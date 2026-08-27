import { pathToFileURL } from "node:url";

import { createApp } from "../app/create-app.js";
import { loadAppConfig, type AppConfig } from "../app/env.js";
import type { RuntimeOwnershipAuthority } from "../app/runtime-ownership-guard.js";
import {
  runWithScopedRuntimeOwnership,
  stopScopedApplicationRuntime,
} from "../app/scoped-runtime-ownership.js";
import {
  SUPPORTED_MARKETS,
  type ExecutionStateRecord,
  type OrderLifecycleStatus,
  type ReconciliationRunRecord,
  type StrategyDecisionAction,
  type StrategySchedulerRunRecord,
  type SupportedMarket,
} from "../domain/types.js";
import type { ExecutionRepository, OperatorStateStore } from "../modules/db/interfaces.js";
import { detectExecutionStateSeedMismatches } from "../modules/db/interfaces.js";

type DryRunCompletionSmokeStatus = "PASS" | "WARN" | "BLOCK";
type DryRunCompletionSmokeEnvKey = keyof typeof FORCED_DRY_RUN_COMPLETION_ENV;
type NonMutationBoundary = Record<
  | "orders"
  | "strategy"
  | "sync"
  | "scheduler"
  | "telegramPolling"
  | "telegramDelivery"
  | "exchangeProbe"
  | "orderTransmission",
  false
>;

const FORCED_DRY_RUN_COMPLETION_ENV = {
  APP_EXECUTION_MODE: "DRY_RUN",
  ENABLE_LIVE_ORDERS: "false",
  ENABLE_TELEGRAM_DELIVERY: "false",
  ENABLE_TELEGRAM_INBOUND_POLLING: "false",
  STRATEGY_SCHEDULER_ENABLED: "false",
  STRATEGY_SCHEDULER_RUN_ON_START: "false",
} as const;

const DEFAULT_DRY_RUN_COMPLETION_DATABASE_PATH = "./var/dryrun-completion-smoke.sqlite";
const SCHEDULER_RUN_SAMPLE_LIMIT = 50;
const RECENT_RISK_EVENT_SAMPLE_LIMIT = 20;
const PENDING_NOTIFICATION_SAMPLE_LIMIT = 20;
const READ_ONLY_DATA_SOURCES = [
  "runtime_config",
  "execution_state",
  "orders",
  "balance_snapshots",
  "position_snapshots",
  "reconciliation_runs",
  "risk_events",
  "operator_notifications",
  "strategy_scheduler_runs",
] as const;
const ACTIVE_ORDER_STATUSES: ReadonlySet<OrderLifecycleStatus> = new Set([
  "INTENT_CREATED",
  "PERSISTED",
  "SUBMITTING",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "RECONCILIATION_REQUIRED",
]);
const BLOCKING_RECONCILIATION_ISSUE_CODES = new Set([
  "BALANCE_DRIFT_DETECTED",
  "POSITION_DRIFT_DETECTED",
  "ORDER_MARKED_FOR_RECOVERY",
  "ORDER_REFERENCE_MISSING",
  "ORDER_LOOKUP_TRANSIENT_FAILURE",
  "ORDER_LOOKUP_DEFERRED",
  "ORDER_HISTORY_LOOKUP_FAILED",
]);

type DryRunCompletionSmokeApp = {
  readonly config: AppConfig;
  readonly operatorState: Pick<OperatorStateStore, "getState">;
  readonly repositories: Pick<
    ExecutionRepository,
    | "listActiveOrders"
    | "getLatestBalanceSnapshot"
    | "getLatestPositionSnapshot"
    | "listReconciliationRuns"
    | "listRiskEvents"
    | "listPendingOperatorNotifications"
    | "listStrategySchedulerRuns"
  >;
  readonly exchangeBackedReadEnabled: boolean;
  readonly liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
};

export interface DryRunCompletionSmokeEnvReport {
  readonly forced: Record<DryRunCompletionSmokeEnvKey, string>;
  readonly previous: Record<DryRunCompletionSmokeEnvKey, string | undefined>;
  readonly databasePathDefaulted: boolean;
  readonly databasePath: string;
}

