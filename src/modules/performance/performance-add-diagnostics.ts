import {
  getMarketForAsset,
  type SupportedAsset,
  type SupportedMarket,
} from "../../domain/types.js";
import type {
  PositionGuardBacktestFrame,
  PositionGuardBacktestFrameResult,
} from "../strategy/position-guard-backtest.js";
import type {
  StrategyMarketRegime,
  StrategyWeakeningStage,
} from "../strategy/position-guard-core.js";
import type { CounterfactualScenario } from "./strategy-counterfactual.js";
import type {
  FifoRealizationSlice,
  PerformanceTradeFill,
  PerformanceTradeMatchResult,
  PositionEpisode,
} from "./performance-trade-matcher.js";
import { PERFORMANCE_QUANTITY_TOLERANCE } from "./performance-trade-matcher.js";
import {
  comparePerformanceTimestamps,
  parsePerformanceTimestamp,
  performanceTimestampEpochNanoseconds,
} from "./performance-timestamp.js";

export type AddDecisionPairingStatus =
  | "EXECUTED_VS_SUPPRESSED"
  | "BASELINE_NOT_EXECUTED"
  | "PATH_DECISION_DIVERGED";

export type AddDecisionDiagnosticsPath = {
  scenario: CounterfactualScenario;
  sourceFrames: readonly PositionGuardBacktestFrame[];
  frames: readonly PositionGuardBacktestFrameResult[];
  fills: readonly PerformanceTradeFill[];
  matchResult: PerformanceTradeMatchResult;
};

export type AddDecisionDiagnosticsInput = {
  asset: SupportedAsset;
  market: SupportedMarket;
  baseline: AddDecisionDiagnosticsPath;
  noAdd: AddDecisionDiagnosticsPath;
  breakevenToleranceKrw: number;
};

export type AddEpisodeOutcome = "WIN" | "LOSS" | "BREAKEVEN" | "UNKNOWN";

export type AddCostAndFeeImpact = {
  status: "AVAILABLE" | "UNKNOWN";
  completeness: "COMPLETE" | "FEE_EVIDENCE_INCOMPLETE" | "NOT_AVAILABLE";
  reason: "NO_MATCHED_ADD_FILL" | "NO_FIFO_REALIZATION_EVIDENCE" | "FEE_EVIDENCE_INCOMPLETE" | null;
  entryNotionalKrw: number | null;
  entryFeeKrw: number | null;
  realizedQuantity: number | null;
  remainingQuantity: number | null;
  realizedGrossPnlBeforeFeesKrw: number | null;
  allocatedEntryFeeKrw: number | null;
  allocatedExitFeeKrw: number | null;
  realizedFeeImpactKrw: number | null;
  realizedNetPnlKrw: number | null;
  realizationSliceIds: readonly string[];
};

export type AddDecisionExposure = {
  id: string;
  generatedAt: string;
  baselineGeneratedAt: string | null;
  pairingStatus: AddDecisionPairingStatus;
  originalEvidence: {
    action: "ADD";
    regime: StrategyMarketRegime;
    atrShock: boolean;
    trendAlignmentScore: number;
    weakeningStage: StrategyWeakeningStage;
  };
  baseline: {
    action: PositionGuardBacktestFrameResult["decision"]["action"] | null;
    executed: boolean | null;
    fillId: string | null;
  };
  baselineEpisode: {
    episodeId: string;
    status: PositionEpisode["status"];
    outcome: AddEpisodeOutcome;
    netRealizedPnlKrw: number | null;
  } | null;
  postDecisionExcursion: {
    status: "UNKNOWN";
    reason: "SEE_POST_DECISION_EXCURSION_ANALYSIS";
  };
  costAndFeeImpact: AddCostAndFeeImpact;
};

