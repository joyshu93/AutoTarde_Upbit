import type {
  BalanceSnapshotRecord,
  ExecutionStateSeed,
  ExchangeBalance,
  ExecutionStateRecord,
  ExecutionStateTransitionRecord,
  OperatorNotificationDeliveryAttemptRecord,
  OperatorNotificationRecord,
  OrderRecord,
  PositionSnapshot,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
  RiskEventRecord,
} from "../../domain/types.js";
import { detectExecutionStateSeedMismatches } from "../db/interfaces.js";
import type { SupportedTelegramCommand, TelegramSyncResult } from "./interfaces.js";

const MANUAL_INPUT_NOTE = "Telegram does not accept manual cash or position input.";

export function formatStatusMessage(
  state: ExecutionStateRecord,
  options?: {
    executionStateSeed?: ExecutionStateSeed;
    liveSendPath?: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
    transitions?: ExecutionStateTransitionRecord[];
    latestReconciliationRun?: ReconciliationRunRecord | null;
  },
): string {
  const liveSendPath = options?.liveSendPath ?? "DRY_RUN_ADAPTER";
  const blockers = describeLiveOrderBlockers(state, liveSendPath);
  const seedMismatches = options?.executionStateSeed
    ? detectExecutionStateSeedMismatches(state, options.executionStateSeed)
    : [];
  const transitions = options?.transitions ?? [];
  const latestReconciliationRun = options?.latestReconciliationRun ?? null;

  return [
    "Execution Status",
    `exchange_account_id: ${state.exchangeAccountId}`,
    "state_source: persisted execution_state",
    `mode: ${state.executionMode}`,
    `live_gate: ${state.liveExecutionGate}`,
    `system_status: ${state.systemStatus}`,
    `kill_switch: ${state.killSwitchActive ? "on" : "off"}`,
    `pause_reason: ${state.pauseReason ?? "none"}`,
    `degraded_reason: ${state.degradedReason ?? "none"}`,
    `degraded_since: ${state.degradedAt ?? "none"}`,
    `live_send_path: ${liveSendPath}`,
    `live_orders_allowed: ${blockers.length === 0 ? "true" : "false"}`,
    `blocked_by: ${blockers.length === 0 ? "none" : blockers.join(",")}`,
    `seed_mismatches: ${seedMismatches.length === 0 ? "none" : seedMismatches.join(",")}`,
    ...formatLatestReconciliationLines(latestReconciliationRun),
    ...formatTransitionLines(transitions),
    `updated_at: ${state.updatedAt}`,
  ].join("\n");
}

