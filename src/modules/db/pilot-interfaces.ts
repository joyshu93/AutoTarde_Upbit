import { createHash } from "node:crypto";

import type {
  AccountExecutionLeaseRecord,
  CandidateExecutionBindingRecord,
  PositionGuardPilotAuditEventRecord,
  PositionGuardPilotDeploymentRecord,
} from "../../domain/pilot-types.js";
import type { ExecutionStateRecord, ExecutionStateTransitionRecord } from "../../domain/types.js";
import type { FaultPauseInput } from "./interfaces.js";
import {
  canonicalNonNegativeDecimal,
  type ExactCandidateState,
} from "../execution/candidate-evidence-decimals.js";
import {
  parsePositionGuardCandidateTimestamp,
  type PositionGuardCandidateExecutionEvidence,
  type PositionGuardCandidateState,
} from "../strategy/position-guard-candidate-state.js";

export function parseCandidatePilotTimestamp(value: string, label: string): bigint {
  return parsePositionGuardCandidateTimestamp(value, label);
}

export interface CreateCandidatePilotDeploymentInput {
  deployment: PositionGuardPilotDeploymentRecord;
  initialState: PositionGuardCandidateState;
}

export interface ActivateCandidatePilotDeploymentInput {
  deploymentId: string;
  expectedPhase: "PENDING_FLAT";
  expectedUpdatedAt: string;
  activationAt: string;
  activationEpochNs: bigint;
}

export interface AdvanceCandidatePilotStateInput {
  deploymentId: string;
  expectedStateVersion: number;
  evidence: PositionGuardCandidateExecutionEvidence;
}

export interface AdvanceCandidatePilotStateResult {
  state: Readonly<PositionGuardCandidateState>;
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>;
  duplicate: boolean;
}

export type CandidateMaterialVersion = "LEGACY_APPROXIMATE_V1" | "EXACT_V2";

export interface CandidateEvidenceRecord {
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>;
  materialHash: string;
  materialVersion: CandidateMaterialVersion;
}

export type CandidatePilotRecoveryFaultReason =
  | "SNAPSHOT_PROVENANCE_INVALID"
  | "STALE_SNAPSHOT"
  | "IDENTITY_MISMATCH"
  | "REPLAY_MISMATCH"
  | "INVENTORY_MISMATCH"
  | "BLOCKING_RECONCILIATION"
  | "ACTIVE_ORDER"
  | "UNCERTAIN_ORDER"
  | "ACTIVATION_CAS_CONFLICT";

export interface PauseCandidatePilotForRecoveryFaultInput {
  deploymentId: string;
  exchangeAccountId: string;
  faultId: string;
  reasonCode: CandidatePilotRecoveryFaultReason;
  provenanceJson: string;
  occurredAt: string;
}

export type CandidateIntentFaultStage =
  | "DUPLICATE"
  | "DERIVATION"
  | "PERSISTENCE"
  | "FINAL_REVALIDATION";

export interface PauseCandidateIntentFaultInput extends PauseCandidatePilotForRecoveryFaultInput {
  stage: CandidateIntentFaultStage;
  strategyDecisionId: string;
  orderId: string;
  bindingId: string;
}

export interface PauseCandidatePilotForRecoveryFaultResult {
  deployment: PositionGuardPilotDeploymentRecord;
  executionState: ExecutionStateRecord;
  auditEvent: PositionGuardPilotAuditEventRecord;
  duplicate: boolean;
}

export interface InMemoryAtomicFaultPauseStore {
  getState(): Promise<ExecutionStateRecord>;
  listTransitions(limit?: number): Promise<ExecutionStateTransitionRecord[]>;
  getTransitionById?(id: string): Promise<ExecutionStateTransitionRecord | null>;
  applyFaultPauseAtomically(input: FaultPauseInput): ExecutionStateRecord;
}