export type AddDecisionDiagnosticsWarning = {
  code:
    | "CAUSAL_INFERENCE_NOT_SUPPORTED"
    | "POST_DECISION_EXCURSION_NOT_IMPLEMENTED"
    | "COST_FEE_ATTRIBUTION_NOT_IMPLEMENTED"
    | "COST_FEE_ATTRIBUTION_INCOMPLETE"
    | "BASELINE_PATH_DECISION_DIVERGED"
    | "BASELINE_ADD_NOT_EXECUTED"
    | "BASELINE_EXECUTED_ADD_FILL_MISSING"
    | "BASELINE_ADD_EPISODE_MISSING"
    | "COMPLETED_EPISODE_NET_PNL_UNKNOWN";
  severity: "WARNING";
  evidenceIds: readonly string[];
  message: string;
};

export type AddDecisionDiagnosticsResult = {
  evidenceKind: "SIMULATED_COUNTERFACTUAL";
  analysisKind: "ADD_DECISION_EXPOSURE";
  causalClaim: false;
  asset: SupportedAsset;
  market: SupportedMarket;
  exposures: readonly AddDecisionExposure[];
  aggregate: {
    unit: "DISTINCT_COMPLETED_POSITION_EPISODE";
    exposureCount: number;
    pairingCounts: Record<AddDecisionPairingStatus, number>;
    distinctCompletedEpisodeCount: number;
    completedEpisodeOutcomes: {
      wins: number;
      losses: number;
      breakeven: number;
      unknown: number;
    };
  };
  warnings: readonly AddDecisionDiagnosticsWarning[];
};

const PERFORMANCE_KRW_TOLERANCE = 0.000001;

const UNKNOWN_EXCURSION = {
  status: "UNKNOWN" as const,
  reason: "SEE_POST_DECISION_EXCURSION_ANALYSIS" as const,
};

const UNKNOWN_COST = {
  status: "UNKNOWN" as const,
  completeness: "NOT_AVAILABLE" as const,
  reason: "NO_MATCHED_ADD_FILL" as const,
  entryNotionalKrw: null,
  entryFeeKrw: null,
  realizedQuantity: null,
  remainingQuantity: null,
  realizedGrossPnlBeforeFeesKrw: null,
  allocatedEntryFeeKrw: null,
  allocatedExitFeeKrw: null,
  realizedFeeImpactKrw: null,
  realizedNetPnlKrw: null,
  realizationSliceIds: [] as readonly string[],
};

