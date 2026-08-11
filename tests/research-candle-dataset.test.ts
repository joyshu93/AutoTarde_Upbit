import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  calculateResearchCandleDatasetChecksum,
  parseResearchCandleDataset,
  readResearchCandleDataset,
  type ResearchCandle,
  type ResearchCandleDataset,
  type ResearchCandleTimeframe,
} from "../src/modules/performance/research-candle-dataset.js";
import { test } from "./harness.js";

type ResearchCandleDatasetInput = Omit<ResearchCandleDataset, "provenance"> & {
  provenance: Omit<ResearchCandleDataset["provenance"], "sha256">;
};

test("research candle dataset accepts checksum-verified BTC and ETH candles", () => {
  for (const asset of ["BTC", "ETH"] as const) {
    const dataset = withChecksum(baseDataset(asset));

    const parsed = parseResearchCandleDataset(JSON.stringify(dataset));

    assert.equal(parsed.provenance.asset, asset);
    assert.equal(parsed.provenance.market, asset === "BTC" ? "KRW-BTC" : "KRW-ETH");
    assert.equal(parsed.candles["1h"][0]?.timeframe, "1h");
    assert.equal(parsed.candles["4h"][0]?.timeframe, "4h");
    assert.equal(parsed.candles["1d"][0]?.timeframe, "1d");
  }
});

test("research candle dataset rejects a candle whose market disagrees with provenance", () => {
  const dataset = withChecksum(baseDataset("BTC"));
  dataset.candles["4h"][0]!.market = "KRW-ETH";

  assert.throws(
    () => parseResearchCandleDataset(JSON.stringify(dataset)),
    /market.*KRW-BTC/i,
  );
});

test("research candle dataset rejects invalid OHLC and numeric candle values", () => {
  const invalidOhlc = withChecksum(baseDataset("BTC"));
  invalidOhlc.candles["1h"][0]!.lowPrice = 102;
  assert.throws(
    () => parseResearchCandleDataset(JSON.stringify(invalidOhlc)),
    /lowPrice.*openPrice/i,
  );

  const invalidNumber = withChecksum(baseDataset("ETH"));
  invalidNumber.candles["1d"][0]!.volume = -1;
  assert.throws(
    () => parseResearchCandleDataset(JSON.stringify(invalidNumber)),
    /volume.*non-negative/i,
  );
});

test("research candle dataset rejects raw JSON numeric overflow in every candle number field", () => {
  for (const field of [
    "openPrice",
    "highPrice",
    "lowPrice",
    "closePrice",
    "volume",
    "quoteVolume",
  ] as const) {
    const rawJson = replaceFirstCandleNumberWithRawOverflow(baseDataset("BTC"), field);

    assert.match(rawJson, new RegExp(`"${field}":1e309`));
    assert.throws(
      () => parseResearchCandleDataset(rawJson),
      new RegExp(`${field}.*finite`, "i"),
    );
  }
});

test("research candle dataset rejects duplicate and out-of-order candle instants", () => {
  const duplicate = withChecksum(baseDataset("BTC"));
  duplicate.candles["1h"].push({ ...duplicate.candles["1h"][0]! });
  assert.throws(
    () => parseResearchCandleDataset(JSON.stringify(duplicate)),
    /strictly ordered/i,
  );

  const outOfOrder = withChecksum(baseDataset("ETH"));
  outOfOrder.candles["4h"] = [
    candle("KRW-ETH", "4h", "2026-08-01T04:00:00.000Z", "2026-08-01T08:00:00.000Z"),
    candle("KRW-ETH", "4h", "2026-08-01T00:00:00.000Z", "2026-08-01T04:00:00.000Z"),
  ];
  assert.throws(
    () => parseResearchCandleDataset(JSON.stringify(outOfOrder)),
    /strictly ordered/i,
  );
});

test("research candle dataset orders mixed-timezone candle instants by their exact epoch", () => {
  const valid = baseDataset("BTC");
  valid.candles["1h"] = [
    candle(
      "KRW-BTC",
      "1h",
      "2026-08-01T09:00:00.000000001+09:00",
      "2026-08-01T01:00:00.000000001Z",
    ),
    candle(
      "KRW-BTC",
      "1h",
      "2026-08-01T00:00:00.000000003Z",
      "2026-08-01T01:00:00.000000003Z",
    ),
  ];
  assert.doesNotThrow(() => parseResearchCandleDataset(JSON.stringify(withChecksum(valid))));

  const invalid = baseDataset("BTC");
  invalid.candles["1h"] = [
    candle(
      "KRW-BTC",
      "1h",
      "2026-08-01T00:00:00.000000003Z",
      "2026-08-01T01:00:00.000000003Z",
    ),
    candle(
      "KRW-BTC",
      "1h",
      "2026-08-01T09:00:00.000000001+09:00",
      "2026-08-01T01:00:00.000000001Z",
    ),
  ];
  assert.throws(
    () => parseResearchCandleDataset(JSON.stringify(withChecksum(invalid))),
    /strictly ordered/i,
  );
});

