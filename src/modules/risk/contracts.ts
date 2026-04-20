import type {
  DecimalString,
  UpbitBalance,
  UpbitOrderChance,
  UpbitOrderReference,
  UpbitSpotMarket,
} from "../exchange/upbit/contracts.js";
import type {
  CancelOrderDecision,
  DeterministicStrategyDecision,
  PlaceOrderDecision,
} from "../strategy/contracts.js";

export const KRW_SPOT_MIN_ORDER_TOTAL = 5000;

export type ExecutionMode = "DRY_RUN" | "LIVE";
export type RiskViolationSeverity = "error" | "warning";
export type RiskViolationCode =
  | "unsupported_market"
  | "non_deterministic_strategy"
  | "llm_strategy_blocked"
  | "discretionary_strategy_blocked"
  | "below_min_order_total"
  | "unsupported_order_type"
  | "unsupported_order_side"
  | "unsupported_time_in_force"
  | "price_unit_mismatch"
  | "insufficient_balance"
  | "market_offline"
  | "missing_order_policy"
  | "missing_order_test_for_live";

export interface RiskPolicySnapshot {
  readonly managedMarkets: readonly UpbitSpotMarket[];
  readonly executionMode: ExecutionMode;
  readonly minimumOrderTotalKrw: number;
  readonly liveRequiresSuccessfulOrderTest: boolean;
  readonly llmEnabled: false;
  readonly discretionary: false;
}

export interface RiskViolation {
  readonly code: RiskViolationCode;
  readonly severity: RiskViolationSeverity;
  readonly message: string;
  readonly market?: UpbitSpotMarket;
}

export interface CreateOrderRiskInput {
  readonly policy: RiskPolicySnapshot;
  readonly decision: PlaceOrderDecision;
  readonly balances: readonly UpbitBalance[];
  readonly orderPolicy?: UpbitOrderChance;
  readonly successfulTestReceiptId?: string;
}

export interface CancelOrderRiskInput {
  readonly policy: RiskPolicySnapshot;
  readonly decision: CancelOrderDecision;
  readonly openOrder?: UpbitOrderReference;
}

export interface RiskEvaluation {
  readonly allowed: boolean;
  readonly decision: DeterministicStrategyDecision;
  readonly violations: readonly RiskViolation[];
  readonly normalizedNotionalKrw?: DecimalString;
}

export interface TradeRiskManager {
  evaluateCreateOrder(input: CreateOrderRiskInput): Promise<RiskEvaluation>;
  evaluateCancelOrder(input: CancelOrderRiskInput): Promise<RiskEvaluation>;
}
