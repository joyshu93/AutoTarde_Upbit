import type { DatabaseSync } from "node:sqlite";

import type {
  CandidateExecutionBindingRecord,
  PositionGuardPilotAuditEventRecord,
  PositionGuardPilotDeploymentRecord,
} from "../../../domain/pilot-types.js";
import type {
  ExecutionStateRecord,
  ExecutionStateTransitionRecord,
} from "../../../domain/types.js";
import {
  canonicalNonNegativeDecimal,
  canonicalSignedDecimal,
  createExactEmptyCandidateState,
  projectExactCandidateState,
  type ExactCandidateState,
} from "../../execution/candidate-evidence-decimals.js";
import {
  parsePositionGuardCandidateTimestamp,
  validatePositionGuardCandidateState,
  type PositionGuardCandidateExecutionEvidence,
  type PositionGuardCandidateState,
} from "../../strategy/position-guard-candidate-state.js";
import {
  candidateEvidenceMaterial,
  buildCandidatePilotRecoveryFaultAuditEvent,
  candidatePilotRecoveryFaultReason,
  validateCandidateExecutionBinding,
  validateCandidatePilotDeployment,
  validateCandidatePilotRecoveryFaultInput,
  type AdvanceCandidatePilotStateInput,
  type AdvanceCandidatePilotStateResult,
  type ActivateCandidatePilotDeploymentInput,
  type CandidateEvidenceRecord,
  type CandidatePilotRepository,
  type CreateCandidatePilotDeploymentInput,
  type PauseCandidatePilotForRecoveryFaultInput,
  type PauseCandidatePilotForRecoveryFaultResult,
} from "../pilot-interfaces.js";
import type { SqliteExecutionStateRow } from "../types.js";
import { fromSqliteBoolean, toSqliteBoolean } from "./sqlite-shapes.js";
import {
  deriveFaultPauseTransitionAt,
  faultPauseTransitionMatchesOccurrence,
  validateFaultPauseInput,
  validateFaultPauseTimestamp,
} from "./atomic-lifecycle-validation.js";
import { withImmediateTransaction } from "./sqlite-transaction.js";

interface DeploymentRow {
  id: string;
  exchange_account_id: string;
  pilot_id: PositionGuardPilotDeploymentRecord["pilotId"];
  market: PositionGuardPilotDeploymentRecord["market"];
  policy_id: PositionGuardPilotDeploymentRecord["policyId"];
  policy_version: PositionGuardPilotDeploymentRecord["policyVersion"];
  phase: PositionGuardPilotDeploymentRecord["phase"];
  activation_at: string | null;
  activation_epoch_ns: string | number | bigint | null;
  created_at: string;
  updated_at: string;
}

interface StateRow {
  current_episode_add_count: number;
  current_episode_cost_basis_krw: number | string;
  current_episode_inventory_quantity: number | string;
  current_episode_realized_pnl_krw: number | string;
  last_full_exit_at: string | null;
  last_full_exit_realized_pnl_krw: number | string | null;
  last_entry_path: PositionGuardCandidateState["lastEntryPath"];
  last_evidence_at: string | null;
  last_evidence_id: string | null;
  state_version: number;
  material_version: "LEGACY_APPROXIMATE_V1" | "EXACT_V2";
  current_episode_cost_basis_krw_exact: string | null;
  current_episode_inventory_quantity_exact: string | null;
  current_episode_realized_pnl_krw_exact: string | null;
  last_full_exit_realized_pnl_krw_exact: string | null;
}

interface EvidenceRow {
  id: string;
  executed_at: string;
  action: PositionGuardCandidateExecutionEvidence["action"];
  entry_path: PositionGuardCandidateExecutionEvidence["entryPath"];
  terminal_status: PositionGuardCandidateExecutionEvidence["terminalStatus"];
  executed_quantity: number | string;
  gross_quote_value_krw: number | string;
  confirmed_fee_krw: number | string;
  remaining_quantity: number | string;
  material_hash: string;
  material_version: "LEGACY_APPROXIMATE_V1" | "EXACT_V2";
  executed_quantity_exact: string | null;
  gross_quote_value_krw_exact: string | null;
  confirmed_fee_krw_exact: string | null;
  remaining_quantity_exact: string | null;
}

interface AuditRow {
  id: string;
  deployment_id: string;
  event_type: PositionGuardPilotAuditEventRecord["eventType"];
  from_phase: PositionGuardPilotAuditEventRecord["fromPhase"];
  to_phase: PositionGuardPilotAuditEventRecord["toPhase"];
  state_version: number;
  payload_json: string;
  created_at: string;
}

interface BindingRow {
  id: string;
  deployment_id: string;
  strategy_decision_id: string;
  order_id: string;
  exchange_account_id: string;
  activation_at: string;
  activation_epoch_ns: bigint | number;
  market: CandidateExecutionBindingRecord["market"];
  strategy_key: CandidateExecutionBindingRecord["strategyKey"];
  policy_id: CandidateExecutionBindingRecord["policyId"];
  policy_version: CandidateExecutionBindingRecord["policyVersion"];
  execution_mode: CandidateExecutionBindingRecord["executionMode"];
  ord_type: CandidateExecutionBindingRecord["ordType"];
  action: CandidateExecutionBindingRecord["action"];
  side: CandidateExecutionBindingRecord["side"];
  intended_quantity_exact: string | null;
  intended_notional_krw_exact: string | null;
  bound_price_exact: string | null;
  bound_volume_exact: string | null;
  bound_time_in_force: CandidateExecutionBindingRecord["boundTimeInForce"];
  bound_smp_type: CandidateExecutionBindingRecord["boundSmpType"];
  material_version: CandidateExecutionBindingRecord["materialVersion"] | "LEGACY_UNVERIFIED";
  order_material_hash: string | null;
  created_at: string;
}

interface ExecutionStateTransitionRow {
  id: string;
  exchange_account_id: string;
  command: ExecutionStateTransitionRecord["command"];
  from_execution_mode: ExecutionStateTransitionRecord["fromExecutionMode"];
  to_execution_mode: ExecutionStateTransitionRecord["toExecutionMode"];
  from_live_execution_gate: ExecutionStateTransitionRecord["fromLiveExecutionGate"];
  to_live_execution_gate: ExecutionStateTransitionRecord["toLiveExecutionGate"];
  from_system_status: ExecutionStateTransitionRecord["fromSystemStatus"];
  to_system_status: ExecutionStateTransitionRecord["toSystemStatus"];
  from_kill_switch_active: number | null;
  to_kill_switch_active: number;
  reason: string | null;
  created_at: string;
}

