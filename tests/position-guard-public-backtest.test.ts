import assert from "node:assert/strict";

import type { UpbitCandleSnapshot } from "../src/modules/exchange/upbit/contracts.js";
import {
  fetchPositionGuardBacktestCandles,
  runPositionGuardPublicBacktest,
  type PositionGuardBacktestCandleReader,
} from "../src/modules/strategy/position-guard-public-backtest.js";
import { test } from "./harness.js";

test("position guard public backtest fetches public candles and formats a replay report", async () => {
  const requests: string[] = [];
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async (request) => {
      requests.push(`minute:${request.unit}:${request.count}:${request.to ?? "none"}`);
      return request.unit === 60
        ? [
          createCandle("KRW-BTC", "2026-04-20T03:00:00", 103),
          createCandle("KRW-BTC", "2026-04-20T02:00:00", 102),
          createCandle("KRW-BTC", "2026-04-20T01:00:00", 101),
          createCandle("KRW-BTC", "2026-04-20T00:00:00", 100),
        ]
        : [
          createCandle("KRW-BTC", "2026-04-20T00:00:00", 103),
          createCandle("KRW-BTC", "2026-04-19T20:00:00", 99),
        ];
    },
    getDayCandles: async (request) => {
      requests.push(`day:${request.count}:${request.to ?? "none"}`);
      return [
        createCandle("KRW-BTC", "2026-04-19T00:00:00", 100),
        createCandle("KRW-BTC", "2026-04-18T00:00:00", 98),
      ];
    },
  };

  const result = await runPositionGuardPublicBacktest(reader, {
    asset: "BTC",
    startAt: "2026-04-20T03:00:00.000Z",
    endAt: "2026-04-20T04:00:00.000Z",
    initialCashKrw: 100_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    pageSize: 200,
    pageLimit: 1,
    warmupDays: 2,
    minimumCompletedCandles: {
      "1h": 2,
      "4h": 1,
      "1d": 1,
    },
    label: "btc-public-smoke",
  });

  assert.deepEqual(requests, [
    "minute:60:200:2026-04-20T04:00:00.000Z",
    "minute:240:200:2026-04-20T04:00:00.000Z",
    "day:200:2026-04-20T04:00:00.000Z",
  ]);
  assert.equal(result.market, "KRW-BTC");
  assert.equal(result.dataset.candleCounts["1h"], 4);
  assert.equal(result.dataset.candleCounts["4h"], 2);
  assert.equal(result.dataset.candleCounts["1d"], 2);
  assert.equal(result.frames.length, 2);
  assert.equal(result.report.label, "btc-public-smoke");
  assert.equal(result.report.frameCount, 2);
  assert.equal(result.nonMutationBoundary.database, false);
  assert.equal(result.nonMutationBoundary.telegram, false);
  assert.equal(result.nonMutationBoundary.privateExchange, false);
  assert.equal(result.nonMutationBoundary.orderLifecycle, false);
  assert.equal(result.nonMutationBoundary.liveOrders, false);
  assert.match(result.formattedReport, /PositionGuard Backtest Report/);
  assert.match(result.formattedReport, /label: btc-public-smoke/);
});

test("position guard public backtest candle fetch paginates backward and de-duplicates overlaps", async () => {
  const calls: string[] = [];
  const oneHourPages = [
    [
      createCandle("KRW-ETH", "2026-04-20T03:00:00", 103),
      createCandle("KRW-ETH", "2026-04-20T02:00:00", 102),
    ],
    [
      createCandle("KRW-ETH", "2026-04-20T02:00:00", 102),
      createCandle("KRW-ETH", "2026-04-20T01:00:00", 101),
    ],
  ];
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async (request) => {
      calls.push(`minute:${request.unit}:${request.to ?? "none"}`);
      if (request.unit === 60) {
        return oneHourPages.shift() ?? [];
      }
      return [
        createCandle("KRW-ETH", "2026-04-20T00:00:00", 102),
        createCandle("KRW-ETH", "2026-04-19T20:00:00", 100),
      ];
    },
    getDayCandles: async (request) => {
      calls.push(`day:${request.to ?? "none"}`);
      return [
        createCandle("KRW-ETH", "2026-04-19T00:00:00", 101),
        createCandle("KRW-ETH", "2026-04-18T00:00:00", 100),
      ];
    },
  };

  const dataset = await fetchPositionGuardBacktestCandles(reader, {
    asset: "ETH",
    historyStartAt: "2026-04-20T02:00:00.000Z",
    endAt: "2026-04-20T04:00:00.000Z",
    pageSize: 2,
    pageLimit: 2,
  });

  assert.deepEqual(calls.filter((call) => call.startsWith("minute:60")), [
    "minute:60:2026-04-20T04:00:00.000Z",
    "minute:60:2026-04-20T02:00:00.000Z",
  ]);
  assert.deepEqual(dataset.candles["1h"].map((candle) => candle.openTime), [
    "2026-04-20T01:00:00.000Z",
    "2026-04-20T02:00:00.000Z",
    "2026-04-20T03:00:00.000Z",
  ]);
  assert.equal(dataset.candleCounts["1h"], 3);
});

