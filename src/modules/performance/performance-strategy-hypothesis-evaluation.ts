import {
  BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY,
  FROZEN_BROAD_LOSS_CAUSE_SCENARIO_ORDER,
} from "../strategy/position-guard-research-manifest.js";

export type StrategyHypothesisAsset = "BTC" | "ETH";
export type StrategyHypothesisTimingModel = "SAME_CLOSE_MODELED" | "NEXT_FRAME_MODELED";
export type StrategyHypothesisCostRole = "BASE" | "STRESS";
export type StrategyHypothesisScope = "FULL_PATH" | "WINDOW";
export type StrategyHypothesisStatus =
  | "REJECTED"
  | "INSUFFICIENT"
  | "ELIGIBLE_FOR_SHADOW_TEST";

export const FROZEN_STRATEGY_HYPOTHESIS_SCENARIO_ORDER =
  FROZEN_BROAD_LOSS_CAUSE_SCENARIO_ORDER;
export type StrategyHypothesisCandidate =
  typeof FROZEN_STRATEGY_HYPOTHESIS_SCENARIO_ORDER[number];

export type StrategyHypothesisManifest = {
  developmentFrom: string;
  developmentTo: string;
  windows: Array<{ id: "W1" | "W2" | "W3"; from: string; to: string }>;
  costCells: Array<{
    id: "BASE" | "STRESS";
    role: StrategyHypothesisCostRole;
    feeRate: number;
    slippageRate: number;
  }>;
  timingModels: StrategyHypothesisTimingModel[];
  scenarios: StrategyHypothesisCandidate[];
};

const MANIFEST: StrategyHypothesisManifest = {
  developmentFrom: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.developmentRange.from,
  developmentTo: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.developmentRange.to,
  windows: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.validationWindows.map((window) => ({
    ...window,
  })),
  costCells: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.costCells.map((cell) => ({ ...cell })),
  timingModels: [...BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.executionTimingModels],
  scenarios: [...BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.scenarioOrder],
};

export const FROZEN_STRATEGY_HYPOTHESIS_MANIFEST: Readonly<StrategyHypothesisManifest> =
  deepFreeze(structuredClone(MANIFEST));

export const FROZEN_STRATEGY_HYPOTHESIS_THRESHOLDS =
  BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.evaluationThresholds;

export type StrategyHypothesisMetricObservation = {
  asset: StrategyHypothesisAsset;
  candidate: string;
  scenario: string;
  timingModel: StrategyHypothesisTimingModel;
  datasetSha256: string;
  initialStateFingerprint: string;
  frameFingerprint: string;
  costCellId: "BASE" | "STRESS";
  costRole: StrategyHypothesisCostRole;
  scope: StrategyHypothesisScope;
  windowId: "W1" | "W2" | "W3" | null;
  netReturnPct: number;
  maxDrawdownPct: number;
};

export type StrategyHypothesisCoverageObservation = {
  asset: StrategyHypothesisAsset;
  candidate: string;
  timingModel: StrategyHypothesisTimingModel;
  scope: StrategyHypothesisScope;
  windowId: "W1" | "W2" | "W3" | null;
  cadenceComplete: boolean;
  independentlyVerifiedNoTrade: boolean;
  lifecycleComplete: boolean;
  feeComplete: boolean;
  finiteMetricsComplete: boolean;
  carryInStateComplete: boolean;
};

export type StrategyHypothesisSupportObservation = {
  asset: StrategyHypothesisAsset;
  candidate: string;
  timingModel: StrategyHypothesisTimingModel;
  scope: StrategyHypothesisScope;
  windowId: "W1" | "W2" | "W3" | null;
  completedEpisodeCount: number;
  policyExposedCompletedEpisodeCount: number;
};

export type StrategyHypothesisEvaluationInput = {
  manifest: StrategyHypothesisManifest;
  candidates: string[];
  metricObservations: StrategyHypothesisMetricObservation[];
  coverageObservations: StrategyHypothesisCoverageObservation[];
  supportObservations: StrategyHypothesisSupportObservation[];
};