export interface DryRunCompletionSchedulerMarketEvidence {
  readonly market: SupportedMarket;
  readonly latestRunStartedAt: string | null;
  readonly latestRunCompletedAt: string | null;
  readonly latestRunStatus: StrategySchedulerRunRecord["status"] | null;
  readonly runOnStart: boolean | null;
  readonly action: StrategyDecisionAction | null;
  readonly orderId: string | null;
  readonly orderStatus: OrderLifecycleStatus | null;
  readonly submissionAccepted: boolean | null;
  readonly detail: string | null;
  readonly errorMessage: string | null;
}

export interface DryRunCompletionSmokeCheck {
  readonly name: string;
  readonly status: DryRunCompletionSmokeStatus;
  readonly detail: string;
}

export interface DryRunCompletionSmokeResult {
  readonly service: string;
  readonly status: DryRunCompletionSmokeStatus;
  readonly executionMode: AppConfig["executionMode"];
  readonly liveExecutionGate: AppConfig["liveExecutionGate"];
  readonly liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  readonly databasePath: string;
  readonly exchangeBackedReadEnabled: boolean;
  readonly telegramDeliveryEnabled: boolean;
  readonly telegramInboundPollingEnabled: boolean;
  readonly telegramBotTokenConfigured: boolean;
  readonly telegramOperatorChatIdConfigured: boolean;
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
  readonly telegramDeliveryAttempted: false;
  readonly exchangeProbeAttempted: false;
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
  readonly recentSchedulerRunCount: number;
  readonly schedulerMarketEvidence: DryRunCompletionSchedulerMarketEvidence[];
  readonly seedMismatches: string[];
  readonly safetyEnv: DryRunCompletionSmokeEnvReport;
  readonly blockingCheckNames: string[];
  readonly warningCheckNames: string[];
  readonly nextActions: string[];
  readonly checks: DryRunCompletionSmokeCheck[];
}

export interface DryRunCompletionSmokeOperations {
  loadAppConfig(): AppConfig;
  createApplication(
    config: AppConfig,
    overrides: { readonly runtimeOwnershipAuthority: RuntimeOwnershipAuthority },
  ): ReturnType<typeof createApp>;
  runWithScopedRuntimeOwnership: typeof runWithScopedRuntimeOwnership;
}

export function applyDryRunCompletionSmokeSafetyEnv(
  env: NodeJS.ProcessEnv = process.env,
): DryRunCompletionSmokeEnvReport {
  const previous = {} as Record<DryRunCompletionSmokeEnvKey, string | undefined>;
  for (const key of Object.keys(FORCED_DRY_RUN_COMPLETION_ENV) as DryRunCompletionSmokeEnvKey[]) {
    previous[key] = env[key];
    env[key] = FORCED_DRY_RUN_COMPLETION_ENV[key];
  }

  const databasePathDefaulted = !env.DATABASE_PATH?.trim();
  if (databasePathDefaulted) {
    env.DATABASE_PATH = DEFAULT_DRY_RUN_COMPLETION_DATABASE_PATH;
  }
  const databasePath = env.DATABASE_PATH ?? DEFAULT_DRY_RUN_COMPLETION_DATABASE_PATH;

  return {
    forced: { ...FORCED_DRY_RUN_COMPLETION_ENV },
    previous,
    databasePathDefaulted,
    databasePath,
  };
}

export function validateDryRunCompletionSmokeSafety(input: {
  config: AppConfig;
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
}): string[] {
  const blockers: string[] = [];

  if (input.config.executionMode !== "DRY_RUN") {
    blockers.push("APP_EXECUTION_MODE must resolve to DRY_RUN for dry-run completion.");
  }

  if (input.config.liveExecutionGate !== "DISABLED") {
    blockers.push("ENABLE_LIVE_ORDERS must resolve to DISABLED for dry-run completion.");
  }

  if (input.liveSendPath !== "DRY_RUN_ADAPTER") {
    blockers.push("liveSendPath must remain DRY_RUN_ADAPTER for dry-run completion.");
  }

  if (input.config.telegramDeliveryEnabled) {
    blockers.push("ENABLE_TELEGRAM_DELIVERY must be false for dry-run completion smoke.");
  }

  if (input.config.telegramInboundPollingEnabled) {
    blockers.push("ENABLE_TELEGRAM_INBOUND_POLLING must be false for dry-run completion smoke.");
  }

  if (input.config.strategySchedulerEnabled) {
    blockers.push("STRATEGY_SCHEDULER_ENABLED must be false for dry-run completion smoke.");
  }

  if (input.config.strategySchedulerRunOnStart) {
    blockers.push("STRATEGY_SCHEDULER_RUN_ON_START must be false for dry-run completion smoke.");
  }

  return blockers;
}

