import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { UpbitCandleSnapshot } from "../src/modules/exchange/upbit/contracts.js";
import {
  acquireUpbitNoTradeEvidence,
  type ResearchNoTradeMinuteCandleReader,
} from "../src/modules/performance/upbit-no-trade-evidence-acquisition.js";
import {
  calculateResearchCandleDatasetChecksum,
  parseResearchCandleDataset,
  type ResearchCandleDataset,
} from "../src/modules/performance/research-candle-dataset.js";
import {
  assertResearchNoTradeEvidenceOutputAvailable,
  createResearchNoTradeEvidenceWriter,
} from "../src/modules/performance/research-no-trade-evidence-writer.js";
import {
  parseNoTradeEvidenceArgs,
  runNoTradeEvidenceCli,
  type NoTradeEvidenceCliDependencies,
  type NoTradeEvidenceCliOptions,
} from "../src/research/upbit-no-trade-evidence.js";
import { test } from "./harness.js";

const VALID_ARGV = [
  "--parent-dataset", "./var/research/btc.json",
  "--output", "./var/research/btc.no-trade.json",
  "--page-size", "200",
  "--page-limit", "100",
] as const;

test("no-trade evidence CLI requires exactly four explicit arguments and rejects invalid parser inputs", () => {
  assert.deepEqual(parseNoTradeEvidenceArgs(VALID_ARGV), {
    parentDatasetPath: "./var/research/btc.json",
    outputPath: "./var/research/btc.no-trade.json",
    pageSize: 200,
    pageLimit: 100,
  });
  for (const [argv, expected] of [
    [VALID_ARGV.slice(0, -2), /Missing required argument --page-limit\./],
    [[...VALID_ARGV, "--output", "other.json"], /Duplicate argument --output\./],
    [[...VALID_ARGV, "--asset", "BTC"], /Unknown argument --asset\./],
    [VALID_ARGV.slice(0, -1), /Missing value for --page-limit\./],
    [["stray", ...VALID_ARGV], /Unexpected argument stray\./],
    [replaceArgument("parent-dataset", ""), /parent-dataset.*non-empty/i],
    [replaceArgument("output", ""), /output.*non-empty/i],
    [replaceArgument("page-size", "0"), /page-size.*between 1 and 200/i],
    [replaceArgument("page-size", "-1"), /page-size.*between 1 and 200/i],
    [replaceArgument("page-size", "1.5"), /page-size.*between 1 and 200/i],
    [replaceArgument("page-size", "9007199254740992"), /page-size.*between 1 and 200/i],
    [replaceArgument("page-limit", "0"), /page-limit.*positive safe integer/i],
    [replaceArgument("page-limit", "-1"), /page-limit.*positive safe integer/i],
    [replaceArgument("page-limit", "1.5"), /page-limit.*positive safe integer/i],
    [replaceArgument("page-limit", "9007199254740992"), /page-limit.*positive safe integer/i],
  ] as const) {
    assert.throws(() => parseNoTradeEvidenceArgs(argv), expected);
  }
});

test("no-trade evidence CLI rejects empty and unsafe local options before side effects", async () => {
  const events: string[] = [];
  await assert.rejects(
    runNoTradeEvidenceCli({ ...validOptions(), pageSize: 0 }, dependencies(events)),
    /page-size.*between 1 and 200/i,
  );
  await assert.rejects(
    runNoTradeEvidenceCli({ ...validOptions(), outputPath: "  " }, dependencies(events)),
    /output.*non-empty/i,
  );
  assert.deepEqual(events, []);
});

test("no-trade evidence CLI authenticates parent and checks output before creating public reader", async () => {
  await withFetchTrap(async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.readParentDataset = async () => {
      events.push("read-parent");
      throw new Error("forged parent");
    };
    await assert.rejects(runNoTradeEvidenceCli(validOptions(), deps), /forged parent/);
    assert.deepEqual(events, ["now", "read-parent"]);

    const unavailableEvents: string[] = [];
    const unavailable = dependencies(unavailableEvents);
    unavailable.assertOutputAvailable = async () => {
      unavailableEvents.push("assert-output");
      throw new Error("output exists");
    };
    await assert.rejects(runNoTradeEvidenceCli(validOptions(), unavailable), /output exists/);
    assert.deepEqual(unavailableEvents, ["now", "read-parent", "assert-output"]);
  });
});

test("no-trade evidence CLI rejects invalid clocks and future parent end before reader construction", async () => {
  await withFetchTrap(async () => {
    const invalidClockEvents: string[] = [];
    await assert.rejects(
      runNoTradeEvidenceCli(validOptions(), dependencies(invalidClockEvents, new Date(Number.NaN))),
      /collection clock is invalid/i,
    );
    assert.deepEqual(invalidClockEvents, ["now"]);

    const futureEvents: string[] = [];
    await assert.rejects(
      runNoTradeEvidenceCli(validOptions(), dependencies(futureEvents, new Date("2026-08-01T01:59:59.999Z"))),
      /parent dataset end.*collection time/i,
    );
    assert.deepEqual(futureEvents, ["now", "read-parent"]);
  });
});

