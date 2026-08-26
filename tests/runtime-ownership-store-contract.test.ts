import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

import type {
  RuntimeOwnershipAcquisition,
  RuntimeOwnershipEventRecord,
} from "../src/domain/runtime-ownership.js";
import type { RuntimeOwnershipStore } from
  "../src/modules/db/runtime-ownership-interfaces.js";
import { InMemoryRuntimeOwnershipStore } from
  "../src/modules/db/repositories/in-memory-runtime-ownership-store.js";
import { openSqliteDatabase } from "../src/modules/db/repositories/sqlite-database.js";
import { SqliteRuntimeOwnershipStore } from
  "../src/modules/db/repositories/sqlite-runtime-ownership-store.js";
import { test } from "./harness.js";

const OWNER_A = "a".repeat(64);
const OWNER_B = "new-owner".padEnd(64, "x");
const OWNER_C = "c".repeat(64);

interface RuntimeOwnershipContractFixture {
  readonly store: RuntimeOwnershipStore;
  cleanup(): void | Promise<void>;
}

type RuntimeOwnershipContractFactory = () =>
  RuntimeOwnershipContractFixture | Promise<RuntimeOwnershipContractFixture>;

async function verifyRuntimeOwnershipStoreContract(
  createFixture: RuntimeOwnershipContractFactory,
): Promise<void> {
  const fixture = await createFixture();
  try {
    const first = await fixture.store.acquireAfterProcessLock({
      ownerToken: OWNER_A,
      executionMode: "LIVE",
      acquiredAtEpochMs: 1_000,
      expiresAtEpochMs: 46_000,
    });
    assert.equal(first.record.generation, 1);
    assert.equal(first.takeover, false);
    assert.deepEqual(await fixture.store.getCurrent(), first.record);

    const renewed = await fixture.store.renew({
      ownerToken: first.record.ownerToken,
      generation: 1,
      heartbeatAtEpochMs: 11_000,
      expiresAtEpochMs: 56_000,
    });
    assert.equal(renewed?.heartbeatAtEpochMs, 11_000);
    assert.equal(renewed?.expiresAtEpochMs, 56_000);
    assert.equal(await fixture.store.renew({
      ownerToken: OWNER_B,
      generation: 1,
      heartbeatAtEpochMs: 11_500,
      expiresAtEpochMs: 56_500,
    }), null);

    const takeover = await fixture.store.acquireAfterProcessLock({
      ownerToken: OWNER_B,
      executionMode: "LIVE",
      acquiredAtEpochMs: 12_000,
      expiresAtEpochMs: 57_000,
    });
    assert.equal(takeover.record.generation, 2);
    assert.equal(takeover.takeover, true);
    assert.equal(await fixture.store.release({
      ownerToken: OWNER_A,
      generation: 1,
      releasedAtEpochMs: 13_000,
    }), false);
    assert.equal(await fixture.store.recordLost({
      ownerToken: OWNER_A,
      generation: 1,
      lostAtEpochMs: 13_000,
      reasonCode: "RUNTIME_OWNERSHIP_MISMATCH",
    }), false);

    assert.equal(await fixture.store.recordLost({
      ownerToken: OWNER_B,
      generation: 2,
      lostAtEpochMs: 13_000,
      reasonCode: "PROCESS_LOCK_LOST",
    }), true);
    assert.deepEqual(await fixture.store.getCurrent(), takeover.record);
    assert.deepEqual(
      (await fixture.store.listRecentEvents(10)).map(eventIdentity),
      [
        "LOST:2:PROCESS_LOCK_LOST",
        "TAKEN_OVER:2:PROCESS_LOCK_ACQUIRED",
        "ACQUIRED:1:PROCESS_LOCK_ACQUIRED",
      ],
    );

    assert.equal(await fixture.store.release({
      ownerToken: OWNER_B,
      generation: 2,
      releasedAtEpochMs: 14_000,
    }), true);
    assert.equal(await fixture.store.getCurrent(), null);

    const reacquired = await fixture.store.acquireAfterProcessLock({
      ownerToken: OWNER_C,
      executionMode: "DRY_RUN",
      acquiredAtEpochMs: 15_000,
      expiresAtEpochMs: 60_000,
    });
    assert.equal(reacquired.record.generation, 3);
    assert.equal(reacquired.takeover, false);
    assert.deepEqual(
      (await fixture.store.listRecentEvents(2)).map(eventIdentity),
      [
        "ACQUIRED:3:PROCESS_LOCK_ACQUIRED",
        "RELEASED:2:CLEAN_RELEASE",
      ],
    );
  } finally {
    await fixture.cleanup();
  }
}

