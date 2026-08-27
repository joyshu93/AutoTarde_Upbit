import { pathToFileURL } from "node:url";

import type { AppServices } from "../app/create-app.js";
import type { AppConfig } from "../app/env.js";
import {
  createRuntimeShutdown,
  runRuntimeStartupGate,
  type RuntimeStopSummary,
} from "../app/runtime-lifecycle.js";
import type { ExecutionStateRecord, ReconciliationRunRecord } from "../domain/types.js";
import { detectExecutionStateSeedMismatches } from "../modules/db/interfaces.js";
import { parseCandidatePilotTimestamp } from "../modules/db/pilot-interfaces.js";
import { openLiveReadOnlyContext } from "./live-readonly-context.js";

type LiveReadinessSmokeStatus = "PASS" | "WARN" | "BLOCK";
type NonMutationBoundary = Record<
  | "orders"
  | "strategy"
  | "sync"
  | "scheduler"
  | "telegramPolling"
  | "exchangeProbe"
  | "notificationDelivery",
  false
> & Readonly<{
  databaseWrites: false;
  migrations: false;
  bootstrap: false;
  candidateInitialization: false;
}>;

const BLOCKING_RECONCILIATION_ISSUE_CODES = new Set([
  "BALANCE_DRIFT_DETECTED",
  "POSITION_DRIFT_DETECTED",
  "ORDER_MARKED_FOR_RECOVERY",
  "ORDER_REFERENCE_MISSING",
  "ORDER_LOOKUP_TRANSIENT_FAILURE",
  "ORDER_LOOKUP_DEFERRED",
  "ORDER_HISTORY_LOOKUP_FAILED",
]);

const READ_ONLY_DATA_SOURCES = [
  "runtime_config",
  "execution_state",
  "orders",
  "balance_snapshots",
  "position_snapshots",
  "reconciliation_runs",
] as const;

export interface LiveReadinessSmokeCheck {
  readonly name: string;
  readonly status: LiveReadinessSmokeStatus;
  readonly detail: string;
}

export interface LiveReadinessSmokeResult {
  readonly service: string;
  readonly status: LiveReadinessSmokeStatus;
  readonly executionMode: AppConfig["executionMode"];
  readonly liveExecutionGate: AppConfig["liveExecutionGate"];
  readonly liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  readonly databasePath: string;
  readonly exchangeBackedReadEnabled: boolean;
  readonly schedulerEnabled: boolean;
  readonly schedulerRunOnStart: boolean;
  readonly telegramInboundPollingEnabled: boolean;
  readonly telegramInboundPollingConfigured: boolean;
  readonly telegramDeliveryEnabled: boolean;
  readonly telegramDeliveryConfigured: boolean;
  readonly telegramBotTokenConfigured: boolean;
  readonly telegramOperatorChatIdConfigured: boolean;
  readonly systemStatus: ExecutionStateRecord["systemStatus"];
  readonly killSwitchActive: boolean;
  readonly degradedReason: string | null;
  readonly operatorStateUpdatedAt: string;
  readonly nonMutationBoundary: NonMutationBoundary;
  readonly orderTransmissionAttempted: false;
  readonly strategyRunAttempted: false;
  readonly syncAttempted: false;
  readonly schedulerStarted: false;
  readonly telegramPollingStarted: false;
  readonly exchangeProbeAttempted: false;
  readonly notificationDeliveryAttempted: false;
  readonly readOnlyDataSources: typeof READ_ONLY_DATA_SOURCES;
  readonly activeOrderCount: number;
  readonly latestBalanceSnapshotAt: string | null;
  readonly latestPositionSnapshotAt: string | null;
  readonly latestReconciliationStatus: string | null;
  readonly latestReconciliationCompletedAt: string | null;
  readonly latestReconciliationIssueCodes: string[];
  readonly latestReconciliationBlockingIssueCodes: string[];
  readonly seedMismatches: string[];
  readonly blockingCheckNames: string[];
  readonly warningCheckNames: string[];
  readonly nextActions: string[];
  readonly checks: LiveReadinessSmokeCheck[];
}

export async function runLiveReadinessSmoke(): Promise<LiveReadinessSmokeResult> {
  return runReadOnlyLiveReadinessSmoke();
}

