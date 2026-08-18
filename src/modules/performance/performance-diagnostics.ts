import type { PerformanceMarket, PerformanceOpeningPosition } from "./performance-calculator.js";
import {
  PERFORMANCE_QUANTITY_TOLERANCE,
  matchPerformanceTrades,
  type PerformanceTradeMatchResult,
} from "./performance-trade-matcher.js";
import type {
  FifoRealizationSlice,
  PerformanceDecisionAction,
  PerformanceTradeFill,
  PositionEpisode,
} from "./performance-trade-matcher.js";
import {
  compareEpochNanoseconds,
  comparePerformanceTimestamps,
  parsePerformanceTimestamp,
  performanceTimestampDifferenceMs,
  performanceTimestampEpochNanoseconds,
} from "./performance-timestamp.js";

export type Metric<T> =
  | { status: "KNOWN"; value: T }
  | { status: "UNKNOWN"; reasons: readonly string[] }
  | { status: "NOT_APPLICABLE"; reason: string };

export type PerformanceDiagnosticPolicy = {
  breakevenToleranceKrw: number;
};

export type PerformanceMarkObservation = {
  snapshotId: string;
  capturedAt: string;
  prices: Partial<Record<PerformanceMarket, number>>;
};

export type PerformanceDiagnosticsInput = {
  fills: readonly PerformanceTradeFill[];
  openingPositions?: readonly PerformanceOpeningPosition[];
  policy: PerformanceDiagnosticPolicy;
  markObservations?: readonly PerformanceMarkObservation[];
};

export type OutcomeCounts = { win: number; loss: number; breakeven: number };
export type HoldingDurationSummary = { average: number; min: number; max: number };
export type EpisodeExtreme = {
  episodeId: string;
  market: PerformanceMarket;
  openedAt: string;
  closedAt: string;
  netPnlKrw: number;
};

export type ActionContribution = {
  sliceCount: number;
  quantity: number;
  grossPnlKrw: Metric<number>;
  netPnlKrw: Metric<number>;
};

export type ActionContributionMap = Record<
  PerformanceDecisionAction | "UNKNOWN",
  ActionContribution
>;

export type PerformanceDiagnosticGroup = {
  completedEpisodeCount: number;
  openEpisodeCount: number;
  episodeOutcomes: Metric<OutcomeCounts>;
  episodeWinRate: Metric<number>;
  averageWinKrw: Metric<number>;
  averageLossKrw: Metric<number>;
  averageNetPnlKrw: Metric<number>;
  payoffRatio: Metric<number>;
  profitFactor: Metric<number>;
  selectedSliceCount: number;
  sliceOutcomes: Metric<OutcomeCounts>;
  sliceWinRate: Metric<number>;
  grossRealizedPnlKrw: Metric<number>;
  realizedFeeImpactKrw: Metric<number>;
  netRealizedPnlKrw: Metric<number>;
  turnoverKrw: Metric<number>;
  confirmedFeesKrw: Metric<number>;
  feeCompleteness: "COMPLETE" | "INCOMPLETE" | "ATTRIBUTION_UNKNOWN";
  maxConsecutiveWins: Metric<number>;
  maxConsecutiveLosses: Metric<number>;
  holdingDurationMs: Metric<HoldingDurationSummary>;
  bestCompletedEpisode: Metric<EpisodeExtreme>;
  worstCompletedEpisode: Metric<EpisodeExtreme>;
  entryActionContribution: ActionContributionMap;
  exitActionContribution: ActionContributionMap;
};

export type RealizedPnlPoint = {
  observedAt: string;
  cumulativePnlKrw: number;
  drawdownKrw: number;
};

export type MarkPnlPoint = {
  snapshotId: string;
  observedAt: string;
  attributedPnlKrw: number;
  drawdownKrw: number;
};

export type MarkValuationMetricScope = "GROSS" | "NET";

export type MarkValuationExclusionReason =
  | "MISSING_ACTIVE_POSITION_MARK"
  | "INCOMPLETE_ACQUISITION_COST"
  | "INCOMPLETE_REALIZED_GROSS_ATTRIBUTION"
  | "INCOMPLETE_REMAINING_BUY_FEE"
  | "INCOMPLETE_REALIZED_NET_ATTRIBUTION";

export type MarkObservationExclusion = {
  snapshotId: string;
  capturedAt: string;
  market: PerformanceMarket;
  metricScopes: readonly MarkValuationMetricScope[];
  reasonCodes: readonly MarkValuationExclusionReason[];
};

export type RealizedPnlCurveDiagnostics = {
  equityDefinition: "CUMULATIVE_SELECTED_STREAM_REALIZED_PNL_KRW";
  observationFrequency: "SELL_FILL_EPOCH";
  gross: Metric<readonly RealizedPnlPoint[]>;
  net: Metric<readonly RealizedPnlPoint[]>;
  maxGrossDrawdownKrw: Metric<number>;
  maxNetDrawdownKrw: Metric<number>;
};

export type MarkPnlCurveDiagnostics = {
  equityDefinition: "SELECTED_STREAM_ATTRIBUTED_PNL_KRW";
  observationFrequency: "PERSISTED_MARK_SNAPSHOT";
  gross: Metric<readonly MarkPnlPoint[]>;
  net: Metric<readonly MarkPnlPoint[]>;
  maxGrossDrawdownKrw: Metric<number>;
  maxNetDrawdownKrw: Metric<number>;
  persistedObservationCount: number;
  usableObservationCount: number;
  sampleCount: number;
  maxObservationGapMs: number | null;
  excludedObservations: readonly MarkObservationExclusion[];
};

