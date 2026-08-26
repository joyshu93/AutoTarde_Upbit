import assert from "node:assert/strict";

import {
  RuntimeOwnershipGuardError,
  type RuntimeOwnershipAuthority,
} from "../src/app/runtime-ownership-guard.js";
import type { ReconciliationRunRecord } from "../src/domain/types.js";
import { InMemoryExecutionRepository } from "../src/modules/db/repositories/in-memory-repositories.js";
import {
  PortfolioSyncService as ProductionPortfolioSyncService,
} from "../src/modules/reconciliation/portfolio-sync-service.js";
import type { ReconciliationSummary } from "../src/modules/reconciliation/interfaces.js";
import type { ReconciliationService } from "../src/modules/reconciliation/reconciliation-service.js";
import { test } from "./harness.js";

class PortfolioSyncService extends ProductionPortfolioSyncService {
  constructor(dependencies: ConstructorParameters<typeof ProductionPortfolioSyncService>[0]) {
    super({
      ...dependencies,
      runtimeOwnership: dependencies.runtimeOwnership ?? createAlwaysOwnedRuntimeOwnershipAuthority(),
    });
  }
}

test("portfolio sync fails closed when runtime authority is omitted", async () => {
  const repositories = new InMemoryExecutionRepository();
  let balanceReads = 0;
  const service = new ProductionPortfolioSyncService({
    exchangeAdapter: {
      async getBalances() {
        balanceReads += 1;
        return [];
      },
    },
    repositories,
    reconciliationService: {
      async runWithRecord(): Promise<never> {
        throw new Error("reconciliation must not run without ownership authority");
      },
    },
  });

  await assert.rejects(
    () => service.run({ exchangeAccountId: "primary", source: "SCHEDULER_PREFLIGHT" }),
    /RUNTIME_OWNERSHIP_NOT_HELD/u,
  );
  assert.equal(balanceReads, 0);
  assert.equal((await repositories.listReconciliationRuns("primary")).length, 0);
});

const SUMMARY: ReconciliationSummary = {
  source: "SCHEDULER_PREFLIGHT",
  status: "SUCCESS",
  issues: [],
  candidateCount: 0,
  processedCount: 0,
  deferredCount: 0,
  maxOrderLookupsPerRun: 10,
};

const EXACT_RUN: ReconciliationRunRecord = {
  id: "exact-reconciliation-run",
  exchangeAccountId: "primary",
  status: "SUCCESS",
  startedAt: "2026-08-22T00:00:00.000Z",
  completedAt: "2026-08-22T00:00:00.001Z",
  summaryJson: JSON.stringify(SUMMARY),
  errorMessage: null,
};

