import assert from "node:assert/strict";

import type { AppConfig } from "../src/app/env.js";
import type { ExecutionStateRecord } from "../src/domain/types.js";
import {
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
    latestReconciliationStatus: null,
  });

  assert.equal(summarizeLiveReadinessSmokeStatus(checks), "BLOCK");
  assert.equal(checks.find((check) => check.name === "non_mutation_boundary")?.status, "PASS");
  assert.equal(checks.find((check) => check.name === "live_mode")?.status, "BLOCK");
  assert.equal(checks.find((check) => check.name === "live_gate")?.status, "BLOCK");
  assert.equal(checks.find((check) => check.name === "live_send_path")?.status, "BLOCK");
});

test("live readiness smoke checks pass only for explicitly gated live wiring", () => {
  const checks = buildLiveReadinessSmokeChecks({
    app: {
      config: createConfig({
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
        maxLiveOrderValueKrw: 6_000,
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
    latestReconciliationStatus: "SUCCESS",
  });

  assert.equal(summarizeLiveReadinessSmokeStatus(checks), "PASS");
  assert.equal(checks.every((check) => check.status === "PASS"), true);
});

test("live readiness smoke blocks automatic scheduler startup during validation", () => {
  const checks = buildLiveReadinessSmokeChecks({
    app: {
      config: createConfig({
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
        maxLiveOrderValueKrw: 6_000,
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
    latestReconciliationStatus: "SUCCESS",
  });

  assert.equal(summarizeLiveReadinessSmokeStatus(checks), "BLOCK");
  assert.equal(checks.find((check) => check.name === "scheduler_disabled_for_validation")?.status, "BLOCK");
  assert.equal(checks.find((check) => check.name === "scheduler_run_on_start_disabled")?.status, "BLOCK");
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
    maxLiveOrderValueKrw: null,
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
