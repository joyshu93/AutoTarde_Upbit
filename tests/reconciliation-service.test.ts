import assert from "node:assert/strict";

import type { OrderRecord, ReconciliationRunRecord } from "../src/domain/types.js";
import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import { ExchangeOrderLookupError } from "../src/modules/exchange/errors.js";
import { parseCandidateEvidenceTimestamp } from "../src/modules/execution/candidate-evidence-decimals.js";
import { ReconciliationService } from "../src/modules/reconciliation/reconciliation-service.js";
import { DurableTelegramReporter } from "../src/modules/telegram/reporter.js";
import { test } from "./harness.js";

function uncertainSubmissionOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: "uncertain-submission-order",
    strategyDecisionId: "decision-identifier-recovery",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "10000000",
    timeInForce: null,
    smpType: null,
    identifier: "identifier-recovery",
    idempotencyKey: "identifier-recovery",
    origin: "STRATEGY",
    requestedAt: "2026-08-21T00:00:00.000Z",
    upbitUuid: null,
    status: "RECONCILIATION_REQUIRED",
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: "RECONCILIATION_REQUIRED",
    failureMessage: "Uncertain submission.",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...overrides,
  };
}

function pausedUncertainSubmissionState() {
  return new InMemoryOperatorStateStore({
    id: "state-identifier-recovery",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "PAUSED",
    killSwitchActive: false,
    pauseReason: "uncertain_submission",
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
}

test("reconciliation runWithRecord returns its exact persisted record as a detached value", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-exact-reconciliation-record",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-22T00:00:00.000Z",
  });
  const originalSave = repositories.saveReconciliationRun.bind(repositories);
  const ownRecords: ReconciliationRunRecord[] = [];
  repositories.saveReconciliationRun = async (record) => {
    ownRecords.push({ ...record });
    await originalSave(record);
    await originalSave({
      id: "concurrent-newer-run",
      exchangeAccountId: record.exchangeAccountId,
      status: "SUCCESS",
      startedAt: "2099-01-01T00:00:00.000Z",
      completedAt: "2099-01-01T00:00:00.001Z",
      summaryJson: JSON.stringify({ source: "DIRECT_RUN", status: "SUCCESS", issues: [] }),
      errorMessage: null,
    });
  };
  const service = new ReconciliationService({ repositories, operatorState });

  const result = await service.runWithRecord("primary");
  const ownRecord = ownRecords[0];

  assert.ok(ownRecord);
  assert.deepEqual(result.reconciliationRun, ownRecord);
  assert.notEqual(result.reconciliationRun.id, "concurrent-newer-run");
  assert.deepEqual(JSON.parse(result.reconciliationRun.summaryJson), result.summary);

  const persistedId = result.reconciliationRun.id;
  result.reconciliationRun.id = "mutated-return-value";
  const persisted = await repositories.listReconciliationRuns("primary");
  assert.ok(persisted.some((record) => record.id === persistedId));
  assert.ok(!persisted.some((record) => record.id === "mutated-return-value"));
});

test("reconciliation runWithRecord protects exact provenance from mutation during persistence", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-protected-reconciliation-record",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-22T00:00:00.000Z",
  });
  const originalSave = repositories.saveReconciliationRun.bind(repositories);
  let mutationRejected = false;
  repositories.saveReconciliationRun = async (record) => {
    await originalSave(record);
    try {
      record.id = "mutated-during-save";
      record.exchangeAccountId = "foreign-account";
    } catch {
      mutationRejected = true;
    }
  };
  const service = new ReconciliationService({ repositories, operatorState });

  const result = await service.runWithRecord("primary", {
    runIdentity: {
      id: "invocation-owned-run",
      startedAt: "2026-08-22T00:00:00.000Z",
    },
  });
  const runs = await repositories.listReconciliationRuns("primary");

  assert.equal(mutationRejected, true);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.id, "invocation-owned-run");
  assert.equal(runs[0]?.exchangeAccountId, "primary");
  assert.deepEqual(result.reconciliationRun, runs[0]);
});

test("reconciliation run preserves the legacy summary API by delegating to the exact result", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-legacy-summary-api",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-22T00:00:00.000Z",
  });
  const service = new ReconciliationService({ repositories, operatorState });

  const summary = await service.run("primary", { source: "SCHEDULER_PREFLIGHT" });
  const [persisted] = await repositories.listReconciliationRuns("primary", 1);

  assert.ok(persisted);
  assert.deepEqual(summary, JSON.parse(persisted.summaryJson));
  assert.equal(summary.source, "SCHEDULER_PREFLIGHT");
});

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
  assert.equal(fills[0]?.executionTimestampProvenance, "EXCHANGE_FILL_CONFIRMED");
  assert.equal(
    fills[0]?.executionEpochNs,
    parseCandidateEvidenceTimestamp("2026-04-20T00:01:00.000Z", "fixture fill").toString(),
  );
});

test("reconciliation projects persisted terminal order evidence after fill backfill", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-candidate-projection",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "PAUSED",
    killSwitchActive: false,
    pauseReason: "operator_pause",
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const order = uncertainSubmissionOrder({
    id: "candidate-projection-order",
    executionMode: "DRY_RUN",
    status: "OPEN",
    upbitUuid: "candidate-projection-uuid",
    identifier: "candidate-projection-identifier",
    failureCode: null,
    failureMessage: null,
  });
  await repositories.saveOrder(order);
  const projectedOrderIds: string[] = [];
  const service = new ReconciliationService({
    repositories,
    operatorState,
    candidateEvidenceService: {
      async processTerminalOrder(orderId) {
        projectedOrderIds.push(orderId);
        return {
          outcome: "ADVANCED",
          orderId,
          detail: "projected",
        };
      },
    },
    orderReader: {
      async getOrder() {
        return {
          uuid: "candidate-projection-uuid",
          identifier: "candidate-projection-identifier",
          market: "KRW-BTC",
          side: "bid",
          ordType: "price",
          state: "done",
          price: "10000000",
          volume: null,
          remainingVolume: "0",
          executedVolume: "0.1",
          paidFee: "500",
          createdAt: "2026-08-21T00:00:00.000Z",
          fills: [
            {
              tradeUuid: "candidate-projection-fill",
              side: "bid",
              price: "100000000",
              volume: "0.1",
              funds: "10000000",
              fee: "500",
              createdAt: "2026-08-21T00:00:01.000Z",
              raw: {},
            },
          ],
          raw: { state: "done" },
        };
      },
    },
  });

  await service.run("primary");

  assert.deepEqual(projectedOrderIds, ["candidate-projection-order"]);
  assert.equal((await repositories.listFills("candidate-projection-order")).length, 1);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("reconciliation preserves an unallocated order fee and never substitutes a missing exchange fill instant", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-paid-fee-fallback",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-07-13T10:31:00.000Z",
  });
  await repositories.saveOrder({
    id: "order-paid-fee-fallback",
    strategyDecisionId: "decision-paid-fee-fallback",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "ask",
    ordType: "market",
    volume: "0.00036247",
    price: null,
    timeInForce: null,
    smpType: null,
    identifier: "KRW-BTC-ask-paid-fee",
    idempotencyKey: "idem-paid-fee-fallback",
    origin: "STRATEGY",
    requestedAt: "2026-07-13T10:31:00.000Z",
    upbitUuid: "uuid-paid-fee-fallback",
    status: "OPEN",
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-07-13T10:31:00.000Z",
    updatedAt: "2026-07-13T10:31:00.000Z",
  });

  const service = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        return {
          uuid: "uuid-paid-fee-fallback",
          identifier: "KRW-BTC-ask-paid-fee",
          market: "KRW-BTC",
          side: "ask",
          ordType: "market",
          state: "done",
          price: null,
          volume: "0.00036247",
          remainingVolume: "0",
          executedVolume: "0.00036247",
          paidFee: "16.94148533",
          createdAt: "2026-07-13T19:31:57+09:00",
          fills: [
            {
              tradeUuid: "trade-paid-fee-fallback",
              side: "ask",
              price: "93478000",
              volume: "0.00036247",
              funds: "33882.97066",
              fee: null,
              createdAt: null,
              raw: {
                uuid: "trade-paid-fee-fallback",
                funds: "33882.97066",
              },
            },
          ],
          raw: {
            state: "done",
            paid_fee: "16.94148533",
          },
        };
      },
    },
  });

  await service.run("primary");
  const fills = await repositories.listFills("order-paid-fee-fallback");

  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.feeCurrency, "KRW");
  assert.equal(fills[0]?.feeAmount, null);
  assert.equal(fills[0]?.feeProvenance, "ORDER_LEVEL_UNALLOCATED");
  assert.equal(fills[0]?.executionTimestampProvenance, "LEGACY_UNVERIFIED");
  assert.equal(fills[0]?.executionEpochNs, null);
  assert.equal(fills[0]?.filledAt, "");
});

