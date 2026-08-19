import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

import type { UpbitCandleSnapshot } from "../src/modules/exchange/upbit/contracts.js";
import {
  acquireUpbitResearchCandleDataset,
} from "../src/modules/performance/upbit-research-candle-acquisition.js";
import type {
  PositionGuardBacktestCandleReader,
} from "../src/modules/strategy/position-guard-public-backtest.js";
import { test } from "./harness.js";

test("research candle acquisition requests all public timeframes and returns a verified dataset", async () => {
  const calls: string[] = [];
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async (request) => {
      calls.push(`minute:${request.market}:${request.unit}:${request.count}:${request.to}`);
      return [createCandle("KRW-ETH", "2026-08-01T00:00:00", 100)];
    },
    getDayCandles: async (request) => {
      calls.push(`day:${request.market}:${request.count}:${request.to}`);
      return [createCandle("KRW-ETH", "2026-08-01T00:00:00", 100)];
    },
  };
  const result = await acquireUpbitResearchCandleDataset(reader, {
    asset: "ETH",
    historyStartAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
    collectedAt: "2026-08-03T00:00:00.000Z",
    pageSize: 200,
    pageLimit: 3,
  });

  assert.deepEqual(calls, [
    "minute:KRW-ETH:60:200:2026-08-02T00:00:00.000Z",
    "minute:KRW-ETH:240:200:2026-08-02T00:00:00.000Z",
    "day:KRW-ETH:200:2026-08-02T00:00:00.000Z",
  ]);
  assert.equal(result.asset, "ETH");
  assert.equal(result.market, "KRW-ETH");
  assert.equal(result.source, "upbit-public-historical-candles");
  assert.deepEqual(result.candleCounts, { "1h": 1, "4h": 1, "1d": 1 });
  assert.equal(JSON.parse(result.json).provenance.sha256, result.dataset.provenance.sha256);
  assert.deepEqual(result.boundary, {
    sqlite: false,
    privateExchange: false,
    telegram: false,
    scheduler: false,
    strategyExecution: false,
    orders: false,
  });
  assert.equal(Object.isFrozen(result.boundary), true);
});

test("research candle acquisition reuses backward pagination and de-duplicates overlap", async () => {
  const oneHourPages = [
    [
      createCandle("KRW-ETH", "2026-08-01T03:00:00", 103),
      createCandle("KRW-ETH", "2026-08-01T02:00:00", 102),
    ],
    [
      createCandle("KRW-ETH", "2026-08-01T02:00:00", 102),
      createCandle("KRW-ETH", "2026-07-31T23:00:00", 99),
    ],
  ];
  const minute60To: Array<string | undefined> = [];
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async (request) => {
      if (request.unit === 60) {
        minute60To.push(request.to);
        return oneHourPages.shift() ?? [];
      }
      return [createCandle("KRW-ETH", "2026-08-01T00:00:00", 100)];
    },
    getDayCandles: async () => [
      createCandle("KRW-ETH", "2026-08-01T00:00:00", 100),
    ],
  };

  const result = await acquireUpbitResearchCandleDataset(reader, acquisitionInput({
    pageSize: 2,
    pageLimit: 2,
  }));

  assert.deepEqual(minute60To, [
    "2026-08-02T00:00:00.000Z",
    "2026-08-01T02:00:00.000Z",
  ]);
  assert.deepEqual(result.dataset.candles["1h"].map(({ openTime }) => openTime), [
    "2026-08-01T02:00:00.000Z",
    "2026-08-01T03:00:00.000Z",
  ]);
});

test("research candle acquisition rejects explicit page-limit coverage exhaustion", async () => {
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async () => [
      createCandle("KRW-BTC", "2026-08-01T03:00:00", 103),
      createCandle("KRW-BTC", "2026-08-01T02:00:00", 102),
    ],
    getDayCandles: async () => [],
  };

  await assert.rejects(
    acquireUpbitResearchCandleDataset(reader, acquisitionInput({
      asset: "BTC",
      historyStartAt: "2026-01-01T00:00:00.000Z",
      pageSize: 2,
      pageLimit: 1,
    })),
    /coverage did not reach historyStartAt.*pageLimit=1/i,
  );
});

