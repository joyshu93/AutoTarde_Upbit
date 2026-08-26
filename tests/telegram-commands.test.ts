import assert from "node:assert/strict";

import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  FillRecord,
  OperatorNotificationDeliveryAttemptRecord,
  OperatorNotificationDeliveryRunRecord,
  OperatorNotificationRecord,
  OperatorNotificationType,
  OrderEventRecord,
  OrderRecord,
  PositionSnapshotRecord,
  RiskEventRecord,
  RiskRuleCode,
  StrategyDecisionRecord,
  StrategySchedulerRunRecord,
  StrategySchedulerStatus,
} from "../src/domain/types.js";
import {
  InMemoryExecutionRepository,
  InMemoryOperatorStateStore,
  InMemoryTelegramInboundOffsetStore,
} from "../src/modules/db/repositories/in-memory-repositories.js";
import type { OperatorStateStore } from "../src/modules/db/interfaces.js";
import { TelegramCommandRouter } from "../src/modules/telegram/commands.js";
import { listTelegramCommandContracts } from "../src/modules/telegram/contracts.js";
import {
  formatBalanceMessage,
  formatOperatorNotificationsMessage,
  formatOperatorNotificationsSummaryMessage,
  formatOrderDetailMessage,
  formatOrderDetailSummaryMessage,
  formatOrdersMessage,
  formatOrdersSummaryMessage,
  formatPositionMessage,
  formatReadinessMessage,
  formatRiskEventsMessage,
  formatRiskEventsSummaryMessage,
  formatStatusMessage,
  formatStrategySchedulerRunsMessage,
  formatStrategySchedulerRunsSummaryMessage,
  formatTelegramInboundMessage,
} from "../src/modules/telegram/formatter.js";
import { buildTelegramReadOnlyResponse } from "../src/modules/telegram/presentation/dashboard.js";
import type { TelegramInboundPollingStatus } from "../src/modules/telegram/inbound.js";
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

function createControlState(
  overrides: Partial<ExecutionStateRecord>,
): ExecutionStateRecord {
  return {
    id: "control-state",
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

function createControlRouterFixture(
  initialState: ExecutionStateRecord,
  transitions: {
    pause?: ExecutionStateRecord;
    resume?: ExecutionStateRecord;
    activateKillSwitch?: ExecutionStateRecord;
  },
  options?: {
    locale?: "ko-KR" | "en-US";
    liveSendPath?: "DRY_RUN_ADAPTER" | "LIVE_ADAPTER";
  },
): {
  router: TelegramCommandRouter;
  calls: {
    getState: number;
    pause: number;
    resume: number;
    activateKillSwitch: number;
  };
} {
  let currentState = initialState;
  const calls = {
    getState: 0,
    pause: 0,
    resume: 0,
    activateKillSwitch: 0,
  };
  const operatorState: OperatorStateStore = {
    async getState() {
      calls.getState += 1;
      return currentState;
    },
    async listTransitions() {
      return [];
    },
    async pauseForFault() {
      return currentState;
    },
    async pause() {
      calls.pause += 1;
      currentState = transitions.pause ?? currentState;
      return currentState;
    },
    async resume() {
      calls.resume += 1;
      currentState = transitions.resume ?? currentState;
      return currentState;
    },
    async activateKillSwitch() {
      calls.activateKillSwitch += 1;
      currentState = transitions.activateKillSwitch ?? currentState;
      return currentState;
    },
    async setExecutionMode() {
      throw new Error("control presentation test must not change execution mode");
    },
    async setLiveExecutionGate() {
      throw new Error("control presentation test must not change the live gate");
    },
    async markDegraded() {
      throw new Error("control presentation test must not mark state degraded");
    },
    async clearDegraded() {
      throw new Error("control presentation test must not clear degraded state");
    },
  };
  const dependencies = {
    repositories: new InMemoryExecutionRepository(),
    operatorState,
    ...(options?.locale ? { locale: options.locale } : {}),
    ...(options?.liveSendPath ? { liveSendPath: options.liveSendPath } : {}),
  };

  return {
    router: new TelegramCommandRouter(dependencies),
    calls,
  };
}

function createRuntimeConfig() {
  return {
    serviceName: "AutoTrade_Upbit",
    executionMode: "DRY_RUN" as const,
    liveExecutionGate: "DISABLED" as const,
    liveSendPath: "DRY_RUN_ADAPTER" as const,
    upbitBaseUrl: "https://api.upbit.com",
    databasePath: "./var/autotrade-upbit.sqlite",
    telegramLocale: "ko-KR" as const,
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
    deprecatedIgnoredEnvVars: [],
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
  const previewParsed = router.parse("/preview BTC");
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
  assert.equal(previewParsed?.command, "/preview");
  assert.deepEqual(previewParsed?.args, ["BTC"]);
  assert.equal(previewParsed?.contract.category, "control");
  assert.equal(runParsed?.command, "/run");
  assert.deepEqual(runParsed?.args, ["BTC"]);
  assert.equal(runParsed?.contract.category, "control");
  assert.equal(router.parse("/setcash 1000000"), null);
  assert.equal(router.parse("status"), null);
});

test("telegram help remains complete while /start returns the Korean dashboard", async () => {
  const router = createRouter();
  const response = await router.route("/help");
  const startResponse = await router.route("/start");

  const dashboard = startResponse as typeof startResponse & {
    parseMode?: string;
    replyMarkup?: { inlineKeyboard: readonly (readonly { callbackData: string }[])[] };
  };
  assert.equal(dashboard.parseMode, "HTML");
  assert.match(dashboard.text, /AutoTrade Upbit/);
  assert.deepEqual(
    dashboard.replyMarkup?.inlineKeyboard.flat().map((button) => button.callbackData),
    ["status", "readiness", "balances", "positions", "orders:page:0", "alerts:page:0", "risks", "scheduler"],
  );
  assert.match(response.text, /AutoTrade Upbit 도움말/);
  assert.match(response.text, /조회 명령/);
  assert.match(response.text, /운영 명령/);
  assert.match(response.text, /텔레그램에서는 원화 잔고나 코인 보유 수량을 직접 입력할 수 없습니다\./);
  assert.match(response.text, /실제 주문은 실행 상태, 리스크 정책, 실주문 전송 안전장치를 모두 통과해야 합니다\./);
  for (const contract of listTelegramCommandContracts()) {
    assert.match(response.text, new RegExp(escapeRegExp(contract.usage)));
  }
});

test("telegram help supports English while /start keeps the dashboard controls read-only", async () => {
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
    locale: "en-US",
  });

  const helpResponse = await router.route("/help");
  const startResponse = await router.route("/start");

  const dashboard = startResponse as typeof startResponse & {
    parseMode?: string;
    replyMarkup?: { inlineKeyboard: readonly (readonly { callbackData: string }[])[] };
  };
  assert.equal(dashboard.parseMode, "HTML");
  assert.match(dashboard.text, /AutoTrade Upbit/);
  assert.ok(
    dashboard.replyMarkup?.inlineKeyboard.flat().every((button) => ![
      "run",
      "preview",
      "sync",
      "pause",
      "resume",
      "killswitch",
    ].includes(button.callbackData)),
  );
  assert.match(helpResponse.text, /AutoTrade Upbit Help/);
  assert.match(helpResponse.text, /Inspection commands/);
  assert.match(helpResponse.text, /Operator controls/);
  assert.match(helpResponse.text, /Telegram does not accept manual cash or position input\./);
  assert.match(helpResponse.text, /Live orders remain subject to execution state, risk policy, and live-send safety gates\./);
  for (const contract of listTelegramCommandContracts()) {
    assert.match(helpResponse.text, new RegExp(escapeRegExp(contract.usage)));
  }
});

test("telegram start accepts a bot mention but rejects arguments without rendering a dashboard", async () => {
  const router = createRouter();

  const mentionedStart = await router.route("/start@AutoTradeBot");
  const invalidStart = await router.route("/start unexpected");

  assert.equal(mentionedStart.parseMode, "HTML");
  assert.ok(mentionedStart.replyMarkup);
  assert.equal(
    invalidStart.text,
    "Usage: /help\nShow supported Telegram operator commands and safety boundaries.",
  );
  assert.equal(invalidStart.parseMode, undefined);
  assert.equal(invalidStart.replyMarkup, undefined);
});

test("read-only callback HTML responses truncate long dynamic status readiness order and alert content", () => {
  const buildResponse = buildTelegramReadOnlyResponse as unknown as (
    text: string,
    replyMarkup: { inlineKeyboard: readonly (readonly { text: string; callbackData: string }[])[] },
    locale: "ko-KR" | "en-US",
  ) => { text: string };
  const keyboard = { inlineKeyboard: [[{ text: "Home", callbackData: "home" }]] };
  const dynamicSources = {
    status: `degraded_reason: ${"<status&>".repeat(1_000)}`,
    readiness: `risk_message: ${"<readiness&>".repeat(1_000)}`,
    order: `failure_message: ${"<order&>".repeat(1_000)}`,
    alert: `message: ${"<alert&>".repeat(1_000)}`,
  };

  for (const [name, source] of Object.entries(dynamicSources)) {
    const response = buildResponse(source, keyboard, "en-US");
    const escapedBody = response.text.slice("<pre>".length, -"</pre>".length);
    assert.ok(response.text.length <= 3_500, name);
    assert.ok(response.text.length <= 4_096, name);
    assert.ok(response.text.startsWith("<pre>") && response.text.endsWith("</pre>"), name);
    assert.ok(!escapedBody.includes("<") && !escapedBody.includes(">"), name);
    assert.match(response.text, /truncated/i, name);
  }

  const korean = buildResponse("<긴 내용&>".repeat(1_000), keyboard, "ko-KR");
  assert.ok(korean.text.length <= 3_500);
  assert.match(korean.text, /생략/u);
});

test("English callback routes retain the English truncation notice", async () => {
  const router = new TelegramCommandRouter({
    repositories: new InMemoryExecutionRepository(),
    operatorState: new InMemoryOperatorStateStore({
      id: "english-callback-truncation",
      exchangeAccountId: "primary",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      systemStatus: "DEGRADED",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: "<long-status&>".repeat(1_000),
      degradedAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    }),
    locale: "en-US",
  });

  const response = await router.routeReadOnlyCallback({ type: "STATUS_DETAIL" });

  assert.ok(response.text.length <= 3_500);
  assert.match(response.text, /Content truncated for Telegram\./);
  assert.doesNotMatch(response.text, /생략/u);
});

test("telegram help dependency locale wins over a differing runtime config locale", async () => {
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
    locale: "en-US",
    runtimeConfig: {
      ...createRuntimeConfig(),
      telegramLocale: "ko-KR",
    },
  });

  const response = await router.route("/help");

  assert.match(response.text, /AutoTrade Upbit Help/);
  assert.doesNotMatch(response.text, /AutoTrade Upbit 도움말/);
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
      telegramLocale: "ko-KR",
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
  assert.match(response.text, /deprecated_ignored_env_vars: MAX_LIVE_ORDER_VALUE_KRW/);
  assert.match(response.text, /strategy_scheduler_enabled: false/);
  assert.match(response.text, /minimum_order_value_krw: 5000/);
  assert.match(response.text, /max_allocation_btc: 0\.6/);
  assert.match(response.text, /total_exposure_cap: 0\.75/);
  assert.match(response.text, /secret_boundary: secret values are never rendered/);
  assert.doesNotMatch(response.text, /123456:real-bot-token|real-upbit-secret|UPBIT_SECRET_KEY=/);
});

test("localized configuration and history inspection preserve bounded reads and invoke no mutation controller", async () => {
  const repository = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "inspection-state-1",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-07-29T00:00:00.000Z",
  });
  const transitionLimits: number[] = [];
  const reconciliationLimits: number[] = [];
  const checkpointAccounts: string[] = [];
  const originalListTransitions = operatorState.listTransitions.bind(operatorState);
  const originalListReconciliationRuns = repository.listReconciliationRuns.bind(repository);
  const originalListCheckpoints = repository.listHistoryRecoveryCheckpoints.bind(repository);

  operatorState.listTransitions = async (limit) => {
    transitionLimits.push(limit ?? -1);
    return originalListTransitions(limit);
  };
  repository.listReconciliationRuns = async (exchangeAccountId, limit) => {
    reconciliationLimits.push(limit ?? -1);
    return originalListReconciliationRuns(exchangeAccountId, limit);
  };
  repository.listHistoryRecoveryCheckpoints = async (exchangeAccountId) => {
    checkpointAccounts.push(exchangeAccountId);
    return originalListCheckpoints(exchangeAccountId);
  };

  const failMutation = async () => {
    throw new Error("inspection localization must not invoke mutation controllers");
  };
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState,
    runtimeConfig: {
      ...createRuntimeConfig(),
      telegramLocale: "ko-KR",
    },
    locale: "en-US",
    syncController: {
      requestSync: failMutation,
    },
    strategyRunController: {
      requestRun: failMutation,
      requestPreview: failMutation,
    },
  });

  const config = await router.route("/config");
  const stateHistory = await router.route("/statehistory");
  const syncHistory = await router.route("/synchistory");
  const recovery = await router.route("/recovery");

  assert.match(config.text, /^Runtime configuration \(Runtime Config\)/u);
  assert.match(stateHistory.text, /^Execution-state history \(Execution State History\)/u);
  assert.match(syncHistory.text, /^Reconciliation history \(Reconciliation History\)/u);
  assert.match(recovery.text, /^Exchange-history recovery \(Exchange History Recovery\)/u);
  assert.deepEqual(transitionLimits, [10]);
  assert.deepEqual(reconciliationLimits, [10, 1]);
  assert.deepEqual(checkpointAccounts, ["primary"]);
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
      telegramLocale: "ko-KR",
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
      deprecatedIgnoredEnvVars: [],
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
  assert.match(response.text, /overall_status: PASS/);
  assert.match(response.text, /운영 준비 상태: 통과/);
  assert.match(response.text, /실행 모드: 모의 실행 \(DRY_RUN\)/);
  assert.match(response.text, /시스템 상태: 실행 중 \(RUNNING\)/);
  assert.match(response.text, /스케줄러: 사용 중 \(시작됨\)/);
  assert.match(response.text, /잔고 스냅샷: 2026-04-20 09:01:00 KST/);
  assert.match(response.text, /포지션 스냅샷: 2026-04-20 09:02:00 KST/);
  assert.match(response.text, /최근 동기화: 정상 \(2026-04-20 09:03:02 KST\)/);
  assert.match(response.text, /활성 주문: 0건/);
  assert.match(response.text, /최근 위험 차단: 0건/);
  assert.match(response.text, /대기 알림: 0건/);
  assert.match(response.text, /주의\/차단 점검: 없음/);
  assert.match(response.text, /기술 상세: \/readiness detail/);
  assert.doesNotMatch(response.text, /state_source:/);
  assert.doesNotMatch(response.text, /read_only_boundary:/);
});

test("telegram router renders equivalent English readiness summary with actionable blockers", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveBalanceSnapshot({
    id: "balance-readiness-en",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:01:00.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "1000000",
    balancesJson: "[]",
  });
  await repository.savePositionSnapshot({
    id: "position-readiness-en",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:02:00.000Z",
    source: "RECONCILIATION",
    positionsJson: "[]",
  });
  await repository.saveReconciliationRun({
    id: "reconciliation-readiness-en",
    exchangeAccountId: "primary",
    status: "DRIFT_DETECTED",
    startedAt: "2026-04-20T00:03:00.000Z",
    completedAt: "2026-04-20T00:03:02.000Z",
    summaryJson: JSON.stringify({
      source: "OPERATOR_SYNC",
      issues: [
        {
          code: "EXCHANGE_ORDER_RECOVERED",
          message: "Recovered exchange order.",
        },
      ],
    }),
    errorMessage: null,
  });
  await repository.saveOrder(createOrder({
    id: "active-order-readiness-en",
    status: "OPEN",
    updatedAt: "2026-04-20T00:04:00.000Z",
  }));
  await repository.saveRiskEvent({
    id: "risk-readiness-en",
    exchangeAccountId: "primary",
    strategyDecisionId: null,
    orderId: "active-order-readiness-en",
    level: "BLOCK",
    ruleCode: "DUPLICATE_ORDER_GUARD",
    message: "Duplicate active order.",
    payloadJson: "{}",
    createdAt: "2026-04-20T00:04:30.000Z",
  });
  await repository.saveOperatorNotification(createNotification({
    id: "notification-readiness-en",
    createdAt: "2026-04-20T00:04:45.000Z",
  }));
  const executionState: ExecutionStateRecord = {
    id: "state-readiness-en",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "DEGRADED",
    killSwitchActive: true,
    pauseReason: null,
    degradedReason: "startup_portfolio_drift_detected",
    degradedAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore(executionState),
    locale: "en-US",
    schedulerStatus: () => ({
      enabled: false,
      started: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      startupPreflight: null,
      markets: [],
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
      async requestPreview() {
        throw new Error("/readiness must not call strategyRunController");
      },
    },
    now: () => "2026-04-20T00:05:00.000Z",
  });

  const response = await router.route("/readiness");

  assert.match(response.text, /Operator Readiness/);
  assert.match(response.text, /overall_status: BLOCK/);
  assert.match(response.text, /Operator readiness: blocked/);
  assert.match(response.text, /Next action: Resolve the blocking checks before running or scheduling orders\./);
  assert.match(response.text, /Execution mode: live \(LIVE\)/);
  assert.match(response.text, /System status: degraded \(DEGRADED\)/);
  assert.match(response.text, /Kill switch: on/);
  assert.match(response.text, /Degraded reason: startup_portfolio_drift_detected/);
  assert.match(response.text, /Scheduler: disabled/);
  assert.match(response.text, /Balance snapshot: 2026-04-20 09:01:00 KST/);
  assert.match(response.text, /Position snapshot: 2026-04-20 09:02:00 KST/);
  assert.match(response.text, /Latest reconciliation: drift detected \(2026-04-20 09:03:02 KST\)/);
  assert.match(response.text, /Active orders: 1/);
  assert.match(response.text, /Recent risk blocks: 1/);
  assert.match(response.text, /Pending notifications: 1/);
  assert.match(response.text, /Warnings\/blocks:/);
  assert.match(response.text, /runtime_config \[BLOCK\]: runtime configuration is unavailable/);
  assert.match(response.text, /execution_state \[BLOCK\]: execution is blocked by the current operator state/);
  assert.match(response.text, /Technical details: \/readiness detail/);
  assert.doesNotMatch(response.text, /- live_send_safety: PASS/);
});

test("telegram router preserves canonical readiness detail output exactly", async () => {
  const executionState: ExecutionStateRecord = {
    id: "state-readiness-detail",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
  const repository = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore(executionState);
  const now = "2026-04-20T00:05:00.000Z";
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState,
    now: () => now,
  });

  const response = await router.route("/readiness DETAIL");
  const expected = formatReadinessMessage({
    runtimeConfig: null,
    executionState,
    latestBalanceSnapshot: null,
    latestPositionSnapshot: null,
    latestReconciliationRun: null,
    activeOrders: [],
    recentRiskEvents: [],
    pendingNotifications: [],
    schedulerStatus: null,
    inboundStatus: null,
    now,
  });

  assert.equal(response.text, expected);
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

  const response = await router.route("/readiness detail");

  assert.match(response.text, /overall_status: WARN/);
  assert.match(response.text, /execution_mode: LIVE/);
  assert.match(response.text, /live_gate: ENABLED/);
  assert.match(response.text, /- live_send_safety: WARN \| live order path is enabled by config; \/run commands are real-order capable/);
  assert.match(response.text, /- execution_state: PASS \| execution state allows orders/);
  assert.match(response.text, /- latest_reconciliation: WARN \| latest reconciliation status=DRIFT_DETECTED completed_at=2026-05-13T07:19:29.388Z non_blocking_issue_codes=EXCHANGE_ORDER_RECOVERED/);
  assert.doesNotMatch(response.text, /overall_status: BLOCK/);
});

