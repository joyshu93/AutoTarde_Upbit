import assert from "node:assert/strict";

import type { RuntimeOwnershipAuthority } from "../src/app/runtime-ownership-guard.js";
import type { CandidateExecutionBindingRecord } from "../src/domain/pilot-types.js";
import type { ExecutionStateRecord, StrategyDecisionRecord } from "../src/domain/types.js";
import type { CandidatePilotRepository } from "../src/modules/db/pilot-interfaces.js";
import { candidateExecutionBindingMaterialHash } from "../src/modules/db/pilot-interfaces.js";
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
  type LiveExecutionAdapter,
  type UpbitOrderRequest,
} from
  "../src/modules/exchange/interfaces.js";
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
const FUTURE_CHRONOLOGY_AT = "2026-08-21T01:00:00.000Z";

test("candidate execution persists one atomic bound intent with exact successor timestamps", async () => {
  const fixture = await createFixture();

  const result = await fixture.service.submitOrderFromDecision(candidateInput());

  assert.equal(result.accepted, true);
  assert.equal(fixture.adapter.createOrderCalls, 1);
  assert.equal(fixture.repositories.persistOrderIntentCalls, 0);
  assert.equal(fixture.repositories.persistCandidateIntentCalls, 1);

  const orders = await fixture.repositories.listOrders("primary");
  assert.equal(orders.length, 1);
  assert.equal(orders[0]?.requestedAt, "2026-08-21T00:00:00.000000001Z");
  assert.equal(orders[0]?.createdAt, "2026-08-21T00:00:00.000000001Z");
  const binding = await fixture.candidatePilots.getExecutionBindingForOrder(orders[0]!.id);
  assert.equal(binding?.createdAt, "2026-08-21T00:00:00.000000000Z");
  assert.equal(binding?.orderId, orders[0]?.id);
  assert.equal(binding?.strategyDecisionId, "decision-1");
  assert.equal(binding?.executionMode, "DRY_RUN");
  assert.equal(binding?.materialVersion, "BINDING_V2");
});

test("candidate execution persists and sends one canonical quote beyond eight decision decimals", async () => {
  const candidateDecision = {
    ...persistedDecision(),
    intendedNotionalKrw: "9609.12345678",
  };
  const fixture = await createFixture({ persistedDecisionOverride: candidateDecision });
  const input = candidateInput();
  input.decision.requestedNotionalKrw = 9609.123456789;
  input.price = "9609.12345678";

  const result = await fixture.service.submitOrderFromDecision(input);

  assert.equal(result.accepted, true);
  assert.equal(fixture.adapter.createOrderCalls, 1);
  assert.equal(fixture.adapter.lastCreateOrderRequest?.price, "9609.12345678");
  assert.equal(fixture.adapter.lastCreateOrderRequest?.volume, null);
  const [order] = await fixture.repositories.listOrders("primary");
  const binding = await fixture.candidatePilots.getExecutionBindingForOrder(order!.id);
  assert.equal(order?.price, "9609.12345678");
  assert.equal(binding?.intendedNotionalKrw, "9609.12345678");
  assert.equal(binding?.boundPrice, "9609.12345678");
});

test("candidate LIVE execution persists a LIVE binding and sends exactly once", async () => {
  const fixture = await createFixture({ live: true });

  const result = await fixture.service.submitOrderFromDecision(candidateInput());

  assert.equal(result.accepted, true);
  assert.equal(result.outcome, "SUBMITTED");
  assert.equal(fixture.adapter.createOrderCalls, 1);
  const orders = await fixture.repositories.listOrders("primary");
  const binding = await fixture.candidatePilots.getExecutionBindingForOrder(orders[0]!.id);
  assert.equal(binding?.executionMode, "LIVE");
});

test("submission without candidate authority preserves the normal persistence path", async () => {
  const fixture = await createFixture();
  const input = candidateInput();
  delete input.candidateAuthority;

  const result = await fixture.service.submitOrderFromDecision(input);

  assert.equal(result.accepted, true);
  assert.equal(fixture.repositories.persistOrderIntentCalls, 1);
  assert.equal(fixture.repositories.persistCandidateIntentCalls, 0);
  assert.equal(fixture.adapter.createOrderCalls, 1);
});

