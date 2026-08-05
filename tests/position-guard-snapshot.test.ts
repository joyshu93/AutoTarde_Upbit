import assert from "node:assert/strict";

import {
  buildPositionGuardMarketSnapshot,
  fetchPositionGuardMarketSnapshot,
} from "../src/modules/strategy/position-guard-snapshot.js";
import {
  analyzePositionGuardMarketStructure,
  type SupportedStrategyTimeframe,
} from "../src/modules/strategy/market-structure.js";
import type {
  UpbitCandleSnapshot,
  UpbitGetDayCandlesRequest,
  UpbitGetMinuteCandlesRequest,
  UpbitSpotMarket,
  UpbitTickerSnapshot,
} from "../src/modules/exchange/upbit/contracts.js";
import { test } from "./harness.js";

test("position guard snapshot builder sorts Upbit candles and normalizes timeframes", () => {
  const snapshot = buildPositionGuardMarketSnapshot({
    market: "KRW-BTC",
    fetchedAt: "2026-04-20T01:05:00.000Z",
    ticker: {
      market: "KRW-BTC",
      trade_price: 105,
      trade_timestamp: Date.parse("2026-04-20T01:05:00.000Z"),
    },
    oneHourCandles: [
      createUpbitCandle("2026-04-20T01:00:00", 105),
      createUpbitCandle("2026-04-20T00:00:00", 100),
    ],
    fourHourCandles: [
      createUpbitCandle("2026-04-19T20:00:00", 98),
    ],
    oneDayCandles: [
      createUpbitCandle("2026-04-19T00:00:00", 95),
    ],
  });

  assert.equal(snapshot.asset, "BTC");
  assert.equal(snapshot.market, "KRW-BTC");
  assert.equal(snapshot.ticker.tradePrice, 105);
  assert.equal(snapshot.timeframes["1h"].candles[0]?.openTime, "2026-04-20T00:00:00.000Z");
  assert.equal(snapshot.timeframes["1h"].candles[0]?.closeTime, "2026-04-20T01:00:00.000Z");
  assert.equal(snapshot.timeframes["4h"].candles[0]?.closeTime, "2026-04-20T00:00:00.000Z");
  assert.equal(snapshot.timeframes["1d"].candles[0]?.closeTime, "2026-04-20T00:00:00.000Z");
});

test("position guard snapshot fetcher requests ticker plus 1h, 4h, and 1d candles", async () => {
  const calls: string[] = [];
  const reader = {
    async getTickers(markets: readonly UpbitSpotMarket[]): Promise<readonly UpbitTickerSnapshot[]> {
      calls.push(`tickers:${markets.join(",")}`);
      return [
        {
          market: "KRW-ETH",
          trade_price: 3500000,
          trade_timestamp: Date.parse("2026-04-20T01:05:00.000Z"),
        },
      ];
    },
    async getMinuteCandles(request: UpbitGetMinuteCandlesRequest): Promise<readonly UpbitCandleSnapshot[]> {
      calls.push(`minutes:${request.unit}:${request.market}:${request.count}:${request.to ?? ""}`);
      return [createUpbitCandle("2026-04-20T00:00:00", 3500000, request.unit)];
    },
    async getDayCandles(request: UpbitGetDayCandlesRequest): Promise<readonly UpbitCandleSnapshot[]> {
      calls.push(`days:${request.market}:${request.count}:${request.to ?? ""}`);
      return [createUpbitCandle("2026-04-19T00:00:00", 3400000)];
    },
  };

  const snapshot = await fetchPositionGuardMarketSnapshot(reader, {
    market: "KRW-ETH",
    fetchedAt: "2026-04-20T01:05:00.000Z",
    candleCount: 120,
    to: "2026-04-20T01:00:00Z",
  });

  assert.deepEqual(calls, [
    "tickers:KRW-ETH",
    "minutes:60:KRW-ETH:120:2026-04-20T01:00:00Z",
    "minutes:240:KRW-ETH:120:2026-04-20T01:00:00Z",
    "days:KRW-ETH:120:2026-04-20T01:00:00Z",
  ]);
  assert.equal(snapshot.asset, "ETH");
  assert.equal(snapshot.timeframes["1h"].candles.length, 1);
});

