import assert from "node:assert/strict";

import {
  DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
  type PositionGuardStructureAnalysis,
} from "../src/modules/strategy/position-guard-core.js";
import {
  runPositionGuardBacktest,
  type PositionGuardBacktestFrame,
} from "../src/modules/strategy/position-guard-backtest.js";
import { test } from "./harness.js";

test("position guard backtest replays buys and exits with trading costs", () => {
  const result = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 100_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    execution: {
      feeRate: 0.0005,
      slippageRate: 0.001,
      minimumTradeValueKrw: 5_000,
    },
    frames: [
      createFrame("2026-04-20T01:00:00.000Z", {
        regime: "EARLY_RECOVERY",
        currentPrice: 100_000,
        entryPath: "RECLAIM",
        reclaimStructure: true,
        trendAlignmentScore: 4,
        recoveryQualityScore: 4,
        volumeRecovery: true,
        macdImproving: true,
        rsiRecovery: true,
      }),
      createFrame("2026-04-20T02:00:00.000Z", {
        invalidationState: "BROKEN",
        breakdown1d: true,
        breakdown4h: true,
        bearishMomentumExpansion: true,
        currentPrice: 110_000,
      }),
    ],
  });

  assert.equal(result.metrics.tradeCount, 2);
  assert.equal(result.metrics.actionCounts.ENTER, 1);
  assert.equal(result.metrics.actionCounts.EXIT, 1);
  assert.equal(result.frames[0]?.executed, true);
  assert.equal(result.frames[1]?.executed, true);
  assert.ok(result.metrics.turnoverKrw > 0);
  assert.ok(result.metrics.feesKrw > 0);
  assert.ok(result.metrics.finalEquityKrw > 100_000);
  assert.equal(result.finalState.quantity, 0);
});

test("position guard backtest skips order intents below the execution minimum", () => {
  const result = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 10_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    settings: {
      ...DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
      entryAllocation: 0.1,
    },
    execution: {
      feeRate: 0.0005,
      slippageRate: 0,
      minimumTradeValueKrw: 5_000,
    },
    frames: [
      createFrame("2026-04-20T01:00:00.000Z", {
        regime: "EARLY_RECOVERY",
        currentPrice: 100_000,
        entryPath: "RECLAIM",
        reclaimStructure: true,
        trendAlignmentScore: 4,
        recoveryQualityScore: 4,
        volumeRecovery: true,
        macdImproving: true,
        rsiRecovery: true,
      }),
    ],
  });

  assert.equal(result.metrics.tradeCount, 0);
  assert.equal(result.metrics.skippedOrderCount, 1);
  assert.equal(result.frames[0]?.executed, false);
  assert.equal(result.frames[0]?.skipReason, "BELOW_MINIMUM_TRADE_VALUE");
  assert.equal(result.finalState.cashKrw, 10_000);
  assert.equal(result.finalState.quantity, 0);
});

test("position guard backtest executes only after a deferred entry is confirmed", () => {
  const analysis: Partial<PositionGuardStructureAnalysis> = {
    regime: "RECLAIM_ATTEMPT",
    currentPrice: 100_000,
    entryPath: "RECLAIM",
    reclaimStructure: true,
    trendAlignmentScore: 3,
    recoveryQualityScore: 3,
  };
  const result = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 1_000_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    frames: [
      createFrame("2026-04-20T01:05:00.000Z", analysis),
      createFrame("2026-04-20T02:05:00.000Z", analysis),
    ],
  });

  assert.equal(result.frames[0]?.decision.action, "ENTER");
  assert.equal(result.frames[0]?.decision.executionDisposition, "DEFERRED_CONFIRMATION");
  assert.equal(result.frames[0]?.executed, false);
  assert.equal(result.frames[0]?.trade, null);
  assert.equal(result.frames[0]?.skipReason, null);
  assert.equal(result.frames[1]?.decision.action, "ENTER");
  assert.equal(result.frames[1]?.decision.executionDisposition, "EXECUTED_AFTER_CONFIRMATION");
  assert.equal(result.frames[1]?.executed, true);
  assert.equal(result.frames[1]?.trade?.action, "ENTER");
  assert.equal(result.metrics.tradeCount, 1);
  assert.equal(result.metrics.skippedOrderCount, 0);
  assert.ok(result.finalState.quantity > 0);
});

function createFrame(
  generatedAt: string,
  analysisOverrides: Partial<PositionGuardStructureAnalysis>,
): PositionGuardBacktestFrame {
  return {
    generatedAt,
    analysis: {
      regime: "RANGE",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: 95_000,
      pullbackZone: false,
      reclaimStructure: false,
      breakoutHoldStructure: false,
      upperRangeChase: false,
      currentPrice: 100_000,
      entryPath: "NONE",
      trendAlignmentScore: 0,
      recoveryQualityScore: 0,
      breakdownPressureScore: 0,
      weakeningStage: "NONE",
      breakdown1d: false,
      breakdown4h: false,
      failedReclaim: false,
      bearishMomentumExpansion: false,
      volumeRecovery: false,
      macdImproving: false,
      rsiRecovery: false,
      atrShock: false,
      averageEntryPrice: 0,
      pnlPct: 0,
      oneHourLocation: "MIDDLE",
      fourHourLocation: "MIDDLE",
      ...analysisOverrides,
    },
  };
}
