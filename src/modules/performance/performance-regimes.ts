import {
  getMarketForAsset,
  type StrategyDecisionAction,
  type SupportedAsset,
  type SupportedMarket,
} from "../../domain/types.js";
import type {
  PositionGuardBacktestFrameResult,
  PositionGuardBacktestTrade,
} from "../strategy/position-guard-backtest.js";
import type { StrategyMarketRegime } from "../strategy/position-guard-core.js";
import {
  classifySampleSupport,
  type SampleSupport,
} from "./performance-attribution.js";
import type { Metric } from "./performance-diagnostics.js";
import type { CounterfactualScenario } from "./strategy-counterfactual.js";
import {
  PERFORMANCE_QUANTITY_TOLERANCE,
  type FifoRealizationSlice,
  type PerformanceTradeEvidence,
  type PerformanceTradeFill,
  type PerformanceTradeMatchResult,
  type PositionEpisode,
} from "./performance-trade-matcher.js";
import {
  comparePerformanceTimestamps,
  parsePerformanceTimestamp,
  performanceTimestampEpochNanoseconds,
} from "./performance-timestamp.js";

export type RegimeAttributionDimension =
  | "ENTRY_REGIME_ATTRIBUTION"
  | "EXIT_REGIME_ATTRIBUTION";

export type RegimeAttributionView = {
  dimension: RegimeAttributionDimension;
  realizationSliceCount: number;
  completedEpisodeCount: number;
  grossRealizedPnlKrw: Metric<number>;
  netRealizedPnlKrw: Metric<number>;
  episodeWinRate: Metric<number>;
  profitFactor: Metric<number>;
  episodeSampleSupport: SampleSupport;
  realizationSliceSampleSupport: SampleSupport;
};

export type RegimeAggregate = {
  regime: StrategyMarketRegime;
  frameCount: number;
  decisionCounts: Record<StrategyDecisionAction, number>;
  executedFrameCount: number;
  fillCount: number;
  turnoverKrw: Metric<number>;
  costCompleteness: "COMPLETE" | "INCOMPLETE";
  feeCompleteness: "COMPLETE" | "INCOMPLETE";
  entryAttribution: RegimeAttributionView;
  exitAttribution: RegimeAttributionView;
};

export type RegimeEvidenceGap = {
  code: "LEFT_CENSORED_OPENING_INVENTORY";
  severity: "WARNING";
  scope: "ENTRY_REGIME_ATTRIBUTION";
  affectedMetrics: readonly ["entryAttribution"];
  evidenceIds: readonly string[];
  message: string;
};

export type PerformanceRegimeAnalysisInput = {
  asset: SupportedAsset;
  market: SupportedMarket;
  scenario: CounterfactualScenario;
  frames: readonly PositionGuardBacktestFrameResult[];
  fills: readonly PerformanceTradeFill[];
  matchResult: PerformanceTradeMatchResult;
  breakevenToleranceKrw: number;
};

export type PerformanceRegimeAnalysisResult = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  scenario: CounterfactualScenario;
  asset: SupportedAsset;
  market: SupportedMarket;
  regimes: Record<StrategyMarketRegime, RegimeAggregate>;
  evidenceGaps: readonly RegimeEvidenceGap[];
  warnings: readonly [{
    code: "ALTERNATIVE_REGIME_VIEWS_MUST_NOT_BE_SUMMED";
    message: string;
  }];
};

export const PERFORMANCE_REGIME_EPISODE_RECONCILIATION_TOLERANCE_KRW = 1e-9;

const REGIMES = [
  "BULL_TREND",
  "PULLBACK_IN_UPTREND",
  "EARLY_RECOVERY",
  "RECLAIM_ATTEMPT",
  "RANGE",
  "WEAK_DOWNTREND",
  "BREAKDOWN_RISK",
] as const satisfies readonly StrategyMarketRegime[];

const ACTIONS = ["ENTER", "ADD", "REDUCE", "EXIT", "HOLD"] as const satisfies readonly StrategyDecisionAction[];

