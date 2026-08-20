import type { StrategyDecisionAction, SupportedAsset, SupportedMarket } from "../../domain/types.js";
import {
  DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
  decidePositionGuardCore,
  type PositionGuardEngineDecision,
  type PositionGuardStrategyContext,
  type PositionGuardStrategySettings,
  type PositionGuardStructureAnalysis,
  type PreviousPositionGuardDecision,
  type StrategyEntryPath,
  type StrategyMarketRegime,
} from "./position-guard-core.js";
import type { SupportedStrategyTimeframe } from "./market-structure.js";
import { performanceTimestampEpochNanoseconds } from "../performance/performance-timestamp.js";
import {
  BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY,
  COMBINED_CONSERVATIVE_ABLATION_RESEARCH_AUTHORITY,
  COMBINED_CONSERVATIVE_COMPONENTS,
  type CombinedConservativeComponent,
  type FrozenBroadLossCauseScenario,
  type FrozenCombinedConservativeAblationScenario,
} from "./position-guard-research-manifest.js";

export interface PositionGuardBacktestFrame {
  generatedAt: string;
  analysis: PositionGuardStructureAnalysis;
  source?: {
    candleCounts: Record<SupportedStrategyTimeframe, number>;
    latestCloseTime: Record<SupportedStrategyTimeframe, string | null>;
  };
}

export interface PositionGuardBacktestExecutionModel {
  feeRate: number;
  slippageRate: number;
  minimumTradeValueKrw: number;
}

export interface PositionGuardBacktestInput {
  asset: SupportedAsset;
  market: SupportedMarket;
  initialCashKrw: number;
  initialQuantity: number;
  initialAverageEntryPrice: number;
  frames: readonly PositionGuardBacktestFrame[];
  settings?: PositionGuardStrategySettings;
  execution?: PositionGuardBacktestExecutionModel;
  researchExecutionPolicy?: PositionGuardBacktestResearchExecutionPolicy;
  researchCarryInState?: PositionGuardBacktestResearchState;
  executionTimingModel?: PositionGuardBacktestExecutionTimingModel;
}

export type PositionGuardBacktestExecutionTimingModel =
  | "SAME_CLOSE_MODELED"
  | "NEXT_FRAME_MODELED";

export type PositionGuardBacktestFrozenResearchPolicyId = FrozenBroadLossCauseScenario;

export type PositionGuardBacktestAblationResearchPolicyId =
  FrozenCombinedConservativeAblationScenario;

export type PositionGuardBacktestInterventionPolicyId =
  | PositionGuardBacktestFrozenResearchPolicyId
  | PositionGuardBacktestAblationResearchPolicyId;

export type PositionGuardBacktestResearchExecutionPolicyId =
  | "NO_ADD"
  | "ADD_RISK_CLEAR"
  | "ADD_HIGH_ALIGNMENT"
  | "ADD_CORE_TREND"
  | PositionGuardBacktestInterventionPolicyId;

type PositionGuardBacktestConditionalAddPolicyId =
  | "ADD_RISK_CLEAR"
  | "ADD_HIGH_ALIGNMENT"
  | "ADD_CORE_TREND";

export interface PositionGuardBacktestResearchState {
  currentEpisodeAddCount: number;
  currentEpisodeRealizedPnlKrw: number;
  lastFullExitAt: string | null;
  lastFullExitRealizedPnlKrw: number | null;
  lastEntryPath: StrategyEntryPath | null;
}

export const POSITION_GUARD_RESEARCH_POLICY_MANIFEST =
  BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.policy;

export type PositionGuardBacktestResearchExecutionPolicy<
  TId extends PositionGuardBacktestResearchExecutionPolicyId = PositionGuardBacktestResearchExecutionPolicyId,
> = TId extends "NO_ADD"
  ? {
      id: "NO_ADD";
      suppressedActions: readonly ["ADD"] | readonly "ADD"[];
    }
  : {
      id: TId;
      suppressedActions?: never;
    };

interface PositionGuardBacktestNoAddSuppression {
  policyId: "NO_ADD";
  originalAction: "ADD";
  reason: "ACTION_SUPPRESSED";
}

interface PositionGuardBacktestConditionalAddSuppression {
  policyId: PositionGuardBacktestConditionalAddPolicyId;
  originalAction: "ADD";
  reason:
    | "ATR_SHOCK"
    | "WEAKENING_PRESENT"
    | "TREND_ALIGNMENT_BELOW_4"
    | "REGIME_NOT_CORE_TREND";
  generatedAt: string;
  analysisSnapshot: Pick<
    PositionGuardStructureAnalysis,
    "atrShock" | "weakeningStage" | "trendAlignmentScore" | "regime"
  >;
}

export type PositionGuardBacktestResearchSuppression =
  | PositionGuardBacktestNoAddSuppression
  | PositionGuardBacktestConditionalAddSuppression;

type PositionGuardBacktestConditionalAddPolicyEvidence = {
  policyId: PositionGuardBacktestConditionalAddPolicyId;
  originalAction: "ADD";
  generatedAt: string;
  analysisSnapshot: Pick<
    PositionGuardStructureAnalysis,
    "atrShock" | "weakeningStage" | "trendAlignmentScore" | "regime"
  >;
}

export type PositionGuardBacktestConditionalAddPolicyEvaluation =
  | (PositionGuardBacktestConditionalAddPolicyEvidence & {
      outcome: "ALLOW";
      reason: "CONDITIONS_MET";
    })
  | (PositionGuardBacktestConditionalAddPolicyEvidence & {
      outcome: "SUPPRESS";
      reason: PositionGuardBacktestConditionalAddSuppression["reason"];
    });

export type PositionGuardBacktestResearchInterventionReason =
  | "CONDITIONS_MET"
  | "RISK_REDUCING_DECISION_PRESERVED"
  | "HTF_BREAKDOWN"
  | "TREND_ALIGNMENT_BELOW_3"
  | "WEAKENING_PRESENT"
  | "REGIME_NOT_ENTRY_TREND"
  | "ENTRY_PATH_NOT_PULLBACK"
  | "PULLBACK_ZONE_MISSING"
  | "REGIME_NOT_PULLBACK_IN_UPTREND"
  | "TREND_ALIGNMENT_BELOW_4"
  | "RECOVERY_QUALITY_BELOW_3"
  | "ONE_HOUR_LOCATION_NOT_LOWER_OR_MIDDLE"
  | "VOLUME_RECOVERY_MISSING"
  | "MOMENTUM_RECOVERY_MISSING"
  | "FAILED_RECLAIM_THESIS"
  | "BEARISH_LOSS_THESIS"
  | "POSITION_AT_LOSS"
  | "EPISODE_ADD_LIMIT_REACHED"
  | "ATR_SHOCK"
  | "REGIME_NOT_CORE_TREND"
  | "NON_POSITIVE_EXIT_12H_COOLDOWN"
  | "SAME_ENTRY_PATH_24H_COOLDOWN";

