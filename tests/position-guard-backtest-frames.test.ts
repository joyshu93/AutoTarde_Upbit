import assert from "node:assert/strict";

import {
  buildPositionGuardBacktestFrames,
} from "../src/modules/strategy/position-guard-backtest-frames.js";
import type { StrategyMarketCandle } from "../src/modules/strategy/market-structure.js";
import { test } from "./harness.js";

test("position guard backtest frame builder excludes future candles at each decision cutoff", () => {
  const frames = buildPositionGuardBacktestFrames({
    asset: "BTC",
    market: "KRW-BTC",
    oneHourCandles: [
      createCandle("1h", "2026-04-20T00:00:00.000Z", 100),
      createCandle("1h", "2026-04-20T01:00:00.000Z", 101),
      createCandle("1h", "2026-04-20T02:00:00.000Z", 102),
      createCandle("1h", "2026-04-20T03:00:00.000Z", 999),
    ],
    fourHourCandles: [
      createCandle("4h", "2026-04-19T16:00:00.000Z", 96),
      createCandle("4h", "2026-04-19T20:00:00.000Z", 98),
    ],
    oneDayCandles: [
      createCandle("1d", "2026-04-18T00:00:00.000Z", 90),
      createCandle("1d", "2026-04-19T00:00:00.000Z", 95),
    ],
    startAt: "2026-04-20T03:00:00.000Z",
    endAt: "2026-04-20T03:00:00.000Z",
    minimumCompletedCandles: {
      "1h": 2,
      "4h": 1,
      "1d": 1,
    },
  });

  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.generatedAt, "2026-04-20T03:00:00.000Z");
  assert.equal(frames[0]?.analysis.currentPrice, 102);
  assert.equal(frames[0]?.source.latestCloseTime["1h"], "2026-04-20T03:00:00.000Z");
  assert.equal(frames[0]?.source.candleCounts["1h"], 3);
});

test("position guard backtest frame builder waits for required completed history in every timeframe", () => {
  const frames = buildPositionGuardBacktestFrames({
    asset: "ETH",
    market: "KRW-ETH",
    oneHourCandles: [
      createCandle("1h", "2026-04-20T00:00:00.000Z", 100),
      createCandle("1h", "2026-04-20T01:00:00.000Z", 101),
      createCandle("1h", "2026-04-20T02:00:00.000Z", 102),
      createCandle("1h", "2026-04-20T03:00:00.000Z", 103),
    ],
    fourHourCandles: [
      createCandle("4h", "2026-04-19T16:00:00.000Z", 96),
      createCandle("4h", "2026-04-19T20:00:00.000Z", 98),
    ],
    oneDayCandles: [
      createCandle("1d", "2026-04-19T00:00:00.000Z", 95),
    ],
    minimumCompletedCandles: {
      "1h": 3,
      "4h": 2,
      "1d": 1,
    },
  });

  assert.deepEqual(frames.map((frame) => frame.generatedAt), [
    "2026-04-20T03:00:00.000Z",
    "2026-04-20T04:00:00.000Z",
  ]);
});

function createCandle(
  timeframe: "1h" | "4h" | "1d",
  openTime: string,
  closePrice: number,
): StrategyMarketCandle {
  const openMs = Date.parse(openTime);
  const durationMs = timeframe === "1h"
    ? 60 * 60 * 1000
    : timeframe === "4h"
      ? 4 * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;

  return {
    market: "KRW-BTC",
    timeframe,
    openTime,
    closeTime: new Date(openMs + durationMs).toISOString(),
    openPrice: closePrice * 0.99,
    highPrice: closePrice * 1.02,
    lowPrice: closePrice * 0.98,
    closePrice,
    volume: 100,
    quoteVolume: closePrice * 100,
  };
}
