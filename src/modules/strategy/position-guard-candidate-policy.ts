import type { StrategyDecisionAction } from "../../domain/types.js";
import {
  parsePositionGuardCandidateTimestamp,
  validatePositionGuardCandidateState,
  type PositionGuardCandidateState,
} from "./position-guard-candidate-state.js";
import type {
  PositionGuardEngineDecision,
  PositionGuardStructureAnalysis,
  StrategyMarketRegime,
} from "./position-guard-core.js";

export const POSITION_GUARD_CANDIDATE_POLICY_VERSION =
  "PCS-2026-001.DEPLOYMENT_READINESS_V1" as const;

export const POSITION_GUARD_REGISTERED_CANDIDATE_POLICY_IDS = [
  "COMBINED_CONSERVATIVE",
  "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  "COMBINED_MINUS_COOLDOWN_CONTROL",
] as const;

export type PositionGuardRegisteredCandidatePolicyId =
  typeof POSITION_GUARD_REGISTERED_CANDIDATE_POLICY_IDS[number];

export type PositionGuardCandidateOutcome = "ALLOW" | "SUPPRESS" | "OVERRIDE_EXIT";
export type PositionGuardCandidatePrecedence =
  | "PRESERVE_RISK_REDUCTION"
  | "EARLY_THESIS_FAILURE"
  | "COOLDOWN_CONTROL"
  | "HTF_TREND_GATE"
  | "ADD_LIMITED"
  | "NO_INTERVENTION";
export type PositionGuardCandidateReason =
  | "CONDITIONS_MET"
  | "RISK_REDUCING_DECISION_PRESERVED"
  | "FAILED_RECLAIM_THESIS"
  | "BEARISH_LOSS_THESIS"
  | "NON_POSITIVE_EXIT_12H_COOLDOWN"
  | "SAME_ENTRY_PATH_24H_COOLDOWN"
  | "HTF_BREAKDOWN"
  | "TREND_ALIGNMENT_BELOW_3"
  | "WEAKENING_PRESENT"
  | "REGIME_NOT_ENTRY_TREND"
  | "POSITION_AT_LOSS"
  | "EPISODE_ADD_LIMIT_REACHED"
  | "ATR_SHOCK"
  | "TREND_ALIGNMENT_BELOW_4"
  | "RECOVERY_QUALITY_BELOW_3"
  | "REGIME_NOT_CORE_TREND"
  | "NO_INTERVENTION";

export interface PositionGuardCandidateEvaluation {
  policyId: PositionGuardRegisteredCandidatePolicyId;
  policyVersion: typeof POSITION_GUARD_CANDIDATE_POLICY_VERSION;
  generatedAt: string;
  originalAction: StrategyDecisionAction;
  effectiveAction: StrategyDecisionAction;
  outcome: PositionGuardCandidateOutcome;
  reason: PositionGuardCandidateReason;
  precedence: PositionGuardCandidatePrecedence;
  effectiveDecision: Readonly<PositionGuardEngineDecision>;
}

type PositionGuardCandidateComponent =
  | "HTF_TREND_GATE"
  | "EARLY_THESIS_FAILURE"
  | "ADD_LIMITED"
  | "COOLDOWN_CONTROL";

const POSITION_GUARD_CANDIDATE_AUTHORITY = Object.freeze({
  quantityTolerance: 1e-12,
  htf: Object.freeze({
    minimumTrendAlignmentScore: 3,
    allowedRegimes: Object.freeze([
      "BULL_TREND",
      "PULLBACK_IN_UPTREND",
      "EARLY_RECOVERY",
    ] as const),
  }),
  earlyFailure: Object.freeze({
    maximumFailedReclaimRecoveryQualityScore: 1,
    minimumBearishBreakdownPressureScore: 2,
  }),
  add: Object.freeze({
    maxAddsPerEpisode: 1,
    minimumTrendAlignmentScore: 4,
    minimumRecoveryQualityScore: 3,
    allowedRegimes: Object.freeze([
      "BULL_TREND",
      "PULLBACK_IN_UPTREND",
    ] as const),
  }),
  cooldown: Object.freeze({
    nonPositiveExitHours: 12,
    sameEntryPathHours: 24,
  }),
});

