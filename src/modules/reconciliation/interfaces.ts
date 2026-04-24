import type { ReconciliationStatus } from "../../domain/types.js";

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
    | "ORDER_LOOKUP_DEFERRED";
  message: string;
}

export interface ReconciliationSummary {
  source: ReconciliationTrigger;
  status: ReconciliationStatus;
  issues: ReconciliationIssue[];
  candidateCount: number;
  processedCount: number;
  deferredCount: number;
  maxOrderLookupsPerRun: number;
}
