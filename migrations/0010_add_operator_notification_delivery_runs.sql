CREATE TABLE IF NOT EXISTS operator_notification_delivery_runs (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('COMPLETED', 'SKIPPED', 'FAILED')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  attempted_count INTEGER NOT NULL CHECK (attempted_count >= 0),
  sent_count INTEGER NOT NULL CHECK (sent_count >= 0),
  retry_scheduled_count INTEGER NOT NULL CHECK (retry_scheduled_count >= 0),
  failed_count INTEGER NOT NULL CHECK (failed_count >= 0),
  stale_lease_count INTEGER NOT NULL CHECK (stale_lease_count >= 0),
  pending_total_count INTEGER NOT NULL CHECK (pending_total_count >= 0),
  pending_due_count INTEGER NOT NULL CHECK (pending_due_count >= 0),
  pending_scheduled_count INTEGER NOT NULL CHECK (pending_scheduled_count >= 0),
  active_lease_count INTEGER NOT NULL CHECK (active_lease_count >= 0),
  expired_lease_count INTEGER NOT NULL CHECK (expired_lease_count >= 0),
  abandoned_lease_candidate_count INTEGER NOT NULL CHECK (abandoned_lease_candidate_count >= 0),
  skipped_reason TEXT,
  error_message TEXT,
  summary_json TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operator_notification_delivery_runs_exchange_account_id
  ON operator_notification_delivery_runs(exchange_account_id, started_at DESC);
