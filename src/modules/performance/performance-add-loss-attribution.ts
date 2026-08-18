import { getMarketForAsset, type SupportedAsset, type SupportedMarket } from "../../domain/types.js";
import type { StrategyMarketRegime, StrategyWeakeningStage } from "../strategy/position-guard-core.js";
import type { AddDecisionDiagnosticsResult, AddDecisionExposure } from "./performance-add-diagnostics.js";
import type { AddPostDecisionExcursion, AddPostDecisionExcursionResult } from "./performance-add-excursions.js";
import type { Metric } from "./performance-diagnostics.js";
import { PERFORMANCE_QUANTITY_TOLERANCE } from "./performance-trade-matcher.js";
import {
  comparePerformanceTimestamps,
  parsePerformanceTimestamp,
  performanceTimestampEpochNanoseconds,
} from "./performance-timestamp.js";

const KRW_TOLERANCE = 0.000001;

export type AddPolicyId = "ADD_RISK_CLEAR" | "ADD_HIGH_ALIGNMENT" | "ADD_CORE_TREND";

export type AddPolicySuppressionEvidence = {
  policyId: AddPolicyId;
  suppressedDecisions: readonly {
    generatedAt: string;
    evidenceIds: readonly string[];
  }[];
};

export type AddLossAttributionInput = {
  asset: SupportedAsset;
  market: SupportedMarket;
  breakevenToleranceKrw: number;
  diagnostics: AddDecisionDiagnosticsResult;
  excursions: AddPostDecisionExcursionResult;
  policySuppressionEvidence: readonly AddPolicySuppressionEvidence[];
};

export type AddContributionLifecycleState = "FULLY_REALIZED" | "PARTIALLY_REALIZED" | "UNREALIZED" | "UNAVAILABLE";

export type AddLossAttributionContribution = {
  exposureId: string;
  generatedAt: string;
  fillId: string | null;
  episodeId: string | null;
  isExecutedAddFill: boolean;
  regime: StrategyMarketRegime;
  atrShock: boolean;
  weakeningStage: StrategyWeakeningStage;
  trendAlignmentScore: number;
  addOrdinalWithinEpisode: number | null;
  lifecycleState: AddContributionLifecycleState;
  entryNotionalKrw: number | null;
  realizedQuantity: number | null;
  remainingQuantity: number | null;
  allocatedEntryFeeKrw: number | null;
  allocatedExitFeeKrw: number | null;
  grossRealizedContributionKrw: Metric<number>;
  confirmedFeeImpactKrw: Metric<number>;
  netRealizedContributionKrw: Metric<number>;
  realizationSliceIds: readonly string[];
  postDecisionExcursion: {
    status: AddPostDecisionExcursion["status"];
    reason: string | null;
    maeKrw: Metric<number>;
    mfeKrw: Metric<number>;
    evidenceIds: readonly string[];
    provenance: AddPostDecisionExcursion["provenance"];
  };
};

export type AddAggregateCompleteness = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export type AddAggregateMetric = {
  completeness: AddAggregateCompleteness;
  knownCount: number;
  unknownCount: number;
  knownSubtotal: Metric<number>;
  total: Metric<number>;
};

export type AddAggregateQuantity = {
  completeness: AddAggregateCompleteness;
  knownCount: number;
  unknownCount: number;
  knownSubtotal: Metric<number>;
  total: Metric<number>;
};

export type AddLossAttributionEvidence = {
  exposureId: string;
  fillId: string | null;
  episodeId: string | null;
  realizationSliceIds: readonly string[];
  excursionExposureId: string;
  datasetSha256: string;
  source: string;
  historyStartAt: string;
  endAt: string;
};

