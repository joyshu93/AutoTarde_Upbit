import { pathToFileURL } from "node:url";

import { createApp, type AppServices } from "../app/create-app.js";
import { loadAppConfig, type AppConfig } from "../app/env.js";
import type { RuntimeOwnershipAuthority } from "../app/runtime-ownership-guard.js";
import {
  runWithScopedRuntimeOwnership,
  stopScopedApplicationRuntime,
} from "../app/scoped-runtime-ownership.js";
import type { ExecutionStateRecord, ReconciliationRunRecord } from "../domain/types.js";
import { detectExecutionStateSeedMismatches } from "../modules/db/interfaces.js";

type DryRunReadinessSmokeStatus = "PASS" | "WARN" | "BLOCK";
type DryRunReadinessSmokeEnvKey = keyof typeof FORCED_DRY_RUN_READINESS_ENV;
type NonMutationBoundary = Record<
  | "orders"
  | "strategy"
  | "sync"
  | "scheduler"
  | "telegramPolling"
  | "exchangeProbe"
  | "notificationDelivery",
  false
>;

const FORCED_DRY_RUN_READINESS_ENV = {
  APP_EXECUTION_MODE: "DRY_RUN",
  ENABLE_LIVE_ORDERS: "false",
  STRATEGY_SCHEDULER_ENABLED: "false",
  STRATEGY_SCHEDULER_RUN_ON_START: "false",
} as const;

const DEFAULT_DRY_RUN_READINESS_DATABASE_PATH = "./var/dryrun-readiness-smoke.sqlite";
const READ_ONLY_DATA_SOURCES = [
  "runtime_config",
  "execution_state",
  "orders",
  "balance_snapshots",
  "position_snapshots",
  "reconciliation_runs",
  "risk_events",
  "operator_notifications",
] as const;

const BLOCKING_RECONCILIATION_ISSUE_CODES = new Set([
  "BALANCE_DRIFT_DETECTED",
  "POSITION_DRIFT_DETECTED",
  "ORDER_MARKED_FOR_RECOVERY",
  "ORDER_REFERENCE_MISSING",
  "ORDER_LOOKUP_TRANSIENT_FAILURE",
  "ORDER_LOOKUP_DEFERRED",
  "ORDER_HISTORY_LOOKUP_FAILED",
]);

export interface DryRunReadinessSmokeEnvReport {
  readonly forced: Record<DryRunReadinessSmokeEnvKey, string>;
  readonly previous: Record<DryRunReadinessSmokeEnvKey, string | undefined>;
  readonly databasePathDefaulted: boolean;
  readonly databasePath: string;
}

export interface DryRunReadinessSmokeCheck {
  readonly name: string;
  readonly status: DryRunReadinessSmokeStatus;
  readonly detail: string;
}

export interface DryRunReadinessSmokeResult {
  readonly service: string;
  readonly status: DryRunReadinessSmokeStatus;
  readonly executionMode: AppConfig["executionMode"];
  readonly liveExecutionGate: AppConfig["liveExecutionGate"];
  readonly liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  readonly databasePath: string;
  readonly exchangeBackedReadEnabled: boolean;
  readonly telegramDeliveryEnabled: boolean;
  readonly telegramDeliveryConfigured: boolean;
  readonly telegramInboundPollingEnabled: boolean;
  readonly telegramInboundPollingConfigured: boolean;
  readonly schedulerEnabled: boolean;
  readonly schedulerRunOnStart: boolean;
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
  readonly recentRiskBlockCount: number;
  readonly pendingNotificationCount: number;
  readonly seedMismatches: string[];
  readonly safetyEnv: DryRunReadinessSmokeEnvReport;
  readonly blockingCheckNames: string[];
  readonly warningCheckNames: string[];
  readonly nextActions: string[];
  readonly checks: DryRunReadinessSmokeCheck[];
}

export interface DryRunReadinessSmokeOperations {
  loadAppConfig(): AppConfig;
  createApplication(
    config: AppConfig,
    overrides: { readonly runtimeOwnershipAuthority: RuntimeOwnershipAuthority },
  ): AppServices;
  runWithScopedRuntimeOwnership: typeof runWithScopedRuntimeOwnership;
}

