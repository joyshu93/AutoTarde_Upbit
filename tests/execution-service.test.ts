import assert from "node:assert/strict";

import type { RuntimeOwnershipAuthority } from "../src/app/runtime-ownership-guard.js";
import type { ExecutionStateRecord, OrderRecord } from "../src/domain/types.js";
import { ExecutionService } from "../src/modules/execution/execution-service.js";
import type { SubmissionOutcome, SubmitOrderFromDecisionResult } from "../src/modules/execution/interfaces.js";
import {
  DryRunExchangeAdapter,
  type ExchangeAdapter,
  type ExecutionExchangeAdapter,
} from "../src/modules/exchange/interfaces.js";
import { InMemoryAccountExecutionLeaseStore } from "../src/modules/db/repositories/in-memory-account-execution-lease-store.js";
import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import { DurableTelegramReporter, type OperatorNotificationReporter } from "../src/modules/telegram/reporter.js";
import { test } from "./harness.js";

function createExecutionService(overrides?: {
  exchangeAdapter?: ExecutionExchangeAdapter;
  validationAdapter?: Pick<ExchangeAdapter, "getOrderChance" | "testOrder">;
  reporter?: OperatorNotificationReporter;
  runtimeOwnership?: RuntimeOwnershipAuthority;
  initialState?: Partial<ExecutionStateRecord>;
}) {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
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
    ...overrides?.initialState,
  });

  const serviceDependencies = {
    riskLimits: {
      maxAllocationByAsset: {
        BTC: 0.6,
        ETH: 0.6,
      },
      totalExposureCap: 0.75,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    executionAdapter: overrides?.exchangeAdapter ?? new DryRunExchangeAdapter(),
    repositories,
    accountExecutionLeases: new InMemoryAccountExecutionLeaseStore(),
    accountExecutionLeaseMs: 30_000,
    operatorState,
    runtimeOwnership: overrides?.runtimeOwnership ?? createAlwaysOwnedRuntimeOwnershipAuthority(
      operatorState,
      overrides?.initialState?.executionMode ?? "DRY_RUN",
    ),
    now: () => "2026-04-20T00:00:20.000Z",
    ...(overrides?.validationAdapter ? { validationAdapter: overrides.validationAdapter } : {}),
    ...(overrides?.reporter ? { reporter: overrides.reporter } : {}),
  };

  const service = new ExecutionService(serviceDependencies);

  return { service, repositories };
}

test("submission outcomes require an explicit discriminant", () => {
  const outcomes: SubmissionOutcome[] = [
    "SUBMITTED",
    "SIMULATED_FILLED",
    "REJECTED",
    "DUPLICATE",
    "LEASE_BLOCKED",
    "RECONCILIATION_REQUIRED",
  ];
  const result: SubmitOrderFromDecisionResult = {
    accepted: true,
    outcome: "SIMULATED_FILLED",
    order: {
      id: "order-1",
      strategyDecisionId: null,
      exchangeAccountId: "primary",
      market: "KRW-BTC",
      side: "bid",
      ordType: "limit",
      volume: "0.001",
      price: "100000000",
      timeInForce: null,
      smpType: null,
      identifier: "identifier-1",
      idempotencyKey: "idempotency-1",
      origin: "STRATEGY",
      requestedAt: "2026-04-20T00:00:00.000Z",
      upbitUuid: null,
      status: "FILLED",
      executionMode: "DRY_RUN",
      exchangeResponseJson: null,
      failureCode: null,
      failureMessage: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    },
    reason: null,
  };

  assert.equal(outcomes.length, 6);
  assert.equal(result.outcome, "SIMULATED_FILLED");
});

test("execution service rejects a non-canonical market-buy quote before persistence", async () => {
  const { service, repositories } = createExecutionService();

  await assert.rejects(
    () => service.submitOrderFromDecision({
      exchangeAccountId: "primary",
      strategyDecisionId: "decision-noncanonical-market-buy",
      referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
      decision: {
        strategyKey: "deterministic.stub.v1",
        market: "KRW-ETH",
        action: "ENTER",
        reasonCodes: ["NONCANONICAL_MARKET_BUY_TEST"],
        referencePrice: 3_438_000,
        requestedNotionalKrw: 9609.123456789,
        requestedQuantity: null,
        metadata: {},
      },
      side: "bid",
      ordType: "price",
      price: "9609.123456789",
      volume: null,
    }),
    /canonical decision notional/,
  );

  assert.deepEqual(await repositories.listOrders("primary"), []);
});