export interface PositionGuardBacktestResearchIntervention {
  readonly scenario: PositionGuardBacktestInterventionPolicyId;
  readonly generatedAt: string;
  readonly originalAction: StrategyDecisionAction;
  readonly effectiveAction: StrategyDecisionAction;
  readonly outcome: "ALLOW" | "SUPPRESS" | "OVERRIDE_EXIT";
  readonly reason: PositionGuardBacktestResearchInterventionReason;
  readonly evidence: Readonly<{
    analysis: Readonly<Pick<
      PositionGuardStructureAnalysis,
      | "regime"
      | "entryPath"
      | "pullbackZone"
      | "breakdown1d"
      | "breakdown4h"
      | "trendAlignmentScore"
      | "recoveryQualityScore"
      | "breakdownPressureScore"
      | "weakeningStage"
      | "failedReclaim"
      | "bearishMomentumExpansion"
      | "volumeRecovery"
      | "macdImproving"
      | "rsiRecovery"
      | "atrShock"
      | "currentPrice"
      | "averageEntryPrice"
      | "pnlPct"
    >> & {
      readonly oneHourLocation: PositionGuardStructureAnalysis["oneHourLocation"];
    };
    researchState: Readonly<PositionGuardBacktestResearchState>;
  }>;
}

export interface PositionGuardBacktestState {
  cashKrw: number;
  quantity: number;
  averageEntryPrice: number;
}

export type PositionGuardBacktestSkipReason =
  | "BELOW_MINIMUM_TRADE_VALUE"
  | "INSUFFICIENT_CASH"
  | "NO_POSITION";

export interface PositionGuardBacktestTrade {
  action: Extract<StrategyDecisionAction, "ENTER" | "ADD" | "REDUCE" | "EXIT">;
  side: "bid" | "ask";
  price: number;
  quantity: number;
  grossNotionalKrw: number;
  feeKrw: number;
  realizedPnlKrw: number;
}

export interface PositionGuardBacktestFrameResult {
  generatedAt: string;
  regime: StrategyMarketRegime;
  source?: PositionGuardBacktestFrame["source"];
  decision: PositionGuardEngineDecision;
  startingState: PositionGuardBacktestState;
  endingState: PositionGuardBacktestState;
  executed: boolean;
  trade: PositionGuardBacktestTrade | null;
  skipReason: PositionGuardBacktestSkipReason | null;
  equityKrw: number;
  drawdownPct: number;
  researchSuppression?: PositionGuardBacktestResearchSuppression | null;
  researchPolicyEvaluation?: PositionGuardBacktestConditionalAddPolicyEvaluation | null;
  researchIntervention?: PositionGuardBacktestResearchIntervention | null;
  modeledExecution?: PositionGuardBacktestModeledExecutionEvidence;
  modeledTradeOrigin?: PositionGuardBacktestModeledTradeOriginEvidence;
}

export type PositionGuardBacktestModeledExecutionEvidence = Readonly<{
  timingModel: PositionGuardBacktestExecutionTimingModel;
  decisionGeneratedAt: string;
  status: "PENDING_NEXT_FRAME" | "EXECUTED_NEXT_FRAME" | "SKIPPED_NEXT_FRAME" | "SKIPPED_NO_NEXT_FRAME";
  executedAt: string | null;
  executionPrice: number | null;
  reason: PositionGuardBacktestSkipReason | "NO_NEXT_FRAME" | null;
}>;

export type PositionGuardBacktestModeledTradeOriginEvidence = Readonly<{
  timingModel: "NEXT_FRAME_MODELED";
  decisionGeneratedAt: string;
  decisionFrameIndex: number;
  executedAt: string;
  executionFrameIndex: number;
  originalAction: StrategyDecisionAction;
  effectiveAction: Extract<StrategyDecisionAction, "ENTER" | "ADD" | "REDUCE" | "EXIT">;
  scenario: PositionGuardBacktestInterventionPolicyId | null;
  intervention: Readonly<Pick<PositionGuardBacktestResearchIntervention, "outcome" | "reason">> | null;
}>;

export interface PositionGuardBacktestMetrics {
  actionCounts: Record<StrategyDecisionAction, number>;
  regimeCounts: Record<StrategyMarketRegime, number>;
  tradeCount: number;
  skippedOrderCount: number;
  turnoverKrw: number;
  feesKrw: number;
  realizedPnlKrw: number;
  finalEquityKrw: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  timeInMarketFrames: number;
}

export interface PositionGuardBacktestResult {
  frames: PositionGuardBacktestFrameResult[];
  metrics: PositionGuardBacktestMetrics;
  finalState: PositionGuardBacktestState;
  finalResearchState?: PositionGuardBacktestResearchState;
}

const DEFAULT_BACKTEST_EXECUTION: PositionGuardBacktestExecutionModel = {
  feeRate: 0.0005,
  slippageRate: 0,
  minimumTradeValueKrw: DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS.minimumTradeValueKrw,
};

type PositionGuardBacktestDecisionExecutionResult = {
  state: PositionGuardBacktestState;
  trade: PositionGuardBacktestTrade | null;
  skipReason: PositionGuardBacktestSkipReason | null;
};

type PendingModeledDecision = {
  decision: PositionGuardEngineDecision;
  originalGeneratedAt: string;
  sourceResultIndex: number;
  entryPath: StrategyEntryPath;
  originalAction: StrategyDecisionAction;
  effectiveAction: Extract<StrategyDecisionAction, "ENTER" | "ADD" | "REDUCE" | "EXIT">;
  scenario: PositionGuardBacktestInterventionPolicyId | null;
  intervention: Readonly<Pick<PositionGuardBacktestResearchIntervention, "outcome" | "reason">> | null;
};