async function runReadOnlyLiveReadinessSmoke(): Promise<LiveReadinessSmokeResult> {
  const context = openLiveReadOnlyContext();
  try {
    const [executionState, activeOrders, latestBalanceSnapshot, latestPositionSnapshot, reconciliationRuns] =
      await Promise.all([
        context.operatorState.getState(),
        context.repositories.listActiveOrders("primary", undefined, 20),
        context.repositories.getLatestBalanceSnapshot("primary"),
        context.repositories.getLatestPositionSnapshot("primary"),
        context.repositories.listReconciliationRuns("primary", 1),
      ]);
    const latestReconciliationRun = reconciliationRuns[0] ?? null;
    const latestReconciliationIssueCodes = parseReconciliationIssueCodes(latestReconciliationRun?.summaryJson ?? null);
    const latestReconciliationBlockingIssueCodes = latestReconciliationIssueCodes.filter((code) =>
      BLOCKING_RECONCILIATION_ISSUE_CODES.has(code)
    );
    const checkedAt = new Date().toISOString();
    const seedMismatches = detectExecutionStateSeedMismatches(executionState, {
      executionMode: context.config.executionMode,
      liveExecutionGate: context.config.liveExecutionGate,
      killSwitchActive: context.config.globalKillSwitch,
    });
    const checks = buildLiveReadinessSmokeChecks({
      app: context,
      executionState,
      seedMismatches,
      activeOrderCount: activeOrders.length,
      latestBalanceSnapshotAt: latestBalanceSnapshot?.capturedAt ?? null,
      latestPositionSnapshotAt: latestPositionSnapshot?.capturedAt ?? null,
      latestReconciliationRun,
      latestReconciliationIssueCodes,
      latestReconciliationBlockingIssueCodes,
      checkedAt,
    });
    return {
      service: context.config.serviceName,
      status: summarizeLiveReadinessSmokeStatus(checks),
      executionMode: context.config.executionMode,
      liveExecutionGate: context.config.liveExecutionGate,
      liveSendPath: context.liveSendPath,
      databasePath: context.config.databasePath,
      exchangeBackedReadEnabled: context.exchangeBackedReadEnabled,
      schedulerEnabled: context.config.strategySchedulerEnabled,
      schedulerRunOnStart: context.config.strategySchedulerRunOnStart,
      telegramInboundPollingEnabled: context.config.telegramInboundPollingEnabled,
      telegramInboundPollingConfigured: context.telegramInboundPollingConfigured,
      telegramDeliveryEnabled: context.config.telegramDeliveryEnabled,
      telegramDeliveryConfigured: context.telegramDeliveryConfigured,
      telegramBotTokenConfigured: Boolean(context.config.telegramBotToken),
      telegramOperatorChatIdConfigured: Boolean(context.config.telegramOperatorChatId),
      systemStatus: executionState.systemStatus,
      killSwitchActive: executionState.killSwitchActive,
      degradedReason: executionState.degradedReason,
      operatorStateUpdatedAt: executionState.updatedAt,
      nonMutationBoundary: createNonMutationBoundary(),
      orderTransmissionAttempted: false,
      strategyRunAttempted: false,
      syncAttempted: false,
      schedulerStarted: false,
      telegramPollingStarted: false,
      exchangeProbeAttempted: false,
      notificationDeliveryAttempted: false,
      readOnlyDataSources: READ_ONLY_DATA_SOURCES,
      activeOrderCount: activeOrders.length,
      latestBalanceSnapshotAt: latestBalanceSnapshot?.capturedAt ?? null,
      latestPositionSnapshotAt: latestPositionSnapshot?.capturedAt ?? null,
      latestReconciliationStatus: latestReconciliationRun?.status ?? null,
      latestReconciliationCompletedAt: latestReconciliationRun?.completedAt ?? null,
      latestReconciliationIssueCodes,
      latestReconciliationBlockingIssueCodes,
      seedMismatches,
      blockingCheckNames: getCheckNamesByStatus(checks, "BLOCK"),
      warningCheckNames: getCheckNamesByStatus(checks, "WARN"),
      nextActions: buildLiveReadinessNextActions(checks),
      checks,
    };
  } finally {
    context.close();
  }
}

