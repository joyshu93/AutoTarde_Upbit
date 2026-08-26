import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RuntimeOwnershipAuthority } from "../src/app/runtime-ownership-guard.js";
import type { CandidateExecutionBindingRecord } from "../src/domain/pilot-types.js";
import type {
  ExecutionStateRecord,
  OrderEventRecord,
  OrderRecord,
  StrategyDecisionRecord,
} from "../src/domain/types.js";
import type { CandidatePilotRepository } from "../src/modules/db/pilot-interfaces.js";
import { InMemoryAccountExecutionLeaseStore } from
  "../src/modules/db/repositories/in-memory-account-execution-lease-store.js";
import { InMemoryCandidatePilotRepository } from
  "../src/modules/db/repositories/in-memory-candidate-pilot-repository.js";
import {
  InMemoryExecutionRepository,
  InMemoryOperatorStateStore,
} from "../src/modules/db/repositories/in-memory-repositories.js";
import {
  DryRunExchangeAdapter,
  type UpbitOrderRequest,
} from "../src/modules/exchange/interfaces.js";
import {
  CandidateExecutionSafetyError,
  ExecutionService,
} from "../src/modules/execution/execution-service.js";
import type {
  CandidateExecutionAuthority,
  SubmitOrderFromDecisionInput,
} from "../src/modules/execution/interfaces.js";
import { createEmptyPositionGuardCandidateState } from
  "../src/modules/strategy/position-guard-candidate-state.js";
import { test } from "./harness.js";

const ATTEMPT_AT = "2026-08-21T00:00:00.000Z";
const ACTIVATION_AT = "2026-08-20T23:59:59.000Z";
const DEPLOYMENT_UPDATED_AT = "2026-08-20T23:59:59.000Z";

type FinalMutation =
  | "NONE"
  | "ORDER_STATUS"
  | "ORDER_IMMUTABLE"
  | "ORDER_EXCHANGE_EVIDENCE"
  | "FIRST_EVENT"
  | "DECISION"
  | "DEPLOYMENT"
  | "EXACT_STATE"
  | "BINDING"
  | "COMPETING_ORDER"
  | "FAILED_COMPETING_ORDER"
  | "REJECTED_COMPETING_ORDER"
  | "ORDER_ID_REFERENCE_COLLISION"
  | "ORDER_CANCELED_DURING_OPERATOR_STATE"
  | "HELPER_RESOLUTION_PAUSE"
  | "OPERATOR_STATE";

test("bound candidate success rereads every final authority in strict order and sends exactly once", async () => {
  const fixture = await createFixture("NONE");

  const result = await fixture.service.submitOrderFromDecision(candidateInput());

  assert.equal(result.accepted, true);
  assert.equal(fixture.adapter.createOrderCalls, 1);
  assert.deepEqual(fixture.trace, [
    "firstEvent",
    "decision",
    "deployment",
    "exactState",
    "binding",
    "operatorState",
    "activeOrders",
    "order",
    "combinedAuthority",
    "operatorState",
    "createOrder",
  ]);
});

for (const scenario of [
  "ORDER_STATUS",
  "ORDER_IMMUTABLE",
  "ORDER_EXCHANGE_EVIDENCE",
] as const) {
  test(`candidate final ${scenario.toLowerCase()} mismatch fault-pauses and sends zero`, async () => {
    await assertFinalCandidateFault(scenario);
  });
}

for (const scenario of [
  "FIRST_EVENT",
  "DECISION",
  "DEPLOYMENT",
  "EXACT_STATE",
  "BINDING",
] as const) {
  test(`candidate final ${scenario.toLowerCase()} authority mismatch fault-pauses and sends zero`, async () => {
    await assertFinalCandidateFault(scenario);
  });
}

test("a competing account active order at candidate final revalidation fault-pauses and sends zero", async () => {
  await assertFinalCandidateFault("COMPETING_ORDER");
});

for (const scenario of ["FAILED_COMPETING_ORDER", "REJECTED_COMPETING_ORDER"] as const) {
  test(`a potentially dispatched ${scenario.split("_")[0]} competitor fault-pauses and sends zero`, async () => {
    await assertFinalCandidateFault(scenario);
  });
}

