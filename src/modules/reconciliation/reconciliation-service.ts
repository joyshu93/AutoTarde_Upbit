import type {
  BalanceSnapshotRecord,
  OrderLifecycleStatus,
  OrderRecord,
  PositionSnapshotRecord,
  RiskEventRecord,
} from "../../domain/types.js";
import { createId } from "../../shared/ids.js";
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

export class ReconciliationService {
  constructor(
    private readonly dependencies: {
      repositories: ExecutionRepository;
      operatorState: OperatorStateStore;
      orderReader?: Pick<ExchangeAdapter, "getOrder">;
      reporter?: OperatorNotificationReporter;
      maxOrderLookupsPerRun?: number;
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
    const openOrders = await this.dependencies.repositories.listActiveOrders(exchangeAccountId);
    const terminalOrders = await this.listTerminalOrdersNeedingBackfill(exchangeAccountId);
    const candidates = buildReconciliationCandidates(openOrders, terminalOrders);
    const maxOrderLookupsPerRun = this.dependencies.maxOrderLookupsPerRun ?? 10;
    const startedAt = new Date().toISOString();
    const issues: ReconciliationIssue[] = [];
    let processedCount = 0;

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

  private async listTerminalOrdersNeedingBackfill(exchangeAccountId: string): Promise<OrderRecord[]> {
    const orders = await this.dependencies.repositories.listOrders(exchangeAccountId);
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
