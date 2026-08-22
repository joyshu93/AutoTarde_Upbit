import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import { test } from "./harness.js";

const SOURCE_ROOT = path.resolve("src");
const CANDIDATE_FILE_PREFIX = "position-guard-candidate-";
const forbiddenCandidateDependencies = [
  "/app/", "/db/", "/exchange/", "/execution/", "/reconciliation/",
  "/telegram/", "/smoke/", "/migrations/", "performance-prospective-",
] as const;
const RUNTIME_SURFACE_DIRECTORIES = [
  "src/app",
  "src/modules/db",
  "src/modules/exchange",
  "src/modules/execution",
  "src/modules/reconciliation",
  "src/modules/telegram",
  "src/smoke",
] as const;
const APPROVED_PERSISTENCE_PROJECTOR_IMPORTERS = new Set([
  "/src/modules/db/pilot-interfaces.ts",
  "/src/modules/db/repositories/in-memory-candidate-pilot-repository.ts",
  "/src/modules/db/repositories/sqlite-candidate-pilot-repository.ts",
  "/src/modules/execution/candidate-evidence-decimals.ts",
  "/src/modules/execution/candidate-evidence-service.ts",
]);
const APPROVED_PERSISTENCE_PROJECTOR =
  "/src/modules/strategy/position-guard-candidate-state.ts";
const APPROVED_RUNTIME_CANDIDATE_FILES = new Set([
  "/src/modules/strategy/position-guard-candidate-policy.ts",
  APPROVED_PERSISTENCE_PROJECTOR,
]);
const APPROVED_RUNTIME_CANDIDATE_EDGES = new Set([
  "/src/modules/strategy/position-guard-policy-router.ts->/src/modules/strategy/position-guard-candidate-policy.ts",
  "/src/modules/strategy/position-guard-policy-router.ts->/src/modules/strategy/position-guard-candidate-state.ts",
  "/src/modules/strategy/position-guard-candidate-policy.ts->/src/modules/strategy/position-guard-candidate-state.ts",
]);
const FORBIDDEN_CANDIDATE_SOURCE_REFERENCES: readonly [RegExp, string][] = [
  [/\bprocess\.env\b/u, "runtime environment configuration"],
  [/(?:node:)?fs(?:\/promises)?\b/iu, "filesystem APIs"],
  [/(?:node:)?child_process(?:\/promises)?\b/iu, "process-control APIs"],
  [/\bsqlite\b/iu, "SQLite"],
  [/node:(?:http|https|http2|net|tls|dgram)\b/iu, "HTTP or network APIs"],
  [/\bfetch\b/iu, "fetch"],
  [/\b(?:axios|got|undici|node-fetch|cross-fetch|superagent|needle|ofetch|ky|wretch)\b/iu, "explicit network clients"],
  [/\bupbit\b/iu, "Upbit"],
  [/\btelegram\b/iu, "Telegram"],
  [/\bscheduler\b/iu, "scheduler"],
  [/\brepository\b/iu, "repository"],
  [/\b(?:submit|place|create|send|execute|transmit)\w*(?:order|trade)\w*\b/iu, "order submission"],
];
type ModuleEdge = Readonly<{
  specifier: string;
  kind: "TYPE_ONLY" | "RUNTIME";
}>;

