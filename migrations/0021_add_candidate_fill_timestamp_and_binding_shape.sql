PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

ALTER TABLE fills ADD COLUMN execution_timestamp_provenance TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED'
  CHECK (execution_timestamp_provenance IN (
    'EXCHANGE_FILL_CONFIRMED', 'RECONCILIATION_OBSERVED_AT_FALLBACK',
    'ORDER_UPDATED_AT_FALLBACK', 'LOCAL_SYNTHETIC', 'LEGACY_UNVERIFIED'
  ));
ALTER TABLE fills ADD COLUMN execution_epoch_ns TEXT;

ALTER TABLE strategy_candidate_execution_bindings ADD COLUMN bound_price_exact TEXT;
ALTER TABLE strategy_candidate_execution_bindings ADD COLUMN bound_volume_exact TEXT;
ALTER TABLE strategy_candidate_execution_bindings ADD COLUMN bound_time_in_force TEXT;
ALTER TABLE strategy_candidate_execution_bindings ADD COLUMN bound_smp_type TEXT;
ALTER TABLE strategy_candidate_execution_bindings ADD COLUMN material_version TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED'
  CHECK (material_version IN ('LEGACY_UNVERIFIED', 'BINDING_V2'));
ALTER TABLE strategy_candidate_execution_bindings ADD COLUMN order_material_hash TEXT;

CREATE INDEX idx_fills_candidate_execution_epoch
  ON fills(order_id, execution_timestamp_provenance, execution_epoch_ns, exchange_fill_id);

COMMIT;
PRAGMA foreign_keys = ON;
