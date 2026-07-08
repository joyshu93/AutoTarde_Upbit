import type {
  StrategyDecision,
  StrategyDecisionAction,
  SupportedAsset,
  SupportedMarket,
} from "../../domain/types.js";

export type StrategyMarketRegime =
  | "BULL_TREND"
  | "PULLBACK_IN_UPTREND"
  | "EARLY_RECOVERY"
  | "RECLAIM_ATTEMPT"
  | "RANGE"
  | "WEAK_DOWNTREND"
  | "BREAKDOWN_RISK";
export type StrategyRiskLevel = "LOW" | "MODERATE" | "ELEVATED" | "HIGH";
export type StrategyInvalidationState = "CLEAR" | "UNCLEAR" | "BROKEN";
export type StrategyEntryPath = "PULLBACK" | "RECLAIM" | "BREAKOUT_HOLD" | "NONE";
export type StrategyWeakeningStage = "NONE" | "SOFT" | "CLEAR" | "FAILURE";
export type StrategySignalQualityBucket = "HIGH" | "MEDIUM" | "BORDERLINE" | "LOW";
export type StrategyExecutionDisposition =
  | "IMMEDIATE"
  | "DEFERRED_CONFIRMATION"
  | "EXECUTED_AFTER_CONFIRMATION"
  | "SKIPPED";

export interface PositionGuardStrategySettings {
  minimumTradeValueKrw: number;
  entryAllocation: number;
  addAllocation: number;
  reduceFraction: number;
  perAssetMaxAllocation: number;
  strongTrendPerAssetMaxAllocation: number;
  totalPortfolioMaxExposure: number;
}

export interface PositionGuardStructureAnalysis {
  regime: StrategyMarketRegime;
  riskLevel: StrategyRiskLevel;
  invalidationState: StrategyInvalidationState;
  invalidationLevel: number | null;
  pullbackZone: boolean;
  reclaimStructure: boolean;
  breakoutHoldStructure: boolean;
  upperRangeChase: boolean;
  currentPrice: number;
  entryPath: StrategyEntryPath;
  trendAlignmentScore: number;
  recoveryQualityScore: number;
  breakdownPressureScore: number;
  weakeningStage: StrategyWeakeningStage;
  breakdown1d: boolean;
  breakdown4h: boolean;
  failedReclaim: boolean;
  bearishMomentumExpansion: boolean;
  volumeRecovery: boolean;
  macdImproving: boolean;
  rsiRecovery: boolean;
  atrShock: boolean;
  averageEntryPrice: number;
  pnlPct: number;
  oneHourLocation?: "LOWER" | "MIDDLE" | "UPPER";
  fourHourLocation?: "LOWER" | "MIDDLE" | "UPPER";
}

export interface PreviousPositionGuardDecision {
  action: StrategyDecisionAction;
  executionDisposition: StrategyExecutionDisposition;
  entryPath: StrategyEntryPath;
  qualityBucket: StrategySignalQualityBucket;
  createdAt: string;
}

export interface RecentExitContext {
  createdAt: string | null;
  hoursSinceExit: number | null;
  realizedPnl: number | null;
}

export interface PositionGuardStrategyContext {
  asset: SupportedAsset;
  market: SupportedMarket;
  generatedAt: string;
  availableKrw: number;
  positionQuantity: number;
  averageEntryPrice: number;
  portfolio: {
    totalEquityKrw: number;
    assetMarketValueKrw: number;
    totalExposureKrw: number;
  };
  latestDecision: PreviousPositionGuardDecision | null;
  recentExit: RecentExitContext;
  settings: PositionGuardStrategySettings;
  analysis: PositionGuardStructureAnalysis;
}

export interface PositionGuardEngineDecision {
  action: StrategyDecisionAction;
  summary: string;
  reasons: string[];
  targetNotionalKrw: number;
  targetQuantityFraction: number | null;
  referencePrice: number;
  executionDisposition: StrategyExecutionDisposition;
  signalQuality: {
    score: number;
    bucket: StrategySignalQualityBucket;
    confirmationRequired: boolean;
    confirmationSatisfied: boolean;
    reentryPenaltyApplied: boolean;
  };
  exposureGuardrails: {
    perAssetMaxAllocation: number;
    totalPortfolioMaxExposure: number;
    remainingAssetCapacity: number;
    remainingPortfolioCapacity: number;
  };
  diagnostics: {
    regime: StrategyMarketRegime;
    riskLevel: StrategyRiskLevel;
    invalidationState: StrategyInvalidationState;
    invalidationLevel: number | null;
    entryPath: StrategyEntryPath;
    trendAlignmentScore: number;
    recoveryQualityScore: number;
    breakdownPressureScore: number;
    weakeningStage: StrategyWeakeningStage;
    upperRangeChase: boolean;
    pullbackZone: boolean;
    reclaimStructure: boolean;
    breakoutHoldStructure: boolean;
  };
}

