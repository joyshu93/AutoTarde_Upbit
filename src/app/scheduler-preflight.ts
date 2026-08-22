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
import { parseCandidatePilotTimestamp } from "../modules/db/pilot-interfaces.js";

const BLOCKING_RECONCILIATION_ISSUE_CODES = new Set([
  "BALANCE_DRIFT_DETECTED",
  "POSITION_DRIFT_DETECTED",
  "ORDER_MARKED_FOR_RECOVERY",
  "ORDER_REFERENCE_MISSING",
  "ORDER_LOOKUP_TRANSIENT_FAILURE",
  "ORDER_LOOKUP_DEFERRED",
  "ORDER_HISTORY_LOOKUP_FAILED",
]);

export interface LiveStrategyRunPreflightEvaluation {
  status: "PASS" | "WARN" | "BLOCK";
  checks: StrategySchedulerStartupPreflightCheck[];
}

export function evaluateLiveStrategyRunPreflight(input: {
  config: Pick<AppConfig, "strategySchedulerBtcIntervalMs" | "strategySchedulerEthIntervalMs" | "liveExecutionGate">;
  executionState: ExecutionStateRecord;
  exchangeBackedReadEnabled: boolean;
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  checkedAt: string;
  balanceSnapshot: BalanceSnapshotRecord | null;
  positionSnapshot: PositionSnapshotRecord | null;
  reconciliationRun: ReconciliationRunRecord | null;
  activeOrders: readonly OrderRecord[];
}): LiveStrategyRunPreflightEvaluation {
  const checks = buildLiveSchedulerChecks(input);
  return {
    status: checks.some((check) => check.status === "BLOCK")
      ? "BLOCK"
      : checks.some((check) => check.status === "WARN")
        ? "WARN"
        : "PASS",
    checks,
  };
}

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
  const evaluation = evaluateLiveStrategyRunPreflight({
    config: input.config,
    executionState: input.executionState,
    exchangeBackedReadEnabled: input.exchangeBackedReadEnabled,
    liveSendPath: input.liveSendPath,
    checkedAt,
    balanceSnapshot: latestBalanceSnapshot,
    positionSnapshot: latestPositionSnapshot,
    reconciliationRun: latestReconciliationRun,
    activeOrders,
  });
  const blockingChecks = evaluation.checks.filter((check) => check.status === "BLOCK");

  return {
    checkedAt,
    scope: "LIVE",
    status: evaluation.status,
    detail: blockingChecks.length === 0
      ? "Live scheduler startup preflight passed."
      : `Live scheduler startup blocked by ${blockingChecks.map((check) => check.name).join(",")}.`,
    checks: evaluation.checks,
  };
}