export function analyzeAddDecisionExposures(
  input: AddDecisionDiagnosticsInput,
): AddDecisionDiagnosticsResult {
  validateInput(input);
  const baselineFrames = mapFramesByEpoch(input.baseline.frames, "BASELINE frame");
  const noAddSourceFrames = mapFramesByEpoch(input.noAdd.sourceFrames, "NO_ADD source frame");
  const baselineFills = mapBaselineFillsByEpoch(input.baseline.fills, input.market);
  const matchedBaselineAddFills = mapMatchedExecutedAddFills(
    input.noAdd.frames,
    baselineFrames,
    baselineFills,
    input.market,
  );
  const baselineFillById = new Map(input.baseline.fills.map((fill) => [fill.id, fill]));
  const episodeLifecycles = mapEpisodeLifecycles(
    input.baseline.matchResult.episodes,
    input.market,
    baselineFillById,
  );
  const slicesByEntryFillId = mapRealizationSlicesByEntryFillId(
    input.baseline.matchResult.realizationSlices,
    input.market,
    episodeLifecycles,
    baselineFillById,
  );
  const warnings: AddDecisionDiagnosticsWarning[] = [
    warning(
      "CAUSAL_INFERENCE_NOT_SUPPORTED",
      [],
      "ADD exposure diagnostics are descriptive counterfactual attribution and do not establish that ADD caused an outcome.",
    ),
  ];

  const exposures = input.noAdd.frames
    .filter((frame) => frame.researchSuppression?.originalAction === "ADD")
    .map((noAddFrame, index) => {
      const epoch = epochKey(noAddFrame.generatedAt, `NO_ADD frame ${index} generatedAt`);
      const sourceFrame = noAddSourceFrames.get(epoch);
      if (!sourceFrame) {
        throw new Error(`NO_ADD source frame is missing for suppressed ADD at ${noAddFrame.generatedAt}.`);
      }
      if (sourceFrame.analysis.regime !== noAddFrame.regime) {
        throw new Error(`NO_ADD source regime does not match suppressed frame at ${noAddFrame.generatedAt}.`);
      }
      validateOriginalEvidence(sourceFrame, noAddFrame.generatedAt);

      const baselineFrame = baselineFrames.get(epoch) ?? null;
      const pairingStatus = classifyPairing(baselineFrame);
      let fill: PerformanceTradeFill | null = null;
      let episode: PositionEpisode | null = null;

      if (pairingStatus === "EXECUTED_VS_SUPPRESSED" && baselineFrame) {
        fill = matchedBaselineAddFills.get(epoch) ?? null;
        if (!fill) {
          warnings.push(warning(
            "BASELINE_EXECUTED_ADD_FILL_MISSING",
            [baselineFrame.generatedAt],
            `Executed BASELINE ADD at ${baselineFrame.generatedAt} has no matching ADD fill evidence.`,
          ));
        } else {
          episode = episodeLifecycles.byEntryFillId.get(fill.id) ?? null;
          if (!episode) {
            warnings.push(warning(
              "BASELINE_ADD_EPISODE_MISSING",
              [fill.id],
              `BASELINE ADD fill ${fill.id} is not linked to a position episode.`,
            ));
          }
        }
      } else if (pairingStatus === "BASELINE_NOT_EXECUTED") {
        warnings.push(warning(
          "BASELINE_ADD_NOT_EXECUTED",
          [noAddFrame.generatedAt],
          `BASELINE selected ADD at ${baselineFrame?.generatedAt ?? noAddFrame.generatedAt} but did not execute it.`,
        ));
      } else {
        warnings.push(warning(
          "BASELINE_PATH_DECISION_DIVERGED",
          [noAddFrame.generatedAt],
          `BASELINE did not select ADD at the suppressed NO_ADD decision instant ${noAddFrame.generatedAt}.`,
        ));
      }

      return {
        id: `add-exposure:${input.asset}:${noAddFrame.generatedAt}:${index}`,
        generatedAt: noAddFrame.generatedAt,
        baselineGeneratedAt: baselineFrame?.generatedAt ?? null,
        pairingStatus,
        originalEvidence: {
          action: "ADD",
          regime: sourceFrame.analysis.regime,
          atrShock: sourceFrame.analysis.atrShock,
          trendAlignmentScore: sourceFrame.analysis.trendAlignmentScore,
          weakeningStage: sourceFrame.analysis.weakeningStage,
        },
        baseline: {
          action: baselineFrame?.decision.action ?? null,
          executed: baselineFrame?.executed ?? null,
          fillId: fill?.id ?? null,
        },
        baselineEpisode: episode ? {
          episodeId: episode.id,
          status: episode.status,
          outcome: episodeOutcome(episode, input.breakevenToleranceKrw),
          netRealizedPnlKrw: episode.netRealizedPnlKrw,
        } : null,
        postDecisionExcursion: UNKNOWN_EXCURSION,
        costAndFeeImpact: fill
          ? calculateCostAndFeeImpact(fill, slicesByEntryFillId.get(fill.id) ?? [])
          : UNKNOWN_COST,
      } satisfies AddDecisionExposure;
    });

  const completedEpisodes = distinctCompletedEpisodes(exposures, input.baseline.matchResult.episodes);
  for (const exposure of exposures) {
    if (exposure.costAndFeeImpact.status !== "UNKNOWN" || exposure.baseline.fillId === null) continue;
    warnings.push(warning(
      "COST_FEE_ATTRIBUTION_INCOMPLETE",
      [exposure.baseline.fillId],
      exposure.costAndFeeImpact.reason === "FEE_EVIDENCE_INCOMPLETE"
        ? `ADD fill ${exposure.baseline.fillId} has incomplete fee evidence; net FIFO contribution remains UNKNOWN.`
        : `ADD fill ${exposure.baseline.fillId} has no FIFO realization evidence; realized contribution remains UNKNOWN.`,
    ));
  }
  for (const episode of completedEpisodes) {
    if (episode.netRealizedPnlKrw === null) {
      warnings.push(warning(
        "COMPLETED_EPISODE_NET_PNL_UNKNOWN",
        [episode.id],
        `Completed episode ${episode.id} has unknown net realized PnL and is counted as an unknown outcome.`,
      ));
    }
  }

  return {
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    analysisKind: "ADD_DECISION_EXPOSURE",
    causalClaim: false,
    asset: input.asset,
    market: input.market,
    exposures,
    aggregate: {
      unit: "DISTINCT_COMPLETED_POSITION_EPISODE",
      exposureCount: exposures.length,
      pairingCounts: {
        EXECUTED_VS_SUPPRESSED: exposures.filter((item) => item.pairingStatus === "EXECUTED_VS_SUPPRESSED").length,
        BASELINE_NOT_EXECUTED: exposures.filter((item) => item.pairingStatus === "BASELINE_NOT_EXECUTED").length,
        PATH_DECISION_DIVERGED: exposures.filter((item) => item.pairingStatus === "PATH_DECISION_DIVERGED").length,
      },
      distinctCompletedEpisodeCount: completedEpisodes.length,
      completedEpisodeOutcomes: {
        wins: completedEpisodes.filter((item) => episodeOutcome(item, input.breakevenToleranceKrw) === "WIN").length,
        losses: completedEpisodes.filter((item) => episodeOutcome(item, input.breakevenToleranceKrw) === "LOSS").length,
        breakeven: completedEpisodes.filter((item) => episodeOutcome(item, input.breakevenToleranceKrw) === "BREAKEVEN").length,
        unknown: completedEpisodes.filter((item) => episodeOutcome(item, input.breakevenToleranceKrw) === "UNKNOWN").length,
      },
    },
    warnings,
  };
}

