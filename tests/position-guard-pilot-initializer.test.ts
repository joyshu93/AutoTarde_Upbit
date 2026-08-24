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
const ROLLBACK_STARTED_AT = "2026-08-23T23:59:59.850000001Z";
const ROLLBACK_STARTED_EPOCH_NS = "1787529599850000001";
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

test("candidate initializer accepts canonical DRAINING restart authority", async () => {
  const authority = drainingAuthority();
  const fixture = createFixture({ result: authority });

  const result = await fixture.initializer.initialize();

  assert.equal(result.deployment.phase, "DRAINING");
  assert.deepEqual(result.exactState, authority.exactState);
  assert.deepEqual(
    result.auditEvents.map((event) => event.eventType),
    ["DEPLOYMENT_CREATED", "PHASE_TRANSITION", "STATE_ADVANCED", "ROLLBACK_STARTED"],
  );
});

test("candidate initializer rejects malformed ACTIVE and PAUSED_FAULT lifecycle audit authority", async () => {
  const active = () => mutableAuthority(validAuthority({
    outcome: "EXISTING",
    createdAt: CREATED_AT,
    phase: "ACTIVE",
    activationAt: "2026-08-23T23:59:59.500000001Z",
    evidence: executedEnterEvidence(),
  }));
  const paused = () => mutableAuthority(validAuthority({
    outcome: "EXISTING",
    createdAt: CREATED_AT,
    phase: "PAUSED_FAULT",
    activationAt: "2026-08-23T23:59:59.500000001Z",
    evidence: executedEnterEvidence(),
  }));
  const cases = [
    (() => {
      const authority = active();
      authority.auditEvents = authority.auditEvents.filter((event) => event.eventType !== "PHASE_TRANSITION");
      return authority;
    })(),
    (() => {
      const authority = active();
      const activation = authority.auditEvents.find((event) => event.eventType === "PHASE_TRANSITION")!;
      activation.payloadJson = "{}";
      return authority;
    })(),
    (() => {
      const authority = paused();
      authority.auditEvents = authority.auditEvents.filter((event) => event.eventType !== "FAULT_PAUSED");
      return authority;
    })(),
    (() => {
      const authority = paused();
      const fault = authority.auditEvents.find((event) => event.eventType === "FAULT_PAUSED")!;
      fault.fromPhase = "PENDING_FLAT";
      return authority;
    })(),
  ];

  for (const authority of cases) {
    const fixture = createFixture({ result: authority });
    await assert.rejects(() => fixture.initializer.initialize(), /activation|fault|lifecycle|audit/i);
  }
});

test("candidate initializer restarts PAUSED_FAULT authority faulted from canonical DRAINING rollback", async () => {
  const authority = pausedFaultFromDrainingAuthority();
  const fixture = createFixture({ result: authority });

  const result = await fixture.initializer.initialize();

  assert.equal(result.deployment.phase, "PAUSED_FAULT");
  assert.deepEqual(
    result.auditEvents.map((event) => event.eventType),
    ["DEPLOYMENT_CREATED", "PHASE_TRANSITION", "STATE_ADVANCED", "ROLLBACK_STARTED", "FAULT_PAUSED"],
  );
  assert.deepEqual(result.exactState, authority.exactState);
});

test("candidate initializer restarts DRAINING fault authority after canonical risk-reducing EXIT evidence", async () => {
  const authority = pausedFaultFromDrainingWithExitAuthority();
  const fixture = createFixture({ result: authority });

  const result = await fixture.initializer.initialize();

  assert.equal(result.deployment.phase, "PAUSED_FAULT");
  assert.equal(result.exactState.stateVersion, 2);
  assert.equal(result.exactState.currentEpisodeInventoryQuantity, "0");
  assert.deepEqual(
    result.auditEvents
      .filter((event) => event.eventType === "STATE_ADVANCED")
      .map((event) => [event.fromPhase, event.toPhase, event.stateVersion]),
    [["ACTIVE", "ACTIVE", 1], ["DRAINING", "DRAINING", 2]],
  );
  assert.equal(rollbackEvent(mutableAuthority(result)).stateVersion, 1);
  assert.equal(faultEvent(mutableAuthority(result)).stateVersion, 2);
});

