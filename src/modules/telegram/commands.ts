import {
  buildUnsupportedCommandMessage,
  listTelegramCommandContracts,
  listSupportedTelegramCommands,
  parseTelegramCommand,
  parseTelegramAssetArg,
  validateTelegramCommand,
} from "./contracts.js";
import {
  formatBalanceMessage,
  formatBalanceSummaryMessage,
  formatControlCommandMessage,
  formatHelpMessage,
  formatOperatorNotificationsMessage,
  formatOrderDetailMessage,
  formatOrdersMessage,
  formatPositionMessage,
  formatPositionSummaryMessage,
  formatReadinessMessage,
  formatReadinessSummaryMessage,
  formatReconciliationRunsMessage,
  formatRecoveryProgressMessage,
  formatRiskEventsMessage,
  formatRuntimeConfigMessage,
  formatStateHistoryMessage,
  formatStrategySchedulerRunsMessage,
  formatStrategyPreviewMessage,
  formatStrategyRunMessage,
  formatStatusMessage,
  formatStatusSummaryMessage,
  formatSyncMessage,
  formatTelegramInboundMessage,
} from "./formatter.js";
import type {
  ParsedTelegramCommand,
  SupportedTelegramCommand,
  TelegramResponse,
  TelegramRouterDependencies,
  TelegramStrategyPreviewResult,
  TelegramStrategyRunResult,
  TelegramSyncResult,
} from "./interfaces.js";
import { getMarketForAsset } from "../../domain/types.js";
import type { ReconciliationRunRecord, StrategySchedulerRunRecord } from "../../domain/types.js";
import type { OperatorStateStore } from "../db/interfaces.js";
import { normalizeTelegramLocale } from "./presentation/locale.js";

export class TelegramCommandRouter {
  constructor(private readonly dependencies: TelegramRouterDependencies) {}

  getSupportedCommands(): SupportedTelegramCommand[] {
    return listSupportedTelegramCommands();
  }

  parse(input: string): ParsedTelegramCommand | null {
    return parseTelegramCommand(input);
  }

  async route(input: string, exchangeAccountId = "primary"): Promise<TelegramResponse> {
    const parsed = this.parse(input);
    if (!parsed) {
      return {
        text: buildUnsupportedCommandMessage(input),
      };
    }

    const validationMessage = validateTelegramCommand(parsed);
    if (validationMessage) {
      return { text: validationMessage };
    }

    switch (parsed.command) {
      case "/help":
        return {
          text: formatHelpMessage(
            listTelegramCommandContracts(),
            normalizeTelegramLocale(this.dependencies.locale),
          ),
        };
      case "/config":
        return {
          text: formatRuntimeConfigMessage(this.dependencies.runtimeConfig ?? null),
        };
      case "/readiness":
        return this.buildReadinessResponse(
          exchangeAccountId,
          parsed.args[0]?.toLowerCase() === "detail",
        );
      case "/status":
        return this.buildStatusResponse(exchangeAccountId, parsed.args[0]?.toLowerCase() === "detail");
      case "/statehistory":
        return this.buildStateHistoryResponse();
      case "/synchistory":
        return this.buildSyncHistoryResponse(exchangeAccountId);
      case "/recovery":
        return this.buildRecoveryProgressResponse(exchangeAccountId);
      case "/alerts":
        return this.buildAlertsResponse(exchangeAccountId);
      case "/risks":
        return this.buildRiskEventsResponse(exchangeAccountId);
      case "/balances":
        return this.buildBalanceResponse(
          exchangeAccountId,
          parsed.args[0]?.toLowerCase() === "detail",
        );
      case "/positions":
        return this.buildPositionResponse(
          exchangeAccountId,
          parsed.args[0]?.toLowerCase() === "detail",
        );
      case "/orders":
        return { text: formatOrdersMessage(await this.dependencies.repositories.listOrders(exchangeAccountId), { limit: 20 }) };
      case "/order":
        return this.buildOrderDetailResponse(exchangeAccountId, parsed.args[0] ?? "");
      case "/scheduler":
        return this.buildSchedulerResponse(exchangeAccountId);
      case "/inbound":
        return this.buildInboundResponse(exchangeAccountId);
      case "/pause":
        return this.applyControlCommand(
          parsed.command,
          () =>
            this.dependencies.operatorState.pause(
              parsed.args.join(" ").trim() || "paused_by_operator",
            ),
        );
      case "/resume":
        return this.applyControlCommand(parsed.command, () => this.dependencies.operatorState.resume());
      case "/killswitch":
        return this.applyControlCommand(
          parsed.command,
          () =>
            this.dependencies.operatorState.activateKillSwitch(
              parsed.args.join(" ").trim() || "killswitch_activated",
            ),
        );
      case "/sync":
        return {
          text: formatSyncMessage(await this.requestSync(exchangeAccountId)),
        };
      case "/preview":
        return {
          text: formatStrategyPreviewMessage(await this.requestStrategyPreview(parsed.args, exchangeAccountId)),
        };
      case "/run":
        return {
          text: formatStrategyRunMessage(await this.requestStrategyRun(parsed.args, exchangeAccountId)),
        };
      default:
        return {
          text: buildUnsupportedCommandMessage(input),
        };
    }
  }

