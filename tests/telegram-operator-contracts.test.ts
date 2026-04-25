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
  parseTelegramCommand,
  validateTelegramCommand,
} from "../src/modules/telegram/contracts.js";
import {
  formatBalanceMessage,
  formatOperatorNotificationsMessage,
  formatPositionMessage,
  formatReconciliationRunsMessage,
  formatRiskEventsMessage,
} from "../src/modules/telegram/formatter.js";
import type { TelegramSyncResult } from "../src/modules/telegram/interfaces.js";
import { test } from "./harness.js";

test("parseTelegramCommand normalizes bot mentions and preserves arguments", () => {
  const parsed = parseTelegramCommand("/STATUS@autotrade_upbit_bot");
  const historyParsed = parseTelegramCommand("/STATEHISTORY@autotrade_upbit_bot");
  const syncHistoryParsed = parseTelegramCommand("/SYNCHISTORY@autotrade_upbit_bot");
  const alertsParsed = parseTelegramCommand("/ALERTS@autotrade_upbit_bot");
  const risksParsed = parseTelegramCommand("/RISKS@autotrade_upbit_bot");

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
  assert.ok(alertsParsed);
  assert.equal(alertsParsed.command, "/alerts");
  assert.equal(alertsParsed.contract.summary, "Show recent persisted operator_notifications, delivery attempts, retry schedule, and Telegram delivery states.");
  assert.ok(risksParsed);
  assert.equal(risksParsed.command, "/risks");
  assert.equal(risksParsed.contract.summary, "Show recent persisted risk_events for operator inspection.");
});

test("manual input commands are rejected by the operator contract", () => {
  const message = buildUnsupportedCommandMessage("/setposition BTC 0.25 95000000");

  assert.match(message, /Manual cash and position input is not supported in Telegram\./);
  assert.match(message, /\/status \/statehistory \/synchistory \/alerts \/risks \/balances \/positions \/orders \/pause \/resume \/killswitch \/sync/);
});

test("no-argument commands return usage guidance when extra arguments are supplied", () => {
  const parsed = parseTelegramCommand("/resume now");
  const historyParsed = parseTelegramCommand("/statehistory now");
  const syncHistoryParsed = parseTelegramCommand("/synchistory now");
  const alertsParsed = parseTelegramCommand("/alerts now");
  const risksParsed = parseTelegramCommand("/risks now");

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

  assert.match(risksMessage, /Risk Events/);
  assert.match(risksMessage, /count: 1/);
  assert.match(risksMessage, /state_source: persisted risk_events/);
  assert.match(risksMessage, /MINIMUM_ORDER_VALUE_GUARD/);
});

test("router applies control commands, blocks invalid arguments, and advertises sync wiring state", async () => {
  const stateTransitions: string[] = [];
  const historyRequests: number[] = [];
  const alertRequests: number[] = [];
  const reconciliationRequests: number[] = [];
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
    }),
    executionStateSeed: {
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      killSwitchActive: false,
    },
    liveSendPath: "DRY_RUN_ADAPTER",
    now: () => "2026-04-20T00:04:00.000Z",
  });

  const statusResponse = await router.route("/status");
  const historyResponse = await router.route("/statehistory");
  const syncHistoryResponse = await router.route("/synchistory");
  const alertsResponse = await router.route("/alerts");
  const risksResponse = await router.route("/risks");
  const pauseResponse = await router.route("/pause maintenance window");
  const invalidResumeResponse = await router.route("/resume now");
  const invalidHistoryResponse = await router.route("/statehistory now");
  const invalidSyncHistoryResponse = await router.route("/synchistory now");
  const invalidAlertsResponse = await router.route("/alerts now");
  const invalidRisksResponse = await router.route("/risks now");
  const unsupportedInputResponse = await router.route("/setcash 100000");
  const syncResponse = await router.route("/sync");

  assert.match(statusResponse.text, /exchange_account_id: primary/);
  assert.match(statusResponse.text, /state_source: persisted execution_state/);
  assert.match(statusResponse.text, /live_orders_allowed: false/);
  assert.match(statusResponse.text, /blocked_by: DRY_RUN,LIVE_GATE_DISABLED,DRY_RUN_ADAPTER/);
  assert.match(statusResponse.text, /seed_mismatches: none/);
  assert.match(statusResponse.text, /recent_sync_source: OPERATOR_SYNC/);
  assert.match(statusResponse.text, /recent_sync_status: SUCCESS/);
  assert.match(statusResponse.text, /recent_sync_issues: 0/);
  assert.match(statusResponse.text, /recent_sync_issue_codes: none/);
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
  assert.match(alertsResponse.text, /Operator Alerts/);
  assert.match(alertsResponse.text, /count: 1/);
  assert.match(alertsResponse.text, /state_source: persisted operator_notifications/);
  assert.match(alertsResponse.text, /attempt_source: persisted operator_notification_delivery_attempts/);
  assert.match(alertsResponse.text, /delivery_attempt_count: 1/);
  assert.match(risksResponse.text, /Risk Events/);
  assert.match(risksResponse.text, /count: 1/);
  assert.match(risksResponse.text, /state_source: persisted risk_events/);
  assert.match(risksResponse.text, /GLOBAL_KILL_SWITCH/);
  assert.deepEqual(historyRequests, [3, 10]);
  assert.deepEqual(alertRequests, [10, 500]);
  assert.deepEqual(reconciliationRequests, [1, 10]);

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
    invalidAlertsResponse.text,
    "Usage: /alerts\nShow recent persisted operator_notifications, delivery attempts, retry schedule, and Telegram delivery states.",
  );
  assert.equal(
    invalidRisksResponse.text,
    "Usage: /risks\nShow recent persisted risk_events for operator inspection.",
  );
  assert.deepEqual(stateTransitions, ["pause:maintenance window"]);

  assert.match(unsupportedInputResponse.text, /Manual cash and position input is not supported in Telegram\./);
  assert.match(syncResponse.text, /status: NOT_CONNECTED/);
  assert.match(syncResponse.text, /requested_at: 2026-04-20T00:04:00.000Z/);
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
    async saveOrder(record) {
      orders.push(record);
    },
    async updateOrder() {},
    async findOrderByIdempotencyKey() {
      return null;
    },
    async listActiveOrders() {
      return [];
    },
    async listOrders() {
      return orders;
    },
    async appendOrderEvent() {},
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
    async saveHistoryRecoveryCheckpoint() {},
    async getHistoryRecoveryCheckpoint() {
      return null;
    },
    async saveOperatorNotification() {},
    async saveOperatorNotificationDeliveryAttempt() {},
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