export type AddLossAttributionCohort = {
  dimension: "REGIME" | "ATR_SHOCK" | "WEAKENING_STAGE" | "TREND_ALIGNMENT_SCORE" | "ADD_ORDINAL" | "POLICY_SUPPRESSED";
  value: string;
  executedAddCount: number;
  fullyRealizedAddCount: number;
  partiallyRealizedAddCount: number;
  unrealizedAddCount: number;
  unavailableLifecycleAddCount: number;
  knownGrossContributionCount: number;
  knownNetContributionCount: number;
  positiveNetContributionCount: number;
  negativeNetContributionCount: number;
  breakevenNetContributionCount: number;
  grossRealizedContributionKrw: AddAggregateMetric;
  confirmedFeeImpactKrw: AddAggregateMetric;
  netRealizedContributionKrw: AddAggregateMetric;
  meanKnownGrossContributionKrw: AddAggregateMetric;
  meanKnownNetContributionKrw: AddAggregateMetric;
  realizedQuantity: AddAggregateQuantity;
  remainingQuantity: AddAggregateQuantity;
  maeKrw: AddExcursionSummary;
  mfeKrw: AddExcursionSummary;
  evidenceIds: readonly string[];
  evidence: readonly AddLossAttributionEvidence[];
};

export type AddExcursionSummary = {
  knownCount: number;
  mean: number | null;
  min: number | null;
  max: number | null;
};

export type AddLossAttributionResult = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  analysisKind: "ADD_LOSS_ATTRIBUTION";
  causalClaim: false;
  asset: SupportedAsset;
  market: SupportedMarket;
  contributionUnit: "EXECUTED_ADD_FILL";
  contributions: readonly AddLossAttributionContribution[];
  aggregate: AddLossAttributionCohort;
  cohorts: {
    byRegime: readonly AddLossAttributionCohort[];
    byAtrShock: readonly AddLossAttributionCohort[];
    byWeakeningStage: readonly AddLossAttributionCohort[];
    byTrendAlignmentScore: readonly AddLossAttributionCohort[];
    byAddOrdinal: readonly AddLossAttributionCohort[];
  };
  policySuppressedCohorts: readonly {
    policyId: AddPolicyId;
    suppressionEvidenceIds: readonly string[];
    metrics: AddLossAttributionCohort;
  }[];
};

export function analyzeAddLossAttribution(input: AddLossAttributionInput): AddLossAttributionResult {
  validateInput(input);
  const excursionByExposureId = mapExcursions(input.excursions.exposures, input.market);
  const contributions = input.diagnostics.exposures.map((exposure) => {
    const excursion = excursionByExposureId.get(exposure.id);
    if (!excursion) throw new Error(`Missing excursion evidence for ADD exposure ${exposure.id}.`);
    return normalizeContribution(exposure, excursion);
  }).sort(compareContributions);
  for (const excursion of input.excursions.exposures) {
    if (!input.diagnostics.exposures.some((exposure) => exposure.id === excursion.exposureId)) {
      throw new Error(`ADD excursion evidence ${excursion.exposureId} does not match a diagnostics exposure.`);
    }
  }

  const ordinalByExposureId = deriveEpisodeOrdinals(contributions);
  const normalized = contributions.map((contribution) => ({
    ...contribution,
    addOrdinalWithinEpisode: ordinalByExposureId.get(contribution.exposureId) ?? null,
  }));

  return {
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    analysisKind: "ADD_LOSS_ATTRIBUTION",
    causalClaim: false,
    asset: input.asset,
    market: input.market,
    contributionUnit: "EXECUTED_ADD_FILL",
    contributions: normalized,
    aggregate: aggregate("REGIME", "ALL", normalized, input.breakevenToleranceKrw),
    cohorts: {
      byRegime: aggregateDimension("REGIME", normalized, input.breakevenToleranceKrw, (item) => item.regime),
      byAtrShock: aggregateDimension("ATR_SHOCK", normalized, input.breakevenToleranceKrw, (item) => String(item.atrShock)),
      byWeakeningStage: aggregateDimension("WEAKENING_STAGE", normalized, input.breakevenToleranceKrw, (item) => item.weakeningStage),
      byTrendAlignmentScore: aggregateDimension("TREND_ALIGNMENT_SCORE", normalized, input.breakevenToleranceKrw, (item) => String(item.trendAlignmentScore)),
      byAddOrdinal: aggregateDimension("ADD_ORDINAL", normalized.filter((item) => item.addOrdinalWithinEpisode !== null), input.breakevenToleranceKrw, (item) => String(item.addOrdinalWithinEpisode)),
    },
    policySuppressedCohorts: input.policySuppressionEvidence
      .map((policy) => {
        const suppressedDecisions = [...policy.suppressedDecisions].sort((left, right) => {
          const epochOrder = compareEpochs(left.generatedAt, right.generatedAt);
          return epochOrder !== 0
            ? epochOrder
            : stableUnique(left.evidenceIds).join("\u0000").localeCompare(stableUnique(right.evidenceIds).join("\u0000"));
        });
        const matched = suppressedDecisions.flatMap((decision) => normalized.filter((item) => sameInstant(item.generatedAt, decision.generatedAt)));
        return {
          policyId: policy.policyId,
          suppressionEvidenceIds: stableUnique(suppressedDecisions.flatMap((decision) => decision.evidenceIds)),
          metrics: aggregate("POLICY_SUPPRESSED", policy.policyId, matched, input.breakevenToleranceKrw),
        };
      })
      .sort((left, right) => left.policyId.localeCompare(right.policyId)),
  };
}

