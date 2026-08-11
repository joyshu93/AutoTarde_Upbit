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
  diagnosePerformance,
  type PerformanceDiagnosticsResult,
} from "../modules/performance/performance-diagnostics.js";
import {
  analyzePerformanceExcursions,
  type PerformanceExcursionResult,
} from "../modules/performance/performance-excursions.js";
import {
  analyzePerformanceRegimes,
  type PerformanceRegimeAnalysisResult,
} from "../modules/performance/performance-regimes.js";
import {
  runCostSensitivity,
  type CostScenario,
  type CostSensitivityCell,
} from "../modules/performance/performance-sensitivity.js";
import {
  readResearchCandleDataset,
  type ResearchCandleDataset,
  type ResearchDatasetProvenance,
} from "../modules/performance/research-candle-dataset.js";
import type { CounterfactualScenario } from "../modules/performance/strategy-counterfactual.js";
import {
  normalizeExplicitIsoTimestamp,
  readPerformanceInput,
  type PerformanceReadFilters,
  type PerformanceReadProvenance,
  type PerformanceReadResult,
} from "../modules/performance/sqlite-performance-reader.js";
import { comparePerformanceTimestamps } from "../modules/performance/performance-timestamp.js";
import { buildPositionGuardBacktestFrames } from "../modules/strategy/position-guard-backtest-frames.js";
import type {
  PositionGuardBacktestMetrics,
  PositionGuardBacktestState,
} from "../modules/strategy/position-guard-backtest.js";

export type IntegratedEvaluationFormat = "text" | "json";

export type SimulationInitialState = {
  cashKrw: number;
  quantity: number;
  averageEntryPriceKrw: number;
};

export type SimulationAssetOptions = {
  datasetPath: string;
  initialState: SimulationInitialState;
};

export type IntegratedSimulationOptions = {
  scenarios: readonly CounterfactualScenario[];
  minimumOrderValueKrw: number;
  costScenarios: readonly CostScenario[];
  assets: Partial<Record<SupportedAsset, SimulationAssetOptions>>;
};

export type IntegratedStrategyEvaluationOptions = {
  observed: PerformanceReadFilters;
  format: IntegratedEvaluationFormat;
  simulation: IntegratedSimulationOptions | null;
};

export type IntegratedDatasetProvenance = {
  asset: SupportedAsset;
  market: SupportedMarket;
  path: string;
  sha256: string;
  dataset: ResearchDatasetProvenance;
  initialState: SimulationInitialState;
  frameCount: number;
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
  executionPolicyId: "NO_ADD" | null;
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
  evidenceGaps: readonly IntegratedEvidenceGap[];
  interpretation: readonly InterpretationFinding[];
};

export type IntegratedEvaluationDependencies = {
  readObserved?: (filters: PerformanceReadFilters) => PerformanceReadResult;
  readDataset?: (datasetPath: string) => Promise<ResearchCandleDataset>;
};

type AssetEvaluation = {
  datasetProvenance: IntegratedDatasetProvenance;
  simulation: UnusableAssetSection | AvailableSimulationAssetSection;
  costs: UnusableCostAssetSection | AvailableCostAssetSection;
  regimes: UnusableAssetSection | AvailableRegimeAssetSection;
  excursions: UnusableAssetSection | AvailableExcursionAssetSection;
  gaps: IntegratedEvidenceGap[];
};

const ASSETS = ["BTC", "ETH"] as const satisfies readonly SupportedAsset[];
const OBSERVED_DISCLAIMER = "Selected order-stream attribution; not total account return." as const;
const CAPITAL_SEMANTICS = "INDEPENDENT_PER_ASSET_NOT_A_PORTFOLIO" as const;
const REQUIRED_COMPLETED_CANDLES = 200;
const SAMPLE_POLICY = {
  id: "OBSERVATION_COUNT_V1" as const,
  insufficientBelow: 10 as const,
  preliminaryBelow: 30 as const,
  supportedFrom: 30 as const,
  statisticalSignificanceClaim: false as const,
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
    "btc-initial-state",
    "eth-initial-state",
    "scenarios",
    "minimum-order-value-krw",
    "cost-cells",
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
  const hasDataset = values.has("btc-dataset") || values.has("eth-dataset");
  const simulationKeys = [
    "btc-dataset",
    "eth-dataset",
    "btc-initial-state",
    "eth-initial-state",
    "scenarios",
    "minimum-order-value-krw",
    "cost-cells",
  ];
  if (!hasDataset) {
    if (simulationKeys.some((key) => values.has(key))) {
      throw new Error("Simulation arguments require at least one local dataset.");
    }
    return { observed, format, simulation: null };
  }

  const assets: Partial<Record<SupportedAsset, SimulationAssetOptions>> = {};
  for (const asset of ASSETS) {
    const prefix = asset.toLowerCase();
    const datasetPath = values.get(`${prefix}-dataset`);
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
      initialState: parseInitialState(initialStateValue, `--${prefix}-initial-state`),
    };
  }

  const scenarios = parseScenarios(requireSimulationArgument(values, "scenarios"));
  const minimumOrderValueKrw = parseFiniteNonNegativeNumber(
    requireSimulationArgument(values, "minimum-order-value-krw"),
    "minimum-order-value-krw",
  );
  const costScenarios = parseCostScenarios(requireSimulationArgument(values, "cost-cells"));
  return {
    observed,
    format,
    simulation: { scenarios, minimumOrderValueKrw, costScenarios, assets },
  };
}

