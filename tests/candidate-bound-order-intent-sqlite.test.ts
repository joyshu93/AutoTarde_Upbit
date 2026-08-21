import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CandidateExecutionBindingRecord } from "../src/domain/pilot-types.js";
import type { OrderEventRecord, OrderRecord, StrategyDecisionRecord } from "../src/domain/types.js";
import type { PersistCandidateBoundOrderIntentRequest } from "../src/modules/db/interfaces.js";
import { candidateExecutionBindingMaterialHash } from "../src/modules/db/pilot-interfaces.js";
import { createSqlitePersistence } from "../src/modules/db/repositories/sqlite-repositories.js";
import { createEmptyPositionGuardCandidateState } from
  "../src/modules/strategy/position-guard-candidate-state.js";
import { test } from "./harness.js";

test("sqlite candidate-bound intent persists order first event and binding atomically", async () => {
  const fixture = await createFixture("success");
  try {
    await fixture.bundle.repositories.persistCandidateBoundOrderIntent(fixture.request);

    assert.deepEqual(await fixture.bundle.repositories.listOrders("primary"), [fixture.request.order]);
    assert.deepEqual(
      await fixture.bundle.repositories.listOrderEvents(fixture.request.order.id),
      [fixture.request.event],
    );
    assert.deepEqual(
      await fixture.bundle.candidatePilots.getExecutionBindingForOrder(fixture.request.order.id),
      fixture.request.binding,
    );
  } finally {
    fixture.bundle.close();
    await cleanupDatabase(fixture.databasePath);
  }
});

test("sqlite candidate-bound intent exact retry remains idempotent after close and reopen", async () => {
  const fixture = await createFixture("retry");
  try {
    await persist(fixture);
    await persist(fixture, cloneRequest(fixture.request));
    fixture.bundle.close();
    fixture.bundle = openBundle(fixture.databasePath);
    await persist(fixture, cloneRequest(fixture.request));
    assert.deepEqual(await targetCounts(fixture.databasePath), { orders: 1, events: 1, bindings: 1 });
  } finally {
    fixture.bundle.close();
    await cleanupDatabase(fixture.databasePath);
  }
});

test("sqlite candidate-bound intent rejects conflicting order event and binding identities", async () => {
  for (const variant of ["order", "event", "binding-order", "binding-id"] as const) {
    const fixture = await createFixture(`conflict-${variant}`);
    try {
      if (variant === "order") {
        await fixture.bundle.repositories.saveOrder({ ...fixture.request.order, price: "9999" });
      } else if (variant === "event") {
        const other = otherOrder(fixture.request.order, "event-owner");
        await fixture.bundle.repositories.saveOrder(other);
        await fixture.bundle.repositories.appendOrderEvent({ ...fixture.request.event, orderId: other.id });
      } else if (variant === "binding-order") {
        await fixture.bundle.repositories.saveOrder(fixture.request.order);
        await fixture.bundle.candidatePilots.createExecutionBinding(rehash({
          ...fixture.request.binding,
          id: "other-binding",
        }));
      } else {
        const other = otherOrder(fixture.request.order, "binding-owner");
        const otherDecision = otherDecisionRecord(fixture.decision, "binding-owner-decision");
        await fixture.bundle.repositories.saveStrategyDecision(otherDecision);
        await fixture.bundle.repositories.saveOrder({ ...other, strategyDecisionId: otherDecision.id });
        await fixture.bundle.candidatePilots.createExecutionBinding(rehash({
          ...fixture.request.binding,
          strategyDecisionId: otherDecision.id,
          orderId: other.id,
        }));
      }
      const before = await snapshotTargetRows(fixture.databasePath);
      await assert.rejects(() => persist(fixture), /conflict|duplicate|dangling|partial/i);
      assert.equal(await snapshotTargetRows(fixture.databasePath), before);
    } finally {
      fixture.bundle.close();
      await cleanupDatabase(fixture.databasePath);
    }
  }
});

