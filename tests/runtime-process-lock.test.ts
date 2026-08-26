import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  acquireRuntimeProcessLock,
  createRuntimeProcessLockForTesting,
  deriveRuntimeLockIdentity,
  RuntimeProcessLockError,
  type RuntimeProcessLockLossReason,
} from "../src/app/runtime-process-lock.js";
import { test } from "./harness.js";

const IDENTITY_INPUT = {
  canonicalDatabasePath: "C:\\runtime\\company-live.sqlite",
  databaseInstanceId: "11111111-1111-4111-8111-111111111111",
  exchangeAccountId: "primary",
} as const;

test("runtime lock identity is deterministic, domain-separated, and redacts its scope", () => {
  const identity = deriveRuntimeLockIdentity(IDENTITY_INPUT);
  const differentPath = deriveRuntimeLockIdentity({
    ...IDENTITY_INPUT,
    canonicalDatabasePath: "C:\\runtime\\other.sqlite",
  });
  const differentAccount = deriveRuntimeLockIdentity({
    ...IDENTITY_INPUT,
    exchangeAccountId: "secondary",
  });
  const differentInstance = deriveRuntimeLockIdentity({
    ...IDENTITY_INPUT,
    databaseInstanceId: null,
  });

  assert.match(identity.scopeDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(deriveRuntimeLockIdentity(IDENTITY_INPUT), identity);
  assert.notEqual(differentPath.scopeDigest, identity.scopeDigest);
  assert.notEqual(differentAccount.scopeDigest, identity.scopeDigest);
  assert.notEqual(differentInstance.scopeDigest, identity.scopeDigest);
  assert.equal(JSON.stringify(identity).includes("company-live.sqlite"), false);
  assert.equal(JSON.stringify(identity).includes("primary"), false);
});

test("runtime process lock permanently reports unexpected listener closure", async () => {
  const listener = new FakeListener();
  const lock = createRuntimeProcessLockForTesting(deriveRuntimeLockIdentity(IDENTITY_INPUT), listener);
  const losses: RuntimeProcessLockLossReason[] = [];
  const unsubscribe = lock.onLost((reason) => losses.push(reason));

  listener.emit("close");
  listener.emit("error", new Error("late listener error"));
  unsubscribe();

  assert.equal(lock.isHeld(), false);
  assert.deepEqual(losses, ["LISTENER_CLOSED"]);
  await lock.release();
  assert.equal(lock.isHeld(), false);
});

test("non-Windows runtime process lock acquisition fails closed", async () => {
  if (process.platform === "win32") return;

  await assert.rejects(
    () => acquireRuntimeProcessLock(deriveRuntimeLockIdentity(IDENTITY_INPUT)),
    (error: unknown) => error instanceof RuntimeProcessLockError && error.code === "UNSUPPORTED_RUNTIME_LOCK_PLATFORM",
  );
});

test("Windows runtime process lock excludes a contender and releases idempotently", async () => {
  if (process.platform !== "win32") return;

  const identity = deriveRuntimeLockIdentity({
    ...IDENTITY_INPUT,
    canonicalDatabasePath: `C:\\runtime\\company-live-${process.pid}-${Date.now()}.sqlite`,
  });
  const owner = await acquireRuntimeProcessLock(identity);
  try {
    assert.equal(owner.isHeld(), true);
    await assert.rejects(
      () => acquireRuntimeProcessLock(identity),
      (error: unknown) => error instanceof RuntimeProcessLockError && error.code === "RUNTIME_ALREADY_OWNED",
    );
  } finally {
    await owner.release();
    await owner.release();
  }
  assert.equal(owner.isHeld(), false);
});

class FakeListener extends EventEmitter {
  close(callback: (error?: Error) => void): this {
    callback();
    return this;
  }
}
