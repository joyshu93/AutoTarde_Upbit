import assert from "node:assert/strict";

import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import { ReconciliationService } from "../src/modules/reconciliation/reconciliation-service.js";
import { DurableTelegramReporter } from "../src/modules/telegram/reporter.js";
import { test } from "./harness.js";

test("reconciliation service updates active orders from exchange state and captures fills", async () => {
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
  });
  await repositories.saveOrder({
    id: "order-1",
    strategyDecisionId: "decision-1",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "limit",
    volume: "0.01",
    price: "100000000",
    timeInForce: null,
    smpType: null,
    identifier: "identifier-1",
    idempotencyKey: "idem-1",
    origin: "STRATEGY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: "uuid-1",
    status: "OPEN",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const service = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        return {
          uuid: "uuid-1",
          identifier: "identifier-1",
          market: "KRW-BTC",
          side: "bid",
          ordType: "limit",
          state: "done",
          price: "100000000",
          volume: "0.01",
          remainingVolume: "0",
          executedVolume: "0.01",
          paidFee: "500",
          createdAt: "2026-04-20T00:00:00.000Z",
          fills: [
            {
              tradeUuid: "trade-1",
              side: "bid",
              price: "100000000",
              volume: "0.01",
              funds: "1000000",
              fee: "500",
              createdAt: "2026-04-20T00:01:00.000Z",
              raw: {
                tradeUuid: "trade-1",
              },
            },
          ],
          raw: {
            state: "done",
          },
        };
      },
    },
  });

  const summary = await service.run("primary");
  const orders = await repositories.listOrders("primary");
  const fills = await repositories.listFills("order-1");

  assert.equal(summary.status, "DRIFT_DETECTED");
  assert.equal(summary.source, "DIRECT_RUN");
  assert.equal(summary.candidateCount, 1);
  assert.equal(summary.processedCount, 1);
  assert.equal(summary.deferredCount, 0);
  assert.equal(summary.maxOrderLookupsPerRun, 10);
  assert.deepEqual(summary.issues, [
    {
      code: "ORDER_STATUS_RECONCILED",
      message: "Order order-1 reconciled from OPEN to FILLED using exchange state done.",
    },
    {
      code: "ORDER_FILLS_BACKFILLED",
      message: "Backfilled 1 fill(s) for order order-1 from exchange snapshot.",
    },
  ]);
  assert.equal(orders[0]?.status, "FILLED");
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.exchangeFillId, "trade-1");
});

test("reconciliation service backfills fills for terminal orders during sync", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-3",
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
  await repositories.saveOrder({
    id: "order-3",
    strategyDecisionId: "decision-3",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "limit",
    volume: "0.02",
    price: "100000000",
    timeInForce: null,
    smpType: null,
    identifier: "identifier-3",
    idempotencyKey: "idem-3",
    origin: "STRATEGY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: "uuid-3",
    status: "FILLED",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const service = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        return {
          uuid: "uuid-3",
          identifier: "identifier-3",
          market: "KRW-BTC",
          side: "bid",
          ordType: "limit",
          state: "done",
          price: "100000000",
          volume: "0.02",
          remainingVolume: "0",
          executedVolume: "0.02",
          paidFee: "1000",
          createdAt: "2026-04-20T00:00:00.000Z",
          fills: [
            {
              tradeUuid: "trade-3",
              side: "bid",
              price: "100000000",
              volume: "0.02",
              funds: "2000000",
              fee: "1000",
              createdAt: "2026-04-20T00:02:00.000Z",
              raw: {
                tradeUuid: "trade-3",
              },
            },
          ],
          raw: {
            state: "done",
          },
        };
      },
    },
  });

  const summary = await service.run("primary");
  const orders = await repositories.listOrders("primary");
  const fills = await repositories.listFills("order-3");

  assert.equal(summary.status, "DRIFT_DETECTED");
  assert.equal(summary.source, "DIRECT_RUN");
  assert.deepEqual(summary.issues, [
    {
      code: "TERMINAL_ORDER_RECHECKED",
      message: "Terminal order order-3 was rechecked against exchange state done.",
    },
    {
      code: "ORDER_FILLS_BACKFILLED",
      message: "Backfilled 1 fill(s) for order order-3 from exchange snapshot.",
    },
  ]);
  assert.equal(orders[0]?.status, "FILLED");
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.exchangeFillId, "trade-3");
});