test("telegram router readiness warns when live scheduler health snapshots are stale", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveBalanceSnapshot({
    id: "balance-live-stale",
    exchangeAccountId: "primary",
    capturedAt: "2026-05-13T07:00:00.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "9000",
    balancesJson: "[]",
  });
  await repository.savePositionSnapshot({
    id: "position-live-stale",
    exchangeAccountId: "primary",
    capturedAt: "2026-05-13T07:00:00.000Z",
    source: "RECONCILIATION",
    positionsJson: "[]",
  });
  await repository.saveReconciliationRun({
    id: "recon-live-stale",
    exchangeAccountId: "primary",
    status: "SUCCESS",
    startedAt: "2026-05-13T07:00:00.000Z",
    completedAt: "2026-05-13T07:00:00.000Z",
    summaryJson: JSON.stringify({ source: "OPERATOR_SYNC", issues: [] }),
    errorMessage: null,
  });

  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-live-stale",
      exchangeAccountId: "primary",
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      systemStatus: "RUNNING",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: null,
      degradedAt: null,
      updatedAt: "2026-05-13T07:00:00.000Z",
    }),
    runtimeConfig: {
      ...createRuntimeConfig(),
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      liveSendPath: "LIVE_ADAPTER",
      strategySchedulerEnabled: true,
      strategySchedulerBtcIntervalMs: 3_600_000,
      strategySchedulerEthIntervalMs: 3_600_000,
    },
    schedulerStatus: () => ({
      enabled: true,
      started: true,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      startupPreflight: {
        checkedAt: "2026-05-13T07:00:00.000Z",
        scope: "LIVE",
        status: "PASS",
        detail: "Live scheduler startup preflight passed.",
        checks: [],
      },
      markets: [],
    }),
    now: () => "2026-05-13T09:00:01.000Z",
  });

  const response = await router.route("/readiness detail");

  assert.match(response.text, /overall_status: WARN/);
  assert.match(response.text, /- balance_snapshot: WARN \| latest balance snapshot captured_at=2026-05-13T07:00:00.000Z stale_age_ms=7201000 max_age_ms=3600000/);
  assert.match(response.text, /- position_snapshot: WARN \| latest position snapshot captured_at=2026-05-13T07:00:00.000Z stale_age_ms=7201000 max_age_ms=3600000/);
  assert.match(response.text, /- latest_reconciliation: WARN \| latest reconciliation status=SUCCESS completed_at=2026-05-13T07:00:00.000Z stale_age_ms=7201000 max_age_ms=3600000/);
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
      telegramLocale: "ko-KR",
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
      deprecatedIgnoredEnvVars: [],
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

  const response = await router.route("/readiness detail");

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

  const response = await router.route("/readiness detail");

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

  const response = await router.route("/readiness detail");

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
      async requestPreview() {
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

  const response = await router.route("/readiness detail");

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
      async requestPreview() {
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

  assert.match(response.text, /AutoTrade Upbit 도움말/);
  assert.match(response.text, /명령 수: 21/);
  assert.match(response.text, /도움말 조회는 동기화, 전략 실행, 스케줄러 실행, 거래소 조회, 주문 변경 또는 실주문 전송을 수행하지 않습니다\./);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("telegram router renders a Korean balance summary without floating-point artifacts", async () => {
  const repository = new InMemoryExecutionRepository();
  const snapshot: BalanceSnapshotRecord = {
    id: "balance-summary-ko",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:01:02.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "8967.627519169999",
    balancesJson: JSON.stringify([
      {
        currency: "KRW",
        balance: "0.52358917",
        locked: "0",
        avgBuyPrice: "0",
        unitCurrency: "KRW",
      },
      {
        currency: "BTC",
        balance: "0.00007489",
        locked: "0.00000001",
        avgBuyPrice: "115950000",
        unitCurrency: "KRW",
      },
    ]),
  };
  await repository.saveBalanceSnapshot(snapshot);
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: createRouterState(),
  });

  const response = await router.route("/balances");

  assert.match(response.text, /잔고 요약/);
  assert.match(response.text, /기준 시각: 2026-04-20 09:01:02 KST/);
  assert.match(response.text, /출처: 거래소 동기화 \(source: RECONCILIATION\)/);
  assert.match(response.text, /총 평가금액: 8,968원/);
  assert.match(response.text, /KRW/);
  assert.match(response.text, /사용 가능: 0\.52358917 KRW/);
  assert.match(response.text, /BTC/);
  assert.match(response.text, /사용 가능: 0\.00007489 BTC/);
  assert.match(response.text, /주문 중: 0\.00000001 BTC/);
  assert.match(response.text, /평균 매수가: 115,950,000원/);
  assert.match(response.text, /기술 상세: \/balances detail/);
  assert.match(response.text, /Telegram에서는 현금이나 보유 수량을 직접 입력할 수 없습니다/);
  assert.doesNotMatch(response.text, /8967\.627519169999/);
  assert.doesNotMatch(response.text, /captured_at:/);
});

test("telegram router renders equivalent English balance summary", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveBalanceSnapshot({
    id: "balance-summary-en",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:01:02.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "1250000",
    balancesJson: JSON.stringify([
      {
        currency: "ETH",
        balance: "0.12500000",
        locked: "0.005",
        avgBuyPrice: "3500000",
        unitCurrency: "KRW",
      },
    ]),
  });
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: createRouterState(),
    locale: "en-US",
  });

  const response = await router.route("/balances");

  assert.match(response.text, /Balance summary/);
  assert.match(response.text, /As of: 2026-04-20 09:01:02 KST/);
  assert.match(response.text, /Source: exchange poll \(source: EXCHANGE_POLL\)/);
  assert.match(response.text, /Total value: KRW 1,250,000/);
  assert.match(response.text, /Available: 0\.125 ETH/);
  assert.match(response.text, /Locked: 0\.005 ETH/);
  assert.match(response.text, /Average buy price: KRW 3,500,000/);
  assert.match(response.text, /Technical details: \/balances detail/);
  assert.match(response.text, /Telegram does not accept manual cash or position input/);
});

test("telegram router reports unavailable balance data explicitly", async () => {
  const router = createRouter();

  const missing = await router.route("/balances");

  assert.match(missing.text, /잔고 정보를 사용할 수 없습니다/);
  assert.match(missing.text, /저장된 잔고 스냅샷이 없습니다/);

  const repository = new InMemoryExecutionRepository();
  await repository.saveBalanceSnapshot({
    id: "balance-malformed",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:01:02.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "1000",
    balancesJson: "{not-json",
  });
  const malformedRouter = new TelegramCommandRouter({
    repositories: repository,
    operatorState: createRouterState(),
  });

  const malformed = await malformedRouter.route("/balances");

  assert.match(malformed.text, /잔고 정보를 사용할 수 없습니다/);
  assert.match(malformed.text, /저장된 잔고 데이터 형식이 올바르지 않습니다/);
  assert.doesNotMatch(malformed.text, /\{not-json/);
});

test("telegram router rejects a balance snapshot when any numeric field is not a finite decimal", async () => {
  const invalidFields = [
    ["balance", "NaN"],
    ["locked", "Infinity"],
    ["avgBuyPrice", "1e5"],
    ["balance", "9".repeat(400)],
  ] as const;

  for (const [field, invalidValue] of invalidFields) {
    const repository = new InMemoryExecutionRepository();
    await repository.saveBalanceSnapshot({
      id: `balance-invalid-${field}`,
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:01:02.000Z",
      source: "RECONCILIATION",
      totalKrwValue: "1000",
      balancesJson: JSON.stringify([
        {
          currency: "BTC",
          balance: "0.001",
          locked: "0",
          avgBuyPrice: "100000000",
          unitCurrency: "KRW",
          [field]: invalidValue,
        },
      ]),
    });
    const router = new TelegramCommandRouter({
      repositories: repository,
      operatorState: createRouterState(),
    });

    const response = await router.route("/balances");

    assert.match(response.text, /잔고 정보를 사용할 수 없습니다/);
    assert.match(response.text, /저장된 잔고 데이터 형식이 올바르지 않습니다/);
    assert.doesNotMatch(response.text, new RegExp(invalidValue));
  }
});

test("telegram router rejects a non-null total KRW value that is not a finite decimal string", async () => {
  for (const invalidTotal of ["0x10", "Infinity", "NaN"]) {
    const repository = new InMemoryExecutionRepository();
    await repository.saveBalanceSnapshot({
      id: `balance-invalid-total-${invalidTotal}`,
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:01:02.000Z",
      source: "RECONCILIATION",
      totalKrwValue: invalidTotal,
      balancesJson: JSON.stringify([
        {
          currency: "KRW",
          balance: "1000",
          locked: "0",
          avgBuyPrice: "0",
          unitCurrency: "KRW",
        },
      ]),
    });
    const router = new TelegramCommandRouter({
      repositories: repository,
      operatorState: createRouterState(),
    });

    const response = await router.route("/balances");

    assert.match(response.text, /잔고 정보를 사용할 수 없습니다/);
    assert.match(response.text, /저장된 잔고 데이터 형식이 올바르지 않습니다/);
    assert.doesNotMatch(response.text, new RegExp(escapeRegExp(invalidTotal)));
  }
});

test("telegram router uses the balance currency as the quantity unit for unsupported assets", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveBalanceSnapshot({
    id: "balance-xrp",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:01:02.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "1000",
    balancesJson: JSON.stringify([
      {
        currency: "XRP",
        balance: "1.50000000",
        locked: "0.25000000",
        avgBuyPrice: "700",
        unitCurrency: "KRW",
      },
    ]),
  });
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: createRouterState(),
  });

  const response = await router.route("/balances");

  assert.match(response.text, /사용 가능: 1\.5 XRP/);
  assert.match(response.text, /주문 중: 0\.25 XRP/);
  assert.doesNotMatch(response.text, /사용 가능: 1\.5 KRW/);
});

test("telegram router explicitly reports an empty stored balance list in Korean and English", async () => {
  for (const locale of ["ko-KR", "en-US"] as const) {
    const repository = new InMemoryExecutionRepository();
    await repository.saveBalanceSnapshot({
      id: `balance-empty-${locale}`,
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:01:02.000Z",
      source: "RECONCILIATION",
      totalKrwValue: "0",
      balancesJson: "[]",
    });
    const router = new TelegramCommandRouter({
      repositories: repository,
      operatorState: createRouterState(),
      locale,
    });

    const response = await router.route("/balances");

    assert.match(
      response.text,
      locale === "ko-KR" ? /저장된 잔고가 없습니다/ : /No stored balances/,
    );
    assert.match(response.text, /\/balances detail/);
  }
});

test("telegram router renders position summaries and explicit empty state", async () => {
  const repository = new InMemoryExecutionRepository();
  const snapshot: PositionSnapshotRecord = {
    id: "position-summary-ko",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:05:00.000Z",
    source: "RECONCILIATION",
    positionsJson: JSON.stringify([
      {
        asset: "BTC",
        market: "KRW-BTC",
        quantity: "0.00007489",
        averageEntryPrice: "115950000",
        markPrice: "119737000",
        marketValue: "8967.10393",
        exposureRatio: "0.8",
        capturedAt: "2026-04-20T00:05:00.000Z",
      },
    ]),
  };
  await repository.savePositionSnapshot(snapshot);
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: createRouterState(),
  });

  const response = await router.route("/positions");

  assert.match(response.text, /보유 현황 요약/);
  assert.match(response.text, /기준 시각: 2026-04-20 09:05:00 KST/);
  assert.match(response.text, /출처: 거래소 동기화 \(source: RECONCILIATION\)/);
  assert.match(response.text, /KRW-BTC/);
  assert.match(response.text, /보유 수량: 0\.00007489 BTC/);
  assert.match(response.text, /평균 매수가: 115,950,000원/);
  assert.match(response.text, /현재가: 119,737,000원/);
  assert.match(response.text, /평가금액: 8,967원/);
  assert.match(response.text, /노출 비율: 80%/);
  assert.match(response.text, /기술 상세: \/positions detail/);
  assert.match(response.text, /Telegram에서는 현금이나 보유 수량을 직접 입력할 수 없습니다/);

  await repository.savePositionSnapshot({
    ...snapshot,
    id: "position-empty",
    capturedAt: "2026-04-20T00:06:00.000Z",
    positionsJson: "[]",
  });
  const empty = await router.route("/positions");

  assert.match(empty.text, /저장된 보유 포지션이 없습니다/);
  assert.match(empty.text, /기술 상세: \/positions detail/);
});

test("telegram router explicitly reports no stored positions when the snapshot is missing", async () => {
  const router = createRouter();

  const response = await router.route("/positions");

  assert.match(response.text, /저장된 보유 포지션이 없습니다/);
  assert.match(response.text, /\/sync 후 다시 확인하세요/);
  assert.match(response.text, /기술 상세: \/positions detail/);
  assert.match(response.text, /Telegram에서는 현금이나 보유 수량을 직접 입력할 수 없습니다/);
});

test("telegram router rejects a position snapshot when any numeric field is not a finite decimal", async () => {
  const invalidFields = [
    ["quantity", "NaN"],
    ["averageEntryPrice", "Infinity"],
    ["markPrice", "1e8"],
    ["marketValue", "--1"],
    ["exposureRatio", "not-a-number"],
    ["quantity", "9".repeat(400)],
  ] as const;

  for (const [field, invalidValue] of invalidFields) {
    const repository = new InMemoryExecutionRepository();
    await repository.savePositionSnapshot({
      id: `position-invalid-${field}`,
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:05:00.000Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([
        {
          asset: "BTC",
          market: "KRW-BTC",
          quantity: "0.001",
          averageEntryPrice: "100000000",
          markPrice: "101000000",
          marketValue: "101000",
          exposureRatio: "0.5",
          capturedAt: "2026-04-20T00:05:00.000Z",
          [field]: invalidValue,
        },
      ]),
    });
    const router = new TelegramCommandRouter({
      repositories: repository,
      operatorState: createRouterState(),
    });

    const response = await router.route("/positions");

    assert.match(response.text, /보유 현황 정보를 사용할 수 없습니다/);
    assert.match(response.text, /저장된 포지션 데이터 형식이 올바르지 않습니다/);
    assert.doesNotMatch(response.text, new RegExp(escapeRegExp(invalidValue)));
  }
});

test("telegram router rejects position snapshots whose asset and market do not match", async () => {
  const mismatches = [
    ["BTC", "KRW-ETH"],
    ["ETH", "KRW-BTC"],
  ] as const;

  for (const [asset, market] of mismatches) {
    const repository = new InMemoryExecutionRepository();
    await repository.savePositionSnapshot({
      id: `position-mismatch-${asset}`,
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:05:00.000Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([
        {
          asset,
          market,
          quantity: "0.001",
          averageEntryPrice: "100000000",
          markPrice: "101000000",
          marketValue: "101000",
          exposureRatio: "0.5",
          capturedAt: "2026-04-20T00:05:00.000Z",
        },
      ]),
    });
    const router = new TelegramCommandRouter({
      repositories: repository,
      operatorState: createRouterState(),
    });

    const response = await router.route("/positions");

    assert.match(response.text, /보유 현황 정보를 사용할 수 없습니다/);
    assert.match(response.text, /저장된 포지션 데이터 형식이 올바르지 않습니다/);
    assert.doesNotMatch(response.text, new RegExp(`${asset}.*${market}`));
  }
});

test("telegram router renders equivalent English position summary", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.savePositionSnapshot({
    id: "position-summary-en",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:05:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: JSON.stringify([
      {
        asset: "ETH",
        market: "KRW-ETH",
        quantity: "0.12500000",
        averageEntryPrice: "3500000",
        markPrice: "3600000",
        marketValue: "450000",
        exposureRatio: null,
        capturedAt: "2026-04-20T00:05:00.000Z",
      },
    ]),
  });
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: createRouterState(),
    locale: "en-US",
  });

  const response = await router.route("/positions");

  assert.match(response.text, /Position summary/);
  assert.match(response.text, /As of: 2026-04-20 09:05:00 KST/);
  assert.match(response.text, /Source: exchange poll \(source: EXCHANGE_POLL\)/);
  assert.match(response.text, /Quantity: 0\.125 ETH/);
  assert.match(response.text, /Average entry: KRW 3,500,000/);
  assert.match(response.text, /Mark price: KRW 3,600,000/);
  assert.match(response.text, /Market value: KRW 450,000/);
  assert.doesNotMatch(response.text, /Exposure:/);
  assert.match(response.text, /Technical details: \/positions detail/);
});

test("portfolio summaries keep equivalent Korean and English structure without duplicate source rows", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveBalanceSnapshot({
    id: "balance-structure",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:01:02.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "1000",
    balancesJson: JSON.stringify([
      {
        currency: "KRW",
        balance: "1000",
        locked: "0",
        avgBuyPrice: "0",
        unitCurrency: "KRW",
      },
    ]),
  });
  const koreanRouter = new TelegramCommandRouter({
    repositories: repository,
    operatorState: createRouterState(),
    locale: "ko-KR",
  });
  const englishRouter = new TelegramCommandRouter({
    repositories: repository,
    operatorState: createRouterState(),
    locale: "en-US",
  });

  const korean = (await koreanRouter.route("/balances")).text;
  const english = (await englishRouter.route("/balances")).text;

  assert.equal(korean.split("\n").length, english.split("\n").length);
  assert.equal(korean.match(/source: RECONCILIATION/g)?.length, 1);
  assert.equal(english.match(/source: RECONCILIATION/g)?.length, 1);
  assert.doesNotMatch(korean, /^source:/mu);
  assert.doesNotMatch(english, /^source:/mu);
});

test("balance and position detail output exactly preserve canonical formatters", async () => {
  const repository = new InMemoryExecutionRepository();
  const balanceSnapshot: BalanceSnapshotRecord = {
    id: "balance-detail",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:01:02.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "8967.627519169999",
    balancesJson: JSON.stringify([]),
  };
  const positionSnapshot: PositionSnapshotRecord = {
    id: "position-detail",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:05:00.000Z",
    source: "RECONCILIATION",
    positionsJson: JSON.stringify([]),
  };
  await repository.saveBalanceSnapshot(balanceSnapshot);
  await repository.savePositionSnapshot(positionSnapshot);
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: createRouterState(),
  });

  assert.equal(
    (await router.route("/balances DETAIL")).text,
    formatBalanceMessage(balanceSnapshot),
  );
  assert.equal(
    (await router.route("/positions detail")).text,
    formatPositionMessage(positionSnapshot),
  );
});

function createRouterState(): InMemoryOperatorStateStore {
  return new InMemoryOperatorStateStore({
    id: "state-portfolio-summary",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
}

test("telegram router exposes a concise Korean order lifecycle summary", async () => {
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

  assert.match(response.text, /주문 상세 \(Order\)/);
  assert.match(response.text, /부분 체결/);
  assert.match(response.text, /아직 완료되지 않았으며 남은 수량의 체결 또는 취소를 기다립니다\./);
  assert.match(response.text, /KRW-BTC · 매수 · price · DRY_RUN · 전략/);
  assert.match(response.text, /요청: 2026-04-20 09:00:00 KST/);
  assert.match(response.text, /갱신: 2026-04-20 09:02:00 KST/);
  assert.match(response.text, /내부 주문 ID: order-1/);
  assert.match(response.text, /식별자: order-identifier-1/);
  assert.match(response.text, /주문금액: 500,000원/);
  assert.match(response.text, /최근 이벤트 \(2건\)/);
  assert.match(response.text, /RECONCILIATION_STATUS_UPDATED · RECONCILIATION · 2026-04-20 09:02:00 KST/);
  assert.doesNotMatch(response.text, /payload=/);
  assert.match(response.text, /최근 체결 \(1건\)/);
  assert.match(response.text, /2026-04-20 09:01:00 KST · 500,000원 · 0\.005 BTC · 수수료 250원/);
  assert.match(response.text, /전체 기술 상세: \/order order-1 detail/);
  assert.match(response.text, /텔레그램에서는 현금이나 포지션을 수동 입력할 수 없습니다\./);
});

test("telegram router reports missing order detail without reading events or fills", async () => {
  let orderLookupCount = 0;
  let eventLookupCount = 0;
  let fillLookupCount = 0;
  const repository = new InMemoryExecutionRepository();
  const findOrderByReference = repository.findOrderByReference.bind(repository);
  const listOrderEvents = repository.listOrderEvents.bind(repository);
  const listFills = repository.listFills.bind(repository);
  repository.findOrderByReference = async (exchangeAccountId, reference) => {
    orderLookupCount += 1;
    return findOrderByReference(exchangeAccountId, reference);
  };
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

  assert.match(response.text, /주문을 찾을 수 없습니다\./);
  assert.match(response.text, /조회값: unknown-order/);
  assert.equal(orderLookupCount, 1);
  assert.equal(eventLookupCount, 0);
  assert.equal(fillLookupCount, 0);
});

test("telegram /order renders equivalent English lifecycle information", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveOrder(createOrder({
    id: "order-en",
    identifier: "order-en-identifier",
    status: "RECONCILIATION_REQUIRED",
    side: "ask",
    ordType: "best",
    price: null,
    volume: "0.125",
    failureCode: "LOOKUP_FAILED",
    failureMessage: "Exchange lookup timed out.",
    requestedAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:05:00.000Z",
  }));
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: createRouterState(),
    locale: "en-US",
  });

  const response = await router.route("/order order-en");

  assert.match(response.text, /Order detail/);
  assert.match(response.text, /Reconciliation required/);
  assert.match(response.text, /This order is not complete; verify it against persisted exchange reconciliation evidence\./);
  assert.match(response.text, /KRW-BTC · Sell · best · DRY_RUN · Strategy/);
  assert.match(response.text, /Volume: 0\.125 BTC/);
  assert.match(response.text, /Failure: LOOKUP_FAILED · Exchange lookup timed out\./);
  assert.match(response.text, /Full technical detail: \/order order-en detail/);
});

