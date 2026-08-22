import assert from "node:assert/strict";

import { CandidateBtcRunPreparationService } from "../src/app/candidate-btc-run-preparation.js";
import type { AppConfig } from "../src/app/env.js";
import type { PositionGuardPilotRefreshReceipt } from "../src/domain/pilot-types.js";
import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  OrderRecord,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
} from "../src/domain/types.js";
import type { PortfolioSyncRunResult } from "../src/modules/reconciliation/portfolio-sync-service.js";
import { test } from "./harness.js";

const REQUESTED_AT = "2026-08-22T00:00:00.000Z";
const CHECKED_AT = "2026-08-22T00:00:01.000Z";

test("candidate preparation refreshes once then evaluates exact refreshed evidence and returns a frozen READY receipt", async () => {
  const trace: string[] = [];
  const freshResult = createSyncResult();
  const preparation = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run(input) {
        trace.push(`refresh:${input.requestedAt}`);
        assert.deepEqual(input, {
          exchangeAccountId: "primary",
          source: "SCHEDULER_PREFLIGHT",
          requestedAt: REQUESTED_AT,
        });
        return freshResult;
      },
    },
    operatorState: {
      async getState() {
        trace.push("state");
        return createExecutionState();
      },
    },
    repositories: {
      async listActiveOrders() {
        trace.push("orders");
        return [];
      },
    },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => {
      trace.push("checked-at");
      return CHECKED_AT;
    },
  });

  const result = await preparation.prepare({
    exchangeAccountId: "primary",
    requestedAt: REQUESTED_AT,
    requestedBy: "TELEGRAM",
  });

  assert.deepEqual(trace, [
    `refresh:${REQUESTED_AT}`,
    "state",
    "orders",
    "checked-at",
  ]);
  assert.equal(result.status, "READY");
  if (result.status !== "READY") throw new Error("expected READY");
  assert.deepEqual(result.refreshReceipt, createReceipt());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.refreshReceipt), true);
  assert.notEqual(result.refreshReceipt, freshResult as unknown as PositionGuardPilotRefreshReceipt);
});

test("candidate preparation returns BLOCKED with deterministic blocking checks and does not substitute newer records", async () => {
  const preparation = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run() {
        return createSyncResult({
          balanceSnapshot: { ...createBalanceSnapshot(), id: "exact-balance" },
          positionSnapshot: { ...createPositionSnapshot(), id: "exact-position" },
          reconciliationRun: createReconciliationRun({ id: "exact-reconciliation" }),
        });
      },
    },
    operatorState: { async getState() { return createExecutionState(); } },
    repositories: {
      async listActiveOrders() {
        return [createOrder()];
      },
    },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });

  const result = await preparation.prepare({
    exchangeAccountId: "primary",
    requestedAt: REQUESTED_AT,
    requestedBy: "SCHEDULER",
  });

  assert.deepEqual(result, {
    status: "BLOCKED",
    detail: "Candidate BTC run blocked by active_orders.",
  });
  assert.equal(Object.isFrozen(result), true);
});

test("candidate preparation returns READY when exact reconciliation evidence is a non-blocking WARN", async () => {
  const preparation = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run() {
        return createSyncResult({
          reconciliationSummary: {
            source: "SCHEDULER_PREFLIGHT",
            status: "DRIFT_DETECTED",
            issues: [{ code: "ORDER_STATUS_RECONCILED", message: "terminal state was reconciled" }],
            candidateCount: 0,
            processedCount: 0,
            deferredCount: 0,
            maxOrderLookupsPerRun: 10,
          },
          reconciliationRun: createReconciliationRun({
            status: "DRIFT_DETECTED",
            summaryJson: JSON.stringify({
              source: "SCHEDULER_PREFLIGHT",
              status: "DRIFT_DETECTED",
              issues: [{ code: "ORDER_STATUS_RECONCILED", message: "terminal state was reconciled" }],
              candidateCount: 0,
              processedCount: 0,
              deferredCount: 0,
              maxOrderLookupsPerRun: 10,
            }),
          }),
        });
      },
    },
    operatorState: { async getState() { return createExecutionState(); } },
    repositories: { async listActiveOrders() { return []; } },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });

  const result = await preparation.prepare({
    exchangeAccountId: "primary",
    requestedAt: REQUESTED_AT,
    requestedBy: "TELEGRAM",
  });

  assert.equal(result.status, "READY");
});

