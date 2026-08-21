import assert from "node:assert/strict";

import type {
  PositionGuardEngineDecision,
  PositionGuardStructureAnalysis,
} from "../src/modules/strategy/position-guard-core.js";
import type { PositionGuardCandidateState } from "../src/modules/strategy/position-guard-candidate-state.js";
import {
  evaluatePositionGuardCandidate,
  type PositionGuardRegisteredCandidatePolicyId,
} from "../src/modules/strategy/position-guard-candidate-policy.js";
import { test } from "./harness.js";

test("candidate policy preserves baseline EXIT and REDUCE decisions before every overlay", () => {
  for (const policyId of [
    "COMBINED_CONSERVATIVE",
    "COMBINED_MINUS_EARLY_THESIS_FAILURE",
    "COMBINED_MINUS_COOLDOWN_CONTROL",
  ] as const) {
    for (const action of ["EXIT", "REDUCE"] as const) {
    const baseline = decision({ action, targetQuantityFraction: action === "EXIT" ? 1 : 0.33 });
    const result = evaluate({
      policyId,
      decision: baseline,
      positionQuantity: 0.01,
      averageEntryPrice: 100,
      analysis: analysis({
        failedReclaim: true,
        recoveryQualityScore: 0,
        breakdownPressureScore: 3,
        breakdown1d: true,
        trendAlignmentScore: 0,
        weakeningStage: "FAILURE",
        atrShock: true,
        regime: "BREAKDOWN_RISK",
      }),
      candidateState: state({
        lastFullExitAt: "2026-08-20T00:00:00Z",
        lastFullExitRealizedPnlKrw: -1,
      }),
    });

    assert.equal(result.outcome, "ALLOW");
    assert.equal(result.reason, "RISK_REDUCING_DECISION_PRESERVED");
    assert.equal(result.precedence, "PRESERVE_RISK_REDUCTION");
    assert.equal(result.effectiveAction, action);
    assert.notEqual(result.effectiveDecision, baseline);
    }
  }
});

test("candidate policy exits a positioned failed reclaim before lower-precedence controls", () => {
  const result = evaluate({
    decision: decision({ action: "ADD" }),
    positionQuantity: 0.01,
    averageEntryPrice: 100,
    analysis: analysis({
      failedReclaim: true,
      weakeningStage: "CLEAR",
      recoveryQualityScore: 1,
      currentPrice: 101,
    }),
  });

  assertOverrideExit(result, "EARLY_THESIS_FAILURE", "FAILED_RECLAIM_THESIS");
});

test("candidate policy exits a positioned bearish loss before lower-precedence controls", () => {
  const result = evaluate({
    decision: decision({ action: "ADD" }),
    positionQuantity: 0.01,
    averageEntryPrice: 100,
    analysis: analysis({
      breakdownPressureScore: 2,
      bearishMomentumExpansion: true,
      pnlPct: -0.1,
      currentPrice: 101,
    }),
  });

  assertOverrideExit(result, "EARLY_THESIS_FAILURE", "BEARISH_LOSS_THESIS");
});

test("candidate policy restricts early failures to positioned HOLD or ADD under exact frozen conditions", () => {
  const failedReclaim = analysis({ failedReclaim: true, recoveryQualityScore: 1 });
  for (const weakeningStage of ["NONE", "SOFT"] as const) {
    assert.equal(evaluate({
      decision: decision({ action: "HOLD" }),
      positionQuantity: 0.01,
      analysis: analysis({ ...failedReclaim, weakeningStage }),
    }).outcome, "ALLOW");
  }
  assert.equal(evaluate({
    decision: decision({ action: "ENTER" }),
    positionQuantity: 0.01,
    analysis: analysis({ ...failedReclaim, weakeningStage: "CLEAR" }),
  }).precedence, "HTF_TREND_GATE");
  assert.equal(evaluate({
    decision: decision({ action: "HOLD" }),
    positionQuantity: 1e-12,
    analysis: analysis({ ...failedReclaim, weakeningStage: "FAILURE" }),
  }).outcome, "ALLOW");
  assert.equal(evaluate({
    decision: decision({ action: "ADD" }),
    positionQuantity: 0.01,
    analysis: analysis({ breakdownPressureScore: 2, pnlPct: -0.1 }),
  }).outcome, "ALLOW");
});