test("candidate dependency extractor classifies every supported literal module syntax", () => {
  const source = [
    'import defaultImport from "bare-esm";',
    'import type { TypeOnly } from "./relative-type.js";',
    'import { type InlineTypeOnly } from "./inline-relative-type.js";',
    'export { exported } from "bare-export";',
    'export type { ExportedType } from "./relative-export.js";',
    'export { type InlineExportedType } from "./inline-relative-export.js";',
    'await import("dynamic-package");',
    'await import("dynamic-package-with-options", { with: { type: "json" } });',
    'await import(`../../app/create-app.js`);',
    'await import(`pkg$literal-import`);',
    'require("commonjs-package");',
    'require(`axios`);',
    'require(`pkg$literal-require`);',
    'import equalsImport = require("import-equals-package");',
    'import type equalsTypeOnlyImport = require("./import-equals-type.js");',
    'import "node:fs";',
  ].join("\n");

  const expected: ModuleEdge[] = [
      { specifier: "bare-esm", kind: "RUNTIME" },
      { specifier: "./relative-type.js", kind: "TYPE_ONLY" },
      { specifier: "./inline-relative-type.js", kind: "TYPE_ONLY" },
      { specifier: "bare-export", kind: "RUNTIME" },
      { specifier: "./relative-export.js", kind: "TYPE_ONLY" },
      { specifier: "./inline-relative-export.js", kind: "TYPE_ONLY" },
      { specifier: "dynamic-package", kind: "RUNTIME" },
      { specifier: "dynamic-package-with-options", kind: "RUNTIME" },
      { specifier: "../../app/create-app.js", kind: "RUNTIME" },
      { specifier: "pkg$literal-import", kind: "RUNTIME" },
      { specifier: "commonjs-package", kind: "RUNTIME" },
      { specifier: "axios", kind: "RUNTIME" },
      { specifier: "pkg$literal-require", kind: "RUNTIME" },
      { specifier: "import-equals-package", kind: "RUNTIME" },
      { specifier: "./import-equals-type.js", kind: "TYPE_ONLY" },
      { specifier: "node:fs", kind: "RUNTIME" },
    ];
  assert.deepEqual(extractModuleEdges(source).sort(compareModuleEdges), expected.sort(compareModuleEdges));
});

test("candidate dependency extractor rejects every computed dynamic module specifier", () => {
  for (const source of [
    'await import("../../" + "app/create-app.js");',
    "await import(`../../app/${moduleName}.js`);",
    'require("../../modules/" + moduleName);',
    "require(`../../modules/${moduleName}.js`);",
  ]) {
    assert.throws(() => extractModuleEdges(source), /non-literal (?:dynamic import|require)/i);
  }
});

test("candidate dependency extractor decodes escaped literals before safety checks", () => {
  const edges = extractModuleEdges([
    'await import("..\\x2f..\\x2fapp/create-app.js");',
    'require(`..\\x2f..\\x2fmodules/db/sqlite.js`);',
  ].join("\n"));
  const expected: ModuleEdge[] = [
    { specifier: "../../app/create-app.js", kind: "RUNTIME" },
    { specifier: "../../modules/db/sqlite.js", kind: "RUNTIME" },
  ];

  assert.deepEqual(edges.sort(compareModuleEdges), expected.sort(compareModuleEdges));
});

test("candidate dependency extractor ignores comments, strings, and lexically shadowed require calls", () => {
  const edges = extractModuleEdges([
    '// await import("../../app/create-app.js");',
    'const example = `require("../../modules/db/sqlite.js")`;',
    'function require(value: string): string { return value; }',
    'require("../../modules/execution/service.js");',
    'loader.require("../../modules/exchange/client.js");',
  ].join("\n"));

  assert.deepEqual(edges, []);
});

test("candidate dependency extractor does not use a distant require function past a nearer binding", () => {
  const edges = extractModuleEdges([
    'function require(value: string): string { return value; }',
    'function inspect(require: unknown): void {',
    '  require("../../modules/execution/service.js");',
    '}',
  ].join("\n"));

  assert.deepEqual(edges, [
    { specifier: "../../modules/execution/service.js", kind: "RUNTIME" },
  ]);
});

