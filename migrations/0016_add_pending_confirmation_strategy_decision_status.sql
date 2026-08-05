PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE strategy_decisions_new (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  strategy_key TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('KRW-BTC', 'KRW-ETH')),
  action TEXT NOT NULL CHECK (action IN ('ENTER', 'ADD', 'REDUCE', 'EXIT', 'HOLD')),
  status TEXT NOT NULL CHECK (
    status IN ('READY', 'PENDING_CONFIRMATION', 'BLOCKED_BY_RISK', 'NO_ACTION', 'DATA_STALE')
  ),
  decision_basis_json TEXT NOT NULL,
  intended_notional_krw TEXT,
  intended_quantity TEXT,
  reference_price TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

INSERT INTO strategy_decisions_new (
  id,
  exchange_account_id,
  strategy_key,
  market,
  action,
  status,
  decision_basis_json,
  intended_notional_krw,
  intended_quantity,
  reference_price,
  created_at
)
SELECT
  id,
  exchange_account_id,
  strategy_key,
  market,
  action,
  status,
  decision_basis_json,
  intended_notional_krw,
  intended_quantity,
  reference_price,
  created_at
FROM strategy_decisions;

DROP TABLE strategy_decisions;
ALTER TABLE strategy_decisions_new RENAME TO strategy_decisions;

CREATE INDEX IF NOT EXISTS idx_strategy_decisions_exchange_account_id
  ON strategy_decisions(exchange_account_id, created_at DESC);

COMMIT;
PRAGMA foreign_keys = ON;
