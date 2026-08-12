import assert from "node:assert/strict";

import {
  analyzeAddDecisionExposures,
  type AddDecisionDiagnosticsPath,
} from "../src/modules/performance/performance-add-diagnostics.js";
import type {
  PositionGuardBacktestFrame,
  PositionGuardBacktestFrameResult,
} from "../src/modules/strategy/position-guard-backtest.js";
import type { PositionGuardStructureAnalysis } from "../src/modules/strategy/position-guard-core.js";
import type {
  FifoRealizationSlice,
  PerformanceTradeFill,
  PerformanceTradeMatchResult,
  PositionEpisode,
} from "../src/modules/performance/performance-trade-matcher.js";
import { PERFORMANCE_QUANTITY_TOLERANCE } from "../src/modules/performance/performance-trade-matcher.js";
import { test } from "./harness.js";

test("ADD diagnostics identifies suppressed decisions and preserves pairing and regime evidence", () => {
  const first = "2026-04-20T10:00:00.000000100+09:00";
  const second = "2026-04-20T01:00:00.000000200Z";
  const third = "2026-04-20T02:00:00.000000000Z";
  const fourth = "2026-04-20T03:00:00.000000000Z";
  const episode = completedEpisode("episode-1", ["fill-1", "fill-2"], 125);
  const baseline = path("BASELINE", [
    resultFrame(first, "ADD", true, "BULL_TREND"),
    resultFrame(second, "ADD", true, "PULLBACK_IN_UPTREND"),
    resultFrame(third, "ADD", false, "RANGE"),
    resultFrame(fourth, "HOLD", false, "WEAK_DOWNTREND"),
  ], [
    sourceFrame(first, "BULL_TREND", true),
    sourceFrame(second, "PULLBACK_IN_UPTREND", false),
    sourceFrame(third, "RANGE", true),
    sourceFrame(fourth, "WEAK_DOWNTREND", false),
  ], [
    fill("fill-1", first),
    fill("fill-2", second),
  ], [episode]);
  const noAdd = path("NO_ADD", [
    suppressedFrame(first, "BULL_TREND"),
    suppressedFrame(second, "PULLBACK_IN_UPTREND"),
    suppressedFrame(third, "RANGE"),
    suppressedFrame(fourth, "WEAK_DOWNTREND"),
  ], [
    sourceFrame(first, "BULL_TREND", true),
    sourceFrame(second, "PULLBACK_IN_UPTREND", false),
    sourceFrame(third, "RANGE", true),
    sourceFrame(fourth, "WEAK_DOWNTREND", false),
  ], [], []);

  const result = analyzeAddDecisionExposures({
    asset: "BTC",
    market: "KRW-BTC",
    baseline,
    noAdd,
    breakevenToleranceKrw: 0,
  });

  assert.equal(result.causalClaim, false);
  assert.deepEqual(
    result.exposures.map((exposure) => exposure.pairingStatus),
    [
      "EXECUTED_VS_SUPPRESSED",
      "EXECUTED_VS_SUPPRESSED",
      "BASELINE_NOT_EXECUTED",
      "PATH_DECISION_DIVERGED",
    ],
  );
  assert.deepEqual(result.exposures.map((exposure) => ({
    regime: exposure.originalEvidence.regime,
    atrShock: exposure.originalEvidence.atrShock,
  })), [
    { regime: "BULL_TREND", atrShock: true },
    { regime: "PULLBACK_IN_UPTREND", atrShock: false },
    { regime: "RANGE", atrShock: true },
    { regime: "WEAK_DOWNTREND", atrShock: false },
  ]);
  assert.equal(result.aggregate.exposureCount, 4);
  assert.equal(result.aggregate.distinctCompletedEpisodeCount, 1);
  assert.deepEqual(result.aggregate.completedEpisodeOutcomes, {
    wins: 1,
    losses: 0,
    breakeven: 0,
    unknown: 0,
  });
  assert.equal(result.exposures[0]?.baselineEpisode?.episodeId, "episode-1");
  assert.equal(result.exposures[1]?.baselineEpisode?.episodeId, "episode-1");
  assert.deepEqual(result.exposures[0]?.postDecisionExcursion, {
    status: "UNKNOWN",
    reason: "SEE_POST_DECISION_EXCURSION_ANALYSIS",
  });
  assert.equal(result.exposures[0]?.costAndFeeImpact.status, "UNKNOWN");
  assert.ok(result.warnings.some((warning) => warning.code === "CAUSAL_INFERENCE_NOT_SUPPORTED"));
  assert.equal(result.warnings.some((warning) => warning.code === "POST_DECISION_EXCURSION_NOT_IMPLEMENTED"), false);
  assert.equal(result.warnings.some((warning) => warning.code === "COST_FEE_ATTRIBUTION_NOT_IMPLEMENTED"), false);
  assert.ok(result.warnings.some((warning) =>
    warning.code === "COST_FEE_ATTRIBUTION_INCOMPLETE"
    && warning.evidenceIds.includes("fill-1")));
});