test("candidate dependency extractor resolves hoisted and loop require bindings before distant declarations", () => {
  const edges = extractModuleEdges([
    'function require(value: string): string { return value; }',
    'function inspectVar(loader: unknown): void {',
    '  if (loader) { var require = loader; }',
    '  require("../../modules/db/sqlite.js");',
    '}',
    'function inspectLoop(loaders: unknown[]): void {',
    '  for (const { require } of loaders) {',
    '    require("../../modules/exchange/client.js");',
    '  }',
    '}',
  ].join("\n"));

  const expected: ModuleEdge[] = [
    { specifier: "../../modules/db/sqlite.js", kind: "RUNTIME" },
    { specifier: "../../modules/exchange/client.js", kind: "RUNTIME" },
  ];
  assert.deepEqual(edges.sort(compareModuleEdges), expected.sort(compareModuleEdges));
});

test("candidate dependency extractor keeps runtime edges for variable import and catch require bindings", () => {
  const variableEdges = extractModuleEdges([
    'function require(value: string): string { return value; }',
    'function inspect(loader: unknown): void {',
    '  const require = loader;',
    '  require("../../modules/reconciliation/service.js");',
    '}',
  ].join("\n"));
  assert.deepEqual(variableEdges, [
    { specifier: "../../modules/reconciliation/service.js", kind: "RUNTIME" },
  ]);

  const importEdges = extractModuleEdges([
    'import require from "./local-loader.js";',
    'require("../../modules/telegram/router.js");',
  ].join("\n"));
  const expectedImportEdges: ModuleEdge[] = [
    { specifier: "./local-loader.js", kind: "RUNTIME" },
    { specifier: "../../modules/telegram/router.js", kind: "RUNTIME" },
  ];
  assert.deepEqual(
    importEdges.sort(compareModuleEdges),
    expectedImportEdges.sort(compareModuleEdges),
  );

  const catchEdges = extractModuleEdges([
    'function require(value: string): string { return value; }',
    'try { throw new Error("fixture"); } catch (require) {',
    '  require("../../modules/exchange/client.js");',
    '}',
  ].join("\n"));
  assert.deepEqual(catchEdges, [
    { specifier: "../../modules/exchange/client.js", kind: "RUNTIME" },
  ]);
});

test("candidate allows type-only domain and core edges without runtime traversal", () => {
  const edges = extractModuleEdges([
    'import type { StrategyDecisionAction } from "../../domain/types.js";',
    'import type { PositionGuardEngineDecision } from "./position-guard-core.js";',
  ].join("\n"));

  assert.deepEqual(edges, [
    { specifier: "../../domain/types.js", kind: "TYPE_ONLY" },
    { specifier: "./position-guard-core.js", kind: "TYPE_ONLY" },
  ]);
  for (const edge of edges) {
    assert.equal(isRuntimeReachableEdge(edge), false);
    assert.doesNotThrow(() => assertCandidateSpecifierIsSafe("/src/modules/strategy/candidate.ts", edge.specifier));
  }
});

test("candidate rejects a forbidden direct type-only edge", () => {
  const forbiddenEdges = [
    ["../../app/create-app.js", "/src/app/create-app.ts"],
    ["../../modules/db/sqlite.js", "/src/modules/db/sqlite.ts"],
    ["../../modules/exchange/client.js", "/src/modules/exchange/client.ts"],
    ["../../modules/execution/service.js", "/src/modules/execution/service.ts"],
    ["../../modules/reconciliation/service.js", "/src/modules/reconciliation/service.ts"],
    ["../../modules/telegram/router.js", "/src/modules/telegram/router.ts"],
    ["../../smoke/readiness.js", "/src/smoke/readiness.ts"],
    ["../../migrations/001.js", "/src/migrations/001.ts"],
    ["../../modules/performance/performance-prospective-shadow.js", "/src/modules/performance/performance-prospective-shadow.ts"],
    ["../../modules/strategy/scheduler/future.js", "/src/modules/strategy/scheduler/future.ts"],
  ] as const;

  for (const [specifier, target] of forbiddenEdges) {
    const [edge] = extractModuleEdges(`import type { Forbidden } from "${specifier}";`);
    assert.deepEqual(edge, { specifier, kind: "TYPE_ONLY" });
    assert.throws(() => assertCandidateDependencyPathIsSafe(target), /forbidden (dependency|scheduler)/i);
  }
});