function validateInput(input: AddDecisionDiagnosticsInput): void {
  if (getMarketForAsset(input.asset) !== input.market) {
    throw new Error(`ADD diagnostics market ${input.market} does not match asset ${input.asset}.`);
  }
  if (input.baseline.scenario !== "BASELINE" || input.noAdd.scenario !== "NO_ADD") {
    throw new Error("ADD diagnostics require BASELINE and NO_ADD paths in their named inputs.");
  }
  if (!Number.isFinite(input.breakevenToleranceKrw) || input.breakevenToleranceKrw < 0) {
    throw new Error("breakevenToleranceKrw must be a finite non-negative number.");
  }
  mapFramesByEpoch(input.noAdd.frames, "NO_ADD frame");
}

function mapFramesByEpoch<T extends { generatedAt: string }>(
  frames: readonly T[],
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  frames.forEach((frame, index) => {
    const key = epochKey(frame.generatedAt, `${label} ${index} generatedAt`);
    if (result.has(key)) throw new Error(`${label} timestamps must be unique by exact instant.`);
    result.set(key, frame);
  });
  return result;
}

function mapBaselineFillsByEpoch(
  fills: readonly PerformanceTradeFill[],
  market: SupportedMarket,
): Map<string, PerformanceTradeFill[]> {
  const result = new Map<string, PerformanceTradeFill[]>();
  const fillIds = new Set<string>();
  for (const fill of fills) {
    if (fillIds.has(fill.id)) throw new Error(`Duplicate BASELINE fill id ${fill.id}.`);
    fillIds.add(fill.id);
    if (fill.market !== market) throw new Error(`Fill ${fill.id} market does not match ADD diagnostics market.`);
    if (!Number.isFinite(fill.priceKrw) || fill.priceKrw <= 0) throw new Error(`Fill ${fill.id} priceKrw must be finite and positive.`);
    if (!Number.isFinite(fill.volume) || fill.volume <= 0) throw new Error(`Fill ${fill.id} volume must be finite and positive.`);
    const key = epochKey(fill.filledAt, `Fill ${fill.id} filledAt`);
    const epochFills = result.get(key) ?? [];
    epochFills.push(fill);
    result.set(key, epochFills);
  }
  return result;
}

