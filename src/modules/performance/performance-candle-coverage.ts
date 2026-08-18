import type { SupportedStrategyTimeframe } from "../strategy/market-structure.js";
import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
} from "./performance-timestamp.js";
import type {
  ResearchCandleDataset,
  ResearchCandleTimeframe,
} from "./research-candle-dataset.js";

export type PositionGuardFeatureCoverageFrame = {
  generatedAt: string;
  latestCloseTime: Record<SupportedStrategyTimeframe, string | null>;
};

export type CandleCoverageGap = {
  firstMissingCloseTime: string;
  lastMissingCloseTime: string;
  missingCandleCount: number;
  previousObservedCloseTime: string | null;
  nextObservedCloseTime: string | null;
};

export type AffectedFrameRange = {
  firstFrameAt: string;
  lastFrameAt: string;
  affectedFrameCount: number;
};

export type CandleCadenceOccurrence = {
  observedAt: string;
  occurrenceCount: number;
};

export type SourceSequenceStatus = "COMPLETE" | "INCOMPLETE";

export type ClockGridStatus = "DENSE" | "SPARSE_BY_CONTRACT" | "ANOMALOUS";

export type PositionGuardTimeframeFeatureCoverage = {
  timeframe: ResearchCandleTimeframe;
  intervalMs: number;
  sourceCadenceStatus: "COMPLETE" | "INCOMPLETE";
  sourceSequenceStatus: SourceSequenceStatus;
  clockGridStatus: ClockGridStatus;
  sourceExpectedCandleCount: number;
  sourceObservedCandleCount: number;
  sourceMissingCandleCount: number;
  sourceDuplicateCandleCount: number;
  sourceOffGridCandleCount: number;
  sourceMissingRanges: CandleCoverageGap[];
  sourceDuplicateInstants: CandleCadenceOccurrence[];
  sourceOffGridInstants: CandleCadenceOccurrence[];
  sourceNoTradeIntervalCount: number;
  sourceNoTradeRanges: CandleCoverageGap[];
  sourceBlockingAnomalyCount: number;
  lookbackContinuityStatus: "COMPLETE" | "INCOMPLETE";
  evaluatedFrameCount: number;
  affectedFrameCount: number;
  affectedFrameRanges: AffectedFrameRange[];
};

export type PositionGuardFeatureCoverage = {
  status: "COMPLETE" | "INCOMPLETE";
  continuityPolicy: "GENERATED_CANDLES_SINCE_DATASET_START";
  requiredLookbackCandles: number;
  frameCount: number;
  affectedFrameCount: number;
  affectedFrameRanges: AffectedFrameRange[];
  timeframes: Record<ResearchCandleTimeframe, PositionGuardTimeframeFeatureCoverage>;
};

const TIMEFRAMES: readonly ResearchCandleTimeframe[] = ["1h", "4h", "1d"];
const TIMEFRAME_INTERVAL_MS: Record<ResearchCandleTimeframe, number> = {
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
};
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

type TimestampedFrame = {
  generatedAt: string;
  generatedAtNanoseconds: bigint;
  latestCloseTime: Record<SupportedStrategyTimeframe, string | null>;
};

type SourceCadence = {
  status: "COMPLETE" | "INCOMPLETE";
  sequenceStatus: SourceSequenceStatus;
  clockGridStatus: ClockGridStatus;
  expectedCount: number;
  observedCount: number;
  missingCount: number;
  duplicateCount: number;
  offGridCount: number;
  missingRanges: CandleCoverageGap[];
  duplicateInstants: CandleCadenceOccurrence[];
  offGridInstants: CandleCadenceOccurrence[];
  firstExpectedClose: bigint;
  intervalNanoseconds: bigint;
  actualCloseInstants: readonly bigint[];
  firstBlockingAnomalyAt: bigint | null;
};

