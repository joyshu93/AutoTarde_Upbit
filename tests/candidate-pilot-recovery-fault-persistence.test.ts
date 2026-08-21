import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

import type { ExecutionStateRecord } from "../src/domain/types.js";
import type {
  CandidatePilotRepository,
  PauseCandidatePilotForRecoveryFaultInput,
} from "../src/modules/db/pilot-interfaces.js";
import type { OperatorStateStore } from "../src/modules/db/interfaces.js";
import { InMemoryCandidatePilotRepository } from
  "../src/modules/db/repositories/in-memory-candidate-pilot-repository.js";
import { InMemoryOperatorStateStore } from
  "../src/modules/db/repositories/in-memory-repositories.js";
import { openSqliteDatabase } from "../src/modules/db/repositories/sqlite-database.js";
import { createSqlitePersistence } from "../src/modules/db/repositories/sqlite-repositories.js";
import { createEmptyPositionGuardCandidateState } from
  "../src/modules/strategy/position-guard-candidate-state.js";
import { test } from "./harness.js";

interface FaultPauseFixture {
  candidatePilots: CandidatePilotRepository;
  operatorState: OperatorStateStore;
  db: DatabaseSync | null;
  close(): Promise<void>;
}

const FACTORIES = [
  { name: "in-memory", create: createInMemoryFixture },
  { name: "sqlite", create: createSqliteFixture },
] as const;

test("candidate recovery fault pause is atomic and idempotent in every repository", async () => {
  for (const factory of FACTORIES) {
    const fixture = await factory.create(`atomic-idempotent-${factory.name}`);
    try {
      const deployment = await createDeployment(fixture, `deployment-${factory.name}`);
      const input = recoveryFaultInput(deployment.id, addMilliseconds(deployment.updatedAt, 1));

      const first = await fixture.candidatePilots.pauseForRecoveryFault(input);
      const retry = await fixture.candidatePilots.pauseForRecoveryFault(input);
      const persistedDeployment = await fixture.candidatePilots.getDeployment(deployment.id);
      const faultAudits = (await fixture.candidatePilots.listAuditEvents(deployment.id))
        .filter((event) => event.id === input.faultId);
      const faultTransitions = (await fixture.operatorState.listTransitions(100))
        .filter((transition) => transition.id === input.faultId);

      assert.equal(first.duplicate, false, factory.name);
      assert.equal(retry.duplicate, true, factory.name);
      assert.equal(first.deployment.phase, "PAUSED_FAULT", factory.name);
      assert.equal(first.deployment.updatedAt, input.occurredAt, factory.name);
      assert.equal(persistedDeployment?.phase, "PAUSED_FAULT", factory.name);
      assert.equal(first.executionState.systemStatus, "PAUSED", factory.name);
      assert.equal(retry.executionState.systemStatus, "PAUSED", factory.name);
      assert.equal((await fixture.operatorState.getState()).systemStatus, "PAUSED", factory.name);
      assert.equal(faultAudits.length, 1, factory.name);
      assert.equal(faultAudits[0]?.eventType, "FAULT_PAUSED", factory.name);
      assert.equal(faultAudits[0]?.fromPhase, "PENDING_FLAT", factory.name);
      assert.equal(faultAudits[0]?.toPhase, "PAUSED_FAULT", factory.name);
      assert.equal(faultAudits[0]?.stateVersion, 0, factory.name);
      assert.equal(faultAudits[0]?.createdAt, input.occurredAt, factory.name);
      assert.deepEqual(JSON.parse(faultAudits[0]?.payloadJson ?? "null"), {
        reasonCode: input.reasonCode,
        provenanceJson: input.provenanceJson,
      }, factory.name);
      assert.equal(faultTransitions.length, 1, factory.name);
      assert.equal(faultTransitions[0]?.command, "AUTOMATIC_PAUSE", factory.name);
      assert.equal(faultTransitions[0]?.fromSystemStatus, "RUNNING", factory.name);
      assert.equal(faultTransitions[0]?.toSystemStatus, "PAUSED", factory.name);
      assert.equal(faultTransitions[0]?.createdAt, input.occurredAt, factory.name);
      assert.equal(
        faultTransitions[0]?.reason,
        `faultId=${input.faultId}; reason=candidate_pilot_recovery:${input.reasonCode}; ` +
          `provenance=${input.provenanceJson}`,
        factory.name,
      );
    } finally {
      await fixture.close();
    }
  }
});

test("concurrent identical candidate recovery faults serialize to one audit and transition", async () => {
  for (const factory of FACTORIES) {
    const fixture = await factory.create(`concurrent-idempotent-${factory.name}`);
    try {
      const deployment = await createDeployment(fixture, `deployment-concurrent-${factory.name}`);
      const input = recoveryFaultInput(deployment.id, addMilliseconds(deployment.updatedAt, 1));

      const results = await Promise.all([
        fixture.candidatePilots.pauseForRecoveryFault(input),
        fixture.candidatePilots.pauseForRecoveryFault(input),
      ]);
      const faultAudits = (await fixture.candidatePilots.listAuditEvents(deployment.id))
        .filter((event) => event.id === input.faultId);
      const faultTransitions = (await fixture.operatorState.listTransitions(100))
        .filter((transition) => transition.id === input.faultId);

      assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true], factory.name);
      assert.equal(faultAudits.length, 1, factory.name);
      assert.equal(faultTransitions.length, 1, factory.name);
    } finally {
      await fixture.close();
    }
  }
});

