import { getMarketForAsset, type SupportedAsset, type SupportedMarket } from "../../domain/types.js";
import type { AddDecisionExposure } from "./performance-add-diagnostics.js";
import type { CandleCoverageGap } from "./performance-candle-coverage.js";
import type { Metric } from "./performance-diagnostics.js";
import {
  assertVerifiedNoTradeCoverage,
  partitionHourlyCoverage,
  type VerifiedNoTradeCoverage,
} from "./performance-hourly-coverage.js";
import type { ResearchCandle, ResearchCandleDataset } from "./research-candle-dataset.js";
import type {
  PerformanceTradeFill,
  PerformanceTradeMatchResult,
  PositionEpisode,
} from "./performance-trade-matcher.js";
import {
  comparePerformanceTimestamps,
  parsePerformanceTimestamp,
  performanceTimestampEpochNanoseconds,
} from "./performance-timestamp.js";

export type AddExcursionReason =
  | "BASELINE_PATH_DECISION_DIVERGED"
  | "BASELINE_ADD_NOT_EXECUTED"
  | "BASELINE_EXECUTED_ADD_FILL_MISSING"
  | "BASELINE_ADD_EPISODE_MISSING"
  | "OPEN_POSITION_EPISODE"
  | "DECISION_AND_EPISODE_CLOSE_SAME_INSTANT"
  | "NO_COMPLETED_HOURLY_INTERVALS_IN_WINDOW"
  | "MISSING_EXPECTED_HOURLY_CANDLE_COVERAGE";

export type AddExcursionCoverage = {
  expectedIntervalCount: number;
  observedIntervalCount: number;
  verifiedNoTradeIntervalCount: number;
  verifiedNoTradeRanges: readonly CandleCoverageGap[];
  missingIntervals: readonly string[];
};

export type AddPostDecisionExcursion = {
  exposureId: string;
  status: "KNOWN" | "UNKNOWN" | "NOT_APPLICABLE";
  reason: AddExcursionReason | null;
  maeKrw: Metric<number>;
  mfeKrw: Metric<number>;
  maePct: Metric<number>;
  mfePct: Metric<number>;
  coverage: AddExcursionCoverage | null;
  evidence: {
    decisionAt: string;
    baselineFillId: string | null;
    episodeId: string | null;
    episodeClosedAt: string | null;
    candleIntervals: readonly string[];
  };
  provenance: {
    datasetSha256: string;
    source: string;
    historyStartAt: string;
    endAt: string;
  };
  warnings: readonly ["INTRABAR_ORDER_NOT_INFERRED"];
};

export type AddPostDecisionExcursionInput = {
  asset: SupportedAsset;
  market: SupportedMarket;
  dataset: ResearchCandleDataset;
  exposures: readonly AddDecisionExposure[];
  baselineFills: readonly PerformanceTradeFill[];
  baselineMatchResult: PerformanceTradeMatchResult;
  verifiedNoTradeCoverage?: VerifiedNoTradeCoverage;
};

export type AddPostDecisionExcursionResult = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  analysisKind: "ADD_POST_DECISION_EXCURSION";
  causalClaim: false;
  asset: SupportedAsset;
  market: SupportedMarket;
  timeframe: "1h";
  exposures: readonly AddPostDecisionExcursion[];
};

const HOUR_NANOSECONDS = 3_600_000_000_000n;
const WARNING = "INTRABAR_ORDER_NOT_INFERRED" as const;
const METRICS = ["maeKrw", "mfeKrw", "maePct", "mfePct"] as const;

export function analyzeAddPostDecisionExcursions(
  input: AddPostDecisionExcursionInput,
): AddPostDecisionExcursionResult {
  validateInput(input);
  const fills = mapFills(input.baselineFills, input.market);
  const episodes = mapEpisodes(input.baselineMatchResult.episodes, fills, input.market);
  const candles = validateCandles(input.dataset, input.market);

  return {
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    analysisKind: "ADD_POST_DECISION_EXCURSION",
    causalClaim: false,
    asset: input.asset,
    market: input.market,
    timeframe: "1h",
    exposures: input.exposures.map((exposure) => analyzeExposure(
      exposure,
      episodes,
      fills,
      candles,
      input.dataset,
      input.verifiedNoTradeCoverage,
    )),
  };
}

