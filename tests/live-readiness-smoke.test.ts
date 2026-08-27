import assert from "node:assert/strict";

import type { AppServices } from "../src/app/create-app.js";
import type { AppConfig } from "../src/app/env.js";
import type { ExecutionStateRecord, ReconciliationRunRecord } from "../src/domain/types.js";
import {
  buildLiveReadinessNextActions,
  buildLiveReadinessSmokeChecks,
  runLiveReadinessSmokeWithApplicationForTest,
  summarizeLiveReadinessSmokeStatus,
} from "../src/smoke/live-readiness.js";
import { test } from "./harness.js";

type CandidatePilotInitializer = { initialize(): Promise<unknown> } | null;

test("live readiness smoke awaits candidate initialization before reading persisted state", async () => {
  const events: string[] = [];

  await runLiveReadinessSmokeWithApplicationForTest(() => createSmokeApp(events, {
    async initialize() {
      events.push("initializer:start");
      await Promise.resolve();
      events.push("initializer:complete");
    },
  }));

  const initializerCompletedAt = events.indexOf("initializer:complete");
  assert.notEqual(initializerCompletedAt, -1);
  assert.equal(initializerCompletedAt < events.indexOf("operator_state"), true);
  assert.equal(initializerCompletedAt < events.indexOf("active_orders"), true);
  assert.equal(initializerCompletedAt < events.indexOf("balance_snapshot"), true);
  assert.equal(initializerCompletedAt < events.indexOf("position_snapshot"), true);
  assert.equal(initializerCompletedAt < events.indexOf("reconciliation_runs"), true);
  assert.equal(events.filter((event) => event === "telegram:stop").length, 1);
  assert.equal(events.filter((event) => event === "scheduler:stop").length, 1);
  assert.equal(events.filter((event) => event === "persistence:close").length, 1);
});

test("live readiness smoke keeps a null candidate initializer as a no-op", async () => {
  const events: string[] = [];

  await runLiveReadinessSmokeWithApplicationForTest(() => createSmokeApp(events, null));

  assert.equal(events.includes("initializer:start"), false);
  assert.equal(events.includes("operator_state"), true);
});

test("live readiness smoke preserves candidate initialization failure and cleans up before any read", async () => {
  const events: string[] = [];
  const originalError = new Error("candidate_initializer_failed");

  await assert.rejects(
    () => runLiveReadinessSmokeWithApplicationForTest(() => createSmokeApp(events, {
      async initialize() {
        events.push("initializer:start");
        throw originalError;
      },
    })),
    (error) => error === originalError,
  );

  assert.deepEqual(events, [
    "initializer:start",
    "telegram:stop",
    "scheduler:stop",
    "persistence:close",
  ]);
});

test("live readiness smoke preserves candidate initialization failure when every cleanup step throws", async () => {
  const events: string[] = [];
  const originalError = new Error("candidate_initializer_failed");

  await assert.rejects(
    () => runLiveReadinessSmokeWithApplicationForTest(() => createSmokeApp(events, {
      async initialize() {
        events.push("initializer:start");
        throw originalError;
      },
    }, ["telegram", "scheduler", "persistence"])),
    (error) => error === originalError,
  );

  assert.deepEqual(events, [
    "initializer:start",
    "telegram:stop",
    "scheduler:stop",
    "persistence:close",
  ]);
});

test("live readiness smoke preserves a continuation read failure when one cleanup step throws", async () => {
  const events: string[] = [];
  const originalError = new Error("balance_snapshot_failed");

  await assert.rejects(
    () => runLiveReadinessSmokeWithApplicationForTest(() => createSmokeApp(events, {
      async initialize() {
        events.push("initializer:start");
        await Promise.resolve();
        events.push("initializer:complete");
      },
    }, ["telegram"], { read: "balance_snapshot", error: originalError })),
    (error) => error === originalError,
  );

  assert.deepEqual(events, [
    "initializer:start",
    "initializer:complete",
    "operator_state",
    "active_orders",
    "balance_snapshot",
    "position_snapshot",
    "reconciliation_runs",
    "telegram:stop",
    "scheduler:stop",
    "persistence:close",
  ]);
});

test("live readiness smoke preserves a continuation read failure when every cleanup step throws", async () => {
  const events: string[] = [];
  const originalError = new Error("balance_snapshot_failed");

  await assert.rejects(
    () => runLiveReadinessSmokeWithApplicationForTest(() => createSmokeApp(events, {
      async initialize() {
        events.push("initializer:start");
        await Promise.resolve();
        events.push("initializer:complete");
      },
    }, ["telegram", "scheduler", "persistence"], {
      read: "balance_snapshot",
      error: originalError,
    })),
    (error) => error === originalError,
  );

  assert.deepEqual(events, [
    "initializer:start",
    "initializer:complete",
    "operator_state",
    "active_orders",
    "balance_snapshot",
    "position_snapshot",
    "reconciliation_runs",
    "telegram:stop",
    "scheduler:stop",
    "persistence:close",
  ]);
});

