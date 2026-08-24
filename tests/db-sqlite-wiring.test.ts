import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  FillRecord,
  OperatorNotificationDeliveryAttemptRecord,
  OperatorNotificationDeliveryRunRecord,
  OperatorNotificationRecord,
  OrderEventRecord,
  OrderRecord,
  PositionSnapshotRecord,
  RiskEventRecord,
  StrategySchedulerRunRecord,
  StrategyDecisionRecord,
} from "../src/domain/types.js";
import type { ExecutionRepository, OperatorStateStore } from "../src/modules/db/interfaces.js";
import {
  InMemoryExecutionRepository,
  InMemoryOperatorStateStore,
} from "../src/modules/db/repositories/in-memory-repositories.js";
import { openSqliteDatabase } from "../src/modules/db/repositories/sqlite-database.js";
import { createSqlitePersistence } from "../src/modules/db/repositories/sqlite-repositories.js";
import { ReconciliationService } from "../src/modules/reconciliation/reconciliation-service.js";
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

test("in-memory atomic lifecycle writes are idempotent, validated, and detached", async () => {
  const repository = new InMemoryExecutionRepository();
  await assertAtomicLifecycleContract(repository);
});

test("in-memory operator notification persistence rejects duplicate ids without rewinding delivery state", async () => {
  await assertOperatorNotificationInsertOnlyContract(new InMemoryExecutionRepository());
});

test("in-memory operator notification delivery records are detached from caller and delivery reads", async () => {
  const repository = new InMemoryExecutionRepository();
  const saved = createNotification({
    id: "operator-notification-detached-pending",
    title: "Original pending notification",
    createdAt: "2026-08-24T00:30:00.000Z",
  });
  await repository.saveOperatorNotification(saved);

  saved.title = "Mutated saved input";
  saved.deliveryStatus = "SENT";
  saved.leaseToken = "caller-lease";
  const listedPending = await readOperatorNotification(repository, saved.id);
  assert.equal(listedPending.title, "Original pending notification");
  assert.equal(listedPending.deliveryStatus, "PENDING");
  assert.equal(listedPending.leaseToken, null);

  listedPending.title = "Mutated notification list result";
  listedPending.deliveryStatus = "FAILED";
  const pendingRead = (await repository.listPendingOperatorNotifications("primary", { limit: 1 }))[0];
  assert.ok(pendingRead);
  pendingRead.message = "Mutated pending list result";
  assert.equal((await readOperatorNotification(repository, saved.id)).title, "Original pending notification");
  assert.equal((await readOperatorNotification(repository, saved.id)).message, "Operator-facing event.");
  assert.equal((await readOperatorNotification(repository, saved.id)).deliveryStatus, "PENDING");

  const [claimed] = await repository.claimPendingOperatorNotifications("primary", {
    limit: 1,
    dueBefore: "2026-08-24T00:31:00.000Z",
    claimedAt: "2026-08-24T00:31:00.000Z",
    leaseToken: "durable-pending-lease",
    leaseExpiresAt: "2026-08-24T00:32:00.000Z",
  });
  assert.ok(claimed);
  claimed.deliveryStatus = "FAILED";
  claimed.leaseToken = "mutated-claim-lease";
  claimed.title = "Mutated claim result";
  const leased = await readOperatorNotification(repository, saved.id);
  assert.equal(leased.deliveryStatus, "PENDING");
  assert.equal(leased.leaseToken, "durable-pending-lease");
  assert.equal(leased.title, "Original pending notification");

  assert.equal(await repository.compareAndSetOperatorNotificationDeliveryStatus({
    id: saved.id,
    leaseToken: "durable-pending-lease",
    deliveryStatus: "SENT",
    attemptCount: 1,
    lastAttemptAt: "2026-08-24T00:31:01.000Z",
    nextAttemptAt: null,
    failureClass: null,
    deliveredAt: "2026-08-24T00:31:01.000Z",
    lastError: null,
  }), true);
  const sent = await readOperatorNotification(repository, saved.id);
  sent.deliveryStatus = "FAILED";
  sent.deliveredAt = null;
  assert.equal((await readOperatorNotification(repository, saved.id)).deliveryStatus, "SENT");
  assert.equal((await readOperatorNotification(repository, saved.id)).deliveredAt, "2026-08-24T00:31:01.000Z");

  const failed = createNotification({
    id: "operator-notification-detached-failed",
    createdAt: "2026-08-24T00:33:00.000Z",
  });
  await repository.saveOperatorNotification(failed);
  const [failedClaim] = await repository.claimPendingOperatorNotifications("primary", {
    limit: 1,
    dueBefore: "2026-08-24T00:34:00.000Z",
    claimedAt: "2026-08-24T00:34:00.000Z",
    leaseToken: "durable-failed-lease",
    leaseExpiresAt: "2026-08-24T00:35:00.000Z",
  });
  assert.equal(failedClaim?.id, failed.id);
  assert.equal(await repository.compareAndSetOperatorNotificationDeliveryStatus({
    id: failed.id,
    leaseToken: "durable-failed-lease",
    deliveryStatus: "FAILED",
    attemptCount: 1,
    lastAttemptAt: "2026-08-24T00:34:01.000Z",
    nextAttemptAt: null,
    failureClass: "PERMANENT",
    deliveredAt: null,
    lastError: "telegram_http_403",
  }), true);
  const failedRead = await readOperatorNotification(repository, failed.id);
  failedRead.deliveryStatus = "SENT";
  failedRead.lastError = null;
  assert.equal((await readOperatorNotification(repository, failed.id)).deliveryStatus, "FAILED");
  assert.equal((await readOperatorNotification(repository, failed.id)).lastError, "telegram_http_403");
});

test("in-memory operator notification delivery attempts are detached on save and list", async () => {
  const repository = new InMemoryExecutionRepository();
  const attempt: OperatorNotificationDeliveryAttemptRecord = {
    id: "delivery-attempt-detached",
    notificationId: "notification-detached",
    exchangeAccountId: "primary",
    attemptCount: 1,
    leaseToken: "lease-detached",
    outcome: "SENT",
    failureClass: null,
    attemptedAt: "2026-08-24T00:40:00.000Z",
    nextAttemptAt: null,
    deliveredAt: "2026-08-24T00:40:01.000Z",
    errorMessage: null,
    createdAt: "2026-08-24T00:40:01.000Z",
  };
  await repository.saveOperatorNotificationDeliveryAttempt(attempt);

  attempt.outcome = "FAILED";
  attempt.errorMessage = "mutated caller input";
  const [saved] = await repository.listOperatorNotificationDeliveryAttempts("primary", 1);
  assert.equal(saved?.outcome, "SENT");
  assert.equal(saved?.errorMessage, null);

  const replacement: OperatorNotificationDeliveryAttemptRecord = {
    ...attempt,
    outcome: "RETRY_SCHEDULED",
    failureClass: "RETRYABLE",
    nextAttemptAt: "2026-08-24T00:41:00.000Z",
    errorMessage: "retry scheduled",
  };
  await repository.saveOperatorNotificationDeliveryAttempt(replacement);
  replacement.outcome = "FAILED";
  replacement.errorMessage = "mutated replacement input";
  const [listed] = await repository.listOperatorNotificationDeliveryAttempts("primary", 1);
  assert.equal(listed?.outcome, "RETRY_SCHEDULED");
  assert.equal(listed?.errorMessage, "retry scheduled");

  if (listed) {
    listed.outcome = "FAILED";
    listed.errorMessage = "mutated list output";
  }
  const [persisted] = await repository.listOperatorNotificationDeliveryAttempts("primary", 1);
  assert.equal(persisted?.outcome, "RETRY_SCHEDULED");
  assert.equal(persisted?.errorMessage, "retry scheduled");
});

test("in-memory operator notification delivery runs are detached on save and list", async () => {
  const repository = new InMemoryExecutionRepository();
  const run: OperatorNotificationDeliveryRunRecord = {
    id: "delivery-run-detached",
    exchangeAccountId: "primary",
    workerName: "inline",
    status: "COMPLETED",
    startedAt: "2026-08-24T00:50:00.000Z",
    completedAt: "2026-08-24T00:50:01.000Z",
    attemptedCount: 1,
    sentCount: 1,
    retryScheduledCount: 0,
    failedCount: 0,
    staleLeaseCount: 0,
    pendingTotalCount: 0,
    pendingDueCount: 0,
    pendingScheduledCount: 0,
    activeLeaseCount: 0,
    expiredLeaseCount: 0,
    abandonedLeaseCandidateCount: 0,
    skippedReason: null,
    errorMessage: null,
    summaryJson: JSON.stringify({ sent: 1 }),
  };
  await repository.saveOperatorNotificationDeliveryRun(run);

  run.status = "FAILED";
  run.errorMessage = "mutated caller input";
  const [saved] = await repository.listOperatorNotificationDeliveryRuns("primary", 1);
  assert.equal(saved?.status, "COMPLETED");
  assert.equal(saved?.errorMessage, null);

  const replacement: OperatorNotificationDeliveryRunRecord = {
    ...run,
    status: "SKIPPED",
    skippedReason: "not configured",
    errorMessage: null,
    summaryJson: JSON.stringify({ skipped: true }),
  };
  await repository.saveOperatorNotificationDeliveryRun(replacement);
  replacement.status = "FAILED";
  replacement.summaryJson = JSON.stringify({ mutated: true });
  const [listed] = await repository.listOperatorNotificationDeliveryRuns("primary", 1);
  assert.equal(listed?.status, "SKIPPED");
  assert.equal(listed?.summaryJson, JSON.stringify({ skipped: true }));

  if (listed) {
    listed.status = "FAILED";
    listed.summaryJson = JSON.stringify({ mutatedList: true });
  }
  const [persisted] = await repository.listOperatorNotificationDeliveryRuns("primary", 1);
  assert.equal(persisted?.status, "SKIPPED");
  assert.equal(persisted?.summaryJson, JSON.stringify({ skipped: true }));
});

