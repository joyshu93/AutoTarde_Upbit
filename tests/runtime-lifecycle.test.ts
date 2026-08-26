import assert from "node:assert/strict";

import type { AppServices } from "../src/app/create-app.js";
import {
  createRuntimeShutdown,
  hasBackgroundRuntime,
  installRuntimeOwnershipLossHandler,
  installRuntimeSignalHandlers,
  stopAppRuntime,
  type RuntimeSignalTarget,
} from "../src/app/runtime-lifecycle.js";
import type { RuntimeOwnershipContext } from "../src/app/runtime-ownership-context.js";
import { StrategyScheduler } from "../src/app/strategy-scheduler.js";
import { runAppStartup } from "../src/index.js";
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

test("runtime lifecycle signal handler is idempotent and exits by shutdown status", async () => {
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
  const second = await handler.shutdown("manual");
  await waitFor(() => exits.length === 1);

  assert.equal(closeCount, 1);
  assert.deepEqual(exits, [0]);
  assert.equal(writes.length, 1);
  assert.equal(second.status, "STOPPED");
});

test("runtime lifecycle signal handler reuses an external shutdown owner", async () => {
  const calls: string[] = [];
  const shutdown = createRuntimeShutdown({
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
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
  const handler = installRuntimeSignalHandlers({
    shutdown,
    signalTarget: {
      on(signal, listener) {
        listeners.set(signal, listener);
      },
      exit() {
        return undefined as never;
      },
    },
    writeLine() {},
  });

  await handler.shutdown("manual");
  listeners.get("SIGTERM")?.();
  await waitFor(() => calls.length === 3);

  assert.deepEqual(calls, ["telegram", "scheduler", "persistence"]);
});

test("owned runtime shutdown fences first and releases the process lock last", async () => {
  const events: string[] = [];
  const ownership = createOwnershipContext(events);
  const shutdown = createRuntimeShutdown(createAsyncRuntimeApp(events), ownership, {
    nowEpochMs: () => 123_456,
    timeoutMs: 1_000,
  });

  const summary = await shutdown("SIGTERM");

  assert.deepEqual(events, [
    "ownership:fence",
    "telegram:stop",
    "scheduler:stop",
    "workers:quiesce",
    "ownership:release",
    "app-db:close",
    "ownership-db:close",
    "process-lock:release",
  ]);
  assert.equal(summary.reason, "SIGTERM");
  assert.equal(summary.status, "STOPPED");
  assert.deepEqual(summary.steps.map((step) => step.status), [
    "STOPPED",
    "STOPPED",
    "STOPPED",
    "STOPPED",
    "STOPPED",
    "STOPPED",
    "STOPPED",
    "STOPPED",
  ]);
});

test("owned runtime shutdown shares one promise and preserves the first reason", async () => {
  const events: string[] = [];
  const quiescence = createDeferred<void>();
  const app = createAsyncRuntimeApp(events, {
    async telegramStopAndWait() {
      events.push("workers:quiesce");
      await quiescence.promise;
      return createTelegramStatus(false);
    },
  });
  const shutdown = createRuntimeShutdown(app, createOwnershipContext(events), {
    nowEpochMs: () => 123_456,
    timeoutMs: 1_000,
  });

  const first = shutdown("SIGINT");
  const second = shutdown("RUNTIME_OWNERSHIP_LOST");

  assert.equal(first, second);
  quiescence.resolve();
  const [firstSummary, secondSummary] = await Promise.all([first, second]);
  assert.equal(firstSummary, secondSummary);
  assert.equal(firstSummary.reason, "SIGINT");
  assert.equal(events.filter((event) => event === "process-lock:release").length, 1);
});

test("ownership loss skips persisted release for an already mismatched generation", async () => {
  const events: string[] = [];
  let releaseCalls = 0;
  const ownership = createOwnershipContext(events, {
    status: "LOST",
    lossReason: "PERSISTED_OWNERSHIP_MISMATCH",
    releaseCurrentOwnership: async () => {
      releaseCalls += 1;
      return true;
    },
  });
  const shutdown = createRuntimeShutdown(createAsyncRuntimeApp(events), ownership, {
    nowEpochMs: () => 123_456,
    timeoutMs: 1_000,
  });

  const summary = await shutdown("RUNTIME_OWNERSHIP_LOST");

  assert.equal(releaseCalls, 0);
  assert.equal(summary.status, "STOPPED");
  assert.equal(
    summary.steps.find((step) => step.name === "runtime_ownership_release")?.status,
    "SKIPPED",
  );
  assert.deepEqual(events, [
    "ownership:fence",
    "telegram:stop",
    "scheduler:stop",
    "workers:quiesce",
    "app-db:close",
    "ownership-db:close",
    "process-lock:release",
  ]);
});

test("release and database close failures produce partial shutdown", async () => {
  const events: string[] = [];
  const ownership = createOwnershipContext(events, {
    releaseCurrentOwnership: async () => {
      events.push("ownership:release");
      return false;
    },
    closeOwnershipDatabase() {
      events.push("ownership-db:close");
      throw new Error("ownership_db_close_failed");
    },
  });
  const app = createAsyncRuntimeApp(events, {
    closeAppDatabase() {
      events.push("app-db:close");
      throw new Error("app_db_close_failed");
    },
  });

  const summary = await createRuntimeShutdown(app, ownership, {
    nowEpochMs: () => 123_456,
    timeoutMs: 1_000,
  })("SIGTERM");

  assert.equal(summary.status, "PARTIAL_FAILURE");
  assert.deepEqual(
    summary.steps.filter((step) => step.status === "FAILED").map((step) => step.name),
    ["runtime_ownership_release", "sqlite_persistence", "runtime_ownership_database"],
  );
  assert.equal(events.at(-1), "process-lock:release");
});

test("worker quiescence timeout prevents ownership release and still closes lock last", async () => {
  const events: string[] = [];
  const never = new Promise<void>(() => undefined);
  const ownership = createOwnershipContext(events);
  const app = createAsyncRuntimeApp(events, {
    async telegramStopAndWait() {
      events.push("workers:quiesce");
      await never;
      return createTelegramStatus(false);
    },
  });

  const summary = await createRuntimeShutdown(app, ownership, {
    nowEpochMs: () => 123_456,
    timeoutMs: 0,
  })("SIGTERM");

  assert.equal(summary.status, "PARTIAL_FAILURE");
  assert.equal(
    summary.steps.find((step) => step.name === "workers_quiescence")?.status,
    "FAILED",
  );
  assert.equal(
    summary.steps.find((step) => step.name === "runtime_ownership_release")?.status,
    "SKIPPED",
  );
  assert.equal(events.includes("ownership:release"), false);
  assert.equal(events.at(-1), "process-lock:release");
});

test("scheduler final persistence timeout prevents ownership release after running clears", async () => {
  const events: string[] = [];
  const finalPersistence = createDeferred<void>();
  let finalPersistenceStarted = false;
  let runSettled = false;
  let releaseCalled = false;
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "DRY_RUN_ADAPTER",
      markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
    },
    controller: {
      async requestRun(request) {
        return {
          status: "COMPLETED",
          requestedAt: "2026-08-26T00:00:00.000Z",
          market: request.market,
          strategyDecisionId: "decision-1",
          action: "HOLD",
          orderId: null,
          orderStatus: null,
          submissionAccepted: null,
          detail: "Decision completed.",
        };
      },
      async requestPreview() {
        throw new Error("Preview is not used by this regression.");
      },
    },
    repositories: {
      async saveStrategySchedulerRun() {},
      async updateStrategySchedulerRun() {
        finalPersistenceStarted = true;
        await finalPersistence.promise;
      },
    },
    now: () => "2026-08-26T00:00:00.000Z",
  });
  const currentRun = scheduler.runMarketNow("KRW-BTC").finally(() => {
    runSettled = true;
  });
  await waitFor(() => finalPersistenceStarted);
  assert.equal(scheduler.getStatus().markets[0]?.running, false);

  const ownership = createOwnershipContext(events, {
    async releaseCurrentOwnership() {
      releaseCalled = true;
      events.push("ownership:release");
      return true;
    },
  });
  const summary = await createRuntimeShutdown({
    telegramInboundPolling: {
      stop: () => createTelegramStatus(false),
      stopAndWait: async () => createTelegramStatus(false),
    },
    strategyScheduler: scheduler,
    persistence: {
      close() {
        events.push("app-db:close");
      },
    },
  }, ownership, {
    nowEpochMs: () => 123_456,
    timeoutMs: 0,
  })("SIGTERM");

  assert.equal(summary.status, "PARTIAL_FAILURE");
  assert.equal(
    summary.steps.find((step) => step.name === "workers_quiescence")?.status,
    "FAILED",
  );
  assert.equal(
    summary.steps.find((step) => step.name === "runtime_ownership_release")?.status,
    "SKIPPED",
  );
  assert.equal(releaseCalled, false);
  assert.equal(runSettled, false);
  assert.equal(events.at(-1), "process-lock:release");

  finalPersistence.resolve();
  await currentRun;
});

