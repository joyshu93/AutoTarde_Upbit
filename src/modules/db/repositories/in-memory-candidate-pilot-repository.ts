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

interface StoredEvidence {
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>;
  hash: string;
  epochNanoseconds: bigint;
}

export class InMemoryCandidatePilotRepository implements CandidatePilotRepository {
  private readonly deployments = new Map<string, PositionGuardPilotDeploymentRecord>();
  private readonly states = new Map<string, Readonly<PositionGuardCandidateState>>();
  private readonly evidence = new Map<string, StoredEvidence[]>();
  private readonly auditEvents = new Map<string, PositionGuardPilotAuditEventRecord[]>();

  async createDeploymentWithInitialState(
    input: CreateCandidatePilotDeploymentInput,
  ): Promise<PositionGuardPilotDeploymentRecord> {
    const deployment = validateCandidatePilotDeployment(input.deployment);
    validatePositionGuardCandidateState(input.initialState);
    const state = cloneState(input.initialState);
    validatePositionGuardCandidateState(state);
    if (state.stateVersion !== 0 || state.lastEvidenceAt !== null || state.lastEvidenceId !== null) {
      throw new Error("Candidate pilot deployment initial state must be pristine.");
    }
    if (this.deployments.has(deployment.id)) {
      throw new Error(`Candidate pilot deployment ${deployment.id} already exists.`);
    }
    if ([...this.deployments.values()].some((candidate) =>
      candidate.exchangeAccountId === deployment.exchangeAccountId &&
      candidate.pilotId === deployment.pilotId
    )) {
      throw new Error(
        `Candidate pilot deployment already exists for account ${deployment.exchangeAccountId}.`,
      );
    }
    this.deployments.set(deployment.id, deployment);
    this.states.set(deployment.id, Object.freeze(state));
    this.evidence.set(deployment.id, []);
    this.auditEvents.set(deployment.id, [{
      id: `${deployment.id}:created`,
      deploymentId: deployment.id,
      eventType: "DEPLOYMENT_CREATED",
      fromPhase: null,
      toPhase: deployment.phase,
      stateVersion: state.stateVersion,
      payloadJson: JSON.stringify({
        pilotId: deployment.pilotId,
        market: deployment.market,
        policyId: deployment.policyId,
        policyVersion: deployment.policyVersion,
      }),
      createdAt: deployment.createdAt,
    }]);
    return { ...deployment };
  }

  async getDeployment(deploymentId: string): Promise<PositionGuardPilotDeploymentRecord | null> {
    const deployment = this.deployments.get(deploymentId);
    return deployment ? { ...deployment } : null;
  }

  async getState(deploymentId: string): Promise<Readonly<PositionGuardCandidateState> | null> {
    const state = this.states.get(deploymentId);
    return state ? Object.freeze(cloneState(state)) : null;
  }

  async listEvidenceAfter(
    deploymentId: string,
    afterEvidenceId: string | null,
  ): Promise<Array<Readonly<PositionGuardCandidateExecutionEvidence>>> {
    const records = [...(this.evidence.get(deploymentId) ?? [])].sort(compareEvidence);
    let startIndex = 0;
    if (afterEvidenceId !== null) {
      const cursorIndex = records.findIndex((item) => item.evidence.evidenceId === afterEvidenceId);
      if (cursorIndex < 0) {
        throw new Error(`Candidate evidence cursor ${afterEvidenceId} does not exist.`);
      }
      startIndex = cursorIndex + 1;
    }
    return records.slice(startIndex).map((item) => Object.freeze({ ...item.evidence }));
  }

  async listAuditEvents(deploymentId: string): Promise<PositionGuardPilotAuditEventRecord[]> {
    return [...(this.auditEvents.get(deploymentId) ?? [])]
      .sort((left, right) => {
        const leftEpoch = parsePositionGuardCandidateTimestamp(left.createdAt, "audit createdAt");
        const rightEpoch = parsePositionGuardCandidateTimestamp(right.createdAt, "audit createdAt");
        if (leftEpoch < rightEpoch) return -1;
        if (leftEpoch > rightEpoch) return 1;
        return left.id.localeCompare(right.id);
      })
      .map((event) => ({ ...event }));
  }

  async advanceStateWithEvidence(
    input: AdvanceCandidatePilotStateInput,
  ): Promise<AdvanceCandidatePilotStateResult> {
    if (!Number.isSafeInteger(input.expectedStateVersion) || input.expectedStateVersion < 0) {
      throw new Error("Candidate pilot expected state version must be a non-negative safe integer.");
    }
    const deployment = this.deployments.get(input.deploymentId);
    const currentState = this.states.get(input.deploymentId);
    if (!deployment || !currentState) {
      throw new Error(`Candidate state ${input.deploymentId} does not exist.`);
    }
    const material = candidateEvidenceMaterial(input.deploymentId, input.evidence);
    const records = this.evidence.get(input.deploymentId) ?? [];
    const duplicate = records.find(
      (item) => item.evidence.evidenceId === material.evidence.evidenceId,
    );
    if (duplicate) {
      if (duplicate.hash !== material.hash) {
        throw new Error(`Conflicting duplicate candidate evidence ${material.evidence.evidenceId}.`);
      }
      return {
        state: Object.freeze(cloneState(currentState)),
        evidence: Object.freeze({ ...material.evidence }),
        duplicate: true,
      };
    }
    if (currentState.stateVersion !== input.expectedStateVersion) {
      throw new Error(
        `Candidate state version mismatch: expected ${input.expectedStateVersion}, ` +
        `persisted ${currentState.stateVersion}.`,
      );
    }

    const nextState = advancePositionGuardCandidateState(currentState, material.evidence);
    const nextEvidence = [...records, {
      evidence: Object.freeze({ ...material.evidence }),
      hash: material.hash,
      epochNanoseconds: material.epochNanoseconds,
    }];
    const nextAudit = [...(this.auditEvents.get(input.deploymentId) ?? []), {
      id: `${input.deploymentId}:evidence:${material.evidence.evidenceId}`,
      deploymentId: input.deploymentId,
      eventType: "STATE_ADVANCED" as const,
      fromPhase: deployment.phase,
      toPhase: deployment.phase,
      stateVersion: nextState.stateVersion,
      payloadJson: JSON.stringify({
        evidenceId: material.evidence.evidenceId,
        materialHash: material.hash,
        fromStateVersion: currentState.stateVersion,
        toStateVersion: nextState.stateVersion,
      }),
      createdAt: material.evidence.executedAt,
    }];

    this.states.set(input.deploymentId, nextState);
    this.evidence.set(input.deploymentId, nextEvidence);
    this.auditEvents.set(input.deploymentId, nextAudit);
    return {
      state: Object.freeze(cloneState(nextState)),
      evidence: Object.freeze({ ...material.evidence }),
      duplicate: false,
    };
  }
}

function cloneState(state: PositionGuardCandidateState): PositionGuardCandidateState {
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

function compareEvidence(left: StoredEvidence, right: StoredEvidence): number {
  if (left.epochNanoseconds < right.epochNanoseconds) return -1;
  if (left.epochNanoseconds > right.epochNanoseconds) return 1;
  return left.evidence.evidenceId.localeCompare(right.evidence.evidenceId);
}