  private async buildBalanceResponse(
    exchangeAccountId: string,
    detail: boolean,
  ): Promise<TelegramResponse> {
    const snapshot = await this.dependencies.repositories.getLatestBalanceSnapshot(exchangeAccountId);
    return {
      text: detail
        ? formatBalanceMessage(snapshot)
        : formatBalanceSummaryMessage(
            snapshot,
            normalizeTelegramLocale(this.dependencies.locale),
          ),
    };
  }

  private async buildPositionResponse(
    exchangeAccountId: string,
    detail: boolean,
  ): Promise<TelegramResponse> {
    const snapshot = await this.dependencies.repositories.getLatestPositionSnapshot(exchangeAccountId);
    return {
      text: detail
        ? formatPositionMessage(snapshot)
        : formatPositionSummaryMessage(
            snapshot,
            normalizeTelegramLocale(this.dependencies.locale),
          ),
    };
  }

  private async requestSync(exchangeAccountId: string): Promise<TelegramSyncResult> {
    if (!this.dependencies.syncController) {
      return {
        status: "NOT_CONNECTED",
        requestedAt: this.dependencies.now?.() ?? new Date().toISOString(),
        detail:
          "Reconciliation trigger is not wired in this process yet. Use stored snapshots for inspection until the sync controller is connected.",
      };
    }

    return this.dependencies.syncController.requestSync({
      exchangeAccountId,
      requestedBy: "TELEGRAM",
      requestedCommand: "/sync",
    });
  }

  private async requestStrategyPreview(
    args: readonly string[],
    exchangeAccountId: string,
  ): Promise<TelegramStrategyPreviewResult> {
    const requestedAt = this.dependencies.now?.() ?? new Date().toISOString();
    const asset = parseTelegramAssetArg(args);

    if (!asset) {
      return {
        status: "FAILED",
        requestedAt,
        market: null,
        action: null,
        executionDisposition: null,
        referencePrice: null,
        requestedNotionalKrw: null,
        requestedQuantity: null,
        orderSide: null,
        orderType: null,
        orderPrice: null,
        orderVolume: null,
        detail: "Invalid strategy preview request. Use /preview BTC or /preview ETH.",
      };
    }

    const market = getMarketForAsset(asset);

    if (!this.dependencies.strategyRunController) {
      return {
        status: "NOT_CONNECTED",
        requestedAt,
        market,
        action: null,
        executionDisposition: null,
        referencePrice: null,
        requestedNotionalKrw: null,
        requestedQuantity: null,
        orderSide: null,
        orderType: null,
        orderPrice: null,
        orderVolume: null,
        detail:
          "PositionGuard strategy runner is not wired in this process yet. No preview was computed.",
      };
    }

    return this.dependencies.strategyRunController.requestPreview({
      exchangeAccountId,
      market,
      requestedBy: "TELEGRAM",
      requestedCommand: "/preview",
    });
  }

  private async requestStrategyRun(
    args: readonly string[],
    exchangeAccountId: string,
  ): Promise<TelegramStrategyRunResult> {
    const requestedAt = this.dependencies.now?.() ?? new Date().toISOString();
    const asset = parseTelegramAssetArg(args);

    if (!asset) {
      return {
        status: "FAILED",
        requestedAt,
        market: null,
        strategyDecisionId: null,
        action: null,
        orderId: null,
        orderStatus: null,
        submissionAccepted: null,
        detail: "Invalid strategy run request. Use /run BTC or /run ETH.",
      };
    }

    const market = getMarketForAsset(asset);

    if (!this.dependencies.strategyRunController) {
      return {
        status: "NOT_CONNECTED",
        requestedAt,
        market,
        strategyDecisionId: null,
        action: null,
        orderId: null,
        orderStatus: null,
        submissionAccepted: null,
        detail:
          "PositionGuard strategy runner is not wired in this process yet. No trading cycle was started.",
      };
    }

    return this.dependencies.strategyRunController.requestRun({
      exchangeAccountId,
      market,
      requestedBy: "TELEGRAM",
      requestedCommand: "/run",
    });
  }