export const POSITION_GUARD_STRATEGY_KEY = "position_guard.paper_core.v1";

export const DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS: PositionGuardStrategySettings = {
  minimumTradeValueKrw: 5_000,
  entryAllocation: 0.30,
  addAllocation: 0.18,
  reduceFraction: 0.33,
  perAssetMaxAllocation: 0.45,
  strongTrendPerAssetMaxAllocation: 0.60,
  totalPortfolioMaxExposure: 0.75,
};

const ENTRY_STRONG_THRESHOLD = 8;
const ENTRY_BORDERLINE_THRESHOLD = 6;
const ADD_STRONG_THRESHOLD = 8;
const ADD_BORDERLINE_THRESHOLD = 6;
const REDUCE_THRESHOLD = 4;
const HEALTHY_HOLD_REDUCE_THRESHOLD = 5;
const RECENT_EXIT_PENALTY_HOURS = 24;
const RECENT_LOSS_EXIT_PENALTY_HOURS = 12;
const HOURLY_CONFIRMATION_WINDOW_MS = 60 * 60 * 1000;

export class PositionGuardCoreStrategy {
  decide(context: PositionGuardStrategyContext): StrategyDecision {
    return toStrategyDecision(context, decidePositionGuardCore(context));
  }
}

export function decidePositionGuardCore(context: PositionGuardStrategyContext): PositionGuardEngineDecision {
  const analysis = context.analysis;
  const quantity = context.positionQuantity;
  const bullishScore = computeBullishScore(analysis) - getReentryPenalty(context);
  const reentryPenaltyApplied = computeBullishScore(analysis) !== bullishScore;
  const qualityBucket = toQualityBucket(bullishScore);
  const exposureGuardrails = buildExposureGuardrails(context);
  const diagnostics = buildDiagnostics(analysis);

  if (quantity <= 0) {
    if (isImmediateExitRequired(analysis)) {
      return flatNoPositionExitHoldDecision(context, reentryPenaltyApplied, exposureGuardrails);
    }

    return decideFlatPositionAction(context, bullishScore, qualityBucket, reentryPenaltyApplied, exposureGuardrails);
  }

  if (isImmediateExitRequired(analysis)) {
    return {
      action: "EXIT",
      summary: `${context.asset} exit is required because invalidation has failed.`,
      reasons: [
        `Regime is ${analysis.regime}.`,
        "Higher-timeframe support has broken or invalidation is already broken.",
        "Invalidation-first exit remains immediate and unchanged.",
      ],
      targetNotionalKrw: 0,
      targetQuantityFraction: 1,
      referencePrice: analysis.currentPrice,
      executionDisposition: "IMMEDIATE",
      signalQuality: {
        score: 0,
        bucket: "LOW",
        confirmationRequired: false,
        confirmationSatisfied: false,
        reentryPenaltyApplied,
      },
      exposureGuardrails,
      diagnostics,
    };
  }

  const reduceDecision = decideReduceAction(context, exposureGuardrails, reentryPenaltyApplied);
  if (reduceDecision) {
    return reduceDecision;
  }

  return decideAddOrHoldAction(context, bullishScore, qualityBucket, reentryPenaltyApplied, exposureGuardrails);
}

function isImmediateExitRequired(analysis: PositionGuardStructureAnalysis): boolean {
  return analysis.invalidationState === "BROKEN" ||
    analysis.breakdown1d ||
    (analysis.breakdown4h && analysis.bearishMomentumExpansion);
}

