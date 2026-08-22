import assert from "node:assert/strict";

import type {
  OrderSubmissionRecoveryObservationRecord,
  PositionGuardPilotDeploymentRecord,
  PositionGuardPilotRecoveryTarget,
  PositionGuardPilotRefreshReceipt,
} from "../src/domain/pilot-types.js";
import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  OrderEventRecord,
  OrderRecord,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
} from "../src/domain/types.js";
import {
  PositionGuardPilotRecovery,
} from "../src/app/position-guard-pilot-recovery.js";
import {
  candidateEvidenceMaterial,
  type CandidateEvidenceRecord,
  type CandidatePilotRecoveryFaultReason,
  type CandidatePilotRepository,
} from "../src/modules/db/pilot-interfaces.js";
import type { ExecutionRepository } from "../src/modules/db/interfaces.js";
import { InMemoryCandidatePilotRepository } from
  "../src/modules/db/repositories/in-memory-candidate-pilot-repository.js";
import {
  InMemoryExecutionRepository,
  InMemoryOperatorStateStore,
} from "../src/modules/db/repositories/in-memory-repositories.js";
import { projectExactCandidateState } from
  "../src/modules/execution/candidate-evidence-decimals.js";
import { createEmptyPositionGuardCandidateState } from
  "../src/modules/strategy/position-guard-candidate-state.js";
import { test } from "./harness.js";

const ACCOUNT_ID = "primary";
const DEPLOYMENT_ID = "btc-pilot-deployment";
const PILOT_ID = "BTC_COMBINED_CONSERVATIVE_PILOT_V1" as const;
const POLICY_ID = "COMBINED_CONSERVATIVE" as const;
const POLICY_VERSION = "PCS-2026-001.DEPLOYMENT_READINESS_V1" as const;
const CREATED_AT = "2026-08-21T00:00:00.000Z";
const ACTIVATED_AT = "2026-08-21T00:00:10.000Z";
const EVIDENCE_AT = "2026-08-21T00:00:20.000Z";
const SNAPSHOT_AT = "2026-08-21T00:00:30.000Z";
const RECONCILIATION_COMPLETED_AT = "2026-08-21T00:00:31.000Z";
const NOW = "2026-08-21T00:01:00.000Z";
const FRESHNESS_THRESHOLD_MS = 60_000;
const MINIMUM_ABSENCE_OBSERVATIONS = 2;
const MINIMUM_ABSENCE_ELAPSED_MS = 10_000;
type RecoveryDependencies = ConstructorParameters<typeof PositionGuardPilotRecovery>[0];
const DEFINITIVE_REJECTION_PAYLOAD = Object.freeze({
  kind: "DEFINITIVE_REJECTION",
  status: 400,
  exchangeCode: "invalid_parameter",
  exchangeName: "validation_error",
  responseReceived: true,
});
const ABSENCE_PROOF_PAYLOAD = Object.freeze({
  absenceObservationCount: MINIMUM_ABSENCE_OBSERVATIONS,
  elapsedMs: MINIMUM_ABSENCE_ELAPSED_MS,
  minimumNotFoundObservations: MINIMUM_ABSENCE_OBSERVATIONS,
  minimumElapsedMs: MINIMUM_ABSENCE_ELAPSED_MS,
});

test("fresh persisted flat PENDING_FLAT activation returns immutable READY ACTIVE provenance", async () => {
  const fixture = await createFixture();

  const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.verificationOnly, true);
  assert.equal(result.phase, "ACTIVE");
  assert.equal(result.deployment.phase, "ACTIVE");
  assert.deepEqual(result.activation, {
    activationAt: NOW,
    activationEpochNs: BigInt(Date.parse(NOW)) * 1_000_000n,
  });
  assert.deepEqual(result.state, {
    currentEpisodeAddCount: 0,
    currentEpisodeCostBasisKrw: "0",
    currentEpisodeInventoryQuantity: "0",
    currentEpisodeRealizedPnlKrw: "0",
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: null,
    lastEvidenceId: null,
    stateVersion: 0,
  });
  assert.equal(result.stateVersion, 0);
  assert.deepEqual(result.refreshProvenance, fixture.receipt);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.deployment), true);
  assert.equal(Object.isFrozen(result.activation), true);
  assert.equal(Object.isFrozen(result.state), true);
  assert.equal(Object.isFrozen(result.refreshProvenance), true);
  assert.equal((await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase, "ACTIVE");
  assert.equal((await fixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID))
    .filter((event) => event.eventType === "PHASE_TRANSITION").length, 1);
});

test("non-flat PENDING_FLAT returns READY PENDING_FLAT without activation", async () => {
  const fixture = await createFixture({ balanceFree: "0.25", positionQuantity: "0.25" });

  const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.phase, "PENDING_FLAT");
  assert.equal(result.activation, null);
  assert.equal(result.state.currentEpisodeInventoryQuantity, "0");
  assert.equal((await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase, "PENDING_FLAT");
});

test("ACTIVE recovery verifies activation chronology and exact replay state", async () => {
  const fixture = await createFixture({
    phase: "ACTIVE",
    evidenceQuantity: "0.1",
    balanceFree: "0.1",
    positionQuantity: "0.1",
  });

  const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "READY");
  if (result.status !== "READY") return;
  assert.equal(result.phase, "ACTIVE");
  assert.deepEqual(result.activation, {
    activationAt: ACTIVATED_AT,
    activationEpochNs: BigInt(Date.parse(ACTIVATED_AT)) * 1_000_000n,
  });
  assert.equal(result.state.currentEpisodeInventoryQuantity, "0.1");
  assert.equal(result.state.stateVersion, 1);
});

test("ACTIVE recovery rejects activation audit chronology that was not pristine", async () => {
  const fixture = await createFixture({
    phase: "ACTIVE",
    evidenceQuantity: "0.1",
    balanceFree: "0.1",
    positionQuantity: "0.1",
  });
  const auditEvents = await fixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID);
  fixture.recovery = fixture.createRecovery(overrideCandidatePilots(fixture.candidatePilots, {
    listAuditEvents: async () => auditEvents.map((event) =>
      event.eventType === "PHASE_TRANSITION" ? { ...event, stateVersion: 1 } : event
    ),
  }));

  await expectFault(fixture, "IDENTITY_MISMATCH");
});

test("ACTIVE recovery requires post-activation evidence and a complete STATE_ADVANCED audit chain", async () => {
  for (const scenario of ["pre-activation-evidence", "missing-state-audit"] as const) {
    const fixture = await createFixture({
      phase: "ACTIVE",
      evidenceQuantity: "0.1",
      balanceFree: "0.1",
      positionQuantity: "0.1",
    });
    const records = await fixture.candidatePilots.listEvidenceRecords(DEPLOYMENT_ID);
    const audits = await fixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID);
    assert.equal(records.length, 1);
    if (scenario === "pre-activation-evidence") {
      const material = candidateEvidenceMaterial(DEPLOYMENT_ID, {
        ...records[0]!.evidence,
        executedAt: "2026-08-21T00:00:05.000Z",
      });
      fixture.recovery = fixture.createRecovery(overrideCandidatePilots(fixture.candidatePilots, {
        getExactState: async () => projectExactCandidateState([material.evidence]),
        listEvidenceRecords: async () => [{
          evidence: material.evidence,
          materialHash: material.hash,
          materialVersion: material.materialVersion,
        }],
      }));
    } else {
      fixture.recovery = fixture.createRecovery(overrideCandidatePilots(fixture.candidatePilots, {
        listAuditEvents: async () => audits.filter((event) => event.eventType !== "STATE_ADVANCED"),
      }));
    }

    await expectFault(fixture, "REPLAY_MISMATCH", scenario);
  }
});

test("receipt that does not match the persisted latest rows faults closed", async () => {
  const fixture = await createFixture();
  await fixture.repositories.saveBalanceSnapshot(balanceSnapshot({
    id: "balance-newer",
    capturedAt: "2026-08-21T00:00:40.000Z",
  }));

  await expectFault(fixture, "SNAPSHOT_PROVENANCE_INVALID");
});

test("stale, future, and malformed persisted refresh timestamps fault closed", async () => {
  const scenarios = [
    {
      name: "stale",
      snapshotAt: "2026-08-20T23:58:00.000Z",
      completedAt: "2026-08-20T23:58:01.000Z",
      reasonCode: "STALE_SNAPSHOT" as const,
    },
    {
      name: "future",
      snapshotAt: "2026-08-21T00:02:00.000Z",
      completedAt: "2026-08-21T00:02:01.000Z",
      reasonCode: "STALE_SNAPSHOT" as const,
    },
    {
      name: "malformed",
      snapshotAt: "2026-08-21 00:00:30",
      completedAt: RECONCILIATION_COMPLETED_AT,
      reasonCode: "SNAPSHOT_PROVENANCE_INVALID" as const,
    },
  ];

  for (const scenario of scenarios) {
    const fixture = await createFixture({
      snapshotAt: scenario.snapshotAt,
      reconciliationCompletedAt: scenario.completedAt,
    });
    await expectFault(fixture, scenario.reasonCode, scenario.name);
  }
});