test("candidate execution fails closed before lease or persistence when its dependency is missing", async () => {
  const fixture = await createFixture({ includeCandidateDependency: false });

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput()),
    CandidateExecutionSafetyError,
  );

  assert.equal((await fixture.repositories.listOrders("primary")).length, 0);
  assert.equal(fixture.repositories.persistOrderIntentCalls, 0);
  assert.equal(fixture.repositories.persistCandidateIntentCalls, 0);
  assert.equal(fixture.adapter.createOrderCalls, 0);
  assert.equal(await fixture.leases.getLease("primary"), null);
});

test("candidate execution rejects authority that does not match the submitted account", async () => {
  const fixture = await createFixture();
  const input = candidateInput({ ...candidateAuthority(), exchangeAccountId: "other" });

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(input),
    /does not match the submitted route/i,
  );

  assert.equal((await fixture.repositories.listOrders("primary")).length, 0);
  assert.equal(fixture.adapter.createOrderCalls, 0);
  assert.equal(await fixture.leases.getLease("primary"), null);
});

test("candidate execution rejects malformed authority with service-owned material fields", async () => {
  const fixture = await createFixture();
  const malformed = {
    ...candidateAuthority(),
    orderId: "caller-controlled-order",
  } as unknown as CandidateExecutionAuthority;

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput(malformed)),
    /authority is malformed/i,
  );

  assert.equal((await fixture.repositories.listOrders("primary")).length, 0);
  assert.equal(fixture.adapter.createOrderCalls, 0);
});

test("candidate execution fails closed when the persisted READY decision is unavailable", async () => {
  const fixture = await createFixture({ saveDecision: false });

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput()),
    /persisted candidate strategy decision does not match/i,
  );

  assert.equal((await fixture.repositories.listOrders("primary")).length, 0);
  assert.equal(fixture.adapter.createOrderCalls, 0);
  assert.equal(await fixture.leases.getLease("primary"), null);
});

test("candidate binding derivation failure pauses pilot and global execution before send", async () => {
  const fixture = await createFixture();
  const earlyExitOnly: CandidateExecutionAuthority = {
    ...candidateAuthority(),
    expectedPhase: "ACTIVE",
    routeReason: "CANDIDATE_EARLY_THESIS_FAILURE",
  };

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput(earlyExitOnly)),
    CandidateExecutionSafetyError,
  );

  assert.equal(fixture.adapter.createOrderCalls, 0);
  assert.equal((await fixture.repositories.listOrders("primary")).length, 0);
  assert.equal((await fixture.candidatePilots.getDeployment("deployment-1"))?.phase, "PAUSED_FAULT");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  assert.notEqual(await fixture.leases.getLease("primary"), null);
  const audit = (await fixture.candidatePilots.listAuditEvents("deployment-1")).at(-1);
  const payload = JSON.parse(audit!.payloadJson) as { reasonCode: string; provenanceJson: string };
  assert.equal(payload.reasonCode, "IDENTITY_MISMATCH");
  assert.equal((JSON.parse(payload.provenanceJson) as { stage: string }).stage, "DERIVATION");
});

test("candidate atomic persistence failure pauses pilot and global execution while retaining the lease", async () => {
  const fixture = await createFixture({ failCandidatePersistence: true });

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput()),
    CandidateExecutionSafetyError,
  );

  assert.equal(fixture.adapter.createOrderCalls, 0);
  assert.equal((await fixture.repositories.listOrders("primary")).length, 0);
  assert.equal((await fixture.candidatePilots.getDeployment("deployment-1"))?.phase, "PAUSED_FAULT");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  assert.notEqual(await fixture.leases.getLease("primary"), null);
});

test("exact candidate duplicate reuses the existing intent without a second binding or send", async () => {
  const fixture = await createFixture();

  const first = await fixture.service.submitOrderFromDecision(candidateInput());
  const second = await fixture.service.submitOrderFromDecision(candidateInput());

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, false);
  assert.equal(second.outcome, "DUPLICATE");
  assert.equal(fixture.repositories.persistCandidateIntentCalls, 1);
  assert.equal(fixture.adapter.createOrderCalls, 1);
  assert.equal((await fixture.repositories.listOrders("primary")).length, 1);
  assert.equal((await fixture.candidatePilots.getDeployment("deployment-1"))?.phase, "ACTIVE");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "RUNNING");
});

