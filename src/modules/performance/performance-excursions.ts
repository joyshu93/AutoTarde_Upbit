import { getMarketForAsset, type SupportedMarket } from "../../domain/types.js";
import type { CandleCoverageGap } from "./performance-candle-coverage.js";
import type { Metric } from "./performance-diagnostics.js";
import {
  assertVerifiedNoTradeCoverage,
  partitionHourlyCoverage,
  type VerifiedNoTradeCoverage,
} from "./performance-hourly-coverage.js";
import {
  isSupportedCounterfactualScenario,
  type CounterfactualScenario,
} from "./strategy-counterfactual.js";
import type {
  ResearchCandle,
  ResearchCandleDataset,
} from "./research-candle-dataset.js";
import {
  PERFORMANCE_QUANTITY_TOLERANCE,
  type FifoRealizationSlice,
  type PerformanceTradeFill,
  type PerformanceTradeMatchResult,
  type PositionEpisode,
} from "./performance-trade-matcher.js";
import {
  comparePerformanceTimestamps,
  parsePerformanceTimestamp,
  performanceTimestampEpochNanoseconds,
} from "./performance-timestamp.js";

export type ExcursionGapCode =
  | "MISSING_ENTRY_BOUNDARY_COVERAGE"
  | "MISSING_EXIT_BOUNDARY_COVERAGE"
  | "MISSING_INTERNAL_CANDLE_COVERAGE"
  | "OPEN_EPISODE_EXCLUDED"
  | "LEFT_CENSORED_OPENING_INVENTORY";

export type ExcursionEvidenceGap = {
  code: ExcursionGapCode;
  severity: "WARNING";
  market: SupportedMarket;
  episodeId: string | null;
  evidenceIds: readonly string[];
  affectedMetrics: readonly string[];
  message: string;
};

export type EpisodeExcursion = {
  episodeId: string;
  market: SupportedMarket;
  openedAt: string;
  closedAt: string;
  referenceEntryFillId: string;
  referenceEntryPriceKrw: number;
  krwSemantics: "PER_UNIT_PRICE_DELTA_FROM_FIRST_ENTRY_FILL";
  evidence: {
    entryFillIds: readonly string[];
    exitFillIds: readonly string[];
    entryAt: string;
    exitAt: string;
  };
  coverage: {
    expectedIntervalCount: number;
    observedIntervalCount: number;
    verifiedNoTradeIntervalCount: number;
    verifiedNoTradeRanges: readonly CandleCoverageGap[];
    unexplainedMissingIntervals: readonly string[];
  };
  maeKrw: Metric<number>;
  mfeKrw: Metric<number>;
  maePct: Metric<number>;
  mfePct: Metric<number>;
  candleCount: number;
  provenance: {
    datasetSha256: string;
    source: string;
    historyStartAt: string;
    endAt: string;
    firstCandleOpenTime: string | null;
    lastCandleCloseTime: string | null;
  };
  warnings: readonly ["INTRABAR_ORDER_NOT_INFERRED"];
};

export type PerformanceExcursionInput = {
  scenario: CounterfactualScenario;
  dataset: ResearchCandleDataset;
  fills: readonly PerformanceTradeFill[];
  matchResult: PerformanceTradeMatchResult;
  verifiedNoTradeCoverage?: VerifiedNoTradeCoverage;
};

export type PerformanceExcursionResult = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  scenario: CounterfactualScenario;
  market: SupportedMarket;
  timeframe: "1h";
  episodes: readonly EpisodeExcursion[];
  evidenceGaps: readonly ExcursionEvidenceGap[];
  warnings: readonly [{
    code: "INTRABAR_ORDER_NOT_INFERRED";
    message: string;
  }];
};

const HOUR_NANOSECONDS = 3_600_000_000_000n;
const EXCURSION_METRICS = ["maeKrw", "mfeKrw", "maePct", "mfePct"] as const;
const INTRABAR_WARNING = {
  code: "INTRABAR_ORDER_NOT_INFERRED" as const,
  message: "MAE/MFE KRW is a per-unit price excursion from the first entry fill. Hourly OHLC does not reveal intrabar ordering, total-position PnL, or stop execution.",
};