test("future deployment, evidence, order, and audit timestamps all fault closed", async () => {
  for (const scenario of ["deployment", "evidence", "order", "audit"] as const) {
    const fixture = await createFixture(scenario === "evidence"
      ? { phase: "ACTIVE", evidenceQuantity: "0.1", balanceFree: "0.1", positionQuantity: "0.1" }
      : { balanceFree: "0.2", positionQuantity: "0.2" });
    if (scenario === "deployment") {
      const deployment = await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID);
      assert.ok(deployment);
      fixture.recovery = fixture.createRecovery(overrideCandidatePilots(fixture.candidatePilots, {
        getDeployment: async () => ({ ...deployment, updatedAt: "2026-08-21T00:02:00.000Z" }),
      }));
    } else if (scenario === "evidence") {
      const records = await fixture.candidatePilots.listEvidenceRecords(DEPLOYMENT_ID);
      assert.equal(records.length, 1);
      const material = candidateEvidenceMaterial(DEPLOYMENT_ID, {
        ...records[0]!.evidence,
        executedAt: "2026-08-21T00:02:00.000Z",
      });
      fixture.recovery = fixture.createRecovery(overrideCandidatePilots(fixture.candidatePilots, {
        getExactState: async () => projectExactCandidateState([material.evidence]),
        listEvidenceRecords: async () => [{
          evidence: material.evidence,
          materialHash: material.hash,
          materialVersion: material.materialVersion,
        }],
      }));
    } else if (scenario === "order") {
      await fixture.repositories.saveOrder({
        ...orderRecord({ status: "FILLED" }),
        updatedAt: "2026-08-21T00:02:00.000Z",
      });
    } else {
      const audits = await fixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID);
      fixture.recovery = fixture.createRecovery(overrideCandidatePilots(fixture.candidatePilots, {
        listAuditEvents: async () => audits.map((event, index) =>
          index === 0 ? { ...event, createdAt: "2026-08-21T00:02:00.000Z" } : event
        ),
      }));
    }

    await expectFault(
      fixture,
      scenario === "evidence" ? "REPLAY_MISMATCH" : scenario === "order" ? "UNCERTAIN_ORDER" : "IDENTITY_MISMATCH",
      scenario,
    );
  }
});

test("every authoritative persistence read failure returns a sanitized durable BLOCKED_FAULT", async () => {
  const operations = [
    "getDeployment",
    "getLatestBalanceSnapshot",
    "getLatestPositionSnapshot",
    "listReconciliationRuns",
    "listOrders",
    "listOrderEvents",
    "listOrderSubmissionRecoveryObservations",
    "getExactState",
    "listEvidenceRecords",
    "listAuditEvents",
  ] as const;
  const outcomes: string[] = [];
  for (const operation of operations) {
    const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
    if (operation === "listOrderEvents" || operation === "listOrderSubmissionRecoveryObservations") {
      await fixture.repositories.saveOrder(orderRecord({ status: "FILLED" }));
    }
    const secret = `SUPER_SECRET_${operation}`;
    const fail = async () => {
      throw new Error(secret);
    };
    const candidatePilots = operation === "getDeployment" || operation === "getExactState" ||
        operation === "listEvidenceRecords" || operation === "listAuditEvents"
      ? overrideCandidatePilots(fixture.candidatePilots, { [operation]: fail })
      : fixture.candidatePilots;
    const repositories = operation !== "getDeployment" && operation !== "getExactState" &&
        operation !== "listEvidenceRecords" && operation !== "listAuditEvents"
      ? overrideExecutionRepositories(fixture.repositories, { [operation]: fail })
      : fixture.repositories;
    fixture.recovery = fixture.createRecovery(candidatePilots, repositories);

    let result: Awaited<ReturnType<PositionGuardPilotRecovery["verifyAndPrepareBtcRun"]>>;
    try {
      result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);
    } catch {
      outcomes.push("THREW");
      continue;
    }
    outcomes.push(result.status);
    assert.equal(result.status, "BLOCKED_FAULT", operation);
    if (result.status !== "BLOCKED_FAULT") continue;
    assert.equal(result.reasonCode, "SNAPSHOT_PROVENANCE_INVALID", operation);
    assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED", operation);
    assert.equal(
      (await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase,
      operation === "getDeployment" ? "PENDING_FLAT" : "PAUSED_FAULT",
      operation,
    );
    const persistedMaterial = JSON.stringify({
      audits: await fixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID),
      transitions: await fixture.operatorState.listTransitions(100),
    });
    assert.equal(persistedMaterial.includes(secret), false, operation);
  }

  assert.deepEqual(outcomes, operations.map(() => "BLOCKED_FAULT"));
});

test("initial and stable-reread deployment failures persist distinct faults for their pause authority", async () => {
  const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
  let deploymentReadCount = 0;
  const failingPilots = overrideCandidatePilots(fixture.candidatePilots, {
    getDeployment: async (deploymentId) => {
      deploymentReadCount += 1;
      if (deploymentReadCount === 1 || deploymentReadCount === 3) {
        throw new Error("same deployment read failure");
      }
      return fixture.candidatePilots.getDeployment(deploymentId);
    },
  });
  const recovery = fixture.createRecovery(failingPilots);

  const initialFailure = await recovery.verifyAndPrepareBtcRun(fixture.receipt);
  assert.equal(initialFailure.status, "BLOCKED_FAULT");
  if (initialFailure.status !== "BLOCKED_FAULT") return;
  assert.equal((await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase, "PENDING_FLAT");

  const stableRereadFailure = await recovery.verifyAndPrepareBtcRun(fixture.receipt);
  assert.equal(stableRereadFailure.status, "BLOCKED_FAULT");
  if (stableRereadFailure.status !== "BLOCKED_FAULT") return;
  assert.notEqual(stableRereadFailure.faultId, initialFailure.faultId);
  assert.equal((await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase, "PAUSED_FAULT");
  assert.equal((await fixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID))
    .filter((event) => event.id === stableRereadFailure.faultId).length, 1);
  const transitions = await fixture.operatorState.listTransitions(100);
  assert.equal(transitions.filter((transition) => transition.id === initialFailure.faultId).length, 1);
  assert.equal(transitions.filter((transition) => transition.id === stableRereadFailure.faultId).length, 1);
  const initialTransition = transitions.find((transition) => transition.id === initialFailure.faultId);
  assert.ok(initialTransition);
  assert.ok(initialTransition.reason);
  const initialProvenance = JSON.parse(initialTransition.reason.slice(
    initialTransition.reason.indexOf("provenance=") + "provenance=".length,
  )) as Record<string, unknown>;
  assert.equal(initialProvenance.faultKind, "PERSISTENCE_READ_FAILURE");
  assert.equal(initialProvenance.readOperation, "candidatePilots.getDeployment");
  assert.equal(initialProvenance.readStage, "INITIAL_DEPLOYMENT_READ");
  assert.equal(initialProvenance.pauseAuthority, "GLOBAL_ONLY");

  const stableAudit = (await fixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID))
    .find((event) => event.id === stableRereadFailure.faultId);
  assert.ok(stableAudit);
  const stableAuditPayload = JSON.parse(stableAudit.payloadJson) as { provenanceJson: string };
  const stableProvenance = JSON.parse(stableAuditPayload.provenanceJson) as Record<string, unknown>;
  assert.equal(stableProvenance.faultKind, "PERSISTENCE_READ_FAILURE");
  assert.equal(stableProvenance.readOperation, "candidatePilots.getDeployment");
  assert.equal(stableProvenance.readStage, "STABLE_AUTHORITY_REREAD");
  assert.equal(stableProvenance.pauseAuthority, "PILOT_AND_GLOBAL_ATOMIC");
});

test("read-failure restart reuses immutable fault identity and separates operation and error class", async () => {
  const restartFixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
  const failingPilots = overrideCandidatePilots(restartFixture.candidatePilots, {
    listEvidenceRecords: async () => {
      throw new Error("SECRET_RESTART_READ_FAILURE");
    },
  });

  const first = await restartFixture.createRecovery(failingPilots)
    .verifyAndPrepareBtcRun(restartFixture.receipt);
  const retry = await restartFixture.createRecovery(
    failingPilots,
    undefined,
    undefined,
    "2026-08-21T00:01:05.000Z",
  )
    .verifyAndPrepareBtcRun(restartFixture.receipt);

  assert.equal(first.status, "BLOCKED_FAULT");
  assert.equal(retry.status, "BLOCKED_FAULT");
  if (first.status !== "BLOCKED_FAULT" || retry.status !== "BLOCKED_FAULT") return;
  assert.equal(first.faultId, retry.faultId);
  assert.equal((await restartFixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID))
    .filter((event) => event.id === first.faultId).length, 1);
  assert.equal((await restartFixture.operatorState.listTransitions(100))
    .filter((transition) => transition.id === first.faultId).length, 1);

  class DistinctReadError extends Error {}
  const distinctFaultIds: string[] = [];
  for (const scenario of [
    { operation: "getExactState" as const, error: new Error("same-message") },
    { operation: "listEvidenceRecords" as const, error: new Error("same-message") },
    { operation: "getExactState" as const, error: new TypeError("same-message") },
    { operation: "getExactState" as const, error: new DistinctReadError("same-message") },
  ]) {
    const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
    const fail = async () => {
      throw scenario.error;
    };
    const result = await fixture.createRecovery(overrideCandidatePilots(fixture.candidatePilots, {
      [scenario.operation]: fail,
    })).verifyAndPrepareBtcRun(fixture.receipt);
    assert.equal(result.status, "BLOCKED_FAULT");
    if (result.status === "BLOCKED_FAULT") distinctFaultIds.push(result.faultId);
  }
  assert.equal(new Set(distinctFaultIds).size, 4);
});

test("missing configured deployment pauses only the target global execution state", async () => {
  const fixture = await createFixture({ createDeployment: false });

  const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "BLOCKED_FAULT");
  if (result.status !== "BLOCKED_FAULT") return;
  assert.equal(result.reasonCode, "IDENTITY_MISMATCH");
  assert.equal(result.executableAuthority, false);
  assert.equal("deployment" in result, false);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  assert.equal(await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID), null);
  assert.equal((await fixture.operatorState.listTransitions(100))
    .filter((transition) => transition.id === result.faultId).length, 1);
});

