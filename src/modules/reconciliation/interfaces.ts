import type { ReconciliationStatus, SupportedMarket } from "../../domain/types.js";

export type ReconciliationTrigger = "DIRECT_RUN" | "OPERATOR_SYNC" | "STARTUP_RECOVERY";

export interface ReconciliationIssue {
  code:
    | "OPEN_ORDER_NEEDS_REVIEW"
    | "ORDER_MARKED_FOR_RECOVERY"
    | "ORDER_STATUS_RECONCILED"
    | "ORDER_FILLS_BACKFILLED"
    | "BALANCE_DRIFT_DETECTED"
    | "POSITION_DRIFT_DETECTED"
    | "TERMINAL_ORDER_RECHECKED"
    | "TERMINAL_ORDER_CONFIRMED_ABSENT"
    | "ORDER_REFERENCE_MISSING"
    | "ORDER_LOOKUP_TRANSIENT_FAILURE"
    | "ORDER_LOOKUP_DEFERRED"
    | "EXCHANGE_ORDER_RECOVERED"
    | "ORDER_HISTORY_LOOKUP_FAILED";
  message: string;
}

export interface ReconciliationHistoryRecoveryMarketProgress {
  market: SupportedMarket;
  recentClosedWindowStartAt: string;
  recentClosedWindowEndAt: string;
  archivalWindowStartAt: string;
  archivalWindowEndAt: string;
  nextWindowEndAt: string;
  archiveComplete: boolean;
  confidenceLevel: "HIGH" | "PARTIAL";
  confidenceReason: "ARCHIVE_COMPLETE" | "ARCHIVE_IN_PROGRESS" | "PAGE_LIMIT_REACHED";
  openHistoryTruncated: boolean;
  recentClosedHistoryTruncated: boolean;
  archivalClosedHistoryTruncated: boolean;
  openPagesScanned: number;
  recentClosedPagesScanned: number;
  archivalClosedPagesScanned: number;
  snapshotCount: number;
}

export interface ReconciliationHistoryRecoverySummary {
  closedOrderLookbackDays: number;
  stopBeforeDays: number;
  stopBeforeAt: string;
  coverageStatus: "IN_PROGRESS" | "COMPLETE";
  confidenceLevel: "HIGH" | "PARTIAL" | "FAILED";
  confidenceReason: "ARCHIVE_COMPLETE" | "ARCHIVE_IN_PROGRESS" | "PAGE_LIMIT_REACHED" | "LOOKUP_FAILED";
  failureMessage: string | null;
  scannedSnapshotCount: number;
  recoveredOrderCount: number;
  markets: ReconciliationHistoryRecoveryMarketProgress[];
}

export interface ReconciliationSummary {
  source: ReconciliationTrigger;
  status: ReconciliationStatus;
  issues: ReconciliationIssue[];
  candidateCount: number;
  processedCount: number;
  deferredCount: number;
  maxOrderLookupsPerRun: number;
  historyRecovery?: ReconciliationHistoryRecoverySummary;
}
