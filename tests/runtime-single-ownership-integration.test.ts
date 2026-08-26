import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createRuntimeShutdown,
  installRuntimeOwnershipLossHandler,
} from "../src/app/runtime-lifecycle.js";
import {
  type RuntimeOwnershipContext,
  createRuntimeOwnershipContext,
} from "../src/app/runtime-ownership-context.js";
import {
  RuntimeOwnershipGuard,
} from "../src/app/runtime-ownership-guard.js";
import {
  RuntimeHeartbeat,
  type RuntimeHeartbeatClock,
  type RuntimeHeartbeatTimer,
} from "../src/app/runtime-heartbeat.js";
import {
  RuntimeProcessLockError,
  acquireRuntimeProcessLock,
  deriveRuntimeLockIdentity,
  type RuntimeProcessLock,
  type RuntimeProcessLockLossReason,
} from "../src/app/runtime-process-lock.js";
import { createSqliteRuntimeOwnershipPersistence } from
  "../src/modules/db/repositories/sqlite-repositories.js";
import { test } from "./harness.js";

const CHILD_ARGUMENT = "--runtime-single-ownership-child";
const CHILD_CONTENTION_EXIT_CODE = 73;
const TEST_ACCOUNT_ID = "primary";

interface OperationalSideEffects {
  databaseOpens: number;
  persistedOwnershipAcquisitions: number;
  bootstrapCalls: number;
  recoveryCalls: number;
  schedulerStarts: number;
  telegramStarts: number;
  createOrderCalls: number;
  cancelOrderCalls: number;
}

interface ChildFixtureMessage {
  readonly type: "OWNED" | "CONTENDED" | "CLEANED";
  readonly code?: string;
  readonly generation?: number;
  readonly takeover?: boolean;
  readonly sideEffects: OperationalSideEffects;
}

const childMode = process.argv[2] === CHILD_ARGUMENT;

if (childMode) {
  await runChildFixture(process.argv[3], process.argv[4]);
} else {
  registerIntegrationTests();
}