test("live readiness smoke rejects successful result when one cleanup step fails", async () => {
  const events: string[] = [];

  await assert.rejects(
    () => runLiveReadinessSmokeWithApplicationForTest(() => createSmokeApp(events, null, ["telegram"])),
    (error) => error instanceof Error &&
      error.message === "Live smoke cleanup failed: telegram_inbound_polling: telegram_cleanup_failed",
  );

  assert.equal(events.filter((event) => event === "telegram:stop").length, 1);
  assert.equal(events.filter((event) => event === "scheduler:stop").length, 1);
  assert.equal(events.filter((event) => event === "persistence:close").length, 1);
});

test("live readiness smoke rejects successful result with every cleanup failure", async () => {
  const events: string[] = [];

  await assert.rejects(
    () => runLiveReadinessSmokeWithApplicationForTest(() => createSmokeApp(
      events,
      null,
      ["telegram", "scheduler", "persistence"],
    )),
    (error) => error instanceof Error && error.message ===
      "Live smoke cleanup failed: telegram_inbound_polling: telegram_cleanup_failed; " +
      "strategy_scheduler: scheduler_cleanup_failed; sqlite_persistence: persistence_cleanup_failed",
  );

  assert.equal(events.filter((event) => event === "telegram:stop").length, 1);
  assert.equal(events.filter((event) => event === "scheduler:stop").length, 1);
  assert.equal(events.filter((event) => event === "persistence:close").length, 1);
});

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
    checkedAt: "2026-05-11T00:00:01.000Z",
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
    checkedAt: "2026-05-11T00:00:01.000Z",
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
    checkedAt: "2026-05-11T00:00:01.000Z",
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
    checkedAt: "2026-05-11T00:00:01.000Z",
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
    checkedAt: "2026-05-11T00:00:01.000Z",
  });

  assert.equal(summarizeLiveReadinessSmokeStatus(checks), "BLOCK");
  assert.equal(checks.find((check) => check.name === "latest_reconciliation")?.status, "BLOCK");
});

