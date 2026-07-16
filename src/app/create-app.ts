import { createHash } from "node:crypto";
import { buildExecutionRiskLimits, loadAppConfig, type AppConfig } from "./env.js";
import { buildManualStrategyRunPreflight, buildStrategySchedulerStartupPreflight } from "./scheduler-preflight.js";
import {
  createDefaultStrategySchedulerConfig,
  StrategyScheduler,
} from "./strategy-scheduler.js";
import { InlineTelegramStrategyRunController } from "./strategy-run-controller.js";
import { InlineTelegramSyncController } from "./sync-controller.js";
import type { ExecutionRepository, OperatorStateStore } from "../modules/db/interfaces.js";
import type { SqlitePersistenceBundle } from "../modules/db/repositories/contracts.js";
import { createSqlitePersistence } from "../modules/db/repositories/sqlite-repositories.js";
import { ExecutionService } from "../modules/execution/execution-service.js";
import { DryRunExchangeAdapter, type ExchangeAdapter } from "../modules/exchange/interfaces.js";
import { UpbitPublicTickerClient } from "../modules/exchange/upbit/public-client.js";
import { UpbitPrivateClient } from "../modules/exchange/upbit/private-client.js";
import { PortfolioSyncService } from "../modules/reconciliation/portfolio-sync-service.js";
import { ReconciliationService } from "../modules/reconciliation/reconciliation-service.js";
import { DeterministicStubStrategy } from "../modules/strategy/deterministic-strategy.js";
import {
  createDefaultPositionGuardRunnerConfig,
  PositionGuardStrategyRunner,
} from "../modules/strategy/position-guard-runner.js";
import type { PositionGuardPublicMarketDataReader } from "../modules/strategy/position-guard-snapshot.js";
import { TelegramCommandRouter } from "../modules/telegram/commands.js";
import {
  OperatorNotificationDeliveryService,
  TelegramBotApiClient,
} from "../modules/telegram/delivery.js";
import {
  TelegramBotUpdateClient,
  TelegramInboundPollingService,
} from "../modules/telegram/inbound.js";
import { DurableTelegramReporter } from "../modules/telegram/reporter.js";

export interface AppServices {
  config: AppConfig;
  repositories: ExecutionRepository;
  operatorState: OperatorStateStore;
  executionService: ExecutionService;
  reconciliationService: ReconciliationService;
  portfolioSyncService: PortfolioSyncService;
  telegramRouter: TelegramCommandRouter;
  strategyScheduler: StrategyScheduler;
  strategy: DeterministicStubStrategy;
  positionGuardRunner: PositionGuardStrategyRunner;
  liveExchangeClient: UpbitPrivateClient;
  exchangeBackedReadEnabled: boolean;
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  notificationDelivery: OperatorNotificationDeliveryService;
  telegramInboundPolling: TelegramInboundPollingService;
  persistence: SqlitePersistenceBundle;
}

export interface CreateAppOverrides {
  publicMarketDataReader?: PositionGuardPublicMarketDataReader;
  privateExchangeAdapter?: ExchangeAdapter;
}

