PRAGMA foreign_keys = ON;

BEGIN TRANSACTION;

-- Numeric amounts/prices are stored as TEXT to avoid SQLite float drift.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  external_ref TEXT,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (external_ref)
);

CREATE TABLE IF NOT EXISTS exchange_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  venue TEXT NOT NULL,
  account_label TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  access_key_ref TEXT NOT NULL,
  secret_key_ref TEXT NOT NULL,
  passphrase_ref TEXT,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('live', 'paper')),
  account_status TEXT NOT NULL CHECK (account_status IN ('active', 'paused', 'revoked', 'paper')),
  can_trade INTEGER NOT NULL CHECK (can_trade IN (0, 1)),
  can_withdraw INTEGER NOT NULL CHECK (can_withdraw IN (0, 1)),
  last_connected_at_ms INTEGER,
  last_reconciled_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (user_id, venue, account_label)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'expired')),
  resource_type TEXT,
  resource_id TEXT,
  response_payload_json TEXT,
  first_seen_at_ms INTEGER NOT NULL,
  last_touched_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS execution_state (
  scope_type TEXT NOT NULL CHECK (scope_type IN ('system', 'exchange_account', 'market', 'order', 'strategy')),
  scope_id TEXT NOT NULL,
  state_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  last_heartbeat_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_type, scope_id, state_key)
);

CREATE TABLE IF NOT EXISTS operator_actions (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  target_type TEXT NOT NULL CHECK (target_type IN ('system', 'exchange_account', 'market', 'order', 'strategy_decision', 'risk_event')),
  target_id TEXT,
  action_type TEXT NOT NULL CHECK (action_type IN ('pause_trading', 'resume_trading', 'cancel_order', 'retry_submission', 'flatten_position', 'ack_risk', 'resolve_risk', 'force_reconcile', 'set_state')),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'approved', 'applied', 'rejected', 'failed', 'cancelled')),
  reason TEXT,
  command_payload_json TEXT,
  result_payload_json TEXT,
  requested_at_ms INTEGER NOT NULL,
  applied_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  UNIQUE (requested_by_user_id, request_idempotency_key)
);

CREATE TABLE IF NOT EXISTS strategy_decisions (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  strategy_name TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  market_symbol TEXT NOT NULL,
  timeframe TEXT,
  decision_type TEXT NOT NULL CHECK (decision_type IN ('buy', 'sell', 'hold', 'cancel', 'reduce', 'flatten')),
  side TEXT CHECK (side IN ('buy', 'sell')),
  position_effect TEXT NOT NULL CHECK (position_effect IN ('open', 'close', 'increase', 'decrease', 'none')),
  decision_status TEXT NOT NULL CHECK (decision_status IN ('pending', 'approved', 'superseded', 'rejected', 'executed', 'expired')),
  decision_key TEXT NOT NULL,
  requested_quantity TEXT,
  requested_notional TEXT,
  limit_price TEXT,
  stop_price TEXT,
  risk_budget TEXT,
  rationale_json TEXT,
  market_snapshot_json TEXT,
  expires_at_ms INTEGER,
  decided_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (requested_quantity IS NOT NULL OR requested_notional IS NOT NULL OR decision_type IN ('hold', 'cancel', 'flatten')),
  UNIQUE (exchange_account_id, decision_key)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  strategy_decision_id TEXT REFERENCES strategy_decisions(id) ON DELETE SET NULL,
  operator_action_id TEXT REFERENCES operator_actions(id) ON DELETE SET NULL,
  client_order_id TEXT NOT NULL,
  venue_order_id TEXT,
  idempotency_key TEXT NOT NULL,
  market_symbol TEXT NOT NULL,
  order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit', 'stop_market', 'stop_limit')),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  time_in_force TEXT CHECK (time_in_force IN ('gtc', 'ioc', 'fok', 'post_only')),
  post_only INTEGER NOT NULL CHECK (post_only IN (0, 1)),
  reduce_only INTEGER NOT NULL CHECK (reduce_only IN (0, 1)),
  requested_quantity TEXT,
  requested_notional TEXT,
  limit_price TEXT,
  stop_price TEXT,
  executed_quantity TEXT NOT NULL DEFAULT '0',
  cumulative_quote_amount TEXT NOT NULL DEFAULT '0',
  average_fill_price TEXT,
  state TEXT NOT NULL CHECK (state IN ('created', 'submission_pending', 'submitted', 'partially_filled', 'filled', 'cancel_pending', 'cancelled', 'rejected', 'expired', 'failed')),
  state_reason_code TEXT,
  source TEXT NOT NULL CHECK (source IN ('strategy', 'recovery', 'operator', 'reconciliation')),
  submitted_at_ms INTEGER,
  last_event_at_ms INTEGER,
  terminal_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (requested_quantity IS NOT NULL OR requested_notional IS NOT NULL),
  UNIQUE (exchange_account_id, client_order_id),
  UNIQUE (exchange_account_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  exchange_account_id TEXT NOT NULL REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('local', 'exchange_poll', 'exchange_websocket', 'reconciliation', 'recovery', 'operator')),
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'submission_requested', 'submission_accepted', 'submission_rejected', 'status_synced', 'fill_recorded', 'cancel_requested', 'cancel_accepted', 'cancel_rejected', 'completed', 'error', 'operator_note')),
  source_event_id TEXT,
  idempotency_key TEXT,
  previous_state TEXT,
  new_state TEXT,
  event_payload_json TEXT,
  occurred_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (order_id, source, source_event_id)
);

CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  order_event_id TEXT REFERENCES order_events(id) ON DELETE SET NULL,
  exchange_account_id TEXT NOT NULL REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  venue_fill_id TEXT NOT NULL,
  venue_trade_id TEXT,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  market_symbol TEXT NOT NULL,
  fill_price TEXT NOT NULL,
  fill_quantity TEXT NOT NULL,
  quote_quantity TEXT,
  fee_amount TEXT,
  fee_asset_symbol TEXT,
  liquidity_role TEXT NOT NULL CHECK (liquidity_role IN ('maker', 'taker', 'unknown')),
  occurred_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (exchange_account_id, venue_fill_id),
  UNIQUE (order_id, venue_trade_id)
);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  capture_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('poll', 'websocket', 'reconciliation', 'recovery', 'operator')),
  asset_symbol TEXT NOT NULL,
  available_amount TEXT NOT NULL,
  locked_amount TEXT NOT NULL,
  total_amount TEXT NOT NULL,
  value_in_base_currency TEXT,
  captured_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (exchange_account_id, capture_id, asset_symbol)
);

CREATE TABLE IF NOT EXISTS position_snapshots (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  capture_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('poll', 'websocket', 'reconciliation', 'recovery', 'operator')),
  market_symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short', 'flat')),
  quantity TEXT NOT NULL,
  average_entry_price TEXT,
  mark_price TEXT,
  unrealized_pnl TEXT,
  realized_pnl TEXT,
  position_state TEXT NOT NULL CHECK (position_state IN ('open', 'closed', 'liquidated')),
  captured_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (exchange_account_id, capture_id, market_symbol, side)
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  run_type TEXT NOT NULL CHECK (run_type IN ('startup_recovery', 'scheduled', 'manual', 'post_order', 'backfill')),
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('system', 'operator', 'risk', 'schedule')),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'completed_with_drift', 'failed', 'aborted')),
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  watermark_start_ms INTEGER,
  watermark_end_ms INTEGER,
  drift_detected INTEGER NOT NULL CHECK (drift_detected IN (0, 1)),
  actions_taken_json TEXT,
  summary_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_events (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  strategy_decision_id TEXT REFERENCES strategy_decisions(id) ON DELETE SET NULL,
  reconciliation_run_id TEXT REFERENCES reconciliation_runs(id) ON DELETE SET NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'suppressed', 'resolved')),
  message TEXT NOT NULL,
  event_payload_json TEXT,
  detected_at_ms INTEGER NOT NULL,
  acknowledged_at_ms INTEGER,
  resolved_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exchange_accounts_user_status
  ON exchange_accounts (user_id, account_status, can_trade);

CREATE INDEX IF NOT EXISTS idx_idempotency_status_expiry
  ON idempotency_keys (status, expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_execution_state_lease_expiry
  ON execution_state (lease_expires_at_ms);

CREATE INDEX IF NOT EXISTS idx_operator_actions_account_status_requested
  ON operator_actions (exchange_account_id, status, requested_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_operator_actions_target_status
  ON operator_actions (target_type, target_id, status);

CREATE INDEX IF NOT EXISTS idx_strategy_decisions_account_status_time
  ON strategy_decisions (exchange_account_id, decision_status, decided_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_decisions_account_market_time
  ON strategy_decisions (exchange_account_id, market_symbol, decided_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_orders_account_state_created
  ON orders (exchange_account_id, state, created_at_ms DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_account_venue_order_id
  ON orders (exchange_account_id, venue_order_id)
  WHERE venue_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_active_by_account
  ON orders (exchange_account_id, updated_at_ms DESC)
  WHERE state IN ('created', 'submission_pending', 'submitted', 'partially_filled', 'cancel_pending');

CREATE INDEX IF NOT EXISTS idx_order_events_order_time
  ON order_events (order_id, occurred_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_order_events_account_source_time
  ON order_events (exchange_account_id, source, occurred_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_fills_order_time
  ON fills (order_id, occurred_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_fills_account_market_time
  ON fills (exchange_account_id, market_symbol, occurred_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account_asset_time
  ON balance_snapshots (exchange_account_id, asset_symbol, captured_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account_capture
  ON balance_snapshots (exchange_account_id, capture_id);

CREATE INDEX IF NOT EXISTS idx_position_snapshots_account_market_time
  ON position_snapshots (exchange_account_id, market_symbol, captured_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_position_snapshots_account_capture
  ON position_snapshots (exchange_account_id, capture_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_account_status_started
  ON reconciliation_runs (exchange_account_id, status, started_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_risk_events_account_status_detected
  ON risk_events (exchange_account_id, status, detected_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_risk_events_event_type_detected
  ON risk_events (event_type, detected_at_ms DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_events_active_dedupe
  ON risk_events (exchange_account_id, dedupe_key)
  WHERE status IN ('open', 'acknowledged', 'suppressed');

COMMIT;
