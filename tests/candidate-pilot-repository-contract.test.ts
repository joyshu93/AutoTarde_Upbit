import assert from "node:assert/strict";

import type { PositionGuardPilotAuditEventRecord } from "../src/domain/pilot-types.js";
import { InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import {
  createEmptyPositionGuardCandidateState,
  parsePositionGuardCandidateTimestamp,
  type PositionGuardCandidateExecutionEvidence,
} from "../src/modules/strategy/position-guard-candidate-state.js";
import type {
  AdvanceCandidatePilotStateInput,
  CandidatePilotRepository,
  CreateCandidatePilotDeploymentInput,
} from "../src/modules/db/pilot-interfaces.js";
import { toPositionGuardCandidateRoutingState } from "../src/modules/db/pilot-interfaces.js";
import { InMemoryCandidatePilotRepository } from
  "../src/modules/db/repositories/in-memory-candidate-pilot-repository.js";
import {
  EXACT_CANDIDATE_QUANTITY_TOLERANCE,
  deriveExactRemainingQuantity,
} from "../src/modules/execution/candidate-evidence-decimals.js";
import { test } from "./harness.js";

export type CandidatePilotRepositoryFactory = () =>
  CandidatePilotRepository | Promise<CandidatePilotRepository>;

export function initialDeploymentInput(
  id = "deployment-contract",
  exchangeAccountId = "primary",
): CreateCandidatePilotDeploymentInput {
  return {
    deployment: {
      id,
      exchangeAccountId,
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      phase: "PENDING_FLAT",
      activationAt: null,
      activationEpochNs: null,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    },
    initialState: createEmptyPositionGuardCandidateState(),
  };
}

export function candidateEvidence(
  evidenceId: string,
  overrides: Partial<PositionGuardCandidateExecutionEvidence> = {},
): PositionGuardCandidateExecutionEvidence {
  return {
    evidenceId,
    executedAt: "2026-08-21T00:00:01.000Z",
    action: "ENTER",
    entryPath: "RECLAIM",
    terminalStatus: "FILLED",
    executedQuantity: "0.1",
    grossQuoteValueKrw: "10000000",
    confirmedFeeKrw: "5000",
    remainingQuantity: "0.1",
    ...overrides,
  };
}

export function advanceInput(
  deploymentId: string,
  evidenceId: string,
  expectedStateVersion: number,
  overrides: Partial<PositionGuardCandidateExecutionEvidence> = {},
): AdvanceCandidatePilotStateInput {
  return {
    deploymentId,
    expectedStateVersion,
    evidence: candidateEvidence(evidenceId, overrides),
  };
}

export async function verifyAtomicDeploymentInitializationContract(
  create: CandidatePilotRepositoryFactory,
): Promise<void> {
  const repository = await create();
  const input = initialDeploymentInput("deployment-atomic-bootstrap");

  const activatedPendingInput = initialDeploymentInput("deployment-activated-pending-bootstrap");
  const forbiddenActivationAt = "2026-08-21T00:00:00.000000001Z";
  activatedPendingInput.deployment.activationAt = forbiddenActivationAt;
  activatedPendingInput.deployment.activationEpochNs = parsePositionGuardCandidateTimestamp(
    forbiddenActivationAt,
    "forbidden pending bootstrap activation",
  );
  await assert.rejects(
    () => repository.initializeDeploymentWithInitialState(activatedPendingInput),
    /without activation|activation.*null/i,
  );
  assert.equal(await repository.getDeployment(activatedPendingInput.deployment.id), null);

  const created = await repository.initializeDeploymentWithInitialState(input);
  assert.equal(created.outcome, "CREATED");
  assert.deepEqual(created.deployment, input.deployment);
  assert.equal(created.exactState.stateVersion, 0);
  assert.equal(created.exactState.currentEpisodeInventoryQuantity, "0");
  assert.deepEqual(created.evidenceRecords, []);
  assert.deepEqual(created.auditEvents, [{
    id: `${input.deployment.id}:created`,
    deploymentId: input.deployment.id,
    eventType: "DEPLOYMENT_CREATED",
    fromPhase: null,
    toPhase: "PENDING_FLAT",
    stateVersion: 0,
    payloadJson: JSON.stringify({
      pilotId: input.deployment.pilotId,
      market: input.deployment.market,
      policyId: input.deployment.policyId,
      policyVersion: input.deployment.policyVersion,
    }),
    createdAt: input.deployment.createdAt,
  }]);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.deployment), true);
  assert.equal(Object.isFrozen(created.exactState), true);
  assert.equal(Object.isFrozen(created.evidenceRecords), true);
  assert.equal(Object.isFrozen(created.auditEvents), true);
  assert.equal(Object.isFrozen(created.auditEvents[0]), true);
  const creationAudit = created.auditEvents[0];
  assert.ok(creationAudit);
  assert.throws(() => {
    (created.deployment as { phase: string }).phase = "ACTIVE";
  }, TypeError);
  assert.throws(() => {
    (created.auditEvents as PositionGuardPilotAuditEventRecord[]).push({
      ...creationAudit,
      id: "forged",
    });
  }, TypeError);

  const restarted = await repository.initializeDeploymentWithInitialState(input);
  assert.equal(restarted.outcome, "EXISTING");
  assert.deepEqual(restoredAuthority(restarted), restoredAuthority(created));

  const differentRequestedAuthority = initialDeploymentInput(
    "deployment-different-deterministic-id",
  );
  differentRequestedAuthority.deployment.createdAt = "2026-08-22T00:00:00.000Z";
  differentRequestedAuthority.deployment.updatedAt = "2026-08-22T00:00:00.000Z";
  const existing = await repository.initializeDeploymentWithInitialState(differentRequestedAuthority);
  assert.equal(existing.outcome, "EXISTING");
  assert.deepEqual(restoredAuthority(existing), restoredAuthority(created));
  assert.equal((await repository.getDeployment(differentRequestedAuthority.deployment.id)), null);

  await assert.rejects(
    () => repository.initializeDeploymentWithInitialState(
      initialDeploymentInput(input.deployment.id, "foreign-account"),
    ),
    /identity|collision|exchange account/i,
  );

  const activeRepository = await create();
  const activeInput = initialDeploymentInput("deployment-active-bootstrap-rejected");
  const activationAt = "2026-08-21T00:00:01.000Z";
  activeInput.deployment.phase = "ACTIVE";
  activeInput.deployment.activationAt = activationAt;
  activeInput.deployment.activationEpochNs = parsePositionGuardCandidateTimestamp(
    activationAt,
    "active bootstrap rejection",
  );
  await assert.rejects(
    () => activeRepository.initializeDeploymentWithInitialState(activeInput),
    /PENDING_FLAT/i,
  );
  assert.equal(
    await activeRepository.getDeployment(activeInput.deployment.id),
    null,
  );

  const accessorInput = initialDeploymentInput("deployment-accessor-rejected", "secondary");
  const accessorId = accessorInput.deployment.id;
  Object.defineProperty(accessorInput.deployment, "id", {
    enumerable: true,
    get: () => accessorId,
  });
  await assert.rejects(
    () => repository.initializeDeploymentWithInitialState(accessorInput),
    /own data properties|accessor/i,
  );
  assert.equal((await repository.getDeployment("deployment-accessor-rejected")), null);
}

