import type { PositionGuardStrategyRunner } from "../modules/strategy/position-guard-runner.js";
import type { StrategySchedulerStartupPreflight } from "../domain/types.js";
import type { PositionGuardPilotRefreshReceipt } from "../domain/pilot-types.js";
import { parseCandidatePilotTimestamp } from "../modules/db/pilot-interfaces.js";
import type {
  TelegramStrategyRunController,
  TelegramStrategyPreviewRequest,
  TelegramStrategyPreviewResult,
  TelegramStrategyRunRequest,
  TelegramStrategyRunResult,
} from "../modules/telegram/interfaces.js";

export type CandidateBtcRunPreparationResult =
  | Readonly<{
      status: "READY";
      refreshReceipt: PositionGuardPilotRefreshReceipt;
    }>
  | Readonly<{
      status: "BLOCKED";
      detail: string;
    }>;

export interface CandidateBtcRunPreparation {
  prepare(input: Readonly<{
    exchangeAccountId: string;
    requestedAt: string;
    requestedBy: "TELEGRAM" | "SCHEDULER";
  }>): Promise<CandidateBtcRunPreparationResult>;
}

export class InlineTelegramStrategyRunController implements TelegramStrategyRunController {
  private running = false;

  constructor(
    private readonly dependencies: {
      runner: Pick<PositionGuardStrategyRunner, "runOnce" | "previewOnce">;
      candidateBtcRunPreparation?: CandidateBtcRunPreparation;
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
      let refreshReceipt: PositionGuardPilotRefreshReceipt | undefined;
      const candidatePreparation = request.market === "KRW-BTC"
        ? this.dependencies.candidateBtcRunPreparation
        : undefined;

      if (candidatePreparation) {
        const preparation = await candidatePreparation.prepare(Object.freeze({
          exchangeAccountId: request.exchangeAccountId,
          requestedAt,
          requestedBy: request.requestedBy,
        }));
        if (preparation.status === "BLOCKED") {
          return failedRunResult({
            requestedAt,
            market: request.market,
            detail: `Candidate BTC run blocked before decision: ${preparation.detail}`,
          });
        }
        if (preparation.status !== "READY") {
          throw new Error("Candidate BTC preparation returned an unsupported status.");
        }

        refreshReceipt = snapshotCandidateRefreshReceipt(
          preparation.refreshReceipt,
          request.exchangeAccountId,
          requestedAt,
        );
      } else if (request.requestedBy === "TELEGRAM" && this.dependencies.beforeManualRunPreflight) {
        const preflight = await this.dependencies.beforeManualRunPreflight();
        if (preflight?.status === "BLOCK") {
          return failedRunResult({
            requestedAt,
            market: request.market,
            detail: buildManualRunPreflightBlockDetail(preflight),
          });
        }
      }

      const result = await this.dependencies.runner.runOnce({
        market: request.market,
        generatedAt: requestedAt,
        ...(refreshReceipt === undefined ? {} : { refreshReceipt }),
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

function failedRunResult(input: {
  requestedAt: string;
  market: TelegramStrategyRunRequest["market"];
  detail: string;
}): TelegramStrategyRunResult {
  return {
    status: "FAILED",
    requestedAt: input.requestedAt,
    market: input.market,
    strategyDecisionId: null,
    action: null,
    orderId: null,
    orderStatus: null,
    submissionAccepted: null,
    submissionOutcome: null,
    detail: input.detail,
  };
}

const REFRESH_RECEIPT_KEYS = [
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
] as const satisfies readonly (keyof PositionGuardPilotRefreshReceipt)[];

const REFRESH_RECEIPT_KEY_SET = new Set<string>(REFRESH_RECEIPT_KEYS);

function snapshotCandidateRefreshReceipt(
  value: unknown,
  exchangeAccountId: string,
  requestedAt: string,
): PositionGuardPilotRefreshReceipt {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Candidate BTC refresh receipt must be a plain object.");
  }

  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== REFRESH_RECEIPT_KEYS.length ||
    ownKeys.some((key) => typeof key !== "string" || !REFRESH_RECEIPT_KEY_SET.has(key))
  ) {
    throw new Error("Candidate BTC refresh receipt has an invalid key set.");
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = Object.create(null) as Record<keyof PositionGuardPilotRefreshReceipt, string>;
  for (const key of REFRESH_RECEIPT_KEYS) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string"
    ) {
      throw new Error(`Candidate BTC refresh receipt ${key} must be an enumerable string data property.`);
    }
    fields[key] = descriptor.value;
  }

  for (const key of [
    "exchangeAccountId",
    "balanceSnapshotId",
    "positionSnapshotId",
    "reconciliationRunId",
  ] as const) {
    if (fields[key].trim().length === 0) {
      throw new Error(`Candidate BTC refresh receipt ${key} must not be empty.`);
    }
  }

  for (const key of [
    "requestedAt",
    "balanceCapturedAt",
    "positionCapturedAt",
    "reconciliationStartedAt",
    "reconciliationCompletedAt",
  ] as const) {
    assertExplicitTimezoneTimestamp(fields[key], `Candidate BTC refresh receipt ${key}`);
  }

  if (fields.reconciliationSource !== "SCHEDULER_PREFLIGHT") {
    throw new Error("Candidate BTC refresh receipt reconciliationSource must be SCHEDULER_PREFLIGHT.");
  }
  if (fields.exchangeAccountId !== exchangeAccountId) {
    throw new Error("Candidate BTC refresh receipt exchange account does not match the run request.");
  }
  if (fields.requestedAt !== requestedAt) {
    throw new Error("Candidate BTC refresh receipt requestedAt does not match the run request.");
  }

  return Object.freeze({
    exchangeAccountId: fields.exchangeAccountId,
    requestedAt: fields.requestedAt,
    balanceSnapshotId: fields.balanceSnapshotId,
    balanceCapturedAt: fields.balanceCapturedAt,
    positionSnapshotId: fields.positionSnapshotId,
    positionCapturedAt: fields.positionCapturedAt,
    reconciliationRunId: fields.reconciliationRunId,
    reconciliationStartedAt: fields.reconciliationStartedAt,
    reconciliationCompletedAt: fields.reconciliationCompletedAt,
    reconciliationSource: "SCHEDULER_PREFLIGHT",
  });
}

function assertExplicitTimezoneTimestamp(value: string, label: string): void {
  parseCandidatePilotTimestamp(value, label);
}
