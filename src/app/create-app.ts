import { buildExecutionPolicy, loadAppConfig, type AppConfig } from "./env.js";
import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../modules/db/repositories/in-memory-repositories.js";
import { ExecutionService } from "../modules/execution/execution-service.js";
import { DryRunExchangeAdapter } from "../modules/exchange/interfaces.js";
import { UpbitPrivateClient } from "../modules/exchange/upbit/private-client.js";
import { ReconciliationService } from "../modules/reconciliation/reconciliation-service.js";
import { DeterministicStubStrategy } from "../modules/strategy/deterministic-strategy.js";
import { TelegramCommandRouter } from "../modules/telegram/commands.js";
import { createId } from "../shared/ids.js";

export interface AppServices {
  config: AppConfig;
  repositories: InMemoryExecutionRepository;
  operatorState: InMemoryOperatorStateStore;
  executionService: ExecutionService;
  reconciliationService: ReconciliationService;
  telegramRouter: TelegramCommandRouter;
  strategy: DeterministicStubStrategy;
  liveExchangeClient: UpbitPrivateClient;
}

export function createApp(config: AppConfig = loadAppConfig()): AppServices {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: createId("execution_state"),
    exchangeAccountId: "primary",
    executionMode: config.executionMode,
    liveExecutionGate: config.liveExecutionGate,
    systemStatus: config.globalKillSwitch ? "KILL_SWITCHED" : "RUNNING",
    killSwitchActive: config.globalKillSwitch,
    pauseReason: null,
    updatedAt: new Date().toISOString(),
  });

  const strategy = new DeterministicStubStrategy();
  const liveExchangeClient = new UpbitPrivateClient({
    accessKey: process.env.UPBIT_ACCESS_KEY ?? "",
    secretKey: process.env.UPBIT_SECRET_KEY ?? "",
    baseUrl: config.upbitBaseUrl,
  });

  const executionService = new ExecutionService({
    policy: buildExecutionPolicy(config),
    exchangeAdapter: new DryRunExchangeAdapter(),
    repositories,
    operatorState,
  });

  const reconciliationService = new ReconciliationService({
    repositories,
    operatorState,
  });

  const telegramRouter = new TelegramCommandRouter({
    operatorState,
    repositories,
  });

  return {
    config,
    repositories,
    operatorState,
    executionService,
    reconciliationService,
    telegramRouter,
    strategy,
    liveExchangeClient,
  };
}
