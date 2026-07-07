import { getMarketForAsset, type SupportedAsset, type SupportedMarket } from "../../domain/types.js";
import type {
  UpbitCandleSnapshot,
  UpbitGetDayCandlesRequest,
  UpbitGetMinuteCandlesRequest,
} from "../exchange/upbit/contracts.js";
import type { StrategyMarketCandle, SupportedStrategyTimeframe } from "./market-structure.js";
import {
  type PositionGuardBacktestExecutionModel,
  type PositionGuardBacktestResult,
  runPositionGuardBacktest,
} from "./position-guard-backtest.js";
import {
  buildPositionGuardBacktestFrames,
  type PositionGuardBacktestAnalysisFrame,
} from "./position-guard-backtest-frames.js";
import {
  buildPositionGuardBacktestReport,
  formatPositionGuardBacktestReport,
  type PositionGuardBacktestReport,
} from "./position-guard-backtest-report.js";
import type { PositionGuardStrategySettings } from "./position-guard-core.js";
import { normalizeUpbitCandles } from "./position-guard-snapshot.js";

export interface PositionGuardBacktestCandleReader {
  getMinuteCandles(request: UpbitGetMinuteCandlesRequest): Promise<readonly UpbitCandleSnapshot[]>;
  getDayCandles(request: UpbitGetDayCandlesRequest): Promise<readonly UpbitCandleSnapshot[]>;
}

export interface FetchPositionGuardBacktestCandlesInput {
  asset: SupportedAsset;
  historyStartAt: string;
  endAt: string;
  pageSize?: number;
  pageLimit?: number;
}

export interface PositionGuardBacktestCandleDataset {
  asset: SupportedAsset;
  market: SupportedMarket;
  historyStartAt: string;
  endAt: string;
  pageSize: number;
  pageLimit: number;
  candleCounts: Record<SupportedStrategyTimeframe, number>;
  candles: Record<SupportedStrategyTimeframe, StrategyMarketCandle[]>;
}

export interface RunPositionGuardPublicBacktestInput {
  asset: SupportedAsset;
  startAt: string;
  endAt: string;
  initialCashKrw: number;
  initialQuantity: number;
  initialAverageEntryPrice: number;
  historyStartAt?: string;
  warmupDays?: number;
  pageSize?: number;
  pageLimit?: number;
  label?: string;
  minimumCompletedCandles?: Partial<Record<SupportedStrategyTimeframe, number>>;
  settings?: PositionGuardStrategySettings;
  execution?: PositionGuardBacktestExecutionModel;
}

export interface PositionGuardPublicBacktestNonMutationBoundary {
  database: false;
  telegram: false;
  privateExchange: false;
  orderLifecycle: false;
  liveOrders: false;
}

export interface PositionGuardPublicBacktestRunResult {
  asset: SupportedAsset;
  market: SupportedMarket;
  startAt: string;
  endAt: string;
  historyStartAt: string;
  dataset: PositionGuardBacktestCandleDataset;
  frames: PositionGuardBacktestAnalysisFrame[];
  backtest: PositionGuardBacktestResult;
  report: PositionGuardBacktestReport;
  formattedReport: string;
  nonMutationBoundary: PositionGuardPublicBacktestNonMutationBoundary;
}

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_PAGE_LIMIT = 10;
const DEFAULT_WARMUP_DAYS = 45;
const TIMEFRAME_ORDER: SupportedStrategyTimeframe[] = ["1h", "4h", "1d"];
const NON_MUTATION_BOUNDARY: PositionGuardPublicBacktestNonMutationBoundary = {
  database: false,
  telegram: false,
  privateExchange: false,
  orderLifecycle: false,
  liveOrders: false,
};