test("partial signal shutdown exits non-zero after asynchronous cleanup", async () => {
  const exits: number[] = [];
  const listeners = new Map<"SIGINT" | "SIGTERM", () => void>();
  installRuntimeSignalHandlers({
    shutdown: async (reason = "MISSING_REASON") => ({
      reason,
      status: "PARTIAL_FAILURE",
      steps: [],
    }),
    signalTarget: {
      on(signal, listener) {
        listeners.set(signal, listener);
      },
      exit(code) {
        exits.push(code ?? 0);
        return undefined as never;
      },
    },
    writeLine() {},
  });

  listeners.get("SIGTERM")?.();
  await waitFor(() => exits.length === 1);

  assert.deepEqual(exits, [1]);
});

test("ownership loss uses the signal shutdown owner and always exits non-zero", async () => {
  const reasons: string[] = [];
  const exits: number[] = [];
  let lose: ((reason: string) => void) | null = null;
  installRuntimeSignalHandlers({
    shutdown: async (reason = "MISSING_REASON") => {
      reasons.push(reason);
      return { reason, status: "STOPPED", steps: [] };
    },
    ownershipLossSource: {
      onLost(listener) {
        lose = listener;
        return () => undefined;
      },
    },
    signalTarget: {
      on() {},
      exit(code) {
        exits.push(code ?? 0);
        return undefined as never;
      },
    },
    writeLine() {},
  });

  (lose as ((reason: string) => void) | null)?.("PERSISTED_OWNERSHIP_MISMATCH");
  await waitFor(() => exits.length === 1);

  assert.deepEqual(reasons, ["RUNTIME_OWNERSHIP_LOST"]);
  assert.deepEqual(exits, [1]);
});