function restoredAuthority(value: Awaited<ReturnType<CandidatePilotRepository["initializeDeploymentWithInitialState"]>>) {
  return {
    deployment: value.deployment,
    exactState: value.exactState,
    evidenceRecords: value.evidenceRecords,
    auditEvents: value.auditEvents,
  };
}

export async function verifyCandidatePilotRepositoryContract(
  create: CandidatePilotRepositoryFactory,
): Promise<void> {
  const repository = await create();
  const input = initialDeploymentInput();
  const deployment = await repository.createDeploymentWithInitialState(input);

  const exactRecoveryIdentity = {
    exchangeAccountId: deployment.exchangeAccountId,
    pilotId: deployment.pilotId,
    market: deployment.market,
    policyId: deployment.policyId,
    policyVersion: deployment.policyVersion,
  } as const;
  const exactMatches = await repository.findDeploymentsForRecoveryIdentity(exactRecoveryIdentity);
  assert.equal(exactMatches.length, 1);
  assert.deepEqual(exactMatches[0], deployment);
  assert.notEqual(exactMatches[0], deployment);
  assert.equal(Object.isFrozen(exactMatches[0]), true);
  assert.deepEqual(
    await repository.findDeploymentsForRecoveryIdentity({
      ...exactRecoveryIdentity,
      exchangeAccountId: "missing-account",
    }),
    [],
  );

  const first = await repository.advanceStateWithEvidence(
    advanceInput(deployment.id, "e1", 0),
  );
  const duplicateEvidence: PositionGuardCandidateExecutionEvidence = {
    remainingQuantity: "0.1",
    confirmedFeeKrw: "5000",
    grossQuoteValueKrw: "10000000",
    executedQuantity: "0.1",
    terminalStatus: "FILLED",
    entryPath: "RECLAIM",
    action: "ENTER",
    executedAt: "2026-08-21T00:00:01.000Z",
    evidenceId: "e1",
  };
  const duplicate = await repository.advanceStateWithEvidence({
    deploymentId: deployment.id,
    expectedStateVersion: 0,
    evidence: duplicateEvidence,
  });

  assert.equal(first.state.stateVersion, 1);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.state.stateVersion, 1);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await repository.listEvidenceAfter(deployment.id, null)).length, 1);

  await assert.rejects(
    () => repository.advanceStateWithEvidence(
      advanceInput(deployment.id, "e1", 0, { confirmedFeeKrw: "5001" }),
    ),
    /conflicting duplicate/i,
  );
  await assert.rejects(
    () => repository.advanceStateWithEvidence(
      advanceInput(deployment.id, "e1", 0, { remainingQuantity: "0" }),
    ),
    /conflicting duplicate/i,
  );
  await assert.rejects(
    () => repository.advanceStateWithEvidence(
      advanceInput(deployment.id, "e2", 0, {
        action: "ADD",
        executedAt: "2026-08-21T00:00:02.000Z",
        remainingQuantity: "0.2",
      }),
    ),
    /state version/i,
  );

  assert.equal((await repository.getState(deployment.id))?.stateVersion, 1);
  const exactState = await repository.getExactState(deployment.id);
  const routingState = await repository.getState(deployment.id);
  assert.ok(exactState);
  assert.ok(routingState);
  assert.deepEqual(routingState, toPositionGuardCandidateRoutingState(exactState));
  assert.notEqual(routingState, exactState);
  assert.equal(Object.isFrozen(routingState), true);
  assert.equal((await repository.listEvidenceAfter(deployment.id, null)).length, 1);
  assert.equal((await repository.listAuditEvents(deployment.id)).length, 2);

  await repository.advanceStateWithEvidence(
    advanceInput(deployment.id, "exact-add", 1, {
      action: "ADD",
      executedAt: "2026-08-21T00:00:01.000000001Z",
      executedQuantity: "0.1",
      grossQuoteValueKrw: "10000000",
      confirmedFeeKrw: "0",
      remainingQuantity: "0.2",
    }),
  );
  await repository.advanceStateWithEvidence(
    advanceInput(deployment.id, "exact-reduce", 2, {
      action: "REDUCE",
      executedAt: "2026-08-21T00:00:02.000000001Z",
      executedQuantity: "0.1",
      grossQuoteValueKrw: "10000000",
      confirmedFeeKrw: "0",
      remainingQuantity: "0.1",
    }),
  );
  assert.equal(
    (await repository.getEvidenceRecord(deployment.id, "exact-reduce"))?.evidence.remainingQuantity,
    "0.1",
  );

  const forgedEvidence = {
    ...candidateEvidence("e2", {
      action: "ADD",
      executedAt: "2026-08-21T00:00:02.000Z",
      remainingQuantity: "0.2",
    }),
    unexpected: true,
  } as PositionGuardCandidateExecutionEvidence;
  await assert.rejects(
    () => repository.advanceStateWithEvidence({
      deploymentId: deployment.id,
      expectedStateVersion: 1,
      evidence: forgedEvidence,
    }),
    /exactly own data properties/i,
  );
}