test("execution service binds market-buy wire material exactly to the decision", async () => {
  for (const material of [
    { price: "20000", volume: null, requestedNotionalKrw: 10_000 },
    { price: null, volume: null, requestedNotionalKrw: 10_000 },
    { price: "10000", volume: "0.1", requestedNotionalKrw: 10_000 },
    { price: "0", volume: null, requestedNotionalKrw: 0 },
  ] as const) {
    const { service, repositories } = createExecutionService();

    await assert.rejects(
      () => service.submitOrderFromDecision({
        exchangeAccountId: "primary",
        strategyDecisionId: "decision-market-buy-material",
        referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
        decision: {
          strategyKey: "deterministic.stub.v1",
          market: "KRW-ETH",
          action: "ENTER",
          reasonCodes: ["MARKET_BUY_MATERIAL_TEST"],
          referencePrice: 3_438_000,
          requestedNotionalKrw: material.requestedNotionalKrw,
          requestedQuantity: null,
          metadata: {},
        },
        side: "bid",
        ordType: "price",
        price: material.price,
        volume: material.volume,
      }),
      /market-buy quote/i,
    );

    assert.deepEqual(await repositories.listOrders("primary"), []);
  }
});

test("baseline final send requires its own exact persisted SUBMITTING intent", async () => {
  for (const mutation of ["MISSING", "TERMINAL", "IMMUTABLE"] as const) {
    const operatorState = new InMemoryOperatorStateStore({
      id: `baseline-final-state-${mutation}`,
      exchangeAccountId: "primary",
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      systemStatus: "RUNNING",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: null,
      degradedAt: null,
      updatedAt: "2026-04-20T00:00:00.000Z",
    });
    const repositories = new BaselineFinalAuthorityRepository(mutation);
    await repositories.saveBalanceSnapshot({
      id: `baseline-final-balance-${mutation}`,
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:00:00.000Z",
      source: "EXCHANGE_POLL",
      totalKrwValue: "10000000",
      balancesJson: "[]",
    });
    await repositories.savePositionSnapshot({
      id: `baseline-final-position-${mutation}`,
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:00:00.000Z",
      source: "EXCHANGE_POLL",
      positionsJson: "[]",
    });
    const adapter = countingLiveAdapter();
    const service = new ExecutionService({
      riskLimits: {
        maxAllocationByAsset: { BTC: 0.6, ETH: 0.6 },
        totalExposureCap: 0.75,
        stalePriceThresholdMs: 30_000,
        minimumOrderValueKrw: 5_000,
      },
      executionAdapter: adapter.adapter,
      validationAdapter: adapter.adapter,
      repositories,
      accountExecutionLeases: new InMemoryAccountExecutionLeaseStore(),
      accountExecutionLeaseMs: 30_000,
      operatorState,
      runtimeOwnership: createAlwaysOwnedRuntimeOwnershipAuthority(operatorState, "LIVE"),
      now: () => "2026-04-20T00:00:20.000Z",
    });

    await assert.rejects(
      () => service.submitOrderFromDecision({
        exchangeAccountId: "primary",
        strategyDecisionId: `baseline-final-decision-${mutation}`,
        referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
        decision: {
          strategyKey: "deterministic.stub.v1",
          market: "KRW-BTC",
          action: "ENTER",
          reasonCodes: ["BASELINE_FINAL_AUTHORITY_TEST"],
          referencePrice: 100_000_000,
          requestedNotionalKrw: 100_000,
          requestedQuantity: 0.001,
          metadata: {},
        },
        side: "bid",
        ordType: "limit",
        price: "100000000",
        volume: "0.001",
      }),
      /final pre-send authority|lease/i,
      mutation,
    );

    assert.equal(adapter.createOrderCalls(), 0, mutation);
    assert.equal((await operatorState.getState()).systemStatus, "PAUSED", mutation);
    assert.equal((await repositories.listOrders("primary"))[0]?.status, "SUBMITTING", mutation);
  }
});

