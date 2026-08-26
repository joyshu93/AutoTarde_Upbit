import assert from "node:assert/strict";

import {
  RUNTIME_HEARTBEAT_INTERVAL_MS,
  RUNTIME_OWNERSHIP_TTL_MS,
  RUNTIME_SHUTDOWN_TIMEOUT_MS,
  RuntimeHeartbeat,
  type RuntimeHeartbeatTimer,
} from "../src/app/runtime-heartbeat.js";
import { RuntimeOwnershipGuard } from "../src/app/runtime-ownership-guard.js";
import type {
  RuntimeProcessLock,
  RuntimeProcessLockLossReason,
} from "../src/app/runtime-process-lock.js";
import type {
  AcquireRuntimeOwnershipInput,
  RecordRuntimeOwnershipLostInput,
  ReleaseRuntimeOwnershipInput,
  RenewRuntimeOwnershipInput,
  RuntimeOwnershipStore,
} from "../src/modules/db/runtime-ownership-interfaces.js";
import { InMemoryRuntimeOwnershipStore } from
  "../src/modules/db/repositories/in-memory-runtime-ownership-store.js";
import { test } from "./harness.js";

const OWNER_A = "owner-a".padEnd(64, "x");
const OWNER_B = "owner-b".padEnd(64, "x");

test("runtime heartbeat exports the fixed safety timing constants", () => {
  assert.equal(RUNTIME_HEARTBEAT_INTERVAL_MS, 10_000);
  assert.equal(RUNTIME_OWNERSHIP_TTL_MS, 45_000);
  assert.equal(RUNTIME_SHUTDOWN_TIMEOUT_MS, 30_000);
});

test("runtime heartbeat renews the exact generation every ten seconds", async () => {
  const fixture = await createHeartbeatFixture();

  fixture.heartbeat.start();
  assert.deepEqual(fixture.timer.pendingDelays(), [10_000]);

  fixture.clock.set(11_000);
  await fixture.timer.fireNext();

  assert.deepEqual(await fixture.store.getCurrent(), {
    ownerToken: OWNER_A,
    generation: 1,
    executionMode: "LIVE",
    acquiredAtEpochMs: 1_000,
    heartbeatAtEpochMs: 11_000,
    expiresAtEpochMs: 56_000,
  });
  assert.equal(fixture.guard.snapshot().heartbeatAtEpochMs, 11_000);
  assert.equal(fixture.guard.snapshot().expiresAtEpochMs, 56_000);
  assert.deepEqual(fixture.timer.pendingDelays(), [10_000]);
  assert.deepEqual(fixture.losses, []);
});

test("runtime heartbeat never renews a newer persisted generation", async () => {
  const fixture = await createHeartbeatFixture();
  fixture.heartbeat.start();
  await fixture.store.acquireAfterProcessLock({
    ownerToken: OWNER_B,
    executionMode: "LIVE",
    acquiredAtEpochMs: 2_000,
    expiresAtEpochMs: 47_000,
  });

  fixture.clock.set(11_000);
  await fixture.timer.fireNext();

  const current = await fixture.store.getCurrent();
  assert.equal(current?.ownerToken, OWNER_B);
  assert.equal(current?.generation, 2);
  assert.equal(current?.heartbeatAtEpochMs, 2_000);
  assert.equal(fixture.guard.snapshot().status, "LOST");
  assert.equal(fixture.guard.snapshot().lossReason, "HEARTBEAT_RENEWAL_MISMATCH");
  assert.deepEqual(fixture.losses, ["HEARTBEAT_RENEWAL_MISMATCH"]);
  assert.deepEqual(fixture.timer.pendingDelays(), []);
});

test("runtime heartbeat retries transient store errors only before persisted expiry", async () => {
  const baseStore = new InMemoryRuntimeOwnershipStore();
  const store = new TransientRenewalStore(baseStore, 10);
  const fixture = await createHeartbeatFixture(store);
  fixture.heartbeat.start();

  for (const now of [11_000, 21_000, 31_000, 41_000]) {
    fixture.clock.set(now);
    await fixture.timer.fireNext();
    assert.deepEqual(fixture.timer.pendingDelays(), [Math.min(10_000, 46_000 - now)]);
    assert.equal(fixture.guard.snapshot().status, "OWNED");
  }
  assert.equal(store.renewCalls, 4);

  fixture.clock.set(46_000);
  await fixture.timer.fireNext();

  assert.equal(store.renewCalls, 4);
  assert.equal(fixture.guard.snapshot().status, "LOST");
  assert.equal(fixture.guard.snapshot().lossReason, "HEARTBEAT_EXPIRED");
  assert.deepEqual(fixture.losses, ["HEARTBEAT_EXPIRED"]);
  assert.deepEqual(fixture.timer.pendingDelays(), []);
});