export function createApp(
  config: AppConfig = loadAppConfig(),
  overrides: CreateAppOverrides = {},
): AppServices {
  const telegramLocale = config.telegramLocale;
  const persistence = createSqlitePersistence({
    databasePath: config.databasePath,
    exchangeAccountId: "primary",
    userId: "system_operator",
    userTelegramId: "system_operator",
    userDisplayName: "System Operator",
    accessKeyRef: process.env.UPBIT_ACCESS_KEY ? "ENV:UPBIT_ACCESS_KEY" : "UNCONFIGURED",
    secretKeyRef: process.env.UPBIT_SECRET_KEY ? "ENV:UPBIT_SECRET_KEY" : "UNCONFIGURED",
    executionMode: config.executionMode,
    liveExecutionGate: config.liveExecutionGate,
    killSwitchActive: config.globalKillSwitch,
  });
  const { repositories, operatorState } = persistence;

  const strategy = new DeterministicStubStrategy();
  const liveExchangeClient = new UpbitPrivateClient({
    accessKey: process.env.UPBIT_ACCESS_KEY ?? "",
    secretKey: process.env.UPBIT_SECRET_KEY ?? "",
    baseUrl: config.upbitBaseUrl,
  });
  const privateExchangeAdapter = overrides.privateExchangeAdapter ?? liveExchangeClient;
  const publicMarketDataReader = overrides.publicMarketDataReader ?? new UpbitPublicTickerClient({
    baseUrl: config.upbitBaseUrl,
  });
  const dryRunExchangeAdapter = new DryRunExchangeAdapter();
  const exchangeBackedReadEnabled = Boolean(process.env.UPBIT_ACCESS_KEY && process.env.UPBIT_SECRET_KEY);
  const syncExchangeAdapter = exchangeBackedReadEnabled ? privateExchangeAdapter : dryRunExchangeAdapter;
  const liveSendEnabled =
    config.executionMode === "LIVE" &&
    config.liveExecutionGate === "ENABLED" &&
    exchangeBackedReadEnabled;
  const liveSendPath = liveSendEnabled ? "LIVE_ADAPTER" : "DRY_RUN_ADAPTER";
  const executionExchangeAdapter = liveSendEnabled ? privateExchangeAdapter : dryRunExchangeAdapter;
  const telegramMessageClient = config.telegramBotToken
    ? new TelegramBotApiClient({
        botToken: config.telegramBotToken,
      })
    : null;
  const telegramBotTokenRef = config.telegramBotToken ? createTelegramBotTokenRef(config.telegramBotToken) : null;
  const notificationDelivery = new OperatorNotificationDeliveryService({
    repositories,
    client: config.telegramDeliveryEnabled ? telegramMessageClient : null,
    operatorChatId: config.telegramDeliveryEnabled ? config.telegramOperatorChatId : null,
    maxAttempts: config.telegramDeliveryMaxAttempts,
    baseBackoffMs: config.telegramDeliveryBaseBackoffMs,
    maxBackoffMs: config.telegramDeliveryMaxBackoffMs,
    leaseDurationMs: config.telegramDeliveryLeaseMs,
  });
  const reporter = new DurableTelegramReporter({
    repositories,
    deliveryService: notificationDelivery,
  });

  const executionService = new ExecutionService({
    riskLimits: buildExecutionRiskLimits(config),
    exchangeAdapter: executionExchangeAdapter,
    validationAdapter: syncExchangeAdapter,
    repositories,
    operatorState,
    reporter,
  });
  const positionGuardRunner = new PositionGuardStrategyRunner({
    repositories,
    executionService,
    marketDataReader: publicMarketDataReader,
    config: createDefaultPositionGuardRunnerConfig("primary"),
  });
  const strategyRunController = new InlineTelegramStrategyRunController({
    runner: positionGuardRunner,
    beforeManualRunPreflight: async () =>
      buildManualStrategyRunPreflight({
        config,
        exchangeAccountId: "primary",
        executionState: await operatorState.getState(),
        repositories,
        exchangeBackedReadEnabled,
        liveSendPath,
      }),
  });
  const reconciliationDependencies = {
    repositories,
    operatorState,
    reporter,
    maxOrderLookupsPerRun: config.reconciliationMaxOrderLookupsPerRun,
    historyMaxPagesPerMarket: config.reconciliationHistoryMaxPagesPerMarket,
    closedOrderLookbackDays: config.reconciliationClosedOrderLookbackDays,
    historyStopBeforeDays: config.reconciliationHistoryStopBeforeDays,
    historyRetentionAssumptionDays: config.reconciliationHistoryRetentionAssumptionDays,
    ...(exchangeBackedReadEnabled ? {
      orderReader: privateExchangeAdapter,
      orderHistoryReader: privateExchangeAdapter,
    } : {}),
  };
  const reconciliationService = new ReconciliationService(reconciliationDependencies);
  const portfolioSyncService = new PortfolioSyncService({
    exchangeAdapter: syncExchangeAdapter,
    marketPriceReader: publicMarketDataReader,
    repositories,
    reconciliationService,
  });
  const strategyScheduler = new StrategyScheduler({
    config: createDefaultStrategySchedulerConfig({
      enabled: config.strategySchedulerEnabled,
      runOnStart: config.strategySchedulerRunOnStart,
      exchangeAccountId: "primary",
      liveSendPath,
      btcIntervalMs: config.strategySchedulerBtcIntervalMs,
      ethIntervalMs: config.strategySchedulerEthIntervalMs,
    }),
    controller: strategyRunController,
    repositories,
    reporter,
    ...(config.executionMode === "LIVE" && config.strategySchedulerEnabled
      ? {
          beforeRunAccountRefresh: async () => {
            try {
              const result = await portfolioSyncService.run({
                exchangeAccountId: "primary",
                source: "SCHEDULER_PREFLIGHT",
              });
              return {
                status: "COMPLETED" as const,
                requestedAt: result.requestedAt,
                detail:
                  `Scheduler preflight sync completed; reconciliation_status=${result.reconciliationSummary.status} ` +
                  `issues=${result.reconciliationSummary.issues.length}.`,
              };
            } catch (error) {
              return {
                status: "FAILED" as const,
                requestedAt: new Date().toISOString(),
                detail: error instanceof Error ? error.message : String(error),
              };
            }
          },
        }
      : {}),
    beforeRunPreflight: async () =>
      buildStrategySchedulerStartupPreflight({
        config,
        exchangeAccountId: "primary",
        executionState: await operatorState.getState(),
        repositories,
        exchangeBackedReadEnabled,
        liveSendPath,
      }),
  });

  let telegramInboundPolling: TelegramInboundPollingService | null = null;
  const telegramRouter = new TelegramCommandRouter({
    operatorState,
    repositories,
    locale: telegramLocale,
    runtimeConfig: {
      serviceName: config.serviceName,
      executionMode: config.executionMode,
      liveExecutionGate: config.liveExecutionGate,
      liveSendPath,
      upbitBaseUrl: config.upbitBaseUrl,
      databasePath: config.databasePath,
      telegramLocale,
      exchangeBackedReadEnabled,
      telegramDeliveryEnabled: config.telegramDeliveryEnabled,
      telegramBotTokenConfigured: Boolean(config.telegramBotToken),
      telegramOperatorChatIdConfigured: Boolean(config.telegramOperatorChatId),
      telegramDeliveryMaxAttempts: config.telegramDeliveryMaxAttempts,
      telegramDeliveryBaseBackoffMs: config.telegramDeliveryBaseBackoffMs,
      telegramDeliveryMaxBackoffMs: config.telegramDeliveryMaxBackoffMs,
      telegramDeliveryLeaseMs: config.telegramDeliveryLeaseMs,
      telegramInboundPollingEnabled: config.telegramInboundPollingEnabled,
      telegramInboundPollIntervalMs: config.telegramInboundPollIntervalMs,
      telegramInboundPollTimeoutSeconds: config.telegramInboundPollTimeoutSeconds,
      telegramInboundPollLimit: config.telegramInboundPollLimit,
      deprecatedIgnoredEnvVars: config.deprecatedIgnoredEnvVars,
      strategySchedulerEnabled: config.strategySchedulerEnabled,
      strategySchedulerRunOnStart: config.strategySchedulerRunOnStart,
      strategySchedulerBtcIntervalMs: config.strategySchedulerBtcIntervalMs,
      strategySchedulerEthIntervalMs: config.strategySchedulerEthIntervalMs,
      reconciliationMaxOrderLookupsPerRun: config.reconciliationMaxOrderLookupsPerRun,
      reconciliationHistoryMaxPagesPerMarket: config.reconciliationHistoryMaxPagesPerMarket,
      reconciliationClosedOrderLookbackDays: config.reconciliationClosedOrderLookbackDays,
      reconciliationHistoryStopBeforeDays: config.reconciliationHistoryStopBeforeDays,
      reconciliationHistoryRetentionAssumptionDays: config.reconciliationHistoryRetentionAssumptionDays,
      stalePriceThresholdMs: config.stalePriceThresholdMs,
      minimumOrderValueKrw: config.minimumOrderValueKrw,
      maxAllocationByAsset: config.maxAllocationByAsset,
      totalExposureCap: config.totalExposureCap,
    },
    syncController: new InlineTelegramSyncController({
      portfolioSyncService,
      reporter,
    }),
    strategyRunController,
    schedulerStatus: () => strategyScheduler.getStatus(),
    telegramInboundStatus: () => telegramInboundPolling?.getStatus() ?? null,
    telegramInboundOffsetStore: persistence.telegramInboundOffsets,
    telegramInboundBotTokenRef: telegramBotTokenRef,
    executionStateSeed: {
      executionMode: config.executionMode,
      liveExecutionGate: config.liveExecutionGate,
      killSwitchActive: config.globalKillSwitch,
    },
    liveSendPath,
  });
  const telegramInboundUpdateClient = config.telegramInboundPollingEnabled && config.telegramBotToken
    ? new TelegramBotUpdateClient({
        botToken: config.telegramBotToken,
      })
    : null;
  telegramInboundPolling = new TelegramInboundPollingService({
    enabled: config.telegramInboundPollingEnabled,
    updateClient: telegramInboundUpdateClient,
    messageClient: telegramMessageClient,
    router: telegramRouter,
    operatorChatId: config.telegramOperatorChatId,
    exchangeAccountId: "primary",
    offsetStore: persistence.telegramInboundOffsets,
    botTokenRef: telegramBotTokenRef,
    pollIntervalMs: config.telegramInboundPollIntervalMs,
    longPollTimeoutSeconds: config.telegramInboundPollTimeoutSeconds,
    limit: config.telegramInboundPollLimit,
  });

  return {
    config,
    repositories,
    operatorState,
    executionService,
    reconciliationService,
    portfolioSyncService,
    telegramRouter,
    strategyScheduler,
    strategy,
    positionGuardRunner,
    liveExchangeClient,
    exchangeBackedReadEnabled,
    liveSendPath,
    notificationDelivery,
    telegramInboundPolling,
    persistence,
  };
}

function createTelegramBotTokenRef(botToken: string): string {
  return `sha256:${createHash("sha256").update(botToken).digest("hex").slice(0, 16)}`;
}