test("reconciliation service treats filled Upbit price bids with canceled dust as filled", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-price-bid-dust-cancel",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-07-14T16:51:00.000Z",
  });
  await repositories.saveOrder({
    id: "order-price-bid-dust-cancel",
    strategyDecisionId: "decision-price-bid-dust-cancel",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "18069.657320999999",
    timeInForce: null,
    smpType: null,
    identifier: "KRW-BTC-bid-dust-cancel",
    idempotencyKey: "idem-price-bid-dust-cancel",
    origin: "STRATEGY",
    requestedAt: "2026-07-14T16:51:10.532Z",
    upbitUuid: "uuid-price-bid-dust-cancel",
    status: "OPEN",
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-07-14T16:51:10.532Z",
    updatedAt: "2026-07-14T16:51:10.532Z",
  });

  const service = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        return {
          uuid: "uuid-price-bid-dust-cancel",
          identifier: "KRW-BTC-bid-dust-cancel",
          market: "KRW-BTC",
          side: "bid",
          ordType: "price",
          state: "cancel",
          price: "18069.657320999999",
          volume: null,
          remainingVolume: null,
          executedVolume: "0.00018945",
          paidFee: "9.034586325",
          createdAt: "2026-07-15T01:51:10+09:00",
          fills: [
            {
              tradeUuid: "trade-price-bid-dust-cancel",
              side: "bid",
              price: "95377000",
              volume: "0.00018945",
              funds: "18069.17265",
              fee: null,
              createdAt: "2026-07-15T01:51:10.745053+09:00",
              raw: {
                uuid: "trade-price-bid-dust-cancel",
                funds: "18069.17265",
              },
            },
          ],
          raw: {
            state: "cancel",
            ord_type: "price",
            executed_volume: "0.00018945",
            paid_fee: "9.034586325",
            locked: "0.484913325495",
          },
        };
      },
    },
  });

  await service.run("primary");
  const orders = await repositories.listOrders("primary");
  const activeOrders = await repositories.listActiveOrders("primary");
  const fills = await repositories.listFills("order-price-bid-dust-cancel");

  assert.equal(orders[0]?.status, "FILLED");
  assert.equal(activeOrders.length, 0);
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.feeAmount, null);
  assert.equal(fills[0]?.feeProvenance, "ORDER_LEVEL_UNALLOCATED");
});

test("reconciliation service rechecks stored canceled price bids with fill evidence", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-stored-canceled-price-bid",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-07-14T16:51:00.000Z",
  });
  await repositories.saveOrder({
    id: "order-stored-canceled-price-bid",
    strategyDecisionId: "decision-stored-canceled-price-bid",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "18069.657320999999",
    timeInForce: null,
    smpType: null,
    identifier: "KRW-BTC-bid-stored-cancel",
    idempotencyKey: "idem-stored-canceled-price-bid",
    origin: "STRATEGY",
    requestedAt: "2026-07-14T16:51:10.532Z",
    upbitUuid: "uuid-stored-canceled-price-bid",
    status: "CANCELED",
    executionMode: "LIVE",
    exchangeResponseJson: JSON.stringify({
      state: "cancel",
      ord_type: "price",
      executed_volume: "0.00018945",
      paid_fee: "9.034586325",
      locked: "0.484913325495",
    }),
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-07-14T16:51:10.532Z",
    updatedAt: "2026-07-14T16:51:11.000Z",
  });

  const service = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        return {
          uuid: "uuid-stored-canceled-price-bid",
          identifier: "KRW-BTC-bid-stored-cancel",
          market: "KRW-BTC",
          side: "bid",
          ordType: "price",
          state: "cancel",
          price: "18069.657320999999",
          volume: null,
          remainingVolume: null,
          executedVolume: "0.00018945",
          paidFee: "9.034586325",
          createdAt: "2026-07-15T01:51:10+09:00",
          fills: [
            {
              tradeUuid: "trade-stored-canceled-price-bid",
              side: "bid",
              price: "95377000",
              volume: "0.00018945",
              funds: "18069.17265",
              fee: null,
              createdAt: "2026-07-15T01:51:10.745053+09:00",
              raw: {
                uuid: "trade-stored-canceled-price-bid",
                funds: "18069.17265",
              },
            },
          ],
          raw: {
            state: "cancel",
            ord_type: "price",
            executed_volume: "0.00018945",
            paid_fee: "9.034586325",
          },
        };
      },
    },
  });

  const summary = await service.run("primary");
  const orders = await repositories.listOrders("primary");
  const fills = await repositories.listFills("order-stored-canceled-price-bid");

  assert.equal(summary.candidateCount, 1);
  assert.deepEqual(
    summary.issues.map((issue) => issue.code),
    ["TERMINAL_ORDER_RECHECKED", "ORDER_STATUS_RECONCILED", "ORDER_FILLS_BACKFILLED"],
  );
  assert.equal(orders[0]?.status, "FILLED");
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.feeAmount, null);
  assert.equal(fills[0]?.feeProvenance, "ORDER_LEVEL_UNALLOCATED");
});