test("configured account-pilot recovery resolves exactly one matching deployment", async () => {
  const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
  const calls: string[] = [];
  const pilots = overrideCandidatePilots(fixture.candidatePilots, {
    findDeploymentsForRecoveryIdentity: async (identity) => {
      calls.push(`find:${identity.exchangeAccountId}:${identity.pilotId}`);
      return fixture.candidatePilots.findDeploymentsForRecoveryIdentity(identity);
    },
    getDeploymentForExchangeAccount: async () => {
      throw new Error("configured recovery must not use account-only first-row lookup");
    },
  });

  const result = await fixture.createConfiguredRecovery(pilots)
    .verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "READY");
  assert.deepEqual(calls, [`find:${ACCOUNT_ID}:${PILOT_ID}`]);
  if (result.status !== "READY") return;
  assert.equal(result.deployment.id, DEPLOYMENT_ID);
});

test("configured account-pilot recovery missing identity pauses globally without reading or mutating pilot authority", async () => {
  const fixture = await createFixture();
  let authorityReads = 0;
  let pilotFaultWrites = 0;
  const pilots = overrideCandidatePilots(fixture.candidatePilots, {
    findDeploymentsForRecoveryIdentity: async () => [],
    getExactState: async () => {
      authorityReads += 1;
      throw new Error("unexpected candidate authority read");
    },
    pauseForRecoveryFault: async (input) => {
      pilotFaultWrites += 1;
      return fixture.candidatePilots.pauseForRecoveryFault(input);
    },
  });

  const result = await fixture.createConfiguredRecovery(pilots)
    .verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "BLOCKED_FAULT");
  if (result.status !== "BLOCKED_FAULT") return;
  assert.equal(result.reasonCode, "IDENTITY_MISMATCH");
  assert.equal(authorityReads, 0);
  assert.equal(pilotFaultWrites, 0);
  assert.equal((await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase, "PENDING_FLAT");
  assert.equal((await fixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID))
    .filter((event) => event.eventType === "FAULT_PAUSED").length, 0);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
});

test("configured account-pilot recovery ambiguous identity pauses globally without candidate authority access", async () => {
  const fixture = await createFixture();
  const deployment = await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID);
  assert.ok(deployment);
  let authorityReads = 0;
  let pilotFaultWrites = 0;
  const pilots = overrideCandidatePilots(fixture.candidatePilots, {
    findDeploymentsForRecoveryIdentity: async () => [
      { ...deployment },
      { ...deployment, id: `${DEPLOYMENT_ID}-ambiguous` },
    ],
    getDeployment: async () => {
      authorityReads += 1;
      throw new Error("unexpected exact deployment read");
    },
    getExactState: async () => {
      authorityReads += 1;
      throw new Error("unexpected candidate state read");
    },
    pauseForRecoveryFault: async (input) => {
      pilotFaultWrites += 1;
      return fixture.candidatePilots.pauseForRecoveryFault(input);
    },
  });

  const result = await fixture.createConfiguredRecovery(pilots)
    .verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "BLOCKED_FAULT");
  if (result.status !== "BLOCKED_FAULT") return;
  assert.equal(result.reasonCode, "IDENTITY_MISMATCH");
  assert.equal(authorityReads, 0);
  assert.equal(pilotFaultWrites, 0);
  assert.equal((await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase, "PENDING_FLAT");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
});

test("configured recovery snapshots lookup authority and pins all later reads to the resolved deployment id", async () => {
  const fixture = await createFixture();
  const persisted = await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID);
  assert.ok(persisted);
  const mutableLookup = { ...persisted };
  const deploymentReads: string[] = [];
  const stateReads: string[] = [];
  const activationWrites: string[] = [];
  const pilots = overrideCandidatePilots(fixture.candidatePilots, {
    findDeploymentsForRecoveryIdentity: async () => [mutableLookup],
    getDeployment: async (deploymentId) => {
      deploymentReads.push(deploymentId);
      return fixture.candidatePilots.getDeployment(deploymentId);
    },
    getExactState: async (deploymentId) => {
      stateReads.push(deploymentId);
      mutableLookup.id = "mutated-after-lookup";
      mutableLookup.exchangeAccountId = "mutated-account";
      return fixture.candidatePilots.getExactState(deploymentId);
    },
    activateDeployment: async (input) => {
      activationWrites.push(input.deploymentId);
      return fixture.candidatePilots.activateDeployment(input);
    },
  });

  const result = await fixture.createConfiguredRecovery(pilots)
    .verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "READY");
  assert.deepEqual(new Set(deploymentReads), new Set([DEPLOYMENT_ID]));
  assert.deepEqual(new Set(stateReads), new Set([DEPLOYMENT_ID]));
  assert.deepEqual(activationWrites, [DEPLOYMENT_ID]);
  if (result.status !== "READY") return;
  assert.equal(result.deployment.id, DEPLOYMENT_ID);
  assert.equal(result.deployment.exchangeAccountId, ACCOUNT_ID);
});

test("recovery snapshots constructor authority before the first awaited lookup", async () => {
  const fixture = await createFixture();
  let releaseLookup!: () => void;
  let markLookupStarted!: () => void;
  const lookupGate = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const lookupStarted = new Promise<void>((resolve) => {
    markLookupStarted = resolve;
  });
  const deploymentReads: string[] = [];
  const balanceReads: string[] = [];
  const pilotFaults: Array<Parameters<CandidatePilotRepository["pauseForRecoveryFault"]>[0]> = [];
  const candidatePilots = overrideCandidatePilots(fixture.candidatePilots, {
    getDeployment: async (deploymentId) => {
      deploymentReads.push(deploymentId);
      markLookupStarted();
      await lookupGate;
      return fixture.candidatePilots.getDeployment(deploymentId);
    },
    pauseForRecoveryFault: async (input) => {
      pilotFaults.push(input);
      return fixture.candidatePilots.pauseForRecoveryFault(input);
    },
  });
  const repositories = overrideExecutionRepositories(fixture.repositories, {
    getLatestBalanceSnapshot: async (exchangeAccountId) => {
      balanceReads.push(exchangeAccountId);
      throw new Error("forced read failure after deployment resolution");
    },
  });
  const target = {
    kind: "EXACT_DEPLOYMENT" as const,
    deploymentId: DEPLOYMENT_ID,
  };
  const dependencies = recoveryDependencies(fixture, { target, candidatePilots, repositories });
  const recovery = new PositionGuardPilotRecovery(dependencies);

  const pending = recovery.verifyAndPrepareBtcRun(fixture.receipt);
  await lookupStarted;
  const mutable = dependencies as unknown as Record<string, unknown>;
  mutable.exchangeAccountId = "mutated-account";
  mutable.pilotId = "mutated-pilot";
  mutable.market = "KRW-ETH";
  mutable.policyId = "mutated-policy";
  mutable.policyVersion = "mutated-version";
  mutable.freshnessThresholdMs = 1;
  mutable.minimumAbsenceObservations = 99;
  mutable.minimumAbsenceElapsedMs = 1;
  mutable.repositories = {};
  mutable.candidatePilots = {};
  mutable.operatorState = {};
  mutable.clock = {};
  target.deploymentId = "mutated-deployment";
  releaseLookup();

  const result = await pending;

  assert.equal(result.status, "BLOCKED_FAULT");
  assert.deepEqual(deploymentReads, [DEPLOYMENT_ID]);
  assert.deepEqual(balanceReads, [ACCOUNT_ID]);
  assert.equal(pilotFaults.length, 1);
  assert.equal(pilotFaults[0]?.deploymentId, DEPLOYMENT_ID);
  assert.equal(pilotFaults[0]?.exchangeAccountId, ACCOUNT_ID);
  const provenance = pilotFaults[0]?.provenanceJson ?? "";
  assert.match(provenance, new RegExp(ACCOUNT_ID));
  assert.match(provenance, new RegExp(PILOT_ID));
  assert.match(provenance, new RegExp(POLICY_VERSION.replaceAll(".", "\\.")));
  assert.match(provenance, new RegExp(String(FRESHNESS_THRESHOLD_MS)));
  assert.match(provenance, new RegExp(String(MINIMUM_ABSENCE_OBSERVATIONS)));
  assert.match(provenance, new RegExp(String(MINIMUM_ABSENCE_ELAPSED_MS)));
  assert.doesNotMatch(provenance, /mutated-/);
  const transition = (await fixture.operatorState.listTransitions(100))
    .find((item) => item.id === result.faultId);
  assert.equal(transition?.exchangeAccountId, ACCOUNT_ID);
  assert.equal(Object.isFrozen(fixture.repositories), false);
  assert.equal(Object.isFrozen(fixture.candidatePilots), false);
  assert.equal(Object.isFrozen(fixture.operatorState), false);
});

