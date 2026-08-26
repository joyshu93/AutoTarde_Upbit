import type { AppConfig } from "./env.js";
import {
  createRuntimeOwnershipContext,
  verifyAndResolveRuntimeDatabase,
  type RuntimeOwnershipContext,
  type VerifiedRuntimeDatabase,
} from "./runtime-ownership-context.js";
import type { RuntimeOwnershipAuthority } from "./runtime-ownership-guard.js";
import {
  acquireRuntimeProcessLock,
  type RuntimeProcessLock,
} from "./runtime-process-lock.js";

export interface ScopedRuntimeOwnershipOperations {
  verifyAndResolveRuntimeDatabase(config: AppConfig): VerifiedRuntimeDatabase;
  acquireRuntimeProcessLock(identity: VerifiedRuntimeDatabase["lockIdentity"]): Promise<RuntimeProcessLock>;
  createRuntimeOwnershipContext(input: {
    readonly config: AppConfig;
    readonly processLock: RuntimeProcessLock;
  }): Promise<RuntimeOwnershipContext>;
  nowEpochMs(): number;
}

export async function runWithScopedRuntimeOwnership<T>(
  config: AppConfig,
  work: (authority: RuntimeOwnershipAuthority) => Promise<T>,
  overrides: Partial<ScopedRuntimeOwnershipOperations> = {},
): Promise<T> {
  const operations: ScopedRuntimeOwnershipOperations = {
    verifyAndResolveRuntimeDatabase,
    acquireRuntimeProcessLock,
    createRuntimeOwnershipContext,
    nowEpochMs: Date.now,
    ...overrides,
  };
  const verified = operations.verifyAndResolveRuntimeDatabase(config);
  const processLock = await operations.acquireRuntimeProcessLock(verified.lockIdentity);
  const ownership = await operations.createRuntimeOwnershipContext({ config, processLock });
  let workFailed = true;

  try {
    const result = await work(ownership.guard);
    workFailed = false;
    return result;
  } finally {
    try {
      await releaseScopedRuntimeOwnership(ownership, operations.nowEpochMs());
    } catch (error) {
      if (!workFailed) throw error;
    }
  }
}

async function releaseScopedRuntimeOwnership(
  ownership: RuntimeOwnershipContext,
  releasedAtEpochMs: number,
): Promise<void> {
  let firstFailure: unknown = null;
  const captureFailure = (error: unknown): void => {
    firstFailure ??= error;
  };

  try {
    ownership.fence("SCOPED_WORK_COMPLETE");
  } catch (error) {
    captureFailure(error);
  }
  try {
    await ownership.heartbeat.stop();
  } catch (error) {
    captureFailure(error);
  }
  try {
    const released = await ownership.releaseCurrentOwnership(releasedAtEpochMs);
    if (!released) throw new Error("Scoped runtime ownership release was not accepted.");
  } catch (error) {
    captureFailure(error);
  }
  try {
    ownership.closeOwnershipDatabase();
  } catch (error) {
    captureFailure(error);
  }
  try {
    await ownership.releaseProcessLock();
  } catch (error) {
    captureFailure(error);
  }

  if (firstFailure !== null) throw firstFailure;
}
