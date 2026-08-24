import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CandidateExecutionBindingRecord, PositionGuardPolicySelection } from "../src/domain/pilot-types.js";
import {
  candidateEvidenceMaterial,
  candidateExecutionBindingMaterialHash,
} from "../src/modules/db/pilot-interfaces.js";
import { openSqliteDatabase } from "../src/modules/db/repositories/sqlite-database.js";
import {
  formatPositionGuardPilotReadiness,
  inspectPositionGuardPilotReadiness,
  parsePositionGuardPilotReadinessArgs,
  type PositionGuardPilotReadinessOptions,
  type PositionGuardPilotReadinessReport,
} from "../src/inspection/position-guard-pilot-readiness.js";
import { test } from "./harness.js";

const CHECKED_AT = "2026-08-24T01:00:00.000Z";
const AUTHORITY = Object.freeze({
  source: "CHECKED_IN_REGISTRY" as const,
  validation: Object.freeze({
    valid: true as const,
    experimentId: "PCS-2026-001",
    eventAt: "2026-08-21T03:08:24.756Z",
  }),
});
const IDENTITY = Object.freeze({
  deploymentId: "position_guard_pilot_fixture",
  exchangeAccountId: "primary",
  pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1" as const,
  market: "KRW-BTC" as const,
  policyId: "COMBINED_CONSERVATIVE" as const,
  policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1" as const,
});
const BASELINE_SELECTION: PositionGuardPolicySelection = Object.freeze({ kind: "BASELINE", pilotId: null });
const CANDIDATE_SELECTION: PositionGuardPolicySelection = Object.freeze({
  kind: "BTC_CANDIDATE_PILOT",
  pilotId: IDENTITY.pilotId,
  market: IDENTITY.market,
  policyId: IDENTITY.policyId,
  policyVersion: IDENTITY.policyVersion,
  liveOperatorConfirmed: true,
});

test("pilot readiness requires explicit safe CLI arguments and keeps baseline as the default selection", () => {
  assert.throws(() => parsePositionGuardPilotReadinessArgs([]), /--database-path is required/u);
  assert.throws(
    () => parsePositionGuardPilotReadinessArgs(["--database-path", "fixture.sqlite"]),
    /--format is required/u,
  );
  assert.throws(
    () => parsePositionGuardPilotReadinessArgs([
      "--database-path", "fixture.sqlite", "--format", "yaml",
      "--exchange-account-id", "primary", "--deployment-id", IDENTITY.deploymentId,
      "--checked-at", CHECKED_AT, "--freshness-threshold-ms", "3600000",
    ]),
    /TEXT\|JSON/u,
  );
  assert.throws(
    () => parsePositionGuardPilotReadinessArgs([
      "--database-path", "fixture.sqlite", "--format", "JSON",
      "--exchange-account-id", "primary", "--deployment-id", IDENTITY.deploymentId,
      "--checked-at", CHECKED_AT,
    ]),
    /--freshness-threshold-ms is required/u,
  );

  const parsed = parsePositionGuardPilotReadinessArgs([
    "--database-path", "fixture.sqlite",
    "--format", "JSON",
    "--exchange-account-id", "primary",
    "--deployment-id", IDENTITY.deploymentId,
    "--checked-at", CHECKED_AT,
    "--freshness-threshold-ms", "3600000",
  ]);
  assert.deepEqual(parsed, {
    databasePath: "fixture.sqlite",
    format: "JSON",
    exchangeAccountId: "primary",
    deploymentId: IDENTITY.deploymentId,
    checkedAt: CHECKED_AT,
    freshnessThresholdMs: 3_600_000,
  });
  assert.throws(
    () => parsePositionGuardPilotReadinessArgs([
      "--database-path", "fixture.sqlite", "--format", "JSON",
      "--exchange-account-id", "primary", "--deployment-id", IDENTITY.deploymentId,
      "--checked-at", CHECKED_AT, "--freshness-threshold-ms", "0", "--unknown", "value",
    ]),
    /positive safe integer|Unknown argument/u,
  );
});

test("missing database is blocked and is never created", async () => {
  const directory = await mkdtemp(join(tmpdir(), "btc-pilot-readiness-missing-"));
  const databasePath = join(directory, "missing.sqlite");
  try {
    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "BLOCK");
    assert.equal(check(report, "database_file").status, "BLOCK");
    await assert.rejects(() => stat(databasePath), /ENOENT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-0017 database fails closed with a stable schema check", async () => {
  await withDirectory("pre0017", async (directory) => {
    const databasePath = join(directory, "pre0017.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE execution_state (id TEXT PRIMARY KEY)");
    db.close();

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "BLOCK");
    assert.equal(check(report, "required_schema").status, "BLOCK");
    assert.match(check(report, "required_schema").detail, /strategy_pilot_deployments/u);
  });
});

test("candidate readiness requires the immutable execution binding table", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    db.exec("DROP TABLE strategy_candidate_execution_bindings");

    const report = inspectPositionGuardPilotReadiness(options(databasePath));

    assert.equal(report.status, "BLOCK");
    assert.equal(check(report, "required_schema").status, "BLOCK");
    assert.match(check(report, "required_schema").detail, /strategy_candidate_execution_bindings/u);
  });
});

test("candidate readiness requires append-only execution binding authority", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    db.exec("DROP TRIGGER strategy_candidate_execution_bindings_no_update");

    const report = inspectPositionGuardPilotReadiness(options(databasePath));

    assert.equal(report.status, "BLOCK");
    assert.equal(check(report, "required_schema").status, "BLOCK");
    assert.match(check(report, "required_schema").detail, /binding trigger/u);
  });
});

test("baseline selection remains non-activating and reports absent pilot state as a warning", async () => {
  await withMigratedFixture(async ({ databasePath }) => {
    const report = inspectPositionGuardPilotReadiness(options(databasePath, {
      selection: BASELINE_SELECTION,
    }));

    assert.equal(report.status, "WARN");
    assert.equal(report.selection.kind, "BASELINE");
    assert.equal(report.selection.candidateSelected, false);
    assert.equal(check(report, "pilot_configuration").status, "WARN");
    assert.equal(check(report, "pilot_deployment").status, "WARN");
    assert.equal(report.ethPolicy, "BASELINE");
    assert.equal(report.nonMutationBoundary.readOnly, true);
    assert.equal(report.nonMutationBoundary.orderMutation, false);
    assert.equal(report.nonMutationBoundary.privateExchange, false);
    assert.equal(report.nonMutationBoundary.telegram, false);
    assert.equal(report.nonMutationBoundary.runtime, false);
  });
});

test("pending-flat candidate is visible but not ready for candidate execution", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "PENDING_FLAT");
    seedHealth(db);

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "WARN");
    assert.equal(report.deployment?.phase, "PENDING_FLAT");
    assert.equal(check(report, "pilot_phase").status, "WARN");
    assert.equal(check(report, "state_replay").status, "PASS");
    assert.equal(check(report, "audit_chain").status, "PASS");
    assert.match(report.nextActions.join("\n"), /flat-start|PENDING_FLAT/u);
  });
});

