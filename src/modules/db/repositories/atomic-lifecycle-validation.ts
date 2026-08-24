import type {
  ExecutionStateRecord,
  FillRecord,
  OrderEventRecord,
  OrderRecord,
  RiskEventRecord,
} from "../../../domain/types.js";
import type {
  FaultPauseInput,
  PersistExchangeSubmissionInput,
  PersistOrderIntentInput,
  PersistReconciliationRecoveryInput,
  PersistReconciledExchangeSnapshotInput,
  PersistUncertainSubmissionInput,
} from "../interfaces.js";

const IMMUTABLE_ORDER_IDENTITY_FIELDS = [
  "strategyDecisionId", "exchangeAccountId", "market", "side", "ordType", "volume", "price",
  "timeInForce", "smpType", "identifier", "idempotencyKey", "origin", "requestedAt",
  "executionMode", "createdAt",
] as const;

export function validateOrderIntentInput(input: PersistOrderIntentInput): void {
  if (input.order.status !== "PERSISTED") throw new Error("Order intent must have PERSISTED status.");
  validateOrderEvent(input.order, input.event, "ORDER_PERSISTED", "LOCAL");
}

export function validateExchangeSubmissionInput(input: PersistExchangeSubmissionInput): void {
  const { order, event, fills } = input;
  const expectedEventSource = eventSourceForExecutionMode(order.executionMode);
  if (input.terminalEvent && input.terminalEvent.id === event.id) {
    throw new Error("Submission and terminal order events must use distinct ids.");
  }
  if (order.status === "OPEN") {
    if (fills.length !== 0) throw new Error("OPEN exchange submissions must not contain fills.");
  } else if (order.status === "PARTIALLY_FILLED" || order.status === "FILLED") {
    if (fills.length === 0) throw new Error(`${order.status} exchange submissions require at least one fill.`);
  } else if (order.status === "REJECTED") {
    if (fills.length !== 0) throw new Error("REJECTED exchange submissions must not contain fills.");
  } else {
    throw new Error(`Exchange submission has unsupported status ${order.status}.`);
  }
  validateOrderEvent(order, event, order.status === "REJECTED" ? "ORDER_REJECTED" : "ORDER_SUBMITTED", expectedEventSource);
  if (input.terminalEvent) {
    if (order.status !== "FILLED") throw new Error("Terminal submission events require a FILLED order.");
    validateOrderEvent(order, input.terminalEvent, "ORDER_FILLED", expectedEventSource);
  } else if (order.status === "FILLED") {
    throw new Error("FILLED exchange submissions require terminal order evidence.");
  }
  validateFills(order, fills);
}

export function validateUncertainSubmissionInput(input: PersistUncertainSubmissionInput): void {
  const { order, event, riskEvent } = input;
  if (order.status !== "RECONCILIATION_REQUIRED") throw new Error("Uncertain submission must have RECONCILIATION_REQUIRED status.");
  if (order.failureCode !== "RECONCILIATION_REQUIRED") throw new Error("Uncertain submission must use RECONCILIATION_REQUIRED failureCode.");
  validateOrderEvent(order, event, "RECONCILIATION_RECOVERY_REQUIRED", eventSourceForExecutionMode(order.executionMode));
  if (
    riskEvent.level !== "BLOCK" || riskEvent.ruleCode !== "POSITION_GUARD_PILOT_UNCERTAIN_ORDER" ||
    riskEvent.orderId !== order.id || riskEvent.exchangeAccountId !== order.exchangeAccountId ||
    riskEvent.strategyDecisionId !== order.strategyDecisionId
  ) throw new Error("Uncertain submission risk event must exactly link the blocked order.");
}

export function validateOrderIdentity(existing: OrderRecord, next: OrderRecord): void {
  if (existing.id !== next.id) throw new Error("Order identity cannot change id.");
  for (const field of IMMUTABLE_ORDER_IDENTITY_FIELDS) {
    if (existing[field] !== next[field]) throw new Error(`Order ${next.id} cannot change immutable ${field}.`);
  }
}

export function validateNewOrderUniqueness(existingOrders: OrderRecord[], next: OrderRecord): void {
  for (const existing of existingOrders) {
    if (existing.id === next.id) throw new Error(`Conflicting duplicate order id ${next.id}.`);
    if (existing.identifier === next.identifier) throw new Error(`Conflicting duplicate order identifier ${next.identifier}.`);
    if (existing.exchangeAccountId === next.exchangeAccountId && existing.idempotencyKey === next.idempotencyKey) {
      throw new Error(`Conflicting duplicate order idempotency key ${next.idempotencyKey}.`);
    }
  }
}