test("candidate preparation fails closed when refresh evidence is not exact candidate authority", async () => {
  let stateReads = 0;
  const preparation = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run() {
        return createSyncResult({
          reconciliationRun: createReconciliationRun({ exchangeAccountId: "other" }),
        });
      },
    },
    operatorState: {
      async getState() {
        stateReads += 1;
        return createExecutionState();
      },
    },
    repositories: { async listActiveOrders() { return []; } },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });

  await assert.rejects(
    preparation.prepare({
      exchangeAccountId: "primary",
      requestedAt: REQUESTED_AT,
      requestedBy: "TELEGRAM",
    }),
    /reconciliation run exchangeAccountId must match the request/,
  );
  assert.equal(stateReads, 0);
});

test("candidate preparation rejects every malformed execution-state authority value before preflight", async () => {
  const malformedStates: Array<Partial<ExecutionStateRecord>> = [
    { executionMode: "INVALID" as never },
    { liveExecutionGate: undefined as never },
    { systemStatus: 1 as never },
    { killSwitchActive: undefined as never },
    { killSwitchActive: "false" as never },
    { killSwitchActive: 0 as never },
    { pauseReason: false as never },
    { degradedReason: 0 as never },
    { degradedAt: "2026-08-22T00:00:00" as never },
  ];

  for (const malformedState of malformedStates) {
    let activeOrderReads = 0;
    const preparation = new CandidateBtcRunPreparationService({
      config: createConfig(),
      portfolioSync: { async run() { return createSyncResult(); } },
      operatorState: { async getState() { return { ...createExecutionState(), ...malformedState }; } },
      repositories: {
        async listActiveOrders() {
          activeOrderReads += 1;
          return [];
        },
      },
      exchangeBackedReadEnabled: true,
      liveSendPath: "LIVE_ADAPTER",
      now: () => CHECKED_AT,
    });

    await assert.rejects(
      preparation.prepare({
        exchangeAccountId: "primary",
        requestedAt: REQUESTED_AT,
        requestedBy: "TELEGRAM",
      }),
      /candidate BTC execution state/,
    );
    assert.equal(activeOrderReads, 0);
  }
});

test("candidate preparation rejects contradictory RUNNING state before active-order reads", async () => {
  let activeOrderReads = 0;
  const preparation = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: { async run() { return createSyncResult(); } },
    operatorState: { async getState() { return createExecutionState({ pauseReason: "operator pause", degradedAt: CHECKED_AT }); } },
    repositories: { async listActiveOrders() { activeOrderReads += 1; return []; } },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });
  await assert.rejects(
    preparation.prepare({ exchangeAccountId: "primary", requestedAt: REQUESTED_AT, requestedBy: "SCHEDULER" }),
    /RUNNING state/,
  );
  assert.equal(activeOrderReads, 0);
});

test("candidate preparation rejects hostile, sparse, and non-standard active-order arrays without invoking array methods or accessors", async () => {
  const hostileSlice = [createOrder()] as OrderRecord[] & { slice?: () => OrderRecord[] };
  let sliceCalls = 0;
  Object.defineProperty(hostileSlice, "slice", { value: () => { sliceCalls += 1; return []; } });
  const accessorOrders = [createOrder()];
  let accessorCalls = 0;
  Object.defineProperty(accessorOrders, "0", { enumerable: true, get() { accessorCalls += 1; throw new Error("must not run"); } });
  const sparseOrders = new Array<OrderRecord>(1);
  const prototypeOrders = [createOrder()];
  Object.setPrototypeOf(prototypeOrders, { slice() { throw new Error("must not run"); } });

  for (const orders of [hostileSlice, accessorOrders, sparseOrders, prototypeOrders]) {
    const preparation = new CandidateBtcRunPreparationService({
      config: createConfig(),
      portfolioSync: { async run() { return createSyncResult(); } },
      operatorState: { async getState() { return createExecutionState(); } },
      repositories: { async listActiveOrders() { return orders; } },
      exchangeBackedReadEnabled: true,
      liveSendPath: "LIVE_ADAPTER",
      now: () => CHECKED_AT,
    });
    await assert.rejects(
      preparation.prepare({ exchangeAccountId: "primary", requestedAt: REQUESTED_AT, requestedBy: "TELEGRAM" }),
      /active orders must be a plain dense data array/,
    );
  }
  assert.equal(sliceCalls, 0);
  assert.equal(accessorCalls, 0);
});

