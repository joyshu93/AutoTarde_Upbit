import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const SOURCE_ROOT = path.resolve("src");
const PROSPECTIVE_SOURCE_FILES = new Set([
  "src/modules/performance/performance-prospective-shadow-commitment.ts",
  "src/modules/performance/performance-prospective-shadow-evaluation.ts",
  "src/modules/performance/performance-prospective-shadow-registration-writer.ts",
  "src/modules/performance/performance-prospective-shadow-registration.ts",
  "src/modules/performance/performance-prospective-shadow-replay.ts",
  "src/research/prospective-component-shadow.ts",
  "src/research/prospective-shadow-commitment.ts",
  "src/research/prospective-shadow-git-commitment-reader.ts",
]);
const CHILD_PROCESS_ALLOWLIST = new Set([
  "src/research/prospective-component-shadow.ts",
  "src/research/prospective-shadow-git-commitment-reader.ts",
]);
const FORBIDDEN_SOURCE_PATH = /(?:^|\/)(?:app|execution|exchange|reconciliation|telegram|db|migrations?|scheduler|runtime)(?:\/|$)/i;
const FORBIDDEN_SOURCE_NAME = /(?:sqlite|upbit.*(?:acquisition|client)|(?:acquisition|client).*upbit|secret|credential)/i;
const FORBIDDEN_NETWORK_MODULE = /^(?:node:(?:http|https|http2|net|tls|dgram)|undici)$/i;

test("prospective shadow recursively excludes operational and acquisition dependencies", async () => {
  const visited = new Set<string>();
  const pending = [...PROSPECTIVE_SOURCE_FILES];

  while (pending.length > 0) {
    const relativeFile = pending.pop();
    assert.ok(relativeFile);
    if (visited.has(relativeFile)) continue;
    visited.add(relativeFile);

    const absoluteFile = path.resolve(relativeFile);
    const source = await readFile(absoluteFile, "utf8");
    const specifiers = extractModuleSpecifiers(source);

    assert.equal(/\bprocess\.env\b/.test(source), false, `${relativeFile} must not read secrets or runtime environment configuration`);
    assert.equal(/\bfetch\s*\(/.test(source), false, `${relativeFile} must not make direct network requests`);
    if (source.includes("node:child_process")) {
      assert.ok(CHILD_PROCESS_ALLOWLIST.has(relativeFile), `${relativeFile} must not import process-control APIs`);
      assert.match(source, /execFileAsync\(\s*["']git["']\s*,/, `${relativeFile} may execute only the read-only Git adapter`);
      assert.doesNotMatch(source, /execFileAsync\(\s*(?!["']git["'])/, `${relativeFile} contains a non-Git process execution target`);
    }

    for (const specifier of specifiers) {
      assert.equal(FORBIDDEN_NETWORK_MODULE.test(specifier), false, `${relativeFile} imports forbidden network dependency ${specifier}`);
      if (specifier === "node:sqlite" || /(?:^|\/)sqlite(?:3)?(?:\/|$)/i.test(specifier)) {
        assert.fail(`${relativeFile} imports forbidden SQLite dependency ${specifier}`);
      }
      if (specifier === "node:child_process") {
        assert.ok(CHILD_PROCESS_ALLOWLIST.has(relativeFile), `${relativeFile} imports forbidden process-control dependency`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;

      const dependency = await resolveSourceImport(absoluteFile, specifier);
      const relativeDependency = toRepositoryPath(dependency);
      assert.equal(FORBIDDEN_SOURCE_PATH.test(relativeDependency), false, `${relativeFile} imports forbidden operational dependency ${relativeDependency}`);
      assert.equal(FORBIDDEN_SOURCE_NAME.test(relativeDependency), false, `${relativeFile} imports forbidden acquisition/secret dependency ${relativeDependency}`);
      pending.push(relativeDependency);
    }
  }

  assert.ok(visited.size > PROSPECTIVE_SOURCE_FILES.size, "the guard must walk transitive research dependencies");
});

test("runtime and non-prospective source cannot import prospective shadow modules", async () => {
  const sourceFiles = await listTypeScriptFiles(SOURCE_ROOT);
  for (const absoluteFile of sourceFiles) {
    const relativeFile = toRepositoryPath(absoluteFile);
    if (PROSPECTIVE_SOURCE_FILES.has(relativeFile)) continue;

    const source = await readFile(absoluteFile, "utf8");
    for (const specifier of extractModuleSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const dependency = await resolveSourceImport(absoluteFile, specifier);
      const relativeDependency = toRepositoryPath(dependency);
      assert.equal(
        PROSPECTIVE_SOURCE_FILES.has(relativeDependency),
        false,
        `${relativeFile} must not import prospective research module ${relativeDependency}`,
      );
    }
  }
});

function extractModuleSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?|\bimport\s*\()\s*["']([^"']+)["']/gs;
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}

async function resolveSourceImport(importer: string, specifier: string): Promise<string> {
  const withoutExtension = specifier.replace(/\.js$/u, "");
  const candidate = path.resolve(path.dirname(importer), `${withoutExtension}.ts`);
  await readFile(candidate, "utf8");
  return candidate;
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files.sort();
}

function toRepositoryPath(absoluteFile: string): string {
  return path.relative(process.cwd(), absoluteFile).replaceAll("\\", "/");
}
