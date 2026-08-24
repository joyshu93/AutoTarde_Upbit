import { createHash } from "node:crypto";

import type {
  PositionGuardPilotAuditEventRecord,
  PositionGuardPilotDeploymentRecord,
} from "../domain/pilot-types.js";
import {
  candidateEvidenceMaterial,
  parseCandidatePilotTimestamp,
  toPositionGuardCandidateRoutingState,
  validateCandidatePilotDeployment,
  type CandidateEvidenceRecord,
  type CandidatePilotDeploymentInitializationResult,
  type CandidatePilotRecoveryIdentity,
  type CandidatePilotRepository,
  type CreateCandidatePilotDeploymentInput,
} from "../modules/db/pilot-interfaces.js";
import {
  createExactEmptyCandidateState,
  projectExactCandidateState,
  type ExactCandidateState,
} from "../modules/execution/candidate-evidence-decimals.js";

type CandidateExecutionEvidence = CandidateEvidenceRecord["evidence"];

export type PositionGuardPilotInitializerIdentity = CandidatePilotRecoveryIdentity;

export type PositionGuardPilotInitializerRepository = Pick<
  CandidatePilotRepository,
  "initializeDeploymentWithInitialState"
>;

export interface PositionGuardPilotInitializerClock {
  now(): string;
}

export type PositionGuardPilotInitializationResult = Readonly<{
  outcome: CandidatePilotDeploymentInitializationResult["outcome"];
  deploymentId: string;
  identity: Readonly<PositionGuardPilotInitializerIdentity>;
  deployment: Readonly<PositionGuardPilotDeploymentRecord>;
  exactState: Readonly<ExactCandidateState>;
  evidenceRecords: readonly Readonly<CandidateEvidenceRecord>[];
  auditEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[];
}>;

type PositionGuardPilotInitializerDependencies = Readonly<{
  identity: PositionGuardPilotInitializerIdentity;
  repository: PositionGuardPilotInitializerRepository;
  clock: PositionGuardPilotInitializerClock;
}>;

const IDENTITY_KEYS = [
  "exchangeAccountId",
  "pilotId",
  "market",
  "policyId",
  "policyVersion",
] as const;
const RESULT_KEYS = [
  "outcome",
  "deployment",
  "exactState",
  "evidenceRecords",
  "auditEvents",
] as const;
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
const EVIDENCE_RECORD_KEYS = ["evidence", "materialHash", "materialVersion"] as const;
const EVIDENCE_KEYS = [
  "evidenceId",
  "executedAt",
  "action",
  "entryPath",
  "terminalStatus",
  "executedQuantity",
  "grossQuoteValueKrw",
  "confirmedFeeKrw",
  "remainingQuantity",
] as const;
const AUDIT_KEYS = [
  "id",
  "deploymentId",
  "eventType",
  "fromPhase",
  "toPhase",
  "stateVersion",
  "payloadJson",
  "createdAt",
] as const;
const AUDIT_EVENT_TYPES = [
  "DEPLOYMENT_CREATED",
  "STATE_ADVANCED",
  "PHASE_TRANSITION",
  "FAULT_PAUSED",
  "ROLLBACK_STARTED",
  "ROLLBACK_COMPLETED",
] as const;
const PILOT_PHASES = ["DISABLED", "PENDING_FLAT", "ACTIVE", "PAUSED_FAULT", "DRAINING"] as const;
const RECOVERY_FAULT_REASONS = [
  "SNAPSHOT_PROVENANCE_INVALID",
  "STALE_SNAPSHOT",
  "IDENTITY_MISMATCH",
  "REPLAY_MISMATCH",
  "INVENTORY_MISMATCH",
  "BLOCKING_RECONCILIATION",
  "ACTIVE_ORDER",
  "UNCERTAIN_ORDER",
  "ACTIVATION_CAS_CONFLICT",
] as const;

export class PositionGuardPilotInitializer {
  readonly identity: Readonly<PositionGuardPilotInitializerIdentity>;
  readonly deploymentId: string;

  private readonly initializeDeploymentWithInitialState: (
    input: CreateCandidatePilotDeploymentInput,
  ) => Promise<CandidatePilotDeploymentInitializationResult>;
  private readonly readClock: () => string;

