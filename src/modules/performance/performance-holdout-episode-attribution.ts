import {
  getMarketForAsset,
  type StrategyDecisionAction,
  type SupportedAsset,
  type SupportedMarket,
} from "../../domain/types.js";
import type { PositionGuardBacktestExecutionTimingModel } from "../strategy/position-guard-backtest.js";
import {
  matchPerformanceTrades,
  PERFORMANCE_QUANTITY_TOLERANCE,
  type FifoRealizationSlice,
  type PerformanceTradeFill,
  type PositionEpisode,
} from "./performance-trade-matcher.js";
import {
  comparePerformanceTimestamps,
  parsePerformanceTimestamp,
  performanceTimestampEpochNanoseconds,
} from "./performance-timestamp.js";
import type {
  CounterfactualModeledFillAttribution,
  CounterfactualScenario,
  CounterfactualScenarioResult,
} from "./strategy-counterfactual.js";

const ABLATION_SCENARIOS = [
  "COMBINED_MINUS_HTF_TREND_GATE",
  "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  "COMBINED_MINUS_ADD_LIMITED",
  "COMBINED_MINUS_COOLDOWN_CONTROL",
] as const;
const COSTS = {
  BASE: { role: "BASE", feeRate: 0.0005, slippageRate: 0.0003 },
  STRESS: { role: "STRESS", feeRate: 0.001, slippageRate: 0.002 },
} as const;

export type HoldoutEpisodeAblationScenario = (typeof ABLATION_SCENARIOS)[number];
export type HoldoutEpisodeCostCell = {
  id: keyof typeof COSTS;
  role: "BASE" | "STRESS";
  feeRate: number;
  slippageRate: number;
};

export type HoldoutEpisodePathProvenance = {
  authorityId: string;
  asset: SupportedAsset;
  market: SupportedMarket;
  timingModel: PositionGuardBacktestExecutionTimingModel;
  costCellId: HoldoutEpisodeCostCell["id"];
  costRole: HoldoutEpisodeCostCell["role"];
  feeRate: number;
  slippageRate: number;
  holdoutFrom: string;
  holdoutTo: string;
  datasetSha256: string;
  datasetFingerprint: string;
  initialStateFingerprint: string;
  developmentFrameFingerprint: string;
  replayFrameFingerprint: string;
};

export type HoldoutEpisodeAttributionInput = {
  reference: CounterfactualScenarioResult;
  ablation: CounterfactualScenarioResult;
  asset: SupportedAsset;
  market: SupportedMarket;
  timingModel: PositionGuardBacktestExecutionTimingModel;
  cost: HoldoutEpisodeCostCell;
  referenceProvenance: HoldoutEpisodePathProvenance;
  ablationProvenance: HoldoutEpisodePathProvenance;
  from: string;
  to: string;
};

export type HoldoutEpisodeRelationshipKind =
  | "EXACT_ENTRY_MATCH"
  | "EXIT_TIMING_CHANGED"
  | "REFERENCE_ONLY_LOSS"
  | "REFERENCE_ONLY_GAIN"
  | "ABLATION_ONLY"
  | "PATH_DIVERGED"
  | "CARRY_IN"
  | "OPEN_AT_TO"
  | "NET_OUTCOME_UNKNOWN";

export type HoldoutEpisodeEnvelope = {
  scenario: CounterfactualScenario;
  asset: SupportedAsset;
  market: SupportedMarket;
  timingModel: PositionGuardBacktestExecutionTimingModel;
  costCellId: HoldoutEpisodeCostCell["id"];
  episodeId: string;
  entryFillIds: readonly string[];
  exitFillIds: readonly string[];
  modeledFillAttributionFillIds: readonly string[];
  interventionFillIds: readonly string[];
  realizationSliceIds: readonly string[];
  interventionEvidenceIds: readonly string[];
  firstEnterDecisionAt: string | null;
  firstEnterDecisionEpochNanoseconds: string | null;
  firstEnterExecutedAt: string | null;
  firstEnterExecutedEpochNanoseconds: string | null;
  openedAt: string;
  openedAtEpochNanoseconds: string;
  closedAt: string | null;
  closedAtEpochNanoseconds: string | null;
  grossRealizedPnlKrw: number | null;
  realizedFeeImpactKrw: number | null;
  netRealizedPnlKrw: number | null;
  openedQuantity: number;
  realizedQuantity: number;
  remainingQuantity: number;
  holdingDurationMs: number | null;
  carryIn: boolean;
  openAtTo: boolean;
  netOutcomeKnown: boolean;
};

export type HoldoutEpisodeInterventionEvidence = {
  id: string;
  evidenceType: "RESEARCH_INTERVENTION";
  scenario: CounterfactualScenario;
  asset: SupportedAsset;
  market: SupportedMarket;
  timingModel: PositionGuardBacktestExecutionTimingModel;
  costCellId: HoldoutEpisodeCostCell["id"];
  decisionEvidenceId: string;
  decisionGeneratedAt: string;
  decisionGeneratedAtEpochNanoseconds: string;
  decisionFrameIndex: number;
  originalAction: StrategyDecisionAction;
  effectiveAction: StrategyDecisionAction;
  outcome: "ALLOW" | "SUPPRESS" | "OVERRIDE_EXIT";
  reason: string;
  linkedFillId: string | null;
  linkedStrategyDecisionId: string | null;
  linkedEpisodeId: string | null;
};

