import assert from "node:assert/strict";

import type { AppConfig } from "../src/app/env.js";
import type {
  ExecutionStateRecord,
  ReconciliationRunRecord,
  StrategySchedulerRunRecord,
} from "../src/domain/types.js";
import {
  applyDryRunCompletionSmokeSafetyEnv,
  buildDryRunCompletionNextActions,
  buildDryRunCompletionSmokeChecks,
  buildSchedulerMarketEvidence,
  summarizeDryRunCompletionSmokeStatus,
  validateDryRunCompletionSmokeSafety,
} from "../src/smoke/dryrun-completion.js";
import { test } from "./harness.js";

test("dry-run completion smoke env forces non-mutating dry-run settings and preserves credentials", () => {
  const env: NodeJS.ProcessEnv = {
    APP_EXECUTION_MODE: "LIVE",
    ENABLE_LIVE_ORDERS: "true",
    ENABLE_TELEGRAM_DELIVERY: "true",
    ENABLE_TELEGRAM_INBOUND_POLLING: "true",
    STRATEGY_SCHEDULER_ENABLED: "true",
    STRATEGY_SCHEDULER_RUN_ON_START: "true",
    UPBIT_ACCESS_KEY: "configured-access",
    UPBIT_SECRET_KEY: "configured-secret",
    TELEGRAM_BOT_TOKEN: "configured-token",
    TELEGRAM_OPERATOR_CHAT_ID: "configured-chat",
  };

  const report = applyDryRunCompletionSmokeSafetyEnv(env);

  assert.equal(report.previous.APP_EXECUTION_MODE, "LIVE");
  assert.equal(env.APP_EXECUTION_MODE, "DRY_RUN");
  assert.equal(env.ENABLE_LIVE_ORDERS, "false");
  assert.equal(env.ENABLE_TELEGRAM_DELIVERY, "false");
  assert.equal(env.ENABLE_TELEGRAM_INBOUND_POLLING, "false");
  assert.equal(env.STRATEGY_SCHEDULER_ENABLED, "false");
  assert.equal(env.STRATEGY_SCHEDULER_RUN_ON_START, "false");
  assert.equal(env.UPBIT_ACCESS_KEY, "configured-access");
  assert.equal(env.UPBIT_SECRET_KEY, "configured-secret");
  assert.equal(env.TELEGRAM_BOT_TOKEN, "configured-token");
  assert.equal(env.TELEGRAM_OPERATOR_CHAT_ID, "configured-chat");
  assert.equal(env.DATABASE_PATH, "./var/dryrun-completion-smoke.sqlite");
});

test("dry-run completion smoke safety validator blocks live, telegram transport, and scheduler settings", () => {
  const blockers = validateDryRunCompletionSmokeSafety({
    config: createConfig({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      telegramDeliveryEnabled: true,
      telegramInboundPollingEnabled: true,
      strategySchedulerEnabled: true,
      strategySchedulerRunOnStart: true,
    }),
    liveSendPath: "LIVE_ADAPTER",
  });

  assert.deepEqual(blockers, [
    "APP_EXECUTION_MODE must resolve to DRY_RUN for dry-run completion.",
    "ENABLE_LIVE_ORDERS must resolve to DISABLED for dry-run completion.",
    "liveSendPath must remain DRY_RUN_ADAPTER for dry-run completion.",
    "ENABLE_TELEGRAM_DELIVERY must be false for dry-run completion smoke.",
    "ENABLE_TELEGRAM_INBOUND_POLLING must be false for dry-run completion smoke.",
    "STRATEGY_SCHEDULER_ENABLED must be false for dry-run completion smoke.",
    "STRATEGY_SCHEDULER_RUN_ON_START must be false for dry-run completion smoke.",
  ]);
});

test("dry-run completion smoke passes with clean persisted sync and automatic scheduler evidence", () => {
  const schedulerEvidence = buildSchedulerMarketEvidence([
    createSchedulerRun({ id: "run_btc", market: "KRW-BTC", action: "HOLD" }),
    createSchedulerRun({ id: "run_eth", market: "KRW-ETH", action: "HOLD" }),
  ]);
  const checks = buildDryRunCompletionSmokeChecks({
    app: {
      config: createConfig({
        telegramBotToken: "configured-token",
        telegramOperatorChatId: "configured-chat",
      }),
      exchangeBackedReadEnabled: true,
      liveSendPath: "DRY_RUN_ADAPTER",
    },
    executionState: createExecutionState(),
    seedMismatches: [],
    safetyBlockers: [],
    activeOrderCount: 0,
    latestBalanceSnapshotAt: "2026-06-29T07:55:43.423Z",
    latestPositionSnapshotAt: "2026-06-29T07:55:43.423Z",
    latestReconciliationRun: createReconciliationRun({ status: "SUCCESS" }),
    latestReconciliationIssueCodes: [],
    latestReconciliationBlockingIssueCodes: [],
    recentRiskBlockCount: 0,
    pendingNotificationCount: 0,
    schedulerMarketEvidence: schedulerEvidence,
  });

  assert.equal(summarizeDryRunCompletionSmokeStatus(checks), "PASS");
  assert.deepEqual(buildDryRunCompletionNextActions(checks), [
    "DRY_RUN automatic execution evidence passed. Next stage is live-readiness validation only after explicit live intent; this smoke did not enable live orders.",
  ]);
});