export function toStrategyDecision(
  context: PositionGuardStrategyContext,
  decision: PositionGuardEngineDecision,
): StrategyDecision {
  const requestedQuantity = decision.targetQuantityFraction === null
    ? null
    : roundQuantity(context.positionQuantity * decision.targetQuantityFraction);

  return {
    strategyKey: POSITION_GUARD_STRATEGY_KEY,
    market: context.market,
    action: decision.action,
    reasonCodes: [
      decision.action.toLowerCase(),
      decision.executionDisposition.toLowerCase(),
      decision.diagnostics.entryPath.toLowerCase(),
      decision.signalQuality.bucket.toLowerCase(),
    ],
    referencePrice: decision.referencePrice,
    requestedNotionalKrw:
      decision.action === "ENTER" || decision.action === "ADD"
        ? roundMoney(decision.targetNotionalKrw)
        : null,
    requestedQuantity:
      decision.action === "REDUCE" || decision.action === "EXIT"
        ? requestedQuantity
        : null,
    metadata: {
      summary: decision.summary,
      reasonsJson: JSON.stringify(decision.reasons),
      executionDisposition: decision.executionDisposition,
      signalQualityBucket: decision.signalQuality.bucket,
      signalQualityScore: decision.signalQuality.score,
      confirmationRequired: decision.signalQuality.confirmationRequired,
      confirmationSatisfied: decision.signalQuality.confirmationSatisfied,
      reentryPenaltyApplied: decision.signalQuality.reentryPenaltyApplied,
      diagnosticsJson: JSON.stringify(decision.diagnostics),
      exposureGuardrailsJson: JSON.stringify(decision.exposureGuardrails),
      sourceEngine: "PositionGuard_PaperTrade",
    },
  };
}

function decideFlatPositionAction(
  context: PositionGuardStrategyContext,
  bullishScore: number,
  qualityBucket: StrategySignalQualityBucket,
  reentryPenaltyApplied: boolean,
  exposureGuardrails: PositionGuardEngineDecision["exposureGuardrails"],
): PositionGuardEngineDecision {
  const analysis = context.analysis;
  const thresholds = getBullishThresholds("ENTER", analysis);

  if (!isConstructiveBullishCandidate(analysis)) {
    return holdDecision(
      context,
      [
        `Regime is ${analysis.regime}.`,
        analysis.upperRangeChase
          ? "Price is too extended for a no-chase entry."
          : "Bullish structure is not strong enough to justify a fresh entry.",
      ],
      bullishScore,
      qualityBucket,
      reentryPenaltyApplied,
      exposureGuardrails,
    );
  }

  if (!hasBullishRiskCapacity(context, exposureGuardrails)) {
    return holdDecision(
      context,
      [`Regime is ${analysis.regime}.`, "Exposure guardrails leave no room for additional risk right now."],
      bullishScore,
      qualityBucket,
      reentryPenaltyApplied,
      exposureGuardrails,
    );
  }

  if (bullishScore >= thresholds.strong) {
    return bullishDecision(context, "ENTER", "IMMEDIATE", qualityBucket, bullishScore, reentryPenaltyApplied, false, exposureGuardrails);
  }

  if (bullishScore >= thresholds.borderline) {
    const confirmationSatisfied = hasPendingBullishConfirmation(context, "ENTER", analysis.entryPath, qualityBucket);
    return bullishDecision(
      context,
      "ENTER",
      confirmationSatisfied ? "EXECUTED_AFTER_CONFIRMATION" : "DEFERRED_CONFIRMATION",
      qualityBucket,
      bullishScore,
      reentryPenaltyApplied,
      confirmationSatisfied,
      exposureGuardrails,
    );
  }

  return holdDecision(
    context,
    [
      `Regime is ${analysis.regime}.`,
      reentryPenaltyApplied
        ? "Recent exit caution slightly raised the entry threshold and the recovery quality is not strong enough yet."
        : "Bullish score did not clear the entry hysteresis threshold.",
    ],
    bullishScore,
    qualityBucket,
    reentryPenaltyApplied,
    exposureGuardrails,
  );
}

