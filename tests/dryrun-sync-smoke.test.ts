import assert from "node:assert/strict";

import type { AppConfig } from "../src/app/env.js";
import {
  applyDryRunSyncSmokeSafetyEnv,
  buildDryRunSyncSmokeResult,
  validateDryRunSyncSmokeSafety,
} from "../src/smoke/dryrun-sync.js";
import { test } from "./harness.js";

test("dry-run sync smoke env forces dry-run read-only operator settings and preserves Upbit credentials", () => {
  const env: NodeJS.ProcessEnv = {
    APP_EXECUTION_MODE: "LIVE",
    ENABLE_LIVE_ORDERS: "true",
    ENABLE_TELEGRAM_DELIVERY: "true",
    ENABLE_TELEGRAM_INBOUND_POLLING: "true",
    STRATEGY_SCHEDULER_ENABLED: "true",
    STRATEGY_SCHEDULER_RUN_ON_START: "true",
    UPBIT_ACCESS_KEY: "configured-access",
    UPBIT_SECRET_KEY: "configured-secret",
  };

  const report = applyDryRunSyncSmokeSafetyEnv(env);

  assert.equal(report.previous.APP_EXECUTION_MODE, "LIVE");
  assert.equal(env.APP_EXECUTION_MODE, "DRY_RUN");
  assert.equal(env.ENABLE_LIVE_ORDERS, "false");
  assert.equal(env.ENABLE_TELEGRAM_DELIVERY, "false");
  assert.equal(env.ENABLE_TELEGRAM_INBOUND_POLLING, "false");
  assert.equal(env.STRATEGY_SCHEDULER_ENABLED, "false");
  assert.equal(env.STRATEGY_SCHEDULER_RUN_ON_START, "false");
  assert.equal(env.UPBIT_ACCESS_KEY, "configured-access");
  assert.equal(env.UPBIT_SECRET_KEY, "configured-secret");
  assert.equal(env.DATABASE_PATH, "./var/dryrun-sync-smoke.sqlite");
});

test("dry-run sync smoke safety validator blocks live, telegram, and scheduler settings", () => {
  const blockers = validateDryRunSyncSmokeSafety({
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
    "APP_EXECUTION_MODE must resolve to DRY_RUN for dry-run sync smoke.",
    "ENABLE_LIVE_ORDERS must resolve to DISABLED for dry-run sync smoke.",
    "liveSendPath must remain DRY_RUN_ADAPTER for dry-run sync smoke.",
    "ENABLE_TELEGRAM_DELIVERY must be false for dry-run sync smoke.",
    "ENABLE_TELEGRAM_INBOUND_POLLING must be false for dry-run sync smoke.",
    "STRATEGY_SCHEDULER_ENABLED must be false for dry-run sync smoke.",
    "STRATEGY_SCHEDULER_RUN_ON_START must be false for dry-run sync smoke.",
  ]);
});

test("dry-run sync smoke skips when Upbit read credentials are unavailable", async () => {
  const result = await buildDryRunSyncSmokeResult({
    config: createConfig(),
    exchangeBackedReadEnabled: false,
    liveSendPath: "DRY_RUN_ADAPTER",
    telegramRouter: {
      async route() {
        throw new Error("route should not be called without read credentials");
      },
    },
  }, createSafetyEnvReport());

  assert.equal(result.status, "SKIPPED");
  assert.equal(result.upbitPrivateReadAttempted, false);
  assert.equal(result.syncAttempted, false);
  assert.match(result.skippedReason ?? "", /UPBIT_ACCESS_KEY/);
  assert.deepEqual(result.commands, []);
  assert.deepEqual(result.nextActions, [
    "Configure UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY in the local DRY_RUN sync smoke script, then rerun it.",
  ]);
});

