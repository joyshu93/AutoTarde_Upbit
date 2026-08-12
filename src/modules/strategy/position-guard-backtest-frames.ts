import type { SupportedAsset, SupportedMarket } from "../../domain/types.js";
import {
  analyzePositionGuardMarketStructure,
  type PositionGuardMarketSnapshot,
  type StrategyMarketCandle,
  type SupportedStrategyTimeframe,
} from "./market-structure.js";
import type { PositionGuardBacktestFrame } from "./position-guard-backtest.js";

export interface PositionGuardBacktestFrameSource {
  candleCounts: Record<SupportedStrategyTimeframe, number>;
  latestCloseTime: Record<SupportedStrategyTimeframe, string | null>;
}

export interface BuildPositionGuardBacktestFramesInput {
  asset: SupportedAsset;
  market: SupportedMarket;
  oneHourCandles: readonly StrategyMarketCandle[];
  fourHourCandles: readonly StrategyMarketCandle[];
  oneDayCandles: readonly StrategyMarketCandle[];
  startAt?: string;
  endAt?: string;
  minimumCompletedCandles?: Partial<Record<SupportedStrategyTimeframe, number>>;
}

export type PositionGuardBacktestAnalysisFrame = PositionGuardBacktestFrame & {
  source: PositionGuardBacktestFrameSource;
};

const DEFAULT_MINIMUM_COMPLETED_CANDLES: Record<SupportedStrategyTimeframe, number> = {
  "1h": 200,
  "4h": 200,
  "1d": 200,
};
const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

type BacktestTimestamp = {
  epochMilliseconds: number;
  epochNanoseconds: bigint;
  exactTimestamp: string;
};

type IndexedCandle = {
  candle: StrategyMarketCandle;
  timestamp: BacktestTimestamp;
};

export function buildPositionGuardBacktestFrames(
  input: BuildPositionGuardBacktestFramesInput,
): PositionGuardBacktestAnalysisFrame[] {
  const minimumCompletedCandles = {
    ...DEFAULT_MINIMUM_COMPLETED_CANDLES,
    ...input.minimumCompletedCandles,
  };
  const indexedCandles = {
    "1h": indexCandles(input.oneHourCandles),
    "4h": indexCandles(input.fourHourCandles),
    "1d": indexCandles(input.oneDayCandles),
  };
  const start = input.startAt === undefined ? null : parseTimestamp(input.startAt, "startAt");
  const end = input.endAt === undefined ? null : parseTimestamp(input.endAt, "endAt");
  const frames: PositionGuardBacktestAnalysisFrame[] = [];
  const completedCounts: Record<SupportedStrategyTimeframe, number> = {
    "1h": 0,
    "4h": 0,
    "1d": 0,
  };

  for (const indexedDecisionCandle of indexedCandles["1h"]) {
    const decisionCandle = indexedDecisionCandle.candle;
    const decision = indexedDecisionCandle.timestamp;
    if (start !== null && decision.epochNanoseconds < start.epochNanoseconds) continue;
    if (end !== null && decision.epochNanoseconds > end.epochNanoseconds) continue;

    advanceCompletedCounts(indexedCandles, completedCounts, decision.epochNanoseconds);
    if (!hasMinimumCompletedCandles(completedCounts, minimumCompletedCandles)) {
      continue;
    }
    const completed = materializeCompletedCandles(indexedCandles, completedCounts);

    const generatedAt = decision.exactTimestamp;
    const snapshot: PositionGuardMarketSnapshot = {
      asset: input.asset,
      market: input.market,
      fetchedAt: generatedAt,
      ticker: {
        tradePrice: decisionCandle.closePrice,
        tradeTimeUtc: generatedAt,
        exchangeTimestampMs: decision.epochMilliseconds,
        fetchedAt: generatedAt,
      },
      timeframes: {
        "1h": { timeframe: "1h", candles: completed["1h"] },
        "4h": { timeframe: "4h", candles: completed["4h"] },
        "1d": { timeframe: "1d", candles: completed["1d"] },
      },
    };

    frames.push({
      generatedAt,
      analysis: analyzePositionGuardMarketStructure(snapshot, 0),
      source: {
        candleCounts: {
          "1h": completed["1h"].length,
          "4h": completed["4h"].length,
          "1d": completed["1d"].length,
        },
        latestCloseTime: {
          "1h": getLatestCloseTime(completed["1h"]),
          "4h": getLatestCloseTime(completed["4h"]),
          "1d": getLatestCloseTime(completed["1d"]),
        },
      },
    });
  }

  return frames;
}

