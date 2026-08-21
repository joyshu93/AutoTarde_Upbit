import assert from "node:assert/strict";

import { CandidateExecutionEvidenceService } from "../src/modules/execution/candidate-evidence-service.js";
import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import { InMemoryCandidatePilotRepository } from "../src/modules/db/repositories/in-memory-candidate-pilot-repository.js";
import { createEmptyPositionGuardCandidateState } from "../src/modules/strategy/position-guard-candidate-state.js";
import { test } from "./harness.js";

test("partial fills aggregate once per terminal order and canceled-with-fill advances once", async () => {
  const repositories = new InMemoryExecutionRepository();
  const pilotRepository = new InMemoryCandidatePilotRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-1",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const deployment = await pilotRepository.createDeploymentWithInitialState({
    deployment: {
      id: "deployment-1",
      exchangeAccountId: "primary",
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      phase: "ACTIVE",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    initialState: createEmptyPositionGuardCandidateState(),
  });
  await repositories.saveStrategyDecision({
    id: "decision-1",
    exchangeAccountId: "primary",
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "ENTER",
    status: "READY",
    decisionBasisJson: JSON.stringify({
      strategyDecision: { market: "KRW-BTC", action: "ENTER" },
      engineDecision: { entryPath: "PULLBACK" },
    }),
    intendedNotionalKrw: "25000000",
    intendedQuantity: null,
    referencePrice: "100000000",
    createdAt: "2026-08-21T00:00:01.000Z",
  });
  await repositories.saveOrder({
    id: "order-1",
    strategyDecisionId: "decision-1",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "25000000",
    timeInForce: null,
    smpType: null,
    identifier: "candidate-order-1",
    idempotencyKey: "candidate-order-1",
    origin: "STRATEGY",
    requestedAt: "2026-08-21T00:00:02.000Z",
    upbitUuid: "uuid-1",
    status: "CANCELED",
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-08-21T00:00:02.000Z",
    updatedAt: "2026-08-21T00:00:05.000Z",
  });
  await repositories.saveFill(fill("fill-1", "0.1", "2026-08-21T00:00:03.000Z", "500"));
  await repositories.saveFill(fill("fill-2", "0.15", "2026-08-21T00:00:04.000Z", "750"));

  const service = new CandidateExecutionEvidenceService({
    exchangeAccountId: "primary",
    repositories,
    pilotRepository,
    operatorState,
    clock: {
      now: () => ({
        occurredAt: "2026-08-21T00:00:06.000Z",
        occurredAtEpochMs: 1_777_000_006_000,
      }),
    },
  });

  const first = await service.processTerminalOrder("order-1");
  const restartedService = new CandidateExecutionEvidenceService({
    exchangeAccountId: "primary",
    repositories,
    pilotRepository,
    operatorState,
    clock: {
      now: () => ({
        occurredAt: "2026-08-21T00:00:07.000Z",
        occurredAtEpochMs: 1_777_000_007_000,
      }),
    },
  });
  const second = await restartedService.processTerminalOrder("order-1");
  const evidence = await pilotRepository.listEvidenceAfter(deployment.id, null);

  assert.equal(first.outcome, "ADVANCED", first.detail);
  assert.equal(second.outcome, "DUPLICATE");
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.executedQuantity, "0.25");
  assert.equal(evidence[0]?.grossQuoteValueKrw, "25000000");
  assert.equal(evidence[0]?.confirmedFeeKrw, "1250");
  assert.equal((await pilotRepository.getState(deployment.id))?.stateVersion, 1);
});

test("terminal no-fill cancellation is an explicit candidate evidence no-op", async () => {
  const fixture = await createCandidateFixture({ fills: [] });
  const first = await fixture.service.processTerminalOrder("order-1");
  const restartedService = new CandidateExecutionEvidenceService({
    exchangeAccountId: "primary",
    repositories: fixture.repositories,
    pilotRepository: fixture.pilotRepository,
    operatorState: fixture.operatorState,
    clock: {
      now: () => ({
        occurredAt: "2026-08-21T00:00:07.000Z",
        occurredAtEpochMs: 1_777_000_007_000,
      }),
    },
  });
  const second = await restartedService.processTerminalOrder("order-1");
  const events = await fixture.repositories.listOrderEvents("order-1");

  assert.equal(first.outcome, "TERMINAL_NO_FILL");
  assert.equal(second.outcome, "DUPLICATE");
  assert.equal((await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null)).length, 0);
  assert.equal((await fixture.pilotRepository.getState(fixture.deploymentId))?.stateVersion, 0);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "RUNNING");
  assert.equal(events.filter((event) => event.eventType === "CANDIDATE_EVIDENCE_TERMINAL_NO_FILL").length, 1);
});

