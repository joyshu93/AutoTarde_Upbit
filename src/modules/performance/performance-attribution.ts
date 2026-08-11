import type {
  Metric,
  PerformanceDiagnosticsResult,
} from "./performance-diagnostics.js";
import type {
  FifoRealizationSlice,
  PerformanceDecisionAction,
  PerformanceLotSource,
  PerformanceTradeMatchResult,
} from "./performance-trade-matcher.js";

export type AnalysisUnit =
  | "REALIZATION_SLICES"
  | "UNIQUE_FILL_IDS"
  | "UNIQUE_DECISION_IDS"
  | "COMPLETED_EPISODES";

export type SampleSupportStatus = "INSUFFICIENT" | "PRELIMINARY" | "SUPPORTED";

export type SampleSupport = {
  policy: "OBSERVATION_COUNT_V1";
  unit: AnalysisUnit;
  observedCount: number;
  requiredCount: 30;
  status: SampleSupportStatus;
};

export type AttributionCounts = {
  realizationSlices: number;
  uniqueFillIds: number;
  uniqueDecisionIds: number;
  completedEpisodes: number;
};

export type ObservedAction = PerformanceDecisionAction | "UNKNOWN";

export type ObservedActionContribution = {
  distinctFillIds: readonly string[];
  distinctDecisionIds: readonly string[];
  sliceCount: number;
  completedEpisodeCount: number;
  realizedQuantity: number;
  grossPnlKrw: Metric<number>;
  observedFeeImpactKrw: Metric<number>;
  netPnlKrw: Metric<number>;
};

export type ObservedActionContributionMap = Record<ObservedAction, ObservedActionContribution>;

export type AttributionTotals = {
  realizedQuantity: number;
  grossPnlKrw: Metric<number>;
  observedFeeImpactKrw: Metric<number>;
  netPnlKrw: Metric<number>;
};

export type HoldingDurationBuckets = {
  under24Hours: number;
  from24HoursToUnder3Days: number;
  from3DaysToUnder7Days: number;
  from7DaysToUnder14Days: number;
  atLeast14Days: number;
};

export type EvidenceGapCode =
  | "LEFT_CENSORED_OPENING_INVENTORY"
  | "OPEN_EPISODE_EXCLUDED_FROM_COMPLETED_ANALYSIS"
  | "INCOMPLETE_COST_EVIDENCE"
  | "INCOMPLETE_FEE_EVIDENCE";

export type EvidenceGap = {
  code: EvidenceGapCode;
  severity: "WARNING";
  scope: "ENTRY_LOT" | "POSITION_EPISODE" | "REALIZATION_SLICE";
  affectedMetrics: readonly string[];
  evidenceIds: readonly string[];
  message: string;
};

export type AttributionWarning = {
  code: "ALTERNATIVE_ATTRIBUTION_VIEWS_MUST_NOT_BE_SUMMED";
  message: string;
};

export type ObservedAttributionResult = {
  evidenceKind: "OBSERVED_LIVE_ATTRIBUTION";
  counts: AttributionCounts;
  sampleSupport: Record<AnalysisUnit, SampleSupport>;
  actionDimensions: {
    entry: {
      kind: "ENTRY_LOT_ATTRIBUTION";
      sourceContributions: {
        SELECTED_STREAM: ObservedActionContributionMap;
      };
    };
    exit: {
      kind: "EXIT_FILL_ATTRIBUTION";
      sourceContributions: Record<PerformanceLotSource, ObservedActionContributionMap>;
    };
  };
  totals: AttributionTotals;
  openingInventoryTotals: AttributionTotals;
  holdingDurationBuckets: HoldingDurationBuckets;
  evidenceGaps: readonly EvidenceGap[];
  warnings: readonly AttributionWarning[];
};

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const ACTIONS: readonly ObservedAction[] = ["ENTER", "ADD", "REDUCE", "EXIT", "UNKNOWN"];

const DOUBLE_COUNT_WARNING: AttributionWarning = {
  code: "ALTERNATIVE_ATTRIBUTION_VIEWS_MUST_NOT_BE_SUMMED",
  message: "Selected-stream entry-lot and exit-fill attribution are alternative views over the same selected-stream realization slices and must not be summed; opening-inventory exit attribution is a separate left-censored source view.",
};