export async function runLiveReadinessSmokeWithApplicationForTest(
  createApplication: () => AppServices,
): Promise<LiveReadinessSmokeResult> {
  const app = createApplication();
  const runtimeShutdown = createRuntimeShutdown(app);
  let primaryFailure = false;

  try {
    return await runRuntimeStartupGate({
      initializer: app.candidatePilotInitializer,
      shutdown: runtimeShutdown,
      continueStartup: async () => {
        const [executionState, activeOrders, latestBalanceSnapshot, latestPositionSnapshot, reconciliationRuns] =
          await Promise.all([
            app.operatorState.getState(),
            app.repositories.listActiveOrders("primary", undefined, 20),
            app.repositories.getLatestBalanceSnapshot("primary"),
            app.repositories.getLatestPositionSnapshot("primary"),
            app.repositories.listReconciliationRuns("primary", 1),
          ]);
        const latestReconciliationRun = reconciliationRuns[0] ?? null;
        const latestReconciliationIssueCodes = parseReconciliationIssueCodes(
          latestReconciliationRun?.summaryJson ?? null,
        );
        const latestReconciliationBlockingIssueCodes = latestReconciliationIssueCodes.filter((code) =>
          BLOCKING_RECONCILIATION_ISSUE_CODES.has(code)
        );
        const checkedAt = new Date().toISOString();
        const seedMismatches = detectExecutionStateSeedMismatches(executionState, {
          executionMode: app.config.executionMode,
          liveExecutionGate: app.config.liveExecutionGate,
          killSwitchActive: app.config.globalKillSwitch,
        });
        const checks = buildLiveReadinessSmokeChecks({
          app,
          executionState,
          seedMismatches,
          activeOrderCount: activeOrders.length,
          latestBalanceSnapshotAt: latestBalanceSnapshot?.capturedAt ?? null,
          latestPositionSnapshotAt: latestPositionSnapshot?.capturedAt ?? null,
          latestReconciliationRun,
          latestReconciliationIssueCodes,
          latestReconciliationBlockingIssueCodes,
          checkedAt,
        });

        return {
          service: app.config.serviceName,
          status: summarizeLiveReadinessSmokeStatus(checks),
          executionMode: app.config.executionMode,
          liveExecutionGate: app.config.liveExecutionGate,
          liveSendPath: app.liveSendPath,
          databasePath: app.config.databasePath,
          exchangeBackedReadEnabled: app.exchangeBackedReadEnabled,
          schedulerEnabled: app.config.strategySchedulerEnabled,
          schedulerRunOnStart: app.config.strategySchedulerRunOnStart,
          telegramInboundPollingEnabled: app.config.telegramInboundPollingEnabled,
          telegramInboundPollingConfigured: app.telegramInboundPolling.isConfigured(),
          telegramDeliveryEnabled: app.config.telegramDeliveryEnabled,
          telegramDeliveryConfigured: app.notificationDelivery.isConfigured(),
          telegramBotTokenConfigured: Boolean(app.config.telegramBotToken),
          telegramOperatorChatIdConfigured: Boolean(app.config.telegramOperatorChatId),
          systemStatus: executionState.systemStatus,
          killSwitchActive: executionState.killSwitchActive,
          degradedReason: executionState.degradedReason,
          operatorStateUpdatedAt: executionState.updatedAt,
          nonMutationBoundary: createNonMutationBoundary(),
          orderTransmissionAttempted: false,
          strategyRunAttempted: false,
          syncAttempted: false,
          schedulerStarted: false,
          telegramPollingStarted: false,
          exchangeProbeAttempted: false,
          notificationDeliveryAttempted: false,
          readOnlyDataSources: READ_ONLY_DATA_SOURCES,
          activeOrderCount: activeOrders.length,
          latestBalanceSnapshotAt: latestBalanceSnapshot?.capturedAt ?? null,
          latestPositionSnapshotAt: latestPositionSnapshot?.capturedAt ?? null,
          latestReconciliationStatus: latestReconciliationRun?.status ?? null,
          latestReconciliationCompletedAt: latestReconciliationRun?.completedAt ?? null,
          latestReconciliationIssueCodes,
          latestReconciliationBlockingIssueCodes,
          seedMismatches,
          blockingCheckNames: getCheckNamesByStatus(checks, "BLOCK"),
          warningCheckNames: getCheckNamesByStatus(checks, "WARN"),
          nextActions: buildLiveReadinessNextActions(checks),
          checks,
        };
      },
    });
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    const shutdownSummary = runtimeShutdown();
    if (!primaryFailure && shutdownSummary.status === "PARTIAL_FAILURE") {
      throw createLiveSmokeCleanupError(shutdownSummary);
    }
  }
}