test("candidate preparation rejects reversed reconciliation chronology and blocks future completion evidence", async () => {
  const reversed = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run() {
        return createSyncResult({
          reconciliationRun: createReconciliationRun({ completedAt: "2026-08-21T23:59:59.999Z" }),
        });
      },
    },
    operatorState: { async getState() { return createExecutionState(); } },
    repositories: { async listActiveOrders() { return []; } },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });
  await assert.rejects(
    reversed.prepare({ exchangeAccountId: "primary", requestedAt: REQUESTED_AT, requestedBy: "SCHEDULER" }),
    /completedAt must not precede/,
  );

  const future = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run() {
        return createSyncResult({
          reconciliationRun: createReconciliationRun({ completedAt: "2026-08-22T00:00:02.000Z" }),
        });
      },
    },
    operatorState: { async getState() { return createExecutionState(); } },
    repositories: { async listActiveOrders() { return []; } },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });
  const result = await future.prepare({ exchangeAccountId: "primary", requestedAt: REQUESTED_AT, requestedBy: "SCHEDULER" });
  assert.deepEqual(result, {
    status: "BLOCKED",
    detail: "Candidate BTC run blocked by latest_reconciliation.",
  });
});

test("candidate preparation rejects descriptor-unsafe or conflicting reconciliation summary authority before state reads", async () => {
  let stateReads = 0;
  const accessorSummary = { ...createSyncResult().reconciliationSummary } as PortfolioSyncRunResult["reconciliationSummary"];
  Object.defineProperty(accessorSummary, "source", {
    enumerable: true,
    get() {
      throw new Error("summary accessor must not run");
    },
  });

  const preparation = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run() {
        return createSyncResult({
          reconciliationSummary: accessorSummary,
          reconciliationRun: createReconciliationRun({
            summaryJson: JSON.stringify({ source: "SCHEDULER_PREFLIGHT", status: "SUCCESS", issues: [] }),
          }),
        });
      },
    },
    operatorState: { async getState() { stateReads += 1; return createExecutionState(); } },
    repositories: { async listActiveOrders() { return []; } },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });
  await assert.rejects(
    preparation.prepare({ exchangeAccountId: "primary", requestedAt: REQUESTED_AT, requestedBy: "TELEGRAM" }),
    /reconciliationSummary source must be an enumerable data property/,
  );
  assert.equal(stateReads, 0);

  const conflicting = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run() {
        return createSyncResult({
          reconciliationRun: createReconciliationRun({
            summaryJson: JSON.stringify({ source: "SCHEDULER_PREFLIGHT", status: "SUCCESS", issues: [], candidateCount: 1, processedCount: 0, deferredCount: 0, maxOrderLookupsPerRun: 10 }),
          }),
        });
      },
    },
    operatorState: { async getState() { return createExecutionState(); } },
    repositories: { async listActiveOrders() { return []; } },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });
  await assert.rejects(
    conflicting.prepare({ exchangeAccountId: "primary", requestedAt: REQUESTED_AT, requestedBy: "TELEGRAM" }),
    /summary evidence must match/,
  );

  const issueOrderedSummary = {
    source: "SCHEDULER_PREFLIGHT" as const,
    status: "DRIFT_DETECTED" as const,
    issues: [
      { code: "ORDER_STATUS_RECONCILED" as const, message: "first material issue" },
      { code: "EXCHANGE_ORDER_RECOVERED" as const, message: "second material issue" },
    ],
    candidateCount: 0,
    processedCount: 0,
    deferredCount: 0,
    maxOrderLookupsPerRun: 10,
  };
  const reorderedMaterial = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: {
      async run() {
        return createSyncResult({
          reconciliationSummary: issueOrderedSummary,
          reconciliationRun: createReconciliationRun({
            status: "DRIFT_DETECTED",
            summaryJson: JSON.stringify({
              ...issueOrderedSummary,
              issues: [
                { code: "EXCHANGE_ORDER_RECOVERED", message: "second material issue" },
                { code: "ORDER_STATUS_RECONCILED", message: "first material issue" },
              ],
            }),
          }),
        });
      },
    },
    operatorState: { async getState() { return createExecutionState(); } },
    repositories: { async listActiveOrders() { return []; } },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });
  await assert.rejects(
    reorderedMaterial.prepare({ exchangeAccountId: "primary", requestedAt: REQUESTED_AT, requestedBy: "TELEGRAM" }),
    /summary evidence must match/,
  );
});

