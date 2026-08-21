import type { AccountExecutionLeaseRecord } from "../../../domain/pilot-types.js";
import {
  validateLeaseWindow,
  type AccountExecutionLeaseStore,
  type AcquireAccountExecutionLeaseInput,
  type RenewAccountExecutionLeaseInput,
} from "../pilot-interfaces.js";

export class InMemoryAccountExecutionLeaseStore implements AccountExecutionLeaseStore {
  private readonly leases = new Map<string, AccountExecutionLeaseRecord>();

  constructor(
    private readonly hasBlockingOrder: (exchangeAccountId: string) => boolean = () => false,
  ) {}

  async getLease(exchangeAccountId: string): Promise<AccountExecutionLeaseRecord | null> {
    const lease = this.leases.get(exchangeAccountId);
    return lease ? { ...lease } : null;
  }

  async acquireLease(
    input: AcquireAccountExecutionLeaseInput,
  ): Promise<AccountExecutionLeaseRecord | null> {
    validateLeaseWindow(input.ownerToken, input.acquiredAtEpochMs, input.expiresAtEpochMs);
    const current = this.leases.get(input.exchangeAccountId);
    if (current && current.expiresAtEpochMs > input.acquiredAtEpochMs) {
      return null;
    }
    if (current && this.hasBlockingOrder(input.exchangeAccountId)) {
      return null;
    }
    const lease: AccountExecutionLeaseRecord = {
      exchangeAccountId: input.exchangeAccountId,
      ownerToken: input.ownerToken,
      purpose: input.purpose,
      acquiredAtEpochMs: input.acquiredAtEpochMs,
      expiresAtEpochMs: input.expiresAtEpochMs,
    };
    this.leases.set(input.exchangeAccountId, lease);
    return { ...lease };
  }

  async renewLease(
    input: RenewAccountExecutionLeaseInput,
  ): Promise<AccountExecutionLeaseRecord | null> {
    validateLeaseWindow(input.ownerToken, input.renewedAtEpochMs, input.expiresAtEpochMs);
    const current = this.leases.get(input.exchangeAccountId);
    if (
      !current ||
      current.ownerToken !== input.ownerToken ||
      current.expiresAtEpochMs <= input.renewedAtEpochMs ||
      current.expiresAtEpochMs >= input.expiresAtEpochMs
    ) {
      return null;
    }
    const renewed = { ...current, expiresAtEpochMs: input.expiresAtEpochMs };
    this.leases.set(input.exchangeAccountId, renewed);
    return { ...renewed };
  }

  async releaseLease(exchangeAccountId: string, ownerToken: string): Promise<boolean> {
    const current = this.leases.get(exchangeAccountId);
    if (!current || current.ownerToken !== ownerToken) return false;
    return this.leases.delete(exchangeAccountId);
  }
}
