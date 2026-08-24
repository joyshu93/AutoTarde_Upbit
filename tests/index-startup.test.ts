import assert from "node:assert/strict";

import type { AppServices } from "../src/app/create-app.js";
import type { AppStartupOperations } from "../src/index.js";
import { test } from "./harness.js";

type IndexModule = typeof import("../src/index.js") & {
  runMain(createApplication?: () => AppServices): Promise<void>;
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

test("runMain leaves createApp failure cleanup with the factory and preserves error identity", async () => {
  const events: string[] = [];
  const { runMain } = await loadFreshIndexModule();
  const originalError = new Error("create_app_failed");
  const app = createAppFixture(events, {
    async initialize() {
      events.push("initializer");
    },
  }, true);

  await assert.rejects(
    () => runMain(() => {
      events.push("factory");
      app.telegramInboundPolling.stop();
      app.strategyScheduler.stop();
      app.persistence.close();
      throw originalError;
    }),
    (error) => error === originalError,
  );

  assert.deepEqual(events, [
    "factory",
    "telegram:stop",
    "scheduler:stop",
    "persistence:close",
  ]);
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
): AppServices {
  return {
    candidatePilotInitializer,
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
