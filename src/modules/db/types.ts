export interface SqliteUserRow {
  id: string;
  telegram_user_id: string;
  telegram_chat_id: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface SqliteExchangeAccountRow {
  id: string;
  user_id: string;
  exchange: "UPBIT";
  venue_type: "SPOT";
  account_label: string;
  access_key_ref: string;
  secret_key_ref: string;
  quote_currency: "KRW";
  is_primary: number;
  created_at: string;
  updated_at: string;
}

export interface SqliteExecutionStateRow {
  id: string;
  exchange_account_id: string;
  execution_mode: "DRY_RUN" | "LIVE";
  live_execution_gate: "DISABLED" | "ENABLED";
  system_status: "BOOTING" | "RUNNING" | "PAUSED" | "KILL_SWITCHED" | "DEGRADED";
  kill_switch_active: number;
  pause_reason: string | null;
  degraded_reason: string | null;
  degraded_at: string | null;
  updated_at: string;
}

export interface SqliteExecutionStateTransitionRow {
  id: string;
  exchange_account_id: string;
  command:
    | "BOOTSTRAP"
    | "/pause"
    | "/resume"
    | "/killswitch"
    | "SET_EXECUTION_MODE"
    | "SET_LIVE_EXECUTION_GATE"
    | "MARK_DEGRADED"
    | "CLEAR_DEGRADED";
  from_execution_mode: "DRY_RUN" | "LIVE" | null;
  to_execution_mode: "DRY_RUN" | "LIVE";
  from_live_execution_gate: "DISABLED" | "ENABLED" | null;
  to_live_execution_gate: "DISABLED" | "ENABLED";
  from_system_status: "BOOTING" | "RUNNING" | "PAUSED" | "KILL_SWITCHED" | "DEGRADED" | null;
  to_system_status: "BOOTING" | "RUNNING" | "PAUSED" | "KILL_SWITCHED" | "DEGRADED";
  from_kill_switch_active: number | null;
  to_kill_switch_active: number;
  reason: string | null;
  created_at: string;
}

export interface SqliteStrategyDecisionRow {
  id: string;
  exchange_account_id: string;
  strategy_key: string;
  market: "KRW-BTC" | "KRW-ETH";
  action: "ENTER" | "ADD" | "REDUCE" | "EXIT" | "HOLD";
  status: "READY" | "BLOCKED_BY_RISK" | "NO_ACTION" | "DATA_STALE";
  decision_basis_json: string;
  intended_notional_krw: string | null;
  intended_quantity: string | null;
  reference_price: string | null;
  created_at: string;
}

export interface SqliteBalanceSnapshotRow {
  id: string;
  exchange_account_id: string;
  captured_at: string;
  source: "EXCHANGE_POLL" | "RECONCILIATION";
  total_krw_value: string | null;
  balances_json: string;
}

export interface SqlitePositionSnapshotRow {
  id: string;
  exchange_account_id: string;
  captured_at: string;
  source: "EXCHANGE_POLL" | "RECONCILIATION";
  positions_json: string;
}

export interface SqliteOrderRow {
  id: string;
  strategy_decision_id: string | null;
  exchange_account_id: string;
  market: "KRW-BTC" | "KRW-ETH";
  side: "bid" | "ask";
  ord_type: "limit" | "price" | "market" | "best";
  volume: string | null;
  price: string | null;
  time_in_force: "ioc" | "fok" | "post_only" | null;
  smp_type: "cancel_maker" | "cancel_taker" | "reduce" | null;
  identifier: string;
  idempotency_key: string;
  origin: "STRATEGY" | "OPERATOR" | "RECOVERY";
  requested_at: string;
  upbit_uuid: string | null;
  status:
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
  execution_mode: "DRY_RUN" | "LIVE";
  exchange_response_json: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface SqliteOrderEventRow {
  id: string;
  order_id: string;
  event_type: string;
  event_source: "LOCAL" | "EXCHANGE" | "RECONCILIATION" | "TELEGRAM";
  payload_json: string;
  created_at: string;
}

export interface SqliteFillRow {
  id: string;
  order_id: string;
  exchange_fill_id: string;
  market: "KRW-BTC" | "KRW-ETH";
  side: "bid" | "ask";
  price: string;
  volume: string;
  fee_currency: string | null;
  fee_amount: string | null;
  filled_at: string;
  raw_payload_json: string;
}

export interface SqliteReconciliationRunRow {
  id: string;
  exchange_account_id: string;
  status: "SUCCESS" | "DRIFT_DETECTED" | "ERROR";
  started_at: string;
  completed_at: string | null;
  summary_json: string;
  error_message: string | null;
}

export interface SqliteOperatorNotificationRow {
  id: string;
  exchange_account_id: string;
  channel: "TELEGRAM";
  notification_type: "ORDER_REJECTED" | "ORDER_SUBMISSION_FAILED" | "RECONCILIATION_DRIFT_DETECTED" | "SYNC_FAILED";
  severity: "INFO" | "WARN" | "ERROR";
  title: string;
  message: string;
  payload_json: string;
  delivery_status: "PENDING" | "SENT" | "FAILED";
  attempt_count: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  failure_class: "RETRYABLE" | "PERMANENT" | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  delivered_at: string | null;
  last_error: string | null;
}

export interface SqliteOperatorNotificationDeliveryAttemptRow {
  id: string;
  notification_id: string;
  exchange_account_id: string;
  attempt_count: number;
  lease_token: string | null;
  outcome: "SENT" | "RETRY_SCHEDULED" | "FAILED" | "STALE_LEASE";
  failure_class: "RETRYABLE" | "PERMANENT" | null;
  attempted_at: string;
  next_attempt_at: string | null;
  delivered_at: string | null;
  error_message: string | null;
  created_at: string;
}

export interface SqliteRiskEventRow {
  id: string;
  exchange_account_id: string;
  strategy_decision_id: string | null;
  order_id: string | null;
  level: "INFO" | "WARN" | "BLOCK";
  rule_code:
    | "GLOBAL_KILL_SWITCH"
    | "EXECUTION_PAUSED"
    | "SYSTEM_DEGRADED"
    | "PER_ASSET_MAX_ALLOCATION"
    | "TOTAL_EXPOSURE_CAP"
    | "STALE_PRICE_GUARD"
    | "DUPLICATE_ORDER_GUARD"
    | "MINIMUM_ORDER_VALUE_GUARD"
    | "LIVE_EXECUTION_DISABLED"
    | "UNSUPPORTED_MARKET"
    | "UNSUPPORTED_ORDER_TYPE"
    | "EXCHANGE_MIN_TOTAL_GUARD"
    | "EXCHANGE_MAX_TOTAL_GUARD"
    | "MARKET_OFFLINE"
    | "EXCHANGE_ORDER_CHANCE_FAILED"
    | "EXCHANGE_ORDER_TEST_FAILED"
    | "ORDER_RECOVERY_REQUIRED"
    | "BALANCE_DRIFT_DETECTED"
    | "POSITION_DRIFT_DETECTED";
  message: string;
  payload_json: string;
  created_at: string;
}
