import assert from "node:assert/strict";

import type { OperatorNotificationRecord, OrderRecord } from "../src/domain/types.js";
import {
  InMemoryExecutionRepository,
  InMemoryOperatorStateStore,
  InMemoryTelegramInboundOffsetStore,
} from "../src/modules/db/repositories/in-memory-repositories.js";
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

function createRuntimeConfig() {
  return {
    serviceName: "AutoTrade_Upbit",
    executionMode: "DRY_RUN" as const,
    liveExecutionGate: "DISABLED" as const,
    liveSendPath: "DRY_RUN_ADAPTER" as const,
    upbitBaseUrl: "https://api.upbit.com",
    databasePath: "./var/autotrade-upbit.sqlite",
    exchangeBackedReadEnabled: true,
    telegramDeliveryEnabled: true,
    telegramBotTokenConfigured: true,
    telegramOperatorChatIdConfigured: true,
    telegramDeliveryMaxAttempts: 5,
    telegramDeliveryBaseBackoffMs: 15_000,
    telegramDeliveryMaxBackoffMs: 300_000,
    telegramDeliveryLeaseMs: 30_000,
    telegramInboundPollingEnabled: true,
    telegramInboundPollIntervalMs: 2_000,
    telegramInboundPollTimeoutSeconds: 25,
    telegramInboundPollLimit: 10,
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
  };
}

test("telegram router parses supported operator commands only", () => {
  const router = createRouter();

  const helpParsed = router.parse("/help");
  const startParsed = router.parse("/start");
  const configParsed = router.parse("/config");
  const readinessParsed = router.parse("/readiness");
  const parsed = router.parse("/status");
  const historyParsed = router.parse("/statehistory");
  const syncHistoryParsed = router.parse("/synchistory");
  const recoveryParsed = router.parse("/recovery");
  const alertsParsed = router.parse("/alerts");
  const risksParsed = router.parse("/risks");
  const schedulerParsed = router.parse("/scheduler");
  const inboundParsed = router.parse("/inbound");
  const orderParsed = router.parse("/order order-1");
  const runParsed = router.parse("/run BTC");
  assert.equal(helpParsed?.command, "/help");
  assert.deepEqual(helpParsed?.args, []);
  assert.equal(helpParsed?.contract.category, "inspection");
  assert.equal(startParsed?.command, "/help");
  assert.deepEqual(startParsed?.args, []);
  assert.equal(configParsed?.command, "/config");
  assert.deepEqual(configParsed?.args, []);
  assert.equal(configParsed?.contract.category, "inspection");
  assert.equal(readinessParsed?.command, "/readiness");
  assert.deepEqual(readinessParsed?.args, []);
  assert.equal(readinessParsed?.contract.category, "inspection");
  assert.equal(parsed?.command, "/status");
  assert.deepEqual(parsed?.args, []);
  assert.equal(parsed?.contract.command, "/status");
  assert.equal(historyParsed?.command, "/statehistory");
  assert.equal(historyParsed?.contract.category, "inspection");
  assert.equal(syncHistoryParsed?.command, "/synchistory");
  assert.equal(syncHistoryParsed?.contract.category, "inspection");
  assert.equal(recoveryParsed?.command, "/recovery");
  assert.equal(recoveryParsed?.contract.category, "inspection");
  assert.equal(alertsParsed?.command, "/alerts");
  assert.equal(alertsParsed?.contract.category, "inspection");
  assert.equal(risksParsed?.command, "/risks");
  assert.equal(risksParsed?.contract.category, "inspection");
  assert.equal(schedulerParsed?.command, "/scheduler");
  assert.equal(schedulerParsed?.contract.category, "inspection");
  assert.equal(inboundParsed?.command, "/inbound");
  assert.equal(inboundParsed?.contract.category, "inspection");
  assert.equal(orderParsed?.command, "/order");
  assert.deepEqual(orderParsed?.args, ["order-1"]);
  assert.equal(orderParsed?.contract.category, "inspection");
  assert.equal(runParsed?.command, "/run");
  assert.deepEqual(runParsed?.args, ["BTC"]);
  assert.equal(runParsed?.contract.category, "control");
  assert.equal(router.parse("/setcash 1000000"), null);
  assert.equal(router.parse("status"), null);
});

test("telegram router exposes non-secret runtime config inspection", async () => {
  const router = new TelegramCommandRouter({
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
    runtimeConfig: {
      serviceName: "AutoTrade_Upbit",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      liveSendPath: "DRY_RUN_ADAPTER",
      upbitBaseUrl: "https://api.upbit.com",
      databasePath: "./var/autotrade-upbit.sqlite",
      exchangeBackedReadEnabled: true,
      telegramDeliveryEnabled: true,
      telegramBotTokenConfigured: true,
      telegramOperatorChatIdConfigured: true,
      telegramDeliveryMaxAttempts: 5,
      telegramDeliveryBaseBackoffMs: 15_000,
      telegramDeliveryMaxBackoffMs: 300_000,
      telegramDeliveryLeaseMs: 30_000,
      telegramInboundPollingEnabled: true,
      telegramInboundPollIntervalMs: 2_000,
      telegramInboundPollTimeoutSeconds: 25,
      telegramInboundPollLimit: 10,
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
    },
  });

  const response = await router.route("/config");

  assert.match(response.text, /Runtime Config/);
  assert.match(response.text, /state_source: runtime app configuration/);
  assert.match(response.text, /execution_mode: DRY_RUN/);
  assert.match(response.text, /live_gate: DISABLED/);
  assert.match(response.text, /live_send_path: DRY_RUN_ADAPTER/);
  assert.match(response.text, /live_orders_allowed_by_config: false/);
  assert.match(response.text, /config_live_blockers: DRY_RUN,LIVE_GATE_DISABLED,DRY_RUN_ADAPTER/);
  assert.match(response.text, /exchange_backed_read_enabled: true/);
  assert.match(response.text, /telegram_bot_token_configured: true/);
  assert.match(response.text, /telegram_operator_chat_id_configured: true/);
  assert.match(response.text, /telegram_inbound_polling_enabled: true/);
  assert.match(response.text, /strategy_scheduler_enabled: false/);
  assert.match(response.text, /minimum_order_value_krw: 5000/);
  assert.match(response.text, /max_allocation_btc: 0\.6/);
  assert.match(response.text, /total_exposure_cap: 0\.75/);
  assert.match(response.text, /secret_boundary: secret values are never rendered/);
  assert.doesNotMatch(response.text, /123456:real-bot-token|real-upbit-secret|UPBIT_SECRET_KEY=/);
});