export function analyzePositionGuardFeatureCoverage(input: {
  dataset: ResearchCandleDataset;
  frames: readonly PositionGuardFeatureCoverageFrame[];
  requiredLookbackCandles: number;
}): PositionGuardFeatureCoverage {
  if (!Number.isSafeInteger(input.requiredLookbackCandles) || input.requiredLookbackCandles <= 0) {
    throw new Error("PositionGuard requiredLookbackCandles must be a positive safe integer.");
  }
  const frames = input.frames.map(parseFrame).sort((left, right) =>
    compareBigInt(left.generatedAtNanoseconds, right.generatedAtNanoseconds)
  );
  const affectedAcrossTimeframes = new Map<bigint, string>();
  const timeframes = Object.fromEntries(TIMEFRAMES.map((timeframe) => {
    const source = analyzeSourceCadence(input.dataset, timeframe);
    const affectedFrames = frames.filter((frame) => {
      const latestCloseTime = frame.latestCloseTime[timeframe];
      if (latestCloseTime === null) return true;
      const latestClose = requireTimestamp(latestCloseTime, `${timeframe} latestCloseTime`);
      if (latestClose > frame.generatedAtNanoseconds) {
        throw new Error(`${timeframe} latestCloseTime must not be after frame generatedAt.`);
      }
      const actualPrefixCount = countActualClosesAtOrBefore(source.actualCloseInstants, latestClose);
      if (actualPrefixCount < input.requiredLookbackCandles) return true;
      const actualLatestClose = latestActualCloseAtOrBefore(
        source.actualCloseInstants,
        frame.generatedAtNanoseconds,
      );
      if (actualLatestClose === null || latestClose !== actualLatestClose) return true;
      return source.firstBlockingAnomalyAt !== null && source.firstBlockingAnomalyAt <= latestClose;
    });
    for (const frame of affectedFrames) {
      affectedAcrossTimeframes.set(frame.generatedAtNanoseconds, frame.generatedAt);
    }
    const affectedFrameRanges = groupFrames(affectedFrames);
    const coverage: PositionGuardTimeframeFeatureCoverage = {
      timeframe,
      intervalMs: TIMEFRAME_INTERVAL_MS[timeframe],
      sourceCadenceStatus: source.status,
      sourceSequenceStatus: source.sequenceStatus,
      clockGridStatus: source.clockGridStatus,
      sourceExpectedCandleCount: source.expectedCount,
      sourceObservedCandleCount: source.observedCount,
      sourceMissingCandleCount: source.missingCount,
      sourceDuplicateCandleCount: source.duplicateCount,
      sourceOffGridCandleCount: source.offGridCount,
      sourceMissingRanges: copyGaps(source.missingRanges),
      sourceDuplicateInstants: copyOccurrences(source.duplicateInstants),
      sourceOffGridInstants: copyOccurrences(source.offGridInstants),
      sourceNoTradeIntervalCount: source.missingRanges.reduce(
        (sum, range) => sum + range.missingCandleCount,
        0,
      ),
      sourceNoTradeRanges: copyGaps(source.missingRanges),
      sourceBlockingAnomalyCount: source.duplicateCount + source.offGridCount,
      lookbackContinuityStatus: affectedFrames.length === 0 ? "COMPLETE" : "INCOMPLETE",
      evaluatedFrameCount: frames.length,
      affectedFrameCount: affectedFrames.length,
      affectedFrameRanges,
    };
    return [timeframe, coverage] as const;
  })) as Record<ResearchCandleTimeframe, PositionGuardTimeframeFeatureCoverage>;
  const affectedFrames = [...affectedAcrossTimeframes.entries()]
    .sort(([left], [right]) => compareBigInt(left, right))
    .map(([generatedAtNanoseconds, generatedAt]) => ({
      generatedAt,
      generatedAtNanoseconds,
      latestCloseTime: { "1h": null, "4h": null, "1d": null },
    }));

  return {
    status: affectedFrames.length === 0
      && TIMEFRAMES.every((timeframe) => timeframes[timeframe].sourceSequenceStatus === "COMPLETE")
      ? "COMPLETE"
      : "INCOMPLETE",
    continuityPolicy: "GENERATED_CANDLES_SINCE_DATASET_START",
    requiredLookbackCandles: input.requiredLookbackCandles,
    frameCount: frames.length,
    affectedFrameCount: affectedFrames.length,
    affectedFrameRanges: groupFrames(affectedFrames),
    timeframes,
  };
}