export type HoldoutEpisodeRelationship = {
  relationshipKind: HoldoutEpisodeRelationshipKind;
  classifications: readonly HoldoutEpisodeRelationshipKind[];
  entryKeyEpochNanoseconds: string | null;
  reference: HoldoutEpisodeEnvelope | null;
  ablation: HoldoutEpisodeEnvelope | null;
  closedKnownPnlComparable: boolean;
  netPnlDeltaKrw: number | null;
};

export type HoldoutEpisodeAttributionCounts = {
  totalRelationships: number;
  exactEntryMatches: number;
  exitTimingChanged: number;
  referenceOnlyLoss: number;
  referenceOnlyGain: number;
  ablationOnly: number;
  pathDiverged: number;
  carryIn: number;
  openAtTo: number;
  netOutcomeUnknown: number;
  closedKnownPnlComparisons: number;
};

export type HoldoutEpisodeAttributionResult = {
  analysisKind: "HOLDOUT_EPISODE_COMPONENT_ABLATION_ATTRIBUTION";
  readonly referenceScenario: "COMBINED_CONSERVATIVE";
  readonly ablationScenario: HoldoutEpisodeAblationScenario;
  readOnly: true;
  causalClaim: false;
  deploymentApproval: false;
  prospectiveApproval: false;
  provenance: HoldoutEpisodePathProvenance;
  referenceInterventions: readonly HoldoutEpisodeInterventionEvidence[];
  ablationInterventions: readonly HoldoutEpisodeInterventionEvidence[];
  relationships: readonly HoldoutEpisodeRelationship[];
  counts: HoldoutEpisodeAttributionCounts;
  warnings: readonly string[];
};

type NormalizedEpisode = {
  envelope: HoldoutEpisodeEnvelope;
  entryKey: bigint | null;
  exitStructure: string;
};

type NormalizedPath = {
  episodes: readonly NormalizedEpisode[];
  interventions: readonly HoldoutEpisodeInterventionEvidence[];
};

export function analyzeHoldoutEpisodeAttribution(
  input: HoldoutEpisodeAttributionInput,
): HoldoutEpisodeAttributionResult {
  const from = requireTimestamp(input.from, "from");
  const to = requireTimestamp(input.to, "to");
  if (from.epochNanoseconds >= to.epochNanoseconds) {
    throw new Error("Holdout [from,to) requires from to be before to.");
  }
  validateCell(input, from.normalized, to.normalized);
  validateScenario(input.reference, "reference", input.timingModel);
  validateScenario(input.ablation, "ablation", input.timingModel);

  const reference = normalizePath(input, input.reference, from.epochNanoseconds, to.epochNanoseconds);
  const ablation = normalizePath(input, input.ablation, from.epochNanoseconds, to.epochNanoseconds);
  const relationships = relateEpisodes(reference.episodes, ablation.episodes);
  const counts = countRelationships(relationships);

  return deepFreeze({
    analysisKind: "HOLDOUT_EPISODE_COMPONENT_ABLATION_ATTRIBUTION",
    referenceScenario: "COMBINED_CONSERVATIVE",
    ablationScenario: input.ablation.scenario as HoldoutEpisodeAblationScenario,
    readOnly: true,
    causalClaim: false,
    deploymentApproval: false,
    prospectiveApproval: false,
    provenance: normalizeProvenance(input.referenceProvenance),
    referenceInterventions: reference.interventions,
    ablationInterventions: ablation.interventions,
    relationships,
    counts,
    warnings: warningsFor(counts),
  });
}

function validateCell(
  input: HoldoutEpisodeAttributionInput,
  normalizedFrom: string,
  normalizedTo: string,
): void {
  if (getMarketForAsset(input.asset) !== input.market) {
    throw new Error("Holdout episode asset and market do not match.");
  }
  if (input.timingModel !== "SAME_CLOSE_MODELED" && input.timingModel !== "NEXT_FRAME_MODELED") {
    throw new Error("Holdout episode timing model is invalid.");
  }
  const expectedCost = COSTS[input.cost.id];
  if (
    !expectedCost || input.cost.role !== expectedCost.role
    || input.cost.feeRate !== expectedCost.feeRate
    || input.cost.slippageRate !== expectedCost.slippageRate
  ) {
    throw new Error("Holdout episode cost cell does not match the frozen cost authority.");
  }
  validateProvenance(input.referenceProvenance, input, normalizedFrom, normalizedTo);
  validateProvenance(input.ablationProvenance, input, normalizedFrom, normalizedTo);
  if (stableProvenanceKey(input.referenceProvenance) !== stableProvenanceKey(input.ablationProvenance)) {
    throw new Error("Reference and ablation provenance mismatch.");
  }
}

