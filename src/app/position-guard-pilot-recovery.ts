import { createHash } from "node:crypto";

import type {
  OrderSubmissionRecoveryObservationRecord,
  PositionGuardPilotAuditEventRecord,
  PositionGuardPilotDeploymentRecord,
  PositionGuardPilotRecoveryTarget,
  PositionGuardPilotRefreshReceipt,
} from "../domain/pilot-types.js";
import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  OperatorNotificationType,
  OrderEventRecord,
  OrderRecord,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
} from "../domain/types.js";
import type { ExecutionRepository, OperatorStateStore } from "../modules/db/interfaces.js";
import {
  candidateEvidenceMaterial,
  candidatePilotRecoveryFaultReason,
  isExactCandidateStateRollbackFlat,
  validateCandidatePilotDeployment,
  type CandidateEvidenceRecord,
  type CandidatePilotRecoveryIdentity,
  type CandidatePilotRecoveryFaultReason,
  type CandidatePilotRepository,
  type PauseCandidatePilotForRecoveryFaultInput,
} from "../modules/db/pilot-interfaces.js";
import {
  EXACT_CANDIDATE_QUANTITY_TOLERANCE,
  addExactDecimals,
  compareExactDecimals,
  createExactEmptyCandidateState,
  parseCanonicalNonNegativeDecimal,
  parseCandidateEvidenceTimestamp,
  projectExactCandidateState,
  type ExactCandidateState,
  type ExactDecimal,
} from "../modules/execution/candidate-evidence-decimals.js";
import { DurableTelegramReporter } from "../modules/telegram/reporter.js";
import type { OperatorNotificationDeliveryService } from "../modules/telegram/delivery.js";

export interface PositionGuardPilotRecoveryClock {
  now(): { occurredAt: string; occurredAtEpochMs: number };
}

export type PositionGuardPilotRecoveryResult =
  | Readonly<{
      status: "READY";
      verificationOnly: true;
      deployment: Readonly<PositionGuardPilotDeploymentRecord>;
      phase: "PENDING_FLAT" | "ACTIVE";
      activation: Readonly<{
        activationAt: string;
        activationEpochNs: bigint;
      }> | null;
      state: Readonly<ExactCandidateState>;
      stateVersion: number;
      refreshProvenance: Readonly<PositionGuardPilotRefreshReceipt>;
    }>
  | Readonly<{
      status: "BLOCKED_FAULT";
      reasonCode: CandidatePilotRecoveryFaultReason;
      faultId: string;
      executableAuthority: false;
    }>;

export type PositionGuardPilotRollbackResult =
  | Readonly<{
      status: "DRAINING" | "DISABLED";
      deployment: Readonly<PositionGuardPilotDeploymentRecord>;
      state: Readonly<ExactCandidateState>;
      stateVersion: number;
      executableAuthority: false;
    }>
  | Extract<PositionGuardPilotRecoveryResult, { status: "BLOCKED_FAULT" }>;

type RecoveryExecutionReads = Pick<
  ExecutionRepository,
  | "getLatestBalanceSnapshot"
  | "getLatestPositionSnapshot"
  | "listReconciliationRuns"
  | "listOrders"
  | "listOrderEvents"
  | "listOrderSubmissionRecoveryObservations"
  | "saveOperatorNotification"
  | "listOperatorNotifications"
>;

type RecoveryCandidateRepository = Pick<
  CandidatePilotRepository,
  | "getDeployment"
  | "findDeploymentsForRecoveryIdentity"
  | "getExactState"
  | "listEvidenceRecords"
  | "listAuditEvents"
  | "activateDeployment"
  | "startRollback"
  | "completeRollback"
  | "pauseForRecoveryFault"
>;

type RecoveryOperatorState = Pick<OperatorStateStore, "pauseForFault"> &
  Required<Pick<OperatorStateStore, "getTransitionById">> &
  Partial<Pick<OperatorStateStore, "getState" | "pause">>;

interface RecoveryReadback {
  resolvedDeploymentId: string | null;
  identityMatchCount: 0 | 1 | 2 | null;
  balanceSnapshot: BalanceSnapshotRecord | null;
  positionSnapshot: PositionSnapshotRecord | null;
  reconciliationRun: ReconciliationRunRecord | null;
  orders: OrderRecord[];
  deployment: PositionGuardPilotDeploymentRecord | null;
  state: Readonly<ExactCandidateState> | null;
  evidenceRecords: Array<Readonly<CandidateEvidenceRecord>>;
  auditEvents: PositionGuardPilotAuditEventRecord[];
  orderEvents: Map<string, OrderEventRecord[]>;
  orderRecoveryObservations: Map<string, OrderSubmissionRecoveryObservationRecord[]>;
}

interface PositionGuardPilotRecoveryDependencies extends CandidatePilotRecoveryIdentity {
  target: PositionGuardPilotRecoveryTarget;
  freshnessThresholdMs: number;
  minimumAbsenceObservations: number;
  minimumAbsenceElapsedMs: number;
  clock: PositionGuardPilotRecoveryClock;
  repositories: RecoveryExecutionReads;
  candidatePilots: RecoveryCandidateRepository;
  operatorState: RecoveryOperatorState;
  notificationDelivery?: Pick<OperatorNotificationDeliveryService, "kick"> | null;
}

interface RecoveryFault extends Error {
  reasonCode: CandidatePilotRecoveryFaultReason;
}

interface RollbackControlError extends Error {
  rollbackControlError: true;
}

interface NotificationPersistenceError extends Error {
  notificationPersistenceError: true;
}

interface PersistenceReadFault extends Error {
  persistenceReadOperation: string;
  persistenceReadStage: PersistenceReadStage;
  persistenceReadPauseAuthority: PersistenceReadPauseAuthority;
  persistenceReadFailureClass: string;
}

type PersistenceReadStage =
  | "INITIAL_DEPLOYMENT_READ"
  | "INITIAL_AUTHORITY_READ"
  | "POST_ACTIVATION_AUDIT_READ"
  | "STABLE_AUTHORITY_REREAD"
  | "EXISTING_FAULT_TRANSITION_READ";

type PersistenceReadPauseAuthority = "GLOBAL_ONLY" | "PILOT_AND_GLOBAL_ATOMIC";

interface PersistenceReadContext {
  operation: string;
  stage: PersistenceReadStage;
  pauseAuthority: PersistenceReadPauseAuthority;
}

const REVIEWED_NON_BLOCKING_RECONCILIATION_CODES = new Set([
  "ORDER_STATUS_RECONCILED",
  "ORDER_FILLS_BACKFILLED",
  "TERMINAL_ORDER_RECHECKED",
  "ORDER_IDENTIFIER_RECOVERED",
  "ORDER_SUBMISSION_ABSENCE_CONFIRMED",
  "EXCHANGE_ORDER_RECOVERED",
  "DRY_RUN_ORDER_REPAIRED",
]);

const RECONCILIATION_SOURCES = new Set([
  "DIRECT_RUN",
  "OPERATOR_SYNC",
  "STARTUP_RECOVERY",
  "SCHEDULER_PREFLIGHT",
]);

const RECONCILIATION_ISSUE_CODES = new Set([
  "OPEN_ORDER_NEEDS_REVIEW",
  "ORDER_MARKED_FOR_RECOVERY",
  "ORDER_STATUS_RECONCILED",
  "ORDER_FILLS_BACKFILLED",
  "BALANCE_DRIFT_DETECTED",
  "POSITION_DRIFT_DETECTED",
  "TERMINAL_ORDER_RECHECKED",
  "ORDER_REFERENCE_MISSING",
  "ORDER_LOOKUP_TRANSIENT_FAILURE",
  "ORDER_LOOKUP_DEFERRED",
  "ORDER_IDENTIFIER_RECOVERY_UNCERTAIN",
  "ORDER_IDENTIFIER_RECOVERED",
  "ORDER_SUBMISSION_ABSENCE_CONFIRMED",
  "CANDIDATE_EVIDENCE_PROJECTION_FAILED",
  "CANDIDATE_EVIDENCE_PROJECTION_DEFERRED",
  "EXCHANGE_ORDER_RECOVERED",
  "ORDER_HISTORY_LOOKUP_FAILED",
  "DRY_RUN_ORDER_REPAIRED",
]);

const RECOVERY_FAULT_REASONS = new Set<CandidatePilotRecoveryFaultReason>([
  "SNAPSHOT_PROVENANCE_INVALID",
  "STALE_SNAPSHOT",
  "IDENTITY_MISMATCH",
  "REPLAY_MISMATCH",
  "INVENTORY_MISMATCH",
  "BLOCKING_RECONCILIATION",
  "ACTIVE_ORDER",
  "UNCERTAIN_ORDER",
  "ACTIVATION_CAS_CONFLICT",
]);

const EXACT_STATE_KEYS = [
  "currentEpisodeAddCount",
  "currentEpisodeCostBasisKrw",
  "currentEpisodeInventoryQuantity",
  "currentEpisodeRealizedPnlKrw",
  "lastFullExitAt",
  "lastFullExitRealizedPnlKrw",
  "lastEntryPath",
  "lastEvidenceAt",
  "lastEvidenceId",
  "stateVersion",
] as const;

const RECOVERY_DEPENDENCY_KEYS = [
  "exchangeAccountId",
  "target",
  "pilotId",
  "market",
  "policyId",
  "policyVersion",
  "freshnessThresholdMs",
  "minimumAbsenceObservations",
  "minimumAbsenceElapsedMs",
  "clock",
  "repositories",
  "candidatePilots",
  "operatorState",
  "notificationDelivery",
] as const;

const RECOVERY_DEPENDENCY_KEYS_WITHOUT_DELIVERY = RECOVERY_DEPENDENCY_KEYS.filter(
  (key) => key !== "notificationDelivery",
);

const QUANTITY_TOLERANCE = parseCanonicalNonNegativeDecimal(
  EXACT_CANDIDATE_QUANTITY_TOLERANCE,
  "candidate recovery quantity tolerance",
);

export class PositionGuardPilotRecovery {
  private readonly dependencies: Readonly<PositionGuardPilotRecoveryDependencies>;

  constructor(dependencies: PositionGuardPilotRecoveryDependencies) {
    this.dependencies = snapshotRecoveryDependencies(dependencies);
  }

  async verifyAndPrepareBtcRun(
    refreshReceipt: PositionGuardPilotRefreshReceipt,
  ): Promise<PositionGuardPilotRecoveryResult> {
    const clock = this.readClock();
    const receipt = snapshotReceipt(refreshReceipt);
    const readback = emptyRecoveryReadback();

    try {
      await this.readPersistedAccountEvidence(readback, "INITIAL_AUTHORITY_READ", null);
      if (!hasEstablishedDeploymentIdentity(readback, this.dependencies)) {
        return this.blockForFault("IDENTITY_MISMATCH", receipt, readback, clock);
      }
      await this.readCandidateAuthority(readback, "INITIAL_AUTHORITY_READ");

      const existingFault = await this.readExistingPersistedFault(readback);
      if (existingFault) {
        await this.reportFaultNotification(existingFault, readback, clock.occurredAt);
        return existingFault;
      }

      const verified = this.verifyReadyAuthority(readback, receipt, clock.epochNanoseconds);

      if (readback.deployment.phase === "PENDING_FLAT") {
        if (!withinTolerance(verified.inventory.balanceQuantity, zeroDecimal())) {
          return await this.confirmStableReady(readback, receipt, clock);
        }
        const activated = await this.activatePendingFlat(readback, verified.state, receipt, clock);
        await this.reportActivationNotification(activated);
        return activated;
      }
      const ready = await this.confirmStableReady(readback, receipt, clock);
      await this.reportActivationNotification(ready);
      return ready;
    } catch (error) {
      if (isNotificationPersistenceError(error)) throw error;
      if (isPersistenceReadFault(error)) {
        return this.blockForReadFailure(error, receipt, readback, clock);
      }
      const fault = asRecoveryFault(error);
      return this.blockForFault(fault.reasonCode, receipt, readback, clock);
    }
  }

  async requestRollback(
    refreshReceipt: PositionGuardPilotRefreshReceipt,
  ): Promise<PositionGuardPilotRollbackResult> {
    return this.transitionRollback(refreshReceipt, "REQUEST");
  }

  async completeRollback(
    refreshReceipt: PositionGuardPilotRefreshReceipt,
  ): Promise<PositionGuardPilotRollbackResult> {
    return this.transitionRollback(refreshReceipt, "COMPLETE");
  }