export function runPositionGuardBacktest(input: PositionGuardBacktestInput): PositionGuardBacktestResult {
  const settings = input.settings ?? DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS;
  const execution = input.execution ?? DEFAULT_BACKTEST_EXECUTION;
  const researchExecutionPolicy = validateResearchExecutionPolicy(input.researchExecutionPolicy);
  const executionTimingModel = input.executionTimingModel ?? "SAME_CLOSE_MODELED";
  validateExecutionTimingModel(executionTimingModel);
  let state: PositionGuardBacktestState = {
    cashKrw: input.initialCashKrw,
    quantity: input.initialQuantity,
    averageEntryPrice: input.initialAverageEntryPrice,
  };
  let researchState = initializeResearchState(input, researchExecutionPolicy);
  let pendingDecision: PendingModeledDecision | null = null;
  let latestDecision: PreviousPositionGuardDecision | null = null;
  const initialEquity = getInitialEquity(input, state);
  let peakEquity = initialEquity;
  const metrics: PositionGuardBacktestMetrics = {
    actionCounts: createActionCounts(),
    regimeCounts: createRegimeCounts(),
    tradeCount: 0,
    skippedOrderCount: 0,
    turnoverKrw: 0,
    feesKrw: 0,
    realizedPnlKrw: 0,
    finalEquityKrw: initialEquity,
    totalReturnPct: 0,
    maxDrawdownPct: 0,
    timeInMarketFrames: 0,
  };
  const results: PositionGuardBacktestFrameResult[] = [];

  for (const [frameIndex, frame] of input.frames.entries()) {
    validateConditionalAddAnalysis(researchExecutionPolicy, frame.analysis);
    let carriedExecution: PositionGuardBacktestDecisionExecutionResult | null = null;
    let modeledTradeOrigin: PositionGuardBacktestModeledTradeOriginEvidence | undefined;
    if (executionTimingModel === "NEXT_FRAME_MODELED" && pendingDecision) {
      const executionDecision = {
        ...pendingDecision.decision,
        referencePrice: frame.analysis.currentPrice,
      };
      carriedExecution = applyDecision({
        decision: executionDecision,
        state,
        execution,
        minimumTradeValueKrw: Math.max(execution.minimumTradeValueKrw, settings.minimumTradeValueKrw),
      });
      state = carriedExecution.state;
      researchState = advanceResearchState({
        researchState,
        executionResult: carriedExecution,
        decision: executionDecision,
        entryPath: pendingDecision.entryPath,
        executedAt: frame.generatedAt,
      });
      const sourceResult = results[pendingDecision.sourceResultIndex];
      if (sourceResult) {
        sourceResult.modeledExecution = Object.freeze({
          timingModel: executionTimingModel,
          decisionGeneratedAt: pendingDecision.originalGeneratedAt,
          status: carriedExecution.trade ? "EXECUTED_NEXT_FRAME" : "SKIPPED_NEXT_FRAME",
          executedAt: frame.generatedAt,
          executionPrice: frame.analysis.currentPrice,
          reason: carriedExecution.skipReason,
        });
      }
      if (carriedExecution.trade) {
        modeledTradeOrigin = Object.freeze({
          timingModel: "NEXT_FRAME_MODELED",
          decisionGeneratedAt: pendingDecision.originalGeneratedAt,
          decisionFrameIndex: pendingDecision.sourceResultIndex,
          executedAt: frame.generatedAt,
          executionFrameIndex: frameIndex,
          originalAction: pendingDecision.originalAction,
          effectiveAction: pendingDecision.effectiveAction,
          scenario: pendingDecision.scenario,
          intervention: pendingDecision.intervention,
        });
      }
      pendingDecision = null;
    }
    const startingState = cloneState(state);
    const context = buildContext({
      input,
      frame,
      state,
      settings,
      latestDecision,
    });
    const decision = decidePositionGuardCore(context);
    const researchIntervention = isInterventionResearchPolicy(researchExecutionPolicy)
      ? evaluatePositionGuardResearchIntervention({
          policyId: researchExecutionPolicy.id,
          generatedAt: frame.generatedAt,
          decision,
          state,
          researchState,
          analysis: context.analysis,
        })
      : null;
    const researchPolicyEvaluation = getConditionalAddPolicyEvaluation(
      researchExecutionPolicy,
      decision.action,
      frame,
    );
    const researchSuppression = getResearchSuppression(
      researchExecutionPolicy,
      decision.action,
      frame,
      researchPolicyEvaluation,
    );
    const effectiveDecision = toEffectiveDecision(decision, researchIntervention);
    const interventionSuppressed = researchIntervention?.outcome === "SUPPRESS";
    let executionResult: PositionGuardBacktestDecisionExecutionResult;
    let modeledExecution: PositionGuardBacktestModeledExecutionEvidence | undefined;
    if (executionTimingModel === "NEXT_FRAME_MODELED") {
      executionResult = carriedExecution ?? { state: cloneState(state), trade: null, skipReason: null };
      if (!researchSuppression && !interventionSuppressed && isExecutableDecision(effectiveDecision)) {
        pendingDecision = {
          decision: effectiveDecision,
          originalGeneratedAt: frame.generatedAt,
          sourceResultIndex: results.length,
          entryPath: context.analysis.entryPath,
          originalAction: decision.action,
          effectiveAction: effectiveDecision.action,
          scenario: researchIntervention?.scenario ?? null,
          intervention: researchIntervention
            ? Object.freeze({
                outcome: researchIntervention.outcome,
                reason: researchIntervention.reason,
              })
            : null,
        };
        modeledExecution = Object.freeze({
          timingModel: executionTimingModel,
          decisionGeneratedAt: frame.generatedAt,
          status: "PENDING_NEXT_FRAME",
          executedAt: null,
          executionPrice: null,
          reason: null,
        });
      }
    } else {
      executionResult = researchSuppression || interventionSuppressed
        ? { state: cloneState(state), trade: null, skipReason: null }
        : applyDecision({
            decision: effectiveDecision,
            state,
            execution,
            minimumTradeValueKrw: Math.max(execution.minimumTradeValueKrw, settings.minimumTradeValueKrw),
          });
      state = executionResult.state;
      researchState = advanceResearchState({
        researchState,
        executionResult,
        decision: effectiveDecision,
        entryPath: context.analysis.entryPath,
        executedAt: frame.generatedAt,
      });
    }
    const equity = getEquity(state, frame.analysis.currentPrice);
    peakEquity = Math.max(peakEquity, equity);
    const drawdownPct = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;

    metrics.actionCounts[decision.action] += 1;
    metrics.regimeCounts[frame.analysis.regime] += 1;
    metrics.finalEquityKrw = equity;
    metrics.maxDrawdownPct = Math.max(metrics.maxDrawdownPct, drawdownPct);
    if (state.quantity > 0) {
      metrics.timeInMarketFrames += 1;
    }
    if (executionResult.trade) {
      metrics.tradeCount += 1;
      metrics.turnoverKrw += executionResult.trade.grossNotionalKrw;
      metrics.feesKrw += executionResult.trade.feeKrw;
      metrics.realizedPnlKrw += executionResult.trade.realizedPnlKrw;
    } else if (executionResult.skipReason) {
      metrics.skippedOrderCount += 1;
    }

    results.push({
      generatedAt: frame.generatedAt,
      regime: frame.analysis.regime,
      source: frame.source,
      decision,
      startingState,
      endingState: cloneState(state),
      executed: executionResult.trade !== null,
      trade: executionResult.trade,
      skipReason: executionResult.skipReason,
      equityKrw: roundMoney(equity),
      drawdownPct,
      ...(researchExecutionPolicy ? { researchSuppression } : {}),
      ...(researchExecutionPolicy && researchExecutionPolicy.id !== "NO_ADD"
        ? { researchPolicyEvaluation }
        : {}),
      ...(isInterventionResearchPolicy(researchExecutionPolicy) ? { researchIntervention } : {}),
      ...(modeledExecution ? { modeledExecution } : {}),
      ...(modeledTradeOrigin ? { modeledTradeOrigin } : {}),
    });

    latestDecision = {
      action: decision.action,
      executionDisposition: decision.executionDisposition,
      entryPath: decision.diagnostics.entryPath,
      qualityBucket: decision.signalQuality.bucket,
      createdAt: frame.generatedAt,
    };
  }

  if (pendingDecision) {
    const sourceResult = results[pendingDecision.sourceResultIndex];
    if (sourceResult) {
      sourceResult.modeledExecution = Object.freeze({
        timingModel: "NEXT_FRAME_MODELED",
        decisionGeneratedAt: pendingDecision.originalGeneratedAt,
        status: "SKIPPED_NO_NEXT_FRAME",
        executedAt: null,
        executionPrice: null,
        reason: "NO_NEXT_FRAME",
      });
    }
  }

  metrics.finalEquityKrw = roundMoney(metrics.finalEquityKrw);
  metrics.totalReturnPct = initialEquity > 0 ? (metrics.finalEquityKrw - initialEquity) / initialEquity : 0;
  metrics.turnoverKrw = roundMoney(metrics.turnoverKrw);
  metrics.feesKrw = roundMoney(metrics.feesKrw);
  metrics.realizedPnlKrw = roundMoney(metrics.realizedPnlKrw);

  return {
    frames: results,
    metrics,
    finalState: cloneState(state),
    ...(isInterventionResearchPolicy(researchExecutionPolicy)
      ? { finalResearchState: cloneResearchState(researchState) }
      : {}),
  };
}

