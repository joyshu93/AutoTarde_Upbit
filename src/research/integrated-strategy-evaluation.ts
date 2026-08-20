import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  getMarketForAsset,
  type ExecutionMode,
  type OrderOrigin,
  type SupportedAsset,
  type SupportedMarket,
} from "../domain/types.js";
import {
  calculatePerformance,
  type PerformanceCalculationResult,
} from "../modules/performance/performance-calculator.js";
import {
  buildObservedAttribution,
  classifySampleSupport,
  type ObservedAttributionResult,
  type SampleSupportStatus,
} from "../modules/performance/performance-attribution.js";
import {
  APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS,
  evaluateAddPolicyCandidate,
  type AddPolicyAffectedFrameRange,
  type AddPolicyCandidate,
  type AddPolicyCandidateEvaluationResult,
  type AddPolicyEvaluationObservation,
  type AddPolicyEvaluationWindow,
} from "../modules/performance/performance-add-policy-evaluation.js";
import {
  analyzePositionGuardFeatureCoverage,
  type CandleCoverageGap,
  type PositionGuardFeatureCoverage,
} from "../modules/performance/performance-candle-coverage.js";
import {
  analyzeAddDecisionExposures,
  type AddDecisionDiagnosticsResult,
} from "../modules/performance/performance-add-diagnostics.js";
import {
  analyzeAddPostDecisionExcursions,
  type AddPostDecisionExcursionResult,
} from "../modules/performance/performance-add-excursions.js";
import {
  analyzeAddLossAttribution,
  type AddLossAttributionResult,
  type AddPolicySuppressionEvidence,
} from "../modules/performance/performance-add-loss-attribution.js";
import {
  classifyAddHoldoutHypotheses,
  type AddHoldoutHypothesisResult,
} from "../modules/performance/performance-add-holdout-hypothesis.js";
import {
  diagnosePerformance,
  type PerformanceDiagnosticsResult,
} from "../modules/performance/performance-diagnostics.js";
import {
  createVerifiedNoTradeCoverageFromRanges,
  type VerifiedNoTradeCoverage,
} from "../modules/performance/performance-hourly-coverage.js";
import {
  analyzePerformanceExcursions,
  type PerformanceExcursionResult,
} from "../modules/performance/performance-excursions.js";
import {
  analyzePerformanceRegimes,
  type PerformanceRegimeAnalysisResult,
} from "../modules/performance/performance-regimes.js";
import {
  evaluateStrategyHypotheses,
  FROZEN_STRATEGY_HYPOTHESIS_MANIFEST,
  FROZEN_STRATEGY_HYPOTHESIS_SCENARIO_ORDER,
  type StrategyHypothesisCoverageObservation,
  type StrategyHypothesisEvaluationResult,
  type StrategyHypothesisMetricObservation,
  type StrategyHypothesisSupportObservation,
  type StrategyHypothesisTimingModel,
} from "../modules/performance/performance-strategy-hypothesis-evaluation.js";
import {
  evaluateCombinedConservativeHoldout,
  type CombinedConservativeHoldoutMatrixCell,
  type CombinedConservativeHoldoutResult,
} from "../modules/performance/performance-combined-conservative-holdout.js";
import {
  evaluatePerformanceComponentAblation,
  type PerformanceComponentAblationCell,
  type PerformanceComponentAblationMetrics,
  type PerformanceComponentAblationResult,
} from "../modules/performance/performance-component-ablation.js";
import {
  analyzeHoldoutEpisodeAttribution,
  type HoldoutEpisodePathProvenance,
} from "../modules/performance/performance-holdout-episode-attribution.js";
import {
  diagnoseCombinedConservativeHoldoutFailures,
  type HoldoutFailureDiagnosticsResult,
} from "../modules/performance/performance-holdout-failure-diagnostics.js";
import {
  runCostSensitivity,
  type CostScenario,
  type CostSensitivityCell,
} from "../modules/performance/performance-sensitivity.js";
import {
  validatePerformanceStability,
  type PerformanceStabilityResult,
  type StabilityScenarioPath,
  type StabilityValidationWindow,
} from "../modules/performance/performance-stability-validation.js";
import {
  readResearchCandleDataset,
  type ResearchCandleDataset,
  type ResearchDatasetProvenance,
} from "../modules/performance/research-candle-dataset.js";
import {
  classifyIndependentNoTradeCoverage,
  parseResearchNoTradeEvidence,
  type IndependentNoTradeCoverage,
  type ResearchNoTradeEvidence,
  type ResearchNoTradeRange,
} from "../modules/performance/research-no-trade-evidence.js";
import {
  runCounterfactualScenarios,
  type CounterfactualScenario,
  type CounterfactualScenarioResult,
} from "../modules/performance/strategy-counterfactual.js";
import {
  normalizeExplicitIsoTimestamp,
  readPerformanceInput,
  type PerformanceReadFilters,
  type PerformanceReadProvenance,
  type PerformanceReadResult,
} from "../modules/performance/sqlite-performance-reader.js";
import {
  compareEpochNanoseconds,
  comparePerformanceTimestamps,
  parsePerformanceTimestamp,
} from "../modules/performance/performance-timestamp.js";
import { PERFORMANCE_QUANTITY_TOLERANCE } from "../modules/performance/performance-trade-matcher.js";
import { buildPositionGuardBacktestFrames } from "../modules/strategy/position-guard-backtest-frames.js";
import type {
  PositionGuardBacktestFrameResult,
  PositionGuardBacktestMetrics,
  PositionGuardBacktestState,
} from "../modules/strategy/position-guard-backtest.js";
import { FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER } from
  "../modules/strategy/position-guard-research-manifest.js";

export type IntegratedEvaluationFormat = "text" | "json";

export type SimulationInitialState = {
  cashKrw: number;
  quantity: number;
  averageEntryPriceKrw: number;
};

export type SimulationAssetOptions = {
  datasetPath: string;
  noTradeEvidencePath?: string;
  initialState: SimulationInitialState;
};

export type IntegratedNoTradeEvidenceProvenance = {
  path: string;
  sha256: string;
  parentDatasetSha256: string;
  source: string;
  collectedAt: string;
  coverageStatus: IndependentNoTradeCoverage["status"];
  verifiedRangeCount: number;
  missingRangeCount: number;
  uncoveredRangeCount: number;
};

export type IntegratedSimulationOptions = {
  scenarios: readonly CounterfactualScenario[];
  minimumOrderValueKrw: number;
  costScenarios: readonly CostScenario[];
  assets: Partial<Record<SupportedAsset, SimulationAssetOptions>>;
};

export type IntegratedStabilityValidationOptions = {
  windows: readonly StabilityValidationWindow[];
  expectedFrameIntervalMs: number;
  comparisonTolerancePercentagePoints: number;
  minimumEvaluableWindows: number;
};

export type IntegratedStrategyEvaluationOptions = {
  observed: PerformanceReadFilters;
  format: IntegratedEvaluationFormat;
  simulation: IntegratedSimulationOptions | null;
  stabilityValidation: IntegratedStabilityValidationOptions | null;
  broadStrategyHypothesisProfile?: "BROAD_LOSS_CAUSE_V1";
  broadStrategyShadowHoldout?: {
    from: string;
    to: string;
  };
};

export type IntegratedDatasetProvenance = {
  asset: SupportedAsset;
  market: SupportedMarket;
  path: string;
  sha256: string;
  dataset: ResearchDatasetProvenance;
  initialState: SimulationInitialState;
  frameCount: number;
  featureCoverage?: PositionGuardFeatureCoverage;
  noTradeEvidence?: IntegratedNoTradeEvidenceProvenance;
};

export type IntegratedProvenance = {
  observed: PerformanceReadProvenance;
  datasets: readonly IntegratedDatasetProvenance[];
  scenarioAssumptions: {
    scenarios: readonly CounterfactualScenario[];
    baseCostScenario: CostScenario | null;
    minimumOrderValueKrw: number | null;
  };
  costCells: readonly CostScenario[];
  sampleSupportPolicy: {
    id: "OBSERVATION_COUNT_V1";
    insufficientBelow: 10;
    preliminaryBelow: 30;
    supportedFrom: 30;
    statisticalSignificanceClaim: false;
  };
  capitalSemantics: "INDEPENDENT_PER_ASSET_NOT_A_PORTFOLIO";
};

export type ObservedEvaluationSection = {
  status: "AVAILABLE";
  evidenceKind: "OBSERVED_LIVE_ATTRIBUTION";
  selectedExecutionMode: ExecutionMode;
  selectedOrigin: OrderOrigin;
  provenance: PerformanceReadProvenance;
  performance: PerformanceCalculationResult;
  diagnostics: PerformanceDiagnosticsResult;
  attribution: ObservedAttributionResult;
  disclaimer: "Selected order-stream attribution; not total account return.";
};

export type CounterfactualScenarioSummary = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  scenario: CounterfactualScenario;
  executionPolicyId: Exclude<CounterfactualScenario, "BASELINE"> | null;
  costScenario: CostScenario;
  initialState: SimulationInitialState;
  finalState: PositionGuardBacktestState;
  frameCount: number;
  fillCount: number;
  completedEpisodeCount: number;
  sampleSupportStatus: SampleSupportStatus;
  metrics: PositionGuardBacktestMetrics;
  fifoDiagnostics: PerformanceDiagnosticsResult["combined"];
};

export type UnavailableAssetSection = {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: "DATASET_UNAVAILABLE";
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  datasetPath: null;
  message: string;
};

export type DatasetUnusableReasonCode =
  | "EMPTY_TIMEFRAME_CANDLES"
  | "INSUFFICIENT_COMPLETED_CANDLES"
  | "NO_OVERLAPPING_REPLAY_WINDOW";

export type UnusableAssetSection = {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: "DATASET_UNUSABLE";
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  datasetPath: string;
  datasetSha256: string;
  reasonCode: DatasetUnusableReasonCode;
  message: string;
};

export type AvailableSimulationAssetSection = {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: "AVAILABLE";
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  datasetPath: string;
  datasetSha256: string;
  independentCapital: true;
  baseCostScenario: CostScenario;
  scenarios: readonly CounterfactualScenarioSummary[];
};

export type SimulationSection = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  capitalSemantics: "INDEPENDENT_PER_ASSET_NOT_A_PORTFOLIO";
  assets: readonly (UnavailableAssetSection | UnusableAssetSection | AvailableSimulationAssetSection)[];
};

export type CostSensitivityCellSummary = Omit<
  CostSensitivityCell,
  "sourceFrames" | "counterfactual" | "costMetricScope" | "fifoOutcomeMetricScope"
> & {
  costMetricScope: NonNullable<CostSensitivityCell["costMetricScope"]>;
  fifoOutcomeMetricScope: NonNullable<CostSensitivityCell["fifoOutcomeMetricScope"]>;
  tradeCount: number;
};

export type AvailableCostAssetSection = {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: "AVAILABLE";
  evidenceKind: "MODELED_COST_SCENARIO";
  datasetSha256: string;
  cells: readonly CostSensitivityCellSummary[];
};

export type UnavailableCostAssetSection = Omit<UnavailableAssetSection, "evidenceKind"> & {
  evidenceKind: "MODELED_COST_SCENARIO";
};

export type UnusableCostAssetSection = Omit<UnusableAssetSection, "evidenceKind"> & {
  evidenceKind: "MODELED_COST_SCENARIO";
};

export type CostSensitivitySection = {
  evidenceKind: "MODELED_COST_SCENARIO";
  capitalSemantics: "INDEPENDENT_PER_ASSET_NOT_A_PORTFOLIO";
  assets: readonly (UnavailableCostAssetSection | UnusableCostAssetSection | AvailableCostAssetSection)[];
};

export type RegimeAnalysisEntry = {
  costScenarioId: string;
  analysis: PerformanceRegimeAnalysisResult;
};

export type AvailableRegimeAssetSection = {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: "AVAILABLE";
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  analyses: readonly RegimeAnalysisEntry[];
};

export type RegimeAnalysisSection = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  assets: readonly (UnavailableAssetSection | UnusableAssetSection | AvailableRegimeAssetSection)[];
};

export type ExcursionAnalysisEntry = {
  costScenarioId: string;
  analysis: PerformanceExcursionResult;
};

export type AvailableExcursionAssetSection = {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: "AVAILABLE";
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  analyses: readonly ExcursionAnalysisEntry[];
};

export type ExcursionAnalysisSection = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  assets: readonly (UnavailableAssetSection | UnusableAssetSection | AvailableExcursionAssetSection)[];
};

export type AddDecisionDiagnosticsEntry = {
  costScenarioId: string;
  analysis: AddDecisionDiagnosticsResult;
  postDecisionExcursions: AddPostDecisionExcursionResult;
};

export type AvailableAddDiagnosticsAssetSection = {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: "AVAILABLE";
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  analyses: readonly AddDecisionDiagnosticsEntry[];
};

export type UnavailableAddDiagnosticsAssetSection = {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: "SCENARIO_PAIR_UNAVAILABLE";
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  message: string;
};

export type AddDiagnosticsSection = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  assets: readonly (
    UnavailableAssetSection | UnusableAssetSection | AvailableAddDiagnosticsAssetSection
    | UnavailableAddDiagnosticsAssetSection
  )[];
};

export type AvailableStabilityAssetSection = {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: "AVAILABLE";
  evidenceKind: "SIMULATED_COUNTERFACTUAL_STABILITY";
  analyses: readonly PerformanceStabilityResult[];
};

export type UnavailableStabilityAssetSection = {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: "DATASET_UNAVAILABLE" | "DATASET_UNUSABLE";
  evidenceKind: "SIMULATED_COUNTERFACTUAL_STABILITY";
  message: string;
};

export type StabilityValidationSection = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL_STABILITY";
  windows: readonly StabilityValidationWindow[];
  assets: readonly (AvailableStabilityAssetSection | UnavailableStabilityAssetSection)[];
  statisticalSignificanceClaim: false;
};

export type ConditionalAddPolicyUnavailableReason =
  | "ALL_CONDITIONAL_SCENARIOS_REQUIRED"
  | "BASELINE_AND_NO_ADD_ANCHORS_REQUIRED"
  | "EXACTLY_THREE_VALIDATION_WINDOWS_REQUIRED"
  | "BASE_COST_CELL_REQUIRED"
  | "STRESS_COST_CELL_REQUIRED";

export type ConditionalAddPolicyAssetSection = {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: "AVAILABLE";
  datasetSha256: string;
  policySupportCostRole: "BASE";
  candidates: readonly AddPolicyCandidateEvaluationResult[];
} | {
  asset: SupportedAsset;
  market: SupportedMarket;
  status: "DATASET_UNAVAILABLE" | "DATASET_UNUSABLE";
  message: string;
  candidates: readonly [];
};

export type ConditionalAddPolicyEvaluationSection = {
  evidenceKind: "SIMULATED_CONDITIONAL_ADD_POLICY_EVALUATION";
  status: "AVAILABLE" | "UNAVAILABLE";
  reasonCodes: readonly ConditionalAddPolicyUnavailableReason[];
  requestedCandidates: readonly AddPolicyCandidate[];
  requiredCandidates: readonly AddPolicyCandidate[];
  requiredAnchors: readonly ["BASELINE", "NO_ADD"];
  windows: readonly StabilityValidationWindow[];
  assets: readonly ConditionalAddPolicyAssetSection[];
  deploymentApproval: false;
  warning: string;
};

export type AddLossAttributionSection = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  analysisKind: "ADD_LOSS_ATTRIBUTION_AND_HOLDOUT_HYPOTHESIS";
  selectedFlowAttribution: true;
  causalClaim: false;
  deploymentApproval: false;
  provenance: {
    selectedFlow: PerformanceReadProvenance["filters"];
    datasets: readonly {
      asset: SupportedAsset;
      market: SupportedMarket;
      path: string;
      sha256: string;
      source: string;
      historyStartAt: string;
      endAt: string;
    }[];
    costScenarioIds: readonly string[];
    attributionCostScenarioId: string;
    validationWindowIds: readonly string[];
    candidateIds: readonly AddPolicyCandidate[];
    policySuppressionEvidence: readonly {
      asset: SupportedAsset;
      policies: readonly AddPolicySuppressionEvidence[];
    }[];
    suppressionEvidenceIds: readonly string[];
  };
  assets: readonly AddLossAttributionResult[];
  holdoutHypotheses: AddHoldoutHypothesisResult;
  warnings: readonly [
    "Selected-flow attribution; not account return.",
    "Descriptive association only; not causal proof.",
    "Future-holdout classification is not deployment approval and does not change strategy or runtime behavior.",
  ];
};

export type IntegratedEvidenceKind =
  | "OBSERVED_LIVE_ATTRIBUTION"
  | "SIMULATED_COUNTERFACTUAL"
  | "MODELED_COST_SCENARIO";

export type IntegratedEvidenceGap = {
  code: string;
  severity: "WARNING";
  evidenceKind: IntegratedEvidenceKind;
  scope: string;
  asset: SupportedAsset | null;
  market: SupportedMarket | null;
  scenario: CounterfactualScenario | null;
  costScenarioId: string | null;
  affectedMetrics: readonly string[];
  evidenceIds: readonly string[];
  message: string;
};

export type InterpretationFinding = {
  code: "OBSERVED_SAMPLE_SUPPORT" | "COUNTERFACTUAL_SCENARIO_DELTA";
  evidenceKind: "OBSERVED_LIVE_ATTRIBUTION" | "SIMULATED_COUNTERFACTUAL";
  asset: SupportedAsset | null;
  metricIds: readonly string[];
  sampleStatus: SampleSupportStatus;
  text: string;
};

export type IntegratedStrategyEvaluationReport = {
  provenance: IntegratedProvenance;
  observedLive: ObservedEvaluationSection;
  simulatedCounterfactuals: SimulationSection;
  costSensitivity: CostSensitivitySection;
  regimeAnalysis: RegimeAnalysisSection;
  excursionAnalysis: ExcursionAnalysisSection;
  addDiagnostics: AddDiagnosticsSection;
  stabilityValidation?: StabilityValidationSection;
  conditionalAddPolicyEvaluation?: ConditionalAddPolicyEvaluationSection;
  addLossAttribution?: AddLossAttributionSection;
  broadStrategyHypothesisEvaluation?: BroadStrategyHypothesisEvaluationSection;
  broadStrategyShadowHoldoutEvaluation?: CombinedConservativeHoldoutResult;
  broadStrategyShadowHoldoutDiagnostics?: HoldoutFailureDiagnosticsResult;
  broadStrategyShadowHoldoutComponentDiagnostics?: PerformanceComponentAblationResult;
  evidenceGaps: readonly IntegratedEvidenceGap[];
  interpretation: readonly InterpretationFinding[];
};

export type BroadStrategyHypothesisEvaluationSection = StrategyHypothesisEvaluationResult & {
  profileId: "BROAD_LOSS_CAUSE_V1";
  readOnly: true;
  deploymentApproval: false;
  developmentCutoffExclusive: string;
  scenarioMatrix: readonly CounterfactualScenario[];
  independentNoTradeProofAvailable: boolean;
  datasets: readonly BroadStrategyHypothesisDatasetProvenance[];
  pathDiagnostics: readonly BroadStrategyPathDiagnostics[];
  interpretationBoundary: "READ_ONLY_SELECTED_COUNTERFACTUAL_PATHS_NOT_DEPLOYMENT_APPROVAL";
};

export type BroadStrategyPathDiagnostics = {
  asset: SupportedAsset;
  scenario: CounterfactualScenario;
  timingModel: StrategyHypothesisTimingModel;
  costCellId: "BASE" | "STRESS";
  backtestMetrics: PositionGuardBacktestMetrics;
  fifoAndEpisodeDiagnostics: PerformanceDiagnosticsResult;
  regimeAnalysis: PerformanceRegimeAnalysisResult;
  excursionAnalysis: PerformanceExcursionResult;
  windows: readonly BroadStrategyWindowDiagnostics[];
  interventions: {
    total: number;
    outcomes: Record<"ALLOW" | "SUPPRESS" | "OVERRIDE_EXIT", number>;
    reasons: Record<string, number>;
  };
};

export type BroadStrategyWindowDiagnostics = {
  windowId: "W1" | "W2" | "W3";
  from: string;
  to: string;
  frameCount: number;
  returnAndDrawdown: { status: "AVAILABLE"; netReturnPct: number; maxDrawdownPct: number }
    | { status: "UNAVAILABLE"; reason: "NO_FRAMES_IN_WINDOW" };
  completedEpisodes: CounterfactualScenarioResult["matchResult"]["episodes"];
  realizationSlices: CounterfactualScenarioResult["matchResult"]["realizationSlices"];
  fills: CounterfactualScenarioResult["fills"];
  excursionEpisodes: PerformanceExcursionResult["episodes"];
};

export type BroadStrategyHypothesisDatasetProvenance = {
  asset: SupportedAsset;
  datasetSha256: string;
  initialStateFingerprint: string;
  frameFingerprint: string;
  developmentFrameCount: number;
  firstDevelopmentFrameAt: string | null;
  lastDevelopmentFrameAt: string | null;
  excludedPostCutoffCandleCount: number;
  noTradeEvidence: IntegratedNoTradeEvidenceProvenance | null;
  developmentVerifiedRangeCount: number;
};

export type IntegratedEvaluationDependencies = {
  readObserved?: (filters: PerformanceReadFilters) => PerformanceReadResult;
  readDataset?: (datasetPath: string) => Promise<ResearchCandleDataset>;
  readNoTradeEvidence?: (evidencePath: string) => Promise<ResearchNoTradeEvidence>;
  verifyBroadShadowDevelopmentAuthority?: (
    observations: readonly BroadShadowDevelopmentAuthorityObservation[],
  ) => void;
};

const UNVERIFIED_TEST_AUTHORITY_VERSION = "UNVERIFIED_TEST_OVERRIDE" as const;

export type BroadShadowDevelopmentAuthorityObservation = {
  asset: SupportedAsset;
  market: SupportedMarket;
  developmentFrom: string;
  developmentTo: string;
  initialStateFingerprint: string;
  developmentFrameFingerprint: string;
  developmentFrameCount: number;
  firstDevelopmentFrameAt: string | null;
  lastDevelopmentFrameAt: string | null;
  developmentCadenceComplete: boolean;
  featureCoverageStatus: PositionGuardFeatureCoverage["status"];
};

type IndependentNoTradeInput = {
  evidence: ResearchNoTradeEvidence;
  coverage: IndependentNoTradeCoverage;
  provenance: IntegratedNoTradeEvidenceProvenance;
  ranges: readonly CandleCoverageGap[];
  verifiedCoverage: VerifiedNoTradeCoverage;
};

type AssetEvaluation = {
  datasetProvenance: IntegratedDatasetProvenance;
  simulation: UnusableAssetSection | AvailableSimulationAssetSection;
  costs: UnusableCostAssetSection | AvailableCostAssetSection;
  regimes: UnusableAssetSection | AvailableRegimeAssetSection;
  excursions: UnusableAssetSection | AvailableExcursionAssetSection;
  addDiagnostics:
    | UnusableAssetSection
    | AvailableAddDiagnosticsAssetSection
    | UnavailableAddDiagnosticsAssetSection;
  stability: AvailableStabilityAssetSection | UnavailableStabilityAssetSection;
  conditionalCandidates: readonly AddPolicyCandidateEvaluationResult[];
  policySuppressionEvidence: readonly AddPolicySuppressionEvidence[];
  gaps: IntegratedEvidenceGap[];
};

