import assert from "node:assert/strict";

import type { ExecutionStateRecord } from "../src/domain/types.js";
import { ExecutionService } from "../src/modules/execution/execution-service.js";
import { DryRunExchangeAdapter, type ExchangeAdapter } from "../src/modules/exchange/interfaces.js";
import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import { DurableTelegramReporter, type OperatorNotificationReporter } from "../src/modules/telegram/reporter.js";
import { test } from "./harness.js";

function createExecutionService(overrides?: {
  exchangeAdapter?: ExchangeAdapter;
  validationAdapter?: Pick<ExchangeAdapter, "getOrderChance" | "testOrder">;
  reporter?: OperatorNotificationReporter;
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
    exchangeAdapter: overrides?.exchangeAdapter ?? new DryRunExchangeAdapter(),
    repositories,
    operatorState,
    ...(overrides?.validationAdapter ? { validationAdapter: overrides.validationAdapter } : {}),
    ...(overrides?.reporter ? { reporter: overrides.reporter } : {}),
  };

  const service = new ExecutionService(serviceDependencies);

  return { service, repositories };
}

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
  assert.equal(first.order?.status, "OPEN");

  const second = await service.submitOrderFromDecision(input);
  assert.equal(second.accepted, false);
  assert.match(second.reason ?? "", /Duplicate order intent/);
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
  const exchangeAdapter: ExchangeAdapter = {
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
  const exchangeAdapter: ExchangeAdapter = {
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
    exchangeAdapter,
    validationAdapter: exchangeAdapter,
    repositories,
    operatorState,
    reporter,
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
  const exchangeAdapter: ExchangeAdapter = {
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
  const exchangeAdapter: ExchangeAdapter = {
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
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-BTC",
      action: "ENTER",
      reasonCodes: ["PRECHECK"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: null,
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

test("execution service records order mode from persisted operator state", async () => {
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
    exchangeAdapter: new DryRunExchangeAdapter(),
    repositories,
    operatorState,
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

  assert.equal(result.accepted, true);
  assert.equal(result.order?.executionMode, "LIVE");
});
