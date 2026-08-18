import assert from "node:assert/strict";

import { runCounterfactualScenarios } from "../src/modules/performance/strategy-counterfactual.js";
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

test("position guard backtest frame builder never synthesizes frames across a sparse 1h gap", () => {
  const frames = buildPositionGuardBacktestFrames({
    asset: "BTC",
    market: "KRW-BTC",
    oneHourCandles: [
      createCandle("1h", "2026-04-20T00:00:00.000Z", 100),
      createCandle("1h", "2026-04-20T02:00:00.000Z", 102),
    ],
    fourHourCandles: [createCandle("4h", "2026-04-19T20:00:00.000Z", 98)],
    oneDayCandles: [createCandle("1d", "2026-04-19T00:00:00.000Z", 95)],
    minimumCompletedCandles: { "1h": 1, "4h": 1, "1d": 1 },
  });

  assert.deepEqual(frames.map((frame) => frame.generatedAt), [
    "2026-04-20T01:00:00.000Z",
    "2026-04-20T03:00:00.000Z",
  ]);
  assert.deepEqual(frames.map((frame) => frame.source.candleCounts["1h"]), [1, 2]);
  assert.equal(frames[1]?.source.latestCloseTime["4h"], "2026-04-20T00:00:00.000Z");
  assert.equal(frames[1]?.source.latestCloseTime["1d"], "2026-04-20T00:00:00.000Z");
});

test("position guard backtest frame builder excludes a mixed-timezone candle one nanosecond after the decision", () => {
  const decisionCandle = createCandle("1h", "2026-04-20T02:00:00.000Z", 101);
  decisionCandle.closeTime = "2026-04-20T12:00:00.000000100+09:00";
  const futureFourHourCandle = createCandle("4h", "2026-04-19T23:00:00.000Z", 999);
  futureFourHourCandle.closeTime = "2026-04-20T03:00:00.000000101Z";

  const frames = buildPositionGuardBacktestFrames({
    asset: "BTC",
    market: "KRW-BTC",
    oneHourCandles: [
      createCandle("1h", "2026-04-20T01:00:00.000Z", 100),
      decisionCandle,
    ],
    fourHourCandles: [
      createCandle("4h", "2026-04-19T20:00:00.000Z", 98),
      futureFourHourCandle,
    ],
    oneDayCandles: [
      createCandle("1d", "2026-04-19T00:00:00.000Z", 95),
    ],
    startAt: "2026-04-20T03:00:00.000000100Z",
    endAt: "2026-04-20T03:00:00.000000100Z",
    minimumCompletedCandles: {
      "1h": 1,
      "4h": 1,
      "1d": 1,
    },
  });

  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.source.candleCounts["4h"], 1);
  assert.equal(frames[0]?.source.latestCloseTime["4h"], "2026-04-20T00:00:00.000Z");
});

test("position guard backtest frame builder preserves exact decision boundaries for MAE and MFE provenance", () => {
  for (const decisionCloseTime of [
    "2026-04-20T03:00:00.000000100Z",
    "2026-04-20T12:00:00.000000100+09:00",
  ]) {
    const decisionCandle = createCandle("1h", "2026-04-20T02:00:00.000Z", 101);
    decisionCandle.closeTime = decisionCloseTime;

    const frames = buildPositionGuardBacktestFrames({
      asset: "BTC",
      market: "KRW-BTC",
      oneHourCandles: [decisionCandle],
      fourHourCandles: [
        createCandle("4h", "2026-04-19T20:00:00.000Z", 98),
      ],
      oneDayCandles: [
        createCandle("1d", "2026-04-19T00:00:00.000Z", 95),
      ],
      startAt: "2026-04-20T03:00:00.000000100Z",
      endAt: "2026-04-20T03:00:00.000000100Z",
      minimumCompletedCandles: {
        "1h": 1,
        "4h": 1,
        "1d": 1,
      },
    });

    assert.equal(frames.length, 1);
    assert.equal(frames[0]?.generatedAt, decisionCloseTime);
    assert.equal(frames[0]?.source.latestCloseTime["1h"], decisionCloseTime);
  }
});

