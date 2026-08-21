import type { OrderOrigin, OrderRecord, StrategyDecision, SupportedMarket } from "../../domain/types.js";

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
