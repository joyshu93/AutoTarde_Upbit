import type { DatabaseSync } from "node:sqlite";

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
  type AcquireRuntimeOwnershipInput,
  type RecordRuntimeOwnershipLostInput,
  type ReleaseRuntimeOwnershipInput,
  type RenewRuntimeOwnershipInput,
  type RuntimeOwnershipStore,
} from "../runtime-ownership-interfaces.js";
import { withImmediateTransaction } from "./sqlite-transaction.js";

const LEASE_SCOPE = "APPLICATION_RUNTIME";

interface RuntimeOwnershipRow {
  owner_token: string;
  generation: number;
  execution_mode: RuntimeOwnershipRecord["executionMode"];
  acquired_at_epoch_ms: number;
  heartbeat_at_epoch_ms: number;
  expires_at_epoch_ms: number;
}

interface RuntimeOwnershipEventRow {
  id: number;
  generation: number;
  event_type: RuntimeOwnershipEventRecord["eventType"];
  execution_mode: RuntimeOwnershipEventRecord["executionMode"];
  reason_code: string;
  event_at_epoch_ms: number;
}

export class SqliteRuntimeOwnershipStore implements RuntimeOwnershipStore {
  constructor(private readonly db: DatabaseSync) {}

  async getCurrent(): Promise<RuntimeOwnershipRecord | null> {
    return selectCurrent(this.db);
  }

  async acquireAfterProcessLock(
    input: AcquireRuntimeOwnershipInput,
  ): Promise<RuntimeOwnershipAcquisition> {
    validateAcquireRuntimeOwnershipInput(input);
    return withImmediateTransaction(this.db, () => {
      const current = selectCurrent(this.db);
      const maximum = selectMaximumEvent(this.db);
      const chronologyFloor = Math.max(
        current?.heartbeatAtEpochMs ?? 0,
        maximum.latestEventAtEpochMs ?? 0,
      );
      assertNoTimestampRollback(input.acquiredAtEpochMs, chronologyFloor);

      const maximumGeneration = Math.max(
        current?.generation ?? 0,
        maximum.generation ?? 0,
      );
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
      this.db.prepare(`
        INSERT INTO runtime_ownership (
          lease_scope, owner_token, generation, execution_mode,
          acquired_at_epoch_ms, heartbeat_at_epoch_ms, expires_at_epoch_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(lease_scope) DO UPDATE SET
          owner_token = excluded.owner_token,
          generation = excluded.generation,
          execution_mode = excluded.execution_mode,
          acquired_at_epoch_ms = excluded.acquired_at_epoch_ms,
          heartbeat_at_epoch_ms = excluded.heartbeat_at_epoch_ms,
          expires_at_epoch_ms = excluded.expires_at_epoch_ms
      `).run(
        LEASE_SCOPE,
        record.ownerToken,
        record.generation,
        record.executionMode,
        record.acquiredAtEpochMs,
        record.heartbeatAtEpochMs,
        record.expiresAtEpochMs,
      );
      appendEvent(this.db, {
        generation: record.generation,
        eventType: current === null ? "ACQUIRED" : "TAKEN_OVER",
        executionMode: record.executionMode,
        reasonCode: "PROCESS_LOCK_ACQUIRED",
        eventAtEpochMs: record.acquiredAtEpochMs,
      });
      return { record, takeover: current !== null };
    });
  }

  async renew(input: RenewRuntimeOwnershipInput): Promise<RuntimeOwnershipRecord | null> {
    validateRenewRuntimeOwnershipInput(input);
    return withImmediateTransaction(this.db, () => {
      const current = selectCurrent(this.db);
      if (
        current === null ||
        current.ownerToken !== input.ownerToken ||
        current.generation !== input.generation
      ) {
        return null;
      }
      assertNoTimestampRollback(input.heartbeatAtEpochMs, current.heartbeatAtEpochMs);
      if (
        input.heartbeatAtEpochMs >= current.expiresAtEpochMs ||
        input.expiresAtEpochMs <= current.expiresAtEpochMs
      ) {
        return null;
      }

      const update = this.db.prepare(`
        UPDATE runtime_ownership SET
          heartbeat_at_epoch_ms = ?,
          expires_at_epoch_ms = ?
        WHERE lease_scope = ?
          AND owner_token = ?
          AND generation = ?
          AND heartbeat_at_epoch_ms = ?
          AND expires_at_epoch_ms = ?
      `).run(
        input.heartbeatAtEpochMs,
        input.expiresAtEpochMs,
        LEASE_SCOPE,
        input.ownerToken,
        input.generation,
        current.heartbeatAtEpochMs,
        current.expiresAtEpochMs,
      );
      if (update.changes !== 1) {
        throw new Error("Runtime ownership renewal compare-and-set changed unexpectedly.");
      }
      return selectCurrent(this.db);
    });
  }

  async release(input: ReleaseRuntimeOwnershipInput): Promise<boolean> {
    validateReleaseRuntimeOwnershipInput(input);
    return withImmediateTransaction(this.db, () => {
      const current = selectCurrent(this.db);
      if (
        current === null ||
        current.ownerToken !== input.ownerToken ||
        current.generation !== input.generation
      ) {
        return false;
      }
      const maximum = selectMaximumEvent(this.db);
      assertNoTimestampRollback(
        input.releasedAtEpochMs,
        Math.max(current.heartbeatAtEpochMs, maximum.latestEventAtEpochMs ?? 0),
      );
      if (input.releasedAtEpochMs >= current.expiresAtEpochMs) return false;

      appendEvent(this.db, {
        generation: current.generation,
        eventType: "RELEASED",
        executionMode: current.executionMode,
        reasonCode: "CLEAN_RELEASE",
        eventAtEpochMs: input.releasedAtEpochMs,
      });
      const deletion = this.db.prepare(`
        DELETE FROM runtime_ownership
        WHERE lease_scope = ? AND owner_token = ? AND generation = ? AND expires_at_epoch_ms > ?
      `).run(LEASE_SCOPE, input.ownerToken, input.generation, input.releasedAtEpochMs);
      if (deletion.changes !== 1) {
        throw new Error("Runtime ownership release compare-and-set changed unexpectedly.");
      }
      return true;
    });
  }

