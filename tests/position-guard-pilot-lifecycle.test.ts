import assert from "node:assert/strict";

import type { PositionGuardPolicySelection } from "../src/domain/pilot-types.js";
import type { ExecutionStateRecord } from "../src/domain/types.js";
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
import { ExecutionService } from "../src/modules/execution/execution-service.js";
import type { CandidateExecutionAuthority } from "../src/modules/execution/interfaces.js";
import {
  DryRunExchangeAdapter,
  type UpbitOrderRequest,
} from "../src/modules/exchange/interfaces.js";
import { ExchangeOrderSubmissionError } from "../src/modules/exchange/errors.js";
import { createEmptyPositionGuardCandidateState } from
  "../src/modules/strategy/position-guard-candidate-state.js";
import {
  routePositionGuardPolicy,
} from "../src/modules/strategy/position-guard-policy-router.js";
import type {
  PositionGuardEngineDecision,
  PositionGuardStructureAnalysis,
} from "../src/modules/strategy/position-guard-core.js";
import { test } from "./harness.js";

const ACCOUNT_ID = "primary";
const PILOT_IDENTITY = {
  exchangeAccountId: ACCOUNT_ID,
  pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1" as const,
  market: "KRW-BTC" as const,
  policyId: "COMBINED_CONSERVATIVE" as const,
  policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
};
const DEPLOYMENT_ID = derivePositionGuardPilotDeploymentId(PILOT_IDENTITY);
const CREATED_AT = "2026-08-21T00:00:00.000Z";
const SNAPSHOT_AT = "2026-08-21T00:00:30.000Z";
const RECONCILIATION_COMPLETED_AT = "2026-08-21T00:00:31.000Z";
const NOW = "2026-08-21T00:00:40.000Z";

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

test("fake validation and one send normalize cancel-with-fill and persist evidence exactly once across restart", async () => {
  const operatorState = new InMemoryOperatorStateStore(executionState());
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

  const adapter = new PartialCancelWithFillAdapter();
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
  const result = await executionService.submitOrderFromDecision({
    exchangeAccountId: ACCOUNT_ID,
    strategyDecisionId: "lifecycle-decision",
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
  });

  assert.equal(result.accepted, true);
  assert.equal(result.order.status, "FILLED");
  assert.deepEqual(
    [adapter.orderChanceCalls, adapter.orderTestCalls, adapter.createOrderCalls],
    [1, 1, 1],
  );
  assert.equal((await repositories.listFills(result.order.id)).length, 2);

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
  const reconstructed = await initializer.initialize();
  assert.equal(reconstructed.deployment.phase, "ACTIVE");
  assert.equal(reconstructed.exactState.stateVersion, 1);
  assert.equal(reconstructed.evidenceRecords.length, 1);
  assert.equal(reconstructed.exactState.currentEpisodeInventoryQuantity, "0.00006");
});

test("uncertain fake send pauses globally and reconstructs a faulted pilot without retry or auto-resume", async () => {
  const operatorState = new InMemoryOperatorStateStore(executionState());
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
  const duplicateAttempt = await executionService.submitOrderFromDecision(input);

  assert.equal(uncertain.outcome, "RECONCILIATION_REQUIRED");
  assert.equal(uncertain.order?.status, "RECONCILIATION_REQUIRED");
  assert.equal(adapter.createOrderCalls, 1);
  assert.notEqual(duplicateAttempt.outcome, "SUBMITTED");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase, "ACTIVE");

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
  const reconstructed = await initializer.initialize();
  assert.equal(reconstructed.deployment.phase, "PAUSED_FAULT");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal(adapter.createOrderCalls, 1);
});

class PartialCancelWithFillAdapter extends DryRunExchangeAdapter {
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

  override async createOrder(request: UpbitOrderRequest) {
    this.createOrderCalls += 1;
    return {
      uuid: "fake-partial-cancel-order",
      identifier: request.identifier,
      market: request.market,
      side: request.side,
      ordType: request.ordType,
      state: "cancel",
      price: request.price,
      volume: request.volume,
      remainingVolume: "0",
      executedVolume: "0.00006",
      paidFee: "3",
      createdAt: "2026-08-21T00:00:12.000Z",
      fills: [
        {
          tradeUuid: "fake-partial-fill-1",
          side: request.side,
          price: "100000000",
          volume: "0.00002",
          funds: "2000",
          fee: "1",
          createdAt: "2026-08-21T00:00:21.000Z",
          raw: { fake: true, part: 1 },
        },
        {
          tradeUuid: "fake-partial-fill-2",
          side: request.side,
          price: "100000000",
          volume: "0.00004",
          funds: "4000",
          fee: "2",
          createdAt: "2026-08-21T00:00:22.000Z",
          raw: { fake: true, part: 2 },
        },
      ],
      raw: { fake: true, terminal: "cancel-with-fill" },
    };
  }
}

class UncertainSubmissionAdapter extends DryRunExchangeAdapter {
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

function executionState(): ExecutionStateRecord {
  return {
    id: "lifecycle-execution-state",
    exchangeAccountId: ACCOUNT_ID,
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
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
