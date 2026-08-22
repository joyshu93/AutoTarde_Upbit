import assert from "node:assert/strict";

import { isStrictHistoryRecoverySummary } from "../src/modules/reconciliation/history-recovery-validation.js";
import { test } from "./harness.js";

const STARTED_AT = "2026-08-22T00:00:00.000Z";
const COMPLETED_AT = "2026-08-22T00:00:01.000Z";
const OFFSET_STARTED_AT = "2026-08-22T09:00:00.123456789+09:00";
const validate = isStrictHistoryRecoverySummary as unknown as (
  value: unknown,
  reconciliationStatus: string,
  issueCodes: readonly string[],
  runStartedAt: string,
  completedOrCheckedAt: string,
) => boolean;

test("history recovery validator accepts producer-derived normal progress variants", () => {
  const fixtures = [
    normalHistoryRecovery(),
    completeHistoryRecovery(),
    pageLimitedCompleteHistoryRecovery(),
    beyondRetentionCompleteHistoryRecovery(),
  ];

  for (const fixture of fixtures) {
    assert.equal(validate(fixture, "SUCCESS", [], STARTED_AT, COMPLETED_AT), true, fixture.confidenceReason);
  }
});

test("history recovery validator accepts producer-canonical windows for an offset nanosecond run identity", () => {
  assert.equal(
    validate(offsetNanosecondHistoryRecovery(), "SUCCESS", [], OFFSET_STARTED_AT, COMPLETED_AT),
    true,
  );
});

test("history recovery validator accepts structurally legitimate failed lookup evidence", () => {
  assert.equal(
    validate(failedHistoryRecovery(""), "DRIFT_DETECTED", ["ORDER_HISTORY_LOOKUP_FAILED"], STARTED_AT, COMPLETED_AT),
    true,
  );
});

test("history recovery validator correlates producer history issue counts while allowing unrelated issues", () => {
  const recovered = normalHistoryRecovery();
  recovered.recoveredOrderCount = 1;
  assert.equal(validate(recovered, "DRIFT_DETECTED", [], STARTED_AT, COMPLETED_AT), false);
  assert.equal(validate(normalHistoryRecovery(), "DRIFT_DETECTED", ["EXCHANGE_ORDER_RECOVERED"], STARTED_AT, COMPLETED_AT), false);
  assert.equal(validate(recovered, "DRIFT_DETECTED", ["EXCHANGE_ORDER_RECOVERED", "EXCHANGE_ORDER_RECOVERED"], STARTED_AT, COMPLETED_AT), false);
  assert.equal(validate(recovered, "DRIFT_DETECTED", ["EXCHANGE_ORDER_RECOVERED", "ORDER_FILLS_BACKFILLED"], STARTED_AT, COMPLETED_AT), true);

  const failed = failedHistoryRecovery("failed");
  assert.equal(validate(failed, "DRIFT_DETECTED", ["ORDER_HISTORY_LOOKUP_FAILED", "ORDER_HISTORY_LOOKUP_FAILED"], STARTED_AT, COMPLETED_AT), false);
  assert.equal(validate(failed, "DRIFT_DETECTED", ["ORDER_HISTORY_LOOKUP_FAILED", "EXCHANGE_ORDER_RECOVERED"], STARTED_AT, COMPLETED_AT), false);
  assert.equal(validate(failed, "DRIFT_DETECTED", ["CANDIDATE_EVIDENCE_PROJECTION_DEFERRED", "ORDER_HISTORY_LOOKUP_FAILED"], STARTED_AT, COMPLETED_AT), true);
});

test("history recovery validator rejects malformed cardinality, derivations, aggregates, pages, and counts", () => {
  const malformed = [
    mutate(normalHistoryRecovery(), (history) => { history.markets.pop(); }),
    mutate(normalHistoryRecovery(), (history) => { history.markets[1]!.market = "KRW-BTC"; }),
    mutate(normalHistoryRecovery(), (history) => { history.stopBeforeAt = "2025-08-21T00:00:00.000Z"; }),
    mutate(normalHistoryRecovery(), (history) => { history.markets[0]!.recentClosedWindowEndAt = COMPLETED_AT; }),
    mutate(normalHistoryRecovery(), (history) => { history.markets[0]!.archivalWindowStartAt = "2026-08-09T00:00:00.000Z"; }),
    mutate(normalHistoryRecovery(), (history) => { history.confidenceLevel = "HIGH"; }),
    mutate(normalHistoryRecovery(), (history) => { history.markets[0]!.openHistoryTruncated = true; history.markets[0]!.openPagesScanned = 0; history.markets[0]!.confidenceReason = "PAGE_LIMIT_REACHED"; }),
    mutate(normalHistoryRecovery(), (history) => { history.markets[0]!.snapshotCount = 1; history.markets[0]!.openPagesScanned = 0; history.markets[0]!.recentClosedPagesScanned = 0; history.markets[0]!.archivalClosedPagesScanned = 0; }),
    mutate(normalHistoryRecovery(), (history) => { history.recoveredOrderCount = 3; }),
    mutate(normalHistoryRecovery(), (history) => { history.scannedSnapshotCount = 0; }),
  ];

  for (const fixture of malformed) {
    assert.equal(validate(fixture, "SUCCESS", [], STARTED_AT, COMPLETED_AT), false);
  }
});

