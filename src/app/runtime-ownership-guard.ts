import type {
  RuntimeOwnershipExecutionMode,
  RuntimeOwnershipRecord,
} from "../domain/runtime-ownership.js";
import type { RuntimeOwnershipStore } from "../modules/db/runtime-ownership-interfaces.js";
import { RUNTIME_OWNERSHIP_TTL_MS } from "./runtime-heartbeat.js";
import type { RuntimeProcessLock } from "./runtime-process-lock.js";

export interface RuntimeOwnershipAuthority {
  snapshot(): RuntimeOwnershipSnapshot;
  assertLocallyHeld(): void;
  assertCurrent(atEpochMs: number): Promise<RuntimeOwnershipRecord>;
}

export interface RuntimeOwnershipSnapshot {
  readonly status: "UNOWNED" | "OWNED" | "LOST";
  readonly generation: number | null;
  readonly executionMode: RuntimeOwnershipExecutionMode | null;
  readonly acquiredAtEpochMs: number | null;
  readonly heartbeatAtEpochMs: number | null;
  readonly expiresAtEpochMs: number | null;
  readonly takeover: boolean;
  readonly lossReason: string | null;
}

export interface AcquireGuardOwnershipInput {
  readonly executionMode: RuntimeOwnershipExecutionMode;
  readonly acquiredAtEpochMs: number;
}

export class RuntimeOwnershipGuardError extends Error {
  constructor(
    readonly code:
      | "RUNTIME_OWNERSHIP_NOT_HELD"
      | "RUNTIME_OWNERSHIP_LOST"
      | "RUNTIME_OWNERSHIP_REACQUISITION_FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeOwnershipGuardError";
  }
}

interface RuntimeOwnershipGuardDependencies {
  readonly processLock: RuntimeProcessLock;
  readonly store: RuntimeOwnershipStore;
  readonly ownerToken: string;
}

export class RuntimeOwnershipGuard implements RuntimeOwnershipAuthority {
  private status: RuntimeOwnershipSnapshot["status"] = "UNOWNED";
  private record: RuntimeOwnershipRecord | null = null;
  private takeover = false;
  private lossReason: string | null = null;
  private readonly lossListeners = new Set<(reason: string) => void>();

  constructor(private readonly dependencies: RuntimeOwnershipGuardDependencies) {
    dependencies.processLock.onLost(() => this.markLost("PROCESS_LOCK_LOST"));
    if (!dependencies.processLock.isHeld()) this.markLost("PROCESS_LOCK_LOST");
  }

  async acquire(input: AcquireGuardOwnershipInput): Promise<RuntimeOwnershipRecord> {
    if (this.status !== "UNOWNED") {
      throw new RuntimeOwnershipGuardError(
        "RUNTIME_OWNERSHIP_REACQUISITION_FORBIDDEN",
        "RUNTIME_OWNERSHIP_REACQUISITION_FORBIDDEN: A runtime ownership guard can acquire only once.",
      );
    }
    if (!this.dependencies.processLock.isHeld()) {
      this.markLost("PROCESS_LOCK_LOST");
      this.throwLost();
    }

    const acquisition = await this.dependencies.store.acquireAfterProcessLock({
      ownerToken: this.dependencies.ownerToken,
      executionMode: input.executionMode,
      acquiredAtEpochMs: input.acquiredAtEpochMs,
      expiresAtEpochMs: input.acquiredAtEpochMs + RUNTIME_OWNERSHIP_TTL_MS,
    });
    this.record = { ...acquisition.record };
    this.takeover = acquisition.takeover;

    if (this.snapshot().status === "LOST" || !this.dependencies.processLock.isHeld()) {
      this.markLost("PROCESS_LOCK_LOST");
      this.throwLost();
    }

    this.status = "OWNED";
    return { ...acquisition.record };
  }

  snapshot(): RuntimeOwnershipSnapshot {
    return {
      status: this.status,
      generation: this.record?.generation ?? null,
      executionMode: this.record?.executionMode ?? null,
      acquiredAtEpochMs: this.record?.acquiredAtEpochMs ?? null,
      heartbeatAtEpochMs: this.record?.heartbeatAtEpochMs ?? null,
      expiresAtEpochMs: this.record?.expiresAtEpochMs ?? null,
      takeover: this.takeover,
      lossReason: this.lossReason,
    };
  }

  assertLocallyHeld(): void {
    if (this.status === "LOST") this.throwLost();
    if (!this.dependencies.processLock.isHeld()) {
      this.markLost("PROCESS_LOCK_LOST");
      this.throwLost();
    }
    if (this.status !== "OWNED" || this.record === null) {
      throw new RuntimeOwnershipGuardError(
        "RUNTIME_OWNERSHIP_NOT_HELD",
        "RUNTIME_OWNERSHIP_NOT_HELD: Runtime ownership has not been acquired.",
      );
    }
  }

  async assertCurrent(atEpochMs: number): Promise<RuntimeOwnershipRecord> {
    validateEpochMs(atEpochMs);
    this.assertLocallyHeld();
    const expected = this.requireRecord();
    const persisted = await this.dependencies.store.getCurrent();
    this.assertLocallyHeld();

    if (!sameOwnership(expected, persisted)) {
      this.markLost("PERSISTED_OWNERSHIP_MISMATCH");
      this.throwLost();
    }
    if (atEpochMs >= persisted.expiresAtEpochMs) {
      this.markLost("OWNERSHIP_EXPIRED");
      this.throwLost();
    }

    this.record = { ...persisted };
    return { ...persisted };
  }

  markLost(reason: string): boolean {
    if (this.status === "LOST") return false;
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(reason)) {
      throw new Error("Runtime ownership loss reason must be a non-secret uppercase reason code.");
    }

    this.status = "LOST";
    this.lossReason = reason;
    for (const listener of this.lossListeners) listener(reason);
    return true;
  }

  onLost(listener: (reason: string) => void): () => void {
    this.lossListeners.add(listener);
    return () => this.lossListeners.delete(listener);
  }

  acceptRenewal(record: RuntimeOwnershipRecord): void {
    if (this.status !== "OWNED") return;
    const expected = this.requireRecord();
    if (!sameOwnership(expected, record)) {
      this.markLost("PERSISTED_OWNERSHIP_MISMATCH");
      this.throwLost();
    }
    this.record = { ...record };
  }

  private requireRecord(): RuntimeOwnershipRecord {
    if (this.record === null) {
      throw new RuntimeOwnershipGuardError(
        "RUNTIME_OWNERSHIP_NOT_HELD",
        "RUNTIME_OWNERSHIP_NOT_HELD: Runtime ownership has not been acquired.",
      );
    }
    return this.record;
  }

  private throwLost(): never {
    throw new RuntimeOwnershipGuardError(
      "RUNTIME_OWNERSHIP_LOST",
      `RUNTIME_OWNERSHIP_LOST: ${this.lossReason ?? "UNKNOWN"}`,
    );
  }
}

function sameOwnership(
  expected: RuntimeOwnershipRecord,
  persisted: RuntimeOwnershipRecord | null,
): persisted is RuntimeOwnershipRecord {
  return persisted !== null &&
    persisted.ownerToken === expected.ownerToken &&
    persisted.generation === expected.generation &&
    persisted.executionMode === expected.executionMode &&
    persisted.acquiredAtEpochMs === expected.acquiredAtEpochMs;
}

function validateEpochMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Runtime ownership assertion time must be a non-negative safe integer.");
  }
}
