import assert from "node:assert/strict";

import {
  DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
  type PositionGuardStructureAnalysis,
} from "../src/modules/strategy/position-guard-core.js";
import {
  runPositionGuardBacktest,
  type PositionGuardBacktestFrame,
  type PositionGuardBacktestResearchExecutionPolicy,
} from "../src/modules/strategy/position-guard-backtest.js";
import { test } from "./harness.js";

const publicResearchPolicyContract: readonly PositionGuardBacktestResearchExecutionPolicy[] = [
  { id: "NO_ADD", suppressedActions: ["ADD"] },
  { id: "ADD_RISK_CLEAR" },
  { id: "ADD_HIGH_ALIGNMENT" },
  { id: "ADD_CORE_TREND" },
];
void publicResearchPolicyContract;

test("position guard backtest replays buys and exits with trading costs", () => {
  const result = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 100_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    execution: {
      feeRate: 0.0005,
      slippageRate: 0.001,
      minimumTradeValueKrw: 5_000,
    },
    frames: [
      createFrame("2026-04-20T01:00:00.000Z", {
        regime: "EARLY_RECOVERY",
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
        invalidationState: "BROKEN",
        breakdown1d: true,
        breakdown4h: true,
        bearishMomentumExpansion: true,
        currentPrice: 110_000,
      }),
    ],
  });

  assert.equal(result.metrics.tradeCount, 2);
  assert.equal(result.metrics.actionCounts.ENTER, 1);
  assert.equal(result.metrics.actionCounts.EXIT, 1);
  assert.equal(result.frames[0]?.executed, true);
  assert.equal(result.frames[1]?.executed, true);
  assert.ok(result.metrics.turnoverKrw > 0);
  assert.ok(result.metrics.feesKrw > 0);
  assert.ok(result.metrics.finalEquityKrw > 100_000);
  assert.equal(result.finalState.quantity, 0);
});

test("position guard backtest skips order intents below the execution minimum", () => {
  const result = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 10_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    settings: {
      ...DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
      entryAllocation: 0.1,
    },
    execution: {
      feeRate: 0.0005,
      slippageRate: 0,
      minimumTradeValueKrw: 5_000,
    },
    frames: [
      createFrame("2026-04-20T01:00:00.000Z", {
        regime: "EARLY_RECOVERY",
        currentPrice: 100_000,
        entryPath: "RECLAIM",
        reclaimStructure: true,
        trendAlignmentScore: 4,
        recoveryQualityScore: 4,
        volumeRecovery: true,
        macdImproving: true,
        rsiRecovery: true,
      }),
    ],
  });

  assert.equal(result.metrics.tradeCount, 0);
  assert.equal(result.metrics.skippedOrderCount, 1);
  assert.equal(result.frames[0]?.executed, false);
  assert.equal(result.frames[0]?.skipReason, "BELOW_MINIMUM_TRADE_VALUE");
  assert.equal(result.finalState.cashKrw, 10_000);
  assert.equal(result.finalState.quantity, 0);
});

test("position guard backtest executes only after a deferred entry is confirmed", () => {
  const analysis: Partial<PositionGuardStructureAnalysis> = {
    regime: "RECLAIM_ATTEMPT",
    currentPrice: 100_000,
    entryPath: "RECLAIM",
    reclaimStructure: true,
    trendAlignmentScore: 3,
    recoveryQualityScore: 3,
  };
  const result = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 1_000_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    frames: [
      createFrame("2026-04-20T01:05:00.000Z", analysis),
      createFrame("2026-04-20T02:05:00.000Z", analysis),
    ],
  });

  assert.equal(result.frames[0]?.decision.action, "ENTER");
  assert.equal(result.frames[0]?.decision.executionDisposition, "DEFERRED_CONFIRMATION");
  assert.equal(result.frames[0]?.executed, false);
  assert.equal(result.frames[0]?.trade, null);
  assert.equal(result.frames[0]?.skipReason, null);
  assert.equal(result.frames[1]?.decision.action, "ENTER");
  assert.equal(result.frames[1]?.decision.executionDisposition, "EXECUTED_AFTER_CONFIRMATION");
  assert.equal(result.frames[1]?.executed, true);
  assert.equal(result.frames[1]?.trade?.action, "ENTER");
  assert.equal(result.metrics.tradeCount, 1);
  assert.equal(result.metrics.skippedOrderCount, 0);
  assert.ok(result.finalState.quantity > 0);
});

