import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { loadAppConfig } from "../src/app/env.js";
import {
  applyDryRunOperatorSmokeSafetyEnv,
  runDryRunOperatorSmoke,
  validateDryRunOperatorSmokeSafety,
} from "../src/smoke/dryrun-operator.js";
import { test } from "./harness.js";

test("dry-run operator smoke env forces offline dry-run safety", () => {
  const env: NodeJS.ProcessEnv = {
    APP_EXECUTION_MODE: "LIVE",
    ENABLE_LIVE_ORDERS: "true",
    ENABLE_TELEGRAM_DELIVERY: "true",
    ENABLE_TELEGRAM_INBOUND_POLLING: "true",
    STRATEGY_SCHEDULER_ENABLED: "true",
    STRATEGY_SCHEDULER_RUN_ON_START: "true",
    UPBIT_ACCESS_KEY: "secret-access",
    UPBIT_SECRET_KEY: "secret-secret",
  };

  const report = applyDryRunOperatorSmokeSafetyEnv(env);
  const config = loadAppConfig(env);

  assert.equal(report.previous.APP_EXECUTION_MODE, "LIVE");
  assert.equal(report.clearedSecrets.UPBIT_ACCESS_KEY.wasConfigured, true);
  assert.equal(report.clearedSecrets.UPBIT_SECRET_KEY.wasConfigured, true);
  assert.equal(env.APP_EXECUTION_MODE, "DRY_RUN");
  assert.equal(env.ENABLE_LIVE_ORDERS, "false");
  assert.equal(env.ENABLE_TELEGRAM_DELIVERY, "false");
  assert.equal(env.ENABLE_TELEGRAM_INBOUND_POLLING, "false");
  assert.equal(env.STRATEGY_SCHEDULER_ENABLED, "false");
  assert.equal(env.STRATEGY_SCHEDULER_RUN_ON_START, "false");
  assert.equal(env.UPBIT_ACCESS_KEY, undefined);
  assert.equal(env.UPBIT_SECRET_KEY, undefined);
  assert.equal(env.DATABASE_PATH, "./var/dryrun-operator-smoke.sqlite");
  assert.equal(config.executionMode, "DRY_RUN");
  assert.equal(config.liveExecutionGate, "DISABLED");
  assert.equal(config.telegramDeliveryEnabled, false);
  assert.equal(config.telegramInboundPollingEnabled, false);
  assert.equal(config.strategySchedulerEnabled, false);
  assert.equal(config.strategySchedulerRunOnStart, false);
});

test("dry-run operator smoke safety validator blocks live or network-capable settings", () => {
  const blockers = validateDryRunOperatorSmokeSafety({
    config: loadAppConfig({
      APP_EXECUTION_MODE: "LIVE",
      ENABLE_LIVE_ORDERS: "true",
      ENABLE_TELEGRAM_DELIVERY: "true",
      ENABLE_TELEGRAM_INBOUND_POLLING: "true",
      STRATEGY_SCHEDULER_ENABLED: "true",
      STRATEGY_SCHEDULER_RUN_ON_START: "true",
    }),
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
  });

  assert.deepEqual(blockers, [
    "APP_EXECUTION_MODE must resolve to DRY_RUN for dry-run operator smoke.",
    "ENABLE_LIVE_ORDERS must resolve to DISABLED for dry-run operator smoke.",
    "liveSendPath must remain DRY_RUN_ADAPTER for dry-run operator smoke.",
    "Upbit private read credentials must be cleared for offline dry-run operator smoke.",
    "ENABLE_TELEGRAM_DELIVERY must be false for dry-run operator smoke.",
    "ENABLE_TELEGRAM_INBOUND_POLLING must be false for dry-run operator smoke.",
    "STRATEGY_SCHEDULER_ENABLED must be false for dry-run operator smoke.",
    "STRATEGY_SCHEDULER_RUN_ON_START must be false for dry-run operator smoke.",
  ]);
});

