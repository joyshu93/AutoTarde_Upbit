import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createSqlitePersistence } from "../src/modules/db/repositories/sqlite-repositories.js";
import { openSqliteDatabase } from "../src/modules/db/repositories/sqlite-database.js";
import { SqliteCandidatePilotRepository } from
  "../src/modules/db/repositories/sqlite-candidate-pilot-repository.js";
import { SqliteAccountExecutionLeaseStore } from
  "../src/modules/db/repositories/sqlite-account-execution-lease-store.js";
import { test } from "./harness.js";
import {
  advanceInput,
  initialDeploymentInput,
  verifyCandidatePilotRepositoryContract,
  verifyCandidatePilotIdentityValidation,
  verifyDeploymentScopedEvidenceIdentityContract,
  verifyMixedOffsetReplayContract,
  verifyPreEpochEvidenceRejectionContract,
} from "./candidate-pilot-repository-contract.test.js";
import { verifyAccountExecutionLeaseContract } from "./account-execution-lease-contract.test.js";

const MIGRATION_0018 = "0018_scope_candidate_evidence_identity_to_deployment.sql";
const MIGRATION_0019 = "0019_store_candidate_evidence_decimals_as_text.sql";

test("sqlite candidate pilot repository satisfies the common contracts", async () => {
  await withFreshBundle("candidate-contract", async (bundle) => {
    await verifyCandidatePilotRepositoryContract(() => bundle.candidatePilots);
  });
  await withFreshBundle("candidate-offset", async (bundle) => {
    await verifyMixedOffsetReplayContract(() => bundle.candidatePilots);
  });
  await withFreshBundle("candidate-identity", async (bundle) => {
    await verifyCandidatePilotIdentityValidation(() => bundle.candidatePilots);
  });
});

test("migration 0019 stores canonical candidate evidence decimals as exact text", async () => {
  await withFreshBundle("candidate-exact-decimals", async (bundle, _databasePath, db) => {
    const deployment = await bundle.candidatePilots.createDeploymentWithInitialState(
      initialDeploymentInput("candidate-exact-decimals"),
    );
    await bundle.candidatePilots.advanceStateWithEvidence(
      advanceInput(deployment.id, "exact-decimal-evidence", 0, {
        executedQuantity: "0.123456789123456789",
        grossQuoteValueKrw: "12345678.987654321",
        confirmedFeeKrw: "1234.567890123",
        remainingQuantity: "0.123456789123456789",
      }),
    );

    const migration = db.prepare(
      "SELECT filename FROM _schema_migrations WHERE filename = ?",
    ).get(MIGRATION_0019) as { filename: string } | undefined;
    const evidence = db.prepare(`
      SELECT
        typeof(executed_quantity) AS executed_quantity_type,
        executed_quantity,
        gross_quote_value_krw,
        confirmed_fee_krw,
        remaining_quantity
      FROM strategy_candidate_execution_evidence
      WHERE deployment_id = ? AND id = ?
    `).get(deployment.id, "exact-decimal-evidence") as {
      executed_quantity_type: string;
      executed_quantity: string;
      gross_quote_value_krw: string;
      confirmed_fee_krw: string;
      remaining_quantity: string;
    } | undefined;

    assert.equal(migration?.filename, MIGRATION_0019);
    assert.equal(evidence?.executed_quantity_type, "text");
    assert.equal(evidence?.executed_quantity, "0.123456789123456789");
    assert.equal(evidence?.gross_quote_value_krw, "12345678.987654321");
    assert.equal(evidence?.confirmed_fee_krw, "1234.567890123");
    assert.equal(evidence?.remaining_quantity, "0.123456789123456789");
    assertDatabaseIntegrity(db);
  });
});