test("position guard backtest preserves the fixed legacy no-policy golden", () => {
  const result = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 100_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    execution: {
      feeRate: 0.0005,
      slippageRate: 0.001,
      minimumTradeValueKrw: 5_000,
    },
    frames: [
      createFrame("2026-04-20T01:00:00.000Z", {
        regime: "EARLY_RECOVERY",
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
        invalidationState: "BROKEN",
        breakdown1d: true,
        breakdown4h: true,
        bearishMomentumExpansion: true,
        currentPrice: 110_000,
      }),
    ],
  });

  assert.deepEqual(result, {
    frames: [
      {
        generatedAt: "2026-04-20T01:00:00.000Z",
        regime: "EARLY_RECOVERY",
        source: undefined,
        decision: {
          action: "ENTER",
          summary: "BTC enter is allowed by constructive structure.",
          reasons: [
            "Regime is EARLY_RECOVERY.",
            "Constructive structure is strong enough to act.",
            "Reclaim structure is intact.",
          ],
          targetNotionalKrw: 30_000,
          targetQuantityFraction: null,
          referencePrice: 100_000,
          executionDisposition: "IMMEDIATE",
          signalQuality: {
            score: 11,
            bucket: "HIGH",
            confirmationRequired: false,
            confirmationSatisfied: false,
            reentryPenaltyApplied: false,
          },
          exposureGuardrails: {
            perAssetMaxAllocation: 0.6,
            totalPortfolioMaxExposure: 0.75,
            remainingAssetCapacity: 60_000,
            remainingPortfolioCapacity: 75_000,
          },
          diagnostics: {
            regime: "EARLY_RECOVERY",
            riskLevel: "LOW",
            invalidationState: "CLEAR",
            invalidationLevel: 95_000,
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
        startingState: { cashKrw: 100_000, quantity: 0, averageEntryPrice: 0 },
        endingState: {
          cashKrw: 69_985,
          quantity: 0.2997002997,
          averageEntryPrice: 100_100,
        },
        executed: true,
        trade: {
          action: "ENTER",
          side: "bid",
          price: 100_100,
          quantity: 0.2997002997,
          grossNotionalKrw: 30_000,
          feeKrw: 15,
          realizedPnlKrw: 0,
        },
        skipReason: null,
        equityKrw: 99_955.02997,
        drawdownPct: 0.00044970029999996767,
      },
      {
        generatedAt: "2026-04-20T02:00:00.000Z",
        regime: "RANGE",
        source: undefined,
        decision: {
          action: "EXIT",
          summary: "BTC exit is required because invalidation has failed.",
          reasons: [
            "Regime is RANGE.",
            "Higher-timeframe support has broken or invalidation is already broken.",
            "Invalidation-first exit remains immediate and unchanged.",
          ],
          targetNotionalKrw: 0,
          targetQuantityFraction: 1,
          referencePrice: 110_000,
          executionDisposition: "IMMEDIATE",
          signalQuality: {
            score: 0,
            bucket: "LOW",
            confirmationRequired: false,
            confirmationSatisfied: false,
            reentryPenaltyApplied: false,
          },
          exposureGuardrails: {
            perAssetMaxAllocation: 0.45,
            totalPortfolioMaxExposure: 0.75,
            remainingAssetCapacity: 13_361.381868150005,
            remainingPortfolioCapacity: 44_246.99175825,
          },
          diagnostics: {
            regime: "RANGE",
            riskLevel: "LOW",
            invalidationState: "BROKEN",
            invalidationLevel: 95_000,
            entryPath: "NONE",
            trendAlignmentScore: 0,
            recoveryQualityScore: 0,
            breakdownPressureScore: 0,
            weakeningStage: "NONE",
            upperRangeChase: false,
            pullbackZone: false,
            reclaimStructure: false,
            breakoutHoldStructure: false,
          },
        },
        startingState: {
          cashKrw: 69_985,
          quantity: 0.2997002997,
          averageEntryPrice: 100_100,
        },
        endingState: { cashKrw: 102_902.598901, quantity: 0, averageEntryPrice: 0 },
        executed: true,
        trade: {
          action: "EXIT",
          side: "ask",
          price: 109_890,
          quantity: 0.2997002997,
          grossNotionalKrw: 32_934.065934,
          feeKrw: 16.467033,
          realizedPnlKrw: 2_917.598901,
        },
        skipReason: null,
        equityKrw: 102_902.598901,
        drawdownPct: 0,
      },
    ],
    metrics: {
      actionCounts: { ENTER: 1, ADD: 0, REDUCE: 0, EXIT: 1, HOLD: 0 },
      regimeCounts: {
        BULL_TREND: 0,
        PULLBACK_IN_UPTREND: 0,
        EARLY_RECOVERY: 1,
        RECLAIM_ATTEMPT: 0,
        RANGE: 1,
        WEAK_DOWNTREND: 0,
        BREAKDOWN_RISK: 0,
      },
      tradeCount: 2,
      skippedOrderCount: 0,
      turnoverKrw: 62_934.065934,
      feesKrw: 31.467033,
      realizedPnlKrw: 2_917.598901,
      finalEquityKrw: 102_902.598901,
      totalReturnPct: 0.029025989010000048,
      maxDrawdownPct: 0.00044970029999996767,
      timeInMarketFrames: 1,
    },
    finalState: { cashKrw: 102_902.598901, quantity: 0, averageEntryPrice: 0 },
  });
  assert.equal(result.frames.every((frame) => !("researchSuppression" in frame)), true);
});

