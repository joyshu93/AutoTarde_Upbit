import assert from "node:assert/strict";

import type { PositionGuardStructureAnalysis } from "../src/modules/strategy/position-guard-core.js";
import {
  runPositionGuardBacktest,
  type PositionGuardBacktestFrame,
  type PositionGuardBacktestResult,
} from "../src/modules/strategy/position-guard-backtest.js";
import {
  buildPositionGuardBacktestReport,
  formatPositionGuardBacktestReport,
} from "../src/modules/strategy/position-guard-backtest-report.js";
import { test } from "./harness.js";
import type { PositionGuardEngineDecision } from "../src/modules/strategy/position-guard-core.js";

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

test("position guard backtest report exposes diagnostics for benchmark, periods, regimes, skips, and trades", () => {
  const result: PositionGuardBacktestResult = {
    frames: [
      {
        generatedAt: "2026-01-01T00:00:00.000Z",
        regime: "RANGE",
        decision: createDecision("ENTER", 100_000),
        startingState: {
          cashKrw: 100_000,
          quantity: 0,
          averageEntryPrice: 0,
        },
        endingState: {
          cashKrw: 49_975,
          quantity: 0.5,
          averageEntryPrice: 100_000,
        },
        executed: true,
        trade: {
          action: "ENTER",
          side: "bid",
          price: 100_000,
          quantity: 0.5,
          grossNotionalKrw: 50_000,
          feeKrw: 25,
          realizedPnlKrw: 0,
        },
        skipReason: null,
        equityKrw: 99_975,
        drawdownPct: 0,
      },
      {
        generatedAt: "2026-01-31T23:00:00.000Z",
        regime: "EARLY_RECOVERY",
        decision: createDecision("ADD", 120_000),
        startingState: {
          cashKrw: 49_975,
          quantity: 0.5,
          averageEntryPrice: 100_000,
        },
        endingState: {
          cashKrw: 49_975,
          quantity: 0.5,
          averageEntryPrice: 100_000,
        },
        executed: false,
        trade: null,
        skipReason: "BELOW_MINIMUM_TRADE_VALUE",
        equityKrw: 109_975,
        drawdownPct: 0,
      },
      {
        generatedAt: "2026-02-01T00:00:00.000Z",
        regime: "WEAK_DOWNTREND",
        decision: createDecision("EXIT", 90_000),
        startingState: {
          cashKrw: 49_975,
          quantity: 0.5,
          averageEntryPrice: 100_000,
        },
        endingState: {
          cashKrw: 94_952.5,
          quantity: 0,
          averageEntryPrice: 0,
        },
        executed: true,
        trade: {
          action: "EXIT",
          side: "ask",
          price: 90_000,
          quantity: 0.5,
          grossNotionalKrw: 45_000,
          feeKrw: 22.5,
          realizedPnlKrw: -5_022.5,
        },
        skipReason: null,
        equityKrw: 94_952.5,
        drawdownPct: 0.1366,
      },
    ],
    metrics: {
      actionCounts: {
        ENTER: 1,
        ADD: 1,
        REDUCE: 0,
        EXIT: 1,
        HOLD: 0,
      },
      regimeCounts: {
        BULL_TREND: 0,
        PULLBACK_IN_UPTREND: 0,
        EARLY_RECOVERY: 1,
        RECLAIM_ATTEMPT: 0,
        RANGE: 1,
        WEAK_DOWNTREND: 1,
        BREAKDOWN_RISK: 0,
      },
      tradeCount: 2,
      skippedOrderCount: 1,
      turnoverKrw: 95_000,
      feesKrw: 47.5,
      realizedPnlKrw: -5_022.5,
      finalEquityKrw: 94_952.5,
      totalReturnPct: -0.050475,
      maxDrawdownPct: 0.1366,
      timeInMarketFrames: 2,
    },
    finalState: {
      cashKrw: 94_952.5,
      quantity: 0,
      averageEntryPrice: 0,
    },
  };

  const report = buildPositionGuardBacktestReport(result, { label: "diagnostic-sample" });
  const formatted = formatPositionGuardBacktestReport(report);

  assert.equal(report.benchmark.initialEquityKrw, 100_000);
  assert.equal(report.benchmark.cashHoldReturnPct, 0);
  assert.equal(report.benchmark.buyHoldFinalEquityKrw, 90_000);
  assert.equal(report.benchmark.buyHoldReturnPct, -0.1);
  assert.equal(report.benchmark.strategyVsBuyHoldPct, 0.049525);
  assert.deepEqual(report.skipReasonCounts, {
    BELOW_MINIMUM_TRADE_VALUE: 1,
    INSUFFICIENT_CASH: 0,
    NO_POSITION: 0,
  });
  assert.deepEqual(report.monthlyReturns.map((month) => month.month), ["2026-01", "2026-02"]);
  assert.equal(report.monthlyReturns[0]?.returnPct, 0.09975);
  assert.equal(report.monthlyReturns[1]?.returnPct, -0.136599);
  assert.equal(report.regimePerformance.RANGE.equityChangeKrw, -25);
  assert.equal(report.regimePerformance.EARLY_RECOVERY.equityChangeKrw, 10_000);
  assert.equal(report.regimePerformance.WEAK_DOWNTREND.equityChangeKrw, -15_022.5);
  assert.equal(report.tradeDiagnostics.sellTradeCount, 1);
  assert.equal(report.tradeDiagnostics.sellWinRatePct, 0);
  assert.equal(report.tradeDiagnostics.averageRealizedPnlKrw, -5_022.5);
  assert.equal(report.tradeDiagnostics.profitFactor, 0);
  assert.equal(report.tradeDiagnostics.completedPositionCount, 1);
  assert.equal(report.tradeDiagnostics.averageCompletedHoldFrames, 3);
  assert.match(formatted, /benchmark:/);
  assert.match(formatted, /monthly_returns:/);
  assert.match(formatted, /regime_performance:/);
  assert.match(formatted, /skipped_order_reasons: BELOW_MINIMUM_TRADE_VALUE=1 INSUFFICIENT_CASH=0 NO_POSITION=0/);
  assert.match(formatted, /trade_diagnostics:/);
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

function createDecision(
  action: PositionGuardEngineDecision["action"],
  referencePrice: number,
): PositionGuardEngineDecision {
  return {
    action,
    summary: action,
    reasons: [],
    targetNotionalKrw: action === "ENTER" || action === "ADD" ? 50_000 : 0,
    targetQuantityFraction: action === "EXIT" ? 1 : null,
    referencePrice,
    executionDisposition: action === "HOLD" ? "SKIPPED" : "IMMEDIATE",
    signalQuality: {
      score: 0,
      bucket: "LOW",
      confirmationRequired: false,
      confirmationSatisfied: false,
      reentryPenaltyApplied: false,
    },
    exposureGuardrails: {
      perAssetMaxAllocation: 0.5,
      totalPortfolioMaxExposure: 0.8,
      remainingAssetCapacity: 50_000,
      remainingPortfolioCapacity: 80_000,
    },
    diagnostics: {
      regime: "RANGE",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: null,
      entryPath: "NONE",
      trendAlignmentScore: 0,
      recoveryQualityScore: 0,
      breakdownPressureScore: 0,
      weakeningStage: "NONE",
      upperRangeChase: false,
      pullbackZone: false,
      reclaimStructure: false,
      breakoutHoldStructure: false,
    },
  };
}