export class SqliteCandidatePilotRepository implements CandidatePilotRepository {
  constructor(private readonly db: DatabaseSync) {}

  async createDeploymentWithInitialState(
    input: CreateCandidatePilotDeploymentInput,
  ): Promise<PositionGuardPilotDeploymentRecord> {
    const deployment = validateCandidatePilotDeployment(input.deployment);
    validatePositionGuardCandidateState(input.initialState);
    if (!isPristineInitialState(input.initialState)) {
      throw new Error("Candidate pilot deployment initial state must be pristine.");
    }
    const exactState = createExactEmptyCandidateState();
    const createdAtEpochNs = parsePositionGuardCandidateTimestamp(deployment.createdAt, "deployment createdAt");
    withImmediateTransaction(this.db, () => {
      this.db.prepare(`
        INSERT INTO strategy_pilot_deployments (
          id, exchange_account_id, pilot_id, market, policy_id, policy_version,
          phase, activation_at, activation_epoch_ns, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deployment.id,
        deployment.exchangeAccountId,
        deployment.pilotId,
        deployment.market,
        deployment.policyId,
        deployment.policyVersion,
        deployment.phase,
        deployment.activationAt,
        deployment.activationEpochNs === null ? null : deployment.activationEpochNs.toString(),
        deployment.createdAt,
        deployment.updatedAt,
      );
      insertExactState(this.db, deployment.id, exactState, deployment.updatedAt);
      this.db.prepare(`
        INSERT INTO strategy_pilot_audit_events (
          id, deployment_id, event_type, from_phase, to_phase, state_version,
          payload_json, created_at, created_at_epoch_ns
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `${deployment.id}:created`,
        deployment.id,
        "DEPLOYMENT_CREATED",
        null,
        deployment.phase,
        0,
        JSON.stringify({
          pilotId: deployment.pilotId,
          market: deployment.market,
          policyId: deployment.policyId,
          policyVersion: deployment.policyVersion,
        }),
        deployment.createdAt,
        createdAtEpochNs,
      );
    });
    return deployment;
  }

  async getDeployment(deploymentId: string): Promise<PositionGuardPilotDeploymentRecord | null> {
    const row = selectDeploymentRow(this.db, deploymentId);
    return row ? deploymentFromRow(row) : null;
  }

  async getDeploymentForExchangeAccount(
    exchangeAccountId: string,
  ): Promise<PositionGuardPilotDeploymentRecord | null> {
    const row = this.db.prepare(`
      SELECT id, exchange_account_id, pilot_id, market, policy_id, policy_version,
        phase, activation_at, activation_epoch_ns, created_at, updated_at
      FROM strategy_pilot_deployments
      WHERE exchange_account_id = ?
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get(exchangeAccountId) as DeploymentRow | undefined;
    return row ? deploymentFromRow(row) : null;
  }

  async activateDeployment(
    input: ActivateCandidatePilotDeploymentInput,
  ): Promise<PositionGuardPilotDeploymentRecord | null> {
    return withImmediateTransaction(this.db, () => {
      const deployment = selectDeploymentRow(this.db, input.deploymentId);
      if (!deployment || deployment.phase !== input.expectedPhase || deployment.updated_at !== input.expectedUpdatedAt ||
        deployment.activation_at !== null || deployment.activation_epoch_ns !== null) {
        return null;
      }
      validateActivationInput(input, deploymentFromRow(deployment));
      const update = this.db.prepare(`
        UPDATE strategy_pilot_deployments
        SET phase = 'ACTIVE', activation_at = ?, activation_epoch_ns = ?, updated_at = ?
        WHERE id = ? AND phase = ? AND updated_at = ?
          AND activation_at IS NULL AND activation_epoch_ns IS NULL
      `).run(
        input.activationAt,
        input.activationEpochNs.toString(),
        input.activationAt,
        input.deploymentId,
        input.expectedPhase,
        input.expectedUpdatedAt,
      );
      if (update.changes !== 1) return null;
      const state = selectStateRow(this.db, input.deploymentId);
      if (!state) throw new Error(`Candidate state ${input.deploymentId} does not exist.`);
      this.db.prepare(`
        INSERT INTO strategy_pilot_audit_events (
          id, deployment_id, event_type, from_phase, to_phase, state_version,
          payload_json, created_at, created_at_epoch_ns
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `${input.deploymentId}:activation:${input.activationEpochNs.toString()}`,
        input.deploymentId,
        "PHASE_TRANSITION",
        input.expectedPhase,
        "ACTIVE",
        state.state_version,
        JSON.stringify({ activationAt: input.activationAt, activationEpochNs: input.activationEpochNs.toString() }),
        input.activationAt,
        input.activationEpochNs,
      );
      const activated = selectDeploymentRow(this.db, input.deploymentId);
      if (!activated) throw new Error(`Activated candidate deployment ${input.deploymentId} disappeared.`);
      return deploymentFromRow(activated);
    });
  }

  async getState(deploymentId: string): Promise<Readonly<PositionGuardCandidateState> | null> {
    const row = selectStateRow(this.db, deploymentId);
    if (!row) return null;
    if (row.material_version === "EXACT_V2") {
      const exact = exactStateFromRow(row);
      return Object.freeze(approximateState(exact));
    }
    const state = legacyStateFromRow(row);
    validatePositionGuardCandidateState(state);
    return Object.freeze(state);
  }

  async getExactState(deploymentId: string): Promise<Readonly<ExactCandidateState> | null> {
    const row = selectStateRow(this.db, deploymentId);
    if (!row || row.material_version !== "EXACT_V2") return null;
    return Object.freeze(exactStateFromRow(row));
  }

  async listEvidenceAfter(
    deploymentId: string,
    afterEvidenceId: string | null,
  ): Promise<Array<Readonly<PositionGuardCandidateExecutionEvidence>>> {
    const records = await this.listEvidenceRecords(deploymentId);
    const cursor = afterEvidenceId === null ? -1 : records.findIndex(
      (record) => record.evidence.evidenceId === afterEvidenceId,
    );
    if (afterEvidenceId !== null && cursor < 0) {
      throw new Error(`Candidate evidence cursor ${afterEvidenceId} does not exist.`);
    }
    return records.slice(cursor + 1).map((record) => Object.freeze({ ...record.evidence }));
  }