  constructor(dependencies: PositionGuardPilotInitializerDependencies) {
    const dependencyRecord = exactOwnDataRecord(
      dependencies,
      "PositionGuard pilot initializer dependencies",
      ["identity", "repository", "clock"] as const,
    );
    this.identity = snapshotIdentity(
      dependencyRecord.identity as PositionGuardPilotInitializerIdentity,
    );
    this.deploymentId = derivePositionGuardPilotDeploymentId(this.identity);

    const repository = exactOwnDataRecord(
      dependencyRecord.repository,
      "PositionGuard pilot initializer repository",
      ["initializeDeploymentWithInitialState"] as const,
    );
    const initialize = repository.initializeDeploymentWithInitialState;
    if (typeof initialize !== "function") {
      throw new Error("PositionGuard pilot initializer repository method is required.");
    }
    this.initializeDeploymentWithInitialState = initialize.bind(dependencyRecord.repository);

    const clock = exactOwnDataRecord(
      dependencyRecord.clock,
      "PositionGuard pilot initializer clock",
      ["now"] as const,
    );
    const now = clock.now;
    if (typeof now !== "function") {
      throw new Error("PositionGuard pilot initializer clock now method is required.");
    }
    this.readClock = now.bind(dependencyRecord.clock);
    Object.freeze(this);
  }

  async initialize(): Promise<PositionGuardPilotInitializationResult> {
    const now = this.readClock();
    const nowEpochNs = strictTimestamp(now, "initializer clock");
    if (nowEpochNs < 0n) {
      throw new Error("PositionGuard pilot initializer clock cannot be before the Unix epoch.");
    }
    const initialization = await this.initializeDeploymentWithInitialState({
      deployment: {
        id: this.deploymentId,
        ...this.identity,
        phase: "PENDING_FLAT",
        activationAt: null,
        activationEpochNs: null,
        createdAt: now,
        updatedAt: now,
      },
      initialState: toPositionGuardCandidateRoutingState(createExactEmptyCandidateState()),
    });
    return validateAndSnapshotAuthority({
      initialization,
      identity: this.identity,
      deploymentId: this.deploymentId,
      now,
      nowEpochNs,
    });
  }
}

export function derivePositionGuardPilotDeploymentId(
  identity: PositionGuardPilotInitializerIdentity,
): string {
  const snapshot = snapshotIdentity(identity);
  const canonicalIdentity = JSON.stringify({
    exchangeAccountId: snapshot.exchangeAccountId,
    pilotId: snapshot.pilotId,
    market: snapshot.market,
    policyId: snapshot.policyId,
    policyVersion: snapshot.policyVersion,
  });
  return `position_guard_pilot_${createHash("sha256")
    .update(canonicalIdentity, "utf8")
    .digest("hex")}`;
}

function validateAndSnapshotAuthority(input: Readonly<{
  initialization: CandidatePilotDeploymentInitializationResult;
  identity: Readonly<PositionGuardPilotInitializerIdentity>;
  deploymentId: string;
  now: string;
  nowEpochNs: bigint;
}>): PositionGuardPilotInitializationResult {
  const result = exactOwnDataRecord(
    input.initialization,
    "PositionGuard pilot initialization result",
    RESULT_KEYS,
  );
  if (result.outcome !== "CREATED" && result.outcome !== "EXISTING") {
    throw new Error("PositionGuard pilot initialization outcome is unsupported.");
  }

  const deployment = snapshotDeployment(
    result.deployment as PositionGuardPilotDeploymentRecord,
    input,
  );
  const evidenceRecords = snapshotEvidenceRecords(
    result.evidenceRecords,
    deployment,
    input.nowEpochNs,
  );
  const exactState = snapshotExactState(result.exactState as ExactCandidateState);
  assertExactStateMatchesEvidence(exactState, evidenceRecords);
  const auditEvents = snapshotAuditEvents(
    result.auditEvents,
    deployment,
    exactState,
    input.nowEpochNs,
  );
  assertCanonicalCreationAudit(deployment, auditEvents);

  if (result.outcome === "CREATED") {
    if (deployment.phase !== "PENDING_FLAT") {
      throw new Error("A newly created PositionGuard pilot deployment must be PENDING_FLAT.");
    }
    if (deployment.createdAt !== input.now || deployment.updatedAt !== input.now) {
      throw new Error("CREATED PositionGuard pilot timestamps must equal the single initializer clock snapshot.");
    }
  }
  switch (deployment.phase) {
    case "PENDING_FLAT":
      assertPristinePendingAuthority(deployment, exactState, evidenceRecords, auditEvents);
      break;
    case "ACTIVE":
    case "PAUSED_FAULT":
      assertRetainedLifecycleAuthority(deployment, exactState, evidenceRecords, auditEvents);
      break;
    case "DISABLED":
      throw new Error("Selected PositionGuard candidate conflicts with a DISABLED deployment.");
    case "DRAINING":
      throw new Error("PositionGuard candidate DRAINING recovery is deferred and blocks initialization.");
    default:
      throw new Error("PositionGuard pilot initialization phase is unsupported.");
  }

  return Object.freeze({
    outcome: result.outcome,
    deploymentId: input.deploymentId,
    identity: input.identity,
    deployment,
    exactState,
    evidenceRecords,
    auditEvents,
  });
}

