import { getMarketForAsset, type SupportedAsset } from "../../domain/types.js";
import type { AddAggregateMetric, AddAggregateQuantity, AddLossAttributionCohort, AddLossAttributionResult } from "./performance-add-loss-attribution.js";
import {
  APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS,
  type AddPolicyCandidate,
  type AddPolicyCandidateEvaluationResult,
  type AddPolicyEvaluationCoverage,
  type AddPolicyEvaluationStatus,
  type AddPolicyEvaluationObservation,
  type AddPolicyEvaluationThresholds,
} from "./performance-add-policy-evaluation.js";

const CANDIDATE_ORDER: readonly AddPolicyCandidate[] = [
  "ADD_CORE_TREND",
  "ADD_HIGH_ALIGNMENT",
  "ADD_RISK_CLEAR",
];

const ASSET_ORDER: readonly SupportedAsset[] = ["BTC", "ETH"];

export type AddHoldoutHypothesisStatus =
  | "READY_FOR_FUTURE_HOLDOUT"
  | "CONFLICTING"
  | "INSUFFICIENT"
  | "NOT_APPLICABLE";

export type AddHoldoutReasonCode =
  | "MISSING_BTC_CANDIDATE_EVALUATION"
  | "MISSING_ETH_CANDIDATE_EVALUATION"
  | "MISSING_BTC_SUPPRESSION_EVIDENCE"
  | "MISSING_ETH_SUPPRESSION_EVIDENCE"
  | "BTC_SUPPRESSED_CONTRIBUTION_INCOMPLETE"
  | "ETH_SUPPRESSED_CONTRIBUTION_INCOMPLETE"
  | "BTC_CANDIDATE_EVIDENCE_INSUFFICIENT"
  | "ETH_CANDIDATE_EVIDENCE_INSUFFICIENT"
  | "BTC_APPROVED_THRESHOLD_OR_SUPPORT_CONTRACT_INSUFFICIENT"
  | "ETH_APPROVED_THRESHOLD_OR_SUPPORT_CONTRACT_INSUFFICIENT"
  | "BTC_FROZEN_PERFORMANCE_OR_DRAWDOWN_GATE_FAILED"
  | "ETH_FROZEN_PERFORMANCE_OR_DRAWDOWN_GATE_FAILED"
  | "BTC_SUPPRESSED_CONTRIBUTION_NOT_NEGATIVE"
  | "ETH_SUPPRESSED_CONTRIBUTION_NOT_NEGATIVE"
  | "BTC_NOT_SUPPORT_ONLY_INSUFFICIENT"
  | "ETH_NOT_SUPPORT_ONLY_INSUFFICIENT"
  | "SUPPORT_ONLY_INSUFFICIENCY_WITH_CROSS_ASSET_NEGATIVE_CONTRIBUTION";

export type AddHoldoutHypothesisInput = {
  attributions: readonly AddLossAttributionResult[];
  candidateEvaluations: readonly AddPolicyCandidateEvaluationResult[];
};

export type AddHoldoutAssetEvidence = {
  asset: SupportedAsset;
  candidateEvaluation: AddPolicyCandidateEvaluationResult | null;
  suppressedContribution: AddLossAttributionCohort | null;
  suppressionEvidenceIds: readonly string[] | null;
};

export type AddHoldoutHypothesis = {
  candidate: AddPolicyCandidate;
  status: AddHoldoutHypothesisStatus;
  reasonCodes: readonly AddHoldoutReasonCode[];
  sourceCandidateStatuses: Record<SupportedAsset, AddPolicyEvaluationStatus | null>;
  assets: readonly AddHoldoutAssetEvidence[];
};

export type AddHoldoutHypothesisResult = {
  evidenceKind: "SIMULATED_CONDITIONAL_ADD_POLICY_EVALUATION";
  analysisKind: "ADD_CROSS_ASSET_HOLDOUT_HYPOTHESIS";
  deploymentApproval: false;
  hypotheses: readonly AddHoldoutHypothesis[];
};

