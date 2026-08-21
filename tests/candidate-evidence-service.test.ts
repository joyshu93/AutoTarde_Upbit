import assert from "node:assert/strict";

import type { FillRecord } from "../src/domain/types.js";
import { CandidateExecutionEvidenceService } from "../src/modules/execution/candidate-evidence-service.js";
import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import { InMemoryCandidatePilotRepository } from "../src/modules/db/repositories/in-memory-candidate-pilot-repository.js";
import { candidateExecutionBindingMaterialHash } from "../src/modules/db/pilot-interfaces.js";
import { ReconciliationService } from "../src/modules/reconciliation/reconciliation-service.js";
import { TerminalCandidateProjectionSweep } from "../src/modules/reconciliation/terminal-candidate-sweep.js";
import { createEmptyPositionGuardCandidateState } from "../src/modules/strategy/position-guard-candidate-state.js";
import { parsePositionGuardCandidateTimestamp } from "../src/modules/strategy/position-guard-candidate-state.js";
import { test } from "./harness.js";

test("partial fills aggregate once per terminal order and canceled-with-fill advances once", async () => {
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
  const repositories = new InMemoryExecutionRepository(operatorState);
  const deployment = await pilotRepository.createDeploymentWithInitialState({
    deployment: {
      id: "deployment-1",
      exchangeAccountId: "primary",
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      phase: "ACTIVE",
      activationAt: "2026-08-21T00:00:00.000Z",
      activationEpochNs: 1_787_270_400_000_000_000n,
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
  await pilotRepository.createExecutionBinding(candidateBinding({
    deploymentId: deployment.id,
    strategyDecisionId: "decision-1",
    orderId: "order-1",
    intendedNotionalKrw: "25000000",
  }));
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
        occurredAtEpochMs: 1_787_270_406_000,
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
        occurredAtEpochMs: 1_787_270_407_000,
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
        occurredAtEpochMs: 1_787_270_407_000,
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
  assert.match(result.detail, /UNVERIFIED_FEE_PROVENANCE/);
  assert.equal((await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null)).length, 0);
  assert.equal((await fixture.pilotRepository.getState(fixture.deploymentId))?.stateVersion, 0);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  assert.equal(events.filter((event) => event.eventType === "CANDIDATE_EVIDENCE_PROJECTION_FAILED").length, 1);
});

test("candidate evidence rejects a reconciliation timestamp substituted for an exchange fill execution instant", async () => {
  const fixture = await createCandidateFixture({
    fills: [{
      ...fill("fallback-timestamp", "0.1", "2026-08-21T00:00:03.000Z", "500"),
      executionTimestampProvenance: "RECONCILIATION_OBSERVED_AT_FALLBACK",
      executionEpochNs: null,
    } as FillRecord],
  });

  const result = await fixture.service.processTerminalOrder("order-1");

  assert.equal(result.outcome, "FAULT");
  assert.match(result.detail, /EXECUTION_TIMESTAMP.*UNVERIFIED|TIMESTAMP.*PROVENANCE/i);
  assert.equal((await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null)).length, 0);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
});

test("candidate evidence fails closed for a direct-send fill with no exchange execution timestamp", async () => {
  const fixture = await createCandidateFixture({
    fills: [{
      ...fill("direct-missing-timestamp", "0.1", "2026-08-21T00:00:03.000Z", "500"),
      executionTimestampProvenance: "LEGACY_UNVERIFIED",
      executionEpochNs: null,
      filledAt: "",
    }],
  });

  const result = await fixture.service.processTerminalOrder("order-1");

  assert.equal(result.outcome, "FAULT");
  assert.match(result.detail, /EXECUTION_TIMESTAMP.*UNVERIFIED|TIMESTAMP.*PROVENANCE/i);
  assert.equal((await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null)).length, 0);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
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

test("terminal candidate evidence uses the latest persisted fill instant rather than order update time", async () => {
  const fixture = await createCandidateFixture({
    fills: [
      fill("chronology-first", "0.05", "2026-08-21T00:00:03.000000001Z", "500"),
      fill("chronology-last", "0.05", "2026-08-21T00:00:04.000000009Z", "500"),
    ],
  });

  const result = await fixture.service.processTerminalOrder("order-1");
  const evidence = await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null);

  assert.equal(result.outcome, "ADVANCED", result.detail);
  assert.equal(evidence[0]?.executedAt, "2026-08-21T00:00:04.000000009Z");
});

test("terminal sweep projects persisted FILLED and CANCELED-with-fill orders exactly once after restart", async () => {
  for (const terminalStatus of ["FILLED", "CANCELED"] as const) {
    const fixture = await createCandidateFixture({
      terminalStatus,
      fills: [fill(`swept-${terminalStatus}`, "0.1", "2026-08-21T00:00:03.000000001Z", "500")],
    });
    const firstSweep = new TerminalCandidateProjectionSweep({
      repositories: fixture.repositories,
      projector: fixture.createService(),
      maximumPerRun: 1,
    });
    const restartSweep = new TerminalCandidateProjectionSweep({
      repositories: fixture.repositories,
      projector: fixture.createService(),
      maximumPerRun: 1,
    });

    const first = await firstSweep.run("primary");
    const restarted = await restartSweep.run("primary");

    assert.equal(first.processedCount, 1);
    assert.equal(restarted.processedCount, 0);
    assert.equal((await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null)).length, 1);
    assert.equal((await fixture.pilotRepository.getState(fixture.deploymentId))?.stateVersion, 1);
    assert.equal((await fixture.pilotRepository.listAuditEvents(fixture.deploymentId)).length, 2);
  }
});

