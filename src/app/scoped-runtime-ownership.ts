import type { AppConfig } from "./env.js";
import { RUNTIME_SHUTDOWN_TIMEOUT_MS } from "./runtime-heartbeat.js";
import type { RuntimeStoppableApp } from "./runtime-lifecycle.js";
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
    readonly executionMode: AppConfig["executionMode"];
    readonly verifiedDatabase: VerifiedRuntimeDatabase;
    readonly processLock: RuntimeProcessLock;
  }): Promise<RuntimeOwnershipContext>;
  nowEpochMs(): number;
}

export async function runWithScopedRuntimeOwnership<T>(
  config: AppConfig,
  work: (
    authority: RuntimeOwnershipAuthority,
    verifiedConfig: AppConfig,
    fenceApplication: (reason: string) => void,
    verifiedDatabase: VerifiedRuntimeDatabase,
  ) => Promise<T>,
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
  const verifiedConfig = { ...config, databasePath: verified.canonicalDatabasePath };
  const processLock = await operations.acquireRuntimeProcessLock(verified.lockIdentity);
  const ownership = await operations.createRuntimeOwnershipContext({
    executionMode: verifiedConfig.executionMode,
    verifiedDatabase: verified,
    processLock,
  });
  let workFailed = true;

  try {
    const result = await work(
      ownership.guard,
      verifiedConfig,
      (reason) => ownership.fence(reason),
      verified,
    );
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

export async function stopScopedApplicationRuntime(
  app: RuntimeStoppableApp,
  fenceApplication: (reason: string) => void,
  timeoutMs = RUNTIME_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const normalizedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  let firstFailure: unknown = null;
  const captureFailure = (error: unknown): void => {
    firstFailure ??= error;
  };
  let workersQuiesced = true;

  let deliveryStatus = { stopped: true, inFlightCount: 0, quiesced: true };
  let inboundStatus: ReturnType<RuntimeStoppableApp["telegramInboundPolling"]["stop"]> | null = null;
  let schedulerStatus: ReturnType<RuntimeStoppableApp["strategyScheduler"]["stop"]> | null = null;

  try {
    fenceApplication("SCOPED_WORK_COMPLETE");
  } catch (error) {
    workersQuiesced = false;
    captureFailure(error);
  }
  try {
    deliveryStatus = app.notificationDelivery?.stop() ?? deliveryStatus;
  } catch (error) {
    workersQuiesced = false;
    captureFailure(error);
  }
  try {
    inboundStatus = app.telegramInboundPolling.stop();
  } catch (error) {
    workersQuiesced = false;
    captureFailure(error);
  }
  try {
    schedulerStatus = app.strategyScheduler.stop();
  } catch (error) {
    workersQuiesced = false;
    captureFailure(error);
  }

  try {
    const stoppedInbound = inboundStatus ?? { running: false } as NonNullable<typeof inboundStatus>;
    const stoppedScheduler = schedulerStatus ?? { markets: [] } as NonNullable<typeof schedulerStatus>;
    const settlements = await waitWithTimeout(
      Promise.allSettled([
        app.notificationDelivery?.stopAndWait?.(normalizedTimeoutMs) ??
          Promise.resolve(deliveryStatus),
        app.telegramInboundPolling.stopAndWait?.(normalizedTimeoutMs) ??
          Promise.resolve(stoppedInbound),
        app.strategyScheduler.stopAndWait?.(normalizedTimeoutMs) ??
          Promise.resolve({ ...stoppedScheduler, quiesced: true }),
      ]),
      normalizedTimeoutMs,
    );

    for (const settlement of settlements) {
      if (settlement.status === "rejected") {
        workersQuiesced = false;
        captureFailure(settlement.reason);
      }
    }

    const [delivery, inbound, scheduler] = settlements;
    if (
      delivery.status === "fulfilled" &&
      inbound.status === "fulfilled" &&
      scheduler.status === "fulfilled" &&
      (
        !delivery.value.quiesced ||
        inbound.value.running ||
        scheduler.value.quiesced === false ||
        scheduler.value.markets.some((market) => market.running)
      )
    ) {
      workersQuiesced = false;
      captureFailure(new Error("Scoped runtime workers did not quiesce before database close."));
    }
  } catch (error) {
    workersQuiesced = false;
    captureFailure(error);
  }

  if (!workersQuiesced) {
    try {
      fenceApplication("SCOPED_WORK_QUIESCENCE_FAILED");
    } catch (error) {
      captureFailure(error);
    }
    throw firstFailure ?? new Error("Scoped runtime workers did not quiesce before database close.");
  }

  try {
    app.persistence.close();
  } catch (error) {
    captureFailure(error);
  }

  if (firstFailure !== null) throw firstFailure;
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
    await ownership.waitForLossRecording();
  } catch (error) {
    captureFailure(error);
  }
  const retainUnsafeScope = ownership.snapshot().lossReason ===
    "SCOPED_WORK_QUIESCENCE_FAILED";
  if (!retainUnsafeScope) {
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
  }

  if (firstFailure !== null) throw firstFailure;
}

function normalizeTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("Scoped runtime shutdown timeout must be a finite non-negative number.");
  }
  return Math.trunc(timeoutMs);
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Scoped runtime worker quiescence timed out."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
