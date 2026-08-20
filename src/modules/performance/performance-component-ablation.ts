import { getMarketForAsset, type SupportedAsset, type SupportedMarket } from "../../domain/types.js";
import {
  FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER,
  type FrozenCombinedConservativeAblationScenario,
} from "../strategy/position-guard-research-manifest.js";
import type {
  HoldoutEpisodeAttributionCounts,
  HoldoutEpisodeAttributionResult,
  HoldoutEpisodeEnvelope,
  HoldoutEpisodeInterventionEvidence,
  HoldoutEpisodePathProvenance,
  HoldoutEpisodeRelationshipKind,
} from "./performance-holdout-episode-attribution.js";
import { PERFORMANCE_QUANTITY_TOLERANCE } from "./performance-trade-matcher.js";
import {
  parsePerformanceTimestamp,
  type PerformanceTimestamp,
} from "./performance-timestamp.js";

const ASSET_ORDER: readonly SupportedAsset[] = ["BTC", "ETH"];
const TIMING_ORDER = ["SAME_CLOSE_MODELED", "NEXT_FRAME_MODELED"] as const;
const COST_ORDER = ["BASE", "STRESS"] as const;
const COVERAGE_KEYS = [
  "cadenceComplete",
  "featureCoverageComplete",
  "carryInStateComplete",
  "referenceLifecycleComplete",
  "ablationLifecycleComplete",
  "referenceFeeComplete",
  "ablationFeeComplete",
  "referenceFiniteMetricsComplete",
  "ablationFiniteMetricsComplete",
] as const;
const PERCENTAGE_POINT_TOLERANCE = 0.000001;
const KRW_TOLERANCE = 0.000000001;
const MINIMUM_COMPLETED_EPISODES = 10;
const INTERPRETATION_BOUNDARY = "Retrospective association cannot authorize shadow or LIVE and can only nominate a fresh prospective test.";

export type PerformanceComponentAblationTiming = (typeof TIMING_ORDER)[number];
export type PerformanceComponentAblationCost = (typeof COST_ORDER)[number];
export type PerformanceComponentAblationClassification =
  | "NO_MEASURABLE_DIFFERENCE"
  | "HARM_ASSOCIATION"
  | "PROTECTIVE_ASSOCIATION"
  | "MIXED_ASSOCIATION"
  | "INSUFFICIENT_EVIDENCE";

export type PerformanceComponentAblationMetrics = {
  scenario: "COMBINED_CONSERVATIVE" | FrozenCombinedConservativeAblationScenario;
  netReturnPct: number;
  maxDrawdownPct: number;
  turnoverKrw: number;
  feesKrw: number;
  completedEpisodeCount: number;
};

export type PerformanceComponentAblationPathCoverage = {
  cadenceComplete: boolean;
  featureCoverageComplete: boolean;
  carryInStateComplete: boolean;
  referenceLifecycleComplete: boolean;
  ablationLifecycleComplete: boolean;
  referenceFeeComplete: boolean;
  ablationFeeComplete: boolean;
  referenceFiniteMetricsComplete: boolean;
  ablationFiniteMetricsComplete: boolean;
};

export type PerformanceComponentAblationCell = {
  asset: SupportedAsset;
  market: SupportedMarket;
  timing: PerformanceComponentAblationTiming;
  cost: PerformanceComponentAblationCost;
  holdoutFrom: string;
  holdoutTo: string;
  reference: PerformanceComponentAblationMetrics;
  ablation: PerformanceComponentAblationMetrics;
  coverage?: PerformanceComponentAblationPathCoverage;
  attribution: HoldoutEpisodeAttributionResult;
};

export type PerformanceComponentAblationInput = {
  authorityId: "COMBINED_CONSERVATIVE_ABLATION_V1";
  assets: Array<{
    asset: SupportedAsset;
    market: SupportedMarket;
    holdoutFrom: string;
    holdoutTo: string;
    cells: PerformanceComponentAblationCell[];
  }>;
};

export type PerformanceComponentAblationDelta = {
  timing: PerformanceComponentAblationTiming;
  cost: PerformanceComponentAblationCost;
  reference: Readonly<PerformanceComponentAblationMetrics>;
  ablation: Readonly<PerformanceComponentAblationMetrics>;
  netReturnPctDelta: number;
  maxDrawdownPctDelta: number;
  turnoverKrwDelta: number;
  feesKrwDelta: number;
  completedEpisodeCountDelta: number;
  coverage: Readonly<PerformanceComponentAblationPathCoverage>;
  episodeAttribution: Readonly<HoldoutEpisodeAttributionResult>;
  evidenceComplete: boolean;
  warnings: readonly string[];
  provenance: Readonly<HoldoutEpisodePathProvenance>;
};

