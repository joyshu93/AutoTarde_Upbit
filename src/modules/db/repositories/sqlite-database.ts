import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { parseMigrationScript, type ParsedMigrationScript } from "../migration-script.js";
import { canonicalizeLocalDatabasePath } from "../local-database-path.js";

export interface SqliteDatabaseHandle {
  db: DatabaseSync;
  close(): void;
}

export interface SqliteDatabaseOpenVerification {
  assertBeforeOpen(databasePath: string): void;
  assertOpenedDatabase(db: DatabaseSync, databasePath: string): void;
}

export function openSqliteDatabase(
  databasePath: string,
  verification?: SqliteDatabaseOpenVerification,
): SqliteDatabaseHandle {
  const openedPath = databasePath === ":memory:"
    ? databasePath
    : canonicalizeLocalDatabasePath(databasePath);
  if (openedPath !== ":memory:") verification?.assertBeforeOpen(openedPath);
  if (openedPath !== ":memory:") mkdirSync(dirname(openedPath), { recursive: true });

  const db = new DatabaseSync(openedPath);
  try {
    if (openedPath !== ":memory:") {
      const canonicalOpenedPath = canonicalizeLocalDatabasePath(openedPath, { mustExist: true });
      if (!sameDatabasePath(openedPath, canonicalOpenedPath)) {
        throw new Error("SQLite opened a different canonical database path than the accepted runtime path.");
      }
      verification?.assertOpenedDatabase(db, openedPath);
    }
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");

    ensureMigrationTable(db);
    applyMigrations(db, resolve(process.cwd(), "migrations"));
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      if (db.isTransaction) {
        db.exec("ROLLBACK;");
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      db.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `SQLite initialization failed and cleanup also failed: ${formatError(error)}`,
      );
    }
    throw error;
  }

  return {
    db,
    close() {
      db.close();
    },
  };
}

