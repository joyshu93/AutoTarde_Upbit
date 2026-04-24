ALTER TABLE execution_state ADD COLUMN degraded_reason TEXT;

ALTER TABLE execution_state ADD COLUMN degraded_at TEXT;

ALTER TABLE execution_state_transitions RENAME TO execution_state_transitions_legacy;

CREATE TABLE execution_state_transitions (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  command TEXT NOT NULL CHECK (
    command IN (
      'BOOTSTRAP',
      '/pause',
      '/resume',
      '/killswitch',
      'SET_EXECUTION_MODE',
      'SET_LIVE_EXECUTION_GATE',
      'MARK_DEGRADED',
      'CLEAR_DEGRADED'
    )
  ),
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

INSERT INTO execution_state_transitions (
  id,
  exchange_account_id,
  command,
  from_execution_mode,
  to_execution_mode,
  from_live_execution_gate,
  to_live_execution_gate,
  from_system_status,
  to_system_status,
  from_kill_switch_active,
  to_kill_switch_active,
  reason,
  created_at
)
SELECT
  id,
  exchange_account_id,
  command,
  from_execution_mode,
  to_execution_mode,
  from_live_execution_gate,
  to_live_execution_gate,
  from_system_status,
  to_system_status,
  from_kill_switch_active,
  to_kill_switch_active,
  reason,
  created_at
FROM execution_state_transitions_legacy;

DROP TABLE execution_state_transitions_legacy;

CREATE INDEX IF NOT EXISTS idx_execution_state_transitions_exchange_account_id
  ON execution_state_transitions(exchange_account_id, created_at DESC);

ALTER TABLE risk_events RENAME TO risk_events_legacy_v2;

CREATE TABLE risk_events (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  strategy_decision_id TEXT,
  order_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('INFO', 'WARN', 'BLOCK')),
  rule_code TEXT NOT NULL CHECK (
    rule_code IN (
      'GLOBAL_KILL_SWITCH',
      'EXECUTION_PAUSED',
      'SYSTEM_DEGRADED',
      'PER_ASSET_MAX_ALLOCATION',
      'TOTAL_EXPOSURE_CAP',
      'STALE_PRICE_GUARD',
      'DUPLICATE_ORDER_GUARD',
      'MINIMUM_ORDER_VALUE_GUARD',
      'LIVE_EXECUTION_DISABLED',
      'UNSUPPORTED_MARKET',
      'UNSUPPORTED_ORDER_TYPE',
      'EXCHANGE_MIN_TOTAL_GUARD',
      'EXCHANGE_MAX_TOTAL_GUARD',
      'MARKET_OFFLINE',
      'EXCHANGE_ORDER_CHANCE_FAILED',
      'EXCHANGE_ORDER_TEST_FAILED',
      'ORDER_RECOVERY_REQUIRED',
      'BALANCE_DRIFT_DETECTED',
      'POSITION_DRIFT_DETECTED'
    )
  ),
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (strategy_decision_id) REFERENCES strategy_decisions(id) ON DELETE SET NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
);

INSERT INTO risk_events (
  id,
  exchange_account_id,
  strategy_decision_id,
  order_id,
  level,
  rule_code,
  message,
  payload_json,
  created_at
)
SELECT
  id,
  exchange_account_id,
  strategy_decision_id,
  order_id,
  level,
  rule_code,
  message,
  payload_json,
  created_at
FROM risk_events_legacy_v2;

DROP TABLE risk_events_legacy_v2;

CREATE INDEX IF NOT EXISTS idx_risk_events_exchange_account_id
  ON risk_events(exchange_account_id, created_at DESC);