test("candidate initializer restarts DRAINING fault authority at a zero-state rollback boundary", async () => {
  const authority = pausedFaultFromDrainingWithoutEvidenceAuthority();
  const fixture = createFixture({ result: authority });

  const result = await fixture.initializer.initialize();

  assert.equal(result.deployment.phase, "PAUSED_FAULT");
  assert.equal(result.exactState.stateVersion, 0);
  assert.deepEqual(
    result.auditEvents
      .filter((event) => event.eventType === "STATE_ADVANCED")
      .map((event) => [event.fromPhase, event.toPhase, event.stateVersion]),
    [],
  );
  assert.equal(rollbackEvent(mutableAuthority(result)).stateVersion, 0);
  assert.equal(faultEvent(mutableAuthority(result)).stateVersion, 0);
});

test("candidate initializer restarts DRAINING fault authority after multiple risk-reducing advances", async () => {
  const authority = pausedFaultFromDrainingWithMultipleExitAuthority();
  const fixture = createFixture({ result: authority });

  const result = await fixture.initializer.initialize();

  assert.equal(result.deployment.phase, "PAUSED_FAULT");
  assert.equal(result.exactState.stateVersion, 3);
  assert.equal(result.exactState.currentEpisodeInventoryQuantity, "0");
  assert.deepEqual(
    result.auditEvents
      .filter((event) => event.eventType === "STATE_ADVANCED")
      .map((event) => [event.fromPhase, event.toPhase, event.stateVersion]),
    [
      ["ACTIVE", "ACTIVE", 1],
      ["DRAINING", "DRAINING", 2],
      ["DRAINING", "DRAINING", 3],
    ],
  );
  assert.equal(rollbackEvent(mutableAuthority(result)).stateVersion, 1);
  assert.equal(faultEvent(mutableAuthority(result)).stateVersion, 3);
});

test("candidate initializer restarts DRAINING fault authority after multiple active advances", async () => {
  const authority = pausedFaultFromDrainingWithMultipleActiveAuthority();
  const fixture = createFixture({ result: authority });

  const result = await fixture.initializer.initialize();

  assert.equal(result.deployment.phase, "PAUSED_FAULT");
  assert.equal(result.exactState.stateVersion, 2);
  assert.equal(result.exactState.currentEpisodeInventoryQuantity, "0.15");
  assert.deepEqual(
    result.auditEvents
      .filter((event) => event.eventType === "STATE_ADVANCED")
      .map((event) => [event.fromPhase, event.toPhase, event.stateVersion]),
    [["ACTIVE", "ACTIVE", 1], ["ACTIVE", "ACTIVE", 2]],
  );
  assert.equal(rollbackEvent(mutableAuthority(result)).stateVersion, 2);
  assert.equal(faultEvent(mutableAuthority(result)).stateVersion, 2);
});

