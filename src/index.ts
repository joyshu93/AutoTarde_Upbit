import { fileURLToPath } from "node:url";

import { createApp, type AppServices } from "./app/create-app.js";
import {
  hasBackgroundRuntime,
  createRuntimeShutdown,
  installRuntimeSignalHandlers,
  runRuntimeStartupGate,
} from "./app/runtime-lifecycle.js";
import { buildStrategySchedulerStartupPreflight } from "./app/scheduler-preflight.js";
import { applyStartupRecoveryPolicy, runStartupRecovery } from "./app/startup-recovery.js";
import { detectExecutionStateSeedMismatches } from "./modules/db/interfaces.js";
import type { TelegramCommandMenuSetupResult } from "./modules/telegram/setup.js";

export interface TelegramRuntimeStartupResult {
  readonly strategySchedulerStatus: { readonly started: boolean };
  readonly strategySchedulerStartupBlockNotified: boolean;
  readonly telegramInboundPollingStatus: { readonly running: boolean };
  readonly telegramCommandMenuSetup: TelegramCommandMenuSetupResult;
}

export interface AppStartupOperations {
  readonly runStartupRecovery?: typeof runStartupRecovery;
  readonly applyStartupRecoveryPolicy?: typeof applyStartupRecoveryPolicy;
  readonly buildStrategySchedulerStartupPreflight?: typeof buildStrategySchedulerStartupPreflight;
  readonly installRuntimeSignalHandlers?: typeof installRuntimeSignalHandlers;
  readonly startTelegramRuntime?: typeof startTelegramRuntime;
  readonly writeBanner?: (banner: unknown) => void;
}

export async function startTelegramRuntime(input: {
  strategyScheduler: {
    start(): { readonly started: boolean };
    reportStartupBlockIfNeeded(): Promise<boolean>;
  };
  telegramInboundPolling: {
    start(): { readonly running: boolean };
  };
  installRuntimeSignalHandlers(): void;
  telegramCommandMenuSetup: {
    setup(): Promise<TelegramCommandMenuSetupResult>;
  };
}): Promise<TelegramRuntimeStartupResult> {
  const strategySchedulerStatus = input.strategyScheduler.start();
  const strategySchedulerStartupBlockNotified =
    await input.strategyScheduler.reportStartupBlockIfNeeded();
  const telegramInboundPollingStatus = input.telegramInboundPolling.start();
  if (hasBackgroundRuntime({
    strategyScheduler: strategySchedulerStatus,
    telegramInboundPolling: telegramInboundPollingStatus,
  })) {
    input.installRuntimeSignalHandlers();
  }
  const telegramCommandMenuSetup = await input.telegramCommandMenuSetup.setup();

  return {
    strategySchedulerStatus,
    strategySchedulerStartupBlockNotified,
    telegramInboundPollingStatus,
    telegramCommandMenuSetup,
  };
}