test("sqlite candidate-bound intent rejects every dangling partial-state permutation", async () => {
  for (const variant of ["order", "event", "binding", "order-event", "order-binding", "event-binding"] as const) {
    const fixture = await createFixture(`dangling-${variant}`);
    try {
      if (variant === "order" || variant === "order-event" || variant === "order-binding") {
        await fixture.bundle.repositories.saveOrder(fixture.request.order);
      }
      if (variant === "event") {
        insertEventRaw(fixture.databasePath, fixture.request.event, false);
      } else if (variant === "order-event") {
        await fixture.bundle.repositories.appendOrderEvent(fixture.request.event);
      }
      if (variant === "binding") {
        insertBindingRaw(fixture.databasePath, fixture.request.binding, false);
      } else if (variant === "order-binding") {
        await fixture.bundle.candidatePilots.createExecutionBinding(fixture.request.binding);
      } else if (variant === "event-binding") {
        insertEventRaw(fixture.databasePath, fixture.request.event, false);
        insertBindingRaw(fixture.databasePath, fixture.request.binding, false);
      }
      const before = await snapshotTargetRows(fixture.databasePath);
      await assert.rejects(() => persist(fixture), /dangling|partial|conflict/i);
      assert.equal(await snapshotTargetRows(fixture.databasePath), before);
    } finally {
      fixture.bundle.close();
      await cleanupDatabase(fixture.databasePath);
    }
  }
});

test("sqlite candidate-bound intent rereads READY decision deployment and exact state authority", async () => {
  for (const variant of [
    "missing-decision", "wrong-decision", "phase", "updated-at", "activation", "account",
    "policy", "version", "missing-state", "state-version",
  ] as const) {
    const fixture = await createFixture(`authority-${variant}`, {
      saveDecision: variant !== "missing-decision",
      decisionStatus: variant === "wrong-decision" ? "DATA_STALE" : "READY",
    });
    try {
      mutateAuthority(fixture.databasePath, variant);
      const before = await snapshotTargetRows(fixture.databasePath);
      await assert.rejects(() => persist(fixture), /decision|deployment|authority|phase|updated|activation|account|policy|version|state/i);
      assert.equal(await snapshotTargetRows(fixture.databasePath), before);
    } finally {
      fixture.bundle.close();
      await cleanupDatabase(fixture.databasePath);
    }
  }
});

test("sqlite candidate-bound intent preserves global identifier and account idempotency uniqueness", async () => {
  for (const field of ["identifier", "idempotencyKey"] as const) {
    const fixture = await createFixture(`unique-${field}`);
    try {
      await fixture.bundle.repositories.saveOrder({
        ...otherOrder(fixture.request.order, `existing-${field}`),
        [field]: fixture.request.order[field],
      });
      const before = await snapshotTargetRows(fixture.databasePath);
      await assert.rejects(() => persist(fixture), /identifier|idempotency|unique|constraint/i);
      assert.equal(await snapshotTargetRows(fixture.databasePath), before);
    } finally {
      fixture.bundle.close();
      await cleanupDatabase(fixture.databasePath);
    }
  }
});

test("sqlite candidate-bound intent rejects extra accessor symbol and malformed public request shapes", async () => {
  const fixture = await createFixture("request-shape");
  try {
    const cases: PersistCandidateBoundOrderIntentRequest[] = [];
    const extra = cloneRequest(fixture.request) as PersistCandidateBoundOrderIntentRequest & { extra?: string };
    extra.extra = "forbidden";
    cases.push(extra);
    const accessor = cloneRequest(fixture.request);
    Object.defineProperty(accessor, "expectedStateVersion", { enumerable: true, get: () => 0 });
    cases.push(accessor);
    const symbol = cloneRequest(fixture.request) as PersistCandidateBoundOrderIntentRequest & { [key: symbol]: string };
    symbol[Symbol("forbidden")] = "value";
    cases.push(symbol);
    const nonPlain = Object.assign(Object.create({ inherited: true }), cloneRequest(fixture.request)) as
      PersistCandidateBoundOrderIntentRequest;
    cases.push(nonPlain);
    for (const request of cases) {
      const before = await snapshotTargetRows(fixture.databasePath);
      await assert.rejects(() => persist(fixture, request), /plain object|exactly own data properties/i);
      assert.equal(await snapshotTargetRows(fixture.databasePath), before);
    }
  } finally {
    fixture.bundle.close();
    await cleanupDatabase(fixture.databasePath);
  }
});

