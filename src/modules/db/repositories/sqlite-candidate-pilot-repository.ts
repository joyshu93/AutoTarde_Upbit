import type { DatabaseSync } from "node:sqlite";

import type {
  PositionGuardPilotAuditEventRecord,
  PositionGuardPilotDeploymentRecord,
} from "../../../domain/pilot-types.js";
import {
  advancePositionGuardCandidateState,
  parsePositionGuardCandidateTimestamp,
  validatePositionGuardCandidateState,
  type PositionGuardCandidateExecutionEvidence,
  type PositionGuardCandidateState,
} from "../../strategy/position-guard-candidate-state.js";
import {
  candidateEvidenceMaterial,
  validateCandidatePilotDeployment,
  type AdvanceCandidatePilotStateInput,
  type AdvanceCandidatePilotStateResult,
  type CandidatePilotRepository,
  type CreateCandidatePilotDeploymentInput,
} from "../pilot-interfaces.js";
import { withImmediateTransaction } from "./sqlite-transaction.js";

interface DeploymentRow {
  id: string;
  exchange_account_id: string;
  pilot_id: PositionGuardPilotDeploymentRecord["pilotId"];
  market: PositionGuardPilotDeploymentRecord["market"];
  policy_id: PositionGuardPilotDeploymentRecord["policyId"];
  policy_version: PositionGuardPilotDeploymentRecord["policyVersion"];
  phase: PositionGuardPilotDeploymentRecord["phase"];
  created_at: string;
  updated_at: string;
}

interface StateRow {
  current_episode_add_count: number;
  current_episode_cost_basis_krw: number;
  current_episode_inventory_quantity: number;
  current_episode_realized_pnl_krw: number;
  last_full_exit_at: string | null;
  last_full_exit_realized_pnl_krw: number | null;
  last_entry_path: PositionGuardCandidateState["lastEntryPath"];
  last_evidence_at: string | null;
  last_evidence_id: string | null;
  state_version: number;
}

interface EvidenceRow {
  id: string;
  executed_at: string;
  action: PositionGuardCandidateExecutionEvidence["action"];
  entry_path: PositionGuardCandidateExecutionEvidence["entryPath"];
  terminal_status: PositionGuardCandidateExecutionEvidence["terminalStatus"];
  executed_quantity: number;
  gross_quote_value_krw: number;
  confirmed_fee_krw: number;
  remaining_quantity: number;
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

export class SqliteCandidatePilotRepository implements CandidatePilotRepository {
  constructor(private readonly db: DatabaseSync) {}