  private async buildStatusResponse(exchangeAccountId: string, detail: boolean): Promise<TelegramResponse> {
    const [state, transitions, runs, schedulerRuns] = await Promise.all([
      this.dependencies.operatorState.getState(),
      this.dependencies.operatorState.listTransitions(3),
      this.dependencies.repositories.listReconciliationRuns(exchangeAccountId, 1),
      this.dependencies.repositories.listStrategySchedulerRuns(exchangeAccountId, 5),
    ]);

    const options = buildStatusFormatOptions(
      this.dependencies,
      transitions,
      runs[0] ?? null,
      schedulerRuns,
    );

    return detail
      ? {
          text: formatStatusMessage(state, options),
        }
      : {
          text: formatStatusSummaryMessage(
            state,
            {
              liveSendPath: options?.liveSendPath ?? "DRY_RUN_ADAPTER",
              latestReconciliationRun: options?.latestReconciliationRun ?? null,
              schedulerStatus: options?.schedulerStatus ?? null,
            },
            normalizeTelegramLocale(this.dependencies.locale),
          ),
        };
  }

  private async buildReadinessResponse(
    exchangeAccountId: string,
    detail: boolean,
  ): Promise<TelegramResponse> {
    const [
      executionState,
      latestBalanceSnapshot,
      latestPositionSnapshot,
      reconciliationRuns,
      activeOrders,
      recentRiskEvents,
      pendingNotifications,
    ] = await Promise.all([
      this.dependencies.operatorState.getState(),
      this.dependencies.repositories.getLatestBalanceSnapshot(exchangeAccountId),
      this.dependencies.repositories.getLatestPositionSnapshot(exchangeAccountId),
      this.dependencies.repositories.listReconciliationRuns(exchangeAccountId, 1),
      this.dependencies.repositories.listActiveOrders(exchangeAccountId, undefined, 20),
      this.dependencies.repositories.listRiskEvents(exchangeAccountId, 20),
      this.dependencies.repositories.listPendingOperatorNotifications(exchangeAccountId, { limit: 20 }),
    ]);

    const readinessInput = {
      runtimeConfig: this.dependencies.runtimeConfig ?? null,
      executionState,
      latestBalanceSnapshot,
      latestPositionSnapshot,
      latestReconciliationRun: reconciliationRuns[0] ?? null,
      activeOrders,
      recentRiskEvents,
      pendingNotifications,
      schedulerStatus: this.dependencies.schedulerStatus?.() ?? null,
      inboundStatus: this.dependencies.telegramInboundStatus?.() ?? null,
      now: this.dependencies.now?.() ?? new Date().toISOString(),
    };

    return {
      text: detail
        ? formatReadinessMessage(readinessInput)
        : formatReadinessSummaryMessage(
            readinessInput,
            normalizeTelegramLocale(this.dependencies.locale),
          ),
    };
  }

  private async buildStateHistoryResponse(): Promise<TelegramResponse> {
    const transitions = await this.dependencies.operatorState.listTransitions(10);

    return {
      text: formatStateHistoryMessage(transitions),
    };
  }

  private async buildRiskEventsResponse(exchangeAccountId: string): Promise<TelegramResponse> {
    const events = await this.dependencies.repositories.listRiskEvents(exchangeAccountId, 10);

    return {
      text: formatRiskEventsMessage(events),
    };
  }

  private async buildSchedulerResponse(exchangeAccountId: string): Promise<TelegramResponse> {
    const runs = await this.dependencies.repositories.listStrategySchedulerRuns(exchangeAccountId, 20);

    return {
      text: formatStrategySchedulerRunsMessage(runs, {
        schedulerStatus: this.dependencies.schedulerStatus?.() ?? null,
      }),
    };
  }

  private async buildOrderDetailResponse(
    exchangeAccountId: string,
    reference: string,
  ): Promise<TelegramResponse> {
    const order = await this.dependencies.repositories.findOrderByReference(exchangeAccountId, reference);
    if (!order) {
      return {
        text: formatOrderDetailMessage(null, [], [], reference),
      };
    }

    const [events, fills] = await Promise.all([
      this.dependencies.repositories.listOrderEvents(order.id),
      this.dependencies.repositories.listFills(order.id),
    ]);

    return {
      text: formatOrderDetailMessage(order, events, fills, reference),
    };
  }