export type PerformanceDiagnosticsResult = {
  policy: PerformanceDiagnosticPolicy;
  matchResult: PerformanceTradeMatchResult;
  markets: Record<PerformanceMarket, PerformanceDiagnosticGroup>;
  combined: PerformanceDiagnosticGroup;
  realizedPnlCurve: RealizedPnlCurveDiagnostics;
  marketRealizedPnlCurves: Record<PerformanceMarket, RealizedPnlCurveDiagnostics>;
  markPnlCurve: MarkPnlCurveDiagnostics;
  marketMarkPnlCurves: Record<PerformanceMarket, MarkPnlCurveDiagnostics>;
  warnings: readonly string[];
};

const MARKETS: readonly PerformanceMarket[] = ["KRW-BTC", "KRW-ETH"];
const ACTIONS = ["ENTER", "ADD", "REDUCE", "EXIT", "UNKNOWN"] as const;
export function diagnosePerformance(
  input: PerformanceDiagnosticsInput,
): PerformanceDiagnosticsResult {
  validateInput(input);
  const matchResult = matchPerformanceTrades({
    fills: input.fills,
    ...(input.openingPositions === undefined
      ? {}
      : { openingPositions: input.openingPositions }),
  });
  const normalizedInput: NormalizedDiagnosticsInput = {
    ...input,
    markObservations: normalizeMarkObservations(input.markObservations ?? []),
    persistedMarkObservationCount: input.markObservations?.length ?? 0,
    matchResult,
  };
  const failures = new Set(matchResult.attributionFailures.map((item) => item.market));
  const markets = Object.fromEntries(
    MARKETS.map((market) => [market, buildGroup(normalizedInput, [market], failures.has(market))]),
  ) as Record<PerformanceMarket, PerformanceDiagnosticGroup>;
  const combined = buildGroup(normalizedInput, MARKETS, failures.size > 0);
  const realizedPnlCurve = buildRealizedCurve(normalizedInput, MARKETS, failures.size > 0);
  const marketRealizedPnlCurves = Object.fromEntries(
    MARKETS.map((market) => [
      market,
      buildRealizedCurve(normalizedInput, [market], failures.has(market)),
    ]),
  ) as Record<PerformanceMarket, RealizedPnlCurveDiagnostics>;
  const markPnlCurve = buildMarkCurve(normalizedInput, MARKETS, failures);
  const marketMarkPnlCurves = Object.fromEntries(
    MARKETS.map((market) => [
      market,
      buildMarkCurve(normalizedInput, [market], failures),
    ]),
  ) as Record<PerformanceMarket, MarkPnlCurveDiagnostics>;
  const warnings: string[] = [];
  if (failures.size > 0) {
    warnings.push(
      `Selected-stream attribution is unknown after unmatched sells for ${[...failures].join(",")}.`,
    );
  }
  if (combined.feeCompleteness === "INCOMPLETE") {
    warnings.push("One or more selected fills have missing fee evidence; net metrics are unknown.");
  }
  if ((input.markObservations?.length ?? 0) === 0) {
    warnings.push("No persisted mark observations were provided; observed mark PnL is unavailable.");
  }
  return {
    policy: input.policy,
    matchResult,
    markets,
    combined,
    realizedPnlCurve,
    marketRealizedPnlCurves,
    markPnlCurve,
    marketMarkPnlCurves,
    warnings,
  };
}

type NormalizedDiagnosticsInput = PerformanceDiagnosticsInput & {
  matchResult: PerformanceTradeMatchResult;
  persistedMarkObservationCount: number;
};