test("research candle dataset accepts exact timeframe durations by epoch nanoseconds", () => {
  const dataset = baseDataset("BTC");
  dataset.candles = {
    "1h": [candle(
      "KRW-BTC",
      "1h",
      "2026-08-01T09:00:00.000000001+09:00",
      "2026-08-01T01:00:00.000000001Z",
    )],
    "4h": [candle(
      "KRW-BTC",
      "4h",
      "2026-08-01T09:00:00.000000002+09:00",
      "2026-08-01T04:00:00.000000002Z",
    )],
    "1d": [candle(
      "KRW-BTC",
      "1d",
      "2026-08-01T08:59:59.999999997+09:00",
      "2026-08-01T23:59:59.999999997Z",
    )],
  };

  assert.doesNotThrow(() => parseResearchCandleDataset(JSON.stringify(withChecksum(dataset))));
});

test("research candle dataset rejects candles with the wrong nominal timeframe duration", () => {
  const cases: ReadonlyArray<{
    timeframe: ResearchCandleTimeframe;
    closeTime: string;
    expectedDuration: string;
  }> = [
    { timeframe: "1h", closeTime: "2026-08-01T00:59:59.999999999Z", expectedDuration: "1 hour" },
    { timeframe: "4h", closeTime: "2026-08-01T04:00:00.000000001Z", expectedDuration: "4 hours" },
    { timeframe: "1d", closeTime: "2026-08-01T23:59:59.999999999Z", expectedDuration: "24 hours" },
  ];

  for (const { timeframe, closeTime, expectedDuration } of cases) {
    const dataset = withChecksum(baseDataset("ETH"));
    dataset.candles[timeframe][0]!.closeTime = closeTime;

    assert.throws(
      () => parseResearchCandleDataset(JSON.stringify(dataset)),
      new RegExp(`${timeframe}.*duration.*${expectedDuration}`, "i"),
    );
  }
});

test("research candle dataset rejects unsupported schemas and missing timeframe arrays", () => {
  const unsupported = withChecksum(baseDataset("BTC")) as unknown as {
    provenance: { schemaVersion: number };
  };
  unsupported.provenance.schemaVersion = 2;
  assert.throws(
    () => parseResearchCandleDataset(JSON.stringify(unsupported)),
    /schemaVersion.*1/i,
  );

  const missingTimeframe = withChecksum(baseDataset("ETH"));
  delete (missingTimeframe.candles as Partial<ResearchCandleDataset["candles"]>)["1d"];
  assert.throws(
    () => parseResearchCandleDataset(JSON.stringify(missingTimeframe)),
    /1d.*array/i,
  );
});

test("research candle dataset rejects declared checksum mismatch", () => {
  const dataset = withChecksum(baseDataset("BTC"));
  dataset.provenance.sha256 = "0".repeat(64);

  assert.throws(
    () => parseResearchCandleDataset(JSON.stringify(dataset)),
    /checksum/i,
  );
});