test("bounded terminal sweep filters durable disposed rows before applying its projection limit", async () => {
  const repositories = new InMemoryExecutionRepository();
  const projected: string[] = [];
  for (const id of ["disposed-applied", "disposed-no-fill", "disposed-fault", "crash-window-order"]) {
    await repositories.saveOrder({
      id,
      strategyDecisionId: `decision-${id}`,
      exchangeAccountId: "primary",
      market: "KRW-BTC",
      side: "bid",
      ordType: "price",
      volume: null,
      price: "10000000",
      timeInForce: null,
      smpType: null,
      identifier: id,
      idempotencyKey: id,
      origin: "STRATEGY",
      requestedAt: "2026-08-21T00:00:01.000Z",
      upbitUuid: `uuid-${id}`,
      status: "FILLED",
      executionMode: "LIVE",
      exchangeResponseJson: null,
      failureCode: null,
      failureMessage: null,
      createdAt: "2026-08-21T00:00:01.000Z",
      updatedAt: "2026-08-21T00:00:09.000Z",
    });
    await repositories.saveFill({
      ...fill(`fill-${id}`, "0.1", "2026-08-21T00:00:02.000000001Z", "500"),
      orderId: id,
      exchangeFillId: `fill-${id}`,
    });
  }
  const sweep = new TerminalCandidateProjectionSweep({
    repositories,
    projector: {
      async processTerminalOrder(orderId: string) {
        projected.push(orderId);
        return { outcome: "ADVANCED", orderId, detail: "projected" };
      },
      async classifyTerminalOrderForSweep(orderId: string) {
        return orderId === "crash-window-order" ? "ELIGIBLE" : "DISPOSED";
      },
    } as never,
    maximumPerRun: 1,
  });

  const result = await sweep.run("primary");

  assert.equal(result.processedCount, 1);
  assert.deepEqual(projected, ["crash-window-order"]);
});

test("terminal sweep excludes persisted submission-absence conclusions across restart replays", async () => {
  const repositories = new InMemoryExecutionRepository();
  const projected: string[] = [];
  for (const [id, failureCode] of [
    ["absence-before-terminal", "ORDER_SUBMISSION_ABSENCE_CONFIRMED"],
    ["eligible-terminal", null],
  ] as const) {
    await repositories.saveOrder(terminalSweepOrder(id, failureCode));
  }
  const makeSweep = () => new TerminalCandidateProjectionSweep({
    repositories,
    projector: {
      async processTerminalOrder(orderId: string) {
        projected.push(orderId);
        return { outcome: "ADVANCED", orderId, detail: "projected" };
      },
    } as never,
    maximumPerRun: 1,
  });

  const first = await makeSweep().run("primary");
  const restart = await makeSweep().run("primary");

  assert.equal(first.processedCount, 1);
  assert.equal(restart.processedCount, 1);
  assert.deepEqual(projected, ["eligible-terminal", "eligible-terminal"]);
});