test("candidate final order reread uses exact account and order id despite reference collisions", async () => {
  const fixture = await createFixture("ORDER_ID_REFERENCE_COLLISION");

  const result = await fixture.service.submitOrderFromDecision(candidateInput());

  assert.equal(result.accepted, true);
  assert.equal(fixture.adapter.createOrderCalls, 1);
  assert.equal(fixture.repositories.referenceLookupCalls, 0);
});

test("a persisted pause settling during the final combined authority await sends zero", async () => {
  const fixture = await createFixture("HELPER_RESOLUTION_PAUSE");

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput()),
    /final pre-send authority is blocked/u,
  );

  assert.equal(fixture.adapter.createOrderCalls, 0);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  const orderRead = fixture.trace.indexOf("order");
  const combinedRead = fixture.trace.indexOf("combinedAuthority");
  const pauseStarted = fixture.trace.indexOf("finalOrderMicrotaskPause");
  assert.ok(orderRead >= 0 && combinedRead > orderRead && pauseStarted > combinedRead);
  assert.equal(fixture.trace.includes("createOrder"), false);
});

test("a final operator-state race occurs after all candidate reads and sends zero", async () => {
  const fixture = await createFixture("OPERATOR_STATE");

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput()),
    CandidateExecutionSafetyError,
  );

  assert.equal(fixture.adapter.createOrderCalls, 0);
  assert.deepEqual(fixture.trace.slice(0, 6), [
    "firstEvent",
    "decision",
    "deployment",
    "exactState",
    "binding",
    "operatorState",
  ]);
  await assertCandidateFaultState(fixture);
});

test("an own-order cancellation during the final operator-state await sends zero", async () => {
  const fixture = await createFixture("ORDER_CANCELED_DURING_OPERATOR_STATE");

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput()),
    CandidateExecutionSafetyError,
  );

  assert.equal(fixture.adapter.createOrderCalls, 0);
  assert.equal((await fixture.repositories.listOrders("primary"))[0]?.status, "CANCELED");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  assert.notEqual(await fixture.leases.getLease("primary"), null);
});

test("candidate final authority keeps the exact account/order revalidation immediately before the sole send", async () => {
  const source = await readFile(
    path.resolve(process.cwd(), "src/modules/execution/execution-service.ts"),
    "utf8",
  );
  assert.equal((source.match(/\.createOrder\s*\(/gu) ?? []).length, 1);

  const submitMethodStart = source.indexOf("async submitOrderFromDecision");
  const submitMethodEnd = source.indexOf("private async prepareCandidateContext", submitMethodStart);
  const submitMethod = source.slice(submitMethodStart, submitMethodEnd);
  const candidateMethodStart = source.indexOf("private async assertFinalCandidatePreSendAuthority");
  const candidateMethodEnd = source.indexOf(
    "private async assertFinalPersistedSubmissionAuthority",
    candidateMethodStart,
  );
  const candidateMethod = source.slice(candidateMethodStart, candidateMethodEnd);
  const persistedMethodStart = candidateMethodEnd;
  const persistedMethodEnd = source.indexOf("private async recordLeaseBlockedAndPause", persistedMethodStart);
  const persistedMethod = source.slice(persistedMethodStart, persistedMethodEnd);
  const candidateReads = [
    "listOrderEvents",
    "getStrategyDecisionById",
    "getDeployment",
    "getExactState",
    "getExecutionBindingForOrder",
  ];
  let cursor = -1;
  for (const marker of candidateReads) {
    const next = candidateMethod.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `expected ordered final candidate read ${marker}`);
    cursor = next;
  }

  assert.doesNotMatch(candidateMethod, /listSubmissionBlockingOrders|findOrderById/u);
  assert.doesNotMatch(
    persistedMethod,
    /\bawait\b|operatorState\.getState|candidatePilots|listSubmissionBlockingOrders|findOrderById/u,
  );

  const candidateHelperCall = submitMethod.indexOf("await this.assertFinalCandidatePreSendAuthority");
  const finalStateRead = submitMethod.indexOf(
    "await this.dependencies.operatorState.getState()",
    candidateHelperCall,
  );
  const blockerRead = submitMethod.indexOf(
    "await this.dependencies.repositories.listSubmissionBlockingOrders",
    finalStateRead,
  );
  const exactOrderRead = submitMethod.indexOf(
    "await this.dependencies.repositories.findOrderById",
    blockerRead,
  );
  const persistedHelperCall = submitMethod.indexOf(
    "this.assertFinalPersistedSubmissionAuthority",
    exactOrderRead,
  );
  const combinedAuthorityCheck = submitMethod.indexOf(
    "await this.runtimeOwnership.assertCurrentExecutionAuthority",
    persistedHelperCall,
  );
  const sendSite = submitMethod.indexOf(
    "this.dependencies.executionAdapter.createOrder",
    combinedAuthorityCheck,
  );
  assert.ok(
    candidateHelperCall >= 0 && finalStateRead > candidateHelperCall &&
    blockerRead > finalStateRead && exactOrderRead > blockerRead &&
    persistedHelperCall > exactOrderRead &&
    combinedAuthorityCheck > persistedHelperCall && sendSite > combinedAuthorityCheck,
  );
  const afterFinalPersistedRead = submitMethod.slice(persistedHelperCall, sendSite);
  assert.equal((afterFinalPersistedRead.match(/\bawait\b/gu) ?? []).length, 1);
  assert.doesNotMatch(afterFinalPersistedRead, /operatorState\.getState|candidatePilots/u);
  assert.doesNotMatch(
    submitMethod.slice(combinedAuthorityCheck + "await".length, sendSite),
    /\bawait\b/u,
  );
});