export function classifySampleSupport(unit: AnalysisUnit, observedCount: number): SampleSupport {
  if (!Number.isSafeInteger(observedCount) || observedCount < 0) {
    throw new Error("observedCount must be a non-negative safe integer.");
  }

  return {
    policy: "OBSERVATION_COUNT_V1",
    unit,
    observedCount,
    requiredCount: 30,
    status:
      observedCount < 10 ? "INSUFFICIENT" : observedCount < 30 ? "PRELIMINARY" : "SUPPORTED",
  };
}

export function buildObservedAttribution(input: {
  matchResult: PerformanceTradeMatchResult;
  diagnostics: PerformanceDiagnosticsResult;
}): ObservedAttributionResult {
  validateObservedEvidence(input.matchResult);
  const counts = countEvidence(input.matchResult);
  const completedEpisodes = input.matchResult.episodes.filter((episode) => episode.status === "COMPLETED");
  const gaps = [
    ...openingInventoryGaps(input.matchResult),
    ...openEpisodeGaps(input.matchResult),
    ...incompleteCostGaps(input.matchResult),
    ...incompleteFeeGaps(input.matchResult),
  ];

  return {
    evidenceKind: "OBSERVED_LIVE_ATTRIBUTION",
    counts,
    sampleSupport: {
      REALIZATION_SLICES: classifySampleSupport("REALIZATION_SLICES", counts.realizationSlices),
      UNIQUE_FILL_IDS: classifySampleSupport("UNIQUE_FILL_IDS", counts.uniqueFillIds),
      UNIQUE_DECISION_IDS: classifySampleSupport("UNIQUE_DECISION_IDS", counts.uniqueDecisionIds),
      COMPLETED_EPISODES: classifySampleSupport("COMPLETED_EPISODES", counts.completedEpisodes),
    },
    actionDimensions: {
      entry: {
        kind: "ENTRY_LOT_ATTRIBUTION",
        sourceContributions: {
          SELECTED_STREAM: buildActionContributions(
            input.matchResult,
            "SELECTED_STREAM",
            "ENTRY",
          ),
        },
      },
      exit: {
        kind: "EXIT_FILL_ATTRIBUTION",
        sourceContributions: {
          SELECTED_STREAM: buildActionContributions(
            input.matchResult,
            "SELECTED_STREAM",
            "EXIT",
          ),
          OPENING: buildActionContributions(input.matchResult, "OPENING", "EXIT"),
        },
      },
    },
    totals: buildSourceTotals(input.matchResult, "SELECTED_STREAM"),
    openingInventoryTotals: buildSourceTotals(input.matchResult, "OPENING"),
    holdingDurationBuckets: bucketCompletedHoldingDurations(completedEpisodes),
    evidenceGaps: gaps,
    warnings: [DOUBLE_COUNT_WARNING],
  };
}

function countEvidence(matchResult: PerformanceTradeMatchResult): AttributionCounts {
  const fillIds = new Set<string>();
  const decisionIds = new Set<string>();

  for (const slice of matchResult.realizationSlices) {
    for (const evidence of [slice.entry, slice.exit]) {
      if (evidence.fillId !== null) fillIds.add(evidence.fillId);
      if (evidence.strategyDecisionId !== null) decisionIds.add(evidence.strategyDecisionId);
    }
  }

  return {
    realizationSlices: matchResult.realizationSlices.length,
    uniqueFillIds: fillIds.size,
    uniqueDecisionIds: decisionIds.size,
    completedEpisodes: matchResult.episodes.filter((episode) => episode.status === "COMPLETED").length,
  };
}

function buildSourceTotals(
  matchResult: PerformanceTradeMatchResult,
  source: PerformanceLotSource,
): AttributionTotals {
  return buildTotalsForSlices(
    matchResult,
    matchResult.realizationSlices.filter((slice) => slice.source === source),
  );
}

function buildTotalsForSlices(
  matchResult: PerformanceTradeMatchResult,
  slices: readonly FifoRealizationSlice[],
): AttributionTotals {
  return {
    realizedQuantity: slices.reduce((sum, slice) => sum + slice.quantity, 0),
    grossPnlKrw: sumObservedMetric(
      matchResult,
      slices.map((slice) => slice.grossPnlBeforeFeesKrw),
      "MISSING_FIFO_COST",
    ),
    observedFeeImpactKrw: sumObservedMetric(
      matchResult,
      feeValues(slices),
      "MISSING_FILL_FEE",
    ),
    netPnlKrw: sumObservedMetric(
      matchResult,
      slices.map((slice) => slice.netRealizedPnlKrw),
      netPnlUnknownReasons(slices),
    ),
  };
}

