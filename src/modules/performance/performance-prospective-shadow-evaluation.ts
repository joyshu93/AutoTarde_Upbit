import {
  PROSPECTIVE_SHADOW_ASSETS,
  PROSPECTIVE_SHADOW_COSTS,
  PROSPECTIVE_SHADOW_SCENARIOS,
  PROSPECTIVE_SHADOW_TIMINGS,
  validateProspectiveShadowRegistration,
  type ProspectiveShadowRegistration,
} from "./performance-prospective-shadow-registration.js";
import {
  validateProspectiveShadowClosureCommitment,
  validateProspectiveShadowCommitment,
  type ValidateProspectiveShadowClosureCommitmentInput,
  type ValidateProspectiveShadowCommitmentInput,
} from "./performance-prospective-shadow-commitment.js";
import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
} from "./performance-timestamp.js";

export type ProspectiveShadowAsset = typeof PROSPECTIVE_SHADOW_ASSETS[number]["asset"];
export type ProspectiveShadowMarket = typeof PROSPECTIVE_SHADOW_ASSETS[number]["market"];
export type ProspectiveShadowScenario = typeof PROSPECTIVE_SHADOW_SCENARIOS[number];
export type ProspectiveShadowTiming = typeof PROSPECTIVE_SHADOW_TIMINGS[number];
export type ProspectiveShadowCostId = typeof PROSPECTIVE_SHADOW_COSTS[number]["id"];

export const PROSPECTIVE_SHADOW_COMPLETENESS_GATES = [
  "CADENCE",
  "FEATURE_COVERAGE",
  "NO_TRADE_COVERAGE",
  "INITIAL_STATE",
  "LIFECYCLE",
  "FEE_EVIDENCE",
  "FINITE_METRICS",
  "EPISODE_RELATIONSHIPS",
] as const;

export type ProspectiveShadowCompletenessGate =
  typeof PROSPECTIVE_SHADOW_COMPLETENESS_GATES[number];

export type ProspectiveShadowMetricEvidence<Unit extends "RATIO" | "KRW"> = Readonly<{
  unit: Unit;
  value: number | null;
  complete: boolean;
  unknownReason: string | null;
}>;

export type ProspectiveShadowPathEvidence = Readonly<{
  asset: ProspectiveShadowAsset;
  market: ProspectiveShadowMarket;
  scenario: ProspectiveShadowScenario;
  timing: ProspectiveShadowTiming;
  costId: ProspectiveShadowCostId;
  completedKnownNetEpisodes: number;
  openEpisodes: number;
  incompleteGates: readonly ProspectiveShadowCompletenessGate[];
  metrics: Readonly<{
    netReturn: ProspectiveShadowMetricEvidence<"RATIO">;
    maximumRealizedDrawdown: ProspectiveShadowMetricEvidence<"RATIO">;
    turnover: ProspectiveShadowMetricEvidence<"KRW">;
    modeledFees: ProspectiveShadowMetricEvidence<"KRW">;
  }>;
}>;

export interface ProspectiveShadowEvaluationInput {
  readonly registration: ProspectiveShadowRegistration;
  readonly initialCommitmentInput: ValidateProspectiveShadowCommitmentInput;
  readonly closureCommitmentInput: ValidateProspectiveShadowClosureCommitmentInput | null;
  readonly asOf: string;
  readonly pathEvidence: readonly ProspectiveShadowPathEvidence[] | null;
}

export type ProspectiveShadowCandidateStatus =
  | "INSUFFICIENT"
  | "REJECTED"
  | "SUPPORTS_CONTINUED_SHADOW";

export type ProspectiveShadowReasonCode =
  | "KNOWN_HARM_NET_RETURN"
  | "KNOWN_HARM_DRAWDOWN"
  | "KNOWN_HARM_TURNOVER"
  | "KNOWN_HARM_FEES"
  | "INCOMPLETE_EVIDENCE"
  | "INSUFFICIENT_EPISODE_SUPPORT"
  | "NO_MEANINGFUL_NET_RETURN_IMPROVEMENT"
  | "QUALIFYING_NET_RETURN_IMPROVEMENT";

export type ProspectiveShadowReasonDetail = Readonly<{
  code: ProspectiveShadowReasonCode;
  detail: string;
}>;