  async listEvidenceRecords(deploymentId: string): Promise<Array<Readonly<CandidateEvidenceRecord>>> {
    const rows = this.db.prepare(`
      SELECT id, executed_at, action, entry_path, terminal_status,
        executed_quantity, gross_quote_value_krw, confirmed_fee_krw, remaining_quantity,
        material_hash, material_version, executed_quantity_exact, gross_quote_value_krw_exact,
        confirmed_fee_krw_exact, remaining_quantity_exact
      FROM strategy_candidate_execution_evidence
      WHERE deployment_id = ?
      ORDER BY executed_at_epoch_ns ASC, id ASC
    `).all(deploymentId) as unknown as EvidenceRow[];
    return rows.map(evidenceRecordFromRow);
  }

  async getEvidenceRecord(
    deploymentId: string,
    evidenceId: string,
  ): Promise<Readonly<CandidateEvidenceRecord> | null> {
    const row = this.db.prepare(`
      SELECT id, executed_at, action, entry_path, terminal_status,
        executed_quantity, gross_quote_value_krw, confirmed_fee_krw, remaining_quantity,
        material_hash, material_version, executed_quantity_exact, gross_quote_value_krw_exact,
        confirmed_fee_krw_exact, remaining_quantity_exact
      FROM strategy_candidate_execution_evidence
      WHERE deployment_id = ? AND id = ?
      LIMIT 1
    `).get(deploymentId, evidenceId) as EvidenceRow | undefined;
    return row ? evidenceRecordFromRow(row) : null;
  }

