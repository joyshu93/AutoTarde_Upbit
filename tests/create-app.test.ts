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
  assert.equal(app.candidatePilotInitializer, null);

  app.persistence.close();
  await cleanupTempDatabase(databasePath);
});

test("createApp baseline never invokes candidate authority or constructs candidate services", async () => {
  const databasePath = await createTempDatabasePath("baseline-no-candidate-graph");
  let observerCalls = 0;
  let initializationRepositoryCalls = 0;
  let app: ReturnType<typeof createApp> | null = null;

  try {
    app = createApp(
      createConfig({ databasePath }),
      {
        afterCandidatePilotAuthorityValidated: () => {
          observerCalls += 1;
          throw new Error("baseline must not observe candidate authority");
        },
        candidatePilotInitializerRepository: {
          async initializeDeploymentWithInitialState() {
            initializationRepositoryCalls += 1;
            throw new Error("baseline must not initialize a candidate deployment");
          },
        },
      },
    );

    assert.equal(observerCalls, 0);
    assert.equal(app.candidateEvidenceService, null);
    assert.equal(app.candidatePilotInitializer, null);
    assert.equal(initializationRepositoryCalls, 0);
  } finally {
    (app as ReturnType<typeof createApp> | null)?.persistence.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp exposes but does not invoke the candidate initializer", async () => {
  const databasePath = await createTempDatabasePath("candidate-initializer-exposure");
  let clockCalls = 0;
  let initializationRepositoryCalls = 0;
  let app: ReturnType<typeof createApp> | null = null;

  try {
    app = createApp(
      createConfig({
        databasePath,
        executionMode: "LIVE",
        positionGuardPolicySelection: candidatePolicySelection(),
      }),
      {
        privateExchangeAdapter: createLiveExecutionAdapterFake(),
        publicMarketDataReader: createDryRunOperatorMarketDataReader(),
        candidatePilotInitializerClock: {
          now() {
            clockCalls += 1;
            return "2026-08-24T00:00:00.000Z";
          },
        },
        candidatePilotInitializerRepository: {
          async initializeDeploymentWithInitialState() {
            initializationRepositoryCalls += 1;
            throw new Error("createApp must expose without initialization");
          },
        },
      },
    );

    assert.notEqual(app.candidatePilotInitializer, null);
    assert.equal(clockCalls, 0);
    assert.equal(initializationRepositoryCalls, 0);
  } finally {
    app?.persistence.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp runs the candidate authority observer after checked-in validation and before SQLite persistence", async () => {
  const databasePath = await createTempDatabasePath("candidate-authority-before-sqlite");
  let observerCalls = 0;
  let app: ReturnType<typeof createApp> | null = null;

  try {
    assert.throws(
      () => {
        app = createApp(
        createConfig({
          databasePath,
          executionMode: "LIVE",
          positionGuardPolicySelection: candidatePolicySelection(),
        }),
        {
          afterCandidatePilotAuthorityValidated: (authority) => {
            observerCalls += 1;
            assert.equal(authority.valid, true);
            assert.equal(authority.experimentId, "PCS-2026-001");
            assert.equal(Object.isFrozen(authority), true);
            assert.equal(existsSync(databasePath), false);
            throw new Error("candidate authority observer rejected");
          },
        },
        );
      },
      /candidate authority observer rejected/i,
    );

    assert.equal(observerCalls, 1);
    await assert.rejects(() => access(databasePath));
  } finally {
    (app as ReturnType<typeof createApp> | null)?.persistence.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp ignores a candidate authority observer return value after checked-in validation", async () => {
  const databasePath = await createTempDatabasePath("candidate-authority-observer-return");
  let app: ReturnType<typeof createApp> | null = null;

  try {
    app = createApp(
        createConfig({
          databasePath,
          executionMode: "LIVE",
          positionGuardPolicySelection: candidatePolicySelection(),
        }),
        {
          afterCandidatePilotAuthorityValidated: () => ({
            valid: true,
            experimentId: "PCS-2026-001",
            eventAt: "tampered",
          }),
        },
    );

    assert.notEqual(app.candidateEvidenceService, null);
  } finally {
    app?.persistence.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp rejects malformed candidate selections before SQLite persistence is created", async () => {
  const cases: ReadonlyArray<Readonly<{
    label: string;
    selection: unknown;
    getterCalls?: () => number;
  }>> = [
    {
      label: "accessor",
      selection: createCandidateSelectionWithAccessor(),
      getterCalls: () => candidateSelectionAccessorCalls,
    },
    {
      label: "extra-property",
      selection: { ...candidatePolicySelection(), unexpected: true },
    },
    {
      label: "symbol-property",
      selection: Object.assign(candidatePolicySelection(), { [Symbol("unexpected")]: true }),
    },
    {
      label: "non-enumerable-property",
      selection: createCandidateSelectionWithNonEnumerableProperty(),
    },
    {
      label: "inherited-property",
      selection: Object.create(candidatePolicySelection()),
    },
  ];

  for (const entry of cases) {
    const databasePath = await createTempDatabasePath(`candidate-selection-${entry.label}`);
    try {
      assert.throws(
        () => createApp(createConfig({
          databasePath,
          executionMode: "LIVE",
          positionGuardPolicySelection: entry.selection as AppConfig["positionGuardPolicySelection"],
        })),
        /candidate policy selection/i,
      );
      assert.equal(entry.getterCalls?.() ?? 0, 0);
      await assert.rejects(() => access(databasePath));
    } finally {
      await cleanupTempDatabase(databasePath);
    }
  }
});

test("createApp rejects a valid candidate selection outside LIVE mode before SQLite persistence", async () => {
  const databasePath = await createTempDatabasePath("candidate-selection-non-live");

  try {
    assert.throws(
      () => createApp(createConfig({
        databasePath,
        executionMode: "DRY_RUN",
        positionGuardPolicySelection: candidatePolicySelection(),
      })),
      /requires LIVE execution mode/i,
    );
    await assert.rejects(() => access(databasePath));
  } finally {
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp snapshots the validated candidate selection before services are composed", async () => {
  const databasePath = await createTempDatabasePath("candidate-selection-snapshot");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;
  const selection = candidatePolicySelection() as {
    kind: "BTC_CANDIDATE_PILOT" | "BASELINE";
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1" | null;
    market?: "KRW-BTC";
    policyId?: "COMBINED_CONSERVATIVE";
    policyVersion?: "PCS-2026-001.DEPLOYMENT_READINESS_V1";
    liveOperatorConfirmed?: true;
  };
  let app: ReturnType<typeof createApp> | null = null;
  process.env.UPBIT_ACCESS_KEY = "test-access-key";
  process.env.UPBIT_SECRET_KEY = "test-secret-key";

  try {
    app = createCandidateLiveApp({
      databasePath,
      selection: selection as unknown as AppConfig["positionGuardPolicySelection"],
    });
    await createPendingFlatCandidateDeployment(app);
    selection.kind = "BASELINE";
    selection.pilotId = null;
    delete selection.market;
    delete selection.policyId;
    delete selection.policyVersion;
    delete selection.liveOperatorConfirmed;

    const response = await app.telegramRouter.route("/run BTC");
    const decision = await app.repositories.getLatestStrategyDecision("primary", "KRW-BTC");

    assert.match(response.text, /COMPLETED|처리 완료/);
    assert.notEqual(decision, null);
    assert.match(decision?.decisionBasisJson ?? "", /BTC_CANDIDATE_PILOT/);
  } finally {
    app?.telegramInboundPolling.stop();
    app?.strategyScheduler.stop();
    app?.persistence.close();
    restoreOptionalEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    restoreOptionalEnv("UPBIT_SECRET_KEY", previousSecretKey);
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp closes SQLite persistence when candidate composition fails after bootstrap", async () => {
  const databasePath = await createTempDatabasePath("candidate-composition-cleanup");

  try {
    assert.throws(
      () => createApp(createConfig({
        databasePath,
        executionMode: "LIVE",
        positionGuardPolicySelection: candidatePolicySelection(),
        strategySchedulerBtcIntervalMs: Number.NaN,
      })),
      /candidate recovery freshnessThresholdMs/i,
    );
    await access(databasePath);
    await rm(databasePath);
    await assert.rejects(() => access(databasePath));
  } finally {
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp wires candidate-only BTC preparation and recovery without changing ETH scheduler ownership", async () => {
  const databasePath = await createTempDatabasePath("candidate-btc-controller-owner");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;
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
        afterCandidatePilotAuthorityValidated: () => {
          assert.equal(existsSync(databasePath), false);
        },
      },
    );

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

test("createApp routes manual candidate BTC through preparation and blocks missing deployment before decisions", async () => {
  const databasePath = await createTempDatabasePath("candidate-manual-btc-missing-deployment");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;
  let app: ReturnType<typeof createApp> | null = null;
  process.env.UPBIT_ACCESS_KEY = "test-access-key";
  process.env.UPBIT_SECRET_KEY = "test-secret-key";

  try {
    app = createCandidateLiveApp({ databasePath });
    const response = await app.telegramRouter.route("/run BTC");
    const decision = await app.repositories.getLatestStrategyDecision("primary", "KRW-BTC");
    const orders = await app.repositories.listOrders("primary");
    const reconciliationRuns = await app.repositories.listReconciliationRuns("primary", 5);
    const latestBalanceSnapshot = await app.repositories.getLatestBalanceSnapshot("primary");
    const latestPositionSnapshot = await app.repositories.getLatestPositionSnapshot("primary");

    assert.match(response.text, /IDENTITY_MISMATCH/);
    assert.equal(decision, null);
    assert.equal(orders.length, 0);
    assert.notEqual(latestBalanceSnapshot, null);
    assert.notEqual(latestPositionSnapshot, null);
    assert.equal(
      (JSON.parse(reconciliationRuns[0]?.summaryJson ?? "{}") as { source?: string }).source,
      "SCHEDULER_PREFLIGHT",
    );
  } finally {
    app?.telegramInboundPolling.stop();
    app?.strategyScheduler.stop();
    app?.persistence.close();
    restoreOptionalEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    restoreOptionalEnv("UPBIT_SECRET_KEY", previousSecretKey);
    await cleanupTempDatabase(databasePath);
  }
});

test("createApp routes manual ETH through the baseline path without candidate preparation", async () => {
  const databasePath = await createTempDatabasePath("candidate-manual-eth-baseline");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;
  let app: ReturnType<typeof createApp> | null = null;
  process.env.UPBIT_ACCESS_KEY = "test-access-key";
  process.env.UPBIT_SECRET_KEY = "test-secret-key";

  try {
    app = createCandidateLiveApp({ databasePath });
    await app.portfolioSyncService.run({
      exchangeAccountId: "primary",
      source: "OPERATOR_SYNC",
    });
    const reconciliationRunsBefore = await app.repositories.listReconciliationRuns("primary", 20);
    const response = await app.telegramRouter.route("/run ETH");
    const decision = await app.repositories.getLatestStrategyDecision("primary", "KRW-ETH");
    const reconciliationRunsAfter = await app.repositories.listReconciliationRuns("primary", 20);

    assert.match(response.text, /HOLD|유지/);
    assert.notEqual(decision, null);
    assert.equal(reconciliationRunsAfter.length, reconciliationRunsBefore.length);
    assert.equal(
      (JSON.parse(reconciliationRunsAfter[0]?.summaryJson ?? "{}") as { source?: string }).source,
      "OPERATOR_SYNC",
    );
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

let candidateSelectionAccessorCalls = 0;

function createCandidateSelectionWithAccessor(): unknown {
  candidateSelectionAccessorCalls = 0;
  const selection = candidatePolicySelection() as Record<string, unknown>;
  delete selection.kind;
  Object.defineProperty(selection, "kind", {
    enumerable: true,
    get() {
      candidateSelectionAccessorCalls += 1;
      return "BTC_CANDIDATE_PILOT";
    },
  });
  return selection;
}

function createCandidateSelectionWithNonEnumerableProperty(): unknown {
  const selection = candidatePolicySelection() as Record<string, unknown>;
  Object.defineProperty(selection, "unexpected", {
    enumerable: false,
    value: true,
  });
  return selection;
}

function createCandidateLiveApp(input: Readonly<{
  databasePath: string;
  selection?: AppConfig["positionGuardPolicySelection"];
}>): ReturnType<typeof createApp> {
  return createApp(
    createConfig({
      databasePath: input.databasePath,
      executionMode: "LIVE",
      liveExecutionGate: "ENABLED",
      positionGuardPolicySelection: input.selection ?? candidatePolicySelection(),
    }),
    {
      privateExchangeAdapter: createLiveExecutionAdapterFake(),
      publicMarketDataReader: createDryRunOperatorMarketDataReader(),
    },
  );
}

async function createPendingFlatCandidateDeployment(app: ReturnType<typeof createApp>): Promise<void> {
  const createdAt = new Date().toISOString();
  await app.persistence.candidatePilots.createDeploymentWithInitialState({
    deployment: {
      id: `create-app-candidate-deployment-${Math.random().toString(16).slice(2)}`,
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
