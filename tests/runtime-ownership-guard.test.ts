import assert from "node:assert/strict";

import {
  RuntimeOwnershipGuard,
  RuntimeOwnershipGuardError,
} from "../src/app/runtime-ownership-guard.js";
import type {
  RuntimeProcessLock,
  RuntimeProcessLockLossReason,
} from "../src/app/runtime-process-lock.js";
import { InMemoryRuntimeOwnershipStore } from
  "../src/modules/db/repositories/in-memory-runtime-ownership-store.js";
import { test } from "./harness.js";

const OWNER_A = "owner-a".padEnd(64, "x");
const OWNER_B = "owner-b".padEnd(64, "x");

test("runtime ownership guard transitions from UNOWNED to OWNED and forbids reacquisition", async () => {
  const processLock = new FakeProcessLock();
  const store = new InMemoryRuntimeOwnershipStore();
  const guard = new RuntimeOwnershipGuard({ processLock, store, ownerToken: OWNER_A });

  assert.deepEqual(guard.snapshot(), {
    status: "UNOWNED",
    generation: null,
    executionMode: null,
    acquiredAtEpochMs: null,
    heartbeatAtEpochMs: null,
    expiresAtEpochMs: null,
    takeover: false,
    lossReason: null,
  });

  const acquired = await guard.acquire({ executionMode: "LIVE", acquiredAtEpochMs: 1_000 });

  assert.equal(acquired.generation, 1);
  assert.deepEqual(guard.snapshot(), {
    status: "OWNED",
    generation: 1,
    executionMode: "LIVE",
    acquiredAtEpochMs: 1_000,
    heartbeatAtEpochMs: 1_000,
    expiresAtEpochMs: 46_000,
    takeover: false,
    lossReason: null,
  });
  guard.assertLocallyHeld();
  assert.deepEqual(await guard.assertCurrent(1_001), acquired);
  await assert.rejects(
    () => guard.acquire({ executionMode: "LIVE", acquiredAtEpochMs: 2_000 }),
    /RUNTIME_OWNERSHIP_REACQUISITION_FORBIDDEN/u,
  );

  assert.equal(guard.markLost("MANUAL_FENCE"), true);
  assert.equal(guard.markLost("LATE_FENCE"), false);
  assert.equal(guard.snapshot().status, "LOST");
  assert.equal(guard.snapshot().lossReason, "MANUAL_FENCE");
  assert.throws(() => guard.assertLocallyHeld(), /RUNTIME_OWNERSHIP_LOST/u);
  await assert.rejects(
    () => guard.acquire({ executionMode: "LIVE", acquiredAtEpochMs: 3_000 }),
    /RUNTIME_OWNERSHIP_REACQUISITION_FORBIDDEN/u,
  );
});

test("runtime ownership guard permanently fences synchronous process-lock loss", async () => {
  const processLock = new FakeProcessLock();
  const guard = new RuntimeOwnershipGuard({
    processLock,
    store: new InMemoryRuntimeOwnershipStore(),
    ownerToken: OWNER_A,
  });
  const losses: string[] = [];
  guard.onLost((reason) => losses.push(reason));
  await guard.acquire({ executionMode: "DRY_RUN", acquiredAtEpochMs: 1_000 });

  processLock.lose("LISTENER_CLOSED");
  processLock.lose("LISTENER_ERROR");

  assert.equal(guard.snapshot().status, "LOST");
  assert.equal(guard.snapshot().lossReason, "PROCESS_LOCK_LOST");
  assert.deepEqual(losses, ["PROCESS_LOCK_LOST"]);
  assert.throws(() => guard.assertLocallyHeld(), /RUNTIME_OWNERSHIP_LOST/u);
  await assert.rejects(() => guard.assertCurrent(1_001), /RUNTIME_OWNERSHIP_LOST/u);
});

test("runtime ownership guard local assertion checks the process lock even without a loss event", async () => {
  const processLock = new FakeProcessLock();
  const guard = new RuntimeOwnershipGuard({
    processLock,
    store: new InMemoryRuntimeOwnershipStore(),
    ownerToken: OWNER_A,
  });
  await guard.acquire({ executionMode: "LIVE", acquiredAtEpochMs: 1_000 });

  processLock.dropWithoutEvent();

  assert.throws(() => guard.assertLocallyHeld(), /RUNTIME_OWNERSHIP_LOST/u);
  assert.equal(guard.snapshot().status, "LOST");
  assert.equal(guard.snapshot().lossReason, "PROCESS_LOCK_LOST");
});

test("runtime ownership guard permanently fences a persisted generation mismatch", async () => {
  const store = new InMemoryRuntimeOwnershipStore();
  const guard = new RuntimeOwnershipGuard({
    processLock: new FakeProcessLock(),
    store,
    ownerToken: OWNER_A,
  });
  await guard.acquire({ executionMode: "LIVE", acquiredAtEpochMs: 1_000 });
  await store.acquireAfterProcessLock({
    ownerToken: OWNER_B,
    executionMode: "LIVE",
    acquiredAtEpochMs: 2_000,
    expiresAtEpochMs: 47_000,
  });

  await assert.rejects(
    () => guard.assertCurrent(2_001),
    (error: unknown) => error instanceof RuntimeOwnershipGuardError &&
      error.code === "RUNTIME_OWNERSHIP_LOST",
  );

  assert.equal(guard.snapshot().status, "LOST");
  assert.equal(guard.snapshot().lossReason, "PERSISTED_OWNERSHIP_MISMATCH");
  await assert.rejects(() => guard.assertCurrent(2_002), /RUNTIME_OWNERSHIP_LOST/u);
});

test("runtime ownership guard rejects expiry at the exact persisted deadline", async () => {
  const guard = new RuntimeOwnershipGuard({
    processLock: new FakeProcessLock(),
    store: new InMemoryRuntimeOwnershipStore(),
    ownerToken: OWNER_A,
  });
  await guard.acquire({ executionMode: "DRY_RUN", acquiredAtEpochMs: 1_000 });

  await assert.rejects(() => guard.assertCurrent(46_000), /RUNTIME_OWNERSHIP_LOST/u);

  assert.equal(guard.snapshot().status, "LOST");
  assert.equal(guard.snapshot().lossReason, "OWNERSHIP_EXPIRED");
});

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

  dropWithoutEvent(): void {
    this.held = false;
  }
}