const ASSETS = ["BTC", "ETH"] as const satisfies readonly SupportedAsset[];
const OBSERVED_DISCLAIMER = "Selected order-stream attribution; not total account return." as const;
const CAPITAL_SEMANTICS = "INDEPENDENT_PER_ASSET_NOT_A_PORTFOLIO" as const;
const REQUIRED_COMPLETED_CANDLES = 200;
const CONDITIONAL_ADD_CANDIDATES = [
  "ADD_RISK_CLEAR",
  "ADD_HIGH_ALIGNMENT",
  "ADD_CORE_TREND",
] as const satisfies readonly AddPolicyCandidate[];
const CONDITIONAL_ADD_WARNING =
  "Favorable offline research results are not deployment approval; any strategy change requires separate design, review, DRY_RUN/shadow validation, and an explicit deployment decision.";
const SAMPLE_POLICY = {
  id: "OBSERVATION_COUNT_V1" as const,
  insufficientBelow: 10 as const,
  preliminaryBelow: 30 as const,
  supportedFrom: 30 as const,
  statisticalSignificanceClaim: false as const,
};
const ADD_DIAGNOSTIC_GAP_CODES = new Set([
  "COST_FEE_ATTRIBUTION_INCOMPLETE",
  "BASELINE_EXECUTED_ADD_FILL_MISSING",
  "BASELINE_ADD_EPISODE_MISSING",
  "COMPLETED_EPISODE_NET_PNL_UNKNOWN",
]);
const BROAD_STRATEGY_PROFILE = "BROAD_LOSS_CAUSE_V1" as const;
const BROAD_STRATEGY_SCENARIOS = [
  "BASELINE",
  "NO_ADD",
  ...FROZEN_STRATEGY_HYPOTHESIS_SCENARIO_ORDER,
] as const satisfies readonly CounterfactualScenario[];
const BROAD_TIMING_MODELS = [
  "SAME_CLOSE_MODELED",
  "NEXT_FRAME_MODELED",
] as const satisfies readonly StrategyHypothesisTimingModel[];
type ValidatedFrozenBroadCostCell = {
  id: "BASE" | "STRESS";
  role: "BASE" | "STRESS";
  feeRate: number;
  slippageRate: number;
};
type ValidatedFrozenBroadAuthority = {
  scenarios: readonly CounterfactualScenario[];
  costScenarios: readonly CostScenario[];
  costCells: readonly ValidatedFrozenBroadCostCell[];
};
const BROAD_COMBINED_SHADOW_AUTHORITY = Object.freeze({
  version:
    "BROAD_LOSS_CAUSE_V1_HOLDOUT_AUTHORITY_V2@1c3a223b819e11d08eaac52744d1a29b2de18e2f3381a028b010a42600598e8f",
  frozenAt: "2026-08-19T05:54:10.188Z",
  developmentEvidenceSha256: "1c3a223b819e11d08eaac52744d1a29b2de18e2f3381a028b010a42600598e8f",
  minimumCompletedEpisodes: 10,
  comparisonTolerancePercentagePoints: 0.000001,
  comparisonToleranceKrw: 0.000000001,
} as const);

export function assertFrozenBroadShadowDevelopmentAuthority(
  observations: readonly BroadShadowDevelopmentAuthorityObservation[],
): void {
  const observedSha256 = sha256Json(observations);
  if (observedSha256 !== BROAD_COMBINED_SHADOW_AUTHORITY.developmentEvidenceSha256) {
    throw new Error(
      `Broad shadow development evidence ${observedSha256} does not match the frozen development authority ${BROAD_COMBINED_SHADOW_AUTHORITY.developmentEvidenceSha256}.`,
    );
  }
}

function validateProgrammaticFrozenBroadAuthority(
  options: IntegratedStrategyEvaluationOptions,
): ValidatedFrozenBroadAuthority | null {
  const requested = options.broadStrategyHypothesisProfile !== undefined
    || options.broadStrategyShadowHoldout !== undefined;
  if (!requested) return null;
  if (options.broadStrategyHypothesisProfile !== BROAD_STRATEGY_PROFILE) {
    throw new Error("Frozen broad evaluation requires BROAD_LOSS_CAUSE_V1.");
  }
  const simulation = options.simulation;
  if (simulation === null) {
    throw new Error("BROAD_LOSS_CAUSE_V1 requires explicit simulation options.");
  }
  if (simulation.assets.BTC === undefined || simulation.assets.ETH === undefined) {
    throw new Error("BROAD_LOSS_CAUSE_V1 requires both BTC and ETH datasets and initial states.");
  }
  if (!sameJson(simulation.scenarios, BROAD_STRATEGY_SCENARIOS)) {
    throw new Error("BROAD_LOSS_CAUSE_V1 requires the exact frozen 8-scenario matrix in canonical order.");
  }
  const authorityCosts = FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.costCells;
  if (simulation.costScenarios.length !== authorityCosts.length) {
    throw new Error("BROAD_LOSS_CAUSE_V1 requires the exact frozen BASE/STRESS cost cells in canonical order.");
  }
  const costCells = simulation.costScenarios.map((actual, index): ValidatedFrozenBroadCostCell => {
    const expected = authorityCosts[index];
    if (!expected) {
      throw new Error("BROAD_LOSS_CAUSE_V1 requires the exact frozen BASE/STRESS cost cells in canonical order.");
    }
    const keys = Object.keys(actual).sort();
    if (!sameJson(keys, ["feeRate", "id", "slippageRate"])) {
      throw new Error("BROAD_LOSS_CAUSE_V1 requires the exact frozen BASE/STRESS cost cells in canonical order.");
    }
    if (
      actual.id !== expected.id
      || actual.feeRate !== expected.feeRate
      || actual.slippageRate !== expected.slippageRate
    ) {
      throw new Error("BROAD_LOSS_CAUSE_V1 requires the exact frozen BASE/STRESS cost cells in canonical order.");
    }
    return Object.freeze({
      id: actual.id,
      role: actual.id,
      feeRate: actual.feeRate,
      slippageRate: actual.slippageRate,
    });
  });
  const exactWindows = FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.windows.map((window) => ({
    id: window.id,
    from: normalizeExplicitIsoTimestamp(window.from, "frozen window from"),
    to: normalizeExplicitIsoTimestamp(window.to, "frozen window to"),
  }));
  if (
    options.stabilityValidation === null
    || !sameJson(options.stabilityValidation.windows, exactWindows)
    || options.stabilityValidation.expectedFrameIntervalMs !== 3_600_000
  ) {
    throw new Error("BROAD_LOSS_CAUSE_V1 requires the exact frozen W1/W2/W3 validation windows.");
  }
  if (options.broadStrategyShadowHoldout !== undefined) {
    if (
      simulation.assets.BTC.noTradeEvidencePath === undefined
      || simulation.assets.ETH.noTradeEvidencePath === undefined
    ) {
      throw new Error("Broad shadow holdout requires authenticated BTC and ETH no-trade evidence.");
    }
    const from = normalizeExplicitIsoTimestamp(
      options.broadStrategyShadowHoldout.from,
      "broad shadow holdout from",
    );
    const to = normalizeExplicitIsoTimestamp(
      options.broadStrategyShadowHoldout.to,
      "broad shadow holdout to",
    );
    if (comparePerformanceTimestamps(from, FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentTo) < 0) {
      throw new Error("Broad shadow holdout must not overlap the frozen development range.");
    }
    if (comparePerformanceTimestamps(from, to) >= 0) {
      throw new Error("Broad shadow holdout [from,to) requires from before to.");
    }
  }
  const scenarios = Object.freeze([...simulation.scenarios]);
  const costScenarios = Object.freeze(costCells.map((cost) => Object.freeze({
    id: cost.id,
    feeRate: cost.feeRate,
    slippageRate: cost.slippageRate,
  })));
  return Object.freeze({
    scenarios,
    costScenarios,
    costCells: Object.freeze(costCells),
  });
}

function requireFrozenBroadAuthority(
  value: ValidatedFrozenBroadAuthority | null,
): ValidatedFrozenBroadAuthority {
  if (value === null) throw new Error("Frozen broad authority was not validated before evaluation.");
  return value;
}

export function scopeResearchDatasetForFeatureCoverage(
  dataset: ResearchCandleDataset,
  frames: readonly Pick<PositionGuardBacktestFrameResult, "generatedAt">[],
): ResearchCandleDataset {
  const lastFrame = frames.at(-1);
  if (lastFrame === undefined) {
    throw new Error("Feature coverage scope requires at least one analyzed frame.");
  }
  const endAt = normalizeExplicitIsoTimestamp(
    lastFrame.generatedAt,
    "feature coverage last frame generatedAt",
  );
  return {
    provenance: {
      ...dataset.provenance,
      endAt,
    },
    candles: {
      "1h": dataset.candles["1h"].filter((candle) =>
        comparePerformanceTimestamps(candle.closeTime, endAt) <= 0),
      "4h": dataset.candles["4h"].filter((candle) =>
        comparePerformanceTimestamps(candle.closeTime, endAt) <= 0),
      "1d": dataset.candles["1d"].filter((candle) =>
        comparePerformanceTimestamps(candle.closeTime, endAt) <= 0),
    },
  };
}

type ConditionalAddPolicyConfiguration = {
  baseCost: CostScenario;
  stressCost: CostScenario;
  windows: readonly StabilityValidationWindow[];
  expectedFrameIntervalMs: number;
};

type ConditionalAddPolicyReadiness = {
  requested: boolean;
  requestedCandidates: AddPolicyCandidate[];
  reasonCodes: ConditionalAddPolicyUnavailableReason[];
  configuration: ConditionalAddPolicyConfiguration | null;
};

export function parseIntegratedStrategyEvaluationArgs(
  argv: readonly string[],
): IntegratedStrategyEvaluationOptions {
  const allowed = new Set([
    "database",
    "exchange-account-id",
    "execution-mode",
    "origin",
    "from",
    "to",
    "format",
    "btc-dataset",
    "eth-dataset",
    "btc-no-trade-evidence",
    "eth-no-trade-evidence",
    "btc-initial-state",
    "eth-initial-state",
    "scenarios",
    "minimum-order-value-krw",
    "cost-cells",
    "validation-windows",
    "validation-frame-interval-ms",
    "validation-comparison-tolerance-pp",
    "validation-minimum-windows",
    "broad-strategy-hypothesis-profile",
    "broad-shadow-holdout-from",
    "broad-shadow-holdout-to",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      throw new Error(`Unexpected argument ${token ?? "<missing>"}.`);
    }
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown argument --${key}.`);
    if (values.has(key)) throw new Error(`Duplicate argument --${key}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }
    values.set(key, value);
    index += 1;
  }

  const observed = parseObservedFilters(values);
  const format = parseFormat(values.get("format"));
  for (const asset of ASSETS) {
    const prefix = asset.toLowerCase();
    if (values.has(`${prefix}-no-trade-evidence`) && !values.has(`${prefix}-dataset`)) {
      throw new Error(`--${prefix}-no-trade-evidence requires --${prefix}-dataset.`);
    }
  }
  const hasDataset = values.has("btc-dataset") || values.has("eth-dataset");
  const simulationKeys = [
    "btc-dataset",
    "eth-dataset",
    "btc-no-trade-evidence",
    "eth-no-trade-evidence",
    "btc-initial-state",
    "eth-initial-state",
    "scenarios",
    "minimum-order-value-krw",
    "cost-cells",
    "broad-strategy-hypothesis-profile",
    "broad-shadow-holdout-from",
    "broad-shadow-holdout-to",
  ];
  if (!hasDataset) {
    if (simulationKeys.some((key) => values.has(key))) {
      throw new Error("Simulation arguments require at least one local dataset.");
    }
    if (hasAnyStabilityArgument(values)) {
      throw new Error("Stability validation requires simulation datasets.");
    }
    return { observed, format, simulation: null, stabilityValidation: null };
  }

  const assets: Partial<Record<SupportedAsset, SimulationAssetOptions>> = {};
  for (const asset of ASSETS) {
    const prefix = asset.toLowerCase();
    const datasetPath = values.get(`${prefix}-dataset`);
    const noTradeEvidencePath = values.get(`${prefix}-no-trade-evidence`);
    const initialStateValue = values.get(`${prefix}-initial-state`);
    if (datasetPath === undefined && initialStateValue !== undefined) {
      throw new Error(`--${prefix}-initial-state requires --${prefix}-dataset.`);
    }
    if (datasetPath === undefined) continue;
    if (initialStateValue === undefined) {
      throw new Error(`Missing required simulation argument --${prefix}-initial-state.`);
    }
    assets[asset] = {
      datasetPath: requireNonEmpty(datasetPath, `--${prefix}-dataset`),
      ...(noTradeEvidencePath === undefined
        ? {}
        : {
            noTradeEvidencePath: requireNonEmpty(
              noTradeEvidencePath,
              `--${prefix}-no-trade-evidence`,
            ),
          }),
      initialState: parseInitialState(initialStateValue, `--${prefix}-initial-state`),
    };
  }

  const scenarios = parseScenarios(requireSimulationArgument(values, "scenarios"));
  const minimumOrderValueKrw = parseFiniteNonNegativeNumber(
    requireSimulationArgument(values, "minimum-order-value-krw"),
    "minimum-order-value-krw",
  );
  const costScenarios = parseCostScenarios(requireSimulationArgument(values, "cost-cells"));
  const simulation = {
    scenarios,
    minimumOrderValueKrw,
    costScenarios,
    assets,
  };
  const stabilityValidation = parseStabilityValidation(values, scenarios);
  const broadStrategyHypothesisProfile = parseBroadStrategyHypothesisProfile(
    values,
    simulation,
    stabilityValidation,
  );
  const broadStrategyShadowHoldout = parseBroadStrategyShadowHoldout(
    values,
    broadStrategyHypothesisProfile,
    simulation,
  );
  if (
    broadStrategyHypothesisProfile === BROAD_STRATEGY_PROFILE
    && ((assets.BTC?.noTradeEvidencePath === undefined)
      !== (assets.ETH?.noTradeEvidencePath === undefined))
  ) {
    throw new Error(
      "BROAD_LOSS_CAUSE_V1 requires both BTC and ETH no-trade evidence paths when either is supplied.",
    );
  }
  return {
    observed,
    format,
    simulation,
    stabilityValidation,
    ...(broadStrategyHypothesisProfile === undefined
      ? {}
      : { broadStrategyHypothesisProfile }),
    ...(broadStrategyShadowHoldout === undefined
      ? {}
      : { broadStrategyShadowHoldout }),
  };
}

export async function buildIntegratedStrategyEvaluation(
  options: IntegratedStrategyEvaluationOptions,
  dependencies: IntegratedEvaluationDependencies = {},
): Promise<IntegratedStrategyEvaluationReport> {
  if (options.observed.executionMode !== "LIVE") {
    throw new Error("OBSERVED_LIVE_ATTRIBUTION requires executionMode LIVE.");
  }
  const frozenBroadAuthority = validateProgrammaticFrozenBroadAuthority(options);
  const evaluationSimulation = frozenBroadAuthority === null
    ? options.simulation
    : {
        ...options.simulation!,
        scenarios: frozenBroadAuthority.scenarios,
        costScenarios: frozenBroadAuthority.costScenarios,
      };
  const readObserved = dependencies.readObserved ?? readPerformanceInput;
  const readDataset = dependencies.readDataset ?? readResearchCandleDataset;
  const readNoTradeEvidence = dependencies.readNoTradeEvidence ?? readResearchNoTradeEvidence;
  const observedRead = readObserved(options.observed);
  const observedDiagnostics = diagnosePerformance({
    fills: observedRead.tradeFills,
    ...(observedRead.attributionInput.openingPositions === undefined
      ? {}
      : { openingPositions: observedRead.attributionInput.openingPositions }),
    markObservations: observedRead.markObservations,
    policy: { breakevenToleranceKrw: 1e-9 },
  });
  const observedAttribution = buildObservedAttribution({
    matchResult: observedDiagnostics.matchResult,
    diagnostics: observedDiagnostics,
  });
  const observedLive: ObservedEvaluationSection = {
    status: "AVAILABLE",
    evidenceKind: "OBSERVED_LIVE_ATTRIBUTION",
    selectedExecutionMode: options.observed.executionMode,
    selectedOrigin: options.observed.origin,
    provenance: observedRead.provenance,
    performance: calculatePerformance(observedRead.attributionInput),
    diagnostics: observedDiagnostics,
    attribution: observedAttribution,
    disclaimer: OBSERVED_DISCLAIMER,
  };
  const conditionalReadiness = assessConditionalAddPolicyReadiness(
    evaluationSimulation,
    options.stabilityValidation,
  );

  const assetEvaluations = new Map<SupportedAsset, AssetEvaluation>();
  const broadDatasets = new Map<SupportedAsset, {
    raw: ResearchCandleDataset;
    development: ResearchCandleDataset;
    options: SimulationAssetOptions;
    noTrade: IndependentNoTradeInput | undefined;
  }>();
  if (evaluationSimulation !== null) {
    for (const asset of ASSETS) {
      const assetOptions = evaluationSimulation.assets[asset];
      if (assetOptions === undefined) continue;
      const rawDataset = await readDataset(assetOptions.datasetPath);
      const noTrade = assetOptions.noTradeEvidencePath === undefined
        ? undefined
        : buildIndependentNoTradeInput(
            assetOptions.noTradeEvidencePath,
            rawDataset,
            await readNoTradeEvidence(assetOptions.noTradeEvidencePath),
          );
      const dataset = options.broadStrategyHypothesisProfile === BROAD_STRATEGY_PROFILE
        ? restrictDatasetToDevelopmentCutoff(rawDataset)
        : rawDataset;
      if (options.broadStrategyHypothesisProfile === BROAD_STRATEGY_PROFILE) {
        broadDatasets.set(asset, {
          raw: rawDataset,
          development: dataset,
          options: assetOptions,
          noTrade,
        });
      }
      const assetSimulation = options.broadStrategyHypothesisProfile === BROAD_STRATEGY_PROFILE
        && assetOptions.initialState.quantity > 0
          ? {
            ...evaluationSimulation,
            scenarios: evaluationSimulation.scenarios.filter((scenario) =>
              scenario !== "ADD_LIMITED"
              && scenario !== "COOLDOWN_CONTROL"
              && scenario !== "COMBINED_CONSERVATIVE"),
          }
        : evaluationSimulation;
      assetEvaluations.set(
        asset,
        evaluateAsset(
          asset,
          assetOptions,
          dataset,
          assetSimulation,
          options.stabilityValidation,
          conditionalReadiness.configuration,
          noTrade,
        ),
      );
    }
  }

  const unavailable = (asset: SupportedAsset): UnavailableAssetSection => ({
    asset,
    market: getMarketForAsset(asset),
    status: "DATASET_UNAVAILABLE",
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    datasetPath: null,
    message: `No immutable local ${asset} candle dataset was supplied; no reader or network fallback was used.`,
  });
  const simulationAssets = ASSETS.map((asset) => assetEvaluations.get(asset)?.simulation ?? unavailable(asset));
  const costAssets = ASSETS.map((asset):
    UnavailableCostAssetSection | UnusableCostAssetSection | AvailableCostAssetSection => {
    const evaluation = assetEvaluations.get(asset);
    if (evaluation) return evaluation.costs;
    const missing = unavailable(asset);
    return { ...missing, evidenceKind: "MODELED_COST_SCENARIO" };
  });
  const regimeAssets = ASSETS.map((asset) => assetEvaluations.get(asset)?.regimes ?? unavailable(asset));
  const excursionAssets = ASSETS.map((asset) => assetEvaluations.get(asset)?.excursions ?? unavailable(asset));
  const addDiagnosticAssets = ASSETS.map(
    (asset) => assetEvaluations.get(asset)?.addDiagnostics ?? unavailable(asset),
  );
  const stabilityAssets = options.stabilityValidation === null
    ? []
    : ASSETS.map((asset): AvailableStabilityAssetSection | UnavailableStabilityAssetSection => {
        const evaluation = assetEvaluations.get(asset);
        if (evaluation) return evaluation.stability;
        return {
          asset,
          market: getMarketForAsset(asset),
          status: "DATASET_UNAVAILABLE",
          evidenceKind: "SIMULATED_COUNTERFACTUAL_STABILITY",
          message: `No immutable local ${asset} dataset was supplied; stability validation was not run.`,
        };
      });
  const datasetGaps = ASSETS
    .filter((asset) => !assetEvaluations.has(asset))
    .map(datasetUnavailableGap);
  const evidenceGaps = [
    ...mapObservedGaps(observedAttribution),
    ...mapObservedMarkGaps(observedDiagnostics),
    ...datasetGaps,
    ...ASSETS.flatMap((asset) => assetEvaluations.get(asset)?.gaps ?? []),
  ];
  const datasets = ASSETS.flatMap((asset) => {
    const provenance = assetEvaluations.get(asset)?.datasetProvenance;
    return provenance === undefined ? [] : [provenance];
  });
  const baseCostScenario = evaluationSimulation?.costScenarios[0] ?? null;
  const conditionalAddPolicyEvaluation = buildConditionalAddPolicySection(
    conditionalReadiness,
    options.stabilityValidation,
    assetEvaluations,
  );
  const addLossAttribution = buildAddLossAttributionSection({
    conditionalAddPolicyEvaluation,
    observedProvenance: observedRead.provenance,
    simulation: evaluationSimulation,
    stabilityValidation: options.stabilityValidation,
    assetEvaluations,
  });
  const broadStrategyHypothesisEvaluation = options.broadStrategyHypothesisProfile === undefined
    ? null
    : buildBroadStrategyHypothesisEvaluation(
        options,
        broadDatasets,
        requireFrozenBroadAuthority(frozenBroadAuthority),
      );
  const broadStrategyShadowHoldoutBundle = options.broadStrategyShadowHoldout === undefined
    ? null
    : buildBroadCombinedConservativeHoldoutEvaluation(
        options,
        broadDatasets,
        dependencies.verifyBroadShadowDevelopmentAuthority
          ?? assertFrozenBroadShadowDevelopmentAuthority,
        dependencies.verifyBroadShadowDevelopmentAuthority === undefined,
        requireFrozenBroadAuthority(frozenBroadAuthority),
      );
  const broadStrategyShadowHoldoutEvaluation =
    broadStrategyShadowHoldoutBundle?.evaluation ?? null;
  const broadStrategyShadowHoldoutComponentDiagnostics =
    broadStrategyShadowHoldoutBundle?.componentDiagnostics ?? null;
  const broadStrategyShadowHoldoutDiagnostics = broadStrategyShadowHoldoutEvaluation === null
    ? null
    : diagnoseCombinedConservativeHoldoutFailures(
        broadStrategyShadowHoldoutEvaluation.assets.map((asset) => ({
          asset: asset.asset,
          market: asset.market,
          status: asset.status,
          comparisons: asset.comparisons,
        })),
      );
  const report: IntegratedStrategyEvaluationReport = {
    provenance: {
      observed: observedRead.provenance,
      datasets,
      scenarioAssumptions: {
        scenarios: evaluationSimulation?.scenarios ?? [],
        baseCostScenario,
        minimumOrderValueKrw: evaluationSimulation?.minimumOrderValueKrw ?? null,
      },
      costCells: evaluationSimulation?.costScenarios ?? [],
      sampleSupportPolicy: SAMPLE_POLICY,
      capitalSemantics: CAPITAL_SEMANTICS,
    },
    observedLive,
    simulatedCounterfactuals: {
      evidenceKind: "SIMULATED_COUNTERFACTUAL",
      capitalSemantics: CAPITAL_SEMANTICS,
      assets: simulationAssets,
    },
    costSensitivity: {
      evidenceKind: "MODELED_COST_SCENARIO",
      capitalSemantics: CAPITAL_SEMANTICS,
      assets: costAssets,
    },
    regimeAnalysis: { evidenceKind: "SIMULATED_COUNTERFACTUAL", assets: regimeAssets },
    excursionAnalysis: { evidenceKind: "SIMULATED_COUNTERFACTUAL", assets: excursionAssets },
    addDiagnostics: { evidenceKind: "SIMULATED_COUNTERFACTUAL", assets: addDiagnosticAssets },
    ...(options.stabilityValidation === null
      ? {}
      : {
          stabilityValidation: {
            evidenceKind: "SIMULATED_COUNTERFACTUAL_STABILITY" as const,
            windows: options.stabilityValidation.windows,
            assets: stabilityAssets,
            statisticalSignificanceClaim: false as const,
          },
        }),
    ...(conditionalAddPolicyEvaluation === null
      ? {}
      : { conditionalAddPolicyEvaluation }),
    ...(addLossAttribution === null ? {} : { addLossAttribution }),
    ...(broadStrategyHypothesisEvaluation === null
      ? {}
      : { broadStrategyHypothesisEvaluation }),
    ...(broadStrategyShadowHoldoutEvaluation === null
      ? {}
      : { broadStrategyShadowHoldoutEvaluation }),
    ...(broadStrategyShadowHoldoutDiagnostics === null
      ? {}
      : { broadStrategyShadowHoldoutDiagnostics }),
    ...(broadStrategyShadowHoldoutComponentDiagnostics === null
      ? {}
      : { broadStrategyShadowHoldoutComponentDiagnostics }),
    evidenceGaps,
    interpretation: buildInterpretation(observedAttribution, simulationAssets),
  };
  assertJsonCompatible(report);
  return report;
}

