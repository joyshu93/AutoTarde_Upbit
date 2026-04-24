import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  BalanceSnapshotRecord,
  OperatorNotificationRecord,
  PositionSnapshotRecord,
} from "../src/domain/types.js";
import { openSqliteDatabase } from "../src/modules/db/repositories/sqlite-database.js";
import { createSqlitePersistence } from "../src/modules/db/repositories/sqlite-repositories.js";
import {
  fromSqliteBoolean,
  parseJson,
  stringifyJson,
  toSqliteBoolean,
} from "../src/modules/db/repositories/sqlite-shapes.js";
import { test } from "./harness.js";

test("sqlite shape helpers preserve boolean and JSON payload values", () => {
  const payload = {
    market: "KRW-BTC",
    nested: {
      accepted: true,
      retries: 2,
    },
  } as const;

  assert.equal(toSqliteBoolean(true), 1);
  assert.equal(toSqliteBoolean(false), 0);
  assert.equal(fromSqliteBoolean(0), false);
  assert.equal(fromSqliteBoolean(5), true);
  assert.equal(stringifyJson(payload), JSON.stringify(payload));
  assert.deepEqual(parseJson<typeof payload>(JSON.stringify(payload)), payload);
});

test("openSqliteDatabase applies the initial migrations and exposes the durable tables", async () => {
  const databasePath = await createTempDatabasePath("migrations");
  const handle = openSqliteDatabase(databasePath);

  try {
    const migrationRows = handle.db.prepare(`
      SELECT filename FROM _schema_migrations ORDER BY filename ASC
    `).all() as Array<{ filename: string }>;
    const tableRows = handle.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC
    `).all() as Array<{ name: string }>;
    const tableNames = new Set(tableRows.map((row) => row.name));

    assert.ok(migrationRows.some((row) => row.filename === "0001_initial.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0003_add_operator_notifications.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0004_add_operator_notification_delivery_index.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0005_add_startup_degraded_policy_and_portfolio_drift_codes.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0006_add_operator_notification_retry_metadata.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0007_add_operator_notification_delivery_leases.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0008_add_operator_notification_delivery_attempt_history.sql"));

    for (const tableName of [
      "users",
      "exchange_accounts",
      "execution_state",
      "execution_state_transitions",
      "orders",
      "order_events",
      "fills",
      "balance_snapshots",
      "position_snapshots",
      "reconciliation_runs",
      "operator_notifications",
      "operator_notification_delivery_attempts",
      "risk_events",
    ]) {
      assert.ok(tableNames.has(tableName), `Expected migrated table ${tableName} to exist.`);
    }
  } finally {
    handle.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("createSqlitePersistence bootstraps operator state and round-trips app-facing snapshot contracts", async () => {
  const databasePath = await createTempDatabasePath("bundle");
  const bundle = createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "user-1",
    userTelegramId: "telegram-user-1",
    userDisplayName: "Primary Operator",
    accessKeyRef: "secret://upbit/access",
    secretKeyRef: "secret://upbit/secret",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    killSwitchActive: false,
  });

  try {
    const initialState = await bundle.operatorState.getState();
    const bootstrapTransitions = await bundle.operatorState.listTransitions();
    assert.equal(initialState.exchangeAccountId, "primary");
    assert.equal(initialState.executionMode, "DRY_RUN");
    assert.equal(initialState.liveExecutionGate, "DISABLED");
    assert.equal(initialState.systemStatus, "RUNNING");
    assert.equal(initialState.killSwitchActive, false);
    assert.equal(initialState.degradedReason, null);
    assert.equal(initialState.degradedAt, null);
    assert.equal(bootstrapTransitions[0]?.command, "BOOTSTRAP");

    const pausedState = await bundle.operatorState.pause("maintenance_window");
    assert.equal(pausedState.systemStatus, "PAUSED");
    assert.equal(pausedState.pauseReason, "maintenance_window");

    const resumedState = await bundle.operatorState.resume();
    assert.equal(resumedState.systemStatus, "RUNNING");
    assert.equal(resumedState.pauseReason, null);

    const degradedState = await bundle.operatorState.markDegraded("startup_portfolio_drift_detected");
    assert.equal(degradedState.systemStatus, "DEGRADED");
    assert.equal(degradedState.degradedReason, "startup_portfolio_drift_detected");
    assert.ok(degradedState.degradedAt);

    const resumedFromDegradedState = await bundle.operatorState.pause("maintenance_window_2");
    assert.equal(resumedFromDegradedState.systemStatus, "PAUSED");
    assert.equal(resumedFromDegradedState.degradedReason, "startup_portfolio_drift_detected");

    const restoredDegradedState = await bundle.operatorState.resume();
    assert.equal(restoredDegradedState.systemStatus, "DEGRADED");
    assert.equal(restoredDegradedState.degradedReason, "startup_portfolio_drift_detected");

    const clearedDegradedState = await bundle.operatorState.clearDegraded("startup_recovery_clean");
    assert.equal(clearedDegradedState.systemStatus, "RUNNING");
    assert.equal(clearedDegradedState.degradedReason, null);
    assert.equal(clearedDegradedState.degradedAt, null);

    const killSwitchedState = await bundle.operatorState.activateKillSwitch("manual_stop");
    assert.equal(killSwitchedState.systemStatus, "KILL_SWITCHED");
    assert.equal(killSwitchedState.killSwitchActive, true);
    assert.equal(killSwitchedState.pauseReason, "manual_stop");

    const stickyResumeState = await bundle.operatorState.resume();
    assert.equal(stickyResumeState.systemStatus, "KILL_SWITCHED");
    assert.equal(stickyResumeState.killSwitchActive, true);

    const liveState = await bundle.operatorState.setExecutionMode("LIVE");
    assert.equal(liveState.executionMode, "LIVE");

    const enabledGateState = await bundle.operatorState.setLiveExecutionGate("ENABLED");
    assert.equal(enabledGateState.liveExecutionGate, "ENABLED");

    const transitions = await bundle.operatorState.listTransitions();
    assert.deepEqual(
      transitions.slice(0, 10).map((transition) => transition.command),
      [
        "SET_LIVE_EXECUTION_GATE",
        "SET_EXECUTION_MODE",
        "/resume",
        "/killswitch",
        "CLEAR_DEGRADED",
        "/resume",
        "/pause",
        "MARK_DEGRADED",
        "/resume",
        "/pause",
      ],
    );

    const balanceSnapshot: BalanceSnapshotRecord = {
      id: "balance-1",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:00:00.000Z",
      source: "EXCHANGE_POLL",
      totalKrwValue: "7500000",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "3500000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "90000000", unitCurrency: "KRW" },
      ]),
    };
    const positionSnapshot: PositionSnapshotRecord = {
      id: "position-1",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:00:00.000Z",
      source: "EXCHANGE_POLL",
      positionsJson: JSON.stringify([
        {
          asset: "BTC",
          market: "KRW-BTC",
          quantity: "0.01",
          averageEntryPrice: "90000000",
          markPrice: "100000000",
          marketValue: "1000000",
          exposureRatio: "0.13",
          capturedAt: "2026-04-20T00:00:00.000Z",
        },
        {
          asset: "ETH",
          market: "KRW-ETH",
          quantity: "1.00",
          averageEntryPrice: "2800000",
          markPrice: "3000000",
          marketValue: "3000000",
          exposureRatio: "0.40",
          capturedAt: "2026-04-20T00:00:00.000Z",
        },
      ]),
    };

    await bundle.repositories.saveBalanceSnapshot(balanceSnapshot);
    await bundle.repositories.savePositionSnapshot(positionSnapshot);

    const latestBalance = await bundle.repositories.getLatestBalanceSnapshot("primary");
    const latestPosition = await bundle.repositories.getLatestPositionSnapshot("primary");
    const exposure = await bundle.repositories.getPortfolioExposure("primary");

    assert.deepEqual(latestBalance, balanceSnapshot);
    assert.deepEqual(latestPosition, positionSnapshot);
    assert.equal(exposure.totalEquityKrw, 7_500_000);
    assert.equal(exposure.totalExposureKrw, 4_000_000);
    assert.deepEqual(exposure.assetExposureKrw, { BTC: 1_000_000, ETH: 3_000_000 });

    const storedPositions = parseJson<Array<{ asset: string; marketValue: string | null }>>(positionSnapshot.positionsJson);
    assert.deepEqual(
      storedPositions.map((position) => ({
        asset: position.asset,
        marketValue: position.marketValue,
      })),
      [
        { asset: "BTC", marketValue: "1000000" },
        { asset: "ETH", marketValue: "3000000" },
      ],
    );

    await bundle.repositories.saveRiskEvent({
      id: "risk-event-1",
      exchangeAccountId: "primary",
      strategyDecisionId: null,
      orderId: null,
      level: "WARN",
      ruleCode: "STALE_PRICE_GUARD",
      message: "Price snapshot is stale.",
      payloadJson: JSON.stringify({ ageMs: 120000 }),
      createdAt: "2026-04-20T00:01:00.000Z",
    });
    await bundle.repositories.saveRiskEvent({
      id: "risk-event-2",
      exchangeAccountId: "primary",
      strategyDecisionId: null,
      orderId: null,
      level: "BLOCK",
      ruleCode: "DUPLICATE_ORDER_GUARD",
      message: "A matching active order already exists.",
      payloadJson: JSON.stringify({ idempotencyKey: "duplicate-key" }),
      createdAt: "2026-04-20T00:02:00.000Z",
    });

    const latestRiskEvents = await bundle.repositories.listRiskEvents("primary", 1);
    assert.equal(latestRiskEvents.length, 1);
    assert.equal(latestRiskEvents[0]?.ruleCode, "DUPLICATE_ORDER_GUARD");

    await bundle.repositories.saveOperatorNotification(createNotification({
      id: "operator-notification-1",
      title: "Order rejected before submission",
      message: "Exchange order chance does not allow price orders for bid on KRW-BTC.",
      payloadJson: JSON.stringify({ market: "KRW-BTC" }),
      createdAt: "2026-04-20T00:03:00.000Z",
    }));

    const latestNotifications = await bundle.repositories.listOperatorNotifications("primary", 1);
    const pendingNotifications = await bundle.repositories.listPendingOperatorNotifications("primary", { limit: 5 });
    assert.equal(latestNotifications.length, 1);
    assert.equal(latestNotifications[0]?.notificationType, "ORDER_REJECTED");
    assert.equal(latestNotifications[0]?.deliveryStatus, "PENDING");
    assert.equal(latestNotifications[0]?.attemptCount, 0);
    assert.equal(pendingNotifications.length, 1);
    assert.equal(pendingNotifications[0]?.id, "operator-notification-1");

    const sentClaim = await bundle.repositories.claimPendingOperatorNotifications("primary", {
      limit: 1,
      dueBefore: "2026-04-20T00:03:05.000Z",
      claimedAt: "2026-04-20T00:03:05.000Z",
      leaseToken: "lease-sent-1",
      leaseExpiresAt: "2026-04-20T00:03:35.000Z",
    });
    assert.equal(sentClaim.length, 1);
    assert.equal(
      await bundle.repositories.compareAndSetOperatorNotificationDeliveryStatus({
        id: "operator-notification-1",
        leaseToken: "lease-sent-1",
        deliveryStatus: "SENT",
        attemptCount: sentClaim[0]?.attemptCount ?? 0,
        lastAttemptAt: "2026-04-20T00:03:05.000Z",
        nextAttemptAt: null,
        failureClass: null,
        deliveredAt: "2026-04-20T00:03:05.000Z",
        lastError: null,
      }),
      true,
    );

    const updatedNotifications = await bundle.repositories.listOperatorNotifications("primary", 1);
    const updatedPendingNotifications = await bundle.repositories.listPendingOperatorNotifications("primary", { limit: 5 });
    assert.equal(updatedNotifications[0]?.deliveryStatus, "SENT");
    assert.equal(updatedNotifications[0]?.attemptCount, 1);
    assert.equal(updatedNotifications[0]?.lastAttemptAt, "2026-04-20T00:03:05.000Z");
    assert.equal(updatedPendingNotifications.length, 0);

    await bundle.repositories.saveOperatorNotificationDeliveryAttempt({
      id: "attempt-1",
      notificationId: "operator-notification-1",
      exchangeAccountId: "primary",
      attemptCount: 1,
      leaseToken: "lease-sent-1",
      outcome: "SENT",
      failureClass: null,
      attemptedAt: "2026-04-20T00:03:05.000Z",
      nextAttemptAt: null,
      deliveredAt: "2026-04-20T00:03:05.000Z",
      errorMessage: null,
      createdAt: "2026-04-20T00:03:05.000Z",
    });

    const attemptRows = await bundle.repositories.listOperatorNotificationDeliveryAttempts("primary", 5);
    assert.equal(attemptRows.length, 1);
    assert.equal(attemptRows[0]?.notificationId, "operator-notification-1");
    assert.equal(attemptRows[0]?.outcome, "SENT");

    await bundle.repositories.saveOperatorNotification(createNotification({
      id: "operator-notification-2",
      notificationType: "SYNC_FAILED",
      severity: "ERROR",
      title: "Sync failed",
      message: "Failed to read balances from Upbit.",
      payloadJson: JSON.stringify({ stage: "getBalances" }),
      createdAt: "2026-04-20T00:03:10.000Z",
    }));
    await bundle.repositories.saveOperatorNotification(createNotification({
      id: "operator-notification-3",
      notificationType: "RECONCILIATION_DRIFT_DETECTED",
      title: "Reconciliation drift detected",
      message: "Detected 1 reconciliation issue(s).",
      payloadJson: JSON.stringify({ issueCount: 1 }),
      createdAt: "2026-04-20T00:03:20.000Z",
    }));

    const retryClaim = await bundle.repositories.claimPendingOperatorNotifications("primary", {
      limit: 1,
      dueBefore: "2026-04-20T00:03:15.000Z",
      claimedAt: "2026-04-20T00:03:15.000Z",
      leaseToken: "lease-retry-1",
      leaseExpiresAt: "2026-04-20T00:03:45.000Z",
    });
    assert.equal(retryClaim.length, 1);
    assert.equal(
      await bundle.repositories.compareAndSetOperatorNotificationDeliveryStatus({
        id: "operator-notification-2",
        leaseToken: "lease-retry-1",
        deliveryStatus: "PENDING",
        attemptCount: retryClaim[0]?.attemptCount ?? 0,
        lastAttemptAt: "2026-04-20T00:03:15.000Z",
        nextAttemptAt: "2026-04-20T00:04:15.000Z",
        failureClass: "RETRYABLE",
        deliveredAt: null,
        lastError: "telegram_http_500",
      }),
      true,
    );

    const oldestFirstPendingNotifications = await bundle.repositories.listPendingOperatorNotifications("primary", {
      limit: 5,
      dueBefore: "2026-04-20T00:04:20.000Z",
    });
    const limitedPendingNotifications = await bundle.repositories.listPendingOperatorNotifications("primary", {
      limit: 1,
      dueBefore: "2026-04-20T00:04:20.000Z",
    });
    assert.deepEqual(
      oldestFirstPendingNotifications.map((notification) => notification.id),
      ["operator-notification-3", "operator-notification-2"],
    );
    assert.deepEqual(
      limitedPendingNotifications.map((notification) => notification.id),
      ["operator-notification-3"],
    );

    const claimedNotifications = await bundle.repositories.claimPendingOperatorNotifications("primary", {
      limit: 5,
      dueBefore: "2026-04-20T00:04:20.000Z",
      claimedAt: "2026-04-20T00:04:20.000Z",
      leaseToken: "lease-a",
      leaseExpiresAt: "2026-04-20T00:04:50.000Z",
    });
    const competingClaim = await bundle.repositories.claimPendingOperatorNotifications("primary", {
      limit: 5,
      dueBefore: "2026-04-20T00:04:20.000Z",
      claimedAt: "2026-04-20T00:04:20.000Z",
      leaseToken: "lease-b",
      leaseExpiresAt: "2026-04-20T00:04:50.000Z",
    });
    assert.deepEqual(
      claimedNotifications.map((notification) => notification.id),
      ["operator-notification-3", "operator-notification-2"],
    );
    assert.equal(competingClaim.length, 0);

    assert.equal(
      await bundle.repositories.compareAndSetOperatorNotificationDeliveryStatus({
        id: "operator-notification-3",
        leaseToken: "lease-b",
        deliveryStatus: "FAILED",
        attemptCount: claimedNotifications.find((notification) => notification.id === "operator-notification-3")?.attemptCount ?? 0,
        lastAttemptAt: "2026-04-20T00:04:21.000Z",
        nextAttemptAt: null,
        failureClass: "PERMANENT",
        deliveredAt: null,
        lastError: "telegram_http_403",
      }),
      false,
    );

    assert.equal(
      await bundle.repositories.compareAndSetOperatorNotificationDeliveryStatus({
      id: "operator-notification-3",
      leaseToken: "lease-a",
      deliveryStatus: "FAILED",
      attemptCount: claimedNotifications.find((notification) => notification.id === "operator-notification-3")?.attemptCount ?? 0,
      lastAttemptAt: "2026-04-20T00:04:21.000Z",
      nextAttemptAt: null,
      failureClass: "PERMANENT",
      deliveredAt: null,
      lastError: "telegram_http_403",
      }),
      true,
    );

    const finalizedNotifications = await bundle.repositories.listOperatorNotifications("primary", 3);
    const finalizedNotification = finalizedNotifications.find((notification) => notification.id === "operator-notification-3");
    assert.equal(finalizedNotification?.leaseToken, null);
    assert.equal(finalizedNotification?.leaseExpiresAt, null);
  } finally {
    bundle.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("sqlite order updates preserve existing order events and fills", async () => {
  const databasePath = await createTempDatabasePath("order-history");
  const bundle = createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "user-2",
    userTelegramId: "telegram-user-2",
    userDisplayName: "History Operator",
    accessKeyRef: "secret://upbit/access",
    secretKeyRef: "secret://upbit/secret",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    killSwitchActive: false,
  });

  try {
    await bundle.repositories.saveOrder({
      id: "order-1",
      strategyDecisionId: null,
      exchangeAccountId: "primary",
      market: "KRW-BTC",
      side: "bid",
      ordType: "price",
      volume: null,
      price: "500000",
      timeInForce: null,
      smpType: null,
      identifier: "identifier-1",
      idempotencyKey: "idempotency-1",
      origin: "STRATEGY",
      requestedAt: "2026-04-20T00:00:00.000Z",
      upbitUuid: null,
      status: "PERSISTED",
      executionMode: "DRY_RUN",
      exchangeResponseJson: null,
      failureCode: null,
      failureMessage: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    });

    await bundle.repositories.appendOrderEvent({
      id: "order-event-1",
      orderId: "order-1",
      eventType: "ORDER_PERSISTED",
      eventSource: "LOCAL",
      payloadJson: JSON.stringify({ step: "persisted" }),
      createdAt: "2026-04-20T00:00:01.000Z",
    });

    await bundle.repositories.saveFill({
      id: "fill-1",
      orderId: "order-1",
      exchangeFillId: "exchange-fill-1",
      market: "KRW-BTC",
      side: "bid",
      price: "500000",
      volume: "0.005",
      feeCurrency: "KRW",
      feeAmount: "250",
      filledAt: "2026-04-20T00:00:02.000Z",
      rawPayloadJson: JSON.stringify({ fill: 1 }),
    });

    await bundle.repositories.updateOrder({
      id: "order-1",
      strategyDecisionId: null,
      exchangeAccountId: "primary",
      market: "KRW-BTC",
      side: "bid",
      ordType: "price",
      volume: null,
      price: "500000",
      timeInForce: null,
      smpType: null,
      identifier: "identifier-1",
      idempotencyKey: "idempotency-1",
      origin: "STRATEGY",
      requestedAt: "2026-04-20T00:00:00.000Z",
      upbitUuid: "uuid-1",
      status: "PARTIALLY_FILLED",
      executionMode: "DRY_RUN",
      exchangeResponseJson: JSON.stringify({ status: "open" }),
      failureCode: null,
      failureMessage: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:03.000Z",
    });
  } finally {
    bundle.close();
  }

  const handle = openSqliteDatabase(databasePath);
  try {
    const orderRow = handle.db.prepare(`
      SELECT status, upbit_uuid FROM orders WHERE id = ?
    `).get("order-1") as { status: string; upbit_uuid: string | null } | undefined;
    const orderEventCount = handle.db.prepare(`
      SELECT COUNT(*) AS count FROM order_events WHERE order_id = ?
    `).get("order-1") as { count: number };
    const fillCount = handle.db.prepare(`
      SELECT COUNT(*) AS count FROM fills WHERE order_id = ?
    `).get("order-1") as { count: number };

    assert.equal(orderRow?.status, "PARTIALLY_FILLED");
    assert.equal(orderRow?.upbit_uuid, "uuid-1");
    assert.equal(orderEventCount.count, 1);
    assert.equal(fillCount.count, 1);
  } finally {
    handle.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("compiled sqlite modules stay importable if a dedicated src/modules/db/sqlite folder is added later", async () => {
  const sqliteDir = path.resolve(process.cwd(), "dist", "src", "modules", "db", "sqlite");

  let entries;
  try {
    entries = await readdir(sqliteDir, { withFileTypes: true });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(sqliteDir, entry.name));

  assert.ok(files.length > 0, "Expected compiled sqlite modules when dist/src/modules/db/sqlite exists.");

  for (const filePath of files) {
    const module = await import(pathToFileURL(filePath).href);
    assert.equal(typeof module, "object");
  }
});

async function createTempDatabasePath(label: string): Promise<string> {
  const directory = path.resolve(process.cwd(), ".tmp-db-tests");
  await mkdir(directory, { recursive: true });
  return path.join(directory, `sqlite-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

async function cleanupTempDatabase(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true });
}

function createNotification(
  overrides: Partial<OperatorNotificationRecord> & Pick<OperatorNotificationRecord, "id" | "createdAt">,
): OperatorNotificationRecord {
  const { id, createdAt, ...rest } = overrides;
  return {
    exchangeAccountId: "primary",
    channel: "TELEGRAM",
    notificationType: "ORDER_REJECTED",
    severity: "WARN",
    title: "Operator notification",
    message: "Operator-facing event.",
    payloadJson: "{}",
    deliveryStatus: "PENDING",
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    failureClass: null,
    leaseToken: null,
    leaseExpiresAt: null,
    ...rest,
    id,
    createdAt,
    deliveredAt: null,
    lastError: null,
  };
}
