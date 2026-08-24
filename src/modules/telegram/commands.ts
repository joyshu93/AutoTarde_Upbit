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
  formatStatusMessage,
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
import {
  describePilot,
  formatPilotTechnicalVisibility,
  formatStatusPresentation,
  type BtcCandidatePilotVisibility,
} from "./presentation/status.js";
import { formatStrategyRunPresentation } from "./presentation/run.js";
import { formatStrategyPreviewPresentation } from "./presentation/preview.js";
import type { StrategyDecisionRecord } from "../../domain/types.js";
import type { PositionGuardPilotRefreshReceipt } from "../../domain/pilot-types.js";
import {
  isExactCandidateStateRollbackFlat,
  parseCandidatePilotTimestamp,
  toPositionGuardCandidateRoutingState,
  validateCandidatePilotDeployment,
  type CandidatePilotRepository,
} from "../db/pilot-interfaces.js";

type TelegramCandidatePilotReader = Pick<
  CandidatePilotRepository,
  "getDeploymentForExchangeAccount" | "getExactState"
>;

type TelegramCommandRouterDependencies = TelegramRouterDependencies & Readonly<{
  candidatePilotReader?: TelegramCandidatePilotReader;
}>;

export class TelegramCommandRouter {
  constructor(private readonly dependencies: TelegramCommandRouterDependencies) {}

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
        return this.buildStrategyPreviewResponse(parsed.args, exchangeAccountId);
      case "/run":
        return this.buildStrategyRunResponse(parsed.args, exchangeAccountId);
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

  private async buildStrategyPreviewResponse(
    args: readonly string[],
    exchangeAccountId: string,
  ): Promise<TelegramResponse> {
    const result = await this.requestStrategyPreview(args, exchangeAccountId);
    const btcPilot = result.market === "KRW-BTC"
      ? await this.readBtcPilotVisibility(exchangeAccountId, { kind: "LATEST" })
      : null;
    return {
      text: formatStrategyPreviewPresentation(
        result,
        normalizeTelegramLocale(this.dependencies.locale),
        btcPilot,
      ),
    };
  }

  private async buildStrategyRunResponse(
    args: readonly string[],
    exchangeAccountId: string,
  ): Promise<TelegramResponse> {
    const result = await this.requestStrategyRun(args, exchangeAccountId);
    const btcPilot = result.market === "KRW-BTC"
      ? await this.readBtcPilotVisibility(
          exchangeAccountId,
          result.strategyDecisionId === null
            ? { kind: "NONE" }
            : { kind: "EXACT", strategyDecisionId: result.strategyDecisionId },
        )
      : null;
    return {
      text: formatStrategyRunPresentation(
        result,
        normalizeTelegramLocale(this.dependencies.locale),
        btcPilot,
      ),
    };
  }