const ALTERNATIVE_VIEW_WARNING = {
  code: "ALTERNATIVE_REGIME_VIEWS_MUST_NOT_BE_SUMMED" as const,
  message: "Entry-regime and exit-regime attribution are alternative attribution views and must not be summed. Their evidence sets are not always identical because opening inventory is exit-attributable but left-censored from entry attribution.",
};

export function analyzePerformanceRegimes(
  input: PerformanceRegimeAnalysisInput,
): PerformanceRegimeAnalysisResult {
  const frameByEpoch = validateInput(input);
  const fillById = new Map(input.fills.map((fill) => [fill.id, fill]));
  const frameByFillId = mapFillsToFrames(input, frameByEpoch);
  validateLifecycle(input.matchResult, fillById, frameByFillId, input.market);

  const selectedSlices = input.matchResult.realizationSlices.filter(
    (slice) => slice.source === "SELECTED_STREAM",
  );
  const allSlices = input.matchResult.realizationSlices;
  const completedEpisodes = input.matchResult.episodes.filter(
    (episode) => episode.status === "COMPLETED",
  );

  const regimes = Object.fromEntries(REGIMES.map((regime) => {
    const regimeFrames = input.frames.filter((frame) => frame.regime === regime);
    const regimeFills = input.fills.filter(
      (fill) => frameByFillId.get(fill.id)?.regime === regime,
    );
    const entrySlices = selectedSlices.filter(
      (slice) => regimeForEvidence(slice.entry, frameByFillId) === regime,
    );
    const exitSlices = allSlices.filter(
      (slice) => regimeForEvidence(slice.exit, frameByFillId) === regime,
    );
    const entryEpisodes = completedEpisodes.filter(
      (episode) => regimeForEpisode(episode, "ENTRY", frameByFillId) === regime,
    );
    const exitEpisodes = completedEpisodes.filter(
      (episode) => regimeForEpisode(episode, "EXIT", frameByFillId) === regime,
    );
    const relevantSlices = [...entrySlices, ...exitSlices];

    return [regime, {
      regime,
      frameCount: regimeFrames.length,
      decisionCounts: countDecisions(regimeFrames),
      executedFrameCount: regimeFrames.filter((frame) => frame.executed).length,
      fillCount: regimeFills.length,
      turnoverKrw: known(sumFinite(
        `${regime} turnoverKrw`,
        regimeFills.map((fill) => multiplyFinite(
          `${regime} turnoverKrw fill ${fill.id}`,
          fill.priceKrw,
          fill.volume,
        )),
      )),
      costCompleteness: relevantSlices.some((slice) => slice.grossPnlBeforeFeesKrw === null)
        ? "INCOMPLETE"
        : "COMPLETE",
      feeCompleteness:
        regimeFills.some((fill) => fill.feeKrw === null)
        || relevantSlices.some((slice) =>
          slice.allocatedBuyFeeKrw === null || slice.allocatedSellFeeKrw === null)
          ? "INCOMPLETE"
          : "COMPLETE",
      entryAttribution: buildAttributionView(
        "ENTRY_REGIME_ATTRIBUTION",
        entrySlices,
        entryEpisodes,
        input.breakevenToleranceKrw,
      ),
      exitAttribution: buildAttributionView(
        "EXIT_REGIME_ATTRIBUTION",
        exitSlices,
        exitEpisodes,
        input.breakevenToleranceKrw,
      ),
    } satisfies RegimeAggregate];
  })) as Record<StrategyMarketRegime, RegimeAggregate>;

  return {
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    scenario: input.scenario,
    asset: input.asset,
    market: input.market,
    regimes,
    evidenceGaps: openingInventoryGaps(input.matchResult),
    warnings: [ALTERNATIVE_VIEW_WARNING],
  };
}

function openingInventoryGaps(matchResult: PerformanceTradeMatchResult): RegimeEvidenceGap[] {
  const openingSliceIds = matchResult.realizationSlices
    .filter((slice) => slice.source === "OPENING")
    .map((slice) => slice.id);
  return openingSliceIds.length === 0 ? [] : [{
    code: "LEFT_CENSORED_OPENING_INVENTORY",
    severity: "WARNING",
    scope: "ENTRY_REGIME_ATTRIBUTION",
    affectedMetrics: ["entryAttribution"],
    evidenceIds: openingSliceIds,
    message: "Opening inventory realization has no observed entry regime and is excluded from entry-regime attribution.",
  }];
}