function analyzeSourceCadence(
  dataset: ResearchCandleDataset,
  timeframe: ResearchCandleTimeframe,
): SourceCadence {
  const intervalNanoseconds = BigInt(TIMEFRAME_INTERVAL_MS[timeframe]) * NANOSECONDS_PER_MILLISECOND;
  const historyStart = requireTimestamp(dataset.provenance.historyStartAt, "dataset historyStartAt");
  const provenanceEnd = requireTimestamp(dataset.provenance.endAt, "dataset endAt");
  const observed = dataset.candles[timeframe].map((candle, index) => ({
    open: requireTimestamp(candle.openTime, `${timeframe}[${index}].openTime`),
    close: requireTimestamp(candle.closeTime, `${timeframe}[${index}].closeTime`),
  })).sort((left, right) => compareBigInt(left.close, right.close));
  const observedInstants = observed.map((item) => item.close);
  const firstObserved = observed[0];
  const lastObservedClose = observed.at(-1)?.close ?? historyStart;
  const leadingIntervals = firstObserved === undefined || firstObserved.open <= historyStart
    ? 0n
    : (firstObserved.open - historyStart) / intervalNanoseconds;
  const firstExpectedClose = firstObserved === undefined
    ? historyStart + intervalNanoseconds
    : firstObserved.close - leadingIntervals * intervalNanoseconds;
  const trailingIntervals = provenanceEnd <= lastObservedClose
    ? 0n
    : (provenanceEnd - lastObservedClose) / intervalNanoseconds;
  const lastExpectedClose = firstObserved === undefined
    ? provenanceEnd
    : lastObservedClose + trailingIntervals * intervalNanoseconds;
  const expectedCount = lastExpectedClose < firstExpectedClose
    ? 0
    : Number((lastExpectedClose - firstExpectedClose) / intervalNanoseconds + 1n);
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new Error(`Research ${timeframe} expected candle count must be a non-negative safe integer.`);
  }
  const expectedInstants = Array.from({ length: expectedCount }, (_, index) =>
    firstExpectedClose + BigInt(index) * intervalNanoseconds
  );
  const expectedSet = new Set(expectedInstants);
  const observedCounts = new Map<bigint, number>();
  for (const close of observedInstants) {
    observedCounts.set(close, (observedCounts.get(close) ?? 0) + 1);
  }
  const missing = expectedInstants.filter((instant) => !observedCounts.has(instant));
  const duplicateCount = [...observedCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const offGridCount = [...observedCounts.entries()].reduce(
    (sum, [instant, count]) => sum + (
      instant % intervalNanoseconds === 0n && expectedSet.has(instant) && instant <= provenanceEnd ? 0 : count
    ),
    0,
  );
  const missingRanges = groupMissingCandles(missing, observedCounts, intervalNanoseconds);
  const duplicateInstants = [...observedCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([instant, count]) => ({ observedAt: formatTimestamp(instant), occurrenceCount: count }));
  const offGridInstants = [...observedCounts.entries()]
    .filter(([instant]) => instant % intervalNanoseconds !== 0n || !expectedSet.has(instant) || instant > provenanceEnd)
    .map(([instant, count]) => ({ observedAt: formatTimestamp(instant), occurrenceCount: count }));
  const blockingAnomalyInstants = [
    ...[...observedCounts.entries()].flatMap(([instant, count]) => count > 1 ? [instant] : []),
    ...[...observedCounts.keys()].filter((instant) =>
      instant % intervalNanoseconds !== 0n || !expectedSet.has(instant) || instant > provenanceEnd
    ),
  ].sort(compareBigInt);
  const status = expectedCount > 0 && missing.length === 0 && duplicateCount === 0 && offGridCount === 0
    && dataset.candles[timeframe].length === expectedCount
    ? "COMPLETE"
    : "INCOMPLETE";
  const sequenceStatus: SourceSequenceStatus = observedInstants.length > 0 && duplicateCount === 0 && offGridCount === 0
    ? "COMPLETE"
    : "INCOMPLETE";
  const clockGridStatus: ClockGridStatus = duplicateCount > 0 || offGridCount > 0
    ? "ANOMALOUS"
    : missing.length > 0
      ? "SPARSE_BY_CONTRACT"
      : "DENSE";
  return {
    status,
    sequenceStatus,
    clockGridStatus,
    expectedCount,
    observedCount: dataset.candles[timeframe].length,
    missingCount: missing.length,
    duplicateCount,
    offGridCount,
    missingRanges,
    duplicateInstants,
    offGridInstants,
    firstExpectedClose,
    intervalNanoseconds,
    actualCloseInstants: observedInstants,
    firstBlockingAnomalyAt: blockingAnomalyInstants[0] ?? null,
  };
}

