import assert from "node:assert/strict";

import {
  analyzePerformanceExcursions,
  type PerformanceExcursionInput,
} from "../src/modules/performance/performance-excursions.js";
import type {
  ResearchCandle,
  ResearchCandleDataset,
} from "../src/modules/performance/research-candle-dataset.js";
import {
  PERFORMANCE_QUANTITY_TOLERANCE,
  matchPerformanceTrades,
  type PerformanceTradeFill,
} from "../src/modules/performance/performance-trade-matcher.js";
import { test } from "./harness.js";

test("excursion analysis uses complete 1h candles on the exact entry-to-exit boundary", () => {
  const fills = completedEpisodeFills();
  const matchResult = matchPerformanceTrades({ fills });
  const dataset = createDataset([
    candle("2026-04-20T00:00:00.000Z", "2026-04-20T01:00:00.000Z", 10, 200),
    candle("2026-04-20T01:00:00.000Z", "2026-04-20T02:00:00.000Z", 90, 115),
    candle("2026-04-20T02:00:00.000Z", "2026-04-20T03:00:00.000Z", 80, 130),
    candle("2026-04-20T03:00:00.000Z", "2026-04-20T04:00:00.000Z", 95, 125),
    candle("2026-04-20T04:00:00.000Z", "2026-04-20T05:00:00.000Z", 1, 500),
  ]);
  const result = analyzeExcursions({ dataset, fills, matchResult });
  const episode = result.episodes[0];

  assert.ok(episode);
  assert.equal(episode.candleCount, 3);
  assert.deepEqual(episode.maeKrw, { status: "KNOWN", value: -20 });
  assert.deepEqual(episode.mfeKrw, { status: "KNOWN", value: 30 });
  assert.deepEqual(episode.maePct, { status: "KNOWN", value: -0.2 });
  assert.deepEqual(episode.mfePct, { status: "KNOWN", value: 0.3 });
  assert.equal(episode.provenance.firstCandleOpenTime, "2026-04-20T01:00:00.000Z");
  assert.equal(episode.provenance.lastCandleCloseTime, "2026-04-20T04:00:00.000Z");
  assert.equal(episode.provenance.datasetSha256, "a".repeat(64));
  assert.equal(result.scenario, "BASELINE");
  assert.equal(episode.krwSemantics, "PER_UNIT_PRICE_DELTA_FROM_FIRST_ENTRY_FILL");
  assert.deepEqual(episode.evidence, {
    entryFillIds: ["entry"],
    exitFillIds: ["exit"],
    entryAt: "2026-04-20T01:00:00.000Z",
    exitAt: "2026-04-20T04:00:00.000Z",
  });
  assert.notEqual(episode.evidence.entryFillIds, matchResult.episodes[0]?.entryFillIds);
  assert.notEqual(episode.evidence.exitFillIds, matchResult.episodes[0]?.exitFillIds);
  assert.deepEqual(result.evidenceGaps, []);
  assert.deepEqual(result.warnings, [{
    code: "INTRABAR_ORDER_NOT_INFERRED",
    message: "MAE/MFE KRW is a per-unit price excursion from the first entry fill. Hourly OHLC does not reveal intrabar ordering, total-position PnL, or stop execution.",
  }]);
});

test("excursion coverage compares mixed timezone boundaries as exact nanosecond instants", () => {
  const fills = completedEpisodeFills();
  const dataset = createDataset([
    candle("2026-04-20T01:00:00.000000100Z", "2026-04-20T02:00:00.000000100Z", 90, 110),
    candle("2026-04-20T02:00:00.000000100Z", "2026-04-20T03:00:00.000000100Z", 85, 120),
    candle("2026-04-20T03:00:00.000000100Z", "2026-04-20T04:00:00.000000100Z", 95, 125),
  ]);
  const offsetFills = fills.map((fill, index) => index === 0
    ? { ...fill, filledAt: "2026-04-20T10:00:00.000000100+09:00" }
    : { ...fill, filledAt: "2026-04-20T04:00:00.000000100Z" });
  const result = analyzeExcursions({
    dataset,
    fills: offsetFills,
    matchResult: matchPerformanceTrades({ fills: offsetFills }),
  });

  assert.equal(result.episodes[0]?.maeKrw.status, "KNOWN");
  assert.equal(result.episodes[0]?.candleCount, 3);
});