function matchExecutedAddFill(
  frame: PositionGuardBacktestFrameResult,
  candidates: readonly PerformanceTradeFill[],
  market: SupportedMarket,
): PerformanceTradeFill | null {
  const trade = frame.trade;
  if (!trade || trade.action !== "ADD" || trade.side !== "bid") {
    throw new Error(`Executed BASELINE ADD frame at ${frame.generatedAt} requires a bid ADD trade.`);
  }
  if (!Number.isFinite(trade.price) || trade.price <= 0) {
    throw new Error(`Executed BASELINE ADD trade price must be finite and positive at ${frame.generatedAt}.`);
  }
  if (!Number.isFinite(trade.quantity) || trade.quantity <= PERFORMANCE_QUANTITY_TOLERANCE) {
    throw new Error(`Executed BASELINE ADD trade quantity must exceed the lifecycle tolerance at ${frame.generatedAt}.`);
  }
  if (candidates.length === 0) return null;

  const matches = candidates.filter((fill) =>
    fill.market === market
    && fill.decisionAction === "ADD"
    && fill.side === "bid"
    && fill.priceKrw === trade.price
    && Math.abs(fill.volume - trade.quantity) <= PERFORMANCE_QUANTITY_TOLERANCE);
  if (matches.length !== 1) {
    throw new Error(
      `Same-epoch fill evidence does not match executed BASELINE ADD trade at ${frame.generatedAt}.`,
    );
  }
  return matches[0]!;
}

function mapMatchedExecutedAddFills(
  noAddFrames: readonly PositionGuardBacktestFrameResult[],
  baselineFrames: ReadonlyMap<string, PositionGuardBacktestFrameResult>,
  baselineFills: ReadonlyMap<string, readonly PerformanceTradeFill[]>,
  market: SupportedMarket,
): Map<string, PerformanceTradeFill | null> {
  const result = new Map<string, PerformanceTradeFill | null>();
  for (const noAddFrame of noAddFrames) {
    if (noAddFrame.researchSuppression?.originalAction !== "ADD") continue;
    const epoch = epochKey(noAddFrame.generatedAt, "Suppressed NO_ADD generatedAt");
    const baselineFrame = baselineFrames.get(epoch) ?? null;
    if (classifyPairing(baselineFrame) !== "EXECUTED_VS_SUPPRESSED" || !baselineFrame) continue;
    result.set(epoch, matchExecutedAddFill(
      baselineFrame,
      baselineFills.get(epoch) ?? [],
      market,
    ));
  }
  return result;
}

type EpisodeLifecycleIndex = {
  byId: ReadonlyMap<string, PositionEpisode>;
  byEntryFillId: ReadonlyMap<string, PositionEpisode>;
};

function mapEpisodeLifecycles(
  episodes: readonly PositionEpisode[],
  market: SupportedMarket,
  fillById: ReadonlyMap<string, PerformanceTradeFill>,
): EpisodeLifecycleIndex {
  const byId = new Map<string, PositionEpisode>();
  const byEntryFillId = new Map<string, PositionEpisode>();
  const episodeIds = new Set<string>();
  for (const episode of episodes) {
    if (episodeIds.has(episode.id)) throw new Error(`Duplicate episode id ${episode.id}.`);
    episodeIds.add(episode.id);
    if (episode.market !== market) {
      throw new Error(`Episode ${episode.id} market does not match ${market}.`);
    }
    if (episode.entryFillIds.length === 0) {
      throw new Error(`Episode ${episode.id} requires at least one BASELINE entry fill.`);
    }
    for (const fillId of episode.entryFillIds) {
      const fill = fillById.get(fillId);
      if (!fill) {
        throw new Error(`Episode ${episode.id} entry fill ${fillId} does not exist in BASELINE fills.`);
      }
      if (fill.market !== market || fill.side !== "bid") {
        throw new Error(`Episode ${episode.id} entry fill ${fillId} must reference a BASELINE bid fill.`);
      }
      if (byEntryFillId.has(fillId)) throw new Error(`Entry fill ${fillId} belongs to multiple position episodes.`);
      byEntryFillId.set(fillId, episode);
    }
    for (const fillId of episode.exitFillIds) {
      const fill = fillById.get(fillId);
      if (!fill) {
        throw new Error(`Episode ${episode.id} exit fill ${fillId} does not exist in BASELINE fills.`);
      }
      if (fill.market !== market || fill.side !== "ask") {
        throw new Error(`Episode ${episode.id} exit fill ${fillId} must reference a BASELINE ask fill.`);
      }
    }
    byId.set(episode.id, episode);
  }
  return { byId, byEntryFillId };
}

