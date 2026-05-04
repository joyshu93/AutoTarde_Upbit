import type {
  BalanceSnapshotRecord,
  ExecutionMode,
  OrderLifecycleStatus,
  OrderRecord,
  PositionSnapshotRecord,
  RiskEventRecord,
} from "../../domain/types.js";
import { SUPPORTED_MARKETS } from "../../domain/types.js";
import { createFingerprint, createId } from "../../shared/ids.js";
import type { ExecutionRepository, OperatorStateStore } from "../db/interfaces.js";
import type { ExchangeAdapter, ExchangeOrderSnapshot, ExchangeFillSnapshot } from "../exchange/interfaces.js";
import type { OperatorNotificationReporter } from "../telegram/reporter.js";
import type { ReconciliationIssue, ReconciliationSummary, ReconciliationTrigger } from "./interfaces.js";
import { detectPortfolioDrift } from "./portfolio-drift.js";

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
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface ExchangeHistoryRecoveryResult {
  snapshots: ExchangeOrderSnapshot[];
  historyRecovery: NonNullable<ReconciliationSummary["historyRecovery"]> | null;
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
    },
  ) {}

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
    const terminalOrders = await this.listTerminalOrdersNeedingBackfill(allOrders);
    const candidates = buildReconciliationCandidates(openOrders, terminalOrders);
    const issues: ReconciliationIssue[] = [];
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
    const parsedReconciledAt = Date.parse(reconciledAt);
    const closedOrderEndTimeMs = Number.isFinite(parsedReconciledAt) ? parsedReconciledAt : Date.now();
    const closedOrderStartTimeMs =
      closedOrderEndTimeMs - closedOrderLookbackDays * MILLISECONDS_PER_DAY;
    const stopBeforeTimeMs = closedOrderEndTimeMs - historyStopBeforeDays * MILLISECONDS_PER_DAY;
    const stopBeforeAt = new Date(stopBeforeTimeMs).toISOString();
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
        const confidenceLevel: "HIGH" | "PARTIAL" = archiveComplete && !pageLimitReached ? "HIGH" : "PARTIAL";
        const confidenceReason: "ARCHIVE_COMPLETE" | "ARCHIVE_IN_PROGRESS" | "PAGE_LIMIT_REACHED" = pageLimitReached
          ? "PAGE_LIMIT_REACHED"
          : archiveComplete
            ? "ARCHIVE_COMPLETE"
            : "ARCHIVE_IN_PROGRESS";

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
      if (isTransientLookupError(message)) {
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

    if (!order.upbitUuid && !order.identifier) {
      return [];
    }

    try {
      const snapshot = await this.dependencies.orderReader.getOrder({
        ...(order.upbitUuid ? { uuid: order.upbitUuid } : {}),
        ...(order.identifier ? { identifier: order.identifier } : {}),
      });

      if (!snapshot) {
        if (order.status === "FAILED" || order.status === "REJECTED") {
          await this.dependencies.repositories.updateOrder({
            ...order,
            failureCode: "TERMINAL_ORDER_CONFIRMED_ABSENT",
            failureMessage: "Exchange confirmed that no terminal order exists for the stored reference.",
            updatedAt: reconciledAt,
          });
          await this.dependencies.repositories.appendOrderEvent({
            id: createId("order_event"),
            orderId: order.id,
            eventType: "RECONCILIATION_TERMINAL_ABSENCE_CONFIRMED",
            eventSource: "RECONCILIATION",
            payloadJson: JSON.stringify({
              orderStatus: order.status,
              reason: "exchange_snapshot_absent",
            }),
            createdAt: reconciledAt,
          });
          return [
            {
              code: "TERMINAL_ORDER_CONFIRMED_ABSENT",
              message: `Terminal order ${order.id} was confirmed absent on exchange during reconciliation.`,
            },
          ];
        }

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
      if (isTransientLookupError(message)) {
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
    for (const fill of snapshot.fills) {
      const fillRecord = buildFillRecord(order, fill, reconciledAt);
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
    confidenceReason: "ARCHIVE_COMPLETE" | "ARCHIVE_IN_PROGRESS" | "PAGE_LIMIT_REACHED";
  }>,
): NonNullable<ReconciliationSummary["historyRecovery"]>["confidenceReason"] {
  if (batches.some((batch) => batch.confidenceReason === "PAGE_LIMIT_REACHED")) {
    return "PAGE_LIMIT_REACHED";
  }

  if (batches.some((batch) => batch.confidenceReason === "ARCHIVE_IN_PROGRESS")) {
    return "ARCHIVE_IN_PROGRESS";
  }

  return "ARCHIVE_COMPLETE";
}

function buildFailedHistoryRecoverySummary(input: {
  reconciledAt: string;
  closedOrderLookbackDays: number | undefined;
  historyStopBeforeDays: number | undefined;
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
  const parsedReconciledAt = Date.parse(input.reconciledAt);
  const closedOrderEndTimeMs = Number.isFinite(parsedReconciledAt) ? parsedReconciledAt : Date.now();

  return {
    closedOrderLookbackDays,
    stopBeforeDays: historyStopBeforeDays,
    stopBeforeAt: new Date(closedOrderEndTimeMs - historyStopBeforeDays * MILLISECONDS_PER_DAY).toISOString(),
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
    return "CANCELED";
  }

  if (snapshot.executedVolume && Number(snapshot.executedVolume) > 0) {
    return "PARTIALLY_FILLED";
  }

  return "OPEN";
}

function shouldReconcileTerminalOrder(order: OrderRecord, fillCount: number): boolean {
  switch (order.status) {
    case "FILLED":
      return fillCount === 0 || order.exchangeResponseJson === null;
    case "CANCELED":
      return order.exchangeResponseJson === null;
    case "REJECTED":
    case "FAILED":
      return order.exchangeResponseJson === null && order.failureCode !== "TERMINAL_ORDER_CONFIRMED_ABSENT";
    default:
      return false;
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

function isTransientLookupError(message: string): boolean {
  return /429|too many requests|timeout|temporar|network|unavailable|503|502|504|connection|econnreset|fetch failed/iu.test(
    message,
  );
}

function buildFillRecord(
  order: OrderRecord,
  fill: ExchangeFillSnapshot,
  reconciledAt: string,
) {
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
    filledAt: fill.createdAt ?? reconciledAt,
    rawPayloadJson: JSON.stringify(fill.raw),
  };
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