function validateInput(
  input: PerformanceRegimeAnalysisInput,
): Map<string, PositionGuardBacktestFrameResult> {
  if (getMarketForAsset(input.asset) !== input.market) {
    throw new Error(`Regime analysis market ${input.market} does not match asset ${input.asset}.`);
  }
  if (input.scenario !== "BASELINE" && input.scenario !== "NO_ADD") {
    throw new Error(`Invalid counterfactual scenario ${String(input.scenario)}.`);
  }
  if (!Number.isFinite(input.breakevenToleranceKrw) || input.breakevenToleranceKrw < 0) {
    throw new Error("breakevenToleranceKrw must be a finite non-negative number.");
  }

  const frameByEpoch = new Map<string, PositionGuardBacktestFrameResult>();
  let previousTimestamp: string | null = null;
  for (const [index, frame] of input.frames.entries()) {
    if (parsePerformanceTimestamp(frame.generatedAt) === null) {
      throw new Error(`Frame ${index} generatedAt must be an exact timestamp with an explicit timezone.`);
    }
    if (previousTimestamp !== null && comparePerformanceTimestamps(previousTimestamp, frame.generatedAt) >= 0) {
      throw new Error("Regime frames must be strictly ordered by exact instant.");
    }
    previousTimestamp = frame.generatedAt;
    if (!REGIMES.includes(frame.regime)) throw new Error(`Frame ${index} has invalid regime.`);
    if (!ACTIONS.includes(frame.decision.action)) throw new Error(`Frame ${index} has invalid decision action.`);
    assertFiniteNonNegative(frame.equityKrw, `Frame ${index} equityKrw`);
    assertFiniteNonNegative(frame.drawdownPct, `Frame ${index} drawdownPct`);
    if (frame.executed !== (frame.trade !== null)) {
      throw new Error(`Frame ${index} executed state contradicts its trade evidence.`);
    }
    if (frame.trade) {
      validateTrade(frame.trade, index);
      if (frame.decision.action !== frame.trade.action) {
        throw new Error(`Frame ${index} decision.action must equal its executed trade.action.`);
      }
    }
    const epoch = performanceTimestampEpochNanoseconds(frame.generatedAt).toString();
    if (frameByEpoch.has(epoch)) throw new Error(`Frame ${index} duplicates an exact decision instant.`);
    frameByEpoch.set(epoch, frame);
  }

  const fillIds = new Set<string>();
  for (const fill of input.fills) {
    if (fillIds.has(fill.id)) throw new Error(`Duplicate fill id ${fill.id}.`);
    fillIds.add(fill.id);
    if (fill.market !== input.market) {
      throw new Error(`Fill ${fill.id} market ${fill.market} does not match ${input.market}.`);
    }
    if (parsePerformanceTimestamp(fill.filledAt) === null) {
      throw new Error(`Fill ${fill.id} filledAt must be an exact timestamp with an explicit timezone.`);
    }
    assertFinitePositive(fill.priceKrw, `Fill ${fill.id} priceKrw`);
    assertFinitePositive(fill.volume, `Fill ${fill.id} volume`);
    if (fill.feeKrw !== null) assertFiniteNonNegative(fill.feeKrw, `Fill ${fill.id} feeKrw`);
    if (fill.strategyDecisionId === null || fill.decisionAction === null) {
      throw new Error(`Fill ${fill.id} must retain strategy decision lifecycle evidence.`);
    }
    if (
      (fill.side === "bid" && !["ENTER", "ADD"].includes(fill.decisionAction))
      || (fill.side === "ask" && !["REDUCE", "EXIT"].includes(fill.decisionAction))
    ) {
      throw new Error(`Fill ${fill.id} action contradicts its side.`);
    }
  }
  return frameByEpoch;
}