function validateResearchExecutionPolicy(
  policy: PositionGuardBacktestResearchExecutionPolicy | undefined,
): PositionGuardBacktestResearchExecutionPolicy | undefined {
  if (!policy) return undefined;

  switch (policy.id) {
    case "NO_ADD":
      if (policy.suppressedActions.length !== 1 || policy.suppressedActions[0] !== "ADD") {
        throw new Error("NO_ADD research execution policy may only suppress ADD.");
      }
      return policy;
    case "ADD_RISK_CLEAR":
    case "ADD_HIGH_ALIGNMENT":
    case "ADD_CORE_TREND":
    case "HTF_TREND_GATE":
    case "STRICT_PULLBACK":
    case "EARLY_THESIS_FAILURE":
    case "ADD_LIMITED":
    case "COOLDOWN_CONTROL":
    case "COMBINED_CONSERVATIVE":
    case "COMBINED_MINUS_HTF_TREND_GATE":
    case "COMBINED_MINUS_EARLY_THESIS_FAILURE":
    case "COMBINED_MINUS_ADD_LIMITED":
    case "COMBINED_MINUS_COOLDOWN_CONTROL":
      if ("suppressedActions" in policy) {
        throw new Error(`${policy.id} research execution policy must not define suppressedActions.`);
      }
      return policy;
    default:
      throw new Error(`Invalid research execution policy ${String((policy as { id?: unknown }).id)}.`);
  }
}

export function evaluatePositionGuardResearchIntervention(input: {
  policyId: PositionGuardBacktestInterventionPolicyId;
  generatedAt: string;
  decision: PositionGuardEngineDecision;
  state: PositionGuardBacktestState;
  researchState: PositionGuardBacktestResearchState;
  analysis: PositionGuardStructureAnalysis;
}): PositionGuardBacktestResearchIntervention | null {
  const { decision } = input;
  if (
    (input.policyId === "EARLY_THESIS_FAILURE" || isCombinedPolicy(input.policyId)) &&
    (decision.action === "EXIT" || decision.action === "REDUCE")
  ) {
    return createResearchIntervention(input, "ALLOW", decision.action, "RISK_REDUCING_DECISION_PRESERVED");
  }

  if (isComponentActive(input.policyId, "EARLY_THESIS_FAILURE")) {
    const earlyFailureReason = getEarlyThesisFailureReason(input);
    if (earlyFailureReason) {
      return createResearchIntervention(input, "OVERRIDE_EXIT", "EXIT", earlyFailureReason);
    }
    if (input.policyId === "EARLY_THESIS_FAILURE") {
      return decision.action === "HOLD" || decision.action === "ADD"
        ? createResearchIntervention(input, "ALLOW", decision.action, "CONDITIONS_MET")
        : null;
    }
  }

  if (isComponentActive(input.policyId, "COOLDOWN_CONTROL")) {
    const cooldownReason = getCooldownReason(input);
    if (cooldownReason) {
      return createResearchIntervention(input, "SUPPRESS", "HOLD", cooldownReason);
    }
    if (input.policyId === "COOLDOWN_CONTROL") {
      return decision.action === "ENTER"
        ? createResearchIntervention(input, "ALLOW", "ENTER", "CONDITIONS_MET")
        : null;
    }
  }

  if (isComponentActive(input.policyId, "HTF_TREND_GATE")) {
    const htfReason = getHtfTrendGateReason(input);
    if (htfReason) {
      return createResearchIntervention(input, "SUPPRESS", "HOLD", htfReason);
    }
    if (input.policyId === "HTF_TREND_GATE") {
      return decision.action === "ENTER"
        ? createResearchIntervention(input, "ALLOW", "ENTER", "CONDITIONS_MET")
        : null;
    }
  }

  if (input.policyId === "STRICT_PULLBACK") {
    if (decision.action !== "ENTER") return null;
    const reason = getStrictPullbackReason(input.analysis);
    return reason
      ? createResearchIntervention(input, "SUPPRESS", "HOLD", reason)
      : createResearchIntervention(input, "ALLOW", "ENTER", "CONDITIONS_MET");
  }

  if (isComponentActive(input.policyId, "ADD_LIMITED")) {
    const addReason = getAddLimitedReason(input);
    if (addReason) {
      return createResearchIntervention(input, "SUPPRESS", "HOLD", addReason);
    }
    if (decision.action === "ADD") {
      return createResearchIntervention(input, "ALLOW", "ADD", "CONDITIONS_MET");
    }
  }

  return null;
}

function isComponentActive(
  policyId: PositionGuardBacktestInterventionPolicyId,
  component: CombinedConservativeComponent,
): boolean {
  if (policyId === component) return true;
  if (policyId === "COMBINED_CONSERVATIVE") {
    return COMBINED_CONSERVATIVE_COMPONENTS.includes(component);
  }
  if (!isAblationPolicy(policyId)) return false;
  const activeComponents: readonly CombinedConservativeComponent[] =
    COMBINED_CONSERVATIVE_ABLATION_RESEARCH_AUTHORITY.scenarios[policyId].activeComponents;
  return activeComponents.includes(component);
}

function isCombinedPolicy(
  policyId: PositionGuardBacktestInterventionPolicyId,
): policyId is "COMBINED_CONSERVATIVE" | PositionGuardBacktestAblationResearchPolicyId {
  return policyId === "COMBINED_CONSERVATIVE" || isAblationPolicy(policyId);
}

