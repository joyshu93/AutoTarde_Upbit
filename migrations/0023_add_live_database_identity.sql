PRAGMA foreign_keys = ON;

CREATE TABLE live_database_identity (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  database_instance_id TEXT NOT NULL UNIQUE,
  exchange_account_id TEXT NOT NULL UNIQUE,
  upbit_access_key_sha256 TEXT NOT NULL CHECK (length(upbit_access_key_sha256) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE RESTRICT
);