function registerIntegrationTests(): void {
  test("Windows process crash permits takeover at the next persisted generation", async () => {
    if (process.platform !== "win32") return;

    const fixture = await createTempDatabase("windows-child-takeover");
    let childA: ChildProcess | null = null;
    let childB: ChildProcess | null = null;
    let childC: ChildProcess | null = null;

    try {
      childA = startChildFixture("hold", fixture.databasePath);
      const ownedA = await waitForChildMessage(childA, (message) => message.type === "OWNED");
      assert.equal(ownedA.generation, 1);
      assert.equal(ownedA.takeover, false);

      childB = startChildFixture("once", fixture.databasePath);
      const contended = await waitForChildMessage(childB, (message) => message.type === "CONTENDED");
      const childBExit = await waitForChildExit(childB);
      assert.equal(contended.code, "RUNTIME_ALREADY_OWNED");
      assert.deepEqual(contended.sideEffects, createZeroSideEffects());
      assert.equal(childBExit.code, CHILD_CONTENTION_EXIT_CODE);

      const childAExit = waitForChildExit(childA);
      assert.equal(childA.kill("SIGKILL"), true);
      const abnormalExit = await childAExit;
      assert.notEqual(abnormalExit.code, 0);

      childC = startChildFixture("once", fixture.databasePath);
      const ownedC = await waitForChildMessage(childC, (message) => message.type === "OWNED");
      assert.equal(ownedC.generation, (ownedA.generation ?? 0) + 1);
      assert.equal(ownedC.takeover, true);
      await waitForChildMessage(childC, (message) => message.type === "CLEANED");
      assert.equal((await waitForChildExit(childC)).code, 0);

      const inspection = createSqliteRuntimeOwnershipPersistence(fixture.databasePath);
      try {
        assert.equal(await inspection.runtimeOwnership.getCurrent(), null);
        const events = [...await inspection.runtimeOwnership.listRecentEvents(10)].reverse();
        assert.deepEqual(events.map((event) => event.eventType), [
          "ACQUIRED",
          "TAKEN_OVER",
          "RELEASED",
        ]);
        assert.deepEqual(events.map((event) => event.generation), [1, 2, 2]);
      } finally {
        inspection.close();
      }
    } finally {
      await terminateFixtureChild(childA);
      await terminateFixtureChild(childB);
      await terminateFixtureChild(childC);
      await fixture.cleanup();
    }
  });

  test("non-Windows production runtime lock fails closed before persistence", async () => {
    if (process.platform === "win32") return;

    await assert.rejects(
      () => acquireRuntimeProcessLock(deriveRuntimeLockIdentity({
        canonicalDatabasePath: path.resolve("tmp", "unsupported-runtime.sqlite"),
        databaseInstanceId: null,
        exchangeAccountId: TEST_ACCOUNT_ID,
      })),
      (error) => error instanceof RuntimeProcessLockError &&
        error.code === "UNSUPPORTED_RUNTIME_LOCK_PLATFORM",
    );
  });

  test("generation replacement stops workers without touching newer ownership or order senders", async () => {
    const fixture = await createTempDatabase("generation-replacement");
    const events: string[] = [];
    const runtime = await createDeterministicOwnedRuntime(fixture.databasePath, events);
    const replacement = createSqliteRuntimeOwnershipPersistence(fixture.databasePath);
    const externalCalls = { createOrder: 0, cancelOrder: 0 };

    try {
      const replacementOwnership = await replacement.runtimeOwnership.acquireAfterProcessLock({
        ownerToken: "b".repeat(64),
        executionMode: "DRY_RUN",
        acquiredAtEpochMs: 2_000,
        expiresAtEpochMs: 47_000,
      });
      assert.equal(replacementOwnership.record.generation, 2);
      assert.equal(replacementOwnership.takeover, true);

      await assert.rejects(async () => {
        await runtime.guard.assertCurrent(2_001);
        externalCalls.createOrder += 1;
      }, /RUNTIME_OWNERSHIP_LOST/u);
      const exitCode = await runtime.exitCode;

      assert.equal(exitCode, 1);
      assert.equal(externalCalls.createOrder, 0);
      assert.equal(externalCalls.cancelOrder, 0);
      assertWorkersStoppedAndLockReleasedLast(events);
      assert.equal(
        runtime.shutdownSummary()?.steps.find((step) =>
          step.name === "runtime_ownership_release"
        )?.status,
        "SKIPPED",
      );

      const current = await replacement.runtimeOwnership.getCurrent();
      assert.equal(current?.ownerToken, "b".repeat(64));
      assert.equal(current?.generation, 2);
    } finally {
      replacement.close();
      await runtime.ensureStopped();
      await fixture.cleanup();
    }
  });

  test("heartbeat expiry stops workers and leaves the expired generation for takeover", async () => {
    const fixture = await createTempDatabase("heartbeat-expiry");
    const events: string[] = [];
    const runtime = await createDeterministicOwnedRuntime(fixture.databasePath, events);
    const externalCalls = { createOrder: 0, cancelOrder: 0 };

    try {
      runtime.clock.set(46_000);
      await runtime.timer.fire();
      await assert.rejects(async () => {
        await runtime.guard.assertCurrent(runtime.clock.nowEpochMs());
        externalCalls.createOrder += 1;
      }, /RUNTIME_OWNERSHIP_LOST/u);
      const exitCode = await runtime.exitCode;

      assert.equal(exitCode, 1);
      assert.equal(runtime.guard.snapshot().lossReason, "HEARTBEAT_EXPIRED");
      assert.equal(externalCalls.createOrder, 0);
      assert.equal(externalCalls.cancelOrder, 0);
      assertWorkersStoppedAndLockReleasedLast(events);

      const inspection = createSqliteRuntimeOwnershipPersistence(fixture.databasePath);
      try {
        const current = await inspection.runtimeOwnership.getCurrent();
        assert.equal(current?.generation, 1);
        assert.equal(current?.expiresAtEpochMs, 46_000);
      } finally {
        inspection.close();
      }
    } finally {
      await runtime.ensureStopped();
      await fixture.cleanup();
    }
  });
}