function buildGroup(
  input: NormalizedDiagnosticsInput,
  markets: readonly PerformanceMarket[],
  attributionFailed: boolean,
): PerformanceDiagnosticGroup {
  const episodes = input.matchResult.episodes.filter((item) => markets.includes(item.market));
  const completed = episodes
    .filter((item) => item.status === "COMPLETED")
    .sort(compareCompletedEpisodes);
  const open = episodes.filter((item) => item.status === "OPEN");
  const slices = selectedSlices(input.matchResult, markets);
  const fills = input.fills.filter((item) => markets.includes(item.market));
  const selectedBuys = fills.filter((item) => item.side === "bid");
  const unknownReasons = attributionFailed ? ["ATTRIBUTION_FAILURE"] : [];
  const episodeValues = completed.map((item) => item.netRealizedPnlKrw);
  const episodeMetricsUnknown = attributionFailed || episodeValues.some((value) => value === null);
  const episodeOutcomes = episodeMetricsUnknown
    ? unknown<OutcomeCounts>(unknownReasons.length > 0 ? unknownReasons : ["MISSING_EPISODE_FEE"])
    : known(countOutcomes(episodeValues as number[], input.policy.breakevenToleranceKrw));
  const outcomeNumbers = episodeMetricsUnknown ? [] : (episodeValues as number[]);
  const outcomes = episodeMetricsUnknown
    ? []
    : outcomeNumbers.map((value) => classify(value, input.policy.breakevenToleranceKrw));
  const simultaneousOutcomeAmbiguity =
    !episodeMetricsUnknown && hasConflictingOutcomesAtSameCloseEpoch(completed, outcomes);
  const wins = outcomeNumbers.filter((value) => classify(value, input.policy.breakevenToleranceKrw) === "WIN");
  const losses = outcomeNumbers.filter(
    (value) => classify(value, input.policy.breakevenToleranceKrw) === "LOSS",
  );
  const sliceValues = slices.map((item) => item.netRealizedPnlKrw);
  const sliceUnknown = attributionFailed || sliceValues.some((value) => value === null);
  const grossValues = slices.map((item) => item.grossPnlBeforeFeesKrw);
  const feeValues = slices.map((item) =>
    item.allocatedBuyFeeKrw === null || item.allocatedSellFeeKrw === null
      ? null
      : item.allocatedBuyFeeKrw + item.allocatedSellFeeKrw,
  );
  const netValues = slices.map((item) => item.netRealizedPnlKrw);
  const completedKnown = completed
    .filter((item): item is PositionEpisode & { netRealizedPnlKrw: number; closedAt: string } =>
      item.netRealizedPnlKrw !== null && item.closedAt !== null,
    );
  const holding = completed.map((item) => item.holdingDurationMs);
  const holdingKnown = !attributionFailed && holding.every((value) => value !== null);
  const selectedSellFees = slices.map((slice) => slice.allocatedSellFeeKrw);
  const confirmedFees =
    selectedBuys.reduce((sum, fill) => sum + (fill.feeKrw ?? 0), 0) +
    selectedSellFees.reduce<number>((sum, fee) => sum + (fee ?? 0), 0);
  const feeMissing =
    selectedBuys.some((fill) => fill.feeKrw === null) ||
    selectedSellFees.some((fee) => fee === null);

  return {
    completedEpisodeCount: completed.length,
    openEpisodeCount: open.length,
    episodeOutcomes,
    episodeWinRate: episodeMetricsUnknown
      ? unknown(unknownReasons.length > 0 ? unknownReasons : ["MISSING_EPISODE_FEE"])
      : completed.length === 0
        ? notApplicable("NO_COMPLETED_EPISODES")
        : known(wins.length / completed.length),
    averageWinKrw: episodeMetricsUnknown
      ? unknown(unknownReasons.length > 0 ? unknownReasons : ["MISSING_EPISODE_FEE"])
      : wins.length === 0
        ? notApplicable("NO_WINNING_EPISODES")
        : known(average(wins)),
    averageLossKrw: episodeMetricsUnknown
      ? unknown(unknownReasons.length > 0 ? unknownReasons : ["MISSING_EPISODE_FEE"])
      : losses.length === 0
        ? notApplicable("NO_LOSING_EPISODES")
        : known(average(losses)),
    averageNetPnlKrw: episodeMetricsUnknown
      ? unknown(unknownReasons.length > 0 ? unknownReasons : ["MISSING_EPISODE_FEE"])
      : completed.length === 0
        ? notApplicable("NO_COMPLETED_EPISODES")
        : known(average(outcomeNumbers)),
    payoffRatio: ratioMetric(wins, losses, episodeMetricsUnknown, "PAYOFF", unknownReasons),
    profitFactor: ratioMetric(wins, losses, episodeMetricsUnknown, "PROFIT_FACTOR", unknownReasons),
    selectedSliceCount: slices.length,
    sliceOutcomes: sliceUnknown
      ? unknown(unknownReasons.length > 0 ? unknownReasons : ["MISSING_SLICE_FEE"])
      : known(countOutcomes(sliceValues as number[], input.policy.breakevenToleranceKrw)),
    sliceWinRate: sliceUnknown
      ? unknown(unknownReasons.length > 0 ? unknownReasons : ["MISSING_SLICE_FEE"])
      : slices.length === 0
        ? notApplicable("NO_SELECTED_REALIZATION_SLICES")
        : known(
            (sliceValues as number[]).filter(
              (value) => classify(value, input.policy.breakevenToleranceKrw) === "WIN",
            ).length / slices.length,
          ),
    grossRealizedPnlKrw: sumMetric(grossValues, attributionFailed, "MISSING_FIFO_COST"),
    realizedFeeImpactKrw: sumMetric(feeValues, attributionFailed, "MISSING_FILL_FEE"),
    netRealizedPnlKrw: sumMetric(netValues, attributionFailed, "MISSING_FILL_FEE"),
    turnoverKrw: attributionFailed
      ? unknown(["ATTRIBUTION_FAILURE"])
      : known(
          selectedBuys.reduce((sum, fill) => sum + fill.priceKrw * fill.volume, 0) +
            slices.reduce(
              (sum, slice) => sum + (slice.exit.priceKrw ?? 0) * slice.quantity,
              0,
            ),
        ),
    confirmedFeesKrw: attributionFailed ? unknown(["ATTRIBUTION_FAILURE"]) : known(confirmedFees),
    feeCompleteness: attributionFailed
      ? "ATTRIBUTION_UNKNOWN"
      : feeMissing
        ? "INCOMPLETE"
        : "COMPLETE",
    maxConsecutiveWins: episodeMetricsUnknown
      ? unknown(unknownReasons.length > 0 ? unknownReasons : ["MISSING_EPISODE_FEE"])
      : simultaneousOutcomeAmbiguity
        ? unknown(["AMBIGUOUS_SIMULTANEOUS_OUTCOMES"])
      : known(maxStreak(outcomes, "WIN")),
    maxConsecutiveLosses: episodeMetricsUnknown
      ? unknown(unknownReasons.length > 0 ? unknownReasons : ["MISSING_EPISODE_FEE"])
      : simultaneousOutcomeAmbiguity
        ? unknown(["AMBIGUOUS_SIMULTANEOUS_OUTCOMES"])
      : known(maxStreak(outcomes, "LOSS")),
    holdingDurationMs: attributionFailed
      ? unknown(["ATTRIBUTION_FAILURE"])
      : completed.length === 0
        ? notApplicable("NO_COMPLETED_EPISODES")
        : !holdingKnown
          ? unknown(["MISSING_HOLDING_DURATION"])
          : holdingSummary(holding as number[]),
    bestCompletedEpisode: episodeExtreme(completedKnown, "BEST", episodeMetricsUnknown, unknownReasons),
    worstCompletedEpisode: episodeExtreme(completedKnown, "WORST", episodeMetricsUnknown, unknownReasons),
    entryActionContribution: actionContributions(slices, "ENTRY", attributionFailed),
    exitActionContribution: actionContributions(slices, "EXIT", attributionFailed),
  };
}

