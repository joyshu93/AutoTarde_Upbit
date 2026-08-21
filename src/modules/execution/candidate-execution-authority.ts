import type { CandidateExecutionBindingRecord } from "../../domain/pilot-types.js";
import type { OrderRecord, StrategyDecisionRecord } from "../../domain/types.js";
import {
  candidateExecutionBindingMaterialHash,
  parseCandidatePilotTimestamp,
  validateCandidateExecutionBinding,
} from "../db/pilot-interfaces.js";
import { validateCandidateBoundOrderIntent } from "../db/repositories/candidate-bound-order-validation.js";
import type { CandidateExecutionAuthority } from "./interfaces.js";

const AUTHORITY_KEYS = [
  "kind",
  "deploymentId",
  "exchangeAccountId",
  "pilotId",
  "market",
  "strategyKey",
  "policyId",
  "policyVersion",
  "activationAt",
  "activationEpochNs",
  "expectedPhase",
  "expectedDeploymentUpdatedAt",
  "expectedStateVersion",
  "routeReason",
] as const;
const DERIVATION_KEYS = ["authority", "order", "decision", "bindingId", "createdAt"] as const;
const TIMESTAMP_INPUT_KEYS = ["activationEpochNs", "bindingCreatedAt"] as const;
const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const MILLISECONDS_PER_SECOND = 1_000n;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000n;

export interface DeriveCandidateExecutionBindingInput {
  readonly authority: CandidateExecutionAuthority;
  readonly order: OrderRecord;
  readonly decision: StrategyDecisionRecord;
  readonly bindingId: string;
  readonly createdAt: string;
}

export interface CandidateExecutionAttemptTimestamps {
  readonly bindingCreatedAt: string;
  readonly orderRequestedAt: string;
}

export function validateCandidateExecutionAuthority(value: unknown): CandidateExecutionAuthority {
  const record = exactOwnDataRecord(value, "candidate execution authority", AUTHORITY_KEYS);
  requireNonEmpty(record.deploymentId, "deploymentId");
  requireNonEmpty(record.exchangeAccountId, "exchangeAccountId");
  if (
    record.kind !== "POSITION_GUARD_BTC_CANDIDATE" ||
    record.pilotId !== "BTC_COMBINED_CONSERVATIVE_PILOT_V1" ||
    record.market !== "KRW-BTC" ||
    record.strategyKey !== "position_guard.paper_core.v1" ||
    record.policyId !== "COMBINED_CONSERVATIVE" ||
    record.policyVersion !== "PCS-2026-001.DEPLOYMENT_READINESS_V1"
  ) {
    throw new Error("Candidate execution authority must use the exact approved frozen identity.");
  }
  if (typeof record.activationAt !== "string" || typeof record.activationEpochNs !== "bigint") {
    throw new Error("Candidate execution authority activation timestamp and epoch are invalid.");
  }
  const activationEpochNs = parseCandidatePilotTimestamp(
    record.activationAt,
    "execution authority activationAt",
  );
  if (activationEpochNs < 0n || activationEpochNs !== record.activationEpochNs) {
    throw new Error("Candidate execution authority activation epoch does not match its timestamp.");
  }
  if (typeof record.expectedDeploymentUpdatedAt !== "string") {
    throw new Error("Candidate execution authority expected deployment updatedAt is invalid.");
  }
  const deploymentUpdatedAt = parseCandidatePilotTimestamp(
    record.expectedDeploymentUpdatedAt,
    "execution authority expected deployment updatedAt",
  );
  if (deploymentUpdatedAt < activationEpochNs) {
    throw new Error("Candidate execution authority deployment chronology is invalid: updatedAt precedes activation.");
  }
  if (!Number.isSafeInteger(record.expectedStateVersion) || (record.expectedStateVersion as number) < 0) {
    throw new Error("Candidate execution authority expected state version must be a non-negative safe integer.");
  }
  validateRouteReason(record.expectedPhase, record.routeReason);

  return Object.freeze({
    kind: "POSITION_GUARD_BTC_CANDIDATE",
    deploymentId: record.deploymentId as string,
    exchangeAccountId: record.exchangeAccountId as string,
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    strategyKey: "position_guard.paper_core.v1",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    activationAt: record.activationAt,
    activationEpochNs,
    expectedPhase: record.expectedPhase,
    expectedDeploymentUpdatedAt: record.expectedDeploymentUpdatedAt,
    expectedStateVersion: record.expectedStateVersion as number,
    routeReason: record.routeReason,
  } as CandidateExecutionAuthority);
}

