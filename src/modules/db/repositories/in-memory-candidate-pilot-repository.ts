import { Buffer } from "node:buffer";

import type {
  CandidateExecutionBindingRecord,
  PositionGuardPilotAuditEventRecord,
  PositionGuardPilotDeploymentRecord,
} from "../../../domain/pilot-types.js";
import {
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
  validateCandidateExecutionBinding,
  validateCandidatePilotDeployment,
  type AdvanceCandidatePilotStateInput,
  type AdvanceCandidatePilotStateResult,
  type ActivateCandidatePilotDeploymentInput,
  type CandidateEvidenceRecord,
  type CandidatePilotRepository,
  type CreateCandidatePilotDeploymentInput,
} from "../pilot-interfaces.js";

interface StoredEvidence {
  record: Readonly<CandidateEvidenceRecord>;
  epochNanoseconds: bigint;
}

export class InMemoryCandidatePilotRepository implements CandidatePilotRepository {
  private readonly deployments = new Map<string, PositionGuardPilotDeploymentRecord>();
  private readonly exactStates = new Map<string, Readonly<ExactCandidateState>>();
  private readonly evidence = new Map<string, StoredEvidence[]>();
  private readonly auditEvents = new Map<string, PositionGuardPilotAuditEventRecord[]>();
  private readonly bindingsByOrderId = new Map<string, CandidateExecutionBindingRecord>();

