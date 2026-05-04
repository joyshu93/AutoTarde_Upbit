import type {
  BalanceSnapshotRecord,
  ExecutionStateSeed,
  ExchangeBalance,
  ExecutionStateRecord,
  ExecutionStateTransitionRecord,
  HistoryRecoveryCheckpointRecord,
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

export function formatRecoveryProgressMessage(
  latestRun: ReconciliationRunRecord | null,
  checkpoints: HistoryRecoveryCheckpointRecord[],
): string {
  const meta = latestRun ? tryParseReconciliationSummaryMeta(latestRun.summaryJson) : null;

  return [
    "Exchange History Recovery",
    "state_source: persisted reconciliation_runs + history_recovery_checkpoints",
    `latest_run_started_at: ${latestRun?.startedAt ?? "none"}`,
    `latest_run_status: ${latestRun?.status ?? "none"}`,
    `latest_run_source: ${meta?.source ?? "none"}`,
    `latest_run_error: ${latestRun?.errorMessage ?? "none"}`,
    `coverage_status: ${meta?.historyRecovery?.coverageStatus ?? "none"}`,
    `confidence_level: ${meta?.historyRecovery?.confidenceLevel ?? "none"}`,
    `confidence_reason: ${meta?.historyRecovery?.confidenceReason ?? "none"}`,
    `failure_message: ${meta?.historyRecovery?.failureMessage ?? "none"}`,
    `history_lookback_days: ${meta?.historyRecovery?.closedOrderLookbackDays ?? "none"}`,
    `history_stop_before_days: ${meta?.historyRecovery?.stopBeforeDays ?? "none"}`,
    `history_stop_before_at: ${meta?.historyRecovery?.stopBeforeAt ?? "none"}`,
    `history_scanned_snapshots: ${meta?.historyRecovery?.scannedSnapshotCount ?? "none"}`,
    `history_recovered_orders: ${meta?.historyRecovery?.recoveredOrderCount ?? "none"}`,
    ...formatRecoveryMarketProgressLines(meta?.historyRecovery?.markets ?? []),
    ...formatHistoryRecoveryCheckpointLines(checkpoints),
  ].join("\n");
}

export function formatOperatorNotificationsMessage(
  notifications: OperatorNotificationRecord[],
  attempts: OperatorNotificationDeliveryAttemptRecord[] = [],
  options?: {
    now?: string;
  },
): string {
  const metrics = summarizeNotificationDeliveryMetrics(notifications, attempts, options?.now ?? null);

  if (notifications.length === 0) {
    return [
      "Operator Alerts",
      "count: 0",
      "state_source: persisted operator_notifications",
      "attempt_source: persisted operator_notification_delivery_attempts",
      "note: No operator notifications are stored yet.",
      `pending_total_count: ${metrics.pendingTotalCount}`,
      `pending_due_count: ${metrics.pendingDueCount}`,
      `pending_scheduled_count: ${metrics.pendingScheduledCount}`,
      `active_lease_count: ${metrics.activeLeaseCount}`,
      `expired_lease_count: ${metrics.expiredLeaseCount}`,
      `abandoned_lease_candidate_count: ${metrics.abandonedLeaseCandidateCount}`,
      `recent_stale_lease_count: ${metrics.recentStaleLeaseCount}`,
      `recent_sent_attempt_count: ${metrics.recentSentAttemptCount}`,
      `recent_retry_scheduled_attempt_count: ${metrics.recentRetryScheduledAttemptCount}`,
      `recent_failed_attempt_count: ${metrics.recentFailedAttemptCount}`,
      `oldest_pending_created_at: ${metrics.oldestPendingCreatedAt ?? "none"}`,
      `next_scheduled_attempt_at: ${metrics.nextScheduledAttemptAt ?? "none"}`,
      `oldest_active_lease_expires_at: ${metrics.oldestActiveLeaseExpiresAt ?? "none"}`,
      `latest_delivery_attempt_at: ${metrics.latestDeliveryAttemptAt ?? "none"}`,
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
    `pending_total_count: ${metrics.pendingTotalCount}`,
    `pending_due_count: ${metrics.pendingDueCount}`,
    `pending_scheduled_count: ${metrics.pendingScheduledCount}`,
    `active_lease_count: ${metrics.activeLeaseCount}`,
    `expired_lease_count: ${metrics.expiredLeaseCount}`,
    `abandoned_lease_candidate_count: ${metrics.abandonedLeaseCandidateCount}`,
    `recent_stale_lease_count: ${metrics.recentStaleLeaseCount}`,
    `recent_sent_attempt_count: ${metrics.recentSentAttemptCount}`,
    `recent_retry_scheduled_attempt_count: ${metrics.recentRetryScheduledAttemptCount}`,
    `recent_failed_attempt_count: ${metrics.recentFailedAttemptCount}`,
    `oldest_pending_created_at: ${metrics.oldestPendingCreatedAt ?? "none"}`,
    `next_scheduled_attempt_at: ${metrics.nextScheduledAttemptAt ?? "none"}`,
    `oldest_active_lease_expires_at: ${metrics.oldestActiveLeaseExpiresAt ?? "none"}`,
    `latest_delivery_attempt_at: ${metrics.latestDeliveryAttemptAt ?? "none"}`,
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

function formatRecoveryMarketProgressLines(
  markets: NonNullable<ReturnType<typeof tryParseReconciliationSummaryMeta>["historyRecovery"]>["markets"],
): string[] {
  if (markets.length === 0) {
    return ["latest_market_progress: none"];
  }

  return [
    "latest_market_progress:",
    ...markets.map(
      (market) =>
        `- ${market.market} | archive_window=${market.archivalWindowStartAt ?? "unknown"}..${market.archivalWindowEndAt ?? "unknown"} | next_window_end_at=${market.nextWindowEndAt ?? "unknown"} | archive_complete=${market.archiveComplete ?? "unknown"} | confidence=${market.confidenceLevel ?? "unknown"}:${market.confidenceReason ?? "unknown"} | truncated open/recent/archive=${market.openHistoryTruncated ?? "unknown"}/${market.recentClosedHistoryTruncated ?? "unknown"}/${market.archivalClosedHistoryTruncated ?? "unknown"} | pages open/recent/archive=${market.openPagesScanned ?? "?"}/${market.recentClosedPagesScanned ?? "?"}/${market.archivalClosedPagesScanned ?? "?"} | snapshots=${market.snapshotCount ?? "?"}`,
    ),
  ];
}

function formatHistoryRecoveryCheckpointLines(
  checkpoints: HistoryRecoveryCheckpointRecord[],
): string[] {
  if (checkpoints.length === 0) {
    return ["persisted_checkpoints: none"];
  }

  const sortedCheckpoints = [...checkpoints].sort(
    (left, right) => left.market.localeCompare(right.market) || left.checkpointType.localeCompare(right.checkpointType),
  );

  return [
    `persisted_checkpoints: ${sortedCheckpoints.length}`,
    ...sortedCheckpoints.map(
      (checkpoint) =>
        `- ${checkpoint.market} | ${checkpoint.checkpointType} | next_window_end_at=${checkpoint.nextWindowEndAt} | updated_at=${checkpoint.updatedAt}`,
    ),
  ];
}

function summarizeNotificationDeliveryMetrics(
  notifications: OperatorNotificationRecord[],
  attempts: OperatorNotificationDeliveryAttemptRecord[],
  now: string | null,
): {
  pendingTotalCount: number;
  pendingDueCount: number;
  pendingScheduledCount: number;
  activeLeaseCount: number;
  expiredLeaseCount: number;
  abandonedLeaseCandidateCount: number;
  recentStaleLeaseCount: number;
  recentSentAttemptCount: number;
  recentRetryScheduledAttemptCount: number;
  recentFailedAttemptCount: number;
  oldestPendingCreatedAt: string | null;
  nextScheduledAttemptAt: string | null;
  oldestActiveLeaseExpiresAt: string | null;
  latestDeliveryAttemptAt: string | null;
} {
  let pendingTotalCount = 0;
  let pendingDueCount = 0;
  let pendingScheduledCount = 0;
  let activeLeaseCount = 0;
  let expiredLeaseCount = 0;
  let abandonedLeaseCandidateCount = 0;
  let oldestPendingCreatedAt: string | null = null;
  let nextScheduledAttemptAt: string | null = null;
  let oldestActiveLeaseExpiresAt: string | null = null;

  for (const notification of notifications) {
    if (notification.deliveryStatus !== "PENDING") {
      continue;
    }

    pendingTotalCount += 1;
    oldestPendingCreatedAt = minIso(oldestPendingCreatedAt, notification.createdAt);

    const leaseActive =
      notification.leaseToken !== null &&
      notification.leaseExpiresAt !== null &&
      notification.lastAttemptAt !== null &&
      (now === null || notification.leaseExpiresAt.localeCompare(now) > 0);

    if (leaseActive) {
      activeLeaseCount += 1;
      if (notification.leaseExpiresAt !== null) {
        oldestActiveLeaseExpiresAt = minIso(oldestActiveLeaseExpiresAt, notification.leaseExpiresAt);
      }
      continue;
    }

    const leaseExpired =
      now !== null &&
      notification.leaseToken !== null &&
      notification.leaseExpiresAt !== null &&
      notification.leaseExpiresAt.localeCompare(now) <= 0;

    if (leaseExpired) {
      expiredLeaseCount += 1;
      if (notification.lastAttemptAt !== null) {
        abandonedLeaseCandidateCount += 1;
      }
    }

    if (notification.nextAttemptAt === null || (now !== null && notification.nextAttemptAt.localeCompare(now) <= 0)) {
      pendingDueCount += 1;
      continue;
    }

    nextScheduledAttemptAt = minIso(nextScheduledAttemptAt, notification.nextAttemptAt);
    pendingScheduledCount += 1;
  }

  const recentStaleLeaseCount = attempts.filter((attempt) => attempt.outcome === "STALE_LEASE").length;
  const recentSentAttemptCount = attempts.filter((attempt) => attempt.outcome === "SENT").length;
  const recentRetryScheduledAttemptCount = attempts.filter((attempt) => attempt.outcome === "RETRY_SCHEDULED").length;
  const recentFailedAttemptCount = attempts.filter((attempt) => attempt.outcome === "FAILED").length;
  const latestDeliveryAttemptAt = attempts
    .map((attempt) => attempt.attemptedAt)
    .sort((left, right) => right.localeCompare(left))[0] ?? null;

  return {
    pendingTotalCount,
    pendingDueCount,
    pendingScheduledCount,
    activeLeaseCount,
    expiredLeaseCount,
    abandonedLeaseCandidateCount,
    recentStaleLeaseCount,
    recentSentAttemptCount,
    recentRetryScheduledAttemptCount,
    recentFailedAttemptCount,
    oldestPendingCreatedAt,
    nextScheduledAttemptAt,
    oldestActiveLeaseExpiresAt,
    latestDeliveryAttemptAt,
  };
}

function minIso(current: string | null, candidate: string): string {
  return current === null || candidate.localeCompare(current) < 0 ? candidate : current;
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
        stopBeforeDays: number | null;
        stopBeforeAt: string | null;
        coverageStatus: string | null;
        confidenceLevel: string | null;
        confidenceReason: string | null;
        failureMessage: string | null;
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
          archiveComplete: boolean | null;
          confidenceLevel: string | null;
          confidenceReason: string | null;
          openHistoryTruncated: boolean | null;
          recentClosedHistoryTruncated: boolean | null;
          archivalClosedHistoryTruncated: boolean | null;
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
    archiveComplete: boolean | null;
    confidenceLevel: string | null;
    confidenceReason: string | null;
    openHistoryTruncated: boolean | null;
    recentClosedHistoryTruncated: boolean | null;
    archivalClosedHistoryTruncated: boolean | null;
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
          stopBeforeDays?: unknown;
          stopBeforeAt?: unknown;
          coverageStatus?: unknown;
          confidenceLevel?: unknown;
          confidenceReason?: unknown;
          failureMessage?: unknown;
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
          stopBeforeDays:
            typeof historyRecoveryRaw.stopBeforeDays === "number"
              ? historyRecoveryRaw.stopBeforeDays
              : null,
          stopBeforeAt:
            typeof historyRecoveryRaw.stopBeforeAt === "string"
              ? historyRecoveryRaw.stopBeforeAt
              : null,
          coverageStatus:
            typeof historyRecoveryRaw.coverageStatus === "string"
              ? historyRecoveryRaw.coverageStatus
              : null,
          confidenceLevel:
            typeof historyRecoveryRaw.confidenceLevel === "string"
              ? historyRecoveryRaw.confidenceLevel
              : null,
          confidenceReason:
            typeof historyRecoveryRaw.confidenceReason === "string"
              ? historyRecoveryRaw.confidenceReason
              : null,
          failureMessage:
            typeof historyRecoveryRaw.failureMessage === "string"
              ? historyRecoveryRaw.failureMessage
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
                      archiveComplete:
                        "archiveComplete" in market && typeof market.archiveComplete === "boolean"
                          ? market.archiveComplete
                          : null,
                      confidenceLevel:
                        "confidenceLevel" in market && typeof market.confidenceLevel === "string"
                          ? market.confidenceLevel
                          : null,
                      confidenceReason:
                        "confidenceReason" in market && typeof market.confidenceReason === "string"
                          ? market.confidenceReason
                          : null,
                      openHistoryTruncated:
                        "openHistoryTruncated" in market && typeof market.openHistoryTruncated === "boolean"
                          ? market.openHistoryTruncated
                          : null,
                      recentClosedHistoryTruncated:
                        "recentClosedHistoryTruncated" in market && typeof market.recentClosedHistoryTruncated === "boolean"
                          ? market.recentClosedHistoryTruncated
                          : null,
                      archivalClosedHistoryTruncated:
                        "archivalClosedHistoryTruncated" in market && typeof market.archivalClosedHistoryTruncated === "boolean"
                          ? market.archivalClosedHistoryTruncated
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
      "recent_sync_history_coverage_status: none",
      "recent_sync_history_confidence: none",
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
    `recent_sync_history_coverage_status: ${meta.historyRecovery?.coverageStatus ?? "none"}`,
    `recent_sync_history_confidence: ${formatHistoryRecoveryConfidence(meta.historyRecovery)}`,
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
        stopBeforeDays: number | null;
        stopBeforeAt: string | null;
        coverageStatus: string | null;
        confidenceLevel: string | null;
        confidenceReason: string | null;
        failureMessage: string | null;
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
          archiveComplete: boolean | null;
          confidenceLevel: string | null;
          confidenceReason: string | null;
          openHistoryTruncated: boolean | null;
          recentClosedHistoryTruncated: boolean | null;
          archivalClosedHistoryTruncated: boolean | null;
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
      `${market.market}[archive=${market.archivalWindowStartAt ?? "unknown"}..${market.archivalWindowEndAt ?? "unknown"} next<=${market.nextWindowEndAt ?? "unknown"} complete=${market.archiveComplete ?? "unknown"} confidence=${market.confidenceLevel ?? "unknown"}:${market.confidenceReason ?? "unknown"} truncated=${market.openHistoryTruncated ?? "unknown"}/${market.recentClosedHistoryTruncated ?? "unknown"}/${market.archivalClosedHistoryTruncated ?? "unknown"} pages=${market.openPagesScanned ?? "?"}/${market.recentClosedPagesScanned ?? "?"}/${market.archivalClosedPagesScanned ?? "?"} snapshots=${market.snapshotCount ?? "?"}]`,
  );

  return [
    `lookback_days=${historyRecovery.closedOrderLookbackDays ?? "unknown"}`,
    `stop_before_days=${historyRecovery.stopBeforeDays ?? "unknown"}`,
    `stop_before_at=${historyRecovery.stopBeforeAt ?? "unknown"}`,
    `coverage=${historyRecovery.coverageStatus ?? "unknown"}`,
    `confidence=${historyRecovery.confidenceLevel ?? "unknown"}:${historyRecovery.confidenceReason ?? "unknown"}`,
    `failure=${historyRecovery.failureMessage ?? "none"}`,
    `scanned=${historyRecovery.scannedSnapshotCount ?? "unknown"}`,
    `recovered=${historyRecovery.recoveredOrderCount ?? "unknown"}`,
    `markets=${marketSummaries.length === 0 ? "none" : marketSummaries.join(";")}`,
  ].join(" ");
}

function formatHistoryRecoveryConfidence(
  historyRecovery:
    | {
        confidenceLevel: string | null;
        confidenceReason: string | null;
        failureMessage: string | null;
      }
    | null,
): string {
  if (!historyRecovery) {
    return "none";
  }

  return `${historyRecovery.confidenceLevel ?? "unknown"}:${historyRecovery.confidenceReason ?? "unknown"} failure=${historyRecovery.failureMessage ?? "none"}`;
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