export function applyDryRunReadinessSmokeSafetyEnv(
  env: NodeJS.ProcessEnv = process.env,
): DryRunReadinessSmokeEnvReport {
  const previous = {} as Record<DryRunReadinessSmokeEnvKey, string | undefined>;
  for (const key of Object.keys(FORCED_DRY_RUN_READINESS_ENV) as DryRunReadinessSmokeEnvKey[]) {
    previous[key] = env[key];
    env[key] = FORCED_DRY_RUN_READINESS_ENV[key];
  }

  const databasePathDefaulted = !env.DATABASE_PATH?.trim();
  if (databasePathDefaulted) {
    env.DATABASE_PATH = DEFAULT_DRY_RUN_READINESS_DATABASE_PATH;
  }
  const databasePath = env.DATABASE_PATH ?? DEFAULT_DRY_RUN_READINESS_DATABASE_PATH;

  return {
    forced: { ...FORCED_DRY_RUN_READINESS_ENV },
    previous,
    databasePathDefaulted,
    databasePath,
  };
}

export function validateDryRunReadinessSmokeSafety(input: {
  config: AppConfig;
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
}): string[] {
  const blockers: string[] = [];

  if (input.config.executionMode !== "DRY_RUN") {
    blockers.push("APP_EXECUTION_MODE must resolve to DRY_RUN for dry-run readiness.");
  }

  if (input.config.liveExecutionGate !== "DISABLED") {
    blockers.push("ENABLE_LIVE_ORDERS must resolve to DISABLED for dry-run readiness.");
  }

  if (input.liveSendPath !== "DRY_RUN_ADAPTER") {
    blockers.push("liveSendPath must remain DRY_RUN_ADAPTER for dry-run readiness.");
  }

  if (input.config.strategySchedulerEnabled) {
    blockers.push("STRATEGY_SCHEDULER_ENABLED must be false for dry-run readiness.");
  }

  if (input.config.strategySchedulerRunOnStart) {
    blockers.push("STRATEGY_SCHEDULER_RUN_ON_START must be false for dry-run readiness.");
  }

  return blockers;
}

export async function runDryRunReadinessSmoke(
  overrides: Partial<DryRunReadinessSmokeOperations> = {},
): Promise<DryRunReadinessSmokeResult> {
  const safetyEnv = applyDryRunReadinessSmokeSafetyEnv();
  const config = (overrides.loadAppConfig ?? loadAppConfig)();
  const createApplication = overrides.createApplication ?? ((appConfig, appOverrides) =>
    createApp(appConfig, appOverrides));
  const runOwned = overrides.runWithScopedRuntimeOwnership ?? runWithScopedRuntimeOwnership;

  return runOwned(config, async (
    runtimeOwnershipAuthority,
    verifiedConfig,
    fenceApplication,
  ) => {
    const app = createApplication(verifiedConfig, { runtimeOwnershipAuthority });
    try {
      return await buildDryRunReadinessSmokeResult(app, safetyEnv);
    } finally {
      await stopScopedApplicationRuntime(app, fenceApplication);
    }
  });
}

