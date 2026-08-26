import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  RuntimeOwnershipGuard,
  RuntimeOwnershipGuardError,
  type RuntimeOwnershipAuthority,
} from "../src/app/runtime-ownership-guard.js";
import type {
  RuntimeProcessLock,
  RuntimeProcessLockLossReason,
} from "../src/app/runtime-process-lock.js";
import type { ExecutionStateRecord } from "../src/domain/types.js";
import { ExecutionService } from "../src/modules/execution/execution-service.js";
import { ExchangeOrderSubmissionError } from "../src/modules/exchange/errors.js";
import {
  DryRunExchangeAdapter,
  type ExchangeAdapter,
  type ExecutionExchangeAdapter,
} from "../src/modules/exchange/interfaces.js";
import { InMemoryAccountExecutionLeaseStore } from "../src/modules/db/repositories/in-memory-account-execution-lease-store.js";
import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import { InMemoryRuntimeOwnershipStore } from "../src/modules/db/repositories/in-memory-runtime-ownership-store.js";
import type { AccountExecutionLeaseStore } from "../src/modules/db/pilot-interfaces.js";
import { test } from "./harness.js";

test("execution service fails closed before persistence when runtime authority is omitted", async () => {
  const exchange = createCountingAdapter();
  const { service, repositories } = await createService({
    exchangeAdapter: exchange,
    runtimeOwnership: null,
  });

  await assert.rejects(
    () => service.submitOrderFromDecision(validInput()),
    /RUNTIME_OWNERSHIP_NOT_HELD/u,
  );

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary")).length, 0);
  assert.equal((await repositories.listRiskEvents("primary")).length, 0);
});

