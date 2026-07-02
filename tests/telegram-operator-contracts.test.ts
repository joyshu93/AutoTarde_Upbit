import assert from "node:assert/strict";

import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  OperatorNotificationRecord,
  OrderRecord,
  PositionSnapshotRecord,
} from "../src/domain/types.js";
import type { ExecutionRepository, OperatorStateStore } from "../src/modules/db/interfaces.js";
import { TelegramCommandRouter } from "../src/modules/telegram/commands.js";
import {
  buildUnsupportedCommandMessage,
  buildUsageMessage,
  listTelegramCommandContracts,
  parseTelegramCommand,
  validateTelegramCommand,
} from "../src/modules/telegram/contracts.js";
import {
  formatBalanceMessage,
  formatHelpMessage,
  formatOperatorNotificationsMessage,
  formatOrderDetailMessage,
  formatPositionMessage,
  formatReadinessMessage,
  formatReconciliationRunsMessage,
  formatRiskEventsMessage,
  formatRuntimeConfigMessage,
  formatStrategySchedulerRunsMessage,
  formatStrategyPreviewMessage,
  formatTelegramInboundMessage,
} from "../src/modules/telegram/formatter.js";
import type { TelegramSyncResult } from "../src/modules/telegram/interfaces.js";
import { test } from "./harness.js";

test("parseTelegramCommand normalizes bot mentions and preserves arguments", () => {
  const helpParsed = parseTelegramCommand("/HELP@autotrade_upbit_bot");
  const configParsed = parseTelegramCommand("/CONFIG@autotrade_upbit_bot");
  const readinessParsed = parseTelegramCommand("/READINESS@autotrade_upbit_bot");
  const parsed = parseTelegramCommand("/STATUS@autotrade_upbit_bot");
  const historyParsed = parseTelegramCommand("/STATEHISTORY@autotrade_upbit_bot");
  const syncHistoryParsed = parseTelegramCommand("/SYNCHISTORY@autotrade_upbit_bot");
  const recoveryParsed = parseTelegramCommand("/RECOVERY@autotrade_upbit_bot");
  const alertsParsed = parseTelegramCommand("/ALERTS@autotrade_upbit_bot");
  const risksParsed = parseTelegramCommand("/RISKS@autotrade_upbit_bot");
  const schedulerParsed = parseTelegramCommand("/SCHEDULER@autotrade_upbit_bot");
  const inboundParsed = parseTelegramCommand("/INBOUND@autotrade_upbit_bot");
  const orderParsed = parseTelegramCommand("/ORDER@autotrade_upbit_bot order-1");
  const previewParsed = parseTelegramCommand("/PREVIEW@autotrade_upbit_bot BTC");
  const runParsed = parseTelegramCommand("/RUN@autotrade_upbit_bot BTC");

  assert.ok(helpParsed);
  assert.equal(helpParsed.command, "/help");
  assert.deepEqual(helpParsed.args, []);
  assert.equal(helpParsed.contract.summary, "Show supported Telegram operator commands and safety boundaries.");
  assert.ok(configParsed);
  assert.equal(configParsed.command, "/config");
  assert.deepEqual(configParsed.args, []);
  assert.equal(configParsed.contract.summary, "Show non-secret runtime configuration, safety gates, and explicit risk limits.");
  assert.ok(readinessParsed);
  assert.equal(readinessParsed.command, "/readiness");
  assert.deepEqual(readinessParsed.args, []);
  assert.equal(readinessParsed.contract.summary, "Show read-only operator readiness checks for DRY_RUN operations.");
  assert.ok(parsed);
  assert.equal(parsed.command, "/status");
  assert.deepEqual(parsed.args, []);
  assert.equal(parsed.contract.summary, "Show persisted execution_state, live-order blockers, and operator control state.");
  assert.ok(historyParsed);
  assert.equal(historyParsed.command, "/statehistory");
  assert.equal(historyParsed.contract.summary, "Show recent persisted execution_state transition history.");
  assert.ok(syncHistoryParsed);
  assert.equal(syncHistoryParsed.command, "/synchistory");
  assert.equal(syncHistoryParsed.contract.summary, "Show recent persisted reconciliation_runs for operator inspection.");
  assert.ok(recoveryParsed);
  assert.equal(recoveryParsed.command, "/recovery");
  assert.equal(recoveryParsed.contract.summary, "Show checkpointed exchange-history recovery progress for operator inspection.");
  assert.ok(alertsParsed);
  assert.equal(alertsParsed.command, "/alerts");
  assert.equal(alertsParsed.contract.summary, "Show recent persisted operator_notifications, delivery attempts, retry schedule, and Telegram delivery states.");
  assert.ok(risksParsed);
  assert.equal(risksParsed.command, "/risks");
  assert.equal(risksParsed.contract.summary, "Show recent persisted risk_events for operator inspection.");
  assert.ok(schedulerParsed);
  assert.equal(schedulerParsed.command, "/scheduler");
  assert.equal(
    schedulerParsed.contract.summary,
    "Show runtime scheduler status and recent persisted strategy_scheduler_runs for operator inspection.",
  );
  assert.ok(inboundParsed);
  assert.equal(inboundParsed.command, "/inbound");
  assert.equal(inboundParsed.contract.summary, "Show Telegram inbound polling status and persisted update offset.");
  assert.ok(orderParsed);
  assert.equal(orderParsed.command, "/order");
  assert.deepEqual(orderParsed.args, ["order-1"]);
  assert.equal(orderParsed.contract.summary, "Show one persisted order with lifecycle events and fills.");
  assert.ok(previewParsed);
  assert.equal(previewParsed.command, "/preview");
  assert.deepEqual(previewParsed.args, ["BTC"]);
  assert.equal(
    previewParsed.contract.summary,
    "Preview one deterministic PositionGuard strategy decision and order intent without persistence or order submission.",
  );
  assert.ok(runParsed);
  assert.equal(runParsed.command, "/run");
  assert.deepEqual(runParsed.args, ["BTC"]);
  assert.equal(runParsed.contract.summary, "Run one deterministic PositionGuard strategy cycle for a supported asset through the safe execution path.");
});