test("reconciliation service repairs local dry-run orders without querying Upbit", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-dryrun-repair",
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
  await repositories.savePositionSnapshot({
    id: "position-snapshot-dryrun-repair",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "RECONCILIATION",
    positionsJson: JSON.stringify([
      {
        asset: "BTC",
        market: "KRW-BTC",
        quantity: "0.00007489",
        averageEntryPrice: "115950000",
        markPrice: "117860000",
        marketValue: "8826.5354",
        exposureRatio: null,
        capturedAt: "2026-04-20T00:00:00.000Z",
      },
    ]),
  });
  await repositories.saveOrder({
    id: "order-dryrun-repair",
    strategyDecisionId: "decision-dryrun-repair",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "ask",
    ordType: "market",
    volume: "0.00007489",
    price: null,
    timeInForce: null,
    smpType: null,
    identifier: "KRW-BTC-ask-dryrun-repair",
    idempotencyKey: "idem-dryrun-repair",
    origin: "STRATEGY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: "dryrun_order_1",
    status: "RECONCILIATION_REQUIRED",
    executionMode: "DRY_RUN",
    exchangeResponseJson: JSON.stringify({ mode: "DRY_RUN" }),
    failureCode: "RECONCILIATION_REQUIRED",
    failureMessage: "Exchange order lookup failed: Upbit private request failed (404 Not Found).",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:10:00.000Z",
  });
  let lookupCount = 0;
  const service = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        lookupCount += 1;
        throw new Error("dry-run orders must not be queried on Upbit");
      },
    },
  });

  const summary = await service.run("primary");
  const orders = await repositories.listOrders("primary");
  const fills = await repositories.listFills("order-dryrun-repair");
  const events = await repositories.listOrderEvents("order-dryrun-repair");
  const activeOrders = await repositories.listActiveOrders("primary");

  assert.equal(lookupCount, 0);
  assert.equal(summary.status, "DRIFT_DETECTED");
  assert.equal(summary.candidateCount, 0);
  assert.deepEqual(summary.issues, [
    {
      code: "DRY_RUN_ORDER_REPAIRED",
      message: "Dry-run local order order-dryrun-repair was repaired to FILLED with a synthetic local fill.",
    },
  ]);
  assert.equal(orders[0]?.status, "FILLED");
  assert.equal(orders[0]?.failureCode, null);
  assert.equal(orders[0]?.failureMessage, null);
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.exchangeFillId, "dryrun_repair:order-dryrun-repair");
  assert.equal(fills[0]?.price, "117860000");
  assert.equal(fills[0]?.volume, "0.00007489");
  assert.equal(events.at(-1)?.eventType, "ORDER_FILLED");
  assert.equal(activeOrders.length, 0);
});

test("reconciliation service recovers exchange-only orders from recent exchange history", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-history-recovery",
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
    orderHistoryReader: {
      async listOpenOrders() {
        return [];
      },
      async listClosedOrders() {
        return [
          {
            uuid: "uuid-history-1",
            identifier: null,
            market: "KRW-BTC",
            side: "bid",
            ordType: "limit",
            state: "done",
            price: "100000000",
            volume: "0.01",
            remainingVolume: "0",
            executedVolume: "0.01",
            paidFee: "500",
            createdAt: "2026-04-20T00:05:00.000Z",
            fills: [
              {
                tradeUuid: "trade-history-1",
                side: "bid",
                price: "100000000",
                volume: "0.01",
                funds: "1000000",
                fee: "500",
                createdAt: "2026-04-20T00:05:01.000Z",
                raw: {
                  tradeUuid: "trade-history-1",
                },
              },
            ],
            raw: {
              state: "done",
            },
          },
        ];
      },
    },
  });

  const summary = await service.run("primary");
  const orders = await repositories.listOrders("primary");
  const fills = await repositories.listFills();

  assert.equal(summary.status, "DRIFT_DETECTED");
  assert.equal(summary.candidateCount, 0);
  assert.equal(summary.processedCount, 0);
  assert.equal(summary.deferredCount, 0);
  assert.equal(summary.historyRecovery?.closedOrderLookbackDays, 7);
  assert.equal(summary.historyRecovery?.stopBeforeDays, 365);
  assert.equal(summary.historyRecovery?.retentionAssumptionDays, 365);
  assert.equal(summary.historyRecovery?.retentionStatus, "WITHIN_ASSUMED_RETENTION");
  assert.equal(summary.historyRecovery?.coverageStatus, "IN_PROGRESS");
  assert.equal(summary.historyRecovery?.confidenceLevel, "PARTIAL");
  assert.equal(summary.historyRecovery?.confidenceReason, "ARCHIVE_IN_PROGRESS");
  assert.equal(summary.historyRecovery?.failureMessage, null);
  assert.equal(summary.historyRecovery?.scannedSnapshotCount, 1);
  assert.equal(summary.historyRecovery?.recoveredOrderCount, 1);
  assert.equal(summary.historyRecovery?.markets.length, 2);
  assert.equal(summary.historyRecovery?.markets[0]?.market, "KRW-BTC");
  assert.equal(summary.historyRecovery?.markets[0]?.archiveComplete, false);
  assert.equal(summary.historyRecovery?.markets[0]?.retentionStatus, "WITHIN_ASSUMED_RETENTION");
  assert.equal(summary.historyRecovery?.markets[0]?.confidenceLevel, "PARTIAL");
  assert.equal(summary.historyRecovery?.markets[0]?.confidenceReason, "ARCHIVE_IN_PROGRESS");
  assert.equal(summary.historyRecovery?.markets[0]?.openHistoryTruncated, false);
  assert.equal(summary.historyRecovery?.markets[0]?.recentClosedHistoryTruncated, false);
  assert.equal(summary.historyRecovery?.markets[0]?.archivalClosedHistoryTruncated, false);
  assert.equal(summary.historyRecovery?.markets[0]?.snapshotCount, 2);
  assert.equal(summary.historyRecovery?.markets[0]?.recentClosedPagesScanned, 1);
  assert.equal(summary.historyRecovery?.markets[0]?.archivalClosedPagesScanned, 1);
  assert.equal(summary.historyRecovery?.markets[0]?.openPagesScanned, 1);
  assert.equal(summary.historyRecovery?.markets[1]?.market, "KRW-ETH");
  assert.equal(summary.historyRecovery?.markets[1]?.snapshotCount, 2);
  assert.deepEqual(summary.issues, [
    {
      code: "EXCHANGE_ORDER_RECOVERED",
      message: `Recovered exchange order ${orders[0]?.id} for KRW-BTC from exchange history state done.`,
    },
    {
      code: "ORDER_FILLS_BACKFILLED",
      message: `Backfilled 1 fill(s) for order ${orders[0]?.id} from exchange snapshot.`,
    },
  ]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0]?.origin, "RECOVERY");
  assert.equal(orders[0]?.status, "FILLED");
  assert.equal(orders[0]?.identifier, "exchange_recovery:uuid-history-1");
  assert.equal(fills.length, 1);
  assert.equal(fills[0]?.exchangeFillId, "trade-history-1");
});

