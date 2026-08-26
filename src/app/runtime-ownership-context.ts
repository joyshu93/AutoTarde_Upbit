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

export interface RuntimeOwnershipContextDependencies {
  createOwnershipPersistence(
    databasePath: string,
  ): ReturnType<typeof createSqliteRuntimeOwnershipPersistence>;
  createOwnerToken(): string;
  nowEpochMs(): number;
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
  return {
    canonicalDatabasePath,
    lockIdentity: deriveRuntimeLockIdentity({
      canonicalDatabasePath,
      databaseInstanceId: null,
      exchangeAccountId: EXCHANGE_ACCOUNT_ID,
    }),
  };
}

export async function createRuntimeOwnershipContext(
  input: CreateRuntimeOwnershipContextInput,
  dependencies: Partial<RuntimeOwnershipContextDependencies> = {},
): Promise<RuntimeOwnershipContext> {
  const createOwnershipPersistence = dependencies.createOwnershipPersistence ??
    createSqliteRuntimeOwnershipPersistence;
  const createOwnerToken = dependencies.createOwnerToken ??
    (() => randomBytes(32).toString("hex"));
  const nowEpochMs = dependencies.nowEpochMs ?? Date.now;
  let ownershipPersistence: ReturnType<typeof createSqliteRuntimeOwnershipPersistence> | null = null;
  let ownershipDatabaseClosed = false;
  let processLockReleasePromise: Promise<void> | null = null;
  let context: RuntimeOwnershipContext | null = null;

  const closeOwnershipDatabase = (): void => {
    if (ownershipPersistence === null || ownershipDatabaseClosed) return;
    ownershipDatabaseClosed = true;
    ownershipPersistence.close();
  };
  const releaseProcessLock = (): Promise<void> => {
    processLockReleasePromise ??= input.processLock.release();
    return processLockReleasePromise;
  };

  try {
    ownershipPersistence = createOwnershipPersistence(
      resolve(input.config.databasePath),
    );
    const ownerToken = createOwnerToken();
    const store = ownershipPersistence.runtimeOwnership;
    const guard = new RuntimeOwnershipGuard({
      processLock: input.processLock,
      store,
      ownerToken,
    });
    const heartbeat = new RuntimeHeartbeat({ guard, store, ownerToken });
    let releasePromise: Promise<boolean> | null = null;
    let startupFailureShutdownPromise: Promise<void> | null = null;

    context = {
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
      closeOwnershipDatabase,
      releaseProcessLock,
      shutdownAfterStartupFailure() {
        startupFailureShutdownPromise ??= shutdownAfterStartupFailure(context!);
        return startupFailureShutdownPromise;
      },
    };

    const acquiredAtEpochMs = nowEpochMs();
    await guard.acquire({
      executionMode: input.config.executionMode,
      acquiredAtEpochMs,
    });
    heartbeat.start();
    await guard.assertCurrent(nowEpochMs());
    return context;
  } catch (error) {
    if (context !== null) {
      await context.shutdownAfterStartupFailure();
    } else {
      try {
        closeOwnershipDatabase();
      } catch {
        // Preserve the setup failure.
      }
      try {
        await releaseProcessLock();
      } catch {
        // Preserve the setup failure.
      }
    }
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