  async listAuditEvents(deploymentId: string): Promise<PositionGuardPilotAuditEventRecord[]> {
    const rows = this.db.prepare(`
      SELECT id, deployment_id, event_type, from_phase, to_phase, state_version, payload_json, created_at
      FROM strategy_pilot_audit_events
      WHERE deployment_id = ?
      ORDER BY created_at_epoch_ns ASC, id ASC
    `).all(deploymentId) as unknown as AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      deploymentId: row.deployment_id,
      eventType: row.event_type,
      fromPhase: row.from_phase,
      toPhase: row.to_phase,
      stateVersion: row.state_version,
      payloadJson: row.payload_json,
      createdAt: row.created_at,
    }));
  }

  async createExecutionBinding(input: CandidateExecutionBindingRecord): Promise<CandidateExecutionBindingRecord> {
    const binding = validateCandidateExecutionBinding(input);
    return withImmediateTransaction(this.db, () => {
      const deployment = selectDeploymentRow(this.db, binding.deploymentId);
      if (!deployment || deployment.exchange_account_id !== binding.exchangeAccountId) {
        throw new Error("Candidate execution binding deployment does not match its exchange account.");
      }
      if (
        (deployment.phase !== "ACTIVE" && deployment.phase !== "DRAINING") ||
        deployment.activation_at === null ||
        deployment.activation_epoch_ns === null ||
        binding.activationAt !== deployment.activation_at ||
        binding.activationEpochNs.toString() !== deployment.activation_epoch_ns.toString()
      ) {
        throw new Error("Candidate execution binding must use the persisted active deployment instant.");
      }
      this.db.prepare(`
        INSERT INTO strategy_candidate_execution_bindings (
          id, deployment_id, strategy_decision_id, order_id, exchange_account_id,
          activation_at, activation_epoch_ns, market, strategy_key, policy_id,
          policy_version, execution_mode, ord_type, action, side,
          intended_quantity_exact, intended_notional_krw_exact, bound_price_exact,
          bound_volume_exact, bound_time_in_force, bound_smp_type, material_version,
          order_material_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_id) DO NOTHING
      `).run(
        binding.id,
        binding.deploymentId,
        binding.strategyDecisionId,
        binding.orderId,
        binding.exchangeAccountId,
        binding.activationAt,
        binding.activationEpochNs,
        binding.market,
        binding.strategyKey,
        binding.policyId,
        binding.policyVersion,
        binding.executionMode,
        binding.ordType,
        binding.action,
        binding.side,
        binding.intendedQuantity,
        binding.intendedNotionalKrw,
        binding.boundPrice,
        binding.boundVolume,
        binding.boundTimeInForce,
        binding.boundSmpType,
        binding.materialVersion,
        binding.orderMaterialHash,
        binding.createdAt,
      );
      const persisted = selectBindingByOrderId(this.db, binding.orderId);
      if (!persisted || !sameBinding(persisted, binding)) {
        throw new Error(`Conflicting candidate execution binding for order ${binding.orderId}.`);
      }
      return persisted;
    });
  }

  async getExecutionBindingForOrder(orderId: string): Promise<CandidateExecutionBindingRecord | null> {
    return selectBindingByOrderId(this.db, orderId);
  }

  async advanceStateWithEvidence(
    input: AdvanceCandidatePilotStateInput,
  ): Promise<AdvanceCandidatePilotStateResult> {
    if (!Number.isSafeInteger(input.expectedStateVersion) || input.expectedStateVersion < 0) {
      throw new Error("Candidate pilot expected state version must be a non-negative safe integer.");
    }
    const material = candidateEvidenceMaterial(input.deploymentId, input.evidence);
    return withImmediateTransaction(this.db, () => {
      const existing = this.db.prepare(`
        SELECT id, executed_at, action, entry_path, terminal_status,
          executed_quantity, gross_quote_value_krw, confirmed_fee_krw, remaining_quantity,
          material_hash, material_version, executed_quantity_exact, gross_quote_value_krw_exact,
          confirmed_fee_krw_exact, remaining_quantity_exact
        FROM strategy_candidate_execution_evidence
        WHERE deployment_id = ? AND id = ?
      `).get(input.deploymentId, material.evidence.evidenceId) as EvidenceRow | undefined;
      if (existing) {
        const record = evidenceRecordFromRow(existing);
        if (record.materialHash !== material.hash || record.materialVersion !== material.materialVersion) {
          throw new Error(`Conflicting duplicate candidate evidence ${material.evidence.evidenceId}.`);
        }
        const state = selectStateRow(this.db, input.deploymentId);
        if (!state) throw new Error(`Candidate state ${input.deploymentId} does not exist.`);
        return {
          state: Object.freeze(state.material_version === "EXACT_V2"
            ? approximateState(exactStateFromRow(state))
            : legacyStateFromRow(state)),
          evidence: Object.freeze({ ...material.evidence }),
          duplicate: true,
        };
      }
      const currentRow = selectStateRow(this.db, input.deploymentId);
      if (!currentRow) throw new Error(`Candidate state ${input.deploymentId} does not exist.`);
      if (currentRow.material_version !== "EXACT_V2") {
        throw new Error("Candidate state is LEGACY_APPROXIMATE_V1 and cannot advance.");
      }
      const currentState = exactStateFromRow(currentRow);
      if (currentState.stateVersion !== input.expectedStateVersion) {
        throw new Error(
          `Candidate state version mismatch: expected ${input.expectedStateVersion}, persisted ${currentState.stateVersion}.`,
        );
      }
      const deployment = selectDeploymentRow(this.db, input.deploymentId);
      if (!deployment) throw new Error(`Candidate deployment ${input.deploymentId} does not exist.`);
      const rows = this.db.prepare(`
        SELECT id, executed_at, action, entry_path, terminal_status,
          executed_quantity, gross_quote_value_krw, confirmed_fee_krw, remaining_quantity,
          material_hash, material_version, executed_quantity_exact, gross_quote_value_krw_exact,
          confirmed_fee_krw_exact, remaining_quantity_exact
        FROM strategy_candidate_execution_evidence
        WHERE deployment_id = ?
        ORDER BY executed_at_epoch_ns ASC, id ASC
      `).all(input.deploymentId) as unknown as EvidenceRow[];
      const existingRecords = rows.map(evidenceRecordFromRow);
      if (existingRecords.some((record) => record.materialVersion !== "EXACT_V2")) {
        throw new Error("Candidate evidence contains LEGACY_APPROXIMATE_V1 rows and cannot advance.");
      }
      const nextState = projectExactCandidateState([
        ...existingRecords.map((record) => record.evidence),
        material.evidence,
      ]);
      if (nextState.stateVersion !== currentState.stateVersion + 1) {
        throw new Error("Candidate evidence replay did not advance the exact state by one version.");
      }
      const approximateEvidence = approximateEvidenceValues(material.evidence);
      this.db.prepare(`
        INSERT INTO strategy_candidate_execution_evidence (
          id, deployment_id, executed_at, executed_at_epoch_ns, action, entry_path,
          terminal_status, executed_quantity, gross_quote_value_krw, confirmed_fee_krw,
          remaining_quantity, material_hash, created_at, material_version,
          executed_quantity_exact, gross_quote_value_krw_exact, confirmed_fee_krw_exact,
          remaining_quantity_exact
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        material.evidence.evidenceId,
        input.deploymentId,
        material.evidence.executedAt,
        material.epochNanoseconds,
        material.evidence.action,
        material.evidence.entryPath,
        material.evidence.terminalStatus,
        approximateEvidence.executedQuantity,
        approximateEvidence.grossQuoteValueKrw,
        approximateEvidence.confirmedFeeKrw,
        approximateEvidence.remainingQuantity,
        material.hash,
        material.evidence.executedAt,
        material.materialVersion,
        material.evidence.executedQuantity,
        material.evidence.grossQuoteValueKrw,
        material.evidence.confirmedFeeKrw,
        material.evidence.remainingQuantity,
      );
      const update = updateExactState(this.db, input.deploymentId, input.expectedStateVersion, nextState, material.evidence.executedAt);
      if (update.changes !== 1) throw new Error("Candidate state version compare-and-swap failed.");
      this.db.prepare(`
        INSERT INTO strategy_pilot_audit_events (
          id, deployment_id, event_type, from_phase, to_phase, state_version,
          payload_json, created_at, created_at_epoch_ns
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `${input.deploymentId}:evidence:${material.evidence.evidenceId}`,
        input.deploymentId,
        "STATE_ADVANCED",
        deployment.phase,
        deployment.phase,
        nextState.stateVersion,
        JSON.stringify({
          evidenceId: material.evidence.evidenceId,
          materialHash: material.hash,
          materialVersion: material.materialVersion,
          fromStateVersion: currentState.stateVersion,
          toStateVersion: nextState.stateVersion,
        }),
        material.evidence.executedAt,
        material.epochNanoseconds,
      );
      return {
        state: Object.freeze(approximateState(nextState)),
        evidence: Object.freeze({ ...material.evidence }),
        duplicate: false,
      };
    });
  }

  async pauseForRecoveryFault(
    input: PauseCandidatePilotForRecoveryFaultInput,
  ): Promise<PauseCandidatePilotForRecoveryFaultResult> {
    validateCandidatePilotRecoveryFaultInput(input);
    const faultOccurrence = {
      exchangeAccountId: input.exchangeAccountId,
      faultId: input.faultId,
      reason: candidatePilotRecoveryFaultReason(input),
      occurredAt: input.occurredAt,
    };
    validateFaultPauseInput(faultOccurrence);

    return withImmediateTransaction(this.db, () => {
      const deploymentRow = selectDeploymentRow(this.db, input.deploymentId);
      const stateRow = selectStateRow(this.db, input.deploymentId);
      if (
        !deploymentRow ||
        !stateRow ||
        deploymentRow.exchange_account_id !== input.exchangeAccountId
      ) {
        throw new Error("Candidate recovery fault deployment provenance does not match persisted state.");
      }
      const deployment = deploymentFromRow(deploymentRow);
      const existingAuditRow = selectAuditRowById(this.db, input.faultId);
      const existingTransitionRow = selectExecutionStateTransitionRow(this.db, input.faultId);
      const executionState = selectExecutionState(this.db, input.exchangeAccountId);
      const faultPause = {
        ...faultOccurrence,
        transitionAt: deriveFaultPauseTransitionAt(input.occurredAt, executionState.updatedAt),
      };
      validateFaultPauseInput(faultPause);

      if (existingAuditRow || existingTransitionRow) {
        if (
          !existingAuditRow ||
          !existingTransitionRow ||
          deployment.phase !== "PAUSED_FAULT" ||
          deployment.updatedAt !== input.occurredAt ||
          (executionState.systemStatus !== "PAUSED" && executionState.systemStatus !== "KILL_SWITCHED")
        ) {
          throw new Error(`Conflicting partial candidate recovery fault ${input.faultId}.`);
        }
        const existingAudit = auditEventFromRow(existingAuditRow);
        const existingTransition = executionStateTransitionFromRow(existingTransitionRow);
        if (existingAudit.fromPhase === null || !isFaultPausablePhase(existingAudit.fromPhase)) {
          throw new Error(`Conflicting duplicate candidate recovery fault ${input.faultId}.`);
        }
        const expectedAudit = buildCandidatePilotRecoveryFaultAuditEvent({
          fault: input,
          fromPhase: existingAudit.fromPhase,
          stateVersion: stateRow.state_version,
        });
        if (
          !sameAuditEvent(existingAudit, expectedAudit) ||
          !isMatchingRecoveryFaultTransition(existingTransition, faultPause)
        ) {
          throw new Error(`Conflicting duplicate candidate recovery fault ${input.faultId}.`);
        }
        return {
          deployment,
          executionState,
          auditEvent: existingAudit,
          duplicate: true,
        };
      }

      if (!isFaultPausablePhase(deployment.phase)) {
        throw new Error(`Candidate recovery fault cannot pause phase ${deployment.phase}.`);
      }
      const occurredAtEpoch = parsePositionGuardCandidateTimestamp(
        input.occurredAt,
        "candidate recovery fault occurredAt",
      );
      const latestAuditAt = selectLatestAuditTimestamp(this.db, input.deploymentId);
      if (
        occurredAtEpoch < parsePositionGuardCandidateTimestamp(deployment.updatedAt, "deployment updatedAt") ||
        (latestAuditAt !== null && occurredAtEpoch < parsePositionGuardCandidateTimestamp(
          latestAuditAt,
          "candidate audit createdAt",
        ))
      ) {
        throw new Error("Candidate recovery fault cannot precede deployment chronology.");
      }
      const transitionAt = validateFaultPauseTimestamp(faultPause, executionState);
      const auditEvent = buildCandidatePilotRecoveryFaultAuditEvent({
        fault: input,
        fromPhase: deployment.phase,
        stateVersion: stateRow.state_version,
      });
      const preservesKillSwitch = executionState.killSwitchActive || executionState.systemStatus === "KILL_SWITCHED";
      const nextExecutionState: ExecutionStateRecord = {
        ...executionState,
        systemStatus: preservesKillSwitch ? "KILL_SWITCHED" : "PAUSED",
        pauseReason: preservesKillSwitch
          ? executionState.pauseReason
          : formatFaultPauseReason(faultPause),
        updatedAt: transitionAt,
      };

      const deploymentUpdate = this.db.prepare(`
        UPDATE strategy_pilot_deployments
        SET phase = 'PAUSED_FAULT', updated_at = ?
        WHERE id = ? AND exchange_account_id = ? AND phase = ? AND updated_at = ?
      `).run(
        input.occurredAt,
        input.deploymentId,
        input.exchangeAccountId,
        deployment.phase,
        deployment.updatedAt,
      );
      if (deploymentUpdate.changes !== 1) {
        throw new Error("Candidate recovery fault deployment compare-and-swap failed.");
      }
      insertAuditEvent(this.db, auditEvent, occurredAtEpoch);
      const executionUpdate = this.db.prepare(`
        UPDATE execution_state
        SET execution_mode = ?, live_execution_gate = ?, system_status = ?,
            kill_switch_active = ?, pause_reason = ?, degraded_reason = ?, degraded_at = ?, updated_at = ?
        WHERE exchange_account_id = ? AND updated_at = ?
      `).run(
        nextExecutionState.executionMode,
        nextExecutionState.liveExecutionGate,
        nextExecutionState.systemStatus,
        toSqliteBoolean(nextExecutionState.killSwitchActive),
        nextExecutionState.pauseReason,
        nextExecutionState.degradedReason,
        nextExecutionState.degradedAt,
        nextExecutionState.updatedAt,
        input.exchangeAccountId,
        executionState.updatedAt,
      );
      if (executionUpdate.changes !== 1) {
        throw new Error("Candidate recovery fault execution-state compare-and-swap failed.");
      }
      insertExecutionStateTransition(this.db, {
        id: input.faultId,
        exchangeAccountId: input.exchangeAccountId,
        command: "AUTOMATIC_PAUSE",
        fromExecutionMode: executionState.executionMode,
        toExecutionMode: nextExecutionState.executionMode,
        fromLiveExecutionGate: executionState.liveExecutionGate,
        toLiveExecutionGate: nextExecutionState.liveExecutionGate,
        fromSystemStatus: executionState.systemStatus,
        toSystemStatus: nextExecutionState.systemStatus,
        fromKillSwitchActive: executionState.killSwitchActive,
        toKillSwitchActive: nextExecutionState.killSwitchActive,
        reason: formatFaultPauseReason(faultPause),
        createdAt: transitionAt,
      });
      const pausedRow = selectDeploymentRow(this.db, input.deploymentId);
      if (!pausedRow) {
        throw new Error(`Paused candidate deployment ${input.deploymentId} disappeared.`);
      }
      return {
        deployment: deploymentFromRow(pausedRow),
        executionState: nextExecutionState,
        auditEvent,
        duplicate: false,
      };
    });
  }
}

