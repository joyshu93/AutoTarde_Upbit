import assert from "node:assert/strict";

import type { AppConfig } from "../src/app/env.js";
import type { StrategySchedulerStartupPreflight } from "../src/domain/types.js";
import {
  buildLiveSchedulerPreflightNextActions,
  buildLiveSchedulerPreflightSmokeChecks,
  createSchedulerPreflightConfig,
  summarizeLiveSchedulerPreflightSmokeStatus,
} from "../src/smoke/live-scheduler-preflight.js";
import { test } from "./harness.js";

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