test("recovery constructor rejects non-canonical dependency and target shapes without invoking accessors", async () => {
  const fixture = await createFixture();
  const base = recoveryDependencies(fixture);
  let accessorCalls = 0;
  const topLevelAccessor = { ...base } as Record<string, unknown>;
  Object.defineProperty(topLevelAccessor, "exchangeAccountId", {
    enumerable: true,
    get: () => {
      accessorCalls += 1;
      return ACCOUNT_ID;
    },
  });
  assert.throws(
    () => new PositionGuardPilotRecovery(topLevelAccessor as unknown as RecoveryDependencies),
    /exactly own data properties/,
  );
  assert.equal(accessorCalls, 0);

  const invalidTopLevels: object[] = [
    { ...base, extra: true },
    Object.defineProperty({ ...base }, "hidden", { value: true, enumerable: false }),
    Object.assign(Object.create({ inherited: true }) as object, base),
  ];
  const withSymbol = { ...base } as Record<PropertyKey, unknown>;
  withSymbol[Symbol("unexpected")] = true;
  invalidTopLevels.push(withSymbol);
  for (const invalid of invalidTopLevels) {
    assert.throws(
      () => new PositionGuardPilotRecovery(invalid as RecoveryDependencies),
      /exactly own data properties/,
    );
  }

  const targetAccessor = {} as Record<string, unknown>;
  Object.defineProperty(targetAccessor, "kind", {
    enumerable: true,
    get: () => {
      accessorCalls += 1;
      return "CONFIGURED_ACCOUNT_PILOT";
    },
  });
  const invalidTargets: object[] = [
    targetAccessor,
    { kind: "EXACT_DEPLOYMENT" },
    { kind: "CONFIGURED_ACCOUNT_PILOT", deploymentId: DEPLOYMENT_ID },
    { kind: "EXACT_DEPLOYMENT", deploymentId: DEPLOYMENT_ID, extra: true },
    Object.defineProperty(
      { kind: "EXACT_DEPLOYMENT", deploymentId: DEPLOYMENT_ID },
      "hidden",
      { value: true, enumerable: false },
    ),
    Object.assign(Object.create({ inherited: true }) as object, {
      kind: "EXACT_DEPLOYMENT",
      deploymentId: DEPLOYMENT_ID,
    }),
  ];
  const targetWithSymbol = {
    kind: "EXACT_DEPLOYMENT",
    deploymentId: DEPLOYMENT_ID,
  } as Record<PropertyKey, unknown>;
  targetWithSymbol[Symbol("unexpected")] = true;
  invalidTargets.push(targetWithSymbol);
  for (const targetValue of invalidTargets) {
    assert.throws(
      () => new PositionGuardPilotRecovery({
        ...base,
        target: targetValue as PositionGuardPilotRecoveryTarget,
      }),
      /target|exactly own data properties/,
    );
  }
  assert.equal(accessorCalls, 0);
});

test("another account's deployment is not mutated and only the target global state pauses", async () => {
  const fixture = await createFixture({ deploymentAccountId: "other-account" });

  const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "BLOCKED_FAULT");
  if (result.status !== "BLOCKED_FAULT") return;
  assert.equal(result.reasonCode, "IDENTITY_MISMATCH");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase, "PENDING_FLAT");
  assert.equal((await fixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID))
    .filter((event) => event.eventType === "FAULT_PAUSED").length, 0);
});

test("deployment policy identity mismatch pauses globally without mutating unestablished pilot authority", async () => {
  const fixture = await createFixture();
  const persisted = await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID);
  assert.ok(persisted);
  fixture.recovery = fixture.createRecovery(overrideCandidatePilots(fixture.candidatePilots, {
    getDeployment: async () => ({ ...persisted, policyVersion: "WRONG_VERSION" as typeof POLICY_VERSION }),
  }));

  const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "BLOCKED_FAULT");
  if (result.status !== "BLOCKED_FAULT") return;
  assert.equal(result.reasonCode, "IDENTITY_MISMATCH");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase, "PENDING_FLAT");
  assert.equal((await fixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID))
    .filter((event) => event.eventType === "FAULT_PAUSED").length, 0);
});

test("evidence hash, material version, and exact replay mismatches fault closed", async () => {
  for (const scenario of ["hash", "material", "replay"] as const) {
    const fixture = await createFixture({
      phase: "ACTIVE",
      evidenceQuantity: "0.1",
      balanceFree: "0.1",
      positionQuantity: "0.1",
    });
    const records = await fixture.candidatePilots.listEvidenceRecords(DEPLOYMENT_ID);
    assert.equal(records.length, 1);
    let corrupted: Readonly<CandidateEvidenceRecord>;
    if (scenario === "hash") {
      corrupted = { ...records[0]!, materialHash: "0".repeat(64) };
    } else if (scenario === "material") {
      corrupted = { ...records[0]!, materialVersion: "LEGACY_APPROXIMATE_V1" };
    } else {
      const evidence = {
        ...records[0]!.evidence,
        executedQuantity: "0.2",
        remainingQuantity: "0.2",
      };
      const material = candidateEvidenceMaterial(DEPLOYMENT_ID, evidence);
      corrupted = {
        evidence: material.evidence,
        materialHash: material.hash,
        materialVersion: material.materialVersion,
      };
    }
    fixture.recovery = fixture.createRecovery(overrideCandidatePilots(fixture.candidatePilots, {
      listEvidenceRecords: async () => [corrupted],
    }));

    await expectFault(fixture, "REPLAY_MISMATCH", scenario);
  }
});

test("unknown reconciliation issue codes and malformed summary JSON block by default", async () => {
  for (const scenario of ["unknown", "malformed"] as const) {
    const fixture = await createFixture();
    await fixture.repositories.updateReconciliationRun(reconciliationRun({
      summaryJson: scenario === "unknown"
        ? reconciliationSummaryJson(["NEW_UNREVIEWED_CODE"])
        : "{not-json",
      status: "DRIFT_DETECTED",
    }));

    await expectFault(fixture, "BLOCKING_RECONCILIATION", scenario);
  }
});

test("reconciliation requires a complete schema, allowlisted source, valid counts, and consistent error state", async () => {
  for (const scenario of ["missing-message", "unknown-source", "invalid-counts", "success-with-error"] as const) {
    const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
    const summary = JSON.parse(reconciliationSummaryJson(
      scenario === "missing-message" ? ["ORDER_STATUS_RECONCILED"] : [],
    )) as Record<string, unknown>;
    let status: ReconciliationRunRecord["status"] = scenario === "missing-message" ? "DRIFT_DETECTED" : "SUCCESS";
    let errorMessage: string | null = null;
    if (scenario === "missing-message") {
      delete (summary.issues as Array<Record<string, unknown>>)[0]!.message;
    } else if (scenario === "unknown-source") {
      summary.source = "UNREVIEWED_SOURCE";
      fixture.receipt = {
        ...fixture.receipt,
        reconciliationSource: "UNREVIEWED_SOURCE" as PositionGuardPilotRefreshReceipt["reconciliationSource"],
      };
    } else if (scenario === "invalid-counts") {
      summary.processedCount = -1;
    } else {
      errorMessage = "stale persisted failure";
    }
    await fixture.repositories.updateReconciliationRun({
      ...reconciliationRun({ summaryJson: JSON.stringify(summary), status }),
      errorMessage,
    });

    await expectFault(fixture, "BLOCKING_RECONCILIATION", scenario);
  }
});

test("history recovery rejects failed, contradictory, future, impossible, and inconsistent progress", async () => {
  const scenarios = ["failed", "future", "chronology", "counts", "aggregate-counts", "progress"] as const;
  const outcomes: string[] = [];
  for (const scenario of scenarios) {
    const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
    const summary = JSON.parse(reconciliationSummaryJson([])) as Record<string, unknown>;
    const history = validHistoryRecoverySummary();
    if (scenario === "failed") {
      history.confidenceLevel = "FAILED";
      history.confidenceReason = "LOOKUP_FAILED";
      history.failureMessage = "history lookup failed";
    } else if (scenario === "future") {
      history.markets[0]!.recentClosedWindowEndAt = "2026-08-21T00:02:00.000Z";
    } else if (scenario === "chronology") {
      history.markets[0]!.archivalWindowStartAt = "2026-08-15T00:00:30.000Z";
    } else if (scenario === "counts") {
      history.recoveredOrderCount = history.scannedSnapshotCount + 1;
    } else if (scenario === "aggregate-counts") {
      history.markets[0]!.snapshotCount = Number.MAX_SAFE_INTEGER;
      history.markets[1]!.snapshotCount = Number.MAX_SAFE_INTEGER;
    } else {
      history.coverageStatus = "COMPLETE";
      history.confidenceReason = "ARCHIVE_COMPLETE";
    }
    summary.historyRecovery = history;
    await fixture.repositories.updateReconciliationRun(reconciliationRun({
      summaryJson: JSON.stringify(summary),
      status: "SUCCESS",
    }));

    const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);
    outcomes.push(result.status);
    if (result.status === "BLOCKED_FAULT") {
      assert.equal(result.reasonCode, "BLOCKING_RECONCILIATION", scenario);
    }
  }

  assert.deepEqual(outcomes, scenarios.map(() => "BLOCKED_FAULT"));
});

test("reviewed non-blocking reconciliation issue codes pass verification", async () => {
  const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
  await fixture.repositories.updateReconciliationRun(reconciliationRun({
    summaryJson: reconciliationSummaryJson(["ORDER_STATUS_RECONCILED", "ORDER_FILLS_BACKFILLED"]),
    status: "DRIFT_DETECTED",
  }));

  const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "READY");
  if (result.status === "READY") assert.equal(result.phase, "PENDING_FLAT");
});

test("active and reconciliation-required orders block account-wide recovery", async () => {
  for (const status of ["OPEN", "RECONCILIATION_REQUIRED"] as const) {
    const fixture = await createFixture();
    await fixture.repositories.saveOrder(orderRecord({ status }));

    await expectFault(
      fixture,
      status === "RECONCILIATION_REQUIRED" ? "UNCERTAIN_ORDER" : "ACTIVE_ORDER",
      status,
    );
  }
});

test("unknown persisted order statuses default to UNCERTAIN_ORDER", async () => {
  const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
  await fixture.repositories.saveOrder(orderRecord({
    status: "NEW_PERSISTED_STATUS" as OrderRecord["status"],
  }));

  await expectFault(fixture, "UNCERTAIN_ORDER");
});

test("FAILED and REJECTED orders without definitive lifecycle proof remain uncertain", async () => {
  for (const status of ["FAILED", "REJECTED"] as const) {
    const fixture = await createFixture();
    await fixture.repositories.saveOrder(orderRecord({
      status,
      failureCode: status === "REJECTED" ? "EXCHANGE_ORDER_REJECTED" : "EXCHANGE_SUBMISSION_FAILED",
    }));

    await expectFault(fixture, "UNCERTAIN_ORDER", status);
  }
});