test("dry-run completion smoke blocks when one market has no completed scheduler run", () => {
  const schedulerEvidence = buildSchedulerMarketEvidence([
    createSchedulerRun({ id: "run_btc", market: "KRW-BTC", action: "HOLD" }),
  ]);
  const checks = buildDryRunCompletionSmokeChecks({
    app: {
      config: createConfig({
        telegramBotToken: "configured-token",
        telegramOperatorChatId: "configured-chat",
      }),
      exchangeBackedReadEnabled: true,
      liveSendPath: "DRY_RUN_ADAPTER",
    },
    executionState: createExecutionState(),
    seedMismatches: [],
    safetyBlockers: [],
    activeOrderCount: 0,
    latestBalanceSnapshotAt: "2026-06-29T07:55:43.423Z",
    latestPositionSnapshotAt: "2026-06-29T07:55:43.423Z",
    latestReconciliationRun: createReconciliationRun({ status: "SUCCESS" }),
    latestReconciliationIssueCodes: [],
    latestReconciliationBlockingIssueCodes: [],
    recentRiskBlockCount: 0,
    pendingNotificationCount: 0,
    schedulerMarketEvidence: schedulerEvidence,
  });

  assert.equal(summarizeDryRunCompletionSmokeStatus(checks), "BLOCK");
  assert.equal(checks.find((check) => check.name === "scheduler_latest_runs")?.status, "BLOCK");
  assert.match(buildDryRunCompletionNextActions(checks).join("\n"), /DRY_RUN scheduler launcher/);
});

test("dry-run completion smoke blocks active order state from latest scheduler evidence", () => {
  const schedulerEvidence = buildSchedulerMarketEvidence([
    createSchedulerRun({ id: "run_btc", market: "KRW-BTC", orderId: "order_btc", orderStatus: "OPEN" }),
    createSchedulerRun({ id: "run_eth", market: "KRW-ETH", action: "HOLD" }),
  ]);
  const checks = buildDryRunCompletionSmokeChecks({
    app: {
      config: createConfig({
        telegramBotToken: "configured-token",
        telegramOperatorChatId: "configured-chat",
      }),
      exchangeBackedReadEnabled: true,
      liveSendPath: "DRY_RUN_ADAPTER",
    },
    executionState: createExecutionState(),
    seedMismatches: [],
    safetyBlockers: [],
    activeOrderCount: 0,
    latestBalanceSnapshotAt: "2026-06-29T07:55:43.423Z",
    latestPositionSnapshotAt: "2026-06-29T07:55:43.423Z",
    latestReconciliationRun: createReconciliationRun({ status: "SUCCESS" }),
    latestReconciliationIssueCodes: [],
    latestReconciliationBlockingIssueCodes: [],
    recentRiskBlockCount: 0,
    pendingNotificationCount: 0,
    schedulerMarketEvidence: schedulerEvidence,
  });

  assert.equal(summarizeDryRunCompletionSmokeStatus(checks), "BLOCK");
  assert.equal(checks.find((check) => check.name === "scheduler_order_states")?.status, "BLOCK");
});

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
    id: "execution_state_primary",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-06-29T07:55:43.000Z",
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
    startedAt: "2026-06-29T07:55:43.000Z",
    completedAt: "2026-06-29T07:55:44.000Z",
    summaryJson: "{\"issues\":[]}",
    errorMessage: null,
    ...overrides,
  };
}

function createSchedulerRun(
  overrides: Partial<StrategySchedulerRunRecord> & Pick<StrategySchedulerRunRecord, "id" | "market">,
): StrategySchedulerRunRecord {
  const { id, market, ...rest } = overrides;

  return {
    id,
    exchangeAccountId: "primary",
    market,
    triggerSource: "SCHEDULER",
    status: "COMPLETED",
    startedAt: "2026-06-29T07:55:43.000Z",
    completedAt: "2026-06-29T07:55:44.000Z",
    intervalMs: 3_600_000,
    runOnStart: true,
    strategyDecisionId: `decision_${market}`,
    action: "HOLD",
    orderId: null,
    orderStatus: null,
    submissionAccepted: null,
    detail: "Decision HOLD persisted; no order submission was requested.",
    errorMessage: null,
    summaryJson: "{}",
    ...rest,
  };
}
