import assert from "node:assert/strict";

import { buildManualStrategyRunPreflight, buildStrategySchedulerStartupPreflight } from "../src/app/scheduler-preflight.js";
import type { AppConfig } from "../src/app/env.js";
import type { ExecutionStateRecord, OrderRecord, ReconciliationRunRecord } from "../src/domain/types.js";
import { InMemoryExecutionRepository } from "../src/modules/db/repositories/in-memory-repositories.js";
import { test } from "./harness.js";

test("scheduler startup preflight does not block dry-run scheduler startup", async () => {
  const repository = new InMemoryExecutionRepository();

  const preflight = await buildStrategySchedulerStartupPreflight({
    config: createConfig({
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      strategySchedulerEnabled: true,
    }),
    exchangeAccountId: "primary",
    executionState: createExecutionState({
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
    }),
    repositories: repository,
    exchangeBackedReadEnabled: false,
    liveSendPath: "DRY_RUN_ADAPTER",
    checkedAt: "2026-05-08T00:00:00.000Z",
  });

  assert.equal(preflight.scope, "DRY_RUN");
  assert.equal(preflight.status, "PASS");
});

test("scheduler startup preflight blocks live scheduler while execution is still on dry-run adapter", async () => {
  const repository = new InMemoryExecutionRepository();
  await seedReadyPortfolio(repository);

  const preflight = await buildStrategySchedulerStartupPreflight({
    config: createConfig({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      strategySchedulerEnabled: true,
    }),
    exchangeAccountId: "primary",
    executionState: createExecutionState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
    }),
    repositories: repository,
    exchangeBackedReadEnabled: true,
    liveSendPath: "DRY_RUN_ADAPTER",
    checkedAt: "2026-05-08T00:00:00.000Z",
  });

  assert.equal(preflight.scope, "LIVE");
  assert.equal(preflight.status, "BLOCK");
  assert.match(preflight.detail, /live_send_path/);
  assert.equal(preflight.checks.find((check) => check.name === "live_send_path")?.status, "BLOCK");
});

test("scheduler startup preflight blocks live scheduler on active orders", async () => {
  const repository = new InMemoryExecutionRepository();
  await seedReadyPortfolio(repository);
  await repository.saveOrder(createOrder({ status: "OPEN" }));

  const preflight = await buildStrategySchedulerStartupPreflight({
    config: createConfig({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      strategySchedulerEnabled: true,
    }),
    exchangeAccountId: "primary",
    executionState: createExecutionState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
    }),
    repositories: repository,
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    checkedAt: "2026-05-08T00:00:00.000Z",
  });

  assert.equal(preflight.status, "BLOCK");
  assert.equal(preflight.checks.find((check) => check.name === "active_orders")?.status, "BLOCK");
});

test("scheduler startup preflight treats recovered exchange history as warning, not live blocker", async () => {
  const repository = new InMemoryExecutionRepository();
  await seedReadyPortfolio(repository, createReconciliationRun({
    status: "DRIFT_DETECTED",
    summaryJson: JSON.stringify({
      issues: [
        { code: "EXCHANGE_ORDER_RECOVERED" },
        { code: "TERMINAL_ORDER_RECHECKED" },
        { code: "ORDER_FILLS_BACKFILLED" },
      ],
    }),
  }));

  const preflight = await buildStrategySchedulerStartupPreflight({
    config: createConfig({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      strategySchedulerEnabled: true,
    }),
    exchangeAccountId: "primary",
    executionState: createExecutionState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
    }),
    repositories: repository,
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    checkedAt: "2026-05-08T00:00:00.000Z",
  });

  assert.equal(preflight.status, "WARN");
  assert.equal(preflight.checks.find((check) => check.name === "latest_reconciliation")?.status, "WARN");
});