test("ADD diagnostics pairs equal epochs across timezone spellings and reports missing net episode PnL", () => {
  const noAddAt = "2026-04-20T10:00:00.000000100+09:00";
  const baselineAt = "2026-04-20T01:00:00.000000100Z";
  const episode = completedEpisode("episode-unknown", ["fill-1"], null);
  const baseline = path(
    "BASELINE",
    [resultFrame(baselineAt, "ADD", true, "BULL_TREND")],
    [sourceFrame(baselineAt, "BULL_TREND", false)],
    [fill("fill-1", baselineAt)],
    [episode],
  );
  const noAdd = path(
    "NO_ADD",
    [suppressedFrame(noAddAt, "BULL_TREND")],
    [sourceFrame(noAddAt, "BULL_TREND", false)],
    [],
    [],
  );

  const result = analyzeAddDecisionExposures({
    asset: "BTC",
    market: "KRW-BTC",
    baseline,
    noAdd,
    breakevenToleranceKrw: 0,
  });

  assert.equal(result.exposures[0]?.pairingStatus, "EXECUTED_VS_SUPPRESSED");
  assert.equal(result.exposures[0]?.baselineGeneratedAt, baselineAt);
  assert.deepEqual(result.aggregate.completedEpisodeOutcomes, {
    wins: 0,
    losses: 0,
    breakeven: 0,
    unknown: 1,
  });
  assert.ok(result.warnings.some((warning) =>
    warning.code === "COMPLETED_EPISODE_NET_PNL_UNKNOWN"
    && warning.evidenceIds.includes("episode-unknown")));
});

test("ADD diagnostics rejects same-epoch fills that do not exactly evidence the executed ADD trade", () => {
  const at = "2026-04-20T01:00:00.000000100Z";
  const baselineFrame = resultFrame(at, "ADD", true, "BULL_TREND");
  const baselineFill = fill("fill-1", at);
  const episode = completedEpisode("episode-1", [baselineFill.id], 10);
  const noAdd = path(
    "NO_ADD",
    [suppressedFrame(at, "BULL_TREND")],
    [sourceFrame(at, "BULL_TREND", false)],
    [],
    [],
  );
  const analyze = (candidate: PerformanceTradeFill) => analyzeAddDecisionExposures({
    asset: "BTC",
    market: "KRW-BTC",
    baseline: path(
      "BASELINE",
      [baselineFrame],
      [sourceFrame(at, "BULL_TREND", false)],
      [candidate],
      [episode],
    ),
    noAdd,
    breakevenToleranceKrw: 0,
  });

  assert.throws(
    () => analyze({ ...baselineFill, side: "ask" }),
    /does not match executed BASELINE ADD trade/,
  );
  assert.throws(
    () => analyze({ ...baselineFill, priceKrw: baselineFill.priceKrw + 1 }),
    /does not match executed BASELINE ADD trade/,
  );
  assert.throws(
    () => analyze({
      ...baselineFill,
      volume: baselineFill.volume + PERFORMANCE_QUANTITY_TOLERANCE * 2,
    }),
    /does not match executed BASELINE ADD trade/,
  );
  assert.throws(
    () => analyze({ ...baselineFill, decisionAction: "ENTER" }),
    /does not match executed BASELINE ADD trade/,
  );
});

