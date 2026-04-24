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

CREATE INDEX idx_operator_notification_delivery_attempts_exchange_account_id
  ON operator_notification_delivery_attempts(exchange_account_id, attempted_at DESC);

CREATE INDEX idx_operator_notification_delivery_attempts_notification_id
  ON operator_notification_delivery_attempts(notification_id, attempt_count DESC);
