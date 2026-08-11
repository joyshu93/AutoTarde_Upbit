import assert from "node:assert/strict";

import type { PositionGuardStructureAnalysis } from "../src/modules/strategy/position-guard-core.js";
import type {
  PositionGuardBacktestFrame,
  PositionGuardBacktestFrameResult,
} from "../src/modules/strategy/position-guard-backtest.js";
import {
  analyzePerformanceRegimes,
  PERFORMANCE_REGIME_EPISODE_RECONCILIATION_TOLERANCE_KRW,
} from "../src/modules/performance/performance-regimes.js";
import {
  runCounterfactualScenarios,
  type CounterfactualScenarioResult,
} from "../src/modules/performance/strategy-counterfactual.js";
import {
  matchPerformanceTrades,
  type PerformanceTradeFill,
} from "../src/modules/performance/performance-trade-matcher.js";
import { test } from "./harness.js";

test("regime analysis keeps entry and exit PnL views separate", () => {
  const scenario = createCompletedScenario();
  const result = analyzeScenario(scenario);
  const entry = result.regimes.BULL_TREND.entryAttribution;
  const weakExit = result.regimes.WEAK_DOWNTREND.exitAttribution;
  const finalExit = result.regimes.BREAKDOWN_RISK.exitAttribution;

  assert.equal(result.regimes.BULL_TREND.frameCount, 1);
  assert.equal(result.regimes.BULL_TREND.decisionCounts.ADD, 1);
  assert.equal(result.regimes.BULL_TREND.executedFrameCount, 1);
  assert.equal(result.regimes.BULL_TREND.fillCount, 1);
  assert.equal(entry.dimension, "ENTRY_REGIME_ATTRIBUTION");
  assert.equal(entry.realizationSliceCount, 2);
  assert.equal(entry.completedEpisodeCount, 1);
  assert.deepEqual(entry.episodeSampleSupport, {
    policy: "OBSERVATION_COUNT_V1",
    unit: "COMPLETED_EPISODES",
    observedCount: 1,
    requiredCount: 30,
    status: "INSUFFICIENT",
  });
  assert.deepEqual(entry.realizationSliceSampleSupport, {
    policy: "OBSERVATION_COUNT_V1",
    unit: "REALIZATION_SLICES",
    observedCount: 2,
    requiredCount: 30,
    status: "INSUFFICIENT",
  });
  assert.equal(weakExit.realizationSliceCount, 2);
  assert.equal(finalExit.realizationSliceCount, 1);
  assert.equal(finalExit.completedEpisodeCount, 1);
  assert.equal(finalExit.dimension, "EXIT_REGIME_ATTRIBUTION");
  assert.equal(result.regimes.BULL_TREND.costCompleteness, "COMPLETE");
  assert.deepEqual(result.evidenceGaps, [{
    code: "LEFT_CENSORED_OPENING_INVENTORY",
    severity: "WARNING",
    scope: "ENTRY_REGIME_ATTRIBUTION",
    affectedMetrics: ["entryAttribution"],
    evidenceIds: [scenario.matchResult.realizationSlices[0]?.id],
    message: "Opening inventory realization has no observed entry regime and is excluded from entry-regime attribution.",
  }]);

  const weakExitSlices = scenario.matchResult.realizationSlices.filter(
    (slice) => slice.exit.occurredAt === "2026-04-20T02:00:00.000Z",
  );
  assert.equal(weakExitSlices.some((slice) => slice.source === "OPENING"), true);
  assert.deepEqual(weakExit.grossRealizedPnlKrw, {
    status: "KNOWN",
    value: weakExitSlices.reduce(
      (sum, slice) => sum + (slice.grossPnlBeforeFeesKrw ?? 0),
      0,
    ),
  });
  assert.deepEqual(weakExit.netRealizedPnlKrw, {
    status: "UNKNOWN",
    reasons: ["MISSING_FILL_FEE"],
  });
  assert.equal(result.regimes.WEAK_DOWNTREND.costCompleteness, "COMPLETE");
  assert.equal(result.regimes.WEAK_DOWNTREND.feeCompleteness, "INCOMPLETE");
  assert.deepEqual(result.warnings, [{
    code: "ALTERNATIVE_REGIME_VIEWS_MUST_NOT_BE_SUMMED",
    message: "Entry-regime and exit-regime attribution are alternative attribution views and must not be summed. Their evidence sets are not always identical because opening inventory is exit-attributable but left-censored from entry attribution.",
  }]);
});

