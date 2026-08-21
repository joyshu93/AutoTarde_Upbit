import type {
  PositionGuardPilotPhase,
  PositionGuardPolicySelection,
} from "../../domain/pilot-types.js";
import type { SupportedMarket } from "../../domain/types.js";
import {
  evaluatePositionGuardCandidate,
  type PositionGuardCandidateEvaluation,
} from "./position-guard-candidate-policy.js";
import type { PositionGuardCandidateState } from "./position-guard-candidate-state.js";
import type {
  PositionGuardEngineDecision,
  PositionGuardStructureAnalysis,
} from "./position-guard-core.js";

export type PositionGuardPolicyRouteReason =
  | "BASELINE_SELECTION"
  | "ETH_BASELINE"
  | "PILOT_DISABLED"
  | "PENDING_FLAT_NEW_RISK_SUPPRESSED"
  | "PENDING_FLAT_RISK_REDUCTION_PRESERVED"
  | "PENDING_FLAT_BASELINE_HOLD_PRESERVED"
  | "DRAINING_NEW_RISK_SUPPRESSED"
  | "DRAINING_RISK_REDUCTION_PRESERVED"
  | "DRAINING_BASELINE_HOLD_PRESERVED"
  | "PAUSED_FAULT_BLOCKED"
  | "CANDIDATE_ALLOWED"
  | "CANDIDATE_SUPPRESSED"
  | "CANDIDATE_EARLY_THESIS_FAILURE";

export interface PositionGuardPolicyRouteInput {
  market: SupportedMarket;
  generatedAt: string;
  baselineDecision: Readonly<PositionGuardEngineDecision>;
  selection: Readonly<PositionGuardPolicySelection>;
  pilotPhase: PositionGuardPilotPhase;
  candidateState: Readonly<PositionGuardCandidateState> | null;
  positionQuantity: number;
  averageEntryPrice: number;
  analysis: Readonly<PositionGuardStructureAnalysis>;
}

export interface PositionGuardPolicyRouteResult {
  baselineDecision: Readonly<PositionGuardEngineDecision>;
  effectiveDecision: Readonly<PositionGuardEngineDecision>;
  selection: "BASELINE" | "BTC_COMBINED_CONSERVATIVE_PILOT_V1";
  pilotPhase: PositionGuardPilotPhase;
  candidateEvaluation: Readonly<PositionGuardCandidateEvaluation> | null;
  reasonCode: PositionGuardPolicyRouteReason;
  stateVersion: number | null;
  executionBlocked: boolean;
}

export function routePositionGuardPolicy(
  input: Readonly<PositionGuardPolicyRouteInput>,
): Readonly<PositionGuardPolicyRouteResult> {
  if (input.selection.kind === "BASELINE") {
    return baselineRoute(input, "BASELINE_SELECTION");
  }

  if (input.market === "KRW-ETH") {
    return baselineRoute(input, "ETH_BASELINE");
  }

  switch (input.pilotPhase) {
    case "DISABLED":
      return baselineRoute(input, "PILOT_DISABLED");
    case "PENDING_FLAT":
      return phaseGateRoute(input, "PENDING_FLAT");
    case "DRAINING":
      return phaseGateRoute(input, "DRAINING");
    case "PAUSED_FAULT":
      return blockedRoute(input);
    case "ACTIVE":
      return activeCandidateRoute(input);
    default:
      throw new Error(`Unsupported PositionGuard pilot phase ${String(input.pilotPhase)}.`);
  }
}

function baselineRoute(
  input: Readonly<PositionGuardPolicyRouteInput>,
  reasonCode: Extract<PositionGuardPolicyRouteReason, "BASELINE_SELECTION" | "ETH_BASELINE" | "PILOT_DISABLED">,
): Readonly<PositionGuardPolicyRouteResult> {
  return routeResult({
    input,
    effectiveDecision: input.baselineDecision,
    selection: "BASELINE",
    candidateEvaluation: null,
    reasonCode,
    stateVersion: null,
    executionBlocked: false,
  });
}