test("candidate duplicate with no execution binding atomically pauses instead of returning DUPLICATE", async () => {
  const fixture = await createFixture();
  const baselineInput = candidateInput();
  delete baselineInput.candidateAuthority;
  const first = await fixture.service.submitOrderFromDecision(baselineInput);

  assert.equal(first.accepted, true);
  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput()),
    CandidateExecutionSafetyError,
  );

  assert.equal(fixture.adapter.createOrderCalls, 1);
  assert.equal(fixture.repositories.persistCandidateIntentCalls, 0);
  assert.equal((await fixture.repositories.listOrders("primary")).length, 1);
  assert.equal((await fixture.candidatePilots.getDeployment("deployment-1"))?.phase, "PAUSED_FAULT");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  const audit = (await fixture.candidatePilots.listAuditEvents("deployment-1")).at(-1);
  const payload = JSON.parse(audit!.payloadJson) as { reasonCode: string };
  assert.equal(payload.reasonCode, "IDENTITY_MISMATCH");
});

test("candidate duplicate with mismatched deployment binding atomically pauses", async () => {
  const fixture = await createFixture({
    transformDuplicateBinding: (binding) => rehashBinding({
      ...binding,
      deploymentId: "other-deployment",
    }),
  });
  await fixture.service.submitOrderFromDecision(candidateInput());

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput()),
    CandidateExecutionSafetyError,
  );

  assert.equal(fixture.adapter.createOrderCalls, 1);
  assert.equal(fixture.repositories.persistCandidateIntentCalls, 1);
  assert.equal((await fixture.candidatePilots.getDeployment("deployment-1"))?.phase, "PAUSED_FAULT");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
});

test("candidate duplicate with mismatched bound order material atomically pauses", async () => {
  const fixture = await createFixture({
    transformDuplicateBinding: (binding) => rehashBinding({
      ...binding,
      boundPrice: "5999",
    }),
  });
  await fixture.service.submitOrderFromDecision(candidateInput());

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput()),
    CandidateExecutionSafetyError,
  );

  assert.equal(fixture.adapter.createOrderCalls, 1);
  assert.equal(fixture.repositories.persistCandidateIntentCalls, 1);
  assert.equal((await fixture.candidatePilots.getDeployment("deployment-1"))?.phase, "PAUSED_FAULT");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
});

test("non-candidate duplicate preserves the existing DUPLICATE result without pausing", async () => {
  const fixture = await createFixture();
  const input = candidateInput();
  delete input.candidateAuthority;

  const first = await fixture.service.submitOrderFromDecision(input);
  const second = await fixture.service.submitOrderFromDecision(input);

  assert.equal(first.accepted, true);
  assert.equal(second.outcome, "DUPLICATE");
  assert.equal(fixture.adapter.createOrderCalls, 1);
  assert.equal((await fixture.candidatePilots.getDeployment("deployment-1"))?.phase, "ACTIVE");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "RUNNING");
});

test("candidate derivation fault advances past authority deployment chronology under clock skew", async () => {
  const fixture = await createFixture();
  const baseAuthority = candidateAuthority();
  if (baseAuthority.expectedPhase !== "ACTIVE") throw new Error("test authority must be ACTIVE");
  const skewedAuthority: CandidateExecutionAuthority = {
    ...baseAuthority,
    expectedDeploymentUpdatedAt: FUTURE_CHRONOLOGY_AT,
    routeReason: "CANDIDATE_EARLY_THESIS_FAILURE" as const,
  };

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput(skewedAuthority)),
    CandidateExecutionSafetyError,
  );

  const audit = (await fixture.candidatePilots.listAuditEvents("deployment-1")).at(-1);
  assert.equal((await fixture.candidatePilots.getDeployment("deployment-1"))?.phase, "PAUSED_FAULT");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  assert.ok(Date.parse(audit!.createdAt) >= Date.parse(FUTURE_CHRONOLOGY_AT));
  assert.equal(fixture.adapter.createOrderCalls, 0);
  assert.notEqual(await fixture.leases.getLease("primary"), null);
});