test("execution service checks persisted runtime ownership at the final send boundary", async () => {
  const checkedAt: number[] = [];
  const runtimeOwnership: RuntimeOwnershipAuthority = {
    snapshot: () => ({
      status: "OWNED",
      generation: 7,
      executionMode: "DRY_RUN",
      acquiredAtEpochMs: 1,
      heartbeatAtEpochMs: 1,
      expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
      takeover: false,
      lossReason: null,
    }),
    assertLocallyHeld() {},
    async assertCurrent(atEpochMs) {
      checkedAt.push(atEpochMs);
      return {
        ownerToken: "owner".padEnd(64, "x"),
        generation: 7,
        executionMode: "DRY_RUN",
        acquiredAtEpochMs: 1,
        heartbeatAtEpochMs: 1,
        expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
      };
    },
    runWithCurrentExecutionAuthority(input, callback) {
      checkedAt.push(input.atEpochMs);
      callback();
      return Promise.resolve({
        runtimeOwnership: {
          ownerToken: "owner".padEnd(64, "x"),
          generation: 7,
          executionMode: "DRY_RUN",
          acquiredAtEpochMs: 1,
          heartbeatAtEpochMs: 1,
          expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
        },
        executionState: {
          exchangeAccountId: input.exchangeAccountId,
          executionMode: "DRY_RUN",
          liveExecutionGate: "DISABLED",
          systemStatus: "RUNNING",
          killSwitchActive: false,
        },
      });
    },
  };
  const { service, repositories } = createExecutionService({ runtimeOwnership });
  await repositories.saveBalanceSnapshot({
    id: "runtime-authority-balance",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "runtime-authority-position",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });

  const result = await service.submitOrderFromDecision({
    exchangeAccountId: "primary",
    strategyDecisionId: "runtime-authority-decision",
    referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-BTC",
      action: "ENTER",
      reasonCodes: ["RUNTIME_AUTHORITY_TEST"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 100_000,
      requestedQuantity: 0.001,
      metadata: {},
    },
    side: "bid",
    ordType: "limit",
    price: "100000000",
    volume: "0.001",
  });

  assert.equal(result.outcome, "SIMULATED_FILLED");
  assert.equal(checkedAt.length, 1);
  assert.equal(Number.isSafeInteger(checkedAt[0]), true);
});

test("execution service persists a dry-run order and blocks duplicate idempotent submissions", async () => {
  const { service, repositories } = createExecutionService();
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

  const input = {
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

  const first = await service.submitOrderFromDecision(input);
  assert.equal(first.accepted, true);
  assert.equal(first.order?.status, "FILLED");

  const activeOrders = await repositories.listActiveOrders("primary");
  const events = await repositories.listOrderEvents(first.order?.id ?? "");
  const fills = await repositories.listFills(first.order?.id);
  assert.equal(activeOrders.length, 0);
  assert.equal(events.at(-1)?.eventType, "ORDER_FILLED");
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.price, "100000000");
  assert.equal(fills[0]?.volume, "0.001");

  const second = await service.submitOrderFromDecision(input);
  assert.equal(second.accepted, false);
  assert.match(second.reason ?? "", /Duplicate order intent/);
});

test("direct terminal exchange fills persist only exchange-confirmed execution instants", async () => {
  const { service, repositories } = createExecutionService({
    exchangeAdapter: terminalLiveAdapter("2026-04-20T00:00:15.123456789Z"),
    initialState: { executionMode: "LIVE", liveExecutionGate: "ENABLED" },
  });
  await seedReadyExecutionAccount(repositories);

  const result = await service.submitOrderFromDecision(terminalLiveInput("present-timestamp"));
  const fills = await repositories.listFills(result.order?.id);

  assert.equal(result.order?.status, "FILLED");
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.executionTimestampProvenance, "EXCHANGE_FILL_CONFIRMED");
  assert.equal(fills[0]?.executionEpochNs, "1776643215123456789");
  assert.equal(fills[0]?.filledAt, "2026-04-20T00:00:15.123456789Z");
});

test("direct terminal exchange fills persist explicit unverified timestamp absence without a local fallback", async () => {
  const { service, repositories } = createExecutionService({
    exchangeAdapter: terminalLiveAdapter(null),
    initialState: { executionMode: "LIVE", liveExecutionGate: "ENABLED" },
  });
  await seedReadyExecutionAccount(repositories);

  const result = await service.submitOrderFromDecision(terminalLiveInput("missing-timestamp"));
  const fills = await repositories.listFills(result.order?.id);

  assert.equal(result.order?.status, "FILLED");
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.executionTimestampProvenance, "LEGACY_UNVERIFIED");
  assert.equal(fills[0]?.executionEpochNs, null);
  assert.equal(fills[0]?.filledAt, "");
  assert.notEqual(fills[0]?.filledAt, result.order?.updatedAt);
});

