import assert from "node:assert/strict";

import type { OrderRecord } from "../src/domain/types.js";
import { classifySubmissionBlockingOrder } from "../src/domain/submission-blocking-order.js";
import { test } from "./harness.js";

test("submission-blocking classification distinguishes unresolved dispatch from definitive terminal proof", () => {
  for (const status of ["FAILED", "REJECTED"] as const) {
    assert.equal(classify({ status, failureCode: null }).blocking, false, `${status} pre-send`);
    assert.equal(classify({
      status,
      failureCode: "SUBMISSION_RESPONSE_UNCERTAIN",
      events: [event("RECONCILIATION_RECOVERY_REQUIRED", "EXCHANGE")],
    }).blocking, true, `${status} uncertain`);
  }

  assert.deepEqual(classify({
    status: "REJECTED",
    failureCode: "EXCHANGE_ORDER_REJECTED",
    exchangeResponseJson: "{}",
    events: [event("ORDER_REJECTED", "EXCHANGE")],
  }).reasonCode, "EXCHANGE_REJECTION_CONFIRMED");
  assert.deepEqual(classify({
    status: "FAILED",
    failureCode: "ORDER_SUBMISSION_ABSENCE_CONFIRMED",
    events: [event("RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED", "RECONCILIATION")],
    observations: [
      { outcome: "NOT_FOUND", observedAtEpochMs: 1_000 },
      { outcome: "NOT_FOUND", observedAtEpochMs: 2_000 },
    ],
  }).reasonCode, "BOUNDED_ABSENCE_CONFIRMED");
});

test("later submission or durable FOUND evidence overrides terminal resolution authority", () => {
  assert.equal(classify({
    status: "REJECTED",
    failureCode: "EXCHANGE_ORDER_REJECTED",
    exchangeResponseJson: "{}",
    events: [
      event("ORDER_REJECTED", "EXCHANGE"),
      event("ORDER_SUBMITTED", "EXCHANGE"),
    ],
  }).blocking, true);
  assert.equal(classify({
    status: "FAILED",
    failureCode: "ORDER_SUBMISSION_ABSENCE_CONFIRMED",
    events: [event("RECONCILIATION_IDENTIFIER_ABSENCE_CONFIRMED", "RECONCILIATION")],
    observations: [
      { outcome: "NOT_FOUND", observedAtEpochMs: 1_000 },
      { outcome: "FOUND", observedAtEpochMs: 2_000 },
      { outcome: "NOT_FOUND", observedAtEpochMs: 3_000 },
    ],
  }).blocking, true);
});

function classify(input: {
  status: OrderRecord["status"];
  failureCode: string | null;
  exchangeResponseJson?: string | null;
  events?: Array<ReturnType<typeof event>>;
  observations?: Array<{ outcome: "FOUND" | "NOT_FOUND" | "TRANSIENT_FAILURE"; observedAtEpochMs: number }>;
}) {
  return classifySubmissionBlockingOrder({
    order: {
      id: "order-1",
      status: input.status,
      failureCode: input.failureCode,
      upbitUuid: null,
      exchangeResponseJson: input.exchangeResponseJson ?? null,
    },
    events: input.events ?? [],
    recoveryObservations: input.observations ?? [],
  });
}

function event(
  eventType: string,
  eventSource: "LOCAL" | "EXCHANGE" | "RECONCILIATION" | "TELEGRAM",
) {
  return { eventType, eventSource, createdAt: "2026-08-21T00:00:00.000Z" };
}