test("candidate persistence fault advances past latest audit chronology under clock skew", async () => {
  const fixture = await createFixture({ failCandidatePersistence: true });
  await appendFutureCandidateAudit(fixture.candidatePilots);
  const authority = { ...candidateAuthority(), expectedStateVersion: 1 };

  await assert.rejects(
    () => fixture.service.submitOrderFromDecision(candidateInput(authority)),
    CandidateExecutionSafetyError,
  );

  const audit = (await fixture.candidatePilots.listAuditEvents("deployment-1")).at(-1);
  assert.equal((await fixture.candidatePilots.getDeployment("deployment-1"))?.phase, "PAUSED_FAULT");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  assert.ok(Date.parse(audit!.createdAt) >= Date.parse(FUTURE_CHRONOLOGY_AT));
  assert.equal(fixture.adapter.createOrderCalls, 0);
  assert.notEqual(await fixture.leases.getLease("primary"), null);
});

class RecordingExecutionRepository extends InMemoryExecutionRepository {
  persistOrderIntentCalls = 0;
  persistCandidateIntentCalls = 0;
  failCandidatePersistence = false;

  override async persistOrderIntent(
    input: Parameters<InMemoryExecutionRepository["persistOrderIntent"]>[0],
  ): Promise<void> {
    this.persistOrderIntentCalls += 1;
    await super.persistOrderIntent(input);
  }

  override async persistCandidateBoundOrderIntent(
    input: Parameters<InMemoryExecutionRepository["persistCandidateBoundOrderIntent"]>[0],
  ): Promise<void> {
    this.persistCandidateIntentCalls += 1;
    if (this.failCandidatePersistence) {
      throw new Error("injected candidate persistence failure");
    }
    await super.persistCandidateBoundOrderIntent(input);
  }
}

class RecordingDryRunAdapter extends DryRunExchangeAdapter {
  createOrderCalls = 0;
  lastCreateOrderRequest: UpbitOrderRequest | null = null;

  override async createOrder(request: UpbitOrderRequest) {
    this.createOrderCalls += 1;
    this.lastCreateOrderRequest = request;
    return super.createOrder(request);
  }
}

class RecordingLiveAdapter implements LiveExecutionAdapter {
  readonly sendPath = "LIVE_ADAPTER" as const;
  createOrderCalls = 0;
  lastCreateOrderRequest: UpbitOrderRequest | null = null;
  private readonly delegate = new DryRunExchangeAdapter();

  getBalances(): ReturnType<DryRunExchangeAdapter["getBalances"]> {
    return this.delegate.getBalances();
  }

  getOrderChance(...args: Parameters<DryRunExchangeAdapter["getOrderChance"]>) {
    return this.delegate.getOrderChance(...args);
  }

  testOrder(...args: Parameters<DryRunExchangeAdapter["testOrder"]>) {
    return this.delegate.testOrder(...args);
  }

  async createOrder(request: UpbitOrderRequest) {
    this.createOrderCalls += 1;
    this.lastCreateOrderRequest = request;
    return this.delegate.createOrder(request);
  }

  cancelOrder(...args: Parameters<DryRunExchangeAdapter["cancelOrder"]>) {
    return this.delegate.cancelOrder(...args);
  }

  getOrder(...args: Parameters<DryRunExchangeAdapter["getOrder"]>) {
    return this.delegate.getOrder(...args);
  }

  listOpenOrders(...args: Parameters<DryRunExchangeAdapter["listOpenOrders"]>) {
    return this.delegate.listOpenOrders(...args);
  }

  listClosedOrders(...args: Parameters<DryRunExchangeAdapter["listClosedOrders"]>) {
    return this.delegate.listClosedOrders(...args);
  }
}

async function createFixture(options: {
  includeCandidateDependency?: boolean;
  failCandidatePersistence?: boolean;
  saveDecision?: boolean;
  persistedDecisionOverride?: StrategyDecisionRecord;
  live?: boolean;
  transformDuplicateBinding?: (binding: CandidateExecutionBindingRecord) => CandidateExecutionBindingRecord;
} = {}) {
  const operatorState = new InMemoryOperatorStateStore(executionState(options.live ?? false));
  const candidatePilots = new InMemoryCandidatePilotRepository(operatorState);
  const repositories = new RecordingExecutionRepository(undefined, candidatePilots);
  repositories.failCandidatePersistence = options.failCandidatePersistence ?? false;
  const adapter = options.live ? new RecordingLiveAdapter() : new RecordingDryRunAdapter();
  const leases = new InMemoryAccountExecutionLeaseStore();
  await seedCandidate(
    candidatePilots,
    repositories,
    options.saveDecision ?? true,
    options.persistedDecisionOverride,
  );

  const dependencies = {
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
    runtimeOwnership: createAlwaysOwnedRuntimeAuthority(
      operatorState,
      options.live ? "LIVE" : "DRY_RUN",
    ),
    now: () => ATTEMPT_AT,
    ...(options.includeCandidateDependency === false
      ? {}
      : { candidatePilots: narrowCandidatePilots(candidatePilots, options.transformDuplicateBinding) }),
  };
  const service = new ExecutionService(dependencies);

  return { adapter, candidatePilots, leases, operatorState, repositories, service };
}