export function deriveCandidateExecutionBinding(
  input: DeriveCandidateExecutionBindingInput,
): Readonly<CandidateExecutionBindingRecord> {
  const record = exactOwnDataRecord(input, "candidate execution binding derivation", DERIVATION_KEYS);
  const authority = validateCandidateExecutionAuthority(record.authority);
  requireNonEmpty(record.bindingId, "bindingId");
  if (typeof record.createdAt !== "string") {
    throw new Error("Candidate execution binding createdAt must be a timestamp string.");
  }
  const timestamps = createCandidateExecutionAttemptTimestamps({
    activationEpochNs: authority.activationEpochNs,
    bindingCreatedAt: record.createdAt,
  });
  const order = record.order as OrderRecord;
  const decision = record.decision as StrategyDecisionRecord;
  const action = asExecutedAction(decision.action);
  if (authority.routeReason === "CANDIDATE_EARLY_THESIS_FAILURE" && action !== "EXIT") {
    throw new Error("Candidate early thesis failure authority permits only an EXIT action.");
  }
  if (order.requestedAt !== timestamps.orderRequestedAt) {
    throw new Error("Candidate order requestedAt must be the exact canonical nanosecond successor.");
  }

  const material: CandidateExecutionBindingRecord = {
    id: record.bindingId as string,
    deploymentId: authority.deploymentId,
    strategyDecisionId: decision.id,
    orderId: order.id,
    exchangeAccountId: authority.exchangeAccountId,
    activationAt: authority.activationAt,
    activationEpochNs: authority.activationEpochNs,
    market: authority.market,
    strategyKey: authority.strategyKey,
    policyId: authority.policyId,
    policyVersion: authority.policyVersion,
    executionMode: order.executionMode,
    ordType: order.ordType,
    action,
    side: order.side,
    intendedQuantity: decision.intendedQuantity,
    intendedNotionalKrw: decision.intendedNotionalKrw,
    boundPrice: order.price,
    boundVolume: order.volume,
    boundTimeInForce: order.timeInForce,
    boundSmpType: order.smpType,
    materialVersion: "BINDING_V2",
    orderMaterialHash: "",
    createdAt: timestamps.bindingCreatedAt,
  };
  material.orderMaterialHash = candidateExecutionBindingMaterialHash(material);
  const binding = validateCandidateExecutionBinding(material);

  validateCandidateBoundOrderIntent({
    order,
    event: {
      id: `candidate-binding-validation:${binding.id}`,
      orderId: order.id,
      eventType: "ORDER_PERSISTED",
      eventSource: "LOCAL",
      payloadJson: JSON.stringify({ decisionAction: decision.action }),
      createdAt: order.requestedAt,
    },
    binding,
    decision,
    deployment: {
      id: authority.deploymentId,
      exchangeAccountId: authority.exchangeAccountId,
      pilotId: authority.pilotId,
      market: authority.market,
      policyId: authority.policyId,
      policyVersion: authority.policyVersion,
      phase: authority.expectedPhase,
      activationAt: authority.activationAt,
      activationEpochNs: authority.activationEpochNs,
      createdAt: authority.activationAt,
      updatedAt: authority.expectedDeploymentUpdatedAt,
    },
    exactStateVersion: authority.expectedStateVersion,
    expectedPhase: authority.expectedPhase,
    expectedDeploymentUpdatedAt: authority.expectedDeploymentUpdatedAt,
    expectedStateVersion: authority.expectedStateVersion,
  });

  return Object.freeze({ ...binding });
}

