import { pathToFileURL } from "node:url";

import { createApp, type AppServices } from "../app/create-app.js";
import { loadAppConfig, type AppConfig } from "../app/env.js";
import type { RuntimeOwnershipAuthority } from "../app/runtime-ownership-guard.js";
import { runWithScopedRuntimeOwnership } from "../app/scoped-runtime-ownership.js";

type DryRunSyncSmokeStatus = "PASS" | "WARN" | "BLOCK" | "SKIPPED";
type DryRunSyncSmokeEnvKey = keyof typeof FORCED_DRY_RUN_SYNC_ENV;
type NonMutationBoundary = Record<
  | "orders"
  | "strategy"
  | "scheduler"
  | "telegramPolling"
  | "telegramDelivery"
  | "orderTransmission",
  false
>;

const FORCED_DRY_RUN_SYNC_ENV = {
  APP_EXECUTION_MODE: "DRY_RUN",
  ENABLE_LIVE_ORDERS: "false",
  ENABLE_TELEGRAM_DELIVERY: "false",
  ENABLE_TELEGRAM_INBOUND_POLLING: "false",
  STRATEGY_SCHEDULER_ENABLED: "false",
  STRATEGY_SCHEDULER_RUN_ON_START: "false",
} as const;

const DEFAULT_DRY_RUN_SYNC_DATABASE_PATH = "./var/dryrun-sync-smoke.sqlite";

interface CommandExpectation {
  readonly command: string;
  readonly requiredPatterns: readonly RegExp[];
  readonly warnPatterns?: readonly RegExp[];
  readonly blockPatterns?: readonly RegExp[];
}

const COMMAND_EXPECTATIONS: readonly CommandExpectation[] = [
  {
    command: "/config",
    requiredPatterns: [
      /Runtime Config/u,
      /execution_mode: DRY_RUN/u,
      /live_send_path: DRY_RUN_ADAPTER/u,
      /exchange_backed_read_enabled: true/u,
    ],
  },
  {
    command: "/sync",
    requiredPatterns: [
      /동기화 요청 완료/u,
      /status: COMPLETED/u,
      /reconciliation_source=OPERATOR_SYNC/u,
    ],
  },
  {
    command: "/balances",
    requiredPatterns: [/Balances Snapshot/u, /source: RECONCILIATION/u],
  },
  {
    command: "/positions",
    requiredPatterns: [/Positions Snapshot/u, /source: RECONCILIATION/u],
  },
  {
    command: "/readiness",
    requiredPatterns: [/Operator Readiness/u],
    warnPatterns: [/overall_status: WARN/u],
    blockPatterns: [/overall_status: BLOCK/u],
  },
  {
    command: "/synchistory",
    requiredPatterns: [/Reconciliation History/u, /source=OPERATOR_SYNC/u],
  },
];

export interface DryRunSyncSmokeEnvReport {
  readonly forced: Record<DryRunSyncSmokeEnvKey, string>;
  readonly previous: Record<DryRunSyncSmokeEnvKey, string | undefined>;
  readonly databasePathDefaulted: boolean;
  readonly databasePath: string;
}

export interface DryRunSyncSmokeCommandResult {
  readonly command: string;
  readonly status: Exclude<DryRunSyncSmokeStatus, "SKIPPED">;
  readonly firstLine: string;
  readonly missingPatterns: string[];
  readonly warningPatterns: string[];
  readonly blockingPatterns: string[];
  readonly error: string | null;
}

export interface DryRunSyncSmokeResult {
  readonly service: string;
  readonly status: DryRunSyncSmokeStatus;
  readonly skippedReason: string | null;
  readonly executionMode: AppConfig["executionMode"];
  readonly liveExecutionGate: AppConfig["liveExecutionGate"];
  readonly liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  readonly databasePath: string;
  readonly exchangeBackedReadEnabled: boolean;
  readonly telegramDeliveryEnabled: boolean;
  readonly telegramInboundPollingEnabled: boolean;
  readonly schedulerEnabled: boolean;
  readonly schedulerRunOnStart: boolean;
  readonly safetyEnv: DryRunSyncSmokeEnvReport;
  readonly nonMutationBoundary: NonMutationBoundary;
  readonly upbitPrivateReadAttempted: boolean;
  readonly syncAttempted: boolean;
  readonly strategyRunAttempted: false;
  readonly schedulerStarted: false;
  readonly telegramPollingStarted: false;
  readonly telegramDeliveryAttempted: false;
  readonly liveOrderTransmissionAttempted: false;
  readonly safetyBlockers: string[];
  readonly blockingCommandNames: string[];
  readonly warningCommandNames: string[];
  readonly nextActions: string[];
  readonly commands: DryRunSyncSmokeCommandResult[];
}

export interface DryRunSyncSmokeOperations {
  createApplication(
    config: AppConfig,
    overrides: { readonly runtimeOwnershipAuthority: RuntimeOwnershipAuthority },
  ): AppServices;
  runWithScopedRuntimeOwnership: typeof runWithScopedRuntimeOwnership;
}