test("execution service settles dry-run price bids with a synthetic fill derived from reference price", async () => {
  const { service, repositories } = createExecutionService();
  await repositories.saveBalanceSnapshot({
    id: "balance-price-bid",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "position-price-bid",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });

  const result = await service.submitOrderFromDecision({
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-price-bid",
    referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-BTC",
      action: "ENTER",
      reasonCodes: ["PRICE_BID"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 100_000,
      requestedQuantity: null,
      metadata: {},
    },
    side: "bid",
    ordType: "price",
    price: "100000",
    volume: null,
  });

  const activeOrders = await repositories.listActiveOrders("primary");
  const fills = await repositories.listFills(result.order?.id);

  assert.equal(result.accepted, true);
  assert.equal(result.order?.status, "FILLED");
  assert.equal(activeOrders.length, 0);
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.price, "100000000");
  assert.equal(fills[0]?.volume, "0.001");
  assert.match(fills[0]?.rawPayloadJson ?? "", /SIMULATED_IMMEDIATE_FILL/);
});

test("execution service applies minimum order value to market asks using reference price and volume", async () => {
  let createOrderCalled = false;
  const baseAdapter = new DryRunExchangeAdapter();
  const exchangeAdapter: ExecutionExchangeAdapter = {
    sendPath: "DRY_RUN_ADAPTER",
    getBalances: baseAdapter.getBalances.bind(baseAdapter),
    getOrderChance: baseAdapter.getOrderChance.bind(baseAdapter),
    testOrder: baseAdapter.testOrder.bind(baseAdapter),
    cancelOrder: baseAdapter.cancelOrder.bind(baseAdapter),
    getOrder: baseAdapter.getOrder.bind(baseAdapter),
    listOpenOrders: baseAdapter.listOpenOrders.bind(baseAdapter),
    listClosedOrders: baseAdapter.listClosedOrders.bind(baseAdapter),
    async createOrder(request) {
      createOrderCalled = true;
      return baseAdapter.createOrder(request);
    },
  };
  const { service, repositories } = createExecutionService({
    exchangeAdapter,
  });
  await repositories.saveBalanceSnapshot({
    id: "balance-small-ask",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "position-small-ask",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: JSON.stringify([
      {
        asset: "BTC",
        market: "KRW-BTC",
        quantity: "0.00001000",
        averageEntryPrice: "100000000",
        markPrice: "100000000",
        marketValue: "1000",
        exposureRatio: "0.0001",
        capturedAt: "2026-04-20T00:00:00.000Z",
      },
    ]),
  });

  const result = await service.submitOrderFromDecision({
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-small-ask",
    referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-BTC",
      action: "EXIT",
      reasonCodes: ["SMALL_EXIT"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: null,
      requestedQuantity: 0.00001,
      metadata: {},
    },
    side: "ask",
    ordType: "market",
    price: null,
    volume: "0.00001",
  });

  const orders = await repositories.listOrders("primary");
  const riskEvents = await repositories.listRiskEvents("primary");

  assert.equal(result.accepted, false);
  assert.match(result.reason ?? "", /below the configured minimum/);
  assert.equal(createOrderCalled, false);
  assert.equal(orders.length, 0);
  assert.equal(riskEvents.length, 1);
  assert.equal(riskEvents[0]?.ruleCode, "MINIMUM_ORDER_VALUE_GUARD");
});

