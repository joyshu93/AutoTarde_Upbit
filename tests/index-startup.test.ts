import assert from "node:assert/strict";

import type { AppServices } from "../src/app/create-app.js";
import type { AppConfig } from "../src/app/env.js";
import { RuntimeOwnershipGuardError } from "../src/app/runtime-ownership-guard.js";
import { RuntimeProcessLockError, type RuntimeProcessLock } from "../src/app/runtime-process-lock.js";
import type { RuntimeOwnershipContext, VerifiedRuntimeDatabase } from
  "../src/app/runtime-ownership-context.js";
import type { AppStartupOperations, RunMainOperations } from "../src/index.js";
import { test } from "./harness.js";

type IndexModule = typeof import("../src/index.js") & {
  runMain(operations?: Partial<RunMainOperations>): Promise<void>;
};

let indexModulePromise: Promise<IndexModule> | null = null;

test("freshly evaluating the index module has no runtime startup side effect", async () => {
  const before = process.listenerCount("SIGINT");

  await loadFreshIndexModule();

  assert.equal(process.listenerCount("SIGINT"), before);
});

test("application startup runs every production continuation step after candidate initialization", async () => {
  const events: string[] = [];
  const { runAppStartup } = await loadFreshIndexModule();
  const app = createAppFixture(events, {
    async initialize() {
      events.push("initializer");
    },
  }, true);

  await runAppStartup(app, createOperations(events));

  assert.deepEqual(events, [
    "initializer",
    "recovery",
    "policy",
    "delivery",
    "state",
    "preflight",
    "scheduler:preflight",
    "scheduler:start",
    "scheduler:report",
    "polling:start",
    "signals:install",
    "menu:setup",
    "banner",
  ]);
});

test("selected-candidate startup recovery completes before every generic and runtime surface", async () => {
  const events: string[] = [];
  const { runAppStartup } = await loadFreshIndexModule();
  const app = createAppFixture(events, {
    async initialize() {
      events.push("initializer");
    },
  }, true, "COMPLETED", {
    async prepareAndRecover() {
      events.push("candidate:recovery");
      return { status: "READY" } as const;
    },
  });

  await runAppStartup(app, createOperations(events));

  assert.deepEqual(events.slice(0, 5), [
    "initializer",
    "candidate:recovery",
    "recovery",
    "policy",
    "delivery",
  ]);
});

test("candidate startup recovery failure owns shutdown before either market can start", async () => {
  const events: string[] = [];
  const { runAppStartup } = await loadFreshIndexModule();
  const originalError = new Error("candidate_startup_recovery_failed");
  const app = createAppFixture(events, null, true, "COMPLETED", {
    async prepareAndRecover() {
      events.push("candidate:recovery");
      throw originalError;
    },
  });

  await assert.rejects(
    () => runAppStartup(app, createOperations(events)),
    (error) => error === originalError,
  );

  assert.deepEqual(events, [
    "candidate:recovery",
    "telegram:stop",
    "scheduler:stop",
    "persistence:close",
  ]);
});

test("application startup keeps successful background work open", async () => {
  const events: string[] = [];
  const { runAppStartup } = await loadFreshIndexModule();
  const app = createAppFixture(events, null, true);

  await runAppStartup(app, createOperations(events));

  assert.equal(events.includes("telegram:stop"), false);
  assert.equal(events.includes("scheduler:stop"), false);
  assert.equal(events.includes("persistence:close"), false);
});

test("application startup performs the existing one-time stop when no background work starts", async () => {
  const events: string[] = [];
  const { runAppStartup } = await loadFreshIndexModule();
  const app = createAppFixture(events, null, false);

  await runAppStartup(app, createOperations(events));

  assert.equal(events.filter((event) => event === "telegram:stop").length, 1);
  assert.equal(events.filter((event) => event === "scheduler:stop").length, 1);
  assert.equal(events.filter((event) => event === "persistence:close").length, 1);
});

test("application startup keeps command-menu failure isolated and nonthrowing", async () => {
  const events: string[] = [];
  const { runAppStartup } = await loadFreshIndexModule();
  const app = createAppFixture(events, null, true, "FAILED");

  await runAppStartup(app, createOperations(events));

  assert.deepEqual(events.slice(-2), ["menu:setup", "banner"]);
});

test("application startup shares one shutdown owner after banner failure following signal installation", async () => {
  const events: string[] = [];
  const { runAppStartup } = await loadFreshIndexModule();
  const originalError = new Error("banner_failed");
  let installedShutdown: (() => unknown) | null = null;
  const app = createAppFixture(events, null, true);

  await assert.rejects(
    () => runAppStartup(app, {
      ...createOperations(events),
      installRuntimeSignalHandlers(input) {
        events.push("signals:install");
        installedShutdown = input.shutdown ?? null;
        return {} as never;
      },
      writeBanner() {
        events.push("banner");
        throw originalError;
      },
    }),
    (error) => error === originalError,
  );

  (installedShutdown as (() => unknown) | null)?.();

  assert.equal(events.filter((event) => event === "telegram:stop").length, 1);
  assert.equal(events.filter((event) => event === "scheduler:stop").length, 1);
  assert.equal(events.filter((event) => event === "persistence:close").length, 1);
});