export interface CandidatePilotRepository {
  createDeploymentWithInitialState(
    input: CreateCandidatePilotDeploymentInput,
  ): Promise<PositionGuardPilotDeploymentRecord>;
  getDeployment(deploymentId: string): Promise<PositionGuardPilotDeploymentRecord | null>;
  getDeploymentForExchangeAccount(
    exchangeAccountId: string,
  ): Promise<PositionGuardPilotDeploymentRecord | null>;
  activateDeployment(
    input: ActivateCandidatePilotDeploymentInput,
  ): Promise<PositionGuardPilotDeploymentRecord | null>;
  getState(deploymentId: string): Promise<Readonly<PositionGuardCandidateState> | null>;
  getExactState(deploymentId: string): Promise<Readonly<ExactCandidateState> | null>;
  listEvidenceAfter(
    deploymentId: string,
    afterEvidenceId: string | null,
  ): Promise<Array<Readonly<PositionGuardCandidateExecutionEvidence>>>;
  listEvidenceRecords(
    deploymentId: string,
  ): Promise<Array<Readonly<CandidateEvidenceRecord>>>;
  getEvidenceRecord(
    deploymentId: string,
    evidenceId: string,
  ): Promise<Readonly<CandidateEvidenceRecord> | null>;
  listAuditEvents(deploymentId: string): Promise<PositionGuardPilotAuditEventRecord[]>;
  createExecutionBinding(input: CandidateExecutionBindingRecord): Promise<CandidateExecutionBindingRecord>;
  getExecutionBindingForOrder(orderId: string): Promise<CandidateExecutionBindingRecord | null>;
  advanceStateWithEvidence(
    input: AdvanceCandidatePilotStateInput,
  ): Promise<AdvanceCandidatePilotStateResult>;
  pauseForRecoveryFault(
    input: PauseCandidatePilotForRecoveryFaultInput,
  ): Promise<PauseCandidatePilotForRecoveryFaultResult>;
  pauseForCandidateIntentFault(
    input: PauseCandidateIntentFaultInput,
  ): Promise<PauseCandidatePilotForRecoveryFaultResult>;
}

export interface AcquireAccountExecutionLeaseInput {
  exchangeAccountId: string;
  ownerToken: string;
  purpose: AccountExecutionLeaseRecord["purpose"];
  acquiredAtEpochMs: number;
  expiresAtEpochMs: number;
}

export interface RenewAccountExecutionLeaseInput {
  exchangeAccountId: string;
  ownerToken: string;
  renewedAtEpochMs: number;
  expiresAtEpochMs: number;
}

export interface AccountExecutionLeaseStore {
  getLease(exchangeAccountId: string): Promise<AccountExecutionLeaseRecord | null>;
  acquireLease(input: AcquireAccountExecutionLeaseInput): Promise<AccountExecutionLeaseRecord | null>;
  renewLease(input: RenewAccountExecutionLeaseInput): Promise<AccountExecutionLeaseRecord | null>;
  releaseLease(exchangeAccountId: string, ownerToken: string): Promise<boolean>;
}

const DEPLOYMENT_KEYS = [
  "id",
  "exchangeAccountId",
  "pilotId",
  "market",
  "policyId",
  "policyVersion",
  "phase",
  "activationAt",
  "activationEpochNs",
  "createdAt",
  "updatedAt",
] as const;
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
const BINDING_KEYS = [
  "id",
  "deploymentId",
  "strategyDecisionId",
  "orderId",
  "exchangeAccountId",
  "activationAt",
  "activationEpochNs",
  "market",
  "strategyKey",
  "policyId",
  "policyVersion",
  "executionMode",
  "ordType",
  "action",
  "side",
  "intendedQuantity",
  "intendedNotionalKrw",
  "boundPrice",
  "boundVolume",
  "boundTimeInForce",
  "boundSmpType",
  "materialVersion",
  "orderMaterialHash",
  "createdAt",
] as const;
const PILOT_PHASES = ["DISABLED", "PENDING_FLAT", "ACTIVE", "PAUSED_FAULT", "DRAINING"] as const;
const EVIDENCE_ACTIONS = ["ENTER", "ADD", "REDUCE", "EXIT"] as const;
const ENTRY_PATHS = ["PULLBACK", "RECLAIM", "BREAKOUT_HOLD", "NONE"] as const;

