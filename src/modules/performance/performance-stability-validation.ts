import {
  getMarketForAsset,
  type StrategyDecisionAction,
  type SupportedAsset,
  type SupportedMarket,
} from "../../domain/types.js";
import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
  type PerformanceTimestamp,
} from "./performance-timestamp.js";

export type StabilityScenario = "BASELINE" | "NO_ADD";
export type StabilityPolicyExposure = "ADD_SUPPRESSED";
export type StabilitySampleSupportStatus = "INSUFFICIENT" | "PRELIMINARY" | "SUPPORTED";
export type StabilityCoverageStatus = "COMPLETE" | "PARTIAL";
export type StabilityDirection = "NO_ADD_BETTER" | "TIED" | "NO_ADD_WORSE" | "NOT_COMPARABLE";
export type StabilityWindowClassification =
  | "NO_ADD_BETTER"
  | "TIED"
  | "NO_ADD_WORSE"
  | "NO_POLICY_EXPOSURE"
  | "INSUFFICIENT_EVIDENCE";
export type StabilityOverallClassification =
  | "CONSISTENT_POSITIVE"
  | "CONSISTENT_NON_POSITIVE"
  | "MIXED"
  | "INSUFFICIENT_EVIDENCE";

export type StabilityValidationWindow = {
  id: string;
  from: string;
  to: string;
};

export type StabilityFrameObservation = {
  generatedAt: string;
  equityKrw: number;
  decisionAction: StrategyDecisionAction;
  policyExposure: StabilityPolicyExposure | null;
};

export type StabilityFillObservation = {
  id: string;
  filledAt: string;
  priceKrw: number;
  volume: number;
  feeKrw: number | null;
};

export type StabilityEpisodeObservation = {
  id: string;
  openedAt: string;
  closedAt: string | null;
  status: "OPEN" | "COMPLETED";
};

export type StabilityScenarioPath = {
  scenario: StabilityScenario;
  initialEquityKrw: number;
  frames: StabilityFrameObservation[];
  fills: StabilityFillObservation[];
  episodes: StabilityEpisodeObservation[];
};

export type PerformanceStabilityInput = {
  asset: SupportedAsset;
  market: SupportedMarket;
  costScenarioId: string;
  expectedFrameIntervalMs: number;
  comparisonTolerancePercentagePoints: number;
  minimumEvaluableWindows: number;
  windows: StabilityValidationWindow[];
  paths: StabilityScenarioPath[];
};

export type StabilityPeriodMetrics = {
  scenario: StabilityScenario;
  startEquityKrw: number;
  endEquityKrw: number | null;
  periodReturnPct: number | null;
  maxDrawdownPct: number | null;
  frameCount: number;
  fillCount: number;
  turnoverKrw: number;
  feesKrw: number | null;
  feeCompleteness: "COMPLETE" | "INCOMPLETE";
  completedEpisodeCount: number;
  carryInCompletedEpisodeCount: number;
  policyExposureCount: number;
};

export type StabilityCoverage = {
  expectedFrameCount: number;
  observedFrameCount: number;
  missingFrameCount: number;
  coverageRatio: number;
  status: StabilityCoverageStatus;
};

export type StabilitySampleSupport = {
  policy: "COMPLETED_EPISODE_COUNT_V1";
  unit: "MINIMUM_SCENARIO_COMPLETED_EPISODES";
  completedEpisodeCount: number;
  baselineCompletedEpisodeCount: number;
  noAddCompletedEpisodeCount: number;
  policyExposureCount: number;
  requiredCount: 30;
  status: StabilitySampleSupportStatus;
};

export type StabilityWindowResult = {
  window: StabilityValidationWindow;
  coverage: StabilityCoverage;
  baseline: StabilityPeriodMetrics;
  noAdd: StabilityPeriodMetrics;
  returnDeltaPercentagePoints: number | null;
  direction: StabilityDirection;
  sampleSupport: StabilitySampleSupport;
  classification: StabilityWindowClassification;
};

export type PerformanceStabilityResult = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL_STABILITY";
  asset: SupportedAsset;
  market: SupportedMarket;
  costScenarioId: string;
  periodSemantics: "[from,to)";
  pathSemantics: "CONTINUOUS_FORWARD_PATH_NO_WINDOW_RESET";
  futureObservationPolicy: "OBSERVATIONS_AT_OR_AFTER_TO_EXCLUDED";
  expectedFrameIntervalMs: number;
  comparisonTolerancePercentagePoints: number;
  minimumEvaluableWindows: number;
  windows: StabilityWindowResult[];
  overall: {
    evaluableWindowCount: number;
    betterWindowCount: number;
    tiedWindowCount: number;
    worseWindowCount: number;
    insufficientWindowCount: number;
    noPolicyExposureWindowCount: number;
    classification: StabilityOverallClassification;
    statisticalSignificanceClaim: false;
  };
};

