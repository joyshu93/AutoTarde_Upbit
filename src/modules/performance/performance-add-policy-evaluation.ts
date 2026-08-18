import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
  type PerformanceTimestamp,
} from "./performance-timestamp.js";

export type AddPolicyCandidate =
  | "ADD_RISK_CLEAR"
  | "ADD_HIGH_ALIGNMENT"
  | "ADD_CORE_TREND";
export type AddPolicyEvaluationScenario = "BASELINE" | "NO_ADD" | AddPolicyCandidate;
export type AddPolicyEvaluationCostRole = "BASE" | "STRESS";
export type AddPolicyEvaluationStatus =
  | "ELIGIBLE_FOR_FURTHER_RESEARCH"
  | "REJECTED"
  | "INSUFFICIENT";
export type AddPolicyGateStatus = "PASS" | "FAIL" | "INSUFFICIENT";

export type AddPolicyEvaluationThresholds = {
  minimumFullPathReturnDeltaPercentagePoints: number;
  minimumBaseWindowReturnDeltaPercentagePoints: number;
  minimumPositiveStressWindowCount: number;
  requiredStressWindowCount: number;
  minimumStressWindowReturnDeltaPercentagePoints: number;
  maximumFullPathDrawdownDeltaPercentagePoints: number;
  maximumStressWindowDrawdownDeltaPercentagePoints: number;
  minimumFullPathPolicyExposedCompletedEpisodes: number;
  minimumWindowPolicyExposedCompletedEpisodes: number;
};

export const APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS: Readonly<AddPolicyEvaluationThresholds> =
  Object.freeze({
    minimumFullPathReturnDeltaPercentagePoints: 0,
    minimumBaseWindowReturnDeltaPercentagePoints: 0,
    minimumPositiveStressWindowCount: 2,
    requiredStressWindowCount: 3,
    minimumStressWindowReturnDeltaPercentagePoints: -0.5,
    maximumFullPathDrawdownDeltaPercentagePoints: 0,
    maximumStressWindowDrawdownDeltaPercentagePoints: 1,
    minimumFullPathPolicyExposedCompletedEpisodes: 30,
    minimumWindowPolicyExposedCompletedEpisodes: 10,
  });

export type AddPolicyEvaluationObservation = {
  scenario: AddPolicyEvaluationScenario;
  costRole: AddPolicyEvaluationCostRole;
  costScenarioId: string;
  feeRate: number;
  slippageRate: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
};

export type AddPolicyEvaluationCoverage = {
  status: "COMPLETE" | "INCOMPLETE";
  windowCadenceStatus: "COMPLETE" | "INCOMPLETE";
  windowSequenceContinuityStatus: "COMPLETE" | "INCOMPLETE";
  windowClockGridStatus: "DENSE" | "SPARSE_BY_CONTRACT" | "ANOMALOUS";
  upstreamStateContinuityStatus: "COMPLETE" | "INCOMPLETE";
  featureLookbackContinuityStatus: "COMPLETE" | "INCOMPLETE";
  expectedFrameIntervalMs: number;
  firstExpectedFrameAt: string;
  endExclusiveAt: string;
  expectedFrameCount: number;
  observedFrameCount: number;
  noTradeFrameCount: number;
  noTradeRanges: AddPolicyCadenceGap[];
  missingFrameCount: number;
  duplicateFrameCount: number;
  offGridFrameCount: number;
  missingRanges: AddPolicyCadenceGap[];
  duplicateInstants: AddPolicyCadenceOccurrence[];
  offGridInstants: AddPolicyCadenceOccurrence[];
  upstreamExpectedFrameCount: number;
  upstreamObservedFrameCount: number;
  upstreamSequenceContinuityStatus: "COMPLETE" | "INCOMPLETE";
  upstreamClockGridStatus: "DENSE" | "SPARSE_BY_CONTRACT" | "ANOMALOUS";
  upstreamNoTradeFrameCount: number;
  upstreamNoTradeRanges: AddPolicyCadenceGap[];
  upstreamFirstExpectedFrameAt: string | null;
  upstreamEndExclusiveAt: string | null;
  upstreamMissingFrameCount: number;
  upstreamDuplicateFrameCount: number;
  upstreamOffGridFrameCount: number;
  upstreamMissingRanges: AddPolicyCadenceGap[];
  upstreamDuplicateInstants: AddPolicyCadenceOccurrence[];
  upstreamOffGridInstants: AddPolicyCadenceOccurrence[];
  featureLookbackAffectedFrameCount: number;
  featureLookbackAffectedRanges: AddPolicyAffectedFrameRange[];
};

export type AddPolicyCadenceOccurrence = {
  observedAt: string;
  occurrenceCount: number;
};

export type AddPolicyAffectedFrameRange = {
  firstFrameAt: string;
  lastFrameAt: string;
  affectedFrameCount: number;
};

export type AddPolicyCadenceGap = {
  firstMissingAt: string;
  lastMissingAt: string;
  missingFrameCount: number;
  previousObservedAt: string | null;
  nextObservedAt: string | null;
};

export type AddPolicyEvaluationWindow = {
  id: string;
  from: string;
  to: string;
  coverage: AddPolicyEvaluationCoverage;
  policyExposedCompletedEpisodeCount: number;
  observations: AddPolicyEvaluationObservation[];
};

export type AddPolicyCandidateEvaluationInput = {
  asset: "BTC" | "ETH";
  candidate: AddPolicyCandidate;
  baseSlippageRate: number;
  thresholds: AddPolicyEvaluationThresholds;
  fullPath: {
    coverage: AddPolicyEvaluationCoverage;
    policyExposedCompletedEpisodeCount: number;
    observations: AddPolicyEvaluationObservation[];
  };
  windows: AddPolicyEvaluationWindow[];
};

export type AddPolicyReturnComparison = {
  costRole: AddPolicyEvaluationCostRole;
  anchor: "BASELINE" | "NO_ADD";
  candidateReturnPct: number;
  anchorReturnPct: number;
  deltaPercentagePoints: number;
  thresholdPercentagePoints: number;
  operator: ">";
  passed: boolean;
};

export type AddPolicyAnchorComparison = {
  costRole: AddPolicyEvaluationCostRole;
  anchor: "BASELINE" | "NO_ADD";
  candidateReturnPct: number;
  anchorReturnPct: number;
  returnDeltaPercentagePoints: number;
  candidateMaxDrawdownPct: number;
  anchorMaxDrawdownPct: number;
  drawdownDeltaPercentagePoints: number;
};

type WindowReturnObservation = {
  windowId: string;
  candidateReturnPct: number;
  baselineReturnPct: number;
  deltaPercentagePoints: number;
  thresholdPercentagePoints: number;
  passed: boolean;
};

