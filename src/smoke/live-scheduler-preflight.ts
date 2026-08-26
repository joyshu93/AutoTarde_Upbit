import { pathToFileURL } from "node:url";

import type { AppServices } from "../app/create-app.js";
import type { AppConfig } from "../app/env.js";
import {
  createRuntimeShutdown,
  runRuntimeStartupGate,
  type RuntimeStopSummary,
} from "../app/runtime-lifecycle.js";
import { buildStrategySchedulerStartupPreflight } from "../app/scheduler-preflight.js";
import type { StrategySchedulerStartupPreflight } from "../domain/types.js";
import { openLiveReadOnlyContext } from "./live-readonly-context.js";

type LiveSchedulerPreflightSmokeStatus = "PASS" | "WARN" | "BLOCK";
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

const READ_ONLY_DATA_SOURCES = [
  "runtime_config",
  "execution_state",
  "orders",
  "balance_snapshots",
  "position_snapshots",
  "reconciliation_runs",
] as const;

export interface LiveSchedulerPreflightSmokeCheck {
  readonly name: string;
  readonly status: LiveSchedulerPreflightSmokeStatus;
  readonly detail: string;
}

export interface LiveSchedulerPreflightSmokeResult {
  readonly service: string;
  readonly status: LiveSchedulerPreflightSmokeStatus;
  readonly executionMode: AppConfig["executionMode"];
  readonly liveExecutionGate: AppConfig["liveExecutionGate"];
  readonly liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  readonly databasePath: string;
  readonly exchangeBackedReadEnabled: boolean;
  readonly configuredSchedulerEnabled: boolean;
  readonly configuredSchedulerRunOnStart: boolean;
  readonly preflightAssumesSchedulerEnabled: true;
  readonly preflightAssumesRunOnStart: false;
  readonly nonMutationBoundary: NonMutationBoundary;
  readonly orderTransmissionAttempted: false;
  readonly strategyRunAttempted: false;
  readonly syncAttempted: false;
  readonly schedulerStarted: false;
  readonly telegramPollingStarted: false;
  readonly exchangeProbeAttempted: false;
  readonly notificationDeliveryAttempted: false;
  readonly readOnlyDataSources: typeof READ_ONLY_DATA_SOURCES;
  readonly schedulerWouldInstallTimers: boolean;
  readonly blockingCheckNames: string[];
  readonly warningCheckNames: string[];
  readonly nextActions: string[];
  readonly preflight: StrategySchedulerStartupPreflight;
  readonly checks: LiveSchedulerPreflightSmokeCheck[];
}

export async function runLiveSchedulerPreflightSmoke(): Promise<LiveSchedulerPreflightSmokeResult> {
  const context = openLiveReadOnlyContext();
  try {
    return await buildLiveSchedulerPreflightSmokeResult(context);
  } finally {
    context.close();
  }
}