test("reconciliation service queues an operator notification when drift is detected", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-operator-notification",
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
  await repositories.saveOrder({
    id: "order-operator-notification",
    strategyDecisionId: "decision-operator-notification",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "limit",
    volume: "0.01",
    price: "100000000",
    timeInForce: null,
    smpType: null,
    identifier: "identifier-operator-notification",
    idempotencyKey: "idem-operator-notification",
    origin: "STRATEGY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: "uuid-operator-notification",
    status: "OPEN",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const service = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        return {
          uuid: "uuid-operator-notification",
          identifier: "identifier-operator-notification",
          market: "KRW-BTC",
          side: "bid",
          ordType: "limit",
          state: "done",
          price: "100000000",
          volume: "0.01",
          remainingVolume: "0",
          executedVolume: "0.01",
          paidFee: "500",
          createdAt: "2026-04-20T00:00:00.000Z",
          fills: [],
          raw: {
            state: "done",
          },
        };
      },
    },
    reporter: new DurableTelegramReporter({ repositories }),
  });

  await service.run("primary");
  const notifications = await repositories.listOperatorNotifications("primary");

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.notificationType, "RECONCILIATION_DRIFT_DETECTED");
  assert.equal(notifications[0]?.severity, "WARN");
  assert.match(notifications[0]?.message ?? "", /Detected 1 reconciliation issue/);
});

test("reconciliation service marks active orders for recovery when exchange lookup fails", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-2",
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
  await repositories.saveOrder({
    id: "order-2",
    strategyDecisionId: "decision-2",
    exchangeAccountId: "primary",
    market: "KRW-ETH",
    side: "bid",
    ordType: "limit",
    volume: "0.1",
    price: "3000000",
    timeInForce: null,
    smpType: null,
    identifier: "identifier-2",
    idempotencyKey: "idem-2",
    origin: "STRATEGY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: "uuid-2",
    status: "OPEN",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const service = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        throw new Error("exchange lookup failed");
      },
    },
  });

  const summary = await service.run("primary");
  const orders = await repositories.listOrders("primary");
  const riskEvents = await repositories.listRiskEvents("primary");

  assert.equal(summary.status, "DRIFT_DETECTED");
  assert.equal(summary.source, "DIRECT_RUN");
  assert.equal(summary.issues.length, 1);
  assert.equal(summary.issues[0]?.code, "ORDER_MARKED_FOR_RECOVERY");
  assert.match(summary.issues[0]?.message ?? "", /exchange lookup failed/);
  assert.equal(orders[0]?.status, "RECONCILIATION_REQUIRED");
  assert.equal(riskEvents.length, 1);
  assert.equal(riskEvents[0]?.ruleCode, "ORDER_RECOVERY_REQUIRED");
});

test("reconciliation service rechecks failed terminal orders with exchange references during recovery sweep", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-4",
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
  await repositories.saveOrder({
    id: "order-4",
    strategyDecisionId: "decision-4",
    exchangeAccountId: "primary",
    market: "KRW-ETH",
    side: "bid",
    ordType: "limit",
    volume: "0.1",
    price: "3000000",
    timeInForce: null,
    smpType: null,
    identifier: "identifier-4",
    idempotencyKey: "idem-4",
    origin: "RECOVERY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: "uuid-4",
    status: "FAILED",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: "EXCHANGE_SUBMISSION_FAILED",
    failureMessage: "Submission failed before local confirmation.",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const service = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        return {
          uuid: "uuid-4",
          identifier: "identifier-4",
          market: "KRW-ETH",
          side: "bid",
          ordType: "limit",
          state: "done",
          price: "3000000",
          volume: "0.1",
          remainingVolume: "0",
          executedVolume: "0.1",
          paidFee: "150",
          createdAt: "2026-04-20T00:00:00.000Z",
          fills: [],
          raw: {
            state: "done",
          },
        };
      },
    },
  });

  const summary = await service.run("primary");
  const orders = await repositories.listOrders("primary");

  assert.equal(summary.status, "DRIFT_DETECTED");
  assert.equal(summary.source, "DIRECT_RUN");
  assert.deepEqual(summary.issues, [
    {
      code: "TERMINAL_ORDER_RECHECKED",
      message: "Terminal order order-4 was rechecked against exchange state done.",
    },
    {
      code: "ORDER_STATUS_RECONCILED",
      message: "Order order-4 reconciled from FAILED to FILLED using exchange state done.",
    },
  ]);
  assert.equal(orders[0]?.status, "FILLED");
  assert.match(orders[0]?.exchangeResponseJson ?? "", /"state":"done"/);
});

