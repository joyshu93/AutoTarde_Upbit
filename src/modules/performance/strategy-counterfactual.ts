import type { SupportedAsset } from "../../domain/types.js";
import {
  runPositionGuardBacktest,
  type PositionGuardBacktestFrame,
  type PositionGuardBacktestInput,
  type PositionGuardBacktestResearchExecutionPolicy,
  type PositionGuardBacktestResult,
} from "../strategy/position-guard-backtest.js";
import type { PerformanceOpeningPosition } from "./performance-calculator.js";
import {
  diagnosePerformance,
  type PerformanceDiagnosticPolicy,
  type PerformanceDiagnosticsResult,
} from "./performance-diagnostics.js";
import {
  matchPerformanceTrades,
  type PerformanceTradeFill,
  type PerformanceTradeMatchResult,
} from "./performance-trade-matcher.js";
import {
  comparePerformanceTimestamps,
  parsePerformanceTimestamp,
} from "./performance-timestamp.js";

export type CounterfactualScenario = "BASELINE" | "NO_ADD";

export interface CounterfactualInput
  extends Omit<PositionGuardBacktestInput, "researchExecutionPolicy"> {
  scenarios: readonly CounterfactualScenario[];
  diagnosticPolicy: PerformanceDiagnosticPolicy;
}

export interface CounterfactualScenarioResult {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  scenario: CounterfactualScenario;
  executionPolicy: PositionGuardBacktestResearchExecutionPolicy | null;
  sourceFrames: readonly PositionGuardBacktestFrame[];
  legacyBacktest: {
    label: "LEGACY_AVERAGE_COST_BACKTEST";
    result: PositionGuardBacktestResult;
  };
  fills: readonly PerformanceTradeFill[];
  matchResult: PerformanceTradeMatchResult;
  diagnostics: PerformanceDiagnosticsResult;
}

export function runCounterfactualScenarios(
  input: CounterfactualInput,
): readonly CounterfactualScenarioResult[] {
  validateCounterfactualInput(input);
  const frameFingerprint = fingerprintFrames(input.frames);

  return input.scenarios.map((scenario) => {
    assertFramesUnchanged(input.frames, frameFingerprint);
    const executionPolicy = policyForScenario(scenario);
    const backtest = runPositionGuardBacktest({
      asset: input.asset,
      market: input.market,
      initialCashKrw: input.initialCashKrw,
      initialQuantity: input.initialQuantity,
      initialAverageEntryPrice: input.initialAverageEntryPrice,
      frames: input.frames,
      ...(input.settings ? { settings: { ...input.settings } } : {}),
      ...(input.execution ? { execution: { ...input.execution } } : {}),
      ...(executionPolicy ? { researchExecutionPolicy: executionPolicy } : {}),
    });
    assertFramesUnchanged(input.frames, frameFingerprint);

    const fills = toPerformanceTradeFills(
      scenario,
      input.asset,
      input.market,
      input.frames,
      backtest,
    );
    const openingPositions = toOpeningPositions(input);
    const matchResult = matchPerformanceTrades({ fills, openingPositions });
    const diagnostics = {
      ...diagnosePerformance({
        fills,
        openingPositions,
        policy: { ...input.diagnosticPolicy },
      }),
      matchResult,
    };

    return {
      evidenceKind: "SIMULATED_COUNTERFACTUAL",
      scenario,
      executionPolicy,
      sourceFrames: input.frames,
      legacyBacktest: {
        label: "LEGACY_AVERAGE_COST_BACKTEST",
        result: backtest,
      },
      fills,
      matchResult,
      diagnostics,
    };
  });
}

function validateCounterfactualInput(input: CounterfactualInput): void {
  if (input.scenarios.length === 0) {
    throw new Error("Counterfactual input requires at least one scenario.");
  }

  const seen = new Set<CounterfactualScenario>();
  for (const scenario of input.scenarios) {
    if (scenario !== "BASELINE" && scenario !== "NO_ADD") {
      throw new Error(`Invalid counterfactual scenario ${String(scenario)}.`);
    }
    if (seen.has(scenario)) {
      throw new Error(`Duplicate counterfactual scenario ${scenario}.`);
    }
    seen.add(scenario);
  }

  for (const [name, value] of [
    ["initialCashKrw", input.initialCashKrw],
    ["initialQuantity", input.initialQuantity],
    ["initialAverageEntryPrice", input.initialAverageEntryPrice],
  ] as const) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite.`);
  }

  for (let index = 0; index < input.frames.length; index += 1) {
    const frame = input.frames[index]!;
    if (parsePerformanceTimestamp(frame.generatedAt) === null) {
      throw new Error(`Frame ${index} generatedAt must have an exact explicit timezone.`);
    }
    const previous = input.frames[index - 1];
    if (previous && comparePerformanceTimestamps(previous.generatedAt, frame.generatedAt) >= 0) {
      throw new Error("Counterfactual frames must be strictly ordered by generatedAt.");
    }
  }
}

function policyForScenario(
  scenario: CounterfactualScenario,
): PositionGuardBacktestResearchExecutionPolicy | null {
  return scenario === "NO_ADD"
    ? { id: "NO_ADD", suppressedActions: ["ADD"] }
    : null;
}

function toPerformanceTradeFills(
  scenario: CounterfactualScenario,
  asset: SupportedAsset,
  market: CounterfactualInput["market"],
  frames: readonly PositionGuardBacktestFrame[],
  backtest: PositionGuardBacktestResult,
): readonly PerformanceTradeFill[] {
  const fills: PerformanceTradeFill[] = [];
  backtest.frames.forEach((frameResult, frameIndex) => {
    const trade = frameResult.trade;
    if (!trade) return;
    const frame = frames[frameIndex]!;
    const stem = [
      "counterfactual",
      scenario,
      asset,
      frame.generatedAt,
      String(frameIndex),
      trade.action,
      trade.side,
    ].join(":");
    fills.push({
      id: `${stem}:fill`,
      orderId: `${stem}:order`,
      strategyDecisionId: `${stem}:decision`,
      decisionAction: trade.action,
      market,
      side: trade.side,
      priceKrw: trade.price,
      volume: trade.quantity,
      feeKrw: trade.feeKrw,
      filledAt: frame.generatedAt,
    });
  });
  return fills;
}

function toOpeningPositions(input: CounterfactualInput): readonly PerformanceOpeningPosition[] {
  if (input.initialQuantity <= 0) return [];
  return [{
    market: input.market,
    quantity: input.initialQuantity,
    averagePriceKrw: input.initialAverageEntryPrice > 0 ? input.initialAverageEntryPrice : null,
  }];
}

function fingerprintFrames(frames: readonly PositionGuardBacktestFrame[]): string {
  return JSON.stringify(frames);
}

function assertFramesUnchanged(
  frames: readonly PositionGuardBacktestFrame[],
  expectedFingerprint: string,
): void {
  if (fingerprintFrames(frames) !== expectedFingerprint) {
    throw new Error("Counterfactual frames were mutated during replay.");
  }
}