function analyzeExposure(
  exposure: AddDecisionExposure,
  episodes: ReadonlyMap<string, PositionEpisode>,
  fills: ReadonlyMap<string, PerformanceTradeFill>,
  candles: readonly ResearchCandle[],
  dataset: ResearchCandleDataset,
  verifiedNoTradeCoverage: AddPostDecisionExcursionInput["verifiedNoTradeCoverage"],
): AddPostDecisionExcursion {
  requireTimestamp(exposure.generatedAt, "ADD decision timestamp");
  const provenance = provenanceOf(dataset);
  const baseEvidence = {
    decisionAt: exposure.generatedAt,
    baselineFillId: exposure.baseline.fillId,
    episodeId: exposure.baselineEpisode?.episodeId ?? null,
    episodeClosedAt: null,
    candleIntervals: [],
  };

  if (exposure.pairingStatus !== "EXECUTED_VS_SUPPRESSED") {
    return unavailable(exposure.id, pairingReason(exposure.pairingStatus), baseEvidence, provenance);
  }
  if (!exposure.baseline.executed || exposure.baseline.action !== "ADD" || exposure.baseline.fillId === null) {
    return unavailable(exposure.id, "BASELINE_EXECUTED_ADD_FILL_MISSING", baseEvidence, provenance);
  }
  const fill = fills.get(exposure.baseline.fillId);
  if (!fill) return unavailable(exposure.id, "BASELINE_EXECUTED_ADD_FILL_MISSING", baseEvidence, provenance);
  validateMatchedAddFill(fill, exposure.generatedAt);

  if (!exposure.baselineEpisode) {
    return unavailable(exposure.id, "BASELINE_ADD_EPISODE_MISSING", baseEvidence, provenance);
  }
  const episode = episodes.get(exposure.baselineEpisode.episodeId);
  if (!episode || !episode.entryFillIds.includes(fill.id)) {
    throw new Error(`Exposure ${exposure.id} has corrupt ADD fill and position episode relationships.`);
  }
  if (episode.status === "OPEN") {
    return unavailable(exposure.id, "OPEN_POSITION_EPISODE", baseEvidence, provenance);
  }
  if (episode.closedAt === null) throw new Error(`Completed episode ${episode.id} has no close timestamp.`);
  requireTimestamp(episode.closedAt, `Episode ${episode.id} close timestamp`);
  const evidence = { ...baseEvidence, episodeClosedAt: episode.closedAt };
  const decisionNs = performanceTimestampEpochNanoseconds(exposure.generatedAt);
  const closeNs = performanceTimestampEpochNanoseconds(episode.closedAt);
  if (closeNs < decisionNs) throw new Error(`Episode ${episode.id} closes before ADD decision ${exposure.id}.`);
  if (closeNs === decisionNs) {
    return unavailable(exposure.id, "DECISION_AND_EPISODE_CLOSE_SAME_INSTANT", evidence, provenance);
  }

  const expectedIntervalCount = Number((closeNs - decisionNs) / HOUR_NANOSECONDS);
  if (!Number.isSafeInteger(expectedIntervalCount) || expectedIntervalCount < 0) {
    throw new Error("ADD excursion expected interval count must be a non-negative safe integer.");
  }
  if (expectedIntervalCount === 0) {
    return unavailable(exposure.id, "NO_COMPLETED_HOURLY_INTERVALS_IN_WINDOW", evidence, provenance);
  }
  const coverageToNs = decisionNs + BigInt(expectedIntervalCount) * HOUR_NANOSECONDS;
  const coverageTo = formatTimestamp(coverageToNs);
  const observed = candles.filter((candle) =>
    performanceTimestampEpochNanoseconds(candle.openTime) >= decisionNs
    && performanceTimestampEpochNanoseconds(candle.closeTime) <= coverageToNs);
  const sourceBoundary = verifiedNoTradeCoverage?.sourceBoundary ?? {
    historyStartAt: exposure.generatedAt,
    endAt: coverageTo,
  };
  if (verifiedNoTradeCoverage !== undefined) {
    assertVerifiedNoTradeCoverage(verifiedNoTradeCoverage);
    validateNoTradeSourceBoundary(verifiedNoTradeCoverage.sourceBoundary, dataset);
  }
  const partition = partitionHourlyCoverage({
    from: exposure.generatedAt,
    to: coverageTo,
    sourceBoundary,
    observedIntervals: observed.map((candle) => ({
      openTime: candle.openTime,
      closeTime: candle.closeTime,
    })),
    verifiedNoTradeRanges: verifiedNoTradeCoverage?.ranges ?? [],
  });
  const coverage = {
    expectedIntervalCount: partition.expectedIntervalCount,
    observedIntervalCount: partition.observedIntervalCount,
    verifiedNoTradeIntervalCount: partition.verifiedNoTradeIntervalCount,
    verifiedNoTradeRanges: partition.verifiedNoTradeRanges.map(copyGap),
    missingIntervals: [...partition.unexplainedMissingIntervals],
  };
  const observedEvidence = {
    ...evidence,
    candleIntervals: observed.map((candle) => intervalKey(candle.openTime, candle.closeTime)),
  };
  if (partition.unexplainedMissingIntervalCount > 0) {
    return unavailable(
      exposure.id,
      "MISSING_EXPECTED_HOURLY_CANDLE_COVERAGE",
      observedEvidence,
      provenance,
      coverage,
    );
  }
  if (observed.length === 0) {
    return unavailable(
      exposure.id,
      "NO_COMPLETED_HOURLY_INTERVALS_IN_WINDOW",
      observedEvidence,
      provenance,
      coverage,
    );
  }

  const low = Math.min(...observed.map((candle) => candle.lowPrice));
  const high = Math.max(...observed.map((candle) => candle.highPrice));
  const maeKrw = Math.min(0, low - fill.priceKrw);
  const mfeKrw = Math.max(0, high - fill.priceKrw);
  return {
    exposureId: exposure.id,
    status: "KNOWN",
    reason: null,
    maeKrw: known(maeKrw),
    mfeKrw: known(mfeKrw),
    maePct: known(maeKrw / fill.priceKrw),
    mfePct: known(mfeKrw / fill.priceKrw),
    coverage,
    evidence: observedEvidence,
    provenance,
    warnings: [WARNING],
  };
}