test("scheduler startup preflight blocks live scheduler when persisted health is stale", async () => {
  const repository = new InMemoryExecutionRepository();
  await seedReadyPortfolio(repository);

  const preflight = await buildStrategySchedulerStartupPreflight({
    config: createConfig({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      strategySchedulerEnabled: true,
      strategySchedulerBtcIntervalMs: 3_600_000,
      strategySchedulerEthIntervalMs: 3_600_000,
    }),
    exchangeAccountId: "primary",
    executionState: createExecutionState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
    }),
    repositories: repository,
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    checkedAt: "2026-05-08T02:00:01.000Z",
  });

  assert.equal(preflight.status, "BLOCK");
  assert.equal(preflight.checks.find((check) => check.name === "balance_snapshot")?.status, "BLOCK");
  assert.equal(preflight.checks.find((check) => check.name === "position_snapshot")?.status, "BLOCK");
  assert.equal(preflight.checks.find((check) => check.name === "latest_reconciliation")?.status, "BLOCK");
  assert.match(preflight.detail, /balance_snapshot/);
});

test("manual strategy run preflight blocks live run even when scheduler is disabled", async () => {
  const repository = new InMemoryExecutionRepository();
  await seedReadyPortfolio(repository);
  await repository.saveOrder(createOrder({ status: "OPEN" }));

  const preflight = await buildManualStrategyRunPreflight({
    config: createConfig({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      strategySchedulerEnabled: false,
    }),
    exchangeAccountId: "primary",
    executionState: createExecutionState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
    }),
    repositories: repository,
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    checkedAt: "2026-05-08T00:00:00.000Z",
  });

  assert.equal(preflight.scope, "LIVE");
  assert.equal(preflight.status, "BLOCK");
  assert.match(preflight.detail, /Live manual \/run blocked by active_orders/);
  assert.equal(preflight.checks.find((check) => check.name === "active_orders")?.status, "BLOCK");
});

async function seedReadyPortfolio(
  repository: InMemoryExecutionRepository,
  reconciliationRun: ReconciliationRunRecord = createReconciliationRun({ status: "SUCCESS" }),
): Promise<void> {
  await repository.saveBalanceSnapshot({
    id: "balance-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-05-08T00:00:00.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "10000",
    balancesJson: "[]",
  });
  await repository.savePositionSnapshot({
    id: "position-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-05-08T00:00:00.000Z",
    source: "RECONCILIATION",
    positionsJson: "[]",
  });
  await repository.saveReconciliationRun(reconciliationRun);
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    serviceName: "AutoTrade_Upbit",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    globalKillSwitch: false,
    upbitBaseUrl: "https://api.upbit.com",
    databasePath: "./var/autotrade-upbit.sqlite",
    telegramDeliveryEnabled: false,
    telegramBotToken: null,
    telegramOperatorChatId: null,
    telegramDeliveryMaxAttempts: 5,
    telegramDeliveryBaseBackoffMs: 15_000,
    telegramDeliveryMaxBackoffMs: 300_000,
    telegramDeliveryLeaseMs: 30_000,
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
    maxAllocationByAsset: {
      BTC: 0.6,
      ETH: 0.6,
    },
    totalExposureCap: 0.75,
    ...overrides,
  };
}

function createExecutionState(overrides: Partial<ExecutionStateRecord> = {}): ExecutionStateRecord {
  return {
    id: "execution-state-1",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

function createReconciliationRun(overrides: Partial<ReconciliationRunRecord>): ReconciliationRunRecord {
  return {
    id: "reconciliation-run-1",
    exchangeAccountId: "primary",
    status: "SUCCESS",
    startedAt: "2026-05-08T00:00:00.000Z",
    completedAt: "2026-05-08T00:00:00.000Z",
    summaryJson: JSON.stringify({ issues: [] }),
    errorMessage: null,
    ...overrides,
  };
}

function createOrder(overrides: Partial<OrderRecord>): OrderRecord {
  return {
    id: "order-1",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "5000",
    timeInForce: null,
    smpType: null,
    identifier: "order-1",
    idempotencyKey: "idem-1",
    origin: "STRATEGY",
    requestedAt: "2026-05-08T00:00:00.000Z",
    strategyDecisionId: null,
    upbitUuid: null,
    status: "OPEN",
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}