test("a lease conflict creates no order row and calls createOrder zero times", async () => {
  const exchange = createCountingAdapter();
  const blocker = new InMemoryAccountExecutionLeaseStore();
  const { service, repositories, operatorState } = await createService({
    exchangeAdapter: exchange,
    accountExecutionLeases: blocker,
  });
  await blocker.acquireLease({
    exchangeAccountId: "primary",
    ownerToken: "another-process",
    purpose: "ORDER_SUBMISSION",
    acquiredAtEpochMs: Date.parse("2026-04-20T00:00:20.000Z"),
    expiresAtEpochMs: Date.parse("2026-04-20T00:01:20.000Z"),
  });

  const result = await service.submitOrderFromDecision(validInput());

  assert.equal(result.outcome, "LEASE_BLOCKED");
  assert.equal(result.order, null);
  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary")).length, 0);
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("lease acquisition ambiguity records risk and fails closed when automatic pause succeeds", async () => {
  const leases: AccountExecutionLeaseStore = {
    async getLease() { return null; },
    async acquireLease() { throw new Error("lease storage unavailable"); },
    async renewLease() { throw new Error("not reached"); },
    async releaseLease() { return true; },
  };
  const { service, repositories, operatorState } = await createService({ accountExecutionLeases: leases });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /Account execution lease acquisition is ambiguous/);

  assert.equal((await repositories.listOrders("primary")).length, 0);
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("an acquired lease blocks an account-wide active order before validation or send", async () => {
  const exchange = createCountingAdapter();
  const { service, repositories, operatorState } = await createService({ exchangeAdapter: exchange });
  await repositories.saveOrder({
    id: "active-eth-order", strategyDecisionId: "other", exchangeAccountId: "primary", market: "KRW-ETH",
    side: "bid", ordType: "limit", volume: "0.001", price: "1000000", timeInForce: null, smpType: null,
    identifier: "active-eth-identifier", idempotencyKey: "other-key", origin: "STRATEGY", requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: null, status: "RECONCILIATION_REQUIRED", executionMode: "DRY_RUN", exchangeResponseJson: null,
    failureCode: "RECONCILIATION_REQUIRED", failureMessage: "pending", createdAt: "2026-04-20T00:00:00.000Z", updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const result = await service.submitOrderFromDecision(validInput());

  assert.equal(result.outcome, "LEASE_BLOCKED");
  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary")).length, 1);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("renewal loss after SUBMITTING retains recovery evidence and sends nothing", async () => {
  const base = new InMemoryAccountExecutionLeaseStore();
  const leases: AccountExecutionLeaseStore = {
    getLease: base.getLease.bind(base),
    acquireLease: base.acquireLease.bind(base),
    async renewLease() { return null; },
    releaseLease: base.releaseLease.bind(base),
  };
  const exchange = createCountingAdapter();
  const { service, repositories, operatorState } = await createService({ exchangeAdapter: exchange, accountExecutionLeases: leases });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /Account execution lease renewal is ambiguous/);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary"))[0]?.status, "SUBMITTING");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("a replaced runtime generation after final order checks leaves immutable evidence and never sends", async () => {
  const exchange = createCountingAdapter();
  const ownershipStore = new InMemoryRuntimeOwnershipStore();
  const runtimeOwnership = new RuntimeOwnershipGuard({
    processLock: new HeldProcessLock(),
    store: ownershipStore,
    ownerToken: "owner-a".padEnd(64, "x"),
  });
  await runtimeOwnership.acquire({ executionMode: "DRY_RUN", acquiredAtEpochMs: 1 });
  const repositories = new ReplaceOwnershipOnFinalOrderReadRepository(async () => {
    await ownershipStore.acquireAfterProcessLock({
      ownerToken: "owner-b".padEnd(64, "x"),
      executionMode: "DRY_RUN",
      acquiredAtEpochMs: 2,
      expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
    });
  });
  const leaseStore = new InMemoryAccountExecutionLeaseStore();
  const { service, operatorState } = await createService({
    exchangeAdapter: exchange,
    accountExecutionLeases: leaseStore,
    repositories,
    runtimeOwnership,
  });

  await assert.rejects(
    () => service.submitOrderFromDecision(validInput()),
    (error) => error instanceof RuntimeOwnershipGuardError &&
      error.code === "RUNTIME_OWNERSHIP_LOST",
  );

  assert.equal(repositories.replacementCalls, 1);
  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary"))[0]?.status, "SUBMITTING");
  assert.equal((await repositories.listRiskEvents("primary")).length, 0);
  assert.equal((await operatorState.getState()).systemStatus, "RUNNING");
  assert.notEqual(await leaseStore.getLease("primary"), null);
});

class ReplaceOwnershipOnFinalOrderReadRepository extends InMemoryExecutionRepository {
  replacementCalls = 0;

  constructor(private readonly replaceOwnership: () => Promise<void>) {
    super();
  }

  override async findOrderById(exchangeAccountId: string, orderId: string) {
    const order = await super.findOrderById(exchangeAccountId, orderId);
    this.replacementCalls += 1;
    await this.replaceOwnership();
    return order;
  }
}

class HeldProcessLock implements RuntimeProcessLock {
  readonly identity = { scopeDigest: "f".repeat(64) };

  isHeld(): boolean {
    return true;
  }

  onLost(_listener: (reason: RuntimeProcessLockLossReason) => void): () => void {
    return () => undefined;
  }

  async release(): Promise<void> {}
}

test("slow validation expiry cannot turn into a concurrent send because pre-send renewal verifies ownership", async () => {
  const base = new InMemoryAccountExecutionLeaseStore();
  let now = "2026-04-20T00:00:20.000Z";
  const exchange = createCountingAdapter({
    async beforeTestOrder() {
      now = "2026-04-20T00:00:51.000Z";
      await base.acquireLease({
        exchangeAccountId: "primary", ownerToken: "second-process", purpose: "ORDER_SUBMISSION",
        acquiredAtEpochMs: Date.parse(now), expiresAtEpochMs: Date.parse("2026-04-20T00:01:21.000Z"),
      });
    },
  });
  const { service, repositories } = await createService({ exchangeAdapter: exchange, accountExecutionLeases: base, now: () => now });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /Account execution lease renewal is ambiguous/);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary"))[0]?.status, "SUBMITTING");
});

test("a takeover persisted after renewal blocks the final pre-send authority check", async () => {
  const base = new InMemoryAccountExecutionLeaseStore();
  let persistTakeover = async (): Promise<void> => undefined;
  const leases: AccountExecutionLeaseStore = {
    getLease: base.getLease.bind(base),
    acquireLease: base.acquireLease.bind(base),
    async renewLease(input) {
      const lease = await base.renewLease(input);
      await persistTakeover();
      return lease;
    },
    releaseLease: base.releaseLease.bind(base),
  };
  const exchange = createCountingAdapter();
  const { service, repositories, operatorState } = await createService({ exchangeAdapter: exchange, accountExecutionLeases: leases });
  persistTakeover = async () => {
    await repositories.saveOrder(createActiveTakeoverOrder());
    await operatorState.pauseForFault({
      exchangeAccountId: "primary", faultId: "concurrent-takeover", reason: "concurrent SUBMITTING order",
      occurredAt: "2026-04-20T00:00:20.000Z",
    });
  };

  await assert.rejects(service.submitOrderFromDecision(validInput()), /final pre-send authority check/i);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary")).filter((order) => order.status === "SUBMITTING").length, 2);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("a final active-order read failure pauses and prevents the send", async () => {
  const repositories = new FailingFinalActiveOrdersRepository();
  const exchange = createCountingAdapter();
  const { service, operatorState } = await createService({ repositories, exchangeAdapter: exchange });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /final pre-send authority check/i);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
});

test("a final execution-state read failure pauses and prevents the send", async () => {
  const operatorState = new FailingFinalStateReadOperatorStateStore(createRunningState());
  const exchange = createCountingAdapter();
  const { service, repositories } = await createService({ operatorState, exchangeAdapter: exchange });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /final pre-send authority check/i);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
});

test("a final LIVE mode transition blocks the configured live send path", async () => {
  const operatorState = new FinalAuthorityDriftOperatorStateStore(
    createRunningState({ executionMode: "LIVE", liveExecutionGate: "ENABLED" }),
    createRunningState({ executionMode: "DRY_RUN", liveExecutionGate: "ENABLED" }),
  );
  const exchange = createCountingAdapter({ sendPath: "LIVE_ADAPTER" });
  const { service, repositories } = await createService({
    operatorState,
    exchangeAdapter: exchange,
  });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /final pre-send authority check/i);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
});

