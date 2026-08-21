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

interface PositionGuardPolicyRouteResultBase {
  baselineDecision: Readonly<PositionGuardEngineDecision>;
  effectiveDecision: Readonly<PositionGuardEngineDecision>;
  selection: "BASELINE" | "BTC_COMBINED_CONSERVATIVE_PILOT_V1";
  pilotPhase: PositionGuardPilotPhase;
  candidateEvaluation: Readonly<PositionGuardCandidateEvaluation> | null;
  reasonCode: PositionGuardPolicyRouteReason;
  stateVersion: number | null;
}

export type PositionGuardPolicyRouteResult =
  | Readonly<PositionGuardPolicyRouteResultBase & {
      executionBlocked: false;
      executionDecision: Readonly<PositionGuardEngineDecision>;
    }>
  | Readonly<PositionGuardPolicyRouteResultBase & {
      executionBlocked: true;
      executionDecision: null;
    }>;

const BASELINE_SELECTION_KEYS = ["kind", "pilotId"] as const;
const CANDIDATE_SELECTION_KEYS = [
  "kind",
  "pilotId",
  "market",
  "policyId",
  "policyVersion",
  "liveOperatorConfirmed",
] as const;

export function routePositionGuardPolicy(
  input: Readonly<PositionGuardPolicyRouteInput>,
): Readonly<PositionGuardPolicyRouteResult> {
  const selection = validatePositionGuardPolicySelection(input.selection);
  const routedInput: PositionGuardPolicyRouteInput = {
    ...input,
    selection,
    baselineDecision: freezeDecision(input.baselineDecision),
  };

  if (routedInput.market !== "KRW-BTC" && routedInput.market !== "KRW-ETH") {
    throw new Error(`Unsupported PositionGuard route market ${String(routedInput.market)}.`);
  }

  if (selection.kind === "BASELINE") {
    return baselineRoute(routedInput, "BASELINE_SELECTION");
  }

  if (routedInput.market === "KRW-ETH") {
    return baselineRoute(routedInput, "ETH_BASELINE");
  }

  switch (routedInput.pilotPhase) {
    case "DISABLED":
      return baselineRoute(routedInput, "PILOT_DISABLED");
    case "PENDING_FLAT":
      return phaseGateRoute(routedInput, "PENDING_FLAT");
    case "DRAINING":
      return phaseGateRoute(routedInput, "DRAINING");
    case "PAUSED_FAULT":
      return blockedRoute(routedInput);
    case "ACTIVE":
      return activeCandidateRoute(routedInput);
    default:
      throw new Error(`Unsupported PositionGuard pilot phase ${String(routedInput.pilotPhase)}.`);
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
  executionBlocked: false | true;
}): Readonly<PositionGuardPolicyRouteResult> {
  const route = {
    baselineDecision: input.input.baselineDecision,
    effectiveDecision: freezeDecision(input.effectiveDecision),
    selection: input.selection,
    pilotPhase: input.input.pilotPhase,
    candidateEvaluation: input.candidateEvaluation,
    reasonCode: input.reasonCode,
    stateVersion: input.stateVersion,
  };
  if (input.executionBlocked) {
    return Object.freeze({
      ...route,
      executionBlocked: true,
      executionDecision: null,
    });
  }
  return Object.freeze({
    ...route,
    executionBlocked: false,
    executionDecision: freezeDecision(input.effectiveDecision),
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

function validatePositionGuardPolicySelection(selection: unknown): PositionGuardPolicySelection {
  const baseline = exactSelectionProperties(selection, BASELINE_SELECTION_KEYS);
  if (baseline !== null) {
    if (baseline.kind === "BASELINE" && baseline.pilotId === null) {
      return Object.freeze({ kind: "BASELINE", pilotId: null });
    }
    throw new Error("Invalid PositionGuard policy selection.");
  }

  const candidate = exactSelectionProperties(selection, CANDIDATE_SELECTION_KEYS);
  if (candidate !== null) {
    if (
      candidate.kind === "BTC_CANDIDATE_PILOT"
      && candidate.pilotId === "BTC_COMBINED_CONSERVATIVE_PILOT_V1"
      && candidate.market === "KRW-BTC"
      && candidate.policyId === "COMBINED_CONSERVATIVE"
      && candidate.policyVersion === "PCS-2026-001.DEPLOYMENT_READINESS_V1"
      && candidate.liveOperatorConfirmed === true
    ) {
      return Object.freeze({
        kind: "BTC_CANDIDATE_PILOT",
        pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
        market: "KRW-BTC",
        policyId: "COMBINED_CONSERVATIVE",
        policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
        liveOperatorConfirmed: true,
      });
    }
    throw new Error("Invalid PositionGuard policy selection.");
  }

  throw new Error("Invalid PositionGuard policy selection.");
}

function exactSelectionProperties(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== Object.prototype) return null;

  const names = Object.getOwnPropertyNames(value);
  if (
    Object.getOwnPropertySymbols(value).length > 0
    || names.length !== keys.length
    || names.some((name) => !keys.includes(name))
  ) {
    return null;
  }

  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function freezeDecision(
  decision: Readonly<PositionGuardEngineDecision>,
): Readonly<PositionGuardEngineDecision> {
  const copy: PositionGuardEngineDecision = {
    ...decision,
    reasons: [...decision.reasons],
    signalQuality: { ...decision.signalQuality },
    exposureGuardrails: { ...decision.exposureGuardrails },
    diagnostics: { ...decision.diagnostics },
  };
  Object.freeze(copy.reasons);
  Object.freeze(copy.signalQuality);
  Object.freeze(copy.exposureGuardrails);
  Object.freeze(copy.diagnostics);
  return Object.freeze(copy);
}