test("clean active candidate produces PASS with stable JSON and text provenance", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "PASS");
    assert.equal(report.deployment?.phase, "ACTIVE");
    assert.equal(report.stateProvenance?.replayEqual, true);
    assert.equal(report.stateProvenance?.stateVersion, 0);
    assert.equal(report.evidenceProvenance?.count, 0);
    assert.equal(check(report, "audit_chain").status, "PASS");
    assert.equal(report.orderState.activeCount, 0);
    assert.equal(report.orderState.uncertainCount, 0);
    assert.equal(report.leaseState.classification, "ABSENT");
    assert.equal(report.health.balance?.classification, "FRESH");
    assert.equal(report.health.position?.classification, "FRESH");
    assert.equal(report.health.reconciliation?.classification, "CLEAN");

    const json = formatPositionGuardPilotReadiness(report, "JSON");
    assert.deepEqual(JSON.parse(json), report);
    assert.doesNotMatch(json, /I_UNDERSTAND_BTC_CANDIDATE_LIVE_PILOT/u);
    assert.doesNotMatch(json, /owner-token/u);
    const text = formatPositionGuardPilotReadiness(report, "TEXT");
    assert.match(text, /BTC Pilot Readiness/u);
    assert.match(text, /overall_status: PASS/u);
    assert.match(text, new RegExp(escapeRegExp(databasePath), "u"));
    assert.match(text, /state_replay: PASS/u);
  });
});

test("paused-fault phase is blocked with an explicit next action", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "PAUSED_FAULT");
    seedHealth(db);
    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "BLOCK");
    assert.equal(check(report, "pilot_phase").status, "BLOCK");
    assert.equal(check(report, "audit_chain").status, "PASS");
    assert.match(report.nextActions.join("\n"), /PAUSED_FAULT/u);
  });
});

test("missing or unsupported candidate audit authority fails closed", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE", { audit: false });
    seedHealth(db);

    const missing = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(missing.status, "BLOCK");
    assert.equal(check(missing, "state_replay").status, "PASS");
    assert.equal(check(missing, "audit_chain").status, "BLOCK");
    assert.match(check(missing, "audit_chain").detail, /DEPLOYMENT_CREATED|audit/u);
  });

  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:unexpected-state`,
      eventType: "STATE_ADVANCED",
      fromPhase: "ACTIVE",
      toPhase: "ACTIVE",
      stateVersion: 0,
      payloadJson: JSON.stringify({
        evidenceId: "missing-evidence",
        materialHash: "0".repeat(64),
        materialVersion: "EXACT_V2",
        fromStateVersion: 0,
        toStateVersion: 1,
      }),
      createdAt: "2026-08-24T00:10:00.000Z",
    });

    const malformed = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(malformed.status, "BLOCK");
    assert.equal(check(malformed, "state_replay").status, "PASS");
    assert.equal(check(malformed, "audit_chain").status, "BLOCK");
    assert.match(check(malformed, "audit_chain").detail, /STATE_ADVANCED|audit/u);
  });
});

test("pilot audit authority is rejected when append-only triggers are missing", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    db.exec("DROP TRIGGER strategy_pilot_audit_events_no_update");
    db.exec("DROP TRIGGER strategy_pilot_audit_events_no_delete");

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "BLOCK");
    assert.equal(check(report, "required_schema").status, "BLOCK");
    assert.equal(check(report, "audit_chain").status, "BLOCK");
    assert.match(check(report, "required_schema").detail, /append-only|trigger|immutable/u);
  });
});

test("pilot audit authority rejects a conditionally disabled UPDATE immutability trigger", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    db.exec(`
      DROP TRIGGER strategy_pilot_audit_events_no_update;
      CREATE TRIGGER strategy_pilot_audit_events_no_update
      BEFORE UPDATE ON strategy_pilot_audit_events
      WHEN 0
      BEGIN
        SELECT RAISE(ABORT, 'strategy pilot audit events are append-only');
      END;
    `);

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "BLOCK");
    assert.equal(check(report, "required_schema").status, "BLOCK");
    assert.equal(check(report, "audit_chain").status, "BLOCK");
    assert.match(check(report, "required_schema").detail, /append-only|trigger|immutable/u);
  });
});

test("pilot audit authority rejects a conditionally disabled DELETE immutability trigger", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    db.exec(`
      DROP TRIGGER strategy_pilot_audit_events_no_delete;
      CREATE TRIGGER strategy_pilot_audit_events_no_delete
      BEFORE DELETE ON strategy_pilot_audit_events
      WHEN 0
      BEGIN
        SELECT RAISE(ABORT, 'strategy pilot audit events are append-only');
      END;
    `);

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "BLOCK");
    assert.equal(check(report, "required_schema").status, "BLOCK");
    assert.equal(check(report, "audit_chain").status, "BLOCK");
    assert.match(check(report, "required_schema").detail, /append-only|trigger|immutable/u);
  });
});

test("canonical audit event identity is required even when payload and timestamps match", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE", { audit: false });
    seedHealth(db);
    const activationAt = "2026-08-23T23:59:30.000Z";
    const activationEpochNs = BigInt(epochMs(activationAt)) * 1_000_000n;
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:wrong-created-identity`,
      eventType: "DEPLOYMENT_CREATED",
      fromPhase: null,
      toPhase: "PENDING_FLAT",
      stateVersion: 0,
      payloadJson: JSON.stringify({
        pilotId: IDENTITY.pilotId,
        market: IDENTITY.market,
        policyId: IDENTITY.policyId,
        policyVersion: IDENTITY.policyVersion,
      }),
      createdAt: "2026-08-23T23:59:00.000Z",
    });
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:activation:${activationEpochNs.toString()}`,
      eventType: "PHASE_TRANSITION",
      fromPhase: "PENDING_FLAT",
      toPhase: "ACTIVE",
      stateVersion: 0,
      payloadJson: JSON.stringify({ activationAt, activationEpochNs: activationEpochNs.toString() }),
      createdAt: activationAt,
    });

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(check(report, "state_replay").status, "PASS");
    assert.equal(check(report, "audit_chain").status, "BLOCK");
    assert.match(check(report, "audit_chain").detail, /DEPLOYMENT_CREATED|identity/u);
  });
});

test("deployment creation must be the first lifecycle event when activation has the same timestamp", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE", { audit: false });
    seedHealth(db);
    const activationAt = "2026-08-23T23:59:30.000Z";
    const activationEpochNs = BigInt(epochMs(activationAt)) * 1_000_000n;
    db.prepare(`
      UPDATE strategy_pilot_deployments
      SET created_at = ?
      WHERE id = ?
    `).run(activationAt, IDENTITY.deploymentId);
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:created`,
      eventType: "DEPLOYMENT_CREATED",
      fromPhase: null,
      toPhase: "PENDING_FLAT",
      stateVersion: 0,
      payloadJson: JSON.stringify({
        pilotId: IDENTITY.pilotId,
        market: IDENTITY.market,
        policyId: IDENTITY.policyId,
        policyVersion: IDENTITY.policyVersion,
      }),
      createdAt: activationAt,
    });
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:activation:${activationEpochNs.toString()}`,
      eventType: "PHASE_TRANSITION",
      fromPhase: "PENDING_FLAT",
      toPhase: "ACTIVE",
      stateVersion: 0,
      payloadJson: JSON.stringify({
        activationAt,
        activationEpochNs: activationEpochNs.toString(),
      }),
      createdAt: activationAt,
    });

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(check(report, "state_replay").status, "PASS");
    assert.equal(check(report, "audit_chain").status, "BLOCK");
    assert.match(check(report, "audit_chain").detail, /DEPLOYMENT_CREATED|first|creation/u);
  });
});

test("STATE_ADVANCED audit must link the exact evidence, state version, and chronology", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE", { audit: "LIFECYCLE_ONLY" });
    seedHealth(db);
    const evidence = {
      evidenceId: "evidence-enter",
      executedAt: "2026-08-24T00:10:00.000Z",
      action: "ENTER" as const,
      entryPath: "PULLBACK" as const,
      terminalStatus: "FILLED" as const,
      executedQuantity: "0.001",
      grossQuoteValueKrw: "100000",
      confirmedFeeKrw: "50",
      remainingQuantity: "0.001",
    };
    const material = candidateEvidenceMaterial(IDENTITY.deploymentId, evidence);
    db.prepare(`
      INSERT INTO strategy_candidate_execution_evidence (
        deployment_id, id, executed_at, executed_at_epoch_ns, action, entry_path,
        terminal_status, executed_quantity, gross_quote_value_krw, confirmed_fee_krw,
        remaining_quantity, material_hash, created_at, material_version,
        executed_quantity_exact, gross_quote_value_krw_exact, confirmed_fee_krw_exact,
        remaining_quantity_exact
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXACT_V2', ?, ?, ?, ?)
    `).run(
      IDENTITY.deploymentId, evidence.evidenceId, evidence.executedAt,
      material.epochNanoseconds, evidence.action, evidence.entryPath, evidence.terminalStatus,
      0.001, 100000, 50, 0.001, material.hash, evidence.executedAt,
      evidence.executedQuantity, evidence.grossQuoteValueKrw, evidence.confirmedFeeKrw,
      evidence.remainingQuantity,
    );
    db.prepare(`
      UPDATE strategy_candidate_states
      SET current_episode_cost_basis_krw = 100050,
          current_episode_inventory_quantity = 0.001,
          last_entry_path = 'PULLBACK', last_evidence_at = ?, last_evidence_id = ?,
          state_version = 1, updated_at = ?,
          current_episode_cost_basis_krw_exact = '100050',
          current_episode_inventory_quantity_exact = '0.001'
      WHERE deployment_id = ?
    `).run(evidence.executedAt, evidence.evidenceId, evidence.executedAt, IDENTITY.deploymentId);
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:evidence:${evidence.evidenceId}`,
      eventType: "STATE_ADVANCED",
      fromPhase: "ACTIVE",
      toPhase: "ACTIVE",
      stateVersion: 1,
      payloadJson: JSON.stringify({
        evidenceId: evidence.evidenceId,
        materialHash: material.hash,
        materialVersion: material.materialVersion,
        fromStateVersion: 0,
        toStateVersion: 2,
      }),
      createdAt: evidence.executedAt,
    });

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(check(report, "state_replay").status, "PASS");
    assert.equal(check(report, "audit_chain").status, "BLOCK");
    assert.match(check(report, "audit_chain").detail, /STATE_ADVANCED|state version|audit/u);
  });
});