const POLICY_COMPONENTS: Readonly<Record<
  PositionGuardRegisteredCandidatePolicyId,
  readonly PositionGuardCandidateComponent[]
>> = Object.freeze({
  COMBINED_CONSERVATIVE: Object.freeze([
    "HTF_TREND_GATE",
    "EARLY_THESIS_FAILURE",
    "ADD_LIMITED",
    "COOLDOWN_CONTROL",
  ] as const),
  COMBINED_MINUS_EARLY_THESIS_FAILURE: Object.freeze([
    "HTF_TREND_GATE",
    "ADD_LIMITED",
    "COOLDOWN_CONTROL",
  ] as const),
  COMBINED_MINUS_COOLDOWN_CONTROL: Object.freeze([
    "HTF_TREND_GATE",
    "EARLY_THESIS_FAILURE",
    "ADD_LIMITED",
  ] as const),
});

const NANOSECONDS_PER_HOUR = 3_600_000_000_000n;
const STRATEGY_DECISION_ACTIONS = ["ENTER", "ADD", "REDUCE", "EXIT", "HOLD"] as const;
const EXECUTION_DISPOSITIONS = ["IMMEDIATE", "DEFERRED_CONFIRMATION", "EXECUTED_AFTER_CONFIRMATION", "SKIPPED"] as const;
const SIGNAL_QUALITY_BUCKETS = ["HIGH", "MEDIUM", "BORDERLINE", "LOW"] as const;
const MARKET_REGIMES = ["BULL_TREND", "PULLBACK_IN_UPTREND", "EARLY_RECOVERY", "RECLAIM_ATTEMPT", "RANGE", "WEAK_DOWNTREND", "BREAKDOWN_RISK"] as const;
const RISK_LEVELS = ["LOW", "MODERATE", "ELEVATED", "HIGH"] as const;
const INVALIDATION_STATES = ["CLEAR", "UNCLEAR", "BROKEN"] as const;
const ENTRY_PATHS = ["PULLBACK", "RECLAIM", "BREAKOUT_HOLD", "NONE"] as const;
const WEAKENING_STAGES = ["NONE", "SOFT", "CLEAR", "FAILURE"] as const;
const STRUCTURE_LOCATIONS = ["LOWER", "MIDDLE", "UPPER"] as const;

export function evaluatePositionGuardCandidate(input: {
  policyId: PositionGuardRegisteredCandidatePolicyId;
  generatedAt: string;
  decision: PositionGuardEngineDecision;
  positionQuantity: number;
  averageEntryPrice: number;
  candidateState: PositionGuardCandidateState;
  analysis: PositionGuardStructureAnalysis;
}): Readonly<PositionGuardCandidateEvaluation> {
  validateInput(input);

  const originalAction = input.decision.action;
  if (originalAction === "EXIT" || originalAction === "REDUCE") {
    return evaluation(input, "ALLOW", "RISK_REDUCING_DECISION_PRESERVED", "PRESERVE_RISK_REDUCTION", input.decision);
  }

  const components = POLICY_COMPONENTS[input.policyId];
  if (hasComponent(components, "EARLY_THESIS_FAILURE")) {
    const earlyFailure = getEarlyFailureReason(input);
    if (earlyFailure !== null) {
      return evaluation(
        input,
        "OVERRIDE_EXIT",
        earlyFailure,
        "EARLY_THESIS_FAILURE",
        exitDecision(input.decision, earlyFailure),
      );
    }
  }

  if (hasComponent(components, "COOLDOWN_CONTROL")) {
    const cooldown = getCooldownReason(input);
    if (cooldown !== null) {
      return evaluation(
        input,
        "SUPPRESS",
        cooldown,
        "COOLDOWN_CONTROL",
        holdDecision(input.decision, cooldown),
      );
    }
  }

  if (hasComponent(components, "HTF_TREND_GATE")) {
    const htf = getHtfTrendGateReason(input);
    if (htf !== null) {
      return evaluation(input, "SUPPRESS", htf, "HTF_TREND_GATE", holdDecision(input.decision, htf));
    }
  }

  if (hasComponent(components, "ADD_LIMITED")) {
    const add = getAddLimitReason(input);
    if (add !== null) {
      return evaluation(input, "SUPPRESS", add, "ADD_LIMITED", holdDecision(input.decision, add));
    }
    if (originalAction === "ADD") {
      return evaluation(input, "ALLOW", "CONDITIONS_MET", "ADD_LIMITED", input.decision);
    }
  }

  return evaluation(input, "ALLOW", "NO_INTERVENTION", "NO_INTERVENTION", input.decision);
}

