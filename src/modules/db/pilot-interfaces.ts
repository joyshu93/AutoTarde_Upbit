import { createHash } from "node:crypto";

import type {
  AccountExecutionLeaseRecord,
  PositionGuardPilotAuditEventRecord,
  PositionGuardPilotDeploymentRecord,
} from "../../domain/pilot-types.js";
import {
  parsePositionGuardCandidateTimestamp,
  type PositionGuardCandidateDecimal,
  type PositionGuardCandidateExecutionEvidence,
  type PositionGuardCandidateState,
} from "../strategy/position-guard-candidate-state.js";

export interface CreateCandidatePilotDeploymentInput {
  deployment: PositionGuardPilotDeploymentRecord;
  initialState: PositionGuardCandidateState;
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

export interface CandidatePilotRepository {
  createDeploymentWithInitialState(
    input: CreateCandidatePilotDeploymentInput,
  ): Promise<PositionGuardPilotDeploymentRecord>;
  getDeployment(deploymentId: string): Promise<PositionGuardPilotDeploymentRecord | null>;
  getDeploymentForExchangeAccount(
    exchangeAccountId: string,
  ): Promise<PositionGuardPilotDeploymentRecord | null>;
  getState(deploymentId: string): Promise<Readonly<PositionGuardCandidateState> | null>;
  listEvidenceAfter(
    deploymentId: string,
    afterEvidenceId: string | null,
  ): Promise<Array<Readonly<PositionGuardCandidateExecutionEvidence>>>;
  listAuditEvents(deploymentId: string): Promise<PositionGuardPilotAuditEventRecord[]>;
  advanceStateWithEvidence(
    input: AdvanceCandidatePilotStateInput,
  ): Promise<AdvanceCandidatePilotStateResult>;
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
  return deployment;
}

export function candidateEvidenceMaterial(
  deploymentId: string,
  evidence: PositionGuardCandidateExecutionEvidence,
): { hash: string; epochNanoseconds: bigint; evidence: PositionGuardCandidateExecutionEvidence } {
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
    schemaVersion: 1,
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
  };
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

function canonicalNonNegativeDecimal(value: unknown, label: string): PositionGuardCandidateDecimal {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Candidate evidence ${label} must be finite and non-negative.`);
    }
    return canonicalDecimalText(String(Object.is(value, -0) ? 0 : value));
  }
  if (typeof value !== "string") {
    throw new Error(`Candidate evidence ${label} must be finite and non-negative.`);
  }
  return canonicalDecimalText(value);
}

function canonicalDecimalText(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new Error("Candidate evidence decimal values must be non-negative decimal strings.");
  }
  const [whole, fractional] = value.split(".");
  const canonicalWhole = whole!.replace(/^0+(?=\d)/u, "");
  const canonicalFractional = fractional?.replace(/0+$/u, "") ?? "";
  return canonicalFractional === "" ? canonicalWhole : `${canonicalWhole}.${canonicalFractional}`;
}

function isZeroDecimal(value: PositionGuardCandidateDecimal): boolean {
  return value === 0 || value === "0";
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
