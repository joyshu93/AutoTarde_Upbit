import type { StrategyDecision, SupportedMarket } from "../../domain/types.js";

export interface StrategyInput {
  market: SupportedMarket;
  referencePrice: number;
}

export interface Strategy {
  decide(input: StrategyInput): StrategyDecision;
}