export async function buildDryRunReadinessSmokeResult(
  app: Pick<
    AppServices,
    | "config"
    | "operatorState"
    | "repositories"
    | "exchangeBackedReadEnabled"
    | "liveSendPath"
    | "telegramInboundPolling"
    | "notificationDelivery"
  >,
  safetyEnv: DryRunReadinessSmokeEnvReport,
): Promise<DryRunReadinessSmokeResult> {
  const [
    executionState,
    activeOrders,
    latestBalanceSnapshot,
    latestPositionSnapshot,
    reconciliationRuns,
    recentRiskEvents,
    pendingNotifications,
  ] = await Promise.all([
    app.operatorState.getState(),
    app.repositories.listActiveOrders("primary", undefined, 20),
    app.repositories.getLatestBalanceSnapshot("primary"),
    app.repositories.getLatestPositionSnapshot("primary"),
    app.repositories.listReconciliationRuns("primary", 1),
    app.repositories.listRiskEvents("primary", 20),
    app.repositories.listPendingOperatorNotifications("primary", { limit: 20 }),
  ]);
  const latestReconciliationRun = reconciliationRuns[0] ?? null;
  const latestReconciliationIssueCodes = parseReconciliationIssueCodes(
    latestReconciliationRun?.summaryJson ?? null,
  );
  const latestReconciliationBlockingIssueCodes = latestReconciliationIssueCodes.filter((code) =>
    BLOCKING_RECONCILIATION_ISSUE_CODES.has(code)
  );
  const seedMismatches = detectExecutionStateSeedMismatches(executionState, {
    executionMode: app.config.executionMode,
    liveExecutionGate: app.config.liveExecutionGate,
    killSwitchActive: app.config.globalKillSwitch,
  });
  const safetyBlockers = validateDryRunReadinessSmokeSafety({
    config: app.config,
    liveSendPath: app.liveSendPath,
  });
  const checks = buildDryRunReadinessSmokeChecks({
    app,
    executionState,
    seedMismatches,
    safetyBlockers,
    activeOrderCount: activeOrders.length,
    latestBalanceSnapshotAt: latestBalanceSnapshot?.capturedAt ?? null,
    latestPositionSnapshotAt: latestPositionSnapshot?.capturedAt ?? null,
    latestReconciliationRun,
    latestReconciliationIssueCodes,
    latestReconciliationBlockingIssueCodes,
    recentRiskBlockCount: countRiskBlocks(recentRiskEvents),
    pendingNotificationCount: pendingNotifications.length,
  });

  return {
    service: app.config.serviceName,
    status: summarizeDryRunReadinessSmokeStatus(checks),
    executionMode: app.config.executionMode,
    liveExecutionGate: app.config.liveExecutionGate,
    liveSendPath: app.liveSendPath,
    databasePath: app.config.databasePath,
    exchangeBackedReadEnabled: app.exchangeBackedReadEnabled,
    telegramDeliveryEnabled: app.config.telegramDeliveryEnabled,
    telegramDeliveryConfigured: app.notificationDelivery.isConfigured(),
    telegramInboundPollingEnabled: app.config.telegramInboundPollingEnabled,
    telegramInboundPollingConfigured: app.telegramInboundPolling.isConfigured(),
    schedulerEnabled: app.config.strategySchedulerEnabled,
    schedulerRunOnStart: app.config.strategySchedulerRunOnStart,
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
    recentRiskBlockCount: countRiskBlocks(recentRiskEvents),
    pendingNotificationCount: pendingNotifications.length,
    seedMismatches,
    safetyEnv,
    blockingCheckNames: getCheckNamesByStatus(checks, "BLOCK"),
    warningCheckNames: getCheckNamesByStatus(checks, "WARN"),
    nextActions: buildDryRunReadinessNextActions(checks),
    checks,
  };
}