test("missing fill fee evidence faults without advancing candidate state", async () => {
  const fixture = await createCandidateFixture({
    fills: [fill("missing-fee", "0.1", "2026-08-21T00:00:03.000Z", null)],
  });
  const result = await fixture.service.processTerminalOrder("order-1");
  const events = await fixture.repositories.listOrderEvents("order-1");

  assert.equal(result.outcome, "FAULT");
  assert.match(result.detail, /MISSING_FEE_EVIDENCE/);
  assert.equal((await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null)).length, 0);
  assert.equal((await fixture.pilotRepository.getState(fixture.deploymentId))?.stateVersion, 0);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  assert.equal(events.filter((event) => event.eventType === "CANDIDATE_EVIDENCE_PROJECTION_FAILED").length, 1);
});

test("conflicting persisted terminal evidence faults instead of advancing twice", async () => {
  const fixture = await createCandidateFixture({
    fills: [fill("conflict-fill", "0.1", "2026-08-21T00:00:03.000Z", "500")],
  });
  await fixture.pilotRepository.advanceStateWithEvidence({
    deploymentId: fixture.deploymentId,
    expectedStateVersion: 0,
    evidence: {
      evidenceId: "terminal-order:order-1",
      executedAt: "2026-08-21T00:00:05.000Z",
      action: "ENTER",
      entryPath: "PULLBACK",
      terminalStatus: "CANCELED",
      executedQuantity: "0.2",
      grossQuoteValueKrw: "20000000",
      confirmedFeeKrw: "1000",
      remainingQuantity: "0.2",
    },
  });

  const result = await fixture.service.processTerminalOrder("order-1");

  assert.equal(result.outcome, "FAULT");
  assert.match(result.detail, /CONFLICTING_TERMINAL_EVIDENCE/);
  assert.equal((await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null)).length, 1);
  assert.equal((await fixture.pilotRepository.getState(fixture.deploymentId))?.stateVersion, 1);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
});

test("candidate evidence rejects fills that exceed the persisted bid quote budget", async () => {
  const fixture = await createCandidateFixture({
    fills: [fill("over-budget-fill", "0.2", "2026-08-21T00:00:03.000Z", "500")],
  });

  const result = await fixture.service.processTerminalOrder("order-1");

  assert.equal(result.outcome, "FAULT");
  assert.match(result.detail, /ORDER_QUANTITY_INVALID/);
  assert.equal((await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null)).length, 0);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
});

async function createCandidateFixture(input: {
  fills: ReturnType<typeof fill>[];
}): Promise<{
  repositories: InMemoryExecutionRepository;
  pilotRepository: InMemoryCandidatePilotRepository;
  operatorState: InMemoryOperatorStateStore;
  deploymentId: string;
  service: CandidateExecutionEvidenceService;
}> {
  const repositories = new InMemoryExecutionRepository();
  const pilotRepository = new InMemoryCandidatePilotRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "candidate-fixture-state",
    exchangeAccountId: "primary",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const deployment = await pilotRepository.createDeploymentWithInitialState({
    deployment: {
      id: "candidate-fixture-deployment",
      exchangeAccountId: "primary",
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      phase: "ACTIVE",
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    initialState: createEmptyPositionGuardCandidateState(),
  });
  await repositories.saveStrategyDecision({
    id: "fixture-decision",
    exchangeAccountId: "primary",
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "ENTER",
    status: "READY",
    decisionBasisJson: JSON.stringify({
      strategyDecision: { market: "KRW-BTC", action: "ENTER" },
      engineDecision: { entryPath: "PULLBACK" },
    }),
    intendedNotionalKrw: "10000000",
    intendedQuantity: null,
    referencePrice: "100000000",
    createdAt: "2026-08-21T00:00:01.000Z",
  });
  await repositories.saveOrder({
    id: "order-1",
    strategyDecisionId: "fixture-decision",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "10000000",
    timeInForce: null,
    smpType: null,
    identifier: "candidate-fixture-order",
    idempotencyKey: "candidate-fixture-order",
    origin: "STRATEGY",
    requestedAt: "2026-08-21T00:00:02.000Z",
    upbitUuid: "candidate-fixture-uuid",
    status: "CANCELED",
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-08-21T00:00:02.000Z",
    updatedAt: "2026-08-21T00:00:05.000Z",
  });
  for (const candidateFill of input.fills) {
    await repositories.saveFill(candidateFill);
  }

  return {
    repositories,
    pilotRepository,
    operatorState,
    deploymentId: deployment.id,
    service: new CandidateExecutionEvidenceService({
      exchangeAccountId: "primary",
      repositories,
      pilotRepository,
      operatorState,
      clock: {
        now: () => ({
          occurredAt: "2026-08-21T00:00:06.000Z",
          occurredAtEpochMs: 1_777_000_006_000,
        }),
      },
    }),
  };
}

function fill(
  id: string,
  volume: string,
  filledAt: string,
  feeAmount: string | null,
) {
  return {
    id,
    orderId: "order-1",
    exchangeFillId: id,
    market: "KRW-BTC" as const,
    side: "bid" as const,
    price: "100000000",
    volume,
    feeCurrency: "KRW",
    feeAmount,
    filledAt,
    rawPayloadJson: "{}",
  };
}