export type ProspectiveShadowDelta = Readonly<{
  unit: "PERCENTAGE_POINTS" | "KRW";
  value: number | null;
  complete: boolean;
  unknownReason: string | null;
}>;

export type ProspectiveShadowCellEvaluation = Readonly<{
  timing: ProspectiveShadowTiming;
  costId: ProspectiveShadowCostId;
  referenceCompletedKnownNetEpisodes: number;
  candidateCompletedKnownNetEpisodes: number;
  referenceOpenEpisodes: number;
  candidateOpenEpisodes: number;
  supportSufficient: boolean;
  incompleteGates: readonly ProspectiveShadowCompletenessGate[];
  referenceMetrics: ProspectiveShadowPathEvidence["metrics"];
  candidateMetrics: ProspectiveShadowPathEvidence["metrics"];
  deltas: Readonly<{
    netReturn: ProspectiveShadowDelta;
    maximumRealizedDrawdown: ProspectiveShadowDelta;
    turnover: ProspectiveShadowDelta;
    modeledFees: ProspectiveShadowDelta;
  }>;
  knownHarmReasonCodes: readonly ProspectiveShadowReasonCode[];
  qualifyingNetReturnImprovement: boolean;
}>;

export type ProspectiveShadowCandidateEvaluation = Readonly<{
  scenario: Exclude<ProspectiveShadowScenario, "COMBINED_CONSERVATIVE">;
  referenceScenario: "COMBINED_CONSERVATIVE";
  status: ProspectiveShadowCandidateStatus;
  reasonCodes: readonly ProspectiveShadowReasonCode[];
  reasonDetails: readonly ProspectiveShadowReasonDetail[];
  incompleteGates: readonly ProspectiveShadowCompletenessGate[];
  cells: readonly ProspectiveShadowCellEvaluation[];
}>;

export type ProspectiveShadowFinalOutcomes = Readonly<{
  assets: readonly Readonly<{
    asset: ProspectiveShadowAsset;
    market: ProspectiveShadowMarket;
    candidates: readonly ProspectiveShadowCandidateEvaluation[];
  }>[];
}>;

export type ProspectiveShadowEvaluation = Readonly<{
  schemaVersion: 1;
  authority: ProspectiveShadowRegistration["authority"];
  experimentId: ProspectiveShadowRegistration["experimentId"];
  phase: "COLLECTING" | "FINAL";
  asOf: string;
  window: ProspectiveShadowRegistration["window"];
  calendar: Readonly<{ windowComplete: boolean }>;
  registration: Readonly<{
    payloadSha256: string;
    implementationCommitSha: string;
  }>;
  commitment: Readonly<{
    assurance: "HUMAN_VERIFIED_PUBLIC_GITHUB_RUN";
    cryptographicallyVerified: false;
    publicationCommitSha: string;
    closureTipSha: string | null;
    registryClassification: "ACTIVE_AT_CLOSE" | null;
  }>;
  comparisonPolicy: ProspectiveShadowRegistration["comparisonPolicy"];
  supportPolicy: ProspectiveShadowRegistration["supportPolicy"];
  outcomes: ProspectiveShadowFinalOutcomes | null;
  safety: Readonly<{
    readOnly: true;
    deploymentApproval: false;
    liveApproval: false;
    boundary: string;
  }>;
}>;

export class ProspectiveShadowEvaluationError extends Error {
  public constructor(
    public readonly code: "REGISTRATION_INVALID" | "EVIDENCE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ProspectiveShadowEvaluationError";
  }
}