type NormalizedWindow = StabilityValidationWindow & {
  fromTimestamp: PerformanceTimestamp;
  toTimestamp: PerformanceTimestamp;
  expectedFrameCount: number;
};

type ValidatedPath = StabilityScenarioPath & {
  frameTimestamps: PerformanceTimestamp[];
  fillTimestamps: PerformanceTimestamp[];
  episodeTimestamps: Array<{
    openedAt: PerformanceTimestamp;
    closedAt: PerformanceTimestamp | null;
  }>;
};

const ACTIONS = ["ENTER", "ADD", "REDUCE", "EXIT", "HOLD"] as const;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

export function validatePerformanceStability(
  input: PerformanceStabilityInput,
): PerformanceStabilityResult {
  validateConfiguration(input);
  const intervalNanoseconds = BigInt(input.expectedFrameIntervalMs) * NANOSECONDS_PER_MILLISECOND;
  const windows = validateWindows(input.windows, intervalNanoseconds);
  const paths = validatePaths(input.paths);
  const baseline = paths.get("BASELINE");
  const noAdd = paths.get("NO_ADD");
  if (!baseline || !noAdd || paths.size !== 2) {
    throw new Error("Stability validation requires exactly one path for each of BASELINE and NO_ADD.");
  }
  validatePairedFrameTimestamps(baseline, noAdd);

  const windowResults = windows.map((window) => buildWindowResult(
    window,
    baseline,
    noAdd,
    intervalNanoseconds,
    input.comparisonTolerancePercentagePoints,
  ));
  const evaluable = windowResults.filter((item) =>
    item.classification === "NO_ADD_BETTER"
    || item.classification === "TIED"
    || item.classification === "NO_ADD_WORSE");
  const betterWindowCount = evaluable.filter((item) => item.direction === "NO_ADD_BETTER").length;
  const tiedWindowCount = evaluable.filter((item) => item.direction === "TIED").length;
  const worseWindowCount = evaluable.filter((item) => item.direction === "NO_ADD_WORSE").length;

  return {
    evidenceKind: "SIMULATED_COUNTERFACTUAL_STABILITY",
    asset: input.asset,
    market: input.market,
    costScenarioId: input.costScenarioId,
    periodSemantics: "[from,to)",
    pathSemantics: "CONTINUOUS_FORWARD_PATH_NO_WINDOW_RESET",
    futureObservationPolicy: "OBSERVATIONS_AT_OR_AFTER_TO_EXCLUDED",
    expectedFrameIntervalMs: input.expectedFrameIntervalMs,
    comparisonTolerancePercentagePoints: input.comparisonTolerancePercentagePoints,
    minimumEvaluableWindows: input.minimumEvaluableWindows,
    windows: windowResults,
    overall: {
      evaluableWindowCount: evaluable.length,
      betterWindowCount,
      tiedWindowCount,
      worseWindowCount,
      insufficientWindowCount: windowResults.filter(
        (item) => item.classification === "INSUFFICIENT_EVIDENCE",
      ).length,
      noPolicyExposureWindowCount: windowResults.filter(
        (item) => item.classification === "NO_POLICY_EXPOSURE",
      ).length,
      classification: classifyOverall(
        evaluable.length,
        betterWindowCount,
        tiedWindowCount,
        worseWindowCount,
        input.minimumEvaluableWindows,
      ),
      statisticalSignificanceClaim: false,
    },
  };
}

function validateConfiguration(input: PerformanceStabilityInput): void {
  if (getMarketForAsset(input.asset) !== input.market) {
    throw new Error(`Stability validation market ${input.market} does not match asset ${input.asset}.`);
  }
  if (input.costScenarioId.trim().length === 0) {
    throw new Error("costScenarioId must be non-empty.");
  }
  if (!Number.isSafeInteger(input.expectedFrameIntervalMs) || input.expectedFrameIntervalMs <= 0) {
    throw new Error("expectedFrameIntervalMs must be a positive safe integer.");
  }
  assertFiniteNonNegative(
    input.comparisonTolerancePercentagePoints,
    "comparisonTolerancePercentagePoints",
  );
  if (!Number.isSafeInteger(input.minimumEvaluableWindows) || input.minimumEvaluableWindows <= 0) {
    throw new Error("minimumEvaluableWindows must be a positive safe integer.");
  }
}