  private async transitionRollback(
    refreshReceipt: PositionGuardPilotRefreshReceipt,
    operation: "REQUEST" | "COMPLETE",
  ): Promise<PositionGuardPilotRollbackResult> {
    const clock = this.readClock();
    const receipt = snapshotReceipt(refreshReceipt);
    const readback = emptyRecoveryReadback();

    await this.ensureGlobalRollbackPause();

    try {
      await this.readPersistedAccountEvidence(readback, "INITIAL_AUTHORITY_READ", null);
      if (!hasEstablishedDeploymentIdentity(readback, this.dependencies)) {
        return this.blockForFault("IDENTITY_MISMATCH", receipt, readback, clock);
      }
      await this.readCandidateAuthority(readback, "INITIAL_AUTHORITY_READ");

      const existingFault = await this.readExistingPersistedFault(readback);
      if (existingFault) {
        await this.reportFaultNotification(existingFault, readback, clock.occurredAt);
        return existingFault;
      }

      const verified = this.verifyRollbackAuthority(readback, receipt, clock.epochNanoseconds);
      const deployment = readback.deployment;
      if (!deployment) {
        throw recoveryFault("IDENTITY_MISMATCH", "Configured candidate deployment is missing.");
      }

      if (deployment.phase === "DISABLED") {
        await this.reportRollbackNotification("POSITION_GUARD_PILOT_ROLLBACK_COMPLETED", deployment, {
          occurredAt: deployment.updatedAt,
          epochNanoseconds: parseTimestamp(
            deployment.updatedAt,
            "candidate rollback completedAt",
            "IDENTITY_MISMATCH",
          ),
        });
        return rollbackResult("DISABLED", deployment, verified.state);
      }

      if (operation === "COMPLETE" && deployment.phase !== "DRAINING") {
        throw rollbackControlError("completeRollback requires an existing DRAINING deployment.");
      }
      if (operation === "COMPLETE" && !isExactCandidateStateRollbackFlat(verified.state)) {
        throw rollbackControlError("completeRollback requires exact-flat DRAINING authority.");
      }

      if (isExactCandidateStateRollbackFlat(verified.state)) {
        const expectedOperatorState = rollbackOperatorState(await this.assertGlobalRollbackPause());
        const disabled = await this.dependencies.candidatePilots.completeRollback({
          deploymentId: deployment.id,
          expectedPhase: deployment.phase,
          expectedUpdatedAt: deployment.updatedAt,
          expectedStateVersion: verified.state.stateVersion,
          expectedOperatorState,
          transitionAt: clock.occurredAt,
          transitionEpochNs: clock.epochNanoseconds,
        });
        if (!disabled) {
          throw rollbackControlError("Candidate rollback global pause authority changed before rollback persistence.");
        }
        await this.reportRollbackNotification("POSITION_GUARD_PILOT_ROLLBACK_COMPLETED", disabled, clock);
        return rollbackResult("DISABLED", disabled, verified.state);
      }

      if (deployment.phase === "DRAINING") {
        await this.reportRollbackNotification("POSITION_GUARD_PILOT_ROLLBACK_STARTED", deployment, {
          occurredAt: deployment.updatedAt,
          epochNanoseconds: parseTimestamp(
            deployment.updatedAt,
            "candidate rollback transitionAt",
            "IDENTITY_MISMATCH",
          ),
        });
        return rollbackResult("DRAINING", deployment, verified.state);
      }
      if (deployment.phase !== "ACTIVE") {
        throw recoveryFault("REPLAY_MISMATCH", `Candidate phase ${deployment.phase} cannot begin rollback.`);
      }

      const expectedOperatorState = rollbackOperatorState(await this.assertGlobalRollbackPause());
      const draining = await this.dependencies.candidatePilots.startRollback({
        deploymentId: deployment.id,
        expectedPhase: "ACTIVE",
        expectedUpdatedAt: deployment.updatedAt,
        expectedStateVersion: verified.state.stateVersion,
        expectedOperatorState,
        transitionAt: clock.occurredAt,
        transitionEpochNs: clock.epochNanoseconds,
      });
      if (!draining) {
        throw rollbackControlError("Candidate rollback global pause authority changed before rollback persistence.");
      }
      await this.reportRollbackNotification("POSITION_GUARD_PILOT_ROLLBACK_STARTED", draining, clock);
      return rollbackResult("DRAINING", draining, verified.state);
    } catch (error) {
      if (isRollbackControlError(error) || isNotificationPersistenceError(error)) throw error;
      if (isPersistenceReadFault(error)) {
        return this.blockForReadFailure(error, receipt, readback, clock);
      }
      const fault = asRecoveryFault(error);
      return this.blockForFault(fault.reasonCode, receipt, readback, clock);
    }
  }

  private async ensureGlobalRollbackPause(): Promise<void> {
    const getState = this.dependencies.operatorState.getState;
    const pause = this.dependencies.operatorState.pause;
    if (!getState || !pause) {
      throw new Error("Candidate rollback requires global operator pause authority.");
    }
    const current = await getState.call(this.dependencies.operatorState);
    if (current.systemStatus === "PAUSED" || current.systemStatus === "KILL_SWITCHED") return;

    const paused = await pause.call(
      this.dependencies.operatorState,
      "position_guard_pilot_rollback_requested",
    );
    if (paused.systemStatus !== "PAUSED" && paused.systemStatus !== "KILL_SWITCHED") {
      throw new Error("Candidate rollback could not establish a global execution pause.");
    }
  }

  private async assertGlobalRollbackPause(): Promise<ExecutionStateRecord> {
    const getState = this.dependencies.operatorState.getState;
    if (!getState) {
      throw recoveryFault("IDENTITY_MISMATCH", "Candidate rollback lost global pause read authority.");
    }
    const state = await getState.call(this.dependencies.operatorState);
    if (state.systemStatus !== "PAUSED" && state.systemStatus !== "KILL_SWITCHED") {
      throw recoveryFault("IDENTITY_MISMATCH", "Candidate rollback global pause changed before persistence.");
    }
    return state;
  }

  private verifyRollbackAuthority(
    readback: RecoveryReadback,
    receipt: Readonly<PositionGuardPilotRefreshReceipt>,
    nowEpochNanoseconds: bigint,
  ): {
    state: Readonly<ExactCandidateState>;
    inventory: { balanceQuantity: ExactDecimal; positionQuantity: ExactDecimal };
  } {
    if (!hasEstablishedDeploymentIdentity(readback, this.dependencies)) {
      throw recoveryFault("IDENTITY_MISMATCH", "Configured candidate deployment is missing.");
    }
    this.verifyDeploymentIdentity(readback, nowEpochNanoseconds);
    this.verifyRefreshCorrelation(receipt, readback, nowEpochNanoseconds);
    this.verifyReconciliation(receipt, readback.reconciliationRun, nowEpochNanoseconds);
    this.verifyAuditAuthority(readback.deployment, readback.auditEvents, nowEpochNanoseconds);
    this.verifyOrders(readback, nowEpochNanoseconds);
    const state = this.verifyEvidenceAndState(readback, nowEpochNanoseconds);
    const inventory = this.readInventory(readback.balanceSnapshot, readback.positionSnapshot);
    this.verifyExchangeInventoryAgreement(inventory.balanceQuantity, inventory.positionQuantity);

    switch (readback.deployment.phase) {
      case "PENDING_FLAT":
        this.verifyPendingFlatState(state, readback.evidenceRecords);
        break;
      case "ACTIVE":
        this.verifyActiveChronology(
          readback.deployment,
          readback.evidenceRecords,
          readback.auditEvents,
          state,
          nowEpochNanoseconds,
        );
        this.verifyReplayInventoryAgreement(
          state.currentEpisodeInventoryQuantity,
          inventory.balanceQuantity,
          inventory.positionQuantity,
        );
        break;
      case "DRAINING":
        this.verifyDrainingChronology(readback.deployment, readback.evidenceRecords, readback.auditEvents, state);
        this.verifyReplayInventoryAgreement(
          state.currentEpisodeInventoryQuantity,
          inventory.balanceQuantity,
          inventory.positionQuantity,
        );
        break;
      case "DISABLED":
        this.verifyDisabledRollback(readback.deployment, readback.auditEvents, state);
        this.verifyReplayInventoryAgreement(
          state.currentEpisodeInventoryQuantity,
          inventory.balanceQuantity,
          inventory.positionQuantity,
        );
        break;
      default:
        throw recoveryFault(
          "IDENTITY_MISMATCH",
          `Candidate phase ${readback.deployment.phase} is not rollback-authoritative.`,
        );
    }
    return { state, inventory };
  }

  private verifyDrainingChronology(
    deployment: PositionGuardPilotDeploymentRecord,
    evidenceRecords: Array<Readonly<CandidateEvidenceRecord>>,
    auditEvents: PositionGuardPilotAuditEventRecord[],
    state: Readonly<ExactCandidateState>,
  ): void {
    if (deployment.activationAt === null || deployment.activationEpochNs === null) {
      throw recoveryFault("IDENTITY_MISMATCH", "DRAINING deployment has no persisted activation instant.");
    }
    const rollbackEvents = auditEvents.filter((event) => event.eventType === "ROLLBACK_STARTED");
    const completedEvents = auditEvents.filter((event) => event.eventType === "ROLLBACK_COMPLETED");
    if (rollbackEvents.length !== 1 || completedEvents.length !== 0) {
      throw recoveryFault("IDENTITY_MISMATCH", "DRAINING requires one rollback-start audit and no completion.");
    }
    const rollback = rollbackEvents[0]!;
    const rollbackAt = parseTimestamp(rollback.createdAt, "rollback startedAt", "IDENTITY_MISMATCH");
    if (
      rollback.id !== `${deployment.id}:rollback_started:${rollbackAt.toString()}` ||
      rollback.deploymentId !== deployment.id ||
      rollback.eventType !== "ROLLBACK_STARTED" ||
      rollback.fromPhase !== "ACTIVE" ||
      rollback.toPhase !== "DRAINING" ||
      rollback.createdAt !== deployment.updatedAt ||
      !Number.isSafeInteger(rollback.stateVersion) ||
      rollback.stateVersion < 0 ||
      rollback.stateVersion > evidenceRecords.length
    ) {
      throw recoveryFault("IDENTITY_MISMATCH", "DRAINING rollback-start audit is invalid.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rollback.payloadJson) as unknown;
    } catch {
      throw recoveryFault("IDENTITY_MISMATCH", "DRAINING rollback-start payload is malformed.");
    }
    if (!isPlainRecord(payload) || !hasExactOwnKeys(payload, ["transitionAt"]) ||
      payload.transitionAt !== rollback.createdAt) {
      throw recoveryFault("IDENTITY_MISMATCH", "DRAINING rollback-start payload is invalid.");
    }

    const stateEvents = auditEvents.filter((event) => event.eventType === "STATE_ADVANCED");
    if (stateEvents.length !== evidenceRecords.length || state.stateVersion !== evidenceRecords.length) {
      throw recoveryFault("REPLAY_MISMATCH", "DRAINING evidence and audit counts do not match.");
    }
    for (const [index, record] of evidenceRecords.entries()) {
      const phase = index < rollback.stateVersion ? "ACTIVE" : "DRAINING";
      if (phase === "DRAINING" && record.evidence.action !== "REDUCE" && record.evidence.action !== "EXIT") {
        throw recoveryFault("REPLAY_MISMATCH", "DRAINING evidence must be REDUCE or EXIT.");
      }
      const event = stateEvents[index];
      if (!event || event.id !== `${deployment.id}:evidence:${record.evidence.evidenceId}` ||
        event.fromPhase !== phase || event.toPhase !== phase || event.stateVersion !== index + 1 ||
        event.createdAt !== record.evidence.executedAt) {
        throw recoveryFault("REPLAY_MISMATCH", "DRAINING evidence audit chain is invalid.");
      }
      const evidenceAt = parseTimestamp(record.evidence.executedAt, "candidate evidence executedAt", "REPLAY_MISMATCH");
      if ((index < rollback.stateVersion && evidenceAt > rollbackAt) ||
        (index >= rollback.stateVersion && evidenceAt < rollbackAt)) {
        throw recoveryFault("REPLAY_MISMATCH", "DRAINING evidence crosses the rollback boundary.");
      }
    }
  }

  private verifyDisabledRollback(
    deployment: PositionGuardPilotDeploymentRecord,
    auditEvents: PositionGuardPilotAuditEventRecord[],
    state: Readonly<ExactCandidateState>,
  ): void {
    if (!isExactCandidateStateRollbackFlat(state)) {
      throw recoveryFault("REPLAY_MISMATCH", "DISABLED rollback authority must be exactly flat.");
    }
    const completions = auditEvents.filter((event) => event.eventType === "ROLLBACK_COMPLETED");
    if (completions.length !== 1) {
      throw recoveryFault("IDENTITY_MISMATCH", "DISABLED rollback authority requires one completion audit.");
    }
    const completion = completions[0]!;
    const completedAt = parseTimestamp(completion.createdAt, "rollback completedAt", "IDENTITY_MISMATCH");
    if (
      completion.id !== `${deployment.id}:rollback_completed:${completedAt.toString()}` ||
      completion.deploymentId !== deployment.id ||
      completion.toPhase !== "DISABLED" ||
      completion.createdAt !== deployment.updatedAt ||
      completion.stateVersion !== state.stateVersion ||
      (completion.fromPhase !== "PENDING_FLAT" &&
        completion.fromPhase !== "ACTIVE" &&
        completion.fromPhase !== "DRAINING")
    ) {
      throw recoveryFault("IDENTITY_MISMATCH", "DISABLED rollback completion audit is invalid.");
    }
  }

  private async readPersistedAccountEvidence(
    readback: RecoveryReadback,
    stage: "INITIAL_AUTHORITY_READ" | "STABLE_AUTHORITY_REREAD",
    pinnedDeploymentId: string | null,
  ): Promise<RecoveryReadback> {
    await this.resolveDeployment(readback, stage, pinnedDeploymentId);
    if (!hasEstablishedDeploymentIdentity(readback, this.dependencies)) return readback;
    const pauseAuthority = stage === "STABLE_AUTHORITY_REREAD" ||
        hasEstablishedDeploymentIdentity(readback, this.dependencies)
      ? "PILOT_AND_GLOBAL_ATOMIC"
      : "GLOBAL_ONLY";
    readback.balanceSnapshot = await this.readPersistence(
      {
        operation: "repositories.getLatestBalanceSnapshot",
        stage,
        pauseAuthority,
      },
      () => this.dependencies.repositories.getLatestBalanceSnapshot(this.dependencies.exchangeAccountId),
    );
    readback.positionSnapshot = await this.readPersistence(
      {
        operation: "repositories.getLatestPositionSnapshot",
        stage,
        pauseAuthority,
      },
      () => this.dependencies.repositories.getLatestPositionSnapshot(this.dependencies.exchangeAccountId),
    );
    const reconciliationRuns = await this.readPersistence(
      {
        operation: "repositories.listReconciliationRuns",
        stage,
        pauseAuthority,
      },
      () => this.dependencies.repositories.listReconciliationRuns(this.dependencies.exchangeAccountId, 1),
    );
    readback.reconciliationRun = reconciliationRuns[0] ?? null;
    readback.orders = await this.readPersistence(
      { operation: "repositories.listOrders", stage, pauseAuthority },
      () => this.dependencies.repositories.listOrders(this.dependencies.exchangeAccountId),
    );
    for (const order of readback.orders) {
      const events = await this.readPersistence(
        { operation: "repositories.listOrderEvents", stage, pauseAuthority },
        () => this.dependencies.repositories.listOrderEvents(order.id),
      );
      readback.orderEvents.set(order.id, events);
      const listObservations = this.dependencies.repositories.listOrderSubmissionRecoveryObservations;
      const observations = listObservations
        ? await this.readPersistence(
            {
              operation: "repositories.listOrderSubmissionRecoveryObservations",
              stage,
              pauseAuthority,
            },
            () => listObservations.call(this.dependencies.repositories, order.id),
          )
        : [];
      readback.orderRecoveryObservations.set(order.id, observations);
    }
    return readback;
  }

  private async resolveDeployment(
    readback: RecoveryReadback,
    stage: "INITIAL_AUTHORITY_READ" | "STABLE_AUTHORITY_REREAD",
    pinnedDeploymentId: string | null,
  ): Promise<void> {
    if (stage === "STABLE_AUTHORITY_REREAD") {
      if (pinnedDeploymentId === null) {
        throw recoveryFault("IDENTITY_MISMATCH", "Candidate deployment identity was not resolved before reread.");
      }
      const deployment = await this.readPersistence(
        {
          operation: "candidatePilots.getDeployment",
          stage,
          pauseAuthority: "PILOT_AND_GLOBAL_ATOMIC",
        },
        () => this.dependencies.candidatePilots.getDeployment(pinnedDeploymentId),
      );
      readback.identityMatchCount = deployment ? 1 : 0;
      if (!deployment) return;
      readback.deployment = snapshotDeployment(deployment);
      if (deploymentMatchesConfiguredIdentity(readback.deployment, this.dependencies) &&
          readback.deployment.id === pinnedDeploymentId) {
        readback.resolvedDeploymentId = pinnedDeploymentId;
      }
      return;
    }

    const target = this.dependencies.target;
    if (target.kind === "EXACT_DEPLOYMENT") {
      const deployment = await this.readPersistence(
        {
          operation: "candidatePilots.getDeployment",
          stage: "INITIAL_DEPLOYMENT_READ",
          pauseAuthority: "GLOBAL_ONLY",
        },
        () => this.dependencies.candidatePilots.getDeployment(target.deploymentId),
      );
      readback.identityMatchCount = deployment ? 1 : 0;
      if (!deployment) return;
      readback.deployment = snapshotDeployment(deployment);
      if (deploymentMatchesConfiguredIdentity(readback.deployment, this.dependencies) &&
          readback.deployment.id === target.deploymentId) {
        readback.resolvedDeploymentId = readback.deployment.id;
      }
      return;
    }

    const matches = await this.readPersistence(
      {
        operation: "candidatePilots.findDeploymentsForRecoveryIdentity",
        stage: "INITIAL_DEPLOYMENT_READ",
        pauseAuthority: "GLOBAL_ONLY",
      },
      () => this.dependencies.candidatePilots.findDeploymentsForRecoveryIdentity({
        exchangeAccountId: this.dependencies.exchangeAccountId,
        pilotId: this.dependencies.pilotId,
        market: this.dependencies.market,
        policyId: this.dependencies.policyId,
        policyVersion: this.dependencies.policyVersion,
      }),
    );
    readback.identityMatchCount = matches.length === 0 ? 0 : matches.length === 1 ? 1 : 2;
    if (matches.length !== 1) return;
    readback.deployment = snapshotDeployment(matches[0]!);
    if (deploymentMatchesConfiguredIdentity(readback.deployment, this.dependencies)) {
      readback.resolvedDeploymentId = readback.deployment.id;
    }
  }

  private async readCandidateAuthority(
    readback: RecoveryReadback,
    stage: "INITIAL_AUTHORITY_READ" | "STABLE_AUTHORITY_REREAD",
  ): Promise<void> {
    const deploymentId = requireResolvedDeploymentId(readback);
    readback.state = await this.readPersistence(
      { operation: "candidatePilots.getExactState", stage, pauseAuthority: "PILOT_AND_GLOBAL_ATOMIC" },
      () => this.dependencies.candidatePilots.getExactState(deploymentId),
    );
    readback.evidenceRecords = await this.readPersistence(
      { operation: "candidatePilots.listEvidenceRecords", stage, pauseAuthority: "PILOT_AND_GLOBAL_ATOMIC" },
      () => this.dependencies.candidatePilots.listEvidenceRecords(deploymentId),
    );
    readback.auditEvents = await this.readPersistence(
      { operation: "candidatePilots.listAuditEvents", stage, pauseAuthority: "PILOT_AND_GLOBAL_ATOMIC" },
      () => this.dependencies.candidatePilots.listAuditEvents(deploymentId),
    );
  }

  private async readPersistence<T>(context: PersistenceReadContext, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      throw persistenceReadFault(context, error);
    }
  }