const REFERENCE_SCENARIO = "COMBINED_CONSERVATIVE" as const;
const CANDIDATE_SCENARIOS = [
  "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  "COMBINED_MINUS_COOLDOWN_CONTROL",
] as const;
const METRIC_KEYS = [
  "netReturn",
  "maximumRealizedDrawdown",
  "turnover",
  "modeledFees",
] as const;
const COMPLETENESS_GATE_DEPENDENCIES: Readonly<Record<ProspectiveShadowCompletenessGate, Readonly<{
  metricKeys: readonly (keyof ProspectiveShadowPathEvidence["metrics"])[];
  affectsKnownNetEpisodeSupport: boolean;
}>>> = {
  CADENCE: { metricKeys: METRIC_KEYS, affectsKnownNetEpisodeSupport: true },
  FEATURE_COVERAGE: { metricKeys: METRIC_KEYS, affectsKnownNetEpisodeSupport: true },
  NO_TRADE_COVERAGE: { metricKeys: METRIC_KEYS, affectsKnownNetEpisodeSupport: true },
  INITIAL_STATE: { metricKeys: METRIC_KEYS, affectsKnownNetEpisodeSupport: true },
  LIFECYCLE: {
    metricKeys: ["netReturn", "maximumRealizedDrawdown"],
    affectsKnownNetEpisodeSupport: true,
  },
  FEE_EVIDENCE: {
    metricKeys: ["netReturn", "modeledFees"],
    affectsKnownNetEpisodeSupport: true,
  },
  FINITE_METRICS: { metricKeys: METRIC_KEYS, affectsKnownNetEpisodeSupport: true },
  EPISODE_RELATIONSHIPS: {
    metricKeys: ["netReturn", "maximumRealizedDrawdown"],
    affectsKnownNetEpisodeSupport: true,
  },
};
const NON_DEPLOYMENT_BOUNDARY =
  "Prospective shadow results are research evidence only and cannot authorize deployment, LIVE execution, or strategy changes.";

export function evaluateProspectiveComponentShadow(
  input: ProspectiveShadowEvaluationInput,
): ProspectiveShadowEvaluation {
  const registration = validateAuthority(() => validateProspectiveShadowRegistration(structuredClone(input.registration)));
  assertRegistrationPayloadBinding(
    registration,
    input.initialCommitmentInput.registration,
    input.initialCommitmentInput.metadata.registrationPayloadSha256,
    "initial commitment",
  );
  const initial = validateAuthority(() => validateProspectiveShadowCommitment(structuredClone(input.initialCommitmentInput)));
  if (initial.implementationCommitSha !== registration.implementationCommitSha) {
    throw registrationInvalid("Initial commitment does not identify the registered implementation commit.");
  }
  const asOf = requireTimestamp(input.asOf, "asOf");
  const windowComplete = compareTimestamps(asOf, registration.window.to) >= 0;

  if (!windowComplete) {
    if (input.closureCommitmentInput !== null || input.pathEvidence !== null) {
      throw evidenceInvalid("Closure or outcome evidence is not admissible before window.to.");
    }
    return deepFreeze(createBaseResult({
      registration,
      initial,
      asOf,
      phase: "COLLECTING",
      closure: null,
      outcomes: null,
    }));
  }

  if (input.closureCommitmentInput === null) {
    throw registrationInvalid("Final evaluation requires raw close-time commitment evidence.");
  }
  const closureCommitmentInput = input.closureCommitmentInput;
  assertRegistrationPayloadBinding(
    registration,
    closureCommitmentInput.registration,
    closureCommitmentInput.metadata.registrationPayloadSha256,
    "closure commitment",
  );
  if (canonicalJson(input.initialCommitmentInput) !== canonicalJson(closureCommitmentInput.initialCommitmentInput)) {
    throw registrationInvalid("Closure commitment substituted different initial commitment evidence.");
  }
  const closure = validateAuthority(() => validateProspectiveShadowClosureCommitment(
    structuredClone(closureCommitmentInput),
  ));
  if (closure.registryClassification !== "ACTIVE_AT_CLOSE") {
    throw registrationInvalid("An abandoned registration cannot produce a prospective evaluation.");
  }
  if (closure.metadata.publicationCommitSha !== initial.publicationCommitSha) {
    throw registrationInvalid("Initial and closure commitment publication commits do not match.");
  }
  if (input.pathEvidence === null) {
    throw evidenceInvalid("Final evaluation requires the exact registered path-evidence matrix.");
  }

  const paths = validatePathMatrix(registration, structuredClone(input.pathEvidence));
  const outcomes = evaluateAssets(registration, paths);
  return deepFreeze(createBaseResult({
    registration,
    initial,
    asOf,
    phase: "FINAL",
    closure,
    outcomes,
  }));
}

