import { pathToFileURL } from "node:url";

import { createApp } from "../app/create-app.js";
import { loadAppConfig, type AppConfig } from "../app/env.js";
import type { RuntimeOwnershipAuthority } from "../app/runtime-ownership-guard.js";
import { runWithScopedRuntimeOwnership } from "../app/scoped-runtime-ownership.js";
import type {
  TelegramInboundPollingStatus,
  TelegramInboundPollSummary,
} from "../modules/telegram/inbound.js";

const FORCED_TELEGRAM_INBOUND_SMOKE_ENV = {
  APP_EXECUTION_MODE: "DRY_RUN",
  ENABLE_LIVE_ORDERS: "false",
  STRATEGY_SCHEDULER_ENABLED: "false",
  STRATEGY_SCHEDULER_RUN_ON_START: "false",
  ENABLE_TELEGRAM_INBOUND_POLLING: "true",
  TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS: "0",
  TELEGRAM_INBOUND_POLL_LIMIT: "1",
} as const;

type TelegramInboundSmokeEnvKey = keyof typeof FORCED_TELEGRAM_INBOUND_SMOKE_ENV;

export interface TelegramInboundSmokeEnvReport {
  readonly forced: Record<TelegramInboundSmokeEnvKey, string>;
  readonly previous: Record<TelegramInboundSmokeEnvKey, string | undefined>;
}

export interface TelegramInboundSmokeResult {
  readonly service: string;
  readonly status: "COMPLETED" | "SKIPPED" | "FAILED" | "BLOCKED";
  readonly executionMode: AppConfig["executionMode"];
  readonly liveExecutionGate: AppConfig["liveExecutionGate"];
  readonly liveSendPath: "DRY_RUN_ADAPTER";
  readonly schedulerEnabled: boolean;
  readonly schedulerRunOnStart: boolean;
  readonly telegramInboundPollingEnabled: boolean;
  readonly telegramInboundPollingConfigured: boolean;
  readonly telegramBotTokenConfigured: boolean;
  readonly telegramOperatorChatIdConfigured: boolean;
  readonly safetyEnv: TelegramInboundSmokeEnvReport;
  readonly safetyBlockers: string[];
  readonly before: TelegramInboundPollingStatus | null;
  readonly summary: TelegramInboundPollSummary | null;
  readonly after: TelegramInboundPollingStatus | null;
}

export interface TelegramInboundSmokeOperations {
  createApplication(
    config: AppConfig,
    overrides: { readonly runtimeOwnershipAuthority: RuntimeOwnershipAuthority },
  ): ReturnType<typeof createApp>;
  runWithScopedRuntimeOwnership: typeof runWithScopedRuntimeOwnership;
}

export function applyTelegramInboundSmokeSafetyEnv(
  env: NodeJS.ProcessEnv = process.env,
): TelegramInboundSmokeEnvReport {
  const previous = {} as Record<TelegramInboundSmokeEnvKey, string | undefined>;

  for (const key of Object.keys(FORCED_TELEGRAM_INBOUND_SMOKE_ENV) as TelegramInboundSmokeEnvKey[]) {
    previous[key] = env[key];
    env[key] = FORCED_TELEGRAM_INBOUND_SMOKE_ENV[key];
  }

  return {
    forced: { ...FORCED_TELEGRAM_INBOUND_SMOKE_ENV },
    previous,
  };
}

