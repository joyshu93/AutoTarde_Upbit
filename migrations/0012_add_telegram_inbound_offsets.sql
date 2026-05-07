CREATE TABLE IF NOT EXISTS telegram_inbound_offsets (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  update_source TEXT NOT NULL CHECK (update_source IN ('GET_UPDATES')),
  bot_token_ref TEXT NOT NULL,
  next_offset INTEGER NOT NULL CHECK (next_offset >= 0),
  last_update_id INTEGER,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE,
  UNIQUE (exchange_account_id, update_source, bot_token_ref)
);

CREATE INDEX IF NOT EXISTS idx_telegram_inbound_offsets_exchange_account_id
  ON telegram_inbound_offsets(exchange_account_id, update_source, updated_at DESC);