function decideAddOrHoldAction(
  context: PositionGuardStrategyContext,
  bullishScore: number,
  qualityBucket: StrategySignalQualityBucket,
  reentryPenaltyApplied: boolean,
  exposureGuardrails: PositionGuardEngineDecision["exposureGuardrails"],
): PositionGuardEngineDecision {
  const analysis = context.analysis;
  const thresholds = getBullishThresholds("ADD", analysis);

  if (!isConstructiveAddCandidate(analysis)) {
    return holdDecision(
      context,
      [
        `Regime is ${analysis.regime}.`,
        analysis.weakeningStage === "SOFT"
          ? "Existing position is still valid, but mild weakening means add quality is not strong enough yet."
          : "Existing position remains valid, but add quality needs stronger trend alignment and recovery structure.",
      ],
      bullishScore,
      qualityBucket,
      reentryPenaltyApplied,
      exposureGuardrails,
    );
  }

  if (!hasBullishRiskCapacity(context, exposureGuardrails)) {
    return holdDecision(
      context,
      [`Regime is ${analysis.regime}.`, "Exposure guardrails leave no room for an additional add."],
      bullishScore,
      qualityBucket,
      reentryPenaltyApplied,
      exposureGuardrails,
    );
  }

  if (bullishScore >= thresholds.strong) {
    return bullishDecision(context, "ADD", "IMMEDIATE", qualityBucket, bullishScore, reentryPenaltyApplied, false, exposureGuardrails);
  }

  if (bullishScore >= thresholds.borderline) {
    const confirmationSatisfied = hasPendingBullishConfirmation(context, "ADD", analysis.entryPath, qualityBucket);
    return bullishDecision(
      context,
      "ADD",
      confirmationSatisfied ? "EXECUTED_AFTER_CONFIRMATION" : "DEFERRED_CONFIRMATION",
      qualityBucket,
      bullishScore,
      reentryPenaltyApplied,
      confirmationSatisfied,
      exposureGuardrails,
    );
  }

  return holdDecision(
    context,
    [`Regime is ${analysis.regime}.`, "Existing hold remains valid, but add quality did not clear the stricter add threshold."],
    bullishScore,
    qualityBucket,
    reentryPenaltyApplied,
    exposureGuardrails,
  );
}

function decideReduceAction(
  context: PositionGuardStrategyContext,
  exposureGuardrails: PositionGuardEngineDecision["exposureGuardrails"],
  reentryPenaltyApplied: boolean,
): PositionGuardEngineDecision | null {
  const analysis = context.analysis;
  const weaknessScore = computeWeaknessScore(analysis);
  const reducePlan = getStructuredReducePlan(context, weaknessScore);
  if (!reducePlan) {
    return null;
  }

  return {
    action: "REDUCE",
    summary: `${context.asset} reduction is allowed because weakening is now sufficiently clear.`,
    reasons: [
      `Regime is ${analysis.regime}.`,
      `Weakening stage is ${analysis.weakeningStage}.`,
      ...reducePlan.reasons,
    ],
    targetNotionalKrw: 0,
    targetQuantityFraction: reducePlan.reduceFraction,
    referencePrice: analysis.currentPrice,
    executionDisposition: "IMMEDIATE",
    signalQuality: {
      score: weaknessScore,
      bucket: reducePlan.qualityBucket,
      confirmationRequired: false,
      confirmationSatisfied: false,
      reentryPenaltyApplied,
    },
    exposureGuardrails,
    diagnostics: buildDiagnostics(analysis),
  };
}

function bullishDecision(
  context: PositionGuardStrategyContext,
  action: "ENTER" | "ADD",
  executionDisposition: StrategyExecutionDisposition,
  qualityBucket: StrategySignalQualityBucket,
  bullishScore: number,
  reentryPenaltyApplied: boolean,
  confirmationSatisfied: boolean,
  exposureGuardrails: PositionGuardEngineDecision["exposureGuardrails"],
): PositionGuardEngineDecision {
  const analysis = context.analysis;
  const budgetBase = Math.max(context.portfolio.totalEquityKrw, context.availableKrw);
  const baseNotional = budgetBase * (action === "ENTER" ? context.settings.entryAllocation : context.settings.addAllocation);
  const targetNotionalKrw = Math.max(
    0,
    Math.min(
      baseNotional * getBullishAllocationMultiplier(action, analysis, executionDisposition),
      context.availableKrw,
      exposureGuardrails.remainingAssetCapacity,
      exposureGuardrails.remainingPortfolioCapacity,
    ),
  );

  return {
    action,
    summary:
      executionDisposition === "DEFERRED_CONFIRMATION"
        ? `${context.asset} ${action.toLowerCase()} setup is deferred pending one additional hourly confirmation.`
        : `${context.asset} ${action.toLowerCase()} is allowed by constructive structure.`,
    reasons: [
      `Regime is ${analysis.regime}.`,
      executionDisposition === "DEFERRED_CONFIRMATION"
        ? "Bullish structure is valid but borderline, so one additional hourly confirmation is required."
        : "Constructive structure is strong enough to act.",
      getEntryPathReason(analysis.entryPath),
    ],
    targetNotionalKrw,
    targetQuantityFraction: null,
    referencePrice: analysis.currentPrice,
    executionDisposition,
    signalQuality: {
      score: bullishScore,
      bucket: qualityBucket,
      confirmationRequired: executionDisposition === "DEFERRED_CONFIRMATION" || confirmationSatisfied,
      confirmationSatisfied,
      reentryPenaltyApplied,
    },
    exposureGuardrails,
    diagnostics: buildDiagnostics(analysis),
  };
}