export function validateCandidatePilotDeployment(
  value: PositionGuardPilotDeploymentRecord,
): PositionGuardPilotDeploymentRecord {
  const record = exactOwnDataRecord(value, "candidate pilot deployment", DEPLOYMENT_KEYS);
  const deployment = {
    id: record.id,
    exchangeAccountId: record.exchangeAccountId,
    pilotId: record.pilotId,
    market: record.market,
    policyId: record.policyId,
    policyVersion: record.policyVersion,
    phase: record.phase,
    activationAt: record.activationAt,
    activationEpochNs: record.activationEpochNs,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  } as PositionGuardPilotDeploymentRecord;
  requireNonEmpty(deployment.id, "deployment id");
  requireNonEmpty(deployment.exchangeAccountId, "deployment exchangeAccountId");
  if (
    deployment.pilotId !== "BTC_COMBINED_CONSERVATIVE_PILOT_V1" ||
    deployment.market !== "KRW-BTC" ||
    deployment.policyId !== "COMBINED_CONSERVATIVE" ||
    deployment.policyVersion !== "PCS-2026-001.DEPLOYMENT_READINESS_V1"
  ) {
    throw new Error("Candidate pilot deployment must use the exact approved identity.");
  }
  if (!PILOT_PHASES.includes(deployment.phase)) {
    throw new Error("Candidate pilot deployment phase is invalid.");
  }
  const createdAt = parsePositionGuardCandidateTimestamp(
    deployment.createdAt,
    "deployment createdAt",
  );
  const updatedAt = parsePositionGuardCandidateTimestamp(
    deployment.updatedAt,
    "deployment updatedAt",
  );
  if (updatedAt < createdAt) {
    throw new Error("Candidate pilot deployment updatedAt cannot precede createdAt.");
  }
  if ((deployment.activationAt === null) !== (deployment.activationEpochNs === null)) {
    throw new Error("Candidate pilot deployment activation timestamp and epoch must be persisted together.");
  }
  if (deployment.activationAt !== null && deployment.activationEpochNs !== null) {
    const activationEpochNs = parsePositionGuardCandidateTimestamp(
      deployment.activationAt,
      "deployment activationAt",
    );
    if (activationEpochNs < 0n || activationEpochNs !== deployment.activationEpochNs) {
      throw new Error("Candidate pilot deployment activation epoch does not match its timestamp.");
    }
  }
  if ((deployment.phase === "ACTIVE" || deployment.phase === "DRAINING") && deployment.activationAt === null) {
    throw new Error("Active candidate pilot deployments require a persisted activation instant.");
  }
  return deployment;
}

export function candidateEvidenceMaterial(
  deploymentId: string,
  evidence: PositionGuardCandidateExecutionEvidence,
): {
  hash: string;
  epochNanoseconds: bigint;
  evidence: PositionGuardCandidateExecutionEvidence;
  materialVersion: "EXACT_V2";
} {
  requireNonEmpty(deploymentId, "deploymentId");
  const record = exactOwnDataRecord(evidence, "candidate execution evidence", EVIDENCE_KEYS);
  const snapshot: PositionGuardCandidateExecutionEvidence = {
    evidenceId: record.evidenceId as string,
    executedAt: record.executedAt as string,
    action: record.action as PositionGuardCandidateExecutionEvidence["action"],
    entryPath: record.entryPath as PositionGuardCandidateExecutionEvidence["entryPath"],
    terminalStatus: record.terminalStatus as PositionGuardCandidateExecutionEvidence["terminalStatus"],
    executedQuantity: canonicalNonNegativeDecimal(record.executedQuantity, "executedQuantity"),
    grossQuoteValueKrw: canonicalNonNegativeDecimal(record.grossQuoteValueKrw, "grossQuoteValueKrw"),
    confirmedFeeKrw: canonicalNonNegativeDecimal(record.confirmedFeeKrw, "confirmedFeeKrw"),
    remainingQuantity: canonicalNonNegativeDecimal(record.remainingQuantity, "remainingQuantity"),
  };
  requireNonEmpty(snapshot.evidenceId, "evidenceId");
  if (!EVIDENCE_ACTIONS.includes(snapshot.action)) {
    throw new Error("Candidate execution evidence action is invalid.");
  }
  if (!ENTRY_PATHS.includes(snapshot.entryPath)) {
    throw new Error("Candidate execution evidence entryPath is invalid.");
  }
  if (snapshot.terminalStatus !== "FILLED" && snapshot.terminalStatus !== "CANCELED") {
    throw new Error("Candidate execution evidence terminalStatus is invalid.");
  }
  if (isZeroDecimal(snapshot.executedQuantity)) {
    if (
      snapshot.terminalStatus !== "CANCELED" ||
      !isZeroDecimal(snapshot.grossQuoteValueKrw) ||
      !isZeroDecimal(snapshot.confirmedFeeKrw)
    ) {
      throw new Error("Candidate no-fill evidence must be canceled with zero value and fee.");
    }
  } else if (
    isZeroDecimal(snapshot.grossQuoteValueKrw)
  ) {
    throw new Error("Candidate filled evidence must have a finite positive quote value.");
  }
  const epochNanoseconds = parsePositionGuardCandidateTimestamp(
    snapshot.executedAt,
    "evidence executedAt",
  );
  if (epochNanoseconds < 0n) {
    throw new Error("Candidate evidence executedAt cannot be before the Unix epoch.");
  }
  const canonical = JSON.stringify({
    schemaVersion: 2,
    materialVersion: "EXACT_V2",
    deploymentId,
    evidenceId: snapshot.evidenceId,
    executedAt: snapshot.executedAt,
    executedAtEpochNs: epochNanoseconds.toString(),
    action: snapshot.action,
    entryPath: snapshot.entryPath,
    terminalStatus: snapshot.terminalStatus,
    executedQuantity: snapshot.executedQuantity,
    grossQuoteValueKrw: snapshot.grossQuoteValueKrw,
    confirmedFeeKrw: snapshot.confirmedFeeKrw,
    remainingQuantity: snapshot.remainingQuantity,
  });
  return {
    hash: createHash("sha256").update(canonical, "utf8").digest("hex"),
    epochNanoseconds,
    evidence: snapshot,
    materialVersion: "EXACT_V2",
  };
}

