import assert from "node:assert/strict";

import {
  analyzeAddPostDecisionExcursions,
} from "../src/modules/performance/performance-add-excursions.js";
import type { AddDecisionExposure } from "../src/modules/performance/performance-add-diagnostics.js";
import type { ResearchCandle, ResearchCandleDataset } from "../src/modules/performance/research-candle-dataset.js";
import type {
  PerformanceTradeFill,
  PerformanceTradeMatchResult,
  PositionEpisode,
} from "../src/modules/performance/performance-trade-matcher.js";
import { test } from "./harness.js";

test("ADD post-decision excursions use only complete persisted hourly candles and preserve provenance", () => {
  const result = analyzeAddPostDecisionExcursions(input({
    decisionAt: "2026-04-20T10:00:00.000000100+09:00",
    closedAt: "2026-04-20T04:00:00.000000100Z",
    candles: [
      candle("2026-04-20T01:00:00.000000100Z", "2026-04-20T02:00:00.000000100Z", 95, 110),
      candle("2026-04-20T02:00:00.000000100Z", "2026-04-20T03:00:00.000000100Z", 90, 120),
      candle("2026-04-20T03:00:00.000000100Z", "2026-04-20T04:00:00.000000100Z", 98, 115),
    ],
  }));

  assert.equal(result.causalClaim, false);
  assert.equal(result.exposures[0]?.status, "KNOWN");
  assert.deepEqual(result.exposures[0]?.maeKrw, { status: "KNOWN", value: -10 });
  assert.deepEqual(result.exposures[0]?.mfeKrw, { status: "KNOWN", value: 20 });
  assert.deepEqual(result.exposures[0]?.maePct, { status: "KNOWN", value: -0.1 });
  assert.deepEqual(result.exposures[0]?.mfePct, { status: "KNOWN", value: 0.2 });
  assert.equal(result.exposures[0]?.evidence.decisionAt, "2026-04-20T10:00:00.000000100+09:00");
  assert.equal(result.exposures[0]?.evidence.candleIntervals.length, 3);
  assert.equal(result.exposures[0]?.provenance.datasetSha256, SHA256);
});

test("ADD post-decision excursions remain unknown when an expected hourly interval is missing", () => {
  const result = analyzeAddPostDecisionExcursions(input({
    candles: [
      candle("2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z", 95, 110),
      candle("2026-04-20T03:00:00Z", "2026-04-20T04:00:00Z", 90, 120),
    ],
  }));

  assert.equal(result.exposures[0]?.status, "UNKNOWN");
  assert.deepEqual(result.exposures[0]?.coverage, {
    expectedIntervalCount: 3,
    observedIntervalCount: 2,
    missingIntervals: ["2026-04-20T02:00:00.000000000Z/2026-04-20T03:00:00.000000000Z"],
  });
  assert.deepEqual(result.exposures[0]?.maeKrw, {
    status: "UNKNOWN",
    reasons: ["MISSING_EXPECTED_HOURLY_CANDLE_COVERAGE"],
  });
});

test("ADD post-decision excursion is not applicable when decision and completed close are the same instant", () => {
  const at = "2026-04-20T01:00:00.000000100Z";
  const result = analyzeAddPostDecisionExcursions(input({ decisionAt: at, closedAt: at, candles: [] }));

  assert.equal(result.exposures[0]?.status, "NOT_APPLICABLE");
  assert.equal(result.exposures[0]?.reason, "DECISION_AND_EPISODE_CLOSE_SAME_INSTANT");
  assert.deepEqual(result.exposures[0]?.maeKrw, {
    status: "NOT_APPLICABLE",
    reason: "DECISION_AND_EPISODE_CLOSE_SAME_INSTANT",
  });
});