export async function runAppStartup(
  app: AppServices,
  operations: AppStartupOperations = {},
): Promise<void> {
  const runStartupRecoveryOperation = operations.runStartupRecovery ?? runStartupRecovery;
  const applyStartupRecoveryPolicyOperation =
    operations.applyStartupRecoveryPolicy ?? applyStartupRecoveryPolicy;
  const buildStrategySchedulerStartupPreflightOperation =
    operations.buildStrategySchedulerStartupPreflight ?? buildStrategySchedulerStartupPreflight;
  const installRuntimeSignalHandlersOperation =
    operations.installRuntimeSignalHandlers ?? installRuntimeSignalHandlers;
  const startTelegramRuntimeOperation = operations.startTelegramRuntime ?? startTelegramRuntime;
  const writeBanner = operations.writeBanner ?? ((banner: unknown) => {
    console.log(JSON.stringify(banner, null, 2));
  });
  const runtimeShutdown = createRuntimeShutdown(app);

  await runRuntimeStartupGate({
    initializer: app.candidatePilotStartupAuthority,
    shutdown: runtimeShutdown,
    continueStartup: async () => {
  await app.candidatePilotStartupRecovery?.prepareAndRecover();
  const startupRecovery = await runStartupRecoveryOperation({
    exchangeAccountId: "primary",
    enabled: app.exchangeBackedReadEnabled,
    portfolioSyncService: app.portfolioSyncService,
  });
  const startupRecoveryPolicy = await applyStartupRecoveryPolicyOperation({
    operatorState: app.operatorState,
    recovery: startupRecovery,
  });
  let notificationDeliverySummary:
    | {
        attempted: number;
        sent: number;
        retryScheduled: number;
        failed: number;
        staleLease: number;
        pendingDue: number;
        pendingScheduled: number;
        activeLease: number;
        skippedReason: string | null;
      }
    | {
        attempted: 0;
        sent: 0;
        retryScheduled: 0;
        failed: 0;
        staleLease: 0;
        pendingDue: 0;
        pendingScheduled: 0;
        activeLease: 0;
        skippedReason: string;
      };

  try {
    notificationDeliverySummary = await app.notificationDelivery.deliverPending("primary");
  } catch (error) {
    notificationDeliverySummary = {
      attempted: 0,
      sent: 0,
      retryScheduled: 0,
      failed: 0,
      staleLease: 0,
      pendingDue: 0,
      pendingScheduled: 0,
      activeLease: 0,
      skippedReason: error instanceof Error ? error.message : String(error),
    };
  }

  const state = await app.operatorState.getState();
  const strategySchedulerStartupPreflight = await buildStrategySchedulerStartupPreflightOperation({
    config: app.config,
    exchangeAccountId: "primary",
    executionState: state,
    repositories: app.repositories,
    exchangeBackedReadEnabled: app.exchangeBackedReadEnabled,
    liveSendPath: app.liveSendPath,
  });
  app.strategyScheduler.setStartupPreflight(strategySchedulerStartupPreflight);
  const telegramRuntime = await startTelegramRuntimeOperation({
    strategyScheduler: app.strategyScheduler,
    telegramInboundPolling: app.telegramInboundPolling,
    installRuntimeSignalHandlers: () => installRuntimeSignalHandlersOperation({
      app,
      shutdown: runtimeShutdown,
    }),
    telegramCommandMenuSetup: app.telegramCommandMenuSetup,
  });
  const {
    strategySchedulerStatus,
    strategySchedulerStartupBlockNotified,
    telegramInboundPollingStatus,
    telegramCommandMenuSetup,
  } = telegramRuntime;
  const runtimeHasBackgroundWork = hasBackgroundRuntime({
    strategyScheduler: strategySchedulerStatus,
    telegramInboundPolling: telegramInboundPollingStatus,
  });
  const runtimeShutdownStatus = runtimeHasBackgroundWork
    ? "SIGNAL_HANDLERS_INSTALLED"
    : "NO_BACKGROUND_RUNTIME";
  const seedMismatches = detectExecutionStateSeedMismatches(state, {
    executionMode: app.config.executionMode,
    liveExecutionGate: app.config.liveExecutionGate,
    killSwitchActive: app.config.globalKillSwitch,
  });

  const banner = {
    service: app.config.serviceName,
    stateSource: "persisted execution_state",
    executionMode: state.executionMode,
    liveExecutionGate: state.liveExecutionGate,
    systemStatus: state.systemStatus,
    killSwitchActive: state.killSwitchActive,
    liveSendPath: app.liveSendPath,
    seedMismatches,
    upbitBaseUrl: app.config.upbitBaseUrl,
    databasePath: app.config.databasePath,
    recoveryReader: app.exchangeBackedReadEnabled ? "UPBIT_PRIVATE_READER" : "DISABLED",
    reconciliationMaxOrderLookupsPerRun: app.config.reconciliationMaxOrderLookupsPerRun,
    reconciliationHistoryMaxPagesPerMarket: app.config.reconciliationHistoryMaxPagesPerMarket,
    reconciliationClosedOrderLookbackDays: app.config.reconciliationClosedOrderLookbackDays,
    reconciliationHistoryStopBeforeDays: app.config.reconciliationHistoryStopBeforeDays,
    reconciliationHistoryRetentionAssumptionDays: app.config.reconciliationHistoryRetentionAssumptionDays,
    startupRecovery,
    startupRecoveryPolicy,
    telegramDeliveryEnabled: app.config.telegramDeliveryEnabled,
    telegramDeliveryConfigured: app.notificationDelivery.isConfigured(),
    telegramDeliveryMaxAttempts: app.config.telegramDeliveryMaxAttempts,
    telegramDeliveryBaseBackoffMs: app.config.telegramDeliveryBaseBackoffMs,
    telegramDeliveryMaxBackoffMs: app.config.telegramDeliveryMaxBackoffMs,
    telegramDeliveryLeaseMs: app.config.telegramDeliveryLeaseMs,
    notificationDeliverySummary,
    runtimeHasBackgroundWork,
    runtimeShutdown: runtimeShutdownStatus,
    deprecatedIgnoredEnvVars: app.config.deprecatedIgnoredEnvVars,
    telegramInboundPollingEnabled: app.config.telegramInboundPollingEnabled,
    telegramInboundPollingConfigured: app.telegramInboundPolling.isConfigured(),
    telegramInboundPolling: telegramInboundPollingStatus,
    telegramCommandMenuSetup,
    strategySchedulerStartupPreflight,
    strategySchedulerStartupBlockNotified,
    strategyScheduler: strategySchedulerStatus,
    supportedCommands: app.telegramRouter.getSupportedCommands(),
  };

  writeBanner(banner);

  if (!runtimeHasBackgroundWork) {
    runtimeShutdown();
  }
    },
  });
}

export async function runMain(
  createApplication: () => AppServices = createApp,
): Promise<void> {
  const app = createApplication();
  await runAppStartup(app);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runMain().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
