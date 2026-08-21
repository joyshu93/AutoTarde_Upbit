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

export type PositionGuardPilotPhase =
  | "DISABLED"
  | "PENDING_FLAT"
  | "ACTIVE"
  | "PAUSED_FAULT"
  | "DRAINING";

export interface PositionGuardPilotDeploymentRecord {
  id: string;
  exchangeAccountId: string;
  pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1";
  market: "KRW-BTC";
  policyId: "COMBINED_CONSERVATIVE";
  policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1";
  phase: PositionGuardPilotPhase;
  createdAt: string;
  updatedAt: string;
}

export type PositionGuardPilotAuditEventType =
  | "DEPLOYMENT_CREATED"
  | "STATE_ADVANCED"
  | "PHASE_TRANSITION"
  | "FAULT_PAUSED"
  | "ROLLBACK_STARTED"
  | "ROLLBACK_COMPLETED";

export interface PositionGuardPilotAuditEventRecord {
  id: string;
  deploymentId: string;
  eventType: PositionGuardPilotAuditEventType;
  fromPhase: PositionGuardPilotPhase | null;
  toPhase: PositionGuardPilotPhase | null;
  stateVersion: number;
  payloadJson: string;
  createdAt: string;
}

export interface AccountExecutionLeaseRecord {
  exchangeAccountId: string;
  ownerToken: string;
  purpose: "ORDER_SUBMISSION";
  acquiredAtEpochMs: number;
  expiresAtEpochMs: number;
}

export interface OrderSubmissionRecoveryObservationRecord {
  id: string;
  orderId: string;
  outcome: "FOUND" | "NOT_FOUND" | "TRANSIENT_FAILURE";
  observedAt: string;
  observedAtEpochMs: number;
  detailJson: string;
  createdAt: string;
}

export interface CandidateExecutionBindingRecord {
  id: string;
  deploymentId: string;
  strategyDecisionId: string;
  orderId: string;
  exchangeAccountId: string;
  activationAt: string;
  activationEpochNs: bigint;
  market: "KRW-BTC";
  strategyKey: "position_guard.paper_core.v1";
  policyId: "COMBINED_CONSERVATIVE";
  policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1";
  executionMode: "DRY_RUN" | "LIVE";
  ordType: "limit" | "price" | "market" | "best";
  action: "ENTER" | "ADD" | "REDUCE" | "EXIT";
  side: "bid" | "ask";
  intendedQuantity: string | null;
  intendedNotionalKrw: string | null;
  createdAt: string;
}

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