test("draining and disabled rollback phases require canonical audit authority", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "DRAINING");
    seedHealth(db);
    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(check(report, "pilot_phase").status, "BLOCK");
    assert.equal(check(report, "audit_chain").status, "PASS");
  });

  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "DISABLED");
    seedHealth(db);
    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(check(report, "pilot_phase").status, "WARN");
    assert.equal(check(report, "audit_chain").status, "PASS");
  });
});

test("rollback completion cannot precede later exact state authority", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "DISABLED", { audit: false });
    seedHealth(db);
    const activationAt = "2026-08-23T23:59:30.000Z";
    const completionAt = "2026-08-23T23:59:40.000Z";
    const activationEpochNs = BigInt(epochMs(activationAt)) * 1_000_000n;
    db.prepare(`
      UPDATE strategy_pilot_deployments
      SET activation_at = ?, activation_epoch_ns = ?, updated_at = ?
      WHERE id = ?
    `).run(activationAt, activationEpochNs, completionAt, IDENTITY.deploymentId);
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:created`,
      eventType: "DEPLOYMENT_CREATED",
      fromPhase: null,
      toPhase: "PENDING_FLAT",
      stateVersion: 0,
      payloadJson: JSON.stringify({
        pilotId: IDENTITY.pilotId,
        market: IDENTITY.market,
        policyId: IDENTITY.policyId,
        policyVersion: IDENTITY.policyVersion,
      }),
      createdAt: "2026-08-23T23:59:00.000Z",
    });
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:activation:${activationEpochNs.toString()}`,
      eventType: "PHASE_TRANSITION",
      fromPhase: "PENDING_FLAT",
      toPhase: "ACTIVE",
      stateVersion: 0,
      payloadJson: JSON.stringify({ activationAt, activationEpochNs: activationEpochNs.toString() }),
      createdAt: activationAt,
    });
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:rollback_completed:${String(BigInt(epochMs(completionAt)) * 1_000_000n)}`,
      eventType: "ROLLBACK_COMPLETED",
      fromPhase: "ACTIVE",
      toPhase: "DISABLED",
      stateVersion: 2,
      payloadJson: JSON.stringify({ transitionAt: completionAt }),
      createdAt: completionAt,
    });
    const enter = seedExactEvidence(db, {
      evidenceId: "late-enter",
      executedAt: "2026-08-24T00:00:00.000Z",
      action: "ENTER",
      entryPath: "PULLBACK",
      terminalStatus: "FILLED",
      executedQuantity: "0.001",
      grossQuoteValueKrw: "100000",
      confirmedFeeKrw: "50",
      remainingQuantity: "0.001",
    });
    const exit = seedExactEvidence(db, {
      evidenceId: "late-exit",
      executedAt: "2026-08-24T00:01:00.000Z",
      action: "EXIT",
      entryPath: "NONE",
      terminalStatus: "FILLED",
      executedQuantity: "0.001",
      grossQuoteValueKrw: "101000",
      confirmedFeeKrw: "50",
      remainingQuantity: "0",
    });
    for (const [index, record] of [enter, exit].entries()) {
      seedAudit(db, {
        id: `${IDENTITY.deploymentId}:evidence:${record.evidence.evidenceId}`,
        eventType: "STATE_ADVANCED",
        fromPhase: "ACTIVE",
        toPhase: "ACTIVE",
        stateVersion: index + 1,
        payloadJson: JSON.stringify({
          evidenceId: record.evidence.evidenceId,
          materialHash: record.materialHash,
          materialVersion: record.materialVersion,
          fromStateVersion: index,
          toStateVersion: index + 1,
        }),
        createdAt: record.evidence.executedAt,
      });
    }
    db.prepare(`
      UPDATE strategy_candidate_states
      SET current_episode_add_count = 0, current_episode_cost_basis_krw = 0,
          current_episode_inventory_quantity = 0, current_episode_realized_pnl_krw = 0,
          last_full_exit_at = ?, last_full_exit_realized_pnl_krw = 900,
          last_entry_path = 'PULLBACK', last_evidence_at = ?, last_evidence_id = ?,
          state_version = 2, updated_at = ?,
          current_episode_cost_basis_krw_exact = '0',
          current_episode_inventory_quantity_exact = '0',
          current_episode_realized_pnl_krw_exact = '0',
          last_full_exit_realized_pnl_krw_exact = '900'
      WHERE deployment_id = ?
    `).run(
      exit.evidence.executedAt, exit.evidence.executedAt, exit.evidence.evidenceId,
      exit.evidence.executedAt, IDENTITY.deploymentId,
    );

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(check(report, "state_replay").status, "PASS");
    assert.equal(check(report, "audit_chain").status, "BLOCK");
    assert.match(check(report, "audit_chain").detail, /ROLLBACK_COMPLETED|chronology|state authority/u);
  });
});

test("terminal candidate evidence requires its canonical source order and immutable binding", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE", { audit: "LIFECYCLE_ONLY" });
    seedHealth(db);
    seedTerminalEvidenceState(db, "missing-source-order");

    const report = inspectPositionGuardPilotReadiness(options(databasePath));

    assert.equal(check(report, "state_replay").status, "PASS");
    assert.equal(check(report, "audit_chain").status, "PASS");
    assert.equal(check(report, "evidence_source_provenance").status, "BLOCK");
    assert.match(check(report, "evidence_source_provenance").detail, /source order|binding/u);
    assert.equal(report.status, "BLOCK");
  });
});

test("terminal candidate evidence accepts one exact source order and binding chain", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE", { audit: "LIFECYCLE_ONLY" });
    seedHealth(db);
    seedTerminalEvidenceState(db, "valid-source-order");
    seedTerminalEvidenceSource(db, "valid-source-order", "VALID");

    const report = inspectPositionGuardPilotReadiness(options(databasePath));

    assert.equal(check(report, "state_replay").status, "PASS");
    assert.equal(check(report, "evidence_source_provenance").status, "PASS");
    assert.equal(check(report, "audit_chain").status, "PASS");
    assert.equal(report.status, "PASS");
  });
});

test("terminal candidate evidence rejects foreign or conflicting source authority", async () => {
  for (const mutation of ["FOREIGN_BINDING", "ORDER_MATERIAL", "BINDING_HASH", "TERMINAL_STATUS"] as const) {
    await withMigratedFixture(async ({ databasePath, db }) => {
      seedDeployment(db, "ACTIVE", { audit: "LIFECYCLE_ONLY" });
      seedHealth(db);
      const orderId = `invalid-source-${mutation.toLowerCase()}`;
      seedTerminalEvidenceState(db, orderId);
      seedTerminalEvidenceSource(db, orderId, mutation);

      const report = inspectPositionGuardPilotReadiness(options(databasePath));

      assert.equal(check(report, "state_replay").status, "PASS", mutation);
      assert.equal(check(report, "evidence_source_provenance").status, "BLOCK", mutation);
      assert.match(check(report, "evidence_source_provenance").detail, /binding|source|conflict|material/u, mutation);
      assert.equal(report.status, "BLOCK", mutation);
    });
  }
});

test("active and uncertain account orders fail closed independently", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    seedOrder(db, "order-open", "OPEN");
    seedOrder(db, "order-uncertain", "RECONCILIATION_REQUIRED");

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "BLOCK");
    assert.equal(report.orderState.activeCount, 2);
    assert.equal(report.orderState.uncertainCount, 1);
    assert.equal(check(report, "active_orders").status, "BLOCK");
    assert.equal(check(report, "uncertain_orders").status, "BLOCK");
  });
});

test("readiness reports unresolved potentially-dispatched FAILED and REJECTED orders", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    for (const status of ["FAILED", "REJECTED"] as const) {
      const id = `unresolved-${status.toLowerCase()}`;
      seedOrder(db, id, status);
      db.prepare("UPDATE orders SET failure_code = ? WHERE id = ?")
        .run("SUBMISSION_RESPONSE_UNCERTAIN", id);
      db.prepare(`
        INSERT INTO order_events (id, order_id, event_type, event_source, payload_json, created_at)
        VALUES (?, ?, 'RECONCILIATION_RECOVERY_REQUIRED', 'EXCHANGE', '{}', ?)
      `).run(`${id}-uncertain-event`, id, CHECKED_AT);
    }

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    const orderState = report.orderState;

    assert.equal(report.status, "BLOCK");
    assert.deepEqual(orderState.blockingOrders.map((order) => order.id), ["unresolved-failed", "unresolved-rejected"]);
    assert.ok(orderState.blockingOrders.every((order) => order.reason.length > 0));
    assert.equal(check(report, "active_orders").status, "BLOCK");
  });
});

test("expired lease is reported as stale without exposing owner authority", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    db.prepare(`
      INSERT INTO account_execution_leases (
        exchange_account_id, owner_token, purpose, acquired_at_epoch_ms, expires_at_epoch_ms
      ) VALUES (?, ?, 'ORDER_SUBMISSION', ?, ?)
    `).run("primary", "owner-token-secret", epochMs("2026-08-24T00:00:00.000Z"), epochMs("2026-08-24T00:30:00.000Z"));

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "WARN");
    assert.equal(report.leaseState.classification, "STALE");
    assert.equal(check(report, "execution_lease").status, "WARN");
    assert.doesNotMatch(JSON.stringify(report), /owner-token-secret/u);
  });
});

test("active execution lease blocks readiness without exposing its owner token", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    db.prepare(`
      INSERT INTO account_execution_leases (
        exchange_account_id, owner_token, purpose, acquired_at_epoch_ms, expires_at_epoch_ms
      ) VALUES (?, ?, 'ORDER_SUBMISSION', ?, ?)
    `).run("primary", "active-owner-secret", epochMs("2026-08-24T00:30:00.000Z"), epochMs("2026-08-24T01:30:00.000Z"));

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "BLOCK");
    assert.equal(report.leaseState.classification, "ACTIVE");
    assert.equal(check(report, "execution_lease").status, "BLOCK");
    assert.doesNotMatch(JSON.stringify(report), /active-owner-secret/u);
  });
});

test("authority and exact deployment identity mismatches fail closed", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    const invalidAuthority = inspectPositionGuardPilotReadiness(options(databasePath, {
      authority: {
        source: "CHECKED_IN_REGISTRY",
        validation: { valid: false, experimentId: "PCS-2026-001", eventAt: AUTHORITY.validation.eventAt },
      } as unknown as PositionGuardPilotReadinessOptions["authority"],
    }));
    assert.equal(invalidAuthority.status, "BLOCK");
    assert.equal(check(invalidAuthority, "authority_record").status, "BLOCK");

    const wrongDeployment = inspectPositionGuardPilotReadiness(options(databasePath, {
      identity: { ...IDENTITY, deploymentId: "different-explicit-deployment" },
    }));
    assert.equal(wrongDeployment.status, "BLOCK");
    assert.equal(check(wrongDeployment, "pilot_deployment").status, "BLOCK");
  });
});

test("candidate evidence material and exact replay mismatch are blocked", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    const evidence = {
      evidenceId: "evidence-enter",
      executedAt: "2026-08-24T00:10:00.000Z",
      action: "ENTER" as const,
      entryPath: "PULLBACK" as const,
      terminalStatus: "FILLED" as const,
      executedQuantity: "0.001",
      grossQuoteValueKrw: "100000",
      confirmedFeeKrw: "50",
      remainingQuantity: "0.001",
    };
    const material = candidateEvidenceMaterial(IDENTITY.deploymentId, evidence);
    db.prepare(`
      INSERT INTO strategy_candidate_execution_evidence (
        deployment_id, id, executed_at, executed_at_epoch_ns, action, entry_path,
        terminal_status, executed_quantity, gross_quote_value_krw, confirmed_fee_krw,
        remaining_quantity, material_hash, created_at, material_version,
        executed_quantity_exact, gross_quote_value_krw_exact, confirmed_fee_krw_exact,
        remaining_quantity_exact
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXACT_V2', ?, ?, ?, ?)
    `).run(
      IDENTITY.deploymentId, evidence.evidenceId, evidence.executedAt,
      material.epochNanoseconds, evidence.action, evidence.entryPath, evidence.terminalStatus,
      0.001, 100000, 50, 0.001, material.hash, evidence.executedAt,
      evidence.executedQuantity, evidence.grossQuoteValueKrw, evidence.confirmedFeeKrw,
      evidence.remainingQuantity,
    );

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "BLOCK");
    assert.equal(check(report, "state_replay").status, "BLOCK");
    assert.equal(report.stateProvenance?.replayEqual, false);
  });
});

test("missing or malformed persisted health fails closed without inference", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    db.prepare(`
      INSERT INTO balance_snapshots (
        id, exchange_account_id, captured_at, source, total_krw_value, balances_json
      ) VALUES (?, ?, ?, 'RECONCILIATION', ?, ?)
    `).run("balance-bad", "primary", "not-a-timestamp", "NaN", "{bad-json");
    db.prepare(`
      INSERT INTO position_snapshots (id, exchange_account_id, captured_at, source, positions_json)
      VALUES (?, ?, ?, 'RECONCILIATION', ?)
    `).run("position-bad", "primary", CHECKED_AT, "{bad-json");
    db.prepare(`
      INSERT INTO reconciliation_runs (
        id, exchange_account_id, status, started_at, completed_at, summary_json, error_message
      ) VALUES (?, ?, 'SUCCESS', ?, ?, ?, NULL)
    `).run("reconciliation-bad", "primary", CHECKED_AT, CHECKED_AT, "{bad-json");

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "BLOCK");
    assert.equal(check(report, "balance_snapshot").status, "BLOCK");
    assert.equal(check(report, "position_snapshot").status, "BLOCK");
    assert.equal(check(report, "latest_reconciliation").status, "BLOCK");
  });
});

test("malformed health timestamps cannot hide behind a lexically later valid row", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    db.prepare(`
      INSERT INTO balance_snapshots (
        id, exchange_account_id, captured_at, source, total_krw_value, balances_json
      ) VALUES ('balance-hidden-bad', 'primary', '0000-invalid', 'RECONCILIATION', '100000', '[]')
    `).run();
    db.prepare(`
      INSERT INTO position_snapshots (id, exchange_account_id, captured_at, source, positions_json)
      VALUES ('position-hidden-bad', 'primary', '0000-invalid', 'RECONCILIATION', '[]')
    `).run();
    db.prepare(`
      INSERT INTO reconciliation_runs (
        id, exchange_account_id, status, started_at, completed_at, summary_json, error_message
      ) VALUES ('reconciliation-hidden-bad', 'primary', 'SUCCESS', '0000-invalid',
        '0000-invalid', ?, NULL)
    `).run(JSON.stringify({
      source: "SCHEDULER_PREFLIGHT",
      status: "SUCCESS",
      issues: [],
      candidateCount: 0,
      processedCount: 0,
      deferredCount: 0,
      maxOrderLookupsPerRun: 10,
    }));

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(check(report, "balance_snapshot").status, "BLOCK");
    assert.equal(check(report, "position_snapshot").status, "BLOCK");
    assert.equal(check(report, "latest_reconciliation").status, "BLOCK");
    assert.equal(report.health.balance, null);
    assert.equal(report.health.position, null);
    assert.equal(report.health.reconciliation, null);
  });
});

test("database paths through an existing symlink or junction ancestor are rejected", async () => {
  await withDirectory("ancestor-link", async (directory) => {
    const realDirectory = join(directory, "real");
    const aliasDirectory = join(directory, "alias");
    await mkdir(realDirectory);
    const databasePath = join(realDirectory, "fixture.sqlite");
    const handle = openSqliteDatabase(databasePath);
    try {
      seedAccount(handle.db);
      handle.db.exec("PRAGMA journal_mode = DELETE");
      seedDeployment(handle.db, "ACTIVE");
      seedHealth(handle.db);
    } finally {
      handle.close();
    }
    try {
      await symlink(realDirectory, aliasDirectory, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return;
      throw error;
    }

    const report = inspectPositionGuardPilotReadiness(options(join(aliasDirectory, "fixture.sqlite")));
    assert.equal(report.status, "BLOCK");
    assert.equal(check(report, "database_file").status, "BLOCK");
    assert.match(check(report, "database_file").detail, /ancestor|reparse|symlink|junction/u);
  });
});

test("non-canonical exact candidate numerics fail closed", async () => {
  await withMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    db.exec("PRAGMA ignore_check_constraints = ON");
    db.prepare(`
      UPDATE strategy_candidate_states
      SET current_episode_cost_basis_krw_exact = 'NaN'
      WHERE deployment_id = ?
    `).run(IDENTITY.deploymentId);
    db.exec("PRAGMA ignore_check_constraints = OFF");

    const report = inspectPositionGuardPilotReadiness(options(databasePath));
    assert.equal(report.status, "BLOCK");
    assert.equal(check(report, "state_replay").status, "BLOCK");
    assert.match(check(report, "state_replay").detail, /canonical non-negative decimal/u);
  });
});

test("inspection leaves database bytes, mtime, WAL, and SHM unchanged", async () => {
  await withMigratedFixture(async ({ databasePath, db, closeWriter }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    closeWriter();
    const before = await captureSqliteFiles(databasePath);

    const report = inspectPositionGuardPilotReadiness(options(databasePath));

    const after = await captureSqliteFiles(databasePath);
    assert.equal(report.nonMutationBoundary.readOnly, true);
    assert.deepEqual(after, before);
  });
});

test("inspection sees committed WAL-resident evidence and reports the SQLite SHM constraint", async () => {
  await withWalMigratedFixture(async ({ databasePath, db }) => {
    seedDeployment(db, "ACTIVE");
    seedHealth(db);
    const before = await captureSqliteFiles(databasePath);
    assert.notEqual(before["-wal"], null);
    assert.notEqual(before["-shm"], null);

    const report = inspectPositionGuardPilotReadiness(options(databasePath));

    const after = await captureSqliteFiles(databasePath);
    assert.equal(report.status, "WARN");
    assert.equal(report.deployment?.phase, "ACTIVE");
    assert.equal(report.health.balance?.id, "balance-latest");
    assert.equal(report.health.position?.id, "position-latest");
    assert.equal(report.health.reconciliation?.id, "reconciliation-latest");
    assert.deepEqual(after.database, before.database);
    assert.deepEqual(after["-wal"], before["-wal"]);
    assert.notEqual(after["-shm"], null);
    assert.equal(check(report, "sqlite_snapshot").status, "WARN");
    assert.match(check(report, "sqlite_snapshot").detail, /SHM reader mark/u);
    assert.match(check(report, "non_mutation_boundary").detail, /SHM reader marks/u);
    assert.equal(report.nonMutationBoundary.sqliteSharedMemory, "READER_MARKS_MAY_CHANGE");
  });
});

test("inspection source has a strict dependency boundary and import-only CLI guard", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/inspection/position-guard-pilot-readiness.ts"),
    "utf8",
  );
  for (const forbidden of [
    "create-app", "createApp", "sqlite-database", "openSqliteDatabase",
    "/exchange/", "telegram", "sync-controller", "scheduler", "/execution/",
  ]) {
    assert.doesNotMatch(source, new RegExp(`from [^\\n]*${escapeRegExp(forbidden)}`, "iu"));
  }
  assert.match(source, /new DatabaseSync\(databasePath, \{ readOnly: true \}\)/u);
  assert.doesNotMatch(source, /(?:[?&]|\b)immutable\s*=\s*(?:1|true)/iu);
  assert.doesNotMatch(source, /readFileSync/u);
  assert.doesNotMatch(source, /WAL-index|readNativeUInt32|readFilePrefix/u);
  assert.doesNotMatch(source, /inspectPositionGuardPilotReadiness\([^)]*process\.env/u);
});

test("package and aggregate test wiring expose only the explicit readiness CLI", () => {
  const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts?.["inspect:btc-pilot:readiness"],
    "npm run build && node dist/src/inspection/position-guard-pilot-readiness.js",
  );
  const runAll = readFileSync(resolve(process.cwd(), "tests/run-all.ts"), "utf8");
  assert.match(runAll, /position-guard-pilot-readiness\.test\.js/u);
});

function options(
  databasePath: string,
  overrides: Partial<PositionGuardPilotReadinessOptions> = {},
): PositionGuardPilotReadinessOptions {
  return {
    databasePath,
    checkedAt: CHECKED_AT,
    freshnessThresholdMs: 3_600_000,
    identity: IDENTITY,
    selection: CANDIDATE_SELECTION,
    authority: AUTHORITY,
    ...overrides,
  };
}

function check(report: PositionGuardPilotReadinessReport, name: string) {
  const found = report.checks.find((item) => item.name === name);
  assert.ok(found, `missing readiness check ${name}`);
  return found;
}

async function withDirectory(
  label: string,
  operation: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `btc-pilot-readiness-${label}-`));
  try {
    await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withMigratedFixture(
  operation: (fixture: {
    databasePath: string;
    db: DatabaseSync;
    closeWriter(): void;
  }) => Promise<void>,
): Promise<void> {
  await withDirectory("fixture", async (directory) => {
    const databasePath = join(directory, "fixture.sqlite");
    const handle = openSqliteDatabase(databasePath);
    let closed = false;
    seedAccount(handle.db);
    // Keep ordinary fixtures journal-free so no-sidecar read-only behavior is deterministic.
    handle.db.exec("PRAGMA journal_mode = DELETE");
    const closeWriter = () => {
      if (closed) return;
      handle.close();
      closed = true;
    };
    try {
      await operation({ databasePath, db: handle.db, closeWriter });
    } finally {
      closeWriter();
    }
  });
}

async function withWalMigratedFixture(
  operation: (fixture: { databasePath: string; db: DatabaseSync }) => Promise<void>,
): Promise<void> {
  await withDirectory("wal-fixture", async (directory) => {
    const databasePath = join(directory, "fixture.sqlite");
    const handle = openSqliteDatabase(databasePath);
    try {
      seedAccount(handle.db);
      handle.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      await operation({ databasePath, db: handle.db });
    } finally {
      handle.close();
    }
  });
}

function seedAccount(db: DatabaseSync): void {
  db.prepare(`
    INSERT INTO users (id, telegram_user_id, telegram_chat_id, display_name, created_at, updated_at)
    VALUES ('user-primary', '1', NULL, 'fixture', ?, ?)
  `).run(CHECKED_AT, CHECKED_AT);
  db.prepare(`
    INSERT INTO exchange_accounts (
      id, user_id, exchange, venue_type, account_label, access_key_ref, secret_key_ref,
      quote_currency, is_primary, created_at, updated_at
    ) VALUES ('primary', 'user-primary', 'UPBIT', 'SPOT', 'fixture', 'unused', 'unused', 'KRW', 1, ?, ?)
  `).run(CHECKED_AT, CHECKED_AT);
}

function seedDeployment(
  db: DatabaseSync,
  phase: "DISABLED" | "PENDING_FLAT" | "ACTIVE" | "PAUSED_FAULT" | "DRAINING",
  options: Readonly<{ audit?: boolean | "LIFECYCLE_ONLY" }> = {},
): void {
  const activationAt = phase === "ACTIVE" || phase === "DRAINING"
    ? "2026-08-23T23:59:30.000Z"
    : null;
  const activationEpochNs = activationAt === null ? null : String(BigInt(epochMs(activationAt)) * 1_000_000n);
  const updatedAt = phase === "PENDING_FLAT"
    ? "2026-08-23T23:59:00.000Z"
    : phase === "ACTIVE"
      ? activationAt!
      : "2026-08-24T00:00:00.000Z";
  db.prepare(`
    INSERT INTO strategy_pilot_deployments (
      id, exchange_account_id, pilot_id, market, policy_id, policy_version, phase,
      created_at, updated_at, activation_at, activation_epoch_ns
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    IDENTITY.deploymentId, IDENTITY.exchangeAccountId, IDENTITY.pilotId, IDENTITY.market,
    IDENTITY.policyId, IDENTITY.policyVersion, phase, "2026-08-23T23:59:00.000Z",
    updatedAt, activationAt, activationEpochNs,
  );
  db.prepare(`
    INSERT INTO strategy_candidate_states (
      deployment_id, current_episode_add_count, current_episode_cost_basis_krw,
      current_episode_inventory_quantity, current_episode_realized_pnl_krw,
      last_full_exit_at, last_full_exit_realized_pnl_krw, last_entry_path,
      last_evidence_at, last_evidence_id, state_version, updated_at, material_version,
      current_episode_cost_basis_krw_exact, current_episode_inventory_quantity_exact,
      current_episode_realized_pnl_krw_exact, last_full_exit_realized_pnl_krw_exact
    ) VALUES (?, 0, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, 0, ?, 'EXACT_V2', '0', '0', '0', NULL)
  `).run(IDENTITY.deploymentId, "2026-08-24T00:00:00.000Z");
  if (options.audit === false) return;
  seedAudit(db, {
    id: `${IDENTITY.deploymentId}:created`,
    eventType: "DEPLOYMENT_CREATED",
    fromPhase: null,
    toPhase: "PENDING_FLAT",
    stateVersion: 0,
    payloadJson: JSON.stringify({
      pilotId: IDENTITY.pilotId,
      market: IDENTITY.market,
      policyId: IDENTITY.policyId,
      policyVersion: IDENTITY.policyVersion,
    }),
    createdAt: "2026-08-23T23:59:00.000Z",
  });
  if (activationAt !== null) {
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:activation:${activationEpochNs}`,
      eventType: "PHASE_TRANSITION",
      fromPhase: "PENDING_FLAT",
      toPhase: "ACTIVE",
      stateVersion: 0,
      payloadJson: JSON.stringify({ activationAt, activationEpochNs }),
      createdAt: activationAt,
    });
  }
  if (options.audit === "LIFECYCLE_ONLY") return;
  if (phase === "DRAINING") {
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:rollback_started:${String(BigInt(epochMs(updatedAt)) * 1_000_000n)}`,
      eventType: "ROLLBACK_STARTED",
      fromPhase: "ACTIVE",
      toPhase: "DRAINING",
      stateVersion: 0,
      payloadJson: JSON.stringify({ transitionAt: updatedAt }),
      createdAt: updatedAt,
    });
  }
  if (phase === "DISABLED") {
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:rollback_completed:${String(BigInt(epochMs(updatedAt)) * 1_000_000n)}`,
      eventType: "ROLLBACK_COMPLETED",
      fromPhase: "PENDING_FLAT",
      toPhase: "DISABLED",
      stateVersion: 0,
      payloadJson: JSON.stringify({ transitionAt: updatedAt }),
      createdAt: updatedAt,
    });
  }
  if (phase === "PAUSED_FAULT") {
    seedAudit(db, {
      id: `${IDENTITY.deploymentId}:fault`,
      eventType: "FAULT_PAUSED",
      fromPhase: "PENDING_FLAT",
      toPhase: "PAUSED_FAULT",
      stateVersion: 0,
      payloadJson: JSON.stringify({ reasonCode: "REPLAY_MISMATCH", provenanceJson: "{}" }),
      createdAt: updatedAt,
    });
  }
}

function seedAudit(db: DatabaseSync, event: Readonly<{
  id: string;
  eventType: "DEPLOYMENT_CREATED" | "STATE_ADVANCED" | "PHASE_TRANSITION" |
    "FAULT_PAUSED" | "ROLLBACK_STARTED" | "ROLLBACK_COMPLETED";
  fromPhase: "DISABLED" | "PENDING_FLAT" | "ACTIVE" | "PAUSED_FAULT" | "DRAINING" | null;
  toPhase: "DISABLED" | "PENDING_FLAT" | "ACTIVE" | "PAUSED_FAULT" | "DRAINING" | null;
  stateVersion: number;
  payloadJson: string;
  createdAt: string;
}>): void {
  db.prepare(`
    INSERT INTO strategy_pilot_audit_events (
      id, deployment_id, event_type, from_phase, to_phase, state_version,
      payload_json, created_at, created_at_epoch_ns
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, IDENTITY.deploymentId, event.eventType, event.fromPhase, event.toPhase,
    event.stateVersion, event.payloadJson, event.createdAt,
    BigInt(epochMs(event.createdAt)) * 1_000_000n,
  );
}

