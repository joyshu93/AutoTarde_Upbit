import assert from "node:assert/strict";

import type { AppConfig } from "../src/app/env.js";
import type { ExecutionStateRecord, ReconciliationRunRecord } from "../src/domain/types.js";
import {
  buildLiveReadinessNextActions,
  buildLiveReadinessSmokeChecks,
  summarizeLiveReadinessSmokeStatus,
} from "../src/smoke/live-readiness.js";
import { test } from "./harness.js";

test("live readiness smoke checks block default dry-run wiring", () => {
  const checks = buildLiveReadinessSmokeChecks({
    app: {
      config: createConfig(),
      exchangeBackedReadEnabled: false,
      liveSendPath: "DRY_RUN_ADAPTER",
    },
    executionState: createExecutionState(),
    seedMismatches: [],
    activeOrderCount: 0,
    latestBalanceSnapshotAt: null,
    latestPositionSnapshotAt: null,
    latestReconciliationRun: null,
    latestReconciliationIssueCodes: [],
    latestReconciliationBlockingIssueCodes: [],
  });

  assert.equal(summarizeLiveReadinessSmokeStatus(checks), "BLOCK");
  assert.equal(checks.find((check) => check.name === "non_mutation_boundary")?.status, "PASS");
  assert.equal(checks.find((check) => check.name === "live_mode")?.status, "BLOCK");
  assert.equal(checks.find((check) => check.name === "live_gate")?.status, "BLOCK");
  assert.equal(checks.find((check) => check.name === "live_send_path")?.status, "BLOCK");
  assert.deepEqual(buildLiveReadinessNextActions(checks).slice(0, 4), [
    "Set APP_EXECUTION_MODE=LIVE in the local live script before running this smoke.",
    "Set ENABLE_LIVE_ORDERS=true only in the local live script after confirming real-order intent.",
    "Configure UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY in the local script; never commit those values.",
    "Resolve mode, live gate, and Upbit credential blockers until liveSendPath becomes LIVE_ADAPTER.",
  ]);
});

test("live readiness smoke checks pass only for explicitly gated live wiring", () => {
  const checks = buildLiveReadinessSmokeChecks({
    app: {
      config: createConfig({
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
      }),
      exchangeBackedReadEnabled: true,
      liveSendPath: "LIVE_ADAPTER",
    },
    executionState: createExecutionState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
    }),
    seedMismatches: [],
    activeOrderCount: 0,
    latestBalanceSnapshotAt: "2026-05-11T00:00:00.000Z",
    latestPositionSnapshotAt: "2026-05-11T00:00:00.000Z",
    latestReconciliationRun: createReconciliationRun({ status: "SUCCESS" }),
    latestReconciliationIssueCodes: [],
    latestReconciliationBlockingIssueCodes: [],
  });

  assert.equal(summarizeLiveReadinessSmokeStatus(checks), "PASS");
  assert.equal(checks.every((check) => check.status === "PASS"), true);
  assert.deepEqual(buildLiveReadinessNextActions(checks), [
    "Live readiness smoke has no blocking or warning actions. Continue with scheduler disabled until operator checks pass.",
  ]);
});

test("live readiness smoke blocks automatic scheduler startup during validation", () => {
  const checks = buildLiveReadinessSmokeChecks({
    app: {
      config: createConfig({
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
        strategySchedulerEnabled: true,
        strategySchedulerRunOnStart: true,
      }),
      exchangeBackedReadEnabled: true,
      liveSendPath: "LIVE_ADAPTER",
    },
    executionState: createExecutionState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
    }),
    seedMismatches: [],
    activeOrderCount: 0,
    latestBalanceSnapshotAt: "2026-05-11T00:00:00.000Z",
    latestPositionSnapshotAt: "2026-05-11T00:00:00.000Z",
    latestReconciliationRun: createReconciliationRun({ status: "SUCCESS" }),
    latestReconciliationIssueCodes: [],
    latestReconciliationBlockingIssueCodes: [],
  });

  assert.equal(summarizeLiveReadinessSmokeStatus(checks), "BLOCK");
  assert.equal(checks.find((check) => check.name === "scheduler_disabled_for_validation")?.status, "BLOCK");
  assert.equal(checks.find((check) => check.name === "scheduler_run_on_start_disabled")?.status, "BLOCK");
  assert.deepEqual(buildLiveReadinessNextActions(checks), [
    "Set STRATEGY_SCHEDULER_ENABLED=false for live validation; enable the scheduler only after separate approval.",
    "Set STRATEGY_SCHEDULER_RUN_ON_START=false so startup cannot immediately trigger a strategy cycle.",
  ]);
});

test("live readiness smoke next actions guide snapshot warnings without blocking", () => {
  const checks = buildLiveReadinessSmokeChecks({
    app: {
      config: createConfig({
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
      }),
      exchangeBackedReadEnabled: true,
      liveSendPath: "LIVE_ADAPTER",
    },
    executionState: createExecutionState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
    }),
    seedMismatches: [],
    activeOrderCount: 0,
    latestBalanceSnapshotAt: null,
    latestPositionSnapshotAt: null,
    latestReconciliationRun: null,
    latestReconciliationIssueCodes: [],
    latestReconciliationBlockingIssueCodes: [],
  });

  assert.equal(summarizeLiveReadinessSmokeStatus(checks), "WARN");
  assert.deepEqual(buildLiveReadinessNextActions(checks), [
    "After the live process starts with scheduler disabled, run /sync and re-check /readiness before /run.",
  ]);
});

test("live readiness smoke blocks reconciliation drift issue codes", () => {
  const checks = buildLiveReadinessSmokeChecks({
    app: {
      config: createConfig({
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
      }),
      exchangeBackedReadEnabled: true,
      liveSendPath: "LIVE_ADAPTER",
    },
    executionState: createExecutionState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
    }),
    seedMismatches: [],
    activeOrderCount: 0,
    latestBalanceSnapshotAt: "2026-05-11T00:00:00.000Z",
    latestPositionSnapshotAt: "2026-05-11T00:00:00.000Z",
    latestReconciliationRun: createReconciliationRun({ status: "DRIFT_DETECTED" }),
    latestReconciliationIssueCodes: ["BALANCE_DRIFT_DETECTED"],
    latestReconciliationBlockingIssueCodes: ["BALANCE_DRIFT_DETECTED"],
  });

  assert.equal(summarizeLiveReadinessSmokeStatus(checks), "BLOCK");
  assert.equal(checks.find((check) => check.name === "latest_reconciliation")?.status, "BLOCK");
});

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    serviceName: "AutoTrade_Upbit",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    positionGuardPolicySelection: { kind: "BASELINE", pilotId: null },
    globalKillSwitch: false,
    upbitBaseUrl: "https://api.upbit.com",
    databasePath: "./var/autotrade-upbit.sqlite",
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
    id: "execution_state_primary",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-05-11T00:00:00.000Z",
    ...overrides,
  };
}

function createReconciliationRun(
  overrides: Partial<ReconciliationRunRecord> = {},
): ReconciliationRunRecord {
  return {
    id: "reconciliation_run_test",
    exchangeAccountId: "primary",
    status: "SUCCESS",
    startedAt: "2026-05-11T00:00:00.000Z",
    completedAt: "2026-05-11T00:00:01.000Z",
    summaryJson: "{\"issues\":[]}",
    errorMessage: null,
    ...overrides,
  };
}
