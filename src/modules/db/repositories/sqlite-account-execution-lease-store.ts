import type { DatabaseSync } from "node:sqlite";

import type { AccountExecutionLeaseRecord } from "../../../domain/pilot-types.js";
import {
  validateLeaseWindow,
  type AccountExecutionLeaseStore,
  type AcquireAccountExecutionLeaseInput,
  type RenewAccountExecutionLeaseInput,
} from "../pilot-interfaces.js";
import { withImmediateTransaction } from "./sqlite-transaction.js";

const BLOCKING_ORDER_STATUSES = [
  "INTENT_CREATED",
  "PERSISTED",
  "SUBMITTING",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "RECONCILIATION_REQUIRED",
] as const;
const BLOCKING_ORDER_PLACEHOLDERS = BLOCKING_ORDER_STATUSES.map(() => "?").join(", ");

interface LeaseRow {
  exchange_account_id: string;
  owner_token: string;
  purpose: AccountExecutionLeaseRecord["purpose"];
  acquired_at_epoch_ms: number;
  expires_at_epoch_ms: number;
}

export class SqliteAccountExecutionLeaseStore implements AccountExecutionLeaseStore {
  constructor(private readonly db: DatabaseSync) {}

  async getLease(exchangeAccountId: string): Promise<AccountExecutionLeaseRecord | null> {
    const row = selectLease(this.db, exchangeAccountId);
    return row ? leaseFromRow(row) : null;
  }

  async acquireLease(
    input: AcquireAccountExecutionLeaseInput,
  ): Promise<AccountExecutionLeaseRecord | null> {
    validateLeaseWindow(input.ownerToken, input.acquiredAtEpochMs, input.expiresAtEpochMs);

    return withImmediateTransaction(this.db, () => {
      const current = selectLease(this.db, input.exchangeAccountId);
      if (!current) {
        this.db.prepare(`
          INSERT INTO account_execution_leases (
            exchange_account_id, owner_token, purpose, acquired_at_epoch_ms, expires_at_epoch_ms
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          input.exchangeAccountId,
          input.ownerToken,
          input.purpose,
          input.acquiredAtEpochMs,
          input.expiresAtEpochMs,
        );
        return leaseFromInput(input);
      }
      if (current.expires_at_epoch_ms > input.acquiredAtEpochMs) {
        return null;
      }
      if (hasBlockingOrder(this.db, input.exchangeAccountId)) {
        return null;
      }

      const update = this.db.prepare(`
        UPDATE account_execution_leases SET
          owner_token = ?,
          purpose = ?,
          acquired_at_epoch_ms = ?,
          expires_at_epoch_ms = ?
        WHERE exchange_account_id = ?
          AND owner_token = ?
          AND expires_at_epoch_ms <= ?
      `).run(
        input.ownerToken,
        input.purpose,
        input.acquiredAtEpochMs,
        input.expiresAtEpochMs,
        input.exchangeAccountId,
        current.owner_token,
        input.acquiredAtEpochMs,
      );
      return update.changes === 1 ? leaseFromInput(input) : null;
    });
  }

  async renewLease(
    input: RenewAccountExecutionLeaseInput,
  ): Promise<AccountExecutionLeaseRecord | null> {
    validateLeaseWindow(input.ownerToken, input.renewedAtEpochMs, input.expiresAtEpochMs);
    const update = this.db.prepare(`
      UPDATE account_execution_leases SET expires_at_epoch_ms = ?
      WHERE exchange_account_id = ?
        AND owner_token = ?
        AND expires_at_epoch_ms > ?
        AND expires_at_epoch_ms < ?
    `).run(
      input.expiresAtEpochMs,
      input.exchangeAccountId,
      input.ownerToken,
      input.renewedAtEpochMs,
      input.expiresAtEpochMs,
    );
    if (update.changes !== 1) return null;
    const renewed = selectLease(this.db, input.exchangeAccountId);
    return renewed ? leaseFromRow(renewed) : null;
  }

  async releaseLease(exchangeAccountId: string, ownerToken: string): Promise<boolean> {
    if (ownerToken.trim() === "") return false;
    const result = this.db.prepare(`
      DELETE FROM account_execution_leases
      WHERE exchange_account_id = ? AND owner_token = ?
    `).run(exchangeAccountId, ownerToken);
    return result.changes === 1;
  }
}

function selectLease(db: DatabaseSync, exchangeAccountId: string): LeaseRow | undefined {
  return db.prepare(`
    SELECT exchange_account_id, owner_token, purpose, acquired_at_epoch_ms, expires_at_epoch_ms
    FROM account_execution_leases
    WHERE exchange_account_id = ?
  `).get(exchangeAccountId) as LeaseRow | undefined;
}

function hasBlockingOrder(db: DatabaseSync, exchangeAccountId: string): boolean {
  const row = db.prepare(`
    SELECT id
    FROM orders
    WHERE exchange_account_id = ? AND status IN (${BLOCKING_ORDER_PLACEHOLDERS})
    LIMIT 1
  `).get(exchangeAccountId, ...BLOCKING_ORDER_STATUSES) as { id: string } | undefined;
  return Boolean(row);
}

function leaseFromInput(input: AcquireAccountExecutionLeaseInput): AccountExecutionLeaseRecord {
  return {
    exchangeAccountId: input.exchangeAccountId,
    ownerToken: input.ownerToken,
    purpose: input.purpose,
    acquiredAtEpochMs: input.acquiredAtEpochMs,
    expiresAtEpochMs: input.expiresAtEpochMs,
  };
}

function leaseFromRow(row: LeaseRow): AccountExecutionLeaseRecord {
  return {
    exchangeAccountId: row.exchange_account_id,
    ownerToken: row.owner_token,
    purpose: row.purpose,
    acquiredAtEpochMs: row.acquired_at_epoch_ms,
    expiresAtEpochMs: row.expires_at_epoch_ms,
  };
}
