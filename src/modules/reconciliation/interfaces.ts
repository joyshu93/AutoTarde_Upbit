import type { ReconciliationStatus } from "../../domain/types.js";

export interface ReconciliationIssue {
  code: "OPEN_ORDER_NEEDS_REVIEW" | "ORDER_MARKED_FOR_RECOVERY";
  message: string;
}

export interface ReconciliationSummary {
  status: ReconciliationStatus;
  issues: ReconciliationIssue[];
}