test("NO_ADD preserves the ADD decision while suppressing only simulated execution", () => {
  const baseline = runPositionGuardBacktest(createAddReplayInput());
  const noAdd = runPositionGuardBacktest({
    ...createAddReplayInput(),
    researchExecutionPolicy: { id: "NO_ADD", suppressedActions: ["ADD"] },
  });

  assert.equal(baseline.frames[0]?.decision.action, "ADD");
  assert.equal(baseline.frames[0]?.executed, true);
  assert.equal(noAdd.frames[0]?.decision.action, "ADD");
  assert.deepEqual(noAdd.frames[0]?.decision, baseline.frames[0]?.decision);
  assert.equal(noAdd.frames[0]?.executed, false);
  assert.equal(noAdd.frames[0]?.trade, null);
  assert.equal(noAdd.frames[0]?.skipReason, null);
  assert.deepEqual(noAdd.frames[0]?.researchSuppression, {
    policyId: "NO_ADD",
    originalAction: "ADD",
    reason: "ACTION_SUPPRESSED",
  });
  assert.equal(noAdd.metrics.skippedOrderCount, 0);
});

test("NO_ADD suppression changes later state and decisions through full replay", () => {
  const input = createAddReplayInput();
  const baseline = runPositionGuardBacktest(input);
  const noAdd = runPositionGuardBacktest({
    ...input,
    researchExecutionPolicy: { id: "NO_ADD", suppressedActions: ["ADD"] },
  });

  assert.notDeepEqual(noAdd.frames[1]?.startingState, baseline.frames[1]?.startingState);
  assert.equal(baseline.frames[2]?.decision.action, "HOLD");
  assert.equal(noAdd.frames[2]?.decision.action, "ADD");
  assert.equal(noAdd.metrics.skippedOrderCount, baseline.metrics.skippedOrderCount);
});

test("position guard backtest rejects invalid research policy actions", () => {
  assert.throws(
    () => runPositionGuardBacktest({
      ...createAddReplayInput(),
      researchExecutionPolicy: {
        id: "NO_ADD",
        suppressedActions: ["ENTER"],
      } as never,
    }),
    /NO_ADD.*only suppress ADD/,
  );
});

test("conditional ADD policies suppress each failing boundary with contemporaneous evidence", () => {
  const policyCases = [
    [
      "ADD_RISK_CLEAR",
      { atrShock: true },
      "ATR_SHOCK",
      { atrShock: true, weakeningStage: "NONE", trendAlignmentScore: 4, regime: "BULL_TREND" },
    ],
    [
      "ADD_RISK_CLEAR",
      { weakeningStage: "SOFT" },
      "WEAKENING_PRESENT",
      { atrShock: false, weakeningStage: "SOFT", trendAlignmentScore: 4, regime: "BULL_TREND" },
    ],
    [
      "ADD_HIGH_ALIGNMENT",
      { trendAlignmentScore: 3 },
      "TREND_ALIGNMENT_BELOW_4",
      { atrShock: false, weakeningStage: "NONE", trendAlignmentScore: 3, regime: "BULL_TREND" },
    ],
    [
      "ADD_CORE_TREND",
      { regime: "EARLY_RECOVERY" },
      "REGIME_NOT_CORE_TREND",
      { atrShock: false, weakeningStage: "NONE", trendAlignmentScore: 4, regime: "EARLY_RECOVERY" },
    ],
  ] as const;

  for (const [policyId, analysisOverrides, reason, analysisSnapshot] of policyCases) {
    const generatedAt = "2026-04-20T01:00:00.000Z";
    const input = createAddReplayInput([
      createFrame(generatedAt, {
        ...strongAddAnalysis,
        ...analysisOverrides,
      }),
    ]);
    const result = runPositionGuardBacktest({
      ...input,
      researchExecutionPolicy: { id: policyId },
    });

    assert.equal(result.frames[0]?.decision.action, "ADD", policyId);
    assert.equal(result.frames[0]?.executed, false, policyId);
    assert.equal(result.frames[0]?.trade, null, policyId);
    assert.equal(result.frames[0]?.skipReason, null, policyId);
    assert.deepEqual(result.frames[0]?.researchSuppression, {
      policyId,
      originalAction: "ADD",
      reason,
      generatedAt,
      analysisSnapshot,
    });
  }
});

