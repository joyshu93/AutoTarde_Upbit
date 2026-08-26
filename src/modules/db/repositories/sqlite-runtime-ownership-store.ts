import type { DatabaseSync } from "node:sqlite";

import type {
  RuntimeOwnershipAcquisition,
  RuntimeOwnershipEventRecord,
  RuntimeOwnershipRecord,
} from "../../../domain/runtime-ownership.js";
import type { ExecutionMode, LiveExecutionGate, SystemStatus } from "../../../domain/types.js";
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
import { withImmediateTransaction } from "./sqlite-transaction.js";

const LEASE_SCOPE = "APPLICATION_RUNTIME";

interface RuntimeOwnershipRow {
  scope_key: string;
  owner_token: string;
  generation: number;
  execution_mode: RuntimeOwnershipRecord["executionMode"];
  acquired_at_epoch_ms: number;
  heartbeat_at_epoch_ms: number;
  expires_at_epoch_ms: number;
}

interface RuntimeOwnershipEventRow {
  id: number;
  scope_key: string;
  generation: number;
  event_type: RuntimeOwnershipEventRecord["eventType"];
  execution_mode: RuntimeOwnershipEventRecord["executionMode"];
  reason_code: string;
  event_at_epoch_ms: number;
}

interface RuntimeExecutionAuthorityRow extends RuntimeOwnershipRow {
  state_exchange_account_id: string | null;
  state_execution_mode: ExecutionMode | null;
  state_live_execution_gate: LiveExecutionGate | null;
  state_system_status: SystemStatus | null;
  state_kill_switch_active: number | null;
}

