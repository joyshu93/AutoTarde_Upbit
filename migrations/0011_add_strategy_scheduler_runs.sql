CREATE TABLE IF NOT EXISTS strategy_scheduler_runs (
  id TEXT PRIMARY KEY,
  exchange_account_id TEXT NOT NULL,
  market TEXT NOT NULL CHECK (market IN ('KRW-BTC', 'KRW-ETH')),
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('SCHEDULER')),
  status TEXT NOT NULL CHECK (status IN ('STARTED', 'COMPLETED', 'FAILED', 'SKIPPED')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  interval_ms INTEGER NOT NULL CHECK (interval_ms > 0),
  run_on_start INTEGER NOT NULL CHECK (run_on_start IN (0, 1)),
  strategy_decision_id TEXT,
  action TEXT CHECK (action IS NULL OR action IN ('ENTER', 'ADD', 'REDUCE', 'EXIT', 'HOLD')),
  order_id TEXT,
  order_status TEXT CHECK (
    order_status IS NULL OR order_status IN (
      'INTENT_CREATED',
      'RISK_REJECTED',
      'PERSISTED',
      'SUBMITTING',
      'OPEN',
      'PARTIALLY_FILLED',
      'FILLED',
      'CANCEL_REQUESTED',
      'CANCELED',
      'REJECTED',
      'FAILED',
      'RECONCILIATION_REQUIRED'
    )
  ),
  submission_accepted INTEGER CHECK (submission_accepted IS NULL OR submission_accepted IN (0, 1)),
  detail TEXT,
  error_message TEXT,
  summary_json TEXT NOT NULL,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_strategy_scheduler_runs_exchange_account_id
  ON strategy_scheduler_runs(exchange_account_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_scheduler_runs_market_status
  ON strategy_scheduler_runs(exchange_account_id, market, status, started_at DESC);