test("regime analysis reports turnover, win rate, profit factor, and stable zero-regime metrics", () => {
  const scenario = createCompletedScenario();
  const result = analyzeScenario(scenario);
  const bull = result.regimes.BULL_TREND;
  const range = result.regimes.RANGE;

  assert.equal(bull.turnoverKrw.status, "KNOWN");
  assert.equal(bull.entryAttribution.episodeWinRate.status, "KNOWN");
  assert.equal(bull.entryAttribution.profitFactor.status, "NOT_APPLICABLE");
  assert.equal(range.frameCount, 0);
  assert.equal(range.turnoverKrw.status, "KNOWN");
  assert.equal(range.entryAttribution.grossRealizedPnlKrw.status, "KNOWN");
  assert.equal(range.entryAttribution.episodeWinRate.status, "NOT_APPLICABLE");
});

test("regime analysis preserves missing fee evidence as unknown", () => {
  const scenario = createCompletedScenario();
  const fills = scenario.fills.map((fill) => ({ ...fill, feeKrw: null }));
  const matchResult = matchPerformanceTrades({
    fills,
    openingPositions: [{ market: "KRW-BTC", quantity: 0.1, averagePriceKrw: 90_000 }],
  });
  const result = analyzePerformanceRegimes({
    asset: "BTC",
    market: "KRW-BTC",
    scenario: "BASELINE",
    frames: scenario.legacyBacktest.result.frames,
    fills,
    matchResult,
    breakevenToleranceKrw: 0,
  });

  assert.equal(result.regimes.BULL_TREND.entryAttribution.grossRealizedPnlKrw.status, "KNOWN");
  assert.deepEqual(result.regimes.BULL_TREND.entryAttribution.netRealizedPnlKrw, {
    status: "UNKNOWN",
    reasons: ["MISSING_FILL_FEE"],
  });
  assert.equal(result.regimes.BULL_TREND.feeCompleteness, "INCOMPLETE");
});

test("regime analysis preserves missing cost evidence as unknown", () => {
  const scenario = createCompletedScenario();
  const selectedIndex = scenario.matchResult.realizationSlices.findIndex(
    (slice) => slice.source === "SELECTED_STREAM",
  );
  assert.notEqual(selectedIndex, -1);
  const selectedEpisodeId = scenario.matchResult.realizationSlices[selectedIndex]?.episodeId;
  assert.ok(selectedEpisodeId);
  const matchResult = {
    ...scenario.matchResult,
    episodes: scenario.matchResult.episodes.map((episode) => episode.id === selectedEpisodeId
      ? { ...episode, grossRealizedPnlKrw: null, netRealizedPnlKrw: null }
      : episode),
    realizationSlices: scenario.matchResult.realizationSlices.map((slice, index) =>
      index === selectedIndex
        ? { ...slice, grossPnlBeforeFeesKrw: null, netRealizedPnlKrw: null }
        : slice),
  };
  const result = analyzePerformanceRegimes({
    asset: "BTC",
    market: "KRW-BTC",
    scenario: "BASELINE",
    frames: scenario.legacyBacktest.result.frames,
    fills: scenario.fills,
    matchResult,
    breakevenToleranceKrw: 0,
  });

  assert.equal(result.regimes.BULL_TREND.costCompleteness, "INCOMPLETE");
  assert.deepEqual(result.regimes.BULL_TREND.entryAttribution.grossRealizedPnlKrw, {
    status: "UNKNOWN",
    reasons: ["MISSING_FIFO_COST"],
  });
});