export function formatIntegratedStrategyEvaluation(
  report: IntegratedStrategyEvaluationReport,
  format: IntegratedEvaluationFormat,
): string {
  if (format !== "text" && format !== "json") throw new Error(`Unsupported format ${String(format)}.`);
  assertJsonCompatible(report);
  if (format === "json") return JSON.stringify(report, null, 2);

  return [
    "Integrated Strategy Evaluation",
    `capital_semantics: ${report.provenance.capitalSemantics}`,
    `observed_evidence: ${report.observedLive.evidenceKind}`,
    `simulation_evidence: ${report.simulatedCounterfactuals.evidenceKind}`,
    `cost_evidence: ${report.costSensitivity.evidenceKind}`,
    "",
    "Human Summary",
    ...formatHumanSummary(report),
    "",
    "Technical Sections (complete JSON facts)",
    "",
    "[Provenance]",
    JSON.stringify(report.provenance, null, 2),
    "",
    "[Observed Live Attribution]",
    JSON.stringify(report.observedLive, null, 2),
    "",
    "[Simulated Counterfactuals]",
    JSON.stringify(report.simulatedCounterfactuals, null, 2),
    "",
    "[Modeled Cost Sensitivity]",
    JSON.stringify(report.costSensitivity, null, 2),
    "",
    "[Regime Analysis]",
    JSON.stringify(report.regimeAnalysis, null, 2),
    "",
    "[Excursion Analysis]",
    JSON.stringify(report.excursionAnalysis, null, 2),
    "",
    "[ADD Decision Diagnostics]",
    JSON.stringify(report.addDiagnostics, null, 2),
    ...(report.broadStrategyHypothesisEvaluation === undefined
      ? []
      : [
          "",
          "[Broad Strategy Hypothesis Evaluation]",
          "Read-only selected counterfactual paths; this is not deployment approval.",
          JSON.stringify(report.broadStrategyHypothesisEvaluation, null, 2),
        ]),
    ...(report.broadStrategyShadowHoldoutEvaluation === undefined
      ? []
      : [
          "",
          "[Combined Conservative Shadow Holdout]",
          "Separate read-only holdout evidence; this is not deployment approval.",
          JSON.stringify(report.broadStrategyShadowHoldoutEvaluation, null, 2),
        ]),
    ...(report.broadStrategyShadowHoldoutDiagnostics === undefined
      ? []
      : [
          "",
          "[Combined Conservative Aggregate Failure Diagnostics]",
          "Descriptive aggregate path associations only; no causal or deployment claim.",
          JSON.stringify(report.broadStrategyShadowHoldoutDiagnostics, null, 2),
        ]),
    ...(report.broadStrategyShadowHoldoutComponentDiagnostics === undefined
      ? []
      : [
          "",
          "[Combined Conservative Component Ablation Diagnostics]",
          "Retrospective association only; non-causal; cannot authorize shadow/LIVE and can only nominate a fresh prospective test.",
          JSON.stringify(report.broadStrategyShadowHoldoutComponentDiagnostics, null, 2),
        ]),
    ...(report.stabilityValidation === undefined
      ? []
      : [
          "",
          "[Anchored Forward Stability]",
          JSON.stringify(report.stabilityValidation, null, 2),
        ]),
    ...(report.conditionalAddPolicyEvaluation === undefined
      ? []
      : [
          "",
          "[Conditional ADD Policy Evaluation]",
          JSON.stringify(report.conditionalAddPolicyEvaluation, null, 2),
        ]),
    "",
    "[Evidence Gaps]",
    JSON.stringify(report.evidenceGaps, null, 2),
    "",
    "[Interpretation]",
    JSON.stringify(report.interpretation, null, 2),
  ].join("\n");
}

function formatHumanSummary(report: IntegratedStrategyEvaluationReport): string[] {
  const completedSupport = report.observedLive.attribution.sampleSupport.COMPLETED_EPISODES;
  const observedFilters = report.observedLive.provenance.filters;
  const lines = [
    `Observed selected stream: fills=${report.observedLive.provenance.fillCount}; completed_episodes=${completedSupport.observedCount}; sample_support=${completedSupport.status}`,
    `Observed filters: database=${observedFilters.databasePath}; account=${observedFilters.exchangeAccountId}; mode=${observedFilters.executionMode}; origin=${observedFilters.origin}; period=[${observedFilters.from ?? "unbounded"},${observedFilters.to ?? "unbounded"})`,
    `Observed scope: ${report.observedLive.disclaimer}`,
  ];
  for (const assetSection of report.simulatedCounterfactuals.assets) {
    if (assetSection.status !== "AVAILABLE") {
      lines.push(`${assetSection.asset} simulation: status=${assetSection.status}; ${assetSection.message}`);
      continue;
    }
    lines.push(
      `${assetSection.asset} simulation: status=AVAILABLE; base_cost=${assetSection.baseCostScenario.id}; scenarios=${assetSection.scenarios.map((scenario) => scenario.scenario).join(",")}; independent_capital=${assetSection.independentCapital}`,
    );
    const dataset = report.provenance.datasets.find((item) => item.asset === assetSection.asset);
    if (dataset) {
      lines.push(
        `${assetSection.asset} dataset: path=${dataset.path}; sha256=${dataset.sha256}; source=${dataset.dataset.source}; period=[${dataset.dataset.historyStartAt},${dataset.dataset.endAt}]; frames=${dataset.frameCount}`,
      );
      if (dataset.featureCoverage) {
        lines.push(
          `${assetSection.asset} feature coverage: continuity=${dataset.featureCoverage.status}; affected_frames=${dataset.featureCoverage.affectedFrameCount}; continuity_policy=${dataset.featureCoverage.continuityPolicy}`,
        );
        for (const timeframe of ["1h", "4h", "1d"] as const) {
          const coverage = dataset.featureCoverage.timeframes[timeframe];
          lines.push(
            `${assetSection.asset} dataset ${timeframe}: source_cadence=${coverage.sourceCadenceStatus}; sequence=${coverage.sourceSequenceStatus}; clock_grid=${coverage.clockGridStatus}; observed=${coverage.sourceObservedCandleCount}; expected=${coverage.sourceExpectedCandleCount}; no_trade_intervals=${coverage.sourceNoTradeIntervalCount}; raw_missing=${coverage.sourceMissingCandleCount}; duplicate=${coverage.sourceDuplicateCandleCount}; off_grid=${coverage.sourceOffGridCandleCount}; recursive_input=${coverage.lookbackContinuityStatus}; affected_frames=${coverage.affectedFrameCount}`,
          );
        }
      }
    }
  }

  for (const assetSection of report.costSensitivity.assets) {
    if (assetSection.status !== "AVAILABLE") continue;
    for (const cell of assetSection.cells) {
      lines.push(
        `${assetSection.asset} cost ${cell.costScenario.id}/${cell.scenario}: return_pct=${cell.totalReturnPct}; final_equity_krw=${cell.finalEquityKrw}; drawdown_pct=${cell.maxDrawdownPct}; trades=${cell.tradeCount}; completed_episodes=${cell.completedEpisodeCount}`,
      );
    }
  }

  for (const assetSection of report.stabilityValidation?.assets ?? []) {
    if (assetSection.status !== "AVAILABLE") {
      lines.push(`${assetSection.asset} stability: status=${assetSection.status}; ${assetSection.message}`);
      continue;
    }
    for (const analysis of assetSection.analyses) {
      lines.push(
        `${assetSection.asset} stability cost ${analysis.costScenarioId}: overall=${analysis.overall.classification}; evaluable=${analysis.overall.evaluableWindowCount}; better=${analysis.overall.betterWindowCount}; tied=${analysis.overall.tiedWindowCount}; worse=${analysis.overall.worseWindowCount}; no_policy_exposure=${analysis.overall.noPolicyExposureWindowCount}; insufficient=${analysis.overall.insufficientWindowCount}`,
      );
      for (const window of analysis.windows) {
        lines.push(
          `${assetSection.asset} stability ${analysis.costScenarioId}/${window.window.id}: classification=${window.classification}; delta_pp=${window.returnDeltaPercentagePoints ?? "unknown"}; baseline_return_pct=${window.baseline.periodReturnPct ?? "unknown"}; no_add_return_pct=${window.noAdd.periodReturnPct ?? "unknown"}; completed_episodes=baseline:${window.sampleSupport.baselineCompletedEpisodeCount},no_add:${window.sampleSupport.noAddCompletedEpisodeCount}; policy_exposure=${window.sampleSupport.policyExposureCount}; coverage=${window.coverage.status}(${window.coverage.observedFrameCount}/${window.coverage.expectedFrameCount})`,
        );
      }
    }
  }

  const conditional = report.conditionalAddPolicyEvaluation;
  if (conditional !== undefined) {
    lines.push(
      `Conditional ADD Policy Evaluation: status=${conditional.status}; candidates=${conditional.requestedCandidates.join(",") || "none"}; reasons=${conditional.reasonCodes.join(",") || "none"}`,
    );
    for (const asset of conditional.assets) {
      if (asset.status !== "AVAILABLE") {
        lines.push(`${asset.asset} conditional ADD: status=${asset.status}; ${asset.message}`);
        continue;
      }
      for (const candidate of asset.candidates) {
        lines.push(
          `${asset.asset} conditional ADD ${candidate.candidate}: status=${candidate.status}; policy_exposed_completed_episodes=${candidate.gates.policyExposedCompletedEpisodes.fullPathObservedCount}; coverage=${candidate.gates.frameCoverage.status}; feature_continuity=${candidate.gates.frameCoverage.fullPath.featureLookbackContinuityStatus}; feature_affected_frames=${candidate.gates.frameCoverage.fullPath.featureLookbackAffectedFrameCount}; base_return=${candidate.gates.fullPathNetReturn.status}; stress_windows=${candidate.gates.stressWindowReturn.status}`,
        );
      }
    }
    lines.push(`Conditional ADD warning: ${conditional.warning}`);
  }

  if (report.addLossAttribution !== undefined) {
    lines.push(...formatAddLossAttributionSummary(report.addLossAttribution));
  }

  const componentDiagnostics = report.broadStrategyShadowHoldoutComponentDiagnostics;
  if (componentDiagnostics !== undefined) {
    for (const asset of ["ETH", "BTC"] as const) {
      const assetDiagnostics = componentDiagnostics.assets.find((item) => item.asset === asset);
      if (!assetDiagnostics) continue;
      lines.push(
        `${asset} component ablation: ${assetDiagnostics.components.map((component) =>
          `${component.ablationScenario}=${component.classification}`).join(",")}; retrospective association; non-causal; cannot authorize shadow/LIVE; can only nominate a fresh prospective test.`,
      );
    }
  }

  const gapCodes = [...new Set(report.evidenceGaps.map((gap) => gap.code))];
  lines.push(`Evidence gaps: count=${report.evidenceGaps.length}; codes=${gapCodes.join(",") || "none"}`);
  for (const finding of report.interpretation) {
    lines.push(
      `Interpretation ${finding.code}${finding.asset === null ? "" : `/${finding.asset}`}: sample_support=${finding.sampleStatus}; metrics=${finding.metricIds.join(",")}; ${finding.text}`,
    );
  }
  return lines;
}

function formatAddLossAttributionSummary(section: AddLossAttributionSection): string[] {
  const lines = ["ADD Loss Attribution"];
  for (const asset of section.assets) {
    lines.push(
      `${asset.asset} ADD totals: executed=${asset.aggregate.executedAddCount}; fully_realized=${asset.aggregate.fullyRealizedAddCount}; partially_realized=${asset.aggregate.partiallyRealizedAddCount}; unrealized=${asset.aggregate.unrealizedAddCount}; known_net_denominator=${asset.aggregate.knownNetContributionCount}/${asset.aggregate.executedAddCount}; net=${formatAggregateMetric(asset.aggregate.netRealizedContributionKrw)}; fee=${formatAggregateMetric(asset.aggregate.confirmedFeeImpactKrw)}; net_completeness=${asset.aggregate.netRealizedContributionKrw.completeness}; fee_completeness=${asset.aggregate.confirmedFeeImpactKrw.completeness}`,
    );
    const losses = [
      ...asset.cohorts.byRegime,
      ...asset.cohorts.byAtrShock,
      ...asset.cohorts.byWeakeningStage,
      ...asset.cohorts.byTrendAlignmentScore,
      ...asset.cohorts.byAddOrdinal,
    ].filter((cohort) =>
      cohort.knownNetContributionCount > 0
      && cohort.netRealizedContributionKrw.knownSubtotal.status === "KNOWN"
      && cohort.netRealizedContributionKrw.knownSubtotal.value < 0
    ).sort((left, right) => {
      const leftValue = left.netRealizedContributionKrw.knownSubtotal.status === "KNOWN"
        ? left.netRealizedContributionKrw.knownSubtotal.value
        : 0;
      const rightValue = right.netRealizedContributionKrw.knownSubtotal.status === "KNOWN"
        ? right.netRealizedContributionKrw.knownSubtotal.value
        : 0;
      return leftValue - rightValue
        || left.dimension.localeCompare(right.dimension)
        || left.value.localeCompare(right.value);
    }).slice(0, 3);
    if (losses.length === 0) {
      lines.push(`${asset.asset} loss cohorts: none with known negative net contribution`);
    } else {
      for (const cohort of losses) {
        lines.push(
          `${asset.asset} loss cohort ${cohort.dimension}=${cohort.value}: known_net_denominator=${cohort.knownNetContributionCount}/${cohort.executedAddCount}; known_net_subtotal=${formatMetric(cohort.netRealizedContributionKrw.knownSubtotal)}; net=${formatAggregateMetric(cohort.netRealizedContributionKrw)}; fee=${formatAggregateMetric(cohort.confirmedFeeImpactKrw)}; net_completeness=${cohort.netRealizedContributionKrw.completeness}; fee_completeness=${cohort.confirmedFeeImpactKrw.completeness}`,
        );
      }
    }
    for (const policy of asset.policySuppressedCohorts) {
      lines.push(
        `${asset.asset} policy suppressed ${policy.policyId}: executed=${policy.metrics.executedAddCount}; known_net_denominator=${policy.metrics.knownNetContributionCount}/${policy.metrics.executedAddCount}; net=${formatAggregateMetric(policy.metrics.netRealizedContributionKrw)}; fee=${formatAggregateMetric(policy.metrics.confirmedFeeImpactKrw)}; evidence=${policy.suppressionEvidenceIds.length}`,
      );
    }
  }
  for (const hypothesis of section.holdoutHypotheses.hypotheses) {
    lines.push(
      `Cross-asset holdout ${hypothesis.candidate}: status=${hypothesis.status}; reasons=${hypothesis.reasonCodes.join(",") || "none"}`,
    );
  }
  lines.push(...section.warnings.map((warning) => `ADD warning: ${warning}`));
  return lines;
}

function formatAggregateMetric(metric: AddLossAttributionResult["aggregate"]["netRealizedContributionKrw"]): string {
  if (metric.total.status === "KNOWN") return String(metric.total.value);
  if (metric.total.status === "UNKNOWN") return `unknown(${metric.total.reasons.join(",")})`;
  return `not_applicable(${metric.total.reason})`;
}

function formatMetric(metric: AddLossAttributionResult["aggregate"]["netRealizedContributionKrw"]["knownSubtotal"]): string {
  if (metric.status === "KNOWN") return String(metric.value);
  if (metric.status === "UNKNOWN") return `unknown(${metric.reasons.join(",")})`;
  return `not_applicable(${metric.reason})`;
}

export type AddPolicySuppressionReplay = {
  policyId: AddPolicyCandidate;
  frames: readonly Pick<PositionGuardBacktestFrameResult, "generatedAt" | "researchSuppression">[];
};

export function extractAddPolicySuppressionEvidence(
  asset: SupportedAsset,
  replays: readonly AddPolicySuppressionReplay[],
): AddPolicySuppressionEvidence[] {
  const market = getMarketForAsset(asset);
  const seenPolicies = new Set<AddPolicyCandidate>();
  return replays.map(({ policyId, frames }) => {
    if (seenPolicies.has(policyId)) throw new Error(`Duplicate ADD policy suppression replay ${policyId}.`);
    seenPolicies.add(policyId);
    const seenInstants = new Set<string>();
    const suppressedDecisions = frames.flatMap((frame) => {
      const suppression = frame.researchSuppression;
      if (suppression === null || suppression === undefined) return [];
      if (suppression.policyId !== policyId) {
        throw new Error(`ADD policy suppression replay ${policyId} contains ${suppression.policyId} evidence.`);
      }
      const frameTime = requirePerformanceTimestamp(frame.generatedAt, `${policyId} replay frame generatedAt`);
      const suppressionTime = requirePerformanceTimestamp(
        suppression.generatedAt,
        `${policyId} research suppression generatedAt`,
      );
      if (compareEpochNanoseconds(frameTime.epochNanoseconds, suppressionTime.epochNanoseconds) !== 0) {
        throw new Error(`ADD policy suppression replay ${policyId} frame and suppression timestamps differ.`);
      }
      if (seenInstants.has(suppressionTime.normalized)) {
        throw new Error(`Duplicate ADD policy suppression instant ${policyId}:${suppressionTime.normalized}.`);
      }
      seenInstants.add(suppressionTime.normalized);
      return [{
        generatedAt: suppressionTime.normalized,
        evidenceIds: [
          `research-suppression:${asset}:${market}:${policyId}:${suppressionTime.normalized}:${suppression.reason}`,
        ],
      }];
    }).sort((left, right) =>
      comparePerformanceTimestamps(left.generatedAt, right.generatedAt)
      || left.evidenceIds[0]!.localeCompare(right.evidenceIds[0]!)
    );
    return { policyId, suppressedDecisions };
  });
}

function buildAddLossAttributionSection(input: {
  conditionalAddPolicyEvaluation: ConditionalAddPolicyEvaluationSection | null;
  observedProvenance: PerformanceReadProvenance;
  simulation: IntegratedSimulationOptions | null;
  stabilityValidation: IntegratedStabilityValidationOptions | null;
  assetEvaluations: ReadonlyMap<SupportedAsset, AssetEvaluation>;
}): AddLossAttributionSection | null {
  if (
    input.conditionalAddPolicyEvaluation?.status !== "AVAILABLE"
    || input.simulation === null
    || input.stabilityValidation === null
    || !CONDITIONAL_ADD_CANDIDATES.every((candidate) =>
      input.simulation?.scenarios.includes(candidate)
    )
    || !input.simulation.scenarios.includes("BASELINE")
    || !input.simulation.scenarios.includes("NO_ADD")
  ) {
    return null;
  }
  const baseCostScenario = input.simulation.costScenarios[0];
  if (baseCostScenario === undefined) return null;

  const attributions: AddLossAttributionResult[] = [];
  const candidateEvaluations: AddPolicyCandidateEvaluationResult[] = [];
  for (const asset of ASSETS) {
    const evaluation = input.assetEvaluations.get(asset);
    if (
      evaluation === undefined
      || evaluation.addDiagnostics.status !== "AVAILABLE"
      || evaluation.policySuppressionEvidence.length !== CONDITIONAL_ADD_CANDIDATES.length
      || evaluation.conditionalCandidates.length !== CONDITIONAL_ADD_CANDIDATES.length
    ) {
      return null;
    }
    const diagnostics = evaluation.addDiagnostics.analyses.find(
      (analysis) => analysis.costScenarioId === baseCostScenario.id,
    );
    if (diagnostics === undefined) return null;
    attributions.push(analyzeAddLossAttribution({
      asset,
      market: getMarketForAsset(asset),
      breakevenToleranceKrw: 1e-9,
      diagnostics: diagnostics.analysis,
      excursions: diagnostics.postDecisionExcursions,
      policySuppressionEvidence: evaluation.policySuppressionEvidence,
    }));
    candidateEvaluations.push(...evaluation.conditionalCandidates);
  }

  const suppressionEvidenceIds = attributions.flatMap((asset) =>
    asset.policySuppressedCohorts.flatMap((policy) => policy.suppressionEvidenceIds)
  );
  return {
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    analysisKind: "ADD_LOSS_ATTRIBUTION_AND_HOLDOUT_HYPOTHESIS",
    selectedFlowAttribution: true,
    causalClaim: false,
    deploymentApproval: false,
    provenance: {
      selectedFlow: { ...input.observedProvenance.filters },
      datasets: ASSETS.map((asset) => input.assetEvaluations.get(asset)!.datasetProvenance).map(
        (dataset) => ({
          asset: dataset.asset,
          market: dataset.market,
          path: dataset.path,
          sha256: dataset.sha256,
          source: dataset.dataset.source,
          historyStartAt: dataset.dataset.historyStartAt,
          endAt: dataset.dataset.endAt,
        }),
      ),
      costScenarioIds: input.simulation.costScenarios.map((cost) => cost.id),
      attributionCostScenarioId: baseCostScenario.id,
      validationWindowIds: input.stabilityValidation.windows.map((window) => window.id),
      candidateIds: [...CONDITIONAL_ADD_CANDIDATES],
      policySuppressionEvidence: ASSETS.map((asset) => ({
        asset,
        policies: input.assetEvaluations.get(asset)!.policySuppressionEvidence.map((policy) => ({
          policyId: policy.policyId,
          suppressedDecisions: policy.suppressedDecisions.map((decision) => ({
            generatedAt: decision.generatedAt,
            evidenceIds: [...decision.evidenceIds],
          })),
        })),
      })),
      suppressionEvidenceIds,
    },
    assets: attributions,
    holdoutHypotheses: classifyIntegratedAddHoldoutHypotheses(attributions, candidateEvaluations),
    warnings: [
      "Selected-flow attribution; not account return.",
      "Descriptive association only; not causal proof.",
      "Future-holdout classification is not deployment approval and does not change strategy or runtime behavior.",
    ],
  };
}