test("a final LIVE gate transition blocks the configured live send path", async () => {
  const operatorState = new FinalAuthorityDriftOperatorStateStore(
    createRunningState({ executionMode: "LIVE", liveExecutionGate: "ENABLED" }),
    createRunningState({ executionMode: "LIVE", liveExecutionGate: "DISABLED" }),
  );
  const exchange = createCountingAdapter({ sendPath: "LIVE_ADAPTER" });
  const { service, repositories } = await createService({
    operatorState,
    exchangeAdapter: exchange,
  });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /final pre-send authority check/i);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
});

test("a final mode and gate mismatch blocks the configured dry-run send path", async () => {
  const operatorState = new FinalAuthorityDriftOperatorStateStore(
    createRunningState(),
    createRunningState({ executionMode: "LIVE", liveExecutionGate: "ENABLED" }),
  );
  const exchange = createCountingAdapter();
  const { service, repositories } = await createService({ operatorState, exchangeAdapter: exchange });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /final pre-send authority check/i);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
});

test("the live channel rejects a non-live initial tuple before order persistence", async () => {
  const operatorState = new InMemoryOperatorStateStore(createRunningState());
  const exchange = createCountingAdapter({ sendPath: "LIVE_ADAPTER" });
  const { service, repositories } = await createService({ operatorState, exchangeAdapter: exchange });

  const result = await service.submitOrderFromDecision(validInput());

  assert.equal(result.outcome, "LEASE_BLOCKED");
  assert.equal(result.order, null);
  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary")).length, 0);
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("the dry channel rejects a fully-live initial tuple before order persistence", async () => {
  const operatorState = new InMemoryOperatorStateStore(
    createRunningState({ executionMode: "LIVE", liveExecutionGate: "ENABLED" }),
  );
  const exchange = createCountingAdapter();
  const { service, repositories } = await createService({ operatorState, exchangeAdapter: exchange });

  const result = await service.submitOrderFromDecision(validInput());

  assert.equal(result.outcome, "LEASE_BLOCKED");
  assert.equal(result.order, null);
  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary")).length, 0);
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("a dry initial tuple cannot upgrade into a live send at final authority", async () => {
  const operatorState = new FinalAuthorityDriftOperatorStateStore(
    createRunningState({ executionMode: "DRY_RUN", liveExecutionGate: "DISABLED" }),
    createRunningState({ executionMode: "LIVE", liveExecutionGate: "ENABLED" }),
  );
  const exchange = createCountingAdapter();
  const { service, repositories } = await createService({
    operatorState,
    exchangeAdapter: exchange,
  });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /final pre-send authority check/i);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary"))[0]?.status, "SUBMITTING");
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("a stable DRY_RUN ENABLED tuple remains simulated on the dry channel", async () => {
  const operatorState = new InMemoryOperatorStateStore(
    createRunningState({ executionMode: "DRY_RUN", liveExecutionGate: "ENABLED" }),
  );
  const { service, repositories } = await createService({ operatorState });

  const result = await service.submitOrderFromDecision(validInput());
  const events = await repositories.listOrderEvents(result.order?.id ?? "");
  const fills = await repositories.listFills(result.order?.id);

  assert.equal(result.outcome, "SIMULATED_FILLED");
  assert.equal(result.order?.executionMode, "DRY_RUN");
  assert.equal(result.order?.status, "FILLED");
  assert.equal(events.find((event) => event.eventType === "ORDER_SUBMITTED")?.eventSource, "LOCAL");
  assert.equal(events.find((event) => event.eventType === "ORDER_FILLED")?.eventSource, "LOCAL");
  assert.equal(fills.length, 1);
});

test("a stable LIVE DISABLED tuple remains simulated on the dry channel", async () => {
  const operatorState = new InMemoryOperatorStateStore(
    createRunningState({ executionMode: "LIVE", liveExecutionGate: "DISABLED" }),
  );
  const { service, repositories } = await createService({ operatorState });

  const result = await service.submitOrderFromDecision(validInput());
  const events = await repositories.listOrderEvents(result.order?.id ?? "");
  const fills = await repositories.listFills(result.order?.id);

  assert.equal(result.outcome, "SIMULATED_FILLED");
  assert.equal(result.order?.executionMode, "DRY_RUN");
  assert.equal(result.order?.status, "FILLED");
  assert.equal(events.find((event) => event.eventType === "ORDER_SUBMITTED")?.eventSource, "LOCAL");
  assert.equal(events.find((event) => event.eventType === "ORDER_FILLED")?.eventSource, "LOCAL");
  assert.equal(fills.length, 1);
});

test("a stable LIVE ENABLED tuple remains exchange-backed on the live channel", async () => {
  const operatorState = new InMemoryOperatorStateStore(
    createRunningState({ executionMode: "LIVE", liveExecutionGate: "ENABLED" }),
  );
  const exchange = createCountingAdapter({ sendPath: "LIVE_ADAPTER" });
  const { service, repositories } = await createService({ operatorState, exchangeAdapter: exchange });

  const result = await service.submitOrderFromDecision(validInput());
  const events = await repositories.listOrderEvents(result.order?.id ?? "");
  const fills = await repositories.listFills(result.order?.id);

  assert.equal(result.outcome, "SUBMITTED");
  assert.equal(result.order?.executionMode, "LIVE");
  assert.equal(result.order?.status, "OPEN");
  assert.equal(events.find((event) => event.eventType === "ORDER_SUBMITTED")?.eventSource, "EXCHANGE");
  assert.equal(events.some((event) => event.eventType === "ORDER_FILLED"), false);
  assert.equal(fills.length, 0);
});

test("mode-only drift between accepted dry tuples blocks the dry channel", async () => {
  const operatorState = new FinalAuthorityDriftOperatorStateStore(
    createRunningState({ executionMode: "LIVE", liveExecutionGate: "DISABLED" }),
    createRunningState({ executionMode: "DRY_RUN", liveExecutionGate: "DISABLED" }),
  );
  const exchange = createCountingAdapter();
  const { service, repositories } = await createService({ operatorState, exchangeAdapter: exchange });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /final pre-send authority check/i);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary"))[0]?.status, "SUBMITTING");
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
});

test("gate-only drift between accepted dry tuples blocks the dry channel", async () => {
  const operatorState = new FinalAuthorityDriftOperatorStateStore(
    createRunningState({ executionMode: "DRY_RUN", liveExecutionGate: "ENABLED" }),
    createRunningState({ executionMode: "DRY_RUN", liveExecutionGate: "DISABLED" }),
  );
  const exchange = createCountingAdapter();
  const { service, repositories } = await createService({ operatorState, exchangeAdapter: exchange });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /final pre-send authority check/i);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await repositories.listOrders("primary"))[0]?.status, "SUBMITTING");
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
});

test("an initial active-order read failure pauses and prevents the send", async () => {
  const repositories = new FailingInitialActiveOrdersRepository();
  const exchange = createCountingAdapter();
  const { service, operatorState } = await createService({ repositories, exchangeAdapter: exchange });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /initial post-acquisition authority check/i);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
});