test("no-trade evidence CLI never writes after acquisition failure", async () => {
  await withFetchTrap(async () => {
    const events: string[] = [];
    const deps = dependencies(events);
    deps.createReader = () => {
      events.push("create-reader");
      return { getMinuteCandles: async () => { events.push("public-minute"); throw new Error("fixture public failure"); } };
    };
    await assert.rejects(runNoTradeEvidenceCli(validOptions(), deps), /fixture public failure/);
    assert.deepEqual(events, ["now", "read-parent", "assert-output", "create-reader", "public-minute"]);
  });
});

test("no-trade evidence CLI produces byte-identical artifacts and stable finite summaries for a fixed clock", async () => {
  await withFetchTrap(async () => {
    const first = await runFixedClockCli();
    const second = await runFixedClockCli();
    assert.deepEqual(first.events, ["now", "read-parent", "assert-output", "create-reader", "public-minute", "write-artifact"]);
    assert.equal(first.json, second.json);
    assert.deepEqual(first.summary, second.summary);
    assert.doesNotThrow(() => JSON.stringify(first.summary));
    assert.equal(first.summary.parentDatasetSha256, validParent().provenance.sha256);
    assert.equal(first.summary.evidenceSha256, JSON.parse(first.json).provenance.sha256);
    assert.equal(first.summary.collectedAt, "2026-08-01T04:00:00.000Z");
    for (const value of [first.summary.segmentCount, first.summary.pageCount, first.summary.verifiedRangeCount]) {
      assert.equal(Number.isFinite(value), true);
    }
  });
});

test("no-trade writer preserves destinations and cleans up temporary artifacts on failure", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "nested", "btc.no-trade.json");
    const parent = validParent();
    const json = await validEvidenceJson(parent);
    const writer = createResearchNoTradeEvidenceWriter();
    await writer({ outputPath, json, parentDataset: parent });
    assert.equal(await readFile(outputPath, "utf8"), json);

    await assert.rejects(writer({ outputPath, json, parentDataset: parent }), /already exists/i);
    assert.equal(await readFile(outputPath, "utf8"), json);

    const malformedPath = path.join(directory, "malformed.json");
    await assert.rejects(writer({ outputPath: malformedPath, json: "{bad", parentDataset: parent }), /valid JSON/i);
    await assert.rejects(access(malformedPath, constants.F_OK));
    assert.deepEqual(await temporaryFiles(directory, "malformed.json"), []);
  });
});

test("no-trade writer rejects checksum mutation and parent mismatch before publication", async () => {
  await withTempDirectory(async (directory) => {
    const parent = validParent();
    const json = await validEvidenceJson(parent);
    const checksumMutated = JSON.parse(json) as { provenance: { source: string } };
    checksumMutated.provenance.source = "mutated-source";
    const differentParent = validParent("different-parent");

    for (const [name, evidence, suppliedParent, expected] of [
      ["checksum", JSON.stringify(checksumMutated), parent, /checksum/i],
      ["parent", json, differentParent, /parent.*sha256/i],
    ] as const) {
      const outputPath = path.join(directory, `${name}.json`);
      const events: string[] = [];
      const writer = createResearchNoTradeEvidenceWriter({
        publishArtifact: async () => { events.push("publish"); },
      });
      await assert.rejects(writer({ outputPath, json: evidence, parentDataset: suppliedParent }), expected);
      assert.deepEqual(events, []);
      await assert.rejects(access(outputPath, constants.F_OK));
      assert.deepEqual(await temporaryFiles(directory, `${name}.json`), []);
    }
  });
});

test("no-trade writer cleans up and preserves event ordering for injected verification and publication failures", async () => {
  await withTempDirectory(async (directory) => {
    const parent = validParent();
    const json = await validEvidenceJson(parent);
    for (const [name, configure, expectedEvents] of [
      ["verify", (events: string[]) => createResearchNoTradeEvidenceWriter({
        verifyArtifact: async () => { events.push("verify"); throw new Error("injected verification failure"); },
        cleanupArtifact: async (temporaryPath) => { events.push("cleanup"); await rm(temporaryPath, { force: true }); },
      }), ["verify", "cleanup"]],
      ["publish", (events: string[]) => createResearchNoTradeEvidenceWriter({
        verifyArtifact: async () => { events.push("verify"); },
        publishArtifact: async () => { events.push("publish"); throw new Error("injected publication failure"); },
        cleanupArtifact: async (temporaryPath) => { events.push("cleanup"); await rm(temporaryPath, { force: true }); },
      }), ["verify", "publish", "cleanup"]],
    ] as const) {
      const outputPath = path.join(directory, `${name}.json`);
      const events: string[] = [];
      await assert.rejects(configure(events)({ outputPath, json, parentDataset: parent }), new RegExp(`injected ${name === "verify" ? "verification" : "publication"} failure`));
      assert.deepEqual(events, expectedEvents);
      await assert.rejects(access(outputPath, constants.F_OK));
      assert.deepEqual(await temporaryFiles(directory, `${name}.json`), []);
    }
  });
});