export function openReadOnlySqliteDatabase(
  databasePath: string,
  verification?: SqliteDatabaseOpenVerification,
): DatabaseSync {
  const canonicalPath = canonicalizeLocalDatabasePath(databasePath, { mustExist: true });
  verification?.assertBeforeOpen(canonicalPath);
  const db = new DatabaseSync(canonicalPath, { readOnly: true });
  try {
    const canonicalOpenedPath = canonicalizeLocalDatabasePath(canonicalPath, { mustExist: true });
    if (!sameDatabasePath(canonicalPath, canonicalOpenedPath)) {
      throw new Error("SQLite opened a different canonical database path than the accepted read-only path.");
    }
    verification?.assertOpenedDatabase(db, canonicalPath);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function sameDatabasePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toUpperCase() === right.toUpperCase()
    : left === right;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureMigrationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

function applyMigrations(db: DatabaseSync, migrationsDir: string): void {
  const filenames = listCanonicalMigrationFilenames(migrationsDir);

  const appliedStatement = db.prepare("SELECT filename FROM _schema_migrations WHERE filename = ?");
  const insertStatement = db.prepare("INSERT INTO _schema_migrations (filename, applied_at) VALUES (?, ?)");

  for (const filename of filenames) {
    const applied = appliedStatement.get(filename) as { filename: string } | undefined;
    if (applied) {
      if (filename === "0019_store_candidate_evidence_decimals_as_text.sql") {
        repairMigration0019(db);
      } else if (filename === "0021_add_candidate_fill_timestamp_and_binding_shape.sql") {
        repairMigration0021(db);
      } else if (filename === "0022_add_candidate_deployment_activation.sql") {
        repairMigration0022(db);
      }
      continue;
    }

    const migrationSql = readFileSync(join(migrationsDir, filename), "utf8");
    const parsed = parseMigrationScript(migrationSql);
    if (repairHistoricalMigrationLedger(
      db,
      migrationsDir,
      filename,
      migrationSql,
      () => insertStatement.run(filename, new Date().toISOString()),
    )) {
      continue;
    }

    applyMigrationAtomically(db, parsed, () => {
      executeMigrationBody(db, filename, parsed.bodySql);
      assertForeignKeyIntegrity(db, filename);
      insertStatement.run(filename, new Date().toISOString());
    });
  }
}

export function listCanonicalMigrationFilenames(
  migrationsDir = resolve(process.cwd(), "migrations"),
): string[] {
  return readdirSync(migrationsDir)
    .filter((filename) => extname(filename) === ".sql")
    .sort((left, right) => left.localeCompare(right));
}

function executeMigrationBody(db: DatabaseSync, filename: string, bodySql: string): void {
  try {
    db.exec(bodySql);
  } catch (error) {
    const repair = legacyMigrationRepair(filename);
    if (repair === null) throw error;
    repair(db);
  }
}

function legacyMigrationRepair(filename: string): ((db: DatabaseSync) => void) | null {
  if (filename === "0005_add_startup_degraded_policy_and_portfolio_drift_codes.sql") {
    return repairMigration0005;
  }
  if (filename === "0006_add_operator_notification_retry_metadata.sql") {
    return repairMigration0006;
  }
  if (filename === "0007_add_operator_notification_delivery_leases.sql") {
    return repairMigration0007;
  }
  if (filename === "0008_add_operator_notification_delivery_attempt_history.sql") {
    return repairMigration0008;
  }
  if (filename === "0009_add_history_recovery_checkpoints.sql") {
    return repairMigration0009;
  }
  return null;
}

function applyMigrationAtomically(
  db: DatabaseSync,
  parsed: Pick<ParsedMigrationScript, "requiresForeignKeysOff">,
  operation: () => void,
): void {
  if (db.isTransaction) {
    throw new Error("Cannot apply a migration while another SQLite transaction is active.");
  }

  const foreignKeysBefore = readForeignKeysPragma(db);
  if (parsed.requiresForeignKeysOff && foreignKeysBefore !== 0) {
    db.exec("PRAGMA foreign_keys = OFF;");
    if (readForeignKeysPragma(db) !== 0) {
      throw new Error("Failed to disable SQLite foreign keys before migration transaction.");
    }
  }

  let operationError: unknown;
  try {
    db.exec("BEGIN IMMEDIATE;");
    try {
      operation();
      db.exec("COMMIT;");
    } catch (error) {
      operationError = error;
      if (db.isTransaction) db.exec("ROLLBACK;");
    }
  } finally {
    if (parsed.requiresForeignKeysOff && foreignKeysBefore !== 0) {
      db.exec("PRAGMA foreign_keys = ON;");
      if (readForeignKeysPragma(db) !== foreignKeysBefore) {
        throw new Error("Failed to restore SQLite foreign keys after migration transaction.");
      }
    }
  }

  if (operationError !== undefined) throw operationError;
}

function readForeignKeysPragma(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
  return row.foreign_keys;
}

function assertForeignKeyIntegrity(db: DatabaseSync, filename: string): void {
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(`Migration ${filename} produced ${violations.length} foreign-key violation(s).`);
  }
}

type SchemaObjectType = "index" | "table" | "trigger";

interface SchemaObjectSignature {
  type: SchemaObjectType;
  name: string;
  tableName: string;
  normalizedSql: string;
}

interface SchemaSnapshot {
  objects: ReadonlyMap<string, Readonly<SchemaObjectSignature>>;
  columns: ReadonlyMap<string, ReadonlySet<string>>;
}

interface SchemaObjectChange {
  key: string;
  before: Readonly<SchemaObjectSignature> | null;
  after: Readonly<SchemaObjectSignature> | null;
}

interface CanonicalMigrationDelta {
  objectChanges: readonly Readonly<SchemaObjectChange>[];
  addedColumns: readonly Readonly<{ tableName: string; columnName: string }>[];
  transientObjectNames: readonly string[];
}

const canonicalMigrationDeltaCache = new Map<string, Readonly<CanonicalMigrationDelta>>();

function repairHistoricalMigrationLedger(
  db: DatabaseSync,
  migrationsDir: string,
  filename: string,
  migrationSql: string,
  recordMigration: () => void,
): boolean {
  const delta = canonicalMigrationDelta(migrationsDir, filename, migrationSql);
  if (delta.objectChanges.length === 0) return false;

  if (matchesCanonicalMigrationDelta(readSchemaSnapshot(db), delta)) {
    applyMigrationAtomically(db, { requiresForeignKeysOff: false }, () => {
      if (!matchesCanonicalMigrationDelta(readSchemaSnapshot(db), delta)) {
        throw incompatibleHistoricalMigration(filename);
      }
      assertMigrationDatabaseIntegrity(db, filename);
      recordMigration();
    });
    return true;
  }

  const snapshot = readSchemaSnapshot(db);
  if (!hasPartialMigrationMarkers(snapshot, delta)) return false;

  if (filename === "0022_add_candidate_deployment_activation.sql") {
    applyMigrationAtomically(db, { requiresForeignKeysOff: false }, () => {
      repairMigration0022Body(db);
      if (!matchesCanonicalMigrationDelta(readSchemaSnapshot(db), delta)) {
        throw incompatibleHistoricalMigration(filename);
      }
      assertMigrationDatabaseIntegrity(db, filename);
      recordMigration();
    });
    return true;
  }

  throw incompatibleHistoricalMigration(filename);
}

function canonicalMigrationDelta(
  migrationsDir: string,
  filename: string,
  migrationSql: string,
): Readonly<CanonicalMigrationDelta> {
  const cacheKey = `${migrationsDir}\u0000${filename}\u0000${migrationSql}`;
  const cached = canonicalMigrationDeltaCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const shadow = new DatabaseSync(":memory:");
  try {
    shadow.exec("PRAGMA foreign_keys = ON;");
    let before: SchemaSnapshot | null = null;
    let after: SchemaSnapshot | null = null;
    for (const candidate of listCanonicalMigrationFilenames(migrationsDir)) {
      if (candidate === filename) before = readSchemaSnapshot(shadow);
      const candidateSql = readFileSync(join(migrationsDir, candidate), "utf8");
      const parsed = parseMigrationScript(candidateSql);
      applyMigrationAtomically(shadow, parsed, () => {
        executeMigrationBody(shadow, candidate, parsed.bodySql);
        assertForeignKeyIntegrity(shadow, candidate);
      });
      if (candidate === filename) {
        after = readSchemaSnapshot(shadow);
        break;
      }
    }
    if (before === null || after === null) {
      throw new Error(`Cannot build canonical schema delta for unknown migration ${filename}.`);
    }

    const delta = Object.freeze(buildCanonicalMigrationDelta(before, after, migrationSql));
    canonicalMigrationDeltaCache.set(cacheKey, delta);
    return delta;
  } finally {
    shadow.close();
  }
}

function buildCanonicalMigrationDelta(
  before: SchemaSnapshot,
  after: SchemaSnapshot,
  migrationSql: string,
): CanonicalMigrationDelta {
  const objectKeys = new Set([...before.objects.keys(), ...after.objects.keys()]);
  const objectChanges = Array.from(objectKeys)
    .sort((left, right) => left.localeCompare(right))
    .flatMap((key): SchemaObjectChange[] => {
      const beforeObject = before.objects.get(key) ?? null;
      const afterObject = after.objects.get(key) ?? null;
      return sameSchemaObject(beforeObject, afterObject)
        ? []
        : [{ key, before: beforeObject, after: afterObject }];
    });

  const addedColumns: Array<{ tableName: string; columnName: string }> = [];
  for (const [tableName, afterColumns] of after.columns) {
    const beforeColumns = before.columns.get(tableName) ?? new Set<string>();
    for (const columnName of afterColumns) {
      if (!beforeColumns.has(columnName)) addedColumns.push({ tableName, columnName });
    }
  }

  const transientObjectNames = Array.from(migrationSql.matchAll(
    /\bALTER\s+TABLE\s+[A-Za-z_][A-Za-z0-9_]*\s+RENAME\s+TO\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/giu,
  ), (match) => match[1]!)
    .filter((name) => !Array.from(after.objects.values()).some((object) => object.name === name));

  return {
    objectChanges: Object.freeze(objectChanges),
    addedColumns: Object.freeze(addedColumns),
    transientObjectNames: Object.freeze(transientObjectNames),
  };
}

function readSchemaSnapshot(db: DatabaseSync): SchemaSnapshot {
  const rows = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger')
      AND sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
      AND name <> '_schema_migrations'
    ORDER BY type ASC, name ASC
  `).all() as Array<{ type: SchemaObjectType; name: string; tbl_name: string; sql: string }>;
  const objects = new Map<string, Readonly<SchemaObjectSignature>>();
  const columns = new Map<string, ReadonlySet<string>>();
  for (const row of rows) {
    objects.set(schemaObjectKey(row.type, row.name), Object.freeze({
      type: row.type,
      name: row.name,
      tableName: row.tbl_name,
      normalizedSql: normalizeSchemaSql(row.sql),
    }));
    if (row.type === "table") {
      const tableColumns = db.prepare(`PRAGMA table_xinfo(${quoteSqlIdentifier(row.name)})`).all() as
        Array<{ name: string }>;
      columns.set(row.name, new Set(tableColumns.map((column) => column.name)));
    }
  }
  return { objects, columns };
}

function matchesCanonicalMigrationDelta(
  snapshot: SchemaSnapshot,
  delta: Readonly<CanonicalMigrationDelta>,
): boolean {
  for (const change of delta.objectChanges) {
    const actual = snapshot.objects.get(change.key) ?? null;
    if (!sameSchemaObject(actual, change.after)) return false;
  }
  for (const transientName of delta.transientObjectNames) {
    if (Array.from(snapshot.objects.values()).some((object) => object.name === transientName)) {
      return false;
    }
  }
  return true;
}

function hasPartialMigrationMarkers(
  snapshot: SchemaSnapshot,
  delta: Readonly<CanonicalMigrationDelta>,
): boolean {
  for (const change of delta.objectChanges) {
    if (change.before === null && snapshot.objects.has(change.key)) return true;
  }
  for (const addedColumn of delta.addedColumns) {
    if (snapshot.columns.get(addedColumn.tableName)?.has(addedColumn.columnName) === true) return true;
  }
  return delta.transientObjectNames.some((name) =>
    Array.from(snapshot.objects.values()).some((object) => object.name === name));
}

function sameSchemaObject(
  left: Readonly<SchemaObjectSignature> | null,
  right: Readonly<SchemaObjectSignature> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.type === right.type &&
    left.name === right.name &&
    left.tableName === right.tableName &&
    left.normalizedSql === right.normalizedSql;
}

function schemaObjectKey(type: SchemaObjectType, name: string): string {
  return `${type}:${name}`;
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function normalizeSchemaSql(sql: string): string {
  let normalized = "";
  let index = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;
  while (index < sql.length) {
    const character = sql[index]!;
    if (quote === null) {
      if (/\s/u.test(character)) {
        index += 1;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") quote = character;
      else if (character === "[") quote = "]";
      normalized += character.toLowerCase();
      index += 1;
      continue;
    }

    normalized += character;
    index += 1;
    if (character !== quote) continue;
    if (sql[index] === quote) {
      normalized += sql[index];
      index += 1;
    } else {
      quote = null;
    }
  }
  return normalized;
}

function assertMigrationDatabaseIntegrity(db: DatabaseSync, filename: string): void {
  assertForeignKeyIntegrity(db, filename);
  const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  if (row.integrity_check !== "ok") {
    throw new Error(`Migration ${filename} cannot be repaired because integrity_check returned ${row.integrity_check}.`);
  }
}

function incompatibleHistoricalMigration(filename: string): Error {
  return new Error(`Incompatible partially applied migration ${filename}: canonical schema validation failed.`);
}

function repairMigration0005(db: DatabaseSync): void {
  ensureExecutionStateColumn(db, "degraded_reason", "TEXT");
  ensureExecutionStateColumn(db, "degraded_at", "TEXT");
  rebuildExecutionStateTransitions(db);
  rebuildRiskEvents(db);
}

function repairMigration0006(db: DatabaseSync): void {
  ensureOperatorNotificationColumn(db, "attempt_count", "INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)");
  ensureOperatorNotificationColumn(db, "last_attempt_at", "TEXT");
  ensureOperatorNotificationColumn(db, "next_attempt_at", "TEXT");
  ensureOperatorNotificationColumn(
    db,
    "failure_class",
    "TEXT CHECK (failure_class IN ('RETRYABLE', 'PERMANENT'))",
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_operator_notifications_delivery_due
      ON operator_notifications(exchange_account_id, delivery_status, next_attempt_at, created_at DESC);
  `);
}

