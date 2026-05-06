import type { PositionGuardStrategyRunner } from "../modules/strategy/position-guard-runner.js";
import type {
  TelegramStrategyRunController,
  TelegramStrategyRunRequest,
  TelegramStrategyRunResult,
} from "../modules/telegram/interfaces.js";

export class InlineTelegramStrategyRunController implements TelegramStrategyRunController {
  private running = false;

  constructor(
    private readonly dependencies: {
      runner: Pick<PositionGuardStrategyRunner, "runOnce">;
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
        detail: `A strategy run is already running for ${request.exchangeAccountId}.`,
      };
    }

    this.running = true;

    try {
      const result = await this.dependencies.runner.runOnce({
        market: request.market,
        generatedAt: requestedAt,
      });

      return {
        status: "COMPLETED",
        requestedAt,
        market: request.market,
        strategyDecisionId: result.strategyDecisionRecord.id,
        action: result.strategyDecision.action,
        orderId: result.submission?.order?.id ?? null,
        orderStatus: result.submission?.order?.status ?? null,
        submissionAccepted: result.submission?.accepted ?? null,
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
        detail: `Strategy run failed: ${message}`,
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

  return `Decision ${result.strategyDecision.action} persisted; order submission rejected: ${submission.reason ?? "unknown reason"}.`;
}