test("live readiness smoke blocks LIVE when the explicit evidence freshness policy is missing", () => {
  const checks = buildLiveReadinessSmokeChecks({
    app: {
      config: createConfig({
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
        liveReadinessMaxEvidenceAgeMs: null,
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
    latestReconciliationRun: createReconciliationRun(),
    latestReconciliationIssueCodes: [],
    latestReconciliationBlockingIssueCodes: [],
    checkedAt: "2026-05-11T00:00:01.000Z",
  } as Parameters<typeof buildLiveReadinessSmokeChecks>[0]);

  assert.equal(checks.find((check) => check.name === "evidence_freshness_policy")?.status, "BLOCK");
  assert.deepEqual(buildLiveReadinessNextActions(checks), [
    "Set LIVE_READINESS_MAX_EVIDENCE_AGE_MS to an explicit positive safe integer before LIVE readiness.",
  ]);
});

test("live readiness smoke passes exact freshness boundaries and warns one millisecond beyond them", () => {
  const exactBoundary = buildFreshnessChecks({
    checkedAt: "2026-05-11T00:01:00.000Z",
    balanceAt: "2026-05-11T00:00:00.000Z",
    positionAt: "2026-05-11T00:00:00.000Z",
    reconciliationAt: "2026-05-11T00:00:00.000Z",
  });
  assert.equal(summarizeLiveReadinessSmokeStatus(exactBoundary), "PASS");
  for (const name of ["balance_snapshot", "position_snapshot", "latest_reconciliation"]) {
    assert.equal(exactBoundary.find((check) => check.name === name)?.status, "PASS");
    assert.match(exactBoundary.find((check) => check.name === name)?.detail ?? "", /fresh_age_ms=60000/iu);
  }

  const stale = buildFreshnessChecks({
    checkedAt: "2026-05-11T00:01:00.001Z",
    balanceAt: "2026-05-11T00:00:00.000Z",
    positionAt: "2026-05-11T00:00:00.000Z",
    reconciliationAt: "2026-05-11T00:00:00.000Z",
  });
  assert.equal(summarizeLiveReadinessSmokeStatus(stale), "WARN");
  for (const name of ["balance_snapshot", "position_snapshot", "latest_reconciliation"]) {
    assert.equal(stale.find((check) => check.name === name)?.status, "WARN");
    assert.match(stale.find((check) => check.name === name)?.detail ?? "", /stale_age_ms=60001/iu);
  }
});

test("live readiness smoke blocks future and malformed persisted health timestamps", () => {
  const future = buildFreshnessChecks({
    checkedAt: "2026-05-11T00:01:00.000Z",
    balanceAt: "2026-05-11T00:01:00.001Z",
    positionAt: "not-a-timestamp",
    reconciliationAt: "2026-05-11T00:01:00.001Z",
  });

  assert.equal(summarizeLiveReadinessSmokeStatus(future), "BLOCK");
  assert.equal(future.find((check) => check.name === "balance_snapshot")?.status, "BLOCK");
  assert.equal(future.find((check) => check.name === "position_snapshot")?.status, "BLOCK");
  assert.equal(future.find((check) => check.name === "latest_reconciliation")?.status, "BLOCK");
  assert.match(future.find((check) => check.name === "balance_snapshot")?.detail ?? "", /uncomparable/iu);
  assert.match(future.find((check) => check.name === "position_snapshot")?.detail ?? "", /uncomparable/iu);
  assert.match(future.find((check) => check.name === "latest_reconciliation")?.detail ?? "", /uncomparable/iu);
  assert.deepEqual(buildLiveReadinessNextActions(future), [
    "Investigate system clock and persisted health timestamps before LIVE startup.",
  ]);
});

function buildFreshnessChecks(input: {
  checkedAt: string;
  balanceAt: string;
  positionAt: string;
  reconciliationAt: string;
}): ReturnType<typeof buildLiveReadinessSmokeChecks> {
  const config = {
    ...createConfig({ executionMode: "LIVE", liveExecutionGate: "ENABLED" }),
    liveReadinessMaxEvidenceAgeMs: 60_000,
  } as AppConfig;
  return buildLiveReadinessSmokeChecks({
    app: { config, exchangeBackedReadEnabled: true, liveSendPath: "LIVE_ADAPTER" },
    executionState: createExecutionState({ executionMode: "LIVE", liveExecutionGate: "ENABLED" }),
    seedMismatches: [],
    activeOrderCount: 0,
    latestBalanceSnapshotAt: input.balanceAt,
    latestPositionSnapshotAt: input.positionAt,
    latestReconciliationRun: createReconciliationRun({
      startedAt: input.reconciliationAt,
      completedAt: input.reconciliationAt,
    }),
    latestReconciliationIssueCodes: [],
    latestReconciliationBlockingIssueCodes: [],
    checkedAt: input.checkedAt,
  } as Parameters<typeof buildLiveReadinessSmokeChecks>[0]);
}

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
    liveReadinessMaxEvidenceAgeMs: 3_600_000,
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

function createSmokeApp(
  events: string[],
  candidatePilotInitializer: CandidatePilotInitializer,
  failingCleanupSteps: readonly CleanupStep[] = [],
  persistedReadFailure: PersistedReadFailure | null = null,
): AppServices {
  return {
    candidatePilotInitializer: candidatePilotInitializer as AppServices["candidatePilotInitializer"],
    config: createConfig({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
    }),
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    operatorState: {
      async getState() {
        events.push("operator_state");
        throwPersistedReadFailure("operator_state", persistedReadFailure);
        return createExecutionState({
          executionMode: "LIVE",
          liveExecutionGate: "ENABLED",
        });
      },
    } as never,
    repositories: {
      async listActiveOrders() {
        events.push("active_orders");
        throwPersistedReadFailure("active_orders", persistedReadFailure);
        return [];
      },
      async getLatestBalanceSnapshot() {
        events.push("balance_snapshot");
        throwPersistedReadFailure("balance_snapshot", persistedReadFailure);
        return null;
      },
      async getLatestPositionSnapshot() {
        events.push("position_snapshot");
        throwPersistedReadFailure("position_snapshot", persistedReadFailure);
        return null;
      },
      async listReconciliationRuns() {
        events.push("reconciliation_runs");
        throwPersistedReadFailure("reconciliation_runs", persistedReadFailure);
        return [];
      },
    } as never,
    telegramInboundPolling: {
      isConfigured() {
        return false;
      },
      stop() {
        events.push("telegram:stop");
        throwWhenRequested("telegram", failingCleanupSteps);
      },
    } as never,
    strategyScheduler: {
      stop() {
        events.push("scheduler:stop");
        throwWhenRequested("scheduler", failingCleanupSteps);
      },
    } as never,
    notificationDelivery: {
      isConfigured() {
        return false;
      },
      stop() {
        return { stopped: true, inFlightCount: 0, quiesced: true };
      },
    } as never,
    persistence: {
      close() {
        events.push("persistence:close");
        throwWhenRequested("persistence", failingCleanupSteps);
      },
    } as never,
  } as unknown as AppServices;
}

type CleanupStep = "telegram" | "scheduler" | "persistence";
type PersistedRead =
  | "operator_state"
  | "active_orders"
  | "balance_snapshot"
  | "position_snapshot"
  | "reconciliation_runs";
type PersistedReadFailure = { readonly read: PersistedRead; readonly error: Error };

function throwWhenRequested(step: CleanupStep, failingCleanupSteps: readonly CleanupStep[]): void {
  if (failingCleanupSteps.includes(step)) {
    throw new Error(`${step}_cleanup_failed`);
  }
}

function throwPersistedReadFailure(read: PersistedRead, failure: PersistedReadFailure | null): void {
  if (failure?.read === read) {
    throw failure.error;
  }
}
