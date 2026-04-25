CREATE TABLE IF NOT EXISTS history_recovery_checkpoints (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('KRW-BTC', 'KRW-ETH')),
  checkpoint_type TEXT NOT NULL CHECK (checkpoint_type IN ('CLOSED_ORDER_ARCHIVE')),
  next_window_end_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  UNIQUE (exchange_account_id, market, checkpoint_type)
);

CREATE INDEX IF NOT EXISTS idx_history_recovery_checkpoints_exchange_account_id
  ON history_recovery_checkpoints(exchange_account_id, checkpoint_type, market);