function classifyIntegratedAddHoldoutHypotheses(
  attributions: readonly AddLossAttributionResult[],
  candidateEvaluations: readonly AddPolicyCandidateEvaluationResult[],
): AddHoldoutHypothesisResult {
  return classifyAddHoldoutHypotheses({
    attributions,
    candidateEvaluations,
  });
}

function assessConditionalAddPolicyReadiness(
  simulation: IntegratedSimulationOptions | null,
  stability: IntegratedStabilityValidationOptions | null,
): ConditionalAddPolicyReadiness {
  const requestedCandidates = simulation?.scenarios.filter(
    (scenario): scenario is AddPolicyCandidate => CONDITIONAL_ADD_CANDIDATES.includes(
      scenario as AddPolicyCandidate,
    ),
  ) ?? [];
  if (requestedCandidates.length === 0) {
    return { requested: false, requestedCandidates, reasonCodes: [], configuration: null };
  }

  const reasonCodes: ConditionalAddPolicyUnavailableReason[] = [];
  if (!CONDITIONAL_ADD_CANDIDATES.every((candidate) => requestedCandidates.includes(candidate))) {
    reasonCodes.push("ALL_CONDITIONAL_SCENARIOS_REQUIRED");
  }
  if (!simulation?.scenarios.includes("BASELINE") || !simulation.scenarios.includes("NO_ADD")) {
    reasonCodes.push("BASELINE_AND_NO_ADD_ANCHORS_REQUIRED");
  }
  if (stability === null || stability.windows.length !== 3) {
    reasonCodes.push("EXACTLY_THREE_VALIDATION_WINDOWS_REQUIRED");
  }
  const baseCost = simulation?.costScenarios[0];
  const stressCost = simulation?.costScenarios.find(
    (cell) => cell.id !== baseCost?.id && cell.feeRate === 0.001 && cell.slippageRate === 0.002,
  );
  if (!isValidConditionalBaseCost(baseCost)) reasonCodes.push("BASE_COST_CELL_REQUIRED");
  if (stressCost === undefined) reasonCodes.push("STRESS_COST_CELL_REQUIRED");

  return {
    requested: true,
    requestedCandidates,
    reasonCodes,
    configuration: reasonCodes.length === 0 && stability !== null && baseCost && stressCost
      ? {
          baseCost: { ...baseCost },
          stressCost: { ...stressCost },
          windows: stability.windows.map((window) => ({ ...window })),
          expectedFrameIntervalMs: stability.expectedFrameIntervalMs,
        }
      : null,
  };
}

function isValidConditionalBaseCost(cost: CostScenario | undefined): cost is CostScenario {
  return cost !== undefined
    && cost.id.trim().length > 0
    && cost.feeRate === 0.0005
    && Number.isFinite(cost.slippageRate)
    && cost.slippageRate >= 0
    && cost.slippageRate < 1;
}

function buildConditionalAddPolicySection(
  readiness: ConditionalAddPolicyReadiness,
  stability: IntegratedStabilityValidationOptions | null,
  evaluations: ReadonlyMap<SupportedAsset, AssetEvaluation>,
): ConditionalAddPolicyEvaluationSection | null {
  if (!readiness.requested) return null;
  const common = {
    evidenceKind: "SIMULATED_CONDITIONAL_ADD_POLICY_EVALUATION" as const,
    reasonCodes: [...readiness.reasonCodes],
    requestedCandidates: [...readiness.requestedCandidates],
    requiredCandidates: [...CONDITIONAL_ADD_CANDIDATES],
    requiredAnchors: ["BASELINE", "NO_ADD"] as const,
    windows: stability?.windows.map((window) => ({ ...window })) ?? [],
    deploymentApproval: false as const,
    warning: CONDITIONAL_ADD_WARNING,
  };
  if (readiness.configuration === null) {
    return { ...common, status: "UNAVAILABLE", assets: [] };
  }

  const assets = ASSETS.map((asset): ConditionalAddPolicyAssetSection => {
    const evaluation = evaluations.get(asset);
    if (evaluation === undefined) {
      return {
        asset,
        market: getMarketForAsset(asset),
        status: "DATASET_UNAVAILABLE",
        message: `No immutable local ${asset} dataset was supplied; conditional ADD evaluation was not run.`,
        candidates: [],
      };
    }
    if (evaluation.simulation.status === "DATASET_UNUSABLE") {
      return {
        asset,
        market: getMarketForAsset(asset),
        status: "DATASET_UNUSABLE",
        message: evaluation.simulation.message,
        candidates: [],
      };
    }
    return {
      asset,
      market: getMarketForAsset(asset),
      status: "AVAILABLE",
      datasetSha256: evaluation.datasetProvenance.sha256,
      policySupportCostRole: "BASE",
      candidates: evaluation.conditionalCandidates,
    };
  });
  return { ...common, status: "AVAILABLE", assets };
}

function restrictDatasetToDevelopmentCutoff(
  dataset: ResearchCandleDataset,
): ResearchCandleDataset {
  const cutoff = FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentTo;
  return {
    provenance: { ...dataset.provenance },
    candles: {
      "1h": dataset.candles["1h"].filter((candle) =>
        comparePerformanceTimestamps(candle.closeTime, cutoff) < 0),
      "4h": dataset.candles["4h"].filter((candle) =>
        comparePerformanceTimestamps(candle.closeTime, cutoff) < 0),
      "1d": dataset.candles["1d"].filter((candle) =>
        comparePerformanceTimestamps(candle.closeTime, cutoff) < 0),
    },
  };
}

function buildBroadStrategyHypothesisEvaluation(
  options: IntegratedStrategyEvaluationOptions,
  datasets: ReadonlyMap<SupportedAsset, {
    raw: ResearchCandleDataset;
    development: ResearchCandleDataset;
    options: SimulationAssetOptions;
    noTrade: IndependentNoTradeInput | undefined;
  }>,
  authority: ValidatedFrozenBroadAuthority,
): BroadStrategyHypothesisEvaluationSection {
  if (
    options.broadStrategyHypothesisProfile !== BROAD_STRATEGY_PROFILE
    || options.simulation === null
  ) {
    throw new Error("Broad strategy hypothesis evaluation requires the frozen profile.");
  }
  const metricObservations: StrategyHypothesisMetricObservation[] = [];
  const coverageObservations: StrategyHypothesisCoverageObservation[] = [];
  const supportObservations: StrategyHypothesisSupportObservation[] = [];
  const datasetProvenance: BroadStrategyHypothesisDatasetProvenance[] = [];
  const pathDiagnostics: BroadStrategyPathDiagnostics[] = [];

  for (const asset of ASSETS) {
    const source = datasets.get(asset);
    if (!source) throw new Error(`Frozen broad profile is missing ${asset} dataset evidence.`);
    const market = getMarketForAsset(asset);
    const allFrames = buildPositionGuardBacktestFrames({
      asset,
      market,
      oneHourCandles: source.development.candles["1h"],
      fourHourCandles: source.development.candles["4h"],
      oneDayCandles: source.development.candles["1d"],
    });
    const frames = allFrames.filter((frame) =>
      comparePerformanceTimestamps(
        frame.generatedAt,
        FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentFrom,
      ) >= 0
      && comparePerformanceTimestamps(
        frame.generatedAt,
        FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentTo,
      ) < 0);
    const initialStateFingerprint = sha256Json(source.options.initialState);
    const frameFingerprint = sha256Json(frames);
    datasetProvenance.push({
      asset,
      datasetSha256: source.raw.provenance.sha256,
      initialStateFingerprint,
      frameFingerprint,
      developmentFrameCount: frames.length,
      firstDevelopmentFrameAt: frames[0]?.generatedAt ?? null,
      lastDevelopmentFrameAt: frames.at(-1)?.generatedAt ?? null,
      excludedPostCutoffCandleCount: countCandles(source.raw) - countCandles(source.development),
      noTradeEvidence: source.noTrade === undefined
        ? null
        : { ...source.noTrade.provenance },
      developmentVerifiedRangeCount: source.noTrade === undefined
        ? 0
        : countNoTradeRangesIntersectingWindow(
            source.noTrade.evidence.verifiedNoTradeRanges,
            FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentFrom,
            FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentTo,
          ),
    });

    const paths = buildBroadContinuousPaths({
      asset,
      market,
      initialState: source.options.initialState,
      minimumOrderValueKrw: options.simulation.minimumOrderValueKrw,
      frames,
      costScenarios: authority.costScenarios,
    });
    pathDiagnostics.push(...buildBroadPathDiagnostics({
      asset,
      market,
      dataset: source.development,
      initialState: source.options.initialState,
      frames,
      paths,
      costCells: authority.costCells,
      ...(source.noTrade === undefined
        ? {}
        : { verifiedNoTradeCoverage: source.noTrade.verifiedCoverage }),
    }));
    appendBroadObservations({
      asset,
      initialState: source.options.initialState,
      frames,
      datasetSha256: source.raw.provenance.sha256,
      initialStateFingerprint,
      frameFingerprint,
      paths,
      costCells: authority.costCells,
      independentNoTradeRanges: source.noTrade?.ranges ?? [],
      independentlyVerifiedNoTrade: source.noTrade !== undefined,
      metricObservations,
      coverageObservations,
      supportObservations,
    });
  }

  const evaluation = evaluateStrategyHypotheses({
    manifest: structuredClone(FROZEN_STRATEGY_HYPOTHESIS_MANIFEST),
    candidates: [...FROZEN_STRATEGY_HYPOTHESIS_SCENARIO_ORDER],
    metricObservations,
    coverageObservations,
    supportObservations,
  });
  return {
    profileId: BROAD_STRATEGY_PROFILE,
    readOnly: true,
    deploymentApproval: false,
    developmentCutoffExclusive: FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentTo,
    scenarioMatrix: [...BROAD_STRATEGY_SCENARIOS],
    independentNoTradeProofAvailable: ASSETS.every((asset) => datasets.get(asset)?.noTrade !== undefined),
    datasets: datasetProvenance,
    pathDiagnostics,
    interpretationBoundary: "READ_ONLY_SELECTED_COUNTERFACTUAL_PATHS_NOT_DEPLOYMENT_APPROVAL",
    ...evaluation,
  };
}

type BroadCombinedConservativeHoldoutBundle = {
  evaluation: CombinedConservativeHoldoutResult;
  componentDiagnostics: PerformanceComponentAblationResult;
};

function buildBroadCombinedConservativeHoldoutEvaluation(
  options: IntegratedStrategyEvaluationOptions,
  datasets: ReadonlyMap<SupportedAsset, {
    raw: ResearchCandleDataset;
    development: ResearchCandleDataset;
    options: SimulationAssetOptions;
    noTrade: IndependentNoTradeInput | undefined;
  }>,
  verifyDevelopmentAuthority: (
    observations: readonly BroadShadowDevelopmentAuthorityObservation[],
  ) => void,
  developmentAuthorityVerified: boolean,
  authority: ValidatedFrozenBroadAuthority,
): BroadCombinedConservativeHoldoutBundle {
  const holdout = options.broadStrategyShadowHoldout;
  if (
    holdout === undefined
    || options.broadStrategyHypothesisProfile !== BROAD_STRATEGY_PROFILE
    || options.simulation === null
  ) {
    throw new Error("Combined conservative holdout requires the frozen broad profile and explicit range.");
  }
  const authorityObservations: BroadShadowDevelopmentAuthorityObservation[] = [];
  const builtAssets = ASSETS.map((asset) => {
    const source = datasets.get(asset);
    if (!source || !source.noTrade) {
      throw new Error(`Combined conservative holdout is missing authenticated ${asset} evidence.`);
    }
    if (source.options.initialState.quantity > PERFORMANCE_QUANTITY_TOLERANCE) {
      throw new Error(
        `Combined conservative holdout requires a flat ${asset} development-start state.`,
      );
    }
    if (comparePerformanceTimestamps(holdout.to, source.raw.provenance.endAt) > 0) {
      throw new Error(`${asset} holdout end is beyond the immutable dataset end.`);
    }
    const market = getMarketForAsset(asset);
    const allFrames = buildPositionGuardBacktestFrames({
      asset,
      market,
      oneHourCandles: source.raw.candles["1h"],
      fourHourCandles: source.raw.candles["4h"],
      oneDayCandles: source.raw.candles["1d"],
    });
    const frames = allFrames.filter((frame) =>
      comparePerformanceTimestamps(
        frame.generatedAt,
        FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentFrom,
      ) >= 0
      && comparePerformanceTimestamps(frame.generatedAt, holdout.to) < 0);
    const developmentFrames = frames.filter((frame) =>
      comparePerformanceTimestamps(
        frame.generatedAt,
        FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentTo,
      ) < 0);
    const initialStateFingerprint = sha256Json(source.options.initialState);
    const developmentFrameFingerprint = sha256Json(developmentFrames);
    const replayFrameFingerprint = sha256Json(frames);
    const developmentCadenceFrom = resolveBroadCadenceFrom(
      null,
      FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentFrom,
      developmentFrames[0]?.generatedAt,
    );
    const developmentCadenceComplete = hasCompleteHourlyCadenceForScope({
      frames: developmentFrames,
      verifiedNoTradeRanges: source.noTrade.ranges,
      from: developmentCadenceFrom,
      to: FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentTo,
    });
    const developmentFeatureCoverage = analyzePositionGuardFeatureCoverage({
      dataset: scopeResearchDatasetForFeatureCoverage(source.raw, developmentFrames),
      frames: developmentFrames.map((frame) => ({
        generatedAt: frame.generatedAt,
        latestCloseTime: { ...frame.source.latestCloseTime },
      })),
      requiredLookbackCandles: REQUIRED_COMPLETED_CANDLES,
    });
    authorityObservations.push({
      asset,
      market,
      developmentFrom: FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentFrom,
      developmentTo: FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentTo,
      initialStateFingerprint,
      developmentFrameFingerprint,
      developmentFrameCount: developmentFrames.length,
      firstDevelopmentFrameAt: developmentFrames[0]?.generatedAt ?? null,
      lastDevelopmentFrameAt: developmentFrames.at(-1)?.generatedAt ?? null,
      developmentCadenceComplete,
      featureCoverageStatus: developmentFeatureCoverage.status,
    });
    const datasetFingerprint = sha256Json({
      datasetSha256: source.raw.provenance.sha256,
      noTradeEvidenceSha256: source.noTrade.provenance.sha256,
      holdout,
      initialStateFingerprint,
      developmentFrameFingerprint,
      replayFrameFingerprint,
    });
    const paths = buildBroadContinuousPaths({
      asset,
      market,
      initialState: source.options.initialState,
      minimumOrderValueKrw: options.simulation!.minimumOrderValueKrw,
      frames,
      costScenarios: authority.costScenarios,
    });
    const ablationPaths = buildCombinedConservativeAblationPaths({
      asset,
      market,
      initialState: source.options.initialState,
      minimumOrderValueKrw: options.simulation!.minimumOrderValueKrw,
      frames,
      costScenarios: authority.costScenarios,
    });
    const holdoutFrames = frames.filter((frame) =>
      comparePerformanceTimestamps(frame.generatedAt, holdout.from) >= 0
      && comparePerformanceTimestamps(frame.generatedAt, holdout.to) < 0);
    const holdoutCadenceComplete = hasCompleteHourlyCadenceForScope({
      frames: holdoutFrames,
      verifiedNoTradeRanges: source.noTrade.ranges,
      from: holdout.from,
      to: holdout.to,
    });
    const replayFeatureCoverage = analyzePositionGuardFeatureCoverage({
      dataset: scopeResearchDatasetForFeatureCoverage(source.raw, frames),
      frames: frames.map((frame) => ({
        generatedAt: frame.generatedAt,
        latestCloseTime: { ...frame.source.latestCloseTime },
      })),
      requiredLookbackCandles: REQUIRED_COMPLETED_CANDLES,
    });
    const cadenceComplete = holdoutCadenceComplete
      && replayFeatureCoverage.status === "COMPLETE";
    const carryInStateComplete = developmentAuthorityVerified
      && developmentCadenceComplete
      && developmentFeatureCoverage.status === "COMPLETE";
    const matrix: CombinedConservativeHoldoutMatrixCell[] = [];
    const componentCells: PerformanceComponentAblationCell[] = [];
    for (const timing of BROAD_TIMING_MODELS) {
      for (const cost of authority.costCells) {
        for (const scenario of ["BASELINE", "NO_ADD", "COMBINED_CONSERVATIVE"] as const) {
          const result = paths.get(broadPathKey(timing, cost.id, scenario));
          if (!result) {
            throw new Error(`Missing holdout replay ${asset}:${timing}:${cost.id}:${scenario}.`);
          }
          const metrics = summarizeBroadHoldoutPath(
            result,
            frames,
            source.options.initialState,
            holdout.from,
            holdout.to,
          );
          matrix.push({
            asset,
            market,
            timing,
            cost: cost.id,
            scenario,
            holdoutFrom: holdout.from,
            holdoutTo: holdout.to,
            datasetChecksum: source.raw.provenance.sha256,
            noTradeEvidenceChecksum: source.noTrade.provenance.sha256,
            datasetFingerprint,
            initialStateFingerprint,
            developmentFrameFingerprint,
            replayFrameFingerprint,
            netReturnPct: metrics.netReturnPct,
            maxDrawdownPct: metrics.maxDrawdownPct,
            turnoverKrw: metrics.turnoverKrw,
            feesKrw: metrics.feesKrw,
            completedEpisodeCount: metrics.completedEpisodeCount,
            coverage: {
              cadenceComplete,
              independentlyVerifiedNoTrade: true,
              lifecycleComplete: result.matchResult.unmatchedSells.length === 0
                && result.matchResult.attributionFailures.length === 0,
              feeComplete: result.diagnostics.combined.feeCompleteness === "COMPLETE",
              finiteMetricsComplete: hasFiniteReplayMetrics(result),
              carryInStateComplete,
            },
          });
        }
        const reference = paths.get(broadPathKey(
          timing,
          cost.id,
          "COMBINED_CONSERVATIVE",
        ));
        if (!reference) {
          throw new Error(
            `Missing holdout replay ${asset}:${timing}:${cost.id}:COMBINED_CONSERVATIVE.`,
          );
        }
        const referenceMetrics = summarizeBroadHoldoutPath(
          reference,
          frames,
          source.options.initialState,
          holdout.from,
          holdout.to,
        );
        const provenance: HoldoutEpisodePathProvenance = {
          authorityId: "COMBINED_CONSERVATIVE_ABLATION_V1",
          asset,
          market,
          timingModel: timing,
          costCellId: cost.id,
          costRole: cost.role,
          feeRate: cost.feeRate,
          slippageRate: cost.slippageRate,
          holdoutFrom: holdout.from,
          holdoutTo: holdout.to,
          datasetSha256: source.raw.provenance.sha256,
          datasetFingerprint,
          initialStateFingerprint,
          developmentFrameFingerprint,
          replayFrameFingerprint,
        };
        for (const scenario of FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER) {
          const ablation = ablationPaths.get(broadPathKey(timing, cost.id, scenario));
          if (!ablation) {
            throw new Error(`Missing ablation replay ${asset}:${timing}:${cost.id}:${scenario}.`);
          }
          const ablationMetrics = summarizeBroadHoldoutPath(
            ablation,
            frames,
            source.options.initialState,
            holdout.from,
            holdout.to,
          );
          componentCells.push({
            asset,
            market,
            timing,
            cost: cost.id,
            holdoutFrom: holdout.from,
            holdoutTo: holdout.to,
            reference: toPerformanceComponentAblationMetrics(
              "COMBINED_CONSERVATIVE",
              referenceMetrics,
            ),
            ablation: toPerformanceComponentAblationMetrics(scenario, ablationMetrics),
            coverage: {
              cadenceComplete: holdoutCadenceComplete,
              featureCoverageComplete: replayFeatureCoverage.status === "COMPLETE",
              carryInStateComplete,
              referenceLifecycleComplete: hasCompleteReplayLifecycle(reference),
              ablationLifecycleComplete: hasCompleteReplayLifecycle(ablation),
              referenceFeeComplete:
                reference.diagnostics.combined.feeCompleteness === "COMPLETE",
              ablationFeeComplete:
                ablation.diagnostics.combined.feeCompleteness === "COMPLETE",
              referenceFiniteMetricsComplete: hasFiniteReplayMetrics(reference),
              ablationFiniteMetricsComplete: hasFiniteReplayMetrics(ablation),
            },
            attribution: analyzeHoldoutEpisodeAttribution({
              reference,
              ablation,
              asset,
              market,
              timingModel: timing,
              cost: {
                id: cost.id,
                role: cost.role,
                feeRate: cost.feeRate,
                slippageRate: cost.slippageRate,
              },
              referenceProvenance: provenance,
              ablationProvenance: provenance,
              from: holdout.from,
              to: holdout.to,
            }),
          });
        }
      }
    }
    return {
      holdoutAsset: {
        asset,
        market,
        authorityVersion: developmentAuthorityVerified
          ? BROAD_COMBINED_SHADOW_AUTHORITY.version
          : UNVERIFIED_TEST_AUTHORITY_VERSION,
        authorityFrozenAt: BROAD_COMBINED_SHADOW_AUTHORITY.frozenAt,
        holdout: { ...holdout },
        dataset: {
          asset,
          market,
          collectedAt: source.raw.provenance.collectedAt,
          endAt: source.raw.provenance.endAt,
          checksum: source.raw.provenance.sha256,
          fingerprint: datasetFingerprint,
          holdoutFrom: holdout.from,
          holdoutTo: holdout.to,
          noTradeEvidenceChecksum: source.noTrade.provenance.sha256,
          initialStateFingerprint,
          developmentFrameFingerprint,
          replayFrameFingerprint,
        },
        matrix,
      },
      componentAsset: {
        asset,
        market,
        holdoutFrom: holdout.from,
        holdoutTo: holdout.to,
        cells: componentCells,
      },
    };
  });
  verifyDevelopmentAuthority(authorityObservations);
  const evaluation = evaluateCombinedConservativeHoldout({
    authority: {
      version: developmentAuthorityVerified
        ? BROAD_COMBINED_SHADOW_AUTHORITY.version
        : UNVERIFIED_TEST_AUTHORITY_VERSION,
      frozenAt: BROAD_COMBINED_SHADOW_AUTHORITY.frozenAt,
      developmentCutoff: FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentTo,
    },
    policy: {
      candidate: "COMBINED_CONSERVATIVE",
      minimumCompletedEpisodes: BROAD_COMBINED_SHADOW_AUTHORITY.minimumCompletedEpisodes,
      comparisonTolerancePercentagePoints:
        BROAD_COMBINED_SHADOW_AUTHORITY.comparisonTolerancePercentagePoints,
      comparisonToleranceKrw: BROAD_COMBINED_SHADOW_AUTHORITY.comparisonToleranceKrw,
    },
    assets: builtAssets.map((asset) => asset.holdoutAsset),
  });
  const componentDiagnostics = evaluatePerformanceComponentAblation({
    authorityId: "COMBINED_CONSERVATIVE_ABLATION_V1",
    assets: builtAssets.map((asset) => asset.componentAsset),
  });
  return { evaluation, componentDiagnostics };
}