export async function runDryRunCompletionSmoke(
  overrides: Partial<DryRunCompletionSmokeOperations> = {},
): Promise<DryRunCompletionSmokeResult> {
  const safetyEnv = applyDryRunCompletionSmokeSafetyEnv();
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
      return await buildDryRunCompletionSmokeResult(app, safetyEnv);
    } finally {
      await stopScopedApplicationRuntime(app, fenceApplication);
    }
  });
}

export async function buildDryRunCompletionSmokeResult(
  app: DryRunCompletionSmokeApp,
  safetyEnv: DryRunCompletionSmokeEnvReport,
): Promise<DryRunCompletionSmokeResult> {
  const [
    executionState,
    activeOrders,
    latestBalanceSnapshot,
    latestPositionSnapshot,
    reconciliationRuns,
    recentRiskEvents,
    pendingNotifications,
    schedulerRuns,
  ] = await Promise.all([
    app.operatorState.getState(),
    app.repositories.listActiveOrders("primary", undefined, 20),
    app.repositories.getLatestBalanceSnapshot("primary"),
    app.repositories.getLatestPositionSnapshot("primary"),
    app.repositories.listReconciliationRuns("primary", 1),
    app.repositories.listRiskEvents("primary", RECENT_RISK_EVENT_SAMPLE_LIMIT),
    app.repositories.listPendingOperatorNotifications("primary", { limit: PENDING_NOTIFICATION_SAMPLE_LIMIT }),
    app.repositories.listStrategySchedulerRuns("primary", SCHEDULER_RUN_SAMPLE_LIMIT),
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
  const safetyBlockers = validateDryRunCompletionSmokeSafety({
    config: app.config,
    liveSendPath: app.liveSendPath,
  });
  const schedulerMarketEvidence = buildSchedulerMarketEvidence(schedulerRuns);
  const recentRiskBlockCount = countRiskBlocks(recentRiskEvents);
  const pendingNotificationCount = pendingNotifications.length;
  const checks = buildDryRunCompletionSmokeChecks({
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
    recentRiskBlockCount,
    pendingNotificationCount,
    schedulerMarketEvidence,
  });

  return {
    service: app.config.serviceName,
    status: summarizeDryRunCompletionSmokeStatus(checks),
    executionMode: app.config.executionMode,
    liveExecutionGate: app.config.liveExecutionGate,
    liveSendPath: app.liveSendPath,
    databasePath: app.config.databasePath,
    exchangeBackedReadEnabled: app.exchangeBackedReadEnabled,
    telegramDeliveryEnabled: app.config.telegramDeliveryEnabled,
    telegramInboundPollingEnabled: app.config.telegramInboundPollingEnabled,
    telegramBotTokenConfigured: Boolean(app.config.telegramBotToken),
    telegramOperatorChatIdConfigured: Boolean(app.config.telegramOperatorChatId),
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
    telegramDeliveryAttempted: false,
    exchangeProbeAttempted: false,
    readOnlyDataSources: READ_ONLY_DATA_SOURCES,
    activeOrderCount: activeOrders.length,
    latestBalanceSnapshotAt: latestBalanceSnapshot?.capturedAt ?? null,
    latestPositionSnapshotAt: latestPositionSnapshot?.capturedAt ?? null,
    latestReconciliationStatus: latestReconciliationRun?.status ?? null,
    latestReconciliationCompletedAt: latestReconciliationRun?.completedAt ?? null,
    latestReconciliationIssueCodes,
    latestReconciliationBlockingIssueCodes,
    recentRiskBlockCount,
    pendingNotificationCount,
    recentSchedulerRunCount: schedulerRuns.length,
    schedulerMarketEvidence,
    seedMismatches,
    safetyEnv,
    blockingCheckNames: getCheckNamesByStatus(checks, "BLOCK"),
    warningCheckNames: getCheckNamesByStatus(checks, "WARN"),
    nextActions: buildDryRunCompletionNextActions(checks),
    checks,
  };
}

export function buildDryRunCompletionSmokeChecks(input: {
  app: Pick<DryRunCompletionSmokeApp, "config" | "exchangeBackedReadEnabled" | "liveSendPath">;
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
  schedulerMarketEvidence: readonly DryRunCompletionSchedulerMarketEvidence[];
}): DryRunCompletionSmokeCheck[] {
  return [
    {
      name: "non_mutation_boundary",
      status: "PASS",
      detail:
        "This smoke reads persisted DRY_RUN evidence only; it runs no sync, strategy cycle, scheduler tick, Telegram polling, Telegram delivery, exchange probe, or order transmission.",
    },
    {
      name: "dry_run_safety_env",
      status: input.safetyBlockers.length === 0 ? "PASS" : "BLOCK",
      detail: input.safetyBlockers.length === 0
        ? "DRY_RUN completion safety environment is enforced."
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
        ? "Persisted execution_state matches current DRY_RUN completion seed."
        : `Persisted execution_state differs from startup seed: ${input.seedMismatches.join(",")}.`,
    },
    {
      name: "upbit_read_credentials",
      status: input.app.exchangeBackedReadEnabled ? "PASS" : "BLOCK",
      detail: input.app.exchangeBackedReadEnabled
        ? "Upbit read credentials are configured. Secret values are not rendered."
        : "UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY are required to treat exchange-backed DRY_RUN validation as complete.",
    },
    {
      name: "telegram_credentials",
      status: hasTelegramCredentials(input.app.config) ? "PASS" : "BLOCK",
      detail: hasTelegramCredentials(input.app.config)
        ? "Telegram bot token and operator chat are configured, but this smoke disables transport."
        : "TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_CHAT_ID are required for operator-visible DRY_RUN validation completion.",
    },
    {
      name: "balance_snapshot",
      status: input.latestBalanceSnapshotAt ? "PASS" : "BLOCK",
      detail: input.latestBalanceSnapshotAt
        ? `latest balance snapshot captured_at=${input.latestBalanceSnapshotAt}`
        : "No balance snapshot is stored; run exchange-backed DRY_RUN sync against this DATABASE_PATH first.",
    },
    {
      name: "position_snapshot",
      status: input.latestPositionSnapshotAt ? "PASS" : "BLOCK",
      detail: input.latestPositionSnapshotAt
        ? `latest position snapshot captured_at=${input.latestPositionSnapshotAt}`
        : "No position snapshot is stored; run exchange-backed DRY_RUN sync against this DATABASE_PATH first.",
    },
    {
      name: "latest_reconciliation",
      status: classifyLatestReconciliation(input),
      detail: describeLatestReconciliation(input),
    },
    {
      name: "active_orders",
      status: input.activeOrderCount === 0 ? "PASS" : "BLOCK",
      detail: input.activeOrderCount === 0
        ? "No active or reconciliation-required orders are stored."
        : `${input.activeOrderCount} active or reconciliation-required order(s) must be inspected before proceeding.`,
    },
    {
      name: "recent_risk_blocks",
      status: input.recentRiskBlockCount === 0 ? "PASS" : "BLOCK",
      detail: input.recentRiskBlockCount === 0
        ? "No BLOCK risk events in the recent bounded sample."
        : `${input.recentRiskBlockCount} BLOCK risk event(s) remain in the recent bounded sample.`,
    },
    {
      name: "pending_notifications",
      status: input.pendingNotificationCount === 0 ? "PASS" : "BLOCK",
      detail: input.pendingNotificationCount === 0
        ? "No pending operator notifications in the recent bounded sample."
        : `${input.pendingNotificationCount} pending operator notification(s) should be reviewed before proceeding.`,
    },
    {
      name: "scheduler_latest_runs",
      status: classifySchedulerLatestRuns(input.schedulerMarketEvidence),
      detail: describeSchedulerLatestRuns(input.schedulerMarketEvidence),
    },
    {
      name: "scheduler_order_states",
      status: classifySchedulerOrderStates(input.schedulerMarketEvidence),
      detail: describeSchedulerOrderStates(input.schedulerMarketEvidence),
    },
  ];
}

export function summarizeDryRunCompletionSmokeStatus(
  checks: readonly DryRunCompletionSmokeCheck[],
): DryRunCompletionSmokeStatus {
  if (checks.some((check) => check.status === "BLOCK")) {
    return "BLOCK";
  }

  if (checks.some((check) => check.status === "WARN")) {
    return "WARN";
  }

  return "PASS";
}

export function buildDryRunCompletionNextActions(
  checks: readonly DryRunCompletionSmokeCheck[],
): string[] {
  const actions: string[] = [];
  const checkNames = new Set(checks.map((check) => check.status === "PASS" ? null : check.name));

  if (checkNames.has("dry_run_safety_env")) {
    actions.push("Run this smoke with DRY_RUN, live orders disabled, Telegram transport disabled, and scheduler startup disabled.");
  }

  if (checkNames.has("execution_state") || checkNames.has("execution_state_seed")) {
    actions.push("Inspect /status and use the intended DRY_RUN DATABASE_PATH before treating validation as complete.");
  }

  if (checkNames.has("upbit_read_credentials")) {
    actions.push("Configure UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY in the local completion smoke script.");
  }

  if (checkNames.has("telegram_credentials")) {
    actions.push("Configure TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_CHAT_ID in the local completion smoke script.");
  }

  if (checkNames.has("balance_snapshot") || checkNames.has("position_snapshot") || checkNames.has("latest_reconciliation")) {
    actions.push("Run smoke:dryrun:sync against the same DATABASE_PATH, then rerun dry-run completion.");
  }

  if (checkNames.has("active_orders") || checkNames.has("scheduler_order_states")) {
    actions.push("Inspect /orders and /order <id|identifier> until active or recovery-required local orders are resolved.");
  }

  if (checkNames.has("recent_risk_blocks")) {
    actions.push("Inspect /risks and resolve recent BLOCK risk evidence before proceeding.");
  }

  if (checkNames.has("pending_notifications")) {
    actions.push("Inspect /alerts and clear or deliver pending operator notifications.");
  }

  if (checkNames.has("scheduler_latest_runs")) {
    actions.push("Start the local DRY_RUN scheduler launcher with the same DATABASE_PATH, confirm /scheduler for BTC and ETH completion, then rerun this smoke.");
  }

  return actions.length === 0
    ? [
      "DRY_RUN automatic execution evidence passed. Next stage is live-readiness validation only after explicit live intent; this smoke did not enable live orders.",
    ]
    : actions;
}

export function buildSchedulerMarketEvidence(
  schedulerRuns: readonly StrategySchedulerRunRecord[],
): DryRunCompletionSchedulerMarketEvidence[] {
  return SUPPORTED_MARKETS.map((market) => {
    const latestRun = schedulerRuns.find((run) => run.market === market) ?? null;

    return {
      market,
      latestRunStartedAt: latestRun?.startedAt ?? null,
      latestRunCompletedAt: latestRun?.completedAt ?? null,
      latestRunStatus: latestRun?.status ?? null,
      runOnStart: latestRun?.runOnStart ?? null,
      action: latestRun?.action ?? null,
      orderId: latestRun?.orderId ?? null,
      orderStatus: latestRun?.orderStatus ?? null,
      submissionAccepted: latestRun?.submissionAccepted ?? null,
      detail: latestRun?.detail ?? null,
      errorMessage: latestRun?.errorMessage ?? null,
    };
  });
}

function classifyLatestReconciliation(input: {
  latestReconciliationRun: Pick<ReconciliationRunRecord, "status" | "completedAt"> | null;
  latestReconciliationBlockingIssueCodes: string[];
}): DryRunCompletionSmokeStatus {
  if (!input.latestReconciliationRun) {
    return "BLOCK";
  }

  if (input.latestReconciliationBlockingIssueCodes.length > 0) {
    return "BLOCK";
  }

  return input.latestReconciliationRun.status === "SUCCESS" ? "PASS" : "BLOCK";
}

function describeLatestReconciliation(input: {
  latestReconciliationRun: Pick<ReconciliationRunRecord, "status" | "completedAt"> | null;
  latestReconciliationIssueCodes: string[];
  latestReconciliationBlockingIssueCodes: string[];
}): string {
  if (!input.latestReconciliationRun) {
    return "No reconciliation run is stored; run exchange-backed DRY_RUN sync against this DATABASE_PATH first.";
  }

  const issueCodes = input.latestReconciliationIssueCodes.length === 0
    ? "none"
    : input.latestReconciliationIssueCodes.join(",");
  if (input.latestReconciliationBlockingIssueCodes.length > 0) {
    return `latest reconciliation status=${input.latestReconciliationRun.status} ` +
      `completed_at=${input.latestReconciliationRun.completedAt ?? "none"} ` +
      `blocking_issue_codes=${input.latestReconciliationBlockingIssueCodes.join(",")} issue_codes=${issueCodes}`;
  }

  if (input.latestReconciliationRun.status !== "SUCCESS") {
    return `latest reconciliation status=${input.latestReconciliationRun.status} ` +
      `completed_at=${input.latestReconciliationRun.completedAt ?? "none"} issue_codes=${issueCodes}`;
  }

  return `latest reconciliation status=${input.latestReconciliationRun.status} ` +
    `completed_at=${input.latestReconciliationRun.completedAt ?? "none"} issue_codes=${issueCodes}`;
}

function classifySchedulerLatestRuns(
  evidence: readonly DryRunCompletionSchedulerMarketEvidence[],
): DryRunCompletionSmokeStatus {
  return evidence.every((market) =>
    market.latestRunStatus === "COMPLETED" &&
    market.latestRunCompletedAt !== null &&
    market.errorMessage === null
  )
    ? "PASS"
    : "BLOCK";
}

function describeSchedulerLatestRuns(
  evidence: readonly DryRunCompletionSchedulerMarketEvidence[],
): string {
  const summaries = evidence.map((market) =>
    `${market.market}:status=${market.latestRunStatus ?? "missing"} ` +
    `completed_at=${market.latestRunCompletedAt ?? "none"} ` +
    `run_on_start=${market.runOnStart ?? "none"} action=${market.action ?? "none"} ` +
    `order=${market.orderId ?? "none"} error=${market.errorMessage ?? "none"}`
  );

  return `latest scheduler evidence: ${summaries.join("; ")}`;
}

function classifySchedulerOrderStates(
  evidence: readonly DryRunCompletionSchedulerMarketEvidence[],
): DryRunCompletionSmokeStatus {
  return evidence.some((market) => market.orderStatus !== null && ACTIVE_ORDER_STATUSES.has(market.orderStatus))
    ? "BLOCK"
    : "PASS";
}

function describeSchedulerOrderStates(
  evidence: readonly DryRunCompletionSchedulerMarketEvidence[],
): string {
  const activeOrderMarkets = evidence
    .filter((market) => market.orderStatus !== null && ACTIVE_ORDER_STATUSES.has(market.orderStatus))
    .map((market) => `${market.market}:${market.orderId ?? "unknown"}:${market.orderStatus}`);

  return activeOrderMarkets.length === 0
    ? "Latest scheduler runs have no active local order state."
    : `Latest scheduler runs reference active local order state: ${activeOrderMarkets.join(",")}.`;
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
    : `Execution state blocks DRY_RUN completion: ${blockers.join(",")}.`;
}

function countRiskBlocks(events: readonly { level: string }[]): number {
  return events.filter((event) => event.level === "BLOCK").length;
}

function hasTelegramCredentials(config: AppConfig): boolean {
  return Boolean(config.telegramBotToken && config.telegramOperatorChatId);
}

function createNonMutationBoundary(): NonMutationBoundary {
  return {
    orders: false,
    strategy: false,
    sync: false,
    scheduler: false,
    telegramPolling: false,
    telegramDelivery: false,
    exchangeProbe: false,
    orderTransmission: false,
  };
}

function getCheckNamesByStatus(
  checks: readonly DryRunCompletionSmokeCheck[],
  status: DryRunCompletionSmokeStatus,
): string[] {
  return checks.filter((check) => check.status === status).map((check) => check.name);
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

if (isMainModule()) {
  const result = await runDryRunCompletionSmoke();
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "BLOCK") {
    process.exitCode = 1;
  }
}