  private async buildInboundResponse(exchangeAccountId: string): Promise<TelegramResponse> {
    const offset = this.dependencies.telegramInboundOffsetStore && this.dependencies.telegramInboundBotTokenRef
      ? await this.dependencies.telegramInboundOffsetStore.getTelegramInboundOffset({
          exchangeAccountId,
          updateSource: "GET_UPDATES",
          botTokenRef: this.dependencies.telegramInboundBotTokenRef,
        })
      : null;

    return {
      text: formatTelegramInboundMessage(this.dependencies.telegramInboundStatus?.() ?? null, offset),
    };
  }

  private async buildAlertsResponse(exchangeAccountId: string): Promise<TelegramResponse> {
    const [notifications, attempts, runs] = await Promise.all([
      this.dependencies.repositories.listOperatorNotifications(exchangeAccountId, 10),
      this.dependencies.repositories.listOperatorNotificationDeliveryAttempts(exchangeAccountId, 5),
      this.dependencies.repositories.listOperatorNotificationDeliveryRuns(exchangeAccountId, 5),
    ]);

    return {
      text: formatOperatorNotificationsMessage(notifications, attempts, runs, {
        now: this.dependencies.now?.() ?? new Date().toISOString(),
      }),
    };
  }

  private async buildRecoveryProgressResponse(exchangeAccountId: string): Promise<TelegramResponse> {
    const [runs, checkpoints] = await Promise.all([
      this.dependencies.repositories.listReconciliationRuns(exchangeAccountId, 1),
      this.dependencies.repositories.listHistoryRecoveryCheckpoints(exchangeAccountId),
    ]);

    return {
      text: formatRecoveryProgressMessage(runs[0] ?? null, checkpoints),
    };
  }

  private async buildSyncHistoryResponse(exchangeAccountId: string): Promise<TelegramResponse> {
    const runs = await this.dependencies.repositories.listReconciliationRuns(exchangeAccountId, 10);

    return {
      text: formatReconciliationRunsMessage(runs),
    };
  }

  private async applyControlCommand(
    command: SupportedTelegramCommand,
    transition: () => Promise<import("../../domain/types.js").ExecutionStateRecord>,
  ): Promise<TelegramResponse> {
    const previousState = await this.dependencies.operatorState.getState();
    const nextState = await transition();

    return {
      text: formatControlCommandMessage(
        command,
        previousState,
        nextState,
        this.dependencies.liveSendPath
          ? { liveSendPath: this.dependencies.liveSendPath }
          : undefined,
      ),
    };
  }
}

function buildStatusFormatOptions(
  dependencies: TelegramRouterDependencies,
  transitions: Awaited<ReturnType<OperatorStateStore["listTransitions"]>>,
  latestReconciliationRun: ReconciliationRunRecord | null,
  schedulerRuns: StrategySchedulerRunRecord[],
): {
  executionStateSeed?: NonNullable<TelegramRouterDependencies["executionStateSeed"]>;
  liveSendPath?: NonNullable<TelegramRouterDependencies["liveSendPath"]>;
  transitions?: Awaited<ReturnType<OperatorStateStore["listTransitions"]>>;
  latestReconciliationRun?: ReconciliationRunRecord | null;
  schedulerStatus?: ReturnType<NonNullable<TelegramRouterDependencies["schedulerStatus"]>>;
  schedulerRuns?: StrategySchedulerRunRecord[];
} | undefined {
  const options: {
    executionStateSeed?: NonNullable<TelegramRouterDependencies["executionStateSeed"]>;
    liveSendPath?: NonNullable<TelegramRouterDependencies["liveSendPath"]>;
    transitions?: Awaited<ReturnType<OperatorStateStore["listTransitions"]>>;
    latestReconciliationRun?: ReconciliationRunRecord | null;
    schedulerStatus?: ReturnType<NonNullable<TelegramRouterDependencies["schedulerStatus"]>>;
    schedulerRuns?: StrategySchedulerRunRecord[];
  } = {};

  if (dependencies.executionStateSeed) {
    options.executionStateSeed = dependencies.executionStateSeed;
  }

  if (dependencies.liveSendPath) {
    options.liveSendPath = dependencies.liveSendPath;
  }

  if (transitions.length > 0) {
    options.transitions = transitions;
  }

  options.latestReconciliationRun = latestReconciliationRun;

  if (dependencies.schedulerStatus) {
    options.schedulerStatus = dependencies.schedulerStatus();
  }

  if (schedulerRuns.length > 0) {
    options.schedulerRuns = schedulerRuns;
  }

  return Object.keys(options).length === 0 ? undefined : options;
}
