import { createHash } from "node:crypto";
import { buildExecutionRiskLimits, loadAppConfig, type AppConfig } from "./env.js";
import { CandidateBtcRunPreparationService } from "./candidate-btc-run-preparation.js";
import { PositionGuardPilotRecovery } from "./position-guard-pilot-recovery.js";
import { loadCheckedInPositionGuardPilotAbandonment } from "./position-guard-pilot-registry-loader.js";
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
import { CandidateExecutionEvidenceService } from "../modules/execution/candidate-evidence-service.js";
import { ExecutionService } from "../modules/execution/execution-service.js";
import {
  DryRunExchangeAdapter,
  type ExchangeAdapter,
  type ExecutionExchangeAdapter,
  type LiveExecutionAdapter,
} from "../modules/exchange/interfaces.js";
import { UpbitPublicTickerClient } from "../modules/exchange/upbit/public-client.js";
import { UpbitPrivateClient } from "../modules/exchange/upbit/private-client.js";
import { PortfolioSyncService } from "../modules/reconciliation/portfolio-sync-service.js";
import {
  DEFAULT_IDENTIFIER_RECOVERY_POLICY,
  ReconciliationService,
} from "../modules/reconciliation/reconciliation-service.js";
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
import { TelegramCommandMenuSetupService } from "../modules/telegram/setup.js";
import {
  TelegramBotUpdateClient,
  TelegramInboundPollingService,
} from "../modules/telegram/inbound.js";
import { DurableTelegramReporter } from "../modules/telegram/reporter.js";
import type { PositionGuardPilotAbandonmentValidation } from "../domain/pilot-types.js";

export interface AppServices {
  config: AppConfig;
  repositories: ExecutionRepository;
  operatorState: OperatorStateStore;
  executionService: ExecutionService;
  candidateEvidenceService: CandidateExecutionEvidenceService | null;
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
  telegramCommandMenuSetup: TelegramCommandMenuSetupService;
  telegramInboundPolling: TelegramInboundPollingService;
  persistence: SqlitePersistenceBundle;
}

export interface CreateAppOverrides {
  publicMarketDataReader?: PositionGuardPublicMarketDataReader;
  privateExchangeAdapter?: LiveExecutionAdapter;
  loadCandidatePilotAbandonment?: () => PositionGuardPilotAbandonmentValidation;
}