export async function runLiveSchedulerPreflightSmokeWithApplicationForTest(
  createApplication: () => AppServices,
): Promise<LiveSchedulerPreflightSmokeResult> {
  const app = createApplication();
  const runtimeShutdown = createRuntimeShutdown(app);
  let primaryFailure = false;

  try {
    return await runRuntimeStartupGate({
      initializer: app.candidatePilotInitializer,
      shutdown: runtimeShutdown,
      continueStartup: () => buildLiveSchedulerPreflightSmokeResult(app),
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

export async function buildLiveSchedulerPreflightSmokeResult(
  app: Pick<
    AppServices,
    | "config"
    | "operatorState"
    | "repositories"
    | "exchangeBackedReadEnabled"
    | "liveSendPath"
  >,
): Promise<LiveSchedulerPreflightSmokeResult> {
  const executionState = await app.operatorState.getState();
  const preflightConfig = createSchedulerPreflightConfig(app.config);
  const preflight = await buildStrategySchedulerStartupPreflight({
    config: preflightConfig,
    exchangeAccountId: "primary",
    executionState,
    repositories: app.repositories,
    exchangeBackedReadEnabled: app.exchangeBackedReadEnabled,
    liveSendPath: app.liveSendPath,
  });
  const checks = buildLiveSchedulerPreflightSmokeChecks({
    app,
    preflight,
  });
  const status = summarizeLiveSchedulerPreflightSmokeStatus(checks);

  return {
    service: app.config.serviceName,
    status,
    executionMode: app.config.executionMode,
    liveExecutionGate: app.config.liveExecutionGate,
    liveSendPath: app.liveSendPath,
    databasePath: app.config.databasePath,
    exchangeBackedReadEnabled: app.exchangeBackedReadEnabled,
    configuredSchedulerEnabled: app.config.strategySchedulerEnabled,
    configuredSchedulerRunOnStart: app.config.strategySchedulerRunOnStart,
    preflightAssumesSchedulerEnabled: true,
    preflightAssumesRunOnStart: false,
    nonMutationBoundary: createNonMutationBoundary(),
    orderTransmissionAttempted: false,
    strategyRunAttempted: false,
    syncAttempted: false,
    schedulerStarted: false,
    telegramPollingStarted: false,
    exchangeProbeAttempted: false,
    notificationDeliveryAttempted: false,
    readOnlyDataSources: READ_ONLY_DATA_SOURCES,
    schedulerWouldInstallTimers: preflight.status !== "BLOCK",
    blockingCheckNames: getCheckNamesByStatus(checks, "BLOCK"),
    warningCheckNames: getCheckNamesByStatus(checks, "WARN"),
    nextActions: buildLiveSchedulerPreflightNextActions(checks),
    preflight,
    checks,
  };
}

export function createSchedulerPreflightConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    strategySchedulerEnabled: true,
    strategySchedulerRunOnStart: false,
  };
}

export function buildLiveSchedulerPreflightSmokeChecks(input: {
  app: Pick<AppServices, "config" | "exchangeBackedReadEnabled" | "liveSendPath">;
  preflight: StrategySchedulerStartupPreflight;
}): LiveSchedulerPreflightSmokeCheck[] {
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
        : "APP_EXECUTION_MODE must resolve to LIVE for live scheduler preflight.",
    },
    {
      name: "preflight_scope",
      status: input.preflight.scope === "LIVE" ? "PASS" : "BLOCK",
      detail: `scheduler startup preflight scope=${input.preflight.scope}`,
    },
    {
      name: "run_on_start_boundary",
      status: "PASS",
      detail: "This smoke assumes STRATEGY_SCHEDULER_RUN_ON_START=false and does not request an immediate scheduler tick.",
    },
    {
      name: "scheduler_startup_preflight",
      status: normalizePreflightStatus(input.preflight.status),
      detail: input.preflight.detail,
    },
    ...input.preflight.checks.map((check) => ({
      name: `preflight:${check.name}`,
      status: normalizePreflightStatus(check.status),
      detail: check.detail,
    })),
  ];
}

export function summarizeLiveSchedulerPreflightSmokeStatus(
  checks: readonly LiveSchedulerPreflightSmokeCheck[],
): LiveSchedulerPreflightSmokeStatus {
  if (checks.some((check) => check.status === "BLOCK")) {
    return "BLOCK";
  }

  if (checks.some((check) => check.status === "WARN")) {
    return "WARN";
  }

  return "PASS";
}

export function buildLiveSchedulerPreflightNextActions(
  checks: readonly LiveSchedulerPreflightSmokeCheck[],
): string[] {
  const actions: string[] = [];
  const checkNames = new Set(checks.map((check) => check.status === "PASS" ? null : check.name));

  if (checkNames.has("live_mode") || checkNames.has("preflight_scope")) {
    actions.push("Run this smoke with APP_EXECUTION_MODE=LIVE in the local live scheduler environment.");
  }

  for (const check of checks) {
    if (check.status !== "BLOCK" || !check.name.startsWith("preflight:")) {
      continue;
    }

    actions.push(`Resolve scheduler preflight blocker ${check.name.replace("preflight:", "")}: ${check.detail}`);
  }

  if (checkNames.has("scheduler_startup_preflight")) {
    const schedulerCheck = checks.find((check) => check.name === "scheduler_startup_preflight");
    if (schedulerCheck?.status === "WARN") {
      actions.push("Review scheduler preflight warnings, then decide explicitly whether to start the live scheduler.");
    }
  }

  return actions.length === 0
    ? ["Live scheduler preflight has no blockers or warnings. Start the scheduler only with an explicit local script change."]
    : actions;
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

function normalizePreflightStatus(
  status: StrategySchedulerStartupPreflight["status"] | StrategySchedulerStartupPreflight["checks"][number]["status"],
): LiveSchedulerPreflightSmokeStatus {
  return status === "NOT_REQUIRED" ? "BLOCK" : status;
}

function getCheckNamesByStatus(
  checks: readonly LiveSchedulerPreflightSmokeCheck[],
  status: LiveSchedulerPreflightSmokeStatus,
): string[] {
  return checks.filter((check) => check.status === status).map((check) => check.name);
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

if (isMainModule()) {
  const result = await runLiveSchedulerPreflightSmoke();
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "BLOCK") {
    process.exitCode = 1;
  }
}