test("sqlite candidate-bound intent rejects nested accessors before authority lookup", async () => {
  const fixture = await createFixture("nested-accessor");
  try {
    const request = cloneRequest(fixture.request);
    let reads = 0;
    Object.defineProperty(request.binding, "strategyDecisionId", {
      enumerable: true,
      get: () => {
        reads += 1;
        return fixture.request.binding.strategyDecisionId;
      },
    });
    await assert.rejects(() => persist(fixture, request), /exactly own data properties/i);
    assert.equal(reads, 0);
    assert.deepEqual(await targetCounts(fixture.databasePath), { orders: 0, events: 0, bindings: 0 });
  } finally {
    fixture.bundle.close();
    await cleanupDatabase(fixture.databasePath);
  }
});

test("sqlite candidate-bound intent rolls back order when event or binding insertion aborts", async () => {
  for (const target of ["event", "binding"] as const) {
    const fixture = await createFixture(`rollback-${target}`);
    try {
      installAbortTrigger(fixture.databasePath, target);
      const before = await snapshotTargetRows(fixture.databasePath);
      await assert.rejects(() => persist(fixture), /forced candidate-bound/i);
      assert.equal(await snapshotTargetRows(fixture.databasePath), before);
      assert.deepEqual(await targetCounts(fixture.databasePath), { orders: 0, events: 0, bindings: 0 });
    } finally {
      fixture.bundle.close();
      await cleanupDatabase(fixture.databasePath);
    }
  }
});

interface FixtureOptions {
  decisionStatus?: StrategyDecisionRecord["status"];
  saveDecision?: boolean;
}

async function createFixture(label: string, options: FixtureOptions = {}) {
  const databasePath = await createTempDatabasePath(label);
  const bundle = createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "operator",
    userTelegramId: "telegram-user",
    userDisplayName: "Operator",
    accessKeyRef: "ENV:UPBIT_ACCESS_KEY",
    secretKeyRef: "ENV:UPBIT_SECRET_KEY",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    killSwitchActive: false,
  });
  const activationAt = "2026-08-20T23:59:59Z";
  const activationEpochNs = BigInt(Date.parse(activationAt)) * 1_000_000n;
  await bundle.candidatePilots.createDeploymentWithInitialState({
    deployment: {
      id: "deployment-1",
      exchangeAccountId: "primary",
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      phase: "PENDING_FLAT",
      activationAt: null,
      activationEpochNs: null,
      createdAt: "2026-08-20T23:00:00Z",
      updatedAt: "2026-08-20T23:00:00Z",
    },
    initialState: createEmptyPositionGuardCandidateState(),
  });
  await bundle.candidatePilots.activateDeployment({
    deploymentId: "deployment-1",
    expectedPhase: "PENDING_FLAT",
    expectedUpdatedAt: "2026-08-20T23:00:00Z",
    activationAt,
    activationEpochNs,
  });
  const decision: StrategyDecisionRecord = {
    id: "decision-1",
    exchangeAccountId: "primary",
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "ENTER",
    status: options.decisionStatus ?? "READY",
    decisionBasisJson: "{}",
    intendedNotionalKrw: "10000",
    intendedQuantity: null,
    referencePrice: "100000000",
    createdAt: "2026-08-20T23:59:59.500Z",
  };
  if (options.saveDecision !== false) {
    await bundle.repositories.saveStrategyDecision(decision);
  }
  const binding = rehash({
    id: "binding-1",
    deploymentId: "deployment-1",
    strategyDecisionId: decision.id,
    orderId: "order-1",
    exchangeAccountId: "primary",
    activationAt,
    activationEpochNs,
    market: "KRW-BTC",
    strategyKey: "position_guard.paper_core.v1",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    executionMode: "LIVE",
    ordType: "price",
    action: "ENTER",
    side: "bid",
    intendedQuantity: null,
    intendedNotionalKrw: "10000",
    boundPrice: "10000",
    boundVolume: null,
    boundTimeInForce: null,
    boundSmpType: null,
    materialVersion: "BINDING_V2",
    orderMaterialHash: "",
    createdAt: "2026-08-21T00:00:00Z",
  });
  const order: OrderRecord = {
    id: "order-1",
    strategyDecisionId: decision.id,
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "10000",
    timeInForce: null,
    smpType: null,
    identifier: "candidate-order-1",
    idempotencyKey: "candidate-idempotency-1",
    origin: "STRATEGY",
    requestedAt: "2026-08-21T00:00:00.000000001Z",
    upbitUuid: null,
    status: "PERSISTED",
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-08-21T00:00:00.000000001Z",
    updatedAt: "2026-08-21T00:00:00.000000001Z",
  };
  const event: OrderEventRecord = {
    id: "event-1",
    orderId: order.id,
    eventType: "ORDER_PERSISTED",
    eventSource: "LOCAL",
    payloadJson: JSON.stringify({ decisionAction: "ENTER" }),
    createdAt: order.requestedAt,
  };
  const request: PersistCandidateBoundOrderIntentRequest = {
    order,
    event,
    binding,
    expectedPhase: "ACTIVE",
    expectedDeploymentUpdatedAt: activationAt,
    expectedStateVersion: 0,
  };
  return { bundle, databasePath, decision, request };
}