export async function fetchPositionGuardBacktestCandles(
  reader: PositionGuardBacktestCandleReader,
  input: FetchPositionGuardBacktestCandlesInput,
): Promise<PositionGuardBacktestCandleDataset> {
  const market = getMarketForAsset(input.asset);
  const pageSize = normalizePageSize(input.pageSize);
  const pageLimit = normalizePageLimit(input.pageLimit);
  const historyStartMs = toUtcMs(input.historyStartAt, "historyStartAt");
  const endMs = toUtcMs(input.endAt, "endAt");
  if (historyStartMs > endMs) {
    throw new Error("PositionGuard backtest historyStartAt must be before or equal to endAt.");
  }

  const [oneHourCandles, fourHourCandles, oneDayCandles] = await Promise.all([
    fetchTimeframeCandles({
      reader,
      market,
      timeframe: "1h",
      historyStartAt: input.historyStartAt,
      endAt: input.endAt,
      historyStartMs,
      endMs,
      pageSize,
      pageLimit,
    }),
    fetchTimeframeCandles({
      reader,
      market,
      timeframe: "4h",
      historyStartAt: input.historyStartAt,
      endAt: input.endAt,
      historyStartMs,
      endMs,
      pageSize,
      pageLimit,
    }),
    fetchTimeframeCandles({
      reader,
      market,
      timeframe: "1d",
      historyStartAt: input.historyStartAt,
      endAt: input.endAt,
      historyStartMs,
      endMs,
      pageSize,
      pageLimit,
    }),
  ]);
  const candles = {
    "1h": oneHourCandles,
    "4h": fourHourCandles,
    "1d": oneDayCandles,
  };

  return {
    asset: input.asset,
    market,
    historyStartAt: new Date(historyStartMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    pageSize,
    pageLimit,
    candleCounts: getCandleCounts(candles),
    candles,
  };
}

export async function runPositionGuardPublicBacktest(
  reader: PositionGuardBacktestCandleReader,
  input: RunPositionGuardPublicBacktestInput,
): Promise<PositionGuardPublicBacktestRunResult> {
  const startMs = toUtcMs(input.startAt, "startAt");
  const endMs = toUtcMs(input.endAt, "endAt");
  if (startMs > endMs) {
    throw new Error("PositionGuard backtest startAt must be before or equal to endAt.");
  }
  const historyStartAt = input.historyStartAt ?? new Date(
    startMs - normalizeWarmupDays(input.warmupDays) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const dataset = await fetchPositionGuardBacktestCandles(reader, {
    asset: input.asset,
    historyStartAt,
    endAt: input.endAt,
    ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
    ...(input.pageLimit === undefined ? {} : { pageLimit: input.pageLimit }),
  });
  const frames = buildPositionGuardBacktestFrames({
    asset: input.asset,
    market: dataset.market,
    oneHourCandles: dataset.candles["1h"],
    fourHourCandles: dataset.candles["4h"],
    oneDayCandles: dataset.candles["1d"],
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    ...(input.minimumCompletedCandles === undefined ? {} : { minimumCompletedCandles: input.minimumCompletedCandles }),
  });
  const backtest = runPositionGuardBacktest({
    asset: input.asset,
    market: dataset.market,
    initialCashKrw: input.initialCashKrw,
    initialQuantity: input.initialQuantity,
    initialAverageEntryPrice: input.initialAverageEntryPrice,
    frames,
    ...(input.settings === undefined ? {} : { settings: input.settings }),
    ...(input.execution === undefined ? {} : { execution: input.execution }),
  });
  const report = buildPositionGuardBacktestReport(backtest, {
    label: input.label ?? `${dataset.market} ${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}`,
  });

  return {
    asset: input.asset,
    market: dataset.market,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    historyStartAt: dataset.historyStartAt,
    dataset,
    frames,
    backtest,
    report,
    formattedReport: formatPositionGuardBacktestReport(report),
    nonMutationBoundary: NON_MUTATION_BOUNDARY,
  };
}

async function fetchTimeframeCandles(input: {
  reader: PositionGuardBacktestCandleReader;
  market: SupportedMarket;
  timeframe: SupportedStrategyTimeframe;
  historyStartAt: string;
  endAt: string;
  historyStartMs: number;
  endMs: number;
  pageSize: number;
  pageLimit: number;
}): Promise<StrategyMarketCandle[]> {
  const candlesByOpenTime = new Map<string, StrategyMarketCandle>();
  let to = new Date(input.endMs).toISOString();

  for (let page = 0; page < input.pageLimit; page += 1) {
    const rawCandles = await fetchRawCandlePage(input.reader, {
      market: input.market,
      timeframe: input.timeframe,
      count: input.pageSize,
      to,
    });
    if (rawCandles.length === 0) {
      break;
    }

    const normalized = normalizeUpbitCandles(rawCandles, input.market, input.timeframe);
    for (const candle of normalized) {
      const closeMs = toUtcMs(candle.closeTime, `${input.timeframe} closeTime`);
      if (closeMs >= input.historyStartMs && closeMs <= input.endMs) {
        candlesByOpenTime.set(candle.openTime, candle);
      }
    }

    const oldest = getOldestCandle(normalized);
    if (oldest === null) {
      break;
    }
    const oldestCloseMs = toUtcMs(oldest.closeTime, `${input.timeframe} oldest closeTime`);
    if (oldestCloseMs <= input.historyStartMs) {
      break;
    }

    const nextTo = oldest.openTime;
    if (nextTo === to) {
      break;
    }
    to = nextTo;
  }

  return [...candlesByOpenTime.values()].sort(
    (left, right) => toUtcMs(left.closeTime, "closeTime") - toUtcMs(right.closeTime, "closeTime"),
  );
}

function fetchRawCandlePage(
  reader: PositionGuardBacktestCandleReader,
  input: {
    market: SupportedMarket;
    timeframe: SupportedStrategyTimeframe;
    count: number;
    to: string;
  },
): Promise<readonly UpbitCandleSnapshot[]> {
  if (input.timeframe === "1h") {
    return reader.getMinuteCandles({
      market: input.market,
      unit: 60,
      count: input.count,
      to: input.to,
    });
  }
  if (input.timeframe === "4h") {
    return reader.getMinuteCandles({
      market: input.market,
      unit: 240,
      count: input.count,
      to: input.to,
    });
  }

  return reader.getDayCandles({
    market: input.market,
    count: input.count,
    to: input.to,
  });
}

function getOldestCandle(candles: readonly StrategyMarketCandle[]): StrategyMarketCandle | null {
  if (candles.length === 0) {
    return null;
  }

  return candles.reduce((oldest, candle) =>
    toUtcMs(candle.openTime, "openTime") < toUtcMs(oldest.openTime, "openTime") ? candle : oldest,
  candles[0] as StrategyMarketCandle);
}

function getCandleCounts(
  candles: Record<SupportedStrategyTimeframe, readonly StrategyMarketCandle[]>,
): Record<SupportedStrategyTimeframe, number> {
  return {
    "1h": candles["1h"].length,
    "4h": candles["4h"].length,
    "1d": candles["1d"].length,
  };
}

function normalizePageSize(pageSize: number | undefined): number {
  const value = pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("PositionGuard backtest pageSize must be an integer between 1 and 200.");
  }
  return value;
}

function normalizePageLimit(pageLimit: number | undefined): number {
  const value = pageLimit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("PositionGuard backtest pageLimit must be a positive integer.");
  }
  return value;
}

function normalizeWarmupDays(warmupDays: number | undefined): number {
  const value = warmupDays ?? DEFAULT_WARMUP_DAYS;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("PositionGuard backtest warmupDays must be a non-negative number.");
  }
  return value;
}

function toUtcMs(value: string, label: string): number {
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid PositionGuard public backtest ${label}: ${value}`);
  }

  return timestamp;
}

export function getPositionGuardPublicBacktestTimeframes(): readonly SupportedStrategyTimeframe[] {
  return TIMEFRAME_ORDER;
}
