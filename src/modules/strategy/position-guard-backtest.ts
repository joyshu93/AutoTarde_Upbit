import type { StrategyDecisionAction, SupportedAsset, SupportedMarket } from "../../domain/types.js";
import {
  DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
  decidePositionGuardCore,
  type PositionGuardEngineDecision,
  type PositionGuardStrategyContext,
  type PositionGuardStrategySettings,
  type PositionGuardStructureAnalysis,
  type PreviousPositionGuardDecision,
  type StrategyMarketRegime,
} from "./position-guard-core.js";
import type { SupportedStrategyTimeframe } from "./market-structure.js";

export interface PositionGuardBacktestFrame {
  generatedAt: string;
  analysis: PositionGuardStructureAnalysis;
  source?: {
    candleCounts: Record<SupportedStrategyTimeframe, number>;
    latestCloseTime: Record<SupportedStrategyTimeframe, string | null>;
  };
}

export interface PositionGuardBacktestExecutionModel {
  feeRate: number;
  slippageRate: number;
  minimumTradeValueKrw: number;
}

export interface PositionGuardBacktestInput {
  asset: SupportedAsset;
  market: SupportedMarket;
  initialCashKrw: number;
  initialQuantity: number;
  initialAverageEntryPrice: number;
  frames: readonly PositionGuardBacktestFrame[];
  settings?: PositionGuardStrategySettings;
  execution?: PositionGuardBacktestExecutionModel;
  researchExecutionPolicy?: PositionGuardBacktestResearchExecutionPolicy;
}

export interface PositionGuardBacktestResearchExecutionPolicy {
  id: "NO_ADD";
  suppressedActions: readonly ["ADD"] | readonly "ADD"[];
}

export interface PositionGuardBacktestResearchSuppression {
  policyId: PositionGuardBacktestResearchExecutionPolicy["id"];
  originalAction: "ADD";
  reason: "ACTION_SUPPRESSED";
}

export interface PositionGuardBacktestState {
  cashKrw: number;
  quantity: number;
  averageEntryPrice: number;
}

export type PositionGuardBacktestSkipReason =
  | "BELOW_MINIMUM_TRADE_VALUE"
  | "INSUFFICIENT_CASH"
  | "NO_POSITION";

export interface PositionGuardBacktestTrade {
  action: Extract<StrategyDecisionAction, "ENTER" | "ADD" | "REDUCE" | "EXIT">;
  side: "bid" | "ask";
  price: number;
  quantity: number;
  grossNotionalKrw: number;
  feeKrw: number;
  realizedPnlKrw: number;
}

export interface PositionGuardBacktestFrameResult {
  generatedAt: string;
  regime: StrategyMarketRegime;
  source?: PositionGuardBacktestFrame["source"];
  decision: PositionGuardEngineDecision;
  startingState: PositionGuardBacktestState;
  endingState: PositionGuardBacktestState;
  executed: boolean;
  trade: PositionGuardBacktestTrade | null;
  skipReason: PositionGuardBacktestSkipReason | null;
  equityKrw: number;
  drawdownPct: number;
  researchSuppression?: PositionGuardBacktestResearchSuppression | null;
}

export interface PositionGuardBacktestMetrics {
  actionCounts: Record<StrategyDecisionAction, number>;
  regimeCounts: Record<StrategyMarketRegime, number>;
  tradeCount: number;
  skippedOrderCount: number;
  turnoverKrw: number;
  feesKrw: number;
  realizedPnlKrw: number;
  finalEquityKrw: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  timeInMarketFrames: number;
}

export interface PositionGuardBacktestResult {
  frames: PositionGuardBacktestFrameResult[];
  metrics: PositionGuardBacktestMetrics;
  finalState: PositionGuardBacktestState;
}

const DEFAULT_BACKTEST_EXECUTION: PositionGuardBacktestExecutionModel = {
  feeRate: 0.0005,
  slippageRate: 0,
  minimumTradeValueKrw: DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS.minimumTradeValueKrw,
};

