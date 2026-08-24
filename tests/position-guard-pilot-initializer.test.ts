import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  PositionGuardPilotInitializer,
  type PositionGuardPilotInitializerClock,
  type PositionGuardPilotInitializerIdentity,
  type PositionGuardPilotInitializerRepository,
} from "../src/app/position-guard-pilot-initializer.js";
import type {
  PositionGuardPilotAuditEventRecord,
  PositionGuardPilotDeploymentRecord,
} from "../src/domain/pilot-types.js";
import type {
  CandidateEvidenceRecord,
  CandidatePilotDeploymentInitializationResult,
  CreateCandidatePilotDeploymentInput,
} from "../src/modules/db/pilot-interfaces.js";
import {
  candidateEvidenceMaterial,
  parseCandidatePilotTimestamp,
} from "../src/modules/db/pilot-interfaces.js";
import {
  createExactEmptyCandidateState,
  projectExactCandidateState,
  type ExactCandidateState,
} from "../src/modules/execution/candidate-evidence-decimals.js";
import { InMemoryCandidatePilotRepository } from "../src/modules/db/repositories/in-memory-candidate-pilot-repository.js";
import type { PositionGuardCandidateExecutionEvidence } from "../src/modules/strategy/position-guard-candidate-state.js";
import { test } from "./harness.js";

const NOW = "2026-08-24T00:00:00.000000001Z";
const CREATED_AT = "2026-08-23T23:59:59.000000001Z";
const IDENTITY: PositionGuardPilotInitializerIdentity = {
  exchangeAccountId: "primary",
  pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
  market: "KRW-BTC",
  policyId: "COMBINED_CONSERVATIVE",
  policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
};

