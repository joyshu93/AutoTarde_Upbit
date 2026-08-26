import assert from "node:assert/strict";

import type { PositionGuardPolicySelection } from "../src/domain/pilot-types.js";
import type { ExchangeBalance, ExecutionStateRecord } from "../src/domain/types.js";
import type { RuntimeOwnershipAuthority } from "../src/app/runtime-ownership-guard.js";
import {
  derivePositionGuardPilotDeploymentId,
  PositionGuardPilotInitializer,
} from "../src/app/position-guard-pilot-initializer.js";
import { PositionGuardPilotRecovery } from "../src/app/position-guard-pilot-recovery.js";
import { InMemoryAccountExecutionLeaseStore } from
  "../src/modules/db/repositories/in-memory-account-execution-lease-store.js";
import { InMemoryCandidatePilotRepository } from
  "../src/modules/db/repositories/in-memory-candidate-pilot-repository.js";
import {
  InMemoryExecutionRepository,
  InMemoryOperatorStateStore,
} from "../src/modules/db/repositories/in-memory-repositories.js";
import { CandidateExecutionEvidenceService } from
  "../src/modules/execution/candidate-evidence-service.js";
import { ExecutionService as ProductionExecutionService } from "../src/modules/execution/execution-service.js";
import type { CandidateExecutionAuthority } from "../src/modules/execution/interfaces.js";
import type {
  CancelOrderResult,
  ExchangeOrderSnapshot,
  LiveExecutionAdapter,
  OrderValidationResult,
  UpbitOrderChance,
  UpbitOrderRequest,
} from "../src/modules/exchange/interfaces.js";
import { ExchangeOrderSubmissionError } from "../src/modules/exchange/errors.js";
import { ReconciliationService as ProductionReconciliationService } from
  "../src/modules/reconciliation/reconciliation-service.js";
import { createEmptyPositionGuardCandidateState } from
  "../src/modules/strategy/position-guard-candidate-state.js";
import {
  createDefaultPositionGuardRunnerConfig,
  PositionGuardStrategyRunner as ProductionPositionGuardStrategyRunner,
} from "../src/modules/strategy/position-guard-runner.js";
import {
  toStrategyDecision,
  type PositionGuardStrategyContext,
} from "../src/modules/strategy/position-guard-core.js";
import { routePositionGuardPolicy } from "../src/modules/strategy/position-guard-policy-router.js";
import type {
  PositionGuardEngineDecision,
  PositionGuardStructureAnalysis,
} from "../src/modules/strategy/position-guard-core.js";
import { test } from "./harness.js";

class ExecutionService extends ProductionExecutionService {
  constructor(dependencies: ConstructorParameters<typeof ProductionExecutionService>[0]) {
    super({
      ...dependencies,
      runtimeOwnership: dependencies.runtimeOwnership ??
        createAlwaysOwnedRuntimeOwnershipAuthority(dependencies.operatorState),
    });
  }
}

class ReconciliationService extends ProductionReconciliationService {
  constructor(dependencies: ConstructorParameters<typeof ProductionReconciliationService>[0]) {
    super({
      ...dependencies,
      runtimeOwnership: dependencies.runtimeOwnership ?? createAlwaysOwnedRuntimeOwnershipAuthority(),
    });
  }
}

class PositionGuardStrategyRunner extends ProductionPositionGuardStrategyRunner {
  constructor(dependencies: ConstructorParameters<typeof ProductionPositionGuardStrategyRunner>[0]) {
    super({
      ...dependencies,
      runtimeOwnership: dependencies.runtimeOwnership ?? createAlwaysOwnedRuntimeOwnershipAuthority(),
    });
  }
}

const ACCOUNT_ID = "primary";
const PILOT_IDENTITY = {
  exchangeAccountId: ACCOUNT_ID,
  pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1" as const,
  market: "KRW-BTC" as const,
  policyId: "COMBINED_CONSERVATIVE" as const,
  policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1" as const,
};
const DEPLOYMENT_ID = derivePositionGuardPilotDeploymentId(PILOT_IDENTITY);
const CREATED_AT = "2026-08-21T00:00:00.000Z";
const SNAPSHOT_AT = "2026-08-21T00:00:30.000Z";
const RECONCILIATION_COMPLETED_AT = "2026-08-21T00:00:31.000Z";
const NOW = "2026-08-21T00:00:40.000Z";

function createAlwaysOwnedRuntimeOwnershipAuthority(
  operatorState?: Pick<InMemoryOperatorStateStore, "getState">,
): RuntimeOwnershipAuthority {
  const record = {
    ownerToken: "owner".padEnd(64, "x"),
    generation: 1,
    executionMode: "DRY_RUN" as const,
    acquiredAtEpochMs: 1,
    heartbeatAtEpochMs: 1,
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  };
  return {
    snapshot: () => ({
      status: "OWNED",
      generation: record.generation,
      executionMode: record.executionMode,
      acquiredAtEpochMs: record.acquiredAtEpochMs,
      heartbeatAtEpochMs: record.heartbeatAtEpochMs,
      expiresAtEpochMs: record.expiresAtEpochMs,
      takeover: false,
      lossReason: null,
    }),
    assertLocallyHeld() {},
    async assertCurrent() {
      return { ...record };
    },
    async assertCurrentExecutionAuthority(input) {
      const state = operatorState === undefined
        ? {
            exchangeAccountId: input.exchangeAccountId,
            executionMode: input.expectedExecutionMode,
            liveExecutionGate: input.expectedLiveExecutionGate,
            systemStatus: "RUNNING" as const,
            killSwitchActive: false,
          }
        : await operatorState.getState();
      return {
        runtimeOwnership: { ...record },
        executionState: {
          exchangeAccountId: state.exchangeAccountId,
          executionMode: state.executionMode,
          liveExecutionGate: state.liveExecutionGate,
          systemStatus: state.systemStatus,
          killSwitchActive: state.killSwitchActive,
        },
      };
    },
  };
}