function holdDecision(
  context: PositionGuardStrategyContext,
  reasons: string[],
  score: number,
  qualityBucket: StrategySignalQualityBucket,
  reentryPenaltyApplied: boolean,
  exposureGuardrails: PositionGuardEngineDecision["exposureGuardrails"],
): PositionGuardEngineDecision {
  return {
    action: "HOLD",
    summary:
      context.positionQuantity > 0
        ? `${context.asset} stays on hold while the existing position remains valid.`
        : `${context.asset} stays on hold because entry quality is not strong enough yet.`,
    reasons,
    targetNotionalKrw: 0,
    targetQuantityFraction: null,
    referencePrice: context.analysis.currentPrice,
    executionDisposition: "SKIPPED",
    signalQuality: {
      score,
      bucket: qualityBucket,
      confirmationRequired: false,
      confirmationSatisfied: false,
      reentryPenaltyApplied,
    },
    exposureGuardrails,
    diagnostics: buildDiagnostics(context.analysis),
  };
}

function flatNoPositionExitHoldDecision(
  context: PositionGuardStrategyContext,
  reentryPenaltyApplied: boolean,
  exposureGuardrails: PositionGuardEngineDecision["exposureGuardrails"],
): PositionGuardEngineDecision {
  return {
    action: "HOLD",
    summary: `No position is open for ${context.asset}, so the strategy holds flat instead of emitting an exit.`,
    reasons: [
      `Regime is ${context.analysis.regime}.`,
      "No position is open, so bearish exit evidence is treated as flat-state risk avoidance rather than a sell order.",
      "Higher-timeframe support has broken or invalidation is already broken.",
    ],
    targetNotionalKrw: 0,
    targetQuantityFraction: null,
    referencePrice: context.analysis.currentPrice,
    executionDisposition: "SKIPPED",
    signalQuality: {
      score: 0,
      bucket: "LOW",
      confirmationRequired: false,
      confirmationSatisfied: false,
      reentryPenaltyApplied,
    },
    exposureGuardrails,
    diagnostics: buildDiagnostics(context.analysis),
  };
}

function buildExposureGuardrails(context: PositionGuardStrategyContext): PositionGuardEngineDecision["exposureGuardrails"] {
  const totalEquity = Math.max(context.portfolio.totalEquityKrw, context.availableKrw);
  const perAssetMaxAllocation = getEffectivePerAssetMaxAllocation(context.settings, context.analysis);
  const perAssetLimitValue = totalEquity * perAssetMaxAllocation;
  const totalExposureLimitValue = totalEquity * context.settings.totalPortfolioMaxExposure;

  return {
    perAssetMaxAllocation,
    totalPortfolioMaxExposure: context.settings.totalPortfolioMaxExposure,
    remainingAssetCapacity: Math.max(0, perAssetLimitValue - context.portfolio.assetMarketValueKrw),
    remainingPortfolioCapacity: Math.max(0, totalExposureLimitValue - context.portfolio.totalExposureKrw),
  };
}

function buildDiagnostics(analysis: PositionGuardStructureAnalysis): PositionGuardEngineDecision["diagnostics"] {
  return {
    regime: analysis.regime,
    riskLevel: analysis.riskLevel,
    invalidationState: analysis.invalidationState,
    invalidationLevel: analysis.invalidationLevel,
    entryPath: analysis.entryPath,
    trendAlignmentScore: analysis.trendAlignmentScore,
    recoveryQualityScore: analysis.recoveryQualityScore,
    breakdownPressureScore: analysis.breakdownPressureScore,
    weakeningStage: analysis.weakeningStage,
    upperRangeChase: analysis.upperRangeChase,
    pullbackZone: analysis.pullbackZone,
    reclaimStructure: analysis.reclaimStructure,
    breakoutHoldStructure: analysis.breakoutHoldStructure,
  };
}