test("candidate initializer rejects forged rollback boundaries around DRAINING state advances", async () => {
  const cases: Array<Readonly<{
    name: string;
    mutate(authority: ReturnType<typeof pausedFaultFromDrainingWithExitAuthority>): void;
  }>> = [
    {
      name: "pre-rollback state advance claims DRAINING",
      mutate(authority) {
        const event = stateAdvanceEvents(authority)[0]!;
        event.fromPhase = "DRAINING";
        event.toPhase = "DRAINING";
      },
    },
    {
      name: "post-rollback state advance claims ACTIVE",
      mutate(authority) {
        const event = stateAdvanceEvents(authority)[1]!;
        event.fromPhase = "ACTIVE";
        event.toPhase = "ACTIVE";
      },
    },
    {
      name: "rollback state version is too low",
      mutate(authority) {
        rollbackEvent(authority).stateVersion = 0;
      },
    },
    {
      name: "rollback state version is too high",
      mutate(authority) {
        rollbackEvent(authority).stateVersion = 2;
      },
    },
    {
      name: "rollback is ordered after a DRAINING state advance",
      mutate(authority) {
        const rollback = rollbackEvent(authority);
        authority.auditEvents.splice(authority.auditEvents.indexOf(rollback), 1);
        rollback.createdAt = "2026-08-23T23:59:59.880000001Z";
        rollback.payloadJson = JSON.stringify({ transitionAt: rollback.createdAt });
        rollback.id = `${authority.deployment.id}:rollback_started:1787529599880000001`;
        authority.auditEvents.splice(-1, 0, rollback);
      },
    },
  ];

  for (const testCase of cases) {
    const authority = pausedFaultFromDrainingWithExitAuthority();
    testCase.mutate(authority);
    const fixture = createFixture({ result: authority });
    await assert.rejects(
      () => fixture.initializer.initialize(),
      /rollback|STATE_ADVANCED|phase|stateVersion|chronology/i,
      testCase.name,
    );
  }
});

test("candidate initializer rejects non-risk-reducing evidence after rollback starts", async () => {
  const authority = pausedFaultFromDrainingWithAddAuthority();
  const fixture = createFixture({ result: authority });

  await assert.rejects(
    () => fixture.initializer.initialize(),
    /DRAINING|risk-reducing|ADD|evidence/i,
  );
});

test("candidate initializer rejects identical rollback and fault epochs regardless of fault id ordering", async () => {
  for (const faultId of ["0000-low-fault-id", "zzzz-high-fault-id"] as const) {
    const authority = pausedFaultFromDrainingAuthority();
    const rollback = rollbackEvent(authority);
    const fault = faultEvent(authority);
    authority.deployment.updatedAt = rollback.createdAt;
    fault.createdAt = rollback.createdAt;
    fault.id = faultId;
    authority.auditEvents.sort(compareAuditChronology);
    const fixture = createFixture({ result: authority });

    await assert.rejects(
      () => fixture.initializer.initialize(),
      /rollback|fault|chronology|precede/i,
      faultId,
    );
  }
});

test("candidate initializer rejects fault at the latest DRAINING evidence epoch regardless of fault id", async () => {
  for (const faultId of ["0000-low-arbitrary-fault-id", "zzzz-high-arbitrary-fault-id"] as const) {
    const authority = pausedFaultFromDrainingWithExitAuthority();
    const latestDrainingEvidenceAt = authority.evidenceRecords.at(-1)!.evidence.executedAt;
    const fault = faultEvent(authority);
    authority.deployment.updatedAt = latestDrainingEvidenceAt;
    fault.createdAt = latestDrainingEvidenceAt;
    fault.id = faultId;
    authority.auditEvents.sort(compareAuditChronology);
    const fixture = createFixture({ result: authority });

    await assert.rejects(
      () => fixture.initializer.initialize(),
      /DRAINING|fault|evidence|chronology|strict/i,
      faultId,
    );
  }
});