test("definitive rejection and bounded absence lifecycle evidence are safe", async () => {
  const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
  const rejected = {
    ...orderRecord({ id: "order-rejected", status: "REJECTED", failureCode: "EXCHANGE_ORDER_REJECTED" }),
    exchangeResponseJson: JSON.stringify(DEFINITIVE_REJECTION_PAYLOAD),
    failureMessage: "Upbit definitively rejected the order submission.",
    updatedAt: "2026-08-21T00:00:27.000Z",
  };
  const absent = {
    ...orderRecord({
    id: "order-absent",
    status: "FAILED",
    failureCode: "ORDER_SUBMISSION_ABSENCE_CONFIRMED",
    }),
    failureMessage: "Bounded identifier recovery confirmed persistent exchange absence.",
    updatedAt: "2026-08-21T00:00:36.000Z",
  };
  await fixture.repositories.saveOrder(rejected);
  await fixture.repositories.appendOrderEvent({
    ...orderEvent(rejected.id, "ORDER_REJECTED", "EXCHANGE"),
    payloadJson: JSON.stringify(DEFINITIVE_REJECTION_PAYLOAD),
  });
  await fixture.repositories.saveOrder(absent);
  await fixture.repositories.saveOrderSubmissionRecoveryObservation(
    recoveryObservation(absent.id, "absence-1", "2026-08-21T00:00:26.000Z"),
  );
  await fixture.repositories.saveOrderSubmissionRecoveryObservation(
    recoveryObservation(absent.id, "absence-2", "2026-08-21T00:00:36.000Z"),
  );
  await fixture.repositories.appendOrderEvent({
    ...orderEvent(absent.id, "RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED", "RECONCILIATION"),
    id: `identifier-recovery-absence-event:${absent.id}`,
    payloadJson: JSON.stringify(ABSENCE_PROOF_PAYLOAD),
    createdAt: absent.updatedAt,
  });

  const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "READY");
});

test("bounded absence ignores transient history but FOUND remains contradictory", async () => {
  const transientFixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
  const transientAbsent = {
    ...orderRecord({ id: "order-transient-absence", status: "FAILED", failureCode: "ORDER_SUBMISSION_ABSENCE_CONFIRMED" }),
    failureMessage: "Bounded identifier recovery confirmed persistent exchange absence.",
    updatedAt: "2026-08-21T00:00:36.000Z",
  };
  await transientFixture.repositories.saveOrder(transientAbsent);
  await transientFixture.repositories.saveOrderSubmissionRecoveryObservation(
    recoveryObservation(transientAbsent.id, "transient-absence-1", "2026-08-21T00:00:26.000Z"),
  );
  await transientFixture.repositories.saveOrderSubmissionRecoveryObservation({
    ...recoveryObservation(transientAbsent.id, "transient-middle", "2026-08-21T00:00:31.000Z"),
    outcome: "TRANSIENT_FAILURE",
    detailJson: JSON.stringify({
      attemptedQueries: [{ identifier: transientAbsent.identifier }],
      reason: "temporary lookup failure",
    }),
  });
  await transientFixture.repositories.saveOrderSubmissionRecoveryObservation(
    recoveryObservation(transientAbsent.id, "transient-absence-2", "2026-08-21T00:00:36.000Z"),
  );
  await transientFixture.repositories.appendOrderEvent({
    ...orderEvent(transientAbsent.id, "RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED", "RECONCILIATION"),
    id: `identifier-recovery-absence-event:${transientAbsent.id}`,
    payloadJson: JSON.stringify(ABSENCE_PROOF_PAYLOAD),
    createdAt: transientAbsent.updatedAt,
  });

  const transientResult = await transientFixture.recovery.verifyAndPrepareBtcRun(transientFixture.receipt);
  assert.equal(transientResult.status, "READY");

  const foundFixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
  const foundAbsent = {
    ...orderRecord({ id: "order-found-absence", status: "FAILED", failureCode: "ORDER_SUBMISSION_ABSENCE_CONFIRMED" }),
    upbitUuid: "current-order-uuid",
    failureMessage: "Bounded identifier recovery confirmed persistent exchange absence.",
    updatedAt: "2026-08-21T00:00:36.000Z",
  };
  const attemptedQueries = [
    { uuid: foundAbsent.upbitUuid },
    { identifier: foundAbsent.identifier },
  ];
  await foundFixture.repositories.saveOrder(foundAbsent);
  for (const [id, observedAt] of [
    ["found-absence-1", "2026-08-21T00:00:26.000Z"],
    ["found-absence-2", "2026-08-21T00:00:36.000Z"],
  ] as const) {
    await foundFixture.repositories.saveOrderSubmissionRecoveryObservation({
      ...recoveryObservation(foundAbsent.id, id, observedAt),
      detailJson: JSON.stringify({ attemptedQueries }),
    });
  }
  await foundFixture.repositories.saveOrderSubmissionRecoveryObservation({
    ...recoveryObservation(foundAbsent.id, "found-middle", "2026-08-21T00:00:31.000Z"),
    outcome: "FOUND",
    detailJson: JSON.stringify({
      query: { identifier: foundAbsent.identifier },
      attemptedQueries,
      uuid: foundAbsent.upbitUuid,
    }),
  });
  await foundFixture.repositories.appendOrderEvent({
    ...orderEvent(foundAbsent.id, "RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED", "RECONCILIATION"),
    id: `identifier-recovery-absence-event:${foundAbsent.id}`,
    payloadJson: JSON.stringify(ABSENCE_PROOF_PAYLOAD),
    createdAt: foundAbsent.updatedAt,
  });

  await expectFault(foundFixture, "UNCERTAIN_ORDER");
});

test("marker-shaped rejection and absence events cannot prove terminal safety", async () => {
  for (const scenario of ["rejection-payload", "terminal-chronology", "absence-observations"] as const) {
    const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
    if (scenario === "absence-observations") {
      const absent = {
        ...orderRecord({ status: "FAILED", failureCode: "ORDER_SUBMISSION_ABSENCE_CONFIRMED" }),
        failureMessage: "Bounded identifier recovery confirmed persistent exchange absence.",
        updatedAt: "2026-08-21T00:00:36.000Z",
      };
      await fixture.repositories.saveOrder(absent);
      await fixture.repositories.saveOrderSubmissionRecoveryObservation(
        recoveryObservation(absent.id, "forged-absence-1", "2026-08-21T00:00:26.000Z"),
      );
      await fixture.repositories.appendOrderEvent({
        ...orderEvent(absent.id, "RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED", "RECONCILIATION"),
        id: `identifier-recovery-absence-event:${absent.id}`,
        payloadJson: JSON.stringify(ABSENCE_PROOF_PAYLOAD),
        createdAt: absent.updatedAt,
      });
    } else {
      const rejected = {
        ...orderRecord({ status: "REJECTED", failureCode: "EXCHANGE_ORDER_REJECTED" }),
        exchangeResponseJson: JSON.stringify(DEFINITIVE_REJECTION_PAYLOAD),
        failureMessage: "Upbit definitively rejected the order submission.",
        updatedAt: "2026-08-21T00:00:27.000Z",
      };
      await fixture.repositories.saveOrder(rejected);
      await fixture.repositories.appendOrderEvent({
        ...orderEvent(rejected.id, "ORDER_REJECTED", "EXCHANGE"),
        payloadJson: scenario === "rejection-payload" ? "{}" : JSON.stringify(DEFINITIVE_REJECTION_PAYLOAD),
        createdAt: scenario === "terminal-chronology" ? "2026-08-21T00:00:26.000Z" : rejected.updatedAt,
      });
    }

    await expectFault(fixture, "UNCERTAIN_ORDER", scenario);
  }
});