function getEffectivePerAssetMaxAllocation(
  settings: PositionGuardStrategySettings,
  analysis: PositionGuardStructureAnalysis,
): number {
  if (
    analysis.invalidationState === "CLEAR" &&
    !analysis.upperRangeChase &&
    analysis.breakdownPressureScore <= 1 &&
    analysis.trendAlignmentScore >= 4 &&
    analysis.recoveryQualityScore >= 4 &&
    (analysis.regime === "BULL_TREND" || analysis.regime === "PULLBACK_IN_UPTREND" || analysis.entryPath === "RECLAIM")
  ) {
    return Math.max(settings.perAssetMaxAllocation, settings.strongTrendPerAssetMaxAllocation);
  }

  return settings.perAssetMaxAllocation;
}

function hasBullishRiskCapacity(
  context: PositionGuardStrategyContext,
  exposureGuardrails: PositionGuardEngineDecision["exposureGuardrails"],
): boolean {
  return context.availableKrw >= context.settings.minimumTradeValueKrw &&
    exposureGuardrails.remainingAssetCapacity >= context.settings.minimumTradeValueKrw &&
    exposureGuardrails.remainingPortfolioCapacity >= context.settings.minimumTradeValueKrw;
}

function hasPendingBullishConfirmation(
  context: PositionGuardStrategyContext,
  action: "ENTER" | "ADD",
  entryPath: StrategyEntryPath,
  qualityBucket: StrategySignalQualityBucket,
): boolean {
  const latestDecision = context.latestDecision;
  if (
    !latestDecision ||
    latestDecision.action !== action ||
    latestDecision.executionDisposition !== "DEFERRED_CONFIRMATION"
  ) {
    return false;
  }

  return latestDecision.entryPath === entryPath &&
    latestDecision.qualityBucket === qualityBucket &&
    isImmediatePreviousHourlyDecision(latestDecision.createdAt, context.generatedAt);
}

function isImmediatePreviousHourlyDecision(previousCreatedAt: string, currentGeneratedAt: string): boolean {
  const previousBucket = toHourlyBucketMs(previousCreatedAt);
  const currentBucket = toHourlyBucketMs(currentGeneratedAt);
  return previousBucket !== null && currentBucket !== null && currentBucket - previousBucket === HOURLY_CONFIRMATION_WINDOW_MS;
}

function toHourlyBucketMs(value: string): number | null {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const bucket = new Date(timestamp);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket.getTime();
}

function computeBullishScore(analysis: PositionGuardStructureAnalysis): number {
  let score = 0;

  if (analysis.regime === "BULL_TREND" || analysis.regime === "PULLBACK_IN_UPTREND") score += 3;
  else if (analysis.regime === "EARLY_RECOVERY") score += 2;
  else if (analysis.regime === "RECLAIM_ATTEMPT") score += 1;

  if (analysis.invalidationState === "CLEAR") score += 2;
  if (hasConstructivePullbackQuality(analysis)) score += 1;
  else if (analysis.pullbackZone) score -= 1;
  if (analysis.reclaimStructure) score += 2;
  if (analysis.breakoutHoldStructure) score += 2;
  if (analysis.volumeRecovery) score += 1;
  if (analysis.macdImproving) score += 1;
  if (analysis.rsiRecovery) score += 1;
  if (analysis.upperRangeChase) score -= 2;
  if (analysis.breakdown4h) score -= 3;
  if (analysis.breakdown1d) score -= 4;
  if (analysis.trendAlignmentScore >= 4) score += 1;
  if (analysis.recoveryQualityScore >= 4) score += 1;
  if (analysis.entryPath === "NONE") score -= 1;
  if (analysis.breakdownPressureScore >= 3) score -= 1;

  return score;
}

function computeWeaknessScore(analysis: PositionGuardStructureAnalysis): number {
  let score = 0;

  if (analysis.failedReclaim) score += 2;
  if (analysis.bearishMomentumExpansion) score += 2;
  if (analysis.breakdown4h) score += 2;
  if (analysis.regime === "WEAK_DOWNTREND") score += 1;
  if (analysis.atrShock) score += 1;
  if (analysis.upperRangeChase) score += 1;

  return score;
}

