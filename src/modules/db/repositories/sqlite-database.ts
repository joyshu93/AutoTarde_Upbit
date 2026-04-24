import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SqliteDatabaseHandle {
  db: DatabaseSync;
  close(): void;
}

export function openSqliteDatabase(databasePath: string): SqliteDatabaseHandle {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");

  ensureMigrationTable(db);
  applyMigrations(db, resolve(process.cwd(), "migrations"));

  return {
    db,
    close() {
      db.close();
    },
  };
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
  const filenames = readdirSync(migrationsDir)
    .filter((filename) => extname(filename) === ".sql")
    .sort((left, right) => left.localeCompare(right));

  const appliedStatement = db.prepare("SELECT filename FROM _schema_migrations WHERE filename = ?");
  const insertStatement = db.prepare("INSERT INTO _schema_migrations (filename, applied_at) VALUES (?, ?)");

  for (const filename of filenames) {
    const applied = appliedStatement.get(filename) as { filename: string } | undefined;
    if (applied) {
      continue;
    }

    const migrationSql = readFileSync(join(migrationsDir, filename), "utf8");
    try {
      db.exec(migrationSql);
    } catch (error) {
      if (filename === "0005_add_startup_degraded_policy_and_portfolio_drift_codes.sql") {
        repairMigration0005(db);
      } else if (filename === "0006_add_operator_notification_retry_metadata.sql") {
        repairMigration0006(db);
      } else if (filename === "0007_add_operator_notification_delivery_leases.sql") {
        repairMigration0007(db);
      } else if (filename === "0008_add_operator_notification_delivery_attempt_history.sql") {
        repairMigration0008(db);
      } else {
        throw error;
      }
    }
    insertStatement.run(filename, new Date().toISOString());
  }
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
          'POSITION_DRIFT_DETECTED'
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