export function classifyAddHoldoutHypotheses(input: AddHoldoutHypothesisInput): AddHoldoutHypothesisResult {
  const attributions = indexAttributions(input.attributions);
  const evaluations = indexEvaluations(input.candidateEvaluations);

  return {
    evidenceKind: "SIMULATED_CONDITIONAL_ADD_POLICY_EVALUATION",
    analysisKind: "ADD_CROSS_ASSET_HOLDOUT_HYPOTHESIS",
    deploymentApproval: false,
    hypotheses: CANDIDATE_ORDER.map((candidate) => classifyCandidate(candidate, attributions, evaluations)),
  };
}

function classifyCandidate(
  candidate: AddPolicyCandidate,
  attributions: ReadonlyMap<SupportedAsset, AddLossAttributionResult>,
  evaluations: ReadonlyMap<string, AddPolicyCandidateEvaluationResult>,
): AddHoldoutHypothesis {
  const assets = ASSET_ORDER.map((asset) => {
    const attribution = attributions.get(asset) ?? null;
    const candidateEvaluation = evaluations.get(evaluationKey(asset, candidate)) ?? null;
    const suppression = attribution === null
      ? null
      : findSuppression(attribution, candidate);
    return {
      asset,
      candidateEvaluation,
      suppressedContribution: suppression?.metrics ?? null,
      suppressionEvidenceIds: suppression?.suppressionEvidenceIds ?? null,
    };
  });
  const sourceCandidateStatuses = Object.fromEntries(assets.map(({ asset, candidateEvaluation }) => [asset, candidateEvaluation?.status ?? null])) as Record<SupportedAsset, AddPolicyEvaluationStatus | null>;

  const notApplicableReasons = assets.flatMap(({ asset, candidateEvaluation, suppressedContribution }) => [
    ...(candidateEvaluation === null ? [missingCandidateReason(asset)] : []),
    ...(suppressedContribution === null ? [missingSuppressionReason(asset)] : []),
  ]);
  if (notApplicableReasons.length > 0) {
    return createHypothesis(candidate, "NOT_APPLICABLE", notApplicableReasons, sourceCandidateStatuses, assets);
  }

  const completeAssets = assets as Array<AddHoldoutAssetEvidence & {
    candidateEvaluation: AddPolicyCandidateEvaluationResult;
    suppressedContribution: AddLossAttributionCohort;
  }>;
  const contributionInsufficiencyReasons = completeAssets.flatMap(({ asset, suppressedContribution }) => {
    const reasons: AddHoldoutReasonCode[] = [];
    if (!hasCompleteSuppressedContribution(suppressedContribution)) reasons.push(incompleteContributionReason(asset));
    return reasons;
  });
  if (contributionInsufficiencyReasons.length > 0) {
    return createHypothesis(candidate, "INSUFFICIENT", contributionInsufficiencyReasons, sourceCandidateStatuses, assets);
  }

  const candidateEvidenceInsufficiencyReasons = completeAssets.flatMap(({ asset, candidateEvaluation }) => [
    ...(!hasCompleteCandidateEvidence(candidateEvaluation) ? [candidateEvidenceInsufficientReason(asset)] : []),
    ...(!hasApprovedThresholdAndSupportContract(candidateEvaluation) ? [approvedThresholdOrSupportContractReason(asset)] : []),
  ]);
  if (candidateEvidenceInsufficiencyReasons.length > 0) {
    return createHypothesis(candidate, "INSUFFICIENT", candidateEvidenceInsufficiencyReasons, sourceCandidateStatuses, assets);
  }

  const conflictReasons = completeAssets.flatMap(({ asset, candidateEvaluation, suppressedContribution }) => {
    const reasons: AddHoldoutReasonCode[] = [];
    if (!performanceAndDrawdownGatesPass(candidateEvaluation)) reasons.push(performanceGateFailedReason(asset));
    if (!isNegativeKnownNet(suppressedContribution)) reasons.push(nonNegativeContributionReason(asset));
    return reasons;
  });
  if (conflictReasons.length > 0) {
    return createHypothesis(candidate, "CONFLICTING", conflictReasons, sourceCandidateStatuses, assets);
  }

  const supportOnly = completeAssets.every(({ candidateEvaluation }) => isSupportOnlyInsufficiency(candidateEvaluation));
  if (!supportOnly) {
    const reasons = completeAssets
      .filter(({ candidateEvaluation }) => !isSupportOnlyInsufficiency(candidateEvaluation))
      .map(({ asset }) => notSupportOnlyReason(asset));
    return createHypothesis(candidate, "CONFLICTING", reasons, sourceCandidateStatuses, assets);
  }

  return createHypothesis(
    candidate,
    "READY_FOR_FUTURE_HOLDOUT",
    ["SUPPORT_ONLY_INSUFFICIENCY_WITH_CROSS_ASSET_NEGATIVE_CONTRIBUTION"],
    sourceCandidateStatuses,
    assets,
  );
}

