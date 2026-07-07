import type { StrategyDecisionAction } from "../../domain/types.js";
import type { SupportedStrategyTimeframe } from "./market-structure.js";
import type {
  PositionGuardBacktestResult,
} from "./position-guard-backtest.js";
import type { StrategyMarketRegime } from "./position-guard-core.js";

export type PositionGuardBacktestReportWarningCode =
  | "NO_FRAMES"
  | "SKIPPED_ORDER_INTENTS"
  | "FUTURE_SOURCE_CANDLE";

export interface PositionGuardBacktestReportWarning {
  code: PositionGuardBacktestReportWarningCode;
  detail: string;
}

export interface PositionGuardBacktestReport {
  label: string | null;
  frameCount: number;
  tradeCount: number;
  skippedOrderCount: number;
  finalEquityKrw: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  timeInMarketPct: number;
  turnoverKrw: number;
  feesKrw: number;
  realizedPnlKrw: number;
  actionCounts: Record<StrategyDecisionAction, number>;
  regimeCounts: Record<StrategyMarketRegime, number>;
  warnings: PositionGuardBacktestReportWarning[];
}

export interface PositionGuardBacktestReportOptions {
  label?: string;
}

const ACTION_ORDER: StrategyDecisionAction[] = ["ENTER", "ADD", "REDUCE", "EXIT", "HOLD"];
const REGIME_ORDER: StrategyMarketRegime[] = [
  "BULL_TREND",
  "PULLBACK_IN_UPTREND",
  "EARLY_RECOVERY",
  "RECLAIM_ATTEMPT",
  "RANGE",
  "WEAK_DOWNTREND",
  "BREAKDOWN_RISK",
];
const TIMEFRAME_ORDER: SupportedStrategyTimeframe[] = ["1h", "4h", "1d"];

export function buildPositionGuardBacktestReport(
  result: PositionGuardBacktestResult,
  options: PositionGuardBacktestReportOptions = {},
): PositionGuardBacktestReport {
  const frameCount = result.frames.length;

  return {
    label: options.label ?? null,
    frameCount,
    tradeCount: result.metrics.tradeCount,
    skippedOrderCount: result.metrics.skippedOrderCount,
    finalEquityKrw: result.metrics.finalEquityKrw,
    totalReturnPct: result.metrics.totalReturnPct,
    maxDrawdownPct: result.metrics.maxDrawdownPct,
    timeInMarketPct: frameCount > 0 ? result.metrics.timeInMarketFrames / frameCount : 0,
    turnoverKrw: result.metrics.turnoverKrw,
    feesKrw: result.metrics.feesKrw,
    realizedPnlKrw: result.metrics.realizedPnlKrw,
    actionCounts: { ...result.metrics.actionCounts },
    regimeCounts: { ...result.metrics.regimeCounts },
    warnings: collectWarnings(result),
  };
}

export function formatPositionGuardBacktestReport(report: PositionGuardBacktestReport): string {
  const lines = [
    "PositionGuard Backtest Report",
    `label: ${report.label ?? "none"}`,
    `frames: ${report.frameCount}`,
    `trades: ${report.tradeCount}`,
    `skipped_orders: ${report.skippedOrderCount}`,
    `final_equity_krw: ${formatMoney(report.finalEquityKrw)}`,
    `total_return_pct: ${formatPercentRatio(report.totalReturnPct)}`,
    `max_drawdown_pct: ${formatPercentRatio(report.maxDrawdownPct)}`,
    `time_in_market_pct: ${formatPercentRatio(report.timeInMarketPct)}`,
    `turnover_krw: ${formatMoney(report.turnoverKrw)}`,
    `fees_krw: ${formatMoney(report.feesKrw)}`,
    `realized_pnl_krw: ${formatMoney(report.realizedPnlKrw)}`,
    `actions: ${formatCounts(report.actionCounts, ACTION_ORDER)}`,
    `regimes: ${formatCounts(report.regimeCounts, REGIME_ORDER)}`,
  ];

  if (report.warnings.length === 0) {
    lines.push("warnings: none");
  } else {
    lines.push("warnings:");
    for (const warning of report.warnings) {
      lines.push(`- ${warning.code} | ${warning.detail}`);
    }
  }

  return lines.join("\n");
}

function collectWarnings(result: PositionGuardBacktestResult): PositionGuardBacktestReportWarning[] {
  const warnings: PositionGuardBacktestReportWarning[] = [];

  if (result.frames.length === 0) {
    warnings.push({
      code: "NO_FRAMES",
      detail: "Backtest replay contains no decision frames.",
    });
  }

  if (result.metrics.skippedOrderCount > 0) {
    warnings.push({
      code: "SKIPPED_ORDER_INTENTS",
      detail: `${result.metrics.skippedOrderCount} order intent(s) were skipped by the offline execution model.`,
    });
  }

  for (const frame of result.frames) {
    if (!frame.source) continue;
    const decisionMs = toUtcMs(frame.generatedAt);
    if (decisionMs === null) continue;

    for (const timeframe of TIMEFRAME_ORDER) {
      const latestCloseTime = frame.source.latestCloseTime[timeframe];
      if (latestCloseTime === null) continue;
      const latestCloseMs = toUtcMs(latestCloseTime);
      if (latestCloseMs === null || latestCloseMs <= decisionMs) continue;

      warnings.push({
        code: "FUTURE_SOURCE_CANDLE",
        detail: `frame=${frame.generatedAt} timeframe=${timeframe} latest_close_time=${latestCloseTime} is after decision time`,
      });
    }
  }

  return warnings;
}

function formatCounts<T extends string>(counts: Record<T, number>, order: readonly T[]): string {
  return order.map((key) => `${key}=${counts[key] ?? 0}`).join(" ");
}

function formatMoney(value: number): string {
  return value.toFixed(6);
}

function formatPercentRatio(value: number): string {
  return (value * 100).toFixed(4);
}

function toUtcMs(value: string): number | null {
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
}