test("candidate fault persistence repairs an event-written pause-missing crash state atomically and idempotently", async () => {
  const operatorState = new InMemoryOperatorStateStore({
    id: "fault-atomic-state",
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
  const repositories = new InMemoryExecutionRepository(operatorState);
  const order = terminalSweepOrder("fault-atomic-order", null);
  const event = {
    id: "candidate-evidence-fault:fault-atomic-order:UNVERIFIED_FEE_PROVENANCE",
    orderId: order.id,
    eventType: "CANDIDATE_EVIDENCE_PROJECTION_FAILED" as const,
    eventSource: "RECONCILIATION" as const,
    payloadJson: JSON.stringify({ code: "UNVERIFIED_FEE_PROVENANCE" }),
    createdAt: "2026-08-21T00:00:06.000Z",
  };
  await repositories.saveOrder(order);
  // Simulate a legacy/intermediate crash from the former event-then-pause sequence.
  await repositories.appendOrderEvent(event);
  const atomicRepository = repositories as unknown as {
    persistCandidateProjectionFault(input: {
      orderId: string;
      event: typeof event;
      faultPause: { exchangeAccountId: string; faultId: string; reason: string; occurredAt: string };
    }): Promise<"APPLIED" | "DUPLICATE">;
  };
  const input = {
    orderId: order.id,
    event,
    faultPause: {
      exchangeAccountId: "primary",
      faultId: event.id,
      reason: "UNVERIFIED_FEE_PROVENANCE",
      occurredAt: event.createdAt,
    },
  };

  const first = await atomicRepository.persistCandidateProjectionFault(input);
  const second = await atomicRepository.persistCandidateProjectionFault(input);

  assert.equal(first, "DUPLICATE");
  assert.equal(second, "DUPLICATE");
  assert.equal((await operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await repositories.listOrderEvents(order.id)).length, 1);
});

test("candidate projection restart re-drives a legacy fault event with its original evidence timestamp", async () => {
  const fixture = await createCandidateFixture({
    fills: [fill("restart-missing-fee", "0.1", "2026-08-21T00:00:03.000Z", null)],
  });
  const eventId = "candidate-evidence-fault:order-1:UNVERIFIED_FEE_PROVENANCE";
  await fixture.repositories.appendOrderEvent({
    id: eventId,
    orderId: "order-1",
    eventType: "CANDIDATE_EVIDENCE_PROJECTION_FAILED",
    eventSource: "RECONCILIATION",
    payloadJson: JSON.stringify({
      code: "UNVERIFIED_FEE_PROVENANCE",
      message: "Every terminal fill requires a confirmed per-fill KRW fee source.",
    }),
    createdAt: "2026-08-21T00:00:06.000Z",
  });
  const restarted = new CandidateExecutionEvidenceService({
    exchangeAccountId: "primary",
    repositories: fixture.repositories,
    pilotRepository: fixture.pilotRepository,
    operatorState: fixture.operatorState,
    clock: {
      now: () => ({ occurredAt: "2026-08-21T00:00:07.000Z", occurredAtEpochMs: 1_787_270_407_000 }),
    },
  });

  const result = await restarted.processTerminalOrder("order-1");

  assert.equal(result.outcome, "FAULT");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await fixture.repositories.listOrderEvents("order-1")).length, 1);
});

for (const fault of [
  {
    label: "standard candidate fault",
    id: "candidate-evidence-fault:order-1:UNVERIFIED_FEE_PROVENANCE",
    code: "UNVERIFIED_FEE_PROVENANCE",
    message: "Persisted terminal evidence fee provenance is unverified.",
  },
  {
    label: "recovered-projection candidate fault",
    id: "candidate-evidence-recovery-fault:order-1",
    code: "RECOVERED_SNAPSHOT_PROJECTION_FAILED",
    message: "Persisted recovered projection failed before its pause was written.",
  },
] as const) {
  test(`complete reconciliation restart repairs an event-written ${fault.label} before disposal`, async () => {
    const fixture = await createCandidateFixture({
      fills: [fill(`restart-${fault.code}`, "0.1", "2026-08-21T00:00:03.000Z", "500")],
    });
    const eventCreatedAt = "2026-08-21T00:00:05.000Z";
    await fixture.repositories.appendOrderEvent({
      id: fault.id,
      orderId: "order-1",
      eventType: "CANDIDATE_EVIDENCE_PROJECTION_FAILED",
      eventSource: "RECONCILIATION",
      payloadJson: JSON.stringify({ code: fault.code, message: fault.message }),
      createdAt: eventCreatedAt,
    });
    const createReconciliation = () => new ReconciliationService({
      repositories: fixture.repositories,
      operatorState: fixture.operatorState,
      candidateEvidenceService: fixture.createService(),
      maxOrderLookupsPerRun: 0,
      maxTerminalCandidateProjectionsPerRun: 1,
    });

    const first = await createReconciliation().run("primary");
    const restarted = await createReconciliation().run("primary");
    const transitions = await fixture.operatorState.listTransitions(100);
    const repairedPause = transitions.find((transition) => transition.id === fault.id);

    assert.ok(first.issues.some((issue) => issue.code === "CANDIDATE_EVIDENCE_PROJECTION_FAILED"));
    assert.ok(!restarted.issues.some((issue) => issue.code === "CANDIDATE_EVIDENCE_PROJECTION_FAILED"));
    assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
    assert.equal(repairedPause?.command, "AUTOMATIC_PAUSE");
    assert.equal(repairedPause?.toSystemStatus, "PAUSED");
    assert.equal(repairedPause?.createdAt, eventCreatedAt);
    assert.equal((await fixture.repositories.listOrderEvents("order-1"))
      .filter((event) => event.id === fault.id).length, 1);
    assert.deepEqual(await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null), []);
  });
}