function buildActionContributions(
  matchResult: PerformanceTradeMatchResult,
  source: PerformanceLotSource,
  dimension: "ENTRY" | "EXIT",
): ObservedActionContributionMap {
  const completedEpisodeIds = new Set(
    matchResult.episodes
      .filter((episode) => episode.status === "COMPLETED")
      .map((episode) => episode.id),
  );
  const sourceSlices = matchResult.realizationSlices.filter((slice) => slice.source === source);

  return Object.fromEntries(ACTIONS.map((action) => {
    const slices = sourceSlices.filter((slice) =>
      (dimension === "ENTRY" ? slice.entry.decisionAction : slice.exit.decisionAction) ===
        (action === "UNKNOWN" ? null : action),
    );
    const evidence = slices.map((slice) => dimension === "ENTRY" ? slice.entry : slice.exit);
    const totals = buildTotalsForSlices(matchResult, slices);
    return [action, {
      distinctFillIds: distinctSorted(evidence.map((item) => item.fillId)),
      distinctDecisionIds: distinctSorted(evidence.map((item) => item.strategyDecisionId)),
      sliceCount: slices.length,
      completedEpisodeCount: new Set(
        slices
          .map((slice) => slice.episodeId)
          .filter((id): id is string => id !== null && completedEpisodeIds.has(id)),
      ).size,
      ...totals,
    }];
  })) as ObservedActionContributionMap;
}

function distinctSorted(values: readonly (string | null)[]): readonly string[] {
  return [...new Set(values.filter((value): value is string => value !== null))].sort();
}

function feeValues(slices: readonly FifoRealizationSlice[]): readonly (number | null)[] {
  return slices.map((slice) =>
    slice.allocatedBuyFeeKrw === null || slice.allocatedSellFeeKrw === null
      ? null
      : slice.allocatedBuyFeeKrw + slice.allocatedSellFeeKrw,
  );
}

function bucketCompletedHoldingDurations(
  episodes: readonly PerformanceTradeMatchResult["episodes"][number][],
): HoldingDurationBuckets {
  const buckets: HoldingDurationBuckets = {
    under24Hours: 0,
    from24HoursToUnder3Days: 0,
    from3DaysToUnder7Days: 0,
    from7DaysToUnder14Days: 0,
    atLeast14Days: 0,
  };

  for (const episode of episodes) {
    const holdingDurationMs = episode.holdingDurationMs;
    if (holdingDurationMs === null) continue;
    if (holdingDurationMs < DAY_MS) buckets.under24Hours += 1;
    else if (holdingDurationMs < 3 * DAY_MS) buckets.from24HoursToUnder3Days += 1;
    else if (holdingDurationMs < 7 * DAY_MS) buckets.from3DaysToUnder7Days += 1;
    else if (holdingDurationMs < 14 * DAY_MS) buckets.from7DaysToUnder14Days += 1;
    else buckets.atLeast14Days += 1;
  }

  return buckets;
}

function sumObservedMetric(
  matchResult: PerformanceTradeMatchResult,
  values: readonly (number | null)[],
  missingEvidenceReasons: readonly string[] | string,
): Metric<number> {
  if (matchResult.attributionFailures.length > 0) {
    return { status: "UNKNOWN", reasons: ["ATTRIBUTION_FAILURE"] };
  }
  if (values.some((value) => value === null)) {
    return {
      status: "UNKNOWN",
      reasons: typeof missingEvidenceReasons === "string"
        ? [missingEvidenceReasons]
        : missingEvidenceReasons,
    };
  }
  return { status: "KNOWN", value: (values as readonly number[]).reduce((sum, value) => sum + value, 0) };
}

function netPnlUnknownReasons(slices: readonly FifoRealizationSlice[]): readonly string[] {
  const reasons: string[] = [];
  if (slices.some((slice) => slice.grossPnlBeforeFeesKrw === null)) {
    reasons.push("MISSING_FIFO_COST");
  }
  if (slices.some((slice) => slice.allocatedBuyFeeKrw === null || slice.allocatedSellFeeKrw === null)) {
    reasons.push("MISSING_FILL_FEE");
  }
  if (reasons.length === 0) reasons.push("MISSING_NET_REALIZED_PNL");
  return reasons;
}

