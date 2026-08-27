import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  provisionLiveDatabaseIdentity,
  verifyLiveDatabaseIdentity,
} from "../src/app/live-database-identity.js";
import {
  acquireRuntimeProcessLock,
  deriveRuntimeLockIdentity,
  RuntimeProcessLockError,
  type RuntimeProcessLock,
} from "../src/app/runtime-process-lock.js";
import {
  RuntimeDuplicateOwnerProbeError,
  runRuntimeDuplicateOwnerProbe,
  terminateRuntimeDuplicateOwnerProbeCliFailure,
  type RuntimeDuplicateOwnerProbeDependencies,
} from "../src/operations/runtime-duplicate-owner-probe.js";
import { createSqlitePersistence } from "../src/modules/db/repositories/sqlite-repositories.js";
import { test } from "./harness.js";

const CONFIRMATION = "I_UNDERSTAND_THIS_ONLY_PROBES_RUNTIME_OWNERSHIP";
const INSTANCE_ID = "00000000-0000-4000-8000-000000000025";
const ACCESS_KEY = "synthetic-probe-access-key";

test("duplicate-owner probe rejects missing confirmation before identity or lock work", async () => {
  let verifyCalls = 0;
  const dependencies = createDependencies({
    verifyLiveDatabaseIdentity() {
      verifyCalls += 1;
      return createVerifiedIdentity();
    },
  });

  await assert.rejects(
    () => runRuntimeDuplicateOwnerProbe(createProbeEnv({
      LIVE_DUPLICATE_OWNER_PROBE_CONFIRMATION: undefined,
    }), dependencies),
    (error) => error instanceof RuntimeDuplicateOwnerProbeError &&
      error.code === "CONFIRMATION_REQUIRED",
  );
  assert.equal(verifyCalls, 0);
});

test("duplicate-owner probe reports PASS only when the production process lock rejects contention", async () => {
  const result = await runRuntimeDuplicateOwnerProbe(createProbeEnv(), createDependencies({
    async acquireRuntimeProcessLock() {
      throw new RuntimeProcessLockError(
        "RUNTIME_ALREADY_OWNED",
        "Another runtime already owns this scope.",
      );
    },
  }));

  assert.deepEqual(result, {
    service: "AutoTrade_Upbit",
    status: "PASS",
    outcome: "DUPLICATE_BLOCKED",
    databaseIdentityVerified: true,
    processLockContended: true,
    processLockAcquired: false,
    processLockReleased: false,
    nonMutationBoundary: {
      databaseWrites: false,
      migrations: false,
      bootstrap: false,
      applicationConstruction: false,
      apiCalls: false,
      workerStarts: false,
      orderTransmission: false,
    },
  });
  const rendered = JSON.stringify(result);
  assert.equal(rendered.includes("synthetic-probe-access-key"), false);
  assert.equal(rendered.includes("synthetic\\live.sqlite"), false);
  assert.equal(rendered.includes("1".repeat(64)), false);
});

test("duplicate-owner probe releases an unexpectedly acquired lock and reports BLOCK", async () => {
  const lock = new FakeProcessLock();
  const result = await runRuntimeDuplicateOwnerProbe(createProbeEnv(), createDependencies({
    async acquireRuntimeProcessLock() {
      return lock;
    },
  }));

  assert.equal(result.status, "BLOCK");
  assert.equal(result.outcome, "NO_ACTIVE_OWNER");
  assert.equal(result.processLockAcquired, true);
  assert.equal(result.processLockReleased, true);
  assert.equal(lock.releaseCalls, 1);
  assert.equal(lock.isHeld(), false);
});

test("duplicate-owner probe fails explicitly when an unexpectedly acquired lock cannot be released", async () => {
  const lock = new FakeProcessLock(new Error("synthetic release failure"));
  await assert.rejects(
    () => runRuntimeDuplicateOwnerProbe(createProbeEnv(), createDependencies({
      async acquireRuntimeProcessLock() {
        return lock;
      },
    })),
    (error) => error instanceof RuntimeDuplicateOwnerProbeError &&
      error.code === "LOCK_RELEASE_FAILED" &&
      !error.message.includes("synthetic\\live.sqlite") &&
      !error.message.includes(ACCESS_KEY),
  );
  assert.equal(lock.releaseCalls, 1);
});

test("duplicate-owner probe CLI renders release failure safely and forces terminal process cleanup", async () => {
  const lock = new FakeProcessLock(new Error(`release failed for ${ACCESS_KEY} at C:\\synthetic\\live.sqlite`));
  let releaseFailure: unknown;
  try {
    await runRuntimeDuplicateOwnerProbe(createProbeEnv(), createDependencies({
      async acquireRuntimeProcessLock() {
        return lock;
      },
    }));
  } catch (error) {
    releaseFailure = error;
  }

  const terminalExit = new Error("synthetic terminal exit");
  let rendered = "";
  let exitCode: number | null = null;
  assert.throws(
    () => terminateRuntimeDuplicateOwnerProbeCliFailure(releaseFailure, {
      writeStderr(output) {
        rendered += output;
      },
      terminateProcess(code): never {
        exitCode = code;
        throw terminalExit;
      },
    }),
    (error) => error === terminalExit,
  );
  assert.equal(exitCode, 1);
  assert.match(rendered, /"code": "LOCK_RELEASE_FAILED"/u);
  assert.equal(rendered.includes(ACCESS_KEY), false);
  assert.equal(rendered.includes("synthetic\\live.sqlite"), false);

  exitCode = null;
  assert.throws(
    () => terminateRuntimeDuplicateOwnerProbeCliFailure(releaseFailure, {
      writeStderr() {
        throw new Error("synthetic stderr failure");
      },
      terminateProcess(code): never {
        exitCode = code;
        throw terminalExit;
      },
    }),
    (error) => error === terminalExit,
  );
  assert.equal(exitCode, 1);
});