test("terminal no-order proof is final, uncontradicted, and bound to explicit recovery policy", async () => {
  const scenarios = ["later-submission", "found-observation", "policy-mismatch"] as const;
  const outcomes: string[] = [];
  for (const scenario of scenarios) {
    const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
    if (scenario === "policy-mismatch") {
      const absent = {
        ...orderRecord({ status: "FAILED", failureCode: "ORDER_SUBMISSION_ABSENCE_CONFIRMED" }),
        failureMessage: "Bounded identifier recovery confirmed persistent exchange absence.",
        updatedAt: "2026-08-21T00:00:36.000Z",
      };
      await fixture.repositories.saveOrder(absent);
      await fixture.repositories.saveOrderSubmissionRecoveryObservation(
        recoveryObservation(absent.id, "policy-absence-1", "2026-08-21T00:00:26.000Z"),
      );
      await fixture.repositories.saveOrderSubmissionRecoveryObservation(
        recoveryObservation(absent.id, "policy-absence-2", "2026-08-21T00:00:36.000Z"),
      );
      await fixture.repositories.appendOrderEvent({
        ...orderEvent(absent.id, "RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED", "RECONCILIATION"),
        id: `identifier-recovery-absence-event:${absent.id}`,
        payloadJson: JSON.stringify({
          ...ABSENCE_PROOF_PAYLOAD,
          minimumElapsedMs: 5_000,
        }),
        createdAt: absent.updatedAt,
      });
    } else {
      const rejected = {
        ...orderRecord({ status: "REJECTED", failureCode: "EXCHANGE_ORDER_REJECTED" }),
        exchangeResponseJson: JSON.stringify(DEFINITIVE_REJECTION_PAYLOAD),
        failureMessage: "Upbit definitively rejected the order submission.",
        updatedAt: "2026-08-21T00:00:27.000Z",
      };
      await fixture.repositories.saveOrder(rejected);
      await fixture.repositories.appendOrderEvent({
        ...orderEvent(rejected.id, "ORDER_REJECTED", "EXCHANGE"),
        payloadJson: JSON.stringify(DEFINITIVE_REJECTION_PAYLOAD),
        createdAt: rejected.updatedAt,
      });
      if (scenario === "later-submission") {
        await fixture.repositories.appendOrderEvent({
          ...orderEvent(rejected.id, "ORDER_SUBMITTED", "EXCHANGE"),
          id: `${rejected.id}:later-submission`,
          payloadJson: JSON.stringify({ accepted: true, uuid: "later-upbit-uuid" }),
          createdAt: "2026-08-21T00:00:28.000Z",
        });
      } else {
        await fixture.repositories.saveOrderSubmissionRecoveryObservation({
          ...recoveryObservation(rejected.id, "found-after-rejection", "2026-08-21T00:00:28.000Z"),
          outcome: "FOUND",
          detailJson: JSON.stringify({
            query: { identifier: rejected.identifier },
            attemptedQueries: [{ identifier: rejected.identifier }],
            uuid: "found-upbit-uuid",
          }),
        });
      }
    }

    const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);
    outcomes.push(result.status);
    if (result.status === "BLOCKED_FAULT") assert.equal(result.reasonCode, "UNCERTAIN_ORDER", scenario);
  }

  const constructorFixture = await createFixture();
  let acceptedInvalidPolicies = 0;
  for (const policy of [
    { minimumAbsenceObservations: 1, minimumAbsenceElapsedMs: MINIMUM_ABSENCE_ELAPSED_MS },
    { minimumAbsenceObservations: MINIMUM_ABSENCE_OBSERVATIONS, minimumAbsenceElapsedMs: 0 },
    { minimumAbsenceObservations: MINIMUM_ABSENCE_OBSERVATIONS, minimumAbsenceElapsedMs: 1.5 },
  ]) {
    try {
      constructorFixture.createRecovery(undefined, undefined, policy);
      acceptedInvalidPolicies += 1;
    } catch {
      // Expected once the explicit bounded-absence policy is validated.
    }
  }

  assert.deepEqual({ outcomes, acceptedInvalidPolicies }, {
    outcomes: scenarios.map(() => "BLOCKED_FAULT"),
    acceptedInvalidPolicies: 0,
  });
});

test("malformed or future lifecycle timestamps cannot prove definitive rejection", async () => {
  for (const createdAt of ["2026-08-21 00:00:27", "2026-08-21T00:02:00.000Z"]) {
    const fixture = await createFixture();
    const rejected = orderRecord({ status: "REJECTED", failureCode: "EXCHANGE_ORDER_REJECTED" });
    await fixture.repositories.saveOrder(rejected);
    await fixture.repositories.appendOrderEvent({
      ...orderEvent(rejected.id, "ORDER_REJECTED", "EXCHANGE"),
      createdAt,
    });

    await expectFault(fixture, "UNCERTAIN_ORDER", createdAt);
  }
});

test("every order status rejects malformed, future, mismatched, or unknown recovery observations", async () => {
  const scenarios = [
    { name: "rejected-unknown-outcome", status: "REJECTED" as const },
    { name: "filled-future", status: "FILLED" as const },
    { name: "canceled-epoch-mismatch", status: "CANCELED" as const },
    { name: "risk-rejected-identity", status: "RISK_REJECTED" as const },
  ];
  const outcomes: string[] = [];
  for (const scenario of scenarios) {
    const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
    let order = orderRecord({ status: scenario.status });
    if (scenario.status === "REJECTED") {
      order = {
        ...order,
        failureCode: "EXCHANGE_ORDER_REJECTED",
        exchangeResponseJson: JSON.stringify(DEFINITIVE_REJECTION_PAYLOAD),
        failureMessage: "Upbit definitively rejected the order submission.",
        updatedAt: "2026-08-21T00:00:27.000Z",
      };
    }
    await fixture.repositories.saveOrder(order);
    if (scenario.status === "REJECTED") {
      await fixture.repositories.appendOrderEvent({
        ...orderEvent(order.id, "ORDER_REJECTED", "EXCHANGE"),
        payloadJson: JSON.stringify(DEFINITIVE_REJECTION_PAYLOAD),
        createdAt: order.updatedAt,
      });
    }
    let observation = recoveryObservation(order.id, `${scenario.name}-observation`, "2026-08-21T00:00:28.000Z");
    if (scenario.name === "rejected-unknown-outcome") {
      observation = {
        ...observation,
        outcome: "UNKNOWN_OUTCOME" as OrderSubmissionRecoveryObservationRecord["outcome"],
      };
    } else if (scenario.name === "filled-future") {
      observation = recoveryObservation(order.id, `${scenario.name}-observation`, "2026-08-21T00:02:00.000Z");
    } else if (scenario.name === "canceled-epoch-mismatch") {
      observation = { ...observation, observedAtEpochMs: observation.observedAtEpochMs + 1 };
    } else {
      observation = { ...observation, orderId: "different-order" };
    }
    const repositories = overrideExecutionRepositories(fixture.repositories, {
      listOrderSubmissionRecoveryObservations: async () => [observation],
    });
    fixture.recovery = fixture.createRecovery(undefined, repositories);

    const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);
    outcomes.push(result.status);
    if (result.status === "BLOCKED_FAULT") assert.equal(result.reasonCode, "UNCERTAIN_ORDER", scenario.name);
  }

  assert.deepEqual(outcomes, scenarios.map(() => "BLOCKED_FAULT"));
});

test("every observation query and returned UUID is bound to the persisted order", async () => {
  const statuses: OrderRecord["status"][] = [
    "INTENT_CREATED",
    "PERSISTED",
    "SUBMITTING",
    "OPEN",
    "PARTIALLY_FILLED",
    "CANCEL_REQUESTED",
    "RECONCILIATION_REQUIRED",
    "FAILED",
    "REJECTED",
    "RISK_REJECTED",
    "FILLED",
    "CANCELED",
  ];
  for (const status of statuses) {
    const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
    const order = orderRecord({ id: `foreign-query-${status.toLowerCase()}`, status });
    await fixture.repositories.saveOrder(order);
    await fixture.repositories.saveOrderSubmissionRecoveryObservation({
      ...recoveryObservation(order.id, `foreign-observation-${status.toLowerCase()}`, "2026-08-21T00:00:28.000Z"),
      detailJson: JSON.stringify({ attemptedQueries: [{ identifier: "foreign-order-identifier" }] }),
    });

    await expectFault(fixture, "UNCERTAIN_ORDER", status);
  }

  const returnedUuidFixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
  const returnedUuidOrder = {
    ...orderRecord({ id: "foreign-returned-uuid", status: "FILLED" }),
    upbitUuid: "persisted-order-uuid",
  };
  const returnedUuidQueries = [
    { uuid: returnedUuidOrder.upbitUuid },
    { identifier: returnedUuidOrder.identifier },
  ];
  await returnedUuidFixture.repositories.saveOrder(returnedUuidOrder);
  await returnedUuidFixture.repositories.saveOrderSubmissionRecoveryObservation({
    ...recoveryObservation(returnedUuidOrder.id, "foreign-returned-uuid-observation", "2026-08-21T00:00:28.000Z"),
    outcome: "FOUND",
    detailJson: JSON.stringify({
      query: { identifier: returnedUuidOrder.identifier },
      attemptedQueries: returnedUuidQueries,
      uuid: "foreign-returned-uuid",
    }),
  });
  await expectFault(returnedUuidFixture, "UNCERTAIN_ORDER", "foreign returned UUID");

  const legitimateFixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
  const legitimateOrder = {
    ...orderRecord({ id: "legitimate-observation-bindings", status: "FILLED" }),
    upbitUuid: "legitimate-order-uuid",
  };
  await legitimateFixture.repositories.saveOrder(legitimateOrder);
  await legitimateFixture.repositories.saveOrderSubmissionRecoveryObservation({
    ...recoveryObservation(legitimateOrder.id, "legitimate-not-found", "2026-08-21T00:00:27.000Z"),
    detailJson: JSON.stringify({ attemptedQueries: [{ identifier: legitimateOrder.identifier }] }),
  });
  await legitimateFixture.repositories.saveOrderSubmissionRecoveryObservation({
    ...recoveryObservation(legitimateOrder.id, "legitimate-transient", "2026-08-21T00:00:28.000Z"),
    outcome: "TRANSIENT_FAILURE",
    detailJson: JSON.stringify({
      attemptedQueries: [{ uuid: legitimateOrder.upbitUuid }],
      reason: "temporary lookup failure",
    }),
  });
  await legitimateFixture.repositories.saveOrderSubmissionRecoveryObservation({
    ...recoveryObservation(legitimateOrder.id, "legitimate-found", "2026-08-21T00:00:29.000Z"),
    outcome: "FOUND",
    detailJson: JSON.stringify({
      query: { identifier: legitimateOrder.identifier },
      attemptedQueries: [{ identifier: legitimateOrder.identifier }],
      uuid: legitimateOrder.upbitUuid,
    }),
  });

  const legitimateResult = await legitimateFixture.recovery.verifyAndPrepareBtcRun(legitimateFixture.receipt);
  assert.equal(legitimateResult.status, "READY");
});