test("excursion metrics are unknown for missing entry, exit, or internal 1h coverage", () => {
  const fills = completedEpisodeFills();
  const matchResult = matchPerformanceTrades({ fills });
  const complete = [
    candle("2026-04-20T01:00:00.000Z", "2026-04-20T02:00:00.000Z", 90, 110),
    candle("2026-04-20T02:00:00.000Z", "2026-04-20T03:00:00.000Z", 85, 120),
    candle("2026-04-20T03:00:00.000Z", "2026-04-20T04:00:00.000Z", 95, 125),
  ];

  const missingEntry = analyzeExcursions({
    dataset: createDataset(complete.slice(1)),
    fills,
    matchResult,
  });
  assert.deepEqual(missingEntry.episodes[0]?.maeKrw, {
    status: "UNKNOWN",
    reasons: ["MISSING_ENTRY_BOUNDARY_COVERAGE"],
  });

  const missingExit = analyzeExcursions({
    dataset: createDataset(complete.slice(0, 2)),
    fills,
    matchResult,
  });
  assert.deepEqual(missingExit.episodes[0]?.mfeKrw, {
    status: "UNKNOWN",
    reasons: ["MISSING_EXIT_BOUNDARY_COVERAGE"],
  });

  const missingInternal = analyzeExcursions({
    dataset: createDataset([complete[0]!, complete[2]!]),
    fills,
    matchResult,
  });
  assert.deepEqual(missingInternal.episodes[0]?.maePct, {
    status: "UNKNOWN",
    reasons: ["MISSING_INTERNAL_CANDLE_COVERAGE"],
  });
  assert.equal(missingInternal.episodes[0]?.candleCount, 2);
});

test("excursion analysis excludes open episodes and opening inventory with explicit gaps", () => {
  const [entry] = completedEpisodeFills();
  assert.ok(entry);
  const openResult = analyzeExcursions({
    dataset: createDataset([]),
    fills: [entry],
    matchResult: matchPerformanceTrades({ fills: [entry] }),
  });
  assert.deepEqual(openResult.episodes, []);
  assert.equal(openResult.evidenceGaps[0]?.code, "OPEN_EPISODE_EXCLUDED");

  const sell: PerformanceTradeFill = {
    id: "opening-exit",
    orderId: "opening-exit-order",
    strategyDecisionId: "opening-exit-decision",
    decisionAction: "EXIT",
    market: "KRW-BTC",
    side: "ask",
    priceKrw: 110,
    volume: 1,
    feeKrw: 0,
    filledAt: "2026-04-20T04:00:00.000Z",
  };
  const openingMatch = matchPerformanceTrades({
    fills: [sell],
    openingPositions: [{ market: "KRW-BTC", quantity: 1, averagePriceKrw: 100 }],
  });
  const openingResult = analyzeExcursions({
    dataset: createDataset([]),
    fills: [sell],
    matchResult: openingMatch,
  });
  assert.deepEqual(openingResult.episodes, []);
  assert.equal(openingResult.evidenceGaps[0]?.code, "LEFT_CENSORED_OPENING_INVENTORY");

  const [openingSlice] = openingMatch.realizationSlices;
  assert.ok(openingSlice);
  assert.throws(
    () => analyzeExcursions({
      dataset: createDataset([]),
      fills: [sell],
      matchResult: {
        ...openingMatch,
        realizationSlices: [{
          ...openingSlice,
          exit: {
            fillId: null,
            orderId: null,
            strategyDecisionId: null,
            decisionAction: null,
            occurredAt: null,
            priceKrw: null,
          },
        }],
      },
    }),
    /exit fill evidence/,
  );
});