test("regime fill mapping requires the exact source-frame instant without look-ahead", () => {
  const scenario = createCompletedScenario();
  const fills = scenario.fills.map((fill, index) => index === 0
    ? { ...fill, filledAt: "2026-04-20T01:00:00.000000001Z" }
    : fill);
  const matchResult = matchPerformanceTrades({
    fills,
    openingPositions: [{ market: "KRW-BTC", quantity: 0.1, averagePriceKrw: 90_000 }],
  });

  assert.throws(
    () => analyzePerformanceRegimes({
      asset: "BTC",
      market: "KRW-BTC",
      scenario: "BASELINE",
      frames: scenario.legacyBacktest.result.frames,
      fills,
      matchResult,
      breakevenToleranceKrw: 0,
    }),
    /exact source frame/,
  );
});

test("regime fill mapping accepts equivalent-offset timestamps at the exact same instant", () => {
  const scenario = createCompletedScenario();
  const fills = scenario.fills.map((fill, index) => index === 0
    ? { ...fill, filledAt: "2026-04-20T10:00:00.000+09:00" }
    : fill);
  const result = analyzePerformanceRegimes({
    asset: "BTC",
    market: "KRW-BTC",
    scenario: "BASELINE",
    frames: scenario.legacyBacktest.result.frames,
    fills,
    matchResult: matchPerformanceTrades({
      fills,
      openingPositions: [{ market: "KRW-BTC", quantity: 0.1, averagePriceKrw: 90_000 }],
    }),
    breakevenToleranceKrw: 0,
  });

  assert.equal(result.regimes.BULL_TREND.fillCount, 1);
  assert.equal(result.regimes.BULL_TREND.entryAttribution.realizationSliceCount, 2);
});

test("regime sample support names episode and slice units for multi-entry partial exits", () => {
  const input = createMultiEpisodeInput([
    fill("entry-a", "ENTER", "bid", 100, 1, "2026-04-20T01:00:00.000Z"),
    fill("add-a", "ADD", "bid", 105, 1, "2026-04-20T02:00:00.000Z"),
    fill("reduce-a", "REDUCE", "ask", 110, 1, "2026-04-20T03:00:00.000Z"),
    fill("exit-a", "EXIT", "ask", 120, 1, "2026-04-20T04:00:00.000Z"),
  ]);
  const range = analyzePerformanceRegimes(input).regimes.RANGE;

  assert.equal(range.entryAttribution.completedEpisodeCount, 1);
  assert.equal(range.entryAttribution.realizationSliceCount, 2);
  assert.equal(range.entryAttribution.episodeSampleSupport.observedCount, 1);
  assert.equal(range.entryAttribution.episodeSampleSupport.unit, "COMPLETED_EPISODES");
  assert.equal(range.entryAttribution.realizationSliceSampleSupport.observedCount, 2);
  assert.equal(range.entryAttribution.realizationSliceSampleSupport.unit, "REALIZATION_SLICES");
});

