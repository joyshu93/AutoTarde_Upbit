import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
  type PositionGuardStructureAnalysis,
} from "../src/modules/strategy/position-guard-core.js";
import {
  evaluatePositionGuardResearchIntervention,
  runPositionGuardBacktest,
  type PositionGuardBacktestFrame,
  type PositionGuardBacktestResearchState,
  type PositionGuardBacktestResearchExecutionPolicy,
} from "../src/modules/strategy/position-guard-backtest.js";
import { test } from "./harness.js";

const publicResearchPolicyContract: readonly PositionGuardBacktestResearchExecutionPolicy[] = [
  { id: "NO_ADD", suppressedActions: ["ADD"] },
  { id: "ADD_RISK_CLEAR" },
  { id: "ADD_HIGH_ALIGNMENT" },
  { id: "ADD_CORE_TREND" },
  { id: "HTF_TREND_GATE" },
  { id: "STRICT_PULLBACK" },
  { id: "EARLY_THESIS_FAILURE" },
  { id: "ADD_LIMITED" },
  { id: "COOLDOWN_CONTROL" },
  { id: "COMBINED_CONSERVATIVE" },
  { id: "COMBINED_MINUS_HTF_TREND_GATE" },
  { id: "COMBINED_MINUS_EARLY_THESIS_FAILURE" },
  { id: "COMBINED_MINUS_ADD_LIMITED" },
  { id: "COMBINED_MINUS_COOLDOWN_CONTROL" },
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

test("frozen entry overlays allow only their exact contemporaneous entry evidence", () => {
  const enterDecision = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 100_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    frames: [createFrame("2026-04-20T01:00:00.000Z", {
      regime: "EARLY_RECOVERY",
      entryPath: "RECLAIM",
      reclaimStructure: true,
      trendAlignmentScore: 4,
      recoveryQualityScore: 4,
      volumeRecovery: true,
      macdImproving: true,
      rsiRecovery: true,
    })],
  }).frames[0]!.decision;
  assert.equal(enterDecision.action, "ENTER");
  const state = { cashKrw: 100_000, quantity: 0, averageEntryPrice: 0 };
  const researchState = emptyResearchState();
  const generatedAt = "2026-04-20T01:00:00.000Z";

  const htfAllowed = evaluatePositionGuardResearchIntervention({
    policyId: "HTF_TREND_GATE",
    generatedAt,
    decision: enterDecision,
    state,
    researchState,
    analysis: createFrame(generatedAt, {
      regime: "EARLY_RECOVERY",
      trendAlignmentScore: 3,
      weakeningStage: "NONE",
      breakdown1d: false,
      breakdown4h: false,
    }).analysis,
  });
  assert.deepEqual(
    [htfAllowed?.outcome, htfAllowed?.effectiveAction, htfAllowed?.reason],
    ["ALLOW", "ENTER", "CONDITIONS_MET"],
  );

  const htfSuppressed = evaluatePositionGuardResearchIntervention({
    policyId: "HTF_TREND_GATE",
    generatedAt,
    decision: enterDecision,
    state,
    researchState,
    analysis: createFrame(generatedAt, {
      regime: "EARLY_RECOVERY",
      trendAlignmentScore: 2,
    }).analysis,
  });
  assert.deepEqual(
    [htfSuppressed?.outcome, htfSuppressed?.effectiveAction, htfSuppressed?.reason],
    ["SUPPRESS", "HOLD", "TREND_ALIGNMENT_BELOW_3"],
  );

  const strictAllowed = evaluatePositionGuardResearchIntervention({
    policyId: "STRICT_PULLBACK",
    generatedAt,
    decision: enterDecision,
    state,
    researchState,
    analysis: createFrame(generatedAt, {
      regime: "PULLBACK_IN_UPTREND",
      entryPath: "PULLBACK",
      pullbackZone: true,
      trendAlignmentScore: 4,
      recoveryQualityScore: 3,
      oneHourLocation: "MIDDLE",
      volumeRecovery: true,
      macdImproving: true,
    }).analysis,
  });
  assert.deepEqual(
    [strictAllowed?.outcome, strictAllowed?.effectiveAction, strictAllowed?.reason],
    ["ALLOW", "ENTER", "CONDITIONS_MET"],
  );

  const strictSuppressed = evaluatePositionGuardResearchIntervention({
    policyId: "STRICT_PULLBACK",
    generatedAt,
    decision: enterDecision,
    state,
    researchState,
    analysis: createFrame(generatedAt, {
      regime: "PULLBACK_IN_UPTREND",
      entryPath: "RECLAIM",
      pullbackZone: true,
      trendAlignmentScore: 4,
      recoveryQualityScore: 3,
      oneHourLocation: "LOWER",
      volumeRecovery: true,
      rsiRecovery: true,
    }).analysis,
  });
  assert.deepEqual(
    [strictSuppressed?.outcome, strictSuppressed?.effectiveAction, strictSuppressed?.reason],
    ["SUPPRESS", "HOLD", "ENTRY_PATH_NOT_PULLBACK"],
  );
});