function createLiveSmokeCleanupError(summary: RuntimeStopSummary): Error {
  const failures = summary.steps
    .filter((step) => step.status === "FAILED")
    .map((step) => `${step.name}: ${step.errorMessage ?? "unknown error"}`);
  return new Error(`Live smoke cleanup failed: ${failures.join("; ")}`);
}

export function buildLiveReadinessSmokeChecks(input: {
  app: Pick<AppServices, "config" | "exchangeBackedReadEnabled" | "liveSendPath">;
  executionState: ExecutionStateRecord;
  seedMismatches: string[];
  activeOrderCount: number;
  latestBalanceSnapshotAt: string | null;
  latestPositionSnapshotAt: string | null;
  latestReconciliationRun: Pick<ReconciliationRunRecord, "status" | "completedAt"> | null;
  latestReconciliationIssueCodes: string[];
  latestReconciliationBlockingIssueCodes: string[];
  checkedAt: string;
}): LiveReadinessSmokeCheck[] {
  const freshnessThresholdMs = getLiveReadinessFreshnessThresholdMs(input.app.config);
  return [
    {
      name: "non_mutation_boundary",
      status: "PASS",
      detail:
        "This smoke creates no orders, runs no strategy cycle, starts no scheduler, starts no Telegram polling, and calls no exchange endpoint.",
    },
    {
      name: "live_mode",
      status: input.app.config.executionMode === "LIVE" ? "PASS" : "BLOCK",
      detail: input.app.config.executionMode === "LIVE"
        ? "APP_EXECUTION_MODE resolves to LIVE."
        : "APP_EXECUTION_MODE must resolve to LIVE for live readiness.",
    },
    {
      name: "live_gate",
      status: input.app.config.liveExecutionGate === "ENABLED" ? "PASS" : "BLOCK",
      detail: input.app.config.liveExecutionGate === "ENABLED"
        ? "ENABLE_LIVE_ORDERS=true is configured."
        : "ENABLE_LIVE_ORDERS must be true for live readiness.",
    },
    {
      name: "upbit_credentials",
      status: input.app.exchangeBackedReadEnabled ? "PASS" : "BLOCK",
      detail: input.app.exchangeBackedReadEnabled
        ? "Upbit credentials are configured. Secret values are not rendered."
        : "UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY must both be configured.",
    },
    {
      name: "live_send_path",
      status: input.app.liveSendPath === "LIVE_ADAPTER" ? "PASS" : "BLOCK",
      detail: input.app.liveSendPath === "LIVE_ADAPTER"
        ? "Execution service would use the live Upbit adapter if a later eligible strategy run submits an order."
        : "Execution service is still wired to the dry-run adapter.",
    },
    {
      name: "scheduler_disabled_for_validation",
      status: input.app.config.strategySchedulerEnabled ? "BLOCK" : "PASS",
      detail: input.app.config.strategySchedulerEnabled
        ? "STRATEGY_SCHEDULER_ENABLED must be false for this live readiness smoke."
        : "Strategy scheduler is disabled for manual live validation.",
    },
    {
      name: "scheduler_run_on_start_disabled",
      status: input.app.config.strategySchedulerRunOnStart ? "BLOCK" : "PASS",
      detail: input.app.config.strategySchedulerRunOnStart
        ? "STRATEGY_SCHEDULER_RUN_ON_START must be false for this live readiness smoke."
        : "No immediate scheduler tick is configured.",
    },
    {
      name: "execution_state",
      status: isLiveRunnableExecutionState(input.executionState) ? "PASS" : "BLOCK",
      detail: describeExecutionState(input.executionState),
    },
    {
      name: "execution_state_seed",
      status: input.seedMismatches.length === 0 ? "PASS" : "BLOCK",
      detail: input.seedMismatches.length === 0
        ? "Persisted execution_state matches current startup seed."
        : `Persisted execution_state differs from startup seed: ${input.seedMismatches.join(",")}.`,
    },
    {
      name: "evidence_freshness_policy",
      status: input.app.config.executionMode !== "LIVE" || freshnessThresholdMs !== null ? "PASS" : "BLOCK",
      detail: input.app.config.executionMode !== "LIVE"
        ? "LIVE evidence freshness policy is not required outside LIVE readiness."
        : freshnessThresholdMs === null
          ? "LIVE_READINESS_MAX_EVIDENCE_AGE_MS must be an explicit positive safe integer."
          : `LIVE evidence freshness max_age_ms=${freshnessThresholdMs}.`,
    },
    {
      name: "balance_snapshot",
      ...describeHealthEvidenceFreshness(
        "balance snapshot",
        input.latestBalanceSnapshotAt,
        input.checkedAt,
        freshnessThresholdMs,
      ),
    },
    {
      name: "position_snapshot",
      ...describeHealthEvidenceFreshness(
        "position snapshot",
        input.latestPositionSnapshotAt,
        input.checkedAt,
        freshnessThresholdMs,
      ),
    },
    {
      name: "latest_reconciliation",
      ...describeLatestReconciliation(input, freshnessThresholdMs),
    },
    {
      name: "active_orders",
      status: input.activeOrderCount === 0 ? "PASS" : "BLOCK",
      detail: input.activeOrderCount === 0
        ? "No active or reconciliation-required orders are stored."
        : `${input.activeOrderCount} active or reconciliation-required order(s) must be resolved first.`,
    },
  ];
}

