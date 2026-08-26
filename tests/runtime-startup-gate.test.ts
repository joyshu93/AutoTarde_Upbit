import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { loadAppConfig } from "../src/app/env.js";
import { provisionLiveDatabaseIdentity } from "../src/app/live-database-identity.js";
import { runRuntimeStartupGate, stopAppRuntime } from "../src/app/runtime-lifecycle.js";
import {
  createRuntimeOwnershipContext,
  verifyAndResolveRuntimeDatabase,
  type RuntimeOwnershipContextDependencies,
} from "../src/app/runtime-ownership-context.js";
import type { RuntimeProcessLock, RuntimeProcessLockLossReason } from
  "../src/app/runtime-process-lock.js";
import {
  createSqlitePersistence,
  createSqliteRuntimeOwnershipPersistence,
} from "../src/modules/db/repositories/sqlite-repositories.js";
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

test("runtime ownership context closes its dedicated SQLite connection independently", async () => {
  const databasePath = await createTempDatabasePath("dedicated-connection");
  const processLock = new FakeRuntimeProcessLock();
  let ownership: Awaited<ReturnType<typeof createRuntimeOwnershipContext>> | null = null;
  let appPersistence: ReturnType<typeof createSqlitePersistence> | null = null;

  try {
    ownership = await createRuntimeOwnershipContext(
      createOwnershipContextInput(databasePath, processLock),
    );
    appPersistence = createSqlitePersistence({
      databasePath,
      exchangeAccountId: "primary",
      userId: "system_operator",
      userTelegramId: "system_operator",
      userDisplayName: "System Operator",
      accessKeyRef: "UNCONFIGURED",
      secretKeyRef: "UNCONFIGURED",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      killSwitchActive: false,
    });

    assert.equal(ownership.snapshot().status, "OWNED");
    assert.equal(await ownership.releaseCurrentOwnership(Date.now()), true);
    ownership.closeOwnershipDatabase();
    assert.equal((await appPersistence.operatorState.getState()).exchangeAccountId, "primary");
  } finally {
    appPersistence?.close();
    ownership?.closeOwnershipDatabase();
    await ownership?.releaseProcessLock();
    await cleanupTempDatabase(databasePath);
  }
});

test("startup-failure ownership cleanup is idempotent and releases only acquired resources", async () => {
  const databasePath = await createTempDatabasePath("startup-failure-cleanup");
  const processLock = new FakeRuntimeProcessLock();
  const ownership = await createRuntimeOwnershipContext(
    createOwnershipContextInput(databasePath, processLock),
  );

  await ownership.shutdownAfterStartupFailure();
  await ownership.shutdownAfterStartupFailure();

  assert.equal(ownership.snapshot().status, "LOST");
  assert.equal(processLock.releaseCalls, 1);
  await cleanupTempDatabase(databasePath);
});

test("ownership database open failure preserves its error and releases the acquired process lock", async () => {
  const databasePath = await createTempDatabasePath("ownership-open-failure");
  const processLock = new FakeRuntimeProcessLock();
  await mkdir(databasePath);
  let originalError: unknown;

  try {
    await createRuntimeOwnershipContext(createOwnershipContextInput(databasePath, processLock));
  } catch (error) {
    originalError = error;
  }

  assert.ok(originalError instanceof Error);
  assert.match(originalError.message, /SQLite|database|open/u);
  assert.equal(processLock.releaseCalls, 1);
  await rm(databasePath, { recursive: true, force: true });
});

test("verified scope mismatch fails before ownership DB open and releases the process lock", async () => {
  const processLock = new FakeRuntimeProcessLock();
  let ownershipDatabaseOpenCalls = 0;

  await assert.rejects(
    () => createRuntimeOwnershipContext({
      executionMode: "DRY_RUN",
      verifiedDatabase: {
        canonicalDatabasePath: path.resolve("scope-mismatch.sqlite"),
        lockIdentity: { scopeDigest: "a".repeat(64) },
      },
      processLock,
    }, {
      createOwnershipPersistence() {
        ownershipDatabaseOpenCalls += 1;
        throw new Error("ownership DB must not open for a mismatched scope");
      },
    }),
    /does not match the verified database scope/u,
  );

  assert.equal(ownershipDatabaseOpenCalls, 0);
  assert.equal(processLock.releaseCalls, 1);
});