async function runChildFixture(mode: string | undefined, databasePath: string | undefined): Promise<void> {
  if ((mode !== "hold" && mode !== "once") || !databasePath) {
    throw new Error("Runtime ownership child fixture requires a mode and temporary database path.");
  }

  const sideEffects = createZeroSideEffects();
  const identity = deriveRuntimeLockIdentity({
    canonicalDatabasePath: path.resolve(databasePath),
    databaseInstanceId: null,
    exchangeAccountId: TEST_ACCOUNT_ID,
  });
  let processLock: RuntimeProcessLock;

  try {
    processLock = await acquireRuntimeProcessLock(identity);
  } catch (error) {
    if (error instanceof RuntimeProcessLockError && error.code === "RUNTIME_ALREADY_OWNED") {
      process.exitCode = CHILD_CONTENTION_EXIT_CODE;
      await sendChildMessage({
        type: "CONTENDED",
        code: error.code,
        sideEffects,
      });
      process.disconnect?.();
      return;
    }
    throw error;
  }

  const ownerToken = mode === "hold" ? "a".repeat(64) : "c".repeat(64);
  const ownership = await createRuntimeOwnershipContext({
    config: { databasePath, executionMode: "DRY_RUN" },
    processLock,
  }, {
    createOwnershipPersistence(openedPath) {
      sideEffects.databaseOpens += 1;
      return createSqliteRuntimeOwnershipPersistence(openedPath);
    },
    createOwnerToken: () => ownerToken,
  });
  sideEffects.persistedOwnershipAcquisitions += 1;
  sideEffects.bootstrapCalls += 1;
  sideEffects.recoveryCalls += 1;
  sideEffects.schedulerStarts += 1;
  sideEffects.telegramStarts += 1;

  const snapshot = ownership.snapshot();
  const generation = snapshot.generation;
  if (generation === null) throw new Error("Owned child fixture has no generation.");
  await sendChildMessage({
    type: "OWNED",
    generation,
    takeover: snapshot.takeover,
    sideEffects,
  });

  if (mode === "hold") {
    await new Promise<void>(() => undefined);
    return;
  }

  ownership.fence("RUNTIME_SHUTDOWN");
  await ownership.heartbeat.stop();
  const released = await ownership.releaseCurrentOwnership(Date.now());
  assert.equal(released, true);
  ownership.closeOwnershipDatabase();
  await ownership.releaseProcessLock();
  await sendChildMessage({ type: "CLEANED", sideEffects });
  process.disconnect?.();
}

async function createDeterministicOwnedRuntime(databasePath: string, events: string[]) {
  const ownershipPersistence = createSqliteRuntimeOwnershipPersistence(databasePath);
  const processLock = new FakeProcessLock(events);
  const ownerToken = "a".repeat(64);
  const guard = new RuntimeOwnershipGuard({
    processLock,
    store: ownershipPersistence.runtimeOwnership,
    ownerToken,
  });
  await guard.acquire({ executionMode: "DRY_RUN", acquiredAtEpochMs: 1_000 });
  const clock = new ManualClock(1_001);
  const timer = new ManualHeartbeatTimer();
  const heartbeat = new RuntimeHeartbeat({
    guard,
    store: ownershipPersistence.runtimeOwnership,
    ownerToken,
    clock,
    timer,
  });
  heartbeat.start();
  await guard.assertCurrent(clock.nowEpochMs());

  let ownershipDatabaseClosed = false;
  let releasePromise: Promise<boolean> | null = null;
  const context: RuntimeOwnershipContext = {
    guard,
    heartbeat,
    snapshot: () => guard.snapshot(),
    fence(reason) {
      events.push("ownership:fence");
      guard.markLost(reason);
    },
    releaseCurrentOwnership(releasedAtEpochMs) {
      releasePromise ??= (async () => {
        await heartbeat.stop();
        const generation = guard.snapshot().generation;
        if (generation === null) return false;
        return ownershipPersistence.runtimeOwnership.release({
          ownerToken,
          generation,
          releasedAtEpochMs,
        });
      })();
      return releasePromise;
    },
    closeOwnershipDatabase() {
      if (ownershipDatabaseClosed) return;
      ownershipDatabaseClosed = true;
      events.push("ownership-db:close");
      ownershipPersistence.close();
    },
    releaseProcessLock: () => processLock.release(),
    async shutdownAfterStartupFailure() {},
  };

  const app = createFakeRuntimeApp(events);
  const shutdown = createRuntimeShutdown(app, context, {
    nowEpochMs: () => clock.nowEpochMs(),
    timeoutMs: 1_000,
  });
  let summary: Awaited<ReturnType<typeof shutdown>> | null = null;
  let resolveExit!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  installRuntimeOwnershipLossHandler({
    shutdown: async (reason) => {
      summary = await shutdown(reason);
      return summary;
    },
    ownershipLossSource: guard,
    signalTarget: {
      on() {},
      exit(code) {
        resolveExit(code ?? 0);
        return undefined as never;
      },
    },
    writeLine() {},
  });

  return {
    guard,
    clock,
    timer,
    exitCode,
    shutdownSummary: () => summary,
    async ensureStopped() {
      await shutdown("TEST_CLEANUP");
    },
  };
}

function createFakeRuntimeApp(events: string[]) {
  return {
    telegramInboundPolling: {
      stop() {
        events.push("telegram:stop");
        return createTelegramStatus(false);
      },
      async stopAndWait() {
        events.push("workers:quiesce");
        return createTelegramStatus(false);
      },
    },
    strategyScheduler: {
      stop() {
        events.push("scheduler:stop");
        return createSchedulerStatus(false);
      },
      async stopAndWait() {
        return createSchedulerStatus(false);
      },
    },
    persistence: {
      close() {
        events.push("app-db:close");
      },
    },
  };
}