test("excursion analysis rejects corrupt timestamps, candles, markets, and lifecycle references", () => {
  const fills = completedEpisodeFills();
  const matchResult = matchPerformanceTrades({ fills });
  const valid = candle("2026-04-20T01:00:00.000Z", "2026-04-20T02:00:00.000Z", 90, 110);

  assert.throws(
    () => analyzeExcursions({
      dataset: createDataset([{ ...valid, openTime: "2026-04-20T01:00:00" }]),
      fills,
      matchResult,
    }),
    /openTime/,
  );
  assert.throws(
    () => analyzeExcursions({
      dataset: createDataset([{ ...valid, market: "KRW-ETH" }]),
      fills,
      matchResult,
    }),
    /market/,
  );
  assert.throws(
    () => analyzeExcursions({
      dataset: createDataset([{ ...valid, highPrice: Number.POSITIVE_INFINITY }]),
      fills,
      matchResult,
    }),
    /highPrice/,
  );
  assert.throws(
    () => analyzeExcursions({
      dataset: createDataset([{ ...valid, lowPrice: -1 }]),
      fills,
      matchResult,
    }),
    /lowPrice/,
  );

  const [episode] = matchResult.episodes;
  assert.ok(episode);
  const brokenMatch = {
    ...matchResult,
    episodes: [{ ...episode, entryFillIds: ["missing-entry"] }],
  };
  assert.throws(
    () => analyzeExcursions({ dataset: createDataset([]), fills, matchResult: brokenMatch }),
    /cross-episode entry fill|lifecycle fill missing-entry/,
  );

  const [firstSlice, ...remainingSlices] = matchResult.realizationSlices;
  assert.ok(firstSlice);
  assert.throws(
    () => analyzeExcursions({
      dataset: createDataset([]),
      fills,
      matchResult: {
        ...matchResult,
        realizationSlices: [{
          ...firstSlice,
          allocatedSellFeeKrw: -1,
          netRealizedPnlKrw: Number.POSITIVE_INFINITY,
        }, ...remainingSlices],
      },
    }),
    /allocated sell fee/,
  );
});

test("excursion analysis carries explicit counterfactual scenario provenance", () => {
  const fills = completedEpisodeFills();
  const input = {
    dataset: createDataset([
      candle("2026-04-20T01:00:00.000Z", "2026-04-20T02:00:00.000Z", 90, 110),
      candle("2026-04-20T02:00:00.000Z", "2026-04-20T03:00:00.000Z", 90, 110),
      candle("2026-04-20T03:00:00.000Z", "2026-04-20T04:00:00.000Z", 90, 110),
    ]),
    fills,
    matchResult: matchPerformanceTrades({ fills }),
  };

  assert.equal(analyzePerformanceExcursions({ ...input, scenario: "NO_ADD" }).scenario, "NO_ADD");
  assert.equal(analyzePerformanceExcursions({ ...input, scenario: "BASELINE" }).evidenceKind, "SIMULATED_COUNTERFACTUAL");
  assert.throws(
    () => analyzePerformanceExcursions({ ...input, scenario: "INVALID" as "BASELINE" }),
    /scenario/,
  );
});

