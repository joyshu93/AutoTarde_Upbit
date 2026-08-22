import assert from "node:assert/strict";

import { CandidateBtcRunPreparationService } from "../src/app/candidate-btc-run-preparation.js";
import type { AppConfig } from "../src/app/env.js";
import type { PositionGuardPilotRefreshReceipt } from "../src/domain/pilot-types.js";
import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  OrderRecord,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
} from "../src/domain/types.js";
import type { PortfolioSyncRunResult } from "../src/modules/reconciliation/portfolio-sync-service.js";
import { test } from "./harness.js";

const REQUESTED_AT = "2026-08-22T00:00:00.000Z";
const CHECKED_AT = "2026-08-22T00:00:01.000Z";

test("candidate preparation refreshes once then evaluates exact refreshed evidence and returns a frozen READY receipt", async () => {
  const trace: string[] = [];
  const freshResult = createSyncResult();
  const preparation = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run(input) {
        trace.push(`refresh:${input.requestedAt}`);
        assert.deepEqual(input, {
          exchangeAccountId: "primary",
          source: "SCHEDULER_PREFLIGHT",
          requestedAt: REQUESTED_AT,
        });
        return freshResult;
      },
    },
    operatorState: {
      async getState() {
        trace.push("state");
        return createExecutionState();
      },
    },
    repositories: {
      async listActiveOrders() {
        trace.push("orders");
        return [];
      },
    },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => {
      trace.push("checked-at");
      return CHECKED_AT;
    },
  });

  const result = await preparation.prepare({
    exchangeAccountId: "primary",
    requestedAt: REQUESTED_AT,
    requestedBy: "TELEGRAM",
  });

  assert.deepEqual(trace, [
    `refresh:${REQUESTED_AT}`,
    "state",
    "orders",
    "checked-at",
  ]);
  assert.equal(result.status, "READY");
  if (result.status !== "READY") throw new Error("expected READY");
  assert.deepEqual(result.refreshReceipt, createReceipt());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.refreshReceipt), true);
  assert.notEqual(result.refreshReceipt, freshResult as unknown as PositionGuardPilotRefreshReceipt);
});

test("candidate preparation returns BLOCKED with deterministic blocking checks and does not substitute newer records", async () => {
  const preparation = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run() {
        return createSyncResult({
          balanceSnapshot: { ...createBalanceSnapshot(), id: "exact-balance" },
          positionSnapshot: { ...createPositionSnapshot(), id: "exact-position" },
          reconciliationRun: createReconciliationRun({ id: "exact-reconciliation" }),
        });
      },
    },
    operatorState: { async getState() { return createExecutionState(); } },
    repositories: {
      async listActiveOrders() {
        return [createOrder()];
      },
    },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });

  const result = await preparation.prepare({
    exchangeAccountId: "primary",
    requestedAt: REQUESTED_AT,
    requestedBy: "SCHEDULER",
  });

  assert.deepEqual(result, {
    status: "BLOCKED",
    detail: "Candidate BTC run blocked by active_orders.",
  });
  assert.equal(Object.isFrozen(result), true);
});

test("candidate preparation returns READY when exact reconciliation evidence is a non-blocking WARN", async () => {
  const preparation = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run() {
        return createSyncResult({
          reconciliationSummary: {
            source: "SCHEDULER_PREFLIGHT",
            status: "DRIFT_DETECTED",
            issues: [{ code: "ORDER_STATUS_RECONCILED", message: "terminal state was reconciled" }],
            candidateCount: 0,
            processedCount: 0,
            deferredCount: 0,
            maxOrderLookupsPerRun: 10,
          },
          reconciliationRun: createReconciliationRun({
            status: "DRIFT_DETECTED",
            summaryJson: JSON.stringify({
              source: "SCHEDULER_PREFLIGHT",
              status: "DRIFT_DETECTED",
              issues: [{ code: "ORDER_STATUS_RECONCILED", message: "terminal state was reconciled" }],
              candidateCount: 0,
              processedCount: 0,
              deferredCount: 0,
              maxOrderLookupsPerRun: 10,
            }),
          }),
        });
      },
    },
    operatorState: { async getState() { return createExecutionState(); } },
    repositories: { async listActiveOrders() { return []; } },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });

  const result = await preparation.prepare({
    exchangeAccountId: "primary",
    requestedAt: REQUESTED_AT,
    requestedBy: "TELEGRAM",
  });

  assert.equal(result.status, "READY");
});

test("candidate preparation fails closed when refresh evidence is not exact candidate authority", async () => {
  let stateReads = 0;
  const preparation = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run() {
        return createSyncResult({
          reconciliationRun: createReconciliationRun({ exchangeAccountId: "other" }),
        });
      },
    },
    operatorState: {
      async getState() {
        stateReads += 1;
        return createExecutionState();
      },
    },
    repositories: { async listActiveOrders() { return []; } },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });

  await assert.rejects(
    preparation.prepare({
      exchangeAccountId: "primary",
      requestedAt: REQUESTED_AT,
      requestedBy: "TELEGRAM",
    }),
    /reconciliation run exchangeAccountId must match the request/,
  );
  assert.equal(stateReads, 0);
});

