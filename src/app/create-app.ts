import { createHash } from "node:crypto";
import { buildExecutionRiskLimits, loadAppConfig, type AppConfig } from "./env.js";
import { CandidateBtcRunPreparationService } from "./candidate-btc-run-preparation.js";
import { PositionGuardPilotRecovery } from "./position-guard-pilot-recovery.js";
import {
  PositionGuardPilotInitializer,
  type PositionGuardPilotInitializerClock,
  type PositionGuardPilotInitializerRepository,
} from "./position-guard-pilot-initializer.js";
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
import type {
  PositionGuardPilotAbandonmentValidation,
  PositionGuardPolicySelection,
} from "../domain/pilot-types.js";

export interface AppServices {
  config: AppConfig;
  repositories: ExecutionRepository;
  operatorState: OperatorStateStore;
  executionService: ExecutionService;
  candidateEvidenceService: CandidateExecutionEvidenceService | null;
  candidatePilotInitializer: PositionGuardPilotInitializer | null;
  candidatePilotRecovery: PositionGuardPilotRecovery | null;
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
  afterCandidatePilotAuthorityValidated?: (authority: PositionGuardPilotAbandonmentValidation) => void;
  candidatePilotInitializerClock?: PositionGuardPilotInitializerClock;
  candidatePilotInitializerRepository?: PositionGuardPilotInitializerRepository;
}

export function createApp(
  config: AppConfig = loadAppConfig(),
  overrides: CreateAppOverrides = {},
): AppServices {
  const telegramLocale = config.telegramLocale;
  const candidatePolicySelection = snapshotCandidatePolicySelection(config);
  if (candidatePolicySelection) {
    const authority = snapshotCandidatePilotAbandonmentAuthority(
      loadCheckedInPositionGuardPilotAbandonment(),
    );
    overrides.afterCandidatePilotAuthorityValidated?.(authority);
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
  try {
  const { repositories, operatorState, accountExecutionLeases } = persistence;
  const candidatePilotInitializer = candidatePolicySelection
    ? new PositionGuardPilotInitializer({
        identity: {
          exchangeAccountId: "primary",
          pilotId: candidatePolicySelection.pilotId,
          market: candidatePolicySelection.market,
          policyId: candidatePolicySelection.policyId,
          policyVersion: candidatePolicySelection.policyVersion,
        },
        repository: overrides.candidatePilotInitializerRepository ?? {
          initializeDeploymentWithInitialState:
            persistence.candidatePilots.initializeDeploymentWithInitialState.bind(
              persistence.candidatePilots,
            ),
        },
        clock: overrides.candidatePilotInitializerClock ?? {
          now: () => new Date().toISOString(),
        },
      })
    : null;

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
    locale: telegramLocale,
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
  const candidatePilotRecovery = candidatePolicySelection
    ? createCandidateRunVerifier({
        candidatePolicySelection,
        repositories,
        candidatePilots: persistence.candidatePilots,
        operatorState,
        notificationDelivery,
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
    ...(candidatePolicySelection && candidatePilotRecovery
      ? {
          policySelection: candidatePolicySelection,
          candidateRunVerifier: candidatePilotRecovery,
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
    ...(candidatePolicySelection ? { candidatePilotReader: persistence.candidatePilots } : {}),
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
    candidatePilotInitializer,
    candidatePilotRecovery,
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
  } catch (error) {
    persistence.close();
    throw error;
  }
}

function createCandidateRunVerifier(input: {
  candidatePolicySelection: Extract<AppConfig["positionGuardPolicySelection"], { kind: "BTC_CANDIDATE_PILOT" }>;
  repositories: ExecutionRepository;
  candidatePilots: SqlitePersistenceBundle["candidatePilots"];
  operatorState: OperatorStateStore;
  notificationDelivery: OperatorNotificationDeliveryService;
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
      getState: input.operatorState.getState.bind(input.operatorState),
      pause: input.operatorState.pause.bind(input.operatorState),
    },
    notificationDelivery: input.notificationDelivery,
  });
}

function snapshotCandidatePolicySelection(
  config: AppConfig,
): Extract<PositionGuardPolicySelection, { kind: "BTC_CANDIDATE_PILOT" }> | null {
  const record = exactOwnDataRecord(config.positionGuardPolicySelection, "candidate policy selection");
  if (record.kind === "BASELINE") {
    assertExactOwnDataValues(record, "candidate policy selection", {
      kind: "BASELINE",
      pilotId: null,
    });
    return null;
  }
  assertExactOwnDataValues(record, "candidate policy selection", {
    kind: "BTC_CANDIDATE_PILOT",
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    liveOperatorConfirmed: true,
  });
  if (config.executionMode !== "LIVE") {
    throw new Error("BTC candidate policy selection requires LIVE execution mode.");
  }
  return Object.freeze({
    kind: "BTC_CANDIDATE_PILOT",
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    liveOperatorConfirmed: true,
  });
}

function snapshotCandidatePilotAbandonmentAuthority(
  authority: PositionGuardPilotAbandonmentValidation,
): PositionGuardPilotAbandonmentValidation {
  const expected = {
    valid: true,
    experimentId: "PCS-2026-001",
    eventAt: "2026-08-21T03:08:24.756Z",
  } as const;
  const record = exactOwnDataRecord(authority, "PositionGuard candidate abandonment authority");
  assertExactOwnDataValues(record, "PositionGuard candidate abandonment authority", expected);
  return Object.freeze({ ...expected });
}

function exactOwnDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an exact plain own-data object.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label} must contain enumerable own data properties only.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function assertExactOwnDataValues(
  record: Record<string, unknown>,
  label: string,
  expected: Readonly<Record<string, unknown>>,
): void {
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(record);
  if (
    actualKeys.length !== expectedKeys.length ||
    !actualKeys.every((key) => Object.hasOwn(expected, key)) ||
    !expectedKeys.every((key) => record[key] === expected[key])
  ) {
    throw new Error(`${label} must contain exactly the approved own data values.`);
  }
}

function createTelegramBotTokenRef(botToken: string): string {
  return `sha256:${createHash("sha256").update(botToken).digest("hex").slice(0, 16)}`;
}