function validateInput(input: Parameters<typeof evaluatePositionGuardCandidate>[0]): void {
  if (!isRecord(input)) throw new Error("PositionGuard candidate input must be an object.");
  if (!POSITION_GUARD_REGISTERED_CANDIDATE_POLICY_IDS.includes(input.policyId)) {
    throw new Error(`Unsupported PositionGuard candidate policy ID ${String(input.policyId)}.`);
  }
  parsePositionGuardCandidateTimestamp(input.generatedAt, "generatedAt");
  if (!Number.isFinite(input.positionQuantity) || input.positionQuantity < 0) {
    throw new Error("PositionGuard candidate positionQuantity must be finite and non-negative.");
  }
  if (!Number.isFinite(input.averageEntryPrice) || input.averageEntryPrice < 0) {
    throw new Error("PositionGuard candidate averageEntryPrice must be finite and non-negative.");
  }
  validatePositionGuardCandidateState(input.candidateState);
  validateDecision(input.decision);
  validateAnalysis(input.analysis);
}

function validateDecision(decision: unknown): void {
  const value = requireRecord(decision, "decision");
  requireEnum(value.action, STRATEGY_DECISION_ACTIONS, "decision action");
  requirePrimitiveString(value.summary, "decision summary");
  requirePrimitiveStringArray(value.reasons, "decision reasons");
  requireFiniteNumber(value.targetNotionalKrw, "decision targetNotionalKrw");
  requireNullableFiniteNumber(value.targetQuantityFraction, "decision targetQuantityFraction");
  requireFiniteNumber(value.referencePrice, "decision referencePrice");
  requireEnum(value.executionDisposition, EXECUTION_DISPOSITIONS, "decision executionDisposition");

  const signalQuality = requireRecord(value.signalQuality, "decision signalQuality");
  requireFiniteNumber(signalQuality.score, "decision signalQuality score");
  requireEnum(signalQuality.bucket, SIGNAL_QUALITY_BUCKETS, "decision signalQuality bucket");
  requireBoolean(signalQuality.confirmationRequired, "decision signalQuality confirmationRequired");
  requireBoolean(signalQuality.confirmationSatisfied, "decision signalQuality confirmationSatisfied");
  requireBoolean(signalQuality.reentryPenaltyApplied, "decision signalQuality reentryPenaltyApplied");

  const exposureGuardrails = requireRecord(value.exposureGuardrails, "decision exposureGuardrails");
  requireFiniteNumber(exposureGuardrails.perAssetMaxAllocation, "decision exposureGuardrails perAssetMaxAllocation");
  requireFiniteNumber(exposureGuardrails.totalPortfolioMaxExposure, "decision exposureGuardrails totalPortfolioMaxExposure");
  requireFiniteNumber(exposureGuardrails.remainingAssetCapacity, "decision exposureGuardrails remainingAssetCapacity");
  requireFiniteNumber(exposureGuardrails.remainingPortfolioCapacity, "decision exposureGuardrails remainingPortfolioCapacity");

  const diagnostics = requireRecord(value.diagnostics, "decision diagnostics");
  validateStructureDiagnostics(diagnostics, "decision diagnostics");
}

