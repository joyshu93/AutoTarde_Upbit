import type { StrategyDecision } from "../../domain/types.js";
import type { Strategy, StrategyInput } from "./interfaces.js";

export class DeterministicStubStrategy implements Strategy {
  decide(input: StrategyInput): StrategyDecision {
    return createHoldDecision(input.market, input.referencePrice);
  }
}

export function createHoldDecision(market: StrategyInput["market"], referencePrice: number): StrategyDecision {
  return {
    strategyKey: "deterministic.stub.v1",
    market,
    action: "HOLD",
    reasonCodes: ["INITIAL_STUB"],
    referencePrice,
    requestedNotionalKrw: null,
    requestedQuantity: null,
    metadata: {
      rationale: "No live strategy has been enabled yet.",
    },
  };
}