test("reconciliation service paginates recent exchange history within the configured lookback window", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-history-pagination",
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
  const closedOrderRequests: Array<{ market: string; page: number | undefined; startTimeMs: number | undefined; endTimeMs: number | undefined }> = [];
  const service = new ReconciliationService({
    repositories,
    operatorState,
    historyMaxPagesPerMarket: 2,
    closedOrderLookbackDays: 3,
    orderHistoryReader: {
      async listOpenOrders() {
        return [];
      },
      async listClosedOrders(query = {}) {
        closedOrderRequests.push({
          market: query.market ?? "unknown",
          page: query.page,
          startTimeMs: query.startTimeMs,
          endTimeMs: query.endTimeMs,
        });

        if (query.market !== "KRW-BTC") {
          return [];
        }

        if (query.page === 1) {
          return Array.from({ length: 20 }, (_, index) => buildHistorySnapshot(index + 1));
        }

        if (query.page === 2) {
          return [buildHistorySnapshot(21)];
        }

        return [];
      },
    },
  });

  const summary = await service.run("primary");
  const orders = await repositories.listOrders("primary");
  const checkpoint = await repositories.getHistoryRecoveryCheckpoint(
    "primary",
    "KRW-BTC",
    "CLOSED_ORDER_ARCHIVE",
  );

  assert.equal(orders.length, 21);
  assert.equal(summary.historyRecovery?.closedOrderLookbackDays, 3);
  assert.equal(summary.historyRecovery?.stopBeforeDays, 365);
  assert.equal(summary.historyRecovery?.retentionAssumptionDays, 365);
  assert.equal(summary.historyRecovery?.retentionStatus, "WITHIN_ASSUMED_RETENTION");
  assert.equal(summary.historyRecovery?.coverageStatus, "IN_PROGRESS");
  assert.equal(summary.historyRecovery?.confidenceLevel, "PARTIAL");
  assert.equal(summary.historyRecovery?.confidenceReason, "ARCHIVE_IN_PROGRESS");
  assert.equal(summary.historyRecovery?.scannedSnapshotCount, 21);
  assert.equal(summary.historyRecovery?.recoveredOrderCount, 21);
  assert.equal(summary.historyRecovery?.markets[0]?.market, "KRW-BTC");
  assert.equal(summary.historyRecovery?.markets[0]?.openPagesScanned, 1);
  assert.equal(summary.historyRecovery?.markets[0]?.recentClosedPagesScanned, 2);
  assert.equal(summary.historyRecovery?.markets[0]?.archivalClosedPagesScanned, 2);
  assert.equal(summary.historyRecovery?.markets[0]?.archiveComplete, false);
  assert.equal(summary.historyRecovery?.markets[0]?.confidenceLevel, "PARTIAL");
  assert.equal(summary.historyRecovery?.markets[0]?.confidenceReason, "ARCHIVE_IN_PROGRESS");
  assert.equal(summary.historyRecovery?.markets[0]?.snapshotCount, 42);
  assert.deepEqual(
    closedOrderRequests.filter((request) => request.market === "KRW-BTC").map((request) => request.page),
    [1, 1, 2, 2],
  );
  assert.equal(
    (closedOrderRequests[0]?.endTimeMs ?? 0) - (closedOrderRequests[0]?.startTimeMs ?? 0),
    3 * 24 * 60 * 60 * 1000,
  );
  assert.ok(checkpoint);
});

test("reconciliation service stops archival exchange-history recovery at the configured boundary", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-history-stop",
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
  const completedArchiveEndAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await repositories.saveHistoryRecoveryCheckpoint({
    id: "checkpoint-stop-btc",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    checkpointType: "CLOSED_ORDER_ARCHIVE",
    nextWindowEndAt: completedArchiveEndAt,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
  await repositories.saveHistoryRecoveryCheckpoint({
    id: "checkpoint-stop-eth",
    exchangeAccountId: "primary",
    market: "KRW-ETH",
    checkpointType: "CLOSED_ORDER_ARCHIVE",
    nextWindowEndAt: completedArchiveEndAt,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const closedOrderRequests: Array<{ market: string; page: number | undefined }> = [];
  const service = new ReconciliationService({
    repositories,
    operatorState,
    closedOrderLookbackDays: 7,
    historyStopBeforeDays: 14,
    orderHistoryReader: {
      async listOpenOrders() {
        return [];
      },
      async listClosedOrders(query = {}) {
        closedOrderRequests.push({
          market: query.market ?? "unknown",
          page: query.page,
        });
        return [];
      },
    },
  });

  const summary = await service.run("primary");

  assert.equal(summary.historyRecovery?.stopBeforeDays, 14);
  assert.equal(summary.historyRecovery?.retentionStatus, "WITHIN_ASSUMED_RETENTION");
  assert.equal(summary.historyRecovery?.coverageStatus, "COMPLETE");
  assert.equal(summary.historyRecovery?.confidenceLevel, "HIGH");
  assert.equal(summary.historyRecovery?.confidenceReason, "ARCHIVE_COMPLETE");
  assert.equal(summary.historyRecovery?.markets.length, 2);
  assert.equal(summary.historyRecovery?.markets[0]?.archiveComplete, true);
  assert.equal(summary.historyRecovery?.markets[0]?.confidenceLevel, "HIGH");
  assert.equal(summary.historyRecovery?.markets[0]?.confidenceReason, "ARCHIVE_COMPLETE");
  assert.equal(summary.historyRecovery?.markets[0]?.archivalClosedPagesScanned, 0);
  assert.equal(summary.historyRecovery?.markets[1]?.archiveComplete, true);
  assert.equal(summary.historyRecovery?.markets[1]?.archivalClosedPagesScanned, 0);
  assert.deepEqual(
    closedOrderRequests.map((request) => `${request.market}:${request.page}`),
    ["KRW-BTC:1", "KRW-ETH:1"],
  );
});

test("reconciliation service marks exchange-history confidence partial when page limits are reached", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-history-page-limit-confidence",
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
    historyMaxPagesPerMarket: 1,
    orderHistoryReader: {
      async listOpenOrders() {
        return [];
      },
      async listClosedOrders(query = {}) {
        if (query.market !== "KRW-BTC") {
          return [];
        }

        return Array.from({ length: 20 }, (_, index) => buildHistorySnapshot(index + 1));
      },
    },
  });

  const summary = await service.run("primary");

  assert.equal(summary.historyRecovery?.coverageStatus, "IN_PROGRESS");
  assert.equal(summary.historyRecovery?.confidenceLevel, "PARTIAL");
  assert.equal(summary.historyRecovery?.confidenceReason, "PAGE_LIMIT_REACHED");
  assert.equal(summary.historyRecovery?.retentionStatus, "WITHIN_ASSUMED_RETENTION");
  assert.equal(summary.historyRecovery?.markets[0]?.market, "KRW-BTC");
  assert.equal(summary.historyRecovery?.markets[0]?.confidenceLevel, "PARTIAL");
  assert.equal(summary.historyRecovery?.markets[0]?.confidenceReason, "PAGE_LIMIT_REACHED");
  assert.equal(summary.historyRecovery?.markets[0]?.openHistoryTruncated, false);
  assert.equal(summary.historyRecovery?.markets[0]?.recentClosedHistoryTruncated, true);
  assert.equal(summary.historyRecovery?.markets[0]?.archivalClosedHistoryTruncated, true);
  assert.equal(summary.historyRecovery?.markets[1]?.market, "KRW-ETH");
  assert.equal(summary.historyRecovery?.markets[1]?.confidenceReason, "ARCHIVE_IN_PROGRESS");
});

