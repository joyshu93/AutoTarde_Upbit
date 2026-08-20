import type {
  CandleCoverageGap,
} from "./performance-candle-coverage.js";
import {
  parsePerformanceTimestamp,
  performanceTimestampEpochNanoseconds,
} from "./performance-timestamp.js";

export type HourlyObservedInterval = {
  openTime: string;
  closeTime: string;
};

const VERIFIED_NO_TRADE_COVERAGE = Symbol("VerifiedNoTradeCoverage");

export type VerifiedNoTradeCoverage = Readonly<{
  sourceBoundary: Readonly<{
    historyStartAt: string;
    endAt: string;
  }>;
  ranges: readonly CandleCoverageGap[];
  sourceSequenceStatus: "COMPLETE";
  sourceBlockingAnomalyCount: 0;
  readonly [VERIFIED_NO_TRADE_COVERAGE]: true;
}>;

export type HourlyCoveragePartition = {
  from: string;
  to: string;
  expectedIntervalCount: number;
  observedIntervalCount: number;
  verifiedNoTradeIntervalCount: number;
  unexplainedMissingIntervalCount: number;
  observedIntervals: readonly string[];
  verifiedNoTradeIntervals: readonly string[];
  verifiedNoTradeRanges: readonly CandleCoverageGap[];
  unexplainedMissingIntervals: readonly string[];
};

type ParsedRange = {
  source: CandleCoverageGap;
  firstClose: bigint;
  lastClose: bigint;
};

const HOUR_NANOSECONDS = 3_600_000_000_000n;

export function createVerifiedNoTradeCoverage(input: {
  sourceBoundary: {
    historyStartAt: string;
    endAt: string;
  };
  observedIntervals: readonly HourlyObservedInterval[];
}): VerifiedNoTradeCoverage {
  if (input.observedIntervals.length === 0) {
    throw new Error("Verified no-trade coverage requires at least one observed source interval.");
  }
  const sourceBoundary = Object.freeze({ ...input.sourceBoundary });
  const partition = partitionHourlyCoverage({
    from: sourceBoundary.historyStartAt,
    to: sourceBoundary.endAt,
    sourceBoundary,
    observedIntervals: input.observedIntervals,
    verifiedNoTradeRanges: [],
  });
  const ranges = Object.freeze(
    groupMissingIntervals(partition.unexplainedMissingIntervals, sourceBoundary)
      .map((range) => Object.freeze(range)),
  );
  return Object.freeze({
    sourceBoundary,
    ranges,
    sourceSequenceStatus: "COMPLETE",
    sourceBlockingAnomalyCount: 0,
    [VERIFIED_NO_TRADE_COVERAGE]: true as const,
  });
}

export function createVerifiedNoTradeCoverageFromRanges(input: {
  sourceBoundary: {
    historyStartAt: string;
    endAt: string;
  };
  observedIntervals: readonly HourlyObservedInterval[];
  verifiedNoTradeRanges: readonly CandleCoverageGap[];
}): VerifiedNoTradeCoverage {
  if (input.observedIntervals.length === 0) {
    throw new Error("Verified no-trade coverage requires at least one observed source interval.");
  }
  const sourceBoundary = Object.freeze({ ...input.sourceBoundary });
  const partition = partitionHourlyCoverage({
    from: sourceBoundary.historyStartAt,
    to: sourceBoundary.endAt,
    sourceBoundary,
    observedIntervals: input.observedIntervals,
    verifiedNoTradeRanges: input.verifiedNoTradeRanges,
  });
  if (partition.unexplainedMissingIntervalCount > 0) {
    throw new Error(
      `Verified no-trade coverage leaves ${partition.unexplainedMissingIntervalCount} unexplained missing hourly interval(s).`,
    );
  }
  const ranges = Object.freeze(
    partition.verifiedNoTradeRanges.map((range) => Object.freeze({ ...range })),
  );
  return Object.freeze({
    sourceBoundary,
    ranges,
    sourceSequenceStatus: "COMPLETE",
    sourceBlockingAnomalyCount: 0,
    [VERIFIED_NO_TRADE_COVERAGE]: true as const,
  });
}