function validateWindows(
  candidates: StabilityValidationWindow[],
  intervalNanoseconds: bigint,
): NormalizedWindow[] {
  if (candidates.length === 0) throw new Error("Stability validation requires at least one window.");
  const ids = new Set<string>();
  const result: NormalizedWindow[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (candidate.id.trim().length === 0) throw new Error("Window id must be non-empty.");
    if (ids.has(candidate.id)) throw new Error(`Duplicate window id ${candidate.id}.`);
    ids.add(candidate.id);
    const fromTimestamp = requireTimestamp(candidate.from, `Window ${candidate.id} from`);
    const toTimestamp = requireTimestamp(candidate.to, `Window ${candidate.id} to`);
    if (compareEpochNanoseconds(fromTimestamp.epochNanoseconds, toTimestamp.epochNanoseconds) >= 0) {
      throw new Error(`Window ${candidate.id} from must be before to.`);
    }
    const duration = toTimestamp.epochNanoseconds - fromTimestamp.epochNanoseconds;
    if (duration % intervalNanoseconds !== 0n) {
      throw new Error(`Window ${candidate.id} duration must be divisible by expectedFrameIntervalMs.`);
    }
    const expectedBigInt = duration / intervalNanoseconds;
    const expectedFrameCount = Number(expectedBigInt);
    if (!Number.isSafeInteger(expectedFrameCount) || expectedFrameCount <= 0) {
      throw new Error(`Window ${candidate.id} expectedFrameCount must be a positive safe integer.`);
    }

    const previous = result[index - 1];
    if (previous) {
      if (compareEpochNanoseconds(previous.fromTimestamp.epochNanoseconds, fromTimestamp.epochNanoseconds) >= 0) {
        throw new Error("Validation windows must be strictly ordered by from instant.");
      }
      if (compareEpochNanoseconds(previous.toTimestamp.epochNanoseconds, fromTimestamp.epochNanoseconds) > 0) {
        throw new Error(`Validation windows ${previous.id} and ${candidate.id} overlap.`);
      }
    }
    result.push({
      id: candidate.id,
      from: fromTimestamp.normalized,
      to: toTimestamp.normalized,
      fromTimestamp,
      toTimestamp,
      expectedFrameCount,
    });
  }
  return result;
}

function validatePaths(candidates: StabilityScenarioPath[]): Map<StabilityScenario, ValidatedPath> {
  const result = new Map<StabilityScenario, ValidatedPath>();
  for (const candidate of candidates) {
    if (candidate.scenario !== "BASELINE" && candidate.scenario !== "NO_ADD") {
      throw new Error(`Unsupported stability scenario ${String(candidate.scenario)}.`);
    }
    if (result.has(candidate.scenario)) {
      throw new Error("Stability validation requires exactly one path for each of BASELINE and NO_ADD.");
    }
    assertFinitePositive(candidate.initialEquityKrw, `${candidate.scenario} initialEquityKrw`);
    const frameTimestamps = validateFrames(candidate);
    const fillTimestamps = validateFills(candidate);
    const episodeTimestamps = validateEpisodes(candidate);
    result.set(candidate.scenario, {
      ...candidate,
      frameTimestamps,
      fillTimestamps,
      episodeTimestamps,
    });
  }
  if (result.size !== 2 || !result.has("BASELINE") || !result.has("NO_ADD")) {
    throw new Error("Stability validation requires exactly one path for each of BASELINE and NO_ADD.");
  }
  return result;
}

function validateFrames(path: StabilityScenarioPath): PerformanceTimestamp[] {
  const timestamps: PerformanceTimestamp[] = [];
  for (let index = 0; index < path.frames.length; index += 1) {
    const frame = path.frames[index]!;
    const timestamp = requireTimestamp(frame.generatedAt, `${path.scenario} frame ${index} generatedAt`);
    const previous = timestamps[index - 1];
    if (previous && compareEpochNanoseconds(previous.epochNanoseconds, timestamp.epochNanoseconds) >= 0) {
      throw new Error(`${path.scenario} frame timestamps must be strictly ordered without duplicates.`);
    }
    assertFiniteNonNegative(frame.equityKrw, `${path.scenario} frame ${index} equityKrw`);
    if (!ACTIONS.includes(frame.decisionAction)) {
      throw new Error(`${path.scenario} frame ${index} decisionAction is invalid.`);
    }
    if (frame.policyExposure !== null && frame.policyExposure !== "ADD_SUPPRESSED") {
      throw new Error(`${path.scenario} frame ${index} policyExposure is invalid.`);
    }
    if (path.scenario === "BASELINE" && frame.policyExposure !== null) {
      throw new Error("BASELINE frames cannot contain NO_ADD policy exposure.");
    }
    if (frame.policyExposure === "ADD_SUPPRESSED" && frame.decisionAction !== "ADD") {
      throw new Error("ADD_SUPPRESSED policy exposure requires decisionAction ADD.");
    }
    timestamps.push(timestamp);
  }
  return timestamps;
}

