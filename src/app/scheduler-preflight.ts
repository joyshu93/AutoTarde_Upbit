import type { AppConfig } from "./env.js";
import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  OrderRecord,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
  StrategySchedulerStartupPreflight,
  StrategySchedulerStartupPreflightCheck,
} from "../domain/types.js";
import type { ExecutionRepository } from "../modules/db/interfaces.js";

const BLOCKING_RECONCILIATION_ISSUE_CODES = new Set([
  "BALANCE_DRIFT_DETECTED",
  "POSITION_DRIFT_DETECTED",
  "ORDER_MARKED_FOR_RECOVERY",
  "ORDER_REFERENCE_MISSING",
  "ORDER_LOOKUP_TRANSIENT_FAILURE",
  "ORDER_LOOKUP_DEFERRED",
  "ORDER_HISTORY_LOOKUP_FAILED",
]);

export async function buildStrategySchedulerStartupPreflight(input: {
  config: AppConfig;
  exchangeAccountId: string;
  executionState: ExecutionStateRecord;
  repositories: Pick<
    ExecutionRepository,
    "getLatestBalanceSnapshot" | "getLatestPositionSnapshot" | "listActiveOrders" | "listReconciliationRuns"
  >;
  exchangeBackedReadEnabled: boolean;
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  checkedAt?: string;
}): Promise<StrategySchedulerStartupPreflight> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();

  if (!input.config.strategySchedulerEnabled) {
    return {
      checkedAt,
      scope: "DISABLED",
      status: "NOT_REQUIRED",
      detail: "Strategy scheduler is disabled.",
      checks: [],
    };
  }

  if (input.config.executionMode !== "LIVE") {
    return {
      checkedAt,
      scope: "DRY_RUN",
      status: "PASS",
      detail: "Live scheduler preflight is not required in DRY_RUN; scheduler remains on the dry-run adapter.",
      checks: [
        {
          name: "dry_run_boundary",
          status: "PASS",
          detail: "APP_EXECUTION_MODE is DRY_RUN, so scheduled strategy cycles cannot transmit live orders.",
        },
      ],
    };
  }

  const [latestBalanceSnapshot, latestPositionSnapshot, activeOrders, reconciliationRuns] = await Promise.all([
    input.repositories.getLatestBalanceSnapshot(input.exchangeAccountId),
    input.repositories.getLatestPositionSnapshot(input.exchangeAccountId),
    input.repositories.listActiveOrders(input.exchangeAccountId, undefined, 20),
    input.repositories.listReconciliationRuns(input.exchangeAccountId, 1),
  ]);
  const latestReconciliationRun = reconciliationRuns[0] ?? null;
  const checks = buildLiveSchedulerChecks({
    config: input.config,
    executionState: input.executionState,
    exchangeBackedReadEnabled: input.exchangeBackedReadEnabled,
    liveSendPath: input.liveSendPath,
    checkedAt,
    latestBalanceSnapshot,
    latestPositionSnapshot,
    latestReconciliationRun,
    activeOrders,
  });
  const status = checks.some((check) => check.status === "BLOCK")
    ? "BLOCK"
    : checks.some((check) => check.status === "WARN")
      ? "WARN"
      : "PASS";
  const blockingChecks = checks.filter((check) => check.status === "BLOCK");

  return {
    checkedAt,
    scope: "LIVE",
    status,
    detail: blockingChecks.length === 0
      ? "Live scheduler startup preflight passed."
      : `Live scheduler startup blocked by ${blockingChecks.map((check) => check.name).join(",")}.`,
    checks,
  };
}

function buildLiveSchedulerChecks(input: {
  config: AppConfig;
  executionState: ExecutionStateRecord;
  exchangeBackedReadEnabled: boolean;
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  checkedAt: string;
  latestBalanceSnapshot: BalanceSnapshotRecord | null;
  latestPositionSnapshot: PositionSnapshotRecord | null;
  latestReconciliationRun: ReconciliationRunRecord | null;
  activeOrders: OrderRecord[];
}): StrategySchedulerStartupPreflightCheck[] {
  const maxAgeMs = getSchedulerFreshnessThresholdMs(input.config);

  return [
    {
      name: "live_gate",
      status: input.config.liveExecutionGate === "ENABLED" ? "PASS" : "BLOCK",
      detail: input.config.liveExecutionGate === "ENABLED"
        ? "ENABLE_LIVE_ORDERS=true is configured."
        : "ENABLE_LIVE_ORDERS is not true.",
    },
    {
      name: "live_send_path",
      status: input.liveSendPath === "LIVE_ADAPTER" ? "PASS" : "BLOCK",
      detail: input.liveSendPath === "LIVE_ADAPTER"
        ? "Execution service is wired to the live exchange adapter."
        : "Execution service is still wired to the dry-run adapter.",
    },
    {
      name: "execution_state",
      status: isRunnableExecutionState(input.executionState) ? "PASS" : "BLOCK",
      detail: describeExecutionState(input.executionState),
    },
    {
      name: "upbit_read_credentials",
      status: input.exchangeBackedReadEnabled ? "PASS" : "BLOCK",
      detail: input.exchangeBackedReadEnabled
        ? "Upbit read credentials are configured."
        : "Upbit read credentials are required before live scheduler startup.",
    },
    {
      name: "balance_snapshot",
      status: describeTimestampFreshness(input.latestBalanceSnapshot?.capturedAt ?? null, input.checkedAt, maxAgeMs).status,
      detail: input.latestBalanceSnapshot
        ? `latest balance snapshot captured_at=${input.latestBalanceSnapshot.capturedAt} ` +
          describeTimestampFreshness(input.latestBalanceSnapshot.capturedAt, input.checkedAt, maxAgeMs).detail
        : "No balance snapshot is stored.",
    },
    {
      name: "position_snapshot",
      status: describeTimestampFreshness(input.latestPositionSnapshot?.capturedAt ?? null, input.checkedAt, maxAgeMs).status,
      detail: input.latestPositionSnapshot
        ? `latest position snapshot captured_at=${input.latestPositionSnapshot.capturedAt} ` +
          describeTimestampFreshness(input.latestPositionSnapshot.capturedAt, input.checkedAt, maxAgeMs).detail
        : "No position snapshot is stored.",
    },
    describeLatestReconciliation(input.latestReconciliationRun, input.checkedAt, maxAgeMs),
    {
      name: "active_orders",
      status: input.activeOrders.length === 0 ? "PASS" : "BLOCK",
      detail: input.activeOrders.length === 0
        ? "No active or reconciliation-required orders are stored."
        : `${input.activeOrders.length} active or reconciliation-required order(s) must be resolved first.`,
    },
  ];
}

