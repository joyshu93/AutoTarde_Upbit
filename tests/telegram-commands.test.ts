import assert from "node:assert/strict";

import type { OperatorNotificationRecord } from "../src/domain/types.js";
import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import { TelegramCommandRouter } from "../src/modules/telegram/commands.js";
import { test } from "./harness.js";

function createRouter(): TelegramCommandRouter {
  return new TelegramCommandRouter({
    repositories: new InMemoryExecutionRepository(),
    operatorState: new InMemoryOperatorStateStore({
      id: "state-1",
      exchangeAccountId: "primary",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      systemStatus: "RUNNING",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: null,
      degradedAt: null,
      updatedAt: "2026-04-20T00:00:00.000Z",
    }),
  });
}

test("telegram router parses supported operator commands only", () => {
  const router = createRouter();

  const parsed = router.parse("/status");
  const historyParsed = router.parse("/statehistory");
  const syncHistoryParsed = router.parse("/synchistory");
  const alertsParsed = router.parse("/alerts");
  const risksParsed = router.parse("/risks");
  assert.equal(parsed?.command, "/status");
  assert.deepEqual(parsed?.args, []);
  assert.equal(parsed?.contract.command, "/status");
  assert.equal(historyParsed?.command, "/statehistory");
  assert.equal(historyParsed?.contract.category, "inspection");
  assert.equal(syncHistoryParsed?.command, "/synchistory");
  assert.equal(syncHistoryParsed?.contract.category, "inspection");
  assert.equal(alertsParsed?.command, "/alerts");
  assert.equal(alertsParsed?.contract.category, "inspection");
  assert.equal(risksParsed?.command, "/risks");
  assert.equal(risksParsed?.contract.category, "inspection");
  assert.equal(router.parse("/setcash 1000000"), null);
  assert.equal(router.parse("status"), null);
});

test("telegram router exposes persisted execution status with explicit blockers", async () => {
  const router = createRouter();

  const status = await router.route("/status");

  assert.match(status.text, /state_source: persisted execution_state/);
  assert.match(status.text, /live_orders_allowed: false/);
  assert.match(status.text, /blocked_by: DRY_RUN,LIVE_GATE_DISABLED,DRY_RUN_ADAPTER/);
  assert.match(status.text, /degraded_reason: none/);
  assert.match(status.text, /degraded_since: none/);
  assert.match(status.text, /recent_sync_source: none/);
  assert.match(status.text, /recent_sync_status: none/);
  assert.match(status.text, /recent_sync_issues: none/);
  assert.match(status.text, /recent_sync_issue_codes: none/);
  assert.match(status.text, /recent_sync_history_recovered_orders: none/);
  assert.match(status.text, /recent_sync_history_scanned_snapshots: none/);
  assert.match(status.text, /recent_sync_history_archive_progress: none/);
  assert.match(status.text, /recent_transitions: 1/);
  assert.match(status.text, /\| BOOTSTRAP \| none -> RUNNING \| mode none -> DRY_RUN \| gate none -> DISABLED \|/);
});