export function validateExchangeSubmissionCompletion(
  currentOrder: OrderRecord,
  nextOrder: OrderRecord,
  input: PersistExchangeSubmissionInput,
  existingEvents: OrderEventRecord[],
  existingFills: FillRecord[],
): "APPLY" | "RETRY" {
  validateOrderIdentity(currentOrder, nextOrder);
  const submissionEvents = existingEvents.filter(
    (event) => event.eventType === "ORDER_SUBMITTED" || event.eventType === "ORDER_REJECTED",
  );
  const terminalEvents = existingEvents.filter((event) => event.eventType === "ORDER_FILLED");
  if (currentOrder.status === "PERSISTED" || currentOrder.status === "SUBMITTING") {
    if (submissionEvents.length === 0 && terminalEvents.length === 0 && existingFills.length === 0) return "APPLY";
    throw new Error(`Corrupt partial exchange submission children for order ${nextOrder.id}.`);
  }
  if (
    recordsEqual(currentOrder, nextOrder) &&
    submissionEvents.length === 1 &&
    recordsEqual(submissionEvents[0]!, input.event) &&
    ((input.terminalEvent === undefined && terminalEvents.length === 0) ||
      (input.terminalEvent !== undefined && terminalEvents.length === 1 && recordsEqual(terminalEvents[0]!, input.terminalEvent))) &&
    recordsEqualSet(existingFills, input.fills, fillIdentity)
  ) return "RETRY";
  throw new Error(`Conflicting exchange submission for order ${nextOrder.id}.`);
}

export function validateUncertainSubmissionCompletion(
  currentOrder: OrderRecord,
  nextOrder: OrderRecord,
  input: PersistUncertainSubmissionInput,
  existingEvents: OrderEventRecord[],
  existingRiskEvents: RiskEventRecord[],
): "APPLY" | "RETRY" {
  validateOrderIdentity(currentOrder, nextOrder);
  const recoveryEvents = existingEvents.filter((event) => event.eventType === "RECONCILIATION_RECOVERY_REQUIRED");
  const uncertainRiskEvents = existingRiskEvents.filter(
    (event) => event.ruleCode === "POSITION_GUARD_PILOT_UNCERTAIN_ORDER",
  );
  if (currentOrder.status === "PERSISTED" || currentOrder.status === "SUBMITTING") {
    if (recoveryEvents.length === 0 && uncertainRiskEvents.length === 0) return "APPLY";
    throw new Error(`Corrupt partial uncertain submission children for order ${nextOrder.id}.`);
  }
  if (
    recordsEqual(currentOrder, nextOrder) &&
    recoveryEvents.length === 1 &&
    uncertainRiskEvents.length === 1 &&
    recordsEqual(recoveryEvents[0]!, input.event) &&
    recordsEqual(uncertainRiskEvents[0]!, input.riskEvent)
  ) return "RETRY";
  throw new Error(`Conflicting uncertain submission for order ${nextOrder.id}.`);
}

export function validateFaultPauseInput(input: FaultPauseInput): void {
  if (!input.exchangeAccountId || !input.faultId.trim() || !input.reason.trim()) {
    throw new Error("Automatic fault pauses require non-empty account, faultId, and reason.");
  }
  parseStrictIsoTimestamp(input.occurredAt, "occurredAt");
  if (input.transitionAt !== undefined) {
    const occurredAt = parseStrictIsoTimestamp(input.occurredAt, "occurredAt");
    const transitionAt = parseStrictIsoTimestamp(input.transitionAt, "transitionAt");
    if (transitionAt < occurredAt) {
      throw new Error("Automatic fault pause transitionAt cannot predate fault occurrence.");
    }
  }
}

export function validateFaultPauseTimestamp(input: FaultPauseInput, current: ExecutionStateRecord): string {
  const requestedTransitionAt = input.transitionAt ?? input.occurredAt;
  const requestedEpoch = parseStrictIsoTimestamp(requestedTransitionAt, "transitionAt");
  const currentEpoch = parseStrictIsoTimestamp(current.updatedAt, "current updatedAt");
  if (input.transitionAt === undefined && requestedEpoch < currentEpoch) {
    throw new Error("Automatic fault pause occurredAt cannot predate current execution state.");
  }
  return requestedEpoch < currentEpoch ? current.updatedAt : requestedTransitionAt;
}

export function deriveFaultPauseTransitionAt(
  occurredAt: string,
  currentUpdatedAt: string,
): string {
  const occurredAtEpoch = parseStrictIsoTimestamp(occurredAt, "occurredAt");
  const currentEpoch = parseStrictIsoTimestamp(currentUpdatedAt, "current updatedAt");
  return occurredAtEpoch < currentEpoch ? currentUpdatedAt : occurredAt;
}