test("reconciliation service treats absent FAILED exchange orders as confirmed terminal absence", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-5",
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
  await repositories.saveOrder({
    id: "order-5",
    strategyDecisionId: "decision-5",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "limit",
    volume: "0.01",
    price: "100000000",
    timeInForce: null,
    smpType: null,
    identifier: "identifier-5",
    idempotencyKey: "idem-5",
    origin: "RECOVERY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: "uuid-5",
    status: "FAILED",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: "EXCHANGE_SUBMISSION_FAILED",
    failureMessage: "Submission failed.",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const service = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        return null;
      },
    },
  });

  const summary = await service.run("primary");
  const orders = await repositories.listOrders("primary");
  const riskEvents = await repositories.listRiskEvents("primary");

  assert.equal(summary.status, "DRIFT_DETECTED");
  assert.deepEqual(summary.issues, [
    {
      code: "TERMINAL_ORDER_CONFIRMED_ABSENT",
      message: "Terminal order order-5 was confirmed absent on exchange during reconciliation.",
    },
  ]);
  assert.equal(orders[0]?.status, "FAILED");
  assert.equal(orders[0]?.failureCode, "TERMINAL_ORDER_CONFIRMED_ABSENT");
  assert.equal(riskEvents.length, 0);
});

test("reconciliation service records transient lookup failures without forcing recovery status", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-6",
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
  await repositories.saveOrder({
    id: "order-6",
    strategyDecisionId: "decision-6",
    exchangeAccountId: "primary",
    market: "KRW-ETH",
    side: "bid",
    ordType: "limit",
    volume: "0.1",
    price: "3000000",
    timeInForce: null,
    smpType: null,
    identifier: "identifier-6",
    idempotencyKey: "idem-6",
    origin: "STRATEGY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: "uuid-6",
    status: "OPEN",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const service = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        throw new Error("429 Too Many Requests");
      },
    },
  });

  const summary = await service.run("primary");
  const orders = await repositories.listOrders("primary");
  const riskEvents = await repositories.listRiskEvents("primary");

  assert.equal(summary.status, "DRIFT_DETECTED");
  assert.deepEqual(summary.issues, [
    {
      code: "ORDER_LOOKUP_TRANSIENT_FAILURE",
      message: "Transient exchange lookup failure for order order-6. 429 Too Many Requests",
    },
  ]);
  assert.equal(orders[0]?.status, "OPEN");
  assert.equal(riskEvents.length, 0);
});

