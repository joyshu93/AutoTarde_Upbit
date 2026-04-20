export type TimestampMs = number;
export type NumericString = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type UserStatus = 'active' | 'disabled';
export type ExecutionMode = 'live' | 'paper';
export type AccountStatus = 'active' | 'paused' | 'revoked' | 'paper';
export type DecisionType = 'buy' | 'sell' | 'hold' | 'cancel' | 'reduce' | 'flatten';
export type DecisionStatus =
  | 'pending'
  | 'approved'
  | 'superseded'
  | 'rejected'
  | 'executed'
  | 'expired';
export type PositionEffect = 'open' | 'close' | 'increase' | 'decrease' | 'none';
export type SnapshotSource = 'poll' | 'websocket' | 'reconciliation' | 'recovery' | 'operator';
export type PositionSide = 'long' | 'short' | 'flat';
export type PositionState = 'open' | 'closed' | 'liquidated';
export type OrderType = 'market' | 'limit' | 'stop_market' | 'stop_limit';
export type OrderSide = 'buy' | 'sell';
export type OrderTimeInForce = 'gtc' | 'ioc' | 'fok' | 'post_only';
export type OrderState =
  | 'created'
  | 'submission_pending'
  | 'submitted'
  | 'partially_filled'
  | 'filled'
  | 'cancel_pending'
  | 'cancelled'
  | 'rejected'
  | 'expired'
  | 'failed';
export type OrderSource = 'strategy' | 'recovery' | 'operator' | 'reconciliation';
export type OrderEventSource =
  | 'local'
  | 'exchange_poll'
  | 'exchange_websocket'
  | 'reconciliation'
  | 'recovery'
  | 'operator';
export type OrderEventType =
  | 'created'
  | 'submission_requested'
  | 'submission_accepted'
  | 'submission_rejected'
  | 'status_synced'
  | 'fill_recorded'
  | 'cancel_requested'
  | 'cancel_accepted'
  | 'cancel_rejected'
  | 'completed'
  | 'error'
  | 'operator_note';
export type LiquidityRole = 'maker' | 'taker' | 'unknown';
export type ReconciliationRunType =
  | 'startup_recovery'
  | 'scheduled'
  | 'manual'
  | 'post_order'
  | 'backfill';
export type ReconciliationTrigger = 'system' | 'operator' | 'risk' | 'schedule';
export type ReconciliationStatus =
  | 'running'
  | 'completed'
  | 'completed_with_drift'
  | 'failed'
  | 'aborted';
export type RiskSeverity = 'info' | 'warning' | 'critical';
export type RiskStatus = 'open' | 'acknowledged' | 'suppressed' | 'resolved';
export type ExecutionScopeType = 'system' | 'exchange_account' | 'market' | 'order' | 'strategy';
export type IdempotencyStatus = 'in_progress' | 'completed' | 'failed' | 'expired';
export type OperatorActionTargetType =
  | 'system'
  | 'exchange_account'
  | 'market'
  | 'order'
  | 'strategy_decision'
  | 'risk_event';
export type OperatorActionType =
  | 'pause_trading'
  | 'resume_trading'
  | 'cancel_order'
  | 'retry_submission'
  | 'flatten_position'
  | 'ack_risk'
  | 'resolve_risk'
  | 'force_reconcile'
  | 'set_state';
export type OperatorActionStatus =
  | 'requested'
  | 'approved'
  | 'applied'
  | 'rejected'
  | 'failed'
  | 'cancelled';

export interface UserRecord {
  id: string;
  externalRef: string | null;
  displayName: string;
  status: UserStatus;
  timezone: string;
  createdAtMs: TimestampMs;
  updatedAtMs: TimestampMs;
}

export interface ExchangeAccountRecord {
  id: string;
  userId: string;
  venue: string;
  accountLabel: string;
  baseCurrency: string;
  accessKeyRef: string;
  secretKeyRef: string;
  passphraseRef: string | null;
  executionMode: ExecutionMode;
  accountStatus: AccountStatus;
  canTrade: boolean;
  canWithdraw: boolean;
  lastConnectedAtMs: TimestampMs | null;
  lastReconciledAtMs: TimestampMs | null;
  createdAtMs: TimestampMs;
  updatedAtMs: TimestampMs;
}

export interface StrategyDecisionRecord {
  id: string;
  exchangeAccountId: string;
  strategyName: string;
  strategyVersion: string;
  marketSymbol: string;
  timeframe: string | null;
  decisionType: DecisionType;
  side: OrderSide | null;
  positionEffect: PositionEffect;
  decisionStatus: DecisionStatus;
  decisionKey: string;
  requestedQuantity: NumericString | null;
  requestedNotional: NumericString | null;
  limitPrice: NumericString | null;
  stopPrice: NumericString | null;
  riskBudget: NumericString | null;
  rationale: JsonValue | null;
  marketSnapshot: JsonValue | null;
  expiresAtMs: TimestampMs | null;
  decidedAtMs: TimestampMs;
  createdAtMs: TimestampMs;
  updatedAtMs: TimestampMs;
}

export interface BalanceSnapshotRecord {
  id: string;
  exchangeAccountId: string;
  captureId: string;
  source: SnapshotSource;
  assetSymbol: string;
  availableAmount: NumericString;
  lockedAmount: NumericString;
  totalAmount: NumericString;
  valueInBaseCurrency: NumericString | null;
  capturedAtMs: TimestampMs;
  createdAtMs: TimestampMs;
}