type BroadContinuousPathMap = Map<string, CounterfactualScenarioResult>;

type BroadHoldoutPathMetrics = {
  netReturnPct: number;
  maxDrawdownPct: number;
  turnoverKrw: number;
  feesKrw: number;
  completedEpisodeCount: number;
};

function summarizeBroadHoldoutPath(
  result: CounterfactualScenarioResult,
  frames: readonly ReturnType<typeof buildPositionGuardBacktestFrames>[number][],
  initialState: SimulationInitialState,
  from: string,
  to: string,
): BroadHoldoutPathMetrics {
  const returnAndDrawdown = summarizeBroadReplayScope(
    result,
    frames,
    initialState,
    from,
    to,
    false,
  );
  const scopedRows = result.legacyBacktest.result.frames.filter((row) =>
    comparePerformanceTimestamps(row.generatedAt, from) >= 0
    && comparePerformanceTimestamps(row.generatedAt, to) < 0);
  return {
    ...returnAndDrawdown,
    turnoverKrw: scopedRows.reduce(
      (sum, row) => sum + (row.trade?.grossNotionalKrw ?? 0),
      0,
    ),
    feesKrw: scopedRows.reduce((sum, row) => sum + (row.trade?.feeKrw ?? 0), 0),
    completedEpisodeCount: completedEpisodesInRange(result, from, to).length,
  };
}

function toPerformanceComponentAblationMetrics(
  scenario: PerformanceComponentAblationMetrics["scenario"],
  metrics: BroadHoldoutPathMetrics,
): PerformanceComponentAblationMetrics {
  return { scenario, ...metrics };
}

function buildBroadPathDiagnostics(input: {
  asset: SupportedAsset;
  market: SupportedMarket;
  dataset: ResearchCandleDataset;
  verifiedNoTradeCoverage?: VerifiedNoTradeCoverage;
  initialState: SimulationInitialState;
  frames: readonly ReturnType<typeof buildPositionGuardBacktestFrames>[number][];
  paths: BroadContinuousPathMap;
  costCells: readonly ValidatedFrozenBroadCostCell[];
}): BroadStrategyPathDiagnostics[] {
  const diagnostics: BroadStrategyPathDiagnostics[] = [];
  for (const timingModel of BROAD_TIMING_MODELS) {
    for (const costCell of input.costCells) {
      for (const scenario of BROAD_STRATEGY_SCENARIOS) {
        const result = input.paths.get(broadPathKey(timingModel, costCell.id, scenario));
        if (!result) continue;
        const interventions = result.legacyBacktest.result.frames
          .map((frame) => frame.researchIntervention)
          .filter((item): item is NonNullable<typeof item> => item !== null && item !== undefined);
        const outcomes = { ALLOW: 0, SUPPRESS: 0, OVERRIDE_EXIT: 0 };
        const reasons: Record<string, number> = {};
        for (const intervention of interventions) {
          outcomes[intervention.outcome] += 1;
          reasons[intervention.reason] = (reasons[intervention.reason] ?? 0) + 1;
        }
        const excursionAnalysis = analyzePerformanceExcursions({
          scenario,
          dataset: input.dataset,
          fills: result.fills,
          matchResult: result.matchResult,
          ...(input.verifiedNoTradeCoverage === undefined
            ? {}
            : { verifiedNoTradeCoverage: input.verifiedNoTradeCoverage }),
        });
        diagnostics.push({
          asset: input.asset,
          scenario,
          timingModel,
          costCellId: costCell.id,
          backtestMetrics: { ...result.legacyBacktest.result.metrics },
          fifoAndEpisodeDiagnostics: result.diagnostics,
          regimeAnalysis: analyzePerformanceRegimes({
            asset: input.asset,
            market: input.market,
            scenario,
            frames: toExecutedActionDiagnosticFrames(result),
            fills: result.fills,
            matchResult: result.matchResult,
            breakevenToleranceKrw: 1e-9,
          }),
          excursionAnalysis,
          windows: buildBroadWindowDiagnostics(
            result,
            excursionAnalysis,
            input.frames,
            input.initialState,
          ),
          interventions: {
            total: interventions.length,
            outcomes,
            reasons,
          },
        });
      }
    }
  }
  return diagnostics;
}

function buildBroadWindowDiagnostics(
  result: CounterfactualScenarioResult,
  excursionAnalysis: PerformanceExcursionResult,
  frames: readonly ReturnType<typeof buildPositionGuardBacktestFrames>[number][],
  initialState: SimulationInitialState,
): BroadStrategyWindowDiagnostics[] {
  return FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.windows.map((window) => {
    const frameCount = result.legacyBacktest.result.frames.filter((frame) =>
      comparePerformanceTimestamps(frame.generatedAt, window.from) >= 0
      && comparePerformanceTimestamps(frame.generatedAt, window.to) < 0).length;
    const completedEpisodes = completedEpisodesInRange(result, window.from, window.to);
    const sliceIds = new Set(completedEpisodes.flatMap((episode) => episode.realizationSliceIds));
    const episodeIds = new Set(completedEpisodes.map((episode) => episode.id));
    return {
      windowId: window.id,
      from: window.from,
      to: window.to,
      frameCount,
      returnAndDrawdown: frameCount === 0
        ? { status: "UNAVAILABLE", reason: "NO_FRAMES_IN_WINDOW" }
        : {
            status: "AVAILABLE",
            ...summarizeBroadReplayScope(
              result,
              frames,
              initialState,
              window.from,
              window.to,
              false,
            ),
          },
      completedEpisodes,
      realizationSlices: result.matchResult.realizationSlices.filter((slice) =>
        sliceIds.has(slice.id)),
      fills: result.fills.filter((fill) =>
        comparePerformanceTimestamps(fill.filledAt, window.from) >= 0
        && comparePerformanceTimestamps(fill.filledAt, window.to) < 0),
      excursionEpisodes: excursionAnalysis.episodes.filter((episode) =>
        episodeIds.has(episode.episodeId)),
    };
  });
}

function toExecutedActionDiagnosticFrames(
  result: CounterfactualScenarioResult,
): PositionGuardBacktestFrameResult[] {
  return result.legacyBacktest.result.frames.map((frame) => {
    if (!frame.trade || frame.decision.action === frame.trade.action) return frame;
    return {
      ...frame,
      decision: {
        ...frame.decision,
        action: frame.trade.action,
      },
    };
  });
}

function buildBroadContinuousPaths(input: {
  asset: SupportedAsset;
  market: SupportedMarket;
  initialState: SimulationInitialState;
  minimumOrderValueKrw: number;
  frames: readonly ReturnType<typeof buildPositionGuardBacktestFrames>[number][];
  costScenarios: readonly CostScenario[];
}): BroadContinuousPathMap {
  const paths: BroadContinuousPathMap = new Map();
  const carryInIncomplete = input.initialState.quantity > PERFORMANCE_QUANTITY_TOLERANCE;
  for (const timingModel of BROAD_TIMING_MODELS) {
    for (const costScenario of input.costScenarios) {
      for (const scenario of BROAD_STRATEGY_SCENARIOS) {
        if (
          carryInIncomplete
          && (scenario === "ADD_LIMITED"
            || scenario === "COOLDOWN_CONTROL"
            || scenario === "COMBINED_CONSERVATIVE")
        ) {
          continue;
        }
        const [result] = runCounterfactualScenarios({
          asset: input.asset,
          market: input.market,
          initialCashKrw: input.initialState.cashKrw,
          initialQuantity: input.initialState.quantity,
          initialAverageEntryPrice: input.initialState.averageEntryPriceKrw,
          frames: input.frames,
          scenarios: [scenario],
          diagnosticPolicy: { breakevenToleranceKrw: 1e-9 },
          execution: {
            feeRate: costScenario.feeRate,
            slippageRate: costScenario.slippageRate,
            minimumTradeValueKrw: input.minimumOrderValueKrw,
          },
          executionTimingModel: timingModel,
        });
        if (!result) throw new Error(`Missing broad replay result for ${scenario}.`);
        paths.set(broadPathKey(timingModel, costScenario.id, scenario), result);
      }
    }
  }
  return paths;
}

function buildCombinedConservativeAblationPaths(input: {
  asset: SupportedAsset;
  market: SupportedMarket;
  initialState: SimulationInitialState;
  minimumOrderValueKrw: number;
  frames: readonly ReturnType<typeof buildPositionGuardBacktestFrames>[number][];
  costScenarios: readonly CostScenario[];
}): BroadContinuousPathMap {
  const paths: BroadContinuousPathMap = new Map();
  for (const timingModel of BROAD_TIMING_MODELS) {
    for (const costScenario of input.costScenarios) {
      for (const scenario of FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER) {
        const [result] = runCounterfactualScenarios({
          asset: input.asset,
          market: input.market,
          initialCashKrw: input.initialState.cashKrw,
          initialQuantity: input.initialState.quantity,
          initialAverageEntryPrice: input.initialState.averageEntryPriceKrw,
          frames: input.frames,
          scenarios: [scenario],
          diagnosticPolicy: { breakevenToleranceKrw: 1e-9 },
          execution: {
            feeRate: costScenario.feeRate,
            slippageRate: costScenario.slippageRate,
            minimumTradeValueKrw: input.minimumOrderValueKrw,
          },
          executionTimingModel: timingModel,
        });
        if (!result) throw new Error(`Missing ablation replay result for ${scenario}.`);
        paths.set(broadPathKey(timingModel, costScenario.id, scenario), result);
      }
    }
  }
  return paths;
}

function appendBroadObservations(input: {
  asset: SupportedAsset;
  initialState: SimulationInitialState;
  frames: readonly ReturnType<typeof buildPositionGuardBacktestFrames>[number][];
  independentNoTradeRanges: readonly CandleCoverageGap[];
  independentlyVerifiedNoTrade: boolean;
  datasetSha256: string;
  initialStateFingerprint: string;
  frameFingerprint: string;
  paths: BroadContinuousPathMap;
  costCells: readonly ValidatedFrozenBroadCostCell[];
  metricObservations: StrategyHypothesisMetricObservation[];
  coverageObservations: StrategyHypothesisCoverageObservation[];
  supportObservations: StrategyHypothesisSupportObservation[];
}): void {
  const flatAtDevelopmentStart =
    input.initialState.quantity <= PERFORMANCE_QUANTITY_TOLERANCE;
  const scopes = [
    { windowId: null, from: FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentFrom,
      to: FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentTo },
    ...FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.windows.map((window) => ({
      windowId: window.id,
      from: window.from,
      to: window.to,
    })),
  ] as const;
  for (const candidate of FROZEN_STRATEGY_HYPOTHESIS_SCENARIO_ORDER) {
    const carryInStateComplete = flatAtDevelopmentStart
      || (candidate !== "ADD_LIMITED"
        && candidate !== "COOLDOWN_CONTROL"
        && candidate !== "COMBINED_CONSERVATIVE");
    for (const timingModel of BROAD_TIMING_MODELS) {
      const baseCandidate = input.paths.get(broadPathKey(timingModel, "BASE", candidate));
      for (const scope of scopes) {
        const scopeFrames = input.frames.filter((frame) =>
          comparePerformanceTimestamps(frame.generatedAt, scope.from) >= 0
          && comparePerformanceTimestamps(frame.generatedAt, scope.to) < 0);
        const candidateLifecycleComplete = baseCandidate !== undefined
          && baseCandidate.matchResult.unmatchedSells.length === 0
          && baseCandidate.matchResult.attributionFailures.length === 0;
        const candidateFeeComplete = baseCandidate?.diagnostics.combined.feeCompleteness === "COMPLETE";
        const firstReplayFrameAt = input.frames[0]?.generatedAt;
        const cadenceFrom = resolveBroadCadenceFrom(
          scope.windowId,
          scope.from,
          firstReplayFrameAt,
        );
        coverageObservationsPush(input.coverageObservations, {
          asset: input.asset,
          candidate,
          timingModel,
          scope: scope.windowId === null ? "FULL_PATH" : "WINDOW",
          windowId: scope.windowId,
          cadenceComplete: hasCompleteHourlyCadenceForScope({
            frames: scopeFrames,
            verifiedNoTradeRanges: input.independentNoTradeRanges,
            from: cadenceFrom,
            to: scope.to,
          }),
          independentlyVerifiedNoTrade: input.independentlyVerifiedNoTrade,
          lifecycleComplete: candidateLifecycleComplete,
          feeComplete: candidateFeeComplete,
          finiteMetricsComplete: baseCandidate !== undefined
            && hasFiniteReplayMetrics(baseCandidate),
          carryInStateComplete,
        });
        const episodes = baseCandidate === undefined
          ? []
          : completedEpisodesInRange(baseCandidate, scope.from, scope.to);
        supportObservationsPush(input.supportObservations, {
          asset: input.asset,
          candidate,
          timingModel,
          scope: scope.windowId === null ? "FULL_PATH" : "WINDOW",
          windowId: scope.windowId,
          completedEpisodeCount: episodes.length,
          policyExposedCompletedEpisodeCount: countPolicyExposedEpisodes(baseCandidate, episodes),
        });
        if (scopeFrames.length === 0) continue;
        for (const cost of input.costCells) {
          for (const scenario of ["BASELINE", "NO_ADD", candidate] as const) {
            const result = input.paths.get(broadPathKey(timingModel, cost.id, scenario));
            if (!result) continue;
            const metrics = summarizeBroadReplayScope(
              result,
              input.frames,
              input.initialState,
              scope.from,
              scope.to,
              scope.windowId === null,
            );
            input.metricObservations.push({
              asset: input.asset,
              candidate,
              scenario,
              timingModel,
              datasetSha256: input.datasetSha256,
              initialStateFingerprint: input.initialStateFingerprint,
              frameFingerprint: input.frameFingerprint,
              costCellId: cost.id,
              costRole: cost.role,
              scope: scope.windowId === null ? "FULL_PATH" : "WINDOW",
              windowId: scope.windowId,
              netReturnPct: metrics.netReturnPct,
              maxDrawdownPct: metrics.maxDrawdownPct,
            });
          }
        }
      }
    }
  }
}

function coverageObservationsPush(
  target: StrategyHypothesisCoverageObservation[],
  value: StrategyHypothesisCoverageObservation,
): void {
  target.push(value);
}

function supportObservationsPush(
  target: StrategyHypothesisSupportObservation[],
  value: StrategyHypothesisSupportObservation,
): void {
  target.push(value);
}

function summarizeBroadReplayScope(
  result: CounterfactualScenarioResult,
  frames: readonly ReturnType<typeof buildPositionGuardBacktestFrames>[number][],
  initialState: SimulationInitialState,
  from: string,
  to: string,
  fullPath: boolean,
): { netReturnPct: number; maxDrawdownPct: number } {
  if (fullPath) {
    return {
      netReturnPct: result.legacyBacktest.result.metrics.totalReturnPct,
      maxDrawdownPct: result.legacyBacktest.result.metrics.maxDrawdownPct,
    };
  }
  const rows = result.legacyBacktest.result.frames;
  const prior = rows.filter((row) => comparePerformanceTimestamps(row.generatedAt, from) < 0).at(-1);
  const scoped = rows.filter((row) =>
    comparePerformanceTimestamps(row.generatedAt, from) >= 0
    && comparePerformanceTimestamps(row.generatedAt, to) < 0);
  const firstPrice = frames[0]?.analysis.currentPrice ?? 0;
  const initialEquity = initialState.cashKrw + initialState.quantity * firstPrice;
  const openingEquity = prior?.equityKrw ?? initialEquity;
  let peak = openingEquity;
  let maxDrawdownPct = 0;
  for (const row of scoped) {
    peak = Math.max(peak, row.equityKrw);
    const drawdown = peak > 0 ? (peak - row.equityKrw) / peak : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdown);
  }
  const closingEquity = scoped.at(-1)?.equityKrw ?? openingEquity;
  return {
    netReturnPct: openingEquity > 0 ? (closingEquity - openingEquity) / openingEquity : 0,
    maxDrawdownPct,
  };
}

function completedEpisodesInRange(
  result: CounterfactualScenarioResult,
  from: string,
  to: string,
): Array<CounterfactualScenarioResult["matchResult"]["episodes"][number] & { closedAt: string }> {
  return result.matchResult.episodes.filter((episode): episode is typeof episode & { closedAt: string } =>
    episode.status === "COMPLETED"
    && episode.closedAt !== null
    && comparePerformanceTimestamps(episode.closedAt, from) >= 0
    && comparePerformanceTimestamps(episode.closedAt, to) < 0);
}

function countPolicyExposedEpisodes(
  result: CounterfactualScenarioResult | undefined,
  episodes: readonly (CounterfactualScenarioResult["matchResult"]["episodes"][number] & {
    closedAt: string;
  })[],
): number {
  if (!result) return 0;
  const exposedFillIds = new Set(
    (result.modeledFillAttributions ?? [])
      .filter((attribution) => attribution.intervention !== null)
      .map((attribution) => attribution.fillId),
  );
  const interventionInstants = result.legacyBacktest.result.frames
    .filter((frame) => frame.researchIntervention !== null
      && frame.researchIntervention !== undefined)
    .map((frame) => frame.generatedAt);
  return episodes.filter((episode) => {
    if ([...episode.entryFillIds, ...episode.exitFillIds]
      .some((fillId) => exposedFillIds.has(fillId))) return true;
    return interventionInstants.some((instant) =>
      comparePerformanceTimestamps(instant, episode.openedAt) >= 0
      && comparePerformanceTimestamps(instant, episode.closedAt) < 0);
  }).length;
}

export function hasCompleteHourlyCadenceForScope(input: {
  frames: readonly { generatedAt: string }[];
  verifiedNoTradeRanges: readonly CandleCoverageGap[];
  from: string;
  to: string;
}): boolean {
  const hour = 3_600_000_000_000n;
  const from = parsePerformanceTimestamp(input.from);
  const to = parsePerformanceTimestamp(input.to);
  if (!from || !to || to.epochNanoseconds <= from.epochNanoseconds) return false;
  const duration = to.epochNanoseconds - from.epochNanoseconds;
  if (duration % hour !== 0n) return false;
  const observed = new Set<string>();
  for (const frame of input.frames) {
    const instant = parsePerformanceTimestamp(frame.generatedAt);
    if (!instant) return false;
    const offset = instant.epochNanoseconds - from.epochNanoseconds;
    if (offset < 0n || instant.epochNanoseconds >= to.epochNanoseconds || offset % hour !== 0n) {
      return false;
    }
    const key = instant.epochNanoseconds.toString();
    if (observed.has(key)) return false;
    observed.add(key);
  }
  const parsedRanges = input.verifiedNoTradeRanges.map((range) => {
    const first = parsePerformanceTimestamp(range.firstMissingCloseTime);
    const last = parsePerformanceTimestamp(range.lastMissingCloseTime);
    if (!first || !last) return null;
    return {
      first: first.epochNanoseconds,
      last: last.epochNanoseconds,
    };
  });
  if (parsedRanges.some((range) => range === null)) return false;
  for (
    let expectedClose = from.epochNanoseconds;
    expectedClose < to.epochNanoseconds;
    expectedClose += hour
  ) {
    if (observed.has(expectedClose.toString())) continue;
    const verified = parsedRanges.some((range) =>
      range !== null && expectedClose >= range.first && expectedClose <= range.last);
    if (!verified) return false;
  }
  return true;
}

export function resolveBroadCadenceFrom(
  windowId: string | null,
  scopeFrom: string,
  firstReplayFrameAt: string | undefined,
): string {
  if (
    windowId === null
    && firstReplayFrameAt !== undefined
    && comparePerformanceTimestamps(firstReplayFrameAt, scopeFrom) > 0
  ) {
    return firstReplayFrameAt;
  }
  return scopeFrom;
}

function countNoTradeRangesIntersectingWindow(
  ranges: readonly ResearchNoTradeRange[],
  from: string,
  to: string,
): number {
  const parsedFrom = parsePerformanceTimestamp(from);
  const parsedTo = parsePerformanceTimestamp(to);
  if (!parsedFrom || !parsedTo) {
    throw new Error("No-trade provenance window requires valid timestamps.");
  }
  return ranges.filter((range) => {
    const parsedRangeFrom = parsePerformanceTimestamp(range.from);
    const parsedRangeTo = parsePerformanceTimestamp(range.to);
    if (!parsedRangeFrom || !parsedRangeTo) {
      throw new Error("No-trade provenance range requires valid timestamps.");
    }
    return parsedRangeFrom.epochNanoseconds < parsedTo.epochNanoseconds
      && parsedRangeTo.epochNanoseconds > parsedFrom.epochNanoseconds;
  }).length;
}

function hasFiniteReplayMetrics(result: CounterfactualScenarioResult): boolean {
  const metrics = result.legacyBacktest.result.metrics;
  return [
    metrics.totalReturnPct,
    metrics.maxDrawdownPct,
    metrics.finalEquityKrw,
    metrics.realizedPnlKrw,
    metrics.turnoverKrw,
    metrics.feesKrw,
  ].every(Number.isFinite);
}

function hasCompleteReplayLifecycle(result: CounterfactualScenarioResult): boolean {
  return result.matchResult.unmatchedSells.length === 0
    && result.matchResult.attributionFailures.length === 0;
}

function broadPathKey(
  timingModel: StrategyHypothesisTimingModel,
  costCellId: string,
  scenario: CounterfactualScenario,
): string {
  return `${timingModel}:${costCellId}:${scenario}`;
}

function countCandles(dataset: ResearchCandleDataset): number {
  return dataset.candles["1h"].length
    + dataset.candles["4h"].length
    + dataset.candles["1d"].length;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readResearchNoTradeEvidence(evidencePath: string): Promise<ResearchNoTradeEvidence> {
  const bytes = await readFile(evidencePath);
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Research no-trade evidence file must contain valid UTF-8 JSON.");
  }
  return parseResearchNoTradeEvidence(json);
}

function buildIndependentNoTradeInput(
  evidencePath: string,
  dataset: ResearchCandleDataset,
  evidence: ResearchNoTradeEvidence,
): IndependentNoTradeInput {
  const coverage = classifyIndependentNoTradeCoverage(dataset, evidence);
  if (coverage.status === "UNVERIFIED_SPARSE") {
    throw new Error(
      `Research no-trade evidence leaves ${coverage.uncoveredRanges.length} parent range(s) unverified.`,
    );
  }
  const ranges = toCandleCoverageGaps(
    evidence.verifiedNoTradeRanges,
    dataset.provenance.historyStartAt,
    dataset.provenance.endAt,
  );
  const verifiedCoverage = createVerifiedNoTradeCoverageFromRanges({
    sourceBoundary: {
      historyStartAt: dataset.provenance.historyStartAt,
      endAt: dataset.provenance.endAt,
    },
    observedIntervals: dataset.candles["1h"].map((candle) => ({
      openTime: candle.openTime,
      closeTime: candle.closeTime,
    })),
    verifiedNoTradeRanges: ranges,
  });
  return {
    evidence,
    coverage,
    ranges,
    verifiedCoverage,
    provenance: {
      path: evidencePath,
      sha256: evidence.provenance.sha256,
      parentDatasetSha256: evidence.provenance.parentDatasetSha256,
      source: evidence.provenance.source,
      collectedAt: evidence.provenance.collectedAt,
      coverageStatus: coverage.status,
      verifiedRangeCount: evidence.verifiedNoTradeRanges.length,
      missingRangeCount: coverage.missingRanges.length,
      uncoveredRangeCount: coverage.uncoveredRanges.length,
    },
  };
}