test("reconciliation service defers lower-priority lookups when the per-run budget is exhausted", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-7",
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
  await repositories.saveOrder({
    id: "order-7a",
    strategyDecisionId: "decision-7a",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "limit",
    volume: "0.01",
    price: "100000000",
    timeInForce: null,
    smpType: null,
    identifier: "identifier-7a",
    idempotencyKey: "idem-7a",
    origin: "STRATEGY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: "uuid-7a",
    status: "OPEN",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
  await repositories.saveOrder({
    id: "order-7b",
    strategyDecisionId: "decision-7b",
    exchangeAccountId: "primary",
    market: "KRW-ETH",
    side: "bid",
    ordType: "limit",
    volume: "0.1",
    price: "3000000",
    timeInForce: null,
    smpType: null,
    identifier: "identifier-7b",
    idempotencyKey: "idem-7b",
    origin: "STRATEGY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: "uuid-7b",
    status: "OPEN",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:01:00.000Z",
  });

  const lookedUpOrders: string[] = [];
  const service = new ReconciliationService({
    repositories,
    operatorState,
    maxOrderLookupsPerRun: 1,
    orderReader: {
      async getOrder(query) {
        lookedUpOrders.push((query.identifier ?? query.uuid) as string);
        return {
          uuid: query.uuid ?? "uuid-unknown",
          identifier: query.identifier ?? null,
          market: query.identifier === "identifier-7a" ? "KRW-BTC" : "KRW-ETH",
          side: "bid",
          ordType: "limit",
          state: "wait",
          price: query.identifier === "identifier-7a" ? "100000000" : "3000000",
          volume: query.identifier === "identifier-7a" ? "0.01" : "0.1",
          remainingVolume: query.identifier === "identifier-7a" ? "0.01" : "0.1",
          executedVolume: "0",
          paidFee: "0",
          createdAt: "2026-04-20T00:00:00.000Z",
          fills: [],
          raw: {
            state: "wait",
          },
        };
      },
    },
  });

  const summary = await service.run("primary");

  assert.deepEqual(lookedUpOrders, ["identifier-7a"]);
  assert.equal(summary.candidateCount, 2);
  assert.equal(summary.processedCount, 1);
  assert.equal(summary.deferredCount, 1);
  assert.deepEqual(summary.issues, [
    {
      code: "ORDER_LOOKUP_DEFERRED",
      message: "Deferred 1 reconciliation lookup(s) after reaching the per-run budget 1.",
    },
  ]);
});

test("reconciliation service records portfolio drift as reconciliation issues and risk events", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-8",
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
  const service = new ReconciliationService({
    repositories,
    operatorState,
  });

  const summary = await service.run("primary", {
    source: "DIRECT_RUN",
    portfolioSnapshots: {
      previousBalanceSnapshot: {
        id: "balance-prev",
        exchangeAccountId: "primary",
        capturedAt: "2026-04-20T00:00:00.000Z",
        source: "RECONCILIATION",
        totalKrwValue: "10000000",
        balancesJson: JSON.stringify([
          { currency: "KRW", balance: "10000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        ]),
      },
      currentBalanceSnapshot: {
        id: "balance-current",
        exchangeAccountId: "primary",
        capturedAt: "2026-04-20T00:10:00.000Z",
        source: "RECONCILIATION",
        totalKrwValue: "10100000",
        balancesJson: JSON.stringify([
          { currency: "KRW", balance: "10100000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
          { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "100000000", unitCurrency: "KRW" },
        ]),
      },
      previousPositionSnapshot: {
        id: "position-prev",
        exchangeAccountId: "primary",
        capturedAt: "2026-04-20T00:00:00.000Z",
        source: "RECONCILIATION",
        positionsJson: JSON.stringify([]),
      },
      currentPositionSnapshot: {
        id: "position-current",
        exchangeAccountId: "primary",
        capturedAt: "2026-04-20T00:10:00.000Z",
        source: "RECONCILIATION",
        positionsJson: JSON.stringify([
          {
            asset: "BTC",
            market: "KRW-BTC",
            quantity: "0.01",
            averageEntryPrice: "100000000",
            markPrice: "100000000",
            marketValue: "1000000",
            exposureRatio: null,
            capturedAt: "2026-04-20T00:10:00.000Z",
          },
        ]),
      },
    },
  });
  const riskEvents = await repositories.listRiskEvents("primary", 10);

  assert.equal(summary.status, "DRIFT_DETECTED");
  assert.deepEqual(
    summary.issues.map((issue) => issue.code),
    ["BALANCE_DRIFT_DETECTED", "POSITION_DRIFT_DETECTED"],
  );
  assert.deepEqual(
    riskEvents.map((event) => event.ruleCode),
    ["BALANCE_DRIFT_DETECTED", "POSITION_DRIFT_DETECTED"],
  );
});