export type StrategyHypothesisComparison = {
  timingModel: StrategyHypothesisTimingModel;
  costCellId: "BASE" | "STRESS";
  costRole: StrategyHypothesisCostRole;
  anchor: "BASELINE" | "NO_ADD";
  candidateNetReturnPct: number;
  anchorNetReturnPct: number;
  returnDeltaPercentagePoints: number;
  candidateMaxDrawdownPct: number;
  anchorMaxDrawdownPct: number;
  drawdownDeltaPercentagePoints: number;
};

export type StrategyHypothesisGate = {
  id: string;
  outcome: "PASS" | "FAIL" | "UNKNOWN";
  reason: string | null;
  observedValue: number | null;
  requiredValue: number | null;
};

export type StrategyHypothesisAssetCandidateEvaluation = {
  asset: StrategyHypothesisAsset;
  candidate: string;
  status: StrategyHypothesisStatus;
  pathProvenance: Array<{
    timingModel: StrategyHypothesisTimingModel;
    datasetSha256: string;
    initialStateFingerprint: string;
    frameFingerprint: string;
  }>;
  dataSufficiency: {
    status: "COMPLETE" | "INSUFFICIENT";
    reasons: string[];
  };
  directionalGateOutcome: {
    status: "PASS" | "FAIL" | "UNKNOWN";
    reasons: string[];
    gates: StrategyHypothesisGate[];
  };
  comparisons: {
    fullPath: StrategyHypothesisComparison[];
    windows: Array<StrategyHypothesisComparison & { windowId: "W1" | "W2" | "W3" }>;
  };
};

export type StrategyHypothesisEvaluationResult = {
  evidenceKind: "SIMULATED_STRATEGY_HYPOTHESIS_EVALUATION";
  manifest: StrategyHypothesisManifest;
  thresholds: typeof FROZEN_STRATEGY_HYPOTHESIS_THRESHOLDS;
  executionTimingProvenance: Array<{
    timingModel: StrategyHypothesisTimingModel;
    modeled: true;
    caveat: string;
    followUpRequired: string | null;
  }>;
  evaluations: StrategyHypothesisAssetCandidateEvaluation[];
  crossAssetSummary: Array<{
    candidate: string;
    adjudicative: false;
    assetStatuses: Array<{ asset: StrategyHypothesisAsset; status: StrategyHypothesisStatus }>;
  }>;
};

const ASSETS: readonly StrategyHypothesisAsset[] = ["BTC", "ETH"];
const TIMINGS: readonly StrategyHypothesisTimingModel[] =
  BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.executionTimingModels;
const WINDOWS = BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.validationWindows.map((item) => item.id);
const COSTS = BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.costCells.map((item) => item.id);
const ANCHORS = BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.anchors;
const FROZEN_CANDIDATES = new Set<string>(FROZEN_STRATEGY_HYPOTHESIS_SCENARIO_ORDER);

export function evaluateStrategyHypotheses(
  input: StrategyHypothesisEvaluationInput,
): StrategyHypothesisEvaluationResult {
  validateManifest(input.manifest);
  const candidates = validateCandidates(input.candidates);
  validateMetricObservations(input.metricObservations, candidates);
  validatePathProvenance(input.metricObservations);
  validateCanonicalAnchors(input.metricObservations);
  validateCoverageObservations(input.coverageObservations, candidates);
  validateSupportObservations(input.supportObservations, candidates);

  const evaluations = ASSETS.flatMap((asset) => candidates.map((candidate) =>
    evaluateAssetCandidate(input, asset, candidate)));

  return {
    evidenceKind: "SIMULATED_STRATEGY_HYPOTHESIS_EVALUATION",
    manifest: structuredClone(MANIFEST),
    thresholds: FROZEN_STRATEGY_HYPOTHESIS_THRESHOLDS,
    executionTimingProvenance: [
      {
        timingModel: "SAME_CLOSE_MODELED",
        modeled: true,
        caveat: "Decision and modeled fill use the same completed frame close; this can overstate executable performance.",
        followUpRequired: "Compare every directional gate with NEXT_FRAME_MODELED lag sensitivity.",
      },
      {
        timingModel: "NEXT_FRAME_MODELED",
        modeled: true,
        caveat: "Fill is delayed to the next completed frame; it remains simulated rather than observed execution.",
        followUpRequired: null,
      },
    ],
    evaluations,
    crossAssetSummary: candidates.map((candidate) => ({
      candidate,
      adjudicative: false,
      assetStatuses: ASSETS.map((asset) => ({
        asset,
        status: requireEvaluation(evaluations, asset, candidate).status,
      })),
    })),
  };
}