test("candidate recovery fault keeps occurrence provenance after a later kill switch", async () => {
  for (const factory of FACTORIES) {
    const fixture = await factory.create(`later-kill-switch-${factory.name}`);
    try {
      const deployment = await createDeployment(fixture, `deployment-later-kill-${factory.name}`);
      const input = recoveryFaultInput(deployment.id, addMilliseconds(deployment.updatedAt, 1));
      await waitUntilAfter(input.occurredAt);
      const killSwitchState = await fixture.operatorState.activateKillSwitch("operator_before_fault_persistence");

      assert.ok(Date.parse(killSwitchState.updatedAt) > Date.parse(input.occurredAt), factory.name);
      const first = await fixture.candidatePilots.pauseForRecoveryFault(input);
      const retry = await fixture.candidatePilots.pauseForRecoveryFault(input);
      const faultAudit = (await fixture.candidatePilots.listAuditEvents(deployment.id))
        .filter((event) => event.id === input.faultId);
      const faultTransition = (await fixture.operatorState.listTransitions(100))
        .filter((transition) => transition.id === input.faultId);

      assert.equal(first.duplicate, false, factory.name);
      assert.equal(retry.duplicate, true, factory.name);
      assert.equal(first.deployment.updatedAt, input.occurredAt, factory.name);
      assert.equal(first.auditEvent.createdAt, input.occurredAt, factory.name);
      assert.equal(first.executionState.systemStatus, "KILL_SWITCHED", factory.name);
      assert.equal(first.executionState.killSwitchActive, true, factory.name);
      assert.equal(first.executionState.pauseReason, killSwitchState.pauseReason, factory.name);
      assert.equal(first.executionState.updatedAt, killSwitchState.updatedAt, factory.name);
      assert.equal(faultAudit.length, 1, factory.name);
      assert.equal(faultTransition.length, 1, factory.name);
      assert.equal(faultTransition[0]?.createdAt, killSwitchState.updatedAt, factory.name);
      assert.equal(faultTransition[0]?.fromSystemStatus, "KILL_SWITCHED", factory.name);
      assert.equal(faultTransition[0]?.toSystemStatus, "KILL_SWITCHED", factory.name);
      assert.equal(faultTransition[0]?.fromKillSwitchActive, true, factory.name);
      assert.equal(faultTransition[0]?.toKillSwitchActive, true, factory.name);
    } finally {
      await fixture.close();
    }
  }
});

test("candidate recovery fault rejects conflicting fault-id reuse without further mutation", async () => {
  for (const factory of FACTORIES) {
    const fixture = await factory.create(`conflicting-reuse-${factory.name}`);
    try {
      const deployment = await createDeployment(fixture, `deployment-conflict-${factory.name}`);
      const input = recoveryFaultInput(deployment.id, addMilliseconds(deployment.updatedAt, 1));
      await fixture.candidatePilots.pauseForRecoveryFault(input);
      const beforeState = await fixture.operatorState.getState();

      await assert.rejects(
        () => fixture.candidatePilots.pauseForRecoveryFault({
          ...input,
          reasonCode: "IDENTITY_MISMATCH",
        }),
        /conflicting duplicate candidate recovery fault/i,
        factory.name,
      );

      assert.deepEqual(await fixture.operatorState.getState(), beforeState, factory.name);
      assert.equal((await fixture.candidatePilots.listAuditEvents(deployment.id))
        .filter((event) => event.id === input.faultId).length, 1, factory.name);
      assert.equal((await fixture.operatorState.listTransitions(100))
        .filter((transition) => transition.id === input.faultId).length, 1, factory.name);
    } finally {
      await fixture.close();
    }
  }
});

test("candidate recovery fault rejects illegal phases and backdated chronology without partial pause", async () => {
  for (const factory of FACTORIES) {
    for (const scenario of ["illegal-phase", "backdated"] as const) {
      const fixture = await factory.create(`${scenario}-${factory.name}`);
      try {
        const deployment = await createDeployment(
          fixture,
          `deployment-${scenario}-${factory.name}`,
          scenario === "illegal-phase" ? "DISABLED" : "PENDING_FLAT",
        );
        const occurredAt = scenario === "backdated"
          ? addMilliseconds(deployment.updatedAt, -1)
          : addMilliseconds(deployment.updatedAt, 1);
        const input = recoveryFaultInput(deployment.id, occurredAt);

        await assert.rejects(
          () => fixture.candidatePilots.pauseForRecoveryFault(input),
          scenario === "illegal-phase" ? /cannot pause phase DISABLED/i : /chronology|precede/i,
          `${factory.name}:${scenario}`,
        );

        assert.equal((await fixture.candidatePilots.getDeployment(deployment.id))?.phase, deployment.phase);
        assert.equal((await fixture.operatorState.getState()).systemStatus, "RUNNING");
        assert.equal((await fixture.candidatePilots.listAuditEvents(deployment.id))
          .filter((event) => event.id === input.faultId).length, 0);
        assert.equal((await fixture.operatorState.listTransitions(100))
          .filter((transition) => transition.id === input.faultId).length, 0);
      } finally {
        await fixture.close();
      }
    }
  }
});