function phaseGateRoute(
  input: Readonly<PositionGuardPolicyRouteInput>,
  phase: "PENDING_FLAT" | "DRAINING",
): Readonly<PositionGuardPolicyRouteResult> {
  if (input.baselineDecision.action === "HOLD") {
    return routeResult({
      input,
      effectiveDecision: input.baselineDecision,
      selection: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      candidateEvaluation: null,
      reasonCode: phase === "PENDING_FLAT"
        ? "PENDING_FLAT_BASELINE_HOLD_PRESERVED"
        : "DRAINING_BASELINE_HOLD_PRESERVED",
      stateVersion: input.candidateState?.stateVersion ?? null,
      executionBlocked: false,
    });
  }

  if (isRiskReducing(input.baselineDecision)) {
    return routeResult({
      input,
      effectiveDecision: input.baselineDecision,
      selection: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      candidateEvaluation: null,
      reasonCode: phase === "PENDING_FLAT"
        ? "PENDING_FLAT_RISK_REDUCTION_PRESERVED"
        : "DRAINING_RISK_REDUCTION_PRESERVED",
      stateVersion: input.candidateState?.stateVersion ?? null,
      executionBlocked: false,
    });
  }

  return routeResult({
    input,
    effectiveDecision: suppressedDecision(input.baselineDecision, `${phase}_NEW_RISK_SUPPRESSED`),
    selection: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    candidateEvaluation: null,
    reasonCode: phase === "PENDING_FLAT"
      ? "PENDING_FLAT_NEW_RISK_SUPPRESSED"
      : "DRAINING_NEW_RISK_SUPPRESSED",
    stateVersion: input.candidateState?.stateVersion ?? null,
    executionBlocked: false,
  });
}

function blockedRoute(
  input: Readonly<PositionGuardPolicyRouteInput>,
): Readonly<PositionGuardPolicyRouteResult> {
  return routeResult({
    input,
    effectiveDecision: suppressedDecision(input.baselineDecision, "PAUSED_FAULT_BLOCKED"),
    selection: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    candidateEvaluation: null,
    reasonCode: "PAUSED_FAULT_BLOCKED",
    stateVersion: input.candidateState?.stateVersion ?? null,
    executionBlocked: true,
  });
}

function activeCandidateRoute(
  input: Readonly<PositionGuardPolicyRouteInput>,
): Readonly<PositionGuardPolicyRouteResult> {
  if (input.candidateState === null) {
    throw new Error("An ACTIVE PositionGuard pilot requires persisted candidate state.");
  }

  const candidateEvaluation = evaluatePositionGuardCandidate({
    policyId: "COMBINED_CONSERVATIVE",
    generatedAt: input.generatedAt,
    decision: input.baselineDecision,
    positionQuantity: input.positionQuantity,
    averageEntryPrice: input.averageEntryPrice,
    candidateState: input.candidateState,
    analysis: input.analysis,
  });

  return routeResult({
    input,
    effectiveDecision: candidateEvaluation.effectiveDecision,
    selection: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    candidateEvaluation,
    reasonCode: candidateReasonCode(candidateEvaluation),
    stateVersion: input.candidateState.stateVersion,
    executionBlocked: false,
  });
}

function routeResult(input: {
  input: Readonly<PositionGuardPolicyRouteInput>;
  effectiveDecision: Readonly<PositionGuardEngineDecision>;
  selection: PositionGuardPolicyRouteResult["selection"];
  candidateEvaluation: Readonly<PositionGuardCandidateEvaluation> | null;
  reasonCode: PositionGuardPolicyRouteReason;
  stateVersion: number | null;
  executionBlocked: boolean;
}): Readonly<PositionGuardPolicyRouteResult> {
  return Object.freeze({
    baselineDecision: input.input.baselineDecision,
    effectiveDecision: input.effectiveDecision,
    selection: input.selection,
    pilotPhase: input.input.pilotPhase,
    candidateEvaluation: input.candidateEvaluation,
    reasonCode: input.reasonCode,
    stateVersion: input.stateVersion,
    executionBlocked: input.executionBlocked,
  });
}

function isRiskReducing(decision: Readonly<PositionGuardEngineDecision>): boolean {
  return decision.action === "REDUCE" || decision.action === "EXIT";
}

function candidateReasonCode(
  evaluation: Readonly<PositionGuardCandidateEvaluation>,
): Extract<
  PositionGuardPolicyRouteReason,
  "CANDIDATE_ALLOWED" | "CANDIDATE_SUPPRESSED" | "CANDIDATE_EARLY_THESIS_FAILURE"
> {
  if (evaluation.outcome === "OVERRIDE_EXIT") return "CANDIDATE_EARLY_THESIS_FAILURE";
  return evaluation.outcome === "SUPPRESS" ? "CANDIDATE_SUPPRESSED" : "CANDIDATE_ALLOWED";
}

function suppressedDecision(
  decision: Readonly<PositionGuardEngineDecision>,
  reasonCode: string,
): Readonly<PositionGuardEngineDecision> {
  return Object.freeze({
    ...decision,
    action: "HOLD",
    summary: `PositionGuard route suppressed ${decision.action} because ${reasonCode}.`,
    reasons: [reasonCode],
    targetNotionalKrw: 0,
    targetQuantityFraction: null,
    executionDisposition: "SKIPPED",
  });
}
