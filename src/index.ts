import { fileURLToPath } from "node:url";

import { createApp, type AppServices } from "./app/create-app.js";
import { loadAppConfig, type AppConfig } from "./app/env.js";
import {
  createRuntimeOwnershipContext,
  verifyAndResolveRuntimeDatabase,
  type RuntimeOwnershipContext,
  type VerifiedRuntimeDatabase,
} from "./app/runtime-ownership-context.js";
import {
  RuntimeOwnershipGuardError,
  type RuntimeOwnershipAuthority,
} from "./app/runtime-ownership-guard.js";
import {
  acquireRuntimeProcessLock,
  type RuntimeProcessLock,
} from "./app/runtime-process-lock.js";
import {
  hasBackgroundRuntime,
  createRuntimeShutdown,
  installRuntimeOwnershipLossHandler,
  installRuntimeSignalHandlers,
  runRuntimeStartupGate,
  type RuntimeOwnershipLossSource,
  type RuntimeShutdown,
} from "./app/runtime-lifecycle.js";
import { buildStrategySchedulerStartupPreflight } from "./app/scheduler-preflight.js";
import { runWithScopedRuntimeOwnership } from "./app/scoped-runtime-ownership.js";
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
  readonly runtimeOwnership?: RuntimeOwnershipContext;
}

export interface RunMainOperations {
  loadAppConfig(): AppConfig;
  verifyAndResolveRuntimeDatabase(config: AppConfig): VerifiedRuntimeDatabase;
  acquireRuntimeProcessLock(
    identity: VerifiedRuntimeDatabase["lockIdentity"],
  ): Promise<RuntimeProcessLock>;
  createRuntimeOwnershipContext(input: {
    readonly config: AppConfig;
    readonly processLock: RuntimeProcessLock;
  }): Promise<RuntimeOwnershipContext>;
  createApp(
    config: AppConfig,
    overrides: { readonly runtimeOwnershipAuthority: RuntimeOwnershipContext["guard"] },
  ): AppServices;
  runAppStartup(app: AppServices, operations: AppStartupOperations): Promise<void>;
}

export interface CreateVerifiedApplicationOperations {
  loadAppConfig(): AppConfig;
  createApp(
    config: AppConfig,
    overrides: { readonly runtimeOwnershipAuthority: RuntimeOwnershipAuthority },
  ): AppServices;
  runWithScopedRuntimeOwnership: typeof runWithScopedRuntimeOwnership;
}

export async function startTelegramRuntime(input: {
  strategyScheduler: {
    start(onRuntimeOwnershipLost?: (error: unknown) => void): { readonly started: boolean };
    reportStartupBlockIfNeeded(): Promise<boolean>;
  };
  telegramInboundPolling: {
    start(onRuntimeOwnershipLost?: (error: unknown) => void): { readonly running: boolean };
  };
  onRuntimeOwnershipLost?: (error: unknown) => void;
  installRuntimeSignalHandlers(): void;
  telegramCommandMenuSetup: {
    setup(): Promise<TelegramCommandMenuSetupResult>;
  };
}): Promise<TelegramRuntimeStartupResult> {
  const strategySchedulerStatus = input.strategyScheduler.start(input.onRuntimeOwnershipLost);
  const strategySchedulerStartupBlockNotified =
    await input.strategyScheduler.reportStartupBlockIfNeeded();
  const telegramInboundPollingStatus = input.telegramInboundPolling.start(input.onRuntimeOwnershipLost);
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
  const appOnlyShutdown = operations.runtimeOwnership
    ? null
    : createRuntimeShutdown(app);
  const runtimeShutdown: RuntimeShutdown = operations.runtimeOwnership
    ? createRuntimeShutdown(app, operations.runtimeOwnership)
    : async () => appOnlyShutdown!();
  const ownershipLossSource = resolveOwnershipLossSource(operations.runtimeOwnership);
  if (ownershipLossSource) {
    installRuntimeOwnershipLossHandler({
      shutdown: runtimeShutdown,
      ownershipLossSource,
    });
  }

  await runRuntimeStartupGate({
    initializer: app.candidatePilotStartupAuthority,
    shutdown: () => runtimeShutdown("STARTUP_FAILED"),
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
    if (isRuntimeOwnershipFailure(error)) throw error;
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
      shutdown: (reason) => runtimeShutdown(reason ?? "RUNTIME_SHUTDOWN"),
    }),
    onRuntimeOwnershipLost: () => {
      void runtimeShutdown("RUNTIME_OWNERSHIP_LOST").catch(() => undefined);
    },
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
    await runtimeShutdown("NO_BACKGROUND_RUNTIME");
  }
    },
  });
}

function isRuntimeOwnershipFailure(error: unknown): boolean {
  return error instanceof RuntimeOwnershipGuardError ||
    (error instanceof Error && /^RUNTIME_OWNERSHIP_(?:LOST|NOT_HELD):/u.test(error.message));
}

function resolveOwnershipLossSource(
  runtimeOwnership: RuntimeOwnershipContext | undefined,
): RuntimeOwnershipLossSource | undefined {
  if (!runtimeOwnership) return undefined;
  const guard = runtimeOwnership.guard as RuntimeOwnershipContext["guard"] &
    Partial<RuntimeOwnershipLossSource>;
  return typeof guard.onLost === "function"
    ? guard as RuntimeOwnershipContext["guard"] & RuntimeOwnershipLossSource
    : undefined;
}

export async function runMain(
  overrides: Partial<RunMainOperations> = {},
): Promise<void> {
  const operations: RunMainOperations = {
    loadAppConfig,
    verifyAndResolveRuntimeDatabase,
    acquireRuntimeProcessLock,
    createRuntimeOwnershipContext,
    createApp,
    runAppStartup,
    ...overrides,
  };
  const config = operations.loadAppConfig();
  const verified = operations.verifyAndResolveRuntimeDatabase(config);
  const processLock = await operations.acquireRuntimeProcessLock(verified.lockIdentity);
  const ownership = await operations.createRuntimeOwnershipContext({ config, processLock });
  try {
    const app = operations.createApp(config, {
      runtimeOwnershipAuthority: ownership.guard,
    });
    await operations.runAppStartup(app, { runtimeOwnership: ownership });
  } catch (error) {
    await ownership.shutdownAfterStartupFailure();
    throw error;
  }
}

export async function createVerifiedApplication<T>(
  useApplication: (app: AppServices) => Promise<T>,
  overrides: Partial<CreateVerifiedApplicationOperations> = {},
): Promise<T> {
  const config = (overrides.loadAppConfig ?? loadAppConfig)();
  const createApplication = overrides.createApp ?? createApp;
  const runOwned = overrides.runWithScopedRuntimeOwnership ?? runWithScopedRuntimeOwnership;

  return runOwned(config, async (runtimeOwnershipAuthority) => {
    const app = createApplication(config, { runtimeOwnershipAuthority });
    try {
      return await useApplication(app);
    } finally {
      app.telegramInboundPolling.stop();
      app.strategyScheduler.stop();
      app.persistence.close();
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runMain().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