function validateProvenance(
  provenance: HoldoutEpisodePathProvenance,
  input: HoldoutEpisodeAttributionInput,
  normalizedFrom: string,
  normalizedTo: string,
): void {
  if (
    provenance.asset !== input.asset || provenance.market !== input.market
    || provenance.timingModel !== input.timingModel
    || provenance.costCellId !== input.cost.id || provenance.costRole !== input.cost.role
    || provenance.feeRate !== input.cost.feeRate
    || provenance.slippageRate !== input.cost.slippageRate
    || requireTimestamp(provenance.holdoutFrom, "provenance holdoutFrom").normalized !== normalizedFrom
    || requireTimestamp(provenance.holdoutTo, "provenance holdoutTo").normalized !== normalizedTo
  ) {
    throw new Error("Holdout episode provenance does not match the selected asset/timing/cost/range cell.");
  }
  if (!/^[a-f0-9]{64}$/.test(provenance.datasetSha256)) {
    throw new Error("Holdout episode provenance datasetSha256 must be lowercase SHA-256.");
  }
  for (const [name, value] of Object.entries({
    authorityId: provenance.authorityId,
    datasetFingerprint: provenance.datasetFingerprint,
    initialStateFingerprint: provenance.initialStateFingerprint,
    developmentFrameFingerprint: provenance.developmentFrameFingerprint,
    replayFrameFingerprint: provenance.replayFrameFingerprint,
  })) {
    if (value.trim().length === 0) throw new Error(`Holdout episode provenance ${name} is required.`);
  }
}

function validateScenario(
  result: CounterfactualScenarioResult,
  role: "reference" | "ablation",
  timingModel: PositionGuardBacktestExecutionTimingModel,
): void {
  if (result.evidenceKind !== "SIMULATED_COUNTERFACTUAL") {
    throw new Error(`${role} scenario must be simulated counterfactual evidence.`);
  }
  if (role === "reference" && result.scenario !== "COMBINED_CONSERVATIVE") {
    throw new Error("Reference scenario must be COMBINED_CONSERVATIVE.");
  }
  if (role === "ablation" && !isAblationScenario(result.scenario)) {
    throw new Error("Ablation scenario must be one frozen COMBINED_CONSERVATIVE ablation.");
  }
  if (result.executionPolicy?.id !== result.scenario) {
    throw new Error(`${role} scenario execution policy does not match its scenario role.`);
  }
  if (result.executionTimingProvenance.model !== timingModel) {
    throw new Error(`${role} scenario timing provenance does not match the selected timing cell.`);
  }
  if (result.executionTimingProvenance.observedExecution !== false) {
    throw new Error(`${role} scenario must retain modeled execution timing provenance.`);
  }
}

function normalizePath(
  input: HoldoutEpisodeAttributionInput,
  result: CounterfactualScenarioResult,
  from: bigint,
  to: bigint,
): NormalizedPath {
  validateDeclaredLifecycleBeforeTo(result, to);
  const boundedFills = result.fills.filter((fill) => {
    const instant = requireTimestamp(fill.filledAt, `fill ${fill.id} filledAt`).epochNanoseconds;
    return instant < to;
  });
  for (const fill of boundedFills) {
    if (fill.market !== input.market) throw new Error(`Fill ${fill.id} does not match the selected market.`);
  }
  let matched: ReturnType<typeof matchPerformanceTrades>;
  try {
    matched = matchPerformanceTrades({ fills: boundedFills });
  } catch (error) {
    throw new Error(`Holdout episode lifecycle evidence is invalid: ${messageOf(error)}`);
  }
  if (matched.unmatchedSells.length > 0 || matched.attributionFailures.length > 0) {
    throw new Error("Holdout episode lifecycle contains an unmatched sell or attribution failure.");
  }
  validateDeclaredMatchResultWhenFullyBounded(result, matched, to);

  const fills = new Map(boundedFills.map((fill) => [fill.id, fill]));
  const realizationSlices = new Map(matched.realizationSlices.map((slice) => [slice.id, slice]));
  const frames = result.sourceFrames.map((frame, index) => ({
    index,
    timestamp: requireTimestamp(frame.generatedAt, `source frame ${index} generatedAt`),
  })).filter((frame) => frame.timestamp.epochNanoseconds < to);
  const attributions = indexAttributions(result, fills, frames, to);
  const normalized = matched.episodes.map((episode) => normalizeEpisode({
    input,
    result,
    episode,
    fills,
    realizationSlices,
    attributions,
    frames,
    from,
  })).filter((episode) =>
    episode.envelope.closedAtEpochNanoseconds === null
    || BigInt(episode.envelope.closedAtEpochNanoseconds) >= from
  );
  rejectDuplicateEntryKeys(normalized, result.scenario);
  const orderedEpisodes = normalized.sort(compareNormalizedEpisodes);
  const interventions = normalizeInterventions({
    input,
    result,
    fills,
    attributions,
    frames,
    episodes: orderedEpisodes,
    from,
    to,
  });
  const evidenceIdsByEpisode = new Map<string, string[]>();
  for (const evidence of interventions) {
    if (evidence.linkedEpisodeId === null) continue;
    const ids = evidenceIdsByEpisode.get(evidence.linkedEpisodeId) ?? [];
    ids.push(evidence.id);
    evidenceIdsByEpisode.set(evidence.linkedEpisodeId, ids);
  }
  return {
    episodes: orderedEpisodes.map((episode) => ({
      ...episode,
      envelope: {
        ...episode.envelope,
        interventionEvidenceIds: evidenceIdsByEpisode.get(episode.envelope.episodeId) ?? [],
      },
    })),
    interventions,
  };
}