test("ADD post-decision excursion uses mixed timezone offsets and nanosecond instants for its window", () => {
  const result = analyzeAddPostDecisionExcursions(input({
    decisionAt: "2026-04-20T10:00:00.000000100+09:00",
    closedAt: "2026-04-20T13:00:00.000000100+09:00",
    candles: [
      candle("2026-04-20T01:00:00.000000100Z", "2026-04-20T02:00:00.000000100Z", 99, 101),
      candle("2026-04-20T02:00:00.000000100Z", "2026-04-20T03:00:00.000000100Z", 97, 103),
      candle("2026-04-20T03:00:00.000000100Z", "2026-04-20T04:00:00.000000100Z", 98, 102),
    ],
  }));

  assert.equal(result.exposures[0]?.status, "KNOWN");
  assert.deepEqual(result.exposures[0]?.maeKrw, { status: "KNOWN", value: -3 });
  assert.deepEqual(result.exposures[0]?.mfeKrw, { status: "KNOWN", value: 3 });
});

test("ADD post-decision excursions reject malformed timestamps and nonpositive candle prices", () => {
  const malformedDecision = input();
  assert.throws(
    () => analyzeAddPostDecisionExcursions({
      ...malformedDecision,
      exposures: [{ ...malformedDecision.exposures[0]!, generatedAt: "not-a-timestamp" }],
    }),
    /decision timestamp must be an exact ISO-8601 timestamp with an explicit timezone/,
  );
  assert.throws(
    () => analyzeAddPostDecisionExcursions(input({
      candles: [candle("2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z", 0, 110)],
    })),
    /lowPrice must be finite and positive/,
  );
});

test("ADD post-decision excursions reject a completed close that is not the terminal exit instant before candle validation", () => {
  const decisionAt = "2026-04-20T01:00:00.000000000Z";
  const earlyExit = { ...exitFill("2026-04-20T02:00:00.000000000Z"), id: "early-exit" };
  const terminalExit = { ...exitFill("2026-04-20T04:00:00.000000000Z"), id: "terminal-exit" };
  const episode = completedEpisode("add-fill", terminalExit.id, decisionAt, "2026-04-20T03:00:00.000000000Z");
  const malformedCandle = candle("2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z", 0, 110);

  assert.throws(
    () => analyzeAddPostDecisionExcursions({
      ...input({ decisionAt, candles: [malformedCandle] }),
      baselineFills: [addFill(decisionAt), terminalExit, earlyExit],
      baselineMatchResult: matchResult({ ...episode, exitFillIds: [terminalExit.id, earlyExit.id] }),
    }),
    /closedAt must match its terminal exit fill/,
  );
});

test("ADD post-decision excursions reject nonfinite prices, market mismatch, and corrupt episode links", () => {
  for (const lowPrice of [Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => analyzeAddPostDecisionExcursions(input({
        candles: [{
          ...candle("2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z", 95, 110),
          lowPrice,
        }],
      })),
      /lowPrice must be finite and positive/,
    );
  }

  const valid = input();
  assert.throws(
    () => analyzeAddPostDecisionExcursions({ ...valid, market: "KRW-ETH" }),
    /ADD excursion market KRW-ETH does not match asset BTC/,
  );
  assert.throws(
    () => analyzeAddPostDecisionExcursions({
      ...valid,
      baselineMatchResult: {
        ...valid.baselineMatchResult,
        episodes: [{ ...valid.baselineMatchResult.episodes[0]!, entryFillIds: ["missing-fill"] }],
      },
    }),
    /corrupt entry fill relationship missing-fill/,
  );
});

const SHA256 = "a".repeat(64);

function input(overrides: {
  decisionAt?: string;
  closedAt?: string;
  candles?: ResearchCandle[];
} = {}) {
  const decisionAt = overrides.decisionAt ?? "2026-04-20T01:00:00.000000000Z";
  const closedAt = overrides.closedAt ?? "2026-04-20T04:00:00.000000000Z";
  const fill = addFill(decisionAt);
  const exit = exitFill(closedAt);
  const episode = completedEpisode(fill.id, exit.id, decisionAt, closedAt);
  return {
    asset: "BTC" as const,
    market: "KRW-BTC" as const,
    dataset: dataset(overrides.candles ?? [
      candle("2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z", 95, 110),
      candle("2026-04-20T02:00:00Z", "2026-04-20T03:00:00Z", 90, 120),
      candle("2026-04-20T03:00:00Z", "2026-04-20T04:00:00Z", 98, 115),
    ]),
    exposures: [exposure(decisionAt, fill.id, episode)],
    baselineFills: [fill, exit],
    baselineMatchResult: matchResult(episode),
  };
}