test("research candle acquisition rejects short and empty source exhaustion before historyStartAt for every timeframe", async () => {
  const timeframes = ["1h", "4h", "1d"] as const;
  const exhaustionKinds = ["short", "empty"] as const;

  for (const timeframe of timeframes) {
    for (const exhaustionKind of exhaustionKinds) {
      const exhaustedCandles = exhaustionKind === "short"
        ? [createCandle("KRW-BTC", "2026-08-01T00:00:00", 100)]
        : [];
      const coveredCandles = [createCandle("KRW-BTC", "2026-01-01T00:00:00", 90)];
      const reader: PositionGuardBacktestCandleReader = {
        getMinuteCandles: async (request) => {
          const requestedTimeframe = request.unit === 60 ? "1h" : "4h";
          return requestedTimeframe === timeframe ? exhaustedCandles : coveredCandles;
        },
        getDayCandles: async () => timeframe === "1d" ? exhaustedCandles : coveredCandles,
      };

      await assert.rejects(
        acquireUpbitResearchCandleDataset(reader, acquisitionInput({
          asset: "BTC",
          historyStartAt: "2026-01-01T00:00:00.000Z",
          pageSize: 2,
          pageLimit: 3,
        })),
        new RegExp(`${timeframe} candle coverage did not reach historyStartAt.*source exhausted`, "i"),
        `${timeframe} ${exhaustionKind} exhaustion must not publish overstated provenance`,
      );
    }
  }
});

test("research candle acquisition rejects an injected timeframe failure without partial success", async () => {
  const calls: string[] = [];
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async (request) => {
      calls.push(`minute:${request.unit}`);
      if (request.unit === 240) {
        throw new Error("fixture 4h failure");
      }
      return [createCandle("KRW-ETH", "2026-08-01T00:00:00", 100)];
    },
    getDayCandles: async () => {
      calls.push("day");
      return [createCandle("KRW-ETH", "2026-08-01T00:00:00", 100)];
    },
  };

  await assert.rejects(
    acquireUpbitResearchCandleDataset(reader, acquisitionInput()),
    /fixture 4h failure/i,
  );
  assert.deepEqual(calls, ["minute:60", "minute:240"]);
});

test("research candle acquisition rejects when range filtering empties a timeframe", async () => {
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async (request) => request.unit === 60
      ? [createCandle("KRW-ETH", "2026-07-31T23:00:00", 99)]
      : [createCandle("KRW-ETH", "2026-08-01T00:00:00", 100)],
    getDayCandles: async () => [
      createCandle("KRW-ETH", "2026-08-01T00:00:00", 100),
    ],
  };

  await assert.rejects(
    acquireUpbitResearchCandleDataset(reader, acquisitionInput()),
    /builder 1h must contain at least one completed candle in range/i,
  );
});

test("research candle acquisition statically imports only its approved pure and public boundaries", async () => {
  const source = await readFile(
    join(process.cwd(), "src/modules/performance/upbit-research-candle-acquisition.ts"),
    "utf8",
  );
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(imports, [
    "../../domain/types.js",
    "../strategy/position-guard-public-backtest.js",
    "./research-candle-dataset-builder.js",
    "./performance-timestamp.js",
    "./research-candle-dataset.js",
  ]);
});

test("conditional ADD research stays outside runtime and operational import graphs", async () => {
  const srcRoot = join(process.cwd(), "src");
  const sourceFiles = await listTypeScriptFiles(srcRoot);
  const integrated = join(srcRoot, "research", "integrated-strategy-evaluation.ts");
  const lossAttribution = join(srcRoot, "modules", "performance", "performance-add-loss-attribution.ts");
  const holdoutHypothesis = join(srcRoot, "modules", "performance", "performance-add-holdout-hypothesis.ts");
  const protectedModules = new Set([lossAttribution, holdoutHypothesis]);
  const approvedImporters = new Map([
    [lossAttribution, new Set([integrated, holdoutHypothesis])],
    [holdoutHypothesis, new Set([integrated])],
  ]);
  const reachable = await collectRelativeImportGraph([lossAttribution, holdoutHypothesis]);
  const forbiddenPath = /(?:^|\/)(?:app|execution|exchange|reconciliation|telegram|runtime|db|research)(?:\/|$)/;

  assert.ok(reachable.has(lossAttribution));
  assert.ok(reachable.has(holdoutHypothesis));
  assert.ok(reachable.has(join(srcRoot, "modules", "performance", "performance-add-policy-evaluation.ts")));
  assert.ok(reachable.has(join(srcRoot, "modules", "performance", "performance-add-diagnostics.ts")));
  for (const filePath of reachable) {
    const relative = filePath.slice(srcRoot.length + 1).replaceAll("\\", "/");
    assert.equal(
      forbiddenPath.test(relative),
      false,
      `conditional ADD pure graph reached forbidden source ${relative}`,
    );
  }

  const violations: string[] = [];
  for (const importer of sourceFiles) {
    const imports = await readRelativeImports(importer);
    for (const imported of imports) {
      if (!protectedModules.has(imported)) continue;
      if (!(approvedImporters.get(imported)?.has(importer) ?? false)) {
        violations.push(
          `${importer.slice(srcRoot.length + 1).replaceAll("\\", "/")} -> ${imported.slice(srcRoot.length + 1).replaceAll("\\", "/")}`,
        );
      }
    }
  }
  assert.deepEqual(violations.sort(), []);

  const integratedImports = await readRelativeImports(integrated);
  assert.ok(integratedImports.includes(lossAttribution));
  assert.ok(integratedImports.includes(holdoutHypothesis));
});