export function validateCandidatePilotRecoveryFaultInput(
  input: PauseCandidatePilotForRecoveryFaultInput,
): void {
  exactOwnDataRecord(input, "candidate recovery fault input", [
    "deploymentId",
    "exchangeAccountId",
    "faultId",
    "reasonCode",
    "provenanceJson",
    "occurredAt",
  ] as const);
  requireNonEmpty(input.deploymentId, "candidate recovery fault deploymentId");
  requireNonEmpty(input.exchangeAccountId, "candidate recovery fault exchangeAccountId");
  requireNonEmpty(input.faultId, "candidate recovery fault faultId");
  requireNonEmpty(input.reasonCode, "candidate recovery fault reasonCode");
  parsePositionGuardCandidateTimestamp(input.occurredAt, "candidate recovery fault occurredAt");
  let provenance: unknown;
  try {
    provenance = JSON.parse(input.provenanceJson) as unknown;
  } catch {
    throw new Error("Candidate recovery fault provenanceJson must be valid JSON.");
  }
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) {
    throw new Error("Candidate recovery fault provenanceJson must contain an object.");
  }
}

const CANDIDATE_INTENT_FAULT_INPUT_KEYS = [
  "deploymentId",
  "exchangeAccountId",
  "stage",
  "strategyDecisionId",
  "orderId",
  "bindingId",
  "faultId",
  "reasonCode",
  "provenanceJson",
  "occurredAt",
] as const;
const CANDIDATE_INTENT_FAULT_PROVENANCE_KEYS = [
  "schemaVersion",
  "stage",
  "deploymentId",
  "exchangeAccountId",
  "strategyDecisionId",
  "orderId",
  "bindingId",
  "market",
  "action",
  "side",
  "ordType",
  "price",
  "volume",
  "expectedPhase",
  "expectedDeploymentUpdatedAt",
  "expectedStateVersion",
] as const;
const CANDIDATE_INTENT_FAULT_STAGES = [
  "DUPLICATE",
  "DERIVATION",
  "PERSISTENCE",
  "FINAL_REVALIDATION",
] as const;