test("dry-run operator smoke routes core operator commands without live side effects", async () => {
  const databasePath = await createTempDatabasePath("dryrun-operator-smoke");
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;
  const previousExecutionMode = process.env.APP_EXECUTION_MODE;
  const previousLiveGate = process.env.ENABLE_LIVE_ORDERS;
  const previousDelivery = process.env.ENABLE_TELEGRAM_DELIVERY;
  const previousInbound = process.env.ENABLE_TELEGRAM_INBOUND_POLLING;
  const previousScheduler = process.env.STRATEGY_SCHEDULER_ENABLED;
  const previousRunOnStart = process.env.STRATEGY_SCHEDULER_RUN_ON_START;
  process.env.DATABASE_PATH = databasePath;
  process.env.APP_EXECUTION_MODE = "LIVE";
  process.env.ENABLE_LIVE_ORDERS = "true";
  process.env.ENABLE_TELEGRAM_DELIVERY = "true";
  process.env.ENABLE_TELEGRAM_INBOUND_POLLING = "true";
  process.env.STRATEGY_SCHEDULER_ENABLED = "true";
  process.env.STRATEGY_SCHEDULER_RUN_ON_START = "true";
  process.env.UPBIT_ACCESS_KEY = "secret-access";
  process.env.UPBIT_SECRET_KEY = "secret-secret";

  try {
    const result = await runDryRunOperatorSmoke();

    assert.equal(result.status, "PASS");
    assert.equal(result.executionMode, "DRY_RUN");
    assert.equal(result.liveExecutionGate, "DISABLED");
    assert.equal(result.liveSendPath, "DRY_RUN_ADAPTER");
    assert.equal(result.exchangeBackedReadEnabled, false);
    assert.equal(result.upbitPrivateReadAttempted, false);
    assert.equal(result.telegramPollingStarted, false);
    assert.equal(result.telegramDeliveryAttempted, false);
    assert.equal(result.schedulerStarted, false);
    assert.equal(result.liveOrderTransmissionAttempted, false);
    assert.equal(result.dryRunOrderCountDelta, 0);
    assert.ok(result.latestBtcDecisionId);
    assert.ok(result.latestEthDecisionId);
    assert.deepEqual(result.safetyBlockers, []);
    assert.deepEqual(result.blockingCommandNames, []);
    assert.deepEqual(result.commands.map((command) => command.status), result.commands.map(() => "PASS"));
    assert.deepEqual(
      result.commands.map((command) => command.command),
      [
        "/config",
        "/status",
        "/readiness",
        "/sync",
        "/balances",
        "/positions",
        "/run BTC",
        "/run ETH",
        "/orders",
        "/scheduler",
        "/alerts",
      ],
    );
  } finally {
    restoreOptionalEnv("DATABASE_PATH", previousDatabasePath);
    restoreOptionalEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    restoreOptionalEnv("UPBIT_SECRET_KEY", previousSecretKey);
    restoreOptionalEnv("APP_EXECUTION_MODE", previousExecutionMode);
    restoreOptionalEnv("ENABLE_LIVE_ORDERS", previousLiveGate);
    restoreOptionalEnv("ENABLE_TELEGRAM_DELIVERY", previousDelivery);
    restoreOptionalEnv("ENABLE_TELEGRAM_INBOUND_POLLING", previousInbound);
    restoreOptionalEnv("STRATEGY_SCHEDULER_ENABLED", previousScheduler);
    restoreOptionalEnv("STRATEGY_SCHEDULER_RUN_ON_START", previousRunOnStart);
    await cleanupTempDatabase(databasePath);
  }
});

async function createTempDatabasePath(label: string): Promise<string> {
  const directory = path.resolve(process.cwd(), ".tmp-db-tests");
  await mkdir(directory, { recursive: true });
  return path.join(directory, `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

async function cleanupTempDatabase(databasePath: string): Promise<void> {
  await Promise.all([
    rmWithRetry(databasePath),
    rmWithRetry(`${databasePath}-wal`),
    rmWithRetry(`${databasePath}-shm`),
  ]);
}

async function rmWithRetry(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(filePath, { force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "EBUSY" || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (typeof value === "string") {
    process.env[name] = value;
    return;
  }

  delete process.env[name];
}
