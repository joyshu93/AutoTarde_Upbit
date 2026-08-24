import assert from "node:assert/strict";

import type { OrderSubmissionRecoveryObservationRecord } from "../src/domain/pilot-types.js";
import { evaluateBoundedAbsence } from
  "../src/modules/reconciliation/submission-recovery-state-machine.js";
import { test } from "./harness.js";

test("durable FOUND authority permanently blocks later bounded absence confirmation", () => {
  const observations = [
    observation("found", "FOUND", 1_000),
    observation("not-found-1", "NOT_FOUND", 2_000),
    observation("not-found-2", "NOT_FOUND", 62_000),
  ];

  const evaluation = evaluateBoundedAbsence(observations, {
    minimumNotFoundObservations: 2,
    minimumElapsedMs: 60_000,
  });

  assert.deepEqual(evaluation, {
    notFoundObservationCount: 2,
    elapsedMs: 60_000,
    confirmed: false,
  });
});

function observation(
  id: string,
  outcome: OrderSubmissionRecoveryObservationRecord["outcome"],
  observedAtEpochMs: number,
): OrderSubmissionRecoveryObservationRecord {
  const observedAt = new Date(observedAtEpochMs).toISOString();
  return {
    id,
    orderId: "order-1",
    outcome,
    observedAt,
    observedAtEpochMs,
    detailJson: "{}",
    createdAt: observedAt,
  };
}