async function verifyRuntimeOwnershipValidationContract(
  createFixture: RuntimeOwnershipContractFactory,
): Promise<void> {
  const fixture = await createFixture();
  try {
    await assert.rejects(() => fixture.store.acquireAfterProcessLock({
      ownerToken: "not-a-runtime-owner-token",
      executionMode: "LIVE",
      acquiredAtEpochMs: 1_000,
      expiresAtEpochMs: 46_000,
    }), /owner token/u);
    await assert.rejects(() => fixture.store.acquireAfterProcessLock({
      ownerToken: OWNER_A,
      executionMode: "LIVE",
      acquiredAtEpochMs: Number.MAX_SAFE_INTEGER + 1,
      expiresAtEpochMs: Number.MAX_SAFE_INTEGER + 2,
    }), /safe integer/u);
    await assert.rejects(() => fixture.store.acquireAfterProcessLock({
      ownerToken: OWNER_A,
      executionMode: "LIVE",
      acquiredAtEpochMs: 1_000,
      expiresAtEpochMs: 1_000,
    }), /expiry/u);

    await fixture.store.acquireAfterProcessLock({
      ownerToken: OWNER_A,
      executionMode: "LIVE",
      acquiredAtEpochMs: 1_000,
      expiresAtEpochMs: 46_000,
    });
    assert.equal(await fixture.store.renew({
      ownerToken: OWNER_A,
      generation: 1,
      heartbeatAtEpochMs: 1_000,
      expiresAtEpochMs: 47_000,
    }), null);
    assert.equal((await fixture.store.getCurrent())?.expiresAtEpochMs, 46_000);
    await assert.rejects(() => fixture.store.renew({
      ownerToken: OWNER_A,
      generation: 1,
      heartbeatAtEpochMs: 999,
      expiresAtEpochMs: 46_001,
    }), /timestamp rollback/u);
    await assert.rejects(() => fixture.store.release({
      ownerToken: OWNER_A,
      generation: 1,
      releasedAtEpochMs: 999,
    }), /timestamp rollback/u);
    await assert.rejects(() => fixture.store.acquireAfterProcessLock({
      ownerToken: OWNER_B,
      executionMode: "LIVE",
      acquiredAtEpochMs: 999,
      expiresAtEpochMs: 46_001,
    }), /timestamp rollback/u);
    assert.equal(await fixture.store.release({
      ownerToken: OWNER_A,
      generation: 1,
      releasedAtEpochMs: 46_000,
    }), false);
    await assert.rejects(() => fixture.store.recordLost({
      ownerToken: OWNER_A,
      generation: 0,
      lostAtEpochMs: 46_000,
      reasonCode: "PROCESS_LOCK_LOST",
    }), /generation/u);
    await assert.rejects(() => fixture.store.recordLost({
      ownerToken: OWNER_A,
      generation: 1,
      lostAtEpochMs: 46_000,
      reasonCode: "contains secret-shaped spaces",
    }), /reason code/u);
    await assert.rejects(() => fixture.store.listRecentEvents(0), /limit/u);
  } finally {
    await fixture.cleanup();
  }
}

async function verifyAuditChronologyContract(
  createFixture: RuntimeOwnershipContractFactory,
): Promise<void> {
  const fixture = await createFixture();
  try {
    await fixture.store.acquireAfterProcessLock({
      ownerToken: OWNER_A,
      executionMode: "LIVE",
      acquiredAtEpochMs: 1_000,
      expiresAtEpochMs: 46_000,
    });
    assert.equal(await fixture.store.recordLost({
      ownerToken: OWNER_A,
      generation: 1,
      lostAtEpochMs: 20_000,
      reasonCode: "PROCESS_LOCK_LOST",
    }), true);

    await assert.rejects(() => fixture.store.renew({
      ownerToken: OWNER_A,
      generation: 1,
      heartbeatAtEpochMs: 15_000,
      expiresAtEpochMs: 60_000,
    }), /timestamp rollback/u);
    await assert.rejects(() => fixture.store.recordLost({
      ownerToken: OWNER_A,
      generation: 1,
      lostAtEpochMs: 19_999,
      reasonCode: "HEARTBEAT_FAILED",
    }), /timestamp rollback/u);
    await assert.rejects(() => fixture.store.release({
      ownerToken: OWNER_A,
      generation: 1,
      releasedAtEpochMs: 19_999,
    }), /timestamp rollback/u);
    assert.deepEqual(
      (await fixture.store.listRecentEvents(10)).map((event) => event.eventAtEpochMs),
      [20_000, 1_000],
    );
  } finally {
    await fixture.cleanup();
  }
}

