import { getMarketForAsset, type SupportedAsset } from "../../domain/types.js";
import type { StrategyMarketCandle } from "../strategy/market-structure.js";
import {
  calculateResearchCandleDatasetChecksum,
  parseResearchCandleDataset,
  type ResearchCandleDataset,
  type ResearchCandleTimeframe,
} from "./research-candle-dataset.js";
import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
  type PerformanceTimestamp,
} from "./performance-timestamp.js";

export type BuildResearchCandleDatasetInput = {
  asset: SupportedAsset;
  historyStartAt: string;
  endAt: string;
  collectedAt: string;
  source: string;
  candles: Record<ResearchCandleTimeframe, readonly StrategyMarketCandle[]>;
};

export type BuiltResearchCandleDataset = {
  dataset: ResearchCandleDataset;
  json: string;
  candleCounts: Record<ResearchCandleTimeframe, number>;
};

export function buildResearchCandleDataset(
  input: BuildResearchCandleDatasetInput,
): BuiltResearchCandleDataset {
  const historyStart = requireTimestamp(input.historyStartAt, "historyStartAt");
  const end = requireTimestamp(input.endAt, "endAt");
  const collected = requireTimestamp(input.collectedAt, "collectedAt");
  if (compareEpochNanoseconds(historyStart.epochNanoseconds, end.epochNanoseconds) >= 0) {
    throw new Error("Research candle dataset builder historyStartAt must be before endAt.");
  }
  if (compareEpochNanoseconds(end.epochNanoseconds, collected.epochNanoseconds) > 0) {
    throw new Error("Research candle dataset builder endAt must be at or before collectedAt.");
  }

  const candles = {
    "1h": filterAndSortCandles(input.candles["1h"], "1h", historyStart, end),
    "4h": filterAndSortCandles(input.candles["4h"], "4h", historyStart, end),
    "1d": filterAndSortCandles(input.candles["1d"], "1d", historyStart, end),
  };
  const unsigned = {
    provenance: {
      schemaVersion: 1 as const,
      asset: input.asset,
      market: getMarketForAsset(input.asset),
      historyStartAt: input.historyStartAt,
      endAt: input.endAt,
      collectedAt: input.collectedAt,
      source: input.source,
    },
    candles,
  };
  const signed: ResearchCandleDataset = {
    provenance: {
      ...unsigned.provenance,
      sha256: calculateResearchCandleDatasetChecksum(unsigned),
    },
    candles: unsigned.candles,
  };
  const json = `${JSON.stringify(signed, null, 2)}\n`;
  const dataset = parseResearchCandleDataset(json);

  return {
    dataset,
    json,
    candleCounts: {
      "1h": dataset.candles["1h"].length,
      "4h": dataset.candles["4h"].length,
      "1d": dataset.candles["1d"].length,
    },
  };
}

function filterAndSortCandles(
  candles: readonly StrategyMarketCandle[],
  timeframe: ResearchCandleTimeframe,
  historyStart: PerformanceTimestamp,
  end: PerformanceTimestamp,
): StrategyMarketCandle[] {
  const parsed = candles.map((candle, index) => ({
    candle: { ...candle },
    openTime: requireTimestamp(candle.openTime, `${timeframe}[${index}].openTime`),
    closeTime: requireTimestamp(candle.closeTime, `${timeframe}[${index}].closeTime`),
  }));
  const filtered = parsed
    .filter(({ openTime, closeTime }) =>
      compareEpochNanoseconds(openTime.epochNanoseconds, historyStart.epochNanoseconds) >= 0
      && compareEpochNanoseconds(closeTime.epochNanoseconds, end.epochNanoseconds) <= 0)
    .sort((left, right) =>
      compareEpochNanoseconds(left.openTime.epochNanoseconds, right.openTime.epochNanoseconds))
    .map(({ candle }) => candle);

  if (filtered.length === 0) {
    throw new Error(
      `Research candle dataset builder ${timeframe} must contain at least one completed candle in range.`,
    );
  }
  return filtered;
}

function requireTimestamp(value: string, label: string): PerformanceTimestamp {
  const timestamp = parsePerformanceTimestamp(value);
  if (!timestamp) {
    throw new Error(
      `Research candle dataset builder ${label} must be an explicit-timezone ISO timestamp.`,
    );
  }
  return timestamp;
}