function exposure(decisionAt: string, fillId: string, episode: PositionEpisode): AddDecisionExposure {
  return {
    id: "exposure-1",
    generatedAt: decisionAt,
    baselineGeneratedAt: decisionAt,
    pairingStatus: "EXECUTED_VS_SUPPRESSED",
    originalEvidence: {
      action: "ADD",
      regime: "BULL_TREND",
      atrShock: false,
      trendAlignmentScore: 4,
      weakeningStage: "NONE",
    },
    baseline: { action: "ADD", executed: true, fillId },
    baselineEpisode: {
      episodeId: episode.id,
      status: episode.status,
      outcome: "WIN",
      netRealizedPnlKrw: 10,
    },
    postDecisionExcursion: { status: "UNKNOWN", reason: "SEE_POST_DECISION_EXCURSION_ANALYSIS" },
    costAndFeeImpact: {
      status: "UNKNOWN",
      completeness: "NOT_AVAILABLE",
      reason: "NO_MATCHED_ADD_FILL",
      entryNotionalKrw: null,
      entryFeeKrw: null,
      realizedQuantity: null,
      remainingQuantity: null,
      realizedGrossPnlBeforeFeesKrw: null,
      allocatedEntryFeeKrw: null,
      allocatedExitFeeKrw: null,
      realizedFeeImpactKrw: null,
      realizedNetPnlKrw: null,
      realizationSliceIds: [],
    },
  };
}

function dataset(candles: ResearchCandle[]): ResearchCandleDataset {
  return {
    provenance: {
      schemaVersion: 1,
      asset: "BTC",
      market: "KRW-BTC",
      historyStartAt: "2026-04-20T00:00:00Z",
      endAt: "2026-04-20T05:00:00Z",
      collectedAt: "2026-04-20T05:00:00Z",
      source: "persisted-test-fixture",
      sha256: SHA256,
    },
    candles: { "1h": candles, "4h": [], "1d": [] },
  };
}

function candle(openTime: string, closeTime: string, lowPrice: number, highPrice: number): ResearchCandle {
  return {
    market: "KRW-BTC",
    timeframe: "1h",
    openTime,
    closeTime,
    openPrice: (lowPrice + highPrice) / 2,
    highPrice,
    lowPrice,
    closePrice: (lowPrice + highPrice) / 2,
    volume: 1,
    quoteVolume: 100,
  };
}

function addFill(filledAt: string): PerformanceTradeFill {
  return {
    id: "add-fill",
    orderId: "add-order",
    strategyDecisionId: "add-decision",
    decisionAction: "ADD",
    market: "KRW-BTC",
    side: "bid",
    priceKrw: 100,
    volume: 1,
    feeKrw: 0,
    filledAt,
  };
}

function exitFill(filledAt: string): PerformanceTradeFill {
  return {
    ...addFill(filledAt),
    id: "exit-fill",
    orderId: "exit-order",
    strategyDecisionId: "exit-decision",
    decisionAction: "EXIT",
    side: "ask",
  };
}

function completedEpisode(
  addFillId: string,
  exitFillId: string,
  openedAt: string,
  closedAt: string,
): PositionEpisode {
  return {
    id: "episode-1",
    market: "KRW-BTC",
    status: "COMPLETED",
    openedAt,
    closedAt,
    entryFillIds: [addFillId],
    exitFillIds: [exitFillId],
    realizationSliceIds: [],
    remainingQuantity: 0,
    grossRealizedPnlKrw: 10,
    realizedFeeImpactKrw: 0,
    netRealizedPnlKrw: 10,
    holdingDurationMs: 1,
  };
}

function matchResult(episode: PositionEpisode): PerformanceTradeMatchResult {
  return {
    realizationSlices: [],
    episodes: [episode],
    unmatchedSells: [],
    attributionFailures: [],
  };
}