test("early thesis failure overrides HOLD or ADD but preserves risk-reducing decisions", () => {
  const baseline = runPositionGuardBacktest(createAddReplayInput());
  const addDecision = baseline.frames[0]!.decision;
  const exitDecision = runPositionGuardBacktest({
    ...createAddReplayInput([createFrame("2026-04-20T01:00:00.000Z", {
      invalidationState: "BROKEN",
      breakdown1d: true,
    })]),
  }).frames[0]!.decision;
  assert.equal(addDecision.action, "ADD");
  assert.equal(exitDecision.action, "EXIT");
  const generatedAt = "2026-04-20T01:00:00.000Z";
  const analysis = createFrame(generatedAt, {
    currentPrice: 90_000,
    failedReclaim: true,
    weakeningStage: "CLEAR",
    recoveryQualityScore: 1,
  }).analysis;
  const shared = {
    policyId: "EARLY_THESIS_FAILURE" as const,
    generatedAt,
    state: { cashKrw: 600_000, quantity: 4, averageEntryPrice: 100_000 },
    researchState: emptyResearchState(),
    analysis,
  };

  const overridden = evaluatePositionGuardResearchIntervention({ ...shared, decision: addDecision });
  assert.deepEqual(
    [overridden?.outcome, overridden?.originalAction, overridden?.effectiveAction, overridden?.reason],
    ["OVERRIDE_EXIT", "ADD", "EXIT", "FAILED_RECLAIM_THESIS"],
  );
  const preserved = evaluatePositionGuardResearchIntervention({ ...shared, decision: exitDecision });
  assert.deepEqual(
    [preserved?.outcome, preserved?.originalAction, preserved?.effectiveAction, preserved?.reason],
    ["ALLOW", "EXIT", "EXIT", "RISK_REDUCING_DECISION_PRESERVED"],
  );
});

test("ADD_LIMITED enforces frozen first-failure precedence and executed ADD count", () => {
  const decision = runPositionGuardBacktest(createAddReplayInput()).frames[0]!.decision;
  const generatedAt = "2026-04-20T01:00:00.000Z";
  const base = {
    policyId: "ADD_LIMITED" as const,
    generatedAt,
    decision,
    state: { cashKrw: 600_000, quantity: 4, averageEntryPrice: 100_000 },
  };
  const allowed = evaluatePositionGuardResearchIntervention({
    ...base,
    researchState: emptyResearchState(),
    analysis: createFrame(generatedAt, strongAddAnalysis).analysis,
  });
  assert.deepEqual([allowed?.outcome, allowed?.reason], ["ALLOW", "CONDITIONS_MET"]);

  const atLoss = evaluatePositionGuardResearchIntervention({
    ...base,
    researchState: { ...emptyResearchState(), currentEpisodeAddCount: 1 },
    analysis: createFrame(generatedAt, {
      ...strongAddAnalysis,
      currentPrice: 99_000,
      atrShock: true,
    }).analysis,
  });
  assert.deepEqual([atLoss?.outcome, atLoss?.reason], ["SUPPRESS", "POSITION_AT_LOSS"]);

  const limited = evaluatePositionGuardResearchIntervention({
    ...base,
    researchState: { ...emptyResearchState(), currentEpisodeAddCount: 1 },
    analysis: createFrame(generatedAt, strongAddAnalysis).analysis,
  });
  assert.deepEqual([limited?.outcome, limited?.reason], ["SUPPRESS", "EPISODE_ADD_LIMIT_REACHED"]);
});

