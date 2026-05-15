PRAGMA foreign_keys = OFF;

ALTER TABLE operator_notifications RENAME TO operator_notifications_legacy_v5;

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
      'SYNC_FAILED'
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
  id,
  exchange_account_id,
  channel,
  notification_type,
  severity,
  title,
  message,
  payload_json,
  delivery_status,
  attempt_count,
  last_attempt_at,
  next_attempt_at,
  failure_class,
  lease_token,
  lease_expires_at,
  created_at,
  delivered_at,
  last_error
)
SELECT
  id,
  exchange_account_id,
  channel,
  notification_type,
  severity,
  title,
  message,
  payload_json,
  delivery_status,
  attempt_count,
  last_attempt_at,
  next_attempt_at,
  failure_class,
  lease_token,
  lease_expires_at,
  created_at,
  delivered_at,
  last_error
FROM operator_notifications_legacy_v5;

ALTER TABLE operator_notification_delivery_attempts RENAME TO operator_notification_delivery_attempts_legacy_v5;

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
  id,
  notification_id,
  exchange_account_id,
  attempt_count,
  lease_token,
  outcome,
  failure_class,
  attempted_at,
  next_attempt_at,
  delivered_at,
  error_message,
  created_at
)
SELECT
  id,
  notification_id,
  exchange_account_id,
  attempt_count,
  lease_token,
  outcome,
  failure_class,
  attempted_at,
  next_attempt_at,
  delivered_at,
  error_message,
  created_at
FROM operator_notification_delivery_attempts_legacy_v5;

DROP TABLE operator_notification_delivery_attempts_legacy_v5;

DROP TABLE operator_notifications_legacy_v5;

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

PRAGMA foreign_keys = ON;
