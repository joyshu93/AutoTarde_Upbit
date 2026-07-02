import type {
  ExecutionMode,
  ExecutionStateSeed,
  LiveExecutionGate,
  OperatorCommand,
  OrderLifecycleStatus,
  OrderSide,
  OrderType,
  StrategySchedulerStatus,
  StrategyDecisionAction,
  SupportedAsset,
  SupportedMarket,
  TelegramInboundOffsetRecord,
} from "../../domain/types.js";
import type { ExecutionRepository, OperatorStateStore, TelegramInboundOffsetStore } from "../db/interfaces.js";
import type { TelegramInboundPollingStatus } from "./inbound.js";

export interface TelegramResponse {
  text: string;
}

export type SupportedTelegramCommand = OperatorCommand["command"];
export type TelegramCommandCategory = "inspection" | "control";
export type TelegramCommandArgumentPolicy = "none" | "optional_reason" | "asset_required" | "order_reference_required";

export interface TelegramCommandContract {
  readonly command: SupportedTelegramCommand;
  readonly category: TelegramCommandCategory;
  readonly usage: string;
  readonly summary: string;
  readonly argumentPolicy: TelegramCommandArgumentPolicy;
}

export interface ParsedTelegramCommand {
  readonly command: SupportedTelegramCommand;
  readonly args: string[];
  readonly contract: TelegramCommandContract;
}

export interface TelegramSyncRequest {
  readonly exchangeAccountId: string;
  readonly requestedBy: "TELEGRAM";
  readonly requestedCommand: "/sync";
}

export interface TelegramSyncResult {
  readonly status: "COMPLETED" | "ALREADY_RUNNING" | "NOT_CONNECTED" | "FAILED";
  readonly requestedAt: string;
  readonly detail: string;
}

export interface TelegramSyncController {
  requestSync(request: TelegramSyncRequest): Promise<TelegramSyncResult>;
}

export interface TelegramStrategyRunRequest {
  readonly exchangeAccountId: string;
  readonly market: SupportedMarket;
  readonly requestedBy: "TELEGRAM" | "SCHEDULER";
  readonly requestedCommand: "/run" | "SCHEDULER_TICK";
}

export interface TelegramStrategyRunResult {
  readonly status: "COMPLETED" | "ALREADY_RUNNING" | "NOT_CONNECTED" | "FAILED";
  readonly requestedAt: string;
  readonly market: SupportedMarket | null;
  readonly strategyDecisionId: string | null;
  readonly action: StrategyDecisionAction | null;
  readonly orderId: string | null;
  readonly orderStatus: OrderLifecycleStatus | null;
  readonly submissionAccepted: boolean | null;
  readonly detail: string;
}

export interface TelegramStrategyRunController {
  requestRun(request: TelegramStrategyRunRequest): Promise<TelegramStrategyRunResult>;
  requestPreview(request: TelegramStrategyPreviewRequest): Promise<TelegramStrategyPreviewResult>;
}

export interface TelegramStrategyPreviewRequest {
  readonly exchangeAccountId: string;
  readonly market: SupportedMarket;
  readonly requestedBy: "TELEGRAM";
  readonly requestedCommand: "/preview";
}

export interface TelegramStrategyPreviewResult {
  readonly status: "COMPLETED" | "ALREADY_RUNNING" | "NOT_CONNECTED" | "FAILED";
  readonly requestedAt: string;
  readonly market: SupportedMarket | null;
  readonly action: StrategyDecisionAction | null;
  readonly executionDisposition: string | null;
  readonly referencePrice: number | null;
  readonly requestedNotionalKrw: number | null;
  readonly requestedQuantity: number | null;
  readonly orderSide: OrderSide | null;
  readonly orderType: OrderType | null;
  readonly orderPrice: string | null;
  readonly orderVolume: string | null;
  readonly detail: string;
}

export interface TelegramRuntimeConfigSnapshot {
  readonly serviceName: string;
  readonly executionMode: ExecutionMode;
  readonly liveExecutionGate: LiveExecutionGate;
  readonly liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  readonly upbitBaseUrl: string;
  readonly databasePath: string;
  readonly exchangeBackedReadEnabled: boolean;
  readonly telegramDeliveryEnabled: boolean;
  readonly telegramBotTokenConfigured: boolean;
  readonly telegramOperatorChatIdConfigured: boolean;
  readonly telegramDeliveryMaxAttempts: number;
  readonly telegramDeliveryBaseBackoffMs: number;
  readonly telegramDeliveryMaxBackoffMs: number;
  readonly telegramDeliveryLeaseMs: number;
  readonly telegramInboundPollingEnabled: boolean;
  readonly telegramInboundPollIntervalMs: number;
  readonly telegramInboundPollTimeoutSeconds: number;
  readonly telegramInboundPollLimit: number;
  readonly deprecatedIgnoredEnvVars: readonly string[];
  readonly strategySchedulerEnabled: boolean;
  readonly strategySchedulerRunOnStart: boolean;
  readonly strategySchedulerBtcIntervalMs: number;
  readonly strategySchedulerEthIntervalMs: number;
  readonly reconciliationMaxOrderLookupsPerRun: number;
  readonly reconciliationHistoryMaxPagesPerMarket: number;
  readonly reconciliationClosedOrderLookbackDays: number;
  readonly reconciliationHistoryStopBeforeDays: number;
  readonly reconciliationHistoryRetentionAssumptionDays: number;
  readonly stalePriceThresholdMs: number;
  readonly minimumOrderValueKrw: number;
  readonly maxAllocationByAsset: Record<SupportedAsset, number>;
  readonly totalExposureCap: number;
}

export interface TelegramRouterDependencies {
  readonly operatorState: OperatorStateStore;
  readonly repositories: ExecutionRepository;
  readonly runtimeConfig?: TelegramRuntimeConfigSnapshot;
  readonly executionStateSeed?: ExecutionStateSeed;
  readonly liveSendPath?: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  readonly syncController?: TelegramSyncController;
  readonly strategyRunController?: TelegramStrategyRunController;
  readonly schedulerStatus?: () => StrategySchedulerStatus;
  readonly telegramInboundStatus?: () => TelegramInboundPollingStatus | null;
  readonly telegramInboundOffsetStore?: TelegramInboundOffsetStore;
  readonly telegramInboundBotTokenRef?: string | null;
  readonly now?: () => string;
}

export type TelegramInboundOffset = TelegramInboundOffsetRecord;