function toCandleCoverageGaps(
  sourceRanges: readonly ResearchNoTradeRange[],
  historyStartAt: string,
  endAt: string,
): CandleCoverageGap[] {
  const hour = 3_600_000_000_000n;
  const historyStart = requirePerformanceTimestamp(
    historyStartAt,
    "no-trade historyStartAt",
  ).epochNanoseconds;
  const end = requirePerformanceTimestamp(endAt, "no-trade endAt").epochNanoseconds;
  const grouped: Array<{ from: bigint; to: bigint }> = [];
  for (const [index, range] of sourceRanges.entries()) {
    const from = requirePerformanceTimestamp(
      range.from,
      `no-trade range ${index} from`,
    ).epochNanoseconds;
    const to = requirePerformanceTimestamp(
      range.to,
      `no-trade range ${index} to`,
    ).epochNanoseconds;
    const previous = grouped.at(-1);
    if (previous !== undefined && previous.to === from) {
      previous.to = to;
    } else {
      grouped.push({ from, to });
    }
  }
  return grouped.map((range) => {
    const count = Number((range.to - range.from) / hour);
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error("Research no-trade evidence range must span positive whole hours.");
    }
    return {
      firstMissingCloseTime: formatCadenceInstant(range.from + hour),
      lastMissingCloseTime: formatCadenceInstant(range.to),
      missingCandleCount: count,
      previousObservedCloseTime: range.from > historyStart
        ? formatCadenceInstant(range.from)
        : null,
      nextObservedCloseTime: range.to + hour <= end
        ? formatCadenceInstant(range.to + hour)
        : null,
    };
  });
}

function evaluateAsset(
  asset: SupportedAsset,
  assetOptions: SimulationAssetOptions,
  dataset: ResearchCandleDataset,
  simulationOptions: IntegratedSimulationOptions,
  stabilityOptions: IntegratedStabilityValidationOptions | null,
  conditionalConfiguration: ConditionalAddPolicyConfiguration | null,
  independentNoTrade: IndependentNoTradeInput | undefined,
): AssetEvaluation {
  const market = getMarketForAsset(asset);
  if (dataset.provenance.asset !== asset) {
    throw new Error(`Local dataset asset ${dataset.provenance.asset} does not match CLI asset ${asset}.`);
  }
  if (dataset.provenance.market !== market) {
    throw new Error(`Local dataset market ${dataset.provenance.market} does not match CLI market ${market}.`);
  }
  const frames = buildPositionGuardBacktestFrames({
    asset,
    market,
    oneHourCandles: dataset.candles["1h"],
    fourHourCandles: dataset.candles["4h"],
    oneDayCandles: dataset.candles["1d"],
  });
  const featureCoverage = conditionalConfiguration === null
    ? null
    : analyzePositionGuardFeatureCoverage({
        dataset,
        frames: frames.map((frame) => ({
          generatedAt: frame.generatedAt,
          latestCloseTime: { ...frame.source.latestCloseTime },
        })),
        requiredLookbackCandles: REQUIRED_COMPLETED_CANDLES,
      });
  const datasetProvenance: IntegratedDatasetProvenance = {
    asset,
    market,
    path: assetOptions.datasetPath,
    sha256: dataset.provenance.sha256,
    dataset: { ...dataset.provenance },
    initialState: { ...assetOptions.initialState },
    frameCount: frames.length,
    ...(featureCoverage === null ? {} : { featureCoverage }),
    ...(independentNoTrade === undefined
      ? {}
      : { noTradeEvidence: { ...independentNoTrade.provenance } }),
  };
  if (frames.length === 0) {
    return buildUnusableAssetEvaluation(assetOptions, dataset, datasetProvenance);
  }
  const sensitivity = runCostSensitivity({
    asset,
    market,
    initialCashKrw: assetOptions.initialState.cashKrw,
    initialQuantity: assetOptions.initialState.quantity,
    initialAverageEntryPrice: assetOptions.initialState.averageEntryPriceKrw,
    frames,
    scenarios: simulationOptions.scenarios,
    diagnosticPolicy: { breakevenToleranceKrw: 1e-9 },
    minimumTradeValueKrw: simulationOptions.minimumOrderValueKrw,
    costScenarios: simulationOptions.costScenarios,
  });
  const baseCost = simulationOptions.costScenarios[0];
  if (!baseCost) throw new Error("At least one cost scenario is required.");
  const baseCells = sensitivity.cells.filter((cell) => cell.costScenario.id === baseCost.id);
  const scenarios = baseCells.map((cell): CounterfactualScenarioSummary => ({
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    scenario: cell.scenario,
    executionPolicyId: cell.counterfactual.executionPolicy?.id ?? null,
    costScenario: { ...cell.costScenario },
    initialState: { ...assetOptions.initialState },
    finalState: { ...cell.counterfactual.legacyBacktest.result.finalState },
    frameCount: frames.length,
    fillCount: cell.counterfactual.fills.length,
    completedEpisodeCount: cell.counterfactual.diagnostics.combined.completedEpisodeCount,
    sampleSupportStatus: classifySampleSupport(
      "COMPLETED_EPISODES",
      cell.counterfactual.diagnostics.combined.completedEpisodeCount,
    ).status,
    metrics: { ...cell.counterfactual.legacyBacktest.result.metrics },
    fifoDiagnostics: cell.counterfactual.diagnostics.combined,
  }));
  const costs: AvailableCostAssetSection = {
    asset,
    market,
    status: "AVAILABLE",
    evidenceKind: "MODELED_COST_SCENARIO",
    datasetSha256: dataset.provenance.sha256,
    cells: sensitivity.cells.map((cell) => summarizeCostCell(cell)),
  };
  const stability: AvailableStabilityAssetSection = {
    asset,
    market,
    status: "AVAILABLE",
    evidenceKind: "SIMULATED_COUNTERFACTUAL_STABILITY",
    analyses: stabilityOptions === null
      ? []
      : simulationOptions.costScenarios.map((costScenario) => {
          const paths = sensitivity.cells
            .filter((cell) => cell.costScenario.id === costScenario.id)
            .filter(isLegacyStabilityCell)
            .map((cell) => toStabilityPath(cell, assetOptions.initialState, frames));
          return validatePerformanceStability({
            asset,
            market,
            costScenarioId: costScenario.id,
            expectedFrameIntervalMs: stabilityOptions.expectedFrameIntervalMs,
            comparisonTolerancePercentagePoints:
              stabilityOptions.comparisonTolerancePercentagePoints,
            minimumEvaluableWindows: stabilityOptions.minimumEvaluableWindows,
            windows: stabilityOptions.windows.map((window) => ({ ...window })),
            paths,
          });
        }),
  };
  const regimeEntries: RegimeAnalysisEntry[] = [];
  const excursionEntries: ExcursionAnalysisEntry[] = [];
  const addDiagnosticEntries: AddDecisionDiagnosticsEntry[] = [];
  const gaps: IntegratedEvidenceGap[] = [];
  const verifiedNoTradeCoverage = independentNoTrade?.verifiedCoverage;
  for (const cell of sensitivity.cells) {
    if (!isLegacyStabilityCell(cell)) continue;
    const regime = analyzePerformanceRegimes({
      asset,
      market,
      scenario: cell.scenario,
      frames: cell.counterfactual.legacyBacktest.result.frames,
      fills: cell.counterfactual.fills,
      matchResult: cell.counterfactual.matchResult,
      breakevenToleranceKrw: 1e-9,
    });
    const excursion = analyzePerformanceExcursions({
      scenario: cell.scenario,
      dataset,
      fills: cell.counterfactual.fills,
      matchResult: cell.counterfactual.matchResult,
      ...(verifiedNoTradeCoverage === undefined ? {} : { verifiedNoTradeCoverage }),
    });
    regimeEntries.push({ costScenarioId: cell.costScenario.id, analysis: regime });
    excursionEntries.push({ costScenarioId: cell.costScenario.id, analysis: excursion });
    gaps.push(...regime.evidenceGaps.map((gap): IntegratedEvidenceGap => ({
      code: gap.code,
      severity: gap.severity,
      evidenceKind: "SIMULATED_COUNTERFACTUAL",
      scope: gap.scope,
      asset,
      market,
      scenario: cell.scenario,
      costScenarioId: cell.costScenario.id,
      affectedMetrics: gap.affectedMetrics,
      evidenceIds: gap.evidenceIds,
      message: gap.message,
    })));
    gaps.push(...excursion.evidenceGaps.map((gap): IntegratedEvidenceGap => ({
      code: gap.code,
      severity: gap.severity,
      evidenceKind: "SIMULATED_COUNTERFACTUAL",
      scope: "EXCURSION_ANALYSIS",
      asset,
      market,
      scenario: cell.scenario,
      costScenarioId: cell.costScenario.id,
      affectedMetrics: gap.affectedMetrics,
      evidenceIds: gap.evidenceIds,
      message: gap.message,
    })));
  }

  for (const costScenario of simulationOptions.costScenarios) {
    const cells = sensitivity.cells.filter((cell) => cell.costScenario.id === costScenario.id);
    const baseline = cells.find((cell) => cell.scenario === "BASELINE");
    const noAdd = cells.find((cell) => cell.scenario === "NO_ADD");
    if (!baseline || !noAdd) continue;
    const analysis = analyzeAddDecisionExposures({
      asset,
      market,
      breakevenToleranceKrw: 1e-9,
      baseline: {
        scenario: "BASELINE",
        sourceFrames: baseline.sourceFrames,
        frames: baseline.counterfactual.legacyBacktest.result.frames,
        fills: baseline.counterfactual.fills,
        matchResult: baseline.counterfactual.matchResult,
      },
      noAdd: {
        scenario: "NO_ADD",
        sourceFrames: noAdd.sourceFrames,
        frames: noAdd.counterfactual.legacyBacktest.result.frames,
        fills: noAdd.counterfactual.fills,
        matchResult: noAdd.counterfactual.matchResult,
      },
    });
    const postDecisionExcursions = analyzeAddPostDecisionExcursions({
      asset,
      market,
      dataset,
      exposures: analysis.exposures,
      baselineFills: baseline.counterfactual.fills,
      baselineMatchResult: baseline.counterfactual.matchResult,
      ...(verifiedNoTradeCoverage === undefined ? {} : { verifiedNoTradeCoverage }),
    });
    addDiagnosticEntries.push({
      costScenarioId: costScenario.id,
      analysis,
      postDecisionExcursions,
    });
    gaps.push(...analysis.warnings
      .filter((item) => ADD_DIAGNOSTIC_GAP_CODES.has(item.code))
      .map((item): IntegratedEvidenceGap => ({
        code: item.code,
        severity: item.severity,
        evidenceKind: "SIMULATED_COUNTERFACTUAL",
        scope: "ADD_DECISION_DIAGNOSTICS",
        asset,
        market,
        scenario: null,
        costScenarioId: costScenario.id,
        affectedMetrics: item.code === "COST_FEE_ATTRIBUTION_INCOMPLETE"
          ? ["costAndFeeImpact"]
          : ["addDiagnostics"],
        evidenceIds: item.evidenceIds,
        message: item.message,
      })));
    const unknownExcursions = new Map<string, string[]>();
    for (const exposure of postDecisionExcursions.exposures) {
      if (exposure.status !== "UNKNOWN" || exposure.reason === null) continue;
      const ids = unknownExcursions.get(exposure.reason) ?? [];
      ids.push(exposure.exposureId);
      unknownExcursions.set(exposure.reason, ids);
    }
    for (const [reason, evidenceIds] of unknownExcursions) {
      gaps.push({
        code: `ADD_POST_DECISION_EXCURSION_${reason}`,
        severity: "WARNING",
        evidenceKind: "SIMULATED_COUNTERFACTUAL",
        scope: "ADD_DECISION_DIAGNOSTICS",
        asset,
        market,
        scenario: null,
        costScenarioId: costScenario.id,
        affectedMetrics: ["postDecisionExcursions"],
        evidenceIds,
        message: `${evidenceIds.length} ADD exposure(s) have UNKNOWN post-decision excursion evidence: ${reason}.`,
      });
    }
  }
  const hasAddScenarioPair = simulationOptions.scenarios.includes("BASELINE")
    && simulationOptions.scenarios.includes("NO_ADD");
  let conditionalCandidates: ReturnType<typeof buildConditionalCandidateEvaluations> = [];
  let policySuppressionEvidence: AddPolicySuppressionEvidence[] = [];
  if (conditionalConfiguration !== null) {
    if (featureCoverage === null) {
      throw new Error("Conditional ADD evaluation requires feature coverage evidence.");
    }
    conditionalCandidates = buildConditionalCandidateEvaluations(
      asset,
      sensitivity.cells,
      assetOptions.initialState,
      frames,
      featureCoverage,
      conditionalConfiguration,
      independentNoTrade?.ranges
        ?? featureCoverage.timeframes["1h"].sourceNoTradeRanges,
    );
    policySuppressionEvidence = extractAddPolicySuppressionEvidence(
      asset,
      CONDITIONAL_ADD_CANDIDATES.map((policyId) => ({
        policyId,
        frames: requireCostCell(
          sensitivity.cells,
          policyId,
          conditionalConfiguration.baseCost.id,
        ).counterfactual.legacyBacktest.result.frames,
      })),
    );
  }

  return {
    datasetProvenance,
    simulation: {
      asset,
      market,
      status: "AVAILABLE",
      evidenceKind: "SIMULATED_COUNTERFACTUAL",
      datasetPath: assetOptions.datasetPath,
      datasetSha256: dataset.provenance.sha256,
      independentCapital: true,
      baseCostScenario: { ...baseCost },
      scenarios,
    },
    costs,
    regimes: {
      asset,
      market,
      status: "AVAILABLE",
      evidenceKind: "SIMULATED_COUNTERFACTUAL",
      analyses: regimeEntries,
    },
    excursions: {
      asset,
      market,
      status: "AVAILABLE",
      evidenceKind: "SIMULATED_COUNTERFACTUAL",
      analyses: excursionEntries,
    },
    addDiagnostics: hasAddScenarioPair
      ? {
          asset,
          market,
          status: "AVAILABLE",
          evidenceKind: "SIMULATED_COUNTERFACTUAL",
          analyses: addDiagnosticEntries,
        }
      : {
          asset,
          market,
          status: "SCENARIO_PAIR_UNAVAILABLE",
          evidenceKind: "SIMULATED_COUNTERFACTUAL",
          message: "ADD diagnostics require both BASELINE and NO_ADD scenarios; no comparison was performed.",
        },
    stability,
    conditionalCandidates,
    policySuppressionEvidence,
    gaps,
  };
}

function toStabilityPath(
  cell: CostSensitivityCell & { scenario: "BASELINE" | "NO_ADD" },
  initialState: SimulationInitialState,
  sourceFrames: readonly ReturnType<typeof buildPositionGuardBacktestFrames>[number][],
): StabilityScenarioPath {
  const firstPrice = sourceFrames[0]?.analysis.currentPrice;
  if (firstPrice === undefined || !Number.isFinite(firstPrice) || firstPrice <= 0) {
    throw new Error("Stability validation requires a positive first-frame price.");
  }
  const initialEquityKrw = initialState.cashKrw + initialState.quantity * firstPrice;
  if (!Number.isFinite(initialEquityKrw) || initialEquityKrw <= 0) {
    throw new Error("Stability validation initial equity must be positive and finite.");
  }
  return {
    scenario: cell.scenario,
    initialEquityKrw,
    frames: cell.counterfactual.legacyBacktest.result.frames.map((frame) => ({
      generatedAt: frame.generatedAt,
      equityKrw: frame.equityKrw,
      decisionAction: frame.decision.action,
      policyExposure: frame.researchSuppression === null
        || frame.researchSuppression === undefined
        ? null
        : "ADD_SUPPRESSED",
    })),
    fills: cell.counterfactual.fills.map((fill) => ({
      id: fill.id,
      filledAt: fill.filledAt,
      priceKrw: fill.priceKrw,
      volume: fill.volume,
      feeKrw: fill.feeKrw,
    })),
    episodes: cell.counterfactual.matchResult.episodes.map((episode) => ({
      id: episode.id,
      openedAt: episode.openedAt,
      closedAt: episode.closedAt,
      status: episode.status,
    })),
  };
}

function isLegacyStabilityCell(
  cell: CostSensitivityCell,
): cell is CostSensitivityCell & { scenario: "BASELINE" | "NO_ADD" } {
  return cell.scenario === "BASELINE" || cell.scenario === "NO_ADD";
}

function buildConditionalCandidateEvaluations(
  asset: SupportedAsset,
  cells: readonly CostSensitivityCell[],
  initialState: SimulationInitialState,
  sourceFrames: readonly ReturnType<typeof buildPositionGuardBacktestFrames>[number][],
  featureCoverage: PositionGuardFeatureCoverage,
  configuration: ConditionalAddPolicyConfiguration,
  independentNoTradeRanges: readonly CandleCoverageGap[],
): AddPolicyCandidateEvaluationResult[] {
  return CONDITIONAL_ADD_CANDIDATES.map((candidate) => {
    const baseCandidateCell = requireCostCell(cells, candidate, configuration.baseCost.id);
    const fullPathObservations = buildFullPathObservations(cells, candidate, configuration);
    const windows = configuration.windows.map((window) => buildCandidateWindow(
      cells,
      candidate,
      initialState,
      sourceFrames,
      featureCoverage,
      configuration,
      independentNoTradeRanges,
      window,
      baseCandidateCell,
    ));
    return evaluateAddPolicyCandidate({
      asset,
      candidate,
      baseSlippageRate: configuration.baseCost.slippageRate,
      thresholds: { ...APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS },
      fullPath: {
        coverage: calculateFullPathCadenceCoverage(
          sourceFrames,
          configuration.expectedFrameIntervalMs,
          featureCoverage.affectedFrameRanges,
          independentNoTradeRanges,
        ),
        policyExposedCompletedEpisodeCount: countPolicyExposedCompletedEpisodes(
          baseCandidateCell,
          null,
        ),
        observations: fullPathObservations,
      },
      windows,
    });
  });
}

function buildFullPathObservations(
  cells: readonly CostSensitivityCell[],
  candidate: AddPolicyCandidate,
  configuration: ConditionalAddPolicyConfiguration,
): AddPolicyEvaluationObservation[] {
  return ([
    ["BASE", configuration.baseCost],
    ["STRESS", configuration.stressCost],
  ] as const).flatMap(([costRole, cost]) =>
    ([candidate, "BASELINE", "NO_ADD"] as const).map((scenario) => {
      const cell = requireCostCell(cells, scenario, cost.id);
      return {
        scenario,
        costRole,
        costScenarioId: cost.id,
        feeRate: cost.feeRate,
        slippageRate: cost.slippageRate,
        totalReturnPct: cell.totalReturnPct,
        maxDrawdownPct: cell.maxDrawdownPct,
      };
    })
  );
}

function buildCandidateWindow(
  cells: readonly CostSensitivityCell[],
  candidate: AddPolicyCandidate,
  initialState: SimulationInitialState,
  sourceFrames: readonly ReturnType<typeof buildPositionGuardBacktestFrames>[number][],
  featureCoverage: PositionGuardFeatureCoverage,
  configuration: ConditionalAddPolicyConfiguration,
  independentNoTradeRanges: readonly CandleCoverageGap[],
  window: StabilityValidationWindow,
  baseCandidateCell: CostSensitivityCell,
): AddPolicyEvaluationWindow {
  const from = requirePerformanceTimestamp(window.from, `Window ${window.id} from`);
  const to = requirePerformanceTimestamp(window.to, `Window ${window.id} to`);
  const coverage = calculateConditionalAddCadenceCoverage({
    from: from.normalized,
    to: to.normalized,
    replayStartAt: sourceFrames[0]?.generatedAt ?? from.normalized,
    expectedFrameIntervalMs: configuration.expectedFrameIntervalMs,
    frames: sourceFrames,
    featureLookbackAffectedRanges: featureCoverage.affectedFrameRanges,
    noTradeFrameRanges: independentNoTradeRanges,
  });
  const observations = ([
    ["BASE", configuration.baseCost],
    ["STRESS", configuration.stressCost],
  ] as const).flatMap(([costRole, cost]) =>
    ([candidate, "BASELINE", "NO_ADD"] as const).map((scenario) => {
      const cell = requireCostCell(cells, scenario, cost.id);
      const metrics = sliceContinuousReplayWindow(
        cell,
        initialState,
        sourceFrames,
        from.epochNanoseconds,
        to.epochNanoseconds,
      );
      return {
        scenario,
        costRole,
        costScenarioId: cost.id,
        feeRate: cost.feeRate,
        slippageRate: cost.slippageRate,
        totalReturnPct: metrics.totalReturnPct,
        maxDrawdownPct: metrics.maxDrawdownPct,
      };
    })
  );
  return {
    id: window.id,
    from: from.normalized,
    to: to.normalized,
    coverage: {
      ...coverage,
    },
    policyExposedCompletedEpisodeCount: countPolicyExposedCompletedEpisodes(
      baseCandidateCell,
      { from: from.epochNanoseconds, to: to.epochNanoseconds },
    ),
    observations,
  };
}