export function applyDryRunSyncSmokeSafetyEnv(
  env: NodeJS.ProcessEnv = process.env,
): DryRunSyncSmokeEnvReport {
  const previous = {} as Record<DryRunSyncSmokeEnvKey, string | undefined>;
  for (const key of Object.keys(FORCED_DRY_RUN_SYNC_ENV) as DryRunSyncSmokeEnvKey[]) {
    previous[key] = env[key];
    env[key] = FORCED_DRY_RUN_SYNC_ENV[key];
  }

  const databasePathDefaulted = !env.DATABASE_PATH?.trim();
  if (databasePathDefaulted) {
    env.DATABASE_PATH = DEFAULT_DRY_RUN_SYNC_DATABASE_PATH;
  }
  const databasePath = env.DATABASE_PATH ?? DEFAULT_DRY_RUN_SYNC_DATABASE_PATH;

  return {
    forced: { ...FORCED_DRY_RUN_SYNC_ENV },
    previous,
    databasePathDefaulted,
    databasePath,
  };
}

export function validateDryRunSyncSmokeSafety(input: {
  config: AppConfig;
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
}): string[] {
  const blockers: string[] = [];

  if (input.config.executionMode !== "DRY_RUN") {
    blockers.push("APP_EXECUTION_MODE must resolve to DRY_RUN for dry-run sync smoke.");
  }

  if (input.config.liveExecutionGate !== "DISABLED") {
    blockers.push("ENABLE_LIVE_ORDERS must resolve to DISABLED for dry-run sync smoke.");
  }

  if (input.liveSendPath !== "DRY_RUN_ADAPTER") {
    blockers.push("liveSendPath must remain DRY_RUN_ADAPTER for dry-run sync smoke.");
  }

  if (input.config.telegramDeliveryEnabled) {
    blockers.push("ENABLE_TELEGRAM_DELIVERY must be false for dry-run sync smoke.");
  }

  if (input.config.telegramInboundPollingEnabled) {
    blockers.push("ENABLE_TELEGRAM_INBOUND_POLLING must be false for dry-run sync smoke.");
  }

  if (input.config.strategySchedulerEnabled) {
    blockers.push("STRATEGY_SCHEDULER_ENABLED must be false for dry-run sync smoke.");
  }

  if (input.config.strategySchedulerRunOnStart) {
    blockers.push("STRATEGY_SCHEDULER_RUN_ON_START must be false for dry-run sync smoke.");
  }

  return blockers;
}

export async function runDryRunSyncSmoke(
  overrides: Partial<DryRunSyncSmokeOperations> = {},
): Promise<DryRunSyncSmokeResult> {
  const safetyEnv = applyDryRunSyncSmokeSafetyEnv();
  const config = loadAppConfig();
  const createApplication = overrides.createApplication ?? ((appConfig, appOverrides) =>
    createApp(appConfig, appOverrides));
  const runOwned = overrides.runWithScopedRuntimeOwnership ?? runWithScopedRuntimeOwnership;

  return runOwned(config, async (runtimeOwnershipAuthority) => {
    const app = createApplication(config, { runtimeOwnershipAuthority });

    try {
      return await buildDryRunSyncSmokeResult(app, safetyEnv);
    } finally {
      app.telegramInboundPolling.stop();
      app.strategyScheduler.stop();
      app.persistence.close();
    }
  });
}

export async function buildDryRunSyncSmokeResult(
  app: {
    config: AppConfig;
    exchangeBackedReadEnabled: boolean;
    liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
    telegramRouter: { route(input: string): Promise<{ text: string }> };
  },
  safetyEnv: DryRunSyncSmokeEnvReport,
): Promise<DryRunSyncSmokeResult> {
  const safetyBlockers = validateDryRunSyncSmokeSafety({
    config: app.config,
    liveSendPath: app.liveSendPath,
  });
  const skippedReason = !app.exchangeBackedReadEnabled
    ? "UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY are required for exchange-backed DRY_RUN sync smoke."
    : null;
  const commands = safetyBlockers.length === 0 && skippedReason === null
    ? await runSyncSmokeCommands(app.telegramRouter)
    : [];
  const status = summarizeDryRunSyncSmokeStatus({
    safetyBlockers,
    skippedReason,
    commands,
  });

  return {
    service: app.config.serviceName,
    status,
    skippedReason,
    executionMode: app.config.executionMode,
    liveExecutionGate: app.config.liveExecutionGate,
    liveSendPath: app.liveSendPath,
    databasePath: app.config.databasePath,
    exchangeBackedReadEnabled: app.exchangeBackedReadEnabled,
    telegramDeliveryEnabled: app.config.telegramDeliveryEnabled,
    telegramInboundPollingEnabled: app.config.telegramInboundPollingEnabled,
    schedulerEnabled: app.config.strategySchedulerEnabled,
    schedulerRunOnStart: app.config.strategySchedulerRunOnStart,
    safetyEnv,
    nonMutationBoundary: createNonMutationBoundary(),
    upbitPrivateReadAttempted: safetyBlockers.length === 0 && skippedReason === null,
    syncAttempted: commands.some((command) => command.command === "/sync"),
    strategyRunAttempted: false,
    schedulerStarted: false,
    telegramPollingStarted: false,
    telegramDeliveryAttempted: false,
    liveOrderTransmissionAttempted: false,
    safetyBlockers,
    blockingCommandNames: getCommandNamesByStatus(commands, "BLOCK"),
    warningCommandNames: getCommandNamesByStatus(commands, "WARN"),
    nextActions: buildDryRunSyncNextActions({ safetyBlockers, skippedReason, commands }),
    commands,
  };
}