export function analyzePerformanceExcursions(
  input: PerformanceExcursionInput,
): PerformanceExcursionResult {
  if (!isSupportedCounterfactualScenario(input.scenario)) {
    throw new Error(`Invalid counterfactual scenario ${String(input.scenario)}.`);
  }
  validateDataset(input.dataset);
  const market = input.dataset.provenance.market;
  const fillById = validateFills(input.fills, market);
  validateMatchResult(input.matchResult, fillById, market);

  const evidenceGaps: ExcursionEvidenceGap[] = [];
  for (const episode of input.matchResult.episodes.filter((item) => item.status === "OPEN")) {
    evidenceGaps.push(gap(
      "OPEN_EPISODE_EXCLUDED",
      market,
      episode.id,
      [...episode.entryFillIds],
      `Open episode ${episode.id} is excluded because no exit decision bounds its excursion interval.`,
    ));
  }
  const openingSlices = input.matchResult.realizationSlices.filter((slice) => slice.source === "OPENING");
  if (openingSlices.length > 0) {
    evidenceGaps.push(gap(
      "LEFT_CENSORED_OPENING_INVENTORY",
      market,
      null,
      openingSlices.map((slice) => slice.id),
      "Opening inventory has no observed entry timestamp and cannot receive fabricated excursion metrics.",
    ));
  }

  const episodes = input.matchResult.episodes
    .filter((episode): episode is PositionEpisode & { status: "COMPLETED"; closedAt: string } =>
      episode.status === "COMPLETED" && episode.closedAt !== null)
    .map((episode) => analyzeEpisode(
      episode,
      input.dataset.candles["1h"],
      input.dataset,
      fillById,
      evidenceGaps,
      input.verifiedNoTradeCoverage,
    ));

  return {
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    scenario: input.scenario,
    market,
    timeframe: "1h",
    episodes,
    evidenceGaps,
    warnings: [INTRABAR_WARNING],
  };
}