test("reconciliation service marks history confidence partial when the scan crosses assumed exchange retention", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-history-retention-confidence",
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
    closedOrderLookbackDays: 7,
    historyStopBeforeDays: 60,
    historyRetentionAssumptionDays: 14,
    orderHistoryReader: {
      async listOpenOrders() {
        return [];
      },
      async listClosedOrders() {
        return [];
      },
    },
  });

  const summary = await service.run("primary");

  assert.equal(summary.historyRecovery?.coverageStatus, "IN_PROGRESS");
  assert.equal(summary.historyRecovery?.retentionAssumptionDays, 14);
  assert.equal(summary.historyRecovery?.retentionStatus, "BEYOND_ASSUMED_RETENTION");
  assert.equal(summary.historyRecovery?.confidenceLevel, "PARTIAL");
  assert.equal(summary.historyRecovery?.confidenceReason, "BEYOND_ASSUMED_RETENTION");
  assert.equal(summary.historyRecovery?.markets[0]?.market, "KRW-BTC");
  assert.equal(summary.historyRecovery?.markets[0]?.retentionStatus, "BEYOND_ASSUMED_RETENTION");
  assert.equal(summary.historyRecovery?.markets[0]?.confidenceReason, "BEYOND_ASSUMED_RETENTION");
  assert.equal(summary.historyRecovery?.markets[1]?.market, "KRW-ETH");
  assert.equal(summary.historyRecovery?.markets[1]?.retentionStatus, "BEYOND_ASSUMED_RETENTION");
});

test("reconciliation service persists failed exchange-history confidence when history lookup fails", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-history-lookup-failed",
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
    orderHistoryReader: {
      async listOpenOrders() {
        throw new Error("Upbit history temporarily unavailable");
      },
      async listClosedOrders() {
        return [];
      },
    },
  });

  const summary = await service.run("primary");

  assert.equal(summary.status, "DRIFT_DETECTED");
  assert.equal(summary.issues[0]?.code, "ORDER_HISTORY_LOOKUP_FAILED");
  assert.equal(summary.historyRecovery?.coverageStatus, "IN_PROGRESS");
  assert.equal(summary.historyRecovery?.confidenceLevel, "FAILED");
  assert.equal(summary.historyRecovery?.confidenceReason, "LOOKUP_FAILED");
  assert.equal(summary.historyRecovery?.retentionAssumptionDays, 365);
  assert.equal(summary.historyRecovery?.retentionStatus, "WITHIN_ASSUMED_RETENTION");
  assert.equal(summary.historyRecovery?.failureMessage, "Upbit history temporarily unavailable");
  assert.equal(summary.historyRecovery?.scannedSnapshotCount, 0);
  assert.equal(summary.historyRecovery?.markets.length, 0);
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
    recoveryClock: {
      now: () => ({ observedAt: "2026-04-20T00:00:01.000Z", observedAtEpochMs: 1_776_643_201_000 }),
    },
  });

  const summary = await service.run("primary");
  const orders = await repositories.listOrders("primary");

  assert.equal(summary.status, "DRIFT_DETECTED");
  assert.equal(summary.source, "DIRECT_RUN");
  assert.deepEqual(summary.issues.map((issue) => issue.code), ["ORDER_IDENTIFIER_RECOVERED"]);
  assert.equal(orders[0]?.status, "FILLED");
  assert.match(orders[0]?.exchangeResponseJson ?? "", /"state":"done"/);
});

test("reconciliation service keeps the first absent FAILED lookup uncertain", async () => {
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
    recoveryClock: {
      now: () => ({ observedAt: "2026-04-20T00:00:01.000Z", observedAtEpochMs: 1_776_643_201_000 }),
    },
  });

  const summary = await service.run("primary");
  const orders = await repositories.listOrders("primary");
  const riskEvents = await repositories.listRiskEvents("primary");

  assert.equal(summary.status, "DRIFT_DETECTED");
  assert.deepEqual(summary.issues.map((issue) => issue.code), ["ORDER_IDENTIFIER_RECOVERY_UNCERTAIN"]);
  assert.equal(orders[0]?.status, "FAILED");
  assert.equal(orders[0]?.failureCode, "EXCHANGE_SUBMISSION_FAILED");
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
        throw new ExchangeOrderLookupError({ kind: "TRANSIENT", status: 429 });
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
      message: "Transient exchange lookup failure for order order-6. Upbit order lookup failed transiently.",
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

test("first identifier recovery absence remains uncertain without resuming or sending", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-identifier-recovery",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "PAUSED",
    killSwitchActive: false,
    pauseReason: "uncertain_submission",
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const order = {
    id: "identifier-recovery-order",
    strategyDecisionId: "decision-identifier-recovery",
    exchangeAccountId: "primary",
    market: "KRW-BTC" as const,
    side: "bid" as const,
    ordType: "price" as const,
    volume: null,
    price: "10000000",
    timeInForce: null,
    smpType: null,
    identifier: "identifier-recovery",
    idempotencyKey: "identifier-recovery",
    origin: "STRATEGY" as const,
    requestedAt: "2026-08-21T00:00:00.000Z",
    upbitUuid: null,
    status: "RECONCILIATION_REQUIRED" as const,
    executionMode: "LIVE" as const,
    exchangeResponseJson: null,
    failureCode: "RECONCILIATION_REQUIRED",
    failureMessage: "Uncertain submission.",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
  await repositories.saveOrder(order);
  let lookupCount = 0;
  const reconciliation = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder(query) {
        lookupCount += 1;
        assert.deepEqual(query, { identifier: "identifier-recovery" });
        return null;
      },
    },
    identifierRecovery: {
      minimumNotFoundObservations: 2,
      minimumElapsedMs: 60_000,
    },
    recoveryClock: {
      now: () => ({
        observedAt: "2026-08-21T00:00:01.000Z",
        observedAtEpochMs: 1_787_270_401_000,
      }),
    },
  });

  const summary = await reconciliation.recoverOrderByIdentifier(order);
  const persistedOrder = await repositories.findOrderByReference("primary", "identifier-recovery");
  const observations = await repositories.listOrderSubmissionRecoveryObservations(order.id);

  assert.equal(summary.outcome, "STILL_UNCERTAIN");
  assert.equal(lookupCount, 1);
  assert.equal(persistedOrder?.status, "RECONCILIATION_REQUIRED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.deepEqual(observations.map((observation) => observation.outcome), ["NOT_FOUND"]);
});