export async function verifyMixedOffsetReplayContract(
  create: CandidatePilotRepositoryFactory,
): Promise<void> {
  const repository = await create();
  const deployment = await repository.createDeploymentWithInitialState(
    initialDeploymentInput("deployment-mixed-offset"),
  );

  await repository.advanceStateWithEvidence(
    advanceInput(deployment.id, "evidence-first", 0, {
      executedAt: "2026-08-21T09:00:00+09:00",
    }),
  );
  await repository.advanceStateWithEvidence(
    advanceInput(deployment.id, "B", 1, {
      action: "ADD",
      executedAt: "2026-08-21T00:00:00.000000001Z",
      executedQuantity: "0.05",
      grossQuoteValueKrw: "5000000",
      confirmedFeeKrw: "2500",
      remainingQuantity: "0.15",
    }),
  );
  await repository.advanceStateWithEvidence(
    advanceInput(deployment.id, "a", 2, {
      action: "ADD",
      executedAt: "2026-08-21T00:00:00.000000001Z",
      executedQuantity: "0.05",
      grossQuoteValueKrw: "5000000",
      confirmedFeeKrw: "2500",
      remainingQuantity: "0.2",
    }),
  );

  const evidence = await repository.listEvidenceAfter(deployment.id, null);
  assert.deepEqual(
    evidence.map((item) => item.evidenceId),
    ["evidence-first", "B", "a"],
  );
  assert.deepEqual(
    (await repository.listEvidenceAfter(deployment.id, "B"))
      .map((item) => item.evidenceId),
    ["a"],
  );
  assert.equal((await repository.getState(deployment.id))?.stateVersion, 3);
}

export async function verifyDeploymentScopedEvidenceIdentityContract(
  create: CandidatePilotRepositoryFactory,
): Promise<void> {
  const repository = await create();
  const first = await repository.createDeploymentWithInitialState(
    initialDeploymentInput("deployment-scoped-first", "primary"),
  );
  const second = await repository.createDeploymentWithInitialState(
    initialDeploymentInput("deployment-scoped-second", "secondary"),
  );

  await repository.advanceStateWithEvidence(advanceInput(first.id, "shared-evidence", 0));
  await repository.advanceStateWithEvidence(advanceInput(second.id, "shared-evidence", 0));

  assert.deepEqual(
    (await repository.listEvidenceAfter(first.id, null)).map((item) => item.evidenceId),
    ["shared-evidence"],
  );
  assert.deepEqual(
    (await repository.listEvidenceAfter(second.id, null)).map((item) => item.evidenceId),
    ["shared-evidence"],
  );
  assert.equal((await repository.getState(first.id))?.stateVersion, 1);
  assert.equal((await repository.getState(second.id))?.stateVersion, 1);
  await assert.rejects(
    () => repository.advanceStateWithEvidence(
      advanceInput(first.id, "shared-evidence", 0, { confirmedFeeKrw: "5001" }),
    ),
    /conflicting duplicate/i,
  );
}

export async function verifyPreEpochEvidenceRejectionContract(
  create: CandidatePilotRepositoryFactory,
): Promise<void> {
  const repository = await create();
  const deployment = await repository.createDeploymentWithInitialState(
    initialDeploymentInput("deployment-pre-epoch"),
  );

  await assert.rejects(
    () => repository.advanceStateWithEvidence(
      advanceInput(deployment.id, "pre-epoch", 0, {
        executedAt: "1969-12-31T23:59:59.999999999Z",
      }),
    ),
    /before the Unix epoch/i,
  );
  assert.equal((await repository.getState(deployment.id))?.stateVersion, 0);
  assert.deepEqual(await repository.listEvidenceAfter(deployment.id, null), []);
  assert.equal((await repository.listAuditEvents(deployment.id)).length, 1);
}

