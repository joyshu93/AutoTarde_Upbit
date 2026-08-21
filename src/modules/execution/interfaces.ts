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

export interface SubmitOrderFromDecisionResult {
  accepted: boolean;
  order: OrderRecord | null;
  reason: string | null;
  outcome?: SubmissionOutcome;
}