test("runtime root recognition includes index and scheduler paths", () => {
  assert.equal(isRuntimeRootPath("/src/index.ts"), true);
  assert.equal(isRuntimeRootPath("/src/modules/strategy/position-guard-runner.ts"), true);
  assert.equal(isRuntimeRootPath("/src/modules/scheduler/future-runtime.ts"), true);
  assert.equal(isRuntimeRootPath("/src/modules/strategy/future-scheduler.ts"), true);
  assert.equal(isRuntimeRootPath("/src/modules/strategy/position-guard-candidate-policy.ts"), false);
});

test("candidate modules recursively exclude operational, prospective, and side-effect dependencies", async () => {
  const candidateFiles = await discoverCandidateFiles();
  const candidateEntries = new Set(candidateFiles.map(toRepositoryPath));
  assert.ok(candidateFiles.length > 0, "the guard must discover at least one candidate module");

  const visited = await walkStaticImports(candidateFiles, async (absoluteFile, source, edges) => {
    const relativeFile = toRepositoryPath(absoluteFile);
    for (const [pattern, label] of FORBIDDEN_CANDIDATE_SOURCE_REFERENCES) {
      assert.equal(pattern.test(source), false, `${relativeFile} must not reference ${label}`);
    }
    for (const edge of edges) {
      assertCandidateSpecifierIsSafe(relativeFile, edge.specifier);
      if (!edge.specifier.startsWith(".")) continue;
      const dependency = await resolveSourceImport(absoluteFile, edge.specifier);
      const dependencyPath = toRepositoryPath(dependency);
      if (candidateEntries.has(relativeFile) || isRuntimeReachableEdge(edge)) {
        assertCandidateDependencyPathIsSafe(dependencyPath);
      }
    }

    assertCandidateDependencyPathIsSafe(relativeFile);
  });

  assert.ok(visited.size >= candidateFiles.length, "candidate dependency traversal must include every discovered candidate file");
});

test("runtime surfaces reach only the reviewed runner route and persistence projector bridges", async () => {
  const candidateFiles = new Set((await discoverCandidateFiles()).map(toRepositoryPath));
  const runtimeFiles = await discoverRuntimeSurfaceFiles();
  assert.ok(runtimeFiles.length > 0, "the guard must discover runtime surface files");

  await walkStaticImports(runtimeFiles, async (absoluteFile, _source, edges) => {
    const relativeFile = toRepositoryPath(absoluteFile);
    assert.equal(
      candidateFiles.has(relativeFile) && !APPROVED_RUNTIME_CANDIDATE_FILES.has(relativeFile),
      false,
      `${relativeFile} is a candidate module reachable from a runtime surface`,
    );
    for (const edge of edges) {
      if (!edge.specifier.startsWith(".")) continue;
      const dependency = await resolveSourceImport(absoluteFile, edge.specifier);
      const dependencyPath = toRepositoryPath(dependency);
      const approvedPersistenceBridge =
        APPROVED_PERSISTENCE_PROJECTOR_IMPORTERS.has(relativeFile) &&
        dependencyPath === APPROVED_PERSISTENCE_PROJECTOR;
      const approvedRuntimeCandidateEdge = APPROVED_RUNTIME_CANDIDATE_EDGES.has(
        `${relativeFile}->${dependencyPath}`,
      );
      assert.equal(
        candidateFiles.has(dependencyPath) && !approvedPersistenceBridge && !approvedRuntimeCandidateEdge,
        false,
        `${relativeFile} directly imports candidate module ${dependencyPath}`,
      );
    }
  });
});

async function discoverCandidateFiles(): Promise<string[]> {
  const sourceFiles = await listTypeScriptFiles(SOURCE_ROOT);
  return sourceFiles.filter(isCandidateFile);
}

