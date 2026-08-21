import type {
  CandidateExecutionBindingRecord,
  PositionGuardPilotDeploymentRecord,
} from "../../../domain/pilot-types.js";
import type {
  OrderEventRecord,
  OrderRecord,
  StrategyDecisionRecord,
} from "../../../domain/types.js";
import { canonicalNonNegativeDecimal } from "../../execution/candidate-evidence-decimals.js";
import { parsePositionGuardCandidateTimestamp } from "../../strategy/position-guard-candidate-state.js";
import type {
  PersistCandidateBoundOrderIntentInput,
  PersistCandidateBoundOrderIntentRequest,
} from "../interfaces.js";
import {
  validateCandidateExecutionBinding,
  validateCandidatePilotDeployment,
} from "../pilot-interfaces.js";
import { validateOrderIntentInput } from "./atomic-lifecycle-validation.js";

const INPUT_KEYS = [
  "order",
  "event",
  "binding",
  "decision",
  "deployment",
  "exactStateVersion",
  "expectedPhase",
  "expectedDeploymentUpdatedAt",
  "expectedStateVersion",
] as const;
const ORDER_KEYS = [
  "id", "strategyDecisionId", "exchangeAccountId", "market", "side", "ordType",
  "volume", "price", "timeInForce", "smpType", "identifier", "idempotencyKey",
  "origin", "requestedAt", "upbitUuid", "status", "executionMode",
  "exchangeResponseJson", "failureCode", "failureMessage", "createdAt", "updatedAt",
] as const;
const EVENT_KEYS = ["id", "orderId", "eventType", "eventSource", "payloadJson", "createdAt"] as const;
const DECISION_KEYS = [
  "id", "exchangeAccountId", "strategyKey", "market", "action", "status",
  "decisionBasisJson", "intendedNotionalKrw", "intendedQuantity", "referencePrice", "createdAt",
] as const;
const REQUEST_KEYS = [
  "order", "event", "binding", "expectedPhase", "expectedDeploymentUpdatedAt", "expectedStateVersion",
] as const;

export function validateCandidateBoundOrderIntentRequestShape(
  value: PersistCandidateBoundOrderIntentRequest,
): PersistCandidateBoundOrderIntentRequest {
  exactOwnDataRecord(value, "candidate-bound order persistence request", REQUEST_KEYS);
  exactOwnDataRecord(value.order, "candidate-bound order", ORDER_KEYS);
  exactOwnDataRecord(value.event, "candidate-bound order event", EVENT_KEYS);
  validateCandidateExecutionBinding(value.binding);
  return value;
}

export function validateCandidateBoundOrderIntent(
  value: PersistCandidateBoundOrderIntentInput,
): PersistCandidateBoundOrderIntentInput {
  exactOwnDataRecord(value, "candidate-bound order intent", INPUT_KEYS);
  exactOwnDataRecord(value.order, "candidate-bound order", ORDER_KEYS);
  exactOwnDataRecord(value.event, "candidate-bound order event", EVENT_KEYS);
  exactOwnDataRecord(value.decision, "candidate-bound strategy decision", DECISION_KEYS);

  validateOrderIntentInput({ order: value.order, event: value.event });
  const binding = validateCandidateExecutionBinding(value.binding);
  const deployment = validateCandidatePilotDeployment(value.deployment);
  validateStateVersion(value.exactStateVersion, "exact state version");
  validateStateVersion(value.expectedStateVersion, "expected state version");
  if (value.exactStateVersion !== value.expectedStateVersion) {
    throw new Error("Candidate-bound order intent exact state version has changed.");
  }
  if (value.expectedPhase !== "ACTIVE" && value.expectedPhase !== "DRAINING") {
    throw new Error("Candidate-bound order intent expected deployment phase is invalid.");
  }
  parsePositionGuardCandidateTimestamp(
    value.expectedDeploymentUpdatedAt,
    "candidate-bound expected deployment updatedAt",
  );

  validateDecision(value.decision, value.order, binding);
  validateDeployment(value, deployment, binding);
  validateOrderBinding(value.order, binding);
  validateCandidateOrderShape(value.expectedPhase, value.decision, value.order);
  validateImmutableRequest(value.order, value.event, binding);
  return value;
}