  private async buildStatusResponse(exchangeAccountId: string, detail: boolean): Promise<TelegramResponse> {
    const [state, transitions, runs, schedulerRuns, btcPilot] = await Promise.all([
      this.dependencies.operatorState.getState(),
      this.dependencies.operatorState.listTransitions(3),
      this.dependencies.repositories.listReconciliationRuns(exchangeAccountId, 1),
      this.dependencies.repositories.listStrategySchedulerRuns(exchangeAccountId, 5),
      this.readBtcPilotVisibility(exchangeAccountId, { kind: "LATEST" }),
    ]);

    const options = buildStatusFormatOptions(
      this.dependencies,
      transitions,
      runs[0] ?? null,
      schedulerRuns,
    );

    return detail
      ? {
          text: appendPilotTechnicalVisibility(formatStatusMessage(state, options), btcPilot),
        }
      : {
          text: formatStatusPresentation(
            {
              state,
              liveSendPath: options?.liveSendPath ?? "DRY_RUN_ADAPTER",
              latestReconciliationRun: options?.latestReconciliationRun ?? null,
              schedulerStatus: options?.schedulerStatus ?? null,
              btcPilot,
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
      btcPilot,
    ] = await Promise.all([
      this.dependencies.operatorState.getState(),
      this.dependencies.repositories.getLatestBalanceSnapshot(exchangeAccountId),
      this.dependencies.repositories.getLatestPositionSnapshot(exchangeAccountId),
      this.dependencies.repositories.listReconciliationRuns(exchangeAccountId, 1),
      this.dependencies.repositories.listActiveOrders(exchangeAccountId, undefined, 20),
      this.dependencies.repositories.listRiskEvents(exchangeAccountId, 20),
      this.dependencies.repositories.listPendingOperatorNotifications(exchangeAccountId, { limit: 20 }),
      this.readBtcPilotVisibility(exchangeAccountId, { kind: "LATEST" }),
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
        ? appendPilotTechnicalVisibility(formatReadinessMessage(readinessInput), btcPilot)
        : appendPilotSummaryVisibility(
            formatReadinessSummaryMessage(
              readinessInput,
              normalizeTelegramLocale(this.dependencies.locale),
            ),
            btcPilot,
            normalizeTelegramLocale(this.dependencies.locale),
          ),
    };
  }

  private async readBtcPilotVisibility(
    exchangeAccountId: string,
    decisionSelection: BtcPilotDecisionSelection,
  ): Promise<BtcCandidatePilotVisibility | null> {
    const decision = await this.readBtcPilotDecision(exchangeAccountId, decisionSelection);
    const audit = parseBtcPilotDecisionAudit(decision);
    const reader = this.dependencies.candidatePilotReader;
    if (!reader) {
      return audit === null ? null : unavailableBtcPilotVisibility(audit.latestOutcome);
    }

    try {
      const rawDeployment = await reader.getDeploymentForExchangeAccount(exchangeAccountId);
      if (rawDeployment === null) return unavailableBtcPilotVisibility(audit?.latestOutcome ?? null);
      const deployment = validateCandidatePilotDeployment(rawDeployment);
      if (deployment.exchangeAccountId !== exchangeAccountId) {
        return unavailableBtcPilotVisibility(audit?.latestOutcome ?? null);
      }
      const exactState = await reader.getExactState(deployment.id);
      if (exactState === null) return unavailableBtcPilotVisibility(audit?.latestOutcome ?? null);
      toPositionGuardCandidateRoutingState(exactState);

      const routeVerified = audit !== null && isAuditCurrentAndVerified({
        audit,
        exchangeAccountId,
        deploymentId: deployment.id,
        phase: deployment.phase,
        activationAt: deployment.activationAt,
        stateVersion: exactState.stateVersion,
      });
      return {
        deploymentId: deployment.id,
        pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
        phase: deployment.phase,
        policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
        stateVersion: exactState.stateVersion,
        activationAt: deployment.activationAt,
        lastEvidenceAt: exactState.lastEvidenceAt,
        lastEvidenceId: exactState.lastEvidenceId,
        currentAuthorityCheck: "VERIFIED_CURRENT",
        exactFlatCheck: isExactCandidateStateRollbackFlat(exactState)
          ? "VERIFIED_CURRENT"
          : "BLOCKED_NON_FLAT",
        replayCheck: routeVerified ? "VERIFIED_BY_ROUTE" : "UNAVAILABLE",
        leaseCheck: "UNAVAILABLE",
        reconciliationCheck: routeVerified ? "VERIFIED_BY_ROUTE" : "UNAVAILABLE",
        reconciliationRunId: routeVerified ? audit.refreshProvenance?.reconciliationRunId ?? null : null,
        latestOutcome: audit?.latestOutcome ?? null,
      };
    } catch {
      return unavailableBtcPilotVisibility(audit?.latestOutcome ?? null);
    }
  }

  private async readBtcPilotDecision(
    exchangeAccountId: string,
    selection: BtcPilotDecisionSelection,
  ): Promise<StrategyDecisionRecord | null> {
    try {
      let decision: StrategyDecisionRecord | null;
      if (selection.kind === "NONE") return null;
      if (selection.kind === "EXACT") {
        const getById = this.dependencies.repositories.getStrategyDecisionById;
        if (!getById) return null;
        decision = await getById.call(this.dependencies.repositories, selection.strategyDecisionId);
        if (decision?.id !== selection.strategyDecisionId) return null;
      } else {
        decision = await this.dependencies.repositories.getLatestStrategyDecision(exchangeAccountId, "KRW-BTC");
      }
      return decision?.exchangeAccountId === exchangeAccountId && decision.market === "KRW-BTC"
        ? decision
        : null;
    } catch {
      return null;
    }
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

const PILOT_PHASES = new Set([
  "DISABLED",
  "PENDING_FLAT",
  "ACTIVE",
  "PAUSED_FAULT",
  "DRAINING",
] as const);

const PILOT_ROUTE_REASON_CODES = new Set([
  "BASELINE_SELECTION",
  "ETH_BASELINE",
  "PILOT_DISABLED",
  "PENDING_FLAT_NEW_RISK_SUPPRESSED",
  "PENDING_FLAT_RISK_REDUCTION_PRESERVED",
  "PENDING_FLAT_BASELINE_HOLD_PRESERVED",
  "DRAINING_NEW_RISK_SUPPRESSED",
  "DRAINING_RISK_REDUCTION_PRESERVED",
  "DRAINING_BASELINE_HOLD_PRESERVED",
  "PAUSED_FAULT_BLOCKED",
  "CANDIDATE_ALLOWED",
  "CANDIDATE_SUPPRESSED",
  "CANDIDATE_EARLY_THESIS_FAILURE",
] as const);

type BtcPilotDecisionSelection =
  | Readonly<{ kind: "LATEST" }>
  | Readonly<{ kind: "EXACT"; strategyDecisionId: string }>
  | Readonly<{ kind: "NONE" }>;

interface BtcPilotDecisionAudit {
  readonly deploymentId: string | null;
  readonly phase: BtcCandidatePilotVisibility["phase"];
  readonly stateVersion: number | null;
  readonly activationAt: string | null;
  readonly refreshProvenance: PositionGuardPilotRefreshReceipt | null;
  readonly latestOutcome: NonNullable<BtcCandidatePilotVisibility["latestOutcome"]>;
}

const REFRESH_PROVENANCE_KEYS = [
  "exchangeAccountId",
  "requestedAt",
  "balanceSnapshotId",
  "balanceCapturedAt",
  "positionSnapshotId",
  "positionCapturedAt",
  "reconciliationRunId",
  "reconciliationStartedAt",
  "reconciliationCompletedAt",
  "reconciliationSource",
] as const;

function parseBtcPilotDecisionAudit(
  decision: StrategyDecisionRecord | null,
): BtcPilotDecisionAudit | null {
  if (decision === null || decision.market !== "KRW-BTC") return null;

  let basis: unknown;
  try {
    basis = JSON.parse(decision.decisionBasisJson) as unknown;
    parseCandidatePilotTimestamp(decision.createdAt, "Telegram candidate decision createdAt");
  } catch {
    return null;
  }
  if (!isPlainRecord(basis) || !isPlainRecord(basis.policyRoute)) return null;

  const route = basis.policyRoute;
  if (
    route.schemaVersion !== "POSITION_GUARD_POLICY_ROUTE_AUDIT_V1" ||
    route.pilotId !== "BTC_COMBINED_CONSERVATIVE_PILOT_V1" ||
    route.policyVersion !== "PCS-2026-001.DEPLOYMENT_READINESS_V1" ||
    typeof route.phase !== "string" ||
    !PILOT_PHASES.has(route.phase as never) ||
    typeof route.reasonCode !== "string" ||
    !PILOT_ROUTE_REASON_CODES.has(route.reasonCode as never) ||
    typeof route.executionBlocked !== "boolean" ||
    !isNullableNonNegativeSafeInteger(route.stateVersion)
  ) {
    return null;
  }

  const deploymentId = readNullableNonEmptyString(route.deploymentId);
  const activationAt = readNullableNonEmptyString(route.activationAt);
  if (activationAt !== null) {
    try {
      parseCandidatePilotTimestamp(activationAt, "Telegram candidate activationAt");
    } catch {
      return null;
    }
  }
  return {
    deploymentId,
    phase: route.phase as BtcCandidatePilotVisibility["phase"],
    stateVersion: route.stateVersion as number | null,
    activationAt,
    refreshProvenance: parseCompleteRefreshProvenance(route.refreshProvenance, decision.createdAt),
    latestOutcome: {
      strategyDecisionId: decision.id,
      action: decision.action,
      reasonCode: route.reasonCode,
      executionBlocked: route.executionBlocked,
      createdAt: decision.createdAt,
    },
  };
}

function parseCompleteRefreshProvenance(
  value: unknown,
  decisionCreatedAt: string,
): PositionGuardPilotRefreshReceipt | null {
  if (!isExactOwnDataRecord(value, REFRESH_PROVENANCE_KEYS)) return null;
  const strings = REFRESH_PROVENANCE_KEYS.slice(0, -1).map((key) => value[key]);
  if (strings.some((item) =>
    typeof item !== "string" || item.length === 0 || item !== item.trim()
  )) return null;
  if (value.reconciliationSource !== "SCHEDULER_PREFLIGHT") return null;

  const receipt = value as unknown as PositionGuardPilotRefreshReceipt;
  try {
    const requestedAt = parseCandidatePilotTimestamp(receipt.requestedAt, "Telegram refresh requestedAt");
    const balanceAt = parseCandidatePilotTimestamp(receipt.balanceCapturedAt, "Telegram balance capturedAt");
    const positionAt = parseCandidatePilotTimestamp(receipt.positionCapturedAt, "Telegram position capturedAt");
    const reconciliationStartedAt = parseCandidatePilotTimestamp(
      receipt.reconciliationStartedAt,
      "Telegram reconciliation startedAt",
    );
    const reconciliationCompletedAt = parseCandidatePilotTimestamp(
      receipt.reconciliationCompletedAt,
      "Telegram reconciliation completedAt",
    );
    const decisionAt = parseCandidatePilotTimestamp(decisionCreatedAt, "Telegram candidate decision createdAt");
    if (
      requestedAt !== balanceAt ||
      requestedAt !== positionAt ||
      requestedAt > reconciliationStartedAt ||
      reconciliationStartedAt > reconciliationCompletedAt ||
      reconciliationCompletedAt > decisionAt
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return Object.freeze({ ...receipt });
}

function isAuditCurrentAndVerified(input: {
  audit: BtcPilotDecisionAudit;
  exchangeAccountId: string;
  deploymentId: string;
  phase: NonNullable<BtcCandidatePilotVisibility["phase"]>;
  activationAt: string | null;
  stateVersion: number;
}): boolean {
  const receipt = input.audit.refreshProvenance;
  return receipt !== null &&
    receipt.exchangeAccountId === input.exchangeAccountId &&
    input.audit.deploymentId === input.deploymentId &&
    input.audit.phase === input.phase &&
    input.audit.activationAt === input.activationAt &&
    input.audit.stateVersion === input.stateVersion;
}

function unavailableBtcPilotVisibility(
  latestOutcome: BtcCandidatePilotVisibility["latestOutcome"],
): BtcCandidatePilotVisibility {
  return {
    deploymentId: null,
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    phase: null,
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    stateVersion: null,
    activationAt: null,
    lastEvidenceAt: null,
    lastEvidenceId: null,
    currentAuthorityCheck: "BLOCKED_UNAVAILABLE",
    exactFlatCheck: "UNAVAILABLE",
    replayCheck: "UNAVAILABLE",
    leaseCheck: "UNAVAILABLE",
    reconciliationCheck: "UNAVAILABLE",
    reconciliationRunId: null,
    latestOutcome,
  };
}

function appendPilotSummaryVisibility(
  message: string,
  pilot: BtcCandidatePilotVisibility | null,
  locale: ReturnType<typeof normalizeTelegramLocale>,
): string {
  return `${message}\n${describePilot(pilot, locale).join("\n")}`;
}

function appendPilotTechnicalVisibility(
  message: string,
  pilot: BtcCandidatePilotVisibility | null,
): string {
  return pilot === null ? message : `${message}\n${formatPilotTechnicalVisibility(pilot)}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isExactOwnDataRecord<const TKeys extends readonly string[]>(
  value: unknown,
  keys: TKeys,
): value is Record<TKeys[number], unknown> {
  if (!isPlainRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    return false;
  }
  return ownKeys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function isNullableNonNegativeSafeInteger(value: unknown): boolean {
  return value === null || (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function readNullableNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
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