function validateFills(path: StabilityScenarioPath): PerformanceTimestamp[] {
  const ids = new Set<string>();
  return path.fills.map((fill, index) => {
    if (fill.id.trim().length === 0) throw new Error(`${path.scenario} fill id must be non-empty.`);
    if (ids.has(fill.id)) throw new Error(`Duplicate fill id ${fill.id}.`);
    ids.add(fill.id);
    const timestamp = requireTimestamp(fill.filledAt, `${path.scenario} fill ${fill.id} filledAt`);
    assertFinitePositive(fill.priceKrw, `${path.scenario} fill ${index} priceKrw`);
    assertFinitePositive(fill.volume, `${path.scenario} fill ${index} volume`);
    if (fill.feeKrw !== null) {
      assertFiniteNonNegative(fill.feeKrw, `${path.scenario} fill ${index} feeKrw`);
    }
    return timestamp;
  });
}

function validateEpisodes(path: StabilityScenarioPath): ValidatedPath["episodeTimestamps"] {
  const ids = new Set<string>();
  return path.episodes.map((episode) => {
    if (episode.id.trim().length === 0) throw new Error(`${path.scenario} episode id must be non-empty.`);
    if (ids.has(episode.id)) throw new Error(`Duplicate episode id ${episode.id}.`);
    ids.add(episode.id);
    const openedAt = requireTimestamp(episode.openedAt, `${path.scenario} episode ${episode.id} openedAt`);
    if (episode.status === "OPEN") {
      if (episode.closedAt !== null) throw new Error(`Open episode ${episode.id} must not have closedAt.`);
      return { openedAt, closedAt: null };
    }
    if (episode.status !== "COMPLETED" || episode.closedAt === null) {
      throw new Error(`Completed episode ${episode.id} must have closedAt.`);
    }
    const closedAt = requireTimestamp(episode.closedAt, `${path.scenario} episode ${episode.id} closedAt`);
    if (compareEpochNanoseconds(openedAt.epochNanoseconds, closedAt.epochNanoseconds) > 0) {
      throw new Error(`Episode ${episode.id} openedAt must not be after closedAt.`);
    }
    return { openedAt, closedAt };
  });
}

function validatePairedFrameTimestamps(baseline: ValidatedPath, noAdd: ValidatedPath): void {
  if (baseline.frameTimestamps.length !== noAdd.frameTimestamps.length) {
    throw new Error("BASELINE and NO_ADD paired frame timestamps must have equal length.");
  }
  for (let index = 0; index < baseline.frameTimestamps.length; index += 1) {
    if (baseline.frameTimestamps[index]?.epochNanoseconds !== noAdd.frameTimestamps[index]?.epochNanoseconds) {
      throw new Error(`BASELINE and NO_ADD paired frame timestamps differ at index ${index}.`);
    }
  }
}

function buildWindowResult(
  window: NormalizedWindow,
  baselinePath: ValidatedPath,
  noAddPath: ValidatedPath,
  intervalNanoseconds: bigint,
  tolerancePercentagePoints: number,
): StabilityWindowResult {
  const baseline = slicePath(window, baselinePath);
  const noAdd = slicePath(window, noAddPath);
  const coverage = calculateCoverage(window, baselinePath, intervalNanoseconds);
  const returnDeltaPercentagePoints = baseline.periodReturnPct === null || noAdd.periodReturnPct === null
    ? null
    : finiteRounded(
        (noAdd.periodReturnPct - baseline.periodReturnPct) * 100,
        `Window ${window.id} return delta`,
      );
  const direction = classifyDirection(returnDeltaPercentagePoints, tolerancePercentagePoints);
  const completedEpisodeCount = Math.min(
    baseline.completedEpisodeCount,
    noAdd.completedEpisodeCount,
  );
  const sampleSupport: StabilitySampleSupport = {
    policy: "COMPLETED_EPISODE_COUNT_V1",
    unit: "MINIMUM_SCENARIO_COMPLETED_EPISODES",
    completedEpisodeCount,
    baselineCompletedEpisodeCount: baseline.completedEpisodeCount,
    noAddCompletedEpisodeCount: noAdd.completedEpisodeCount,
    policyExposureCount: noAdd.policyExposureCount,
    requiredCount: 30,
    status: classifySampleSupport(completedEpisodeCount),
  };

  return {
    window: { id: window.id, from: window.from, to: window.to },
    coverage,
    baseline,
    noAdd,
    returnDeltaPercentagePoints,
    direction,
    sampleSupport,
    classification: classifyWindow(coverage, sampleSupport, direction),
  };
}

