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
  const startMs = input.startAt === undefined ? null : toUtcMs(input.startAt, "startAt");
  const endMs = input.endAt === undefined ? null : toUtcMs(input.endAt, "endAt");
  const frames: PositionGuardBacktestAnalysisFrame[] = [];

  for (const decisionCandle of sortedCandles["1h"]) {
    const decisionMs = toUtcMs(decisionCandle.closeTime, "1h closeTime");
    if (startMs !== null && decisionMs < startMs) continue;
    if (endMs !== null && decisionMs > endMs) continue;

    const completed = {
      "1h": getCompletedCandles(sortedCandles["1h"], decisionMs),
      "4h": getCompletedCandles(sortedCandles["4h"], decisionMs),
      "1d": getCompletedCandles(sortedCandles["1d"], decisionMs),
    };
    if (!hasMinimumCompletedCandles(completed, minimumCompletedCandles)) {
      continue;
    }

    const generatedAt = new Date(decisionMs).toISOString();
    const snapshot: PositionGuardMarketSnapshot = {
      asset: input.asset,
      market: input.market,
      fetchedAt: generatedAt,
      ticker: {
        tradePrice: decisionCandle.closePrice,
        tradeTimeUtc: generatedAt,
        exchangeTimestampMs: decisionMs,
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
  return [...candles].sort((left, right) => toUtcMs(left.closeTime, "closeTime") - toUtcMs(right.closeTime, "closeTime"));
}

function getCompletedCandles(
  candles: readonly StrategyMarketCandle[],
  cutoffMs: number,
): StrategyMarketCandle[] {
  return candles.filter((candle) => toUtcMs(candle.closeTime, "closeTime") <= cutoffMs);
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

function toUtcMs(value: string, label: string): number {
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid PositionGuard backtest ${label}: ${value}`);
  }

  return timestamp;
}