test("sqlite recovery fault rolls back pilot, audit, execution state, and transition on final insert failure", async () => {
  const fixture = await createSqliteFixture("rollback-final-transition");
  try {
    assert.ok(fixture.db);
    const deployment = await createDeployment(fixture, "deployment-rollback-final-transition");
    const input = recoveryFaultInput(deployment.id, addMilliseconds(deployment.updatedAt, 1));
    fixture.db.exec(`
      CREATE TRIGGER fail_recovery_fault_transition_for_test
      BEFORE INSERT ON execution_state_transitions
      WHEN NEW.id = '${input.faultId}'
      BEGIN
        SELECT RAISE(ABORT, 'injected recovery fault transition failure');
      END;
    `);

    await assert.rejects(
      () => fixture.candidatePilots.pauseForRecoveryFault(input),
      /injected recovery fault transition failure/i,
    );

    assert.equal((await fixture.candidatePilots.getDeployment(deployment.id))?.phase, "PENDING_FLAT");
    assert.equal((await fixture.operatorState.getState()).systemStatus, "RUNNING");
    assert.equal((await fixture.candidatePilots.listAuditEvents(deployment.id))
      .filter((event) => event.id === input.faultId).length, 0);
    assert.equal((await fixture.operatorState.listTransitions(100))
      .filter((transition) => transition.id === input.faultId).length, 0);
  } finally {
    await fixture.close();
  }
});

async function createDeployment(
  fixture: FaultPauseFixture,
  deploymentId: string,
  phase: "PENDING_FLAT" | "DISABLED" = "PENDING_FLAT",
) {
  const executionState = await fixture.operatorState.getState();
  const createdAt = addMilliseconds(executionState.updatedAt, 10);
  return fixture.candidatePilots.createDeploymentWithInitialState({
    deployment: {
      id: deploymentId,
      exchangeAccountId: "primary",
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      phase,
      activationAt: null,
      activationEpochNs: null,
      createdAt,
      updatedAt: createdAt,
    },
    initialState: createEmptyPositionGuardCandidateState(),
  });
}

function recoveryFaultInput(
  deploymentId: string,
  occurredAt: string,
): PauseCandidatePilotForRecoveryFaultInput {
  return {
    deploymentId,
    exchangeAccountId: "primary",
    faultId: `recovery-fault:${deploymentId}`,
    reasonCode: "REPLAY_MISMATCH",
    provenanceJson: JSON.stringify({ source: "repository-contract" }),
    occurredAt,
  };
}

function createInMemoryFixture(_label: string): Promise<FaultPauseFixture> {
  const operatorState = new InMemoryOperatorStateStore(initialExecutionState());
  return Promise.resolve({
    candidatePilots: new InMemoryCandidatePilotRepository(operatorState),
    operatorState,
    db: null,
    close: () => Promise.resolve(),
  });
}

async function createSqliteFixture(label: string): Promise<FaultPauseFixture> {
  const databasePath = await createTempDatabasePath(label);
  const bundle = createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "pilot-user",
    userTelegramId: "pilot-telegram-user",
    userDisplayName: "Pilot Operator",
    accessKeyRef: "secret://upbit/access",
    secretKeyRef: "secret://upbit/secret",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    killSwitchActive: false,
  });
  const rawHandle = openSqliteDatabase(databasePath);
  return {
    candidatePilots: bundle.candidatePilots,
    operatorState: bundle.operatorState,
    db: rawHandle.db,
    async close() {
      rawHandle.close();
      bundle.close();
      await cleanupTempDatabase(databasePath);
    },
  };
}

function initialExecutionState(): ExecutionStateRecord {
  return {
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
  };
}

function addMilliseconds(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

async function waitUntilAfter(value: string): Promise<void> {
  const epochMilliseconds = Date.parse(value);
  while (Date.now() <= epochMilliseconds) {
    await delay(2);
  }
}

async function createTempDatabasePath(label: string): Promise<string> {
  const directory = path.resolve(process.cwd(), ".tmp-db-tests");
  await mkdir(directory, { recursive: true });
  return path.join(directory, `pilot-recovery-fault-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`);
}

async function cleanupTempDatabase(databasePath: string): Promise<void> {
  await rm(databasePath, { force: true });
  await rm(`${databasePath}-shm`, { force: true });
  await rm(`${databasePath}-wal`, { force: true });
}