test("ADD diagnostics attributes only FIFO slices entered by the executed ADD fill", () => {
  const at = "2026-04-20T01:00:00.000000100Z";
  const addFill = fill("fill-add", at);
  const otherFill = fill("fill-other", "2026-04-20T00:00:00.000000100Z");
  const episode = {
    ...completedEpisode("episode-1", [otherFill.id, addFill.id], 1_180),
    realizationSliceIds: ["slice-other", "slice-add-1", "slice-add-2"],
  } satisfies PositionEpisode;
  const slices = [
    realizationSlice("slice-other", otherFill.id, 0.1, 1_000, 5, 5, 990, otherFill.filledAt),
    realizationSlice("slice-add-1", addFill.id, 0.04, 400, 2, 2, 396),
    realizationSlice("slice-add-2", addFill.id, 0.03, -200, 1.5, 1.5, -203),
  ];

  const result = analyzeAddDecisionExposures({
    asset: "BTC",
    market: "KRW-BTC",
    baseline: path(
      "BASELINE",
      [resultFrame(at, "ADD", true, "BULL_TREND")],
      [sourceFrame(at, "BULL_TREND", false)],
      [otherFill, addFill],
      [episode],
      slices,
    ),
    noAdd: path(
      "NO_ADD",
      [suppressedFrame(at, "BULL_TREND")],
      [sourceFrame(at, "BULL_TREND", false)],
      [],
      [],
    ),
    breakevenToleranceKrw: 0,
  });

  assert.deepEqual(result.exposures[0]?.costAndFeeImpact, {
    status: "AVAILABLE",
    completeness: "COMPLETE",
    reason: null,
    entryNotionalKrw: 10_000,
    entryFeeKrw: 5,
    realizedQuantity: 0.07,
    remainingQuantity: 0.03,
    realizedGrossPnlBeforeFeesKrw: 200,
    allocatedEntryFeeKrw: 3.5,
    allocatedExitFeeKrw: 3.5,
    realizedFeeImpactKrw: 7,
    realizedNetPnlKrw: 193,
    realizationSliceIds: ["slice-add-1", "slice-add-2"],
  });
});

test("ADD diagnostics keeps net FIFO contribution unknown when any allocated fee is missing", () => {
  const at = "2026-04-20T01:00:00.000000100Z";
  const addFill = { ...fill("fill-add", at), feeKrw: null };
  const episode = {
    ...completedEpisode("episode-1", [addFill.id], null),
    realizationSliceIds: ["slice-add"],
  } satisfies PositionEpisode;
  const incompleteSlice = realizationSlice("slice-add", addFill.id, 0.1, 500, null, 5, null);

  const result = analyzeAddDecisionExposures({
    asset: "BTC",
    market: "KRW-BTC",
    baseline: path(
      "BASELINE",
      [resultFrame(at, "ADD", true, "BULL_TREND")],
      [sourceFrame(at, "BULL_TREND", false)],
      [addFill],
      [episode],
      [incompleteSlice],
    ),
    noAdd: path(
      "NO_ADD",
      [suppressedFrame(at, "BULL_TREND")],
      [sourceFrame(at, "BULL_TREND", false)],
      [],
      [],
    ),
    breakevenToleranceKrw: 0,
  });

  const impact = result.exposures[0]?.costAndFeeImpact;
  assert.equal(impact?.status, "UNKNOWN");
  assert.equal(impact?.completeness, "FEE_EVIDENCE_INCOMPLETE");
  assert.equal(impact?.entryFeeKrw, null);
  assert.equal(impact?.realizedGrossPnlBeforeFeesKrw, 500);
  assert.equal(impact?.allocatedEntryFeeKrw, null);
  assert.equal(impact?.realizedFeeImpactKrw, null);
  assert.equal(impact?.realizedNetPnlKrw, null);
  assert.ok(result.warnings.some((warning) =>
    warning.code === "COST_FEE_ATTRIBUTION_INCOMPLETE"
    && warning.evidenceIds.includes(addFill.id)));
});