test("execution service rejects a stale strategy reference price while accepting a fresh one", async () => {
  const { service, repositories } = createExecutionService();
  await repositories.saveBalanceSnapshot({
    id: "balance-price-freshness",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:10.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "position-price-freshness",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:10.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });

  const staleInput = {
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-stale-reference-price",
    referencePriceCapturedAt: "2026-04-19T23:59:00.000Z",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-BTC" as const,
      action: "ENTER" as const,
      reasonCodes: ["STALE_REFERENCE_PRICE"],
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
  const freshInput = {
    ...staleInput,
    strategyDecisionId: "decision-fresh-reference-price",
    referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
  };

  const staleResult = await service.submitOrderFromDecision(staleInput);
  const freshResult = await service.submitOrderFromDecision(freshInput);
  const orders = await repositories.listOrders("primary");
  const riskEvents = await repositories.listRiskEvents("primary");

  assert.equal(staleResult.accepted, false);
  assert.equal(staleResult.order, null);
  assert.equal(freshResult.accepted, true);
  assert.equal(orders.length, 1);
  assert.equal(orders[0]?.strategyDecisionId, "decision-fresh-reference-price");
  assert.equal(riskEvents.length, 1);
  assert.equal(riskEvents[0]?.strategyDecisionId, "decision-stale-reference-price");
  assert.equal(riskEvents[0]?.ruleCode, "STALE_PRICE_GUARD");
});

test("execution service blocks new orders when startup recovery has left the system DEGRADED", async () => {
  const { service, repositories } = createExecutionService({
    initialState: {
      systemStatus: "DEGRADED",
      degradedReason: "startup_portfolio_drift_detected",
      degradedAt: "2026-04-20T00:00:00.000Z",
    },
  });
  await repositories.saveBalanceSnapshot({
    id: "balance-degraded",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "position-degraded",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });

  const result = await service.submitOrderFromDecision({
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-degraded",
    referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-BTC",
      action: "ENTER",
      reasonCodes: ["DEGRADED"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 100_000,
      requestedQuantity: 0.001,
      metadata: {},
    },
    side: "bid",
    ordType: "limit",
    price: "100000000",
    volume: "0.001",
  });
  const riskEvents = await repositories.listRiskEvents("primary");

  assert.equal(result.accepted, false);
  assert.match(result.reason ?? "", /DEGRADED/i);
  assert.equal(riskEvents.length, 1);
  assert.equal(riskEvents[0]?.ruleCode, "SYSTEM_DEGRADED");
});

test("execution service blocks order persistence when order chance rejects the requested order type", async () => {
  let createOrderCalled = false;
  const exchangeAdapter: ExecutionExchangeAdapter = {
    sendPath: "DRY_RUN_ADAPTER",
    async getBalances() {
      return [];
    },
    async getOrderChance() {
      return {
        marketId: "KRW-BTC",
        askTypes: ["limit"],
        bidTypes: ["limit"],
        maxTotal: null,
        bidMinTotal: 5000,
        askMinTotal: 5000,
        bidFee: "0",
        askFee: "0",
      };
    },
    async testOrder() {
      return {
        accepted: true,
        marketOnline: true,
        reason: null,
        preview: null,
      };
    },
    async createOrder() {
      createOrderCalled = true;
      throw new Error("createOrder should not be called when precheck fails.");
    },
    async cancelOrder() {
      return {
        accepted: false,
        canceledOrder: null,
        reason: "not-used",
      };
    },
    async getOrder() {
      return null;
    },
    async listOpenOrders() {
      return [];
    },
    async listClosedOrders() {
      return [];
    },
  };
  const { service, repositories } = createExecutionService({
    exchangeAdapter,
    validationAdapter: exchangeAdapter,
  });

  await repositories.saveBalanceSnapshot({
    id: "balance-unsupported-type",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "position-unsupported-type",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });

  const result = await service.submitOrderFromDecision({
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-unsupported-type",
    referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-BTC",
      action: "ENTER",
      reasonCodes: ["PRECHECK"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 100_000,
      requestedQuantity: 0.001,
      metadata: {},
    },
    side: "bid",
    ordType: "price",
    price: "100000",
    volume: null,
  });

  const orders = await repositories.listOrders("primary");
  const riskEvents = await repositories.listRiskEvents("primary");
  const payload = JSON.parse(riskEvents[0]?.payloadJson ?? "{}") as Record<string, unknown>;

  assert.equal(result.accepted, false);
  assert.equal(result.order, null);
  assert.match(result.reason ?? "", /does not allow price orders/);
  assert.equal(createOrderCalled, false);
  assert.equal(orders.length, 0);
  assert.equal(riskEvents.length, 1);
  assert.equal(riskEvents[0]?.ruleCode, "UNSUPPORTED_ORDER_TYPE");
  assert.equal(payload.market, "KRW-BTC");
  assert.equal(payload.side, "bid");
  assert.equal(payload.ordType, "price");
  assert.equal(payload.stage, "getOrderChance");
  assert.equal(typeof payload.idempotencyKey, "string");
});

test("execution service queues an operator notification when an order is rejected before submission", async () => {
  const exchangeAdapter: ExecutionExchangeAdapter = {
    sendPath: "DRY_RUN_ADAPTER",
    async getBalances() {
      return [];
    },
    async getOrderChance() {
      return {
        marketId: "KRW-BTC",
        askTypes: ["limit"],
        bidTypes: ["limit"],
        maxTotal: null,
        bidMinTotal: 5000,
        askMinTotal: 5000,
        bidFee: "0",
        askFee: "0",
      };
    },
    async testOrder() {
      return {
        accepted: true,
        marketOnline: true,
        reason: null,
        preview: null,
      };
    },
    async createOrder() {
      throw new Error("createOrder should not be called when precheck fails.");
    },
    async cancelOrder() {
      return {
        accepted: false,
        canceledOrder: null,
        reason: "not-used",
      };
    },
    async getOrder() {
      return null;
    },
    async listOpenOrders() {
      return [];
    },
    async listClosedOrders() {
      return [];
    },
  };
  const repositories = new InMemoryExecutionRepository();
  const reporter = new DurableTelegramReporter({ repositories });
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-notification-1",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const service = new ExecutionService({
    riskLimits: {
      maxAllocationByAsset: {
        BTC: 0.6,
        ETH: 0.6,
      },
      totalExposureCap: 0.75,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    executionAdapter: exchangeAdapter,
    validationAdapter: exchangeAdapter,
    repositories,
    accountExecutionLeases: new InMemoryAccountExecutionLeaseStore(),
    accountExecutionLeaseMs: 30_000,
    operatorState,
    runtimeOwnership: createAlwaysOwnedRuntimeOwnershipAuthority(operatorState),
    reporter,
    now: () => "2026-04-20T00:00:20.000Z",
  });

  await repositories.saveBalanceSnapshot({
    id: "balance-notification-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "position-notification-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });

  await service.submitOrderFromDecision({
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-notification-1",
    referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-BTC",
      action: "ENTER",
      reasonCodes: ["PRECHECK"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 100_000,
      requestedQuantity: 0.001,
      metadata: {},
    },
    side: "bid",
    ordType: "price",
    price: "100000",
    volume: null,
  });

  const notifications = await repositories.listOperatorNotifications("primary");

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.notificationType, "ORDER_REJECTED");
  assert.equal(notifications[0]?.deliveryStatus, "PENDING");
  assert.match(notifications[0]?.message ?? "", /does not allow price orders/);
});