test("position guard backtest frame builder normalizes legacy timestamps for counterfactual replay", () => {
  const decisionCandle = createCandle("1h", "2026-04-20T02:00:00.000Z", 101);
  decisionCandle.closeTime = "2026-04-20T03:00:00.123456789";

  const frames = buildPositionGuardBacktestFrames({
    asset: "BTC",
    market: "KRW-BTC",
    oneHourCandles: [decisionCandle],
    fourHourCandles: [
      createCandle("4h", "2026-04-19T20:00:00.000Z", 98),
    ],
    oneDayCandles: [
      createCandle("1d", "2026-04-19T00:00:00.000Z", 95),
    ],
    minimumCompletedCandles: {
      "1h": 1,
      "4h": 1,
      "1d": 1,
    },
  });

  assert.equal(frames[0]?.generatedAt, "2026-04-20T03:00:00.123456789Z");
  assert.doesNotThrow(() => runCounterfactualScenarios({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 1_000_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    frames,
    scenarios: ["BASELINE"],
    diagnosticPolicy: { breakevenToleranceKrw: 0 },
  }));
});

test("position guard backtest frame builder rejects invalid explicit timestamps", () => {
  for (const startAt of [
    "2026-02-30T00:00:00.000Z",
    "2026-04-20T03:00:00.1234567890Z",
    "2026-04-20T03:00:00.000+14:01",
  ]) {
    assert.throws(
      () => buildPositionGuardBacktestFrames({
        asset: "BTC",
        market: "KRW-BTC",
        oneHourCandles: [],
        fourHourCandles: [],
        oneDayCandles: [],
        startAt,
      }),
      /Invalid PositionGuard backtest startAt/,
    );
  }
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

test("position guard backtest frame builder defaults to 200 completed candles in every timeframe", () => {
  const firstEligibleAt = "2026-04-20T00:00:00.000Z";
  const frames = buildPositionGuardBacktestFrames({
    asset: "BTC",
    market: "KRW-BTC",
    oneHourCandles: createCandleSeries("1h", 201, "2026-04-20T01:00:00.000Z"),
    fourHourCandles: createCandleSeries("4h", 201, "2026-04-20T04:00:00.000Z"),
    oneDayCandles: createCandleSeries("1d", 200, firstEligibleAt),
  });

  assert.equal(frames[0]?.generatedAt, firstEligibleAt);
  assert.ok(frames.every((frame) => frame.source.candleCounts["1h"] >= 200));
  assert.ok(frames.every((frame) => frame.source.candleCounts["4h"] >= 200));
  assert.ok(frames.every((frame) => frame.source.candleCounts["1d"] >= 200));
});

test("position guard backtest frame builder reads each candle close timestamp once", () => {
  let closeTimeReadCount = 0;
  const tracked = (candle: StrategyMarketCandle): StrategyMarketCandle => {
    const closeTime = candle.closeTime;
    return Object.defineProperty({ ...candle }, "closeTime", {
      enumerable: true,
      configurable: false,
      get() {
        closeTimeReadCount += 1;
        return closeTime;
      },
    });
  };
  const oneHourCandles = createCandleSeries("1h", 6, "2026-04-20T06:00:00.000Z").map(tracked);
  const fourHourCandles = createCandleSeries("4h", 3, "2026-04-20T04:00:00.000Z").map(tracked);
  const oneDayCandles = createCandleSeries("1d", 2, "2026-04-20T00:00:00.000Z").map(tracked);

  const frames = buildPositionGuardBacktestFrames({
    asset: "BTC",
    market: "KRW-BTC",
    oneHourCandles,
    fourHourCandles,
    oneDayCandles,
    minimumCompletedCandles: {
      "1h": 1,
      "4h": 1,
      "1d": 1,
    },
  });

  assert.ok(frames.length > 0);
  assert.equal(closeTimeReadCount, oneHourCandles.length + fourHourCandles.length + oneDayCandles.length);
});

function createCandleSeries(
  timeframe: "1h" | "4h" | "1d",
  count: number,
  finalCloseTime: string,
): StrategyMarketCandle[] {
  const durationMs = getTimeframeDurationMs(timeframe);
  const finalCloseMs = Date.parse(finalCloseTime);

  return Array.from({ length: count }, (_, index) => {
    const closeMs = finalCloseMs - (count - index - 1) * durationMs;
    return createCandle(
      timeframe,
      new Date(closeMs - durationMs).toISOString(),
      100 + index,
    );
  });
}

function createCandle(
  timeframe: "1h" | "4h" | "1d",
  openTime: string,
  closePrice: number,
): StrategyMarketCandle {
  const openMs = Date.parse(openTime);
  const durationMs = getTimeframeDurationMs(timeframe);

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

function getTimeframeDurationMs(timeframe: "1h" | "4h" | "1d"): number {
  return timeframe === "1h"
    ? 60 * 60 * 1000
    : timeframe === "4h"
      ? 4 * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;
}