function validateObservedEvidence(matchResult: PerformanceTradeMatchResult): void {
  for (const slice of matchResult.realizationSlices) {
    assertFinitePositive(slice.quantity, `Realization slice ${slice.id} quantity`);
    assertNullableFinite(slice.grossPnlBeforeFeesKrw, `Realization slice ${slice.id} grossPnlBeforeFeesKrw`);
    assertNullableFinite(slice.netRealizedPnlKrw, `Realization slice ${slice.id} netRealizedPnlKrw`);
    assertNullableFinite(slice.allocatedBuyFeeKrw, `Realization slice ${slice.id} allocatedBuyFeeKrw`);
    assertNullableFinite(slice.allocatedSellFeeKrw, `Realization slice ${slice.id} allocatedSellFeeKrw`);
    assertNullableNonNegativeDuration(slice.holdingDurationMs, `Realization slice ${slice.id}`);
  }

  for (const episode of matchResult.episodes) {
    assertFiniteNonNegative(episode.remainingQuantity, `Episode ${episode.id} remainingQuantity`);
    assertNullableFinite(episode.grossRealizedPnlKrw, `Episode ${episode.id} grossRealizedPnlKrw`);
    assertNullableFinite(episode.realizedFeeImpactKrw, `Episode ${episode.id} realizedFeeImpactKrw`);
    assertNullableFinite(episode.netRealizedPnlKrw, `Episode ${episode.id} netRealizedPnlKrw`);
    assertNullableNonNegativeDuration(episode.holdingDurationMs, `Episode ${episode.id}`);
  }
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number.`);
  }
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
}

function assertNullableFinite(value: number | null, label: string): void {
  if (value !== null && !Number.isFinite(value)) {
    throw new Error(`${label} must be finite or null.`);
  }
}

function assertNullableNonNegativeDuration(value: number | null, label: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} holdingDurationMs must be a finite non-negative number or null.`);
  }
}

function openingInventoryGaps(matchResult: PerformanceTradeMatchResult): readonly EvidenceGap[] {
  const sliceIds = matchResult.realizationSlices
    .filter((slice) => slice.source === "OPENING")
    .map((slice) => slice.id);
  if (sliceIds.length === 0) return [];

  return [{
    code: "LEFT_CENSORED_OPENING_INVENTORY",
    severity: "WARNING",
    scope: "ENTRY_LOT",
    affectedMetrics: [
      "ENTRY_ACTION_ATTRIBUTION",
      "GROSS_PNL_KRW",
      "OBSERVED_FEE_IMPACT_KRW",
      "NET_PNL_KRW",
    ],
    evidenceIds: sliceIds,
    message: "Opening inventory predates the selected stream and is left-censored for entry attribution.",
  }];
}

function openEpisodeGaps(matchResult: PerformanceTradeMatchResult): readonly EvidenceGap[] {
  return matchResult.episodes
    .filter((episode) => episode.status === "OPEN")
    .map((episode) => ({
      code: "OPEN_EPISODE_EXCLUDED_FROM_COMPLETED_ANALYSIS" as const,
      severity: "WARNING" as const,
      scope: "POSITION_EPISODE" as const,
      affectedMetrics: ["COMPLETED_EPISODE_COUNT", "HOLDING_DURATION_BUCKETS"],
      evidenceIds: [episode.id],
      message: "Open position episodes are excluded from completed-episode holding analysis.",
    }));
}

function incompleteFeeGaps(matchResult: PerformanceTradeMatchResult): readonly EvidenceGap[] {
  const sliceIds = matchResult.realizationSlices
    .filter(
      (slice) => slice.allocatedBuyFeeKrw === null || slice.allocatedSellFeeKrw === null,
    )
    .map((slice) => slice.id);
  if (sliceIds.length === 0) return [];

  return [{
    code: "INCOMPLETE_FEE_EVIDENCE",
    severity: "WARNING",
    scope: "REALIZATION_SLICE",
    affectedMetrics: ["OBSERVED_FEE_IMPACT_KRW", "NET_PNL_KRW"],
    evidenceIds: sliceIds,
    message: "One or more realization slices have incomplete fee evidence; fee impact and net PnL remain unknown.",
  }];
}

function incompleteCostGaps(matchResult: PerformanceTradeMatchResult): readonly EvidenceGap[] {
  const sliceIds = matchResult.realizationSlices
    .filter((slice) => slice.grossPnlBeforeFeesKrw === null)
    .map((slice) => slice.id);
  if (sliceIds.length === 0) return [];

  return [{
    code: "INCOMPLETE_COST_EVIDENCE",
    severity: "WARNING",
    scope: "REALIZATION_SLICE",
    affectedMetrics: ["GROSS_PNL_KRW", "NET_PNL_KRW"],
    evidenceIds: sliceIds,
    message: "One or more realization slices have incomplete cost evidence; gross and net PnL remain unknown.",
  }];
}
