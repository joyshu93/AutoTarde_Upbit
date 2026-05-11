import assert from "node:assert/strict";

import {
  hasBackgroundRuntime,
  installRuntimeSignalHandlers,
  stopAppRuntime,
  type RuntimeSignalTarget,
} from "../src/app/runtime-lifecycle.js";
import { test } from "./harness.js";

test("runtime lifecycle detects whether background timers are active", () => {
  assert.equal(hasBackgroundRuntime({
    strategyScheduler: { started: false },
    telegramInboundPolling: { running: false },
  }), false);
  assert.equal(hasBackgroundRuntime({
    strategyScheduler: { started: true },
    telegramInboundPolling: { running: false },
  }), true);
  assert.equal(hasBackgroundRuntime({
    strategyScheduler: { started: false },
    telegramInboundPolling: { running: true },
  }), true);
});

test("runtime lifecycle stops polling, scheduler, and persistence explicitly", () => {
  const calls: string[] = [];
  const summary = stopAppRuntime({
    telegramInboundPolling: {
      stop() {
        calls.push("telegram");
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
  });

  assert.equal(summary.status, "STOPPED");
  assert.deepEqual(calls, ["telegram", "scheduler", "persistence"]);
  assert.deepEqual(summary.steps.map((step) => step.status), ["STOPPED", "STOPPED", "STOPPED"]);
});

test("runtime lifecycle records shutdown failures instead of throwing", () => {
  const summary = stopAppRuntime({
    telegramInboundPolling: {
      stop() {
        throw new Error("telegram_stop_failed");
      },
    },
    strategyScheduler: {
      stop() {
        return createSchedulerStatus(false);
      },
    },
    persistence: {
      close() {},
    },
  });

  assert.equal(summary.status, "PARTIAL_FAILURE");
  assert.equal(summary.steps[0]?.status, "FAILED");
  assert.equal(summary.steps[0]?.errorMessage, "telegram_stop_failed");
});

test("runtime lifecycle signal handler is idempotent and exits by shutdown status", () => {
  const writes: string[] = [];
  const exits: number[] = [];
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
  const signalTarget: RuntimeSignalTarget = {
    on(signal, listener) {
      listeners.set(signal, listener);
    },
    exit(code) {
      exits.push(code ?? 0);
      return undefined as never;
    },
  };
  let closeCount = 0;
  const handler = installRuntimeSignalHandlers({
    app: {
      telegramInboundPolling: {
        stop() {
          return createTelegramStatus(false);
        },
      },
      strategyScheduler: {
        stop() {
          return createSchedulerStatus(false);
        },
      },
      persistence: {
        close() {
          closeCount += 1;
        },
      },
    },
    signalTarget,
    writeLine: (line) => writes.push(line),
  });

  listeners.get("SIGINT")?.();
  const second = handler.shutdown("manual");

  assert.equal(closeCount, 1);
  assert.deepEqual(exits, [0]);
  assert.equal(writes.length, 1);
  assert.equal(second.status, "STOPPED");
});

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