test("candidate initializer rejects forged DRAINING rollback restart authority", async () => {
  const cases: Array<Readonly<{
    name: string;
    mutate(authority: ReturnType<typeof pausedFaultFromDrainingAuthority>): void;
  }>> = [
    {
      name: "missing rollback",
      mutate(authority) {
        authority.auditEvents = authority.auditEvents.filter((event) => event.eventType !== "ROLLBACK_STARTED");
      },
    },
    {
      name: "duplicate rollback",
      mutate(authority) {
        const rollback = rollbackStartedAudit(authority.deployment, authority.exactState.stateVersion);
        authority.auditEvents.splice(-1, 0, { ...rollback, id: `${rollback.id}:duplicate` });
      },
    },
    {
      name: "forged rollback id",
      mutate(authority) {
        rollbackEvent(authority).id = `${authority.deployment.id}:rollback_started:forged`;
      },
    },
    {
      name: "wrong rollback source phase",
      mutate(authority) {
        rollbackEvent(authority).fromPhase = "PENDING_FLAT";
      },
    },
    {
      name: "wrong rollback target phase",
      mutate(authority) {
        rollbackEvent(authority).toPhase = "PAUSED_FAULT";
      },
    },
    {
      name: "wrong rollback state version",
      mutate(authority) {
        rollbackEvent(authority).stateVersion = 0;
      },
    },
    {
      name: "wrong rollback payload",
      mutate(authority) {
        rollbackEvent(authority).payloadJson = JSON.stringify({ transitionAt: CREATED_AT });
      },
    },
    {
      name: "non-canonical rollback payload",
      mutate(authority) {
        rollbackEvent(authority).payloadJson = `{ "transitionAt": "${ROLLBACK_STARTED_AT}" }`;
      },
    },
    {
      name: "rollback createdAt differs from transitionAt",
      mutate(authority) {
        rollbackEvent(authority).createdAt = "2026-08-23T23:59:59.860000001Z";
      },
    },
    {
      name: "rollback precedes candidate evidence",
      mutate(authority) {
        const rollback = rollbackEvent(authority);
        rollback.createdAt = "2026-08-23T23:59:59.700000001Z";
        rollback.payloadJson = JSON.stringify({ transitionAt: rollback.createdAt });
        rollback.id = `${authority.deployment.id}:rollback_started:1787529599700000001`;
      },
    },
    {
      name: "rollback follows fault",
      mutate(authority) {
        const rollback = rollbackEvent(authority);
        rollback.createdAt = "2026-08-23T23:59:59.950000001Z";
        rollback.payloadJson = JSON.stringify({ transitionAt: rollback.createdAt });
        rollback.id = `${authority.deployment.id}:rollback_started:1787529599950000001`;
      },
    },
    {
      name: "wrong rollback deployment identity",
      mutate(authority) {
        rollbackEvent(authority).deploymentId = "foreign-deployment";
      },
    },
    {
      name: "fault does not originate from DRAINING",
      mutate(authority) {
        faultEvent(authority).fromPhase = "ACTIVE";
      },
    },
    {
      name: "fault uses wrong state version",
      mutate(authority) {
        faultEvent(authority).stateVersion = 0;
      },
    },
    {
      name: "fault timestamp differs from deployment update",
      mutate(authority) {
        faultEvent(authority).createdAt = "2026-08-23T23:59:59.910000001Z";
      },
    },
    {
      name: "unsupported rollback completion audit",
      mutate(authority) {
        const rollback = rollbackEvent(authority);
        authority.auditEvents.splice(-1, 0, {
          ...rollback,
          id: `${authority.deployment.id}:rollback_completed:${ROLLBACK_STARTED_EPOCH_NS}`,
          eventType: "ROLLBACK_COMPLETED",
          fromPhase: "DRAINING",
          toPhase: "DISABLED",
        });
      },
    },
  ];

  for (const testCase of cases) {
    const authority = pausedFaultFromDrainingAuthority();
    testCase.mutate(authority);
    const fixture = createFixture({ result: authority });
    await assert.rejects(
      () => fixture.initializer.initialize(),
      /rollback|fault|audit|chronology|identity|stateVersion/i,
      testCase.name,
    );
  }
});