test("regime analysis rejects cross-episode slice and fill lifecycle corruption", () => {
  const input = createMultiEpisodeInput([
    fill("entry-a", "ENTER", "bid", 100, 1, "2026-04-20T01:00:00.000Z"),
    fill("exit-a", "EXIT", "ask", 110, 1, "2026-04-20T02:00:00.000Z"),
    fill("entry-b", "ENTER", "bid", 120, 1, "2026-04-20T03:00:00.000Z"),
    fill("exit-b", "EXIT", "ask", 130, 1, "2026-04-20T04:00:00.000Z"),
  ]);
  const [firstEpisode, secondEpisode] = input.matchResult.episodes;
  const [firstSlice, secondSlice] = input.matchResult.realizationSlices;
  assert.ok(firstEpisode && secondEpisode && firstSlice && secondSlice);

  assert.throws(
    () => analyzePerformanceRegimes({
      ...input,
      matchResult: {
        ...input.matchResult,
        realizationSlices: [{ ...firstSlice, episodeId: secondEpisode.id }, secondSlice],
      },
    }),
    /cross-episode|bidirectional lifecycle/,
  );
  assert.throws(
    () => analyzePerformanceRegimes({
      ...input,
      matchResult: {
        ...input.matchResult,
        episodes: [{ ...firstEpisode, realizationSliceIds: [secondSlice.id] }, secondEpisode],
      },
    }),
    /cross-episode|bidirectional lifecycle/,
  );
  assert.throws(
    () => analyzePerformanceRegimes({
      ...input,
      matchResult: {
        ...input.matchResult,
        episodes: [{ ...firstEpisode, entryFillIds: [secondEpisode.entryFillIds[0]!] }, secondEpisode],
      },
    }),
    /entry fill|cross-episode/,
  );
  assert.throws(
    () => analyzePerformanceRegimes({
      ...input,
      matchResult: {
        ...input.matchResult,
        episodes: [{ ...firstEpisode, closedAt: secondEpisode.closedAt }, secondEpisode],
      },
    }),
    /terminal exit fill/,
  );
});

test("regime analysis reconciles every episode PnL and fee aggregate with linked slices", () => {
  const input = createMultiEpisodeInput([
    fill("entry-a", "ENTER", "bid", 100, 1, "2026-04-20T01:00:00.000Z"),
    fill("exit-a", "EXIT", "ask", 110, 1, "2026-04-20T02:00:00.000Z"),
    fill("entry-b", "ENTER", "bid", 120, 1, "2026-04-20T03:00:00.000Z"),
    fill("exit-b", "EXIT", "ask", 130, 1, "2026-04-20T04:00:00.000Z"),
  ]);
  const [firstEpisode] = input.matchResult.episodes;
  assert.ok(firstEpisode);

  assert.throws(
    () => analyzePerformanceRegimes({
      ...input,
      matchResult: {
        ...input.matchResult,
        episodes: input.matchResult.episodes.map((episode) => episode.id === firstEpisode.id
          ? {
            ...episode,
            grossRealizedPnlKrw: (episode.grossRealizedPnlKrw ?? 0)
              + PERFORMANCE_REGIME_EPISODE_RECONCILIATION_TOLERANCE_KRW * 2,
          }
          : episode),
      },
    }),
    /grossRealizedPnlKrw.*linked realization slices/,
  );
  assert.throws(
    () => analyzePerformanceRegimes({
      ...input,
      matchResult: {
        ...input.matchResult,
        episodes: input.matchResult.episodes.map((episode) => episode.id === firstEpisode.id
          ? { ...episode, realizedFeeImpactKrw: null }
          : episode),
      },
    }),
    /realizedFeeImpactKrw.*linked realization slices/,
  );
  assert.throws(
    () => analyzePerformanceRegimes({
      ...input,
      matchResult: {
        ...input.matchResult,
        episodes: input.matchResult.episodes.map((episode) => episode.id === firstEpisode.id
          ? {
            ...episode,
            netRealizedPnlKrw: (episode.netRealizedPnlKrw ?? 0)
              - PERFORMANCE_REGIME_EPISODE_RECONCILIATION_TOLERANCE_KRW * 2,
          }
          : episode),
      },
    }),
    /netRealizedPnlKrw.*linked realization slices/,
  );

  const incompleteSlices = input.matchResult.realizationSlices.map((slice) =>
    slice.episodeId === firstEpisode.id
      ? { ...slice, allocatedBuyFeeKrw: null, netRealizedPnlKrw: null }
      : slice);
  assert.throws(
    () => analyzePerformanceRegimes({
      ...input,
      matchResult: { ...input.matchResult, realizationSlices: incompleteSlices },
    }),
    /realizedFeeImpactKrw.*linked realization slices/,
  );

  assert.doesNotThrow(() => analyzePerformanceRegimes({
    ...input,
    matchResult: {
      ...input.matchResult,
      episodes: input.matchResult.episodes.map((episode) => episode.id === firstEpisode.id
        ? {
          ...episode,
          grossRealizedPnlKrw: (episode.grossRealizedPnlKrw ?? 0)
            + PERFORMANCE_REGIME_EPISODE_RECONCILIATION_TOLERANCE_KRW / 2,
          realizedFeeImpactKrw: (episode.realizedFeeImpactKrw ?? 0)
            + PERFORMANCE_REGIME_EPISODE_RECONCILIATION_TOLERANCE_KRW / 2,
          netRealizedPnlKrw: (episode.netRealizedPnlKrw ?? 0)
            + PERFORMANCE_REGIME_EPISODE_RECONCILIATION_TOLERANCE_KRW / 2,
        }
        : episode),
    },
  }));
});