test("production lock identity is mode invariant while LIVE still verifies database identity", async () => {
  const databasePath = await createTempDatabasePath("cross-mode-lock-identity");
  const databaseInstanceId = "22222222-2222-4222-8222-222222222222";
  const accessKey = "runtime-cross-mode-access-key";
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;

  try {
    const setup = createSqlitePersistence({
      databasePath,
      exchangeAccountId: "primary",
      userId: "system_operator",
      userTelegramId: "system_operator",
      userDisplayName: "System Operator",
      accessKeyRef: "TEST:UPBIT_ACCESS_KEY",
      secretKeyRef: "TEST:UPBIT_SECRET_KEY",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      killSwitchActive: false,
    });
    setup.close();
    provisionLiveDatabaseIdentity({
      databasePath,
      databaseInstanceId,
      exchangeAccountId: "primary",
      upbitAccessKey: accessKey,
    });
    process.env.UPBIT_ACCESS_KEY = accessKey;

    const dryRun = verifyAndResolveRuntimeDatabase(loadAppConfig({
      APP_EXECUTION_MODE: "DRY_RUN",
      DATABASE_PATH: databasePath,
    }));
    const live = verifyAndResolveRuntimeDatabase(loadAppConfig({
      APP_EXECUTION_MODE: "LIVE",
      DATABASE_PATH: databasePath,
      LIVE_DATABASE_INSTANCE_ID: databaseInstanceId,
    }));

    assert.equal(live.canonicalDatabasePath, dryRun.canonicalDatabasePath);
    assert.deepEqual(live.lockIdentity, dryRun.lockIdentity);

    process.env.UPBIT_ACCESS_KEY = "wrong-runtime-cross-mode-access-key";
    assert.throws(
      () => verifyAndResolveRuntimeDatabase(loadAppConfig({
        APP_EXECUTION_MODE: "LIVE",
        DATABASE_PATH: databasePath,
        LIVE_DATABASE_INSTANCE_ID: databaseInstanceId,
      })),
      /credential identity does not match/u,
    );
  } finally {
    restoreOptionalEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    await cleanupTempDatabase(databasePath);
  }
});

test("setup failure after ownership DB open closes DB and process lock exactly once", async () => {
  const databasePath = await createTempDatabasePath("injected-owner-token-failure");
  const events: string[] = [];
  const processLock = new FakeRuntimeProcessLock(events);
  const originalError = new Error("owner_token_generation_failed");
  let unexpectedContext: Awaited<ReturnType<typeof createRuntimeOwnershipContext>> | null = null;
  let caught: unknown;
  const dependencies = {
    createOwnershipPersistence(openedPath: string) {
      events.push(`ownership-db:open:${openedPath}`);
      return {
        runtimeOwnership: createUnexpectedRuntimeOwnershipStore(events),
        close() {
          events.push("ownership-db:close");
        },
      };
    },
    createOwnerToken() {
      events.push("owner-token:create");
      throw originalError;
    },
  } satisfies Partial<RuntimeOwnershipContextDependencies>;

  try {
    unexpectedContext = await createRuntimeOwnershipContext(
      createOwnershipContextInput(databasePath, processLock),
      dependencies,
    );
  } catch (error) {
    caught = error;
  }

  try {
    assert.equal(caught, originalError);
    assert.deepEqual(events, [
      `ownership-db:open:${databasePath}`,
      "owner-token:create",
      "ownership-db:close",
      "process-lock:release",
    ]);
    assert.equal(processLock.releaseCalls, 1);
  } finally {
    await unexpectedContext?.shutdownAfterStartupFailure();
    await cleanupTempDatabase(databasePath);
  }
});

test("runtime context records exact-generation LOST evidence for expiry and process-lock loss", async () => {
  for (const lossKind of ["EXPIRY", "PROCESS_LOCK"] as const) {
    const databasePath = await createTempDatabasePath(`lost-evidence-${lossKind.toLowerCase()}`);
    const processLock = new FakeRuntimeProcessLock();
    const ownership = await createRuntimeOwnershipContext(
      createOwnershipContextInput(databasePath, processLock),
      { nowEpochMs: () => 1_000 },
    );
    try {
      if (lossKind === "EXPIRY") {
        await assert.rejects(() => ownership.guard.assertCurrent(46_000), /OWNERSHIP_EXPIRED/u);
      } else {
        processLock.lose("LISTENER_CLOSED");
      }
      await ownership.waitForLossRecording();

      const inspection = createSqliteRuntimeOwnershipPersistence(
        databasePath,
        processLock.identity.scopeDigest,
      );
      try {
        const events = await inspection.runtimeOwnership.listRecentEvents(10);
        assert.deepEqual(events.map((event) => event.eventType), ["LOST", "ACQUIRED"]);
        assert.equal(
          events[0]?.reasonCode,
          lossKind === "EXPIRY" ? "OWNERSHIP_EXPIRED" : "PROCESS_LOCK_LOST",
        );
        assert.equal(events[0]?.generation, 1);
      } finally {
        inspection.close();
      }
    } finally {
      await ownership.heartbeat.stop();
      ownership.closeOwnershipDatabase();
      await ownership.releaseProcessLock();
      await cleanupTempDatabase(databasePath);
    }
  }
});