function isAblationPolicy(
  policyId: PositionGuardBacktestInterventionPolicyId,
): policyId is PositionGuardBacktestAblationResearchPolicyId {
  return (COMBINED_CONSERVATIVE_ABLATION_RESEARCH_AUTHORITY.scenarioOrder as readonly string[])
    .includes(policyId);
}

function getHtfTrendGateReason(
  input: Parameters<typeof evaluatePositionGuardResearchIntervention>[0],
): PositionGuardBacktestResearchInterventionReason | null {
  if (input.decision.action !== "ENTER") return null;
  const { analysis } = input;
  const policy = POSITION_GUARD_RESEARCH_POLICY_MANIFEST.scenarios.HTF_TREND_GATE;
  if (analysis.breakdown1d || analysis.breakdown4h) return "HTF_BREAKDOWN";
  if (analysis.trendAlignmentScore < policy.minimumTrendAlignmentScore) {
    return "TREND_ALIGNMENT_BELOW_3";
  }
  if (analysis.weakeningStage !== "NONE") return "WEAKENING_PRESENT";
  if (!policy.allowedRegimes.includes(analysis.regime as typeof policy.allowedRegimes[number])) {
    return "REGIME_NOT_ENTRY_TREND";
  }
  return null;
}

function getStrictPullbackReason(
  analysis: PositionGuardStructureAnalysis,
): PositionGuardBacktestResearchInterventionReason | null {
  const policy = POSITION_GUARD_RESEARCH_POLICY_MANIFEST.scenarios.STRICT_PULLBACK;
  if (analysis.entryPath !== policy.requiredEntryPath) return "ENTRY_PATH_NOT_PULLBACK";
  if (!analysis.pullbackZone) return "PULLBACK_ZONE_MISSING";
  if (analysis.regime !== policy.requiredRegime) return "REGIME_NOT_PULLBACK_IN_UPTREND";
  if (analysis.breakdown1d || analysis.breakdown4h) return "HTF_BREAKDOWN";
  if (analysis.trendAlignmentScore < policy.minimumTrendAlignmentScore) return "TREND_ALIGNMENT_BELOW_4";
  if (analysis.recoveryQualityScore < policy.minimumRecoveryQualityScore) return "RECOVERY_QUALITY_BELOW_3";
  if (!policy.allowedOneHourLocations.includes(
    analysis.oneHourLocation as typeof policy.allowedOneHourLocations[number],
  )) {
    return "ONE_HOUR_LOCATION_NOT_LOWER_OR_MIDDLE";
  }
  if (!analysis.volumeRecovery) return "VOLUME_RECOVERY_MISSING";
  if (!analysis.macdImproving && !analysis.rsiRecovery) return "MOMENTUM_RECOVERY_MISSING";
  return null;
}

function getEarlyThesisFailureReason(
  input: Parameters<typeof evaluatePositionGuardResearchIntervention>[0],
): PositionGuardBacktestResearchInterventionReason | null {
  if (input.state.quantity <= POSITION_GUARD_RESEARCH_POLICY_MANIFEST.quantityTolerance) return null;
  if (input.decision.action !== "HOLD" && input.decision.action !== "ADD") return null;
  const { analysis } = input;
  const policy = POSITION_GUARD_RESEARCH_POLICY_MANIFEST.scenarios.EARLY_THESIS_FAILURE;
  if (
    analysis.failedReclaim &&
    (analysis.weakeningStage === "CLEAR" || analysis.weakeningStage === "FAILURE") &&
    analysis.recoveryQualityScore <= policy.maximumFailedReclaimRecoveryQualityScore
  ) {
    return "FAILED_RECLAIM_THESIS";
  }
  if (
    analysis.breakdownPressureScore >= policy.minimumBearishBreakdownPressureScore &&
    analysis.bearishMomentumExpansion &&
    analysis.pnlPct < 0
  ) {
    return "BEARISH_LOSS_THESIS";
  }
  return null;
}

function getAddLimitedReason(
  input: Parameters<typeof evaluatePositionGuardResearchIntervention>[0],
): PositionGuardBacktestResearchInterventionReason | null {
  if (input.decision.action !== "ADD") return null;
  const { analysis, researchState, state } = input;
  const policy = POSITION_GUARD_RESEARCH_POLICY_MANIFEST.scenarios.ADD_LIMITED;
  if (analysis.currentPrice < state.averageEntryPrice) return "POSITION_AT_LOSS";
  if (
    researchState.currentEpisodeAddCount >=
      policy.maxAddsPerEpisode
  ) {
    return "EPISODE_ADD_LIMIT_REACHED";
  }
  if (analysis.atrShock) return "ATR_SHOCK";
  if (analysis.weakeningStage !== "NONE") return "WEAKENING_PRESENT";
  if (analysis.trendAlignmentScore < policy.minimumTrendAlignmentScore) return "TREND_ALIGNMENT_BELOW_4";
  if (analysis.recoveryQualityScore < policy.minimumRecoveryQualityScore) return "RECOVERY_QUALITY_BELOW_3";
  if (!policy.allowedRegimes.includes(analysis.regime as typeof policy.allowedRegimes[number])) {
    return "REGIME_NOT_CORE_TREND";
  }
  return null;
}

function getCooldownReason(
  input: Parameters<typeof evaluatePositionGuardResearchIntervention>[0],
): PositionGuardBacktestResearchInterventionReason | null {
  if (input.decision.action !== "ENTER") return null;
  const { lastFullExitAt, lastFullExitRealizedPnlKrw, lastEntryPath } = input.researchState;
  if (lastFullExitAt === null) return null;
  const elapsedNanoseconds = parseExactTimestamp(input.generatedAt) - parseExactTimestamp(lastFullExitAt);
  if (elapsedNanoseconds < 0n) {
    throw new Error("Research cooldown generatedAt must not precede lastFullExitAt.");
  }
  if (
    lastFullExitRealizedPnlKrw !== null &&
    lastFullExitRealizedPnlKrw <= 0 &&
    elapsedNanoseconds < hoursToNanoseconds(
      POSITION_GUARD_RESEARCH_POLICY_MANIFEST.scenarios.COOLDOWN_CONTROL.nonPositiveExitHours,
    )
  ) {
    return "NON_POSITIVE_EXIT_12H_COOLDOWN";
  }
  if (
    lastEntryPath === input.analysis.entryPath &&
    elapsedNanoseconds < hoursToNanoseconds(
      POSITION_GUARD_RESEARCH_POLICY_MANIFEST.scenarios.COOLDOWN_CONTROL.sameEntryPathHours,
    )
  ) {
    return "SAME_ENTRY_PATH_24H_COOLDOWN";
  }
  return null;
}