export function createApp(
  config: AppConfig = loadAppConfig(),
  overrides: CreateAppOverrides = {},
): AppServices {
  const telegramLocale = config.telegramLocale;
  const candidatePolicySelection = config.positionGuardPolicySelection.kind === "BTC_CANDIDATE_PILOT"
    ? config.positionGuardPolicySelection
    : null;
  if (candidatePolicySelection) {
    const authority = (overrides.loadCandidatePilotAbandonment ??
      loadCheckedInPositionGuardPilotAbandonment)();
    assertCandidatePilotAbandonmentAuthority(authority);
  }
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
  const { repositories, operatorState, accountExecutionLeases } = persistence;

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
  const executionAdapter: ExecutionExchangeAdapter = liveSendEnabled ? privateExchangeAdapter : dryRunExchangeAdapter;
  const liveSendPath = executionAdapter.sendPath;
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
  const telegramCommandMenuSetup = new TelegramCommandMenuSetupService({
    client: telegramMessageClient,
    operatorChatId: config.telegramOperatorChatId,
  });
  const reporter = new DurableTelegramReporter({
    repositories,
    deliveryService: notificationDelivery,
  });

  const executionService = new ExecutionService({
    riskLimits: buildExecutionRiskLimits(config),
    executionAdapter,
    validationAdapter: syncExchangeAdapter,
    repositories,
    accountExecutionLeases,
    accountExecutionLeaseMs: config.accountExecutionLeaseMs,
    operatorState,
    reporter,
    ...(candidatePolicySelection ? { candidatePilots: persistence.candidatePilots } : {}),
  });
  const recoveryClock = {
    now: () => {
      const observedAt = new Date().toISOString();
      return { observedAt, observedAtEpochMs: Date.parse(observedAt) };
    },
  };
  const candidateEvidenceService = candidatePolicySelection
    ? new CandidateExecutionEvidenceService({
        exchangeAccountId: "primary",
        repositories,
        pilotRepository: persistence.candidatePilots,
        operatorState,
        clock: {
          now: () => {
            const occurredAt = new Date().toISOString();
            return { occurredAt, occurredAtEpochMs: Date.parse(occurredAt) };
          },
        },
      })
    : null;
  const candidateRunVerifier = candidatePolicySelection
    ? createCandidateRunVerifier({
        candidatePolicySelection,
        repositories,
        candidatePilots: persistence.candidatePilots,
        operatorState,
        freshnessThresholdMs: Math.min(
          config.strategySchedulerBtcIntervalMs,
          config.strategySchedulerEthIntervalMs,
        ),
      })
    : null;
  const positionGuardRunner = new PositionGuardStrategyRunner({
    repositories,
    executionService,
    marketDataReader: publicMarketDataReader,
    config: createDefaultPositionGuardRunnerConfig("primary"),
    ...(candidatePolicySelection && candidateRunVerifier
      ? {
          policySelection: candidatePolicySelection,
          candidateRunVerifier,
        }
      : {}),
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
    identifierRecovery: DEFAULT_IDENTIFIER_RECOVERY_POLICY,
    recoveryClock,
    ...(candidateEvidenceService ? { candidateEvidenceService } : {}),
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
  const candidateBtcRunPreparation = candidatePolicySelection
    ? new CandidateBtcRunPreparationService({
        config: {
          strategySchedulerBtcIntervalMs: config.strategySchedulerBtcIntervalMs,
          strategySchedulerEthIntervalMs: config.strategySchedulerEthIntervalMs,
          liveExecutionGate: config.liveExecutionGate,
        },
        portfolioSync: portfolioSyncService,
        operatorState,
        repositories,
        exchangeBackedReadEnabled,
        liveSendPath,
      })
    : null;
  const strategyRunController = new InlineTelegramStrategyRunController({
    runner: positionGuardRunner,
    ...(candidateBtcRunPreparation ? { candidateBtcRunPreparation } : {}),
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
    ...(candidatePolicySelection
      ? {
          resolveRunPreparationOwner: (market: "KRW-BTC" | "KRW-ETH") =>
            market === "KRW-BTC" ? "CONTROLLER" as const : "SCHEDULER" as const,
        }
      : {}),
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
    candidateEvidenceService,
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
    telegramCommandMenuSetup,
    telegramInboundPolling,
    persistence,
  };
}

function createCandidateRunVerifier(input: {
  candidatePolicySelection: Extract<AppConfig["positionGuardPolicySelection"], { kind: "BTC_CANDIDATE_PILOT" }>;
  repositories: ExecutionRepository;
  candidatePilots: SqlitePersistenceBundle["candidatePilots"];
  operatorState: OperatorStateStore;
  freshnessThresholdMs: number;
}): PositionGuardPilotRecovery {
  const getTransitionById = input.operatorState.getTransitionById;
  if (!getTransitionById) {
    throw new Error("Candidate pilot recovery requires persisted execution transition lookup.");
  }

  return new PositionGuardPilotRecovery({
    exchangeAccountId: "primary",
    target: { kind: "CONFIGURED_ACCOUNT_PILOT" },
    pilotId: input.candidatePolicySelection.pilotId,
    market: input.candidatePolicySelection.market,
    policyId: input.candidatePolicySelection.policyId,
    policyVersion: input.candidatePolicySelection.policyVersion,
    freshnessThresholdMs: input.freshnessThresholdMs,
    minimumAbsenceObservations: DEFAULT_IDENTIFIER_RECOVERY_POLICY.minimumNotFoundObservations,
    minimumAbsenceElapsedMs: DEFAULT_IDENTIFIER_RECOVERY_POLICY.minimumElapsedMs,
    clock: {
      now: () => {
        const occurredAt = new Date().toISOString();
        return { occurredAt, occurredAtEpochMs: Date.parse(occurredAt) };
      },
    },
    repositories: input.repositories,
    candidatePilots: input.candidatePilots,
    operatorState: {
      pauseForFault: input.operatorState.pauseForFault.bind(input.operatorState),
      getTransitionById: getTransitionById.bind(input.operatorState),
    },
  });
}

function assertCandidatePilotAbandonmentAuthority(
  authority: PositionGuardPilotAbandonmentValidation,
): void {
  const expected = {
    valid: true,
    experimentId: "PCS-2026-001",
    eventAt: "2026-08-21T03:08:24.756Z",
  } as const;
  if (
    typeof authority !== "object" || authority === null || Array.isArray(authority) ||
    Object.getPrototypeOf(authority) !== Object.prototype ||
    Object.keys(authority).length !== Object.keys(expected).length
  ) {
    throw new Error("PositionGuard candidate abandonment authority is malformed.");
  }

  for (const [key, value] of Object.entries(expected)) {
    const descriptor = Object.getOwnPropertyDescriptor(authority, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.value !== value) {
      throw new Error("PositionGuard candidate abandonment authority is invalid.");
    }
  }
}

function createTelegramBotTokenRef(botToken: string): string {
  return `sha256:${createHash("sha256").update(botToken).digest("hex").slice(0, 16)}`;
}