test("manual input commands are rejected by the operator contract", () => {
  const message = buildUnsupportedCommandMessage("/setposition BTC 0.25 95000000");

  assert.match(message, /Manual cash and position input is not supported in Telegram\./);
  assert.match(message, /\/help \/config \/readiness \/status \/statehistory \/synchistory \/recovery \/alerts \/risks \/balances \/positions \/orders \/order \/scheduler \/inbound \/pause \/resume \/killswitch \/sync \/preview \/run/);
});

test("no-argument commands return usage guidance when extra arguments are supplied", () => {
  const helpParsed = parseTelegramCommand("/help now");
  const configParsed = parseTelegramCommand("/config now");
  const readinessParsed = parseTelegramCommand("/readiness now");
  const parsed = parseTelegramCommand("/resume now");
  const historyParsed = parseTelegramCommand("/statehistory now");
  const syncHistoryParsed = parseTelegramCommand("/synchistory now");
  const recoveryParsed = parseTelegramCommand("/recovery now");
  const alertsParsed = parseTelegramCommand("/alerts now");
  const risksParsed = parseTelegramCommand("/risks now");
  const schedulerParsed = parseTelegramCommand("/scheduler now");
  const inboundParsed = parseTelegramCommand("/inbound now");
  const missingOrderParsed = parseTelegramCommand("/order");
  const extraOrderParsed = parseTelegramCommand("/order order-1 now");
  const missingPreviewAssetParsed = parseTelegramCommand("/preview");
  const unsupportedPreviewAssetParsed = parseTelegramCommand("/preview DOGE");
  const extraPreviewArgParsed = parseTelegramCommand("/preview BTC now");
  const missingRunAssetParsed = parseTelegramCommand("/run");
  const unsupportedRunAssetParsed = parseTelegramCommand("/run DOGE");
  const extraRunArgParsed = parseTelegramCommand("/run BTC now");

  assert.ok(helpParsed);
  assert.equal(
    validateTelegramCommand(helpParsed),
    buildUsageMessage("/help"),
  );
  assert.ok(configParsed);
  assert.equal(
    validateTelegramCommand(configParsed),
    buildUsageMessage("/config"),
  );
  assert.ok(readinessParsed);
  assert.equal(
    validateTelegramCommand(readinessParsed),
    buildUsageMessage("/readiness"),
  );
  assert.ok(parsed);
  assert.equal(
    validateTelegramCommand(parsed),
    buildUsageMessage("/resume"),
  );
  assert.ok(historyParsed);
  assert.equal(
    validateTelegramCommand(historyParsed),
    buildUsageMessage("/statehistory"),
  );
  assert.ok(syncHistoryParsed);
  assert.equal(
    validateTelegramCommand(syncHistoryParsed),
    buildUsageMessage("/synchistory"),
  );
  assert.ok(recoveryParsed);
  assert.equal(
    validateTelegramCommand(recoveryParsed),
    buildUsageMessage("/recovery"),
  );
  assert.ok(alertsParsed);
  assert.equal(
    validateTelegramCommand(alertsParsed),
    buildUsageMessage("/alerts"),
  );
  assert.ok(risksParsed);
  assert.equal(
    validateTelegramCommand(risksParsed),
    buildUsageMessage("/risks"),
  );
  assert.ok(schedulerParsed);
  assert.equal(
    validateTelegramCommand(schedulerParsed),
    buildUsageMessage("/scheduler"),
  );
  assert.ok(inboundParsed);
  assert.equal(
    validateTelegramCommand(inboundParsed),
    buildUsageMessage("/inbound"),
  );
  assert.ok(missingOrderParsed);
  assert.equal(
    validateTelegramCommand(missingOrderParsed),
    buildUsageMessage("/order"),
  );
  assert.ok(extraOrderParsed);
  assert.equal(
    validateTelegramCommand(extraOrderParsed),
    buildUsageMessage("/order"),
  );
  assert.ok(missingPreviewAssetParsed);
  assert.equal(
    validateTelegramCommand(missingPreviewAssetParsed),
    buildUsageMessage("/preview"),
  );
  assert.ok(unsupportedPreviewAssetParsed);
  assert.equal(
    validateTelegramCommand(unsupportedPreviewAssetParsed),
    buildUsageMessage("/preview"),
  );
  assert.ok(extraPreviewArgParsed);
  assert.equal(
    validateTelegramCommand(extraPreviewArgParsed),
    buildUsageMessage("/preview"),
  );
  assert.ok(missingRunAssetParsed);
  assert.equal(
    validateTelegramCommand(missingRunAssetParsed),
    buildUsageMessage("/run"),
  );
  assert.ok(unsupportedRunAssetParsed);
  assert.equal(
    validateTelegramCommand(unsupportedRunAssetParsed),
    buildUsageMessage("/run"),
  );
  assert.ok(extraRunArgParsed);
  assert.equal(
    validateTelegramCommand(extraRunArgParsed),
    buildUsageMessage("/run"),
  );
});

