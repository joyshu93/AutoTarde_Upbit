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
  buildCandidatePilotRollbackAuditEvent,
  buildCandidatePilotRecoveryFaultAuditEvent,
  candidatePilotRecoveryFaultReason,
  resolveCandidateIntentFaultOccurrence,
  toPositionGuardCandidateRoutingState,
  isExactCandidateStateRollbackFlat,
  validateCandidateExecutionBinding,
  validateCandidateIntentFaultInput,
  validateCandidatePilotDeployment,
  validateCandidatePilotRecoveryFaultChronology,
  validateCandidatePilotRecoveryFaultInput,
  validateCandidatePilotRollbackChronology,
  validateCandidatePilotRollbackInput,
  type AdvanceCandidatePilotStateInput,
  type AdvanceCandidatePilotStateResult,
  type ActivateCandidatePilotDeploymentInput,
  type CandidateEvidenceRecord,
  type CandidatePilotDeploymentInitializationResult,
  type CandidatePilotRollbackInput,
  type CandidatePilotRecoveryIdentity,
  type CandidatePilotRepository,
  type CreateCandidatePilotDeploymentInput,
  type InMemoryAtomicFaultPauseStore,
  type PauseCandidateIntentFaultInput,
  type PauseCandidatePilotForRecoveryFaultInput,
  type PauseCandidatePilotForRecoveryFaultResult,
} from "../pilot-interfaces.js";
import type {
  InMemoryCandidateBoundOrderStore,
  PreparedInMemoryCandidateBoundOrderIntent,
} from "../interfaces.js";
import { deriveFaultPauseTransitionAt, recordsEqual } from "./atomic-lifecycle-validation.js";

interface StoredEvidence {
  record: Readonly<CandidateEvidenceRecord>;
  epochNanoseconds: bigint;
}

export class InMemoryCandidatePilotRepository implements CandidatePilotRepository, InMemoryCandidateBoundOrderStore {
  private readonly deployments = new Map<string, PositionGuardPilotDeploymentRecord>();
  private readonly exactStates = new Map<string, Readonly<ExactCandidateState>>();
  private readonly evidence = new Map<string, StoredEvidence[]>();
  private readonly auditEvents = new Map<string, PositionGuardPilotAuditEventRecord[]>();
  private readonly bindingsByOrderId = new Map<string, CandidateExecutionBindingRecord>();
  private recoveryFaultSerialization: Promise<void> = Promise.resolve();
  private initializationSerialization: Promise<void> = Promise.resolve();

  constructor(private readonly atomicFaultPauseStore?: InMemoryAtomicFaultPauseStore) {}

  async createDeploymentWithInitialState(
    input: CreateCandidatePilotDeploymentInput,
  ): Promise<PositionGuardPilotDeploymentRecord> {
    const deployment = this.validateInitialDeployment(input);
    if (this.deployments.has(deployment.id)) {
      throw new Error(`Candidate pilot deployment ${deployment.id} already exists.`);
    }
    if ([...this.deployments.values()].some((candidate) =>
      candidate.exchangeAccountId === deployment.exchangeAccountId && candidate.pilotId === deployment.pilotId
    )) {
      throw new Error(`Candidate pilot deployment already exists for account ${deployment.exchangeAccountId}.`);
    }
    this.insertDeploymentWithInitialState(deployment);
    return { ...deployment };
  }

  async initializeDeploymentWithInitialState(
    input: CreateCandidatePilotDeploymentInput,
  ): Promise<CandidatePilotDeploymentInitializationResult> {
    const deployment = this.validateInitialDeployment(input);
    if (
      deployment.phase !== "PENDING_FLAT" ||
      deployment.activationAt !== null ||
      deployment.activationEpochNs !== null
    ) {
      throw new Error("Candidate pilot deployment initialization requires PENDING_FLAT without activation authority.");
    }
    return this.serializeInitialization(async () => {
      const existingById = this.deployments.get(deployment.id);
      if (existingById && !sameBootstrapIdentity(existingById, deployment)) {
        throw new Error(`Candidate pilot deployment ${deployment.id} identity collision.`);
      }
      const existing = existingById ?? [...this.deployments.values()]
        .find((candidate) =>
          candidate.exchangeAccountId === deployment.exchangeAccountId && candidate.pilotId === deployment.pilotId,
        );
      if (existing) {
        return this.bootstrapAuthority("EXISTING", existing);
      }
      this.insertDeploymentWithInitialState(deployment);
      const created = this.deployments.get(deployment.id);
      if (!created) {
        throw new Error(`Candidate pilot deployment ${deployment.id} was not persisted.`);
      }
      return this.bootstrapAuthority("CREATED", created);
    });
  }