test("candidate preparation rejects malformed history recovery even when returned and persisted summaries match", async () => {
  const summary = { ...createSyncResult().reconciliationSummary, historyRecovery: {} } as never;
  const preparation = new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: { async run() { return createSyncResult({ reconciliationSummary: summary, reconciliationRun: createReconciliationRun({ summaryJson: JSON.stringify(summary) }) }); } },
    operatorState: { async getState() { return createExecutionState(); } },
    repositories: { async listActiveOrders() { return []; } }, exchangeBackedReadEnabled: true, liveSendPath: "LIVE_ADAPTER", now: () => CHECKED_AT,
  });
  await assert.rejects(preparation.prepare({ exchangeAccountId: "primary", requestedAt: REQUESTED_AT, requestedBy: "TELEGRAM" }), /historyRecovery/);
});

test("candidate preparation fully validates persisted history recovery with exact run chronology", async () => {
  const valid = candidateHistoryRecovery();
  assert.equal(
    (await candidatePreparationForSummary(candidateSummary("SUCCESS", [], valid), "SUCCESS").prepare({
      exchangeAccountId: "primary",
      requestedAt: REQUESTED_AT,
      requestedBy: "TELEGRAM",
    })).status,
    "READY",
  );
  const malformed = [
    { ...valid, failureMessage: 7 },
    { ...valid, markets: valid.markets.slice(0, 1) },
    { ...valid, retentionBoundaryAt: "2025-08-21T00:00:00.000Z" },
    { ...valid, confidenceLevel: "HIGH" },
    { ...valid, markets: valid.markets.map((market, index) => index === 0 ? { ...market, archivalWindowStartAt: "2026-08-09T00:00:00.000Z" } : market) },
    { ...valid, markets: valid.markets.map((market, index) => index === 0 ? { ...market, recentClosedHistoryTruncated: true, recentClosedPagesScanned: 0, confidenceReason: "PAGE_LIMIT_REACHED" } : market), confidenceReason: "PAGE_LIMIT_REACHED" },
    { ...valid, scannedSnapshotCount: 0 },
  ];
  for (const historyRecovery of malformed) {
    const summary = candidateSummary("SUCCESS", [], historyRecovery);
    const preparation = candidatePreparationForSummary(summary, "SUCCESS");
    await assert.rejects(
      preparation.prepare({ exchangeAccountId: "primary", requestedAt: REQUESTED_AT, requestedBy: "TELEGRAM" }),
      /historyRecovery/,
    );
  }
});

test("candidate preparation rejects reverse lookup-failure mismatch but returns BLOCKED for legitimate failed lookup", async () => {
  const lookupIssues = [{ code: "ORDER_HISTORY_LOOKUP_FAILED", message: "lookup failed" }] as const;
  const failed = { ...candidateHistoryRecovery(), confidenceLevel: "FAILED", confidenceReason: "LOOKUP_FAILED", failureMessage: "", scannedSnapshotCount: 0, recoveredOrderCount: 0, markets: [] };
  const legitimate = candidatePreparationForSummary(candidateSummary("DRIFT_DETECTED", lookupIssues, failed), "DRIFT_DETECTED");
  assert.deepEqual(
    await legitimate.prepare({ exchangeAccountId: "primary", requestedAt: REQUESTED_AT, requestedBy: "TELEGRAM" }),
    { status: "BLOCKED", detail: "Candidate BTC run blocked by latest_reconciliation." },
  );

  for (const summary of [
    candidateSummary("DRIFT_DETECTED", [], failed),
    candidateSummary("DRIFT_DETECTED", lookupIssues, candidateHistoryRecovery()),
    candidateSummary("DRIFT_DETECTED", lookupIssues, { ...failed, failureMessage: 7 }),
  ]) {
    await assert.rejects(
      candidatePreparationForSummary(summary, "DRIFT_DETECTED").prepare({ exchangeAccountId: "primary", requestedAt: REQUESTED_AT, requestedBy: "TELEGRAM" }),
      /historyRecovery/,
    );
  }
});