test("ADD diagnostics rejects selected slice entry evidence that contradicts its referenced bid fill", () => {
  const input = lifecycleEvidenceInput();
  const slice = input.baseline.matchResult.realizationSlices[0]!;
  for (const entry of [
    { ...slice.entry, orderId: "wrong-order" },
    { ...slice.entry, strategyDecisionId: "wrong-decision" },
    { ...slice.entry, decisionAction: "ENTER" as const },
    { ...slice.entry, occurredAt: "2026-04-20T01:00:00.000000101Z" },
    { ...slice.entry, priceKrw: 100_001 },
  ]) {
    assert.throws(
      () => analyzeAddDecisionExposures({
        ...input,
        baseline: {
          ...input.baseline,
          matchResult: {
            ...input.baseline.matchResult,
            realizationSlices: [{ ...slice, entry }],
          },
        },
      }),
      /entry evidence does not match referenced bid fill/,
    );
  }
});

test("ADD diagnostics rejects selected slice exit evidence outside its completed ask lifecycle", () => {
  const input = lifecycleEvidenceInput();
  const slice = input.baseline.matchResult.realizationSlices[0]!;
  const episode = input.baseline.matchResult.episodes[0]!;
  const exit = input.baseline.fills.find((fill) => fill.id === "exit-fill")!;
  const otherExit = { ...exit, id: "other-exit", orderId: "other-exit-order" };

  assert.throws(
    () => analyzeAddDecisionExposures({
      ...input,
      baseline: { ...input.baseline, fills: input.baseline.fills.filter((fill) => fill.id !== exit.id) },
    }),
    /exit fill exit-fill does not exist in BASELINE fills/,
  );
  assert.throws(
    () => analyzeAddDecisionExposures({
      ...input,
      baseline: {
        ...input.baseline,
        fills: [...input.baseline.fills, otherExit],
        matchResult: {
          ...input.baseline.matchResult,
          episodes: [{ ...episode, exitFillIds: [otherExit.id] }],
        },
      },
    }),
    /cross-episode exit fill/,
  );
  assert.throws(
    () => analyzeAddDecisionExposures({
      ...input,
      baseline: {
        ...input.baseline,
        matchResult: {
          ...input.baseline.matchResult,
          realizationSlices: [{ ...slice, exit: { ...slice.exit, priceKrw: 105_001 } }],
        },
      },
    }),
    /exit evidence does not match referenced ask fill/,
  );
});

test("ADD diagnostics requires episode realization slice links to include every selected slice", () => {
  const input = lifecycleEvidenceInput();
  const episode = input.baseline.matchResult.episodes[0]!;

  assert.throws(
    () => analyzeAddDecisionExposures({
      ...input,
      baseline: {
        ...input.baseline,
        matchResult: {
          ...input.baseline.matchResult,
          episodes: [{ ...episode, realizationSliceIds: [...episode.realizationSliceIds, "unlinked-slice"] }],
        },
      },
    }),
    /corrupt bidirectional lifecycle slice links/,
  );
});

test("ADD diagnostics rejects contradictory known FIFO net contribution arithmetic", () => {
  const input = lifecycleEvidenceInput();
  const slice = input.baseline.matchResult.realizationSlices[0]!;

  assert.throws(
    () => analyzeAddDecisionExposures({
      ...input,
      baseline: {
        ...input.baseline,
        matchResult: {
          ...input.baseline.matchResult,
          realizationSlices: [{ ...slice, netRealizedPnlKrw: slice.netRealizedPnlKrw! + 0.01 }],
        },
      },
    }),
    /net PnL contradicts gross and allocated fees/,
  );
});