function buildRealizedCurve(
  input: NormalizedDiagnosticsInput,
  markets: readonly PerformanceMarket[],
  attributionFailed: boolean,
): RealizedPnlCurveDiagnostics {
  const slices = selectedSlices(input.matchResult, markets);
  const grossUnknown = attributionFailed || slices.some((item) => item.grossPnlBeforeFeesKrw === null);
  const netUnknown = attributionFailed || slices.some((item) => item.netRealizedPnlKrw === null);
  const gross = grossUnknown
    ? unknown<readonly RealizedPnlPoint[]>([attributionFailed ? "ATTRIBUTION_FAILURE" : "MISSING_FIFO_COST"])
    : known(realizedPoints(slices, "grossPnlBeforeFeesKrw"));
  const net = netUnknown
    ? unknown<readonly RealizedPnlPoint[]>([attributionFailed ? "ATTRIBUTION_FAILURE" : "MISSING_FILL_FEE"])
    : known(realizedPoints(slices, "netRealizedPnlKrw"));
  return {
    equityDefinition: "CUMULATIVE_SELECTED_STREAM_REALIZED_PNL_KRW",
    observationFrequency: "SELL_FILL_EPOCH",
    gross,
    net,
    maxGrossDrawdownKrw:
      gross.status === "KNOWN" ? known(maxDrawdown(gross.value.map((item) => item.cumulativePnlKrw))) : gross,
    maxNetDrawdownKrw:
      net.status === "KNOWN" ? known(maxDrawdown(net.value.map((item) => item.cumulativePnlKrw))) : net,
  };
}

function buildMarkCurve(
  input: NormalizedDiagnosticsInput,
  markets: readonly PerformanceMarket[],
  attributionFailedMarkets: ReadonlySet<PerformanceMarket>,
): MarkPnlCurveDiagnostics {
  const observations = [...(input.markObservations ?? [])].sort(
    (left, right) => comparePerformanceTimestamps(left.capturedAt, right.capturedAt) ||
      left.snapshotId.localeCompare(right.snapshotId),
  );
  const persistedBase = {
    equityDefinition: "SELECTED_STREAM_ATTRIBUTED_PNL_KRW" as const,
    observationFrequency: "PERSISTED_MARK_SNAPSHOT" as const,
    persistedObservationCount: input.persistedMarkObservationCount,
  };
  if (observations.length === 0) {
    return {
      ...persistedBase,
      usableObservationCount: 0,
      sampleCount: 0,
      maxObservationGapMs: null,
      excludedObservations: [],
      gross: notApplicable("NO_MARK_OBSERVATIONS"),
      net: notApplicable("NO_MARK_OBSERVATIONS"),
      maxGrossDrawdownKrw: notApplicable("NO_MARK_OBSERVATIONS"),
      maxNetDrawdownKrw: notApplicable("NO_MARK_OBSERVATIONS"),
    };
  }
  const affectedMarkets = markets.filter((market) => attributionFailedMarkets.has(market));
  if (affectedMarkets.length > 0) {
    const metric = unknown<readonly MarkPnlPoint[]>(["ATTRIBUTION_FAILURE"]);
    return {
      ...persistedBase,
      usableObservationCount: 0,
      sampleCount: 0,
      maxObservationGapMs: null,
      excludedObservations: attributionFailureExclusions(observations, affectedMarkets),
      gross: metric,
      net: metric,
      maxGrossDrawdownKrw: unknown(["ATTRIBUTION_FAILURE"]),
      maxNetDrawdownKrw: unknown(["ATTRIBUTION_FAILURE"]),
    };
  }
  const grossPoints: MarkPnlPoint[] = [];
  const netPoints: MarkPnlPoint[] = [];
  const usableTimestamps: string[] = [];
  const exclusions: MarkObservationExclusion[] = [];
  let grossFailure: string | null = null;
  let netFailure: string | null = null;
  for (const observation of observations) {
    const valued = valueAtObservation(input, observation, markets);
    exclusions.push(...valued.exclusions);
    if (valued.gross === null) {
      grossFailure = "MISSING_MARK_OR_COST";
    } else {
      usableTimestamps.push(observation.capturedAt);
      grossPoints.push({
        snapshotId: observation.snapshotId,
        observedAt: observation.capturedAt,
        attributedPnlKrw: valued.gross,
        drawdownKrw: 0,
      });
    }
    if (valued.net === null) {
      netFailure = "MISSING_MARK_COST_OR_FEE";
    } else {
      netPoints.push({
        snapshotId: observation.snapshotId,
        observedAt: observation.capturedAt,
        attributedPnlKrw: valued.net,
        drawdownKrw: 0,
      });
    }
  }
  applyDrawdowns(grossPoints, "attributedPnlKrw");
  applyDrawdowns(netPoints, "attributedPnlKrw");
  const gross = grossFailure
    ? unknown<readonly MarkPnlPoint[]>([grossFailure])
    : known<readonly MarkPnlPoint[]>(grossPoints);
  const net = netFailure
    ? unknown<readonly MarkPnlPoint[]>([netFailure])
    : known<readonly MarkPnlPoint[]>(netPoints);
  return {
    ...persistedBase,
    usableObservationCount: usableTimestamps.length,
    sampleCount: usableTimestamps.length,
    maxObservationGapMs: maximumTimestampGap(usableTimestamps),
    excludedObservations: normalizeMarkExclusions(exclusions),
    gross,
    net,
    maxGrossDrawdownKrw:
      gross.status === "KNOWN"
        ? known(maxDrawdown(gross.value.map((item) => item.attributedPnlKrw)))
        : unknown(gross.status === "UNKNOWN" ? gross.reasons : [gross.reason]),
    maxNetDrawdownKrw:
      net.status === "KNOWN"
        ? known(maxDrawdown(net.value.map((item) => item.attributedPnlKrw)))
        : unknown(net.status === "UNKNOWN" ? net.reasons : [net.reason]),
  };
}