function validateInput(input: AddLossAttributionInput): void {
  if (getMarketForAsset(input.asset) !== input.market) throw new Error(`ADD loss attribution market ${input.market} does not match asset ${input.asset}.`);
  if (input.diagnostics.asset !== input.asset || input.excursions.asset !== input.asset) throw new Error("ADD loss attribution asset evidence does not match input asset.");
  if (input.diagnostics.market !== input.market || input.excursions.market !== input.market) throw new Error("ADD loss attribution market evidence does not match input market.");
  if (!Number.isFinite(input.breakevenToleranceKrw) || input.breakevenToleranceKrw < 0) throw new Error("breakevenToleranceKrw must be finite and non-negative.");

  const exposureIds = new Set<string>();
  const executedFillIds = new Set<string>();
  for (const exposure of input.diagnostics.exposures) {
    if (exposureIds.has(exposure.id)) throw new Error(`Duplicate ADD exposure id ${exposure.id}.`);
    exposureIds.add(exposure.id);
    requireTimestamp(exposure.generatedAt, `ADD exposure ${exposure.id} generatedAt`);
    validateExposureNumbers(exposure);
    if (
      exposure.pairingStatus === "EXECUTED_VS_SUPPRESSED" &&
      exposure.baseline.action === "ADD" &&
      exposure.baseline.executed === true &&
      exposure.baseline.fillId !== null
    ) {
      if (executedFillIds.has(exposure.baseline.fillId)) {
        throw new Error(`Duplicate executed ADD fill id ${exposure.baseline.fillId}.`);
      }
      executedFillIds.add(exposure.baseline.fillId);
    }
  }
  const policyIds = new Set<AddPolicyId>();
  for (const policy of input.policySuppressionEvidence) {
    if (policyIds.has(policy.policyId)) throw new Error(`Duplicate ADD policy suppression evidence ${policy.policyId}.`);
    policyIds.add(policy.policyId);
    const decisionEpochs = new Set<string>();
    for (const decision of policy.suppressedDecisions) {
      if (decision.evidenceIds.length === 0 || decision.evidenceIds.some((evidenceId) => evidenceId.trim().length === 0)) {
        throw new Error(`Policy ${policy.policyId} suppression evidence id must be non-blank.`);
      }
      const epoch = timestampEpoch(decision.generatedAt, `Policy ${policy.policyId} suppression generatedAt`);
      if (decisionEpochs.has(epoch)) throw new Error(`Duplicate ADD policy suppression instant for ${policy.policyId}.`);
      decisionEpochs.add(epoch);
      if (!input.diagnostics.exposures.some((exposure) => sameInstant(exposure.generatedAt, decision.generatedAt))) {
        throw new Error(`Policy ${policy.policyId} suppression does not match an ADD exposure at ${decision.generatedAt}.`);
      }
    }
  }
}