test("position guard snapshot fetcher provides 200 completed candles per timeframe for EMA200", async () => {
  const decisionAt = "2026-04-20T05:30:00.000Z";
  const requestedTo: Partial<Record<SupportedStrategyTimeframe, string>> = {};
  const reader = {
    async getTickers(markets: readonly UpbitSpotMarket[]): Promise<readonly UpbitTickerSnapshot[]> {
      return markets.map((market) => ({
        market,
        trade_price: 120_000_000,
        trade_timestamp: Date.parse(decisionAt),
      }));
    },
    async getMinuteCandles(request: UpbitGetMinuteCandlesRequest): Promise<readonly UpbitCandleSnapshot[]> {
      const timeframe = request.unit === 60 ? "1h" : "4h";
      if (request.to !== undefined) requestedTo[timeframe] = request.to;
      return createCandleWindow({
        count: request.count,
        decisionAt,
        durationMs: request.unit * 60 * 1000,
        ...(request.to === undefined ? {} : { to: request.to }),
        unit: request.unit,
      });
    },
    async getDayCandles(request: UpbitGetDayCandlesRequest): Promise<readonly UpbitCandleSnapshot[]> {
      if (request.to !== undefined) requestedTo["1d"] = request.to;
      return createCandleWindow({
        count: request.count,
        decisionAt,
        durationMs: 24 * 60 * 60 * 1000,
        ...(request.to === undefined ? {} : { to: request.to }),
      });
    },
  };

  const snapshot = await fetchPositionGuardMarketSnapshot(reader, {
    market: "KRW-BTC",
    fetchedAt: decisionAt,
    candleCount: 200,
  });
  const analysis = analyzePositionGuardMarketStructure(snapshot);
  const decisionAtMs = Date.parse(decisionAt);

  for (const timeframe of ["1h", "4h", "1d"] as const) {
    const candles = snapshot.timeframes[timeframe].candles;
    const completedCandleCount = candles.filter((candle) => Date.parse(candle.closeTime) <= decisionAtMs).length;
    assert.equal(candles.length, 200, `${timeframe} should retain the requested production candle count`);
    assert.equal(completedCandleCount, 200, `${timeframe} should contain 200 completed candles`);
    assert.notEqual(analysis.timeframes[timeframe].indicators.ema200, null, `${timeframe} EMA200 should be computable`);
  }

  assert.deepEqual(requestedTo, {
    "1h": "2026-04-20T05:00:00.000Z",
    "4h": "2026-04-20T04:00:00.000Z",
    "1d": "2026-04-20T00:00:00.000Z",
  });
});

function createCandleWindow(input: {
  count: number;
  decisionAt: string;
  durationMs: number;
  to?: string;
  unit?: 60 | 240;
}): UpbitCandleSnapshot[] {
  const decisionAtMs = Date.parse(input.decisionAt);
  const activeCandleOpenMs = Math.floor(decisionAtMs / input.durationMs) * input.durationMs;
  const endExclusiveMs = input.to === undefined
    ? activeCandleOpenMs + input.durationMs
    : Date.parse(input.to);

  return Array.from({ length: input.count }, (_, index) => {
    const openMs = endExclusiveMs - ((index + 1) * input.durationMs);
    const utcStart = new Date(openMs).toISOString().replace(".000Z", "");
    return createUpbitCandle(utcStart, 120_000_000 - index * 10_000, input.unit);
  });
}

function createUpbitCandle(
  utcStart: string,
  close: number,
  unit?: 60 | 240,
): UpbitCandleSnapshot {
  return {
    market: "KRW-BTC",
    candle_date_time_utc: utcStart,
    candle_date_time_kst: utcStart,
    opening_price: close * 0.99,
    high_price: close * 1.02,
    low_price: close * 0.98,
    trade_price: close,
    timestamp: Date.parse(`${utcStart}Z`),
    candle_acc_trade_price: close * 100,
    candle_acc_trade_volume: 100,
    ...(unit === undefined ? {} : { unit }),
  };
}