function indexAttributions(
  result: CounterfactualScenarioResult,
  fills: ReadonlyMap<string, PerformanceTradeFill>,
  frames: readonly { index: number; timestamp: NonNullable<ReturnType<typeof parsePerformanceTimestamp>> }[],
  to: bigint,
): Map<string, CounterfactualModeledFillAttribution> {
  const indexed = new Map<string, CounterfactualModeledFillAttribution>();
  for (const attribution of result.modeledFillAttributions ?? []) {
    const fill = fills.get(attribution.fillId);
    if (!fill) continue;
    if (indexed.has(attribution.fillId)) throw new Error(`Duplicate modeled fill attribution ${attribution.fillId}.`);
    if (attribution.scenario !== result.scenario) throw new Error(`Attribution ${attribution.fillId} scenario mismatch.`);
    const decision = requireTimestamp(attribution.decisionGeneratedAt, `attribution ${attribution.fillId} decisionGeneratedAt`);
    const executed = requireTimestamp(attribution.executedAt, `attribution ${attribution.fillId} executedAt`);
    if (executed.epochNanoseconds >= to || comparePerformanceTimestamps(attribution.executedAt, fill.filledAt) !== 0) {
      throw new Error(`Attribution ${attribution.fillId} execution instant mismatch.`);
    }
    if (
      !Number.isInteger(attribution.decisionFrameIndex) || attribution.decisionFrameIndex < 0
      || !Number.isInteger(attribution.executionFrameIndex) || attribution.executionFrameIndex < 0
    ) {
      throw new Error(`Attribution ${attribution.fillId} frame indexes must be non-negative integers.`);
    }
    if (decision.epochNanoseconds > executed.epochNanoseconds) {
      throw new Error(`Attribution ${attribution.fillId} decision occurs after execution.`);
    }
    const decisionFrame = frames.find((frame) => frame.index === attribution.decisionFrameIndex);
    const executionFrame = frames.find((frame) => frame.index === attribution.executionFrameIndex);
    if (
      !decisionFrame || decisionFrame.timestamp.epochNanoseconds !== decision.epochNanoseconds
      || !executionFrame || executionFrame.timestamp.epochNanoseconds !== executed.epochNanoseconds
    ) {
      throw new Error(`Attribution ${attribution.fillId} frame provenance mismatch.`);
    }
    if (attribution.effectiveAction !== fill.decisionAction) {
      throw new Error(`Attribution ${attribution.fillId} effective action contradicts its fill.`);
    }
    if (attribution.intervention !== null && attribution.intervention.reason.trim().length === 0) {
      throw new Error(`Attribution ${attribution.fillId} intervention reason is required.`);
    }
    indexed.set(attribution.fillId, attribution);
  }
  return indexed;
}

