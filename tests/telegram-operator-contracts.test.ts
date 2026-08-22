import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  formatRecoveryProgressMessage,
  formatRiskEventsMessage,
  formatRuntimeConfigMessage,
  formatStateHistoryMessage,
  formatStrategySchedulerRunsMessage,
  formatStrategyPreviewMessage,
  formatStrategyRunMessage,
  formatSyncMessage,
  formatTelegramInboundMessage,
} from "../src/modules/telegram/formatter.js";
import type {
  TelegramStrategyPreviewResult,
  TelegramStrategyRunResult,
  TelegramSyncResult,
} from "../src/modules/telegram/interfaces.js";
import { test } from "./harness.js";

test("formatter remains a re-export-only compatibility facade", () => {
  const formatterSource = readFileSync(
    join(process.cwd(), "src", "modules", "telegram", "formatter.ts"),
    "utf8",
  ).trim();

  assert.equal(
    formatterSource,
    'export * from "./presentation/technical.js";',
  );
});

function createInspectionRuntimeConfig() {
  return {
    serviceName: "AutoTrade_Upbit",
    executionMode: "DRY_RUN" as const,
    liveExecutionGate: "DISABLED" as const,
    liveSendPath: "DRY_RUN_ADAPTER" as const,
    upbitBaseUrl: "https://api.upbit.com",
    databasePath: "./var/operator.sqlite",
    telegramLocale: "ko-KR" as const,
    exchangeBackedReadEnabled: false,
    telegramDeliveryEnabled: true,
    telegramBotTokenConfigured: false,
    telegramOperatorChatIdConfigured: false,
    telegramDeliveryMaxAttempts: 5,
    telegramDeliveryBaseBackoffMs: 15_000,
    telegramDeliveryMaxBackoffMs: 300_000,
    telegramDeliveryLeaseMs: 30_000,
    telegramInboundPollingEnabled: true,
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
  };
}

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
  assert.equal(
    readinessParsed.contract.summary,
    "Show a concise operator readiness summary or the complete technical readiness detail.",
  );
  assert.equal(readinessParsed.contract.usage, "/readiness [detail]");
  assert.ok(parsed);
  assert.equal(parsed.command, "/status");
  assert.deepEqual(parsed.args, []);
  assert.equal(parsed.contract.summary, "Show a concise execution summary or the persisted technical execution detail.");
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
  assert.equal(
    alertsParsed.contract.summary,
    "Show a concise persisted alert and delivery-health summary or the canonical technical list.",
  );
  assert.equal(alertsParsed.contract.usage, "/alerts [detail]");
  assert.ok(risksParsed);
  assert.equal(risksParsed.command, "/risks");
  assert.equal(
    risksParsed.contract.summary,
    "Show a concise persisted risk-history summary or the canonical technical list.",
  );
  assert.equal(risksParsed.contract.usage, "/risks [detail]");
  assert.ok(schedulerParsed);
  assert.equal(schedulerParsed.command, "/scheduler");
  assert.equal(
    schedulerParsed.contract.summary,
    "Show a concise runtime scheduler and persisted-run summary or the canonical technical detail.",
  );
  assert.equal(schedulerParsed.contract.usage, "/scheduler [detail]");
  assert.ok(inboundParsed);
  assert.equal(inboundParsed.command, "/inbound");
  assert.equal(
    inboundParsed.contract.summary,
    "Show a concise Telegram inbound summary or the canonical technical polling and offset detail.",
  );
  assert.equal(inboundParsed.contract.usage, "/inbound [detail]");
  assert.ok(orderParsed);
  assert.equal(orderParsed.command, "/order");
  assert.deepEqual(orderParsed.args, ["order-1"]);
  assert.equal(
    orderParsed.contract.summary,
    "Show a concise persisted order lifecycle summary or the canonical technical detail.",
  );
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

test("balance and position commands accept only optional detail arguments", () => {
  const balancesDetail = parseTelegramCommand("/balances DETAIL");
  const positionsDetail = parseTelegramCommand("/positions detail");
  const balancesExtra = parseTelegramCommand("/balances detail now");
  const positionsExtra = parseTelegramCommand("/positions summary");

  assert.ok(balancesDetail);
  assert.ok(positionsDetail);
  assert.ok(balancesExtra);
  assert.ok(positionsExtra);
  assert.equal(validateTelegramCommand(balancesDetail), null);
  assert.equal(validateTelegramCommand(positionsDetail), null);
  assert.equal(validateTelegramCommand(balancesExtra), buildUsageMessage("/balances"));
  assert.equal(validateTelegramCommand(positionsExtra), buildUsageMessage("/positions"));

  const contracts = listTelegramCommandContracts();
  assert.equal(
    contracts.find((contract) => contract.command === "/balances")?.usage,
    "/balances [detail]",
  );
  assert.equal(
    contracts.find((contract) => contract.command === "/positions")?.usage,
    "/positions [detail]",
  );
});

test("orders command accepts only an optional detail argument", () => {
  const ordersDetail = parseTelegramCommand("/orders DETAIL");
  const ordersExtra = parseTelegramCommand("/orders detail now");
  const ordersSummary = parseTelegramCommand("/orders summary");

  assert.ok(ordersDetail);
  assert.ok(ordersExtra);
  assert.ok(ordersSummary);
  assert.equal(validateTelegramCommand(ordersDetail), null);
  assert.equal(validateTelegramCommand(ordersExtra), buildUsageMessage("/orders"));
  assert.equal(validateTelegramCommand(ordersSummary), buildUsageMessage("/orders"));

  const contract = listTelegramCommandContracts()
    .find((candidate) => candidate.command === "/orders");
  assert.equal(contract?.usage, "/orders [detail]");
  assert.equal(
    contract?.summary,
    "Show a concise recent-order summary or the canonical stored order list.",
  );
});