test("position guard public backtest rejects incomplete history when page limit is exhausted", async () => {
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async () => [
      createCandle("KRW-BTC", "2026-04-20T03:00:00", 103),
      createCandle("KRW-BTC", "2026-04-20T02:00:00", 102),
    ],
    getDayCandles: async () => [],
  };

  await assert.rejects(
    fetchPositionGuardBacktestCandles(reader, {
      asset: "BTC",
      historyStartAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-04-20T04:00:00.000Z",
      pageSize: 2,
      pageLimit: 1,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /1h/);
      assert.match(error.message, /historyStartAt|coverage/i);
      return true;
    },
  );
});

test("position guard public backtest fetches timeframe groups sequentially", async () => {
  const calls: string[] = [];
  let inFlight = 0;
  const enterPublicCandleRequest = async (label: string): Promise<void> => {
    if (inFlight !== 0) {
      throw new Error(`parallel public candle fetch detected at ${label}`);
    }
    inFlight += 1;
    try {
      await Promise.resolve();
    } finally {
      inFlight -= 1;
    }
  };
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async (request) => {
      const label = `minute:${request.unit}`;
      calls.push(label);
      await enterPublicCandleRequest(label);
      return request.unit === 60
        ? [createCandle("KRW-BTC", "2026-04-19T23:00:00", 103)]
        : [createCandle("KRW-BTC", "2026-04-19T20:00:00", 102)];
    },
    getDayCandles: async () => {
      const label = "day";
      calls.push(label);
      await enterPublicCandleRequest(label);
      return [createCandle("KRW-BTC", "2026-04-19T00:00:00", 101)];
    },
  };

  const dataset = await fetchPositionGuardBacktestCandles(reader, {
    asset: "BTC",
    historyStartAt: "2026-04-20T00:00:00.000Z",
    endAt: "2026-04-20T04:00:00.000Z",
    pageSize: 1,
    pageLimit: 1,
  });

  assert.deepEqual(calls, ["minute:60", "minute:240", "day"]);
  assert.deepEqual(dataset.candleCounts, {
    "1h": 1,
    "4h": 1,
    "1d": 1,
  });
});

test("position guard public backtest defaults include enough daily history for EMA200", async () => {
  const dayRequests: Array<{ count: number; to: string | undefined }> = [];
  const reader: PositionGuardBacktestCandleReader = {
    getMinuteCandles: async () => [],
    getDayCandles: async (request) => {
      dayRequests.push({ count: request.count, to: request.to });
      return [];
    },
  };
  const startAt = "2026-08-01T00:00:00.000Z";

  const result = await runPositionGuardPublicBacktest(reader, {
    asset: "ETH",
    startAt,
    endAt: "2026-08-02T00:00:00.000Z",
    initialCashKrw: 100_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
  });

  const warmupDays = (Date.parse(startAt) - Date.parse(result.historyStartAt)) /
    (24 * 60 * 60 * 1000);
  assert.ok(warmupDays >= 200, `expected at least 200 warmup days, received ${warmupDays}`);
  assert.deepEqual(dayRequests, [{ count: 200, to: "2026-08-02T00:00:00.000Z" }]);
});

function createCandle(
  market: "KRW-BTC" | "KRW-ETH",
  openTimeUtc: string,
  closePrice: number,
): UpbitCandleSnapshot {
  return {
    market,
    candle_date_time_utc: openTimeUtc,
    candle_date_time_kst: openTimeUtc,
    opening_price: closePrice * 0.99,
    high_price: closePrice * 1.02,
    low_price: closePrice * 0.98,
    trade_price: closePrice,
    timestamp: Date.parse(`${openTimeUtc}Z`),
    candle_acc_trade_price: closePrice * 100,
    candle_acc_trade_volume: 100,
  };
}