test("excursion analysis rejects forged episode roles, terminal state, and bidirectional links", () => {
  const fills = completedEpisodeFills();
  const matchResult = matchPerformanceTrades({ fills });
  const [episode] = matchResult.episodes;
  const [slice] = matchResult.realizationSlices;
  assert.ok(episode && slice);
  const input = { dataset: createDataset([]), fills, matchResult };

  assert.throws(
    () => analyzeExcursions({
      ...input,
      matchResult: {
        ...matchResult,
        episodes: [{ ...episode, entryFillIds: ["entry", "exit"] }],
      },
    }),
    /entry fill.*bid/,
  );
  assert.throws(
    () => analyzeExcursions({
      ...input,
      matchResult: {
        ...matchResult,
        episodes: [{ ...episode, exitFillIds: ["exit", "entry"] }],
      },
    }),
    /exit fill.*ask|terminal exit fill/,
  );
  assert.throws(
    () => analyzeExcursions({
      ...input,
      matchResult: {
        ...matchResult,
        episodes: [{ ...episode, closedAt: "2026-04-20T05:00:00.000Z" }],
      },
    }),
    /terminal exit fill/,
  );
  assert.throws(
    () => analyzeExcursions({
      ...input,
      matchResult: {
        ...matchResult,
        episodes: [{
          ...episode,
          remainingQuantity: PERFORMANCE_QUANTITY_TOLERANCE * 2,
        }],
      },
    }),
    /remainingQuantity.*tolerance/,
  );
  assert.doesNotThrow(() => analyzeExcursions({
    ...input,
    matchResult: {
      ...matchResult,
      episodes: [{ ...episode, remainingQuantity: PERFORMANCE_QUANTITY_TOLERANCE }],
    },
  }));
  assert.throws(
    () => analyzeExcursions({
      ...input,
      matchResult: {
        ...matchResult,
        episodes: [{ ...episode, realizationSliceIds: [] }],
      },
    }),
    /bidirectional lifecycle/,
  );
  assert.throws(
    () => analyzeExcursions({
      ...input,
      matchResult: {
        ...matchResult,
        realizationSlices: [{ ...slice, episodeId: "forged-episode" }],
      },
    }),
    /episode lifecycle|bidirectional lifecycle/,
  );
  assert.throws(
    () => analyzeExcursions({
      ...input,
      matchResult: {
        ...matchResult,
        realizationSlices: [{
          ...slice,
          entry: { ...slice.entry, strategyDecisionId: "forged-decision" },
        }],
      },
    }),
    /evidence contradicts lifecycle fill/,
  );
});

test("excursion analysis rejects non-finite derived per-unit ratios", () => {
  const fills = completedEpisodeFills().map((item) => ({
    ...item,
    priceKrw: Number.MIN_VALUE,
  }));
  const resultInput = {
    dataset: createDataset([
      candle("2026-04-20T01:00:00.000Z", "2026-04-20T02:00:00.000Z", Number.MIN_VALUE, Number.MAX_VALUE),
      candle("2026-04-20T02:00:00.000Z", "2026-04-20T03:00:00.000Z", Number.MIN_VALUE, Number.MAX_VALUE),
      candle("2026-04-20T03:00:00.000Z", "2026-04-20T04:00:00.000Z", Number.MIN_VALUE, Number.MAX_VALUE),
    ]),
    fills,
    matchResult: matchPerformanceTrades({ fills }),
  };

  assert.throws(() => analyzeExcursions(resultInput), /mfePct.*finite/);
});

function completedEpisodeFills(): PerformanceTradeFill[] {
  return [
    {
      id: "entry",
      orderId: "entry-order",
      strategyDecisionId: "entry-decision",
      decisionAction: "ENTER",
      market: "KRW-BTC",
      side: "bid",
      priceKrw: 100,
      volume: 1,
      feeKrw: 0,
      filledAt: "2026-04-20T01:00:00.000Z",
    },
    {
      id: "exit",
      orderId: "exit-order",
      strategyDecisionId: "exit-decision",
      decisionAction: "EXIT",
      market: "KRW-BTC",
      side: "ask",
      priceKrw: 120,
      volume: 1,
      feeKrw: 0,
      filledAt: "2026-04-20T04:00:00.000Z",
    },
  ];
}

function candle(openTime: string, closeTime: string, lowPrice: number, highPrice: number): ResearchCandle {
  return {
    market: "KRW-BTC",
    timeframe: "1h",
    openTime,
    closeTime,
    openPrice: 100,
    highPrice,
    lowPrice,
    closePrice: 100,
    volume: 1,
    quoteVolume: 100,
  };
}

function createDataset(candles: readonly ResearchCandle[]): ResearchCandleDataset {
  return {
    provenance: {
      schemaVersion: 1,
      asset: "BTC",
      market: "KRW-BTC",
      historyStartAt: "2026-04-19T00:00:00.000Z",
      endAt: "2026-04-21T00:00:00.000Z",
      collectedAt: "2026-04-21T00:00:00.000Z",
      source: "fixture",
      sha256: "a".repeat(64),
    },
    candles: { "1h": [...candles], "4h": [], "1d": [] },
  };
}

function analyzeExcursions(input: Omit<PerformanceExcursionInput, "scenario">) {
  return analyzePerformanceExcursions({ ...input, scenario: "BASELINE" });
}