function mapRealizationSlicesByEntryFillId(
  slices: readonly FifoRealizationSlice[],
  market: SupportedMarket,
  episodeLifecycles: EpisodeLifecycleIndex,
  fillById: ReadonlyMap<string, PerformanceTradeFill>,
): Map<string, FifoRealizationSlice[]> {
  const result = new Map<string, FifoRealizationSlice[]>();
  const sliceIds = new Set<string>();
  const selectedSliceIdsByEpisode = new Map<string, string[]>();
  const allocatedBuyFeesByEntryFillId = new Map<string, number>();
  for (const slice of slices) {
    if (sliceIds.has(slice.id)) throw new Error(`Duplicate realization slice id ${slice.id}.`);
    sliceIds.add(slice.id);
    if (slice.market !== market) throw new Error(`Realization slice ${slice.id} market does not match ${market}.`);
    if (!Number.isFinite(slice.quantity) || slice.quantity <= PERFORMANCE_QUANTITY_TOLERANCE) {
      throw new Error(`Realization slice ${slice.id} quantity must exceed the lifecycle tolerance.`);
    }
    validateNullableFinite(slice.grossPnlBeforeFeesKrw, `Realization slice ${slice.id} gross PnL`);
    validateNullableFee(slice.allocatedBuyFeeKrw, `Realization slice ${slice.id} allocated buy fee`);
    validateNullableFee(slice.allocatedSellFeeKrw, `Realization slice ${slice.id} allocated sell fee`);
    validateNullableFinite(slice.netRealizedPnlKrw, `Realization slice ${slice.id} net PnL`);
    if (slice.source !== "SELECTED_STREAM") continue;
    const entryFillId = slice.entry.fillId;
    if (entryFillId === null) throw new Error(`Selected realization slice ${slice.id} requires an entry fill.`);
    const entryFill = fillById.get(entryFillId);
    if (!entryFill || entryFill.side !== "bid") {
      throw new Error(`Selected realization slice ${slice.id} entry evidence does not match referenced bid fill.`);
    }
    if (!evidenceMatchesFill(slice.entry, entryFill)) {
      throw new Error(`Selected realization slice ${slice.id} entry evidence does not match referenced bid fill.`);
    }
    const episode = episodeLifecycles.byEntryFillId.get(entryFillId);
    if (!episode || slice.episodeId !== episode.id) {
      throw new Error(`Realization slice ${slice.id} has a corrupt ADD entry episode relationship.`);
    }
    if (!episode.realizationSliceIds.includes(slice.id)) {
      throw new Error(`Realization slice ${slice.id} is missing from episode ${episode.id}.`);
    }
    const exitFillId = slice.exit.fillId;
    const exitFill = exitFillId === null ? undefined : fillById.get(exitFillId);
    if (!exitFill || exitFill.side !== "ask") {
      throw new Error(`Selected realization slice ${slice.id} exit evidence does not match referenced ask fill.`);
    }
    if (!episode.exitFillIds.includes(exitFill.id)) {
      throw new Error(`Selected realization slice ${slice.id} has a cross-episode exit fill.`);
    }
    if (!evidenceMatchesFill(slice.exit, exitFill)) {
      throw new Error(`Selected realization slice ${slice.id} exit evidence does not match referenced ask fill.`);
    }
    validateKnownNetPnl(slice);
    if (slice.allocatedBuyFeeKrw !== null) {
      allocatedBuyFeesByEntryFillId.set(
        entryFill.id,
        (allocatedBuyFeesByEntryFillId.get(entryFill.id) ?? 0) + slice.allocatedBuyFeeKrw,
      );
    }
    const episodeSliceIds = selectedSliceIdsByEpisode.get(episode.id) ?? [];
    episodeSliceIds.push(slice.id);
    selectedSliceIdsByEpisode.set(episode.id, episodeSliceIds);
    const entrySlices = result.get(entryFillId) ?? [];
    entrySlices.push(slice);
    result.set(entryFillId, entrySlices);
  }
  for (const episode of episodeLifecycles.byId.values()) {
    if (!sameStringSet(episode.realizationSliceIds, selectedSliceIdsByEpisode.get(episode.id) ?? [])) {
      throw new Error(`Episode ${episode.id} has corrupt bidirectional lifecycle slice links.`);
    }
  }
  for (const [entryFillId, allocatedBuyFeeKrw] of allocatedBuyFeesByEntryFillId) {
    const entryFill = fillById.get(entryFillId)!;
    if (entryFill.feeKrw !== null && allocatedBuyFeeKrw - entryFill.feeKrw > PERFORMANCE_KRW_TOLERANCE) {
      throw new Error(`Selected realization slices for entry fill ${entryFillId} allocated buy fees exceed known total fee.`);
    }
  }
  return result;
}