  private validateInitialDeployment(input: CreateCandidatePilotDeploymentInput): PositionGuardPilotDeploymentRecord {
    const deployment = validateCandidatePilotDeployment(input.deployment);
    validatePositionGuardCandidateState(input.initialState);
    if (!isPristineInitialState(input.initialState)) {
      throw new Error("Candidate pilot deployment initial state must be pristine.");
    }
    return deployment;
  }

  private insertDeploymentWithInitialState(deployment: PositionGuardPilotDeploymentRecord): void {
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
  }

  private bootstrapAuthority(
    outcome: CandidatePilotDeploymentInitializationResult["outcome"],
    deployment: PositionGuardPilotDeploymentRecord,
  ): CandidatePilotDeploymentInitializationResult {
    const exactState = this.exactStates.get(deployment.id);
    if (!exactState) {
      throw new Error(`Candidate pilot deployment ${deployment.id} is missing exact state authority.`);
    }
    const evidenceRecords = orderedEvidence(this.evidence.get(deployment.id) ?? []).map((item) => Object.freeze({
      evidence: Object.freeze({ ...item.record.evidence }),
      materialHash: item.record.materialHash,
      materialVersion: item.record.materialVersion,
    }));
    const auditEvents = [...(this.auditEvents.get(deployment.id) ?? [])]
      .sort((left, right) => {
        const leftEpoch = parsePositionGuardCandidateTimestamp(left.createdAt, "audit createdAt");
        const rightEpoch = parsePositionGuardCandidateTimestamp(right.createdAt, "audit createdAt");
        if (leftEpoch < rightEpoch) return -1;
        if (leftEpoch > rightEpoch) return 1;
        return left.id.localeCompare(right.id);
      })
      .map((event) => Object.freeze({ ...event }));
    return Object.freeze({
      outcome,
      deployment: Object.freeze({ ...deployment }),
      exactState: Object.freeze({ ...exactState }),
      evidenceRecords: Object.freeze(evidenceRecords),
      auditEvents: Object.freeze(auditEvents),
    });
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

  async findDeploymentsForRecoveryIdentity(
    identity: CandidatePilotRecoveryIdentity,
  ): Promise<Array<Readonly<PositionGuardPilotDeploymentRecord>>> {
    return [...this.deployments.values()]
      .filter((candidate) =>
        candidate.exchangeAccountId === identity.exchangeAccountId &&
        candidate.pilotId === identity.pilotId &&
        candidate.market === identity.market &&
        candidate.policyId === identity.policyId &&
        candidate.policyVersion === identity.policyVersion
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .slice(0, 2)
      .map((deployment) => Object.freeze({ ...validateCandidatePilotDeployment(deployment) }));
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

  async startRollback(input: CandidatePilotRollbackInput): Promise<PositionGuardPilotDeploymentRecord | null> {
    const rollback = validateCandidatePilotRollbackInput(input);
    const deployment = this.deployments.get(rollback.deploymentId);
    const state = this.exactStates.get(rollback.deploymentId);
    if (!deployment || !state || rollback.expectedPhase !== "ACTIVE" || deployment.phase !== "ACTIVE" ||
      deployment.updatedAt !== rollback.expectedUpdatedAt || state.stateVersion !== rollback.expectedStateVersion) {
      return null;
    }
    validateCandidatePilotRollbackChronology(rollback, deployment, state);
    const next: PositionGuardPilotDeploymentRecord = {
      ...deployment,
      phase: "DRAINING",
      updatedAt: rollback.transitionAt,
    };
    const audit = buildCandidatePilotRollbackAuditEvent({
      rollback,
      eventType: "ROLLBACK_STARTED",
      fromPhase: deployment.phase,
      toPhase: next.phase,
      stateVersion: state.stateVersion,
    });
    this.deployments.set(next.id, next);
    this.auditEvents.set(next.id, [...(this.auditEvents.get(next.id) ?? []), audit]);
    return { ...validateCandidatePilotDeployment(next) };
  }

  async completeRollback(input: CandidatePilotRollbackInput): Promise<PositionGuardPilotDeploymentRecord | null> {
    const rollback = validateCandidatePilotRollbackInput(input);
    const deployment = this.deployments.get(rollback.deploymentId);
    const state = this.exactStates.get(rollback.deploymentId);
    if (!deployment || !state || !isRollbackCompletablePhase(rollback.expectedPhase) ||
      deployment.phase !== rollback.expectedPhase || deployment.updatedAt !== rollback.expectedUpdatedAt ||
      state.stateVersion !== rollback.expectedStateVersion) {
      return null;
    }
    validateCandidatePilotRollbackChronology(rollback, deployment, state);
    if (!isExactCandidateStateRollbackFlat(state)) {
      throw new Error("Candidate pilot rollback completion requires an exact flat current episode state.");
    }
    const next: PositionGuardPilotDeploymentRecord = {
      ...deployment,
      phase: "DISABLED",
      updatedAt: rollback.transitionAt,
    };
    const audit = buildCandidatePilotRollbackAuditEvent({
      rollback,
      eventType: "ROLLBACK_COMPLETED",
      fromPhase: deployment.phase,
      toPhase: next.phase,
      stateVersion: state.stateVersion,
    });
    this.deployments.set(next.id, next);
    this.auditEvents.set(next.id, [...(this.auditEvents.get(next.id) ?? []), audit]);
    return { ...validateCandidatePilotDeployment(next) };
  }

  async getState(deploymentId: string): Promise<Readonly<PositionGuardCandidateState> | null> {
    const state = this.exactStates.get(deploymentId);
    return state ? toPositionGuardCandidateRoutingState(state) : null;
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
    const existingById = [...this.bindingsByOrderId.values()]
      .find((candidate) => candidate.id === binding.id);
    if (existingById) {
      throw new Error(`Conflicting candidate execution binding id ${binding.id}.`);
    }
    this.bindingsByOrderId.set(binding.orderId, { ...binding });
    return { ...binding };
  }

  prepareCandidateBoundOrderIntent(
    input: CandidateExecutionBindingRecord,
  ): PreparedInMemoryCandidateBoundOrderIntent {
    const binding = { ...validateCandidateExecutionBinding(input) };
    const deployment = this.deployments.get(binding.deploymentId);
    const exactState = this.exactStates.get(binding.deploymentId);
    const existingByOrder = this.bindingsByOrderId.get(binding.orderId);
    const existingById = [...this.bindingsByOrderId.values()]
      .find((candidate) => candidate.id === binding.id);
    const deploymentSnapshot = deployment ? { ...deployment } : null;
    const exactStateSnapshot = exactState ? { ...exactState } : null;
    const existingByOrderSnapshot = existingByOrder ? { ...existingByOrder } : null;
    const existingByIdSnapshot = existingById ? { ...existingById } : null;
    let used = false;

    return {
      deployment: deploymentSnapshot ? { ...deploymentSnapshot } : null,
      exactStateVersion: exactStateSnapshot?.stateVersion ?? null,
      existingBindingByOrderId: existingByOrderSnapshot ? { ...existingByOrderSnapshot } : null,
      existingBindingById: existingByIdSnapshot ? { ...existingByIdSnapshot } : null,
      commitBinding: () => {
        if (used) {
          throw new Error("Candidate-bound binding commit capability is single-use and was already used.");
        }
        used = true;
        const currentDeployment = this.deployments.get(binding.deploymentId) ?? null;
        const currentExactState = this.exactStates.get(binding.deploymentId) ?? null;
        const currentByOrder = this.bindingsByOrderId.get(binding.orderId) ?? null;
        const currentById = [...this.bindingsByOrderId.values()]
          .find((candidate) => candidate.id === binding.id) ?? null;
        if (
          !optionalRecordsEqual(currentDeployment, deploymentSnapshot) ||
          !optionalRecordsEqual(currentExactState, exactStateSnapshot) ||
          !optionalBindingsEqual(currentByOrder, existingByOrderSnapshot) ||
          !optionalBindingsEqual(currentById, existingByIdSnapshot)
        ) {
          throw new Error("Candidate-bound order authority changed before binding commit.");
        }
        if (currentByOrder || currentById) {
          if (
            !currentByOrder || !currentById ||
            !sameBinding(currentByOrder, binding) ||
            !sameBinding(currentById, binding)
          ) {
            throw new Error("Candidate-bound order binding conflicts with prepared authority.");
          }
          return;
        }
        this.bindingsByOrderId.set(binding.orderId, binding);
      },
    };
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
        state: toPositionGuardCandidateRoutingState(currentState),
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
      state: toPositionGuardCandidateRoutingState(nextState),
      evidence: Object.freeze({ ...material.evidence }),
      duplicate: false,
    };
  }

  async pauseForRecoveryFault(
    input: PauseCandidatePilotForRecoveryFaultInput,
  ): Promise<PauseCandidatePilotForRecoveryFaultResult> {
    validateCandidatePilotRecoveryFaultInput(input);
    if (!this.atomicFaultPauseStore) {
      throw new Error("In-memory candidate recovery faults require an atomic fault-pause store.");
    }
    return this.serializeRecoveryFault(() => this.pauseForRecoveryFaultSerialized(input));
  }

  async pauseForCandidateIntentFault(
    input: PauseCandidateIntentFaultInput,
  ): Promise<PauseCandidatePilotForRecoveryFaultResult> {
    const candidateIntentInput = Object.freeze({ ...input });
    const fault = validateCandidateIntentFaultInput(candidateIntentInput);
    if (!this.atomicFaultPauseStore) {
      throw new Error("In-memory candidate recovery faults require an atomic fault-pause store.");
    }
    return this.serializeRecoveryFault(
      () => this.pauseForRecoveryFaultSerialized(fault, candidateIntentInput),
    );
  }

  private async pauseForRecoveryFaultSerialized(
    input: PauseCandidatePilotForRecoveryFaultInput,
    candidateIntentInput: PauseCandidateIntentFaultInput | null = null,
  ): Promise<PauseCandidatePilotForRecoveryFaultResult> {
    if (!this.atomicFaultPauseStore) {
      throw new Error("In-memory candidate recovery faults require an atomic fault-pause store.");
    }
    const deployment = this.deployments.get(input.deploymentId);
    const state = this.exactStates.get(input.deploymentId);
    if (!deployment || !state || deployment.exchangeAccountId !== input.exchangeAccountId) {
      throw new Error("Candidate recovery fault deployment provenance does not match persisted state.");
    }
    const existingAudit = (this.auditEvents.get(input.deploymentId) ?? [])
      .find((event) => event.id === input.faultId);
    const existingTransition = this.atomicFaultPauseStore.getTransitionById
      ? await this.atomicFaultPauseStore.getTransitionById(input.faultId)
      : (await this.atomicFaultPauseStore.listTransitions(Number.MAX_SAFE_INTEGER))
        .find((transition) => transition.id === input.faultId) ?? null;
    const executionState = await this.atomicFaultPauseStore.getState();
    const latestAudit = (this.auditEvents.get(input.deploymentId) ?? []).reduce<
      PositionGuardPilotAuditEventRecord | null
    >((latest, event) => {
      if (!latest) return event;
      return parsePositionGuardCandidateTimestamp(event.createdAt, "candidate audit createdAt") >
        parsePositionGuardCandidateTimestamp(latest.createdAt, "candidate audit createdAt")
        ? event
        : latest;
    }, null);
    const effectiveInput = candidateIntentInput === null
      ? input
      : existingAudit
        ? { ...input, occurredAt: existingAudit.createdAt }
        : resolveCandidateIntentFaultOccurrence(candidateIntentInput, [
            deployment.updatedAt,
            ...(latestAudit === null ? [] : [latestAudit.createdAt]),
          ]);
    const transitionAt = deriveFaultPauseTransitionAt(effectiveInput.occurredAt, executionState.updatedAt);
    if (existingAudit || existingTransition) {
      if (!existingAudit || !existingTransition || deployment.phase !== "PAUSED_FAULT" ||
        deployment.updatedAt !== effectiveInput.occurredAt ||
        (executionState.systemStatus !== "PAUSED" && executionState.systemStatus !== "KILL_SWITCHED")) {
        throw new Error(`Conflicting partial candidate recovery fault ${input.faultId}.`);
      }
      if (existingAudit.fromPhase === null || !isFaultPausablePhase(existingAudit.fromPhase)) {
        throw new Error(`Conflicting duplicate candidate recovery fault ${input.faultId}.`);
      }
      const expectedAudit = buildCandidatePilotRecoveryFaultAuditEvent({
        fault: effectiveInput,
        fromPhase: existingAudit.fromPhase,
        stateVersion: state.stateVersion,
      });
      const expectedReason = `faultId=${input.faultId}; reason=${candidatePilotRecoveryFaultReason(effectiveInput)}`;
      if (!sameAuditEvent(existingAudit, expectedAudit) ||
        existingTransition.command !== "AUTOMATIC_PAUSE" ||
        existingTransition.exchangeAccountId !== input.exchangeAccountId ||
        existingTransition.reason !== expectedReason) {
        throw new Error(`Conflicting duplicate candidate recovery fault ${input.faultId}.`);
      }
      return {
        deployment: { ...deployment },
        executionState,
        auditEvent: { ...existingAudit },
        duplicate: true,
      };
    }
    if (!isFaultPausablePhase(deployment.phase)) {
      throw new Error(`Candidate recovery fault cannot pause phase ${deployment.phase}.`);
    }
    validateCandidatePilotRecoveryFaultChronology(effectiveInput, deployment, latestAudit?.createdAt ?? null);
    const auditEvent = buildCandidatePilotRecoveryFaultAuditEvent({
      fault: effectiveInput,
      fromPhase: deployment.phase,
      stateVersion: state.stateVersion,
    });
    const nextExecutionState = this.atomicFaultPauseStore.applyFaultPauseAtomically({
      exchangeAccountId: input.exchangeAccountId,
      faultId: input.faultId,
      reason: candidatePilotRecoveryFaultReason(effectiveInput),
      occurredAt: effectiveInput.occurredAt,
      transitionAt,
    });
    const pausedDeployment: PositionGuardPilotDeploymentRecord = {
      ...deployment,
      phase: "PAUSED_FAULT",
      updatedAt: effectiveInput.occurredAt,
    };
    this.deployments.set(input.deploymentId, pausedDeployment);
    this.auditEvents.set(input.deploymentId, [
      ...(this.auditEvents.get(input.deploymentId) ?? []),
      auditEvent,
    ]);
    return {
      deployment: { ...pausedDeployment },
      executionState: { ...nextExecutionState },
      auditEvent: { ...auditEvent },
      duplicate: false,
    };
  }

  private async serializeRecoveryFault<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.recoveryFaultSerialization;
    let release!: () => void;
    this.recoveryFaultSerialization = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async serializeInitialization<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.initializationSerialization;
    let release!: () => void;
    this.initializationSerialization = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function sameBootstrapIdentity(
  left: PositionGuardPilotDeploymentRecord,
  right: PositionGuardPilotDeploymentRecord,
): boolean {
  return left.exchangeAccountId === right.exchangeAccountId &&
    left.pilotId === right.pilotId &&
    left.market === right.market &&
    left.policyId === right.policyId &&
    left.policyVersion === right.policyVersion;
}

function isFaultPausablePhase(phase: PositionGuardPilotDeploymentRecord["phase"]): boolean {
  return phase === "PENDING_FLAT" || phase === "ACTIVE" || phase === "DRAINING";
}

function isRollbackCompletablePhase(
  phase: PositionGuardPilotDeploymentRecord["phase"],
): phase is "PENDING_FLAT" | "ACTIVE" | "DRAINING" {
  return phase === "PENDING_FLAT" || phase === "ACTIVE" || phase === "DRAINING";
}

function sameAuditEvent(
  left: PositionGuardPilotAuditEventRecord,
  right: PositionGuardPilotAuditEventRecord,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function optionalBindingsEqual(
  left: CandidateExecutionBindingRecord | null,
  right: CandidateExecutionBindingRecord | null,
): boolean {
  if (left === null || right === null) return left === right;
  return sameBinding(left, right);
}

function optionalRecordsEqual<T extends object>(left: T | null, right: T | null): boolean {
  if (left === null || right === null) return left === right;
  return recordsEqual(left, right);
}

function compareSqliteBinaryText(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