function createResearchIntervention(
  input: Parameters<typeof evaluatePositionGuardResearchIntervention>[0],
  outcome: PositionGuardBacktestResearchIntervention["outcome"],
  effectiveAction: StrategyDecisionAction,
  reason: PositionGuardBacktestResearchInterventionReason,
): PositionGuardBacktestResearchIntervention {
  const analysis = Object.freeze({
    regime: input.analysis.regime,
    entryPath: input.analysis.entryPath,
    pullbackZone: input.analysis.pullbackZone,
    breakdown1d: input.analysis.breakdown1d,
    breakdown4h: input.analysis.breakdown4h,
    trendAlignmentScore: input.analysis.trendAlignmentScore,
    recoveryQualityScore: input.analysis.recoveryQualityScore,
    breakdownPressureScore: input.analysis.breakdownPressureScore,
    weakeningStage: input.analysis.weakeningStage,
    failedReclaim: input.analysis.failedReclaim,
    bearishMomentumExpansion: input.analysis.bearishMomentumExpansion,
    volumeRecovery: input.analysis.volumeRecovery,
    macdImproving: input.analysis.macdImproving,
    rsiRecovery: input.analysis.rsiRecovery,
    atrShock: input.analysis.atrShock,
    oneHourLocation: input.analysis.oneHourLocation,
    currentPrice: input.analysis.currentPrice,
    averageEntryPrice: input.analysis.averageEntryPrice,
    pnlPct: input.analysis.pnlPct,
  });
  return Object.freeze({
    scenario: input.policyId,
    generatedAt: input.generatedAt,
    originalAction: input.decision.action,
    effectiveAction,
    outcome,
    reason,
    evidence: Object.freeze({
      analysis,
      researchState: Object.freeze(cloneResearchState(input.researchState)),
    }),
  });
}

function toEffectiveDecision(
  decision: PositionGuardEngineDecision,
  intervention: PositionGuardBacktestResearchIntervention | null,
): PositionGuardEngineDecision {
  if (!intervention || intervention.outcome === "ALLOW") return decision;
  if (intervention.outcome === "OVERRIDE_EXIT") {
    return {
      ...decision,
      action: "EXIT",
      targetNotionalKrw: 0,
      targetQuantityFraction: 1,
      executionDisposition: "IMMEDIATE",
    };
  }
  return {
    ...decision,
    action: "HOLD",
    targetNotionalKrw: 0,
    targetQuantityFraction: null,
    executionDisposition: "SKIPPED",
  };
}

function getResearchSuppression(
  policy: PositionGuardBacktestResearchExecutionPolicy | undefined,
  action: StrategyDecisionAction,
  frame: PositionGuardBacktestFrame,
  conditionalEvaluation: PositionGuardBacktestConditionalAddPolicyEvaluation | null,
): PositionGuardBacktestResearchSuppression | null {
  if (!policy || action !== "ADD") return null;
  if (policy.id === "NO_ADD") {
    return {
      policyId: policy.id,
      originalAction: action,
      reason: "ACTION_SUPPRESSED",
    };
  }

  if (!isConditionalAddPolicy(policy)) return null;

  if (conditionalEvaluation?.outcome !== "SUPPRESS") return null;

  return {
    policyId: policy.id,
    originalAction: action,
    reason: conditionalEvaluation.reason,
    generatedAt: conditionalEvaluation.generatedAt,
    analysisSnapshot: conditionalEvaluation.analysisSnapshot,
  };
}

function getConditionalAddPolicyEvaluation(
  policy: PositionGuardBacktestResearchExecutionPolicy | undefined,
  action: StrategyDecisionAction,
  frame: PositionGuardBacktestFrame,
): PositionGuardBacktestConditionalAddPolicyEvaluation | null {
  if (!isConditionalAddPolicy(policy) || action !== "ADD") return null;

  const reason = getConditionalAddSuppressionReason(policy.id, frame.analysis);
  const evidence = {
    policyId: policy.id,
    originalAction: action,
    generatedAt: frame.generatedAt,
    analysisSnapshot: {
      atrShock: frame.analysis.atrShock,
      weakeningStage: frame.analysis.weakeningStage,
      trendAlignmentScore: frame.analysis.trendAlignmentScore,
      regime: frame.analysis.regime,
    },
  } as const;
  if (reason === null) {
    return { ...evidence, outcome: "ALLOW", reason: "CONDITIONS_MET" };
  }
  return {
    ...evidence,
    outcome: "SUPPRESS",
    reason,
  };
}

function validateConditionalAddAnalysis(
  policy: PositionGuardBacktestResearchExecutionPolicy | undefined,
  analysis: PositionGuardStructureAnalysis,
): void {
  if (!isConditionalAddPolicy(policy)) return;
  if (!Number.isFinite(analysis.trendAlignmentScore)) {
    throw new Error("Invalid conditional ADD analysis trendAlignmentScore: expected a finite number.");
  }
  if (typeof analysis.atrShock !== "boolean") {
    throw new Error("Invalid conditional ADD analysis atrShock: expected a boolean.");
  }
  if (
    analysis.weakeningStage !== "NONE" &&
    analysis.weakeningStage !== "SOFT" &&
    analysis.weakeningStage !== "CLEAR" &&
    analysis.weakeningStage !== "FAILURE"
  ) {
    throw new Error("Invalid conditional ADD analysis weakeningStage.");
  }
  if (
    analysis.regime !== "BULL_TREND" &&
    analysis.regime !== "PULLBACK_IN_UPTREND" &&
    analysis.regime !== "EARLY_RECOVERY" &&
    analysis.regime !== "RECLAIM_ATTEMPT" &&
    analysis.regime !== "RANGE" &&
    analysis.regime !== "WEAK_DOWNTREND" &&
    analysis.regime !== "BREAKDOWN_RISK"
  ) {
    throw new Error("Invalid conditional ADD analysis regime.");
  }
}

function isConditionalAddPolicy(
  policy: PositionGuardBacktestResearchExecutionPolicy | undefined,
): policy is PositionGuardBacktestResearchExecutionPolicy<PositionGuardBacktestConditionalAddPolicyId> {
  return policy?.id === "ADD_RISK_CLEAR" ||
    policy?.id === "ADD_HIGH_ALIGNMENT" ||
    policy?.id === "ADD_CORE_TREND";
}

function isInterventionResearchPolicy(
  policy: PositionGuardBacktestResearchExecutionPolicy | undefined,
): policy is PositionGuardBacktestResearchExecutionPolicy<PositionGuardBacktestInterventionPolicyId> {
  return policy?.id === "HTF_TREND_GATE" ||
    policy?.id === "STRICT_PULLBACK" ||
    policy?.id === "EARLY_THESIS_FAILURE" ||
    policy?.id === "ADD_LIMITED" ||
    policy?.id === "COOLDOWN_CONTROL" ||
    policy?.id === "COMBINED_CONSERVATIVE" ||
    policy?.id === "COMBINED_MINUS_HTF_TREND_GATE" ||
    policy?.id === "COMBINED_MINUS_EARLY_THESIS_FAILURE" ||
    policy?.id === "COMBINED_MINUS_ADD_LIMITED" ||
    policy?.id === "COMBINED_MINUS_COOLDOWN_CONTROL";
}