export function runPositionGuardBacktest(input: PositionGuardBacktestInput): PositionGuardBacktestResult {
  const settings = input.settings ?? DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS;
  const execution = input.execution ?? DEFAULT_BACKTEST_EXECUTION;
  const researchExecutionPolicy = validateResearchExecutionPolicy(input.researchExecutionPolicy);
  let state: PositionGuardBacktestState = {
    cashKrw: input.initialCashKrw,
    quantity: input.initialQuantity,
    averageEntryPrice: input.initialAverageEntryPrice,
  };
  let latestDecision: PreviousPositionGuardDecision | null = null;
  const initialEquity = getInitialEquity(input, state);
  let peakEquity = initialEquity;
  const metrics: PositionGuardBacktestMetrics = {
    actionCounts: createActionCounts(),
    regimeCounts: createRegimeCounts(),
    tradeCount: 0,
    skippedOrderCount: 0,
    turnoverKrw: 0,
    feesKrw: 0,
    realizedPnlKrw: 0,
    finalEquityKrw: initialEquity,
    totalReturnPct: 0,
    maxDrawdownPct: 0,
    timeInMarketFrames: 0,
  };
  const results: PositionGuardBacktestFrameResult[] = [];

  for (const frame of input.frames) {
    const startingState = cloneState(state);
    const context = buildContext({
      input,
      frame,
      state,
      settings,
      latestDecision,
    });
    const decision = decidePositionGuardCore(context);
    const researchSuppression = getResearchSuppression(researchExecutionPolicy, decision.action);
    const executionResult = researchSuppression
      ? { state: cloneState(state), trade: null, skipReason: null }
      : applyDecision({
          decision,
          state,
          execution,
          minimumTradeValueKrw: Math.max(execution.minimumTradeValueKrw, settings.minimumTradeValueKrw),
        });
    state = executionResult.state;
    const equity = getEquity(state, frame.analysis.currentPrice);
    peakEquity = Math.max(peakEquity, equity);
    const drawdownPct = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;

    metrics.actionCounts[decision.action] += 1;
    metrics.regimeCounts[frame.analysis.regime] += 1;
    metrics.finalEquityKrw = equity;
    metrics.maxDrawdownPct = Math.max(metrics.maxDrawdownPct, drawdownPct);
    if (state.quantity > 0) {
      metrics.timeInMarketFrames += 1;
    }
    if (executionResult.trade) {
      metrics.tradeCount += 1;
      metrics.turnoverKrw += executionResult.trade.grossNotionalKrw;
      metrics.feesKrw += executionResult.trade.feeKrw;
      metrics.realizedPnlKrw += executionResult.trade.realizedPnlKrw;
    } else if (executionResult.skipReason) {
      metrics.skippedOrderCount += 1;
    }

    results.push({
      generatedAt: frame.generatedAt,
      regime: frame.analysis.regime,
      source: frame.source,
      decision,
      startingState,
      endingState: cloneState(state),
      executed: executionResult.trade !== null,
      trade: executionResult.trade,
      skipReason: executionResult.skipReason,
      equityKrw: roundMoney(equity),
      drawdownPct,
      ...(researchExecutionPolicy ? { researchSuppression } : {}),
    });

    latestDecision = {
      action: decision.action,
      executionDisposition: decision.executionDisposition,
      entryPath: decision.diagnostics.entryPath,
      qualityBucket: decision.signalQuality.bucket,
      createdAt: frame.generatedAt,
    };
  }

  metrics.finalEquityKrw = roundMoney(metrics.finalEquityKrw);
  metrics.totalReturnPct = initialEquity > 0 ? (metrics.finalEquityKrw - initialEquity) / initialEquity : 0;
  metrics.turnoverKrw = roundMoney(metrics.turnoverKrw);
  metrics.feesKrw = roundMoney(metrics.feesKrw);
  metrics.realizedPnlKrw = roundMoney(metrics.realizedPnlKrw);

  return {
    frames: results,
    metrics,
    finalState: cloneState(state),
  };
}

function validateResearchExecutionPolicy(
  policy: PositionGuardBacktestResearchExecutionPolicy | undefined,
): PositionGuardBacktestResearchExecutionPolicy | undefined {
  if (!policy) return undefined;
  if (
    policy.id !== "NO_ADD" ||
    policy.suppressedActions.length !== 1 ||
    policy.suppressedActions[0] !== "ADD"
  ) {
    throw new Error("NO_ADD research execution policy may only suppress ADD.");
  }
  return policy;
}