test("ownership loss can attach to the shared shutdown owner before signal installation", async () => {
  const reasons: string[] = [];
  const exits: number[] = [];
  let lose: ((reason: string) => void) | null = null;
  installRuntimeOwnershipLossHandler({
    shutdown: async (reason) => {
      reasons.push(reason);
      return { reason, status: "STOPPED", steps: [] };
    },
    ownershipLossSource: {
      onLost(listener) {
        lose = listener;
        return () => undefined;
      },
    },
    signalTarget: {
      on() {},
      exit(code) {
        exits.push(code ?? 0);
        return undefined as never;
      },
    },
    writeLine() {},
  });

  (lose as ((reason: string) => void) | null)?.("HEARTBEAT_EXPIRED");
  await waitFor(() => exits.length === 1);

  assert.deepEqual(reasons, ["RUNTIME_OWNERSHIP_LOST"]);
  assert.deepEqual(exits, [1]);
});

test("runAppStartup subscribes ownership loss before candidate startup initialization", async () => {
  const events: string[] = [];
  const startupError = new Error("stop_after_ordering_check");
  const baseOwnership = createOwnershipContext(events);
  const ownership = {
    ...baseOwnership,
    guard: Object.assign(baseOwnership.guard, {
      onLost() {
        events.push("ownership-loss:subscribe");
        return () => undefined;
      },
    }),
  } satisfies RuntimeOwnershipContext;
  const app = {
    candidatePilotStartupAuthority: {
      async initialize() {
        events.push("candidate:initialize");
        assert.deepEqual(events.slice(0, 2), [
          "ownership-loss:subscribe",
          "candidate:initialize",
        ]);
        throw startupError;
      },
    },
    telegramInboundPolling: {
      stop: () => createTelegramStatus(false),
      stopAndWait: async () => createTelegramStatus(false),
    },
    strategyScheduler: {
      stop: () => createSchedulerStatus(false),
      stopAndWait: async () => createSchedulerStatus(false),
    },
    persistence: {
      close() {},
    },
  } as unknown as AppServices;

  await assert.rejects(
    () => runAppStartup(app, { runtimeOwnership: ownership }),
    (error) => error === startupError,
  );

  assert.deepEqual(events.slice(0, 2), [
    "ownership-loss:subscribe",
    "candidate:initialize",
  ]);
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

function createAsyncRuntimeApp(
  events: string[],
  overrides: {
    telegramStopAndWait?: (timeoutMs: number) => Promise<ReturnType<typeof createTelegramStatus>>;
    schedulerStopAndWait?: (timeoutMs: number) => Promise<ReturnType<typeof createSchedulerStatus>>;
    closeAppDatabase?: () => void;
  } = {},
) {
  return {
    telegramInboundPolling: {
      stop() {
        events.push("telegram:stop");
        return createTelegramStatus(false);
      },
      stopAndWait: overrides.telegramStopAndWait ?? (async () => {
        events.push("workers:quiesce");
        return createTelegramStatus(false);
      }),
    },
    strategyScheduler: {
      stop() {
        events.push("scheduler:stop");
        return createSchedulerStatus(false);
      },
      stopAndWait: overrides.schedulerStopAndWait ?? (async () => createSchedulerStatus(false)),
    },
    persistence: {
      close: overrides.closeAppDatabase ?? (() => {
        events.push("app-db:close");
      }),
    },
  };
}

function createOwnershipContext(
  events: string[],
  overrides: {
    status?: "OWNED" | "LOST";
    lossReason?: string | null;
    releaseCurrentOwnership?: (releasedAtEpochMs: number) => Promise<boolean>;
    closeOwnershipDatabase?: () => void;
  } = {},
): RuntimeOwnershipContext {
  const status = overrides.status ?? "OWNED";
  return {
    guard: {} as RuntimeOwnershipContext["guard"],
    heartbeat: {
      async stop() {},
    } as RuntimeOwnershipContext["heartbeat"],
    snapshot: () => ({
      status,
      generation: 7,
      executionMode: "LIVE",
      acquiredAtEpochMs: 1_000,
      heartbeatAtEpochMs: 2_000,
      expiresAtEpochMs: 47_000,
      takeover: false,
      lossReason: overrides.lossReason ?? null,
    }),
    fence() {
      events.push("ownership:fence");
    },
    releaseCurrentOwnership: overrides.releaseCurrentOwnership ?? (async () => {
      events.push("ownership:release");
      return true;
    }),
    closeOwnershipDatabase: overrides.closeOwnershipDatabase ?? (() => {
      events.push("ownership-db:close");
    }),
    async releaseProcessLock() {
      events.push("process-lock:release");
    },
    async shutdownAfterStartupFailure() {},
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for asynchronous lifecycle event.");
}