type StressWindowReturnObservation = WindowReturnObservation & {
  positive: boolean;
  floorPassed: boolean;
};

type DrawdownObservation = {
  costRole?: AddPolicyEvaluationCostRole;
  windowId?: string;
  candidateMaxDrawdownPct: number;
  baselineMaxDrawdownPct: number;
  deltaPercentagePoints: number;
  maximumDeltaPercentagePoints: number;
  passed: boolean;
};

export type AddPolicyCandidateEvaluationResult = {
  evidenceKind: "SIMULATED_CONDITIONAL_ADD_POLICY_EVALUATION";
  asset: "BTC" | "ETH";
  candidate: AddPolicyCandidate;
  status: AddPolicyEvaluationStatus;
  periodSemantics: "[from,to)";
  costAnchors: Record<AddPolicyEvaluationCostRole, {
    costScenarioId: string;
    feeRate: number;
    slippageRate: number;
  }>;
  thresholds: AddPolicyEvaluationThresholds;
  observations: {
    fullPath: AddPolicyCandidateEvaluationInput["fullPath"];
    windows: AddPolicyEvaluationWindow[];
  };
  anchorComparisons: {
    fullPath: AddPolicyAnchorComparison[];
    windows: Array<{
      windowId: string;
      evaluable: boolean;
      comparisons: AddPolicyAnchorComparison[];
    }>;
  };
  gates: {
    fullPathNetReturn: {
      status: "PASS" | "FAIL";
      comparisons: AddPolicyReturnComparison[];
    };
    baseWindowReturn: {
      status: "PASS" | "FAIL";
      observations: WindowReturnObservation[];
    };
    stressWindowReturn: {
      status: "PASS" | "FAIL";
      requiredPositiveWindowCount: number;
      positiveWindowCount: number;
      observations: StressWindowReturnObservation[];
    };
    fullPathMaxDrawdown: {
      status: "PASS" | "FAIL";
      observations: DrawdownObservation[];
    };
    stressWindowMaxDrawdown: {
      status: "PASS" | "FAIL";
      observations: DrawdownObservation[];
    };
    policyExposedCompletedEpisodes: {
      status: "PASS" | "INSUFFICIENT";
      fullPathObservedCount: number;
      fullPathRequiredCount: number;
      windows: Array<{
        windowId: string;
        evaluable: boolean;
        observedCount: number;
        requiredCount: number;
        passed: boolean | null;
      }>;
    };
    frameCoverage: {
      status: "PASS" | "INSUFFICIENT";
      fullPath: AddPolicyEvaluationCoverage & { passed: boolean };
      windows: Array<AddPolicyEvaluationCoverage & {
        windowId: string;
        passed: boolean;
      }>;
    };
  };
  statisticalSignificanceClaim: false;
};

type ValidatedWindow = AddPolicyEvaluationWindow & {
  fromTimestamp: PerformanceTimestamp;
  toTimestamp: PerformanceTimestamp;
};

const CANDIDATES: readonly AddPolicyCandidate[] = [
  "ADD_RISK_CLEAR",
  "ADD_HIGH_ALIGNMENT",
  "ADD_CORE_TREND",
];
const COST_ROLES: readonly AddPolicyEvaluationCostRole[] = ["BASE", "STRESS"];
const ANCHORS = ["BASELINE", "NO_ADD"] as const;

export function evaluateAddPolicyCandidate(
  input: AddPolicyCandidateEvaluationInput,
): AddPolicyCandidateEvaluationResult {
  validateIdentity(input);
  validateThresholds(input.thresholds);
  assertFiniteSlippageRate(input.baseSlippageRate, "baseSlippageRate");
  validateCoverage(input.fullPath.coverage, "Full-path");
  validateEpisodeCount(
    input.fullPath.policyExposedCompletedEpisodeCount,
    "Full-path policy-exposed completed episode count",
  );
  const costAnchors = validateObservationMatrix(
    input.fullPath.observations,
    input.candidate,
    input.baseSlippageRate,
    "Full path",
  );
  const windows = validateWindows(input, costAnchors);
  const evaluableWindows = windows.filter((window) => window.coverage.status === "COMPLETE");

  const fullPathNetReturn = buildFullPathReturnGate(input);
  const baseWindowReturn = buildBaseWindowReturnGate(input, evaluableWindows);
  const stressWindowReturn = buildStressWindowReturnGate(input, evaluableWindows);
  const fullPathMaxDrawdown = buildFullPathDrawdownGate(input);
  const stressWindowMaxDrawdown = buildStressWindowDrawdownGate(input, evaluableWindows);
  const policyExposedCompletedEpisodes = buildSupportGate(input, windows);
  const frameCoverage = buildCoverageGate(input.fullPath, windows);
  const insufficient = policyExposedCompletedEpisodes.status === "INSUFFICIENT"
    || frameCoverage.status === "INSUFFICIENT";
  const failedPerformance = [
    fullPathNetReturn,
    baseWindowReturn,
    stressWindowReturn,
    fullPathMaxDrawdown,
    stressWindowMaxDrawdown,
  ].some((gate) => gate.status === "FAIL");

  return {
    evidenceKind: "SIMULATED_CONDITIONAL_ADD_POLICY_EVALUATION",
    asset: input.asset,
    candidate: input.candidate,
    status: insufficient
      ? "INSUFFICIENT"
      : failedPerformance
        ? "REJECTED"
        : "ELIGIBLE_FOR_FURTHER_RESEARCH",
    periodSemantics: "[from,to)",
    costAnchors,
    thresholds: { ...APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS },
    observations: {
      fullPath: {
        coverage: copyCoverage(input.fullPath.coverage),
        policyExposedCompletedEpisodeCount: input.fullPath.policyExposedCompletedEpisodeCount,
        observations: input.fullPath.observations.map(copyObservation),
      },
      windows: windows.map(({ fromTimestamp: _from, toTimestamp: _to, ...window }) => ({
        ...window,
        coverage: copyCoverage(window.coverage),
        observations: window.observations.map(copyObservation),
      })),
    },
    anchorComparisons: {
      fullPath: buildAnchorComparisons(input.fullPath.observations, input.candidate),
      windows: windows.map((window) => ({
        windowId: window.id,
        evaluable: window.coverage.status === "COMPLETE",
        comparisons: window.coverage.status === "COMPLETE"
          ? buildAnchorComparisons(window.observations, input.candidate)
          : [],
      })),
    },
    gates: {
      fullPathNetReturn,
      baseWindowReturn,
      stressWindowReturn,
      fullPathMaxDrawdown,
      stressWindowMaxDrawdown,
      policyExposedCompletedEpisodes,
      frameCoverage,
    },
    statisticalSignificanceClaim: false,
  };
}