function seedExactEvidence(
  db: DatabaseSync,
  evidence: Readonly<{
    evidenceId: string;
    executedAt: string;
    action: "ENTER" | "ADD" | "REDUCE" | "EXIT";
    entryPath: "PULLBACK" | "RECLAIM" | "BREAKOUT_HOLD" | "NONE";
    terminalStatus: "FILLED" | "CANCELED";
    executedQuantity: string;
    grossQuoteValueKrw: string;
    confirmedFeeKrw: string;
    remainingQuantity: string;
  }>,
) {
  const material = candidateEvidenceMaterial(IDENTITY.deploymentId, evidence);
  db.prepare(`
    INSERT INTO strategy_candidate_execution_evidence (
      deployment_id, id, executed_at, executed_at_epoch_ns, action, entry_path,
      terminal_status, executed_quantity, gross_quote_value_krw, confirmed_fee_krw,
      remaining_quantity, material_hash, created_at, material_version,
      executed_quantity_exact, gross_quote_value_krw_exact, confirmed_fee_krw_exact,
      remaining_quantity_exact
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'EXACT_V2', ?, ?, ?, ?)
  `).run(
    IDENTITY.deploymentId, evidence.evidenceId, evidence.executedAt, material.epochNanoseconds,
    evidence.action, evidence.entryPath, evidence.terminalStatus,
    Number(evidence.executedQuantity), Number(evidence.grossQuoteValueKrw),
    Number(evidence.confirmedFeeKrw), Number(evidence.remainingQuantity), material.hash,
    evidence.executedAt, evidence.executedQuantity, evidence.grossQuoteValueKrw,
    evidence.confirmedFeeKrw, evidence.remainingQuantity,
  );
  return Object.freeze({
    evidence: material.evidence,
    materialHash: material.hash,
    materialVersion: material.materialVersion,
  });
}