test("balance, position, replay inventory, and malformed numeric mismatches fault closed", async () => {
  const scenarios = [
    { name: "balance-position", balanceFree: "0.2", positionQuantity: "0.1", evidenceQuantity: "0.1" },
    { name: "replay-exchange", balanceFree: "0.2", positionQuantity: "0.2", evidenceQuantity: "0.1" },
    { name: "negative", balanceFree: "-0.1", positionQuantity: "0.1", evidenceQuantity: "0.1" },
    { name: "non-finite", balanceFree: "NaN", positionQuantity: "0.1", evidenceQuantity: "0.1" },
  ];
  for (const scenario of scenarios) {
    const fixture = await createFixture({
      phase: "ACTIVE",
      evidenceQuantity: scenario.evidenceQuantity,
      balanceFree: scenario.balanceFree,
      positionQuantity: scenario.positionQuantity,
    });
    await expectFault(fixture, "INVENTORY_MISMATCH", scenario.name);
  }
});

test("activation CAS conflict faults instead of accepting separately activated state", async () => {
  const fixture = await createFixture();
  fixture.recovery = fixture.createRecovery(overrideCandidatePilots(fixture.candidatePilots, {
    activateDeployment: async () => null,
  }));

  await expectFault(fixture, "ACTIVATION_CAS_CONFLICT");
});

test("restart retry reuses the deterministic Task 9A1 recovery fault", async () => {
  const fixture = await createFixture();
  await fixture.repositories.saveBalanceSnapshot(balanceSnapshot({
    id: "balance-newer",
    capturedAt: "2026-08-21T00:00:40.000Z",
  }));

  const first = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);
  const retry = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(first.status, "BLOCKED_FAULT");
  assert.equal(retry.status, "BLOCKED_FAULT");
  if (first.status !== "BLOCKED_FAULT" || retry.status !== "BLOCKED_FAULT") return;
  assert.equal(first.faultId, retry.faultId);
  assert.equal((await fixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID))
    .filter((event) => event.id === first.faultId).length, 1);
  assert.equal((await fixture.operatorState.listTransitions(100))
    .filter((transition) => transition.id === first.faultId).length, 1);
});

test("fault identity includes complete reason-relevant persisted authority material", async () => {
  const firstFixture = await createFixture({
    phase: "ACTIVE",
    evidenceQuantity: "0.1",
    balanceFree: "0.2",
    positionQuantity: "0.1",
  });
  const secondFixture = await createFixture({
    phase: "ACTIVE",
    evidenceQuantity: "0.1",
    balanceFree: "0.3",
    positionQuantity: "0.1",
  });

  const first = await firstFixture.recovery.verifyAndPrepareBtcRun(firstFixture.receipt);
  const second = await secondFixture.recovery.verifyAndPrepareBtcRun(secondFixture.receipt);

  assert.equal(first.status, "BLOCKED_FAULT");
  assert.equal(second.status, "BLOCKED_FAULT");
  if (first.status !== "BLOCKED_FAULT" || second.status !== "BLOCKED_FAULT") return;
  assert.equal(first.reasonCode, "INVENTORY_MISMATCH");
  assert.equal(second.reasonCode, "INVENTORY_MISMATCH");
  assert.notEqual(first.faultId, second.faultId);
});

test("a concurrent authoritative change between verification reads cannot return stale READY", async () => {
  const fixture = await createFixture({ balanceFree: "0.2", positionQuantity: "0.2" });
  const firstPosition = await fixture.repositories.getLatestPositionSnapshot(ACCOUNT_ID);
  assert.ok(firstPosition);
  let positionReadCount = 0;
  const changingRepositories = overrideExecutionRepositories(fixture.repositories, {
    getLatestPositionSnapshot: async () => {
      positionReadCount += 1;
      return positionReadCount === 1
        ? firstPosition
        : positionSnapshot({ capturedAt: firstPosition.capturedAt, quantity: "0.3" });
    },
  });
  fixture.recovery = fixture.createRecovery(undefined, changingRepositories);

  await expectFault(fixture, "SNAPSHOT_PROVENANCE_INVALID");
  assert.ok(positionReadCount >= 2);
});

test("successful recovery never resumes a pre-existing operator pause", async () => {
  const fixture = await createFixture({ operatorStatus: "PAUSED" });
  const beforeTransitions = await fixture.operatorState.listTransitions(100);

  const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);

  assert.equal(result.status, "READY");
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED");
  assert.equal((await fixture.operatorState.getState()).pauseReason, "operator-maintenance");
  assert.deepEqual(await fixture.operatorState.listTransitions(100), beforeTransitions);
});

interface FixtureOptions {
  createDeployment?: boolean;
  deploymentAccountId?: string;
  phase?: "PENDING_FLAT" | "ACTIVE";
  evidenceQuantity?: string;
  balanceFree?: string;
  balanceLocked?: string;
  positionQuantity?: string;
  snapshotAt?: string;
  reconciliationCompletedAt?: string;
  operatorStatus?: "RUNNING" | "PAUSED";
  minimumAbsenceObservations?: number;
  minimumAbsenceElapsedMs?: number;
}

interface RecoveryFixture {
  repositories: InMemoryExecutionRepository;
  operatorState: InMemoryOperatorStateStore;
  candidatePilots: InMemoryCandidatePilotRepository;
  receipt: PositionGuardPilotRefreshReceipt;
  recovery: PositionGuardPilotRecovery;
  createRecovery(
    candidatePilots?: CandidatePilotRepository,
    repositories?: ExecutionRepository,
    absencePolicy?: {
      minimumAbsenceObservations: number;
      minimumAbsenceElapsedMs: number;
    },
    recoveryNow?: string,
    target?: PositionGuardPilotRecoveryTarget,
  ): PositionGuardPilotRecovery;
  createConfiguredRecovery(
    candidatePilots?: CandidatePilotRepository,
    repositories?: ExecutionRepository,
  ): PositionGuardPilotRecovery;
}

async function createFixture(options: FixtureOptions = {}): Promise<RecoveryFixture> {
  const snapshotAt = options.snapshotAt ?? SNAPSHOT_AT;
  const reconciliationCompletedAt = options.reconciliationCompletedAt ?? RECONCILIATION_COMPLETED_AT;
  const operatorState = new InMemoryOperatorStateStore(initialExecutionState(options.operatorStatus ?? "RUNNING"));
  const repositories = new InMemoryExecutionRepository(operatorState);
  const candidatePilots = new InMemoryCandidatePilotRepository(operatorState);
  if (options.createDeployment !== false) {
    await candidatePilots.createDeploymentWithInitialState({
      deployment: deploymentRecord({ exchangeAccountId: options.deploymentAccountId ?? ACCOUNT_ID }),
      initialState: createEmptyPositionGuardCandidateState(),
    });
    if (options.phase === "ACTIVE") {
      const activated = await candidatePilots.activateDeployment({
        deploymentId: DEPLOYMENT_ID,
        expectedPhase: "PENDING_FLAT",
        expectedUpdatedAt: CREATED_AT,
        activationAt: ACTIVATED_AT,
        activationEpochNs: BigInt(Date.parse(ACTIVATED_AT)) * 1_000_000n,
      });
      assert.ok(activated);
      if (options.evidenceQuantity !== undefined) {
        await candidatePilots.advanceStateWithEvidence({
          deploymentId: DEPLOYMENT_ID,
          expectedStateVersion: 0,
          evidence: {
            evidenceId: "evidence-enter-1",
            executedAt: EVIDENCE_AT,
            action: "ENTER",
            entryPath: "PULLBACK",
            terminalStatus: "FILLED",
            executedQuantity: options.evidenceQuantity,
            grossQuoteValueKrw: "10000000",
            confirmedFeeKrw: "5000",
            remainingQuantity: options.evidenceQuantity,
          },
        });
      }
    }
  }

  await repositories.saveBalanceSnapshot(balanceSnapshot({
    capturedAt: snapshotAt,
    ...(options.balanceFree !== undefined ? { balanceFree: options.balanceFree } : {}),
    ...(options.balanceLocked !== undefined ? { balanceLocked: options.balanceLocked } : {}),
  }));
  await repositories.savePositionSnapshot(positionSnapshot({
    capturedAt: snapshotAt,
    ...(options.positionQuantity !== undefined ? { quantity: options.positionQuantity } : {}),
  }));
  await repositories.saveReconciliationRun(reconciliationRun({
    startedAt: snapshotAt,
    completedAt: reconciliationCompletedAt,
  }));

  const receipt: PositionGuardPilotRefreshReceipt = {
    exchangeAccountId: ACCOUNT_ID,
    requestedAt: snapshotAt,
    balanceSnapshotId: "balance-refresh",
    balanceCapturedAt: snapshotAt,
    positionSnapshotId: "position-refresh",
    positionCapturedAt: snapshotAt,
    reconciliationRunId: "reconciliation-refresh",
    reconciliationStartedAt: snapshotAt,
    reconciliationCompletedAt,
    reconciliationSource: "SCHEDULER_PREFLIGHT",
  };
  const createRecovery = (
    pilotRepository: CandidatePilotRepository = candidatePilots,
    executionRepositories: ExecutionRepository = repositories,
    absencePolicy = {
      minimumAbsenceObservations: options.minimumAbsenceObservations ?? MINIMUM_ABSENCE_OBSERVATIONS,
      minimumAbsenceElapsedMs: options.minimumAbsenceElapsedMs ?? MINIMUM_ABSENCE_ELAPSED_MS,
    },
    recoveryNow = NOW,
    target: PositionGuardPilotRecoveryTarget = {
      kind: "EXACT_DEPLOYMENT",
      deploymentId: DEPLOYMENT_ID,
    },
  ) => {
    const dependencies = {
      exchangeAccountId: ACCOUNT_ID,
      target,
      pilotId: PILOT_ID,
      market: "KRW-BTC",
      policyId: POLICY_ID,
      policyVersion: POLICY_VERSION,
      freshnessThresholdMs: FRESHNESS_THRESHOLD_MS,
      minimumAbsenceObservations: absencePolicy.minimumAbsenceObservations,
      minimumAbsenceElapsedMs: absencePolicy.minimumAbsenceElapsedMs,
      clock: {
        now: () => ({ occurredAt: recoveryNow, occurredAtEpochMs: Date.parse(recoveryNow) }),
      },
      repositories: executionRepositories,
      candidatePilots: pilotRepository,
      operatorState,
    } as const;
    return new PositionGuardPilotRecovery(dependencies);
  };
  return {
    repositories,
    operatorState,
    candidatePilots,
    receipt,
    recovery: createRecovery(),
    createRecovery,
    createConfiguredRecovery: (
      pilotRepository: CandidatePilotRepository = candidatePilots,
      executionRepositories: ExecutionRepository = repositories,
    ) => createRecovery(
      pilotRepository,
      executionRepositories,
      undefined,
      undefined,
      { kind: "CONFIGURED_ACCOUNT_PILOT" },
    ),
  };
}