test("runtime heartbeat recovers from a transient error before expiry", async () => {
  const baseStore = new InMemoryRuntimeOwnershipStore();
  const store = new TransientRenewalStore(baseStore, 1);
  const fixture = await createHeartbeatFixture(store);
  fixture.heartbeat.start();

  fixture.clock.set(11_000);
  await fixture.timer.fireNext();
  fixture.clock.set(21_000);
  await fixture.timer.fireNext();

  assert.equal(store.renewCalls, 2);
  assert.equal(fixture.guard.snapshot().status, "OWNED");
  assert.equal(fixture.guard.snapshot().heartbeatAtEpochMs, 21_000);
  assert.equal(fixture.guard.snapshot().expiresAtEpochMs, 66_000);
  assert.deepEqual(fixture.timer.pendingDelays(), [10_000]);
  assert.deepEqual(fixture.losses, []);
});

test("runtime heartbeat treats a timer jump beyond expiry as one permanent loss", async () => {
  const fixture = await createHeartbeatFixture();
  fixture.heartbeat.start();

  fixture.clock.set(46_001);
  await fixture.timer.fireNext();
  fixture.processLock.lose("LISTENER_ERROR");

  assert.equal(fixture.guard.snapshot().status, "LOST");
  assert.equal(fixture.guard.snapshot().lossReason, "HEARTBEAT_EXPIRED");
  assert.deepEqual(fixture.losses, ["HEARTBEAT_EXPIRED"]);
  assert.deepEqual(fixture.timer.pendingDelays(), []);
});

test("runtime heartbeat reports process-lock loss once and stops pending renewal", async () => {
  const fixture = await createHeartbeatFixture();
  fixture.heartbeat.start();

  fixture.processLock.lose("LISTENER_CLOSED");
  fixture.processLock.lose("LISTENER_ERROR");

  assert.deepEqual(fixture.losses, ["PROCESS_LOCK_LOST"]);
  assert.deepEqual(fixture.timer.pendingDelays(), []);
});

test("runtime heartbeat stop is asynchronous and idempotently prevents future renewal", async () => {
  const fixture = await createHeartbeatFixture();
  fixture.heartbeat.start();

  const firstStop = fixture.heartbeat.stop();
  const secondStop = fixture.heartbeat.stop();
  await Promise.all([firstStop, secondStop]);

  assert.equal(fixture.timer.clearCalls, 1);
  assert.deepEqual(fixture.timer.pendingDelays(), []);
  assert.equal((await fixture.store.getCurrent())?.heartbeatAtEpochMs, 1_000);
  assert.deepEqual(fixture.losses, []);
});

test("runtime heartbeat stop observes an in-flight mismatch and awaits its loss callback", async () => {
  const store = new DeferredRenewalStore(new InMemoryRuntimeOwnershipStore());
  let releaseLossCallback: (() => void) | null = null;
  const lossCallbackGate = new Promise<void>((resolve) => {
    releaseLossCallback = resolve;
  });
  let lossCallbackStarted = false;
  const fixture = await createHeartbeatFixture(store, async () => {
    lossCallbackStarted = true;
    await lossCallbackGate;
  });
  fixture.heartbeat.start();
  fixture.clock.set(11_000);
  const timerRun = fixture.timer.fireNext();
  assert.equal(store.renewCalls, 1);

  let stopSettled = false;
  const stop = fixture.heartbeat.stop().then(() => {
    stopSettled = true;
  });
  await Promise.resolve();
  assert.equal(stopSettled, false);

  store.completeWithMismatch();
  await timerRun;
  await Promise.resolve();

  assert.equal(fixture.guard.snapshot().status, "LOST");
  assert.deepEqual(fixture.losses, ["HEARTBEAT_RENEWAL_MISMATCH"]);
  assert.equal(lossCallbackStarted, true);
  assert.equal(stopSettled, false);

  const release = releaseLossCallback as (() => void) | null;
  if (release === null) throw new Error("Expected the loss callback to start.");
  release();
  await stop;
  assert.equal(stopSettled, true);
});

interface HeartbeatFixture {
  readonly clock: ManualClock;
  readonly timer: ManualTimer;
  readonly processLock: FakeProcessLock;
  readonly store: RuntimeOwnershipStore;
  readonly guard: RuntimeOwnershipGuard;
  readonly heartbeat: RuntimeHeartbeat;
  readonly losses: string[];
}