async function runSyncSmokeCommands(
  router: { route(input: string): Promise<{ text: string }> },
): Promise<DryRunSyncSmokeCommandResult[]> {
  const results: DryRunSyncSmokeCommandResult[] = [];

  for (const expectation of COMMAND_EXPECTATIONS) {
    try {
      const response = await router.route(expectation.command);
      const missingPatterns = expectation.requiredPatterns
        .filter((pattern) => !pattern.test(response.text))
        .map((pattern) => pattern.source);
      const warningPatterns = (expectation.warnPatterns ?? [])
        .filter((pattern) => pattern.test(response.text))
        .map((pattern) => pattern.source);
      const blockingPatterns = (expectation.blockPatterns ?? [])
        .filter((pattern) => pattern.test(response.text))
        .map((pattern) => pattern.source);

      results.push({
        command: expectation.command,
        status: classifyCommandResult({ missingPatterns, warningPatterns, blockingPatterns }),
        firstLine: response.text.split("\n")[0] ?? "",
        missingPatterns,
        warningPatterns,
        blockingPatterns,
        error: null,
      });
    } catch (error) {
      results.push({
        command: expectation.command,
        status: "BLOCK",
        firstLine: "",
        missingPatterns: [],
        warningPatterns: [],
        blockingPatterns: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

function classifyCommandResult(input: {
  missingPatterns: readonly string[];
  warningPatterns: readonly string[];
  blockingPatterns: readonly string[];
}): Exclude<DryRunSyncSmokeStatus, "SKIPPED"> {
  if (input.missingPatterns.length > 0 || input.blockingPatterns.length > 0) {
    return "BLOCK";
  }

  if (input.warningPatterns.length > 0) {
    return "WARN";
  }

  return "PASS";
}

function summarizeDryRunSyncSmokeStatus(input: {
  safetyBlockers: readonly string[];
  skippedReason: string | null;
  commands: readonly DryRunSyncSmokeCommandResult[];
}): DryRunSyncSmokeStatus {
  if (input.safetyBlockers.length > 0 || input.commands.some((command) => command.status === "BLOCK")) {
    return "BLOCK";
  }

  if (input.skippedReason) {
    return "SKIPPED";
  }

  if (input.commands.some((command) => command.status === "WARN")) {
    return "WARN";
  }

  return "PASS";
}

function buildDryRunSyncNextActions(input: {
  safetyBlockers: readonly string[];
  skippedReason: string | null;
  commands: readonly DryRunSyncSmokeCommandResult[];
}): string[] {
  const actions: string[] = [];

  if (input.safetyBlockers.length > 0) {
    actions.push("Keep APP_EXECUTION_MODE=DRY_RUN, ENABLE_LIVE_ORDERS=false, Telegram delivery/inbound disabled, and scheduler disabled for this smoke.");
  }

  if (input.skippedReason) {
    actions.push("Configure UPBIT_ACCESS_KEY and UPBIT_SECRET_KEY in the local DRY_RUN sync smoke script, then rerun it.");
  }

  for (const command of input.commands) {
    if (command.status === "BLOCK") {
      actions.push(`Inspect ${command.command}: ${command.error ?? command.missingPatterns.concat(command.blockingPatterns).join(",")}`);
    }
  }

  if (input.commands.some((command) => command.status === "WARN")) {
    actions.push("Review /readiness warnings before starting the long-running DRY_RUN runtime.");
  }

  return actions.length === 0
    ? ["Exchange-backed DRY_RUN sync passed. Start the local DRY_RUN runtime and run Telegram operator checks."]
    : actions;
}

function createNonMutationBoundary(): NonMutationBoundary {
  return {
    orders: false,
    strategy: false,
    scheduler: false,
    telegramPolling: false,
    telegramDelivery: false,
    orderTransmission: false,
  };
}

function getCommandNamesByStatus(
  commands: readonly DryRunSyncSmokeCommandResult[],
  status: Exclude<DryRunSyncSmokeStatus, "SKIPPED">,
): string[] {
  return commands.filter((command) => command.status === status).map((command) => command.command);
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

if (isMainModule()) {
  const result = await runDryRunSyncSmoke();
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "BLOCK") {
    process.exitCode = 1;
  }
}