function valueAtObservation(
  input: NormalizedDiagnosticsInput,
  observation: PerformanceMarkObservation,
  markets: readonly PerformanceMarket[],
): MarkValuationResult {
  const fills = input.fills.filter(
    (fill) => comparePerformanceTimestamps(fill.filledAt, observation.capturedAt) <= 0,
  );
  const slices = selectedSlices(input.matchResult, markets).filter(
    (slice) =>
      slice.exit.occurredAt !== null &&
      comparePerformanceTimestamps(slice.exit.occurredAt, observation.capturedAt) <= 0,
  );
  let gross = 0;
  let net = 0;
  let grossAvailable = true;
  let netAvailable = true;
  const exclusions: MarkObservationExclusion[] = [];
  for (const market of markets) {
    const marketBuys = fills.filter((fill) => fill.market === market && fill.side === "bid");
    const marketSlices = slices.filter((slice) => slice.market === market);
    const boughtQuantity = sum(marketBuys.map((fill) => fill.volume));
    const soldQuantity = sum(marketSlices.map((slice) => slice.quantity));
    const quantityResidue = boughtQuantity - soldQuantity;
    const remainingQuantity =
      Math.abs(quantityResidue) <= PERFORMANCE_QUANTITY_TOLERANCE
        ? 0
        : Math.max(0, quantityResidue);
    const acquisitionCost =
      sum(marketBuys.map((fill) => fill.priceKrw * fill.volume)) -
      sum(
        marketSlices.map((slice) =>
          slice.entry.priceKrw === null ? Number.NaN : slice.entry.priceKrw * slice.quantity,
        ),
      );
    const knownBuyFees = marketBuys.every((fill) => fill.feeKrw !== null);
    const remainingBuyFees = knownBuyFees
      ? sum(marketBuys.map((fill) => fill.feeKrw ?? 0)) -
        sum(marketSlices.map((slice) => slice.allocatedBuyFeeKrw ?? Number.NaN))
      : null;
    const realizedGross = sum(marketSlices.map((slice) => slice.grossPnlBeforeFeesKrw ?? Number.NaN));
    const realizedNet = sum(marketSlices.map((slice) => slice.netRealizedPnlKrw ?? Number.NaN));
    const reasons = new Map<MarkValuationExclusionReason, Set<MarkValuationMetricScope>>();
    if (!Number.isFinite(acquisitionCost)) {
      addMarkExclusionReason(reasons, "INCOMPLETE_ACQUISITION_COST", ["GROSS", "NET"]);
    }
    if (!Number.isFinite(realizedGross)) {
      addMarkExclusionReason(
        reasons,
        "INCOMPLETE_REALIZED_GROSS_ATTRIBUTION",
        ["GROSS", "NET"],
      );
    }
    if (remainingQuantity > 0 && observation.prices[market] === undefined) {
      addMarkExclusionReason(reasons, "MISSING_ACTIVE_POSITION_MARK", ["GROSS", "NET"]);
    }
    if (remainingBuyFees === null || !Number.isFinite(remainingBuyFees)) {
      addMarkExclusionReason(reasons, "INCOMPLETE_REMAINING_BUY_FEE", ["NET"]);
    }
    if (!Number.isFinite(realizedNet)) {
      addMarkExclusionReason(reasons, "INCOMPLETE_REALIZED_NET_ATTRIBUTION", ["NET"]);
    }
    if (reasons.size > 0) {
      exclusions.push(markObservationExclusion(observation, market, reasons));
    }
    const markValue = remainingQuantity * (observation.prices[market] ?? 0);
    const marketGrossAvailable =
      Number.isFinite(acquisitionCost) &&
      Number.isFinite(realizedGross) &&
      !(remainingQuantity > 0 && observation.prices[market] === undefined);
    const marketNetAvailable =
      marketGrossAvailable &&
      remainingBuyFees !== null &&
      Number.isFinite(remainingBuyFees) &&
      Number.isFinite(realizedNet);
    if (marketGrossAvailable) {
      gross += realizedGross + markValue - acquisitionCost;
    } else {
      grossAvailable = false;
      netAvailable = false;
    }
    if (marketNetAvailable) {
      net += realizedNet + markValue - acquisitionCost - remainingBuyFees;
    } else {
      netAvailable = false;
    }
  }
  return {
    gross: grossAvailable ? gross : null,
    net: netAvailable ? net : null,
    exclusions: normalizeMarkExclusions(exclusions),
  };
}

