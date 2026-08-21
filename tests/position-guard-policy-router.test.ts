import assert from "node:assert/strict";
import {
  routePositionGuardPolicy,
  type PositionGuardPolicyRouteInput,
} from "../src/modules/strategy/position-guard-policy-router.js";
import type { PositionGuardPolicySelection } from "../src/domain/pilot-types.js";
import type { PositionGuardCandidateState } from "../src/modules/strategy/position-guard-candidate-state.js";
import type {
  PositionGuardEngineDecision,
  PositionGuardStructureAnalysis,
} from "../src/modules/strategy/position-guard-core.js";
import { test } from "./harness.js";

test("ETH is baseline for every pilot phase", () => {
  for (const pilotPhase of ["DISABLED", "PENDING_FLAT", "ACTIVE", "PAUSED_FAULT", "DRAINING"] as const) {
    const result = routePositionGuardPolicy(routeInput({
      market: "KRW-ETH",
      pilotPhase,
      baselineAction: "ADD",
    }));

    assert.equal(result.effectiveDecision.action, "ADD");
    assert.equal(result.reasonCode, "ETH_BASELINE");
    assert.equal(result.selection, "BASELINE");
    assert.equal(result.candidateEvaluation, null);
    assert.equal(result.executionBlocked, false);
  }
});

test("baseline selection remains baseline for BTC regardless of persisted phase", () => {
  const result = routePositionGuardPolicy(routeInput({
    selection: baselineSelection(),
    pilotPhase: "ACTIVE",
    baselineAction: "ENTER",
  }));

  assert.equal(result.effectiveDecision.action, "ENTER");
  assert.equal(result.reasonCode, "BASELINE_SELECTION");
  assert.equal(result.selection, "BASELINE");
  assert.equal(result.candidateEvaluation, null);
  assert.equal(result.stateVersion, null);
});

test("pending-flat and draining suppress new BTC risk without changing risk reduction", () => {
  const pendingEntry = routePositionGuardPolicy(routeInput({
    pilotPhase: "PENDING_FLAT",
    baselineAction: "ENTER",
  }));
  const drainingAdd = routePositionGuardPolicy(routeInput({
    pilotPhase: "DRAINING",
    baselineAction: "ADD",
  }));
  const pendingReduce = routePositionGuardPolicy(routeInput({
    pilotPhase: "PENDING_FLAT",
    baselineAction: "REDUCE",
  }));
  const drainingExit = routePositionGuardPolicy(routeInput({
    pilotPhase: "DRAINING",
    baselineAction: "EXIT",
  }));

  assert.deepEqual(
    [pendingEntry.effectiveDecision.action, pendingEntry.reasonCode],
    ["HOLD", "PENDING_FLAT_NEW_RISK_SUPPRESSED"],
  );
  assert.deepEqual(
    [drainingAdd.effectiveDecision.action, drainingAdd.reasonCode],
    ["HOLD", "DRAINING_NEW_RISK_SUPPRESSED"],
  );
  assert.deepEqual(
    [pendingReduce.effectiveDecision.action, pendingReduce.reasonCode],
    ["REDUCE", "PENDING_FLAT_RISK_REDUCTION_PRESERVED"],
  );
  assert.deepEqual(
    [drainingExit.effectiveDecision.action, drainingExit.reasonCode],
    ["EXIT", "DRAINING_RISK_REDUCTION_PRESERVED"],
  );
});

test("pending-flat and draining preserve a baseline BTC hold", () => {
  for (const pilotPhase of ["PENDING_FLAT", "DRAINING"] as const) {
    const input = routeInput({ pilotPhase, baselineAction: "HOLD" });
    const result = routePositionGuardPolicy(input);

    assert.equal(result.effectiveDecision, input.baselineDecision);
  }
});

