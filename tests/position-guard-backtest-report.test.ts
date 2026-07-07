import assert from "node:assert/strict";

import type { PositionGuardStructureAnalysis } from "../src/modules/strategy/position-guard-core.js";
import {
  runPositionGuardBacktest,
  type PositionGuardBacktestFrame,
} from "../src/modules/strategy/position-guard-backtest.js";
import {
  buildPositionGuardBacktestReport,
  formatPositionGuardBacktestReport,
} from "../src/modules/strategy/position-guard-backtest-report.js";
import { test } from "./harness.js";

test("position guard backtest report summarizes replay metrics in a stable text format", () => {
  const result = runPositionGuardBacktest({
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 100_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
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
      createFrame("2026-04-20T02:00:00.000Z", {
        invalidationState: "BROKEN",
        breakdown1d: true,
        breakdown4h: true,
        bearishMomentumExpansion: true,
        currentPrice: 110_000,
      }),
    ],
  });

  const report = buildPositionGuardBacktestReport(result, { label: "btc-sample" });
  const formatted = formatPositionGuardBacktestReport(report);

  assert.equal(report.label, "btc-sample");
  assert.equal(report.frameCount, 2);
  assert.equal(report.tradeCount, 2);
  assert.equal(report.actionCounts.ENTER, 1);
  assert.equal(report.actionCounts.EXIT, 1);
  assert.equal(report.timeInMarketPct, 0.5);
  assert.deepEqual(report.warnings, []);
  assert.match(formatted, /PositionGuard Backtest Report/);
  assert.match(formatted, /label: btc-sample/);
  assert.match(formatted, /frames: 2/);
  assert.match(formatted, /trades: 2/);
  assert.match(formatted, /total_return_pct:/);
  assert.match(formatted, /actions: ENTER=1 ADD=0 REDUCE=0 EXIT=1 HOLD=0/);
  assert.match(formatted, /warnings: none/);
});

test("position guard backtest report warns when replay source data is after the decision time", () => {
  const result = runPositionGuardBacktest({
    asset: "ETH",
    market: "KRW-ETH",
    initialCashKrw: 100_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    frames: [
      {
        ...createFrame("2026-04-20T01:00:00.000Z", {}),
        source: {
          candleCounts: {
            "1h": 24,
            "4h": 24,
            "1d": 30,
          },
          latestCloseTime: {
            "1h": "2026-04-20T02:00:00.000Z",
            "4h": "2026-04-20T00:00:00.000Z",
            "1d": "2026-04-20T00:00:00.000Z",
          },
        },
      },
    ],
  });

  const report = buildPositionGuardBacktestReport(result);
  const formatted = formatPositionGuardBacktestReport(report);

  assert.equal(report.warnings.length, 1);
  assert.equal(report.warnings[0]?.code, "FUTURE_SOURCE_CANDLE");
  assert.match(report.warnings[0]?.detail ?? "", /1h/);
  assert.match(formatted, /warnings:/);
  assert.match(formatted, /FUTURE_SOURCE_CANDLE/);
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
