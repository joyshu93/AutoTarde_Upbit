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
  formatOperatorNotificationsSummaryMessage,
  formatOrderDetailMessage,
  formatOrderDetailSummaryMessage,
  formatOrdersMessage,
  formatOrdersSummaryMessage,
  formatPositionMessage,
  formatPositionSummaryMessage,
  formatReadinessMessage,
  formatReadinessSummaryMessage,
  formatReconciliationRunsMessage,
  formatRecoveryProgressMessage,
  formatRiskEventsMessage,
  formatRiskEventsSummaryMessage,
  formatRuntimeConfigMessage,
  formatStateHistoryMessage,
  formatStrategySchedulerRunsMessage,
  formatStrategySchedulerRunsSummaryMessage,
  formatStrategyPreviewMessage,
  formatStrategyRunMessage,
  formatStatusMessage,
  formatStatusSummaryMessage,
  formatSyncMessage,
  formatTelegramInboundMessage,
  formatTelegramInboundSummaryMessage,
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
import type { TelegramReadOnlyCallbackAction } from "./callbacks.js";
import { getMarketForAsset } from "../../domain/types.js";
import type { ReconciliationRunRecord, StrategySchedulerRunRecord } from "../../domain/types.js";
import type { OperatorStateStore } from "../db/interfaces.js";
import { normalizeTelegramLocale } from "./presentation/locale.js";
import {
  backHomeKeyboard,
  buildTelegramDashboardResponse,
  buildTelegramReadOnlyResponse,
  detailKeyboard,
  expiredCallbackResponse,
  homeKeyboard,
} from "./presentation/dashboard.js";
import {
  formatOrdersPagePresentation,
  sortTelegramOrdersNewestFirst,
  TELEGRAM_ORDER_PAGE_SIZE,
} from "./presentation/orders.js";
import {
  formatAlertDetailPresentation,
  formatAlertsPagePresentation,
  sortTelegramAlertsNewestFirst,
  TELEGRAM_ALERT_PAGE_SIZE,
} from "./presentation/alerts.js";

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

    if (isTelegramStartCommand(input)) {
      return buildTelegramDashboardResponse(normalizeTelegramLocale(this.dependencies.locale));
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
          text: formatRuntimeConfigMessage(
            this.dependencies.runtimeConfig ?? null,
            normalizeTelegramLocale(this.dependencies.locale),
          ),
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
        return this.buildAlertsResponse(
          exchangeAccountId,
          parsed.args[0]?.toLowerCase() === "detail",
        );
      case "/risks":
        return this.buildRiskEventsResponse(
          exchangeAccountId,
          parsed.args[0]?.toLowerCase() === "detail",
        );
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
        return this.buildOrdersResponse(
          exchangeAccountId,
          parsed.args[0]?.toLowerCase() === "detail",
        );
      case "/order":
        return this.buildOrderDetailResponse(
          exchangeAccountId,
          parsed.args[0] ?? "",
          parsed.args[1]?.toLowerCase() === "detail",
        );
      case "/scheduler":
        return this.buildSchedulerResponse(
          exchangeAccountId,
          parsed.args[0]?.toLowerCase() === "detail",
        );
      case "/inbound":
        return this.buildInboundResponse(
          exchangeAccountId,
          parsed.args[0]?.toLowerCase() === "detail",
        );
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
          text: formatSyncMessage(
            await this.requestSync(exchangeAccountId),
            normalizeTelegramLocale(this.dependencies.locale),
          ),
        };
      case "/preview":
        return {
          text: formatStrategyPreviewMessage(
            await this.requestStrategyPreview(parsed.args, exchangeAccountId),
            normalizeTelegramLocale(this.dependencies.locale),
          ),
        };
      case "/run":
        return {
          text: formatStrategyRunMessage(
            await this.requestStrategyRun(parsed.args, exchangeAccountId),
            normalizeTelegramLocale(this.dependencies.locale),
          ),
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

  async routeReadOnlyCallback(
    action: TelegramReadOnlyCallbackAction,
    exchangeAccountId = "primary",
  ): Promise<TelegramResponse> {
    const locale = normalizeTelegramLocale(this.dependencies.locale);
    switch (action.type) {
      case "HOME":
        return buildTelegramDashboardResponse(locale);
      case "STATUS":
      case "STATUS_REFRESH":
        return this.buildCallbackResponse(
          (await this.buildStatusResponse(exchangeAccountId, false)).text,
          detailKeyboard(locale, "status:detail", "status:refresh"),
          locale,
        );
      case "STATUS_DETAIL":
        return this.buildCallbackResponse(
          (await this.buildStatusResponse(exchangeAccountId, true)).text,
          backHomeKeyboard(locale, "status"),
          locale,
        );
      case "READINESS":
      case "READINESS_REFRESH":
        return this.buildCallbackResponse(
          (await this.buildReadinessResponse(exchangeAccountId, false)).text,
          detailKeyboard(locale, "readiness:detail", "readiness:refresh"),
          locale,
        );
      case "READINESS_DETAIL":
        return this.buildCallbackResponse(
          (await this.buildReadinessResponse(exchangeAccountId, true)).text,
          backHomeKeyboard(locale, "readiness"),
          locale,
        );
      case "BALANCES":
        return this.buildCallbackResponse(
          (await this.buildBalanceResponse(exchangeAccountId, false)).text,
          homeKeyboard(locale),
          locale,
        );
      case "POSITIONS":
        return this.buildCallbackResponse(
          (await this.buildPositionResponse(exchangeAccountId, false)).text,
          homeKeyboard(locale),
          locale,
        );
      case "ORDERS_PAGE":
        return this.buildOrdersCallbackPage(action.page, exchangeAccountId, locale);
      case "ORDERS_DETAIL":
        return this.buildOrderCallbackDetail(action.orderId, exchangeAccountId, locale);
      case "ALERTS_PAGE":
        return this.buildAlertsCallbackPage(action.page, exchangeAccountId, locale);
      case "ALERTS_DETAIL":
        return this.buildAlertCallbackDetail(action.alertId, exchangeAccountId, locale);
      case "RISKS":
        return this.buildCallbackResponse(
          (await this.buildRiskEventsResponse(exchangeAccountId, false)).text,
          homeKeyboard(locale),
          locale,
        );
      case "SCHEDULER":
        return this.buildCallbackResponse(
          (await this.buildSchedulerResponse(exchangeAccountId, false)).text,
          homeKeyboard(locale),
          locale,
        );
    }
  }

  private buildCallbackResponse(
    text: string,
    replyMarkup: import("./interfaces.js").TelegramInlineKeyboardMarkup,
    locale: ReturnType<typeof normalizeTelegramLocale>,
  ): TelegramResponse {
    return buildTelegramReadOnlyResponse(text, replyMarkup, locale);
  }

  private async buildOrdersCallbackPage(
    page: number,
    exchangeAccountId: string,
    locale: ReturnType<typeof normalizeTelegramLocale>,
  ): Promise<TelegramResponse> {
    const orders = sortTelegramOrdersNewestFirst(
      await this.dependencies.repositories.listOrders(exchangeAccountId),
    );
    const firstIndex = page * TELEGRAM_ORDER_PAGE_SIZE;
    if (firstIndex >= orders.length && !(page === 0 && orders.length === 0)) {
      return expiredCallbackResponse(locale);
    }

    const visibleCount = Math.min(TELEGRAM_ORDER_PAGE_SIZE, orders.length - firstIndex);
    return this.buildCallbackResponse(
      formatOrdersPagePresentation(orders, page, locale),
      buildPagedKeyboard(locale, "orders", page, firstIndex, visibleCount, orders.length),
      locale,
    );
  }

  private async buildOrderCallbackDetail(
    orderId: number,
    exchangeAccountId: string,
    locale: ReturnType<typeof normalizeTelegramLocale>,
  ): Promise<TelegramResponse> {
    const orders = sortTelegramOrdersNewestFirst(
      await this.dependencies.repositories.listOrders(exchangeAccountId),
    );
    const order = orders[orderId];
    if (!order) {
      return expiredCallbackResponse(locale);
    }

    return this.buildCallbackResponse(
      (await this.buildOrderDetailResponse(exchangeAccountId, order.id, true)).text,
      backHomeKeyboard(locale, `orders:page:${Math.floor(orderId / TELEGRAM_ORDER_PAGE_SIZE)}`),
      locale,
    );
  }

  private async buildAlertsCallbackPage(
    page: number,
    exchangeAccountId: string,
    locale: ReturnType<typeof normalizeTelegramLocale>,
  ): Promise<TelegramResponse> {
    const alerts = sortTelegramAlertsNewestFirst(
      await this.dependencies.repositories.listOperatorNotifications(exchangeAccountId, 10),
    );
    const firstIndex = page * TELEGRAM_ALERT_PAGE_SIZE;
    if (firstIndex >= alerts.length && !(page === 0 && alerts.length === 0)) {
      return expiredCallbackResponse(locale);
    }

    const visibleCount = Math.min(TELEGRAM_ALERT_PAGE_SIZE, alerts.length - firstIndex);
    return this.buildCallbackResponse(
      formatAlertsPagePresentation(alerts, page, locale),
      buildPagedKeyboard(locale, "alerts", page, firstIndex, visibleCount, alerts.length),
      locale,
    );
  }

  private async buildAlertCallbackDetail(
    alertId: number,
    exchangeAccountId: string,
    locale: ReturnType<typeof normalizeTelegramLocale>,
  ): Promise<TelegramResponse> {
    const alerts = sortTelegramAlertsNewestFirst(
      await this.dependencies.repositories.listOperatorNotifications(exchangeAccountId, 10),
    );
    const alert = alerts[alertId];
    if (!alert) {
      return expiredCallbackResponse(locale);
    }

    return this.buildCallbackResponse(
      formatAlertDetailPresentation(alert, locale),
      backHomeKeyboard(locale, `alerts:page:${Math.floor(alertId / TELEGRAM_ALERT_PAGE_SIZE)}`),
      locale,
    );
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

  private async buildOrdersResponse(
    exchangeAccountId: string,
    detail: boolean,
  ): Promise<TelegramResponse> {
    const orders = await this.dependencies.repositories.listOrders(exchangeAccountId);
    return {
      text: detail
        ? formatOrdersMessage(orders, { limit: 20 })
        : formatOrdersSummaryMessage(
            orders,
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
      text: formatStateHistoryMessage(
        transitions,
        normalizeTelegramLocale(this.dependencies.locale),
      ),
    };
  }

  private async buildRiskEventsResponse(
    exchangeAccountId: string,
    detail: boolean,
  ): Promise<TelegramResponse> {
    const events = await this.dependencies.repositories.listRiskEvents(exchangeAccountId, 10);

    return {
      text: detail
        ? formatRiskEventsMessage(events)
        : formatRiskEventsSummaryMessage(
            events,
            normalizeTelegramLocale(this.dependencies.locale),
          ),
    };
  }

  private async buildSchedulerResponse(
    exchangeAccountId: string,
    detail: boolean,
  ): Promise<TelegramResponse> {
    const runs = await this.dependencies.repositories.listStrategySchedulerRuns(exchangeAccountId, 20);
    const schedulerStatus = this.dependencies.schedulerStatus?.() ?? null;

    return {
      text: detail
        ? formatStrategySchedulerRunsMessage(runs, { schedulerStatus })
        : formatStrategySchedulerRunsSummaryMessage(
            runs,
            schedulerStatus,
            normalizeTelegramLocale(this.dependencies.locale),
          ),
    };
  }

  private async buildOrderDetailResponse(
    exchangeAccountId: string,
    reference: string,
    detail: boolean,
  ): Promise<TelegramResponse> {
    const order = await this.dependencies.repositories.findOrderByReference(exchangeAccountId, reference);
    if (!order) {
      return {
        text: detail
          ? formatOrderDetailMessage(null, [], [], reference)
          : formatOrderDetailSummaryMessage(
              null,
              [],
              [],
              reference,
              normalizeTelegramLocale(this.dependencies.locale),
            ),
      };
    }

    const [events, fills] = await Promise.all([
      this.dependencies.repositories.listOrderEvents(order.id),
      this.dependencies.repositories.listFills(order.id),
    ]);

    return {
      text: detail
        ? formatOrderDetailMessage(order, events, fills, reference)
        : formatOrderDetailSummaryMessage(
            order,
            events,
            fills,
            reference,
            normalizeTelegramLocale(this.dependencies.locale),
          ),
    };
  }

  private async buildInboundResponse(
    exchangeAccountId: string,
    detail: boolean,
  ): Promise<TelegramResponse> {
    const status = this.dependencies.telegramInboundStatus?.() ?? null;
    const offset = this.dependencies.telegramInboundOffsetStore && this.dependencies.telegramInboundBotTokenRef
      ? await this.dependencies.telegramInboundOffsetStore.getTelegramInboundOffset({
          exchangeAccountId,
          updateSource: "GET_UPDATES",
          botTokenRef: this.dependencies.telegramInboundBotTokenRef,
        })
      : null;

    return {
      text: detail
        ? formatTelegramInboundMessage(status, offset)
        : formatTelegramInboundSummaryMessage(
            status,
            offset,
            normalizeTelegramLocale(this.dependencies.locale),
          ),
    };
  }

  private async buildAlertsResponse(
    exchangeAccountId: string,
    detail: boolean,
  ): Promise<TelegramResponse> {
    const [notifications, attempts, runs] = await Promise.all([
      this.dependencies.repositories.listOperatorNotifications(exchangeAccountId, 10),
      this.dependencies.repositories.listOperatorNotificationDeliveryAttempts(exchangeAccountId, 5),
      this.dependencies.repositories.listOperatorNotificationDeliveryRuns(exchangeAccountId, 5),
    ]);

    const now = this.dependencies.now?.() ?? new Date().toISOString();
    return {
      text: detail
        ? formatOperatorNotificationsMessage(notifications, attempts, runs, { now })
        : formatOperatorNotificationsSummaryMessage(
            notifications,
            attempts,
            runs,
            normalizeTelegramLocale(this.dependencies.locale),
            { now },
          ),
    };
  }

  private async buildRecoveryProgressResponse(exchangeAccountId: string): Promise<TelegramResponse> {
    const [runs, checkpoints] = await Promise.all([
      this.dependencies.repositories.listReconciliationRuns(exchangeAccountId, 1),
      this.dependencies.repositories.listHistoryRecoveryCheckpoints(exchangeAccountId),
    ]);

    return {
      text: formatRecoveryProgressMessage(
        runs[0] ?? null,
        checkpoints,
        normalizeTelegramLocale(this.dependencies.locale),
      ),
    };
  }

  private async buildSyncHistoryResponse(exchangeAccountId: string): Promise<TelegramResponse> {
    const runs = await this.dependencies.repositories.listReconciliationRuns(exchangeAccountId, 10);

    return {
      text: formatReconciliationRunsMessage(
        runs,
        normalizeTelegramLocale(this.dependencies.locale),
      ),
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
        {
          liveSendPath: this.dependencies.liveSendPath ?? "DRY_RUN_ADAPTER",
          locale: normalizeTelegramLocale(this.dependencies.locale),
        },
      ),
    };
  }
}

function buildPagedKeyboard(
  locale: import("./presentation/locale.js").TelegramLocale,
  resource: "orders" | "alerts",
  page: number,
  firstIndex: number,
  visibleCount: number,
  totalCount: number,
): import("./interfaces.js").TelegramInlineKeyboardMarkup {
  const detailRows = Array.from({ length: visibleCount }, (_, index) => [{
    text: locale === "ko-KR" ? `상세 ${firstIndex + index + 1}` : `Detail ${firstIndex + index + 1}`,
    callbackData: `${resource}:detail:${firstIndex + index}`,
  }]);
  const navigation = [
    ...(page > 0
      ? [{ text: locale === "ko-KR" ? "이전" : "Previous", callbackData: `${resource}:page:${page - 1}` }]
      : []),
    ...((firstIndex + visibleCount) < totalCount
      ? [{ text: locale === "ko-KR" ? "다음" : "Next", callbackData: `${resource}:page:${page + 1}` }]
      : []),
    { text: locale === "ko-KR" ? "홈" : "Home", callbackData: "home" },
  ];

  return { inlineKeyboard: [...detailRows, navigation] };
}

function isTelegramStartCommand(input: string): boolean {
  const [rawCommand = "", ...args] = input.trim().split(/\s+/u);
  return args.length === 0 && rawCommand.toLowerCase().split("@", 1)[0] === "/start";
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
