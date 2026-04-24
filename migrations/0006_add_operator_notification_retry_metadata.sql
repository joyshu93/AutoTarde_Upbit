ALTER TABLE operator_notifications
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);

ALTER TABLE operator_notifications
  ADD COLUMN last_attempt_at TEXT;

ALTER TABLE operator_notifications
  ADD COLUMN next_attempt_at TEXT;

ALTER TABLE operator_notifications
  ADD COLUMN failure_class TEXT CHECK (failure_class IN ('RETRYABLE', 'PERMANENT'));

CREATE INDEX IF NOT EXISTS idx_operator_notifications_delivery_due
  ON operator_notifications(exchange_account_id, delivery_status, next_attempt_at, created_at DESC);