function repairMigration0007(db: DatabaseSync): void {
  ensureOperatorNotificationColumn(db, "lease_token", "TEXT");
  ensureOperatorNotificationColumn(db, "lease_expires_at", "TEXT");
}

function repairMigration0008(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS operator_notification_delivery_attempts (
      id TEXT PRIMARY KEY,
      notification_id TEXT NOT NULL,
      exchange_account_id TEXT NOT NULL,
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
      lease_token TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('SENT', 'RETRY_SCHEDULED', 'FAILED', 'STALE_LEASE')),
      failure_class TEXT CHECK (failure_class IN ('RETRYABLE', 'PERMANENT')),
      attempted_at TEXT NOT NULL,
      next_attempt_at TEXT,
      delivered_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (notification_id) REFERENCES operator_notifications(id) ON DELETE CASCADE,
      FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_operator_notification_delivery_attempts_exchange_account_id
      ON operator_notification_delivery_attempts(exchange_account_id, attempted_at DESC);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_operator_notification_delivery_attempts_notification_id
      ON operator_notification_delivery_attempts(notification_id, attempt_count DESC);
  `);
}

function repairMigration0009(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS history_recovery_checkpoints (
      id TEXT PRIMARY KEY,
      exchange_account_id TEXT NOT NULL,
      market TEXT NOT NULL CHECK (market IN ('KRW-BTC', 'KRW-ETH')),
      checkpoint_type TEXT NOT NULL CHECK (checkpoint_type IN ('CLOSED_ORDER_ARCHIVE')),
      next_window_end_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE,
      UNIQUE (exchange_account_id, market, checkpoint_type)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_history_recovery_checkpoints_exchange_account_id
      ON history_recovery_checkpoints(exchange_account_id, checkpoint_type, market);
  `);
}

