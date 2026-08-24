import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createApp } from "../src/app/create-app.js";
import type { AppConfig } from "../src/app/env.js";
import { runAppStartup, startTelegramRuntime, type AppStartupOperations } from "../src/index.js";
import {
  DryRunExchangeAdapter,
  type LiveExecutionAdapter,
} from "../src/modules/exchange/interfaces.js";
import { createEmptyPositionGuardCandidateState } from "../src/modules/strategy/position-guard-candidate-state.js";
import type { PositionGuardPublicMarketDataReader } from
  "../src/modules/strategy/position-guard-snapshot.js";
import { createDryRunOperatorMarketDataReader } from "../src/smoke/dryrun-operator.js";
import { test } from "./harness.js";

test("createApp keeps dry-run adapter as the default live send path", async () => {
  const databasePath = await createTempDatabasePath("dryrun");
  const app = createApp(createConfig({ databasePath }));

  assert.equal(app.liveSendPath, "DRY_RUN_ADAPTER");
  assert.equal(app.strategyScheduler.getStatus().liveSendPath, "DRY_RUN_ADAPTER");
  assert.equal(app.telegramCommandMenuSetup.isConfigured(), false);
  assert.equal(app.candidatePilotInitializer, null);
  assert.equal((app as typeof app & { candidatePilotRecovery?: unknown }).candidatePilotRecovery, null);

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
    assert.equal((app as typeof app & { candidatePilotRecovery?: unknown }).candidatePilotRecovery, null);
    assert.equal(initializationRepositoryCalls, 0);
  } finally {
    (app as ReturnType<typeof createApp> | null)?.persistence.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("baseline startup rejects every persisted nonterminal candidate phase before runtime surfaces", async () => {
  for (const phase of ["PENDING_FLAT", "ACTIVE", "DRAINING", "PAUSED_FAULT"] as const) {
    const databasePath = await createTempDatabasePath(`baseline-persisted-${phase.toLowerCase()}`);
    let baselineApp: ReturnType<typeof createApp> | null = null;

    try {
      await seedPersistedCandidatePhase(databasePath, phase);
      baselineApp = createApp(createConfig({ databasePath }));
      const boundary = createStartupBoundaryOperations();
      let notificationCalls = 0;
      const startupApp = {
        ...baselineApp,
        notificationDelivery: {
          ...baselineApp.notificationDelivery,
          async deliverPending() {
            notificationCalls += 1;
            return {} as never;
          },
          isConfigured() {
            return false;
          },
        },
        persistence: {
          ...baselineApp.persistence,
          close() {},
        },
      } as unknown as typeof baselineApp;

      await assert.rejects(
        () => runAppStartup(startupApp, boundary.operations),
        /candidate|pilot|baseline|selection|authority/i,
        phase,
      );

      assert.equal(notificationCalls, 0, phase);
      assert.equal(boundary.runtimeSurfaceCalls(), 0, phase);
      assert.equal((await baselineApp.operatorState.getState()).systemStatus, "PAUSED", phase);
    } finally {
      baselineApp?.persistence.close();
      await cleanupTempDatabase(databasePath);
    }
  }
});

test("fresh and canonically rollback-completed databases remain baseline without candidate recovery", async () => {
  for (const authority of ["FRESH", "CANONICAL_DISABLED"] as const) {
    const databasePath = await createTempDatabasePath(`baseline-${authority.toLowerCase()}`);
    let baselineApp: ReturnType<typeof createApp> | null = null;

    try {
      if (authority === "CANONICAL_DISABLED") {
        await seedCanonicalDisabledCandidate(databasePath);
      }
      baselineApp = createApp(createConfig({ databasePath }));
      const boundary = createStartupBoundaryOperations();

      await runAppStartup(baselineApp, boundary.operations);

      assert.equal(boundary.runtimeSurfaceCalls(), 1, authority);
      assert.equal(
        (baselineApp as typeof baselineApp & { candidatePilotStartupRecovery?: unknown })
          .candidatePilotStartupRecovery ?? null,
        null,
        authority,
      );
    } finally {
      baselineApp?.persistence.close();
      await cleanupTempDatabase(databasePath);
    }
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

test("createApp exposes candidate rollback with bound operator authority and construction sends no order", async () => {
  const databasePath = await createTempDatabasePath("candidate-recovery-exposure");
  const privateAdapter = createCountingLiveExecutionAdapterFake();
  let app: ReturnType<typeof createApp> | null = null;

  try {
    app = createApp(
      createConfig({
        databasePath,
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
        positionGuardPolicySelection: candidatePolicySelection(),
      }),
      {
        privateExchangeAdapter: privateAdapter.adapter,
        publicMarketDataReader: createDryRunOperatorMarketDataReader(),
      },
    );

    const recovery = (app as typeof app & {
      candidatePilotRecovery?: {
        requestRollback(receipt: {
          exchangeAccountId: string;
          requestedAt: string;
          balanceSnapshotId: string;
          balanceCapturedAt: string;
          positionSnapshotId: string;
          positionCapturedAt: string;
          reconciliationRunId: string;
          reconciliationStartedAt: string;
          reconciliationCompletedAt: string;
          reconciliationSource: "SCHEDULER_PREFLIGHT";
        }): Promise<{ status: string }>;
      } | null;
    }).candidatePilotRecovery;
    assert.notEqual(recovery, null);
    assert.notEqual(recovery, undefined);
    assert.equal(privateAdapter.getCreateOrderCallCount(), 0);

    const result = await recovery?.requestRollback({
      exchangeAccountId: "primary",
      requestedAt: "2026-08-24T00:00:00.000Z",
      balanceSnapshotId: "missing-balance",
      balanceCapturedAt: "2026-08-24T00:00:00.000Z",
      positionSnapshotId: "missing-position",
      positionCapturedAt: "2026-08-24T00:00:00.000Z",
      reconciliationRunId: "missing-reconciliation",
      reconciliationStartedAt: "2026-08-24T00:00:00.000Z",
      reconciliationCompletedAt: "2026-08-24T00:00:01.000Z",
      reconciliationSource: "SCHEDULER_PREFLIGHT",
    });
    await app.notificationDelivery.deliverPending("primary");

    assert.equal(result?.status, "BLOCKED_FAULT");
    assert.equal((await app.operatorState.getState()).systemStatus, "PAUSED");
    assert.equal(privateAdapter.getCreateOrderCallCount(), 0);
  } finally {
    app?.persistence.close();
    await cleanupTempDatabase(databasePath);
  }
});

test("candidate createApp construction invokes no exchange, market, Telegram, or timer side effect", async () => {
  const databasePath = await createTempDatabasePath("candidate-construction-side-effects");
  const previousAccessKey = process.env.UPBIT_ACCESS_KEY;
  const previousSecretKey = process.env.UPBIT_SECRET_KEY;
  const previousFetch = globalThis.fetch;
  const previousSetTimeout = globalThis.setTimeout;
  const previousSetInterval = globalThis.setInterval;
  const fakes = createConstructionSideEffectFakes();
  let app: ReturnType<typeof createApp> | null = null;
  process.env.UPBIT_ACCESS_KEY = "fake-access-key";
  process.env.UPBIT_SECRET_KEY = "fake-secret-key";
  globalThis.fetch = (async () => {
    fakes.counts.telegramClient += 1;
    throw new Error("createApp construction must not call a Telegram client");
  }) as typeof fetch;
  globalThis.setTimeout = ((..._args: Parameters<typeof setTimeout>) => {
    fakes.counts.timeoutInstall += 1;
    return {} as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.setInterval = ((..._args: Parameters<typeof setInterval>) => {
    fakes.counts.intervalInstall += 1;
    return {} as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  try {
    app = createApp(
      createConfig({
        databasePath,
        executionMode: "LIVE",
        liveExecutionGate: "ENABLED",
        positionGuardPolicySelection: candidatePolicySelection(),
        strategySchedulerEnabled: true,
        strategySchedulerRunOnStart: true,
        telegramDeliveryEnabled: true,
        telegramBotToken: "fake-bot-token",
        telegramOperatorChatId: "fake-chat-id",
        telegramInboundPollingEnabled: true,
      }),
      {
        privateExchangeAdapter: fakes.privateAdapter,
        publicMarketDataReader: fakes.publicMarketDataReader,
      },
    );

    assert.deepEqual(fakes.counts, emptyConstructionSideEffectCounts());
    assert.equal(app.strategyScheduler.getStatus().started, false);
    assert.equal(app.strategyScheduler.getStatus().markets.every((market) => !market.running), true);
    assert.equal(app.telegramInboundPolling.getStatus().running, false);
  } finally {
    app?.persistence.close();
    globalThis.fetch = previousFetch;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.setInterval = previousSetInterval;
    restoreOptionalEnv("UPBIT_ACCESS_KEY", previousAccessKey);
    restoreOptionalEnv("UPBIT_SECRET_KEY", previousSecretKey);
    await cleanupTempDatabase(databasePath);
  }
});

test("production createApp router reads current candidate persistence while baseline stays reader-free", async () => {
  const candidateDatabasePath = await createTempDatabasePath("candidate-router-persistence");
  const baselineDatabasePath = await createTempDatabasePath("baseline-router-no-candidate-reader");
  const fakes = createConstructionSideEffectFakes();
  let candidateApp: ReturnType<typeof createApp> | null = null;
  let baselineApp: ReturnType<typeof createApp> | null = null;

  try {
    candidateApp = createApp(
      createConfig({
        databasePath: candidateDatabasePath,
        executionMode: "LIVE",
        positionGuardPolicySelection: candidatePolicySelection(),
        telegramLocale: "en-US",
      }),
      {
        privateExchangeAdapter: fakes.privateAdapter,
        publicMarketDataReader: fakes.publicMarketDataReader,
      },
    );
    const deploymentId = "create-app-router-current-candidate";
    const createdAt = "2026-08-24T00:00:00.000000000Z";
    const deployment = await candidateApp.persistence.candidatePilots.createDeploymentWithInitialState({
      deployment: {
        id: deploymentId,
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
    const activationAt = "2026-08-24T00:00:01.000000000Z";
    const activated = await candidateApp.persistence.candidatePilots.activateDeployment({
      deploymentId,
      expectedPhase: "PENDING_FLAT",
      expectedUpdatedAt: deployment.updatedAt,
      activationAt,
      activationEpochNs: BigInt(Date.parse(activationAt)) * 1_000_000n,
    });
    assert.ok(activated);
    await candidateApp.persistence.candidatePilots.advanceStateWithEvidence({
      deploymentId,
      expectedStateVersion: 0,
      evidence: {
        evidenceId: "create-app-router-current-evidence",
        executedAt: "2026-08-24T00:00:02.000000000Z",
        action: "ENTER",
        entryPath: "RECLAIM",
        terminalStatus: "FILLED",
        executedQuantity: "0.01",
        grossQuoteValueKrw: "1000000",
        confirmedFeeKrw: "500",
        remainingQuantity: "0.01",
      },
    });

    const [status, readiness] = await Promise.all([
      candidateApp.telegramRouter.route("/status detail"),
      candidateApp.telegramRouter.route("/readiness detail"),
    ]);
    for (const response of [status, readiness]) {
      assert.match(response.text, new RegExp(`btc_pilot_deployment_id: ${deploymentId}`, "u"));
      assert.match(response.text, /btc_pilot_phase: ACTIVE/u);
      assert.match(response.text, /btc_pilot_state_version: 1/u);
      assert.match(response.text, /btc_pilot_current_authority_check: VERIFIED_CURRENT/u);
      assert.doesNotMatch(response.text, /btc_pilot_phase: unavailable/u);
      assert.doesNotMatch(response.text, /btc_pilot_state_version: none/u);
    }

    baselineApp = createApp(createConfig({
      databasePath: baselineDatabasePath,
      telegramLocale: "en-US",
    }));
    const [baselineStatus, baselineReadiness] = await Promise.all([
      baselineApp.telegramRouter.route("/status detail"),
      baselineApp.telegramRouter.route("/readiness detail"),
    ]);
    assert.doesNotMatch(baselineStatus.text, /btc_pilot_/u);
    assert.doesNotMatch(baselineReadiness.text, /btc_pilot_/u);
    assert.deepEqual(fakes.counts, emptyConstructionSideEffectCounts());
    assert.equal(candidateApp.strategyScheduler.getStatus().started, false);
    assert.equal(baselineApp.strategyScheduler.getStatus().started, false);
  } finally {
    candidateApp?.persistence.close();
    baselineApp?.persistence.close();
    await cleanupTempDatabase(candidateDatabasePath);
    await cleanupTempDatabase(baselineDatabasePath);
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
    assert.notEqual(app.candidatePilotInitializer, null);
    assert.equal(privateAdapter.getCreateOrderCallCount(), 0);

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

test("createApp passes en-US into operator notification push delivery", async () => {
  const databasePath = await createTempDatabasePath("notification-delivery-locale");
  const previousFetch = globalThis.fetch;
  const sentBodies: Array<Record<string, unknown>> = [];
  let app: ReturnType<typeof createApp> | null = null;
  globalThis.fetch = (async (_input, init) => {
    sentBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    app = createApp(createConfig({
      databasePath,
      telegramLocale: "en-US",
      telegramDeliveryEnabled: true,
      telegramBotToken: "test-bot-token",
      telegramOperatorChatId: "chat-1",
    }));
    await app.repositories.saveOperatorNotification({
      id: "create-app-locale-notification",
      exchangeAccountId: "primary",
      channel: "TELEGRAM",
      notificationType: "POSITION_GUARD_PILOT_FAULT_PAUSED",
      severity: "ERROR",
      title: "Raw title must not be delivered",
      message: "Raw message must not be delivered",
      payloadJson: JSON.stringify({
        deploymentId: "deployment-create-app-locale",
        phase: "PAUSED_FAULT",
        reasonCode: "UNCERTAIN_ORDER",
        faultId: "fault-create-app-locale",
      }),
      deliveryStatus: "PENDING",
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: null,
      failureClass: null,
      leaseToken: null,
      leaseExpiresAt: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      deliveredAt: null,
      lastError: null,
    });

    await app.notificationDelivery.deliverPending("primary", 1);

    assert.equal(sentBodies.length, 1);
    const text = sentBodies[0]?.text;
    assert.equal(typeof text, "string");
    assert.match(String(text), /BTC candidate pilot fault paused/u);
    assert.match(String(text), /Notification code: POSITION_GUARD_PILOT_FAULT_PAUSED/u);
    assert.doesNotMatch(String(text), /BTC 후보 파일럿/u);
  } finally {
    app?.persistence.close();
    globalThis.fetch = previousFetch;
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

async function seedPersistedCandidatePhase(
  databasePath: string,
  phase: "PENDING_FLAT" | "ACTIVE" | "DRAINING" | "PAUSED_FAULT",
): Promise<void> {
  const candidateApp = createApp(createConfig({
    databasePath,
    executionMode: "LIVE",
    positionGuardPolicySelection: candidatePolicySelection(),
  }));
  const initialized = await candidateApp.candidatePilotInitializer!.initialize();
  candidateApp.persistence.close();
  if (phase === "PENDING_FLAT") return;

  const activationAt = initialized.deployment.createdAt;
  const activationEpochNs = BigInt(Date.parse(activationAt)) * 1_000_000n;
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare(`
      UPDATE strategy_pilot_deployments
      SET phase = ?, activation_at = ?, activation_epoch_ns = ?, updated_at = ?
      WHERE id = ?
    `).run(
      phase,
      activationAt,
      activationEpochNs.toString(),
      activationAt,
      initialized.deployment.id,
    );
  } finally {
    db.close();
  }
}

async function seedCanonicalDisabledCandidate(databasePath: string): Promise<void> {
  const candidateApp = createApp(createConfig({
    databasePath,
    executionMode: "LIVE",
    positionGuardPolicySelection: candidatePolicySelection(),
  }));
  try {
    const initialized = await candidateApp.candidatePilotInitializer!.initialize();
    const operatorState = await candidateApp.operatorState.pause("candidate_rollback_test");
    const transitionAt = new Date().toISOString();
    const disabled = await candidateApp.persistence.candidatePilots.completeRollback({
      deploymentId: initialized.deployment.id,
      expectedPhase: "PENDING_FLAT",
      expectedUpdatedAt: initialized.deployment.updatedAt,
      expectedStateVersion: 0,
      expectedOperatorState: {
        id: operatorState.id,
        exchangeAccountId: operatorState.exchangeAccountId,
        systemStatus: operatorState.systemStatus as "PAUSED" | "KILL_SWITCHED",
        updatedAt: operatorState.updatedAt,
      },
      transitionAt,
      transitionEpochNs: BigInt(Date.parse(transitionAt)) * 1_000_000n,
    });
    assert.equal(disabled?.phase, "DISABLED");
  } finally {
    candidateApp.persistence.close();
  }
}

function createStartupBoundaryOperations(): Readonly<{
  operations: AppStartupOperations;
  runtimeSurfaceCalls(): number;
}> {
  let runtimeSurfaceCalls = 0;
  return {
    operations: {
      async runStartupRecovery() {
        return {} as never;
      },
      async applyStartupRecoveryPolicy() {
        return {} as never;
      },
      async buildStrategySchedulerStartupPreflight() {
        return {} as never;
      },
      async startTelegramRuntime() {
        runtimeSurfaceCalls += 1;
        return {
          strategySchedulerStatus: { started: true },
          strategySchedulerStartupBlockNotified: false,
          telegramInboundPollingStatus: { running: false },
          telegramCommandMenuSetup: {} as never,
        };
      },
      writeBanner() {},
    },
    runtimeSurfaceCalls: () => runtimeSurfaceCalls,
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
  getCreateOrderCallCount(): number;
}> {
  const baseAdapter = new DryRunExchangeAdapter();
  let balanceCallCount = 0;
  let createOrderCallCount = 0;
  return {
    adapter: {
      sendPath: "LIVE_ADAPTER",
      async getBalances() {
        balanceCallCount += 1;
        return baseAdapter.getBalances();
      },
      getOrderChance: baseAdapter.getOrderChance.bind(baseAdapter),
      testOrder: baseAdapter.testOrder.bind(baseAdapter),
      async createOrder(request) {
        createOrderCallCount += 1;
        return baseAdapter.createOrder(request);
      },
      cancelOrder: baseAdapter.cancelOrder.bind(baseAdapter),
      getOrder: baseAdapter.getOrder.bind(baseAdapter),
      listOpenOrders: baseAdapter.listOpenOrders.bind(baseAdapter),
      listClosedOrders: baseAdapter.listClosedOrders.bind(baseAdapter),
    },
    getBalanceCallCount: () => balanceCallCount,
    getCreateOrderCallCount: () => createOrderCallCount,
  };
}

type ConstructionSideEffectCounts = {
  getBalances: number;
  getOrderChance: number;
  testOrder: number;
  createOrder: number;
  cancelOrder: number;
  getOrder: number;
  listOpenOrders: number;
  listClosedOrders: number;
  getTickers: number;
  getMinuteCandles: number;
  getDayCandles: number;
  telegramClient: number;
  timeoutInstall: number;
  intervalInstall: number;
};

function emptyConstructionSideEffectCounts(): ConstructionSideEffectCounts {
  return {
    getBalances: 0,
    getOrderChance: 0,
    testOrder: 0,
    createOrder: 0,
    cancelOrder: 0,
    getOrder: 0,
    listOpenOrders: 0,
    listClosedOrders: 0,
    getTickers: 0,
    getMinuteCandles: 0,
    getDayCandles: 0,
    telegramClient: 0,
    timeoutInstall: 0,
    intervalInstall: 0,
  };
}

function createConstructionSideEffectFakes(): Readonly<{
  counts: ConstructionSideEffectCounts;
  privateAdapter: LiveExecutionAdapter;
  publicMarketDataReader: PositionGuardPublicMarketDataReader;
}> {
  const counts = emptyConstructionSideEffectCounts();
  const privateBase = new DryRunExchangeAdapter();
  const publicBase = createDryRunOperatorMarketDataReader();
  return {
    counts,
    privateAdapter: {
      sendPath: "LIVE_ADAPTER",
      async getBalances() {
        counts.getBalances += 1;
        return privateBase.getBalances();
      },
      async getOrderChance(market) {
        counts.getOrderChance += 1;
        return privateBase.getOrderChance(market);
      },
      async testOrder(request) {
        counts.testOrder += 1;
        return privateBase.testOrder(request);
      },
      async createOrder(request) {
        counts.createOrder += 1;
        return privateBase.createOrder(request);
      },
      async cancelOrder(query) {
        counts.cancelOrder += 1;
        return privateBase.cancelOrder(query);
      },
      async getOrder(query) {
        counts.getOrder += 1;
        return privateBase.getOrder(query);
      },
      async listOpenOrders(query) {
        counts.listOpenOrders += 1;
        void query;
        return privateBase.listOpenOrders();
      },
      async listClosedOrders(query) {
        counts.listClosedOrders += 1;
        void query;
        return privateBase.listClosedOrders();
      },
    },
    publicMarketDataReader: {
      async getTickers(markets) {
        counts.getTickers += 1;
        return publicBase.getTickers(markets);
      },
      async getMinuteCandles(request) {
        counts.getMinuteCandles += 1;
        return publicBase.getMinuteCandles(request);
      },
      async getDayCandles(request) {
        counts.getDayCandles += 1;
        return publicBase.getDayCandles(request);
      },
    },
  };
}
