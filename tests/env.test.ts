import assert from "node:assert/strict";

import { buildExecutionRiskLimits, loadAppConfig } from "../src/app/env.js";
import { test } from "./harness.js";

test("loadAppConfig defaults to DRY_RUN with live gate disabled", () => {
  const config = loadAppConfig({});

  assert.equal(config.executionMode, "DRY_RUN");
  assert.equal(config.liveExecutionGate, "DISABLED");
  assert.equal(config.telegramDeliveryEnabled, false);
  assert.equal(config.telegramDeliveryMaxAttempts, 5);
  assert.equal(config.telegramDeliveryBaseBackoffMs, 15_000);
  assert.equal(config.telegramDeliveryMaxBackoffMs, 300_000);
  assert.equal(config.telegramDeliveryLeaseMs, 30_000);
  assert.equal(config.telegramInboundPollingEnabled, false);
  assert.equal(config.telegramInboundPollIntervalMs, 2_000);
  assert.equal(config.telegramInboundPollTimeoutSeconds, 25);
  assert.equal(config.telegramInboundPollLimit, 10);
  assert.equal(config.strategySchedulerEnabled, false);
  assert.equal(config.strategySchedulerRunOnStart, false);
  assert.equal(config.strategySchedulerBtcIntervalMs, 3_600_000);
  assert.equal(config.strategySchedulerEthIntervalMs, 3_600_000);
  assert.equal(config.reconciliationMaxOrderLookupsPerRun, 10);
  assert.equal(config.reconciliationHistoryMaxPagesPerMarket, 3);
  assert.equal(config.reconciliationClosedOrderLookbackDays, 7);
  assert.equal(config.reconciliationHistoryStopBeforeDays, 365);
  assert.equal(config.reconciliationHistoryRetentionAssumptionDays, 365);
  assert.equal(config.globalKillSwitch, false);
  assert.equal(config.databasePath, "./var/autotrade-upbit.sqlite");
  assert.deepEqual(config.deprecatedIgnoredEnvVars, []);

  const riskLimits = buildExecutionRiskLimits(config);
  assert.equal(riskLimits.minimumOrderValueKrw, 5_000);
  assert.equal(riskLimits.totalExposureCap, 0.75);
});

test("loadAppConfig surfaces deprecated ignored environment variables", () => {
  const config = loadAppConfig({
    MAX_LIVE_ORDER_VALUE_KRW: "6000",
  });

  assert.deepEqual(config.deprecatedIgnoredEnvVars, ["MAX_LIVE_ORDER_VALUE_KRW"]);
});

test("loadAppConfig allows LIVE only when explicitly requested", () => {
  const config = loadAppConfig({
    APP_EXECUTION_MODE: "LIVE",
    ENABLE_LIVE_ORDERS: "true",
    ENABLE_TELEGRAM_DELIVERY: "true",
    TELEGRAM_DELIVERY_MAX_ATTEMPTS: "7",
    TELEGRAM_DELIVERY_BASE_BACKOFF_MS: "20000",
    TELEGRAM_DELIVERY_MAX_BACKOFF_MS: "600000",
    TELEGRAM_DELIVERY_LEASE_MS: "45000",
    ENABLE_TELEGRAM_INBOUND_POLLING: "true",
    TELEGRAM_INBOUND_POLL_INTERVAL_MS: "3000",
    TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS: "20",
    TELEGRAM_INBOUND_POLL_LIMIT: "15",
    STRATEGY_SCHEDULER_ENABLED: "true",
    STRATEGY_SCHEDULER_RUN_ON_START: "true",
    STRATEGY_SCHEDULER_BTC_INTERVAL_MS: "1800000",
    STRATEGY_SCHEDULER_ETH_INTERVAL_MS: "2700000",
    RECONCILIATION_HISTORY_MAX_PAGES_PER_MARKET: "5",
    RECONCILIATION_CLOSED_ORDER_LOOKBACK_DAYS: "2",
    RECONCILIATION_HISTORY_STOP_BEFORE_DAYS: "30",
    RECONCILIATION_HISTORY_RETENTION_ASSUMPTION_DAYS: "90",
  });

  assert.equal(config.executionMode, "LIVE");
  assert.equal(config.liveExecutionGate, "ENABLED");
  assert.equal(config.telegramDeliveryEnabled, true);
  assert.equal(config.telegramDeliveryMaxAttempts, 7);
  assert.equal(config.telegramDeliveryBaseBackoffMs, 20_000);
  assert.equal(config.telegramDeliveryMaxBackoffMs, 600_000);
  assert.equal(config.telegramDeliveryLeaseMs, 45_000);
  assert.equal(config.telegramInboundPollingEnabled, true);
  assert.equal(config.telegramInboundPollIntervalMs, 3_000);
  assert.equal(config.telegramInboundPollTimeoutSeconds, 20);
  assert.equal(config.telegramInboundPollLimit, 15);
  assert.equal(config.strategySchedulerEnabled, true);
  assert.equal(config.strategySchedulerRunOnStart, true);
  assert.equal(config.strategySchedulerBtcIntervalMs, 1_800_000);
  assert.equal(config.strategySchedulerEthIntervalMs, 2_700_000);
  assert.equal(config.reconciliationHistoryMaxPagesPerMarket, 5);
  assert.equal(config.reconciliationClosedOrderLookbackDays, 2);
  assert.equal(config.reconciliationHistoryStopBeforeDays, 30);
  assert.equal(config.reconciliationHistoryRetentionAssumptionDays, 90);
});

test("loadAppConfig accepts an explicit sqlite database path override", () => {
  const config = loadAppConfig({
    DATABASE_PATH: "./var/test-wiring.sqlite",
    RECONCILIATION_MAX_ORDER_LOOKUPS_PER_RUN: "4",
    RECONCILIATION_HISTORY_MAX_PAGES_PER_MARKET: "6",
  });

  assert.equal(config.databasePath, "./var/test-wiring.sqlite");
  assert.equal(config.reconciliationMaxOrderLookupsPerRun, 4);
  assert.equal(config.reconciliationHistoryMaxPagesPerMarket, 6);
});