export interface PositionSnapshotRecord {
  id: string;
  exchangeAccountId: string;
  captureId: string;
  source: SnapshotSource;
  marketSymbol: string;
  side: PositionSide;
  quantity: NumericString;
  averageEntryPrice: NumericString | null;
  markPrice: NumericString | null;
  unrealizedPnl: NumericString | null;
  realizedPnl: NumericString | null;
  positionState: PositionState;
  capturedAtMs: TimestampMs;
  createdAtMs: TimestampMs;
}

export interface OrderRecord {
  id: string;
  exchangeAccountId: string;
  strategyDecisionId: string | null;
  operatorActionId: string | null;
  clientOrderId: string;
  venueOrderId: string | null;
  idempotencyKey: string;
  marketSymbol: string;
  orderType: OrderType;
  side: OrderSide;
  timeInForce: OrderTimeInForce | null;
  postOnly: boolean;
  reduceOnly: boolean;
  requestedQuantity: NumericString | null;
  requestedNotional: NumericString | null;
  limitPrice: NumericString | null;
  stopPrice: NumericString | null;
  executedQuantity: NumericString;
  cumulativeQuoteAmount: NumericString;
  averageFillPrice: NumericString | null;
  state: OrderState;
  stateReasonCode: string | null;
  source: OrderSource;
  submittedAtMs: TimestampMs | null;
  lastEventAtMs: TimestampMs | null;
  terminalAtMs: TimestampMs | null;
  createdAtMs: TimestampMs;
  updatedAtMs: TimestampMs;
}

export interface OrderEventRecord {
  id: string;
  orderId: string;
  exchangeAccountId: string;
  source: OrderEventSource;
  eventType: OrderEventType;
  sourceEventId: string | null;
  idempotencyKey: string | null;
  previousState: OrderState | null;
  newState: OrderState | null;
  eventPayload: JsonValue | null;
  occurredAtMs: TimestampMs;
  createdAtMs: TimestampMs;
}

export interface FillRecord {
  id: string;
  orderId: string;
  orderEventId: string | null;
  exchangeAccountId: string;
  venueFillId: string;
  venueTradeId: string | null;
  side: OrderSide;
  marketSymbol: string;
  fillPrice: NumericString;
  fillQuantity: NumericString;
  quoteQuantity: NumericString | null;
  feeAmount: NumericString | null;
  feeAssetSymbol: string | null;
  liquidityRole: LiquidityRole;
  occurredAtMs: TimestampMs;
  createdAtMs: TimestampMs;
}

export interface ReconciliationRunRecord {
  id: string;
  exchangeAccountId: string;
  runType: ReconciliationRunType;
  triggerSource: ReconciliationTrigger;
  status: ReconciliationStatus;
  startedAtMs: TimestampMs;
  finishedAtMs: TimestampMs | null;
  watermarkStartMs: TimestampMs | null;
  watermarkEndMs: TimestampMs | null;
  driftDetected: boolean;
  actionsTaken: JsonValue | null;
  summary: JsonValue | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAtMs: TimestampMs;
  updatedAtMs: TimestampMs;
}

export interface RiskEventRecord {
  id: string;
  exchangeAccountId: string;
  orderId: string | null;
  strategyDecisionId: string | null;
  reconciliationRunId: string | null;
  severity: RiskSeverity;
  eventType: string;
  dedupeKey: string;
  status: RiskStatus;
  message: string;
  eventPayload: JsonValue | null;
  detectedAtMs: TimestampMs;
  acknowledgedAtMs: TimestampMs | null;
  resolvedAtMs: TimestampMs | null;
  createdAtMs: TimestampMs;
  updatedAtMs: TimestampMs;
}

export interface ExecutionStateRecord {
  scopeType: ExecutionScopeType;
  scopeId: string;
  stateKey: string;
  version: number;
  state: JsonValue;
  leaseOwner: string | null;
  leaseExpiresAtMs: TimestampMs | null;
  lastHeartbeatAtMs: TimestampMs | null;
  createdAtMs: TimestampMs;
  updatedAtMs: TimestampMs;
}

export interface IdempotencyKeyRecord {
  scope: string;
  idempotencyKey: string;
  requestHash: string;
  status: IdempotencyStatus;
  resourceType: string | null;
  resourceId: string | null;
  responsePayload: JsonValue | null;
  firstSeenAtMs: TimestampMs;
  lastTouchedAtMs: TimestampMs;
  expiresAtMs: TimestampMs | null;
}

export interface OperatorActionRecord {
  id: string;
  exchangeAccountId: string | null;
  targetType: OperatorActionTargetType;
  targetId: string | null;
  actionType: OperatorActionType;
  requestedByUserId: string;
  requestIdempotencyKey: string;
  status: OperatorActionStatus;
  reason: string | null;
  commandPayload: JsonValue | null;
  resultPayload: JsonValue | null;
  requestedAtMs: TimestampMs;
  appliedAtMs: TimestampMs | null;
  createdAtMs: TimestampMs;
  updatedAtMs: TimestampMs;
}

export interface ExecutionStateKey {
  scopeType: ExecutionScopeType;
  scopeId: string;
  stateKey: string;
}

export interface ResourcePointer {
  resourceType: string;
  resourceId: string;
}
