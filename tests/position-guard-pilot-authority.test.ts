import assert from "node:assert/strict";

import {
  validatePositionGuardPilotAbandonment,
} from "../src/modules/strategy/position-guard-pilot-authority.js";
import { test } from "./harness.js";

const EXACT_ABANDONED_EVENT = {
  authority: "PROSPECTIVE_COMPONENT_SHADOW_V1",
  event: "ABANDONED",
  eventAt: "2026-08-21T03:08:24.756Z",
  experimentId: "PCS-2026-001",
  publicationCommitSha: "358113dba5cd0425161a4aed0827f496d268d1f5",
  reason: "operator-abandoned-before-window-start-for-separately-governed-btc-only-live-pilot-no-prospective-outcomes-collected-or-evaluated",
  registrationPayloadSha256: "978e31695707453507fa604bae71f3f1657a061f891e621f2026f1e293c53b40",
  schemaVersion: 1,
} as const;

test("pilot authority accepts only the exact published abandonment", () => {
  assert.deepEqual(validatePositionGuardPilotAbandonment(EXACT_ABANDONED_EVENT), {
    valid: true,
    experimentId: "PCS-2026-001",
    eventAt: "2026-08-21T03:08:24.756Z",
  });
});

test("pilot authority rejects every material mutation of the published abandonment", () => {
  for (const event of [
    { ...EXACT_ABANDONED_EVENT, authority: "OTHER" },
    { ...EXACT_ABANDONED_EVENT, event: "REGISTERED" },
    { ...EXACT_ABANDONED_EVENT, eventAt: "2026-08-21T03:08:24.757Z" },
    { ...EXACT_ABANDONED_EVENT, experimentId: "PCS-2026-002" },
    { ...EXACT_ABANDONED_EVENT, publicationCommitSha: "0".repeat(40) },
    { ...EXACT_ABANDONED_EVENT, reason: "later-semantic-approximation" },
    { ...EXACT_ABANDONED_EVENT, registrationPayloadSha256: "0".repeat(64) },
    { ...EXACT_ABANDONED_EVENT, schemaVersion: 2 },
  ]) {
    assert.throws(() => validatePositionGuardPilotAbandonment(event));
  }
});

test("pilot authority rejects an inherited abandonment record with unrelated own keys", () => {
  const inheritedRecord = Object.assign(Object.create(EXACT_ABANDONED_EVENT), {
    unrelated1: true,
    unrelated2: true,
    unrelated3: true,
    unrelated4: true,
    unrelated5: true,
    unrelated6: true,
    unrelated7: true,
    unrelated8: true,
  });

  assert.throws(() => validatePositionGuardPilotAbandonment(inheritedRecord));
});