  async recordLost(input: RecordRuntimeOwnershipLostInput): Promise<boolean> {
    validateRecordRuntimeOwnershipLostInput(input);
    return withImmediateTransaction(this.db, () => {
      const current = selectCurrent(this.db);
      if (
        current === null ||
        current.ownerToken !== input.ownerToken ||
        current.generation !== input.generation
      ) {
        return false;
      }
      const maximum = selectMaximumEvent(this.db);
      assertNoTimestampRollback(
        input.lostAtEpochMs,
        Math.max(current.heartbeatAtEpochMs, maximum.latestEventAtEpochMs ?? 0),
      );
      appendEvent(this.db, {
        generation: current.generation,
        eventType: "LOST",
        executionMode: current.executionMode,
        reasonCode: input.reasonCode,
        eventAtEpochMs: input.lostAtEpochMs,
      });
      return true;
    });
  }

  async listRecentEvents(limit: number): Promise<readonly RuntimeOwnershipEventRecord[]> {
    validateRuntimeOwnershipEventLimit(limit);
    const rows = this.db.prepare(`
      SELECT id, generation, event_type, execution_mode, reason_code, event_at_epoch_ms
      FROM runtime_ownership_events
      WHERE lease_scope = ?
      ORDER BY event_at_epoch_ms DESC, id DESC
      LIMIT ?
    `).all(LEASE_SCOPE, limit) as unknown as RuntimeOwnershipEventRow[];
    return rows.map(eventFromRow);
  }
}

function selectCurrent(db: DatabaseSync): RuntimeOwnershipRecord | null {
  const row = db.prepare(`
    SELECT owner_token, generation, execution_mode,
      acquired_at_epoch_ms, heartbeat_at_epoch_ms, expires_at_epoch_ms
    FROM runtime_ownership
    WHERE lease_scope = ?
  `).get(LEASE_SCOPE) as RuntimeOwnershipRow | undefined;
  if (row === undefined) return null;
  const record: RuntimeOwnershipRecord = {
    ownerToken: row.owner_token,
    generation: row.generation,
    executionMode: row.execution_mode,
    acquiredAtEpochMs: row.acquired_at_epoch_ms,
    heartbeatAtEpochMs: row.heartbeat_at_epoch_ms,
    expiresAtEpochMs: row.expires_at_epoch_ms,
  };
  validateRuntimeOwnershipRecord(record);
  return record;
}

function selectMaximumEvent(db: DatabaseSync): {
  generation: number | null;
  latestEventAtEpochMs: number | null;
} {
  const maximumGenerationRow = db.prepare(`
    SELECT id, generation, event_type, execution_mode, reason_code, event_at_epoch_ms
    FROM runtime_ownership_events
    WHERE lease_scope = ?
    ORDER BY generation DESC, id DESC
    LIMIT 1
  `).get(LEASE_SCOPE) as unknown as RuntimeOwnershipEventRow | undefined;
  const latestTimestampRow = db.prepare(`
    SELECT id, generation, event_type, execution_mode, reason_code, event_at_epoch_ms
    FROM runtime_ownership_events
    WHERE lease_scope = ?
    ORDER BY event_at_epoch_ms DESC, id DESC
    LIMIT 1
  `).get(LEASE_SCOPE) as unknown as RuntimeOwnershipEventRow | undefined;
  const maximumGenerationEvent = maximumGenerationRow === undefined
    ? null
    : eventFromRow(maximumGenerationRow);
  const latestTimestampEvent = latestTimestampRow === undefined
    ? null
    : eventFromRow(latestTimestampRow);
  return {
    generation: maximumGenerationEvent?.generation ?? null,
    latestEventAtEpochMs: latestTimestampEvent?.eventAtEpochMs ?? null,
  };
}

function appendEvent(
  db: DatabaseSync,
  event: Omit<RuntimeOwnershipEventRecord, "id">,
): RuntimeOwnershipEventRecord {
  const result = db.prepare(`
    INSERT INTO runtime_ownership_events (
      lease_scope, generation, event_type, execution_mode, reason_code, event_at_epoch_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    LEASE_SCOPE,
    event.generation,
    event.eventType,
    event.executionMode,
    event.reasonCode,
    event.eventAtEpochMs,
  );
  const id = Number(result.lastInsertRowid);
  const record: RuntimeOwnershipEventRecord = { id, ...event };
  validateRuntimeOwnershipEventRecord(record);
  return record;
}

function eventFromRow(row: RuntimeOwnershipEventRow): RuntimeOwnershipEventRecord {
  const event: RuntimeOwnershipEventRecord = {
    id: row.id,
    generation: row.generation,
    eventType: row.event_type,
    executionMode: row.execution_mode,
    reasonCode: row.reason_code,
    eventAtEpochMs: row.event_at_epoch_ms,
  };
  validateRuntimeOwnershipEventRecord(event);
  return event;
}
