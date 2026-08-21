import type { OrderLifecycleStatus } from "../../domain/types.js";
import type { OrderSubmissionRecoveryObservationRecord } from "../../domain/pilot-types.js";
import { compareDeterministicIdentifiers } from "../execution/candidate-evidence-decimals.js";

export interface BoundedAbsencePolicy {
  minimumNotFoundObservations: number;
  minimumElapsedMs: number;
}

export interface BoundedAbsenceEvaluation {
  notFoundObservationCount: number;
  elapsedMs: number;
  confirmed: boolean;
}

export function isPotentiallyDispatchedRecoveryStatus(
  status: OrderLifecycleStatus,
): status is Extract<OrderLifecycleStatus, "SUBMITTING" | "RECONCILIATION_REQUIRED" | "FAILED" | "REJECTED"> {
  return status === "SUBMITTING" || status === "RECONCILIATION_REQUIRED" || status === "FAILED" || status === "REJECTED";
}

export function evaluateBoundedAbsence(
  observations: readonly OrderSubmissionRecoveryObservationRecord[],
  policy: BoundedAbsencePolicy,
): BoundedAbsenceEvaluation {
  const absence = observations
    .filter((observation) => observation.outcome === "NOT_FOUND")
    .sort((left, right) => left.observedAtEpochMs - right.observedAtEpochMs ||
      compareDeterministicIdentifiers(left.id, right.id));
  const first = absence[0];
  const latest = absence.at(-1);
  const elapsedMs = first && latest ? latest.observedAtEpochMs - first.observedAtEpochMs : 0;
  return {
    notFoundObservationCount: absence.length,
    elapsedMs,
    confirmed: absence.length >= policy.minimumNotFoundObservations && elapsedMs >= policy.minimumElapsedMs,
  };
}
