import assert from "node:assert/strict";

import type { CandidateExecutionBindingRecord } from "../src/domain/pilot-types.js";
import type { OrderEventRecord, OrderRecord, StrategyDecisionRecord } from "../src/domain/types.js";
import type { PersistCandidateBoundOrderIntentRequest } from "../src/modules/db/interfaces.js";
import { candidateExecutionBindingMaterialHash } from "../src/modules/db/pilot-interfaces.js";
import { InMemoryCandidatePilotRepository } from
  "../src/modules/db/repositories/in-memory-candidate-pilot-repository.js";
import { InMemoryExecutionRepository } from "../src/modules/db/repositories/in-memory-repositories.js";
import { createEmptyPositionGuardCandidateState } from
  "../src/modules/strategy/position-guard-candidate-state.js";
import { test } from "./harness.js";

test("in-memory candidate-bound intent persists order first event and binding atomically", async () => {
  const fixture = await createFixture();

  await fixture.execution.persistCandidateBoundOrderIntent(fixture.request);

  assert.deepEqual(await fixture.execution.listOrders("primary"), [fixture.request.order]);
  assert.deepEqual(await fixture.execution.listOrderEvents(fixture.request.order.id), [fixture.request.event]);
  assert.deepEqual(
    await fixture.candidate.getExecutionBindingForOrder(fixture.request.order.id),
    fixture.request.binding,
  );
});

test("in-memory candidate-bound intent exact retry is idempotent and rejects extra first-order events", async () => {
  const fixture = await createFixture();
  await fixture.execution.persistCandidateBoundOrderIntent(fixture.request);
  await fixture.execution.persistCandidateBoundOrderIntent(cloneRequest(fixture.request));
  assert.equal((await fixture.execution.listOrders("primary")).length, 1);
  assert.equal((await fixture.execution.listOrderEvents(fixture.request.order.id)).length, 1);

  await fixture.execution.appendOrderEvent({
    id: "unexpected-event",
    orderId: fixture.request.order.id,
    eventType: "ORDER_SUBMITTING",
    eventSource: "LOCAL",
    payloadJson: "{}",
    createdAt: "2026-08-21T00:00:00.000000002Z",
  });
  await assert.rejects(
    () => fixture.execution.persistCandidateBoundOrderIntent(cloneRequest(fixture.request)),
    /exactly.*first event|dangling|conflicting/i,
  );
});

test("in-memory candidate-bound intent rejects duplicate order and global event identities on retry", async () => {
  const duplicateOrder = await createFixture();
  await duplicateOrder.execution.persistCandidateBoundOrderIntent(duplicateOrder.request);
  await duplicateOrder.execution.saveOrder({ ...duplicateOrder.request.order });
  await assert.rejects(
    () => duplicateOrder.execution.persistCandidateBoundOrderIntent(cloneRequest(duplicateOrder.request)),
    /duplicate|conflicting|dangling/i,
  );

  const duplicateEvent = await createFixture();
  await duplicateEvent.execution.persistCandidateBoundOrderIntent(duplicateEvent.request);
  await duplicateEvent.execution.appendOrderEvent({
    ...duplicateEvent.request.event,
    orderId: "other-order",
  });
  await assert.rejects(
    () => duplicateEvent.execution.persistCandidateBoundOrderIntent(cloneRequest(duplicateEvent.request)),
    /duplicate|conflicting|dangling/i,
  );
});

test("in-memory candidate-bound intent requires its injected candidate store", async () => {
  const fixture = await createFixture();
  const execution = new InMemoryExecutionRepository();
  await execution.saveStrategyDecision(fixture.decision);

  await assert.rejects(
    () => execution.persistCandidateBoundOrderIntent(fixture.request),
    /candidate.*store.*required/i,
  );
  assert.equal((await execution.listOrders("primary")).length, 0);
});

test("in-memory candidate-bound intent rejects malformed event material without partial rows", async () => {
  const fixture = await createFixture();
  const malformed = cloneRequest(fixture.request);
  malformed.event.eventType = "ORDER_SUBMITTING";

  await assertNoNewTargetRows(fixture, () => fixture.execution.persistCandidateBoundOrderIntent(malformed));

  const forged = cloneRequest(fixture.request);
  forged.binding.orderMaterialHash = "0".repeat(64);
  await assertNoNewTargetRows(fixture, () => fixture.execution.persistCandidateBoundOrderIntent(forged));
});