function validateAnalysis(analysis: unknown): void {
  const value = requireRecord(analysis, "analysis");
  requireEnum(value.regime, MARKET_REGIMES, "analysis regime");
  requireEnum(value.riskLevel, RISK_LEVELS, "analysis riskLevel");
  requireEnum(value.invalidationState, INVALIDATION_STATES, "analysis invalidationState");
  requireNullableFiniteNumber(value.invalidationLevel, "analysis invalidationLevel");
  for (const field of [
    "pullbackZone",
    "reclaimStructure",
    "breakoutHoldStructure",
    "upperRangeChase",
    "breakdown1d",
    "breakdown4h",
    "failedReclaim",
    "bearishMomentumExpansion",
    "volumeRecovery",
    "macdImproving",
    "rsiRecovery",
    "atrShock",
  ] as const) {
    requireBoolean(value[field], `analysis ${field}`);
  }
  for (const field of [
    "currentPrice",
    "trendAlignmentScore",
    "recoveryQualityScore",
    "breakdownPressureScore",
    "averageEntryPrice",
    "pnlPct",
  ] as const) {
    requireFiniteNumber(value[field], `analysis ${field}`);
  }
  requireEnum(value.entryPath, ENTRY_PATHS, "analysis entryPath");
  requireEnum(value.weakeningStage, WEAKENING_STAGES, "analysis weakeningStage");
  requireOptionalEnum(value.oneHourLocation, STRUCTURE_LOCATIONS, "analysis oneHourLocation");
  requireOptionalEnum(value.fourHourLocation, STRUCTURE_LOCATIONS, "analysis fourHourLocation");
}