function getConditionalAddSuppressionReason(
  policyId: PositionGuardBacktestConditionalAddPolicyId,
  analysis: PositionGuardStructureAnalysis,
): PositionGuardBacktestConditionalAddSuppression["reason"] | null {
  if (analysis.atrShock) return "ATR_SHOCK";
  if (analysis.weakeningStage !== "NONE") return "WEAKENING_PRESENT";
  if (policyId === "ADD_RISK_CLEAR") return null;
  if (analysis.trendAlignmentScore < 4) return "TREND_ALIGNMENT_BELOW_4";
  if (policyId === "ADD_HIGH_ALIGNMENT") return null;
  if (analysis.regime !== "BULL_TREND" && analysis.regime !== "PULLBACK_IN_UPTREND") {
    return "REGIME_NOT_CORE_TREND";
  }
  return null;
}

function initializeResearchState(
  input: PositionGuardBacktestInput,
  policy: PositionGuardBacktestResearchExecutionPolicy | undefined,
): PositionGuardBacktestResearchState {
  const stateful = isInterventionResearchPolicy(policy) && (
    isComponentActive(policy.id, "ADD_LIMITED") ||
    isComponentActive(policy.id, "COOLDOWN_CONTROL")
  );
  if (
    stateful &&
    input.initialQuantity > POSITION_GUARD_RESEARCH_POLICY_MANIFEST.quantityTolerance &&
    !input.researchCarryInState
  ) {
    throw new Error(`${policy.id} requires explicit carry-in research state when initial quantity is non-zero.`);
  }
  const state = input.researchCarryInState ?? {
    currentEpisodeAddCount: 0,
    currentEpisodeRealizedPnlKrw: 0,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
  };
  validateResearchState(state);
  return cloneResearchState(state);
}

function validateResearchState(state: PositionGuardBacktestResearchState): void {
  if (!Number.isInteger(state.currentEpisodeAddCount) || state.currentEpisodeAddCount < 0) {
    throw new Error("Research state currentEpisodeAddCount must be a non-negative integer.");
  }
  if (!Number.isFinite(state.currentEpisodeRealizedPnlKrw)) {
    throw new Error("Research state currentEpisodeRealizedPnlKrw must be finite.");
  }
  if (state.lastFullExitAt !== null) parseExactTimestamp(state.lastFullExitAt);
  if (
    state.lastFullExitRealizedPnlKrw !== null &&
    !Number.isFinite(state.lastFullExitRealizedPnlKrw)
  ) {
    throw new Error("Research state lastFullExitRealizedPnlKrw must be finite or null.");
  }
  if (
    state.lastEntryPath !== null &&
    state.lastEntryPath !== "PULLBACK" &&
    state.lastEntryPath !== "RECLAIM" &&
    state.lastEntryPath !== "BREAKOUT_HOLD" &&
    state.lastEntryPath !== "NONE"
  ) {
    throw new Error("Research state lastEntryPath is invalid.");
  }
}

function advanceResearchState(input: {
  researchState: PositionGuardBacktestResearchState;
  executionResult: PositionGuardBacktestDecisionExecutionResult;
  decision: PositionGuardEngineDecision;
  entryPath: StrategyEntryPath;
  executedAt: string;
}): PositionGuardBacktestResearchState {
  const next = cloneResearchState(input.researchState);
  const trade = input.executionResult.trade;
  if (!trade) return next;
  if (trade.action === "ENTER") {
    next.lastEntryPath = input.entryPath;
  } else if (trade.action === "ADD") {
    next.currentEpisodeAddCount += 1;
  }
  if (trade.action === "REDUCE" || trade.action === "EXIT") {
    next.currentEpisodeRealizedPnlKrw = roundMoney(
      next.currentEpisodeRealizedPnlKrw + trade.realizedPnlKrw,
    );
  }
  if (
    trade.action === "EXIT" &&
    input.executionResult.state.quantity <= POSITION_GUARD_RESEARCH_POLICY_MANIFEST.quantityTolerance
  ) {
    next.currentEpisodeAddCount = 0;
    next.lastFullExitAt = input.executedAt;
    next.lastFullExitRealizedPnlKrw = next.currentEpisodeRealizedPnlKrw;
    next.currentEpisodeRealizedPnlKrw = 0;
  }
  return next;
}

function cloneResearchState(state: PositionGuardBacktestResearchState): PositionGuardBacktestResearchState {
  return {
    currentEpisodeAddCount: state.currentEpisodeAddCount,
    currentEpisodeRealizedPnlKrw: state.currentEpisodeRealizedPnlKrw,
    lastFullExitAt: state.lastFullExitAt,
    lastFullExitRealizedPnlKrw: state.lastFullExitRealizedPnlKrw,
    lastEntryPath: state.lastEntryPath,
  };
}

function validateExecutionTimingModel(model: PositionGuardBacktestExecutionTimingModel): void {
  if (model !== "SAME_CLOSE_MODELED" && model !== "NEXT_FRAME_MODELED") {
    throw new Error(`Invalid backtest execution timing model ${String(model)}.`);
  }
}

function isExecutableDecision(
  decision: PositionGuardEngineDecision,
): decision is PositionGuardEngineDecision & {
  action: Extract<StrategyDecisionAction, "ENTER" | "ADD" | "REDUCE" | "EXIT">;
} {
  return decision.executionDisposition !== "DEFERRED_CONFIRMATION" &&
    (decision.action === "ENTER" ||
      decision.action === "ADD" ||
      decision.action === "REDUCE" ||
      decision.action === "EXIT");
}

function parseExactTimestamp(value: string): bigint {
  try {
    return performanceTimestampEpochNanoseconds(value);
  } catch {
    throw new Error(`Invalid research timestamp ${value}.`);
  }
}

function hoursToNanoseconds(hours: number): bigint {
  return BigInt(hours) * 3_600_000_000_000n;
}

function buildContext(input: {
  input: PositionGuardBacktestInput;
  frame: PositionGuardBacktestFrame;
  state: PositionGuardBacktestState;
  settings: PositionGuardStrategySettings;
  latestDecision: PreviousPositionGuardDecision | null;
}): PositionGuardStrategyContext {
  const { frame, state } = input;
  const currentPrice = frame.analysis.currentPrice;
  const assetMarketValueKrw = state.quantity * currentPrice;
  const totalEquityKrw = state.cashKrw + assetMarketValueKrw;
  const averageEntryPrice = state.quantity > 0 ? state.averageEntryPrice : 0;
  const analysis: PositionGuardStructureAnalysis = {
    ...frame.analysis,
    averageEntryPrice,
    pnlPct: averageEntryPrice > 0 ? (currentPrice - averageEntryPrice) / averageEntryPrice : 0,
  };

  return {
    asset: input.input.asset,
    market: input.input.market,
    generatedAt: frame.generatedAt,
    availableKrw: state.cashKrw,
    positionQuantity: state.quantity,
    averageEntryPrice,
    portfolio: {
      totalEquityKrw,
      assetMarketValueKrw,
      totalExposureKrw: assetMarketValueKrw,
    },
    latestDecision: input.latestDecision,
    recentExit: {
      createdAt: null,
      hoursSinceExit: null,
      realizedPnl: null,
    },
    settings: input.settings,
    analysis,
  };
}