function getBullishThresholds(
  action: "ENTER" | "ADD",
  analysis: PositionGuardStructureAnalysis,
): { strong: number; borderline: number } {
  let strong = action === "ENTER" ? ENTRY_STRONG_THRESHOLD : ADD_STRONG_THRESHOLD;
  let borderline = action === "ENTER" ? ENTRY_BORDERLINE_THRESHOLD : ADD_BORDERLINE_THRESHOLD;

  if (analysis.entryPath === "RECLAIM" && analysis.recoveryQualityScore >= 3 && analysis.trendAlignmentScore >= 3) {
    strong -= 1;
    borderline -= 1;
  } else if (analysis.entryPath === "BREAKOUT_HOLD") {
    strong += 1;
    borderline += 1;
    if (analysis.oneHourLocation === "UPPER") {
      strong += 1;
      borderline += 1;
    }
  } else if (analysis.entryPath === "PULLBACK") {
    if (action === "ADD") {
      strong += 1;
      borderline += 1;
    }
    if (analysis.oneHourLocation !== "LOWER" && analysis.fourHourLocation !== "LOWER") {
      strong += 1;
      borderline += 1;
    }
  }

  if (analysis.breakdownPressureScore >= 2 && action === "ADD") {
    strong += 1;
    borderline += 1;
  }

  return { strong, borderline: Math.min(borderline, strong - 1) };
}

function isConstructiveBullishCandidate(analysis: PositionGuardStructureAnalysis): boolean {
  return analysis.invalidationState === "CLEAR" &&
    !analysis.upperRangeChase &&
    !analysis.breakdown1d &&
    !analysis.breakdown4h &&
    (hasConstructivePullbackQuality(analysis) || analysis.reclaimStructure || analysis.breakoutHoldStructure) &&
    (
      analysis.regime === "BULL_TREND" ||
      analysis.regime === "PULLBACK_IN_UPTREND" ||
      analysis.regime === "EARLY_RECOVERY" ||
      analysis.regime === "RECLAIM_ATTEMPT"
    );
}

function isConstructiveAddCandidate(analysis: PositionGuardStructureAnalysis): boolean {
  return isConstructiveBullishCandidate(analysis) &&
    isHealthyHoldState(analysis) &&
    analysis.breakdownPressureScore <= 1 &&
    analysis.trendAlignmentScore >= 3 &&
    (
      analysis.entryPath === "RECLAIM" ||
      analysis.entryPath === "BREAKOUT_HOLD" ||
      (analysis.entryPath === "PULLBACK" && analysis.recoveryQualityScore >= 2)
    );
}

function hasConstructivePullbackQuality(analysis: PositionGuardStructureAnalysis): boolean {
  return analysis.pullbackZone &&
    (
      analysis.oneHourLocation === "LOWER" ||
      analysis.fourHourLocation === "LOWER" ||
      (analysis.oneHourLocation === "MIDDLE" && analysis.volumeRecovery)
    );
}

function isHealthyHoldState(analysis: PositionGuardStructureAnalysis): boolean {
  return analysis.invalidationState === "CLEAR" &&
    !analysis.failedReclaim &&
    !analysis.bearishMomentumExpansion &&
    analysis.regime !== "WEAK_DOWNTREND";
}

function hasIndependentReduceEvidence(analysis: PositionGuardStructureAnalysis): boolean {
  return analysis.failedReclaim ||
    analysis.breakdown4h ||
    analysis.breakdownPressureScore >= 2 ||
    analysis.atrShock ||
    analysis.upperRangeChase ||
    analysis.regime === "WEAK_DOWNTREND" ||
    analysis.weakeningStage === "CLEAR" ||
    analysis.weakeningStage === "FAILURE";
}