  async createDeploymentWithInitialState(
    input: CreateCandidatePilotDeploymentInput,
  ): Promise<PositionGuardPilotDeploymentRecord> {
    const deployment = validateCandidatePilotDeployment(input.deployment);
    validatePositionGuardCandidateState(input.initialState);
    if (!isPristineInitialState(input.initialState)) {
      throw new Error("Candidate pilot deployment initial state must be pristine.");
    }
    if (this.deployments.has(deployment.id)) {
      throw new Error(`Candidate pilot deployment ${deployment.id} already exists.`);
    }
    if ([...this.deployments.values()].some((candidate) =>
      candidate.exchangeAccountId === deployment.exchangeAccountId && candidate.pilotId === deployment.pilotId
    )) {
      throw new Error(`Candidate pilot deployment already exists for account ${deployment.exchangeAccountId}.`);
    }
    this.deployments.set(deployment.id, { ...deployment });
    this.exactStates.set(deployment.id, createExactEmptyCandidateState());
    this.evidence.set(deployment.id, []);
    this.auditEvents.set(deployment.id, [{
      id: `${deployment.id}:created`,
      deploymentId: deployment.id,
      eventType: "DEPLOYMENT_CREATED",
      fromPhase: null,
      toPhase: deployment.phase,
      stateVersion: 0,
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

  async getDeploymentForExchangeAccount(
    exchangeAccountId: string,
  ): Promise<PositionGuardPilotDeploymentRecord | null> {
    const deployment = [...this.deployments.values()]
      .filter((candidate) => candidate.exchangeAccountId === exchangeAccountId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
    return deployment ? { ...deployment } : null;
  }

  async activateDeployment(
    input: ActivateCandidatePilotDeploymentInput,
  ): Promise<PositionGuardPilotDeploymentRecord | null> {
    const deployment = this.deployments.get(input.deploymentId);
    if (!deployment || deployment.phase !== input.expectedPhase || deployment.updatedAt !== input.expectedUpdatedAt ||
      deployment.activationAt !== null || deployment.activationEpochNs !== null) {
      return null;
    }
    validateActivationInput(input, deployment);
    const activated: PositionGuardPilotDeploymentRecord = {
      ...deployment,
      phase: "ACTIVE",
      activationAt: input.activationAt,
      activationEpochNs: input.activationEpochNs,
      updatedAt: input.activationAt,
    };
    this.deployments.set(activated.id, activated);
    const stateVersion = this.exactStates.get(activated.id)?.stateVersion ?? 0;
    this.auditEvents.set(activated.id, [...(this.auditEvents.get(activated.id) ?? []), {
      id: `${activated.id}:activation:${input.activationEpochNs.toString()}`,
      deploymentId: activated.id,
      eventType: "PHASE_TRANSITION",
      fromPhase: deployment.phase,
      toPhase: activated.phase,
      stateVersion,
      payloadJson: JSON.stringify({ activationAt: input.activationAt, activationEpochNs: input.activationEpochNs.toString() }),
      createdAt: input.activationAt,
    }]);
    return { ...activated };
  }

  async getState(deploymentId: string): Promise<Readonly<PositionGuardCandidateState> | null> {
    const state = this.exactStates.get(deploymentId);
    return state ? Object.freeze(approximateState(state)) : null;
  }

  async getExactState(deploymentId: string): Promise<Readonly<ExactCandidateState> | null> {
    const state = this.exactStates.get(deploymentId);
    return state ? Object.freeze({ ...state }) : null;
  }

  async listEvidenceAfter(
    deploymentId: string,
    afterEvidenceId: string | null,
  ): Promise<Array<Readonly<PositionGuardCandidateExecutionEvidence>>> {
    const records = orderedEvidence(this.evidence.get(deploymentId) ?? []);
    const start = afterEvidenceId === null ? 0 : cursorAfter(records, afterEvidenceId);
    return records.slice(start).map((item) => Object.freeze({ ...item.record.evidence }));
  }

  async listEvidenceRecords(deploymentId: string): Promise<Array<Readonly<CandidateEvidenceRecord>>> {
    return orderedEvidence(this.evidence.get(deploymentId) ?? [])
      .map((item) => Object.freeze({
        evidence: Object.freeze({ ...item.record.evidence }),
        materialHash: item.record.materialHash,
        materialVersion: item.record.materialVersion,
      }));
  }

  async getEvidenceRecord(
    deploymentId: string,
    evidenceId: string,
  ): Promise<Readonly<CandidateEvidenceRecord> | null> {
    const record = (this.evidence.get(deploymentId) ?? [])
      .find((item) => item.record.evidence.evidenceId === evidenceId)?.record;
    return record ? Object.freeze({
      evidence: Object.freeze({ ...record.evidence }),
      materialHash: record.materialHash,
      materialVersion: record.materialVersion,
    }) : null;
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

  async createExecutionBinding(input: CandidateExecutionBindingRecord): Promise<CandidateExecutionBindingRecord> {
    const binding = validateCandidateExecutionBinding(input);
    const deployment = this.deployments.get(binding.deploymentId);
    if (!deployment || deployment.exchangeAccountId !== binding.exchangeAccountId) {
      throw new Error("Candidate execution binding deployment does not match its exchange account.");
    }
    if (
      (deployment.phase !== "ACTIVE" && deployment.phase !== "DRAINING") ||
      deployment.activationAt === null ||
      deployment.activationEpochNs === null ||
      binding.activationAt !== deployment.activationAt ||
      binding.activationEpochNs !== deployment.activationEpochNs
    ) {
      throw new Error("Candidate execution binding must use the persisted active deployment instant.");
    }
    const existing = this.bindingsByOrderId.get(binding.orderId);
    if (existing) {
      if (!sameBinding(existing, binding)) {
        throw new Error(`Conflicting candidate execution binding for order ${binding.orderId}.`);
      }
      return { ...existing };
    }
    this.bindingsByOrderId.set(binding.orderId, { ...binding });
    return { ...binding };
  }

  async getExecutionBindingForOrder(orderId: string): Promise<CandidateExecutionBindingRecord | null> {
    const binding = this.bindingsByOrderId.get(orderId);
    return binding ? { ...binding } : null;
  }

  async advanceStateWithEvidence(
    input: AdvanceCandidatePilotStateInput,
  ): Promise<AdvanceCandidatePilotStateResult> {
    if (!Number.isSafeInteger(input.expectedStateVersion) || input.expectedStateVersion < 0) {
      throw new Error("Candidate pilot expected state version must be a non-negative safe integer.");
    }
    const deployment = this.deployments.get(input.deploymentId);
    const currentState = this.exactStates.get(input.deploymentId);
    if (!deployment || !currentState) {
      throw new Error(`Candidate state ${input.deploymentId} does not exist or is legacy approximate.`);
    }
    const material = candidateEvidenceMaterial(input.deploymentId, input.evidence);
    const records = this.evidence.get(input.deploymentId) ?? [];
    const duplicate = records.find((item) => item.record.evidence.evidenceId === material.evidence.evidenceId);
    if (duplicate) {
      if (duplicate.record.materialHash !== material.hash || duplicate.record.materialVersion !== material.materialVersion) {
        throw new Error(`Conflicting duplicate candidate evidence ${material.evidence.evidenceId}.`);
      }
      return {
        state: Object.freeze(approximateState(currentState)),
        evidence: Object.freeze({ ...material.evidence }),
        duplicate: true,
      };
    }
    if (currentState.stateVersion !== input.expectedStateVersion) {
      throw new Error(
        `Candidate state version mismatch: expected ${input.expectedStateVersion}, persisted ${currentState.stateVersion}.`,
      );
    }
    const nextRecords = [...records, {
      record: Object.freeze({
        evidence: Object.freeze({ ...material.evidence }),
        materialHash: material.hash,
        materialVersion: material.materialVersion,
      }),
      epochNanoseconds: material.epochNanoseconds,
    }];
    const nextState = projectExactCandidateState(nextRecords.map((item) => item.record.evidence));
    if (nextState.stateVersion !== currentState.stateVersion + 1) {
      throw new Error("Candidate evidence replay did not advance the exact state by one version.");
    }
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
        materialVersion: material.materialVersion,
        fromStateVersion: currentState.stateVersion,
        toStateVersion: nextState.stateVersion,
      }),
      createdAt: material.evidence.executedAt,
    }];
    this.exactStates.set(input.deploymentId, nextState);
    this.evidence.set(input.deploymentId, nextRecords);
    this.auditEvents.set(input.deploymentId, nextAudit);
    return {
      state: Object.freeze(approximateState(nextState)),
      evidence: Object.freeze({ ...material.evidence }),
      duplicate: false,
    };
  }
}

function orderedEvidence(records: readonly StoredEvidence[]): StoredEvidence[] {
  return [...records].sort((left, right) => {
    if (left.epochNanoseconds < right.epochNanoseconds) return -1;
    if (left.epochNanoseconds > right.epochNanoseconds) return 1;
    return compareSqliteBinaryText(left.record.evidence.evidenceId, right.record.evidence.evidenceId);
  });
}

function cursorAfter(records: readonly StoredEvidence[], evidenceId: string): number {
  const cursorIndex = records.findIndex((item) => item.record.evidence.evidenceId === evidenceId);
  if (cursorIndex < 0) throw new Error(`Candidate evidence cursor ${evidenceId} does not exist.`);
  return cursorIndex + 1;
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

function sameBinding(left: CandidateExecutionBindingRecord, right: CandidateExecutionBindingRecord): boolean {
  return left.id === right.id &&
    left.deploymentId === right.deploymentId &&
    left.strategyDecisionId === right.strategyDecisionId &&
    left.orderId === right.orderId &&
    left.exchangeAccountId === right.exchangeAccountId &&
    left.activationAt === right.activationAt &&
    left.activationEpochNs === right.activationEpochNs &&
    left.market === right.market &&
    left.strategyKey === right.strategyKey &&
    left.policyId === right.policyId &&
    left.policyVersion === right.policyVersion &&
    left.executionMode === right.executionMode &&
    left.ordType === right.ordType &&
    left.action === right.action &&
    left.side === right.side &&
    left.intendedQuantity === right.intendedQuantity &&
    left.intendedNotionalKrw === right.intendedNotionalKrw &&
    left.boundPrice === right.boundPrice &&
    left.boundVolume === right.boundVolume &&
    left.boundTimeInForce === right.boundTimeInForce &&
    left.boundSmpType === right.boundSmpType &&
    left.materialVersion === right.materialVersion &&
    left.orderMaterialHash === right.orderMaterialHash &&
    left.createdAt === right.createdAt;
}

function compareSqliteBinaryText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