function createBaseResult(input: {
  registration: ProspectiveShadowRegistration;
  initial: ReturnType<typeof validateProspectiveShadowCommitment>;
  asOf: string;
  phase: "COLLECTING" | "FINAL";
  closure: ReturnType<typeof validateProspectiveShadowClosureCommitment> | null;
  outcomes: ProspectiveShadowFinalOutcomes | null;
}): ProspectiveShadowEvaluation {
  return {
    schemaVersion: 1,
    authority: input.registration.authority,
    experimentId: input.registration.experimentId,
    phase: input.phase,
    asOf: input.asOf,
    window: structuredClone(input.registration.window),
    calendar: { windowComplete: input.phase === "FINAL" },
    registration: {
      payloadSha256: input.registration.payloadSha256,
      implementationCommitSha: input.registration.implementationCommitSha,
    },
    commitment: {
      assurance: input.initial.assurance,
      cryptographicallyVerified: false,
      publicationCommitSha: input.initial.publicationCommitSha,
      closureTipSha: input.closure?.closureTipSha ?? null,
      registryClassification: input.closure === null ? null : "ACTIVE_AT_CLOSE",
    },
    comparisonPolicy: structuredClone(input.registration.comparisonPolicy),
    supportPolicy: structuredClone(input.registration.supportPolicy),
    outcomes: input.outcomes,
    safety: {
      readOnly: true,
      deploymentApproval: false,
      liveApproval: false,
      boundary: NON_DEPLOYMENT_BOUNDARY,
    },
  };
}

function evaluateAssets(
  registration: ProspectiveShadowRegistration,
  paths: readonly ProspectiveShadowPathEvidence[],
): ProspectiveShadowFinalOutcomes {
  return {
    assets: registration.matrix.assets.map(({ asset, market }) => ({
      asset,
      market,
      candidates: CANDIDATE_SCENARIOS.map((scenario) =>
        evaluateCandidate(registration, paths, asset, scenario)),
    })),
  };
}

function evaluateCandidate(
  registration: ProspectiveShadowRegistration,
  paths: readonly ProspectiveShadowPathEvidence[],
  asset: ProspectiveShadowAsset,
  scenario: typeof CANDIDATE_SCENARIOS[number],
): ProspectiveShadowCandidateEvaluation {
  const cells = registration.matrix.timings.flatMap((timing) =>
    registration.matrix.costs.map(({ id: costId }) => {
      const reference = requirePath(paths, asset, REFERENCE_SCENARIO, timing, costId);
      const candidate = requirePath(paths, asset, scenario, timing, costId);
      return evaluateCell(registration, reference, candidate);
    }),
  );
  const knownHarm = uniqueReasonCodes(cells.flatMap((cell) => cell.knownHarmReasonCodes));
  const incompleteGates = sortGates(cells.flatMap((cell) => cell.incompleteGates));
  const insufficientSupport = cells.some((cell) => !cell.supportSufficient);
  const incompleteMetrics = cells.some((cell) => METRIC_KEYS.some((key) => !cell.deltas[key].complete));
  const hasBenefit = cells.some((cell) => cell.qualifyingNetReturnImprovement);

  let status: ProspectiveShadowCandidateStatus;
  let reasonCodes: ProspectiveShadowReasonCode[];
  if (knownHarm.length > 0) {
    status = "REJECTED";
    reasonCodes = [...knownHarm];
    if (incompleteGates.length > 0 || incompleteMetrics) reasonCodes.push("INCOMPLETE_EVIDENCE");
    if (insufficientSupport) reasonCodes.push("INSUFFICIENT_EPISODE_SUPPORT");
  } else if (incompleteGates.length > 0 || incompleteMetrics || insufficientSupport) {
    status = "INSUFFICIENT";
    reasonCodes = [];
    if (incompleteGates.length > 0 || incompleteMetrics) reasonCodes.push("INCOMPLETE_EVIDENCE");
    if (insufficientSupport) reasonCodes.push("INSUFFICIENT_EPISODE_SUPPORT");
  } else if (!hasBenefit) {
    status = "REJECTED";
    reasonCodes = ["NO_MEANINGFUL_NET_RETURN_IMPROVEMENT"];
  } else {
    status = "SUPPORTS_CONTINUED_SHADOW";
    reasonCodes = ["QUALIFYING_NET_RETURN_IMPROVEMENT"];
  }

  return {
    scenario,
    referenceScenario: REFERENCE_SCENARIO,
    status,
    reasonCodes: uniqueReasonCodes(reasonCodes),
    reasonDetails: createReasonDetails(
      uniqueReasonCodes(reasonCodes),
      registration,
      incompleteGates,
    ),
    incompleteGates,
    cells,
  };
}