test("ADD diagnostics rejects allocated buy fees exceeding the known entry fill fee", () => {
  const input = lifecycleEvidenceInput();
  const slice = input.baseline.matchResult.realizationSlices[0]!;

  assert.throws(
    () => analyzeAddDecisionExposures({
      ...input,
      baseline: {
        ...input.baseline,
        matchResult: {
          ...input.baseline.matchResult,
          realizationSlices: [{
            ...slice,
            allocatedBuyFeeKrw: 6,
            netRealizedPnlKrw: slice.grossPnlBeforeFeesKrw! - 6 - slice.allocatedSellFeeKrw!,
          }],
        },
      },
    }),
    /allocated buy fees exceed known total fee/,
  );
});

test("ADD diagnostics validates episode identity market and actual baseline bid entry fills", () => {
  const at = "2026-04-20T01:00:00.000000100Z";
  const validFill = fill("fill-1", at);
  const noAdd = path(
    "NO_ADD",
    [suppressedFrame(at, "BULL_TREND")],
    [sourceFrame(at, "BULL_TREND", false)],
    [],
    [],
  );
  const analyze = (
    fills: readonly PerformanceTradeFill[],
    episodes: readonly PositionEpisode[],
  ) => analyzeAddDecisionExposures({
    asset: "BTC",
    market: "KRW-BTC",
    baseline: path(
      "BASELINE",
      [resultFrame(at, "ADD", true, "BULL_TREND")],
      [sourceFrame(at, "BULL_TREND", false)],
      fills,
      episodes,
    ),
    noAdd,
    breakevenToleranceKrw: 0,
  });

  assert.throws(
    () => analyze([validFill], [{
      ...completedEpisode("episode-1", [validFill.id], 10),
      market: "KRW-ETH",
    }]),
    /Episode episode-1 market does not match KRW-BTC/,
  );
  assert.throws(
    () => analyze([validFill], [
      completedEpisode("duplicate", [validFill.id], 10),
      completedEpisode("duplicate", [], 10),
    ]),
    /Duplicate episode id duplicate/,
  );
  assert.throws(
    () => analyze([validFill], [completedEpisode("episode-1", ["missing-fill"], 10)]),
    /entry fill missing-fill does not exist in BASELINE fills/,
  );
  assert.throws(
    () => analyze([
      validFill,
      { ...validFill, filledAt: "2026-04-20T02:00:00.000000100Z" },
    ], [completedEpisode("episode-1", [validFill.id], 10)]),
    /Duplicate BASELINE fill id fill-1/,
  );

  const askFill = {
    ...fill("ask-fill", "2026-04-20T02:00:00.000000100Z"),
    side: "ask" as const,
    decisionAction: "EXIT" as const,
  };
  assert.throws(
    () => analyze(
      [validFill, askFill],
      [completedEpisode("episode-1", [validFill.id, askFill.id], 10)],
    ),
    /entry fill ask-fill must reference a BASELINE bid fill/,
  );

  assert.throws(
    () => analyze([validFill], [
      completedEpisode("episode-1", [validFill.id], 10),
      completedEpisode("episode-2", [validFill.id], 20),
    ]),
    /Entry fill fill-1 belongs to multiple position episodes/,
  );
});

function path(
  scenario: AddDecisionDiagnosticsPath["scenario"],
  frames: readonly PositionGuardBacktestFrameResult[],
  sourceFrames: readonly PositionGuardBacktestFrame[],
  fills: readonly PerformanceTradeFill[],
  episodes: readonly PositionEpisode[],
  realizationSlices: readonly FifoRealizationSlice[] = [],
): AddDecisionDiagnosticsPath {
  return {
    scenario,
    frames,
    sourceFrames,
    fills: [
      ...fills,
      ...episodes
        .flatMap((episode) => episode.exitFillIds)
        .filter((exitFillId, index, allExitFillIds) =>
          !fills.some((fill) => fill.id === exitFillId)
          && allExitFillIds.indexOf(exitFillId) === index)
        .map((exitFillId) => defaultExitFill(exitFillId)),
    ],
    matchResult: {
      episodes,
      realizationSlices,
      unmatchedSells: [],
      attributionFailures: [],
    } satisfies PerformanceTradeMatchResult,
  };
}