function buildAnchorComparisons(
  observations: AddPolicyEvaluationObservation[],
  candidateScenario: AddPolicyCandidate,
): AddPolicyAnchorComparison[] {
  return COST_ROLES.flatMap((costRole) => ANCHORS.map((anchor) => {
    const candidate = requireObservation(observations, candidateScenario, costRole);
    const anchorObservation = requireObservation(observations, anchor, costRole);
    return {
      costRole,
      anchor,
      candidateReturnPct: candidate.totalReturnPct,
      anchorReturnPct: anchorObservation.totalReturnPct,
      returnDeltaPercentagePoints: percentagePointDifference(
        candidate.totalReturnPct,
        anchorObservation.totalReturnPct,
        `${costRole} ${anchor} return delta`,
      ),
      candidateMaxDrawdownPct: candidate.maxDrawdownPct,
      anchorMaxDrawdownPct: anchorObservation.maxDrawdownPct,
      drawdownDeltaPercentagePoints: percentagePointDifference(
        candidate.maxDrawdownPct,
        anchorObservation.maxDrawdownPct,
        `${costRole} ${anchor} drawdown delta`,
      ),
    };
  }));
}

function validateIdentity(input: AddPolicyCandidateEvaluationInput): void {
  if (input.asset !== "BTC" && input.asset !== "ETH") {
    throw new Error(`Unsupported ADD policy evaluation asset ${String(input.asset)}.`);
  }
  if (!CANDIDATES.includes(input.candidate)) {
    throw new Error(`Unsupported ADD policy candidate ${String(input.candidate)}.`);
  }
}

function validateThresholds(thresholds: AddPolicyEvaluationThresholds): void {
  const finiteFields: Array<[number, string]> = [
    [thresholds.minimumFullPathReturnDeltaPercentagePoints, "minimumFullPathReturnDeltaPercentagePoints"],
    [thresholds.minimumBaseWindowReturnDeltaPercentagePoints, "minimumBaseWindowReturnDeltaPercentagePoints"],
    [thresholds.minimumStressWindowReturnDeltaPercentagePoints, "minimumStressWindowReturnDeltaPercentagePoints"],
    [thresholds.maximumFullPathDrawdownDeltaPercentagePoints, "maximumFullPathDrawdownDeltaPercentagePoints"],
    [thresholds.maximumStressWindowDrawdownDeltaPercentagePoints, "maximumStressWindowDrawdownDeltaPercentagePoints"],
  ];
  for (const [value, field] of finiteFields) assertFinite(value, `Threshold ${field}`);
  validatePositiveCount(thresholds.minimumPositiveStressWindowCount, "minimumPositiveStressWindowCount");
  validatePositiveCount(thresholds.requiredStressWindowCount, "requiredStressWindowCount");
  validatePositiveCount(
    thresholds.minimumFullPathPolicyExposedCompletedEpisodes,
    "minimumFullPathPolicyExposedCompletedEpisodes",
  );
  validatePositiveCount(
    thresholds.minimumWindowPolicyExposedCompletedEpisodes,
    "minimumWindowPolicyExposedCompletedEpisodes",
  );
  if (thresholds.minimumPositiveStressWindowCount > thresholds.requiredStressWindowCount) {
    throw new Error("minimumPositiveStressWindowCount cannot exceed requiredStressWindowCount.");
  }
  for (const key of Object.keys(
    APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS,
  ) as Array<keyof AddPolicyEvaluationThresholds>) {
    if (thresholds[key] !== APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS[key]) {
      throw new Error(`ADD policy evaluation must use the approved threshold ${key}.`);
    }
  }
}

function validateWindows(
  input: AddPolicyCandidateEvaluationInput,
  anchors: AddPolicyCandidateEvaluationResult["costAnchors"],
): ValidatedWindow[] {
  if (input.windows.length !== input.thresholds.requiredStressWindowCount) {
    throw new Error(
      `ADD policy evaluation requires exactly ${input.thresholds.requiredStressWindowCount} validation windows.`,
    );
  }
  const ids = new Set<string>();
  const result: ValidatedWindow[] = [];
  for (const window of input.windows) {
    if (window.id.trim().length === 0) throw new Error("Validation window id must be non-empty.");
    if (ids.has(window.id)) throw new Error(`Duplicate validation window id ${window.id}.`);
    ids.add(window.id);
    const fromTimestamp = requireTimestamp(window.from, `Window ${window.id} from`);
    const toTimestamp = requireTimestamp(window.to, `Window ${window.id} to`);
    if (compareEpochNanoseconds(fromTimestamp.epochNanoseconds, toTimestamp.epochNanoseconds) >= 0) {
      throw new Error(`Window ${window.id} from must be before to.`);
    }
    const previous = result[result.length - 1];
    if (previous) {
      if (compareEpochNanoseconds(previous.fromTimestamp.epochNanoseconds, fromTimestamp.epochNanoseconds) >= 0) {
        throw new Error("Validation windows must be strictly ordered by from instant.");
      }
      if (compareEpochNanoseconds(previous.toTimestamp.epochNanoseconds, fromTimestamp.epochNanoseconds) > 0) {
        throw new Error(`Validation windows ${previous.id} and ${window.id} overlap.`);
      }
    }
    validateCoverage(window.coverage, `Window ${window.id}`);
    validateEpisodeCount(
      window.policyExposedCompletedEpisodeCount,
      `Window ${window.id} policy-exposed completed episode count`,
    );
    const windowAnchors = validateObservationMatrix(
      window.observations,
      input.candidate,
      input.baseSlippageRate,
      `Window ${window.id}`,
    );
    for (const role of COST_ROLES) {
      if (windowAnchors[role].costScenarioId !== anchors[role].costScenarioId) {
        throw new Error(
          `Window ${window.id} cost anchor ${role} must be ${anchors[role].costScenarioId}.`,
        );
      }
    }
    result.push({
      ...window,
      from: fromTimestamp.normalized,
      to: toTimestamp.normalized,
      coverage: copyCoverage(window.coverage),
      observations: window.observations.map(copyObservation),
      fromTimestamp,
      toTimestamp,
    });
  }
  return result;
}

