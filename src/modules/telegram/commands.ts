import {
  buildUnsupportedCommandMessage,
  listSupportedTelegramCommands,
  parseTelegramCommand,
  validateTelegramCommand,
} from "./contracts.js";
import {
  formatBalanceMessage,
  formatControlCommandMessage,
  formatOperatorNotificationsMessage,
  formatOrdersMessage,
  formatPositionMessage,
  formatReconciliationRunsMessage,
  formatRecoveryProgressMessage,
  formatRiskEventsMessage,
  formatStateHistoryMessage,
  formatStatusMessage,
  formatSyncMessage,
} from "./formatter.js";
import type {
  ParsedTelegramCommand,
  SupportedTelegramCommand,
  TelegramResponse,
  TelegramRouterDependencies,
  TelegramSyncResult,
} from "./interfaces.js";
import type { ReconciliationRunRecord } from "../../domain/types.js";
import type { OperatorStateStore } from "../db/interfaces.js";

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
      case "/status":
        return this.buildStatusResponse(exchangeAccountId);
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
        return { text: formatBalanceMessage(await this.dependencies.repositories.getLatestBalanceSnapshot(exchangeAccountId)) };
      case "/positions":
        return { text: formatPositionMessage(await this.dependencies.repositories.getLatestPositionSnapshot(exchangeAccountId)) };
      case "/orders":
        return { text: formatOrdersMessage(await this.dependencies.repositories.listOrders(exchangeAccountId)) };
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
      default:
        return {
          text: buildUnsupportedCommandMessage(input),
        };
    }
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

  private async buildStatusResponse(exchangeAccountId: string): Promise<TelegramResponse> {
    const [state, transitions, runs] = await Promise.all([
      this.dependencies.operatorState.getState(),
      this.dependencies.operatorState.listTransitions(3),
      this.dependencies.repositories.listReconciliationRuns(exchangeAccountId, 1),
    ]);

    return {
      text: formatStatusMessage(
        state,
        buildStatusFormatOptions(this.dependencies, transitions, runs[0] ?? null),
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

  private async buildAlertsResponse(exchangeAccountId: string): Promise<TelegramResponse> {
    const [notifications, attempts] = await Promise.all([
      this.dependencies.repositories.listOperatorNotifications(exchangeAccountId, 10),
      this.dependencies.repositories.listOperatorNotificationDeliveryAttempts(exchangeAccountId, 5),
    ]);

    return {
      text: formatOperatorNotificationsMessage(notifications, attempts, {
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
): {
  executionStateSeed?: NonNullable<TelegramRouterDependencies["executionStateSeed"]>;
  liveSendPath?: NonNullable<TelegramRouterDependencies["liveSendPath"]>;
  transitions?: Awaited<ReturnType<OperatorStateStore["listTransitions"]>>;
  latestReconciliationRun?: ReconciliationRunRecord | null;
} | undefined {
  const options: {
    executionStateSeed?: NonNullable<TelegramRouterDependencies["executionStateSeed"]>;
    liveSendPath?: NonNullable<TelegramRouterDependencies["liveSendPath"]>;
    transitions?: Awaited<ReturnType<OperatorStateStore["listTransitions"]>>;
    latestReconciliationRun?: ReconciliationRunRecord | null;
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

  return Object.keys(options).length === 0 ? undefined : options;
}