function evidenceMatchesFill(
  evidence: FifoRealizationSlice["entry"] | FifoRealizationSlice["exit"],
  fill: PerformanceTradeFill,
): boolean {
  return evidence.fillId === fill.id
    && evidence.orderId === fill.orderId
    && evidence.strategyDecisionId === fill.strategyDecisionId
    && evidence.decisionAction === fill.decisionAction
    && evidence.occurredAt !== null
    && parsePerformanceTimestamp(evidence.occurredAt) !== null
    && comparePerformanceTimestamps(evidence.occurredAt, fill.filledAt) === 0
    && evidence.priceKrw === fill.priceKrw;
}

function validateKnownNetPnl(slice: FifoRealizationSlice): void {
  if (
    slice.grossPnlBeforeFeesKrw === null
    || slice.allocatedBuyFeeKrw === null
    || slice.allocatedSellFeeKrw === null
    || slice.netRealizedPnlKrw === null
  ) return;
  const expectedNetPnlKrw = slice.grossPnlBeforeFeesKrw - slice.allocatedBuyFeeKrw - slice.allocatedSellFeeKrw;
  if (Math.abs(slice.netRealizedPnlKrw - expectedNetPnlKrw) > PERFORMANCE_KRW_TOLERANCE) {
    throw new Error(`Realization slice ${slice.id} net PnL contradicts gross and allocated fees.`);
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return left.length === leftSet.size
    && right.length === rightSet.size
    && leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}

function calculateCostAndFeeImpact(
  fill: PerformanceTradeFill,
  slices: readonly FifoRealizationSlice[],
): AddCostAndFeeImpact {
  if (slices.length === 0) {
    return {
      ...UNKNOWN_COST,
      reason: "NO_FIFO_REALIZATION_EVIDENCE",
      entryNotionalKrw: fill.priceKrw * fill.volume,
      entryFeeKrw: fill.feeKrw,
      realizedQuantity: 0,
      remainingQuantity: fill.volume,
    };
  }

  const realizedQuantity = sum(slices.map((slice) => slice.quantity));
  if (realizedQuantity - fill.volume > PERFORMANCE_QUANTITY_TOLERANCE) {
    throw new Error(`ADD fill ${fill.id} realization quantity exceeds its entry volume.`);
  }
  const gross = sumKnown(slices.map((slice) => slice.grossPnlBeforeFeesKrw));
  const allocatedEntryFee = sumKnown(slices.map((slice) => slice.allocatedBuyFeeKrw));
  const allocatedExitFee = sumKnown(slices.map((slice) => slice.allocatedSellFeeKrw));
  const net = sumKnown(slices.map((slice) => slice.netRealizedPnlKrw));
  const feeComplete = fill.feeKrw !== null && allocatedEntryFee !== null && allocatedExitFee !== null && net !== null;

  return {
    status: feeComplete ? "AVAILABLE" : "UNKNOWN",
    completeness: feeComplete ? "COMPLETE" : "FEE_EVIDENCE_INCOMPLETE",
    reason: feeComplete ? null : "FEE_EVIDENCE_INCOMPLETE",
    entryNotionalKrw: fill.priceKrw * fill.volume,
    entryFeeKrw: fill.feeKrw,
    realizedQuantity: normalizeQuantity(realizedQuantity),
    remainingQuantity: normalizeQuantity(fill.volume - realizedQuantity),
    realizedGrossPnlBeforeFeesKrw: gross,
    allocatedEntryFeeKrw: allocatedEntryFee,
    allocatedExitFeeKrw: allocatedExitFee,
    realizedFeeImpactKrw:
      allocatedEntryFee === null || allocatedExitFee === null
        ? null
        : allocatedEntryFee + allocatedExitFee,
    realizedNetPnlKrw: net,
    realizationSliceIds: slices.map((slice) => slice.id),
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumKnown(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null)
    ? null
    : sum(values as readonly number[]);
}

function normalizeQuantity(value: number): number {
  return Math.abs(value) <= PERFORMANCE_QUANTITY_TOLERANCE ? 0 : Number(value.toFixed(12));
}

function validateNullableFinite(value: number | null, label: string): void {
  if (value !== null && !Number.isFinite(value)) throw new Error(`${label} must be finite when known.`);
}

function validateNullableFee(value: number | null, label: string): void {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} must be finite and non-negative when known.`);
  }
}

function classifyPairing(
  baselineFrame: PositionGuardBacktestFrameResult | null,
): AddDecisionPairingStatus {
  if (!baselineFrame || baselineFrame.decision.action !== "ADD") return "PATH_DECISION_DIVERGED";
  return baselineFrame.executed && baselineFrame.trade?.action === "ADD"
    ? "EXECUTED_VS_SUPPRESSED"
    : "BASELINE_NOT_EXECUTED";
}

function validateOriginalEvidence(frame: PositionGuardBacktestFrame, generatedAt: string): void {
  if (!Number.isFinite(frame.analysis.trendAlignmentScore)) {
    throw new Error(`Suppressed ADD trendAlignmentScore must be finite at ${generatedAt}.`);
  }
  if (typeof frame.analysis.atrShock !== "boolean") {
    throw new Error(`Suppressed ADD atrShock must be boolean at ${generatedAt}.`);
  }
}

function distinctCompletedEpisodes(
  exposures: readonly AddDecisionExposure[],
  episodes: readonly PositionEpisode[],
): PositionEpisode[] {
  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
  const ids = new Set(exposures
    .map((exposure) => exposure.baselineEpisode?.episodeId ?? null)
    .filter((id): id is string => id !== null));
  return [...ids]
    .map((id) => episodeById.get(id))
    .filter((episode): episode is PositionEpisode => episode?.status === "COMPLETED");
}

function episodeOutcome(episode: PositionEpisode, toleranceKrw: number): AddEpisodeOutcome {
  if (episode.status !== "COMPLETED" || episode.netRealizedPnlKrw === null) return "UNKNOWN";
  if (!Number.isFinite(episode.netRealizedPnlKrw)) {
    throw new Error(`Episode ${episode.id} netRealizedPnlKrw must be finite when known.`);
  }
  if (episode.netRealizedPnlKrw > toleranceKrw) return "WIN";
  if (episode.netRealizedPnlKrw < -toleranceKrw) return "LOSS";
  return "BREAKEVEN";
}

function epochKey(value: string, label: string): string {
  if (parsePerformanceTimestamp(value) === null) {
    throw new Error(`${label} must have an explicit timezone.`);
  }
  return performanceTimestampEpochNanoseconds(value).toString();
}

function warning(
  code: AddDecisionDiagnosticsWarning["code"],
  evidenceIds: readonly string[],
  message: string,
): AddDecisionDiagnosticsWarning {
  return { code, severity: "WARNING", evidenceIds, message };
}
