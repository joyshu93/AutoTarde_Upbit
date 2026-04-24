import { buildExecutionRiskLimits, loadAppConfig, type AppConfig } from "./env.js";
import { InlineTelegramSyncController } from "./sync-controller.js";
import type { ExecutionRepository, OperatorStateStore } from "../modules/db/interfaces.js";
import type { SqlitePersistenceBundle } from "../modules/db/repositories/contracts.js";
import { createSqlitePersistence } from "../modules/db/repositories/sqlite-repositories.js";
import { ExecutionService } from "../modules/execution/execution-service.js";
import { DryRunExchangeAdapter } from "../modules/exchange/interfaces.js";
import { UpbitPublicTickerClient } from "../modules/exchange/upbit/public-client.js";
import { UpbitPrivateClient } from "../modules/exchange/upbit/private-client.js";
import { PortfolioSyncService } from "../modules/reconciliation/portfolio-sync-service.js";
import { ReconciliationService } from "../modules/reconciliation/reconciliation-service.js";
import { DeterministicStubStrategy } from "../modules/strategy/deterministic-strategy.js";
import { TelegramCommandRouter } from "../modules/telegram/commands.js";
import {
  OperatorNotificationDeliveryService,
  TelegramBotApiClient,
} from "../modules/telegram/delivery.js";
import { DurableTelegramReporter } from "../modules/telegram/reporter.js";

export interface AppServices {
  config: AppConfig;
  repositories: ExecutionRepository;
  operatorState: OperatorStateStore;
  executionService: ExecutionService;
  reconciliationService: ReconciliationService;
  portfolioSyncService: PortfolioSyncService;
  telegramRouter: TelegramCommandRouter;
  strategy: DeterministicStubStrategy;
  liveExchangeClient: UpbitPrivateClient;
  exchangeBackedReadEnabled: boolean;
  notificationDelivery: OperatorNotificationDeliveryService;
  persistence: SqlitePersistenceBundle;
}

export function createApp(config: AppConfig = loadAppConfig()): AppServices {
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
  const publicTickerClient = new UpbitPublicTickerClient({
    baseUrl: config.upbitBaseUrl,
  });
  const dryRunExchangeAdapter = new DryRunExchangeAdapter();
  const exchangeBackedReadEnabled = Boolean(process.env.UPBIT_ACCESS_KEY && process.env.UPBIT_SECRET_KEY);
  const syncExchangeAdapter = exchangeBackedReadEnabled ? liveExchangeClient : dryRunExchangeAdapter;
  const telegramClient = config.telegramDeliveryEnabled && config.telegramBotToken
    ? new TelegramBotApiClient({
        botToken: config.telegramBotToken,
      })
    : null;
  const notificationDelivery = new OperatorNotificationDeliveryService({
    repositories,
    client: telegramClient,
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
    exchangeAdapter: dryRunExchangeAdapter,
    validationAdapter: syncExchangeAdapter,
    repositories,
    operatorState,
    reporter,
  });

  const reconciliationDependencies = {
    repositories,
    operatorState,
    reporter,
    maxOrderLookupsPerRun: config.reconciliationMaxOrderLookupsPerRun,
    ...(exchangeBackedReadEnabled ? { orderReader: liveExchangeClient } : {}),
  };
  const reconciliationService = new ReconciliationService(reconciliationDependencies);
  const portfolioSyncService = new PortfolioSyncService({
    exchangeAdapter: syncExchangeAdapter,
    marketPriceReader: publicTickerClient,
    repositories,
    reconciliationService,
  });

  const telegramRouter = new TelegramCommandRouter({
    operatorState,
    repositories,
    syncController: new InlineTelegramSyncController({
      portfolioSyncService,
      reporter,
    }),
    executionStateSeed: {
      executionMode: config.executionMode,
      liveExecutionGate: config.liveExecutionGate,
      killSwitchActive: config.globalKillSwitch,
    },
    liveSendPath: "DRY_RUN_ADAPTER",
  });

  return {
    config,
    repositories,
    operatorState,
    executionService,
    reconciliationService,
    portfolioSyncService,
    telegramRouter,
    strategy,
    liveExchangeClient,
    exchangeBackedReadEnabled,
    notificationDelivery,
    persistence,
  };
}