function indexAttributions(attributions: readonly AddLossAttributionResult[]): Map<SupportedAsset, AddLossAttributionResult> {
  const result = new Map<SupportedAsset, AddLossAttributionResult>();
  for (const attribution of attributions) {
    if (result.has(attribution.asset)) throw new Error(`Duplicate ADD holdout attribution asset ${attribution.asset}.`);
    if (attribution.market !== getMarketForAsset(attribution.asset)) {
      throw new Error(`ADD holdout attribution market ${attribution.market} does not match asset ${attribution.asset}.`);
    }
    validateJsonSafe(attribution, `ADD holdout attribution ${attribution.asset}`);
    for (const suppressed of attribution.policySuppressedCohorts) {
      if (suppressed.metrics.dimension !== "POLICY_SUPPRESSED" || suppressed.metrics.value !== suppressed.policyId) {
        throw new Error(`ADD holdout policy-suppressed cohort candidate ${suppressed.policyId} is mismatched.`);
      }
      if (suppressed.suppressionEvidenceIds.some((evidenceId) => evidenceId.trim().length === 0)) {
        throw new Error(`ADD holdout suppression evidence id for ${attribution.asset}:${suppressed.policyId} must be non-blank.`);
      }
      if (suppressed.metrics.executedAddCount > 0 && suppressed.suppressionEvidenceIds.length === 0) {
        throw new Error(`ADD holdout suppression evidence ids are required for ${attribution.asset}:${suppressed.policyId}.`);
      }
      validateSuppressedContribution(suppressed.metrics, attribution.asset, suppressed.policyId);
    }
    result.set(attribution.asset, attribution);
  }
  return result;
}

function indexEvaluations(evaluations: readonly AddPolicyCandidateEvaluationResult[]): Map<string, AddPolicyCandidateEvaluationResult> {
  const result = new Map<string, AddPolicyCandidateEvaluationResult>();
  for (const evaluation of evaluations) {
    const key = evaluationKey(evaluation.asset, evaluation.candidate);
    if (result.has(key)) throw new Error(`Duplicate ADD holdout candidate evaluation ${key}.`);
    validateJsonSafe(evaluation, `ADD holdout candidate evaluation ${key}`);
    result.set(key, evaluation);
  }
  return result;
}

function findSuppression(
  attribution: AddLossAttributionResult,
  candidate: AddPolicyCandidate,
): AddLossAttributionResult["policySuppressedCohorts"][number] | null {
  const matches = attribution.policySuppressedCohorts.filter((item) => item.policyId === candidate);
  if (matches.length > 1) throw new Error(`Duplicate ADD holdout suppression cohort ${attribution.asset}:${candidate}.`);
  return matches[0] ?? null;
}