function validateCoverage(coverage: AddPolicyEvaluationCoverage, label: string): void {
  validatePositiveCount(coverage.expectedFrameIntervalMs, `${label} expectedFrameIntervalMs`);
  validatePositiveCount(coverage.expectedFrameCount, `${label} expectedFrameCount`);
  validateEpisodeCount(coverage.observedFrameCount, `${label} observedFrameCount`);
  validateEpisodeCount(coverage.noTradeFrameCount, `${label} noTradeFrameCount`);
  validateEpisodeCount(coverage.missingFrameCount, `${label} missingFrameCount`);
  validateEpisodeCount(coverage.duplicateFrameCount, `${label} duplicateFrameCount`);
  validateEpisodeCount(coverage.offGridFrameCount, `${label} offGridFrameCount`);
  validateEpisodeCount(coverage.upstreamExpectedFrameCount, `${label} upstreamExpectedFrameCount`);
  validateEpisodeCount(coverage.upstreamObservedFrameCount, `${label} upstreamObservedFrameCount`);
  validateEpisodeCount(coverage.upstreamNoTradeFrameCount, `${label} upstreamNoTradeFrameCount`);
  validateEpisodeCount(coverage.upstreamMissingFrameCount, `${label} upstreamMissingFrameCount`);
  validateEpisodeCount(coverage.upstreamDuplicateFrameCount, `${label} upstreamDuplicateFrameCount`);
  validateEpisodeCount(coverage.upstreamOffGridFrameCount, `${label} upstreamOffGridFrameCount`);
  validateEpisodeCount(
    coverage.featureLookbackAffectedFrameCount,
    `${label} featureLookbackAffectedFrameCount`,
  );
  if (coverage.status !== "COMPLETE" && coverage.status !== "INCOMPLETE") {
    throw new Error(`${label} coverage status must be COMPLETE or INCOMPLETE.`);
  }
  for (const [field, status] of [
    ["windowCadenceStatus", coverage.windowCadenceStatus],
    ["windowSequenceContinuityStatus", coverage.windowSequenceContinuityStatus],
    ["upstreamStateContinuityStatus", coverage.upstreamStateContinuityStatus],
    ["upstreamSequenceContinuityStatus", coverage.upstreamSequenceContinuityStatus],
    ["featureLookbackContinuityStatus", coverage.featureLookbackContinuityStatus],
  ] as const) {
    if (status !== "COMPLETE" && status !== "INCOMPLETE") {
      throw new Error(`${label} ${field} must be COMPLETE or INCOMPLETE.`);
    }
  }
  for (const [field, status] of [
    ["windowClockGridStatus", coverage.windowClockGridStatus],
    ["upstreamClockGridStatus", coverage.upstreamClockGridStatus],
  ] as const) {
    if (status !== "DENSE" && status !== "SPARSE_BY_CONTRACT" && status !== "ANOMALOUS") {
      throw new Error(`${label} ${field} must be DENSE, SPARSE_BY_CONTRACT, or ANOMALOUS.`);
    }
  }
  const intervalNanoseconds = BigInt(coverage.expectedFrameIntervalMs) * 1_000_000n;
  const firstExpected = requireTimestamp(coverage.firstExpectedFrameAt, `${label} firstExpectedFrameAt`);
  const endExclusive = requireTimestamp(coverage.endExclusiveAt, `${label} endExclusiveAt`);
  validateCadenceBounds(
    firstExpected,
    endExclusive,
    intervalNanoseconds,
    coverage.expectedFrameCount,
    `${label} cadence`,
  );
  validateGapRanges(
    coverage.noTradeRanges,
    coverage.noTradeFrameCount,
    `${label} noTradeRanges`,
    firstExpected,
    endExclusive,
    intervalNanoseconds,
  );
  validateGapRanges(
    coverage.missingRanges,
    coverage.missingFrameCount,
    `${label} missingRanges`,
    firstExpected,
    endExclusive,
    intervalNanoseconds,
  );
  validateDisjointGapRanges(
    coverage.noTradeRanges,
    coverage.missingRanges,
    `${label} noTradeRanges`,
    `${label} missingRanges`,
  );
  validateCountConservation(
    coverage.observedFrameCount,
    coverage.noTradeFrameCount,
    coverage.missingFrameCount,
    coverage.expectedFrameCount,
    `${label} window`,
  );
  validateOccurrenceManifest(
    coverage.duplicateInstants,
    coverage.duplicateFrameCount,
    `${label} duplicateInstants`,
    "DUPLICATE",
    firstExpected,
    endExclusive,
    intervalNanoseconds,
  );
  validateOccurrenceManifest(
    coverage.offGridInstants,
    coverage.offGridFrameCount,
    `${label} offGridInstants`,
    "OFF_GRID",
    firstExpected,
    endExclusive,
    intervalNanoseconds,
  );
  const upstreamBounds = validateUpstreamBounds(coverage, label, intervalNanoseconds);
  validateGapRanges(
    coverage.upstreamNoTradeRanges,
    coverage.upstreamNoTradeFrameCount,
    `${label} upstreamNoTradeRanges`,
    upstreamBounds.first,
    upstreamBounds.end,
    intervalNanoseconds,
  );
  validateGapRanges(
    coverage.upstreamMissingRanges,
    coverage.upstreamMissingFrameCount,
    `${label} upstreamMissingRanges`,
    upstreamBounds.first,
    upstreamBounds.end,
    intervalNanoseconds,
  );
  validateDisjointGapRanges(
    coverage.upstreamNoTradeRanges,
    coverage.upstreamMissingRanges,
    `${label} upstreamNoTradeRanges`,
    `${label} upstreamMissingRanges`,
  );
  validateCountConservation(
    coverage.upstreamObservedFrameCount,
    coverage.upstreamNoTradeFrameCount,
    coverage.upstreamMissingFrameCount,
    coverage.upstreamExpectedFrameCount,
    `${label} upstream`,
  );
  validateOccurrenceManifest(
    coverage.upstreamDuplicateInstants,
    coverage.upstreamDuplicateFrameCount,
    `${label} upstreamDuplicateInstants`,
    "DUPLICATE",
    upstreamBounds.first,
    upstreamBounds.end,
    intervalNanoseconds,
  );
  validateOccurrenceManifest(
    coverage.upstreamOffGridInstants,
    coverage.upstreamOffGridFrameCount,
    `${label} upstreamOffGridInstants`,
    "OFF_GRID",
    upstreamBounds.first,
    upstreamBounds.end,
    intervalNanoseconds,
  );
  validateAffectedFrameRanges(
    coverage.featureLookbackAffectedRanges,
    coverage.featureLookbackAffectedFrameCount,
    `${label} featureLookbackAffectedRanges`,
    firstExpected,
    endExclusive,
    intervalNanoseconds,
  );
  const expectedWindowStatus = (
    coverage.observedFrameCount !== coverage.expectedFrameCount
    || coverage.noTradeFrameCount !== 0
    || coverage.missingFrameCount !== 0
    || coverage.duplicateFrameCount !== 0
    || coverage.offGridFrameCount !== 0
    || coverage.missingRanges.length !== 0
    || coverage.duplicateInstants.length !== 0
    || coverage.offGridInstants.length !== 0
  ) ? "INCOMPLETE" : "COMPLETE";
  if (coverage.windowCadenceStatus !== expectedWindowStatus) {
    throw new Error(`${label} windowCadenceStatus must match its cadence evidence.`);
  }
  const expectedWindowSequenceStatus = coverage.missingFrameCount !== 0
    || coverage.duplicateFrameCount !== 0
    || coverage.offGridFrameCount !== 0
    || coverage.missingRanges.length !== 0
    || coverage.duplicateInstants.length !== 0
    || coverage.offGridInstants.length !== 0
    ? "INCOMPLETE"
    : "COMPLETE";
  if (coverage.windowSequenceContinuityStatus !== expectedWindowSequenceStatus) {
    throw new Error(`${label} windowSequenceContinuityStatus must match its cadence evidence.`);
  }
  const expectedWindowClockGridStatus = expectedWindowSequenceStatus === "INCOMPLETE"
    ? "ANOMALOUS"
    : coverage.noTradeFrameCount > 0
      ? "SPARSE_BY_CONTRACT"
      : "DENSE";
  if (coverage.windowClockGridStatus !== expectedWindowClockGridStatus) {
    throw new Error(`${label} windowClockGridStatus must match its cadence evidence.`);
  }
  const expectedUpstreamSequenceStatus = coverage.upstreamMissingFrameCount !== 0
    || coverage.upstreamDuplicateFrameCount !== 0
    || coverage.upstreamOffGridFrameCount !== 0
    || coverage.upstreamMissingRanges.length !== 0
    || coverage.upstreamDuplicateInstants.length !== 0
    || coverage.upstreamOffGridInstants.length !== 0
    ? "INCOMPLETE"
    : "COMPLETE";
  if (coverage.upstreamSequenceContinuityStatus !== expectedUpstreamSequenceStatus) {
    throw new Error(`${label} upstreamSequenceContinuityStatus must match its cadence evidence.`);
  }
  const expectedUpstreamClockGridStatus = expectedUpstreamSequenceStatus === "INCOMPLETE"
    ? "ANOMALOUS"
    : coverage.upstreamNoTradeFrameCount > 0
      ? "SPARSE_BY_CONTRACT"
      : "DENSE";
  if (coverage.upstreamClockGridStatus !== expectedUpstreamClockGridStatus) {
    throw new Error(`${label} upstreamClockGridStatus must match its cadence evidence.`);
  }
  if (coverage.upstreamStateContinuityStatus !== coverage.upstreamSequenceContinuityStatus) {
    throw new Error(`${label} upstreamStateContinuityStatus must equal upstreamSequenceContinuityStatus.`);
  }
  const expectedFeatureStatus = coverage.featureLookbackAffectedFrameCount === 0
    && coverage.featureLookbackAffectedRanges.length === 0
    ? "COMPLETE"
    : "INCOMPLETE";
  if (coverage.featureLookbackContinuityStatus !== expectedFeatureStatus) {
    throw new Error(`${label} featureLookbackContinuityStatus must match its affected-frame evidence.`);
  }
  const expectedOverallStatus = coverage.windowSequenceContinuityStatus === "COMPLETE"
    && coverage.upstreamSequenceContinuityStatus === "COMPLETE"
    && coverage.upstreamStateContinuityStatus === "COMPLETE"
    && coverage.featureLookbackContinuityStatus === "COMPLETE"
    ? "COMPLETE"
    : "INCOMPLETE";
  if (coverage.status !== expectedOverallStatus) {
    throw new Error(`${label} coverage status must match window cadence and upstream continuity.`);
  }
}