export async function verifyCandidatePilotIdentityValidation(
  create: CandidatePilotRepositoryFactory,
): Promise<void> {
  const repository = await create();
  const input = initialDeploymentInput("deployment-forged-identity");
  const forged = {
    ...input.deployment,
    policyVersion: "FORGED",
  } as unknown as typeof input.deployment;
  await assert.rejects(
    () => repository.createDeploymentWithInitialState({
      deployment: forged,
      initialState: input.initialState,
    }),
    /approved identity/i,
  );

  await repository.createDeploymentWithInitialState(
    initialDeploymentInput("deployment-unique-one"),
  );
  await assert.rejects(
    () => repository.createDeploymentWithInitialState(
      initialDeploymentInput("deployment-unique-two"),
    ),
    /already exists|unique/i,
  );
}

export async function verifyCandidateDeploymentActivationContract(
  create: CandidatePilotRepositoryFactory,
): Promise<void> {
  const repository = await create();
  const deployment = await repository.createDeploymentWithInitialState(
    initialDeploymentInput("deployment-activation-contract"),
  );
  const activationAt = "2026-08-21T00:00:01.000000001Z";
  const input = {
    deploymentId: deployment.id,
    expectedPhase: "PENDING_FLAT" as const,
    expectedUpdatedAt: deployment.updatedAt,
    activationAt,
    activationEpochNs: parsePositionGuardCandidateTimestamp(activationAt, "activation contract").toString(),
  };
  const activated = await repository.activateDeployment({
    ...input,
    activationEpochNs: BigInt(input.activationEpochNs),
  });
  const replay = await repository.activateDeployment({
    ...input,
    activationEpochNs: BigInt(input.activationEpochNs),
  });

  assert.equal(activated?.phase, "ACTIVE");
  assert.equal(activated?.activationAt, activationAt);
  assert.equal(activated?.activationEpochNs, BigInt(input.activationEpochNs));
  assert.equal(replay, null);
  assert.equal((await repository.listAuditEvents(deployment.id)).at(-1)?.eventType, "PHASE_TRANSITION");
}

export async function verifyCandidatePilotRollbackContract(
  create: CandidatePilotRepositoryFactory,
): Promise<void> {
  await verifyNonFlatActiveRollbackStart(create);
  await verifyPristinePendingRollbackCompletion(create);
  await verifyFullyExitedActiveRollbackCompletion(create);
  await verifySameInstantDirectRollbackCompletion(create);
  await verifyDrainingRollbackCompletion(create);
  await verifySameInstantDrainingRollbackCompletionRejection(create);
  await verifyRollbackRejectsNonFlatAndStaleRequests(create);
  await verifyRollbackCompletionCasMisses(create);
  await verifyRollbackSnapshotsInputsAndSerializesConcurrentRequests(create);
}

async function verifyNonFlatActiveRollbackStart(create: CandidatePilotRepositoryFactory): Promise<void> {
  const repository = await create();
  const deployment = await createActiveDeployment(repository, "rollback-start-non-flat");
  await repository.advanceStateWithEvidence(advanceInput(deployment.id, "rollback-start-entry", 0, {
    executedAt: "2026-08-21T00:00:02.000000000Z",
  }));
  const current = await requireRollbackAuthority(repository, deployment.id);
  const input = rollbackInput(current, "2026-08-21T00:00:03.000000000Z");

  const transitioned = await repository.startRollback(input);

  assert.equal(transitioned?.phase, "DRAINING");
  assert.equal(transitioned?.updatedAt, input.transitionAt);
  assertDetachedDeployment(repository, deployment.id, transitioned);
  assert.deepEqual((await repository.listAuditEvents(deployment.id)).at(-1), rollbackAudit({
    deploymentId: deployment.id,
    eventType: "ROLLBACK_STARTED",
    fromPhase: "ACTIVE",
    toPhase: "DRAINING",
    stateVersion: current.state.stateVersion,
    transitionAt: input.transitionAt,
  }));
}

async function verifyPristinePendingRollbackCompletion(create: CandidatePilotRepositoryFactory): Promise<void> {
  const repository = await create();
  const deployment = await repository.createDeploymentWithInitialState(
    initialDeploymentInput("rollback-complete-pending"),
  );
  const current = await requireRollbackAuthority(repository, deployment.id);
  const input = rollbackInput(current, "2026-08-21T00:00:01.000000000Z");

  const transitioned = await repository.completeRollback(input);

  assert.equal(transitioned?.phase, "DISABLED");
  assert.deepEqual((await repository.listAuditEvents(deployment.id)).at(-1), rollbackAudit({
    deploymentId: deployment.id,
    eventType: "ROLLBACK_COMPLETED",
    fromPhase: "PENDING_FLAT",
    toPhase: "DISABLED",
    stateVersion: 0,
    transitionAt: input.transitionAt,
  }));
}

async function verifyFullyExitedActiveRollbackCompletion(create: CandidatePilotRepositoryFactory): Promise<void> {
  const repository = await create();
  const deployment = await createActiveDeployment(repository, "rollback-complete-active");
  await repository.advanceStateWithEvidence(advanceInput(deployment.id, "rollback-complete-entry", 0, {
    executedAt: "2026-08-21T00:00:02.000000000Z",
  }));
  await repository.advanceStateWithEvidence(advanceInput(deployment.id, "rollback-complete-exit", 1, {
    action: "EXIT",
    entryPath: "NONE",
    executedAt: "2026-08-21T00:00:03.000000000Z",
    remainingQuantity: "0",
  }));
  const current = await requireRollbackAuthority(repository, deployment.id);
  assertRollbackFlat(current.state);
  const input = rollbackInput(current, "2026-08-21T00:00:04.000000000Z");

  const transitioned = await repository.completeRollback(input);

  assert.equal(transitioned?.phase, "DISABLED");
  assert.equal((await repository.getExactState(deployment.id))?.lastFullExitAt,
    "2026-08-21T00:00:03.000000000Z");
  assert.equal((await repository.listEvidenceRecords(deployment.id)).length, 2);
}

