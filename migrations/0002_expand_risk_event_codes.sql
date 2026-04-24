ALTER TABLE risk_events RENAME TO risk_events_legacy;

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
      'ORDER_RECOVERY_REQUIRED'
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
  id,
  exchange_account_id,
  strategy_decision_id,
  order_id,
  level,
  rule_code,
  message,
  payload_json,
  created_at
)
SELECT
  id,
  exchange_account_id,
  strategy_decision_id,
  order_id,
  level,
  rule_code,
  message,
  payload_json,
  created_at
FROM risk_events_legacy;

DROP TABLE risk_events_legacy;

CREATE INDEX IF NOT EXISTS idx_risk_events_exchange_account_id
  ON risk_events(exchange_account_id, created_at DESC);