function slicePath(window: NormalizedWindow, path: ValidatedPath): StabilityPeriodMetrics {
  const frameIndexes = indexesInWindow(path.frameTimestamps, window);
  const priorFrameIndex = lastIndexBefore(path.frameTimestamps, window.fromTimestamp.epochNanoseconds);
  const startEquityKrw = priorFrameIndex < 0
    ? path.initialEquityKrw
    : path.frames[priorFrameIndex]!.equityKrw;
  const endFrameIndex = frameIndexes.at(-1);
  const endEquityKrw = endFrameIndex === undefined ? null : path.frames[endFrameIndex]!.equityKrw;
  const periodReturnPct = endEquityKrw === null || startEquityKrw === 0
    ? null
    : finiteRounded(
        (endEquityKrw - startEquityKrw) / startEquityKrw,
        `${path.scenario} window ${window.id} periodReturnPct`,
      );
  const maxDrawdownPct = endEquityKrw === null
    ? null
    : calculateDrawdown(
        startEquityKrw,
        frameIndexes.map((index) => path.frames[index]!.equityKrw),
        `${path.scenario} window ${window.id}`,
      );
  const fillIndexes = indexesInWindow(path.fillTimestamps, window);
  let turnoverKrw = 0;
  let feesKrw = 0;
  let feesComplete = true;
  for (const index of fillIndexes) {
    const fill = path.fills[index]!;
    const fillTurnover = fill.priceKrw * fill.volume;
    if (!Number.isFinite(fillTurnover)) {
      throw new Error(`${path.scenario} fill ${fill.id} turnover must be finite.`);
    }
    turnoverKrw += fillTurnover;
    if (!Number.isFinite(turnoverKrw)) {
      throw new Error(`${path.scenario} window ${window.id} turnover must be finite.`);
    }
    if (fill.feeKrw === null) {
      feesComplete = false;
    } else {
      feesKrw += fill.feeKrw;
      if (!Number.isFinite(feesKrw)) {
        throw new Error(`${path.scenario} window ${window.id} fees must be finite.`);
      }
    }
  }
  const completedEpisodeIndexes = path.episodeTimestamps.flatMap((timestamps, index) =>
    timestamps.closedAt !== null && isInWindow(timestamps.closedAt.epochNanoseconds, window)
      ? [index]
      : []);
  const carryInCompletedEpisodeCount = completedEpisodeIndexes.filter((index) =>
    path.episodeTimestamps[index]!.openedAt.epochNanoseconds < window.fromTimestamp.epochNanoseconds
  ).length;

  return {
    scenario: path.scenario,
    startEquityKrw,
    endEquityKrw,
    periodReturnPct,
    maxDrawdownPct,
    frameCount: frameIndexes.length,
    fillCount: fillIndexes.length,
    turnoverKrw: finiteRounded(turnoverKrw, `${path.scenario} window ${window.id} turnoverKrw`),
    feesKrw: feesComplete
      ? finiteRounded(feesKrw, `${path.scenario} window ${window.id} feesKrw`)
      : null,
    feeCompleteness: feesComplete ? "COMPLETE" : "INCOMPLETE",
    completedEpisodeCount: completedEpisodeIndexes.length,
    carryInCompletedEpisodeCount,
    policyExposureCount: frameIndexes.filter(
      (index) => path.frames[index]!.policyExposure === "ADD_SUPPRESSED",
    ).length,
  };
}