export async function buildManualStrategyRunPreflight(input: {
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

  if (input.config.executionMode !== "LIVE") {
    return {
      checkedAt,
      scope: "DRY_RUN",
      status: "PASS",
      detail: "Live manual run preflight is not required in DRY_RUN; /run remains on the dry-run adapter.",
      checks: [
        {
          name: "dry_run_boundary",
          status: "PASS",
          detail: "APP_EXECUTION_MODE is DRY_RUN, so manual strategy runs cannot transmit live orders.",
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
  const evaluation = evaluateLiveStrategyRunPreflight({
    config: input.config,
    executionState: input.executionState,
    exchangeBackedReadEnabled: input.exchangeBackedReadEnabled,
    liveSendPath: input.liveSendPath,
    checkedAt,
    balanceSnapshot: latestBalanceSnapshot,
    positionSnapshot: latestPositionSnapshot,
    reconciliationRun: latestReconciliationRun,
    activeOrders,
  });
  const blockingChecks = evaluation.checks.filter((check) => check.status === "BLOCK");

  return {
    checkedAt,
    scope: "LIVE",
    status: evaluation.status,
    detail: blockingChecks.length === 0
      ? "Live manual /run preflight passed."
      : `Live manual /run blocked by ${blockingChecks.map((check) => check.name).join(",")}.`,
    checks: evaluation.checks,
  };
}

function buildLiveSchedulerChecks(input: {
  config: Pick<AppConfig, "strategySchedulerBtcIntervalMs" | "strategySchedulerEthIntervalMs" | "liveExecutionGate">;
  executionState: ExecutionStateRecord;
  exchangeBackedReadEnabled: boolean;
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  checkedAt: string;
  balanceSnapshot: BalanceSnapshotRecord | null;
  positionSnapshot: PositionSnapshotRecord | null;
  reconciliationRun: ReconciliationRunRecord | null;
  activeOrders: readonly OrderRecord[];
}): StrategySchedulerStartupPreflightCheck[] {
  const maxAgeMs = getStrategyRunFreshnessThresholdMs(input.config);

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
      status: describeTimestampFreshness(input.balanceSnapshot?.capturedAt ?? null, input.checkedAt, maxAgeMs).status,
      detail: input.balanceSnapshot
        ? `latest balance snapshot captured_at=${input.balanceSnapshot.capturedAt} ` +
          describeTimestampFreshness(input.balanceSnapshot.capturedAt, input.checkedAt, maxAgeMs).detail
        : "No balance snapshot is stored.",
    },
    {
      name: "position_snapshot",
      status: describeTimestampFreshness(input.positionSnapshot?.capturedAt ?? null, input.checkedAt, maxAgeMs).status,
      detail: input.positionSnapshot
        ? `latest position snapshot captured_at=${input.positionSnapshot.capturedAt} ` +
          describeTimestampFreshness(input.positionSnapshot.capturedAt, input.checkedAt, maxAgeMs).detail
        : "No position snapshot is stored.",
    },
    describeLatestReconciliation(input.reconciliationRun, input.checkedAt, maxAgeMs),
    {
      name: "active_orders",
      status: input.activeOrders.length === 0 ? "PASS" : "BLOCK",
      detail: input.activeOrders.length === 0
        ? "No active or reconciliation-required orders are stored."
        : `${input.activeOrders.length} active or reconciliation-required order(s) must be resolved first.`,
    },
  ];
}

export function getStrategyRunFreshnessThresholdMs(
  config: Pick<AppConfig, "strategySchedulerBtcIntervalMs" | "strategySchedulerEthIntervalMs">,
): number {
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

  let ageNs: bigint;
  try {
    ageNs = parseCandidatePilotTimestamp(checkedAt, "strategy run preflight checkedAt") -
      parseCandidatePilotTimestamp(timestamp, "strategy run preflight evidence timestamp");
  } catch {
    return {
      status: "BLOCK",
      detail: "timestamp is not comparable to preflight time",
    };
  }

  if (ageNs < 0n) {
    return {
      status: "BLOCK",
      detail: "timestamp is not comparable to preflight time",
    };
  }

  const maxAgeNs = BigInt(maxAgeMs) * 1_000_000n;
  const ageMs = Number(ageNs / 1_000_000n);

  return ageNs <= maxAgeNs
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

  if (run.status !== "DRIFT_DETECTED") {
    return {
      name: "latest_reconciliation",
      status: "BLOCK",
      detail: `latest reconciliation status=${run.status} completed_at=${run.completedAt ?? "none"} ${freshness.detail} is not eligible for live preflight.`,
    };
  }

  const issueEvidence = parseReconciliationIssueCodes(run.summaryJson);
  if (issueEvidence === null) {
    return {
      name: "latest_reconciliation",
      status: "BLOCK",
      detail:
        `latest reconciliation status=${run.status} completed_at=${run.completedAt ?? "none"} ` +
        `${freshness.detail} issue_evidence_malformed=true`,
    };
  }
  const issueCodes = issueEvidence;
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

function parseReconciliationIssueCodes(rawJson: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Object.getPrototypeOf(parsed) !== Object.prototype) {
    return null;
  }
  const summaryDescriptors = Object.getOwnPropertyDescriptors(parsed);
  const issuesDescriptor = summaryDescriptors.issues;
  if (issuesDescriptor === undefined || issuesDescriptor.enumerable !== true || !("value" in issuesDescriptor) || !Array.isArray(issuesDescriptor.value)) {
    return null;
  }

  const issueCodes: string[] = [];
  for (let index = 0; index < issuesDescriptor.value.length; index += 1) {
    const issue = issuesDescriptor.value[index];
    if (typeof issue !== "object" || issue === null || Object.getPrototypeOf(issue) !== Object.prototype) {
      return null;
    }
    const issueDescriptors = Object.getOwnPropertyDescriptors(issue);
    const codeDescriptor = issueDescriptors.code;
    if (
      codeDescriptor === undefined ||
      codeDescriptor.enumerable !== true ||
      !("value" in codeDescriptor) ||
      typeof codeDescriptor.value !== "string" ||
      codeDescriptor.value.trim().length === 0
    ) {
      return null;
    }
    issueCodes.push(codeDescriptor.value);
  }

  return issueCodes;
}

function formatIssueCodes(issueCodes: string[]): string {
  return issueCodes.length === 0 ? "none" : issueCodes.join(",");
}