test("an initial execution-state read failure pauses and prevents the send", async () => {
  const operatorState = new FailingInitialStateReadOperatorStateStore(createRunningState());
  const exchange = createCountingAdapter();
  const { service, repositories } = await createService({ operatorState, exchangeAdapter: exchange });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /initial post-acquisition authority check/i);

  assert.equal(exchange.createOrderCalls, 0);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
});

test("unsafe lease expiry arithmetic records risk and pauses before any order exists", async () => {
  const { service, repositories, operatorState } = await createService({ accountExecutionLeaseMs: Number.MAX_SAFE_INTEGER });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /Account execution lease acquisition is ambiguous/);

  assert.equal((await repositories.listOrders("primary")).length, 0);
  assert.equal((await repositories.listRiskEvents("primary"))[0]?.ruleCode, "ACCOUNT_EXECUTION_LEASE_BLOCKED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("automatic pause failure after lease conflict is fatal rather than a safe blocked result", async () => {
  const blocker = new InMemoryAccountExecutionLeaseStore();
  const { service } = await createService({
    accountExecutionLeases: blocker,
    operatorState: new FailingPauseOperatorStateStore(createRunningState()),
  });
  await blocker.acquireLease({
    exchangeAccountId: "primary", ownerToken: "other", purpose: "ORDER_SUBMISSION",
    acquiredAtEpochMs: Date.parse("2026-04-20T00:00:20.000Z"),
    expiresAtEpochMs: Date.parse("2026-04-20T00:01:20.000Z"),
  });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /Automatic fault pause could not be persisted/);
});

