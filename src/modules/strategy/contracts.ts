import type {
  DecimalString,
  Iso8601String,
  ManagedSpotAsset,
  UpbitCreateOrderRequest,
  UpbitOrderIdentifier,
  UpbitOrderReference,
  UpbitOrderSide,
  UpbitOrderType,
  UpbitSpotMarket,
  UuidString,
} from "../exchange/upbit/contracts.js";

export const DETERMINISTIC_STRATEGY_PROFILE = {
  mode: "RULE_BASED",
  llmEnabled: false,
  discretionary: false,
} as const;

export type StrategyDecisionMode =
  typeof DETERMINISTIC_STRATEGY_PROFILE.mode;
export type StrategyReasonCode =
  | "hold_no_signal"
  | "entry_signal"
  | "exit_signal"
  | "rebalance_signal"
  | "replace_stale_order"
  | "risk_reduction";

export interface DeterministicStrategyMetadata {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly configurationRevision: string;
  readonly mode: StrategyDecisionMode;
  readonly llmEnabled: false;
  readonly discretionary: false;
  readonly managedMarkets: readonly UpbitSpotMarket[];
}

export interface StrategyBalanceSnapshot {
  readonly currency: ManagedSpotAsset;
  readonly free: DecimalString;
  readonly locked: DecimalString;
  readonly avgBuyPrice?: DecimalString;
}

export interface StrategyMarketSnapshot {
  readonly market: UpbitSpotMarket;
  readonly observedAt: Iso8601String;
  readonly lastTradePrice: DecimalString;
  readonly bestBidPrice: DecimalString;
  readonly bestBidSize: DecimalString;
  readonly bestAskPrice: DecimalString;
  readonly bestAskSize: DecimalString;
}

export interface StrategyOpenOrderSnapshot {
  readonly uuid: UuidString;
  readonly identifier?: UpbitOrderIdentifier;
  readonly market: UpbitSpotMarket;
  readonly side: UpbitOrderSide;
  readonly ordType: UpbitOrderType;
  readonly price: DecimalString | null;
  readonly remainingVolume: DecimalString;
  readonly createdAt: Iso8601String;
}

export interface DeterministicStrategyContext {
  readonly metadata: DeterministicStrategyMetadata;
  readonly market: UpbitSpotMarket;
  readonly now: Iso8601String;
  readonly sequence: string;
  readonly balances: readonly StrategyBalanceSnapshot[];
  readonly marketSnapshot: StrategyMarketSnapshot;
  readonly openOrders: readonly StrategyOpenOrderSnapshot[];
}

export type StrategyOrderInstruction = Omit<
  UpbitCreateOrderRequest["order"],
  "identifier"
> & {
  readonly identifier?: never;
};

export interface StrategyCancelInstruction {
  readonly target: UpbitOrderReference;
}

export interface BaseDeterministicStrategyDecision {
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly configurationRevision: string;
  readonly market: UpbitSpotMarket;
  readonly decidedAt: Iso8601String;
  readonly decisionKey: string;
  readonly inputHash: string;
  readonly mode: StrategyDecisionMode;
  readonly llmEnabled: false;
  readonly discretionary: false;
  readonly reasonCode: StrategyReasonCode;
}

export interface HoldDecision extends BaseDeterministicStrategyDecision {
  readonly action: "HOLD";
}

export interface PlaceOrderDecision extends BaseDeterministicStrategyDecision {
  readonly action: "CREATE_ORDER";
  readonly order: StrategyOrderInstruction;
}

export interface CancelOrderDecision extends BaseDeterministicStrategyDecision {
  readonly action: "CANCEL_ORDER";
  readonly cancel: StrategyCancelInstruction;
}

export type DeterministicStrategyDecision =
  | HoldDecision
  | PlaceOrderDecision
  | CancelOrderDecision;

export interface DeterministicStrategyEngine {
  evaluate(
    context: DeterministicStrategyContext,
  ): Promise<DeterministicStrategyDecision>;
}