async function expectFault(
  fixture: RecoveryFixture,
  reasonCode: CandidatePilotRecoveryFaultReason,
  label?: string,
): Promise<void> {
  const result = await fixture.recovery.verifyAndPrepareBtcRun(fixture.receipt);
  assert.equal(result.status, "BLOCKED_FAULT", label);
  if (result.status !== "BLOCKED_FAULT") return;
  assert.equal(result.reasonCode, reasonCode, label);
  assert.equal(result.executableAuthority, false, label);
  assert.equal("deployment" in result, false, label);
  assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED", label);
  assert.equal((await fixture.candidatePilots.getDeployment(DEPLOYMENT_ID))?.phase, "PAUSED_FAULT", label);
  assert.equal((await fixture.candidatePilots.listAuditEvents(DEPLOYMENT_ID))
    .filter((event) => event.id === result.faultId).length, 1, label);
}

function deploymentRecord(input: { exchangeAccountId: string }): PositionGuardPilotDeploymentRecord {
  return {
    id: DEPLOYMENT_ID,
    exchangeAccountId: input.exchangeAccountId,
    pilotId: PILOT_ID,
    market: "KRW-BTC",
    policyId: POLICY_ID,
    policyVersion: POLICY_VERSION,
    phase: "PENDING_FLAT",
    activationAt: null,
    activationEpochNs: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function balanceSnapshot(input: {
  id?: string;
  capturedAt?: string;
  balanceFree?: string;
  balanceLocked?: string;
} = {}): BalanceSnapshotRecord {
  return {
    id: input.id ?? "balance-refresh",
    exchangeAccountId: ACCOUNT_ID,
    capturedAt: input.capturedAt ?? SNAPSHOT_AT,
    source: "RECONCILIATION",
    totalKrwValue: null,
    balancesJson: JSON.stringify([{
      currency: "BTC",
      balance: input.balanceFree ?? "0",
      locked: input.balanceLocked ?? "0",
      avgBuyPrice: "0",
      unitCurrency: "KRW",
    }]),
  };
}

function positionSnapshot(input: { capturedAt?: string; quantity?: string } = {}): PositionSnapshotRecord {
  const capturedAt = input.capturedAt ?? SNAPSHOT_AT;
  return {
    id: "position-refresh",
    exchangeAccountId: ACCOUNT_ID,
    capturedAt,
    source: "RECONCILIATION",
    positionsJson: JSON.stringify([{
      asset: "BTC",
      market: "KRW-BTC",
      quantity: input.quantity ?? "0",
      averageEntryPrice: null,
      markPrice: null,
      marketValue: null,
      exposureRatio: null,
      capturedAt,
    }]),
  };
}

function reconciliationRun(input: {
  startedAt?: string;
  completedAt?: string;
  summaryJson?: string;
  status?: ReconciliationRunRecord["status"];
} = {}): ReconciliationRunRecord {
  return {
    id: "reconciliation-refresh",
    exchangeAccountId: ACCOUNT_ID,
    status: input.status ?? "SUCCESS",
    startedAt: input.startedAt ?? SNAPSHOT_AT,
    completedAt: input.completedAt ?? RECONCILIATION_COMPLETED_AT,
    summaryJson: input.summaryJson ?? reconciliationSummaryJson([]),
    errorMessage: null,
  };
}

function reconciliationSummaryJson(issueCodes: string[]): string {
  return JSON.stringify({
    source: "SCHEDULER_PREFLIGHT",
    status: issueCodes.length === 0 ? "SUCCESS" : "DRIFT_DETECTED",
    issues: issueCodes.map((code) => ({ code, message: `fixture:${code}` })),
    candidateCount: 0,
    processedCount: 0,
    deferredCount: 0,
    maxOrderLookupsPerRun: 10,
  });
}

function validHistoryRecoverySummary() {
  const marketProgress = (market: "KRW-BTC" | "KRW-ETH") => ({
    market,
    recentClosedWindowStartAt: "2026-08-14T00:00:30.000Z",
    recentClosedWindowEndAt: SNAPSHOT_AT,
    archivalWindowStartAt: "2026-08-07T00:00:30.000Z",
    archivalWindowEndAt: "2026-08-14T00:00:30.000Z",
    nextWindowEndAt: "2026-08-07T00:00:30.000Z",
    archiveComplete: false,
    retentionStatus: "WITHIN_ASSUMED_RETENTION",
    confidenceLevel: "PARTIAL",
    confidenceReason: "ARCHIVE_IN_PROGRESS",
    openHistoryTruncated: false,
    recentClosedHistoryTruncated: false,
    archivalClosedHistoryTruncated: false,
    openPagesScanned: 1,
    recentClosedPagesScanned: 1,
    archivalClosedPagesScanned: 1,
    snapshotCount: 2,
  });
  return {
    closedOrderLookbackDays: 7,
    stopBeforeDays: 365,
    stopBeforeAt: "2025-08-21T00:00:30.000Z",
    retentionAssumptionDays: 365,
    retentionBoundaryAt: "2025-08-21T00:00:30.000Z",
    retentionStatus: "WITHIN_ASSUMED_RETENTION",
    coverageStatus: "IN_PROGRESS",
    confidenceLevel: "PARTIAL",
    confidenceReason: "ARCHIVE_IN_PROGRESS",
    failureMessage: null as string | null,
    scannedSnapshotCount: 2,
    recoveredOrderCount: 1,
    markets: [marketProgress("KRW-BTC"), marketProgress("KRW-ETH")],
  };
}

function orderRecord(input: {
  id?: string;
  status: OrderRecord["status"];
  failureCode?: string | null;
}): OrderRecord {
  const id = input.id ?? `order-${input.status.toLowerCase()}`;
  return {
    id,
    strategyDecisionId: null,
    exchangeAccountId: ACCOUNT_ID,
    market: "KRW-ETH",
    side: "bid",
    ordType: "price",
    volume: null,
    price: "5000",
    timeInForce: null,
    smpType: null,
    identifier: `${id}-identifier`,
    idempotencyKey: `${id}-idempotency`,
    origin: "STRATEGY",
    requestedAt: "2026-08-21T00:00:25.000Z",
    upbitUuid: null,
    status: input.status,
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: input.failureCode ?? null,
    failureMessage: null,
    createdAt: "2026-08-21T00:00:25.000Z",
    updatedAt: "2026-08-21T00:00:26.000Z",
  };
}

function orderEvent(
  orderId: string,
  eventType: string,
  eventSource: OrderEventRecord["eventSource"],
): OrderEventRecord {
  return {
    id: `${orderId}:${eventType}`,
    orderId,
    eventType,
    eventSource,
    payloadJson: "{}",
    createdAt: "2026-08-21T00:00:27.000Z",
  };
}

function recoveryObservation(
  orderId: string,
  id: string,
  observedAt: string,
): OrderSubmissionRecoveryObservationRecord {
  return {
    id,
    orderId,
    outcome: "NOT_FOUND",
    observedAt,
    observedAtEpochMs: Date.parse(observedAt),
    detailJson: JSON.stringify({ attemptedQueries: [{ identifier: `${orderId}-identifier` }] }),
    createdAt: observedAt,
  };
}

function initialExecutionState(status: "RUNNING" | "PAUSED"): ExecutionStateRecord {
  return {
    id: `execution_state_${ACCOUNT_ID}`,
    exchangeAccountId: ACCOUNT_ID,
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    systemStatus: status,
    killSwitchActive: false,
    pauseReason: status === "PAUSED" ? "operator-maintenance" : null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-08-20T23:59:59.000Z",
  };
}

function overrideCandidatePilots(
  base: CandidatePilotRepository,
  overrides: Partial<CandidatePilotRepository>,
): CandidatePilotRepository {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return Reflect.get(overrides, property, receiver);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function overrideExecutionRepositories(
  base: ExecutionRepository,
  overrides: Partial<ExecutionRepository>,
): ExecutionRepository {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return Reflect.get(overrides, property, receiver);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function recoveryDependencies(
  fixture: RecoveryFixture,
  overrides: Partial<RecoveryDependencies> = {},
): RecoveryDependencies {
  return {
    exchangeAccountId: ACCOUNT_ID,
    target: {
      kind: "EXACT_DEPLOYMENT",
      deploymentId: DEPLOYMENT_ID,
    },
    pilotId: PILOT_ID,
    market: "KRW-BTC",
    policyId: POLICY_ID,
    policyVersion: POLICY_VERSION,
    freshnessThresholdMs: FRESHNESS_THRESHOLD_MS,
    minimumAbsenceObservations: MINIMUM_ABSENCE_OBSERVATIONS,
    minimumAbsenceElapsedMs: MINIMUM_ABSENCE_ELAPSED_MS,
    clock: {
      now: () => ({ occurredAt: NOW, occurredAtEpochMs: Date.parse(NOW) }),
    },
    repositories: fixture.repositories,
    candidatePilots: fixture.candidatePilots,
    operatorState: fixture.operatorState,
    ...overrides,
  };
}