export type PerformanceComponentAblationComponentResult = {
  ablationScenario: FrozenCombinedConservativeAblationScenario;
  classification: PerformanceComponentAblationClassification;
  deltas: readonly PerformanceComponentAblationDelta[];
  warnings: readonly string[];
};

export type PerformanceComponentAblationAssetResult = {
  asset: SupportedAsset;
  market: SupportedMarket;
  holdoutFrom: string;
  holdoutTo: string;
  components: readonly PerformanceComponentAblationComponentResult[];
};

export type PerformanceComponentAblationResult = {
  analysisKind: "PERFORMANCE_COMPONENT_ABLATION";
  authorityId: "COMBINED_CONSERVATIVE_ABLATION_V1";
  readOnly: true;
  causalClaim: false;
  deploymentApproval: false;
  prospectiveApproval: false;
  interpretationBoundary: typeof INTERPRETATION_BOUNDARY;
  percentagePointTolerance: typeof PERCENTAGE_POINT_TOLERANCE;
  krwTolerance: typeof KRW_TOLERANCE;
  minimumCompletedEpisodes: typeof MINIMUM_COMPLETED_EPISODES;
  assets: readonly PerformanceComponentAblationAssetResult[];
};

type ValidatedAsset = {
  asset: SupportedAsset;
  market: SupportedMarket;
  holdoutFrom: string;
  holdoutTo: string;
  cells: ReadonlyMap<string, PerformanceComponentAblationCell>;
};

export function evaluatePerformanceComponentAblation(
  input: PerformanceComponentAblationInput,
): PerformanceComponentAblationResult {
  if (input.authorityId !== "COMBINED_CONSERVATIVE_ABLATION_V1") {
    throw new Error("Component ablation authorityId must be COMBINED_CONSERVATIVE_ABLATION_V1.");
  }
  const assets = validateAssets(input.assets, input.authorityId);
  return deepFreeze({
    analysisKind: "PERFORMANCE_COMPONENT_ABLATION",
    authorityId: input.authorityId,
    readOnly: true,
    causalClaim: false,
    deploymentApproval: false,
    prospectiveApproval: false,
    interpretationBoundary: INTERPRETATION_BOUNDARY,
    percentagePointTolerance: PERCENTAGE_POINT_TOLERANCE,
    krwTolerance: KRW_TOLERANCE,
    minimumCompletedEpisodes: MINIMUM_COMPLETED_EPISODES,
    assets: ASSET_ORDER.map((asset) => evaluateAsset(assets.get(asset)!)),
  });
}

function validateAssets(
  values: readonly PerformanceComponentAblationInput["assets"][number][],
  authorityId: string,
): ReadonlyMap<SupportedAsset, ValidatedAsset> {
  const assets = new Map<SupportedAsset, ValidatedAsset>();
  for (const value of values) {
    if (!isSupportedAsset(value.asset)) throw new Error(`Unsupported component ablation asset ${String(value.asset)}.`);
    if (assets.has(value.asset)) throw new Error(`Duplicate component ablation asset ${value.asset}.`);
    if (value.market !== getMarketForAsset(value.asset)) {
      throw new Error(`Component ablation market ${value.market} does not match asset ${value.asset}.`);
    }
    const holdoutFrom = requireTimestamp(value.holdoutFrom, `${value.asset} holdoutFrom`);
    const holdoutTo = requireTimestamp(value.holdoutTo, `${value.asset} holdoutTo`);
    if (holdoutFrom.epochNanoseconds >= holdoutTo.epochNanoseconds) {
      throw new Error(`Component ablation ${value.asset} holdout [from,to) range is invalid.`);
    }
    const cells = validateCells(value, holdoutFrom, holdoutTo, authorityId);
    assets.set(value.asset, {
      asset: value.asset,
      market: value.market,
      holdoutFrom: holdoutFrom.normalized,
      holdoutTo: holdoutTo.normalized,
      cells,
    });
  }
  for (const asset of ASSET_ORDER) if (!assets.has(asset)) throw new Error(`Missing component ablation asset ${asset}.`);
  if (assets.size !== ASSET_ORDER.length) throw new Error("Component ablation input must contain exactly BTC and ETH.");
  return assets;
}

