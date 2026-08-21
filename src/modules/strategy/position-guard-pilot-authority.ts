import type {
  PositionGuardPilotAbandonmentRecord,
  PositionGuardPilotAbandonmentValidation,
} from "../../domain/pilot-types.js";

const EXACT_ABANDONED_RECORD = Object.freeze({
  authority: "PROSPECTIVE_COMPONENT_SHADOW_V1",
  event: "ABANDONED",
  eventAt: "2026-08-21T03:08:24.756Z",
  experimentId: "PCS-2026-001",
  publicationCommitSha: "358113dba5cd0425161a4aed0827f496d268d1f5",
  reason: "operator-abandoned-before-window-start-for-separately-governed-btc-only-live-pilot-no-prospective-outcomes-collected-or-evaluated",
  registrationPayloadSha256: "978e31695707453507fa604bae71f3f1657a061f891e621f2026f1e293c53b40",
  schemaVersion: 1,
} as const);

export function validatePositionGuardPilotAbandonment(
  value: unknown,
): PositionGuardPilotAbandonmentValidation {
  if (!isExactAbandonedRecord(value)) {
    throw new Error("PositionGuard pilot abandonment authority does not match the published registry event.");
  }

  return Object.freeze({
    valid: true,
    experimentId: EXACT_ABANDONED_RECORD.experimentId,
    eventAt: EXACT_ABANDONED_RECORD.eventAt,
  });
}

function isExactAbandonedRecord(value: unknown): value is PositionGuardPilotAbandonmentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const expectedEntries = Object.entries(EXACT_ABANDONED_RECORD);
  if (Object.keys(candidate).length !== expectedEntries.length) {
    return false;
  }

  return expectedEntries.every(([key, expectedValue]) => candidate[key] === expectedValue);
}