async function discoverRuntimeSurfaceFiles(): Promise<string[]> {
  const files = new Set<string>();
  for (const directory of RUNTIME_SURFACE_DIRECTORIES) {
    for (const file of await listTypeScriptFiles(path.resolve(directory))) files.add(file);
  }

  for (const file of await listTypeScriptFiles(SOURCE_ROOT)) {
    const normalized = toRepositoryPath(file);
    if (isRuntimeRootPath(normalized)) {
      files.add(file);
    }
  }

  return [...files].filter((file) => !isCandidateFile(file)).sort();
}

function isRuntimeRootPath(normalized: string): boolean {
  return normalized === "/src/index.ts" ||
    normalized.endsWith("/position-guard-runner.ts") ||
    normalized.split("/").includes("scheduler") ||
    /(?:^|\/)[^/]*scheduler[^/]*\.ts$/iu.test(normalized);
}

function extractModuleEdges(source: string): ModuleEdge[] {
  const edges = new Map<string, ModuleEdge>();
  const add = (specifier: string, kind: ModuleEdge["kind"]) => {
    const key = `${kind}:${specifier}`;
    edges.set(key, { specifier, kind });
  };
  const { sourceFile, checker } = createDependencyFixtureProgram(source);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(staticModuleSpecifier(node.moduleSpecifier, "import declaration"), importDeclarationKind(node));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(staticModuleSpecifier(node.moduleSpecifier, "export declaration"), exportDeclarationKind(node));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = node.moduleReference.expression;
      if (specifier !== undefined) {
        add(staticModuleSpecifier(specifier, "import-equals declaration"), node.isTypeOnly ? "TYPE_ONLY" : "RUNTIME");
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        add(argument.literal.text, "TYPE_ONLY");
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(literalCallSpecifier(node, "dynamic import"), "RUNTIME");
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      !isInSourceRequireFunctionDeclaration(node.expression, checker)
    ) {
      add(literalCallSpecifier(node, "require"), "RUNTIME");
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...edges.values()];
}

function createDependencyFixtureProgram(source: string): Readonly<{
  sourceFile: ts.SourceFile;
  checker: ts.TypeChecker;
}> {
  const fileName = "candidate-dependency-boundary-fixture.ts";
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    types: [],
  };
  const fixture = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const host = ts.createCompilerHost(options, true);
  host.getSourceFile = (requestedFileName) => requestedFileName === fileName ? fixture : undefined;
  host.fileExists = (requestedFileName) => requestedFileName === fileName;
  host.readFile = (requestedFileName) => requestedFileName === fileName ? source : undefined;
  host.writeFile = () => undefined;

  const program = ts.createProgram({ rootNames: [fileName], options, host });
  const sourceFile = program.getSourceFile(fileName);
  assert.ok(sourceFile, "dependency fixture source must be bound by the TypeScript program");
  return { sourceFile, checker: program.getTypeChecker() };
}

function staticModuleSpecifier(expression: ts.Expression, syntax: string): string {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  throw new Error(`Candidate dependency boundary rejects non-literal ${syntax}.`);
}

function importDeclarationKind(node: ts.ImportDeclaration): ModuleEdge["kind"] {
  const clause = node.importClause;
  if (clause?.isTypeOnly) return "TYPE_ONLY";
  if (
    clause?.name === undefined &&
    clause?.namedBindings !== undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  ) {
    return "TYPE_ONLY";
  }
  return "RUNTIME";
}

function exportDeclarationKind(node: ts.ExportDeclaration): ModuleEdge["kind"] {
  if (node.isTypeOnly) return "TYPE_ONLY";
  if (
    node.exportClause !== undefined &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((element) => element.isTypeOnly)
  ) {
    return "TYPE_ONLY";
  }
  return "RUNTIME";
}