test("unbound terminal candidate evidence faults instead of attaching to the current deployment", async () => {
  const fixture = await createCandidateFixture({
    fills: [fill("unbound-fill", "0.1", "2026-08-21T00:00:03.000Z", "500")],
    bound: false,
  });

  const result = await fixture.service.processTerminalOrder("order-1");

  assert.equal(result.outcome, "FAULT");
  assert.match(result.detail, /BINDING/i);
  assert.equal((await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null)).length, 0);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
});

test("pre-deployment terminal strategy history is excluded without a candidate fault", async () => {
  const fixture = await createCandidateFixture({
    bound: false,
    orderRequestedAt: "2026-08-20T23:59:59.000Z",
    fills: [fill("pre-deployment-fill", "0.1", "2026-08-21T00:00:03.000Z", "500")],
  });

  const result = await fixture.service.processTerminalOrder("order-1");

  assert.equal(result.outcome, "NOT_CANDIDATE_ORDER");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "RUNNING");
  assert.equal((await fixture.repositories.listOrderEvents("order-1"))
    .filter((event) => event.eventType === "CANDIDATE_EVIDENCE_PROJECTION_FAILED").length, 0);
});

test("pre-activation terminal history uses the persisted ACTIVE instant rather than deployment creation", async () => {
  const fixture = await createCandidateFixture({
    bound: false,
    activationAt: "2026-08-21T00:00:10.000Z",
    orderRequestedAt: "2026-08-21T00:00:05.000Z",
    fills: [fill("pre-activation-fill", "0.1", "2026-08-21T00:00:06.000Z", "500")],
  });

  const result = await fixture.service.processTerminalOrder("order-1");

  assert.equal(result.outcome, "NOT_CANDIDATE_ORDER");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "RUNNING");
});

test("bound execution mode must match the persisted terminal order", async () => {
  const fixture = await createCandidateFixture({
    bound: false,
    fills: [fill("mode-mismatch-fill", "0.1", "2026-08-21T00:00:03.000Z", "500")],
  });
  const binding = {
    ...candidateBinding({
      deploymentId: fixture.deploymentId,
      strategyDecisionId: "fixture-decision",
      orderId: "order-1",
      intendedNotionalKrw: "10000000",
    }),
    executionMode: "DRY_RUN" as const,
  };
  await fixture.pilotRepository.createExecutionBinding({
    ...binding,
    orderMaterialHash: candidateExecutionBindingMaterialHash(binding),
  });

  const result = await fixture.service.processTerminalOrder("order-1");

  assert.equal(result.outcome, "FAULT");
  assert.match(result.detail, /BINDING_INVALID/i);
  assert.equal((await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null)).length, 0);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
});