function groupMissingIntervals(
  intervalKeys: readonly string[],
  sourceBoundary: Readonly<{ historyStartAt: string; endAt: string }>,
): CandleCoverageGap[] {
  const historyStart = performanceTimestampEpochNanoseconds(sourceBoundary.historyStartAt);
  const sourceEnd = performanceTimestampEpochNanoseconds(sourceBoundary.endAt);
  const closes = intervalKeys.map((key, index) => {
    const separator = key.indexOf("/");
    if (separator < 0) throw new Error(`Derived missing interval ${index} is malformed.`);
    return performanceTimestampEpochNanoseconds(key.slice(separator + 1));
  });
  const ranges: CandleCoverageGap[] = [];
  for (let index = 0; index < closes.length;) {
    const firstClose = closes[index]!;
    let lastClose = firstClose;
    let count = 1;
    index += 1;
    while (index < closes.length && closes[index] === lastClose + HOUR_NANOSECONDS) {
      lastClose = closes[index]!;
      count += 1;
      index += 1;
    }
    ranges.push({
      firstMissingCloseTime: formatTimestamp(firstClose),
      lastMissingCloseTime: formatTimestamp(lastClose),
      missingCandleCount: count,
      previousObservedCloseTime: firstClose - HOUR_NANOSECONDS > historyStart
        ? formatTimestamp(firstClose - HOUR_NANOSECONDS)
        : null,
      nextObservedCloseTime: lastClose + HOUR_NANOSECONDS <= sourceEnd
        ? formatTimestamp(lastClose + HOUR_NANOSECONDS)
        : null,
    });
  }
  return ranges;
}

export function assertVerifiedNoTradeCoverage(
  coverage: VerifiedNoTradeCoverage,
): void {
  if ((coverage as VerifiedNoTradeCoverage)[VERIFIED_NO_TRADE_COVERAGE] !== true) {
    throw new Error("Verified no-trade coverage must be created by createVerifiedNoTradeCoverage.");
  }
}

export function partitionHourlyCoverage(input: {
  from: string;
  to: string;
  sourceBoundary: {
    historyStartAt: string;
    endAt: string;
  };
  observedIntervals: readonly HourlyObservedInterval[];
  verifiedNoTradeRanges: readonly CandleCoverageGap[];
}): HourlyCoveragePartition {
  const from = requireTimestamp(input.from, "Hourly coverage from");
  const to = requireTimestamp(input.to, "Hourly coverage to");
  const historyStart = requireTimestamp(
    input.sourceBoundary.historyStartAt,
    "Hourly coverage sourceBoundary historyStartAt",
  );
  const sourceEnd = requireTimestamp(
    input.sourceBoundary.endAt,
    "Hourly coverage sourceBoundary endAt",
  );

  if (historyStart >= sourceEnd) {
    throw new Error("Hourly coverage sourceBoundary historyStartAt must be before endAt.");
  }
  requireHourAlignment(
    sourceEnd,
    historyStart,
    "Hourly coverage sourceBoundary endAt",
  );
  if (from >= to) throw new Error("Hourly coverage from must be before to.");
  requireHourAlignment(from, historyStart, "Hourly coverage from");
  requireHourAlignment(to, historyStart, "Hourly coverage to");
  if (from < historyStart || to > sourceEnd) {
    throw new Error("Hourly coverage analysis window falls outside sourceBoundary.");
  }

  const intervalCount = Number((to - from) / HOUR_NANOSECONDS);
  if (!Number.isSafeInteger(intervalCount) || intervalCount < 0) {
    throw new Error("Hourly coverage expected interval count must be a non-negative safe integer.");
  }
  if (from + BigInt(intervalCount) * HOUR_NANOSECONDS !== to) {
    throw new Error("Hourly coverage from and to must span exact aligned hours.");
  }

  const observedByKey = new Map<string, bigint>();
  for (const [index, interval] of input.observedIntervals.entries()) {
    const open = requireTimestamp(interval.openTime, `Observed interval ${index} openTime`);
    const close = requireTimestamp(interval.closeTime, `Observed interval ${index} closeTime`);
    requireHourAlignment(open, historyStart, `Observed interval ${index} openTime`);
    if (close - open !== HOUR_NANOSECONDS) {
      throw new Error(`Observed interval ${index} must represent exactly one aligned hour.`);
    }
    if (open < historyStart || close > sourceEnd) {
      throw new Error(`Observed interval ${index} falls outside sourceBoundary.`);
    }
    const key = intervalKey(open, close);
    if (observedByKey.has(key)) throw new Error(`Duplicate observed hourly interval ${key}.`);
    observedByKey.set(key, open);
  }

  const parsedRanges = parseRanges(input.verifiedNoTradeRanges, historyStart, sourceEnd);
  const noTradeByKey = new Map<string, bigint>();
  for (const range of parsedRanges) {
    for (let close = range.firstClose; close <= range.lastClose; close += HOUR_NANOSECONDS) {
      const key = intervalKey(close - HOUR_NANOSECONDS, close);
      if (observedByKey.has(key)) {
        throw new Error(`Observed and verified no-trade evidence collision at ${key}.`);
      }
      noTradeByKey.set(key, close - HOUR_NANOSECONDS);
    }
  }
  validateRangeNeighborsAgainstObservations(parsedRanges, observedByKey, from, to);

  const observedIntervals: string[] = [];
  const verifiedNoTradeIntervals: string[] = [];
  const unexplainedMissingIntervals: string[] = [];
  for (let index = 0; index < intervalCount; index += 1) {
    const open = from + BigInt(index) * HOUR_NANOSECONDS;
    const key = intervalKey(open, open + HOUR_NANOSECONDS);
    if (observedByKey.has(key)) observedIntervals.push(key);
    else if (noTradeByKey.has(key)) verifiedNoTradeIntervals.push(key);
    else unexplainedMissingIntervals.push(key);
  }

  return {
    from: formatTimestamp(from),
    to: formatTimestamp(to),
    expectedIntervalCount: intervalCount,
    observedIntervalCount: observedIntervals.length,
    verifiedNoTradeIntervalCount: verifiedNoTradeIntervals.length,
    unexplainedMissingIntervalCount: unexplainedMissingIntervals.length,
    observedIntervals,
    verifiedNoTradeIntervals,
    verifiedNoTradeRanges: parsedRanges
      .map((range) => clipRange(range, from, to))
      .filter((range): range is CandleCoverageGap => range !== null),
    unexplainedMissingIntervals,
  };
}

