import type { OrderOrigin, OrderRecord, StrategyDecision, SupportedMarket } from "../../domain/types.js";

export interface SubmitOrderFromDecisionInput {
  exchangeAccountId: string;
  strategyDecisionId: string | null;
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
}