test("candidate initializer requires canonical STATE_ADVANCED linkage for every evidence record", async () => {
  const base = () => mutableAuthority(validAuthority({
    outcome: "EXISTING",
    createdAt: CREATED_AT,
    phase: "ACTIVE",
    activationAt: "2026-08-23T23:59:59.500000001Z",
    evidence: executedEnterEvidence(),
  }));
  const cases = [
    (() => {
      const authority = base();
      authority.auditEvents = authority.auditEvents.filter((event) => event.eventType !== "STATE_ADVANCED");
      return authority;
    })(),
    (() => {
      const authority = base();
      const stateEvent = authority.auditEvents.find((event) => event.eventType === "STATE_ADVANCED")!;
      stateEvent.payloadJson = JSON.stringify({
        ...JSON.parse(stateEvent.payloadJson) as Record<string, unknown>,
        materialHash: "0".repeat(64),
      });
      return authority;
    })(),
    (() => {
      const authority = base();
      const stateEvent = authority.auditEvents.find((event) => event.eventType === "STATE_ADVANCED")!;
      stateEvent.createdAt = "2026-08-23T23:59:59.800000001Z";
      return authority;
    })(),
    (() => {
      const authority = base();
      const duplicate = authority.auditEvents.find((event) => event.eventType === "STATE_ADVANCED")!;
      authority.auditEvents.push({ ...duplicate, id: `${duplicate.id}:duplicate` });
      return authority;
    })(),
  ];

  for (const authority of cases) {
    const fixture = createFixture({ result: authority });
    await assert.rejects(() => fixture.initializer.initialize(), /STATE_ADVANCED|evidence|chronology|audit/i);
  }
});

test("candidate initializer rejects non-exact evidence and audit arrays without invoking getters", async () => {
  const active = () => mutableAuthority(validAuthority({
    outcome: "EXISTING",
    createdAt: CREATED_AT,
    phase: "ACTIVE",
    activationAt: "2026-08-23T23:59:59.500000001Z",
    evidence: executedEnterEvidence(),
  }));
  let getterCalls = 0;
  const evidenceAccessor = active();
  const evidenceValue = evidenceAccessor.evidenceRecords[0]!;
  Object.defineProperty(evidenceAccessor.evidenceRecords, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return evidenceValue;
    },
  });
  const auditAccessor = active();
  const auditValue = auditAccessor.auditEvents[0]!;
  Object.defineProperty(auditAccessor.auditEvents, "0", {
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return auditValue;
    },
  });
  const sparseEvidence = active();
  sparseEvidence.evidenceRecords.length = 2;
  const sparseAudit = active();
  sparseAudit.auditEvents.length += 1;
  const extraProperty = active();
  Object.defineProperty(extraProperty.auditEvents, "extra", { value: true, enumerable: true });
  const symbolProperty = active();
  Object.defineProperty(symbolProperty.evidenceRecords, Symbol("extra"), { value: true });
  const exoticPrototype = active();
  Object.setPrototypeOf(exoticPrototype.auditEvents, Object.create(Array.prototype));

  for (const authority of [
    evidenceAccessor,
    auditAccessor,
    sparseEvidence,
    sparseAudit,
    extraProperty,
    symbolProperty,
    exoticPrototype,
  ]) {
    const fixture = createFixture({ result: authority });
    await assert.rejects(() => fixture.initializer.initialize(), /exact|dense|plain|array|data/i);
  }
  assert.equal(getterCalls, 0);
});