export function validateCandidateIntentFaultInput(
  input: PauseCandidateIntentFaultInput,
): PauseCandidatePilotForRecoveryFaultInput {
  exactOwnDataRecord(input, "candidate intent fault input", CANDIDATE_INTENT_FAULT_INPUT_KEYS);
  requireNonEmpty(input.deploymentId, "candidate intent fault deploymentId");
  requireNonEmpty(input.exchangeAccountId, "candidate intent fault exchangeAccountId");
  requireNonEmpty(input.strategyDecisionId, "candidate intent fault strategyDecisionId");
  requireNonEmpty(input.orderId, "candidate intent fault orderId");
  requireNonEmpty(input.bindingId, "candidate intent fault bindingId");
  requireNonEmpty(input.faultId, "candidate intent fault faultId");
  if (!CANDIDATE_INTENT_FAULT_STAGES.includes(input.stage)) {
    throw new Error("Candidate intent fault stage is invalid.");
  }
  const expectedReasonCode: CandidatePilotRecoveryFaultReason = input.stage === "PERSISTENCE"
    ? "ACTIVATION_CAS_CONFLICT"
    : "IDENTITY_MISMATCH";
  if (input.reasonCode !== expectedReasonCode) {
    throw new Error("Candidate intent fault reason does not match its stage.");
  }
  parsePositionGuardCandidateTimestamp(input.occurredAt, "candidate intent fault occurredAt");

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.provenanceJson) as unknown;
  } catch {
    throw new Error("Candidate intent fault provenanceJson must be valid JSON.");
  }
  const provenance = exactOwnDataRecord(
    parsed,
    "candidate intent fault provenance",
    CANDIDATE_INTENT_FAULT_PROVENANCE_KEYS,
  );
  if (provenance.schemaVersion !== "CANDIDATE_INTENT_FAULT_V1") {
    throw new Error("Candidate intent fault provenance schema is invalid.");
  }
  if (!CANDIDATE_INTENT_FAULT_STAGES.includes(provenance.stage as CandidateIntentFaultStage)) {
    throw new Error("Candidate intent fault provenance stage is invalid.");
  }
  if (
    provenance.stage !== input.stage ||
    provenance.deploymentId !== input.deploymentId ||
    provenance.exchangeAccountId !== input.exchangeAccountId ||
    provenance.strategyDecisionId !== input.strategyDecisionId ||
    provenance.orderId !== input.orderId ||
    provenance.bindingId !== input.bindingId
  ) {
    throw new Error("Candidate intent fault provenance identity does not match the request.");
  }
  if (
    provenance.market !== "KRW-BTC" ||
    !EVIDENCE_ACTIONS.includes(provenance.action as typeof EVIDENCE_ACTIONS[number]) ||
    (provenance.side !== "bid" && provenance.side !== "ask") ||
    !["limit", "price", "market", "best"].includes(provenance.ordType as string) ||
    (provenance.expectedPhase !== "ACTIVE" && provenance.expectedPhase !== "DRAINING") ||
    !Number.isSafeInteger(provenance.expectedStateVersion) ||
    (provenance.expectedStateVersion as number) < 0
  ) {
    throw new Error("Candidate intent fault provenance material is invalid.");
  }
  if (typeof provenance.expectedDeploymentUpdatedAt !== "string") {
    throw new Error("Candidate intent fault expected deployment timestamp is invalid.");
  }
  parsePositionGuardCandidateTimestamp(
    provenance.expectedDeploymentUpdatedAt,
    "candidate intent fault expectedDeploymentUpdatedAt",
  );
  for (const [label, value] of [["price", provenance.price], ["volume", provenance.volume]] as const) {
    if (value !== null) {
      canonicalNonNegativeDecimal(value, `candidate intent fault ${label}`);
    }
  }
  const expectedFaultId = `candidate-intent:${createHash("sha256")
    .update(input.provenanceJson, "utf8")
    .digest("hex")}`;
  if (input.faultId !== expectedFaultId) {
    throw new Error("Candidate intent fault ID does not match the deterministic provenance hash.");
  }

  return {
    deploymentId: input.deploymentId,
    exchangeAccountId: input.exchangeAccountId,
    faultId: input.faultId,
    reasonCode: input.reasonCode,
    provenanceJson: input.provenanceJson,
    occurredAt: input.occurredAt,
  };
}

export function resolveCandidateIntentFaultOccurrence(
  input: PauseCandidateIntentFaultInput,
  persistedChronology: readonly string[],
): PauseCandidatePilotForRecoveryFaultInput {
  const fault = validateCandidateIntentFaultInput(input);
  const attemptedEpoch = parsePositionGuardCandidateTimestamp(
    fault.occurredAt,
    "candidate intent fault attempted occurredAt",
  );
  const latestPersistedEpoch = persistedChronology.reduce<bigint | null>((latest, timestamp) => {
    const epoch = parsePositionGuardCandidateTimestamp(
      timestamp,
      "candidate intent fault persisted chronology",
    );
    return latest === null || epoch > latest ? epoch : latest;
  }, null);
  const effectiveEpoch = latestPersistedEpoch !== null && attemptedEpoch <= latestPersistedEpoch
    ? latestPersistedEpoch + 1n
    : attemptedEpoch;
  return {
    ...fault,
    occurredAt: formatCandidatePilotUtcNanoseconds(effectiveEpoch),
  };
}