function getSchedulerFreshnessThresholdMs(config: AppConfig): number {
  return Math.min(config.strategySchedulerBtcIntervalMs, config.strategySchedulerEthIntervalMs);
}

function describeTimestampFreshness(
  timestamp: string | null,
  checkedAt: string,
  maxAgeMs: number,
): { status: "PASS" | "BLOCK"; detail: string } {
  if (timestamp === null) {
    return {
      status: "BLOCK",
      detail: "missing timestamp",
    };
  }

  const ageMs = Date.parse(checkedAt) - Date.parse(timestamp);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return {
      status: "BLOCK",
      detail: "timestamp is not comparable to preflight time",
    };
  }

  return ageMs <= maxAgeMs
    ? {
        status: "PASS",
        detail: `fresh_age_ms=${ageMs} max_age_ms=${maxAgeMs}`,
      }
    : {
        status: "BLOCK",
        detail: `stale_age_ms=${ageMs} max_age_ms=${maxAgeMs}`,
      };
}

function isRunnableExecutionState(state: ExecutionStateRecord): boolean {
  return state.executionMode === "LIVE" &&
    state.liveExecutionGate === "ENABLED" &&
    state.systemStatus === "RUNNING" &&
    !state.killSwitchActive &&
    state.degradedReason === null;
}

function describeExecutionState(state: ExecutionStateRecord): string {
  const blockers: string[] = [];

  if (state.executionMode !== "LIVE") {
    blockers.push("execution_mode_not_live");
  }

  if (state.liveExecutionGate !== "ENABLED") {
    blockers.push("live_gate_disabled");
  }

  if (state.systemStatus !== "RUNNING") {
    blockers.push(`system_status_${state.systemStatus.toLowerCase()}`);
  }

  if (state.killSwitchActive) {
    blockers.push("kill_switch_active");
  }

  if (state.degradedReason !== null) {
    blockers.push(`degraded:${state.degradedReason}`);
  }

  return blockers.length === 0
    ? "Execution state is live, running, not degraded, and kill switch is off."
    : `Execution state blocks live scheduler startup: ${blockers.join(",")}.`;
}

function describeLatestReconciliation(
  run: ReconciliationRunRecord | null,
  checkedAt: string,
  maxAgeMs: number,
): StrategySchedulerStartupPreflightCheck {
  if (!run) {
    return {
      name: "latest_reconciliation",
      status: "BLOCK",
      detail: "No reconciliation run is stored.",
    };
  }

  const freshness = describeTimestampFreshness(run.completedAt, checkedAt, maxAgeMs);
  if (freshness.status === "BLOCK") {
    return {
      name: "latest_reconciliation",
      status: "BLOCK",
      detail:
        `latest reconciliation status=${run.status} completed_at=${run.completedAt ?? "none"} ${freshness.detail}`,
    };
  }

  if (run.status === "SUCCESS") {
    return {
      name: "latest_reconciliation",
      status: "PASS",
      detail: `latest reconciliation status=${run.status} completed_at=${run.completedAt ?? "none"} ${freshness.detail}`,
    };
  }

  const issueCodes = parseReconciliationIssueCodes(run.summaryJson);
  const blockingIssueCodes = issueCodes.filter((code) => BLOCKING_RECONCILIATION_ISSUE_CODES.has(code));
  if (blockingIssueCodes.length > 0) {
    return {
      name: "latest_reconciliation",
      status: "BLOCK",
      detail:
        `latest reconciliation status=${run.status} completed_at=${run.completedAt ?? "none"} ` +
        `${freshness.detail} blocking_issue_codes=${blockingIssueCodes.join(",")} issue_codes=${formatIssueCodes(issueCodes)}`,
    };
  }

  return {
    name: "latest_reconciliation",
    status: "WARN",
    detail:
      `latest reconciliation status=${run.status} completed_at=${run.completedAt ?? "none"} ` +
      `${freshness.detail} non_blocking_issue_codes=${formatIssueCodes(issueCodes)}`,
  };
}

function parseReconciliationIssueCodes(rawJson: string): string[] {
  try {
    const parsed = JSON.parse(rawJson) as { issues?: unknown };
    if (!Array.isArray(parsed.issues)) {
      return [];
    }

    return parsed.issues
      .map((issue) =>
        issue && typeof issue === "object" && "code" in issue && typeof issue.code === "string"
          ? issue.code
          : null)
      .filter((code): code is string => code !== null);
  } catch {
    return [];
  }
}

function formatIssueCodes(issueCodes: string[]): string {
  return issueCodes.length === 0 ? "none" : issueCodes.join(",");
}