test("LOST recording cannot touch a superseding generation and normal shutdown is RELEASED", async () => {
  for (const scenario of ["SUPERSEDED", "NORMAL_SHUTDOWN"] as const) {
    const databasePath = await createTempDatabasePath(`lost-boundary-${scenario.toLowerCase()}`);
    const processLock = new FakeRuntimeProcessLock();
    const ownership = await createRuntimeOwnershipContext(
      createOwnershipContextInput(databasePath, processLock),
      { nowEpochMs: () => 1_000 },
    );
    const inspection = createSqliteRuntimeOwnershipPersistence(
      databasePath,
      processLock.identity.scopeDigest,
    );
    try {
      if (scenario === "SUPERSEDED") {
        await inspection.runtimeOwnership.acquireAfterProcessLock({
          ownerToken: "new-owner".padEnd(64, "x"),
          executionMode: "DRY_RUN",
          acquiredAtEpochMs: 2_000,
          expiresAtEpochMs: 47_000,
        });
        await assert.rejects(
          () => ownership.guard.assertCurrent(2_001),
          /PERSISTED_OWNERSHIP_MISMATCH/u,
        );
      } else {
        ownership.fence("RUNTIME_SHUTDOWN");
      }
      await ownership.waitForLossRecording();
      if (scenario === "NORMAL_SHUTDOWN") {
        assert.equal(await ownership.releaseCurrentOwnership(2_000), true);
      }

      const events = await inspection.runtimeOwnership.listRecentEvents(10);
      assert.equal(events.some((event) => event.eventType === "LOST"), false);
      if (scenario === "SUPERSEDED") {
        assert.equal((await inspection.runtimeOwnership.getCurrent())?.generation, 2);
      } else {
        assert.deepEqual(events.map((event) => event.eventType), ["RELEASED", "ACQUIRED"]);
      }
    } finally {
      await ownership.heartbeat.stop();
      ownership.closeOwnershipDatabase();
      inspection.close();
      await ownership.releaseProcessLock();
      await cleanupTempDatabase(databasePath);
    }
  }
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

class FakeRuntimeProcessLock implements RuntimeProcessLock {
  readonly identity = { scopeDigest: "b".repeat(64) };
  releaseCalls = 0;
  private held = true;
  private readonly listeners = new Set<(reason: RuntimeProcessLockLossReason) => void>();

  constructor(private readonly events?: string[]) {}

  isHeld(): boolean {
    return this.held;
  }

  onLost(listener: (reason: RuntimeProcessLockLossReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    this.releaseCalls += 1;
    this.events?.push("process-lock:release");
  }

  lose(reason: RuntimeProcessLockLossReason): void {
    if (!this.held) return;
    this.held = false;
    for (const listener of this.listeners) listener(reason);
  }
}

function createOwnershipContextInput(
  databasePath: string,
  processLock: RuntimeProcessLock,
) {
  return {
    executionMode: "DRY_RUN" as const,
    verifiedDatabase: {
      canonicalDatabasePath: path.resolve(databasePath),
      lockIdentity: processLock.identity,
    },
    processLock,
  };
}

function createUnexpectedRuntimeOwnershipStore(events: string[]) {
  const unexpected = (name: string): never => {
    events.push(name);
    throw new Error(`${name} must not run after owner-token failure.`);
  };
  return {
    getCurrent: async () => unexpected("ownership:get-current"),
    acquireAfterProcessLock: async () => unexpected("ownership:acquire"),
    renew: async () => unexpected("ownership:renew"),
    release: async () => unexpected("ownership:release"),
    recordLost: async () => unexpected("ownership:record-lost"),
    listRecentEvents: async () => unexpected("ownership:list-events"),
  };
}

async function createTempDatabasePath(label: string): Promise<string> {
  const directory = path.resolve(process.cwd(), ".tmp-db-tests");
  await mkdir(directory, { recursive: true });
  return path.join(
    directory,
    `runtime-startup-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
}

async function cleanupTempDatabase(databasePath: string): Promise<void> {
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
  ]);
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