function repairMigration0019(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    if (tableExists(db, "strategy_candidate_execution_evidence")) {
      ensureCandidatePilotColumn(
        db,
        "strategy_candidate_execution_evidence",
        "material_version",
        "TEXT NOT NULL DEFAULT 'LEGACY_APPROXIMATE_V1' " +
          "CHECK (material_version IN ('LEGACY_APPROXIMATE_V1', 'EXACT_V2'))",
      );
      ensureCandidatePilotColumn(db, "strategy_candidate_execution_evidence", "executed_quantity_exact", "TEXT");
      ensureCandidatePilotColumn(db, "strategy_candidate_execution_evidence", "gross_quote_value_krw_exact", "TEXT");
      ensureCandidatePilotColumn(db, "strategy_candidate_execution_evidence", "confirmed_fee_krw_exact", "TEXT");
      ensureCandidatePilotColumn(db, "strategy_candidate_execution_evidence", "remaining_quantity_exact", "TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_strategy_candidate_evidence_material_version
          ON strategy_candidate_execution_evidence(deployment_id, material_version, executed_at_epoch_ns, id);
      `);
    }
    if (tableExists(db, "strategy_candidate_states")) {
      ensureCandidatePilotColumn(
        db,
        "strategy_candidate_states",
        "material_version",
        "TEXT NOT NULL DEFAULT 'LEGACY_APPROXIMATE_V1' " +
          "CHECK (material_version IN ('LEGACY_APPROXIMATE_V1', 'EXACT_V2'))",
      );
      ensureCandidatePilotColumn(db, "strategy_candidate_states", "current_episode_cost_basis_krw_exact", "TEXT");
      ensureCandidatePilotColumn(db, "strategy_candidate_states", "current_episode_inventory_quantity_exact", "TEXT");
      ensureCandidatePilotColumn(db, "strategy_candidate_states", "current_episode_realized_pnl_krw_exact", "TEXT");
      ensureCandidatePilotColumn(db, "strategy_candidate_states", "last_full_exit_realized_pnl_krw_exact", "TEXT");
    }
    if (tableExists(db, "fills")) {
      ensureCandidatePilotColumn(
        db,
        "fills",
        "fee_provenance",
        "TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED' " +
          "CHECK (fee_provenance IN (" +
          "'EXCHANGE_FILL_CONFIRMED', 'ORDER_LEVEL_UNALLOCATED', 'ORDER_LEVEL_ALLOCATED', " +
          "'MISSING', 'LEGACY_UNVERIFIED', 'SIMULATED'))",
      );
    }
    db.exec("COMMIT;");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK;");
    throw error;
  }
}

function repairMigration0021(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    if (tableExists(db, "fills")) {
      ensureCandidatePilotColumn(
        db,
        "fills",
        "execution_timestamp_provenance",
        "TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED' " +
          "CHECK (execution_timestamp_provenance IN (" +
          "'EXCHANGE_FILL_CONFIRMED', 'RECONCILIATION_OBSERVED_AT_FALLBACK', " +
          "'ORDER_UPDATED_AT_FALLBACK', 'LOCAL_SYNTHETIC', 'LEGACY_UNVERIFIED'))",
      );
      ensureCandidatePilotColumn(db, "fills", "execution_epoch_ns", "TEXT");
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_fills_candidate_execution_epoch
          ON fills(order_id, execution_timestamp_provenance, execution_epoch_ns, exchange_fill_id);
      `);
    }
    if (tableExists(db, "strategy_candidate_execution_bindings")) {
      ensureCandidatePilotColumn(db, "strategy_candidate_execution_bindings", "bound_price_exact", "TEXT");
      ensureCandidatePilotColumn(db, "strategy_candidate_execution_bindings", "bound_volume_exact", "TEXT");
      ensureCandidatePilotColumn(db, "strategy_candidate_execution_bindings", "bound_time_in_force", "TEXT");
      ensureCandidatePilotColumn(db, "strategy_candidate_execution_bindings", "bound_smp_type", "TEXT");
      ensureCandidatePilotColumn(
        db,
        "strategy_candidate_execution_bindings",
        "material_version",
        "TEXT NOT NULL DEFAULT 'LEGACY_UNVERIFIED' CHECK (material_version IN ('LEGACY_UNVERIFIED', 'BINDING_V2'))",
      );
      ensureCandidatePilotColumn(db, "strategy_candidate_execution_bindings", "order_material_hash", "TEXT");
    }
    db.exec("COMMIT;");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK;");
    throw error;
  }
}