function analyzeEpisode(
  episode: PositionEpisode & { status: "COMPLETED"; closedAt: string },
  candles: readonly ResearchCandle[],
  dataset: ResearchCandleDataset,
  fillById: ReadonlyMap<string, PerformanceTradeFill>,
  evidenceGaps: ExcursionEvidenceGap[],
  verifiedNoTradeCoverage: PerformanceExcursionInput["verifiedNoTradeCoverage"],
): EpisodeExcursion {
  const entryFillId = episode.entryFillIds[0];
  if (!entryFillId) throw new Error(`Completed episode ${episode.id} has no entry fill.`);
  const entryFill = fillById.get(entryFillId);
  if (!entryFill) throw new Error(`Episode ${episode.id} references lifecycle fill ${entryFillId}.`);
  if (entryFill.side !== "bid" || comparePerformanceTimestamps(entryFill.filledAt, episode.openedAt) !== 0) {
    throw new Error(`Episode ${episode.id} opening lifecycle evidence is inconsistent.`);
  }

  const intervalCandles = candles.filter((candle) =>
    comparePerformanceTimestamps(candle.openTime, episode.openedAt) >= 0
    && comparePerformanceTimestamps(candle.closeTime, episode.closedAt) <= 0);
  const first = intervalCandles[0];
  const last = intervalCandles[intervalCandles.length - 1];
  const openedAt = performanceTimestampEpochNanoseconds(episode.openedAt);
  const closedAt = performanceTimestampEpochNanoseconds(episode.closedAt);
  const completeLegacyIntervals = (closedAt - openedAt) / HOUR_NANOSECONDS;
  const legacyCoverageTo = openedAt + completeLegacyIntervals * HOUR_NANOSECONDS;
  const legacyNonWholeHour = verifiedNoTradeCoverage === undefined && legacyCoverageTo !== closedAt;
  if (verifiedNoTradeCoverage !== undefined) {
    assertVerifiedNoTradeCoverage(verifiedNoTradeCoverage);
    validateNoTradeSourceBoundary(verifiedNoTradeCoverage.sourceBoundary, dataset);
    rejectFillBoundaryNoTrade(episode, verifiedNoTradeCoverage.ranges);
  }
  const coverage = verifiedNoTradeCoverage === undefined && completeLegacyIntervals === 0n
    ? {
      expectedIntervalCount: 0,
      observedIntervalCount: 0,
      verifiedNoTradeIntervalCount: 0,
      unexplainedMissingIntervalCount: 0,
      observedIntervals: [] as readonly string[],
      verifiedNoTradeIntervals: [] as readonly string[],
      verifiedNoTradeRanges: [] as readonly CandleCoverageGap[],
      unexplainedMissingIntervals: [] as readonly string[],
    }
    : partitionHourlyCoverage({
      from: episode.openedAt,
      to: verifiedNoTradeCoverage === undefined ? formatTimestamp(legacyCoverageTo) : episode.closedAt,
      sourceBoundary: verifiedNoTradeCoverage?.sourceBoundary ?? {
        historyStartAt: episode.openedAt,
        endAt: formatTimestamp(legacyCoverageTo),
      },
      observedIntervals: intervalCandles
        .filter((candle) => performanceTimestampEpochNanoseconds(candle.closeTime) <= (
          verifiedNoTradeCoverage === undefined ? legacyCoverageTo : closedAt
        ))
        .map((candle) => ({ openTime: candle.openTime, closeTime: candle.closeTime })),
      verifiedNoTradeRanges: verifiedNoTradeCoverage?.ranges ?? [],
    });
  const reasons: ExcursionGapCode[] = [];
  if (!first || comparePerformanceTimestamps(first.openTime, episode.openedAt) !== 0) {
    reasons.push("MISSING_ENTRY_BOUNDARY_COVERAGE");
  }
  const firstInterval = intervalKey(openedAt, openedAt + HOUR_NANOSECONDS);
  const lastInterval = intervalKey(closedAt - HOUR_NANOSECONDS, closedAt);
  if (
    legacyNonWholeHour
      ? hasInternalGap(intervalCandles)
      : coverage.unexplainedMissingIntervals.some((interval) =>
        interval !== firstInterval && interval !== lastInterval)
  ) {
    reasons.push("MISSING_INTERNAL_CANDLE_COVERAGE");
  }
  if (!last || comparePerformanceTimestamps(last.closeTime, episode.closedAt) !== 0) {
    reasons.push("MISSING_EXIT_BOUNDARY_COVERAGE");
  }

  for (const reason of reasons) {
    evidenceGaps.push(gap(
      reason,
      episode.market,
      episode.id,
      intervalCandles.map((candle) => `${candle.openTime}/${candle.closeTime}`),
      coverageGapMessage(reason, episode.id),
    ));
  }

  const metrics = reasons.length > 0
    ? unknownMetrics(reasons)
    : calculateExcursions(intervalCandles, entryFill.priceKrw);
  return {
    episodeId: episode.id,
    market: episode.market,
    openedAt: episode.openedAt,
    closedAt: episode.closedAt,
    referenceEntryFillId: entryFill.id,
    referenceEntryPriceKrw: entryFill.priceKrw,
    krwSemantics: "PER_UNIT_PRICE_DELTA_FROM_FIRST_ENTRY_FILL",
    evidence: {
      entryFillIds: [...episode.entryFillIds],
      exitFillIds: [...episode.exitFillIds],
      entryAt: episode.openedAt,
      exitAt: episode.closedAt,
    },
    coverage: {
      expectedIntervalCount: coverage.expectedIntervalCount,
      observedIntervalCount: coverage.observedIntervalCount,
      verifiedNoTradeIntervalCount: coverage.verifiedNoTradeIntervalCount,
      verifiedNoTradeRanges: coverage.verifiedNoTradeRanges.map(copyGap),
      unexplainedMissingIntervals: [...coverage.unexplainedMissingIntervals],
    },
    ...metrics,
    candleCount: intervalCandles.length,
    provenance: {
      datasetSha256: dataset.provenance.sha256,
      source: dataset.provenance.source,
      historyStartAt: dataset.provenance.historyStartAt,
      endAt: dataset.provenance.endAt,
      firstCandleOpenTime: first?.openTime ?? null,
      lastCandleCloseTime: last?.closeTime ?? null,
    },
    warnings: ["INTRABAR_ORDER_NOT_INFERRED"],
  };
}