function groupMissingCandles(
  missing: readonly bigint[],
  observedCounts: ReadonlyMap<bigint, number>,
  intervalNanoseconds: bigint,
): CandleCoverageGap[] {
  const ranges: CandleCoverageGap[] = [];
  for (const instant of missing) {
    const previous = ranges.at(-1);
    if (previous !== undefined) {
      const previousLast = requireTimestamp(previous.lastMissingCloseTime, "lastMissingCloseTime");
      if (instant - previousLast === intervalNanoseconds) {
        previous.lastMissingCloseTime = formatTimestamp(instant);
        previous.missingCandleCount += 1;
        previous.nextObservedCloseTime = observedCounts.has(instant + intervalNanoseconds)
          ? formatTimestamp(instant + intervalNanoseconds)
          : null;
        continue;
      }
    }
    ranges.push({
      firstMissingCloseTime: formatTimestamp(instant),
      lastMissingCloseTime: formatTimestamp(instant),
      missingCandleCount: 1,
      previousObservedCloseTime: observedCounts.has(instant - intervalNanoseconds)
        ? formatTimestamp(instant - intervalNanoseconds)
        : null,
      nextObservedCloseTime: observedCounts.has(instant + intervalNanoseconds)
        ? formatTimestamp(instant + intervalNanoseconds)
        : null,
    });
  }
  return ranges;
}

function parseFrame(frame: PositionGuardFeatureCoverageFrame): TimestampedFrame {
  return {
    generatedAt: frame.generatedAt,
    generatedAtNanoseconds: requireTimestamp(frame.generatedAt, "frame generatedAt"),
    latestCloseTime: { ...frame.latestCloseTime },
  };
}

function groupFrames(frames: readonly TimestampedFrame[]): AffectedFrameRange[] {
  const ranges: AffectedFrameRange[] = [];
  const expectedInterval = BigInt(TIMEFRAME_INTERVAL_MS["1h"]) * NANOSECONDS_PER_MILLISECOND;
  for (const frame of frames) {
    const previous = ranges.at(-1);
    if (previous !== undefined) {
      const previousLast = requireTimestamp(previous.lastFrameAt, "lastFrameAt");
      if (frame.generatedAtNanoseconds - previousLast === expectedInterval) {
        previous.lastFrameAt = frame.generatedAt;
        previous.affectedFrameCount += 1;
        continue;
      }
    }
    ranges.push({
      firstFrameAt: frame.generatedAt,
      lastFrameAt: frame.generatedAt,
      affectedFrameCount: 1,
    });
  }
  return ranges;
}

function countActualClosesAtOrBefore(actualCloses: readonly bigint[], instant: bigint): number {
  let low = 0;
  let high = actualCloses.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (actualCloses[middle]! <= instant) low = middle + 1;
    else high = middle;
  }
  return low;
}

function latestActualCloseAtOrBefore(actualCloses: readonly bigint[], instant: bigint): bigint | null {
  const count = countActualClosesAtOrBefore(actualCloses, instant);
  return count === 0 ? null : actualCloses[count - 1]!;
}

function copyGaps(gaps: readonly CandleCoverageGap[]): CandleCoverageGap[] {
  return gaps.map((gap) => ({ ...gap }));
}

function copyOccurrences(occurrences: readonly CandleCadenceOccurrence[]): CandleCadenceOccurrence[] {
  return occurrences.map((occurrence) => ({ ...occurrence }));
}

function requireTimestamp(value: string, label: string): bigint {
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) throw new Error(`${label} must be an explicit-timezone ISO timestamp.`);
  return parsed.epochNanoseconds;
}

function formatTimestamp(epochNanoseconds: bigint): string {
  const nanosecondsPerSecond = 1_000_000_000n;
  const seconds = epochNanoseconds / nanosecondsPerSecond;
  const fractionalNanoseconds = epochNanoseconds % nanosecondsPerSecond;
  const milliseconds = Number(seconds * 1_000n);
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Coverage timestamp is outside the safe range.");
  const prefix = new Date(milliseconds).toISOString().slice(0, 19);
  if (fractionalNanoseconds % NANOSECONDS_PER_MILLISECOND === 0n) {
    return `${prefix}.${(fractionalNanoseconds / NANOSECONDS_PER_MILLISECOND).toString().padStart(3, "0")}Z`;
  }
  return `${prefix}.${fractionalNanoseconds.toString().padStart(9, "0")}Z`;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