test("candidate initializer creates one deterministic pristine PENDING_FLAT authority", async () => {
  const fixture = createFixture({ outcome: "CREATED", createdAt: NOW });

  const result = await fixture.initializer.initialize();

  assert.equal(fixture.clockCalls(), 1);
  assert.equal(fixture.repositoryCalls(), 1);
  assert.equal(result.outcome, "CREATED");
  assert.equal(result.deploymentId, expectedDeploymentId(IDENTITY));
  assert.deepEqual(result.identity, IDENTITY);
  assert.deepEqual(fixture.requests(), [{
    deployment: {
      id: expectedDeploymentId(IDENTITY),
      ...IDENTITY,
      phase: "PENDING_FLAT",
      activationAt: null,
      activationEpochNs: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    initialState: {
      currentEpisodeAddCount: 0,
      currentEpisodeCostBasisKrw: 0,
      currentEpisodeInventoryQuantity: 0,
      currentEpisodeRealizedPnlKrw: 0,
      lastFullExitAt: null,
      lastFullExitRealizedPnlKrw: null,
      lastEntryPath: null,
      lastEvidenceAt: null,
      lastEvidenceId: null,
      stateVersion: 0,
    },
  }]);
  assert.deepEqual(result.exactState, createExactEmptyCandidateState());
  assert.deepEqual(result.evidenceRecords, []);
  assert.deepEqual(result.auditEvents, [creationAudit(result.deployment)]);
});

test("candidate initializer restart preserves persisted timestamps and state", async () => {
  const persisted = validAuthority({ outcome: "EXISTING", createdAt: CREATED_AT });
  const fixture = createFixture({ result: persisted });

  const result = await fixture.initializer.initialize();

  assert.equal(result.outcome, "EXISTING");
  assert.equal(result.deployment.createdAt, CREATED_AT);
  assert.equal(result.deployment.updatedAt, CREATED_AT);
  assert.deepEqual(result.exactState, persisted.exactState);
  assert.equal(fixture.requests()[0]?.deployment.createdAt, NOW);
});

test("candidate initializer real repository restart keeps the first persisted authority", async () => {
  const repository = new InMemoryCandidatePilotRepository();
  const times = [CREATED_AT, NOW];
  let clockCalls = 0;
  const initializer = new PositionGuardPilotInitializer({
    identity: IDENTITY,
    repository: {
      initializeDeploymentWithInitialState:
        repository.initializeDeploymentWithInitialState.bind(repository),
    },
    clock: {
      now() {
        const value = times[clockCalls];
        clockCalls += 1;
        if (value === undefined) throw new Error("unexpected clock call");
        return value;
      },
    },
  });

  const created = await initializer.initialize();
  const restarted = await initializer.initialize();

  assert.equal(created.outcome, "CREATED");
  assert.equal(restarted.outcome, "EXISTING");
  assert.equal(clockCalls, 2);
  assert.deepEqual(restarted.deployment, created.deployment);
  assert.deepEqual(restarted.exactState, created.exactState);
  assert.deepEqual(restarted.auditEvents, created.auditEvents);
});

test("candidate initializer deployment id is canonical across immutable equivalent identities", async () => {
  const first = createFixture({ outcome: "CREATED", createdAt: NOW });
  const mutableIdentity = { ...IDENTITY };
  const second = createFixture({
    outcome: "CREATED",
    createdAt: NOW,
    identity: mutableIdentity,
  });
  mutableIdentity.exchangeAccountId = "mutated-after-construction";

  const [firstResult, secondResult] = await Promise.all([
    first.initializer.initialize(),
    second.initializer.initialize(),
  ]);

  assert.equal(firstResult.deploymentId, secondResult.deploymentId);
  assert.equal(secondResult.identity.exchangeAccountId, "primary");
  assert.equal(Object.isFrozen(secondResult.identity), true);
});

test("candidate initializer snapshots its strict ISO clock exactly once per call", async () => {
  const fixture = createFixture({ outcome: "CREATED", createdAt: NOW });
  await fixture.initializer.initialize();
  assert.equal(fixture.clockCalls(), 1);

  const invalidClock = createFixture({ outcome: "CREATED", createdAt: NOW, now: "not-a-timestamp" });
  await assert.rejects(() => invalidClock.initializer.initialize(), /clock|timestamp|ISO/i);
  assert.equal(invalidClock.clockCalls(), 1);
  assert.equal(invalidClock.repositoryCalls(), 0);
});

test("candidate initializer accepts structurally intact ACTIVE and PAUSED_FAULT restart authority", async () => {
  for (const phase of ["ACTIVE", "PAUSED_FAULT"] as const) {
    const evidence = executedEnterEvidence();
    const authority = validAuthority({
      outcome: "EXISTING",
      createdAt: CREATED_AT,
      phase,
      activationAt: "2026-08-23T23:59:59.500000001Z",
      evidence,
    });
    const fixture = createFixture({ result: authority });

    const result = await fixture.initializer.initialize();

    assert.equal(result.deployment.phase, phase);
    assert.deepEqual(result.exactState, projectExactCandidateState([evidence]));
  }
});

test("candidate initializer rejects disabled, draining, unsupported, and created non-pending phases", async () => {
  const cases: Array<{
    label: string;
    authority: CandidatePilotDeploymentInitializationResult;
  }> = [
    {
      label: "DISABLED",
      authority: validAuthority({ outcome: "EXISTING", createdAt: CREATED_AT, phase: "DISABLED" }),
    },
    {
      label: "DRAINING",
      authority: validAuthority({
        outcome: "EXISTING",
        createdAt: CREATED_AT,
        phase: "DRAINING",
        activationAt: "2026-08-23T23:59:59.500000001Z",
      }),
    },
    {
      label: "unsupported",
      authority: validAuthority({ outcome: "EXISTING", createdAt: CREATED_AT, phase: "PENDING_FLAT" }),
    },
    {
      label: "CREATED ACTIVE",
      authority: validAuthority({
        outcome: "CREATED",
        createdAt: CREATED_AT,
        phase: "ACTIVE",
        activationAt: "2026-08-23T23:59:59.500000001Z",
      }),
    },
  ];
  (cases[2]!.authority.deployment as { phase: string }).phase = "UNKNOWN";

  for (const entry of cases) {
    const fixture = createFixture({ result: entry.authority });
    await assert.rejects(
      () => fixture.initializer.initialize(),
      new RegExp(`${entry.label}|phase|unsupported|disabled|draining|newly created|PENDING_FLAT`, "i"),
      entry.label,
    );
  }
});

test("candidate initializer rejects malformed identity, deployment id, and future persisted time", async () => {
  const cases = [
    mutateAuthority((authority) => {
      authority.deployment.id = "wrong-id";
    }),
    mutateAuthority((authority) => {
      authority.deployment.exchangeAccountId = "foreign-account";
    }),
    mutateAuthority((authority) => {
      authority.deployment.createdAt = "2026-08-24T00:00:00.000000002Z";
      authority.deployment.updatedAt = authority.deployment.createdAt;
      authority.auditEvents[0]!.createdAt = authority.deployment.createdAt;
    }),
  ];

  for (const authority of cases) {
    const fixture = createFixture({ result: authority });
    await assert.rejects(() => fixture.initializer.initialize(), /identity|deployment id|future|createdAt/i);
  }
});

test("candidate initializer rejects PENDING_FLAT activation, non-pristine state, evidence, and malformed audit", async () => {
  const activationAt = "2026-08-23T23:59:59.500000001Z";
  const cases = [
    mutateAuthority((authority) => {
      authority.deployment.activationAt = activationAt;
      authority.deployment.activationEpochNs = parseCandidatePilotTimestamp(activationAt, "test activation");
    }),
    mutateAuthority((authority) => {
      authority.exactState.currentEpisodeAddCount = 1;
    }),
    mutateAuthority((authority) => {
      authority.evidenceRecords.push(executedEvidenceRecord(authority.deployment.id));
    }),
    mutateAuthority((authority) => {
      authority.auditEvents[0]!.payloadJson = "{}";
    }),
    mutateAuthority((authority) => {
      authority.auditEvents.push({ ...authority.auditEvents[0]!, id: "duplicate-created" });
    }),
  ];

  for (const authority of cases) {
    const fixture = createFixture({ result: authority });
    await assert.rejects(() => fixture.initializer.initialize(), /PENDING_FLAT|pristine|state|evidence|audit|activation/i);
  }
});

test("candidate initializer rejects ACTIVE authority with corrupted exact state or evidence material", async () => {
  const base = () => validAuthority({
    outcome: "EXISTING",
    createdAt: CREATED_AT,
    phase: "ACTIVE",
    activationAt: "2026-08-23T23:59:59.500000001Z",
    evidence: executedEnterEvidence(),
  });
  const stateMismatch = mutableAuthority(base());
  stateMismatch.exactState.currentEpisodeCostBasisKrw = "1";
  const hashMismatch = mutableAuthority(base());
  hashMismatch.evidenceRecords[0]!.materialHash = "0".repeat(64);
  const futureEvidence = mutableAuthority(base());
  futureEvidence.evidenceRecords[0]!.evidence.executedAt = "2026-08-24T00:00:00.000000002Z";

  for (const authority of [stateMismatch, hashMismatch, futureEvidence]) {
    const fixture = createFixture({ result: authority });
    await assert.rejects(() => fixture.initializer.initialize(), /state|evidence|material|future|timestamp/i);
  }
});

test("candidate initializer returns detached deeply frozen authority and never invokes forbidden collaborators", async () => {
  const source = mutableAuthority(validAuthority({ outcome: "EXISTING", createdAt: CREATED_AT }));
  const fixture = createFixture({ result: source });

  const result = await fixture.initializer.initialize();
  source.deployment.updatedAt = NOW;
  source.auditEvents[0]!.payloadJson = "{}";

  assert.equal(result.deployment.updatedAt, CREATED_AT);
  assert.equal(result.auditEvents[0]?.payloadJson, creationAuditPayload());
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.deployment), true);
  assert.equal(Object.isFrozen(result.exactState), true);
  assert.equal(Object.isFrozen(result.evidenceRecords), true);
  assert.equal(Object.isFrozen(result.auditEvents), true);
  assert.equal(Object.isFrozen(result.auditEvents[0]), true);
});