test("telegram /order summary labels stale terminal failure metadata as processing history", () => {
  const cases: Array<{
    locale: "ko-KR" | "en-US";
    status: "FILLED" | "CANCELED";
    expected: RegExp;
    forbidden: RegExp;
  }> = [
    {
      locale: "ko-KR",
      status: "FILLED",
      expected: /과거 처리 이력: 이전 주문 처리 오류 정보가 남아 있습니다\. 현재 상태는 체결 완료입니다\./,
      forbidden: /실패:|RECONCILIATION_REQUIRED|Exchange order lookup failed/,
    },
    {
      locale: "en-US",
      status: "CANCELED",
      expected: /Processing history: Earlier order-processing failure metadata remains\. Current status is Canceled\./,
      forbidden: /Failure:|RECONCILIATION_REQUIRED|Exchange order lookup failed/,
    },
  ];

  for (const testCase of cases) {
    const order = createOrder({
      id: `order-terminal-${testCase.status}`,
      status: testCase.status,
      failureCode: "RECONCILIATION_REQUIRED",
      failureMessage: "Exchange order lookup failed.",
    });

    const message = formatOrderDetailSummaryMessage(
      order,
      [],
      [],
      order.id,
      testCase.locale,
    );

    assert.match(message, testCase.expected);
    assert.doesNotMatch(message, testCase.forbidden);
  }
});

test("telegram /order summary keeps active failure metadata for unresolved statuses", () => {
  const statuses: Array<"FAILED" | "REJECTED" | "RECONCILIATION_REQUIRED"> = [
    "FAILED",
    "REJECTED",
    "RECONCILIATION_REQUIRED",
  ];

  for (const status of statuses) {
    const order = createOrder({
      id: `order-active-failure-${status}`,
      status,
      failureCode: "LOOKUP_FAILED",
      failureMessage: "Exchange lookup timed out.",
    });
    const korean = formatOrderDetailSummaryMessage(order, [], [], order.id, "ko-KR");
    const english = formatOrderDetailSummaryMessage(order, [], [], order.id, "en-US");

    assert.match(korean, /실패: LOOKUP_FAILED · Exchange lookup timed out\./);
    assert.match(english, /Failure: LOOKUP_FAILED · Exchange lookup timed out\./);
  }
});

test("telegram /order shows only the newest three events and fills without inferring state", async () => {
  const repository = new InMemoryExecutionRepository();
  const order = createOrder({
    id: "order-latest-three",
    identifier: "order-latest-three-identifier",
    status: "OPEN",
    price: "100000000",
    volume: "0.0001",
  });
  await repository.saveOrder(order);

  for (let index = 0; index < 5; index += 1) {
    await repository.appendOrderEvent({
      id: `event-${index}`,
      orderId: order.id,
      eventType: `EVENT_${index}`,
      eventSource: index % 2 === 0 ? "LOCAL" : "EXCHANGE",
      payloadJson: JSON.stringify({ index }),
      createdAt: `2026-04-20T00:0${index}:00.000Z`,
    });
    await repository.saveFill({
      id: `fill-${index}`,
      orderId: order.id,
      exchangeFillId: `exchange-fill-${index}`,
      market: "KRW-BTC",
      side: "bid",
      price: `${100000000 + index}`,
      volume: "0.00001",
      feeCurrency: "KRW",
      feeAmount: `${index}`,
      filledAt: `2026-04-20T00:0${index}:30.000Z`,
      rawPayloadJson: JSON.stringify({ index }),
    });
  }

  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: createRouterState(),
  });
  const response = await router.route("/order order-latest-three");

  assert.match(response.text, /미체결/);
  assert.match(response.text, /아직 완료되지 않았으며 거래소 체결 또는 취소를 기다립니다\./);
  assert.match(response.text, /최근 이벤트 \(전체 5건 중 3건\)/);
  assert.match(response.text, /EVENT_4/);
  assert.match(response.text, /EVENT_3/);
  assert.match(response.text, /EVENT_2/);
  assert.doesNotMatch(response.text, /EVENT_1/);
  assert.match(response.text, /최근 체결 \(전체 5건 중 3건\)/);
  assert.match(response.text, /2026-04-20 09:04:30 KST/);
  assert.doesNotMatch(response.text, /2026-04-20 09:01:30 KST/);
});

test("telegram order detail sorts mixed-offset event and fill timestamps by instant", () => {
  const order = createOrder({ id: "order-mixed-offset" });
  const events: OrderEventRecord[] = [
    {
      id: "event-offset",
      orderId: order.id,
      eventType: "OFFSET_EVENT",
      eventSource: "LOCAL",
      payloadJson: "{}",
      createdAt: "2026-04-20T09:00:00+09:00",
    },
    {
      id: "event-z-newer",
      orderId: order.id,
      eventType: "NEWER_Z_EVENT",
      eventSource: "EXCHANGE",
      payloadJson: "{}",
      createdAt: "2026-04-20T00:30:00.000Z",
    },
  ];
  const fills: FillRecord[] = [
    {
      id: "fill-offset",
      orderId: order.id,
      exchangeFillId: "fill-offset",
      market: "KRW-BTC",
      side: "bid",
      price: "100000000",
      volume: "0.00001",
      feeCurrency: "KRW",
      feeAmount: "0.1",
      filledAt: "2026-04-20T09:00:00+09:00",
      rawPayloadJson: "{}",
    },
    {
      id: "fill-z-newer",
      orderId: order.id,
      exchangeFillId: "fill-z-newer",
      market: "KRW-BTC",
      side: "bid",
      price: "100000001",
      volume: "0.00002",
      feeCurrency: "KRW",
      feeAmount: "0.2",
      filledAt: "2026-04-20T00:30:00.000Z",
      rawPayloadJson: "{}",
    },
  ];

  const message = formatOrderDetailSummaryMessage(order, events, fills, order.id, "en-US");

  assert.ok(message.indexOf("NEWER_Z_EVENT") < message.indexOf("OFFSET_EVENT"));
  assert.ok(message.indexOf("KRW 100,000,001") < message.indexOf("KRW 100,000,000"));
});

test("telegram order detail puts invalid timestamps last and labels them as data errors", () => {
  const order = createOrder({ id: "order-invalid-time" });
  const events: OrderEventRecord[] = [
    {
      id: "event-invalid",
      orderId: order.id,
      eventType: "INVALID_TIME_EVENT",
      eventSource: "LOCAL",
      payloadJson: "{}",
      createdAt: "not-an-instant",
    },
    {
      id: "event-valid",
      orderId: order.id,
      eventType: "VALID_TIME_EVENT",
      eventSource: "EXCHANGE",
      payloadJson: "{}",
      createdAt: "2026-04-20T00:30:00.000Z",
    },
  ];
  const fills: FillRecord[] = [
    {
      id: "fill-invalid",
      orderId: order.id,
      exchangeFillId: "fill-invalid",
      market: "KRW-BTC",
      side: "bid",
      price: "100000000",
      volume: "0.00001",
      feeCurrency: "KRW",
      feeAmount: "0.1",
      filledAt: "invalid-fill-time",
      rawPayloadJson: "{}",
    },
    {
      id: "fill-valid",
      orderId: order.id,
      exchangeFillId: "fill-valid",
      market: "KRW-BTC",
      side: "bid",
      price: "100000001",
      volume: "0.00002",
      feeCurrency: "KRW",
      feeAmount: "0.2",
      filledAt: "2026-04-20T00:30:00.000Z",
      rawPayloadJson: "{}",
    },
  ];

  const message = formatOrderDetailSummaryMessage(order, events, fills, order.id, "ko-KR");

  assert.ok(message.indexOf("VALID_TIME_EVENT") < message.indexOf("INVALID_TIME_EVENT"));
  assert.ok(message.indexOf("100,000,001원") < message.indexOf("100,000,000원"));
  assert.match(message, /INVALID_TIME_EVENT · LOCAL · 시간 데이터 오류 \(not-an-instant\)/);
  assert.match(message, /시간 데이터 오류 \(invalid-fill-time\) · 100,000,000원/);
});

test("telegram order detail preserves fee decimal precision and reports unknown fee currency", () => {
  const order = createOrder({ id: "order-fee-precision" });
  const fills: FillRecord[] = [
    {
      id: "fill-krw-decimal",
      orderId: order.id,
      exchangeFillId: "fill-krw-decimal",
      market: "KRW-BTC",
      side: "bid",
      price: "100000000",
      volume: "0.00001",
      feeCurrency: "KRW",
      feeAmount: "0.00000001",
      filledAt: "2026-04-20T00:02:00.000Z",
      rawPayloadJson: "{}",
    },
    {
      id: "fill-unknown-currency",
      orderId: order.id,
      exchangeFillId: "fill-unknown-currency",
      market: "KRW-BTC",
      side: "bid",
      price: "100000000",
      volume: "0.00001",
      feeCurrency: null,
      feeAmount: "0.12345678",
      filledAt: "2026-04-20T00:01:00.000Z",
      rawPayloadJson: "{}",
    },
  ];

  const korean = formatOrderDetailSummaryMessage(order, [], fills, order.id, "ko-KR");
  const english = formatOrderDetailSummaryMessage(order, [], fills, order.id, "en-US");

  assert.match(korean, /수수료 0\.00000001원/);
  assert.match(korean, /수수료 0\.12345678 \(통화 미상\)/);
  assert.match(english, /Fee KRW 0\.00000001/);
  assert.match(english, /Fee 0\.12345678 \(currency unknown\)/);
});

test("telegram order detail distinguishes unavailable fee information from a real zero fee", () => {
  const order = createOrder({ id: "order-fee-availability" });
  const fills: FillRecord[] = [
    {
      id: "fill-fee-unavailable",
      orderId: order.id,
      exchangeFillId: "fill-fee-unavailable",
      market: "KRW-BTC",
      side: "bid",
      price: "100000000",
      volume: "0.00001",
      feeCurrency: "KRW",
      feeAmount: null,
      filledAt: "2026-04-20T00:02:00.000Z",
      rawPayloadJson: "{}",
    },
    {
      id: "fill-zero-fee",
      orderId: order.id,
      exchangeFillId: "fill-zero-fee",
      market: "KRW-BTC",
      side: "bid",
      price: "100000000",
      volume: "0.00001",
      feeCurrency: "KRW",
      feeAmount: "0",
      filledAt: "2026-04-20T00:01:00.000Z",
      rawPayloadJson: "{}",
    },
  ];

  const korean = formatOrderDetailSummaryMessage(order, [], fills, order.id, "ko-KR");
  const english = formatOrderDetailSummaryMessage(order, [], fills, order.id, "en-US");

  assert.match(korean, /수수료 정보 없음/);
  assert.match(korean, /수수료 0원/);
  assert.doesNotMatch(korean, /수수료 없음/);
  assert.match(english, /Fee unavailable/);
  assert.match(english, /Fee KRW 0/);
  assert.doesNotMatch(english, /no fee/);
});

test("telegram order detail labels malformed order and fill decimals as data errors", () => {
  const order = createOrder({
    id: "order-malformed-decimals",
    ordType: "limit",
    price: "bad-order-price",
    volume: "bad-order-volume",
  });
  const fills: FillRecord[] = [{
    id: "fill-malformed-decimals",
    orderId: order.id,
    exchangeFillId: "fill-malformed-decimals",
    market: "KRW-BTC",
    side: "bid",
    price: "bad-fill-price",
    volume: "bad-fill-volume",
    feeCurrency: "KRW",
    feeAmount: "bad-fee",
    filledAt: "2026-04-20T00:01:00.000Z",
    rawPayloadJson: "{}",
  }];

  const korean = formatOrderDetailSummaryMessage(order, [], fills, order.id, "ko-KR");
  const english = formatOrderDetailSummaryMessage(order, [], fills, order.id, "en-US");

  assert.match(korean, /주문 단가: 데이터 오류 \(bad-order-price\)/);
  assert.match(korean, /수량: 데이터 오류 \(bad-order-volume\)/);
  assert.match(korean, /가격 데이터 오류 \(bad-fill-price\)/);
  assert.match(korean, /수량 데이터 오류 \(bad-fill-volume\)/);
  assert.match(korean, /수수료 데이터 오류 \(bad-fee\)/);
  assert.doesNotMatch(korean, /주문 단가: 없음|수량: 없음/);
  assert.match(english, /Unit price: data error \(bad-order-price\)/);
  assert.match(english, /Volume: data error \(bad-order-volume\)/);
  assert.match(english, /Price data error \(bad-fill-price\)/);
  assert.match(english, /Volume data error \(bad-fill-volume\)/);
  assert.match(english, /Fee data error \(bad-fee\)/);
});

test("telegram /order detail preserves the canonical technical output exactly", async () => {
  const repository = new InMemoryExecutionRepository();
  const order = createOrder({
    id: "order-canonical",
    identifier: "order-canonical-identifier",
    status: "FILLED",
    failureCode: "RECONCILIATION_REQUIRED",
    failureMessage: "Exchange order lookup failed.",
  });
  const events: OrderEventRecord[] = [{
    id: "canonical-event",
    orderId: order.id,
    eventType: "ORDER_FILLED",
    eventSource: "EXCHANGE",
    payloadJson: JSON.stringify({ raw: true }),
    createdAt: "2026-04-20T00:02:00.000Z",
  }];
  const fills: FillRecord[] = [{
    id: "canonical-fill",
    orderId: order.id,
    exchangeFillId: "canonical-exchange-fill",
    market: "KRW-BTC",
    side: "bid",
    price: "500000",
    volume: "0.005",
    feeCurrency: "KRW",
    feeAmount: "250",
    filledAt: "2026-04-20T00:01:00.000Z",
    rawPayloadJson: JSON.stringify({ fill: true }),
  }];
  await repository.saveOrder(order);
  await repository.appendOrderEvent(events[0]!);
  await repository.saveFill(fills[0]!);
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: createRouterState(),
  });

  const response = await router.route("/order order-canonical-identifier DETAIL");

  assert.equal(
    response.text,
    formatOrderDetailMessage(order, events, fills, "order-canonical-identifier"),
  );
  assert.match(response.text, /failure_code: RECONCILIATION_REQUIRED/);
  assert.match(response.text, /failure_message: Exchange order lookup failed\./);
});

test("telegram order detail summary gives every persisted lifecycle state an honest meaning", () => {
  const statuses: OrderRecord["status"][] = [
    "INTENT_CREATED",
    "RISK_REJECTED",
    "PERSISTED",
    "SUBMITTING",
    "OPEN",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCEL_REQUESTED",
    "CANCELED",
    "REJECTED",
    "FAILED",
    "RECONCILIATION_REQUIRED",
  ];

  for (const status of statuses) {
    const message = formatOrderDetailSummaryMessage(
      createOrder({ id: `order-${status}`, status }),
      [],
      [],
      `order-${status}`,
      "en-US",
    );
    assert.match(message, /Meaning: /);
    if (["OPEN", "PARTIALLY_FILLED", "CANCEL_REQUESTED", "RECONCILIATION_REQUIRED"].includes(status)) {
      assert.match(message, /not complete/);
      assert.doesNotMatch(message, /records this order as filled|records this order as canceled/);
    }
  }
});

test("telegram order detail summary preserves Upbit price and volume semantics", () => {
  const cases: Array<{
    order: OrderRecord;
    expected: RegExp;
    absent?: RegExp;
  }> = [
    {
      order: createOrder({ id: "order-limit", ordType: "limit", side: "bid", price: "100000000", volume: "0.001" }),
      expected: /Unit price: KRW 100,000,000[\s\S]*Volume: 0\.001 BTC/,
    },
    {
      order: createOrder({ id: "order-price-bid", ordType: "price", side: "bid", price: "6000", volume: null }),
      expected: /Order amount: KRW 6,000/,
      absent: /Volume:/,
    },
    {
      order: createOrder({ id: "order-market-ask", ordType: "market", side: "ask", price: null, volume: "0.001" }),
      expected: /Volume: 0\.001 BTC/,
      absent: /Unit price:|Order amount:|Order price:/,
    },
    {
      order: createOrder({ id: "order-best-bid", ordType: "best", side: "bid", price: "6000", volume: null }),
      expected: /Order amount: KRW 6,000/,
      absent: /Volume:/,
    },
    {
      order: createOrder({ id: "order-best-ask", ordType: "best", side: "ask", price: null, volume: "0.001" }),
      expected: /Volume: 0\.001 BTC/,
      absent: /Unit price:|Order amount:|Order price:/,
    },
  ];

  for (const { order, expected, absent } of cases) {
    const message = formatOrderDetailSummaryMessage(order, [], [], order.id, "en-US");
    assert.match(message, expected);
    if (absent) {
      assert.doesNotMatch(message, absent);
    }
  }
});