test("telegram router includes recent reconciliation summary in /status when available", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveReconciliationRun({
    id: "recon-run-status-1",
    exchangeAccountId: "primary",
    status: "DRIFT_DETECTED",
    startedAt: "2026-04-20T00:30:00.000Z",
    completedAt: "2026-04-20T00:30:04.000Z",
    summaryJson: JSON.stringify({
      source: "OPERATOR_SYNC",
      status: "DRIFT_DETECTED",
      issues: [
        {
          code: "ORDER_FILLS_BACKFILLED",
          message: "Backfilled 1 fill(s).",
        },
      ],
      processedCount: 1,
      deferredCount: 0,
      historyRecovery: {
        closedOrderLookbackDays: 7,
        scannedSnapshotCount: 3,
        recoveredOrderCount: 1,
        markets: [
          {
            market: "KRW-BTC",
            recentClosedWindowStartAt: "2026-04-13T00:30:00.000Z",
            recentClosedWindowEndAt: "2026-04-20T00:30:00.000Z",
            archivalWindowStartAt: "2026-04-06T00:30:00.000Z",
            archivalWindowEndAt: "2026-04-13T00:30:00.000Z",
            nextWindowEndAt: "2026-04-06T00:30:00.000Z",
            openPagesScanned: 1,
            recentClosedPagesScanned: 1,
            archivalClosedPagesScanned: 1,
            snapshotCount: 3,
          },
        ],
      },
    }),
    errorMessage: null,
  });

  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-1",
      exchangeAccountId: "primary",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      systemStatus: "RUNNING",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: null,
      degradedAt: null,
      updatedAt: "2026-04-20T00:00:00.000Z",
    }),
  });

  const status = await router.route("/status");

  assert.match(status.text, /recent_sync_source: OPERATOR_SYNC/);
  assert.match(status.text, /recent_sync_status: DRIFT_DETECTED/);
  assert.match(status.text, /recent_sync_issues: 1/);
  assert.match(status.text, /recent_sync_issue_codes: ORDER_FILLS_BACKFILLED/);
  assert.match(status.text, /recent_sync_history_recovered_orders: 1/);
  assert.match(status.text, /recent_sync_history_scanned_snapshots: 3/);
  assert.match(status.text, /recent_sync_history_archive_progress: lookback_days=7 scanned=3 recovered=1 markets=KRW-BTC\[archive=2026-04-06T00:30:00.000Z\.\.2026-04-13T00:30:00.000Z next<=2026-04-06T00:30:00.000Z pages=1\/1\/1 snapshots=3\]/);
  assert.match(status.text, /recent_sync_completed_at: 2026-04-20T00:30:04.000Z/);
  assert.match(status.text, /recent_sync_error: none/);
});

test("telegram router exposes dedicated execution-state history inspection", async () => {
  const router = createRouter();

  const history = await router.route("/statehistory");

  assert.match(history.text, /Execution State History/);
  assert.match(history.text, /count: 1/);
  assert.match(history.text, /state_source: persisted execution_state_transitions/);
  assert.match(history.text, /\| BOOTSTRAP \| none -> RUNNING \| mode none -> DRY_RUN \| gate none -> DISABLED \| reason=bootstrap_seed/);
  assert.doesNotMatch(history.text, /live_orders_allowed:/);
});

test("telegram router exposes dedicated reconciliation history inspection", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveReconciliationRun({
    id: "recon-run-1",
    exchangeAccountId: "primary",
    status: "DRIFT_DETECTED",
    startedAt: "2026-04-20T00:20:00.000Z",
    completedAt: "2026-04-20T00:20:05.000Z",
    summaryJson: JSON.stringify({
      source: "OPERATOR_SYNC",
      status: "DRIFT_DETECTED",
      issues: [
        {
          code: "ORDER_FILLS_BACKFILLED",
          message: "Backfilled 1 fill for order order-1.",
        },
      ],
      processedCount: 1,
      deferredCount: 0,
      historyRecovery: {
        closedOrderLookbackDays: 7,
        scannedSnapshotCount: 3,
        recoveredOrderCount: 1,
        markets: [
          {
            market: "KRW-BTC",
            recentClosedWindowStartAt: "2026-04-13T00:20:00.000Z",
            recentClosedWindowEndAt: "2026-04-20T00:20:00.000Z",
            archivalWindowStartAt: "2026-04-06T00:20:00.000Z",
            archivalWindowEndAt: "2026-04-13T00:20:00.000Z",
            nextWindowEndAt: "2026-04-06T00:20:00.000Z",
            openPagesScanned: 1,
            recentClosedPagesScanned: 1,
            archivalClosedPagesScanned: 1,
            snapshotCount: 3,
          },
        ],
      },
    }),
    errorMessage: null,
  });

  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-1",
      exchangeAccountId: "primary",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      systemStatus: "RUNNING",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: null,
      degradedAt: null,
      updatedAt: "2026-04-20T00:00:00.000Z",
    }),
  });

  const history = await router.route("/synchistory");

  assert.match(history.text, /Reconciliation History/);
  assert.match(history.text, /count: 1/);
  assert.match(history.text, /state_source: persisted reconciliation_runs/);
  assert.match(history.text, /\| DRIFT_DETECTED \| source=OPERATOR_SYNC \| issues=1 \| codes=ORDER_FILLS_BACKFILLED \| processed=1 \| deferred=0 \| history=lookback_days=7 scanned=3 recovered=1 markets=KRW-BTC\[archive=2026-04-06T00:20:00.000Z\.\.2026-04-13T00:20:00.000Z next<=2026-04-06T00:20:00.000Z pages=1\/1\/1 snapshots=3\] \| completed_at=2026-04-20T00:20:05.000Z \| error=none/);
});