function evaluateAssetCandidate(
  input: StrategyHypothesisEvaluationInput,
  asset: StrategyHypothesisAsset,
  candidate: string,
): StrategyHypothesisAssetCandidateEvaluation {
  const insufficiencyReasons = buildInsufficiencyReasons(input, asset, candidate);
  const comparisons = buildComparisons(input.metricObservations, asset, candidate);
  const gates = TIMINGS.flatMap((timing) => buildTimingGates(
    input.metricObservations,
    asset,
    candidate,
    timing,
  ));
  const failureReasons = gates
    .filter((gate) => gate.outcome === "FAIL" && gate.reason !== null)
    .map((gate) => gate.reason as string);
  const hasFailure = failureReasons.length > 0;
  const hasUnknown = gates.some((gate) => gate.outcome === "UNKNOWN");
  const dataSufficiency = insufficiencyReasons.length === 0 ? "COMPLETE" : "INSUFFICIENT";
  const directionalGateOutcome = hasFailure ? "FAIL" : hasUnknown ? "UNKNOWN" : "PASS";

  return {
    asset,
    candidate,
    status: hasFailure
      ? "REJECTED"
      : dataSufficiency === "INSUFFICIENT"
        ? "INSUFFICIENT"
        : directionalGateOutcome === "PASS"
          ? "ELIGIBLE_FOR_SHADOW_TEST"
          : "INSUFFICIENT",
    pathProvenance: TIMINGS.map((timingModel) => requirePathProvenance(
      input.metricObservations,
      asset,
      timingModel,
    )),
    dataSufficiency: { status: dataSufficiency, reasons: insufficiencyReasons },
    directionalGateOutcome: {
      status: directionalGateOutcome,
      reasons: failureReasons,
      gates,
    },
    comparisons,
  };
}