async function createHeartbeatFixture(
  store: RuntimeOwnershipStore = new InMemoryRuntimeOwnershipStore(),
  afterLoss?: (reason: string) => void | Promise<void>,
): Promise<HeartbeatFixture> {
  const clock = new ManualClock(1_000);
  const timer = new ManualTimer();
  const processLock = new FakeProcessLock();
  const guard = new RuntimeOwnershipGuard({ processLock, store, ownerToken: OWNER_A });
  await guard.acquire({ executionMode: "LIVE", acquiredAtEpochMs: 1_000 });
  const losses: string[] = [];
  const heartbeat = new RuntimeHeartbeat({
    guard,
    store,
    ownerToken: OWNER_A,
    clock,
    timer,
    onLoss: (reason) => {
      losses.push(reason);
      return afterLoss?.(reason);
    },
  });
  return { clock, timer, processLock, store, guard, heartbeat, losses };
}

class ManualClock {
  constructor(private currentEpochMs: number) {}

  nowEpochMs(): number {
    return this.currentEpochMs;
  }

  set(epochMs: number): void {
    this.currentEpochMs = epochMs;
  }
}

class ManualTimer implements RuntimeHeartbeatTimer {
  clearCalls = 0;

  private nextId = 1;
  private readonly callbacks = new Map<number, () => void | Promise<void>>();
  private readonly delays = new Map<number, number>();

  set(callback: () => void | Promise<void>, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    this.delays.set(id, delayMs);
    return id;
  }

  clear(handle: unknown): void {
    this.clearCalls += 1;
    this.callbacks.delete(handle as number);
    this.delays.delete(handle as number);
  }

  pendingDelays(): number[] {
    return [...this.delays.values()];
  }

  async fireNext(): Promise<void> {
    const entry = this.callbacks.entries().next().value as
      | readonly [number, () => void | Promise<void>]
      | undefined;
    assert.notEqual(entry, undefined, "Expected a pending heartbeat timer.");
    const [id, callback] = entry as readonly [number, () => void | Promise<void>];
    this.callbacks.delete(id);
    this.delays.delete(id);
    await callback();
  }
}

class FakeProcessLock implements RuntimeProcessLock {
  readonly identity = { scopeDigest: "f".repeat(64) };

  private held = true;
  private readonly listeners = new Set<(reason: RuntimeProcessLockLossReason) => void>();

  isHeld(): boolean {
    return this.held;
  }

  onLost(listener: (reason: RuntimeProcessLockLossReason) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async release(): Promise<void> {
    this.held = false;
  }

  lose(reason: RuntimeProcessLockLossReason): void {
    if (!this.held) return;
    this.held = false;
    for (const listener of this.listeners) listener(reason);
  }
}

class TransientRenewalStore implements RuntimeOwnershipStore {
  renewCalls = 0;

  constructor(
    private readonly delegate: RuntimeOwnershipStore,
    private failuresRemaining: number,
  ) {}

  getCurrent() {
    return this.delegate.getCurrent();
  }

  acquireAfterProcessLock(input: AcquireRuntimeOwnershipInput) {
    return this.delegate.acquireAfterProcessLock(input);
  }

  renew(input: RenewRuntimeOwnershipInput) {
    this.renewCalls += 1;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(new Error("SQLITE_BUSY"));
    }
    return this.delegate.renew(input);
  }

  release(input: ReleaseRuntimeOwnershipInput) {
    return this.delegate.release(input);
  }

  recordLost(input: RecordRuntimeOwnershipLostInput) {
    return this.delegate.recordLost(input);
  }

  listRecentEvents(limit: number) {
    return this.delegate.listRecentEvents(limit);
  }
}

class DeferredRenewalStore implements RuntimeOwnershipStore {
  renewCalls = 0;

  private pendingRenewal: ((value: null) => void) | null = null;

  constructor(private readonly delegate: RuntimeOwnershipStore) {}

  getCurrent() {
    return this.delegate.getCurrent();
  }

  acquireAfterProcessLock(input: AcquireRuntimeOwnershipInput) {
    return this.delegate.acquireAfterProcessLock(input);
  }

  renew(_input: RenewRuntimeOwnershipInput) {
    this.renewCalls += 1;
    return new Promise<null>((resolve) => {
      this.pendingRenewal = resolve;
    });
  }

  completeWithMismatch(): void {
    const resolve = this.pendingRenewal;
    if (resolve === null) throw new Error("Expected one deferred heartbeat renewal.");
    this.pendingRenewal = null;
    resolve(null);
  }

  release(input: ReleaseRuntimeOwnershipInput) {
    return this.delegate.release(input);
  }

  recordLost(input: RecordRuntimeOwnershipLostInput) {
    return this.delegate.recordLost(input);
  }

  listRecentEvents(limit: number) {
    return this.delegate.listRecentEvents(limit);
  }
}