function snapshotIdentity(
  value: PositionGuardPilotInitializerIdentity,
): Readonly<PositionGuardPilotInitializerIdentity> {
  const identity = exactOwnDataRecord(value, "PositionGuard pilot initializer identity", IDENTITY_KEYS);
  if (typeof identity.exchangeAccountId !== "string" || identity.exchangeAccountId.trim() === "") {
    throw new Error("PositionGuard pilot initializer exchange account identity is required.");
  }
  if (
    identity.pilotId !== "BTC_COMBINED_CONSERVATIVE_PILOT_V1" ||
    identity.market !== "KRW-BTC" ||
    identity.policyId !== "COMBINED_CONSERVATIVE" ||
    identity.policyVersion !== "PCS-2026-001.DEPLOYMENT_READINESS_V1"
  ) {
    throw new Error("PositionGuard pilot initializer requires the exact approved BTC candidate identity.");
  }
  return Object.freeze({
    exchangeAccountId: identity.exchangeAccountId,
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
  });
}

function snapshotDeployment(
  value: PositionGuardPilotDeploymentRecord,
  authority: Readonly<{
    identity: Readonly<PositionGuardPilotInitializerIdentity>;
    deploymentId: string;
    nowEpochNs: bigint;
  }>,
): Readonly<PositionGuardPilotDeploymentRecord> {
  const validated = validateCandidatePilotDeployment(value);
  const deployment = Object.freeze({ ...validated });
  if (deployment.id !== authority.deploymentId) {
    throw new Error("PositionGuard pilot persisted deployment id does not match deterministic authority.");
  }
  for (const key of IDENTITY_KEYS) {
    if (deployment[key] !== authority.identity[key]) {
      throw new Error(`PositionGuard pilot persisted identity mismatch at ${key}.`);
    }
  }
  const createdAt = strictTimestamp(deployment.createdAt, "persisted deployment createdAt");
  const updatedAt = strictTimestamp(deployment.updatedAt, "persisted deployment updatedAt");
  assertNotFuture(createdAt, authority.nowEpochNs, "persisted deployment createdAt");
  assertNotFuture(updatedAt, authority.nowEpochNs, "persisted deployment updatedAt");
  if (updatedAt < createdAt) {
    throw new Error("PositionGuard pilot updatedAt cannot precede deployment creation.");
  }
  if (deployment.activationAt !== null) {
    const activationAt = strictTimestamp(deployment.activationAt, "persisted deployment activationAt");
    if (activationAt < createdAt || activationAt > updatedAt) {
      throw new Error("PositionGuard pilot activation timestamp is outside deployment chronology.");
    }
    assertNotFuture(activationAt, authority.nowEpochNs, "persisted deployment activationAt");
  }
  return deployment;
}