type MarkValuationResult = {
  gross: number | null;
  net: number | null;
  exclusions: readonly MarkObservationExclusion[];
};

function addMarkExclusionReason(
  reasons: Map<MarkValuationExclusionReason, Set<MarkValuationMetricScope>>,
  reason: MarkValuationExclusionReason,
  scopes: readonly MarkValuationMetricScope[],
): void {
  const stored = reasons.get(reason) ?? new Set<MarkValuationMetricScope>();
  for (const scope of scopes) stored.add(scope);
  reasons.set(reason, stored);
}

function markObservationExclusion(
  observation: PerformanceMarkObservation,
  market: PerformanceMarket,
  reasons: ReadonlyMap<MarkValuationExclusionReason, ReadonlySet<MarkValuationMetricScope>>,
): MarkObservationExclusion {
  const reasonCodes = [...reasons.keys()].sort();
  const metricScopes = [...new Set([...reasons.values()].flatMap((scopes) => [...scopes]))].sort();
  return {
    snapshotId: observation.snapshotId,
    capturedAt: observation.capturedAt,
    market,
    metricScopes,
    reasonCodes,
  };
}

function normalizeMarkExclusions(
  exclusions: readonly MarkObservationExclusion[],
): readonly MarkObservationExclusion[] {
  const unique = new Map<string, MarkObservationExclusion>();
  for (const exclusion of exclusions) {
    const metricScopes = [...exclusion.metricScopes].sort();
    const reasonCodes = [...exclusion.reasonCodes].sort();
    const normalized = { ...exclusion, metricScopes, reasonCodes };
    const key = [
      performanceTimestampEpochNanoseconds(normalized.capturedAt).toString(),
      normalized.snapshotId,
      normalized.market,
      metricScopes.join(","),
      reasonCodes.join(","),
    ].join("|");
    unique.set(key, normalized);
  }
  return [...unique.values()]
    .sort(
      (left, right) =>
        comparePerformanceTimestamps(left.capturedAt, right.capturedAt) ||
        left.snapshotId.localeCompare(right.snapshotId) ||
        left.market.localeCompare(right.market) ||
        left.metricScopes.join(",").localeCompare(right.metricScopes.join(",")) ||
        left.reasonCodes.join(",").localeCompare(right.reasonCodes.join(",")),
    )
    .map((exclusion) => ({
      ...exclusion,
      metricScopes: [...exclusion.metricScopes],
      reasonCodes: [...exclusion.reasonCodes],
    }));
}

function attributionFailureExclusions(
  observations: readonly PerformanceMarkObservation[],
  affectedMarkets: readonly PerformanceMarket[],
): readonly MarkObservationExclusion[] {
  const exclusions = observations.flatMap((observation) =>
    affectedMarkets.map((market) => ({
      snapshotId: observation.snapshotId,
      capturedAt: observation.capturedAt,
      market,
      metricScopes: ["GROSS", "NET"] as const,
      reasonCodes: [
        "INCOMPLETE_REALIZED_GROSS_ATTRIBUTION",
        "INCOMPLETE_REALIZED_NET_ATTRIBUTION",
      ] as const,
    })),
  );
  return normalizeMarkExclusions(exclusions);
}

function actionContributions(
  slices: readonly FifoRealizationSlice[],
  dimension: "ENTRY" | "EXIT",
  attributionFailed: boolean,
): ActionContributionMap {
  const result = Object.fromEntries(
    ACTIONS.map((action) => [
      action,
      {
        sliceCount: 0,
        quantity: 0,
        grossPnlKrw: known(0),
        netPnlKrw: known(0),
      },
    ]),
  ) as ActionContributionMap;
  for (const slice of slices) {
    const rawAction = dimension === "ENTRY" ? slice.entry.decisionAction : slice.exit.decisionAction;
    const action = rawAction ?? "UNKNOWN";
    const target = result[action];
    target.sliceCount += 1;
    target.quantity += slice.quantity;
    target.grossPnlKrw = addMetric(target.grossPnlKrw, slice.grossPnlBeforeFeesKrw, "MISSING_FIFO_COST");
    target.netPnlKrw = addMetric(target.netPnlKrw, slice.netRealizedPnlKrw, "MISSING_FILL_FEE");
  }
  if (attributionFailed) {
    for (const action of ACTIONS) {
      result[action].grossPnlKrw = unknown(["ATTRIBUTION_FAILURE"]);
      result[action].netPnlKrw = unknown(["ATTRIBUTION_FAILURE"]);
    }
  }
  return result;
}

