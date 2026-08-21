import assert from "node:assert/strict";

import type { AccountExecutionLeaseStore } from "../src/modules/db/pilot-interfaces.js";
import { InMemoryAccountExecutionLeaseStore } from
  "../src/modules/db/repositories/in-memory-account-execution-lease-store.js";
import { test } from "./harness.js";

export interface LeaseContractFixture {
  store: AccountExecutionLeaseStore;
  setBlockingOrder(active: boolean): void | Promise<void>;
}

export type LeaseContractFactory = () => LeaseContractFixture | Promise<LeaseContractFixture>;

export async function verifyAccountExecutionLeaseContract(
  create: LeaseContractFactory,
): Promise<void> {
  const fixture = await create();
  const first = await fixture.store.acquireLease({
    exchangeAccountId: "primary",
    ownerToken: "owner-one",
    purpose: "ORDER_SUBMISSION",
    acquiredAtEpochMs: 1_000,
    expiresAtEpochMs: 2_000,
  });
  const contender = await fixture.store.acquireLease({
    exchangeAccountId: "primary",
    ownerToken: "owner-two",
    purpose: "ORDER_SUBMISSION",
    acquiredAtEpochMs: 1_000,
    expiresAtEpochMs: 2_000,
  });

  assert.equal(first?.ownerToken, "owner-one");
  assert.equal(contender, null);
  assert.equal(await fixture.store.renewLease({
    exchangeAccountId: "primary",
    ownerToken: "stale-owner",
    renewedAtEpochMs: 1_500,
    expiresAtEpochMs: 2_500,
  }), null);
  assert.equal((await fixture.store.renewLease({
    exchangeAccountId: "primary",
    ownerToken: "owner-one",
    renewedAtEpochMs: 1_500,
    expiresAtEpochMs: 2_500,
  }))?.expiresAtEpochMs, 2_500);
  assert.equal(await fixture.store.renewLease({
    exchangeAccountId: "primary",
    ownerToken: "owner-one",
    renewedAtEpochMs: 1_600,
    expiresAtEpochMs: 2_400,
  }), null);
  assert.equal((await fixture.store.getLease("primary"))?.expiresAtEpochMs, 2_500);
  assert.equal(await fixture.store.releaseLease("primary", "stale-owner"), false);
  assert.equal(await fixture.store.releaseLease("primary", "owner-one"), true);

  const expired = await fixture.store.acquireLease({
    exchangeAccountId: "primary",
    ownerToken: "expired-owner",
    purpose: "ORDER_SUBMISSION",
    acquiredAtEpochMs: 3_000,
    expiresAtEpochMs: 4_000,
  });
  assert.equal(expired?.ownerToken, "expired-owner");

  await fixture.setBlockingOrder(true);
  assert.equal(await fixture.store.acquireLease({
    exchangeAccountId: "primary",
    ownerToken: "blocked-takeover",
    purpose: "ORDER_SUBMISSION",
    acquiredAtEpochMs: 5_000,
    expiresAtEpochMs: 6_000,
  }), null);

  await fixture.setBlockingOrder(false);
  const takeover = await fixture.store.acquireLease({
    exchangeAccountId: "primary",
    ownerToken: "new-owner",
    purpose: "ORDER_SUBMISSION",
    acquiredAtEpochMs: 5_000,
    expiresAtEpochMs: 6_000,
  });
  assert.equal(takeover?.ownerToken, "new-owner");
  assert.equal(await fixture.store.releaseLease("primary", "expired-owner"), false);
  assert.deepEqual(await fixture.store.getLease("primary"), takeover);
}

test("in-memory account execution lease store satisfies the common contract", async () => {
  let blockingOrder = false;
  await verifyAccountExecutionLeaseContract(() => ({
    store: new InMemoryAccountExecutionLeaseStore(
      (exchangeAccountId) => exchangeAccountId === "primary" && blockingOrder,
    ),
    setBlockingOrder(active) {
      blockingOrder = active;
    },
  }));
});
