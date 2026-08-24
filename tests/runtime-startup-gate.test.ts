import assert from "node:assert/strict";

import { runRuntimeStartupGate, stopAppRuntime } from "../src/app/runtime-lifecycle.js";
import { test } from "./harness.js";

test("runtime startup gate continues without candidate initialization when initializer is null", async () => {
  const events: string[] = [];

  await runRuntimeStartupGate({
    initializer: null,
    continueStartup: async () => {
      events.push("continuation");
    },
    shutdown: () => {
      events.push("shutdown");
    },
  });

  assert.deepEqual(events, ["continuation"]);
});

test("runtime startup gate awaits initialization before continuing", async () => {
  const events: string[] = [];

  await runRuntimeStartupGate({
    initializer: {
      async initialize() {
        events.push("initializer:start");
        await Promise.resolve();
        events.push("initializer:complete");
      },
    },
    continueStartup: async () => {
      events.push("continuation");
    },
    shutdown: () => {
      events.push("shutdown");
    },
  });

  assert.deepEqual(events, ["initializer:start", "initializer:complete", "continuation"]);
});

test("runtime startup gate stops every resource once and preserves initializer failure identity", async () => {
  const originalError = new Error("initializer_failed");
  const calls: string[] = [];

  await assert.rejects(
    () => runRuntimeStartupGate({
      initializer: {
        async initialize() {
          throw originalError;
        },
      },
      continueStartup: async () => {
        calls.push("continuation");
      },
      shutdown: () => stopAppRuntime(createRuntimeApp(calls)),
    }),
    (error) => error === originalError,
  );

  assert.deepEqual(calls, ["telegram", "scheduler", "persistence"]);
});

test("runtime startup gate stops every resource once and preserves continuation failure when cleanup partially fails", async () => {
  const originalError = new Error("continuation_failed");
  const calls: string[] = [];

  await assert.rejects(
    () => runRuntimeStartupGate({
      initializer: null,
      continueStartup: async () => {
        throw originalError;
      },
      shutdown: () => stopAppRuntime(createRuntimeApp(calls, true)),
    }),
    (error) => error === originalError,
  );

  assert.deepEqual(calls, ["telegram", "scheduler", "persistence"]);
});

function createRuntimeApp(calls: string[], failTelegramStop = false) {
  return {
    telegramInboundPolling: {
      stop() {
        calls.push("telegram");
        if (failTelegramStop) {
          throw new Error("telegram_cleanup_failed");
        }
        return createTelegramStatus(false);
      },
    },
    strategyScheduler: {
      stop() {
        calls.push("scheduler");
        return createSchedulerStatus(false);
      },
    },
    persistence: {
      close() {
        calls.push("persistence");
      },
    },
  };
}

function createTelegramStatus(running: boolean) {
  return {
    enabled: true,
    configured: true,
    running,
    nextOffset: null,
    pollIntervalMs: 1000,
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
}

function createSchedulerStatus(started: boolean) {
  return {
    enabled: true,
    started,
    exchangeAccountId: "primary",
    liveSendPath: "DRY_RUN_ADAPTER" as const,
    startupPreflight: null,
    markets: [],
  };
}