test("execution service blocks order persistence when exchange order test reports market offline", async () => {
  let createOrderCalled = false;
  const exchangeAdapter: ExecutionExchangeAdapter = {
    sendPath: "DRY_RUN_ADAPTER",
    async getBalances() {
      return [];
    },
    async getOrderChance() {
      return {
        marketId: "KRW-ETH",
        askTypes: ["limit"],
        bidTypes: ["limit", "price"],
        maxTotal: null,
        bidMinTotal: 5000,
        askMinTotal: 5000,
        bidFee: "0",
        askFee: "0",
      };
    },
    async testOrder() {
      return {
        accepted: false,
        marketOnline: false,
        reason: "market_offline",
        preview: null,
      };
    },
    async createOrder() {
      createOrderCalled = true;
      throw new Error("createOrder should not be called when order test fails.");
    },
    async cancelOrder() {
      return {
        accepted: false,
        canceledOrder: null,
        reason: "not-used",
      };
    },
    async getOrder() {
      return null;
    },
    async listOpenOrders() {
      return [];
    },
    async listClosedOrders() {
      return [];
    },
  };
  const { service, repositories } = createExecutionService({
    exchangeAdapter,
    validationAdapter: exchangeAdapter,
  });

  await repositories.saveBalanceSnapshot({
    id: "balance-market-offline",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "position-market-offline",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });

  const result = await service.submitOrderFromDecision({
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-market-offline",
    referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-ETH",
      action: "ENTER",
      reasonCodes: ["PRECHECK"],
      referencePrice: 3_000_000,
      requestedNotionalKrw: 100_000,
      requestedQuantity: 0.03,
      metadata: {},
    },
    side: "bid",
    ordType: "limit",
    price: "3000000",
    volume: "0.03",
  });

  const orders = await repositories.listOrders("primary");
  const riskEvents = await repositories.listRiskEvents("primary");

  assert.equal(result.accepted, false);
  assert.equal(result.order, null);
  assert.match(result.reason ?? "", /market_offline/);
  assert.equal(createOrderCalled, false);
  assert.equal(orders.length, 0);
  assert.equal(riskEvents.length, 1);
  assert.equal(riskEvents[0]?.ruleCode, "MARKET_OFFLINE");
});