function validateCells(
  asset: PerformanceComponentAblationInput["assets"][number],
  holdoutFrom: PerformanceTimestamp,
  holdoutTo: PerformanceTimestamp,
  authorityId: string,
): ReadonlyMap<string, PerformanceComponentAblationCell> {
  const cells = new Map<string, PerformanceComponentAblationCell>();
  for (const cell of asset.cells) {
    validateCell(cell, asset.asset, asset.market, holdoutFrom, holdoutTo, authorityId);
    const scenario = cell.ablation.scenario;
    if (!isAblationScenario(scenario)) throw new Error("Component ablation scenario is not frozen.");
    const key = cellKey(scenario, cell.timing, cell.cost);
    if (cells.has(key)) throw new Error(`Duplicate component ablation cell ${asset.asset}:${key}.`);
    cells.set(key, cell);
  }
  for (const scenario of FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER) {
    for (const timing of TIMING_ORDER) for (const cost of COST_ORDER) {
      const key = cellKey(scenario, timing, cost);
      if (!cells.has(key)) throw new Error(`Component ablation matrix requires exactly one cell for ${asset.asset}:${key}.`);
    }
  }
  const expected = FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER.length * TIMING_ORDER.length * COST_ORDER.length;
  if (cells.size !== expected) throw new Error(`Component ablation matrix for ${asset.asset} contains an extra cell.`);
  validateSharedProvenance(cells.values());
  return cells;
}

function validateCell(
  cell: PerformanceComponentAblationCell,
  asset: SupportedAsset,
  market: SupportedMarket,
  holdoutFrom: PerformanceTimestamp,
  holdoutTo: PerformanceTimestamp,
  authorityId: string,
): void {
  if (cell.asset !== asset || cell.market !== market) throw new Error("Component ablation cell asset or market mismatch.");
  if (!isTiming(cell.timing) || !isCost(cell.cost)) throw new Error("Component ablation cell timing or cost is invalid.");
  if (
    requireTimestamp(cell.holdoutFrom, "cell holdoutFrom").epochNanoseconds !== holdoutFrom.epochNanoseconds
    || requireTimestamp(cell.holdoutTo, "cell holdoutTo").epochNanoseconds !== holdoutTo.epochNanoseconds
  ) {
    throw new Error("Component ablation cell holdout range mismatch.");
  }
  if (cell.reference.scenario !== "COMBINED_CONSERVATIVE") throw new Error("Component ablation reference must be COMBINED_CONSERVATIVE.");
  if (!isAblationScenario(cell.ablation.scenario)) throw new Error("Component ablation scenario is not frozen.");
  validateMetrics(cell.reference, "reference");
  validateMetrics(cell.ablation, "ablation");
  validateCoverage(cell.coverage);
  validateAttribution(cell, holdoutFrom, holdoutTo, authorityId);
}

function validateCoverage(value: PerformanceComponentAblationPathCoverage | undefined): asserts value is PerformanceComponentAblationPathCoverage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Component ablation path coverage must contain exactly nine boolean keys.");
  }
  const keys = Object.keys(value).sort();
  const expected = [...COVERAGE_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Component ablation path coverage must contain exactly nine boolean keys.");
  }
  for (const key of COVERAGE_KEYS) {
    if (typeof value[key] !== "boolean") {
      throw new Error(`Component ablation path coverage ${key} must be boolean.`);
    }
  }
}

function validateMetrics(value: PerformanceComponentAblationMetrics, label: string): void {
  requireFinite(value.netReturnPct, `${label} netReturnPct`);
  requireNonNegative(value.maxDrawdownPct, `${label} maxDrawdownPct`);
  requireNonNegative(value.turnoverKrw, `${label} turnoverKrw`);
  requireNonNegative(value.feesKrw, `${label} feesKrw`);
  if (!Number.isSafeInteger(value.completedEpisodeCount) || value.completedEpisodeCount < 0 || Object.is(value.completedEpisodeCount, -0)) {
    throw new Error(`${label} completedEpisodeCount must be a non-negative safe integer.`);
  }
}