test("stateful scenarios reject carry-in inventory without explicit research state", () => {
  for (const id of ["ADD_LIMITED", "COOLDOWN_CONTROL", "COMBINED_CONSERVATIVE"] as const) {
    assert.throws(
      () => runPositionGuardBacktest({
        ...createAddReplayInput(),
        researchExecutionPolicy: { id },
      }),
      new RegExp(`${id}.*carry-in research state`),
    );
  }

  assert.throws(
    () => runPositionGuardBacktest({
      ...createAddReplayInput(),
      researchExecutionPolicy: { id: "COOLDOWN_CONTROL" },
      researchCarryInState: {
        ...emptyResearchState(),
        currentEpisodeRealizedPnlKrw: Number.NaN,
      },
    }),
    /currentEpisodeRealizedPnlKrw.*finite/,
  );
});

test("cooldown uses elapsed timestamps and prior full-exit evidence", () => {
  const enterDecision = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 100_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    frames: [createFrame("2026-04-20T13:00:00.000Z", {
      regime: "EARLY_RECOVERY",
      entryPath: "RECLAIM",
      reclaimStructure: true,
      trendAlignmentScore: 4,
      recoveryQualityScore: 4,
      volumeRecovery: true,
      macdImproving: true,
      rsiRecovery: true,
    })],
  }).frames[0]!.decision;
  const analysis = createFrame("2026-04-20T13:00:00.000Z", {
    entryPath: "RECLAIM",
  }).analysis;
  const base = {
    policyId: "COOLDOWN_CONTROL" as const,
    decision: enterDecision,
    state: { cashKrw: 100_000, quantity: 0, averageEntryPrice: 0 },
    analysis,
  };
  const lossCooldown = evaluatePositionGuardResearchIntervention({
    ...base,
    generatedAt: "2026-04-20T11:59:59.999Z",
    researchState: {
      ...emptyResearchState(),
      lastFullExitAt: "2026-04-20T00:00:00.000Z",
      lastFullExitRealizedPnlKrw: 0,
      lastEntryPath: "PULLBACK",
    },
  });
  assert.deepEqual([lossCooldown?.outcome, lossCooldown?.reason], ["SUPPRESS", "NON_POSITIVE_EXIT_12H_COOLDOWN"]);

  const samePathCooldown = evaluatePositionGuardResearchIntervention({
    ...base,
    generatedAt: "2026-04-20T13:00:00.000Z",
    researchState: {
      ...emptyResearchState(),
      lastFullExitAt: "2026-04-20T00:00:00.000Z",
      lastFullExitRealizedPnlKrw: 1,
      lastEntryPath: "RECLAIM",
    },
  });
  assert.deepEqual([samePathCooldown?.outcome, samePathCooldown?.reason], ["SUPPRESS", "SAME_ENTRY_PATH_24H_COOLDOWN"]);

  const elapsed = evaluatePositionGuardResearchIntervention({
    ...base,
    generatedAt: "2026-04-21T00:00:00.000Z",
    researchState: {
      ...emptyResearchState(),
      lastFullExitAt: "2026-04-20T00:00:00.000Z",
      lastFullExitRealizedPnlKrw: 0,
      lastEntryPath: "RECLAIM",
    },
  });
  assert.deepEqual([elapsed?.outcome, elapsed?.reason], ["ALLOW", "CONDITIONS_MET"]);
});