export function calculateConditionalAddCadenceCoverage(input: {
  from: string;
  to: string;
  replayStartAt?: string;
  expectedFrameIntervalMs: number;
  frames: readonly { generatedAt: string }[];
  featureLookbackAffectedRanges: readonly AddPolicyAffectedFrameRange[];
  noTradeFrameRanges: readonly CandleCoverageGap[];
}): AddPolicyEvaluationWindow["coverage"] {
  if (!Number.isSafeInteger(input.expectedFrameIntervalMs) || input.expectedFrameIntervalMs <= 0) {
    throw new Error("Conditional ADD expectedFrameIntervalMs must be a positive safe integer.");
  }
  const from = requirePerformanceTimestamp(input.from, "Conditional ADD cadence from");
  const to = requirePerformanceTimestamp(input.to, "Conditional ADD cadence to");
  const replayStart = requirePerformanceTimestamp(
    input.replayStartAt ?? input.from,
    "Conditional ADD cadence replayStartAt",
  );
  if (replayStart.epochNanoseconds > from.epochNanoseconds) {
    throw new Error("Conditional ADD cadence replayStartAt must be at or before from.");
  }
  const intervalNanoseconds = BigInt(input.expectedFrameIntervalMs) * 1_000_000n;
  const durationNanoseconds = to.epochNanoseconds - from.epochNanoseconds;
  if (durationNanoseconds <= 0n || durationNanoseconds % intervalNanoseconds !== 0n) {
    throw new Error("Conditional ADD cadence range must be a positive multiple of expectedFrameIntervalMs.");
  }
  const expectedFrameCount = Number(durationNanoseconds / intervalNanoseconds);
  if (!Number.isSafeInteger(expectedFrameCount) || expectedFrameCount <= 0) {
    throw new Error("Conditional ADD cadence expected frame count must be a positive safe integer.");
  }
  const allObservedInstants = input.frames.map((frame) =>
    requirePerformanceTimestamp(frame.generatedAt, "Source frame generatedAt").epochNanoseconds
  );
  const allNoTradeInstants = validateNoTradeFrameRanges({
    ranges: input.noTradeFrameRanges,
    observedInstants: new Set(allObservedInstants),
    intervalNanoseconds,
    label: "Conditional ADD cadence noTradeFrameRanges",
  });
  const observedInstants = allObservedInstants.flatMap((instant) => {
    return isWithinWindow(instant, from.epochNanoseconds, to.epochNanoseconds)
      ? [instant]
      : [];
  });
  const noTradeInstants = sliceNoTradeFrameInstants({
    instants: allNoTradeInstants,
    firstExpectedInstant: from.epochNanoseconds,
    endExclusiveInstant: to.epochNanoseconds,
  });
  const windowCadence = buildConditionalAddCadenceDetail({
    firstExpectedInstant: from.epochNanoseconds,
    intervalNanoseconds,
    expectedFrameCount,
    observedInstants,
    noTradeInstants,
    adjacentObservedInstants: new Set(allObservedInstants),
  });
  const upstreamDuration = from.epochNanoseconds - replayStart.epochNanoseconds;
  if (upstreamDuration % intervalNanoseconds !== 0n) {
    throw new Error("Conditional ADD cadence upstream range must align to expectedFrameIntervalMs.");
  }
  const upstreamExpectedFrameCount = Number(upstreamDuration / intervalNanoseconds);
  const upstreamObservedInstants = allObservedInstants.flatMap((instant) => {
    return isWithinWindow(
      instant,
      replayStart.epochNanoseconds,
      from.epochNanoseconds,
    ) ? [instant] : [];
  });
  const upstreamNoTradeInstants = sliceNoTradeFrameInstants({
    instants: allNoTradeInstants,
    firstExpectedInstant: replayStart.epochNanoseconds,
    endExclusiveInstant: from.epochNanoseconds,
  });
  const upstream = buildConditionalAddCadenceDetail({
    firstExpectedInstant: replayStart.epochNanoseconds,
    intervalNanoseconds,
    expectedFrameCount: upstreamExpectedFrameCount,
    observedInstants: upstreamObservedInstants,
    noTradeInstants: upstreamNoTradeInstants,
    adjacentObservedInstants: new Set(allObservedInstants),
  });
  const complete = windowCadence.windowSequenceContinuityStatus === "COMPLETE"
    && upstream.windowSequenceContinuityStatus === "COMPLETE";
  const featureLookbackAffectedRanges = sliceAffectedFrameRanges(
    input.featureLookbackAffectedRanges,
    from.epochNanoseconds,
    to.epochNanoseconds,
    intervalNanoseconds,
  );
  const featureLookbackAffectedFrameCount = featureLookbackAffectedRanges.reduce(
    (sum, range) => sum + range.affectedFrameCount,
    0,
  );
  const featureLookbackContinuityStatus = featureLookbackAffectedFrameCount === 0
    ? "COMPLETE"
    : "INCOMPLETE";
  return {
    ...windowCadence,
    status: complete && featureLookbackContinuityStatus === "COMPLETE" ? "COMPLETE" : "INCOMPLETE",
    windowCadenceStatus: windowCadence.status,
    windowSequenceContinuityStatus: windowCadence.windowSequenceContinuityStatus,
    windowClockGridStatus: windowCadence.windowClockGridStatus,
    upstreamStateContinuityStatus: upstream.windowSequenceContinuityStatus,
    featureLookbackContinuityStatus,
    upstreamExpectedFrameCount,
    upstreamObservedFrameCount: upstream.observedFrameCount,
    upstreamSequenceContinuityStatus: upstream.windowSequenceContinuityStatus,
    upstreamClockGridStatus: upstream.windowClockGridStatus,
    upstreamNoTradeFrameCount: upstream.noTradeFrameCount,
    upstreamNoTradeRanges: upstream.noTradeRanges,
    upstreamFirstExpectedFrameAt: upstreamExpectedFrameCount === 0 ? null : formatCadenceInstant(replayStart.epochNanoseconds),
    upstreamEndExclusiveAt: upstreamExpectedFrameCount === 0 ? null : formatCadenceInstant(from.epochNanoseconds),
    upstreamMissingFrameCount: upstream.missingFrameCount,
    upstreamDuplicateFrameCount: upstream.duplicateFrameCount,
    upstreamOffGridFrameCount: upstream.offGridFrameCount,
    upstreamMissingRanges: upstream.missingRanges,
    upstreamDuplicateInstants: upstream.duplicateInstants,
    upstreamOffGridInstants: upstream.offGridInstants,
    featureLookbackAffectedFrameCount,
    featureLookbackAffectedRanges,
  };
}

function calculateFullPathCadenceCoverage(
  frames: readonly { generatedAt: string }[],
  expectedFrameIntervalMs: number,
  featureLookbackAffectedRanges: readonly AddPolicyAffectedFrameRange[],
  noTradeFrameRanges: readonly CandleCoverageGap[],
): AddPolicyEvaluationWindow["coverage"] {
  if (!Number.isSafeInteger(expectedFrameIntervalMs) || expectedFrameIntervalMs <= 0) {
    throw new Error("Conditional ADD expectedFrameIntervalMs must be a positive safe integer.");
  }
  const instants = frames.map((frame) =>
    requirePerformanceTimestamp(frame.generatedAt, "Full-path source frame generatedAt").epochNanoseconds
  ).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const first = instants[0];
  const last = instants.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("Conditional ADD full-path cadence requires at least one source frame.");
  }
  const intervalNanoseconds = BigInt(expectedFrameIntervalMs) * 1_000_000n;
  const allNoTradeInstants = validateNoTradeFrameRanges({
    ranges: noTradeFrameRanges,
    observedInstants: new Set(instants),
    intervalNanoseconds,
    label: "Conditional ADD full-path noTradeFrameRanges",
  });
  const expectedFrameCount = Number((last - first) / intervalNanoseconds + 1n);
  if (!Number.isSafeInteger(expectedFrameCount) || expectedFrameCount <= 0) {
    throw new Error("Conditional ADD full-path expected frame count must be a positive safe integer.");
  }
  const cadence = buildConditionalAddCadenceDetail({
    firstExpectedInstant: first,
    intervalNanoseconds,
    expectedFrameCount,
    observedInstants: instants,
    noTradeInstants: sliceNoTradeFrameInstants({
      instants: allNoTradeInstants,
      firstExpectedInstant: first,
      endExclusiveInstant: last + intervalNanoseconds,
    }),
    adjacentObservedInstants: new Set(instants),
  });
  return {
    ...cadence,
    windowCadenceStatus: cadence.status,
    windowSequenceContinuityStatus: cadence.windowSequenceContinuityStatus,
    windowClockGridStatus: cadence.windowClockGridStatus,
    upstreamStateContinuityStatus: "COMPLETE",
    featureLookbackContinuityStatus: featureLookbackAffectedRanges.length === 0 ? "COMPLETE" : "INCOMPLETE",
    upstreamMissingFrameCount: 0,
    upstreamExpectedFrameCount: 0,
    upstreamObservedFrameCount: 0,
    upstreamSequenceContinuityStatus: "COMPLETE",
    upstreamClockGridStatus: "DENSE",
    upstreamNoTradeFrameCount: 0,
    upstreamNoTradeRanges: [],
    upstreamFirstExpectedFrameAt: null,
    upstreamEndExclusiveAt: null,
    upstreamDuplicateFrameCount: 0,
    upstreamOffGridFrameCount: 0,
    upstreamMissingRanges: [],
    upstreamDuplicateInstants: [],
    upstreamOffGridInstants: [],
    featureLookbackAffectedFrameCount: featureLookbackAffectedRanges.reduce(
      (sum, range) => sum + range.affectedFrameCount,
      0,
    ),
    featureLookbackAffectedRanges: featureLookbackAffectedRanges.map((range) => ({ ...range })),
    status: cadence.windowSequenceContinuityStatus === "COMPLETE" && featureLookbackAffectedRanges.length === 0
      ? "COMPLETE"
      : "INCOMPLETE",
  };
}

type ConditionalAddCadenceDetail = Pick<
  AddPolicyEvaluationWindow["coverage"],
  | "status"
  | "windowSequenceContinuityStatus"
  | "windowClockGridStatus"
  | "expectedFrameCount"
  | "observedFrameCount"
  | "noTradeFrameCount"
  | "noTradeRanges"
  | "missingFrameCount"
  | "duplicateFrameCount"
  | "offGridFrameCount"
  | "missingRanges"
  | "expectedFrameIntervalMs"
  | "firstExpectedFrameAt"
  | "endExclusiveAt"
  | "duplicateInstants"
  | "offGridInstants"
>;

function buildConditionalAddCadenceDetail(input: {
  firstExpectedInstant: bigint;
  intervalNanoseconds: bigint;
  expectedFrameCount: number;
  observedInstants: readonly bigint[];
  noTradeInstants: ReadonlySet<bigint>;
  adjacentObservedInstants?: ReadonlySet<bigint>;
}): ConditionalAddCadenceDetail {
  const expectedInstants = Array.from({ length: input.expectedFrameCount }, (_, index) =>
    input.firstExpectedInstant + BigInt(index) * input.intervalNanoseconds
  );
  const expectedSet = new Set(expectedInstants);
  const observedSet = new Set(input.observedInstants);
  for (const instant of input.noTradeInstants) {
    if (observedSet.has(instant)) {
      throw new Error("Conditional ADD cadence cannot classify an observed frame as no-trade.");
    }
  }
  const observedCounts = new Map<bigint, number>();
  for (const instant of input.observedInstants) {
    observedCounts.set(instant, (observedCounts.get(instant) ?? 0) + 1);
  }
  const observedExpectedInstants = expectedInstants.filter((instant) => observedSet.has(instant));
  const noTradeExpectedInstants = expectedInstants.filter((instant) => input.noTradeInstants.has(instant));
  const missingInstants = expectedInstants.filter((instant) =>
    !observedSet.has(instant) && !input.noTradeInstants.has(instant)
  );
  const duplicateFrameCount = input.observedInstants.length - observedSet.size;
  const offGridFrameCount = input.observedInstants.filter((instant) => !expectedSet.has(instant)).length;
  const duplicateInstants = [...observedCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([instant, occurrenceCount]) => ({ observedAt: formatCadenceInstant(instant), occurrenceCount }));
  const offGridInstants = [...observedCounts.entries()]
    .filter(([instant]) => !expectedSet.has(instant))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([instant, occurrenceCount]) => ({ observedAt: formatCadenceInstant(instant), occurrenceCount }));
  const missingRanges = groupConditionalAddCadenceGaps(
    missingInstants,
    input.adjacentObservedInstants ?? observedSet,
    input.intervalNanoseconds,
  );
  const noTradeRanges = groupConditionalAddCadenceGaps(
    noTradeExpectedInstants,
    input.adjacentObservedInstants ?? observedSet,
    input.intervalNanoseconds,
  );
  const sequenceComplete = missingInstants.length === 0
    && duplicateFrameCount === 0
    && offGridFrameCount === 0;
  const rawCadenceComplete = sequenceComplete && noTradeExpectedInstants.length === 0;
  const clockGridStatus = duplicateFrameCount > 0 || offGridFrameCount > 0 || missingInstants.length > 0
    ? "ANOMALOUS"
    : noTradeExpectedInstants.length > 0
      ? "SPARSE_BY_CONTRACT"
      : "DENSE";

  return {
    status: rawCadenceComplete ? "COMPLETE" : "INCOMPLETE",
    windowSequenceContinuityStatus: sequenceComplete ? "COMPLETE" : "INCOMPLETE",
    windowClockGridStatus: clockGridStatus,
    expectedFrameIntervalMs: Number(input.intervalNanoseconds / 1_000_000n),
    firstExpectedFrameAt: formatCadenceInstant(input.firstExpectedInstant),
    endExclusiveAt: formatCadenceInstant(
      input.firstExpectedInstant + BigInt(input.expectedFrameCount) * input.intervalNanoseconds,
    ),
    expectedFrameCount: input.expectedFrameCount,
    observedFrameCount: observedExpectedInstants.length,
    noTradeFrameCount: noTradeExpectedInstants.length,
    noTradeRanges,
    missingFrameCount: missingInstants.length,
    duplicateFrameCount,
    offGridFrameCount,
    missingRanges,
    duplicateInstants,
    offGridInstants,
  };
}

function validateNoTradeFrameRanges(input: {
  ranges: readonly CandleCoverageGap[];
  observedInstants: ReadonlySet<bigint>;
  intervalNanoseconds: bigint;
  label: string;
}): Set<bigint> {
  const instants = new Set<bigint>();
  let previousLast: bigint | null = null;
  for (const [index, range] of input.ranges.entries()) {
    const first = requirePerformanceTimestamp(
      range.firstMissingCloseTime,
      `${input.label}[${index}] firstMissingCloseTime`,
    ).epochNanoseconds;
    const last = requirePerformanceTimestamp(
      range.lastMissingCloseTime,
      `${input.label}[${index}] lastMissingCloseTime`,
    ).epochNanoseconds;
    if (!Number.isSafeInteger(range.missingCandleCount) || range.missingCandleCount <= 0) {
      throw new Error(`${input.label}[${index}] missingCandleCount must be a positive safe integer.`);
    }
    const span = last - first;
    if (span < 0n || span % input.intervalNanoseconds !== 0n
      || span / input.intervalNanoseconds + 1n !== BigInt(range.missingCandleCount)) {
      throw new Error(`${input.label}[${index}] timestamp span must match missingCandleCount.`);
    }
    if (first % input.intervalNanoseconds !== 0n) {
      throw new Error(`${input.label}[${index}] must align to expectedFrameIntervalMs.`);
    }
    if (previousLast !== null && first <= previousLast) {
      throw new Error(`${input.label} ranges must be strictly ordered and non-overlapping.`);
    }
    if (previousLast !== null && first - previousLast === input.intervalNanoseconds) {
      throw new Error(`${input.label} ranges must be canonical and non-adjacent.`);
    }
    for (let instant = first; instant <= last; instant += input.intervalNanoseconds) {
      if (input.observedInstants.has(instant)) {
        throw new Error("Conditional ADD cadence cannot classify an observed frame as no-trade.");
      }
      instants.add(instant);
    }
    previousLast = last;
  }
  return instants;
}

function sliceNoTradeFrameInstants(input: {
  instants: ReadonlySet<bigint>;
  firstExpectedInstant: bigint;
  endExclusiveInstant: bigint;
}): Set<bigint> {
  return new Set([...input.instants].filter((instant) =>
    isWithinWindow(instant, input.firstExpectedInstant, input.endExclusiveInstant)
  ));
}

function groupConditionalAddCadenceGaps(
  missingInstants: readonly bigint[],
  observedInstants: ReadonlySet<bigint>,
  intervalNanoseconds: bigint,
): AddPolicyEvaluationWindow["coverage"]["missingRanges"] {
  const ranges: AddPolicyEvaluationWindow["coverage"]["missingRanges"] = [];
  for (const missingInstant of missingInstants) {
    const previous = ranges.at(-1);
    if (previous !== undefined) {
      const previousLast = requirePerformanceTimestamp(
        previous.lastMissingAt,
        "Conditional ADD cadence lastMissingAt",
      ).epochNanoseconds;
      if (missingInstant - previousLast === intervalNanoseconds) {
        previous.lastMissingAt = formatCadenceInstant(missingInstant);
        previous.missingFrameCount += 1;
        previous.nextObservedAt = observedInstants.has(missingInstant + intervalNanoseconds)
          ? formatCadenceInstant(missingInstant + intervalNanoseconds)
          : null;
        continue;
      }
    }

    ranges.push({
      firstMissingAt: formatCadenceInstant(missingInstant),
      lastMissingAt: formatCadenceInstant(missingInstant),
      missingFrameCount: 1,
      previousObservedAt: observedInstants.has(missingInstant - intervalNanoseconds)
        ? formatCadenceInstant(missingInstant - intervalNanoseconds)
        : null,
      nextObservedAt: observedInstants.has(missingInstant + intervalNanoseconds)
        ? formatCadenceInstant(missingInstant + intervalNanoseconds)
        : null,
    });
  }
  return ranges;
}

function sliceAffectedFrameRanges(
  ranges: readonly AddPolicyAffectedFrameRange[],
  from: bigint,
  to: bigint,
  intervalNanoseconds: bigint,
): AddPolicyAffectedFrameRange[] {
  const affected: bigint[] = [];
  for (const range of ranges) {
    const first = requirePerformanceTimestamp(
      range.firstFrameAt,
      "Conditional ADD feature coverage firstFrameAt",
    ).epochNanoseconds;
    const last = requirePerformanceTimestamp(
      range.lastFrameAt,
      "Conditional ADD feature coverage lastFrameAt",
    ).epochNanoseconds;
    for (let instant = first; instant <= last; instant += intervalNanoseconds) {
      if (isWithinWindow(instant, from, to)) affected.push(instant);
    }
  }
  const sliced: AddPolicyAffectedFrameRange[] = [];
  for (const instant of affected.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)) {
    const previous = sliced.at(-1);
    if (previous !== undefined) {
      const previousLast = requirePerformanceTimestamp(
        previous.lastFrameAt,
        "Conditional ADD feature coverage lastFrameAt",
      ).epochNanoseconds;
      if (instant - previousLast === intervalNanoseconds) {
        previous.lastFrameAt = formatCadenceInstant(instant);
        previous.affectedFrameCount += 1;
        continue;
      }
    }
    sliced.push({
      firstFrameAt: formatCadenceInstant(instant),
      lastFrameAt: formatCadenceInstant(instant),
      affectedFrameCount: 1,
    });
  }
  return sliced;
}

function formatCadenceInstant(epochNanoseconds: bigint): string {
  const nanosecondsPerSecond = 1_000_000_000n;
  const nanosecondsPerMillisecond = 1_000_000n;
  const seconds = epochNanoseconds / nanosecondsPerSecond;
  const fractionalNanoseconds = epochNanoseconds % nanosecondsPerSecond;
  const prefix = new Date(Number(seconds * 1_000n)).toISOString().slice(0, 19);
  if (fractionalNanoseconds % nanosecondsPerMillisecond === 0n) {
    const milliseconds = fractionalNanoseconds / nanosecondsPerMillisecond;
    return `${prefix}.${milliseconds.toString().padStart(3, "0")}Z`;
  }
  return `${prefix}.${fractionalNanoseconds.toString().padStart(9, "0")}Z`;
}

function sliceContinuousReplayWindow(
  cell: CostSensitivityCell,
  initialState: SimulationInitialState,
  sourceFrames: readonly ReturnType<typeof buildPositionGuardBacktestFrames>[number][],
  from: bigint,
  to: bigint,
): { totalReturnPct: number; maxDrawdownPct: number } {
  const firstPrice = sourceFrames[0]?.analysis.currentPrice;
  if (firstPrice === undefined || !Number.isFinite(firstPrice) || firstPrice <= 0) {
    throw new Error("Conditional ADD evaluation requires a positive first-frame price.");
  }
  const initialEquity = initialState.cashKrw + initialState.quantity * firstPrice;
  if (!Number.isFinite(initialEquity) || initialEquity <= 0) {
    throw new Error("Conditional ADD evaluation initial equity must be finite and positive.");
  }
  let startEquity = initialEquity;
  const equities: number[] = [];
  for (const frame of cell.counterfactual.legacyBacktest.result.frames) {
    const timestamp = requirePerformanceTimestamp(frame.generatedAt, "Replay frame generatedAt");
    if (timestamp.epochNanoseconds < from) startEquity = frame.equityKrw;
    if (isWithinWindow(timestamp.epochNanoseconds, from, to)) equities.push(frame.equityKrw);
  }
  const endEquity = equities.at(-1) ?? startEquity;
  const totalReturnPct = (endEquity - startEquity) / startEquity;
  let peak = startEquity;
  let maxDrawdownPct = 0;
  for (const equity of equities) {
    peak = Math.max(peak, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak > 0 ? (peak - equity) / peak : 0);
  }
  if (!Number.isFinite(totalReturnPct) || !Number.isFinite(maxDrawdownPct)) {
    throw new Error("Conditional ADD window metrics must be finite.");
  }
  return { totalReturnPct, maxDrawdownPct };
}

function countPolicyExposedCompletedEpisodes(
  cell: CostSensitivityCell,
  window: { from: bigint; to: bigint } | null,
): number {
  const exposureInstants = cell.counterfactual.legacyBacktest.result.frames.flatMap((frame) =>
    frame.researchPolicyEvaluation?.outcome === "ALLOW" && frame.trade?.action === "ADD"
      ? [requirePerformanceTimestamp(frame.generatedAt, "Policy exposure generatedAt").epochNanoseconds]
      : []
  );
  return cell.counterfactual.matchResult.episodes.filter((episode) => {
    if (episode.status !== "COMPLETED" || episode.closedAt === null) return false;
    const openedAt = requirePerformanceTimestamp(episode.openedAt, `Episode ${episode.id} openedAt`)
      .epochNanoseconds;
    const closedAt = requirePerformanceTimestamp(episode.closedAt, `Episode ${episode.id} closedAt`)
      .epochNanoseconds;
    if (window !== null && !isWithinWindow(closedAt, window.from, window.to)) return false;
    return exposureInstants.some((instant) => instant >= openedAt && instant <= closedAt);
  }).length;
}

function requireCostCell(
  cells: readonly CostSensitivityCell[],
  scenario: CounterfactualScenario,
  costScenarioId: string,
): CostSensitivityCell {
  const matches = cells.filter(
    (cell) => cell.scenario === scenario && cell.costScenario.id === costScenarioId,
  );
  if (matches.length !== 1) {
    throw new Error(`Conditional ADD evaluation requires exactly one ${scenario}/${costScenarioId} cell.`);
  }
  return matches[0]!;
}

function requirePerformanceTimestamp(value: string, label: string) {
  const parsed = parsePerformanceTimestamp(value);
  if (parsed === null) throw new Error(`${label} requires an explicit timezone.`);
  return parsed;
}

function isWithinWindow(value: bigint, from: bigint, to: bigint): boolean {
  return compareEpochNanoseconds(value, from) >= 0 && compareEpochNanoseconds(value, to) < 0;
}

function buildUnusableAssetEvaluation(
  assetOptions: SimulationAssetOptions,
  dataset: ResearchCandleDataset,
  datasetProvenance: IntegratedDatasetProvenance,
): AssetEvaluation {
  const asset = dataset.provenance.asset;
  const market = dataset.provenance.market;
  const reasonCode = classifyDatasetUnusableReason(dataset);
  const message = describeDatasetUnusableReason(dataset, reasonCode);
  const common = {
    asset,
    market,
    status: "DATASET_UNUSABLE" as const,
    datasetPath: assetOptions.datasetPath,
    datasetSha256: dataset.provenance.sha256,
    reasonCode,
    message,
  };
  return {
    datasetProvenance,
    simulation: { ...common, evidenceKind: "SIMULATED_COUNTERFACTUAL" },
    costs: { ...common, evidenceKind: "MODELED_COST_SCENARIO" },
    regimes: { ...common, evidenceKind: "SIMULATED_COUNTERFACTUAL" },
    excursions: { ...common, evidenceKind: "SIMULATED_COUNTERFACTUAL" },
    addDiagnostics: { ...common, evidenceKind: "SIMULATED_COUNTERFACTUAL" },
    stability: {
      asset,
      market,
      status: "DATASET_UNUSABLE",
      evidenceKind: "SIMULATED_COUNTERFACTUAL_STABILITY",
      message,
    },
    conditionalCandidates: [],
    policySuppressionEvidence: [],
    gaps: [{
      code: "DATASET_UNUSABLE",
      severity: "WARNING",
      evidenceKind: "SIMULATED_COUNTERFACTUAL",
      scope: "LOCAL_CANDLE_DATASET",
      asset,
      market,
      scenario: null,
      costScenarioId: null,
      affectedMetrics: ["simulatedCounterfactuals", "costSensitivity", "regimeAnalysis", "excursionAnalysis", "addDiagnostics"],
      evidenceIds: [dataset.provenance.sha256],
      message,
    }],
  };
}