function evaluateCell(
  registration: ProspectiveShadowRegistration,
  reference: ProspectiveShadowPathEvidence,
  candidate: ProspectiveShadowPathEvidence,
): ProspectiveShadowCellEvaluation {
  const minimum = registration.supportPolicy.minimumKnownNetClosedEpisodesPerPath;
  const supportSufficient = reference.completedKnownNetEpisodes >= minimum &&
    candidate.completedKnownNetEpisodes >= minimum;
  const deltas = {
    netReturn: ratioDelta(reference.metrics.netReturn, candidate.metrics.netReturn),
    maximumRealizedDrawdown: ratioDelta(
      reference.metrics.maximumRealizedDrawdown,
      candidate.metrics.maximumRealizedDrawdown,
    ),
    turnover: krwDelta(reference.metrics.turnover, candidate.metrics.turnover),
    modeledFees: krwDelta(reference.metrics.modeledFees, candidate.metrics.modeledFees),
  };
  const knownHarmReasonCodes: ProspectiveShadowReasonCode[] = [];
  if (supportSufficient) {
    const ratioTolerance = registration.comparisonPolicy.percentagePointTolerance / 100;
    const krwTolerance = registration.comparisonPolicy.krwTolerance;
    if (isMetricBelow(reference.metrics.netReturn, candidate.metrics.netReturn, ratioTolerance)) {
      knownHarmReasonCodes.push("KNOWN_HARM_NET_RETURN");
    }
    if (isMetricAbove(
      reference.metrics.maximumRealizedDrawdown,
      candidate.metrics.maximumRealizedDrawdown,
      ratioTolerance,
    )) {
      knownHarmReasonCodes.push("KNOWN_HARM_DRAWDOWN");
    }
    if (isMetricAbove(reference.metrics.turnover, candidate.metrics.turnover, krwTolerance)) {
      knownHarmReasonCodes.push("KNOWN_HARM_TURNOVER");
    }
    if (isMetricAbove(reference.metrics.modeledFees, candidate.metrics.modeledFees, krwTolerance)) {
      knownHarmReasonCodes.push("KNOWN_HARM_FEES");
    }
  }
  return {
    timing: candidate.timing,
    costId: candidate.costId,
    referenceCompletedKnownNetEpisodes: reference.completedKnownNetEpisodes,
    candidateCompletedKnownNetEpisodes: candidate.completedKnownNetEpisodes,
    referenceOpenEpisodes: reference.openEpisodes,
    candidateOpenEpisodes: candidate.openEpisodes,
    supportSufficient,
    incompleteGates: sortGates([...reference.incompleteGates, ...candidate.incompleteGates]),
    referenceMetrics: structuredClone(reference.metrics),
    candidateMetrics: structuredClone(candidate.metrics),
    deltas,
    knownHarmReasonCodes,
    qualifyingNetReturnImprovement: supportSufficient &&
      isMetricAbove(
        reference.metrics.netReturn,
        candidate.metrics.netReturn,
        registration.comparisonPolicy.percentagePointTolerance / 100,
      ),
  };
}

function ratioDelta(
  reference: ProspectiveShadowMetricEvidence<"RATIO">,
  candidate: ProspectiveShadowMetricEvidence<"RATIO">,
): ProspectiveShadowDelta {
  return createDelta(reference, candidate, "PERCENTAGE_POINTS", 100);
}

function krwDelta(
  reference: ProspectiveShadowMetricEvidence<"KRW">,
  candidate: ProspectiveShadowMetricEvidence<"KRW">,
): ProspectiveShadowDelta {
  return createDelta(reference, candidate, "KRW", 1);
}

function createDelta(
  reference: ProspectiveShadowMetricEvidence<"RATIO" | "KRW">,
  candidate: ProspectiveShadowMetricEvidence<"RATIO" | "KRW">,
  unit: ProspectiveShadowDelta["unit"],
  scale: number,
): ProspectiveShadowDelta {
  if (!reference.complete || !candidate.complete || reference.value === null || candidate.value === null) {
    const reasons = [reference.unknownReason, candidate.unknownReason].filter((value): value is string => value !== null);
    return {
      unit,
      value: null,
      complete: false,
      unknownReason: reasons.length > 0 ? reasons.join("; ") : "comparison metric is incomplete",
    };
  }
  const delta = (candidate.value - reference.value) * scale;
  if (!Number.isFinite(delta)) {
    throw evidenceInvalid("Comparison metric delta must remain finite after subtraction and unit conversion.");
  }
  return {
    unit,
    value: delta,
    complete: true,
    unknownReason: null,
  };
}