function validateExposureNumbers(exposure: AddDecisionExposure): void {
  if (!Number.isInteger(exposure.originalEvidence.trendAlignmentScore) || exposure.originalEvidence.trendAlignmentScore < 0) {
    throw new Error(`ADD exposure ${exposure.id} trend alignment score must be a non-negative integer.`);
  }
  const impact = exposure.costAndFeeImpact;
  validateNullablePositive(impact.entryNotionalKrw, `ADD exposure ${exposure.id} entry notional`);
  validateNullableNonNegative(impact.entryFeeKrw, `ADD exposure ${exposure.id} entry fee`);
  validateNullableNonNegative(impact.realizedQuantity, `ADD exposure ${exposure.id} realized quantity`);
  validateNullableNonNegative(impact.remainingQuantity, `ADD exposure ${exposure.id} remaining quantity`);
  validateNullableFinite(impact.realizedGrossPnlBeforeFeesKrw, `ADD exposure ${exposure.id} gross contribution`);
  validateNullableNonNegative(impact.allocatedEntryFeeKrw, `ADD exposure ${exposure.id} allocated entry fee`);
  validateNullableNonNegative(impact.allocatedExitFeeKrw, `ADD exposure ${exposure.id} allocated exit fee`);
  validateNullableNonNegative(impact.realizedFeeImpactKrw, `ADD exposure ${exposure.id} realized fee impact`);
  validateNullableFinite(impact.realizedNetPnlKrw, `ADD exposure ${exposure.id} net contribution`);
  if (impact.completeness === "COMPLETE") {
    if (
      impact.entryFeeKrw === null || impact.realizedGrossPnlBeforeFeesKrw === null ||
      impact.allocatedEntryFeeKrw === null || impact.allocatedExitFeeKrw === null ||
      impact.realizedFeeImpactKrw === null || impact.realizedNetPnlKrw === null
    ) {
      throw new Error(`ADD exposure ${exposure.id} COMPLETE fee evidence is missing a required fee component.`);
    }
    if (impact.realizationSliceIds.length === 0) {
      throw new Error(`ADD exposure ${exposure.id} COMPLETE fee evidence requires realization slice evidence.`);
    }
    const expectedFeeImpact = impact.allocatedEntryFeeKrw + impact.allocatedExitFeeKrw;
    if (Math.abs(expectedFeeImpact - impact.realizedFeeImpactKrw) > KRW_TOLERANCE) {
      throw new Error(`ADD exposure ${exposure.id} fee impact contradicts allocated fees.`);
    }
    const expectedNet = impact.realizedGrossPnlBeforeFeesKrw - impact.realizedFeeImpactKrw;
    if (Math.abs(expectedNet - impact.realizedNetPnlKrw) > KRW_TOLERANCE) {
      throw new Error(`ADD exposure ${exposure.id} net contribution contradicts gross and fees.`);
    }
  }
}

function mapExcursions(exposures: readonly AddPostDecisionExcursion[], market: SupportedMarket): Map<string, AddPostDecisionExcursion> {
  const result = new Map<string, AddPostDecisionExcursion>();
  for (const excursion of exposures) {
    if (result.has(excursion.exposureId)) throw new Error(`Duplicate ADD excursion exposure id ${excursion.exposureId}.`);
    requireTimestamp(excursion.evidence.decisionAt, `ADD excursion ${excursion.exposureId} decisionAt`);
    validateMetric(excursion.maeKrw, `ADD excursion ${excursion.exposureId} MAE`);
    validateMetric(excursion.mfeKrw, `ADD excursion ${excursion.exposureId} MFE`);
    result.set(excursion.exposureId, excursion);
  }
  return result;
}