function calculateExcursions(
  candles: readonly ResearchCandle[],
  entryPrice: number,
): Pick<EpisodeExcursion, "maeKrw" | "mfeKrw" | "maePct" | "mfePct"> {
  const minimumLow = Math.min(...candles.map((candle) => candle.lowPrice));
  const maximumHigh = Math.max(...candles.map((candle) => candle.highPrice));
  const maeKrw = Math.min(0, minimumLow - entryPrice);
  const mfeKrw = Math.max(0, maximumHigh - entryPrice);
  return {
    maeKrw: knownFinite("maeKrw", maeKrw),
    mfeKrw: knownFinite("mfeKrw", mfeKrw),
    maePct: knownFinite("maePct", maeKrw / entryPrice),
    mfePct: knownFinite("mfePct", mfeKrw / entryPrice),
  };
}

function unknownMetrics(
  reasons: readonly ExcursionGapCode[],
): Pick<EpisodeExcursion, "maeKrw" | "mfeKrw" | "maePct" | "mfePct"> {
  return {
    maeKrw: unknown(reasons),
    mfeKrw: unknown(reasons),
    maePct: unknown(reasons),
    mfePct: unknown(reasons),
  };
}

function validateDataset(dataset: ResearchCandleDataset): void {
  const { provenance } = dataset;
  if (getMarketForAsset(provenance.asset) !== provenance.market) {
    throw new Error(`Dataset market ${provenance.market} does not match asset ${provenance.asset}.`);
  }
  if (!/^[a-f0-9]{64}$/.test(provenance.sha256)) throw new Error("Dataset sha256 is invalid.");
  if (provenance.source.trim().length === 0) throw new Error("Dataset source must not be empty.");
  for (const [label, timestamp] of [
    ["historyStartAt", provenance.historyStartAt],
    ["endAt", provenance.endAt],
    ["collectedAt", provenance.collectedAt],
  ] as const) {
    if (parsePerformanceTimestamp(timestamp) === null) {
      throw new Error(`Dataset ${label} must be an exact timestamp with an explicit timezone.`);
    }
  }
  if (comparePerformanceTimestamps(provenance.historyStartAt, provenance.endAt) >= 0) {
    throw new Error("Dataset historyStartAt must be before endAt.");
  }
  if (comparePerformanceTimestamps(provenance.endAt, provenance.collectedAt) > 0) {
    throw new Error("Dataset collectedAt must be at or after endAt.");
  }

  let previousClose: string | null = null;
  for (const [index, candle] of dataset.candles["1h"].entries()) {
    if (candle.market !== provenance.market) {
      throw new Error(`1h candle ${index} market ${candle.market} does not match ${provenance.market}.`);
    }
    if (candle.timeframe !== "1h") throw new Error(`Candle ${index} timeframe must be 1h.`);
    if (parsePerformanceTimestamp(candle.openTime) === null) throw new Error(`Candle ${index} openTime is invalid.`);
    if (parsePerformanceTimestamp(candle.closeTime) === null) throw new Error(`Candle ${index} closeTime is invalid.`);
    const duration = performanceTimestampEpochNanoseconds(candle.closeTime)
      - performanceTimestampEpochNanoseconds(candle.openTime);
    if (duration !== HOUR_NANOSECONDS) {
      throw new Error(`Candle ${index} must represent one complete 1h interval.`);
    }
    if (previousClose !== null && comparePerformanceTimestamps(previousClose, candle.openTime) > 0) {
      throw new Error("1h candles must be ordered and non-overlapping by exact instant.");
    }
    previousClose = candle.closeTime;
    if (
      comparePerformanceTimestamps(candle.openTime, provenance.historyStartAt) < 0
      || comparePerformanceTimestamps(candle.closeTime, provenance.endAt) > 0
    ) {
      throw new Error(`Candle ${index} falls outside dataset provenance boundaries.`);
    }
    validateCandleValues(candle, index);
  }
}