function createSyncResult(overrides: Partial<PortfolioSyncRunResult> = {}): PortfolioSyncRunResult {
  return {
    requestedAt: REQUESTED_AT,
    valuationSource: "public_ticker",
    balanceSnapshot: createBalanceSnapshot(),
    positionSnapshot: createPositionSnapshot(),
    previousBalanceSnapshot: null,
    previousPositionSnapshot: null,
    reconciliationSummary: {
      source: "SCHEDULER_PREFLIGHT",
      status: "SUCCESS",
      issues: [],
      candidateCount: 0,
      processedCount: 0,
      deferredCount: 0,
      maxOrderLookupsPerRun: 10,
    },
    reconciliationRun: createReconciliationRun(),
    ...overrides,
  };
}

function createBalanceSnapshot(overrides: Partial<BalanceSnapshotRecord> = {}): BalanceSnapshotRecord {
  return {
    id: "balance-1",
    exchangeAccountId: "primary",
    capturedAt: REQUESTED_AT,
    source: "RECONCILIATION",
    totalKrwValue: "10000",
    balancesJson: "[]",
    ...overrides,
  };
}

function createPositionSnapshot(overrides: Partial<PositionSnapshotRecord> = {}): PositionSnapshotRecord {
  return {
    id: "position-1",
    exchangeAccountId: "primary",
    capturedAt: REQUESTED_AT,
    source: "RECONCILIATION",
    positionsJson: "[]",
    ...overrides,
  };
}

function createReconciliationRun(overrides: Partial<ReconciliationRunRecord> = {}): ReconciliationRunRecord {
  return {
    id: "reconciliation-1",
    exchangeAccountId: "primary",
    status: "SUCCESS",
    startedAt: REQUESTED_AT,
    completedAt: CHECKED_AT,
    summaryJson: JSON.stringify({ source: "SCHEDULER_PREFLIGHT", status: "SUCCESS", issues: [] }),
    errorMessage: null,
    ...overrides,
  };
}

function createReceipt(): PositionGuardPilotRefreshReceipt {
  return {
    exchangeAccountId: "primary",
    requestedAt: REQUESTED_AT,
    balanceSnapshotId: "balance-1",
    balanceCapturedAt: REQUESTED_AT,
    positionSnapshotId: "position-1",
    positionCapturedAt: REQUESTED_AT,
    reconciliationRunId: "reconciliation-1",
    reconciliationStartedAt: REQUESTED_AT,
    reconciliationCompletedAt: CHECKED_AT,
    reconciliationSource: "SCHEDULER_PREFLIGHT",
  };
}

function createExecutionState(overrides: Partial<ExecutionStateRecord> = {}): ExecutionStateRecord {
  return {
    id: "state-1",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: REQUESTED_AT,
    ...overrides,
  };
}

function createOrder(): OrderRecord {
  return {
    id: "active-order-1",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "5000",
    timeInForce: null,
    smpType: null,
    identifier: "active-order-1",
    idempotencyKey: "active-order-1",
    origin: "STRATEGY",
    requestedAt: REQUESTED_AT,
    strategyDecisionId: null,
    upbitUuid: null,
    status: "OPEN",
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: REQUESTED_AT,
    updatedAt: REQUESTED_AT,
  };
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    serviceName: "AutoTrade_Upbit",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    positionGuardPolicySelection: { kind: "BASELINE", pilotId: null },
    globalKillSwitch: false,
    upbitBaseUrl: "https://api.upbit.com",
    databasePath: "./var/test.sqlite",
    telegramLocale: "ko-KR",
    telegramDeliveryEnabled: false,
    telegramBotToken: null,
    telegramOperatorChatId: null,
    telegramDeliveryMaxAttempts: 5,
    telegramDeliveryBaseBackoffMs: 15_000,
    telegramDeliveryMaxBackoffMs: 300_000,
    telegramDeliveryLeaseMs: 30_000,
    accountExecutionLeaseMs: 30_000,
    telegramInboundPollingEnabled: false,
    telegramInboundPollIntervalMs: 2_000,
    telegramInboundPollTimeoutSeconds: 25,
    telegramInboundPollLimit: 10,
    deprecatedIgnoredEnvVars: [],
    strategySchedulerEnabled: false,
    strategySchedulerRunOnStart: false,
    strategySchedulerBtcIntervalMs: 3_600_000,
    strategySchedulerEthIntervalMs: 3_600_000,
    reconciliationMaxOrderLookupsPerRun: 10,
    reconciliationHistoryMaxPagesPerMarket: 3,
    reconciliationClosedOrderLookbackDays: 7,
    reconciliationHistoryStopBeforeDays: 365,
    reconciliationHistoryRetentionAssumptionDays: 365,
    stalePriceThresholdMs: 30_000,
    minimumOrderValueKrw: 5_000,
    maxAllocationByAsset: { BTC: 0.6, ETH: 0.6 },
    totalExposureCap: 0.75,
    ...overrides,
  };
}
