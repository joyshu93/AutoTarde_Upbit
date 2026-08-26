import type { RuntimeOwnershipRecord } from "../domain/runtime-ownership.js";
import type { RuntimeOwnershipStore } from "../modules/db/runtime-ownership-interfaces.js";
import type { RuntimeOwnershipGuard } from "./runtime-ownership-guard.js";

export const RUNTIME_HEARTBEAT_INTERVAL_MS = 10_000;
export const RUNTIME_OWNERSHIP_TTL_MS = 45_000;
export const RUNTIME_SHUTDOWN_TIMEOUT_MS = 30_000;

export interface RuntimeHeartbeatClock {
  nowEpochMs(): number;
}

export interface RuntimeHeartbeatTimer {
  set(callback: () => void | Promise<void>, delayMs: number): unknown;
  clear(handle: unknown): void;
}

interface RuntimeHeartbeatDependencies {
  readonly guard: RuntimeOwnershipGuard;
  readonly store: RuntimeOwnershipStore;
  readonly ownerToken: string;
  readonly clock?: RuntimeHeartbeatClock;
  readonly timer?: RuntimeHeartbeatTimer;
  readonly onLoss?: (reason: string) => void | Promise<void>;
}

const systemClock: RuntimeHeartbeatClock = {
  nowEpochMs: () => Date.now(),
};

const systemTimer: RuntimeHeartbeatTimer = {
  set(callback, delayMs) {
    return setTimeout(() => {
      void callback();
    }, delayMs);
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class RuntimeHeartbeat {
  private readonly clock: RuntimeHeartbeatClock;
  private readonly timer: RuntimeHeartbeatTimer;
  private started = false;
  private stopped = false;
  private timerHandle: unknown | null = null;
  private inFlight: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private lossCallbackPromise: Promise<void> | null = null;
  private lossNotified = false;
  private unsubscribeGuardLoss: (() => void) | null = null;

  constructor(private readonly dependencies: RuntimeHeartbeatDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.timer = dependencies.timer ?? systemTimer;
  }

  start(): void {
    if (this.stopped) {
      throw new Error("Runtime heartbeat cannot restart after stop.");
    }
    if (this.started) return;

    const snapshot = this.dependencies.guard.snapshot();
    if (snapshot.status !== "OWNED") {
      throw new Error("Runtime heartbeat requires currently owned runtime authority.");
    }

    this.started = true;
    this.unsubscribeGuardLoss = this.dependencies.guard.onLost((reason) => {
      this.handleGuardLoss(reason);
    });
    this.schedule(RUNTIME_HEARTBEAT_INTERVAL_MS);
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise;

    this.stopped = true;
    this.started = false;
    this.clearScheduledTimer();
    const pendingAttempt = this.inFlight ?? Promise.resolve();
    this.stopPromise = this.finishStop(pendingAttempt);
    return this.stopPromise;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.dependencies.guard.snapshot().status !== "OWNED") return;
    this.timerHandle = this.timer.set(() => this.runScheduledAttempt(), delayMs);
  }

  private async runScheduledAttempt(): Promise<void> {
    this.timerHandle = null;
    if (this.stopped || this.dependencies.guard.snapshot().status !== "OWNED") return;

    const attempt = this.attemptRenewal();
    this.inFlight = attempt;
    try {
      await attempt;
    } finally {
      if (this.inFlight === attempt) this.inFlight = null;
    }
  }

  private async attemptRenewal(): Promise<void> {
    const lease = this.dependencies.guard.snapshot();
    if (
      lease.status !== "OWNED" ||
      lease.generation === null ||
      lease.expiresAtEpochMs === null
    ) {
      return;
    }

    const attemptedAtEpochMs = this.clock.nowEpochMs();
    if (attemptedAtEpochMs >= lease.expiresAtEpochMs) {
      this.lose("HEARTBEAT_EXPIRED");
      return;
    }

    try {
      this.dependencies.guard.assertLocallyHeld();
      const renewed = await this.dependencies.store.renew({
        ownerToken: this.dependencies.ownerToken,
        generation: lease.generation,
        heartbeatAtEpochMs: attemptedAtEpochMs,
        expiresAtEpochMs: attemptedAtEpochMs + RUNTIME_OWNERSHIP_TTL_MS,
      });

      if (this.dependencies.guard.snapshot().status !== "OWNED") return;
      if (renewed === null) {
        this.lose("HEARTBEAT_RENEWAL_MISMATCH");
        return;
      }
      if (this.clock.nowEpochMs() >= lease.expiresAtEpochMs) {
        this.lose("HEARTBEAT_EXPIRED");
        return;
      }

      this.dependencies.guard.acceptRenewal(renewed);
      this.schedule(RUNTIME_HEARTBEAT_INTERVAL_MS);
    } catch (error) {
      if (this.dependencies.guard.snapshot().status !== "OWNED") return;
      const retryAtEpochMs = this.clock.nowEpochMs();
      if (retryAtEpochMs >= lease.expiresAtEpochMs) {
        this.lose("HEARTBEAT_EXPIRED");
        return;
      }
      if (!isTransientStoreError(error)) {
        this.lose("HEARTBEAT_RENEWAL_FAILED");
        return;
      }

      this.schedule(Math.min(
        RUNTIME_HEARTBEAT_INTERVAL_MS,
        lease.expiresAtEpochMs - retryAtEpochMs,
      ));
    }
  }

  private lose(reason: string): void {
    if (this.dependencies.guard.snapshot().status === "LOST") return;
    this.dependencies.guard.markLost(reason);
  }

  private handleGuardLoss(reason: string): void {
    this.clearScheduledTimer();
    if (this.lossNotified) return;
    this.lossNotified = true;

    try {
      this.lossCallbackPromise = Promise.resolve(this.dependencies.onLoss?.(reason));
    } catch (error) {
      this.lossCallbackPromise = Promise.reject(error);
    }
    void this.lossCallbackPromise.catch(() => undefined);
  }

  private clearScheduledTimer(): void {
    if (this.timerHandle === null) return;
    this.timer.clear(this.timerHandle);
    this.timerHandle = null;
  }

  private async finishStop(pendingAttempt: Promise<void>): Promise<void> {
    try {
      await pendingAttempt;
      await (this.lossCallbackPromise ?? Promise.resolve());
    } finally {
      this.unsubscribeGuardLoss?.();
      this.unsubscribeGuardLoss = null;
    }
  }
}

function isTransientStoreError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as Error & { readonly code?: unknown; readonly errcode?: unknown };
  return sqliteError.code === "SQLITE_BUSY" ||
    sqliteError.code === "SQLITE_LOCKED" ||
    sqliteError.errcode === 5 ||
    sqliteError.errcode === 6 ||
    /\bSQLITE_(?:BUSY|LOCKED)\b/u.test(error.message);
}

export type { RuntimeOwnershipRecord };