async function assertFinalCandidateFault(mutation: FinalMutation): Promise<void> {
  const fixture = await createFixture(mutation);

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput()),
    CandidateExecutionSafetyError,
  );

  assert.equal(fixture.adapter.createOrderCalls, 0);
  await assertCandidateFaultState(fixture);
}

async function assertCandidateFaultState(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<void> {
  const orders = await fixture.repositories.listOrders("primary");
  assert.equal(orders.length, 1);
  assert.equal(orders[0]?.status, "SUBMITTING");
  assert.notEqual(await fixture.leases.getLease("primary"), null);
  assert.equal((await fixture.candidatePilots.getDeployment("deployment-1"))?.phase, "PAUSED_FAULT");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  const audit = (await fixture.candidatePilots.listAuditEvents("deployment-1")).at(-1);
  assert.equal(audit?.eventType, "FAULT_PAUSED");
  const payload = JSON.parse(audit?.payloadJson ?? "null") as {
    reasonCode: string;
    provenanceJson: string;
  };
  assert.equal(payload.reasonCode, "IDENTITY_MISMATCH");
  assert.equal(
    (JSON.parse(payload.provenanceJson) as { stage: string }).stage,
    "FINAL_REVALIDATION",
  );
}

class FinalAuthorityRepository extends InMemoryExecutionRepository {
  finalReadsArmed = false;
  referenceLookupCalls = 0;
  cancellationMutations = 0;
  private submittingOrder: OrderRecord | null = null;

  constructor(
    candidatePilots: InMemoryCandidatePilotRepository,
    private readonly mutation: FinalMutation,
    readonly trace: string[],
    private readonly onFinalOrderResolved: () => void,
  ) {
    super(undefined, candidatePilots);
  }

  override async updateOrder(record: OrderRecord): Promise<void> {
    await super.updateOrder(record);
    if (record.status === "SUBMITTING") {
      this.finalReadsArmed = true;
      this.submittingOrder = record;
    }
  }

  async cancelSubmittingOrderDuringOperatorState(): Promise<void> {
    const order = (await super.listOrders("primary")).find(
      (candidate) => candidate.status === "SUBMITTING",
    );
    if (!order) {
      if (this.cancellationMutations > 0) return;
      throw new Error("expected submitting order for race fixture");
    }
    await super.updateOrder({
      ...order,
      status: "CANCELED",
      updatedAt: "2026-08-21T00:00:00.001Z",
    });
    this.cancellationMutations += 1;
  }

  override async listActiveOrders(
    exchangeAccountId: string,
    market?: OrderRecord["market"],
    limit?: number,
  ): Promise<OrderRecord[]> {
    const orders = await super.listActiveOrders(exchangeAccountId, market, limit);
    if (!this.finalReadsArmed) return orders;
    this.trace.push("activeOrders");
    return this.mutation === "COMPETING_ORDER" ? [...orders, competingOrder()] : orders;
  }

  override async listSubmissionBlockingOrders(
    exchangeAccountId: string,
    limit: number,
  ): Promise<OrderRecord[]> {
    const orders = await super.listSubmissionBlockingOrders(exchangeAccountId, limit);
    if (!this.finalReadsArmed) return orders;
    this.trace.push("activeOrders");
    if (this.mutation === "COMPETING_ORDER") return [...orders, competingOrder()];
    if (this.mutation === "FAILED_COMPETING_ORDER") {
      return [...orders, { ...competingOrder(), status: "FAILED" }];
    }
    if (this.mutation === "REJECTED_COMPETING_ORDER") {
      return [...orders, { ...competingOrder(), status: "REJECTED" }];
    }
    return orders;
  }

  findOrderById(exchangeAccountId: string, orderId: string): Promise<OrderRecord | null> {
    if (
      this.finalReadsArmed &&
      this.mutation === "HELPER_RESOLUTION_PAUSE" &&
      this.submittingOrder?.id === orderId &&
      this.submittingOrder.exchangeAccountId === exchangeAccountId
    ) {
      const order = this.submittingOrder;
      this.trace.push("order");
      return {
        then: (resolve: (value: OrderRecord) => unknown) => {
          resolve(order);
          queueMicrotask(() => {
            this.onFinalOrderResolved();
            this.trace.push("finalOrderMicrotaskPause");
          });
        },
      } as unknown as Promise<OrderRecord>;
    }
    return super.findOrderById(exchangeAccountId, orderId).then((order) => {
      if (!this.finalReadsArmed) return order;
    this.trace.push("order");
    if (!order) return null;
    if (this.mutation === "ORDER_STATUS") return { ...order, status: "OPEN" };
    if (this.mutation === "ORDER_IMMUTABLE") return { ...order, price: "6001" };
    if (this.mutation === "ORDER_EXCHANGE_EVIDENCE") {
      return { ...order, upbitUuid: "unexpected-upbit-uuid" };
    }
    return order;
    });
  }

  override async findOrderByReference(
    exchangeAccountId: string,
    reference: string,
  ): Promise<OrderRecord | null> {
    this.referenceLookupCalls += 1;
    const order = await super.findOrderByReference(exchangeAccountId, reference);
    if (!this.finalReadsArmed) return order;
    this.trace.push("order");
    if (!order) return null;
    if (this.mutation === "ORDER_ID_REFERENCE_COLLISION") {
      return { ...competingOrder(), identifier: reference };
    }
    if (this.mutation === "ORDER_STATUS") return { ...order, status: "OPEN" };
    if (this.mutation === "ORDER_IMMUTABLE") return { ...order, price: "6001" };
    if (this.mutation === "ORDER_EXCHANGE_EVIDENCE") {
      return { ...order, upbitUuid: "unexpected-upbit-uuid" };
    }
    return order;
  }

  override async listOrderEvents(orderId: string): Promise<OrderEventRecord[]> {
    const events = await super.listOrderEvents(orderId);
    if (!this.finalReadsArmed) return events;
    this.trace.push("firstEvent");
    return this.mutation === "FIRST_EVENT" && events[0]
      ? [{ ...events[0], eventType: "ORDER_SUBMITTING" }, ...events.slice(1)]
      : events;
  }

  override async getStrategyDecisionById(id: string): Promise<StrategyDecisionRecord | null> {
    const decision = await super.getStrategyDecisionById(id);
    if (!this.finalReadsArmed) return decision;
    this.trace.push("decision");
    return this.mutation === "DECISION" && decision
      ? { ...decision, status: "PENDING_CONFIRMATION" }
      : decision;
  }
}

class TracingOperatorStateStore extends InMemoryOperatorStateStore {
  visibleSystemStatus: ExecutionStateRecord["systemStatus"] = "RUNNING";

  constructor(
    initialState: ExecutionStateRecord,
    private readonly finalReadsArmed: () => boolean,
    private readonly mutation: FinalMutation,
    private readonly trace: string[],
    private readonly cancelSubmittingOrder: () => Promise<void>,
  ) {
    super(initialState);
  }

  override getState(): Promise<ExecutionStateRecord> {
    if (!this.finalReadsArmed()) return super.getState();
    this.trace.push("operatorState");
    if (this.mutation === "ORDER_CANCELED_DURING_OPERATOR_STATE") {
      return super.getState().then(async (state) => {
        await this.cancelSubmittingOrder();
        return state;
      });
    }
    return super.getState().then((state) => this.mutation === "OPERATOR_STATE"
      ? { ...state, systemStatus: "PAUSED", pauseReason: "final race" }
      : state);
  }
}

class TracingDryRunAdapter extends DryRunExchangeAdapter {
  createOrderCalls = 0;
  systemStatusAtSend: ExecutionStateRecord["systemStatus"] | null = null;

  constructor(
    private readonly trace: string[],
    private readonly finalReadsArmed: () => boolean,
    private readonly systemStatus: () => ExecutionStateRecord["systemStatus"],
  ) {
    super();
  }

  override async createOrder(request: UpbitOrderRequest) {
    this.createOrderCalls += 1;
    this.systemStatusAtSend = this.systemStatus();
    if (this.finalReadsArmed()) this.trace.push("createOrder");
    return super.createOrder(request);
  }
}

async function createFixture(mutation: FinalMutation) {
  const trace: string[] = [];
  let repositories: FinalAuthorityRepository;
  let finalPausePromise: Promise<void> = Promise.resolve();
  const operatorState = new TracingOperatorStateStore(
    executionState(),
    () => repositories?.finalReadsArmed ?? false,
    mutation,
    trace,
    () => repositories.cancelSubmittingOrderDuringOperatorState(),
  );
  const candidatePilots = new InMemoryCandidatePilotRepository(operatorState);
  repositories = new FinalAuthorityRepository(candidatePilots, mutation, trace, () => {
    finalPausePromise = operatorState.pause("final combined authority race").then(() => {
      operatorState.visibleSystemStatus = "PAUSED";
    });
  });
  const leases = new InMemoryAccountExecutionLeaseStore();
  const adapter = new TracingDryRunAdapter(
    trace,
    () => repositories.finalReadsArmed,
    () => operatorState.visibleSystemStatus,
  );
  await seedCandidate(candidatePilots, repositories);

  const service = new ExecutionService({
    riskLimits: {
      maxAllocationByAsset: { BTC: 0.6, ETH: 0.6 },
      totalExposureCap: 0.75,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    executionAdapter: adapter,
    repositories,
    accountExecutionLeases: leases,
    accountExecutionLeaseMs: 30_000,
    operatorState,
    runtimeOwnership: createAlwaysOwnedRuntimeAuthority({
      operatorState,
      trace,
      waitForFinalPause: () => finalPausePromise,
    }),
    candidatePilots: finalCandidatePilotReads(candidatePilots, repositories, mutation, trace),
    now: () => ATTEMPT_AT,
  });

  return { adapter, candidatePilots, leases, operatorState, repositories, service, trace };
}

function createAlwaysOwnedRuntimeAuthority(input: {
  readonly operatorState: TracingOperatorStateStore;
  readonly trace: string[];
  waitForFinalPause(): Promise<void>;
}): RuntimeOwnershipAuthority {
  const record = {
    ownerToken: "owner".padEnd(64, "a"),
    generation: 1,
    executionMode: "DRY_RUN" as const,
    acquiredAtEpochMs: 1,
    heartbeatAtEpochMs: 1,
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  };
  const authority = {
    snapshot: () => ({
      status: "OWNED" as const,
      generation: record.generation,
      executionMode: record.executionMode,
      acquiredAtEpochMs: record.acquiredAtEpochMs,
      heartbeatAtEpochMs: record.heartbeatAtEpochMs,
      expiresAtEpochMs: record.expiresAtEpochMs,
      takeover: false,
      lossReason: null,
    }),
    assertLocallyHeld() {},
    async assertCurrent() {
      return { ...record };
    },
    async assertCurrentExecutionAuthority() {
      input.trace.push("combinedAuthority");
      await Promise.resolve();
      await input.waitForFinalPause();
      const executionState = await input.operatorState.getState();
      if (executionState.systemStatus !== "RUNNING" || executionState.killSwitchActive) {
        throw new Error("final pre-send authority is blocked");
      }
      return { runtimeOwnership: { ...record }, executionState };
    },
  };
  return authority;
}

function finalCandidatePilotReads(
  candidatePilots: CandidatePilotRepository,
  repositories: FinalAuthorityRepository,
  mutation: FinalMutation,
  trace: string[],
) {
  return {
    async getDeployment(deploymentId: string) {
      const deployment = await candidatePilots.getDeployment(deploymentId);
      if (!repositories.finalReadsArmed) return deployment;
      trace.push("deployment");
      return mutation === "DEPLOYMENT" && deployment
        ? { ...deployment, updatedAt: "2026-08-21T00:00:00.500Z" }
        : deployment;
    },
    async getExactState(deploymentId: string) {
      const state = await candidatePilots.getExactState(deploymentId);
      if (!repositories.finalReadsArmed) return state;
      trace.push("exactState");
      return mutation === "EXACT_STATE" && state
        ? { ...state, stateVersion: state.stateVersion + 1 }
        : state;
    },
    async getExecutionBindingForOrder(orderId: string) {
      const binding = await candidatePilots.getExecutionBindingForOrder(orderId);
      if (!repositories.finalReadsArmed) return binding;
      trace.push("binding");
      return mutation === "BINDING" && binding
        ? { ...binding, boundPrice: "6001" } as CandidateExecutionBindingRecord
        : binding;
    },
    pauseForCandidateIntentFault:
      candidatePilots.pauseForCandidateIntentFault.bind(candidatePilots),
  };
}

async function seedCandidate(
  candidatePilots: InMemoryCandidatePilotRepository,
  repositories: InMemoryExecutionRepository,
): Promise<void> {
  await candidatePilots.createDeploymentWithInitialState({
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
      createdAt: "2026-08-20T23:00:00.000Z",
      updatedAt: "2026-08-20T23:00:00.000Z",
    },
    initialState: createEmptyPositionGuardCandidateState(),
  });
  await candidatePilots.activateDeployment({
    deploymentId: "deployment-1",
    expectedPhase: "PENDING_FLAT",
    expectedUpdatedAt: "2026-08-20T23:00:00.000Z",
    activationAt: ACTIVATION_AT,
    activationEpochNs: BigInt(Date.parse(ACTIVATION_AT)) * 1_000_000n,
  });
  await repositories.saveStrategyDecision(persistedDecision());
  await repositories.saveBalanceSnapshot({
    id: "balance-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-08-20T23:59:59.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "100000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "position-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-08-20T23:59:59.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });
}

function persistedDecision(): StrategyDecisionRecord {
  return {
    id: "decision-1",
    exchangeAccountId: "primary",
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "ENTER",
    status: "READY",
    decisionBasisJson: "{}",
    intendedNotionalKrw: "6000",
    intendedQuantity: null,
    referencePrice: "100000000",
    createdAt: "2026-08-20T23:59:59.500Z",
  };
}

function candidateAuthority(): CandidateExecutionAuthority {
  return {
    kind: "POSITION_GUARD_BTC_CANDIDATE",
    deploymentId: "deployment-1",
    exchangeAccountId: "primary",
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    strategyKey: "position_guard.paper_core.v1",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    activationAt: ACTIVATION_AT,
    activationEpochNs: BigInt(Date.parse(ACTIVATION_AT)) * 1_000_000n,
    expectedPhase: "ACTIVE",
    expectedDeploymentUpdatedAt: DEPLOYMENT_UPDATED_AT,
    expectedStateVersion: 0,
    routeReason: "CANDIDATE_ALLOWED",
  };
}

function candidateInput(): SubmitOrderFromDecisionInput {
  return {
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-1",
    referencePriceCapturedAt: "2026-08-20T23:59:59.900Z",
    decision: {
      strategyKey: "position_guard.paper_core.v1",
      market: "KRW-BTC",
      action: "ENTER",
      reasonCodes: ["candidate-final-authority-test"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 6_000,
      requestedQuantity: null,
      metadata: {},
    },
    side: "bid",
    ordType: "price",
    price: "6000",
    volume: null,
    candidateAuthority: candidateAuthority(),
  };
}

function competingOrder(): OrderRecord {
  return {
    id: "competing-order",
    strategyDecisionId: "competing-decision",
    exchangeAccountId: "primary",
    market: "KRW-ETH",
    side: "bid",
    ordType: "limit",
    volume: "0.001",
    price: "1000000",
    timeInForce: null,
    smpType: null,
    identifier: "competing-identifier",
    idempotencyKey: "competing-idempotency",
    origin: "STRATEGY",
    requestedAt: ATTEMPT_AT,
    upbitUuid: null,
    status: "RECONCILIATION_REQUIRED",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: "RECONCILIATION_REQUIRED",
    failureMessage: "uncertain",
    createdAt: ATTEMPT_AT,
    updatedAt: ATTEMPT_AT,
  };
}

function executionState(): ExecutionStateRecord {
  return {
    id: "state-1",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-20T23:00:00.000Z",
  };
}