test("formatters expose stored snapshots, risk events, and keep Telegram manual input out of scope", () => {
  const balanceSnapshot: BalanceSnapshotRecord = {
    id: "balance-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "1250000",
    balancesJson: JSON.stringify([
      {
        currency: "KRW",
        balance: "250000",
        locked: "0",
        avgBuyPrice: "0",
        unitCurrency: "KRW",
      },
      {
        currency: "BTC",
        balance: "0.01000000",
        locked: "0",
        avgBuyPrice: "100000000",
        unitCurrency: "KRW",
      },
    ]),
  };
  const positionSnapshot: PositionSnapshotRecord = {
    id: "position-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:05:00.000Z",
    source: "RECONCILIATION",
    positionsJson: JSON.stringify([
      {
        asset: "BTC",
        market: "KRW-BTC",
        quantity: "0.01000000",
        averageEntryPrice: "100000000",
        markPrice: "101000000",
        marketValue: "1010000",
        exposureRatio: "0.80",
        capturedAt: "2026-04-20T00:05:00.000Z",
      },
    ]),
  };

  const balancesMessage = formatBalanceMessage(balanceSnapshot);
  const positionsMessage = formatPositionMessage(positionSnapshot);
  const notificationsMessage = formatOperatorNotificationsMessage([
    createNotification({
      id: "notification-1",
      notificationType: "RECONCILIATION_DRIFT_DETECTED",
      title: "Reconciliation drift detected",
      message: "Detected 2 reconciliation issue(s).",
      payloadJson: JSON.stringify({
        issueCount: 2,
      }),
      createdAt: "2026-04-20T00:06:30.000Z",
    }),
  ], [
    {
      id: "attempt-1",
      notificationId: "notification-1",
      exchangeAccountId: "primary",
      attemptCount: 1,
      leaseToken: "lease-1",
      outcome: "RETRY_SCHEDULED",
      failureClass: "RETRYABLE",
      attemptedAt: "2026-04-20T00:06:35.000Z",
      nextAttemptAt: "2026-04-20T00:07:35.000Z",
      deliveredAt: null,
      errorMessage: "telegram_http_500",
      createdAt: "2026-04-20T00:06:35.000Z",
    },
  ]);
  const reconciliationRunsMessage = formatReconciliationRunsMessage([
    {
      id: "recon-run-1",
      exchangeAccountId: "primary",
      status: "SUCCESS",
      startedAt: "2026-04-20T00:07:00.000Z",
      completedAt: "2026-04-20T00:07:02.000Z",
      summaryJson: JSON.stringify({
        source: "OPERATOR_SYNC",
        status: "SUCCESS",
        issues: [],
        processedCount: 1,
        deferredCount: 0,
      }),
      errorMessage: null,
    },
  ]);
  const emptySchedulerRunsMessage = formatStrategySchedulerRunsMessage([]);
  const schedulerRunsMessage = formatStrategySchedulerRunsMessage([
    {
      id: "strategy-scheduler-run-1",
      exchangeAccountId: "primary",
      market: "KRW-BTC",
      triggerSource: "SCHEDULER",
      status: "SKIPPED",
      startedAt: "2026-04-20T00:08:00.000Z",
      completedAt: "2026-04-20T00:08:00.000Z",
      intervalMs: 1_800_000,
      runOnStart: true,
      strategyDecisionId: null,
      action: null,
      orderId: null,
      orderStatus: null,
      submissionAccepted: null,
      detail: "Previous run still active.",
      errorMessage: null,
      summaryJson: JSON.stringify({ status: "SKIPPED" }),
    },
  ]);
  const telegramInboundMessage = formatTelegramInboundMessage({
    enabled: true,
    configured: true,
    running: false,
    nextOffset: 77,
    pollIntervalMs: 2_000,
    longPollTimeoutSeconds: 25,
    limit: 10,
    lastPollAt: "2026-04-20T00:09:00.000Z",
    lastUpdateId: 76,
    offsetLoaded: true,
    offsetStorage: "DURABLE",
    processedCount: 4,
    ignoredCount: 2,
    failedCount: 1,
    lastError: "telegram_http_500",
  }, {
    id: "telegram-inbound-offset-1",
    exchangeAccountId: "primary",
    updateSource: "GET_UPDATES",
    botTokenRef: "sha256:bot-a",
    nextOffset: 77,
    lastUpdateId: 76,
    updatedAt: "2026-04-20T00:09:01.000Z",
  });
  const orderDetailMessage = formatOrderDetailMessage(createOrder({
    id: "order-1",
    status: "FAILED",
    failureCode: "order_submission_failed",
    failureMessage: "telegram-inspectable failure",
  }), [
    {
      id: "order-event-1",
      orderId: "order-1",
      eventType: "ORDER_SUBMISSION_FAILED",
      eventSource: "LOCAL",
      payloadJson: JSON.stringify({ failure: true }),
      createdAt: "2026-04-20T00:09:30.000Z",
    },
  ], [], "order-identifier");
  const helpMessage = formatHelpMessage(listTelegramCommandContracts());
  const runtimeConfigMessage = formatRuntimeConfigMessage({
    serviceName: "AutoTrade_Upbit",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    liveSendPath: "DRY_RUN_ADAPTER",
    upbitBaseUrl: "https://api.upbit.com",
    databasePath: "./var/autotrade-upbit.sqlite",
    exchangeBackedReadEnabled: false,
    telegramDeliveryEnabled: false,
    telegramBotTokenConfigured: false,
    telegramOperatorChatIdConfigured: false,
    telegramDeliveryMaxAttempts: 5,
    telegramDeliveryBaseBackoffMs: 15_000,
    telegramDeliveryMaxBackoffMs: 300_000,
    telegramDeliveryLeaseMs: 30_000,
    telegramInboundPollingEnabled: false,
    telegramInboundPollIntervalMs: 2_000,
    telegramInboundPollTimeoutSeconds: 25,
    telegramInboundPollLimit: 10,
    deprecatedIgnoredEnvVars: ["MAX_LIVE_ORDER_VALUE_KRW"],
    strategySchedulerEnabled: false,
    strategySchedulerRunOnStart: false,
    strategySchedulerBtcIntervalMs: 3_600_000,
    strategySchedulerEthIntervalMs: 3_600_000,
    reconciliationMaxOrderLookupsPerRun: 10,
    reconciliationHistoryMaxPagesPerMarket: 3,
    reconciliationClosedOrderLookbackDays: 7,
    reconciliationHistoryStopBeforeDays: 365,
    reconciliationHistoryRetentionAssumptionDays: 365,
    stalePriceThresholdMs: 30_000,
    minimumOrderValueKrw: 5_000,
    maxAllocationByAsset: {
      BTC: 0.6,
      ETH: 0.6,
    },
    totalExposureCap: 0.75,
  });
  const readinessMessage = formatReadinessMessage({
    runtimeConfig: null,
    executionState: createExecutionState({
      systemStatus: "PAUSED",
      pauseReason: "maintenance",
    }),
    latestBalanceSnapshot: null,
    latestPositionSnapshot: null,
    latestReconciliationRun: null,
    activeOrders: [],
    recentRiskEvents: [],
    pendingNotifications: [],
    schedulerStatus: null,
    inboundStatus: null,
  });
  const risksMessage = formatRiskEventsMessage([
    {
      id: "risk-event-1",
      exchangeAccountId: "primary",
      strategyDecisionId: "decision-1",
      orderId: null,
      level: "BLOCK",
      ruleCode: "MINIMUM_ORDER_VALUE_GUARD",
      message: "Requested order value is below the configured minimum.",
      payloadJson: "{}",
      createdAt: "2026-04-20T00:10:00.000Z",
    },
  ]);
  const strategyPreviewMessage = formatStrategyPreviewMessage({
    status: "COMPLETED",
    requestedAt: "2026-04-20T00:11:00.000Z",
    market: "KRW-BTC",
    action: "ENTER",
    executionDisposition: "READY",
    referencePrice: 100_000_000,
    requestedNotionalKrw: 150_000,
    requestedQuantity: null,
    orderSide: "bid",
    orderType: "price",
    orderPrice: "150000",
    orderVolume: null,
    detail: "Decision ENTER computed; order intent bid price would require /run to persist and submit through the configured path.",
  });

  assert.match(balancesMessage, /Balances Snapshot/);
  assert.match(balancesMessage, /- BTC free=0\.01000000 locked=0 avg_buy_price=100000000 KRW/);
  assert.match(balancesMessage, /operator_boundary: Telegram does not accept manual cash or position input\./);

  assert.match(positionsMessage, /Positions Snapshot/);
  assert.match(positionsMessage, /- KRW-BTC qty=0\.01000000 avg=100000000 mark=101000000 value=1010000 exposure=0\.80/);
  assert.match(positionsMessage, /operator_boundary: Telegram does not accept manual cash or position input\./);

  assert.match(notificationsMessage, /Operator Alerts/);
  assert.match(notificationsMessage, /state_source: persisted operator_notifications/);
  assert.match(notificationsMessage, /attempt_source: persisted operator_notification_delivery_attempts/);
  assert.match(notificationsMessage, /\| WARN \| RECONCILIATION_DRIFT_DETECTED \| PENDING \| attempts=0 \| last_attempt_at=none \| next_attempt_at=none \| failure_class=none \| delivered_at=none \| error=none \| Reconciliation drift detected \| Detected 2 reconciliation issue\(s\)\./);
  assert.match(notificationsMessage, /delivery_attempt_count: 1/);
  assert.match(notificationsMessage, /\| notification_id=notification-1 \| attempt=1 \| outcome=RETRY_SCHEDULED \| failure_class=RETRYABLE \| next_attempt_at=2026-04-20T00:07:35.000Z \| delivered_at=none \| error=telegram_http_500/);

  assert.match(reconciliationRunsMessage, /Reconciliation History/);
  assert.match(reconciliationRunsMessage, /state_source: persisted reconciliation_runs/);
  assert.match(reconciliationRunsMessage, /\| SUCCESS \| source=OPERATOR_SYNC \| issues=0 \| codes=none \| processed=1 \| deferred=0 \| history=none \| completed_at=2026-04-20T00:07:02.000Z \| error=none/);

  assert.match(emptySchedulerRunsMessage, /Strategy Scheduler History/);
  assert.match(emptySchedulerRunsMessage, /count: 0/);
  assert.match(emptySchedulerRunsMessage, /state_source: runtime scheduler status \+ persisted strategy_scheduler_runs/);
  assert.match(emptySchedulerRunsMessage, /runtime_status_source: unavailable/);
  assert.match(emptySchedulerRunsMessage, /note: No strategy scheduler runs are stored yet\./);

  assert.match(schedulerRunsMessage, /Strategy Scheduler History/);
  assert.match(schedulerRunsMessage, /count: 1/);
  assert.match(schedulerRunsMessage, /runtime_enabled: unknown/);
  assert.match(schedulerRunsMessage, /runtime_startup_preflight_checks: none/);
  assert.match(schedulerRunsMessage, /\| KRW-BTC \| SKIPPED \| trigger=SCHEDULER \| completed_at=2026-04-20T00:08:00.000Z \| interval_ms=1800000 \| run_on_start=true \| decision=none \| action=none \| order=none \| order_status=none \| accepted=none \| error=none \| detail=Previous run still active\./);

  assert.match(telegramInboundMessage, /Telegram Inbound/);
  assert.match(telegramInboundMessage, /state_source: runtime polling status \+ persisted telegram_inbound_offsets/);
  assert.match(telegramInboundMessage, /offset_storage: DURABLE/);
  assert.match(telegramInboundMessage, /runtime_next_offset: 77/);
  assert.match(telegramInboundMessage, /failed_count: 1/);
  assert.match(telegramInboundMessage, /last_error: telegram_http_500/);
  assert.match(telegramInboundMessage, /persisted_bot_token_ref: sha256:bot-a/);
  assert.match(telegramInboundMessage, /persisted_next_offset: 77/);

  assert.match(orderDetailMessage, /Order Detail/);
  assert.match(orderDetailMessage, /state_source: persisted orders \+ order_events \+ fills/);
  assert.match(orderDetailMessage, /status: FAILED/);
  assert.match(orderDetailMessage, /failure_code: order_submission_failed/);
  assert.match(orderDetailMessage, /failure_message: telegram-inspectable failure/);
  assert.match(orderDetailMessage, /event_count: 1/);
  assert.match(orderDetailMessage, /\| LOCAL \| ORDER_SUBMISSION_FAILED \| payload=\{"failure":true\}/);
  assert.match(orderDetailMessage, /fill_count: 0/);
  assert.match(orderDetailMessage, /fills: none/);

  assert.match(helpMessage, /Operator Help/);
  assert.match(helpMessage, /state_source: static telegram command contracts/);
  assert.match(helpMessage, /- \/help \| \/help \| Show supported Telegram operator commands and safety boundaries\./);
  assert.match(helpMessage, /- \/sync \| \/sync \| Request a reconciliation sync through the operator control plane\./);
  assert.match(helpMessage, /read_only_boundary: \/help never triggers sync, strategy runs, scheduler ticks, exchange reads, order mutation, or live order transmission\./);
  assert.match(helpMessage, /operator_boundary: Telegram does not accept manual cash or position input\./);

  assert.match(runtimeConfigMessage, /Runtime Config/);
  assert.match(runtimeConfigMessage, /state_source: runtime app configuration/);
  assert.match(runtimeConfigMessage, /telegram_bot_token_configured: false/);
  assert.match(runtimeConfigMessage, /telegram_operator_chat_id_configured: false/);
  assert.match(runtimeConfigMessage, /config_live_blockers: DRY_RUN,LIVE_GATE_DISABLED,DRY_RUN_ADAPTER/);
  assert.match(runtimeConfigMessage, /deprecated_ignored_env_vars: MAX_LIVE_ORDER_VALUE_KRW/);
  assert.match(runtimeConfigMessage, /secret_boundary: secret values are never rendered/);

  assert.match(readinessMessage, /Operator Readiness/);
  assert.match(readinessMessage, /overall_status: BLOCK/);
  assert.match(readinessMessage, /- runtime_config: BLOCK \| runtime configuration was not supplied/);
  assert.match(readinessMessage, /- execution_state: BLOCK \| current blockers: DRY_RUN,LIVE_GATE_DISABLED,PAUSED,DRY_RUN_ADAPTER/);
  assert.match(readinessMessage, /read_only_boundary: \/readiness never triggers sync, Telegram polling, strategy runs, scheduler ticks, exchange reads, order mutation, or live order transmission\./);
  assert.match(readinessMessage, /secret_boundary: secret values are never rendered/);

  assert.match(risksMessage, /Risk Events/);
  assert.match(risksMessage, /count: 1/);
  assert.match(risksMessage, /state_source: persisted risk_events/);
  assert.match(risksMessage, /MINIMUM_ORDER_VALUE_GUARD/);

  assert.match(strategyPreviewMessage, /Strategy Preview/);
  assert.match(strategyPreviewMessage, /action: ENTER/);
  assert.match(strategyPreviewMessage, /order_side: bid/);
  assert.match(strategyPreviewMessage, /no_mutation_boundary: \/preview never persists strategy decisions, creates orders, sends orders, or triggers reconciliation\./);
});

