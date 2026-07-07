import type { StrategyDecisionAction } from "../../domain/types.js";
import type { SupportedStrategyTimeframe } from "./market-structure.js";
import type {
  PositionGuardBacktestResult,
  PositionGuardBacktestSkipReason,
  PositionGuardBacktestState,
  PositionGuardBacktestTrade,
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

export interface PositionGuardBacktestBenchmarkReport {
  initialEquityKrw: number;
  finalCashHoldEquityKrw: number;
  cashHoldReturnPct: number;
  buyHoldFinalEquityKrw: number;
  buyHoldReturnPct: number;
  strategyVsBuyHoldPct: number;
}

export interface PositionGuardBacktestMonthlyReturn {
  month: string;
  frameCount: number;
  startEquityKrw: number;
  endEquityKrw: number;
  returnPct: number;
}

export interface PositionGuardBacktestRegimePerformance {
  frameCount: number;
  equityChangeKrw: number;
  returnContributionPct: number;
}

export interface PositionGuardBacktestTradeDiagnostics {
  sellTradeCount: number;
  winningSellTradeCount: number;
  losingSellTradeCount: number;
  breakevenSellTradeCount: number;
  sellWinRatePct: number;
  averageRealizedPnlKrw: number;
  averageWinKrw: number;
  averageLossKrw: number;
  profitFactor: number | null;
  completedPositionCount: number;
  averageCompletedHoldFrames: number | null;
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
  benchmark: PositionGuardBacktestBenchmarkReport;
  monthlyReturns: PositionGuardBacktestMonthlyReturn[];
  regimePerformance: Record<StrategyMarketRegime, PositionGuardBacktestRegimePerformance>;
  skipReasonCounts: Record<PositionGuardBacktestSkipReason, number>;
  tradeDiagnostics: PositionGuardBacktestTradeDiagnostics;
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
const SKIP_REASON_ORDER: PositionGuardBacktestSkipReason[] = [
  "BELOW_MINIMUM_TRADE_VALUE",
  "INSUFFICIENT_CASH",
  "NO_POSITION",
];

export function buildPositionGuardBacktestReport(
  result: PositionGuardBacktestResult,
  options: PositionGuardBacktestReportOptions = {},
): PositionGuardBacktestReport {
  const frameCount = result.frames.length;
  const initialEquityKrw = getInitialEquity(result);

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
    benchmark: buildBenchmarkReport(result, initialEquityKrw),
    monthlyReturns: buildMonthlyReturns(result, initialEquityKrw),
    regimePerformance: buildRegimePerformance(result, initialEquityKrw),
    skipReasonCounts: buildSkipReasonCounts(result),
    tradeDiagnostics: buildTradeDiagnostics(result),
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
    "benchmark:",
    `- cash_hold_return_pct: ${formatPercentRatio(report.benchmark.cashHoldReturnPct)}`,
    `- buy_hold_return_pct: ${formatPercentRatio(report.benchmark.buyHoldReturnPct)}`,
    `- strategy_vs_buy_hold_pct: ${formatPercentRatio(report.benchmark.strategyVsBuyHoldPct)}`,
    `- buy_hold_final_equity_krw: ${formatMoney(report.benchmark.buyHoldFinalEquityKrw)}`,
    `actions: ${formatCounts(report.actionCounts, ACTION_ORDER)}`,
    `regimes: ${formatCounts(report.regimeCounts, REGIME_ORDER)}`,
    `skipped_order_reasons: ${formatCounts(report.skipReasonCounts, SKIP_REASON_ORDER)}`,
    formatTradeDiagnostics(report.tradeDiagnostics),
  ];

  if (report.monthlyReturns.length === 0) {
    lines.push("monthly_returns: none");
  } else {
    lines.push("monthly_returns:");
    for (const monthlyReturn of report.monthlyReturns) {
      lines.push(
        `- ${monthlyReturn.month} | frames=${monthlyReturn.frameCount} return_pct=${formatPercentRatio(monthlyReturn.returnPct)} start_equity_krw=${formatMoney(monthlyReturn.startEquityKrw)} end_equity_krw=${formatMoney(monthlyReturn.endEquityKrw)}`,
      );
    }
  }

  lines.push("regime_performance:");
  for (const regime of REGIME_ORDER) {
    const performance = report.regimePerformance[regime];
    lines.push(
      `- ${regime} | frames=${performance.frameCount} return_contribution_pct=${formatPercentRatio(performance.returnContributionPct)} equity_change_krw=${formatMoney(performance.equityChangeKrw)}`,
    );
  }

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

function buildBenchmarkReport(
  result: PositionGuardBacktestResult,
  initialEquityKrw: number,
): PositionGuardBacktestBenchmarkReport {
  const firstPrice = result.frames[0]?.decision.referencePrice ?? 0;
  const lastPrice = result.frames.at(-1)?.decision.referencePrice ?? firstPrice;
  const finalCashHoldEquityKrw = initialEquityKrw;
  const buyHoldFinalEquityKrw = firstPrice > 0
    ? roundMoney((initialEquityKrw / firstPrice) * lastPrice)
    : initialEquityKrw;
  const cashHoldReturnPct = getReturnPct(initialEquityKrw, finalCashHoldEquityKrw);
  const buyHoldReturnPct = getReturnPct(initialEquityKrw, buyHoldFinalEquityKrw);

  return {
    initialEquityKrw,
    finalCashHoldEquityKrw,
    cashHoldReturnPct,
    buyHoldFinalEquityKrw,
    buyHoldReturnPct,
    strategyVsBuyHoldPct: roundRatio(result.metrics.totalReturnPct - buyHoldReturnPct),
  };
}

function buildMonthlyReturns(
  result: PositionGuardBacktestResult,
  initialEquityKrw: number,
): PositionGuardBacktestMonthlyReturn[] {
  const monthlyReturns = new Map<string, PositionGuardBacktestMonthlyReturn>();
  let previousEquity = initialEquityKrw;

  for (const frame of result.frames) {
    const month = getUtcMonthKey(frame.generatedAt);
    if (month === null) {
      previousEquity = frame.equityKrw;
      continue;
    }

    let monthlyReturn = monthlyReturns.get(month);
    if (monthlyReturn === undefined) {
      monthlyReturn = {
        month,
        frameCount: 0,
        startEquityKrw: roundMoney(previousEquity),
        endEquityKrw: roundMoney(previousEquity),
        returnPct: 0,
      };
      monthlyReturns.set(month, monthlyReturn);
    }

    monthlyReturn.frameCount += 1;
    monthlyReturn.endEquityKrw = roundMoney(frame.equityKrw);
    monthlyReturn.returnPct = getReturnPct(monthlyReturn.startEquityKrw, monthlyReturn.endEquityKrw);
    previousEquity = frame.equityKrw;
  }

  return [...monthlyReturns.values()];
}

function buildRegimePerformance(
  result: PositionGuardBacktestResult,
  initialEquityKrw: number,
): Record<StrategyMarketRegime, PositionGuardBacktestRegimePerformance> {
  const performance = createRegimePerformance();
  let previousEquity = initialEquityKrw;

  for (const frame of result.frames) {
    const frameEquityChangeKrw = frame.equityKrw - previousEquity;
    const regimePerformance = performance[frame.regime];
    regimePerformance.frameCount += 1;
    regimePerformance.equityChangeKrw = roundMoney(regimePerformance.equityChangeKrw + frameEquityChangeKrw);
    regimePerformance.returnContributionPct = initialEquityKrw > 0
      ? roundRatio(regimePerformance.equityChangeKrw / initialEquityKrw)
      : 0;
    previousEquity = frame.equityKrw;
  }

  return performance;
}

function buildSkipReasonCounts(
  result: PositionGuardBacktestResult,
): Record<PositionGuardBacktestSkipReason, number> {
  const counts = createSkipReasonCounts();
  for (const frame of result.frames) {
    if (frame.skipReason === null) continue;
    counts[frame.skipReason] += 1;
  }
  return counts;
}

function buildTradeDiagnostics(result: PositionGuardBacktestResult): PositionGuardBacktestTradeDiagnostics {
  const sellTrades = result.frames
    .map((frame) => frame.trade)
    .filter((trade): trade is PositionGuardBacktestTrade => trade !== null && trade.side === "ask");
  const realizedPnls = sellTrades.map((trade) => trade.realizedPnlKrw);
  const wins = realizedPnls.filter((pnl) => pnl > 0);
  const losses = realizedPnls.filter((pnl) => pnl < 0);
  const breakevenCount = realizedPnls.length - wins.length - losses.length;
  const grossWin = wins.reduce((sum, pnl) => sum + pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0));
  const completedHoldFrames = getCompletedHoldFrames(result);

  return {
    sellTradeCount: sellTrades.length,
    winningSellTradeCount: wins.length,
    losingSellTradeCount: losses.length,
    breakevenSellTradeCount: breakevenCount,
    sellWinRatePct: sellTrades.length > 0 ? roundRatio(wins.length / sellTrades.length) : 0,
    averageRealizedPnlKrw: roundMoney(average(realizedPnls)),
    averageWinKrw: roundMoney(average(wins)),
    averageLossKrw: roundMoney(average(losses)),
    profitFactor: grossLoss > 0 ? roundRatio(grossWin / grossLoss) : (grossWin > 0 ? null : 0),
    completedPositionCount: completedHoldFrames.length,
    averageCompletedHoldFrames: completedHoldFrames.length > 0 ? roundRatio(average(completedHoldFrames)) : null,
  };
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

function getInitialEquity(result: PositionGuardBacktestResult): number {
  const firstFrame = result.frames[0];
  if (firstFrame === undefined) {
    return result.metrics.finalEquityKrw;
  }

  return roundMoney(getStateEquity(firstFrame.startingState, firstFrame.decision.referencePrice));
}

function getStateEquity(state: PositionGuardBacktestState, referencePrice: number): number {
  return state.cashKrw + state.quantity * referencePrice;
}

function getReturnPct(startEquityKrw: number, endEquityKrw: number): number {
  if (startEquityKrw <= 0) {
    return 0;
  }
  return roundRatio((endEquityKrw - startEquityKrw) / startEquityKrw);
}

function getUtcMonthKey(value: string): string | null {
  const timestamp = toUtcMs(value);
  if (timestamp === null) return null;
  return new Date(timestamp).toISOString().slice(0, 7);
}

function getCompletedHoldFrames(result: PositionGuardBacktestResult): number[] {
  const completedHoldFrames: number[] = [];
  const firstFrame = result.frames[0];
  let openFrameIndex: number | null = firstFrame !== undefined && firstFrame.startingState.quantity > 0 ? 0 : null;

  for (let index = 0; index < result.frames.length; index += 1) {
    const frame = result.frames[index];
    if (frame === undefined) continue;

    if (openFrameIndex === null && frame.startingState.quantity <= 0 && frame.endingState.quantity > 0) {
      openFrameIndex = index;
    }
    if (openFrameIndex !== null && frame.startingState.quantity > 0 && frame.endingState.quantity <= 0) {
      completedHoldFrames.push(index - openFrameIndex + 1);
      openFrameIndex = null;
    }
  }

  return completedHoldFrames;
}

function createRegimePerformance(): Record<StrategyMarketRegime, PositionGuardBacktestRegimePerformance> {
  return Object.fromEntries(
    REGIME_ORDER.map((regime) => [
      regime,
      {
        frameCount: 0,
        equityChangeKrw: 0,
        returnContributionPct: 0,
      },
    ]),
  ) as Record<StrategyMarketRegime, PositionGuardBacktestRegimePerformance>;
}

function createSkipReasonCounts(): Record<PositionGuardBacktestSkipReason, number> {
  return {
    BELOW_MINIMUM_TRADE_VALUE: 0,
    INSUFFICIENT_CASH: 0,
    NO_POSITION: 0,
  };
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatCounts<T extends string>(counts: Record<T, number>, order: readonly T[]): string {
  return order.map((key) => `${key}=${counts[key] ?? 0}`).join(" ");
}

function formatTradeDiagnostics(diagnostics: PositionGuardBacktestTradeDiagnostics): string {
  return [
    "trade_diagnostics:",
    `sell_trades=${diagnostics.sellTradeCount}`,
    `sell_win_rate_pct=${formatPercentRatio(diagnostics.sellWinRatePct)}`,
    `avg_realized_pnl_krw=${formatMoney(diagnostics.averageRealizedPnlKrw)}`,
    `avg_win_krw=${formatMoney(diagnostics.averageWinKrw)}`,
    `avg_loss_krw=${formatMoney(diagnostics.averageLossKrw)}`,
    `profit_factor=${diagnostics.profitFactor === null ? "none" : diagnostics.profitFactor.toFixed(4)}`,
    `completed_positions=${diagnostics.completedPositionCount}`,
    `avg_completed_hold_frames=${diagnostics.averageCompletedHoldFrames === null ? "none" : diagnostics.averageCompletedHoldFrames.toFixed(4)}`,
  ].join(" ");
}

function formatMoney(value: number): string {
  return value.toFixed(6);
}

function formatPercentRatio(value: number): string {
  return (value * 100).toFixed(4);
}

function roundMoney(value: number): number {
  return Number(value.toFixed(6));
}

function roundRatio(value: number): number {
  return Number(value.toFixed(6));
}

function toUtcMs(value: string): number | null {
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
}