function normalizeEpisode(input: {
  input: HoldoutEpisodeAttributionInput;
  result: CounterfactualScenarioResult;
  episode: PositionEpisode;
  fills: ReadonlyMap<string, PerformanceTradeFill>;
  realizationSlices: ReadonlyMap<string, FifoRealizationSlice>;
  attributions: ReadonlyMap<string, CounterfactualModeledFillAttribution>;
  frames: readonly { index: number; timestamp: NonNullable<ReturnType<typeof parsePerformanceTimestamp>> }[];
  from: bigint;
}): NormalizedEpisode {
  const entryFills = input.episode.entryFillIds.map((id) => requireFill(input.fills, id, input.episode.id));
  const exitFills = input.episode.exitFillIds.map((id) => requireFill(input.fills, id, input.episode.id));
  const enterFills = entryFills.filter((fill) => fill.decisionAction === "ENTER").sort(compareFills);
  const firstEnter = enterFills[0] ?? null;
  const entryAttribution = firstEnter === null ? null : input.attributions.get(firstEnter.id) ?? null;
  let decisionAt: string | null = entryAttribution?.decisionGeneratedAt ?? null;
  if (firstEnter && !decisionAt && input.input.timingModel === "SAME_CLOSE_MODELED") {
    const executionEpoch = performanceTimestampEpochNanoseconds(firstEnter.filledAt);
    const matchingFrames = input.frames.filter((frame) => frame.timestamp.epochNanoseconds === executionEpoch);
    if (matchingFrames.length !== 1) {
      throw new Error(`SAME_CLOSE_MODELED entry ${firstEnter.id} requires one source frame at its execution instant.`);
    }
    decisionAt = matchingFrames[0]!.timestamp.normalized;
  }
  if (firstEnter && !decisionAt && input.input.timingModel === "NEXT_FRAME_MODELED") {
    throw new Error(`NEXT_FRAME_MODELED entry ${firstEnter.id} requires modeled fill attribution.`);
  }

  const opened = requireTimestamp(input.episode.openedAt, `episode ${input.episode.id} openedAt`);
  const closed = input.episode.closedAt === null
    ? null
    : requireTimestamp(input.episode.closedAt, `episode ${input.episode.id} closedAt`);
  const decision = decisionAt === null ? null : requireTimestamp(decisionAt, `episode ${input.episode.id} decisionAt`);
  const executed = firstEnter === null ? null : requireTimestamp(firstEnter.filledAt, `entry fill ${firstEnter.id}`);
  const attributionIds = [...new Set([...entryFills, ...exitFills]
    .filter((fill) => input.attributions.has(fill.id)).map((fill) => fill.id))].sort();
  const interventionIds = attributionIds.filter((id) => input.attributions.get(id)?.intervention !== null);
  const carryIn = opened.epochNanoseconds < input.from;
  const openAtTo = input.episode.status === "OPEN";
  const netOutcomeKnown = !openAtTo && input.episode.netRealizedPnlKrw !== null;
  const realizationSlices = input.episode.realizationSliceIds.map((id) => {
    const slice = input.realizationSlices.get(id);
    if (!slice) throw new Error(`Episode ${input.episode.id} references missing realization slice ${id}.`);
    if (slice.episodeId !== input.episode.id) {
      throw new Error(`Realization slice ${id} does not link back to episode ${input.episode.id}.`);
    }
    return slice;
  });
  const openedQuantity = sumQuantities(entryFills.map((fill) => fill.volume), "opened quantity");
  const realizedQuantity = sumQuantities(
    realizationSlices.map((slice) => slice.quantity),
    "realized quantity",
  );
  const remainingQuantity = finiteNonNegative(input.episode.remainingQuantity, "remaining quantity");
  if (
    realizedQuantity > openedQuantity + PERFORMANCE_QUANTITY_TOLERANCE
    || Math.abs(openedQuantity - realizedQuantity - remainingQuantity) > PERFORMANCE_QUANTITY_TOLERANCE
  ) {
    throw new Error(`Episode ${input.episode.id} quantity conservation is invalid.`);
  }

  return {
    entryKey: decision?.epochNanoseconds ?? null,
    exitStructure: JSON.stringify(exitFills.sort(compareFills).map((fill) => [
      requireTimestamp(fill.filledAt, `exit fill ${fill.id}`).epochNanoseconds.toString(),
      fill.decisionAction,
      fill.volume,
    ])),
    envelope: {
      scenario: input.result.scenario,
      asset: input.input.asset,
      market: input.input.market,
      timingModel: input.input.timingModel,
      costCellId: input.input.cost.id,
      episodeId: input.episode.id,
      entryFillIds: entryFills.sort(compareFills).map((fill) => fill.id),
      exitFillIds: exitFills.sort(compareFills).map((fill) => fill.id),
      modeledFillAttributionFillIds: attributionIds,
      interventionFillIds: interventionIds,
      realizationSliceIds: realizationSlices.map((slice) => slice.id),
      interventionEvidenceIds: [],
      firstEnterDecisionAt: decision?.normalized ?? null,
      firstEnterDecisionEpochNanoseconds: decision?.epochNanoseconds.toString() ?? null,
      firstEnterExecutedAt: executed?.normalized ?? null,
      firstEnterExecutedEpochNanoseconds: executed?.epochNanoseconds.toString() ?? null,
      openedAt: opened.normalized,
      openedAtEpochNanoseconds: opened.epochNanoseconds.toString(),
      closedAt: closed?.normalized ?? null,
      closedAtEpochNanoseconds: closed?.epochNanoseconds.toString() ?? null,
      grossRealizedPnlKrw: finiteOrNull(input.episode.grossRealizedPnlKrw, "gross realized PnL"),
      realizedFeeImpactKrw: finiteNonNegativeOrNull(input.episode.realizedFeeImpactKrw, "realized fee impact"),
      netRealizedPnlKrw: finiteOrNull(input.episode.netRealizedPnlKrw, "net realized PnL"),
      openedQuantity,
      realizedQuantity,
      remainingQuantity,
      holdingDurationMs: finiteNonNegativeOrNull(input.episode.holdingDurationMs, "holding duration"),
      carryIn,
      openAtTo,
      netOutcomeKnown,
    },
  };
}