function validateGapRanges(
  ranges: readonly AddPolicyCadenceGap[],
  expectedMissingFrameCount: number,
  label: string,
  firstExpected: PerformanceTimestamp | null,
  endExclusive: PerformanceTimestamp | null,
  intervalNanoseconds: bigint,
): void {
  let total = 0;
  let previousLast: PerformanceTimestamp | null = null;
  for (const [index, range] of ranges.entries()) {
    validatePositiveCount(range.missingFrameCount, `${label}[${index}] missingFrameCount`);
    const first = requireTimestamp(range.firstMissingAt, `${label}[${index}] firstMissingAt`);
    const last = requireTimestamp(range.lastMissingAt, `${label}[${index}] lastMissingAt`);
    if (compareEpochNanoseconds(first.epochNanoseconds, last.epochNanoseconds) > 0) {
      throw new Error(`${label}[${index}] firstMissingAt must be at or before lastMissingAt.`);
    }
    const span = last.epochNanoseconds - first.epochNanoseconds;
    if (span % intervalNanoseconds !== 0n || span / intervalNanoseconds + 1n !== BigInt(range.missingFrameCount)) {
      throw new Error(`${label}[${index}] timestamp span must match missingFrameCount.`);
    }
    if (firstExpected === null || endExclusive === null
      || first.epochNanoseconds < firstExpected.epochNanoseconds
      || last.epochNanoseconds >= endExclusive.epochNanoseconds) {
      throw new Error(`${label}[${index}] must be inside its cadence bounds.`);
    }
    if ((first.epochNanoseconds - firstExpected.epochNanoseconds) % intervalNanoseconds !== 0n) {
      throw new Error(`${label}[${index}] must align to expectedFrameIntervalMs.`);
    }
    if (previousLast !== null && first.epochNanoseconds - previousLast.epochNanoseconds <= intervalNanoseconds) {
      throw new Error(`${label} must be sorted, non-overlapping, and non-adjacent.`);
    }
    for (const [field, value] of [
      ["previousObservedAt", range.previousObservedAt],
      ["nextObservedAt", range.nextObservedAt],
    ] as const) {
      if (value !== null) {
        const observed = requireTimestamp(value, `${label}[${index}] ${field}`);
        const expectedObserved = field === "previousObservedAt"
          ? first.epochNanoseconds - intervalNanoseconds
          : last.epochNanoseconds + intervalNanoseconds;
        if (observed.epochNanoseconds !== expectedObserved) {
          throw new Error(`${label}[${index}] ${field} must be adjacent to the missing range.`);
        }
      }
    }
    total += range.missingFrameCount;
    previousLast = last;
  }
  if (total !== expectedMissingFrameCount) {
    throw new Error(`${label} counts must sum to missingFrameCount.`);
  }
}