test("cooldown compares mixed-offset nanosecond timestamps exactly at 12h and 24h", () => {
  const enterDecision = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 100_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    frames: [createFrame("2026-04-20T13:00:00.000Z", {
      regime: "EARLY_RECOVERY",
      entryPath: "RECLAIM",
      reclaimStructure: true,
      trendAlignmentScore: 4,
      recoveryQualityScore: 4,
      volumeRecovery: true,
      macdImproving: true,
      rsiRecovery: true,
    })],
  }).frames[0]!.decision;
  const base = {
    policyId: "COOLDOWN_CONTROL" as const,
    decision: enterDecision,
    state: { cashKrw: 100_000, quantity: 0, averageEntryPrice: 0 },
    analysis: createFrame("2026-04-20T13:00:00.000Z", { entryPath: "RECLAIM" }).analysis,
  };
  const exitAt = "2026-04-20T00:00:00.000000500Z";
  const evaluate = (
    generatedAt: string,
    lastFullExitRealizedPnlKrw: number,
    lastEntryPath: PositionGuardBacktestResearchState["lastEntryPath"],
  ) => evaluatePositionGuardResearchIntervention({
    ...base,
    generatedAt,
    researchState: {
      ...emptyResearchState(),
      lastFullExitAt: exitAt,
      lastFullExitRealizedPnlKrw,
      lastEntryPath,
    },
  });

  assert.equal(
    evaluate("2026-04-20T21:00:00.000000499+09:00", 0, "PULLBACK")?.reason,
    "NON_POSITIVE_EXIT_12H_COOLDOWN",
  );
  assert.equal(
    evaluate("2026-04-20T21:00:00.000000500+09:00", 0, "PULLBACK")?.reason,
    "CONDITIONS_MET",
  );
  assert.equal(
    evaluate("2026-04-20T21:00:00.000000501+09:00", 0, "PULLBACK")?.reason,
    "CONDITIONS_MET",
  );
  assert.equal(
    evaluate("2026-04-21T09:00:00.000000499+09:00", 1, "RECLAIM")?.reason,
    "SAME_ENTRY_PATH_24H_COOLDOWN",
  );
  assert.equal(
    evaluate("2026-04-21T09:00:00.000000500+09:00", 1, "RECLAIM")?.reason,
    "CONDITIONS_MET",
  );
  assert.equal(
    evaluate("2026-04-21T09:00:00.000000501+09:00", 1, "RECLAIM")?.reason,
    "CONDITIONS_MET",
  );
});

test("cooldown uses the whole episode loss when REDUCE loses and final EXIT profits", () => {
  const result = runCooldownEpisodeReplay(50_000, 110_000);

  assert.deepEqual(result.frames.slice(0, 3).map((frame) => frame.decision.action), [
    "REDUCE",
    "EXIT",
    "ENTER",
  ]);
  assert.ok((result.frames[0]?.trade?.realizedPnlKrw ?? 0) < 0);
  assert.ok((result.frames[1]?.trade?.realizedPnlKrw ?? 0) > 0);
  assert.ok((result.finalResearchState?.lastFullExitRealizedPnlKrw ?? 0) < 0);
  assert.equal(result.frames[2]?.researchIntervention?.reason, "NON_POSITIVE_EXIT_12H_COOLDOWN");
  assert.equal(result.frames[2]?.trade, null);
  assert.equal(result.finalResearchState?.currentEpisodeRealizedPnlKrw, 0);
});

test("cooldown uses the whole episode profit when REDUCE profits and final EXIT loses", () => {
  const result = runCooldownEpisodeReplay(150_000, 90_000);

  assert.deepEqual(result.frames.slice(0, 3).map((frame) => frame.decision.action), [
    "REDUCE",
    "EXIT",
    "ENTER",
  ]);
  assert.ok((result.frames[0]?.trade?.realizedPnlKrw ?? 0) > 0);
  assert.ok((result.frames[1]?.trade?.realizedPnlKrw ?? 0) < 0);
  assert.ok((result.finalResearchState?.lastFullExitRealizedPnlKrw ?? 0) > 0);
  assert.equal(result.frames[2]?.researchIntervention?.reason, "CONDITIONS_MET");
  assert.equal(result.frames[2]?.trade?.action, "ENTER");
  assert.equal(result.finalResearchState?.currentEpisodeRealizedPnlKrw, 0);
});