async function verifySameInstantDirectRollbackCompletion(create: CandidatePilotRepositoryFactory): Promise<void> {
  const pendingRepository = await create();
  const pending = await pendingRepository.createDeploymentWithInitialState(
    initialDeploymentInput("rollback-complete-pending-same-instant"),
  );
  const pendingAuthority = await requireRollbackAuthority(pendingRepository, pending.id);
  const pendingCompleted = await pendingRepository.completeRollback(
    rollbackInput(pendingAuthority, pending.updatedAt),
  );
  assert.equal(pendingCompleted?.phase, "DISABLED");
  assert.deepEqual(
    (await pendingRepository.listAuditEvents(pending.id)).map((event) => event.eventType),
    ["DEPLOYMENT_CREATED", "ROLLBACK_COMPLETED"],
  );

  const activeRepository = await create();
  const active = await createActiveDeployment(activeRepository, "rollback-complete-active-same-instant");
  const activeAuthority = await requireRollbackAuthority(activeRepository, active.id);
  const activeCompleted = await activeRepository.completeRollback(
    rollbackInput(activeAuthority, active.updatedAt),
  );
  assert.equal(activeCompleted?.phase, "DISABLED");
  assert.deepEqual(
    (await activeRepository.listAuditEvents(active.id)).map((event) => event.eventType),
    ["DEPLOYMENT_CREATED", "PHASE_TRANSITION", "ROLLBACK_COMPLETED"],
  );
}

async function verifyDrainingRollbackCompletion(create: CandidatePilotRepositoryFactory): Promise<void> {
  const repository = await create();
  const deployment = await createActiveDeployment(repository, "rollback-complete-draining");
  const active = await requireRollbackAuthority(repository, deployment.id);
  const started = await repository.startRollback(rollbackInput(active, "2026-08-21T00:00:02.000000000Z"));
  assert.equal(started?.phase, "DRAINING");
  const draining = await requireRollbackAuthority(repository, deployment.id);
  const completed = await repository.completeRollback(
    rollbackInput(draining, "2026-08-21T00:00:03.000000000Z"),
  );

  assert.equal(completed?.phase, "DISABLED");
}

async function verifySameInstantDrainingRollbackCompletionRejection(
  create: CandidatePilotRepositoryFactory,
): Promise<void> {
  const repository = await create();
  const deployment = await createActiveDeployment(repository, "rollback-complete-draining-same-instant");
  const active = await requireRollbackAuthority(repository, deployment.id);
  const rollbackAt = "2026-08-21T00:00:02.000000000Z";
  const started = await repository.startRollback(rollbackInput(active, rollbackAt));
  assert.equal(started?.phase, "DRAINING");
  const draining = await requireRollbackAuthority(repository, deployment.id);
  const deploymentBefore = await repository.getDeployment(deployment.id);
  const auditsBefore = await repository.listAuditEvents(deployment.id);

  await assert.rejects(
    () => repository.completeRollback(rollbackInput(draining, rollbackAt)),
    /strictly after|chronology/i,
  );

  assert.deepEqual(await repository.getDeployment(deployment.id), deploymentBefore);
  assert.deepEqual(await repository.listAuditEvents(deployment.id), auditsBefore);
}

export async function verifyCandidatePilotDrainingFaultChronology(input: {
  repository: CandidatePilotRepository;
  getExecutionState: () => Promise<unknown>;
  listExecutionTransitions: () => Promise<readonly unknown[]>;
}): Promise<void> {
  const deployment = await createActiveDeployment(input.repository, "draining-fault-same-instant");
  const active = await requireRollbackAuthority(input.repository, deployment.id);
  const rollbackAt = "2026-08-21T00:00:02.000000000Z";
  const started = await input.repository.startRollback(rollbackInput(active, rollbackAt));
  assert.equal(started?.phase, "DRAINING");
  const latestAuditAt = "2026-08-21T00:00:03.000000000Z";
  await input.repository.advanceStateWithEvidence(advanceInput(deployment.id, "draining-fault-latest-evidence", 0, {
    executedAt: latestAuditAt,
  }));
  const deploymentBefore = await input.repository.getDeployment(deployment.id);
  const stateBefore = await input.repository.getExactState(deployment.id);
  const evidenceBefore = await input.repository.listEvidenceRecords(deployment.id);
  const auditsBefore = await input.repository.listAuditEvents(deployment.id);
  const executionStateBefore = await input.getExecutionState();
  const executionTransitionsBefore = await input.listExecutionTransitions();
  assert.equal(auditsBefore.at(-1)?.eventType, "STATE_ADVANCED");
  assert.equal(auditsBefore.at(-1)?.createdAt, latestAuditAt);

  for (const faultId of ["000-draining-fault-same-audit", "zzz-draining-fault-same-audit"]) {
    await assert.rejects(
      () => input.repository.pauseForRecoveryFault({
        deploymentId: deployment.id,
        exchangeAccountId: deployment.exchangeAccountId,
        faultId,
        reasonCode: "REPLAY_MISMATCH",
        provenanceJson: "{}",
        occurredAt: latestAuditAt,
      }),
      /strictly after|chronology/i,
    );

    assert.deepEqual(await input.repository.getDeployment(deployment.id), deploymentBefore);
    assert.deepEqual(await input.repository.getExactState(deployment.id), stateBefore);
    assert.deepEqual(await input.repository.listEvidenceRecords(deployment.id), evidenceBefore);
    assert.deepEqual(await input.repository.listAuditEvents(deployment.id), auditsBefore);
    assert.deepEqual(await input.getExecutionState(), executionStateBefore);
    assert.deepEqual(await input.listExecutionTransitions(), executionTransitionsBefore);
  }
}