function validateAttribution(
  cell: PerformanceComponentAblationCell,
  holdoutFrom: PerformanceTimestamp,
  holdoutTo: PerformanceTimestamp,
  authorityId: string,
): void {
  const attribution = cell.attribution;
  if (
    attribution.analysisKind !== "HOLDOUT_EPISODE_COMPONENT_ABLATION_ATTRIBUTION"
    || attribution.readOnly !== true || attribution.causalClaim !== false
    || attribution.deploymentApproval !== false || attribution.prospectiveApproval !== false
  ) throw new Error("Component ablation attribution safety flags are invalid.");
  if (attribution.referenceScenario !== "COMBINED_CONSERVATIVE") {
    throw new Error("Component ablation attribution referenceScenario must be COMBINED_CONSERVATIVE.");
  }
  if (attribution.ablationScenario !== cell.ablation.scenario) {
    throw new Error("Component ablation attribution ablationScenario must match the cell ablation scenario.");
  }
  for (const relationship of attribution.relationships) {
    if (relationship.reference !== null) validateEnvelopeIdentity(
      relationship.reference,
      "reference",
      attribution.referenceScenario,
      cell,
      holdoutTo,
    );
    if (relationship.ablation !== null) validateEnvelopeIdentity(
      relationship.ablation,
      "ablation",
      attribution.ablationScenario,
      cell,
      holdoutTo,
    );
  }
  const provenance = attribution.provenance;
  if (
    provenance.authorityId !== authorityId || provenance.asset !== cell.asset || provenance.market !== cell.market
    || provenance.timingModel !== cell.timing || provenance.costCellId !== cell.cost
    || provenance.costRole !== cell.cost
    || requireTimestamp(provenance.holdoutFrom, "attribution holdoutFrom").epochNanoseconds !== holdoutFrom.epochNanoseconds
    || requireTimestamp(provenance.holdoutTo, "attribution holdoutTo").epochNanoseconds !== holdoutTo.epochNanoseconds
  ) throw new Error("Component ablation attribution provenance mismatch.");
  const expectedCost = cell.cost === "BASE"
    ? { feeRate: 0.0005, slippageRate: 0.0003 }
    : { feeRate: 0.001, slippageRate: 0.002 };
  if (provenance.feeRate !== expectedCost.feeRate || provenance.slippageRate !== expectedCost.slippageRate) {
    throw new Error("Component ablation attribution cost provenance mismatch.");
  }
  if (!isSha256(provenance.datasetSha256)) throw new Error("Component ablation attribution provenance dataset SHA-256 is invalid.");
  for (const value of [
    provenance.datasetFingerprint,
    provenance.initialStateFingerprint,
    provenance.developmentFrameFingerprint,
    provenance.replayFrameFingerprint,
  ]) if (value.trim().length === 0) throw new Error("Component ablation attribution provenance is incomplete.");
  for (const [name, count] of Object.entries(attribution.counts)) {
    if (!Number.isSafeInteger(count) || count < 0 || Object.is(count, -0)) {
      throw new Error(`Component ablation attribution count ${name} must be a non-negative safe integer.`);
    }
  }
  validateInterventionEvidence(attribution, cell);
  validateAttributionCounts(attribution);
  if (!Array.isArray(attribution.warnings) || attribution.warnings.some((warning) => warning.trim().length === 0)) {
    throw new Error("Component ablation attribution warnings are invalid.");
  }
}

function validateEnvelopeIdentity(
  envelope: HoldoutEpisodeEnvelope,
  label: "reference" | "ablation",
  scenario: string,
  cell: PerformanceComponentAblationCell,
  holdoutTo: PerformanceTimestamp,
): void {
  if (envelope.scenario !== scenario) {
    throw new Error(`Component ablation attribution ${label} envelope scenario mismatch.`);
  }
  if (envelope.asset !== cell.asset) {
    throw new Error(`Component ablation attribution ${label} envelope asset mismatch.`);
  }
  if (envelope.market !== cell.market) {
    throw new Error(`Component ablation attribution ${label} envelope market mismatch.`);
  }
  if (envelope.timingModel !== cell.timing) {
    throw new Error(`Component ablation attribution ${label} envelope timing mismatch.`);
  }
  if (envelope.costCellId !== cell.cost) {
    throw new Error(`Component ablation attribution ${label} envelope cost mismatch.`);
  }
  validateTimestampIdentity(
    envelope.openedAt,
    envelope.openedAtEpochNanoseconds,
    `${label} envelope openedAt`,
  );
  validateNullableTimestampIdentity(
    envelope.closedAt,
    envelope.closedAtEpochNanoseconds,
    `${label} envelope closedAt`,
  );
  validateNullableTimestampIdentity(
    envelope.firstEnterDecisionAt,
    envelope.firstEnterDecisionEpochNanoseconds,
    `${label} envelope firstEnterDecisionAt`,
  );
  validateNullableTimestampIdentity(
    envelope.firstEnterExecutedAt,
    envelope.firstEnterExecutedEpochNanoseconds,
    `${label} envelope firstEnterExecutedAt`,
  );
  if (
    envelope.closedAt !== null
    && requireTimestamp(envelope.closedAt, `${label} envelope closedAt`).epochNanoseconds
      >= holdoutTo.epochNanoseconds
  ) {
    throw new Error(`Component ablation attribution ${label} envelope closes outside [from,to).`);
  }
  requireNonNegative(envelope.openedQuantity, `${label} envelope openedQuantity`);
  requireNonNegative(envelope.realizedQuantity, `${label} envelope realizedQuantity`);
  requireNonNegative(envelope.remainingQuantity, `${label} envelope remainingQuantity`);
  if (
    envelope.realizedQuantity > envelope.openedQuantity + PERFORMANCE_QUANTITY_TOLERANCE
    || Math.abs(
      envelope.openedQuantity - envelope.realizedQuantity - envelope.remainingQuantity,
    ) > PERFORMANCE_QUANTITY_TOLERANCE
  ) {
    throw new Error(`Component ablation attribution ${label} envelope quantity conservation mismatch.`);
  }
  validateUniqueIds(envelope.entryFillIds, `${label} envelope entryFillIds`);
  validateUniqueIds(envelope.exitFillIds, `${label} envelope exitFillIds`);
  validateUniqueIds(
    envelope.modeledFillAttributionFillIds,
    `${label} envelope modeledFillAttributionFillIds`,
  );
  validateUniqueIds(envelope.interventionFillIds, `${label} envelope interventionFillIds`);
  validateUniqueIds(envelope.realizationSliceIds, `${label} envelope realizationSliceIds`);
  validateUniqueIds(envelope.interventionEvidenceIds, `${label} envelope interventionEvidenceIds`);
}