function clipRange(range: ParsedRange, from: bigint, to: bigint): CandleCoverageGap | null {
  const firstClose = range.firstClose < from + HOUR_NANOSECONDS
    ? from + HOUR_NANOSECONDS
    : range.firstClose;
  const lastClose = range.lastClose > to ? to : range.lastClose;
  if (firstClose > lastClose) return null;
  const missingCandleCount = Number((lastClose - firstClose) / HOUR_NANOSECONDS + 1n);
  if (!Number.isSafeInteger(missingCandleCount) || missingCandleCount <= 0) {
    throw new Error("Clipped verified no-trade range count must be a positive safe integer.");
  }
  return {
    firstMissingCloseTime: formatTimestamp(firstClose),
    lastMissingCloseTime: formatTimestamp(lastClose),
    missingCandleCount,
    previousObservedCloseTime: firstClose - HOUR_NANOSECONDS > from
      ? formatTimestamp(firstClose - HOUR_NANOSECONDS)
      : null,
    nextObservedCloseTime: lastClose + HOUR_NANOSECONDS <= to
      ? formatTimestamp(lastClose + HOUR_NANOSECONDS)
      : null,
  };
}

function parseRanges(
  ranges: readonly CandleCoverageGap[],
  historyStart: bigint,
  sourceEnd: bigint,
): ParsedRange[] {
  const parsed: ParsedRange[] = [];
  let previousLastClose: bigint | null = null;
  for (const [index, range] of ranges.entries()) {
    const firstClose = requireTimestamp(
      range.firstMissingCloseTime,
      `Verified no-trade range ${index} firstMissingCloseTime`,
    );
    const lastClose = requireTimestamp(
      range.lastMissingCloseTime,
      `Verified no-trade range ${index} lastMissingCloseTime`,
    );
    requireHourAlignment(firstClose, historyStart, `Verified no-trade range ${index} firstMissingCloseTime`);
    requireHourAlignment(lastClose, historyStart, `Verified no-trade range ${index} lastMissingCloseTime`);
    if (firstClose > lastClose) {
      throw new Error(`Verified no-trade range ${index} is reversed.`);
    }
    if (firstClose - HOUR_NANOSECONDS < historyStart || lastClose > sourceEnd) {
      throw new Error(`Verified no-trade range ${index} falls outside sourceBoundary.`);
    }
    const expectedCount = Number((lastClose - firstClose) / HOUR_NANOSECONDS + 1n);
    if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) {
      throw new Error(`Verified no-trade range ${index} count must be a positive safe integer.`);
    }
    if (!Number.isSafeInteger(range.missingCandleCount) || range.missingCandleCount !== expectedCount) {
      throw new Error(`Verified no-trade range ${index} missingCandleCount does not match its boundaries.`);
    }
    if (previousLastClose !== null) {
      if (firstClose <= previousLastClose) throw new Error("Verified no-trade ranges overlap or are not strictly ordered.");
      if (firstClose === previousLastClose + HOUR_NANOSECONDS) {
        throw new Error("Adjacent verified no-trade ranges must be represented as one canonical range.");
      }
    }
    validateNeighbor(
      range.previousObservedCloseTime,
      firstClose - HOUR_NANOSECONDS > historyStart ? firstClose - HOUR_NANOSECONDS : null,
      historyStart,
      sourceEnd,
      `Verified no-trade range ${index} previousObservedCloseTime`,
    );
    validateNeighbor(
      range.nextObservedCloseTime,
      lastClose + HOUR_NANOSECONDS <= sourceEnd ? lastClose + HOUR_NANOSECONDS : null,
      historyStart,
      sourceEnd,
      `Verified no-trade range ${index} nextObservedCloseTime`,
    );
    parsed.push({ source: copyGap(range), firstClose, lastClose });
    previousLastClose = lastClose;
  }
  return parsed;
}

