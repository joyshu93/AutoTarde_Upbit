import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { ExecutionStateRecord } from "../src/domain/types.js";
import { ExecutionService } from "../src/modules/execution/execution-service.js";
import { ExchangeOrderSubmissionError } from "../src/modules/exchange/errors.js";
import { DryRunExchangeAdapter, type ExchangeAdapter } from "../src/modules/exchange/interfaces.js";
import { InMemoryAccountExecutionLeaseStore } from "../src/modules/db/repositories/in-memory-account-execution-lease-store.js";
import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import { test } from "./harness.js";

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
});

async function createService(overrides: {
  exchangeAdapter?: ExchangeAdapter;
  accountExecutionLeases?: InMemoryAccountExecutionLeaseStore;
  repositories?: InMemoryExecutionRepository;
} = {}) {
  const repositories = overrides.repositories ?? new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore(createRunningState());
  const accountExecutionLeases = overrides.accountExecutionLeases ?? new InMemoryAccountExecutionLeaseStore();
  const service = new ExecutionService({
    riskLimits: {
      maxAllocationByAsset: { BTC: 0.6, ETH: 0.6 },
      totalExposureCap: 0.75,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    exchangeAdapter: overrides.exchangeAdapter ?? new DryRunExchangeAdapter(),
    repositories,
    accountExecutionLeases,
    accountExecutionLeaseMs: 30_000,
    operatorState,
    now: () => "2026-04-20T00:00:20.000Z",
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

function createRunningState(): ExecutionStateRecord {
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

function createCountingAdapter(options: { createOrderError?: Error } = {}) {
  const baseAdapter = new DryRunExchangeAdapter();
  let createOrderCalls = 0;
  const adapter: ExchangeAdapter & { readonly createOrderCalls: number } = {
    get createOrderCalls() {
      return createOrderCalls;
    },
    getBalances: baseAdapter.getBalances.bind(baseAdapter),
    getOrderChance: baseAdapter.getOrderChance.bind(baseAdapter),
    testOrder: baseAdapter.testOrder.bind(baseAdapter),
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
  return adapter;
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