function normalizeContribution(exposure: AddDecisionExposure, excursion: AddPostDecisionExcursion): AddLossAttributionContribution {
  if (!sameInstant(exposure.generatedAt, excursion.evidence.decisionAt)) throw new Error(`ADD excursion ${excursion.exposureId} decision timestamp does not match exposure ${exposure.id}.`);
  if (exposure.baseline.fillId !== excursion.evidence.baselineFillId) throw new Error(`ADD excursion ${excursion.exposureId} fill evidence does not match exposure ${exposure.id}.`);
  if ((exposure.baselineEpisode?.episodeId ?? null) !== excursion.evidence.episodeId) throw new Error(`ADD excursion ${excursion.exposureId} episode evidence does not match exposure ${exposure.id}.`);

  const isExecutedAddFill = exposure.pairingStatus === "EXECUTED_VS_SUPPRESSED"
    && exposure.baseline.action === "ADD"
    && exposure.baseline.executed === true
    && exposure.baseline.fillId !== null;
  if (exposure.pairingStatus === "EXECUTED_VS_SUPPRESSED" && !isExecutedAddFill) {
    throw new Error(`ADD exposure ${exposure.id} has corrupt executed ADD lifecycle evidence.`);
  }

  const impact = exposure.costAndFeeImpact;
  const grossValue = impact.realizedGrossPnlBeforeFeesKrw;
  const feeValue = impact.realizedFeeImpactKrw;
  const netValue = impact.realizedNetPnlKrw;
  const fullySpecified = impact.completeness === "COMPLETE"
    && impact.status === "AVAILABLE"
    && grossValue !== null
    && impact.allocatedEntryFeeKrw !== null
    && impact.allocatedExitFeeKrw !== null
    && feeValue !== null
    && netValue !== null
    && impact.realizationSliceIds.length > 0;
  const gross = grossValue !== null && impact.realizationSliceIds.length > 0
    ? known(grossValue)
    : unknown(impact.completeness);
  const fee = fullySpecified && feeValue !== null ? known(feeValue) : unknown(impact.completeness);
  const net = fullySpecified && netValue !== null ? known(netValue) : unknown(impact.completeness);
  const lifecycleState = lifecycle(impact.realizedQuantity, impact.remainingQuantity, exposure.baseline.fillId !== null && exposure.baselineEpisode !== null);

  return {
    exposureId: exposure.id,
    generatedAt: exposure.generatedAt,
    fillId: exposure.baseline.fillId,
    episodeId: exposure.baselineEpisode?.episodeId ?? null,
    isExecutedAddFill,
    regime: exposure.originalEvidence.regime,
    atrShock: exposure.originalEvidence.atrShock,
    weakeningStage: exposure.originalEvidence.weakeningStage,
    trendAlignmentScore: exposure.originalEvidence.trendAlignmentScore,
    addOrdinalWithinEpisode: null,
    lifecycleState,
    entryNotionalKrw: impact.entryNotionalKrw,
    realizedQuantity: impact.realizedQuantity,
    remainingQuantity: impact.remainingQuantity,
    allocatedEntryFeeKrw: impact.allocatedEntryFeeKrw,
    allocatedExitFeeKrw: impact.allocatedExitFeeKrw,
    grossRealizedContributionKrw: gross,
    confirmedFeeImpactKrw: fee,
    netRealizedContributionKrw: net,
    realizationSliceIds: [...impact.realizationSliceIds],
    postDecisionExcursion: {
      status: excursion.status,
      reason: excursion.reason,
      maeKrw: excursion.maeKrw,
      mfeKrw: excursion.mfeKrw,
      evidenceIds: stableUnique([excursion.exposureId, ...excursion.evidence.candleIntervals]),
      provenance: { ...excursion.provenance },
    },
  };
}

function deriveEpisodeOrdinals(contributions: readonly AddLossAttributionContribution[]): Map<string, number> {
  const byEpisode = new Map<string, AddLossAttributionContribution[]>();
  for (const contribution of contributions) {
    if (!contribution.isExecutedAddFill || contribution.fillId === null || contribution.episodeId === null) continue;
    const entries = byEpisode.get(contribution.episodeId) ?? [];
    entries.push(contribution);
    byEpisode.set(contribution.episodeId, entries);
  }
  const result = new Map<string, number>();
  for (const entries of byEpisode.values()) {
    entries.sort(compareContributions).forEach((entry, index) => result.set(entry.exposureId, index + 1));
  }
  return result;
}

function aggregateDimension(
  dimension: AddLossAttributionCohort["dimension"],
  contributions: readonly AddLossAttributionContribution[],
  tolerance: number,
  valueOf: (contribution: AddLossAttributionContribution) => string,
): readonly AddLossAttributionCohort[] {
  const grouped = new Map<string, AddLossAttributionContribution[]>();
  for (const contribution of contributions) {
    const value = valueOf(contribution);
    const entries = grouped.get(value) ?? [];
    entries.push(contribution);
    grouped.set(value, entries);
  }
  return [...grouped.entries()]
    .map(([value, entries]) => aggregate(dimension, value, entries, tolerance))
    .sort((left, right) => dimension === "ADD_ORDINAL"
      ? Number(left.value) - Number(right.value)
      : left.value.localeCompare(right.value));
}