test("candidate policy suppresses ENTER during the 12-hour non-positive-exit cooldown", () => {
  const result = evaluate({
    decision: decision({ action: "ENTER" }),
    candidateState: state({
      lastFullExitAt: "2026-08-20T00:00:00Z",
      lastFullExitRealizedPnlKrw: 0,
    }),
    generatedAt: "2026-08-20T11:59:59.999999999Z",
  });

  assertSuppress(result, "COOLDOWN_CONTROL", "NON_POSITIVE_EXIT_12H_COOLDOWN");
});

test("candidate policy suppresses ENTER during the 24-hour same-entry-path cooldown", () => {
  const result = evaluate({
    decision: decision({ action: "ENTER" }),
    candidateState: state({
      lastFullExitAt: "2026-08-20T00:00:00Z",
      lastFullExitRealizedPnlKrw: 10,
      lastEntryPath: "PULLBACK",
    }),
    generatedAt: "2026-08-20T23:59:59.999999999Z",
  });

  assertSuppress(result, "COOLDOWN_CONTROL", "SAME_ENTRY_PATH_24H_COOLDOWN");
});

test("candidate policy releases exact cooldown boundaries and rejects future full-exit timestamps", () => {
  const nonPositiveState = state({
    lastFullExitAt: "2026-08-20T00:00:00Z",
    lastFullExitRealizedPnlKrw: 0,
  });
  assert.equal(evaluate({
    candidateState: nonPositiveState,
    generatedAt: "2026-08-20T12:00:00Z",
  }).outcome, "ALLOW");

  const samePathState = state({
    lastFullExitAt: "2026-08-20T00:00:00Z",
    lastFullExitRealizedPnlKrw: 1,
    lastEntryPath: "PULLBACK",
  });
  assert.equal(evaluate({
    candidateState: samePathState,
    generatedAt: "2026-08-21T00:00:00Z",
  }).outcome, "ALLOW");
  assert.throws(() => evaluate({
    candidateState: samePathState,
    generatedAt: "2026-08-19T23:59:59.999999999Z",
  }), /before lastFullExitAt/);
});

test("candidate policy suppresses ENTER for each HTF trend-gate failure", () => {
  const cases: readonly [string, Partial<PositionGuardStructureAnalysis>, string][] = [
    ["breakdown", { breakdown1d: true }, "HTF_BREAKDOWN"],
    ["trend score", { trendAlignmentScore: 2 }, "TREND_ALIGNMENT_BELOW_3"],
    ["weakening", { weakeningStage: "SOFT" }, "WEAKENING_PRESENT"],
    ["regime", { regime: "RECLAIM_ATTEMPT" }, "REGIME_NOT_ENTRY_TREND"],
  ];

  for (const [label, changes, reason] of cases) {
    const result = evaluate({ decision: decision({ action: "ENTER" }), analysis: analysis(changes) });
    assertSuppress(result, "HTF_TREND_GATE", reason, label);
  }
});

test("candidate policy suppresses ADD for each registered ADD limit", () => {
  const cases: readonly [string, Partial<PositionGuardStructureAnalysis>, Partial<PositionGuardCandidateState>, number, number, string][] = [
    ["position at loss", { currentPrice: 99 }, {}, 0, 100, "POSITION_AT_LOSS"],
    ["episode add count", {}, { currentEpisodeAddCount: 1 }, 0.01, 99, "EPISODE_ADD_LIMIT_REACHED"],
    ["ATR shock", { atrShock: true }, {}, 0.01, 99, "ATR_SHOCK"],
    ["trend score", { trendAlignmentScore: 3 }, {}, 0.01, 99, "TREND_ALIGNMENT_BELOW_4"],
    ["recovery score", { recoveryQualityScore: 2 }, {}, 0.01, 99, "RECOVERY_QUALITY_BELOW_3"],
    ["regime", { regime: "EARLY_RECOVERY" }, {}, 0.01, 99, "REGIME_NOT_CORE_TREND"],
  ];

  for (const [label, changes, stateChanges, positionQuantity, averageEntryPrice, reason] of cases) {
    const result = evaluate({
      decision: decision({ action: "ADD" }),
      analysis: analysis(changes),
      candidateState: state(stateChanges),
      positionQuantity,
      averageEntryPrice,
    });
    assertSuppress(result, "ADD_LIMITED", reason, label);
  }
});