type SqliteFixture = Awaited<ReturnType<typeof createFixture>>;

function openBundle(databasePath: string): ReturnType<typeof createSqlitePersistence> {
  return createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "operator",
    userTelegramId: "telegram-user",
    userDisplayName: "Operator",
    accessKeyRef: "ENV:UPBIT_ACCESS_KEY",
    secretKeyRef: "ENV:UPBIT_SECRET_KEY",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    killSwitchActive: false,
  });
}

async function persist(fixture: SqliteFixture, request = fixture.request): Promise<void> {
  await fixture.bundle.repositories.persistCandidateBoundOrderIntent(request);
}

function cloneRequest(input: PersistCandidateBoundOrderIntentRequest): PersistCandidateBoundOrderIntentRequest {
  return {
    order: { ...input.order },
    event: { ...input.event },
    binding: { ...input.binding },
    expectedPhase: input.expectedPhase,
    expectedDeploymentUpdatedAt: input.expectedDeploymentUpdatedAt,
    expectedStateVersion: input.expectedStateVersion,
  };
}

function otherOrder(order: OrderRecord, id: string): OrderRecord {
  return {
    ...order,
    id,
    strategyDecisionId: null,
    identifier: `${id}-identifier`,
    idempotencyKey: `${id}-idempotency`,
  };
}

function otherDecisionRecord(decision: StrategyDecisionRecord, id: string): StrategyDecisionRecord {
  return { ...decision, id };
}

function mutateAuthority(databasePath: string, variant: string): void {
  if (variant === "missing-decision" || variant === "wrong-decision") return;
  withRawDatabase(databasePath, (db) => {
    if (variant === "phase") db.prepare("UPDATE strategy_pilot_deployments SET phase = 'DRAINING' WHERE id = ?").run("deployment-1");
    if (variant === "updated-at") db.prepare("UPDATE strategy_pilot_deployments SET updated_at = ? WHERE id = ?")
      .run("2026-08-21T00:00:00Z", "deployment-1");
    if (variant === "activation") db.prepare("UPDATE strategy_pilot_deployments SET activation_at = ?, activation_epoch_ns = ? WHERE id = ?")
      .run("2026-08-20T23:59:58Z", "1787270398000000000", "deployment-1");
    if (variant === "missing-state") db.prepare("DELETE FROM strategy_candidate_states WHERE deployment_id = ?").run("deployment-1");
    if (variant === "state-version") db.prepare("UPDATE strategy_candidate_states SET state_version = 1 WHERE deployment_id = ?").run("deployment-1");
    if (variant === "account") {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare("UPDATE strategy_pilot_deployments SET exchange_account_id = 'other' WHERE id = ?").run("deployment-1");
    }
    if (variant === "policy" || variant === "version") {
      db.exec("PRAGMA ignore_check_constraints = ON");
      const column = variant === "policy" ? "policy_id" : "policy_version";
      db.prepare(`UPDATE strategy_pilot_deployments SET ${column} = 'WRONG' WHERE id = ?`).run("deployment-1");
    }
  });
}