function mapFillsToFrames(
  input: PerformanceRegimeAnalysisInput,
  frameByEpoch: ReadonlyMap<string, PositionGuardBacktestFrameResult>,
): Map<string, PositionGuardBacktestFrameResult> {
  const frameByFillId = new Map<string, PositionGuardBacktestFrameResult>();
  const fillCountByEpoch = new Map<string, number>();
  for (const fill of input.fills) {
    const epoch = performanceTimestampEpochNanoseconds(fill.filledAt).toString();
    const frame = frameByEpoch.get(epoch);
    if (!frame) throw new Error(`Fill ${fill.id} has no exact source frame; nearest-frame look-ahead is forbidden.`);
    if (!frame.executed || !frame.trade) {
      throw new Error(`Fill ${fill.id} maps to a frame without executed trade evidence.`);
    }
    validateFillAgainstTrade(fill, frame.trade);
    fillCountByEpoch.set(epoch, (fillCountByEpoch.get(epoch) ?? 0) + 1);
    frameByFillId.set(fill.id, frame);
  }
  for (const [epoch, frame] of frameByEpoch) {
    const count = fillCountByEpoch.get(epoch) ?? 0;
    if (frame.executed && count !== 1) {
      throw new Error(`Executed frame ${frame.generatedAt} must map to exactly one synthetic fill.`);
    }
    if (!frame.executed && count !== 0) {
      throw new Error(`Unexecuted frame ${frame.generatedAt} cannot map to a synthetic fill.`);
    }
  }
  return frameByFillId;
}

