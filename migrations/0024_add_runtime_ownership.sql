PRAGMA foreign_keys = ON;

CREATE TABLE runtime_ownership (
  scope_key TEXT NOT NULL CHECK (
    length(scope_key) = 64
    AND scope_key NOT GLOB '*[^a-f0-9]*'
  ),
  lease_scope TEXT NOT NULL CHECK (lease_scope = 'APPLICATION_RUNTIME'),
  owner_token TEXT NOT NULL CHECK (
    length(owner_token) = 64
    AND owner_token NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  generation INTEGER NOT NULL CHECK (
    generation >= 1 AND generation <= 9007199254740991
  ),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('DRY_RUN', 'LIVE')),
  acquired_at_epoch_ms INTEGER NOT NULL CHECK (
    acquired_at_epoch_ms >= 0 AND acquired_at_epoch_ms <= 9007199254740991
  ),
  heartbeat_at_epoch_ms INTEGER NOT NULL CHECK (
    heartbeat_at_epoch_ms >= acquired_at_epoch_ms
    AND heartbeat_at_epoch_ms <= 9007199254740991
  ),
  expires_at_epoch_ms INTEGER NOT NULL CHECK (
    expires_at_epoch_ms > heartbeat_at_epoch_ms
    AND expires_at_epoch_ms <= 9007199254740991
  ),
  PRIMARY KEY (scope_key, lease_scope)
);

CREATE TABLE runtime_ownership_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT CHECK (id >= 1 AND id <= 9007199254740991),
  scope_key TEXT NOT NULL CHECK (
    length(scope_key) = 64
    AND scope_key NOT GLOB '*[^a-f0-9]*'
  ),
  lease_scope TEXT NOT NULL CHECK (lease_scope = 'APPLICATION_RUNTIME'),
  generation INTEGER NOT NULL CHECK (
    generation >= 1 AND generation <= 9007199254740991
  ),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('ACQUIRED', 'TAKEN_OVER', 'RELEASED', 'LOST')
  ),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('DRY_RUN', 'LIVE')),
  reason_code TEXT NOT NULL CHECK (
    length(reason_code) BETWEEN 1 AND 64
    AND substr(reason_code, 1, 1) GLOB '[A-Z]'
    AND reason_code NOT GLOB '*[^A-Z0-9_]*'
  ),
  event_at_epoch_ms INTEGER NOT NULL CHECK (
    event_at_epoch_ms >= 0 AND event_at_epoch_ms <= 9007199254740991
  )
);

CREATE INDEX idx_runtime_ownership_expires_at
  ON runtime_ownership(scope_key, expires_at_epoch_ms, generation);

CREATE INDEX idx_runtime_ownership_events_recent
  ON runtime_ownership_events(scope_key, lease_scope, event_at_epoch_ms DESC, id DESC);

CREATE UNIQUE INDEX idx_runtime_ownership_events_generation_acquisition
  ON runtime_ownership_events(scope_key, generation)
  WHERE event_type IN ('ACQUIRED', 'TAKEN_OVER');

CREATE TRIGGER runtime_ownership_events_no_update
BEFORE UPDATE ON runtime_ownership_events
BEGIN
  SELECT RAISE(ABORT, 'runtime ownership events are append-only');
END;

CREATE TRIGGER runtime_ownership_events_no_delete
BEFORE DELETE ON runtime_ownership_events
BEGIN
  SELECT RAISE(ABORT, 'runtime ownership events are append-only');
END;