function assertWorkersStoppedAndLockReleasedLast(events: string[]): void {
  assert.deepEqual(events, [
    "ownership:fence",
    "telegram:stop",
    "scheduler:stop",
    "workers:quiesce",
    "app-db:close",
    "ownership-db:close",
    "process-lock:release",
  ]);
  assert.equal(events.at(-1), "process-lock:release");
}

function createTelegramStatus(running: boolean) {
  return {
    enabled: true,
    configured: true,
    running,
    nextOffset: null,
    pollIntervalMs: 1_000,
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
    exchangeAccountId: TEST_ACCOUNT_ID,
    liveSendPath: "DRY_RUN_ADAPTER" as const,
    startupPreflight: null,
    markets: [],
  };
}

class FakeProcessLock implements RuntimeProcessLock {
  readonly identity = { scopeDigest: "f".repeat(64) };
  private held = true;
  private readonly listeners = new Set<(reason: RuntimeProcessLockLossReason) => void>();

  constructor(private readonly events: string[]) {}

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
    this.events.push("process-lock:release");
  }
}

class ManualClock implements RuntimeHeartbeatClock {
  constructor(private now: number) {}

  nowEpochMs(): number {
    return this.now;
  }

  set(value: number): void {
    this.now = value;
  }
}

class ManualHeartbeatTimer implements RuntimeHeartbeatTimer {
  private callback: (() => void | Promise<void>) | null = null;

  set(callback: () => void | Promise<void>): unknown {
    this.callback = callback;
    return callback;
  }

  clear(handle: unknown): void {
    if (this.callback === handle) this.callback = null;
  }

  async fire(): Promise<void> {
    const callback = this.callback;
    assert.ok(callback, "Expected a scheduled heartbeat callback.");
    this.callback = null;
    await callback();
  }
}

function startChildFixture(mode: "hold" | "once", databasePath: string): ChildProcess {
  return fork(fileURLToPath(import.meta.url), [CHILD_ARGUMENT, mode, databasePath], {
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
}

function waitForChildMessage(
  child: ChildProcess,
  predicate: (message: ChildFixtureMessage) => boolean,
  timeoutMs = 10_000,
): Promise<ChildFixtureMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child fixture message. stderr=${readChildStderr(child)}`));
    }, timeoutMs);
    const onMessage = (candidate: unknown): void => {
      if (!isChildFixtureMessage(candidate) || !predicate(candidate)) return;
      cleanup();
      resolve(candidate);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(
        `Child exited before expected message: code=${String(code)} signal=${String(signal)} stderr=${readChildStderr(child)}`,
      ));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function waitForChildExit(child: ChildProcess): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function terminateFixtureChild(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  const exit = waitForChildExit(child);
  child.kill("SIGKILL");
  await exit;
}

function readChildStderr(child: ChildProcess): string {
  const stderr = child.stderr;
  if (stderr === null) return "unavailable";
  return stderr.read()?.toString() ?? "";
}

function isChildFixtureMessage(value: unknown): value is ChildFixtureMessage {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { readonly type?: unknown }).type;
  return type === "OWNED" || type === "CONTENDED" || type === "CLEANED";
}

async function sendChildMessage(message: ChildFixtureMessage): Promise<void> {
  if (!process.send) throw new Error("Runtime ownership child fixture requires an IPC channel.");
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function createZeroSideEffects(): OperationalSideEffects {
  return {
    databaseOpens: 0,
    persistedOwnershipAcquisitions: 0,
    bootstrapCalls: 0,
    recoveryCalls: 0,
    schedulerStarts: 0,
    telegramStarts: 0,
    createOrderCalls: 0,
    cancelOrderCalls: 0,
  };
}

async function createTempDatabase(label: string): Promise<{
  readonly databasePath: string;
  cleanup(): Promise<void>;
}> {
  const baseDirectory = path.resolve("tmp", "runtime-single-ownership-integration");
  await mkdir(baseDirectory, { recursive: true });
  const directory = await mkdtemp(path.join(baseDirectory, `${label}-`));
  const resolvedDirectory = path.resolve(directory);
  const expectedPrefix = `${baseDirectory}${path.sep}`;
  if (!resolvedDirectory.startsWith(expectedPrefix)) {
    throw new Error("Refusing to create a runtime ownership fixture outside the test temp directory.");
  }
  return {
    databasePath: path.join(resolvedDirectory, "runtime.sqlite"),
    async cleanup() {
      if (!resolvedDirectory.startsWith(expectedPrefix)) {
        throw new Error("Refusing to remove a directory outside the test temp directory.");
      }
      await rm(resolvedDirectory, { recursive: true, force: true });
    },
  };
}