  async createDeploymentWithInitialState(
    input: CreateCandidatePilotDeploymentInput,
  ): Promise<PositionGuardPilotDeploymentRecord> {
    const deployment = validateCandidatePilotDeployment(input.deployment);
    validatePositionGuardCandidateState(input.initialState);
    const initialState = snapshotState(input.initialState);
    validatePositionGuardCandidateState(initialState);
    assertPristineInitialState(initialState);
    const createdAtEpochNs = parsePositionGuardCandidateTimestamp(
      deployment.createdAt,
      "deployment createdAt",
    );

    withImmediateTransaction(this.db, () => {
      this.db.prepare(`
        INSERT INTO strategy_pilot_deployments (
          id, exchange_account_id, pilot_id, market, policy_id, policy_version,
          phase, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deployment.id,
        deployment.exchangeAccountId,
        deployment.pilotId,
        deployment.market,
        deployment.policyId,
        deployment.policyVersion,
        deployment.phase,
        deployment.createdAt,
        deployment.updatedAt,
      );
      insertState(this.db, deployment.id, initialState, deployment.updatedAt);
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
        initialState.stateVersion,
        deploymentAuditPayload(deployment),
        deployment.createdAt,
        createdAtEpochNs,
      );
    });

    return deployment;
  }

  async getDeployment(deploymentId: string): Promise<PositionGuardPilotDeploymentRecord | null> {
    const row = this.db.prepare(`
      SELECT id, exchange_account_id, pilot_id, market, policy_id, policy_version,
        phase, created_at, updated_at
      FROM strategy_pilot_deployments
      WHERE id = ?
    `).get(deploymentId) as DeploymentRow | undefined;
    return row ? deploymentFromRow(row) : null;
  }

  async getState(deploymentId: string): Promise<Readonly<PositionGuardCandidateState> | null> {
    const row = selectStateRow(this.db, deploymentId);
    return row ? stateFromRow(row) : null;
  }

  async listEvidenceAfter(
    deploymentId: string,
    afterEvidenceId: string | null,
  ): Promise<Array<Readonly<PositionGuardCandidateExecutionEvidence>>> {
    const rows = afterEvidenceId === null
      ? this.db.prepare(`
          SELECT id, executed_at, action, entry_path, terminal_status, executed_quantity,
            gross_quote_value_krw, confirmed_fee_krw, remaining_quantity
          FROM strategy_candidate_execution_evidence
          WHERE deployment_id = ?
          ORDER BY executed_at_epoch_ns ASC, id ASC
        `).all(deploymentId) as unknown as EvidenceRow[]
      : this.listEvidenceAfterCursor(deploymentId, afterEvidenceId);
    return rows.map(evidenceFromRow);
  }

  async listAuditEvents(deploymentId: string): Promise<PositionGuardPilotAuditEventRecord[]> {
    const rows = this.db.prepare(`
      SELECT id, deployment_id, event_type, from_phase, to_phase, state_version,
        payload_json, created_at
      FROM strategy_pilot_audit_events
      WHERE deployment_id = ?
      ORDER BY created_at_epoch_ns ASC, id ASC
    `).all(deploymentId) as unknown as AuditRow[];
    return rows.map(auditFromRow);
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
        SELECT material_hash
        FROM strategy_candidate_execution_evidence
        WHERE deployment_id = ? AND id = ?
      `).get(input.deploymentId, material.evidence.evidenceId) as
        { material_hash: string } | undefined;
      if (existing) {
        if (existing.material_hash !== material.hash) {
          throw new Error(
            `Conflicting duplicate candidate evidence ${material.evidence.evidenceId}.`,
          );
        }
        const duplicateState = selectStateRow(this.db, input.deploymentId);
        if (!duplicateState) {
          throw new Error(`Candidate state ${input.deploymentId} does not exist.`);
        }
        return {
          state: stateFromRow(duplicateState),
          evidence: Object.freeze({ ...material.evidence }),
          duplicate: true,
        };
      }

      const currentRow = selectStateRow(this.db, input.deploymentId);
      if (!currentRow) {
        throw new Error(`Candidate state ${input.deploymentId} does not exist.`);
      }
      const currentState = stateFromRow(currentRow);
      if (currentState.stateVersion !== input.expectedStateVersion) {
        throw new Error(
          `Candidate state version mismatch: expected ${input.expectedStateVersion}, ` +
          `persisted ${currentState.stateVersion}.`,
        );
      }
      const deployment = selectDeploymentRow(this.db, input.deploymentId);
      if (!deployment) {
        throw new Error(`Candidate deployment ${input.deploymentId} does not exist.`);
      }
      const nextState = advancePositionGuardCandidateState(currentState, material.evidence);

      this.db.prepare(`
        INSERT INTO strategy_candidate_execution_evidence (
          id, deployment_id, executed_at, executed_at_epoch_ns, action, entry_path,
          terminal_status, executed_quantity, gross_quote_value_krw, confirmed_fee_krw,
          remaining_quantity, material_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        material.evidence.evidenceId,
        input.deploymentId,
        material.evidence.executedAt,
        material.epochNanoseconds,
        material.evidence.action,
        material.evidence.entryPath,
        material.evidence.terminalStatus,
        material.evidence.executedQuantity,
        material.evidence.grossQuoteValueKrw,
        material.evidence.confirmedFeeKrw,
        material.evidence.remainingQuantity,
        material.hash,
        material.evidence.executedAt,
      );
      const update = updateState(
        this.db,
        input.deploymentId,
        input.expectedStateVersion,
        nextState,
        material.evidence.executedAt,
      );
      if (update.changes !== 1) {
        throw new Error("Candidate state version compare-and-swap failed.");
      }
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
        evidenceAuditPayload(
          material.evidence.evidenceId,
          material.hash,
          currentState.stateVersion,
          nextState.stateVersion,
        ),
        material.evidence.executedAt,
        material.epochNanoseconds,
      );

      return {
        state: nextState,
        evidence: Object.freeze({ ...material.evidence }),
        duplicate: false,
      };
    });
  }

  private listEvidenceAfterCursor(
    deploymentId: string,
    afterEvidenceId: string,
  ): EvidenceRow[] {
    const cursor = this.db.prepare(`
      SELECT id
      FROM strategy_candidate_execution_evidence
      WHERE deployment_id = ? AND id = ?
    `).get(deploymentId, afterEvidenceId) as { id: string } | undefined;
    if (!cursor) {
      throw new Error(`Candidate evidence cursor ${afterEvidenceId} does not exist.`);
    }
    return this.db.prepare(`
      SELECT id, executed_at, action, entry_path, terminal_status, executed_quantity,
        gross_quote_value_krw, confirmed_fee_krw, remaining_quantity
      FROM strategy_candidate_execution_evidence
      WHERE deployment_id = ?
        AND (executed_at_epoch_ns, id) > (
          SELECT executed_at_epoch_ns, id
          FROM strategy_candidate_execution_evidence
          WHERE deployment_id = ? AND id = ?
        )
      ORDER BY executed_at_epoch_ns ASC, id ASC
    `).all(deploymentId, deploymentId, afterEvidenceId) as unknown as EvidenceRow[];
  }
}

function snapshotState(state: PositionGuardCandidateState): PositionGuardCandidateState {
  return {
    currentEpisodeAddCount: state.currentEpisodeAddCount,
    currentEpisodeCostBasisKrw: state.currentEpisodeCostBasisKrw,
    currentEpisodeInventoryQuantity: state.currentEpisodeInventoryQuantity,
    currentEpisodeRealizedPnlKrw: state.currentEpisodeRealizedPnlKrw,
    lastFullExitAt: state.lastFullExitAt,
    lastFullExitRealizedPnlKrw: state.lastFullExitRealizedPnlKrw,
    lastEntryPath: state.lastEntryPath,
    lastEvidenceAt: state.lastEvidenceAt,
    lastEvidenceId: state.lastEvidenceId,
    stateVersion: state.stateVersion,
  };
}

function assertPristineInitialState(state: PositionGuardCandidateState): void {
  if (state.stateVersion !== 0 || state.lastEvidenceId !== null || state.lastEvidenceAt !== null) {
    throw new Error("Candidate pilot deployment initial state must be pristine.");
  }
}

function selectDeploymentRow(db: DatabaseSync, deploymentId: string): DeploymentRow | undefined {
  return db.prepare(`
    SELECT id, exchange_account_id, pilot_id, market, policy_id, policy_version,
      phase, created_at, updated_at
    FROM strategy_pilot_deployments
    WHERE id = ?
  `).get(deploymentId) as DeploymentRow | undefined;
}

function selectStateRow(db: DatabaseSync, deploymentId: string): StateRow | undefined {
  return db.prepare(`
    SELECT current_episode_add_count, current_episode_cost_basis_krw,
      current_episode_inventory_quantity, current_episode_realized_pnl_krw,
      last_full_exit_at, last_full_exit_realized_pnl_krw, last_entry_path,
      last_evidence_at, last_evidence_id, state_version
    FROM strategy_candidate_states
    WHERE deployment_id = ?
  `).get(deploymentId) as StateRow | undefined;
}

function insertState(
  db: DatabaseSync,
  deploymentId: string,
  state: PositionGuardCandidateState,
  updatedAt: string,
): void {
  db.prepare(`
    INSERT INTO strategy_candidate_states (
      deployment_id, current_episode_add_count, current_episode_cost_basis_krw,
      current_episode_inventory_quantity, current_episode_realized_pnl_krw,
      last_full_exit_at, last_full_exit_realized_pnl_krw, last_entry_path,
      last_evidence_at, last_evidence_id, state_version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    deploymentId,
    state.currentEpisodeAddCount,
    state.currentEpisodeCostBasisKrw,
    state.currentEpisodeInventoryQuantity,
    state.currentEpisodeRealizedPnlKrw,
    state.lastFullExitAt,
    state.lastFullExitRealizedPnlKrw,
    state.lastEntryPath,
    state.lastEvidenceAt,
    state.lastEvidenceId,
    state.stateVersion,
    updatedAt,
  );
}

function updateState(
  db: DatabaseSync,
  deploymentId: string,
  expectedStateVersion: number,
  state: PositionGuardCandidateState,
  updatedAt: string,
): { changes: number | bigint } {
  return db.prepare(`
    UPDATE strategy_candidate_states SET
      current_episode_add_count = ?,
      current_episode_cost_basis_krw = ?,
      current_episode_inventory_quantity = ?,
      current_episode_realized_pnl_krw = ?,
      last_full_exit_at = ?,
      last_full_exit_realized_pnl_krw = ?,
      last_entry_path = ?,
      last_evidence_at = ?,
      last_evidence_id = ?,
      state_version = ?,
      updated_at = ?
    WHERE deployment_id = ? AND state_version = ?
  `).run(
    state.currentEpisodeAddCount,
    state.currentEpisodeCostBasisKrw,
    state.currentEpisodeInventoryQuantity,
    state.currentEpisodeRealizedPnlKrw,
    state.lastFullExitAt,
    state.lastFullExitRealizedPnlKrw,
    state.lastEntryPath,
    state.lastEvidenceAt,
    state.lastEvidenceId,
    state.stateVersion,
    updatedAt,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stateFromRow(row: StateRow): Readonly<PositionGuardCandidateState> {
  const state = snapshotState({
    currentEpisodeAddCount: row.current_episode_add_count,
    currentEpisodeCostBasisKrw: row.current_episode_cost_basis_krw,
    currentEpisodeInventoryQuantity: row.current_episode_inventory_quantity,
    currentEpisodeRealizedPnlKrw: row.current_episode_realized_pnl_krw,
    lastFullExitAt: row.last_full_exit_at,
    lastFullExitRealizedPnlKrw: row.last_full_exit_realized_pnl_krw,
    lastEntryPath: row.last_entry_path,
    lastEvidenceAt: row.last_evidence_at,
    lastEvidenceId: row.last_evidence_id,
    stateVersion: row.state_version,
  });
  validatePositionGuardCandidateState(state);
  return Object.freeze(state);
}

function evidenceFromRow(row: EvidenceRow): Readonly<PositionGuardCandidateExecutionEvidence> {
  return Object.freeze({
    evidenceId: row.id,
    executedAt: row.executed_at,
    action: row.action,
    entryPath: row.entry_path,
    terminalStatus: row.terminal_status,
    executedQuantity: row.executed_quantity,
    grossQuoteValueKrw: row.gross_quote_value_krw,
    confirmedFeeKrw: row.confirmed_fee_krw,
    remainingQuantity: row.remaining_quantity,
  });
}

function auditFromRow(row: AuditRow): PositionGuardPilotAuditEventRecord {
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

function deploymentAuditPayload(deployment: PositionGuardPilotDeploymentRecord): string {
  return JSON.stringify({
    pilotId: deployment.pilotId,
    market: deployment.market,
    policyId: deployment.policyId,
    policyVersion: deployment.policyVersion,
  });
}

function evidenceAuditPayload(
  evidenceId: string,
  materialHash: string,
  fromStateVersion: number,
  toStateVersion: number,
): string {
  return JSON.stringify({ evidenceId, materialHash, fromStateVersion, toStateVersion });
}
