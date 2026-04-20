import { createId } from "../../shared/ids.js";
import type { ExecutionRepository, OperatorStateStore } from "../db/interfaces.js";
import type { ReconciliationSummary } from "./interfaces.js";

export class ReconciliationService {
  constructor(
    private readonly dependencies: {
      repositories: ExecutionRepository;
      operatorState: OperatorStateStore;
    },
  ) {}

  async run(exchangeAccountId: string): Promise<ReconciliationSummary> {
    const state = await this.dependencies.operatorState.getState();
    const openOrders = await this.dependencies.repositories.listActiveOrders(exchangeAccountId);
    const issues = openOrders.map((order) => ({
      code: order.status === "RECONCILIATION_REQUIRED" ? "ORDER_MARKED_FOR_RECOVERY" : "OPEN_ORDER_NEEDS_REVIEW",
      message:
        order.status === "RECONCILIATION_REQUIRED"
          ? `Order ${order.id} is already marked for recovery.`
          : `Order ${order.id} remains active and should be checked against exchange state.`,
    })) as ReconciliationSummary["issues"];

    const startedAt = new Date().toISOString();
    const summary: ReconciliationSummary = {
      status: issues.length === 0 && state.systemStatus !== "DEGRADED" ? "SUCCESS" : "DRIFT_DETECTED",
      issues,
    };

    await this.dependencies.repositories.saveReconciliationRun({
      id: createId("recon_run"),
      exchangeAccountId,
      status: summary.status,
      startedAt,
      completedAt: new Date().toISOString(),
      summaryJson: JSON.stringify(summary),
      errorMessage: null,
    });

    return summary;
  }
}