function getResearchSuppression(
  policy: PositionGuardBacktestResearchExecutionPolicy | undefined,
  action: StrategyDecisionAction,
): PositionGuardBacktestResearchSuppression | null {
  if (!policy || action !== "ADD") return null;
  return {
    policyId: policy.id,
    originalAction: action,
    reason: "ACTION_SUPPRESSED",
  };
}

function buildContext(input: {
  input: PositionGuardBacktestInput;
  frame: PositionGuardBacktestFrame;
  state: PositionGuardBacktestState;
  settings: PositionGuardStrategySettings;
  latestDecision: PreviousPositionGuardDecision | null;
}): PositionGuardStrategyContext {
  const { frame, state } = input;
  const currentPrice = frame.analysis.currentPrice;
  const assetMarketValueKrw = state.quantity * currentPrice;
  const totalEquityKrw = state.cashKrw + assetMarketValueKrw;
  const averageEntryPrice = state.quantity > 0 ? state.averageEntryPrice : 0;
  const analysis: PositionGuardStructureAnalysis = {
    ...frame.analysis,
    averageEntryPrice,
    pnlPct: averageEntryPrice > 0 ? (currentPrice - averageEntryPrice) / averageEntryPrice : 0,
  };

  return {
    asset: input.input.asset,
    market: input.input.market,
    generatedAt: frame.generatedAt,
    availableKrw: state.cashKrw,
    positionQuantity: state.quantity,
    averageEntryPrice,
    portfolio: {
      totalEquityKrw,
      assetMarketValueKrw,
      totalExposureKrw: assetMarketValueKrw,
    },
    latestDecision: input.latestDecision,
    recentExit: {
      createdAt: null,
      hoursSinceExit: null,
      realizedPnl: null,
    },
    settings: input.settings,
    analysis,
  };
}

function applyDecision(input: {
  decision: PositionGuardEngineDecision;
  state: PositionGuardBacktestState;
  execution: PositionGuardBacktestExecutionModel;
  minimumTradeValueKrw: number;
}): {
  state: PositionGuardBacktestState;
  trade: PositionGuardBacktestTrade | null;
  skipReason: PositionGuardBacktestSkipReason | null;
} {
  if (input.decision.executionDisposition === "DEFERRED_CONFIRMATION") {
    return {
      state: cloneState(input.state),
      trade: null,
      skipReason: null,
    };
  }

  switch (input.decision.action) {
    case "ENTER":
    case "ADD":
      return applyBuy(input);
    case "REDUCE":
    case "EXIT":
      return applySell(input);
    case "HOLD":
    default:
      return {
        state: cloneState(input.state),
        trade: null,
        skipReason: null,
      };
  }
}

function applyBuy(input: {
  decision: PositionGuardEngineDecision;
  state: PositionGuardBacktestState;
  execution: PositionGuardBacktestExecutionModel;
  minimumTradeValueKrw: number;
}): {
  state: PositionGuardBacktestState;
  trade: PositionGuardBacktestTrade | null;
  skipReason: PositionGuardBacktestSkipReason | null;
} {
  const targetNotional = Math.max(0, input.decision.targetNotionalKrw);
  if (targetNotional < input.minimumTradeValueKrw) {
    return { state: cloneState(input.state), trade: null, skipReason: "BELOW_MINIMUM_TRADE_VALUE" };
  }

  const grossNotional = Math.min(targetNotional, input.state.cashKrw / (1 + input.execution.feeRate));
  if (grossNotional < input.minimumTradeValueKrw) {
    return { state: cloneState(input.state), trade: null, skipReason: "INSUFFICIENT_CASH" };
  }

  const price = input.decision.referencePrice * (1 + input.execution.slippageRate);
  const quantity = grossNotional / price;
  const feeKrw = grossNotional * input.execution.feeRate;
  const previousCost = input.state.averageEntryPrice * input.state.quantity;
  const nextQuantity = input.state.quantity + quantity;
  const nextAverageEntryPrice = nextQuantity > 0 ? (previousCost + grossNotional) / nextQuantity : 0;
  const action = input.decision.action === "ADD" ? "ADD" : "ENTER";
  const nextState = {
    cashKrw: roundMoney(input.state.cashKrw - grossNotional - feeKrw),
    quantity: roundQuantity(nextQuantity),
    averageEntryPrice: roundMoney(nextAverageEntryPrice),
  };

  return {
    state: nextState,
    trade: {
      action,
      side: "bid",
      price: roundMoney(price),
      quantity: roundQuantity(quantity),
      grossNotionalKrw: roundMoney(grossNotional),
      feeKrw: roundMoney(feeKrw),
      realizedPnlKrw: 0,
    },
    skipReason: null,
  };
}