test("dry-run sync smoke routes exchange-backed sync inspection commands without strategy or order transmission", async () => {
  const routedCommands: string[] = [];
  const result = await buildDryRunSyncSmokeResult({
    config: createConfig(),
    exchangeBackedReadEnabled: true,
    liveSendPath: "DRY_RUN_ADAPTER",
    telegramRouter: {
      async route(command) {
        routedCommands.push(command);
        return { text: createRouteResponse(command, "PASS") };
      },
    },
  }, createSafetyEnvReport());

  assert.equal(result.status, "PASS");
  assert.equal(result.upbitPrivateReadAttempted, true);
  assert.equal(result.syncAttempted, true);
  assert.equal(result.strategyRunAttempted, false);
  assert.equal(result.schedulerStarted, false);
  assert.equal(result.telegramPollingStarted, false);
  assert.equal(result.telegramDeliveryAttempted, false);
  assert.equal(result.liveOrderTransmissionAttempted, false);
  assert.deepEqual(routedCommands, [
    "/config",
    "/sync",
    "/balances",
    "/positions",
    "/readiness",
    "/synchistory",
  ]);
  assert.deepEqual(result.blockingCommandNames, []);
  assert.deepEqual(result.warningCommandNames, []);
  assert.deepEqual(result.nextActions, [
    "Exchange-backed DRY_RUN sync passed. Start the local DRY_RUN runtime and run Telegram operator checks.",
  ]);
});

test("dry-run sync smoke blocks when post-sync readiness blocks", async () => {
  const result = await buildDryRunSyncSmokeResult({
    config: createConfig(),
    exchangeBackedReadEnabled: true,
    liveSendPath: "DRY_RUN_ADAPTER",
    telegramRouter: {
      async route(command) {
        return { text: createRouteResponse(command, command === "/readiness" ? "BLOCK" : "PASS") };
      },
    },
  }, createSafetyEnvReport());

  assert.equal(result.status, "BLOCK");
  assert.deepEqual(result.blockingCommandNames, ["/readiness"]);
  assert.match(result.nextActions.join("\n"), /Inspect \/readiness/);
});

test("dry-run sync smoke warns when post-sync readiness warns", async () => {
  const result = await buildDryRunSyncSmokeResult({
    config: createConfig(),
    exchangeBackedReadEnabled: true,
    liveSendPath: "DRY_RUN_ADAPTER",
    telegramRouter: {
      async route(command) {
        return { text: createRouteResponse(command, command === "/readiness" ? "WARN" : "PASS") };
      },
    },
  }, createSafetyEnvReport());

  assert.equal(result.status, "WARN");
  assert.deepEqual(result.warningCommandNames, ["/readiness"]);
  assert.deepEqual(result.nextActions, [
    "Review /readiness warnings before starting the long-running DRY_RUN runtime.",
  ]);
});

function createRouteResponse(command: string, readinessStatus: "PASS" | "WARN" | "BLOCK"): string {
  switch (command) {
    case "/config":
      return [
        "Runtime Config",
        "execution_mode: DRY_RUN",
        "live_send_path: DRY_RUN_ADAPTER",
        "exchange_backed_read_enabled: true",
      ].join("\n");
    case "/sync":
      return [
        "동기화 요청 완료",
        "status: COMPLETED",
        "detail: Stored balance snapshot (3 balances). reconciliation_source=OPERATOR_SYNC. Reconciliation status=SUCCESS.",
      ].join("\n");
    case "/balances":
      return ["Balances Snapshot", "source: RECONCILIATION"].join("\n");
    case "/positions":
      return ["Positions Snapshot", "source: RECONCILIATION"].join("\n");
    case "/readiness":
      return ["Operator Readiness", `overall_status: ${readinessStatus}`].join("\n");
    case "/synchistory":
      return ["Reconciliation History", "- 2026-05-11T00:00:00.000Z | SUCCESS | source=OPERATOR_SYNC"].join("\n");
    default:
      throw new Error(`Unexpected command ${command}`);
  }
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

function createSafetyEnvReport(): ReturnType<typeof applyDryRunSyncSmokeSafetyEnv> {
  return {
    forced: {
      APP_EXECUTION_MODE: "DRY_RUN",
      ENABLE_LIVE_ORDERS: "false",
      ENABLE_TELEGRAM_DELIVERY: "false",
      ENABLE_TELEGRAM_INBOUND_POLLING: "false",
      STRATEGY_SCHEDULER_ENABLED: "false",
      STRATEGY_SCHEDULER_RUN_ON_START: "false",
    },
    previous: {
      APP_EXECUTION_MODE: undefined,
      ENABLE_LIVE_ORDERS: undefined,
      ENABLE_TELEGRAM_DELIVERY: undefined,
      ENABLE_TELEGRAM_INBOUND_POLLING: undefined,
      STRATEGY_SCHEDULER_ENABLED: undefined,
      STRATEGY_SCHEDULER_RUN_ON_START: undefined,
    },
    databasePathDefaulted: false,
    databasePath: "./var/company-dryrun.sqlite",
  };
}