test("runMain preserves createApp failure identity while releasing acquired ownership", async () => {
  const events: string[] = [];
  const { runMain } = await loadFreshIndexModule();
  const originalError = new Error("create_app_failed");
  const runtime = createRunMainFixture(events);

  await assert.rejects(
    () => runMain({
      ...runtime.operations,
      createApp() {
        events.push("app:create");
        throw originalError;
      },
    }),
    (error) => error === originalError,
  );

  assert.deepEqual(events, [
    "config:load",
    "identity:verify",
    "process-lock:acquire",
    "ownership-db:open",
    "ownership:acquire",
    "heartbeat:start",
    "app:create",
    "ownership:startup-failure",
  ]);
});

test("runAppStartup preserves notification delivery ownership loss and starts no worker", async () => {
  const events: string[] = [];
  const { runAppStartup } = await loadFreshIndexModule();
  const originalError = new RuntimeOwnershipGuardError(
    "RUNTIME_OWNERSHIP_LOST",
    "RUNTIME_OWNERSHIP_LOST: STARTUP_DELIVERY_LOST",
  );
  const app = createAppFixture(events, null, true);
  Object.defineProperty(app.notificationDelivery, "deliverPending", {
    configurable: true,
    value: async () => {
      events.push("delivery");
      throw originalError;
    },
  });

  await assert.rejects(
    () => runAppStartup(app, createOperations(events)),
    (error) => error === originalError,
  );

  assert.deepEqual(events, [
    "recovery",
    "policy",
    "delivery",
    "telegram:stop",
    "scheduler:stop",
    "persistence:close",
  ]);
});

test("runAppStartup routes scheduled ownership loss through the shared shutdown owner", async () => {
  const events: string[] = [];
  const { runAppStartup } = await loadFreshIndexModule();
  const app = createAppFixture(events, null, true);
  let onRuntimeOwnershipLost: ((error: unknown) => void) | undefined;
  Object.defineProperty(app.strategyScheduler, "start", {
    configurable: true,
    value(handler?: (error: unknown) => void) {
      events.push("scheduler:start");
      onRuntimeOwnershipLost = handler;
      return { started: true };
    },
  });

  await runAppStartup(app, createOperations(events));
  events.length = 0;

  assert.ok(onRuntimeOwnershipLost);
  onRuntimeOwnershipLost(new RuntimeOwnershipGuardError(
    "RUNTIME_OWNERSHIP_LOST",
    "RUNTIME_OWNERSHIP_LOST: SCHEDULED_CALLBACK_LOST",
  ));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    "telegram:stop",
    "scheduler:stop",
    "persistence:close",
  ]);
});

test("runMain acquires both ownership layers before application construction and candidate authority", async () => {
  const events: string[] = [];
  const { runMain } = await loadFreshIndexModule();
  const runtime = createRunMainFixture(events);

  await runMain(runtime.operations);

  assert.deepEqual(events.slice(0, 8), [
    "config:load",
    "identity:verify",
    "process-lock:acquire",
    "ownership-db:open",
    "ownership:acquire",
    "heartbeat:start",
    "app:create",
    "candidate-authority",
  ]);
});

test("contended process lock causes zero mutable runtime side effects", async () => {
  const events: string[] = [];
  const sideEffects: string[] = [];
  const { runMain } = await loadFreshIndexModule();
  const originalError = new RuntimeProcessLockError(
    "RUNTIME_ALREADY_OWNED",
    "Another runtime already owns this scope.",
  );
  const runtime = createRunMainFixture(events);

  await assert.rejects(
    () => runMain({
      ...runtime.operations,
      async acquireRuntimeProcessLock() {
        events.push("process-lock:acquire");
        throw originalError;
      },
      async createRuntimeOwnershipContext() {
        sideEffects.push("mutable-sqlite-open", "ownership-acquire", "heartbeat-start");
        return runtime.ownership;
      },
      createApp() {
        sideEffects.push("app-construction", "bootstrap");
        return runtime.app;
      },
      async runAppStartup() {
        sideEffects.push(
          "candidate-initialization",
          "candidate-recovery",
          "upbit-read",
          "telegram-delivery",
          "telegram-menu",
          "telegram-polling",
          "scheduler",
          "order-send",
        );
      },
    }),
    (error) => error === originalError,
  );

  assert.deepEqual(events, ["config:load", "identity:verify", "process-lock:acquire"]);
  assert.deepEqual(sideEffects, []);
});

function loadFreshIndexModule(): Promise<IndexModule> {
  if (!indexModulePromise) {
    const moduleUrl = new URL("../src/index.js", import.meta.url);
    moduleUrl.searchParams.set("index-startup-test", "fresh-evaluation");
    indexModulePromise = import(moduleUrl.href) as Promise<IndexModule>;
  }

  return indexModulePromise;
}