export function createCandidateExecutionAttemptTimestamps(input: {
  readonly activationEpochNs: bigint;
  readonly bindingCreatedAt: string;
}): Readonly<CandidateExecutionAttemptTimestamps> {
  const record = exactOwnDataRecord(input, "candidate execution attempt timestamps", TIMESTAMP_INPUT_KEYS);
  if (typeof record.activationEpochNs !== "bigint" || record.activationEpochNs < 0n) {
    throw new Error("Candidate execution activation epoch must be a non-negative bigint.");
  }
  if (typeof record.bindingCreatedAt !== "string") {
    throw new Error("Candidate execution binding createdAt must be a timestamp string.");
  }
  const bindingEpochNs = parseCandidatePilotTimestamp(
    record.bindingCreatedAt,
    "execution binding createdAt",
  );
  if (bindingEpochNs < 0n) {
    throw new Error("Candidate execution binding createdAt cannot be pre-epoch.");
  }
  if (bindingEpochNs <= record.activationEpochNs) {
    throw new Error("Candidate execution binding createdAt must be after activation.");
  }
  return Object.freeze({
    bindingCreatedAt: formatCanonicalUtcIsoNanoseconds(bindingEpochNs),
    orderRequestedAt: formatCanonicalUtcIsoNanoseconds(bindingEpochNs + 1n),
  });
}

export function formatCanonicalUtcIsoNanoseconds(epochNanoseconds: bigint): string {
  if (typeof epochNanoseconds !== "bigint") {
    throw new Error("Epoch nanoseconds must be a bigint.");
  }
  if (epochNanoseconds < 0n) {
    throw new Error("Cannot format a pre-epoch timestamp.");
  }
  const wholeSeconds = epochNanoseconds / NANOSECONDS_PER_SECOND;
  const fractionalNanoseconds = epochNanoseconds % NANOSECONDS_PER_SECOND;
  const wholeMilliseconds = wholeSeconds * MILLISECONDS_PER_SECOND;
  if (wholeMilliseconds > MAX_DATE_MILLISECONDS) {
    throw new Error("Epoch nanoseconds exceed the supported UTC calendar range.");
  }
  const iso = new Date(Number(wholeMilliseconds)).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u.test(iso)) {
    throw new Error("Epoch nanoseconds exceed the supported four-digit UTC year range.");
  }
  return `${iso.slice(0, 19)}.${fractionalNanoseconds.toString().padStart(9, "0")}Z`;
}

function asExecutedAction(value: StrategyDecisionRecord["action"]): CandidateExecutionBindingRecord["action"] {
  if (value !== "ENTER" && value !== "ADD" && value !== "REDUCE" && value !== "EXIT") {
    throw new Error("Candidate execution binding requires an executed strategy action.");
  }
  return value;
}

function validateRouteReason(phase: unknown, routeReason: unknown): asserts phase is "ACTIVE" | "DRAINING" {
  if (phase === "ACTIVE") {
    if (routeReason !== "CANDIDATE_ALLOWED" && routeReason !== "CANDIDATE_EARLY_THESIS_FAILURE") {
      throw new Error("ACTIVE candidate execution authority route reason is invalid.");
    }
    return;
  }
  if (phase === "DRAINING") {
    if (routeReason !== "DRAINING_RISK_REDUCTION_PRESERVED") {
      throw new Error("DRAINING candidate execution authority route reason is invalid.");
    }
    return;
  }
  throw new Error("Candidate execution authority expected phase is invalid.");
}

function requireNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Candidate execution authority ${label} must be a non-empty string.`);
  }
}

function exactOwnDataRecord<const TKeys extends readonly string[]>(
  value: unknown,
  label: string,
  expectedKeys: TKeys,
): Record<TKeys[number], unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object with exactly own data properties.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object with exactly own data properties.`);
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