test("telegram router exposes durable operator alerts inspection", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveOperatorNotification(createNotification({
    id: "operator-notification-1",
    title: "Order rejected before submission",
    message: "Exchange order chance does not allow price orders for bid on KRW-BTC.",
    payloadJson: JSON.stringify({ market: "KRW-BTC" }),
    createdAt: "2026-04-20T00:21:00.000Z",
  }));
  await repository.saveOperatorNotificationDeliveryAttempt({
    id: "notification-attempt-1",
    notificationId: "operator-notification-1",
    exchangeAccountId: "primary",
    attemptCount: 1,
    leaseToken: "lease-1",
    outcome: "RETRY_SCHEDULED",
    failureClass: "RETRYABLE",
    attemptedAt: "2026-04-20T00:21:05.000Z",
    nextAttemptAt: "2026-04-20T00:22:05.000Z",
    deliveredAt: null,
    errorMessage: "telegram_http_500",
    createdAt: "2026-04-20T00:21:05.000Z",
  });

  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-1",
      exchangeAccountId: "primary",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      systemStatus: "RUNNING",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: null,
      degradedAt: null,
      updatedAt: "2026-04-20T00:00:00.000Z",
    }),
  });

  const alerts = await router.route("/alerts");

  assert.match(alerts.text, /Operator Alerts/);
  assert.match(alerts.text, /count: 1/);
  assert.match(alerts.text, /state_source: persisted operator_notifications/);
  assert.match(alerts.text, /attempt_source: persisted operator_notification_delivery_attempts/);
  assert.match(alerts.text, /pending_due_count: 1/);
  assert.match(alerts.text, /pending_scheduled_count: 0/);
  assert.match(alerts.text, /active_lease_count: 0/);
  assert.match(alerts.text, /recent_stale_lease_count: 0/);
  assert.match(alerts.text, /\| WARN \| ORDER_REJECTED \| PENDING \| attempts=0 \| last_attempt_at=none \| next_attempt_at=none \| failure_class=none \| delivered_at=none \| error=none \| Order rejected before submission \| Exchange order chance does not allow price orders/);
  assert.match(alerts.text, /delivery_attempt_count: 1/);
  assert.match(alerts.text, /\| notification_id=operator-notification-1 \| attempt=1 \| outcome=RETRY_SCHEDULED \| failure_class=RETRYABLE \| next_attempt_at=2026-04-20T00:22:05.000Z \| delivered_at=none \| error=telegram_http_500/);
});

test("telegram router exposes dedicated persisted risk-event inspection", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveRiskEvent({
    id: "risk-event-1",
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-1",
    orderId: null,
    level: "BLOCK",
    ruleCode: "DUPLICATE_ORDER_GUARD",
    message: "A matching active order already exists.",
    payloadJson: JSON.stringify({ idempotencyKey: "duplicate-key" }),
    createdAt: "2026-04-20T00:01:00.000Z",
  });

  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-1",
      exchangeAccountId: "primary",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      systemStatus: "RUNNING",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: null,
      degradedAt: null,
      updatedAt: "2026-04-20T00:00:00.000Z",
    }),
  });

  const risks = await router.route("/risks");

  assert.match(risks.text, /Risk Events/);
  assert.match(risks.text, /count: 1/);
  assert.match(risks.text, /state_source: persisted risk_events/);
  assert.match(risks.text, /\| BLOCK \| DUPLICATE_ORDER_GUARD \| A matching active order already exists\./);
});

test("telegram router pauses and resumes operator state", async () => {
  const router = createRouter();

  const paused = await router.route("/pause maintenance");
  assert.match(paused.text, /system_status: PAUSED/);
  assert.match(paused.text, /pause_reason: maintenance/);

  const resumed = await router.route("/resume");
  assert.match(resumed.text, /system_status: RUNNING/);
});

test("telegram router activates kill switch", async () => {
  const router = createRouter();

  const response = await router.route("/killswitch operator_stop");
  assert.match(response.text, /system_status: KILL_SWITCHED/);
  assert.match(response.text, /kill_switch: on/);
});

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
