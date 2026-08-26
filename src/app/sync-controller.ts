import type { PortfolioSyncService } from "../modules/reconciliation/portfolio-sync-service.js";
import type { OperatorNotificationReporter } from "../modules/telegram/reporter.js";
import type {
  TelegramSyncController,
  TelegramSyncRequest,
  TelegramSyncResult,
} from "../modules/telegram/interfaces.js";
import {
  RuntimeOwnershipGuardError,
  type RuntimeOwnershipAuthority,
} from "./runtime-ownership-guard.js";

export class InlineTelegramSyncController implements TelegramSyncController {
  private running = false;
  private readonly runtimeOwnership: RuntimeOwnershipAuthority;

  constructor(
    private readonly dependencies: {
      portfolioSyncService: Pick<PortfolioSyncService, "run">;
      reporter?: OperatorNotificationReporter;
      runtimeOwnership?: RuntimeOwnershipAuthority;
      now?: () => string;
    },
  ) {
    this.runtimeOwnership = dependencies.runtimeOwnership ?? createUnavailableRuntimeOwnershipAuthority();
  }

  async requestSync(request: TelegramSyncRequest): Promise<TelegramSyncResult> {
    this.runtimeOwnership.assertLocallyHeld();
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
      this.runtimeOwnership.assertLocallyHeld();
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
      if (isRuntimeOwnershipFailure(error)) throw error;
      this.runtimeOwnership.assertLocallyHeld();
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
      this.runtimeOwnership.assertLocallyHeld();
      await this.dependencies.reporter.report(input);
      this.runtimeOwnership.assertLocallyHeld();
    } catch (error) {
      if (isRuntimeOwnershipFailure(error)) throw error;
      this.runtimeOwnership.assertLocallyHeld();
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

function createUnavailableRuntimeOwnershipAuthority(): RuntimeOwnershipAuthority {
  return unavailableRuntimeOwnershipAuthority();
}

function unavailableRuntimeOwnershipAuthority(): RuntimeOwnershipAuthority {
  return {
    snapshot: () => ({ status: "UNOWNED", generation: null, executionMode: null, acquiredAtEpochMs: null,
      heartbeatAtEpochMs: null, expiresAtEpochMs: null, takeover: false, lossReason: null }),
    assertLocallyHeld: throwRuntimeOwnershipNotHeld,
    async assertCurrent(): Promise<never> { return throwRuntimeOwnershipNotHeld(); },
  };
}

function throwRuntimeOwnershipNotHeld(): never {
  throw new RuntimeOwnershipGuardError(
    "RUNTIME_OWNERSHIP_NOT_HELD",
    "RUNTIME_OWNERSHIP_NOT_HELD: Runtime ownership is unavailable in this composition.",
  );
}

function isRuntimeOwnershipFailure(error: unknown): boolean {
  return error instanceof RuntimeOwnershipGuardError ||
    (error instanceof Error && /^RUNTIME_OWNERSHIP_(?:LOST|NOT_HELD):/u.test(error.message));
}
