import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { loadAppConfig } from "../src/app/env.js";
import { RuntimeProcessLockError } from "../src/app/runtime-process-lock.js";
import {
  runWithScopedRuntimeOwnership,
  stopScopedApplicationRuntime,
} from "../src/app/scoped-runtime-ownership.js";
import { createVerifiedApplication } from "../src/index.js";
import { runDryRunCompletionSmoke } from "../src/smoke/dryrun-completion.js";
import { runDryRunReadinessSmoke } from "../src/smoke/dryrun-readiness.js";
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

test("every writable createApp composition contends on one real scope and cleans up", async () => {
  if (process.platform !== "win32") return;

  const databasePath = await createTempDatabasePath("create-app-compositions");
  const config = createDryRunConfig(databasePath);
  const touchedEnvKeys = [
    "APP_EXECUTION_MODE",
    "ENABLE_LIVE_ORDERS",
    "ENABLE_TELEGRAM_DELIVERY",
    "ENABLE_TELEGRAM_INBOUND_POLLING",
    "STRATEGY_SCHEDULER_ENABLED",
    "STRATEGY_SCHEDULER_RUN_ON_START",
    "DATABASE_PATH",
  ] as const;
  const previousEnv = Object.fromEntries(
    touchedEnvKeys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof touchedEnvKeys)[number], string | undefined>;
  let readinessCreateCalls = 0;
  let completionCreateCalls = 0;
  let verifiedCallbackCalls = 0;

  try {
    process.env.DATABASE_PATH = databasePath;
    await runWithScopedRuntimeOwnership(config, async () => {
      await assert.rejects(
        () => runDryRunReadinessSmoke({
          loadAppConfig: () => config,
          createApplication() {
            readinessCreateCalls += 1;
            throw new Error("contended readiness must not create an application");
          },
        }),
        isRuntimeContention,
      );
      await assert.rejects(
        () => runDryRunCompletionSmoke({
          loadAppConfig: () => config,
          createApplication() {
            completionCreateCalls += 1;
            throw new Error("contended completion must not create an application");
          },
        }),
        isRuntimeContention,
      );
      await assert.rejects(
        () => createVerifiedApplication(async () => {
          verifiedCallbackCalls += 1;
          return "unreachable";
        }, { loadAppConfig: () => config }),
        isRuntimeContention,
      );
    });

    assert.equal(readinessCreateCalls, 0);
    assert.equal(completionCreateCalls, 0);
    assert.equal(verifiedCallbackCalls, 0);

    const readiness = await runDryRunReadinessSmoke({ loadAppConfig: () => config });
    const completion = await runDryRunCompletionSmoke({ loadAppConfig: () => config });
    const verifiedDatabasePath = await createVerifiedApplication(async (app) => {
      verifiedCallbackCalls += 1;
      assert.equal(app.strategyScheduler.start().started, false);
      return app.config.databasePath;
    }, { loadAppConfig: () => config });

    assert.equal(readiness.databasePath, databasePath);
    assert.equal(completion.databasePath, databasePath);
    assert.equal(verifiedDatabasePath, databasePath);
    assert.equal(verifiedCallbackCalls, 1);

    const finalGeneration = await runWithScopedRuntimeOwnership(config, async (authority) => {
      authority.assertLocallyHeld();
      return authority.snapshot().generation ?? 0;
    });
    assert.ok(finalGeneration > 0);
  } finally {
    for (const key of touchedEnvKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    await cleanupTempDatabase(databasePath);
  }
});

test("scoped application cleanup fences and quiesces delivery before database close", async () => {
  const events: string[] = [];
  const deliverySettlement = createDeferred<void>();
  const stopping = stopScopedApplicationRuntime({
    notificationDelivery: {
      stop() {
        events.push("delivery:stop");
        return { stopped: true, inFlightCount: 1, quiesced: false };
      },
      async stopAndWait() {
        events.push("delivery:quiesce");
        await deliverySettlement.promise;
        return { stopped: true, inFlightCount: 0, quiesced: true };
      },
    },
    telegramInboundPolling: {
      stop() {
        events.push("inbound:stop");
        return { running: false } as never;
      },
      async stopAndWait() {
        events.push("inbound:quiesce");
        return { running: false } as never;
      },
    },
    strategyScheduler: {
      stop() {
        events.push("scheduler:stop");
        return { markets: [] } as never;
      },
      async stopAndWait() {
        events.push("scheduler:quiesce");
        return { markets: [], quiesced: true } as never;
      },
    },
    persistence: {
      close() {
        events.push("database:close");
      },
    },
  }, (reason) => events.push(`ownership:fence:${reason}`), 1_000);

  await waitFor(() => events.includes("delivery:quiesce"));
  assert.equal(events.includes("database:close"), false);
  deliverySettlement.resolve();
  await stopping;
  assert.deepEqual(events, [
    "ownership:fence:SCOPED_WORK_COMPLETE",
    "delivery:stop",
    "inbound:stop",
    "scheduler:stop",
    "delivery:quiesce",
    "inbound:quiesce",
    "scheduler:quiesce",
    "database:close",
  ]);
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for scoped application cleanup.");
}

function isRuntimeContention(error: unknown): boolean {
  return error instanceof RuntimeProcessLockError && error.code === "RUNTIME_ALREADY_OWNED";
}