test("candidate initializer requires CREATED timestamps to equal its single clock snapshot", async () => {
  const fixture = createFixture({
    result: validAuthority({ outcome: "CREATED", createdAt: CREATED_AT }),
  });

  await assert.rejects(() => fixture.initializer.initialize(), /CREATED|clock|createdAt|updatedAt/i);
  assert.equal(fixture.clockCalls(), 1);
  assert.equal(fixture.repositoryCalls(), 1);
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
    updatedAt: phase === "PAUSED_FAULT"
      ? "2026-08-23T23:59:59.900000001Z"
      : activationAt ?? input.createdAt,
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
      id: `${deployment.id}:activation:${deployment.activationEpochNs!.toString()}`,
      deploymentId: deployment.id,
      eventType: "PHASE_TRANSITION",
      fromPhase: "PENDING_FLAT",
      toPhase: "ACTIVE",
      stateVersion: 0,
      payloadJson: JSON.stringify({
        activationAt,
        activationEpochNs: deployment.activationEpochNs!.toString(),
      }),
      createdAt: activationAt!,
    });
  }
  if (phase === "PAUSED_FAULT" && activationAt !== null) {
    auditEvents.push({
      id: `${deployment.id}:activation:${deployment.activationEpochNs!.toString()}`,
      deploymentId: deployment.id,
      eventType: "PHASE_TRANSITION",
      fromPhase: "PENDING_FLAT",
      toPhase: "ACTIVE",
      stateVersion: 0,
      payloadJson: JSON.stringify({
        activationAt,
        activationEpochNs: deployment.activationEpochNs!.toString(),
      }),
      createdAt: activationAt,
    });
  }
  if (input.evidence) {
    auditEvents.push(stateAdvancedAudit(deployment, input.evidence));
  }
  if (phase === "PAUSED_FAULT") {
    auditEvents.push({
      id: `${deployment.id}:fault:test`,
      deploymentId: deployment.id,
      eventType: "FAULT_PAUSED",
      fromPhase: activationAt === null ? "PENDING_FLAT" : "ACTIVE",
      toPhase: "PAUSED_FAULT",
      stateVersion: exactState.stateVersion,
      payloadJson: JSON.stringify({
        reasonCode: "REPLAY_MISMATCH",
        provenanceJson: JSON.stringify({ source: "initializer-test" }),
      }),
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

function stateAdvancedAudit(
  deployment: PositionGuardPilotDeploymentRecord,
  evidence: PositionGuardCandidateExecutionEvidence,
  transition: Readonly<{
    phase: "ACTIVE" | "DRAINING";
    fromStateVersion: number;
    toStateVersion: number;
  }> = { phase: "ACTIVE", fromStateVersion: 0, toStateVersion: 1 },
): PositionGuardPilotAuditEventRecord {
  const material = candidateEvidenceMaterial(deployment.id, evidence);
  return {
    id: `${deployment.id}:evidence:${material.evidence.evidenceId}`,
    deploymentId: deployment.id,
    eventType: "STATE_ADVANCED",
    fromPhase: transition.phase,
    toPhase: transition.phase,
    stateVersion: transition.toStateVersion,
    payloadJson: JSON.stringify({
      evidenceId: material.evidence.evidenceId,
      materialHash: material.hash,
      materialVersion: material.materialVersion,
      fromStateVersion: transition.fromStateVersion,
      toStateVersion: transition.toStateVersion,
    }),
    createdAt: material.evidence.executedAt,
  };
}

function pausedFaultFromDrainingAuthority(): ReturnType<typeof mutableAuthority> {
  const authority = mutableAuthority(validAuthority({
    outcome: "EXISTING",
    createdAt: CREATED_AT,
    phase: "PAUSED_FAULT",
    activationAt: "2026-08-23T23:59:59.500000001Z",
    evidence: executedEnterEvidence(),
  }));
  faultEvent(authority).fromPhase = "DRAINING";
  authority.auditEvents.splice(
    -1,
    0,
    rollbackStartedAudit(authority.deployment, authority.exactState.stateVersion),
  );
  return authority;
}

function drainingAuthority(): ReturnType<typeof mutableAuthority> {
  const authority = pausedFaultFromDrainingAuthority();
  const rollback = rollbackEvent(authority);
  authority.deployment.phase = "DRAINING";
  authority.deployment.updatedAt = rollback.createdAt;
  authority.auditEvents = authority.auditEvents.filter((event) => event.eventType !== "FAULT_PAUSED");
  return authority;
}

function pausedFaultFromDrainingWithoutEvidenceAuthority(): ReturnType<typeof mutableAuthority> {
  const authority = mutableAuthority(validAuthority({
    outcome: "EXISTING",
    createdAt: CREATED_AT,
    phase: "PAUSED_FAULT",
    activationAt: "2026-08-23T23:59:59.500000001Z",
  }));
  faultEvent(authority).fromPhase = "DRAINING";
  authority.auditEvents.splice(-1, 0, rollbackStartedAudit(authority.deployment, 0));
  return authority;
}

function pausedFaultFromDrainingWithExitAuthority(): ReturnType<typeof mutableAuthority> {
  const authority = pausedFaultFromDrainingAuthority();
  const exitEvidence = executedExitEvidence();
  authority.evidenceRecords.push(executedEvidenceRecord(authority.deployment.id, exitEvidence));
  authority.exactState = {
    ...projectExactCandidateState([executedEnterEvidence(), exitEvidence]),
  };
  authority.auditEvents.splice(
    -1,
    0,
    stateAdvancedAudit(authority.deployment, exitEvidence, {
      phase: "DRAINING",
      fromStateVersion: 1,
      toStateVersion: 2,
    }),
  );
  faultEvent(authority).stateVersion = 2;
  return authority;
}

function pausedFaultFromDrainingWithMultipleExitAuthority(): ReturnType<typeof mutableAuthority> {
  const authority = pausedFaultFromDrainingAuthority();
  const reduceEvidence = executedReduceEvidence();
  const finalExitEvidence = executedFinalExitEvidence();
  authority.evidenceRecords.push(
    executedEvidenceRecord(authority.deployment.id, reduceEvidence),
    executedEvidenceRecord(authority.deployment.id, finalExitEvidence),
  );
  authority.exactState = {
    ...projectExactCandidateState([
      executedEnterEvidence(),
      reduceEvidence,
      finalExitEvidence,
    ]),
  };
  const fault = faultEvent(authority);
  const faultIndex = authority.auditEvents.indexOf(fault);
  authority.auditEvents.splice(
    faultIndex,
    0,
    stateAdvancedAudit(authority.deployment, reduceEvidence, {
      phase: "DRAINING",
      fromStateVersion: 1,
      toStateVersion: 2,
    }),
    stateAdvancedAudit(authority.deployment, finalExitEvidence, {
      phase: "DRAINING",
      fromStateVersion: 2,
      toStateVersion: 3,
    }),
  );
  fault.stateVersion = 3;
  return authority;
}

function pausedFaultFromDrainingWithMultipleActiveAuthority(): ReturnType<typeof mutableAuthority> {
  const authority = pausedFaultFromDrainingAuthority();
  const addEvidence = executedActiveAddEvidence();
  authority.evidenceRecords.push(executedEvidenceRecord(authority.deployment.id, addEvidence));
  authority.exactState = {
    ...projectExactCandidateState([executedEnterEvidence(), addEvidence]),
  };
  const rollback = rollbackEvent(authority);
  authority.auditEvents.splice(
    authority.auditEvents.indexOf(rollback),
    0,
    stateAdvancedAudit(authority.deployment, addEvidence, {
      phase: "ACTIVE",
      fromStateVersion: 1,
      toStateVersion: 2,
    }),
  );
  rollback.stateVersion = 2;
  faultEvent(authority).stateVersion = 2;
  return authority;
}

function pausedFaultFromDrainingWithAddAuthority(): ReturnType<typeof mutableAuthority> {
  const authority = pausedFaultFromDrainingWithExitAuthority();
  const addEvidence = executedAddEvidence();
  authority.evidenceRecords[1] = executedEvidenceRecord(authority.deployment.id, addEvidence);
  authority.exactState = {
    ...projectExactCandidateState([executedEnterEvidence(), addEvidence]),
  };
  const addAudit = stateAdvancedAudit(authority.deployment, addEvidence, {
    phase: "DRAINING",
    fromStateVersion: 1,
    toStateVersion: 2,
  });
  const secondStateEvent = stateAdvanceEvents(authority)[1]!;
  authority.auditEvents[authority.auditEvents.indexOf(secondStateEvent)] = addAudit;
  return authority;
}

function rollbackStartedAudit(
  deployment: PositionGuardPilotDeploymentRecord,
  stateVersion: number,
): PositionGuardPilotAuditEventRecord {
  return {
    id: `${deployment.id}:rollback_started:${ROLLBACK_STARTED_EPOCH_NS}`,
    deploymentId: deployment.id,
    eventType: "ROLLBACK_STARTED",
    fromPhase: "ACTIVE",
    toPhase: "DRAINING",
    stateVersion,
    payloadJson: JSON.stringify({ transitionAt: ROLLBACK_STARTED_AT }),
    createdAt: ROLLBACK_STARTED_AT,
  };
}

function rollbackEvent(
  authority: ReturnType<typeof mutableAuthority>,
): PositionGuardPilotAuditEventRecord {
  const event = authority.auditEvents.find((candidate) => candidate.eventType === "ROLLBACK_STARTED");
  if (event === undefined) throw new Error("test rollback event is missing");
  return event;
}

function faultEvent(
  authority: ReturnType<typeof mutableAuthority>,
): PositionGuardPilotAuditEventRecord {
  const event = authority.auditEvents.find((candidate) => candidate.eventType === "FAULT_PAUSED");
  if (event === undefined) throw new Error("test fault event is missing");
  return event;
}

function stateAdvanceEvents(
  authority: ReturnType<typeof mutableAuthority>,
): PositionGuardPilotAuditEventRecord[] {
  return authority.auditEvents.filter((event) => event.eventType === "STATE_ADVANCED");
}

function compareAuditChronology(
  left: PositionGuardPilotAuditEventRecord,
  right: PositionGuardPilotAuditEventRecord,
): number {
  const leftEpochNs = parseCandidatePilotTimestamp(left.createdAt, "test audit createdAt");
  const rightEpochNs = parseCandidatePilotTimestamp(right.createdAt, "test audit createdAt");
  if (leftEpochNs < rightEpochNs) return -1;
  if (leftEpochNs > rightEpochNs) return 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
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

function executedExitEvidence(): PositionGuardCandidateExecutionEvidence {
  return {
    evidenceId: "candidate-exit-2",
    executedAt: "2026-08-23T23:59:59.870000001Z",
    action: "EXIT",
    entryPath: "NONE",
    terminalStatus: "FILLED",
    executedQuantity: "0.1",
    grossQuoteValueKrw: "11000",
    confirmedFeeKrw: "5",
    remainingQuantity: "0",
  };
}

function executedReduceEvidence(): PositionGuardCandidateExecutionEvidence {
  return {
    evidenceId: "candidate-reduce-2",
    executedAt: "2026-08-23T23:59:59.870000001Z",
    action: "REDUCE",
    entryPath: "NONE",
    terminalStatus: "FILLED",
    executedQuantity: "0.04",
    grossQuoteValueKrw: "4400",
    confirmedFeeKrw: "2",
    remainingQuantity: "0.06",
  };
}

function executedFinalExitEvidence(): PositionGuardCandidateExecutionEvidence {
  return {
    evidenceId: "candidate-exit-3",
    executedAt: "2026-08-23T23:59:59.880000001Z",
    action: "EXIT",
    entryPath: "NONE",
    terminalStatus: "FILLED",
    executedQuantity: "0.06",
    grossQuoteValueKrw: "6600",
    confirmedFeeKrw: "3",
    remainingQuantity: "0",
  };
}

function executedActiveAddEvidence(): PositionGuardCandidateExecutionEvidence {
  return {
    evidenceId: "candidate-active-add-2",
    executedAt: "2026-08-23T23:59:59.800000001Z",
    action: "ADD",
    entryPath: "RECLAIM",
    terminalStatus: "FILLED",
    executedQuantity: "0.05",
    grossQuoteValueKrw: "5000",
    confirmedFeeKrw: "2.5",
    remainingQuantity: "0.15",
  };
}

function executedAddEvidence(): PositionGuardCandidateExecutionEvidence {
  return {
    evidenceId: "candidate-add-2",
    executedAt: "2026-08-23T23:59:59.870000001Z",
    action: "ADD",
    entryPath: "RECLAIM",
    terminalStatus: "FILLED",
    executedQuantity: "0.1",
    grossQuoteValueKrw: "10000",
    confirmedFeeKrw: "5",
    remainingQuantity: "0.2",
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