test("migration 0019 upgrades existing candidate evidence without losing state", async () => {
  const databasePath = await createTempDatabasePath("upgrade-0019");
  await createAppliedOriginal0017Fixture(databasePath);

  const before = new DatabaseSync(databasePath);
  try {
    before.exec(await readFile(path.resolve(process.cwd(), "migrations", MIGRATION_0018), "utf8"));
    before.prepare(
      "INSERT INTO _schema_migrations (filename, applied_at) VALUES (?, ?)",
    ).run(MIGRATION_0018, "2026-08-21T00:00:00.000Z");
    const repository = new SqliteCandidatePilotRepository(before);
    await repository.advanceStateWithEvidence(
      advanceInput("original-0017-primary", "pre-0019-evidence", 1, {
        action: "ADD",
        executedAt: "2026-08-21T00:00:02.000Z",
        executedQuantity: 0.1,
        grossQuoteValueKrw: 10_000_000,
        confirmedFeeKrw: 5_000,
        remainingQuantity: 0.2,
      }),
    );
  } finally {
    before.close();
  }

  const handle = openSqliteDatabase(databasePath);
  try {
    const migration = handle.db.prepare(
      "SELECT filename FROM _schema_migrations WHERE filename = ?",
    ).get(MIGRATION_0019) as { filename: string } | undefined;
    const evidence = handle.db.prepare(`
      SELECT typeof(executed_quantity) AS value_type, executed_quantity
      FROM strategy_candidate_execution_evidence
      WHERE deployment_id = ? AND id = ?
    `).get("original-0017-primary", "pre-0019-evidence") as {
      value_type: string;
      executed_quantity: string;
    } | undefined;
    const repository = new SqliteCandidatePilotRepository(handle.db);

    assert.equal(migration?.filename, MIGRATION_0019);
    assert.equal(evidence?.value_type, "text");
    assert.equal(evidence?.executed_quantity, "0.1");
    assert.equal((await repository.getState("original-0017-primary"))?.stateVersion, 2);
    assertDatabaseIntegrity(handle.db);
  } finally {
    handle.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("sqlite candidate evidence identity is scoped to its deployment", async () => {
  await withFreshBundle("candidate-scoped-evidence", async (bundle, _databasePath, db) => {
    insertSecondaryExchangeAccount(db);
    await verifyDeploymentScopedEvidenceIdentityContract(() => bundle.candidatePilots);
    assertDatabaseIntegrity(db);
  });
});

test("sqlite candidate pilot rejects pre-epoch evidence without mutation", async () => {
  await withFreshBundle("candidate-pre-epoch", async (bundle, _databasePath, db) => {
    await verifyPreEpochEvidenceRejectionContract(() => bundle.candidatePilots);
    assertDatabaseIntegrity(db);
  });
});

test("sqlite pilot connections retain foreign keys and the five-second busy timeout", async () => {
  await withFreshBundle("connection-pragmas", async (_bundle, _databasePath, db) => {
    const foreignKeys = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    const busyTimeout = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    assert.equal(foreignKeys.foreign_keys, 1);
    assert.equal(busyTimeout.timeout, 5_000);
  });
});

test("sqlite account execution lease store satisfies the common contract", async () => {
  await withFreshBundle("lease-contract", async (bundle, databasePath, db) => {
    await verifyAccountExecutionLeaseContract(() => ({
      store: bundle.accountExecutionLeases,
      setBlockingOrder(active) {
        if (active) {
          insertOrder(db, "blocking-order", "OPEN");
        } else {
          db.prepare("DELETE FROM orders WHERE id = ?")
            .run("blocking-order");
        }
      },
    }));
    assertDatabaseIntegrity(db);
    assert.ok(databasePath.endsWith(".sqlite"));
  });
});

test("migration 0017 reserves exact values and preserves pre-0017 rows and delivery foreign keys", async () => {
  const databasePath = await createTempDatabasePath("upgrade");
  await createPre0017Fixture(databasePath);

  const handle = openSqliteDatabase(databasePath);
  try {
    assert.equal((handle.db.prepare(
      "SELECT COUNT(*) AS count FROM operator_notifications WHERE id = 'legacy-notification'",
    ).get() as { count: number }).count, 1);
    assert.equal((handle.db.prepare(
      "SELECT COUNT(*) AS count FROM operator_notification_delivery_attempts WHERE id = 'legacy-attempt'",
    ).get() as { count: number }).count, 1);
    assert.equal((handle.db.prepare(
      "SELECT COUNT(*) AS count FROM execution_state_transitions WHERE id = 'legacy-transition'",
    ).get() as { count: number }).count, 1);
    assert.equal((handle.db.prepare(
      "SELECT COUNT(*) AS count FROM risk_events WHERE id = 'legacy-risk'",
    ).get() as { count: number }).count, 1);

    for (const notificationType of [
      "POSITION_GUARD_PILOT_ACTIVATED",
      "POSITION_GUARD_PILOT_FAULT_PAUSED",
      "POSITION_GUARD_PILOT_UNCERTAIN_SUBMISSION",
      "POSITION_GUARD_PILOT_ROLLBACK_STARTED",
      "POSITION_GUARD_PILOT_ROLLBACK_COMPLETED",
    ]) {
      insertNotification(handle.db, `notification-${notificationType}`, notificationType);
    }
    for (const ruleCode of [
      "POSITION_GUARD_PILOT_IDENTITY_MISMATCH",
      "POSITION_GUARD_PILOT_REPLAY_MISMATCH",
      "POSITION_GUARD_PILOT_STALE_SNAPSHOT",
      "POSITION_GUARD_PILOT_BLOCKING_RECONCILIATION",
      "POSITION_GUARD_PILOT_ACTIVE_ORDER",
      "POSITION_GUARD_PILOT_UNCERTAIN_ORDER",
      "ACCOUNT_EXECUTION_LEASE_BLOCKED",
    ]) {
      insertRisk(handle.db, `risk-${ruleCode}`, ruleCode);
    }
    insertTransition(handle.db, "automatic-pause", "AUTOMATIC_PAUSE");

    const migration = handle.db.prepare(
      "SELECT filename FROM _schema_migrations WHERE filename = ?",
    ).get("0017_add_btc_candidate_live_pilot.sql") as { filename: string } | undefined;
    assert.equal(migration?.filename, "0017_add_btc_candidate_live_pilot.sql");
    assertCompositeEvidenceIdentity(handle.db);
    assertDatabaseIntegrity(handle.db);
  } finally {
    handle.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("migration 0018 upgrades a recorded original 0017 without losing pilot state", async () => {
  const databasePath = await createTempDatabasePath("upgrade-original-0017");
  await createAppliedOriginal0017Fixture(databasePath);

  const handle = openSqliteDatabase(databasePath);
  try {
    const migration = handle.db.prepare(
      "SELECT filename FROM _schema_migrations WHERE filename = ?",
    ).get(MIGRATION_0018) as { filename: string } | undefined;
    assert.equal(migration?.filename, MIGRATION_0018);
    assertCompositeEvidenceIdentity(handle.db);

    const existingEvidence = handle.db.prepare(`
      SELECT id, deployment_id, material_hash
      FROM strategy_candidate_execution_evidence
      WHERE deployment_id = ? AND id = ?
    `).get("original-0017-primary", "original-evidence") as {
      id: string;
      deployment_id: string;
      material_hash: string;
    } | undefined;
    assert.equal(existingEvidence?.deployment_id, "original-0017-primary");
    assert.equal(existingEvidence?.id, "original-evidence");
    assert.equal(existingEvidence?.material_hash.length, 64);

    const repository = new SqliteCandidatePilotRepository(handle.db);
    const existingState = await repository.getState("original-0017-primary");
    assert.equal(existingState?.stateVersion, 1);
    assert.equal(existingState?.lastEvidenceId, "original-evidence");
    assert.equal((await repository.getState("original-0017-secondary"))?.stateVersion, 0);

    assert.throws(() => handle.db.prepare(`
      UPDATE strategy_candidate_execution_evidence
      SET id = id
      WHERE deployment_id = ? AND id = ?
    `).run("original-0017-primary", "original-evidence"), /append-only/i);
    assert.throws(() => handle.db.prepare(`
      DELETE FROM strategy_candidate_execution_evidence
      WHERE deployment_id = ? AND id = ?
    `).run("original-0017-primary", "original-evidence"), /append-only/i);

    await repository.advanceStateWithEvidence(
      advanceInput("original-0017-primary", "shared-after-upgrade", 1, {
        action: "ADD",
        executedAt: "2026-08-21T00:00:02.000Z",
        remainingQuantity: 0.2,
      }),
    );
    await repository.advanceStateWithEvidence(
      advanceInput("original-0017-secondary", "shared-after-upgrade", 0),
    );
    const sharedRows = handle.db.prepare(`
      SELECT deployment_id
      FROM strategy_candidate_execution_evidence
      WHERE id = ?
      ORDER BY deployment_id ASC
    `).all("shared-after-upgrade") as unknown as Array<{ deployment_id: string }>;
    assert.deepEqual(
      sharedRows.map((row) => row.deployment_id),
      ["original-0017-primary", "original-0017-secondary"],
    );
    assertDatabaseIntegrity(handle.db);
  } finally {
    handle.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("migration 0018 remains valid after fresh current composite 0017", async () => {
  await withFreshBundle("migration-0018-fresh", async (_bundle, _databasePath, db) => {
    const migration = db.prepare(
      "SELECT filename FROM _schema_migrations WHERE filename = ?",
    ).get(MIGRATION_0018) as { filename: string } | undefined;
    assert.equal(migration?.filename, MIGRATION_0018);
    assertCompositeEvidenceIdentity(db);
    assertDatabaseIntegrity(db);
  });
});

test("migration 0018 rolls back its evidence and state rebuild atomically", async () => {
  const databasePath = await createTempDatabasePath("rollback-0018");
  await createAppliedOriginal0017Fixture(databasePath);

  try {
    const before = new DatabaseSync(databasePath);
    before.exec("ALTER TABLE strategy_candidate_execution_evidence DROP COLUMN material_hash;");
    before.close();

    let unexpectedHandle: ReturnType<typeof openSqliteDatabase> | undefined;
    try {
      assert.throws(() => {
        unexpectedHandle = openSqliteDatabase(databasePath);
      }, /material_hash/i);
    } finally {
      unexpectedHandle?.close();
    }

    const after = new DatabaseSync(databasePath);
    try {
      const migration = after.prepare(
        "SELECT filename FROM _schema_migrations WHERE filename = ?",
      ).get(MIGRATION_0018);
      const legacyTables = after.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE '%0018_legacy%'
      `).all();
      assert.equal(migration, undefined);
      assert.deepEqual(legacyTables, []);
      assertGlobalEvidenceIdentity(after);
      assert.equal((after.prepare(`
        SELECT COUNT(*) AS count
        FROM strategy_candidate_execution_evidence
        WHERE deployment_id = ? AND id = ?
      `).get("original-0017-primary", "original-evidence") as { count: number }).count, 1);
      assert.equal((after.prepare(`
        SELECT COUNT(*) AS count
        FROM strategy_candidate_states
        WHERE deployment_id IN (?, ?)
      `).get("original-0017-primary", "original-0017-secondary") as { count: number }).count, 2);
      assert.throws(() => after.prepare(`
        UPDATE strategy_candidate_execution_evidence
        SET id = id
        WHERE deployment_id = ? AND id = ?
      `).run("original-0017-primary", "original-evidence"), /append-only/i);
      assertDatabaseIntegrity(after);
    } finally {
      after.close();
    }
  } finally {
    await cleanupTempDatabase(databasePath);
  }
});

test("migration 0017 rolls back every rebuild when legacy copy fails", async () => {
  const databasePath = await createTempDatabasePath("rollback");
  await createPre0017Fixture(databasePath);
  const before = new DatabaseSync(databasePath);
  before.exec("ALTER TABLE operator_notifications DROP COLUMN lease_expires_at;");
  before.close();

  assert.throws(() => openSqliteDatabase(databasePath));

  const after = new DatabaseSync(databasePath);
  try {
    const row = after.prepare(
      "SELECT id FROM operator_notifications WHERE id = 'legacy-notification'",
    ).get() as { id: string } | undefined;
    const migration = after.prepare(
      "SELECT filename FROM _schema_migrations WHERE filename = ?",
    ).get("0017_add_btc_candidate_live_pilot.sql");
    const legacyTables = after.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE '%0017_legacy%'
    `).all();
    assert.equal(row?.id, "legacy-notification");
    assert.equal(migration, undefined);
    assert.deepEqual(legacyTables, []);
    const integrity = after.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    assert.equal(integrity.integrity_check, "ok");
  } finally {
    after.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("pilot evidence, audit, and recovery observations are append-only", async () => {
  await withFreshBundle("append-only", async (bundle, _databasePath, db) => {
    const deployment = await bundle.candidatePilots.createDeploymentWithInitialState(
      initialDeploymentInput("deployment-append-only"),
    );
    await bundle.candidatePilots.advanceStateWithEvidence(
      advanceInput(deployment.id, "append-only-evidence", 0),
    );
    insertOrder(db, "recovery-order", "RECONCILIATION_REQUIRED");
    db.prepare(`
      INSERT INTO order_submission_recovery_observations (
        id, order_id, outcome, observed_at, observed_at_epoch_ms, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "recovery-observation",
      "recovery-order",
      "TRANSIENT_FAILURE",
      "2026-08-21T00:00:02.000Z",
      1_776_902_402_000,
      "{}",
      "2026-08-21T00:00:02.000Z",
    );

    for (const [tableName, id] of [
      ["strategy_candidate_execution_evidence", "append-only-evidence"],
      ["strategy_pilot_audit_events", `${deployment.id}:evidence:append-only-evidence`],
      ["order_submission_recovery_observations", "recovery-observation"],
    ] as const) {
      assert.throws(() => db.prepare(
        `UPDATE ${tableName} SET id = id WHERE id = ?`,
      ).run(id), /append-only/i);
      assert.throws(() => db.prepare(
        `DELETE FROM ${tableName} WHERE id = ?`,
      ).run(id), /append-only/i);
    }
    assertDatabaseIntegrity(db);
  });
});

test("candidate evidence insert, state CAS, and audit roll back as one transaction", async () => {
  await withFreshBundle("atomic-rollback", async (bundle, _databasePath, db) => {
    const deployment = await bundle.candidatePilots.createDeploymentWithInitialState(
      initialDeploymentInput("deployment-rollback"),
    );
    db.exec(`
      CREATE TRIGGER fail_candidate_audit_for_test
      BEFORE INSERT ON strategy_pilot_audit_events
      WHEN NEW.event_type = 'STATE_ADVANCED'
      BEGIN
        SELECT RAISE(ABORT, 'injected audit failure');
      END;
    `);

    await assert.rejects(
      () => bundle.candidatePilots.advanceStateWithEvidence(
        advanceInput(deployment.id, "rollback-evidence", 0),
      ),
      /injected audit failure/i,
    );
    assert.equal((await bundle.candidatePilots.getState(deployment.id))?.stateVersion, 0);
    assert.deepEqual(await bundle.candidatePilots.listEvidenceAfter(deployment.id, null), []);
    assert.equal((await bundle.candidatePilots.listAuditEvents(deployment.id)).length, 1);
    assertDatabaseIntegrity(db);
  });
});

test("two sqlite connections produce one lease winner and stale owners cannot mutate takeover", async () => {
  const databasePath = await createTempDatabasePath("lease-concurrency");
  const bootstrap = createBundle(databasePath);
  bootstrap.close();
  const firstHandle = openSqliteDatabase(databasePath);
  const secondHandle = openSqliteDatabase(databasePath);
  try {
    const firstStore = new SqliteAccountExecutionLeaseStore(firstHandle.db);
    const secondStore = new SqliteAccountExecutionLeaseStore(secondHandle.db);
    const [first, second] = await Promise.all([
      firstStore.acquireLease({
        exchangeAccountId: "primary",
        ownerToken: "process-one",
        purpose: "ORDER_SUBMISSION",
        acquiredAtEpochMs: 1_000,
        expiresAtEpochMs: 2_000,
      }),
      secondStore.acquireLease({
        exchangeAccountId: "primary",
        ownerToken: "process-two",
        purpose: "ORDER_SUBMISSION",
        acquiredAtEpochMs: 1_000,
        expiresAtEpochMs: 2_000,
      }),
    ]);
    assert.equal([first, second].filter((lease) => lease !== null).length, 1);

    const winner = first ?? second;
    assert.ok(winner);
    const takeoverStore = winner.ownerToken === "process-one" ? secondStore : firstStore;
    const staleStore = winner.ownerToken === "process-one" ? firstStore : secondStore;
    const takeover = await takeoverStore.acquireLease({
      exchangeAccountId: "primary",
      ownerToken: "takeover",
      purpose: "ORDER_SUBMISSION",
      acquiredAtEpochMs: 3_000,
      expiresAtEpochMs: 4_000,
    });
    assert.equal(takeover?.ownerToken, "takeover");
    assert.equal(await staleStore.renewLease({
      exchangeAccountId: "primary",
      ownerToken: winner.ownerToken,
      renewedAtEpochMs: 3_100,
      expiresAtEpochMs: 4_100,
    }), null);
    assert.equal(await staleStore.releaseLease("primary", winner.ownerToken), false);
    assert.equal((await takeoverStore.getLease("primary"))?.ownerToken, "takeover");
    assertDatabaseIntegrity(firstHandle.db);
  } finally {
    firstHandle.close();
    secondHandle.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("expired sqlite lease cannot be stolen with active or reconciliation-required orders", async () => {
  await withFreshBundle("lease-order-block", async (bundle, _databasePath, db) => {
    const store = bundle.accountExecutionLeases;
    await store.acquireLease({
      exchangeAccountId: "primary",
      ownerToken: "expired",
      purpose: "ORDER_SUBMISSION",
      acquiredAtEpochMs: 1_000,
      expiresAtEpochMs: 2_000,
    });

    for (const status of ["OPEN", "RECONCILIATION_REQUIRED"] as const) {
      const orderId = `blocking-${status}`;
      insertOrder(db, orderId, status);
      assert.equal(await store.acquireLease({
        exchangeAccountId: "primary",
        ownerToken: `contender-${status}`,
        purpose: "ORDER_SUBMISSION",
        acquiredAtEpochMs: 3_000,
        expiresAtEpochMs: 4_000,
      }), null);
      db.prepare("DELETE FROM orders WHERE id = ?").run(orderId);
    }
  });
});

function createBundle(databasePath: string): ReturnType<typeof createSqlitePersistence> {
  return createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "pilot-user",
    userTelegramId: "pilot-telegram-user",
    userDisplayName: "Pilot Operator",
    accessKeyRef: "secret://upbit/access",
    secretKeyRef: "secret://upbit/secret",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    killSwitchActive: false,
  });
}

async function withFreshBundle(
  label: string,
  run: (
    bundle: ReturnType<typeof createSqlitePersistence>,
    databasePath: string,
    db: DatabaseSync,
  ) => Promise<void>,
): Promise<void> {
  const databasePath = await createTempDatabasePath(label);
  const bundle = createBundle(databasePath);
  const rawHandle = openSqliteDatabase(databasePath);
  try {
    await run(bundle, databasePath, rawHandle.db);
  } finally {
    rawHandle.close();
    bundle.close();
    await cleanupTempDatabase(databasePath);
  }
}

async function createTempDatabasePath(label: string): Promise<string> {
  const directory = path.resolve(process.cwd(), ".tmp-db-tests");
  await mkdir(directory, { recursive: true });
  return path.join(directory, `pilot-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

async function cleanupTempDatabase(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
}

async function createPre0017Fixture(databasePath: string): Promise<void> {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE _schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const migrations = (await readdir(path.resolve(process.cwd(), "migrations")))
      .filter((filename) => filename.endsWith(".sql"))
      .filter((filename) => filename.slice(0, 4) < "0017")
      .sort((left, right) => left.localeCompare(right));
    const fixtureMigrations = new Set([
      "0001_initial.sql",
      "0005_add_startup_degraded_policy_and_portfolio_drift_codes.sql",
      "0009_add_history_recovery_checkpoints.sql",
      "0010_add_operator_notification_delivery_runs.sql",
      "0011_add_strategy_scheduler_runs.sql",
      "0012_add_telegram_inbound_offsets.sql",
      "0014_extend_scheduler_operator_notification_types.sql",
      "0015_add_scheduler_startup_blocked_notification_type.sql",
      "0016_add_pending_confirmation_strategy_decision_status.sql",
    ]);
    const recordMigration = db.prepare(
      "INSERT INTO _schema_migrations (filename, applied_at) VALUES (?, ?)",
    );
    for (const filename of migrations) {
      if (fixtureMigrations.has(filename)) {
        db.exec(await readFile(path.resolve(process.cwd(), "migrations", filename), "utf8"));
      }
      recordMigration.run(filename, "2026-08-21T00:00:00.000Z");
    }
    db.prepare(`
      INSERT INTO users (
        id, telegram_user_id, telegram_chat_id, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("legacy-user", "legacy-telegram", null, "Legacy", "2026-08-21T00:00:00Z", "2026-08-21T00:00:00Z");
    db.prepare(`
      INSERT INTO exchange_accounts (
        id, user_id, exchange, venue_type, account_label, access_key_ref, secret_key_ref,
        quote_currency, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "primary", "legacy-user", "UPBIT", "SPOT", "primary", "legacy-access",
      "legacy-secret", "KRW", 1, "2026-08-21T00:00:00Z", "2026-08-21T00:00:00Z",
    );
    insertNotification(db, "legacy-notification", "SCHEDULER_STARTUP_BLOCKED");
    db.prepare(`
      INSERT INTO operator_notification_delivery_attempts (
        id, notification_id, exchange_account_id, attempt_count, lease_token, outcome,
        failure_class, attempted_at, next_attempt_at, delivered_at, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-attempt", "legacy-notification", "primary", 1, "lease", "SENT", null,
      "2026-08-21T00:00:01Z", null, "2026-08-21T00:00:01Z", null,
      "2026-08-21T00:00:01Z",
    );
    insertTransition(db, "legacy-transition", "CLEAR_DEGRADED");
    insertRisk(db, "legacy-risk", "POSITION_DRIFT_DETECTED");
    assertDatabaseIntegrity(db);
  } finally {
    db.close();
  }
}

async function createAppliedOriginal0017Fixture(databasePath: string): Promise<void> {
  await createPre0017Fixture(databasePath);
  const current0017 = await readFile(
    path.resolve(process.cwd(), "migrations", "0017_add_btc_candidate_live_pilot.sql"),
    "utf8",
  );
  const original0017 = current0017
    .replace(
      /CREATE TABLE strategy_candidate_execution_evidence \(\r?\n  deployment_id TEXT NOT NULL,\r?\n  id TEXT NOT NULL,/u,
      "CREATE TABLE strategy_candidate_execution_evidence (\n" +
        "  id TEXT PRIMARY KEY,\n" +
        "  deployment_id TEXT NOT NULL,",
    )
    .replace(
      /  PRIMARY KEY \(deployment_id, id\)\r?\n\);/u,
      "  UNIQUE (deployment_id, id)\n);",
    );
  assert.notEqual(original0017, current0017);

  const db = new DatabaseSync(databasePath);
  try {
    db.exec(original0017);
    db.prepare(
      "INSERT INTO _schema_migrations (filename, applied_at) VALUES (?, ?)",
    ).run("0017_add_btc_candidate_live_pilot.sql", "2026-08-21T00:00:00.000Z");
    insertSecondaryExchangeAccount(db);

    const repository = new SqliteCandidatePilotRepository(db);
    await repository.createDeploymentWithInitialState(
      initialDeploymentInput("original-0017-primary", "primary"),
    );
    await repository.createDeploymentWithInitialState(
      initialDeploymentInput("original-0017-secondary", "secondary"),
    );
    await repository.advanceStateWithEvidence(
      advanceInput("original-0017-primary", "original-evidence", 0),
    );

    assertGlobalEvidenceIdentity(db);
    assertDatabaseIntegrity(db);
  } finally {
    db.close();
  }
}

function insertNotification(db: DatabaseSync, id: string, type: string): void {
  db.prepare(`
    INSERT INTO operator_notifications (
      id, exchange_account_id, channel, notification_type, severity, title, message,
      payload_json, delivery_status, attempt_count, last_attempt_at, next_attempt_at,
      failure_class, lease_token, lease_expires_at, created_at, delivered_at, last_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, "primary", "TELEGRAM", type, "WARN", "title", "message", "{}", "PENDING", 0,
    null, null, null, null, null, "2026-08-21T00:00:00Z", null, null,
  );
}

function insertSecondaryExchangeAccount(db: DatabaseSync): void {
  db.prepare(`
    INSERT INTO exchange_accounts (
      id, user_id, exchange, venue_type, account_label, access_key_ref, secret_key_ref,
      quote_currency, is_primary, created_at, updated_at
    )
    SELECT ?, user_id, exchange, venue_type, ?, access_key_ref, secret_key_ref,
      quote_currency, 0, created_at, updated_at
    FROM exchange_accounts
    WHERE id = ?
  `).run("secondary", "secondary", "primary");
}

function assertCompositeEvidenceIdentity(db: DatabaseSync): void {
  const columns = db.prepare(
    "PRAGMA table_info(strategy_candidate_execution_evidence)",
  ).all() as Array<{ name: string; pk: number }>;
  assert.equal(columns.find((column) => column.name === "deployment_id")?.pk, 1);
  assert.equal(columns.find((column) => column.name === "id")?.pk, 2);

  const foreignKeys = db.prepare(
    "PRAGMA foreign_key_list(strategy_candidate_states)",
  ).all() as Array<{ id: number; seq: number; table: string; from: string; to: string }>;
  const evidenceReference = foreignKeys
    .filter((foreignKey) => foreignKey.table === "strategy_candidate_execution_evidence")
    .sort((left, right) => left.seq - right.seq);
  assert.deepEqual(
    evidenceReference.map((foreignKey) => [foreignKey.from, foreignKey.to]),
    [["deployment_id", "deployment_id"], ["last_evidence_id", "id"]],
  );
  assert.equal(new Set(evidenceReference.map((foreignKey) => foreignKey.id)).size, 1);

  const replayIndex = db.prepare(
    "PRAGMA index_info(idx_strategy_candidate_evidence_replay)",
  ).all() as Array<{ seqno: number; name: string }>;
  assert.deepEqual(
    replayIndex.sort((left, right) => left.seqno - right.seqno).map((column) => column.name),
    ["deployment_id", "executed_at_epoch_ns", "id"],
  );
}

function assertGlobalEvidenceIdentity(db: DatabaseSync): void {
  const columns = db.prepare(
    "PRAGMA table_info(strategy_candidate_execution_evidence)",
  ).all() as Array<{ name: string; pk: number }>;
  assert.equal(columns.find((column) => column.name === "id")?.pk, 1);
  assert.equal(columns.find((column) => column.name === "deployment_id")?.pk, 0);
}

function insertRisk(db: DatabaseSync, id: string, ruleCode: string): void {
  db.prepare(`
    INSERT INTO risk_events (
      id, exchange_account_id, strategy_decision_id, order_id, level, rule_code,
      message, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, "primary", null, null, "BLOCK", ruleCode, "risk", "{}", "2026-08-21T00:00:00Z");
}

function insertTransition(db: DatabaseSync, id: string, command: string): void {
  db.prepare(`
    INSERT INTO execution_state_transitions (
      id, exchange_account_id, command, from_execution_mode, to_execution_mode,
      from_live_execution_gate, to_live_execution_gate, from_system_status,
      to_system_status, from_kill_switch_active, to_kill_switch_active, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, "primary", command, "DRY_RUN", "DRY_RUN", "DISABLED", "DISABLED", "RUNNING",
    "PAUSED", 0, 0, "test", "2026-08-21T00:00:00Z",
  );
}

function insertOrder(
  db: DatabaseSync,
  id: string,
  status: "OPEN" | "RECONCILIATION_REQUIRED",
): void {
  db.prepare(`
    INSERT INTO orders (
      id, strategy_decision_id, exchange_account_id, market, side, ord_type, volume,
      price, time_in_force, smp_type, identifier, idempotency_key, origin, requested_at,
      upbit_uuid, status, execution_mode, exchange_response_json, failure_code,
      failure_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, null, "primary", "KRW-BTC", "bid", "price", null, "10000", null, null,
    `${id}-identifier`, `${id}-idempotency`, "STRATEGY", "2026-08-21T00:00:00Z", null,
    status, "DRY_RUN", null, null, null, "2026-08-21T00:00:00Z", "2026-08-21T00:00:00Z",
  );
}

function assertDatabaseIntegrity(db: DatabaseSync): void {
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  assert.equal(integrity.integrity_check, "ok");
}