test("Windows duplicate-owner probe uses the real read-only identity and named-pipe lock without database mutation", async () => {
  if (process.platform !== "win32") return;

  const directory = await mkdtemp(join(tmpdir(), "autotrade-runtime-duplicate-probe-"));
  const databasePath = join(directory, "synthetic-live.sqlite");
  let heldLock: RuntimeProcessLock | null = null;
  try {
    const persistence = createSqlitePersistence({
      databasePath,
      exchangeAccountId: "primary",
      userId: "synthetic-probe-operator",
      userTelegramId: "synthetic-probe-telegram-user",
      userDisplayName: "Synthetic Probe Operator",
      accessKeyRef: "SYNTHETIC_ONLY",
      secretKeyRef: "SYNTHETIC_ONLY",
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      killSwitchActive: false,
    });
    persistence.close();
    provisionLiveDatabaseIdentity({
      databasePath,
      databaseInstanceId: INSTANCE_ID,
      exchangeAccountId: "primary",
      upbitAccessKey: ACCESS_KEY,
    });
    const verification = verifyLiveDatabaseIdentity({
      executionMode: "LIVE",
      databasePath,
      expectedDatabaseInstanceId: INSTANCE_ID,
      exchangeAccountId: "primary",
      upbitAccessKey: ACCESS_KEY,
    });
    assert.equal(verification.status, "VERIFIED");
    const lockIdentity = deriveRuntimeLockIdentity({
      canonicalDatabasePath: verification.canonicalDatabasePath,
      databaseInstanceId: null,
      exchangeAccountId: "primary",
    });
    heldLock = await acquireRuntimeProcessLock(lockIdentity);

    const env = createProbeEnv({ DATABASE_PATH: databasePath });
    const beforeContention = await databaseSha256(databasePath);
    const contended = await runRuntimeDuplicateOwnerProbe(env);
    assert.equal(contended.status, "PASS");
    assert.equal(contended.outcome, "DUPLICATE_BLOCKED");
    assert.equal(await databaseSha256(databasePath), beforeContention);

    await heldLock.release();
    heldLock = null;
    const beforeUnowned = await databaseSha256(databasePath);
    const unowned = await runRuntimeDuplicateOwnerProbe(env);
    assert.equal(unowned.status, "BLOCK");
    assert.equal(unowned.outcome, "NO_ACTIVE_OWNER");
    assert.equal(await databaseSha256(databasePath), beforeUnowned);
  } finally {
    if (heldLock?.isHeld()) await heldLock.release();
    await rm(directory, { recursive: true, force: true });
  }
});

function createProbeEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    APP_EXECUTION_MODE: "LIVE",
    DATABASE_PATH: "C:\\synthetic\\live.sqlite",
    LIVE_DATABASE_INSTANCE_ID: INSTANCE_ID,
    UPBIT_ACCESS_KEY: ACCESS_KEY,
    LIVE_DUPLICATE_OWNER_PROBE_CONFIRMATION: CONFIRMATION,
    ...overrides,
  };
}

function createVerifiedIdentity() {
  return {
    status: "VERIFIED" as const,
    canonicalDatabasePath: "C:\\synthetic\\live.sqlite",
    databaseInstanceId: INSTANCE_ID,
    exchangeAccountId: "primary",
    databaseOpenVerification: {
      assertBeforeOpen() {},
      assertOpenedDatabase() {},
    },
  };
}

function createDependencies(
  overrides: Partial<RuntimeDuplicateOwnerProbeDependencies> = {},
): RuntimeDuplicateOwnerProbeDependencies {
  return {
    verifyLiveDatabaseIdentity: createVerifiedIdentity,
    deriveRuntimeLockIdentity() {
      return { scopeDigest: "1".repeat(64) };
    },
    async acquireRuntimeProcessLock() {
      throw new Error("probe test must select a lock outcome");
    },
    ...overrides,
  };
}

class FakeProcessLock implements RuntimeProcessLock {
  readonly identity = { scopeDigest: "1".repeat(64) };
  releaseCalls = 0;
  private held = true;

  constructor(private readonly releaseError: Error | null = null) {}

  isHeld(): boolean {
    return this.held;
  }

  onLost(): () => void {
    return () => undefined;
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
    if (this.releaseError !== null) throw this.releaseError;
    this.held = false;
  }
}

async function databaseSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