test("in-memory runtime ownership store satisfies the common CAS and audit contract", async () => {
  await verifyRuntimeOwnershipStoreContract(() => ({
    store: new InMemoryRuntimeOwnershipStore(),
    cleanup() {},
  }));
});

test("SQLite runtime ownership store satisfies the common CAS and audit contract", async () => {
  await verifyRuntimeOwnershipStoreContract(createSqliteFixture);
});

test("in-memory runtime ownership store enforces strict input chronology", async () => {
  await verifyRuntimeOwnershipValidationContract(() => ({
    store: new InMemoryRuntimeOwnershipStore(),
    cleanup() {},
  }));
});

test("SQLite runtime ownership store enforces strict input chronology", async () => {
  await verifyRuntimeOwnershipValidationContract(createSqliteFixture);
});

test("in-memory runtime ownership audit events reject timestamp rollback", async () => {
  await verifyAuditChronologyContract(() => ({
    store: new InMemoryRuntimeOwnershipStore(),
    cleanup() {},
  }));
});

test("SQLite runtime ownership audit events reject timestamp rollback", async () => {
  await verifyAuditChronologyContract(createSqliteFixture);
});

test("SQLite runtime ownership store rejects malformed persisted rows", async () => {
  const fixture = await createSqliteFixture();
  try {
    const db = fixture.db;
    db.exec("PRAGMA ignore_check_constraints = ON;");
    db.prepare(`
      INSERT INTO runtime_ownership (
        lease_scope, owner_token, generation, execution_mode,
        acquired_at_epoch_ms, heartbeat_at_epoch_ms, expires_at_epoch_ms
      ) VALUES ('APPLICATION_RUNTIME', ?, 1, 'LIVE', 1000, 1000, 46000)
    `).run("invalid-token");
    db.exec("PRAGMA ignore_check_constraints = OFF;");

    await assert.rejects(() => fixture.store.getCurrent(), /owner token/u);
  } finally {
    await fixture.cleanup();
  }
});

test("SQLite runtime ownership allocation rejects malformed persisted audit evidence", async () => {
  const fixture = await createSqliteFixture();
  try {
    fixture.db.exec("PRAGMA ignore_check_constraints = ON;");
    fixture.db.prepare(`
      INSERT INTO runtime_ownership_events (
        lease_scope, generation, event_type, execution_mode, reason_code, event_at_epoch_ms
      ) VALUES ('APPLICATION_RUNTIME', 1, 'ACQUIRED', 'LIVE', 'invalid reason', 1000)
    `).run();
    fixture.db.exec("PRAGMA ignore_check_constraints = OFF;");

    await assert.rejects(() => fixture.store.listRecentEvents(10), /reason code/u);
    await assert.rejects(() => fixture.store.acquireAfterProcessLock({
      ownerToken: OWNER_A,
      executionMode: "LIVE",
      acquiredAtEpochMs: 2_000,
      expiresAtEpochMs: 47_000,
    }), /reason code/u);
  } finally {
    await fixture.cleanup();
  }
});

