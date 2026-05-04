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
  assert.equal(config.reconciliationMaxOrderLookupsPerRun, 10);
  assert.equal(config.reconciliationHistoryMaxPagesPerMarket, 3);
  assert.equal(config.reconciliationClosedOrderLookbackDays, 7);
  assert.equal(config.reconciliationHistoryStopBeforeDays, 365);
  assert.equal(config.globalKillSwitch, false);
  assert.equal(config.databasePath, "./var/autotrade-upbit.sqlite");

  const riskLimits = buildExecutionRiskLimits(config);
  assert.equal(riskLimits.minimumOrderValueKrw, 5_000);
  assert.equal(riskLimits.totalExposureCap, 0.75);
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
    RECONCILIATION_HISTORY_MAX_PAGES_PER_MARKET: "5",
    RECONCILIATION_CLOSED_ORDER_LOOKBACK_DAYS: "2",
    RECONCILIATION_HISTORY_STOP_BEFORE_DAYS: "30",
  });

  assert.equal(config.executionMode, "LIVE");
  assert.equal(config.liveExecutionGate, "ENABLED");
  assert.equal(config.telegramDeliveryEnabled, true);
  assert.equal(config.telegramDeliveryMaxAttempts, 7);
  assert.equal(config.telegramDeliveryBaseBackoffMs, 20_000);
  assert.equal(config.telegramDeliveryMaxBackoffMs, 600_000);
  assert.equal(config.telegramDeliveryLeaseMs, 45_000);
  assert.equal(config.reconciliationHistoryMaxPagesPerMarket, 5);
  assert.equal(config.reconciliationClosedOrderLookbackDays, 2);
  assert.equal(config.reconciliationHistoryStopBeforeDays, 30);
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