function normalizeInterventions(input: {
  input: HoldoutEpisodeAttributionInput;
  result: CounterfactualScenarioResult;
  fills: ReadonlyMap<string, PerformanceTradeFill>;
  attributions: ReadonlyMap<string, CounterfactualModeledFillAttribution>;
  frames: readonly { index: number; timestamp: NonNullable<ReturnType<typeof parsePerformanceTimestamp>> }[];
  episodes: readonly NormalizedEpisode[];
  from: bigint;
  to: bigint;
}): HoldoutEpisodeInterventionEvidence[] {
  const records: HoldoutEpisodeInterventionEvidence[] = [];
  const attributions = [...input.attributions.values()];
  for (const [frameIndex, frame] of input.result.legacyBacktest.result.frames.entries()) {
    const intervention = frame.researchIntervention;
    if (intervention === null || intervention === undefined) continue;
    const generatedAt = requireTimestamp(frame.generatedAt, `intervention frame ${frameIndex} generatedAt`);
    if (generatedAt.epochNanoseconds < input.from || generatedAt.epochNanoseconds >= input.to) continue;
    const sourceFrame = input.frames.find((candidate) => candidate.index === frameIndex);
    if (!sourceFrame || sourceFrame.timestamp.epochNanoseconds !== generatedAt.epochNanoseconds) {
      throw new Error(`Intervention frame ${frameIndex} does not match source-frame timing evidence.`);
    }
    const interventionGeneratedAt = requireTimestamp(
      intervention.generatedAt,
      `intervention frame ${frameIndex} intervention generatedAt`,
    );
    if (interventionGeneratedAt.epochNanoseconds !== generatedAt.epochNanoseconds) {
      throw new Error(`Intervention frame ${frameIndex} intervention generatedAt does not match its frame instant.`);
    }
    if (intervention.scenario !== input.result.scenario) {
      throw new Error(`Intervention frame ${frameIndex} scenario does not match its replay path.`);
    }
    if (frame.decision.action !== intervention.originalAction) {
      throw new Error(`Intervention frame ${frameIndex} original action contradicts its decision.`);
    }
    if (intervention.reason.trim().length === 0) {
      throw new Error(`Intervention frame ${frameIndex} reason is required.`);
    }
    const candidates = attributions.filter((attribution) =>
      attribution.decisionFrameIndex === frameIndex
      && requireTimestamp(
        attribution.decisionGeneratedAt,
        `attribution ${attribution.fillId} decisionGeneratedAt`,
      ).epochNanoseconds === generatedAt.epochNanoseconds);
    if (candidates.length > 1) {
      throw new Error(`Intervention frame ${frameIndex} links to multiple modeled fills.`);
    }
    const attribution = candidates[0] ?? null;
    if (attribution !== null && (
      attribution.originalAction !== intervention.originalAction
      || attribution.effectiveAction !== intervention.effectiveAction
      || attribution.intervention?.outcome !== intervention.outcome
      || attribution.intervention.reason !== intervention.reason
    )) {
      throw new Error(`Intervention frame ${frameIndex} contradicts its modeled fill attribution.`);
    }
    const fill = attribution === null ? null : input.fills.get(attribution.fillId) ?? null;
    if (attribution !== null && fill === null) {
      throw new Error(`Intervention frame ${frameIndex} references missing fill ${attribution.fillId}.`);
    }
    const linkedEpisodeId = resolveInterventionEpisodeId(
      input.episodes,
      generatedAt.epochNanoseconds,
      fill?.id ?? null,
    );
    const decisionEvidenceId = [
      "decision",
      input.result.scenario,
      input.input.asset,
      generatedAt.epochNanoseconds.toString(),
      frameIndex,
    ].join(":");
    records.push({
      id: [
        "intervention",
        input.result.scenario,
        input.input.asset,
        generatedAt.epochNanoseconds.toString(),
        frameIndex,
        intervention.outcome,
        intervention.originalAction,
        intervention.effectiveAction,
        intervention.reason,
      ].join(":"),
      evidenceType: "RESEARCH_INTERVENTION",
      scenario: input.result.scenario,
      asset: input.input.asset,
      market: input.input.market,
      timingModel: input.input.timingModel,
      costCellId: input.input.cost.id,
      decisionEvidenceId,
      decisionGeneratedAt: generatedAt.normalized,
      decisionGeneratedAtEpochNanoseconds: generatedAt.epochNanoseconds.toString(),
      decisionFrameIndex: frameIndex,
      originalAction: intervention.originalAction,
      effectiveAction: intervention.effectiveAction,
      outcome: intervention.outcome,
      reason: intervention.reason,
      linkedFillId: fill?.id ?? null,
      linkedStrategyDecisionId: fill?.strategyDecisionId ?? null,
      linkedEpisodeId,
    });
  }
  records.sort(compareInterventions);
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`Duplicate intervention evidence id ${record.id}.`);
    ids.add(record.id);
  }
  return records;
}

function resolveInterventionEpisodeId(
  episodes: readonly NormalizedEpisode[],
  decisionAt: bigint,
  fillId: string | null,
): string | null {
  if (fillId !== null) {
    const linked = episodes.filter((episode) =>
      episode.envelope.entryFillIds.includes(fillId)
      || episode.envelope.exitFillIds.includes(fillId));
    if (linked.length !== 1) {
      throw new Error(`Intervention fill ${fillId} must link to exactly one selected-stream episode.`);
    }
    return linked[0]!.envelope.episodeId;
  }
  const active = episodes.filter((episode) => {
    const opened = BigInt(episode.envelope.openedAtEpochNanoseconds);
    const closed = episode.envelope.closedAtEpochNanoseconds === null
      ? null
      : BigInt(episode.envelope.closedAtEpochNanoseconds);
    return opened <= decisionAt && (closed === null || decisionAt < closed);
  });
  if (active.length > 1) throw new Error("Intervention instant maps to multiple active episodes.");
  return active[0]?.envelope.episodeId ?? null;
}

function compareInterventions(
  left: HoldoutEpisodeInterventionEvidence,
  right: HoldoutEpisodeInterventionEvidence,
): number {
  return compareNanosecondStrings(
    left.decisionGeneratedAtEpochNanoseconds,
    right.decisionGeneratedAtEpochNanoseconds,
  ) || left.decisionFrameIndex - right.decisionFrameIndex || left.id.localeCompare(right.id);
}

function relateEpisodes(
  reference: readonly NormalizedEpisode[],
  ablation: readonly NormalizedEpisode[],
): HoldoutEpisodeRelationship[] {
  const referenceByKey = new Map(reference.filter(hasKey).map((item) => [item.entryKey.toString(), item]));
  const ablationByKey = new Map(ablation.filter(hasKey).map((item) => [item.entryKey.toString(), item]));
  const rows: HoldoutEpisodeRelationship[] = [];
  const keys = [...new Set([...referenceByKey.keys(), ...ablationByKey.keys()])]
    .sort(compareNanosecondStrings);
  for (const key of keys) {
    rows.push(buildRelationship(referenceByKey.get(key) ?? null, ablationByKey.get(key) ?? null, key));
  }
  for (const item of reference.filter((episode) => episode.entryKey === null)) {
    rows.push(buildRelationship(item, null, null));
  }
  for (const item of ablation.filter((episode) => episode.entryKey === null)) {
    rows.push(buildRelationship(null, item, null));
  }
  return rows.sort(compareRelationships);
}