test("SQLite runtime ownership generation allocation fails closed on safe-integer overflow", async () => {
  const fixture = await createSqliteFixture();
  try {
    fixture.db.prepare(`
      INSERT INTO runtime_ownership_events (
        lease_scope, generation, event_type, execution_mode, reason_code, event_at_epoch_ms
      ) VALUES ('APPLICATION_RUNTIME', ?, 'RELEASED', 'LIVE', 'CLEAN_RELEASE', 1000)
    `).run(Number.MAX_SAFE_INTEGER);

    await assert.rejects(() => fixture.store.acquireAfterProcessLock({
      ownerToken: OWNER_A,
      executionMode: "LIVE",
      acquiredAtEpochMs: 2_000,
      expiresAtEpochMs: 47_000,
    }), /generation overflow/u);
    assert.equal(await fixture.store.getCurrent(), null);
    assert.equal((await fixture.store.listRecentEvents(10)).length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("two concurrent SQLite worker connections serialize generation takeover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "autotrade-runtime-ownership-race-"));
  const databasePath = join(directory, "runtime.sqlite");
  const bootstrap = openSqliteDatabase(databasePath);
  bootstrap.close();
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const storeModuleUrl = new URL(
    "../src/modules/db/repositories/sqlite-runtime-ownership-store.js",
    import.meta.url,
  ).href;

  try {
    const workerResults = await Promise.all([
      runOwnershipWorker({
        databasePath,
        storeModuleUrl,
        barrier,
        ownerToken: OWNER_A,
        executionMode: "DRY_RUN",
      }),
      runOwnershipWorker({
        databasePath,
        storeModuleUrl,
        barrier,
        ownerToken: OWNER_B,
        executionMode: "LIVE",
      }),
    ]);

    assert.notEqual(workerResults[0]?.threadId, workerResults[1]?.threadId);
    assert.equal(Atomics.load(new Int32Array(barrier), 0), 2);
    const acquisitions = workerResults
      .map((result) => result.acquisition)
      .sort((left, right) => left.record.generation - right.record.generation);
    assert.deepEqual(acquisitions.map((result) => result.record.generation), [1, 2]);
    assert.deepEqual(acquisitions.map((result) => result.takeover), [false, true]);

    const inspectionDb = new DatabaseSync(databasePath);
    const inspectionStore = new SqliteRuntimeOwnershipStore(inspectionDb);
    try {
      const current = await inspectionStore.getCurrent();
      assert.equal(current?.generation, 2);
      assert.equal(current?.ownerToken, acquisitions[1]?.record.ownerToken);
      assert.deepEqual(
        (await inspectionStore.listRecentEvents(10)).map((event) => event.eventType),
        ["TAKEN_OVER", "ACQUIRED"],
      );
    } finally {
      inspectionDb.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

interface OwnershipWorkerInput {
  readonly databasePath: string;
  readonly storeModuleUrl: string;
  readonly barrier: SharedArrayBuffer;
  readonly ownerToken: string;
  readonly executionMode: "DRY_RUN" | "LIVE";
}

interface OwnershipWorkerResult {
  readonly threadId: number;
  readonly acquisition: RuntimeOwnershipAcquisition;
}

function runOwnershipWorker(input: OwnershipWorkerInput): Promise<OwnershipWorkerResult> {
  const source = `
    import { parentPort, threadId, workerData } from "node:worker_threads";
    import { DatabaseSync } from "node:sqlite";

    void (async () => {
      let db;
      try {
        const { SqliteRuntimeOwnershipStore } = await import(workerData.storeModuleUrl);
        db = new DatabaseSync(workerData.databasePath);
        db.exec("PRAGMA foreign_keys = ON;");
        db.exec("PRAGMA busy_timeout = 5000;");
        const barrier = new Int32Array(workerData.barrier);
        const arrived = Atomics.add(barrier, 0, 1) + 1;
        if (arrived === 2) Atomics.notify(barrier, 0, 2);
        while (Atomics.load(barrier, 0) < 2) {
          const observed = Atomics.load(barrier, 0);
          if (Atomics.wait(barrier, 0, observed, 5000) === "timed-out") {
            throw new Error("Runtime ownership worker barrier timed out.");
          }
        }
        const store = new SqliteRuntimeOwnershipStore(db);
        const acquisition = await store.acquireAfterProcessLock({
          ownerToken: workerData.ownerToken,
          executionMode: workerData.executionMode,
          acquiredAtEpochMs: 1000,
          expiresAtEpochMs: 46000,
        });
        parentPort.postMessage({ ok: true, threadId, acquisition });
      } catch (error) {
        parentPort.postMessage({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (db !== undefined) db.close();
      }
    })();
  `;

  return new Promise<OwnershipWorkerResult>((resolve, reject) => {
    const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(source)}`);
    const worker = new Worker(workerUrl, { workerData: input });
    let settled = false;
    let workerResult: OwnershipWorkerResult | null = null;
    worker.once("message", (message: unknown) => {
      const result = message as {
        readonly ok: boolean;
        readonly threadId?: number;
        readonly acquisition?: RuntimeOwnershipAcquisition;
        readonly message?: string;
      };
      if (
        !result.ok ||
        result.threadId === undefined ||
        result.acquisition === undefined
      ) {
        settled = true;
        reject(new Error(result.message ?? "Runtime ownership worker failed."));
        return;
      }
      workerResult = { threadId: result.threadId, acquisition: result.acquisition };
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`Runtime ownership worker exited with code ${code}.`));
      } else if (workerResult === null) {
        reject(new Error("Runtime ownership worker exited without a result."));
      } else {
        resolve(workerResult);
      }
    });
  });
}

function eventIdentity(event: RuntimeOwnershipEventRecord): string {
  return `${event.eventType}:${event.generation}:${event.reasonCode}`;
}

async function createSqliteFixture(): Promise<RuntimeOwnershipContractFixture & {
  readonly db: DatabaseSync;
}> {
  const directory = await mkdtemp(join(tmpdir(), "autotrade-runtime-ownership-store-"));
  const databasePath = join(directory, "runtime.sqlite");
  const handle = openSqliteDatabase(databasePath);
  return {
    db: handle.db,
    store: new SqliteRuntimeOwnershipStore(handle.db),
    async cleanup() {
      handle.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
