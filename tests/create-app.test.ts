import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { createApp } from "../src/app/create-app.js";
import type { AppConfig } from "../src/app/env.js";
import { startTelegramRuntime } from "../src/index.js";
import {
  DryRunExchangeAdapter,
  type LiveExecutionAdapter,
} from "../src/modules/exchange/interfaces.js";
import { createEmptyPositionGuardCandidateState } from "../src/modules/strategy/position-guard-candidate-state.js";
import { createDryRunOperatorMarketDataReader } from "../src/smoke/dryrun-operator.js";
import { test } from "./harness.js";

test("createApp keeps dry-run adapter as the default live send path", async () => {
  const databasePath = await createTempDatabasePath("dryrun");
  const app = createApp(createConfig({ databasePath }));

  assert.equal(app.liveSendPath, "DRY_RUN_ADAPTER");
  assert.equal(app.strategyScheduler.getStatus().liveSendPath, "DRY_RUN_ADAPTER");
  assert.equal(app.telegramCommandMenuSetup.isConfigured(), false);

  app.persistence.close();
  await cleanupTempDatabase(databasePath);
});

test("createApp baseline never invokes candidate authority or constructs candidate services", async () => {
  const databasePath = await createTempDatabasePath("baseline-no-candidate-graph");
  let authorityCalls = 0;
  let app: ReturnType<typeof createApp> | null = null;

  try {
    app = createApp(
      createConfig({ databasePath }),
      {
        loadCandidatePilotAbandonment: () => {
          authorityCalls += 1;
          throw new Error("baseline must not load candidate authority");
        },
      },
    );

    assert.equal(authorityCalls, 0);
    assert.equal(app.candidateEvidenceService, null);
  } finally {
    (app as ReturnType<typeof createApp> | null)?.persistence.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp rejects candidate authority before SQLite persistence is created", async () => {
  const databasePath = await createTempDatabasePath("candidate-authority-before-sqlite");
  let authorityCalls = 0;
  let app: ReturnType<typeof createApp> | null = null;

  try {
    await assert.rejects(
      async () => {
        app = createApp(
        createConfig({
          databasePath,
          positionGuardPolicySelection: candidatePolicySelection(),
        }),
        {
          loadCandidatePilotAbandonment: () => {
            authorityCalls += 1;
            throw new Error("candidate authority fixture rejected");
          },
        },
        );
      },
      /candidate authority fixture rejected/i,
    );

    assert.equal(authorityCalls, 1);
    await assert.rejects(() => access(databasePath));
  } finally {
    (app as ReturnType<typeof createApp> | null)?.persistence.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp rejects malformed candidate authority before SQLite persistence is created", async () => {
  const databasePath = await createTempDatabasePath("candidate-malformed-authority-before-sqlite");

  try {
    assert.throws(
      () => createApp(
        createConfig({
          databasePath,
          positionGuardPolicySelection: candidatePolicySelection(),
        }),
        {
          loadCandidatePilotAbandonment: () => ({
            valid: true,
            experimentId: "PCS-2026-001",
            eventAt: "tampered",
          }) as never,
        },
      ),
      /candidate abandonment authority is invalid/i,
    );

    await assert.rejects(() => access(databasePath));
  } finally {
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp wires candidate-only BTC preparation and recovery without changing ETH scheduler ownership", async () => {
  const databasePath = await createTempDatabasePath("candidate-btc-controller-owner");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;
  let authorityCalls = 0;
  let app: ReturnType<typeof createApp> | null = null;
  const privateAdapter = createCountingLiveExecutionAdapterFake();
  process.env.UPBIT_ACCESS_KEY = "test-access-key";
  process.env.UPBIT_SECRET_KEY = "test-secret-key";

  try {
    app = createApp(
      createConfig({
        databasePath,
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
        strategySchedulerEnabled: true,
        positionGuardPolicySelection: candidatePolicySelection(),
      }),
      {
        privateExchangeAdapter: privateAdapter.adapter,
        publicMarketDataReader: createDryRunOperatorMarketDataReader(),
        loadCandidatePilotAbandonment: () => {
          authorityCalls += 1;
          assert.equal(existsSync(databasePath), false);
          return validCandidateAuthority();
        },
      },
    );

    assert.equal(authorityCalls, 1);
    assert.notEqual(app.candidateEvidenceService, null);

    const createdAt = new Date().toISOString();
    await app.persistence.candidatePilots.createDeploymentWithInitialState({
      deployment: {
        id: "create-app-candidate-deployment",
        exchangeAccountId: "primary",
        pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
        market: "KRW-BTC",
        policyId: "COMBINED_CONSERVATIVE",
        policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
        phase: "PENDING_FLAT",
        activationAt: null,
        activationEpochNs: null,
        createdAt,
        updatedAt: createdAt,
      },
      initialState: createEmptyPositionGuardCandidateState(),
    });

    const btcResult = await app.strategyScheduler.runMarketNow("KRW-BTC");
    const btcDecision = await app.repositories.getLatestStrategyDecision("primary", "KRW-BTC");
    const deployment = await app.persistence.candidatePilots.getDeployment("create-app-candidate-deployment");
    assert.equal(privateAdapter.getBalanceCallCount(), 1);
    const ethResult = await app.strategyScheduler.runMarketNow("KRW-ETH");
    const ethDecision = await app.repositories.getLatestStrategyDecision("primary", "KRW-ETH");

    assert.equal(btcResult.status, "COMPLETED");
    assert.notEqual(btcDecision, null);
    assert.match(btcDecision?.decisionBasisJson ?? "", /BTC_CANDIDATE_PILOT/);
    assert.equal(deployment?.phase, "ACTIVE");
    assert.equal(ethResult.status, "COMPLETED");
    assert.notEqual(ethDecision, null);
    assert.equal(privateAdapter.getBalanceCallCount(), 2);
  } finally {
    app?.telegramInboundPolling.stop();
    app?.strategyScheduler.stop();
    app?.persistence.close();
    restoreOptionalEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    restoreOptionalEnv("UPBIT_SECRET_KEY", previousSecretKey);
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp wires command-menu setup without changing live-send selection", async () => {
  const databasePath = await createTempDatabasePath("command-menu");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;
  process.env.UPBIT_ACCESS_KEY = "test-access-key";
  process.env.UPBIT_SECRET_KEY = "test-secret-key";

  try {
    const app = createApp(createConfig({
      databasePath,
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      telegramBotToken: "test-telegram-token",
      telegramOperatorChatId: "operator-chat-1",
    }));

    assert.equal(app.liveSendPath, "LIVE_ADAPTER");
    assert.equal(app.strategyScheduler.getStatus().liveSendPath, "LIVE_ADAPTER");
    assert.equal(app.telegramCommandMenuSetup.isConfigured(), true);
    app.persistence.close();
  } finally {
    restoreOptionalEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    restoreOptionalEnv("UPBIT_SECRET_KEY", previousSecretKey);
    await cleanupTempDatabase(databasePath);
  }
});

test("runtime starts scheduler and inbound decisions before isolated command-menu setup reporting", async () => {
  const events: string[] = [];
  const commandMenuResult = {
    configured: true,
    attempted: true,
    status: "FAILED" as const,
    failureCode: "telegram_command_menu_english_failed",
    korean: "COMPLETED" as const,
    english: "FAILED" as const,
  };

  const result = await startTelegramRuntime({
    strategyScheduler: {
      start() {
        events.push("scheduler:start");
        return { started: true };
      },
      async reportStartupBlockIfNeeded() {
        events.push("scheduler:report");
        return false;
      },
    },
    telegramInboundPolling: {
      start() {
        events.push("inbound:start");
        return { running: true };
      },
    },
    installRuntimeSignalHandlers() {
      events.push("signals:install");
    },
    telegramCommandMenuSetup: {
      async setup() {
        events.push("menu:setup");
        return commandMenuResult;
      },
    },
  });

  assert.deepEqual(events, [
    "scheduler:start",
    "scheduler:report",
    "inbound:start",
    "signals:install",
    "menu:setup",
  ]);
  assert.equal(result.telegramCommandMenuSetup.status, "FAILED");
  assert.equal(result.strategySchedulerStatus.started, true);
  assert.equal(result.telegramInboundPollingStatus.running, true);
});

test("createApp wires the live adapter only when live mode, live gate, and Upbit credentials are configured", async () => {
  const databasePath = await createTempDatabasePath("live");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;
  process.env.UPBIT_ACCESS_KEY = "test-access-key";
  process.env.UPBIT_SECRET_KEY = "test-secret-key";

  try {
    const app = createApp(createConfig({
      databasePath,
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      strategySchedulerEnabled: true,
    }));

    assert.equal(app.liveSendPath, "LIVE_ADAPTER");
    assert.equal(app.strategyScheduler.getStatus().liveSendPath, "LIVE_ADAPTER");
    app.persistence.close();
  } finally {
    restoreOptionalEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    restoreOptionalEnv("UPBIT_SECRET_KEY", previousSecretKey);
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp refreshes live scheduler account health before before-run preflight", async () => {
  const databasePath = await createTempDatabasePath("live-scheduler-preflight");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;
  let app: ReturnType<typeof createApp> | null = null;
  process.env.UPBIT_ACCESS_KEY = "test-access-key";
  process.env.UPBIT_SECRET_KEY = "test-secret-key";

  try {
    app = createApp(
      createConfig({
        databasePath,
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
        strategySchedulerEnabled: true,
      }),
      {
        privateExchangeAdapter: createLiveExecutionAdapterFake(),
        publicMarketDataReader: createDryRunOperatorMarketDataReader(),
      },
    );

    const result = await app.strategyScheduler.runMarketNow("KRW-BTC");
    await app.notificationDelivery.deliverPending("primary");
    const latestDecision = await app.repositories.getLatestStrategyDecision(
      "primary",
      "KRW-BTC",
    );
    const reconciliationRuns = await app.repositories.listReconciliationRuns("primary", 1);
    const latestReconciliationMeta = JSON.parse(
      reconciliationRuns[0]?.summaryJson ?? "{}",
    ) as { source?: string };

    assert.equal(app.liveSendPath, "LIVE_ADAPTER");
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.action, "HOLD");
    assert.notEqual(latestDecision, null);
    assert.equal(latestReconciliationMeta.source, "SCHEDULER_PREFLIGHT");
  } finally {
    app?.telegramInboundPolling.stop();
    app?.strategyScheduler.stop();
    app?.persistence.close();
    restoreOptionalEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    restoreOptionalEnv("UPBIT_SECRET_KEY", previousSecretKey);
    await cleanupTempDatabase(databasePath);
  }
});

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    serviceName: "AutoTrade_Upbit",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    positionGuardPolicySelection: { kind: "BASELINE", pilotId: null },
    globalKillSwitch: false,
    upbitBaseUrl: "https://api.upbit.com",
    databasePath: "./var/autotrade-upbit.sqlite",
    telegramLocale: "ko-KR",
    telegramDeliveryEnabled: false,
    telegramBotToken: null,
    telegramOperatorChatId: null,
    telegramDeliveryMaxAttempts: 5,
    telegramDeliveryBaseBackoffMs: 15_000,
    telegramDeliveryMaxBackoffMs: 300_000,
    telegramDeliveryLeaseMs: 30_000,
    accountExecutionLeaseMs: 30_000,
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
    ...overrides,
  };
}

async function createTempDatabasePath(label: string): Promise<string> {
  const directory = path.resolve(process.cwd(), ".tmp-db-tests");
  await mkdir(directory, { recursive: true });
  return path.join(directory, `create-app-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

async function cleanupTempDatabase(databasePath: string): Promise<void> {
  await Promise.all([
    rmWithRetry(databasePath),
    rmWithRetry(`${databasePath}-wal`),
    rmWithRetry(`${databasePath}-shm`),
  ]);
}

async function rmWithRetry(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(filePath, { force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "EBUSY" || attempt === 4) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (typeof value === "string") {
    process.env[name] = value;
    return;
  }

  delete process.env[name];
}

function candidatePolicySelection(): AppConfig["positionGuardPolicySelection"] {
  return {
    kind: "BTC_CANDIDATE_PILOT",
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    liveOperatorConfirmed: true,
  };
}

function validCandidateAuthority() {
  return {
    valid: true as const,
    experimentId: "PCS-2026-001" as const,
    eventAt: "2026-08-21T03:08:24.756Z" as const,
  };
}

function createLiveExecutionAdapterFake(): LiveExecutionAdapter {
  const baseAdapter = new DryRunExchangeAdapter();
  return {
    sendPath: "LIVE_ADAPTER",
    getBalances: baseAdapter.getBalances.bind(baseAdapter),
    getOrderChance: baseAdapter.getOrderChance.bind(baseAdapter),
    testOrder: baseAdapter.testOrder.bind(baseAdapter),
    createOrder: baseAdapter.createOrder.bind(baseAdapter),
    cancelOrder: baseAdapter.cancelOrder.bind(baseAdapter),
    getOrder: baseAdapter.getOrder.bind(baseAdapter),
    listOpenOrders: baseAdapter.listOpenOrders.bind(baseAdapter),
    listClosedOrders: baseAdapter.listClosedOrders.bind(baseAdapter),
  };
}

function createCountingLiveExecutionAdapterFake(): Readonly<{
  adapter: LiveExecutionAdapter;
  getBalanceCallCount(): number;
}> {
  const baseAdapter = new DryRunExchangeAdapter();
  let balanceCallCount = 0;
  return {
    adapter: {
      sendPath: "LIVE_ADAPTER",
      async getBalances() {
        balanceCallCount += 1;
        return baseAdapter.getBalances();
      },
      getOrderChance: baseAdapter.getOrderChance.bind(baseAdapter),
      testOrder: baseAdapter.testOrder.bind(baseAdapter),
      createOrder: baseAdapter.createOrder.bind(baseAdapter),
      cancelOrder: baseAdapter.cancelOrder.bind(baseAdapter),
      getOrder: baseAdapter.getOrder.bind(baseAdapter),
      listOpenOrders: baseAdapter.listOpenOrders.bind(baseAdapter),
      listClosedOrders: baseAdapter.listClosedOrders.bind(baseAdapter),
    },
    getBalanceCallCount: () => balanceCallCount,
  };
}