function describeLatestReconciliation(input: {
  latestReconciliationRun: Pick<ReconciliationRunRecord, "status" | "completedAt"> | null;
  latestReconciliationIssueCodes: string[];
  latestReconciliationBlockingIssueCodes: string[];
  checkedAt: string;
}, freshnessThresholdMs: number | null): Pick<LiveReadinessSmokeCheck, "status" | "detail"> {
  if (!input.latestReconciliationRun) {
    return {
      status: "WARN",
      detail: "No reconciliation run is stored yet; run /sync before any live strategy run.",
    };
  }

  const issueCodes = formatIssueCodes(input.latestReconciliationIssueCodes);
  const freshness = describeHealthEvidenceFreshness(
    "reconciliation",
    input.latestReconciliationRun.completedAt,
    input.checkedAt,
    freshnessThresholdMs,
  );
  if (input.latestReconciliationBlockingIssueCodes.length > 0) {
    return {
      status: "BLOCK",
      detail: `${freshness.detail} status=${input.latestReconciliationRun.status} ` +
        `blocking_issue_codes=${input.latestReconciliationBlockingIssueCodes.join(",")} issue_codes=${issueCodes}`,
    };
  }

  if (freshness.status === "BLOCK") return freshness;
  if (input.latestReconciliationRun.status !== "SUCCESS") {
    return {
      status: "WARN",
      detail: `${freshness.detail} status=${input.latestReconciliationRun.status} ` +
        `non_blocking_issue_codes=${issueCodes}`,
    };
  }

  return freshness;
}

function getLiveReadinessFreshnessThresholdMs(config: AppConfig): number | null {
  const value = config.liveReadinessMaxEvidenceAgeMs;
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : null;
}

function describeHealthEvidenceFreshness(
  label: string,
  timestamp: string | null,
  checkedAt: string,
  maxAgeMs: number | null,
): Pick<LiveReadinessSmokeCheck, "status" | "detail"> {
  if (timestamp === null) {
    return {
      status: "WARN",
      detail: `No ${label} is stored yet; run /sync before any live strategy run.`,
    };
  }
  if (maxAgeMs === null) {
    return { status: "PASS", detail: `latest ${label} captured_at=${timestamp}` };
  }

  let ageNs: bigint;
  try {
    ageNs = parseCandidatePilotTimestamp(checkedAt, "LIVE readiness checkedAt") -
      parseCandidatePilotTimestamp(timestamp, `LIVE readiness ${label} timestamp`);
  } catch {
    return {
      status: "BLOCK",
      detail: `latest ${label} captured_at=${timestamp} freshness_check=uncomparable`,
    };
  }
  if (ageNs < 0n) {
    return {
      status: "BLOCK",
      detail: `latest ${label} captured_at=${timestamp} freshness_check=uncomparable`,
    };
  }

  const ageMs = ageNs / 1_000_000n;
  const maxAgeNs = BigInt(maxAgeMs) * 1_000_000n;
  return ageNs <= maxAgeNs
    ? {
        status: "PASS",
        detail: `latest ${label} captured_at=${timestamp} fresh_age_ms=${ageMs} max_age_ms=${maxAgeMs}`,
      }
    : {
        status: "WARN",
        detail: `latest ${label} captured_at=${timestamp} stale_age_ms=${ageMs} max_age_ms=${maxAgeMs}`,
      };
}

function formatIssueCodes(issueCodes: readonly string[]): string {
  return issueCodes.length === 0 ? "none" : issueCodes.join(",");
}

