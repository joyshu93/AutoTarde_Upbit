import { getAssetForMarket, type SupportedMarket } from "../../domain/types.js";
import type {
  UpbitCandleSnapshot,
  UpbitGetDayCandlesRequest,
  UpbitGetMinuteCandlesRequest,
  UpbitSpotMarket,
  UpbitTickerSnapshot,
} from "../exchange/upbit/contracts.js";
import type {
  PositionGuardMarketSnapshot,
  StrategyMarketCandle,
  SupportedStrategyTimeframe,
} from "./market-structure.js";

export interface PositionGuardPublicMarketDataReader {
  getTickers(markets: readonly UpbitSpotMarket[]): Promise<readonly UpbitTickerSnapshot[]>;
  getMinuteCandles(request: UpbitGetMinuteCandlesRequest): Promise<readonly UpbitCandleSnapshot[]>;
  getDayCandles(request: UpbitGetDayCandlesRequest): Promise<readonly UpbitCandleSnapshot[]>;
}

export interface FetchPositionGuardMarketSnapshotInput {
  market: SupportedMarket;
  fetchedAt: string;
  candleCount: number;
  to?: string;
}

export interface BuildPositionGuardMarketSnapshotInput {
  market: SupportedMarket;
  fetchedAt: string;
  ticker: UpbitTickerSnapshot;
  oneHourCandles: readonly UpbitCandleSnapshot[];
  fourHourCandles: readonly UpbitCandleSnapshot[];
  oneDayCandles: readonly UpbitCandleSnapshot[];
}

export async function fetchPositionGuardMarketSnapshot(
  reader: PositionGuardPublicMarketDataReader,
  input: FetchPositionGuardMarketSnapshotInput,
): Promise<PositionGuardMarketSnapshot> {
  const [tickers, oneHourCandles, fourHourCandles, oneDayCandles] = await Promise.all([
    reader.getTickers([input.market]),
    reader.getMinuteCandles({
      market: input.market,
      unit: 60,
      count: input.candleCount,
      ...(input.to === undefined ? {} : { to: input.to }),
    }),
    reader.getMinuteCandles({
      market: input.market,
      unit: 240,
      count: input.candleCount,
      ...(input.to === undefined ? {} : { to: input.to }),
    }),
    reader.getDayCandles({
      market: input.market,
      count: input.candleCount,
      ...(input.to === undefined ? {} : { to: input.to }),
    }),
  ]);
  const ticker = tickers.find((candidate) => candidate.market === input.market);
  if (!ticker) {
    throw new Error(`Upbit ticker response did not include ${input.market}.`);
  }

  return buildPositionGuardMarketSnapshot({
    market: input.market,
    fetchedAt: input.fetchedAt,
    ticker,
    oneHourCandles,
    fourHourCandles,
    oneDayCandles,
  });
}

export function buildPositionGuardMarketSnapshot(
  input: BuildPositionGuardMarketSnapshotInput,
): PositionGuardMarketSnapshot {
  return {
    asset: getAssetForMarket(input.market),
    market: input.market,
    fetchedAt: input.fetchedAt,
    ticker: {
      tradePrice: input.ticker.trade_price,
      exchangeTimestampMs: input.ticker.trade_timestamp,
      tradeTimeUtc: new Date(input.ticker.trade_timestamp).toISOString(),
      fetchedAt: input.fetchedAt,
    },
    timeframes: {
      "1h": {
        timeframe: "1h",
        candles: normalizeUpbitCandles(input.oneHourCandles, input.market, "1h"),
      },
      "4h": {
        timeframe: "4h",
        candles: normalizeUpbitCandles(input.fourHourCandles, input.market, "4h"),
      },
      "1d": {
        timeframe: "1d",
        candles: normalizeUpbitCandles(input.oneDayCandles, input.market, "1d"),
      },
    },
  };
}

function normalizeUpbitCandles(
  candles: readonly UpbitCandleSnapshot[],
  market: SupportedMarket,
  timeframe: SupportedStrategyTimeframe,
): StrategyMarketCandle[] {
  return [...candles]
    .sort((left, right) => toUtcMs(left.candle_date_time_utc) - toUtcMs(right.candle_date_time_utc))
    .map((candle) => {
      const openMs = toUtcMs(candle.candle_date_time_utc);
      const closeMs = openMs + timeframeDurationMs(timeframe);
      return {
        market,
        timeframe,
        openTime: new Date(openMs).toISOString(),
        closeTime: new Date(closeMs).toISOString(),
        openPrice: candle.opening_price,
        highPrice: candle.high_price,
        lowPrice: candle.low_price,
        closePrice: candle.trade_price,
        volume: candle.candle_acc_trade_volume,
        quoteVolume: candle.candle_acc_trade_price,
      };
    });
}

function timeframeDurationMs(timeframe: SupportedStrategyTimeframe): number {
  if (timeframe === "1h") return 60 * 60 * 1000;
  if (timeframe === "4h") return 4 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function toUtcMs(value: string): number {
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid Upbit candle timestamp: ${value}`);
  }

  return timestamp;
}
