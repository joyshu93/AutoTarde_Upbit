export type PositionGuardPolicySelection =
  | Readonly<{
      kind: "BASELINE";
      pilotId: null;
    }>
  | Readonly<{
      kind: "BTC_CANDIDATE_PILOT";
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1";
      market: "KRW-BTC";
      policyId: "COMBINED_CONSERVATIVE";
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1";
      liveOperatorConfirmed: true;
    }>;

export type PositionGuardPilotAbandonmentRecord = Readonly<{
  authority: string;
  event: string;
  eventAt: string;
  experimentId: string;
  publicationCommitSha: string;
  reason: string;
  registrationPayloadSha256: string;
  schemaVersion: number;
}>;

export type PositionGuardPilotAbandonmentValidation = Readonly<{
  valid: true;
  experimentId: "PCS-2026-001";
  eventAt: "2026-08-21T03:08:24.756Z";
}>;