function buildRelationship(
  reference: NormalizedEpisode | null,
  ablation: NormalizedEpisode | null,
  key: string | null,
): HoldoutEpisodeRelationship {
  const envelopes = [reference?.envelope, ablation?.envelope].filter(
    (item): item is HoldoutEpisodeEnvelope => item !== undefined,
  );
  const classifications: HoldoutEpisodeRelationshipKind[] = [];
  if (reference && ablation) {
    classifications.push("EXACT_ENTRY_MATCH");
    if (reference.exitStructure !== ablation.exitStructure) classifications.push("EXIT_TIMING_CHANGED");
  }
  if (envelopes.some((item) => item.carryIn)) classifications.push("CARRY_IN");
  if (envelopes.some((item) => item.openAtTo)) classifications.push("OPEN_AT_TO");
  if (envelopes.some((item) => !item.openAtTo && !item.netOutcomeKnown)) classifications.push("NET_OUTCOME_UNKNOWN");
  if (classifications.length === 0) {
    if (key === null) classifications.push("PATH_DIVERGED");
    else if (reference) {
      const pnl = reference.envelope.netRealizedPnlKrw;
      classifications.push(pnl !== null && pnl < 0
        ? "REFERENCE_ONLY_LOSS"
        : pnl !== null && pnl > 0
          ? "REFERENCE_ONLY_GAIN"
          : "PATH_DIVERGED");
    }
    else classifications.push("ABLATION_ONLY");
  }
  const closedKnownPnlComparable = reference !== null && ablation !== null
    && envelopes.every((item) => !item.carryIn && !item.openAtTo && item.netOutcomeKnown);
  const netPnlDeltaKrw = closedKnownPnlComparable
    ? ablation.envelope.netRealizedPnlKrw! - reference.envelope.netRealizedPnlKrw!
    : null;
  if (netPnlDeltaKrw !== null && !Number.isFinite(netPnlDeltaKrw)) {
    throw new Error("Episode net PnL delta must be finite.");
  }
  const primary = primaryClassification(classifications);
  return {
    relationshipKind: primary,
    classifications,
    entryKeyEpochNanoseconds: key,
    reference: reference?.envelope ?? null,
    ablation: ablation?.envelope ?? null,
    closedKnownPnlComparable,
    netPnlDeltaKrw,
  };
}

function primaryClassification(
  classifications: readonly HoldoutEpisodeRelationshipKind[],
): HoldoutEpisodeRelationshipKind {
  for (const kind of ["CARRY_IN", "OPEN_AT_TO", "NET_OUTCOME_UNKNOWN"] as const) {
    if (classifications.includes(kind)) return kind;
  }
  return classifications.includes("EXIT_TIMING_CHANGED") ? "EXIT_TIMING_CHANGED" : classifications[0]!;
}

function countRelationships(rows: readonly HoldoutEpisodeRelationship[]): HoldoutEpisodeAttributionCounts {
  const count = (kind: HoldoutEpisodeRelationshipKind): number =>
    rows.filter((row) => row.classifications.includes(kind)).length;
  return {
    totalRelationships: rows.length,
    exactEntryMatches: count("EXACT_ENTRY_MATCH"),
    exitTimingChanged: count("EXIT_TIMING_CHANGED"),
    referenceOnlyLoss: count("REFERENCE_ONLY_LOSS"),
    referenceOnlyGain: count("REFERENCE_ONLY_GAIN"),
    ablationOnly: count("ABLATION_ONLY"),
    pathDiverged: count("PATH_DIVERGED"),
    carryIn: count("CARRY_IN"),
    openAtTo: count("OPEN_AT_TO"),
    netOutcomeUnknown: count("NET_OUTCOME_UNKNOWN"),
    closedKnownPnlComparisons: rows.filter((row) => row.closedKnownPnlComparable).length,
  };
}

function warningsFor(counts: HoldoutEpisodeAttributionCounts): string[] {
  const warnings: string[] = [];
  if (counts.carryIn > 0) warnings.push("Carry-in episodes are excluded from closed known PnL comparisons.");
  if (counts.openAtTo > 0) warnings.push("Episodes open at the exclusive holdout end are excluded from closed known PnL comparisons.");
  if (counts.netOutcomeUnknown > 0) warnings.push("Episodes with unknown net outcomes are excluded from closed known PnL comparisons.");
  if (counts.pathDiverged > 0) warnings.push("Path-diverged episodes have no unique executed ENTER decision key.");
  return warnings;
}

function normalizeProvenance(value: HoldoutEpisodePathProvenance): HoldoutEpisodePathProvenance {
  return {
    authorityId: value.authorityId,
    asset: value.asset,
    market: value.market,
    timingModel: value.timingModel,
    costCellId: value.costCellId,
    costRole: value.costRole,
    feeRate: value.feeRate,
    slippageRate: value.slippageRate,
    holdoutFrom: requireTimestamp(value.holdoutFrom, "provenance holdoutFrom").normalized,
    holdoutTo: requireTimestamp(value.holdoutTo, "provenance holdoutTo").normalized,
    datasetSha256: value.datasetSha256,
    datasetFingerprint: value.datasetFingerprint,
    initialStateFingerprint: value.initialStateFingerprint,
    developmentFrameFingerprint: value.developmentFrameFingerprint,
    replayFrameFingerprint: value.replayFrameFingerprint,
  };
}

