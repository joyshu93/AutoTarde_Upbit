import type {
  RuntimeOwnershipAcquisition,
  RuntimeOwnershipEventRecord,
  RuntimeOwnershipRecord,
} from "../../../domain/runtime-ownership.js";
import {
  assertNoTimestampRollback,
  validateAcquireRuntimeOwnershipInput,
  validateRecordRuntimeOwnershipLostInput,
  validateReleaseRuntimeOwnershipInput,
  validateRenewRuntimeOwnershipInput,
  validateRuntimeOwnershipEventLimit,
  validateRuntimeOwnershipEventRecord,
  validateRuntimeOwnershipRecord,
  validateRuntimeOwnershipScopeKey,
  type AcquireRuntimeOwnershipInput,
  type PersistedRuntimeExecutionAuthority,
  type RecordRuntimeOwnershipLostInput,
  type ReleaseRuntimeOwnershipInput,
  type RenewRuntimeOwnershipInput,
  type RuntimeOwnershipStore,
} from "../runtime-ownership-interfaces.js";

export class InMemoryRuntimeOwnershipStore implements RuntimeOwnershipStore {
  private current: RuntimeOwnershipRecord | null = null;
  private readonly events: RuntimeOwnershipEventRecord[] = [];
  private nextEventId = 1;

  constructor(private readonly scopeKey: string) {
    validateRuntimeOwnershipScopeKey(scopeKey);
  }

  async getCurrent(): Promise<RuntimeOwnershipRecord | null> {
    if (this.current === null) return null;
    validateRuntimeOwnershipRecord(this.current);
    return { ...this.current };
  }

  getCurrentExecutionAuthority(
    _exchangeAccountId: string,
  ): PersistedRuntimeExecutionAuthority | null {
    const runtimeOwnership = this.current;
    if (runtimeOwnership !== null) validateRuntimeOwnershipRecord(runtimeOwnership);
    return runtimeOwnership === null
      ? null
      : { runtimeOwnership: { ...runtimeOwnership }, executionState: null };
  }

  async acquireAfterProcessLock(
    input: AcquireRuntimeOwnershipInput,
  ): Promise<RuntimeOwnershipAcquisition> {
    validateAcquireRuntimeOwnershipInput(input);
    const current = this.current;
    if (current !== null) validateRuntimeOwnershipRecord(current);
    const chronologyFloor = Math.max(
      current?.heartbeatAtEpochMs ?? 0,
      this.maximumEventTimestamp(),
    );
    assertNoTimestampRollback(input.acquiredAtEpochMs, chronologyFloor);

    let maximumGeneration = current?.generation ?? 0;
    for (const event of this.events) {
      validateRuntimeOwnershipEventRecord(event);
      maximumGeneration = Math.max(maximumGeneration, event.generation);
    }
    if (maximumGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Runtime ownership generation overflow.");
    }

    const record: RuntimeOwnershipRecord = {
      ownerToken: input.ownerToken,
      generation: maximumGeneration + 1,
      executionMode: input.executionMode,
      acquiredAtEpochMs: input.acquiredAtEpochMs,
      heartbeatAtEpochMs: input.acquiredAtEpochMs,
      expiresAtEpochMs: input.expiresAtEpochMs,
    };
    validateRuntimeOwnershipRecord(record);
    const takeover = current !== null;
    this.current = record;
    this.appendEvent({
      generation: record.generation,
      eventType: takeover ? "TAKEN_OVER" : "ACQUIRED",
      executionMode: record.executionMode,
      reasonCode: "PROCESS_LOCK_ACQUIRED",
      eventAtEpochMs: input.acquiredAtEpochMs,
    });
    return { record: { ...record }, takeover };
  }

  async renew(input: RenewRuntimeOwnershipInput): Promise<RuntimeOwnershipRecord | null> {
    validateRenewRuntimeOwnershipInput(input);
    const current = this.current;
    if (current === null) return null;
    validateRuntimeOwnershipRecord(current);
    if (current.ownerToken !== input.ownerToken || current.generation !== input.generation) {
      return null;
    }
    assertNoTimestampRollback(
      input.heartbeatAtEpochMs,
      Math.max(current.heartbeatAtEpochMs, this.maximumEventTimestamp()),
    );
    if (
      input.heartbeatAtEpochMs === current.heartbeatAtEpochMs ||
      input.heartbeatAtEpochMs >= current.expiresAtEpochMs ||
      input.expiresAtEpochMs <= current.expiresAtEpochMs
    ) {
      return null;
    }

    const renewed: RuntimeOwnershipRecord = {
      ...current,
      heartbeatAtEpochMs: input.heartbeatAtEpochMs,
      expiresAtEpochMs: input.expiresAtEpochMs,
    };
    validateRuntimeOwnershipRecord(renewed);
    this.current = renewed;
    return { ...renewed };
  }

  async release(input: ReleaseRuntimeOwnershipInput): Promise<boolean> {
    validateReleaseRuntimeOwnershipInput(input);
    const current = this.current;
    if (current === null) return false;
    validateRuntimeOwnershipRecord(current);
    if (current.ownerToken !== input.ownerToken || current.generation !== input.generation) {
      return false;
    }
    assertNoTimestampRollback(
      input.releasedAtEpochMs,
      Math.max(current.heartbeatAtEpochMs, this.maximumEventTimestamp()),
    );
    if (input.releasedAtEpochMs >= current.expiresAtEpochMs) return false;

    this.appendEvent({
      generation: current.generation,
      eventType: "RELEASED",
      executionMode: current.executionMode,
      reasonCode: "CLEAN_RELEASE",
      eventAtEpochMs: input.releasedAtEpochMs,
    });
    this.current = null;
    return true;
  }

  async recordLost(input: RecordRuntimeOwnershipLostInput): Promise<boolean> {
    validateRecordRuntimeOwnershipLostInput(input);
    const current = this.current;
    if (current === null) return false;
    validateRuntimeOwnershipRecord(current);
    if (current.ownerToken !== input.ownerToken || current.generation !== input.generation) {
      return false;
    }
    assertNoTimestampRollback(
      input.lostAtEpochMs,
      Math.max(current.heartbeatAtEpochMs, this.maximumEventTimestamp()),
    );
    this.appendEvent({
      generation: current.generation,
      eventType: "LOST",
      executionMode: current.executionMode,
      reasonCode: input.reasonCode,
      eventAtEpochMs: input.lostAtEpochMs,
    });
    return true;
  }

  async listRecentEvents(limit: number): Promise<readonly RuntimeOwnershipEventRecord[]> {
    validateRuntimeOwnershipEventLimit(limit);
    return this.events
      .slice(-limit)
      .reverse()
      .map((event) => {
        validateRuntimeOwnershipEventRecord(event);
        return { ...event };
      });
  }

  private appendEvent(event: Omit<RuntimeOwnershipEventRecord, "id">): void {
    if (!Number.isSafeInteger(this.nextEventId)) {
      throw new Error("Runtime ownership event id overflow.");
    }
    const record: RuntimeOwnershipEventRecord = { id: this.nextEventId, ...event };
    validateRuntimeOwnershipEventRecord(record);
    this.events.push(record);
    this.nextEventId += 1;
  }

  private maximumEventTimestamp(): number {
    let maximum = 0;
    for (const event of this.events) {
      validateRuntimeOwnershipEventRecord(event);
      maximum = Math.max(maximum, event.eventAtEpochMs);
    }
    return maximum;
  }
}