  private verifyReadyAuthority(
    readback: RecoveryReadback,
    receipt: Readonly<PositionGuardPilotRefreshReceipt>,
    nowEpochNanoseconds: bigint,
  ): {
    state: Readonly<ExactCandidateState>;
    inventory: { balanceQuantity: ExactDecimal; positionQuantity: ExactDecimal };
  } {
    if (!hasEstablishedDeploymentIdentity(readback, this.dependencies)) {
      throw recoveryFault("IDENTITY_MISMATCH", "Configured candidate deployment is missing.");
    }
    this.verifyDeploymentIdentity(readback, nowEpochNanoseconds);
    this.verifyRefreshCorrelation(receipt, readback, nowEpochNanoseconds);
    this.verifyReconciliation(receipt, readback.reconciliationRun, nowEpochNanoseconds);
    this.verifyAuditAuthority(readback.deployment, readback.auditEvents, nowEpochNanoseconds);
    this.verifyOrders(readback, nowEpochNanoseconds);
    const state = this.verifyEvidenceAndState(readback, nowEpochNanoseconds);
    const inventory = this.readInventory(readback.balanceSnapshot, readback.positionSnapshot);
    this.verifyExchangeInventoryAgreement(inventory.balanceQuantity, inventory.positionQuantity);

    if (readback.deployment.phase === "PENDING_FLAT") {
      this.verifyPendingFlatState(state, readback.evidenceRecords);
    } else if (readback.deployment.phase === "ACTIVE") {
      this.verifyActiveChronology(
        readback.deployment,
        readback.evidenceRecords,
        readback.auditEvents,
        state,
        nowEpochNanoseconds,
      );
      this.verifyReplayInventoryAgreement(
        state.currentEpisodeInventoryQuantity,
        inventory.balanceQuantity,
        inventory.positionQuantity,
      );
    } else {
      throw recoveryFault("IDENTITY_MISMATCH", `Candidate phase ${readback.deployment.phase} is not recoverable.`);
    }
    return { state, inventory };
  }

  private verifyDeploymentIdentity(
    readback: RecoveryReadback & { deployment: PositionGuardPilotDeploymentRecord },
    nowEpochNanoseconds: bigint,
  ): void {
    const deployment = readback.deployment;
    if (
      deployment.id !== readback.resolvedDeploymentId ||
      deployment.exchangeAccountId !== this.dependencies.exchangeAccountId ||
      deployment.pilotId !== this.dependencies.pilotId ||
      deployment.market !== this.dependencies.market ||
      deployment.policyId !== this.dependencies.policyId ||
      deployment.policyVersion !== this.dependencies.policyVersion
    ) {
      throw recoveryFault("IDENTITY_MISMATCH", "Persisted candidate deployment identity does not match policy.");
    }
    const createdAt = parseTimestamp(deployment.createdAt, "deployment createdAt", "IDENTITY_MISMATCH");
    const updatedAt = parseTimestamp(deployment.updatedAt, "deployment updatedAt", "IDENTITY_MISMATCH");
    if (updatedAt < createdAt || createdAt > nowEpochNanoseconds || updatedAt > nowEpochNanoseconds) {
      throw recoveryFault("IDENTITY_MISMATCH", "Candidate deployment chronology is invalid.");
    }
    if ((deployment.activationAt === null) !== (deployment.activationEpochNs === null)) {
      throw recoveryFault("IDENTITY_MISMATCH", "Candidate deployment activation identity is incomplete.");
    }
    if (deployment.activationAt !== null && deployment.activationEpochNs !== null) {
      const activationAt = parseTimestamp(deployment.activationAt, "deployment activationAt", "IDENTITY_MISMATCH");
      if (
        activationAt !== deployment.activationEpochNs ||
        activationAt < createdAt ||
        activationAt > updatedAt ||
        activationAt > nowEpochNanoseconds
      ) {
        throw recoveryFault("IDENTITY_MISMATCH", "Candidate deployment activation chronology is invalid.");
      }
    }
  }

  private verifyRefreshCorrelation(
    receipt: Readonly<PositionGuardPilotRefreshReceipt>,
    readback: RecoveryReadback,
    nowEpochNanoseconds: bigint,
  ): void {
    const balance = readback.balanceSnapshot;
    const position = readback.positionSnapshot;
    const reconciliation = readback.reconciliationRun;
    if (!balance || !position || !reconciliation || reconciliation.completedAt === null) {
      throw recoveryFault("SNAPSHOT_PROVENANCE_INVALID", "Persisted refresh evidence is incomplete.");
    }
    if (
      receipt.exchangeAccountId !== this.dependencies.exchangeAccountId ||
      balance.exchangeAccountId !== this.dependencies.exchangeAccountId ||
      position.exchangeAccountId !== this.dependencies.exchangeAccountId ||
      reconciliation.exchangeAccountId !== this.dependencies.exchangeAccountId ||
      balance.id !== receipt.balanceSnapshotId ||
      balance.capturedAt !== receipt.balanceCapturedAt ||
      position.id !== receipt.positionSnapshotId ||
      position.capturedAt !== receipt.positionCapturedAt ||
      reconciliation.id !== receipt.reconciliationRunId ||
      reconciliation.startedAt !== receipt.reconciliationStartedAt ||
      reconciliation.completedAt !== receipt.reconciliationCompletedAt ||
      balance.source !== "RECONCILIATION" ||
      position.source !== "RECONCILIATION"
    ) {
      throw recoveryFault("SNAPSHOT_PROVENANCE_INVALID", "Refresh receipt does not match latest persistence.");
    }

    let requestedAt: bigint;
    let balanceAt: bigint;
    let positionAt: bigint;
    let reconciliationStartedAt: bigint;
    let reconciliationCompletedAt: bigint;
    try {
      requestedAt = parseCandidateEvidenceTimestamp(receipt.requestedAt, "refresh requestedAt");
      balanceAt = parseCandidateEvidenceTimestamp(balance.capturedAt, "balance capturedAt");
      positionAt = parseCandidateEvidenceTimestamp(position.capturedAt, "position capturedAt");
      reconciliationStartedAt = parseCandidateEvidenceTimestamp(
        reconciliation.startedAt,
        "reconciliation startedAt",
      );
      reconciliationCompletedAt = parseCandidateEvidenceTimestamp(
        reconciliation.completedAt,
        "reconciliation completedAt",
      );
    } catch (error) {
      throw recoveryFault(
        "SNAPSHOT_PROVENANCE_INVALID",
        error instanceof Error ? error.message : "Refresh timestamp is malformed.",
      );
    }
    if (
      balanceAt !== requestedAt ||
      positionAt !== requestedAt ||
      reconciliationCompletedAt < reconciliationStartedAt
    ) {
      throw recoveryFault("SNAPSHOT_PROVENANCE_INVALID", "Persisted refresh chronology is contradictory.");
    }
    for (const timestamp of [requestedAt, balanceAt, positionAt, reconciliationStartedAt, reconciliationCompletedAt]) {
      this.requireFresh(timestamp, nowEpochNanoseconds);
    }
  }

  private requireFresh(timestamp: bigint, nowEpochNanoseconds: bigint): void {
    const thresholdNanoseconds = BigInt(this.dependencies.freshnessThresholdMs) * 1_000_000n;
    if (timestamp > nowEpochNanoseconds || nowEpochNanoseconds - timestamp > thresholdNanoseconds) {
      throw recoveryFault("STALE_SNAPSHOT", "Persisted refresh evidence is future-dated or stale.");
    }
  }

  private verifyReconciliation(
    receipt: Readonly<PositionGuardPilotRefreshReceipt>,
    run: ReconciliationRunRecord | null,
    nowEpochNanoseconds: bigint,
  ): void {
    if (!run) throw recoveryFault("BLOCKING_RECONCILIATION", "Latest reconciliation is missing.");
    let summary: unknown;
    try {
      summary = JSON.parse(run.summaryJson) as unknown;
    } catch {
      throw recoveryFault("BLOCKING_RECONCILIATION", "Reconciliation summary JSON is malformed.");
    }
    if (
      !isPlainRecord(summary) ||
      !hasExactOwnKeys(
        summary,
        ["source", "status", "issues", "candidateCount", "processedCount", "deferredCount", "maxOrderLookupsPerRun"],
        ["historyRecovery"],
      ) ||
      !Array.isArray(summary.issues) ||
      typeof summary.source !== "string" ||
      !RECONCILIATION_SOURCES.has(summary.source) ||
      (summary.status !== "SUCCESS" && summary.status !== "DRIFT_DETECTED" && summary.status !== "ERROR") ||
      !isNonNegativeSafeInteger(summary.candidateCount) ||
      !isNonNegativeSafeInteger(summary.processedCount) ||
      !isNonNegativeSafeInteger(summary.deferredCount) ||
      !isNonNegativeSafeInteger(summary.maxOrderLookupsPerRun) ||
      summary.processedCount + summary.deferredCount !== summary.candidateCount ||
      summary.processedCount > summary.maxOrderLookupsPerRun ||
      (summary.historyRecovery !== undefined &&
        !isValidHistoryRecoverySummary(summary.historyRecovery, run, nowEpochNanoseconds))
    ) {
      throw recoveryFault("BLOCKING_RECONCILIATION", "Reconciliation summary shape is invalid.");
    }
    if (
      summary.source !== receipt.reconciliationSource ||
      summary.status !== run.status ||
      (summary.status !== "SUCCESS" && summary.status !== "DRIFT_DETECTED") ||
      run.status === "ERROR" ||
      run.errorMessage !== null
    ) {
      throw recoveryFault("BLOCKING_RECONCILIATION", "Reconciliation provenance or status is invalid.");
    }
    const issueCodes: string[] = [];
    for (const issue of summary.issues) {
      if (
        !isPlainRecord(issue) ||
        !hasExactOwnKeys(issue, ["code", "message"]) ||
        typeof issue.code !== "string" ||
        !RECONCILIATION_ISSUE_CODES.has(issue.code) ||
        !isNonEmptyString(issue.message)
      ) {
        throw recoveryFault("BLOCKING_RECONCILIATION", "Reconciliation issue shape is invalid.");
      }
      issueCodes.push(issue.code);
    }
    if (
      (run.status === "SUCCESS" && issueCodes.length > 0) ||
      (run.status === "DRIFT_DETECTED" && issueCodes.length === 0) ||
      issueCodes.some((code) => !REVIEWED_NON_BLOCKING_RECONCILIATION_CODES.has(code))
    ) {
      throw recoveryFault("BLOCKING_RECONCILIATION", "Reconciliation contains a blocking issue code.");
    }
  }

