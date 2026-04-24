PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  telegram_chat_id TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS exchange_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  exchange TEXT NOT NULL CHECK (exchange = 'UPBIT'),
  venue_type TEXT NOT NULL CHECK (venue_type = 'SPOT'),
  account_label TEXT NOT NULL,
  access_key_ref TEXT NOT NULL,
  secret_key_ref TEXT NOT NULL,
  quote_currency TEXT NOT NULL CHECK (quote_currency = 'KRW'),
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS execution_state (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL UNIQUE,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('DRY_RUN', 'LIVE')),
  live_execution_gate TEXT NOT NULL CHECK (live_execution_gate IN ('DISABLED', 'ENABLED')),
  system_status TEXT NOT NULL CHECK (system_status IN ('BOOTING', 'RUNNING', 'PAUSED', 'KILL_SWITCHED', 'DEGRADED')),
  kill_switch_active INTEGER NOT NULL CHECK (kill_switch_active IN (0, 1)),
  pause_reason TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS execution_state_transitions (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  command TEXT NOT NULL CHECK (command IN ('BOOTSTRAP', '/pause', '/resume', '/killswitch', 'SET_EXECUTION_MODE', 'SET_LIVE_EXECUTION_GATE')),
  from_execution_mode TEXT CHECK (from_execution_mode IN ('DRY_RUN', 'LIVE')),
  to_execution_mode TEXT NOT NULL CHECK (to_execution_mode IN ('DRY_RUN', 'LIVE')),
  from_live_execution_gate TEXT CHECK (from_live_execution_gate IN ('DISABLED', 'ENABLED')),
  to_live_execution_gate TEXT NOT NULL CHECK (to_live_execution_gate IN ('DISABLED', 'ENABLED')),
  from_system_status TEXT CHECK (from_system_status IN ('BOOTING', 'RUNNING', 'PAUSED', 'KILL_SWITCHED', 'DEGRADED')),
  to_system_status TEXT NOT NULL CHECK (to_system_status IN ('BOOTING', 'RUNNING', 'PAUSED', 'KILL_SWITCHED', 'DEGRADED')),
  from_kill_switch_active INTEGER CHECK (from_kill_switch_active IN (0, 1)),
  to_kill_switch_active INTEGER NOT NULL CHECK (to_kill_switch_active IN (0, 1)),
  reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS strategy_decisions (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  strategy_key TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('KRW-BTC', 'KRW-ETH')),
  action TEXT NOT NULL CHECK (action IN ('ENTER', 'ADD', 'REDUCE', 'EXIT', 'HOLD')),
  status TEXT NOT NULL CHECK (status IN ('READY', 'BLOCKED_BY_RISK', 'NO_ACTION', 'DATA_STALE')),
  decision_basis_json TEXT NOT NULL,
  intended_notional_krw TEXT,
  intended_quantity TEXT,
  reference_price TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('EXCHANGE_POLL', 'RECONCILIATION')),
  total_krw_value TEXT,
  balances_json TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS position_snapshots (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('EXCHANGE_POLL', 'RECONCILIATION')),
  positions_json TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  strategy_decision_id TEXT,
  exchange_account_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('KRW-BTC', 'KRW-ETH')),
  side TEXT NOT NULL CHECK (side IN ('bid', 'ask')),
  ord_type TEXT NOT NULL CHECK (ord_type IN ('limit', 'price', 'market', 'best')),
  volume TEXT,
  price TEXT,
  time_in_force TEXT CHECK (time_in_force IN ('ioc', 'fok', 'post_only')),
  smp_type TEXT CHECK (smp_type IN ('cancel_maker', 'cancel_taker', 'reduce')),
  identifier TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('STRATEGY', 'OPERATOR', 'RECOVERY')),
  requested_at TEXT NOT NULL,
  upbit_uuid TEXT,
  status TEXT NOT NULL CHECK (status IN ('INTENT_CREATED', 'RISK_REJECTED', 'PERSISTED', 'SUBMITTING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELED', 'REJECTED', 'FAILED', 'RECONCILIATION_REQUIRED')),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('DRY_RUN', 'LIVE')),
  exchange_response_json TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (strategy_decision_id) REFERENCES strategy_decisions(id) ON DELETE SET NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  UNIQUE (exchange_account_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS order_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_source TEXT NOT NULL CHECK (event_source IN ('LOCAL', 'EXCHANGE', 'RECONCILIATION', 'TELEGRAM')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  exchange_fill_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('KRW-BTC', 'KRW-ETH')),
  side TEXT NOT NULL CHECK (side IN ('bid', 'ask')),
  price TEXT NOT NULL,
  volume TEXT NOT NULL,
  fee_currency TEXT,
  fee_amount TEXT,
  filled_at TEXT NOT NULL,
  raw_payload_json TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  UNIQUE (order_id, exchange_fill_id)
);

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'DRIFT_DETECTED', 'ERROR')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  summary_json TEXT NOT NULL,
  error_message TEXT,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operator_notifications (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('TELEGRAM')),
  notification_type TEXT NOT NULL CHECK (notification_type IN ('ORDER_REJECTED', 'ORDER_SUBMISSION_FAILED', 'RECONCILIATION_DRIFT_DETECTED', 'SYNC_FAILED')),
  severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('PENDING', 'SENT', 'FAILED')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  failure_class TEXT CHECK (failure_class IN ('RETRYABLE', 'PERMANENT')),
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operator_notification_delivery_attempts (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  exchange_account_id TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
  lease_token TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('SENT', 'RETRY_SCHEDULED', 'FAILED', 'STALE_LEASE')),
  failure_class TEXT CHECK (failure_class IN ('RETRYABLE', 'PERMANENT')),
  attempted_at TEXT NOT NULL,
  next_attempt_at TEXT,
  delivered_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (notification_id) REFERENCES operator_notifications(id) ON DELETE CASCADE,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS risk_events (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  strategy_decision_id TEXT,
  order_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('INFO', 'WARN', 'BLOCK')),
  rule_code TEXT NOT NULL CHECK (rule_code IN ('GLOBAL_KILL_SWITCH', 'EXECUTION_PAUSED', 'PER_ASSET_MAX_ALLOCATION', 'TOTAL_EXPOSURE_CAP', 'STALE_PRICE_GUARD', 'DUPLICATE_ORDER_GUARD', 'MINIMUM_ORDER_VALUE_GUARD', 'LIVE_EXECUTION_DISABLED', 'UNSUPPORTED_MARKET', 'UNSUPPORTED_ORDER_TYPE', 'EXCHANGE_MIN_TOTAL_GUARD', 'EXCHANGE_MAX_TOTAL_GUARD', 'MARKET_OFFLINE', 'EXCHANGE_ORDER_CHANCE_FAILED', 'EXCHANGE_ORDER_TEST_FAILED', 'ORDER_RECOVERY_REQUIRED')),
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (strategy_decision_id) REFERENCES strategy_decisions(id) ON DELETE SET NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_exchange_accounts_user_id
  ON exchange_accounts(user_id, is_primary);

CREATE INDEX IF NOT EXISTS idx_strategy_decisions_exchange_account_id
  ON strategy_decisions(exchange_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_state_transitions_exchange_account_id
  ON execution_state_transitions(exchange_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_balance_snapshots_exchange_account_id
  ON balance_snapshots(exchange_account_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_position_snapshots_exchange_account_id
  ON position_snapshots(exchange_account_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_exchange_account_id
  ON orders(exchange_account_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_status
  ON orders(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_order_events_order_id
  ON order_events(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fills_order_id
  ON fills(order_id, filled_at DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_exchange_account_id
  ON reconciliation_runs(exchange_account_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_notifications_exchange_account_id
  ON operator_notifications(exchange_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_notifications_delivery_status
  ON operator_notifications(exchange_account_id, delivery_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_notifications_delivery_due
  ON operator_notifications(exchange_account_id, delivery_status, next_attempt_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_notification_delivery_attempts_exchange_account_id
  ON operator_notification_delivery_attempts(exchange_account_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_notification_delivery_attempts_notification_id
  ON operator_notification_delivery_attempts(notification_id, attempt_count DESC);

CREATE INDEX IF NOT EXISTS idx_risk_events_exchange_account_id
  ON risk_events(exchange_account_id, created_at DESC);