function validateDeclaredLifecycleBeforeTo(
  result: CounterfactualScenarioResult,
  to: bigint,
): void {
  const fills = new Map(result.fills.map((fill) => [fill.id, fill]));
  const failureFillIds = [
    ...result.matchResult.unmatchedSells.map((failure) => failure.fillId),
    ...result.matchResult.attributionFailures.map((failure) => failure.causingFillId),
  ];
  for (const fillId of failureFillIds) {
    const fill = fills.get(fillId);
    if (!fill) throw new Error(`Declared lifecycle failure references missing fill ${fillId}.`);
    if (requireTimestamp(fill.filledAt, `lifecycle failure fill ${fillId}`).epochNanoseconds < to) {
      throw new Error(`Holdout episode lifecycle contains an unmatched sell ${fillId}.`);
    }
  }
}

function validateDeclaredMatchResultWhenFullyBounded(
  result: CounterfactualScenarioResult,
  recomputed: ReturnType<typeof matchPerformanceTrades>,
  to: bigint,
): void {
  const fullyBounded = result.fills.every((fill) =>
    requireTimestamp(fill.filledAt, `fill ${fill.id} filledAt`).epochNanoseconds < to);
  if (!fullyBounded) return;
  if (JSON.stringify(result.matchResult) !== JSON.stringify(recomputed)) {
    throw new Error(
      "Declared FIFO lifecycle evidence has malformed realization links or quantities for the bounded fills.",
    );
  }
}

function stableProvenanceKey(value: HoldoutEpisodePathProvenance): string {
  return JSON.stringify(normalizeProvenance(value));
}

function rejectDuplicateEntryKeys(episodes: readonly NormalizedEpisode[], scenario: CounterfactualScenario): void {
  const seen = new Set<string>();
  for (const episode of episodes) {
    if (episode.entryKey === null) continue;
    const key = episode.entryKey.toString();
    if (seen.has(key)) throw new Error(`Scenario ${scenario} has duplicate entry key ${key}.`);
    seen.add(key);
  }
}

function compareNormalizedEpisodes(left: NormalizedEpisode, right: NormalizedEpisode): number {
  if (left.entryKey !== null && right.entryKey !== null) return left.entryKey < right.entryKey ? -1 : left.entryKey > right.entryKey ? 1 : left.envelope.episodeId.localeCompare(right.envelope.episodeId);
  if (left.entryKey !== null) return -1;
  if (right.entryKey !== null) return 1;
  return compareNanosecondStrings(left.envelope.openedAtEpochNanoseconds, right.envelope.openedAtEpochNanoseconds)
    || left.envelope.episodeId.localeCompare(right.envelope.episodeId);
}

function compareRelationships(left: HoldoutEpisodeRelationship, right: HoldoutEpisodeRelationship): number {
  const leftAt = left.entryKeyEpochNanoseconds ?? left.reference?.openedAtEpochNanoseconds ?? left.ablation?.openedAtEpochNanoseconds ?? "0";
  const rightAt = right.entryKeyEpochNanoseconds ?? right.reference?.openedAtEpochNanoseconds ?? right.ablation?.openedAtEpochNanoseconds ?? "0";
  return compareNanosecondStrings(leftAt, rightAt)
    || pathOrder(left) - pathOrder(right)
    || (left.reference?.episodeId ?? left.ablation?.episodeId ?? "").localeCompare(
      right.reference?.episodeId ?? right.ablation?.episodeId ?? "",
    );
}

function pathOrder(row: HoldoutEpisodeRelationship): number {
  return row.reference !== null ? 0 : 1;
}

function compareNanosecondStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function compareFills(left: PerformanceTradeFill, right: PerformanceTradeFill): number {
  return comparePerformanceTimestamps(left.filledAt, right.filledAt) || left.id.localeCompare(right.id);
}

function requireFill(
  fills: ReadonlyMap<string, PerformanceTradeFill>,
  fillId: string,
  episodeId: string,
): PerformanceTradeFill {
  const fill = fills.get(fillId);
  if (!fill) throw new Error(`Episode ${episodeId} references missing fill ${fillId}.`);
  return fill;
}

function requireTimestamp(value: string, label: string): NonNullable<ReturnType<typeof parsePerformanceTimestamp>> {
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) throw new Error(`${label} must be an exact ISO-8601 timestamp with an explicit timezone.`);
  return parsed;
}

function finiteOrNull(value: number | null, label: string): number | null {
  if (value !== null && !Number.isFinite(value)) throw new Error(`${label} must be finite or null.`);
  return value;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || Object.is(value, -0)) {
    throw new Error(`${label} must be finite and non-negative.`);
  }
  return value;
}

function finiteNonNegativeOrNull(value: number | null, label: string): number | null {
  return value === null ? null : finiteNonNegative(value, label);
}

function sumQuantities(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    total += finiteNonNegative(value, label);
    if (!Number.isFinite(total)) throw new Error(`${label} sum must be finite.`);
  }
  return Math.abs(total) <= PERFORMANCE_QUANTITY_TOLERANCE ? 0 : total;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function hasKey(value: NormalizedEpisode): value is NormalizedEpisode & { entryKey: bigint } {
  return value.entryKey !== null;
}

function isAblationScenario(value: CounterfactualScenario): value is HoldoutEpisodeAblationScenario {
  return (ABLATION_SCENARIOS as readonly CounterfactualScenario[]).includes(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