  private verifyAuditAuthority(
    deployment: PositionGuardPilotDeploymentRecord,
    auditEvents: PositionGuardPilotAuditEventRecord[],
    nowEpochNanoseconds: bigint,
  ): void {
    const ids = new Set<string>();
    for (const event of auditEvents) {
      const eventEpoch = parseTimestamp(event.createdAt, "pilot audit createdAt", "IDENTITY_MISMATCH");
      if (
        ids.has(event.id) ||
        event.deploymentId !== deployment.id ||
        !Number.isSafeInteger(event.stateVersion) ||
        event.stateVersion < 0 ||
        eventEpoch > nowEpochNanoseconds
      ) {
        throw recoveryFault("IDENTITY_MISMATCH", "Pilot audit chronology, version, or identity is invalid.");
      }
      ids.add(event.id);
      try {
        const payload = JSON.parse(event.payloadJson) as unknown;
        if (!isPlainRecord(payload)) throw new Error("Pilot audit payload must be an object.");
      } catch (error) {
        throw recoveryFault(
          "IDENTITY_MISMATCH",
          error instanceof Error ? error.message : "Pilot audit payload JSON is malformed.",
        );
      }
    }
  }

  private verifyOrders(readback: RecoveryReadback, nowEpochNanoseconds: bigint): void {
    const orderIds = new Set<string>();
    for (const order of readback.orders) {
      const events = readback.orderEvents.get(order.id) ?? [];
      const observations = readback.orderRecoveryObservations.get(order.id) ?? [];
      this.verifyOrderChronology(order, events, nowEpochNanoseconds);
      verifyRecoveryObservations(order, observations, nowEpochNanoseconds);
      if (orderIds.has(order.id) || order.exchangeAccountId !== this.dependencies.exchangeAccountId) {
        throw recoveryFault("UNCERTAIN_ORDER", "Account-wide order read returned duplicate or mismatched provenance.");
      }
      orderIds.add(order.id);
      switch (order.status) {
        case "INTENT_CREATED":
        case "PERSISTED":
        case "SUBMITTING":
        case "OPEN":
        case "PARTIALLY_FILLED":
        case "CANCEL_REQUESTED":
          throw recoveryFault("ACTIVE_ORDER", `Order ${order.id} remains nonterminal.`);
        case "RECONCILIATION_REQUIRED":
          throw recoveryFault("UNCERTAIN_ORDER", "An order requires reconciliation.");
        case "FAILED":
        case "REJECTED":
          if (!isDefinitivelyAbsentOrder(
            order,
            events,
            observations,
            nowEpochNanoseconds,
            {
              minimumNotFoundObservations: this.dependencies.minimumAbsenceObservations,
              minimumElapsedMs: this.dependencies.minimumAbsenceElapsedMs,
            },
          )) {
            throw recoveryFault("UNCERTAIN_ORDER", `Order ${order.id} lacks definitive no-order evidence.`);
          }
          break;
        case "RISK_REJECTED":
        case "FILLED":
        case "CANCELED":
          break;
        default:
          throw recoveryFault("UNCERTAIN_ORDER", `Order ${order.id} has an unknown persisted lifecycle status.`);
      }
    }
  }

  private verifyOrderChronology(
    order: OrderRecord,
    events: OrderEventRecord[],
    nowEpochNanoseconds: bigint,
  ): void {
    const requestedAt = parseTimestamp(order.requestedAt, "order requestedAt", "UNCERTAIN_ORDER");
    const createdAt = parseTimestamp(order.createdAt, "order createdAt", "UNCERTAIN_ORDER");
    const updatedAt = parseTimestamp(order.updatedAt, "order updatedAt", "UNCERTAIN_ORDER");
    if (
      requestedAt > createdAt ||
      createdAt > updatedAt ||
      updatedAt > nowEpochNanoseconds ||
      requestedAt > nowEpochNanoseconds
    ) {
      throw recoveryFault("UNCERTAIN_ORDER", `Order ${order.id} has invalid persisted chronology.`);
    }
    const eventIds = new Set<string>();
    for (const event of events) {
      const eventAt = parseTimestamp(event.createdAt, "order event createdAt", "UNCERTAIN_ORDER");
      if (
        eventIds.has(event.id) ||
        event.orderId !== order.id ||
        eventAt < requestedAt ||
        eventAt > nowEpochNanoseconds
      ) {
        throw recoveryFault("UNCERTAIN_ORDER", `Order ${order.id} has invalid lifecycle event chronology.`);
      }
      eventIds.add(event.id);
    }
  }

  private verifyEvidenceAndState(
    readback: RecoveryReadback,
    nowEpochNanoseconds: bigint,
  ): Readonly<ExactCandidateState> {
    if (!readback.state || !hasExactStateShape(readback.state)) {
      throw recoveryFault("REPLAY_MISMATCH", "Persisted exact candidate state is missing or malformed.");
    }
    try {
      for (const record of readback.evidenceRecords) {
        if (record.materialVersion !== "EXACT_V2") {
          throw new Error("Candidate evidence is not exact material V2.");
        }
        const material = candidateEvidenceMaterial(requireResolvedDeploymentId(readback), record.evidence);
        if (material.epochNanoseconds > nowEpochNanoseconds) {
          throw new Error("Candidate evidence timestamp is future-dated.");
        }
        if (material.materialVersion !== record.materialVersion || material.hash !== record.materialHash) {
          throw new Error("Candidate evidence material hash does not match persistence.");
        }
      }
      const replayed = projectExactCandidateState(readback.evidenceRecords.map((record) => record.evidence));
      if (!sameExactState(replayed, readback.state)) {
        throw new Error("Candidate exact replay does not match persisted exact state.");
      }
      return replayed;
    } catch (error) {
      throw recoveryFault(
        "REPLAY_MISMATCH",
        error instanceof Error ? error.message : "Candidate exact replay failed.",
      );
    }
  }

  private readInventory(
    balanceSnapshot: BalanceSnapshotRecord | null,
    positionSnapshot: PositionSnapshotRecord | null,
  ): { balanceQuantity: ExactDecimal; positionQuantity: ExactDecimal } {
    try {
      if (!balanceSnapshot || !positionSnapshot) throw new Error("Persisted inventory snapshots are missing.");
      const balances = JSON.parse(balanceSnapshot.balancesJson) as unknown;
      const positions = JSON.parse(positionSnapshot.positionsJson) as unknown;
      if (!Array.isArray(balances) || !Array.isArray(positions)) {
        throw new Error("Persisted inventory snapshot JSON must contain arrays.");
      }
      const btcBalances = balances.filter((item) => isPlainRecord(item) && item.currency === "BTC");
      const btcPositions = positions.filter((item) =>
        isPlainRecord(item) && item.asset === "BTC" && item.market === "KRW-BTC"
      );
      if (btcBalances.length !== 1 || btcPositions.length !== 1) {
        throw new Error("Persisted snapshots require exactly one BTC balance and position.");
      }
      const balance = btcBalances[0]!;
      const position = btcPositions[0]!;
      if (position.capturedAt !== positionSnapshot.capturedAt) {
        throw new Error("Persisted BTC position timestamp contradicts its snapshot.");
      }
      const free = parseExchangeDecimal(balance.balance, "BTC free balance");
      const locked = parseExchangeDecimal(balance.locked, "BTC locked balance");
      return {
        balanceQuantity: addExactDecimals(free, locked),
        positionQuantity: parseExchangeDecimal(position.quantity, "BTC position quantity"),
      };
    } catch (error) {
      throw recoveryFault(
        "INVENTORY_MISMATCH",
        error instanceof Error ? error.message : "Persisted BTC inventory is malformed.",
      );
    }
  }

  private verifyExchangeInventoryAgreement(balance: ExactDecimal, position: ExactDecimal): void {
    if (!withinTolerance(balance, position)) {
      throw recoveryFault("INVENTORY_MISMATCH", "BTC balance and position quantities disagree.");
    }
  }

  private verifyReplayInventoryAgreement(replay: string, balance: ExactDecimal, position: ExactDecimal): void {
    try {
      const replayQuantity = parseCanonicalNonNegativeDecimal(replay, "candidate replay inventory");
      if (!withinTolerance(replayQuantity, balance) || !withinTolerance(replayQuantity, position)) {
        throw new Error("Candidate replay and exchange BTC inventory disagree.");
      }
    } catch (error) {
      throw recoveryFault(
        "INVENTORY_MISMATCH",
        error instanceof Error ? error.message : "Candidate replay inventory is malformed.",
      );
    }
  }

  private verifyPendingFlatState(
    state: Readonly<ExactCandidateState>,
    evidence: Array<Readonly<CandidateEvidenceRecord>>,
  ): void {
    if (evidence.length !== 0 || !sameExactState(state, createExactEmptyCandidateState())) {
      throw recoveryFault("REPLAY_MISMATCH", "PENDING_FLAT requires pristine empty candidate state and evidence.");
    }
  }

  private async activatePendingFlat(
    readback: RecoveryReadback,
    state: Readonly<ExactCandidateState>,
    receipt: Readonly<PositionGuardPilotRefreshReceipt>,
    clock: { occurredAt: string; epochNanoseconds: bigint },
  ): Promise<PositionGuardPilotRecoveryResult> {
    let activated: PositionGuardPilotDeploymentRecord | null;
    const deploymentId = requireResolvedDeploymentId(readback);
    try {
      activated = await this.dependencies.candidatePilots.activateDeployment({
        deploymentId,
        expectedPhase: "PENDING_FLAT",
        expectedUpdatedAt: readback.deployment!.updatedAt,
        activationAt: clock.occurredAt,
        activationEpochNs: clock.epochNanoseconds,
      });
    } catch (error) {
      return this.blockForFault("ACTIVATION_CAS_CONFLICT", receipt, readback, clock, error);
    }
    if (!activated) {
      return this.blockForFault("ACTIVATION_CAS_CONFLICT", receipt, readback, clock);
    }
    const activatedDeployment = snapshotDeployment(activated);
    const activatedReadback = {
      ...readback,
      deployment: activatedDeployment,
      auditEvents: [] as PositionGuardPilotAuditEventRecord[],
    };
    let auditEvents: PositionGuardPilotAuditEventRecord[];
    try {
      auditEvents = await this.readPersistence(
        {
          operation: "candidatePilots.listAuditEvents",
          stage: "POST_ACTIVATION_AUDIT_READ",
          pauseAuthority: "PILOT_AND_GLOBAL_ATOMIC",
        },
        () => this.dependencies.candidatePilots.listAuditEvents(deploymentId),
      );
      activatedReadback.auditEvents = auditEvents;
    } catch (error) {
      if (isPersistenceReadFault(error)) {
        return this.blockForReadFailure(error, receipt, activatedReadback, clock);
      }
      throw error;
    }
    try {
      this.verifyDeploymentIdentity(activatedReadback, clock.epochNanoseconds);
      this.verifyAuditAuthority(activatedDeployment, auditEvents, clock.epochNanoseconds);
      this.verifyActiveChronology(
        activatedDeployment,
        readback.evidenceRecords,
        auditEvents,
        state,
        clock.epochNanoseconds,
      );
    } catch (error) {
      return this.blockForFault("ACTIVATION_CAS_CONFLICT", receipt, activatedReadback, clock, error);
    }
    return this.confirmStableReady(activatedReadback, receipt, clock);
  }

  private verifyActiveChronology(
    deployment: PositionGuardPilotDeploymentRecord,
    evidenceRecords: Array<Readonly<CandidateEvidenceRecord>>,
    auditEvents: PositionGuardPilotAuditEventRecord[],
    state: Readonly<ExactCandidateState>,
    nowEpochNanoseconds: bigint,
  ): void {
    if (deployment.activationAt === null || deployment.activationEpochNs === null) {
      throw recoveryFault("IDENTITY_MISMATCH", "ACTIVE deployment has no persisted activation instant.");
    }
    const activationEpoch = parseTimestamp(deployment.activationAt, "deployment activationAt", "IDENTITY_MISMATCH");
    if (activationEpoch !== deployment.activationEpochNs || activationEpoch > nowEpochNanoseconds) {
      throw recoveryFault("IDENTITY_MISMATCH", "Persisted activation timestamp and epoch are invalid.");
    }
    const createdEpoch = parseTimestamp(deployment.createdAt, "deployment createdAt", "IDENTITY_MISMATCH");
    if (activationEpoch < createdEpoch) {
      throw recoveryFault("IDENTITY_MISMATCH", "Persisted activation predates deployment creation.");
    }
    const activationEvents = auditEvents.filter((event) => event.eventType === "PHASE_TRANSITION" &&
      event.fromPhase === "PENDING_FLAT" && event.toPhase === "ACTIVE");
    if (activationEvents.length !== 1) {
      throw recoveryFault("IDENTITY_MISMATCH", "ACTIVE deployment requires one activation audit event.");
    }
    const activationEvent = activationEvents[0]!;
    let payload: unknown;
    try {
      payload = JSON.parse(activationEvent.payloadJson) as unknown;
    } catch {
      throw recoveryFault("IDENTITY_MISMATCH", "Activation audit payload JSON is malformed.");
    }
    if (
      activationEvent.createdAt !== deployment.activationAt ||
      activationEvent.stateVersion !== 0 ||
      !isPlainRecord(payload) ||
      !hasExactOwnKeys(payload, ["activationAt", "activationEpochNs"]) ||
      payload.activationAt !== deployment.activationAt ||
      payload.activationEpochNs !== deployment.activationEpochNs.toString()
    ) {
      throw recoveryFault("IDENTITY_MISMATCH", "Activation audit does not match persisted deployment chronology.");
    }
    const stateAdvanceEvents = auditEvents.filter((event) => event.eventType === "STATE_ADVANCED");
    if (stateAdvanceEvents.length !== evidenceRecords.length || state.stateVersion !== evidenceRecords.length) {
      throw recoveryFault("REPLAY_MISMATCH", "Candidate evidence and STATE_ADVANCED audit counts do not match.");
    }
    for (const [index, record] of evidenceRecords.entries()) {
      const evidenceAt = parseTimestamp(record.evidence.executedAt, "candidate evidence executedAt", "REPLAY_MISMATCH");
      if (evidenceAt <= activationEpoch || evidenceAt > nowEpochNanoseconds) {
        throw recoveryFault("REPLAY_MISMATCH", "Candidate evidence does not follow activation chronology.");
      }
      const event = stateAdvanceEvents[index];
      if (!event) {
        throw recoveryFault("REPLAY_MISMATCH", "Candidate evidence has no STATE_ADVANCED audit event.");
      }
      let statePayload: unknown;
      try {
        statePayload = JSON.parse(event.payloadJson) as unknown;
      } catch {
        throw recoveryFault("REPLAY_MISMATCH", "STATE_ADVANCED audit payload JSON is malformed.");
      }
      const expectedVersion = index + 1;
      if (
        event.id !== `${deployment.id}:evidence:${record.evidence.evidenceId}` ||
        event.fromPhase !== "ACTIVE" ||
        event.toPhase !== "ACTIVE" ||
        event.stateVersion !== expectedVersion ||
        event.createdAt !== record.evidence.executedAt ||
        !isPlainRecord(statePayload) ||
        !hasExactOwnKeys(
          statePayload,
          ["evidenceId", "materialHash", "materialVersion", "fromStateVersion", "toStateVersion"],
        ) ||
        statePayload.evidenceId !== record.evidence.evidenceId ||
        statePayload.materialHash !== record.materialHash ||
        statePayload.materialVersion !== record.materialVersion ||
        statePayload.fromStateVersion !== index ||
        statePayload.toStateVersion !== expectedVersion
      ) {
        throw recoveryFault("REPLAY_MISMATCH", "STATE_ADVANCED audit chain does not match candidate evidence.");
      }
    }
  }

