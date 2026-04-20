import type { RiskEvaluationContext, RiskEvaluationResult } from "../../domain/types.js";

export interface RiskEvaluator {
  evaluate(context: RiskEvaluationContext): RiskEvaluationResult;
}