function buildInsufficiencyReasons(
  input: StrategyHypothesisEvaluationInput,
  asset: StrategyHypothesisAsset,
  candidate: string,
): string[] {
  const reasons: string[] = [];
  for (const timing of TIMINGS) {
    const timingMetrics = input.metricObservations.filter((item) =>
      item.asset === asset && item.candidate === candidate && item.timingModel === timing);
    if (timingMetrics.length === 0) reasons.push(`${timing}:METRIC_EVIDENCE_MISSING`);
    for (const windowId of [null, ...WINDOWS] as const) {
      const label = windowId ?? "FULL_PATH";
      const coverage = findCoverage(input.coverageObservations, asset, candidate, timing, windowId);
      if (!coverage) {
        reasons.push(`${timing}:${label}:COVERAGE_EVIDENCE_MISSING`);
      } else {
        if (!coverage.cadenceComplete) reasons.push(`${timing}:${label}:CADENCE_INCOMPLETE`);
        if (!coverage.independentlyVerifiedNoTrade) {
          reasons.push(`${timing}:${label}:INDEPENDENTLY_VERIFIED_NO_TRADE_FALSE`);
        }
        if (!coverage.lifecycleComplete) reasons.push(`${timing}:${label}:LIFECYCLE_INCOMPLETE`);
        if (!coverage.feeComplete) reasons.push(`${timing}:${label}:FEE_INCOMPLETE`);
        if (!coverage.finiteMetricsComplete) reasons.push(`${timing}:${label}:FINITE_METRICS_INCOMPLETE`);
        if (!coverage.carryInStateComplete) reasons.push(`${timing}:${label}:CARRY_IN_STATE_INCOMPLETE`);
      }
      const support = findSupport(input.supportObservations, asset, candidate, timing, windowId);
      if (!support) {
        reasons.push(`${timing}:${label}:SUPPORT_EVIDENCE_MISSING`);
      } else if (windowId === null) {
        if (support.completedEpisodeCount
          < FROZEN_STRATEGY_HYPOTHESIS_THRESHOLDS.minimumFullPathCompletedEpisodes) {
          reasons.push(`${timing}:FULL_PATH:COMPLETED_EPISODES_BELOW_30`);
        }
      } else if (support.policyExposedCompletedEpisodeCount
        < FROZEN_STRATEGY_HYPOTHESIS_THRESHOLDS.minimumWindowPolicyExposedCompletedEpisodes) {
        reasons.push(`${timing}:${windowId}:POLICY_EXPOSED_COMPLETED_EPISODES_BELOW_10`);
      }
    }
    for (const windowId of [null, ...WINDOWS] as const) {
      for (const costCellId of COSTS) {
        for (const scenario of [...ANCHORS, candidate]) {
          if (!findMetric(input.metricObservations, asset, candidate, scenario, timing, costCellId, windowId)) {
            reasons.push(
              `${timing}:${windowId ?? "FULL_PATH"}:${costCellId}:${scenario}:METRIC_EVIDENCE_MISSING`,
            );
          }
        }
      }
    }
  }
  return reasons;
}

function buildComparisons(
  observations: StrategyHypothesisMetricObservation[],
  asset: StrategyHypothesisAsset,
  candidate: string,
): StrategyHypothesisAssetCandidateEvaluation["comparisons"] {
  const fullPath: StrategyHypothesisComparison[] = [];
  const windows: StrategyHypothesisAssetCandidateEvaluation["comparisons"]["windows"] = [];
  for (const timing of TIMINGS) {
    for (const costCellId of COSTS) {
      for (const anchor of ANCHORS) {
        const candidateMetric = findMetric(
          observations, asset, candidate, candidate, timing, costCellId, null,
        );
        const anchorMetric = findMetric(
          observations, asset, candidate, anchor, timing, costCellId, null,
        );
        if (candidateMetric && anchorMetric) {
          fullPath.push(compare(candidateMetric, anchorMetric, anchor));
        }
        for (const windowId of WINDOWS) {
          const windowCandidate = findMetric(
            observations, asset, candidate, candidate, timing, costCellId, windowId,
          );
          const windowAnchor = findMetric(
            observations, asset, candidate, anchor, timing, costCellId, windowId,
          );
          if (windowCandidate && windowAnchor) {
            windows.push({ windowId, ...compare(windowCandidate, windowAnchor, anchor) });
          }
        }
      }
    }
  }
  return { fullPath, windows };
}