  private async confirmStableReady(
    baseline: RecoveryReadback,
    receipt: Readonly<PositionGuardPilotRefreshReceipt>,
    clock: { occurredAt: string; epochNanoseconds: bigint },
  ): Promise<PositionGuardPilotRecoveryResult> {
    const latest = emptyRecoveryReadback();
    try {
      await this.readPersistedAccountEvidence(
        latest,
        "STABLE_AUTHORITY_REREAD",
        requireResolvedDeploymentId(baseline),
      );
      if (!hasEstablishedDeploymentIdentity(latest, this.dependencies)) {
        throw recoveryFault("IDENTITY_MISMATCH", "Candidate deployment identity changed during recovery verification.");
      }
      await this.readCandidateAuthority(latest, "STABLE_AUTHORITY_REREAD");
      if (canonicalAuthorityJson(latest) !== canonicalAuthorityJson(baseline)) {
        throw recoveryFault(
          "SNAPSHOT_PROVENANCE_INVALID",
          "Persisted recovery authority changed during verification.",
        );
      }
      const verified = this.verifyReadyAuthority(latest, receipt, clock.epochNanoseconds);
      return this.ready(latest.deployment, verified.state, receipt);
    } catch (error) {
      if (isPersistenceReadFault(error)) {
        const faultAuthority = hasEstablishedDeploymentIdentity(latest, this.dependencies) ? latest : baseline;
        return this.blockForReadFailure(error, receipt, faultAuthority, clock);
      }
      const fault = asRecoveryFault(error);
      return this.blockForFault(fault.reasonCode, receipt, latest, clock);
    }
  }

  private ready(
    deployment: PositionGuardPilotDeploymentRecord,
    state: Readonly<ExactCandidateState>,
    receipt: Readonly<PositionGuardPilotRefreshReceipt>,
  ): PositionGuardPilotRecoveryResult {
    if (deployment.phase !== "PENDING_FLAT" && deployment.phase !== "ACTIVE") {
      throw new Error(`Candidate recovery cannot return READY for phase ${deployment.phase}.`);
    }
    const activation = deployment.activationAt !== null && deployment.activationEpochNs !== null
      ? deepFreeze({
          activationAt: deployment.activationAt,
          activationEpochNs: deployment.activationEpochNs,
        })
      : null;
    return deepFreeze({
      status: "READY" as const,
      verificationOnly: true as const,
      deployment: { ...deployment },
      phase: deployment.phase,
      activation,
      state: { ...state },
      stateVersion: state.stateVersion,
      refreshProvenance: { ...receipt },
    });
  }

  private async blockForFault(
    reasonCode: CandidatePilotRecoveryFaultReason,
    receipt: Readonly<PositionGuardPilotRefreshReceipt>,
    readback: RecoveryReadback,
    clock: { occurredAt: string; epochNanoseconds: bigint },
    _cause?: unknown,
  ): Promise<Extract<PositionGuardPilotRecoveryResult, { status: "BLOCKED_FAULT" }>> {
    const provenanceJson = buildFaultProvenanceJson({
      reasonCode,
      configured: this.dependencies,
      receipt,
      readback,
    });
    return this.persistFault(reasonCode, provenanceJson, readback, clock);
  }

  private async blockForReadFailure(
    fault: PersistenceReadFault,
    receipt: Readonly<PositionGuardPilotRefreshReceipt>,
    readback: RecoveryReadback,
    clock: { occurredAt: string; epochNanoseconds: bigint },
  ): Promise<Extract<PositionGuardPilotRecoveryResult, { status: "BLOCKED_FAULT" }>> {
    const reasonCode = "SNAPSHOT_PROVENANCE_INVALID" as const;
    const provenanceJson = buildReadFailureProvenanceJson({
      reasonCode,
      operation: fault.persistenceReadOperation,
      stage: fault.persistenceReadStage,
      pauseAuthority: fault.persistenceReadPauseAuthority,
      failureClass: fault.persistenceReadFailureClass,
      configured: this.dependencies,
      receipt,
    });
    return this.persistFault(reasonCode, provenanceJson, readback, clock);
  }

  private async persistFault(
    reasonCode: CandidatePilotRecoveryFaultReason,
    provenanceJson: string,
    readback: RecoveryReadback,
    clock: { occurredAt: string; epochNanoseconds: bigint },
  ): Promise<Extract<PositionGuardPilotRecoveryResult, { status: "BLOCKED_FAULT" }>> {
    const faultId = `candidate-pilot-recovery:${createHash("sha256")
      .update(`${reasonCode}\n${provenanceJson}`, "utf8")
      .digest("hex")}`;
    const faultMaterial = { reasonCode, provenanceJson } as const;
    let occurredAt = clock.occurredAt;

    const deploymentIdentityEstablished = hasEstablishedDeploymentIdentity(readback, this.dependencies);
    if (deploymentIdentityEstablished) {
      const fault: PauseCandidatePilotForRecoveryFaultInput = {
        deploymentId: requireResolvedDeploymentId(readback),
        exchangeAccountId: this.dependencies.exchangeAccountId,
        faultId,
        reasonCode,
        provenanceJson,
        occurredAt,
      };
      const existing = readback.auditEvents.find((event) => event.id === faultId);
      if (existing) {
        fault.occurredAt = existing.createdAt;
      } else if (readback.deployment.phase === "PAUSED_FAULT") {
        fault.occurredAt = readback.deployment.updatedAt;
      }
      occurredAt = fault.occurredAt;
      const persisted = await this.dependencies.candidatePilots.pauseForRecoveryFault(fault);
      if (persisted.auditEvent.id !== faultId || persisted.deployment.phase !== "PAUSED_FAULT") {
        throw new Error("Candidate recovery fault pause did not persist the expected atomic authority.");
      }
    } else {
      let existing = null;
      try {
        existing = await this.dependencies.operatorState.getTransitionById(faultId);
      } catch {
        // The deterministic pause write remains safe and idempotent when its optional readback is unavailable.
      }
      if (existing) occurredAt = existing.createdAt;
      await this.dependencies.operatorState.pauseForFault({
        exchangeAccountId: this.dependencies.exchangeAccountId,
        faultId,
        reason: candidatePilotRecoveryFaultReason(faultMaterial),
        occurredAt,
        ...(existing ? { transitionAt: existing.createdAt } : {}),
      });
    }

    const result = deepFreeze({
      status: "BLOCKED_FAULT" as const,
      reasonCode,
      faultId,
      executableAuthority: false as const,
    });
    await this.reportFaultNotification(result, readback, occurredAt);
    return result;
  }

  private async reportActivationNotification(result: PositionGuardPilotRecoveryResult): Promise<void> {
    if (result.status !== "READY" || result.phase !== "ACTIVE" || result.activation === null) return;
    await this.reportPilotNotification({
      notificationType: "POSITION_GUARD_PILOT_ACTIVATED",
      severity: "INFO",
      eventIdentity: `${result.deployment.id}:activation:${result.activation.activationEpochNs.toString()}`,
      createdAt: result.activation.activationAt,
      title: "Candidate pilot activated",
      message: "The BTC candidate pilot entered ACTIVE after persisted recovery verification.",
      payload: {
        deploymentId: result.deployment.id,
        phase: result.phase,
        activationAt: result.activation.activationAt,
        activationEpochNs: result.activation.activationEpochNs.toString(),
      },
    });
  }

  private async reportFaultNotification(
    result: Extract<PositionGuardPilotRecoveryResult, { status: "BLOCKED_FAULT" }>,
    readback: RecoveryReadback,
    fallbackCreatedAt: string,
  ): Promise<void> {
    const audit = readback.auditEvents.find((event) => event.id === result.faultId);
    const notificationType = result.reasonCode === "UNCERTAIN_ORDER"
      ? "POSITION_GUARD_PILOT_UNCERTAIN_SUBMISSION"
      : "POSITION_GUARD_PILOT_FAULT_PAUSED";
    await this.reportPilotNotification({
      notificationType,
      severity: "ERROR",
      eventIdentity: result.faultId,
      createdAt: audit?.createdAt ?? fallbackCreatedAt,
      title: result.reasonCode === "UNCERTAIN_ORDER"
        ? "Candidate order submission is uncertain"
        : "Candidate pilot paused for recovery fault",
      message: result.reasonCode === "UNCERTAIN_ORDER"
        ? "Candidate authority is paused because persisted order evidence is uncertain."
        : `Candidate authority is paused for recovery fault ${result.reasonCode}.`,
      payload: {
        deploymentId: readback.resolvedDeploymentId,
        faultId: result.faultId,
        reasonCode: result.reasonCode,
        executableAuthority: false,
      },
    });
  }

  private async reportRollbackNotification(
    notificationType:
      | "POSITION_GUARD_PILOT_ROLLBACK_STARTED"
      | "POSITION_GUARD_PILOT_ROLLBACK_COMPLETED",
    deployment: PositionGuardPilotDeploymentRecord,
    clock: { occurredAt: string; epochNanoseconds: bigint },
  ): Promise<void> {
    const started = notificationType === "POSITION_GUARD_PILOT_ROLLBACK_STARTED";
    await this.reportPilotNotification({
      notificationType,
      severity: started ? "WARN" : "INFO",
      eventIdentity: `${deployment.id}:${started ? "rollback_started" : "rollback_completed"}:${clock.epochNanoseconds.toString()}`,
      createdAt: clock.occurredAt,
      title: started ? "Candidate pilot rollback started" : "Candidate pilot rollback completed",
      message: started
        ? "The BTC candidate pilot entered DRAINING; only reduction or exit authority remains."
        : "The BTC candidate pilot is flat and DISABLED; global execution remains paused.",
      payload: {
        deploymentId: deployment.id,
        phase: deployment.phase,
        transitionAt: clock.occurredAt,
        transitionEpochNs: clock.epochNanoseconds.toString(),
      },
    });
  }

