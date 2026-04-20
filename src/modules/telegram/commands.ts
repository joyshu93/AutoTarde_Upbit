import {
  buildUnsupportedCommandMessage,
  listSupportedTelegramCommands,
  parseTelegramCommand,
  validateTelegramCommand,
} from "./contracts.js";
import {
  formatBalanceMessage,
  formatControlCommandMessage,
  formatOrdersMessage,
  formatPositionMessage,
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
        return { text: formatStatusMessage(await this.dependencies.operatorState.getState()) };
      case "/balances":
        return { text: formatBalanceMessage(await this.dependencies.repositories.getLatestBalanceSnapshot(exchangeAccountId)) };
      case "/positions":
        return { text: formatPositionMessage(await this.dependencies.repositories.getLatestPositionSnapshot(exchangeAccountId)) };
      case "/orders":
        return { text: formatOrdersMessage(await this.dependencies.repositories.listOrders(exchangeAccountId)) };
      case "/pause":
        return {
          text: formatControlCommandMessage(
            parsed.command,
            await this.dependencies.operatorState.pause(
              parsed.args.join(" ").trim() || "paused_by_operator",
            ),
          ),
        };
      case "/resume":
        return {
          text: formatControlCommandMessage(
            parsed.command,
            await this.dependencies.operatorState.resume(),
          ),
        };
      case "/killswitch":
        return {
          text: formatControlCommandMessage(
            parsed.command,
            await this.dependencies.operatorState.activateKillSwitch(
              parsed.args.join(" ").trim() || "killswitch_activated",
            ),
          ),
        };
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
}
