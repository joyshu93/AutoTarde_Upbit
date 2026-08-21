import assert from "node:assert/strict";

import {
  createEmptyPositionGuardCandidateState,
  type PositionGuardCandidateExecutionEvidence,
} from "../src/modules/strategy/position-guard-candidate-state.js";
import type {
  AdvanceCandidatePilotStateInput,
  CandidatePilotRepository,
  CreateCandidatePilotDeploymentInput,
} from "../src/modules/db/pilot-interfaces.js";
import { InMemoryCandidatePilotRepository } from
  "../src/modules/db/repositories/in-memory-candidate-pilot-repository.js";
import { test } from "./harness.js";

export type CandidatePilotRepositoryFactory = () =>
  CandidatePilotRepository | Promise<CandidatePilotRepository>;

export function initialDeploymentInput(
  id = "deployment-contract",
): CreateCandidatePilotDeploymentInput {
  return {
    deployment: {
      id,
      exchangeAccountId: "primary",
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      phase: "PENDING_FLAT",
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
    executedQuantity: 0.1,
    grossQuoteValueKrw: 10_000_000,
    confirmedFeeKrw: 5_000,
    remainingQuantity: 0.1,
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

export async function verifyCandidatePilotRepositoryContract(
  create: CandidatePilotRepositoryFactory,
): Promise<void> {
  const repository = await create();
  const input = initialDeploymentInput();
  const deployment = await repository.createDeploymentWithInitialState(input);

  const first = await repository.advanceStateWithEvidence(
    advanceInput(deployment.id, "e1", 0),
  );
  const duplicateEvidence: PositionGuardCandidateExecutionEvidence = {
    remainingQuantity: 0.1,
    confirmedFeeKrw: 5_000,
    grossQuoteValueKrw: 10_000_000,
    executedQuantity: 0.1,
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
      advanceInput(deployment.id, "e1", 0, { confirmedFeeKrw: 5_001 }),
    ),
    /conflicting duplicate/i,
  );
  await assert.rejects(
    () => repository.advanceStateWithEvidence(
      advanceInput(deployment.id, "e2", 0, {
        action: "ADD",
        executedAt: "2026-08-21T00:00:02.000Z",
        remainingQuantity: 0.2,
      }),
    ),
    /state version/i,
  );

  assert.equal((await repository.getState(deployment.id))?.stateVersion, 1);
  assert.equal((await repository.listEvidenceAfter(deployment.id, null)).length, 1);
  assert.equal((await repository.listAuditEvents(deployment.id)).length, 2);

  const forgedEvidence = {
    ...candidateEvidence("e2", {
      action: "ADD",
      executedAt: "2026-08-21T00:00:02.000Z",
      remainingQuantity: 0.2,
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
    advanceInput(deployment.id, "evidence-a", 0, {
      executedAt: "2026-08-21T09:00:00+09:00",
    }),
  );
  await repository.advanceStateWithEvidence(
    advanceInput(deployment.id, "evidence-b", 1, {
      action: "ADD",
      executedAt: "2026-08-21T00:00:00.000000001Z",
      executedQuantity: 0.05,
      grossQuoteValueKrw: 5_000_000,
      confirmedFeeKrw: 2_500,
      remainingQuantity: 0.15,
    }),
  );
  await repository.advanceStateWithEvidence(
    advanceInput(deployment.id, "evidence-c", 2, {
      action: "ADD",
      executedAt: "2026-08-21T00:00:00.000000001Z",
      executedQuantity: 0.05,
      grossQuoteValueKrw: 5_000_000,
      confirmedFeeKrw: 2_500,
      remainingQuantity: 0.2,
    }),
  );

  const evidence = await repository.listEvidenceAfter(deployment.id, null);
  assert.deepEqual(
    evidence.map((item) => item.evidenceId),
    ["evidence-a", "evidence-b", "evidence-c"],
  );
  assert.deepEqual(
    (await repository.listEvidenceAfter(deployment.id, "evidence-a"))
      .map((item) => item.evidenceId),
    ["evidence-b", "evidence-c"],
  );
  assert.equal((await repository.getState(deployment.id))?.stateVersion, 3);
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

test("in-memory candidate pilot repository satisfies the common contract", async () => {
  await verifyCandidatePilotRepositoryContract(() => new InMemoryCandidatePilotRepository());
});

test("in-memory candidate pilot replay orders mixed offsets by epoch nanosecond and id", async () => {
  await verifyMixedOffsetReplayContract(() => new InMemoryCandidatePilotRepository());
});

test("in-memory candidate pilot repository rejects forged persisted identity", async () => {
  await verifyCandidatePilotIdentityValidation(() => new InMemoryCandidatePilotRepository());
});