test("candidate preparation rejects nested history accessors and sparse market arrays before later dependency reads", async () => {
  let getterCalls = 0;
  let stateReads = 0;
  const accessor = candidateHistoryRecovery();
  Object.defineProperty(accessor.markets[0], "snapshotCount", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 2;
    },
  });
  const sparse = candidateHistoryRecovery();
  sparse.markets = new Array(2) as typeof sparse.markets;
  for (const historyRecovery of [accessor, sparse]) {
    const summary = candidateSummary("SUCCESS", [], historyRecovery);
    const persistedSummary = candidateSummary("SUCCESS", [], candidateHistoryRecovery());
    const preparation = candidatePreparationForSummary(summary, "SUCCESS", () => { stateReads += 1; }, persistedSummary);
    await assert.rejects(
      preparation.prepare({ exchangeAccountId: "primary", requestedAt: REQUESTED_AT, requestedBy: "TELEGRAM" }),
      /historyRecovery/,
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(stateReads, 0);
});

test("candidate preparation snapshots caller, dependency, and exact sync-result authority across awaits without latest-row substitution", async () => {
  let releaseState!: () => void;
  const stateGate = new Promise<void>((resolve) => { releaseState = resolve; });
  let stateReadStarted!: () => void;
  const stateRead = new Promise<void>((resolve) => { stateReadStarted = resolve; });
  const request = {
    exchangeAccountId: "primary",
    requestedAt: REQUESTED_AT,
    requestedBy: "TELEGRAM" as const,
  };
  const config = createConfig();
  const syncResult = createSyncResult();
  const operatorState = {
    async getState() {
      stateReadStarted();
      await stateGate;
      return createExecutionState();
    },
  };
  const repositories = {
    async listActiveOrders(): Promise<OrderRecord[]> { return []; },
    getLatestBalanceSnapshot() { throw new Error("candidate preparation must not read latest balance rows"); },
    getLatestPositionSnapshot() { throw new Error("candidate preparation must not read latest position rows"); },
    listReconciliationRuns() { throw new Error("candidate preparation must not read latest reconciliation rows"); },
  };
  const preparation = new CandidateBtcRunPreparationService({
    config,
    portfolioSync: { async run() { return syncResult; } },
    operatorState,
    repositories,
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });

  const pending = preparation.prepare(request);
  await stateRead;
  request.exchangeAccountId = "other";
  request.requestedAt = "2026-08-22T01:00:00.000Z";
  config.liveExecutionGate = "DISABLED";
  operatorState.getState = async () => ({ ...createExecutionState(), killSwitchActive: true });
  repositories.listActiveOrders = async () => [createOrder()];
  syncResult.balanceSnapshot.id = "newer-balance";
  syncResult.positionSnapshot.id = "newer-position";
  syncResult.reconciliationRun.id = "newer-reconciliation";
  syncResult.reconciliationSummary.candidateCount = 99;
  releaseState();

  const result = await pending;
  assert.equal(result.status, "READY");
  if (result.status !== "READY") throw new Error("expected READY");
  assert.deepEqual(result.refreshReceipt, createReceipt());
});

function createSyncResult(overrides: Partial<PortfolioSyncRunResult> = {}): PortfolioSyncRunResult {
  return {
    requestedAt: REQUESTED_AT,
    valuationSource: "public_ticker",
    balanceSnapshot: createBalanceSnapshot(),
    positionSnapshot: createPositionSnapshot(),
    previousBalanceSnapshot: null,
    previousPositionSnapshot: null,
    reconciliationSummary: {
      source: "SCHEDULER_PREFLIGHT",
      status: "SUCCESS",
      issues: [],
      candidateCount: 0,
      processedCount: 0,
      deferredCount: 0,
      maxOrderLookupsPerRun: 10,
    },
    reconciliationRun: createReconciliationRun(),
    ...overrides,
  };
}