test("telegram router exposes read-only operator readiness", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveBalanceSnapshot({
    id: "balance-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:01:00.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "1000000",
    balancesJson: "[]",
  });
  await repository.savePositionSnapshot({
    id: "position-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:02:00.000Z",
    source: "RECONCILIATION",
    positionsJson: "[]",
  });
  await repository.saveReconciliationRun({
    id: "recon-run-1",
    exchangeAccountId: "primary",
    status: "SUCCESS",
    startedAt: "2026-04-20T00:03:00.000Z",
    completedAt: "2026-04-20T00:03:02.000Z",
    summaryJson: JSON.stringify({ source: "OPERATOR_SYNC", issues: [] }),
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
    runtimeConfig: {
      serviceName: "AutoTrade_Upbit",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      liveSendPath: "DRY_RUN_ADAPTER",
      upbitBaseUrl: "https://api.upbit.com",
      databasePath: "./var/autotrade-upbit.sqlite",
      exchangeBackedReadEnabled: true,
      telegramDeliveryEnabled: true,
      telegramBotTokenConfigured: true,
      telegramOperatorChatIdConfigured: true,
      telegramDeliveryMaxAttempts: 5,
      telegramDeliveryBaseBackoffMs: 15_000,
      telegramDeliveryMaxBackoffMs: 300_000,
      telegramDeliveryLeaseMs: 30_000,
      telegramInboundPollingEnabled: true,
      telegramInboundPollIntervalMs: 2_000,
      telegramInboundPollTimeoutSeconds: 25,
      telegramInboundPollLimit: 10,
      strategySchedulerEnabled: true,
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
    },
    schedulerStatus: () => ({
      enabled: true,
      started: true,
      exchangeAccountId: "primary",
      liveSendPath: "DRY_RUN_ADAPTER",
      startupPreflight: null,
      markets: [],
    }),
    telegramInboundStatus: () => ({
      enabled: true,
      configured: true,
      running: true,
      nextOffset: 42,
      pollIntervalMs: 2_000,
      longPollTimeoutSeconds: 25,
      limit: 10,
      lastPollAt: "2026-04-20T00:04:00.000Z",
      lastUpdateId: 41,
      offsetLoaded: true,
      offsetStorage: "DURABLE",
      processedCount: 3,
      ignoredCount: 0,
      failedCount: 0,
      lastError: null,
    }),
  });

  const response = await router.route("/readiness");

  assert.match(response.text, /Operator Readiness/);
  assert.match(response.text, /state_source: runtime config \+ persisted execution_state \+ latest persisted snapshots/);
  assert.match(response.text, /overall_status: PASS/);
  assert.match(response.text, /live_gate: DISABLED/);
  assert.match(response.text, /latest_balance_snapshot_at: 2026-04-20T00:01:00.000Z/);
  assert.match(response.text, /latest_position_snapshot_at: 2026-04-20T00:02:00.000Z/);
  assert.match(response.text, /latest_reconciliation_status: SUCCESS/);
  assert.match(response.text, /active_order_count: 0/);
  assert.match(response.text, /recent_risk_block_count: 0/);
  assert.match(response.text, /pending_notification_count: 0/);
  assert.match(response.text, /- live_send_safety: PASS \| live order path blocked by DRY_RUN,LIVE_GATE_DISABLED,DRY_RUN_ADAPTER/);
  assert.match(response.text, /- telegram_inbound: PASS \| inbound configured running=true offset_storage=DURABLE/);
  assert.match(response.text, /- strategy_scheduler: PASS \| scheduler enabled started=true/);
  assert.match(response.text, /- active_orders: PASS \| no active or reconciliation-required orders are currently stored/);
  assert.match(response.text, /- recent_risk_blocks: PASS \| no BLOCK risk events in recent sample size=0/);
  assert.match(response.text, /- pending_notifications: PASS \| no pending operator notifications in recent bounded sample/);
  assert.match(response.text, /read_only_boundary: \/readiness never triggers sync, Telegram polling, strategy runs, scheduler ticks, exchange reads, order mutation, or live order transmission\./);
  assert.match(response.text, /secret_boundary: secret values are never rendered/);
});

test("telegram router readiness warns when live send path is intentionally enabled", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveBalanceSnapshot({
    id: "balance-live-ready",
    exchangeAccountId: "primary",
    capturedAt: "2026-05-13T07:19:29.233Z",
    source: "RECONCILIATION",
    totalKrwValue: "8967.627519169999",
    balancesJson: "[]",
  });
  await repository.savePositionSnapshot({
    id: "position-live-ready",
    exchangeAccountId: "primary",
    capturedAt: "2026-05-13T07:19:29.233Z",
    source: "RECONCILIATION",
    positionsJson: "[]",
  });
  await repository.saveReconciliationRun({
    id: "recon-live-ready",
    exchangeAccountId: "primary",
    status: "DRIFT_DETECTED",
    startedAt: "2026-05-13T07:19:29.233Z",
    completedAt: "2026-05-13T07:19:29.388Z",
    summaryJson: JSON.stringify({
      source: "OPERATOR_SYNC",
      issues: [
        { code: "EXCHANGE_ORDER_RECOVERED", message: "Recovered exchange order." },
      ],
    }),
    errorMessage: null,
  });
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-live-ready",
      exchangeAccountId: "primary",
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      systemStatus: "RUNNING",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: null,
      degradedAt: null,
      updatedAt: "2026-05-13T07:09:45.563Z",
    }),
    runtimeConfig: {
      ...createRuntimeConfig(),
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      liveSendPath: "LIVE_ADAPTER",
    },
    schedulerStatus: () => ({
      enabled: false,
      started: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      startupPreflight: {
        checkedAt: "2026-05-13T07:19:10.683Z",
        scope: "DISABLED",
        status: "NOT_REQUIRED",
        detail: "Strategy scheduler is disabled.",
        checks: [],
      },
      markets: [],
    }),
    telegramInboundStatus: () => ({
      enabled: true,
      configured: true,
      running: true,
      nextOffset: null,
      pollIntervalMs: 2_000,
      longPollTimeoutSeconds: 25,
      limit: 10,
      lastPollAt: null,
      lastUpdateId: null,
      offsetLoaded: false,
      offsetStorage: "DURABLE",
      processedCount: 0,
      ignoredCount: 0,
      failedCount: 0,
      lastError: null,
    }),
  });

  const response = await router.route("/readiness");

  assert.match(response.text, /overall_status: WARN/);
  assert.match(response.text, /execution_mode: LIVE/);
  assert.match(response.text, /live_gate: ENABLED/);
  assert.match(response.text, /- live_send_safety: WARN \| live order path is enabled by config; \/run commands are real-order capable/);
  assert.match(response.text, /- execution_state: PASS \| execution state allows orders/);
  assert.match(response.text, /- latest_reconciliation: WARN \| latest reconciliation status=DRIFT_DETECTED completed_at=2026-05-13T07:19:29.388Z non_blocking_issue_codes=EXCHANGE_ORDER_RECOVERED/);
  assert.doesNotMatch(response.text, /overall_status: BLOCK/);
});

