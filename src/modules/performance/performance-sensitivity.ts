import type { PositionGuardBacktestFrame } from "../strategy/position-guard-backtest.js";
import type { Metric } from "./performance-diagnostics.js";
import {
  runCounterfactualScenarios,
  type CounterfactualInput,
  type CounterfactualScenario,
  type CounterfactualScenarioResult,
} from "./strategy-counterfactual.js";

export type CostScenario = {
  id: string;
  feeRate: number;
  slippageRate: number;
};

export interface CostSensitivityInput extends Omit<CounterfactualInput, "execution"> {
  minimumTradeValueKrw: number;
  costScenarios: readonly CostScenario[];
}

export type CostSensitivityCell = {
  evidenceKind: "MODELED_COST_SCENARIO";
  scenario: CounterfactualScenario;
  costScenario: CostScenario;
  sourceFrames: readonly PositionGuardBacktestFrame[];
  finalEquityKrw: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  costMetricScope?: "ALL_SIMULATED_FILLS";
  turnoverKrw: Metric<number>;
  modeledFeesKrw: Metric<number>;
  fifoOutcomeMetricScope?: "SELECTED_STREAM_FIFO";
  completedEpisodeCount: number;
  episodeWinRate: Metric<number>;
  profitFactor: Metric<number>;
  counterfactual: CounterfactualScenarioResult;
};

export type CostSensitivityResult = {
  asset: CostSensitivityInput["asset"];
  market: CostSensitivityInput["market"];
  scenarios: readonly CounterfactualScenario[];
  costScenarios: readonly CostScenario[];
  sourceFrames: readonly PositionGuardBacktestFrame[];
  cells: readonly CostSensitivityCell[];
};

export function runCostSensitivity(input: CostSensitivityInput): CostSensitivityResult {
  validateCostSensitivityInput(input);
  const cells: CostSensitivityCell[] = [];

  for (const scenario of input.scenarios) {
    for (const costScenario of input.costScenarios) {
      const [counterfactual] = runCounterfactualScenarios({
        asset: input.asset,
        market: input.market,
        initialCashKrw: input.initialCashKrw,
        initialQuantity: input.initialQuantity,
        initialAverageEntryPrice: input.initialAverageEntryPrice,
        frames: input.frames,
        scenarios: [scenario],
        diagnosticPolicy: { ...input.diagnosticPolicy },
        execution: {
          feeRate: costScenario.feeRate,
          slippageRate: costScenario.slippageRate,
          minimumTradeValueKrw: input.minimumTradeValueKrw,
        },
        ...(input.settings ? { settings: { ...input.settings } } : {}),
      });
      if (!counterfactual) throw new Error("Cost sensitivity replay returned no scenario result.");

      const metrics = counterfactual.legacyBacktest.result.metrics;
      const diagnostics = counterfactual.diagnostics.combined;
      const allFillCosts = summarizeAllFillCosts(counterfactual.fills);
      assertFiniteResult(metrics.finalEquityKrw, "finalEquityKrw");
      assertFiniteResult(metrics.totalReturnPct, "totalReturnPct");
      assertFiniteResult(metrics.maxDrawdownPct, "maxDrawdownPct");

      cells.push({
        evidenceKind: "MODELED_COST_SCENARIO",
        scenario,
        costScenario: { ...costScenario },
        sourceFrames: counterfactual.sourceFrames,
        finalEquityKrw: metrics.finalEquityKrw,
        totalReturnPct: metrics.totalReturnPct,
        maxDrawdownPct: metrics.maxDrawdownPct,
        costMetricScope: "ALL_SIMULATED_FILLS",
        turnoverKrw: allFillCosts.turnoverKrw,
        modeledFeesKrw: allFillCosts.modeledFeesKrw,
        fifoOutcomeMetricScope: "SELECTED_STREAM_FIFO",
        completedEpisodeCount: diagnostics.completedEpisodeCount,
        episodeWinRate: diagnostics.episodeWinRate,
        profitFactor: diagnostics.profitFactor,
        counterfactual,
      });
    }
  }

  return {
    asset: input.asset,
    market: input.market,
    scenarios: [...input.scenarios],
    costScenarios: input.costScenarios.map((scenario) => ({ ...scenario })),
    sourceFrames: input.frames,
    cells,
  };
}

function summarizeAllFillCosts(
  fills: CounterfactualScenarioResult["fills"],
): Pick<CostSensitivityCell, "turnoverKrw" | "modeledFeesKrw"> {
  let turnoverKrw = 0;
  let modeledFeesKrw = 0;
  let feesComplete = true;

  for (const fill of fills) {
    const turnover = fill.priceKrw * fill.volume;
    assertFiniteNonNegativeCost(turnover, `Fill ${fill.id} turnover`);
    turnoverKrw += turnover;
    assertFiniteNonNegativeCost(turnoverKrw, "All-fill turnover");

    if (fill.feeKrw === null) {
      feesComplete = false;
      continue;
    }
    assertFiniteNonNegativeCost(fill.feeKrw, `Fill ${fill.id} modeled fee`);
    modeledFeesKrw += fill.feeKrw;
    assertFiniteNonNegativeCost(modeledFeesKrw, "All-fill modeled fees");
  }

  return {
    turnoverKrw: { status: "KNOWN", value: turnoverKrw },
    modeledFeesKrw: feesComplete
      ? { status: "KNOWN", value: modeledFeesKrw }
      : { status: "UNKNOWN", reasons: ["MISSING_MODELED_FILL_FEE"] },
  };
}

function validateCostSensitivityInput(input: CostSensitivityInput): void {
  if (input.costScenarios.length === 0) {
    throw new Error("Cost sensitivity requires at least one cost scenario.");
  }
  if (!Number.isFinite(input.minimumTradeValueKrw) || input.minimumTradeValueKrw < 0) {
    throw new Error("minimumTradeValueKrw must be a finite non-negative number.");
  }

  const ids = new Set<string>();
  const ratePairs = new Set<string>();
  for (const scenario of input.costScenarios) {
    if (scenario.id.trim().length === 0) {
      throw new Error("Cost scenario id must be non-empty.");
    }
    if (ids.has(scenario.id)) {
      throw new Error(`Duplicate cost scenario id ${scenario.id}.`);
    }
    ids.add(scenario.id);

    assertFiniteNonNegativeRate(scenario.feeRate, "feeRate");
    assertFiniteNonNegativeRate(scenario.slippageRate, "slippageRate");
    const ratePair = `${scenario.feeRate}:${scenario.slippageRate}`;
    if (ratePairs.has(ratePair)) {
      throw new Error(
        `Duplicate cost rates feeRate=${scenario.feeRate} slippageRate=${scenario.slippageRate}.`,
      );
    }
    ratePairs.add(ratePair);
  }
}

function assertFiniteNonNegativeRate(value: number, field: "feeRate" | "slippageRate"): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number.`);
  }
  if (field === "slippageRate" && value >= 1) {
    throw new Error("slippageRate must be less than 1 to preserve positive execution prices.");
  }
}

function assertFiniteResult(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`Cost sensitivity ${field} must be finite.`);
  }
}

function assertFiniteNonNegativeCost(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number.`);
  }
}