function validateInterventionEvidence(
  attribution: HoldoutEpisodeAttributionResult,
  cell: PerformanceComponentAblationCell,
): void {
  const paths = [
    {
      label: "reference" as const,
      scenario: attribution.referenceScenario,
      records: attribution.referenceInterventions,
      envelopes: attribution.relationships.flatMap((relationship) =>
        relationship.reference === null ? [] : [relationship.reference]),
    },
    {
      label: "ablation" as const,
      scenario: attribution.ablationScenario,
      records: attribution.ablationInterventions,
      envelopes: attribution.relationships.flatMap((relationship) =>
        relationship.ablation === null ? [] : [relationship.ablation]),
    },
  ];
  const from = requireTimestamp(cell.holdoutFrom, "component cell holdoutFrom");
  const to = requireTimestamp(cell.holdoutTo, "component cell holdoutTo");
  for (const path of paths) {
    if (!Array.isArray(path.records)) {
      throw new Error(`Component ablation attribution ${path.label} interventions must be an array.`);
    }
    const records = new Map<string, HoldoutEpisodeInterventionEvidence>();
    let previous: HoldoutEpisodeInterventionEvidence | null = null;
    for (const record of path.records) {
      if (record.id.trim().length === 0 || record.decisionEvidenceId.trim().length === 0) {
        throw new Error(`Component ablation attribution ${path.label} intervention IDs are required.`);
      }
      if (records.has(record.id)) {
        throw new Error(`Component ablation attribution ${path.label} intervention ID is duplicated.`);
      }
      if (record.evidenceType !== "RESEARCH_INTERVENTION") {
        throw new Error(`Component ablation attribution ${path.label} intervention type mismatch.`);
      }
      for (const [name, actual, expected] of [
        ["scenario", record.scenario, path.scenario],
        ["asset", record.asset, cell.asset],
        ["market", record.market, cell.market],
        ["timing", record.timingModel, cell.timing],
        ["cost", record.costCellId, cell.cost],
      ] as const) {
        if (actual !== expected) {
          throw new Error(
            `Component ablation attribution ${path.label} intervention ${name} mismatch.`,
          );
        }
      }
      const instant = validateTimestampIdentity(
        record.decisionGeneratedAt,
        record.decisionGeneratedAtEpochNanoseconds,
        `${path.label} intervention decisionGeneratedAt`,
      );
      if (instant < from.epochNanoseconds || instant >= to.epochNanoseconds) {
        throw new Error(`Component ablation attribution ${path.label} intervention is outside [from,to).`);
      }
      if (!Number.isSafeInteger(record.decisionFrameIndex) || record.decisionFrameIndex < 0) {
        throw new Error(`Component ablation attribution ${path.label} intervention frame index is invalid.`);
      }
      if (record.reason.trim().length === 0) {
        throw new Error(`Component ablation attribution ${path.label} intervention reason is required.`);
      }
      if (record.linkedFillId === null && record.linkedStrategyDecisionId !== null) {
        throw new Error(`Component ablation attribution ${path.label} intervention decision/fill links mismatch.`);
      }
      if (previous !== null && compareInterventionEvidence(previous, record) >= 0) {
        throw new Error(`Component ablation attribution ${path.label} interventions are not in stable order.`);
      }
      records.set(record.id, record);
      previous = record;
    }
    const envelopes = new Map(path.envelopes.map((envelope) => [envelope.episodeId, envelope]));
    for (const record of records.values()) {
      if (record.linkedEpisodeId === null) continue;
      const envelope = envelopes.get(record.linkedEpisodeId);
      if (!envelope || !envelope.interventionEvidenceIds.includes(record.id)) {
        throw new Error(
          `Component ablation attribution ${path.label} intervention episode link mismatch.`,
        );
      }
      if (
        record.linkedFillId !== null
        && !envelope.entryFillIds.includes(record.linkedFillId)
        && !envelope.exitFillIds.includes(record.linkedFillId)
      ) {
        throw new Error(`Component ablation attribution ${path.label} intervention fill link mismatch.`);
      }
    }
    for (const envelope of envelopes.values()) {
      for (const id of envelope.interventionEvidenceIds) {
        if (records.get(id)?.linkedEpisodeId !== envelope.episodeId) {
          throw new Error(
            `Component ablation attribution ${path.label} envelope intervention link mismatch.`,
          );
        }
      }
    }
  }
}