function validateInput(input: AddPostDecisionExcursionInput): void {
  if (getMarketForAsset(input.asset) !== input.market) throw new Error(`ADD excursion market ${input.market} does not match asset ${input.asset}.`);
  if (input.dataset.provenance.market !== input.market || input.dataset.provenance.asset !== input.asset) {
    throw new Error("ADD excursion dataset market and asset must match the requested analysis.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.dataset.provenance.sha256)) throw new Error("ADD excursion dataset sha256 is invalid.");
  if (input.dataset.provenance.source.trim().length === 0) throw new Error("ADD excursion dataset source must not be empty.");
  for (const [label, value] of Object.entries({
    historyStartAt: input.dataset.provenance.historyStartAt,
    endAt: input.dataset.provenance.endAt,
    collectedAt: input.dataset.provenance.collectedAt,
  })) requireTimestamp(value, `Dataset ${label}`);
}

function mapFills(fills: readonly PerformanceTradeFill[], market: SupportedMarket): Map<string, PerformanceTradeFill> {
  const result = new Map<string, PerformanceTradeFill>();
  for (const fill of fills) {
    if (result.has(fill.id)) throw new Error(`Duplicate BASELINE fill id ${fill.id}.`);
    if (fill.market !== market) throw new Error(`Fill ${fill.id} market does not match ${market}.`);
    requireTimestamp(fill.filledAt, `Fill ${fill.id} filledAt`);
    if (!Number.isFinite(fill.priceKrw) || fill.priceKrw <= 0) throw new Error(`Fill ${fill.id} priceKrw must be finite and positive.`);
    if (!Number.isFinite(fill.volume) || fill.volume <= 0) throw new Error(`Fill ${fill.id} volume must be finite and positive.`);
    result.set(fill.id, fill);
  }
  return result;
}

function mapEpisodes(
  episodes: readonly PositionEpisode[],
  fills: ReadonlyMap<string, PerformanceTradeFill>,
  market: SupportedMarket,
): Map<string, PositionEpisode> {
  const result = new Map<string, PositionEpisode>();
  const entryOwners = new Map<string, string>();
  for (const episode of episodes) {
    if (result.has(episode.id)) throw new Error(`Duplicate position episode id ${episode.id}.`);
    if (episode.market !== market) throw new Error(`Episode ${episode.id} market does not match ${market}.`);
    requireTimestamp(episode.openedAt, `Episode ${episode.id} openedAt`);
    if (episode.entryFillIds.length === 0) throw new Error(`Episode ${episode.id} has no entry fills.`);
    for (const fillId of episode.entryFillIds) {
      const fill = fills.get(fillId);
      if (!fill || fill.side !== "bid") throw new Error(`Episode ${episode.id} has corrupt entry fill relationship ${fillId}.`);
      if (entryOwners.has(fillId)) throw new Error(`Entry fill ${fillId} belongs to multiple position episodes.`);
      entryOwners.set(fillId, episode.id);
    }
    if (episode.status === "COMPLETED") {
      if (episode.closedAt === null || episode.exitFillIds.length === 0) throw new Error(`Completed episode ${episode.id} has corrupt close relationship.`);
      requireTimestamp(episode.closedAt, `Episode ${episode.id} closedAt`);
      if (comparePerformanceTimestamps(episode.openedAt, episode.closedAt) > 0) throw new Error(`Episode ${episode.id} closes before it opens.`);
      const exitFills: PerformanceTradeFill[] = [];
      for (const fillId of episode.exitFillIds) {
        const fill = fills.get(fillId);
        if (!fill || fill.side !== "ask") throw new Error(`Episode ${episode.id} has corrupt exit fill relationship ${fillId}.`);
        exitFills.push(fill);
      }
      const terminalExit = [...exitFills].sort((left, right) => {
        const timestampOrder = comparePerformanceTimestamps(left.filledAt, right.filledAt);
        if (timestampOrder !== 0) return timestampOrder;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      })[exitFills.length - 1];
      if (!terminalExit || comparePerformanceTimestamps(episode.closedAt, terminalExit.filledAt) !== 0) {
        throw new Error(`Completed episode ${episode.id} closedAt must match its terminal exit fill.`);
      }
    } else if (episode.closedAt !== null) {
      throw new Error(`Open episode ${episode.id} has a close timestamp.`);
    }
    result.set(episode.id, episode);
  }
  return result;
}

function validateCandles(dataset: ResearchCandleDataset, market: SupportedMarket): ResearchCandle[] {
  const candles = dataset.candles["1h"];
  const intervals = new Set<string>();
  let previousClose: string | null = null;
  for (const [index, candle] of candles.entries()) {
    if (candle.market !== market || candle.timeframe !== "1h") throw new Error(`Candle ${index} market or timeframe is invalid.`);
    requireTimestamp(candle.openTime, `Candle ${index} openTime`);
    requireTimestamp(candle.closeTime, `Candle ${index} closeTime`);
    if (performanceTimestampEpochNanoseconds(candle.closeTime) - performanceTimestampEpochNanoseconds(candle.openTime) !== HOUR_NANOSECONDS) {
      throw new Error(`Candle ${index} must be a complete 1h interval.`);
    }
    if (previousClose !== null && comparePerformanceTimestamps(previousClose, candle.openTime) > 0) throw new Error("Hourly candles must be ordered and non-overlapping.");
    previousClose = candle.closeTime;
    const key = intervalKey(candle.openTime, candle.closeTime);
    if (intervals.has(key)) throw new Error(`Duplicate hourly candle interval ${key}.`);
    intervals.add(key);
    for (const field of ["openPrice", "highPrice", "lowPrice", "closePrice"] as const) {
      if (!Number.isFinite(candle[field]) || candle[field] <= 0) throw new Error(`Candle ${index} ${field} must be finite and positive.`);
    }
    if (candle.lowPrice > candle.openPrice || candle.lowPrice > candle.closePrice || candle.highPrice < candle.openPrice || candle.highPrice < candle.closePrice) {
      throw new Error(`Candle ${index} OHLC values are inconsistent.`);
    }
  }
  return candles;
}

function validateMatchedAddFill(fill: PerformanceTradeFill, decisionAt: string): void {
  if (fill.side !== "bid" || fill.decisionAction !== "ADD") throw new Error(`Fill ${fill.id} does not evidence an executed ADD bid.`);
  if (comparePerformanceTimestamps(fill.filledAt, decisionAt) !== 0) throw new Error(`Fill ${fill.id} does not match the ADD decision instant.`);
}

function validateNoTradeSourceBoundary(
  boundary: NonNullable<AddPostDecisionExcursionInput["verifiedNoTradeCoverage"]>["sourceBoundary"],
  dataset: ResearchCandleDataset,
): void {
  if (
    comparePerformanceTimestamps(boundary.historyStartAt, dataset.provenance.historyStartAt) !== 0
    || comparePerformanceTimestamps(boundary.endAt, dataset.provenance.endAt) !== 0
  ) {
    throw new Error("Verified no-trade sourceBoundary must match ADD dataset provenance boundaries.");
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

function unavailable(
  exposureId: string,
  reason: AddExcursionReason,
  evidence: AddPostDecisionExcursion["evidence"],
  provenance: AddPostDecisionExcursion["provenance"],
  coverage: AddExcursionCoverage | null = null,
): AddPostDecisionExcursion {
  const metric = reason === "DECISION_AND_EPISODE_CLOSE_SAME_INSTANT" || reason === "NO_COMPLETED_HOURLY_INTERVALS_IN_WINDOW"
    ? notApplicable(reason)
    : unknown(reason);
  return {
    exposureId,
    status: metric.status,
    reason,
    maeKrw: metric,
    mfeKrw: metric,
    maePct: metric,
    mfePct: metric,
    coverage,
    evidence,
    provenance,
    warnings: [WARNING],
  };
}

function pairingReason(status: AddDecisionExposure["pairingStatus"]): AddExcursionReason {
  return status === "PATH_DECISION_DIVERGED" ? "BASELINE_PATH_DECISION_DIVERGED" : "BASELINE_ADD_NOT_EXECUTED";
}

function known(value: number): Metric<number> {
  if (!Number.isFinite(value)) throw new Error("Excursion calculation produced a non-finite result.");
  return { status: "KNOWN", value };
}

function unknown(reason: AddExcursionReason): Metric<number> {
  return { status: "UNKNOWN", reasons: [reason] };
}

function notApplicable(reason: AddExcursionReason): Metric<number> {
  return { status: "NOT_APPLICABLE", reason };
}

function provenanceOf(dataset: ResearchCandleDataset): AddPostDecisionExcursion["provenance"] {
  return {
    datasetSha256: dataset.provenance.sha256,
    source: dataset.provenance.source,
    historyStartAt: dataset.provenance.historyStartAt,
    endAt: dataset.provenance.endAt,
  };
}

function intervalKey(openTime: string, closeTime: string): string {
  return `${formatTimestamp(performanceTimestampEpochNanoseconds(openTime))}/${formatTimestamp(performanceTimestampEpochNanoseconds(closeTime))}`;
}

function requireTimestamp(value: string, label: string): void {
  if (parsePerformanceTimestamp(value) === null) throw new Error(`${label} must be an exact ISO-8601 timestamp with an explicit timezone.`);
}

function formatTimestamp(epochNanoseconds: bigint): string {
  const seconds = epochNanoseconds / 1_000_000_000n;
  const nanoseconds = epochNanoseconds % 1_000_000_000n;
  return `${new Date(Number(seconds * 1_000n)).toISOString().slice(0, 19)}.${nanoseconds.toString().padStart(9, "0")}Z`;
}
