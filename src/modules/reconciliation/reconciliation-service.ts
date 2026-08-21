import type {
  BalanceSnapshotRecord,
  ExecutionMode,
  FillRecord,
  OrderLifecycleStatus,
  OrderRecord,
  PositionSnapshot,
  PositionSnapshotRecord,
  RiskEventRecord,
} from "../../domain/types.js";
import { SUPPORTED_MARKETS } from "../../domain/types.js";
import { createFingerprint, createId } from "../../shared/ids.js";
import type { ExecutionRepository, OperatorStateStore } from "../db/interfaces.js";
import type { CandidateExecutionEvidenceService } from "../execution/candidate-evidence-service.js";
import { ExchangeOrderLookupError } from "../exchange/errors.js";
import type { ExchangeAdapter, ExchangeOrderSnapshot, ExchangeFillSnapshot } from "../exchange/interfaces.js";
import { parseCandidateEvidenceTimestamp } from "../execution/candidate-evidence-decimals.js";
import type { OperatorNotificationReporter } from "../telegram/reporter.js";
import type { ReconciliationIssue, ReconciliationSummary, ReconciliationTrigger } from "./interfaces.js";
import { detectPortfolioDrift } from "./portfolio-drift.js";
import {
  evaluateBoundedAbsence,
  isPotentiallyDispatchedRecoveryStatus,
} from "./submission-recovery-state-machine.js";
import {
  DEFAULT_MAX_TERMINAL_CANDIDATE_PROJECTIONS_PER_RUN,
  TerminalCandidateProjectionSweep,
} from "./terminal-candidate-sweep.js";

const TERMINAL_RECONCILIATION_STATUSES = new Set<OrderLifecycleStatus>([
  "FILLED",
  "CANCELED",
  "REJECTED",
  "FAILED",
]);
const MANAGED_MARKETS = ["KRW-BTC", "KRW-ETH"] as const satisfies typeof SUPPORTED_MARKETS;
const EXCHANGE_HISTORY_PAGE_LIMIT = 20;
const DEFAULT_HISTORY_MAX_PAGES_PER_MARKET = 3;
const DEFAULT_CLOSED_ORDER_LOOKBACK_DAYS = 7;
const DEFAULT_HISTORY_STOP_BEFORE_DAYS = 365;
const DEFAULT_HISTORY_RETENTION_ASSUMPTION_DAYS = 365;
export const DEFAULT_IDENTIFIER_RECOVERY_POLICY = Object.freeze({
  minimumNotFoundObservations: 2,
  minimumElapsedMs: 60_000,
});
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface ExchangeHistoryRecoveryResult {
  snapshots: ExchangeOrderSnapshot[];
  historyRecovery: NonNullable<ReconciliationSummary["historyRecovery"]> | null;
}

export interface IdentifierRecoveryPolicy {
  minimumNotFoundObservations: number;
  minimumElapsedMs: number;
}

export interface ReconciliationRecoveryClock {
  now(): { observedAt: string; observedAtEpochMs: number };
}

export type IdentifierRecoveryOutcome =
  | "RECOVERED"
  | "RECOVERED_BUT_PROJECTION_FAILED"
  | "STILL_UNCERTAIN"
  | "ABSENCE_CONFIRMED"
  | "TRANSIENT_FAILURE";

export interface IdentifierRecoverySummary {
  outcome: IdentifierRecoveryOutcome;
  orderId: string;
  detail: string;
}

export class ReconciliationService {
  constructor(
    private readonly dependencies: {
      repositories: ExecutionRepository;
      operatorState: OperatorStateStore;
      orderReader?: Pick<ExchangeAdapter, "getOrder">;
      orderHistoryReader?: Pick<ExchangeAdapter, "listOpenOrders" | "listClosedOrders">;
      reporter?: OperatorNotificationReporter;
      maxOrderLookupsPerRun?: number;
      historyMaxPagesPerMarket?: number;
      closedOrderLookbackDays?: number;
      historyStopBeforeDays?: number;
      historyRetentionAssumptionDays?: number;
      identifierRecovery?: IdentifierRecoveryPolicy;
      recoveryClock?: ReconciliationRecoveryClock;
      candidateEvidenceService?: Pick<CandidateExecutionEvidenceService, "processTerminalOrder">;
      maxTerminalCandidateProjectionsPerRun?: number;
    },
  ) {}

