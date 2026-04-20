export const SUPPORTED_ASSETS = ["BTC", "ETH"] as const;
export type SupportedAsset = (typeof SUPPORTED_ASSETS)[number];

export const SUPPORTED_MARKETS = ["KRW-BTC", "KRW-ETH"] as const;
export type SupportedMarket = (typeof SUPPORTED_MARKETS)[number];

export type QuoteCurrency = "KRW";
export type ExchangeName = "UPBIT";
export type VenueType = "SPOT";

export type ExecutionMode = "DRY_RUN" | "LIVE";
export type LiveExecutionGate = "DISABLED" | "ENABLED";
export type SystemStatus = "BOOTING" | "RUNNING" | "PAUSED" | "KILL_SWITCHED" | "DEGRADED";

export type StrategyDecisionAction = "ENTER" | "ADD" | "REDUCE" | "EXIT" | "HOLD";
export type StrategyDecisionStatus = "READY" | "BLOCKED_BY_RISK" | "NO_ACTION" | "DATA_STALE";

export type OrderSide = "bid" | "ask";
export type OrderType = "limit" | "price" | "market" | "best";
export type TimeInForce = "ioc" | "fok" | "post_only";
export type UpbitSelfMatchPrevention = "cancel_maker" | "cancel_taker" | "reduce";

export type OrderLifecycleStatus =
  | "INTENT_CREATED"
  | "RISK_REJECTED"
  | "PERSISTED"
  | "SUBMITTING"
  | "OPEN"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "CANCEL_REQUESTED"
  | "CANCELED"
  | "REJECTED"
  | "FAILED"
  | "RECONCILIATION_REQUIRED";

export type OrderOrigin = "STRATEGY" | "OPERATOR" | "RECOVERY";
export type ReconciliationStatus = "SUCCESS" | "DRIFT_DETECTED" | "ERROR";
export type RiskEventLevel = "INFO" | "WARN" | "BLOCK";
export type RiskRuleCode =
  | "GLOBAL_KILL_SWITCH"
  | "EXECUTION_PAUSED"
  | "PER_ASSET_MAX_ALLOCATION"
  | "TOTAL_EXPOSURE_CAP"
  | "STALE_PRICE_GUARD"
  | "DUPLICATE_ORDER_GUARD"
  | "MINIMUM_ORDER_VALUE_GUARD"
  | "LIVE_EXECUTION_DISABLED"
  | "UNSUPPORTED_MARKET"
  | "ORDER_RECOVERY_REQUIRED";