test("conditional ADD policies execute at their exact passing boundaries", () => {
  const policyCases = [
    ["ADD_RISK_CLEAR", { atrShock: false, weakeningStage: "NONE" }],
    ["ADD_HIGH_ALIGNMENT", { trendAlignmentScore: 4 }],
    ["ADD_CORE_TREND", { trendAlignmentScore: 4, regime: "BULL_TREND" }],
    ["ADD_CORE_TREND", { trendAlignmentScore: 4, regime: "PULLBACK_IN_UPTREND" }],
  ] as const;

  for (const [policyId, analysisOverrides] of policyCases) {
    const result = runPositionGuardBacktest({
      ...createAddReplayInput([
        createFrame("2026-04-20T01:00:00.000Z", {
          ...strongAddAnalysis,
          ...analysisOverrides,
        }),
      ]),
      researchExecutionPolicy: { id: policyId },
    });

    assert.equal(result.frames[0]?.decision.action, "ADD", policyId);
    assert.equal(result.frames[0]?.executed, true, policyId);
    assert.equal(result.frames[0]?.trade?.action, "ADD", policyId);
    assert.equal(result.frames[0]?.researchSuppression, null, policyId);
  }
});

test("conditional ADD policies emit explicit ALLOW evidence only for ADD decisions", () => {
  const generatedAt = "2026-04-20T01:00:00.000Z";
  const result = runPositionGuardBacktest({
    ...createAddReplayInput([
      createFrame(generatedAt, strongAddAnalysis),
    ]),
    execution: { feeRate: 0.0005, slippageRate: 0, minimumTradeValueKrw: 1_000_000 },
    researchExecutionPolicy: { id: "ADD_CORE_TREND" },
  });

  assert.equal(result.frames[0]?.decision.action, "ADD");
  assert.equal(result.frames[0]?.trade, null);
  assert.equal(result.frames[0]?.skipReason, "BELOW_MINIMUM_TRADE_VALUE");
  assert.deepEqual(
    (result.frames[0] as { researchPolicyEvaluation?: unknown }).researchPolicyEvaluation,
    {
      policyId: "ADD_CORE_TREND",
      originalAction: "ADD",
      outcome: "ALLOW",
      reason: "CONDITIONS_MET",
      generatedAt,
      analysisSnapshot: {
        atrShock: false,
        weakeningStage: "NONE",
        trendAlignmentScore: 4,
        regime: "BULL_TREND",
      },
    },
  );
});

test("conditional ADD suppression drives full replay without mutating source frames", () => {
  const input = createAddReplayInput([
    createFrame("2026-04-20T01:00:00.000Z", {
      ...strongAddAnalysis,
      trendAlignmentScore: 3,
    }),
    createFrame("2026-04-20T02:00:00.000Z", strongAddAnalysis),
  ]);
  const sourceBefore = structuredClone(input.frames);
  const baseline = runPositionGuardBacktest(input);
  const first = runPositionGuardBacktest({
    ...input,
    researchExecutionPolicy: { id: "ADD_HIGH_ALIGNMENT" },
  });
  const second = runPositionGuardBacktest({
    ...input,
    researchExecutionPolicy: { id: "ADD_HIGH_ALIGNMENT" },
  });

  assert.equal(first.frames[0]?.decision.action, "ADD");
  assert.equal(first.frames[0]?.executed, false);
  assert.notDeepEqual(first.frames[1]?.startingState, baseline.frames[1]?.startingState);
  assert.deepEqual(input.frames, sourceBefore);
  assert.deepEqual(second, first);
});

