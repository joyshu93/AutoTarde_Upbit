-- The activation instant is distinct from deployment creation. Legacy rows remain null and fail closed.
ALTER TABLE strategy_pilot_deployments
  ADD COLUMN activation_at TEXT;

ALTER TABLE strategy_pilot_deployments
  ADD COLUMN activation_epoch_ns TEXT;

CREATE INDEX idx_strategy_pilot_deployments_activation
  ON strategy_pilot_deployments(exchange_account_id, phase, activation_epoch_ns, id);
