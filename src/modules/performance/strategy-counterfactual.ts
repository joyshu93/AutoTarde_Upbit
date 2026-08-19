import type { StrategyDecisionAction, SupportedAsset } from "../../domain/types.js";
import {
  runPositionGuardBacktest,
  type PositionGuardBacktestExecutionTimingModel,
  type PositionGuardBacktestFrame,
  type PositionGuardBacktestInput,
  type PositionGuardBacktestResearchExecutionPolicy,
  type PositionGuardBacktestResearchExecutionPolicyId,
  type PositionGuardBacktestResult,
} from "../strategy/position-guard-backtest.js";
import { BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY } from
  "../strategy/position-guard-research-manifest.js";
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

export type CounterfactualScenario = "BASELINE" | PositionGuardBacktestResearchExecutionPolicyId;

export const SUPPORTED_COUNTERFACTUAL_SCENARIOS = Object.freeze([
  "BASELINE",
  "NO_ADD",
  "ADD_RISK_CLEAR",
  "ADD_HIGH_ALIGNMENT",
  "ADD_CORE_TREND",
  ...BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.scenarioOrder,
] as const satisfies readonly CounterfactualScenario[]);

export function isSupportedCounterfactualScenario(
  value: unknown,
): value is CounterfactualScenario {
  return typeof value === "string"
    && (SUPPORTED_COUNTERFACTUAL_SCENARIOS as readonly string[]).includes(value);
}

export const BROAD_LOSS_CAUSE_RESEARCH_MANIFEST = Object.freeze({
  authorityId: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.id,
  developmentRange: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.developmentRange,
  validationWindows: Object.freeze(Object.fromEntries(
    BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.validationWindows.map((window) => [
      window.id,
      Object.freeze({ from: window.from, to: window.to }),
    ]),
  )),
  costCells: {
    BASE: Object.freeze({
      role: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.costCells[0].role,
      feeRate: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.costCells[0].feeRate,
      slippageRate: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.costCells[0].slippageRate,
    }),
    STRESS: Object.freeze({
      role: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.costCells[1].role,
      feeRate: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.costCells[1].feeRate,
      slippageRate: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.costCells[1].slippageRate,
    }),
  },
  executionTimingModels: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.executionTimingModels,
  scenarioOrder: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.scenarioOrder,
  scenarios: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.policy.scenarios,
});

type CounterfactualExecutionPolicy = PositionGuardBacktestResearchExecutionPolicy<
  PositionGuardBacktestResearchExecutionPolicyId
>;

export interface CounterfactualInput
  extends Omit<PositionGuardBacktestInput, "researchExecutionPolicy"> {
  scenarios: readonly CounterfactualScenario[];
  diagnosticPolicy: PerformanceDiagnosticPolicy;
}

export interface CounterfactualScenarioResult {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  scenario: CounterfactualScenario;
  executionPolicy: CounterfactualExecutionPolicy | null;
  sourceFrames: readonly PositionGuardBacktestFrame[];
  legacyBacktest: {
    label: "LEGACY_AVERAGE_COST_BACKTEST";
    result: PositionGuardBacktestResult;
  };
  fills: readonly PerformanceTradeFill[];
  matchResult: PerformanceTradeMatchResult;
  diagnostics: PerformanceDiagnosticsResult;
  executionTimingProvenance: CounterfactualExecutionTimingProvenance;
  modeledFillAttributions?: readonly CounterfactualModeledFillAttribution[];
}

export interface CounterfactualModeledFillAttribution {
  fillId: string;
  scenario: CounterfactualScenario;
  decisionGeneratedAt: string;
  decisionFrameIndex: number;
  executedAt: string;
  executionFrameIndex: number;
  originalAction: StrategyDecisionAction;
  effectiveAction: PerformanceTradeFill["decisionAction"];
  intervention: Readonly<{
    outcome: "ALLOW" | "SUPPRESS" | "OVERRIDE_EXIT";
    reason: string;
  }> | null;
}

export interface CounterfactualExecutionTimingProvenance {
  model: PositionGuardBacktestExecutionTimingModel;
  observedExecution: false;
  caveat: string;
}

export function runCounterfactualScenarios(
  input: CounterfactualInput,
): readonly CounterfactualScenarioResult[] {
  validateCounterfactualInput(input);
  const frameFingerprint = fingerprintFrames(input.frames);

  return input.scenarios.map((scenario) => {
    assertFramesUnchanged(input.frames, frameFingerprint);
    const executionPolicy = policyForScenario(scenario);
    const executionTimingModel = input.executionTimingModel ?? "SAME_CLOSE_MODELED";
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
      ...(input.researchCarryInState
        ? { researchCarryInState: { ...input.researchCarryInState } }
        : {}),
      executionTimingModel,
    });
    assertFramesUnchanged(input.frames, frameFingerprint);

    const modeledFills = toPerformanceTradeFills(
      scenario,
      input.asset,
      input.market,
      input.frames,
      backtest,
    );
    const fills = modeledFills.fills;
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
      executionTimingProvenance: getExecutionTimingProvenance(executionTimingModel),
      ...(modeledFills.attributions.length > 0
        ? { modeledFillAttributions: modeledFills.attributions }
        : {}),
    };
  });
}