function selectDeploymentRow(db: DatabaseSync, deploymentId: string): DeploymentRow | undefined {
  return db.prepare(`
    SELECT id, exchange_account_id, pilot_id, market, policy_id, policy_version,
      phase, activation_at, activation_epoch_ns, created_at, updated_at
    FROM strategy_pilot_deployments WHERE id = ?
  `).get(deploymentId) as DeploymentRow | undefined;
}

function selectStateRow(db: DatabaseSync, deploymentId: string): StateRow | undefined {
  return db.prepare(`
    SELECT current_episode_add_count, current_episode_cost_basis_krw,
      current_episode_inventory_quantity, current_episode_realized_pnl_krw,
      last_full_exit_at, last_full_exit_realized_pnl_krw, last_entry_path,
      last_evidence_at, last_evidence_id, state_version, material_version,
      current_episode_cost_basis_krw_exact, current_episode_inventory_quantity_exact,
      current_episode_realized_pnl_krw_exact, last_full_exit_realized_pnl_krw_exact
    FROM strategy_candidate_states WHERE deployment_id = ?
  `).get(deploymentId) as StateRow | undefined;
}

function selectAuditRowById(db: DatabaseSync, id: string): AuditRow | undefined {
  return db.prepare(`
    SELECT id, deployment_id, event_type, from_phase, to_phase, state_version, payload_json, created_at
    FROM strategy_pilot_audit_events WHERE id = ? LIMIT 1
  `).get(id) as AuditRow | undefined;
}