function repairMigration0022(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE;");
  try {
    repairMigration0022Body(db);
    db.exec("COMMIT;");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK;");
    throw error;
  }
}

function repairMigration0022Body(db: DatabaseSync): void {
  if (!tableExists(db, "strategy_pilot_deployments")) return;
  ensureCandidatePilotColumn(db, "strategy_pilot_deployments", "activation_at", "TEXT");
  ensureCandidatePilotColumn(db, "strategy_pilot_deployments", "activation_epoch_ns", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_strategy_pilot_deployments_activation
      ON strategy_pilot_deployments(exchange_account_id, phase, activation_epoch_ns, id);
  `);
}

function ensureExecutionStateColumn(
  db: DatabaseSync,
  columnName: "degraded_reason" | "degraded_at",
  columnType: "TEXT",
): void {
  if (tableHasColumn(db, "execution_state", columnName)) {
    return;
  }

  db.exec(`ALTER TABLE execution_state ADD COLUMN ${columnName} ${columnType};`);
}

function ensureOperatorNotificationColumn(
  db: DatabaseSync,
  columnName:
    | "attempt_count"
    | "last_attempt_at"
    | "next_attempt_at"
    | "failure_class"
    | "lease_token"
    | "lease_expires_at",
  columnType: string,
): void {
  if (tableHasColumn(db, "operator_notifications", columnName)) {
    return;
  }

  db.exec(`ALTER TABLE operator_notifications ADD COLUMN ${columnName} ${columnType};`);
}

function ensureCandidatePilotColumn(
  db: DatabaseSync,
  tableName:
    | "strategy_candidate_execution_evidence"
    | "strategy_candidate_states"
    | "fills"
    | "strategy_candidate_execution_bindings"
    | "strategy_pilot_deployments",
  columnName: string,
  columnType: string,
): void {
  if (!tableHasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType};`);
  }
}