test("combined conservative applies early-exit before entry and ADD suppressions", () => {
  const decision = runPositionGuardBacktest(createAddReplayInput()).frames[0]!.decision;
  const generatedAt = "2026-04-20T01:00:00.000Z";
  const result = evaluatePositionGuardResearchIntervention({
    policyId: "COMBINED_CONSERVATIVE",
    generatedAt,
    decision,
    state: { cashKrw: 600_000, quantity: 4, averageEntryPrice: 100_000 },
    researchState: { ...emptyResearchState(), currentEpisodeAddCount: 1 },
    analysis: createFrame(generatedAt, {
      ...strongAddAnalysis,
      currentPrice: 90_000,
      failedReclaim: true,
      weakeningStage: "CLEAR",
      recoveryQualityScore: 1,
    }).analysis,
  });

  assert.deepEqual(
    [result?.outcome, result?.effectiveAction, result?.reason],
    ["OVERRIDE_EXIT", "EXIT", "FAILED_RECLAIM_THESIS"],
  );
});

test("combined ablations omit exactly one component while retaining original precedence", () => {
  const generatedAt = "2026-04-20T13:00:00.000Z";
  const addDecision = runPositionGuardBacktest(createAddReplayInput()).frames[0]!.decision;
  const enterDecision = runPositionGuardBacktest({
    ...createAddReplayInput([createFrame(generatedAt, {
      regime: "EARLY_RECOVERY",
      currentPrice: 100_000,
      entryPath: "RECLAIM",
      reclaimStructure: true,
      trendAlignmentScore: 4,
      recoveryQualityScore: 4,
      volumeRecovery: true,
      macdImproving: true,
      rsiRecovery: true,
    })]),
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
  }).frames[0]!.decision;

  const withoutEarlyFailure = evaluatePositionGuardResearchIntervention({
    policyId: "COMBINED_MINUS_EARLY_THESIS_FAILURE",
    generatedAt,
    decision: addDecision,
    state: { cashKrw: 600_000, quantity: 4, averageEntryPrice: 100_000 },
    researchState: { ...emptyResearchState(), currentEpisodeAddCount: 1 },
    analysis: createFrame(generatedAt, {
      ...strongAddAnalysis,
      currentPrice: 90_000,
      failedReclaim: true,
      weakeningStage: "CLEAR",
      recoveryQualityScore: 1,
    }).analysis,
  });
  assert.deepEqual(
    [withoutEarlyFailure?.outcome, withoutEarlyFailure?.reason],
    ["SUPPRESS", "POSITION_AT_LOSS"],
  );

  const withoutAddLimited = evaluatePositionGuardResearchIntervention({
    policyId: "COMBINED_MINUS_ADD_LIMITED",
    generatedAt,
    decision: addDecision,
    state: { cashKrw: 600_000, quantity: 4, averageEntryPrice: 100_000 },
    researchState: { ...emptyResearchState(), currentEpisodeAddCount: 1 },
    analysis: createFrame(generatedAt, strongAddAnalysis).analysis,
  });
  assert.equal(withoutAddLimited, null);

  const withoutHtfGate = evaluatePositionGuardResearchIntervention({
    policyId: "COMBINED_MINUS_HTF_TREND_GATE",
    generatedAt,
    decision: enterDecision,
    state: { cashKrw: 1_000_000, quantity: 0, averageEntryPrice: 0 },
    researchState: emptyResearchState(),
    analysis: createFrame(generatedAt, {
      regime: "EARLY_RECOVERY",
      entryPath: "RECLAIM",
      trendAlignmentScore: 2,
    }).analysis,
  });
  assert.equal(withoutHtfGate, null);

  const withoutCooldown = evaluatePositionGuardResearchIntervention({
    policyId: "COMBINED_MINUS_COOLDOWN_CONTROL",
    generatedAt,
    decision: enterDecision,
    state: { cashKrw: 1_000_000, quantity: 0, averageEntryPrice: 0 },
    researchState: {
      ...emptyResearchState(),
      lastFullExitAt: "2026-04-20T12:00:00.000Z",
      lastFullExitRealizedPnlKrw: -1,
    },
    analysis: createFrame(generatedAt, {
      regime: "EARLY_RECOVERY",
      entryPath: "RECLAIM",
      trendAlignmentScore: 4,
    }).analysis,
  });
  assert.equal(withoutCooldown, null);
});