function classifyDatasetUnusableReason(dataset: ResearchCandleDataset): DatasetUnusableReasonCode {
  const counts = datasetCandleCounts(dataset);
  if (Object.values(counts).some((count) => count === 0)) return "EMPTY_TIMEFRAME_CANDLES";
  if (Object.values(counts).some((count) => count < REQUIRED_COMPLETED_CANDLES)) {
    return "INSUFFICIENT_COMPLETED_CANDLES";
  }
  return "NO_OVERLAPPING_REPLAY_WINDOW";
}

function describeDatasetUnusableReason(
  dataset: ResearchCandleDataset,
  reasonCode: DatasetUnusableReasonCode,
): string {
  const counts = datasetCandleCounts(dataset);
  const countSummary = `1h=${counts["1h"]}, 4h=${counts["4h"]}, 1d=${counts["1d"]}`;
  if (reasonCode === "EMPTY_TIMEFRAME_CANDLES") {
    return `${reasonCode}: ${dataset.provenance.asset} dataset has an empty required timeframe (${countSummary}).`;
  }
  if (reasonCode === "INSUFFICIENT_COMPLETED_CANDLES") {
    return `${reasonCode}: ${dataset.provenance.asset} dataset cannot supply ${REQUIRED_COMPLETED_CANDLES} completed candles per timeframe (${countSummary}).`;
  }
  return `${reasonCode}: ${dataset.provenance.asset} dataset has no decision instant with ${REQUIRED_COMPLETED_CANDLES} completed 1h, 4h, and 1d candles.`;
}

function datasetCandleCounts(
  dataset: ResearchCandleDataset,
): Record<"1h" | "4h" | "1d", number> {
  return {
    "1h": dataset.candles["1h"].length,
    "4h": dataset.candles["4h"].length,
    "1d": dataset.candles["1d"].length,
  };
}

function summarizeCostCell(cell: CostSensitivityCell): CostSensitivityCellSummary {
  if (cell.costMetricScope !== "ALL_SIMULATED_FILLS") {
    throw new Error("Cost sensitivity cell costMetricScope must be ALL_SIMULATED_FILLS.");
  }
  if (cell.fifoOutcomeMetricScope !== "SELECTED_STREAM_FIFO") {
    throw new Error("Cost sensitivity cell fifoOutcomeMetricScope must be SELECTED_STREAM_FIFO.");
  }
  return {
    evidenceKind: cell.evidenceKind,
    scenario: cell.scenario,
    costScenario: { ...cell.costScenario },
    finalEquityKrw: cell.finalEquityKrw,
    totalReturnPct: cell.totalReturnPct,
    maxDrawdownPct: cell.maxDrawdownPct,
    costMetricScope: cell.costMetricScope,
    turnoverKrw: cell.turnoverKrw,
    modeledFeesKrw: cell.modeledFeesKrw,
    fifoOutcomeMetricScope: cell.fifoOutcomeMetricScope,
    completedEpisodeCount: cell.completedEpisodeCount,
    episodeWinRate: cell.episodeWinRate,
    profitFactor: cell.profitFactor,
    tradeCount: cell.counterfactual.legacyBacktest.result.metrics.tradeCount,
  };
}

function mapObservedGaps(attribution: ObservedAttributionResult): IntegratedEvidenceGap[] {
  return attribution.evidenceGaps.map((gap) => ({
    code: gap.code,
    severity: gap.severity,
    evidenceKind: "OBSERVED_LIVE_ATTRIBUTION",
    scope: gap.scope,
    asset: null,
    market: null,
    scenario: null,
    costScenarioId: null,
    affectedMetrics: gap.affectedMetrics,
    evidenceIds: gap.evidenceIds,
    message: gap.message,
  }));
}

function mapObservedMarkGaps(diagnostics: PerformanceDiagnosticsResult): IntegratedEvidenceGap[] {
  const persisted = diagnostics.markPnlCurve.persistedObservationCount;
  const usable = diagnostics.markPnlCurve.usableObservationCount;
  const exclusions = diagnostics.markPnlCurve.excludedObservations.filter((exclusion) =>
    exclusion.metricScopes.includes("GROSS")
  );
  const evidenceIds = [...new Set(exclusions.map((exclusion) => exclusion.snapshotId))];
  const reasonCounts = new Map<string, number>();
  const grossReasonCodes = new Set([
    "MISSING_ACTIVE_POSITION_MARK",
    "INCOMPLETE_ACQUISITION_COST",
    "INCOMPLETE_REALIZED_GROSS_ATTRIBUTION",
  ]);
  for (const exclusion of exclusions) {
    for (const reason of exclusion.reasonCodes) {
      if (!grossReasonCodes.has(reason)) continue;
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  const exclusionSummary = [...reasonCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(",");
  const provenanceSuffix = exclusions.length === 0
    ? ""
    : ` excluded_snapshot_count=${evidenceIds.length}; exclusion_reasons=${exclusionSummary}.`;
  let code: "MARK_DATA_UNAVAILABLE" | "MARK_DATA_UNUSABLE" | "MARK_DATA_PARTIAL";
  let message: string;
  if (persisted === 0) {
    code = "MARK_DATA_UNAVAILABLE";
    message = "No persisted mark observations were selected (persisted=0, usable=0); mark-based PnL and drawdown remain not applicable without interpolation or a future observation.";
  } else if (usable === 0) {
    code = "MARK_DATA_UNUSABLE";
    message = `Persisted mark observations cannot value the selected stream (persisted=${persisted}, usable=0); mark-based PnL and drawdown remain unknown without interpolation or a future observation.${provenanceSuffix}`;
  } else if (usable < persisted) {
    if (evidenceIds.length === 0) return [];
    code = "MARK_DATA_PARTIAL";
    message = `Persisted mark evidence is only partially usable (persisted=${persisted}, usable=${usable}); mark-based PnL and drawdown retain the diagnostics metric state without interpolation or a future observation.${provenanceSuffix}`;
  } else {
    return [];
  }
  return [{
    code,
    severity: "WARNING",
    evidenceKind: "OBSERVED_LIVE_ATTRIBUTION",
    scope: "PERSISTED_MARK_OBSERVATIONS",
    asset: null,
    market: null,
    scenario: null,
    costScenarioId: null,
    affectedMetrics: [
      "observedLive.diagnostics.markPnlCurve",
      "observedLive.diagnostics.marketMarkPnlCurves",
    ],
    evidenceIds,
    message,
  }];
}

function datasetUnavailableGap(asset: SupportedAsset): IntegratedEvidenceGap {
  return {
    code: "DATASET_UNAVAILABLE",
    severity: "WARNING",
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    scope: "LOCAL_CANDLE_DATASET",
    asset,
    market: getMarketForAsset(asset),
    scenario: null,
    costScenarioId: null,
    affectedMetrics: ["simulatedCounterfactuals", "costSensitivity", "regimeAnalysis", "excursionAnalysis", "addDiagnostics"],
    evidenceIds: [],
    message: `No immutable local ${asset} dataset was supplied; actual counterfactual evidence is unavailable and no network fallback was attempted.`,
  };
}

export function buildInterpretation(
  observed: ObservedAttributionResult,
  simulationAssets: readonly (
    UnavailableAssetSection | UnusableAssetSection | AvailableSimulationAssetSection
  )[],
): InterpretationFinding[] {
  const completedSupport = observed.sampleSupport.COMPLETED_EPISODES;
  const findings: InterpretationFinding[] = [{
    code: "OBSERVED_SAMPLE_SUPPORT",
    evidenceKind: "OBSERVED_LIVE_ATTRIBUTION",
    asset: null,
    metricIds: ["/observedLive/attribution/sampleSupport/COMPLETED_EPISODES"],
    sampleStatus: completedSupport.status,
    text: `Observed completed-episode support is ${completedSupport.status} (${completedSupport.observedCount}/${completedSupport.requiredCount}); this policy is an interpretation aid, not a statistical significance claim.`,
  }];
  for (const [assetIndex, assetSection] of simulationAssets.entries()) {
    if (assetSection.status !== "AVAILABLE") continue;
    const baselineIndex = assetSection.scenarios.findIndex((item) => item.scenario === "BASELINE");
    const noAddIndex = assetSection.scenarios.findIndex((item) => item.scenario === "NO_ADD");
    if (baselineIndex < 0 || noAddIndex < 0) continue;
    const baseline = assetSection.scenarios[baselineIndex]!;
    const noAdd = assetSection.scenarios[noAddIndex]!;
    const delta = noAdd.metrics.totalReturnPct - baseline.metrics.totalReturnPct;
    if (!Number.isFinite(delta)) throw new Error(`${assetSection.asset} scenario delta must be finite.`);
    const percentagePointDelta = Math.abs(delta) * 100;
    if (!Number.isFinite(percentagePointDelta)) {
      throw new Error(`${assetSection.asset} percentage-point scenario delta must be finite.`);
    }
    const sampleStatus = weakerSampleStatus(baseline.sampleSupportStatus, noAdd.sampleSupportStatus);
    const direction = delta > 0 ? "higher" : delta < 0 ? "lower" : "equal";
    findings.push({
      code: "COUNTERFACTUAL_SCENARIO_DELTA",
      evidenceKind: "SIMULATED_COUNTERFACTUAL",
      asset: assetSection.asset,
      metricIds: [
        `/simulatedCounterfactuals/assets/${assetIndex}/scenarios/${baselineIndex}/metrics/totalReturnPct`,
        `/simulatedCounterfactuals/assets/${assetIndex}/scenarios/${noAddIndex}/metrics/totalReturnPct`,
      ],
      sampleStatus,
      text: `${assetSection.asset} NO_ADD replay return was ${direction} than BASELINE by ${formatSignificantNumber(percentagePointDelta)} percentage points under the explicit base cost cell; this descriptive difference does not establish causality or future performance.`,
    });
  }
  return findings;
}

function formatSignificantNumber(value: number): string {
  return Number(value.toPrecision(15)).toString();
}

function weakerSampleStatus(left: SampleSupportStatus, right: SampleSupportStatus): SampleSupportStatus {
  const rank: Record<SampleSupportStatus, number> = { INSUFFICIENT: 0, PRELIMINARY: 1, SUPPORTED: 2 };
  return rank[left] <= rank[right] ? left : right;
}

function parseObservedFilters(values: ReadonlyMap<string, string>): PerformanceReadFilters {
  const databasePath = requireArgument(values, "database");
  const exchangeAccountId = requireArgument(values, "exchange-account-id");
  const executionMode = parseExecutionMode(requireArgument(values, "execution-mode"));
  const origin = parseOrigin(requireArgument(values, "origin"));
  const from = parseOptionalTimestamp(values.get("from"), "from");
  const to = parseOptionalTimestamp(values.get("to"), "to");
  if (from !== undefined && to !== undefined && comparePerformanceTimestamps(from, to) >= 0) {
    throw new Error("--from must be earlier than --to.");
  }
  return {
    databasePath,
    exchangeAccountId,
    executionMode,
    origin,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function parseFormat(value: string | undefined): IntegratedEvaluationFormat {
  if (value === undefined || value === "text") return "text";
  if (value === "json") return "json";
  throw new Error(`Invalid --format: ${value}. Use text or json.`);
}

function parseExecutionMode(value: string): ExecutionMode {
  if (value === "LIVE") return value;
  if (value === "DRY_RUN") {
    throw new Error("OBSERVED_LIVE_ATTRIBUTION requires --execution-mode LIVE.");
  }
  throw new Error(`Invalid --execution-mode: ${value}. Use LIVE.`);
}

function parseOrigin(value: string): OrderOrigin {
  if (value === "STRATEGY" || value === "OPERATOR" || value === "RECOVERY") return value;
  throw new Error(`Invalid --origin: ${value}. Use STRATEGY, OPERATOR, or RECOVERY.`);
}

function parseOptionalTimestamp(value: string | undefined, key: "from" | "to"): string | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeExplicitIsoTimestamp(value, `--${key}`);
  } catch {
    throw new Error(`Invalid --${key}: ${value}. Use an explicit ISO-8601 timezone.`);
  }
}

function parseInitialState(value: string, label: string): SimulationInitialState {
  const record = parseJsonRecord(value, label);
  assertExactKeys(record, ["cashKrw", "quantity", "averageEntryPriceKrw"], label);
  const initialState = {
    cashKrw: requireFiniteNonNegativeJsonNumber(record.cashKrw, `${label}.cashKrw`),
    quantity: requireFiniteNonNegativeJsonNumber(record.quantity, `${label}.quantity`),
    averageEntryPriceKrw: requireFiniteNonNegativeJsonNumber(
      record.averageEntryPriceKrw,
      `${label}.averageEntryPriceKrw`,
    ),
  };
  if (initialState.quantity > 0 && initialState.averageEntryPriceKrw <= 0) {
    throw new Error(`${label}.averageEntryPriceKrw must be positive when quantity is positive.`);
  }
  return initialState;
}

function parseScenarios(value: string): CounterfactualScenario[] {
  const parsed = parseJson(value, "--scenarios");
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("--scenarios must be a non-empty JSON array.");
  }
  const result: CounterfactualScenario[] = [];
  const seen = new Set<string>();
  for (const scenario of parsed) {
    if (
      scenario !== "BASELINE"
      && scenario !== "NO_ADD"
      && scenario !== "ADD_RISK_CLEAR"
      && scenario !== "ADD_HIGH_ALIGNMENT"
      && scenario !== "ADD_CORE_TREND"
      && scenario !== "HTF_TREND_GATE"
      && scenario !== "STRICT_PULLBACK"
      && scenario !== "EARLY_THESIS_FAILURE"
      && scenario !== "ADD_LIMITED"
      && scenario !== "COOLDOWN_CONTROL"
      && scenario !== "COMBINED_CONSERVATIVE"
    ) {
      throw new Error(`Unsupported scenario ${String(scenario)}.`);
    }
    if (seen.has(scenario)) throw new Error(`Duplicate scenario ${scenario}.`);
    seen.add(scenario);
    result.push(scenario);
  }
  return result;
}

function parseBroadStrategyHypothesisProfile(
  values: ReadonlyMap<string, string>,
  simulation: IntegratedSimulationOptions,
  stabilityValidation: IntegratedStabilityValidationOptions | null,
): "BROAD_LOSS_CAUSE_V1" | undefined {
  const value = values.get("broad-strategy-hypothesis-profile");
  if (value === undefined) return undefined;
  if (value !== "BROAD_LOSS_CAUSE_V1") {
    throw new Error(
      `Invalid --broad-strategy-hypothesis-profile: ${value}. Use BROAD_LOSS_CAUSE_V1.`,
    );
  }
  if (!simulation.assets.BTC || !simulation.assets.ETH) {
    throw new Error("BROAD_LOSS_CAUSE_V1 requires both BTC and ETH datasets and initial states.");
  }
  const exactScenarios: readonly CounterfactualScenario[] = [
    "BASELINE",
    "NO_ADD",
    ...FROZEN_STRATEGY_HYPOTHESIS_SCENARIO_ORDER,
  ];
  if (!sameJson(simulation.scenarios, exactScenarios)) {
    throw new Error("BROAD_LOSS_CAUSE_V1 requires the exact frozen 8-scenario matrix in canonical order.");
  }
  const exactCosts = FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.costCells.map((cell) => ({
    id: cell.id,
    feeRate: cell.feeRate,
    slippageRate: cell.slippageRate,
  }));
  if (!sameJson(simulation.costScenarios, exactCosts)) {
    throw new Error("BROAD_LOSS_CAUSE_V1 requires the exact frozen BASE/STRESS cost cells.");
  }
  const exactWindows = FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.windows.map((window) => ({
    id: window.id,
    from: normalizeExplicitIsoTimestamp(window.from, "frozen window from"),
    to: normalizeExplicitIsoTimestamp(window.to, "frozen window to"),
  }));
  if (
    stabilityValidation === null
    || !sameJson(stabilityValidation.windows, exactWindows)
    || stabilityValidation.expectedFrameIntervalMs !== 3_600_000
  ) {
    throw new Error("BROAD_LOSS_CAUSE_V1 requires the exact frozen W1/W2/W3 validation windows.");
  }
  return value;
}

function parseBroadStrategyShadowHoldout(
  values: ReadonlyMap<string, string>,
  profile: "BROAD_LOSS_CAUSE_V1" | undefined,
  simulation: IntegratedSimulationOptions,
): IntegratedStrategyEvaluationOptions["broadStrategyShadowHoldout"] {
  const fromValue = values.get("broad-shadow-holdout-from");
  const toValue = values.get("broad-shadow-holdout-to");
  if (fromValue === undefined && toValue === undefined) return undefined;
  if (fromValue === undefined || toValue === undefined) {
    throw new Error("--broad-shadow-holdout-from and --broad-shadow-holdout-to must be provided together.");
  }
  if (profile !== BROAD_STRATEGY_PROFILE) {
    throw new Error("Broad shadow holdout requires --broad-strategy-hypothesis-profile BROAD_LOSS_CAUSE_V1.");
  }
  if (
    simulation.assets.BTC?.noTradeEvidencePath === undefined
    || simulation.assets.ETH?.noTradeEvidencePath === undefined
  ) {
    throw new Error("Broad shadow holdout requires authenticated BTC and ETH no-trade evidence.");
  }
  const from = normalizeExplicitIsoTimestamp(fromValue, "--broad-shadow-holdout-from");
  const to = normalizeExplicitIsoTimestamp(toValue, "--broad-shadow-holdout-to");
  if (comparePerformanceTimestamps(from, FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentTo) < 0) {
    throw new Error("Broad shadow holdout must not overlap the frozen development range.");
  }
  if (comparePerformanceTimestamps(from, to) >= 0) {
    throw new Error("Broad shadow holdout [from,to) requires from before to.");
  }
  return { from, to };
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseCostScenarios(value: string): CostScenario[] {
  const parsed = parseJson(value, "--cost-cells");
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("--cost-cells must be a non-empty JSON array.");
  }
  const result: CostScenario[] = [];
  const ids = new Set<string>();
  const rates = new Set<string>();
  for (const [index, item] of parsed.entries()) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`--cost-cells[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    assertExactKeys(record, ["id", "feeRate", "slippageRate"], `--cost-cells[${index}]`);
    const id = requireNonEmpty(record.id, `--cost-cells[${index}].id`);
    if (ids.has(id)) throw new Error(`Duplicate cost scenario id ${id}.`);
    ids.add(id);
    const feeRate = requireFiniteNonNegativeJsonNumber(record.feeRate, "feeRate");
    const slippageRate = requireFiniteNonNegativeJsonNumber(record.slippageRate, "slippageRate");
    if (slippageRate >= 1) throw new Error("slippageRate must be less than 1.");
    const rateKey = `${feeRate}:${slippageRate}`;
    if (rates.has(rateKey)) throw new Error(`Duplicate cost rates ${rateKey}.`);
    rates.add(rateKey);
    result.push({ id, feeRate, slippageRate });
  }
  return result;
}

const STABILITY_ARGUMENTS = [
  "validation-windows",
  "validation-frame-interval-ms",
  "validation-comparison-tolerance-pp",
  "validation-minimum-windows",
] as const;

function hasAnyStabilityArgument(values: ReadonlyMap<string, string>): boolean {
  return STABILITY_ARGUMENTS.some((key) => values.has(key));
}

function parseStabilityValidation(
  values: ReadonlyMap<string, string>,
  scenarios: readonly CounterfactualScenario[],
): IntegratedStabilityValidationOptions | null {
  if (!hasAnyStabilityArgument(values)) return null;
  for (const key of STABILITY_ARGUMENTS) {
    if (!values.has(key)) throw new Error(`Stability validation requires --${key}.`);
  }
  if (!scenarios.includes("BASELINE") || !scenarios.includes("NO_ADD")) {
    throw new Error("Stability validation requires BASELINE and NO_ADD scenarios.");
  }
  const parsedWindows = parseJson(requireArgument(values, "validation-windows"), "--validation-windows");
  if (!Array.isArray(parsedWindows) || parsedWindows.length === 0) {
    throw new Error("--validation-windows must be a non-empty JSON array.");
  }
  const windows = parsedWindows.map((item, index): StabilityValidationWindow => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`--validation-windows[${index}] must be an object.`);
    }
    const record = item as Record<string, unknown>;
    assertExactKeys(record, ["id", "from", "to"], `--validation-windows[${index}]`);
    const id = requireNonEmpty(record.id, `--validation-windows[${index}].id`);
    const fromValue = requireNonEmpty(record.from, `--validation-windows[${index}].from`);
    const toValue = requireNonEmpty(record.to, `--validation-windows[${index}].to`);
    let from: string;
    let to: string;
    try {
      from = normalizeExplicitIsoTimestamp(fromValue, `--validation-windows[${index}].from`);
      to = normalizeExplicitIsoTimestamp(toValue, `--validation-windows[${index}].to`);
    } catch {
      throw new Error(`--validation-windows[${index}] timestamps require an explicit ISO-8601 timezone.`);
    }
    return { id, from, to };
  });
  return {
    windows,
    expectedFrameIntervalMs: parsePositiveSafeInteger(
      requireArgument(values, "validation-frame-interval-ms"),
      "validation-frame-interval-ms",
    ),
    comparisonTolerancePercentagePoints: parseFiniteNonNegativeNumber(
      requireArgument(values, "validation-comparison-tolerance-pp"),
      "validation-comparison-tolerance-pp",
    ),
    minimumEvaluableWindows: parsePositiveSafeInteger(
      requireArgument(values, "validation-minimum-windows"),
      "validation-minimum-windows",
    ),
  };
}

function parsePositiveSafeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (value.trim().length === 0 || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return parsed;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function parseJsonRecord(value: string, label: string): Record<string, unknown> {
  const parsed = parseJson(value, label);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}

function parseFiniteNonNegativeNumber(value: string, label: string): number {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty finite non-negative number.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
  return parsed;
}

function requireFiniteNonNegativeJsonNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number.`);
  }
  return value;
}

function requireArgument(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Missing required argument --${key}.`);
  return requireNonEmpty(value, `--${key}`);
}

function requireSimulationArgument(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Missing required simulation argument --${key}.`);
  return value;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function assertJsonCompatible(value: unknown, location = "<root>", seen = new Set<object>()): void {
  if (value === undefined) throw new Error(`Integrated evaluation ${location}: undefined is not supported.`);
  if (typeof value === "bigint") throw new Error(`Integrated evaluation ${location}: BigInt is not supported.`);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`Integrated evaluation ${location} must be finite.`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`Integrated evaluation ${location} contains unsupported ${typeof value}.`);
  }
  if (seen.has(value)) throw new Error(`Integrated evaluation ${location} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonCompatible(item, `${location}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertJsonCompatible(item, `${location}.${key}`, seen);
    }
  }
  seen.delete(value);
}

async function main(): Promise<void> {
  const options = parseIntegratedStrategyEvaluationArgs(process.argv.slice(2));
  const report = await buildIntegratedStrategyEvaluation(options);
  console.log(formatIntegratedStrategyEvaluation(report, options.format));
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Integrated strategy evaluation failed: ${message}`);
    process.exitCode = 1;
  });
}