test("candidate initializer rejects forbidden collaborator dependencies without calling them", () => {
  let forbiddenCalls = 0;
  const dependencies = {
    identity: IDENTITY,
    repository: {
      async initializeDeploymentWithInitialState() {
        throw new Error("not reached");
      },
    },
    clock: { now: () => NOW },
    activate: () => { forbiddenCalls += 1; },
    reconcile: () => { forbiddenCalls += 1; },
    execute: () => { forbiddenCalls += 1; },
    telegram: () => { forbiddenCalls += 1; },
  };

  assert.throws(
    () => new PositionGuardPilotInitializer(
      dependencies as unknown as ConstructorParameters<typeof PositionGuardPilotInitializer>[0],
    ),
    /dependencies|approved own data properties/i,
  );
  assert.equal(forbiddenCalls, 0);
});

function createFixture(input: Readonly<{
  outcome?: "CREATED" | "EXISTING";
  createdAt?: string;
  result?: CandidatePilotDeploymentInitializationResult;
  identity?: PositionGuardPilotInitializerIdentity;
  now?: string;
}>): Readonly<{
  initializer: PositionGuardPilotInitializer;
  clockCalls(): number;
  repositoryCalls(): number;
  requests(): CreateCandidatePilotDeploymentInput[];
}> {
  let clockCalls = 0;
  let repositoryCalls = 0;
  const requests: CreateCandidatePilotDeploymentInput[] = [];
  const now = input.now ?? NOW;
  const identity = { ...(input.identity ?? IDENTITY) };
  const repository: PositionGuardPilotInitializerRepository = {
    async initializeDeploymentWithInitialState(request) {
      repositoryCalls += 1;
      requests.push(structuredClone(request));
      return input.result ?? validAuthority({
        outcome: input.outcome ?? "CREATED",
        createdAt: input.createdAt ?? now,
        identity,
      });
    },
  };
  const clock: PositionGuardPilotInitializerClock = {
    now() {
      clockCalls += 1;
      return now;
    },
  };
  const initializer = new PositionGuardPilotInitializer({
    identity,
    repository,
    clock,
  });
  return Object.freeze({
    initializer,
    clockCalls: () => clockCalls,
    repositoryCalls: () => repositoryCalls,
    requests: () => requests.map((request) => structuredClone(request)),
  });
}