function validateLifecycle(
  matchResult: PerformanceTradeMatchResult,
  fillById: ReadonlyMap<string, PerformanceTradeFill>,
  frameByFillId: ReadonlyMap<string, PositionGuardBacktestFrameResult>,
  market: SupportedMarket,
): void {
  if (matchResult.unmatchedSells.length > 0 || matchResult.attributionFailures.length > 0) {
    throw new Error("Regime analysis requires unambiguous matched lifecycle evidence.");
  }
  const episodeById = uniqueById(matchResult.episodes, "episode");
  const sliceById = uniqueById(matchResult.realizationSlices, "slice");
  for (const slice of matchResult.realizationSlices) {
    if (slice.market !== market) throw new Error(`Slice ${slice.id} market does not match ${market}.`);
    assertFinitePositive(slice.quantity, `Slice ${slice.id} quantity`);
    validateNullableFinite(slice.grossPnlBeforeFeesKrw, `Slice ${slice.id} gross PnL`);
    validateNullableNonNegative(slice.allocatedBuyFeeKrw, `Slice ${slice.id} allocated buy fee`);
    validateNullableNonNegative(slice.allocatedSellFeeKrw, `Slice ${slice.id} allocated sell fee`);
    validateNullableFinite(slice.netRealizedPnlKrw, `Slice ${slice.id} net PnL`);
    validateNullableNonNegative(slice.holdingDurationMs, `Slice ${slice.id} holding duration`);
    validateEvidence(slice.entry, fillById, frameByFillId, slice.id);
    validateEvidence(slice.exit, fillById, frameByFillId, slice.id);
    if (slice.exit.fillId === null) {
      throw new Error(`Slice ${slice.id} requires observed exit fill evidence.`);
    }
    if (slice.source === "OPENING") {
      if (slice.episodeId !== null || slice.entry.fillId !== null) {
        throw new Error(`Opening slice ${slice.id} has corrupt left-censored lifecycle evidence.`);
      }
      continue;
    }
    if (slice.episodeId === null) {
      throw new Error(`Selected slice ${slice.id} has no episode lifecycle reference.`);
    }
    const episode = episodeById.get(slice.episodeId);
    if (!episode) {
      throw new Error(`Selected slice ${slice.id} references missing episode ${slice.episodeId}.`);
    }
    if (!episode.realizationSliceIds.includes(slice.id)) {
      throw new Error(`Selected slice ${slice.id} is missing from its bidirectional lifecycle episode.`);
    }
    if (slice.entry.fillId === null || !episode.entryFillIds.includes(slice.entry.fillId)) {
      throw new Error(`Selected slice ${slice.id} has a cross-episode entry fill reference.`);
    }
    if (slice.exit.fillId === null || !episode.exitFillIds.includes(slice.exit.fillId)) {
      throw new Error(`Selected slice ${slice.id} has a cross-episode exit fill reference.`);
    }
  }
  for (const episode of matchResult.episodes) {
    if (episode.market !== market) throw new Error(`Episode ${episode.id} market does not match ${market}.`);
    if (parsePerformanceTimestamp(episode.openedAt) === null) throw new Error(`Episode ${episode.id} openedAt is invalid.`);
    if (episode.entryFillIds.length === 0) {
      throw new Error(`Episode ${episode.id} requires at least one entry fill.`);
    }
    const entryFills = episode.entryFillIds.map((fillId) => requireEpisodeFill(
      fillId,
      episode,
      fillById,
      frameByFillId,
      "entry",
      "bid",
    ));
    const exitFills = episode.exitFillIds.map((fillId) => requireEpisodeFill(
      fillId,
      episode,
      fillById,
      frameByFillId,
      "exit",
      "ask",
    ));
    const firstEntry = entryFills[0]!;
    if (comparePerformanceTimestamps(episode.openedAt, firstEntry.filledAt) !== 0) {
      throw new Error(`Episode ${episode.id} openedAt does not match its first entry fill.`);
    }
    assertFiniteNonNegative(episode.remainingQuantity, `Episode ${episode.id} remainingQuantity`);
    if (episode.status === "COMPLETED") {
      if (episode.closedAt === null || parsePerformanceTimestamp(episode.closedAt) === null) {
        throw new Error(`Completed episode ${episode.id} requires an exact closedAt.`);
      }
      if (comparePerformanceTimestamps(episode.openedAt, episode.closedAt) >= 0) {
        throw new Error(`Completed episode ${episode.id} must close after it opens.`);
      }
      const terminalExit = exitFills[exitFills.length - 1];
      if (!terminalExit || comparePerformanceTimestamps(episode.closedAt, terminalExit.filledAt) !== 0) {
        throw new Error(`Completed episode ${episode.id} closedAt must match its terminal exit fill.`);
      }
      if (Math.abs(episode.remainingQuantity) > PERFORMANCE_QUANTITY_TOLERANCE) {
        throw new Error(`Completed episode ${episode.id} remainingQuantity exceeds the lifecycle tolerance.`);
      }
    } else if (episode.status === "OPEN") {
      if (episode.closedAt !== null) {
        throw new Error(`Open episode ${episode.id} cannot have closedAt evidence.`);
      }
      if (episode.remainingQuantity <= PERFORMANCE_QUANTITY_TOLERANCE) {
        throw new Error(`Open episode ${episode.id} must retain positive remainingQuantity.`);
      }
    } else {
      throw new Error(`Episode ${episode.id} has invalid status ${String(episode.status)}.`);
    }
    const linkedSlices = matchResult.realizationSlices.filter((slice) => slice.episodeId === episode.id);
    if (!sameStringSet(episode.realizationSliceIds, linkedSlices.map((slice) => slice.id))) {
      throw new Error(`Episode ${episode.id} has corrupt bidirectional lifecycle slice links.`);
    }
    for (const sliceId of episode.realizationSliceIds) {
      const slice = sliceById.get(sliceId);
      if (!slice || slice.episodeId !== episode.id) {
        throw new Error(`Episode ${episode.id} has a cross-episode lifecycle slice ${sliceId}.`);
      }
    }
    if (episode.status === "COMPLETED") {
      const linkedEntryFillIds = new Set(linkedSlices.map((slice) => slice.entry.fillId));
      if (episode.entryFillIds.some((fillId) => !linkedEntryFillIds.has(fillId))) {
        throw new Error(`Completed episode ${episode.id} has an entry fill without matching slice evidence.`);
      }
    }
    const linkedExitFillIds = new Set(linkedSlices.map((slice) => slice.exit.fillId));
    if (episode.exitFillIds.some((fillId) => !linkedExitFillIds.has(fillId))) {
      throw new Error(`Episode ${episode.id} has an exit fill without matching slice evidence.`);
    }
    validateNullableFinite(episode.grossRealizedPnlKrw, `Episode ${episode.id} gross PnL`);
    validateNullableNonNegative(episode.realizedFeeImpactKrw, `Episode ${episode.id} fee impact`);
    validateNullableFinite(episode.netRealizedPnlKrw, `Episode ${episode.id} net PnL`);
    validateNullableNonNegative(episode.holdingDurationMs, `Episode ${episode.id} holding duration`);
    reconcileEpisodeAggregate(
      episode,
      "grossRealizedPnlKrw",
      linkedSlices.map((slice) => slice.grossPnlBeforeFeesKrw),
    );
    reconcileEpisodeAggregate(
      episode,
      "realizedFeeImpactKrw",
      linkedSlices.map((slice) => slice.allocatedBuyFeeKrw === null || slice.allocatedSellFeeKrw === null
        ? null
        : sumFinite(
          `Episode ${episode.id} realization slice ${slice.id} fee total`,
          [slice.allocatedBuyFeeKrw, slice.allocatedSellFeeKrw],
        )),
    );
    reconcileEpisodeAggregate(
      episode,
      "netRealizedPnlKrw",
      linkedSlices.map((slice) => slice.netRealizedPnlKrw),
    );
  }
}