export function validateTelegramInboundSmokeSafety(
  config: Pick<
    AppConfig,
    | "executionMode"
    | "liveExecutionGate"
    | "strategySchedulerEnabled"
    | "strategySchedulerRunOnStart"
    | "telegramInboundPollingEnabled"
    | "telegramInboundPollTimeoutSeconds"
    | "telegramInboundPollLimit"
  >,
): string[] {
  const blockers: string[] = [];

  if (config.executionMode !== "DRY_RUN") {
    blockers.push("APP_EXECUTION_MODE must resolve to DRY_RUN for telegram inbound smoke.");
  }

  if (config.liveExecutionGate !== "DISABLED") {
    blockers.push("ENABLE_LIVE_ORDERS must resolve to DISABLED for telegram inbound smoke.");
  }

  if (config.strategySchedulerEnabled) {
    blockers.push("STRATEGY_SCHEDULER_ENABLED must be false for telegram inbound smoke.");
  }

  if (config.strategySchedulerRunOnStart) {
    blockers.push("STRATEGY_SCHEDULER_RUN_ON_START must be false for telegram inbound smoke.");
  }

  if (!config.telegramInboundPollingEnabled) {
    blockers.push("ENABLE_TELEGRAM_INBOUND_POLLING must be true for telegram inbound smoke.");
  }

  if (config.telegramInboundPollTimeoutSeconds !== 0) {
    blockers.push("TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS must be 0 for a non-blocking smoke poll.");
  }

  if (config.telegramInboundPollLimit !== 1) {
    blockers.push("TELEGRAM_INBOUND_POLL_LIMIT must be 1 for a bounded smoke poll.");
  }

  return blockers;
}

export async function runTelegramInboundSmokeOnce(
  overrides: Partial<TelegramInboundSmokeOperations> = {},
): Promise<TelegramInboundSmokeResult> {
  const safetyEnv = applyTelegramInboundSmokeSafetyEnv();
  const config = loadAppConfig();
  const createApplication = overrides.createApplication ?? ((appConfig, appOverrides) =>
    createApp(appConfig, appOverrides));
  const runOwned = overrides.runWithScopedRuntimeOwnership ?? runWithScopedRuntimeOwnership;

  return runOwned(config, async (runtimeOwnershipAuthority) => {
    const app = createApplication(config, { runtimeOwnershipAuthority });
    let before: TelegramInboundPollingStatus | null = null;
    let summary: TelegramInboundPollSummary | null = null;
    let after: TelegramInboundPollingStatus | null = null;

    try {
      before = app.telegramInboundPolling.getStatus();
      const safetyBlockers = validateTelegramInboundSmokeSafety(app.config);

      if (safetyBlockers.length > 0) {
        after = app.telegramInboundPolling.getStatus();
        return buildResult({
          app,
          status: "BLOCKED",
          safetyEnv,
          safetyBlockers,
          before,
          summary,
          after,
        });
      }

      summary = await app.telegramInboundPolling.pollOnce();
      after = app.telegramInboundPolling.getStatus();

      return buildResult({
        app,
        status: summary.status,
        safetyEnv,
        safetyBlockers,
        before,
        summary,
        after,
      });
    } finally {
      app.telegramInboundPolling.stop();
      app.strategyScheduler.stop();
      app.persistence.close();
    }
  });
}

function buildResult(input: {
  app: ReturnType<typeof createApp>;
  status: TelegramInboundSmokeResult["status"];
  safetyEnv: TelegramInboundSmokeEnvReport;
  safetyBlockers: string[];
  before: TelegramInboundPollingStatus | null;
  summary: TelegramInboundPollSummary | null;
  after: TelegramInboundPollingStatus | null;
}): TelegramInboundSmokeResult {
  return {
    service: input.app.config.serviceName,
    status: input.status,
    executionMode: input.app.config.executionMode,
    liveExecutionGate: input.app.config.liveExecutionGate,
    liveSendPath: "DRY_RUN_ADAPTER",
    schedulerEnabled: input.app.config.strategySchedulerEnabled,
    schedulerRunOnStart: input.app.config.strategySchedulerRunOnStart,
    telegramInboundPollingEnabled: input.app.config.telegramInboundPollingEnabled,
    telegramInboundPollingConfigured: input.app.telegramInboundPolling.isConfigured(),
    telegramBotTokenConfigured: Boolean(input.app.config.telegramBotToken),
    telegramOperatorChatIdConfigured: Boolean(input.app.config.telegramOperatorChatId),
    safetyEnv: input.safetyEnv,
    safetyBlockers: input.safetyBlockers,
    before: input.before,
    summary: input.summary,
    after: input.after,
  };
}

function isMainModule(): boolean {
  return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
}

if (isMainModule()) {
  const result = await runTelegramInboundSmokeOnce();
  console.log(JSON.stringify(result, null, 2));

  if (result.status === "BLOCKED" || result.status === "FAILED") {
    process.exitCode = 1;
  }
}
