import { createHash } from "node:crypto";

import type {
  PositionGuardPilotAuditEventRecord,
  PositionGuardPilotDeploymentRecord,
} from "../domain/pilot-types.js";
import type {
  BalanceSnapshotRecord,
  OrderEventRecord,
  OrderLifecycleStatus,
  OrderRecord,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
} from "../domain/types.js";
import type { ReconciliationTrigger } from "../modules/reconciliation/interfaces.js";
import type { ExecutionRepository, OperatorStateStore } from "../modules/db/interfaces.js";
import {
  candidateEvidenceMaterial,
  candidatePilotRecoveryFaultReason,
  type CandidateEvidenceRecord,
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

export interface PositionGuardPilotRefreshReceipt {
  exchangeAccountId: string;
  requestedAt: string;
  balanceSnapshotId: string;
  balanceCapturedAt: string;
  positionSnapshotId: string;
  positionCapturedAt: string;
  reconciliationRunId: string;
  reconciliationStartedAt: string;
  reconciliationCompletedAt: string;
  reconciliationSource: ReconciliationTrigger;
}

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

type RecoveryExecutionReads = Pick<
  ExecutionRepository,
  | "getLatestBalanceSnapshot"
  | "getLatestPositionSnapshot"
  | "listReconciliationRuns"
  | "listOrders"
  | "listOrderEvents"
>;

type RecoveryCandidateRepository = Pick<
  CandidatePilotRepository,
  | "getDeployment"
  | "getExactState"
  | "listEvidenceRecords"
  | "listAuditEvents"
  | "activateDeployment"
  | "pauseForRecoveryFault"
>;

type RecoveryOperatorState = Pick<OperatorStateStore, "pauseForFault"> &
  Required<Pick<OperatorStateStore, "getTransitionById">>;

interface RecoveryReadback {
  balanceSnapshot: BalanceSnapshotRecord | null;
  positionSnapshot: PositionSnapshotRecord | null;
  reconciliationRun: ReconciliationRunRecord | null;
  orders: OrderRecord[];
  deployment: PositionGuardPilotDeploymentRecord | null;
  state: Readonly<ExactCandidateState> | null;
  evidenceRecords: Array<Readonly<CandidateEvidenceRecord>>;
  auditEvents: PositionGuardPilotAuditEventRecord[];
  orderEvents: Map<string, OrderEventRecord[]>;
}

interface RecoveryFault extends Error {
  reasonCode: CandidatePilotRecoveryFaultReason;
}

const ACTIVE_ORDER_STATUSES = new Set<OrderLifecycleStatus>([
  "INTENT_CREATED",
  "PERSISTED",
  "SUBMITTING",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
]);

const REVIEWED_NON_BLOCKING_RECONCILIATION_CODES = new Set([
  "ORDER_STATUS_RECONCILED",
  "ORDER_FILLS_BACKFILLED",
  "TERMINAL_ORDER_RECHECKED",
  "ORDER_IDENTIFIER_RECOVERED",
  "ORDER_SUBMISSION_ABSENCE_CONFIRMED",
  "EXCHANGE_ORDER_RECOVERED",
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

const QUANTITY_TOLERANCE = parseCanonicalNonNegativeDecimal(
  EXACT_CANDIDATE_QUANTITY_TOLERANCE,
  "candidate recovery quantity tolerance",
);

export class PositionGuardPilotRecovery {
  constructor(
    private readonly dependencies: {
      exchangeAccountId: string;
      deploymentId: string;
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1";
      market: "KRW-BTC";
      policyId: "COMBINED_CONSERVATIVE";
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1";
      freshnessThresholdMs: number;
      clock: PositionGuardPilotRecoveryClock;
      repositories: RecoveryExecutionReads;
      candidatePilots: RecoveryCandidateRepository;
      operatorState: RecoveryOperatorState;
    },
  ) {
    requireNonEmpty(dependencies.exchangeAccountId, "candidate recovery exchangeAccountId");
    requireNonEmpty(dependencies.deploymentId, "candidate recovery deploymentId");
    if (!Number.isSafeInteger(dependencies.freshnessThresholdMs) || dependencies.freshnessThresholdMs <= 0) {
      throw new Error("Candidate recovery freshnessThresholdMs must be a positive safe integer.");
    }
  }

  async verifyAndPrepareBtcRun(
    refreshReceipt: PositionGuardPilotRefreshReceipt,
  ): Promise<PositionGuardPilotRecoveryResult> {
    const clock = this.readClock();
    const receipt = snapshotReceipt(refreshReceipt);
    const readback = await this.readPersistedAccountEvidence();

    if (!readback.deployment || readback.deployment.exchangeAccountId !== this.dependencies.exchangeAccountId) {
      return this.blockForFault("IDENTITY_MISMATCH", receipt, readback, clock);
    }

    const [state, evidenceRecords, auditEvents] = await Promise.all([
      this.dependencies.candidatePilots.getExactState(this.dependencies.deploymentId),
      this.dependencies.candidatePilots.listEvidenceRecords(this.dependencies.deploymentId),
      this.dependencies.candidatePilots.listAuditEvents(this.dependencies.deploymentId),
    ]);
    readback.state = state;
    readback.evidenceRecords = evidenceRecords;
    readback.auditEvents = auditEvents;

    const existingFault = await this.readExistingPersistedFault(readback);
    if (existingFault) return existingFault;

    try {
      this.verifyDeploymentIdentity(readback.deployment);
      this.verifyRefreshCorrelation(receipt, readback, clock.epochNanoseconds);
      this.verifyReconciliation(receipt, readback.reconciliationRun);
      await this.verifyOrders(readback, clock.epochNanoseconds);
      const replayedState = this.verifyEvidenceAndState(readback);
      const inventory = this.readInventory(readback.balanceSnapshot, readback.positionSnapshot);
      this.verifyExchangeInventoryAgreement(inventory.balanceQuantity, inventory.positionQuantity);

      if (readback.deployment.phase === "PENDING_FLAT") {
        this.verifyPendingFlatState(replayedState, readback.evidenceRecords);
        if (!withinTolerance(inventory.balanceQuantity, zeroDecimal())) {
          return this.ready(readback.deployment, replayedState, receipt);
        }
        return await this.activatePendingFlat(readback, replayedState, receipt, clock);
      }

      if (readback.deployment.phase !== "ACTIVE") {
        throw recoveryFault("IDENTITY_MISMATCH", `Candidate phase ${readback.deployment.phase} is not recoverable.`);
      }
      this.verifyActiveChronology(readback.deployment, readback.auditEvents, replayedState, clock.epochNanoseconds);
      this.verifyReplayInventoryAgreement(
        replayedState.currentEpisodeInventoryQuantity,
        inventory.balanceQuantity,
        inventory.positionQuantity,
      );
      return this.ready(readback.deployment, replayedState, receipt);
    } catch (error) {
      const fault = asRecoveryFault(error);
      return this.blockForFault(fault.reasonCode, receipt, readback, clock);
    }
  }

  private async readPersistedAccountEvidence(): Promise<RecoveryReadback> {
    const [balanceSnapshot, positionSnapshot, reconciliationRuns, orders, deployment] = await Promise.all([
      this.dependencies.repositories.getLatestBalanceSnapshot(this.dependencies.exchangeAccountId),
      this.dependencies.repositories.getLatestPositionSnapshot(this.dependencies.exchangeAccountId),
      this.dependencies.repositories.listReconciliationRuns(this.dependencies.exchangeAccountId, 1),
      this.dependencies.repositories.listOrders(this.dependencies.exchangeAccountId),
      this.dependencies.candidatePilots.getDeployment(this.dependencies.deploymentId),
    ]);
    return {
      balanceSnapshot,
      positionSnapshot,
      reconciliationRun: reconciliationRuns[0] ?? null,
      orders,
      deployment,
      state: null,
      evidenceRecords: [],
      auditEvents: [],
      orderEvents: new Map(),
    };
  }

  private verifyDeploymentIdentity(deployment: PositionGuardPilotDeploymentRecord): void {
    if (
      deployment.id !== this.dependencies.deploymentId ||
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
    if (updatedAt < createdAt) {
      throw recoveryFault("IDENTITY_MISMATCH", "Candidate deployment chronology is invalid.");
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
  ): void {
    if (!run) throw recoveryFault("BLOCKING_RECONCILIATION", "Latest reconciliation is missing.");
    let summary: unknown;
    try {
      summary = JSON.parse(run.summaryJson) as unknown;
    } catch {
      throw recoveryFault("BLOCKING_RECONCILIATION", "Reconciliation summary JSON is malformed.");
    }
    if (!isPlainRecord(summary) || !Array.isArray(summary.issues)) {
      throw recoveryFault("BLOCKING_RECONCILIATION", "Reconciliation summary shape is invalid.");
    }
    if (
      summary.source !== receipt.reconciliationSource ||
      summary.status !== run.status ||
      (summary.status !== "SUCCESS" && summary.status !== "DRIFT_DETECTED") ||
      run.status === "ERROR"
    ) {
      throw recoveryFault("BLOCKING_RECONCILIATION", "Reconciliation provenance or status is invalid.");
    }
    const issueCodes: string[] = [];
    for (const issue of summary.issues) {
      if (!isPlainRecord(issue) || typeof issue.code !== "string" || issue.code.trim() === "") {
        throw recoveryFault("BLOCKING_RECONCILIATION", "Reconciliation issue shape is invalid.");
      }
      issueCodes.push(issue.code);
    }
    if (
      (run.status === "SUCCESS" && issueCodes.length > 0) ||
      issueCodes.some((code) => !REVIEWED_NON_BLOCKING_RECONCILIATION_CODES.has(code))
    ) {
      throw recoveryFault("BLOCKING_RECONCILIATION", "Reconciliation contains a blocking issue code.");
    }
  }

  private async verifyOrders(readback: RecoveryReadback, nowEpochNanoseconds: bigint): Promise<void> {
    for (const order of readback.orders) {
      if (order.exchangeAccountId !== this.dependencies.exchangeAccountId) {
        throw recoveryFault("UNCERTAIN_ORDER", "Account-wide order read returned mismatched provenance.");
      }
      if (order.status === "RECONCILIATION_REQUIRED") {
        throw recoveryFault("UNCERTAIN_ORDER", "An order requires reconciliation.");
      }
      if (ACTIVE_ORDER_STATUSES.has(order.status)) {
        throw recoveryFault("ACTIVE_ORDER", `Order ${order.id} remains nonterminal.`);
      }
      if (order.status !== "FAILED" && order.status !== "REJECTED") continue;
      const events = await this.dependencies.repositories.listOrderEvents(order.id);
      readback.orderEvents.set(order.id, events);
      if (!isDefinitivelyAbsentOrder(order, events, nowEpochNanoseconds)) {
        throw recoveryFault("UNCERTAIN_ORDER", `Order ${order.id} lacks definitive no-order evidence.`);
      }
    }
  }

  private verifyEvidenceAndState(readback: RecoveryReadback): Readonly<ExactCandidateState> {
    if (!readback.state || !hasExactStateShape(readback.state)) {
      throw recoveryFault("REPLAY_MISMATCH", "Persisted exact candidate state is missing or malformed.");
    }
    try {
      for (const record of readback.evidenceRecords) {
        if (record.materialVersion !== "EXACT_V2") {
          throw new Error("Candidate evidence is not exact material V2.");
        }
        const material = candidateEvidenceMaterial(this.dependencies.deploymentId, record.evidence);
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
    try {
      activated = await this.dependencies.candidatePilots.activateDeployment({
        deploymentId: this.dependencies.deploymentId,
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
    const auditEvents = await this.dependencies.candidatePilots.listAuditEvents(this.dependencies.deploymentId);
    try {
      this.verifyDeploymentIdentity(activated);
      this.verifyActiveChronology(activated, auditEvents, state, clock.epochNanoseconds);
    } catch (error) {
      return this.blockForFault("ACTIVATION_CAS_CONFLICT", receipt, {
        ...readback,
        deployment: activated,
        auditEvents,
      }, clock, error);
    }
    return this.ready(activated, state, receipt);
  }

  private verifyActiveChronology(
    deployment: PositionGuardPilotDeploymentRecord,
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
    for (const event of auditEvents) {
      const eventEpoch = parseTimestamp(event.createdAt, "pilot audit createdAt", "IDENTITY_MISMATCH");
      if (event.deploymentId !== deployment.id || eventEpoch > nowEpochNanoseconds) {
        throw recoveryFault("IDENTITY_MISMATCH", "Pilot audit chronology or identity is invalid.");
      }
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
      payload.activationAt !== deployment.activationAt ||
      payload.activationEpochNs !== deployment.activationEpochNs.toString()
    ) {
      throw recoveryFault("IDENTITY_MISMATCH", "Activation audit does not match persisted deployment chronology.");
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
  ): Promise<PositionGuardPilotRecoveryResult> {
    const provenanceJson = buildFaultProvenanceJson({
      reasonCode,
      configured: this.dependencies,
      receipt,
      readback,
    });
    const faultId = `candidate-pilot-recovery:${createHash("sha256")
      .update(`${reasonCode}\n${provenanceJson}`, "utf8")
      .digest("hex")}`;
    const fault: PauseCandidatePilotForRecoveryFaultInput = {
      deploymentId: this.dependencies.deploymentId,
      exchangeAccountId: this.dependencies.exchangeAccountId,
      faultId,
      reasonCode,
      provenanceJson,
      occurredAt: clock.occurredAt,
    };

    const deploymentIdentityEstablished = readback.deployment !== null &&
      readback.deployment.exchangeAccountId === this.dependencies.exchangeAccountId;
    if (deploymentIdentityEstablished) {
      const existing = readback.auditEvents.find((event) => event.id === faultId);
      if (existing) fault.occurredAt = existing.createdAt;
      const persisted = await this.dependencies.candidatePilots.pauseForRecoveryFault(fault);
      if (persisted.auditEvent.id !== faultId || persisted.deployment.phase !== "PAUSED_FAULT") {
        throw new Error("Candidate recovery fault pause did not persist the expected atomic authority.");
      }
    } else {
      const existing = await this.dependencies.operatorState.getTransitionById(faultId);
      if (existing) fault.occurredAt = existing.createdAt;
      await this.dependencies.operatorState.pauseForFault({
        exchangeAccountId: fault.exchangeAccountId,
        faultId: fault.faultId,
        reason: candidatePilotRecoveryFaultReason(fault),
        occurredAt: fault.occurredAt,
        ...(existing ? { transitionAt: existing.createdAt } : {}),
      });
    }

    return deepFreeze({
      status: "BLOCKED_FAULT" as const,
      reasonCode,
      faultId,
      executableAuthority: false as const,
    });
  }

  private async readExistingPersistedFault(
    readback: RecoveryReadback,
  ): Promise<PositionGuardPilotRecoveryResult | null> {
    if (readback.deployment?.phase !== "PAUSED_FAULT") return null;
    const faultEvents = readback.auditEvents
      .filter((event) => event.eventType === "FAULT_PAUSED")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    const event = faultEvents[0];
    if (!event) throw new Error("Persisted PAUSED_FAULT deployment has no fault audit event.");
    const transition = await this.dependencies.operatorState.getTransitionById(event.id);
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

function buildFaultProvenanceJson(input: {
  reasonCode: CandidatePilotRecoveryFaultReason;
  configured: {
    exchangeAccountId: string;
    deploymentId: string;
    pilotId: string;
    market: string;
    policyId: string;
    policyVersion: string;
  };
  receipt: Readonly<PositionGuardPilotRefreshReceipt>;
  readback: RecoveryReadback;
}): string {
  const deployment = input.readback.deployment;
  const state = input.readback.state;
  return JSON.stringify({
    schemaVersion: 1,
    reasonCode: input.reasonCode,
    configuredIdentity: {
      exchangeAccountId: input.configured.exchangeAccountId,
      deploymentId: input.configured.deploymentId,
      pilotId: input.configured.pilotId,
      market: input.configured.market,
      policyId: input.configured.policyId,
      policyVersion: input.configured.policyVersion,
    },
    refreshReceipt: input.receipt,
    persistedCorrelation: {
      balanceSnapshot: snapshotIdentity(input.readback.balanceSnapshot),
      positionSnapshot: snapshotIdentity(input.readback.positionSnapshot),
      reconciliationRun: input.readback.reconciliationRun ? {
        id: input.readback.reconciliationRun.id,
        exchangeAccountId: input.readback.reconciliationRun.exchangeAccountId,
        status: input.readback.reconciliationRun.status,
        startedAt: input.readback.reconciliationRun.startedAt,
        completedAt: input.readback.reconciliationRun.completedAt,
      } : null,
      deploymentIdentity: deployment ? {
        id: deployment.id,
        exchangeAccountId: deployment.exchangeAccountId,
        pilotId: deployment.pilotId,
        market: deployment.market,
        policyId: deployment.policyId,
        policyVersion: deployment.policyVersion,
      } : null,
      stateVersion: state?.stateVersion ?? null,
      evidence: [...input.readback.evidenceRecords]
        .map((record) => ({
          evidenceId: record.evidence.evidenceId,
          materialHash: record.materialHash,
          materialVersion: record.materialVersion,
        }))
        .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
      orders: [...input.readback.orders]
        .map((order) => ({
          id: order.id,
          status: order.status,
          failureCode: order.failureCode,
          eventIds: [...(input.readback.orderEvents.get(order.id) ?? [])]
            .map((event) => event.id)
            .sort(),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
  });
}

function snapshotIdentity(value: BalanceSnapshotRecord | PositionSnapshotRecord | null): object | null {
  return value ? {
    id: value.id,
    exchangeAccountId: value.exchangeAccountId,
    capturedAt: value.capturedAt,
    source: value.source,
  } : null;
}

function isDefinitivelyAbsentOrder(
  order: OrderRecord,
  events: OrderEventRecord[],
  nowEpochNanoseconds: bigint,
): boolean {
  let requestedAt: bigint;
  try {
    requestedAt = parseCandidateEvidenceTimestamp(order.requestedAt, "order requestedAt");
  } catch {
    return false;
  }
  const isValidProofEvent = (event: OrderEventRecord): boolean => {
    try {
      const eventAt = parseCandidateEvidenceTimestamp(event.createdAt, "order event createdAt");
      return eventAt >= requestedAt && eventAt <= nowEpochNanoseconds;
    } catch {
      return false;
    }
  };
  if (order.status === "REJECTED") {
    return order.failureCode === "EXCHANGE_ORDER_REJECTED" && events.some((event) =>
      event.orderId === order.id &&
      event.eventType === "ORDER_REJECTED" &&
      (event.eventSource === "EXCHANGE" || (order.executionMode === "DRY_RUN" && event.eventSource === "LOCAL")) &&
      isValidProofEvent(event)
    );
  }
  return order.status === "FAILED" &&
    order.failureCode === "ORDER_SUBMISSION_ABSENCE_CONFIRMED" &&
    events.some((event) =>
      event.orderId === order.id &&
      event.eventType === "RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED" &&
      event.eventSource === "RECONCILIATION" &&
      isValidProofEvent(event)
    );
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

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
