import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { UpbitCandleSnapshot } from "../src/modules/exchange/upbit/contracts.js";
import { buildResearchCandleDataset } from "../src/modules/performance/research-candle-dataset-builder.js";
import {
  createResearchCandleDatasetWriter,
  writeVerifiedResearchCandleDataset,
} from "../src/modules/performance/research-candle-dataset-writer.js";
import { readResearchCandleDataset } from "../src/modules/performance/research-candle-dataset.js";
import type { PositionGuardBacktestCandleReader } from "../src/modules/strategy/position-guard-public-backtest.js";
import {
  assertResearchCandleDatasetOutputAvailable,
  parseResearchCandleDatasetArgs,
  runResearchCandleDatasetCli,
  type ResearchCandleDatasetCliDependencies,
  type ResearchCandleDatasetCliOptions,
} from "../src/research/upbit-candle-dataset.js";
import { test } from "./harness.js";

const VALID_ARGV = [
  "--asset", "BTC",
  "--history-start", "2025-01-01T00:00:00.000Z",
  "--end", "2026-08-11T00:00:00.000Z",
  "--output", "./var/research/btc.json",
  "--page-size", "200",
  "--page-limit", "100",
] as const;

test("research candle CLI parses all six required values without defaults", () => {
  assert.deepEqual(parseResearchCandleDatasetArgs(VALID_ARGV), {
    asset: "BTC",
    historyStartAt: "2025-01-01T00:00:00.000Z",
    endAt: "2026-08-11T00:00:00.000Z",
    outputPath: "./var/research/btc.json",
    pageSize: 200,
    pageLimit: 100,
  });
});

test("research candle CLI rejects incomplete or open argument contracts", () => {
  const cases: ReadonlyArray<[readonly string[], RegExp]> = [
    [VALID_ARGV.slice(0, -2), /Missing required argument --page-limit\./],
    [[...VALID_ARGV, "--asset", "ETH"], /Duplicate argument --asset\./],
    [[...VALID_ARGV, "--database", "live.sqlite"], /Unknown argument --database\./],
    [VALID_ARGV.slice(0, -1), /Missing value for --page-limit\./],
  ];
  for (const [argv, expected] of cases) {
    assert.throws(() => parseResearchCandleDatasetArgs(argv), expected);
  }
});

test("research candle CLI validates asset, path, timestamps, range, and pagination", () => {
  const cases: ReadonlyArray<[string, string, RegExp]> = [
    ["asset", "XRP", /--asset must be BTC or ETH\./],
    ["output", "   ", /--output must be a non-empty path\./],
    ["history-start", "2025-01-01T00:00:00", /--history-start must be an explicit-timezone ISO timestamp\./],
    ["end", "bad", /--end must be an explicit-timezone ISO timestamp\./],
    ["history-start", "2026-08-11T00:00:00.000Z", /--history-start must be before --end\./],
    ["page-size", "0", /--page-size must be an integer between 1 and 200\./],
    ["page-size", "201", /--page-size must be an integer between 1 and 200\./],
    ["page-size", "1.5", /--page-size must be an integer between 1 and 200\./],
    ["page-limit", "0", /--page-limit must be a positive integer\./],
    ["page-limit", "abc", /--page-limit must be a positive integer\./],
  ];
  for (const [key, value, expected] of cases) {
    assert.throws(() => parseResearchCandleDatasetArgs(replaceArg(key, value)), expected, `${key}=${value}`);
  }
});

test("research candle CLI rejects invalid local options before any injected side effect", async () => {
  const events: string[] = [];
  await assert.rejects(
    runResearchCandleDatasetCli({ ...validOptions(), pageSize: 0 }, dependencies(events)),
    /page-size.*between 1 and 200/i,
  );
  assert.deepEqual(events, []);
});

test("research candle CLI rejects an invalid clock or future end before reader construction", async () => {
  const invalidClockEvents: string[] = [];
  await assert.rejects(
    runResearchCandleDatasetCli(validOptions(), dependencies(invalidClockEvents, new Date(Number.NaN))),
    /collection clock is invalid/i,
  );
  assert.deepEqual(invalidClockEvents, ["now"]);

  const futureEvents: string[] = [];
  await assert.rejects(
    runResearchCandleDatasetCli(validOptions(), dependencies(futureEvents, new Date("2026-08-01T23:59:59.999Z"))),
    /--end must be at or before the collection time\./,
  );
  assert.deepEqual(futureEvents, ["now"]);
});

test("research candle CLI refuses an existing output before reader construction", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.assertOutputAvailable = async () => {
    events.push("assert-output");
    throw new Error("Research candle dataset output already exists.");
  };
  await assert.rejects(runResearchCandleDatasetCli(validOptions(), deps), /already exists/i);
  assert.deepEqual(events, ["now", "assert-output"]);
});