test("telegram router readiness summarizes persistence health warnings", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveOrder(createOrder({
    id: "active-order-1",
    status: "OPEN",
    updatedAt: "2026-04-20T00:05:00.000Z",
  }));
  await repository.saveRiskEvent({
    id: "risk-event-block-1",
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-1",
    orderId: "active-order-1",
    level: "BLOCK",
    ruleCode: "DUPLICATE_ORDER_GUARD",
    message: "Duplicate active order.",
    payloadJson: "{}",
    createdAt: "2026-04-20T00:04:00.000Z",
  });
  await repository.saveOperatorNotification(createNotification({
    id: "pending-notification-1",
    createdAt: "2026-04-20T00:06:00.000Z",
  }));
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
    runtimeConfig: {
      serviceName: "AutoTrade_Upbit",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      liveSendPath: "DRY_RUN_ADAPTER",
      upbitBaseUrl: "https://api.upbit.com",
      databasePath: "./var/autotrade-upbit.sqlite",
      exchangeBackedReadEnabled: true,
      telegramDeliveryEnabled: true,
      telegramBotTokenConfigured: true,
      telegramOperatorChatIdConfigured: true,
      telegramDeliveryMaxAttempts: 5,
      telegramDeliveryBaseBackoffMs: 15_000,
      telegramDeliveryMaxBackoffMs: 300_000,
      telegramDeliveryLeaseMs: 30_000,
      telegramInboundPollingEnabled: false,
      telegramInboundPollIntervalMs: 2_000,
      telegramInboundPollTimeoutSeconds: 25,
      telegramInboundPollLimit: 10,
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
    },
  });

  const response = await router.route("/readiness");

  assert.match(response.text, /overall_status: WARN/);
  assert.match(response.text, /active_order_count: 1/);
  assert.match(response.text, /recent_risk_block_count: 1/);
  assert.match(response.text, /pending_notification_count: 1/);
  assert.match(response.text, /- active_orders: WARN \| 1 active or reconciliation-required order\(s\) need operator visibility/);
  assert.match(response.text, /- recent_risk_blocks: WARN \| 1 BLOCK risk event\(s\) in recent sample size=1/);
  assert.match(response.text, /- pending_notifications: WARN \| 1 pending operator notification\(s\) in bounded sample/);
});

test("telegram router readiness warns for non-blocking reconciliation recovery progress", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveBalanceSnapshot({
    id: "balance-recovery-progress",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:01:00.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "1000000",
    balancesJson: "[]",
  });
  await repository.savePositionSnapshot({
    id: "position-recovery-progress",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:02:00.000Z",
    source: "RECONCILIATION",
    positionsJson: "[]",
  });
  await repository.saveReconciliationRun({
    id: "recon-recovery-progress",
    exchangeAccountId: "primary",
    status: "DRIFT_DETECTED",
    startedAt: "2026-04-20T00:03:00.000Z",
    completedAt: "2026-04-20T00:03:01.000Z",
    summaryJson: JSON.stringify({
      source: "OPERATOR_SYNC",
      status: "DRIFT_DETECTED",
      issues: [
        { code: "EXCHANGE_ORDER_RECOVERED", message: "Recovered exchange order." },
        { code: "TERMINAL_ORDER_RECHECKED", message: "Terminal order rechecked." },
        { code: "ORDER_FILLS_BACKFILLED", message: "Backfilled fills." },
      ],
    }),
    errorMessage: null,
  });
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-recovery-progress",
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
    runtimeConfig: createRuntimeConfig(),
  });

  const response = await router.route("/readiness");

  assert.match(response.text, /overall_status: WARN/);
  assert.match(response.text, /latest_reconciliation_status: DRIFT_DETECTED/);
  assert.match(response.text, /- latest_reconciliation: WARN \| latest reconciliation status=DRIFT_DETECTED completed_at=2026-04-20T00:03:01.000Z non_blocking_issue_codes=EXCHANGE_ORDER_RECOVERED,TERMINAL_ORDER_RECHECKED,ORDER_FILLS_BACKFILLED/);
});

test("telegram router readiness blocks for portfolio drift reconciliation issues", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveBalanceSnapshot({
    id: "balance-drift-block",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:01:00.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "1000000",
    balancesJson: "[]",
  });
  await repository.savePositionSnapshot({
    id: "position-drift-block",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:02:00.000Z",
    source: "RECONCILIATION",
    positionsJson: "[]",
  });
  await repository.saveReconciliationRun({
    id: "recon-drift-block",
    exchangeAccountId: "primary",
    status: "DRIFT_DETECTED",
    startedAt: "2026-04-20T00:03:00.000Z",
    completedAt: "2026-04-20T00:03:01.000Z",
    summaryJson: JSON.stringify({
      source: "OPERATOR_SYNC",
      status: "DRIFT_DETECTED",
      issues: [
        { code: "BALANCE_DRIFT_DETECTED", message: "Balance drift." },
      ],
    }),
    errorMessage: null,
  });
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-drift-block",
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
    runtimeConfig: createRuntimeConfig(),
  });

  const response = await router.route("/readiness");

  assert.match(response.text, /overall_status: BLOCK/);
  assert.match(response.text, /- latest_reconciliation: BLOCK \| latest reconciliation status=DRIFT_DETECTED completed_at=2026-04-20T00:03:01.000Z blocking_issue_codes=BALANCE_DRIFT_DETECTED issue_codes=BALANCE_DRIFT_DETECTED/);
});

test("telegram router readiness blocks unhealthy execution state without triggering controllers", async () => {
  const router = new TelegramCommandRouter({
    repositories: new InMemoryExecutionRepository(),
    operatorState: new InMemoryOperatorStateStore({
      id: "state-1",
      exchangeAccountId: "primary",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      systemStatus: "DEGRADED",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: "startup_portfolio_drift_detected",
      degradedAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    }),
    syncController: {
      async requestSync() {
        throw new Error("/readiness must not call syncController");
      },
    },
    strategyRunController: {
      async requestRun() {
        throw new Error("/readiness must not call strategyRunController");
      },
    },
    telegramInboundOffsetStore: {
      async getTelegramInboundOffset() {
        throw new Error("/readiness must not read persisted inbound offsets");
      },
      async saveTelegramInboundOffset() {
        throw new Error("/readiness must not mutate inbound offsets");
      },
    },
  });

  const response = await router.route("/readiness");

  assert.match(response.text, /overall_status: BLOCK/);
  assert.match(response.text, /system_status: DEGRADED/);
  assert.match(response.text, /degraded_reason: startup_portfolio_drift_detected/);
  assert.match(response.text, /- execution_state: BLOCK \| current blockers: DRY_RUN,LIVE_GATE_DISABLED,DEGRADED,DRY_RUN_ADAPTER/);
  assert.match(response.text, /- runtime_config: BLOCK \| runtime configuration was not supplied/);
});