function validAuthority(input: Readonly<{
  outcome: "CREATED" | "EXISTING";
  createdAt: string;
  identity?: PositionGuardPilotInitializerIdentity;
  phase?: PositionGuardPilotDeploymentRecord["phase"];
  activationAt?: string | null;
  evidence?: PositionGuardCandidateExecutionEvidence;
}>): CandidatePilotDeploymentInitializationResult {
  const identity = input.identity ?? IDENTITY;
  const phase = input.phase ?? "PENDING_FLAT";
  const activationAt = input.activationAt ?? null;
  const deployment: PositionGuardPilotDeploymentRecord = {
    id: expectedDeploymentId(identity),
    ...identity,
    phase,
    activationAt,
    activationEpochNs: activationAt === null
      ? null
      : parseCandidatePilotTimestamp(activationAt, "test activationAt"),
    createdAt: input.createdAt,
    updatedAt: activationAt ?? input.createdAt,
  };
  const evidenceRecords = input.evidence
    ? [executedEvidenceRecord(deployment.id, input.evidence)]
    : [];
  const exactState = input.evidence
    ? projectExactCandidateState([input.evidence])
    : createExactEmptyCandidateState();
  const auditEvents: PositionGuardPilotAuditEventRecord[] = [creationAudit(deployment)];
  if (phase === "ACTIVE" || phase === "DRAINING") {
    auditEvents.push({
      id: `${deployment.id}:active`,
      deploymentId: deployment.id,
      eventType: "PHASE_TRANSITION",
      fromPhase: "PENDING_FLAT",
      toPhase: "ACTIVE",
      stateVersion: 0,
      payloadJson: JSON.stringify({ activationAt }),
      createdAt: activationAt!,
    });
  }
  if (phase === "PAUSED_FAULT") {
    auditEvents.push({
      id: `${deployment.id}:paused`,
      deploymentId: deployment.id,
      eventType: "FAULT_PAUSED",
      fromPhase: activationAt === null ? "PENDING_FLAT" : "ACTIVE",
      toPhase: "PAUSED_FAULT",
      stateVersion: exactState.stateVersion,
      payloadJson: JSON.stringify({ reasonCode: "TEST" }),
      createdAt: deployment.updatedAt,
    });
  }
  return {
    outcome: input.outcome,
    deployment,
    exactState,
    evidenceRecords,
    auditEvents,
  };
}