test("regime analysis requires executed decision and trade actions to agree", () => {
  const input = createMultiEpisodeInput([
    fill("entry-a", "ENTER", "bid", 100, 1, "2026-04-20T01:00:00.000Z"),
    fill("exit-a", "EXIT", "ask", 110, 1, "2026-04-20T02:00:00.000Z"),
  ]);

  for (const contradictoryAction of ["HOLD", "ADD"] as const) {
    const contradictoryFrames = input.frames.map((frame, index) => index === 0
      ? { ...frame, decision: { ...frame.decision, action: contradictoryAction } }
      : frame);
    assert.throws(
      () => analyzePerformanceRegimes({ ...input, frames: contradictoryFrames }),
      /decision\.action.*trade\.action/,
    );
  }
});

test("regime analysis rejects non-finite derived turnover, PnL sums, and ratios", () => {
  const input = createMultiEpisodeInput([
    fill("entry-a", "ENTER", "bid", 100, 1, "2026-04-20T01:00:00.000Z"),
    fill("exit-a", "EXIT", "ask", 110, 1, "2026-04-20T02:00:00.000Z"),
    fill("entry-b", "ENTER", "bid", 120, 1, "2026-04-20T03:00:00.000Z"),
    fill("exit-b", "EXIT", "ask", 130, 1, "2026-04-20T04:00:00.000Z"),
  ]);
  const hugeFills = input.fills.map((item) => ({ ...item, priceKrw: Number.MAX_VALUE }));
  const hugeFrames = input.frames.map((frame) => ({
    ...frame,
    trade: frame.trade && {
      ...frame.trade,
      price: Number.MAX_VALUE,
      grossNotionalKrw: Number.MAX_VALUE,
    },
  }));
  const hugeFillById = new Map(hugeFills.map((item) => [item.id, item]));
  const hugeMatch = {
    ...input.matchResult,
    realizationSlices: input.matchResult.realizationSlices.map((slice) => ({
      ...slice,
      entry: slice.entry.fillId === null ? slice.entry : {
        ...slice.entry,
        priceKrw: hugeFillById.get(slice.entry.fillId)?.priceKrw ?? null,
      },
      exit: slice.exit.fillId === null ? slice.exit : {
        ...slice.exit,
        priceKrw: hugeFillById.get(slice.exit.fillId)?.priceKrw ?? null,
      },
    })),
  };
  assert.throws(
    () => analyzePerformanceRegimes({
      ...input,
      frames: hugeFrames,
      fills: hugeFills,
      matchResult: hugeMatch,
    }),
    /turnoverKrw.*finite/,
  );

  const overflowingSlices = input.matchResult.realizationSlices.map((slice) => ({
    ...slice,
    grossPnlBeforeFeesKrw: Number.MAX_VALUE,
    netRealizedPnlKrw: Number.MAX_VALUE,
  }));
  const overflowingEpisodes = input.matchResult.episodes.map((episode) => ({
    ...episode,
    grossRealizedPnlKrw: Number.MAX_VALUE,
    netRealizedPnlKrw: Number.MAX_VALUE,
  }));
  assert.throws(
    () => analyzePerformanceRegimes({
      ...input,
      matchResult: {
        ...input.matchResult,
        episodes: overflowingEpisodes,
        realizationSlices: overflowingSlices,
      },
    }),
    /grossRealizedPnlKrw.*finite/,
  );

  const [winningEpisode, losingEpisode] = input.matchResult.episodes;
  assert.ok(winningEpisode && losingEpisode);
  const ratioSlices = input.matchResult.realizationSlices.map((slice) => slice.episodeId === winningEpisode.id
    ? { ...slice, netRealizedPnlKrw: 1 }
    : slice.episodeId === losingEpisode.id
      ? { ...slice, netRealizedPnlKrw: -Number.MIN_VALUE }
      : slice);
  assert.throws(
    () => analyzePerformanceRegimes({
      ...input,
      matchResult: {
        ...input.matchResult,
        realizationSlices: ratioSlices,
        episodes: [
          { ...winningEpisode, netRealizedPnlKrw: 1 },
          { ...losingEpisode, netRealizedPnlKrw: -Number.MIN_VALUE },
        ],
      },
    }),
    /profitFactor.*finite/,
  );
});