function realizationSlice(
  id: string,
  entryFillId: string,
  quantity: number,
  grossPnlBeforeFeesKrw: number,
  allocatedBuyFeeKrw: number | null,
  allocatedSellFeeKrw: number | null,
  netRealizedPnlKrw: number | null,
  entryOccurredAt = "2026-04-20T01:00:00.000000100Z",
): FifoRealizationSlice {
  return {
    id,
    market: "KRW-BTC",
    source: "SELECTED_STREAM",
    episodeId: "episode-1",
    entry: {
      fillId: entryFillId,
      orderId: `${entryFillId}-order`,
      strategyDecisionId: `${entryFillId}-decision`,
      decisionAction: "ADD",
      occurredAt: entryOccurredAt,
      priceKrw: 100_000,
    },
    exit: {
      fillId: "exit-fill",
      orderId: "exit-order",
      strategyDecisionId: "exit-decision",
      decisionAction: "EXIT",
      occurredAt: "2026-04-20T04:00:00.000000000Z",
      priceKrw: 105_000,
    },
    quantity,
    grossPnlBeforeFeesKrw,
    allocatedBuyFeeKrw,
    allocatedSellFeeKrw,
    netRealizedPnlKrw,
    holdingDurationMs: 10_800_000,
  };
}

function sourceFrame(
  generatedAt: string,
  regime: PositionGuardStructureAnalysis["regime"],
  atrShock: boolean,
): PositionGuardBacktestFrame {
  return { generatedAt, analysis: analysis(regime, atrShock) };
}

function resultFrame(
  generatedAt: string,
  action: "ADD" | "HOLD",
  executed: boolean,
  regime: PositionGuardStructureAnalysis["regime"],
): PositionGuardBacktestFrameResult {
  return {
    generatedAt,
    regime,
    decision: {
      action,
      summary: action,
      reasons: [],
      targetNotionalKrw: action === "ADD" ? 10_000 : 0,
      targetQuantityFraction: null,
      referencePrice: 100_000,
      executionDisposition: "IMMEDIATE",
      signalQuality: {
        score: 4,
        bucket: "HIGH",
        confirmationRequired: false,
        confirmationSatisfied: true,
        reentryPenaltyApplied: false,
      },
      exposureGuardrails: {
        perAssetMaxAllocation: 0.5,
        totalPortfolioMaxExposure: 0.8,
        remainingAssetCapacity: 10_000,
        remainingPortfolioCapacity: 10_000,
      },
      diagnostics: {
        regime,
        riskLevel: "LOW",
        invalidationState: "CLEAR",
        invalidationLevel: 90_000,
        entryPath: "RECLAIM",
        trendAlignmentScore: 4,
        recoveryQualityScore: 4,
        breakdownPressureScore: 0,
        weakeningStage: "NONE",
        upperRangeChase: false,
        pullbackZone: false,
        reclaimStructure: true,
        breakoutHoldStructure: false,
      },
    },
    startingState: { cashKrw: 100_000, quantity: 1, averageEntryPrice: 90_000 },
    endingState: { cashKrw: executed ? 90_000 : 100_000, quantity: executed ? 1.1 : 1, averageEntryPrice: 90_909 },
    executed,
    trade: executed ? {
      action: "ADD",
      side: "bid",
      price: 100_000,
      quantity: 0.1,
      grossNotionalKrw: 10_000,
      feeKrw: 5,
      realizedPnlKrw: 0,
    } : null,
    skipReason: executed ? null : "BELOW_MINIMUM_TRADE_VALUE",
    equityKrw: 200_000,
    drawdownPct: 0,
  };
}

