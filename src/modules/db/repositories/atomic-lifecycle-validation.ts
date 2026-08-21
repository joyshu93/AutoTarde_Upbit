import type {
  ExecutionStateRecord,
  FillRecord,
  OrderEventRecord,
  OrderRecord,
} from "../../../domain/types.js";
import type {
  FaultPauseInput,
  PersistExchangeSubmissionInput,
  PersistOrderIntentInput,
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
  if (order.status === "OPEN") {
    if (fills.length !== 0) throw new Error("OPEN exchange submissions must not contain fills.");
  } else if (order.status === "PARTIALLY_FILLED" || order.status === "FILLED") {
    if (fills.length === 0) throw new Error(`${order.status} exchange submissions require at least one fill.`);
  } else if (order.status === "REJECTED") {
    if (fills.length !== 0) throw new Error("REJECTED exchange submissions must not contain fills.");
  } else {
    throw new Error(`Exchange submission has unsupported status ${order.status}.`);
  }
  validateOrderEvent(order, event, order.status === "REJECTED" ? "ORDER_REJECTED" : "ORDER_SUBMITTED", "EXCHANGE");
  validateFills(order, fills);
}

export function validateUncertainSubmissionInput(input: PersistUncertainSubmissionInput): void {
  const { order, event, riskEvent } = input;
  if (order.status !== "RECONCILIATION_REQUIRED") throw new Error("Uncertain submission must have RECONCILIATION_REQUIRED status.");
  if (order.failureCode !== "RECONCILIATION_REQUIRED") throw new Error("Uncertain submission must use RECONCILIATION_REQUIRED failureCode.");
  validateOrderEvent(order, event, "RECONCILIATION_RECOVERY_REQUIRED", "LOCAL");
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

export function validateAtomicCompletion(
  currentOrder: OrderRecord,
  nextOrder: OrderRecord,
  childStates: Array<{ present: boolean; exact: boolean }>,
  operation: string,
): "APPLY" | "RETRY" {
  validateOrderIdentity(currentOrder, nextOrder);
  const allAbsent = childStates.every((child) => !child.present);
  const allExact = childStates.every((child) => child.present && child.exact);
  if (currentOrder.status === "PERSISTED" || currentOrder.status === "SUBMITTING") {
    if (allAbsent) return "APPLY";
    throw new Error(`Corrupt partial ${operation} children for order ${nextOrder.id}.`);
  }
  if (recordsEqual(currentOrder, nextOrder) && allExact) return "RETRY";
  throw new Error(`Conflicting ${operation} for order ${nextOrder.id}.`);
}

export function validateFaultPauseInput(input: FaultPauseInput, current: ExecutionStateRecord): void {
  if (!input.exchangeAccountId || !input.faultId.trim() || !input.reason.trim()) {
    throw new Error("Automatic fault pauses require non-empty account, faultId, and reason.");
  }
  if (parseStrictIsoTimestamp(input.occurredAt, "occurredAt") < parseStrictIsoTimestamp(current.updatedAt, "current updatedAt")) {
    throw new Error("Automatic fault pause occurredAt cannot predate current execution state.");
  }
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

function validateOrderEvent(order: OrderRecord, event: OrderEventRecord, type: string, source: OrderEventRecord["eventSource"]): void {
  if (event.orderId !== order.id || event.eventType !== type || event.eventSource !== source) {
    throw new Error(`Order event ${event.id} is not canonical for order ${order.id}.`);
  }
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

function parseStrictIsoTimestamp(input: string, label: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(input);
  if (!match) throw new Error(`${label} must be an ISO-8601 timestamp with explicit timezone.`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error(`${label} must be a valid ISO-8601 timestamp.`);
  }
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be a valid ISO-8601 timestamp.`);
  return timestamp;
}