test("telegram router renders a concise Korean orders summary with lifecycle counts and recent-order hints", async () => {
  const repository = new InMemoryExecutionRepository();
  let listOrdersCallCount = 0;
  const listOrders = repository.listOrders.bind(repository);
  repository.listOrders = async (exchangeAccountId) => {
    listOrdersCallCount += 1;
    return listOrders(exchangeAccountId);
  };
  const statuses: OrderRecord["status"][] = [
    "INTENT_CREATED",
    "RISK_REJECTED",
    "PERSISTED",
    "SUBMITTING",
    "OPEN",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCEL_REQUESTED",
    "CANCELED",
    "REJECTED",
    "FAILED",
    "RECONCILIATION_REQUIRED",
  ];
  for (const [index, status] of statuses.entries()) {
    await repository.saveOrder(createOrder({
      id: `order-summary-${index}`,
      identifier: `order-summary-identifier-${index}`,
      status,
      executionMode: index % 2 === 0 ? "LIVE" : "DRY_RUN",
      origin: index % 3 === 0 ? "RECOVERY" : index % 3 === 1 ? "OPERATOR" : "STRATEGY",
      side: index % 2 === 0 ? "bid" : "ask",
      ordType: index % 2 === 0 ? "price" : "market",
      price: index % 2 === 0 ? String(500_000 + index) : null,
      volume: index % 2 === 0 ? null : `0.0000000${index}`,
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

  assert.match(response.text, /최근 주문/);
  assert.match(response.text, /전체: 12건/);
  assert.match(response.text, /진행\/확인 필요: 7건/);
  assert.match(response.text, /체결 완료: 1건/);
  assert.match(response.text, /취소: 1건/);
  assert.match(response.text, /거부\/실패: 3건/);
  assert.match(response.text, /2026-04-20 09:11:00 KST/);
  assert.match(response.text, /KRW-BTC · 매도 · 확인 필요 · DRY_RUN · 전략/);
  assert.match(response.text, /수량: 0\.00000001 BTC/);
  assert.match(response.text, /확인: \/order order-summary-11/);
  assert.match(response.text, /KRW-BTC · 매수 · 실패 · LIVE · 운영자/);
  assert.match(response.text, /주문금액: 500,010원/);
  assert.match(response.text, /로컬 저장/);
  assert.match(response.text, /전송 중/);
  assert.match(response.text, /미체결/);
  assert.match(response.text, /부분 체결/);
  assert.match(response.text, /체결 완료/);
  assert.match(response.text, /취소 요청/);
  assert.match(response.text, /취소 완료/);
  assert.match(response.text, /거래소 거부/);
  assert.match(response.text, /2건은 생략되었습니다\./);
  assert.match(response.text, /전체 기술 목록: \/orders detail/);
  assert.doesNotMatch(response.text, /order-summary-1(?:\D|$)/);
  assert.doesNotMatch(response.text, /displayed_count:/);
  assert.equal(listOrdersCallCount, 1);

  const earlyRepository = new InMemoryExecutionRepository();
  await earlyRepository.saveOrder(createOrder({
    id: "order-summary-intent",
    status: "INTENT_CREATED",
  }));
  await earlyRepository.saveOrder(createOrder({
    id: "order-summary-risk",
    status: "RISK_REJECTED",
    updatedAt: "2026-04-20T00:01:00.000Z",
  }));
  const earlyRouter = new TelegramCommandRouter({
    repositories: earlyRepository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-orders-early",
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
  const earlyResponse = await earlyRouter.route("/orders");
  assert.match(earlyResponse.text, /주문 의도 생성/);
  assert.match(earlyResponse.text, /리스크 거부/);
});

test("telegram router renders equivalent English order labels and explicit terminal states", async () => {
  const repository = new InMemoryExecutionRepository();
  const statuses: OrderRecord["status"][] = [
    "INTENT_CREATED",
    "RISK_REJECTED",
    "PERSISTED",
    "SUBMITTING",
    "OPEN",
    "PARTIALLY_FILLED",
    "FILLED",
    "CANCEL_REQUESTED",
    "CANCELED",
    "REJECTED",
    "FAILED",
    "RECONCILIATION_REQUIRED",
  ];
  for (const [index, status] of statuses.entries()) {
    await repository.saveOrder(createOrder({
      id: `order-english-${index}`,
      identifier: `order-english-identifier-${index}`,
      status,
      side: index % 2 === 0 ? "bid" : "ask",
      origin: "STRATEGY",
      executionMode: "LIVE",
      updatedAt: `2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));
  }
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-orders-english",
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
    locale: "en-US",
  });

  const response = await router.route("/orders");

  assert.match(response.text, /Recent orders/);
  assert.match(response.text, /Total: 12/);
  assert.match(response.text, /Active\/recovery required: 7/);
  assert.match(response.text, /Filled: 1/);
  assert.match(response.text, /Canceled: 1/);
  assert.match(response.text, /Rejected\/failed: 3/);
  assert.match(response.text, /2026-04-20 09:11:00 KST/);
  assert.match(response.text, /KRW-BTC · Sell · Reconciliation required · LIVE · Strategy/);
  assert.match(response.text, /· Failed ·/);
  assert.match(response.text, /Persisted/);
  assert.match(response.text, /Submitting/);
  assert.match(response.text, /Open/);
  assert.match(response.text, /Partially filled/);
  assert.match(response.text, /Filled/);
  assert.match(response.text, /Cancel requested/);
  assert.match(response.text, /Canceled/);
  assert.match(response.text, /Rejected/);
  assert.match(response.text, /2 order\(s\) omitted\./);
  assert.match(response.text, /Full technical list: \/orders detail/);

  const earlyRepository = new InMemoryExecutionRepository();
  await earlyRepository.saveOrder(createOrder({
    id: "order-english-intent",
    status: "INTENT_CREATED",
  }));
  await earlyRepository.saveOrder(createOrder({
    id: "order-english-risk",
    status: "RISK_REJECTED",
    updatedAt: "2026-04-20T00:01:00.000Z",
  }));
  const earlyRouter = new TelegramCommandRouter({
    repositories: earlyRepository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-orders-english-early",
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
    locale: "en-US",
  });
  const earlyResponse = await earlyRouter.route("/orders");
  assert.match(earlyResponse.text, /Intent created/);
  assert.match(earlyResponse.text, /Risk rejected/);
});

test("telegram order summary preserves Upbit price and volume semantics for every supported order shape", () => {
  const cases: Array<{
    name: string;
    order: OrderRecord;
    expected: RegExp[];
    forbidden: RegExp[];
  }> = [
    {
      name: "limit bid",
      order: createOrder({
        id: "order-limit-bid",
        side: "bid",
        ordType: "limit",
        price: "119000000",
        volume: "0.0001",
      }),
      expected: [/주문 단가: 119,000,000원/, /수량: 0\.0001 BTC/],
      forbidden: [/주문금액:/],
    },
    {
      name: "limit ask",
      order: createOrder({
        id: "order-limit-ask",
        side: "ask",
        ordType: "limit",
        price: "120000000",
        volume: "0.0002",
      }),
      expected: [/주문 단가: 120,000,000원/, /수량: 0\.0002 BTC/],
      forbidden: [/주문금액:/],
    },
    {
      name: "best bid",
      order: createOrder({
        id: "order-best-bid",
        side: "bid",
        ordType: "best",
        price: "7000",
        volume: null,
        timeInForce: "ioc",
      }),
      expected: [/주문금액: 7,000원/],
      forbidden: [/주문 단가:/, /수량:/],
    },
    {
      name: "best ask",
      order: createOrder({
        id: "order-best-ask",
        side: "ask",
        ordType: "best",
        price: null,
        volume: "0.0003",
        timeInForce: "fok",
      }),
      expected: [/수량: 0\.0003 BTC/],
      forbidden: [/주문금액:/, /주문 단가:/],
    },
    {
      name: "market ask",
      order: createOrder({
        id: "order-market-ask",
        side: "ask",
        ordType: "market",
        price: null,
        volume: "0.0004",
      }),
      expected: [/수량: 0\.0004 BTC/],
      forbidden: [/주문금액:/, /주문 단가:/],
    },
    {
      name: "price bid",
      order: createOrder({
        id: "order-price-bid",
        side: "bid",
        ordType: "price",
        price: "8000",
        volume: null,
      }),
      expected: [/주문금액: 8,000원/],
      forbidden: [/주문 단가:/, /수량:/],
    },
  ];

  for (const orderCase of cases) {
    const message = formatOrdersSummaryMessage([orderCase.order], "ko-KR");
    for (const expected of orderCase.expected) {
      assert.match(message, expected, orderCase.name);
    }
    for (const forbidden of orderCase.forbidden) {
      assert.doesNotMatch(message, forbidden, orderCase.name);
    }
  }
});

test("telegram /orders detail preserves the canonical technical list exactly", async () => {
  const repository = new InMemoryExecutionRepository();
  for (let index = 0; index < 25; index += 1) {
    await repository.saveOrder(createOrder({
      id: `order-detail-${index}`,
      identifier: `order-detail-identifier-${index}`,
      updatedAt: `2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`,
    }));
  }
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-orders-detail",
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
  const orders = await repository.listOrders("primary");

  const response = await router.route("/orders DETAIL");

  assert.equal(response.text, formatOrdersMessage(orders, { limit: 20 }));
  assert.match(response.text, /displayed_count: 20/);
  assert.match(response.text, /omitted_count: 5/);
  assert.match(response.text, /order-detail-identifier-24/);
  assert.doesNotMatch(response.text, /order-detail-identifier-0/);
});

test("telegram /orders summary explicitly reports an empty persisted order list", async () => {
  const router = createRouter();
  const englishRouter = new TelegramCommandRouter({
    repositories: new InMemoryExecutionRepository(),
    operatorState: new InMemoryOperatorStateStore({
      id: "state-orders-empty-english",
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
    locale: "en-US",
  });

  const response = await router.route("/orders");
  const englishResponse = await englishRouter.route("/orders");

  assert.match(response.text, /최근 주문/);
  assert.match(response.text, /전체: 0건/);
  assert.match(response.text, /저장된 주문이 없습니다\./);
  assert.match(response.text, /전체 기술 목록: \/orders detail/);
  assert.match(englishResponse.text, /Recent orders/);
  assert.match(englishResponse.text, /Total: 0/);
  assert.match(englishResponse.text, /No stored orders\./);
  assert.match(englishResponse.text, /Full technical list: \/orders detail/);
});

test("telegram router renders a concise Korean execution status by default", async () => {
  const router = createRouter();

  const status = await router.route("/status");

  assert.match(status.text, /운영 상태/);
  assert.match(status.text, /시스템: 실행 중/);
  assert.match(status.text, /실행 모드: 모의 실행/);
  assert.match(status.text, /실주문: 차단됨/);
  assert.match(status.text, /차단 사유: 모의 실행 모드, 실주문 게이트 비활성화, 모의 주문 어댑터/);
  assert.match(status.text, /킬 스위치: 꺼짐/);
  assert.match(status.text, /스케줄러: 상태 정보 없음/);
  assert.match(status.text, /최근 동기화: 기록 없음/);
  assert.match(status.text, /업데이트: 2026-04-20 09:00:00 KST/);
  assert.match(status.text, /\/status detail/);
  assert.doesNotMatch(status.text, /state_source:/);
  assert.doesNotMatch(status.text, /blocked_by:/);
});

test("telegram router renders equivalent English blockers, degraded reason, scheduler, and reconciliation", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveReconciliationRun({
    id: "recon-english-summary-1",
    exchangeAccountId: "primary",
    status: "DRIFT_DETECTED",
    startedAt: "2026-04-20T00:02:00.000Z",
    completedAt: "2026-04-20T00:02:03.000Z",
    summaryJson: JSON.stringify({ source: "OPERATOR_SYNC", issues: [] }),
    errorMessage: null,
  });
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "state-1",
      exchangeAccountId: "primary",
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      systemStatus: "DEGRADED",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: "portfolio_drift_detected",
      degradedAt: "2026-04-20T00:01:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    }),
    liveSendPath: "LIVE_ADAPTER",
    locale: "en-US",
    schedulerStatus: () => ({
      enabled: true,
      started: true,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      startupPreflight: null,
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
          running: false,
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          skippedCount: 0,
          lastStartedAt: null,
          lastCompletedAt: null,
          lastStatus: "NEVER_RUN",
          lastStrategyDecisionId: null,
          lastAction: null,
          lastOrderId: null,
          lastOrderStatus: null,
          lastError: null,
          nextRunAt: "2026-04-20T01:00:00.000Z",
        },
        {
          market: "KRW-ETH",
          intervalMs: 3_600_000,
          running: false,
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          skippedCount: 0,
          lastStartedAt: null,
          lastCompletedAt: null,
          lastStatus: "NEVER_RUN",
          lastStrategyDecisionId: null,
          lastAction: null,
          lastOrderId: null,
          lastOrderStatus: null,
          lastError: null,
          nextRunAt: null,
        },
      ],
    }),
  });

  const status = await router.route("/status");

  assert.match(status.text, /Execution status/);
  assert.match(status.text, /System: degraded/);
  assert.match(status.text, /Execution mode: live/);
  assert.match(status.text, /Real orders: blocked/);
  assert.match(status.text, /Blocking reasons: system degraded/);
  assert.match(status.text, /Kill switch: off/);
  assert.match(status.text, /Degraded reason: portfolio_drift_detected/);
  assert.match(status.text, /Scheduler: enabled \(started\)/);
  assert.match(status.text, /KRW-BTC next run: 2026-04-20 10:00:00 KST/);
  assert.match(status.text, /KRW-ETH next run: none/);
  assert.match(status.text, /Latest reconciliation: drift detected \(2026-04-20 09:02:03 KST\)/);
  assert.match(status.text, /Updated: 2026-04-20 09:00:00 KST/);
  assert.match(status.text, /\/status detail/);
});

test("telegram router renders the English pause reason and paused blocker", async () => {
  const router = new TelegramCommandRouter({
    repositories: new InMemoryExecutionRepository(),
    operatorState: new InMemoryOperatorStateStore({
      id: "state-1",
      exchangeAccountId: "primary",
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      systemStatus: "PAUSED",
      killSwitchActive: false,
      pauseReason: "operator_maintenance",
      degradedReason: null,
      degradedAt: null,
      updatedAt: "2026-04-20T00:00:00.000Z",
    }),
    liveSendPath: "LIVE_ADAPTER",
    locale: "en-US",
  });

  const status = await router.route("/status");

  assert.match(status.text, /System: paused/);
  assert.match(status.text, /Real orders: blocked/);
  assert.match(status.text, /Blocking reasons: system paused/);
  assert.match(status.text, /Pause reason: operator_maintenance/);
});

test("telegram router preserves canonical technical status behind /status detail", async () => {
  const router = createRouter();

  const status = await router.route("/status detail");

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

test("telegram router captures one immutable runtime ownership snapshot for status and readiness", async () => {
  const router = createRouter();
  const snapshot = {
    status: "LOST",
    generation: 9,
    executionMode: "DRY_RUN",
    acquiredAtEpochMs: 1_785_000_000_000,
    heartbeatAtEpochMs: 1_785_000_010_000,
    expiresAtEpochMs: 1_785_000_055_000,
    takeover: true,
    lossReason: "PERSISTED_OWNERSHIP_MISMATCH",
  } as const;
  let snapshotCalls = 0;
  router.setRuntimeOwnershipSnapshotProvider(() => {
    snapshotCalls += 1;
    return snapshot;
  });

  const status = await router.route("/status detail");
  const readiness = await router.route("/readiness detail");

  assert.equal(snapshotCalls, 2);
  for (const message of [status.text, readiness.text]) {
    assert.match(message, /runtime_ownership_status: LOST/u);
    assert.match(message, /runtime_ownership_generation: 9/u);
    assert.match(message, /runtime_ownership_execution_mode: DRY_RUN/u);
    assert.match(message, /runtime_ownership_heartbeat_age_ms:/u);
    assert.match(message, /runtime_ownership_takeover: true/u);
    assert.match(message, /runtime_ownership_reason: PERSISTED_OWNERSHIP_MISMATCH/u);
  }
});

test("/status detail exactly equals the canonical formatStatusMessage output", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveReconciliationRun({
    id: "recon-canonical-status-1",
    exchangeAccountId: "primary",
    status: "DRIFT_DETECTED",
    startedAt: "2026-04-20T00:02:00.000Z",
    completedAt: "2026-04-20T00:02:03.000Z",
    summaryJson: JSON.stringify({
      source: "OPERATOR_SYNC",
      issues: [{ code: "ORDER_FILLS_BACKFILLED", message: "Backfilled one fill." }],
    }),
    errorMessage: null,
  });
  await repository.saveStrategySchedulerRun({
    id: "scheduler-canonical-status-1",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    triggerSource: "SCHEDULER",
    status: "COMPLETED",
    startedAt: "2026-04-20T00:03:00.000Z",
    completedAt: "2026-04-20T00:03:01.000Z",
    intervalMs: 3_600_000,
    runOnStart: false,
    strategyDecisionId: "decision-canonical-1",
    action: "HOLD",
    orderId: null,
    orderStatus: null,
    submissionAccepted: null,
    detail: "No order requested.",
    errorMessage: null,
    summaryJson: JSON.stringify({ status: "COMPLETED" }),
  });
  const state = {
    id: "state-canonical-1",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  } satisfies ExecutionStateRecord;
  const operatorState = new InMemoryOperatorStateStore(state);
  const schedulerStatus = {
    enabled: true,
    started: true,
    exchangeAccountId: "primary",
    liveSendPath: "DRY_RUN_ADAPTER",
    startupPreflight: null,
    markets: [
      {
        market: "KRW-BTC",
        intervalMs: 3_600_000,
        running: false,
        runCount: 1,
        successCount: 1,
        failureCount: 0,
        skippedCount: 0,
        lastStartedAt: "2026-04-20T00:03:00.000Z",
        lastCompletedAt: "2026-04-20T00:03:01.000Z",
        lastStatus: "COMPLETED",
        lastStrategyDecisionId: "decision-canonical-1",
        lastAction: "HOLD",
        lastOrderId: null,
        lastOrderStatus: null,
        lastError: null,
        nextRunAt: "2026-04-20T01:00:00.000Z",
      },
    ],
  } satisfies StrategySchedulerStatus;
  const executionStateSeed = {
    executionMode: "DRY_RUN" as const,
    liveExecutionGate: "DISABLED" as const,
    killSwitchActive: false,
  };
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState,
    executionStateSeed,
    liveSendPath: "DRY_RUN_ADAPTER",
    schedulerStatus: () => schedulerStatus,
  });

  const actual = await router.route("/status detail");
  const [transitions, reconciliationRuns, schedulerRuns] = await Promise.all([
    operatorState.listTransitions(3),
    repository.listReconciliationRuns("primary", 1),
    repository.listStrategySchedulerRuns("primary", 5),
  ]);
  const expected = formatStatusMessage(state, {
    executionStateSeed,
    liveSendPath: "DRY_RUN_ADAPTER",
    transitions,
    latestReconciliationRun: reconciliationRuns[0] ?? null,
    schedulerStatus,
    schedulerRuns,
  });

  assert.equal(actual.text, expected);
});

test("telegram status summary explains degraded state and scheduler next runs", async () => {
  const router = new TelegramCommandRouter({
    repositories: new InMemoryExecutionRepository(),
    operatorState: new InMemoryOperatorStateStore({
      id: "state-1",
      exchangeAccountId: "primary",
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      systemStatus: "DEGRADED",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: "portfolio_drift_detected",
      degradedAt: "2026-04-20T00:01:00.000Z",
      updatedAt: "2026-04-20T00:02:00.000Z",
    }),
    liveSendPath: "LIVE_ADAPTER",
    schedulerStatus: () => ({
      enabled: true,
      started: true,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      startupPreflight: null,
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
          running: false,
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          skippedCount: 0,
          lastStartedAt: null,
          lastCompletedAt: null,
          lastStatus: "NEVER_RUN",
          lastStrategyDecisionId: null,
          lastAction: null,
          lastOrderId: null,
          lastOrderStatus: null,
          lastError: null,
          nextRunAt: "2026-04-20T01:00:00.000Z",
        },
        {
          market: "KRW-ETH",
          intervalMs: 3_600_000,
          running: false,
          runCount: 0,
          successCount: 0,
          failureCount: 0,
          skippedCount: 0,
          lastStartedAt: null,
          lastCompletedAt: null,
          lastStatus: "NEVER_RUN",
          lastStrategyDecisionId: null,
          lastAction: null,
          lastOrderId: null,
          lastOrderStatus: null,
          lastError: null,
          nextRunAt: null,
        },
      ],
    }),
  });

  const status = await router.route("/status");

  assert.match(status.text, /시스템: 점검 필요/);
  assert.match(status.text, /실주문: 차단됨/);
  assert.match(status.text, /차단 사유: 시스템 성능 저하 상태/);
  assert.match(status.text, /점검 사유: portfolio_drift_detected/);
  assert.match(status.text, /스케줄러: 사용 중 \(시작됨\)/);
  assert.match(status.text, /KRW-BTC 다음 실행: 2026-04-20 10:00:00 KST/);
  assert.match(status.text, /KRW-ETH 다음 실행: 없음/);
});

test("telegram status summary explains paused and kill-switched blockers", async () => {
  for (const scenario of [
    {
      systemStatus: "PAUSED" as const,
      killSwitchActive: false,
      pauseReason: "operator_maintenance",
      expectedStatus: /시스템: 일시정지/,
      expectedBlocker: /차단 사유: 운영 일시정지/,
      expectedReason: /일시정지 사유: operator_maintenance/,
    },
    {
      systemStatus: "KILL_SWITCHED" as const,
      killSwitchActive: true,
      pauseReason: "emergency_stop",
      expectedStatus: /시스템: 긴급 중지/,
      expectedBlocker: /차단 사유: 킬 스위치 활성화/,
      expectedReason: /일시정지 사유: emergency_stop/,
    },
  ]) {
    const router = new TelegramCommandRouter({
      repositories: new InMemoryExecutionRepository(),
      operatorState: new InMemoryOperatorStateStore({
        id: "state-1",
        exchangeAccountId: "primary",
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
        systemStatus: scenario.systemStatus,
        killSwitchActive: scenario.killSwitchActive,
        pauseReason: scenario.pauseReason,
        degradedReason: null,
        degradedAt: null,
        updatedAt: "2026-04-20T00:00:00.000Z",
      }),
      liveSendPath: "LIVE_ADAPTER",
    });

    const status = await router.route("/status");

    assert.match(status.text, scenario.expectedStatus);
    assert.match(status.text, /실주문: 차단됨/);
    assert.match(status.text, scenario.expectedBlocker);
    assert.match(status.text, scenario.expectedReason);
  }
});

test("telegram status summary includes the latest reconciliation status in KST", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveReconciliationRun({
    id: "recon-summary-1",
    exchangeAccountId: "primary",
    status: "DRIFT_DETECTED",
    startedAt: "2026-04-20T00:02:00.000Z",
    completedAt: "2026-04-20T00:02:03.000Z",
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
  });

  const status = await router.route("/status");

  assert.match(status.text, /최근 동기화: 차이 감지 \(2026-04-20 09:02:03 KST\)/);
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

  const status = await router.route("/status detail");

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

  const scheduler = await router.route("/scheduler detail");

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

  assert.equal(scheduler.text.split("\n")[0], "전략 스케줄러");
  assert.match(scheduler.text, /전략 스케줄러/);
  assert.match(scheduler.text, /현재 런타임 상태를 확인할 수 없습니다/);
  assert.match(scheduler.text, /최근 저장된 실행 이력이 없습니다/);
  assert.match(scheduler.text, /\/scheduler detail/);
});

test("telegram scheduler summary directly reports a disabled runtime in Korean and English", () => {
  const disabledStatus: StrategySchedulerStatus = {
    enabled: false,
    started: false,
    exchangeAccountId: "primary",
    liveSendPath: "DRY_RUN_ADAPTER",
    startupPreflight: null,
    markets: [],
  };

  const korean = formatStrategySchedulerRunsSummaryMessage([], disabledStatus, "ko-KR");
  const english = formatStrategySchedulerRunsSummaryMessage([], disabledStatus, "en-US");

  assert.match(korean, /상태: 비활성/);
  assert.match(english, /State: disabled/);
  assert.doesNotMatch(korean, /시작되지 않음/);
  assert.doesNotMatch(english, /enabled but not started/);
});

test("telegram scheduler summary separates runtime memory from bounded persisted history", async () => {
  const runs: StrategySchedulerRunRecord[] = [
    createSchedulerRun({
      id: "scheduler-invalid",
      market: "KRW-BTC",
      status: "STARTED",
      startedAt: "invalid-timestamp",
      completedAt: null,
      action: "ENTER",
      detail: "Invalid timestamp row",
    }),
    createSchedulerRun({
      id: "scheduler-offset-newest",
      market: "KRW-ETH",
      status: "COMPLETED",
      startedAt: "2026-04-20T09:05:00+09:00",
      completedAt: "2026-04-20T09:06:00+09:00",
      action: "ADD",
      orderId: "order-newest",
      orderStatus: "FILLED",
      submissionAccepted: true,
      detail: "Order completed",
    }),
    createSchedulerRun({
      id: "scheduler-zulu-older",
      market: "KRW-BTC",
      status: "FAILED",
      startedAt: "2026-04-20T00:04:00.000Z",
      completedAt: "2026-04-20T00:04:30.000Z",
      action: "REDUCE",
      errorMessage: "upbit timeout",
    }),
    createSchedulerRun({
      id: "scheduler-skipped",
      market: "KRW-ETH",
      status: "SKIPPED",
      startedAt: "2026-04-20T00:03:00.000Z",
      completedAt: "2026-04-20T00:03:01.000Z",
      action: "EXIT",
      detail: "Deferred after another order",
    }),
  ];
  let historyReads = 0;
  let runtimeReads = 0;
  const repository = new InMemoryExecutionRepository();
  for (const run of runs) {
    await repository.saveStrategySchedulerRun(run);
  }
  const listSchedulerRuns = repository.listStrategySchedulerRuns.bind(repository);
  repository.listStrategySchedulerRuns = async (exchangeAccountId, limit) => {
    historyReads += 1;
    assert.equal(limit, 20);
    return listSchedulerRuns(exchangeAccountId, limit);
  };
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore(createSchedulerExecutionState()),
    locale: "ko-KR",
    schedulerStatus: () => {
      runtimeReads += 1;
      return {
        enabled: true,
        started: true,
        exchangeAccountId: "primary",
        liveSendPath: "LIVE_ADAPTER",
        startupPreflight: {
          checkedAt: "2026-04-20T00:00:00.000Z",
          scope: "LIVE",
          status: "WARN",
          detail: "History recovery remains in progress.",
          checks: [
            { name: "live_gate", status: "PASS", detail: "enabled" },
            { name: "latest_reconciliation", status: "WARN", detail: "archive in progress" },
            { name: "active_orders", status: "BLOCK", detail: "one active order" },
          ],
        },
        markets: [
          {
            market: "KRW-BTC",
            intervalMs: 3_600_000,
            running: false,
            runCount: 4,
            successCount: 2,
            failureCount: 1,
            skippedCount: 1,
            lastStartedAt: "2026-04-20T00:00:00.000Z",
            lastCompletedAt: "2026-04-20T00:00:02.000Z",
            lastStatus: "COMPLETED",
            lastStrategyDecisionId: "decision-runtime",
            lastAction: "EXIT",
            lastOrderId: "order-runtime",
            lastOrderStatus: "OPEN",
            lastError: null,
            nextRunAt: "2026-04-20T01:00:00.000Z",
          },
        ],
      };
    },
  });

  const response = await router.route("/scheduler");

  assert.equal(historyReads, 1);
  assert.equal(runtimeReads, 1);
  assert.match(response.text, /현재 메모리 상태/);
  assert.match(response.text, /최근 저장 이력.*최대 20건/);
  assert.match(response.text, /연결 경로.*LIVE_ADAPTER.*주문 허용을 뜻하지 않습니다/);
  assert.match(response.text, /PASS 1.*주의 1.*차단 1/);
  assert.match(response.text, /latest_reconciliation.*archive in progress/);
  assert.match(response.text, /active_orders.*one active order/);
  assert.match(response.text, /KRW-BTC.*1시간/);
  assert.match(response.text, /2026-04-20 10:00:00 KST/);
  assert.match(response.text, /\/order order-runtime/);
  assert.match(response.text, /시작 1.*완료 1.*실패 1.*건너뜀 1/);
  assert.ok(response.text.indexOf("order-newest") < response.text.indexOf("upbit timeout"));
  assert.match(response.text, /표시 3건.*생략 1건/);
  assert.doesNotMatch(response.text, /Invalid timestamp row/);
  assert.match(response.text, /\/scheduler detail/);
});

test("telegram scheduler summary puts an invalid persisted timestamp last and labels it", () => {
  const message = formatStrategySchedulerRunsSummaryMessage(
    [
      createSchedulerRun({
        id: "scheduler-invalid-visible",
        startedAt: "not-a-time",
        detail: "Invalid timestamp row",
      }),
      createSchedulerRun({
        id: "scheduler-valid",
        startedAt: "2026-04-20T00:00:00.000Z",
        detail: "Valid timestamp row",
      }),
    ],
    null,
    "ko-KR",
  );

  assert.ok(message.indexOf("Valid timestamp row") < message.indexOf("Invalid timestamp row"));
  assert.match(message, /잘못된 시각 \(not-a-time\)/);
});

test("telegram scheduler summary supports English and preserves canonical detail exactly", async () => {
  const runs = [
    createSchedulerRun({
      id: "scheduler-en",
      status: "COMPLETED",
      action: "HOLD",
      startedAt: "2026-04-20T00:00:00.000Z",
      completedAt: "2026-04-20T00:00:01.000Z",
      detail: "Held position",
    }),
  ];
  const schedulerStatus: StrategySchedulerStatus = {
    enabled: true,
    started: false,
    exchangeAccountId: "primary",
    liveSendPath: "DRY_RUN_ADAPTER",
    startupPreflight: {
      checkedAt: "2026-04-20T00:00:00.000Z",
      scope: "DRY_RUN",
      status: "PASS",
      detail: "Dry-run preflight passed.",
      checks: [],
    },
    markets: [],
  };
  const repository = new InMemoryExecutionRepository();
  for (const run of runs) {
    await repository.saveStrategySchedulerRun(run);
  }
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore(createSchedulerExecutionState()),
    locale: "en-US",
    schedulerStatus: () => schedulerStatus,
  });

  const summary = await router.route("/scheduler");
  const detail = await router.route("/scheduler DETAIL");

  assert.match(summary.text, /Strategy scheduler/);
  assert.match(summary.text, /enabled but not started/);
  assert.match(summary.text, /Current in-memory runtime status/);
  assert.match(summary.text, /Recent persisted history/);
  assert.match(summary.text, /Started 0.*Completed 1.*Failed 0.*Skipped 0/);
  assert.equal(detail.text, formatStrategySchedulerRunsMessage(runs, { schedulerStatus }));
  assert.equal(
    formatStrategySchedulerRunsSummaryMessage(runs, schedulerStatus, "en-US"),
    summary.text,
  );
});

function createSchedulerRun(
  overrides: Partial<StrategySchedulerRunRecord>,
): StrategySchedulerRunRecord {
  return {
    id: "scheduler-run",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    triggerSource: "SCHEDULER",
    status: "COMPLETED",
    startedAt: "2026-04-20T00:00:00.000Z",
    completedAt: "2026-04-20T00:00:01.000Z",
    intervalMs: 3_600_000,
    runOnStart: false,
    strategyDecisionId: null,
    action: null,
    orderId: null,
    orderStatus: null,
    submissionAccepted: null,
    detail: null,
    errorMessage: null,
    summaryJson: "{}",
    ...overrides,
  };
}

function createSchedulerExecutionState(): ExecutionStateRecord {
  return {
    id: "scheduler-state",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
}

function createInboundStatus(
  overrides: Partial<TelegramInboundPollingStatus> = {},
): TelegramInboundPollingStatus {
  return {
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
    ...overrides,
  };
}

test("telegram /inbound returns a Korean healthy summary with synchronized persisted progress", async () => {
  let runtimeReads = 0;
  let offsetReads = 0;
  const router = new TelegramCommandRouter({
    repositories: new InMemoryExecutionRepository(),
    operatorState: createRouterState(),
    telegramInboundBotTokenRef: "sha256:bot-a",
    telegramInboundStatus: () => {
      runtimeReads += 1;
      return createInboundStatus();
    },
    telegramInboundOffsetStore: {
      async getTelegramInboundOffset(input) {
        offsetReads += 1;
        assert.deepEqual(input, {
          exchangeAccountId: "primary",
          updateSource: "GET_UPDATES",
          botTokenRef: "sha256:bot-a",
        });
        return {
          id: "telegram-inbound-offset-1",
          exchangeAccountId: "primary",
          updateSource: "GET_UPDATES",
          botTokenRef: "sha256:bot-a",
          nextOffset: 42,
          lastUpdateId: 41,
          updatedAt: "2026-04-20T00:11:00.000Z",
        };
      },
      async saveTelegramInboundOffset() {
        throw new Error("/inbound must not mutate persisted offset state");
      },
    },
  });

  const inbound = await router.route("/inbound");

  assert.match(inbound.text, /^텔레그램 명령 수신$/m);
  assert.match(inbound.text, /현재 메모리 폴링 상태:/);
  assert.match(inbound.text, /상태: 실행 중/);
  assert.match(inbound.text, /다음 조치: 없음/);
  assert.match(inbound.text, /활성화 예 \| 설정 완료 예 \| 실행 중 예/);
  assert.match(inbound.text, /오프셋 저장: 영구 저장/);
  assert.match(inbound.text, /런타임 오프셋 로드: 예/);
  assert.match(inbound.text, /다음 오프셋 42 \| 최근 업데이트 ID 41/);
  assert.match(inbound.text, /폴링 간격 2초 \| 롱폴링 제한 25초 \| 배치 한도 10건/);
  assert.match(inbound.text, /최근 폴링 2026-04-20 09:12:00 KST/);
  assert.match(inbound.text, /처리 3건 \| 무시 1건 \| 실패 0건/);
  assert.match(inbound.text, /저장된 telegram_inbound_offsets 진행:/);
  assert.match(inbound.text, /저장 레코드: 있음/);
  assert.match(inbound.text, /다음 오프셋 42 \| 최근 업데이트 ID 41/);
  assert.match(inbound.text, /저장 갱신 2026-04-20 09:11:00 KST/);
  assert.match(inbound.text, /런타임과 저장 오프셋 비교: 동기화됨/);
  assert.match(inbound.text, /전체 기술 정보: \/inbound detail/);
  assert.doesNotMatch(inbound.text, /sha256:bot-a|botTokenRef|bot_token_ref/);
  assert.equal(runtimeReads, 1);
  assert.equal(offsetReads, 1);
});

test("telegram /inbound renders every runtime state and absent persisted progress", async () => {
  const cases: Array<{
    status: TelegramInboundPollingStatus | null;
    expectedState: RegExp;
    expectedAction: RegExp;
  }> = [
    {
      status: null,
      expectedState: /상태: 확인 불가/,
      expectedAction: /다음 조치: 런타임 상태 연결 확인/,
    },
    {
      status: createInboundStatus({ enabled: false, configured: false, running: false }),
      expectedState: /상태: 비활성/,
      expectedAction: /다음 조치: 필요 시 인바운드 폴링 활성화/,
    },
    {
      status: createInboundStatus({ configured: false, running: false }),
      expectedState: /상태: 활성화됐지만 설정 미완료/,
      expectedAction: /다음 조치: 봇 토큰과 운영자 채팅 ID 설정/,
    },
    {
      status: createInboundStatus({ running: false }),
      expectedState: /상태: 설정됐지만 실행 중이 아님/,
      expectedAction: /다음 조치: 인바운드 폴링 시작 상태 확인/,
    },
    {
      status: createInboundStatus(),
      expectedState: /상태: 실행 중/,
      expectedAction: /다음 조치: 없음/,
    },
  ];

  for (const entry of cases) {
    const router = new TelegramCommandRouter({
      repositories: new InMemoryExecutionRepository(),
      operatorState: createRouterState(),
      telegramInboundBotTokenRef: "sha256:bot-a",
      telegramInboundStatus: () => entry.status,
      telegramInboundOffsetStore: {
        async getTelegramInboundOffset() {
          return null;
        },
        async saveTelegramInboundOffset() {
          throw new Error("/inbound must not mutate persisted offset state");
        },
      },
    });

    const response = await router.route("/inbound");
    assert.match(response.text, entry.expectedState);
    assert.match(response.text, entry.expectedAction);
    assert.match(response.text, /저장 레코드: 없음/);
    assert.match(response.text, /런타임과 저장 오프셋 비교: 확인 불가/);
  }
});

test("telegram /inbound exposes failures and distinguishes different offsets", async () => {
  const exactError = "telegram_http_502: upstream gateway timeout";
  const router = new TelegramCommandRouter({
    repositories: new InMemoryExecutionRepository(),
    operatorState: createRouterState(),
    telegramInboundBotTokenRef: "sha256:bot-a",
    telegramInboundStatus: () => createInboundStatus({
      failedCount: 2,
      lastError: exactError,
    }),
    telegramInboundOffsetStore: {
      async getTelegramInboundOffset() {
        return {
          id: "telegram-inbound-offset-1",
          exchangeAccountId: "primary",
          updateSource: "GET_UPDATES",
          botTokenRef: "sha256:bot-a",
          nextOffset: 40,
          lastUpdateId: 39,
          updatedAt: "2026-04-20T00:11:00.000Z",
        };
      },
      async saveTelegramInboundOffset() {
        throw new Error("/inbound must not mutate persisted offset state");
      },
    },
  });

  const response = await router.route("/inbound");

  assert.match(response.text, /다음 조치: 최근 폴링 오류 확인/);
  assert.match(response.text, /처리 3건 \| 무시 1건 \| 실패 2건/);
  assert.match(response.text, new RegExp(`최근 오류: ${exactError}`));
  assert.match(response.text, /런타임과 저장 오프셋 비교: 다름/);
});

test("telegram /inbound supports en-US and preserves exact canonical detail", async () => {
  const status = createInboundStatus();
  const offset = {
    id: "telegram-inbound-offset-1",
    exchangeAccountId: "primary",
    updateSource: "GET_UPDATES",
    botTokenRef: "sha256:bot-a",
    nextOffset: 42,
    lastUpdateId: 41,
    updatedAt: "2026-04-20T00:11:00.000Z",
  } as const;
  let runtimeReads = 0;
  let offsetReads = 0;
  const router = new TelegramCommandRouter({
    repositories: new InMemoryExecutionRepository(),
    operatorState: createRouterState(),
    locale: "en-US",
    telegramInboundBotTokenRef: "sha256:bot-a",
    telegramInboundStatus: () => {
      runtimeReads += 1;
      return status;
    },
    telegramInboundOffsetStore: {
      async getTelegramInboundOffset() {
        offsetReads += 1;
        return offset;
      },
      async saveTelegramInboundOffset() {
        throw new Error("/inbound must not mutate persisted offset state");
      },
    },
  });

  const summary = await router.route("/inbound");
  assert.match(summary.text, /^Telegram command inbound$/m);
  assert.match(summary.text, /Current in-memory polling state:/);
  assert.match(summary.text, /State: running/);
  assert.match(summary.text, /Next action: none/);
  assert.match(summary.text, /Offset storage: durable/);
  assert.match(summary.text, /Runtime and persisted offset comparison: synchronized/);
  assert.match(summary.text, /Full technical details: \/inbound detail/);

  const detail = await router.route("/inbound DETAIL");
  assert.equal(detail.text, formatTelegramInboundMessage(status, offset));
  assert.match(detail.text, /persisted_bot_token_ref: sha256:bot-a/);
  assert.equal(runtimeReads, 2);
  assert.equal(offsetReads, 2);
  assert.equal(
    (await router.route("/inbound now")).text,
    "Usage: /inbound [detail]\nShow a concise Telegram inbound summary or the canonical technical polling and offset detail.",
  );
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

  const status = await router.route("/status detail");

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

  const alerts = await router.route("/alerts detail");

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

  const alerts = await router.route("/alerts detail");

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

test("telegram alerts summary leads with Korean delivery health and sorts persisted alerts by instant", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveOperatorNotification(createNotification({
    id: "operator-notification-invalid",
    notificationType: "SYNC_FAILED",
    severity: "ERROR",
    title: "Sync evidence",
    message: "Persisted invalid timestamp evidence.",
    deliveryStatus: "FAILED",
    attemptCount: 2,
    lastAttemptAt: "2026-04-20T00:04:00.000Z",
    failureClass: "PERMANENT",
    lastError: "sync_failed",
    createdAt: "invalid-time",
  }));
  await repository.saveOperatorNotification(createNotification({
    id: "operator-notification-offset-newest",
    notificationType: "SCHEDULER_ORDER_SUBMITTED",
    severity: "INFO",
    title: "Scheduled order submitted",
    message: "Persisted submission evidence.",
    deliveryStatus: "SENT",
    attemptCount: 1,
    deliveredAt: "2026-04-20T00:31:01.000Z",
    createdAt: "2026-04-20T09:31:00+09:00",
  }));
  await repository.saveOperatorNotification(createNotification({
    id: "operator-notification-pending",
    notificationType: "ORDER_REJECTED",
    severity: "WARN",
    title: "Order rejected before submission",
    message: "Persisted rejection evidence.",
    deliveryStatus: "PENDING",
    nextAttemptAt: "2026-04-20T00:35:00.000Z",
    createdAt: "2026-04-20T00:30:00.000Z",
  }));
  await repository.saveOperatorNotificationDeliveryAttempt({
    id: "attempt-retry",
    notificationId: "operator-notification-pending",
    exchangeAccountId: "primary",
    attemptCount: 1,
    leaseToken: "lease-retry",
    outcome: "RETRY_SCHEDULED",
    failureClass: "RETRYABLE",
    attemptedAt: "2026-04-20T00:32:00.000Z",
    nextAttemptAt: "2026-04-20T00:35:00.000Z",
    deliveredAt: null,
    errorMessage: "telegram_http_500",
    createdAt: "2026-04-20T00:32:00.000Z",
  });
  await repository.saveOperatorNotificationDeliveryRun({
    id: "delivery-run-failed",
    exchangeAccountId: "primary",
    workerName: "telegram_delivery_inline_worker",
    status: "FAILED",
    startedAt: "2026-04-20T00:32:00.000Z",
    completedAt: "2026-04-20T00:32:01.000Z",
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
    errorMessage: "worker_failed",
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
    now: () => "2026-04-20T00:33:00.000Z",
  });

  const alerts = await router.route("/alerts");

  assert.match(alerts.text, /알림 전송 상태/);
  assert.match(alerts.text, /최근 조회 표본: 알림 최대 10건.*전송 시도 최대 5건/);
  assert.match(alerts.text, /표본 내 대기 1.*즉시 전송 0.*재시도 예정 1.*실패 알림 1/);
  assert.match(alerts.text, /표본 내 임대: 활성 0.*만료 0/);
  assert.match(alerts.text, /표본 내 최근 전송 시도: 전송 0.*재시도 예약 1.*실패 0.*만료 임대 0/);
  assert.ok(
    alerts.text.indexOf("2026-04-20 09:31:00 KST") <
      alerts.text.indexOf("2026-04-20 09:30:00 KST"),
  );
  assert.ok(alerts.text.indexOf("2026-04-20 09:30:00 KST") < alerts.text.indexOf("데이터 오류"));
  assert.match(alerts.text, /정보.*스케줄 주문 제출.*전송 완료/);
  assert.match(alerts.text, /주의.*주문 거부.*전송 대기/);
  assert.match(alerts.text, /오류.*동기화 실패.*전송 실패/);
  assert.match(alerts.text, /제목: Scheduled order submitted/);
  assert.match(alerts.text, /내용: Persisted submission evidence\./);
  assert.match(alerts.text, /시도 횟수: 2/);
  assert.match(alerts.text, /마지막 시도: 2026-04-20 09:04:00 KST/);
  assert.match(alerts.text, /다음 재시도: 2026-04-20 09:35:00 KST/);
  assert.match(alerts.text, /전송 완료: 2026-04-20 09:31:01 KST/);
  assert.match(alerts.text, /오류: sync_failed/);
  assert.match(alerts.text, /최근 전송 실행: 실패/);
  assert.match(alerts.text, /최근 시도 결과: 재시도 예약/);
  assert.match(alerts.text, /전체 기술 정보: \/alerts detail/);
});

test("telegram alerts summary maps every notification and delivery enum in English", () => {
  const notificationTypes: readonly OperatorNotificationType[] = [
    "ORDER_REJECTED",
    "ORDER_SUBMISSION_FAILED",
    "RECONCILIATION_DRIFT_DETECTED",
    "SCHEDULER_STARTUP_BLOCKED",
    "SCHEDULER_ORDER_REJECTED",
    "SCHEDULER_ORDER_SUBMITTED",
    "SCHEDULER_RUN_FAILED",
    "SCHEDULER_RUN_SKIPPED",
    "SYNC_FAILED",
    "POSITION_GUARD_PILOT_ACTIVATED",
    "POSITION_GUARD_PILOT_FAULT_PAUSED",
    "POSITION_GUARD_PILOT_UNCERTAIN_SUBMISSION",
    "POSITION_GUARD_PILOT_ROLLBACK_STARTED",
    "POSITION_GUARD_PILOT_ROLLBACK_COMPLETED",
  ];
  const severities = ["INFO", "WARN", "ERROR"] as const;
  const deliveryStatuses = ["PENDING", "SENT", "FAILED"] as const;
  for (const [index, notificationType] of notificationTypes.entries()) {
    const message = formatOperatorNotificationsSummaryMessage(
      [createNotification({
      id: `notification-${index}`,
      notificationType,
      severity: severities[index % severities.length]!,
      deliveryStatus: deliveryStatuses[index % deliveryStatuses.length]!,
      title: `Original title ${notificationType}`,
      message: `Original message ${notificationType}`,
      createdAt: `2026-04-20T00:${String(index).padStart(2, "0")}:00.000Z`,
      })],
      [],
      [],
      "en-US",
      { now: "2026-04-20T00:10:00.000Z" },
    );
    assert.match(message, new RegExp(escapeRegExp([
      "Order rejected",
      "Order submission failed",
      "Reconciliation drift detected",
      "Scheduler startup blocked",
      "Scheduled order rejected",
      "Scheduled order submitted",
      "Scheduled run failed",
      "Scheduled run skipped",
      "Sync failed",
      "BTC candidate pilot activated",
      "BTC candidate pilot fault paused",
      "BTC candidate pilot submission uncertain",
      "BTC candidate pilot rollback started",
      "BTC candidate pilot rollback completed",
    ][index]!)));
    assert.match(message, new RegExp(escapeRegExp(["Info", "Warning", "Error"][index % 3]!)));
    assert.match(message, new RegExp(escapeRegExp(["Pending", "Sent", "Failed"][index % 3]!)));
    assert.match(message, new RegExp(escapeRegExp(`Original title ${notificationType}`)));
    assert.match(message, new RegExp(escapeRegExp(`Original message ${notificationType}`)));
  }

  for (const [index, outcome] of ([
    "SENT",
    "RETRY_SCHEDULED",
    "FAILED",
    "STALE_LEASE",
  ] as const).entries()) {
    const message = formatOperatorNotificationsSummaryMessage(
      [],
      [createDeliveryAttempt(outcome, index)],
      [],
      "en-US",
    );
    assert.match(message, new RegExp(escapeRegExp([
      "Sent",
      "Retry scheduled",
      "Failed",
      "Stale lease",
    ][index]!)));
  }

  for (const [index, status] of (["COMPLETED", "SKIPPED", "FAILED"] as const).entries()) {
    const message = formatOperatorNotificationsSummaryMessage(
      [],
      [],
      [createDeliveryRun(status, index)],
      "en-US",
    );
    assert.match(message, new RegExp(escapeRegExp(["Completed", "Skipped", "Failed"][index]!)));
  }
});

test("telegram alerts summary bounds displayed histories and reports omitted sample records", () => {
  const notifications = Array.from({ length: 5 }, (_, index) =>
    createNotification({
      id: `notification-${index}`,
      title: `Original title ${index}`,
      message: `Original message ${index}`,
      createdAt: `2026-04-20T00:0${index}:00.000Z`,
    }),
  );
  const attempts = Array.from({ length: 3 }, (_, index) => createDeliveryAttempt("SENT", index));
  const runs = Array.from({ length: 3 }, (_, index) => createDeliveryRun("COMPLETED", index));

  const korean = formatOperatorNotificationsSummaryMessage(
    notifications,
    attempts,
    runs,
    "ko-KR",
  );
  const english = formatOperatorNotificationsSummaryMessage(
    notifications,
    attempts,
    runs,
    "en-US",
  );

  for (const message of [korean, english]) {
    assert.match(message, /Original title 4/);
    assert.match(message, /Original message 4/);
    assert.match(message, /Original title 3/);
    assert.match(message, /Original message 3/);
    assert.match(message, /Original title 2/);
    assert.match(message, /Original message 2/);
    assert.doesNotMatch(message, /Original title 1/);
    assert.doesNotMatch(message, /Original message 1/);
    assert.doesNotMatch(message, /Original title 0/);
    assert.doesNotMatch(message, /Original message 0/);
    assert.equal((message.match(/Recent delivery run:|최근 전송 실행:/g) ?? []).length, 1);
    assert.equal((message.match(/Recent attempt outcome:|최근 시도 결과:/g) ?? []).length, 1);
    assert.match(message, /\/alerts detail/);
  }

  assert.match(korean, /최근 알림 2건 생략/);
  assert.match(korean, /전송 실행 2건 생략/);
  assert.match(korean, /전송 시도 2건 생략/);
  assert.match(english, /2 recent alert\(s\) omitted/);
  assert.match(english, /2 delivery run\(s\) omitted/);
  assert.match(english, /2 delivery attempt\(s\) omitted/);
  assert.match(english, /Recent sample: up to 10 alerts and up to 5 delivery attempts/);
  assert.match(english, /In-sample pending/);
});

test("telegram alerts detail preserves canonical output and performs each bounded read once", async () => {
  const notifications = [
    createNotification({
      id: "notification-detail",
      createdAt: "2026-04-20T00:00:00.000Z",
    }),
  ];
  const attempts = [createDeliveryAttempt("SENT", 0)];
  const runs = [createDeliveryRun("COMPLETED", 0)];
  const reads: string[] = [];
  const repository = new InMemoryExecutionRepository();
  repository.listOperatorNotifications = async (exchangeAccountId, limit) => {
    reads.push(`notifications:${exchangeAccountId}:${limit}`);
    return notifications;
  };
  repository.listOperatorNotificationDeliveryAttempts = async (exchangeAccountId, limit) => {
    reads.push(`attempts:${exchangeAccountId}:${limit}`);
    return attempts;
  };
  repository.listOperatorNotificationDeliveryRuns = async (exchangeAccountId, limit) => {
    reads.push(`runs:${exchangeAccountId}:${limit}`);
    return runs;
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
    now: () => "2026-04-20T00:10:00.000Z",
  });

  const response = await router.route("/alerts DETAIL");

  assert.equal(
    response.text,
    formatOperatorNotificationsMessage(notifications, attempts, runs, {
      now: "2026-04-20T00:10:00.000Z",
    }),
  );
  assert.deepEqual(reads, [
    "notifications:primary:10",
    "attempts:primary:5",
    "runs:primary:5",
  ]);
  assert.equal(
    (await router.route("/alerts now")).text,
    "Usage: /alerts [detail]\nShow a concise persisted alert and delivery-health summary or the canonical technical list.",
  );
});

test("telegram alerts summary keeps delivery health in Korean and English empty states", () => {
  const korean = formatOperatorNotificationsSummaryMessage([], [], [], "ko-KR", {
    now: "2026-04-20T00:10:00.000Z",
  });
  const english = formatOperatorNotificationsSummaryMessage([], [], [], "en-US", {
    now: "2026-04-20T00:10:00.000Z",
  });

  assert.match(korean, /알림 전송 상태/);
  assert.match(korean, /저장된 최근 운영 알림이 없습니다/);
  assert.match(english, /Alert delivery health/);
  assert.match(english, /No recent persisted operator alerts/);
});

test("telegram router presents persisted risk history in Korean without claiming current blockers", async () => {
  const repository = new InMemoryExecutionRepository();
  const events: RiskEventRecord[] = [
    {
      id: "risk-event-invalid",
      exchangeAccountId: "primary",
      strategyDecisionId: null,
      orderId: null,
      level: "INFO",
      ruleCode: "LIVE_EXECUTION_DISABLED",
      message: "Invalid time evidence.",
      payloadJson: "{}",
      createdAt: "not-a-timestamp",
    },
    {
      id: "risk-event-offset",
      exchangeAccountId: "primary",
      strategyDecisionId: "decision-2",
      orderId: "order-2",
      level: "WARN",
      ruleCode: "STALE_PRICE_GUARD",
      message: "Market price is stale.",
      payloadJson: "{}",
      createdAt: "2026-04-20T09:30:00+09:00",
    },
    {
      id: "risk-event-latest",
      exchangeAccountId: "primary",
      strategyDecisionId: null,
      orderId: null,
      level: "BLOCK",
      ruleCode: "DUPLICATE_ORDER_GUARD",
      message: "A matching active order already exists.",
      payloadJson: JSON.stringify({ idempotencyKey: "duplicate-key" }),
      createdAt: "2026-04-20T00:31:00.000Z",
    },
  ];
  for (const event of events) {
    await repository.saveRiskEvent(event);
  }

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

  assert.match(risks.text, /최근 리스크 이력/);
  assert.match(risks.text, /저장된 최근 이력이며 현재 활성 차단 상태가 아닙니다/);
  assert.match(risks.text, /조회 건수: 3건/);
  assert.match(risks.text, /정보 1.*주의 1.*차단 1/);
  assert.ok(risks.text.indexOf("2026-04-20 09:31:00 KST") < risks.text.indexOf("2026-04-20 09:30:00 KST"));
  assert.ok(risks.text.indexOf("2026-04-20 09:30:00 KST") < risks.text.indexOf("데이터 오류"));
  assert.match(risks.text, /중복 주문 차단/);
  assert.match(risks.text, /동일한 활성 주문/);
  assert.match(risks.text, /원문: A matching active order already exists\./);
  assert.match(risks.text, /주문 확인: \/order order-2/);
  assert.match(risks.text, /전략 결정 ID: decision-2/);
  assert.match(risks.text, /전체 기술 이력: \/risks detail/);
});

test("telegram risk summary maps every rule code exhaustively in English", async () => {
  const repository = new InMemoryExecutionRepository();
  const events: RiskEventRecord[] = [];
  const expectedTitles: Readonly<Record<RiskRuleCode, string>> = {
    GLOBAL_KILL_SWITCH: "Global kill switch",
    EXECUTION_PAUSED: "Execution paused",
    SYSTEM_DEGRADED: "System degraded",
    PER_ASSET_MAX_ALLOCATION: "Per-asset allocation limit",
    TOTAL_EXPOSURE_CAP: "Total exposure cap",
    STALE_PRICE_GUARD: "Stale price guard",
    DUPLICATE_ORDER_GUARD: "Duplicate order guard",
    MINIMUM_ORDER_VALUE_GUARD: "Minimum order value",
    LIVE_EXECUTION_DISABLED: "Live execution disabled",
    UNSUPPORTED_MARKET: "Unsupported market",
    UNSUPPORTED_ORDER_TYPE: "Unsupported order type",
    EXCHANGE_MIN_TOTAL_GUARD: "Exchange minimum order value",
    EXCHANGE_MAX_TOTAL_GUARD: "Exchange maximum order value",
    MARKET_OFFLINE: "Market offline",
    EXCHANGE_ORDER_CHANCE_FAILED: "Order availability check failed",
    EXCHANGE_ORDER_TEST_FAILED: "Exchange order test failed",
    ORDER_RECOVERY_REQUIRED: "Order recovery required",
    BALANCE_DRIFT_DETECTED: "Balance drift detected",
    POSITION_DRIFT_DETECTED: "Position drift detected",
    POSITION_GUARD_PILOT_UNCERTAIN_ORDER: "Uncertain order submission",
    ACCOUNT_EXECUTION_LEASE_BLOCKED: "Account execution lease blocked",
  };

  let offset = 0;
  for (const ruleCode of Object.keys(expectedTitles) as RiskRuleCode[]) {
    const event: RiskEventRecord = {
      id: `risk-${offset}`,
      exchangeAccountId: "primary",
      strategyDecisionId: null,
      orderId: null,
      level: "INFO",
      ruleCode,
      message: `persisted message ${ruleCode}`,
      payloadJson: "{}",
      createdAt: new Date(Date.UTC(2026, 3, 20, 0, 0, offset)).toISOString(),
    };
    events.push(event);
    await repository.saveRiskEvent(event);
    offset += 1;
  }

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
    locale: "en-US",
  });

  const response = await router.route("/risks");
  const exhaustivePresentation = formatRiskEventsSummaryMessage(events, "en-US");

  assert.match(response.text, /Recent risk history/);
  assert.match(response.text, /persisted recent history, not the current active blocker state/);
  for (const title of Object.values(expectedTitles)) {
    assert.match(exhaustivePresentation, new RegExp(escapeRegExp(title)));
  }
  assert.match(response.text, /Original: persisted message POSITION_DRIFT_DETECTED/);
  assert.match(response.text, /Full technical history: \/risks detail/);
});

test("telegram risk summary explains stale-price evidence and degraded safety state precisely", () => {
  const events: RiskEventRecord[] = [
    {
      id: "risk-stale-price",
      exchangeAccountId: "primary",
      strategyDecisionId: null,
      orderId: null,
      level: "BLOCK",
      ruleCode: "STALE_PRICE_GUARD",
      message: "Market reference is missing or stale.",
      payloadJson: "{}",
      createdAt: "2026-04-20T00:01:00.000Z",
    },
    {
      id: "risk-degraded",
      exchangeAccountId: "primary",
      strategyDecisionId: null,
      orderId: null,
      level: "BLOCK",
      ruleCode: "SYSTEM_DEGRADED",
      message: "System recovery is required.",
      payloadJson: "{}",
      createdAt: "2026-04-20T00:02:00.000Z",
    },
  ];

  const korean = formatRiskEventsSummaryMessage(events, "ko-KR");
  const english = formatRiskEventsSummaryMessage(events, "en-US");

  assert.match(korean, /시스템 복구 필요/);
  assert.match(
    korean,
    /가격 스냅샷이 없거나 주문 판단에 사용된 가격이 허용 시간을 초과했습니다\./,
  );
  assert.match(
    english,
    /The price snapshot was missing or the price used for the order decision exceeded the allowed age\./,
  );
});

test("telegram risks detail preserves canonical output and uses one bounded read", async () => {
  const repository = new InMemoryExecutionRepository();
  const event: RiskEventRecord = {
    id: "risk-detail",
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-detail",
    orderId: "order-detail",
    level: "BLOCK",
    ruleCode: "ORDER_RECOVERY_REQUIRED",
    message: "Order state requires recovery.",
    payloadJson: "{}",
    createdAt: "2026-04-20T00:10:00.000Z",
  };
  await repository.saveRiskEvent(event);
  const originalListRiskEvents = repository.listRiskEvents.bind(repository);
  const reads: Array<[string, number | undefined]> = [];
  repository.listRiskEvents = async (exchangeAccountId, limit) => {
    reads.push([exchangeAccountId, limit]);
    return originalListRiskEvents(exchangeAccountId, limit);
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

  const response = await router.route("/risks DETAIL");

  assert.equal(response.text, formatRiskEventsMessage([event]));
  assert.deepEqual(reads, [["primary", 10]]);
  assert.equal(
    (await router.route("/risks now")).text,
    "Usage: /risks [detail]\nShow a concise persisted risk-history summary or the canonical technical list.",
  );
});

test("telegram risks summary has explicit Korean and English empty states", async () => {
  const korean = createRouter();
  const english = new TelegramCommandRouter({
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
    locale: "en-US",
  });

  assert.match((await korean.route("/risks")).text, /저장된 최근 리스크 기록이 없습니다/);
  assert.match((await english.route("/risks")).text, /No persisted recent risk records/);
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

test("telegram control result renders Korean pause guidance, canonical evidence, and KST time", async () => {
  const previous = createControlState({
    systemStatus: "RUNNING",
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
  const next = createControlState({
    systemStatus: "PAUSED",
    pauseReason: "정기 점검",
    updatedAt: "2026-04-20T01:02:03.000Z",
  });
  const fixture = createControlRouterFixture(previous, {
    pause: next,
  });

  const response = await fixture.router.route("/pause 정기 점검");

  assert.match(response.text, /실행 제어 결과/);
  assert.match(response.text, /command: \/pause/);
  assert.match(response.text, /result: accepted/);
  assert.match(response.text, /신규 실행이 일시정지되었습니다/);
  assert.match(response.text, /\/status/);
  assert.match(response.text, /준비된 경우에만 \/resume/);
  assert.match(response.text, /transition: RUNNING -> PAUSED/);
  assert.match(response.text, /execution_mode: DRY_RUN/);
  assert.match(response.text, /live_gate: DISABLED/);
  assert.match(response.text, /live_orders_allowed: false/);
  assert.match(response.text, /blocked_by: DRY_RUN,LIVE_GATE_DISABLED,PAUSED,DRY_RUN_ADAPTER/);
  assert.match(response.text, /kill_switch: off/);
  assert.match(response.text, /reason: 정기 점검/);
  assert.match(response.text, /2026-04-20 10:02:03 KST/);
  assert.deepEqual(fixture.calls, {
    getState: 1,
    pause: 1,
    resume: 0,
    activateKillSwitch: 0,
  });
});

test("telegram control result warns when Korean resume restores real-order-capable operation", async () => {
  const previous = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "PAUSED",
    pauseReason: "operator_check",
  });
  const next = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    updatedAt: "2026-04-20T02:00:00.000Z",
  });
  const fixture = createControlRouterFixture(previous, {
    resume: next,
  }, {
    liveSendPath: "LIVE_ADAPTER",
  });

  const response = await fixture.router.route("/resume");

  assert.match(response.text, /실주문 가능 상태로 다시 진입할 수 있습니다/);
  assert.match(response.text, /\/readiness/);
  assert.match(response.text, /transition: PAUSED -> RUNNING/);
  assert.match(response.text, /execution_mode: LIVE/);
  assert.match(response.text, /live_gate: ENABLED/);
  assert.match(response.text, /live_orders_allowed: true/);
  assert.match(response.text, /blocked_by: none/);
  assert.doesNotMatch(response.text, /실행은 계속 차단되어 있습니다/);
  assert.deepEqual(fixture.calls, {
    getState: 1,
    pause: 0,
    resume: 1,
    activateKillSwitch: 0,
  });
});

test("telegram control result explains Korean resume blockers with canonical codes", async () => {
  const previous = createControlState({
    systemStatus: "PAUSED",
    pauseReason: "operator_check",
  });
  const next = createControlState({
    systemStatus: "RUNNING",
    updatedAt: "2026-04-20T03:00:00.000Z",
  });
  const fixture = createControlRouterFixture(previous, {
    resume: next,
  });

  const response = await fixture.router.route("/resume");

  assert.match(response.text, /실행은 계속 차단되어 있습니다/);
  assert.match(response.text, /DRY_RUN,LIVE_GATE_DISABLED,DRY_RUN_ADAPTER/);
  assert.match(response.text, /blocked_by: DRY_RUN,LIVE_GATE_DISABLED,DRY_RUN_ADAPTER/);
  assert.doesNotMatch(response.text, /실주문 가능 상태로 다시 진입할 수 있습니다/);
});

test("telegram control result never claims resume cleared an active kill switch", async () => {
  const previous = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "KILL_SWITCHED",
    killSwitchActive: true,
    pauseReason: "emergency_stop",
  });
  const next = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "KILL_SWITCHED",
    killSwitchActive: true,
    pauseReason: null,
    updatedAt: "2026-04-20T04:00:00.000Z",
  });
  const fixture = createControlRouterFixture(previous, {
    resume: next,
  }, {
    liveSendPath: "LIVE_ADAPTER",
  });

  const response = await fixture.router.route("/resume");

  assert.match(response.text, /킬 스위치는 계속 활성 상태입니다/);
  assert.match(response.text, /\/resume 명령은 킬 스위치를 해제하지 않습니다/);
  assert.match(response.text, /transition: KILL_SWITCHED -> KILL_SWITCHED/);
  assert.match(response.text, /blocked_by: KILL_SWITCHED/);
  assert.match(response.text, /kill_switch: on/);
  assert.match(response.text, /pause_reason: none/);
  assert.match(response.text, /previous_kill_switch_reason: emergency_stop/);
  assert.doesNotMatch(response.text, /pause_reason: emergency_stop/);
  assert.doesNotMatch(response.text, /운영이 재개되었습니다/);
});

test("telegram control result preserves metacharacters in the exact plain-text reason", async () => {
  const reason = 'ops <halt> & "review"';
  const fixture = createControlRouterFixture(
    createControlState({
      systemStatus: "RUNNING",
    }),
    {
      pause: createControlState({
        systemStatus: "PAUSED",
        pauseReason: reason,
        updatedAt: "2026-04-20T04:30:00.000Z",
      }),
    },
  );

  const response = await fixture.router.route(`/pause ${reason}`);

  assert.match(response.text, /pause_reason: ops <halt> & "review"/);
  assert.doesNotMatch(response.text, /&lt;|&amp;|&quot;/);
});

test("telegram pause during an active kill switch stays truthful in Korean and never recommends resume", async () => {
  const previous = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "KILL_SWITCHED",
    killSwitchActive: true,
    pauseReason: "emergency_stop",
  });
  const next = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "KILL_SWITCHED",
    killSwitchActive: true,
    pauseReason: "secondary_pause",
    updatedAt: "2026-04-20T04:40:00.000Z",
  });
  const fixture = createControlRouterFixture(previous, {
    pause: next,
  }, {
    liveSendPath: "LIVE_ADAPTER",
  });

  const response = await fixture.router.route("/pause secondary_pause");

  assert.match(response.text, /킬 스위치 활성 상태가 유지되며 실행은 계속 차단됩니다/);
  assert.match(response.text, /\/pause 명령은 킬 스위치 상태를 변경하지 않습니다/);
  assert.match(response.text, /transition: KILL_SWITCHED -> KILL_SWITCHED/);
  assert.match(response.text, /pause_reason: secondary_pause/);
  assert.doesNotMatch(response.text, /일시정지 상태가 유지됩니다/);
  assert.doesNotMatch(response.text, /\/resume/);
});

test("telegram pause during an active kill switch has equivalent truthful English output", async () => {
  const previous = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "KILL_SWITCHED",
    killSwitchActive: true,
    pauseReason: "emergency_stop",
  });
  const next = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "KILL_SWITCHED",
    killSwitchActive: true,
    pauseReason: "secondary_pause",
  });
  const fixture = createControlRouterFixture(previous, {
    pause: next,
  }, {
    locale: "en-US",
    liveSendPath: "LIVE_ADAPTER",
  });

  const response = await fixture.router.route("/pause secondary_pause");

  assert.match(response.text, /The kill switch remains active and execution remains blocked/);
  assert.match(response.text, /\/pause does not change the kill-switch state/);
  assert.doesNotMatch(response.text, /The system remains paused/);
  assert.doesNotMatch(response.text, /\/resume/);
});

test("telegram repeated resume describes RUNNING to RUNNING truthfully in Korean", async () => {
  const running = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
  });
  const fixture = createControlRouterFixture(running, {
    resume: createControlState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      systemStatus: "RUNNING",
      updatedAt: "2026-04-20T04:50:00.000Z",
    }),
  }, {
    liveSendPath: "LIVE_ADAPTER",
  });

  const response = await fixture.router.route("/resume");

  assert.match(response.text, /이미 실행 중이며 RUNNING 상태가 유지됩니다/);
  assert.match(response.text, /\/readiness/);
  assert.match(response.text, /transition: RUNNING -> RUNNING/);
  assert.doesNotMatch(response.text, /일시정지가 해제되었습니다/);
});

test("telegram repeated resume has equivalent truthful English output", async () => {
  const running = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
  });
  const fixture = createControlRouterFixture(running, {
    resume: createControlState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      systemStatus: "RUNNING",
    }),
  }, {
    locale: "en-US",
    liveSendPath: "LIVE_ADAPTER",
  });

  const response = await fixture.router.route("/resume");

  assert.match(response.text, /The system was already running and remains RUNNING/);
  assert.match(response.text, /\/readiness/);
  assert.doesNotMatch(response.text, /The pause was released/);
});

test("telegram control results describe kill switch and repeated transitions truthfully", async () => {
  const paused = createControlState({
    systemStatus: "PAUSED",
    pauseReason: "existing_pause",
  });
  const repeatedPause = createControlRouterFixture(paused, {
    pause: createControlState({
      systemStatus: "PAUSED",
      pauseReason: "existing_pause",
      updatedAt: "2026-04-20T05:00:00.000Z",
    }),
  });
  const pauseResponse = await repeatedPause.router.route("/pause existing_pause");
  assert.match(pauseResponse.text, /일시정지 상태가 유지됩니다/);
  assert.doesNotMatch(pauseResponse.text, /일시정지 상태로 전환되었습니다/);

  const killed = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "KILL_SWITCHED",
    killSwitchActive: true,
    pauseReason: "emergency_stop",
  });
  const repeatedKill = createControlRouterFixture(killed, {
    activateKillSwitch: createControlState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      systemStatus: "KILL_SWITCHED",
      killSwitchActive: true,
      pauseReason: "emergency_stop",
      updatedAt: "2026-04-20T06:00:00.000Z",
    }),
  }, {
    liveSendPath: "LIVE_ADAPTER",
  });
  const killResponse = await repeatedKill.router.route("/killswitch emergency_stop");
  assert.match(killResponse.text, /글로벌 킬 스위치는 활성 상태이며 실행은 계속 차단됩니다/);
  assert.match(killResponse.text, /킬 스위치 활성 상태가 유지됩니다/);
  assert.doesNotMatch(killResponse.text, /\/resume.*해제/);
  assert.deepEqual(repeatedKill.calls, {
    getState: 1,
    pause: 0,
    resume: 0,
    activateKillSwitch: 1,
  });
});

test("telegram control result renders equivalent English information", async () => {
  const previous = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
  });
  const next = createControlState({
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "KILL_SWITCHED",
    killSwitchActive: true,
    pauseReason: "operator_stop",
    updatedAt: "2026-04-20T07:08:09.000Z",
  });
  const fixture = createControlRouterFixture(previous, {
    activateKillSwitch: next,
  }, {
    locale: "en-US",
    liveSendPath: "LIVE_ADAPTER",
  });

  const response = await fixture.router.route("/killswitch operator_stop");

  assert.match(response.text, /Execution control result/);
  assert.match(response.text, /command: \/killswitch/);
  assert.match(response.text, /result: accepted/);
  assert.match(response.text, /global kill switch is active and execution remains blocked/i);
  assert.match(response.text, /Review \/status/);
  assert.match(response.text, /transition: RUNNING -> KILL_SWITCHED/);
  assert.match(response.text, /execution_mode: LIVE/);
  assert.match(response.text, /live_gate: ENABLED/);
  assert.match(response.text, /live_orders_allowed: false/);
  assert.match(response.text, /blocked_by: KILL_SWITCHED/);
  assert.match(response.text, /kill_switch: on/);
  assert.match(response.text, /reason: operator_stop/);
  assert.match(response.text, /2026-04-20 16:08:09 KST/);
});

test("invalid control arguments preserve usage responses without state reads or transitions", async () => {
  const state = createControlState({});
  const fixture = createControlRouterFixture(state, {});

  assert.equal(
    (await fixture.router.route("/resume now")).text,
    "Usage: /resume\nResume execution when the kill switch is clear.",
  );
  assert.deepEqual(fixture.calls, {
    getState: 0,
    pause: 0,
    resume: 0,
    activateKillSwitch: 0,
  });
});

test("telegram router exposes strategy run trigger without manual portfolio input", async () => {
  const router = createRouter();

  const missingController = await router.route("/run BTC");
  const missingPreviewController = await router.route("/preview BTC");
  const invalidAsset = await router.route("/run DOGE");
  const invalidPreviewAsset = await router.route("/preview DOGE");

  assert.match(missingController.text, /Strategy Run/);
  assert.match(missingController.text, /status: NOT_CONNECTED/);
  assert.match(missingController.text, /market: KRW-BTC/);
  assert.match(missingController.text, /PositionGuard strategy runner is not wired/);
  assert.match(missingController.text, /operator_boundary: Telegram does not accept manual cash or position input\./);
  assert.match(missingPreviewController.text, /Strategy Preview/);
  assert.match(missingPreviewController.text, /status: NOT_CONNECTED/);
  assert.match(missingPreviewController.text, /market: KRW-BTC/);
  assert.match(missingPreviewController.text, /No preview was computed/);
  assert.match(missingPreviewController.text, /no_mutation_boundary: \/preview never persists strategy decisions, creates orders, sends orders, or triggers reconciliation\./);
  assert.equal(
    invalidAsset.text,
    "Usage: /run BTC|ETH\nRun one deterministic PositionGuard strategy cycle for a supported asset through the safe execution path.",
  );
  assert.equal(
    invalidPreviewAsset.text,
    "Usage: /preview BTC|ETH\nPreview one deterministic PositionGuard strategy decision and order intent without persistence or order submission.",
  );
});

test("telegram router calls a wired strategy run controller for supported assets", async () => {
  const runRequests: string[] = [];
  const previewRequests: string[] = [];
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
      async requestPreview(request) {
        previewRequests.push(`${request.exchangeAccountId}:${request.market}:${request.requestedCommand}`);
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T00:14:00.000Z",
          market: request.market,
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
        };
      },
    },
  });

  const preview = await router.route("/preview BTC");
  const response = await router.route("/run ETH");

  assert.deepEqual(previewRequests, ["primary:KRW-BTC:/preview"]);
  assert.deepEqual(runRequests, ["primary:KRW-ETH:/run"]);
  assert.match(preview.text, /Strategy Preview/);
  assert.match(preview.text, /status: COMPLETED/);
  assert.match(preview.text, /market: KRW-BTC/);
  assert.match(preview.text, /action: ENTER/);
  assert.match(preview.text, /order_side: bid/);
  assert.match(preview.text, /order_type: price/);
  assert.match(preview.text, /order_price: 150000/);
  assert.match(response.text, /status: COMPLETED/);
  assert.match(response.text, /market: KRW-ETH/);
  assert.match(response.text, /strategy_decision_id: strategy-decision-1/);
  assert.match(response.text, /action: HOLD/);
  assert.match(response.text, /submission_accepted: none/);
});

function createBtcPilotDecision(input: {
  id: string;
  phase: "ACTIVE" | "DRAINING";
  stateVersion: number;
  reasonCode: "CANDIDATE_ALLOWED" | "DRAINING_RISK_REDUCTION_PRESERVED";
}): StrategyDecisionRecord {
  return {
    id: input.id,
    exchangeAccountId: "primary",
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: input.phase === "ACTIVE" ? "ADD" : "REDUCE",
    status: "READY",
    decisionBasisJson: JSON.stringify({
      policyRoute: {
        schemaVersion: "POSITION_GUARD_POLICY_ROUTE_AUDIT_V1",
        configuredSelection: {
          kind: "BTC_CANDIDATE_PILOT",
          pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
          market: "KRW-BTC",
          policyId: "COMBINED_CONSERVATIVE",
          policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
          liveOperatorConfirmed: true,
        },
        resolvedSelection: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
        executionBlocked: input.phase !== "ACTIVE",
        deploymentId: "deployment-pilot-1",
        pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
        policyId: "COMBINED_CONSERVATIVE",
        policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
        phase: input.phase,
        activationAt: "2026-08-21T03:00:00.000Z",
        stateVersion: input.stateVersion,
        reasonCode: input.reasonCode,
        refreshProvenance: {
          exchangeAccountId: "primary",
          requestedAt: "2026-08-21T03:29:00.000Z",
          balanceSnapshotId: "balance-pilot-1",
          balanceCapturedAt: "2026-08-21T03:29:00.000Z",
          positionSnapshotId: "position-pilot-1",
          positionCapturedAt: "2026-08-21T03:29:00.000Z",
          reconciliationRunId: "reconciliation-pilot-1",
          reconciliationStartedAt: "2026-08-21T03:29:00.100Z",
          reconciliationCompletedAt: "2026-08-21T03:29:00.200Z",
          reconciliationSource: "SCHEDULER_PREFLIGHT",
        },
      },
    }),
    intendedNotionalKrw: input.phase === "ACTIVE" ? "5000" : null,
    intendedQuantity: input.phase === "DRAINING" ? "0.00001" : null,
    referencePrice: "100000000",
    createdAt: "2026-08-21T03:30:00.000Z",
  };
}

function createCandidatePilotReader(input: {
  phase: "ACTIVE" | "DRAINING";
  stateVersion: number;
}) {
  return {
    async getDeploymentForExchangeAccount() {
      return {
        id: "deployment-pilot-1",
        exchangeAccountId: "primary",
        pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1" as const,
        market: "KRW-BTC" as const,
        policyId: "COMBINED_CONSERVATIVE" as const,
        policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1" as const,
        phase: input.phase,
        activationAt: "2026-08-21T03:00:00.000Z",
        activationEpochNs: BigInt(Date.parse("2026-08-21T03:00:00.000Z")) * 1_000_000n,
        createdAt: "2026-08-21T02:00:00.000Z",
        updatedAt: "2026-08-21T03:30:00.000Z",
      };
    },
    async getExactState() {
      return {
        currentEpisodeAddCount: 1,
        currentEpisodeCostBasisKrw: "5000",
        currentEpisodeInventoryQuantity: "0.00005",
        currentEpisodeRealizedPnlKrw: "0",
        lastFullExitAt: null,
        lastFullExitRealizedPnlKrw: null,
        lastEntryPath: "PULLBACK" as const,
        lastEvidenceAt: "2026-08-21T03:20:00.000Z",
        lastEvidenceId: "evidence-pilot-1",
        stateVersion: input.stateVersion,
      };
    },
  };
}

test("telegram router exposes persisted BTC pilot audit on status, readiness, run, and preview", async () => {
  const repository = new InMemoryExecutionRepository();
  const decisionBasisJson = JSON.stringify({
    policyRoute: {
      schemaVersion: "POSITION_GUARD_POLICY_ROUTE_AUDIT_V1",
      configuredSelection: {
        kind: "BTC_CANDIDATE_PILOT",
        pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
        market: "KRW-BTC",
        policyId: "COMBINED_CONSERVATIVE",
        policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
        liveOperatorConfirmed: true,
      },
      resolvedSelection: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      executionBlocked: false,
      deploymentId: "deployment-pilot-1",
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      phase: "ACTIVE",
      activationAt: "2026-08-21T03:00:00.000Z",
      stateVersion: 4,
      reasonCode: "CANDIDATE_ALLOWED",
      refreshProvenance: {
        exchangeAccountId: "primary",
        requestedAt: "2026-08-21T03:29:00.000Z",
        balanceSnapshotId: "balance-pilot-1",
        balanceCapturedAt: "2026-08-21T03:29:00.000Z",
        positionSnapshotId: "position-pilot-1",
        positionCapturedAt: "2026-08-21T03:29:00.000Z",
        reconciliationRunId: "reconciliation-pilot-1",
        reconciliationStartedAt: "2026-08-21T03:29:00.100Z",
        reconciliationCompletedAt: "2026-08-21T03:29:00.200Z",
        reconciliationSource: "SCHEDULER_PREFLIGHT",
      },
    },
    localConfirmation: "I_UNDERSTAND_BTC_CANDIDATE_LIVE_PILOT",
    ownerToken: "owner-token-must-not-render",
  });
  await repository.saveStrategyDecision({
    id: "strategy-decision-pilot-1",
    exchangeAccountId: "primary",
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "ADD",
    status: "READY",
    decisionBasisJson,
    intendedNotionalKrw: "5000",
    intendedQuantity: null,
    referencePrice: "100000000",
    createdAt: "2026-08-21T03:30:00.000Z",
  });
  const dependencies = {
    repositories: repository,
    candidatePilotReader: {
      async getDeploymentForExchangeAccount() {
        return {
          id: "deployment-pilot-1",
          exchangeAccountId: "primary",
          pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1" as const,
          market: "KRW-BTC" as const,
          policyId: "COMBINED_CONSERVATIVE" as const,
          policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1" as const,
          phase: "ACTIVE" as const,
          activationAt: "2026-08-21T03:00:00.000Z",
          activationEpochNs: BigInt(Date.parse("2026-08-21T03:00:00.000Z")) * 1_000_000n,
          createdAt: "2026-08-21T02:00:00.000Z",
          updatedAt: "2026-08-21T03:30:00.000Z",
        };
      },
      async getExactState() {
        return {
          currentEpisodeAddCount: 1,
          currentEpisodeCostBasisKrw: "5000",
          currentEpisodeInventoryQuantity: "0.00005",
          currentEpisodeRealizedPnlKrw: "0",
          lastFullExitAt: null,
          lastFullExitRealizedPnlKrw: null,
          lastEntryPath: "PULLBACK" as const,
          lastEvidenceAt: "2026-08-21T03:20:00.000Z",
          lastEvidenceId: "evidence-pilot-1",
          stateVersion: 4,
        };
      },
    },
    operatorState: new InMemoryOperatorStateStore({
      id: "state-pilot-visibility",
      exchangeAccountId: "primary",
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      systemStatus: "RUNNING",
      killSwitchActive: false,
      pauseReason: null,
      degradedReason: null,
      degradedAt: null,
      updatedAt: "2026-08-21T03:31:00.000Z",
    }),
    liveSendPath: "LIVE_ADAPTER",
    strategyRunController: {
      async requestRun(request: { market: "KRW-BTC" | "KRW-ETH" }) {
        return {
          status: "COMPLETED",
          requestedAt: "2026-08-21T03:31:00.000Z",
          market: request.market,
          strategyDecisionId: "strategy-decision-pilot-1",
          action: "ADD",
          orderId: null,
          orderStatus: null,
          submissionAccepted: null,
          detail: "Candidate decision persisted.",
        };
      },
      async requestPreview(request: { market: "KRW-BTC" | "KRW-ETH" }) {
        return {
          status: "COMPLETED",
          requestedAt: "2026-08-21T03:31:00.000Z",
          market: request.market,
          action: "ADD",
          executionDisposition: "IMMEDIATE",
          referencePrice: 100_000_000,
          requestedNotionalKrw: 5_000,
          requestedQuantity: null,
          orderSide: "bid",
          orderType: "price",
          orderPrice: "5000",
          orderVolume: null,
          detail: "Candidate preview computed.",
        };
      },
    },
    now: () => "2026-08-21T03:31:00.000Z",
  };
  const router = new TelegramCommandRouter(dependencies as unknown as ConstructorParameters<typeof TelegramCommandRouter>[0]);

  const responses = await Promise.all([
    router.route("/status"),
    router.route("/status detail"),
    router.route("/readiness"),
    router.route("/readiness detail"),
    router.route("/run BTC"),
    router.route("/preview BTC"),
  ]);

  for (const response of responses) {
    assert.match(response.text, /BTC_COMBINED_CONSERVATIVE_PILOT_V1/u);
    assert.match(response.text, /PCS-2026-001\.DEPLOYMENT_READINESS_V1/u);
    assert.match(response.text, /ACTIVE/u);
    assert.match(response.text, /BASELINE/u);
    assert.doesNotMatch(response.text, /I_UNDERSTAND_BTC_CANDIDATE_LIVE_PILOT/u);
    assert.doesNotMatch(response.text, /owner-token-must-not-render/u);
  }
  assert.match(responses[0]!.text, /최근 BTC 후보 결과: 추가 매수 · CANDIDATE_ALLOWED/u);
  assert.match(responses[1]!.text, /btc_pilot_latest_reason_code: CANDIDATE_ALLOWED/u);
  assert.match(responses[3]!.text, /btc_pilot_replay_check: VERIFIED_BY_ROUTE/u);
  assert.match(responses[3]!.text, /btc_pilot_lease_check: UNAVAILABLE/u);
});

test("status and readiness use current persisted BTC pilot authority instead of a stale decision phase", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveStrategyDecision(createBtcPilotDecision({
    id: "decision-stale-active",
    phase: "ACTIVE",
    stateVersion: 4,
    reasonCode: "CANDIDATE_ALLOWED",
  }));
  const candidatePilotReader = createCandidatePilotReader({ phase: "DRAINING", stateVersion: 5 });
  let deploymentReadCount = 0;
  let stateReadCount = 0;
  const dependencies = {
    repositories: repository,
    candidatePilotReader: {
      async getDeploymentForExchangeAccount(exchangeAccountId: string) {
        deploymentReadCount += 1;
        void exchangeAccountId;
        return candidatePilotReader.getDeploymentForExchangeAccount();
      },
      async getExactState(deploymentId: string) {
        stateReadCount += 1;
        void deploymentId;
        return candidatePilotReader.getExactState();
      },
    },
    operatorState: new InMemoryOperatorStateStore(createControlState({
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
    })),
    liveSendPath: "LIVE_ADAPTER" as const,
    locale: "en-US" as const,
  };
  const router = new TelegramCommandRouter(dependencies as unknown as ConstructorParameters<typeof TelegramCommandRouter>[0]);

  const status = await router.route("/status detail");
  const readiness = await router.route("/readiness detail");

  assert.match(status.text, /btc_pilot_phase: DRAINING/u);
  assert.match(status.text, /btc_pilot_state_version: 5/u);
  assert.doesNotMatch(status.text, /btc_pilot_phase: ACTIVE/u);
  assert.match(readiness.text, /btc_pilot_phase: DRAINING/u);
  assert.match(readiness.text, /btc_pilot_current_authority_check: VERIFIED_CURRENT/u);
  assert.match(readiness.text, /btc_pilot_replay_check: UNAVAILABLE/u);
  assert.equal(deploymentReadCount, 2);
  assert.equal(stateReadCount, 2);
});

test("status blocks BTC pilot visibility when current persisted authority is unavailable or malformed", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveStrategyDecision(createBtcPilotDecision({
    id: "decision-cannot-authorize-current",
    phase: "ACTIVE",
    stateVersion: 4,
    reasonCode: "CANDIDATE_ALLOWED",
  }));
  const dependencies = {
    repositories: repository,
    candidatePilotReader: {
      async getDeploymentForExchangeAccount() {
        return { phase: "ACTIVE" };
      },
      async getExactState() {
        throw new Error("must not read state after malformed deployment");
      },
    },
    operatorState: new InMemoryOperatorStateStore(createControlState({})),
  };
  const router = new TelegramCommandRouter(dependencies as unknown as ConstructorParameters<typeof TelegramCommandRouter>[0]);

  const response = await router.route("/status detail");

  assert.match(response.text, /btc_pilot_phase: unavailable/u);
  assert.match(response.text, /btc_pilot_current_authority_check: BLOCKED_UNAVAILABLE/u);
  assert.doesNotMatch(response.text, /btc_pilot_phase: ACTIVE/u);
});

test("truncated or incoherent BTC refresh provenance is never labeled verified", async () => {
  const scenarios = [
    {
      name: "truncated",
      mutate(provenance: Record<string, unknown>) {
        delete provenance.positionSnapshotId;
      },
    },
    {
      name: "wrong-account",
      mutate(provenance: Record<string, unknown>) {
        provenance.exchangeAccountId = "different-account";
      },
    },
    {
      name: "non-canonical-id",
      mutate(provenance: Record<string, unknown>) {
        provenance.balanceSnapshotId = " balance-pilot-1 ";
      },
    },
    {
      name: "non-canonical-timezone",
      mutate(provenance: Record<string, unknown>) {
        provenance.balanceCapturedAt = "2026-08-21 03:29:00";
      },
    },
    {
      name: "reconciliation-time-reversal",
      mutate(provenance: Record<string, unknown>) {
        provenance.reconciliationStartedAt = "2026-08-21T03:29:00.300Z";
        provenance.reconciliationCompletedAt = "2026-08-21T03:29:00.200Z";
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const repository = new InMemoryExecutionRepository();
    const malformed = createBtcPilotDecision({
      id: `decision-${scenario.name}-provenance`,
      phase: "ACTIVE",
      stateVersion: 4,
      reasonCode: "CANDIDATE_ALLOWED",
    });
    const basis = JSON.parse(malformed.decisionBasisJson) as {
      policyRoute: { refreshProvenance: Record<string, unknown> };
    };
    scenario.mutate(basis.policyRoute.refreshProvenance);
    await repository.saveStrategyDecision({ ...malformed, decisionBasisJson: JSON.stringify(basis) });
    const dependencies = {
      repositories: repository,
      candidatePilotReader: createCandidatePilotReader({ phase: "ACTIVE", stateVersion: 4 }),
      operatorState: new InMemoryOperatorStateStore(createControlState({})),
    };
    const router = new TelegramCommandRouter(
      dependencies as unknown as ConstructorParameters<typeof TelegramCommandRouter>[0],
    );

    const response = await router.route("/readiness detail");

    assert.match(response.text, /btc_pilot_current_authority_check: VERIFIED_CURRENT/u, scenario.name);
    assert.match(response.text, /btc_pilot_replay_check: UNAVAILABLE/u, scenario.name);
    assert.match(response.text, /btc_pilot_lease_check: UNAVAILABLE/u, scenario.name);
    assert.match(response.text, /btc_pilot_reconciliation_check: UNAVAILABLE/u, scenario.name);
    assert.doesNotMatch(response.text, /VERIFIED_BY_ROUTE/u, scenario.name);
  }
});

test("run BTC never falls back to another strategy decision when exact lookup mismatches", async () => {
  const repository = new InMemoryExecutionRepository();
  const stale = createBtcPilotDecision({
    id: "decision-stale-latest",
    phase: "ACTIVE",
    stateVersion: 4,
    reasonCode: "CANDIDATE_ALLOWED",
  });
  await repository.saveStrategyDecision(stale);
  repository.getStrategyDecisionById = async () => stale;
  const dependencies = {
    repositories: repository,
    candidatePilotReader: createCandidatePilotReader({ phase: "ACTIVE", stateVersion: 4 }),
    operatorState: new InMemoryOperatorStateStore(createControlState({})),
    strategyRunController: {
      async requestRun() {
        return {
          status: "COMPLETED" as const,
          requestedAt: "2026-08-21T03:31:00.000Z",
          market: "KRW-BTC" as const,
          strategyDecisionId: "decision-exact-returned",
          action: "HOLD" as const,
          orderId: null,
          orderStatus: null,
          submissionAccepted: null,
          detail: "Exact decision lookup mismatch fixture.",
        };
      },
      async requestPreview() {
        throw new Error("preview must not run");
      },
    },
  };
  const router = new TelegramCommandRouter(dependencies as unknown as ConstructorParameters<typeof TelegramCommandRouter>[0]);

  const response = await router.route("/run BTC");

  assert.match(response.text, /decision-exact-returned/u);
  assert.doesNotMatch(response.text, /decision-stale-latest/u);
  assert.doesNotMatch(response.text, /CANDIDATE_ALLOWED/u);
});

test("run BTC omits decision audit when exact lookup is unavailable", async () => {
  const repository = new InMemoryExecutionRepository();
  const stale = createBtcPilotDecision({
    id: "decision-latest-must-not-be-used",
    phase: "ACTIVE",
    stateVersion: 4,
    reasonCode: "CANDIDATE_ALLOWED",
  });
  await repository.saveStrategyDecision(stale);
  Object.defineProperty(repository, "getStrategyDecisionById", {
    configurable: true,
    value: undefined,
  });
  const dependencies = {
    repositories: repository,
    candidatePilotReader: createCandidatePilotReader({ phase: "ACTIVE", stateVersion: 4 }),
    operatorState: new InMemoryOperatorStateStore(createControlState({})),
    strategyRunController: {
      async requestRun() {
        return {
          status: "COMPLETED" as const,
          requestedAt: "2026-08-21T03:31:00.000Z",
          market: "KRW-BTC" as const,
          strategyDecisionId: "decision-exact-unavailable",
          action: "HOLD" as const,
          orderId: null,
          orderStatus: null,
          submissionAccepted: null,
          detail: "Exact decision lookup unavailable fixture.",
        };
      },
      async requestPreview() {
        throw new Error("preview must not run");
      },
    },
  };
  const router = new TelegramCommandRouter(
    dependencies as unknown as ConstructorParameters<typeof TelegramCommandRouter>[0],
  );

  const response = await router.route("/run BTC");

  assert.match(response.text, /decision-exact-unavailable/u);
  assert.doesNotMatch(response.text, /decision-latest-must-not-be-used/u);
  assert.doesNotMatch(response.text, /CANDIDATE_ALLOWED/u);
});

test("router localizes run, calls BTC and ETH exactly once, and adds one bounded BTC audit read", async () => {
  const baseRepositories = new InMemoryExecutionRepository();
  const baseOperatorState = new InMemoryOperatorStateStore({
    id: "run-state",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
  let candidateAuditReads = 0;
  let operatorStateReads = 0;
  let runCalls = 0;
  const markets: string[] = [];
  baseRepositories.getStrategyDecisionById = async () => {
    candidateAuditReads += 1;
    return null;
  };
  const operatorState = new Proxy(baseOperatorState, {
    get(target, property, receiver) {
      operatorStateReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const router = new TelegramCommandRouter({
    repositories: baseRepositories,
    operatorState,
    locale: "ko-KR",
    strategyRunController: {
      async requestRun(request) {
        runCalls += 1;
        markets.push(request.market);
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T00:15:00.000Z",
          market: request.market,
          strategyDecisionId: `decision-${request.market}`,
          action: "HOLD",
          orderId: null,
          orderStatus: null,
          submissionAccepted: null,
          detail: "Decision HOLD persisted; no order submission was requested.",
        };
      },
      async requestPreview() {
        throw new Error("requestPreview must not be called by /run");
      },
    },
  });

  const btc = await router.route("/run BTC");
  const eth = await router.route("/run ETH");
  const invalidAsset = await router.route("/run DOGE");
  const extraArgs = await router.route("/run BTC now");

  assert.equal(runCalls, 2);
  assert.deepEqual(markets, ["KRW-BTC", "KRW-ETH"]);
  assert.equal(candidateAuditReads, 1);
  assert.equal(operatorStateReads, 0);
  assert.match(btc.text, /전략 실행 결과 \(Strategy Run\)/);
  assert.match(btc.text, /시장\/자산: KRW-BTC \/ BTC/);
  assert.match(eth.text, /시장\/자산: KRW-ETH \/ ETH/);
  assert.equal(
    invalidAsset.text,
    "Usage: /run BTC|ETH\nRun one deterministic PositionGuard strategy cycle for a supported asset through the safe execution path.",
  );
  assert.equal(
    extraArgs.text,
    "Usage: /run BTC|ETH\nRun one deterministic PositionGuard strategy cycle for a supported asset through the safe execution path.",
  );
});

test("router localizes ETH preview, invokes its controller once, and performs no candidate audit read", async () => {
  const baseRepositories = new InMemoryExecutionRepository();
  const baseOperatorState = new InMemoryOperatorStateStore({
    id: "preview-state",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
  let operatorStateReads = 0;
  let previewCalls = 0;
  baseRepositories.getLatestStrategyDecision = async () => {
    throw new Error("ETH preview must not read the BTC candidate audit");
  };
  const operatorState = new Proxy(baseOperatorState, {
    get(target, property, receiver) {
      operatorStateReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const router = new TelegramCommandRouter({
    repositories: baseRepositories,
    operatorState,
    locale: "ko-KR",
    strategyRunController: {
      async requestPreview(request) {
        previewCalls += 1;
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T00:11:00.000Z",
          market: request.market,
          action: "HOLD",
          executionDisposition: "SKIPPED",
          referencePrice: 5_000_000,
          requestedNotionalKrw: null,
          requestedQuantity: null,
          orderSide: null,
          orderType: null,
          orderPrice: null,
          orderVolume: null,
          detail: "No order intent.",
        };
      },
      async requestRun() {
        throw new Error("requestRun must not be called by /preview");
      },
    },
  });

  const response = await router.route("/preview ETH");

  assert.equal(previewCalls, 1);
  assert.equal(operatorStateReads, 0);
  assert.match(response.text, /전략 미리보기 \(Strategy Preview\)/);
  assert.match(response.text, /시장\/자산: KRW-ETH \/ ETH/);
  assert.match(response.text, /주문 의도: 없음/);
});

test("telegram read-only callbacks return typed HTML views for every approved action", async () => {
  const repository = new InMemoryExecutionRepository();
  for (let index = 0; index < 6; index += 1) {
    await repository.saveOrder(createOrder({
      id: `callback-order-${index}`,
      updatedAt: `2026-04-20T00:0${index}:00.000Z`,
    }));
  }
  for (let index = 0; index < 4; index += 1) {
    await repository.saveOperatorNotification(createNotification({
      id: `callback-alert-${index}`,
      title: `alert <${index}>`,
      message: `message & ${index}`,
      createdAt: `2026-04-20T00:0${index}:30.000Z`,
    }));
  }

  const mutationCalls: string[] = [];
  const operatorState = new Proxy(new InMemoryOperatorStateStore({
    id: "callback-state",
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
      if (
        typeof property === "string" &&
        [
          "pause",
          "resume",
          "activateKillSwitch",
          "setExecutionMode",
          "setLiveExecutionGate",
          "markDegraded",
          "clearDegraded",
        ].includes(property)
      ) {
        return () => {
          mutationCalls.push(property);
          throw new Error(`callback_must_not_mutate_operator_state:${property}`);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState,
    syncController: {
      async requestSync() {
        throw new Error("callbacks_must_not_sync");
      },
    },
    strategyRunController: {
      async requestRun() {
        throw new Error("callbacks_must_not_run");
      },
      async requestPreview() {
        throw new Error("callbacks_must_not_preview");
      },
    },
  });
  const callbackRouter = router as unknown as {
    routeReadOnlyCallback(action: unknown, exchangeAccountId?: string): Promise<{
      text: string;
      parseMode: "HTML";
      replyMarkup: { inlineKeyboard: readonly (readonly { callbackData: string }[])[] };
    }>;
  };
  const actions = [
    { type: "HOME" },
    { type: "STATUS" },
    { type: "STATUS_DETAIL" },
    { type: "STATUS_REFRESH" },
    { type: "READINESS" },
    { type: "READINESS_DETAIL" },
    { type: "READINESS_REFRESH" },
    { type: "BALANCES" },
    { type: "POSITIONS" },
    { type: "ORDERS_PAGE", page: 0 },
    { type: "ORDERS_DETAIL", orderId: 0 },
    { type: "ALERTS_PAGE", page: 0 },
    { type: "ALERTS_DETAIL", alertId: 0 },
    { type: "RISKS" },
    { type: "SCHEDULER" },
  ];

  for (const action of actions) {
    const response = await callbackRouter.routeReadOnlyCallback(action);
    assert.equal(response.parseMode, "HTML", action.type);
    assert.ok(response.replyMarkup.inlineKeyboard.length > 0, action.type);
  }
  assert.deepEqual(mutationCalls, []);
});

test("telegram read-only callback pages are bounded, escaped, and expire without detail reads", async () => {
  const repository = new InMemoryExecutionRepository();
  for (let index = 0; index < 6; index += 1) {
    await repository.saveOrder(createOrder({
      id: `page-order-${index}`,
      updatedAt: `2026-04-20T00:0${index}:00.000Z`,
    }));
  }
  for (let index = 0; index < 4; index += 1) {
    await repository.saveOperatorNotification(createNotification({
      id: `page-alert-${index}`,
      title: `alert <${index}>`,
      message: `message & ${index}`,
      createdAt: `2026-04-20T00:0${index}:30.000Z`,
    }));
  }
  let eventReads = 0;
  let fillReads = 0;
  repository.listOrderEvents = async () => {
    eventReads += 1;
    return [];
  };
  repository.listFills = async () => {
    fillReads += 1;
    return [];
  };
  const router = new TelegramCommandRouter({
    repositories: repository,
    operatorState: new InMemoryOperatorStateStore({
      id: "page-state",
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
  const callbackRouter = router as unknown as {
    routeReadOnlyCallback(action: unknown, exchangeAccountId?: string): Promise<{
      text: string;
      replyMarkup: { inlineKeyboard: readonly (readonly { callbackData: string }[])[] };
    }>;
  };

  const firstOrders = await callbackRouter.routeReadOnlyCallback({ type: "ORDERS_PAGE", page: 0 });
  const secondOrders = await callbackRouter.routeReadOnlyCallback({ type: "ORDERS_PAGE", page: 1 });
  const firstAlerts = await callbackRouter.routeReadOnlyCallback({ type: "ALERTS_PAGE", page: 0 });
  const secondAlerts = await callbackRouter.routeReadOnlyCallback({ type: "ALERTS_PAGE", page: 1 });
  const expiredOrder = await callbackRouter.routeReadOnlyCallback({ type: "ORDERS_DETAIL", orderId: 99 });
  const expiredAlertsPage = await callbackRouter.routeReadOnlyCallback({ type: "ALERTS_PAGE", page: 2 });
  const expiredAlert = await callbackRouter.routeReadOnlyCallback({ type: "ALERTS_DETAIL", alertId: 4 });
  const alertDetail = await callbackRouter.routeReadOnlyCallback({ type: "ALERTS_DETAIL", alertId: 0 });

  assert.match(firstOrders.text, /page-order-5/);
  assert.doesNotMatch(firstOrders.text, /page-order-0/);
  const secondOrderButtons = secondOrders.replyMarkup.inlineKeyboard.flat().map((button) => button.callbackData);
  assert.ok(secondOrderButtons.includes("orders:page:0"));
  assert.ok(secondOrderButtons.includes("home"));
  assert.ok(!secondOrderButtons.includes("orders:page:2"));
  assert.match(firstAlerts.text, /alert &lt;3&gt;/);
  const secondAlertButtons = secondAlerts.replyMarkup.inlineKeyboard.flat().map((button) => button.callbackData);
  assert.ok(secondAlertButtons.includes("alerts:page:0"));
  assert.ok(secondAlertButtons.includes("home"));
  assert.ok(!secondAlertButtons.includes("alerts:page:2"));
  assert.match(alertDetail.text, /message &amp; 3/);
  assert.match(expiredOrder.text, /expired|not found|만료|찾을 수 없/u);
  assert.match(expiredAlertsPage.text, /expired|not found|만료|찾을 수 없/u);
  assert.match(expiredAlert.text, /expired|not found|만료|찾을 수 없/u);
  assert.equal(eventReads, 0);
  assert.equal(fillReads, 0);
});

test("router keeps invalid preview requests usage-only and localizes missing controller state", async () => {
  let previewCalls = 0;
  const routerWithController = new TelegramCommandRouter({
    repositories: new InMemoryExecutionRepository(),
    operatorState: new InMemoryOperatorStateStore({
      id: "invalid-preview-state",
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
      async requestPreview() {
        previewCalls += 1;
        throw new Error("invalid preview requests must not reach the controller");
      },
      async requestRun() {
        throw new Error("requestRun must not be called");
      },
    },
  });
  const routerWithoutController = createRouter();

  const invalidAsset = await routerWithController.route("/preview DOGE");
  const extraArgs = await routerWithController.route("/preview BTC now");
  const missingController = await routerWithoutController.route("/preview BTC");

  assert.equal(previewCalls, 0);
  assert.equal(invalidAsset.text, "Usage: /preview BTC|ETH\nPreview one deterministic PositionGuard strategy decision and order intent without persistence or order submission.");
  assert.equal(extraArgs.text, "Usage: /preview BTC|ETH\nPreview one deterministic PositionGuard strategy decision and order intent without persistence or order submission.");
  assert.match(missingController.text, /상태: 미리보기 기능 연결 안 됨/);
  assert.match(missingController.text, /status: NOT_CONNECTED/);
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
    deliveredAt: null,
    lastError: null,
    ...rest,
    id,
    createdAt,
  };
}

function createDeliveryAttempt(
  outcome: OperatorNotificationDeliveryAttemptRecord["outcome"],
  index: number,
): OperatorNotificationDeliveryAttemptRecord {
  return {
    id: `attempt-${outcome}`,
    notificationId: `notification-${index}`,
    exchangeAccountId: "primary",
    attemptCount: index + 1,
    leaseToken: `lease-${index}`,
    outcome,
    failureClass: outcome === "RETRY_SCHEDULED" ? "RETRYABLE" : null,
    attemptedAt: `2026-04-20T00:0${index}:30.000Z`,
    nextAttemptAt: outcome === "RETRY_SCHEDULED" ? "2026-04-20T00:09:00.000Z" : null,
    deliveredAt: outcome === "SENT" ? "2026-04-20T00:00:30.000Z" : null,
    errorMessage: outcome === "FAILED" ? "telegram_http_403" : null,
    createdAt: `2026-04-20T00:0${index}:30.000Z`,
  };
}

function createDeliveryRun(
  status: OperatorNotificationDeliveryRunRecord["status"],
  index: number,
): OperatorNotificationDeliveryRunRecord {
  return {
    id: `delivery-run-${status}`,
    exchangeAccountId: "primary",
    workerName: "telegram_delivery_inline_worker",
    status,
    startedAt: `2026-04-20T00:0${index}:00.000Z`,
    completedAt: `2026-04-20T00:0${index}:01.000Z`,
    attemptedCount: 1,
    sentCount: status === "COMPLETED" ? 1 : 0,
    retryScheduledCount: 0,
    failedCount: status === "FAILED" ? 1 : 0,
    staleLeaseCount: 0,
    pendingTotalCount: 0,
    pendingDueCount: 0,
    pendingScheduledCount: 0,
    activeLeaseCount: 0,
    expiredLeaseCount: 0,
    abandonedLeaseCandidateCount: 0,
    skippedReason: status === "SKIPPED" ? "delivery_not_configured" : null,
    errorMessage: status === "FAILED" ? "delivery_worker_failed" : null,
    summaryJson: "{}",
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
