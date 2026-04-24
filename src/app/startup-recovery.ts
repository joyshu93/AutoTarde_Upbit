import type { ExecutionStateRecord } from "../domain/types.js";
import type { OperatorStateStore } from "../modules/db/interfaces.js";
import type { ReconciliationTrigger } from "../modules/reconciliation/interfaces.js";
import type { PortfolioSyncRunResult, PortfolioSyncService } from "../modules/reconciliation/portfolio-sync-service.js";

const STARTUP_PORTFOLIO_DRIFT_CODES = new Set<string>([
  "BALANCE_DRIFT_DETECTED",
  "POSITION_DRIFT_DETECTED",
]);

export interface StartupRecoveryResult {
  status: "COMPLETED" | "FAILED" | "SKIPPED";
  exchangeBacked: boolean;
  reconciliationStatus: PortfolioSyncRunResult["reconciliationSummary"]["status"] | null;
  issueCount: number;
  source: ReconciliationTrigger;
  candidateCount: number;
  processedCount: number;
  deferredCount: number;
  maxOrderLookupsPerRun: number;
  portfolioBaselineAvailable: boolean;
  portfolioDriftDetected: boolean;
  detail: string;
}

export interface StartupRecoveryPolicyResult {
  action: "NONE" | "MARKED_DEGRADED" | "CLEARED_DEGRADED";
  finalSystemStatus: ExecutionStateRecord["systemStatus"];
  degradedReason: string | null;
  degradedAt: string | null;
}

export async function runStartupRecovery(input: {
  exchangeAccountId: string;
  enabled: boolean;
  portfolioSyncService: Pick<PortfolioSyncService, "run">;
}): Promise<StartupRecoveryResult> {
  if (!input.enabled) {
    return {
      status: "SKIPPED",
      exchangeBacked: false,
      reconciliationStatus: null,
      issueCount: 0,
      source: "STARTUP_RECOVERY",
      candidateCount: 0,
      processedCount: 0,
      deferredCount: 0,
      maxOrderLookupsPerRun: 0,
      portfolioBaselineAvailable: false,
      portfolioDriftDetected: false,
      detail: "Exchange-backed startup recovery is skipped because Upbit read credentials are not configured.",
    };
  }

  try {
    const result = await input.portfolioSyncService.run({
      exchangeAccountId: input.exchangeAccountId,
      source: "STARTUP_RECOVERY",
    });
    const portfolioBaselineAvailable =
      result.previousBalanceSnapshot !== null && result.previousPositionSnapshot !== null;
    const portfolioDriftDetected = result.reconciliationSummary.issues.some((issue) =>
      STARTUP_PORTFOLIO_DRIFT_CODES.has(issue.code)
    );

    return {
      status: "COMPLETED",
      exchangeBacked: true,
      reconciliationStatus: result.reconciliationSummary.status,
      issueCount: result.reconciliationSummary.issues.length,
      source: result.reconciliationSummary.source,
      candidateCount: result.reconciliationSummary.candidateCount,
      processedCount: result.reconciliationSummary.processedCount,
      deferredCount: result.reconciliationSummary.deferredCount,
      maxOrderLookupsPerRun: result.reconciliationSummary.maxOrderLookupsPerRun,
      portfolioBaselineAvailable,
      portfolioDriftDetected,
      detail: `Startup recovery sweep completed with reconciliation status ${result.reconciliationSummary.status}.`,
    };
  } catch (error) {
    return {
      status: "FAILED",
      exchangeBacked: true,
      reconciliationStatus: null,
      issueCount: 0,
      source: "STARTUP_RECOVERY",
      candidateCount: 0,
      processedCount: 0,
      deferredCount: 0,
      maxOrderLookupsPerRun: 0,
      portfolioBaselineAvailable: false,
      portfolioDriftDetected: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function applyStartupRecoveryPolicy(input: {
  operatorState: Pick<OperatorStateStore, "getState" | "markDegraded" | "clearDegraded">;
  recovery: StartupRecoveryResult;
}): Promise<StartupRecoveryPolicyResult> {
  if (input.recovery.status !== "COMPLETED") {
    const state = await input.operatorState.getState();
    return {
      action: "NONE",
      finalSystemStatus: state.systemStatus,
      degradedReason: state.degradedReason,
      degradedAt: state.degradedAt,
    };
  }

  if (input.recovery.portfolioDriftDetected) {
    const state = await input.operatorState.markDegraded("startup_portfolio_drift_detected");
    return {
      action: state.systemStatus === "DEGRADED" ? "MARKED_DEGRADED" : "NONE",
      finalSystemStatus: state.systemStatus,
      degradedReason: state.degradedReason,
      degradedAt: state.degradedAt,
    };
  }

  if (input.recovery.portfolioBaselineAvailable) {
    const before = await input.operatorState.getState();
    const state = await input.operatorState.clearDegraded("startup_recovery_clean");
    return {
      action: before.degradedReason || before.degradedAt ? "CLEARED_DEGRADED" : "NONE",
      finalSystemStatus: state.systemStatus,
      degradedReason: state.degradedReason,
      degradedAt: state.degradedAt,
    };
  }

  const state = await input.operatorState.getState();
  return {
    action: "NONE",
    finalSystemStatus: state.systemStatus,
    degradedReason: state.degradedReason,
    degradedAt: state.degradedAt,
  };
}