function formatCandidatePilotUtcNanoseconds(epochNanoseconds: bigint): string {
  const nanosecondsPerSecond = 1_000_000_000n;
  const millisecondsPerSecond = 1_000n;
  const maximumDateMilliseconds = 8_640_000_000_000_000n;
  if (epochNanoseconds < 0n) {
    throw new Error("Candidate intent fault occurrence cannot precede the Unix epoch.");
  }
  const wholeSeconds = epochNanoseconds / nanosecondsPerSecond;
  const fractionalNanoseconds = epochNanoseconds % nanosecondsPerSecond;
  const wholeMilliseconds = wholeSeconds * millisecondsPerSecond;
  if (wholeMilliseconds > maximumDateMilliseconds) {
    throw new Error("Candidate intent fault occurrence exceeds the supported UTC range.");
  }
  const iso = new Date(Number(wholeMilliseconds)).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u.test(iso)) {
    throw new Error("Candidate intent fault occurrence exceeds the supported canonical UTC range.");
  }
  return `${iso.slice(0, 19)}.${fractionalNanoseconds.toString().padStart(9, "0")}Z`;
}

export function candidatePilotRecoveryFaultReason(
  input: PauseCandidatePilotForRecoveryFaultInput,
): string {
  return `candidate_pilot_recovery:${input.reasonCode}; provenance=${input.provenanceJson}`;
}

export function buildCandidatePilotRecoveryFaultAuditEvent(input: {
  fault: PauseCandidatePilotForRecoveryFaultInput;
  fromPhase: PositionGuardPilotDeploymentRecord["phase"];
  stateVersion: number;
}): PositionGuardPilotAuditEventRecord {
  return {
    id: input.fault.faultId,
    deploymentId: input.fault.deploymentId,
    eventType: "FAULT_PAUSED",
    fromPhase: input.fromPhase,
    toPhase: "PAUSED_FAULT",
    stateVersion: input.stateVersion,
    payloadJson: JSON.stringify({
      reasonCode: input.fault.reasonCode,
      provenanceJson: input.fault.provenanceJson,
    }),
    createdAt: input.fault.occurredAt,
  };
}

export function validateCandidateExecutionBinding(
  value: CandidateExecutionBindingRecord,
): CandidateExecutionBindingRecord {
  const record = exactOwnDataRecord(value, "candidate execution binding", BINDING_KEYS);
  const binding = {
    id: record.id,
    deploymentId: record.deploymentId,
    strategyDecisionId: record.strategyDecisionId,
    orderId: record.orderId,
    exchangeAccountId: record.exchangeAccountId,
    activationAt: record.activationAt,
    activationEpochNs: record.activationEpochNs,
    market: record.market,
    strategyKey: record.strategyKey,
    policyId: record.policyId,
    policyVersion: record.policyVersion,
    executionMode: record.executionMode,
    ordType: record.ordType,
    action: record.action,
    side: record.side,
    intendedQuantity: record.intendedQuantity,
    intendedNotionalKrw: record.intendedNotionalKrw,
    boundPrice: record.boundPrice,
    boundVolume: record.boundVolume,
    boundTimeInForce: record.boundTimeInForce,
    boundSmpType: record.boundSmpType,
    materialVersion: record.materialVersion,
    orderMaterialHash: record.orderMaterialHash,
    createdAt: record.createdAt,
  } as CandidateExecutionBindingRecord;
  for (const field of [
    binding.id,
    binding.deploymentId,
    binding.strategyDecisionId,
    binding.orderId,
    binding.exchangeAccountId,
  ]) {
    requireNonEmpty(field, "candidate execution binding identity");
  }
  if (
    binding.market !== "KRW-BTC" ||
    binding.strategyKey !== "position_guard.paper_core.v1" ||
    binding.policyId !== "COMBINED_CONSERVATIVE" ||
    binding.policyVersion !== "PCS-2026-001.DEPLOYMENT_READINESS_V1" ||
    !["DRY_RUN", "LIVE"].includes(binding.executionMode) ||
    !["limit", "price", "market", "best"].includes(binding.ordType) ||
    !EVIDENCE_ACTIONS.includes(binding.action) ||
    !["bid", "ask"].includes(binding.side)
  ) {
    throw new Error("Candidate execution binding has an invalid persisted provenance identity.");
  }
  const activationEpochNs = parsePositionGuardCandidateTimestamp(binding.activationAt, "binding activationAt");
  if (activationEpochNs < 0n || activationEpochNs !== binding.activationEpochNs) {
    throw new Error("Candidate execution binding activation epoch does not match its timestamp.");
  }
  parsePositionGuardCandidateTimestamp(binding.createdAt, "binding createdAt");
  if (binding.intendedQuantity !== null) {
    canonicalNonNegativeDecimal(binding.intendedQuantity, "binding intendedQuantity");
  }
  if (binding.intendedNotionalKrw !== null) {
    canonicalNonNegativeDecimal(binding.intendedNotionalKrw, "binding intendedNotionalKrw");
  }
  if (binding.boundPrice !== null) {
    canonicalNonNegativeDecimal(binding.boundPrice, "binding boundPrice");
  }
  if (binding.boundVolume !== null) {
    canonicalNonNegativeDecimal(binding.boundVolume, "binding boundVolume");
  }
  if (binding.boundTimeInForce !== null && !["ioc", "fok", "post_only"].includes(binding.boundTimeInForce)) {
    throw new Error("Candidate execution binding boundTimeInForce is invalid.");
  }
  if (binding.boundSmpType !== null && !["cancel_maker", "cancel_taker", "reduce"].includes(binding.boundSmpType)) {
    throw new Error("Candidate execution binding boundSmpType is invalid.");
  }
  if (binding.materialVersion !== "BINDING_V2" || !/^[a-f0-9]{64}$/u.test(binding.orderMaterialHash)) {
    throw new Error("Candidate execution binding material version or hash is invalid.");
  }
  if (parsePositionGuardCandidateTimestamp(binding.createdAt, "binding createdAt") <= activationEpochNs) {
    throw new Error("Candidate execution binding must be created after its activation instant.");
  }
  if (candidateExecutionBindingMaterialHash(binding) !== binding.orderMaterialHash) {
    throw new Error("Candidate execution binding material hash does not match its persisted shape.");
  }
  return binding;
}