test("candidate policy keeps an allowed ENTER untouched and records an allowed ADD evaluation", () => {
  const enter = evaluate({ decision: decision({ action: "ENTER" }) });
  const add = evaluate({
    decision: decision({ action: "ADD" }),
    positionQuantity: 0.01,
    averageEntryPrice: 99,
  });

  assert.equal(enter.outcome, "ALLOW");
  assert.equal(enter.reason, "NO_INTERVENTION");
  assert.equal(enter.precedence, "NO_INTERVENTION");
  assert.equal(enter.effectiveAction, enter.originalAction);

  assert.equal(add.outcome, "ALLOW");
  assert.equal(add.reason, "CONDITIONS_MET");
  assert.equal(add.precedence, "ADD_LIMITED");
  assert.equal(add.effectiveAction, add.originalAction);
});

test("candidate policy omits only the selected frozen component while retaining the other controls", () => {
  const earlyFailure = evaluate({
    policyId: "COMBINED_MINUS_EARLY_THESIS_FAILURE",
    decision: decision({ action: "HOLD" }),
    positionQuantity: 0.01,
    averageEntryPrice: 100,
    analysis: analysis({
      failedReclaim: true,
      weakeningStage: "CLEAR",
      recoveryQualityScore: 1,
      currentPrice: 101,
    }),
  });
  const cooldown = evaluate({
    policyId: "COMBINED_MINUS_COOLDOWN_CONTROL",
    decision: decision({ action: "ENTER" }),
    candidateState: state({
      lastFullExitAt: "2026-08-20T00:00:00Z",
      lastFullExitRealizedPnlKrw: -1,
    }),
    generatedAt: "2026-08-20T01:00:00Z",
  });

  assert.equal(earlyFailure.outcome, "ALLOW");
  assert.equal(cooldown.outcome, "ALLOW");
  assertSuppress(evaluate({
    policyId: "COMBINED_MINUS_EARLY_THESIS_FAILURE",
    analysis: analysis({ trendAlignmentScore: 2 }),
  }), "HTF_TREND_GATE", "TREND_ALIGNMENT_BELOW_3");
  assertSuppress(evaluate({
    policyId: "COMBINED_MINUS_COOLDOWN_CONTROL",
    decision: decision({ action: "ADD" }),
    analysis: analysis({ atrShock: true }),
  }), "ADD_LIMITED", "ATR_SHOCK");
});

test("candidate policy precedence is early failure, cooldown, HTF gate, then ADD limit", () => {
  const early = evaluate({
    decision: decision({ action: "ADD" }),
    positionQuantity: 0.01,
    averageEntryPrice: 100,
    analysis: analysis({
      failedReclaim: true,
      weakeningStage: "CLEAR",
      recoveryQualityScore: 0,
      trendAlignmentScore: 0,
      atrShock: true,
      currentPrice: 101,
    }),
  });
  assertOverrideExit(early, "EARLY_THESIS_FAILURE", "FAILED_RECLAIM_THESIS");

  const cooldown = evaluate({
    decision: decision({ action: "ENTER" }),
    candidateState: state({
      lastFullExitAt: "2026-08-20T00:00:00Z",
      lastFullExitRealizedPnlKrw: -1,
    }),
    generatedAt: "2026-08-20T01:00:00Z",
    analysis: analysis({ trendAlignmentScore: 0 }),
  });
  assertSuppress(cooldown, "COOLDOWN_CONTROL", "NON_POSITIVE_EXIT_12H_COOLDOWN");

  const add = evaluate({
    decision: decision({ action: "ADD" }),
    positionQuantity: 0.01,
    averageEntryPrice: 99,
    analysis: analysis({ breakdown1d: true, atrShock: true }),
  });
  assertSuppress(add, "ADD_LIMITED", "ATR_SHOCK");
});