function buildTimingGates(
  observations: StrategyHypothesisMetricObservation[],
  asset: StrategyHypothesisAsset,
  candidate: string,
  timing: StrategyHypothesisTimingModel,
): StrategyHypothesisGate[] {
  const baseCandidate = findMetric(observations, asset, candidate, candidate, timing, "BASE", null);
  const stressCandidate = findMetric(observations, asset, candidate, candidate, timing, "STRESS", null);
  const baseBaseline = findMetric(observations, asset, candidate, "BASELINE", timing, "BASE", null);
  const drawdownDelta = metricDelta(baseCandidate, baseBaseline, "maxDrawdownPct");

  return [
    ...ANCHORS.map((anchor) => {
      const anchorMetric = findMetric(
        observations, asset, candidate, anchor, timing, "BASE", null,
      );
      const returnDelta = metricDelta(baseCandidate, anchorMetric, "netReturnPct");
      return gate(
        `${timing}:FULL_PATH_BASE_RETURN:${anchor}`,
        returnDelta,
        returnDelta === null ? null : returnDelta > 0,
        `${timing}:FULL_PATH_BASE_RETURN_NOT_IMPROVED_VS_${anchor}`,
        0,
      );
    }),
    gate(
      `${timing}:FULL_PATH_BASE_DRAWDOWN`,
      drawdownDelta,
      drawdownDelta === null ? null : drawdownDelta <= 0,
      `${timing}:FULL_PATH_BASE_DRAWDOWN_WORSENED`,
      0,
    ),
    ...ANCHORS.map((anchor) => {
      const windowDeltas = WINDOWS.map((windowId) => metricDelta(
        findMetric(observations, asset, candidate, candidate, timing, "BASE", windowId),
        findMetric(observations, asset, candidate, anchor, timing, "BASE", windowId),
        "netReturnPct",
      ));
      const knownWindowDeltas = windowDeltas.filter((value): value is number => value !== null);
      const improvedWindowCount = knownWindowDeltas.filter((value) => value > 0).length;
      return gate(
        `${timing}:BASE_WINDOW_RETURN:${anchor}`,
        knownWindowDeltas.length === WINDOWS.length ? improvedWindowCount : null,
        knownWindowDeltas.length === WINDOWS.length
          ? improvedWindowCount >= FROZEN_STRATEGY_HYPOTHESIS_THRESHOLDS.minimumImprovedWindowCount
          : null,
        `${timing}:BASE_WINDOW_IMPROVEMENT_COUNT_BELOW_2_VS_${anchor}`,
        FROZEN_STRATEGY_HYPOTHESIS_THRESHOLDS.minimumImprovedWindowCount,
      );
    }),
    ...ANCHORS.map((anchor) => {
      const stressAnchor = findMetric(
        observations, asset, candidate, anchor, timing, "STRESS", null,
      );
      const stressDelta = metricDelta(stressCandidate, stressAnchor, "netReturnPct");
      return gate(
        `${timing}:STRESS_RETURN_RETENTION:${anchor}`,
        stressDelta,
        stressDelta === null ? null : stressDelta > 0,
        `${timing}:STRESS_RETURN_IMPROVEMENT_NOT_RETAINED_VS_${anchor}`,
        0,
      );
    }),
  ];
}

function gate(
  id: string,
  observedValue: number | null,
  passed: boolean | null,
  failureReason: string,
  requiredValue: number,
): StrategyHypothesisGate {
  return {
    id,
    outcome: passed === null ? "UNKNOWN" : passed ? "PASS" : "FAIL",
    reason: passed === false ? failureReason : null,
    observedValue,
    requiredValue,
  };
}

function compare(
  candidate: StrategyHypothesisMetricObservation,
  anchor: StrategyHypothesisMetricObservation,
  anchorName: "BASELINE" | "NO_ADD",
): StrategyHypothesisComparison {
  return {
    timingModel: candidate.timingModel,
    costCellId: candidate.costCellId,
    costRole: candidate.costRole,
    anchor: anchorName,
    candidateNetReturnPct: candidate.netReturnPct,
    anchorNetReturnPct: anchor.netReturnPct,
    returnDeltaPercentagePoints: percentagePointDelta(candidate.netReturnPct, anchor.netReturnPct),
    candidateMaxDrawdownPct: candidate.maxDrawdownPct,
    anchorMaxDrawdownPct: anchor.maxDrawdownPct,
    drawdownDeltaPercentagePoints: percentagePointDelta(
      candidate.maxDrawdownPct,
      anchor.maxDrawdownPct,
    ),
  };
}

function validateManifest(manifest: StrategyHypothesisManifest): void {
  if (JSON.stringify(manifest) !== JSON.stringify(MANIFEST)) {
    throw new Error("Evaluation requires the exact frozen development manifest.");
  }
}