test("generic lookup error messages are not treated as typed transient exchange failures", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = pausedUncertainSubmissionState();
  const order = uncertainSubmissionOrder({ id: "generic-lookup-error" });
  await repositories.saveOrder(order);
  const reconciliation = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: { async getOrder() { throw new Error("network timeout"); } },
    recoveryClock: {
      now: () => ({ observedAt: "2026-08-21T00:00:01.000Z", observedAtEpochMs: 1_787_270_401_000 }),
    },
  });

  await assert.rejects(
    () => reconciliation.recoverOrderByIdentifier(order),
    /network timeout/,
  );
  assert.deepEqual(await repositories.listOrderSubmissionRecoveryObservations(order.id), []);
});

test("immediate persisted terminal strategy orders are swept without consuming exchange lookup budget", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = pausedUncertainSubmissionState();
  const order = uncertainSubmissionOrder({
    id: "immediate-terminal-order",
    status: "FILLED",
    upbitUuid: null,
    updatedAt: "2026-08-21T00:00:10.000Z",
  });
  await repositories.saveOrder(order);
  await repositories.saveFill({
    id: "immediate-terminal-fill",
    orderId: order.id,
    exchangeFillId: "immediate-terminal-fill",
    market: "KRW-BTC",
    side: "bid",
    price: "100000000",
    volume: "0.1",
    feeCurrency: "KRW",
    feeAmount: "500",
    filledAt: "2026-08-21T00:00:02.000000001Z",
    rawPayloadJson: "{}",
  });
  const projected: string[] = [];
  const reconciliation = new ReconciliationService({
    repositories,
    operatorState,
    maxOrderLookupsPerRun: 0,
    candidateEvidenceService: {
      async processTerminalOrder(orderId) {
        projected.push(orderId);
        return { outcome: "ADVANCED", orderId, detail: "projected" };
      },
    },
  });

  await reconciliation.run("primary");

  assert.deepEqual(projected, [order.id]);
});

test("complete reconciliation restarts exclude actual absence-confirmed failures before constrained lookup candidates", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = pausedUncertainSubmissionState();
  const absenceConfirmed = uncertainSubmissionOrder({
    id: "absence-confirmed-failed",
    identifier: "absence-confirmed-failed",
    idempotencyKey: "absence-confirmed-failed",
    status: "FAILED",
    failureCode: "ORDER_SUBMISSION_ABSENCE_CONFIRMED",
    failureMessage: "Bounded identifier recovery confirmed persistent exchange absence.",
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const eligible = uncertainSubmissionOrder({
    id: "eligible-failed-after-absence",
    identifier: "eligible-failed-after-absence",
    idempotencyKey: "eligible-failed-after-absence",
    status: "FAILED",
    failureCode: "ORDER_SUBMISSION_UNCERTAIN",
    updatedAt: "2026-08-21T00:00:01.000Z",
  });
  await repositories.saveOrder(absenceConfirmed);
  await repositories.saveOrder(eligible);
  const lookupQueries: Array<{ uuid?: string; identifier?: string }> = [];
  const createReconciliation = (observedAt: string, observedAtEpochMs: number) =>
    new ReconciliationService({
      repositories,
      operatorState,
      maxOrderLookupsPerRun: 1,
      orderReader: {
        async getOrder(query) {
          lookupQueries.push(query);
          return null;
        },
      },
      identifierRecovery: {
        minimumNotFoundObservations: 3,
        minimumElapsedMs: 60_000,
      },
      recoveryClock: {
        now: () => ({ observedAt, observedAtEpochMs }),
      },
    });

  const first = await createReconciliation(
    "2026-08-21T00:00:02.000Z",
    1_787_270_402_000,
  ).run("primary");
  const restarted = await createReconciliation(
    "2026-08-21T00:00:03.000Z",
    1_787_270_403_000,
  ).run("primary");

  assert.deepEqual(lookupQueries, [
    { identifier: eligible.identifier! },
    { identifier: eligible.identifier! },
  ]);
  assert.deepEqual([first.candidateCount, restarted.candidateCount], [1, 1]);
  assert.deepEqual([first.processedCount, restarted.processedCount], [1, 1]);
  assert.deepEqual([first.deferredCount, restarted.deferredCount], [0, 0]);
  assert.deepEqual(
    await repositories.listOrderSubmissionRecoveryObservations(absenceConfirmed.id),
    [],
  );
  assert.equal((await repositories.listOrderSubmissionRecoveryObservations(eligible.id)).length, 2);
});

test("terminal sweep orders persisted fill instants before order update time with deterministic order IDs", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = pausedUncertainSubmissionState();
  const orders = [
    uncertainSubmissionOrder({ id: "terminal-z", status: "FILLED", updatedAt: "2026-08-21T00:00:00.000Z" }),
    uncertainSubmissionOrder({ id: "terminal-a", status: "CANCELED", updatedAt: "2026-08-21T23:59:59.000Z" }),
    uncertainSubmissionOrder({ id: "terminal-later", status: "FILLED", updatedAt: "2026-08-20T00:00:00.000Z" }),
  ];
  for (const order of orders) {
    await repositories.saveOrder(order);
  }
  for (const [orderId, filledAt] of [
    ["terminal-z", "2026-08-21T00:00:03.000000001Z"],
    ["terminal-a", "2026-08-21T00:00:03.000000001Z"],
    ["terminal-later", "2026-08-21T00:00:04.000000001Z"],
  ] as const) {
    await repositories.saveFill({
      id: `fill-${orderId}`,
      orderId,
      exchangeFillId: `fill-${orderId}`,
      market: "KRW-BTC",
      side: "bid",
      price: "100000000",
      volume: "0.1",
      feeCurrency: "KRW",
      feeAmount: "500",
      feeProvenance: "EXCHANGE_FILL_CONFIRMED",
      executionTimestampProvenance: "EXCHANGE_FILL_CONFIRMED",
      executionEpochNs: parseCandidateEvidenceTimestamp(filledAt, "terminal sweep fixture").toString(),
      filledAt,
      rawPayloadJson: "{}",
    });
  }
  const projected: string[] = [];
  const reconciliation = new ReconciliationService({
    repositories,
    operatorState,
    maxOrderLookupsPerRun: 0,
    maxTerminalCandidateProjectionsPerRun: 2,
    candidateEvidenceService: {
      async processTerminalOrder(orderId) {
        projected.push(orderId);
        return { outcome: "ADVANCED", orderId, detail: "projected" };
      },
    },
  });

  await reconciliation.run("primary");

  assert.deepEqual(projected, ["terminal-a", "terminal-z"]);
});

