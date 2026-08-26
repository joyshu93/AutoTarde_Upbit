import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { loadAppConfig } from "../src/app/env.js";
import { RuntimeProcessLockError } from "../src/app/runtime-process-lock.js";
import { runWithScopedRuntimeOwnership } from "../src/app/scoped-runtime-ownership.js";
import { test } from "./harness.js";

test("scoped runtime ownership rejects overlap and permits reacquisition only after cleanup", async () => {
  if (process.platform !== "win32") return;

  const databasePath = await createTempDatabasePath("scoped-contention");
  const config = createDryRunConfig(databasePath);
  const releaseOwner = createDeferred<void>();
  const ownerStarted = createDeferred<number>();
  let contenderWorkCalls = 0;

  try {
    const owner = runWithScopedRuntimeOwnership(config, async (authority) => {
      authority.assertLocallyHeld();
      ownerStarted.resolve(authority.snapshot().generation ?? 0);
      await releaseOwner.promise;
      return "owner-complete";
    });
    const firstGeneration = await ownerStarted.promise;

    await assert.rejects(
      () => runWithScopedRuntimeOwnership(config, async () => {
        contenderWorkCalls += 1;
      }),
      (error) => error instanceof RuntimeProcessLockError && error.code === "RUNTIME_ALREADY_OWNED",
    );
    assert.equal(contenderWorkCalls, 0);

    releaseOwner.resolve();
    assert.equal(await owner, "owner-complete");

    const secondGeneration = await runWithScopedRuntimeOwnership(config, async (authority) => {
      authority.assertLocallyHeld();
      return authority.snapshot().generation ?? 0;
    });
    assert.ok(secondGeneration > firstGeneration);
  } finally {
    releaseOwner.resolve();
    await cleanupTempDatabase(databasePath);
  }
});

test("scoped runtime ownership preserves work failure identity and still releases its scope", async () => {
  if (process.platform !== "win32") return;

  const databasePath = await createTempDatabasePath("scoped-primary-failure");
  const config = createDryRunConfig(databasePath);
  const originalError = new Error("scoped_work_failed");

  try {
    await assert.rejects(
      () => runWithScopedRuntimeOwnership(config, async () => {
        throw originalError;
      }),
      (error) => error === originalError,
    );

    const reacquired = await runWithScopedRuntimeOwnership(config, async (authority) => {
      authority.assertLocallyHeld();
      return authority.snapshot().status;
    });
    assert.equal(reacquired, "OWNED");
  } finally {
    await cleanupTempDatabase(databasePath);
  }
});

function createDryRunConfig(databasePath: string) {
  return loadAppConfig({
    APP_EXECUTION_MODE: "DRY_RUN",
    ENABLE_LIVE_ORDERS: "false",
    DATABASE_PATH: databasePath,
    ENABLE_TELEGRAM_DELIVERY: "false",
    ENABLE_TELEGRAM_INBOUND_POLLING: "false",
    STRATEGY_SCHEDULER_ENABLED: "false",
    STRATEGY_SCHEDULER_RUN_ON_START: "false",
  });
}

async function createTempDatabasePath(label: string): Promise<string> {
  const directory = path.resolve("tmp", `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(directory, { recursive: true });
  return path.join(directory, "runtime.sqlite");
}

async function cleanupTempDatabase(databasePath: string): Promise<void> {
  await rm(path.dirname(databasePath), { recursive: true, force: true });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
