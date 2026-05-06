import assert from "node:assert/strict";

import {
  buildPositionGuardMarketSnapshot,
  fetchPositionGuardMarketSnapshot,
} from "../src/modules/strategy/position-guard-snapshot.js";
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