function indexCandles(candles: readonly StrategyMarketCandle[]): IndexedCandle[] {
  return candles.map((sourceCandle) => {
    const { closeTime, ...candleWithoutCloseTime } = sourceCandle;
    return {
      candle: { ...candleWithoutCloseTime, closeTime },
      timestamp: parseTimestamp(closeTime, "closeTime"),
    };
  }).sort((left, right) => compareEpochNanoseconds(
    left.timestamp.epochNanoseconds,
    right.timestamp.epochNanoseconds,
  ));
}

function advanceCompletedCounts(
  indexedCandles: Record<SupportedStrategyTimeframe, IndexedCandle[]>,
  completedCounts: Record<SupportedStrategyTimeframe, number>,
  cutoffEpochNanoseconds: bigint,
): void {
  for (const timeframe of ["1h", "4h", "1d"] as const) {
    const candles = indexedCandles[timeframe];
    while (
      completedCounts[timeframe] < candles.length &&
      candles[completedCounts[timeframe]]!.timestamp.epochNanoseconds <= cutoffEpochNanoseconds
    ) {
      completedCounts[timeframe] += 1;
    }
  }
}

function materializeCompletedCandles(
  indexedCandles: Record<SupportedStrategyTimeframe, IndexedCandle[]>,
  completedCounts: Record<SupportedStrategyTimeframe, number>,
): Record<SupportedStrategyTimeframe, StrategyMarketCandle[]> {
  return {
    "1h": indexedCandles["1h"].slice(0, completedCounts["1h"]).map(({ candle }) => candle),
    "4h": indexedCandles["4h"].slice(0, completedCounts["4h"]).map(({ candle }) => candle),
    "1d": indexedCandles["1d"].slice(0, completedCounts["1d"]).map(({ candle }) => candle),
  };
}

function hasMinimumCompletedCandles(
  completedCounts: Record<SupportedStrategyTimeframe, number>,
  minimumCompletedCandles: Record<SupportedStrategyTimeframe, number>,
): boolean {
  return completedCounts["1h"] >= minimumCompletedCandles["1h"] &&
    completedCounts["4h"] >= minimumCompletedCandles["4h"] &&
    completedCounts["1d"] >= minimumCompletedCandles["1d"];
}

function getLatestCloseTime(candles: readonly StrategyMarketCandle[]): string | null {
  return candles[candles.length - 1]?.closeTime ?? null;
}

function parseTimestamp(value: string, label: string): BacktestTimestamp {
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) {
    throw new Error(`Invalid PositionGuard backtest ${label}: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const explicitTimezone = match[8];
  const timezone = explicitTimezone ?? "Z";
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 || !isValidTimezone(timezone)
  ) {
    throw new Error(`Invalid PositionGuard backtest ${label}: ${value}`);
  }

  const wholeSecond = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${timezone}`;
  const wholeSecondMs = Date.parse(wholeSecond);
  if (!Number.isFinite(wholeSecondMs)) {
    throw new Error(`Invalid PositionGuard backtest ${label}: ${value}`);
  }

  const fractionNanoseconds = BigInt(fraction.padEnd(9, "0") || "0");
  return {
    epochMilliseconds: wholeSecondMs + Number(fraction.padEnd(3, "0").slice(0, 3) || "0"),
    epochNanoseconds: BigInt(wholeSecondMs) * NANOSECONDS_PER_MILLISECOND + fractionNanoseconds,
    exactTimestamp: explicitTimezone === undefined ? `${value}Z` : value,
  };
}

function compareEpochNanoseconds(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isValidTimezone(timezone: string): boolean {
  if (timezone === "Z") return true;
  const offsetHour = Number(timezone.slice(1, 3));
  const offsetMinute = Number(timezone.slice(4, 6));
  return offsetMinute <= 59 && (offsetHour < 14 || (offsetHour === 14 && offsetMinute === 0));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
