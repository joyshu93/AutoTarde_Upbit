import assert from "node:assert/strict";

import { decidePositionGuardCore, DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS } from "../src/modules/strategy/position-guard-core.js";
import {
  analyzePositionGuardMarketStructure,
  type PositionGuardMarketSnapshot,
  type StrategyMarketCandle,
  type SupportedStrategyTimeframe,
} from "../src/modules/strategy/market-structure.js";
import { test } from "./harness.js";

test("position guard market structure creates a constructive pullback input", () => {
  const snapshot = createSnapshot({
    currentPrice: 107,
    closeForIndex: (index) => index < 202 ? 100 + index * 0.08 : 106 + ((index % 5) * 0.4),
    highForClose: (close, index) => index >= 202 ? Math.max(close * 1.006, 125) : close * 1.006,
    lowForClose: (close, index) => index >= 202 ? Math.min(close * 0.994, 100) : close * 0.994,
  });

  const analysis = analyzePositionGuardMarketStructure(snapshot);

  assert.equal(analysis.invalidationState, "CLEAR");
  assert.equal(analysis.entryPath, "PULLBACK");
  assert.equal(analysis.pullbackZone, true);
  assert.notEqual(analysis.riskLevel, "HIGH");
});

test("position guard market structure feeds the core decision engine", () => {
  const snapshot = createSnapshot({
    currentPrice: 107,
    closeForIndex: (index) => index < 202 ? 100 + index * 0.08 : 106 + ((index % 5) * 0.4),
    highForClose: (close, index) => index >= 202 ? Math.max(close * 1.006, 125) : close * 1.006,
    lowForClose: (close, index) => index >= 202 ? Math.min(close * 0.994, 100) : close * 0.994,
  });
  const analysis = analyzePositionGuardMarketStructure(snapshot);
  const decision = decidePositionGuardCore({
    asset: "BTC",
    market: "KRW-BTC",
    generatedAt: "2026-04-20T01:05:00.000Z",
    availableKrw: 1_000_000,
    positionQuantity: 0,
    averageEntryPrice: 0,
    portfolio: {
      totalEquityKrw: 2_000_000,
      assetMarketValueKrw: 0,
      totalExposureKrw: 0,
    },
    latestDecision: null,
    recentExit: {
      createdAt: null,
      hoursSinceExit: null,
      realizedPnl: null,
    },
    settings: DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
    analysis,
  });

  assert.ok(["ENTER", "HOLD"].includes(decision.action));
  assert.equal(decision.referencePrice, 107);
  assert.equal(decision.diagnostics.invalidationState, "CLEAR");
});

test("position guard market structure marks breakdown and invalidation failure", () => {
  const snapshot = createSnapshot({
    currentPrice: 82,
    closeForIndex: (index) => {
      if (index < 200) return 125 - index * 0.05;
      if (index === 218) return 99;
      if (index === 219) return 82;
      return 101 - (index - 200) * 0.2;
    },
    lowForClose: (close, index) => index === 219 ? close * 0.995 : Math.min(close * 0.995, 96),
  });

  const analysis = analyzePositionGuardMarketStructure(snapshot, 100);

  assert.equal(analysis.invalidationState, "BROKEN");
  assert.equal(analysis.weakeningStage, "FAILURE");
  assert.ok(analysis.breakdown1d || analysis.breakdown4h);
  assert.ok(analysis.pnlPct < 0);
});

test("position guard market structure ignores unfinished spike candles", () => {
  const snapshot = createSnapshot({
    currentPrice: 107,
    closeForIndex: (index) => 100 + index * 0.03,
  });
  const unfinished = createCandle({
    timeframe: "1h",
    index: 220,
    close: 180,
    openTime: "2026-04-20T01:00:00.000Z",
    closeTime: "2026-04-20T02:00:00.000Z",
  });
  snapshot.timeframes["1h"].candles.push(unfinished);
  snapshot.ticker.exchangeTimestampMs = Date.parse("2026-04-20T01:30:00.000Z");

  const analysis = analyzePositionGuardMarketStructure(snapshot);

  assert.notEqual(analysis.timeframes["1h"].latestClose, unfinished.closePrice);
  assert.equal(analysis.currentPrice, 107);
});

function createSnapshot(input: {
  currentPrice: number;
  closeForIndex: (index: number, timeframe: SupportedStrategyTimeframe) => number;
  highForClose?: (close: number, index: number, timeframe: SupportedStrategyTimeframe) => number;
  lowForClose?: (close: number, index: number, timeframe: SupportedStrategyTimeframe) => number;
}): PositionGuardMarketSnapshot {
  const fetchedAt = "2026-04-20T01:05:00.000Z";

  return {
    asset: "BTC",
    market: "KRW-BTC",
    fetchedAt,
    ticker: {
      tradePrice: input.currentPrice,
      tradeTimeUtc: fetchedAt,
      exchangeTimestampMs: Date.parse(fetchedAt),
    },
    timeframes: {
      "1h": {
        timeframe: "1h",
        candles: createCandles("1h", 220, input.closeForIndex, input.highForClose, input.lowForClose),
      },
      "4h": {
        timeframe: "4h",
        candles: createCandles("4h", 220, input.closeForIndex, input.highForClose, input.lowForClose),
      },
      "1d": {
        timeframe: "1d",
        candles: createCandles("1d", 220, input.closeForIndex, input.highForClose, input.lowForClose),
      },
    },
  };
}

function createCandles(
  timeframe: SupportedStrategyTimeframe,
  count: number,
  closeForIndex: (index: number, timeframe: SupportedStrategyTimeframe) => number,
  highForClose?: (close: number, index: number, timeframe: SupportedStrategyTimeframe) => number,
  lowForClose?: (close: number, index: number, timeframe: SupportedStrategyTimeframe) => number,
): StrategyMarketCandle[] {
  const durationMs = timeframe === "1h" ? 60 * 60 * 1000 : timeframe === "4h" ? 4 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const lastCloseMs = Date.parse("2026-04-20T01:00:00.000Z");

  return Array.from({ length: count }, (_, index) => {
    const close = closeForIndex(index, timeframe);
    const closeTime = new Date(lastCloseMs - ((count - 1 - index) * durationMs)).toISOString();
    const openTime = new Date(lastCloseMs - ((count - index) * durationMs)).toISOString();
    const explicitLow = lowForClose?.(close, index, timeframe);
    const explicitHigh = highForClose?.(close, index, timeframe);
    return createCandle({
      timeframe,
      index,
      close,
      openTime,
      closeTime,
      ...(explicitHigh === undefined ? {} : { high: explicitHigh }),
      ...(explicitLow === undefined ? {} : { low: explicitLow }),
    });
  });
}

function createCandle(input: {
  timeframe: SupportedStrategyTimeframe;
  index: number;
  close: number;
  openTime: string;
  closeTime: string;
  high?: number;
  low?: number;
}): StrategyMarketCandle {
  const open = input.close * (input.index % 2 === 0 ? 0.998 : 1.002);
  const high = input.high ?? Math.max(open, input.close) * 1.006;
  const low = input.low ?? Math.min(open, input.close) * 0.994;

  return {
    market: "KRW-BTC",
    timeframe: input.timeframe,
    openTime: input.openTime,
    closeTime: input.closeTime,
    openPrice: open,
    highPrice: high,
    lowPrice: low,
    closePrice: input.close,
    volume: 100 + input.index,
    quoteVolume: input.close * (100 + input.index),
  };
}
