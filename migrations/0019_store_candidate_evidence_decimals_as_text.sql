PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

-- The pre-0019 REAL columns remain immutable compatibility mirrors. They are not
-- reinterpreted as exact strings, and their historical material hashes remain valid.
ALTER TABLE strategy_candidate_execution_evidence
  ADD COLUMN material_version TEXT NOT NULL DEFAULT 'LEGACY_APPROXIMATE_V1'
  CHECK (material_version IN ('LEGACY_APPROXIMATE_V1', 'EXACT_V2'));
ALTER TABLE strategy_candidate_execution_evidence
  ADD COLUMN executed_quantity_exact TEXT;
ALTER TABLE strategy_candidate_execution_evidence
  ADD COLUMN gross_quote_value_krw_exact TEXT;
ALTER TABLE strategy_candidate_execution_evidence
  ADD COLUMN confirmed_fee_krw_exact TEXT;
ALTER TABLE strategy_candidate_execution_evidence
  ADD COLUMN remaining_quantity_exact TEXT;

ALTER TABLE strategy_candidate_states
  ADD COLUMN material_version TEXT NOT NULL DEFAULT 'LEGACY_APPROXIMATE_V1'
  CHECK (material_version IN ('LEGACY_APPROXIMATE_V1', 'EXACT_V2'));
ALTER TABLE strategy_candidate_states
  ADD COLUMN current_episode_cost_basis_krw_exact TEXT;
ALTER TABLE strategy_candidate_states
  ADD COLUMN current_episode_inventory_quantity_exact TEXT;
ALTER TABLE strategy_candidate_states
  ADD COLUMN current_episode_realized_pnl_krw_exact TEXT;
ALTER TABLE strategy_candidate_states
  ADD COLUMN last_full_exit_realized_pnl_krw_exact TEXT;

ALTER TABLE fills
  ADD COLUMN fee_provenance TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED'
  CHECK (fee_provenance IN (
    'EXCHANGE_FILL_CONFIRMED',
    'ORDER_LEVEL_UNALLOCATED',
    'ORDER_LEVEL_ALLOCATED',
    'MISSING',
    'LEGACY_UNVERIFIED',
    'SIMULATED'
  ));

CREATE INDEX idx_strategy_candidate_evidence_material_version
  ON strategy_candidate_execution_evidence(deployment_id, material_version, executed_at_epoch_ns, id);

COMMIT;
PRAGMA foreign_keys = ON;