async function verifyRollbackRejectsNonFlatAndStaleRequests(create: CandidatePilotRepositoryFactory): Promise<void> {
  const repository = await create();
  const deployment = await createActiveDeployment(repository, "rollback-rejections");
  await repository.advanceStateWithEvidence(advanceInput(deployment.id, "rollback-rejections-entry", 0, {
    executedAt: "2026-08-21T00:00:02.000000000Z",
  }));
  const current = await requireRollbackAuthority(repository, deployment.id);
  const nonFlat = rollbackInput(current, "2026-08-21T00:00:03.000000000Z");
  await assert.rejects(() => repository.completeRollback(nonFlat), /flat|zero/i);
  assert.equal((await repository.getDeployment(deployment.id))?.phase, "ACTIVE");
  assert.equal((await repository.listAuditEvents(deployment.id)).length, 3);

  const staleVersion = { ...nonFlat, expectedStateVersion: current.state.stateVersion - 1 };
  const staleUpdatedAt = { ...nonFlat, expectedUpdatedAt: "2026-08-21T00:00:00.000Z" };
  const stalePhase = { ...nonFlat, expectedPhase: "PENDING_FLAT" as const };
  for (const staleInput of [staleVersion, staleUpdatedAt, stalePhase]) {
    const deploymentBefore = await repository.getDeployment(deployment.id);
    const auditsBefore = await repository.listAuditEvents(deployment.id);
    assert.equal(await repository.startRollback(staleInput), null);
    assert.deepEqual(await repository.getDeployment(deployment.id), deploymentBefore);
    assert.deepEqual(await repository.listAuditEvents(deployment.id), auditsBefore);
  }
  await assert.rejects(
    () => repository.startRollback({
      ...nonFlat,
      transitionAt: "2026-08-21T00:00:01.000000000Z",
      transitionEpochNs: parsePositionGuardCandidateTimestamp(
        "2026-08-21T00:00:01.000000000Z",
        "stale rollback transition",
      ),
    }),
    /chronology|precede/i,
  );
  await assert.rejects(
    () => repository.startRollback({
      ...nonFlat,
      transitionAt: "2026-08-21T00:00:03.000000000",
    }),
    /invalid|timezone|ISO|timestamp/i,
  );
  await assert.rejects(
    () => repository.startRollback({ ...nonFlat, transitionEpochNs: nonFlat.transitionEpochNs + 1n }),
    /epoch|timestamp/i,
  );
  assert.equal((await repository.getDeployment(deployment.id))?.phase, "ACTIVE");
  assert.equal((await repository.listAuditEvents(deployment.id)).length, 3);
}

async function verifyRollbackSnapshotsInputsAndSerializesConcurrentRequests(
  create: CandidatePilotRepositoryFactory,
): Promise<void> {
  const repository = await create();
  const deployment = await createActiveDeployment(repository, "rollback-concurrency");
  const active = await requireRollbackAuthority(repository, deployment.id);
  const startInput = rollbackInput(active, "2026-08-21T00:00:02.000000000Z");
  const firstStart = repository.startRollback(startInput);
  startInput.deploymentId = "mutated-after-start";
  startInput.expectedStateVersion = 999;
  const secondStart = repository.startRollback({ ...rollbackInput(active, "2026-08-21T00:00:02.000000000Z") });
  const startResults = await Promise.all([firstStart, secondStart]);
  assert.equal(startResults.filter((result) => result !== null).length, 1);
  assert.equal((await repository.getDeployment(deployment.id))?.phase, "DRAINING");
  assert.equal((await repository.listAuditEvents(deployment.id)).filter(
    (event) => event.eventType === "ROLLBACK_STARTED",
  ).length, 1);

  const draining = await requireRollbackAuthority(repository, deployment.id);
  const completionInput = rollbackInput(draining, "2026-08-21T00:00:03.000000000Z");
  const firstCompletion = repository.completeRollback(completionInput);
  completionInput.transitionAt = "2026-08-21T00:00:04.000000000Z";
  completionInput.transitionEpochNs = parsePositionGuardCandidateTimestamp(
    completionInput.transitionAt,
    "mutated completion transition",
  );
  const secondCompletion = repository.completeRollback(rollbackInput(draining, "2026-08-21T00:00:03.000000000Z"));
  const completionResults = await Promise.all([firstCompletion, secondCompletion]);
  assert.equal(completionResults.filter((result) => result !== null).length, 1);
  assert.equal((await repository.getDeployment(deployment.id))?.phase, "DISABLED");
  assert.equal((await repository.listAuditEvents(deployment.id)).filter(
    (event) => event.eventType === "ROLLBACK_COMPLETED",
  ).length, 1);
}

