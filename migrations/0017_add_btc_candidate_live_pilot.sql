PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

ALTER TABLE execution_state_transitions RENAME TO execution_state_transitions_0017_legacy;

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
      'CLEAR_DEGRADED',
      'AUTOMATIC_PAUSE'
    )
  ),
  from_execution_mode TEXT CHECK (from_execution_mode IN ('DRY_RUN', 'LIVE')),
  to_execution_mode TEXT NOT NULL CHECK (to_execution_mode IN ('DRY_RUN', 'LIVE')),
  from_live_execution_gate TEXT CHECK (from_live_execution_gate IN ('DISABLED', 'ENABLED')),
  to_live_execution_gate TEXT NOT NULL CHECK (to_live_execution_gate IN ('DISABLED', 'ENABLED')),
  from_system_status TEXT CHECK (
    from_system_status IN ('BOOTING', 'RUNNING', 'PAUSED', 'KILL_SWITCHED', 'DEGRADED')
  ),
  to_system_status TEXT NOT NULL CHECK (
    to_system_status IN ('BOOTING', 'RUNNING', 'PAUSED', 'KILL_SWITCHED', 'DEGRADED')
  ),
  from_kill_switch_active INTEGER CHECK (from_kill_switch_active IN (0, 1)),
  to_kill_switch_active INTEGER NOT NULL CHECK (to_kill_switch_active IN (0, 1)),
  reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

INSERT INTO execution_state_transitions (
  id, exchange_account_id, command, from_execution_mode, to_execution_mode,
  from_live_execution_gate, to_live_execution_gate, from_system_status,
  to_system_status, from_kill_switch_active, to_kill_switch_active, reason, created_at
)
SELECT
  id, exchange_account_id, command, from_execution_mode, to_execution_mode,
  from_live_execution_gate, to_live_execution_gate, from_system_status,
  to_system_status, from_kill_switch_active, to_kill_switch_active, reason, created_at
FROM execution_state_transitions_0017_legacy;

DROP TABLE execution_state_transitions_0017_legacy;

CREATE INDEX idx_execution_state_transitions_exchange_account_id
  ON execution_state_transitions(exchange_account_id, created_at DESC);

ALTER TABLE operator_notifications RENAME TO operator_notifications_0017_legacy;

CREATE TABLE operator_notifications (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('TELEGRAM')),
  notification_type TEXT NOT NULL CHECK (
    notification_type IN (
      'ORDER_REJECTED',
      'ORDER_SUBMISSION_FAILED',
      'RECONCILIATION_DRIFT_DETECTED',
      'SCHEDULER_STARTUP_BLOCKED',
      'SCHEDULER_ORDER_REJECTED',
      'SCHEDULER_ORDER_SUBMITTED',
      'SCHEDULER_RUN_FAILED',
      'SCHEDULER_RUN_SKIPPED',
      'SYNC_FAILED',
      'POSITION_GUARD_PILOT_ACTIVATED',
      'POSITION_GUARD_PILOT_FAULT_PAUSED',
      'POSITION_GUARD_PILOT_UNCERTAIN_SUBMISSION',
      'POSITION_GUARD_PILOT_ROLLBACK_STARTED',
      'POSITION_GUARD_PILOT_ROLLBACK_COMPLETED'
    )
  ),
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

INSERT INTO operator_notifications (
  id, exchange_account_id, channel, notification_type, severity, title, message,
  payload_json, delivery_status, attempt_count, last_attempt_at, next_attempt_at,
  failure_class, lease_token, lease_expires_at, created_at, delivered_at, last_error
)
SELECT
  id, exchange_account_id, channel, notification_type, severity, title, message,
  payload_json, delivery_status, attempt_count, last_attempt_at, next_attempt_at,
  failure_class, lease_token, lease_expires_at, created_at, delivered_at, last_error
FROM operator_notifications_0017_legacy;

ALTER TABLE operator_notification_delivery_attempts
  RENAME TO operator_notification_delivery_attempts_0017_legacy;

