import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { createApp } from "../src/app/create-app.js";
import type { AppConfig } from "../src/app/env.js";
import { test } from "./harness.js";

test("createApp keeps dry-run adapter as the default live send path", async () => {
  const databasePath = await createTempDatabasePath("dryrun");
  const app = createApp(createConfig({ databasePath }));

  assert.equal(app.liveSendPath, "DRY_RUN_ADAPTER");
  assert.equal(app.strategyScheduler.getStatus().liveSendPath, "DRY_RUN_ADAPTER");

  app.persistence.close();
  await cleanupTempDatabase(databasePath);
});

test("createApp wires the live adapter only when live mode, live gate, and Upbit credentials are configured", async () => {
  const databasePath = await createTempDatabasePath("live");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;
  process.env.UPBIT_ACCESS_KEY = "test-access-key";
  process.env.UPBIT_SECRET_KEY = "test-secret-key";

  try {
    const app = createApp(createConfig({
      databasePath,
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      strategySchedulerEnabled: true,
    }));

    assert.equal(app.liveSendPath, "LIVE_ADAPTER");
    assert.equal(app.strategyScheduler.getStatus().liveSendPath, "LIVE_ADAPTER");
    app.persistence.close();
  } finally {
    restoreOptionalEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    restoreOptionalEnv("UPBIT_SECRET_KEY", previousSecretKey);
    await cleanupTempDatabase(databasePath);
  }
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

async function createTempDatabasePath(label: string): Promise<string> {
  const directory = path.resolve(process.cwd(), ".tmp-db-tests");
  await mkdir(directory, { recursive: true });
  return path.join(directory, `create-app-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

async function cleanupTempDatabase(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true });
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (typeof value === "string") {
    process.env[name] = value;
    return;
  }

  delete process.env[name];
}