test("lease risk evidence failure still pauses and fails closed", async () => {
  const blocker = new InMemoryAccountExecutionLeaseStore();
  const repositories = new FailingLeaseRiskRepository();
  const { service, operatorState } = await createService({ accountExecutionLeases: blocker, repositories });
  await blocker.acquireLease({
    exchangeAccountId: "primary", ownerToken: "other", purpose: "ORDER_SUBMISSION",
    acquiredAtEpochMs: Date.parse("2026-04-20T00:00:20.000Z"),
    expiresAtEpochMs: Date.parse("2026-04-20T00:01:20.000Z"),
  });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /risk evidence could not be persisted/i);

  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("lease risk and pause persistence failures are reported together", async () => {
  const blocker = new InMemoryAccountExecutionLeaseStore();
  const { service } = await createService({
    accountExecutionLeases: blocker,
    repositories: new FailingLeaseRiskRepository(),
    operatorState: new FailingPauseOperatorStateStore(createRunningState()),
  });
  await blocker.acquireLease({
    exchangeAccountId: "primary", ownerToken: "other", purpose: "ORDER_SUBMISSION",
    acquiredAtEpochMs: Date.parse("2026-04-20T00:00:20.000Z"),
    expiresAtEpochMs: Date.parse("2026-04-20T00:01:20.000Z"),
  });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /risk evidence and automatic fault pause could not be persisted/i);
});