function aggregate(
  dimension: AddLossAttributionCohort["dimension"],
  value: string,
  contributions: readonly AddLossAttributionContribution[],
  tolerance: number,
): AddLossAttributionCohort {
  const executed = contributions.filter((item) => item.isExecutedAddFill);
  const knownGross = executed.filter((item) => item.grossRealizedContributionKrw.status === "KNOWN");
  const knownNet = executed.filter((item) => item.netRealizedContributionKrw.status === "KNOWN");
  const knownFees = executed.filter((item) => item.confirmedFeeImpactKrw.status === "KNOWN");
  return {
    dimension,
    value,
    executedAddCount: executed.length,
    fullyRealizedAddCount: executed.filter((item) => item.lifecycleState === "FULLY_REALIZED").length,
    partiallyRealizedAddCount: executed.filter((item) => item.lifecycleState === "PARTIALLY_REALIZED").length,
    unrealizedAddCount: executed.filter((item) => item.lifecycleState === "UNREALIZED").length,
    unavailableLifecycleAddCount: executed.filter((item) => item.lifecycleState === "UNAVAILABLE").length,
    knownGrossContributionCount: knownGross.length,
    knownNetContributionCount: knownNet.length,
    positiveNetContributionCount: knownNet.filter((item) => valueOfMetric(item.netRealizedContributionKrw) > tolerance).length,
    negativeNetContributionCount: knownNet.filter((item) => valueOfMetric(item.netRealizedContributionKrw) < -tolerance).length,
    breakevenNetContributionCount: knownNet.filter((item) => Math.abs(valueOfMetric(item.netRealizedContributionKrw)) <= tolerance).length,
    grossRealizedContributionKrw: aggregateMetric(executed.map((item) => item.grossRealizedContributionKrw)),
    confirmedFeeImpactKrw: aggregateMetric(executed.map((item) => item.confirmedFeeImpactKrw)),
    netRealizedContributionKrw: aggregateMetric(executed.map((item) => item.netRealizedContributionKrw)),
    meanKnownGrossContributionKrw: aggregateMean(executed.map((item) => item.grossRealizedContributionKrw)),
    meanKnownNetContributionKrw: aggregateMean(executed.map((item) => item.netRealizedContributionKrw)),
    realizedQuantity: aggregateQuantity(executed.map((item) => item.realizedQuantity)),
    remainingQuantity: aggregateQuantity(executed.map((item) => item.remainingQuantity)),
    maeKrw: summarizeExcursion(executed.map((item) => item.postDecisionExcursion.maeKrw)),
    mfeKrw: summarizeExcursion(executed.map((item) => item.postDecisionExcursion.mfeKrw)),
    evidenceIds: executed.map((item) => item.exposureId),
    evidence: executed.map((item) => ({
      exposureId: item.exposureId,
      fillId: item.fillId,
      episodeId: item.episodeId,
      realizationSliceIds: item.realizationSliceIds,
      excursionExposureId: item.exposureId,
      datasetSha256: item.postDecisionExcursion.provenance.datasetSha256,
      source: item.postDecisionExcursion.provenance.source,
      historyStartAt: item.postDecisionExcursion.provenance.historyStartAt,
      endAt: item.postDecisionExcursion.provenance.endAt,
    })),
  };
}

function lifecycle(realized: number | null, remaining: number | null, hasLifecycle: boolean): AddContributionLifecycleState {
  if (!hasLifecycle || realized === null || remaining === null) return "UNAVAILABLE";
  if (realized <= PERFORMANCE_QUANTITY_TOLERANCE) return "UNREALIZED";
  return remaining <= PERFORMANCE_QUANTITY_TOLERANCE ? "FULLY_REALIZED" : "PARTIALLY_REALIZED";
}

function summarizeExcursion(values: readonly Metric<number>[]): AddExcursionSummary {
  const knownValues = values.filter((value): value is { status: "KNOWN"; value: number } => value.status === "KNOWN").map((value) => value.value);
  return knownValues.length === 0
    ? { knownCount: 0, mean: null, min: null, max: null }
    : { knownCount: knownValues.length, mean: sum(knownValues) / knownValues.length, min: Math.min(...knownValues), max: Math.max(...knownValues) };
}

function compareContributions(left: AddLossAttributionContribution, right: AddLossAttributionContribution): number {
  const timeOrder = comparePerformanceTimestamps(left.generatedAt, right.generatedAt);
  if (timeOrder !== 0) return timeOrder;
  const leftFill = left.fillId ?? "";
  const rightFill = right.fillId ?? "";
  return leftFill.localeCompare(rightFill) || left.exposureId.localeCompare(right.exposureId);
}