  private async reportPilotNotification(input: {
    notificationType: OperatorNotificationType;
    severity: "INFO" | "WARN" | "ERROR";
    eventIdentity: string;
    createdAt: string;
    title: string;
    message: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const reporter = new DurableTelegramReporter({
      repositories: this.dependencies.repositories,
      ...(this.dependencies.notificationDelivery
        ? { deliveryService: this.dependencies.notificationDelivery }
        : {}),
      now: () => input.createdAt,
    });
    try {
      await reporter.report({
        notificationId: `operator_notification:${input.notificationType.toLowerCase()}:${input.eventIdentity}`,
        exchangeAccountId: this.dependencies.exchangeAccountId,
        notificationType: input.notificationType,
        severity: input.severity,
        title: input.title,
        message: input.message,
        payload: input.payload,
      });
    } catch (error) {
      throw notificationPersistenceError(error);
    }
  }

  private async readExistingPersistedFault(
    readback: RecoveryReadback,
  ): Promise<Extract<PositionGuardPilotRecoveryResult, { status: "BLOCKED_FAULT" }> | null> {
    if (readback.deployment?.phase !== "PAUSED_FAULT") return null;
    const faultEvents = readback.auditEvents
      .filter((event) => event.eventType === "FAULT_PAUSED")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const event = faultEvents[0];
    if (!event) throw new Error("Persisted PAUSED_FAULT deployment has no fault audit event.");
    const transition = await this.readPersistence(
      {
        operation: "operatorState.getTransitionById",
        stage: "EXISTING_FAULT_TRANSITION_READ",
        pauseAuthority: "PILOT_AND_GLOBAL_ATOMIC",
      },
      () => this.dependencies.operatorState.getTransitionById(event.id),
    );
    if (!transition || transition.command !== "AUTOMATIC_PAUSE") {
      throw new Error("Persisted candidate recovery fault has no matching global pause transition.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(event.payloadJson) as unknown;
    } catch {
      throw new Error("Persisted candidate recovery fault audit payload is malformed.");
    }
    if (!isPlainRecord(payload) || !isRecoveryFaultReason(payload.reasonCode)) {
      throw new Error("Persisted candidate recovery fault audit reason is invalid.");
    }
    return deepFreeze({
      status: "BLOCKED_FAULT" as const,
      reasonCode: payload.reasonCode,
      faultId: event.id,
      executableAuthority: false as const,
    });
  }

  private readClock(): { occurredAt: string; occurredAtEpochMs: number; epochNanoseconds: bigint } {
    const value = this.dependencies.clock.now();
    const epochNanoseconds = parseCandidateEvidenceTimestamp(value.occurredAt, "candidate recovery clock");
    if (
      !Number.isSafeInteger(value.occurredAtEpochMs) ||
      value.occurredAtEpochMs < 0 ||
      Date.parse(value.occurredAt) !== value.occurredAtEpochMs
    ) {
      throw new Error("Candidate recovery clock must provide matching ISO and epoch-millisecond values.");
    }
    return { ...value, epochNanoseconds };
  }
}

function rollbackResult(
  status: "DRAINING" | "DISABLED",
  deployment: PositionGuardPilotDeploymentRecord,
  state: Readonly<ExactCandidateState>,
): PositionGuardPilotRollbackResult {
  if (deployment.phase !== status) {
    throw new Error(`Candidate rollback result ${status} does not match phase ${deployment.phase}.`);
  }
  return deepFreeze({
    status,
    deployment: { ...deployment },
    state: { ...state },
    stateVersion: state.stateVersion,
    executableAuthority: false as const,
  });
}

function snapshotReceipt(value: PositionGuardPilotRefreshReceipt): Readonly<PositionGuardPilotRefreshReceipt> {
  return Object.freeze({
    exchangeAccountId: value.exchangeAccountId,
    requestedAt: value.requestedAt,
    balanceSnapshotId: value.balanceSnapshotId,
    balanceCapturedAt: value.balanceCapturedAt,
    positionSnapshotId: value.positionSnapshotId,
    positionCapturedAt: value.positionCapturedAt,
    reconciliationRunId: value.reconciliationRunId,
    reconciliationStartedAt: value.reconciliationStartedAt,
    reconciliationCompletedAt: value.reconciliationCompletedAt,
    reconciliationSource: value.reconciliationSource,
  });
}

function emptyRecoveryReadback(): RecoveryReadback {
  return {
    resolvedDeploymentId: null,
    identityMatchCount: null,
    balanceSnapshot: null,
    positionSnapshot: null,
    reconciliationRun: null,
    orders: [],
    deployment: null,
    state: null,
    evidenceRecords: [],
    auditEvents: [],
    orderEvents: new Map(),
    orderRecoveryObservations: new Map(),
  };
}

function hasEstablishedDeploymentIdentity(
  readback: RecoveryReadback,
  configured: CandidatePilotRecoveryIdentity,
): readback is RecoveryReadback & { deployment: PositionGuardPilotDeploymentRecord } {
  return readback.resolvedDeploymentId !== null &&
    readback.deployment?.id === readback.resolvedDeploymentId &&
    deploymentMatchesConfiguredIdentity(readback.deployment, configured);
}

function deploymentMatchesConfiguredIdentity(
  deployment: PositionGuardPilotDeploymentRecord,
  configured: CandidatePilotRecoveryIdentity,
): boolean {
  return deployment.exchangeAccountId === configured.exchangeAccountId &&
    deployment.pilotId === configured.pilotId &&
    deployment.market === configured.market &&
    deployment.policyId === configured.policyId &&
    deployment.policyVersion === configured.policyVersion;
}

function requireResolvedDeploymentId(readback: RecoveryReadback): string {
  if (readback.resolvedDeploymentId === null) {
    throw recoveryFault("IDENTITY_MISMATCH", "Candidate deployment identity is unresolved.");
  }
  return readback.resolvedDeploymentId;
}

function snapshotDeployment(
  deployment: PositionGuardPilotDeploymentRecord,
): Readonly<PositionGuardPilotDeploymentRecord> {
  try {
    return Object.freeze({ ...validateCandidatePilotDeployment(deployment) });
  } catch {
    throw recoveryFault("IDENTITY_MISMATCH", "Persisted candidate deployment identity is malformed.");
  }
}

function buildFaultProvenanceJson(input: {
  reasonCode: CandidatePilotRecoveryFaultReason;
  configured: PositionGuardPilotRecoveryDependencies;
  receipt: Readonly<PositionGuardPilotRefreshReceipt>;
  readback: RecoveryReadback;
}): string {
  return canonicalJson({
    schemaVersion: 3,
    reasonCode: input.reasonCode,
    configuredIdentity: {
      exchangeAccountId: input.configured.exchangeAccountId,
      target: input.configured.target,
      resolvedDeploymentId: input.readback.resolvedDeploymentId,
      identityMatchCount: input.readback.identityMatchCount,
      pilotId: input.configured.pilotId,
      market: input.configured.market,
      policyId: input.configured.policyId,
      policyVersion: input.configured.policyVersion,
    },
    verificationPolicy: recoveryVerificationPolicyMaterial(input.configured),
    refreshReceipt: input.receipt,
    persistedAuthority: persistedAuthorityMaterial(input.readback),
  });
}

function buildReadFailureProvenanceJson(input: {
  reasonCode: "SNAPSHOT_PROVENANCE_INVALID";
  operation: string;
  stage: PersistenceReadStage;
  pauseAuthority: PersistenceReadPauseAuthority;
  failureClass: string;
  configured: PositionGuardPilotRecoveryDependencies;
  receipt: Readonly<PositionGuardPilotRefreshReceipt>;
}): string {
  return canonicalJson({
    schemaVersion: 3,
    reasonCode: input.reasonCode,
    faultKind: "PERSISTENCE_READ_FAILURE",
    readOperation: input.operation,
    readStage: input.stage,
    pauseAuthority: input.pauseAuthority,
    readFailureClass: input.failureClass,
    configuredIdentity: {
      exchangeAccountId: input.configured.exchangeAccountId,
      target: input.configured.target,
      resolvedDeploymentId: null,
      pilotId: input.configured.pilotId,
      market: input.configured.market,
      policyId: input.configured.policyId,
      policyVersion: input.configured.policyVersion,
    },
    verificationPolicy: recoveryVerificationPolicyMaterial(input.configured),
    refreshReceipt: input.receipt,
  });
}

function recoveryVerificationPolicyMaterial(
  configured: PositionGuardPilotRecoveryDependencies,
): object {
  return {
    freshnessThresholdMs: configured.freshnessThresholdMs,
    minimumAbsenceObservations: configured.minimumAbsenceObservations,
    minimumAbsenceElapsedMs: configured.minimumAbsenceElapsedMs,
  };
}

function canonicalAuthorityJson(readback: RecoveryReadback): string {
  return canonicalJson(persistedAuthorityMaterial(readback));
}

function persistedAuthorityMaterial(readback: RecoveryReadback): object {
  return {
    deployment: readback.deployment ? { ...readback.deployment } : null,
    balanceSnapshot: readback.balanceSnapshot ? {
      ...readback.balanceSnapshot,
      balancesPayload: contentMaterial(readback.balanceSnapshot.balancesJson),
    } : null,
    positionSnapshot: readback.positionSnapshot ? {
      ...readback.positionSnapshot,
      positionsPayload: contentMaterial(readback.positionSnapshot.positionsJson),
    } : null,
    reconciliationRun: readback.reconciliationRun ? {
      ...readback.reconciliationRun,
      summaryPayload: contentMaterial(readback.reconciliationRun.summaryJson),
    } : null,
    exactState: readback.state ? { ...readback.state } : null,
    evidenceRecords: readback.evidenceRecords.map((record, sequence) => ({
      sequence,
      materialHash: record.materialHash,
      materialVersion: record.materialVersion,
      evidence: { ...record.evidence },
    })),
    auditEvents: [...readback.auditEvents]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((event) => ({
        ...event,
        payload: contentMaterial(event.payloadJson),
      })),
    orders: [...readback.orders]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((order) => ({
        ...order,
        exchangeResponse: order.exchangeResponseJson === null ? null : contentMaterial(order.exchangeResponseJson),
        lifecycleEvents: [...(readback.orderEvents.get(order.id) ?? [])]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((event) => ({
            ...event,
            payload: contentMaterial(event.payloadJson),
          })),
        recoveryObservations: [...(readback.orderRecoveryObservations.get(order.id) ?? [])]
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((observation) => ({
            ...observation,
            detail: contentMaterial(observation.detailJson),
          })),
      })),
  };
}

function contentMaterial(value: string): { value: string; sha256: string } {
  return {
    value,
    sha256: createHash("sha256").update(value, "utf8").digest("hex"),
  };
}

function verifyRecoveryObservations(
  order: OrderRecord,
  observations: OrderSubmissionRecoveryObservationRecord[],
  nowEpochNanoseconds: bigint,
): void {
  const requestedAt = parseTimestamp(order.requestedAt, "order requestedAt", "UNCERTAIN_ORDER");
  const ids = new Set<string>();
  for (const observation of observations) {
    let observedAt: bigint;
    let detail: unknown;
    try {
      observedAt = parseCandidateEvidenceTimestamp(observation.observedAt, "recovery observation observedAt");
      const createdAt = parseCandidateEvidenceTimestamp(observation.createdAt, "recovery observation createdAt");
      detail = JSON.parse(observation.detailJson) as unknown;
      if (
        !isNonEmptyString(observation.id) ||
        ids.has(observation.id) ||
        observation.orderId !== order.id ||
        !["FOUND", "NOT_FOUND", "TRANSIENT_FAILURE"].includes(observation.outcome as string) ||
        !Number.isSafeInteger(observation.observedAtEpochMs) ||
        observation.observedAtEpochMs < 0 ||
        Date.parse(observation.observedAt) !== observation.observedAtEpochMs ||
        observation.createdAt !== observation.observedAt ||
        createdAt !== observedAt ||
        observedAt < requestedAt ||
        observedAt > nowEpochNanoseconds ||
        !isValidRecoveryObservationDetail(order, observation.outcome, detail)
      ) {
        throw new Error("Recovery observation authority is invalid.");
      }
    } catch {
      throw recoveryFault("UNCERTAIN_ORDER", `Order ${order.id} has invalid recovery observation evidence.`);
    }
    ids.add(observation.id);
  }
}

function isValidRecoveryObservationDetail(
  order: OrderRecord,
  outcome: OrderSubmissionRecoveryObservationRecord["outcome"],
  detail: unknown,
): boolean {
  if (!isPlainRecord(detail)) return false;
  const expectedQueries = recoveryQueriesForOrder(order);
  if (!expectedQueries) return false;
  if (outcome === "NOT_FOUND") {
    return hasExactOwnKeys(detail, ["attemptedQueries"]) &&
      isValidRecoveryQueries(detail.attemptedQueries, expectedQueries);
  }
  if (outcome === "TRANSIENT_FAILURE") {
    return hasExactOwnKeys(detail, ["attemptedQueries", "reason"]) &&
      isValidRecoveryQueries(detail.attemptedQueries, expectedQueries) && isNonEmptyString(detail.reason);
  }
  if (outcome === "FOUND") {
    return hasExactOwnKeys(detail, ["query", "attemptedQueries", "uuid"]) &&
      isValidRecoveryQuery(detail.query) &&
      expectedQueries.some((query) => canonicalJson(query) === canonicalJson(detail.query)) &&
      isValidRecoveryQueries(detail.attemptedQueries, expectedQueries) &&
      order.upbitUuid !== null &&
      detail.uuid === order.upbitUuid &&
      (detail.attemptedQueries as unknown[]).some((query) => canonicalJson(query) === canonicalJson(detail.query));
  }
  return false;
}

function isValidRecoveryQueries(value: unknown, expected: unknown[]): value is unknown[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isValidRecoveryQuery)) return false;
  const canonical = value.map((query) => canonicalJson(query));
  const allowed = new Set(expected.map((query) => canonicalJson(query)));
  return new Set(canonical).size === canonical.length && canonical.every((query) => allowed.has(query));
}

function isValidRecoveryQuery(value: unknown): boolean {
  return isPlainRecord(value) &&
    ((hasExactOwnKeys(value, ["uuid"]) && isNonEmptyString(value.uuid)) ||
      (hasExactOwnKeys(value, ["identifier"]) && isNonEmptyString(value.identifier)));
}

function recoveryQueriesForOrder(order: OrderRecord): Array<{ uuid: string } | { identifier: string }> | null {
  if (!isNonEmptyString(order.identifier) || (order.upbitUuid !== null && !isNonEmptyString(order.upbitUuid))) {
    return null;
  }
  return [
    ...(order.upbitUuid ? [{ uuid: order.upbitUuid }] : []),
    { identifier: order.identifier },
  ];
}