function createOperations(
  events: string[],
): AppStartupOperations {
  return {
    async runStartupRecovery() {
      events.push("recovery");
      return {} as never;
    },
    async applyStartupRecoveryPolicy() {
      events.push("policy");
      return {} as never;
    },
    async buildStrategySchedulerStartupPreflight() {
      events.push("preflight");
      return {} as never;
    },
    installRuntimeSignalHandlers() {
      events.push("signals:install");
      return {} as never;
    },
    writeBanner() {
      events.push("banner");
    },
  };
}

function createAppFixture(
  events: string[],
  candidatePilotInitializer: { initialize(): Promise<unknown> } | null,
  hasBackgroundWork: boolean,
  menuStatus: "COMPLETED" | "FAILED" = "COMPLETED",
  candidatePilotStartupRecovery: {
    prepareAndRecover(): Promise<Readonly<{ status: "READY" }>>;
  } | null = null,
): AppServices {
  return {
    candidatePilotInitializer,
    candidatePilotStartupAuthority: candidatePilotInitializer,
    candidatePilotStartupRecovery,
    exchangeBackedReadEnabled: false,
    portfolioSyncService: {} as never,
    operatorState: {
      async getState() {
        events.push("state");
        return {} as never;
      },
    } as never,
    notificationDelivery: {
      async deliverPending() {
        events.push("delivery");
        return {
          attempted: 0,
          sent: 0,
          retryScheduled: 0,
          failed: 0,
          staleLease: 0,
          pendingDue: 0,
          pendingScheduled: 0,
          activeLease: 0,
          skippedReason: null,
        };
      },
      isConfigured() {
        return false;
      },
    } as never,
    config: {} as never,
    repositories: {} as never,
    liveSendPath: "DRY_RUN_ADAPTER",
    strategyScheduler: {
      setStartupPreflight() {
        events.push("scheduler:preflight");
      },
      start() {
        events.push("scheduler:start");
        return { started: hasBackgroundWork };
      },
      async reportStartupBlockIfNeeded() {
        events.push("scheduler:report");
        return false;
      },
      stop() {
        events.push("scheduler:stop");
        return {} as never;
      },
    } as never,
    telegramInboundPolling: {
      isConfigured() {
        return false;
      },
      start() {
        events.push("polling:start");
        return { running: false };
      },
      stop() {
        events.push("telegram:stop");
        return {} as never;
      },
    } as never,
    telegramRouter: {
      getSupportedCommands() {
        return [];
      },
    } as never,
    telegramCommandMenuSetup: {
      async setup() {
        events.push("menu:setup");
        return {
          configured: true,
          attempted: true,
          status: menuStatus,
          failureCode: null,
          korean: "COMPLETED",
          english: menuStatus,
        } as never;
      },
    } as never,
    persistence: {
      close() {
        events.push("persistence:close");
      },
    } as never,
  } as unknown as AppServices;
}

function createRunMainFixture(events: string[]): {
  readonly app: AppServices;
  readonly ownership: RuntimeOwnershipContext;
  readonly operations: RunMainOperations;
} {
  const config = {} as AppConfig;
  const verified = {
    canonicalDatabasePath: "C:\\runtime-test\\autotrade.sqlite",
    lockIdentity: { scopeDigest: "a".repeat(64) },
  } satisfies VerifiedRuntimeDatabase;
  const processLock = {
    identity: verified.lockIdentity,
    isHeld: () => true,
    onLost: () => () => undefined,
    async release() {
      events.push("process-lock:release");
    },
  } satisfies RuntimeProcessLock;
  const ownership = {
    guard: {} as never,
    heartbeat: {} as never,
    snapshot: () => ({ status: "OWNED" }) as never,
    fence() {},
    async releaseCurrentOwnership() {
      return true;
    },
    async waitForLossRecording() {},
    closeOwnershipDatabase() {},
    async releaseProcessLock() {},
    async shutdownAfterStartupFailure() {
      events.push("ownership:startup-failure");
    },
  } satisfies RuntimeOwnershipContext;
  const app = createAppFixture(events, {
    async initialize() {
      events.push("candidate-authority");
    },
  }, false);
  const operations: RunMainOperations = {
    loadAppConfig() {
      events.push("config:load");
      return config;
    },
    verifyAndResolveRuntimeDatabase() {
      events.push("identity:verify");
      return verified;
    },
    async acquireRuntimeProcessLock() {
      events.push("process-lock:acquire");
      return processLock;
    },
    async createRuntimeOwnershipContext() {
      events.push("ownership-db:open", "ownership:acquire", "heartbeat:start");
      return ownership;
    },
    createApp() {
      events.push("app:create");
      return app;
    },
    async runAppStartup(startedApp) {
      await startedApp.candidatePilotStartupAuthority.initialize();
    },
  };
  return { app, ownership, operations };
}