test("active candidate uses combined conservative and preserves allowed baseline sizing", () => {
  const allowed = routePositionGuardPolicy(routeInput({
    pilotPhase: "ACTIVE",
    baselineAction: "ENTER",
  }));
  const earlyFailure = routePositionGuardPolicy(routeInput({
    pilotPhase: "ACTIVE",
    baselineAction: "ADD",
    positionQuantity: 0.01,
    averageEntryPrice: 120_000,
    analysis: analysis({
      currentPrice: 100_000,
      failedReclaim: true,
      weakeningStage: "CLEAR",
      recoveryQualityScore: 1,
    }),
  }));

  assert.equal(allowed.selection, "BTC_COMBINED_CONSERVATIVE_PILOT_V1");
  assert.equal(allowed.candidateEvaluation?.policyId, "COMBINED_CONSERVATIVE");
  assert.equal(allowed.candidateEvaluation?.outcome, "ALLOW");
  assert.equal(allowed.effectiveDecision.targetNotionalKrw, allowed.baselineDecision.targetNotionalKrw);
  assert.equal(allowed.effectiveDecision.targetQuantityFraction, allowed.baselineDecision.targetQuantityFraction);
  assert.deepEqual(
    [earlyFailure.candidateEvaluation?.outcome, earlyFailure.effectiveDecision.action, earlyFailure.reasonCode],
    ["OVERRIDE_EXIT", "EXIT", "CANDIDATE_EARLY_THESIS_FAILURE"],
  );
});

test("paused fault returns an explicit non-order-convertible BTC route", () => {
  const result = routePositionGuardPolicy(routeInput({
    pilotPhase: "PAUSED_FAULT",
    baselineAction: "ENTER",
  }));

  assert.equal(result.executionBlocked, true);
  assert.equal(result.reasonCode, "PAUSED_FAULT_BLOCKED");
  assert.equal(result.effectiveDecision.action, "HOLD");
  assert.equal(result.effectiveDecision.executionDisposition, "SKIPPED");
  assert.equal(result.effectiveDecision.targetNotionalKrw, 0);
  assert.equal(result.effectiveDecision.targetQuantityFraction, null);
  assert.equal(result.candidateEvaluation, null);
});

test("active BTC routing fails closed when no persisted candidate state is available", () => {
  assert.throws(
    () => routePositionGuardPolicy(routeInput({ pilotPhase: "ACTIVE", candidateState: null })),
    /candidate state/i,
  );
});

function routeInput(overrides: {
  market?: "KRW-BTC" | "KRW-ETH";
  pilotPhase?: "DISABLED" | "PENDING_FLAT" | "ACTIVE" | "PAUSED_FAULT" | "DRAINING";
  baselineAction?: PositionGuardEngineDecision["action"];
  selection?: PositionGuardPolicySelection;
  candidateState?: PositionGuardCandidateState | null;
  positionQuantity?: number;
  averageEntryPrice?: number;
  analysis?: PositionGuardStructureAnalysis;
} = {}): PositionGuardPolicyRouteInput {
  return {
    market: overrides.market ?? "KRW-BTC",
    generatedAt: "2026-08-21T05:00:00.000Z",
    baselineDecision: decision({ action: overrides.baselineAction ?? "ENTER" }),
    selection: overrides.selection ?? candidateSelection(),
    pilotPhase: overrides.pilotPhase ?? "ACTIVE",
    candidateState: overrides.candidateState === undefined ? candidateState() : overrides.candidateState,
    positionQuantity: overrides.positionQuantity ?? 0,
    averageEntryPrice: overrides.averageEntryPrice ?? 0,
    analysis: overrides.analysis ?? analysis(),
  };
}

function baselineSelection(): PositionGuardPolicySelection {
  return { kind: "BASELINE", pilotId: null };
}

function candidateSelection(): PositionGuardPolicySelection {
  return {
    kind: "BTC_CANDIDATE_PILOT",
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    liveOperatorConfirmed: true,
  };
}

function candidateState(): PositionGuardCandidateState {
  return {
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
  };
}

function decision(overrides: Partial<PositionGuardEngineDecision> = {}): PositionGuardEngineDecision {
  return {
    action: "ENTER",
    summary: "Synthetic baseline decision.",
    reasons: ["Synthetic baseline reason."],
    targetNotionalKrw: 123_456.789,
    targetQuantityFraction: 0.3,
    referencePrice: 100_000,
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
      remainingAssetCapacity: 200_000,
      remainingPortfolioCapacity: 200_000,
    },
    diagnostics: {
      regime: "BULL_TREND",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: null,
      entryPath: "PULLBACK",
      trendAlignmentScore: 4,
      recoveryQualityScore: 4,
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
    currentPrice: 100_000,
    entryPath: "PULLBACK",
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
    atrShock: false,
    averageEntryPrice: 0,
    pnlPct: 0,
    ...overrides,
  };
}