test("execution service blocks price orders below the exchange min total before persistence", async () => {
  let createOrderCalled = false;
  const exchangeAdapter: ExecutionExchangeAdapter = {
    sendPath: "DRY_RUN_ADAPTER",
    async getBalances() {
      return [];
    },
    async getOrderChance() {
      return {
        marketId: "KRW-BTC",
        askTypes: ["limit"],
        bidTypes: ["limit", "price"],
        maxTotal: null,
        bidMinTotal: 10000,
        askMinTotal: 5000,
        bidFee: "0",
        askFee: "0",
      };
    },
    async testOrder() {
      return {
        accepted: true,
        marketOnline: true,
        reason: null,
        preview: null,
      };
    },
    async createOrder() {
      createOrderCalled = true;
      throw new Error("createOrder should not be called when exchange min total blocks the order.");
    },
    async cancelOrder() {
      return {
        accepted: false,
        canceledOrder: null,
        reason: "not-used",
      };
    },
    async getOrder() {
      return null;
    },
    async listOpenOrders() {
      return [];
    },
    async listClosedOrders() {
      return [];
    },
  };
  const { service, repositories } = createExecutionService({
    exchangeAdapter,
    validationAdapter: exchangeAdapter,
  });

  await repositories.saveBalanceSnapshot({
    id: "balance-min-total",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "position-min-total",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });

  const result = await service.submitOrderFromDecision({
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-min-total",
    referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-BTC",
      action: "ENTER",
      reasonCodes: ["PRECHECK"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 7_000,
      requestedQuantity: null,
      metadata: {},
    },
    side: "bid",
    ordType: "price",
    price: "7000",
    volume: null,
  });

  const orders = await repositories.listOrders("primary");
  const riskEvents = await repositories.listRiskEvents("primary");

  assert.equal(result.accepted, false);
  assert.equal(result.order, null);
  assert.match(result.reason ?? "", /below exchange min total/i);
  assert.equal(createOrderCalled, false);
  assert.equal(orders.length, 0);
  assert.equal(riskEvents.length, 1);
  assert.equal(riskEvents[0]?.ruleCode, "EXCHANGE_MIN_TOTAL_GUARD");
});

test("execution service records lifecycle evidence from the live execution adapter", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-2",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const service = new ExecutionService({
    riskLimits: {
      maxAllocationByAsset: {
        BTC: 0.6,
        ETH: 0.6,
      },
      totalExposureCap: 0.75,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    executionAdapter: createLiveExecutionAdapter(),
    repositories,
    accountExecutionLeases: new InMemoryAccountExecutionLeaseStore(),
    accountExecutionLeaseMs: 30_000,
    operatorState,
    runtimeOwnership: createAlwaysOwnedRuntimeOwnershipAuthority(operatorState, "LIVE"),
    now: () => "2026-04-20T00:00:20.000Z",
  });

  await repositories.saveBalanceSnapshot({
    id: "balance-2",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "position-2",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });

  const result = await service.submitOrderFromDecision({
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-2",
    referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-ETH",
      action: "ENTER",
      reasonCodes: ["STATE_MODE"],
      referencePrice: 3_000_000,
      requestedNotionalKrw: 100_000,
      requestedQuantity: 0.03,
      metadata: {},
    },
    side: "bid",
    ordType: "limit",
    price: "3000000",
    volume: "0.03",
  });

  const events = await repositories.listOrderEvents(result.order?.id ?? "");
  const fills = await repositories.listFills(result.order?.id);

  assert.equal(result.accepted, true);
  assert.equal(result.order?.executionMode, "LIVE");
  assert.equal(result.order?.status, "OPEN");
  assert.equal(events.some((event) => event.eventType === "ORDER_FILLED"), false);
  assert.equal(fills.length, 0);
});

class BaselineFinalAuthorityRepository extends InMemoryExecutionRepository {
  private finalReadsArmed = false;

  constructor(private readonly mutation: "MISSING" | "TERMINAL" | "IMMUTABLE") {
    super();
  }

  override async updateOrder(record: OrderRecord): Promise<void> {
    await super.updateOrder(record);
    if (record.status === "SUBMITTING") this.finalReadsArmed = true;
  }

  override async listActiveOrders(
    exchangeAccountId: string,
    market?: "KRW-BTC" | "KRW-ETH",
    limit?: number,
  ): Promise<OrderRecord[]> {
    const orders = await super.listActiveOrders(exchangeAccountId, market, limit);
    if (!this.finalReadsArmed) return orders;
    if (this.mutation === "MISSING") return [];
    return orders.map((order) => this.mutation === "TERMINAL"
      ? { ...order, status: "FILLED" }
      : { ...order, price: "99999999" });
  }

  override async findOrderById(exchangeAccountId: string, orderId: string): Promise<OrderRecord | null> {
    const order = await super.findOrderById(exchangeAccountId, orderId);
    if (!this.finalReadsArmed || !order) return order;
    if (this.mutation === "MISSING") return null;
    return this.mutation === "TERMINAL"
      ? { ...order, status: "FILLED" }
      : { ...order, price: "99999999" };
  }
}