function getStructuredReducePlan(
  context: PositionGuardStrategyContext,
  weaknessScore: number,
): {
  reduceFraction: number;
  qualityBucket: StrategySignalQualityBucket;
  reasons: string[];
} | null {
  const analysis = context.analysis;
  const hasProfitBuffer = analysis.pnlPct >= 0.02;
  const hasIndependentEvidence = hasIndependentReduceEvidence(analysis);

  if (analysis.weakeningStage === "SOFT") {
    if (!hasProfitBuffer || !hasIndependentEvidence) {
      return null;
    }

    return {
      reduceFraction: Math.min(0.35, Math.max(0.15, context.settings.reduceFraction * 0.5)),
      qualityBucket: "BORDERLINE",
      reasons: ["Weakening is still soft, so any reduction stays modest and mainly protects open gains."],
    };
  }

  if (analysis.weakeningStage === "NONE" && !hasIndependentEvidence) {
    return null;
  }

  const reduceThreshold = analysis.weakeningStage === "CLEAR"
    ? Math.max(3, (isHealthyHoldState(analysis) ? HEALTHY_HOLD_REDUCE_THRESHOLD : REDUCE_THRESHOLD) - 1)
    : isHealthyHoldState(analysis)
      ? HEALTHY_HOLD_REDUCE_THRESHOLD
      : REDUCE_THRESHOLD;

  if (weaknessScore < reduceThreshold) {
    return null;
  }

  return {
    reduceFraction: getGraduatedReduceFraction(weaknessScore, context.settings.reduceFraction),
    qualityBucket: weaknessScore >= 7 ? "HIGH" : weaknessScore >= 5 ? "MEDIUM" : "BORDERLINE",
    reasons: [
      analysis.weakeningStage === "CLEAR"
        ? "Weakening has become clear enough that a larger staged reduction is now justified."
        : "Weakening evidence cleared the reduce hysteresis threshold.",
    ],
  };
}

function getGraduatedReduceFraction(weaknessScore: number, base: number): number {
  if (weaknessScore >= 7) {
    return Math.min(0.9, base * 1.75);
  }
  if (weaknessScore >= 5) {
    return Math.min(0.75, base * 1.2);
  }
  return Math.max(0.2, base * 0.65);
}

function getBullishAllocationMultiplier(
  action: "ENTER" | "ADD",
  analysis: PositionGuardStructureAnalysis,
  executionDisposition: StrategyExecutionDisposition,
): number {
  let multiplier = action === "ENTER" ? 0.72 : 0.48;

  if (analysis.entryPath === "RECLAIM") multiplier += 0.16;
  else if (analysis.entryPath === "BREAKOUT_HOLD") multiplier += 0.12;
  else if (analysis.entryPath === "PULLBACK" && (analysis.oneHourLocation === "LOWER" || analysis.fourHourLocation === "LOWER")) {
    multiplier += 0.08;
  }

  if (analysis.trendAlignmentScore >= 4) multiplier += 0.08;
  else if (analysis.trendAlignmentScore <= 2) multiplier -= 0.05;

  if (analysis.recoveryQualityScore >= 4) multiplier += 0.08;
  else if (analysis.recoveryQualityScore <= 1) multiplier -= 0.08;

  if (executionDisposition === "EXECUTED_AFTER_CONFIRMATION") multiplier -= 0.08;
  if (executionDisposition === "DEFERRED_CONFIRMATION") multiplier -= 0.18;

  return Math.max(action === "ENTER" ? 0.35 : 0.25, Math.min(action === "ENTER" ? 1 : 0.9, multiplier));
}

function getReentryPenalty(context: PositionGuardStrategyContext): number {
  const analysis = context.analysis;
  if (
    context.positionQuantity > 0 ||
    context.recentExit.hoursSinceExit === null ||
    context.recentExit.hoursSinceExit > RECENT_EXIT_PENALTY_HOURS
  ) {
    return 0;
  }

  let penalty = 1;
  if (context.recentExit.hoursSinceExit <= RECENT_LOSS_EXIT_PENALTY_HOURS && (context.recentExit.realizedPnl ?? 0) <= 0) {
    penalty += 1;
  }

  if (analysis.reclaimStructure && analysis.recoveryQualityScore >= 3) {
    penalty -= 1;
  }

  return Math.max(0, penalty);
}

function getEntryPathReason(entryPath: StrategyEntryPath): string {
  switch (entryPath) {
    case "RECLAIM":
      return "Reclaim structure is intact.";
    case "BREAKOUT_HOLD":
      return "Breakout-hold structure is intact.";
    case "PULLBACK":
      return "Constructive pullback structure is available.";
    case "NONE":
    default:
      return "No constructive entry path is active.";
  }
}

function toQualityBucket(score: number): StrategySignalQualityBucket {
  if (score >= 8) return "HIGH";
  if (score >= 6) return "MEDIUM";
  if (score >= 4) return "BORDERLINE";
  return "LOW";
}

function roundMoney(value: number): number {
  return Number(value.toFixed(6));
}

function roundQuantity(value: number): number {
  return Number(value.toFixed(12));
}