function isDefinitivelyAbsentOrder(
  order: OrderRecord,
  events: OrderEventRecord[],
  observations: OrderSubmissionRecoveryObservationRecord[],
  nowEpochNanoseconds: bigint,
  policy: { minimumNotFoundObservations: number; minimumElapsedMs: number },
): boolean {
  let requestedAt: bigint;
  try {
    requestedAt = parseCandidateEvidenceTimestamp(order.requestedAt, "order requestedAt");
  } catch {
    return false;
  }
  if (observations.some((observation) => observation.outcome === "FOUND")) return false;
  if (order.status === "REJECTED") {
    const rejectionEvents = events.filter((event) => event.eventType === "ORDER_REJECTED");
    if (
      order.failureCode !== "EXCHANGE_ORDER_REJECTED" ||
      order.upbitUuid !== null ||
      !isNonEmptyString(order.failureMessage) ||
      order.exchangeResponseJson === null ||
      rejectionEvents.length !== 1
    ) {
      return false;
    }
    const event = rejectionEvents[0]!;
    try {
      const eventAt = parseCandidateEvidenceTimestamp(event.createdAt, "order rejection createdAt");
      const payload = JSON.parse(event.payloadJson) as unknown;
      const response = JSON.parse(order.exchangeResponseJson) as unknown;
      const validProof = event.orderId === order.id &&
        event.createdAt === order.updatedAt &&
        eventAt >= requestedAt &&
        eventAt <= nowEpochNanoseconds &&
        (event.eventSource === "EXCHANGE" || (order.executionMode === "DRY_RUN" && event.eventSource === "LOCAL")) &&
        isDefinitiveRejectionPayload(payload) &&
        isDefinitiveRejectionPayload(response) &&
        canonicalJson(payload) === canonicalJson(response);
      return validProof && !hasLaterContradictoryOrderEvidence(event, events);
    } catch {
      return false;
    }
  }
  const absenceEvents = events.filter((event) =>
    event.eventType === "RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED"
  );
  if (
    order.status !== "FAILED" ||
    order.failureCode !== "ORDER_SUBMISSION_ABSENCE_CONFIRMED" ||
    order.failureMessage !== "Bounded identifier recovery confirmed persistent exchange absence." ||
    absenceEvents.length !== 1
  ) {
    return false;
  }
  const event = absenceEvents[0]!;
  try {
    const eventAt = parseCandidateEvidenceTimestamp(event.createdAt, "absence proof createdAt");
    const payload = JSON.parse(event.payloadJson) as unknown;
    if (
      event.id !== `identifier-recovery-absence-event:${order.id}` ||
      event.orderId !== order.id ||
      event.eventSource !== "RECONCILIATION" ||
      event.createdAt !== order.updatedAt ||
      eventAt < requestedAt ||
      eventAt > nowEpochNanoseconds ||
      !isPlainRecord(payload) ||
      !hasExactOwnKeys(
        payload,
        ["absenceObservationCount", "elapsedMs", "minimumNotFoundObservations", "minimumElapsedMs"],
      ) ||
      !isNonNegativeSafeInteger(payload.absenceObservationCount) ||
      !isNonNegativeSafeInteger(payload.elapsedMs) ||
      !isNonNegativeSafeInteger(payload.minimumNotFoundObservations) ||
      payload.minimumNotFoundObservations !== policy.minimumNotFoundObservations ||
      !isNonNegativeSafeInteger(payload.minimumElapsedMs) ||
      payload.minimumElapsedMs !== policy.minimumElapsedMs
    ) {
      return false;
    }
    const expectedQueries = recoveryQueriesForOrder(order);
    if (!expectedQueries) return false;
    const observationIds = new Set<string>();
    for (const observation of observations) {
      const observationAt = parseCandidateEvidenceTimestamp(
        observation.observedAt,
        "absence observation observedAt",
      );
      if (
        observationIds.has(observation.id) ||
        observation.orderId !== order.id ||
        observation.createdAt !== observation.observedAt ||
        Date.parse(observation.observedAt) !== observation.observedAtEpochMs ||
        observationAt < requestedAt ||
        observationAt > eventAt ||
        observationAt > nowEpochNanoseconds
      ) {
        return false;
      }
      observationIds.add(observation.id);
    }
    const absenceObservations = observations.filter((observation) => observation.outcome === "NOT_FOUND");
    for (const observation of absenceObservations) {
      const detail = JSON.parse(observation.detailJson) as unknown;
      if (
        !isPlainRecord(detail) ||
        !hasExactOwnKeys(detail, ["attemptedQueries"]) ||
        canonicalJson(detail.attemptedQueries) !== canonicalJson(expectedQueries)
      ) {
        return false;
      }
    }
    const ordered = [...absenceObservations].sort((left, right) =>
      left.observedAtEpochMs - right.observedAtEpochMs || left.id.localeCompare(right.id)
    );
    const first = ordered[0];
    const latest = ordered.at(-1);
    if (!first || !latest || latest.observedAt !== event.createdAt) return false;
    const elapsedMs = latest.observedAtEpochMs - first.observedAtEpochMs;
    return !hasLaterContradictoryOrderEvidence(event, events) &&
      absenceObservations.length === payload.absenceObservationCount &&
      elapsedMs === payload.elapsedMs &&
      absenceObservations.length >= policy.minimumNotFoundObservations &&
      elapsedMs >= policy.minimumElapsedMs;
  } catch {
    return false;
  }
}

function hasLaterContradictoryOrderEvidence(
  proof: OrderEventRecord,
  events: OrderEventRecord[],
): boolean {
  const proofAt = Date.parse(proof.createdAt);
  return events.some((event) => {
    if (event.id === proof.id || Date.parse(event.createdAt) < proofAt) return false;
    if (event.eventSource === "EXCHANGE") return true;
    const eventType = event.eventType.toUpperCase();
    if (
      eventType.includes("SUBMITTED") ||
      eventType.includes("ACCEPTED") ||
      eventType.includes("FILL") ||
      eventType.includes("CANCELED") ||
      eventType.includes("TERMINAL") ||
      eventType.includes("EXCHANGE_ORDER_RECOVERED")
    ) {
      return true;
    }
    try {
      const payload = JSON.parse(event.payloadJson) as unknown;
      return containsContradictoryOrderMaterial(payload);
    } catch {
      return true;
    }
  });
}

function containsContradictoryOrderMaterial(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (value.accepted === true || isNonEmptyString(value.uuid) || isNonEmptyString(value.upbitUuid)) return true;
  if (typeof value.fillCount === "number" && value.fillCount > 0) return true;
  if (typeof value.executedVolume === "string" && value.executedVolume !== "0") return true;
  return ["OPEN", "PARTIALLY_FILLED", "FILLED", "CANCELED"].includes(value.nextStatus as string);
}

function isDefinitiveRejectionPayload(value: unknown): boolean {
  if (
    !isPlainRecord(value) ||
    !hasExactOwnKeys(value, ["kind", "status", "exchangeCode", "exchangeName", "responseReceived"]) ||
    value.kind !== "DEFINITIVE_REJECTION" ||
    !Number.isSafeInteger(value.status) ||
    (value.status as number) < 400 ||
    (value.status as number) >= 500 ||
    value.status === 408 ||
    value.status === 429 ||
    value.responseReceived !== true ||
    !isNullableString(value.exchangeCode) ||
    !isNullableString(value.exchangeName)
  ) {
    return false;
  }
  return ![value.exchangeCode, value.exchangeName].some((item) =>
    typeof item === "string" && item.trim().toLowerCase() === "duplicate_identifier"
  );
}

function isValidHistoryRecoverySummary(
  value: unknown,
  run: ReconciliationRunRecord,
  nowEpochNanoseconds: bigint,
): boolean {
  if (
    !isPlainRecord(value) ||
    !hasExactOwnKeys(value, [
      "closedOrderLookbackDays",
      "stopBeforeDays",
      "stopBeforeAt",
      "retentionAssumptionDays",
      "retentionBoundaryAt",
      "retentionStatus",
      "coverageStatus",
      "confidenceLevel",
      "confidenceReason",
      "failureMessage",
      "scannedSnapshotCount",
      "recoveredOrderCount",
      "markets",
    ]) ||
    !Number.isSafeInteger(value.closedOrderLookbackDays) ||
    (value.closedOrderLookbackDays as number) <= 0 ||
    !Number.isSafeInteger(value.stopBeforeDays) ||
    (value.stopBeforeDays as number) < (value.closedOrderLookbackDays as number) ||
    !isStrictTimestamp(value.stopBeforeAt) ||
    !Number.isSafeInteger(value.retentionAssumptionDays) ||
    (value.retentionAssumptionDays as number) < (value.closedOrderLookbackDays as number) ||
    !isStrictTimestamp(value.retentionBoundaryAt) ||
    (value.retentionStatus !== "WITHIN_ASSUMED_RETENTION" && value.retentionStatus !== "BEYOND_ASSUMED_RETENTION") ||
    (value.coverageStatus !== "IN_PROGRESS" && value.coverageStatus !== "COMPLETE") ||
    (value.confidenceLevel !== "HIGH" && value.confidenceLevel !== "PARTIAL") ||
    ![
      "ARCHIVE_COMPLETE",
      "ARCHIVE_IN_PROGRESS",
      "PAGE_LIMIT_REACHED",
      "BEYOND_ASSUMED_RETENTION",
    ].includes(value.confidenceReason as string) ||
    value.failureMessage !== null ||
    !isNonNegativeSafeInteger(value.scannedSnapshotCount) ||
    !isNonNegativeSafeInteger(value.recoveredOrderCount) ||
    !Array.isArray(value.markets) ||
    value.markets.length !== 2
  ) {
    return false;
  }

  const millisecondsPerDay = 86_400_000;
  const startedAtMs = Date.parse(run.startedAt);
  const lookbackMs = (value.closedOrderLookbackDays as number) * millisecondsPerDay;
  const stopBeforeMs = (value.stopBeforeDays as number) * millisecondsPerDay;
  const retentionMs = (value.retentionAssumptionDays as number) * millisecondsPerDay;
  if (
    !Number.isSafeInteger(startedAtMs) ||
    !Number.isSafeInteger(lookbackMs) ||
    !Number.isSafeInteger(stopBeforeMs) ||
    !Number.isSafeInteger(retentionMs)
  ) {
    return false;
  }
  const recentStartAt = new Date(startedAtMs - lookbackMs).toISOString();
  const expectedStopBeforeAt = new Date(startedAtMs - stopBeforeMs).toISOString();
  const expectedRetentionBoundaryAt = new Date(startedAtMs - retentionMs).toISOString();
  if (
    value.stopBeforeAt !== expectedStopBeforeAt ||
    value.retentionBoundaryAt !== expectedRetentionBoundaryAt ||
    !timestampIsNotFuture(run.startedAt, nowEpochNanoseconds) ||
    !timestampIsNotFuture(value.stopBeforeAt, nowEpochNanoseconds) ||
    !timestampIsNotFuture(value.retentionBoundaryAt, nowEpochNanoseconds)
  ) {
    return false;
  }

  const markets = new Set<string>();
  const validatedMarkets: Array<{
    archiveComplete: boolean;
    retentionStatus: "WITHIN_ASSUMED_RETENTION" | "BEYOND_ASSUMED_RETENTION";
    confidenceLevel: "HIGH" | "PARTIAL";
    confidenceReason: "ARCHIVE_COMPLETE" | "ARCHIVE_IN_PROGRESS" | "PAGE_LIMIT_REACHED" |
      "BEYOND_ASSUMED_RETENTION";
    snapshotCount: number;
  }> = [];
  for (const market of value.markets) {
    if (
      !isPlainRecord(market) ||
      !hasExactOwnKeys(market, [
        "market",
        "recentClosedWindowStartAt",
        "recentClosedWindowEndAt",
        "archivalWindowStartAt",
        "archivalWindowEndAt",
        "nextWindowEndAt",
        "archiveComplete",
        "retentionStatus",
        "confidenceLevel",
        "confidenceReason",
        "openHistoryTruncated",
        "recentClosedHistoryTruncated",
        "archivalClosedHistoryTruncated",
        "openPagesScanned",
        "recentClosedPagesScanned",
        "archivalClosedPagesScanned",
        "snapshotCount",
      ]) ||
      (market.market !== "KRW-BTC" && market.market !== "KRW-ETH") ||
      markets.has(market.market) ||
      !isStrictTimestamp(market.recentClosedWindowStartAt) ||
      !isStrictTimestamp(market.recentClosedWindowEndAt) ||
      !isStrictTimestamp(market.archivalWindowStartAt) ||
      !isStrictTimestamp(market.archivalWindowEndAt) ||
      !isStrictTimestamp(market.nextWindowEndAt) ||
      typeof market.archiveComplete !== "boolean" ||
      (market.retentionStatus !== "WITHIN_ASSUMED_RETENTION" && market.retentionStatus !== "BEYOND_ASSUMED_RETENTION") ||
      (market.confidenceLevel !== "HIGH" && market.confidenceLevel !== "PARTIAL") ||
      ![
        "ARCHIVE_COMPLETE",
        "ARCHIVE_IN_PROGRESS",
        "PAGE_LIMIT_REACHED",
        "BEYOND_ASSUMED_RETENTION",
      ].includes(market.confidenceReason as string) ||
      typeof market.openHistoryTruncated !== "boolean" ||
      typeof market.recentClosedHistoryTruncated !== "boolean" ||
      typeof market.archivalClosedHistoryTruncated !== "boolean" ||
      !isNonNegativeSafeInteger(market.openPagesScanned) ||
      !isNonNegativeSafeInteger(market.recentClosedPagesScanned) ||
      !isNonNegativeSafeInteger(market.archivalClosedPagesScanned) ||
      !isNonNegativeSafeInteger(market.snapshotCount)
    ) {
      return false;
    }

    const timestamps = [
      market.recentClosedWindowStartAt,
      market.recentClosedWindowEndAt,
      market.archivalWindowStartAt,
      market.archivalWindowEndAt,
      market.nextWindowEndAt,
    ];
    if (!timestamps.every((timestamp) => timestampIsNotFuture(timestamp, nowEpochNanoseconds))) return false;

    const archivalStartMs = Date.parse(market.archivalWindowStartAt as string);
    const archivalEndMs = Date.parse(market.archivalWindowEndAt as string);
    const expectedArchivalStartMs = archivalEndMs <= Date.parse(expectedStopBeforeAt)
      ? archivalEndMs
      : Math.max(archivalEndMs - lookbackMs, Date.parse(expectedStopBeforeAt));
    const expectedArchiveComplete = archivalStartMs <= Date.parse(expectedStopBeforeAt);
    const expectedRetentionStatus =
      archivalStartMs <= Date.parse(expectedRetentionBoundaryAt) ||
        Date.parse(expectedStopBeforeAt) < Date.parse(expectedRetentionBoundaryAt)
        ? "BEYOND_ASSUMED_RETENTION"
        : "WITHIN_ASSUMED_RETENTION";
    const pageLimitReached = market.openHistoryTruncated ||
      market.recentClosedHistoryTruncated || market.archivalClosedHistoryTruncated;
    const expectedConfidenceReason = pageLimitReached
      ? "PAGE_LIMIT_REACHED"
      : expectedRetentionStatus === "BEYOND_ASSUMED_RETENTION"
        ? "BEYOND_ASSUMED_RETENTION"
        : expectedArchiveComplete
          ? "ARCHIVE_COMPLETE"
          : "ARCHIVE_IN_PROGRESS";
    const expectedConfidenceLevel = expectedArchiveComplete && !pageLimitReached &&
        expectedRetentionStatus === "WITHIN_ASSUMED_RETENTION"
      ? "HIGH"
      : "PARTIAL";
    const totalPages = (market.openPagesScanned as number) +
      (market.recentClosedPagesScanned as number) + (market.archivalClosedPagesScanned as number);
    if (
      market.recentClosedWindowStartAt !== recentStartAt ||
      market.recentClosedWindowEndAt !== run.startedAt ||
      archivalStartMs > archivalEndMs ||
      archivalEndMs > Date.parse(recentStartAt) ||
      market.archivalWindowStartAt !== new Date(expectedArchivalStartMs).toISOString() ||
      market.nextWindowEndAt !== market.archivalWindowStartAt ||
      market.archiveComplete !== expectedArchiveComplete ||
      market.retentionStatus !== expectedRetentionStatus ||
      market.confidenceReason !== expectedConfidenceReason ||
      market.confidenceLevel !== expectedConfidenceLevel ||
      (market.openHistoryTruncated && market.openPagesScanned === 0) ||
      (market.recentClosedHistoryTruncated && market.recentClosedPagesScanned === 0) ||
      (market.archivalClosedHistoryTruncated && market.archivalClosedPagesScanned === 0) ||
      !Number.isSafeInteger(totalPages) ||
      (market.snapshotCount > 0 && totalPages === 0)
    ) {
      return false;
    }
    markets.add(market.market);
    validatedMarkets.push({
      archiveComplete: expectedArchiveComplete,
      retentionStatus: expectedRetentionStatus,
      confidenceLevel: expectedConfidenceLevel,
      confidenceReason: expectedConfidenceReason,
      snapshotCount: market.snapshotCount as number,
    });
  }

  if (!markets.has("KRW-BTC") || !markets.has("KRW-ETH")) return false;
  const expectedCoverage = validatedMarkets.every((market) => market.archiveComplete) ? "COMPLETE" : "IN_PROGRESS";
  const expectedRetention = validatedMarkets.some((market) => market.retentionStatus === "BEYOND_ASSUMED_RETENTION")
    ? "BEYOND_ASSUMED_RETENTION"
    : "WITHIN_ASSUMED_RETENTION";
  const expectedConfidence = validatedMarkets.every((market) => market.confidenceLevel === "HIGH")
    ? "HIGH"
    : "PARTIAL";
  const expectedReason = validatedMarkets.some((market) => market.confidenceReason === "PAGE_LIMIT_REACHED")
    ? "PAGE_LIMIT_REACHED"
    : validatedMarkets.some((market) => market.confidenceReason === "BEYOND_ASSUMED_RETENTION")
      ? "BEYOND_ASSUMED_RETENTION"
      : validatedMarkets.some((market) => market.confidenceReason === "ARCHIVE_IN_PROGRESS")
        ? "ARCHIVE_IN_PROGRESS"
        : "ARCHIVE_COMPLETE";
  const snapshotCount = validatedMarkets.reduce((total, market) => total + market.snapshotCount, 0);
  return Number.isSafeInteger(snapshotCount) &&
    value.coverageStatus === expectedCoverage &&
    value.retentionStatus === expectedRetention &&
    value.confidenceLevel === expectedConfidence &&
    value.confidenceReason === expectedReason &&
    (value.recoveredOrderCount as number) <= (value.scannedSnapshotCount as number) &&
    (value.scannedSnapshotCount as number) <= snapshotCount &&
    ((value.scannedSnapshotCount as number) > 0) === (snapshotCount > 0);
}