  async recoverOrderByIdentifier(order: OrderRecord): Promise<IdentifierRecoverySummary> {
    if (isSubmissionAbsenceConfirmed(order)) {
      return {
        outcome: "ABSENCE_CONFIRMED",
        orderId: order.id,
        detail: "Bounded identifier recovery previously confirmed persistent exchange absence.",
      };
    }
    if (!isPotentiallyDispatchedRecoveryStatus(order.status)) {
      throw new Error(`Order ${order.id} is not eligible for submission recovery.`);
    }
    if (!this.dependencies.orderReader || (!order.upbitUuid && !order.identifier)) {
      return {
        outcome: "STILL_UNCERTAIN",
        orderId: order.id,
        detail: "No exchange lookup reference is available for uncertain submission recovery.",
      };
    }
    const observations = this.recoveryObservationRepository();
    const now = this.recoveryClock().now();
    validateRecoveryObservationTime(now);
    const queries = [
      ...(order.upbitUuid ? [{ uuid: order.upbitUuid }] : []),
      ...(order.identifier ? [{ identifier: order.identifier }] : []),
    ];
    let snapshot: ExchangeOrderSnapshot | null = null;
    let matchedQuery: { uuid?: string; identifier?: string } | null = null;
    try {
      for (const query of queries) {
        const candidate = await this.dependencies.orderReader.getOrder(query);
        if (candidate) {
          snapshot = candidate;
          matchedQuery = query;
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown identifier recovery lookup failure.";
      if (isTypedTransientLookupError(error)) {
        await this.recordRecoveryObservation(order, "TRANSIENT_FAILURE", now, {
          attemptedQueries: queries,
          reason: message,
        });
        return {
          outcome: "TRANSIENT_FAILURE",
          orderId: order.id,
          detail: `Transient identifier recovery lookup failure: ${message}`,
        };
      }
      throw error;
    }

    if (snapshot) {
      await this.recordRecoveryObservation(order, "FOUND", now, {
        query: matchedQuery,
        attemptedQueries: queries,
        uuid: snapshot.uuid,
      });
      try {
        const issues = await this.applyExchangeSnapshot(order, snapshot, now.observedAt);
        const projectionFailure = issues.find((issue) => issue.code === "CANDIDATE_EVIDENCE_PROJECTION_FAILED");
        if (projectionFailure) {
          await this.persistRecoveredProjectionFailure(order, now.observedAt, projectionFailure.message);
          return {
            outcome: "RECOVERED_BUT_PROJECTION_FAILED",
            orderId: order.id,
            detail: "Exchange order was recovered, but terminal candidate projection failed and paused execution.",
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown recovered snapshot projection failure.";
        await this.persistRecoveredProjectionFailure(order, now.observedAt, message);
        return {
          outcome: "RECOVERED_BUT_PROJECTION_FAILED",
          orderId: order.id,
          detail: `Exchange order was recovered, but local projection failed: ${message}`,
        };
      }
      return {
        outcome: "RECOVERED",
        orderId: order.id,
        detail: "Exchange order recovery lookup found a matching order.",
      };
    }

    await this.recordRecoveryObservation(order, "NOT_FOUND", now, { attemptedQueries: queries });
    const policy = validateIdentifierRecoveryPolicy(
      this.dependencies.identifierRecovery ?? DEFAULT_IDENTIFIER_RECOVERY_POLICY,
    );
    const persisted = await observations.listOrderSubmissionRecoveryObservations(order.id);
    const absence = evaluateBoundedAbsence(persisted, policy);
    if (!absence.confirmed) {
      return {
        outcome: "STILL_UNCERTAIN",
        orderId: order.id,
        detail:
          `Persisted absence evidence is below the explicit recovery bound ` +
          `(${absence.notFoundObservationCount}/${policy.minimumNotFoundObservations}; ` +
          `${absence.elapsedMs}/${policy.minimumElapsedMs}ms).`,
      };
    }
    const finalizer = this.dependencies.repositories.finalizeBoundedSubmissionAbsence;
    if (!finalizer) {
      throw new Error("Atomic bounded submission absence finalization is unavailable.");
    }
    const message = "Bounded identifier recovery confirmed persistent exchange absence.";
    const finalized = await finalizer.call(this.dependencies.repositories, {
      orderId: order.id,
      expectedStatus: order.status,
      expectedUpdatedAt: order.updatedAt,
      failedAt: now.observedAt,
      failureCode: "ORDER_SUBMISSION_ABSENCE_CONFIRMED",
      failureMessage: message,
      event: {
        id: `identifier-recovery-absence-event:${order.id}`,
        orderId: order.id,
        eventType: "RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED",
        eventSource: "RECONCILIATION",
        payloadJson: JSON.stringify({
          absenceObservationCount: absence.notFoundObservationCount,
          elapsedMs: absence.elapsedMs,
          minimumNotFoundObservations: policy.minimumNotFoundObservations,
          minimumElapsedMs: policy.minimumElapsedMs,
        }),
        createdAt: now.observedAt,
      },
      faultPause: {
        exchangeAccountId: order.exchangeAccountId,
        faultId: `identifier-recovery-absence:${order.id}`,
        reason: message,
        occurredAt: now.observedAt,
      },
    });
    if (!finalized) {
      return {
        outcome: "STILL_UNCERTAIN",
        orderId: order.id,
        detail: "Bounded absence finalization lost its order compare-and-set and did not overwrite newer recovery evidence.",
      };
    }
    return {
      outcome: "ABSENCE_CONFIRMED",
      orderId: order.id,
      detail: message,
    };
  }

  async run(
    exchangeAccountId: string,
    options?: {
      source?: ReconciliationTrigger;
      portfolioSnapshots?: {
        previousBalanceSnapshot: BalanceSnapshotRecord | null;
        currentBalanceSnapshot: BalanceSnapshotRecord | null;
        previousPositionSnapshot: PositionSnapshotRecord | null;
        currentPositionSnapshot: PositionSnapshotRecord | null;
      };
    },
  ): Promise<ReconciliationSummary> {
    const maxOrderLookupsPerRun = this.dependencies.maxOrderLookupsPerRun ?? 10;
    const startedAt = new Date().toISOString();
    const [openOrders, allOrders, state] = await Promise.all([
      this.dependencies.repositories.listActiveOrders(exchangeAccountId),
      this.dependencies.repositories.listOrders(exchangeAccountId),
      this.dependencies.operatorState.getState(),
    ]);
    const issues: ReconciliationIssue[] = [];
    const dryRunRepairIssues = await this.repairLocalDryRunOrders(openOrders, startedAt);
    issues.push(...dryRunRepairIssues);
    if (this.dependencies.candidateEvidenceService) {
      const projectionSweep = await new TerminalCandidateProjectionSweep({
        repositories: this.dependencies.repositories,
        projector: this.dependencies.candidateEvidenceService,
        maximumPerRun: this.dependencies.maxTerminalCandidateProjectionsPerRun ??
          DEFAULT_MAX_TERMINAL_CANDIDATE_PROJECTIONS_PER_RUN,
      }).run(exchangeAccountId);
      for (const orderId of projectionSweep.failedOrderIds) {
        issues.push({
          code: "CANDIDATE_EVIDENCE_PROJECTION_FAILED",
          message: `Candidate evidence projection failed for terminal order ${orderId}.`,
        });
      }
      if (projectionSweep.deferredCount > 0) {
        issues.push({
          code: "CANDIDATE_EVIDENCE_PROJECTION_DEFERRED",
          message: `Deferred ${projectionSweep.deferredCount} terminal candidate projection(s) after the bounded sweep.`,
        });
      }
    }
    const exchangeBackedOpenOrders = openOrders.filter((order) => !isLocalDryRunExchangeArtifact(order));
    const terminalOrders = await this.listTerminalOrdersNeedingBackfill(allOrders);
    const candidates = buildReconciliationCandidates(exchangeBackedOpenOrders, terminalOrders);
    let processedCount = 0;

    const historyRecovery = await this.recoverMissingExchangeOrders(
      exchangeAccountId,
      allOrders,
      state.executionMode,
      startedAt,
    );
    issues.push(...historyRecovery.issues);

    for (const candidate of candidates.slice(0, maxOrderLookupsPerRun)) {
      processedCount += 1;
      const candidateIssues = candidate.kind === "active"
        ? await this.reconcileActiveOrder(candidate.order, startedAt)
        : await this.reconcileTerminalOrder(candidate.order, startedAt);
      issues.push(...candidateIssues);
    }

    const deferredCount = Math.max(0, candidates.length - processedCount);
    if (deferredCount > 0) {
      issues.push({
        code: "ORDER_LOOKUP_DEFERRED",
        message: `Deferred ${deferredCount} reconciliation lookup(s) after reaching the per-run budget ${maxOrderLookupsPerRun}.`,
      });
    }

    const portfolioIssues = await this.detectPortfolioDrift(exchangeAccountId, startedAt, options?.portfolioSnapshots);
    issues.push(...portfolioIssues);

    const summary: ReconciliationSummary = {
      source: options?.source ?? "DIRECT_RUN",
      status: issues.length === 0 ? "SUCCESS" : "DRIFT_DETECTED",
      issues,
      candidateCount: candidates.length,
      processedCount,
      deferredCount,
      maxOrderLookupsPerRun,
      ...(historyRecovery.historyRecovery ? { historyRecovery: historyRecovery.historyRecovery } : {}),
    };

    await this.dependencies.repositories.saveReconciliationRun({
      id: createId("recon_run"),
      exchangeAccountId,
      status: summary.status,
      startedAt,
      completedAt: new Date().toISOString(),
      summaryJson: JSON.stringify(summary),
      errorMessage: null,
    });
    if (summary.status === "DRIFT_DETECTED") {
      await this.safeReport({
        exchangeAccountId,
        notificationType: "RECONCILIATION_DRIFT_DETECTED",
        severity: "WARN",
        title: "Reconciliation drift detected",
        message: `Detected ${summary.issues.length} reconciliation issue(s) during ${summary.source}.`,
        payload: {
          source: summary.source,
          issueCount: summary.issues.length,
          issueCodes: summary.issues.map((issue) => issue.code),
        },
      });
    }

    return summary;
  }

  private async detectPortfolioDrift(
    exchangeAccountId: string,
    createdAt: string,
    snapshots:
      | {
          previousBalanceSnapshot: BalanceSnapshotRecord | null;
          currentBalanceSnapshot: BalanceSnapshotRecord | null;
          previousPositionSnapshot: PositionSnapshotRecord | null;
          currentPositionSnapshot: PositionSnapshotRecord | null;
        }
      | undefined,
  ): Promise<ReconciliationIssue[]> {
    if (!snapshots) {
      return [];
    }

    const fills = await this.dependencies.repositories.listFills();
    const evaluation = detectPortfolioDrift({
      previousBalanceSnapshot: snapshots.previousBalanceSnapshot,
      currentBalanceSnapshot: snapshots.currentBalanceSnapshot,
      previousPositionSnapshot: snapshots.previousPositionSnapshot,
      currentPositionSnapshot: snapshots.currentPositionSnapshot,
      fills,
    });

    if (evaluation.findings.length === 0) {
      return [];
    }

    for (const finding of evaluation.findings) {
      await this.dependencies.repositories.saveRiskEvent({
        id: createId("risk_event"),
        exchangeAccountId,
        strategyDecisionId: null,
        orderId: null,
        level: "WARN",
        ruleCode: finding.code,
        message: finding.message,
        payloadJson: JSON.stringify(finding.payload),
        createdAt,
      });
    }

    return evaluation.findings.map((finding) => ({
      code: finding.code,
      message: finding.message,
    }));
  }

  private async listTerminalOrdersNeedingBackfill(orders: OrderRecord[]): Promise<OrderRecord[]> {
    const candidates = orders.filter(
      (order) =>
        !isLocalDryRunExchangeArtifact(order) &&
        !isSubmissionAbsenceConfirmed(order) &&
        TERMINAL_RECONCILIATION_STATUSES.has(order.status) &&
        Boolean(order.upbitUuid || order.identifier),
    );
    const fillsByOrder = await Promise.all(
      candidates.map(async (order) => ({
        order,
        fills: await this.dependencies.repositories.listFills(order.id),
      })),
    );

    return fillsByOrder
      .filter(({ order, fills }) => shouldReconcileTerminalOrder(order, fills.length))
      .map(({ order }) => order);
  }

  private async repairLocalDryRunOrders(
    orders: OrderRecord[],
    repairedAt: string,
  ): Promise<ReconciliationIssue[]> {
    const issues: ReconciliationIssue[] = [];
    const dryRunOrders = orders.filter(isLocalDryRunExchangeArtifact);

    for (const order of dryRunOrders) {
      const existingFills = await this.dependencies.repositories.listFills(order.id);
      if (existingFills.length > 0) {
        await this.dependencies.repositories.updateOrder({
          ...order,
          status: "FILLED",
          failureCode: null,
          failureMessage: null,
          updatedAt: repairedAt,
        });
        await this.dependencies.repositories.appendOrderEvent({
          id: createId("order_event"),
          orderId: order.id,
          eventType: "DRY_RUN_ORDER_REPAIRED",
          eventSource: "RECONCILIATION",
          payloadJson: JSON.stringify({
            previousStatus: order.status,
            nextStatus: "FILLED",
            existingFillCount: existingFills.length,
            settlement: "LOCAL_DRY_RUN_REPAIR",
          }),
          createdAt: repairedAt,
        });
        issues.push({
          code: "DRY_RUN_ORDER_REPAIRED",
          message: `Dry-run local order ${order.id} was repaired to FILLED using existing local fill evidence.`,
        });
        continue;
      }

      const syntheticFill = await this.createDryRunRepairFill(order, repairedAt);
      if (!syntheticFill) {
        await this.dependencies.repositories.updateOrder({
          ...order,
          status: "CANCELED",
          failureCode: null,
          failureMessage: null,
          updatedAt: repairedAt,
        });
        await this.dependencies.repositories.appendOrderEvent({
          id: createId("order_event"),
          orderId: order.id,
          eventType: "DRY_RUN_ORDER_REPAIRED",
          eventSource: "RECONCILIATION",
          payloadJson: JSON.stringify({
            previousStatus: order.status,
            nextStatus: "CANCELED",
            syntheticFillCreated: false,
            settlement: "LOCAL_DRY_RUN_REPAIR",
            reason: "price_or_volume_unavailable",
          }),
          createdAt: repairedAt,
        });
        issues.push({
          code: "DRY_RUN_ORDER_REPAIRED",
          message: `Dry-run local order ${order.id} was repaired to CANCELED because price or volume evidence was unavailable.`,
        });
        continue;
      }

      await this.dependencies.repositories.saveFill(syntheticFill);
      await this.dependencies.repositories.updateOrder({
        ...order,
        status: "FILLED",
        failureCode: null,
        failureMessage: null,
        updatedAt: repairedAt,
      });
      await this.dependencies.repositories.appendOrderEvent({
        id: createId("order_event"),
        orderId: order.id,
        eventType: "ORDER_FILLED",
        eventSource: "RECONCILIATION",
        payloadJson: JSON.stringify({
          previousStatus: order.status,
          nextStatus: "FILLED",
          syntheticFillCreated: true,
          settlement: "LOCAL_DRY_RUN_REPAIR",
          fillId: syntheticFill.exchangeFillId,
        }),
        createdAt: repairedAt,
      });
      issues.push({
        code: "DRY_RUN_ORDER_REPAIRED",
        message: `Dry-run local order ${order.id} was repaired to FILLED with a synthetic local fill.`,
      });
    }

    return issues;
  }

  private async createDryRunRepairFill(
    order: OrderRecord,
    repairedAt: string,
  ): Promise<FillRecord | null> {
    const price = await this.resolveDryRunRepairPrice(order);
    const volume = resolveDryRunRepairVolume(order, price);
    if (!price || !volume) {
      return null;
    }

    const exchangeFillId = `dryrun_repair:${order.id}`;
    return {
      id: createId("fill"),
      orderId: order.id,
      exchangeFillId,
      market: order.market,
      side: order.side,
      price,
      volume,
      feeCurrency: null,
      feeAmount: null,
      executionTimestampProvenance: "LOCAL_SYNTHETIC",
      executionEpochNs: tryParseEpochNanoseconds(repairedAt),
      filledAt: repairedAt,
      rawPayloadJson: JSON.stringify({
        mode: "DRY_RUN",
        settlement: "LOCAL_DRY_RUN_REPAIR",
        orderId: order.id,
        identifier: order.identifier,
        upbitUuid: order.upbitUuid,
      }),
    };
  }

  private async resolveDryRunRepairPrice(order: OrderRecord): Promise<string | null> {
    if (isPositiveNumericString(order.price)) {
      return order.price;
    }

    const snapshot = await this.dependencies.repositories.getLatestPositionSnapshot(order.exchangeAccountId);
    const position = parsePositions(snapshot).find((candidate) => candidate.market === order.market);
    if (isPositiveNumericString(position?.markPrice ?? null)) {
      return position?.markPrice ?? null;
    }

    if (isPositiveNumericString(position?.averageEntryPrice ?? null)) {
      return position?.averageEntryPrice ?? null;
    }

    return null;
  }

  private async recoverMissingExchangeOrders(
    exchangeAccountId: string,
    localOrders: OrderRecord[],
    executionMode: ExecutionMode,
    reconciledAt: string,
  ): Promise<{
    issues: ReconciliationIssue[];
    historyRecovery: ReconciliationSummary["historyRecovery"];
  }> {
    if (!this.dependencies.orderHistoryReader) {
      return {
        issues: [],
        historyRecovery: undefined,
      };
    }

    const knownUuids = new Set(
      localOrders.map((order) => order.upbitUuid).filter((value): value is string => typeof value === "string"),
    );
    const knownIdentifiers = new Set(
      localOrders.map((order) => order.identifier).filter((value): value is string => typeof value === "string"),
    );

    try {
      const exchangeHistory = await this.listExchangeHistorySnapshots(exchangeAccountId, reconciledAt);
      const issues: ReconciliationIssue[] = [];
      let recoveredOrderCount = 0;

      for (const snapshot of exchangeHistory.snapshots) {
        if (knownUuids.has(snapshot.uuid)) {
          continue;
        }

        if (snapshot.identifier && knownIdentifiers.has(snapshot.identifier)) {
          continue;
        }

        const recoveredOrder = buildRecoveredOrderRecord({
          exchangeAccountId,
          executionMode,
          snapshot,
          recoveredAt: reconciledAt,
        });

        await this.dependencies.repositories.saveOrder(recoveredOrder);
        await this.dependencies.repositories.appendOrderEvent({
          id: createId("order_event"),
          orderId: recoveredOrder.id,
          eventType: "RECONCILIATION_HISTORY_RECOVERED",
          eventSource: "RECONCILIATION",
          payloadJson: JSON.stringify({
            exchangeState: snapshot.state,
            market: snapshot.market,
            upbitUuid: snapshot.uuid,
            identifier: snapshot.identifier,
          }),
          createdAt: reconciledAt,
        });

        knownUuids.add(snapshot.uuid);
        knownIdentifiers.add(recoveredOrder.identifier);
        recoveredOrderCount += 1;
        issues.push({
          code: "EXCHANGE_ORDER_RECOVERED",
          message: `Recovered exchange order ${recoveredOrder.id} for ${snapshot.market} from exchange history state ${snapshot.state}.`,
        });
        issues.push(...await this.applyExchangeSnapshot(recoveredOrder, snapshot, reconciledAt));
      }

      return {
        issues,
        historyRecovery: exchangeHistory.historyRecovery
          ? {
              ...exchangeHistory.historyRecovery,
              recoveredOrderCount,
            }
          : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown exchange history lookup failure.";
      return {
        issues: [
          {
            code: "ORDER_HISTORY_LOOKUP_FAILED",
            message: `Exchange order history lookup failed. ${message}`,
          },
        ],
        historyRecovery: buildFailedHistoryRecoverySummary({
          reconciledAt,
          closedOrderLookbackDays: this.dependencies.closedOrderLookbackDays,
          historyStopBeforeDays: this.dependencies.historyStopBeforeDays,
          historyRetentionAssumptionDays: this.dependencies.historyRetentionAssumptionDays,
          failureMessage: message,
        }),
      };
    }
  }

  private async listExchangeHistorySnapshots(
    exchangeAccountId: string,
    reconciledAt: string,
  ): Promise<ExchangeHistoryRecoveryResult> {
    const orderHistoryReader = this.dependencies.orderHistoryReader;
    if (!orderHistoryReader) {
      return {
        snapshots: [],
        historyRecovery: null,
      };
    }

    const historyMaxPagesPerMarket = Math.max(
      1,
      Math.trunc(this.dependencies.historyMaxPagesPerMarket ?? DEFAULT_HISTORY_MAX_PAGES_PER_MARKET),
    );
    const closedOrderLookbackDays = Math.max(
      1,
      Math.trunc(this.dependencies.closedOrderLookbackDays ?? DEFAULT_CLOSED_ORDER_LOOKBACK_DAYS),
    );
    const historyStopBeforeDays = Math.max(
      closedOrderLookbackDays,
      Math.trunc(this.dependencies.historyStopBeforeDays ?? DEFAULT_HISTORY_STOP_BEFORE_DAYS),
    );
    const historyRetentionAssumptionDays = Math.max(
      closedOrderLookbackDays,
      Math.trunc(this.dependencies.historyRetentionAssumptionDays ?? DEFAULT_HISTORY_RETENTION_ASSUMPTION_DAYS),
    );
    const parsedReconciledAt = Date.parse(reconciledAt);
    const closedOrderEndTimeMs = Number.isFinite(parsedReconciledAt) ? parsedReconciledAt : Date.now();
    const closedOrderStartTimeMs =
      closedOrderEndTimeMs - closedOrderLookbackDays * MILLISECONDS_PER_DAY;
    const stopBeforeTimeMs = closedOrderEndTimeMs - historyStopBeforeDays * MILLISECONDS_PER_DAY;
    const retentionBoundaryTimeMs =
      closedOrderEndTimeMs - historyRetentionAssumptionDays * MILLISECONDS_PER_DAY;
    const stopBeforeAt = new Date(stopBeforeTimeMs).toISOString();
    const retentionBoundaryAt = new Date(retentionBoundaryTimeMs).toISOString();
    const recentClosedWindowStartAt = new Date(closedOrderStartTimeMs).toISOString();
    const recentClosedWindowEndAt = new Date(closedOrderEndTimeMs).toISOString();

    const batches = await Promise.all(
      MANAGED_MARKETS.map(async (market) => {
        const checkpoint = await this.dependencies.repositories.getHistoryRecoveryCheckpoint(
          exchangeAccountId,
          market,
          "CLOSED_ORDER_ARCHIVE",
        );
        const parsedCheckpointEndTimeMs = checkpoint ? Date.parse(checkpoint.nextWindowEndAt) : NaN;
        const archivalWindowEndTimeMs =
          Number.isFinite(parsedCheckpointEndTimeMs) ? parsedCheckpointEndTimeMs : closedOrderStartTimeMs;
        const archiveAlreadyComplete = archivalWindowEndTimeMs <= stopBeforeTimeMs;
        const archivalWindowStartTimeMs = archiveAlreadyComplete
          ? archivalWindowEndTimeMs
          : Math.max(
              archivalWindowEndTimeMs - closedOrderLookbackDays * MILLISECONDS_PER_DAY,
              stopBeforeTimeMs,
            );
        const [openSnapshots, recentClosedSnapshots, archivalClosedSnapshots] = await Promise.all([
          paginateExchangeOrderHistory({
            maxPages: historyMaxPagesPerMarket,
            fetchPage: (page) =>
              orderHistoryReader.listOpenOrders({
                market,
                page,
                limit: EXCHANGE_HISTORY_PAGE_LIMIT,
                orderBy: "desc",
              }),
          }),
          paginateExchangeOrderHistory({
            maxPages: historyMaxPagesPerMarket,
            fetchPage: (page) =>
              orderHistoryReader.listClosedOrders({
                market,
                page,
                limit: EXCHANGE_HISTORY_PAGE_LIMIT,
                orderBy: "desc",
                startTimeMs: closedOrderStartTimeMs,
                endTimeMs: closedOrderEndTimeMs,
              }),
          }),
          archiveAlreadyComplete
            ? Promise.resolve({ snapshots: [], pagesScanned: 0, pageLimitReached: false })
            : paginateExchangeOrderHistory({
                maxPages: historyMaxPagesPerMarket,
                fetchPage: (page) =>
                  orderHistoryReader.listClosedOrders({
                    market,
                    page,
                    limit: EXCHANGE_HISTORY_PAGE_LIMIT,
                    orderBy: "desc",
                    startTimeMs: archivalWindowStartTimeMs,
                    endTimeMs: archivalWindowEndTimeMs,
                  }),
              }),
        ]);
        const nextWindowEndAt = new Date(archivalWindowStartTimeMs).toISOString();
        const archiveComplete = archivalWindowStartTimeMs <= stopBeforeTimeMs;
        const pageLimitReached =
          openSnapshots.pageLimitReached ||
          recentClosedSnapshots.pageLimitReached ||
          archivalClosedSnapshots.pageLimitReached;
        const retentionStatus: "WITHIN_ASSUMED_RETENTION" | "BEYOND_ASSUMED_RETENTION" =
          archivalWindowStartTimeMs <= retentionBoundaryTimeMs || stopBeforeTimeMs < retentionBoundaryTimeMs
            ? "BEYOND_ASSUMED_RETENTION"
            : "WITHIN_ASSUMED_RETENTION";
        const confidenceLevel: "HIGH" | "PARTIAL" =
          archiveComplete && !pageLimitReached && retentionStatus === "WITHIN_ASSUMED_RETENTION" ? "HIGH" : "PARTIAL";
        const confidenceReason = resolveHistoryRecoveryConfidenceReason({
          archiveComplete,
          pageLimitReached,
          retentionStatus,
        });

        await this.dependencies.repositories.saveHistoryRecoveryCheckpoint({
          id: checkpoint?.id ?? createId("history_recovery_checkpoint"),
          exchangeAccountId,
          market,
          checkpointType: "CLOSED_ORDER_ARCHIVE",
          nextWindowEndAt,
          updatedAt: reconciledAt,
        });

        const snapshots = [
          ...openSnapshots.snapshots,
          ...recentClosedSnapshots.snapshots,
          ...archivalClosedSnapshots.snapshots,
        ];

        return {
          market,
          snapshots,
          recentClosedWindowStartAt,
          recentClosedWindowEndAt,
          archivalWindowStartAt: new Date(archivalWindowStartTimeMs).toISOString(),
          archivalWindowEndAt: new Date(archivalWindowEndTimeMs).toISOString(),
          nextWindowEndAt,
          openPagesScanned: openSnapshots.pagesScanned,
          recentClosedPagesScanned: recentClosedSnapshots.pagesScanned,
          archivalClosedPagesScanned: archivalClosedSnapshots.pagesScanned,
          archiveComplete,
          retentionStatus,
          confidenceLevel,
          confidenceReason,
          openHistoryTruncated: openSnapshots.pageLimitReached,
          recentClosedHistoryTruncated: recentClosedSnapshots.pageLimitReached,
          archivalClosedHistoryTruncated: archivalClosedSnapshots.pageLimitReached,
          snapshotCount: snapshots.length,
        };
      }),
    );

    const deduped = new Map<string, ExchangeOrderSnapshot>();
    for (const snapshot of batches.flatMap((batch) => batch.snapshots)) {
      const key = snapshot.uuid || snapshot.identifier || JSON.stringify(snapshot.raw);
      if (!deduped.has(key)) {
        deduped.set(key, snapshot);
      }
    }

    return {
      snapshots: [...deduped.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      historyRecovery: {
        closedOrderLookbackDays,
        stopBeforeDays: historyStopBeforeDays,
        stopBeforeAt,
        retentionAssumptionDays: historyRetentionAssumptionDays,
        retentionBoundaryAt,
        retentionStatus: summarizeHistoryRetentionStatus(batches),
        coverageStatus: batches.every((batch) => batch.archiveComplete) ? "COMPLETE" : "IN_PROGRESS",
        confidenceLevel: summarizeHistoryRecoveryConfidence(batches),
        confidenceReason: summarizeHistoryRecoveryConfidenceReason(batches),
        failureMessage: null,
        scannedSnapshotCount: deduped.size,
        recoveredOrderCount: 0,
        markets: batches.map((batch) => ({
          market: batch.market,
          recentClosedWindowStartAt: batch.recentClosedWindowStartAt,
          recentClosedWindowEndAt: batch.recentClosedWindowEndAt,
          archivalWindowStartAt: batch.archivalWindowStartAt,
          archivalWindowEndAt: batch.archivalWindowEndAt,
          nextWindowEndAt: batch.nextWindowEndAt,
          archiveComplete: batch.archiveComplete,
          retentionStatus: batch.retentionStatus,
          confidenceLevel: batch.confidenceLevel,
          confidenceReason: batch.confidenceReason,
          openHistoryTruncated: batch.openHistoryTruncated,
          recentClosedHistoryTruncated: batch.recentClosedHistoryTruncated,
          archivalClosedHistoryTruncated: batch.archivalClosedHistoryTruncated,
          openPagesScanned: batch.openPagesScanned,
          recentClosedPagesScanned: batch.recentClosedPagesScanned,
          archivalClosedPagesScanned: batch.archivalClosedPagesScanned,
          snapshotCount: batch.snapshotCount,
        })),
      },
    };
  }

  private async reconcileActiveOrder(
    order: OrderRecord,
    reconciledAt: string,
  ): Promise<ReconciliationSummary["issues"]> {
    if (!this.dependencies.orderReader) {
      return [
        {
          code: order.status === "RECONCILIATION_REQUIRED" ? "ORDER_MARKED_FOR_RECOVERY" : "OPEN_ORDER_NEEDS_REVIEW",
          message:
            order.status === "RECONCILIATION_REQUIRED"
              ? `Order ${order.id} is already marked for recovery.`
              : `Order ${order.id} remains active and exchange order lookup is not wired.`,
        },
      ];
    }

    if (order.status === "RECONCILIATION_REQUIRED" || order.status === "SUBMITTING") {
      const recovery = await this.recoverOrderByIdentifier(order);
      const code = recovery.outcome === "RECOVERED"
        ? "ORDER_IDENTIFIER_RECOVERED"
        : recovery.outcome === "RECOVERED_BUT_PROJECTION_FAILED"
          ? "CANDIDATE_EVIDENCE_PROJECTION_FAILED"
        : recovery.outcome === "ABSENCE_CONFIRMED"
          ? "ORDER_SUBMISSION_ABSENCE_CONFIRMED"
          : "ORDER_IDENTIFIER_RECOVERY_UNCERTAIN";
      return [{ code, message: `Order ${order.id} identifier recovery: ${recovery.detail}` }];
    }

    if (!order.upbitUuid && !order.identifier) {
      return [
        await this.markOrderForRecovery(
          order,
          reconciledAt,
          "Order has no exchange reference for reconciliation.",
          "ORDER_REFERENCE_MISSING",
        ),
      ];
    }

    try {
      const snapshot = await this.dependencies.orderReader.getOrder({
        ...(order.upbitUuid ? { uuid: order.upbitUuid } : {}),
        ...(order.identifier ? { identifier: order.identifier } : {}),
      });

      if (!snapshot) {
        return [await this.markOrderForRecovery(order, reconciledAt, "Exchange order snapshot could not be found.")];
      }

      return this.applyExchangeSnapshot(order, snapshot, reconciledAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown reconciliation query failure.";
      if (isTypedTransientLookupError(error)) {
        await this.dependencies.repositories.appendOrderEvent({
          id: createId("order_event"),
          orderId: order.id,
          eventType: "RECONCILIATION_LOOKUP_TRANSIENT_FAILURE",
          eventSource: "RECONCILIATION",
          payloadJson: JSON.stringify({
            reason: message,
          }),
          createdAt: reconciledAt,
        });
        return [
          {
            code: "ORDER_LOOKUP_TRANSIENT_FAILURE",
            message: `Transient exchange lookup failure for order ${order.id}. ${message}`,
          },
        ];
      }

      return [await this.markOrderForRecovery(order, reconciledAt, `Exchange order lookup failed: ${message}`)];
    }
  }

  private async reconcileTerminalOrder(
    order: OrderRecord,
    reconciledAt: string,
  ): Promise<ReconciliationSummary["issues"]> {
    if (!this.dependencies.orderReader) {
      return [];
    }

    if (isPotentiallyDispatchedRecoveryStatus(order.status)) {
      const recovery = await this.recoverOrderByIdentifier(order);
      const code = recovery.outcome === "RECOVERED"
        ? "ORDER_IDENTIFIER_RECOVERED"
        : recovery.outcome === "RECOVERED_BUT_PROJECTION_FAILED"
          ? "CANDIDATE_EVIDENCE_PROJECTION_FAILED"
          : recovery.outcome === "ABSENCE_CONFIRMED"
            ? "ORDER_SUBMISSION_ABSENCE_CONFIRMED"
            : "ORDER_IDENTIFIER_RECOVERY_UNCERTAIN";
      return [{ code, message: `Terminal order ${order.id} identifier recovery: ${recovery.detail}` }];
    }

    if (!order.upbitUuid && !order.identifier) {
      return [];
    }

    try {
      const snapshot = await this.dependencies.orderReader.getOrder({
        ...(order.upbitUuid ? { uuid: order.upbitUuid } : {}),
        ...(order.identifier ? { identifier: order.identifier } : {}),
      });

      if (!snapshot) {
        return [
          await this.markOrderForRecovery(
            order,
            reconciledAt,
            "Terminal order snapshot could not be found during reconciliation.",
          ),
        ];
      }

      const issues = await this.applyExchangeSnapshot(order, snapshot, reconciledAt);
      issues.unshift({
        code: "TERMINAL_ORDER_RECHECKED",
        message: `Terminal order ${order.id} was rechecked against exchange state ${snapshot.state}.`,
      });
      return issues;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown terminal reconciliation query failure.";
      if (isTypedTransientLookupError(error)) {
        await this.dependencies.repositories.appendOrderEvent({
          id: createId("order_event"),
          orderId: order.id,
          eventType: "RECONCILIATION_LOOKUP_TRANSIENT_FAILURE",
          eventSource: "RECONCILIATION",
          payloadJson: JSON.stringify({
            reason: message,
            orderStatus: order.status,
          }),
          createdAt: reconciledAt,
        });
        return [
          {
            code: "ORDER_LOOKUP_TRANSIENT_FAILURE",
            message: `Transient exchange lookup failure for terminal order ${order.id}. ${message}`,
          },
        ];
      }

      return [
        await this.markOrderForRecovery(
          order,
          reconciledAt,
          `Terminal order lookup failed: ${message}`,
        ),
      ];
    }
  }

  private async applyExchangeSnapshot(
    order: OrderRecord,
    snapshot: ExchangeOrderSnapshot,
    reconciledAt: string,
  ): Promise<ReconciliationSummary["issues"]> {
    const issues: ReconciliationSummary["issues"] = [];
    const existingFills = await this.dependencies.repositories.listFills(order.id);
    const existingFillIds = new Set(existingFills.map((fill) => fill.exchangeFillId));
    const nextStatus = mapExchangeOrderToLifecycleStatus(snapshot);

    const nextOrder: OrderRecord = {
      ...order,
      upbitUuid: snapshot.uuid,
      status: nextStatus,
      exchangeResponseJson: JSON.stringify(snapshot.raw),
      updatedAt: reconciledAt,
    };

    if (
      nextOrder.status !== order.status ||
      nextOrder.upbitUuid !== order.upbitUuid ||
      nextOrder.exchangeResponseJson !== order.exchangeResponseJson
    ) {
      await this.dependencies.repositories.updateOrder(nextOrder);
      await this.dependencies.repositories.appendOrderEvent({
        id: createId("order_event"),
        orderId: order.id,
        eventType: "RECONCILIATION_STATUS_UPDATED",
        eventSource: "RECONCILIATION",
        payloadJson: JSON.stringify({
          previousStatus: order.status,
          nextStatus,
          exchangeState: snapshot.state,
          executedVolume: snapshot.executedVolume,
          remainingVolume: snapshot.remainingVolume,
        }),
        createdAt: reconciledAt,
      });

      if (nextStatus !== order.status) {
        issues.push({
          code: "ORDER_STATUS_RECONCILED",
          message: `Order ${order.id} reconciled from ${order.status} to ${nextStatus} using exchange state ${snapshot.state}.`,
        });
      }
    }

    let newFillCount = 0;
    for (const fillRecord of buildFillRecords(order, snapshot)) {
      if (!existingFillIds.has(fillRecord.exchangeFillId)) {
        newFillCount += 1;
        existingFillIds.add(fillRecord.exchangeFillId);
      }
      await this.dependencies.repositories.saveFill(fillRecord);
    }

    if (newFillCount > 0) {
      issues.push({
        code: "ORDER_FILLS_BACKFILLED",
        message: `Backfilled ${newFillCount} fill(s) for order ${order.id} from exchange snapshot.`,
      });
    }

    if (
      (nextOrder.status === "FILLED" || nextOrder.status === "CANCELED") &&
      this.dependencies.candidateEvidenceService
    ) {
      const projection = await this.dependencies.candidateEvidenceService.processTerminalOrder(order.id);
      if (projection.outcome === "FAULT") {
        issues.push({
          code: "CANDIDATE_EVIDENCE_PROJECTION_FAILED",
          message: `Candidate evidence projection failed for order ${order.id}. ${projection.detail}`,
        });
      }
    }

    return issues;
  }

  private async markOrderForRecovery(
    order: OrderRecord,
    reconciledAt: string,
    message: string,
    issueCode: ReconciliationIssue["code"] = "ORDER_MARKED_FOR_RECOVERY",
  ): Promise<ReconciliationSummary["issues"][number]> {
    const nextOrder: OrderRecord = {
      ...order,
      status: "RECONCILIATION_REQUIRED",
      failureCode: order.failureCode ?? "RECONCILIATION_REQUIRED",
      failureMessage: message,
      updatedAt: reconciledAt,
    };

    await this.dependencies.repositories.updateOrder(nextOrder);
    await this.dependencies.repositories.appendOrderEvent({
      id: createId("order_event"),
      orderId: order.id,
      eventType: "RECONCILIATION_RECOVERY_REQUIRED",
      eventSource: "RECONCILIATION",
      payloadJson: JSON.stringify({
        reason: message,
      }),
      createdAt: reconciledAt,
    });
    await this.dependencies.repositories.saveRiskEvent(createRecoveryRiskEvent(order, message, reconciledAt));

    return {
      code: issueCode,
      message: `Order ${order.id} marked RECONCILIATION_REQUIRED. ${message}`,
    };
  }

  private async persistRecoveredProjectionFailure(
    order: OrderRecord,
    occurredAt: string,
    message: string,
  ): Promise<void> {
    const eventId = `candidate-evidence-recovery-fault:${order.id}`;
    const existingEvent = (await this.dependencies.repositories.listOrderEvents(order.id))
      .find((event) => event.id === eventId);
    const event = existingEvent ?? {
      id: eventId,
      orderId: order.id,
      eventType: "CANDIDATE_EVIDENCE_PROJECTION_FAILED" as const,
      eventSource: "RECONCILIATION" as const,
      payloadJson: JSON.stringify({ code: "RECOVERED_SNAPSHOT_PROJECTION_FAILED", message }),
      createdAt: occurredAt,
    };
    const persistCandidateProjectionFault = this.dependencies.repositories.persistCandidateProjectionFault;
    if (!persistCandidateProjectionFault) {
      throw new Error("Recovered candidate projection failures require atomic fault persistence.");
    }
    await persistCandidateProjectionFault.call(this.dependencies.repositories, {
      orderId: order.id,
      event,
      faultPause: {
        exchangeAccountId: order.exchangeAccountId,
        faultId: eventId,
        reason: `RECOVERED_SNAPSHOT_PROJECTION_FAILED: ${message}`,
        occurredAt: event.createdAt,
      },
    });
  }

  private recoveryObservationRepository(): Required<Pick<ExecutionRepository,
    "saveOrderSubmissionRecoveryObservation" | "listOrderSubmissionRecoveryObservations"
  >> {
    const { saveOrderSubmissionRecoveryObservation, listOrderSubmissionRecoveryObservations } = this.dependencies.repositories;
    if (!saveOrderSubmissionRecoveryObservation || !listOrderSubmissionRecoveryObservations) {
      throw new Error("Order submission recovery observation persistence is unavailable.");
    }
    return {
      saveOrderSubmissionRecoveryObservation: saveOrderSubmissionRecoveryObservation.bind(this.dependencies.repositories),
      listOrderSubmissionRecoveryObservations: listOrderSubmissionRecoveryObservations.bind(this.dependencies.repositories),
    };
  }

  private recoveryClock(): ReconciliationRecoveryClock {
    if (!this.dependencies.recoveryClock) {
      throw new Error("Identifier recovery requires an injected persisted-observation clock.");
    }
    return this.dependencies.recoveryClock;
  }

  private async recordRecoveryObservation(
    order: OrderRecord,
    outcome: "FOUND" | "NOT_FOUND" | "TRANSIENT_FAILURE",
    now: ReturnType<ReconciliationRecoveryClock["now"]>,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const observations = this.recoveryObservationRepository();
    const observationId = createId("order_recovery_observation");
    await observations.saveOrderSubmissionRecoveryObservation({
      id: observationId,
      orderId: order.id,
      outcome,
      observedAt: now.observedAt,
      observedAtEpochMs: now.observedAtEpochMs,
      detailJson: JSON.stringify(detail),
      createdAt: now.observedAt,
    });
    await this.dependencies.repositories.appendOrderEvent({
      id: createId("order_event"),
      orderId: order.id,
      eventType: "RECONCILIATION_IDENTIFIER_RECOVERY_OBSERVED",
      eventSource: "RECONCILIATION",
      payloadJson: JSON.stringify({ outcome, observationId, ...detail }),
      createdAt: now.observedAt,
    });
  }

  private async safeReport(input: {
    exchangeAccountId: string;
    notificationType: "RECONCILIATION_DRIFT_DETECTED";
    severity: "WARN";
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
      // Reporting is best-effort and must not change reconciliation outcomes.
    }
  }
}

function summarizeHistoryRecoveryConfidence(
  batches: Array<{
    confidenceLevel: "HIGH" | "PARTIAL";
  }>,
): NonNullable<ReconciliationSummary["historyRecovery"]>["confidenceLevel"] {
  return batches.every((batch) => batch.confidenceLevel === "HIGH") ? "HIGH" : "PARTIAL";
}

function summarizeHistoryRecoveryConfidenceReason(
  batches: Array<{
    confidenceReason:
      | "ARCHIVE_COMPLETE"
      | "ARCHIVE_IN_PROGRESS"
      | "PAGE_LIMIT_REACHED"
      | "BEYOND_ASSUMED_RETENTION";
  }>,
): NonNullable<ReconciliationSummary["historyRecovery"]>["confidenceReason"] {
  if (batches.some((batch) => batch.confidenceReason === "PAGE_LIMIT_REACHED")) {
    return "PAGE_LIMIT_REACHED";
  }

  if (batches.some((batch) => batch.confidenceReason === "BEYOND_ASSUMED_RETENTION")) {
    return "BEYOND_ASSUMED_RETENTION";
  }

  if (batches.some((batch) => batch.confidenceReason === "ARCHIVE_IN_PROGRESS")) {
    return "ARCHIVE_IN_PROGRESS";
  }

  return "ARCHIVE_COMPLETE";
}

function summarizeHistoryRetentionStatus(
  batches: Array<{
    retentionStatus: "WITHIN_ASSUMED_RETENTION" | "BEYOND_ASSUMED_RETENTION";
  }>,
): NonNullable<ReconciliationSummary["historyRecovery"]>["retentionStatus"] {
  return batches.some((batch) => batch.retentionStatus === "BEYOND_ASSUMED_RETENTION")
    ? "BEYOND_ASSUMED_RETENTION"
    : "WITHIN_ASSUMED_RETENTION";
}

function resolveHistoryRecoveryConfidenceReason(input: {
  archiveComplete: boolean;
  pageLimitReached: boolean;
  retentionStatus: "WITHIN_ASSUMED_RETENTION" | "BEYOND_ASSUMED_RETENTION";
}): NonNullable<ReconciliationSummary["historyRecovery"]>["markets"][number]["confidenceReason"] {
  if (input.pageLimitReached) {
    return "PAGE_LIMIT_REACHED";
  }

  if (input.retentionStatus === "BEYOND_ASSUMED_RETENTION") {
    return "BEYOND_ASSUMED_RETENTION";
  }

  return input.archiveComplete ? "ARCHIVE_COMPLETE" : "ARCHIVE_IN_PROGRESS";
}

function buildFailedHistoryRecoverySummary(input: {
  reconciledAt: string;
  closedOrderLookbackDays: number | undefined;
  historyStopBeforeDays: number | undefined;
  historyRetentionAssumptionDays: number | undefined;
  failureMessage: string;
}): NonNullable<ReconciliationSummary["historyRecovery"]> {
  const closedOrderLookbackDays = Math.max(
    1,
    Math.trunc(input.closedOrderLookbackDays ?? DEFAULT_CLOSED_ORDER_LOOKBACK_DAYS),
  );
  const historyStopBeforeDays = Math.max(
    closedOrderLookbackDays,
    Math.trunc(input.historyStopBeforeDays ?? DEFAULT_HISTORY_STOP_BEFORE_DAYS),
  );
  const historyRetentionAssumptionDays = Math.max(
    closedOrderLookbackDays,
    Math.trunc(input.historyRetentionAssumptionDays ?? DEFAULT_HISTORY_RETENTION_ASSUMPTION_DAYS),
  );
  const parsedReconciledAt = Date.parse(input.reconciledAt);
  const closedOrderEndTimeMs = Number.isFinite(parsedReconciledAt) ? parsedReconciledAt : Date.now();
  const retentionBoundaryTimeMs =
    closedOrderEndTimeMs - historyRetentionAssumptionDays * MILLISECONDS_PER_DAY;

  return {
    closedOrderLookbackDays,
    stopBeforeDays: historyStopBeforeDays,
    stopBeforeAt: new Date(closedOrderEndTimeMs - historyStopBeforeDays * MILLISECONDS_PER_DAY).toISOString(),
    retentionAssumptionDays: historyRetentionAssumptionDays,
    retentionBoundaryAt: new Date(retentionBoundaryTimeMs).toISOString(),
    retentionStatus:
      closedOrderEndTimeMs - historyStopBeforeDays * MILLISECONDS_PER_DAY < retentionBoundaryTimeMs
        ? "BEYOND_ASSUMED_RETENTION"
        : "WITHIN_ASSUMED_RETENTION",
    coverageStatus: "IN_PROGRESS",
    confidenceLevel: "FAILED",
    confidenceReason: "LOOKUP_FAILED",
    failureMessage: input.failureMessage,
    scannedSnapshotCount: 0,
    recoveredOrderCount: 0,
    markets: [],
  };
}

async function paginateExchangeOrderHistory(input: {
  maxPages: number;
  fetchPage: (page: number) => Promise<ExchangeOrderSnapshot[]>;
}): Promise<{ snapshots: ExchangeOrderSnapshot[]; pagesScanned: number; pageLimitReached: boolean }> {
  const snapshots: ExchangeOrderSnapshot[] = [];
  let pagesScanned = 0;
  let pageLimitReached = false;

  for (let page = 1; page <= input.maxPages; page += 1) {
    const pageSnapshots = await input.fetchPage(page);
    pagesScanned += 1;
    if (pageSnapshots.length === 0) {
      break;
    }

    snapshots.push(...pageSnapshots);
    if (pageSnapshots.length < EXCHANGE_HISTORY_PAGE_LIMIT) {
      break;
    }

    pageLimitReached = page === input.maxPages;
  }

  return {
    snapshots,
    pagesScanned,
    pageLimitReached,
  };
}

function buildRecoveredOrderRecord(input: {
  exchangeAccountId: string;
  executionMode: ExecutionMode;
  snapshot: ExchangeOrderSnapshot;
  recoveredAt: string;
}): OrderRecord {
  const identifier = input.snapshot.identifier ?? `exchange_recovery:${input.snapshot.uuid}`;

  return {
    id: createId("order"),
    strategyDecisionId: null,
    exchangeAccountId: input.exchangeAccountId,
    market: input.snapshot.market,
    side: input.snapshot.side,
    ordType: input.snapshot.ordType,
    volume: input.snapshot.volume,
    price: input.snapshot.price,
    timeInForce: null,
    smpType: null,
    identifier,
    idempotencyKey: createFingerprint(
      `exchange_recovery:${input.exchangeAccountId}:${input.snapshot.uuid}:${identifier}`,
    ),
    origin: "RECOVERY",
    requestedAt: input.snapshot.createdAt,
    upbitUuid: input.snapshot.uuid,
    status: mapExchangeOrderToLifecycleStatus(input.snapshot),
    executionMode: input.executionMode,
    exchangeResponseJson: JSON.stringify(input.snapshot.raw),
    failureCode: null,
    failureMessage: null,
    createdAt: input.snapshot.createdAt,
    updatedAt: input.recoveredAt,
  };
}

function mapExchangeOrderToLifecycleStatus(snapshot: ExchangeOrderSnapshot): OrderRecord["status"] {
  if (snapshot.state === "done") {
    return "FILLED";
  }

  if (snapshot.state === "cancel") {
    if (snapshot.side === "bid" && snapshot.ordType === "price" && hasExecutedVolume(snapshot.executedVolume)) {
      return "FILLED";
    }

    return "CANCELED";
  }

  if (hasExecutedVolume(snapshot.executedVolume)) {
    return "PARTIALLY_FILLED";
  }

  return "OPEN";
}

function hasExecutedVolume(executedVolume: string | null): boolean {
  return Boolean(executedVolume && Number(executedVolume) > 0);
}

function shouldReconcileTerminalOrder(order: OrderRecord, fillCount: number): boolean {
  switch (order.status) {
    case "FILLED":
      return fillCount === 0 || order.exchangeResponseJson === null;
    case "CANCELED":
      return order.exchangeResponseJson === null || isFilledPriceBidDustCancelCandidate(order, fillCount);
    case "REJECTED":
    case "FAILED":
      return order.exchangeResponseJson === null && order.failureCode !== "TERMINAL_ORDER_CONFIRMED_ABSENT";
    default:
      return false;
  }
}

function isSubmissionAbsenceConfirmed(order: OrderRecord): boolean {
  return order.status === "FAILED" && order.failureCode === "ORDER_SUBMISSION_ABSENCE_CONFIRMED";
}

function isFilledPriceBidDustCancelCandidate(order: OrderRecord, fillCount: number): boolean {
  if (order.side !== "bid" || order.ordType !== "price") {
    return false;
  }

  if (fillCount > 0) {
    return true;
  }

  const parsed = parseJsonObject(order.exchangeResponseJson);
  if (!parsed || parsed.state !== "cancel") {
    return false;
  }

  return hasExecutedVolume(getStringField(parsed, "executed_volume", "executedVolume"));
}

function getStringField(value: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return null;
}

function isLocalDryRunExchangeArtifact(order: OrderRecord): boolean {
  if (order.upbitUuid?.startsWith("dryrun_")) {
    return true;
  }

  const parsed = parseJsonObject(order.exchangeResponseJson);
  return parsed?.mode === "DRY_RUN";
}

function resolveDryRunRepairVolume(order: OrderRecord, price: string | null): string | null {
  if (isPositiveNumericString(order.volume)) {
    return order.volume;
  }

  if (order.side === "bid" && isPositiveNumericString(order.price) && isPositiveNumericString(price)) {
    const notional = Number(order.price);
    const referencePrice = Number(price);
    const derivedVolume = notional / referencePrice;
    return Number.isFinite(derivedVolume) && derivedVolume > 0 ? derivedVolume.toFixed(8) : null;
  }

  return null;
}

function parsePositions(snapshot: PositionSnapshotRecord | null): PositionSnapshot[] {
  if (!snapshot) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(snapshot.positionsJson);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isPositionSnapshot);
  } catch {
    return [];
  }
}

function isPositionSnapshot(value: unknown): value is PositionSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<PositionSnapshot>;
  return (
    (candidate.asset === "BTC" || candidate.asset === "ETH") &&
    (candidate.market === "KRW-BTC" || candidate.market === "KRW-ETH") &&
    typeof candidate.quantity === "string" &&
    typeof candidate.capturedAt === "string"
  );
}

function isPositiveNumericString(value: string | null | undefined): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function buildReconciliationCandidates(
  activeOrders: OrderRecord[],
  terminalOrders: OrderRecord[],
): Array<
  | { kind: "active"; order: OrderRecord; priority: number }
  | { kind: "terminal"; order: OrderRecord; priority: number }
> {
  const activeCandidates = activeOrders.map((order) => ({
    kind: "active" as const,
    order,
    priority: getActiveOrderPriority(order.status),
  }));
  const terminalCandidates = terminalOrders.map((order) => ({
    kind: "terminal" as const,
    order,
    priority: getTerminalOrderPriority(order.status),
  }));

  return [...activeCandidates, ...terminalCandidates].sort((left, right) => {
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }

    return left.order.updatedAt.localeCompare(right.order.updatedAt);
  });
}

function getActiveOrderPriority(status: OrderLifecycleStatus): number {
  switch (status) {
    case "RECONCILIATION_REQUIRED":
      return 0;
    case "CANCEL_REQUESTED":
      return 1;
    case "PARTIALLY_FILLED":
      return 2;
    case "OPEN":
      return 3;
    case "PERSISTED":
      return 4;
    case "SUBMITTING":
      return 5;
    case "INTENT_CREATED":
      return 6;
    default:
      return 7;
  }
}

function getTerminalOrderPriority(status: OrderLifecycleStatus): number {
  switch (status) {
    case "FAILED":
      return 7;
    case "REJECTED":
      return 8;
    case "FILLED":
      return 9;
    case "CANCELED":
      return 10;
    default:
      return 11;
  }
}

function isTypedTransientLookupError(error: unknown): error is ExchangeOrderLookupError {
  return error instanceof ExchangeOrderLookupError && error.kind === "TRANSIENT";
}

function validateIdentifierRecoveryPolicy(policy: IdentifierRecoveryPolicy): IdentifierRecoveryPolicy {
  if (!Number.isSafeInteger(policy.minimumNotFoundObservations) || policy.minimumNotFoundObservations < 2) {
    throw new Error("Identifier recovery requires at least two persisted not-found observations.");
  }
  if (!Number.isSafeInteger(policy.minimumElapsedMs) || policy.minimumElapsedMs <= 0) {
    throw new Error("Identifier recovery requires a positive persisted elapsed-time bound.");
  }

  return policy;
}

function validateRecoveryObservationTime(value: ReturnType<ReconciliationRecoveryClock["now"]>): void {
  if (!Number.isSafeInteger(value.observedAtEpochMs) || value.observedAtEpochMs < 0) {
    throw new Error("Recovery observation time must include a non-negative integer epoch timestamp.");
  }
  const parsedObservedAt = Date.parse(value.observedAt);
  if (!Number.isFinite(parsedObservedAt)) {
    throw new Error("Recovery observation time must include a valid persisted timestamp.");
  }
  if (parsedObservedAt !== value.observedAtEpochMs) {
    throw new Error("Recovery observation ISO timestamp and epoch timestamp must identify the same instant.");
  }
}

function buildFillRecords(
  order: OrderRecord,
  snapshot: ExchangeOrderSnapshot,
): FillRecord[] {
  return snapshot.fills.map((fill) => buildFillRecord(order, fill, snapshot.paidFee));
}

function buildFillRecord(
  order: OrderRecord,
  fill: ExchangeFillSnapshot,
  orderPaidFee: string | null,
): FillRecord {
  const executionEpochNs = fill.createdAt === null ? null : tryParseEpochNanoseconds(fill.createdAt);
  return {
    id: createId("fill"),
    orderId: order.id,
    exchangeFillId: resolveExchangeFillId(order, fill),
    market: order.market,
    side: fill.side,
    price: fill.price,
    volume: fill.volume,
    feeCurrency: "KRW",
    feeAmount: fill.fee,
    feeProvenance: fill.fee !== null
      ? "EXCHANGE_FILL_CONFIRMED"
      : orderPaidFee !== null
        ? "ORDER_LEVEL_UNALLOCATED"
        : "MISSING",
    executionTimestampProvenance: fill.createdAt === null
      ? "LEGACY_UNVERIFIED"
      : "EXCHANGE_FILL_CONFIRMED",
    executionEpochNs,
    // Empty is a persisted absence marker, never a reconciliation-time substitution.
    filledAt: fill.createdAt ?? "",
    rawPayloadJson: JSON.stringify(fill.raw),
  };
}

function tryParseEpochNanoseconds(timestamp: string): string | null {
  try {
    return parseCandidateEvidenceTimestamp(timestamp, "exchange fill createdAt").toString();
  } catch {
    return null;
  }
}

function resolveExchangeFillId(order: OrderRecord, fill: ExchangeFillSnapshot): string {
  if (fill.tradeUuid) {
    return fill.tradeUuid;
  }

  return [
    "reconciliation_fill",
    order.id,
    fill.side,
    fill.price,
    fill.volume,
    fill.createdAt ?? "unknown_created_at",
  ].join(":");
}

function createRecoveryRiskEvent(
  order: OrderRecord,
  message: string,
  createdAt: string,
): RiskEventRecord {
  return {
    id: createId("risk_event"),
    exchangeAccountId: order.exchangeAccountId,
    strategyDecisionId: order.strategyDecisionId,
    orderId: order.id,
    level: "WARN",
    ruleCode: "ORDER_RECOVERY_REQUIRED",
    message,
    payloadJson: JSON.stringify({
      orderId: order.id,
      market: order.market,
      identifier: order.identifier,
      upbitUuid: order.upbitUuid,
    }),
    createdAt,
  };
}