test("sqlite operator notification persistence rejects duplicate ids without rewinding delivery state", async () => {
  const databasePath = await createTempDatabasePath("notification-insert-only");
  const bundle = createNotificationTestPersistence(databasePath);

  try {
    await assertOperatorNotificationInsertOnlyContract(bundle.repositories);
  } finally {
    bundle.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("sqlite operator notification insert race stores one immutable row and rejects one writer", async () => {
  const databasePath = await createTempDatabasePath("notification-insert-race");
  const first = createNotificationTestPersistence(databasePath);
  const second = createNotificationTestPersistence(databasePath);
  const notification = createNotification({
    id: "operator-notification-race",
    title: "Candidate pilot recovery completed",
    message: "Candidate pilot recovery completed without drift.",
    payloadJson: JSON.stringify({ deploymentId: "deployment-race" }),
    createdAt: "2026-08-24T00:10:00.000Z",
  });

  try {
    const results = await Promise.allSettled([
      first.repositories.saveOperatorNotification({ ...notification }),
      second.repositories.saveOperatorNotification({ ...notification }),
    ]);

    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ["fulfilled", "rejected"],
    );
    assert.deepEqual(await first.repositories.listOperatorNotifications("primary", 10), [notification]);
  } finally {
    second.close();
    first.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("in-memory automatic fault pauses are idempotent and preserve kill switches", async () => {
  await assertFaultTimestampPrecisionContract(createInMemoryOperatorState());

  const operatorState = createInMemoryOperatorState();
  const fault = {
    exchangeAccountId: "primary",
    faultId: "fault-uncertain-order",
    reason: "UNCERTAIN_ORDER",
    occurredAt: "2026-08-21T00:00:00.000Z",
  };

  await assert.rejects(operatorState.pauseForFault({ ...fault, faultId: "fault-no-timezone", occurredAt: "2026-08-21T00:00:00.000" }));
  await assert.rejects(operatorState.pauseForFault({ ...fault, faultId: "fault-too-old", occurredAt: "2026-08-19T00:00:00.000Z" }));

  await operatorState.pauseForFault(fault);
  await operatorState.pauseForFault(fault);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal(
    (await operatorState.listTransitions()).filter((transition) => transition.command === "AUTOMATIC_PAUSE").length,
    1,
  );

  await operatorState.activateKillSwitch("operator");
  await operatorState.pauseForFault({
    ...fault,
    faultId: "fault-second",
    occurredAt: "2099-08-21T00:01:00.000Z",
  });
  const state = await operatorState.getState();
  assert.equal(state.systemStatus, "KILL_SWITCHED");
  assert.equal(state.killSwitchActive, true);
  assert.equal(state.pauseReason, "operator");
  assert.deepEqual(await operatorState.pauseForFault(fault), state);
  assert.deepEqual(await operatorState.getState(), state);
  assert.equal(
    (await operatorState.listTransitions()).filter((transition) => transition.command === "AUTOMATIC_PAUSE").length,
    2,
  );
});

test("sqlite atomic lifecycle writes roll back conflicts and fault pauses stay safe", async () => {
  const databasePath = await createTempDatabasePath("atomic-lifecycle");
  const bundle = createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "operator",
    userTelegramId: "telegram-user",
    userDisplayName: "Operator",
    accessKeyRef: "ENV:UPBIT_ACCESS_KEY",
    secretKeyRef: "ENV:UPBIT_SECRET_KEY",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    killSwitchActive: false,
  });

  try {
    const repositories = bundle.repositories;
    await assertAtomicLifecycleContract(repositories);
    await assertFaultTimestampPrecisionContract(
      bundle.operatorState,
      "2099-08-21T00:00:00.000000009Z",
      "2099-08-21T09:00:00.000000009+09:00",
    );

    const original = createOrderRecord({
      id: "rollback-order",
      status: "PERSISTED",
      updatedAt: "2026-08-21T00:00:00.000Z",
    });
    await repositories.persistOrderIntent({
      order: original,
      event: createOrderEvent(original.id, "rollback-event", "ORDER_PERSISTED"),
    });
    await repositories.appendOrderEvent(createOrderEvent(original.id, "conflicting-event", "EXISTING"));

    const uncertain = {
      ...original,
      status: "RECONCILIATION_REQUIRED" as const,
      updatedAt: "2026-08-21T00:01:00.000Z",
      failureCode: "RECONCILIATION_REQUIRED",
      failureMessage: "Submission outcome requires reconciliation.",
    };
    await assert.rejects(
      repositories.persistUncertainSubmission({
        order: uncertain,
        event: createOrderEvent(uncertain.id, "conflicting-event", "RECONCILIATION_REQUIRED"),
        riskEvent: createRiskEvent(uncertain.id, "rollback-risk"),
      }),
    );
    assert.equal((await repositories.findOrderByReference("primary", original.id))?.status, "PERSISTED");
    assert.equal((await repositories.listRiskEvents("primary")).some((event) => event.id === "rollback-risk"), false);

    const malformedOrder = createOrderRecord({ id: "rollback-malformed-order", status: "PERSISTED" });
    await assert.rejects(
      repositories.persistOrderIntent({
        order: malformedOrder,
        event: {
          ...createOrderEvent(malformedOrder.id, "rollback-malformed-event", "ORDER_PERSISTED"),
          eventSource: "INVALID" as never,
        },
      }),
    );
    assert.equal(await repositories.findOrderByReference("primary", malformedOrder.id), null);

    const fault = {
      exchangeAccountId: "primary",
      faultId: "sqlite-uncertain-order",
      reason: "UNCERTAIN_ORDER",
      occurredAt: "2099-08-21T00:02:00.000Z",
    };
    await bundle.operatorState.pauseForFault(fault);
    await bundle.operatorState.pauseForFault(fault);
    await bundle.operatorState.activateKillSwitch("operator");
    await bundle.operatorState.pauseForFault({
      ...fault,
      faultId: "sqlite-second-fault",
      occurredAt: "2099-08-21T00:03:00.000Z",
    });
    const state = await bundle.operatorState.getState();
    assert.equal(state.systemStatus, "KILL_SWITCHED");
    assert.deepEqual(await bundle.operatorState.pauseForFault(fault), state);
    assert.deepEqual(await bundle.operatorState.getState(), state);
    assert.equal(
      (await bundle.operatorState.listTransitions()).filter((transition) => transition.command === "AUTOMATIC_PAUSE").length,
      4,
    );
  } finally {
    bundle.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("two SQLite connections preserve a terminal winner when missing reconciliation snapshot races recovery", async () => {
  const databasePath = await createTempDatabasePath("reconciliation-recovery-cas-race");
  const bootstrap = {
    databasePath,
    exchangeAccountId: "primary",
    userId: "operator",
    userTelegramId: "telegram-user",
    userDisplayName: "Operator",
    accessKeyRef: "ENV:UPBIT_ACCESS_KEY",
    secretKeyRef: "ENV:UPBIT_SECRET_KEY",
    executionMode: "DRY_RUN" as const,
    liveExecutionGate: "DISABLED" as const,
    killSwitchActive: false,
  };
  const first = createSqlitePersistence(bootstrap);
  const second = createSqlitePersistence(bootstrap);
  const original = createOrderRecord({
    id: "sqlite-reconciliation-recovery-cas-order",
    status: "OPEN",
    upbitUuid: "sqlite-reconciliation-recovery-cas-uuid",
    exchangeResponseJson: JSON.stringify({ state: "wait" }),
  });
  const terminal = {
    ...original,
    status: "CANCELED" as const,
    exchangeResponseJson: JSON.stringify({ state: "cancel" }),
    updatedAt: "2026-08-24T00:01:00.000Z",
  };
  const terminalEvent: OrderEventRecord = {
    id: "sqlite-reconciliation-recovery-cas-terminal-event",
    orderId: original.id,
    eventType: "RECONCILIATION_STATUS_UPDATED",
    eventSource: "RECONCILIATION",
    payloadJson: JSON.stringify({ previousStatus: "OPEN", nextStatus: "CANCELED" }),
    createdAt: terminal.updatedAt,
  };
  const terminalFill = {
    ...createFill(original.id, "sqlite-reconciliation-recovery-cas-terminal-fill"),
    exchangeFillId: "sqlite-reconciliation-recovery-cas-exchange-fill",
    volume: "0.001",
    feeProvenance: "LEGACY_UNVERIFIED" as const,
    executionTimestampProvenance: "LEGACY_UNVERIFIED" as const,
    executionEpochNs: null,
  };

  try {
    await first.repositories.saveOrder(original);
    const projectedOrderIds: string[] = [];
    const service = new ReconciliationService({
      repositories: first.repositories,
      operatorState: first.operatorState,
      orderReader: {
        async getOrder() {
          await second.repositories.persistReconciledExchangeSnapshot!({
            expectedOrder: original,
            order: terminal,
            event: terminalEvent,
            fills: [terminalFill],
          });
          return null;
        },
      },
      candidateEvidenceService: {
        async processTerminalOrder(orderId) {
          projectedOrderIds.push(orderId);
          return { outcome: "ADVANCED" as const, orderId, detail: "unexpected stale projection" };
        },
      },
    });

    await service.run("primary");

    assert.deepEqual(await first.repositories.findOrderById("primary", original.id), terminal);
    assert.deepEqual(await first.repositories.listOrderEvents(original.id), [terminalEvent]);
    assert.deepEqual(await first.repositories.listFills(original.id), [terminalFill]);
    assert.deepEqual(await first.repositories.listRiskEvents("primary"), []);
    assert.deepEqual(projectedOrderIds, []);
  } finally {
    second.close();
    first.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("sqlite reconciliation aggregate rolls back a fill-prefix failure and completes after restart", async () => {
  const databasePath = await createTempDatabasePath("atomic-reconciliation-restart");
  const bootstrap = {
    databasePath,
    exchangeAccountId: "primary",
    userId: "operator",
    userTelegramId: "telegram-user",
    userDisplayName: "Operator",
    accessKeyRef: "ENV:UPBIT_ACCESS_KEY",
    secretKeyRef: "ENV:UPBIT_SECRET_KEY",
    executionMode: "LIVE" as const,
    liveExecutionGate: "ENABLED" as const,
    killSwitchActive: false,
  };
  const original = createOrderRecord({
    id: "atomic-reconciliation-order",
    status: "OPEN",
    executionMode: "LIVE",
    upbitUuid: "atomic-reconciliation-uuid",
    exchangeResponseJson: JSON.stringify({ state: "wait" }),
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const terminal = {
    ...original,
    status: "FILLED" as const,
    exchangeResponseJson: JSON.stringify({ state: "done", executed_volume: "0.003" }),
    updatedAt: "2026-08-21T00:01:00.000Z",
  };
  const event: OrderEventRecord = {
    id: "atomic-reconciliation-event",
    orderId: original.id,
    eventType: "RECONCILIATION_STATUS_UPDATED",
    eventSource: "RECONCILIATION",
    payloadJson: JSON.stringify({ previousStatus: "OPEN", nextStatus: "FILLED" }),
    createdAt: terminal.updatedAt,
  };
  const fills: FillRecord[] = [
    {
      ...createFill(original.id, "atomic-reconciliation-fill-local-1"),
      exchangeFillId: "atomic-reconciliation-fill-1",
      volume: "0.001",
      feeProvenance: "EXCHANGE_FILL_CONFIRMED",
      executionTimestampProvenance: "EXCHANGE_FILL_CONFIRMED",
      executionEpochNs: "1787270460000000000",
      rawPayloadJson: JSON.stringify({ trade_uuid: "atomic-reconciliation-fill-1" }),
    },
    {
      ...createFill(original.id, "atomic-reconciliation-fill-local-2"),
      exchangeFillId: "atomic-reconciliation-fill-2",
      volume: "0.002",
      feeProvenance: "EXCHANGE_FILL_CONFIRMED",
      executionTimestampProvenance: "EXCHANGE_FILL_CONFIRMED",
      executionEpochNs: "1787270461000000000",
      filledAt: "2026-08-21T00:01:01.000Z",
      rawPayloadJson: JSON.stringify({ trade_uuid: "atomic-reconciliation-fill-2" }),
    },
  ];

  let first = createSqlitePersistence(bootstrap);
  try {
    await first.repositories.saveOrder(original);
    const injector = new DatabaseSync(databasePath);
    try {
      injector.exec(`
        CREATE TRIGGER fail_second_reconciliation_fill
        BEFORE INSERT ON fills
        WHEN NEW.exchange_fill_id = 'atomic-reconciliation-fill-2'
        BEGIN
          SELECT RAISE(ABORT, 'injected failure after fill prefix');
        END;
      `);
    } finally {
      injector.close();
    }

    const persistSnapshot = first.repositories.persistReconciledExchangeSnapshot;
    assert.ok(persistSnapshot);
    await assert.rejects(persistSnapshot.call(first.repositories, {
      expectedOrder: original,
      order: terminal,
      event,
      fills,
    }), /injected failure after fill prefix/);
    assert.deepEqual(await first.repositories.findOrderById("primary", original.id), original);
    assert.deepEqual(await first.repositories.listOrderEvents(original.id), []);
    assert.deepEqual(await first.repositories.listFills(original.id), []);
  } finally {
    first.close();
  }

  const triggerCleanup = new DatabaseSync(databasePath);
  try {
    triggerCleanup.exec("DROP TRIGGER fail_second_reconciliation_fill;");
  } finally {
    triggerCleanup.close();
  }

  first = createSqlitePersistence(bootstrap);
  try {
    const persistSnapshot = first.repositories.persistReconciledExchangeSnapshot;
    assert.ok(persistSnapshot);
    const result = await persistSnapshot.call(first.repositories, {
      expectedOrder: original,
      order: terminal,
      event,
      fills,
    });
    assert.deepEqual(result, { outcome: "APPLIED", insertedFillCount: 2 });
    assert.deepEqual(await first.repositories.findOrderById("primary", original.id), terminal);
    assert.deepEqual(await first.repositories.listOrderEvents(original.id), [event]);
    assert.deepEqual(
      (await first.repositories.listFills(original.id)).sort((left, right) => left.id.localeCompare(right.id)),
      [...fills].sort((left, right) => left.id.localeCompare(right.id)),
    );
  } finally {
    first.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("reconciliation stays lookup-eligible after atomic fill failure and projects evidence only after restart completion", async () => {
  const databasePath = await createTempDatabasePath("reconciliation-fault-restart");
  const bootstrap = {
    databasePath,
    exchangeAccountId: "primary",
    userId: "operator",
    userTelegramId: "telegram-user",
    userDisplayName: "Operator",
    accessKeyRef: "ENV:UPBIT_ACCESS_KEY",
    secretKeyRef: "ENV:UPBIT_SECRET_KEY",
    executionMode: "LIVE" as const,
    liveExecutionGate: "ENABLED" as const,
    killSwitchActive: false,
  };
  const order = createOrderRecord({
    id: "reconciliation-fault-order",
    status: "OPEN",
    executionMode: "LIVE",
    upbitUuid: "reconciliation-fault-uuid",
    exchangeResponseJson: JSON.stringify({ state: "wait" }),
  });
  const snapshot = {
    uuid: "reconciliation-fault-uuid",
    identifier: order.identifier,
    market: "KRW-BTC" as const,
    side: "bid" as const,
    ordType: "limit" as const,
    state: "done" as const,
    price: order.price,
    volume: order.volume,
    remainingVolume: "0",
    executedVolume: "0.003",
    paidFee: "750",
    createdAt: order.createdAt,
    fills: [
      {
        tradeUuid: "reconciliation-service-fill-1",
        side: "bid" as const,
        price: "500000",
        volume: "0.001",
        funds: "500",
        fee: "250",
        createdAt: "2026-08-21T00:01:00.000Z",
        raw: { trade_uuid: "reconciliation-service-fill-1" },
      },
      {
        tradeUuid: "reconciliation-service-fill-2",
        side: "bid" as const,
        price: "500000",
        volume: "0.002",
        funds: "1000",
        fee: "500",
        createdAt: "2026-08-21T00:01:01.000Z",
        raw: { trade_uuid: "reconciliation-service-fill-2" },
      },
    ],
    raw: { state: "done", executed_volume: "0.003" },
  };
  const projectedOrderIds: string[] = [];
  const projector = {
    async processTerminalOrder(orderId: string) {
      projectedOrderIds.push(orderId);
      return { outcome: "ADVANCED" as const, orderId, detail: "projected complete aggregate" };
    },
  };

  let bundle = createSqlitePersistence(bootstrap);
  try {
    await bundle.repositories.saveOrder(order);
    const injector = new DatabaseSync(databasePath);
    try {
      injector.exec(`
        CREATE TRIGGER fail_reconciliation_service_second_fill
        BEFORE INSERT ON fills
        WHEN NEW.exchange_fill_id = 'reconciliation-service-fill-2'
        BEGIN
          SELECT RAISE(ABORT, 'injected service failure after fill prefix');
        END;
      `);
    } finally {
      injector.close();
    }
    const service = new ReconciliationService({
      repositories: bundle.repositories,
      operatorState: bundle.operatorState,
      orderReader: { async getOrder() { return snapshot; } },
      candidateEvidenceService: projector,
    });
    await service.run("primary", {
      runIdentity: {
        id: "reconciliation-fault-run-1",
        startedAt: "2026-08-21T00:02:00.000Z",
      },
    });

    const failedOrder = await bundle.repositories.findOrderById("primary", order.id);
    assert.equal(failedOrder?.status, "OPEN");
    assert.equal(failedOrder?.exchangeResponseJson, order.exchangeResponseJson);
    assert.deepEqual(await bundle.repositories.listFills(order.id), []);
    assert.deepEqual(projectedOrderIds, []);
  } finally {
    bundle.close();
  }

  const triggerCleanup = new DatabaseSync(databasePath);
  try {
    triggerCleanup.exec("DROP TRIGGER fail_reconciliation_service_second_fill;");
  } finally {
    triggerCleanup.close();
  }

  bundle = createSqlitePersistence(bootstrap);
  try {
    const restarted = new ReconciliationService({
      repositories: bundle.repositories,
      operatorState: bundle.operatorState,
      orderReader: { async getOrder() { return snapshot; } },
      candidateEvidenceService: projector,
      recoveryClock: {
        now: () => ({
          observedAt: "2026-08-21T00:03:00.000Z",
          observedAtEpochMs: Date.parse("2026-08-21T00:03:00.000Z"),
        }),
      },
    });
    await restarted.run("primary", {
      runIdentity: {
        id: "reconciliation-fault-run-2",
        startedAt: "2026-08-21T00:03:00.000Z",
      },
    });

    assert.equal((await bundle.repositories.findOrderById("primary", order.id))?.status, "FILLED");
    assert.deepEqual(
      (await bundle.repositories.listFills(order.id)).map((fill) => fill.exchangeFillId).sort(),
      ["reconciliation-service-fill-1", "reconciliation-service-fill-2"],
    );
    assert.deepEqual(projectedOrderIds, [order.id]);
  } finally {
    bundle.close();
    await cleanupTempDatabase(databasePath);
  }
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
    assert.ok(migrationRows.some((row) => row.filename === "0009_add_history_recovery_checkpoints.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0010_add_operator_notification_delivery_runs.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0011_add_strategy_scheduler_runs.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0012_add_telegram_inbound_offsets.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0014_extend_scheduler_operator_notification_types.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0015_add_scheduler_startup_blocked_notification_type.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0016_add_pending_confirmation_strategy_decision_status.sql"));
    assert.ok(migrationRows.some((row) => row.filename === "0017_add_btc_candidate_live_pilot.sql"));
    assert.ok(migrationRows.some(
      (row) => row.filename === "0018_scope_candidate_evidence_identity_to_deployment.sql",
    ));

    const foreignKeyViolations = handle.db.prepare("PRAGMA foreign_key_check").all();
    assert.deepEqual(foreignKeyViolations, []);

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
      "history_recovery_checkpoints",
      "operator_notifications",
      "operator_notification_delivery_attempts",
      "operator_notification_delivery_runs",
      "strategy_scheduler_runs",
      "telegram_inbound_offsets",
      "risk_events",
      "strategy_pilot_deployments",
      "strategy_candidate_states",
      "strategy_candidate_execution_evidence",
      "strategy_pilot_audit_events",
      "account_execution_leases",
      "order_submission_recovery_observations",
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
    assert.notEqual(bundle.candidatePilots, bundle.repositories);
    assert.notEqual(bundle.accountExecutionLeases, bundle.repositories);
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

    await bundle.repositories.saveHistoryRecoveryCheckpoint({
      id: "history-checkpoint-1",
      exchangeAccountId: "primary",
      market: "KRW-BTC",
      checkpointType: "CLOSED_ORDER_ARCHIVE",
      nextWindowEndAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-20T00:02:30.000Z",
    });

    const checkpoint = await bundle.repositories.getHistoryRecoveryCheckpoint(
      "primary",
      "KRW-BTC",
      "CLOSED_ORDER_ARCHIVE",
    );
    assert.equal(checkpoint?.nextWindowEndAt, "2026-04-01T00:00:00.000Z");

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

    await bundle.repositories.saveOperatorNotificationDeliveryRun({
      id: "delivery-run-1",
      exchangeAccountId: "primary",
      workerName: "telegram_delivery_inline_worker",
      status: "COMPLETED",
      startedAt: "2026-04-20T00:03:05.000Z",
      completedAt: "2026-04-20T00:03:06.000Z",
      attemptedCount: 1,
      sentCount: 1,
      retryScheduledCount: 0,
      failedCount: 0,
      staleLeaseCount: 0,
      pendingTotalCount: 0,
      pendingDueCount: 0,
      pendingScheduledCount: 0,
      activeLeaseCount: 0,
      expiredLeaseCount: 0,
      abandonedLeaseCandidateCount: 0,
      skippedReason: null,
      errorMessage: null,
      summaryJson: JSON.stringify({ attempted: 1, sent: 1 }),
    });

    const runRows = await bundle.repositories.listOperatorNotificationDeliveryRuns("primary", 5);
    assert.equal(runRows.length, 1);
    assert.equal(runRows[0]?.status, "COMPLETED");
    assert.equal(runRows[0]?.sentCount, 1);

    const schedulerRun = createStrategySchedulerRun({
      id: "scheduler-run-1",
      status: "STARTED",
      startedAt: "2026-04-20T00:03:07.000Z",
      completedAt: null,
      strategyDecisionId: null,
      action: null,
      orderId: null,
      orderStatus: null,
      submissionAccepted: null,
      detail: null,
      errorMessage: null,
    });
    await bundle.repositories.saveStrategySchedulerRun(schedulerRun);
    await bundle.repositories.updateStrategySchedulerRun({
      ...schedulerRun,
      status: "COMPLETED",
      completedAt: "2026-04-20T00:03:08.000Z",
      strategyDecisionId: "strategy-decision-1",
      action: "HOLD",
      detail: "Decision HOLD persisted; no order submission was requested.",
      summaryJson: JSON.stringify({ status: "COMPLETED" }),
    });

    const schedulerRuns = await bundle.repositories.listStrategySchedulerRuns("primary", 5);
    assert.equal(schedulerRuns.length, 1);
    assert.equal(schedulerRuns[0]?.status, "COMPLETED");
    assert.equal(schedulerRuns[0]?.strategyDecisionId, "strategy-decision-1");
    assert.equal(schedulerRuns[0]?.action, "HOLD");
    assert.equal(schedulerRuns[0]?.runOnStart, false);

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
      id: "operator-notification-scheduler",
      notificationType: "SCHEDULER_ORDER_SUBMITTED",
      severity: "INFO",
      title: "Scheduled strategy submitted an order",
      message: "KRW-BTC scheduled EXIT created order order-1.",
      payloadJson: JSON.stringify({ market: "KRW-BTC", orderId: "order-1" }),
      createdAt: "2026-04-20T00:03:15.000Z",
    }));
    await bundle.repositories.saveOperatorNotification(createNotification({
      id: "operator-notification-scheduler-startup-blocked",
      notificationType: "SCHEDULER_STARTUP_BLOCKED",
      severity: "ERROR",
      title: "Strategy scheduler startup blocked",
      message: "Live scheduler startup blocked by active_orders.",
      payloadJson: JSON.stringify({ scope: "LIVE", liveSendPath: "LIVE_ADAPTER" }),
      deliveryStatus: "SENT",
      createdAt: "2026-04-20T00:03:17.000Z",
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
    const schedulerNotification = oldestFirstPendingNotifications.find((notification) =>
      notification.id === "operator-notification-scheduler"
    );
    const startupBlockNotification = (await bundle.repositories.listOperatorNotifications("primary", 10)).find((notification) =>
      notification.id === "operator-notification-scheduler-startup-blocked"
    );
    assert.equal(schedulerNotification?.notificationType, "SCHEDULER_ORDER_SUBMITTED");
    assert.equal(startupBlockNotification?.notificationType, "SCHEDULER_STARTUP_BLOCKED");
    assert.equal(startupBlockNotification?.severity, "ERROR");
    assert.deepEqual(
      oldestFirstPendingNotifications.map((notification) => notification.id),
      ["operator-notification-scheduler", "operator-notification-3", "operator-notification-2"],
    );
    assert.deepEqual(
      limitedPendingNotifications.map((notification) => notification.id),
      ["operator-notification-scheduler"],
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
      ["operator-notification-scheduler", "operator-notification-3", "operator-notification-2"],
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

test("migration 0016 preserves existing strategy decision references", async () => {
  const databasePath = await createTempDatabasePath("migration-0016-existing-references");
  await createPre0016Database(databasePath, false);
  const handle = openSqliteDatabase(databasePath);

  try {
    const decision = handle.db.prepare("SELECT status FROM strategy_decisions WHERE id = ?")
      .get("legacy-decision") as { status: string } | undefined;
    const order = handle.db.prepare("SELECT strategy_decision_id FROM orders WHERE id = ?")
      .get("legacy-order") as { strategy_decision_id: string | null } | undefined;
    const risk = handle.db.prepare("SELECT strategy_decision_id FROM risk_events WHERE id = ?")
      .get("legacy-risk") as { strategy_decision_id: string | null } | undefined;
    const violations = handle.db.prepare("PRAGMA foreign_key_check").all();

    assert.equal(decision?.status, "READY");
    assert.equal(order?.strategy_decision_id, "legacy-decision");
    assert.equal(risk?.strategy_decision_id, "legacy-decision");
    assert.deepEqual(violations, []);
  } finally {
    handle.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("migration 0016 rolls back its table rebuild when legacy data copy fails", async () => {
  const databasePath = await createTempDatabasePath("migration-0016-rollback");
  await createPre0016Database(databasePath, true);

  assert.throws(
    () => openSqliteDatabase(databasePath),
    /reference_price|no such column/i,
  );

  const inspection = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tableRows = inspection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('strategy_decisions', 'strategy_decisions_new')
      ORDER BY name ASC
    `).all() as Array<{ name: string }>;
    const migration = inspection.prepare("SELECT filename FROM _schema_migrations WHERE filename = ?")
      .get("0016_add_pending_confirmation_strategy_decision_status.sql");

    assert.deepEqual(tableRows.map((row) => row.name), ["strategy_decisions"]);
    assert.equal(migration, undefined);
  } finally {
    inspection.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("sqlite repository round-trips durable telegram inbound offsets by bot token ref", async () => {
  const databasePath = await createTempDatabasePath("telegram-inbound-offset");
  const bundle = createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "operator",
    userTelegramId: "telegram-user",
    userDisplayName: "Operator",
    accessKeyRef: "ENV:UPBIT_ACCESS_KEY",
    secretKeyRef: "ENV:UPBIT_SECRET_KEY",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    killSwitchActive: false,
  });

  try {
    await bundle.telegramInboundOffsets.saveTelegramInboundOffset({
      id: "telegram-inbound-offset-1",
      exchangeAccountId: "primary",
      updateSource: "GET_UPDATES",
      botTokenRef: "sha256:bot-a",
      nextOffset: 101,
      lastUpdateId: 100,
      updatedAt: "2026-04-20T00:00:00.000Z",
    });
    await bundle.telegramInboundOffsets.saveTelegramInboundOffset({
      id: "telegram-inbound-offset-2",
      exchangeAccountId: "primary",
      updateSource: "GET_UPDATES",
      botTokenRef: "sha256:bot-a",
      nextOffset: 102,
      lastUpdateId: 101,
      updatedAt: "2026-04-20T00:01:00.000Z",
    });
    await bundle.telegramInboundOffsets.saveTelegramInboundOffset({
      id: "telegram-inbound-offset-other-bot",
      exchangeAccountId: "primary",
      updateSource: "GET_UPDATES",
      botTokenRef: "sha256:bot-b",
      nextOffset: 5,
      lastUpdateId: 4,
      updatedAt: "2026-04-20T00:02:00.000Z",
    });

    assert.deepEqual(
      await bundle.telegramInboundOffsets.getTelegramInboundOffset({
        exchangeAccountId: "primary",
        updateSource: "GET_UPDATES",
        botTokenRef: "sha256:bot-a",
      }),
      {
        id: "telegram-inbound-offset-2",
        exchangeAccountId: "primary",
        updateSource: "GET_UPDATES",
        botTokenRef: "sha256:bot-a",
        nextOffset: 102,
        lastUpdateId: 101,
        updatedAt: "2026-04-20T00:01:00.000Z",
      },
    );
    assert.equal(
      (await bundle.telegramInboundOffsets.getTelegramInboundOffset({
        exchangeAccountId: "primary",
        updateSource: "GET_UPDATES",
        botTokenRef: "sha256:bot-b",
      }))?.nextOffset,
      5,
    );
  } finally {
    bundle.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("sqlite repository returns the latest strategy decision for a market and strategy", async () => {
  const databasePath = await createTempDatabasePath("strategy-decisions");
  const bundle = createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "operator",
    userTelegramId: "telegram-user",
    userDisplayName: "Operator",
    accessKeyRef: "ENV:UPBIT_ACCESS_KEY",
    secretKeyRef: "ENV:UPBIT_SECRET_KEY",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    killSwitchActive: false,
  });

  try {
    const older = createStrategyDecisionRecord({
      id: "decision-older",
      createdAt: "2026-04-20T00:00:00.000Z",
    });
    const newer = createStrategyDecisionRecord({
      id: "decision-newer",
      createdAt: "2026-04-20T01:00:00.000Z",
    });
    const otherStrategy = createStrategyDecisionRecord({
      id: "decision-other-strategy",
      strategyKey: "other.strategy.v1",
      createdAt: "2026-04-20T02:00:00.000Z",
    });
    await bundle.repositories.saveStrategyDecision(older);
    await bundle.repositories.saveStrategyDecision(newer);
    await bundle.repositories.saveStrategyDecision(otherStrategy);

    const latestAny = await bundle.repositories.getLatestStrategyDecision("primary", "KRW-BTC");
    const latestPositionGuard = await bundle.repositories.getLatestStrategyDecision(
      "primary",
      "KRW-BTC",
      "position_guard.paper_core.v1",
    );

    assert.deepEqual(latestAny, otherStrategy);
    assert.deepEqual(latestPositionGuard, newer);
  } finally {
    bundle.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("sqlite repository round-trips pending-confirmation strategy decisions after migrations", async () => {
  const databasePath = await createTempDatabasePath("pending-confirmation-decision");
  const bundle = createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "operator",
    userTelegramId: "telegram-user",
    userDisplayName: "Operator",
    accessKeyRef: "ENV:UPBIT_ACCESS_KEY",
    secretKeyRef: "ENV:UPBIT_SECRET_KEY",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    killSwitchActive: false,
  });

  try {
    const decision = createStrategyDecisionRecord({
      id: "decision-pending-confirmation",
      status: "PENDING_CONFIRMATION",
    });

    await bundle.repositories.saveStrategyDecision(decision);

    const stored = await bundle.repositories.getLatestStrategyDecision(
      "primary",
      "KRW-BTC",
      "position_guard.paper_core.v1",
    );
    assert.deepEqual(stored, decision);
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

    const byId = await bundle.repositories.findOrderByReference("primary", "order-1");
    const byIdentifier = await bundle.repositories.findOrderByReference("primary", "identifier-1");
    const byUuid = await bundle.repositories.findOrderByReference("primary", "uuid-1");
    const events = await bundle.repositories.listOrderEvents("order-1");
    const fills = await bundle.repositories.listFills("order-1");

    assert.equal(byId?.id, "order-1");
    assert.equal(byIdentifier?.id, "order-1");
    assert.equal(byUuid?.id, "order-1");
    assert.equal(events[0]?.eventType, "ORDER_PERSISTED");
    assert.equal(fills[0]?.exchangeFillId, "exchange-fill-1");
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

test("sqlite active-order listing excludes terminal orders and applies bounded newest-first limits", async () => {
  const databasePath = await createTempDatabasePath("active-order-limit");
  const bundle = createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "user-active-orders",
    userTelegramId: "telegram-user-active-orders",
    userDisplayName: "Active Order Operator",
    accessKeyRef: "secret://upbit/access",
    secretKeyRef: "secret://upbit/secret",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    killSwitchActive: false,
  });

  try {
    await bundle.repositories.saveOrder(createOrderRecord({
      id: "old-active-btc",
      market: "KRW-BTC",
      status: "OPEN",
      updatedAt: "2026-04-20T00:00:01.000Z",
    }));
    await bundle.repositories.saveOrder(createOrderRecord({
      id: "new-active-btc",
      market: "KRW-BTC",
      status: "PARTIALLY_FILLED",
      updatedAt: "2026-04-20T00:00:03.000Z",
    }));
    await bundle.repositories.saveOrder(createOrderRecord({
      id: "active-eth",
      market: "KRW-ETH",
      status: "CANCEL_REQUESTED",
      updatedAt: "2026-04-20T00:00:02.000Z",
    }));
    await bundle.repositories.saveOrder(createOrderRecord({
      id: "terminal-btc",
      market: "KRW-BTC",
      status: "FILLED",
      updatedAt: "2026-04-20T00:00:04.000Z",
    }));

    const latestTwoActive = await bundle.repositories.listActiveOrders("primary", undefined, 2);
    const latestBtcActive = await bundle.repositories.listActiveOrders("primary", "KRW-BTC", 1);

    assert.deepEqual(
      latestTwoActive.map((order) => order.id),
      ["new-active-btc", "active-eth"],
    );
    assert.deepEqual(
      latestBtcActive.map((order) => order.id),
      ["new-active-btc"],
    );
  } finally {
    bundle.close();
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

function createNotificationTestPersistence(databasePath: string) {
  return createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "user-notification-test",
    userTelegramId: "telegram-notification-test",
    userDisplayName: "Notification Test Operator",
    accessKeyRef: "secret://upbit/access",
    secretKeyRef: "secret://upbit/secret",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    killSwitchActive: false,
  });
}

async function assertOperatorNotificationInsertOnlyContract(repository: ExecutionRepository): Promise<void> {
  const pending = createNotification({
    id: "operator-notification-insert-only",
    title: "Candidate pilot recovery completed",
    message: "Candidate pilot recovery completed without drift.",
    payloadJson: JSON.stringify({ deploymentId: "deployment-insert-only" }),
    createdAt: "2026-08-24T00:00:00.000Z",
  });

  await repository.saveOperatorNotification(pending);
  await assert.rejects(repository.saveOperatorNotification({ ...pending }));
  assert.deepEqual(await readOperatorNotification(repository, pending.id), pending);

  await assert.rejects(repository.saveOperatorNotification({
    ...pending,
    message: "Conflicting immutable notification material.",
  }));
  assert.deepEqual(await readOperatorNotification(repository, pending.id), pending);

  const [leased] = await repository.claimPendingOperatorNotifications("primary", {
    limit: 1,
    dueBefore: "2026-08-24T00:01:00.000Z",
    claimedAt: "2026-08-24T00:01:00.000Z",
    leaseToken: "lease-insert-only-sent",
    leaseExpiresAt: "2026-08-24T00:02:00.000Z",
  });
  assert.equal(leased?.id, pending.id);
  const leasedReadback = await readOperatorNotification(repository, pending.id);
  await assert.rejects(repository.saveOperatorNotification({ ...pending }));
  assert.deepEqual(await readOperatorNotification(repository, pending.id), leasedReadback);

  assert.equal(await repository.compareAndSetOperatorNotificationDeliveryStatus({
    id: pending.id,
    leaseToken: "lease-insert-only-sent",
    deliveryStatus: "SENT",
    attemptCount: leased?.attemptCount ?? 0,
    lastAttemptAt: "2026-08-24T00:01:01.000Z",
    nextAttemptAt: null,
    failureClass: null,
    deliveredAt: "2026-08-24T00:01:01.000Z",
    lastError: null,
  }), true);
  const sentReadback = await readOperatorNotification(repository, pending.id);
  await assert.rejects(repository.saveOperatorNotification({ ...pending }));
  assert.deepEqual(await readOperatorNotification(repository, pending.id), sentReadback);

  const pendingFailure = createNotification({
    id: "operator-notification-insert-only-failed",
    title: "Candidate pilot recovery failed",
    message: "Candidate pilot recovery requires operator action.",
    payloadJson: JSON.stringify({ deploymentId: "deployment-insert-only" }),
    createdAt: "2026-08-24T00:03:00.000Z",
  });
  await repository.saveOperatorNotification(pendingFailure);
  const [leasedFailure] = await repository.claimPendingOperatorNotifications("primary", {
    limit: 1,
    dueBefore: "2026-08-24T00:04:00.000Z",
    claimedAt: "2026-08-24T00:04:00.000Z",
    leaseToken: "lease-insert-only-failed",
    leaseExpiresAt: "2026-08-24T00:05:00.000Z",
  });
  assert.equal(leasedFailure?.id, pendingFailure.id);
  assert.equal(await repository.compareAndSetOperatorNotificationDeliveryStatus({
    id: pendingFailure.id,
    leaseToken: "lease-insert-only-failed",
    deliveryStatus: "FAILED",
    attemptCount: leasedFailure?.attemptCount ?? 0,
    lastAttemptAt: "2026-08-24T00:04:01.000Z",
    nextAttemptAt: null,
    failureClass: "PERMANENT",
    deliveredAt: null,
    lastError: "telegram_http_403",
  }), true);
  const failedReadback = await readOperatorNotification(repository, pendingFailure.id);
  await assert.rejects(repository.saveOperatorNotification({ ...pendingFailure }));
  assert.deepEqual(await readOperatorNotification(repository, pendingFailure.id), failedReadback);
}

async function readOperatorNotification(
  repository: ExecutionRepository,
  notificationId: string,
): Promise<OperatorNotificationRecord> {
  const notification = (await repository.listOperatorNotifications("primary", 100))
    .find((candidate) => candidate.id === notificationId);
  assert.ok(notification, `Expected operator notification ${notificationId}.`);
  return notification;
}

async function createPre0016Database(
  databasePath: string,
  omitReferencePriceColumn: boolean,
): Promise<void> {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE _schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY
      );
      CREATE TABLE exchange_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE strategy_decisions (
        id TEXT PRIMARY KEY,
        exchange_account_id TEXT NOT NULL,
        strategy_key TEXT NOT NULL,
        market TEXT NOT NULL CHECK (market IN ('KRW-BTC', 'KRW-ETH')),
        action TEXT NOT NULL CHECK (action IN ('ENTER', 'ADD', 'REDUCE', 'EXIT', 'HOLD')),
        status TEXT NOT NULL CHECK (status IN ('READY', 'BLOCKED_BY_RISK', 'NO_ACTION', 'DATA_STALE')),
        decision_basis_json TEXT NOT NULL,
        intended_notional_krw TEXT,
        intended_quantity TEXT,
        ${omitReferencePriceColumn ? "" : "reference_price TEXT,"}
        created_at TEXT NOT NULL,
        FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        strategy_decision_id TEXT,
        exchange_account_id TEXT NOT NULL,
        FOREIGN KEY (strategy_decision_id) REFERENCES strategy_decisions(id) ON DELETE SET NULL,
        FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE risk_events (
        id TEXT PRIMARY KEY,
        exchange_account_id TEXT NOT NULL,
        strategy_decision_id TEXT,
        order_id TEXT,
        FOREIGN KEY (exchange_account_id) REFERENCES exchange_accounts(id) ON DELETE CASCADE,
        FOREIGN KEY (strategy_decision_id) REFERENCES strategy_decisions(id) ON DELETE SET NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
      );
      INSERT INTO users (id) VALUES ('legacy-user');
      INSERT INTO exchange_accounts (id, user_id) VALUES ('primary', 'legacy-user');
      INSERT INTO strategy_decisions (
        id,
        exchange_account_id,
        strategy_key,
        market,
        action,
        status,
        decision_basis_json,
        intended_notional_krw,
        intended_quantity,
        ${omitReferencePriceColumn ? "" : "reference_price,"}
        created_at
      ) VALUES (
        'legacy-decision',
        'primary',
        'position_guard.paper_core.v1',
        'KRW-BTC',
        'ENTER',
        'READY',
        '{}',
        '100000',
        NULL,
        ${omitReferencePriceColumn ? "" : "'110000000',"}
        '2026-04-20T00:00:00.000Z'
      );
      INSERT INTO orders (id, strategy_decision_id, exchange_account_id)
        VALUES ('legacy-order', 'legacy-decision', 'primary');
      INSERT INTO risk_events (id, exchange_account_id, strategy_decision_id, order_id)
        VALUES ('legacy-risk', 'primary', 'legacy-decision', 'legacy-order');
    `);

    const migrationNames = (await readdir(path.resolve(process.cwd(), "migrations")))
      .filter((filename) => filename.endsWith(".sql"))
      .filter((filename) => filename !== "0016_add_pending_confirmation_strategy_decision_status.sql");
    const insertMigration = db.prepare(
      "INSERT INTO _schema_migrations (filename, applied_at) VALUES (?, ?)",
    );
    for (const filename of migrationNames) {
      insertMigration.run(filename, "2026-04-20T00:00:00.000Z");
    }
  } finally {
    db.close();
  }
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

function createStrategyDecisionRecord(overrides: Partial<StrategyDecisionRecord> = {}): StrategyDecisionRecord {
  return {
    id: "decision-1",
    exchangeAccountId: "primary",
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "ENTER",
    status: "READY",
    decisionBasisJson: JSON.stringify({
      metadata: {
        executionDisposition: "IMMEDIATE",
        signalQualityBucket: "HIGH",
        diagnosticsJson: JSON.stringify({ entryPath: "RECLAIM" }),
      },
    }),
    intendedNotionalKrw: "100000",
    intendedQuantity: null,
    referencePrice: "110000000",
    createdAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}

function createStrategySchedulerRun(
  overrides: Partial<StrategySchedulerRunRecord> & Pick<StrategySchedulerRunRecord, "id" | "status" | "startedAt">,
): StrategySchedulerRunRecord {
  return {
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    triggerSource: "SCHEDULER",
    completedAt: null,
    intervalMs: 3_600_000,
    runOnStart: false,
    strategyDecisionId: null,
    action: null,
    orderId: null,
    orderStatus: null,
    submissionAccepted: null,
    detail: null,
    errorMessage: null,
    summaryJson: "{}",
    ...overrides,
  };
}

function createOrderRecord(overrides: Partial<OrderRecord> & Pick<OrderRecord, "id">): OrderRecord {
  return {
    strategyDecisionId: null,
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "500000",
    timeInForce: null,
    smpType: null,
    identifier: `${overrides.id}-identifier`,
    idempotencyKey: `${overrides.id}-idempotency`,
    origin: "STRATEGY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: null,
    status: "OPEN",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}

async function assertAtomicLifecycleContract(repository: ExecutionRepository): Promise<void> {
  const intentOrder = createOrderRecord({
    id: "atomic-intent-order",
    status: "PERSISTED",
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const intentEvent = createOrderEvent(intentOrder.id, "atomic-intent-event", "ORDER_PERSISTED");
  await repository.persistOrderIntent({ order: intentOrder, event: intentEvent });

  intentOrder.status = "FILLED";
  intentEvent.eventType = "MUTATED_BY_CALLER";
  const persistedIntent = await repository.findOrderByReference("primary", "atomic-intent-order");
  assert.equal(persistedIntent?.status, "PERSISTED");
  assert.equal((await repository.listOrderEvents("atomic-intent-order"))[0]?.eventType, "ORDER_PERSISTED");

  await assert.rejects(
    repository.persistOrderIntent({
      order: createOrderRecord({
        id: "atomic-duplicate-identifier",
        status: "PERSISTED",
        identifier: persistedIntent?.identifier ?? "atomic-intent-order-identifier",
        idempotencyKey: "other-idempotency-key",
      }),
      event: createOrderEvent("atomic-duplicate-identifier", "atomic-duplicate-identifier-event", "ORDER_PERSISTED"),
    }),
  );
  await assert.rejects(
    repository.persistOrderIntent({
      order: createOrderRecord({
        id: "atomic-duplicate-idempotency",
        status: "PERSISTED",
        identifier: "atomic-duplicate-idempotency-identifier",
        idempotencyKey: persistedIntent?.idempotencyKey ?? "atomic-intent-order-idempotency",
      }),
      event: createOrderEvent("atomic-duplicate-idempotency", "atomic-duplicate-idempotency-event", "ORDER_PERSISTED"),
    }),
  );

  await repository.persistOrderIntent({
    order: createOrderRecord({
      id: "atomic-intent-order",
      status: "PERSISTED",
      updatedAt: "2026-08-21T00:00:00.000Z",
    }),
    event: createOrderEvent("atomic-intent-order", "atomic-intent-event", "ORDER_PERSISTED"),
  });
  assert.equal((await repository.listOrderEvents("atomic-intent-order")).length, 1);

  await assert.rejects(
    repository.persistOrderIntent({
      order: createOrderRecord({
        id: "atomic-intent-order",
        status: "PERSISTED",
        updatedAt: "2026-08-21T00:00:01.000Z",
      }),
      event: createOrderEvent("atomic-intent-order", "atomic-conflicting-event", "ORDER_PERSISTED"),
    }),
  );
  assert.equal((await repository.listOrderEvents("atomic-intent-order")).length, 1);

  const submittedOrder = createOrderRecord({
    id: "atomic-intent-order",
    status: "PARTIALLY_FILLED",
    upbitUuid: "atomic-upbit-uuid",
    exchangeResponseJson: "{\"state\":\"wait\"}",
    updatedAt: "2026-08-21T00:00:02.000Z",
  });
  const submissionEvent = createOrderEvent(submittedOrder.id, "atomic-submission-event", "ORDER_SUBMITTED");
  const fill = createFill(submittedOrder.id, "atomic-fill");
  submissionEvent.eventSource = "LOCAL";
  await assert.rejects(
    repository.persistExchangeSubmission({
      order: { ...submittedOrder, status: "OPEN" },
      event: { ...submissionEvent },
      fills: [fill],
    }),
  );
  await assert.rejects(
    repository.persistExchangeSubmission({
      order: submittedOrder,
      event: submissionEvent,
      fills: [fill, { ...fill }],
    }),
  );
  assert.equal((await repository.findOrderByReference("primary", submittedOrder.id))?.status, "PERSISTED");
  assert.equal((await repository.listFills(submittedOrder.id)).length, 0);
  await repository.persistExchangeSubmission({
    order: submittedOrder,
    event: submissionEvent,
    fills: [fill],
  });
  await repository.persistExchangeSubmission({
    order: { ...submittedOrder },
    event: { ...submissionEvent },
    fills: [{ ...fill }],
  });
  fill.price = "1";
  assert.equal((await repository.findOrderByReference("primary", submittedOrder.id))?.status, "PARTIALLY_FILLED");
  assert.equal((await repository.listFills(submittedOrder.id)).length, 1);
  assert.equal((await repository.listFills(submittedOrder.id))[0]?.price, "500000");

  const filledOrder = createOrderRecord({
    id: "atomic-filled-order",
    status: "PERSISTED",
    updatedAt: "2026-08-21T00:00:03.000Z",
  });
  await repository.persistOrderIntent({
    order: filledOrder,
    event: createOrderEvent(filledOrder.id, "atomic-filled-intent", "ORDER_PERSISTED"),
  });
  const terminalOrder = { ...filledOrder, status: "FILLED" as const, upbitUuid: "atomic-filled-uuid" };
  const terminalSubmission = createOrderEvent(terminalOrder.id, "atomic-filled-submission", "ORDER_SUBMITTED");
  terminalSubmission.eventSource = "LOCAL";
  const terminalEvent = createOrderEvent(terminalOrder.id, "atomic-filled-terminal", "ORDER_FILLED");
  terminalEvent.eventSource = "LOCAL";
  const terminalFill = createFill(terminalOrder.id, "atomic-filled-fill");
  await assert.rejects(repository.persistExchangeSubmission({
    order: terminalOrder,
    event: terminalSubmission,
    terminalEvent: { ...terminalEvent, id: terminalSubmission.id },
    fills: [terminalFill],
  }));
  assert.equal((await repository.findOrderByReference("primary", terminalOrder.id))?.status, "PERSISTED");
  assert.equal((await repository.listOrderEvents(terminalOrder.id)).length, 1);
  assert.equal((await repository.listFills(terminalOrder.id)).length, 0);
  await assert.rejects(repository.persistExchangeSubmission({
    order: terminalOrder,
    event: terminalSubmission,
    fills: [terminalFill],
  }));
  assert.equal((await repository.findOrderByReference("primary", terminalOrder.id))?.status, "PERSISTED");
  assert.equal((await repository.listOrderEvents(terminalOrder.id)).length, 1);
  await repository.persistExchangeSubmission({
    order: terminalOrder,
    event: terminalSubmission,
    terminalEvent,
    fills: [terminalFill],
  });
  await repository.persistExchangeSubmission({
    order: { ...terminalOrder },
    event: { ...terminalSubmission },
    terminalEvent: { ...terminalEvent },
    fills: [{ ...terminalFill }],
  });
  assert.deepEqual((await repository.listOrderEvents(terminalOrder.id)).map((event) => event.eventType).sort(), [
    "ORDER_FILLED", "ORDER_PERSISTED", "ORDER_SUBMITTED",
  ]);

  const uncertainOrder = createOrderRecord({
    id: "atomic-uncertain-order",
    status: "PERSISTED",
    updatedAt: "2026-08-21T00:00:03.000Z",
  });
  await repository.persistOrderIntent({
    order: uncertainOrder,
    event: createOrderEvent(uncertainOrder.id, "atomic-uncertain-intent", "ORDER_PERSISTED"),
  });
  const reconciliationRequiredOrder = {
    ...uncertainOrder,
    status: "RECONCILIATION_REQUIRED" as const,
    failureCode: "RECONCILIATION_REQUIRED",
    failureMessage: "Submission outcome requires reconciliation.",
    updatedAt: "2026-08-21T00:00:04.000Z",
  };
  const recoveryEvent = createOrderEvent(
    reconciliationRequiredOrder.id,
    "atomic-recovery-event",
    "RECONCILIATION_RECOVERY_REQUIRED",
  );
  const riskEvent = createRiskEvent(reconciliationRequiredOrder.id, "atomic-uncertain-risk");
  await repository.persistUncertainSubmission({
    order: reconciliationRequiredOrder,
    event: recoveryEvent,
    riskEvent,
  });
  await repository.persistUncertainSubmission({
    order: { ...reconciliationRequiredOrder },
    event: { ...recoveryEvent },
    riskEvent: { ...riskEvent },
  });
  assert.equal(
    (await repository.findOrderByReference("primary", reconciliationRequiredOrder.id))?.status,
    "RECONCILIATION_REQUIRED",
  );
  assert.equal((await repository.listOrderEvents(reconciliationRequiredOrder.id)).length, 2);
  assert.equal((await repository.listRiskEvents("primary")).filter((event) => event.id === riskEvent.id).length, 1);

  await assert.rejects(
    repository.persistExchangeSubmission({
      order: {
        ...submittedOrder,
        identifier: "mutated-identifier",
        status: "FILLED",
      },
      event: {
        ...submissionEvent,
        id: "immutable-mutation-event",
        eventType: "ORDER_SUBMITTED",
      },
      fills: [createFill(submittedOrder.id, "immutable-mutation-fill")],
    }),
  );

  const partialOrder = createOrderRecord({ id: "partial-child-order", status: "PERSISTED" });
  await repository.persistOrderIntent({
    order: partialOrder,
    event: createOrderEvent(partialOrder.id, "partial-child-intent", "ORDER_PERSISTED"),
  });
  const partialEvent = createOrderEvent(partialOrder.id, "partial-child-submission", "ORDER_SUBMITTED");
  partialEvent.eventSource = "EXCHANGE";
  await repository.appendOrderEvent(partialEvent);
  await assert.rejects(
    repository.persistExchangeSubmission({
      order: { ...partialOrder, status: "PARTIALLY_FILLED" },
      event: partialEvent,
      fills: [createFill(partialOrder.id, "partial-child-fill")],
    }),
  );
  assert.equal((await repository.findOrderByReference("primary", partialOrder.id))?.status, "PERSISTED");
  assert.equal((await repository.listFills(partialOrder.id)).length, 0);

  const extraSubmissionEventOrder = createOrderRecord({ id: "extra-submission-event-order", status: "PERSISTED" });
  await repository.persistOrderIntent({
    order: extraSubmissionEventOrder,
    event: createOrderEvent(extraSubmissionEventOrder.id, "extra-submission-event-intent", "ORDER_PERSISTED"),
  });
  const extraSubmissionEvent = createOrderEvent(
    extraSubmissionEventOrder.id,
    "extra-submission-event-existing",
    "ORDER_SUBMITTED",
  );
  extraSubmissionEvent.eventSource = "EXCHANGE";
  await repository.appendOrderEvent(extraSubmissionEvent);
  const incomingSubmissionEvent = createOrderEvent(
    extraSubmissionEventOrder.id,
    "extra-submission-event-incoming",
    "ORDER_SUBMITTED",
  );
  incomingSubmissionEvent.eventSource = "EXCHANGE";
  await assert.rejects(repository.persistExchangeSubmission({
    order: { ...extraSubmissionEventOrder, status: "PARTIALLY_FILLED" },
    event: incomingSubmissionEvent,
    fills: [createFill(extraSubmissionEventOrder.id, "extra-submission-event-fill")],
  }));

  const extraFillOrder = createOrderRecord({ id: "extra-fill-order", status: "PERSISTED" });
  await repository.persistOrderIntent({
    order: extraFillOrder,
    event: createOrderEvent(extraFillOrder.id, "extra-fill-intent", "ORDER_PERSISTED"),
  });
  await repository.saveFill(createFill(extraFillOrder.id, "extra-fill-existing"));
  const extraFillEvent = createOrderEvent(extraFillOrder.id, "extra-fill-event", "ORDER_SUBMITTED");
  extraFillEvent.eventSource = "EXCHANGE";
  await assert.rejects(repository.persistExchangeSubmission({
    order: { ...extraFillOrder, status: "PARTIALLY_FILLED" },
    event: extraFillEvent,
    fills: [createFill(extraFillOrder.id, "extra-fill-incoming")],
  }));

  const extraRecoveryEventOrder = createOrderRecord({ id: "extra-recovery-event-order", status: "PERSISTED" });
  await repository.persistOrderIntent({
    order: extraRecoveryEventOrder,
    event: createOrderEvent(extraRecoveryEventOrder.id, "extra-recovery-event-intent", "ORDER_PERSISTED"),
  });
  await repository.appendOrderEvent(createOrderEvent(
    extraRecoveryEventOrder.id,
    "extra-recovery-event-existing",
    "RECONCILIATION_RECOVERY_REQUIRED",
  ));
  const extraRecoveryEventNext = toReconciliationRequiredOrder(extraRecoveryEventOrder);
  await assert.rejects(repository.persistUncertainSubmission({
    order: extraRecoveryEventNext,
    event: createOrderEvent(extraRecoveryEventOrder.id, "extra-recovery-event-incoming", "RECONCILIATION_RECOVERY_REQUIRED"),
    riskEvent: createRiskEvent(extraRecoveryEventOrder.id, "extra-recovery-event-risk"),
  }));

  const extraRiskOrder = createOrderRecord({ id: "extra-risk-order", status: "PERSISTED" });
  await repository.persistOrderIntent({
    order: extraRiskOrder,
    event: createOrderEvent(extraRiskOrder.id, "extra-risk-intent", "ORDER_PERSISTED"),
  });
  await repository.saveRiskEvent(createRiskEvent(extraRiskOrder.id, "extra-risk-existing"));
  const extraRiskNext = toReconciliationRequiredOrder(extraRiskOrder);
  await assert.rejects(repository.persistUncertainSubmission({
    order: extraRiskNext,
    event: createOrderEvent(extraRiskOrder.id, "extra-risk-event", "RECONCILIATION_RECOVERY_REQUIRED"),
    riskEvent: createRiskEvent(extraRiskOrder.id, "extra-risk-incoming"),
  }));

  const reconciledOrder = createOrderRecord({
    id: "atomic-reconciled-parity-order",
    status: "OPEN",
    executionMode: "LIVE",
    upbitUuid: "atomic-reconciled-parity-uuid",
    exchangeResponseJson: JSON.stringify({ state: "wait" }),
  });
  await repository.saveOrder(reconciledOrder);
  const reconciledTerminal = {
    ...reconciledOrder,
    status: "FILLED" as const,
    exchangeResponseJson: JSON.stringify({ state: "done" }),
    updatedAt: "2026-08-21T00:02:00.000Z",
  };
  const reconciledEvent: OrderEventRecord = {
    id: "atomic-reconciled-parity-event",
    orderId: reconciledOrder.id,
    eventType: "RECONCILIATION_STATUS_UPDATED",
    eventSource: "RECONCILIATION",
    payloadJson: JSON.stringify({ previousStatus: "OPEN", nextStatus: "FILLED" }),
    createdAt: reconciledTerminal.updatedAt,
  };
  const reconciledFills = [
    {
      ...createFill(reconciledOrder.id, "atomic-reconciled-parity-fill-1"),
      exchangeFillId: "atomic-reconciled-parity-exchange-fill-1",
    },
    {
      ...createFill(reconciledOrder.id, "atomic-reconciled-parity-fill-2"),
      exchangeFillId: "atomic-reconciled-parity-exchange-fill-2",
      volume: "0.002",
    },
  ];
  const persistReconciledSnapshot = repository.persistReconciledExchangeSnapshot;
  assert.ok(persistReconciledSnapshot);
  assert.deepEqual(await persistReconciledSnapshot.call(repository, {
    expectedOrder: reconciledOrder,
    order: reconciledTerminal,
    event: reconciledEvent,
    fills: reconciledFills,
  }), { outcome: "APPLIED", insertedFillCount: 2 });
  const completeAggregate = {
    order: await repository.findOrderById("primary", reconciledOrder.id),
    events: await repository.listOrderEvents(reconciledOrder.id),
    fills: await repository.listFills(reconciledOrder.id),
  };
  assert.deepEqual(await persistReconciledSnapshot.call(repository, {
    expectedOrder: reconciledTerminal,
    order: reconciledTerminal,
    event: null,
    fills: reconciledFills.map((fill, index) => ({ ...fill, id: `replayed-local-fill-${index}` })),
  }), { outcome: "DUPLICATE", insertedFillCount: 0 });
  assert.deepEqual({
    order: await repository.findOrderById("primary", reconciledOrder.id),
    events: await repository.listOrderEvents(reconciledOrder.id),
    fills: await repository.listFills(reconciledOrder.id),
  }, completeAggregate);
  await assert.rejects(persistReconciledSnapshot.call(repository, {
    expectedOrder: reconciledTerminal,
    order: reconciledTerminal,
    event: null,
    fills: [{ ...reconciledFills[0]!, id: "conflicting-replay-fill", price: "500000.0" }],
  }));
  assert.deepEqual({
    order: await repository.findOrderById("primary", reconciledOrder.id),
    events: await repository.listOrderEvents(reconciledOrder.id),
    fills: await repository.listFills(reconciledOrder.id),
  }, completeAggregate);

  assert.deepEqual(await persistReconciledSnapshot.call(repository, {
    expectedOrder: reconciledOrder,
    order: reconciledOrder,
    event: null,
    fills: [],
  }), { outcome: "CONFLICT", insertedFillCount: 0 });
  assert.deepEqual({
    order: await repository.findOrderById("primary", reconciledOrder.id),
    events: await repository.listOrderEvents(reconciledOrder.id),
    fills: await repository.listFills(reconciledOrder.id),
  }, completeAggregate);

  const recoveryOrder = createOrderRecord({ id: "atomic-recovery-parity-order", status: "OPEN" });
  await repository.saveOrder(recoveryOrder);
  const recoveryNext = {
    ...recoveryOrder,
    status: "RECONCILIATION_REQUIRED" as const,
    failureCode: "RECONCILIATION_REQUIRED",
    failureMessage: "Exchange snapshot is unavailable.",
    updatedAt: "2026-08-21T00:03:00.000Z",
  };
  const atomicRecoveryEvent: OrderEventRecord = {
    id: "atomic-recovery-parity-event",
    orderId: recoveryOrder.id,
    eventType: "RECONCILIATION_RECOVERY_REQUIRED",
    eventSource: "RECONCILIATION",
    payloadJson: JSON.stringify({ reason: recoveryNext.failureMessage }),
    createdAt: recoveryNext.updatedAt,
  };
  const atomicRecoveryRisk: RiskEventRecord = {
    id: "atomic-recovery-parity-risk",
    exchangeAccountId: recoveryOrder.exchangeAccountId,
    strategyDecisionId: recoveryOrder.strategyDecisionId,
    orderId: recoveryOrder.id,
    level: "WARN",
    ruleCode: "ORDER_RECOVERY_REQUIRED",
    message: recoveryNext.failureMessage,
    payloadJson: JSON.stringify({ orderId: recoveryOrder.id }),
    createdAt: recoveryNext.updatedAt,
  };
  const persistRecovery = repository.persistReconciliationRecovery;
  assert.ok(persistRecovery);
  assert.deepEqual(await persistRecovery.call(repository, {
    expectedOrder: recoveryOrder,
    order: recoveryNext,
    event: atomicRecoveryEvent,
    riskEvent: atomicRecoveryRisk,
  }), { outcome: "APPLIED" });
  const recoveryAggregate = {
    order: await repository.findOrderById("primary", recoveryOrder.id),
    events: await repository.listOrderEvents(recoveryOrder.id),
    risks: (await repository.listRiskEvents("primary")).filter((risk) => risk.orderId === recoveryOrder.id),
  };
  assert.deepEqual(await persistRecovery.call(repository, {
    expectedOrder: recoveryNext,
    order: recoveryNext,
    event: atomicRecoveryEvent,
    riskEvent: atomicRecoveryRisk,
  }), { outcome: "DUPLICATE" });
  await assert.rejects(persistRecovery.call(repository, {
    expectedOrder: recoveryNext,
    order: recoveryNext,
    event: atomicRecoveryEvent,
    riskEvent: { ...atomicRecoveryRisk, message: "conflicting retry material" },
  }));
  assert.deepEqual({
    order: await repository.findOrderById("primary", recoveryOrder.id),
    events: await repository.listOrderEvents(recoveryOrder.id),
    risks: (await repository.listRiskEvents("primary")).filter((risk) => risk.orderId === recoveryOrder.id),
  }, recoveryAggregate);

  const recoveryConflictOrder = createOrderRecord({ id: "atomic-recovery-conflict-order", status: "OPEN" });
  await repository.saveOrder(recoveryConflictOrder);
  const recoveryWinner = {
    ...recoveryConflictOrder,
    status: "FILLED" as const,
    updatedAt: "2026-08-21T00:04:00.000Z",
  };
  await repository.updateOrder(recoveryWinner);
  assert.deepEqual(await persistRecovery.call(repository, {
    expectedOrder: recoveryConflictOrder,
    order: {
      ...recoveryConflictOrder,
      status: "RECONCILIATION_REQUIRED",
      failureCode: "RECONCILIATION_REQUIRED",
      failureMessage: "stale recovery",
      updatedAt: "2026-08-21T00:05:00.000Z",
    },
    event: { ...atomicRecoveryEvent, id: "atomic-recovery-conflict-event", orderId: recoveryConflictOrder.id },
    riskEvent: { ...atomicRecoveryRisk, id: "atomic-recovery-conflict-risk", orderId: recoveryConflictOrder.id },
  }), { outcome: "CONFLICT" });
  assert.deepEqual(await repository.findOrderById("primary", recoveryConflictOrder.id), recoveryWinner);
  assert.deepEqual(await repository.listOrderEvents(recoveryConflictOrder.id), []);
  assert.deepEqual((await repository.listRiskEvents("primary")).filter((risk) => risk.orderId === recoveryConflictOrder.id), []);

  const immutableFillOrder = createOrderRecord({ id: "immutable-fill-order", status: "PERSISTED" });
  await repository.persistOrderIntent({
    order: immutableFillOrder,
    event: createOrderEvent(immutableFillOrder.id, "immutable-fill-intent", "ORDER_PERSISTED"),
  });
  const immutableFill = {
    ...createFill(immutableFillOrder.id, "immutable-fill-original"),
    exchangeFillId: "immutable-exchange-fill",
    feeProvenance: "EXCHANGE_FILL_CONFIRMED" as const,
    executionTimestampProvenance: "EXCHANGE_FILL_CONFIRMED" as const,
    executionEpochNs: "1787270402000000000",
    rawPayloadJson: JSON.stringify({ uuid: "immutable-exchange-fill", price: "500000", volume: "0.001" }),
  };
  await repository.saveFill(immutableFill);
  await repository.saveFill({ ...immutableFill, id: "immutable-fill-replay-local-id" });
  assert.deepEqual(await repository.listFills(immutableFillOrder.id), [immutableFill]);

  const conflictingFillMutations: FillRecord[] = [
    { ...immutableFill, id: "immutable-fill-price-conflict", price: "500000.0" },
    { ...immutableFill, id: "immutable-fill-volume-conflict", volume: "0.0010" },
    { ...immutableFill, id: "immutable-fill-market-conflict", market: "KRW-ETH" },
    { ...immutableFill, id: "immutable-fill-side-conflict", side: "ask" },
    { ...immutableFill, id: "immutable-fill-raw-conflict", rawPayloadJson: JSON.stringify({ changed: true }) },
  ];
  for (const conflictingFill of conflictingFillMutations) {
    await assert.rejects(repository.saveFill(conflictingFill));
    assert.deepEqual(await repository.listFills(immutableFillOrder.id), [immutableFill]);
  }

  await assert.rejects(repository.saveFill({
    ...immutableFill,
    orderId: extraFillOrder.id,
    exchangeFillId: "different-exchange-fill",
  }));
  assert.deepEqual(await repository.listFills(immutableFillOrder.id), [immutableFill]);

  const invalidOrder = createOrderRecord({ id: "invalid-atomic-order", status: "PERSISTED" });
  await assert.rejects(
    repository.persistOrderIntent({
      order: invalidOrder,
      event: createOrderEvent("another-order", "invalid-atomic-event", "ORDER_PERSISTED"),
    }),
  );
  assert.equal(await repository.findOrderByReference("primary", invalidOrder.id), null);
}

function toReconciliationRequiredOrder(order: OrderRecord): OrderRecord {
  return {
    ...order,
    status: "RECONCILIATION_REQUIRED",
    failureCode: "RECONCILIATION_REQUIRED",
    failureMessage: "Submission outcome requires reconciliation.",
    updatedAt: "2026-08-21T00:00:04.000Z",
  };
}

async function assertFaultTimestampPrecisionContract(
  operatorState: OperatorStateStore,
  latestOccurredAt = "2026-08-21T00:00:00.000000009Z",
  offsetEquivalentOccurredAt = "2026-08-21T09:00:00.000000009+09:00",
): Promise<void> {
  const latestFault = {
    exchangeAccountId: "primary",
    faultId: "nanosecond-latest-fault",
    reason: "NANOSECOND_PRECISION",
    occurredAt: latestOccurredAt,
  };
  await operatorState.pauseForFault(latestFault);
  await assert.rejects(operatorState.pauseForFault({
    ...latestFault,
    faultId: "nanosecond-rewind-fault",
    occurredAt: latestOccurredAt.replace("000000009", "000000001"),
  }));

  const offsetEquivalentFault = {
    ...latestFault,
    faultId: "nanosecond-offset-equivalent-fault",
    occurredAt: offsetEquivalentOccurredAt,
  };
  await operatorState.pauseForFault(offsetEquivalentFault);
  assert.equal((await operatorState.getState()).updatedAt, offsetEquivalentFault.occurredAt);
  assert.equal(
    (await operatorState.listTransitions()).filter((transition) => transition.command === "AUTOMATIC_PAUSE").length,
    2,
  );
}

function createOrderEvent(orderId: string, id: string, eventType: string): OrderEventRecord {
  return {
    id,
    orderId,
    eventType,
    eventSource: "LOCAL",
    payloadJson: "{}",
    createdAt: "2026-08-21T00:00:00.000Z",
  };
}

function createFill(orderId: string, id: string): FillRecord {
  return {
    id,
    orderId,
    exchangeFillId: `${id}-exchange`,
    market: "KRW-BTC",
    side: "bid",
    price: "500000",
    volume: "0.001",
    feeCurrency: "KRW",
    feeAmount: "250",
    filledAt: "2026-08-21T00:00:02.000Z",
    rawPayloadJson: "{}",
  };
}

function createRiskEvent(orderId: string, id: string): RiskEventRecord {
  return {
    id,
    exchangeAccountId: "primary",
    strategyDecisionId: null,
    orderId,
    level: "BLOCK",
    ruleCode: "POSITION_GUARD_PILOT_UNCERTAIN_ORDER",
    message: "Order submission requires reconciliation.",
    payloadJson: "{}",
    createdAt: "2026-08-21T00:00:04.000Z",
  };
}

function createInMemoryOperatorState(): InMemoryOperatorStateStore {
  const state: ExecutionStateRecord = {
    id: "state-primary",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: "persisted-drift",
    degradedAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
  return new InMemoryOperatorStateStore(state);
}