test("telegram router exposes static operator help without touching runtime state", async () => {
  const throwingRepositories = new Proxy(new InMemoryExecutionRepository(), {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value === "function") {
        return () => {
          throw new Error(`/help must not call repository method ${String(property)}`);
        };
      }

      return value;
    },
  });
  const throwingOperatorState = new Proxy(new InMemoryOperatorStateStore({
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
  }), {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value === "function") {
        return () => {
          throw new Error(`/help must not call operator-state method ${String(property)}`);
        };
      }

      return value;
    },
  });
  const router = new TelegramCommandRouter({
    repositories: throwingRepositories,
    operatorState: throwingOperatorState,
    syncController: {
      async requestSync() {
        throw new Error("/help must not call syncController");
      },
    },
    strategyRunController: {
      async requestRun() {
        throw new Error("/help must not call strategyRunController");
      },
    },
    schedulerStatus: () => {
      throw new Error("/help must not read scheduler runtime status");
    },
    telegramInboundStatus: () => {
      throw new Error("/help must not read inbound runtime status");
    },
  });

  const response = await router.route("/help");

  assert.match(response.text, /Operator Help/);
  assert.match(response.text, /state_source: static telegram command contracts/);
  assert.match(response.text, /command_count: 20/);
  assert.match(response.text, /inspection_commands:/);
  assert.match(response.text, /- \/help \| \/help \| Show supported Telegram operator commands and safety boundaries\./);
  assert.match(response.text, /- \/order \| \/order <order-id\|identifier> \| Show one persisted order with lifecycle events and fills\./);
  assert.match(response.text, /control_commands:/);
  assert.match(response.text, /- \/run \| \/run BTC\|ETH \| Run one deterministic PositionGuard strategy cycle for a supported asset through the safe execution path\./);
  assert.match(response.text, /read_only_boundary: \/help never triggers sync, strategy runs, scheduler ticks, exchange reads, order mutation, or live order transmission\./);
  assert.match(response.text, /live_boundary: Live order transmission requires APP_EXECUTION_MODE=LIVE and ENABLE_LIVE_ORDERS=true; the default path remains DRY_RUN\./);
  assert.match(response.text, /operator_boundary: Telegram does not accept manual cash or position input\./);
});

