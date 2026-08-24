import type { OrderEventRecord, OrderLifecycleStatus, OrderRecord } from "./types.js";
import type { OrderSubmissionRecoveryObservationRecord } from "./pilot-types.js";

export const SUBMISSION_BLOCKING_CANDIDATE_STATUSES = Object.freeze([
  "INTENT_CREATED",
  "PERSISTED",
  "SUBMITTING",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "RECONCILIATION_REQUIRED",
  "FAILED",
  "REJECTED",
] as const satisfies readonly OrderLifecycleStatus[]);

const ACTIVE_SUBMISSION_STATUSES: ReadonlySet<OrderLifecycleStatus> = new Set([
  "INTENT_CREATED",
  "PERSISTED",
  "SUBMITTING",
  "OPEN",
  "PARTIALLY_FILLED",
  "CANCEL_REQUESTED",
  "RECONCILIATION_REQUIRED",
]);

const DISPATCH_EVIDENCE_EVENTS = new Set([
  "ORDER_SUBMITTED",
  "ORDER_FILLED",
  "ORDER_CANCELED",
  "ORDER_REJECTED",
  "RECONCILIATION_RECOVERY_REQUIRED",
  "RECONCILIATION_STATUS_UPDATED",
  "RECONCILIATION_IDENTIFIER_RECOVERY_OBSERVED",
]);

const UNCERTAIN_FAILURE_CODES = new Set([
  "EXCHANGE_SUBMISSION_FAILED",
  "RECONCILIATION_REQUIRED",
  "SUBMISSION_RESPONSE_UNCERTAIN",
]);

export type SubmissionBlockingReasonCode =
  | "ACTIVE_SUBMISSION_LIFECYCLE"
  | "UNRESOLVED_POTENTIALLY_DISPATCHED"
  | "DEFINITIVE_PRE_SEND_TERMINAL"
  | "EXCHANGE_REJECTION_CONFIRMED"
  | "BOUNDED_ABSENCE_CONFIRMED"
  | "RESOLVED_TERMINAL";

export interface SubmissionBlockingOrderEvidence {
  order: Pick<
    OrderRecord,
    "id" | "status" | "failureCode" | "upbitUuid" | "exchangeResponseJson"
  >;
  events: readonly Pick<OrderEventRecord, "eventType" | "eventSource" | "createdAt">[];
  recoveryObservations: readonly Pick<
    OrderSubmissionRecoveryObservationRecord,
    "outcome" | "observedAtEpochMs"
  >[];
}

export interface SubmissionBlockingClassification {
  blocking: boolean;
  reasonCode: SubmissionBlockingReasonCode;
  reason: string;
}

export function classifySubmissionBlockingOrder(
  evidence: Readonly<SubmissionBlockingOrderEvidence>,
): Readonly<SubmissionBlockingClassification> {
  const { order } = evidence;
  if (ACTIVE_SUBMISSION_STATUSES.has(order.status)) {
    return classification(
      true,
      "ACTIVE_SUBMISSION_LIFECYCLE",
      `Order ${order.id} remains in submission-blocking lifecycle ${order.status}.`,
    );
  }

  if (order.status !== "FAILED" && order.status !== "REJECTED") {
    return classification(false, "RESOLVED_TERMINAL", `Order ${order.id} is terminal and resolved.`);
  }

  const foundObserved = evidence.recoveryObservations.some((item) => item.outcome === "FOUND");
  const notFoundEpochs = evidence.recoveryObservations
    .filter((item) => item.outcome === "NOT_FOUND")
    .map((item) => item.observedAtEpochMs)
    .sort((left, right) => left - right);
  const boundedAbsenceObserved =
    notFoundEpochs.length >= 2 &&
    notFoundEpochs.at(-1)! > notFoundEpochs[0]!;
  const submitted = evidence.events.some((item) => item.eventType === "ORDER_SUBMITTED");
  const recoveryRequired = evidence.events.some((item) => item.eventType === "RECONCILIATION_RECOVERY_REQUIRED");
  const absenceConfirmed = evidence.events.some(
    (item) => item.eventType === "RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED" &&
      item.eventSource === "RECONCILIATION",
  );
  const exchangeRejected = evidence.events.some(
    (item) => item.eventType === "ORDER_REJECTED" && item.eventSource === "EXCHANGE",
  );

  if (
    order.status === "FAILED" &&
    order.failureCode === "ORDER_SUBMISSION_ABSENCE_CONFIRMED" &&
    absenceConfirmed &&
    boundedAbsenceObserved &&
    !foundObserved &&
    !submitted &&
    order.upbitUuid === null
  ) {
    return classification(
      false,
      "BOUNDED_ABSENCE_CONFIRMED",
      `Order ${order.id} has durable bounded exchange-absence authority.`,
    );
  }

  if (
    order.status === "REJECTED" &&
    order.failureCode === "EXCHANGE_ORDER_REJECTED" &&
    exchangeRejected &&
    !foundObserved &&
    !submitted &&
    !recoveryRequired &&
    order.upbitUuid === null
  ) {
    return classification(
      false,
      "EXCHANGE_REJECTION_CONFIRMED",
      `Order ${order.id} has a definitive persisted exchange rejection.`,
    );
  }

  const hasDispatchEvidence =
    order.upbitUuid !== null ||
    order.exchangeResponseJson !== null ||
    foundObserved ||
    evidence.events.some((item) => DISPATCH_EVIDENCE_EVENTS.has(item.eventType)) ||
    (order.failureCode !== null && (
      UNCERTAIN_FAILURE_CODES.has(order.failureCode) ||
      /UNCERTAIN|RECONCILIATION/u.test(order.failureCode)
    ));
  if (!hasDispatchEvidence) {
    return classification(
      false,
      "DEFINITIVE_PRE_SEND_TERMINAL",
      `Order ${order.id} terminated before any persisted exchange-dispatch evidence.`,
    );
  }

  return classification(
    true,
    "UNRESOLVED_POTENTIALLY_DISPATCHED",
    `Order ${order.id} is ${order.status} with unresolved persisted exchange-dispatch evidence.`,
  );
}

function classification(
  blocking: boolean,
  reasonCode: SubmissionBlockingReasonCode,
  reason: string,
): Readonly<SubmissionBlockingClassification> {
  return Object.freeze({ blocking, reasonCode, reason });
}