async function verifyRollbackCompletionCasMisses(create: CandidatePilotRepositoryFactory): Promise<void> {
  const repository = await create();
  const deployment = await createActiveDeployment(repository, "rollback-completion-cas-miss");
  const active = await requireRollbackAuthority(repository, deployment.id);
  await repository.startRollback(rollbackInput(active, "2026-08-21T00:00:02.000000000Z"));
  const draining = await requireRollbackAuthority(repository, deployment.id);
  const completion = rollbackInput(draining, "2026-08-21T00:00:03.000000000Z");
  const completed = await repository.completeRollback(completion);
  assert.equal(completed?.phase, "DISABLED");
  const auditCountAfterCompletion = (await repository.listAuditEvents(deployment.id)).length;
  const disabled = await requireRollbackAuthority(repository, deployment.id);

  assert.equal(await repository.completeRollback(completion), null);
  assert.equal((await repository.getDeployment(deployment.id))?.phase, "DISABLED");
  assert.equal((await repository.listAuditEvents(deployment.id)).length, auditCountAfterCompletion);
  assert.equal(await repository.completeRollback(rollbackInput(disabled, "2026-08-21T00:00:04.000000000Z")), null);
  assert.equal((await repository.getDeployment(deployment.id))?.phase, "DISABLED");
  assert.equal((await repository.listAuditEvents(deployment.id)).length, auditCountAfterCompletion);

  const staleRepository = await create();
  const staleDeployment = await createActiveDeployment(staleRepository, "rollback-completion-stale");
  const staleActive = await requireRollbackAuthority(staleRepository, staleDeployment.id);
  await staleRepository.startRollback(rollbackInput(staleActive, "2026-08-21T00:00:02.000000000Z"));
  const staleDraining = await requireRollbackAuthority(staleRepository, staleDeployment.id);
  const validCompletion = rollbackInput(staleDraining, "2026-08-21T00:00:03.000000000Z");
  const staleInputs = [
    { ...validCompletion, expectedStateVersion: staleDraining.state.stateVersion + 1 },
    { ...validCompletion, expectedUpdatedAt: staleActive.deployment.updatedAt },
    { ...validCompletion, expectedPhase: "ACTIVE" as const },
  ];
  for (const staleInput of staleInputs) {
    const deploymentBefore = await staleRepository.getDeployment(staleDeployment.id);
    const auditsBefore = await staleRepository.listAuditEvents(staleDeployment.id);
    assert.equal(await staleRepository.completeRollback(staleInput), null);
    assert.deepEqual(await staleRepository.getDeployment(staleDeployment.id), deploymentBefore);
    assert.deepEqual(await staleRepository.listAuditEvents(staleDeployment.id), auditsBefore);
  }
}

async function createActiveDeployment(
  repository: CandidatePilotRepository,
  id: string,
) {
  const deployment = await repository.createDeploymentWithInitialState(initialDeploymentInput(id));
  const activationAt = "2026-08-21T00:00:01.000000000Z";
  const activated = await repository.activateDeployment({
    deploymentId: deployment.id,
    expectedPhase: "PENDING_FLAT",
    expectedUpdatedAt: deployment.updatedAt,
    activationAt,
    activationEpochNs: parsePositionGuardCandidateTimestamp(activationAt, "rollback activation"),
  });
  assert.ok(activated);
  return activated;
}

async function requireRollbackAuthority(repository: CandidatePilotRepository, deploymentId: string) {
  const deployment = await repository.getDeployment(deploymentId);
  const state = await repository.getExactState(deploymentId);
  assert.ok(deployment);
  assert.ok(state);
  return { deployment, state };
}

function rollbackInput(
  authority: Awaited<ReturnType<typeof requireRollbackAuthority>>,
  transitionAt: string,
) {
  return {
    deploymentId: authority.deployment.id,
    expectedPhase: authority.deployment.phase,
    expectedUpdatedAt: authority.deployment.updatedAt,
    expectedStateVersion: authority.state.stateVersion,
    transitionAt,
    transitionEpochNs: parsePositionGuardCandidateTimestamp(transitionAt, "rollback transition"),
  };
}

function rollbackAudit(input: {
  deploymentId: string;
  eventType: "ROLLBACK_STARTED" | "ROLLBACK_COMPLETED";
  fromPhase: PositionGuardPilotAuditEventRecord["fromPhase"];
  toPhase: PositionGuardPilotAuditEventRecord["toPhase"];
  stateVersion: number;
  transitionAt: string;
}): PositionGuardPilotAuditEventRecord {
  return {
    id: `${input.deploymentId}:${input.eventType.toLowerCase()}:${parsePositionGuardCandidateTimestamp(
      input.transitionAt,
      "rollback audit transition",
    ).toString()}`,
    deploymentId: input.deploymentId,
    eventType: input.eventType,
    fromPhase: input.fromPhase,
    toPhase: input.toPhase,
    stateVersion: input.stateVersion,
    payloadJson: JSON.stringify({ transitionAt: input.transitionAt }),
    createdAt: input.transitionAt,
  };
}

function assertRollbackFlat(state: NonNullable<Awaited<ReturnType<CandidatePilotRepository["getExactState"]>>>) {
  assert.equal(state.currentEpisodeAddCount, 0);
  assert.equal(state.currentEpisodeCostBasisKrw, "0");
  assert.equal(state.currentEpisodeInventoryQuantity, "0");
  assert.equal(state.currentEpisodeRealizedPnlKrw, "0");
}