function creationAudit(deployment: PositionGuardPilotDeploymentRecord): PositionGuardPilotAuditEventRecord {
  return {
    id: `${deployment.id}:created`,
    deploymentId: deployment.id,
    eventType: "DEPLOYMENT_CREATED",
    fromPhase: null,
    toPhase: "PENDING_FLAT",
    stateVersion: 0,
    payloadJson: creationAuditPayload(deployment),
    createdAt: deployment.createdAt,
  };
}

function creationAuditPayload(identity: PositionGuardPilotInitializerIdentity = IDENTITY): string {
  return JSON.stringify({
    pilotId: identity.pilotId,
    market: identity.market,
    policyId: identity.policyId,
    policyVersion: identity.policyVersion,
  });
}

function executedEnterEvidence(): PositionGuardCandidateExecutionEvidence {
  return {
    evidenceId: "candidate-enter-1",
    executedAt: "2026-08-23T23:59:59.750000001Z",
    action: "ENTER",
    entryPath: "RECLAIM",
    terminalStatus: "FILLED",
    executedQuantity: "0.1",
    grossQuoteValueKrw: "10000",
    confirmedFeeKrw: "5",
    remainingQuantity: "0.1",
  };
}

function executedEvidenceRecord(
  deploymentId: string,
  evidence: PositionGuardCandidateExecutionEvidence = executedEnterEvidence(),
): CandidateEvidenceRecord {
  const material = candidateEvidenceMaterial(deploymentId, evidence);
  return {
    evidence: { ...material.evidence },
    materialHash: material.hash,
    materialVersion: material.materialVersion,
  };
}

function expectedDeploymentId(identity: PositionGuardPilotInitializerIdentity): string {
  const canonicalIdentity = JSON.stringify({
    exchangeAccountId: identity.exchangeAccountId,
    pilotId: identity.pilotId,
    market: identity.market,
    policyId: identity.policyId,
    policyVersion: identity.policyVersion,
  });
  return `position_guard_pilot_${createHash("sha256").update(canonicalIdentity, "utf8").digest("hex")}`;
}

function mutateAuthority(
  mutation: (authority: ReturnType<typeof mutableAuthority>) => void,
): CandidatePilotDeploymentInitializationResult {
  const authority = mutableAuthority(validAuthority({ outcome: "EXISTING", createdAt: CREATED_AT }));
  mutation(authority);
  return authority;
}

function mutableAuthority(authority: CandidatePilotDeploymentInitializationResult): {
  outcome: "CREATED" | "EXISTING";
  deployment: PositionGuardPilotDeploymentRecord;
  exactState: ExactCandidateState;
  evidenceRecords: Array<{
    evidence: PositionGuardCandidateExecutionEvidence;
    materialHash: string;
    materialVersion: CandidateEvidenceRecord["materialVersion"];
  }>;
  auditEvents: PositionGuardPilotAuditEventRecord[];
} {
  return {
    outcome: authority.outcome,
    deployment: { ...authority.deployment },
    exactState: { ...authority.exactState },
    evidenceRecords: authority.evidenceRecords.map((record) => ({
      evidence: { ...record.evidence },
      materialHash: record.materialHash,
      materialVersion: record.materialVersion,
    })),
    auditEvents: authority.auditEvents.map((event) => ({ ...event })),
  };
}