function sameInstant(left: string, right: string): boolean {
  return timestampEpoch(left, "timestamp") === timestampEpoch(right, "timestamp");
}

function timestampEpoch(value: string, label: string): string {
  requireTimestamp(value, label);
  return performanceTimestampEpochNanoseconds(value).toString();
}

function compareEpochs(left: string, right: string): number {
  const leftEpoch = performanceTimestampEpochNanoseconds(left);
  const rightEpoch = performanceTimestampEpochNanoseconds(right);
  return leftEpoch < rightEpoch ? -1 : leftEpoch > rightEpoch ? 1 : 0;
}

function requireTimestamp(value: string, label: string): void {
  if (parsePerformanceTimestamp(value) === null) throw new Error(`${label} must have an explicit timezone.`);
}

function validateMetric(metric: Metric<number>, label: string): void {
  if (metric.status === "KNOWN" && !Number.isFinite(metric.value)) throw new Error(`${label} must be finite when known.`);
}

function validateNullableFinite(value: number | null, label: string): void {
  if (value !== null && !Number.isFinite(value)) throw new Error(`${label} must be finite when known.`);
}

function validateNullableNonNegative(value: number | null, label: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`${label} must be finite and non-negative when known.`);
}

function validateNullablePositive(value: number | null, label: string): void {
  if (value !== null && (!Number.isFinite(value) || value <= 0)) throw new Error(`${label} must be finite and positive when known.`);
}

function known(value: number): Metric<number> { return { status: "KNOWN", value }; }
function unknown(reason: string): Metric<number> { return { status: "UNKNOWN", reasons: [reason] }; }
function aggregateMetric(values: readonly Metric<number>[]): AddAggregateMetric {
  const knownValues = values.filter((value): value is { status: "KNOWN"; value: number } => value.status === "KNOWN").map((value) => value.value);
  return aggregateValues(knownValues, values.length, "NO_KNOWN_CONTRIBUTIONS", "INCOMPLETE_CONTRIBUTION_EVIDENCE");
}

function aggregateMean(values: readonly Metric<number>[]): AddAggregateMetric {
  const knownValues = values.filter((value): value is { status: "KNOWN"; value: number } => value.status === "KNOWN").map((value) => value.value);
  const aggregate = aggregateValues(knownValues, values.length, "NO_KNOWN_CONTRIBUTIONS", "INCOMPLETE_CONTRIBUTION_EVIDENCE");
  return {
    ...aggregate,
    knownSubtotal: knownValues.length === 0 ? aggregate.knownSubtotal : known(sum(knownValues) / knownValues.length),
    total: aggregate.completeness === "COMPLETE" && knownValues.length > 0 ? known(sum(knownValues) / knownValues.length) : aggregate.total,
  };
}

function aggregateQuantity(values: readonly (number | null)[]): AddAggregateQuantity {
  const knownValues = values.filter((value): value is number => value !== null);
  return aggregateValues(knownValues, values.length, "NO_KNOWN_QUANTITIES", "INCOMPLETE_QUANTITY_EVIDENCE");
}

function aggregateValues(
  knownValues: readonly number[],
  totalCount: number,
  noKnownReason: string,
  incompleteReason: string,
): AddAggregateMetric {
  const unknownCount = totalCount - knownValues.length;
  const completeness: AddAggregateCompleteness = totalCount === 0 || knownValues.length === 0
    ? "UNKNOWN"
    : unknownCount === 0
      ? "COMPLETE"
      : "PARTIAL";
  const knownSubtotal = knownValues.length === 0 ? unknown(noKnownReason) : known(sum(knownValues));
  return {
    completeness,
    knownCount: knownValues.length,
    unknownCount,
    knownSubtotal,
    total: totalCount === 0 || completeness === "COMPLETE" ? knownSubtotal : unknown(incompleteReason),
  };
}
function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }
function valueOfMetric(metric: Metric<number>): number { return metric.status === "KNOWN" ? metric.value : 0; }
function stableUnique(values: readonly string[]): readonly string[] { return [...new Set(values)].sort((left, right) => left.localeCompare(right)); }