test("no-trade writer loses exclusive publication race without replacing destination bytes", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "race.json");
    const parent = validParent();
    const writer = createResearchNoTradeEvidenceWriter({
      verifyArtifact: async () => { await writeFile(outputPath, "race-winner", "utf8"); },
    });
    await assert.rejects(
      writer({ outputPath, json: await validEvidenceJson(parent), parentDataset: parent }),
      /exist|EEXIST/i,
    );
    assert.equal(await readFile(outputPath, "utf8"), "race-winner");
    assert.deepEqual(await temporaryFiles(directory, "race.json"), []);
  });
});

test("no-trade writer leaves successful publication intact when cleanup fails", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "btc.no-trade.json");
    const writer = createResearchNoTradeEvidenceWriter({
      cleanupArtifact: async () => { throw new Error("cleanup failed"); },
    });
    await writer({ outputPath, json: await validEvidenceJson(validParent()), parentDataset: validParent() });
    assert.equal((await readFile(outputPath, "utf8")).endsWith("\n"), true);
  });
});

test("no-trade output availability preserves existing bytes", async () => {
  await withTempDirectory(async (directory) => {
    const outputPath = path.join(directory, "existing.json");
    await writeFile(outputPath, "keep", "utf8");
    await assert.rejects(assertResearchNoTradeEvidenceOutputAvailable(outputPath), /already exists/i);
    assert.equal(await readFile(outputPath, "utf8"), "keep");
  });
});

function validOptions(): NoTradeEvidenceCliOptions {
  return { parentDatasetPath: "C:/tmp/research/btc.json", outputPath: "C:/tmp/research/btc.no-trade.json", pageSize: 200, pageLimit: 3 };
}

function dependencies(events: string[], now = new Date("2026-08-01T04:00:00.000Z")): NoTradeEvidenceCliDependencies {
  return {
    now: () => { events.push("now"); return now; },
    readParentDataset: async () => { events.push("read-parent"); return validParent(); },
    assertOutputAvailable: async () => { events.push("assert-output"); },
    createReader: () => { events.push("create-reader"); return fixtureReader(events); },
    writeArtifact: async () => { events.push("write-artifact"); },
  };
}

function validParent(source = "fixture"): ResearchCandleDataset {
  const unsigned = {
    provenance: { schemaVersion: 1 as const, asset: "BTC" as const, market: "KRW-BTC" as const, historyStartAt: "2026-08-01T00:00:00.000Z", endAt: "2026-08-01T02:00:00.000Z", collectedAt: "2026-08-01T03:00:00.000Z", source },
    candles: { "1h": [{ market: "KRW-BTC" as const, timeframe: "1h" as const, openTime: "2026-08-01T01:00:00.000Z", closeTime: "2026-08-01T02:00:00.000Z", openPrice: 100, highPrice: 102, lowPrice: 99, closePrice: 101, volume: 1, quoteVolume: 101 }], "4h": [], "1d": [] },
  };
  return parseResearchCandleDataset(JSON.stringify({ ...unsigned, provenance: { ...unsigned.provenance, sha256: calculateResearchCandleDatasetChecksum(unsigned) } }));
}

function fixtureReader(events: string[]): ResearchNoTradeMinuteCandleReader {
  return { getMinuteCandles: async () => { events.push("public-minute"); return []; } };
}

async function validEvidenceJson(parentDataset: ResearchCandleDataset): Promise<string> {
  return (await acquireUpbitNoTradeEvidence({ getMinuteCandles: async () => [] }, { parentDataset, collectedAt: "2026-08-01T04:00:00.000Z", pageSize: 200, pageLimit: 3 })).json;
}

async function runFixedClockCli(): Promise<{ events: string[]; json: string; summary: Awaited<ReturnType<typeof runNoTradeEvidenceCli>> }> {
  const events: string[] = [];
  let json = "";
  const deps = dependencies(events);
  deps.writeArtifact = async ({ json: artifactJson, parentDataset }) => {
    events.push("write-artifact");
    json = artifactJson;
    assert.equal(parentDataset.provenance.sha256, validParent().provenance.sha256);
  };
  const summary = await runNoTradeEvidenceCli(validOptions(), deps);
  return { events, json, summary };
}

function replaceArgument(key: string, value: string): string[] {
  const result: string[] = [...VALID_ARGV];
  const index = result.indexOf(`--${key}`);
  assert.notEqual(index, -1);
  result[index + 1] = value;
  return result;
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "autotrade-no-trade-cli-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

async function temporaryFiles(directory: string, outputName: string): Promise<string[]> {
  const entries = await readdir(directory).catch(() => []);
  return entries.filter((entry) => entry.startsWith(`.${outputName}.`) && entry.endsWith(".tmp"));
}

async function withFetchTrap(callback: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network access is forbidden in no-trade CLI tests"); }) as typeof fetch;
  try { await callback(); } finally { globalThis.fetch = original; }
}