test("a complete bound order shape mismatch faults before candidate state advancement", async () => {
  const fixture = await createCandidateFixture({
    bound: false,
    fills: [fill("bound-price-mismatch", "0.1", "2026-08-21T00:00:03.000Z", "500")],
  });
  const binding = {
    ...candidateBinding({
      deploymentId: fixture.deploymentId,
      strategyDecisionId: "fixture-decision",
      orderId: "order-1",
      intendedNotionalKrw: "10000000",
    }),
    boundPrice: "9999999",
  };
  await fixture.pilotRepository.createExecutionBinding({
    ...binding,
    orderMaterialHash: candidateExecutionBindingMaterialHash(binding),
  });

  const result = await fixture.service.processTerminalOrder("order-1");

  assert.equal(result.outcome, "FAULT");
  assert.match(result.detail, /BINDING_INVALID/i);
  assert.equal((await fixture.pilotRepository.getState(fixture.deploymentId))?.stateVersion, 0);
});

test("persisted terminal sweep progress skips applied, no-fill, and fault dispositions before its limit after restart", async () => {
  const fixture = await createCandidateFixture({
    fills: [fill("already-applied", "0.1", "2026-08-21T00:00:02.000Z", "500")],
  });
  await seedFixtureTerminalOrder(fixture, "no-fill-before-crash", []);
  await seedFixtureTerminalOrder(fixture, "fault-before-crash", [
    fill("fault-before-crash-fill", "0.1", "2026-08-21T00:00:03.000Z", "500"),
  ], false);
  await seedFixtureTerminalOrder(
    fixture,
    "preactivation-before-crash",
    [],
    false,
    "ENTER",
    "2026-08-20T23:59:59.000Z",
  );
  await seedFixtureTerminalOrder(fixture, "crash-window-order", [
    fill("crash-window-fill", "0.1", "2026-08-21T00:00:04.000Z", "500"),
  ], true, "ADD");

  await fixture.service.processTerminalOrder("order-1");
  await fixture.service.processTerminalOrder("no-fill-before-crash");
  await fixture.service.processTerminalOrder("fault-before-crash");
  const restartedSweep = new TerminalCandidateProjectionSweep({
    repositories: fixture.repositories,
    projector: fixture.createService(),
    maximumPerRun: 1,
  });

  const firstAfterRestart = await restartedSweep.run("primary");
  const replay = await new TerminalCandidateProjectionSweep({
    repositories: fixture.repositories,
    projector: fixture.createService(),
    maximumPerRun: 1,
  }).run("primary");
  const secondRestartReplay = await new TerminalCandidateProjectionSweep({
    repositories: fixture.repositories,
    projector: fixture.createService(),
    maximumPerRun: 1,
  }).run("primary");

  assert.equal(firstAfterRestart.processedCount, 1);
  assert.equal(replay.processedCount, 0);
  assert.equal(secondRestartReplay.processedCount, 0);
  assert.equal((await fixture.pilotRepository.getEvidenceRecord(
    fixture.deploymentId,
    "terminal-order:crash-window-order",
  ))?.materialVersion, "EXACT_V2");
});

test("bounded terminal sweep reaches every later eligible row once across multiple recreated restarts", async () => {
  const fixture = await createCandidateFixture({
    fills: [fill("already-applied", "0.1", "2026-08-21T00:00:03.000Z", "500")],
  });
  await seedFixtureTerminalOrder(fixture, "no-fill-before-eligible", []);
  await seedFixtureTerminalOrder(fixture, "fault-before-eligible", [
    fill("fault-before-eligible-fill", "0.1", "2026-08-21T00:00:04.000Z", "500"),
  ], false);
  await seedFixtureTerminalOrder(
    fixture,
    "preactivation-before-eligible",
    [],
    false,
    "ENTER",
    "2026-08-20T23:59:59.000Z",
  );
  const laterEligibleRows = [
    ["eligible-z-first", "2026-08-21T00:00:07.000000001Z"],
    ["eligible-a-second", "2026-08-21T00:00:08.000000001Z"],
    ["eligible-y-third", "2026-08-21T00:00:09.000000001Z"],
    ["eligible-b-fourth", "2026-08-21T00:00:10.000000001Z"],
    ["eligible-x-fifth", "2026-08-21T00:00:11.000000001Z"],
  ] as const;
  for (const [orderId, filledAt] of laterEligibleRows) {
    await seedFixtureTerminalOrder(fixture, orderId, [
      fill(`fill-${orderId}`, "0.01", filledAt, "50"),
    ], true, "ADD");
  }

  await fixture.service.processTerminalOrder("order-1");
  await fixture.service.processTerminalOrder("no-fill-before-eligible");
  await fixture.service.processTerminalOrder("fault-before-eligible");

  const projected: string[] = [];
  const runRestartedSweep = async () => {
    const restartedService = fixture.createService();
    return new TerminalCandidateProjectionSweep({
      repositories: fixture.repositories,
      projector: {
        async processTerminalOrder(orderId: string) {
          projected.push(orderId);
          return restartedService.processTerminalOrder(orderId);
        },
        async classifyTerminalOrderForSweep(orderId: string) {
          return restartedService.classifyTerminalOrderForSweep(orderId);
        },
      },
      maximumPerRun: 2,
    }).run("primary");
  };

  const runs = [
    await runRestartedSweep(),
    await runRestartedSweep(),
    await runRestartedSweep(),
    await runRestartedSweep(),
  ];

  assert.deepEqual(runs.map((run) => run.processedCount), [2, 2, 1, 0]);
  assert.deepEqual(runs.map((run) => run.deferredCount), [3, 1, 0, 0]);
  assert.deepEqual(projected, laterEligibleRows.map(([orderId]) => orderId));
  assert.deepEqual(
    (await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null))
      .map((evidence) => evidence.evidenceId),
    ["terminal-order:order-1", ...laterEligibleRows.map(([orderId]) => `terminal-order:${orderId}`)],
  );
});

