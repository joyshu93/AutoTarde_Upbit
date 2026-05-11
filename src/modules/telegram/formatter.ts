import type {
  BalanceSnapshotRecord,
  ExecutionStateSeed,
  ExchangeBalance,
  ExecutionStateRecord,
  ExecutionStateTransitionRecord,
  HistoryRecoveryCheckpointRecord,
  OperatorNotificationDeliveryAttemptRecord,
  OperatorNotificationDeliveryRunRecord,
  OperatorNotificationRecord,
  FillRecord,
  OrderEventRecord,
  OrderRecord,
  PositionSnapshot,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
  RiskEventRecord,
  StrategySchedulerRunRecord,
  StrategySchedulerStatus,
  TelegramInboundOffsetRecord,
} from "../../domain/types.js";
import { detectExecutionStateSeedMismatches } from "../db/interfaces.js";
import type { TelegramInboundPollingStatus } from "./inbound.js";
import type {
  SupportedTelegramCommand,
  TelegramCommandContract,
  TelegramRuntimeConfigSnapshot,
  TelegramStrategyRunResult,
  TelegramSyncResult,
} from "./interfaces.js";

const MANUAL_INPUT_NOTE = "Telegram does not accept manual cash or position input.";

export function formatHelpMessage(contracts: readonly TelegramCommandContract[]): string {
  const inspectionContracts = contracts.filter((contract) => contract.category === "inspection");
  const controlContracts = contracts.filter((contract) => contract.category === "control");

  return [
    "Operator Help",
    "state_source: static telegram command contracts",
    `command_count: ${contracts.length}`,
    ...formatHelpCommandGroup("inspection_commands", inspectionContracts),
    ...formatHelpCommandGroup("control_commands", controlContracts),
    "read_only_boundary: /help never triggers sync, strategy runs, scheduler ticks, exchange reads, order mutation, or live order transmission.",
    "execution_boundary: /run BTC|ETH is a deterministic strategy trigger and still inherits execution-state, risk, DRY_RUN, and live-send gates.",
    "live_boundary: Live order transmission requires APP_EXECUTION_MODE=LIVE and ENABLE_LIVE_ORDERS=true; the default path remains DRY_RUN.",
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

export function formatRuntimeConfigMessage(config: TelegramRuntimeConfigSnapshot | null): string {
  if (!config) {
    return [
      "Runtime Config",
      "state_source: runtime app configuration",
      "status: unavailable",
      "note: Runtime configuration was not supplied to the Telegram router.",
      `operator_boundary: ${MANUAL_INPUT_NOTE}`,
    ].join("\n");
  }

  const liveBlockers = describeRuntimeConfigLiveBlockers(config);

  return [
    "Runtime Config",
    "state_source: runtime app configuration",
    `service_name: ${config.serviceName}`,
    `execution_mode: ${config.executionMode}`,
    `live_gate: ${config.liveExecutionGate}`,
    `live_send_path: ${config.liveSendPath}`,
    `live_orders_allowed_by_config: ${liveBlockers.length === 0 ? "true" : "false"}`,
    `config_live_blockers: ${liveBlockers.length === 0 ? "none" : liveBlockers.join(",")}`,
    `exchange_backed_read_enabled: ${config.exchangeBackedReadEnabled}`,
    `upbit_base_url: ${config.upbitBaseUrl}`,
    `database_path: ${config.databasePath}`,
    `telegram_delivery_enabled: ${config.telegramDeliveryEnabled}`,
    `telegram_bot_token_configured: ${config.telegramBotTokenConfigured}`,
    `telegram_operator_chat_id_configured: ${config.telegramOperatorChatIdConfigured}`,
    `telegram_delivery_max_attempts: ${config.telegramDeliveryMaxAttempts}`,
    `telegram_delivery_base_backoff_ms: ${config.telegramDeliveryBaseBackoffMs}`,
    `telegram_delivery_max_backoff_ms: ${config.telegramDeliveryMaxBackoffMs}`,
    `telegram_delivery_lease_ms: ${config.telegramDeliveryLeaseMs}`,
    `telegram_inbound_polling_enabled: ${config.telegramInboundPollingEnabled}`,
    `telegram_inbound_poll_interval_ms: ${config.telegramInboundPollIntervalMs}`,
    `telegram_inbound_poll_timeout_seconds: ${config.telegramInboundPollTimeoutSeconds}`,
    `telegram_inbound_poll_limit: ${config.telegramInboundPollLimit}`,
    `strategy_scheduler_enabled: ${config.strategySchedulerEnabled}`,
    `strategy_scheduler_run_on_start: ${config.strategySchedulerRunOnStart}`,
    `strategy_scheduler_btc_interval_ms: ${config.strategySchedulerBtcIntervalMs}`,
    `strategy_scheduler_eth_interval_ms: ${config.strategySchedulerEthIntervalMs}`,
    `reconciliation_max_order_lookups_per_run: ${config.reconciliationMaxOrderLookupsPerRun}`,
    `reconciliation_history_max_pages_per_market: ${config.reconciliationHistoryMaxPagesPerMarket}`,
    `reconciliation_closed_order_lookback_days: ${config.reconciliationClosedOrderLookbackDays}`,
    `reconciliation_history_stop_before_days: ${config.reconciliationHistoryStopBeforeDays}`,
    `reconciliation_history_retention_assumption_days: ${config.reconciliationHistoryRetentionAssumptionDays}`,
    `stale_price_threshold_ms: ${config.stalePriceThresholdMs}`,
    `minimum_order_value_krw: ${config.minimumOrderValueKrw}`,
    `max_live_order_value_krw: ${config.maxLiveOrderValueKrw ?? "none"}`,
    `max_allocation_btc: ${config.maxAllocationByAsset.BTC}`,
    `max_allocation_eth: ${config.maxAllocationByAsset.ETH}`,
    `total_exposure_cap: ${config.totalExposureCap}`,
    "secret_boundary: secret values are never rendered; only configured/not_configured booleans are shown.",
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

export function formatReadinessMessage(input: {
  runtimeConfig: TelegramRuntimeConfigSnapshot | null;
  executionState: ExecutionStateRecord;
  latestBalanceSnapshot: BalanceSnapshotRecord | null;
  latestPositionSnapshot: PositionSnapshotRecord | null;
  latestReconciliationRun: ReconciliationRunRecord | null;
  activeOrders: OrderRecord[];
  recentRiskEvents: RiskEventRecord[];
  pendingNotifications: OperatorNotificationRecord[];
  schedulerStatus: StrategySchedulerStatus | null;
  inboundStatus: TelegramInboundPollingStatus | null;
}): string {
  const checks = buildReadinessChecks(input);
  const overallStatus = checks.some((check) => check.status === "BLOCK")
    ? "BLOCK"
    : checks.some((check) => check.status === "WARN")
      ? "WARN"
      : "PASS";

  return [
    "Operator Readiness",
    "state_source: runtime config + persisted execution_state + latest persisted snapshots",
    `overall_status: ${overallStatus}`,
    `exchange_account_id: ${input.executionState.exchangeAccountId}`,
    `system_status: ${input.executionState.systemStatus}`,
    `execution_mode: ${input.executionState.executionMode}`,
    `live_gate: ${input.executionState.liveExecutionGate}`,
    `kill_switch: ${input.executionState.killSwitchActive ? "on" : "off"}`,
    `degraded_reason: ${input.executionState.degradedReason ?? "none"}`,
    `latest_balance_snapshot_at: ${input.latestBalanceSnapshot?.capturedAt ?? "none"}`,
    `latest_position_snapshot_at: ${input.latestPositionSnapshot?.capturedAt ?? "none"}`,
    `latest_reconciliation_status: ${input.latestReconciliationRun?.status ?? "none"}`,
    `latest_reconciliation_completed_at: ${input.latestReconciliationRun?.completedAt ?? "none"}`,
    `active_order_count: ${input.activeOrders.length}`,
    `recent_risk_block_count: ${countRiskBlocks(input.recentRiskEvents)}`,
    `pending_notification_count: ${input.pendingNotifications.length}`,
    "checks:",
    ...checks.map((check) => `- ${check.name}: ${check.status} | ${check.detail}`),
    "read_only_boundary: /readiness never triggers sync, Telegram polling, strategy runs, scheduler ticks, exchange reads, order mutation, or live order transmission.",
    "secret_boundary: secret values are never rendered; only configured/not_configured readiness is shown.",
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

export function formatStatusMessage(
  state: ExecutionStateRecord,
  options?: {
    executionStateSeed?: ExecutionStateSeed;
    liveSendPath?: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
    transitions?: ExecutionStateTransitionRecord[];
    latestReconciliationRun?: ReconciliationRunRecord | null;
    schedulerStatus?: StrategySchedulerStatus;
    schedulerRuns?: StrategySchedulerRunRecord[];
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
    ...formatStrategySchedulerStatusLines(options?.schedulerStatus ?? null),
    ...formatStrategySchedulerRunLines(options?.schedulerRuns ?? []),
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
    `history_retention_assumption_days: ${meta?.historyRecovery?.retentionAssumptionDays ?? "none"}`,
    `history_retention_boundary_at: ${meta?.historyRecovery?.retentionBoundaryAt ?? "none"}`,
    `history_retention_status: ${meta?.historyRecovery?.retentionStatus ?? "none"}`,
    `history_scanned_snapshots: ${meta?.historyRecovery?.scannedSnapshotCount ?? "none"}`,
    `history_recovered_orders: ${meta?.historyRecovery?.recoveredOrderCount ?? "none"}`,
    ...formatRecoveryMarketProgressLines(meta?.historyRecovery?.markets ?? []),
    ...formatHistoryRecoveryCheckpointLines(checkpoints),
  ].join("\n");
}

export function formatOperatorNotificationsMessage(
  notifications: OperatorNotificationRecord[],
  attempts: OperatorNotificationDeliveryAttemptRecord[] = [],
  runs: OperatorNotificationDeliveryRunRecord[] = [],
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
      `delivery_run_count: ${runs.length}`,
      ...formatOperatorNotificationDeliveryRunLines(runs),
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
    `delivery_run_count: ${runs.length}`,
    ...formatOperatorNotificationDeliveryRunLines(runs),
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

export function formatOrdersMessage(orders: OrderRecord[], options?: { limit?: number }): string {
  if (orders.length === 0) {
    return [
      "Orders",
      "count: 0",
      "note: No orders are stored yet.",
    ].join("\n");
  }

  const sortedOrders = [...orders].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const limit = Math.max(1, Math.trunc(options?.limit ?? sortedOrders.length));
  const visibleOrders = sortedOrders.slice(0, limit);
  const omittedCount = Math.max(0, sortedOrders.length - visibleOrders.length);

  return [
    "Orders",
    `count: ${sortedOrders.length}`,
    `displayed_count: ${visibleOrders.length}`,
    `omitted_count: ${omittedCount}`,
    ...visibleOrders.map(
      (order) =>
        `- ${order.updatedAt} | ${order.market} | ${order.side} | ${order.status} | mode=${order.executionMode} | price=${order.price ?? "market"} | volume=${order.volume ?? "notional"} | id=${order.identifier}`,
    ),
    ...(omittedCount > 0
      ? [`note: Showing the most recent ${visibleOrders.length} order(s). Use /order <id|identifier> for details.`]
      : []),
  ].join("\n");
}

export function formatOrderDetailMessage(
  order: OrderRecord | null,
  events: OrderEventRecord[],
  fills: FillRecord[],
  reference: string,
): string {
  if (!order) {
    return [
      "Order Detail",
      `query: ${reference}`,
      "status: not_found",
      "state_source: persisted orders + order_events + fills",
      "note: No order matched the provided id, identifier, or Upbit UUID for this exchange account.",
      `operator_boundary: ${MANUAL_INPUT_NOTE}`,
    ].join("\n");
  }

  const sortedEvents = [...events].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const sortedFills = [...fills].sort((left, right) => left.filledAt.localeCompare(right.filledAt));

  return [
    "Order Detail",
    `query: ${reference}`,
    "state_source: persisted orders + order_events + fills",
    `id: ${order.id}`,
    `identifier: ${order.identifier}`,
    `exchange_account_id: ${order.exchangeAccountId}`,
    `market: ${order.market}`,
    `side: ${order.side}`,
    `ord_type: ${order.ordType}`,
    `status: ${order.status}`,
    `execution_mode: ${order.executionMode}`,
    `origin: ${order.origin}`,
    `strategy_decision_id: ${order.strategyDecisionId ?? "none"}`,
    `idempotency_key: ${order.idempotencyKey}`,
    `upbit_uuid: ${order.upbitUuid ?? "none"}`,
    `price: ${order.price ?? "none"}`,
    `volume: ${order.volume ?? "none"}`,
    `time_in_force: ${order.timeInForce ?? "none"}`,
    `smp_type: ${order.smpType ?? "none"}`,
    `requested_at: ${order.requestedAt}`,
    `created_at: ${order.createdAt}`,
    `updated_at: ${order.updatedAt}`,
    `failure_code: ${order.failureCode ?? "none"}`,
    `failure_message: ${order.failureMessage ?? "none"}`,
    `exchange_response_available: ${order.exchangeResponseJson ? "true" : "false"}`,
    `event_count: ${sortedEvents.length}`,
    ...formatOrderEventLines(sortedEvents),
    `fill_count: ${sortedFills.length}`,
    ...formatFillLines(sortedFills),
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

function formatHelpCommandGroup(
  label: string,
  contracts: readonly TelegramCommandContract[],
): string[] {
  if (contracts.length === 0) {
    return [`${label}: none`];
  }

  return [
    `${label}:`,
    ...contracts.map(
      (contract) => `- ${contract.command} | ${contract.usage} | ${contract.summary}`,
    ),
  ];
}

function describeRuntimeConfigLiveBlockers(config: TelegramRuntimeConfigSnapshot): string[] {
  const blockers: string[] = [];

  if (config.executionMode !== "LIVE") {
    blockers.push("DRY_RUN");
  }

  if (config.liveExecutionGate !== "ENABLED") {
    blockers.push("LIVE_GATE_DISABLED");
  }

  if (config.liveSendPath === "DRY_RUN_ADAPTER") {
    blockers.push("DRY_RUN_ADAPTER");
  }

  return blockers;
}

function buildReadinessChecks(input: {
  runtimeConfig: TelegramRuntimeConfigSnapshot | null;
  executionState: ExecutionStateRecord;
  latestBalanceSnapshot: BalanceSnapshotRecord | null;
  latestPositionSnapshot: PositionSnapshotRecord | null;
  latestReconciliationRun: ReconciliationRunRecord | null;
  activeOrders: OrderRecord[];
  recentRiskEvents: RiskEventRecord[];
  pendingNotifications: OperatorNotificationRecord[];
  schedulerStatus: StrategySchedulerStatus | null;
  inboundStatus: TelegramInboundPollingStatus | null;
}): Array<{ name: string; status: "PASS" | "WARN" | "BLOCK"; detail: string }> {
  const config = input.runtimeConfig;
  const liveBlockers = config ? describeRuntimeConfigLiveBlockers(config) : ["CONFIG_UNAVAILABLE"];
  const stateBlockers = describeLiveOrderBlockers(input.executionState, config?.liveSendPath ?? "DRY_RUN_ADAPTER");

  return [
    {
      name: "runtime_config",
      status: config ? "PASS" : "BLOCK",
      detail: config ? "runtime configuration is available" : "runtime configuration was not supplied",
    },
    {
      name: "live_send_safety",
      status: liveBlockers.length > 0 ? "PASS" : "BLOCK",
      detail: liveBlockers.length > 0
        ? `live order path blocked by ${liveBlockers.join(",")}`
        : "live order path is enabled by config",
    },
    {
      name: "execution_state",
      status: stateBlockers.some((blocker) => blocker === "KILL_SWITCHED" || blocker === "PAUSED" || blocker === "DEGRADED")
        ? "BLOCK"
        : "PASS",
      detail: stateBlockers.length === 0
        ? "execution state allows orders"
        : `current blockers: ${stateBlockers.join(",")}`,
    },
    {
      name: "upbit_read_credentials",
      status: config?.exchangeBackedReadEnabled ? "PASS" : "WARN",
      detail: config?.exchangeBackedReadEnabled
        ? "Upbit read credentials are configured"
        : "Upbit read credentials are not configured; startup recovery and exchange-backed sync are limited",
    },
    {
      name: "telegram_delivery",
      status: config?.telegramDeliveryEnabled && config.telegramBotTokenConfigured && config.telegramOperatorChatIdConfigured
        ? "PASS"
        : "WARN",
      detail: config?.telegramDeliveryEnabled && config.telegramBotTokenConfigured && config.telegramOperatorChatIdConfigured
        ? "Telegram delivery is configured"
        : "Telegram delivery is not fully configured; durable notifications remain inspectable through /alerts",
    },
    {
      name: "telegram_inbound",
      status: input.inboundStatus?.enabled && input.inboundStatus.configured
        ? "PASS"
        : "WARN",
      detail: input.inboundStatus?.enabled && input.inboundStatus.configured
        ? `inbound configured running=${input.inboundStatus.running} offset_storage=${input.inboundStatus.offsetStorage}`
        : "Telegram inbound polling is disabled or not configured",
    },
    {
      name: "strategy_scheduler",
      status: describeStrategySchedulerReadiness(input.schedulerStatus).status,
      detail: describeStrategySchedulerReadiness(input.schedulerStatus).detail,
    },
    {
      name: "balance_snapshot",
      status: input.latestBalanceSnapshot ? "PASS" : "WARN",
      detail: input.latestBalanceSnapshot
        ? `latest balance snapshot captured_at=${input.latestBalanceSnapshot.capturedAt}`
        : "no balance snapshot is stored yet",
    },
    {
      name: "position_snapshot",
      status: input.latestPositionSnapshot ? "PASS" : "WARN",
      detail: input.latestPositionSnapshot
        ? `latest position snapshot captured_at=${input.latestPositionSnapshot.capturedAt}`
        : "no position snapshot is stored yet",
    },
    {
      name: "latest_reconciliation",
      status: describeReconciliationReadiness(input.latestReconciliationRun).status,
      detail: describeReconciliationReadiness(input.latestReconciliationRun).detail,
    },
    {
      name: "active_orders",
      status: input.activeOrders.length === 0 ? "PASS" : "WARN",
      detail: input.activeOrders.length === 0
        ? "no active or reconciliation-required orders are currently stored"
        : `${input.activeOrders.length} active or reconciliation-required order(s) need operator visibility`,
    },
    {
      name: "recent_risk_blocks",
      status: countRiskBlocks(input.recentRiskEvents) === 0 ? "PASS" : "WARN",
      detail: countRiskBlocks(input.recentRiskEvents) === 0
        ? `no BLOCK risk events in recent sample size=${input.recentRiskEvents.length}`
        : `${countRiskBlocks(input.recentRiskEvents)} BLOCK risk event(s) in recent sample size=${input.recentRiskEvents.length}`,
    },
    {
      name: "pending_notifications",
      status: input.pendingNotifications.length === 0 ? "PASS" : "WARN",
      detail: input.pendingNotifications.length === 0
        ? "no pending operator notifications in recent bounded sample"
        : `${input.pendingNotifications.length} pending operator notification(s) in bounded sample`,
    },
  ];
}

function countRiskBlocks(events: readonly RiskEventRecord[]): number {
  return events.filter((event) => event.level === "BLOCK").length;
}

function describeStrategySchedulerReadiness(
  status: StrategySchedulerStatus | null,
): { status: "PASS" | "WARN" | "BLOCK"; detail: string } {
  if (!status?.enabled) {
    return {
      status: "WARN",
      detail: "scheduler is disabled; only explicit /run commands can trigger strategy cycles",
    };
  }

  if (status.startupPreflight?.status === "BLOCK") {
    return {
      status: "BLOCK",
      detail: `scheduler startup blocked: ${status.startupPreflight.detail}`,
    };
  }

  return {
    status: status.started ? "PASS" : "WARN",
    detail:
      `scheduler enabled started=${status.started} ` +
      `startup_preflight=${status.startupPreflight?.status ?? "none"}`,
  };
}

function describeReconciliationReadiness(
  run: ReconciliationRunRecord | null,
): { status: "PASS" | "WARN" | "BLOCK"; detail: string } {
  if (!run) {
    return {
      status: "WARN",
      detail: "no reconciliation run is stored yet",
    };
  }

  if (run.status === "SUCCESS") {
    return {
      status: "PASS",
      detail: `latest reconciliation status=${run.status} completed_at=${run.completedAt ?? "none"}`,
    };
  }

  const meta = tryParseReconciliationSummaryMeta(run.summaryJson);
  const blockingIssueCodes = meta.issueCodes.filter(isBlockingReconciliationIssueCode);
  const issueSummary = meta.issueCodes.length === 0 ? "none" : meta.issueCodes.join(",");
  if (blockingIssueCodes.length > 0) {
    return {
      status: "BLOCK",
      detail:
        `latest reconciliation status=${run.status} completed_at=${run.completedAt ?? "none"} ` +
        `blocking_issue_codes=${blockingIssueCodes.join(",")} issue_codes=${issueSummary}`,
    };
  }

  return {
    status: "WARN",
    detail:
      `latest reconciliation status=${run.status} completed_at=${run.completedAt ?? "none"} ` +
      `non_blocking_issue_codes=${issueSummary}`,
  };
}

function isBlockingReconciliationIssueCode(code: string): boolean {
  return [
    "BALANCE_DRIFT_DETECTED",
    "POSITION_DRIFT_DETECTED",
    "ORDER_MARKED_FOR_RECOVERY",
    "ORDER_REFERENCE_MISSING",
    "ORDER_LOOKUP_TRANSIENT_FAILURE",
    "ORDER_LOOKUP_DEFERRED",
    "ORDER_HISTORY_LOOKUP_FAILED",
  ].includes(code);
}

function formatOrderEventLines(events: OrderEventRecord[]): string[] {
  if (events.length === 0) {
    return ["events: none"];
  }

  return [
    "events:",
    ...events.map(
      (event) =>
        `- ${event.createdAt} | ${event.eventSource} | ${event.eventType} | payload=${summarizeJsonPayload(event.payloadJson)}`,
    ),
  ];
}

function formatFillLines(fills: FillRecord[]): string[] {
  if (fills.length === 0) {
    return ["fills: none"];
  }

  return [
    "fills:",
    ...fills.map(
      (fill) =>
        `- ${fill.filledAt} | ${fill.market} | ${fill.side} | price=${fill.price} | volume=${fill.volume} | fee=${fill.feeAmount ?? "none"} ${fill.feeCurrency ?? "none"} | exchange_fill_id=${fill.exchangeFillId}`,
    ),
  ];
}

function summarizeJsonPayload(rawJson: string): string {
  const normalized = rawJson.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 160) {
    return normalized || "{}";
  }

  return `${normalized.slice(0, 157)}...`;
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

export function formatStrategyRunMessage(result: TelegramStrategyRunResult): string {
  return [
    "Strategy Run",
    `status: ${result.status}`,
    `requested_at: ${result.requestedAt}`,
    `market: ${result.market ?? "none"}`,
    `strategy_decision_id: ${result.strategyDecisionId ?? "none"}`,
    `action: ${result.action ?? "none"}`,
    `submission_accepted: ${result.submissionAccepted === null ? "none" : result.submissionAccepted}`,
    `order_id: ${result.orderId ?? "none"}`,
    `order_status: ${result.orderStatus ?? "none"}`,
    `detail: ${result.detail}`,
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

export function formatStrategySchedulerRunsMessage(runs: StrategySchedulerRunRecord[]): string {
  if (runs.length === 0) {
    return [
      "Strategy Scheduler History",
      "count: 0",
      "state_source: persisted strategy_scheduler_runs",
      "note: No strategy scheduler runs are stored yet.",
      `operator_boundary: ${MANUAL_INPUT_NOTE}`,
    ].join("\n");
  }

  const sortedRuns = [...runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt));

  return [
    "Strategy Scheduler History",
    `count: ${sortedRuns.length}`,
    "state_source: persisted strategy_scheduler_runs",
    ...sortedRuns.map(
      (run) =>
        `- ${run.startedAt} | ${run.market} | ${run.status} | trigger=${run.triggerSource} | completed_at=${run.completedAt ?? "none"} | interval_ms=${run.intervalMs} | run_on_start=${run.runOnStart} | decision=${run.strategyDecisionId ?? "none"} | action=${run.action ?? "none"} | order=${run.orderId ?? "none"} | order_status=${run.orderStatus ?? "none"} | accepted=${run.submissionAccepted === null ? "none" : run.submissionAccepted} | error=${run.errorMessage ?? "none"} | detail=${run.detail ?? "none"}`,
    ),
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

export function formatTelegramInboundMessage(
  status: TelegramInboundPollingStatus | null,
  offset: TelegramInboundOffsetRecord | null,
): string {
  return [
    "Telegram Inbound",
    "state_source: runtime polling status + persisted telegram_inbound_offsets",
    `enabled: ${status?.enabled ?? "unknown"}`,
    `configured: ${status?.configured ?? "unknown"}`,
    `running: ${status?.running ?? "unknown"}`,
    `offset_storage: ${status?.offsetStorage ?? "unknown"}`,
    `offset_loaded: ${status?.offsetLoaded ?? "unknown"}`,
    `runtime_next_offset: ${status?.nextOffset ?? "none"}`,
    `runtime_last_update_id: ${status?.lastUpdateId ?? "none"}`,
    `poll_interval_ms: ${status?.pollIntervalMs ?? "unknown"}`,
    `long_poll_timeout_seconds: ${status?.longPollTimeoutSeconds ?? "unknown"}`,
    `poll_limit: ${status?.limit ?? "unknown"}`,
    `last_poll_at: ${status?.lastPollAt ?? "none"}`,
    `processed_count: ${status?.processedCount ?? "unknown"}`,
    `ignored_count: ${status?.ignoredCount ?? "unknown"}`,
    `failed_count: ${status?.failedCount ?? "unknown"}`,
    `last_error: ${status?.lastError ?? "none"}`,
    `persisted_offset_available: ${offset ? "true" : "false"}`,
    `persisted_bot_token_ref: ${offset?.botTokenRef ?? "none"}`,
    `persisted_next_offset: ${offset?.nextOffset ?? "none"}`,
    `persisted_last_update_id: ${offset?.lastUpdateId ?? "none"}`,
    `persisted_updated_at: ${offset?.updatedAt ?? "none"}`,
    `operator_boundary: ${MANUAL_INPUT_NOTE}`,
  ].join("\n");
}

function formatStrategySchedulerStatusLines(status: StrategySchedulerStatus | null): string[] {
  if (!status) {
    return [
      "strategy_scheduler_enabled: unknown",
      "strategy_scheduler_started: unknown",
      "strategy_scheduler_markets: none",
    ];
  }

  return [
    `strategy_scheduler_enabled: ${status.enabled}`,
    `strategy_scheduler_started: ${status.started}`,
    `strategy_scheduler_exchange_account_id: ${status.exchangeAccountId}`,
    `strategy_scheduler_live_send_path: ${status.liveSendPath}`,
    `strategy_scheduler_startup_preflight_status: ${status.startupPreflight?.status ?? "none"}`,
    `strategy_scheduler_startup_preflight_scope: ${status.startupPreflight?.scope ?? "none"}`,
    `strategy_scheduler_startup_preflight_detail: ${status.startupPreflight?.detail ?? "none"}`,
    ...formatStrategySchedulerPreflightCheckLines(status.startupPreflight?.checks ?? []),
    `strategy_scheduler_markets: ${status.markets.length}`,
    ...status.markets.map(
      (market) =>
        `- ${market.market} interval_ms=${market.intervalMs} running=${market.running} next_run_at=${market.nextRunAt ?? "none"} last_status=${market.lastStatus} run_count=${market.runCount} success=${market.successCount} failure=${market.failureCount} skipped=${market.skippedCount} last_started_at=${market.lastStartedAt ?? "none"} last_completed_at=${market.lastCompletedAt ?? "none"} last_decision=${market.lastStrategyDecisionId ?? "none"} last_action=${market.lastAction ?? "none"} last_order=${market.lastOrderId ?? "none"} last_order_status=${market.lastOrderStatus ?? "none"} last_error=${market.lastError ?? "none"}`,
    ),
  ];
}

function formatStrategySchedulerPreflightCheckLines(
  checks: NonNullable<StrategySchedulerStatus["startupPreflight"]>["checks"],
): string[] {
  if (checks.length === 0) {
    return ["strategy_scheduler_startup_preflight_checks: none"];
  }

  return [
    `strategy_scheduler_startup_preflight_checks: ${checks.length}`,
    ...checks.map((check) => `- ${check.name}: ${check.status} | ${check.detail}`),
  ];
}

function formatStrategySchedulerRunLines(runs: StrategySchedulerRunRecord[]): string[] {
  if (runs.length === 0) {
    return [
      "strategy_scheduler_recent_runs: none",
    ];
  }

  const sortedRuns = [...runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return [
    `strategy_scheduler_recent_runs: ${sortedRuns.length}`,
    ...sortedRuns.map(
      (run) =>
        `- ${run.startedAt} | ${run.market} | ${run.status} | completed_at=${run.completedAt ?? "none"} | interval_ms=${run.intervalMs} | run_on_start=${run.runOnStart} | decision=${run.strategyDecisionId ?? "none"} | action=${run.action ?? "none"} | order=${run.orderId ?? "none"} | order_status=${run.orderStatus ?? "none"} | accepted=${run.submissionAccepted === null ? "none" : run.submissionAccepted} | error=${run.errorMessage ?? "none"} | detail=${run.detail ?? "none"}`,
    ),
  ];
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
        `- ${market.market} | archive_window=${market.archivalWindowStartAt ?? "unknown"}..${market.archivalWindowEndAt ?? "unknown"} | next_window_end_at=${market.nextWindowEndAt ?? "unknown"} | archive_complete=${market.archiveComplete ?? "unknown"} | retention=${market.retentionStatus ?? "unknown"} | confidence=${market.confidenceLevel ?? "unknown"}:${market.confidenceReason ?? "unknown"} | truncated open/recent/archive=${market.openHistoryTruncated ?? "unknown"}/${market.recentClosedHistoryTruncated ?? "unknown"}/${market.archivalClosedHistoryTruncated ?? "unknown"} | pages open/recent/archive=${market.openPagesScanned ?? "?"}/${market.recentClosedPagesScanned ?? "?"}/${market.archivalClosedPagesScanned ?? "?"} | snapshots=${market.snapshotCount ?? "?"}`,
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

function formatOperatorNotificationDeliveryRunLines(
  runs: OperatorNotificationDeliveryRunRecord[],
): string[] {
  if (runs.length === 0) {
    return ["recent_delivery_runs: none"];
  }

  const sortedRuns = [...runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return [
    "recent_delivery_runs:",
    ...sortedRuns.map(
      (run) =>
        `- ${run.startedAt} | status=${run.status} | worker=${run.workerName} | attempted=${run.attemptedCount} | sent=${run.sentCount} | retry_scheduled=${run.retryScheduledCount} | failed=${run.failedCount} | stale_lease=${run.staleLeaseCount} | pending=${run.pendingTotalCount}/${run.pendingDueCount}/${run.pendingScheduledCount} | leases active/expired/abandoned=${run.activeLeaseCount}/${run.expiredLeaseCount}/${run.abandonedLeaseCandidateCount} | skipped=${run.skippedReason ?? "none"} | error=${run.errorMessage ?? "none"} | completed_at=${run.completedAt ?? "none"}`,
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
        retentionAssumptionDays: number | null;
        retentionBoundaryAt: string | null;
        retentionStatus: string | null;
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
          retentionStatus: string | null;
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
    retentionStatus: string | null;
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
          retentionAssumptionDays?: unknown;
          retentionBoundaryAt?: unknown;
          retentionStatus?: unknown;
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
          retentionAssumptionDays:
            typeof historyRecoveryRaw.retentionAssumptionDays === "number"
              ? historyRecoveryRaw.retentionAssumptionDays
              : null,
          retentionBoundaryAt:
            typeof historyRecoveryRaw.retentionBoundaryAt === "string"
              ? historyRecoveryRaw.retentionBoundaryAt
              : null,
          retentionStatus:
            typeof historyRecoveryRaw.retentionStatus === "string"
              ? historyRecoveryRaw.retentionStatus
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
                      retentionStatus:
                        "retentionStatus" in market && typeof market.retentionStatus === "string"
                          ? market.retentionStatus
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
        retentionAssumptionDays: number | null;
        retentionBoundaryAt: string | null;
        retentionStatus: string | null;
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
          retentionStatus: string | null;
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
      `${market.market}[archive=${market.archivalWindowStartAt ?? "unknown"}..${market.archivalWindowEndAt ?? "unknown"} next<=${market.nextWindowEndAt ?? "unknown"} complete=${market.archiveComplete ?? "unknown"} retention=${market.retentionStatus ?? "unknown"} confidence=${market.confidenceLevel ?? "unknown"}:${market.confidenceReason ?? "unknown"} truncated=${market.openHistoryTruncated ?? "unknown"}/${market.recentClosedHistoryTruncated ?? "unknown"}/${market.archivalClosedHistoryTruncated ?? "unknown"} pages=${market.openPagesScanned ?? "?"}/${market.recentClosedPagesScanned ?? "?"}/${market.archivalClosedPagesScanned ?? "?"} snapshots=${market.snapshotCount ?? "?"}]`,
  );

  return [
    `lookback_days=${historyRecovery.closedOrderLookbackDays ?? "unknown"}`,
    `stop_before_days=${historyRecovery.stopBeforeDays ?? "unknown"}`,
    `stop_before_at=${historyRecovery.stopBeforeAt ?? "unknown"}`,
    `retention_days=${historyRecovery.retentionAssumptionDays ?? "unknown"}`,
    `retention_boundary_at=${historyRecovery.retentionBoundaryAt ?? "unknown"}`,
    `retention=${historyRecovery.retentionStatus ?? "unknown"}`,
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