async function assertDetachedDeployment(
  repository: CandidatePilotRepository,
  deploymentId: string,
  deployment: Awaited<ReturnType<CandidatePilotRepository["startRollback"]>>,
): Promise<void> {
  assert.ok(deployment);
  deployment.phase = "ACTIVE";
  assert.equal((await repository.getDeployment(deploymentId))?.phase, "DRAINING");
}

test("in-memory candidate pilot repository satisfies the common contract", async () => {
  await verifyCandidatePilotRepositoryContract(() => new InMemoryCandidatePilotRepository());
});

test("in-memory candidate pilot repository atomically initializes a frozen deployment authority", async () => {
  await verifyAtomicDeploymentInitializationContract(() => new InMemoryCandidatePilotRepository());
});

test("in-memory candidate pilot initialization snapshots caller input before queued work", async () => {
  const repository = new InMemoryCandidatePilotRepository();
  const input = initialDeploymentInput("deployment-input-snapshot");
  const requestedCreatedAt = input.deployment.createdAt;

  const initialization = repository.initializeDeploymentWithInitialState(input);
  input.deployment.createdAt = "2026-08-22T00:00:00.000Z";
  input.deployment.updatedAt = "2026-08-22T00:00:00.000Z";

  const result = await initialization;
  assert.equal(result.deployment.createdAt, requestedCreatedAt);
  assert.equal(result.deployment.updatedAt, requestedCreatedAt);
});

test("in-memory exact recovery lookup ignores an earlier foreign-account deployment", async () => {
  const repository = new InMemoryCandidatePilotRepository();
  await repository.createDeploymentWithInitialState(
    initialDeploymentInput("deployment-foreign-account", "foreign-account"),
  );
  const target = await repository.createDeploymentWithInitialState(
    initialDeploymentInput("deployment-target", "primary"),
  );

  const matches = await repository.findDeploymentsForRecoveryIdentity({
    exchangeAccountId: target.exchangeAccountId,
    pilotId: target.pilotId,
    market: target.market,
    policyId: target.policyId,
    policyVersion: target.policyVersion,
  });

  assert.deepEqual(matches.map((deployment) => deployment.id), [target.id]);
});

test("in-memory candidate pilot replay orders mixed offsets by epoch nanosecond and id", async () => {
  await verifyMixedOffsetReplayContract(() => new InMemoryCandidatePilotRepository());
});

test("in-memory candidate evidence identity is scoped to its deployment", async () => {
  await verifyDeploymentScopedEvidenceIdentityContract(
    () => new InMemoryCandidatePilotRepository(),
  );
});

test("in-memory candidate pilot rejects pre-epoch evidence without mutation", async () => {
  await verifyPreEpochEvidenceRejectionContract(() => new InMemoryCandidatePilotRepository());
});

test("in-memory candidate pilot repository rejects forged persisted identity", async () => {
  await verifyCandidatePilotIdentityValidation(() => new InMemoryCandidatePilotRepository());
});

test("in-memory candidate pilot activation persists an actual active instant with compare-and-set", async () => {
  await verifyCandidateDeploymentActivationContract(() => new InMemoryCandidatePilotRepository());
});

test("in-memory candidate pilot rollback persistence satisfies the common contract", async () => {
  await verifyCandidatePilotRollbackContract(() => new InMemoryCandidatePilotRepository());
});

test("in-memory draining recovery faults require strict forward chronology without partial mutation", async () => {
  const operatorState = new InMemoryOperatorStateStore({
    id: "execution_state_primary",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const repository = new InMemoryCandidatePilotRepository(operatorState);

  await verifyCandidatePilotDrainingFaultChronology({
    repository,
    getExecutionState: () => operatorState.getState(),
    listExecutionTransitions: () => operatorState.listTransitions(Number.MAX_SAFE_INTEGER),
  });
});

test("in-memory rollback completion rejects a persisted PAUSED_FAULT without mutation or audit", async () => {
  const operatorState = new InMemoryOperatorStateStore({
    id: "execution_state_primary",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-21T00:00:00.000Z",
  });
  const repository = new InMemoryCandidatePilotRepository(operatorState);
  const deployment = await repository.createDeploymentWithInitialState(initialDeploymentInput("rollback-paused-fault"));
  await repository.pauseForRecoveryFault({
    deploymentId: deployment.id,
    exchangeAccountId: deployment.exchangeAccountId,
    faultId: "rollback-paused-fault",
    reasonCode: "REPLAY_MISMATCH",
    provenanceJson: "{}",
    occurredAt: "2026-08-21T00:00:01.000000000Z",
  });
  const paused = await requireRollbackAuthority(repository, deployment.id);
  const auditCount = (await repository.listAuditEvents(deployment.id)).length;

  assert.equal(
    await repository.completeRollback(rollbackInput(paused, "2026-08-21T00:00:02.000000000Z")),
    null,
  );
  assert.equal((await repository.getDeployment(deployment.id))?.phase, "PAUSED_FAULT");
  assert.equal((await repository.listAuditEvents(deployment.id)).length, auditCount);
});

test("exact candidate residuals use the canonical persisted quantity tolerance", () => {
  assert.equal(EXACT_CANDIDATE_QUANTITY_TOLERANCE, "0.000000000001");
  assert.equal(deriveExactRemainingQuantity({
    currentQuantity: "1.0000000000001",
    action: "EXIT",
    executedQuantity: "1",
  }), "0");
});