function selectLatestAuditTimestamp(db: DatabaseSync, deploymentId: string): string | null {
  const row = db.prepare(`
    SELECT created_at
    FROM strategy_pilot_audit_events
    WHERE deployment_id = ?
    ORDER BY created_at_epoch_ns DESC, id DESC
    LIMIT 1
  `).get(deploymentId) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

function selectExecutionState(db: DatabaseSync, exchangeAccountId: string): ExecutionStateRecord {
  const row = db.prepare(`
    SELECT * FROM execution_state WHERE exchange_account_id = ? LIMIT 1
  `).get(exchangeAccountId) as SqliteExecutionStateRow | undefined;
  if (!row) {
    throw new Error(`Execution state is missing for exchange account ${exchangeAccountId}.`);
  }
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    executionMode: row.execution_mode,
    liveExecutionGate: row.live_execution_gate,
    systemStatus: row.system_status,
    killSwitchActive: fromSqliteBoolean(row.kill_switch_active),
    pauseReason: row.pause_reason,
    degradedReason: row.degraded_reason,
    degradedAt: row.degraded_at,
    updatedAt: row.updated_at,
  };
}

function selectExecutionStateTransitionRow(
  db: DatabaseSync,
  id: string,
): ExecutionStateTransitionRow | undefined {
  return db.prepare(`
    SELECT * FROM execution_state_transitions WHERE id = ? LIMIT 1
  `).get(id) as ExecutionStateTransitionRow | undefined;
}

function auditEventFromRow(row: AuditRow): PositionGuardPilotAuditEventRecord {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    eventType: row.event_type,
    fromPhase: row.from_phase,
    toPhase: row.to_phase,
    stateVersion: row.state_version,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
  };
}