test("legacy and inferred fill fees never count as confirmed candidate fee evidence", async () => {
  for (const feeProvenance of ["ORDER_LEVEL_ALLOCATED", "LEGACY_UNVERIFIED"] as const) {
    const fixture = await createCandidateFixture({
      fills: [{
        ...fill(`${feeProvenance}-fee`, "0.1", "2026-08-21T00:00:03.000Z", "500"),
        feeProvenance,
      }],
    });

    const result = await fixture.service.processTerminalOrder("order-1");

    assert.equal(result.outcome, "FAULT");
    assert.match(result.detail, /FEE.*PROVENANCE|UNVERIFIED_FEE/i);
    assert.equal((await fixture.pilotRepository.listEvidenceAfter(fixture.deploymentId, null)).length, 0);
  }
});

async function createCandidateFixture(input: {
  fills: FillRecord[];
  bound?: boolean;
  terminalStatus?: "FILLED" | "CANCELED";
  orderRequestedAt?: string;
  activationAt?: string;
}): Promise<{
  repositories: InMemoryExecutionRepository;
  pilotRepository: InMemoryCandidatePilotRepository;
  operatorState: InMemoryOperatorStateStore;
  deploymentId: string;
  service: CandidateExecutionEvidenceService;
  createService: () => CandidateExecutionEvidenceService;
}> {
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
  const repositories = new InMemoryExecutionRepository(operatorState);
  const deployment = await pilotRepository.createDeploymentWithInitialState({
    deployment: {
      id: "candidate-fixture-deployment",
      exchangeAccountId: "primary",
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      phase: "ACTIVE",
      activationAt: input.activationAt ?? "2026-08-21T00:00:00.000Z",
      activationEpochNs: parsePositionGuardCandidateTimestamp(
        input.activationAt ?? "2026-08-21T00:00:00.000Z",
        "fixture activationAt",
      ),
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
    requestedAt: input.orderRequestedAt ?? "2026-08-21T00:00:02.000Z",
    upbitUuid: "candidate-fixture-uuid",
    status: input.terminalStatus ?? "CANCELED",
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: input.orderRequestedAt ?? "2026-08-21T00:00:02.000Z",
    updatedAt: "2026-08-21T00:00:05.000Z",
  });
  if (input.bound !== false) {
    await pilotRepository.createExecutionBinding(candidateBinding({
      deploymentId: deployment.id,
      strategyDecisionId: "fixture-decision",
      orderId: "order-1",
      intendedNotionalKrw: "10000000",
    }));
  }
  for (const candidateFill of input.fills) {
    await repositories.saveFill(candidateFill);
  }

  const createService = () => new CandidateExecutionEvidenceService({
    exchangeAccountId: "primary",
    repositories,
    pilotRepository,
    operatorState,
    clock: {
      now: () => ({
        occurredAt: "2026-08-21T00:00:06.000Z",
        occurredAtEpochMs: 1_787_270_406_000,
      }),
    },
  });

  return {
    repositories,
    pilotRepository,
    operatorState,
    deploymentId: deployment.id,
    service: createService(),
    createService,
  };
}

function terminalSweepOrder(id: string, failureCode: string | null) {
  return {
    id,
    strategyDecisionId: `decision-${id}`,
    exchangeAccountId: "primary",
    market: "KRW-BTC" as const,
    side: "bid" as const,
    ordType: "price" as const,
    volume: null,
    price: "10000000",
    timeInForce: null,
    smpType: null,
    identifier: id,
    idempotencyKey: id,
    origin: "STRATEGY" as const,
    requestedAt: "2026-08-21T00:00:02.000Z",
    upbitUuid: `uuid-${id}`,
    status: "CANCELED" as const,
    executionMode: "LIVE" as const,
    exchangeResponseJson: null,
    failureCode,
    failureMessage: failureCode ? "bounded absence confirmed" : null,
    createdAt: "2026-08-21T00:00:02.000Z",
    updatedAt: "2026-08-21T00:00:05.000Z",
  };
}

function fill(
  id: string,
  volume: string,
  filledAt: string,
  feeAmount: string | null,
): FillRecord {
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
    feeProvenance: "EXCHANGE_FILL_CONFIRMED",
    executionTimestampProvenance: "EXCHANGE_FILL_CONFIRMED",
    executionEpochNs: parsePositionGuardCandidateTimestamp(filledAt, "fixture fill timestamp").toString(),
    filledAt,
    rawPayloadJson: "{}",
  };
}