export class SqliteRuntimeOwnershipStore implements RuntimeOwnershipStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly scopeKey: string,
  ) {
    validateRuntimeOwnershipScopeKey(scopeKey);
  }

  async getCurrent(): Promise<RuntimeOwnershipRecord | null> {
    return selectCurrent(this.db, this.scopeKey);
  }

  getCurrentExecutionAuthority(
    exchangeAccountId: string,
  ): PersistedRuntimeExecutionAuthority | null {
    if (typeof exchangeAccountId !== "string" || exchangeAccountId.length === 0) {
      throw new Error("Runtime execution authority requires an exchange account id.");
    }
    const row = this.db.prepare(`
      SELECT r.scope_key, r.owner_token, r.generation, r.execution_mode,
        r.acquired_at_epoch_ms, r.heartbeat_at_epoch_ms, r.expires_at_epoch_ms,
        s.exchange_account_id AS state_exchange_account_id,
        s.execution_mode AS state_execution_mode,
        s.live_execution_gate AS state_live_execution_gate,
        s.system_status AS state_system_status,
        s.kill_switch_active AS state_kill_switch_active
      FROM runtime_ownership r
      LEFT JOIN execution_state s ON s.exchange_account_id = ?
      WHERE r.scope_key = ? AND r.lease_scope = ?
      LIMIT 1
    `).get(exchangeAccountId, this.scopeKey, LEASE_SCOPE) as RuntimeExecutionAuthorityRow | undefined;
    if (row === undefined) return null;

    const runtimeOwnership = ownershipFromRow(row);
    const exchangeAccountIdValue = row.state_exchange_account_id;
    const executionMode = row.state_execution_mode;
    const liveExecutionGate = row.state_live_execution_gate;
    const systemStatus = row.state_system_status;
    const killSwitchActive = row.state_kill_switch_active;
    const hasExecutionState = exchangeAccountIdValue !== null &&
      executionMode !== null && liveExecutionGate !== null &&
      systemStatus !== null && killSwitchActive !== null;
    if (!hasExecutionState) {
      return { runtimeOwnership, executionState: null };
    }
    if (killSwitchActive !== 0 && killSwitchActive !== 1) {
      throw new Error("Persisted runtime execution kill-switch state is invalid.");
    }
    return {
      runtimeOwnership,
      executionState: {
        exchangeAccountId: exchangeAccountIdValue,
        executionMode,
        liveExecutionGate,
        systemStatus,
        killSwitchActive: killSwitchActive === 1,
      },
    };
  }

  async acquireAfterProcessLock(
    input: AcquireRuntimeOwnershipInput,
  ): Promise<RuntimeOwnershipAcquisition> {
    validateAcquireRuntimeOwnershipInput(input);
    return withImmediateTransaction(this.db, () => {
      const current = selectCurrent(this.db, this.scopeKey);
      const maximum = selectMaximumEvent(this.db, this.scopeKey);
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
          scope_key, lease_scope, owner_token, generation, execution_mode,
          acquired_at_epoch_ms, heartbeat_at_epoch_ms, expires_at_epoch_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_key, lease_scope) DO UPDATE SET
          owner_token = excluded.owner_token,
          generation = excluded.generation,
          execution_mode = excluded.execution_mode,
          acquired_at_epoch_ms = excluded.acquired_at_epoch_ms,
          heartbeat_at_epoch_ms = excluded.heartbeat_at_epoch_ms,
          expires_at_epoch_ms = excluded.expires_at_epoch_ms
      `).run(
        this.scopeKey,
        LEASE_SCOPE,
        record.ownerToken,
        record.generation,
        record.executionMode,
        record.acquiredAtEpochMs,
        record.heartbeatAtEpochMs,
        record.expiresAtEpochMs,
      );
      appendEvent(this.db, this.scopeKey, {
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
      const current = selectCurrent(this.db, this.scopeKey);
      if (
        current === null ||
        current.ownerToken !== input.ownerToken ||
        current.generation !== input.generation
      ) {
        return null;
      }
      const maximum = selectMaximumEvent(this.db, this.scopeKey);
      assertNoTimestampRollback(
        input.heartbeatAtEpochMs,
        Math.max(current.heartbeatAtEpochMs, maximum.latestEventAtEpochMs ?? 0),
      );
      if (
        input.heartbeatAtEpochMs === current.heartbeatAtEpochMs ||
        input.heartbeatAtEpochMs >= current.expiresAtEpochMs ||
        input.expiresAtEpochMs <= current.expiresAtEpochMs
      ) {
        return null;
      }

      const update = this.db.prepare(`
        UPDATE runtime_ownership SET
          heartbeat_at_epoch_ms = ?,
          expires_at_epoch_ms = ?
        WHERE scope_key = ? AND lease_scope = ?
          AND owner_token = ?
          AND generation = ?
          AND heartbeat_at_epoch_ms = ?
          AND expires_at_epoch_ms = ?
      `).run(
        input.heartbeatAtEpochMs,
        input.expiresAtEpochMs,
        this.scopeKey,
        LEASE_SCOPE,
        input.ownerToken,
        input.generation,
        current.heartbeatAtEpochMs,
        current.expiresAtEpochMs,
      );
      if (update.changes !== 1) {
        throw new Error("Runtime ownership renewal compare-and-set changed unexpectedly.");
      }
      return selectCurrent(this.db, this.scopeKey);
    });
  }

  async release(input: ReleaseRuntimeOwnershipInput): Promise<boolean> {
    validateReleaseRuntimeOwnershipInput(input);
    return withImmediateTransaction(this.db, () => {
      const current = selectCurrent(this.db, this.scopeKey);
      if (
        current === null ||
        current.ownerToken !== input.ownerToken ||
        current.generation !== input.generation
      ) {
        return false;
      }
      const maximum = selectMaximumEvent(this.db, this.scopeKey);
      assertNoTimestampRollback(
        input.releasedAtEpochMs,
        Math.max(current.heartbeatAtEpochMs, maximum.latestEventAtEpochMs ?? 0),
      );
      if (input.releasedAtEpochMs >= current.expiresAtEpochMs) return false;

      appendEvent(this.db, this.scopeKey, {
        generation: current.generation,
        eventType: "RELEASED",
        executionMode: current.executionMode,
        reasonCode: "CLEAN_RELEASE",
        eventAtEpochMs: input.releasedAtEpochMs,
      });
      const deletion = this.db.prepare(`
        DELETE FROM runtime_ownership
        WHERE scope_key = ? AND lease_scope = ?
          AND owner_token = ? AND generation = ? AND expires_at_epoch_ms > ?
      `).run(
        this.scopeKey,
        LEASE_SCOPE,
        input.ownerToken,
        input.generation,
        input.releasedAtEpochMs,
      );
      if (deletion.changes !== 1) {
        throw new Error("Runtime ownership release compare-and-set changed unexpectedly.");
      }
      return true;
    });
  }

  async recordLost(input: RecordRuntimeOwnershipLostInput): Promise<boolean> {
    validateRecordRuntimeOwnershipLostInput(input);
    return withImmediateTransaction(this.db, () => {
      const current = selectCurrent(this.db, this.scopeKey);
      if (
        current === null ||
        current.ownerToken !== input.ownerToken ||
        current.generation !== input.generation
      ) {
        return false;
      }
      const maximum = selectMaximumEvent(this.db, this.scopeKey);
      assertNoTimestampRollback(
        input.lostAtEpochMs,
        Math.max(current.heartbeatAtEpochMs, maximum.latestEventAtEpochMs ?? 0),
      );
      appendEvent(this.db, this.scopeKey, {
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
      SELECT id, scope_key, generation, event_type, execution_mode, reason_code, event_at_epoch_ms
      FROM runtime_ownership_events
      WHERE scope_key = ? AND lease_scope = ?
      ORDER BY event_at_epoch_ms DESC, id DESC
      LIMIT ?
    `).all(this.scopeKey, LEASE_SCOPE, limit) as unknown as RuntimeOwnershipEventRow[];
    return rows.map(eventFromRow);
  }
}