function seedTerminalEvidenceState(db: DatabaseSync, orderId: string): void {
  const evidence = seedExactEvidence(db, {
    evidenceId: `terminal-order:${orderId}`,
    executedAt: "2026-08-24T00:10:00.000Z",
    action: "ENTER",
    entryPath: "PULLBACK",
    terminalStatus: "FILLED",
    executedQuantity: "0.001",
    grossQuoteValueKrw: "100000",
    confirmedFeeKrw: "50",
    remainingQuantity: "0.001",
  });
  db.prepare(`
    UPDATE strategy_candidate_states
    SET current_episode_cost_basis_krw = 100050,
        current_episode_inventory_quantity = 0.001,
        last_entry_path = 'PULLBACK', last_evidence_at = ?, last_evidence_id = ?,
        state_version = 1, updated_at = ?,
        current_episode_cost_basis_krw_exact = '100050',
        current_episode_inventory_quantity_exact = '0.001'
    WHERE deployment_id = ?
  `).run(
    evidence.evidence.executedAt,
    evidence.evidence.evidenceId,
    evidence.evidence.executedAt,
    IDENTITY.deploymentId,
  );
  seedAudit(db, {
    id: `${IDENTITY.deploymentId}:evidence:${evidence.evidence.evidenceId}`,
    eventType: "STATE_ADVANCED",
    fromPhase: "ACTIVE",
    toPhase: "ACTIVE",
    stateVersion: 1,
    payloadJson: JSON.stringify({
      evidenceId: evidence.evidence.evidenceId,
      materialHash: evidence.materialHash,
      materialVersion: evidence.materialVersion,
      fromStateVersion: 0,
      toStateVersion: 1,
    }),
    createdAt: evidence.evidence.executedAt,
  });
}