function validateCandidateOrderShape(
  phase: "ACTIVE" | "DRAINING",
  decision: StrategyDecisionRecord,
  order: OrderRecord,
): void {
  const isEntry = decision.action === "ENTER" || decision.action === "ADD";
  if (phase === "DRAINING" && isEntry) {
    throw new Error("DRAINING candidate deployments allow only REDUCE or EXIT orders.");
  }

  if (isEntry) {
    if (
      order.side !== "bid" ||
      order.ordType !== "price" ||
      order.price === null ||
      order.price !== decision.intendedNotionalKrw ||
      decision.intendedQuantity !== null ||
      order.volume !== null ||
      order.timeInForce !== null ||
      order.smpType !== null
    ) {
      throw new Error("Candidate entry order shape is invalid.");
    }
    validatePositiveDecimal(order.price, "Candidate entry order shape");
    return;
  }

  if (
    order.side !== "ask" ||
    order.ordType !== "market" ||
    decision.intendedNotionalKrw !== null ||
    order.price !== null ||
    order.volume === null ||
    order.volume !== decision.intendedQuantity ||
    order.timeInForce !== null ||
    order.smpType !== null
  ) {
    throw new Error("Candidate exit order shape is invalid.");
  }
  validatePositiveDecimal(order.volume, "Candidate exit order shape");
}

function validateDecision(
  decision: StrategyDecisionRecord,
  order: OrderRecord,
  binding: CandidateExecutionBindingRecord,
): void {
  if (
    typeof decision.id !== "string" || decision.id.trim() === "" ||
    decision.status !== "READY" ||
    decision.strategyKey !== "position_guard.paper_core.v1" ||
    decision.market !== "KRW-BTC" ||
    !isCandidateAction(decision.action) ||
    decision.id !== order.strategyDecisionId ||
    decision.id !== binding.strategyDecisionId ||
    decision.exchangeAccountId !== order.exchangeAccountId ||
    decision.exchangeAccountId !== binding.exchangeAccountId ||
    decision.market !== order.market ||
    decision.market !== binding.market ||
    decision.strategyKey !== binding.strategyKey ||
    decision.action !== binding.action ||
    decision.intendedQuantity !== binding.intendedQuantity ||
    decision.intendedNotionalKrw !== binding.intendedNotionalKrw
  ) {
    throw new Error("Candidate-bound order intent does not match its persisted READY strategy decision.");
  }
  validateOptionalDecimal(decision.intendedQuantity, "decision intendedQuantity");
  validateOptionalDecimal(decision.intendedNotionalKrw, "decision intendedNotionalKrw");
  validateOptionalDecimal(decision.referencePrice, "decision referencePrice");
  const decisionCreatedAt = parsePositionGuardCandidateTimestamp(
    decision.createdAt,
    "candidate-bound decision createdAt",
  );
  const bindingCreatedAt = parsePositionGuardCandidateTimestamp(
    binding.createdAt,
    "candidate-bound binding createdAt",
  );
  const requestedAt = parsePositionGuardCandidateTimestamp(
    order.requestedAt,
    "candidate-bound order requestedAt",
  );
  if (decisionCreatedAt > bindingCreatedAt || bindingCreatedAt >= requestedAt) {
    throw new Error("Candidate decision and binding chronology must satisfy decision <= binding < request.");
  }

  const expectedSide = decision.action === "ENTER" || decision.action === "ADD" ? "bid" : "ask";
  if (order.side !== expectedSide || binding.side !== expectedSide) {
    throw new Error("Candidate-bound order side does not match its strategy action.");
  }
  if (expectedSide === "bid") {
    if (decision.intendedNotionalKrw === null || order.price !== decision.intendedNotionalKrw) {
      throw new Error("Candidate entry order does not match its intended notional.");
    }
  } else if (decision.intendedQuantity === null || order.volume !== decision.intendedQuantity) {
    throw new Error("Candidate exit order does not match its intended quantity.");
  }
}

