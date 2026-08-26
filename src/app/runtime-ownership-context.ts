import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import type { AppConfig } from "./env.js";
import { RuntimeHeartbeat } from "./runtime-heartbeat.js";
import {
  RuntimeOwnershipGuard,
  type RuntimeOwnershipAuthority,
  type RuntimeOwnershipSnapshot,
} from "./runtime-ownership-guard.js";
import {
  deriveRuntimeLockIdentity,
  type RuntimeLockIdentity,
  type RuntimeProcessLock,
} from "./runtime-process-lock.js";
import { verifyLiveDatabaseIdentity } from "./live-database-identity.js";
import { createSqliteRuntimeOwnershipPersistence } from
  "../modules/db/repositories/sqlite-repositories.js";

const EXCHANGE_ACCOUNT_ID = "primary";

export interface VerifiedRuntimeDatabase {
  readonly canonicalDatabasePath: string;
  readonly lockIdentity: RuntimeLockIdentity;
}

export interface RuntimeOwnershipContext {
  readonly guard: RuntimeOwnershipAuthority;
  readonly heartbeat: RuntimeHeartbeat;
  snapshot(): RuntimeOwnershipSnapshot;
  fence(reason: string): void;
  releaseCurrentOwnership(releasedAtEpochMs: number): Promise<boolean>;
  closeOwnershipDatabase(): void;
  releaseProcessLock(): Promise<void>;
  shutdownAfterStartupFailure(): Promise<void>;
}

export interface CreateRuntimeOwnershipContextInput {
  readonly config: Pick<AppConfig, "databasePath" | "executionMode">;
  readonly processLock: RuntimeProcessLock;
}

export function verifyAndResolveRuntimeDatabase(config: AppConfig): VerifiedRuntimeDatabase {
  const verification = verifyLiveDatabaseIdentity({
    executionMode: config.executionMode,
    databasePath: config.databasePath,
    expectedDatabaseInstanceId: config.liveDatabaseInstanceId ?? null,
    exchangeAccountId: EXCHANGE_ACCOUNT_ID,
    upbitAccessKey: process.env.UPBIT_ACCESS_KEY?.trim() || null,
  });
  const canonicalDatabasePath = verification.status === "VERIFIED"
    ? verification.canonicalDatabasePath
    : resolve(config.databasePath);
  const databaseInstanceId = verification.status === "VERIFIED"
    ? verification.databaseInstanceId
    : null;

  return {
    canonicalDatabasePath,
    lockIdentity: deriveRuntimeLockIdentity({
      canonicalDatabasePath,
      databaseInstanceId,
      exchangeAccountId: EXCHANGE_ACCOUNT_ID,
    }),
  };
}

export async function createRuntimeOwnershipContext(
  input: CreateRuntimeOwnershipContextInput,
): Promise<RuntimeOwnershipContext> {
  let ownershipPersistence: ReturnType<typeof createSqliteRuntimeOwnershipPersistence>;
  try {
    ownershipPersistence = createSqliteRuntimeOwnershipPersistence(
      resolve(input.config.databasePath),
    );
  } catch (error) {
    try {
      await input.processLock.release();
    } catch {
      // Preserve the ownership-database open failure.
    }
    throw error;
  }
  const ownerToken = randomBytes(32).toString("hex");
  const store = ownershipPersistence.runtimeOwnership;
  const guard = new RuntimeOwnershipGuard({
    processLock: input.processLock,
    store,
    ownerToken,
  });
  const heartbeat = new RuntimeHeartbeat({ guard, store, ownerToken });
  let ownershipDatabaseClosed = false;
  let processLockReleased = false;
  let releasePromise: Promise<boolean> | null = null;
  let startupFailureShutdownPromise: Promise<void> | null = null;

  const context: RuntimeOwnershipContext = {
    guard,
    heartbeat,
    snapshot: () => guard.snapshot(),
    fence(reason) {
      guard.markLost(reason);
    },
    releaseCurrentOwnership(releasedAtEpochMs) {
      releasePromise ??= (async () => {
        await heartbeat.stop();
        const snapshot = guard.snapshot();
        if (snapshot.generation === null) return false;
        return store.release({
          ownerToken,
          generation: snapshot.generation,
          releasedAtEpochMs,
        });
      })();
      return releasePromise;
    },
    closeOwnershipDatabase() {
      if (ownershipDatabaseClosed) return;
      ownershipDatabaseClosed = true;
      ownershipPersistence.close();
    },
    async releaseProcessLock() {
      if (processLockReleased) return;
      processLockReleased = true;
      await input.processLock.release();
    },
    shutdownAfterStartupFailure() {
      startupFailureShutdownPromise ??= shutdownAfterStartupFailure(context);
      return startupFailureShutdownPromise;
    },
  };

  try {
    const acquiredAtEpochMs = Date.now();
    await guard.acquire({
      executionMode: input.config.executionMode,
      acquiredAtEpochMs,
    });
    heartbeat.start();
    await guard.assertCurrent(Date.now());
    return context;
  } catch (error) {
    await context.shutdownAfterStartupFailure();
    throw error;
  }
}

async function shutdownAfterStartupFailure(context: RuntimeOwnershipContext): Promise<void> {
  try {
    context.fence("STARTUP_FAILED");
  } catch {
    // Startup cleanup is best effort and must not replace the primary failure.
  }
  try {
    await context.heartbeat.stop();
  } catch {
    // Preserve the startup failure.
  }
  try {
    await context.releaseCurrentOwnership(Date.now());
  } catch {
    // Preserve the startup failure.
  }
  try {
    context.closeOwnershipDatabase();
  } catch {
    // Preserve the startup failure.
  }
  try {
    await context.releaseProcessLock();
  } catch {
    // Preserve the startup failure.
  }
}