test("every combined ablation retains the exact complementary component behavior and precedence", () => {
  const generatedAt = "2026-04-20T13:00:00.000Z";
  const addDecision = runPositionGuardBacktest(createAddReplayInput()).frames[0]!.decision;
  const holdDecision = runPositionGuardBacktest({
    ...createAddReplayInput([createFrame(generatedAt, {})]),
  }).frames[0]!.decision;
  const enterDecision = runPositionGuardBacktest({
    ...createAddReplayInput([createFrame(generatedAt, {
      regime: "EARLY_RECOVERY",
      currentPrice: 100_000,
      entryPath: "RECLAIM",
      reclaimStructure: true,
      trendAlignmentScore: 4,
      recoveryQualityScore: 4,
      volumeRecovery: true,
      macdImproving: true,
      rsiRecovery: true,
    })]),
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
  }).frames[0]!.decision;
  const policyIds = [
    "COMBINED_MINUS_HTF_TREND_GATE",
    "COMBINED_MINUS_EARLY_THESIS_FAILURE",
    "COMBINED_MINUS_ADD_LIMITED",
    "COMBINED_MINUS_COOLDOWN_CONTROL",
  ] as const;
  const expected = {
    COMBINED_MINUS_HTF_TREND_GATE: {
      components: ["FAILED_RECLAIM_THESIS", "NON_POSITIVE_EXIT_12H_COOLDOWN", null, "EPISODE_ADD_LIMIT_REACHED"],
      precedence: ["FAILED_RECLAIM_THESIS", "NON_POSITIVE_EXIT_12H_COOLDOWN"],
    },
    COMBINED_MINUS_EARLY_THESIS_FAILURE: {
      components: [null, "NON_POSITIVE_EXIT_12H_COOLDOWN", "TREND_ALIGNMENT_BELOW_3", "EPISODE_ADD_LIMIT_REACHED"],
      precedence: ["POSITION_AT_LOSS", "NON_POSITIVE_EXIT_12H_COOLDOWN"],
    },
    COMBINED_MINUS_ADD_LIMITED: {
      components: ["FAILED_RECLAIM_THESIS", "NON_POSITIVE_EXIT_12H_COOLDOWN", "TREND_ALIGNMENT_BELOW_3", null],
      precedence: ["FAILED_RECLAIM_THESIS", "NON_POSITIVE_EXIT_12H_COOLDOWN"],
    },
    COMBINED_MINUS_COOLDOWN_CONTROL: {
      components: ["FAILED_RECLAIM_THESIS", null, "TREND_ALIGNMENT_BELOW_3", "EPISODE_ADD_LIMIT_REACHED"],
      precedence: ["FAILED_RECLAIM_THESIS", "TREND_ALIGNMENT_BELOW_3"],
    },
  } as const;

  for (const policyId of policyIds) {
    const base = {
      policyId,
      generatedAt,
      state: { cashKrw: 600_000, quantity: 4, averageEntryPrice: 100_000 },
    };
    const early = evaluatePositionGuardResearchIntervention({
      ...base,
      decision: holdDecision,
      researchState: emptyResearchState(),
      analysis: createFrame(generatedAt, {
        failedReclaim: true,
        weakeningStage: "CLEAR",
        recoveryQualityScore: 1,
      }).analysis,
    })?.reason ?? null;
    const cooldown = evaluatePositionGuardResearchIntervention({
      ...base,
      decision: enterDecision,
      state: { cashKrw: 1_000_000, quantity: 0, averageEntryPrice: 0 },
      researchState: {
        ...emptyResearchState(),
        lastFullExitAt: "2026-04-20T12:00:00.000Z",
        lastFullExitRealizedPnlKrw: -1,
      },
      analysis: createFrame(generatedAt, {
        regime: "EARLY_RECOVERY",
        entryPath: "RECLAIM",
        trendAlignmentScore: 4,
      }).analysis,
    })?.reason ?? null;
    const htf = evaluatePositionGuardResearchIntervention({
      ...base,
      decision: enterDecision,
      state: { cashKrw: 1_000_000, quantity: 0, averageEntryPrice: 0 },
      researchState: emptyResearchState(),
      analysis: createFrame(generatedAt, {
        regime: "EARLY_RECOVERY",
        entryPath: "RECLAIM",
        trendAlignmentScore: 2,
      }).analysis,
    })?.reason ?? null;
    const add = evaluatePositionGuardResearchIntervention({
      ...base,
      decision: addDecision,
      researchState: { ...emptyResearchState(), currentEpisodeAddCount: 1 },
      analysis: createFrame(generatedAt, strongAddAnalysis).analysis,
    })?.reason ?? null;
    const earlyBeforeAdd = evaluatePositionGuardResearchIntervention({
      ...base,
      decision: addDecision,
      researchState: { ...emptyResearchState(), currentEpisodeAddCount: 1 },
      analysis: createFrame(generatedAt, {
        ...strongAddAnalysis,
        currentPrice: 90_000,
        failedReclaim: true,
        weakeningStage: "CLEAR",
        recoveryQualityScore: 1,
      }).analysis,
    })?.reason ?? null;
    const cooldownBeforeHtf = evaluatePositionGuardResearchIntervention({
      ...base,
      decision: enterDecision,
      state: { cashKrw: 1_000_000, quantity: 0, averageEntryPrice: 0 },
      researchState: {
        ...emptyResearchState(),
        lastFullExitAt: "2026-04-20T12:00:00.000Z",
        lastFullExitRealizedPnlKrw: -1,
      },
      analysis: createFrame(generatedAt, {
        regime: "EARLY_RECOVERY",
        entryPath: "RECLAIM",
        trendAlignmentScore: 2,
      }).analysis,
    })?.reason ?? null;

    assert.deepEqual([early, cooldown, htf, add], expected[policyId].components);
    assert.deepEqual([earlyBeforeAdd, cooldownBeforeHtf], expected[policyId].precedence);
  }
});