function snapshotExactState(value: ExactCandidateState): Readonly<ExactCandidateState> {
  const state = exactOwnDataRecord(value, "PositionGuard pilot exact state", EXACT_STATE_KEYS);
  const snapshot: ExactCandidateState = {
    currentEpisodeAddCount: state.currentEpisodeAddCount as number,
    currentEpisodeCostBasisKrw: state.currentEpisodeCostBasisKrw as string,
    currentEpisodeInventoryQuantity: state.currentEpisodeInventoryQuantity as string,
    currentEpisodeRealizedPnlKrw: state.currentEpisodeRealizedPnlKrw as string,
    lastFullExitAt: state.lastFullExitAt as string | null,
    lastFullExitRealizedPnlKrw: state.lastFullExitRealizedPnlKrw as string | null,
    lastEntryPath: state.lastEntryPath as ExactCandidateState["lastEntryPath"],
    lastEvidenceAt: state.lastEvidenceAt as string | null,
    lastEvidenceId: state.lastEvidenceId as string | null,
    stateVersion: state.stateVersion as number,
  };
  toPositionGuardCandidateRoutingState(snapshot);
  return Object.freeze(snapshot);
}

function snapshotEvidenceRecords(
  value: unknown,
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  nowEpochNs: bigint,
): readonly Readonly<CandidateEvidenceRecord>[] {
  const items = exactDensePlainArray(value, "PositionGuard pilot evidence authority");
  const ids = new Set<string>();
  let previousEpochNs: bigint | null = null;
  let previousEvidenceId: string | null = null;
  const activationEpochNs = deployment.activationAt === null
    ? null
    : strictTimestamp(deployment.activationAt, "persisted deployment activationAt");
  const records = items.map((item, index) => {
    const record = exactOwnDataRecord(item, `PositionGuard pilot evidence record ${index}`, EVIDENCE_RECORD_KEYS);
    const evidenceRecord = exactOwnDataRecord(
      record.evidence,
      `PositionGuard pilot evidence ${index}`,
      EVIDENCE_KEYS,
    );
    const evidence: CandidateExecutionEvidence = {
      evidenceId: evidenceRecord.evidenceId as string,
      executedAt: evidenceRecord.executedAt as string,
      action: evidenceRecord.action as CandidateExecutionEvidence["action"],
      entryPath: evidenceRecord.entryPath as CandidateExecutionEvidence["entryPath"],
      terminalStatus: evidenceRecord.terminalStatus as CandidateExecutionEvidence["terminalStatus"],
      executedQuantity: evidenceRecord.executedQuantity as CandidateExecutionEvidence["executedQuantity"],
      grossQuoteValueKrw: evidenceRecord.grossQuoteValueKrw as CandidateExecutionEvidence["grossQuoteValueKrw"],
      confirmedFeeKrw: evidenceRecord.confirmedFeeKrw as CandidateExecutionEvidence["confirmedFeeKrw"],
      remainingQuantity: evidenceRecord.remainingQuantity as CandidateExecutionEvidence["remainingQuantity"],
    };
    const material = candidateEvidenceMaterial(deployment.id, evidence);
    if (record.materialVersion !== "EXACT_V2" || record.materialHash !== material.hash) {
      throw new Error(`PositionGuard pilot evidence ${material.evidence.evidenceId} material is invalid.`);
    }
    if (ids.has(material.evidence.evidenceId)) {
      throw new Error(`Duplicate PositionGuard pilot evidence ${material.evidence.evidenceId}.`);
    }
    ids.add(material.evidence.evidenceId);
    const evidenceAt = strictTimestamp(material.evidence.executedAt, "persisted evidence executedAt");
    assertNotFuture(evidenceAt, nowEpochNs, "persisted evidence executedAt");
    if (activationEpochNs === null || evidenceAt < activationEpochNs) {
      throw new Error("PositionGuard pilot execution evidence requires prior activation authority.");
    }
    if (
      previousEpochNs !== null &&
      (evidenceAt < previousEpochNs ||
        (evidenceAt === previousEpochNs && material.evidence.evidenceId <= previousEvidenceId!))
    ) {
      throw new Error("PositionGuard pilot evidence authority is not in exact persisted chronology.");
    }
    previousEpochNs = evidenceAt;
    previousEvidenceId = material.evidence.evidenceId;
    return Object.freeze({
      evidence: Object.freeze({ ...material.evidence }),
      materialHash: material.hash,
      materialVersion: material.materialVersion,
    });
  });
  return Object.freeze(records);
}