function rebuildExecutionStateTransitions(db: DatabaseSync): void {
  const legacyTableName = "execution_state_transitions_repair_legacy";
  const partialLegacyTableName = "execution_state_transitions_legacy";

  if (tableExists(db, "execution_state_transitions")) {
    db.exec(`ALTER TABLE execution_state_transitions RENAME TO ${legacyTableName};`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_state_transitions (
      id TEXT PRIMARY KEY,
      exchange_account_id TEXT NOT NULL,
      command TEXT NOT NULL CHECK (
        command IN (
          'BOOTSTRAP',
          '/pause',
          '/resume',
          '/killswitch',
          'SET_EXECUTION_MODE',
          'SET_LIVE_EXECUTION_GATE',
          'MARK_DEGRADED',
          'CLEAR_DEGRADED'
        )
      ),
      from_execution_mode TEXT CHECK (from_execution_mode IN ('DRY_RUN', 'LIVE')),
      to_execution_mode TEXT NOT NULL CHECK (to_execution_mode IN ('DRY_RUN', 'LIVE')),
      from_live_execution_gate TEXT CHECK (from_live_execution_gate IN ('DISABLED', 'ENABLED')),
      to_live_execution_gate TEXT NOT NULL CHECK (to_live_execution_gate IN ('DISABLED', 'ENABLED')),
      from_system_status TEXT CHECK (from_system_status IN ('BOOTING', 'RUNNING', 'PAUSED', 'KILL_SWITCHED', 'DEGRADED')),
      to_system_status TEXT NOT NULL CHECK (to_system_status IN ('BOOTING', 'RUNNING', 'PAUSED', 'KILL_SWITCHED', 'DEGRADED')),
      from_kill_switch_active INTEGER CHECK (from_kill_switch_active IN (0, 1)),
      to_kill_switch_active INTEGER NOT NULL CHECK (to_kill_switch_active IN (0, 1)),
      reason TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
    );
  `);

  for (const sourceTable of [legacyTableName, partialLegacyTableName]) {
    if (!tableExists(db, sourceTable)) {
      continue;
    }

    db.exec(`
      INSERT OR IGNORE INTO execution_state_transitions (
        id,
        exchange_account_id,
        command,
        from_execution_mode,
        to_execution_mode,
        from_live_execution_gate,
        to_live_execution_gate,
        from_system_status,
        to_system_status,
        from_kill_switch_active,
        to_kill_switch_active,
        reason,
        created_at
      )
      SELECT
        id,
        exchange_account_id,
        command,
        from_execution_mode,
        to_execution_mode,
        from_live_execution_gate,
        to_live_execution_gate,
        from_system_status,
        to_system_status,
        from_kill_switch_active,
        to_kill_switch_active,
        reason,
        created_at
      FROM ${sourceTable};
    `);
    db.exec(`DROP TABLE ${sourceTable};`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_execution_state_transitions_exchange_account_id
      ON execution_state_transitions(exchange_account_id, created_at DESC);
  `);
}

function rebuildRiskEvents(db: DatabaseSync): void {
  const legacyTableName = "risk_events_repair_legacy";
  const partialLegacyTableName = "risk_events_legacy_v2";

  if (tableExists(db, "risk_events")) {
    db.exec(`ALTER TABLE risk_events RENAME TO ${legacyTableName};`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_events (
      id TEXT PRIMARY KEY,
      exchange_account_id TEXT NOT NULL,
      strategy_decision_id TEXT,
      order_id TEXT,
      level TEXT NOT NULL CHECK (level IN ('INFO', 'WARN', 'BLOCK')),
      rule_code TEXT NOT NULL CHECK (
        rule_code IN (
          'GLOBAL_KILL_SWITCH',
          'EXECUTION_PAUSED',
          'SYSTEM_DEGRADED',
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
          'ORDER_RECOVERY_REQUIRED',
          'BALANCE_DRIFT_DETECTED',
          'POSITION_DRIFT_DETECTED',
          'POSITION_GUARD_PILOT_UNCERTAIN_ORDER',
          'ACCOUNT_EXECUTION_LEASE_BLOCKED'
        )
      ),
      message TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (strategy_decision_id) REFERENCES strategy_decisions(id) ON DELETE SET NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
    );
  `);

  for (const sourceTable of [legacyTableName, partialLegacyTableName]) {
    if (!tableExists(db, sourceTable)) {
      continue;
    }

    db.exec(`
      INSERT OR IGNORE INTO risk_events (
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
      FROM ${sourceTable};
    `);
    db.exec(`DROP TABLE ${sourceTable};`);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_risk_events_exchange_account_id
      ON risk_events(exchange_account_id, created_at DESC);
  `);
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName) as { name: string } | undefined;

  return Boolean(row);
}

function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}