function validateCandleValues(candle: ResearchCandle, index: number): void {
  for (const field of ["openPrice", "highPrice", "lowPrice", "closePrice"] as const) {
    const value = candle[field];
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Candle ${index} ${field} must be finite and positive.`);
    }
  }
  for (const field of ["volume", "quoteVolume"] as const) {
    const value = candle[field];
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Candle ${index} ${field} must be finite and non-negative.`);
    }
  }
  if (
    candle.lowPrice > candle.openPrice
    || candle.lowPrice > candle.closePrice
    || candle.openPrice > candle.highPrice
    || candle.closePrice > candle.highPrice
  ) {
    throw new Error(`Candle ${index} OHLC values are inconsistent.`);
  }
}

function validateFills(
  fills: readonly PerformanceTradeFill[],
  market: SupportedMarket,
): Map<string, PerformanceTradeFill> {
  const fillById = new Map<string, PerformanceTradeFill>();
  for (const fill of fills) {
    if (fillById.has(fill.id)) throw new Error(`Duplicate fill id ${fill.id}.`);
    if (fill.market !== market) throw new Error(`Fill ${fill.id} market does not match ${market}.`);
    if (parsePerformanceTimestamp(fill.filledAt) === null) throw new Error(`Fill ${fill.id} filledAt is invalid.`);
    if (!Number.isFinite(fill.priceKrw) || fill.priceKrw <= 0) throw new Error(`Fill ${fill.id} priceKrw is invalid.`);
    if (!Number.isFinite(fill.volume) || fill.volume <= 0) throw new Error(`Fill ${fill.id} volume is invalid.`);
    if (fill.feeKrw !== null && (!Number.isFinite(fill.feeKrw) || fill.feeKrw < 0)) {
      throw new Error(`Fill ${fill.id} feeKrw is invalid.`);
    }
    if (fill.strategyDecisionId === null || fill.decisionAction === null) {
      throw new Error(`Fill ${fill.id} must retain strategy decision lifecycle evidence.`);
    }
    if (
      (fill.side === "bid" && !["ENTER", "ADD"].includes(fill.decisionAction))
      || (fill.side === "ask" && !["REDUCE", "EXIT"].includes(fill.decisionAction))
    ) {
      throw new Error(`Fill ${fill.id} decision action contradicts its side.`);
    }
    fillById.set(fill.id, fill);
  }
  return fillById;
}

