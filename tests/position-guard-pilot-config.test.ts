import assert from "node:assert/strict";

import {
  POSITION_GUARD_PILOT_CONFIRMATION,
  POSITION_GUARD_PILOT_ID,
  parsePositionGuardPolicySelection,
} from "../src/app/position-guard-pilot-config.js";
import { test } from "./harness.js";

test("pilot config defaults to baseline and rejects every implicit candidate selection", () => {
  assert.deepEqual(parsePositionGuardPolicySelection({}), {
    kind: "BASELINE",
    pilotId: null,
  });
  assert.throws(() => parsePositionGuardPolicySelection({
    POSITION_GUARD_PILOT_ID: "combined_conservative",
  }));
  assert.throws(() => parsePositionGuardPolicySelection({
    POSITION_GUARD_PILOT_ID: "COMBINED_MINUS_COOLDOWN_CONTROL",
  }));
});

test("the only LIVE pilot maps to the frozen BTC policy and exact confirmation", () => {
  const selection = parsePositionGuardPolicySelection({
    APP_EXECUTION_MODE: "LIVE",
    POSITION_GUARD_PILOT_ID,
    POSITION_GUARD_PILOT_CONFIRMATION,
  });

  assert.equal(selection.kind, "BTC_CANDIDATE_PILOT");
  if (selection.kind !== "BTC_CANDIDATE_PILOT") {
    throw new Error("expected candidate pilot");
  }

  assert.equal(selection.market, "KRW-BTC");
  assert.equal(selection.policyId, "COMBINED_CONSERVATIVE");
  assert.equal(selection.policyVersion, "PCS-2026-001.DEPLOYMENT_READINESS_V1");
  assert.equal(selection.liveOperatorConfirmed, true);
});

test("pilot config rejects the exact pilot outside LIVE mode or without confirmation", () => {
  assert.throws(() => parsePositionGuardPolicySelection({
    POSITION_GUARD_PILOT_ID,
    POSITION_GUARD_PILOT_CONFIRMATION,
  }));
  assert.throws(() => parsePositionGuardPolicySelection({
    APP_EXECUTION_MODE: "LIVE",
    POSITION_GUARD_PILOT_ID,
  }));
});