function validateCandidates(candidates: string[]): string[] {
  if (candidates.length === 0) throw new Error("At least one candidate is required.");
  const seen = new Set<string>();
  let previousFrozenIndex = -1;
  for (const candidate of candidates) {
    if (!FROZEN_CANDIDATES.has(candidate)) throw new Error(`Unsupported candidate ${candidate}.`);
    if (seen.has(candidate)) throw new Error(`Duplicate candidate ${candidate}.`);
    const frozenIndex = FROZEN_STRATEGY_HYPOTHESIS_SCENARIO_ORDER.indexOf(
      candidate as StrategyHypothesisCandidate,
    );
    if (frozenIndex <= previousFrozenIndex) {
      throw new Error("Candidates must be an exact selected subsequence of frozen scenario order.");
    }
    seen.add(candidate);
    previousFrozenIndex = frozenIndex;
  }
  return [...candidates];
}

function validateMetricObservations(
  observations: StrategyHypothesisMetricObservation[],
  candidates: string[],
): void {
  const seen = new Set<string>();
  for (const observation of observations) {
    validateCommonIdentity(observation, candidates);
    if (observation.scenario !== "BASELINE"
      && observation.scenario !== "NO_ADD"
      && observation.scenario !== observation.candidate) {
      throw new Error(`Malformed scenario ${observation.scenario}.`);
    }
    const cost = MANIFEST.costCells.find((item) => item.id === observation.costCellId);
    if (!cost || cost.role !== observation.costRole) {
      throw new Error(`Metric observation ${metricOrderKey(observation)} has an invalid explicit cost role.`);
    }
    assertFinite(observation.netReturnPct, "netReturnPct");
    assertFinite(observation.maxDrawdownPct, "maxDrawdownPct");
    if (!/^[a-f0-9]{64}$/.test(observation.datasetSha256)) {
      throw new Error("datasetSha256 must be a lowercase 64-character SHA-256 value.");
    }
    assertNonEmpty(observation.initialStateFingerprint, "initialStateFingerprint");
    assertNonEmpty(observation.frameFingerprint, "frameFingerprint");
    if (observation.maxDrawdownPct < 0) throw new Error("maxDrawdownPct must be non-negative.");
    const key = metricOrderKey(observation);
    if (seen.has(key)) throw new Error(`Duplicate metric observation ${key}.`);
    seen.add(key);
  }
  validateStableOrder(observations, metricOrderKey, "Metric observations");
}

function validatePathProvenance(observations: StrategyHypothesisMetricObservation[]): void {
  const identities = new Map<string, string>();
  for (const observation of observations) {
    const pathKey = `${observation.asset}:${observation.timingModel}`;
    const identity = [
      observation.datasetSha256,
      observation.initialStateFingerprint,
      observation.frameFingerprint,
    ].join(":");
    const canonical = identities.get(pathKey);
    if (canonical !== undefined && canonical !== identity) {
      throw new Error(
        `Provenance identity mismatch for ${observation.asset} ${observation.timingModel}.`,
      );
    }
    identities.set(pathKey, identity);
  }
}

function requirePathProvenance(
  observations: StrategyHypothesisMetricObservation[],
  asset: StrategyHypothesisAsset,
  timingModel: StrategyHypothesisTimingModel,
): StrategyHypothesisAssetCandidateEvaluation["pathProvenance"][number] {
  const observation = observations.find((item) =>
    item.asset === asset && item.timingModel === timingModel);
  return {
    timingModel,
    datasetSha256: observation?.datasetSha256 ?? "",
    initialStateFingerprint: observation?.initialStateFingerprint ?? "",
    frameFingerprint: observation?.frameFingerprint ?? "",
  };
}