function snapshotAuditEvents(
  value: unknown,
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  exactState: Readonly<ExactCandidateState>,
  nowEpochNs: bigint,
): readonly Readonly<PositionGuardPilotAuditEventRecord>[] {
  const items = exactDensePlainArray(value, "PositionGuard pilot audit authority");
  const createdAt = strictTimestamp(deployment.createdAt, "persisted deployment createdAt");
  const ids = new Set<string>();
  let previousEpochNs: bigint | null = null;
  let previousEventId: string | null = null;
  const events = items.map((item, index) => {
    const record = exactOwnDataRecord(item, `PositionGuard pilot audit event ${index}`, AUDIT_KEYS);
    if (typeof record.id !== "string" || record.id.trim() === "" || ids.has(record.id)) {
      throw new Error("PositionGuard pilot audit event id is invalid or duplicated.");
    }
    ids.add(record.id);
    if (record.deploymentId !== deployment.id) {
      throw new Error("PositionGuard pilot audit event deployment identity mismatch.");
    }
    if (!AUDIT_EVENT_TYPES.includes(record.eventType as PositionGuardPilotAuditEventRecord["eventType"])) {
      throw new Error("PositionGuard pilot audit event type is unsupported.");
    }
    if (record.fromPhase !== null && !PILOT_PHASES.includes(record.fromPhase as typeof PILOT_PHASES[number])) {
      throw new Error("PositionGuard pilot audit fromPhase is unsupported.");
    }
    if (record.toPhase !== null && !PILOT_PHASES.includes(record.toPhase as typeof PILOT_PHASES[number])) {
      throw new Error("PositionGuard pilot audit toPhase is unsupported.");
    }
    if (!Number.isSafeInteger(record.stateVersion) || (record.stateVersion as number) < 0 ||
      (record.stateVersion as number) > exactState.stateVersion) {
      throw new Error("PositionGuard pilot audit stateVersion is invalid.");
    }
    if (typeof record.payloadJson !== "string") {
      throw new Error("PositionGuard pilot audit payloadJson must be a string.");
    }
    try {
      JSON.parse(record.payloadJson);
    } catch {
      throw new Error("PositionGuard pilot audit payloadJson must be valid JSON.");
    }
    const eventAt = strictTimestamp(record.createdAt as string, "persisted audit createdAt");
    if (eventAt < createdAt) {
      throw new Error("PositionGuard pilot audit event precedes deployment creation.");
    }
    assertNotFuture(eventAt, nowEpochNs, "persisted audit createdAt");
    if (
      previousEpochNs !== null &&
      (eventAt < previousEpochNs || (eventAt === previousEpochNs && (record.id as string) <= previousEventId!))
    ) {
      throw new Error("PositionGuard pilot audit authority is not in exact persisted chronology.");
    }
    previousEpochNs = eventAt;
    previousEventId = record.id as string;
    return Object.freeze({
      id: record.id,
      deploymentId: deployment.id,
      eventType: record.eventType,
      fromPhase: record.fromPhase,
      toPhase: record.toPhase,
      stateVersion: record.stateVersion,
      payloadJson: record.payloadJson,
      createdAt: record.createdAt,
    } as PositionGuardPilotAuditEventRecord);
  });
  return Object.freeze(events);
}