function validateNeighbor(
  value: string | null,
  expected: bigint | null,
  historyStart: bigint,
  sourceEnd: bigint,
  label: string,
): void {
  if (value === null) {
    if (expected !== null) throw new Error(`${label} contradicts the no-trade range position.`);
    return;
  }
  const instant = requireTimestamp(value, label);
  requireHourAlignment(instant, historyStart, label);
  if (instant < historyStart || instant > sourceEnd) throw new Error(`${label} falls outside sourceBoundary.`);
  if (expected === null || instant !== expected) {
    throw new Error(`${label} contradicts the no-trade range position.`);
  }
}

function validateRangeNeighborsAgainstObservations(
  ranges: readonly ParsedRange[],
  observedByKey: ReadonlyMap<string, bigint>,
  from: bigint,
  to: bigint,
): void {
  for (const range of ranges) {
    for (const [label, value] of [
      ["previousObservedCloseTime", range.source.previousObservedCloseTime],
      ["nextObservedCloseTime", range.source.nextObservedCloseTime],
    ] as const) {
      if (value === null) continue;
      const close = performanceTimestampEpochNanoseconds(value);
      const open = close - HOUR_NANOSECONDS;
      if (open >= from && close <= to && !observedByKey.has(intervalKey(open, close))) {
        throw new Error(`Verified no-trade ${label} has no matching observed interval in the analysis window.`);
      }
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

function requireTimestamp(value: string, label: string): bigint {
  if (parsePerformanceTimestamp(value) === null) {
    throw new Error(`${label} must be an exact ISO-8601 timestamp with an explicit timezone.`);
  }
  return performanceTimestampEpochNanoseconds(value);
}

function requireHourAlignment(value: bigint, anchor: bigint, label: string): void {
  if ((value - anchor) % HOUR_NANOSECONDS !== 0n) {
    throw new Error(`${label} must be aligned to an exact hour from sourceBoundary historyStartAt.`);
  }
}

function intervalKey(open: bigint, close: bigint): string {
  return `${formatTimestamp(open)}/${formatTimestamp(close)}`;
}

function formatTimestamp(epochNanoseconds: bigint): string {
  const seconds = epochNanoseconds / 1_000_000_000n;
  const nanoseconds = epochNanoseconds % 1_000_000_000n;
  return `${new Date(Number(seconds * 1_000n)).toISOString().slice(0, 19)}.${nanoseconds.toString().padStart(9, "0")}Z`;
}
