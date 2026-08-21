import assert from "node:assert/strict";

import type { AppConfig } from "../src/app/env.js";
import type { ExecutionStateRecord, ReconciliationRunRecord } from "../src/domain/types.js";
import {
  applyDryRunReadinessSmokeSafetyEnv,
  buildDryRunReadinessNextActions,
  buildDryRunReadinessSmokeChecks,
  summarizeDryRunReadinessSmokeStatus,
  validateDryRunReadinessSmokeSafety,
} from "../src/smoke/dryrun-readiness.js";
import { test } from "./harness.js";

test("dry-run readiness smoke env forces dry-run mode and preserves configured integrations", () => {
  const env: NodeJS.ProcessEnv = {
    APP_EXECUTION_MODE: "LIVE",
    ENABLE_LIVE_ORDERS: "true",
    STRATEGY_SCHEDULER_ENABLED: "true",
    STRATEGY_SCHEDULER_RUN_ON_START: "true",
    ENABLE_TELEGRAM_DELIVERY: "true",
    ENABLE_TELEGRAM_INBOUND_POLLING: "true",
    UPBIT_ACCESS_KEY: "configured-access",
    UPBIT_SECRET_KEY: "configured-secret",
  };

  const report = applyDryRunReadinessSmokeSafetyEnv(env);

  assert.equal(report.previous.APP_EXECUTION_MODE, "LIVE");
  assert.equal(env.APP_EXECUTION_MODE, "DRY_RUN");
  assert.equal(env.ENABLE_LIVE_ORDERS, "false");
  assert.equal(env.STRATEGY_SCHEDULER_ENABLED, "false");
  assert.equal(env.STRATEGY_SCHEDULER_RUN_ON_START, "false");
  assert.equal(env.ENABLE_TELEGRAM_DELIVERY, "true");
  assert.equal(env.ENABLE_TELEGRAM_INBOUND_POLLING, "true");
  assert.equal(env.UPBIT_ACCESS_KEY, "configured-access");
  assert.equal(env.UPBIT_SECRET_KEY, "configured-secret");
  assert.equal(env.DATABASE_PATH, "./var/dryrun-readiness-smoke.sqlite");
});

test("dry-run readiness smoke safety validator blocks live and scheduler settings", () => {
  const blockers = validateDryRunReadinessSmokeSafety({
    config: createConfig({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      strategySchedulerEnabled: true,
      strategySchedulerRunOnStart: true,
    }),
    liveSendPath: "LIVE_ADAPTER",
  });

  assert.deepEqual(blockers, [
    "APP_EXECUTION_MODE must resolve to DRY_RUN for dry-run readiness.",
    "ENABLE_LIVE_ORDERS must resolve to DISABLED for dry-run readiness.",
    "liveSendPath must remain DRY_RUN_ADAPTER for dry-run readiness.",
    "STRATEGY_SCHEDULER_ENABLED must be false for dry-run readiness.",
    "STRATEGY_SCHEDULER_RUN_ON_START must be false for dry-run readiness.",
  ]);
});

test("dry-run readiness smoke warns for missing integration evidence without blocking dry-run safety", () => {
  const checks = buildDryRunReadinessSmokeChecks({
    app: {
      config: createConfig(),
      exchangeBackedReadEnabled: false,
      liveSendPath: "DRY_RUN_ADAPTER",
      notificationDelivery: {
        isConfigured: () => false,
      },
      telegramInboundPolling: {
        isConfigured: () => false,
      },
    },
    executionState: createExecutionState(),
    seedMismatches: [],
    safetyBlockers: [],
    activeOrderCount: 0,
    latestBalanceSnapshotAt: null,
    latestPositionSnapshotAt: null,
    latestReconciliationRun: null,
    latestReconciliationIssueCodes: [],
    latestReconciliationBlockingIssueCodes: [],
    recentRiskBlockCount: 0,
    pendingNotificationCount: 0,
  });

  assert.equal(summarizeDryRunReadinessSmokeStatus(checks), "WARN");
  assert.equal(checks.find((check) => check.name === "dry_run_safety_env")?.status, "PASS");
  assert.equal(checks.find((check) => check.name === "upbit_read_credentials")?.status, "WARN");
  assert.equal(checks.find((check) => check.name === "balance_snapshot")?.status, "WARN");
  assert.deepEqual(buildDryRunReadinessNextActions(checks), [
    "Configure UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY in the local DRY_RUN script before exchange-backed /sync.",
    "Configure TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_CHAT_ID in the local DRY_RUN script before bot operation.",
    "After starting the DRY_RUN runtime, run /sync, then re-check /readiness before /run BTC|ETH.",
  ]);
});

test("dry-run readiness smoke passes with configured integrations and clean persisted evidence", () => {
  const checks = buildDryRunReadinessSmokeChecks({
    app: {
      config: createConfig({
        telegramDeliveryEnabled: true,
        telegramInboundPollingEnabled: true,
      }),
      exchangeBackedReadEnabled: true,
      liveSendPath: "DRY_RUN_ADAPTER",
      notificationDelivery: {
        isConfigured: () => true,
      },
      telegramInboundPolling: {
        isConfigured: () => true,
      },
    },
    executionState: createExecutionState(),
    seedMismatches: [],
    safetyBlockers: [],
    activeOrderCount: 0,
    latestBalanceSnapshotAt: "2026-05-11T00:00:00.000Z",
    latestPositionSnapshotAt: "2026-05-11T00:00:00.000Z",
    latestReconciliationRun: createReconciliationRun({ status: "SUCCESS" }),
    latestReconciliationIssueCodes: [],
    latestReconciliationBlockingIssueCodes: [],
    recentRiskBlockCount: 0,
    pendingNotificationCount: 0,
  });

  assert.equal(summarizeDryRunReadinessSmokeStatus(checks), "PASS");
  assert.deepEqual(buildDryRunReadinessNextActions(checks), [
    "DRY_RUN readiness has no blockers or warnings. Start the local DRY_RUN runtime and run operator checks.",
  ]);
});

test("dry-run readiness smoke blocks persisted drift issue codes", () => {
  const checks = buildDryRunReadinessSmokeChecks({
    app: {
      config: createConfig(),
      exchangeBackedReadEnabled: true,
      liveSendPath: "DRY_RUN_ADAPTER",
      notificationDelivery: {
        isConfigured: () => true,
      },
      telegramInboundPolling: {
        isConfigured: () => true,
      },
    },
    executionState: createExecutionState(),
    seedMismatches: [],
    safetyBlockers: [],
    activeOrderCount: 0,
    latestBalanceSnapshotAt: "2026-05-11T00:00:00.000Z",
    latestPositionSnapshotAt: "2026-05-11T00:00:00.000Z",
    latestReconciliationRun: createReconciliationRun({ status: "DRIFT_DETECTED" }),
    latestReconciliationIssueCodes: ["BALANCE_DRIFT_DETECTED"],
    latestReconciliationBlockingIssueCodes: ["BALANCE_DRIFT_DETECTED"],
    recentRiskBlockCount: 0,
    pendingNotificationCount: 0,
  });

  assert.equal(summarizeDryRunReadinessSmokeStatus(checks), "BLOCK");
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