function calculateCoverage(
  window: NormalizedWindow,
  path: ValidatedPath,
  intervalNanoseconds: bigint,
): StabilityCoverage {
  const indexes = indexesInWindow(path.frameTimestamps, window);
  for (const index of indexes) {
    const offset = path.frameTimestamps[index]!.epochNanoseconds - window.fromTimestamp.epochNanoseconds;
    if (offset % intervalNanoseconds !== 0n) {
      throw new Error(`Window ${window.id} contains a frame that is not aligned to expectedFrameIntervalMs.`);
    }
  }
  if (indexes.length > window.expectedFrameCount) {
    throw new Error(`Window ${window.id} observedFrameCount exceeds expectedFrameCount.`);
  }
  const missingFrameCount = window.expectedFrameCount - indexes.length;
  return {
    expectedFrameCount: window.expectedFrameCount,
    observedFrameCount: indexes.length,
    missingFrameCount,
    coverageRatio: finiteRounded(indexes.length / window.expectedFrameCount, `Window ${window.id} coverageRatio`),
    status: missingFrameCount === 0 ? "COMPLETE" : "PARTIAL",
  };
}

function indexesInWindow(timestamps: PerformanceTimestamp[], window: NormalizedWindow): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    if (isInWindow(timestamps[index]!.epochNanoseconds, window)) indexes.push(index);
  }
  return indexes;
}

function lastIndexBefore(timestamps: PerformanceTimestamp[], boundary: bigint): number {
  let result = -1;
  for (let index = 0; index < timestamps.length; index += 1) {
    if (timestamps[index]!.epochNanoseconds >= boundary) break;
    result = index;
  }
  return result;
}

function isInWindow(value: bigint, window: NormalizedWindow): boolean {
  return value >= window.fromTimestamp.epochNanoseconds && value < window.toTimestamp.epochNanoseconds;
}

function calculateDrawdown(startEquityKrw: number, equities: number[], label: string): number {
  let peak = startEquityKrw;
  let maximum = 0;
  for (const equity of equities) {
    peak = Math.max(peak, equity);
    const drawdown = peak > 0 ? (peak - equity) / peak : 0;
    if (!Number.isFinite(drawdown) || drawdown < 0) {
      throw new Error(`${label} maxDrawdownPct must be finite and non-negative.`);
    }
    maximum = Math.max(maximum, drawdown);
  }
  return finiteRounded(maximum, `${label} maxDrawdownPct`);
}

function classifySampleSupport(completedEpisodeCount: number): StabilitySampleSupportStatus {
  return completedEpisodeCount < 10
    ? "INSUFFICIENT"
    : completedEpisodeCount < 30
      ? "PRELIMINARY"
      : "SUPPORTED";
}

function classifyDirection(
  deltaPercentagePoints: number | null,
  tolerancePercentagePoints: number,
): StabilityDirection {
  if (deltaPercentagePoints === null) return "NOT_COMPARABLE";
  if (deltaPercentagePoints > tolerancePercentagePoints) return "NO_ADD_BETTER";
  if (deltaPercentagePoints < -tolerancePercentagePoints) return "NO_ADD_WORSE";
  return "TIED";
}

function classifyWindow(
  coverage: StabilityCoverage,
  sampleSupport: StabilitySampleSupport,
  direction: StabilityDirection,
): StabilityWindowClassification {
  if (coverage.status !== "COMPLETE" || direction === "NOT_COMPARABLE") {
    return "INSUFFICIENT_EVIDENCE";
  }
  if (sampleSupport.policyExposureCount === 0) return "NO_POLICY_EXPOSURE";
  if (sampleSupport.status === "INSUFFICIENT") return "INSUFFICIENT_EVIDENCE";
  return direction;
}

function classifyOverall(
  evaluableWindowCount: number,
  betterWindowCount: number,
  tiedWindowCount: number,
  worseWindowCount: number,
  minimumEvaluableWindows: number,
): StabilityOverallClassification {
  if (evaluableWindowCount < minimumEvaluableWindows) return "INSUFFICIENT_EVIDENCE";
  if (betterWindowCount === evaluableWindowCount) return "CONSISTENT_POSITIVE";
  if (betterWindowCount === 0 && tiedWindowCount + worseWindowCount === evaluableWindowCount) {
    return "CONSISTENT_NON_POSITIVE";
  }
  return "MIXED";
}

function requireTimestamp(value: string, label: string): PerformanceTimestamp {
  const timestamp = parsePerformanceTimestamp(value);
  if (!timestamp) throw new Error(`${label} must be an ISO-8601 timestamp with an explicit timezone.`);
  return timestamp;
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be finite and positive.`);
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be finite and non-negative.`);
}

function finiteRounded(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return Number(value.toPrecision(15));
}