function candidatePreparationForSummary(
  summary: PortfolioSyncRunResult["reconciliationSummary"],
  status: "SUCCESS" | "DRIFT_DETECTED",
  onStateRead?: () => void,
  persistedSummary: PortfolioSyncRunResult["reconciliationSummary"] = summary,
) {
  return new CandidateBtcRunPreparationService({
    config: createConfig(),
    portfolioSync: { async run() { return createSyncResult({ reconciliationSummary: summary, reconciliationRun: createReconciliationRun({ status, summaryJson: JSON.stringify(persistedSummary) }) }); } },
    operatorState: { async getState() { onStateRead?.(); return createExecutionState(); } },
    repositories: { async listActiveOrders() { return []; } },
    exchangeBackedReadEnabled: true,
    liveSendPath: "LIVE_ADAPTER",
    now: () => CHECKED_AT,
  });
}

function candidateSummary(status: "SUCCESS" | "DRIFT_DETECTED", issues: readonly unknown[], historyRecovery: unknown): PortfolioSyncRunResult["reconciliationSummary"] {
  return {
    source: "SCHEDULER_PREFLIGHT",
    status,
    issues: issues as PortfolioSyncRunResult["reconciliationSummary"]["issues"],
    candidateCount: 0,
    processedCount: 0,
    deferredCount: 0,
    maxOrderLookupsPerRun: 10,
    historyRecovery: historyRecovery as NonNullable<PortfolioSyncRunResult["reconciliationSummary"]["historyRecovery"]>,
  };
}

function candidateHistoryRecovery() {
  const market = (name: "KRW-BTC" | "KRW-ETH") => ({
    market: name,
    recentClosedWindowStartAt: "2026-08-15T00:00:00.000Z",
    recentClosedWindowEndAt: REQUESTED_AT,
    archivalWindowStartAt: "2026-08-08T00:00:00.000Z",
    archivalWindowEndAt: "2026-08-15T00:00:00.000Z",
    nextWindowEndAt: "2026-08-08T00:00:00.000Z",
    archiveComplete: false,
    retentionStatus: "WITHIN_ASSUMED_RETENTION" as const,
    confidenceLevel: "PARTIAL" as const,
    confidenceReason: "ARCHIVE_IN_PROGRESS" as const,
    openHistoryTruncated: false,
    recentClosedHistoryTruncated: false,
    archivalClosedHistoryTruncated: false,
    openPagesScanned: 1,
    recentClosedPagesScanned: 1,
    archivalClosedPagesScanned: 1,
    snapshotCount: 2,
  });
  return {
    closedOrderLookbackDays: 7,
    stopBeforeDays: 365,
    stopBeforeAt: "2025-08-22T00:00:00.000Z",
    retentionAssumptionDays: 365,
    retentionBoundaryAt: "2025-08-22T00:00:00.000Z",
    retentionStatus: "WITHIN_ASSUMED_RETENTION" as const,
    coverageStatus: "IN_PROGRESS" as const,
    confidenceLevel: "PARTIAL" as "PARTIAL" | "FAILED" | "HIGH",
    confidenceReason: "ARCHIVE_IN_PROGRESS" as "ARCHIVE_IN_PROGRESS" | "LOOKUP_FAILED" | "PAGE_LIMIT_REACHED" | "ARCHIVE_COMPLETE" | "BEYOND_ASSUMED_RETENTION",
    failureMessage: null as string | number | null,
    scannedSnapshotCount: 2,
    recoveredOrderCount: 1,
    markets: [market("KRW-BTC"), market("KRW-ETH")],
  };
}

function createBalanceSnapshot(overrides: Partial<BalanceSnapshotRecord> = {}): BalanceSnapshotRecord {
  return {
    id: "balance-1",
    exchangeAccountId: "primary",
    capturedAt: REQUESTED_AT,
    source: "RECONCILIATION",
    totalKrwValue: "10000",
    balancesJson: "[]",
    ...overrides,
  };
}