test("combined ablations preserve core risk reduction before component evaluation", () => {
  const generatedAt = "2026-04-20T01:00:00.000Z";
  const exitDecision = runPositionGuardBacktest({
    ...createAddReplayInput([createFrame(generatedAt, {
      invalidationState: "BROKEN",
      breakdown1d: true,
      breakdown4h: true,
      bearishMomentumExpansion: true,
    })]),
  }).frames[0]!.decision;
  const policyIds = [
    "COMBINED_MINUS_HTF_TREND_GATE",
    "COMBINED_MINUS_EARLY_THESIS_FAILURE",
    "COMBINED_MINUS_ADD_LIMITED",
    "COMBINED_MINUS_COOLDOWN_CONTROL",
  ] as const;

  for (const policyId of policyIds) {
    const result = evaluatePositionGuardResearchIntervention({
      policyId,
      generatedAt,
      decision: exitDecision,
      state: { cashKrw: 600_000, quantity: 4, averageEntryPrice: 100_000 },
      researchState: emptyResearchState(),
      analysis: createFrame(generatedAt, { breakdown1d: true, breakdown4h: true }).analysis,
    });
    assert.deepEqual(
      [result?.outcome, result?.effectiveAction, result?.reason],
      ["ALLOW", "EXIT", "RISK_REDUCING_DECISION_PRESERVED"],
    );
  }
});