export function faultPauseTransitionMatchesOccurrence(input: FaultPauseInput, transitionAt: string): boolean {
  try {
    if (input.transitionAt === undefined) return transitionAt === input.occurredAt;
    return parseStrictIsoTimestamp(transitionAt, "persisted transition createdAt") >=
      parseStrictIsoTimestamp(input.occurredAt, "occurredAt");
  } catch {
    return false;
  }
}

export function normalizeFillFeeProvenance(record: FillRecord): FillRecord {
  return {
    ...record,
    feeProvenance: record.feeProvenance ?? "LEGACY_UNVERIFIED",
    executionTimestampProvenance: record.executionTimestampProvenance ?? "LEGACY_UNVERIFIED",
    executionEpochNs: record.executionEpochNs ?? null,
  };
}

export function validateReconciledExchangeSnapshotInput(
  input: PersistReconciledExchangeSnapshotInput,
): void {
  validateOrderIdentity(input.expectedOrder, input.order);
  const orderChanged = !recordsEqual(input.expectedOrder, input.order);
  if (orderChanged !== (input.event !== null)) {
    throw new Error("Reconciled order changes require exactly one reconciliation event.");
  }
  if (
    input.event &&
    (
      input.event.orderId !== input.order.id ||
      input.event.eventType !== "RECONCILIATION_STATUS_UPDATED" ||
      input.event.eventSource !== "RECONCILIATION"
    )
  ) {
    throw new Error(`Reconciliation event ${input.event.id} is invalid for order ${input.order.id}.`);
  }

  const ids = new Set<string>();
  const exchangeIdentities = new Set<string>();
  for (const fill of input.fills) {
    validateFillForOrder(input.order, fill);
    const exchangeIdentity = fillExchangeIdentity(fill);
    if (ids.has(fill.id) || exchangeIdentities.has(exchangeIdentity)) {
      throw new Error(`Duplicate fill identity ${fill.id} in reconciled order ${input.order.id}.`);
    }
    ids.add(fill.id);
    exchangeIdentities.add(exchangeIdentity);
  }
}

export function validateReconciliationRecoveryInput(input: PersistReconciliationRecoveryInput): void {
  const { expectedOrder, order, event, riskEvent } = input;
  validateOrderIdentity(expectedOrder, order);
  if (order.status !== "RECONCILIATION_REQUIRED" || order.failureCode !== "RECONCILIATION_REQUIRED") {
    throw new Error("Reconciliation recovery must set RECONCILIATION_REQUIRED status and failureCode.");
  }
  validateOrderEvent(order, event, "RECONCILIATION_RECOVERY_REQUIRED", "RECONCILIATION");
  if (
    riskEvent.level !== "WARN" || riskEvent.ruleCode !== "ORDER_RECOVERY_REQUIRED" ||
    riskEvent.orderId !== order.id || riskEvent.exchangeAccountId !== order.exchangeAccountId ||
    riskEvent.strategyDecisionId !== order.strategyDecisionId
  ) throw new Error("Reconciliation recovery risk event must exactly link the blocked order.");
}

export function validateReconciliationRecoveryCompletion(
  currentOrder: OrderRecord,
  nextOrder: OrderRecord,
  input: PersistReconciliationRecoveryInput,
  existingEvents: OrderEventRecord[],
  existingRiskEvents: RiskEventRecord[],
): "APPLY" | "RETRY" {
  validateOrderIdentity(currentOrder, nextOrder);
  const recoveryEvents = existingEvents.filter((event) => event.eventType === "RECONCILIATION_RECOVERY_REQUIRED");
  const recoveryRiskEvents = existingRiskEvents.filter((event) => event.ruleCode === "ORDER_RECOVERY_REQUIRED");
  if (!recordsEqual(currentOrder, nextOrder)) {
    if (recoveryEvents.length === 0 && recoveryRiskEvents.length === 0) return "APPLY";
    throw new Error(`Corrupt partial reconciliation recovery children for order ${nextOrder.id}.`);
  }
  if (
    recoveryEvents.length === 1 && recoveryRiskEvents.length === 1 &&
    recordsEqual(recoveryEvents[0]!, input.event) && recordsEqual(recoveryRiskEvents[0]!, input.riskEvent)
  ) return "RETRY";
  throw new Error(`Conflicting reconciliation recovery for order ${nextOrder.id}.`);
}