test("FAILED and REJECTED potentially-dispatched orders keep first null lookup uncertain", async () => {
  for (const status of ["FAILED", "REJECTED"] as const) {
    const repositories = new InMemoryExecutionRepository();
    const operatorState = pausedUncertainSubmissionState();
    const order = uncertainSubmissionOrder({
      id: `terminal-${status.toLowerCase()}-absence`,
      status,
      failureCode: "SUBMISSION_RESPONSE_UNCERTAIN",
    });
    await repositories.saveOrder(order);
    const reconciliation = new ReconciliationService({
      repositories,
      operatorState,
      orderReader: { async getOrder() { return null; } },
      identifierRecovery: { minimumNotFoundObservations: 2, minimumElapsedMs: 60_000 },
      recoveryClock: {
        now: () => ({ observedAt: "2026-08-21T00:00:01.000Z", observedAtEpochMs: 1_787_270_401_000 }),
      },
    });

    const result = await reconciliation.recoverOrderByIdentifier(order);

    assert.equal(result.outcome, "STILL_UNCERTAIN");
    assert.equal((await repositories.findOrderByReference("primary", order.id))?.status, status);
  }
});

test("submission recovery uses a persisted UUID before identifier fallback and never resumes", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = pausedUncertainSubmissionState();
  const order = uncertainSubmissionOrder({
    id: "uuid-submission-order",
    upbitUuid: "persisted-upbit-uuid",
    identifier: "persisted-identifier",
  });
  await repositories.saveOrder(order);
  const lookupQueries: Array<{ uuid?: string; identifier?: string }> = [];
  const reconciliation = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder(query) {
        lookupQueries.push(query);
        assert.deepEqual(query, { uuid: "persisted-upbit-uuid" });
        return {
          uuid: "persisted-upbit-uuid",
          identifier: "persisted-identifier",
          market: "KRW-BTC",
          side: "bid",
          ordType: "price",
          state: "done",
          price: "10000000",
          volume: null,
          remainingVolume: "0",
          executedVolume: "0.1",
          paidFee: "500",
          createdAt: "2026-08-21T00:00:00.000Z",
          fills: [
            {
              tradeUuid: "uuid-recovery-fill",
              side: "bid",
              price: "100000000",
              volume: "0.1",
              funds: "10000000",
              fee: "500",
              createdAt: "2026-08-21T00:00:01.000Z",
              raw: {},
            },
          ],
          raw: { state: "done" },
        };
      },
    },
    recoveryClock: {
      now: () => ({
        observedAt: "2026-08-21T00:00:01.000Z",
        observedAtEpochMs: 1_787_270_401_000,
      }),
    },
  });

  const recovery = await reconciliation.recoverOrderByIdentifier(order);
  const persistedOrder = await repositories.findOrderByReference("primary", order.id);
  const observations = await repositories.listOrderSubmissionRecoveryObservations(order.id);

  assert.equal(recovery.outcome, "RECOVERED");
  assert.deepEqual(lookupQueries, [{ uuid: "persisted-upbit-uuid" }]);
  assert.equal(persistedOrder?.status, "FILLED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.deepEqual(observations.map((observation) => observation.outcome), ["FOUND"]);
});

test("recovered terminal projection failures persist a fault marker and pause execution", async () => {
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-recovered-projection-failure",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const repositories = new InMemoryExecutionRepository(operatorState);
  const order = uncertainSubmissionOrder({ id: "recovered-projection-failure-order" });
  await repositories.saveOrder(order);
  const reconciliation = new ReconciliationService({
    repositories,
    operatorState,
    candidateEvidenceService: {
      async processTerminalOrder(orderId) {
        return { outcome: "FAULT", orderId, detail: "candidate binding could not be verified" };
      },
    },
    orderReader: {
      async getOrder() {
        return {
          uuid: "recovered-projection-failure-uuid",
          identifier: order.identifier,
          market: "KRW-BTC",
          side: "bid",
          ordType: "price",
          state: "done",
          price: "10000000",
          volume: null,
          remainingVolume: "0",
          executedVolume: "0.1",
          paidFee: "500",
          createdAt: "2026-08-21T00:00:00.000Z",
          fills: [],
          raw: { state: "done" },
        };
      },
    },
    recoveryClock: {
      now: () => ({ observedAt: "2026-08-21T00:00:01.000Z", observedAtEpochMs: 1_787_270_401_000 }),
    },
  });

  const result = await reconciliation.recoverOrderByIdentifier(order);
  const events = await repositories.listOrderEvents(order.id);

  assert.equal(result.outcome, "RECOVERED_BUT_PROJECTION_FAILED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal(events.filter((event) => event.id === `candidate-evidence-recovery-fault:${order.id}`).length, 1);
});

test("bounded persisted identifier absence reaches a terminal fault only after count and elapsed time", async () => {
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-bounded-absence",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const repositories = new InMemoryExecutionRepository(operatorState);
  const order = uncertainSubmissionOrder({ id: "bounded-absence-order" });
  await repositories.saveOrder(order);
  let now = {
    observedAt: "2026-08-21T00:00:01.000Z",
    observedAtEpochMs: 1_787_270_401_000,
  };
  const reconciliation = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: { async getOrder() { return null; } },
    identifierRecovery: {
      minimumNotFoundObservations: 2,
      minimumElapsedMs: 60_000,
    },
    recoveryClock: { now: () => now },
  });

  const first = await reconciliation.recoverOrderByIdentifier(order);
  now = {
    observedAt: "2026-08-21T00:01:01.000Z",
    observedAtEpochMs: 1_787_270_461_000,
  };
  const second = await reconciliation.recoverOrderByIdentifier(order);
  const persistedOrder = await repositories.findOrderByReference("primary", order.id);
  const observations = await repositories.listOrderSubmissionRecoveryObservations(order.id);

  assert.equal(first.outcome, "STILL_UNCERTAIN");
  assert.equal(second.outcome, "ABSENCE_CONFIRMED");
  assert.equal(persistedOrder?.status, "FAILED");
  assert.equal(persistedOrder?.failureCode, "ORDER_SUBMISSION_ABSENCE_CONFIRMED");
  assert.deepEqual(observations.map((observation) => observation.outcome), ["NOT_FOUND", "NOT_FOUND"]);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
});