test("in-memory candidate-bound intent rereads a READY decision", async () => {
  const missing = await createFixture({ saveDecision: false });
  await assertNoNewTargetRows(missing, () => missing.execution.persistCandidateBoundOrderIntent(missing.request));

  const wrong = await createFixture({ decisionStatus: "DATA_STALE" });
  await assertNoNewTargetRows(wrong, () => wrong.execution.persistCandidateBoundOrderIntent(wrong.request));
});

test("in-memory candidate-bound intent rejects deployment and exact-state CAS mismatches", async () => {
  for (const mutate of [
    (request: PersistCandidateBoundOrderIntentRequest) => { request.expectedPhase = "DRAINING"; },
    (request: PersistCandidateBoundOrderIntentRequest) => {
      request.expectedDeploymentUpdatedAt = "2026-08-20T23:59:59.000000001Z";
    },
    (request: PersistCandidateBoundOrderIntentRequest) => { request.expectedStateVersion = 1; },
  ]) {
    const fixture = await createFixture();
    mutate(fixture.request);
    await assertNoNewTargetRows(fixture, () => fixture.execution.persistCandidateBoundOrderIntent(fixture.request));
  }
});

test("in-memory candidate-bound intent rejects binding conflicts by order and primary id", async () => {
  const byOrder = await createFixture();
  await byOrder.candidate.createExecutionBinding(rehash({
    ...byOrder.request.binding,
    id: "other-binding",
  }));
  await assert.rejects(
    () => byOrder.execution.persistCandidateBoundOrderIntent(byOrder.request),
    /binding.*order|conflicting|dangling/i,
  );
  assert.equal((await byOrder.execution.listOrders("primary")).length, 0);

  const byId = await createFixture();
  const otherBinding = rehash({
    ...byId.request.binding,
    orderId: "other-order",
    strategyDecisionId: "other-decision",
  });
  await byId.candidate.createExecutionBinding(otherBinding);
  await assert.rejects(
    () => byId.execution.persistCandidateBoundOrderIntent(byId.request),
    /binding.*id|conflicting|dangling/i,
  );
  assert.equal((await byId.execution.listOrders("primary")).length, 0);
  assert.deepEqual(await byId.candidate.getExecutionBindingForOrder("other-order"), otherBinding);
});

test("in-memory candidate-bound intent rejects every dangling partial-state permutation", async () => {
  const orderOnly = await createFixture();
  await orderOnly.execution.saveOrder(orderOnly.request.order);
  await assert.rejects(
    () => orderOnly.execution.persistCandidateBoundOrderIntent(orderOnly.request),
    /dangling|partial/i,
  );

  const eventOnly = await createFixture();
  await eventOnly.execution.appendOrderEvent(eventOnly.request.event);
  await assert.rejects(
    () => eventOnly.execution.persistCandidateBoundOrderIntent(eventOnly.request),
    /dangling|partial/i,
  );

  const orderEventOnly = await createFixture();
  await orderEventOnly.execution.persistOrderIntent({
    order: orderEventOnly.request.order,
    event: orderEventOnly.request.event,
  });
  await assert.rejects(
    () => orderEventOnly.execution.persistCandidateBoundOrderIntent(orderEventOnly.request),
    /dangling|partial/i,
  );

  const bindingOnly = await createFixture();
  await bindingOnly.candidate.createExecutionBinding(bindingOnly.request.binding);
  await assert.rejects(
    () => bindingOnly.execution.persistCandidateBoundOrderIntent(bindingOnly.request),
    /dangling|partial/i,
  );
});

test("in-memory candidate-bound intent preserves identifier and account-idempotency uniqueness", async () => {
  for (const field of ["identifier", "idempotencyKey"] as const) {
    const fixture = await createFixture();
    await fixture.execution.saveOrder({
      ...fixture.request.order,
      id: `existing-${field}`,
      strategyDecisionId: null,
      [field]: fixture.request.order[field],
    });
    await assert.rejects(
      () => fixture.execution.persistCandidateBoundOrderIntent(fixture.request),
      /identifier|idempotency/i,
    );
    assert.equal((await fixture.execution.listOrders("primary")).length, 1);
    assert.equal(await fixture.candidate.getExecutionBindingForOrder(fixture.request.order.id), null);
  }
});