function validateDisjointGapRanges(
  left: readonly AddPolicyCadenceGap[],
  right: readonly AddPolicyCadenceGap[],
  leftLabel: string,
  rightLabel: string,
): void {
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftRange = left[leftIndex]!;
    const rightRange = right[rightIndex]!;
    const leftFirst = requireTimestamp(leftRange.firstMissingAt, `${leftLabel}[${leftIndex}] firstMissingAt`);
    const leftLast = requireTimestamp(leftRange.lastMissingAt, `${leftLabel}[${leftIndex}] lastMissingAt`);
    const rightFirst = requireTimestamp(rightRange.firstMissingAt, `${rightLabel}[${rightIndex}] firstMissingAt`);
    const rightLast = requireTimestamp(rightRange.lastMissingAt, `${rightLabel}[${rightIndex}] lastMissingAt`);
    if (leftFirst.epochNanoseconds <= rightLast.epochNanoseconds
      && rightFirst.epochNanoseconds <= leftLast.epochNanoseconds) {
      throw new Error(`${leftLabel} must not overlap ${rightLabel}.`);
    }
    if (leftLast.epochNanoseconds < rightLast.epochNanoseconds) leftIndex += 1;
    else rightIndex += 1;
  }
}

function validateCountConservation(
  observed: number,
  noTrade: number,
  missing: number,
  expected: number,
  label: string,
): void {
  if (observed + noTrade + missing !== expected) {
    throw new Error(`${label} count conservation requires observed + noTrade + missing to equal expected.`);
  }
}

function validateCadenceBounds(
  first: PerformanceTimestamp,
  end: PerformanceTimestamp,
  intervalNanoseconds: bigint,
  expectedCount: number,
  label: string,
): void {
  const duration = end.epochNanoseconds - first.epochNanoseconds;
  if (duration <= 0n || duration % intervalNanoseconds !== 0n
    || duration / intervalNanoseconds !== BigInt(expectedCount)) {
    throw new Error(`${label} bounds must match expectedFrameCount and expectedFrameIntervalMs.`);
  }
}

function validateUpstreamBounds(
  coverage: AddPolicyEvaluationCoverage,
  label: string,
  intervalNanoseconds: bigint,
): { first: PerformanceTimestamp | null; end: PerformanceTimestamp | null } {
  if (coverage.upstreamExpectedFrameCount === 0) {
    if (coverage.upstreamFirstExpectedFrameAt !== null || coverage.upstreamEndExclusiveAt !== null) {
      throw new Error(`${label} empty upstream cadence must use null bounds.`);
    }
    return { first: null, end: null };
  }
  if (coverage.upstreamFirstExpectedFrameAt === null || coverage.upstreamEndExclusiveAt === null) {
    throw new Error(`${label} non-empty upstream cadence requires explicit bounds.`);
  }
  const first = requireTimestamp(coverage.upstreamFirstExpectedFrameAt, `${label} upstreamFirstExpectedFrameAt`);
  const end = requireTimestamp(coverage.upstreamEndExclusiveAt, `${label} upstreamEndExclusiveAt`);
  validateCadenceBounds(first, end, intervalNanoseconds, coverage.upstreamExpectedFrameCount, `${label} upstream cadence`);
  return { first, end };
}

function validateOccurrenceManifest(
  occurrences: readonly AddPolicyCadenceOccurrence[],
  expectedCount: number,
  label: string,
  kind: "DUPLICATE" | "OFF_GRID",
  first: PerformanceTimestamp | null,
  end: PerformanceTimestamp | null,
  intervalNanoseconds: bigint,
): void {
  let total = 0;
  let previous: PerformanceTimestamp | null = null;
  for (const [index, occurrence] of occurrences.entries()) {
    const observed = requireTimestamp(occurrence.observedAt, `${label}[${index}] observedAt`);
    validatePositiveCount(occurrence.occurrenceCount, `${label}[${index}] occurrenceCount`);
    if (kind === "DUPLICATE" && occurrence.occurrenceCount < 2) {
      throw new Error(`${label}[${index}] duplicate occurrenceCount must be at least 2.`);
    }
    if (first === null || end === null || observed.epochNanoseconds < first.epochNanoseconds
      || observed.epochNanoseconds >= end.epochNanoseconds) {
      throw new Error(`${label}[${index}] must be inside its cadence bounds.`);
    }
    if (kind === "OFF_GRID" && (observed.epochNanoseconds - first.epochNanoseconds) % intervalNanoseconds === 0n) {
      throw new Error(`${label}[${index}] must be off the expected cadence grid.`);
    }
    if (previous !== null && observed.epochNanoseconds <= previous.epochNanoseconds) {
      throw new Error(`${label} must be strictly ordered by instant.`);
    }
    total += kind === "DUPLICATE" ? occurrence.occurrenceCount - 1 : occurrence.occurrenceCount;
    previous = observed;
  }
  if (total !== expectedCount) throw new Error(`${label} counts must match its frame count.`);
}

function validateAffectedFrameRanges(
  ranges: readonly AddPolicyAffectedFrameRange[],
  expectedCount: number,
  label: string,
  firstExpected: PerformanceTimestamp,
  endExclusive: PerformanceTimestamp,
  intervalNanoseconds: bigint,
): void {
  let total = 0;
  let previousLast: PerformanceTimestamp | null = null;
  for (const [index, range] of ranges.entries()) {
    validatePositiveCount(range.affectedFrameCount, `${label}[${index}] affectedFrameCount`);
    const first = requireTimestamp(range.firstFrameAt, `${label}[${index}] firstFrameAt`);
    const last = requireTimestamp(range.lastFrameAt, `${label}[${index}] lastFrameAt`);
    const span = last.epochNanoseconds - first.epochNanoseconds;
    if (span < 0n || span % intervalNanoseconds !== 0n
      || span / intervalNanoseconds + 1n !== BigInt(range.affectedFrameCount)) {
      throw new Error(`${label}[${index}] timestamp span must match affectedFrameCount.`);
    }
    if (first.epochNanoseconds < firstExpected.epochNanoseconds
      || last.epochNanoseconds >= endExclusive.epochNanoseconds) {
      throw new Error(`${label}[${index}] must be inside its cadence bounds.`);
    }
    if ((first.epochNanoseconds - firstExpected.epochNanoseconds) % intervalNanoseconds !== 0n) {
      throw new Error(`${label}[${index}] must align to expectedFrameIntervalMs.`);
    }
    if (previousLast !== null && first.epochNanoseconds - previousLast.epochNanoseconds <= intervalNanoseconds) {
      throw new Error(`${label} must be sorted, non-overlapping, and non-adjacent.`);
    }
    total += range.affectedFrameCount;
    previousLast = last;
  }
  if (total !== expectedCount) throw new Error(`${label} counts must sum to featureLookbackAffectedFrameCount.`);
}

