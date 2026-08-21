import type { PositionGuardStrategyRunner } from "../modules/strategy/position-guard-runner.js";
import type { StrategySchedulerStartupPreflight } from "../domain/types.js";
import type {
  TelegramStrategyRunController,
  TelegramStrategyPreviewRequest,
  TelegramStrategyPreviewResult,
  TelegramStrategyRunRequest,
  TelegramStrategyRunResult,
} from "../modules/telegram/interfaces.js";

export class InlineTelegramStrategyRunController implements TelegramStrategyRunController {
  private running = false;

  constructor(
    private readonly dependencies: {
      runner: Pick<PositionGuardStrategyRunner, "runOnce" | "previewOnce">;
      beforeManualRunPreflight?: () => Promise<StrategySchedulerStartupPreflight | null>;
      now?: () => string;
    },
  ) {}

  async requestRun(request: TelegramStrategyRunRequest): Promise<TelegramStrategyRunResult> {
    const requestedAt = this.dependencies.now?.() ?? new Date().toISOString();
    if (this.running) {
      return {
        status: "ALREADY_RUNNING",
        requestedAt,
        market: request.market,
        strategyDecisionId: null,
        action: null,
        orderId: null,
        orderStatus: null,
        submissionAccepted: null,
        submissionOutcome: null,
        detail: `A strategy run is already running for ${request.exchangeAccountId}.`,
      };
    }

    this.running = true;

    try {
      if (request.requestedBy === "TELEGRAM" && this.dependencies.beforeManualRunPreflight) {
        const preflight = await this.dependencies.beforeManualRunPreflight();
        if (preflight?.status === "BLOCK") {
          return {
            status: "FAILED",
            requestedAt,
            market: request.market,
            strategyDecisionId: null,
            action: null,
            orderId: null,
            orderStatus: null,
            submissionAccepted: null,
            submissionOutcome: null,
            detail: buildManualRunPreflightBlockDetail(preflight),
          };
        }
      }

      const result = await this.dependencies.runner.runOnce({
        market: request.market,
        generatedAt: requestedAt,
      });

      const submissionOutcome = result.submission?.outcome ?? null;
      return {
        status: submissionOutcome === "RECONCILIATION_REQUIRED" || submissionOutcome === "LEASE_BLOCKED"
          ? "FAILED"
          : submissionOutcome === "DUPLICATE" ? "SKIPPED" : "COMPLETED",
        requestedAt,
        market: request.market,
        strategyDecisionId: result.strategyDecisionRecord.id,
        action: result.strategyDecision.action,
        orderId: result.submission?.order?.id ?? null,
        orderStatus: result.submission?.order?.status ?? null,
        submissionAccepted: result.submission?.accepted ?? null,
        submissionOutcome,
        detail: buildStrategyRunDetail(result),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown strategy run failure.";

      return {
        status: "FAILED",
        requestedAt,
        market: request.market,
        strategyDecisionId: null,
        action: null,
        orderId: null,
        orderStatus: null,
        submissionAccepted: null,
        submissionOutcome: null,
        detail: `Strategy run failed: ${message}`,
      };
    } finally {
      this.running = false;
    }
  }

  async requestPreview(request: TelegramStrategyPreviewRequest): Promise<TelegramStrategyPreviewResult> {
    const requestedAt = this.dependencies.now?.() ?? new Date().toISOString();
    if (this.running) {
      return {
        status: "ALREADY_RUNNING",
        requestedAt,
        market: request.market,
        action: null,
        executionDisposition: null,
        referencePrice: null,
        requestedNotionalKrw: null,
        requestedQuantity: null,
        orderSide: null,
        orderType: null,
        orderPrice: null,
        orderVolume: null,
        detail: `A strategy run or preview is already running for ${request.exchangeAccountId}.`,
      };
    }

    this.running = true;

    try {
      const result = await this.dependencies.runner.previewOnce({
        market: request.market,
        generatedAt: requestedAt,
      });

      return {
        status: "COMPLETED",
        requestedAt,
        market: request.market,
        action: result.strategyDecision.action,
        executionDisposition: result.engineDecision.executionDisposition,
        referencePrice: result.strategyDecision.referencePrice,
        requestedNotionalKrw: result.orderPreview?.requestedNotionalKrw ?? result.strategyDecision.requestedNotionalKrw,
        requestedQuantity: result.orderPreview?.requestedQuantity ?? result.strategyDecision.requestedQuantity,
        orderSide: result.orderPreview?.side ?? null,
        orderType: result.orderPreview?.ordType ?? null,
        orderPrice: result.orderPreview?.price ?? null,
        orderVolume: result.orderPreview?.volume ?? null,
        detail: buildStrategyPreviewDetail(result),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown strategy preview failure.";

      return {
        status: "FAILED",
        requestedAt,
        market: request.market,
        action: null,
        executionDisposition: null,
        referencePrice: null,
        requestedNotionalKrw: null,
        requestedQuantity: null,
        orderSide: null,
        orderType: null,
        orderPrice: null,
        orderVolume: null,
        detail: `Strategy preview failed: ${message}`,
      };
    } finally {
      this.running = false;
    }
  }
}

function buildStrategyRunDetail(
  result: Awaited<ReturnType<PositionGuardStrategyRunner["runOnce"]>>,
): string {
  const submission = result.submission;
  if (submission === null) {
    return `Decision ${result.strategyDecision.action} persisted; no order submission was requested.`;
  }

  if (submission.accepted) {
    return `Decision ${result.strategyDecision.action} persisted and submitted through the configured execution path.`;
  }

  if (submission.outcome === "RECONCILIATION_REQUIRED") {
    return `Decision ${result.strategyDecision.action} persisted; order outcome is uncertain and requires reconciliation: ${submission.reason}.`;
  }
  if (submission.outcome === "LEASE_BLOCKED") {
    return `Decision ${result.strategyDecision.action} persisted; order submission was blocked by the account execution lease.`;
  }
  if (submission.outcome === "DUPLICATE") {
    return `Decision ${result.strategyDecision.action} persisted; duplicate order intent was identified and not resent.`;
  }

  return `Decision ${result.strategyDecision.action} persisted; order submission rejected: ${submission.reason ?? "unknown reason"}.`;
}

function buildStrategyPreviewDetail(
  result: Awaited<ReturnType<PositionGuardStrategyRunner["previewOnce"]>>,
): string {
  if (result.orderPreview === null) {
    return `Decision ${result.strategyDecision.action} computed; no order submission would be requested.`;
  }

  return `Decision ${result.strategyDecision.action} computed; order intent ${result.orderPreview.side} ${result.orderPreview.ordType} would require /run to persist and submit through the configured path.`;
}

function buildManualRunPreflightBlockDetail(preflight: StrategySchedulerStartupPreflight): string {
  const blockingChecks = preflight.checks
    .filter((check) => check.status === "BLOCK")
    .map((check) => check.name);

  return blockingChecks.length === 0
    ? `Manual strategy run blocked before decision: ${preflight.detail}`
    : `Manual strategy run blocked before decision: ${preflight.detail} blocking_checks=${blockingChecks.join(",")}`;
}