function createAlwaysOwnedRuntimeAuthority(
  operatorState: InMemoryOperatorStateStore,
  executionMode: "DRY_RUN" | "LIVE",
): RuntimeOwnershipAuthority {
  const record = {
    ownerToken: "owner".padEnd(64, "a"),
    generation: 1,
    executionMode,
    acquiredAtEpochMs: 1,
    heartbeatAtEpochMs: 1,
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  };
  return {
    snapshot: () => ({
      status: "OWNED",
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
      const executionState = await operatorState.getState();
      return {
        runtimeOwnership: { ...record },
        executionState: {
          exchangeAccountId: executionState.exchangeAccountId,
          executionMode: executionState.executionMode,
          liveExecutionGate: executionState.liveExecutionGate,
          systemStatus: executionState.systemStatus,
          killSwitchActive: executionState.killSwitchActive,
        },
      };
    },
  };
}

async function seedCandidate(
  candidatePilots: InMemoryCandidatePilotRepository,
  repositories: InMemoryExecutionRepository,
  saveDecision: boolean,
  persistedDecisionOverride?: StrategyDecisionRecord,
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
  if (saveDecision) {
    await repositories.saveStrategyDecision(persistedDecisionOverride ?? persistedDecision());
  }
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

function candidateInput(
  authority: CandidateExecutionAuthority = candidateAuthority(),
): SubmitOrderFromDecisionInput {
  return {
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-1",
    referencePriceCapturedAt: "2026-08-20T23:59:59.900Z",
    decision: {
      strategyKey: "position_guard.paper_core.v1",
      market: "KRW-BTC",
      action: "ENTER",
      reasonCodes: ["candidate-test"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 6_000,
      requestedQuantity: null,
      metadata: {},
    },
    side: "bid",
    ordType: "price",
    price: "6000",
    volume: null,
    candidateAuthority: authority,
  };
}

function narrowCandidatePilots(
  candidatePilots: CandidatePilotRepository,
  transformDuplicateBinding?: (binding: CandidateExecutionBindingRecord) => CandidateExecutionBindingRecord,
) {
  let bindingReadCount = 0;
  return {
    getDeployment: candidatePilots.getDeployment.bind(candidatePilots),
    getExactState: candidatePilots.getExactState.bind(candidatePilots),
    getExecutionBindingForOrder: async (orderId: string) => {
      const binding = await candidatePilots.getExecutionBindingForOrder(orderId);
      bindingReadCount += 1;
      return binding && transformDuplicateBinding && bindingReadCount > 1
        ? transformDuplicateBinding(binding)
        : binding;
    },
    pauseForCandidateIntentFault:
      candidatePilots.pauseForCandidateIntentFault.bind(candidatePilots),
  };
}

function rehashBinding(
  binding: CandidateExecutionBindingRecord,
): CandidateExecutionBindingRecord {
  const next = { ...binding, orderMaterialHash: "" };
  next.orderMaterialHash = candidateExecutionBindingMaterialHash(next);
  return next;
}

async function appendFutureCandidateAudit(candidatePilots: CandidatePilotRepository): Promise<void> {
  await candidatePilots.advanceStateWithEvidence({
    deploymentId: "deployment-1",
    expectedStateVersion: 0,
    evidence: {
      evidenceId: "future-chronology",
      executedAt: FUTURE_CHRONOLOGY_AT,
      action: "ENTER",
      entryPath: "RECLAIM",
      terminalStatus: "FILLED",
      executedQuantity: "0.00001",
      grossQuoteValueKrw: "1000",
      confirmedFeeKrw: "0.5",
      remainingQuantity: "0.00001",
    },
  });
}

function executionState(live: boolean): ExecutionStateRecord {
  return {
    id: "state-1",
    exchangeAccountId: "primary",
    executionMode: live ? "LIVE" : "DRY_RUN",
    liveExecutionGate: live ? "ENABLED" : "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-20T23:00:00.000Z",
  };
}