function countingLiveAdapter(): Readonly<{
  adapter: ExecutionExchangeAdapter;
  createOrderCalls(): number;
}> {
  const baseAdapter = new DryRunExchangeAdapter();
  let calls = 0;
  return {
    adapter: {
      sendPath: "LIVE_ADAPTER",
      getBalances: baseAdapter.getBalances.bind(baseAdapter),
      getOrderChance: baseAdapter.getOrderChance.bind(baseAdapter),
      testOrder: baseAdapter.testOrder.bind(baseAdapter),
      async createOrder(request) {
        calls += 1;
        return baseAdapter.createOrder(request);
      },
      cancelOrder: baseAdapter.cancelOrder.bind(baseAdapter),
      getOrder: baseAdapter.getOrder.bind(baseAdapter),
      listOpenOrders: baseAdapter.listOpenOrders.bind(baseAdapter),
      listClosedOrders: baseAdapter.listClosedOrders.bind(baseAdapter),
    },
    createOrderCalls: () => calls,
  };
}

function createAlwaysOwnedRuntimeOwnershipAuthority(
  operatorState: InMemoryOperatorStateStore,
  executionMode: "DRY_RUN" | "LIVE" = "DRY_RUN",
): RuntimeOwnershipAuthority {
  const record = {
    ownerToken: "owner".padEnd(64, "x"),
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

function createLiveExecutionAdapter(): ExecutionExchangeAdapter {
  const baseAdapter = new DryRunExchangeAdapter();
  return {
    sendPath: "LIVE_ADAPTER",
    getBalances: baseAdapter.getBalances.bind(baseAdapter),
    getOrderChance: baseAdapter.getOrderChance.bind(baseAdapter),
    testOrder: baseAdapter.testOrder.bind(baseAdapter),
    createOrder: baseAdapter.createOrder.bind(baseAdapter),
    cancelOrder: baseAdapter.cancelOrder.bind(baseAdapter),
    getOrder: baseAdapter.getOrder.bind(baseAdapter),
    listOpenOrders: baseAdapter.listOpenOrders.bind(baseAdapter),
    listClosedOrders: baseAdapter.listClosedOrders.bind(baseAdapter),
  };
}

function terminalLiveAdapter(fillCreatedAt: string | null): ExecutionExchangeAdapter {
  const baseAdapter = new DryRunExchangeAdapter();
  return {
    sendPath: "LIVE_ADAPTER",
    getBalances: baseAdapter.getBalances.bind(baseAdapter),
    getOrderChance: baseAdapter.getOrderChance.bind(baseAdapter),
    testOrder: baseAdapter.testOrder.bind(baseAdapter),
    async createOrder(request) {
      return {
        uuid: `terminal-${request.identifier}`,
        identifier: request.identifier,
        market: request.market,
        side: request.side,
        ordType: request.ordType,
        state: "done",
        price: request.price,
        volume: request.volume,
        remainingVolume: "0",
        executedVolume: request.volume,
        paidFee: "500",
        createdAt: "2026-04-20T00:00:14.000Z",
        fills: [{
          tradeUuid: `trade-${request.identifier}`,
          side: request.side,
          price: request.price ?? "100000000",
          volume: request.volume ?? "0.001",
          funds: "100000",
          fee: "500",
          createdAt: fillCreatedAt,
          raw: { fillCreatedAt },
        }],
        raw: { terminal: true, fillCreatedAt },
      };
    },
    cancelOrder: baseAdapter.cancelOrder.bind(baseAdapter),
    getOrder: baseAdapter.getOrder.bind(baseAdapter),
    listOpenOrders: baseAdapter.listOpenOrders.bind(baseAdapter),
    listClosedOrders: baseAdapter.listClosedOrders.bind(baseAdapter),
  };
}

function terminalLiveInput(id: string) {
  return {
    exchangeAccountId: "primary",
    strategyDecisionId: `decision-${id}`,
    referencePriceCapturedAt: "2026-04-20T00:00:10.000Z",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-BTC" as const,
      action: "ENTER" as const,
      reasonCodes: ["TERMINAL_FILL_TIMESTAMP"],
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

async function seedReadyExecutionAccount(repositories: InMemoryExecutionRepository): Promise<void> {
  await repositories.saveBalanceSnapshot({
    id: "terminal-fill-balance",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "terminal-fill-position",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });
}