test("bounded absence confirmation is idempotent across a complete reconciliation restart", async () => {
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-bounded-absence-restart",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const repositories = new InMemoryExecutionRepository(operatorState);
  const order = uncertainSubmissionOrder({ id: "bounded-absence-restart-order" });
  await repositories.saveOrder(order);
  let now = { observedAt: "2026-08-21T00:00:01.000Z", observedAtEpochMs: 1_787_270_401_000 };
  const beforeRestart = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: { async getOrder() { return null; } },
    identifierRecovery: { minimumNotFoundObservations: 2, minimumElapsedMs: 60_000 },
    recoveryClock: { now: () => now },
  });
  await beforeRestart.recoverOrderByIdentifier(order);
  now = { observedAt: "2026-08-21T00:01:01.000Z", observedAtEpochMs: 1_787_270_461_000 };
  const confirmation = await beforeRestart.recoverOrderByIdentifier(order);
  const persisted = (await repositories.findOrderByReference("primary", order.id))!;
  const restarted = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: { async getOrder() { throw new Error("lookup must not run after absence confirmation"); } },
    identifierRecovery: { minimumNotFoundObservations: 2, minimumElapsedMs: 60_000 },
    recoveryClock: { now: () => now },
  });

  const replay = await restarted.recoverOrderByIdentifier(persisted);

  assert.equal(confirmation.outcome, "ABSENCE_CONFIRMED");
  assert.equal(replay.outcome, "ABSENCE_CONFIRMED");
  assert.equal((await repositories.listOrderEvents(order.id))
    .filter((event) => event.eventType === "RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED").length, 1);
});

test("bounded absence keeps count and elapsed thresholds independently uncertain across restart", async () => {
  for (const policy of [
    { minimumNotFoundObservations: 3, minimumElapsedMs: 60_000 },
    { minimumNotFoundObservations: 2, minimumElapsedMs: 120_000 },
  ]) {
    const operatorState = new InMemoryOperatorStateStore({
      id: `state-independent-bound-${policy.minimumNotFoundObservations}-${policy.minimumElapsedMs}`,
      exchangeAccountId: "primary",
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      systemStatus: "RUNNING",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: null,
      degradedAt: null,
      updatedAt: "2026-08-21T00:00:00.000Z",
    });
    const repositories = new InMemoryExecutionRepository(operatorState);
    const order = uncertainSubmissionOrder({ id: `independent-bound-${policy.minimumNotFoundObservations}-${policy.minimumElapsedMs}` });
    await repositories.saveOrder(order);
    let now = { observedAt: "2026-08-21T00:00:01.000Z", observedAtEpochMs: 1_787_270_401_000 };
    const firstService = new ReconciliationService({
      repositories,
      operatorState,
      orderReader: { async getOrder() { return null; } },
      identifierRecovery: policy,
      recoveryClock: { now: () => now },
    });
    const first = await firstService.recoverOrderByIdentifier(order);
    now = { observedAt: "2026-08-21T00:01:01.000Z", observedAtEpochMs: 1_787_270_461_000 };
    const restartedService = new ReconciliationService({
      repositories,
      operatorState,
      orderReader: { async getOrder() { return null; } },
      identifierRecovery: policy,
      recoveryClock: { now: () => now },
    });
    const second = await restartedService.recoverOrderByIdentifier(order);

    assert.equal(first.outcome, "STILL_UNCERTAIN");
    assert.equal(second.outcome, "STILL_UNCERTAIN");
    assert.equal((await repositories.findOrderByReference("primary", order.id))?.status, "RECONCILIATION_REQUIRED");
    assert.equal((await operatorState.getState()).systemStatus, "RUNNING");
  }
});

test("bounded absence finalization loses its compare-and-set to a concurrent recovered order", async () => {
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-absence-cas-loss",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const repositories = new InMemoryExecutionRepository(operatorState);
  const order = uncertainSubmissionOrder({ id: "absence-cas-loss-order" });
  await repositories.saveOrder(order);
  let now = { observedAt: "2026-08-21T00:00:01.000Z", observedAtEpochMs: 1_787_270_401_000 };
  const reconciliation = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: { async getOrder() { return null; } },
    identifierRecovery: { minimumNotFoundObservations: 2, minimumElapsedMs: 60_000 },
    recoveryClock: { now: () => now },
  });

  await reconciliation.recoverOrderByIdentifier(order);
  const finalizer = repositories.finalizeBoundedSubmissionAbsence.bind(repositories);
  repositories.finalizeBoundedSubmissionAbsence = async (input) => {
    await repositories.updateOrder({
      ...(await repositories.findOrderByReference("primary", order.id))!,
      status: "FILLED",
      failureCode: null,
      failureMessage: null,
      updatedAt: "2026-08-21T00:01:01.000Z",
    });
    return finalizer(input);
  };
  now = { observedAt: "2026-08-21T00:01:01.000Z", observedAtEpochMs: 1_787_270_461_000 };

  const result = await reconciliation.recoverOrderByIdentifier(order);

  assert.equal(result.outcome, "STILL_UNCERTAIN");
  assert.equal((await repositories.findOrderByReference("primary", order.id))?.status, "FILLED");
  assert.equal((await operatorState.getState()).systemStatus, "RUNNING");
  assert.equal(
    (await repositories.listOrderEvents(order.id))
      .filter((event) => event.eventType === "RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED").length,
    0,
  );
});

test("transient identifier lookup failures never count toward bounded absence", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = pausedUncertainSubmissionState();
  const order = uncertainSubmissionOrder({ id: "transient-absence-order" });
  await repositories.saveOrder(order);
  let now = {
    observedAt: "2026-08-21T00:00:01.000Z",
    observedAtEpochMs: 1_787_270_401_000,
  };
  let attempt = 0;
  const reconciliation = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        attempt += 1;
        if (attempt === 1) throw new ExchangeOrderLookupError({ kind: "TRANSIENT", status: null });
        return null;
      },
    },
    identifierRecovery: {
      minimumNotFoundObservations: 2,
      minimumElapsedMs: 60_000,
    },
    recoveryClock: { now: () => now },
  });

  const transient = await reconciliation.recoverOrderByIdentifier(order);
  now = {
    observedAt: "2026-08-21T00:01:01.000Z",
    observedAtEpochMs: 1_787_270_461_000,
  };
  const absence = await reconciliation.recoverOrderByIdentifier(order);
  const observations = await repositories.listOrderSubmissionRecoveryObservations(order.id);

  assert.equal(transient.outcome, "TRANSIENT_FAILURE");
  assert.equal(absence.outcome, "STILL_UNCERTAIN");
  assert.deepEqual(observations.map((observation) => observation.outcome), ["TRANSIENT_FAILURE", "NOT_FOUND"]);
  assert.equal((await repositories.findOrderByReference("primary", order.id))?.status, "RECONCILIATION_REQUIRED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
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

function buildHistorySnapshot(index: number) {
  return {
    uuid: `uuid-history-page-${index}`,
    identifier: null,
    market: "KRW-BTC" as const,
    side: "bid" as const,
    ordType: "limit" as const,
    state: "done",
    price: "100000000",
    volume: "0.01",
    remainingVolume: "0",
    executedVolume: "0.01",
    paidFee: "500",
    createdAt: `2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`,
    fills: [],
    raw: {
      state: "done",
      index,
    },
  };
}