test("order command accepts a reference with an optional detail argument only", () => {
  const summary = parseTelegramCommand("/order order-1");
  const detail = parseTelegramCommand("/order order-1 DETAIL");
  const missing = parseTelegramCommand("/order");
  const unsupported = parseTelegramCommand("/order order-1 summary");
  const extra = parseTelegramCommand("/order order-1 detail now");

  assert.ok(summary);
  assert.ok(detail);
  assert.ok(missing);
  assert.ok(unsupported);
  assert.ok(extra);
  assert.equal(validateTelegramCommand(summary), null);
  assert.equal(validateTelegramCommand(detail), null);
  assert.equal(validateTelegramCommand(missing), buildUsageMessage("/order"));
  assert.equal(validateTelegramCommand(unsupported), buildUsageMessage("/order"));
  assert.equal(validateTelegramCommand(extra), buildUsageMessage("/order"));

  const contract = listTelegramCommandContracts()
    .find((candidate) => candidate.command === "/order");
  assert.equal(contract?.usage, "/order <order-id|identifier> [detail]");
  assert.equal(
    contract?.summary,
    "Show a concise persisted order lifecycle summary or the canonical technical detail.",
  );
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
  const readinessDetailParsed = parseTelegramCommand("/readiness detail");
  const readinessDetailCaseParsed = parseTelegramCommand("/readiness DETAIL");
  const readinessExtraParsed = parseTelegramCommand("/readiness detail now");
  const statusDetailParsed = parseTelegramCommand("/status detail");
  const statusDetailCaseParsed = parseTelegramCommand("/status DETAIL");
  const invalidStatusParsed = parseTelegramCommand("/status verbose");
  const extraStatusParsed = parseTelegramCommand("/status detail now");
  const parsed = parseTelegramCommand("/resume now");
  const resumeDetailParsed = parseTelegramCommand("/resume detail");
  const syncDetailParsed = parseTelegramCommand("/sync detail");
  const runDetailParsed = parseTelegramCommand("/run BTC detail");
  const historyParsed = parseTelegramCommand("/statehistory now");
  const syncHistoryParsed = parseTelegramCommand("/synchistory now");
  const recoveryParsed = parseTelegramCommand("/recovery now");
  const alertsDetailParsed = parseTelegramCommand("/alerts detail");
  const alertsDetailCaseParsed = parseTelegramCommand("/alerts DETAIL");
  const alertsParsed = parseTelegramCommand("/alerts now");
  const risksDetailParsed = parseTelegramCommand("/risks detail");
  const risksDetailCaseParsed = parseTelegramCommand("/risks DETAIL");
  const risksParsed = parseTelegramCommand("/risks now");
  const schedulerDetailParsed = parseTelegramCommand("/scheduler DETAIL");
  const schedulerParsed = parseTelegramCommand("/scheduler now");
  const inboundDetailParsed = parseTelegramCommand("/inbound DETAIL");
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
  assert.ok(readinessDetailParsed);
  assert.equal(validateTelegramCommand(readinessDetailParsed), null);
  assert.ok(readinessDetailCaseParsed);
  assert.equal(validateTelegramCommand(readinessDetailCaseParsed), null);
  assert.ok(readinessExtraParsed);
  assert.equal(validateTelegramCommand(readinessExtraParsed), buildUsageMessage("/readiness"));
  assert.ok(statusDetailParsed);
  assert.equal(validateTelegramCommand(statusDetailParsed), null);
  assert.ok(statusDetailCaseParsed);
  assert.equal(validateTelegramCommand(statusDetailCaseParsed), null);
  assert.ok(invalidStatusParsed);
  assert.equal(validateTelegramCommand(invalidStatusParsed), buildUsageMessage("/status"));
  assert.ok(extraStatusParsed);
  assert.equal(validateTelegramCommand(extraStatusParsed), buildUsageMessage("/status"));
  assert.ok(parsed);
  assert.equal(
    validateTelegramCommand(parsed),
    buildUsageMessage("/resume"),
  );
  assert.ok(resumeDetailParsed);
  assert.equal(validateTelegramCommand(resumeDetailParsed), buildUsageMessage("/resume"));
  assert.ok(syncDetailParsed);
  assert.equal(validateTelegramCommand(syncDetailParsed), buildUsageMessage("/sync"));
  assert.ok(runDetailParsed);
  assert.equal(validateTelegramCommand(runDetailParsed), buildUsageMessage("/run"));
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
  assert.ok(alertsDetailParsed);
  assert.equal(validateTelegramCommand(alertsDetailParsed), null);
  assert.ok(alertsDetailCaseParsed);
  assert.equal(validateTelegramCommand(alertsDetailCaseParsed), null);
  assert.ok(alertsParsed);
  assert.equal(
    validateTelegramCommand(alertsParsed),
    buildUsageMessage("/alerts"),
  );
  assert.ok(risksParsed);
  assert.ok(risksDetailParsed);
  assert.equal(validateTelegramCommand(risksDetailParsed), null);
  assert.ok(risksDetailCaseParsed);
  assert.equal(validateTelegramCommand(risksDetailCaseParsed), null);
  assert.equal(
    validateTelegramCommand(risksParsed),
    buildUsageMessage("/risks"),
  );
  assert.ok(schedulerDetailParsed);
  assert.equal(validateTelegramCommand(schedulerDetailParsed), null);
  assert.ok(schedulerParsed);
  assert.equal(
    validateTelegramCommand(schedulerParsed),
    buildUsageMessage("/scheduler"),
  );
  assert.ok(inboundDetailParsed);
  assert.equal(validateTelegramCommand(inboundDetailParsed), null);
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
    telegramLocale: "ko-KR",
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

  assert.match(helpMessage, /AutoTrade Upbit 도움말/);
  assert.match(helpMessage, /- \/help/);
  assert.match(helpMessage, /사용법: \/sync/);
  assert.match(helpMessage, /도움말 조회는 동기화, 전략 실행, 스케줄러 실행, 거래소 조회, 주문 변경 또는 실주문 전송을 수행하지 않습니다\./);
  assert.match(helpMessage, /텔레그램에서는 원화 잔고나 코인 보유 수량을 직접 입력할 수 없습니다\./);

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

test("strategy preview presentation localizes every status without changing canonical evidence", () => {
  const cases: ReadonlyArray<{
    status: TelegramStrategyPreviewResult["status"];
    koreanLabel: string;
    nextAction: RegExp;
  }> = [
    { status: "COMPLETED", koreanLabel: "미리보기 완료", nextAction: /\/readiness.*\/run BTC\|ETH/ },
    { status: "ALREADY_RUNNING", koreanLabel: "전략 확인 진행 중", nextAction: /기다린 뒤.*다시 시도/ },
    { status: "NOT_CONNECTED", koreanLabel: "미리보기 기능 연결 안 됨", nextAction: /\/config.*프로세스/ },
    { status: "FAILED", koreanLabel: "미리보기 실패", nextAction: /detail.*\/alerts/ },
  ];

  for (const testCase of cases) {
    const message = formatStrategyPreviewMessage(
      createStrategyPreviewResult({ status: testCase.status }),
      "ko-KR",
    );

    assert.match(message, /전략 미리보기 \(Strategy Preview\)/);
    assert.match(message, new RegExp(`상태: ${testCase.koreanLabel}`));
    assert.match(message, testCase.nextAction);
    assert.match(message, new RegExp(`status: ${testCase.status}`));
    assert.match(message, /전략 판단을 저장하지 않았습니다/);
    assert.match(message, /주문을 전송하지 않았습니다/);
  }
});

test("strategy preview presentation covers actions and execution dispositions including unknown values", () => {
  const actionCases: ReadonlyArray<[TelegramStrategyPreviewResult["action"], string]> = [
    ["ENTER", "신규 매수 판단"],
    ["ADD", "추가 매수 판단"],
    ["HOLD", "관망 판단"],
    ["REDUCE", "일부 매도 판단"],
    ["EXIT", "매도 종료 판단"],
    [null, "판단 없음"],
  ];
  const dispositionCases: ReadonlyArray<[string | null, string]> = [
    ["IMMEDIATE", "즉시 처리"],
    ["DEFERRED_CONFIRMATION", "추가 확인 대기"],
    ["EXECUTED_AFTER_CONFIRMATION", "확인 후 처리"],
    ["SKIPPED", "처리 생략"],
    ["FUTURE_DISPOSITION", "알 수 없는 처리 상태 (FUTURE_DISPOSITION)"],
    [null, "처리 상태 없음"],
  ];

  for (const [action, expected] of actionCases) {
    const message = formatStrategyPreviewMessage(
      createStrategyPreviewResult({ action }),
      "ko-KR",
    );
    assert.match(message, new RegExp(`판단: ${expected}`));
    assert.match(message, new RegExp(`action: ${action ?? "none"}`));
  }

  for (const [executionDisposition, expected] of dispositionCases) {
    const message = formatStrategyPreviewMessage(
      createStrategyPreviewResult({ executionDisposition }),
      "ko-KR",
    );
    assert.ok(message.includes(`실행 처리: ${expected}`));
    assert.match(
      message,
      new RegExp(`execution_disposition: ${executionDisposition ?? "none"}`),
    );
  }
});

test("strategy preview presentation explains HOLD and Upbit order intent semantics", () => {
  const hold = formatStrategyPreviewMessage(
    createStrategyPreviewResult({
      action: "HOLD",
      executionDisposition: "SKIPPED",
      requestedNotionalKrw: null,
      orderSide: null,
      orderType: null,
      orderPrice: null,
    }),
    "ko-KR",
  );
  const marketBuy = formatStrategyPreviewMessage(
    createStrategyPreviewResult({
      orderSide: "bid",
      orderType: "price",
      orderPrice: "150000",
      orderVolume: null,
    }),
    "ko-KR",
  );
  const marketSell = formatStrategyPreviewMessage(
    createStrategyPreviewResult({
      market: "KRW-ETH",
      action: "EXIT",
      orderSide: "ask",
      orderType: "market",
      orderPrice: null,
      orderVolume: "0.25",
      requestedQuantity: 0.25,
    }),
    "ko-KR",
  );
  const limit = formatStrategyPreviewMessage(
    createStrategyPreviewResult({
      market: "KRW-ETH",
      action: "ADD",
      orderSide: "bid",
      orderType: "limit",
      orderPrice: "5000000",
      orderVolume: "0.125",
      requestedQuantity: 0.125,
    }),
    "ko-KR",
  );

  assert.match(hold, /주문 의도: 없음 \(미리보기 결과에 주문 의도가 없습니다\.\)/);
  assert.match(marketBuy, /시장가 매수 의도.*KRW 지출 금액 150,000원/);
  assert.match(marketSell, /시장가 매도 의도.*매도 수량 0\.25 ETH/);
  assert.match(limit, /지정가 매수 의도.*주문 단가 5,000,000원.*주문 수량 0\.125 ETH/);
  assert.doesNotMatch(marketBuy, /주문 (실행|제출|접수|저장)/);
});

test("strategy preview presentation rejects non-decimal, non-finite, and unsafe order prices without changing canonical values", () => {
  const invalidOrderPrices = [
    "0x10",
    "1e3",
    "Infinity",
    "-Infinity",
    "NaN",
    "9007199254740993",
  ];

  for (const orderPrice of invalidOrderPrices) {
    const korean = formatStrategyPreviewMessage(
      createStrategyPreviewResult({ orderPrice }),
      "ko-KR",
    );
    const english = formatStrategyPreviewMessage(
      createStrategyPreviewResult({ orderPrice }),
      "en-US",
    );

    assert.match(korean, /시장가 매수 의도 - KRW 지출 금액 없음/);
    assert.match(english, /Market buy intent - KRW spend amount none/);
    assert.ok(korean.includes(`order_price: ${orderPrice}`));
    assert.ok(english.includes(`order_price: ${orderPrice}`));
  }

  const invalidLimit = formatStrategyPreviewMessage(
    createStrategyPreviewResult({
      orderType: "limit",
      orderPrice: "0x10",
      orderVolume: "0.0015",
    }),
    "ko-KR",
  );
  assert.match(invalidLimit, /지정가 매수 의도 - 주문 단가 없음, 주문 수량 0\.0015 BTC/);
  assert.match(invalidLimit, /order_price: 0x10/);
});

test("strategy preview presentation formats valid plain-decimal order prices without precision loss", () => {
  const exactSafeInteger = formatStrategyPreviewMessage(
    createStrategyPreviewResult({ orderPrice: "9007199254740991" }),
    "ko-KR",
  );
  const roundedDecimal = formatStrategyPreviewMessage(
    createStrategyPreviewResult({ orderPrice: "00150000.50" }),
    "en-US",
  );

  assert.match(exactSafeInteger, /KRW 지출 금액 9,007,199,254,740,991원/);
  assert.match(exactSafeInteger, /order_price: 9007199254740991/);
  assert.match(roundedDecimal, /KRW spend amount KRW 150,001/);
  assert.match(roundedDecimal, /order_price: 00150000\.50/);
});

test("strategy preview presentation formats BTC and ETH values while retaining raw invalid evidence and exact detail", () => {
  const detail = `원문 & <tag> > "quoted" 'single' 한국어`;
  const valid = formatStrategyPreviewMessage(
    createStrategyPreviewResult({ detail }),
    "ko-KR",
  );
  const invalid = formatStrategyPreviewMessage(
    createStrategyPreviewResult({
      requestedAt: "not-a-timestamp",
      market: "KRW-ETH",
      referencePrice: Number.NaN,
      requestedNotionalKrw: Number.POSITIVE_INFINITY,
      requestedQuantity: Number.NaN,
      detail,
    }),
    "ko-KR",
  );

  assert.match(valid, /시장\/자산: KRW-BTC \/ BTC/);
  assert.match(valid, /기준 가격: 100,000,000원/);
  assert.match(valid, /요청 금액: 150,000원/);
  assert.match(valid, /요청 수량: 0\.0015 BTC/);
  assert.match(valid, /요청 시각: 2026-04-20 09:11:00 KST/);
  assert.match(invalid, /시장\/자산: KRW-ETH \/ ETH/);
  assert.match(invalid, /기준 가격: 없음/);
  assert.match(invalid, /요청 금액: 없음/);
  assert.match(invalid, /요청 수량: 없음/);
  assert.match(invalid, /요청 시각: 없음/);
  assert.match(invalid, /requested_at: not-a-timestamp/);
  assert.ok(valid.includes(`detail: ${detail}`));
  assert.ok(invalid.includes(`detail: ${detail}`));
});

test("strategy preview presentation provides equivalent English output and retains every canonical field", () => {
  const result = createStrategyPreviewResult({
    status: "COMPLETED",
    market: "KRW-ETH",
    action: "REDUCE",
    executionDisposition: "DEFERRED_CONFIRMATION",
    referencePrice: 5_000_000,
    requestedNotionalKrw: 625_000,
    requestedQuantity: 0.125,
    orderSide: "ask",
    orderType: "limit",
    orderPrice: "5000000",
    orderVolume: "0.125",
    detail: "Intent only; state can change.",
  });
  const message = formatStrategyPreviewMessage(result, "en-US");

  assert.match(message, /Strategy Preview/);
  assert.match(message, /State: Preview completed/);
  assert.match(message, /Market\/asset: KRW-ETH \/ ETH/);
  assert.match(message, /Action: Partial sell decision/);
  assert.match(message, /Execution disposition: Deferred for confirmation/);
  assert.match(message, /Order intent: Limit sell intent.*unit price KRW 5,000,000.*quantity 0\.125 ETH/);
  assert.match(message, /No strategy decision was persisted/);
  assert.match(message, /No order was sent/);

  const canonicalLines = [
    "status: COMPLETED",
    "requested_at: 2026-04-20T00:11:00.000Z",
    "market: KRW-ETH",
    "action: REDUCE",
    "execution_disposition: DEFERRED_CONFIRMATION",
    "reference_price: 5000000",
    "requested_notional_krw: 625000",
    "requested_quantity: 0.125",
    "order_side: ask",
    "order_type: limit",
    "order_price: 5000000",
    "order_volume: 0.125",
    "detail: Intent only; state can change.",
    "no_mutation_boundary: /preview never persists strategy decisions, creates orders, sends orders, or triggers reconciliation.",
    "operator_boundary: Telegram does not accept manual cash or position input.",
  ];
  for (const line of canonicalLines) {
    assert.ok(message.includes(line), `missing canonical line: ${line}`);
  }
});

function createStrategyPreviewResult(
  overrides: Partial<TelegramStrategyPreviewResult> = {},
): TelegramStrategyPreviewResult {
  return {
    status: "COMPLETED",
    requestedAt: "2026-04-20T00:11:00.000Z",
    market: "KRW-BTC",
    action: "ENTER",
    executionDisposition: "IMMEDIATE",
    referencePrice: 100_000_000,
    requestedNotionalKrw: 150_000,
    requestedQuantity: 0.0015,
    orderSide: "bid",
    orderType: "price",
    orderPrice: "150000",
    orderVolume: null,
    detail: "Preview computed without persistence or order submission.",
    ...overrides,
  };
}

test("strategy run presentation localizes every status without changing canonical evidence", () => {
  const cases: ReadonlyArray<{
    status: TelegramStrategyRunResult["status"];
    koreanLabel: string;
    nextAction: RegExp;
  }> = [
    { status: "COMPLETED", koreanLabel: "실행 요청 처리 완료", nextAction: /\/preview.*다음 주기/ },
    { status: "ALREADY_RUNNING", koreanLabel: "전략 실행 진행 중", nextAction: /기다린 뒤.*다시 시도/ },
    { status: "SKIPPED", koreanLabel: "전략 실행 생략", nextAction: /detail.*\/readiness/ },
    { status: "NOT_CONNECTED", koreanLabel: "전략 실행 기능 연결 안 됨", nextAction: /\/config.*프로세스/ },
    { status: "FAILED", koreanLabel: "전략 실행 실패", nextAction: /detail.*\/alerts/ },
  ];

  for (const testCase of cases) {
    const message = formatStrategyRunMessage(
      createStrategyRunResult({ status: testCase.status }),
      "ko-KR",
    );

    assert.match(message, /전략 실행 결과 \(Strategy Run\)/);
    assert.match(message, new RegExp(`상태: ${testCase.koreanLabel}`));
    assert.match(message, testCase.nextAction);
    assert.match(message, new RegExp(`status: ${testCase.status}`));
    assert.match(message, /LIVE 모드.*실주문/);
  }
});

test("strategy run presentation covers actions and submission outcomes without calling acceptance a fill", () => {
  const actionCases: ReadonlyArray<[TelegramStrategyRunResult["action"], string]> = [
    ["ENTER", "신규 매수"],
    ["ADD", "추가 매수"],
    ["HOLD", "관망"],
    ["REDUCE", "일부 매도"],
    ["EXIT", "매도 종료"],
    [null, "판단 없음"],
  ];

  for (const [action, expected] of actionCases) {
    const message = formatStrategyRunMessage(
      createStrategyRunResult({ action }),
      "ko-KR",
    );
    assert.match(message, new RegExp(`판단: ${expected}`));
    assert.match(message, new RegExp(`action: ${action ?? "none"}`));
  }

  const noRequest = formatStrategyRunMessage(
    createStrategyRunResult({
      action: "HOLD",
      submissionAccepted: null,
      orderId: null,
      orderStatus: null,
    }),
    "ko-KR",
  );
  const accepted = formatStrategyRunMessage(
    createStrategyRunResult({
      action: "ENTER",
      submissionAccepted: true,
      orderId: "order-accepted-1",
      orderStatus: "OPEN",
    }),
    "ko-KR",
  );
  const rejected = formatStrategyRunMessage(
    createStrategyRunResult({
      action: "ENTER",
      submissionAccepted: false,
      orderId: null,
      orderStatus: null,
      detail: "위험 정책에서 거부됨 & exact <detail>",
    }),
    "ko-KR",
  );

  assert.match(noRequest, /주문 결과: 주문 요청 없음/);
  assert.match(noRequest, /주문을 요청하지 않았습니다/);
  assert.match(accepted, /주문 결과: 주문 접수됨/);
  assert.match(accepted, /체결을 의미하지 않습니다/);
  assert.match(accepted, /\/order order-accepted-1/);
  assert.doesNotMatch(accepted, /주문 (체결됨|체결 완료)/);
  assert.match(rejected, /주문 결과: 주문 거부됨/);
  assert.match(rejected, /\/risks.*\/alerts/);
  assert.ok(rejected.includes("detail: 위험 정책에서 거부됨 & exact <detail>"));
});

test("strategy run presentation labels lifecycle states while retaining raw values", () => {
  const lifecycleCases: ReadonlyArray<[
    NonNullable<TelegramStrategyRunResult["orderStatus"]>,
    string,
  ]> = [
    ["OPEN", "주문 열림"],
    ["PARTIALLY_FILLED", "부분 체결"],
    ["FILLED", "체결 완료"],
    ["CANCELED", "주문 취소"],
    ["FAILED", "주문 실패"],
    ["RECONCILIATION_REQUIRED", "동기화 확인 필요"],
  ];

  for (const [orderStatus, readable] of lifecycleCases) {
    const message = formatStrategyRunMessage(
      createStrategyRunResult({
        submissionAccepted: true,
        orderId: `order-${orderStatus}`,
        orderStatus,
      }),
      "ko-KR",
    );
    assert.match(message, new RegExp(`주문 상태: ${readable}`));
    assert.match(message, new RegExp(`order_status: ${orderStatus}`));
    assert.match(message, /주문 접수는 체결 증명이 아닙니다/);
  }
});

test("strategy run presentation formats KST, preserves invalid raw time and exact detail", () => {
  const detail = `원문 & <tag> > "quoted" 'single' 한국어`;
  const valid = formatStrategyRunMessage(
    createStrategyRunResult({ detail }),
    "ko-KR",
  );
  const invalid = formatStrategyRunMessage(
    createStrategyRunResult({
      requestedAt: "not-a-timestamp",
      market: null,
      strategyDecisionId: null,
      action: null,
      orderId: null,
      orderStatus: null,
      submissionAccepted: null,
      detail,
    }),
    "ko-KR",
  );

  assert.match(valid, /요청 시각: 2026-04-20 09:15:00 KST/);
  assert.match(invalid, /요청 시각: 없음/);
  assert.match(invalid, /requested_at: not-a-timestamp/);
  assert.match(invalid, /시장\/자산: 없음/);
  assert.match(invalid, /전략 판단 ID: 없음/);
  assert.ok(valid.includes(`detail: ${detail}`));
  assert.ok(invalid.includes(`detail: ${detail}`));
});

test("strategy run presentation provides equivalent English output and retains every canonical field", () => {
  const result = createStrategyRunResult({
    status: "COMPLETED",
    market: "KRW-ETH",
    strategyDecisionId: "decision-en-1",
    action: "REDUCE",
    submissionAccepted: true,
    orderId: "order-en-1",
    orderStatus: "PARTIALLY_FILLED",
    detail: "Order accepted; inspect lifecycle.",
  });
  const message = formatStrategyRunMessage(result, "en-US");

  assert.match(message, /Strategy Run Result/);
  assert.match(message, /State: Run request processed/);
  assert.match(message, /Market\/asset: KRW-ETH \/ ETH/);
  assert.match(message, /Action: Partial sell/);
  assert.match(message, /Submission: Order accepted/);
  assert.match(message, /Acceptance is not proof of a fill/);
  assert.match(message, /Order state: Partially filled/);
  assert.match(message, /In LIVE mode, \/run can send a real order/);
  assert.match(message, /\/order order-en-1/);

  const canonicalLines = [
    "status: COMPLETED",
    "requested_at: 2026-04-20T00:15:00.000Z",
    "market: KRW-ETH",
    "strategy_decision_id: decision-en-1",
    "action: REDUCE",
    "submission_accepted: true",
    "order_id: order-en-1",
    "order_status: PARTIALLY_FILLED",
    "detail: Order accepted; inspect lifecycle.",
    "operator_boundary: Telegram does not accept manual cash or position input.",
  ];
  for (const line of canonicalLines) {
    assert.ok(message.includes(line), `missing canonical line: ${line}`);
  }
});

function createStrategyRunResult(
  overrides: Partial<TelegramStrategyRunResult> = {},
): TelegramStrategyRunResult {
  return {
    status: "COMPLETED",
    requestedAt: "2026-04-20T00:15:00.000Z",
    market: "KRW-BTC",
    strategyDecisionId: "strategy-decision-1",
    action: "HOLD",
    orderId: null,
    orderStatus: null,
    submissionAccepted: null,
    detail: "Decision HOLD persisted; no order submission was requested.",
    ...overrides,
  };
}

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
    async pauseForFault() {
      return currentState;
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

  const statusResponse = await router.route("/status detail");
  const historyResponse = await router.route("/statehistory");
  const syncHistoryResponse = await router.route("/synchistory");
  const recoveryResponse = await router.route("/recovery");
  const alertsResponse = await router.route("/alerts detail");
  const risksResponse = await router.route("/risks detail");
  const schedulerResponse = await router.route("/scheduler detail");
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
  assert.match(inboundResponse.text, /텔레그램 명령 수신/);
  assert.match(inboundResponse.text, /활성화 예 \| 설정 완료 예 \| 실행 중 아니요/);
  assert.match(inboundResponse.text, /다음 오프셋 88 \| 최근 업데이트 ID 87/);
  assert.match(inboundResponse.text, /런타임과 저장 오프셋 비교: 동기화됨/);
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
    "Usage: /alerts [detail]\nShow a concise persisted alert and delivery-health summary or the canonical technical list.",
  );
  assert.equal(
    invalidRisksResponse.text,
    "Usage: /risks [detail]\nShow a concise persisted risk-history summary or the canonical technical list.",
  );
  const invalidSchedulerResponse = await router.route("/scheduler now");
  assert.equal(
    invalidSchedulerResponse.text,
    "Usage: /scheduler [detail]\nShow a concise runtime scheduler and persisted-run summary or the canonical technical detail.",
  );
  const invalidInboundResponse = await router.route("/inbound now");
  assert.equal(
    invalidInboundResponse.text,
    "Usage: /inbound [detail]\nShow a concise Telegram inbound summary or the canonical technical polling and offset detail.",
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

test("formatSyncMessage presents every sync status in Korean with canonical evidence", () => {
  const cases = [
    {
      status: "COMPLETED",
      readableStatus: "동기화 요청 완료",
      explanation: "동기화 요청이 완료되었습니다.",
      nextAction: "/readiness",
    },
    {
      status: "ALREADY_RUNNING",
      readableStatus: "동기화 진행 중",
      explanation: "이미 동기화 요청이 진행 중입니다.",
      nextAction: "/synchistory",
    },
    {
      status: "NOT_CONNECTED",
      readableStatus: "동기화 기능 연결 안 됨",
      explanation: "이 프로세스에 동기화 기능이 연결되지 않았습니다.",
      nextAction: "/config",
    },
    {
      status: "FAILED",
      readableStatus: "동기화 실패",
      explanation: "동기화 요청을 완료하지 못했습니다.",
      nextAction: "/alerts",
    },
  ] as const;

  for (const entry of cases) {
    const message = formatSyncMessage({
      status: entry.status,
      requestedAt: "2026-07-16T00:30:45.000Z",
      detail: "drift & <gap> \"확인\" '필요'",
    }, "ko-KR");

    assert.match(message, new RegExp(`^${entry.readableStatus}`, "u"));
    assert.match(message, new RegExp(entry.explanation, "u"));
    assert.match(message, new RegExp(entry.nextAction.replace("/", "\\/"), "u"));
    assert.match(message, /요청 시각: 2026-07-16 09:30:45 KST/u);
    assert.match(message, new RegExp(`status: ${entry.status}`, "u"));
    assert.match(message, /requested_at: 2026-07-16T00:30:45\.000Z/u);
    assert.ok(message.includes("detail: drift & <gap> \"확인\" '필요'"));
    assert.match(message, /Telegram은 수동 현금 또는 포지션 입력을 받지 않습니다\./u);
  }
});

test("formatSyncMessage supports equivalent English presentation", () => {
  const message = formatSyncMessage({
    status: "COMPLETED",
    requestedAt: "2026-07-16T00:30:45.000Z",
    detail: "Request completed; reconciliation detail may still report drift.",
  }, "en-US");

  assert.match(message, /^Sync request completed/u);
  assert.match(message, /The sync request completed\./u);
  assert.match(message, /Next action: Inspect \/readiness/u);
  assert.match(message, /Requested at: 2026-07-16 09:30:45 KST/u);
  assert.match(message, /status: COMPLETED/u);
  assert.match(message, /requested_at: 2026-07-16T00:30:45\.000Z/u);
  assert.match(message, /detail: Request completed; reconciliation detail may still report drift\./u);
  assert.match(message, /Telegram does not accept manual cash or position input\./u);
});

test("configuration presentation is Korean-first, supports English, and never renders secret values", () => {
  const config = createInspectionRuntimeConfig();
  const korean = formatRuntimeConfigMessage(config, "ko-KR");
  const english = formatRuntimeConfigMessage(config, "en-US");
  const missingKorean = formatRuntimeConfigMessage(null, "ko-KR");
  const missingEnglish = formatRuntimeConfigMessage(null, "en-US");

  assert.match(korean, /^실행 설정 \(Runtime Config\)/u);
  assert.match(korean, /실행 모드: 모의 실행 \(DRY_RUN\)/u);
  assert.match(korean, /실주문: 차단됨/u);
  assert.match(korean, /필수 설정 누락: Telegram 봇 토큰, Telegram 운영자 채팅 ID/u);
  assert.doesNotMatch(korean, /필수 설정 누락:.*Upbit 조회 자격 증명/u);
  assert.match(korean, /무시되는 이전 환경 변수: MAX_LIVE_ORDER_VALUE_KRW/u);
  assert.match(english, /^Runtime configuration \(Runtime Config\)/u);
  assert.match(english, /Execution mode: dry run \(DRY_RUN\)/u);
  assert.match(english, /Missing required configuration: Telegram bot token, Telegram operator chat ID/u);
  assert.doesNotMatch(english, /Missing required configuration:.*Upbit read credentials/u);
  assert.match(missingKorean, /실행 설정을 확인할 수 없습니다/u);
  assert.match(missingEnglish, /Runtime configuration is unavailable/u);

  for (const message of [korean, english]) {
    assert.match(message, /state_source: runtime app configuration/u);
    assert.match(message, /execution_mode: DRY_RUN/u);
    assert.match(message, /live_gate: DISABLED/u);
    assert.match(message, /live_send_path: DRY_RUN_ADAPTER/u);
    assert.match(message, /telegram_bot_token_configured: false/u);
    assert.match(message, /telegram_operator_chat_id_configured: false/u);
    assert.match(message, /deprecated_ignored_env_vars: MAX_LIVE_ORDER_VALUE_KRW/u);
    assert.doesNotMatch(message, /123456:secret-token|upbit-secret-value|operator-chat-secret/u);
  }
});

test("configuration presentation requires credentials only for enabled LIVE and Telegram capabilities", () => {
  const offlineDryRun = {
    ...createInspectionRuntimeConfig(),
    telegramDeliveryEnabled: false,
    telegramInboundPollingEnabled: false,
  };
  const liveWithoutUpbitReads = {
    ...offlineDryRun,
    executionMode: "LIVE" as const,
    liveExecutionGate: "ENABLED" as const,
    liveSendPath: "LIVE_ADAPTER" as const,
  };
  const telegramEnabled = {
    ...offlineDryRun,
    telegramDeliveryEnabled: true,
  };

  const offlineKorean = formatRuntimeConfigMessage(offlineDryRun, "ko-KR");
  const offlineEnglish = formatRuntimeConfigMessage(offlineDryRun, "en-US");
  const liveKorean = formatRuntimeConfigMessage(liveWithoutUpbitReads, "ko-KR");
  const liveEnglish = formatRuntimeConfigMessage(liveWithoutUpbitReads, "en-US");
  const telegramKorean = formatRuntimeConfigMessage(telegramEnabled, "ko-KR");
  const telegramEnglish = formatRuntimeConfigMessage(telegramEnabled, "en-US");

  assert.match(offlineKorean, /필수 설정 누락: 없음/u);
  assert.match(offlineEnglish, /Missing required configuration: none/u);
  assert.match(liveKorean, /필수 설정 누락: Upbit 조회 자격 증명/u);
  assert.match(liveEnglish, /Missing required configuration: Upbit read credentials/u);
  assert.match(telegramKorean, /필수 설정 누락: Telegram 봇 토큰, Telegram 운영자 채팅 ID/u);
  assert.match(telegramEnglish, /Missing required configuration: Telegram bot token, Telegram operator chat ID/u);

  for (const message of [
    offlineKorean,
    offlineEnglish,
    liveKorean,
    liveEnglish,
    telegramKorean,
    telegramEnglish,
  ]) {
    assert.match(message, /exchange_backed_read_enabled: false/u);
    assert.match(message, /telegram_bot_token_configured: false/u);
    assert.match(message, /telegram_operator_chat_id_configured: false/u);
    assert.match(message, /secret_boundary: secret values are never rendered/u);
  }
});

test("execution-state history presentation handles empty and populated evidence with KST and exact canonical rows", () => {
  const transition = {
    id: "transition-localized-1",
    exchangeAccountId: "primary",
    command: "/pause" as const,
    fromExecutionMode: "LIVE" as const,
    toExecutionMode: "LIVE" as const,
    fromLiveExecutionGate: "ENABLED" as const,
    toLiveExecutionGate: "ENABLED" as const,
    fromSystemStatus: "RUNNING" as const,
    toSystemStatus: "PAUSED" as const,
    fromKillSwitchActive: false,
    toKillSwitchActive: false,
    reason: `정기 점검 & exact <reason>`,
    createdAt: "2026-07-29T00:30:45.000Z",
  };
  const canonical = "- 2026-07-29T00:30:45.000Z | /pause | RUNNING -> PAUSED | mode LIVE -> LIVE | gate ENABLED -> ENABLED | reason=정기 점검 & exact <reason>";
  const korean = formatStateHistoryMessage([transition], "ko-KR");
  const english = formatStateHistoryMessage([transition], "en-US");
  const empty = formatStateHistoryMessage([], "ko-KR");
  const emptyEnglish = formatStateHistoryMessage([], "en-US");

  assert.match(korean, /^실행 상태 변경 이력 \(Execution State History\)/u);
  assert.match(korean, /저장된 과거 기록이며 현재 실행 상태를 증명하지 않습니다/u);
  assert.match(korean, /2026-07-29 09:30:45 KST/u);
  assert.match(korean, /운영자 일시정지/u);
  assert.match(english, /^Execution-state history \(Execution State History\)/u);
  assert.match(english, /persisted history and does not prove the current execution state/u);
  assert.match(empty, /저장된 실행 상태 변경 기록이 없습니다/u);
  assert.match(emptyEnglish, /No execution-state transitions are stored/u);
  for (const message of [korean, english]) {
    assert.ok(message.includes(canonical));
    assert.match(message, /state_source: persisted execution_state_transitions/u);
  }
});

test("reconciliation history presentation explains latest persisted evidence without changing canonical rows", () => {
  const detail = `stored error & exact <message>`;
  const run = {
    id: "recon-localized-1",
    exchangeAccountId: "primary",
    status: "DRIFT_DETECTED" as const,
    startedAt: "2026-07-29T00:40:00.000Z",
    completedAt: "2026-07-29T00:40:05.000Z",
    summaryJson: JSON.stringify({
      source: "SCHEDULER_PREFLIGHT",
      issues: [
        { code: "EXCHANGE_ORDER_RECOVERED" },
        { code: "ORDER_FILLS_BACKFILLED" },
      ],
      processedCount: 2,
      deferredCount: 0,
      historyRecovery: {
        coverageStatus: "IN_PROGRESS",
        confidenceLevel: "PARTIAL",
        confidenceReason: "ARCHIVE_IN_PROGRESS",
      },
    }),
    errorMessage: detail,
  };
  const korean = formatReconciliationRunsMessage([run], "ko-KR");
  const english = formatReconciliationRunsMessage([run], "en-US");
  const empty = formatReconciliationRunsMessage([], "ko-KR");
  const emptyEnglish = formatReconciliationRunsMessage([], "en-US");

  assert.match(korean, /^동기화 이력 \(Reconciliation History\)/u);
  assert.match(korean, /최근 결과: 차이 감지 \(DRIFT_DETECTED\)/u);
  assert.match(korean, /감지 항목: 2건/u);
  assert.match(korean, /이력 범위: 진행 중 \(IN_PROGRESS\)/u);
  assert.match(korean, /신뢰도: 부분 확인 \(PARTIAL\).*ARCHIVE_IN_PROGRESS/u);
  assert.match(korean, /2026-07-29 09:40:00 KST/u);
  assert.match(english, /^Reconciliation history \(Reconciliation History\)/u);
  assert.match(english, /Latest outcome: drift detected \(DRIFT_DETECTED\)/u);
  assert.match(empty, /저장된 동기화 실행 기록이 없습니다/u);
  assert.match(emptyEnglish, /No reconciliation runs are stored/u);
  for (const message of [korean, english]) {
    assert.match(message, /state_source: persisted reconciliation_runs/u);
    assert.match(message, /codes=EXCHANGE_ORDER_RECOVERED,ORDER_FILLS_BACKFILLED/u);
    assert.ok(message.includes(`error=${detail}`));
  }
});

test("recovery presentation explains persisted coverage, retention, progress, and checkpoints without overstating completion", () => {
  const storedFailure = `archive delayed & exact <failure>`;
  const latestRun = {
    id: "recovery-localized-1",
    exchangeAccountId: "primary",
    status: "DRIFT_DETECTED" as const,
    startedAt: "2026-07-29T00:50:00.000Z",
    completedAt: "2026-07-29T00:50:05.000Z",
    summaryJson: JSON.stringify({
      source: "STARTUP_RECOVERY",
      issues: [{ code: "EXCHANGE_ORDER_RECOVERED" }],
      historyRecovery: {
        closedOrderLookbackDays: 7,
        stopBeforeDays: 365,
        stopBeforeAt: "2025-07-29T00:50:00.000Z",
        retentionAssumptionDays: 365,
        retentionBoundaryAt: "2025-07-29T00:50:00.000Z",
        retentionStatus: "WITHIN_ASSUMED_RETENTION",
        coverageStatus: "IN_PROGRESS",
        confidenceLevel: "PARTIAL",
        confidenceReason: "ARCHIVE_IN_PROGRESS",
        failureMessage: storedFailure,
        scannedSnapshotCount: 5,
        recoveredOrderCount: 2,
        markets: [{
          market: "KRW-BTC",
          archivalWindowStartAt: "2026-07-15T00:50:00.000Z",
          archivalWindowEndAt: "2026-07-22T00:50:00.000Z",
          nextWindowEndAt: "2026-07-15T00:50:00.000Z",
          archiveComplete: false,
          retentionStatus: "WITHIN_ASSUMED_RETENTION",
          confidenceLevel: "PARTIAL",
          confidenceReason: "ARCHIVE_IN_PROGRESS",
          openHistoryTruncated: false,
          recentClosedHistoryTruncated: false,
          archivalClosedHistoryTruncated: false,
          openPagesScanned: 1,
          recentClosedPagesScanned: 1,
          archivalClosedPagesScanned: 1,
          snapshotCount: 5,
        }],
      },
    }),
    errorMessage: null,
  };
  const checkpoints = [{
    id: "checkpoint-localized-1",
    exchangeAccountId: "primary",
    market: "KRW-BTC" as const,
    checkpointType: "CLOSED_ORDER_ARCHIVE" as const,
    nextWindowEndAt: "2026-07-15T00:50:00.000Z",
    updatedAt: "2026-07-29T00:50:05.000Z",
  }];
  const korean = formatRecoveryProgressMessage(latestRun, checkpoints, "ko-KR");
  const english = formatRecoveryProgressMessage(latestRun, checkpoints, "en-US");
  const missing = formatRecoveryProgressMessage(null, [], "ko-KR");
  const missingEnglish = formatRecoveryProgressMessage(null, [], "en-US");

  assert.match(korean, /^거래소 이력 복구 \(Exchange History Recovery\)/u);
  assert.match(korean, /복구 범위: 진행 중 \(IN_PROGRESS\)/u);
  assert.match(korean, /신뢰도: 부분 확인 \(PARTIAL\).*ARCHIVE_IN_PROGRESS/u);
  assert.match(korean, /보존 범위 판단: 가정된 보존 기간 안쪽 \(WITHIN_ASSUMED_RETENTION\)/u);
  assert.match(korean, /시장 진행: KRW-BTC.*완료 아님/u);
  assert.match(korean, /저장 체크포인트: 1개/u);
  assert.match(korean, /2026-07-29 09:50:00 KST/u);
  assert.doesNotMatch(korean, /거래소 전체 이력 복구 완료/u);
  assert.match(english, /^Exchange-history recovery \(Exchange History Recovery\)/u);
  assert.match(english, /Coverage: in progress \(IN_PROGRESS\)/u);
  assert.match(missing, /저장된 복구 실행 근거가 없습니다/u);
  assert.match(missingEnglish, /No persisted recovery-run evidence is available/u);
  for (const message of [korean, english]) {
    assert.match(message, /state_source: persisted reconciliation_runs \+ history_recovery_checkpoints/u);
    assert.ok(message.includes(`failure_message: ${storedFailure}`));
    assert.match(message, /persisted_checkpoints: 1/u);
    assert.match(message, /archive_complete=false/u);
  }
});

test("formatSyncMessage retains an invalid raw timestamp while using localized none", () => {
  const korean = formatSyncMessage({
    status: "FAILED",
    requestedAt: "not-an-iso-time",
    detail: "invalid timestamp fixture",
  }, "ko-KR");
  const english = formatSyncMessage({
    status: "FAILED",
    requestedAt: "not-an-iso-time",
    detail: "invalid timestamp fixture",
  }, "en-US");

  assert.match(korean, /요청 시각: 없음/u);
  assert.match(korean, /requested_at: not-an-iso-time/u);
  assert.match(english, /Requested at: none/u);
  assert.match(english, /requested_at: not-an-iso-time/u);
});

test("router localizes sync, invokes a configured controller once, and rejects arguments without invocation", async () => {
  const syncRequests: string[] = [];
  const router = new TelegramCommandRouter({
    operatorState: createOperatorStateStub(),
    repositories: createRepositoryStub(),
    locale: "en-US",
    syncController: {
      async requestSync(request): Promise<TelegramSyncResult> {
        syncRequests.push(`${request.exchangeAccountId}:${request.requestedCommand}`);
        return {
          status: "COMPLETED",
          requestedAt: "2026-07-16T00:30:45.000Z",
          detail: "sync detail",
        };
      },
    },
  });

  const response = await router.route("/sync");
  const invalidResponse = await router.route("/sync detail");

  assert.deepEqual(syncRequests, ["primary:/sync"]);
  assert.match(response.text, /^Sync request completed/u);
  assert.equal(invalidResponse.text, buildUsageMessage("/sync"));
});

test("router presents a missing sync controller as localized NOT_CONNECTED", async () => {
  const router = new TelegramCommandRouter({
    operatorState: createOperatorStateStub(),
    repositories: createRepositoryStub(),
    locale: "ko-KR",
    now: () => "invalid-now",
  });

  const response = await router.route("/sync");

  assert.match(response.text, /^동기화 기능 연결 안 됨/u);
  assert.match(response.text, /요청 시각: 없음/u);
  assert.match(response.text, /status: NOT_CONNECTED/u);
  assert.match(response.text, /requested_at: invalid-now/u);
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
    async pauseForFault() {
      return createExecutionState({ systemStatus: "PAUSED" });
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
    async persistOrderIntent() {},
    async persistCandidateBoundOrderIntent() {},
    async persistExchangeSubmission() {},
    async persistUncertainSubmission() {},
    async findOrderByIdempotencyKey() {
      return null;
    },
    async findOrderById(exchangeAccountId, orderId) {
      return orders.find((order) =>
        order.exchangeAccountId === exchangeAccountId && order.id === orderId,
      ) ?? null;
    },
    async findOrderByReference(_exchangeAccountId, reference) {
      return orders.find((order) => order.id === reference || order.identifier === reference) ?? null;
    },
    async listActiveOrders() {
      return [];
    },
    async listCandidateSubmissionBlockingOrders() {
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