export async function buildIntegratedStrategyEvaluation(
  options: IntegratedStrategyEvaluationOptions,
  dependencies: IntegratedEvaluationDependencies = {},
): Promise<IntegratedStrategyEvaluationReport> {
  if (options.observed.executionMode !== "LIVE") {
    throw new Error("OBSERVED_LIVE_ATTRIBUTION requires executionMode LIVE.");
  }
  const readObserved = dependencies.readObserved ?? readPerformanceInput;
  const readDataset = dependencies.readDataset ?? readResearchCandleDataset;
  const observedRead = readObserved(options.observed);
  const observedDiagnostics = diagnosePerformance({
    fills: observedRead.tradeFills,
    ...(observedRead.input.openingPositions === undefined
      ? {}
      : { openingPositions: observedRead.input.openingPositions }),
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
    performance: calculatePerformance(observedRead.input),
    diagnostics: observedDiagnostics,
    attribution: observedAttribution,
    disclaimer: OBSERVED_DISCLAIMER,
  };

  const assetEvaluations = new Map<SupportedAsset, AssetEvaluation>();
  if (options.simulation !== null) {
    for (const asset of ASSETS) {
      const assetOptions = options.simulation.assets[asset];
      if (assetOptions === undefined) continue;
      const dataset = await readDataset(assetOptions.datasetPath);
      assetEvaluations.set(
        asset,
        evaluateAsset(asset, assetOptions, dataset, options.simulation),
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
  const baseCostScenario = options.simulation?.costScenarios[0] ?? null;
  const report: IntegratedStrategyEvaluationReport = {
    provenance: {
      observed: observedRead.provenance,
      datasets,
      scenarioAssumptions: {
        scenarios: options.simulation?.scenarios ?? [],
        baseCostScenario,
        minimumOrderValueKrw: options.simulation?.minimumOrderValueKrw ?? null,
      },
      costCells: options.simulation?.costScenarios ?? [],
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

  const gapCodes = [...new Set(report.evidenceGaps.map((gap) => gap.code))];
  lines.push(`Evidence gaps: count=${report.evidenceGaps.length}; codes=${gapCodes.join(",") || "none"}`);
  for (const finding of report.interpretation) {
    lines.push(
      `Interpretation ${finding.code}${finding.asset === null ? "" : `/${finding.asset}`}: sample_support=${finding.sampleStatus}; metrics=${finding.metricIds.join(",")}; ${finding.text}`,
    );
  }
  return lines;
}

function evaluateAsset(
  asset: SupportedAsset,
  assetOptions: SimulationAssetOptions,
  dataset: ResearchCandleDataset,
  simulationOptions: IntegratedSimulationOptions,
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
  const datasetProvenance: IntegratedDatasetProvenance = {
    asset,
    market,
    path: assetOptions.datasetPath,
    sha256: dataset.provenance.sha256,
    dataset: { ...dataset.provenance },
    initialState: { ...assetOptions.initialState },
    frameCount: frames.length,
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
  const regimeEntries: RegimeAnalysisEntry[] = [];
  const excursionEntries: ExcursionAnalysisEntry[] = [];
  const gaps: IntegratedEvidenceGap[] = [];
  for (const cell of sensitivity.cells) {
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
    gaps,
  };
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
    gaps: [{
      code: "DATASET_UNUSABLE",
      severity: "WARNING",
      evidenceKind: "SIMULATED_COUNTERFACTUAL",
      scope: "LOCAL_CANDLE_DATASET",
      asset,
      market,
      scenario: null,
      costScenarioId: null,
      affectedMetrics: ["simulatedCounterfactuals", "costSensitivity", "regimeAnalysis", "excursionAnalysis"],
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
  let code: "MARK_DATA_UNAVAILABLE" | "MARK_DATA_UNUSABLE" | "MARK_DATA_PARTIAL";
  let message: string;
  if (persisted === 0) {
    code = "MARK_DATA_UNAVAILABLE";
    message = "No persisted mark observations were selected (persisted=0, usable=0); mark-based PnL and drawdown remain not applicable without interpolation or a future observation.";
  } else if (usable === 0) {
    code = "MARK_DATA_UNUSABLE";
    message = `Persisted mark observations cannot value the selected stream (persisted=${persisted}, usable=0); mark-based PnL and drawdown remain unknown without interpolation or a future observation.`;
  } else if (usable < persisted) {
    code = "MARK_DATA_PARTIAL";
    message = `Persisted mark evidence is only partially usable (persisted=${persisted}, usable=${usable}); mark-based PnL and drawdown retain the diagnostics metric state without interpolation or a future observation.`;
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
    evidenceIds: [],
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
    affectedMetrics: ["simulatedCounterfactuals", "costSensitivity", "regimeAnalysis", "excursionAnalysis"],
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
    if (scenario !== "BASELINE" && scenario !== "NO_ADD") {
      throw new Error(`Unsupported scenario ${String(scenario)}.`);
    }
    if (seen.has(scenario)) throw new Error(`Duplicate scenario ${scenario}.`);
    seen.add(scenario);
    result.push(scenario);
  }
  return result;
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