export function buildDryRunReadinessSmokeChecks(input: {
  app: {
    config: AppConfig;
    exchangeBackedReadEnabled: boolean;
    liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
    notificationDelivery: { isConfigured(): boolean };
    telegramInboundPolling: { isConfigured(): boolean };
  };
  executionState: ExecutionStateRecord;
  seedMismatches: string[];
  safetyBlockers: string[];
  activeOrderCount: number;
  latestBalanceSnapshotAt: string | null;
  latestPositionSnapshotAt: string | null;
  latestReconciliationRun: Pick<ReconciliationRunRecord, "status" | "completedAt"> | null;
  latestReconciliationIssueCodes: string[];
  latestReconciliationBlockingIssueCodes: string[];
  recentRiskBlockCount: number;
  pendingNotificationCount: number;
}): DryRunReadinessSmokeCheck[] {
  return [
    {
      name: "non_mutation_boundary",
      status: "PASS",
      detail:
        "This smoke creates no orders, runs no strategy cycle, starts no scheduler, starts no Telegram polling, runs no sync, and calls no exchange endpoint.",
    },
    {
      name: "dry_run_safety_env",
      status: input.safetyBlockers.length === 0 ? "PASS" : "BLOCK",
      detail: input.safetyBlockers.length === 0
        ? "DRY_RUN safety environment is enforced."
        : input.safetyBlockers.join(" "),
    },
    {
      name: "execution_state",
      status: isDryRunRunnableExecutionState(input.executionState) ? "PASS" : "BLOCK",
      detail: describeExecutionState(input.executionState),
    },
    {
      name: "execution_state_seed",
      status: input.seedMismatches.length === 0 ? "PASS" : "BLOCK",
      detail: input.seedMismatches.length === 0
        ? "Persisted execution_state matches current DRY_RUN startup seed."
        : `Persisted execution_state differs from startup seed: ${input.seedMismatches.join(",")}.`,
    },
    {
      name: "upbit_read_credentials",
      status: input.app.exchangeBackedReadEnabled ? "PASS" : "WARN",
      detail: input.app.exchangeBackedReadEnabled
        ? "Upbit read credentials are configured. Secret values are not rendered."
        : "Upbit read credentials are not configured; /sync will use local dry-run balances only.",
    },
    {
      name: "telegram_delivery",
      status: input.app.config.telegramDeliveryEnabled && input.app.notificationDelivery.isConfigured()
        ? "PASS"
        : "WARN",
      detail: input.app.config.telegramDeliveryEnabled && input.app.notificationDelivery.isConfigured()
        ? "Telegram delivery is enabled and configured."
        : "Telegram delivery is disabled or missing bot token/operator chat; notifications remain inspectable through /alerts.",
    },
    {
      name: "telegram_inbound",
      status: input.app.config.telegramInboundPollingEnabled && input.app.telegramInboundPolling.isConfigured()
        ? "PASS"
        : "WARN",
      detail: input.app.config.telegramInboundPollingEnabled && input.app.telegramInboundPolling.isConfigured()
        ? "Telegram inbound polling is enabled and configured, but this smoke does not start it."
        : "Telegram inbound polling is disabled or missing bot token/operator chat.",
    },
    {
      name: "balance_snapshot",
      status: input.latestBalanceSnapshotAt ? "PASS" : "WARN",
      detail: input.latestBalanceSnapshotAt
        ? `latest balance snapshot captured_at=${input.latestBalanceSnapshotAt}`
        : "No balance snapshot is stored yet; run /sync after starting the DRY_RUN runtime.",
    },
    {
      name: "position_snapshot",
      status: input.latestPositionSnapshotAt ? "PASS" : "WARN",
      detail: input.latestPositionSnapshotAt
        ? `latest position snapshot captured_at=${input.latestPositionSnapshotAt}`
        : "No position snapshot is stored yet; run /sync after starting the DRY_RUN runtime.",
    },
    {
      name: "latest_reconciliation",
      status: classifyLatestReconciliation(input),
      detail: describeLatestReconciliation(input),
    },
    {
      name: "active_orders",
      status: input.activeOrderCount === 0 ? "PASS" : "WARN",
      detail: input.activeOrderCount === 0
        ? "No active or reconciliation-required orders are stored."
        : `${input.activeOrderCount} active or reconciliation-required order(s) need operator visibility.`,
    },
    {
      name: "recent_risk_blocks",
      status: input.recentRiskBlockCount === 0 ? "PASS" : "WARN",
      detail: input.recentRiskBlockCount === 0
        ? "No BLOCK risk events in the recent bounded sample."
        : `${input.recentRiskBlockCount} BLOCK risk event(s) in the recent bounded sample.`,
    },
    {
      name: "pending_notifications",
      status: input.pendingNotificationCount === 0 ? "PASS" : "WARN",
      detail: input.pendingNotificationCount === 0
        ? "No pending operator notifications in the recent bounded sample."
        : `${input.pendingNotificationCount} pending operator notification(s) in the recent bounded sample.`,
    },
  ];
}

export function summarizeDryRunReadinessSmokeStatus(
  checks: readonly DryRunReadinessSmokeCheck[],
): DryRunReadinessSmokeStatus {
  if (checks.some((check) => check.status === "BLOCK")) {
    return "BLOCK";
  }

  if (checks.some((check) => check.status === "WARN")) {
    return "WARN";
  }

  return "PASS";
}