test("pending-flat suppresses new BTC risk until fake exchange-backed flat recovery activates", async () => {
  const operatorState = new InMemoryOperatorStateStore(executionState());
  const repositories = new InMemoryExecutionRepository(operatorState);
  const candidatePilots = new InMemoryCandidatePilotRepository(operatorState);
  await candidatePilots.createDeploymentWithInitialState({
    deployment: {
      id: DEPLOYMENT_ID,
      exchangeAccountId: ACCOUNT_ID,
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      phase: "PENDING_FLAT",
      activationAt: null,
      activationEpochNs: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    initialState: createEmptyPositionGuardCandidateState(),
  });

  const pendingRoute = routePositionGuardPolicy({
    market: "KRW-BTC",
    generatedAt: SNAPSHOT_AT,
    baselineDecision: decision("ENTER"),
    selection: candidateSelection(),
    pilotPhase: "PENDING_FLAT",
    candidateState: createEmptyPositionGuardCandidateState(),
    positionQuantity: 0,
    averageEntryPrice: 0,
    analysis: structureAnalysis(),
  });
  assert.equal(pendingRoute.effectiveDecision.action, "HOLD");
  assert.equal(pendingRoute.reasonCode, "PENDING_FLAT_NEW_RISK_SUPPRESSED");

  await repositories.saveBalanceSnapshot({
    id: "lifecycle-balance",
    exchangeAccountId: ACCOUNT_ID,
    capturedAt: SNAPSHOT_AT,
    source: "RECONCILIATION",
    totalKrwValue: "100000",
    balancesJson: JSON.stringify([
      { currency: "KRW", balance: "100000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
      { currency: "BTC", balance: "0", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
    ]),
  });
  await repositories.savePositionSnapshot({
    id: "lifecycle-position",
    exchangeAccountId: ACCOUNT_ID,
    capturedAt: SNAPSHOT_AT,
    source: "RECONCILIATION",
    positionsJson: JSON.stringify([{
      asset: "BTC",
      market: "KRW-BTC",
      quantity: "0",
      averageEntryPrice: null,
      markPrice: null,
      marketValue: null,
      exposureRatio: null,
      capturedAt: SNAPSHOT_AT,
    }]),
  });
  await repositories.saveReconciliationRun({
    id: "lifecycle-reconciliation",
    exchangeAccountId: ACCOUNT_ID,
    status: "SUCCESS",
    startedAt: SNAPSHOT_AT,
    completedAt: RECONCILIATION_COMPLETED_AT,
    summaryJson: JSON.stringify({
      source: "SCHEDULER_PREFLIGHT",
      status: "SUCCESS",
      issues: [],
      candidateCount: 0,
      processedCount: 0,
      deferredCount: 0,
      maxOrderLookupsPerRun: 10,
    }),
    errorMessage: null,
  });

  const recovery = new PositionGuardPilotRecovery({
    exchangeAccountId: ACCOUNT_ID,
    target: { kind: "EXACT_DEPLOYMENT", deploymentId: DEPLOYMENT_ID },
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    freshnessThresholdMs: 60_000,
    minimumAbsenceObservations: 2,
    minimumAbsenceElapsedMs: 5_000,
    clock: {
      now: () => ({ occurredAt: NOW, occurredAtEpochMs: Date.parse(NOW) }),
    },
    repositories,
    candidatePilots,
    operatorState,
  });
  const result = await recovery.verifyAndPrepareBtcRun({
    exchangeAccountId: ACCOUNT_ID,
    requestedAt: SNAPSHOT_AT,
    balanceSnapshotId: "lifecycle-balance",
    balanceCapturedAt: SNAPSHOT_AT,
    positionSnapshotId: "lifecycle-position",
    positionCapturedAt: SNAPSHOT_AT,
    reconciliationRunId: "lifecycle-reconciliation",
    reconciliationStartedAt: SNAPSHOT_AT,
    reconciliationCompletedAt: RECONCILIATION_COMPLETED_AT,
    reconciliationSource: "SCHEDULER_PREFLIGHT",
  });

  assert.equal(result.status, "READY");
  if (result.status !== "READY") throw new Error("Expected fake flat recovery to return READY.");
  assert.equal(result.phase, "ACTIVE");
  assert.equal(result.deployment.phase, "ACTIVE");
  assert.equal((await candidatePilots.listAuditEvents(DEPLOYMENT_ID)).at(-1)?.eventType, "PHASE_TRANSITION");
});

test("real runner binds DRAINING EXIT through projection, restart replay, and flat completion", async () => {
  const operatorState = new InMemoryOperatorStateStore(executionState("LIVE"));
  const candidatePilots = new InMemoryCandidatePilotRepository(operatorState);
  const repositories = new InMemoryExecutionRepository(operatorState, candidatePilots);
  await candidatePilots.createDeploymentWithInitialState({
    deployment: {
      id: DEPLOYMENT_ID,
      ...PILOT_IDENTITY,
      phase: "PENDING_FLAT",
      activationAt: null,
      activationEpochNs: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    initialState: createEmptyPositionGuardCandidateState(),
  });
  const activationAt = "2026-08-21T00:00:05.000Z";
  const activated = await candidatePilots.activateDeployment({
    deploymentId: DEPLOYMENT_ID,
    expectedPhase: "PENDING_FLAT",
    expectedUpdatedAt: CREATED_AT,
    activationAt,
    activationEpochNs: BigInt(Date.parse(activationAt)) * 1_000_000n,
  });
  assert.ok(activated);
  await candidatePilots.advanceStateWithEvidence({
    deploymentId: DEPLOYMENT_ID,
    expectedStateVersion: 0,
    evidence: {
      evidenceId: "draining-seed-enter",
      executedAt: "2026-08-21T00:00:06.000Z",
      action: "ENTER",
      entryPath: "PULLBACK",
      terminalStatus: "FILLED",
      executedQuantity: "0.1",
      grossQuoteValueKrw: "10000000",
      confirmedFeeKrw: "5000",
      remainingQuantity: "0.1",
    },
  });
  const paused = await operatorState.pause("operator_requested_candidate_rollback");
  const rollbackAt = "2026-08-21T00:00:08.000Z";
  const draining = await candidatePilots.startRollback({
    deploymentId: DEPLOYMENT_ID,
    expectedPhase: "ACTIVE",
    expectedUpdatedAt: activationAt,
    expectedStateVersion: 1,
    expectedOperatorState: {
      id: paused.id,
      exchangeAccountId: paused.exchangeAccountId,
      systemStatus: "PAUSED",
      updatedAt: paused.updatedAt,
    },
    transitionAt: rollbackAt,
    transitionEpochNs: BigInt(Date.parse(rollbackAt)) * 1_000_000n,
  });
  assert.equal(draining?.phase, "DRAINING");
  await operatorState.resume();

  await repositories.saveBalanceSnapshot({
    id: "draining-runner-balance",
    exchangeAccountId: ACCOUNT_ID,
    capturedAt: "2026-08-21T00:00:09.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "11000000",
    balancesJson: JSON.stringify([
      { currency: "KRW", balance: "1000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
      { currency: "BTC", balance: "0.1", locked: "0", avgBuyPrice: "100000000", unitCurrency: "KRW" },
    ]),
  });
  await repositories.savePositionSnapshot({
    id: "draining-runner-position",
    exchangeAccountId: ACCOUNT_ID,
    capturedAt: "2026-08-21T00:00:09.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: JSON.stringify([{
      asset: "BTC",
      market: "KRW-BTC",
      quantity: "0.1",
      averageEntryPrice: "100000000",
      markPrice: "100000000",
      marketValue: "10000000",
      exposureRatio: "0.9090909090909091",
      capturedAt: "2026-08-21T00:00:09.000Z",
    }]),
  });

  const adapter = new ImmediateDrainingExitLiveAdapter();
  const executionService = executionServiceFor({
    adapter,
    repositories,
    operatorState,
    candidatePilots,
    now: "2026-08-21T00:00:20.000Z",
  });
  const refreshReceipt = {
    exchangeAccountId: ACCOUNT_ID,
    requestedAt: "2026-08-21T00:00:09.000Z",
    balanceSnapshotId: "draining-runner-balance",
    balanceCapturedAt: "2026-08-21T00:00:09.000Z",
    positionSnapshotId: "draining-runner-position",
    positionCapturedAt: "2026-08-21T00:00:09.000Z",
    reconciliationRunId: "draining-runner-reconciliation",
    reconciliationStartedAt: "2026-08-21T00:00:09.000Z",
    reconciliationCompletedAt: "2026-08-21T00:00:10.000Z",
    reconciliationSource: "SCHEDULER_PREFLIGHT" as const,
  };
  const exactState = await candidatePilots.getExactState(DEPLOYMENT_ID);
  assert.ok(exactState);
  const runner = new PositionGuardStrategyRunner({
    repositories,
    executionService,
    marketDataReader: {} as never,
    config: createDefaultPositionGuardRunnerConfig(ACCOUNT_ID),
    policySelection: candidateSelection(),
    candidateRunVerifier: {
      async verifyAndPrepareBtcRun() {
        return {
          status: "READY" as const,
          verificationOnly: true as const,
          deployment: draining!,
          phase: "DRAINING" as const,
          activation: {
            activationAt,
            activationEpochNs: BigInt(Date.parse(activationAt)) * 1_000_000n,
          },
          state: exactState!,
          stateVersion: exactState!.stateVersion,
          refreshProvenance: refreshReceipt,
        };
      },
    },
  });
  const generatedAt = "2026-08-21T00:00:10.000Z";
  const exitDecision = decision("EXIT");
  const context = drainingOpenContext(generatedAt);
  Object.defineProperty(runner, "buildDecision", {
    value: async () => ({
      strategyDecision: toStrategyDecision(context, exitDecision),
      engineDecision: exitDecision,
      context,
      referencePriceCapturedAt: generatedAt,
    }),
  });

  const run = await runner.runOnce({ market: "KRW-BTC", generatedAt, refreshReceipt });
  assert.equal(run.submission?.accepted, true);
  assert.equal(run.submission?.order.status, "FILLED");
  const binding = await candidatePilots.getExecutionBindingForOrder(run.submission!.order.id);
  assert.equal(binding?.deploymentId, DEPLOYMENT_ID);
  assert.equal(binding?.action, "EXIT");
  assert.equal(binding?.boundVolume, "0.1");

  const evidenceService = new CandidateExecutionEvidenceService({
    exchangeAccountId: ACCOUNT_ID,
    repositories,
    pilotRepository: candidatePilots,
    operatorState,
    clock: {
      now: () => ({
        occurredAt: "2026-08-21T00:00:23.000Z",
        occurredAtEpochMs: Date.parse("2026-08-21T00:00:23.000Z"),
      }),
    },
  });
  const projection = await evidenceService.processTerminalOrder(run.submission!.order.id);
  assert.equal(projection.outcome, "ADVANCED", projection.detail);
  assert.equal((await candidatePilots.getExactState(DEPLOYMENT_ID))?.currentEpisodeInventoryQuantity, "0");

  const initializer = new PositionGuardPilotInitializer({
    identity: PILOT_IDENTITY,
    repository: {
      initializeDeploymentWithInitialState: (request) =>
        candidatePilots.initializeDeploymentWithInitialState(request),
    },
    clock: { now: () => "2026-08-21T00:00:30.000Z" },
  });
  const reconstructed = await initializer.initialize();
  assert.equal(reconstructed.deployment.phase, "DRAINING");
  assert.equal(reconstructed.exactState.currentEpisodeInventoryQuantity, "0");

  const completionPause = await operatorState.pause("operator_confirmed_flat_completion");
  const completedAt = "2026-08-21T00:00:31.000Z";
  const disabled = await candidatePilots.completeRollback({
    deploymentId: DEPLOYMENT_ID,
    expectedPhase: "DRAINING",
    expectedUpdatedAt: rollbackAt,
    expectedStateVersion: 2,
    expectedOperatorState: {
      id: completionPause.id,
      exchangeAccountId: completionPause.exchangeAccountId,
      systemStatus: "PAUSED",
      updatedAt: completionPause.updatedAt,
    },
    transitionAt: completedAt,
    transitionEpochNs: BigInt(Date.parse(completedAt)) * 1_000_000n,
  });
  assert.equal(disabled?.phase, "DISABLED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal(adapter.createOrderCalls, 1);
});

test("fake validation and one send normalize cancel-with-fill and persist evidence exactly once across restart", async () => {
  const operatorState = new InMemoryOperatorStateStore(executionState("LIVE"));
  const candidatePilots = new InMemoryCandidatePilotRepository(operatorState);
  const repositories = new InMemoryExecutionRepository(operatorState, candidatePilots);
  await candidatePilots.createDeploymentWithInitialState({
    deployment: {
      id: DEPLOYMENT_ID,
      exchangeAccountId: ACCOUNT_ID,
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      phase: "PENDING_FLAT",
      activationAt: null,
      activationEpochNs: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    initialState: createEmptyPositionGuardCandidateState(),
  });
  const activationAt = "2026-08-21T00:00:05.000Z";
  const activated = await candidatePilots.activateDeployment({
    deploymentId: DEPLOYMENT_ID,
    expectedPhase: "PENDING_FLAT",
    expectedUpdatedAt: CREATED_AT,
    activationAt,
    activationEpochNs: BigInt(Date.parse(activationAt)) * 1_000_000n,
  });
  assert.notEqual(activated, null);

  await repositories.saveStrategyDecision({
    id: "lifecycle-decision",
    exchangeAccountId: ACCOUNT_ID,
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "ENTER",
    status: "READY",
    decisionBasisJson: JSON.stringify({
      strategyDecision: { market: "KRW-BTC", action: "ENTER" },
      engineDecision: { entryPath: "PULLBACK" },
    }),
    intendedNotionalKrw: "6000",
    intendedQuantity: null,
    referencePrice: "100000000",
    createdAt: "2026-08-21T00:00:09.000Z",
  });
  await repositories.saveBalanceSnapshot({
    id: "execution-balance",
    exchangeAccountId: ACCOUNT_ID,
    capturedAt: "2026-08-21T00:00:08.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "100000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "execution-position",
    exchangeAccountId: ACCOUNT_ID,
    capturedAt: "2026-08-21T00:00:08.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });

  const adapter = new ImmediateCancelWithFillLiveAdapter();
  const executionService = new ExecutionService({
    riskLimits: {
      maxAllocationByAsset: { BTC: 0.6, ETH: 0.6 },
      totalExposureCap: 0.75,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    executionAdapter: adapter,
    validationAdapter: adapter,
    repositories,
    accountExecutionLeases: new InMemoryAccountExecutionLeaseStore(),
    accountExecutionLeaseMs: 30_000,
    operatorState,
    candidatePilots,
    now: () => "2026-08-21T00:00:20.000Z",
  });
  const input = {
    exchangeAccountId: ACCOUNT_ID,
    strategyDecisionId: "lifecycle-decision",
    referencePriceCapturedAt: "2026-08-21T00:00:10.000Z",
    decision: {
      strategyKey: "position_guard.paper_core.v1",
      market: "KRW-BTC" as const,
      action: "ENTER" as const,
      reasonCodes: ["CANDIDATE_ALLOWED"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 6_000,
      requestedQuantity: null,
      metadata: {},
    },
    side: "bid" as const,
    ordType: "price" as const,
    price: "6000",
    volume: null,
    candidateAuthority: candidateAuthority(activationAt),
  };
  const result = await executionService.submitOrderFromDecision(input);

  assert.equal(result.accepted, true);
  assert.equal(result.outcome, "SUBMITTED");
  assert.equal(result.order.status, "FILLED");
  assert.deepEqual(
    [adapter.orderChanceCalls, adapter.orderTestCalls, adapter.createOrderCalls],
    [1, 1, 1],
  );
  assert.equal((await repositories.listFills(result.order.id)).length, 2);

  const stateBeforeExecutionRestart = await candidatePilots.getExactState(DEPLOYMENT_ID);
  const evidenceBeforeExecutionRestart = await candidatePilots.listEvidenceAfter(DEPLOYMENT_ID, null);
  const auditBeforeExecutionRestart = await candidatePilots.listAuditEvents(DEPLOYMENT_ID);
  const restartedExecutionService = new ExecutionService({
    riskLimits: {
      maxAllocationByAsset: { BTC: 0.6, ETH: 0.6 },
      totalExposureCap: 0.75,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    executionAdapter: adapter,
    validationAdapter: adapter,
    repositories,
    accountExecutionLeases: new InMemoryAccountExecutionLeaseStore(),
    accountExecutionLeaseMs: 30_000,
    operatorState,
    candidatePilots,
    now: () => "2026-08-21T00:00:21.000Z",
  });
  const restartDuplicate = await restartedExecutionService.submitOrderFromDecision(input);

  assert.equal(restartDuplicate.outcome, "DUPLICATE");
  assert.equal(restartDuplicate.order?.id, result.order.id);
  assert.equal(adapter.createOrderCalls, 1);
  assert.deepEqual(await candidatePilots.getExactState(DEPLOYMENT_ID), stateBeforeExecutionRestart);
  assert.deepEqual(
    await candidatePilots.listEvidenceAfter(DEPLOYMENT_ID, null),
    evidenceBeforeExecutionRestart,
  );
  assert.deepEqual(await candidatePilots.listAuditEvents(DEPLOYMENT_ID), auditBeforeExecutionRestart);

  const evidenceService = new CandidateExecutionEvidenceService({
    exchangeAccountId: ACCOUNT_ID,
    repositories,
    pilotRepository: candidatePilots,
    operatorState,
    clock: {
      now: () => ({
        occurredAt: "2026-08-21T00:00:23.000Z",
        occurredAtEpochMs: Date.parse("2026-08-21T00:00:23.000Z"),
      }),
    },
  });
  const firstProjection = await evidenceService.processTerminalOrder(result.order.id);
  const stateAfterFirstProjection = await candidatePilots.getExactState(DEPLOYMENT_ID);
  const evidenceAfterFirstProjection = await candidatePilots.listEvidenceAfter(DEPLOYMENT_ID, null);
  const evidenceRecordsAfterFirstProjection = await candidatePilots.listEvidenceRecords(DEPLOYMENT_ID);
  const auditAfterFirstProjection = await candidatePilots.listAuditEvents(DEPLOYMENT_ID);
  const restartedEvidenceService = new CandidateExecutionEvidenceService({
    exchangeAccountId: ACCOUNT_ID,
    repositories,
    pilotRepository: candidatePilots,
    operatorState,
    clock: {
      now: () => ({
        occurredAt: "2026-08-21T00:00:24.000Z",
        occurredAtEpochMs: Date.parse("2026-08-21T00:00:24.000Z"),
      }),
    },
  });
  const duplicateProjection = await restartedEvidenceService.processTerminalOrder(result.order.id);
  const evidence = await candidatePilots.listEvidenceAfter(DEPLOYMENT_ID, null);
  const exactState = await candidatePilots.getExactState(DEPLOYMENT_ID);

  assert.equal(firstProjection.outcome, "ADVANCED", firstProjection.detail);
  assert.equal(duplicateProjection.outcome, "DUPLICATE");
  assert.deepEqual(await candidatePilots.getExactState(DEPLOYMENT_ID), stateAfterFirstProjection);
  assert.deepEqual(
    await candidatePilots.listEvidenceAfter(DEPLOYMENT_ID, null),
    evidenceAfterFirstProjection,
  );
  assert.deepEqual(await candidatePilots.listAuditEvents(DEPLOYMENT_ID), auditAfterFirstProjection);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.executedQuantity, "0.00006");
  assert.equal(evidence[0]?.grossQuoteValueKrw, "6000");
  assert.equal(evidence[0]?.confirmedFeeKrw, "3");
  assert.equal(exactState?.stateVersion, 1);
  assert.equal(exactState?.currentEpisodeInventoryQuantity, "0.00006");

  const initializer = new PositionGuardPilotInitializer({
    identity: {
      exchangeAccountId: ACCOUNT_ID,
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    },
    repository: {
      initializeDeploymentWithInitialState: (input) =>
        candidatePilots.initializeDeploymentWithInitialState(input),
    },
    clock: { now: () => "2026-08-21T00:00:30.000Z" },
  });
  const auditBeforeInitializer = await candidatePilots.listAuditEvents(DEPLOYMENT_ID);
  const reconstructed = await initializer.initialize();
  assert.equal(reconstructed.deployment.phase, "ACTIVE");
  assert.deepEqual(reconstructed.exactState, stateAfterFirstProjection);
  assert.deepEqual(reconstructed.evidenceRecords, evidenceRecordsAfterFirstProjection);
  assert.deepEqual(await candidatePilots.listAuditEvents(DEPLOYMENT_ID), auditBeforeInitializer);
});

test("staged partial fills reconcile once before terminal cancel-with-fill advances candidate state", async () => {
  const operatorState = new InMemoryOperatorStateStore(executionState("LIVE"));
  const candidatePilots = new InMemoryCandidatePilotRepository(operatorState);
  const repositories = new InMemoryExecutionRepository(operatorState, candidatePilots);
  await candidatePilots.createDeploymentWithInitialState({
    deployment: {
      id: DEPLOYMENT_ID,
      exchangeAccountId: ACCOUNT_ID,
      pilotId: PILOT_IDENTITY.pilotId,
      market: PILOT_IDENTITY.market,
      policyId: PILOT_IDENTITY.policyId,
      policyVersion: PILOT_IDENTITY.policyVersion,
      phase: "PENDING_FLAT",
      activationAt: null,
      activationEpochNs: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    initialState: createEmptyPositionGuardCandidateState(),
  });
  const activationAt = "2026-08-21T00:00:05.000Z";
  assert.notEqual(await candidatePilots.activateDeployment({
    deploymentId: DEPLOYMENT_ID,
    expectedPhase: "PENDING_FLAT",
    expectedUpdatedAt: CREATED_AT,
    activationAt,
    activationEpochNs: BigInt(Date.parse(activationAt)) * 1_000_000n,
  }), null);
  await repositories.saveStrategyDecision({
    id: "staged-lifecycle-decision",
    exchangeAccountId: ACCOUNT_ID,
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "ENTER",
    status: "READY",
    decisionBasisJson: JSON.stringify({
      strategyDecision: { market: "KRW-BTC", action: "ENTER" },
      engineDecision: { entryPath: "PULLBACK" },
    }),
    intendedNotionalKrw: "6000",
    intendedQuantity: null,
    referencePrice: "100000000",
    createdAt: "2026-08-21T00:00:09.000Z",
  });
  await repositories.saveBalanceSnapshot({
    id: "staged-execution-balance",
    exchangeAccountId: ACCOUNT_ID,
    capturedAt: "2026-08-21T00:00:08.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "100000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "staged-execution-position",
    exchangeAccountId: ACCOUNT_ID,
    capturedAt: "2026-08-21T00:00:08.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });

  const adapter = new StagedPartialFillLiveAdapter();
  const executionService = executionServiceFor({
    adapter,
    repositories,
    operatorState,
    candidatePilots,
    now: "2026-08-21T00:00:20.000Z",
  });
  const input = candidateEnterInput("staged-lifecycle-decision", activationAt);
  const submitted = await executionService.submitOrderFromDecision(input);
  assert.equal(submitted.outcome, "SUBMITTED");
  assert.equal(submitted.order?.status, "OPEN");
  assert.equal(adapter.createOrderCalls, 1);
  assert.equal((await repositories.listFills(submitted.order!.id)).length, 0);

  const evidenceService = new CandidateExecutionEvidenceService({
    exchangeAccountId: ACCOUNT_ID,
    repositories,
    pilotRepository: candidatePilots,
    operatorState,
    clock: {
      now: () => ({
        occurredAt: "2026-08-21T00:00:30.000Z",
        occurredAtEpochMs: Date.parse("2026-08-21T00:00:30.000Z"),
      }),
    },
  });
  const reconciliation = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: adapter,
    candidateEvidenceService: evidenceService,
  });
  const runReconciliation = (sequence: number) => reconciliation.run(ACCOUNT_ID, {
    source: "SCHEDULER_PREFLIGHT",
    runIdentity: {
      id: `staged-reconciliation-${sequence}`,
      startedAt: `2026-08-21T00:00:${String(20 + sequence).padStart(2, "0")}.000Z`,
    },
  });

  await runReconciliation(1);
  assert.equal((await repositories.findOrderById(ACCOUNT_ID, submitted.order!.id))?.status, "PARTIALLY_FILLED");
  assert.equal((await repositories.listFills(submitted.order!.id)).length, 1);
  const stateAfterFirstPartial = await candidatePilots.getExactState(DEPLOYMENT_ID);
  const evidenceAfterFirstPartial = await candidatePilots.listEvidenceAfter(DEPLOYMENT_ID, null);
  const auditAfterFirstPartial = await candidatePilots.listAuditEvents(DEPLOYMENT_ID);

  await runReconciliation(2);
  assert.equal((await repositories.listFills(submitted.order!.id)).length, 1);
  assert.deepEqual(await candidatePilots.getExactState(DEPLOYMENT_ID), stateAfterFirstPartial);
  assert.deepEqual(await candidatePilots.listEvidenceAfter(DEPLOYMENT_ID, null), evidenceAfterFirstPartial);
  assert.deepEqual(await candidatePilots.listAuditEvents(DEPLOYMENT_ID), auditAfterFirstPartial);

  await runReconciliation(3);
  assert.equal((await repositories.findOrderById(ACCOUNT_ID, submitted.order!.id))?.status, "PARTIALLY_FILLED");
  assert.equal((await repositories.listFills(submitted.order!.id)).length, 2);
  assert.deepEqual(await candidatePilots.getExactState(DEPLOYMENT_ID), stateAfterFirstPartial);
  assert.deepEqual(await candidatePilots.listEvidenceAfter(DEPLOYMENT_ID, null), evidenceAfterFirstPartial);

  await runReconciliation(4);
  assert.equal((await repositories.findOrderById(ACCOUNT_ID, submitted.order!.id))?.status, "FILLED");
  assert.equal((await repositories.listFills(submitted.order!.id)).length, 2);
  const terminalEvidence = await candidatePilots.listEvidenceAfter(DEPLOYMENT_ID, null);
  const terminalState = await candidatePilots.getExactState(DEPLOYMENT_ID);
  assert.equal(terminalEvidence.length, 1);
  assert.equal(terminalEvidence[0]?.executedQuantity, "0.00006");
  assert.equal(terminalState?.stateVersion, 1);
  assert.equal(terminalState?.currentEpisodeInventoryQuantity, "0.00006");

  const getOrderCallsBeforeTerminalReplay = adapter.getOrderCalls;
  const terminalAudit = await candidatePilots.listAuditEvents(DEPLOYMENT_ID);
  await runReconciliation(5);
  assert.equal(adapter.getOrderCalls, getOrderCallsBeforeTerminalReplay);
  assert.deepEqual(await candidatePilots.getExactState(DEPLOYMENT_ID), terminalState);
  assert.deepEqual(await candidatePilots.listEvidenceAfter(DEPLOYMENT_ID, null), terminalEvidence);
  assert.deepEqual(await candidatePilots.listAuditEvents(DEPLOYMENT_ID), terminalAudit);
});

test("uncertain fake send pauses globally and reconstructs a faulted pilot without retry or auto-resume", async () => {
  const operatorState = new InMemoryOperatorStateStore(executionState("LIVE"));
  const candidatePilots = new InMemoryCandidatePilotRepository(operatorState);
  const repositories = new InMemoryExecutionRepository(operatorState, candidatePilots);
  await candidatePilots.createDeploymentWithInitialState({
    deployment: {
      id: DEPLOYMENT_ID,
      exchangeAccountId: ACCOUNT_ID,
      pilotId: PILOT_IDENTITY.pilotId,
      market: PILOT_IDENTITY.market,
      policyId: PILOT_IDENTITY.policyId,
      policyVersion: PILOT_IDENTITY.policyVersion,
      phase: "PENDING_FLAT",
      activationAt: null,
      activationEpochNs: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    initialState: createEmptyPositionGuardCandidateState(),
  });
  const activationAt = "2026-08-21T00:00:05.000Z";
  const activated = await candidatePilots.activateDeployment({
    deploymentId: DEPLOYMENT_ID,
    expectedPhase: "PENDING_FLAT",
    expectedUpdatedAt: CREATED_AT,
    activationAt,
    activationEpochNs: BigInt(Date.parse(activationAt)) * 1_000_000n,
  });
  assert.notEqual(activated, null);

  await repositories.saveStrategyDecision({
    id: "uncertain-lifecycle-decision",
    exchangeAccountId: ACCOUNT_ID,
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "ENTER",
    status: "READY",
    decisionBasisJson: JSON.stringify({
      strategyDecision: { market: "KRW-BTC", action: "ENTER" },
      engineDecision: { entryPath: "PULLBACK" },
    }),
    intendedNotionalKrw: "6000",
    intendedQuantity: null,
    referencePrice: "100000000",
    createdAt: "2026-08-21T00:00:09.000Z",
  });
  await repositories.saveBalanceSnapshot({
    id: "uncertain-balance",
    exchangeAccountId: ACCOUNT_ID,
    capturedAt: "2026-08-21T00:00:08.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "100000",
    balancesJson: JSON.stringify([
      { currency: "KRW", balance: "100000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
      { currency: "BTC", balance: "0", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
    ]),
  });
  await repositories.savePositionSnapshot({
    id: "uncertain-position",
    exchangeAccountId: ACCOUNT_ID,
    capturedAt: "2026-08-21T00:00:08.000Z",
    source: "RECONCILIATION",
    positionsJson: JSON.stringify([{
      asset: "BTC",
      market: "KRW-BTC",
      quantity: "0",
      averageEntryPrice: null,
      markPrice: null,
      marketValue: null,
      exposureRatio: null,
      capturedAt: "2026-08-21T00:00:08.000Z",
    }]),
  });
  await repositories.saveReconciliationRun({
    id: "uncertain-reconciliation",
    exchangeAccountId: ACCOUNT_ID,
    status: "SUCCESS",
    startedAt: "2026-08-21T00:00:10.000Z",
    completedAt: "2026-08-21T00:00:11.000Z",
    summaryJson: JSON.stringify({
      source: "SCHEDULER_PREFLIGHT",
      status: "SUCCESS",
      issues: [],
      candidateCount: 0,
      processedCount: 0,
      deferredCount: 0,
      maxOrderLookupsPerRun: 10,
    }),
    errorMessage: null,
  });

  const adapter = new UncertainSubmissionAdapter();
  const executionService = new ExecutionService({
    riskLimits: {
      maxAllocationByAsset: { BTC: 0.6, ETH: 0.6 },
      totalExposureCap: 0.75,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    executionAdapter: adapter,
    validationAdapter: adapter,
    repositories,
    accountExecutionLeases: new InMemoryAccountExecutionLeaseStore(),
    accountExecutionLeaseMs: 30_000,
    operatorState,
    candidatePilots,
    now: () => "2026-08-21T00:00:20.000Z",
  });
  const input = {
    exchangeAccountId: ACCOUNT_ID,
    strategyDecisionId: "uncertain-lifecycle-decision",
    referencePriceCapturedAt: "2026-08-21T00:00:10.000Z",
    decision: {
      strategyKey: "position_guard.paper_core.v1",
      market: "KRW-BTC" as const,
      action: "ENTER" as const,
      reasonCodes: ["CANDIDATE_ALLOWED"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 6_000,
      requestedQuantity: null,
      metadata: {},
    },
    side: "bid" as const,
    ordType: "price" as const,
    price: "6000",
    volume: null,
    candidateAuthority: candidateAuthority(activationAt),
  };
  const uncertain = await executionService.submitOrderFromDecision(input);

  assert.equal(uncertain.outcome, "RECONCILIATION_REQUIRED");
  assert.equal(uncertain.order?.status, "RECONCILIATION_REQUIRED");
  assert.equal(adapter.createOrderCalls, 1);
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase, "ACTIVE");

  const stateBeforeRestart = await candidatePilots.getExactState(DEPLOYMENT_ID);
  const evidenceBeforeRestart = await candidatePilots.listEvidenceAfter(DEPLOYMENT_ID, null);
  const auditBeforeRestart = await candidatePilots.listAuditEvents(DEPLOYMENT_ID);
  const restartedExecutionService = new ExecutionService({
    riskLimits: {
      maxAllocationByAsset: { BTC: 0.6, ETH: 0.6 },
      totalExposureCap: 0.75,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    executionAdapter: adapter,
    validationAdapter: adapter,
    repositories,
    accountExecutionLeases: new InMemoryAccountExecutionLeaseStore(),
    accountExecutionLeaseMs: 30_000,
    operatorState,
    candidatePilots,
    now: () => "2026-08-21T00:00:21.000Z",
  });
  const duplicateAttempt = await restartedExecutionService.submitOrderFromDecision(input);

  assert.equal(duplicateAttempt.outcome, "DUPLICATE");
  assert.equal(duplicateAttempt.order?.id, uncertain.order?.id);
  assert.equal(adapter.createOrderCalls, 1);
  assert.deepEqual(await candidatePilots.getExactState(DEPLOYMENT_ID), stateBeforeRestart);
  assert.deepEqual(await candidatePilots.listEvidenceAfter(DEPLOYMENT_ID, null), evidenceBeforeRestart);
  assert.deepEqual(await candidatePilots.listAuditEvents(DEPLOYMENT_ID), auditBeforeRestart);

  const recovery = new PositionGuardPilotRecovery({
    exchangeAccountId: ACCOUNT_ID,
    target: { kind: "EXACT_DEPLOYMENT", deploymentId: DEPLOYMENT_ID },
    pilotId: PILOT_IDENTITY.pilotId,
    market: PILOT_IDENTITY.market,
    policyId: PILOT_IDENTITY.policyId,
    policyVersion: PILOT_IDENTITY.policyVersion,
    freshnessThresholdMs: 60_000,
    minimumAbsenceObservations: 2,
    minimumAbsenceElapsedMs: 5_000,
    clock: {
      now: () => ({
        occurredAt: "2026-08-21T00:00:40.000Z",
        occurredAtEpochMs: Date.parse("2026-08-21T00:00:40.000Z"),
      }),
    },
    repositories,
    candidatePilots,
    operatorState,
  });
  const recovered = await recovery.verifyAndPrepareBtcRun({
    exchangeAccountId: ACCOUNT_ID,
    requestedAt: "2026-08-21T00:00:12.000Z",
    balanceSnapshotId: "uncertain-balance",
    balanceCapturedAt: "2026-08-21T00:00:08.000Z",
    positionSnapshotId: "uncertain-position",
    positionCapturedAt: "2026-08-21T00:00:08.000Z",
    reconciliationRunId: "uncertain-reconciliation",
    reconciliationStartedAt: "2026-08-21T00:00:10.000Z",
    reconciliationCompletedAt: "2026-08-21T00:00:11.000Z",
    reconciliationSource: "SCHEDULER_PREFLIGHT",
  });
  assert.equal(recovered.status, "BLOCKED_FAULT");
  assert.equal((await candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase, "PAUSED_FAULT");

  const initializer = new PositionGuardPilotInitializer({
    identity: PILOT_IDENTITY,
    repository: {
      initializeDeploymentWithInitialState: (request) =>
        candidatePilots.initializeDeploymentWithInitialState(request),
    },
    clock: { now: () => "2026-08-21T00:00:50.000Z" },
  });
  const stateBeforeInitializer = await candidatePilots.getExactState(DEPLOYMENT_ID);
  const evidenceBeforeInitializer = await candidatePilots.listEvidenceRecords(DEPLOYMENT_ID);
  const auditBeforeInitializer = await candidatePilots.listAuditEvents(DEPLOYMENT_ID);
  const reconstructed = await initializer.initialize();
  assert.equal(reconstructed.deployment.phase, "PAUSED_FAULT");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal(adapter.createOrderCalls, 1);
  assert.deepEqual(reconstructed.exactState, stateBeforeInitializer);
  assert.deepEqual(reconstructed.evidenceRecords, evidenceBeforeInitializer);
  assert.deepEqual(await candidatePilots.listAuditEvents(DEPLOYMENT_ID), auditBeforeInitializer);
});

class NonNetworkLiveAdapter implements LiveExecutionAdapter {
  readonly sendPath = "LIVE_ADAPTER" as const;

  async getBalances(): Promise<ExchangeBalance[]> {
    return [];
  }

  async getOrderChance(market: "KRW-BTC" | "KRW-ETH"): Promise<UpbitOrderChance> {
    return {
      marketId: market,
      askTypes: ["limit", "market"],
      bidTypes: ["limit", "price"],
      maxTotal: null,
      bidMinTotal: 5_000,
      askMinTotal: 5_000,
      bidFee: "0.0005",
      askFee: "0.0005",
    };
  }

  async testOrder(_request: UpbitOrderRequest): Promise<OrderValidationResult> {
    return { accepted: true, marketOnline: true, reason: null, preview: null };
  }

  async createOrder(_request: UpbitOrderRequest): Promise<ExchangeOrderSnapshot> {
    throw new Error("Non-network LIVE fake must define createOrder explicitly.");
  }

  async cancelOrder(_query: { uuid?: string; identifier?: string }): Promise<CancelOrderResult> {
    return { accepted: false, canceledOrder: null, reason: "Not used by lifecycle fake." };
  }

  async getOrder(_query: { uuid?: string; identifier?: string }): Promise<ExchangeOrderSnapshot | null> {
    return null;
  }

  async listOpenOrders(): Promise<ExchangeOrderSnapshot[]> {
    return [];
  }

  async listClosedOrders(): Promise<ExchangeOrderSnapshot[]> {
    return [];
  }
}

class ImmediateDrainingExitLiveAdapter extends NonNetworkLiveAdapter {
  createOrderCalls = 0;

  override async createOrder(request: UpbitOrderRequest): Promise<ExchangeOrderSnapshot> {
    this.createOrderCalls += 1;
    return {
      uuid: "fake-draining-exit-order",
      identifier: request.identifier,
      market: request.market,
      side: request.side,
      ordType: request.ordType,
      state: "done",
      price: request.price,
      volume: request.volume,
      remainingVolume: "0",
      executedVolume: request.volume,
      paidFee: "5000",
      createdAt: "2026-08-21T00:00:12.000Z",
      fills: [{
        tradeUuid: "fake-draining-exit-fill",
        side: "ask",
        price: "100000000",
        volume: request.volume ?? "0",
        funds: "10000000",
        fee: "5000",
        createdAt: "2026-08-21T00:00:21.000Z",
        raw: { fake: true, drainingExit: true },
      }],
      raw: { fake: true, drainingExit: true },
    };
  }
}

class ImmediateCancelWithFillLiveAdapter extends NonNetworkLiveAdapter {
  orderChanceCalls = 0;
  orderTestCalls = 0;
  createOrderCalls = 0;

  override async getOrderChance(market: "KRW-BTC" | "KRW-ETH") {
    this.orderChanceCalls += 1;
    return super.getOrderChance(market);
  }

  override async testOrder(request: UpbitOrderRequest) {
    this.orderTestCalls += 1;
    return super.testOrder(request);
  }

  override async createOrder(request: UpbitOrderRequest): Promise<ExchangeOrderSnapshot> {
    this.createOrderCalls += 1;
    return terminalCancelWithFillSnapshot(request);
  }
}

class StagedPartialFillLiveAdapter extends NonNetworkLiveAdapter {
  createOrderCalls = 0;
  getOrderCalls = 0;
  private request: UpbitOrderRequest | null = null;
  private readonly stageIndexes = [0, 0, 1, 2] as const;

  override async createOrder(request: UpbitOrderRequest): Promise<ExchangeOrderSnapshot> {
    this.createOrderCalls += 1;
    this.request = { ...request };
    return exchangeOrderSnapshot(request, {
      state: "wait",
      executedVolume: "0",
      remainingVolume: "0.00006",
      fills: [],
      raw: { fake: true, stage: "OPEN" },
    });
  }

  override async getOrder(): Promise<ExchangeOrderSnapshot | null> {
    if (!this.request) throw new Error("Staged fake requires createOrder before getOrder.");
    const stageIndex = this.stageIndexes[this.getOrderCalls];
    if (stageIndex === undefined) throw new Error("Unexpected extra staged exchange lookup.");
    this.getOrderCalls += 1;
    const fillOne = exchangeFill("fake-staged-fill-1", "0.00002", "2000", "1", "2026-08-21T00:00:21.000Z");
    const fillTwo = exchangeFill("fake-staged-fill-2", "0.00004", "4000", "2", "2026-08-21T00:00:23.000Z");
    if (stageIndex === 0) {
      return exchangeOrderSnapshot(this.request, {
        state: "wait",
        executedVolume: "0.00002",
        remainingVolume: "0.00004",
        fills: [fillOne],
        raw: { fake: true, stage: "PARTIAL_ONE" },
      });
    }
    if (stageIndex === 1) {
      return exchangeOrderSnapshot(this.request, {
        state: "wait",
        executedVolume: "0.00006",
        remainingVolume: "0",
        fills: [fillOne, fillTwo],
        raw: { fake: true, stage: "PARTIAL_TWO" },
      });
    }
    return terminalCancelWithFillSnapshot(this.request, [fillOne, fillTwo]);
  }
}

class UncertainSubmissionAdapter extends NonNetworkLiveAdapter {
  createOrderCalls = 0;

  override async createOrder(_request: UpbitOrderRequest): Promise<never> {
    this.createOrderCalls += 1;
    throw new ExchangeOrderSubmissionError({
      kind: "UNCERTAIN",
      status: null,
      exchangeCode: null,
      exchangeName: null,
      responseReceived: false,
    });
  }
}

function exchangeFill(
  tradeUuid: string,
  volume: string,
  funds: string,
  fee: string,
  createdAt: string,
): ExchangeOrderSnapshot["fills"][number] {
  return {
    tradeUuid,
    side: "bid",
    price: "100000000",
    volume,
    funds,
    fee,
    createdAt,
    raw: { fake: true, tradeUuid },
  };
}

function exchangeOrderSnapshot(
  request: UpbitOrderRequest,
  input: Pick<ExchangeOrderSnapshot, "state" | "executedVolume" | "remainingVolume" | "fills" | "raw">,
): ExchangeOrderSnapshot {
  return {
    uuid: "fake-partial-cancel-order",
    identifier: request.identifier,
    market: request.market,
    side: request.side,
    ordType: request.ordType,
    state: input.state,
    price: request.price,
    volume: request.volume,
    remainingVolume: input.remainingVolume,
    executedVolume: input.executedVolume,
    paidFee: input.fills.length === 0
      ? "0"
      : String(input.fills.reduce((total, fill) => total + Number(fill.fee ?? 0), 0)),
    createdAt: "2026-08-21T00:00:12.000Z",
    fills: input.fills,
    raw: input.raw,
  };
}

function terminalCancelWithFillSnapshot(
  request: UpbitOrderRequest,
  fills = [
    exchangeFill("fake-partial-fill-1", "0.00002", "2000", "1", "2026-08-21T00:00:21.000Z"),
    exchangeFill("fake-partial-fill-2", "0.00004", "4000", "2", "2026-08-21T00:00:22.000Z"),
  ],
): ExchangeOrderSnapshot {
  return exchangeOrderSnapshot(request, {
    state: "cancel",
    executedVolume: "0.00006",
    remainingVolume: "0",
    fills,
    raw: { fake: true, terminal: "cancel-with-fill" },
  });
}

function executionServiceFor(input: {
  adapter: LiveExecutionAdapter;
  repositories: InMemoryExecutionRepository;
  operatorState: InMemoryOperatorStateStore;
  candidatePilots: InMemoryCandidatePilotRepository;
  now: string;
}): ExecutionService {
  return new ExecutionService({
    riskLimits: {
      maxAllocationByAsset: { BTC: 0.6, ETH: 0.6 },
      totalExposureCap: 0.75,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    executionAdapter: input.adapter,
    validationAdapter: input.adapter,
    repositories: input.repositories,
    accountExecutionLeases: new InMemoryAccountExecutionLeaseStore(),
    accountExecutionLeaseMs: 30_000,
    operatorState: input.operatorState,
    candidatePilots: input.candidatePilots,
    now: () => input.now,
  });
}

function candidateEnterInput(
  strategyDecisionId: string,
  activationAt: string,
): Parameters<ExecutionService["submitOrderFromDecision"]>[0] {
  return {
    exchangeAccountId: ACCOUNT_ID,
    strategyDecisionId,
    referencePriceCapturedAt: "2026-08-21T00:00:10.000Z",
    decision: {
      strategyKey: "position_guard.paper_core.v1",
      market: "KRW-BTC",
      action: "ENTER",
      reasonCodes: ["CANDIDATE_ALLOWED"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 6_000,
      requestedQuantity: null,
      metadata: {},
    },
    side: "bid",
    ordType: "price",
    price: "6000",
    volume: null,
    candidateAuthority: candidateAuthority(activationAt),
  };
}

function candidateAuthority(activationAt: string): CandidateExecutionAuthority {
  return {
    kind: "POSITION_GUARD_BTC_CANDIDATE",
    deploymentId: DEPLOYMENT_ID,
    exchangeAccountId: ACCOUNT_ID,
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    strategyKey: "position_guard.paper_core.v1",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    activationAt,
    activationEpochNs: BigInt(Date.parse(activationAt)) * 1_000_000n,
    expectedPhase: "ACTIVE",
    expectedDeploymentUpdatedAt: activationAt,
    expectedStateVersion: 0,
    routeReason: "CANDIDATE_ALLOWED",
  };
}

function executionState(mode: "DRY_RUN" | "LIVE" = "DRY_RUN"): ExecutionStateRecord {
  return {
    id: "lifecycle-execution-state",
    exchangeAccountId: ACCOUNT_ID,
    executionMode: mode,
    liveExecutionGate: mode === "LIVE" ? "ENABLED" : "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: CREATED_AT,
  };
}

function candidateSelection(): PositionGuardPolicySelection {
  return Object.freeze({
    kind: "BTC_CANDIDATE_PILOT",
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    liveOperatorConfirmed: true,
  });
}

function decision(action: PositionGuardEngineDecision["action"]): PositionGuardEngineDecision {
  return {
    action,
    summary: `${action} lifecycle fixture.`,
    reasons: ["LIFECYCLE_FIXTURE"],
    targetNotionalKrw: action === "ENTER" || action === "ADD" ? 6_000 : 0,
    targetQuantityFraction: action === "REDUCE" ? 0.5 : action === "EXIT" ? 1 : null,
    referencePrice: 100_000_000,
    executionDisposition: "EXECUTED_AFTER_CONFIRMATION",
    signalQuality: {
      score: 8,
      bucket: "HIGH",
      confirmationRequired: false,
      confirmationSatisfied: true,
      reentryPenaltyApplied: false,
    },
    exposureGuardrails: {
      perAssetMaxAllocation: 0.6,
      totalPortfolioMaxExposure: 0.75,
      remainingAssetCapacity: 60_000,
      remainingPortfolioCapacity: 75_000,
    },
    diagnostics: {
      regime: "BULL_TREND",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: 95_000_000,
      entryPath: "PULLBACK",
      trendAlignmentScore: 3,
      recoveryQualityScore: 3,
      breakdownPressureScore: 0,
      weakeningStage: "NONE",
      upperRangeChase: false,
      pullbackZone: true,
      reclaimStructure: false,
      breakoutHoldStructure: false,
    },
  };
}

function drainingOpenContext(generatedAt: string): PositionGuardStrategyContext {
  return {
    asset: "BTC",
    market: "KRW-BTC",
    generatedAt,
    availableKrw: 1_000_000,
    positionQuantity: 0.1,
    averageEntryPrice: 100_000_000,
    portfolio: {
      totalEquityKrw: 11_000_000,
      assetMarketValueKrw: 10_000_000,
      totalExposureKrw: 10_000_000,
    },
    latestDecision: null,
    recentExit: { createdAt: null, hoursSinceExit: null, realizedPnl: null },
    settings: createDefaultPositionGuardRunnerConfig(ACCOUNT_ID).settings,
    analysis: {
      ...structureAnalysis(),
      averageEntryPrice: 100_000_000,
      pnlPct: 0,
    },
  };
}

function structureAnalysis(): PositionGuardStructureAnalysis {
  return {
    regime: "BULL_TREND",
    riskLevel: "LOW",
    invalidationState: "CLEAR",
    invalidationLevel: 95_000_000,
    pullbackZone: true,
    reclaimStructure: false,
    breakoutHoldStructure: false,
    upperRangeChase: false,
    currentPrice: 100_000_000,
    entryPath: "PULLBACK",
    trendAlignmentScore: 3,
    recoveryQualityScore: 3,
    breakdownPressureScore: 0,
    weakeningStage: "NONE",
    breakdown1d: false,
    breakdown4h: false,
    failedReclaim: false,
    bearishMomentumExpansion: false,
    volumeRecovery: true,
    macdImproving: true,
    rsiRecovery: true,
    atrShock: false,
    averageEntryPrice: 0,
    pnlPct: 0,
  };
}