test("candidate policy deeply freezes detached output without mutating baseline decision or analysis", () => {
  const baseline = decision({ action: "ENTER", reasons: ["baseline"] });
  const structure = analysis();
  const result = evaluate({ decision: baseline, analysis: structure });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.effectiveDecision), true);
  assert.equal(Object.isFrozen(result.effectiveDecision.reasons), true);
  assert.equal(Object.isFrozen(result.effectiveDecision.signalQuality), true);
  assert.equal(Object.isFrozen(result.effectiveDecision.exposureGuardrails), true);
  assert.equal(Object.isFrozen(result.effectiveDecision.diagnostics), true);
  assert.deepEqual(baseline.reasons, ["baseline"]);
  assert.equal(structure.regime, "BULL_TREND");
  assert.throws(() => {
    (result.effectiveDecision.reasons as string[]).push("mutation");
  }, TypeError);
  baseline.signalQuality.score = 0;
  baseline.exposureGuardrails.remainingAssetCapacity = 0;
  baseline.diagnostics.regime = "BREAKDOWN_RISK";
  assert.equal(result.effectiveDecision.signalQuality.score, 8);
  assert.equal(result.effectiveDecision.exposureGuardrails.remainingAssetCapacity, 100_000);
  assert.equal(result.effectiveDecision.diagnostics.regime, "BULL_TREND");
});

test("candidate policy rejects unsupported IDs, invalid generated timestamps, numbers, and state", () => {
  assert.throws(() => evaluate({ policyId: "NOT_REGISTERED" as PositionGuardRegisteredCandidatePolicyId }));
  assert.throws(() => evaluate({ generatedAt: "2026-08-20T00:00:00" }));
  assert.throws(() => evaluate({ positionQuantity: Number.NaN }));
  assert.throws(() => evaluate({ averageEntryPrice: -1 }));
  assert.throws(() => evaluate({ candidateState: state({ lastFullExitAt: "2026-08-20T00:00:00Z" }) }));
});

test("candidate policy rejects malformed runtime-shaped decision and analysis values", () => {
  const malformedInputs: readonly Partial<Parameters<typeof evaluatePositionGuardCandidate>[0]>[] = [
    { decision: { ...decision(), action: "INVALID" } as unknown as PositionGuardEngineDecision },
    { decision: { ...decision(), summary: new String("wrapped") } as unknown as PositionGuardEngineDecision },
    { decision: { ...decision(), reasons: ["ok", new String("wrapped")] } as unknown as PositionGuardEngineDecision },
    { decision: { ...decision(), targetNotionalKrw: Number.NaN } },
    { decision: { ...decision(), executionDisposition: "INVALID" } as unknown as PositionGuardEngineDecision },
    { decision: { ...decision(), signalQuality: null } as unknown as PositionGuardEngineDecision },
    { decision: { ...decision(), signalQuality: { ...decision().signalQuality, score: Number.NaN } } },
    { decision: { ...decision(), exposureGuardrails: { ...decision().exposureGuardrails, remainingAssetCapacity: Number.NaN } } },
    { decision: { ...decision(), diagnostics: { ...decision().diagnostics, pullbackZone: "true" } } as unknown as PositionGuardEngineDecision },
    { analysis: null as unknown as PositionGuardStructureAnalysis },
    { analysis: { ...analysis(), currentPrice: Number.NaN } },
    { analysis: { ...analysis(), regime: "INVALID" } as unknown as PositionGuardStructureAnalysis },
    { analysis: { ...analysis(), bearishMomentumExpansion: "false" } as unknown as PositionGuardStructureAnalysis },
    { analysis: { ...analysis(), oneHourLocation: "INVALID" } as unknown as PositionGuardStructureAnalysis },
  ];

  for (const input of malformedInputs) {
    assert.throws(() => evaluate(input), /candidate (decision|analysis)/i);
  }
});

function evaluate(overrides: Partial<Parameters<typeof evaluatePositionGuardCandidate>[0]> = {}) {
  return evaluatePositionGuardCandidate({
    policyId: "COMBINED_CONSERVATIVE",
    generatedAt: "2026-08-20T12:00:00Z",
    decision: decision({ action: "ENTER" }),
    positionQuantity: 0,
    averageEntryPrice: 0,
    candidateState: state(),
    analysis: analysis(),
    ...overrides,
  });
}

function assertSuppress(
  result: ReturnType<typeof evaluate>,
  precedence: string,
  reason: string,
  label?: string,
): void {
  assert.equal(result.outcome, "SUPPRESS", label);
  assert.equal(result.precedence, precedence, label);
  assert.equal(result.reason, reason, label);
  assert.equal(result.effectiveAction, "HOLD", label);
  assert.equal(result.effectiveDecision.targetNotionalKrw, 0, label);
  assert.equal(result.effectiveDecision.targetQuantityFraction, null, label);
  assert.equal(result.effectiveDecision.executionDisposition, "SKIPPED", label);
}

