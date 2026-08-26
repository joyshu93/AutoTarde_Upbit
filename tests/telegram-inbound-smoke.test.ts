import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { loadAppConfig } from "../src/app/env.js";
import {
  applyTelegramInboundSmokeSafetyEnv,
  runTelegramInboundSmokeOnce,
  validateTelegramInboundSmokeSafety,
} from "../src/smoke/telegram-inbound-once.js";
import { test } from "./harness.js";

test("telegram inbound smoke env forces dry-run and disables live/scheduler paths", () => {
  const env: NodeJS.ProcessEnv = {
    APP_EXECUTION_MODE: "LIVE",
    ENABLE_LIVE_ORDERS: "true",
    STRATEGY_SCHEDULER_ENABLED: "true",
    STRATEGY_SCHEDULER_RUN_ON_START: "true",
    ENABLE_TELEGRAM_INBOUND_POLLING: "false",
    TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS: "25",
    TELEGRAM_INBOUND_POLL_LIMIT: "10",
  };

  const report = applyTelegramInboundSmokeSafetyEnv(env);
  const config = loadAppConfig(env);

  assert.equal(report.previous.APP_EXECUTION_MODE, "LIVE");
  assert.equal(report.previous.ENABLE_LIVE_ORDERS, "true");
  assert.equal(env.APP_EXECUTION_MODE, "DRY_RUN");
  assert.equal(env.ENABLE_LIVE_ORDERS, "false");
  assert.equal(env.STRATEGY_SCHEDULER_ENABLED, "false");
  assert.equal(env.STRATEGY_SCHEDULER_RUN_ON_START, "false");
  assert.equal(env.ENABLE_TELEGRAM_INBOUND_POLLING, "true");
  assert.equal(env.TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS, "0");
  assert.equal(env.TELEGRAM_INBOUND_POLL_LIMIT, "1");
  assert.equal(config.executionMode, "DRY_RUN");
  assert.equal(config.liveExecutionGate, "DISABLED");
  assert.equal(config.strategySchedulerEnabled, false);
  assert.equal(config.strategySchedulerRunOnStart, false);
  assert.equal(config.telegramInboundPollingEnabled, true);
  assert.equal(config.telegramInboundPollTimeoutSeconds, 0);
  assert.equal(config.telegramInboundPollLimit, 1);
  assert.deepEqual(validateTelegramInboundSmokeSafety(config), []);
});

test("telegram inbound smoke safety validator blocks non-smoke runtime settings", () => {
  const config = loadAppConfig({
    APP_EXECUTION_MODE: "LIVE",
    ENABLE_LIVE_ORDERS: "true",
    STRATEGY_SCHEDULER_ENABLED: "true",
    STRATEGY_SCHEDULER_RUN_ON_START: "true",
    ENABLE_TELEGRAM_INBOUND_POLLING: "false",
    TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS: "25",
    TELEGRAM_INBOUND_POLL_LIMIT: "10",
  });

  assert.deepEqual(validateTelegramInboundSmokeSafety(config), [
    "APP_EXECUTION_MODE must resolve to DRY_RUN for telegram inbound smoke.",
    "ENABLE_LIVE_ORDERS must resolve to DISABLED for telegram inbound smoke.",
    "STRATEGY_SCHEDULER_ENABLED must be false for telegram inbound smoke.",
    "STRATEGY_SCHEDULER_RUN_ON_START must be false for telegram inbound smoke.",
    "ENABLE_TELEGRAM_INBOUND_POLLING must be true for telegram inbound smoke.",
    "TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS must be 0 for a non-blocking smoke poll.",
    "TELEGRAM_INBOUND_POLL_LIMIT must be 1 for a bounded smoke poll.",
  ]);
});

test("telegram inbound one-shot runs under real scoped ownership and cleans up without Telegram API access", async () => {
  if (process.platform !== "win32") return;

  const databasePath = await createTempDatabasePath("telegram-inbound-owned-smoke");
  const previousDatabasePath = process.env.DATABASE_PATH;
  const cleanupEvents: string[] = [];
  let observedGeneration: number | null = null;
  process.env.DATABASE_PATH = databasePath;

  try {
    const result = await runTelegramInboundSmokeOnce({
      createApplication(config, overrides) {
        overrides.runtimeOwnershipAuthority.assertLocallyHeld();
        observedGeneration = overrides.runtimeOwnershipAuthority.snapshot().generation;
        const status = {
          enabled: true,
          configured: true,
          running: false,
          nextOffset: null,
          pollIntervalMs: 2_000,
          longPollTimeoutSeconds: 0,
          limit: 1,
          lastPollAt: null,
          lastUpdateId: null,
          offsetLoaded: false,
          offsetStorage: "MEMORY" as const,
          processedCount: 0,
          ignoredCount: 0,
          failedCount: 0,
          lastError: null,
        };
        return {
          config,
          liveSendPath: "DRY_RUN_ADAPTER",
          telegramInboundPolling: {
            isConfigured: () => true,
            getStatus: () => ({ ...status }),
            async pollOnce() {
              return {
                status: "COMPLETED" as const,
                receivedCount: 0,
                processedCount: 0,
                ignoredCount: 0,
                failedCount: 0,
                nextOffset: null,
                skippedReason: null,
                errorMessage: null,
              };
            },
            stop() { cleanupEvents.push("inbound:stop"); },
          },
          strategyScheduler: { stop() { cleanupEvents.push("scheduler:stop"); } },
          persistence: { close() { cleanupEvents.push("persistence:close"); } },
        } as never;
      },
    });

    assert.equal(result.status, "COMPLETED");
    assert.ok((observedGeneration ?? 0) > 0);
    assert.deepEqual(cleanupEvents, ["inbound:stop", "scheduler:stop", "persistence:close"]);
  } finally {
    restoreOptionalEnv("DATABASE_PATH", previousDatabasePath);
    await rm(path.dirname(databasePath), { recursive: true, force: true });
  }
});

async function createTempDatabasePath(label: string): Promise<string> {
  const directory = path.resolve("tmp", `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(directory, { recursive: true });
  return path.join(directory, "runtime.sqlite");
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
