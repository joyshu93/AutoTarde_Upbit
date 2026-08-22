import assert from "node:assert/strict";

import type { ReconciliationRunRecord } from "../src/domain/types.js";
import { InMemoryExecutionRepository } from "../src/modules/db/repositories/in-memory-repositories.js";
import { PortfolioSyncService } from "../src/modules/reconciliation/portfolio-sync-service.js";
import type { ReconciliationSummary } from "../src/modules/reconciliation/interfaces.js";
import { test } from "./harness.js";

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

function createService(input: {
  repositories: InMemoryExecutionRepository;
  runWithRecord: () => Promise<{ summary: ReconciliationSummary; reconciliationRun: ReconciliationRunRecord }>;
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

test("portfolio sync persists an ERROR reconciliation row and rethrows an exact-result failure", async () => {
  const repositories = new InMemoryExecutionRepository();
  const failure = new Error("exact reconciliation failed");
  const service = createService({
    repositories,
    async runWithRecord() {
      throw failure;
    },
  });

  await assert.rejects(
    service.run({ exchangeAccountId: "primary", source: "SCHEDULER_PREFLIGHT" }),
    (error) => error === failure,
  );
  const runs = await repositories.listReconciliationRuns("primary");

  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "ERROR");
  assert.equal(runs[0]?.errorMessage, "exact reconciliation failed");
  assert.equal(JSON.parse(runs[0]?.summaryJson ?? "{}").source, "SCHEDULER_PREFLIGHT");
});