function hasCompleteSuppressedContribution(cohort: AddLossAttributionCohort): boolean {
  const gross = cohort.grossRealizedContributionKrw;
  const net = cohort.netRealizedContributionKrw;
  const fee = cohort.confirmedFeeImpactKrw;
  return cohort.executedAddCount > 0
    && cohort.fullyRealizedAddCount === cohort.executedAddCount
    && cohort.partiallyRealizedAddCount === 0
    && cohort.unrealizedAddCount === 0
    && cohort.unavailableLifecycleAddCount === 0
    && cohort.knownGrossContributionCount === cohort.executedAddCount
    && cohort.knownNetContributionCount === cohort.executedAddCount
    && gross.completeness === "COMPLETE"
    && gross.total.status === "KNOWN"
    && Number.isFinite(gross.total.value)
    && net.completeness === "COMPLETE"
    && net.total.status === "KNOWN"
    && Number.isFinite(net.total.value)
    && fee.completeness === "COMPLETE"
    && fee.total.status === "KNOWN"
    && Number.isFinite(fee.total.value)
    && cohort.realizedQuantity.completeness === "COMPLETE"
    && cohort.remainingQuantity.completeness === "COMPLETE"
    && cohort.realizedQuantity.total.status === "KNOWN"
    && cohort.remainingQuantity.total.status === "KNOWN"
    && cohort.realizedQuantity.total.value > 0
    && cohort.remainingQuantity.total.value === 0;
}

function hasCompleteCandidateEvidence(candidate: AddPolicyCandidateEvaluationResult): boolean {
  const exactWindowIds = ["W1", "W2", "W3"];
  const windows = candidate.observations.windows;
  if (!hasExactWindowIds(windows.map((window) => window.id), exactWindowIds)) return false;
  if (!hasExactWindowIds(candidate.anchorComparisons.windows.map((window) => window.windowId), exactWindowIds)) return false;
  if (!hasExactWindowIds(candidate.gates.frameCoverage.windows.map((window) => window.windowId), exactWindowIds)) return false;
  if (!hasExactWindowIds(candidate.gates.policyExposedCompletedEpisodes.windows.map((window) => window.windowId), exactWindowIds)) return false;
  if (!hasCompleteCoverage(candidate.observations.fullPath.coverage)) return false;
  if (!hasCompleteCoverage(candidate.gates.frameCoverage.fullPath) || !candidate.gates.frameCoverage.fullPath.passed) return false;
  if (!hasRequiredCostCells(candidate.observations.fullPath.observations, candidate)) return false;
  if (!hasNonEmptyComparisonEvidence(candidate)) return false;
  return windows.every((window) => {
    const anchorWindow = candidate.anchorComparisons.windows.find((item) => item.windowId === window.id);
    const coverageWindow = candidate.gates.frameCoverage.windows.find((item) => item.windowId === window.id);
    return anchorWindow !== undefined
      && anchorWindow.evaluable
      && anchorWindow.comparisons.length > 0
      && coverageWindow !== undefined
      && coverageWindow.passed
      && hasCompleteCoverage(window.coverage)
      && hasCompleteCoverage(coverageWindow)
      && hasRequiredCostCells(window.observations, candidate);
  });
}

function performanceAndDrawdownGatesPass(candidate: AddPolicyCandidateEvaluationResult): boolean {
  return candidate.gates.fullPathNetReturn.status === "PASS"
    && candidate.gates.baseWindowReturn.status === "PASS"
    && candidate.gates.stressWindowReturn.status === "PASS"
    && candidate.gates.fullPathMaxDrawdown.status === "PASS"
    && candidate.gates.stressWindowMaxDrawdown.status === "PASS";
}

function isSupportOnlyInsufficiency(candidate: AddPolicyCandidateEvaluationResult): boolean {
  return candidate.status === "INSUFFICIENT"
    && candidate.gates.policyExposedCompletedEpisodes.status === "INSUFFICIENT"
    && candidate.gates.frameCoverage.status === "PASS"
    && performanceAndDrawdownGatesPass(candidate)
    && hasApprovedThresholdAndSupportContract(candidate);
}