export interface UserRecord {
  id: string;
  telegramUserId: string;
  telegramChatId: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExchangeAccountRecord {
  id: string;
  userId: string;
  exchange: ExchangeName;
  venueType: VenueType;
  accountLabel: string;
  accessKeyRef: string;
  secretKeyRef: string;
  quoteCurrency: QuoteCurrency;
  isPrimary: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionStateRecord {
  id: string;
  exchangeAccountId: string;
  executionMode: ExecutionMode;
  liveExecutionGate: LiveExecutionGate;
  systemStatus: SystemStatus;
  killSwitchActive: boolean;
  pauseReason: string | null;
  updatedAt: string;
}

export interface ExchangeBalance {
  currency: string;
  balance: string;
  locked: string;
  avgBuyPrice: string;
  unitCurrency: string;
}

export interface BalanceSnapshotRecord {
  id: string;
  exchangeAccountId: string;
  capturedAt: string;
  source: "EXCHANGE_POLL" | "RECONCILIATION";
  totalKrwValue: string | null;
  balancesJson: string;
}

export interface PositionSnapshot {
  asset: SupportedAsset;
  market: SupportedMarket;
  quantity: string;
  averageEntryPrice: string | null;
  markPrice: string | null;
  marketValue: string | null;
  exposureRatio: string | null;
  capturedAt: string;
}

export interface PositionSnapshotRecord {
  id: string;
  exchangeAccountId: string;
  capturedAt: string;
  source: "EXCHANGE_POLL" | "RECONCILIATION";
  positionsJson: string;
}

export interface StrategyDecisionRecord {
  id: string;
  exchangeAccountId: string;
  strategyKey: string;
  market: SupportedMarket;
  action: StrategyDecisionAction;
  status: StrategyDecisionStatus;
  decisionBasisJson: string;
  intendedNotionalKrw: string | null;
  intendedQuantity: string | null;
  referencePrice: string | null;
  createdAt: string;
}

export interface OrderIntent {
  strategyDecisionId: string | null;
  exchangeAccountId: string;
  market: SupportedMarket;
  side: OrderSide;
  ordType: OrderType;
  volume: string | null;
  price: string | null;
  timeInForce: TimeInForce | null;
  smpType: UpbitSelfMatchPrevention | null;
  identifier: string;
  idempotencyKey: string;
  origin: OrderOrigin;
  requestedAt: string;
}

export interface OrderRecord extends OrderIntent {
  id: string;
  upbitUuid: string | null;
  status: OrderLifecycleStatus;
  executionMode: ExecutionMode;
  exchangeResponseJson: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderEventRecord {
  id: string;
  orderId: string;
  eventType: string;
  eventSource: "LOCAL" | "EXCHANGE" | "RECONCILIATION" | "TELEGRAM";
  payloadJson: string;
  createdAt: string;
}

export interface FillRecord {
  id: string;
  orderId: string;
  exchangeFillId: string;
  market: SupportedMarket;
  side: OrderSide;
  price: string;
  volume: string;
  feeCurrency: string | null;
  feeAmount: string | null;
  filledAt: string;
  rawPayloadJson: string;
}

export interface ReconciliationRunRecord {
  id: string;
  exchangeAccountId: string;
  status: ReconciliationStatus;
  startedAt: string;
  completedAt: string | null;
  summaryJson: string;
  errorMessage: string | null;
}

export interface RiskEventRecord {
  id: string;
  exchangeAccountId: string;
  strategyDecisionId: string | null;
  orderId: string | null;
  level: RiskEventLevel;
  ruleCode: RiskRuleCode;
  message: string;
  payloadJson: string;
  createdAt: string;
}

export interface ExecutionPolicy {
  executionMode: ExecutionMode;
  liveExecutionGate: LiveExecutionGate;
  globalKillSwitch: boolean;
  maxAllocationByAsset: Record<SupportedAsset, number>;
  totalExposureCap: number;
  stalePriceThresholdMs: number;
  minimumOrderValueKrw: number;
}

export interface PriceSnapshot {
  market: SupportedMarket;
  tradePrice: number;
  capturedAt: string;
}

export interface PortfolioExposureSnapshot {
  totalEquityKrw: number;
  totalExposureKrw: number;
  assetExposureKrw: Record<SupportedAsset, number>;
}

export interface StrategyDecision {
  strategyKey: string;
  market: SupportedMarket;
  action: StrategyDecisionAction;
  reasonCodes: string[];
  referencePrice: number;
  requestedNotionalKrw: number | null;
  requestedQuantity: number | null;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RiskEvaluationContext {
  policy: ExecutionPolicy;
  systemStatus: SystemStatus;
  market: SupportedMarket;
  priceSnapshot: PriceSnapshot | null;
  portfolio: PortfolioExposureSnapshot;
  openOrders: Pick<OrderRecord, "market" | "side" | "ordType" | "price" | "volume" | "status" | "identifier" | "idempotencyKey">[];
  requestedSide: OrderSide;
  requestedIdempotencyKey: string;
  requestedPrice: string | null;
  requestedVolume: string | null;
  requestedNotionalKrw: number | null;
  requestedQuantity: number | null;
  now: string;
}

export interface RiskEvaluationResult {
  accepted: boolean;
  triggeredRules: Array<{
    code: RiskRuleCode;
    level: RiskEventLevel;
    message: string;
  }>;
}

export interface OperatorCommand {
  command:
    | "/status"
    | "/balances"
    | "/positions"
    | "/orders"
    | "/pause"
    | "/resume"
    | "/killswitch"
    | "/sync";
  args: string[];
}

export function getMarketForAsset(asset: SupportedAsset): SupportedMarket {
  return asset === "BTC" ? "KRW-BTC" : "KRW-ETH";
}

export function getAssetForMarket(market: SupportedMarket): SupportedAsset {
  return market === "KRW-BTC" ? "BTC" : "ETH";
}