test("history recovery validator requires producer page minima for normal market rows", () => {
  const malformed = [
    mutate(normalHistoryRecovery(), (history) => { history.markets[0]!.openPagesScanned = 0; }),
    mutate(normalHistoryRecovery(), (history) => { history.markets[0]!.recentClosedPagesScanned = 0; }),
    mutate(normalHistoryRecovery(), (history) => { history.markets[0]!.archivalClosedPagesScanned = 0; }),
    mutate(normalHistoryRecovery(), (history) => {
      history.scannedSnapshotCount = 0;
      history.recoveredOrderCount = 0;
      history.markets[0]!.openPagesScanned = 0;
      history.markets[0]!.recentClosedPagesScanned = 0;
      history.markets[0]!.archivalClosedPagesScanned = 0;
      history.markets[0]!.snapshotCount = 0;
    }),
  ];

  for (const fixture of malformed) {
    assert.equal(validate(fixture, "SUCCESS", [], STARTED_AT, COMPLETED_AT), false);
  }
  assert.equal(validate(completeHistoryRecovery(), "SUCCESS", [], STARTED_AT, COMPLETED_AT), true);
});

test("history recovery validator enforces failed-message and bidirectional lookup-issue correlation", () => {
  assert.equal(validate(failedHistoryRecovery(7 as never), "DRIFT_DETECTED", ["ORDER_HISTORY_LOOKUP_FAILED"], STARTED_AT, COMPLETED_AT), false);
  assert.equal(validate(failedHistoryRecovery("failed"), "SUCCESS", ["ORDER_HISTORY_LOOKUP_FAILED"], STARTED_AT, COMPLETED_AT), false);
  assert.equal(validate(failedHistoryRecovery("failed"), "DRIFT_DETECTED", [], STARTED_AT, COMPLETED_AT), false);
  assert.equal(validate(normalHistoryRecovery(), "DRIFT_DETECTED", ["ORDER_HISTORY_LOOKUP_FAILED"], STARTED_AT, COMPLETED_AT), false);
});

test("history recovery validator rejects future timestamps and strict-data violations without invoking getters", () => {
  let getterCalls = 0;
  const accessor = normalHistoryRecovery();
  Object.defineProperty(accessor.markets[0], "snapshotCount", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 2;
    },
  });
  const sparse = normalHistoryRecovery();
  sparse.markets = new Array(2) as HistoryRecovery["markets"];
  const symbol = normalHistoryRecovery() as HistoryRecovery & { [key: symbol]: boolean };
  Object.defineProperty(symbol, Symbol("extra"), { enumerable: true, value: true });
  const customPrototype = normalHistoryRecovery();
  Object.setPrototypeOf(customPrototype.markets[0], { custom: true });
  const future = mutate(normalHistoryRecovery(), (history) => {
    history.markets[0]!.recentClosedWindowEndAt = "2026-08-22T00:00:01.000000001Z";
  });

  for (const fixture of [accessor, sparse, symbol, customPrototype, future]) {
    assert.equal(validate(fixture, "SUCCESS", [], STARTED_AT, COMPLETED_AT), false);
  }
  assert.equal(getterCalls, 0);
});

type MarketProgress = {
  market: "KRW-BTC" | "KRW-ETH";
  recentClosedWindowStartAt: string;
  recentClosedWindowEndAt: string;
  archivalWindowStartAt: string;
  archivalWindowEndAt: string;
  nextWindowEndAt: string;
  archiveComplete: boolean;
  retentionStatus: "WITHIN_ASSUMED_RETENTION" | "BEYOND_ASSUMED_RETENTION";
  confidenceLevel: "HIGH" | "PARTIAL";
  confidenceReason: "ARCHIVE_COMPLETE" | "ARCHIVE_IN_PROGRESS" | "PAGE_LIMIT_REACHED" | "BEYOND_ASSUMED_RETENTION";
  openHistoryTruncated: boolean;
  recentClosedHistoryTruncated: boolean;
  archivalClosedHistoryTruncated: boolean;
  openPagesScanned: number;
  recentClosedPagesScanned: number;
  archivalClosedPagesScanned: number;
  snapshotCount: number;
};

type HistoryRecovery = {
  closedOrderLookbackDays: number;
  stopBeforeDays: number;
  stopBeforeAt: string;
  retentionAssumptionDays: number;
  retentionBoundaryAt: string;
  retentionStatus: "WITHIN_ASSUMED_RETENTION" | "BEYOND_ASSUMED_RETENTION";
  coverageStatus: "IN_PROGRESS" | "COMPLETE";
  confidenceLevel: "HIGH" | "PARTIAL" | "FAILED";
  confidenceReason: "ARCHIVE_COMPLETE" | "ARCHIVE_IN_PROGRESS" | "PAGE_LIMIT_REACHED" | "BEYOND_ASSUMED_RETENTION" | "LOOKUP_FAILED";
  failureMessage: string | null;
  scannedSnapshotCount: number;
  recoveredOrderCount: number;
  markets: MarketProgress[];
};