test("telegram router exposes a read-only order lifecycle detail", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveOrder(createOrder({
    id: "order-1",
    identifier: "order-identifier-1",
    upbitUuid: "upbit-uuid-1",
    status: "PARTIALLY_FILLED",
    exchangeResponseJson: JSON.stringify({ uuid: "upbit-uuid-1" }),
    updatedAt: "2026-04-20T00:02:00.000Z",
  }));
  await repository.appendOrderEvent({
    id: "order-event-1",
    orderId: "order-1",
    eventType: "ORDER_PERSISTED",
    eventSource: "LOCAL",
    payloadJson: JSON.stringify({ status: "PERSISTED" }),
    createdAt: "2026-04-20T00:00:01.000Z",
  });
  await repository.appendOrderEvent({
    id: "order-event-2",
    orderId: "order-1",
    eventType: "RECONCILIATION_STATUS_UPDATED",
    eventSource: "RECONCILIATION",
    payloadJson: JSON.stringify({ status: "PARTIALLY_FILLED" }),
    createdAt: "2026-04-20T00:02:00.000Z",
  });
  await repository.saveFill({
    id: "fill-1",
    orderId: "order-1",
    exchangeFillId: "exchange-fill-1",
    market: "KRW-BTC",
    side: "bid",
    price: "500000",
    volume: "0.005",
    feeCurrency: "KRW",
    feeAmount: "250",
    filledAt: "2026-04-20T00:01:00.000Z",
    rawPayloadJson: JSON.stringify({ fill: 1 }),
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

  const response = await router.route("/order order-identifier-1");

  assert.match(response.text, /Order Detail/);
  assert.match(response.text, /query: order-identifier-1/);
  assert.match(response.text, /state_source: persisted orders \+ order_events \+ fills/);
  assert.match(response.text, /id: order-1/);
  assert.match(response.text, /identifier: order-identifier-1/);
  assert.match(response.text, /upbit_uuid: upbit-uuid-1/);
  assert.match(response.text, /status: PARTIALLY_FILLED/);
  assert.match(response.text, /idempotency_key: idempotency-1/);
  assert.match(response.text, /exchange_response_available: true/);
  assert.match(response.text, /event_count: 2/);
  assert.match(response.text, /\| LOCAL \| ORDER_PERSISTED \| payload=\{"status":"PERSISTED"\}/);
  assert.match(response.text, /\| RECONCILIATION \| RECONCILIATION_STATUS_UPDATED \| payload=\{"status":"PARTIALLY_FILLED"\}/);
  assert.match(response.text, /fill_count: 1/);
  assert.match(response.text, /\| KRW-BTC \| bid \| price=500000 \| volume=0\.005 \| fee=250 KRW \| exchange_fill_id=exchange-fill-1/);
  assert.match(response.text, /operator_boundary: Telegram does not accept manual cash or position input\./);
});

test("telegram router reports missing order detail without reading events or fills", async () => {
  let eventLookupCount = 0;
  let fillLookupCount = 0;
  const repository = new InMemoryExecutionRepository();
  const listOrderEvents = repository.listOrderEvents.bind(repository);
  const listFills = repository.listFills.bind(repository);
  repository.listOrderEvents = async (orderId) => {
    eventLookupCount += 1;
    return listOrderEvents(orderId);
  };
  repository.listFills = async (orderId) => {
    fillLookupCount += 1;
    return listFills(orderId);
  };
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

  const response = await router.route("/order unknown-order");

  assert.match(response.text, /Order Detail/);
  assert.match(response.text, /status: not_found/);
  assert.match(response.text, /query: unknown-order/);
  assert.equal(eventLookupCount, 0);
  assert.equal(fillLookupCount, 0);
});

test("telegram router bounds /orders output for delivery-safe summaries", async () => {
  const repository = new InMemoryExecutionRepository();
  for (let index = 0; index < 25; index += 1) {
    await repository.saveOrder(createOrder({
      id: `order-summary-${index}`,
      identifier: `order-summary-identifier-${index}`,
      updatedAt: `2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));
  }
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-orders-summary",
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

  const response = await router.route("/orders");

  assert.match(response.text, /Orders/);
  assert.match(response.text, /count: 25/);
  assert.match(response.text, /displayed_count: 20/);
  assert.match(response.text, /omitted_count: 5/);
  assert.match(response.text, /order-summary-identifier-24/);
  assert.doesNotMatch(response.text, /order-summary-identifier-0/);
  assert.match(response.text, /Use \/order <id\|identifier> for details\./);
});

test("telegram router exposes persisted execution status with explicit blockers", async () => {
  const router = createRouter();

  const status = await router.route("/status");

  assert.match(status.text, /state_source: persisted execution_state/);
  assert.match(status.text, /live_orders_allowed: false/);
  assert.match(status.text, /blocked_by: DRY_RUN,LIVE_GATE_DISABLED,DRY_RUN_ADAPTER/);
  assert.match(status.text, /strategy_scheduler_enabled: unknown/);
  assert.match(status.text, /degraded_reason: none/);
  assert.match(status.text, /degraded_since: none/);
  assert.match(status.text, /recent_sync_source: none/);
  assert.match(status.text, /recent_sync_status: none/);
  assert.match(status.text, /recent_sync_issues: none/);
  assert.match(status.text, /recent_sync_issue_codes: none/);
  assert.match(status.text, /recent_sync_history_coverage_status: none/);
  assert.match(status.text, /recent_sync_history_confidence: none/);
  assert.match(status.text, /recent_sync_history_recovered_orders: none/);
  assert.match(status.text, /recent_sync_history_scanned_snapshots: none/);
  assert.match(status.text, /recent_sync_history_archive_progress: none/);
  assert.match(status.text, /recent_transitions: 1/);
  assert.match(status.text, /\| BOOTSTRAP \| none -> RUNNING \| mode none -> DRY_RUN \| gate none -> DISABLED \|/);
});

test("telegram router includes strategy scheduler state in /status when wired", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveStrategySchedulerRun({
    id: "strategy-scheduler-run-1",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    triggerSource: "SCHEDULER",
    status: "COMPLETED",
    startedAt: "2026-04-20T00:00:00.000Z",
    completedAt: "2026-04-20T00:00:02.000Z",
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
    schedulerStatus: () => ({
      enabled: true,
      started: true,
      exchangeAccountId: "primary",
      liveSendPath: "DRY_RUN_ADAPTER",
      startupPreflight: null,
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 1_800_000,
          running: false,
          runCount: 1,
          successCount: 1,
          failureCount: 0,
          skippedCount: 0,
          lastStartedAt: "2026-04-20T00:00:00.000Z",
          lastCompletedAt: "2026-04-20T00:00:02.000Z",
          lastStatus: "COMPLETED",
          lastStrategyDecisionId: "strategy-decision-1",
          lastAction: "HOLD",
          lastOrderId: null,
          lastOrderStatus: null,
          lastError: null,
          nextRunAt: "2026-04-20T00:30:00.000Z",
        },
      ],
    }),
  });

  const status = await router.route("/status");

  assert.match(status.text, /strategy_scheduler_enabled: true/);
  assert.match(status.text, /strategy_scheduler_started: true/);
  assert.match(status.text, /strategy_scheduler_live_send_path: DRY_RUN_ADAPTER/);
  assert.match(status.text, /- KRW-BTC interval_ms=1800000 running=false next_run_at=2026-04-20T00:30:00.000Z last_status=COMPLETED run_count=1 success=1 failure=0 skipped=0/);
  assert.match(status.text, /last_decision=strategy-decision-1 last_action=HOLD/);
  assert.match(status.text, /strategy_scheduler_recent_runs: 1/);
  assert.match(status.text, /\| KRW-BTC \| COMPLETED \| completed_at=2026-04-20T00:00:02.000Z \| interval_ms=1800000/);
});

test("telegram router exposes dedicated strategy scheduler inspection", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveStrategySchedulerRun({
    id: "strategy-scheduler-run-1",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    triggerSource: "SCHEDULER",
    status: "COMPLETED",
    startedAt: "2026-04-20T00:00:00.000Z",
    completedAt: "2026-04-20T00:00:02.000Z",
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
  });
  await repository.saveStrategySchedulerRun({
    id: "strategy-scheduler-run-2",
    exchangeAccountId: "primary",
    market: "KRW-ETH",
    triggerSource: "SCHEDULER",
    status: "FAILED",
    startedAt: "2026-04-20T00:10:00.000Z",
    completedAt: "2026-04-20T00:10:01.000Z",
    intervalMs: 1_800_000,
    runOnStart: false,
    strategyDecisionId: null,
    action: null,
    orderId: null,
    orderStatus: null,
    submissionAccepted: null,
    detail: null,
    errorMessage: "upbit_timeout",
    summaryJson: JSON.stringify({ status: "FAILED" }),
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
    schedulerStatus: () => ({
      enabled: true,
      started: true,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      startupPreflight: {
        checkedAt: "2026-04-20T00:00:00.000Z",
        scope: "LIVE",
        status: "WARN",
        detail: "Live scheduler startup preflight passed with warnings.",
        checks: [
          {
            name: "latest_reconciliation",
            status: "WARN",
            detail: "Exchange-history archive recovery is still in progress.",
          },
        ],
      },
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 1_800_000,
          running: false,
          runCount: 3,
          successCount: 2,
          failureCount: 1,
          skippedCount: 0,
          lastStartedAt: "2026-04-20T00:00:00.000Z",
          lastCompletedAt: "2026-04-20T00:00:02.000Z",
          lastStatus: "COMPLETED",
          lastStrategyDecisionId: "strategy-decision-1",
          lastAction: "HOLD",
          lastOrderId: null,
          lastOrderStatus: null,
          lastError: null,
          nextRunAt: "2026-04-20T00:30:00.000Z",
        },
      ],
    }),
  });

  const scheduler = await router.route("/scheduler");

  assert.match(scheduler.text, /Strategy Scheduler History/);
  assert.match(scheduler.text, /count: 2/);
  assert.match(scheduler.text, /state_source: runtime scheduler status \+ persisted strategy_scheduler_runs/);
  assert.match(scheduler.text, /runtime_status_source: in-memory scheduler status/);
  assert.match(scheduler.text, /runtime_enabled: true/);
  assert.match(scheduler.text, /runtime_started: true/);
  assert.match(scheduler.text, /runtime_live_send_path: LIVE_ADAPTER/);
  assert.match(scheduler.text, /runtime_startup_preflight_status: WARN/);
  assert.match(scheduler.text, /runtime_startup_preflight_scope: LIVE/);
  assert.match(scheduler.text, /runtime_startup_preflight_checks: 1/);
  assert.match(scheduler.text, /- runtime_preflight latest_reconciliation: WARN \| Exchange-history archive recovery is still in progress\./);
  assert.match(scheduler.text, /- runtime KRW-BTC interval_ms=1800000 running=false next_run_at=2026-04-20T00:30:00.000Z last_status=COMPLETED run_count=3 success=2 failure=1 skipped=0/);
  assert.match(scheduler.text, /2026-04-20T00:10:00.000Z \| KRW-ETH \| FAILED \| trigger=SCHEDULER/);
  assert.match(scheduler.text, /interval_ms=1800000 \| run_on_start=false/);
  assert.match(scheduler.text, /error=upbit_timeout/);
  assert.match(scheduler.text, /2026-04-20T00:00:00.000Z \| KRW-BTC \| COMPLETED \| trigger=SCHEDULER/);
  assert.match(scheduler.text, /decision=strategy-decision-1 \| action=HOLD/);
  assert.match(scheduler.text, /operator_boundary: Telegram does not accept manual cash or position input\./);
});

test("telegram router exposes empty strategy scheduler history", async () => {
  const router = createRouter();

  const scheduler = await router.route("/scheduler");

  assert.match(scheduler.text, /Strategy Scheduler History/);
  assert.match(scheduler.text, /count: 0/);
  assert.match(scheduler.text, /state_source: runtime scheduler status \+ persisted strategy_scheduler_runs/);
  assert.match(scheduler.text, /runtime_status_source: unavailable/);
  assert.match(scheduler.text, /runtime_startup_preflight_checks: none/);
  assert.match(scheduler.text, /note: No strategy scheduler runs are stored yet\./);
});

test("telegram router exposes dedicated telegram inbound inspection", async () => {
  const offsetStore = new InMemoryTelegramInboundOffsetStore();
  await offsetStore.saveTelegramInboundOffset({
    id: "telegram-inbound-offset-1",
    exchangeAccountId: "primary",
    updateSource: "GET_UPDATES",
    botTokenRef: "sha256:bot-a",
    nextOffset: 42,
    lastUpdateId: 41,
    updatedAt: "2026-04-20T00:11:00.000Z",
  });
  const router = new TelegramCommandRouter({
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
    telegramInboundOffsetStore: offsetStore,
    telegramInboundBotTokenRef: "sha256:bot-a",
    telegramInboundStatus: () => ({
      enabled: true,
      configured: true,
      running: true,
      nextOffset: 42,
      pollIntervalMs: 2_000,
      longPollTimeoutSeconds: 25,
      limit: 10,
      lastPollAt: "2026-04-20T00:12:00.000Z",
      lastUpdateId: 41,
      offsetLoaded: true,
      offsetStorage: "DURABLE",
      processedCount: 3,
      ignoredCount: 1,
      failedCount: 0,
      lastError: null,
    }),
  });

  const inbound = await router.route("/inbound");

  assert.match(inbound.text, /Telegram Inbound/);
  assert.match(inbound.text, /state_source: runtime polling status \+ persisted telegram_inbound_offsets/);
  assert.match(inbound.text, /enabled: true/);
  assert.match(inbound.text, /configured: true/);
  assert.match(inbound.text, /running: true/);
  assert.match(inbound.text, /offset_storage: DURABLE/);
  assert.match(inbound.text, /runtime_next_offset: 42/);
  assert.match(inbound.text, /processed_count: 3/);
  assert.match(inbound.text, /ignored_count: 1/);
  assert.match(inbound.text, /persisted_offset_available: true/);
  assert.match(inbound.text, /persisted_bot_token_ref: sha256:bot-a/);
  assert.match(inbound.text, /persisted_next_offset: 42/);
  assert.match(inbound.text, /persisted_last_update_id: 41/);
  assert.match(inbound.text, /operator_boundary: Telegram does not accept manual cash or position input\./);
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
        stopBeforeDays: 365,
        stopBeforeAt: "2025-04-20T00:30:00.000Z",
        retentionAssumptionDays: 365,
        retentionBoundaryAt: "2025-04-20T00:30:00.000Z",
        retentionStatus: "WITHIN_ASSUMED_RETENTION",
        coverageStatus: "IN_PROGRESS",
        confidenceLevel: "PARTIAL",
        confidenceReason: "ARCHIVE_IN_PROGRESS",
        failureMessage: null,
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
            retentionStatus: "WITHIN_ASSUMED_RETENTION",
            openPagesScanned: 1,
            recentClosedPagesScanned: 1,
            archivalClosedPagesScanned: 1,
            archiveComplete: false,
            confidenceLevel: "PARTIAL",
            confidenceReason: "ARCHIVE_IN_PROGRESS",
            openHistoryTruncated: false,
            recentClosedHistoryTruncated: false,
            archivalClosedHistoryTruncated: false,
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
  assert.match(status.text, /recent_sync_history_coverage_status: IN_PROGRESS/);
  assert.match(status.text, /recent_sync_history_confidence: PARTIAL:ARCHIVE_IN_PROGRESS failure=none/);
  assert.match(status.text, /recent_sync_history_recovered_orders: 1/);
  assert.match(status.text, /recent_sync_history_scanned_snapshots: 3/);
  assert.match(status.text, /recent_sync_history_archive_progress: lookback_days=7 stop_before_days=365 stop_before_at=2025-04-20T00:30:00.000Z retention_days=365 retention_boundary_at=2025-04-20T00:30:00.000Z retention=WITHIN_ASSUMED_RETENTION coverage=IN_PROGRESS confidence=PARTIAL:ARCHIVE_IN_PROGRESS failure=none scanned=3 recovered=1 markets=KRW-BTC\[archive=2026-04-06T00:30:00.000Z\.\.2026-04-13T00:30:00.000Z next<=2026-04-06T00:30:00.000Z complete=false retention=WITHIN_ASSUMED_RETENTION confidence=PARTIAL:ARCHIVE_IN_PROGRESS truncated=false\/false\/false pages=1\/1\/1 snapshots=3\]/);
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
        stopBeforeDays: 365,
        stopBeforeAt: "2025-04-20T00:20:00.000Z",
        retentionAssumptionDays: 365,
        retentionBoundaryAt: "2025-04-20T00:20:00.000Z",
        retentionStatus: "WITHIN_ASSUMED_RETENTION",
        coverageStatus: "IN_PROGRESS",
        confidenceLevel: "PARTIAL",
        confidenceReason: "ARCHIVE_IN_PROGRESS",
        failureMessage: null,
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
            retentionStatus: "WITHIN_ASSUMED_RETENTION",
            openPagesScanned: 1,
            recentClosedPagesScanned: 1,
            archivalClosedPagesScanned: 1,
            archiveComplete: false,
            confidenceLevel: "PARTIAL",
            confidenceReason: "ARCHIVE_IN_PROGRESS",
            openHistoryTruncated: false,
            recentClosedHistoryTruncated: false,
            archivalClosedHistoryTruncated: false,
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
  assert.match(history.text, /\| DRIFT_DETECTED \| source=OPERATOR_SYNC \| issues=1 \| codes=ORDER_FILLS_BACKFILLED \| processed=1 \| deferred=0 \| history=lookback_days=7 stop_before_days=365 stop_before_at=2025-04-20T00:20:00.000Z retention_days=365 retention_boundary_at=2025-04-20T00:20:00.000Z retention=WITHIN_ASSUMED_RETENTION coverage=IN_PROGRESS confidence=PARTIAL:ARCHIVE_IN_PROGRESS failure=none scanned=3 recovered=1 markets=KRW-BTC\[archive=2026-04-06T00:20:00.000Z\.\.2026-04-13T00:20:00.000Z next<=2026-04-06T00:20:00.000Z complete=false retention=WITHIN_ASSUMED_RETENTION confidence=PARTIAL:ARCHIVE_IN_PROGRESS truncated=false\/false\/false pages=1\/1\/1 snapshots=3\] \| completed_at=2026-04-20T00:20:05.000Z \| error=none/);
});

test("telegram router exposes dedicated exchange-history recovery inspection", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveReconciliationRun({
    id: "recon-run-recovery-1",
    exchangeAccountId: "primary",
    status: "DRIFT_DETECTED",
    startedAt: "2026-04-20T00:25:00.000Z",
    completedAt: "2026-04-20T00:25:03.000Z",
    summaryJson: JSON.stringify({
      source: "OPERATOR_SYNC",
      status: "DRIFT_DETECTED",
      issues: [
        {
          code: "EXCHANGE_ORDER_RECOVERED",
          message: "Recovered 1 exchange order.",
        },
      ],
      processedCount: 0,
      deferredCount: 0,
      historyRecovery: {
        closedOrderLookbackDays: 7,
        stopBeforeDays: 365,
        stopBeforeAt: "2025-04-20T00:25:00.000Z",
        retentionAssumptionDays: 365,
        retentionBoundaryAt: "2025-04-20T00:25:00.000Z",
        retentionStatus: "WITHIN_ASSUMED_RETENTION",
        coverageStatus: "IN_PROGRESS",
        confidenceLevel: "PARTIAL",
        confidenceReason: "ARCHIVE_IN_PROGRESS",
        failureMessage: null,
        scannedSnapshotCount: 4,
        recoveredOrderCount: 1,
        markets: [
          {
            market: "KRW-BTC",
            recentClosedWindowStartAt: "2026-04-13T00:25:00.000Z",
            recentClosedWindowEndAt: "2026-04-20T00:25:00.000Z",
            archivalWindowStartAt: "2026-04-06T00:25:00.000Z",
            archivalWindowEndAt: "2026-04-13T00:25:00.000Z",
            nextWindowEndAt: "2026-04-06T00:25:00.000Z",
            retentionStatus: "WITHIN_ASSUMED_RETENTION",
            openPagesScanned: 1,
            recentClosedPagesScanned: 2,
            archivalClosedPagesScanned: 1,
            archiveComplete: false,
            confidenceLevel: "PARTIAL",
            confidenceReason: "ARCHIVE_IN_PROGRESS",
            openHistoryTruncated: false,
            recentClosedHistoryTruncated: false,
            archivalClosedHistoryTruncated: false,
            snapshotCount: 4,
          },
        ],
      },
    }),
    errorMessage: null,
  });
  await repository.saveHistoryRecoveryCheckpoint({
    id: "checkpoint-1",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    checkpointType: "CLOSED_ORDER_ARCHIVE",
    nextWindowEndAt: "2026-04-06T00:25:00.000Z",
    updatedAt: "2026-04-20T00:25:03.000Z",
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

  const recovery = await router.route("/recovery");

  assert.match(recovery.text, /Exchange History Recovery/);
  assert.match(recovery.text, /state_source: persisted reconciliation_runs \+ history_recovery_checkpoints/);
  assert.match(recovery.text, /latest_run_started_at: 2026-04-20T00:25:00.000Z/);
  assert.match(recovery.text, /latest_run_status: DRIFT_DETECTED/);
  assert.match(recovery.text, /coverage_status: IN_PROGRESS/);
  assert.match(recovery.text, /confidence_level: PARTIAL/);
  assert.match(recovery.text, /confidence_reason: ARCHIVE_IN_PROGRESS/);
  assert.match(recovery.text, /failure_message: none/);
  assert.match(recovery.text, /history_lookback_days: 7/);
  assert.match(recovery.text, /history_stop_before_days: 365/);
  assert.match(recovery.text, /history_stop_before_at: 2025-04-20T00:25:00.000Z/);
  assert.match(recovery.text, /history_retention_assumption_days: 365/);
  assert.match(recovery.text, /history_retention_boundary_at: 2025-04-20T00:25:00.000Z/);
  assert.match(recovery.text, /history_retention_status: WITHIN_ASSUMED_RETENTION/);
  assert.match(recovery.text, /history_scanned_snapshots: 4/);
  assert.match(recovery.text, /history_recovered_orders: 1/);
  assert.match(recovery.text, /- KRW-BTC \| archive_window=2026-04-06T00:25:00.000Z\.\.2026-04-13T00:25:00.000Z \| next_window_end_at=2026-04-06T00:25:00.000Z \| archive_complete=false \| retention=WITHIN_ASSUMED_RETENTION \| confidence=PARTIAL:ARCHIVE_IN_PROGRESS \| truncated open\/recent\/archive=false\/false\/false \| pages open\/recent\/archive=1\/2\/1 \| snapshots=4/);
  assert.match(recovery.text, /persisted_checkpoints: 1/);
  assert.match(recovery.text, /- KRW-BTC \| CLOSED_ORDER_ARCHIVE \| next_window_end_at=2026-04-06T00:25:00.000Z \| updated_at=2026-04-20T00:25:03.000Z/);
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
  await repository.saveOperatorNotificationDeliveryRun({
    id: "delivery-run-1",
    exchangeAccountId: "primary",
    workerName: "telegram_delivery_inline_worker",
    status: "COMPLETED",
    startedAt: "2026-04-20T00:21:05.000Z",
    completedAt: "2026-04-20T00:21:06.000Z",
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
  assert.match(alerts.text, /delivery_run_count: 1/);
  assert.match(alerts.text, /recent_delivery_runs:/);
  assert.match(alerts.text, /status=COMPLETED \| worker=telegram_delivery_inline_worker \| attempted=1 \| sent=0 \| retry_scheduled=1/);
  assert.match(alerts.text, /recent_stale_lease_count: 0/);
  assert.match(alerts.text, /\| WARN \| ORDER_REJECTED \| PENDING \| attempts=0 \| last_attempt_at=none \| next_attempt_at=none \| failure_class=none \| delivered_at=none \| error=none \| Order rejected before submission \| Exchange order chance does not allow price orders/);
  assert.match(alerts.text, /delivery_attempt_count: 1/);
  assert.match(alerts.text, /\| notification_id=operator-notification-1 \| attempt=1 \| outcome=RETRY_SCHEDULED \| failure_class=RETRYABLE \| next_attempt_at=2026-04-20T00:22:05.000Z \| delivered_at=none \| error=telegram_http_500/);
});

test("telegram router exposes delivery worker queue metrics in /alerts", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveOperatorNotification(createNotification({
    id: "operator-notification-due",
    createdAt: "2026-04-20T00:00:00.000Z",
  }));
  await repository.saveOperatorNotification(createNotification({
    id: "operator-notification-scheduled",
    createdAt: "2026-04-20T00:01:00.000Z",
    nextAttemptAt: "2026-04-20T00:11:00.000Z",
  }));
  await repository.saveOperatorNotification(createNotification({
    id: "operator-notification-active-lease",
    createdAt: "2026-04-20T00:02:00.000Z",
    attemptCount: 1,
    lastAttemptAt: "2026-04-20T00:04:00.000Z",
    leaseToken: "lease-active",
    leaseExpiresAt: "2026-04-20T00:10:00.000Z",
  }));
  await repository.saveOperatorNotification(createNotification({
    id: "operator-notification-expired-lease",
    createdAt: "2026-04-20T00:03:00.000Z",
    attemptCount: 1,
    lastAttemptAt: "2026-04-20T00:03:30.000Z",
    leaseToken: "lease-expired",
    leaseExpiresAt: "2026-04-20T00:04:00.000Z",
  }));
  await repository.saveOperatorNotificationDeliveryAttempt({
    id: "attempt-sent",
    notificationId: "operator-notification-due",
    exchangeAccountId: "primary",
    attemptCount: 1,
    leaseToken: "lease-sent",
    outcome: "SENT",
    failureClass: null,
    attemptedAt: "2026-04-20T00:04:30.000Z",
    nextAttemptAt: null,
    deliveredAt: "2026-04-20T00:04:30.000Z",
    errorMessage: null,
    createdAt: "2026-04-20T00:04:30.000Z",
  });
  await repository.saveOperatorNotificationDeliveryAttempt({
    id: "attempt-failed",
    notificationId: "operator-notification-scheduled",
    exchangeAccountId: "primary",
    attemptCount: 1,
    leaseToken: "lease-failed",
    outcome: "FAILED",
    failureClass: "PERMANENT",
    attemptedAt: "2026-04-20T00:04:40.000Z",
    nextAttemptAt: null,
    deliveredAt: null,
    errorMessage: "telegram_http_403",
    createdAt: "2026-04-20T00:04:40.000Z",
  });
  await repository.saveOperatorNotificationDeliveryAttempt({
    id: "attempt-stale",
    notificationId: "operator-notification-active-lease",
    exchangeAccountId: "primary",
    attemptCount: 1,
    leaseToken: "lease-stale",
    outcome: "STALE_LEASE",
    failureClass: null,
    attemptedAt: "2026-04-20T00:04:50.000Z",
    nextAttemptAt: null,
    deliveredAt: null,
    errorMessage: "stale_lease_finalize",
    createdAt: "2026-04-20T00:04:50.000Z",
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
    now: () => "2026-04-20T00:05:00.000Z",
  });

  const alerts = await router.route("/alerts");

  assert.match(alerts.text, /pending_total_count: 4/);
  assert.match(alerts.text, /pending_due_count: 2/);
  assert.match(alerts.text, /pending_scheduled_count: 1/);
  assert.match(alerts.text, /active_lease_count: 1/);
  assert.match(alerts.text, /expired_lease_count: 1/);
  assert.match(alerts.text, /abandoned_lease_candidate_count: 1/);
  assert.match(alerts.text, /recent_stale_lease_count: 1/);
  assert.match(alerts.text, /recent_sent_attempt_count: 1/);
  assert.match(alerts.text, /recent_retry_scheduled_attempt_count: 0/);
  assert.match(alerts.text, /recent_failed_attempt_count: 1/);
  assert.match(alerts.text, /oldest_pending_created_at: 2026-04-20T00:00:00.000Z/);
  assert.match(alerts.text, /next_scheduled_attempt_at: 2026-04-20T00:11:00.000Z/);
  assert.match(alerts.text, /oldest_active_lease_expires_at: 2026-04-20T00:10:00.000Z/);
  assert.match(alerts.text, /latest_delivery_attempt_at: 2026-04-20T00:04:50.000Z/);
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

test("telegram router exposes strategy run trigger without manual portfolio input", async () => {
  const router = createRouter();

  const missingController = await router.route("/run BTC");
  const invalidAsset = await router.route("/run DOGE");

  assert.match(missingController.text, /Strategy Run/);
  assert.match(missingController.text, /status: NOT_CONNECTED/);
  assert.match(missingController.text, /market: KRW-BTC/);
  assert.match(missingController.text, /PositionGuard strategy runner is not wired/);
  assert.match(missingController.text, /operator_boundary: Telegram does not accept manual cash or position input\./);
  assert.equal(
    invalidAsset.text,
    "Usage: /run BTC|ETH\nRun one deterministic PositionGuard strategy cycle for a supported asset through the safe execution path.",
  );
});

test("telegram router calls a wired strategy run controller for supported assets", async () => {
  const runRequests: string[] = [];
  const router = new TelegramCommandRouter({
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
    strategyRunController: {
      async requestRun(request) {
        runRequests.push(`${request.exchangeAccountId}:${request.market}:${request.requestedCommand}`);
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T00:15:00.000Z",
          market: request.market,
          strategyDecisionId: "strategy-decision-1",
          action: "HOLD",
          orderId: null,
          orderStatus: null,
          submissionAccepted: null,
          detail: "Decision HOLD persisted; no order submission was requested.",
        };
      },
    },
  });

  const response = await router.route("/run ETH");

  assert.deepEqual(runRequests, ["primary:KRW-ETH:/run"]);
  assert.match(response.text, /status: COMPLETED/);
  assert.match(response.text, /market: KRW-ETH/);
  assert.match(response.text, /strategy_decision_id: strategy-decision-1/);
  assert.match(response.text, /action: HOLD/);
  assert.match(response.text, /submission_accepted: none/);
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