function seedTerminalEvidenceSource(
  db: DatabaseSync,
  orderId: string,
  mutation: "VALID" | "FOREIGN_BINDING" | "ORDER_MATERIAL" | "BINDING_HASH" | "TERMINAL_STATUS",
): void {
  const activationAt = "2026-08-23T23:59:30.000Z";
  const activationEpochNs = BigInt(epochMs(activationAt)) * 1_000_000n;
  const bindingCreatedAt = "2026-08-24T00:09:59.999999999Z";
  const requestedAt = "2026-08-24T00:10:00.000000000Z";
  const decisionId = `${orderId}-decision`;
  db.prepare(`
    INSERT INTO strategy_decisions (
      id, exchange_account_id, strategy_key, market, action, status, decision_basis_json,
      intended_notional_krw, intended_quantity, reference_price, created_at
    ) VALUES (?, 'primary', 'position_guard.paper_core.v1', 'KRW-BTC', 'ENTER', 'READY',
      ?, '100000', '0.001', '100000000', ?)
  `).run(decisionId, JSON.stringify({ entryPath: "PULLBACK" }), activationAt);
  db.prepare(`
    INSERT INTO orders (
      id, strategy_decision_id, exchange_account_id, market, side, ord_type, volume,
      price, time_in_force, smp_type, identifier, idempotency_key, origin, requested_at,
      upbit_uuid, status, execution_mode, exchange_response_json, failure_code,
      failure_message, created_at, updated_at
    ) VALUES (?, ?, 'primary', 'KRW-BTC', 'bid', 'price', NULL, '100000', NULL, NULL,
      ?, ?, 'STRATEGY', ?, ?, ?, 'LIVE', '{}', NULL, NULL, ?, '2026-08-24T00:10:00.000Z')
  `).run(
    orderId,
    decisionId,
    `${orderId}-identifier`,
    `${orderId}-idempotency`,
    requestedAt,
    `${orderId}-upbit-uuid`,
    mutation === "TERMINAL_STATUS" ? "CANCELED" : "FILLED",
    requestedAt,
  );

  const material: CandidateExecutionBindingRecord = {
    id: `${orderId}-binding`,
    deploymentId: mutation === "FOREIGN_BINDING" ? "foreign-deployment" : IDENTITY.deploymentId,
    strategyDecisionId: decisionId,
    orderId,
    exchangeAccountId: "primary",
    activationAt,
    activationEpochNs,
    market: "KRW-BTC",
    strategyKey: "position_guard.paper_core.v1",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    executionMode: "LIVE",
    ordType: "price",
    action: "ENTER",
    side: "bid",
    intendedQuantity: "0.001",
    intendedNotionalKrw: "100000",
    boundPrice: mutation === "ORDER_MATERIAL" ? "99999" : "100000",
    boundVolume: null,
    boundTimeInForce: null,
    boundSmpType: null,
    materialVersion: "BINDING_V2",
    orderMaterialHash: "",
    createdAt: bindingCreatedAt,
  };
  material.orderMaterialHash = candidateExecutionBindingMaterialHash(material);
  if (mutation === "BINDING_HASH") material.orderMaterialHash = "0".repeat(64);
  if (mutation === "FOREIGN_BINDING") db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(`
    INSERT INTO strategy_candidate_execution_bindings (
      id, deployment_id, strategy_decision_id, order_id, exchange_account_id,
      activation_at, activation_epoch_ns, market, strategy_key, policy_id, policy_version,
      execution_mode, ord_type, action, side, intended_quantity_exact,
      intended_notional_krw_exact, bound_price_exact, bound_volume_exact,
      bound_time_in_force, bound_smp_type, material_version, order_material_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    material.id, material.deploymentId, material.strategyDecisionId, material.orderId,
    material.exchangeAccountId, material.activationAt, material.activationEpochNs,
    material.market, material.strategyKey, material.policyId, material.policyVersion,
    material.executionMode, material.ordType, material.action, material.side,
    material.intendedQuantity, material.intendedNotionalKrw, material.boundPrice,
    material.boundVolume, material.boundTimeInForce, material.boundSmpType,
    material.materialVersion, material.orderMaterialHash, material.createdAt,
  );
  if (mutation === "FOREIGN_BINDING") db.exec("PRAGMA foreign_keys = ON");
}

function seedHealth(db: DatabaseSync): void {
  const capturedAt = "2026-08-24T00:30:00.000Z";
  db.prepare(`
    INSERT INTO balance_snapshots (
      id, exchange_account_id, captured_at, source, total_krw_value, balances_json
    ) VALUES ('balance-latest', 'primary', ?, 'RECONCILIATION', '100000', '[]')
  `).run(capturedAt);
  db.prepare(`
    INSERT INTO position_snapshots (
      id, exchange_account_id, captured_at, source, positions_json
    ) VALUES ('position-latest', 'primary', ?, 'RECONCILIATION', '[]')
  `).run(capturedAt);
  db.prepare(`
    INSERT INTO reconciliation_runs (
      id, exchange_account_id, status, started_at, completed_at, summary_json, error_message
    ) VALUES ('reconciliation-latest', 'primary', 'SUCCESS', ?, ?, ?, NULL)
  `).run(
    capturedAt,
    capturedAt,
    JSON.stringify({
      source: "SCHEDULER_PREFLIGHT",
      status: "SUCCESS",
      issues: [],
      candidateCount: 0,
      processedCount: 0,
      deferredCount: 0,
      maxOrderLookupsPerRun: 10,
    }),
  );
}

function seedOrder(db: DatabaseSync, id: string, status: string): void {
  db.prepare(`
    INSERT INTO orders (
      id, strategy_decision_id, exchange_account_id, market, side, ord_type, volume,
      price, time_in_force, smp_type, identifier, idempotency_key, origin, requested_at,
      upbit_uuid, status, execution_mode, exchange_response_json, failure_code,
      failure_message, created_at, updated_at
    ) VALUES (?, NULL, 'primary', 'KRW-BTC', 'bid', 'price', NULL, '5000', NULL, NULL,
      ?, ?, 'STRATEGY', ?, NULL, ?, 'LIVE', NULL, NULL, NULL, ?, ?)
  `).run(id, `${id}-identifier`, `${id}-idempotency`, CHECKED_AT, status, CHECKED_AT, CHECKED_AT);
}

async function captureSqliteFiles(databasePath: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const suffix of ["", "-wal", "-shm"] as const) {
    const filePath = `${databasePath}${suffix}`;
    try {
      const [bytes, metadata] = await Promise.all([readFile(filePath), stat(filePath, { bigint: true })]);
      result[suffix || "database"] = {
        bytes: bytes.toString("base64"),
        size: metadata.size.toString(),
        mtimeNs: metadata.mtimeNs.toString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      result[suffix || "database"] = null;
    }
  }
  return result;
}

function epochMs(value: string): number {
  const result = Date.parse(value);
  assert.ok(Number.isSafeInteger(result));
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