function candidateBinding(input: {
  deploymentId: string;
  strategyDecisionId: string;
  orderId: string;
  intendedNotionalKrw: string;
}) {
  const binding = {
    id: `binding:${input.orderId}`,
    deploymentId: input.deploymentId,
    strategyDecisionId: input.strategyDecisionId,
    orderId: input.orderId,
    exchangeAccountId: "primary",
    activationAt: "2026-08-21T00:00:00.000Z",
    activationEpochNs: 1_787_270_400_000_000_000n,
    market: "KRW-BTC" as const,
    strategyKey: "position_guard.paper_core.v1" as const,
    policyId: "COMBINED_CONSERVATIVE" as const,
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1" as const,
    executionMode: "LIVE" as const,
    ordType: "price" as const,
    action: "ENTER" as const,
    side: "bid" as const,
    intendedQuantity: null,
    intendedNotionalKrw: input.intendedNotionalKrw,
    boundPrice: input.intendedNotionalKrw,
    boundVolume: null,
    boundTimeInForce: null,
    boundSmpType: null,
    materialVersion: "BINDING_V2" as const,
    createdAt: "2026-08-21T00:00:01.500Z",
  };
  return {
    ...binding,
    orderMaterialHash: candidateExecutionBindingMaterialHash(binding),
  };
}

async function seedFixtureTerminalOrder(
  fixture: Awaited<ReturnType<typeof createCandidateFixture>>,
  id: string,
  fills: FillRecord[],
  bound = true,
  action: "ENTER" | "ADD" = "ENTER",
  requestedAt = "2026-08-21T00:00:02.000Z",
): Promise<void> {
  const decisionId = `decision-${id}`;
  await fixture.repositories.saveStrategyDecision({
    id: decisionId,
    exchangeAccountId: "primary",
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action,
    status: "READY",
    decisionBasisJson: JSON.stringify({
      strategyDecision: { market: "KRW-BTC", action },
      engineDecision: { entryPath: "PULLBACK" },
    }),
    intendedNotionalKrw: "10000000",
    intendedQuantity: null,
    referencePrice: "100000000",
    createdAt: "2026-08-21T00:00:01.000Z",
  });
  await fixture.repositories.saveOrder({
    id,
    strategyDecisionId: decisionId,
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "10000000",
    timeInForce: null,
    smpType: null,
    identifier: id,
    idempotencyKey: id,
    origin: "STRATEGY",
    requestedAt,
    upbitUuid: `uuid-${id}`,
    status: fills.length === 0 ? "CANCELED" : "FILLED",
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: requestedAt,
    updatedAt: "2026-08-21T00:00:05.000Z",
  });
  if (bound) {
    const binding = {
      ...candidateBinding({
      deploymentId: fixture.deploymentId,
      strategyDecisionId: decisionId,
      orderId: id,
      intendedNotionalKrw: "10000000",
      }),
      action,
    };
    await fixture.pilotRepository.createExecutionBinding({
      ...binding,
      orderMaterialHash: candidateExecutionBindingMaterialHash(binding),
    });
  }
  for (const fillRecord of fills) {
    await fixture.repositories.saveFill({ ...fillRecord, orderId: id });
  }
}
