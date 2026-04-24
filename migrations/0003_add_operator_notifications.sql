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
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operator_notifications_exchange_account_id
  ON operator_notifications(exchange_account_id, created_at DESC);