function suppressedFrame(
  generatedAt: string,
  regime: PositionGuardStructureAnalysis["regime"],
): PositionGuardBacktestFrameResult {
  return {
    ...resultFrame(generatedAt, "ADD", false, regime),
    skipReason: null,
    researchSuppression: {
      policyId: "NO_ADD",
      originalAction: "ADD",
      reason: "ACTION_SUPPRESSED",
    },
  };
}

function analysis(
  regime: PositionGuardStructureAnalysis["regime"],
  atrShock: boolean,
): PositionGuardStructureAnalysis {
  return {
    regime,
    riskLevel: "LOW",
    invalidationState: "CLEAR",
    invalidationLevel: 90_000,
    pullbackZone: false,
    reclaimStructure: true,
    breakoutHoldStructure: false,
    upperRangeChase: false,
    currentPrice: 100_000,
    entryPath: "RECLAIM",
    trendAlignmentScore: 4,
    recoveryQualityScore: 4,
    breakdownPressureScore: 0,
    weakeningStage: "NONE",
    breakdown1d: false,
    breakdown4h: false,
    failedReclaim: false,
    bearishMomentumExpansion: false,
    volumeRecovery: true,
    macdImproving: true,
    rsiRecovery: true,
    atrShock,
    averageEntryPrice: 90_000,
    pnlPct: 0.1,
  };
}

function fill(id: string, filledAt: string): PerformanceTradeFill {
  return {
    id,
    orderId: `${id}-order`,
    strategyDecisionId: `${id}-decision`,
    decisionAction: "ADD",
    market: "KRW-BTC",
    side: "bid",
    priceKrw: 100_000,
    volume: 0.1,
    feeKrw: 5,
    filledAt,
  };
}

function defaultExitFill(id: string): PerformanceTradeFill {
  return {
    id,
    orderId: "exit-order",
    strategyDecisionId: "exit-decision",
    decisionAction: "EXIT",
    market: "KRW-BTC",
    side: "ask",
    priceKrw: 105_000,
    volume: 0.1,
    feeKrw: 5,
    filledAt: "2026-04-20T04:00:00.000000000Z",
  };
}

function completedEpisode(
  id: string,
  entryFillIds: readonly string[],
  netRealizedPnlKrw: number | null,
): PositionEpisode {
  return {
    id,
    market: "KRW-BTC",
    status: "COMPLETED",
    openedAt: "2026-04-20T01:00:00.000000100Z",
    closedAt: "2026-04-20T04:00:00.000000000Z",
    entryFillIds,
    exitFillIds: ["exit-fill"],
    realizationSliceIds: [],
    remainingQuantity: 0,
    grossRealizedPnlKrw: netRealizedPnlKrw,
    realizedFeeImpactKrw: netRealizedPnlKrw === null ? null : 10,
    netRealizedPnlKrw,
    holdingDurationMs: 10_800_000,
  };
}

function lifecycleEvidenceInput() {
  const at = "2026-04-20T01:00:00.000000100Z";
  const entry = fill("fill-add", at);
  const exit = {
    ...fill("exit-fill", "2026-04-20T04:00:00.000000000Z"),
    orderId: "exit-order",
    strategyDecisionId: "exit-decision",
    decisionAction: "EXIT" as const,
    side: "ask" as const,
    priceKrw: 105_000,
  };
  const episode = {
    ...completedEpisode("episode-1", [entry.id], 488),
    realizationSliceIds: ["slice-add"],
  } satisfies PositionEpisode;
  const slice = realizationSlice("slice-add", entry.id, 0.1, 500, 5, 5, 490);

  return {
    asset: "BTC" as const,
    market: "KRW-BTC" as const,
    baseline: path(
      "BASELINE",
      [resultFrame(at, "ADD", true, "BULL_TREND")],
      [sourceFrame(at, "BULL_TREND", false)],
      [entry, exit],
      [episode],
      [slice],
    ),
    noAdd: path(
      "NO_ADD",
      [suppressedFrame(at, "BULL_TREND")],
      [sourceFrame(at, "BULL_TREND", false)],
      [],
      [],
    ),
    breakevenToleranceKrw: 0,
  };
}