function assertRetainedLifecycleAuthority(
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  exactState: Readonly<ExactCandidateState>,
  evidenceRecords: readonly Readonly<CandidateEvidenceRecord>[],
  auditEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
): void {
  const activationEvents = auditEvents.filter((event) => event.eventType === "PHASE_TRANSITION");
  if (deployment.activationAt === null || deployment.activationEpochNs === null) {
    if (deployment.phase === "ACTIVE" || activationEvents.length !== 0 || evidenceRecords.length !== 0) {
      throw new Error("PositionGuard pilot lifecycle requires canonical activation authority.");
    }
  } else {
    const expectedActivation = {
      id: `${deployment.id}:activation:${deployment.activationEpochNs.toString()}`,
      deploymentId: deployment.id,
      eventType: "PHASE_TRANSITION",
      fromPhase: "PENDING_FLAT",
      toPhase: "ACTIVE",
      stateVersion: 0,
      payloadJson: JSON.stringify({
        activationAt: deployment.activationAt,
        activationEpochNs: deployment.activationEpochNs.toString(),
      }),
      createdAt: deployment.activationAt,
    } as const;
    if (activationEvents.length !== 1 || !recordsEqual(activationEvents[0]!, expectedActivation, AUDIT_KEYS)) {
      throw new Error("PositionGuard pilot canonical activation audit authority is invalid.");
    }
    if (deployment.phase === "ACTIVE" && deployment.updatedAt !== deployment.activationAt) {
      throw new Error("ACTIVE PositionGuard pilot must preserve its canonical activation update timestamp.");
    }
  }

  const stateEvents = auditEvents.filter((event) => event.eventType === "STATE_ADVANCED");
  if (stateEvents.length !== evidenceRecords.length) {
    throw new Error("PositionGuard pilot STATE_ADVANCED audit count does not match evidence authority.");
  }
  for (let index = 0; index < evidenceRecords.length; index += 1) {
    const record = evidenceRecords[index]!;
    const expectedStateEvent = {
      id: `${deployment.id}:evidence:${record.evidence.evidenceId}`,
      deploymentId: deployment.id,
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
    } as const;
    if (!recordsEqual(stateEvents[index]!, expectedStateEvent, AUDIT_KEYS)) {
      throw new Error("PositionGuard pilot STATE_ADVANCED audit does not link exact evidence chronology.");
    }
  }

  const faultEvents = auditEvents.filter((event) => event.eventType === "FAULT_PAUSED");
  const rollbackEvents = auditEvents.filter((event) => event.eventType === "ROLLBACK_STARTED");
  if (deployment.phase === "ACTIVE") {
    if (faultEvents.length !== 0 || rollbackEvents.length !== 0) {
      throw new Error("ACTIVE PositionGuard pilot must not contain fault-pause or rollback authority.");
    }
  } else {
    const expectedFaultFromPhase = rollbackEvents.length === 0
      ? deployment.activationAt === null ? "PENDING_FLAT" : "ACTIVE"
      : "DRAINING";
    assertCanonicalFaultAudit(
      deployment,
      exactState,
      evidenceRecords,
      faultEvents,
      expectedFaultFromPhase,
    );
    if (rollbackEvents.length !== 0) {
      assertCanonicalRollbackStartedAudit(
        deployment,
        exactState,
        evidenceRecords,
        auditEvents,
        rollbackEvents,
        faultEvents[0]!,
      );
    }
  }

  const expectedAuditCount = 1 + activationEvents.length + stateEvents.length +
    rollbackEvents.length + faultEvents.length;
  if (auditEvents.length !== expectedAuditCount) {
    throw new Error("PositionGuard pilot lifecycle contains unsupported audit authority.");
  }
}

function assertCanonicalFaultAudit(
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  exactState: Readonly<ExactCandidateState>,
  evidenceRecords: readonly Readonly<CandidateEvidenceRecord>[],
  faultEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
  expectedFromPhase: "PENDING_FLAT" | "ACTIVE" | "DRAINING",
): void {
  if (faultEvents.length !== 1) {
    throw new Error("PAUSED_FAULT PositionGuard pilot requires exactly one canonical fault audit.");
  }
  const fault = faultEvents[0]!;
  if (
    fault.fromPhase !== expectedFromPhase ||
    fault.toPhase !== "PAUSED_FAULT" ||
    fault.stateVersion !== exactState.stateVersion ||
    fault.createdAt !== deployment.updatedAt
  ) {
    throw new Error("PositionGuard pilot canonical fault transition audit is invalid.");
  }
  const payload = parseExactJsonObject(
    fault.payloadJson,
    "PositionGuard pilot canonical fault audit payload",
    ["reasonCode", "provenanceJson"] as const,
  );
  if (
    typeof payload.reasonCode !== "string" ||
    !RECOVERY_FAULT_REASONS.includes(payload.reasonCode as typeof RECOVERY_FAULT_REASONS[number]) ||
    typeof payload.provenanceJson !== "string"
  ) {
    throw new Error("PositionGuard pilot canonical fault audit payload is invalid.");
  }
  parseExactJsonObject(payload.provenanceJson, "PositionGuard pilot fault provenance", null);
  if (fault.payloadJson !== JSON.stringify({
    reasonCode: payload.reasonCode,
    provenanceJson: payload.provenanceJson,
  })) {
    throw new Error("PositionGuard pilot canonical fault audit payload is not canonical JSON.");
  }
  const faultAt = strictTimestamp(fault.createdAt, "persisted fault audit createdAt");
  const latestEvidence = evidenceRecords.at(-1);
  if (
    latestEvidence !== undefined &&
    faultAt < strictTimestamp(latestEvidence.evidence.executedAt, "persisted evidence executedAt")
  ) {
    throw new Error("PositionGuard pilot fault audit precedes exact evidence chronology.");
  }
}