test("combined conservative retains a byte-for-byte full-result golden", () => {
  const result = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 1_000_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    executionTimingModel: "NEXT_FRAME_MODELED",
    researchExecutionPolicy: { id: "COMBINED_CONSERVATIVE" },
    frames: [
      createFrame("2026-04-20T01:00:00.000000100Z", {
        ...strongAddAnalysis,
        regime: "EARLY_RECOVERY",
        entryPath: "RECLAIM",
      }),
      createFrame("2026-04-20T02:00:00.000000200Z", strongAddAnalysis),
      createFrame("2026-04-20T03:00:00.000000300Z", {
        currentPrice: 110_000,
        invalidationState: "BROKEN",
        breakdown1d: true,
        breakdown4h: true,
        bearishMomentumExpansion: true,
      }),
      createFrame("2026-04-20T04:00:00.000000400Z", { currentPrice: 105_000 }),
    ],
  });
  const serialized = JSON.stringify(result);

  assert.equal(result.frames.length, 4);
  assert.ok(result.frames.some((frame) => frame.researchIntervention?.evidence));
  assert.ok(result.frames.some((frame) => frame.modeledExecution));
  assert.ok(result.frames.some((frame) => frame.modeledTradeOrigin));
  assert.ok(result.finalResearchState);
  assert.equal(
    createHash("sha256").update(serialized).digest("hex"),
    "ca974febcf3d20d6ae87b35aa41c9b5932b90c55a0107ab5496b27ea139ff02b",
  );
});

test("NEXT_FRAME_MODELED executes against the next price and records the final pending skip", () => {
  const input = {
    asset: "BTC" as const,
    market: "KRW-BTC" as const,
    initialCashKrw: 100_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    executionTimingModel: "NEXT_FRAME_MODELED" as const,
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
        regime: "EARLY_RECOVERY",
        currentPrice: 110_000,
        entryPath: "RECLAIM",
        reclaimStructure: true,
        trendAlignmentScore: 4,
        recoveryQualityScore: 4,
        volumeRecovery: true,
        macdImproving: true,
        rsiRecovery: true,
      }),
    ],
  };
  const result = runPositionGuardBacktest(input);

  assert.equal(result.frames[0]?.decision.action, "ENTER");
  assert.equal(result.frames[0]?.trade, null);
  assert.equal(result.frames[0]?.modeledExecution?.status, "EXECUTED_NEXT_FRAME");
  assert.equal(result.frames[0]?.modeledExecution?.executedAt, "2026-04-20T02:00:00.000Z");
  assert.equal(result.frames[0]?.modeledExecution?.executionPrice, 110_000);
  assert.equal((result.frames[1]?.startingState.quantity ?? 0) > 0, true);
  assert.equal(result.frames[1]?.modeledExecution?.status, "SKIPPED_NO_NEXT_FRAME");
  assert.equal(result.frames[1]?.modeledExecution?.reason, "NO_NEXT_FRAME");
  assert.equal(result.metrics.tradeCount, 1);
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

function emptyResearchState(): PositionGuardBacktestResearchState {
  return {
    currentEpisodeAddCount: 0,
    currentEpisodeRealizedPnlKrw: 0,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
  };
}

function runCooldownEpisodeReplay(reducePrice: number, exitPrice: number) {
  return runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 100_000,
    initialQuantity: 1,
    initialAverageEntryPrice: 100_000,
    researchExecutionPolicy: { id: "COOLDOWN_CONTROL" },
    researchCarryInState: {
      ...emptyResearchState(),
      lastEntryPath: "PULLBACK",
    },
    frames: [
      createFrame("2026-04-20T01:00:00.000Z", {
        regime: "WEAK_DOWNTREND",
        currentPrice: reducePrice,
        weakeningStage: "CLEAR",
        failedReclaim: true,
        bearishMomentumExpansion: true,
      }),
      createFrame("2026-04-20T02:00:00.000Z", {
        currentPrice: exitPrice,
        invalidationState: "BROKEN",
        breakdown1d: true,
        breakdown4h: true,
        bearishMomentumExpansion: true,
      }),
      createFrame("2026-04-20T03:00:00.000Z", {
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
}

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