test("portfolio sync discards exchange results when ownership is lost during the balance read", async () => {
  const repositories = new InMemoryExecutionRepository();
  const ownership = createOwnedThenLostRuntimeOwnershipAuthority();
  let reconciliationCalls = 0;
  const service = new PortfolioSyncService({
    exchangeAdapter: {
      async getBalances() {
        ownership.lose();
        return [
          { currency: "KRW", balance: "10000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        ];
      },
    },
    repositories,
    reconciliationService: {
      async runWithRecord(): Promise<never> {
        reconciliationCalls += 1;
        throw new Error("reconciliation must not run after ownership loss");
      },
    },
    runtimeOwnership: ownership.authority,
    now: () => "2026-08-22T00:00:00.000Z",
  });

  await assert.rejects(
    () => service.run({ exchangeAccountId: "primary", source: "SCHEDULER_PREFLIGHT" }),
    (error) => error === ownership.lossError,
  );

  assert.equal(await repositories.getLatestBalanceSnapshot("primary"), null);
  assert.equal(await repositories.getLatestPositionSnapshot("primary"), null);
  assert.equal((await repositories.listReconciliationRuns("primary")).length, 0);
  assert.equal(reconciliationCalls, 0);
});

test("portfolio sync broad catch preserves the exact ownership error before a second assertion", async () => {
  const repositories = new InMemoryExecutionRepository();
  const ownership = createFreshAssertionRuntimeOwnershipAuthority();
  const originalError = new RuntimeOwnershipGuardError(
    "RUNTIME_OWNERSHIP_LOST",
    "RUNTIME_OWNERSHIP_LOST: EXCHANGE_READ_DETECTED_LOSS",
  );
  const service = new PortfolioSyncService({
    exchangeAdapter: {
      async getBalances(): Promise<never> {
        ownership.lose();
        throw originalError;
      },
    },
    repositories,
    reconciliationService: {
      async runWithRecord(): Promise<never> {
        throw new Error("reconciliation must not run after ownership loss");
      },
    },
    runtimeOwnership: ownership.authority,
    now: () => "2026-08-22T00:00:00.000Z",
  });

  await assert.rejects(
    () => service.run({ exchangeAccountId: "primary", source: "SCHEDULER_PREFLIGHT" }),
    (error) => error === originalError,
  );

  assert.equal(ownership.assertionErrors.length, 0);
  assert.equal((await repositories.listReconciliationRuns("primary")).length, 0);
});

function createFreshAssertionRuntimeOwnershipAuthority(): {
  authority: RuntimeOwnershipAuthority;
  assertionErrors: RuntimeOwnershipGuardError[];
  lose(): void;
} {
  let held = true;
  const assertionErrors: RuntimeOwnershipGuardError[] = [];
  return {
    assertionErrors,
    lose() {
      held = false;
    },
    authority: {
      snapshot: () => ({
        status: held ? "OWNED" : "LOST",
        generation: 1,
        executionMode: "DRY_RUN",
        acquiredAtEpochMs: 1,
        heartbeatAtEpochMs: 1,
        expiresAtEpochMs: 45_001,
        takeover: false,
        lossReason: held ? null : "TEST_GENERATION_REPLACED",
      }),
      assertLocallyHeld() {
        if (!held) {
          const error = new RuntimeOwnershipGuardError(
            "RUNTIME_OWNERSHIP_LOST",
            `RUNTIME_OWNERSHIP_LOST: ASSERTION_${assertionErrors.length + 1}`,
          );
          assertionErrors.push(error);
          throw error;
        }
      },
      async assertCurrent(): Promise<never> {
        throw new Error("assertCurrent is not used by portfolio sync");
      },
    },
  };
}

function createOwnedThenLostRuntimeOwnershipAuthority(): {
  authority: RuntimeOwnershipAuthority;
  lose(): void;
  lossError: RuntimeOwnershipGuardError;
} {
  let held = true;
  const lossError = new RuntimeOwnershipGuardError(
    "RUNTIME_OWNERSHIP_LOST",
    "RUNTIME_OWNERSHIP_LOST: TEST_GENERATION_REPLACED",
  );
  return {
    lossError,
    lose() {
      held = false;
    },
    authority: {
      snapshot: () => ({
        status: held ? "OWNED" : "LOST",
        generation: 1,
        executionMode: "DRY_RUN",
        acquiredAtEpochMs: 1,
        heartbeatAtEpochMs: 1,
        expiresAtEpochMs: 45_001,
        takeover: false,
        lossReason: held ? null : "TEST_GENERATION_REPLACED",
      }),
      assertLocallyHeld() {
        if (!held) throw lossError;
      },
      async assertCurrent() {
        if (!held) throw lossError;
        return {
          ownerToken: "owner".padEnd(64, "x"),
          generation: 1,
          executionMode: "DRY_RUN",
          acquiredAtEpochMs: 1,
          heartbeatAtEpochMs: 1,
          expiresAtEpochMs: 45_001,
        };
      },
    },
  };
}

function createAlwaysOwnedRuntimeOwnershipAuthority(): RuntimeOwnershipAuthority {
  const record = {
    ownerToken: "owner".padEnd(64, "x"),
    generation: 1,
    executionMode: "DRY_RUN" as const,
    acquiredAtEpochMs: 1,
    heartbeatAtEpochMs: 1,
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  };
  return {
    snapshot: () => ({
      status: "OWNED",
      generation: record.generation,
      executionMode: record.executionMode,
      acquiredAtEpochMs: record.acquiredAtEpochMs,
      heartbeatAtEpochMs: record.heartbeatAtEpochMs,
      expiresAtEpochMs: record.expiresAtEpochMs,
      takeover: false,
      lossReason: null,
    }),
    assertLocallyHeld() {},
    async assertCurrent() {
      return { ...record };
    },
  };
}

function createService(input: {
  repositories: InMemoryExecutionRepository;
  runWithRecord: ReconciliationService["runWithRecord"];
}) {
  return new PortfolioSyncService({
    exchangeAdapter: {
      async getBalances() {
        return [
          { currency: "KRW", balance: "10000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        ];
      },
    },
    repositories: input.repositories,
    reconciliationService: {
      runWithRecord: input.runWithRecord,
    },
    now: () => "2026-08-22T00:00:00.000Z",
  });
}

test("portfolio sync propagates the exact reconciliation record from the same invocation", async () => {
  const repositories = new InMemoryExecutionRepository();
  const service = createService({
    repositories,
    async runWithRecord() {
      await repositories.saveReconciliationRun(EXACT_RUN);
      await repositories.saveReconciliationRun({
        ...EXACT_RUN,
        id: "concurrent-newer-run",
        startedAt: "2099-01-01T00:00:00.000Z",
        completedAt: "2099-01-01T00:00:00.001Z",
      });
      return { summary: SUMMARY, reconciliationRun: { ...EXACT_RUN } };
    },
  });

  const result = await service.run({
    exchangeAccountId: "primary",
    source: "SCHEDULER_PREFLIGHT",
  });

  assert.deepEqual(result.reconciliationRun, EXACT_RUN);
  assert.equal(result.reconciliationSummary, SUMMARY);
});

test("portfolio sync preserves an explicit requested time for snapshots and reconciliation identity", async () => {
  const repositories = new InMemoryExecutionRepository();
  let observedStartedAt: string | undefined;
  const service = createService({
    repositories,
    async runWithRecord(_exchangeAccountId, options) {
      observedStartedAt = options?.runIdentity?.startedAt;
      return {
        summary: SUMMARY,
        reconciliationRun: {
          ...EXACT_RUN,
          id: options?.runIdentity?.id ?? "missing-id",
          startedAt: options?.runIdentity?.startedAt ?? "missing-started-at",
        },
      };
    },
  });

  const result = await service.run({
    exchangeAccountId: "primary",
    source: "SCHEDULER_PREFLIGHT",
    requestedAt: "2026-08-22T00:00:05.123456789+09:00",
  });

  assert.equal(result.requestedAt, "2026-08-22T00:00:05.123456789+09:00");
  assert.equal(result.balanceSnapshot.capturedAt, "2026-08-22T00:00:05.123456789+09:00");
  assert.equal(result.positionSnapshot.capturedAt, "2026-08-22T00:00:05.123456789+09:00");
  assert.equal(observedStartedAt, "2026-08-22T00:00:05.123456789+09:00");
  assert.equal(result.reconciliationRun.startedAt, "2026-08-22T00:00:05.123456789+09:00");
});

test("portfolio sync rejects accessor requested time before any dependency read", async () => {
  const repositories = new InMemoryExecutionRepository();
  let dependencyReads = 0;
  const service = new PortfolioSyncService({
    exchangeAdapter: {
      async getBalances() {
        dependencyReads += 1;
        return [];
      },
    },
    repositories,
    reconciliationService: {
      async runWithRecord() {
        dependencyReads += 1;
        throw new Error("not reached");
      },
    },
  });
  const input = Object.defineProperty({
    exchangeAccountId: "primary",
    source: "SCHEDULER_PREFLIGHT",
  }, "requestedAt", {
    enumerable: true,
    get() {
      throw new Error("requestedAt accessor must not execute");
    },
  });

  await assert.rejects(
    service.run(input as { exchangeAccountId: string; source: "SCHEDULER_PREFLIGHT"; requestedAt?: string }),
    /requestedAt must be an enumerable string data property/,
  );
  assert.equal(dependencyReads, 0);
});

test("portfolio sync rejects invalid or accessor source before any dependency read", async () => {
  const repositories = new InMemoryExecutionRepository();
  let dependencyReads = 0;
  const service = new PortfolioSyncService({
    exchangeAdapter: { async getBalances() { dependencyReads += 1; return []; } },
    repositories,
    reconciliationService: { async runWithRecord() { dependencyReads += 1; throw new Error("not reached"); } },
  });
  await assert.rejects(
    service.run({ exchangeAccountId: "primary", source: "INVALID" as never }),
    /source is unsupported/,
  );
  const accessorInput = Object.defineProperty({ exchangeAccountId: "primary" }, "source", {
    enumerable: true,
    get() { throw new Error("source accessor must not execute"); },
  });
  await assert.rejects(
    service.run(accessorInput as { exchangeAccountId: string; source: "SCHEDULER_PREFLIGHT" }),
    /source must be an enumerable string data property/,
  );
  assert.equal(dependencyReads, 0);
});

test("portfolio sync snapshots a valid source before caller mutation across an await", async () => {
  const repositories = new InMemoryExecutionRepository();
  let releaseBalances!: () => void;
  const balancesGate = new Promise<void>((resolve) => { releaseBalances = resolve; });
  let balanceReadStarted!: () => void;
  const balanceRead = new Promise<void>((resolve) => { balanceReadStarted = resolve; });
  let observedSource: string | undefined;
  const service = new PortfolioSyncService({
    exchangeAdapter: {
      async getBalances() {
        balanceReadStarted();
        await balancesGate;
        return [];
      },
    },
    repositories,
    reconciliationService: {
      async runWithRecord(_accountId, options) {
        observedSource = options?.source;
        return { summary: SUMMARY, reconciliationRun: EXACT_RUN };
      },
    },
    now: () => "2026-08-22T00:00:00.000Z",
  });
  const input: { exchangeAccountId: string; source: "DIRECT_RUN" | "SCHEDULER_PREFLIGHT" } = {
    exchangeAccountId: "primary",
    source: "SCHEDULER_PREFLIGHT",
  };
  const pending = service.run(input);
  await balanceRead;
  input.source = "DIRECT_RUN";
  releaseBalances();
  await pending;
  assert.equal(observedSource, "SCHEDULER_PREFLIGHT");
});

test("portfolio sync persists an ERROR reconciliation row and rethrows an exact-result failure", async () => {
  const repositories = new InMemoryExecutionRepository();
  const failure = new Error("exact reconciliation failed");
  let receivedIdentity: { id: string; startedAt: string } | undefined;
  const service = createService({
    repositories,
    async runWithRecord(_exchangeAccountId, options) {
      receivedIdentity = options?.runIdentity;
      throw failure;
    },
  });

  await assert.rejects(
    service.run({ exchangeAccountId: "primary", source: "SCHEDULER_PREFLIGHT" }),
    (error) => error === failure,
  );
  const runs = await repositories.listReconciliationRuns("primary");

  assert.ok(receivedIdentity);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.id, receivedIdentity.id);
  assert.equal(runs[0]?.startedAt, receivedIdentity.startedAt);
  assert.equal(runs[0]?.status, "ERROR");
  assert.equal(runs[0]?.errorMessage, "exact reconciliation failed");
  assert.equal(JSON.parse(runs[0]?.summaryJson ?? "{}").source, "SCHEDULER_PREFLIGHT");
});

test("portfolio sync converts a persist-then-throw reconciliation into one ERROR row for the same invocation", async () => {
  const repositories = new InMemoryExecutionRepository();
  const failure = new Error("persistence callback failed after save");
  let receivedIdentity: { id: string; startedAt: string } | undefined;
  const service = createService({
    repositories,
    async runWithRecord(exchangeAccountId, options) {
      receivedIdentity = options?.runIdentity;
      assert.ok(receivedIdentity);
      await repositories.saveReconciliationRun({
        id: receivedIdentity.id,
        exchangeAccountId,
        status: "SUCCESS",
        startedAt: receivedIdentity.startedAt,
        completedAt: "2026-08-22T00:00:00.001Z",
        summaryJson: JSON.stringify(SUMMARY),
        errorMessage: null,
      });
      throw failure;
    },
  });

  await assert.rejects(
    service.run({ exchangeAccountId: "primary", source: "SCHEDULER_PREFLIGHT" }),
    (error) => error === failure,
  );
  const runs = await repositories.listReconciliationRuns("primary");

  assert.ok(receivedIdentity);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.id, receivedIdentity.id);
  assert.equal(runs[0]?.startedAt, receivedIdentity.startedAt);
  assert.equal(runs[0]?.status, "ERROR");
  assert.equal(runs[0]?.errorMessage, failure.message);
});