function validateMatchResult(
  matchResult: PerformanceTradeMatchResult,
  fillById: ReadonlyMap<string, PerformanceTradeFill>,
  market: SupportedMarket,
): void {
  if (matchResult.unmatchedSells.length > 0 || matchResult.attributionFailures.length > 0) {
    throw new Error("Excursion analysis requires unambiguous matched lifecycle evidence.");
  }
  const episodeById = uniqueById(matchResult.episodes, "episode");
  const sliceById = uniqueById(matchResult.realizationSlices, "slice");
  for (const slice of matchResult.realizationSlices) validateSlice(slice, fillById, market);
  for (const slice of matchResult.realizationSlices) {
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
    if (!episode) throw new Error(`Selected slice ${slice.id} references missing episode lifecycle.`);
    if (!episode.realizationSliceIds.includes(slice.id)) {
      throw new Error(`Selected slice ${slice.id} is missing from its bidirectional lifecycle episode.`);
    }
    if (slice.entry.fillId === null || !episode.entryFillIds.includes(slice.entry.fillId)) {
      throw new Error(`Selected slice ${slice.id} has a cross-episode entry fill.`);
    }
    if (slice.exit.fillId === null || !episode.exitFillIds.includes(slice.exit.fillId)) {
      throw new Error(`Selected slice ${slice.id} has a cross-episode exit fill.`);
    }
  }
  for (const episode of matchResult.episodes) {
    if (episode.market !== market) throw new Error(`Episode ${episode.id} market does not match ${market}.`);
    if (parsePerformanceTimestamp(episode.openedAt) === null) throw new Error(`Episode ${episode.id} openedAt is invalid.`);
    if (episode.entryFillIds.length === 0) throw new Error(`Episode ${episode.id} requires an entry fill.`);
    const entryFills = episode.entryFillIds.map((fillId) => requireEpisodeFill(
      episode,
      fillId,
      fillById,
      "entry",
      "bid",
    ));
    const exitFills = episode.exitFillIds.map((fillId) => requireEpisodeFill(
      episode,
      fillId,
      fillById,
      "exit",
      "ask",
    ));
    if (comparePerformanceTimestamps(episode.openedAt, entryFills[0]!.filledAt) !== 0) {
      throw new Error(`Episode ${episode.id} openedAt does not match its first entry fill.`);
    }
    if (!Number.isFinite(episode.remainingQuantity) || episode.remainingQuantity < 0) {
      throw new Error(`Episode ${episode.id} remainingQuantity is invalid.`);
    }
    if (episode.status === "COMPLETED") {
      if (episode.closedAt === null || parsePerformanceTimestamp(episode.closedAt) === null) {
        throw new Error(`Completed episode ${episode.id} closedAt is invalid.`);
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
      if (episode.closedAt !== null) throw new Error(`Open episode ${episode.id} cannot have closedAt evidence.`);
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
        throw new Error(`Episode ${episode.id} references a cross-episode lifecycle slice ${sliceId}.`);
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
  }
}

function validateSlice(
  slice: FifoRealizationSlice,
  fillById: ReadonlyMap<string, PerformanceTradeFill>,
  market: SupportedMarket,
): void {
  if (slice.market !== market) throw new Error(`Slice ${slice.id} market does not match ${market}.`);
  if (!Number.isFinite(slice.quantity) || slice.quantity <= 0) throw new Error(`Slice ${slice.id} quantity is invalid.`);
  validateNullableFinite(slice.grossPnlBeforeFeesKrw, `Slice ${slice.id} gross PnL`);
  validateNullableNonNegative(slice.allocatedBuyFeeKrw, `Slice ${slice.id} allocated buy fee`);
  validateNullableNonNegative(slice.allocatedSellFeeKrw, `Slice ${slice.id} allocated sell fee`);
  validateNullableFinite(slice.netRealizedPnlKrw, `Slice ${slice.id} net PnL`);
  validateNullableNonNegative(slice.holdingDurationMs, `Slice ${slice.id} holding duration`);
  if (slice.exit.fillId === null) throw new Error(`Slice ${slice.id} requires observed exit fill evidence.`);
  for (const evidence of [slice.entry, slice.exit]) {
    if (evidence.fillId === null) {
      if (
        evidence.orderId !== null
        || evidence.strategyDecisionId !== null
        || evidence.decisionAction !== null
        || evidence.occurredAt !== null
      ) {
        throw new Error(`Slice ${slice.id} has corrupt left-censored evidence.`);
      }
      continue;
    }
    const fill = fillById.get(evidence.fillId);
    if (!fill) throw new Error(`Slice ${slice.id} references lifecycle fill ${evidence.fillId}.`);
    if (
      evidence.occurredAt === null
      || comparePerformanceTimestamps(evidence.occurredAt, fill.filledAt) !== 0
      || evidence.priceKrw !== fill.priceKrw
      || evidence.orderId !== fill.orderId
      || evidence.strategyDecisionId !== fill.strategyDecisionId
      || evidence.decisionAction !== fill.decisionAction
    ) {
      throw new Error(`Slice ${slice.id} evidence contradicts lifecycle fill ${fill.id}.`);
    }
  }
}

function requireEpisodeFill(
  episode: PositionEpisode,
  fillId: string,
  fillById: ReadonlyMap<string, PerformanceTradeFill>,
  role: "entry" | "exit",
  expectedSide: "bid" | "ask",
): PerformanceTradeFill {
  const fill = fillById.get(fillId);
  if (!fill) throw new Error(`Episode ${episode.id} references lifecycle fill ${fillId}.`);
  if (fill.market !== episode.market || fill.side !== expectedSide) {
    throw new Error(`Episode ${episode.id} ${role} fill ${fillId} must be ${expectedSide} for the same market.`);
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

function validateNullableFinite(value: number | null, label: string): void {
  if (value !== null && !Number.isFinite(value)) throw new Error(`${label} must be finite or null.`);
}

function validateNullableNonNegative(value: number | null, label: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} must be finite, non-negative, or null.`);
  }
}

function hasInternalGap(candles: readonly ResearchCandle[]): boolean {
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1];
    const current = candles[index];
    if (previous && current && comparePerformanceTimestamps(previous.closeTime, current.openTime) !== 0) {
      return true;
    }
  }
  return false;
}

function validateNoTradeSourceBoundary(
  boundary: NonNullable<PerformanceExcursionInput["verifiedNoTradeCoverage"]>["sourceBoundary"],
  dataset: ResearchCandleDataset,
): void {
  if (
    comparePerformanceTimestamps(boundary.historyStartAt, dataset.provenance.historyStartAt) !== 0
    || comparePerformanceTimestamps(boundary.endAt, dataset.provenance.endAt) !== 0
  ) {
    throw new Error("Verified no-trade sourceBoundary must match dataset provenance boundaries.");
  }
}

function rejectFillBoundaryNoTrade(
  episode: PositionEpisode & { status: "COMPLETED"; closedAt: string },
  ranges: readonly CandleCoverageGap[],
): void {
  const entryBoundaryClose = performanceTimestampEpochNanoseconds(episode.openedAt) + HOUR_NANOSECONDS;
  const exitBoundaryClose = performanceTimestampEpochNanoseconds(episode.closedAt);
  for (const range of ranges) {
    const first = performanceTimestampEpochNanoseconds(range.firstMissingCloseTime);
    const last = performanceTimestampEpochNanoseconds(range.lastMissingCloseTime);
    if (entryBoundaryClose >= first && entryBoundaryClose <= last) {
      throw new Error(`Verified no-trade evidence covers episode ${episode.id} entry fill boundary.`);
    }
    if (exitBoundaryClose >= first && exitBoundaryClose <= last) {
      throw new Error(`Verified no-trade evidence covers episode ${episode.id} exit fill boundary.`);
    }
  }
}

function copyGap(range: CandleCoverageGap): CandleCoverageGap {
  return {
    firstMissingCloseTime: range.firstMissingCloseTime,
    lastMissingCloseTime: range.lastMissingCloseTime,
    missingCandleCount: range.missingCandleCount,
    previousObservedCloseTime: range.previousObservedCloseTime,
    nextObservedCloseTime: range.nextObservedCloseTime,
  };
}

function intervalKey(open: bigint, close: bigint): string {
  return `${formatTimestamp(open)}/${formatTimestamp(close)}`;
}

function formatTimestamp(epochNanoseconds: bigint): string {
  const seconds = epochNanoseconds / 1_000_000_000n;
  const nanoseconds = epochNanoseconds % 1_000_000_000n;
  return `${new Date(Number(seconds * 1_000n)).toISOString().slice(0, 19)}.${nanoseconds.toString().padStart(9, "0")}Z`;
}

function gap(
  code: ExcursionGapCode,
  market: SupportedMarket,
  episodeId: string | null,
  evidenceIds: readonly string[],
  message: string,
): ExcursionEvidenceGap {
  return {
    code,
    severity: "WARNING",
    market,
    episodeId,
    evidenceIds,
    affectedMetrics: EXCURSION_METRICS,
    message,
  };
}

function coverageGapMessage(code: ExcursionGapCode, episodeId: string): string {
  if (code === "MISSING_ENTRY_BOUNDARY_COVERAGE") {
    return `Episode ${episodeId} lacks a completed 1h interval beginning exactly at entry.`;
  }
  if (code === "MISSING_EXIT_BOUNDARY_COVERAGE") {
    return `Episode ${episodeId} lacks a completed 1h interval ending exactly at exit.`;
  }
  return `Episode ${episodeId} has missing internal 1h candle coverage.`;
}

function known<T>(value: T): Metric<T> {
  return { status: "KNOWN", value };
}

function knownFinite(label: string, value: number): Metric<number> {
  if (!Number.isFinite(value)) throw new Error(`${label} must remain finite after derived arithmetic.`);
  return known(value);
}

function unknown<T>(reasons: readonly string[]): Metric<T> {
  return { status: "UNKNOWN", reasons };
}