test("router applies control commands, blocks invalid arguments, and advertises sync wiring state", async () => {
  const stateTransitions: string[] = [];
  const historyRequests: number[] = [];
  const alertRequests: number[] = [];
  const reconciliationRequests: number[] = [];
  const schedulerRequests: number[] = [];
  let inboundOffsetRequests = 0;
  const recoveryCheckpointRequests: string[] = [];
  let currentState = createExecutionState({
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const operatorState: OperatorStateStore = {
    async getState() {
      return currentState;
    },
    async listTransitions(limit) {
      historyRequests.push(limit ?? -1);
      return [
        {
          id: "transition-1",
          exchangeAccountId: "primary",
          command: "BOOTSTRAP",
          fromExecutionMode: null,
          toExecutionMode: "DRY_RUN",
          fromLiveExecutionGate: null,
          toLiveExecutionGate: "DISABLED",
          fromSystemStatus: null,
          toSystemStatus: "RUNNING",
          fromKillSwitchActive: null,
          toKillSwitchActive: false,
          reason: "bootstrap_seed",
          createdAt: "2026-04-20T00:00:00.000Z",
        },
      ];
    },
    async pause(reason) {
      stateTransitions.push(`pause:${reason ?? "none"}`);
      currentState = createExecutionState({
        systemStatus: "PAUSED",
        killSwitchActive: false,
        pauseReason: reason ?? "paused_by_operator",
        updatedAt: "2026-04-20T00:01:00.000Z",
      });
      return currentState;
    },
    async resume() {
      stateTransitions.push("resume");
      currentState = createExecutionState({
        systemStatus: "RUNNING",
        killSwitchActive: false,
        pauseReason: null,
        updatedAt: "2026-04-20T00:02:00.000Z",
      });
      return currentState;
    },
    async activateKillSwitch(reason) {
      stateTransitions.push(`killswitch:${reason ?? "none"}`);
      currentState = createExecutionState({
        systemStatus: "KILL_SWITCHED",
        killSwitchActive: true,
        pauseReason: reason ?? "killswitch_activated",
        updatedAt: "2026-04-20T00:03:00.000Z",
      });
      return currentState;
    },
    async setExecutionMode(mode) {
      stateTransitions.push(`mode:${mode}`);
      currentState = createExecutionState({
        executionMode: mode,
        updatedAt: "2026-04-20T00:03:30.000Z",
      });
      return currentState;
    },
    async setLiveExecutionGate(gate) {
      stateTransitions.push(`live_gate:${gate}`);
      currentState = createExecutionState({
        liveExecutionGate: gate,
        updatedAt: "2026-04-20T00:03:45.000Z",
      });
      return currentState;
    },
    async markDegraded(reason) {
      stateTransitions.push(`degraded:${reason ?? "none"}`);
      currentState = createExecutionState({
        systemStatus: "DEGRADED",
        degradedReason: reason ?? "startup_portfolio_drift_detected",
        degradedAt: "2026-04-20T00:03:50.000Z",
        updatedAt: "2026-04-20T00:03:50.000Z",
      });
      return currentState;
    },
    async clearDegraded(reason) {
      stateTransitions.push(`clear_degraded:${reason ?? "none"}`);
      currentState = createExecutionState({
        systemStatus: "RUNNING",
        degradedReason: null,
        degradedAt: null,
        updatedAt: "2026-04-20T00:03:55.000Z",
      });
      return currentState;
    },
  };

  const router = new TelegramCommandRouter({
    operatorState,
    repositories: createRepositoryStub({
      async listOperatorNotifications(_exchangeAccountId, limit) {
        alertRequests.push(limit ?? -1);
        return [
          {
            ...createNotification({
              id: "notification-1",
              notificationType: "RECONCILIATION_DRIFT_DETECTED",
              title: "Reconciliation drift detected",
              message: "Detected 1 reconciliation issue(s).",
              payloadJson: JSON.stringify({
                issueCount: 1,
              }),
              createdAt: "2026-04-20T00:03:40.000Z",
            }),
          },
        ];
      },
      async listOperatorNotificationDeliveryAttempts(_exchangeAccountId, limit) {
        alertRequests.push((limit ?? -1) * 100);
        return [
          {
            id: "attempt-1",
            notificationId: "notification-1",
            exchangeAccountId: "primary",
            attemptCount: 1,
            leaseToken: "lease-1",
            outcome: "RETRY_SCHEDULED",
            failureClass: "RETRYABLE",
            attemptedAt: "2026-04-20T00:03:41.000Z",
            nextAttemptAt: "2026-04-20T00:04:41.000Z",
            deliveredAt: null,
            errorMessage: "telegram_http_500",
            createdAt: "2026-04-20T00:03:41.000Z",
          },
        ];
      },
      async listReconciliationRuns(_exchangeAccountId, limit) {
        reconciliationRequests.push(limit ?? -1);
        return [
          {
            id: "recon-run-1",
            exchangeAccountId: "primary",
            status: "SUCCESS",
            startedAt: "2026-04-20T00:03:50.000Z",
            completedAt: "2026-04-20T00:03:55.000Z",
          summaryJson: JSON.stringify({
            source: "OPERATOR_SYNC",
            status: "SUCCESS",
            issues: [],
            processedCount: 1,
            deferredCount: 0,
          }),
            errorMessage: null,
          },
        ];
      },
      async listStrategySchedulerRuns(_exchangeAccountId, limit) {
        schedulerRequests.push(limit ?? -1);
        return [
          {
            id: "strategy-scheduler-run-1",
            exchangeAccountId: "primary",
            market: "KRW-BTC",
            triggerSource: "SCHEDULER",
            status: "COMPLETED",
            startedAt: "2026-04-20T00:03:20.000Z",
            completedAt: "2026-04-20T00:03:22.000Z",
            intervalMs: 1_800_000,
            runOnStart: false,
            strategyDecisionId: "strategy-decision-1",
            action: "HOLD",
            orderId: null,
            orderStatus: null,
            submissionAccepted: null,
            detail: "Decision HOLD persisted; no order submission was requested.",
            errorMessage: null,
            summaryJson: JSON.stringify({ status: "COMPLETED" }),
          },
        ];
      },
      async listHistoryRecoveryCheckpoints(exchangeAccountId) {
        recoveryCheckpointRequests.push(exchangeAccountId);
        return [
          {
            id: "checkpoint-1",
            exchangeAccountId,
            market: "KRW-BTC",
            checkpointType: "CLOSED_ORDER_ARCHIVE",
            nextWindowEndAt: "2026-04-06T00:03:55.000Z",
            updatedAt: "2026-04-20T00:03:55.000Z",
          },
        ];
      },
      async listOperatorNotificationDeliveryRuns(_exchangeAccountId, limit) {
        alertRequests.push((limit ?? -1) * 1000);
        return [
          {
            id: "delivery-run-1",
            exchangeAccountId: "primary",
            workerName: "telegram_delivery_inline_worker",
            status: "COMPLETED",
            startedAt: "2026-04-20T00:03:41.000Z",
            completedAt: "2026-04-20T00:03:42.000Z",
            attemptedCount: 1,
            sentCount: 0,
            retryScheduledCount: 1,
            failedCount: 0,
            staleLeaseCount: 0,
            pendingTotalCount: 1,
            pendingDueCount: 0,
            pendingScheduledCount: 1,
            activeLeaseCount: 0,
            expiredLeaseCount: 0,
            abandonedLeaseCandidateCount: 0,
            skippedReason: null,
            errorMessage: null,
            summaryJson: "{}",
          },
        ];
      },
    }),
    executionStateSeed: {
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      killSwitchActive: false,
    },
    liveSendPath: "DRY_RUN_ADAPTER",
    telegramInboundStatus: () => ({
      enabled: true,
      configured: true,
      running: false,
      nextOffset: 88,
      pollIntervalMs: 2_000,
      longPollTimeoutSeconds: 25,
      limit: 10,
      lastPollAt: "2026-04-20T00:03:45.000Z",
      lastUpdateId: 87,
      offsetLoaded: true,
      offsetStorage: "DURABLE",
      processedCount: 2,
      ignoredCount: 1,
      failedCount: 0,
      lastError: null,
    }),
    telegramInboundBotTokenRef: "sha256:bot-a",
    telegramInboundOffsetStore: {
      async getTelegramInboundOffset() {
        inboundOffsetRequests += 1;
        return {
          id: "telegram-inbound-offset-1",
          exchangeAccountId: "primary",
          updateSource: "GET_UPDATES",
          botTokenRef: "sha256:bot-a",
          nextOffset: 88,
          lastUpdateId: 87,
          updatedAt: "2026-04-20T00:03:45.000Z",
        };
      },
      async saveTelegramInboundOffset() {
        throw new Error("inbound inspection must not mutate offset state");
      },
    },
    now: () => "2026-04-20T00:04:00.000Z",
  });

  const statusResponse = await router.route("/status");
  const historyResponse = await router.route("/statehistory");
  const syncHistoryResponse = await router.route("/synchistory");
  const recoveryResponse = await router.route("/recovery");
  const alertsResponse = await router.route("/alerts");
  const risksResponse = await router.route("/risks");
  const schedulerResponse = await router.route("/scheduler");
  const inboundResponse = await router.route("/inbound");
  const pauseResponse = await router.route("/pause maintenance window");
  const invalidResumeResponse = await router.route("/resume now");
  const invalidHistoryResponse = await router.route("/statehistory now");
  const invalidSyncHistoryResponse = await router.route("/synchistory now");
  const invalidRecoveryResponse = await router.route("/recovery now");
  const invalidAlertsResponse = await router.route("/alerts now");
  const invalidRisksResponse = await router.route("/risks now");
  const unsupportedInputResponse = await router.route("/setcash 100000");
  const syncResponse = await router.route("/sync");
  const invalidPreviewResponse = await router.route("/preview ETH now");
  const invalidRunResponse = await router.route("/run ETH now");

  assert.match(statusResponse.text, /exchange_account_id: primary/);
  assert.match(statusResponse.text, /state_source: persisted execution_state/);
  assert.match(statusResponse.text, /live_orders_allowed: false/);
  assert.match(statusResponse.text, /blocked_by: DRY_RUN,LIVE_GATE_DISABLED,DRY_RUN_ADAPTER/);
  assert.match(statusResponse.text, /seed_mismatches: none/);
  assert.match(statusResponse.text, /recent_sync_source: OPERATOR_SYNC/);
  assert.match(statusResponse.text, /recent_sync_status: SUCCESS/);
  assert.match(statusResponse.text, /recent_sync_issues: 0/);
  assert.match(statusResponse.text, /recent_sync_issue_codes: none/);
  assert.match(statusResponse.text, /recent_sync_history_coverage_status: none/);
  assert.match(statusResponse.text, /recent_sync_history_confidence: none/);
  assert.match(statusResponse.text, /recent_sync_history_recovered_orders: none/);
  assert.match(statusResponse.text, /recent_sync_history_scanned_snapshots: none/);
  assert.match(statusResponse.text, /recent_sync_history_archive_progress: none/);
  assert.match(statusResponse.text, /recent_sync_completed_at: 2026-04-20T00:03:55.000Z/);
  assert.match(statusResponse.text, /recent_sync_error: none/);
  assert.match(statusResponse.text, /recent_transitions: 1/);
  assert.match(statusResponse.text, /\| BOOTSTRAP \| none -> RUNNING \| mode none -> DRY_RUN \| gate none -> DISABLED \|/);
  assert.match(historyResponse.text, /Execution State History/);
  assert.match(historyResponse.text, /count: 1/);
  assert.match(historyResponse.text, /state_source: persisted execution_state_transitions/);
  assert.match(syncHistoryResponse.text, /Reconciliation History/);
  assert.match(syncHistoryResponse.text, /count: 1/);
  assert.match(syncHistoryResponse.text, /state_source: persisted reconciliation_runs/);
  assert.match(syncHistoryResponse.text, /\| SUCCESS \| source=OPERATOR_SYNC \| issues=0 \| codes=none \| processed=1 \| deferred=0 \| history=none \| completed_at=2026-04-20T00:03:55.000Z \| error=none/);
  assert.match(recoveryResponse.text, /Exchange History Recovery/);
  assert.match(recoveryResponse.text, /latest_run_status: SUCCESS/);
  assert.match(recoveryResponse.text, /persisted_checkpoints: 1/);
  assert.match(alertsResponse.text, /Operator Alerts/);
  assert.match(alertsResponse.text, /count: 1/);
  assert.match(alertsResponse.text, /state_source: persisted operator_notifications/);
  assert.match(alertsResponse.text, /attempt_source: persisted operator_notification_delivery_attempts/);
  assert.match(alertsResponse.text, /delivery_attempt_count: 1/);
  assert.match(risksResponse.text, /Risk Events/);
  assert.match(risksResponse.text, /count: 1/);
  assert.match(risksResponse.text, /state_source: persisted risk_events/);
  assert.match(risksResponse.text, /GLOBAL_KILL_SWITCH/);
  assert.match(schedulerResponse.text, /Strategy Scheduler History/);
  assert.match(schedulerResponse.text, /count: 1/);
  assert.match(schedulerResponse.text, /state_source: runtime scheduler status \+ persisted strategy_scheduler_runs/);
  assert.match(schedulerResponse.text, /runtime_status_source: unavailable/);
  assert.match(schedulerResponse.text, /\| KRW-BTC \| COMPLETED \| trigger=SCHEDULER/);
  assert.match(inboundResponse.text, /Telegram Inbound/);
  assert.match(inboundResponse.text, /enabled: true/);
  assert.match(inboundResponse.text, /persisted_next_offset: 88/);
  assert.deepEqual(historyRequests, [3, 10]);
  assert.deepEqual(alertRequests, [10, 500, 5000]);
  assert.deepEqual(reconciliationRequests, [1, 10, 1]);
  assert.deepEqual(schedulerRequests, [5, 20]);
  assert.equal(inboundOffsetRequests, 1);
  assert.deepEqual(recoveryCheckpointRequests, ["primary"]);

  assert.match(pauseResponse.text, /Execution Control/);
  assert.match(pauseResponse.text, /command: \/pause/);
  assert.match(pauseResponse.text, /transition: RUNNING -> PAUSED/);
  assert.match(pauseResponse.text, /pause_reason: maintenance window/);
  assert.deepEqual(stateTransitions, ["pause:maintenance window"]);

  assert.equal(
    invalidResumeResponse.text,
    "Usage: /resume\nResume execution when the kill switch is clear.",
  );
  assert.equal(
    invalidHistoryResponse.text,
    "Usage: /statehistory\nShow recent persisted execution_state transition history.",
  );
  assert.equal(
    invalidSyncHistoryResponse.text,
    "Usage: /synchistory\nShow recent persisted reconciliation_runs for operator inspection.",
  );
  assert.equal(
    invalidRecoveryResponse.text,
    "Usage: /recovery\nShow checkpointed exchange-history recovery progress for operator inspection.",
  );
  assert.equal(
    invalidAlertsResponse.text,
    "Usage: /alerts\nShow recent persisted operator_notifications, delivery attempts, retry schedule, and Telegram delivery states.",
  );
  assert.equal(
    invalidRisksResponse.text,
    "Usage: /risks\nShow recent persisted risk_events for operator inspection.",
  );
  const invalidSchedulerResponse = await router.route("/scheduler now");
  assert.equal(
    invalidSchedulerResponse.text,
    "Usage: /scheduler\nShow runtime scheduler status and recent persisted strategy_scheduler_runs for operator inspection.",
  );
  const invalidInboundResponse = await router.route("/inbound now");
  assert.equal(
    invalidInboundResponse.text,
    "Usage: /inbound\nShow Telegram inbound polling status and persisted update offset.",
  );
  assert.deepEqual(stateTransitions, ["pause:maintenance window"]);

  assert.match(unsupportedInputResponse.text, /Manual cash and position input is not supported in Telegram\./);
  assert.match(syncResponse.text, /status: NOT_CONNECTED/);
  assert.match(syncResponse.text, /requested_at: 2026-04-20T00:04:00.000Z/);
  assert.equal(
    invalidPreviewResponse.text,
    "Usage: /preview BTC|ETH\nPreview one deterministic PositionGuard strategy decision and order intent without persistence or order submission.",
  );
  assert.equal(
    invalidRunResponse.text,
    "Usage: /run BTC|ETH\nRun one deterministic PositionGuard strategy cycle for a supported asset through the safe execution path.",
  );
});

test("router surfaces a wired sync controller when available", async () => {
  const syncRequests: string[] = [];
  const router = new TelegramCommandRouter({
    operatorState: createOperatorStateStub(),
    repositories: createRepositoryStub(),
    syncController: {
      async requestSync(request): Promise<TelegramSyncResult> {
        syncRequests.push(`${request.exchangeAccountId}:${request.requestedCommand}`);
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T00:10:00.000Z",
          detail: "Reconciliation run completed for the primary account.",
        };
      },
    },
  });

  const response = await router.route("/sync");

  assert.deepEqual(syncRequests, ["primary:/sync"]);
  assert.match(response.text, /status: COMPLETED/);
  assert.match(response.text, /detail: Reconciliation run completed for the primary account\./);
});

function createExecutionState(
  overrides: Partial<ExecutionStateRecord> = {},
): ExecutionStateRecord {
  return {
    id: "execution-state-1",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}

function createOperatorStateStub(): OperatorStateStore {
  return {
    async getState() {
      return createExecutionState();
    },
    async listTransitions() {
      return [
        {
          id: "transition-1",
          exchangeAccountId: "primary",
          command: "BOOTSTRAP",
          fromExecutionMode: null,
          toExecutionMode: "DRY_RUN",
          fromLiveExecutionGate: null,
          toLiveExecutionGate: "DISABLED",
          fromSystemStatus: null,
          toSystemStatus: "RUNNING",
          fromKillSwitchActive: null,
          toKillSwitchActive: false,
          reason: "bootstrap_seed",
          createdAt: "2026-04-20T00:00:00.000Z",
        },
      ];
    },
    async pause(reason) {
      return createExecutionState({
        systemStatus: "PAUSED",
        pauseReason: reason ?? "paused_by_operator",
      });
    },
    async resume() {
      return createExecutionState({
        systemStatus: "RUNNING",
        pauseReason: null,
      });
    },
    async activateKillSwitch(reason) {
      return createExecutionState({
        systemStatus: "KILL_SWITCHED",
        killSwitchActive: true,
        pauseReason: reason ?? "killswitch_activated",
      });
    },
    async setExecutionMode(mode) {
      return createExecutionState({
        executionMode: mode,
      });
    },
    async setLiveExecutionGate(gate) {
      return createExecutionState({
        liveExecutionGate: gate,
      });
    },
    async markDegraded(reason) {
      return createExecutionState({
        systemStatus: "DEGRADED",
        degradedReason: reason ?? "startup_portfolio_drift_detected",
        degradedAt: "2026-04-20T00:04:00.000Z",
      });
    },
    async clearDegraded() {
      return createExecutionState({
        systemStatus: "RUNNING",
        degradedReason: null,
        degradedAt: null,
      });
    },
  };
}

function createRepositoryStub(overrides: Partial<ExecutionRepository> = {}): ExecutionRepository {
  const orders: OrderRecord[] = [];
  const riskEvents = [
    {
      id: "risk-event-1",
      exchangeAccountId: "primary",
      strategyDecisionId: "decision-1",
      orderId: null,
      level: "BLOCK" as const,
      ruleCode: "GLOBAL_KILL_SWITCH" as const,
      message: "Global kill switch is active.",
      payloadJson: "{}",
      createdAt: "2026-04-20T00:00:30.000Z",
    },
  ];

  return {
    async saveStrategyDecision() {},
    async getLatestStrategyDecision() {
      return null;
    },
    async saveOrder(record) {
      orders.push(record);
    },
    async updateOrder() {},
    async findOrderByIdempotencyKey() {
      return null;
    },
    async findOrderByReference(_exchangeAccountId, reference) {
      return orders.find((order) => order.id === reference || order.identifier === reference) ?? null;
    },
    async listActiveOrders() {
      return [];
    },
    async listOrders() {
      return orders;
    },
    async appendOrderEvent() {},
    async listOrderEvents() {
      return [];
    },
    async saveFill() {},
    async listFills() {
      return [];
    },
    async saveBalanceSnapshot() {},
    async getLatestBalanceSnapshot() {
      return null;
    },
    async savePositionSnapshot() {},
    async getLatestPositionSnapshot() {
      return null;
    },
    async getPortfolioExposure() {
      return {
        totalEquityKrw: 0,
        totalExposureKrw: 0,
        assetExposureKrw: {
          BTC: 0,
          ETH: 0,
        },
      };
    },
    async saveRiskEvent() {},
    async listRiskEvents(_exchangeAccountId, limit) {
      return typeof limit === "number" ? riskEvents.slice(0, limit) : riskEvents;
    },
    async saveReconciliationRun() {},
    async updateReconciliationRun() {},
    async listReconciliationRuns() {
      return [];
    },
    async saveStrategySchedulerRun() {},
    async updateStrategySchedulerRun() {},
    async listStrategySchedulerRuns() {
      return [];
    },
    async saveHistoryRecoveryCheckpoint() {},
    async listHistoryRecoveryCheckpoints() {
      return [];
    },
    async getHistoryRecoveryCheckpoint() {
      return null;
    },
    async saveOperatorNotification() {},
    async saveOperatorNotificationDeliveryAttempt() {},
    async saveOperatorNotificationDeliveryRun() {},
    async claimPendingOperatorNotifications() {
      return [];
    },
    async compareAndSetOperatorNotificationDeliveryStatus() {
      return true;
    },
    async listOperatorNotifications() {
      return [];
    },
    async listOperatorNotificationDeliveryAttempts() {
      return [];
    },
    async listOperatorNotificationDeliveryRuns() {
      return [];
    },
    async listPendingOperatorNotifications() {
      return [];
    },
    ...overrides,
  };
}

function createNotification(
  overrides: Partial<OperatorNotificationRecord> & Pick<OperatorNotificationRecord, "id" | "createdAt">,
): OperatorNotificationRecord {
  const { id, createdAt, ...rest } = overrides;
  return {
    exchangeAccountId: "primary",
    channel: "TELEGRAM",
    notificationType: "ORDER_REJECTED",
    severity: "WARN",
    title: "Operator notification",
    message: "Operator-facing event.",
    payloadJson: "{}",
    deliveryStatus: "PENDING",
    attemptCount: 0,
    lastAttemptAt: null,
    nextAttemptAt: null,
    failureClass: null,
    leaseToken: null,
    leaseExpiresAt: null,
    ...rest,
    id,
    createdAt,
    deliveredAt: null,
    lastError: null,
  };
}

function createOrder(overrides: Partial<OrderRecord> & Pick<OrderRecord, "id">): OrderRecord {
  return {
    strategyDecisionId: "strategy-decision-1",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "500000",
    timeInForce: null,
    smpType: null,
    identifier: "order-identifier",
    idempotencyKey: "idempotency-1",
    origin: "STRATEGY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: null,
    status: "PERSISTED",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}