test("in-memory candidate commit capability is single-use and rejects changed authority", async () => {
  const singleUse = await createFixture();
  const prepared = singleUse.candidate.prepareCandidateBoundOrderIntent(singleUse.request.binding);
  prepared.commitBinding();
  assert.throws(() => prepared.commitBinding(), /already.*used|single-use/i);

  const changed = await createFixture();
  const stale = changed.candidate.prepareCandidateBoundOrderIntent(changed.request.binding);
  await changed.candidate.advanceStateWithEvidence({
    deploymentId: changed.request.binding.deploymentId,
    expectedStateVersion: 0,
    evidence: {
      evidenceId: "changed-state",
      executedAt: "2026-08-21T00:00:01Z",
      action: "ENTER",
      entryPath: "RECLAIM",
      terminalStatus: "FILLED",
      executedQuantity: "0.0001",
      grossQuoteValueKrw: "10000",
      confirmedFeeKrw: "5",
      remainingQuantity: "0.0001",
    },
  });
  assert.throws(() => stale.commitBinding(), /authority.*changed|state.*changed/i);
  assert.equal(await changed.candidate.getExecutionBindingForOrder(changed.request.order.id), null);
});

test("in-memory candidate authority reads use exact account and order id under reference collisions", async () => {
  const repository = new InMemoryExecutionRepository();
  const methods = candidateAuthorityMethods(repository);
  await repository.saveOrder(authorityOrder("reference-owner", "OPEN", {
    identifier: "exact-order-id",
  }));
  await repository.saveOrder(authorityOrder("exact-order-id", "SUBMITTING"));

  assert.equal((await repository.findOrderByReference("primary", "exact-order-id"))?.id, "reference-owner");
  assert.equal((await methods.findOrderById("primary", "exact-order-id"))?.id, "exact-order-id");
  assert.equal(await methods.findOrderById("other-account", "exact-order-id"), null);
});