function reconcileEpisodeAggregate(
  episode: PositionEpisode,
  field: "grossRealizedPnlKrw" | "realizedFeeImpactKrw" | "netRealizedPnlKrw",
  sliceValues: readonly (number | null)[],
): void {
  const actual = episode[field];
  const hasIncompleteSliceEvidence = sliceValues.some((value) => value === null);
  if (hasIncompleteSliceEvidence) {
    if (actual !== null) {
      throw new Error(
        `Episode ${episode.id} ${field} must be null when linked realization slices are incomplete.`,
      );
    }
    return;
  }
  if (actual === null) {
    throw new Error(
      `Episode ${episode.id} ${field} must equal its complete linked realization slices, not null.`,
    );
  }

  const expected = sumFinite(
    `Episode ${episode.id} ${field} linked realization slices`,
    sliceValues as number[],
  );
  const difference = Math.abs(actual - expected);
  if (
    !Number.isFinite(difference)
    || difference > PERFORMANCE_REGIME_EPISODE_RECONCILIATION_TOLERANCE_KRW
  ) {
    throw new Error(
      `Episode ${episode.id} ${field} contradicts linked realization slices beyond `
      + `${PERFORMANCE_REGIME_EPISODE_RECONCILIATION_TOLERANCE_KRW} KRW tolerance.`,
    );
  }
}

function requireEpisodeFill(
  fillId: string,
  episode: PositionEpisode,
  fillById: ReadonlyMap<string, PerformanceTradeFill>,
  frameByFillId: ReadonlyMap<string, PositionGuardBacktestFrameResult>,
  role: "entry" | "exit",
  expectedSide: "bid" | "ask",
): PerformanceTradeFill {
  const fill = fillById.get(fillId);
  if (!fill || !frameByFillId.has(fillId)) {
    throw new Error(`Episode ${episode.id} references lifecycle fill ${fillId} without a source frame.`);
  }
  if (fill.market !== episode.market || fill.side !== expectedSide) {
    throw new Error(`Episode ${episode.id} ${role} fill ${fillId} has cross-episode market or side evidence.`);
  }
  return fill;
}

function uniqueById<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.id)) throw new Error(`Duplicate ${label} id ${item.id}.`);
    result.set(item.id, item);
  }
  return result;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  return leftSet.size === left.length && right.every((value) => leftSet.has(value));
}

