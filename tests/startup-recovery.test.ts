import assert from "node:assert/strict";

import { applyStartupRecoveryPolicy, runStartupRecovery } from "../src/app/startup-recovery.js";
import { test } from "./harness.js";

test("startup recovery skips exchange-backed sweep when Upbit read credentials are unavailable", async () => {
  const result = await runStartupRecovery({
    exchangeAccountId: "primary",
    enabled: false,
    portfolioSyncService: {
      async run() {
        throw new Error("run should not be called when startup recovery is disabled");
      },
    },
  });

  assert.deepEqual(result, {
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
  });
});

test("startup recovery runs portfolio sync and reports drift metadata", async () => {
  const result = await runStartupRecovery({
    exchangeAccountId: "primary",
    enabled: true,
    portfolioSyncService: {
      async run(input) {
        assert.equal(input.exchangeAccountId, "primary");
        assert.equal(input.source, "STARTUP_RECOVERY");
        return {
          requestedAt: "2026-04-20T00:00:00.000Z",
          valuationSource: "public_ticker" as const,
          balanceSnapshot: {
            id: "balance-current",
            exchangeAccountId: "primary",
            capturedAt: "2026-04-20T00:00:00.000Z",
            source: "RECONCILIATION" as const,
            totalKrwValue: "10000000",
            balancesJson: "[]",
          },
          positionSnapshot: {
            id: "position-current",
            exchangeAccountId: "primary",
            capturedAt: "2026-04-20T00:00:00.000Z",
            source: "RECONCILIATION" as const,
            positionsJson: "[]",
          },
          previousBalanceSnapshot: {
            id: "balance-previous",
            exchangeAccountId: "primary",
            capturedAt: "2026-04-19T23:59:00.000Z",
            source: "RECONCILIATION" as const,
            totalKrwValue: "10000000",
            balancesJson: "[]",
          },
          previousPositionSnapshot: {
            id: "position-previous",
            exchangeAccountId: "primary",
            capturedAt: "2026-04-19T23:59:00.000Z",
            source: "RECONCILIATION" as const,
            positionsJson: "[]",
          },
          reconciliationSummary: {
            source: "STARTUP_RECOVERY" as const,
            status: "DRIFT_DETECTED" as const,
            issues: [
              {
                code: "BALANCE_DRIFT_DETECTED" as const,
                message: "Unexplained KRW delta.",
              },
            ],
            candidateCount: 1,
            processedCount: 1,
            deferredCount: 0,
            maxOrderLookupsPerRun: 10,
          },
        };
      },
    },
  });

  assert.deepEqual(result, {
    status: "COMPLETED",
    exchangeBacked: true,
    reconciliationStatus: "DRIFT_DETECTED",
    issueCount: 1,
    source: "STARTUP_RECOVERY",
    candidateCount: 1,
    processedCount: 1,
    deferredCount: 0,
    maxOrderLookupsPerRun: 10,
    portfolioBaselineAvailable: true,
    portfolioDriftDetected: true,
    detail: "Startup recovery sweep completed with reconciliation status DRIFT_DETECTED.",
  });
});

test("startup recovery captures portfolio sync failures without aborting startup", async () => {
  const result = await runStartupRecovery({
    exchangeAccountId: "primary",
    enabled: true,
    portfolioSyncService: {
      async run(input) {
        assert.equal(input.source, "STARTUP_RECOVERY");
        throw new Error("exchange lookup failed");
      },
    },
  });

  assert.deepEqual(result, {
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
    detail: "exchange lookup failed",
  });
});

test("startup recovery policy marks the system DEGRADED when portfolio drift remains unresolved", async () => {
  const transitions: string[] = [];
  const result = await applyStartupRecoveryPolicy({
    recovery: {
      status: "COMPLETED",
      exchangeBacked: true,
      reconciliationStatus: "DRIFT_DETECTED",
      issueCount: 1,
      source: "STARTUP_RECOVERY",
      candidateCount: 1,
      processedCount: 1,
      deferredCount: 0,
      maxOrderLookupsPerRun: 10,
      portfolioBaselineAvailable: true,
      portfolioDriftDetected: true,
      detail: "drift",
    },
    operatorState: {
      async getState() {
        return {
          id: "state-1",
          exchangeAccountId: "primary",
          executionMode: "DRY_RUN",
          liveExecutionGate: "DISABLED",
          systemStatus: "RUNNING",
          killSwitchActive: false,
          pauseReason: null,
          degradedReason: null,
          degradedAt: null,
          updatedAt: "2026-04-20T00:00:00.000Z",
        };
      },
      async markDegraded(reason) {
        transitions.push(`mark:${reason}`);
        return {
          id: "state-1",
          exchangeAccountId: "primary",
          executionMode: "DRY_RUN",
          liveExecutionGate: "DISABLED",
          systemStatus: "DEGRADED",
          killSwitchActive: false,
          pauseReason: null,
          degradedReason: reason ?? "startup_portfolio_drift_detected",
          degradedAt: "2026-04-20T00:00:10.000Z",
          updatedAt: "2026-04-20T00:00:10.000Z",
        };
      },
      async clearDegraded() {
        throw new Error("clearDegraded should not be called while drift is unresolved");
      },
    },
  });

  assert.deepEqual(transitions, ["mark:startup_portfolio_drift_detected"]);
  assert.deepEqual(result, {
    action: "MARKED_DEGRADED",
    finalSystemStatus: "DEGRADED",
    degradedReason: "startup_portfolio_drift_detected",
    degradedAt: "2026-04-20T00:00:10.000Z",
  });
});

test("startup recovery policy clears previous DEGRADED state once a clean baseline is observed", async () => {
  const transitions: string[] = [];
  const result = await applyStartupRecoveryPolicy({
    recovery: {
      status: "COMPLETED",
      exchangeBacked: true,
      reconciliationStatus: "SUCCESS",
      issueCount: 0,
      source: "STARTUP_RECOVERY",
      candidateCount: 0,
      processedCount: 0,
      deferredCount: 0,
      maxOrderLookupsPerRun: 10,
      portfolioBaselineAvailable: true,
      portfolioDriftDetected: false,
      detail: "clean",
    },
    operatorState: {
      async getState() {
        return {
          id: "state-2",
          exchangeAccountId: "primary",
          executionMode: "DRY_RUN",
          liveExecutionGate: "DISABLED",
          systemStatus: "DEGRADED",
          killSwitchActive: false,
          pauseReason: null,
          degradedReason: "startup_portfolio_drift_detected",
          degradedAt: "2026-04-19T23:00:00.000Z",
          updatedAt: "2026-04-19T23:00:00.000Z",
        };
      },
      async markDegraded() {
        throw new Error("markDegraded should not be called when startup recovery is clean");
      },
      async clearDegraded(reason) {
        transitions.push(`clear:${reason}`);
        return {
          id: "state-2",
          exchangeAccountId: "primary",
          executionMode: "DRY_RUN",
          liveExecutionGate: "DISABLED",
          systemStatus: "RUNNING",
          killSwitchActive: false,
          pauseReason: null,
          degradedReason: null,
          degradedAt: null,
          updatedAt: "2026-04-20T00:00:10.000Z",
        };
      },
    },
  });

  assert.deepEqual(transitions, ["clear:startup_recovery_clean"]);
  assert.deepEqual(result, {
    action: "CLEARED_DEGRADED",
    finalSystemStatus: "RUNNING",
    degradedReason: null,
    degradedAt: null,
  });
});
