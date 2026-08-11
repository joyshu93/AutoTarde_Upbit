import type { SupportedAsset, SupportedMarket } from "../../domain/types.js";
import {
  fetchPositionGuardBacktestCandles,
  type PositionGuardBacktestCandleReader,
} from "../strategy/position-guard-public-backtest.js";
import {
  buildResearchCandleDataset,
  type BuiltResearchCandleDataset,
} from "./research-candle-dataset-builder.js";
import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
} from "./performance-timestamp.js";
import type { ResearchCandleTimeframe } from "./research-candle-dataset.js";

export type AcquireUpbitResearchCandleDatasetInput = {
  asset: SupportedAsset;
  historyStartAt: string;
  endAt: string;
  collectedAt: string;
  pageSize: number;
  pageLimit: number;
};

export type ResearchCandleAcquisitionBoundary = {
  sqlite: false;
  privateExchange: false;
  telegram: false;
  scheduler: false;
  strategyExecution: false;
  orders: false;
};

export type AcquiredResearchCandleDataset = BuiltResearchCandleDataset & {
  asset: SupportedAsset;
  market: SupportedMarket;
  source: "upbit-public-historical-candles";
  boundary: ResearchCandleAcquisitionBoundary;
};

const SOURCE = "upbit-public-historical-candles" as const;
const TIMEFRAME_DURATION_NANOSECONDS: Record<ResearchCandleTimeframe, bigint> = {
  "1h": 60n * 60n * 1_000_000_000n,
  "4h": 4n * 60n * 60n * 1_000_000_000n,
  "1d": 24n * 60n * 60n * 1_000_000_000n,
};
const BOUNDARY: ResearchCandleAcquisitionBoundary = Object.freeze({
  sqlite: false,
  privateExchange: false,
  telegram: false,
  scheduler: false,
  strategyExecution: false,
  orders: false,
});

export async function acquireUpbitResearchCandleDataset(
  reader: PositionGuardBacktestCandleReader,
  input: AcquireUpbitResearchCandleDatasetInput,
): Promise<AcquiredResearchCandleDataset> {
  const fetched = await fetchPositionGuardBacktestCandles(reader, {
    asset: input.asset,
    historyStartAt: input.historyStartAt,
    endAt: input.endAt,
    pageSize: input.pageSize,
    pageLimit: input.pageLimit,
  });
  assertRequestedHistoryCoverage(fetched.candles, input.historyStartAt);
  const built = buildResearchCandleDataset({
    asset: input.asset,
    historyStartAt: input.historyStartAt,
    endAt: input.endAt,
    collectedAt: input.collectedAt,
    source: SOURCE,
    candles: fetched.candles,
  });

  return {
    ...built,
    asset: input.asset,
    market: fetched.market,
    source: SOURCE,
    boundary: BOUNDARY,
  };
}

function assertRequestedHistoryCoverage(
  candles: BuiltResearchCandleDataset["dataset"]["candles"],
  historyStartAt: string,
): void {
  const historyStart = parsePerformanceTimestamp(historyStartAt);
  if (!historyStart) {
    throw new Error(
      "Research candle acquisition historyStartAt must be an explicit-timezone ISO timestamp.",
    );
  }

  for (const timeframe of ["1h", "4h", "1d"] as const) {
    const earliestOpen = candles[timeframe].reduce<bigint | null>((earliest, candle) => {
      const openTime = parsePerformanceTimestamp(candle.openTime);
      if (!openTime) {
        throw new Error(
          `Research candle acquisition ${timeframe} openTime must be an explicit-timezone ISO timestamp.`,
        );
      }
      return earliest === null || compareEpochNanoseconds(openTime.epochNanoseconds, earliest) < 0
        ? openTime.epochNanoseconds
        : earliest;
    }, null);
    const coverageDeadline = historyStart.epochNanoseconds
      + TIMEFRAME_DURATION_NANOSECONDS[timeframe];

    if (earliestOpen === null || compareEpochNanoseconds(earliestOpen, coverageDeadline) >= 0) {
      throw new Error(
        `Research candle acquisition ${timeframe} candle coverage did not reach historyStartAt ${historyStartAt}: source exhausted before the first expected interval.`,
      );
    }
  }
}
