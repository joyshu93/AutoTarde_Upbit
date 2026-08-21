PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE strategy_candidate_execution_bindings (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  strategy_decision_id TEXT NOT NULL,
  order_id TEXT NOT NULL UNIQUE,
  exchange_account_id TEXT NOT NULL,
  activation_at TEXT NOT NULL,
  activation_epoch_ns INTEGER NOT NULL CHECK (activation_epoch_ns >= 0),
  market TEXT NOT NULL CHECK (market = 'KRW-BTC'),
  strategy_key TEXT NOT NULL CHECK (strategy_key = 'position_guard.paper_core.v1'),
  policy_id TEXT NOT NULL CHECK (policy_id = 'COMBINED_CONSERVATIVE'),
  policy_version TEXT NOT NULL CHECK (policy_version = 'PCS-2026-001.DEPLOYMENT_READINESS_V1'),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('DRY_RUN', 'LIVE')),
  ord_type TEXT NOT NULL CHECK (ord_type IN ('limit', 'price', 'market', 'best')),
  action TEXT NOT NULL CHECK (action IN ('ENTER', 'ADD', 'REDUCE', 'EXIT')),
  side TEXT NOT NULL CHECK (side IN ('bid', 'ask')),
  intended_quantity_exact TEXT,
  intended_notional_krw_exact TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (deployment_id) REFERENCES strategy_pilot_deployments(id) ON DELETE RESTRICT,
  FOREIGN KEY (strategy_decision_id) REFERENCES strategy_decisions(id) ON DELETE RESTRICT,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE RESTRICT
);

CREATE INDEX idx_strategy_candidate_execution_bindings_deployment
  ON strategy_candidate_execution_bindings(deployment_id, activation_epoch_ns, id);

CREATE TRIGGER strategy_candidate_execution_bindings_no_update
BEFORE UPDATE ON strategy_candidate_execution_bindings
BEGIN
  SELECT RAISE(ABORT, 'strategy candidate execution bindings are append-only');
END;

CREATE TRIGGER strategy_candidate_execution_bindings_no_delete
BEFORE DELETE ON strategy_candidate_execution_bindings
BEGIN
  SELECT RAISE(ABORT, 'strategy candidate execution bindings are append-only');
END;

COMMIT;
PRAGMA foreign_keys = ON;
