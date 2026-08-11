import assert from "node:assert/strict";

import {
  buildResearchCandleDataset,
} from "../src/modules/performance/research-candle-dataset-builder.js";
import {
  parseResearchCandleDataset,
  type ResearchCandleTimeframe,
} from "../src/modules/performance/research-candle-dataset.js";
import type { SupportedMarket } from "../src/domain/types.js";
import type { StrategyMarketCandle } from "../src/modules/strategy/market-structure.js";
import { test } from "./harness.js";

test("research candle dataset builder signs and serializes valid BTC and ETH candles", () => {
  for (const asset of ["BTC", "ETH"] as const) {
    const market = asset === "BTC" ? "KRW-BTC" : "KRW-ETH";
    const result = buildResearchCandleDataset({
      asset,
      historyStartAt: "2026-07-01T00:00:00.000Z",
      endAt: "2026-08-02T00:00:00.000Z",
      collectedAt: "2026-08-03T00:00:00.000Z",
      source: "upbit-public-historical-candles",
      candles: validCandles(market),
    });

    assert.equal(result.dataset.provenance.market, market);
    assert.equal(
      parseResearchCandleDataset(result.json).provenance.sha256,
      result.dataset.provenance.sha256,
    );
    assert.deepEqual(result.candleCounts, { "1h": 1, "4h": 1, "1d": 1 });
    assert.equal(result.json.endsWith("\n"), true);
  }
});