test("research candle dataset checksum ignores JSON whitespace and property order", () => {
  const original = withChecksum(baseDataset("BTC"));
  const reordered: ResearchCandleDataset = {
    candles: {
      "1d": original.candles["1d"],
      "4h": original.candles["4h"],
      "1h": original.candles["1h"],
    },
    provenance: {
      source: original.provenance.source,
      collectedAt: original.provenance.collectedAt,
      sha256: original.provenance.sha256,
      endAt: original.provenance.endAt,
      market: original.provenance.market,
      historyStartAt: original.provenance.historyStartAt,
      asset: original.provenance.asset,
      schemaVersion: original.provenance.schemaVersion,
    },
  };
  const candlePropertyReordered: ResearchCandleDataset = {
    ...original,
    candles: {
      ...original.candles,
      "1h": [{
        quoteVolume: original.candles["1h"][0]!.quoteVolume,
        volume: original.candles["1h"][0]!.volume,
        closePrice: original.candles["1h"][0]!.closePrice,
        lowPrice: original.candles["1h"][0]!.lowPrice,
        highPrice: original.candles["1h"][0]!.highPrice,
        openPrice: original.candles["1h"][0]!.openPrice,
        closeTime: original.candles["1h"][0]!.closeTime,
        openTime: original.candles["1h"][0]!.openTime,
        timeframe: original.candles["1h"][0]!.timeframe,
        market: original.candles["1h"][0]!.market,
      }],
    },
  };

  const originalChecksum = calculateResearchCandleDatasetChecksum(withoutChecksum(original));
  const reorderedChecksum = calculateResearchCandleDatasetChecksum(withoutChecksum(reordered));
  const candlePropertyReorderedChecksum = calculateResearchCandleDatasetChecksum(
    withoutChecksum(candlePropertyReordered),
  );

  assert.equal(reorderedChecksum, originalChecksum);
  assert.equal(candlePropertyReorderedChecksum, originalChecksum);
  assert.equal(
    parseResearchCandleDataset(JSON.stringify(reordered, null, 2)).provenance.sha256,
    parseResearchCandleDataset(JSON.stringify(original)).provenance.sha256,
  );
});

test("research candle dataset checksum changes when a validated candle price changes", () => {
  const original = baseDataset("ETH");
  const changed = baseDataset("ETH");
  changed.candles["1h"][0]!.closePrice = 101.5;

  assert.notEqual(
    calculateResearchCandleDatasetChecksum(original),
    calculateResearchCandleDatasetChecksum(changed),
  );
});

test("research candle dataset reader rejects empty and malformed local JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autotrade-research-candles-"));
  const emptyPath = join(directory, "empty.json");
  const malformedPath = join(directory, "malformed.json");
  const validPath = join(directory, "valid.json");

  try {
    await writeFile(emptyPath, "", "utf8");
    await writeFile(malformedPath, "{not-json", "utf8");
    await writeFile(validPath, JSON.stringify(withChecksum(baseDataset("ETH"))), "utf8");

    await assert.rejects(readResearchCandleDataset(emptyPath), /empty/i);
    await assert.rejects(readResearchCandleDataset(malformedPath), /JSON/i);
    assert.equal((await readResearchCandleDataset(validPath)).provenance.asset, "ETH");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function baseDataset(asset: "BTC" | "ETH"): ResearchCandleDatasetInput {
  const market: ResearchCandle["market"] = asset === "BTC" ? "KRW-BTC" : "KRW-ETH";
  return {
    provenance: {
      schemaVersion: 1 as const,
      asset,
      market,
      historyStartAt: "2026-07-01T00:00:00.000Z",
      endAt: "2026-08-02T00:00:00.000Z",
      collectedAt: "2026-08-03T00:00:00.000Z",
      source: "upbit-public-historical-candles",
    },
    candles: {
      "1h": [candle(market, "1h", "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z")],
      "4h": [candle(market, "4h", "2026-08-01T00:00:00.000Z", "2026-08-01T04:00:00.000Z")],
      "1d": [candle(market, "1d", "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z")],
    },
  };
}

function candle(
  market: ResearchCandle["market"],
  timeframe: ResearchCandleTimeframe,
  openTime: string,
  closeTime: string,
): ResearchCandle {
  return {
    market,
    timeframe,
    openTime,
    closeTime,
    openPrice: 100,
    highPrice: 102,
    lowPrice: 99,
    closePrice: 101,
    volume: 0,
    quoteVolume: 101,
  };
}

function withChecksum(dataset: ResearchCandleDatasetInput): ResearchCandleDataset {
  return {
    ...dataset,
    provenance: {
      ...dataset.provenance,
      sha256: calculateResearchCandleDatasetChecksum(dataset),
    },
  };
}

function withoutChecksum(dataset: ResearchCandleDataset): ResearchCandleDatasetInput {
  const { sha256: _sha256, ...provenance } = dataset.provenance;
  return { ...dataset, provenance };
}

function replaceFirstCandleNumberWithRawOverflow(
  dataset: ResearchCandleDatasetInput,
  field: "openPrice" | "highPrice" | "lowPrice" | "closePrice" | "volume" | "quoteVolume",
): string {
  const signedJson = JSON.stringify(withChecksum(dataset));
  return signedJson.replace(
    new RegExp(`("${field}":)-?\\d+(?:\\.\\d+)?`),
    "$11e309",
  );
}
