import type { OrderOrigin, OrderRecord, StrategyDecision, SupportedMarket } from "../../domain/types.js";

interface CandidateExecutionAuthorityBase {
  readonly kind: "POSITION_GUARD_BTC_CANDIDATE";
  readonly deploymentId: string;
  readonly exchangeAccountId: string;
  readonly pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1";
  readonly market: "KRW-BTC";
  readonly strategyKey: "position_guard.paper_core.v1";
  readonly policyId: "COMBINED_CONSERVATIVE";
  readonly policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1";
  readonly activationAt: string;
  readonly activationEpochNs: bigint;
  readonly expectedDeploymentUpdatedAt: string;
  readonly expectedStateVersion: number;
}

export type CandidateExecutionAuthority =
  | Readonly<CandidateExecutionAuthorityBase & {
      expectedPhase: "ACTIVE";
      routeReason: "CANDIDATE_ALLOWED" | "CANDIDATE_EARLY_THESIS_FAILURE";
    }>
  | Readonly<CandidateExecutionAuthorityBase & {
      expectedPhase: "DRAINING";
      routeReason: "DRAINING_RISK_REDUCTION_PRESERVED";
    }>;

export type SubmissionOutcome =
  | "SUBMITTED"
  | "SIMULATED_FILLED"
  | "REJECTED"
  | "DUPLICATE"
  | "LEASE_BLOCKED"
  | "RECONCILIATION_REQUIRED";

export interface SubmitOrderFromDecisionInput {
  exchangeAccountId: string;
  strategyDecisionId: string | null;
  referencePriceCapturedAt: string;
  decision: StrategyDecision;
  side: "bid" | "ask";
  ordType: "limit" | "price" | "market" | "best";
  price: string | null;
  volume: string | null;
  origin?: OrderOrigin;
  market?: SupportedMarket;
}

export type SubmitOrderFromDecisionResult =
  | {
      accepted: true;
      outcome: "SUBMITTED" | "SIMULATED_FILLED";
      order: OrderRecord;
      reason: null;
    }
  | {
      accepted: false;
      outcome: "DUPLICATE";
      order: OrderRecord;
      reason: string;
    }
  | {
      accepted: false;
      outcome: "LEASE_BLOCKED";
      order: null;
      reason: string;
    }
  | {
      accepted: false;
      outcome: "RECONCILIATION_REQUIRED";
      order: OrderRecord;
      reason: string;
    }
  | {
      accepted: false;
      outcome: "REJECTED";
      order: OrderRecord | null;
      reason: string;
    };