function validateTimestampIdentity(value: string, epoch: string, label: string): bigint {
  const parsed = requireTimestamp(value, label);
  let declared: bigint;
  try {
    declared = BigInt(epoch);
  } catch {
    throw new Error(`${label} epoch identity is invalid.`);
  }
  if (declared !== parsed.epochNanoseconds) throw new Error(`${label} epoch identity mismatch.`);
  return declared;
}

function validateNullableTimestampIdentity(
  value: string | null,
  epoch: string | null,
  label: string,
): void {
  if (value === null || epoch === null) {
    if (value !== null || epoch !== null) throw new Error(`${label} nullable identity mismatch.`);
    return;
  }
  validateTimestampIdentity(value, epoch, label);
}

function validateUniqueIds(values: readonly string[], label: string): void {
  if (!Array.isArray(values) || values.some((value) => value.trim().length === 0)) {
    throw new Error(`${label} must contain non-empty IDs.`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate IDs.`);
}

function compareInterventionEvidence(
  left: HoldoutEpisodeInterventionEvidence,
  right: HoldoutEpisodeInterventionEvidence,
): number {
  const leftAt = BigInt(left.decisionGeneratedAtEpochNanoseconds);
  const rightAt = BigInt(right.decisionGeneratedAtEpochNanoseconds);
  return leftAt < rightAt ? -1 : leftAt > rightAt ? 1
    : left.decisionFrameIndex - right.decisionFrameIndex || left.id.localeCompare(right.id);
}

function validateAttributionCounts(attribution: HoldoutEpisodeAttributionResult): void {
  const count = (kind: HoldoutEpisodeRelationshipKind): number =>
    attribution.relationships.filter((relationship) => relationship.classifications.includes(kind)).length;
  const expected: HoldoutEpisodeAttributionCounts = {
    totalRelationships: attribution.relationships.length,
    exactEntryMatches: count("EXACT_ENTRY_MATCH"),
    exitTimingChanged: count("EXIT_TIMING_CHANGED"),
    referenceOnlyLoss: count("REFERENCE_ONLY_LOSS"),
    referenceOnlyGain: count("REFERENCE_ONLY_GAIN"),
    ablationOnly: count("ABLATION_ONLY"),
    pathDiverged: count("PATH_DIVERGED"),
    carryIn: count("CARRY_IN"),
    openAtTo: count("OPEN_AT_TO"),
    netOutcomeUnknown: count("NET_OUTCOME_UNKNOWN"),
    closedKnownPnlComparisons: attribution.relationships.filter((relationship) =>
      relationship.closedKnownPnlComparable).length,
  };
  for (const name of Object.keys(expected) as Array<keyof HoldoutEpisodeAttributionCounts>) {
    if (attribution.counts[name] !== expected[name]) {
      throw new Error(`Component ablation attribution count ${name} does not match relationships.`);
    }
  }
}

function evaluateAsset(asset: ValidatedAsset): PerformanceComponentAblationAssetResult {
  return {
    asset: asset.asset,
    market: asset.market,
    holdoutFrom: asset.holdoutFrom,
    holdoutTo: asset.holdoutTo,
    components: FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER.map((scenario) => {
      const deltas = TIMING_ORDER.flatMap((timing) => COST_ORDER.map((cost) =>
        compareCell(asset.cells.get(cellKey(scenario, timing, cost))!),
      ));
      const warnings = [...new Set(deltas.flatMap((delta) => delta.warnings))];
      return {
        ablationScenario: scenario,
        classification: classify(deltas),
        deltas,
        warnings,
      };
    }),
  };
}

function compareCell(cell: PerformanceComponentAblationCell): PerformanceComponentAblationDelta {
  const reference = copyMetrics(cell.reference);
  const ablation = copyMetrics(cell.ablation);
  const coverage = deepFreeze(copyCoverage(requireCoverage(cell.coverage)));
  const attributionWarnings = [...cell.attribution.warnings];
  const incompleteCounts = [
    ["carry-in episode evidence", cell.attribution.counts.carryIn],
    ["open episode evidence", cell.attribution.counts.openAtTo],
    ["unknown outcome or fee evidence", cell.attribution.counts.netOutcomeUnknown],
    ["path-diverged episode evidence", cell.attribution.counts.pathDiverged],
  ] as const;
  const warnings = [
    ...COVERAGE_KEYS.filter((key) => !coverage[key]).map((key) => `Path coverage ${key} is incomplete.`),
    ...attributionWarnings,
    ...incompleteCounts.filter(([, count]) => count > 0).map(([name]) => `Insufficient ${name}.`),
  ];
  if (reference.completedEpisodeCount < MINIMUM_COMPLETED_EPISODES || ablation.completedEpisodeCount < MINIMUM_COMPLETED_EPISODES) {
    warnings.push(`Both paths require at least ${MINIMUM_COMPLETED_EPISODES} completed episodes.`);
  }
  if (cell.attribution.counts.closedKnownPnlComparisons < 1) {
    warnings.push("At least one closed known-PnL comparison is required.");
  }
  return {
    timing: cell.timing,
    cost: cell.cost,
    reference,
    ablation,
    netReturnPctDelta: requireDelta(ablation.netReturnPct, reference.netReturnPct, "netReturnPct", 100),
    maxDrawdownPctDelta: requireDelta(ablation.maxDrawdownPct, reference.maxDrawdownPct, "maxDrawdownPct", 100),
    turnoverKrwDelta: requireDelta(ablation.turnoverKrw, reference.turnoverKrw, "turnoverKrw"),
    feesKrwDelta: requireDelta(ablation.feesKrw, reference.feesKrw, "feesKrw"),
    completedEpisodeCountDelta: requireDelta(ablation.completedEpisodeCount, reference.completedEpisodeCount, "completedEpisodeCount"),
    coverage,
    episodeAttribution: deepFreeze(structuredClone(cell.attribution)),
    evidenceComplete: warnings.length === 0,
    warnings,
    provenance: copyProvenance(cell.attribution.provenance),
  };
}

function classify(deltas: readonly PerformanceComponentAblationDelta[]): PerformanceComponentAblationClassification {
  if (deltas.some((delta) => !delta.evidenceComplete)) return "INSUFFICIENT_EVIDENCE";
  if (deltas.every(withinAllTolerances)) return "NO_MEASURABLE_DIFFERENCE";
  if (
    deltas.every((delta) => beyondPositive(delta.netReturnPctDelta, PERCENTAGE_POINT_TOLERANCE, delta.reference.netReturnPct, delta.ablation.netReturnPct, 100))
    && deltas.every((delta) =>
      !beyondPositive(delta.maxDrawdownPctDelta, PERCENTAGE_POINT_TOLERANCE, delta.reference.maxDrawdownPct, delta.ablation.maxDrawdownPct, 100)
      && !beyondPositive(delta.turnoverKrwDelta, KRW_TOLERANCE, delta.reference.turnoverKrw, delta.ablation.turnoverKrw)
      && !beyondPositive(delta.feesKrwDelta, KRW_TOLERANCE, delta.reference.feesKrw, delta.ablation.feesKrw),
    )
  ) return "HARM_ASSOCIATION";
  if (
    deltas.every((delta) => beyondNegative(delta.netReturnPctDelta, PERCENTAGE_POINT_TOLERANCE, delta.reference.netReturnPct, delta.ablation.netReturnPct, 100))
    && deltas.every((delta) =>
      !beyondNegative(delta.maxDrawdownPctDelta, PERCENTAGE_POINT_TOLERANCE, delta.reference.maxDrawdownPct, delta.ablation.maxDrawdownPct, 100)
      && !beyondNegative(delta.turnoverKrwDelta, KRW_TOLERANCE, delta.reference.turnoverKrw, delta.ablation.turnoverKrw)
      && !beyondNegative(delta.feesKrwDelta, KRW_TOLERANCE, delta.reference.feesKrw, delta.ablation.feesKrw),
    )
  ) return "PROTECTIVE_ASSOCIATION";
  return "MIXED_ASSOCIATION";
}

function withinAllTolerances(delta: PerformanceComponentAblationDelta): boolean {
  return withinTolerance(delta.netReturnPctDelta, PERCENTAGE_POINT_TOLERANCE, delta.reference.netReturnPct, delta.ablation.netReturnPct, 100)
    && withinTolerance(delta.maxDrawdownPctDelta, PERCENTAGE_POINT_TOLERANCE, delta.reference.maxDrawdownPct, delta.ablation.maxDrawdownPct, 100)
    && withinTolerance(delta.turnoverKrwDelta, KRW_TOLERANCE, delta.reference.turnoverKrw, delta.ablation.turnoverKrw)
    && withinTolerance(delta.feesKrwDelta, KRW_TOLERANCE, delta.reference.feesKrw, delta.ablation.feesKrw)
    && delta.completedEpisodeCountDelta === 0;
}

function withinTolerance(delta: number, tolerance: number, left: number, right: number, scale = 1): boolean {
  return Math.abs(delta) <= tolerance + roundingAllowance(left, right, scale);
}

function beyondPositive(delta: number, tolerance: number, left: number, right: number, scale = 1): boolean {
  return delta > tolerance + roundingAllowance(left, right, scale);
}

function beyondNegative(delta: number, tolerance: number, left: number, right: number, scale = 1): boolean {
  return delta < -tolerance - roundingAllowance(left, right, scale);
}

function roundingAllowance(left: number, right: number, scale = 1): number {
  return Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * scale;
}

function validateSharedProvenance(values: Iterable<PerformanceComponentAblationCell>): void {
  let expected: string | null = null;
  for (const cell of values) {
    const provenance = cell.attribution.provenance;
    const key = JSON.stringify({
      authorityId: provenance.authorityId,
      asset: provenance.asset,
      market: provenance.market,
      holdoutFromEpochNanoseconds: requireTimestamp(
        provenance.holdoutFrom,
        "attribution holdoutFrom",
      ).epochNanoseconds.toString(),
      holdoutToEpochNanoseconds: requireTimestamp(
        provenance.holdoutTo,
        "attribution holdoutTo",
      ).epochNanoseconds.toString(),
      datasetSha256: provenance.datasetSha256,
      datasetFingerprint: provenance.datasetFingerprint,
      initialStateFingerprint: provenance.initialStateFingerprint,
      developmentFrameFingerprint: provenance.developmentFrameFingerprint,
      replayFrameFingerprint: provenance.replayFrameFingerprint,
    });
    if (expected === null) expected = key;
    else if (key !== expected) throw new Error("Component ablation attribution provenance mismatch across cells.");
  }
}

function requireDelta(left: number, right: number, label: string, scale = 1): number {
  const delta = (left - right) * scale;
  if (!Number.isFinite(delta)) throw new Error(`Component ablation ${label} delta must be finite.`);
  return Object.is(delta, -0) ? 0 : delta;
}

function copyMetrics(value: PerformanceComponentAblationMetrics): PerformanceComponentAblationMetrics {
  return { ...value };
}

function copyProvenance(value: HoldoutEpisodePathProvenance): HoldoutEpisodePathProvenance {
  return { ...value };
}

function copyCoverage(
  value: PerformanceComponentAblationPathCoverage,
): PerformanceComponentAblationPathCoverage {
  const copy = {} as PerformanceComponentAblationPathCoverage;
  for (const key of COVERAGE_KEYS) copy[key] = value[key];
  return copy;
}

function requireCoverage(
  value: PerformanceComponentAblationPathCoverage | undefined,
): PerformanceComponentAblationPathCoverage {
  validateCoverage(value);
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function requireTimestamp(value: string, label: string): PerformanceTimestamp {
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) throw new Error(`${label} must be a valid timestamp with an explicit timezone.`);
  return parsed;
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(`${label} must be finite and JSON-safe.`);
}

function requireNonNegative(value: number, label: string): void {
  requireFinite(value, label);
  if (value < 0) throw new Error(`${label} must be non-negative.`);
}

function cellKey(
  scenario: FrozenCombinedConservativeAblationScenario,
  timing: PerformanceComponentAblationTiming,
  cost: PerformanceComponentAblationCost,
): string {
  return `${scenario}:${timing}:${cost}`;
}

function isSupportedAsset(value: SupportedAsset): value is SupportedAsset {
  return value === "BTC" || value === "ETH";
}

function isTiming(value: string): value is PerformanceComponentAblationTiming {
  return (TIMING_ORDER as readonly string[]).includes(value);
}

function isCost(value: string): value is PerformanceComponentAblationCost {
  return (COST_ORDER as readonly string[]).includes(value);
}

function isAblationScenario(value: string): value is FrozenCombinedConservativeAblationScenario {
  return (FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER as readonly string[]).includes(value);
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}