function createPositionSnapshot(overrides: Partial<PositionSnapshotRecord> = {}): PositionSnapshotRecord {
  return {
    id: "position-1",
    exchangeAccountId: "primary",
    capturedAt: REQUESTED_AT,
    source: "RECONCILIATION",
    positionsJson: "[]",
    ...overrides,
  };
}

function createReconciliationRun(overrides: Partial<ReconciliationRunRecord> = {}): ReconciliationRunRecord {
  return {
    id: "reconciliation-1",
    exchangeAccountId: "primary",
    status: "SUCCESS",
    startedAt: REQUESTED_AT,
    completedAt: CHECKED_AT,
    summaryJson: JSON.stringify({
      source: "SCHEDULER_PREFLIGHT",
      status: "SUCCESS",
      issues: [],
      candidateCount: 0,
      processedCount: 0,
      deferredCount: 0,
      maxOrderLookupsPerRun: 10,
    }),
    errorMessage: null,
    ...overrides,
  };
}

function createReceipt(): PositionGuardPilotRefreshReceipt {
  return {
    exchangeAccountId: "primary",
    requestedAt: REQUESTED_AT,
    balanceSnapshotId: "balance-1",
    balanceCapturedAt: REQUESTED_AT,
    positionSnapshotId: "position-1",
    positionCapturedAt: REQUESTED_AT,
    reconciliationRunId: "reconciliation-1",
    reconciliationStartedAt: REQUESTED_AT,
    reconciliationCompletedAt: CHECKED_AT,
    reconciliationSource: "SCHEDULER_PREFLIGHT",
  };
}

function createExecutionState(overrides: Partial<ExecutionStateRecord> = {}): ExecutionStateRecord {
  return {
    id: "state-1",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: REQUESTED_AT,
    ...overrides,
  };
}

function createOrder(): OrderRecord {
  return {
    id: "active-order-1",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "5000",
    timeInForce: null,
    smpType: null,
    identifier: "active-order-1",
    idempotencyKey: "active-order-1",
    origin: "STRATEGY",
    requestedAt: REQUESTED_AT,
    strategyDecisionId: null,
    upbitUuid: null,
    status: "OPEN",
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: REQUESTED_AT,
    updatedAt: REQUESTED_AT,
  };
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    serviceName: "AutoTrade_Upbit",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    positionGuardPolicySelection: { kind: "BASELINE", pilotId: null },
    globalKillSwitch: false,
    upbitBaseUrl: "https://api.upbit.com",
    databasePath: "./var/test.sqlite",
    telegramLocale: "ko-KR",
    telegramDeliveryEnabled: false,
    telegramBotToken: null,
    telegramOperatorChatId: null,
    telegramDeliveryMaxAttempts: 5,
    telegramDeliveryBaseBackoffMs: 15_000,
    telegramDeliveryMaxBackoffMs: 300_000,
    telegramDeliveryLeaseMs: 30_000,
    accountExecutionLeaseMs: 30_000,
    telegramInboundPollingEnabled: false,
    telegramInboundPollIntervalMs: 2_000,
    telegramInboundPollTimeoutSeconds: 25,
    telegramInboundPollLimit: 10,
    deprecatedIgnoredEnvVars: [],
    strategySchedulerEnabled: false,
    strategySchedulerRunOnStart: false,
    strategySchedulerBtcIntervalMs: 3_600_000,
    strategySchedulerEthIntervalMs: 3_600_000,
    reconciliationMaxOrderLookupsPerRun: 10,
    reconciliationHistoryMaxPagesPerMarket: 3,
    reconciliationClosedOrderLookbackDays: 7,
    reconciliationHistoryStopBeforeDays: 365,
    reconciliationHistoryRetentionAssumptionDays: 365,
    stalePriceThresholdMs: 30_000,
    minimumOrderValueKrw: 5_000,
    maxAllocationByAsset: { BTC: 0.6, ETH: 0.6 },
    totalExposureCap: 0.75,
    ...overrides,
  };
}