export function candidateExecutionBindingMaterialHash(
  binding: Omit<CandidateExecutionBindingRecord, "orderMaterialHash"> & { orderMaterialHash?: string },
): string {
  const canonical = JSON.stringify({
    schemaVersion: 2,
    materialVersion: binding.materialVersion,
    id: binding.id,
    deploymentId: binding.deploymentId,
    strategyDecisionId: binding.strategyDecisionId,
    orderId: binding.orderId,
    exchangeAccountId: binding.exchangeAccountId,
    activationAt: binding.activationAt,
    activationEpochNs: binding.activationEpochNs.toString(),
    market: binding.market,
    strategyKey: binding.strategyKey,
    policyId: binding.policyId,
    policyVersion: binding.policyVersion,
    executionMode: binding.executionMode,
    ordType: binding.ordType,
    action: binding.action,
    side: binding.side,
    intendedQuantity: binding.intendedQuantity,
    intendedNotionalKrw: binding.intendedNotionalKrw,
    boundPrice: binding.boundPrice,
    boundVolume: binding.boundVolume,
    boundTimeInForce: binding.boundTimeInForce,
    boundSmpType: binding.boundSmpType,
    createdAt: binding.createdAt,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function validateLeaseWindow(
  ownerToken: string,
  atEpochMs: number,
  expiresAtEpochMs: number,
): void {
  requireNonEmpty(ownerToken, "ownerToken");
  if (!Number.isSafeInteger(atEpochMs) || atEpochMs < 0) {
    throw new Error("Account execution lease time must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(expiresAtEpochMs) || expiresAtEpochMs <= atEpochMs) {
    throw new Error("Account execution lease expiry must be a safe integer after its operation time.");
  }
}

function isZeroDecimal(value: unknown): boolean {
  return value === "0";
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function exactOwnDataRecord<const TKeys extends readonly string[]>(
  value: unknown,
  label: string,
  expectedKeys: TKeys,
): Record<TKeys[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object with exactly own data properties.`);
  }
  const expected = new Set<string>(expectedKeys);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new Error(`${label} must have exactly own data properties: ${expectedKeys.join(", ")}.`);
  }
  const result = {} as Record<TKeys[number], unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label} must have exactly own data properties: ${expectedKeys.join(", ")}.`);
    }
    result[key as TKeys[number]] = descriptor.value;
  }
  return result;
}
