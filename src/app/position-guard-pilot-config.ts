import type { PositionGuardPolicySelection } from "../domain/pilot-types.js";

export const POSITION_GUARD_PILOT_ID = "BTC_COMBINED_CONSERVATIVE_PILOT_V1" as const;
export const POSITION_GUARD_PILOT_CONFIRMATION = "I_UNDERSTAND_BTC_CANDIDATE_LIVE_PILOT" as const;
const POSITION_GUARD_PILOT_POLICY_VERSION = "PCS-2026-001.DEPLOYMENT_READINESS_V1" as const;

const BASELINE_SELECTION: PositionGuardPolicySelection = Object.freeze({
  kind: "BASELINE",
  pilotId: null,
});

export function parsePositionGuardPolicySelection(
  env: NodeJS.ProcessEnv,
): PositionGuardPolicySelection {
  const configuredPilotId = env.POSITION_GUARD_PILOT_ID;
  const configuredConfirmation = env.POSITION_GUARD_PILOT_CONFIRMATION;

  if (configuredPilotId === undefined && configuredConfirmation === undefined) {
    return BASELINE_SELECTION;
  }

  if (env.APP_EXECUTION_MODE?.trim().toUpperCase() !== "LIVE") {
    throw new Error("PositionGuard pilot selection requires APP_EXECUTION_MODE=LIVE.");
  }
  if (configuredPilotId !== POSITION_GUARD_PILOT_ID) {
    throw new Error("POSITION_GUARD_PILOT_ID is not the approved BTC pilot.");
  }
  if (configuredConfirmation !== POSITION_GUARD_PILOT_CONFIRMATION) {
    throw new Error("POSITION_GUARD_PILOT_CONFIRMATION is required for the BTC pilot.");
  }

  return Object.freeze({
    kind: "BTC_CANDIDATE_PILOT",
    pilotId: POSITION_GUARD_PILOT_ID,
    market: "KRW-BTC",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: POSITION_GUARD_PILOT_POLICY_VERSION,
    liveOperatorConfirmed: true,
  });
}