function validateObservationMatrix(
  observations: AddPolicyEvaluationObservation[],
  candidate: AddPolicyCandidate,
  baseSlippageRate: number,
  label: string,
): AddPolicyCandidateEvaluationResult["costAnchors"] {
  const expectedScenarios: readonly AddPolicyEvaluationScenario[] = [candidate, ...ANCHORS];
  const seen = new Set<string>();
  const anchors: Partial<AddPolicyCandidateEvaluationResult["costAnchors"]> = {};
  for (const observation of observations) {
    if (!expectedScenarios.includes(observation.scenario)) {
      throw new Error(`${label} contains unsupported scenario ${String(observation.scenario)}.`);
    }
    if (!COST_ROLES.includes(observation.costRole)) {
      throw new Error(`${label} contains unsupported cost role ${String(observation.costRole)}.`);
    }
    const key = `${observation.scenario}:${observation.costRole}`;
    if (seen.has(key)) throw new Error(`${label} contains duplicate ${key} observation.`);
    seen.add(key);
    if (observation.costScenarioId.trim().length === 0) {
      throw new Error(`${label} costScenarioId must be non-empty.`);
    }
    assertFiniteNonNegative(observation.feeRate, `${label} ${key} feeRate`);
    assertFiniteSlippageRate(observation.slippageRate, `${label} ${key} slippageRate`);
    const expectedFeeRate = observation.costRole === "BASE" ? 0.0005 : 0.001;
    const expectedSlippageRate = observation.costRole === "BASE" ? baseSlippageRate : 0.002;
    if (observation.feeRate !== expectedFeeRate) {
      throw new Error(`${label} ${key} ${observation.costRole} feeRate must be ${expectedFeeRate}.`);
    }
    if (observation.slippageRate !== expectedSlippageRate) {
      throw new Error(
        `${label} ${key} ${observation.costRole} slippageRate must be ${expectedSlippageRate}.`,
      );
    }
    const existingAnchor = anchors[observation.costRole];
    if (existingAnchor !== undefined && existingAnchor.costScenarioId !== observation.costScenarioId) {
      throw new Error(`${label} cost anchor ${observation.costRole} must use one costScenarioId.`);
    }
    anchors[observation.costRole] = {
      costScenarioId: observation.costScenarioId,
      feeRate: observation.feeRate,
      slippageRate: observation.slippageRate,
    };
    assertFinite(observation.totalReturnPct, `${label} ${key} totalReturnPct`);
    assertFinite(observation.maxDrawdownPct, `${label} ${key} maxDrawdownPct`);
    if (observation.maxDrawdownPct < 0) {
      throw new Error(`${label} ${key} maxDrawdownPct must be non-negative.`);
    }
  }
  for (const scenario of expectedScenarios) {
    for (const role of COST_ROLES) {
      if (!seen.has(`${scenario}:${role}`)) {
        throw new Error(`${label} requires exactly one ${scenario} ${role} observation.`);
      }
    }
  }
  if (observations.length !== expectedScenarios.length * COST_ROLES.length) {
    throw new Error(`${label} observation matrix contains unexpected entries.`);
  }
  if (anchors.BASE!.costScenarioId === anchors.STRESS!.costScenarioId) {
    throw new Error("BASE and STRESS cost scenario IDs must be distinct.");
  }
  if (
    anchors.BASE!.feeRate === anchors.STRESS!.feeRate
    && anchors.BASE!.slippageRate === anchors.STRESS!.slippageRate
  ) {
    throw new Error("BASE and STRESS must use distinct rates.");
  }
  return { BASE: anchors.BASE!, STRESS: anchors.STRESS! };
}

function buildFullPathReturnGate(
  input: AddPolicyCandidateEvaluationInput,
): AddPolicyCandidateEvaluationResult["gates"]["fullPathNetReturn"] {
  const comparisons = COST_ROLES.flatMap((costRole) => ANCHORS.map((anchor) => {
    const candidate = requireObservation(input.fullPath.observations, input.candidate, costRole);
    const baseline = requireObservation(input.fullPath.observations, anchor, costRole);
    const delta = percentagePointDifference(
      candidate.totalReturnPct,
      baseline.totalReturnPct,
      `Full-path ${costRole} ${anchor} return delta`,
    );
    return {
      costRole,
      anchor,
      candidateReturnPct: candidate.totalReturnPct,
      anchorReturnPct: baseline.totalReturnPct,
      deltaPercentagePoints: delta,
      thresholdPercentagePoints: input.thresholds.minimumFullPathReturnDeltaPercentagePoints,
      operator: ">" as const,
      passed: delta > input.thresholds.minimumFullPathReturnDeltaPercentagePoints,
    };
  }));
  return { status: comparisons.every((item) => item.passed) ? "PASS" : "FAIL", comparisons };
}

function buildBaseWindowReturnGate(
  input: AddPolicyCandidateEvaluationInput,
  windows: ValidatedWindow[],
): AddPolicyCandidateEvaluationResult["gates"]["baseWindowReturn"] {
  const observations = windows.map((window) => windowReturn(
    window,
    input.candidate,
    "BASE",
    input.thresholds.minimumBaseWindowReturnDeltaPercentagePoints,
  ));
  return { status: observations.every((item) => item.passed) ? "PASS" : "FAIL", observations };
}

function buildStressWindowReturnGate(
  input: AddPolicyCandidateEvaluationInput,
  windows: ValidatedWindow[],
): AddPolicyCandidateEvaluationResult["gates"]["stressWindowReturn"] {
  const observations = windows.map((window) => {
    const item = windowReturn(
      window,
      input.candidate,
      "STRESS",
      input.thresholds.minimumStressWindowReturnDeltaPercentagePoints,
    );
    return {
      ...item,
      positive: item.deltaPercentagePoints > 0,
      floorPassed: item.deltaPercentagePoints >= input.thresholds.minimumStressWindowReturnDeltaPercentagePoints,
    };
  });
  const positiveWindowCount = observations.filter((item) => item.positive).length;
  return {
    status: positiveWindowCount >= input.thresholds.minimumPositiveStressWindowCount
      && observations.every((item) => item.floorPassed)
      ? "PASS"
      : "FAIL",
    requiredPositiveWindowCount: input.thresholds.minimumPositiveStressWindowCount,
    positiveWindowCount,
    observations,
  };
}

function windowReturn(
  window: ValidatedWindow,
  candidateScenario: AddPolicyCandidate,
  costRole: AddPolicyEvaluationCostRole,
  threshold: number,
): WindowReturnObservation {
  const candidate = requireObservation(window.observations, candidateScenario, costRole);
  const baseline = requireObservation(window.observations, "BASELINE", costRole);
  const delta = percentagePointDifference(
    candidate.totalReturnPct,
    baseline.totalReturnPct,
    `Window ${window.id} ${costRole} return delta`,
  );
  return {
    windowId: window.id,
    candidateReturnPct: candidate.totalReturnPct,
    baselineReturnPct: baseline.totalReturnPct,
    deltaPercentagePoints: delta,
    thresholdPercentagePoints: threshold,
    passed: delta > threshold,
  };
}