function isMetricAbove(
  reference: ProspectiveShadowMetricEvidence<"RATIO" | "KRW">,
  candidate: ProspectiveShadowMetricEvidence<"RATIO" | "KRW">,
  tolerance: number,
): boolean {
  if (!reference.complete || !candidate.complete || reference.value === null || candidate.value === null) {
    return false;
  }
  const threshold = reference.value + tolerance;
  if (!Number.isFinite(threshold)) return false;
  return candidate.value > threshold;
}

function isMetricBelow(
  reference: ProspectiveShadowMetricEvidence<"RATIO" | "KRW">,
  candidate: ProspectiveShadowMetricEvidence<"RATIO" | "KRW">,
  tolerance: number,
): boolean {
  if (!reference.complete || !candidate.complete || reference.value === null || candidate.value === null) {
    return false;
  }
  const threshold = reference.value - tolerance;
  if (!Number.isFinite(threshold)) return false;
  return candidate.value < threshold;
}

function validatePathMatrix(
  registration: ProspectiveShadowRegistration,
  value: unknown,
): readonly ProspectiveShadowPathEvidence[] {
  if (!Array.isArray(value) || value.length !== registration.matrix.pathCount) {
    throw evidenceInvalid(`Path evidence must contain exactly ${registration.matrix.pathCount} registered paths.`);
  }
  const expected = registration.matrix.assets.flatMap(({ asset, market }) =>
    registration.matrix.scenarios.flatMap((scenario) =>
      registration.matrix.timings.flatMap((timing) =>
        registration.matrix.costs.map((cost) => ({ asset, market, scenario, timing, costId: cost.id })),
      ),
    ),
  );
  const result = value.map((item, index) => validatePath(item, expected[index]!, index));
  return deepFreeze(result);
}

function validatePath(
  value: unknown,
  expected: Readonly<{
    asset: ProspectiveShadowAsset;
    market: ProspectiveShadowMarket;
    scenario: ProspectiveShadowScenario;
    timing: ProspectiveShadowTiming;
    costId: ProspectiveShadowCostId;
  }>,
  index: number,
): ProspectiveShadowPathEvidence {
  const record = requireRecord(value, `pathEvidence[${index}]`);
  assertExactKeys(record, [
    "asset", "market", "scenario", "timing", "costId", "completedKnownNetEpisodes",
    "openEpisodes", "incompleteGates", "metrics",
  ], `pathEvidence[${index}]`);
  for (const key of ["asset", "market", "scenario", "timing", "costId"] as const) {
    if (record[key] !== expected[key]) {
      throw evidenceInvalid(`pathEvidence[${index}].${key} does not match the registered matrix order.`);
    }
  }
  const completedKnownNetEpisodes = requireNonNegativeInteger(
    record.completedKnownNetEpisodes,
    `pathEvidence[${index}].completedKnownNetEpisodes`,
  );
  const openEpisodes = requireNonNegativeInteger(record.openEpisodes, `pathEvidence[${index}].openEpisodes`);
  const metricsRecord = requireRecord(record.metrics, `pathEvidence[${index}].metrics`);
  assertExactKeys(metricsRecord, [...METRIC_KEYS], `pathEvidence[${index}].metrics`);
  const metrics = {
    netReturn: validateMetric(metricsRecord.netReturn, "RATIO", false, `${index}.netReturn`),
    maximumRealizedDrawdown: validateMetric(
      metricsRecord.maximumRealizedDrawdown,
      "RATIO",
      true,
      `${index}.maximumRealizedDrawdown`,
    ),
    turnover: validateMetric(metricsRecord.turnover, "KRW", true, `${index}.turnover`),
    modeledFees: validateMetric(metricsRecord.modeledFees, "KRW", true, `${index}.modeledFees`),
  };
  const incompleteGates = validateGates(record.incompleteGates, index);
  validateGateMetricDependencies(incompleteGates, metrics, completedKnownNetEpisodes, index);
  return deepFreeze({
    ...expected,
    completedKnownNetEpisodes,
    openEpisodes,
    incompleteGates,
    metrics,
  });
}

