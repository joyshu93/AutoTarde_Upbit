PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

ALTER TABLE strategy_candidate_states
  RENAME TO strategy_candidate_states_0019_legacy;
ALTER TABLE strategy_candidate_execution_evidence
  RENAME TO strategy_candidate_execution_evidence_0019_legacy;

CREATE TABLE strategy_candidate_execution_evidence (
  deployment_id TEXT NOT NULL,
  id TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  executed_at_epoch_ns INTEGER NOT NULL CHECK (executed_at_epoch_ns >= 0),
  action TEXT NOT NULL CHECK (action IN ('ENTER', 'ADD', 'REDUCE', 'EXIT')),
  entry_path TEXT NOT NULL CHECK (entry_path IN ('PULLBACK', 'RECLAIM', 'BREAKOUT_HOLD', 'NONE')),
  terminal_status TEXT NOT NULL CHECK (terminal_status IN ('FILLED', 'CANCELED')),
  executed_quantity TEXT NOT NULL CHECK (length(executed_quantity) > 0),
  gross_quote_value_krw TEXT NOT NULL CHECK (length(gross_quote_value_krw) > 0),
  confirmed_fee_krw TEXT NOT NULL CHECK (length(confirmed_fee_krw) > 0),
  remaining_quantity TEXT NOT NULL CHECK (length(remaining_quantity) > 0),
  material_hash TEXT NOT NULL CHECK (length(material_hash) = 64),
  created_at TEXT NOT NULL,
  FOREIGN KEY (deployment_id) REFERENCES strategy_pilot_deployments(id) ON DELETE RESTRICT,
  PRIMARY KEY (deployment_id, id)
);

INSERT INTO strategy_candidate_execution_evidence (
  deployment_id, id, executed_at, executed_at_epoch_ns, action, entry_path,
  terminal_status, executed_quantity, gross_quote_value_krw, confirmed_fee_krw,
  remaining_quantity, material_hash, created_at
)
SELECT
  deployment_id, id, executed_at, executed_at_epoch_ns, action, entry_path,
  terminal_status, CAST(executed_quantity AS TEXT), CAST(gross_quote_value_krw AS TEXT),
  CAST(confirmed_fee_krw AS TEXT), CAST(remaining_quantity AS TEXT), material_hash, created_at
FROM strategy_candidate_execution_evidence_0019_legacy;

CREATE TABLE strategy_candidate_states (
  deployment_id TEXT PRIMARY KEY,
  current_episode_add_count INTEGER NOT NULL CHECK (current_episode_add_count >= 0),
  current_episode_cost_basis_krw REAL NOT NULL CHECK (current_episode_cost_basis_krw >= 0),
  current_episode_inventory_quantity REAL NOT NULL CHECK (current_episode_inventory_quantity >= 0),
  current_episode_realized_pnl_krw REAL NOT NULL,
  last_full_exit_at TEXT,
  last_full_exit_realized_pnl_krw REAL,
  last_entry_path TEXT CHECK (last_entry_path IN ('PULLBACK', 'RECLAIM', 'BREAKOUT_HOLD', 'NONE')),
  last_evidence_at TEXT,
  last_evidence_id TEXT,
  state_version INTEGER NOT NULL CHECK (state_version >= 0),
  updated_at TEXT NOT NULL,
  CHECK ((last_full_exit_at IS NULL) = (last_full_exit_realized_pnl_krw IS NULL)),
  CHECK ((last_evidence_at IS NULL) = (last_evidence_id IS NULL)),
  FOREIGN KEY (deployment_id) REFERENCES strategy_pilot_deployments(id) ON DELETE RESTRICT,
  FOREIGN KEY (deployment_id, last_evidence_id)
    REFERENCES strategy_candidate_execution_evidence(deployment_id, id) ON DELETE RESTRICT
);

INSERT INTO strategy_candidate_states (
  deployment_id, current_episode_add_count, current_episode_cost_basis_krw,
  current_episode_inventory_quantity, current_episode_realized_pnl_krw,
  last_full_exit_at, last_full_exit_realized_pnl_krw, last_entry_path,
  last_evidence_at, last_evidence_id, state_version, updated_at
)
SELECT
  deployment_id, current_episode_add_count, current_episode_cost_basis_krw,
  current_episode_inventory_quantity, current_episode_realized_pnl_krw,
  last_full_exit_at, last_full_exit_realized_pnl_krw, last_entry_path,
  last_evidence_at, last_evidence_id, state_version, updated_at
FROM strategy_candidate_states_0019_legacy;

DROP TABLE strategy_candidate_states_0019_legacy;
DROP TABLE strategy_candidate_execution_evidence_0019_legacy;

CREATE INDEX idx_strategy_candidate_evidence_replay
  ON strategy_candidate_execution_evidence(deployment_id, executed_at_epoch_ns, id);

CREATE TRIGGER strategy_candidate_execution_evidence_no_update
BEFORE UPDATE ON strategy_candidate_execution_evidence
BEGIN
  SELECT RAISE(ABORT, 'strategy candidate execution evidence is append-only');
END;

CREATE TRIGGER strategy_candidate_execution_evidence_no_delete
BEFORE DELETE ON strategy_candidate_execution_evidence
BEGIN
  SELECT RAISE(ABORT, 'strategy candidate execution evidence is append-only');
END;

COMMIT;
PRAGMA foreign_keys = ON;