function validateDeployment(
  input: PersistCandidateBoundOrderIntentInput,
  deployment: PositionGuardPilotDeploymentRecord,
  binding: CandidateExecutionBindingRecord,
): void {
  if (
    deployment.id !== binding.deploymentId ||
    deployment.exchangeAccountId !== binding.exchangeAccountId ||
    deployment.pilotId !== "BTC_COMBINED_CONSERVATIVE_PILOT_V1" ||
    deployment.market !== binding.market ||
    deployment.policyId !== binding.policyId ||
    deployment.policyVersion !== binding.policyVersion ||
    deployment.phase !== input.expectedPhase ||
    deployment.updatedAt !== input.expectedDeploymentUpdatedAt ||
    deployment.activationAt === null ||
    deployment.activationEpochNs === null ||
    deployment.activationAt !== binding.activationAt ||
    deployment.activationEpochNs !== binding.activationEpochNs
  ) {
    throw new Error("Candidate-bound order intent does not match its persisted deployment authority.");
  }
}

function validateOrderBinding(order: OrderRecord, binding: CandidateExecutionBindingRecord): void {
  if (
    order.id !== binding.orderId ||
    order.exchangeAccountId !== binding.exchangeAccountId ||
    order.market !== binding.market ||
    order.executionMode !== binding.executionMode ||
    order.ordType !== binding.ordType ||
    order.side !== binding.side ||
    order.price !== binding.boundPrice ||
    order.volume !== binding.boundVolume ||
    order.timeInForce !== binding.boundTimeInForce ||
    order.smpType !== binding.boundSmpType
  ) {
    throw new Error("Candidate execution binding does not match immutable order material.");
  }
  validateOptionalDecimal(order.price, "order price");
  validateOptionalDecimal(order.volume, "order volume");
}

function validateImmutableRequest(
  order: OrderRecord,
  event: OrderEventRecord,
  binding: CandidateExecutionBindingRecord,
): void {
  if (
    order.origin !== "STRATEGY" ||
    order.upbitUuid !== null ||
    order.exchangeResponseJson !== null ||
    order.failureCode !== null ||
    order.failureMessage !== null
  ) {
    throw new Error("Candidate-bound order intent must be a pristine local strategy order.");
  }
  if (
    order.requestedAt !== order.createdAt ||
    order.requestedAt !== order.updatedAt ||
    event.createdAt !== order.requestedAt
  ) {
    throw new Error("Candidate-bound order timestamps must share the immutable request instant.");
  }
  const bindingCreatedAt = parsePositionGuardCandidateTimestamp(binding.createdAt, "binding createdAt");
  const requestedAt = parsePositionGuardCandidateTimestamp(order.requestedAt, "order requestedAt");
  if (requestedAt !== bindingCreatedAt + 1n) {
    throw new Error("Candidate order requestedAt must be the exact nanosecond successor of binding createdAt.");
  }
}

function validateStateVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Candidate-bound ${label} must be a non-negative safe integer.`);
  }
}

function validateOptionalDecimal(value: string | null, label: string): void {
  if (value !== null && canonicalNonNegativeDecimal(value, label) !== value) {
    throw new Error(`${label} must be canonical.`);
  }
}

function validatePositiveDecimal(value: string, label: string): void {
  const canonical = canonicalNonNegativeDecimal(value, `${label} value`);
  if (canonical !== value || canonical === "0") {
    throw new Error(`${label} requires a canonical positive decimal.`);
  }
}

function isCandidateAction(
  value: StrategyDecisionRecord["action"],
): value is CandidateExecutionBindingRecord["action"] {
  return value === "ENTER" || value === "ADD" || value === "REDUCE" || value === "EXIT";
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