function validateEvidence(
  evidence: PerformanceTradeEvidence,
  fillById: ReadonlyMap<string, PerformanceTradeFill>,
  frameByFillId: ReadonlyMap<string, PositionGuardBacktestFrameResult>,
  sliceId: string,
): void {
  if (evidence.fillId === null) {
    if (evidence.occurredAt !== null || evidence.strategyDecisionId !== null) {
      throw new Error(`Slice ${sliceId} has corrupt opening-inventory evidence.`);
    }
    return;
  }
  const fill = fillById.get(evidence.fillId);
  if (!fill || !frameByFillId.has(evidence.fillId)) {
    throw new Error(`Slice ${sliceId} references lifecycle fill ${evidence.fillId} without a source frame.`);
  }
  if (
    evidence.orderId !== fill.orderId
    || evidence.strategyDecisionId !== fill.strategyDecisionId
    || evidence.decisionAction !== fill.decisionAction
    || evidence.occurredAt === null
    || comparePerformanceTimestamps(evidence.occurredAt, fill.filledAt) !== 0
    || evidence.priceKrw !== fill.priceKrw
  ) {
    throw new Error(`Slice ${sliceId} lifecycle evidence contradicts fill ${fill.id}.`);
  }
}

function buildAttributionView(
  dimension: RegimeAttributionDimension,
  slices: readonly FifoRealizationSlice[],
  episodes: readonly PositionEpisode[],
  tolerance: number,
): RegimeAttributionView {
  const episodeValues = episodes.map((episode) => episode.netRealizedPnlKrw);
  const episodeReasons = pnlUnknownReasons(
    episodes.flatMap((episode) => slicesForEpisode(episode, slices)),
  );
  const episodesUnknown = episodeValues.some((value) => value === null);
  const knownEpisodeValues = episodeValues as number[];
  const wins = episodesUnknown ? [] : knownEpisodeValues.filter((value) => value > tolerance);
  const losses = episodesUnknown ? [] : knownEpisodeValues.filter((value) => value < -tolerance);

  return {
    dimension,
    realizationSliceCount: slices.length,
    completedEpisodeCount: episodes.length,
    grossRealizedPnlKrw: sumNullableMetric(
      `${dimension} grossRealizedPnlKrw`,
      slices.map((slice) => slice.grossPnlBeforeFeesKrw),
      ["MISSING_FIFO_COST"],
    ),
    netRealizedPnlKrw: sumNullableMetric(
      `${dimension} netRealizedPnlKrw`,
      slices.map((slice) => slice.netRealizedPnlKrw),
      pnlUnknownReasons(slices),
    ),
    episodeWinRate: episodesUnknown
      ? unknown(episodeReasons.length > 0 ? episodeReasons : ["MISSING_EPISODE_FEE"])
      : episodes.length === 0
        ? notApplicable("NO_COMPLETED_EPISODES")
        : known(divideFinite(`${dimension} episodeWinRate`, wins.length, episodes.length)),
    profitFactor: episodesUnknown
      ? unknown(episodeReasons.length > 0 ? episodeReasons : ["MISSING_EPISODE_FEE"])
      : losses.length === 0
        ? notApplicable("ZERO_GROSS_LOSS")
        : known(divideFinite(
          `${dimension} profitFactor`,
          sumFinite(`${dimension} profitFactor numerator`, wins),
          Math.abs(sumFinite(`${dimension} profitFactor denominator`, losses)),
        )),
    episodeSampleSupport: classifySampleSupport("COMPLETED_EPISODES", episodes.length),
    realizationSliceSampleSupport: classifySampleSupport("REALIZATION_SLICES", slices.length),
  };
}

function slicesForEpisode(
  episode: PositionEpisode,
  candidateSlices: readonly FifoRealizationSlice[],
): FifoRealizationSlice[] {
  const ids = new Set(episode.realizationSliceIds);
  return candidateSlices.filter((slice) => ids.has(slice.id));
}

function pnlUnknownReasons(slices: readonly FifoRealizationSlice[]): string[] {
  const reasons: string[] = [];
  if (slices.some((slice) => slice.grossPnlBeforeFeesKrw === null)) reasons.push("MISSING_FIFO_COST");
  if (slices.some((slice) =>
    slice.allocatedBuyFeeKrw === null || slice.allocatedSellFeeKrw === null)) {
    reasons.push("MISSING_FILL_FEE");
  }
  return reasons;
}