function executionStateTransitionFromRow(
  row: ExecutionStateTransitionRow,
): ExecutionStateTransitionRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    command: row.command,
    fromExecutionMode: row.from_execution_mode,
    toExecutionMode: row.to_execution_mode,
    fromLiveExecutionGate: row.from_live_execution_gate,
    toLiveExecutionGate: row.to_live_execution_gate,
    fromSystemStatus: row.from_system_status,
    toSystemStatus: row.to_system_status,
    fromKillSwitchActive: row.from_kill_switch_active === null
      ? null
      : fromSqliteBoolean(row.from_kill_switch_active),
    toKillSwitchActive: fromSqliteBoolean(row.to_kill_switch_active),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function insertAuditEvent(
  db: DatabaseSync,
  event: PositionGuardPilotAuditEventRecord,
  createdAtEpochNs: bigint,
): void {
  db.prepare(`
    INSERT INTO strategy_pilot_audit_events (
      id, deployment_id, event_type, from_phase, to_phase, state_version,
      payload_json, created_at, created_at_epoch_ns
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.deploymentId,
    event.eventType,
    event.fromPhase,
    event.toPhase,
    event.stateVersion,
    event.payloadJson,
    event.createdAt,
    createdAtEpochNs,
  );
}

function insertExecutionStateTransition(
  db: DatabaseSync,
  transition: ExecutionStateTransitionRecord,
): void {
  db.prepare(`
    INSERT INTO execution_state_transitions (
      id, exchange_account_id, command, from_execution_mode, to_execution_mode,
      from_live_execution_gate, to_live_execution_gate, from_system_status,
      to_system_status, from_kill_switch_active, to_kill_switch_active, reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    transition.id,
    transition.exchangeAccountId,
    transition.command,
    transition.fromExecutionMode,
    transition.toExecutionMode,
    transition.fromLiveExecutionGate,
    transition.toLiveExecutionGate,
    transition.fromSystemStatus,
    transition.toSystemStatus,
    transition.fromKillSwitchActive === null ? null : toSqliteBoolean(transition.fromKillSwitchActive),
    toSqliteBoolean(transition.toKillSwitchActive),
    transition.reason,
    transition.createdAt,
  );
}

function formatFaultPauseReason(input: {
  faultId: string;
  reason: string;
}): string {
  return `faultId=${input.faultId}; reason=${input.reason}`;
}

function isMatchingRecoveryFaultTransition(
  transition: ExecutionStateTransitionRecord,
  faultPause: {
    exchangeAccountId: string;
    faultId: string;
    reason: string;
    occurredAt: string;
  },
): boolean {
  return transition.command === "AUTOMATIC_PAUSE" &&
    transition.exchangeAccountId === faultPause.exchangeAccountId &&
    transition.reason === formatFaultPauseReason(faultPause) &&
    faultPauseTransitionMatchesOccurrence(faultPause, transition.createdAt) &&
    transition.fromExecutionMode !== null &&
    transition.fromExecutionMode === transition.toExecutionMode &&
    transition.fromLiveExecutionGate !== null &&
    transition.fromLiveExecutionGate === transition.toLiveExecutionGate &&
    transition.fromKillSwitchActive !== null &&
    transition.fromKillSwitchActive === transition.toKillSwitchActive &&
    (transition.toSystemStatus === "PAUSED" || transition.toSystemStatus === "KILL_SWITCHED");
}

function isFaultPausablePhase(phase: PositionGuardPilotDeploymentRecord["phase"]): boolean {
  return phase === "PENDING_FLAT" || phase === "ACTIVE" || phase === "DRAINING";
}

function sameAuditEvent(
  left: PositionGuardPilotAuditEventRecord,
  right: PositionGuardPilotAuditEventRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function insertExactState(db: DatabaseSync, deploymentId: string, state: Readonly<ExactCandidateState>, updatedAt: string): void {
  const approximate = approximateState(state);
  db.prepare(`
    INSERT INTO strategy_candidate_states (
      deployment_id, current_episode_add_count, current_episode_cost_basis_krw,
      current_episode_inventory_quantity, current_episode_realized_pnl_krw,
      last_full_exit_at, last_full_exit_realized_pnl_krw, last_entry_path,
      last_evidence_at, last_evidence_id, state_version, updated_at, material_version,
      current_episode_cost_basis_krw_exact, current_episode_inventory_quantity_exact,
      current_episode_realized_pnl_krw_exact, last_full_exit_realized_pnl_krw_exact
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    deploymentId,
    approximate.currentEpisodeAddCount,
    approximate.currentEpisodeCostBasisKrw,
    approximate.currentEpisodeInventoryQuantity,
    approximate.currentEpisodeRealizedPnlKrw,
    approximate.lastFullExitAt,
    approximate.lastFullExitRealizedPnlKrw,
    approximate.lastEntryPath,
    approximate.lastEvidenceAt,
    approximate.lastEvidenceId,
    approximate.stateVersion,
    updatedAt,
    "EXACT_V2",
    state.currentEpisodeCostBasisKrw,
    state.currentEpisodeInventoryQuantity,
    state.currentEpisodeRealizedPnlKrw,
    state.lastFullExitRealizedPnlKrw,
  );
}

function updateExactState(
  db: DatabaseSync,
  deploymentId: string,
  expectedStateVersion: number,
  state: Readonly<ExactCandidateState>,
  updatedAt: string,
): { changes: number | bigint } {
  const approximate = approximateState(state);
  return db.prepare(`
    UPDATE strategy_candidate_states SET
      current_episode_add_count = ?, current_episode_cost_basis_krw = ?,
      current_episode_inventory_quantity = ?, current_episode_realized_pnl_krw = ?,
      last_full_exit_at = ?, last_full_exit_realized_pnl_krw = ?, last_entry_path = ?,
      last_evidence_at = ?, last_evidence_id = ?, state_version = ?, updated_at = ?,
      material_version = ?, current_episode_cost_basis_krw_exact = ?,
      current_episode_inventory_quantity_exact = ?, current_episode_realized_pnl_krw_exact = ?,
      last_full_exit_realized_pnl_krw_exact = ?
    WHERE deployment_id = ? AND state_version = ? AND material_version = 'EXACT_V2'
  `).run(
    approximate.currentEpisodeAddCount,
    approximate.currentEpisodeCostBasisKrw,
    approximate.currentEpisodeInventoryQuantity,
    approximate.currentEpisodeRealizedPnlKrw,
    approximate.lastFullExitAt,
    approximate.lastFullExitRealizedPnlKrw,
    approximate.lastEntryPath,
    approximate.lastEvidenceAt,
    approximate.lastEvidenceId,
    approximate.stateVersion,
    updatedAt,
    "EXACT_V2",
    state.currentEpisodeCostBasisKrw,
    state.currentEpisodeInventoryQuantity,
    state.currentEpisodeRealizedPnlKrw,
    state.lastFullExitRealizedPnlKrw,
    deploymentId,
    expectedStateVersion,
  );
}

function deploymentFromRow(row: DeploymentRow): PositionGuardPilotDeploymentRecord {
  return {
    id: row.id,
    exchangeAccountId: row.exchange_account_id,
    pilotId: row.pilot_id,
    market: row.market,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    phase: row.phase,
    activationAt: row.activation_at,
    activationEpochNs: row.activation_epoch_ns === null ? null : BigInt(row.activation_epoch_ns),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateActivationInput(
  input: ActivateCandidatePilotDeploymentInput,
  deployment: PositionGuardPilotDeploymentRecord,
): void {
  const activation = parsePositionGuardCandidateTimestamp(input.activationAt, "deployment activationAt");
  if (activation < 0n || activation !== input.activationEpochNs) {
    throw new Error("Candidate deployment activation epoch does not match its timestamp.");
  }
  if (activation < parsePositionGuardCandidateTimestamp(deployment.createdAt, "deployment createdAt") ||
    activation < parsePositionGuardCandidateTimestamp(deployment.updatedAt, "deployment updatedAt")) {
    throw new Error("Candidate deployment activation cannot precede persisted deployment chronology.");
  }
}

function legacyStateFromRow(row: StateRow): PositionGuardCandidateState {
  return {
    currentEpisodeAddCount: row.current_episode_add_count,
    currentEpisodeCostBasisKrw: Number(row.current_episode_cost_basis_krw),
    currentEpisodeInventoryQuantity: Number(row.current_episode_inventory_quantity),
    currentEpisodeRealizedPnlKrw: Number(row.current_episode_realized_pnl_krw),
    lastFullExitAt: row.last_full_exit_at,
    lastFullExitRealizedPnlKrw: row.last_full_exit_realized_pnl_krw === null ? null : Number(row.last_full_exit_realized_pnl_krw),
    lastEntryPath: row.last_entry_path,
    lastEvidenceAt: row.last_evidence_at,
    lastEvidenceId: row.last_evidence_id,
    stateVersion: row.state_version,
  };
}

function exactStateFromRow(row: StateRow): ExactCandidateState {
  if (
    row.current_episode_cost_basis_krw_exact === null ||
    row.current_episode_inventory_quantity_exact === null ||
    row.current_episode_realized_pnl_krw_exact === null
  ) {
    throw new Error("EXACT_V2 candidate state is missing authoritative exact decimal fields.");
  }
  const state: ExactCandidateState = {
    currentEpisodeAddCount: row.current_episode_add_count,
    currentEpisodeCostBasisKrw: canonicalNonNegativeDecimal(row.current_episode_cost_basis_krw_exact, "candidate state cost basis"),
    currentEpisodeInventoryQuantity: canonicalNonNegativeDecimal(row.current_episode_inventory_quantity_exact, "candidate state inventory"),
    currentEpisodeRealizedPnlKrw: canonicalSignedDecimal(row.current_episode_realized_pnl_krw_exact, "candidate state realized pnl"),
    lastFullExitAt: row.last_full_exit_at,
    lastFullExitRealizedPnlKrw: row.last_full_exit_realized_pnl_krw_exact === null
      ? null
      : canonicalSignedDecimal(row.last_full_exit_realized_pnl_krw_exact, "candidate state full exit pnl"),
    lastEntryPath: row.last_entry_path,
    lastEvidenceAt: row.last_evidence_at,
    lastEvidenceId: row.last_evidence_id,
    stateVersion: row.state_version,
  };
  if (state.lastFullExitAt !== null) {
    parsePositionGuardCandidateTimestamp(state.lastFullExitAt, "candidate state lastFullExitAt");
  }
  return state;
}

function evidenceRecordFromRow(row: EvidenceRow): Readonly<CandidateEvidenceRecord> {
  const exact = row.material_version === "EXACT_V2";
  if (exact && (
    row.executed_quantity_exact === null ||
    row.gross_quote_value_krw_exact === null ||
    row.confirmed_fee_krw_exact === null ||
    row.remaining_quantity_exact === null
  )) {
    throw new Error("EXACT_V2 candidate evidence is missing authoritative exact decimal fields.");
  }
  const evidence: PositionGuardCandidateExecutionEvidence = {
    evidenceId: row.id,
    executedAt: row.executed_at,
    action: row.action,
    entryPath: row.entry_path,
    terminalStatus: row.terminal_status,
    executedQuantity: exact
      ? canonicalNonNegativeDecimal(row.executed_quantity_exact, "candidate evidence executed quantity")
      : String(row.executed_quantity),
    grossQuoteValueKrw: exact
      ? canonicalNonNegativeDecimal(row.gross_quote_value_krw_exact, "candidate evidence gross quote value")
      : String(row.gross_quote_value_krw),
    confirmedFeeKrw: exact
      ? canonicalNonNegativeDecimal(row.confirmed_fee_krw_exact, "candidate evidence confirmed fee")
      : String(row.confirmed_fee_krw),
    remainingQuantity: exact
      ? canonicalNonNegativeDecimal(row.remaining_quantity_exact, "candidate evidence remaining quantity")
      : String(row.remaining_quantity),
  };
  return Object.freeze({
    evidence: Object.freeze(evidence),
    materialHash: row.material_hash,
    materialVersion: row.material_version,
  });
}

function approximateState(state: Readonly<ExactCandidateState>): PositionGuardCandidateState {
  const result: PositionGuardCandidateState = {
    currentEpisodeAddCount: state.currentEpisodeAddCount,
    currentEpisodeCostBasisKrw: Number(state.currentEpisodeCostBasisKrw),
    currentEpisodeInventoryQuantity: Number(state.currentEpisodeInventoryQuantity),
    currentEpisodeRealizedPnlKrw: Number(state.currentEpisodeRealizedPnlKrw),
    lastFullExitAt: state.lastFullExitAt,
    lastFullExitRealizedPnlKrw: state.lastFullExitRealizedPnlKrw === null ? null : Number(state.lastFullExitRealizedPnlKrw),
    lastEntryPath: state.lastEntryPath,
    lastEvidenceAt: state.lastEvidenceAt,
    lastEvidenceId: state.lastEvidenceId,
    stateVersion: state.stateVersion,
  };
  validatePositionGuardCandidateState(result);
  return result;
}

function approximateEvidenceValues(evidence: PositionGuardCandidateExecutionEvidence): {
  executedQuantity: number;
  grossQuoteValueKrw: number;
  confirmedFeeKrw: number;
  remainingQuantity: number;
} {
  const result = {
    executedQuantity: Number(evidence.executedQuantity),
    grossQuoteValueKrw: Number(evidence.grossQuoteValueKrw),
    confirmedFeeKrw: Number(evidence.confirmedFeeKrw),
    remainingQuantity: Number(evidence.remainingQuantity),
  };
  if (Object.values(result).some((value) => !Number.isFinite(value))) {
    throw new Error("Exact candidate evidence cannot be mirrored into finite legacy REAL fields.");
  }
  return result;
}

function isPristineInitialState(state: PositionGuardCandidateState): boolean {
  return state.currentEpisodeAddCount === 0 &&
    state.currentEpisodeCostBasisKrw === 0 &&
    state.currentEpisodeInventoryQuantity === 0 &&
    state.currentEpisodeRealizedPnlKrw === 0 &&
    state.lastFullExitAt === null &&
    state.lastFullExitRealizedPnlKrw === null &&
    state.lastEntryPath === null &&
    state.lastEvidenceAt === null &&
    state.lastEvidenceId === null &&
    state.stateVersion === 0;
}

function selectBindingByOrderId(db: DatabaseSync, orderId: string): CandidateExecutionBindingRecord | null {
  const statement = db.prepare(`
    SELECT id, deployment_id, strategy_decision_id, order_id, exchange_account_id,
      activation_at, activation_epoch_ns, market, strategy_key, policy_id, policy_version,
      execution_mode, ord_type, action, side, intended_quantity_exact,
      intended_notional_krw_exact, bound_price_exact, bound_volume_exact,
      bound_time_in_force, bound_smp_type, material_version, order_material_hash, created_at
    FROM strategy_candidate_execution_bindings WHERE order_id = ?
  `);
  statement.setReadBigInts(true);
  const row = statement.get(orderId) as BindingRow | undefined;
  return row ? validateCandidateExecutionBinding({
    id: row.id,
    deploymentId: row.deployment_id,
    strategyDecisionId: row.strategy_decision_id,
    orderId: row.order_id,
    exchangeAccountId: row.exchange_account_id,
    activationAt: row.activation_at,
    activationEpochNs: BigInt(row.activation_epoch_ns),
    market: row.market,
    strategyKey: row.strategy_key,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    executionMode: row.execution_mode,
    ordType: row.ord_type,
    action: row.action,
    side: row.side,
    intendedQuantity: row.intended_quantity_exact,
    intendedNotionalKrw: row.intended_notional_krw_exact,
    boundPrice: row.bound_price_exact,
    boundVolume: row.bound_volume_exact,
    boundTimeInForce: row.bound_time_in_force,
    boundSmpType: row.bound_smp_type,
    materialVersion: row.material_version === "BINDING_V2" ? row.material_version : (() => {
      throw new Error("Legacy candidate execution binding cannot be used for projection.");
    })(),
    orderMaterialHash: row.order_material_hash ?? "",
    createdAt: row.created_at,
  }) : null;
}

function sameBinding(left: CandidateExecutionBindingRecord, right: CandidateExecutionBindingRecord): boolean {
  return left.id === right.id && left.deploymentId === right.deploymentId &&
    left.strategyDecisionId === right.strategyDecisionId && left.orderId === right.orderId &&
    left.exchangeAccountId === right.exchangeAccountId && left.activationAt === right.activationAt &&
    left.activationEpochNs === right.activationEpochNs && left.market === right.market &&
    left.strategyKey === right.strategyKey && left.policyId === right.policyId &&
    left.policyVersion === right.policyVersion && left.executionMode === right.executionMode &&
    left.ordType === right.ordType && left.action === right.action && left.side === right.side &&
    left.intendedQuantity === right.intendedQuantity && left.intendedNotionalKrw === right.intendedNotionalKrw &&
    left.boundPrice === right.boundPrice && left.boundVolume === right.boundVolume &&
    left.boundTimeInForce === right.boundTimeInForce && left.boundSmpType === right.boundSmpType &&
    left.materialVersion === right.materialVersion && left.orderMaterialHash === right.orderMaterialHash &&
    left.createdAt === right.createdAt;
}
