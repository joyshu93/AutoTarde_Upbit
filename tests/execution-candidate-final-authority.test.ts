import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

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
  | "OPERATOR_STATE";

test("bound candidate success rereads every final authority in strict order and sends exactly once", async () => {
  const fixture = await createFixture("NONE");

  const result = await fixture.service.submitOrderFromDecision(candidateInput());

  assert.equal(result.accepted, true);
  assert.equal(fixture.adapter.createOrderCalls, 1);
  assert.deepEqual(fixture.trace, [
    "activeOrders",
    "order",
    "firstEvent",
    "decision",
    "deployment",
    "exactState",
    "binding",
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

test("a final operator-state race occurs after all candidate reads and sends zero", async () => {
  const fixture = await createFixture("OPERATOR_STATE");

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput()),
    CandidateExecutionSafetyError,
  );

  assert.equal(fixture.adapter.createOrderCalls, 0);
  assert.deepEqual(fixture.trace.slice(0, 8), [
    "activeOrders",
    "order",
    "firstEvent",
    "decision",
    "deployment",
    "exactState",
    "binding",
    "operatorState",
  ]);
  await assertCandidateFaultState(fixture);
});

test("candidate final authority keeps the sole send immediately behind the final state await", async () => {
  const source = await readFile(
    path.resolve(process.cwd(), "src/modules/execution/execution-service.ts"),
    "utf8",
  );
  assert.equal((source.match(/\.createOrder\s*\(/gu) ?? []).length, 1);

  const finalMethodStart = source.indexOf("private async assertFinalPreSendAuthority");
  const finalMethodEnd = source.indexOf("private async recordLeaseBlockedAndPause", finalMethodStart);
  const finalMethod = source.slice(finalMethodStart, finalMethodEnd);
  const orderedReads = [
    "listActiveOrders",
    "findOrderByReference",
    "listOrderEvents",
    "getStrategyDecisionById",
    "getDeployment",
    "getExactState",
    "getExecutionBindingForOrder",
    "operatorState.getState",
  ];
  let cursor = -1;
  for (const marker of orderedReads) {
    const next = finalMethod.indexOf(marker, cursor + 1);
    assert.ok(next > cursor, `expected ordered final read ${marker}`);
    cursor = next;
  }

  const finalStateRead = finalMethod.indexOf("await this.dependencies.operatorState.getState()");
  assert.ok(finalStateRead >= 0);
  const afterFinalState = finalMethod.slice(finalStateRead);
  assert.equal((afterFinalState.match(/\bawait\b/gu) ?? []).length, 1);
  assert.doesNotMatch(afterFinalState, /\.(?:filter|map|forEach|reduce|some|every)\s*\(/u);

  const callSite = source.indexOf("await this.assertFinalPreSendAuthority");
  const sendSite = source.indexOf("this.dependencies.executionAdapter.createOrder", callSite);
  assert.ok(callSite >= 0 && sendSite > callSite);
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

  constructor(
    candidatePilots: InMemoryCandidatePilotRepository,
    private readonly mutation: FinalMutation,
    readonly trace: string[],
  ) {
    super(undefined, candidatePilots);
  }

  override async updateOrder(record: OrderRecord): Promise<void> {
    await super.updateOrder(record);
    if (record.status === "SUBMITTING") this.finalReadsArmed = true;
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

  override async findOrderByReference(
    exchangeAccountId: string,
    reference: string,
  ): Promise<OrderRecord | null> {
    const order = await super.findOrderByReference(exchangeAccountId, reference);
    if (!this.finalReadsArmed) return order;
    this.trace.push("order");
    if (!order) return null;
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
  constructor(
    initialState: ExecutionStateRecord,
    private readonly finalReadsArmed: () => boolean,
    private readonly mutation: FinalMutation,
    private readonly trace: string[],
  ) {
    super(initialState);
  }

  override async getState(): Promise<ExecutionStateRecord> {
    const state = await super.getState();
    if (!this.finalReadsArmed()) return state;
    this.trace.push("operatorState");
    return this.mutation === "OPERATOR_STATE"
      ? { ...state, systemStatus: "PAUSED", pauseReason: "final race" }
      : state;
  }
}

class TracingDryRunAdapter extends DryRunExchangeAdapter {
  createOrderCalls = 0;

  constructor(
    private readonly trace: string[],
    private readonly finalReadsArmed: () => boolean,
  ) {
    super();
  }

  override async createOrder(request: UpbitOrderRequest) {
    this.createOrderCalls += 1;
    if (this.finalReadsArmed()) this.trace.push("createOrder");
    return super.createOrder(request);
  }
}

async function createFixture(mutation: FinalMutation) {
  const trace: string[] = [];
  let repositories: FinalAuthorityRepository;
  const operatorState = new TracingOperatorStateStore(
    executionState(),
    () => repositories?.finalReadsArmed ?? false,
    mutation,
    trace,
  );
  const candidatePilots = new InMemoryCandidatePilotRepository(operatorState);
  repositories = new FinalAuthorityRepository(candidatePilots, mutation, trace);
  const leases = new InMemoryAccountExecutionLeaseStore();
  const adapter = new TracingDryRunAdapter(trace, () => repositories.finalReadsArmed);
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
    candidatePilots: finalCandidatePilotReads(candidatePilots, repositories, mutation, trace),
    now: () => ATTEMPT_AT,
  });

  return { adapter, candidatePilots, leases, operatorState, repositories, service, trace };
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