test("release ambiguity is fatal after a terminal dry-run outcome", async () => {
  const base = new InMemoryAccountExecutionLeaseStore();
  const leases: AccountExecutionLeaseStore = {
    getLease: base.getLease.bind(base), acquireLease: base.acquireLease.bind(base), renewLease: base.renewLease.bind(base),
    async releaseLease() { return false; },
  };
  const { service, operatorState } = await createService({ accountExecutionLeases: leases });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /Account execution lease release is ambiguous/);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("a thrown release is also fatal and pauses the account", async () => {
  const base = new InMemoryAccountExecutionLeaseStore();
  const leases: AccountExecutionLeaseStore = {
    getLease: base.getLease.bind(base), acquireLease: base.acquireLease.bind(base), renewLease: base.renewLease.bind(base),
    async releaseLease() { throw new Error("release transport failure"); },
  };
  const { service, operatorState } = await createService({ accountExecutionLeases: leases });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /Account execution lease release is ambiguous/);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("an uncertain send reserves identifier and never retries createOrder", async () => {
  const exchange = createCountingAdapter({
    createOrderError: new ExchangeOrderSubmissionError({
      kind: "UNCERTAIN",
      status: null,
      exchangeCode: null,
      exchangeName: null,
      responseReceived: false,
    }),
  });
  const { service, operatorState } = await createService({ exchangeAdapter: exchange });

  const first = await service.submitOrderFromDecision(validInput());
  const second = await service.submitOrderFromDecision(validInput());

  assert.equal(first.outcome, "RECONCILIATION_REQUIRED");
  assert.equal(first.order?.status, "RECONCILIATION_REQUIRED");
  assert.equal(second.outcome, "DUPLICATE");
  assert.equal(exchange.createOrderCalls, 1);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("an untyped send exception fails closed as reconciliation required", async () => {
  const exchange = createCountingAdapter({ createOrderError: new Error("socket closed") });
  const { service } = await createService({ exchangeAdapter: exchange });

  const result = await service.submitOrderFromDecision(validInput());

  assert.equal(result.outcome, "RECONCILIATION_REQUIRED");
  assert.equal(result.order?.status, "RECONCILIATION_REQUIRED");
  assert.equal(exchange.createOrderCalls, 1);
});

test("a definitive exchange rejection is terminal and releases the account lease", async () => {
  const leaseStore = new InMemoryAccountExecutionLeaseStore();
  const exchange = createCountingAdapter({
    createOrderError: new ExchangeOrderSubmissionError({
      kind: "DEFINITIVE_REJECTION",
      status: 400,
      exchangeCode: "insufficient_funds_bid",
      exchangeName: "insufficient_funds_bid",
      responseReceived: true,
    }),
  });
  const { service } = await createService({
    exchangeAdapter: exchange,
    accountExecutionLeases: leaseStore,
  });

  const result = await service.submitOrderFromDecision(validInput());
  const reacquired = await leaseStore.acquireLease({
    exchangeAccountId: "primary",
    ownerToken: "later-attempt",
    purpose: "ORDER_SUBMISSION",
    acquiredAtEpochMs: Date.parse("2026-04-20T00:00:20.000Z"),
    expiresAtEpochMs: Date.parse("2026-04-20T00:00:50.000Z"),
  });

  assert.equal(result.outcome, "REJECTED");
  assert.equal(result.order?.status, "REJECTED");
  assert.notEqual(reacquired, null);
});

test("duplicate_identifier is reconciliation required and retains the account lease", async () => {
  const leaseStore = new InMemoryAccountExecutionLeaseStore();
  const exchange = createCountingAdapter({
    createOrderError: new ExchangeOrderSubmissionError({
      kind: "DEFINITIVE_REJECTION",
      status: 400,
      exchangeCode: "duplicate_identifier",
      exchangeName: "duplicate_identifier",
      responseReceived: true,
    }),
  });
  const { service } = await createService({
    exchangeAdapter: exchange,
    accountExecutionLeases: leaseStore,
  });

  const result = await service.submitOrderFromDecision(validInput());

  assert.equal(result.outcome, "RECONCILIATION_REQUIRED");
  assert.equal(result.order?.status, "RECONCILIATION_REQUIRED");
  assert.notEqual(await leaseStore.getLease("primary"), null);
});

test("a post-send persistence failure keeps SUBMITTING and the account lease before throwing", async () => {
  const leaseStore = new InMemoryAccountExecutionLeaseStore();
  const repositories = new FailingExchangeSubmissionRepository();
  const { service, operatorState } = await createService({
    accountExecutionLeases: leaseStore,
    repositories,
  });

  await assert.rejects(service.submitOrderFromDecision(validInput()), /could not be persisted atomically/);

  assert.equal((await repositories.listOrders("primary"))[0]?.status, "SUBMITTING");
  assert.notEqual(await leaseStore.getLease("primary"), null);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("a simulated terminal outcome releases the account execution lease", async () => {
  const leaseStore = new InMemoryAccountExecutionLeaseStore();
  const { service } = await createService({ accountExecutionLeases: leaseStore });

  const result = await service.submitOrderFromDecision(validInput());
  const reacquired = await leaseStore.acquireLease({
    exchangeAccountId: "primary",
    ownerToken: "later-attempt",
    purpose: "ORDER_SUBMISSION",
    acquiredAtEpochMs: Date.parse("2026-04-20T00:00:20.000Z"),
    expiresAtEpochMs: Date.parse("2026-04-20T00:00:50.000Z"),
  });

  assert.equal(result.outcome, "SIMULATED_FILLED");
  assert.notEqual(reacquired, null);
});

test("only ExecutionService has production createOrder authority", async () => {
  const productionRoot = path.resolve(process.cwd(), "src");
  const files = await listTypeScriptFiles(productionRoot);
  const callers = await Promise.all(files.map(async (filePath) => ({
    filePath,
    source: await readFile(filePath, "utf8"),
  })));
  const createOrderCallers = callers
    .filter(({ source }) => /\.createOrder\s*\(/u.test(source))
    .map(({ filePath }) => path.relative(process.cwd(), filePath).replaceAll("\\", "/"));

  assert.deepEqual(createOrderCallers, ["src/modules/execution/execution-service.ts"]);

  const cancelOrderCallers = callers
    .filter(({ source }) => /\.cancelOrder\s*\(/u.test(source))
    .map(({ filePath }) => path.relative(process.cwd(), filePath).replaceAll("\\", "/"));

  assert.deepEqual(cancelOrderCallers, []);
});

async function createService(overrides: {
  exchangeAdapter?: ExecutionExchangeAdapter;
  accountExecutionLeases?: AccountExecutionLeaseStore;
  repositories?: InMemoryExecutionRepository;
  operatorState?: InMemoryOperatorStateStore;
  runtimeOwnership?: RuntimeOwnershipAuthority | null;
  accountExecutionLeaseMs?: number;
  now?: () => string;
} = {}) {
  const repositories = overrides.repositories ?? new InMemoryExecutionRepository();
  const operatorState = overrides.operatorState ?? new InMemoryOperatorStateStore(createRunningState());
  const accountExecutionLeases = overrides.accountExecutionLeases ?? new InMemoryAccountExecutionLeaseStore();
  const service = new ExecutionService({
    riskLimits: {
      maxAllocationByAsset: { BTC: 0.6, ETH: 0.6 },
      totalExposureCap: 0.75,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    executionAdapter: overrides.exchangeAdapter ?? new DryRunExchangeAdapter(),
    repositories,
    accountExecutionLeases,
    accountExecutionLeaseMs: overrides.accountExecutionLeaseMs ?? 30_000,
    operatorState,
    ...(overrides.runtimeOwnership === null
      ? {}
      : {
          runtimeOwnership: overrides.runtimeOwnership ??
            createAlwaysOwnedRuntimeOwnershipAuthority(operatorState),
        }),
    now: overrides.now ?? (() => "2026-04-20T00:00:20.000Z"),
  });
  await repositories.saveBalanceSnapshot({
    id: "balance-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "position-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });
  return { service, repositories, operatorState };
}

class FailingExchangeSubmissionRepository extends InMemoryExecutionRepository {
  override async persistExchangeSubmission(): Promise<void> {
    throw new Error("injected atomic persistence failure");
  }
}

class FailingPauseOperatorStateStore extends InMemoryOperatorStateStore {
  override async pauseForFault(): Promise<ExecutionStateRecord> {
    throw new Error("injected pause persistence failure");
  }
}

class FailingFinalStateReadOperatorStateStore extends InMemoryOperatorStateStore {
  private reads = 0;

  override async getState(): Promise<ExecutionStateRecord> {
    this.reads += 1;
    if (this.reads === 2) throw new Error("injected final state read failure");
    return super.getState();
  }
}

class FailingInitialStateReadOperatorStateStore extends InMemoryOperatorStateStore {
  private reads = 0;

  override async getState(): Promise<ExecutionStateRecord> {
    this.reads += 1;
    if (this.reads === 1) throw new Error("injected initial state read failure");
    return super.getState();
  }
}

class FinalAuthorityDriftOperatorStateStore extends InMemoryOperatorStateStore {
  private reads = 0;

  constructor(
    initialState: ExecutionStateRecord,
    private readonly finalState: ExecutionStateRecord,
  ) {
    super(initialState);
  }

  override async getState(): Promise<ExecutionStateRecord> {
    this.reads += 1;
    if (this.reads === 2) return { ...this.finalState };
    return super.getState();
  }
}

class FailingFinalActiveOrdersRepository extends InMemoryExecutionRepository {
  override async listSubmissionBlockingOrders(): Promise<never> {
    throw new Error("injected final submission-blocking order read failure");
  }
}

class FailingInitialActiveOrdersRepository extends InMemoryExecutionRepository {
  override async listActiveOrders(): Promise<[]> {
    throw new Error("injected initial active-order read failure");
  }
}

class FailingLeaseRiskRepository extends InMemoryExecutionRepository {
  override async saveRiskEvent(): Promise<void> {
    throw new Error("injected lease risk persistence failure");
  }
}

function createRunningState(overrides: Partial<ExecutionStateRecord> = {}): ExecutionStateRecord {
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
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}

function createAlwaysOwnedRuntimeOwnershipAuthority(
  operatorState: InMemoryOperatorStateStore,
): RuntimeOwnershipAuthority {
  const record = {
    ownerToken: "owner".padEnd(64, "x"),
    generation: 1,
    executionMode: "DRY_RUN" as const,
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
    runWithCurrentExecutionAuthority(_input, callback) {
      callback();
      return operatorState.getState().then((executionState) => ({
        runtimeOwnership: { ...record },
        executionState: {
          exchangeAccountId: executionState.exchangeAccountId,
          executionMode: executionState.executionMode,
          liveExecutionGate: executionState.liveExecutionGate,
          systemStatus: executionState.systemStatus,
          killSwitchActive: executionState.killSwitchActive,
        },
      }));
    },
  };
}

function validInput() {
  return {
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-1",
    referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-BTC" as const,
      action: "ENTER" as const,
      reasonCodes: ["TEST"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 100_000,
      requestedQuantity: 0.001,
      metadata: {},
    },
    side: "bid" as const,
    ordType: "limit" as const,
    price: "100000000",
    volume: "0.001",
  };
}

function createActiveTakeoverOrder() {
  return {
    id: "concurrent-submitting-order", strategyDecisionId: "concurrent-decision", exchangeAccountId: "primary",
    market: "KRW-ETH" as const, side: "bid" as const, ordType: "limit" as const, volume: "0.001", price: "1000000",
    timeInForce: null, smpType: null, identifier: "concurrent-submitting-identifier", idempotencyKey: "concurrent-key",
    origin: "STRATEGY" as const, requestedAt: "2026-04-20T00:00:20.000Z", upbitUuid: null,
    status: "SUBMITTING" as const, executionMode: "DRY_RUN" as const, exchangeResponseJson: null,
    failureCode: null, failureMessage: null, createdAt: "2026-04-20T00:00:20.000Z", updatedAt: "2026-04-20T00:00:20.000Z",
  };
}

function createCountingAdapter(options: {
  createOrderError?: Error;
  beforeTestOrder?: () => Promise<void>;
  sendPath?: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
} = {}): ExecutionExchangeAdapter & { readonly createOrderCalls: number } {
  const baseAdapter = new DryRunExchangeAdapter();
  let createOrderCalls = 0;
  const methods: ExchangeAdapter = {
    getBalances: baseAdapter.getBalances.bind(baseAdapter),
    getOrderChance: baseAdapter.getOrderChance.bind(baseAdapter),
    async testOrder(request) {
      await options.beforeTestOrder?.();
      return baseAdapter.testOrder(request);
    },
    cancelOrder: baseAdapter.cancelOrder.bind(baseAdapter),
    getOrder: baseAdapter.getOrder.bind(baseAdapter),
    listOpenOrders: baseAdapter.listOpenOrders.bind(baseAdapter),
    listClosedOrders: baseAdapter.listClosedOrders.bind(baseAdapter),
    async createOrder(request) {
      createOrderCalls += 1;
      if (options.createOrderError) throw options.createOrderError;
      return baseAdapter.createOrder(request);
    },
  };
  if (options.sendPath === "LIVE_ADAPTER") {
    return {
      ...methods,
      sendPath: "LIVE_ADAPTER",
      get createOrderCalls() {
        return createOrderCalls;
      },
    };
  }
  return {
    ...methods,
    sendPath: "DRY_RUN_ADAPTER",
    get createOrderCalls() {
      return createOrderCalls;
    },
  };
}

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
  }));
  return nested.flat();
}