test("independent no-trade evidence stays outside runtime and network acquisition graphs", async () => {
  const srcRoot = join(process.cwd(), "src");
  const sidecar = join(srcRoot, "modules", "performance", "research-no-trade-evidence.ts");
  const networkAcquisition = join(srcRoot, "modules", "performance", "upbit-research-candle-acquisition.ts");
  assert.deepEqual(
    collectModuleSpecifiers(`
      import value from "static-import";
      import "side-effect-import";
      export * from "export-from";
      void import("dynamic-import");
      require("require-import");
      void import(variableSpecifier);
      require(variableSpecifier);
    `),
    [
      "<non-literal dynamic import()>",
      "<non-literal require()>",
      "dynamic-import",
      "export-from",
      "require-import",
      "side-effect-import",
      "static-import",
    ],
  );
  assert.deepEqual(
    collectModuleSpecifiers(await readFile(sidecar, "utf8")),
    [
      "./performance-timestamp.js",
      "./research-candle-dataset.js",
      "node:crypto",
    ],
    "sidecar direct module specifiers must stay on the pure allowlist",
  );
  const reachable = await collectRelativeImportGraph([sidecar]);
  const forbiddenPath = /(?:^|\/)(?:app|execution|exchange|reconciliation|telegram|runtime|db|research)(?:\/|$)/;

  assert.ok(reachable.has(sidecar));
  assert.equal(reachable.has(networkAcquisition), false, "sidecar must not reach network acquisition");
  for (const filePath of reachable) {
    const relative = filePath.slice(srcRoot.length + 1).replaceAll("\\", "/");
    assert.equal(
      forbiddenPath.test(relative),
      false,
      `independent no-trade evidence reached forbidden source ${relative}`,
    );
  }

  const importers: string[] = [];
  for (const sourceFile of await listTypeScriptFiles(srcRoot)) {
    if ((await readRelativeImports(sourceFile)).includes(sidecar)) {
      importers.push(sourceFile.slice(srcRoot.length + 1).replaceAll("\\", "/"));
    }
  }
  assert.deepEqual(importers.sort(), [], "runtime source graph must not import the sidecar");
});

async function collectRelativeImportGraph(roots: readonly string[]): Promise<Set<string>> {
  const visited = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const filePath = pending.shift()!;
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    for (const imported of await readRelativeImports(filePath)) {
      if (!visited.has(imported)) pending.push(imported);
    }
  }
  return visited;
}

async function readRelativeImports(filePath: string): Promise<string[]> {
  const source = await readFile(filePath, "utf8");
  return collectModuleSpecifiers(source)
    .filter((specifier) => /^\.{1,2}\//.test(specifier))
    .map((specifier) => resolve(dirname(filePath), specifier.replace(/\.js$/, ".ts")))
    .sort();
}

function collectModuleSpecifiers(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "module-specifier-fixture.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        specifiers.push(moduleSpecifierArgument(node, "<non-literal dynamic import()>"));
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        specifiers.push(moduleSpecifierArgument(node, "<non-literal require()>"));
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers.sort();
}

function moduleSpecifierArgument(call: ts.CallExpression, fallback: string): string {
  const argument = call.arguments[0];
  return argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
    ? argument.text
    : fallback;
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const entryPath = join(directory, entry.name);
    return entry.isDirectory()
      ? listTypeScriptFiles(entryPath)
      : Promise.resolve(entry.name.endsWith(".ts") ? [entryPath] : []);
  }));
  return files.flat().sort();
}

function acquisitionInput(
  overrides: Partial<Parameters<typeof acquireUpbitResearchCandleDataset>[1]> = {},
): Parameters<typeof acquireUpbitResearchCandleDataset>[1] {
  return {
    asset: "ETH",
    historyStartAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
    collectedAt: "2026-08-03T00:00:00.000Z",
    pageSize: 200,
    pageLimit: 3,
    ...overrides,
  };
}

function createCandle(
  market: "KRW-BTC" | "KRW-ETH",
  openTimeUtc: string,
  closePrice: number,
): UpbitCandleSnapshot {
  return {
    market,
    candle_date_time_utc: openTimeUtc,
    candle_date_time_kst: openTimeUtc,
    opening_price: closePrice * 0.99,
    high_price: closePrice * 1.02,
    low_price: closePrice * 0.98,
    trade_price: closePrice,
    timestamp: Date.parse(`${openTimeUtc}Z`),
    candle_acc_trade_price: closePrice * 100,
    candle_acc_trade_volume: 100,
  };
}
