import type { PortfolioSyncService } from "../modules/reconciliation/portfolio-sync-service.js";
import type { OperatorNotificationReporter } from "../modules/telegram/reporter.js";
import type {
  TelegramSyncController,
  TelegramSyncRequest,
  TelegramSyncResult,
} from "../modules/telegram/interfaces.js";

export class InlineTelegramSyncController implements TelegramSyncController {
  private running = false;

  constructor(
    private readonly dependencies: {
      portfolioSyncService: Pick<PortfolioSyncService, "run">;
      reporter?: OperatorNotificationReporter;
      now?: () => string;
    },
  ) {}

  async requestSync(request: TelegramSyncRequest): Promise<TelegramSyncResult> {
    const requestedAt = this.dependencies.now?.() ?? new Date().toISOString();
    if (this.running) {
      return {
        status: "ALREADY_RUNNING",
        requestedAt,
        detail: `A sync is already running for ${request.exchangeAccountId}.`,
      };
    }

    this.running = true;

    try {
      const result = await this.dependencies.portfolioSyncService.run({
        exchangeAccountId: request.exchangeAccountId,
        source: "OPERATOR_SYNC",
      });
      const positionCount = safeCountJsonArray(result.positionSnapshot.positionsJson);
      const driftCodes = result.reconciliationSummary.issues.map((issue) => issue.code);

      return {
        status: "COMPLETED",
        requestedAt: result.requestedAt,
        detail: [
          `Stored balance snapshot (${safeCountJsonArray(result.balanceSnapshot.balancesJson)} balances).`,
          `Stored position snapshot (${positionCount} positions).`,
          `valuation_source=${result.valuationSource}.`,
          `reconciliation_source=${result.reconciliationSummary.source}.`,
          `Reconciliation status=${result.reconciliationSummary.status}.`,
          `issues=${result.reconciliationSummary.issues.length}.`,
          `issue_codes=${driftCodes.length === 0 ? "none" : driftCodes.join(",")}.`,
        ].join(" "),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown sync failure.";
      await this.safeReport({
        exchangeAccountId: request.exchangeAccountId,
        notificationType: "SYNC_FAILED",
        severity: "ERROR",
        title: "Reconciliation sync failed",
        message,
        payload: {
          requestedBy: request.requestedBy,
          requestedCommand: request.requestedCommand,
        },
      });

      return {
        status: "FAILED",
        requestedAt,
        detail: `Sync failed: ${message}`,
      };
    } finally {
      this.running = false;
    }
  }

  private async safeReport(input: {
    exchangeAccountId: string;
    notificationType: "SYNC_FAILED";
    severity: "ERROR";
    title: string;
    message: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (!this.dependencies.reporter) {
      return;
    }

    try {
      await this.dependencies.reporter.report(input);
    } catch {
      // Reporting is best-effort and must not change sync outcomes.
    }
  }
}

function safeCountJsonArray(rawJson: string): number {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