function regimeForEvidence(
  evidence: PerformanceTradeEvidence,
  frameByFillId: ReadonlyMap<string, PositionGuardBacktestFrameResult>,
): StrategyMarketRegime | null {
  return evidence.fillId === null ? null : frameByFillId.get(evidence.fillId)?.regime ?? null;
}

function regimeForEpisode(
  episode: PositionEpisode,
  boundary: "ENTRY" | "EXIT",
  frameByFillId: ReadonlyMap<string, PositionGuardBacktestFrameResult>,
): StrategyMarketRegime | null {
  const ids = boundary === "ENTRY" ? episode.entryFillIds : episode.exitFillIds;
  const id = boundary === "ENTRY" ? ids[0] : ids[ids.length - 1];
  return id === undefined ? null : frameByFillId.get(id)?.regime ?? null;
}

function countDecisions(
  frames: readonly PositionGuardBacktestFrameResult[],
): Record<StrategyDecisionAction, number> {
  const counts: Record<StrategyDecisionAction, number> = {
    ENTER: 0,
    ADD: 0,
    REDUCE: 0,
    EXIT: 0,
    HOLD: 0,
  };
  for (const frame of frames) counts[frame.decision.action] += 1;
  return counts;
}

function validateTrade(trade: PositionGuardBacktestTrade, frameIndex: number): void {
  assertFinitePositive(trade.price, `Frame ${frameIndex} trade price`);
  assertFinitePositive(trade.quantity, `Frame ${frameIndex} trade quantity`);
  assertFinitePositive(trade.grossNotionalKrw, `Frame ${frameIndex} trade grossNotionalKrw`);
  assertFiniteNonNegative(trade.feeKrw, `Frame ${frameIndex} trade feeKrw`);
  if (!Number.isFinite(trade.realizedPnlKrw)) {
    throw new Error(`Frame ${frameIndex} trade realizedPnlKrw must be finite.`);
  }
}

function validateFillAgainstTrade(fill: PerformanceTradeFill, trade: PositionGuardBacktestTrade): void {
  if (
    fill.decisionAction !== trade.action
    || fill.side !== trade.side
    || fill.priceKrw !== trade.price
    || fill.volume !== trade.quantity
  ) {
    throw new Error(`Fill ${fill.id} contradicts its exact source frame trade.`);
  }
}

function sumNullableMetric(
  label: string,
  values: readonly (number | null)[],
  reasons: readonly string[],
): Metric<number> {
  return values.some((value) => value === null)
    ? unknown(reasons.length > 0 ? reasons : ["INCOMPLETE_PNL_EVIDENCE"])
    : known(sumFinite(label, values as number[]));
}

function known<T>(value: T): Metric<T> {
  return { status: "KNOWN", value };
}

function unknown<T>(reasons: readonly string[]): Metric<T> {
  return { status: "UNKNOWN", reasons };
}

function notApplicable<T>(reason: string): Metric<T> {
  return { status: "NOT_APPLICABLE", reason };
}

function sumFinite(label: string, values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error(`${label} input must be finite.`);
    total += value;
    if (!Number.isFinite(total)) throw new Error(`${label} must remain finite after derived arithmetic.`);
  }
  return total;
}

function multiplyFinite(label: string, left: number, right: number): number {
  const result = left * right;
  if (!Number.isFinite(result)) throw new Error(`${label} must remain finite after derived arithmetic.`);
  return result;
}

function divideFinite(label: string, numerator: number, denominator: number): number {
  const result = numerator / denominator;
  if (!Number.isFinite(result)) throw new Error(`${label} must remain finite after derived arithmetic.`);
  return result;
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be finite and positive.`);
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative.`);
}

function validateNullableFinite(value: number | null, label: string): void {
  if (value !== null && !Number.isFinite(value)) throw new Error(`${label} must be finite or null.`);
}

function validateNullableNonNegative(value: number | null, label: string): void {
  if (value !== null) assertFiniteNonNegative(value, label);
}