test("regime analysis rejects corrupt timestamps, values, market mismatches, and lifecycle links", () => {
  const scenario = createCompletedScenario();
  const base = {
    asset: "BTC" as const,
    market: "KRW-BTC" as const,
    scenario: "BASELINE" as const,
    frames: scenario.legacyBacktest.result.frames,
    fills: scenario.fills,
    matchResult: scenario.matchResult,
    breakevenToleranceKrw: 0,
  };

  const corruptFrames = base.frames.map((frame, index) => index === 0
    ? { ...frame, generatedAt: "2026-04-20T01:00:00" }
    : frame);
  assert.throws(() => analyzePerformanceRegimes({ ...base, frames: corruptFrames }), /generatedAt/);
  assert.throws(
    () => analyzePerformanceRegimes({
      ...base,
      fills: base.fills.map((fill, index) => index === 0
        ? { ...fill, market: "KRW-ETH" as const }
        : fill),
    }),
    /market/,
  );
  assert.throws(
    () => analyzePerformanceRegimes({
      ...base,
      fills: base.fills.map((fill, index) => index === 0
        ? { ...fill, priceKrw: Number.POSITIVE_INFINITY }
        : fill),
    }),
    /priceKrw/,
  );
  assert.throws(
    () => analyzePerformanceRegimes({ ...base, breakevenToleranceKrw: -1 }),
    /breakevenToleranceKrw/,
  );

  const [firstSlice, ...remainingSlices] = base.matchResult.realizationSlices;
  assert.ok(firstSlice);
  const brokenMatch = {
    ...base.matchResult,
    realizationSlices: [{
      ...firstSlice,
      exit: { ...firstSlice.exit, fillId: "missing-fill" },
    }, ...remainingSlices],
  };
  assert.throws(
    () => analyzePerformanceRegimes({ ...base, matchResult: brokenMatch }),
    /lifecycle fill missing-fill/,
  );

  const openingSlice = base.matchResult.realizationSlices.find((slice) => slice.source === "OPENING");
  assert.ok(openingSlice);
  assert.throws(
    () => analyzePerformanceRegimes({
      ...base,
      matchResult: {
        ...base.matchResult,
        realizationSlices: base.matchResult.realizationSlices.map((slice) =>
          slice.id === openingSlice.id
            ? {
              ...slice,
              exit: {
                fillId: null,
                orderId: null,
                strategyDecisionId: null,
                decisionAction: null,
                occurredAt: null,
                priceKrw: null,
              },
            }
            : slice),
      },
    }),
    /exit fill evidence/,
  );
});

function analyzeScenario(scenario: CounterfactualScenarioResult) {
  return analyzePerformanceRegimes({
    asset: "BTC",
    market: "KRW-BTC",
    scenario: "BASELINE",
    frames: scenario.legacyBacktest.result.frames,
    fills: scenario.fills,
    matchResult: scenario.matchResult,
    breakevenToleranceKrw: 0,
  });
}