function realizedPoints(
  slices: readonly FifoRealizationSlice[],
  field: "grossPnlBeforeFeesKrw" | "netRealizedPnlKrw",
): RealizedPnlPoint[] {
  const grouped = new Map<string, { epochNanoseconds: bigint; observedAt: string; pnl: number }>();
  for (const slice of slices) {
    const observedAt = slice.exit.occurredAt;
    const value = slice[field];
    if (observedAt === null || value === null) {
      throw new Error("Cannot build a known realized curve from incomplete slices.");
    }
    const epochNanoseconds = performanceTimestampEpochNanoseconds(observedAt);
    const key = epochNanoseconds.toString();
    const current = grouped.get(key);
    if (current) {
      current.pnl += value;
      if (observedAt < current.observedAt) current.observedAt = observedAt;
    } else {
      grouped.set(key, { epochNanoseconds, observedAt, pnl: value });
    }
  }
  let cumulative = 0;
  const points = [...grouped.entries()]
    .sort(([, left], [, right]) =>
      compareEpochNanoseconds(left.epochNanoseconds, right.epochNanoseconds),
    )
    .map(([, item]) => {
      cumulative += item.pnl;
      return { observedAt: item.observedAt, cumulativePnlKrw: cumulative, drawdownKrw: 0 };
    });
  applyDrawdowns(points, "cumulativePnlKrw");
  return points;
}

function selectedSlices(
  matchResult: PerformanceTradeMatchResult,
  markets: readonly PerformanceMarket[],
): FifoRealizationSlice[] {
  return matchResult.realizationSlices.filter(
    (item) => item.source === "SELECTED_STREAM" && markets.includes(item.market),
  );
}

function ratioMetric(
  wins: readonly number[],
  losses: readonly number[],
  isUnknown: boolean,
  kind: "PAYOFF" | "PROFIT_FACTOR",
  reasons: readonly string[],
): Metric<number> {
  if (isUnknown) return unknown(reasons.length > 0 ? reasons : ["MISSING_EPISODE_FEE"]);
  if (losses.length === 0) return notApplicable("ZERO_GROSS_LOSS");
  if (wins.length === 0) {
    return kind === "PROFIT_FACTOR" ? known(0) : notApplicable("NO_WINNING_EPISODES");
  }
  const numerator = kind === "PAYOFF" ? average(wins) : sum(wins);
  const denominator = kind === "PAYOFF" ? Math.abs(average(losses)) : Math.abs(sum(losses));
  return known(numerator / denominator);
}

function episodeExtreme(
  episodes: readonly (PositionEpisode & { netRealizedPnlKrw: number; closedAt: string })[],
  kind: "BEST" | "WORST",
  isUnknown: boolean,
  reasons: readonly string[],
): Metric<EpisodeExtreme> {
  if (isUnknown) return unknown(reasons.length > 0 ? reasons : ["MISSING_EPISODE_FEE"]);
  if (episodes.length === 0) return notApplicable("NO_COMPLETED_EPISODES");
  const ordered = [...episodes].sort((left, right) =>
    kind === "BEST"
      ? right.netRealizedPnlKrw - left.netRealizedPnlKrw
      : left.netRealizedPnlKrw - right.netRealizedPnlKrw,
  );
  const episode = ordered[0];
  if (!episode) return notApplicable("NO_COMPLETED_EPISODES");
  return known({
    episodeId: episode.id,
    market: episode.market,
    openedAt: episode.openedAt,
    closedAt: episode.closedAt,
    netPnlKrw: episode.netRealizedPnlKrw,
  });
}

function countOutcomes(values: readonly number[], tolerance: number): OutcomeCounts {
  const result = { win: 0, loss: 0, breakeven: 0 };
  for (const value of values) {
    const outcome = classify(value, tolerance);
    if (outcome === "WIN") result.win += 1;
    else if (outcome === "LOSS") result.loss += 1;
    else result.breakeven += 1;
  }
  return result;
}

function classify(value: number, tolerance: number): "WIN" | "LOSS" | "BREAKEVEN" {
  if (value > tolerance) return "WIN";
  if (value < -tolerance) return "LOSS";
  return "BREAKEVEN";
}