function selectCurrent(db: DatabaseSync, scopeKey: string): RuntimeOwnershipRecord | null {
  const row = db.prepare(`
    SELECT scope_key, owner_token, generation, execution_mode,
      acquired_at_epoch_ms, heartbeat_at_epoch_ms, expires_at_epoch_ms
    FROM runtime_ownership
    WHERE scope_key = ? AND lease_scope = ?
  `).get(scopeKey, LEASE_SCOPE) as RuntimeOwnershipRow | undefined;
  if (row === undefined) return null;
  return ownershipFromRow(row);
}

function ownershipFromRow(row: RuntimeOwnershipRow): RuntimeOwnershipRecord {
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

function selectMaximumEvent(db: DatabaseSync, scopeKey: string): {
  generation: number | null;
  latestEventAtEpochMs: number | null;
} {
  const maximumGenerationRow = db.prepare(`
    SELECT id, scope_key, generation, event_type, execution_mode, reason_code, event_at_epoch_ms
    FROM runtime_ownership_events
    WHERE scope_key = ? AND lease_scope = ?
    ORDER BY generation DESC, id DESC
    LIMIT 1
  `).get(scopeKey, LEASE_SCOPE) as unknown as RuntimeOwnershipEventRow | undefined;
  const latestTimestampRow = db.prepare(`
    SELECT id, scope_key, generation, event_type, execution_mode, reason_code, event_at_epoch_ms
    FROM runtime_ownership_events
    WHERE scope_key = ? AND lease_scope = ?
    ORDER BY event_at_epoch_ms DESC, id DESC
    LIMIT 1
  `).get(scopeKey, LEASE_SCOPE) as unknown as RuntimeOwnershipEventRow | undefined;
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
  scopeKey: string,
  event: Omit<RuntimeOwnershipEventRecord, "id">,
): RuntimeOwnershipEventRecord {
  const result = db.prepare(`
    INSERT INTO runtime_ownership_events (
      scope_key, lease_scope, generation, event_type, execution_mode, reason_code, event_at_epoch_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    scopeKey,
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