function literalCallSpecifier(call: ts.CallExpression, syntax: "dynamic import" | "require"): string {
  const argument = call.arguments[0];
  if (argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
    return argument.text;
  }
  const position = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart());
  throw new Error(
    `Candidate dependency boundary rejects non-literal ${syntax} at ${position.line + 1}:${position.character + 1}.`,
  );
}

function isInSourceRequireFunctionDeclaration(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declarations = symbol?.declarations?.filter((declaration) =>
    declaration.getSourceFile() === identifier.getSourceFile()
  ) ?? [];
  return declarations.length > 0 &&
    declarations.every(ts.isFunctionDeclaration) &&
    declarations.some((declaration) => declaration.body !== undefined);
}

function compareModuleEdges(left: ModuleEdge, right: ModuleEdge): number {
  return `${left.specifier}:${left.kind}`.localeCompare(`${right.specifier}:${right.kind}`);
}

function isRuntimeReachableEdge(edge: ModuleEdge): boolean {
  return edge.kind === "RUNTIME";
}

async function walkStaticImports(
  entryFiles: readonly string[],
  visit: (absoluteFile: string, source: string, edges: readonly ModuleEdge[]) => Promise<void>,
): Promise<ReadonlySet<string>> {
  const visited = new Set<string>();
  const pending = [...entryFiles].sort().reverse();

  while (pending.length > 0) {
    const absoluteFile = pending.pop();
    assert.ok(absoluteFile);
    const normalizedFile = path.normalize(absoluteFile);
    if (visited.has(normalizedFile)) continue;
    visited.add(normalizedFile);

    const source = await readFile(normalizedFile, "utf8");
    const edges = extractModuleEdges(source);
    await visit(normalizedFile, source, edges);
    for (const edge of edges) {
      if (!isRuntimeReachableEdge(edge) || !edge.specifier.startsWith(".")) continue;
      pending.push(await resolveSourceImport(normalizedFile, edge.specifier));
    }
  }

  return visited;
}

function assertCandidateSpecifierIsSafe(relativeFile: string, specifier: string): void {
  const normalized = specifier.toLowerCase();
  const forbidden =
    /^(?:node:)?(?:fs|child_process|sqlite|http|https|http2|net|tls|dgram|dns)(?:\/|$)/u.test(normalized) ||
    /^(?:axios|got|undici|node-fetch|cross-fetch|superagent|needle|ofetch|ky|wretch)(?:\/|$)/u.test(normalized) ||
    /(?:upbit|telegram|scheduler|repository|sqlite|order(?:-|_)?submission)/u.test(normalized);
  assert.equal(forbidden, false, `${relativeFile} imports forbidden candidate dependency ${specifier}`);
}

function assertCandidateDependencyPathIsSafe(relativeFile: string): void {
  assert.equal(
    forbiddenCandidateDependencies.some((forbidden) => relativeFile.includes(forbidden)),
    false,
    `${relativeFile} is a forbidden dependency of candidate preparation`,
  );
  assert.equal(relativeFile.includes("/scheduler/"), false, `${relativeFile} is a forbidden scheduler dependency`);
}

async function resolveSourceImport(importer: string, specifier: string): Promise<string> {
  const withoutExtension = specifier.replace(/\.js$/u, "");
  const base = path.resolve(path.dirname(importer), withoutExtension);
  const candidates = [`${base}.ts`, path.join(base, "index.ts")];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported TypeScript source shape.
    }
  }
  assert.fail(`${toRepositoryPath(importer)} imports an unresolved local TypeScript module ${specifier}`);
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...await listTypeScriptFiles(absolute));
      else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
    }
    return files.sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function isCandidateFile(absoluteFile: string): boolean {
  return path.basename(absoluteFile).startsWith(CANDIDATE_FILE_PREFIX);
}

function toRepositoryPath(absoluteFile: string): string {
  return `/${path.relative(process.cwd(), absoluteFile).replaceAll("\\", "/")}`;
}