export function validateFillForOrder(order: OrderRecord, fill: FillRecord): void {
  if (fill.orderId !== order.id || fill.market !== order.market || fill.side !== order.side) {
    throw new Error(`Fill ${fill.id} identity does not match order ${order.id}.`);
  }
  validateExactDecimal(fill.price, "fill price", false);
  validateExactDecimal(fill.volume, "fill volume", false);
  if (fill.feeAmount !== null) {
    validateExactDecimal(fill.feeAmount, "fill fee amount", true);
  }
  if (fill.executionEpochNs !== null && fill.executionEpochNs !== undefined && !/^\d+$/.test(fill.executionEpochNs)) {
    throw new Error(`Fill ${fill.id} executionEpochNs must be an exact non-negative integer string.`);
  }
}

export function resolveImmutableFillReplay(
  existing: FillRecord | null | undefined,
  next: FillRecord,
): "INSERT" | "PRESERVE" {
  if (!existing) return "INSERT";
  if (fillExchangeIdentity(existing) !== fillExchangeIdentity(next) || existing.id === next.id && existing.orderId !== next.orderId) {
    throw new Error(`Conflicting fill identity ${next.id}.`);
  }
  const { id: _existingId, ...existingMaterial } = existing;
  const { id: _nextId, ...nextMaterial } = next;
  if (!recordsEqual(existingMaterial, nextMaterial)) {
    throw new Error(`Conflicting duplicate fill ${next.exchangeFillId}.`);
  }
  return "PRESERVE";
}

export function recordsEqual<T extends object>(left: T, right: T): boolean {
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && leftRecord[key] === rightRecord[key],
  );
}

function recordsEqualSet<T extends object>(left: T[], right: T[], identity: (record: T) => string): boolean {
  if (left.length !== right.length) return false;
  const rightByIdentity = new Map(right.map((record) => [identity(record), record]));
  if (rightByIdentity.size !== right.length) return false;
  return left.every((record) => {
    const matching = rightByIdentity.get(identity(record));
    return matching !== undefined && recordsEqual(record, matching);
  });
}

function fillIdentity(fill: FillRecord): string {
  return `${fill.id}\u0000${fill.orderId}\u0000${fill.exchangeFillId}`;
}

function fillExchangeIdentity(fill: FillRecord): string {
  return `${fill.orderId}\u0000${fill.exchangeFillId}`;
}

function validateExactDecimal(value: string, label: string, allowZero: boolean): void {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a plain non-negative decimal string.`);
  }
  if (!allowZero && !/[1-9]/.test(value)) {
    throw new Error(`${label} must be greater than zero.`);
  }
}

function validateOrderEvent(order: OrderRecord, event: OrderEventRecord, type: string, source: OrderEventRecord["eventSource"]): void {
  if (event.orderId !== order.id || event.eventType !== type || event.eventSource !== source) {
    throw new Error(`Order event ${event.id} is not canonical for order ${order.id}.`);
  }
}

function eventSourceForExecutionMode(executionMode: OrderRecord["executionMode"]): OrderEventRecord["eventSource"] {
  return executionMode === "DRY_RUN" ? "LOCAL" : "EXCHANGE";
}

function validateFills(order: OrderRecord, fills: FillRecord[]): void {
  const ids = new Set<string>();
  const exchangeIdentities = new Set<string>();
  for (const fill of fills) {
    const exchangeIdentity = `${fill.orderId}\u0000${fill.exchangeFillId}`;
    if (fill.orderId !== order.id || fill.market !== order.market || fill.side !== order.side || ids.has(fill.id) || exchangeIdentities.has(exchangeIdentity)) {
      throw new Error(`Fill ${fill.id} is invalid for order ${order.id}.`);
    }
    ids.add(fill.id);
    exchangeIdentities.add(exchangeIdentity);
  }
}

function parseStrictIsoTimestamp(input: string, label: string): bigint {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(input);
  if (!match) throw new Error(`${label} must be an ISO-8601 timestamp with explicit timezone.`);
  const [
    , yearText, monthText, dayText, hourText, minuteText, secondText, fractionText,
    timezoneText, , offsetHourText, offsetMinuteText,
  ] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(`${label} must be a valid ISO-8601 timestamp.`);
  }
  const wholeSecondTimestamp = Date.parse(
    `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${timezoneText}`,
  );
  if (!Number.isFinite(wholeSecondTimestamp)) throw new Error(`${label} must be a valid ISO-8601 timestamp.`);
  const fractionNanoseconds = BigInt((fractionText ?? "").padEnd(9, "0"));
  return BigInt(wholeSecondTimestamp) * 1_000_000n + fractionNanoseconds;
}