function insertEventRaw(databasePath: string, event: OrderEventRecord, enforceForeignKeys: boolean): void {
  withRawDatabase(databasePath, (db) => {
    db.exec(`PRAGMA foreign_keys = ${enforceForeignKeys ? "ON" : "OFF"}`);
    db.prepare(`INSERT INTO order_events (id, order_id, event_type, event_source, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      event.id, event.orderId, event.eventType, event.eventSource, event.payloadJson, event.createdAt,
    );
  });
}

function insertBindingRaw(
  databasePath: string,
  binding: CandidateExecutionBindingRecord,
  enforceForeignKeys: boolean,
): void {
  withRawDatabase(databasePath, (db) => {
    db.exec(`PRAGMA foreign_keys = ${enforceForeignKeys ? "ON" : "OFF"}`);
    db.prepare(`INSERT INTO strategy_candidate_execution_bindings (
      id, deployment_id, strategy_decision_id, order_id, exchange_account_id,
      activation_at, activation_epoch_ns, market, strategy_key, policy_id, policy_version,
      execution_mode, ord_type, action, side, intended_quantity_exact, intended_notional_krw_exact,
      bound_price_exact, bound_volume_exact, bound_time_in_force, bound_smp_type,
      material_version, order_material_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      binding.id, binding.deploymentId, binding.strategyDecisionId, binding.orderId,
      binding.exchangeAccountId, binding.activationAt, binding.activationEpochNs,
      binding.market, binding.strategyKey, binding.policyId, binding.policyVersion,
      binding.executionMode, binding.ordType, binding.action, binding.side,
      binding.intendedQuantity, binding.intendedNotionalKrw, binding.boundPrice,
      binding.boundVolume, binding.boundTimeInForce, binding.boundSmpType,
      binding.materialVersion, binding.orderMaterialHash, binding.createdAt,
    );
  });
}

function installAbortTrigger(databasePath: string, target: "event" | "binding"): void {
  withRawDatabase(databasePath, (db) => {
    const table = target === "event" ? "order_events" : "strategy_candidate_execution_bindings";
    db.exec(`CREATE TRIGGER force_candidate_bound_${target}_abort BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT, 'forced candidate-bound ${target} failure'); END;`);
  });
}

async function targetCounts(databasePath: string): Promise<{ orders: number; events: number; bindings: number }> {
  return withRawDatabase(databasePath, (db) => ({
    orders: Number((db.prepare("SELECT COUNT(*) AS count FROM orders").get() as { count: number }).count),
    events: Number((db.prepare("SELECT COUNT(*) AS count FROM order_events").get() as { count: number }).count),
    bindings: Number((db.prepare("SELECT COUNT(*) AS count FROM strategy_candidate_execution_bindings").get() as { count: number }).count),
  }));
}

async function snapshotTargetRows(databasePath: string): Promise<string> {
  return withRawDatabase(databasePath, (db) => {
    const snapshot = ["orders", "order_events", "strategy_candidate_execution_bindings"].map((table) => {
      const statement = db.prepare(`SELECT * FROM ${table} ORDER BY rowid ASC`);
      statement.setReadBigInts(true);
      return [table, statement.all()];
    });
    return JSON.stringify(snapshot, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  });
}

function withRawDatabase<T>(databasePath: string, operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return operation(db);
  } finally {
    db.close();
  }
}

function rehash(
  binding: Omit<CandidateExecutionBindingRecord, "orderMaterialHash"> & { orderMaterialHash?: string },
): CandidateExecutionBindingRecord {
  const material = { ...binding, orderMaterialHash: "" } as CandidateExecutionBindingRecord;
  return { ...material, orderMaterialHash: candidateExecutionBindingMaterialHash(material) };
}

async function createTempDatabasePath(label: string): Promise<string> {
  const directory = path.resolve("var", "test-candidate-bound-sqlite");
  await mkdir(directory, { recursive: true });
  const databasePath = path.join(directory, `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
  await cleanupDatabase(databasePath);
  return databasePath;
}

async function cleanupDatabase(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
}