function validateGateMetricDependencies(
  gates: readonly ProspectiveShadowCompletenessGate[],
  metrics: ProspectiveShadowPathEvidence["metrics"],
  completedKnownNetEpisodes: number,
  index: number,
): void {
  if (metrics.netReturn.complete && !metrics.modeledFees.complete) {
    throw evidenceInvalid(
      `pathEvidence[${index}].metrics.netReturn cannot be complete while modeled fee evidence is incomplete.`,
    );
  }
  if (completedKnownNetEpisodes > 0 && (!metrics.netReturn.complete || !metrics.modeledFees.complete)) {
    throw evidenceInvalid(
      `pathEvidence[${index}] cannot claim known-net closed episodes without complete net-return and fee evidence.`,
    );
  }
  for (const gate of gates) {
    const dependency = COMPLETENESS_GATE_DEPENDENCIES[gate];
    if (dependency.affectsKnownNetEpisodeSupport && completedKnownNetEpisodes > 0) {
      throw evidenceInvalid(
        `pathEvidence[${index}] cannot claim known-net closed episodes while ${gate} is incomplete.`,
      );
    }
    for (const key of dependency.metricKeys) {
      if (metrics[key].complete) {
        throw evidenceInvalid(
          `pathEvidence[${index}].metrics.${key} cannot be complete while ${gate} is incomplete.`,
        );
      }
    }
  }
}

function validateMetric<Unit extends "RATIO" | "KRW">(
  value: unknown,
  unit: Unit,
  nonNegative: boolean,
  label: string,
): ProspectiveShadowMetricEvidence<Unit> {
  const record = requireRecord(value, label);
  assertExactKeys(record, ["unit", "value", "complete", "unknownReason"], label);
  if (record.unit !== unit) throw evidenceInvalid(`${label}.unit must be ${unit}.`);
  if (typeof record.complete !== "boolean") throw evidenceInvalid(`${label}.complete must be boolean.`);
  if (record.complete) {
    const numeric = requireFiniteNumber(record.value, `${label}.value`);
    if (nonNegative && numeric < 0) throw evidenceInvalid(`${label}.value must be non-negative.`);
    if (record.unknownReason !== null) throw evidenceInvalid(`${label}.unknownReason must be null when complete.`);
    return { unit, value: numeric, complete: true, unknownReason: null };
  }
  if (record.value !== null) throw evidenceInvalid(`${label}.value must be null when incomplete.`);
  if (typeof record.unknownReason !== "string" || record.unknownReason.trim() === "") {
    throw evidenceInvalid(`${label}.unknownReason must explain incomplete evidence.`);
  }
  return { unit, value: null, complete: false, unknownReason: record.unknownReason.trim() };
}

function validateGates(value: unknown, index: number): readonly ProspectiveShadowCompletenessGate[] {
  if (!Array.isArray(value)) throw evidenceInvalid(`pathEvidence[${index}].incompleteGates must be an array.`);
  const gates = value.map((item) => {
    if (!PROSPECTIVE_SHADOW_COMPLETENESS_GATES.includes(item as ProspectiveShadowCompletenessGate)) {
      throw evidenceInvalid(`pathEvidence[${index}] contains an unknown completeness gate.`);
    }
    return item as ProspectiveShadowCompletenessGate;
  });
  if (new Set(gates).size !== gates.length) {
    throw evidenceInvalid(`pathEvidence[${index}] contains duplicate completeness gates.`);
  }
  return sortGates(gates);
}

function requirePath(
  paths: readonly ProspectiveShadowPathEvidence[],
  asset: ProspectiveShadowAsset,
  scenario: ProspectiveShadowScenario,
  timing: ProspectiveShadowTiming,
  costId: ProspectiveShadowCostId,
): ProspectiveShadowPathEvidence {
  const path = paths.find((item) => item.asset === asset && item.scenario === scenario &&
    item.timing === timing && item.costId === costId);
  if (!path) throw evidenceInvalid(`Registered path is missing: ${asset}/${scenario}/${timing}/${costId}.`);
  return path;
}