function createCompletedScenario(): CounterfactualScenarioResult {
  const [scenario] = runCounterfactualScenarios({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 991_000,
    initialQuantity: 0.1,
    initialAverageEntryPrice: 90_000,
    frames: [
      createFrame("2026-04-20T01:00:00.000Z", {
        regime: "BULL_TREND",
        currentPrice: 100_000,
        entryPath: "RECLAIM",
        reclaimStructure: true,
        trendAlignmentScore: 4,
        recoveryQualityScore: 4,
        volumeRecovery: true,
        macdImproving: true,
        rsiRecovery: true,
      }),
      createFrame("2026-04-20T02:00:00.000Z", {
        regime: "WEAK_DOWNTREND",
        currentPrice: 120_000,
        weakeningStage: "CLEAR",
        failedReclaim: true,
        bearishMomentumExpansion: true,
      }),
      createFrame("2026-04-20T03:00:00.000Z", {
        regime: "BREAKDOWN_RISK",
        currentPrice: 110_000,
        invalidationState: "BROKEN",
        breakdown1d: true,
        breakdown4h: true,
        bearishMomentumExpansion: true,
      }),
    ],
    scenarios: ["BASELINE"],
    diagnosticPolicy: { breakevenToleranceKrw: 0 },
  });
  assert.ok(scenario);
  return scenario;
}

function createMultiEpisodeInput(fills: readonly PerformanceTradeFill[]) {
  const template = createCompletedScenario().legacyBacktest.result.frames[0]!;
  const frames: PositionGuardBacktestFrameResult[] = fills.map((item) => ({
    ...template,
    generatedAt: item.filledAt,
    regime: "RANGE",
    decision: {
      ...template.decision,
      action: item.decisionAction ?? "HOLD",
      diagnostics: { ...template.decision.diagnostics, regime: "RANGE" },
    },
    executed: true,
    trade: {
      action: item.decisionAction as "ENTER" | "ADD" | "REDUCE" | "EXIT",
      side: item.side,
      price: item.priceKrw,
      quantity: item.volume,
      grossNotionalKrw: item.priceKrw * item.volume,
      feeKrw: item.feeKrw ?? 0,
      realizedPnlKrw: 0,
    },
    skipReason: null,
  }));
  return {
    asset: "BTC" as const,
    market: "KRW-BTC" as const,
    scenario: "BASELINE" as const,
    frames,
    fills,
    matchResult: matchPerformanceTrades({ fills }),
    breakevenToleranceKrw: 0,
  };
}

function fill(
  id: string,
  action: "ENTER" | "ADD" | "REDUCE" | "EXIT",
  side: "bid" | "ask",
  priceKrw: number,
  volume: number,
  filledAt: string,
): PerformanceTradeFill {
  return {
    id,
    orderId: `${id}-order`,
    strategyDecisionId: `${id}-decision`,
    decisionAction: action,
    market: "KRW-BTC",
    side,
    priceKrw,
    volume,
    feeKrw: 0,
    filledAt,
  };
}

function createFrame(
  generatedAt: string,
  overrides: Partial<PositionGuardStructureAnalysis>,
): PositionGuardBacktestFrame {
  return {
    generatedAt,
    analysis: {
      regime: "RANGE",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: 95_000,
      pullbackZone: false,
      reclaimStructure: false,
      breakoutHoldStructure: false,
      upperRangeChase: false,
      currentPrice: 100_000,
      entryPath: "NONE",
      trendAlignmentScore: 0,
      recoveryQualityScore: 0,
      breakdownPressureScore: 0,
      weakeningStage: "NONE",
      breakdown1d: false,
      breakdown4h: false,
      failedReclaim: false,
      bearishMomentumExpansion: false,
      volumeRecovery: false,
      macdImproving: false,
      rsiRecovery: false,
      atrShock: false,
      averageEntryPrice: 90_000,
      pnlPct: 0,
      ...overrides,
    },
  };
}