function assertOverrideExit(
  result: ReturnType<typeof evaluate>,
  precedence: string,
  reason: string,
): void {
  assert.equal(result.outcome, "OVERRIDE_EXIT");
  assert.equal(result.precedence, precedence);
  assert.equal(result.reason, reason);
  assert.equal(result.effectiveAction, "EXIT");
  assert.equal(result.effectiveDecision.targetNotionalKrw, 0);
  assert.equal(result.effectiveDecision.targetQuantityFraction, 1);
  assert.equal(result.effectiveDecision.executionDisposition, "IMMEDIATE");
}

function decision(overrides: Partial<PositionGuardEngineDecision> = {}): PositionGuardEngineDecision {
  return {
    action: "ENTER",
    summary: "Synthetic baseline decision.",
    reasons: ["Synthetic baseline reason."],
    targetNotionalKrw: 10_000,
    targetQuantityFraction: null,
    referencePrice: 100,
    executionDisposition: "IMMEDIATE",
    signalQuality: {
      score: 8,
      bucket: "HIGH",
      confirmationRequired: false,
      confirmationSatisfied: true,
      reentryPenaltyApplied: false,
    },
    exposureGuardrails: {
      perAssetMaxAllocation: 0.45,
      totalPortfolioMaxExposure: 0.75,
      remainingAssetCapacity: 100_000,
      remainingPortfolioCapacity: 100_000,
    },
    diagnostics: {
      regime: "BULL_TREND",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: null,
      entryPath: "PULLBACK",
      trendAlignmentScore: 4,
      recoveryQualityScore: 3,
      breakdownPressureScore: 0,
      weakeningStage: "NONE",
      upperRangeChase: false,
      pullbackZone: true,
      reclaimStructure: false,
      breakoutHoldStructure: false,
    },
    ...overrides,
  };
}

function analysis(overrides: Partial<PositionGuardStructureAnalysis> = {}): PositionGuardStructureAnalysis {
  return {
    regime: "BULL_TREND",
    riskLevel: "LOW",
    invalidationState: "CLEAR",
    invalidationLevel: null,
    pullbackZone: true,
    reclaimStructure: false,
    breakoutHoldStructure: false,
    upperRangeChase: false,
    currentPrice: 100,
    entryPath: "PULLBACK",
    trendAlignmentScore: 4,
    recoveryQualityScore: 3,
    breakdownPressureScore: 0,
    weakeningStage: "NONE",
    breakdown1d: false,
    breakdown4h: false,
    failedReclaim: false,
    bearishMomentumExpansion: false,
    volumeRecovery: true,
    macdImproving: true,
    rsiRecovery: true,
    atrShock: false,
    averageEntryPrice: 0,
    pnlPct: 0,
    ...overrides,
  };
}

function state(overrides: Partial<PositionGuardCandidateState> = {}): PositionGuardCandidateState {
  const result: PositionGuardCandidateState = {
    currentEpisodeAddCount: 0,
    currentEpisodeCostBasisKrw: 0,
    currentEpisodeInventoryQuantity: 0,
    currentEpisodeRealizedPnlKrw: 0,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: null,
    lastEvidenceId: null,
    stateVersion: 0,
    ...overrides,
  };
  if (result.currentEpisodeAddCount > 0) {
    result.currentEpisodeInventoryQuantity = result.currentEpisodeInventoryQuantity || 0.01;
    result.currentEpisodeCostBasisKrw = result.currentEpisodeCostBasisKrw || 100;
    result.lastEntryPath ??= "PULLBACK";
    result.lastEvidenceAt ??= "2026-01-01T00:00:00Z";
    result.lastEvidenceId ??= "fixture-open-evidence";
  }
  if (result.lastFullExitAt !== null) {
    result.lastEvidenceAt ??= result.lastFullExitAt;
    result.lastEvidenceId ??= "fixture-full-exit";
  }
  result.stateVersion = Math.max(result.stateVersion, minimumReachableStateVersion(result));
  return result;
}

function minimumReachableStateVersion(state: PositionGuardCandidateState): number {
  let minimum = state.lastFullExitAt === null ? 0 : 2;
  if (state.currentEpisodeInventoryQuantity > 1e-12) {
    minimum += 1 + state.currentEpisodeAddCount;
    if (state.currentEpisodeRealizedPnlKrw !== 0) minimum += 1;
  }
  return minimum;
}