function applyDecision(input: {
  decision: PositionGuardEngineDecision;
  state: PositionGuardBacktestState;
  execution: PositionGuardBacktestExecutionModel;
  minimumTradeValueKrw: number;
}): {
  state: PositionGuardBacktestState;
  trade: PositionGuardBacktestTrade | null;
  skipReason: PositionGuardBacktestSkipReason | null;
} {
  if (input.decision.executionDisposition === "DEFERRED_CONFIRMATION") {
    return {
      state: cloneState(input.state),
      trade: null,
      skipReason: null,
    };
  }

  switch (input.decision.action) {
    case "ENTER":
    case "ADD":
      return applyBuy(input);
    case "REDUCE":
    case "EXIT":
      return applySell(input);
    case "HOLD":
    default:
      return {
        state: cloneState(input.state),
        trade: null,
        skipReason: null,
      };
  }
}

function applyBuy(input: {
  decision: PositionGuardEngineDecision;
  state: PositionGuardBacktestState;
  execution: PositionGuardBacktestExecutionModel;
  minimumTradeValueKrw: number;
}): {
  state: PositionGuardBacktestState;
  trade: PositionGuardBacktestTrade | null;
  skipReason: PositionGuardBacktestSkipReason | null;
} {
  const targetNotional = Math.max(0, input.decision.targetNotionalKrw);
  if (targetNotional < input.minimumTradeValueKrw) {
    return { state: cloneState(input.state), trade: null, skipReason: "BELOW_MINIMUM_TRADE_VALUE" };
  }

  const grossNotional = Math.min(targetNotional, input.state.cashKrw / (1 + input.execution.feeRate));
  if (grossNotional < input.minimumTradeValueKrw) {
    return { state: cloneState(input.state), trade: null, skipReason: "INSUFFICIENT_CASH" };
  }

  const price = input.decision.referencePrice * (1 + input.execution.slippageRate);
  const quantity = grossNotional / price;
  const feeKrw = grossNotional * input.execution.feeRate;
  const previousCost = input.state.averageEntryPrice * input.state.quantity;
  const nextQuantity = input.state.quantity + quantity;
  const nextAverageEntryPrice = nextQuantity > 0 ? (previousCost + grossNotional) / nextQuantity : 0;
  const action = input.decision.action === "ADD" ? "ADD" : "ENTER";
  const nextState = {
    cashKrw: roundMoney(input.state.cashKrw - grossNotional - feeKrw),
    quantity: roundQuantity(nextQuantity),
    averageEntryPrice: roundMoney(nextAverageEntryPrice),
  };

  return {
    state: nextState,
    trade: {
      action,
      side: "bid",
      price: roundMoney(price),
      quantity: roundQuantity(quantity),
      grossNotionalKrw: roundMoney(grossNotional),
      feeKrw: roundMoney(feeKrw),
      realizedPnlKrw: 0,
    },
    skipReason: null,
  };
}

function applySell(input: {
  decision: PositionGuardEngineDecision;
  state: PositionGuardBacktestState;
  execution: PositionGuardBacktestExecutionModel;
  minimumTradeValueKrw: number;
}): {
  state: PositionGuardBacktestState;
  trade: PositionGuardBacktestTrade | null;
  skipReason: PositionGuardBacktestSkipReason | null;
} {
  if (input.state.quantity <= 0) {
    return { state: cloneState(input.state), trade: null, skipReason: "NO_POSITION" };
  }

  const requestedFraction = input.decision.targetQuantityFraction ?? 0;
  const quantity = input.decision.action === "EXIT"
    ? input.state.quantity
    : input.state.quantity * requestedFraction;
  const sellQuantity = Math.min(input.state.quantity, Math.max(0, quantity));
  const price = input.decision.referencePrice * (1 - input.execution.slippageRate);
  const grossNotional = sellQuantity * price;
  if (grossNotional < input.minimumTradeValueKrw) {
    return { state: cloneState(input.state), trade: null, skipReason: "BELOW_MINIMUM_TRADE_VALUE" };
  }

  const feeKrw = grossNotional * input.execution.feeRate;
  const proceeds = grossNotional - feeKrw;
  const costBasis = sellQuantity * input.state.averageEntryPrice;
  const nextQuantity = Math.max(0, input.state.quantity - sellQuantity);
  const action = input.decision.action === "EXIT" ? "EXIT" : "REDUCE";
  const nextState = {
    cashKrw: roundMoney(input.state.cashKrw + proceeds),
    quantity: roundQuantity(nextQuantity),
    averageEntryPrice: nextQuantity > 0 ? input.state.averageEntryPrice : 0,
  };

  return {
    state: nextState,
    trade: {
      action,
      side: "ask",
      price: roundMoney(price),
      quantity: roundQuantity(sellQuantity),
      grossNotionalKrw: roundMoney(grossNotional),
      feeKrw: roundMoney(feeKrw),
      realizedPnlKrw: roundMoney(proceeds - costBasis),
    },
    skipReason: null,
  };
}

function getInitialEquity(input: PositionGuardBacktestInput, state: PositionGuardBacktestState): number {
  const firstFramePrice = input.frames[0]?.analysis.currentPrice;
  const markPrice = firstFramePrice ?? state.averageEntryPrice;
  return getEquity(state, markPrice);
}

function getEquity(state: PositionGuardBacktestState, currentPrice: number): number {
  return state.cashKrw + state.quantity * currentPrice;
}

function cloneState(state: PositionGuardBacktestState): PositionGuardBacktestState {
  return {
    cashKrw: roundMoney(state.cashKrw),
    quantity: roundQuantity(state.quantity),
    averageEntryPrice: roundMoney(state.averageEntryPrice),
  };
}

function createActionCounts(): Record<StrategyDecisionAction, number> {
  return {
    ENTER: 0,
    ADD: 0,
    REDUCE: 0,
    EXIT: 0,
    HOLD: 0,
  };
}

function createRegimeCounts(): Record<StrategyMarketRegime, number> {
  return {
    BULL_TREND: 0,
    PULLBACK_IN_UPTREND: 0,
    EARLY_RECOVERY: 0,
    RECLAIM_ATTEMPT: 0,
    RANGE: 0,
    WEAK_DOWNTREND: 0,
    BREAKDOWN_RISK: 0,
  };
}

function roundMoney(value: number): number {
  return Number(value.toFixed(6));
}

function roundQuantity(value: number): number {
  return Number(value.toFixed(12));
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