test("research candle CLI never writes after acquisition failure", async () => {
  const events: string[] = [];
  const deps = dependencies(events);
  deps.createReader = () => {
    events.push("create-reader");
    return {
      getMinuteCandles: async () => {
        events.push("public-minute");
        throw new Error("fixture public failure");
      },
      getDayCandles: async () => [],
    };
  };
  await assert.rejects(runResearchCandleDatasetCli(validOptions(), deps), /fixture public failure/);
  assert.deepEqual(events, ["now", "assert-output", "create-reader", "public-minute"]);
});

test("research candle CLI writes verified JSON and returns a finite complete summary", async () => {
  const events: string[] = [];
  let writtenJson = "";
  const deps = dependencies(events);
  deps.writeArtifact = async ({ json }) => {
    events.push("write-artifact");
    writtenJson = json;
  };

  const summary = await runResearchCandleDatasetCli(validOptions(), deps);

  assert.deepEqual(events, [
    "now", "assert-output", "create-reader",
    "public-minute:60", "public-minute:240", "public-day", "write-artifact",
  ]);
  assert.equal(writtenJson.endsWith("\n"), true);
  assert.equal(writtenJson.endsWith("\n\n"), false);
  assert.deepEqual(summary, {
    service: "AutoTrade_Upbit",
    status: "COMPLETED",
    asset: "BTC",
    market: "KRW-BTC",
    historyStartAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
    collectedAt: "2026-08-03T00:00:00.000Z",
    outputPath: "C:/tmp/research/btc.json",
    candleCounts: { "1h": 1, "4h": 1, "1d": 1 },
    sha256: JSON.parse(writtenJson).provenance.sha256,
    source: "upbit-public-historical-candles",
    boundary: {
      sqlite: false,
      privateExchange: false,
      telegram: false,
      scheduler: false,
      strategyExecution: false,
      orders: false,
    },
  });
  assert.doesNotThrow(() => JSON.stringify(summary));
});

test("research candle output precondition preserves existing destination bytes", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "existing.json");
    await writeFile(outputPath, "keep-me", "utf8");
    await assert.rejects(assertResearchCandleDatasetOutputAvailable(outputPath), /output already exists/i);
    assert.equal(await readFile(outputPath, "utf8"), "keep-me");
  });
});

test("verified writer creates nested parents and a checksum-valid artifact", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "nested", "btc.json");
    const json = validArtifactJson();
    await writeVerifiedResearchCandleDataset({ outputPath, json });
    assert.equal(await readFile(outputPath, "utf8"), json);
    assert.equal((await readResearchCandleDataset(outputPath)).provenance.asset, "BTC");
    assert.deepEqual(await temporaryFiles(path.dirname(outputPath), path.basename(outputPath)), []);
  });
});

test("verified writer never replaces an existing destination", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "btc.json");
    await writeFile(outputPath, "original-bytes", "utf8");
    await assert.rejects(writeVerifiedResearchCandleDataset({ outputPath, json: validArtifactJson() }), /exist/i);
    assert.equal(await readFile(outputPath, "utf8"), "original-bytes");
    assert.deepEqual(await temporaryFiles(directory, "btc.json"), []);
  });
});

test("verified writer leaves no artifact or temporary file after malformed JSON", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "btc.json");
    await assert.rejects(writeVerifiedResearchCandleDataset({ outputPath, json: "{bad\n" }), /valid JSON/i);
    await assert.rejects(access(outputPath, constants.F_OK));
    assert.deepEqual(await temporaryFiles(directory, "btc.json"), []);
  });
});

test("verified writer cleans temporary files after injected verification or publish failure", async () => {
  await withTempDirectory(async (directory) => {
    for (const [name, writer] of [
      ["verification", createResearchCandleDatasetWriter({
        verifyArtifact: async () => { throw new Error("injected verification failure"); },
      })],
      ["publish", createResearchCandleDatasetWriter({
        publishArtifact: async () => { throw new Error("injected publish failure"); },
      })],
    ] as const) {
      const outputPath = path.join(directory, `${name}.json`);
      await assert.rejects(writer({ outputPath, json: validArtifactJson() }), new RegExp(`injected ${name} failure`));
      await assert.rejects(access(outputPath, constants.F_OK));
      assert.deepEqual(await temporaryFiles(directory, `${name}.json`), []);
    }
  });
});