function maxStreak(
  outcomes: readonly ("WIN" | "LOSS" | "BREAKEVEN")[],
  target: "WIN" | "LOSS",
): number {
  let maximum = 0;
  let current = 0;
  for (const outcome of outcomes) {
    current = outcome === target ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function hasConflictingOutcomesAtSameCloseEpoch(
  episodes: readonly PositionEpisode[],
  outcomes: readonly ("WIN" | "LOSS" | "BREAKEVEN")[],
): boolean {
  const byEpoch = new Map<string, Set<"WIN" | "LOSS" | "BREAKEVEN">>();
  for (let index = 0; index < episodes.length; index += 1) {
    const episode = episodes[index];
    const outcome = outcomes[index];
    if (!episode?.closedAt || !outcome) continue;
    const epoch = performanceTimestampEpochNanoseconds(episode.closedAt).toString();
    const observed = byEpoch.get(epoch) ?? new Set<"WIN" | "LOSS" | "BREAKEVEN">();
    observed.add(outcome);
    if (observed.size > 1) return true;
    byEpoch.set(epoch, observed);
  }
  return false;
}

function holdingSummary(values: readonly number[]): Metric<HoldingDurationSummary> {
  return known({ average: average(values), min: Math.min(...values), max: Math.max(...values) });
}

function sumMetric(
  values: readonly (number | null)[],
  attributionFailed: boolean,
  missingReason: string,
): Metric<number> {
  if (attributionFailed) return unknown(["ATTRIBUTION_FAILURE"]);
  return values.some((value) => value === null)
    ? unknown([missingReason])
    : known(sum(values as number[]));
}

function addMetric(metric: Metric<number>, value: number | null, reason: string): Metric<number> {
  if (metric.status === "UNKNOWN") return metric;
  if (value === null) return unknown([reason]);
  return known((metric.status === "KNOWN" ? metric.value : 0) + value);
}

function applyDrawdowns<T extends { drawdownKrw: number }>(
  points: T[],
  valueField: keyof T,
): void {
  let peak = 0;
  for (const point of points) {
    const value = point[valueField];
    if (typeof value !== "number") throw new Error("Drawdown source must be numeric.");
    peak = Math.max(peak, value);
    point.drawdownKrw = peak - value;
  }
}

function maxDrawdown(values: readonly number[]): number {
  let peak = 0;
  let maximum = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    maximum = Math.max(maximum, peak - value);
  }
  return maximum;
}

function maximumTimestampGap(timestamps: readonly string[]): number | null {
  if (timestamps.length < 2) return null;
  let maximum = 0;
  for (let index = 1; index < timestamps.length; index += 1) {
    const current = timestamps[index];
    const previous = timestamps[index - 1];
    if (current === undefined || previous === undefined) continue;
    maximum = Math.max(maximum, performanceTimestampDifferenceMs(current, previous));
  }
  return maximum;
}

function compareCompletedEpisodes(left: PositionEpisode, right: PositionEpisode): number {
  return comparePerformanceTimestamps(
    left.closedAt ?? left.openedAt,
    right.closedAt ?? right.openedAt,
  ) ||
    left.id.localeCompare(right.id);
}

function validateInput(input: PerformanceDiagnosticsInput): void {
  const tolerance = input.policy.breakevenToleranceKrw;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error("breakevenToleranceKrw must be a finite non-negative number.");
  }
  for (const observation of input.markObservations ?? []) {
    if (observation.snapshotId.length === 0) throw new Error("snapshotId must be non-empty.");
    if (!isValidExplicitIsoTimestamp(observation.capturedAt)) {
      throw new Error("Mark capturedAt must be ISO-8601 with an explicit timezone.");
    }
    for (const [market, price] of Object.entries(observation.prices)) {
      if (!MARKETS.includes(market as PerformanceMarket)) throw new Error(`Unsupported mark market ${market}.`);
      if (!Number.isFinite(price) || (price ?? 0) <= 0) throw new Error(`Mark price for ${market} must be positive.`);
    }
  }
}

function normalizeMarkObservations(
  observations: readonly PerformanceMarkObservation[],
): PerformanceMarkObservation[] {
  const byEpoch = new Map<string, PerformanceMarkObservation>();
  for (const observation of observations) {
    const epoch = performanceTimestampEpochNanoseconds(observation.capturedAt).toString();
    const existing = byEpoch.get(epoch);
    if (!existing) {
      byEpoch.set(epoch, observation);
      continue;
    }
    const mergedPrices = mergeMarkPrices(existing.prices, observation.prices);
    if (mergedPrices === null) {
      throw new Error(
        `Conflicting mark observations at the same instant ${observation.capturedAt}.`,
      );
    }
    const representative =
      observation.snapshotId.localeCompare(existing.snapshotId) < 0 ? observation : existing;
    byEpoch.set(epoch, {
      snapshotId: representative.snapshotId,
      capturedAt: representative.capturedAt,
      prices: mergedPrices,
    });
  }
  return [...byEpoch.values()]
    .sort((left, right) =>
      comparePerformanceTimestamps(left.capturedAt, right.capturedAt) ||
      left.snapshotId.localeCompare(right.snapshotId),
    );
}

function mergeMarkPrices(
  left: Partial<Record<PerformanceMarket, number>>,
  right: Partial<Record<PerformanceMarket, number>>,
): Partial<Record<PerformanceMarket, number>> | null {
  const merged: Partial<Record<PerformanceMarket, number>> = {};
  for (const market of MARKETS) {
    const leftPrice = left[market];
    const rightPrice = right[market];
    if (leftPrice !== undefined && rightPrice !== undefined && leftPrice !== rightPrice) {
      return null;
    }
    const price = leftPrice ?? rightPrice;
    if (price !== undefined) merged[market] = price;
  }
  return merged;
}

function isValidExplicitIsoTimestamp(value: string): boolean {
  return parsePerformanceTimestamp(value) !== null;
}

function known<T>(value: T): Metric<T> {
  return { status: "KNOWN", value };
}

function unknown<T>(reasons: readonly string[]): Metric<T> {
  return { status: "UNKNOWN", reasons: [...new Set(reasons)] };
}

function notApplicable<T>(reason: string): Metric<T> {
  return { status: "NOT_APPLICABLE", reason };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: readonly number[]): number {
  return sum(values) / values.length;
}