function hasApprovedThresholdAndSupportContract(candidate: AddPolicyCandidateEvaluationResult): boolean {
  if (!hasApprovedThresholds(candidate.thresholds)) return false;
  const support = candidate.gates.policyExposedCompletedEpisodes;
  if (!Number.isInteger(support.fullPathObservedCount) || support.fullPathObservedCount < 0) return false;
  if (support.fullPathRequiredCount !== APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS.minimumFullPathPolicyExposedCompletedEpisodes) return false;
  if (!hasExactWindowIds(support.windows.map((window) => window.windowId), ["W1", "W2", "W3"])) return false;
  const windowsConsistent = support.windows.every((window) => {
    if (!Number.isInteger(window.observedCount) || window.observedCount < 0) return false;
    if (window.requiredCount !== APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS.minimumWindowPolicyExposedCompletedEpisodes) return false;
    if (window.evaluable !== true || typeof window.passed !== "boolean") return false;
    return window.passed === (window.observedCount >= window.requiredCount);
  });
  if (!windowsConsistent) return false;
  const expectedStatus = support.fullPathObservedCount >= support.fullPathRequiredCount && support.windows.every((window) => window.passed)
    ? "PASS"
    : "INSUFFICIENT";
  return support.status === expectedStatus;
}

function hasApprovedThresholds(thresholds: AddPolicyEvaluationThresholds): boolean {
  return (Object.keys(APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS) as Array<keyof AddPolicyEvaluationThresholds>)
    .every((key) => thresholds[key] === APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS[key]);
}

function hasRequiredCostCells(
  observations: readonly AddPolicyEvaluationObservation[],
  candidate: AddPolicyCandidateEvaluationResult,
): boolean {
  const expected = (["BASE", "STRESS"] as const).flatMap((costRole) => (["BASELINE", "NO_ADD", candidate.candidate] as const).map((scenario) => ({ costRole, scenario })));
  if (observations.length !== expected.length) return false;
  return expected.every(({ costRole, scenario }) => {
    const matches = observations.filter((item) => item.costRole === costRole && item.scenario === scenario);
    const anchor = candidate.costAnchors[costRole];
    return matches.length === 1
      && matches[0]!.costScenarioId === anchor.costScenarioId
      && matches[0]!.feeRate === anchor.feeRate
      && matches[0]!.slippageRate === anchor.slippageRate;
  });
}

function hasNonEmptyComparisonEvidence(candidate: AddPolicyCandidateEvaluationResult): boolean {
  return candidate.anchorComparisons.fullPath.length > 0
    && candidate.gates.fullPathNetReturn.comparisons.length > 0
    && candidate.gates.baseWindowReturn.observations.length > 0
    && candidate.gates.stressWindowReturn.observations.length > 0
    && candidate.gates.fullPathMaxDrawdown.observations.length > 0
    && candidate.gates.stressWindowMaxDrawdown.observations.length > 0;
}