CREATE TABLE operator_notification_delivery_attempts (
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

INSERT INTO operator_notification_delivery_attempts (
  id, notification_id, exchange_account_id, attempt_count, lease_token, outcome,
  failure_class, attempted_at, next_attempt_at, delivered_at, error_message, created_at
)
SELECT
  id, notification_id, exchange_account_id, attempt_count, lease_token, outcome,
  failure_class, attempted_at, next_attempt_at, delivered_at, error_message, created_at
FROM operator_notification_delivery_attempts_0017_legacy;

DROP TABLE operator_notification_delivery_attempts_0017_legacy;
DROP TABLE operator_notifications_0017_legacy;

CREATE INDEX idx_operator_notifications_exchange_account_id
  ON operator_notifications(exchange_account_id, created_at DESC);
CREATE INDEX idx_operator_notifications_delivery_status
  ON operator_notifications(exchange_account_id, delivery_status, created_at DESC);
CREATE INDEX idx_operator_notifications_delivery_due
  ON operator_notifications(exchange_account_id, delivery_status, next_attempt_at, created_at DESC);
CREATE INDEX idx_operator_notification_delivery_attempts_exchange_account_id
  ON operator_notification_delivery_attempts(exchange_account_id, attempted_at DESC);
CREATE INDEX idx_operator_notification_delivery_attempts_notification_id
  ON operator_notification_delivery_attempts(notification_id, attempt_count DESC);

ALTER TABLE risk_events RENAME TO risk_events_0017_legacy;

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
      'POSITION_DRIFT_DETECTED',
      'POSITION_GUARD_PILOT_IDENTITY_MISMATCH',
      'POSITION_GUARD_PILOT_REPLAY_MISMATCH',
      'POSITION_GUARD_PILOT_STALE_SNAPSHOT',
      'POSITION_GUARD_PILOT_BLOCKING_RECONCILIATION',
      'POSITION_GUARD_PILOT_ACTIVE_ORDER',
      'POSITION_GUARD_PILOT_UNCERTAIN_ORDER',
      'ACCOUNT_EXECUTION_LEASE_BLOCKED'
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
  id, exchange_account_id, strategy_decision_id, order_id, level, rule_code,
  message, payload_json, created_at
)
SELECT
  id, exchange_account_id, strategy_decision_id, order_id, level, rule_code,
  message, payload_json, created_at
FROM risk_events_0017_legacy;

DROP TABLE risk_events_0017_legacy;

CREATE INDEX idx_risk_events_exchange_account_id
  ON risk_events(exchange_account_id, created_at DESC);

CREATE TABLE strategy_pilot_deployments (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  pilot_id TEXT NOT NULL CHECK (pilot_id = 'BTC_COMBINED_CONSERVATIVE_PILOT_V1'),
  market TEXT NOT NULL CHECK (market = 'KRW-BTC'),
  policy_id TEXT NOT NULL CHECK (policy_id = 'COMBINED_CONSERVATIVE'),
  policy_version TEXT NOT NULL CHECK (policy_version = 'PCS-2026-001.DEPLOYMENT_READINESS_V1'),
  phase TEXT NOT NULL CHECK (phase IN ('DISABLED', 'PENDING_FLAT', 'ACTIVE', 'PAUSED_FAULT', 'DRAINING')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE RESTRICT,
  UNIQUE (exchange_account_id, pilot_id)
);

CREATE TABLE strategy_candidate_execution_evidence (
  deployment_id TEXT NOT NULL,
  id TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  executed_at_epoch_ns INTEGER NOT NULL CHECK (executed_at_epoch_ns >= 0),
  action TEXT NOT NULL CHECK (action IN ('ENTER', 'ADD', 'REDUCE', 'EXIT')),
  entry_path TEXT NOT NULL CHECK (entry_path IN ('PULLBACK', 'RECLAIM', 'BREAKOUT_HOLD', 'NONE')),
  terminal_status TEXT NOT NULL CHECK (terminal_status IN ('FILLED', 'CANCELED')),
  executed_quantity REAL NOT NULL CHECK (executed_quantity >= 0),
  gross_quote_value_krw REAL NOT NULL CHECK (gross_quote_value_krw >= 0),
  confirmed_fee_krw REAL NOT NULL CHECK (confirmed_fee_krw >= 0),
  remaining_quantity REAL NOT NULL CHECK (remaining_quantity >= 0),
  material_hash TEXT NOT NULL CHECK (length(material_hash) = 64),
  created_at TEXT NOT NULL,
  FOREIGN KEY (deployment_id) REFERENCES strategy_pilot_deployments(id) ON DELETE RESTRICT,
  PRIMARY KEY (deployment_id, id)
);

CREATE TABLE strategy_candidate_states (
  deployment_id TEXT PRIMARY KEY,
  current_episode_add_count INTEGER NOT NULL CHECK (current_episode_add_count >= 0),
  current_episode_cost_basis_krw REAL NOT NULL CHECK (current_episode_cost_basis_krw >= 0),
  current_episode_inventory_quantity REAL NOT NULL CHECK (current_episode_inventory_quantity >= 0),
  current_episode_realized_pnl_krw REAL NOT NULL,
  last_full_exit_at TEXT,
  last_full_exit_realized_pnl_krw REAL,
  last_entry_path TEXT CHECK (last_entry_path IN ('PULLBACK', 'RECLAIM', 'BREAKOUT_HOLD', 'NONE')),
  last_evidence_at TEXT,
  last_evidence_id TEXT,
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  updated_at TEXT NOT NULL,
  CHECK ((last_full_exit_at IS NULL) = (last_full_exit_realized_pnl_krw IS NULL)),
  CHECK ((last_evidence_at IS NULL) = (last_evidence_id IS NULL)),
  FOREIGN KEY (deployment_id) REFERENCES strategy_pilot_deployments(id) ON DELETE RESTRICT,
  FOREIGN KEY (deployment_id, last_evidence_id)
    REFERENCES strategy_candidate_execution_evidence(deployment_id, id) ON DELETE RESTRICT
);

CREATE TABLE strategy_pilot_audit_events (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'DEPLOYMENT_CREATED',
      'STATE_ADVANCED',
      'PHASE_TRANSITION',
      'FAULT_PAUSED',
      'ROLLBACK_STARTED',
      'ROLLBACK_COMPLETED'
    )
  ),
  from_phase TEXT CHECK (from_phase IN ('DISABLED', 'PENDING_FLAT', 'ACTIVE', 'PAUSED_FAULT', 'DRAINING')),
  to_phase TEXT CHECK (to_phase IN ('DISABLED', 'PENDING_FLAT', 'ACTIVE', 'PAUSED_FAULT', 'DRAINING')),
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_at_epoch_ns INTEGER NOT NULL CHECK (created_at_epoch_ns >= 0),
  FOREIGN KEY (deployment_id) REFERENCES strategy_pilot_deployments(id) ON DELETE RESTRICT
);