function buildFullPathDrawdownGate(
  input: AddPolicyCandidateEvaluationInput,
): AddPolicyCandidateEvaluationResult["gates"]["fullPathMaxDrawdown"] {
  const observations = COST_ROLES.map((costRole) => drawdownObservation(
    input.fullPath.observations,
    input.candidate,
    costRole,
    input.thresholds.maximumFullPathDrawdownDeltaPercentagePoints,
    { costRole },
  ));
  return { status: observations.every((item) => item.passed) ? "PASS" : "FAIL", observations };
}

function buildStressWindowDrawdownGate(
  input: AddPolicyCandidateEvaluationInput,
  windows: ValidatedWindow[],
): AddPolicyCandidateEvaluationResult["gates"]["stressWindowMaxDrawdown"] {
  const observations = windows.map((window) => drawdownObservation(
    window.observations,
    input.candidate,
    "STRESS",
    input.thresholds.maximumStressWindowDrawdownDeltaPercentagePoints,
    { windowId: window.id },
  ));
  return { status: observations.every((item) => item.passed) ? "PASS" : "FAIL", observations };
}

function drawdownObservation(
  observations: AddPolicyEvaluationObservation[],
  candidateScenario: AddPolicyCandidate,
  costRole: AddPolicyEvaluationCostRole,
  maximumDelta: number,
  identity: Pick<DrawdownObservation, "costRole" | "windowId">,
): DrawdownObservation {
  const candidate = requireObservation(observations, candidateScenario, costRole);
  const baseline = requireObservation(observations, "BASELINE", costRole);
  const delta = percentagePointDifference(
    candidate.maxDrawdownPct,
    baseline.maxDrawdownPct,
    `${identity.windowId ?? "Full-path"} ${costRole} drawdown delta`,
  );
  return {
    ...identity,
    candidateMaxDrawdownPct: candidate.maxDrawdownPct,
    baselineMaxDrawdownPct: baseline.maxDrawdownPct,
    deltaPercentagePoints: delta,
    maximumDeltaPercentagePoints: maximumDelta,
    passed: delta <= maximumDelta,
  };
}

function buildSupportGate(
  input: AddPolicyCandidateEvaluationInput,
  windows: ValidatedWindow[],
): AddPolicyCandidateEvaluationResult["gates"]["policyExposedCompletedEpisodes"] {
  const supportWindows = windows.map((window) => ({
    windowId: window.id,
    evaluable: window.coverage.status === "COMPLETE",
    observedCount: window.policyExposedCompletedEpisodeCount,
    requiredCount: input.thresholds.minimumWindowPolicyExposedCompletedEpisodes,
    passed: window.coverage.status === "COMPLETE"
      ? window.policyExposedCompletedEpisodeCount
        >= input.thresholds.minimumWindowPolicyExposedCompletedEpisodes
      : null,
  }));
  const fullPathPassed = input.fullPath.policyExposedCompletedEpisodeCount
    >= input.thresholds.minimumFullPathPolicyExposedCompletedEpisodes;
  return {
    status: fullPathPassed && supportWindows.every((window) => window.passed !== false)
      ? "PASS"
      : "INSUFFICIENT",
    fullPathObservedCount: input.fullPath.policyExposedCompletedEpisodeCount,
    fullPathRequiredCount: input.thresholds.minimumFullPathPolicyExposedCompletedEpisodes,
    windows: supportWindows,
  };
}

function buildCoverageGate(
  fullPath: AddPolicyCandidateEvaluationInput["fullPath"],
  windows: ValidatedWindow[],
): AddPolicyCandidateEvaluationResult["gates"]["frameCoverage"] {
  const fullPathCoverage = {
    ...copyCoverage(fullPath.coverage),
    passed: fullPath.coverage.status === "COMPLETE",
  };
  const observations = windows.map((window) => ({
    windowId: window.id,
    ...copyCoverage(window.coverage),
    passed: window.coverage.status === "COMPLETE",
  }));
  return {
    status: fullPathCoverage.passed && observations.every((window) => window.passed)
      ? "PASS"
      : "INSUFFICIENT",
    fullPath: fullPathCoverage,
    windows: observations,
  };
}

function requireObservation(
  observations: AddPolicyEvaluationObservation[],
  scenario: AddPolicyEvaluationScenario,
  costRole: AddPolicyEvaluationCostRole,
): AddPolicyEvaluationObservation {
  const result = observations.find(
    (observation) => observation.scenario === scenario && observation.costRole === costRole,
  );
  if (!result) throw new Error(`Missing validated observation ${scenario}/${costRole}.`);
  return result;
}

function requireTimestamp(value: string, label: string): PerformanceTimestamp {
  const timestamp = parsePerformanceTimestamp(value);
  if (!timestamp) throw new Error(`${label} must be a valid ISO-8601 timestamp with explicit timezone.`);
  return timestamp;
}

function validateEpisodeCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function validatePositiveCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
}

function percentagePointDifference(left: number, right: number, label: string): number {
  const result = (left - right) * 100;
  assertFinite(result, label);
  return Number(result.toPrecision(15));
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite non-negative.`);
  }
}

function assertFiniteSlippageRate(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be finite non-negative.`);
  }
  if (value >= 1) throw new Error(`${label} must be less than 1.`);
}

function copyObservation(observation: AddPolicyEvaluationObservation): AddPolicyEvaluationObservation {
  return { ...observation };
}

function copyCoverage(coverage: AddPolicyEvaluationCoverage): AddPolicyEvaluationCoverage {
  return {
    ...coverage,
    noTradeRanges: coverage.noTradeRanges.map((range) => ({ ...range })),
    missingRanges: coverage.missingRanges.map((range) => ({ ...range })),
    duplicateInstants: coverage.duplicateInstants.map((occurrence) => ({ ...occurrence })),
    offGridInstants: coverage.offGridInstants.map((occurrence) => ({ ...occurrence })),
    upstreamNoTradeRanges: coverage.upstreamNoTradeRanges.map((range) => ({ ...range })),
    upstreamMissingRanges: coverage.upstreamMissingRanges.map((range) => ({ ...range })),
    upstreamDuplicateInstants: coverage.upstreamDuplicateInstants.map((occurrence) => ({ ...occurrence })),
    upstreamOffGridInstants: coverage.upstreamOffGridInstants.map((occurrence) => ({ ...occurrence })),
    featureLookbackAffectedRanges: coverage.featureLookbackAffectedRanges.map((range) => ({ ...range })),
  };
}