export function formatBalanceMessage(snapshot: BalanceSnapshotRecord | null): string {
  if (!snapshot) {
    return [
      "Balances Snapshot",
      "status: unavailable",
      "note: No exchange balance snapshot is stored yet.",
      `operator_boundary: ${MANUAL_INPUT_NOTE}`,
    ].join("\n");
  }

  const balances = tryParseJson<ExchangeBalance[]>(snapshot.balancesJson);

  return [
    "Balances Snapshot",
    `captured_at: ${snapshot.capturedAt}`,
    `source: ${snapshot.source}`,
    `total_krw_value: ${snapshot.totalKrwValue ?? "unknown"}`,
    ...formatBalanceLines(balances, snapshot.balancesJson),
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

export function formatStateHistoryMessage(
  transitions: ExecutionStateTransitionRecord[],
): string {
  if (transitions.length === 0) {
    return [
      "Execution State History",
      "count: 0",
      "state_source: persisted execution_state_transitions",
      "note: No execution-state transitions are stored yet.",
    ].join("\n");
  }

  return [
    "Execution State History",
    `count: ${transitions.length}`,
    "state_source: persisted execution_state_transitions",
    ...transitions.map(
      (transition) =>
        `- ${transition.createdAt} | ${transition.command} | ${transition.fromSystemStatus ?? "none"} -> ${transition.toSystemStatus} | mode ${transition.fromExecutionMode ?? "none"} -> ${transition.toExecutionMode} | gate ${transition.fromLiveExecutionGate ?? "none"} -> ${transition.toLiveExecutionGate} | reason=${transition.reason ?? "none"}`,
    ),
  ].join("\n");
}

export function formatReconciliationRunsMessage(
  runs: ReconciliationRunRecord[],
): string {
  if (runs.length === 0) {
    return [
      "Reconciliation History",
      "count: 0",
      "state_source: persisted reconciliation_runs",
      "note: No reconciliation runs are stored yet.",
    ].join("\n");
  }

  const sortedRuns = [...runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt));

  return [
    "Reconciliation History",
    `count: ${sortedRuns.length}`,
    "state_source: persisted reconciliation_runs",
    ...sortedRuns.map((run) => {
      const summaryMeta = tryParseReconciliationSummaryMeta(run.summaryJson);
      return `- ${run.startedAt} | ${run.status} | source=${summaryMeta.source ?? "unknown"} | issues=${summaryMeta.issueCount ?? "unknown"} | codes=${summaryMeta.issueCodes.length === 0 ? "none" : summaryMeta.issueCodes.join(",")} | processed=${summaryMeta.processedCount ?? "unknown"} | deferred=${summaryMeta.deferredCount ?? "unknown"} | history=${formatHistoryRecoveryInline(summaryMeta.historyRecovery)} | completed_at=${run.completedAt ?? "none"} | error=${run.errorMessage ?? "none"}`;
    }),
  ].join("\n");
}

export function formatOperatorNotificationsMessage(
  notifications: OperatorNotificationRecord[],
  attempts: OperatorNotificationDeliveryAttemptRecord[] = [],
): string {
  const metrics = summarizeNotificationDeliveryMetrics(notifications, attempts);

  if (notifications.length === 0) {
    return [
      "Operator Alerts",
      "count: 0",
      "state_source: persisted operator_notifications",
      "attempt_source: persisted operator_notification_delivery_attempts",
      "note: No operator notifications are stored yet.",
      `pending_due_count: ${metrics.pendingDueCount}`,
      `pending_scheduled_count: ${metrics.pendingScheduledCount}`,
      `active_lease_count: ${metrics.activeLeaseCount}`,
      `recent_stale_lease_count: ${metrics.recentStaleLeaseCount}`,
      `delivery_attempt_count: ${attempts.length}`,
      ...formatOperatorNotificationAttemptLines(attempts),
    ].join("\n");
  }

  const sortedNotifications = [...notifications].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return [
    "Operator Alerts",
    `count: ${sortedNotifications.length}`,
    "state_source: persisted operator_notifications",
    "attempt_source: persisted operator_notification_delivery_attempts",
    `pending_due_count: ${metrics.pendingDueCount}`,
    `pending_scheduled_count: ${metrics.pendingScheduledCount}`,
    `active_lease_count: ${metrics.activeLeaseCount}`,
    `recent_stale_lease_count: ${metrics.recentStaleLeaseCount}`,
    ...sortedNotifications.map(
      (notification) =>
        `- ${notification.createdAt} | ${notification.severity} | ${notification.notificationType} | ${notification.deliveryStatus} | attempts=${notification.attemptCount} | last_attempt_at=${notification.lastAttemptAt ?? "none"} | next_attempt_at=${notification.nextAttemptAt ?? "none"} | failure_class=${notification.failureClass ?? "none"} | delivered_at=${notification.deliveredAt ?? "none"} | error=${notification.lastError ?? "none"} | ${notification.title} | ${notification.message}`,
    ),
    `delivery_attempt_count: ${attempts.length}`,
    ...formatOperatorNotificationAttemptLines(attempts),
  ].join("\n");
}

export function formatPositionMessage(snapshot: PositionSnapshotRecord | null): string {
  if (!snapshot) {
    return [
      "Positions Snapshot",
      "status: unavailable",
      "note: No exchange position snapshot is stored yet.",
      `operator_boundary: ${MANUAL_INPUT_NOTE}`,
    ].join("\n");
  }

  const positions = tryParseJson<PositionSnapshot[]>(snapshot.positionsJson);

  return [
    "Positions Snapshot",
    `captured_at: ${snapshot.capturedAt}`,
    `source: ${snapshot.source}`,
    ...formatPositionLines(positions, snapshot.positionsJson),
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

export function formatOrdersMessage(orders: OrderRecord[]): string {
  if (orders.length === 0) {
    return [
      "Orders",
      "count: 0",
      "note: No orders are stored yet.",
    ].join("\n");
  }

  const sortedOrders = [...orders].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  return [
    "Orders",
    `count: ${sortedOrders.length}`,
    ...sortedOrders.map(
      (order) =>
        `- ${order.updatedAt} | ${order.market} | ${order.side} | ${order.status} | mode=${order.executionMode} | price=${order.price ?? "market"} | volume=${order.volume ?? "notional"} | id=${order.identifier}`,
    ),
  ].join("\n");
}

export function formatRiskEventsMessage(events: RiskEventRecord[]): string {
  if (events.length === 0) {
    return [
      "Risk Events",
      "count: 0",
      "state_source: persisted risk_events",
      "note: No risk events are stored yet.",
    ].join("\n");
  }

  const sortedEvents = [...events].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return [
    "Risk Events",
    `count: ${sortedEvents.length}`,
    "state_source: persisted risk_events",
    ...sortedEvents.map(
      (event) => `- ${event.createdAt} | ${event.level} | ${event.ruleCode} | ${event.message}`,
    ),
  ].join("\n");
}

export function formatControlCommandMessage(
  command: SupportedTelegramCommand,
  previousState: ExecutionStateRecord,
  nextState: ExecutionStateRecord,
  options?: {
    liveSendPath?: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  },
): string {
  const blockers = describeLiveOrderBlockers(nextState, options?.liveSendPath ?? "DRY_RUN_ADAPTER");

  return [
    "Execution Control",
    `command: ${command}`,
    `result: accepted`,
    `transition: ${previousState.systemStatus} -> ${nextState.systemStatus}`,
    `mode_transition: ${previousState.executionMode} -> ${nextState.executionMode}`,
    `live_gate_transition: ${previousState.liveExecutionGate} -> ${nextState.liveExecutionGate}`,
    `system_status: ${nextState.systemStatus}`,
    `kill_switch: ${nextState.killSwitchActive ? "on" : "off"}`,
    `pause_reason: ${nextState.pauseReason ?? "none"}`,
    `live_orders_allowed: ${blockers.length === 0 ? "true" : "false"}`,
    `blocked_by: ${blockers.length === 0 ? "none" : blockers.join(",")}`,
    `updated_at: ${nextState.updatedAt}`,
  ].join("\n");
}

export function formatSyncMessage(result: TelegramSyncResult): string {
  return [
    "Reconciliation Sync",
    `status: ${result.status}`,
    `requested_at: ${result.requestedAt}`,
    `detail: ${result.detail}`,
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

function formatBalanceLines(
  balances: ExchangeBalance[] | null,
  rawJson: string,
): string[] {
  if (!balances || balances.length === 0) {
    return [`balances_json: ${rawJson}`];
  }

  return [
    "balances:",
    ...balances.map(
      (balance) =>
        `- ${balance.currency} free=${balance.balance} locked=${balance.locked} avg_buy_price=${balance.avgBuyPrice} ${balance.unitCurrency}`,
    ),
  ];
}

function formatPositionLines(
  positions: PositionSnapshot[] | null,
  rawJson: string,
): string[] {
  if (!positions || positions.length === 0) {
    return [`positions_json: ${rawJson}`];
  }

  return [
    "positions:",
    ...positions.map(
      (position) =>
        `- ${position.market} qty=${position.quantity} avg=${position.averageEntryPrice ?? "unknown"} mark=${position.markPrice ?? "unknown"} value=${position.marketValue ?? "unknown"} exposure=${position.exposureRatio ?? "unknown"}`,
    ),
  ];
}

function formatOperatorNotificationAttemptLines(
  attempts: OperatorNotificationDeliveryAttemptRecord[],
): string[] {
  if (attempts.length === 0) {
    return ["recent_delivery_attempts: none"];
  }

  const sortedAttempts = [...attempts].sort((left, right) => right.attemptedAt.localeCompare(left.attemptedAt));
  return [
    "recent_delivery_attempts:",
    ...sortedAttempts.map(
      (attempt) =>
        `- ${attempt.attemptedAt} | notification_id=${attempt.notificationId} | attempt=${attempt.attemptCount} | outcome=${attempt.outcome} | failure_class=${attempt.failureClass ?? "none"} | next_attempt_at=${attempt.nextAttemptAt ?? "none"} | delivered_at=${attempt.deliveredAt ?? "none"} | error=${attempt.errorMessage ?? "none"}`,
    ),
  ];
}

function summarizeNotificationDeliveryMetrics(
  notifications: OperatorNotificationRecord[],
  attempts: OperatorNotificationDeliveryAttemptRecord[],
): {
  pendingDueCount: number;
  pendingScheduledCount: number;
  activeLeaseCount: number;
  recentStaleLeaseCount: number;
} {
  let pendingDueCount = 0;
  let pendingScheduledCount = 0;
  let activeLeaseCount = 0;

  for (const notification of notifications) {
    if (notification.deliveryStatus !== "PENDING") {
      continue;
    }

    const leaseActive =
      notification.leaseToken !== null &&
      notification.leaseExpiresAt !== null &&
      notification.lastAttemptAt !== null;

    if (leaseActive) {
      activeLeaseCount += 1;
      continue;
    }

    if (notification.nextAttemptAt === null) {
      pendingDueCount += 1;
      continue;
    }

    pendingScheduledCount += 1;
  }

  const recentStaleLeaseCount = attempts.filter((attempt) => attempt.outcome === "STALE_LEASE").length;

  return {
    pendingDueCount,
    pendingScheduledCount,
    activeLeaseCount,
    recentStaleLeaseCount,
  };
}

function tryParseJson<T>(rawJson: string): T | null {
  try {
    return JSON.parse(rawJson) as T;
  } catch {
    return null;
  }
}

function tryParseReconciliationIssueCount(rawJson: string): number | null {
  const parsed = tryParseJson<{ issues?: unknown }>(rawJson);
  if (!parsed || !Array.isArray(parsed.issues)) {
    return null;
  }

  return parsed.issues.length;
}

function tryParseReconciliationSummaryMeta(rawJson: string): {
  source: string | null;
  issueCount: number | null;
  issueCodes: string[];
  processedCount: number | null;
  deferredCount: number | null;
  historyRecovery:
    | {
        closedOrderLookbackDays: number | null;
        scannedSnapshotCount: number | null;
        recoveredOrderCount: number | null;
        markets: Array<{
          market: string;
          archivalWindowStartAt: string | null;
          archivalWindowEndAt: string | null;
          nextWindowEndAt: string | null;
          openPagesScanned: number | null;
          recentClosedPagesScanned: number | null;
          archivalClosedPagesScanned: number | null;
          snapshotCount: number | null;
        }>;
      }
    | null;
} {
  type ParsedHistoryRecoveryMarketMeta = {
    market: string;
    archivalWindowStartAt: string | null;
    archivalWindowEndAt: string | null;
    nextWindowEndAt: string | null;
    openPagesScanned: number | null;
    recentClosedPagesScanned: number | null;
    archivalClosedPagesScanned: number | null;
    snapshotCount: number | null;
  };

  const parsed = tryParseJson<{
    source?: unknown;
    issues?: unknown;
    processedCount?: unknown;
    deferredCount?: unknown;
    historyRecovery?: unknown;
  }>(rawJson);
  const historyRecoveryRaw =
    parsed && parsed.historyRecovery && typeof parsed.historyRecovery === "object"
      ? parsed.historyRecovery as {
          closedOrderLookbackDays?: unknown;
          scannedSnapshotCount?: unknown;
          recoveredOrderCount?: unknown;
          markets?: unknown;
        }
      : null;

  return {
    source: parsed && typeof parsed.source === "string" ? parsed.source : null,
    issueCount: parsed && Array.isArray(parsed.issues) ? parsed.issues.length : null,
    issueCodes:
      parsed && Array.isArray(parsed.issues)
        ? parsed.issues
            .map((issue) =>
              issue && typeof issue === "object" && "code" in issue && typeof issue.code === "string"
                ? issue.code
                : null,
            )
            .filter((code): code is string => typeof code === "string")
        : [],
    processedCount:
      parsed && typeof parsed.processedCount === "number" ? parsed.processedCount : null,
    deferredCount:
      parsed && typeof parsed.deferredCount === "number" ? parsed.deferredCount : null,
    historyRecovery: historyRecoveryRaw
      ? {
          closedOrderLookbackDays:
            typeof historyRecoveryRaw.closedOrderLookbackDays === "number"
              ? historyRecoveryRaw.closedOrderLookbackDays
              : null,
          scannedSnapshotCount:
            typeof historyRecoveryRaw.scannedSnapshotCount === "number"
              ? historyRecoveryRaw.scannedSnapshotCount
              : null,
          recoveredOrderCount:
            typeof historyRecoveryRaw.recoveredOrderCount === "number"
              ? historyRecoveryRaw.recoveredOrderCount
              : null,
          markets:
            Array.isArray(historyRecoveryRaw.markets)
              ? historyRecoveryRaw.markets
                  .map((market): ParsedHistoryRecoveryMarketMeta | null => {
                    if (!market || typeof market !== "object") {
                      return null;
                    }

                    return {
                      market:
                        "market" in market && typeof market.market === "string"
                          ? market.market
                          : "unknown",
                      archivalWindowStartAt:
                        "archivalWindowStartAt" in market && typeof market.archivalWindowStartAt === "string"
                          ? market.archivalWindowStartAt
                          : null,
                      archivalWindowEndAt:
                        "archivalWindowEndAt" in market && typeof market.archivalWindowEndAt === "string"
                          ? market.archivalWindowEndAt
                          : null,
                      nextWindowEndAt:
                        "nextWindowEndAt" in market && typeof market.nextWindowEndAt === "string"
                          ? market.nextWindowEndAt
                          : null,
                      openPagesScanned:
                        "openPagesScanned" in market && typeof market.openPagesScanned === "number"
                          ? market.openPagesScanned
                          : null,
                      recentClosedPagesScanned:
                        "recentClosedPagesScanned" in market && typeof market.recentClosedPagesScanned === "number"
                          ? market.recentClosedPagesScanned
                          : null,
                      archivalClosedPagesScanned:
                        "archivalClosedPagesScanned" in market && typeof market.archivalClosedPagesScanned === "number"
                          ? market.archivalClosedPagesScanned
                          : null,
                      snapshotCount:
                        "snapshotCount" in market && typeof market.snapshotCount === "number"
                          ? market.snapshotCount
                          : null,
                    };
                  })
                  .filter((market): market is ParsedHistoryRecoveryMarketMeta => market !== null)
              : [],
        }
      : null,
  };
}

function formatTransitionLines(
  transitions: ExecutionStateTransitionRecord[],
): string[] {
  if (transitions.length === 0) {
    return ["recent_transitions: none"];
  }

  return [
    `recent_transitions: ${transitions.length}`,
    ...transitions.map(
      (transition) =>
        `- ${transition.createdAt} | ${transition.command} | ${transition.fromSystemStatus ?? "none"} -> ${transition.toSystemStatus} | mode ${transition.fromExecutionMode ?? "none"} -> ${transition.toExecutionMode} | gate ${transition.fromLiveExecutionGate ?? "none"} -> ${transition.toLiveExecutionGate} | reason=${transition.reason ?? "none"}`,
    ),
  ];
}

function formatLatestReconciliationLines(
  run: ReconciliationRunRecord | null,
): string[] {
  if (!run) {
    return [
      "recent_sync_source: none",
      "recent_sync_status: none",
      "recent_sync_issues: none",
      "recent_sync_issue_codes: none",
      "recent_sync_history_recovered_orders: none",
      "recent_sync_history_scanned_snapshots: none",
      "recent_sync_history_archive_progress: none",
      "recent_sync_completed_at: none",
      "recent_sync_error: none",
    ];
  }

  const meta = tryParseReconciliationSummaryMeta(run.summaryJson);
  return [
    `recent_sync_source: ${meta.source ?? "unknown"}`,
    `recent_sync_status: ${run.status}`,
    `recent_sync_issues: ${meta.issueCount ?? "unknown"}`,
    `recent_sync_issue_codes: ${meta.issueCodes.length === 0 ? "none" : meta.issueCodes.join(",")}`,
    `recent_sync_history_recovered_orders: ${meta.historyRecovery?.recoveredOrderCount ?? "none"}`,
    `recent_sync_history_scanned_snapshots: ${meta.historyRecovery?.scannedSnapshotCount ?? "none"}`,
    `recent_sync_history_archive_progress: ${formatHistoryRecoveryInline(meta.historyRecovery)}`,
    `recent_sync_completed_at: ${run.completedAt ?? "none"}`,
    `recent_sync_error: ${run.errorMessage ?? "none"}`,
  ];
}

function formatHistoryRecoveryInline(
  historyRecovery:
    | {
        closedOrderLookbackDays: number | null;
        scannedSnapshotCount: number | null;
        recoveredOrderCount: number | null;
        markets: Array<{
          market: string;
          archivalWindowStartAt: string | null;
          archivalWindowEndAt: string | null;
          nextWindowEndAt: string | null;
          openPagesScanned: number | null;
          recentClosedPagesScanned: number | null;
          archivalClosedPagesScanned: number | null;
          snapshotCount: number | null;
        }>;
      }
    | null,
): string {
  if (!historyRecovery) {
    return "none";
  }

  const marketSummaries = historyRecovery.markets.map(
    (market) =>
      `${market.market}[archive=${market.archivalWindowStartAt ?? "unknown"}..${market.archivalWindowEndAt ?? "unknown"} next<=${market.nextWindowEndAt ?? "unknown"} pages=${market.openPagesScanned ?? "?"}/${market.recentClosedPagesScanned ?? "?"}/${market.archivalClosedPagesScanned ?? "?"} snapshots=${market.snapshotCount ?? "?"}]`,
  );

  return [
    `lookback_days=${historyRecovery.closedOrderLookbackDays ?? "unknown"}`,
    `scanned=${historyRecovery.scannedSnapshotCount ?? "unknown"}`,
    `recovered=${historyRecovery.recoveredOrderCount ?? "unknown"}`,
    `markets=${marketSummaries.length === 0 ? "none" : marketSummaries.join(";")}`,
  ].join(" ");
}

function describeLiveOrderBlockers(
  state: ExecutionStateRecord,
  liveSendPath: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER",
): string[] {
  const blockers: string[] = [];

  if (state.executionMode !== "LIVE") {
    blockers.push("DRY_RUN");
  }

  if (state.liveExecutionGate !== "ENABLED") {
    blockers.push("LIVE_GATE_DISABLED");
  }

  if (state.killSwitchActive || state.systemStatus === "KILL_SWITCHED") {
    blockers.push("KILL_SWITCHED");
  } else if (state.systemStatus === "PAUSED") {
    blockers.push("PAUSED");
  } else if (state.systemStatus === "DEGRADED") {
    blockers.push("DEGRADED");
  }

  if (liveSendPath === "DRY_RUN_ADAPTER") {
    blockers.push("DRY_RUN_ADAPTER");
  }

  return blockers;
}