CREATE TABLE account_execution_leases (
  exchange_account_id TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL CHECK (length(owner_token) > 0),
  purpose TEXT NOT NULL CHECK (purpose IN ('ORDER_SUBMISSION')),
  acquired_at_epoch_ms INTEGER NOT NULL CHECK (acquired_at_epoch_ms >= 0),
  expires_at_epoch_ms INTEGER NOT NULL CHECK (expires_at_epoch_ms > acquired_at_epoch_ms),
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

CREATE TABLE order_submission_recovery_observations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('FOUND', 'NOT_FOUND', 'TRANSIENT_FAILURE')),
  observed_at TEXT NOT NULL,
  observed_at_epoch_ms INTEGER NOT NULL CHECK (observed_at_epoch_ms >= 0),
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT
);

CREATE INDEX idx_strategy_pilot_deployments_account
  ON strategy_pilot_deployments(exchange_account_id, pilot_id);
CREATE INDEX idx_strategy_candidate_evidence_replay
  ON strategy_candidate_execution_evidence(deployment_id, executed_at_epoch_ns, id);
CREATE INDEX idx_strategy_pilot_audit_events_deployment
  ON strategy_pilot_audit_events(deployment_id, created_at_epoch_ns, id);
CREATE INDEX idx_account_execution_leases_expiry
  ON account_execution_leases(expires_at_epoch_ms, exchange_account_id);
CREATE INDEX idx_order_submission_recovery_observations_order
  ON order_submission_recovery_observations(order_id, observed_at_epoch_ms, id);

CREATE TRIGGER strategy_candidate_execution_evidence_no_update
BEFORE UPDATE ON strategy_candidate_execution_evidence
BEGIN
  SELECT RAISE(ABORT, 'strategy candidate execution evidence is append-only');
END;

CREATE TRIGGER strategy_candidate_execution_evidence_no_delete
BEFORE DELETE ON strategy_candidate_execution_evidence
BEGIN
  SELECT RAISE(ABORT, 'strategy candidate execution evidence is append-only');
END;

CREATE TRIGGER strategy_pilot_audit_events_no_update
BEFORE UPDATE ON strategy_pilot_audit_events
BEGIN
  SELECT RAISE(ABORT, 'strategy pilot audit events are append-only');
END;

CREATE TRIGGER strategy_pilot_audit_events_no_delete
BEFORE DELETE ON strategy_pilot_audit_events
BEGIN
  SELECT RAISE(ABORT, 'strategy pilot audit events are append-only');
END;

CREATE TRIGGER order_submission_recovery_observations_no_update
BEFORE UPDATE ON order_submission_recovery_observations
BEGIN
  SELECT RAISE(ABORT, 'order submission recovery observations are append-only');
END;

CREATE TRIGGER order_submission_recovery_observations_no_delete
BEFORE DELETE ON order_submission_recovery_observations
BEGIN
  SELECT RAISE(ABORT, 'order submission recovery observations are append-only');
END;

COMMIT;
PRAGMA foreign_keys = ON;