function assertCanonicalRollbackStartedAudit(
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  exactState: Readonly<ExactCandidateState>,
  evidenceRecords: readonly Readonly<CandidateEvidenceRecord>[],
  auditEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
  rollbackEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
  faultEvent: Readonly<PositionGuardPilotAuditEventRecord>,
): void {
  if (
    rollbackEvents.length !== 1 ||
    deployment.activationAt === null ||
    deployment.activationEpochNs === null
  ) {
    throw new Error("DRAINING fault restart requires exactly one canonical rollback-start audit.");
  }
  const rollback = rollbackEvents[0]!;
  const payload = parseExactJsonObject(
    rollback.payloadJson,
    "PositionGuard pilot canonical rollback audit payload",
    ["transitionAt"] as const,
  );
  if (typeof payload.transitionAt !== "string") {
    throw new Error("PositionGuard pilot canonical rollback audit payload is invalid.");
  }
  const transitionAtEpochNs = strictTimestamp(
    payload.transitionAt,
    "persisted rollback transitionAt",
  );
  const expectedRollback = {
    id: `${deployment.id}:rollback_started:${transitionAtEpochNs.toString()}`,
    deploymentId: deployment.id,
    eventType: "ROLLBACK_STARTED",
    fromPhase: "ACTIVE",
    toPhase: "DRAINING",
    stateVersion: exactState.stateVersion,
    payloadJson: JSON.stringify({ transitionAt: payload.transitionAt }),
    createdAt: payload.transitionAt,
  } as const;
  if (!recordsEqual(rollback, expectedRollback, AUDIT_KEYS)) {
    throw new Error("PositionGuard pilot canonical rollback-start audit is invalid.");
  }

  const rollbackAt = strictTimestamp(rollback.createdAt, "persisted rollback audit createdAt");
  const faultAt = strictTimestamp(faultEvent.createdAt, "persisted fault audit createdAt");
  const activationAt = strictTimestamp(deployment.activationAt, "persisted deployment activationAt");
  const latestEvidence = evidenceRecords.at(-1);
  if (
    rollbackAt < activationAt ||
    rollbackAt > faultAt ||
    (latestEvidence !== undefined && rollbackAt < strictTimestamp(
      latestEvidence.evidence.executedAt,
      "persisted evidence executedAt",
    )) ||
    auditEvents.indexOf(rollback) >= auditEvents.indexOf(faultEvent)
  ) {
    throw new Error("PositionGuard pilot rollback-start audit violates exact lifecycle chronology.");
  }
}

function assertExactStateMatchesEvidence(
  exactState: Readonly<ExactCandidateState>,
  evidenceRecords: readonly Readonly<CandidateEvidenceRecord>[],
): void {
  const projected = projectExactCandidateState(evidenceRecords.map((record) => record.evidence));
  if (!recordsEqual(exactState, projected, EXACT_STATE_KEYS)) {
    throw new Error("PositionGuard pilot exact state does not match persisted evidence material.");
  }
}