function hasExactWindowIds(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function hasCompleteCoverage(coverage: AddPolicyEvaluationCoverage): boolean {
  return coverage.status === "COMPLETE"
    && coverage.windowCadenceStatus === "COMPLETE"
    && coverage.windowSequenceContinuityStatus === "COMPLETE"
    && coverage.upstreamStateContinuityStatus === "COMPLETE"
    && coverage.featureLookbackContinuityStatus === "COMPLETE"
    && coverage.missingFrameCount === 0
    && coverage.duplicateFrameCount === 0
    && coverage.offGridFrameCount === 0
    && coverage.missingRanges.length === 0
    && coverage.duplicateInstants.length === 0
    && coverage.offGridInstants.length === 0
    && coverage.observedFrameCount + coverage.noTradeFrameCount === coverage.expectedFrameCount
    && coverage.upstreamSequenceContinuityStatus === "COMPLETE"
    && coverage.upstreamMissingFrameCount === 0
    && coverage.upstreamDuplicateFrameCount === 0
    && coverage.upstreamOffGridFrameCount === 0
    && coverage.upstreamMissingRanges.length === 0
    && coverage.upstreamDuplicateInstants.length === 0
    && coverage.upstreamOffGridInstants.length === 0
    && coverage.upstreamObservedFrameCount + coverage.upstreamNoTradeFrameCount === coverage.upstreamExpectedFrameCount
    && coverage.featureLookbackAffectedFrameCount === 0
    && coverage.featureLookbackAffectedRanges.length === 0;
}

function isNegativeKnownNet(cohort: AddLossAttributionCohort): boolean {
  return cohort.netRealizedContributionKrw.total.status === "KNOWN"
    && Number.isFinite(cohort.netRealizedContributionKrw.total.value)
    && cohort.netRealizedContributionKrw.total.value < 0;
}

function createHypothesis(
  candidate: AddPolicyCandidate,
  status: AddHoldoutHypothesisStatus,
  reasonCodes: readonly AddHoldoutReasonCode[],
  sourceCandidateStatuses: Record<SupportedAsset, AddPolicyEvaluationStatus | null>,
  assets: readonly AddHoldoutAssetEvidence[],
): AddHoldoutHypothesis {
  return { candidate, status, reasonCodes, sourceCandidateStatuses, assets };
}

function evaluationKey(asset: SupportedAsset, candidate: AddPolicyCandidate): string {
  return `${asset}:${candidate}`;
}

function missingCandidateReason(asset: SupportedAsset): AddHoldoutReasonCode {
  return asset === "BTC" ? "MISSING_BTC_CANDIDATE_EVALUATION" : "MISSING_ETH_CANDIDATE_EVALUATION";
}

function missingSuppressionReason(asset: SupportedAsset): AddHoldoutReasonCode {
  return asset === "BTC" ? "MISSING_BTC_SUPPRESSION_EVIDENCE" : "MISSING_ETH_SUPPRESSION_EVIDENCE";
}

function incompleteContributionReason(asset: SupportedAsset): AddHoldoutReasonCode {
  return asset === "BTC" ? "BTC_SUPPRESSED_CONTRIBUTION_INCOMPLETE" : "ETH_SUPPRESSED_CONTRIBUTION_INCOMPLETE";
}

function candidateEvidenceInsufficientReason(asset: SupportedAsset): AddHoldoutReasonCode {
  return asset === "BTC" ? "BTC_CANDIDATE_EVIDENCE_INSUFFICIENT" : "ETH_CANDIDATE_EVIDENCE_INSUFFICIENT";
}

function approvedThresholdOrSupportContractReason(asset: SupportedAsset): AddHoldoutReasonCode {
  return asset === "BTC"
    ? "BTC_APPROVED_THRESHOLD_OR_SUPPORT_CONTRACT_INSUFFICIENT"
    : "ETH_APPROVED_THRESHOLD_OR_SUPPORT_CONTRACT_INSUFFICIENT";
}

function performanceGateFailedReason(asset: SupportedAsset): AddHoldoutReasonCode {
  return asset === "BTC" ? "BTC_FROZEN_PERFORMANCE_OR_DRAWDOWN_GATE_FAILED" : "ETH_FROZEN_PERFORMANCE_OR_DRAWDOWN_GATE_FAILED";
}

function nonNegativeContributionReason(asset: SupportedAsset): AddHoldoutReasonCode {
  return asset === "BTC" ? "BTC_SUPPRESSED_CONTRIBUTION_NOT_NEGATIVE" : "ETH_SUPPRESSED_CONTRIBUTION_NOT_NEGATIVE";
}

function notSupportOnlyReason(asset: SupportedAsset): AddHoldoutReasonCode {
  return asset === "BTC" ? "BTC_NOT_SUPPORT_ONLY_INSUFFICIENT" : "ETH_NOT_SUPPORT_ONLY_INSUFFICIENT";
}

function validateSuppressedContribution(cohort: AddLossAttributionCohort, asset: SupportedAsset, candidate: AddPolicyCandidate): void {
  const name = `ADD holdout suppressed contribution ${asset}:${candidate}`;
  const counts = [
    cohort.executedAddCount,
    cohort.fullyRealizedAddCount,
    cohort.partiallyRealizedAddCount,
    cohort.unrealizedAddCount,
    cohort.unavailableLifecycleAddCount,
    cohort.knownGrossContributionCount,
    cohort.knownNetContributionCount,
    cohort.positiveNetContributionCount,
    cohort.negativeNetContributionCount,
    cohort.breakevenNetContributionCount,
  ];
  for (const count of counts) requireNonNegativeInteger(count, `${name} count`);
  if (
    cohort.fullyRealizedAddCount + cohort.partiallyRealizedAddCount + cohort.unrealizedAddCount + cohort.unavailableLifecycleAddCount
    !== cohort.executedAddCount
  ) {
    throw new Error(`${name} lifecycle counts do not sum to executed ADD count.`);
  }
  if (
    cohort.positiveNetContributionCount + cohort.negativeNetContributionCount + cohort.breakevenNetContributionCount
    !== cohort.knownNetContributionCount
  ) {
    throw new Error(`${name} known net contribution counts do not match outcome counts.`);
  }
  validateAggregateMetric(cohort.grossRealizedContributionKrw, cohort.executedAddCount, cohort.knownGrossContributionCount, `${name} gross`, false);
  validateAggregateMetric(cohort.confirmedFeeImpactKrw, cohort.executedAddCount, null, `${name} fee`, true);
  validateAggregateMetric(cohort.netRealizedContributionKrw, cohort.executedAddCount, cohort.knownNetContributionCount, `${name} net`, false);
  validateAggregateMetric(cohort.meanKnownGrossContributionKrw, cohort.executedAddCount, null, `${name} mean gross`, false);
  validateAggregateMetric(cohort.meanKnownNetContributionKrw, cohort.executedAddCount, null, `${name} mean net`, false);
  validateAggregateQuantity(cohort.realizedQuantity, cohort.executedAddCount, `${name} realized quantity`);
  validateAggregateQuantity(cohort.remainingQuantity, cohort.executedAddCount, `${name} remaining quantity`);
  validateKnownContributionIdentity(cohort, name);
  validateHomogeneousLifecycleQuantities(cohort, name);
}

function validateKnownContributionIdentity(cohort: AddLossAttributionCohort, name: string): void {
  const gross = knownValue(cohort.grossRealizedContributionKrw.total);
  const fee = knownValue(cohort.confirmedFeeImpactKrw.total);
  const net = knownValue(cohort.netRealizedContributionKrw.total);
  if (gross === null || fee === null || net === null) return;
  if (Math.abs((gross - fee) - net) > 0.000001) {
    throw new Error(`${name} net total contradicts gross total minus fee total.`);
  }
}

function validateHomogeneousLifecycleQuantities(cohort: AddLossAttributionCohort, name: string): void {
  if (cohort.executedAddCount === 0) return;
  const realized = knownValue(cohort.realizedQuantity.total);
  const remaining = knownValue(cohort.remainingQuantity.total);
  if (cohort.fullyRealizedAddCount === cohort.executedAddCount && (realized === null || realized <= 0 || remaining === null || Math.abs(remaining) > 0.000000000001)) {
    throw new Error(`${name} fully realized ADDs must have positive realized and zero remaining quantity.`);
  }
  if (cohort.unrealizedAddCount === cohort.executedAddCount && (realized === null || Math.abs(realized) > 0.000000000001 || remaining === null || remaining <= 0)) {
    throw new Error(`${name} unrealized ADDs must have zero realized and positive remaining quantity.`);
  }
  if (cohort.partiallyRealizedAddCount === cohort.executedAddCount && (realized === null || remaining === null || realized <= 0 || remaining <= 0)) {
    throw new Error(`${name} partially realized ADDs must have positive realized and remaining quantity.`);
  }
}

function validateAggregateMetric(
  metric: AddAggregateMetric,
  executedCount: number,
  expectedKnownCount: number | null,
  name: string,
  nonNegativeValue: boolean,
): void {
  validateAggregateShape(metric, executedCount, name);
  if (expectedKnownCount !== null && metric.knownCount !== expectedKnownCount) {
    throw new Error(`${name} known count contradicts contribution count.`);
  }
  validateMetricValue(metric.knownSubtotal, `${name} known subtotal`, nonNegativeValue);
  validateMetricValue(metric.total, `${name} total`, nonNegativeValue);
  if (metric.completeness === "COMPLETE") {
    if (metric.knownSubtotal.status !== "KNOWN" || metric.total.status !== "KNOWN") {
      throw new Error(`${name} COMPLETE evidence must have known totals.`);
    }
    if (Math.abs(metric.knownSubtotal.value - metric.total.value) > 0.000001) {
      throw new Error(`${name} COMPLETE total contradicts known subtotal.`);
    }
  }
}

function validateAggregateQuantity(metric: AddAggregateQuantity, executedCount: number, name: string): void {
  validateAggregateShape(metric, executedCount, name);
  validateMetricValue(metric.knownSubtotal, `${name} known subtotal`, true);
  validateMetricValue(metric.total, `${name} total`, true);
  if (metric.completeness === "COMPLETE") {
    if (metric.knownSubtotal.status !== "KNOWN" || metric.total.status !== "KNOWN") {
      throw new Error(`${name} COMPLETE evidence must have known totals.`);
    }
    if (Math.abs(metric.knownSubtotal.value - metric.total.value) > 0.000001) {
      throw new Error(`${name} COMPLETE total contradicts known subtotal.`);
    }
  }
}

function validateAggregateShape(
  metric: AddAggregateMetric | AddAggregateQuantity,
  executedCount: number,
  name: string,
): void {
  requireNonNegativeInteger(metric.knownCount, `${name} known count`);
  requireNonNegativeInteger(metric.unknownCount, `${name} unknown count`);
  if (metric.knownCount + metric.unknownCount !== executedCount) {
    throw new Error(`${name} known and unknown counts do not sum to executed ADD count.`);
  }
  const expectedCompleteness = executedCount === 0 || metric.knownCount === 0
    ? "UNKNOWN"
    : metric.unknownCount === 0
      ? "COMPLETE"
      : "PARTIAL";
  if (metric.completeness !== expectedCompleteness) {
    throw new Error(`${name} completeness contradicts known and unknown counts.`);
  }
  if (metric.knownCount === 0 && metric.knownSubtotal.status === "KNOWN") {
    throw new Error(`${name} has a known subtotal without known observations.`);
  }
  if (metric.knownCount > 0 && metric.knownSubtotal.status !== "KNOWN") {
    throw new Error(`${name} hides known observations behind an unknown subtotal.`);
  }
  if (metric.completeness === "COMPLETE" && metric.total.status !== "KNOWN") {
    throw new Error(`${name} COMPLETE evidence must have a known total.`);
  }
  if (metric.completeness !== "COMPLETE" && metric.total.status === "KNOWN") {
    throw new Error(`${name} incomplete evidence must not claim a known total.`);
  }
}

function validateMetricValue(metric: AddAggregateMetric["total"], name: string, nonNegative: boolean): void {
  if (metric.status !== "KNOWN") return;
  if (!Number.isFinite(metric.value)) throw new Error(`${name} must be finite.`);
  if (nonNegative && metric.value < 0) throw new Error(`${name} must be non-negative.`);
}

function knownValue(metric: AddAggregateMetric["total"]): number | null {
  return metric.status === "KNOWN" ? metric.value : null;
}

function requireNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
}

function validateJsonSafe(value: unknown, name: string, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${name} contains a non-finite number.`);
    return;
  }
  if (
    typeof value === "undefined"
    || typeof value === "function"
    || typeof value === "symbol"
    || typeof value === "bigint"
  ) {
    throw new Error(`${name} contains a non-JSON-safe value.`);
  }
  if (typeof value !== "object") throw new Error(`${name} contains a non-JSON-safe value.`);
  if (ancestors.has(value)) throw new Error(`${name} contains a cycle.`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error(`${name} contains a non-JSON-safe symbol key.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new Error(`${name} contains a non-JSON-safe object.`);
  }
  ancestors.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    validateJsonSafe(item, name, ancestors);
  }
  ancestors.delete(value);
}