function timestampIsNotFuture(value: unknown, nowEpochNanoseconds: bigint): value is string {
  if (!isStrictTimestamp(value)) return false;
  try {
    return parseCandidateEvidenceTimestamp(value, "history recovery timestamp") <= nowEpochNanoseconds;
  } catch {
    return false;
  }
}

function parseExchangeDecimal(value: unknown, label: string): ExactDecimal {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error(`${label} must be a finite non-negative decimal string.`);
  }
  const [whole, fraction = ""] = value.split(".");
  const trimmedFraction = fraction.replace(/0+$/u, "");
  const canonical = trimmedFraction === "" ? whole! : `${whole}.${trimmedFraction}`;
  return parseCanonicalNonNegativeDecimal(canonical, label);
}

function withinTolerance(left: ExactDecimal, right: ExactDecimal): boolean {
  return compareExactDecimals(left, addExactDecimals(right, QUANTITY_TOLERANCE)) <= 0 &&
    compareExactDecimals(right, addExactDecimals(left, QUANTITY_TOLERANCE)) <= 0;
}

function zeroDecimal(): ExactDecimal {
  return parseCanonicalNonNegativeDecimal("0", "zero quantity");
}

function sameExactState(left: Readonly<ExactCandidateState>, right: Readonly<ExactCandidateState>): boolean {
  return EXACT_STATE_KEYS.every((key) => left[key] === right[key]);
}

function hasExactStateShape(value: Readonly<ExactCandidateState>): boolean {
  return isPlainRecord(value) &&
    Reflect.ownKeys(value).length === EXACT_STATE_KEYS.length &&
    EXACT_STATE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function parseTimestamp(
  value: string,
  label: string,
  reasonCode: CandidatePilotRecoveryFaultReason,
): bigint {
  try {
    return parseCandidateEvidenceTimestamp(value, label);
  } catch (error) {
    throw recoveryFault(reasonCode, error instanceof Error ? error.message : `Invalid ${label}.`);
  }
}

function recoveryFault(reasonCode: CandidatePilotRecoveryFaultReason, message: string): RecoveryFault {
  return Object.assign(new Error(message), { reasonCode });
}

function rollbackControlError(message: string): RollbackControlError {
  return Object.assign(new Error(message), { rollbackControlError: true as const });
}

function isRollbackControlError(error: unknown): error is RollbackControlError {
  return error instanceof Error && "rollbackControlError" in error && error.rollbackControlError === true;
}

function notificationPersistenceError(cause: unknown): NotificationPersistenceError {
  return Object.assign(new Error("candidate pilot notification persistence failed.", { cause }), {
    notificationPersistenceError: true as const,
  });
}

function isNotificationPersistenceError(error: unknown): error is NotificationPersistenceError {
  return error instanceof Error &&
    "notificationPersistenceError" in error &&
    error.notificationPersistenceError === true;
}

function persistenceReadFault(context: PersistenceReadContext, cause: unknown): PersistenceReadFault {
  const persistenceReadFailureClass = sanitizedReadFailureClass(cause);
  return Object.assign(new Error(`Persistence read failed during ${context.operation}.`), {
    persistenceReadOperation: context.operation,
    persistenceReadStage: context.stage,
    persistenceReadPauseAuthority: context.pauseAuthority,
    persistenceReadFailureClass,
  });
}

function isPersistenceReadFault(value: unknown): value is PersistenceReadFault {
  return value instanceof Error &&
    "persistenceReadOperation" in value && typeof value.persistenceReadOperation === "string" &&
    "persistenceReadStage" in value && isPersistenceReadStage(value.persistenceReadStage) &&
    "persistenceReadPauseAuthority" in value && isPersistenceReadPauseAuthority(value.persistenceReadPauseAuthority) &&
    "persistenceReadFailureClass" in value &&
    typeof value.persistenceReadFailureClass === "string" &&
    isSanitizedReadFailureClass(value.persistenceReadFailureClass);
}

function isPersistenceReadStage(value: unknown): value is PersistenceReadStage {
  return typeof value === "string" && [
    "INITIAL_DEPLOYMENT_READ",
    "INITIAL_AUTHORITY_READ",
    "POST_ACTIVATION_AUDIT_READ",
    "STABLE_AUTHORITY_REREAD",
    "EXISTING_FAULT_TRANSITION_READ",
  ].includes(value);
}

function isPersistenceReadPauseAuthority(value: unknown): value is PersistenceReadPauseAuthority {
  return value === "GLOBAL_ONLY" || value === "PILOT_AND_GLOBAL_ATOMIC";
}

function sanitizedReadFailureClass(cause: unknown): string {
  if (cause instanceof Error) {
    const constructorName = cause.constructor?.name;
    return isSanitizedReadFailureClass(constructorName) ? constructorName : "Error";
  }
  const kind = cause === null ? "NULL" : (typeof cause).toUpperCase();
  return `NON_ERROR_${kind}`;
}

function isSanitizedReadFailureClass(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_$.-]{0,63}$/u.test(value);
}

function asRecoveryFault(error: unknown): RecoveryFault {
  if (error instanceof Error && "reasonCode" in error && isRecoveryFaultReason(error.reasonCode)) {
    return error as RecoveryFault;
  }
  return recoveryFault("SNAPSHOT_PROVENANCE_INVALID", error instanceof Error ? error.message : String(error));
}

function isRecoveryFaultReason(value: unknown): value is CandidatePilotRecoveryFaultReason {
  return typeof value === "string" && RECOVERY_FAULT_REASONS.has(value as CandidatePilotRecoveryFaultReason);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactOwnKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  return keys.length >= required.length &&
    keys.every((key) => typeof key === "string" && allowed.has(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStrictTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    parseCandidateEvidenceTimestamp(value, "persisted timestamp");
    return true;
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    return { $number: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function snapshotRecoveryDependencies(
  value: PositionGuardPilotRecoveryDependencies,
): Readonly<PositionGuardPilotRecoveryDependencies> {
  const hasNotificationDelivery = Object.prototype.hasOwnProperty.call(value, "notificationDelivery");
  const record = exactOwnDataRecord(
    value,
    "candidate recovery dependencies",
    hasNotificationDelivery ? RECOVERY_DEPENDENCY_KEYS : RECOVERY_DEPENDENCY_KEYS_WITHOUT_DELIVERY,
  );
  const exchangeAccountId = requireNonEmptyString(
    record.exchangeAccountId,
    "candidate recovery exchangeAccountId",
  );
  const pilotId = requireExactString(
    record.pilotId,
    "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    "candidate recovery pilotId",
  );
  const market = requireExactString(record.market, "KRW-BTC", "candidate recovery market");
  const policyId = requireExactString(
    record.policyId,
    "COMBINED_CONSERVATIVE",
    "candidate recovery policyId",
  );
  const policyVersion = requireExactString(
    record.policyVersion,
    "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    "candidate recovery policyVersion",
  );
  const freshnessThresholdMs = requirePositiveSafeInteger(
    record.freshnessThresholdMs,
    "candidate recovery freshnessThresholdMs",
  );
  const minimumAbsenceObservations = requireSafeIntegerAtLeast(
    record.minimumAbsenceObservations,
    2,
    "candidate recovery minimumAbsenceObservations",
  );
  const minimumAbsenceElapsedMs = requirePositiveSafeInteger(
    record.minimumAbsenceElapsedMs,
    "candidate recovery minimumAbsenceElapsedMs",
  );

  return Object.freeze({
    exchangeAccountId,
    target: snapshotRecoveryTarget(record.target),
    pilotId,
    market,
    policyId,
    policyVersion,
    freshnessThresholdMs,
    minimumAbsenceObservations,
    minimumAbsenceElapsedMs,
    clock: requireObjectReference<PositionGuardPilotRecoveryClock>(record.clock, "candidate recovery clock"),
    repositories: requireObjectReference<RecoveryExecutionReads>(
      record.repositories,
      "candidate recovery repositories",
    ),
    candidatePilots: requireObjectReference<RecoveryCandidateRepository>(
      record.candidatePilots,
      "candidate recovery candidatePilots",
    ),
    operatorState: requireObjectReference<RecoveryOperatorState>(
      record.operatorState,
      "candidate recovery operatorState",
    ),
    notificationDelivery: !hasNotificationDelivery || record.notificationDelivery === null
      ? null
      : requireObjectReference<Pick<OperatorNotificationDeliveryService, "kick">>(
          record.notificationDelivery,
          "candidate recovery notificationDelivery",
        ),
  });
}

function rollbackOperatorState(state: ExecutionStateRecord) {
  return Object.freeze({
    id: state.id,
    exchangeAccountId: state.exchangeAccountId,
    systemStatus: state.systemStatus as "PAUSED" | "KILL_SWITCHED",
    updatedAt: state.updatedAt,
  });
}

function snapshotRecoveryTarget(value: unknown): PositionGuardPilotRecoveryTarget {
  if (hasExactOwnDataShape(value, ["kind"] as const)) {
    const record = exactOwnDataRecord(value, "candidate recovery target", ["kind"] as const);
    if (record.kind !== "CONFIGURED_ACCOUNT_PILOT") {
      throw new Error("Candidate recovery target is invalid.");
    }
    return Object.freeze({ kind: "CONFIGURED_ACCOUNT_PILOT" as const });
  }
  if (hasExactOwnDataShape(value, ["kind", "deploymentId"] as const)) {
    const record = exactOwnDataRecord(
      value,
      "candidate recovery target",
      ["kind", "deploymentId"] as const,
    );
    if (record.kind !== "EXACT_DEPLOYMENT") {
      throw new Error("Candidate recovery target is invalid.");
    }
    return Object.freeze({
      kind: "EXACT_DEPLOYMENT" as const,
      deploymentId: requireNonEmptyString(record.deploymentId, "candidate recovery deploymentId"),
    });
  }
  throw new Error(
    "Candidate recovery target must have exactly own data properties for a supported target.",
  );
}

function hasExactOwnDataShape<const TKeys extends readonly string[]>(
  value: unknown,
  expectedKeys: TKeys,
): boolean {
  if (!isPlainObject(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length) return false;
  const expected = new Set<string>(expectedKeys);
  return ownKeys.every((key) => {
    if (typeof key !== "string" || !expected.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function exactOwnDataRecord<const TKeys extends readonly string[]>(
  value: unknown,
  label: string,
  expectedKeys: TKeys,
): Record<TKeys[number], unknown> {
  if (!hasExactOwnDataShape(value, expectedKeys)) {
    throw new Error(`${label} must have exactly own data properties: ${expectedKeys.join(", ")}.`);
  }
  const result = {} as Record<TKeys[number], unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`${label} must have exactly own data properties: ${expectedKeys.join(", ")}.`);
    }
    result[key as TKeys[number]] = descriptor.value;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireExactString<const TValue extends string>(
  value: unknown,
  expected: TValue,
  label: string,
): TValue {
  if (value !== expected) throw new Error(`${label} must be ${expected}.`);
  return expected;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value as number;
}

function requireSafeIntegerAtLeast(value: unknown, minimum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be a safe integer of at least ${minimum}.`);
  }
  return value as number;
}

function requireObjectReference<T extends object>(value: unknown, label: string): T {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} must be an object reference.`);
  }
  return value as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