function validateStructureDiagnostics(value: Record<string, unknown>, label: string): void {
  requireEnum(value.regime, MARKET_REGIMES, `${label} regime`);
  requireEnum(value.riskLevel, RISK_LEVELS, `${label} riskLevel`);
  requireEnum(value.invalidationState, INVALIDATION_STATES, `${label} invalidationState`);
  requireNullableFiniteNumber(value.invalidationLevel, `${label} invalidationLevel`);
  requireEnum(value.entryPath, ENTRY_PATHS, `${label} entryPath`);
  requireFiniteNumber(value.trendAlignmentScore, `${label} trendAlignmentScore`);
  requireFiniteNumber(value.recoveryQualityScore, `${label} recoveryQualityScore`);
  requireFiniteNumber(value.breakdownPressureScore, `${label} breakdownPressureScore`);
  requireEnum(value.weakeningStage, WEAKENING_STAGES, `${label} weakeningStage`);
  for (const field of ["upperRangeChase", "pullbackZone", "reclaimStructure", "breakoutHoldStructure"] as const) {
    requireBoolean(value[field], `${label} ${field}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`PositionGuard candidate ${label} must be an object.`);
  return value;
}

function requirePrimitiveString(value: unknown, label: string): void {
  if (typeof value !== "string") throw new Error(`PositionGuard candidate ${label} must be a primitive string.`);
}

function requirePrimitiveStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`PositionGuard candidate ${label} must be an array of primitive strings.`);
  }
}

function requireFiniteNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`PositionGuard candidate ${label} must be finite.`);
  }
}

function requireNullableFiniteNumber(value: unknown, label: string): void {
  if (value !== null) requireFiniteNumber(value, label);
}

function requireBoolean(value: unknown, label: string): void {
  if (typeof value !== "boolean") throw new Error(`PositionGuard candidate ${label} must be boolean.`);
}

function requireEnum(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`PositionGuard candidate ${label} is invalid.`);
  }
}

function requireOptionalEnum(value: unknown, allowed: readonly string[], label: string): void {
  if (value !== undefined) requireEnum(value, allowed, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getEarlyFailureReason(
  input: Parameters<typeof evaluatePositionGuardCandidate>[0],
): Extract<PositionGuardCandidateReason, "FAILED_RECLAIM_THESIS" | "BEARISH_LOSS_THESIS"> | null {
  if (input.decision.action !== "HOLD" && input.decision.action !== "ADD") return null;
  if (input.positionQuantity <= POSITION_GUARD_CANDIDATE_AUTHORITY.quantityTolerance) return null;
  if (
    input.analysis.failedReclaim &&
    (input.analysis.weakeningStage === "CLEAR" || input.analysis.weakeningStage === "FAILURE") &&
    input.analysis.recoveryQualityScore <=
      POSITION_GUARD_CANDIDATE_AUTHORITY.earlyFailure.maximumFailedReclaimRecoveryQualityScore
  ) {
    return "FAILED_RECLAIM_THESIS";
  }
  if (
    input.analysis.breakdownPressureScore >= POSITION_GUARD_CANDIDATE_AUTHORITY.earlyFailure.minimumBearishBreakdownPressureScore &&
    input.analysis.bearishMomentumExpansion &&
    input.analysis.pnlPct < 0
  ) {
    return "BEARISH_LOSS_THESIS";
  }
  return null;
}

function getCooldownReason(
  input: Parameters<typeof evaluatePositionGuardCandidate>[0],
): Extract<
  PositionGuardCandidateReason,
  "NON_POSITIVE_EXIT_12H_COOLDOWN" | "SAME_ENTRY_PATH_24H_COOLDOWN"
> | null {
  if (input.decision.action !== "ENTER" || input.candidateState.lastFullExitAt === null) return null;

  const generatedAt = parsePositionGuardCandidateTimestamp(input.generatedAt, "generatedAt");
  const lastFullExitAt = parsePositionGuardCandidateTimestamp(input.candidateState.lastFullExitAt, "lastFullExitAt");
  const elapsedNanoseconds = generatedAt - lastFullExitAt;
  if (elapsedNanoseconds < 0n) {
    throw new Error("PositionGuard candidate generatedAt must not be before lastFullExitAt.");
  }

  if (
    input.candidateState.lastFullExitRealizedPnlKrw !== null &&
    input.candidateState.lastFullExitRealizedPnlKrw <= 0 &&
    elapsedNanoseconds < BigInt(POSITION_GUARD_CANDIDATE_AUTHORITY.cooldown.nonPositiveExitHours) * NANOSECONDS_PER_HOUR
  ) {
    return "NON_POSITIVE_EXIT_12H_COOLDOWN";
  }
  if (
    input.candidateState.lastEntryPath === input.analysis.entryPath &&
    elapsedNanoseconds < BigInt(POSITION_GUARD_CANDIDATE_AUTHORITY.cooldown.sameEntryPathHours) * NANOSECONDS_PER_HOUR
  ) {
    return "SAME_ENTRY_PATH_24H_COOLDOWN";
  }
  return null;
}

function getHtfTrendGateReason(
  input: Parameters<typeof evaluatePositionGuardCandidate>[0],
): Extract<
  PositionGuardCandidateReason,
  "HTF_BREAKDOWN" | "TREND_ALIGNMENT_BELOW_3" | "WEAKENING_PRESENT" | "REGIME_NOT_ENTRY_TREND"
> | null {
  if (input.decision.action !== "ENTER") return null;
  if (input.analysis.breakdown1d || input.analysis.breakdown4h) return "HTF_BREAKDOWN";
  if (
    input.analysis.trendAlignmentScore <
    POSITION_GUARD_CANDIDATE_AUTHORITY.htf.minimumTrendAlignmentScore
  ) {
    return "TREND_ALIGNMENT_BELOW_3";
  }
  if (input.analysis.weakeningStage !== "NONE") return "WEAKENING_PRESENT";
  if (!isAllowedRegime(input.analysis.regime, POSITION_GUARD_CANDIDATE_AUTHORITY.htf.allowedRegimes)) {
    return "REGIME_NOT_ENTRY_TREND";
  }
  return null;
}

function getAddLimitReason(
  input: Parameters<typeof evaluatePositionGuardCandidate>[0],
): Extract<
  PositionGuardCandidateReason,
  | "POSITION_AT_LOSS"
  | "EPISODE_ADD_LIMIT_REACHED"
  | "ATR_SHOCK"
  | "WEAKENING_PRESENT"
  | "TREND_ALIGNMENT_BELOW_4"
  | "RECOVERY_QUALITY_BELOW_3"
  | "REGIME_NOT_CORE_TREND"
> | null {
  if (input.decision.action !== "ADD") return null;
  if (input.analysis.currentPrice < input.averageEntryPrice) return "POSITION_AT_LOSS";
  if (input.candidateState.currentEpisodeAddCount >= POSITION_GUARD_CANDIDATE_AUTHORITY.add.maxAddsPerEpisode) {
    return "EPISODE_ADD_LIMIT_REACHED";
  }
  if (input.analysis.atrShock) return "ATR_SHOCK";
  if (input.analysis.weakeningStage !== "NONE") return "WEAKENING_PRESENT";
  if (
    input.analysis.trendAlignmentScore <
    POSITION_GUARD_CANDIDATE_AUTHORITY.add.minimumTrendAlignmentScore
  ) {
    return "TREND_ALIGNMENT_BELOW_4";
  }
  if (
    input.analysis.recoveryQualityScore <
    POSITION_GUARD_CANDIDATE_AUTHORITY.add.minimumRecoveryQualityScore
  ) {
    return "RECOVERY_QUALITY_BELOW_3";
  }
  if (!isAllowedRegime(input.analysis.regime, POSITION_GUARD_CANDIDATE_AUTHORITY.add.allowedRegimes)) {
    return "REGIME_NOT_CORE_TREND";
  }
  return null;
}

function evaluation(
  input: Parameters<typeof evaluatePositionGuardCandidate>[0],
  outcome: PositionGuardCandidateOutcome,
  reason: PositionGuardCandidateReason,
  precedence: PositionGuardCandidatePrecedence,
  effectiveDecision: PositionGuardEngineDecision,
): Readonly<PositionGuardCandidateEvaluation> {
  return Object.freeze({
    policyId: input.policyId,
    policyVersion: POSITION_GUARD_CANDIDATE_POLICY_VERSION,
    generatedAt: input.generatedAt,
    originalAction: input.decision.action,
    effectiveAction: effectiveDecision.action,
    outcome,
    reason,
    precedence,
    effectiveDecision: freezeDecision(effectiveDecision),
  });
}

function holdDecision(
  decision: PositionGuardEngineDecision,
  reason: PositionGuardCandidateReason,
): PositionGuardEngineDecision {
  return {
    ...cloneDecision(decision),
    action: "HOLD",
    summary: `Candidate policy suppressed ${decision.action} because ${reason}.`,
    reasons: [reason],
    targetNotionalKrw: 0,
    targetQuantityFraction: null,
    executionDisposition: "SKIPPED",
  };
}

function exitDecision(
  decision: PositionGuardEngineDecision,
  reason: PositionGuardCandidateReason,
): PositionGuardEngineDecision {
  return {
    ...cloneDecision(decision),
    action: "EXIT",
    summary: `Candidate policy requires EXIT because ${reason}.`,
    reasons: [reason],
    targetNotionalKrw: 0,
    targetQuantityFraction: 1,
    executionDisposition: "IMMEDIATE",
  };
}

function cloneDecision(decision: PositionGuardEngineDecision): PositionGuardEngineDecision {
  return {
    ...decision,
    reasons: [...decision.reasons],
    signalQuality: { ...decision.signalQuality },
    exposureGuardrails: { ...decision.exposureGuardrails },
    diagnostics: { ...decision.diagnostics },
  };
}

function freezeDecision(decision: PositionGuardEngineDecision): Readonly<PositionGuardEngineDecision> {
  const copy = cloneDecision(decision);
  Object.freeze(copy.reasons);
  Object.freeze(copy.signalQuality);
  Object.freeze(copy.exposureGuardrails);
  Object.freeze(copy.diagnostics);
  return Object.freeze(copy);
}

function hasComponent(
  components: readonly PositionGuardCandidateComponent[],
  component: PositionGuardCandidateComponent,
): boolean {
  return components.includes(component);
}

function isAllowedRegime(
  regime: StrategyMarketRegime,
  allowedRegimes: readonly StrategyMarketRegime[],
): boolean {
  return allowedRegimes.includes(regime);
}