function createNonMutationBoundary(): NonMutationBoundary {
  return {
    orders: false,
    strategy: false,
    sync: false,
    scheduler: false,
    telegramPolling: false,
    exchangeProbe: false,
    notificationDelivery: false,
    databaseWrites: false,
    migrations: false,
    bootstrap: false,
    candidateInitialization: false,
  };
}

function parseReconciliationIssueCodes(rawJson: string | null): string[] {
  if (!rawJson) {
    return [];
  }

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

export function summarizeLiveReadinessSmokeStatus(
  checks: readonly LiveReadinessSmokeCheck[],
): LiveReadinessSmokeStatus {
  if (checks.some((check) => check.status === "BLOCK")) {
    return "BLOCK";
  }

  if (checks.some((check) => check.status === "WARN")) {
    return "WARN";
  }

  return "PASS";
}

export function buildLiveReadinessNextActions(checks: readonly LiveReadinessSmokeCheck[]): string[] {
  const actions: string[] = [];
  const checkNames = new Set(checks.map((check) => check.status === "PASS" ? null : check.name));

  if (checkNames.has("live_mode")) {
    actions.push("Set APP_EXECUTION_MODE=LIVE in the local live script before running this smoke.");
  }

  if (checkNames.has("live_gate")) {
    actions.push("Set ENABLE_LIVE_ORDERS=true only in the local live script after confirming real-order intent.");
  }

  if (checkNames.has("upbit_credentials")) {
    actions.push("Configure UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY in the local script; never commit those values.");
  }

  if (checkNames.has("live_send_path")) {
    actions.push("Resolve mode, live gate, and Upbit credential blockers until liveSendPath becomes LIVE_ADAPTER.");
  }

  if (checkNames.has("scheduler_disabled_for_validation")) {
    actions.push("Set STRATEGY_SCHEDULER_ENABLED=false for live validation; enable the scheduler only after separate approval.");
  }

  if (checkNames.has("scheduler_run_on_start_disabled")) {
    actions.push("Set STRATEGY_SCHEDULER_RUN_ON_START=false so startup cannot immediately trigger a strategy cycle.");
  }

  if (checkNames.has("execution_state")) {
    actions.push("Inspect /status and resolve persisted pause, kill switch, or degraded state before any live strategy run.");
  }

  if (checkNames.has("execution_state_seed")) {
    actions.push("Use the intended LIVE DATABASE_PATH or align persisted execution_state with the current startup seed.");
  }

  if (checkNames.has("evidence_freshness_policy")) {
    actions.push(
      "Set LIVE_READINESS_MAX_EVIDENCE_AGE_MS to an explicit positive safe integer before LIVE readiness.",
    );
  }

  const healthEvidenceChecks = checks.filter((check) =>
    check.name === "balance_snapshot" ||
    check.name === "position_snapshot" ||
    check.name === "latest_reconciliation"
  );
  const uncomparableEvidenceBlocks = healthEvidenceChecks.filter((check) =>
    check.status === "BLOCK" && check.detail.includes("freshness_check=uncomparable")
  );
  if (uncomparableEvidenceBlocks.length > 0) {
    actions.push("Investigate system clock and persisted health timestamps before LIVE startup.");
  }

  if (healthEvidenceChecks.some((check) =>
    check.status === "WARN" ||
    (check.status === "BLOCK" && !uncomparableEvidenceBlocks.includes(check))
  )) {
    actions.push("After the live process starts with scheduler disabled, run /sync and re-check /readiness before /run.");
  }

  if (checkNames.has("active_orders")) {
    actions.push("Inspect /orders and /order <id|identifier>; resolve active or reconciliation-required orders first.");
  }

  return actions.length === 0
    ? ["Live readiness smoke has no blocking or warning actions. Continue with scheduler disabled until operator checks pass."]
    : actions;
}

function getCheckNamesByStatus(
  checks: readonly LiveReadinessSmokeCheck[],
  status: LiveReadinessSmokeStatus,
): string[] {
  return checks.filter((check) => check.status === status).map((check) => check.name);
}

function isLiveRunnableExecutionState(state: ExecutionStateRecord): boolean {
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
    : `Execution state blocks live readiness: ${blockers.join(",")}.`;
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

if (isMainModule()) {
  const result = await runLiveReadinessSmoke();
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "BLOCK") {
    process.exitCode = 1;
  }
}
