import type {
  ExecutionStateSeed,
  OperatorCommand,
  OrderLifecycleStatus,
  StrategyDecisionAction,
  SupportedMarket,
} from "../../domain/types.js";
import type { ExecutionRepository, OperatorStateStore } from "../db/interfaces.js";

export interface TelegramResponse {
  text: string;
}

export type SupportedTelegramCommand = OperatorCommand["command"];
export type TelegramCommandCategory = "inspection" | "control";
export type TelegramCommandArgumentPolicy = "none" | "optional_reason" | "asset_required";

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
  readonly requestedBy: "TELEGRAM";
  readonly requestedCommand: "/run";
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
}

export interface TelegramRouterDependencies {
  readonly operatorState: OperatorStateStore;
  readonly repositories: ExecutionRepository;
  readonly executionStateSeed?: ExecutionStateSeed;
  readonly liveSendPath?: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  readonly syncController?: TelegramSyncController;
  readonly strategyRunController?: TelegramStrategyRunController;
  readonly now?: () => string;
}