function validateCanonicalAnchors(observations: StrategyHypothesisMetricObservation[]): void {
  const anchors = new Map<string, string>();
  for (const observation of observations) {
    if (observation.scenario !== "BASELINE" && observation.scenario !== "NO_ADD") continue;
    const windowLabel = observation.windowId ?? "FULL_PATH";
    const key = [
      observation.asset,
      observation.timingModel,
      observation.costCellId,
      windowLabel,
      observation.scenario,
    ].join(":");
    const value = JSON.stringify({
      costRole: observation.costRole,
      scope: observation.scope,
      datasetSha256: observation.datasetSha256,
      initialStateFingerprint: observation.initialStateFingerprint,
      frameFingerprint: observation.frameFingerprint,
      netReturnPct: observation.netReturnPct,
      maxDrawdownPct: observation.maxDrawdownPct,
    });
    const canonical = anchors.get(key);
    if (canonical !== undefined && canonical !== value) {
      throw new Error(
        `Canonical anchor mismatch for ${observation.asset} ${observation.timingModel} ${observation.costCellId} ${windowLabel} ${observation.scenario}.`,
      );
    }
    anchors.set(key, value);
  }
}

function validateCoverageObservations(
  observations: StrategyHypothesisCoverageObservation[],
  candidates: string[],
): void {
  const seen = new Set<string>();
  for (const observation of observations) {
    validateCommonIdentity(observation, candidates);
    for (const [field, value] of Object.entries({
      cadenceComplete: observation.cadenceComplete,
      independentlyVerifiedNoTrade: observation.independentlyVerifiedNoTrade,
      lifecycleComplete: observation.lifecycleComplete,
      feeComplete: observation.feeComplete,
      finiteMetricsComplete: observation.finiteMetricsComplete,
      carryInStateComplete: observation.carryInStateComplete,
    })) {
      if (typeof value !== "boolean") throw new Error(`${field} must be boolean.`);
    }
    const key = commonOrderKey(observation);
    if (seen.has(key)) throw new Error(`Duplicate coverage observation ${key}.`);
    seen.add(key);
  }
  validateStableOrder(observations, commonOrderKey, "Coverage observations");
}

function validateSupportObservations(
  observations: StrategyHypothesisSupportObservation[],
  candidates: string[],
): void {
  const seen = new Set<string>();
  for (const observation of observations) {
    validateCommonIdentity(observation, candidates);
    assertCount(observation.completedEpisodeCount, "completedEpisodeCount");
    assertCount(
      observation.policyExposedCompletedEpisodeCount,
      "policyExposedCompletedEpisodeCount",
    );
    const key = commonOrderKey(observation);
    if (seen.has(key)) throw new Error(`Duplicate support observation ${key}.`);
    seen.add(key);
  }
  validateStableOrder(observations, commonOrderKey, "Support observations");
}

function validateCommonIdentity(
  observation: {
    asset: StrategyHypothesisAsset;
    candidate: string;
    timingModel: StrategyHypothesisTimingModel;
    scope: StrategyHypothesisScope;
    windowId: string | null;
  },
  candidates: string[],
): void {
  if (!ASSETS.includes(observation.asset)) throw new Error(`Unsupported asset ${observation.asset}.`);
  if (!candidates.includes(observation.candidate)) {
    throw new Error(`Observation candidate ${observation.candidate} was not declared.`);
  }
  if (!TIMINGS.includes(observation.timingModel)) {
    throw new Error(`Unsupported timing model ${observation.timingModel}.`);
  }
  if (observation.scope === "FULL_PATH") {
    if (observation.windowId !== null) throw new Error("Full-path observation window must be null.");
  } else if (observation.scope === "WINDOW") {
    if (!WINDOWS.includes(observation.windowId as typeof WINDOWS[number])) {
      throw new Error(`Unsupported validation window ${String(observation.windowId)}.`);
    }
  } else {
    throw new Error(`Unsupported observation scope ${String(observation.scope)}.`);
  }
}

function findMetric(
  observations: StrategyHypothesisMetricObservation[],
  asset: StrategyHypothesisAsset,
  candidate: string,
  scenario: string,
  timingModel: StrategyHypothesisTimingModel,
  costCellId: "BASE" | "STRESS",
  windowId: "W1" | "W2" | "W3" | null,
): StrategyHypothesisMetricObservation | undefined {
  return observations.find((item) => item.asset === asset
    && item.candidate === candidate
    && item.scenario === scenario
    && item.timingModel === timingModel
    && item.costCellId === costCellId
    && item.windowId === windowId);
}