function assertCanonicalCreationAudit(
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  auditEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
): void {
  const creationEvents = auditEvents.filter((event) => event.eventType === "DEPLOYMENT_CREATED");
  const expected = {
    id: `${deployment.id}:created`,
    deploymentId: deployment.id,
    eventType: "DEPLOYMENT_CREATED",
    fromPhase: null,
    toPhase: "PENDING_FLAT",
    stateVersion: 0,
    payloadJson: JSON.stringify({
      pilotId: deployment.pilotId,
      market: deployment.market,
      policyId: deployment.policyId,
      policyVersion: deployment.policyVersion,
    }),
    createdAt: deployment.createdAt,
  } as const;
  if (creationEvents.length !== 1 || !recordsEqual(creationEvents[0]!, expected, AUDIT_KEYS)) {
    throw new Error("PositionGuard pilot canonical DEPLOYMENT_CREATED audit authority is invalid.");
  }
}

function assertPristinePendingAuthority(
  deployment: Readonly<PositionGuardPilotDeploymentRecord>,
  exactState: Readonly<ExactCandidateState>,
  evidenceRecords: readonly Readonly<CandidateEvidenceRecord>[],
  auditEvents: readonly Readonly<PositionGuardPilotAuditEventRecord>[],
): void {
  if (deployment.activationAt !== null || deployment.activationEpochNs !== null) {
    throw new Error("PENDING_FLAT PositionGuard pilot must not contain activation authority.");
  }
  if (deployment.updatedAt !== deployment.createdAt) {
    throw new Error("PENDING_FLAT PositionGuard pilot must preserve its pristine creation timestamp.");
  }
  if (!recordsEqual(exactState, createExactEmptyCandidateState(), EXACT_STATE_KEYS)) {
    throw new Error("PENDING_FLAT PositionGuard pilot requires pristine exact state.");
  }
  if (evidenceRecords.length !== 0) {
    throw new Error("PENDING_FLAT PositionGuard pilot must not contain execution evidence.");
  }
  if (auditEvents.length !== 1) {
    throw new Error("PENDING_FLAT PositionGuard pilot requires exactly one creation audit event.");
  }
}

function exactDensePlainArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be an exact dense plain array.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.enumerable ||
    lengthDescriptor.configurable ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    (lengthDescriptor.value as number) < 0
  ) {
    throw new Error(`${label} must contain an exact ordinary length data property.`);
  }
  const length = lengthDescriptor.value as number;
  const expectedKeys = [...Array.from({ length }, (_, index) => String(index)), "length"];
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new Error(`${label} must be dense and contain no extra own properties.`);
  }
  const descriptors = Array.from({ length }, (_, index) =>
    Object.getOwnPropertyDescriptor(value, String(index))
  );
  if (descriptors.some((descriptor) =>
    descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)
  )) {
    throw new Error(`${label} must contain ordinary enumerable own data index properties.`);
  }
  return Object.freeze(descriptors.map((descriptor) => descriptor!.value));
}

function parseExactJsonObject<K extends readonly string[]>(
  value: string,
  label: string,
  expectedKeys: K | null,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    throw new Error(`${label} must contain a plain object.`);
  }
  return expectedKeys === null
    ? parsed as Record<string, unknown>
    : exactOwnDataRecord(parsed, label, expectedKeys);
}

function exactOwnDataRecord<K extends readonly string[]>(
  value: unknown,
  label: string,
  expectedKeys: K,
): Record<K[number], unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an exact plain own-data object.`);
  }
  const actualKeys = Reflect.ownKeys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new Error(`${label} must contain exactly the approved own data properties.`);
  }
  const snapshot = {} as Record<K[number], unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must contain enumerable own data properties only.`);
    }
    snapshot[key as K[number]] = descriptor.value;
  }
  return snapshot;
}

function recordsEqual<K extends readonly string[]>(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  keys: K,
): boolean {
  return keys.every((key) => left[key] === right[key]);
}

function strictTimestamp(value: unknown, label: string): bigint {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a strict ISO-8601 timestamp string.`);
  }
  return parseCandidatePilotTimestamp(value, label);
}

function assertNotFuture(value: bigint, now: bigint, label: string): void {
  if (value > now) {
    throw new Error(`${label} cannot be in the future.`);
  }
}