test("position guard backtest rejects unknown conditional ADD policy IDs", () => {
  assert.throws(
    () => runPositionGuardBacktest({
      ...createAddReplayInput(),
      researchExecutionPolicy: { id: "ADD_UNKNOWN" } as never,
    }),
    /Invalid research execution policy ADD_UNKNOWN/,
  );
});

test("conditional ADD policies reject forbidden suppression fields", () => {
  assert.throws(
    () => runPositionGuardBacktest({
      ...createAddReplayInput(),
      researchExecutionPolicy: {
        id: "ADD_RISK_CLEAR",
        suppressedActions: ["ADD"],
      } as never,
    }),
    /ADD_RISK_CLEAR.*must not define suppressedActions/,
  );
});

test("conditional ADD policies reject malformed policy analysis fields", () => {
  const malformedCases = [
    ["trendAlignmentScore", Number.NaN],
    ["trendAlignmentScore", Number.POSITIVE_INFINITY],
    ["atrShock", "false"],
    ["weakeningStage", "UNKNOWN"],
    ["regime", "UNKNOWN"],
  ] as const;

  for (const [field, value] of malformedCases) {
    const input = createAddReplayInput([
      createFrame("2026-04-20T01:00:00.000Z", {
        ...strongAddAnalysis,
        [field]: value,
      } as never),
    ]);

    assert.throws(
      () => runPositionGuardBacktest({
        ...input,
        researchExecutionPolicy: { id: "ADD_CORE_TREND" },
      }),
      new RegExp(`Invalid conditional ADD analysis ${field}`),
      field,
    );
  }
});

test("conditional ADD suppression reasons follow strict first-failure precedence", () => {
  const precedenceCases = [
    [
      { atrShock: true, weakeningStage: "SOFT", trendAlignmentScore: 3, regime: "EARLY_RECOVERY" },
      "ATR_SHOCK",
    ],
    [
      { atrShock: false, weakeningStage: "SOFT", trendAlignmentScore: 3, regime: "EARLY_RECOVERY" },
      "WEAKENING_PRESENT",
    ],
    [
      { atrShock: false, weakeningStage: "NONE", trendAlignmentScore: 3, regime: "EARLY_RECOVERY" },
      "TREND_ALIGNMENT_BELOW_4",
    ],
    [
      { atrShock: false, weakeningStage: "NONE", trendAlignmentScore: 4, regime: "EARLY_RECOVERY" },
      "REGIME_NOT_CORE_TREND",
    ],
  ] as const;

  for (const [analysisOverrides, expectedReason] of precedenceCases) {
    const result = runPositionGuardBacktest({
      ...createAddReplayInput([
        createFrame("2026-04-20T01:00:00.000Z", {
          ...strongAddAnalysis,
          ...analysisOverrides,
        }),
      ]),
      researchExecutionPolicy: { id: "ADD_CORE_TREND" },
    });

    assert.equal(result.frames[0]?.decision.action, "ADD");
    assert.equal(result.frames[0]?.researchSuppression?.reason, expectedReason);
  }
});

const strongAddAnalysis: Partial<PositionGuardStructureAnalysis> = {
  regime: "BULL_TREND",
  currentPrice: 100_000,
  entryPath: "RECLAIM",
  reclaimStructure: true,
  trendAlignmentScore: 4,
  recoveryQualityScore: 4,
  volumeRecovery: true,
  macdImproving: true,
  rsiRecovery: true,
};

function createAddReplayInput(frames?: readonly PositionGuardBacktestFrame[]) {
  return {
    asset: "BTC" as const,
    market: "KRW-BTC" as const,
    initialCashKrw: 600_000,
    initialQuantity: 4,
    initialAverageEntryPrice: 100_000,
    frames: frames ?? [
      createFrame("2026-04-20T01:00:00.000Z", strongAddAnalysis),
      createFrame("2026-04-20T02:00:00.000Z", strongAddAnalysis),
      createFrame("2026-04-20T03:00:00.000Z", strongAddAnalysis),
    ],
  };
}

function createFrame(
  generatedAt: string,
  analysisOverrides: Partial<PositionGuardStructureAnalysis>,
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
      averageEntryPrice: 0,
      pnlPct: 0,
      oneHourLocation: "MIDDLE",
      fourHourLocation: "MIDDLE",
      ...analysisOverrides,
    },
  };
}