function sortGates(gates: readonly ProspectiveShadowCompletenessGate[]): ProspectiveShadowCompletenessGate[] {
  const unique = new Set(gates);
  return PROSPECTIVE_SHADOW_COMPLETENESS_GATES.filter((gate) => unique.has(gate));
}

function uniqueReasonCodes(codes: readonly ProspectiveShadowReasonCode[]): ProspectiveShadowReasonCode[] {
  return [...new Set(codes)];
}

function createReasonDetails(
  codes: readonly ProspectiveShadowReasonCode[],
  registration: ProspectiveShadowRegistration,
  incompleteGates: readonly ProspectiveShadowCompletenessGate[],
): ProspectiveShadowReasonDetail[] {
  const percentagePointTolerance = registration.comparisonPolicy.percentagePointTolerance;
  const krwTolerance = registration.comparisonPolicy.krwTolerance;
  const minimumSupport = registration.supportPolicy.minimumKnownNetClosedEpisodesPerPath;
  return codes.map((code) => {
    switch (code) {
      case "KNOWN_HARM_NET_RETURN":
        return { code, detail: `A supported cell has candidate net return below reference by more than ${percentagePointTolerance} percentage points.` };
      case "KNOWN_HARM_DRAWDOWN":
        return { code, detail: `A supported cell has candidate maximum realized drawdown above reference by more than ${percentagePointTolerance} percentage points.` };
      case "KNOWN_HARM_TURNOVER":
        return { code, detail: `A supported cell has candidate turnover above reference by more than ${krwTolerance} KRW.` };
      case "KNOWN_HARM_FEES":
        return { code, detail: `A supported cell has candidate modeled fees above reference by more than ${krwTolerance} KRW.` };
      case "INCOMPLETE_EVIDENCE":
        return {
          code,
          detail: incompleteGates.length === 0
            ? "At least one registered comparison metric is incomplete or unknown."
            : `Incomplete evidence gates: ${incompleteGates.join(", ")}.`,
        };
      case "INSUFFICIENT_EPISODE_SUPPORT":
        return { code, detail: `At least one cell has fewer than ${minimumSupport} known-net closed episodes on the reference or candidate path.` };
      case "NO_MEANINGFUL_NET_RETURN_IMPROVEMENT":
        return { code, detail: `No complete supported cell improves candidate net return by more than ${percentagePointTolerance} percentage points.` };
      case "QUALIFYING_NET_RETURN_IMPROVEMENT":
        return { code, detail: `At least one complete supported cell improves candidate net return by more than ${percentagePointTolerance} percentage points and every cell is non-worse.` };
    }
  });
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw evidenceInvalid(`${label} must be a timestamp string.`);
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) throw evidenceInvalid(`${label} must be ISO-8601 with an explicit timezone.`);
  return parsed.normalized;
}

function compareTimestamps(left: string, right: string): number {
  const leftParsed = parsePerformanceTimestamp(left);
  const rightParsed = parsePerformanceTimestamp(right);
  if (!leftParsed || !rightParsed) throw evidenceInvalid("Evaluation timestamps are invalid.");
  return compareEpochNanoseconds(leftParsed.epochNanoseconds, rightParsed.epochNanoseconds);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw evidenceInvalid(`${label} must be a non-negative safe integer and not negative zero.`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
    throw evidenceInvalid(`${label} must be finite and not negative zero.`);
  }
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw evidenceInvalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw evidenceInvalid(`${label} keys do not match the frozen contract.`);
  }
}

function validateAuthority<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ProspectiveShadowEvaluationError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw registrationInvalid(message);
  }
}

function assertRegistrationPayloadBinding(
  registration: ProspectiveShadowRegistration,
  rawRegistration: ProspectiveShadowRegistration,
  metadataPayloadSha256: string,
  label: string,
): void {
  if (rawRegistration.payloadSha256 !== registration.payloadSha256 ||
      metadataPayloadSha256 !== registration.payloadSha256) {
    throw registrationInvalid(`${label} is not bound to the exact top-level registration payload SHA-256.`);
  }
}

function registrationInvalid(message: string): ProspectiveShadowEvaluationError {
  return new ProspectiveShadowEvaluationError("REGISTRATION_INVALID", message);
}

function evidenceInvalid(message: string): ProspectiveShadowEvaluationError {
  return new ProspectiveShadowEvaluationError("EVIDENCE_INVALID", message);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, sortJsonValue(nested)]),
    );
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
