import assert from "node:assert/strict";

import type { AppServices } from "../src/app/create-app.js";
import type { AppConfig } from "../src/app/env.js";
import type { ExecutionStateRecord, StrategySchedulerStartupPreflight } from "../src/domain/types.js";
import {
  buildLiveSchedulerPreflightNextActions,
  buildLiveSchedulerPreflightSmokeChecks,
  createSchedulerPreflightConfig,
  runLiveSchedulerPreflightSmoke,
  summarizeLiveSchedulerPreflightSmokeStatus,
} from "../src/smoke/live-scheduler-preflight.js";
import { test } from "./harness.js";

type CandidatePilotInitializer = { initialize(): Promise<unknown> } | null;

test("live scheduler preflight smoke awaits candidate initialization before state and preflight reads", async () => {
  const events: string[] = [];

  await runLiveSchedulerPreflightSmoke(() => createSmokeApp(events, {
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

test("live scheduler preflight smoke keeps a null candidate initializer as a no-op", async () => {
  const events: string[] = [];

  await runLiveSchedulerPreflightSmoke(() => createSmokeApp(events, null));

  assert.equal(events.includes("initializer:start"), false);
  assert.equal(events.includes("operator_state"), true);
});

test("live scheduler preflight smoke preserves candidate initialization failure and cleans up before preflight", async () => {
  const events: string[] = [];
  const originalError = new Error("candidate_initializer_failed");

  await assert.rejects(
    () => runLiveSchedulerPreflightSmoke(() => createSmokeApp(events, {
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

test("live scheduler preflight smoke preserves candidate initialization failure when every cleanup step throws", async () => {
  const events: string[] = [];
  const originalError = new Error("candidate_initializer_failed");

  await assert.rejects(
    () => runLiveSchedulerPreflightSmoke(() => createSmokeApp(events, {
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

test("live scheduler preflight smoke rejects successful result when one cleanup step fails", async () => {
  const events: string[] = [];

  await assert.rejects(
    () => runLiveSchedulerPreflightSmoke(() => createSmokeApp(events, null, ["telegram"])),
    (error) => error instanceof Error &&
      error.message === "Live smoke cleanup failed: telegram_inbound_polling: telegram_cleanup_failed",
  );

  assert.equal(events.filter((event) => event === "telegram:stop").length, 1);
  assert.equal(events.filter((event) => event === "scheduler:stop").length, 1);
  assert.equal(events.filter((event) => event === "persistence:close").length, 1);
});

test("live scheduler preflight smoke rejects successful result with every cleanup failure", async () => {
  const events: string[] = [];

  await assert.rejects(
    () => runLiveSchedulerPreflightSmoke(() => createSmokeApp(
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

test("live scheduler preflight smoke blocks non-live invocation", () => {
  const checks = buildLiveSchedulerPreflightSmokeChecks({
    app: {
      config: createConfig(),
      exchangeBackedReadEnabled: false,
      liveSendPath: "DRY_RUN_ADAPTER",
    },
    preflight: createPreflight({
      scope: "DRY_RUN",
      status: "PASS",
      detail: "Live scheduler preflight is not required in DRY_RUN.",
    }),
  });

  assert.equal(summarizeLiveSchedulerPreflightSmokeStatus(checks), "BLOCK");
  assert.equal(checks.find((check) => check.name === "live_mode")?.status, "BLOCK");
  assert.equal(checks.find((check) => check.name === "preflight_scope")?.status, "BLOCK");
  assert.deepEqual(buildLiveSchedulerPreflightNextActions(checks).slice(0, 1), [
    "Run this smoke with APP_EXECUTION_MODE=LIVE in the local live scheduler environment.",
  ]);
});

test("live scheduler preflight smoke passes when startup preflight passes", () => {
  const checks = buildLiveSchedulerPreflightSmokeChecks({
    app: {
      config: createConfig({
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
      }),
      exchangeBackedReadEnabled: true,
      liveSendPath: "LIVE_ADAPTER",
    },
    preflight: createPreflight({
      scope: "LIVE",
      status: "PASS",
      detail: "Live scheduler startup preflight passed.",
      checks: [
        { name: "live_gate", status: "PASS", detail: "ENABLE_LIVE_ORDERS=true is configured." },
        { name: "active_orders", status: "PASS", detail: "No active or reconciliation-required orders are stored." },
      ],
    }),
  });

  assert.equal(summarizeLiveSchedulerPreflightSmokeStatus(checks), "PASS");
  assert.equal(checks.every((check) => check.status === "PASS"), true);
  assert.deepEqual(buildLiveSchedulerPreflightNextActions(checks), [
    "Live scheduler preflight has no blockers or warnings. Start the scheduler only with an explicit local script change.",
  ]);
});

test("live scheduler preflight smoke keeps non-blocking history recovery as warning", () => {
  const checks = buildLiveSchedulerPreflightSmokeChecks({
    app: {
      config: createConfig({
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
      }),
      exchangeBackedReadEnabled: true,
      liveSendPath: "LIVE_ADAPTER",
    },
    preflight: createPreflight({
      scope: "LIVE",
      status: "WARN",
      detail: "Live scheduler startup preflight passed.",
      checks: [
        {
          name: "latest_reconciliation",
          status: "WARN",
          detail: "latest reconciliation status=DRIFT_DETECTED non_blocking_issue_codes=EXCHANGE_ORDER_RECOVERED",
        },
      ],
    }),
  });

  assert.equal(summarizeLiveSchedulerPreflightSmokeStatus(checks), "WARN");
  assert.equal(checks.find((check) => check.name === "scheduler_startup_preflight")?.status, "WARN");
  assert.equal(checks.find((check) => check.name === "preflight:latest_reconciliation")?.status, "WARN");
  assert.match(buildLiveSchedulerPreflightNextActions(checks).join("\n"), /Review scheduler preflight warnings/);
});

test("live scheduler preflight smoke reports preflight blockers without starting timers", () => {
  const checks = buildLiveSchedulerPreflightSmokeChecks({
    app: {
      config: createConfig({
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
      }),
      exchangeBackedReadEnabled: true,
      liveSendPath: "LIVE_ADAPTER",
    },
    preflight: createPreflight({
      scope: "LIVE",
      status: "BLOCK",
      detail: "Live scheduler startup blocked by active_orders.",
      checks: [
        {
          name: "active_orders",
          status: "BLOCK",
          detail: "1 active or reconciliation-required order(s) must be resolved first.",
        },
      ],
    }),
  });

  assert.equal(summarizeLiveSchedulerPreflightSmokeStatus(checks), "BLOCK");
  assert.equal(checks.find((check) => check.name === "preflight:active_orders")?.status, "BLOCK");
  assert.deepEqual(buildLiveSchedulerPreflightNextActions(checks), [
    "Resolve scheduler preflight blocker active_orders: 1 active or reconciliation-required order(s) must be resolved first.",
  ]);
});

test("live scheduler preflight smoke assumes scheduler enabled but never run-on-start", () => {
  const config = createSchedulerPreflightConfig(createConfig({
    strategySchedulerEnabled: false,
    strategySchedulerRunOnStart: true,
  }));

  assert.equal(config.strategySchedulerEnabled, true);
  assert.equal(config.strategySchedulerRunOnStart, false);
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

function createPreflight(
  overrides: Partial<StrategySchedulerStartupPreflight> = {},
): StrategySchedulerStartupPreflight {
  return {
    checkedAt: "2026-05-14T00:00:00.000Z",
    scope: "LIVE",
    status: "PASS",
    detail: "Live scheduler startup preflight passed.",
    checks: [],
    ...overrides,
  };
}

function createSmokeApp(
  events: string[],
  candidatePilotInitializer: CandidatePilotInitializer,
  failingCleanupSteps: readonly CleanupStep[] = [],
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
        return createExecutionState();
      },
    } as never,
    repositories: {
      async listActiveOrders() {
        events.push("active_orders");
        return [];
      },
      async getLatestBalanceSnapshot() {
        events.push("balance_snapshot");
        return null;
      },
      async getLatestPositionSnapshot() {
        events.push("position_snapshot");
        return null;
      },
      async listReconciliationRuns() {
        events.push("reconciliation_runs");
        return [];
      },
    } as never,
    telegramInboundPolling: {
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
    persistence: {
      close() {
        events.push("persistence:close");
        throwWhenRequested("persistence", failingCleanupSteps);
      },
    } as never,
  } as unknown as AppServices;
}

type CleanupStep = "telegram" | "scheduler" | "persistence";

function throwWhenRequested(step: CleanupStep, failingCleanupSteps: readonly CleanupStep[]): void {
  if (failingCleanupSteps.includes(step)) {
    throw new Error(`${step}_cleanup_failed`);
  }
}

function createExecutionState(): ExecutionStateRecord {
  return {
    id: "execution_state_primary",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-05-14T00:00:00.000Z",
  };
}
