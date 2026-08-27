import { randomBytes } from "node:crypto";

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
import { canonicalizeLocalDatabasePath } from "../modules/db/local-database-path.js";
import type { SqliteDatabaseOpenVerification } from
  "../modules/db/repositories/sqlite-database.js";

const EXCHANGE_ACCOUNT_ID = "primary";

export interface VerifiedRuntimeDatabase {
  readonly canonicalDatabasePath: string;
  readonly lockIdentity: RuntimeLockIdentity;
  readonly databaseOpenVerification?: SqliteDatabaseOpenVerification;
}

export interface RuntimeOwnershipContext {
  readonly guard: RuntimeOwnershipAuthority;
  readonly heartbeat: RuntimeHeartbeat;
  snapshot(): RuntimeOwnershipSnapshot;
  fence(reason: string): void;
  releaseCurrentOwnership(releasedAtEpochMs: number): Promise<boolean>;
  waitForLossRecording(): Promise<void>;
  closeOwnershipDatabase(): void;
  releaseProcessLock(): Promise<void>;
  shutdownAfterStartupFailure(): Promise<void>;
}

export interface CreateRuntimeOwnershipContextInput {
  readonly executionMode: AppConfig["executionMode"];
  readonly verifiedDatabase: VerifiedRuntimeDatabase;
  readonly processLock: RuntimeProcessLock;
}

export interface RuntimeOwnershipContextDependencies {
  createOwnershipPersistence(
    databasePath: string,
    scopeKey: string,
    databaseOpenVerification?: SqliteDatabaseOpenVerification,
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
    : canonicalizeLocalDatabasePath(config.databasePath);
  return {
    canonicalDatabasePath,
    ...(verification.status === "VERIFIED"
      ? { databaseOpenVerification: verification.databaseOpenVerification }
      : {}),
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
    if (
      input.processLock.identity.scopeDigest !==
      input.verifiedDatabase.lockIdentity.scopeDigest
    ) {
      throw new Error("Runtime process lock does not match the verified database scope.");
    }
    ownershipPersistence = createOwnershipPersistence(
      input.verifiedDatabase.canonicalDatabasePath,
      input.verifiedDatabase.lockIdentity.scopeDigest,
      input.verifiedDatabase.databaseOpenVerification,
    );
    const ownerToken = createOwnerToken();
    const store = ownershipPersistence.runtimeOwnership;
    const guard = new RuntimeOwnershipGuard({
      processLock: input.processLock,
      store,
      ownerToken,
    });
    const heartbeat = new RuntimeHeartbeat({ guard, store, ownerToken });
    let lossRecordingPromise = Promise.resolve();
    guard.onLost((reason) => {
      if (!shouldRecordRuntimeOwnershipLoss(reason)) return;
      const snapshot = guard.snapshot();
      if (snapshot.generation === null) return;
      const lostAtEpochMs = Math.max(
        nowEpochMs(),
        snapshot.heartbeatAtEpochMs ?? 0,
        reason.endsWith("EXPIRED") ? snapshot.expiresAtEpochMs ?? 0 : 0,
      );
      lossRecordingPromise = lossRecordingPromise
        .then(async () => {
          await store.recordLost({
            ownerToken,
            generation: snapshot.generation!,
            lostAtEpochMs,
            reasonCode: reason,
          });
        })
        .catch(() => undefined);
    });
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
          if (!input.processLock.isHeld()) guard.markLost("PROCESS_LOCK_LOST");
          const snapshot = guard.snapshot();
          if (snapshot.generation === null) return false;
          if (snapshot.lossReason && shouldRecordRuntimeOwnershipLoss(snapshot.lossReason)) {
            return false;
          }
          const released = await store.release({
            ownerToken,
            generation: snapshot.generation,
            releasedAtEpochMs,
          });
          if (!released) guard.markLost("PERSISTED_OWNERSHIP_MISMATCH");
          return released;
        })();
        return releasePromise;
      },
      waitForLossRecording: () => lossRecordingPromise,
      closeOwnershipDatabase,
      releaseProcessLock,
      shutdownAfterStartupFailure() {
        startupFailureShutdownPromise ??= shutdownAfterStartupFailure(context!);
        return startupFailureShutdownPromise;
      },
    };

    const acquiredAtEpochMs = nowEpochMs();
    await guard.acquire({
      executionMode: input.executionMode,
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
    await context.waitForLossRecording();
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

function shouldRecordRuntimeOwnershipLoss(reason: string): boolean {
  return reason === "PROCESS_LOCK_LOST" ||
    reason === "PERSISTED_OWNERSHIP_MISMATCH" ||
    reason === "OWNERSHIP_EXPIRED" ||
    reason === "HEARTBEAT_EXPIRED" ||
    reason === "HEARTBEAT_RENEWAL_MISMATCH" ||
    reason === "HEARTBEAT_RENEWAL_FAILED" ||
    reason === "RUNTIME_WORK_QUIESCENCE_FAILED" ||
    reason === "SCOPED_WORK_QUIESCENCE_FAILED";
}