test("in-memory submission authority query classifies active, unresolved, and definitive terminal rows", async () => {
  const repository = new InMemoryExecutionRepository();
  const methods = candidateAuthorityMethods(repository);
  const activeStatuses: OrderRecord["status"][] = [
    "INTENT_CREATED", "PERSISTED", "SUBMITTING", "OPEN", "PARTIALLY_FILLED",
    "CANCEL_REQUESTED", "RECONCILIATION_REQUIRED",
  ];
  const resolvedStatuses: OrderRecord["status"][] = ["RISK_REJECTED", "FILLED", "CANCELED"];
  for (const [index, status] of [...activeStatuses, ...resolvedStatuses].entries()) {
    await repository.saveOrder(authorityOrder(`order-${status}`, status, {
      updatedAt: `2026-08-21T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
  }
  for (const status of ["FAILED", "REJECTED"] as const) {
    await repository.saveOrder(authorityOrder(`order-unresolved-${status}`, status, {
      failureCode: "SUBMISSION_RESPONSE_UNCERTAIN",
    }));
    await repository.saveOrder(authorityOrder(`order-pre-send-${status}`, status));
  }
  await repository.saveOrder(authorityOrder("order-absence-confirmed", "FAILED", {
    failureCode: "ORDER_SUBMISSION_ABSENCE_CONFIRMED",
  }));
  await repository.appendOrderEvent({
    id: "order-absence-confirmed-event",
    orderId: "order-absence-confirmed",
    eventType: "RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED",
    eventSource: "RECONCILIATION",
    payloadJson: "{}",
    createdAt: "2026-08-21T00:01:00.000Z",
  });
  for (const [index, observedAt] of ["2026-08-21T00:00:30.000Z", "2026-08-21T00:00:31.000Z"].entries()) {
    await repository.saveOrderSubmissionRecoveryObservation({
      id: `order-absence-confirmed-observation-${index}`,
      orderId: "order-absence-confirmed",
      outcome: "NOT_FOUND",
      observedAt,
      observedAtEpochMs: Date.parse(observedAt),
      detailJson: "{}",
      createdAt: observedAt,
    });
  }
  await repository.saveOrder(authorityOrder("order-exchange-rejected", "REJECTED", {
    failureCode: "EXCHANGE_ORDER_REJECTED",
    exchangeResponseJson: "{}",
  }));
  await repository.appendOrderEvent({
    id: "order-exchange-rejected-event",
    orderId: "order-exchange-rejected",
    eventType: "ORDER_REJECTED",
    eventSource: "EXCHANGE",
    payloadJson: "{}",
    createdAt: "2026-08-21T00:01:00.000Z",
  });

  const rows = await methods.listCandidateSubmissionBlockingOrders("primary", 20);
  assert.deepEqual(
    new Set(rows.map((order) => order.id)),
    new Set([
      ...activeStatuses.map((status) => `order-${status}`),
      "order-unresolved-FAILED",
      "order-unresolved-REJECTED",
    ]),
  );
  assert.equal(rows.some((order) => order.id.startsWith("order-pre-send-")), false);
  assert.equal(rows.some((order) => order.id === "order-absence-confirmed"), false);
  assert.equal(rows.some((order) => order.id === "order-exchange-rejected"), false);
  assert.equal((await methods.listCandidateSubmissionBlockingOrders("primary", 2)).length, 2);
  await assert.rejects(() => methods.listCandidateSubmissionBlockingOrders("primary", 0), /limit/i);
});

interface FixtureOptions {
  decisionStatus?: StrategyDecisionRecord["status"];
  saveDecision?: boolean;
}

async function createFixture(options: FixtureOptions = {}) {
  const candidate = new InMemoryCandidatePilotRepository();
  const execution = new InMemoryExecutionRepository(undefined, candidate);
  const activationEpochNs = BigInt(Date.parse("2026-08-20T23:59:59Z")) * 1_000_000n;
  await candidate.createDeploymentWithInitialState({
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
  await candidate.activateDeployment({
    deploymentId: "deployment-1",
    expectedPhase: "PENDING_FLAT",
    expectedUpdatedAt: "2026-08-20T23:00:00Z",
    activationAt: "2026-08-20T23:59:59Z",
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
    await execution.saveStrategyDecision(decision);
  }
  const binding = rehash({
    id: "binding-1",
    deploymentId: "deployment-1",
    strategyDecisionId: "decision-1",
    orderId: "order-1",
    exchangeAccountId: "primary",
    activationAt: "2026-08-20T23:59:59Z",
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
    strategyDecisionId: "decision-1",
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
    expectedDeploymentUpdatedAt: "2026-08-20T23:59:59Z",
    expectedStateVersion: 0,
  };
  return { candidate, decision, execution, request };
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

function rehash(
  binding: Omit<CandidateExecutionBindingRecord, "orderMaterialHash"> & { orderMaterialHash?: string },
): CandidateExecutionBindingRecord {
  const material = { ...binding, orderMaterialHash: "" } as CandidateExecutionBindingRecord;
  return { ...material, orderMaterialHash: candidateExecutionBindingMaterialHash(material) };
}

function candidateAuthorityMethods(repository: InMemoryExecutionRepository) {
  return repository as InMemoryExecutionRepository & {
    findOrderById(exchangeAccountId: string, orderId: string): Promise<OrderRecord | null>;
    listCandidateSubmissionBlockingOrders(exchangeAccountId: string, limit: number): Promise<OrderRecord[]>;
  };
}

function authorityOrder(
  id: string,
  status: OrderRecord["status"],
  overrides: Partial<OrderRecord> = {},
): OrderRecord {
  return {
    id,
    strategyDecisionId: null,
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "10000",
    timeInForce: null,
    smpType: null,
    identifier: `${id}-identifier`,
    idempotencyKey: `${id}-idempotency`,
    origin: "STRATEGY",
    requestedAt: "2026-08-21T00:00:00.000Z",
    upbitUuid: null,
    status,
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

async function assertNoNewTargetRows(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  operation: () => Promise<void>,
): Promise<void> {
  await assert.rejects(operation);
  assert.equal((await fixture.execution.listOrders("primary")).length, 0);
  assert.equal((await fixture.execution.listOrderEvents(fixture.request.order.id)).length, 0);
  assert.equal(await fixture.candidate.getExecutionBindingForOrder(fixture.request.order.id), null);
}