function normalHistoryRecovery(): HistoryRecovery {
  const market = (name: MarketProgress["market"]): MarketProgress => ({
    market: name,
    recentClosedWindowStartAt: "2026-08-15T00:00:00.000Z",
    recentClosedWindowEndAt: STARTED_AT,
    archivalWindowStartAt: "2026-08-08T00:00:00.000Z",
    archivalWindowEndAt: "2026-08-15T00:00:00.000Z",
    nextWindowEndAt: "2026-08-08T00:00:00.000Z",
    archiveComplete: false,
    retentionStatus: "WITHIN_ASSUMED_RETENTION",
    confidenceLevel: "PARTIAL",
    confidenceReason: "ARCHIVE_IN_PROGRESS",
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
    retentionStatus: "WITHIN_ASSUMED_RETENTION",
    coverageStatus: "IN_PROGRESS",
    confidenceLevel: "PARTIAL",
    confidenceReason: "ARCHIVE_IN_PROGRESS",
    failureMessage: null,
    scannedSnapshotCount: 2,
    recoveredOrderCount: 0,
    markets: [market("KRW-BTC"), market("KRW-ETH")],
  };
}

function completeHistoryRecovery(): HistoryRecovery {
  const history = normalHistoryRecovery();
  history.stopBeforeDays = 14;
  history.stopBeforeAt = "2026-08-08T00:00:00.000Z";
  history.coverageStatus = "COMPLETE";
  history.confidenceLevel = "HIGH";
  history.confidenceReason = "ARCHIVE_COMPLETE";
  history.scannedSnapshotCount = 0;
  history.recoveredOrderCount = 0;
  for (const market of history.markets) {
    market.archivalWindowStartAt = "2026-08-01T00:00:00.000Z";
    market.archivalWindowEndAt = "2026-08-01T00:00:00.000Z";
    market.nextWindowEndAt = "2026-08-01T00:00:00.000Z";
    market.archiveComplete = true;
    market.confidenceLevel = "HIGH";
    market.confidenceReason = "ARCHIVE_COMPLETE";
    market.archivalClosedPagesScanned = 0;
    market.snapshotCount = 0;
  }
  return history;
}

function offsetNanosecondHistoryRecovery(): HistoryRecovery {
  const history = normalHistoryRecovery();
  history.stopBeforeAt = "2025-08-22T00:00:00.123Z";
  history.retentionBoundaryAt = "2025-08-22T00:00:00.123Z";
  for (const market of history.markets) {
    market.recentClosedWindowStartAt = "2026-08-15T00:00:00.123Z";
    market.recentClosedWindowEndAt = "2026-08-22T00:00:00.123Z";
    market.archivalWindowStartAt = "2026-08-08T00:00:00.123Z";
    market.archivalWindowEndAt = "2026-08-15T00:00:00.123Z";
    market.nextWindowEndAt = "2026-08-08T00:00:00.123Z";
  }
  return history;
}

function pageLimitedCompleteHistoryRecovery(): HistoryRecovery {
  const history = completeHistoryRecovery();
  history.confidenceLevel = "PARTIAL";
  history.confidenceReason = "PAGE_LIMIT_REACHED";
  history.markets[0]!.openHistoryTruncated = true;
  history.markets[0]!.confidenceLevel = "PARTIAL";
  history.markets[0]!.confidenceReason = "PAGE_LIMIT_REACHED";
  return history;
}

function beyondRetentionCompleteHistoryRecovery(): HistoryRecovery {
  const history = completeHistoryRecovery();
  history.stopBeforeDays = 60;
  history.stopBeforeAt = "2026-06-23T00:00:00.000Z";
  history.retentionAssumptionDays = 14;
  history.retentionBoundaryAt = "2026-08-08T00:00:00.000Z";
  history.retentionStatus = "BEYOND_ASSUMED_RETENTION";
  history.confidenceLevel = "PARTIAL";
  history.confidenceReason = "BEYOND_ASSUMED_RETENTION";
  for (const market of history.markets) {
    market.archivalWindowStartAt = "2026-06-01T00:00:00.000Z";
    market.archivalWindowEndAt = "2026-06-01T00:00:00.000Z";
    market.nextWindowEndAt = "2026-06-01T00:00:00.000Z";
    market.retentionStatus = "BEYOND_ASSUMED_RETENTION";
    market.confidenceLevel = "PARTIAL";
    market.confidenceReason = "BEYOND_ASSUMED_RETENTION";
  }
  return history;
}

function failedHistoryRecovery(message: string): HistoryRecovery {
  return {
    ...normalHistoryRecovery(),
    coverageStatus: "IN_PROGRESS",
    confidenceLevel: "FAILED",
    confidenceReason: "LOOKUP_FAILED",
    failureMessage: message,
    scannedSnapshotCount: 0,
    recoveredOrderCount: 0,
    markets: [],
  };
}

function mutate(value: HistoryRecovery, mutation: (value: HistoryRecovery) => void): HistoryRecovery {
  mutation(value);
  return value;
}