test("research candle dataset builder sorts newest-first mixed-offset candles by exact instant", () => {
  const candles = validCandles("KRW-BTC");
  candles["1h"] = [
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

  const result = buildBtc(candles);

  assert.deepEqual(result.dataset.candles["1h"].map(({ openTime }) => openTime), [
    "2026-08-01T09:00:00.000000001+09:00",
    "2026-08-01T00:00:00.000000003Z",
  ]);
});

test("research candle dataset builder excludes a candle opening before historyStartAt", () => {
  const candles = validCandles("KRW-BTC");
  candles["1h"] = [
    candle("KRW-BTC", "1h", "2026-07-31T23:00:00.000Z", "2026-08-01T00:00:00.000Z"),
    candle("KRW-BTC", "1h", "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z"),
  ];

  const result = buildBtc(candles, {
    historyStartAt: "2026-08-01T00:00:00.000Z",
  });

  assert.deepEqual(result.dataset.candles["1h"].map(({ openTime }) => openTime), [
    "2026-08-01T00:00:00.000Z",
  ]);
});

test("research candle dataset builder excludes a candle closing after endAt", () => {
  const candles = validCandles("KRW-BTC");
  candles["1h"] = [
    candle("KRW-BTC", "1h", "2026-08-01T23:00:00.000Z", "2026-08-02T00:00:00.000Z"),
    candle("KRW-BTC", "1h", "2026-08-02T00:00:00.000Z", "2026-08-02T01:00:00.000Z"),
  ];

  const result = buildBtc(candles);

  assert.deepEqual(result.dataset.candles["1h"].map(({ closeTime }) => closeTime), [
    "2026-08-02T00:00:00.000Z",
  ]);
});

test("research candle dataset builder retains a candle exactly on both requested boundaries", () => {
  const result = buildBtc(validCandles("KRW-BTC"), {
    historyStartAt: "2026-08-01T00:00:00.000Z",
  });

  assert.equal(result.dataset.candles["1d"][0]?.openTime, "2026-08-01T00:00:00.000Z");
  assert.equal(result.dataset.candles["1d"][0]?.closeTime, "2026-08-02T00:00:00.000Z");
});

test("research candle dataset builder rejects invalid provenance ranges before filtering", () => {
  const candles = validCandles("KRW-BTC");

  assert.throws(
    () => buildBtc(candles, { historyStartAt: "2026-08-02T00:00:00.000Z" }),
    /historyStartAt.*before.*endAt/i,
  );
  assert.throws(
    () => buildBtc(candles, { endAt: "2026-08-04T00:00:00.000Z" }),
    /endAt.*collectedAt/i,
  );
  assert.throws(
    () => buildBtc(candles, { historyStartAt: "2026-08-01T00:00:00" }),
    /historyStartAt.*explicit-timezone/i,
  );
});

test("research candle dataset builder rejects an empty post-filter timeframe", () => {
  const candles = validCandles("KRW-BTC");
  candles["1h"] = [
    candle("KRW-BTC", "1h", "2026-07-31T23:00:00.000Z", "2026-08-01T00:00:00.000Z"),
  ];

  assert.throws(
    () => buildBtc(candles, { historyStartAt: "2026-08-01T00:00:00.000Z" }),
    /1h.*at least one/i,
  );
});

test("research candle dataset builder produces byte-identical output for fixed input", () => {
  const candles = validCandles("KRW-BTC");

  const first = buildBtc(candles);
  const second = buildBtc(candles);

  assert.equal(second.json, first.json);
  assert.equal(second.dataset.provenance.sha256, first.dataset.provenance.sha256);
});

test("research candle dataset builder delegates candle corruption validation", () => {
  const corruptions: ReadonlyArray<{
    name: string;
    mutate: (candles: Record<ResearchCandleTimeframe, StrategyMarketCandle[]>) => void;
    error: RegExp;
  }> = [
    {
      name: "wrong market",
      mutate: (candles) => { candles["1h"][0]!.market = "KRW-ETH"; },
      error: /market.*KRW-BTC/i,
    },
    {
      name: "wrong duration",
      mutate: (candles) => { candles["4h"][0]!.closeTime = "2026-08-01T03:59:59.999Z"; },
      error: /4h.*duration.*4 hours/i,
    },
    {
      name: "duplicate open instant",
      mutate: (candles) => { candles["1h"].push({ ...candles["1h"][0]! }); },
      error: /strictly ordered/i,
    },
    {
      name: "NaN",
      mutate: (candles) => { candles["1h"][0]!.openPrice = Number.NaN; },
      error: /openPrice.*finite/i,
    },
    {
      name: "Infinity",
      mutate: (candles) => { candles["1h"][0]!.highPrice = Number.POSITIVE_INFINITY; },
      error: /highPrice.*finite/i,
    },
    {
      name: "negative volume",
      mutate: (candles) => { candles["1h"][0]!.volume = -1; },
      error: /volume.*non-negative/i,
    },
    {
      name: "invalid OHLC",
      mutate: (candles) => { candles["1h"][0]!.lowPrice = 103; },
      error: /lowPrice.*openPrice/i,
    },
    {
      name: "timezone-less candle timestamp",
      mutate: (candles) => { candles["1h"][0]!.openTime = "2026-08-01T00:00:00.000"; },
      error: /openTime.*explicit-timezone/i,
    },
  ];

  for (const corruption of corruptions) {
    const candles = mutableCandles("KRW-BTC");
    corruption.mutate(candles);
    assert.throws(() => buildBtc(candles), corruption.error, corruption.name);
  }
});

test("research candle dataset builder does not mutate caller candle arrays or objects", () => {
  const candles = mutableCandles("KRW-BTC");
  candles["1h"].unshift(
    candle("KRW-BTC", "1h", "2026-07-31T23:00:00.000Z", "2026-08-01T00:00:00.000Z"),
  );
  candles["4h"].reverse();
  const before = structuredClone(candles);

  buildBtc(candles, { historyStartAt: "2026-08-01T00:00:00.000Z" });

  assert.deepEqual(candles, before);
});

function buildBtc(
  candles: Record<ResearchCandleTimeframe, readonly StrategyMarketCandle[]>,
  overrides: Partial<{
    historyStartAt: string;
    endAt: string;
    collectedAt: string;
  }> = {},
) {
  return buildResearchCandleDataset({
    asset: "BTC",
    historyStartAt: overrides.historyStartAt ?? "2026-07-01T00:00:00.000Z",
    endAt: overrides.endAt ?? "2026-08-02T00:00:00.000Z",
    collectedAt: overrides.collectedAt ?? "2026-08-03T00:00:00.000Z",
    source: "upbit-public-historical-candles",
    candles,
  });
}

function validCandles(
  market: SupportedMarket,
): Record<ResearchCandleTimeframe, StrategyMarketCandle[]> {
  return {
    "1h": [candle(market, "1h", "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z")],
    "4h": [candle(market, "4h", "2026-08-01T00:00:00.000Z", "2026-08-01T04:00:00.000Z")],
    "1d": [candle(market, "1d", "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z")],
  };
}

function mutableCandles(
  market: SupportedMarket,
): Record<ResearchCandleTimeframe, StrategyMarketCandle[]> {
  return validCandles(market);
}

function candle(
  market: SupportedMarket,
  timeframe: ResearchCandleTimeframe,
  openTime: string,
  closeTime: string,
): StrategyMarketCandle {
  return {
    market,
    timeframe,
    openTime,
    closeTime,
    openPrice: 100,
    highPrice: 102,
    lowPrice: 99,
    closePrice: 101,
    volume: 1,
    quoteVolume: 101,
  };
}
