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

export function buildPositionGuardBacktestFrames(
  input: BuildPositionGuardBacktestFramesInput,
): PositionGuardBacktestAnalysisFrame[] {
  const minimumCompletedCandles = {
    ...DEFAULT_MINIMUM_COMPLETED_CANDLES,
    ...input.minimumCompletedCandles,
  };
  const sortedCandles = {
    "1h": sortCandles(input.oneHourCandles),
    "4h": sortCandles(input.fourHourCandles),
    "1d": sortCandles(input.oneDayCandles),
  };
  const start = input.startAt === undefined ? null : parseTimestamp(input.startAt, "startAt");
  const end = input.endAt === undefined ? null : parseTimestamp(input.endAt, "endAt");
  const frames: PositionGuardBacktestAnalysisFrame[] = [];

  for (const decisionCandle of sortedCandles["1h"]) {
    const decision = parseTimestamp(decisionCandle.closeTime, "1h closeTime");
    if (start !== null && decision.epochNanoseconds < start.epochNanoseconds) continue;
    if (end !== null && decision.epochNanoseconds > end.epochNanoseconds) continue;

    const completed = {
      "1h": getCompletedCandles(sortedCandles["1h"], decision.epochNanoseconds),
      "4h": getCompletedCandles(sortedCandles["4h"], decision.epochNanoseconds),
      "1d": getCompletedCandles(sortedCandles["1d"], decision.epochNanoseconds),
    };
    if (!hasMinimumCompletedCandles(completed, minimumCompletedCandles)) {
      continue;
    }

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

function sortCandles(candles: readonly StrategyMarketCandle[]): StrategyMarketCandle[] {
  return [...candles].sort((left, right) => compareEpochNanoseconds(
    parseTimestamp(left.closeTime, "closeTime").epochNanoseconds,
    parseTimestamp(right.closeTime, "closeTime").epochNanoseconds,
  ));
}

function getCompletedCandles(
  candles: readonly StrategyMarketCandle[],
  cutoffEpochNanoseconds: bigint,
): StrategyMarketCandle[] {
  return candles.filter(
    (candle) => parseTimestamp(candle.closeTime, "closeTime").epochNanoseconds <= cutoffEpochNanoseconds,
  );
}

function hasMinimumCompletedCandles(
  completed: Record<SupportedStrategyTimeframe, StrategyMarketCandle[]>,
  minimumCompletedCandles: Record<SupportedStrategyTimeframe, number>,
): boolean {
  return completed["1h"].length >= minimumCompletedCandles["1h"] &&
    completed["4h"].length >= minimumCompletedCandles["4h"] &&
    completed["1d"].length >= minimumCompletedCandles["1d"];
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