function findCoverage(
  observations: StrategyHypothesisCoverageObservation[],
  asset: StrategyHypothesisAsset,
  candidate: string,
  timingModel: StrategyHypothesisTimingModel,
  windowId: "W1" | "W2" | "W3" | null,
): StrategyHypothesisCoverageObservation | undefined {
  return observations.find((item) => item.asset === asset
    && item.candidate === candidate
    && item.timingModel === timingModel
    && item.windowId === windowId);
}

function findSupport(
  observations: StrategyHypothesisSupportObservation[],
  asset: StrategyHypothesisAsset,
  candidate: string,
  timingModel: StrategyHypothesisTimingModel,
  windowId: "W1" | "W2" | "W3" | null,
): StrategyHypothesisSupportObservation | undefined {
  return observations.find((item) => item.asset === asset
    && item.candidate === candidate
    && item.timingModel === timingModel
    && item.windowId === windowId);
}

function metricDelta(
  candidate: StrategyHypothesisMetricObservation | undefined,
  baseline: StrategyHypothesisMetricObservation | undefined,
  field: "netReturnPct" | "maxDrawdownPct",
): number | null {
  return candidate && baseline ? candidate[field] - baseline[field] : null;
}

function metricOrderKey(item: StrategyHypothesisMetricObservation): string {
  return [
    assetOrder(item.asset),
    candidateOrder(item.candidate),
    timingOrder(item.timingModel),
    scopeOrder(item.windowId),
    costOrder(item.costCellId),
    scenarioOrder(item.scenario, item.candidate),
  ].join("|");
}

function commonOrderKey(item: {
  asset: StrategyHypothesisAsset;
  candidate: string;
  timingModel: StrategyHypothesisTimingModel;
  windowId: string | null;
}): string {
  return [
    assetOrder(item.asset),
    candidateOrder(item.candidate),
    timingOrder(item.timingModel),
    scopeOrder(item.windowId),
  ].join("|");
}

function validateStableOrder<T>(items: T[], key: (item: T) => string, label: string): void {
  for (let index = 1; index < items.length; index += 1) {
    if (compareText(key(items[index - 1] as T), key(items[index] as T)) > 0) {
      throw new Error(`${label} must use stable order.`);
    }
  }
}

function assetOrder(asset: StrategyHypothesisAsset): string {
  return asset === "BTC" ? "0" : "1";
}

function candidateOrder(candidate: string): string {
  const index = FROZEN_STRATEGY_HYPOTHESIS_SCENARIO_ORDER.indexOf(
    candidate as StrategyHypothesisCandidate,
  );
  return String(index).padStart(2, "0");
}

function timingOrder(timing: StrategyHypothesisTimingModel): string {
  return timing === "SAME_CLOSE_MODELED" ? "0" : "1";
}

function scopeOrder(windowId: string | null): string {
  return windowId === null ? "0" : windowId === "W1" ? "1" : windowId === "W2" ? "2" : "3";
}

function costOrder(costCellId: "BASE" | "STRESS"): string {
  return costCellId === "BASE" ? "0" : "1";
}

function scenarioOrder(scenario: string, candidate: string): string {
  return scenario === "BASELINE" ? "0" : scenario === "NO_ADD" ? "1" : scenario === candidate ? "2" : "9";
}

function percentagePointDelta(candidate: number, anchor: number): number {
  return Number(((candidate - anchor) * 100).toFixed(12));
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be non-empty.`);
  }
}

function requireEvaluation(
  evaluations: StrategyHypothesisAssetCandidateEvaluation[],
  asset: StrategyHypothesisAsset,
  candidate: string,
): StrategyHypothesisAssetCandidateEvaluation {
  const result = evaluations.find((item) => item.asset === asset && item.candidate === candidate);
  if (!result) throw new Error(`Missing evaluation ${asset}:${candidate}.`);
  return result;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