export function buildDryRunReadinessNextActions(
  checks: readonly DryRunReadinessSmokeCheck[],
): string[] {
  const actions: string[] = [];
  const checkNames = new Set(checks.map((check) => check.status === "PASS" ? null : check.name));

  if (checkNames.has("dry_run_safety_env")) {
    actions.push("Keep APP_EXECUTION_MODE=DRY_RUN, ENABLE_LIVE_ORDERS=false, and scheduler disabled in the local DRY_RUN script.");
  }

  if (checkNames.has("execution_state") || checkNames.has("execution_state_seed")) {
    actions.push("Inspect /status and align the intended DATABASE_PATH with the current DRY_RUN execution_state.");
  }

  if (checkNames.has("upbit_read_credentials")) {
    actions.push("Configure UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY in the local DRY_RUN script before exchange-backed /sync.");
  }

  if (checkNames.has("telegram_delivery") || checkNames.has("telegram_inbound")) {
    actions.push("Configure TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_CHAT_ID in the local DRY_RUN script before bot operation.");
  }

  if (checkNames.has("balance_snapshot") || checkNames.has("position_snapshot") || checkNames.has("latest_reconciliation")) {
    actions.push("After starting the DRY_RUN runtime, run /sync, then re-check /readiness before /run BTC|ETH.");
  }

  if (checkNames.has("active_orders")) {
    actions.push("Inspect /orders and /order <id|identifier> before requesting more strategy runs.");
  }

  if (checkNames.has("recent_risk_blocks")) {
    actions.push("Inspect /risks for recent guardrail blockers.");
  }

  if (checkNames.has("pending_notifications")) {
    actions.push("Inspect /alerts and Telegram delivery configuration.");
  }

  return actions.length === 0
    ? ["DRY_RUN readiness has no blockers or warnings. Start the local DRY_RUN runtime and run operator checks."]
    : actions;
}

function classifyLatestReconciliation(input: {
  latestReconciliationRun: Pick<ReconciliationRunRecord, "status" | "completedAt"> | null;
  latestReconciliationBlockingIssueCodes: string[];
}): DryRunReadinessSmokeStatus {
  if (!input.latestReconciliationRun) {
    return "WARN";
  }

  if (input.latestReconciliationBlockingIssueCodes.length > 0) {
    return "BLOCK";
  }

  return input.latestReconciliationRun.status === "SUCCESS" ? "PASS" : "WARN";
}

function describeLatestReconciliation(input: {
  latestReconciliationRun: Pick<ReconciliationRunRecord, "status" | "completedAt"> | null;
  latestReconciliationIssueCodes: string[];
  latestReconciliationBlockingIssueCodes: string[];
}): string {
  if (!input.latestReconciliationRun) {
    return "No reconciliation run is stored yet; run /sync after starting the DRY_RUN runtime.";
  }

  const issueCodes = input.latestReconciliationIssueCodes.length === 0
    ? "none"
    : input.latestReconciliationIssueCodes.join(",");
  if (input.latestReconciliationBlockingIssueCodes.length > 0) {
    return `latest reconciliation status=${input.latestReconciliationRun.status} ` +
      `completed_at=${input.latestReconciliationRun.completedAt ?? "none"} ` +
      `blocking_issue_codes=${input.latestReconciliationBlockingIssueCodes.join(",")} issue_codes=${issueCodes}`;
  }

  return `latest reconciliation status=${input.latestReconciliationRun.status} ` +
    `completed_at=${input.latestReconciliationRun.completedAt ?? "none"} issue_codes=${issueCodes}`;
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

    return parsed
      .issues
      .map((issue) =>
        issue && typeof issue === "object" && "code" in issue && typeof issue.code === "string"
          ? issue.code
          : null)
      .filter((code): code is string => code !== null);
  } catch {
    return [];
  }
}

function isDryRunRunnableExecutionState(state: ExecutionStateRecord): boolean {
  return state.executionMode === "DRY_RUN" &&
    state.liveExecutionGate === "DISABLED" &&
    state.systemStatus === "RUNNING" &&
    !state.killSwitchActive &&
    state.degradedReason === null;
}

function describeExecutionState(state: ExecutionStateRecord): string {
  const blockers: string[] = [];

  if (state.executionMode !== "DRY_RUN") {
    blockers.push("execution_mode_not_dry_run");
  }

  if (state.liveExecutionGate !== "DISABLED") {
    blockers.push("live_gate_enabled");
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
    ? "Execution state is DRY_RUN, running, not degraded, and kill switch is off."
    : `Execution state blocks DRY_RUN readiness: ${blockers.join(",")}.`;
}

function countRiskBlocks(events: readonly { level: string }[]): number {
  return events.filter((event) => event.level === "BLOCK").length;
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
  };
}

function getCheckNamesByStatus(
  checks: readonly DryRunReadinessSmokeCheck[],
  status: DryRunReadinessSmokeStatus,
): string[] {
  return checks.filter((check) => check.status === status).map((check) => check.name);
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

if (isMainModule()) {
  const result = await runDryRunReadinessSmoke();
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "BLOCK") {
    process.exitCode = 1;
  }
}