function applySell(input: {
  decision: PositionGuardEngineDecision;
  state: PositionGuardBacktestState;
  execution: PositionGuardBacktestExecutionModel;
  minimumTradeValueKrw: number;
}): {
  state: PositionGuardBacktestState;
  trade: PositionGuardBacktestTrade | null;
  skipReason: PositionGuardBacktestSkipReason | null;
} {
  if (input.state.quantity <= 0) {
    return { state: cloneState(input.state), trade: null, skipReason: "NO_POSITION" };
  }

  const requestedFraction = input.decision.targetQuantityFraction ?? 0;
  const quantity = input.decision.action === "EXIT"
    ? input.state.quantity
    : input.state.quantity * requestedFraction;
  const sellQuantity = Math.min(input.state.quantity, Math.max(0, quantity));
  const price = input.decision.referencePrice * (1 - input.execution.slippageRate);
  const grossNotional = sellQuantity * price;
  if (grossNotional < input.minimumTradeValueKrw) {
    return { state: cloneState(input.state), trade: null, skipReason: "BELOW_MINIMUM_TRADE_VALUE" };
  }

  const feeKrw = grossNotional * input.execution.feeRate;
  const proceeds = grossNotional - feeKrw;
  const costBasis = sellQuantity * input.state.averageEntryPrice;
  const nextQuantity = Math.max(0, input.state.quantity - sellQuantity);
  const action = input.decision.action === "EXIT" ? "EXIT" : "REDUCE";
  const nextState = {
    cashKrw: roundMoney(input.state.cashKrw + proceeds),
    quantity: roundQuantity(nextQuantity),
    averageEntryPrice: nextQuantity > 0 ? input.state.averageEntryPrice : 0,
  };

  return {
    state: nextState,
    trade: {
      action,
      side: "ask",
      price: roundMoney(price),
      quantity: roundQuantity(sellQuantity),
      grossNotionalKrw: roundMoney(grossNotional),
      feeKrw: roundMoney(feeKrw),
      realizedPnlKrw: roundMoney(proceeds - costBasis),
    },
    skipReason: null,
  };
}

function getInitialEquity(input: PositionGuardBacktestInput, state: PositionGuardBacktestState): number {
  const firstFramePrice = input.frames[0]?.analysis.currentPrice;
  const markPrice = firstFramePrice ?? state.averageEntryPrice;
  return getEquity(state, markPrice);
}

function getEquity(state: PositionGuardBacktestState, currentPrice: number): number {
  return state.cashKrw + state.quantity * currentPrice;
}

function cloneState(state: PositionGuardBacktestState): PositionGuardBacktestState {
  return {
    cashKrw: roundMoney(state.cashKrw),
    quantity: roundQuantity(state.quantity),
    averageEntryPrice: roundMoney(state.averageEntryPrice),
  };
}

function createActionCounts(): Record<StrategyDecisionAction, number> {
  return {
    ENTER: 0,
    ADD: 0,
    REDUCE: 0,
    EXIT: 0,
    HOLD: 0,
  };
}

function createRegimeCounts(): Record<StrategyMarketRegime, number> {
  return {
    BULL_TREND: 0,
    PULLBACK_IN_UPTREND: 0,
    EARLY_RECOVERY: 0,
    RECLAIM_ATTEMPT: 0,
    RANGE: 0,
    WEAK_DOWNTREND: 0,
    BREAKDOWN_RISK: 0,
  };
}

function roundMoney(value: number): number {
  return Number(value.toFixed(6));
}

function roundQuantity(value: number): number {
  return Number(value.toFixed(12));
}