test("verified writer keeps publication successful when post-publication cleanup fails", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "btc.json");
    const writer = createResearchCandleDatasetWriter({
      cleanupArtifact: async () => {
        throw new Error("injected cleanup failure");
      },
    });

    await writer({ outputPath, json: validArtifactJson() });

    assert.equal(await readFile(outputPath, "utf8"), validArtifactJson());
    assert.equal((await readResearchCandleDataset(outputPath)).provenance.asset, "BTC");
  });
});

test("research candle modules remain outside runtime and operational import graphs", async () => {
  const graph = await collectRelativeImportGraph(path.join(process.cwd(), "src", "index.ts"));
  for (const target of [
    "src/modules/performance/research-candle-dataset-builder.ts",
    "src/modules/performance/upbit-research-candle-acquisition.ts",
    "src/modules/performance/research-candle-dataset-writer.ts",
    "src/research/upbit-candle-dataset.ts",
  ]) assert.equal(graph.has(target), false, target);

  const cli = await readFile(path.join(process.cwd(), "src/research/upbit-candle-dataset.ts"), "utf8");
  const imports = [...cli.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
  assert.deepEqual(
    imports.filter((specifier) => /private-client|modules\/(?:db|telegram|execution|reconciliation)|scheduler|migrations/i.test(specifier)),
    [],
  );
});

function validOptions(): ResearchCandleDatasetCliOptions {
  return {
    asset: "BTC",
    historyStartAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
    outputPath: "C:/tmp/research/btc.json",
    pageSize: 200,
    pageLimit: 3,
  };
}

function dependencies(events: string[], now = new Date("2026-08-03T00:00:00.000Z")): ResearchCandleDatasetCliDependencies {
  return {
    now: () => { events.push("now"); return now; },
    assertOutputAvailable: async () => { events.push("assert-output"); },
    createReader: () => { events.push("create-reader"); return fixtureReader(events); },
    writeArtifact: async () => { events.push("write-artifact"); },
  };
}

function fixtureReader(events: string[]): PositionGuardBacktestCandleReader {
  return {
    getMinuteCandles: async (request) => {
      events.push(`public-minute:${request.unit}`);
      return [upbitCandle("KRW-BTC", "2026-08-01T00:00:00")];
    },
    getDayCandles: async () => {
      events.push("public-day");
      return [upbitCandle("KRW-BTC", "2026-08-01T00:00:00")];
    },
  };
}

function upbitCandle(market: "KRW-BTC" | "KRW-ETH", openTime: string): UpbitCandleSnapshot {
  return {
    market,
    candle_date_time_utc: openTime,
    candle_date_time_kst: openTime,
    opening_price: 100,
    high_price: 102,
    low_price: 99,
    trade_price: 101,
    timestamp: Date.parse(`${openTime}Z`),
    candle_acc_trade_price: 101,
    candle_acc_trade_volume: 1,
  };
}

function validArtifactJson(): string {
  const candle = (timeframe: "1h" | "4h" | "1d", closeTime: string) => ({
    market: "KRW-BTC" as const,
    timeframe,
    openTime: "2026-08-01T00:00:00.000Z",
    closeTime,
    openPrice: 100,
    highPrice: 102,
    lowPrice: 99,
    closePrice: 101,
    volume: 1,
    quoteVolume: 101,
  });
  return buildResearchCandleDataset({
    asset: "BTC",
    historyStartAt: "2026-08-01T00:00:00.000Z",
    endAt: "2026-08-02T00:00:00.000Z",
    collectedAt: "2026-08-03T00:00:00.000Z",
    source: "upbit-public-historical-candles",
    candles: {
      "1h": [candle("1h", "2026-08-01T01:00:00.000Z")],
      "4h": [candle("4h", "2026-08-01T04:00:00.000Z")],
      "1d": [candle("1d", "2026-08-02T00:00:00.000Z")],
    },
  }).json;
}

function replaceArg(key: string, value: string): string[] {
  const result: string[] = [...VALID_ARGV];
  const index = result.indexOf(`--${key}`);
  assert.notEqual(index, -1);
  result[index + 1] = value;
  return result;
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "autotrade-candle-cli-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function temporaryFiles(directory: string, outputName: string): Promise<string[]> {
  const entries = await readdir(directory).catch(() => []);
  return entries.filter((entry) => entry.startsWith(`.${outputName}.`) && entry.endsWith(".tmp"));
}

async function collectRelativeImportGraph(entryPath: string): Promise<Set<string>> {
  const pending = [entryPath];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const relative = path.relative(process.cwd(), current).replaceAll("\\", "/");
    if (visited.has(relative)) continue;
    visited.add(relative);
    const source = await readFile(current, "utf8");
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"|import\("(\.[^"]+)"\)/g)) {
      const specifier = match[1] ?? match[2];
      if (specifier !== undefined) pending.push(path.resolve(path.dirname(current), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return visited;
}