function validateCounterfactualInput(input: CounterfactualInput): void {
  if (input.scenarios.length === 0) {
    throw new Error("Counterfactual input requires at least one scenario.");
  }

  const seen = new Set<CounterfactualScenario>();
  for (const scenario of input.scenarios) {
    policyForScenario(scenario);
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
): CounterfactualExecutionPolicy | null {
  switch (scenario) {
    case "BASELINE":
      return null;
    case "NO_ADD":
      return { id: "NO_ADD", suppressedActions: ["ADD"] };
    case "ADD_RISK_CLEAR":
      return { id: "ADD_RISK_CLEAR" };
    case "ADD_HIGH_ALIGNMENT":
      return { id: "ADD_HIGH_ALIGNMENT" };
    case "ADD_CORE_TREND":
      return { id: "ADD_CORE_TREND" };
    case "HTF_TREND_GATE":
      return { id: "HTF_TREND_GATE" };
    case "STRICT_PULLBACK":
      return { id: "STRICT_PULLBACK" };
    case "EARLY_THESIS_FAILURE":
      return { id: "EARLY_THESIS_FAILURE" };
    case "ADD_LIMITED":
      return { id: "ADD_LIMITED" };
    case "COOLDOWN_CONTROL":
      return { id: "COOLDOWN_CONTROL" };
    case "COMBINED_CONSERVATIVE":
      return { id: "COMBINED_CONSERVATIVE" };
    default: {
      const exhaustiveScenario: never = scenario;
      throw new Error(`Invalid counterfactual scenario ${String(exhaustiveScenario)}.`);
    }
  }
}

function getExecutionTimingProvenance(
  model: PositionGuardBacktestExecutionTimingModel,
): CounterfactualExecutionTimingProvenance {
  return model === "SAME_CLOSE_MODELED"
    ? {
        model,
        observedExecution: false,
        caveat: "Core decisions are modeled at each frame close and filled at that same close.",
      }
    : {
        model,
        observedExecution: false,
        caveat: "Core decisions are modeled at one frame close and filled at the next completed frame close.",
      };
}

function toPerformanceTradeFills(
  scenario: CounterfactualScenario,
  asset: SupportedAsset,
  market: CounterfactualInput["market"],
  frames: readonly PositionGuardBacktestFrame[],
  backtest: PositionGuardBacktestResult,
): Readonly<{
  fills: readonly PerformanceTradeFill[];
  attributions: readonly CounterfactualModeledFillAttribution[];
}> {
  const fills: PerformanceTradeFill[] = [];
  const attributions: CounterfactualModeledFillAttribution[] = [];
  backtest.frames.forEach((frameResult, frameIndex) => {
    const trade = frameResult.trade;
    if (!trade) return;
    const frame = frames[frameIndex]!;
    const origin = frameResult.modeledTradeOrigin;
    const legacyStem = [
      "counterfactual",
      scenario,
      asset,
      frame.generatedAt,
      String(frameIndex),
      trade.action,
      trade.side,
    ].join(":");
    const decisionStem = origin
      ? [
          "counterfactual",
          scenario,
          asset,
          origin.decisionGeneratedAt,
          String(origin.decisionFrameIndex),
          origin.originalAction,
        ].join(":")
      : legacyStem;
    const executionStem = origin
      ? [
          decisionStem,
          "effective",
          origin.effectiveAction,
          "intervention",
          origin.intervention?.outcome ?? "NONE",
          origin.intervention?.reason ?? "NONE",
          "executed",
          origin.executedAt,
          String(origin.executionFrameIndex),
          trade.side,
        ].join(":")
      : legacyStem;
    const fill: PerformanceTradeFill = {
      id: `${executionStem}:fill`,
      orderId: `${executionStem}:order`,
      strategyDecisionId: `${decisionStem}:decision`,
      decisionAction: origin ? origin.effectiveAction : trade.action,
      market,
      side: trade.side,
      priceKrw: trade.price,
      volume: trade.quantity,
      feeKrw: trade.feeKrw,
      filledAt: frame.generatedAt,
    };
    fills.push(fill);
    if (origin) {
      attributions.push({
        fillId: fill.id,
        scenario,
        decisionGeneratedAt: origin.decisionGeneratedAt,
        decisionFrameIndex: origin.decisionFrameIndex,
        executedAt: origin.executedAt,
        executionFrameIndex: origin.executionFrameIndex,
        originalAction: origin.originalAction,
        effectiveAction: origin.effectiveAction,
        intervention: origin.intervention,
      });
    } else if (frameResult.researchIntervention) {
      attributions.push({
        fillId: fill.id,
        scenario,
        decisionGeneratedAt: frame.generatedAt,
        decisionFrameIndex: frameIndex,
        executedAt: frame.generatedAt,
        executionFrameIndex: frameIndex,
        originalAction: frameResult.researchIntervention.originalAction,
        effectiveAction: trade.action,
        intervention: {
          outcome: frameResult.researchIntervention.outcome,
          reason: frameResult.researchIntervention.reason,
        },
      });
    }
  });
  return { fills, attributions };
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
