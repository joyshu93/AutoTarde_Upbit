import type {
  PerformanceFillSide,
  PerformanceMarket,
  PerformanceOpeningPosition,
} from "./performance-calculator.js";
import {
  comparePerformanceTimestamps,
  parsePerformanceTimestamp,
  performanceTimestampDifferenceMs,
  performanceTimestampEpochNanoseconds,
} from "./performance-timestamp.js";

export type PerformanceDecisionAction = "ENTER" | "ADD" | "REDUCE" | "EXIT";
export type PerformanceLotSource = "OPENING" | "SELECTED_STREAM";

export type PerformanceTradeFill = {
  id: string;
  orderId: string;
  strategyDecisionId: string | null;
  decisionAction: PerformanceDecisionAction | null;
  market: PerformanceMarket;
  side: PerformanceFillSide;
  priceKrw: number;
  volume: number;
  feeKrw: number | null;
  filledAt: string;
};

export type PerformanceTradeEvidence = {
  fillId: string | null;
  orderId: string | null;
  strategyDecisionId: string | null;
  decisionAction: PerformanceDecisionAction | null;
  occurredAt: string | null;
  priceKrw: number | null;
};

export type FifoRealizationSlice = {
  id: string;
  market: PerformanceMarket;
  source: PerformanceLotSource;
  episodeId: string | null;
  entry: PerformanceTradeEvidence;
  exit: PerformanceTradeEvidence;
  quantity: number;
  grossPnlBeforeFeesKrw: number | null;
  allocatedBuyFeeKrw: number | null;
  allocatedSellFeeKrw: number | null;
  netRealizedPnlKrw: number | null;
  holdingDurationMs: number | null;
};

export type PositionEpisode = {
  id: string;
  market: PerformanceMarket;
  status: "OPEN" | "COMPLETED";
  openedAt: string;
  closedAt: string | null;
  entryFillIds: readonly string[];
  exitFillIds: readonly string[];
  realizationSliceIds: readonly string[];
  remainingQuantity: number;
  grossRealizedPnlKrw: number | null;
  realizedFeeImpactKrw: number | null;
  netRealizedPnlKrw: number | null;
  holdingDurationMs: number | null;
};

export type UnmatchedPerformanceSell = {
  market: PerformanceMarket;
  fillId: string;
  quantity: number;
};

export type PerformanceAttributionFailure = {
  code: "UNMATCHED_SELL";
  market: PerformanceMarket;
  causingFillId: string;
  unmatchedQuantity: number;
  ignoredLaterFillIds: readonly string[];
};

export type PerformanceTradeMatchInput = {
  fills: readonly PerformanceTradeFill[];
  openingPositions?: readonly PerformanceOpeningPosition[];
};

export type PerformanceTradeMatchResult = {
  realizationSlices: readonly FifoRealizationSlice[];
  episodes: readonly PositionEpisode[];
  unmatchedSells: readonly UnmatchedPerformanceSell[];
  attributionFailures: readonly PerformanceAttributionFailure[];
};

type InventoryLot = {
  source: PerformanceLotSource;
  episodeId: string | null;
  entry: PerformanceTradeEvidence;
  quantity: number;
  priceKrw: number | null;
  buyFeePerUnitKrw: number | null;
};

type MutableEpisode = {
  id: string;
  market: PerformanceMarket;
  openedAt: string;
  entryFillIds: string[];
  exitFillIds: string[];
  realizationSliceIds: string[];
  remainingQuantity: number;
  grossRealizedPnlKrw: number | null;
  realizedFeeImpactKrw: number | null;
  netRealizedPnlKrw: number | null;
};

type MarketState = {
  lots: InventoryLot[];
  currentEpisode: MutableEpisode | null;
  attributionFailure: MutableAttributionFailure | null;
};

type MutableAttributionFailure = Omit<
  PerformanceAttributionFailure,
  "ignoredLaterFillIds"
> & {
  ignoredLaterFillIds: string[];
};

export const PERFORMANCE_QUANTITY_TOLERANCE = 1e-12;

export function matchPerformanceTrades(
  input: PerformanceTradeMatchInput,
): PerformanceTradeMatchResult {
  const openingPositions = input.openingPositions ?? [];
  validateInput(input.fills, openingPositions);
  rejectAmbiguousInstants(input.fills);

  const states = new Map<PerformanceMarket, MarketState>();
  const slices: FifoRealizationSlice[] = [];
  const completedEpisodes: PositionEpisode[] = [];
  const unmatchedSells: UnmatchedPerformanceSell[] = [];

  for (const position of openingPositions) {
    const state = getState(states, position.market);
    state.lots.push({
      source: "OPENING",
      episodeId: null,
      entry: openingEvidence(position.averagePriceKrw),
      quantity: position.quantity,
      priceKrw: position.averagePriceKrw,
      buyFeePerUnitKrw: null,
    });
  }

  const orderedFills = [...input.fills].sort(compareFills);
  for (const fill of orderedFills) {
    const state = getState(states, fill.market);
    if (state.attributionFailure) {
      state.attributionFailure.ignoredLaterFillIds.push(fill.id);
      continue;
    }
    if (fill.side === "bid") {
      addSelectedLot(state, fill);
      continue;
    }

    consumeSell(state, fill, slices, completedEpisodes, unmatchedSells);
  }

  const openEpisodes = [...states.values()]
    .map((state) => state.currentEpisode)
    .filter((episode): episode is MutableEpisode => episode !== null)
    .map((episode) => finishEpisode(episode, null));

  return {
    realizationSlices: slices,
    episodes: [...completedEpisodes, ...openEpisodes].sort(compareEpisodes),
    unmatchedSells,
    attributionFailures: [...states.values()]
      .map((state) => state.attributionFailure)
      .filter((failure): failure is MutableAttributionFailure => failure !== null),
  };
}

function addSelectedLot(state: MarketState, fill: PerformanceTradeFill): void {
  let episode = state.currentEpisode;
  if (!episode) {
    episode = {
      id: `${fill.market}:${fill.id}`,
      market: fill.market,
      openedAt: fill.filledAt,
      entryFillIds: [],
      exitFillIds: [],
      realizationSliceIds: [],
      remainingQuantity: 0,
      grossRealizedPnlKrw: 0,
      realizedFeeImpactKrw: 0,
      netRealizedPnlKrw: 0,
    };
    state.currentEpisode = episode;
  }
  episode.entryFillIds.push(fill.id);
  episode.remainingQuantity = normalizeQuantity(episode.remainingQuantity + fill.volume);
  state.lots.push({
    source: "SELECTED_STREAM",
    episodeId: episode.id,
    entry: fillEvidence(fill),
    quantity: fill.volume,
    priceKrw: fill.priceKrw,
    buyFeePerUnitKrw: fill.feeKrw === null ? null : fill.feeKrw / fill.volume,
  });
}

function consumeSell(
  state: MarketState,
  fill: PerformanceTradeFill,
  slices: FifoRealizationSlice[],
  completedEpisodes: PositionEpisode[],
  unmatchedSells: UnmatchedPerformanceSell[],
): void {
  let remaining = fill.volume;
  let sliceIndex = 0;
  const touchedEpisodes = new Set<string>();

  while (remaining > PERFORMANCE_QUANTITY_TOLERANCE && state.lots.length > 0) {
    const lot = state.lots[0];
    if (!lot) {
      break;
    }
    const consumed = Math.min(remaining, lot.quantity);
    const allocatedBuyFeeKrw =
      lot.buyFeePerUnitKrw === null ? null : lot.buyFeePerUnitKrw * consumed;
    const allocatedSellFeeKrw =
      fill.feeKrw === null ? null : fill.feeKrw * (consumed / fill.volume);
    const grossPnlBeforeFeesKrw =
      lot.priceKrw === null ? null : (fill.priceKrw - lot.priceKrw) * consumed;
    const netRealizedPnlKrw =
      grossPnlBeforeFeesKrw === null ||
      allocatedBuyFeeKrw === null ||
      allocatedSellFeeKrw === null
        ? null
        : grossPnlBeforeFeesKrw - allocatedBuyFeeKrw - allocatedSellFeeKrw;
    const slice: FifoRealizationSlice = {
      id: `${fill.id}:${lot.entry.fillId ?? "opening"}:${sliceIndex}`,
      market: fill.market,
      source: lot.source,
      episodeId: lot.episodeId,
      entry: lot.entry,
      exit: fillEvidence(fill),
      quantity: consumed,
      grossPnlBeforeFeesKrw,
      allocatedBuyFeeKrw,
      allocatedSellFeeKrw,
      netRealizedPnlKrw,
      holdingDurationMs:
        lot.entry.occurredAt === null
          ? null
          : performanceTimestampDifferenceMs(fill.filledAt, lot.entry.occurredAt),
    };
    slices.push(slice);

    if (lot.source === "SELECTED_STREAM") {
      const episode = state.currentEpisode;
      if (!episode || episode.id !== lot.episodeId) {
        throw new Error(`Selected lot ${lot.entry.fillId ?? "unknown"} has no matching episode.`);
      }
      touchedEpisodes.add(episode.id);
      episode.realizationSliceIds.push(slice.id);
      episode.remainingQuantity = normalizeQuantity(episode.remainingQuantity - consumed);
      episode.grossRealizedPnlKrw = addNullable(
        episode.grossRealizedPnlKrw,
        grossPnlBeforeFeesKrw,
      );
      episode.realizedFeeImpactKrw = addNullable(
        episode.realizedFeeImpactKrw,
        addNullable(allocatedBuyFeeKrw, allocatedSellFeeKrw),
      );
      episode.netRealizedPnlKrw = addNullable(
        episode.netRealizedPnlKrw,
        netRealizedPnlKrw,
      );
    }

    lot.quantity = normalizeQuantity(lot.quantity - consumed);
    remaining = normalizeQuantity(remaining - consumed);
    if (lot.quantity === 0) {
      state.lots.shift();
    }
    sliceIndex += 1;
  }

  const episode = state.currentEpisode;
  if (episode && touchedEpisodes.has(episode.id)) {
    episode.exitFillIds.push(fill.id);
    if (episode.remainingQuantity === 0) {
      completedEpisodes.push(finishEpisode(episode, fill));
      state.currentEpisode = null;
    }
  }

  if (remaining > PERFORMANCE_QUANTITY_TOLERANCE) {
    unmatchedSells.push({ market: fill.market, fillId: fill.id, quantity: remaining });
    state.attributionFailure = {
      code: "UNMATCHED_SELL",
      market: fill.market,
      causingFillId: fill.id,
      unmatchedQuantity: remaining,
      ignoredLaterFillIds: [],
    };
  }
}

function finishEpisode(
  episode: MutableEpisode,
  closingFill: PerformanceTradeFill | null,
): PositionEpisode {
  return {
    id: episode.id,
    market: episode.market,
    status: closingFill === null ? "OPEN" : "COMPLETED",
    openedAt: episode.openedAt,
    closedAt: closingFill?.filledAt ?? null,
    entryFillIds: episode.entryFillIds,
    exitFillIds: episode.exitFillIds,
    realizationSliceIds: episode.realizationSliceIds,
    remainingQuantity: episode.remainingQuantity,
    grossRealizedPnlKrw: episode.grossRealizedPnlKrw,
    realizedFeeImpactKrw: episode.realizedFeeImpactKrw,
    netRealizedPnlKrw: episode.netRealizedPnlKrw,
    holdingDurationMs:
      closingFill === null
        ? null
        : performanceTimestampDifferenceMs(closingFill.filledAt, episode.openedAt),
  };
}

function fillEvidence(fill: PerformanceTradeFill): PerformanceTradeEvidence {
  return {
    fillId: fill.id,
    orderId: fill.orderId,
    strategyDecisionId: fill.strategyDecisionId,
    decisionAction: fill.decisionAction,
    occurredAt: fill.filledAt,
    priceKrw: fill.priceKrw,
  };
}

function openingEvidence(averagePriceKrw: number | null): PerformanceTradeEvidence {
  return {
    fillId: null,
    orderId: null,
    strategyDecisionId: null,
    decisionAction: null,
    occurredAt: null,
    priceKrw: averagePriceKrw,
  };
}

function getState(
  states: Map<PerformanceMarket, MarketState>,
  market: PerformanceMarket,
): MarketState {
  const existing = states.get(market);
  if (existing) {
    return existing;
  }
  const state: MarketState = { lots: [], currentEpisode: null, attributionFailure: null };
  states.set(market, state);
  return state;
}

function compareFills(left: PerformanceTradeFill, right: PerformanceTradeFill): number {
  return comparePerformanceTimestamps(left.filledAt, right.filledAt) || left.id.localeCompare(right.id);
}

function compareEpisodes(left: PositionEpisode, right: PositionEpisode): number {
  return comparePerformanceTimestamps(left.openedAt, right.openedAt) || left.id.localeCompare(right.id);
}

function rejectAmbiguousInstants(fills: readonly PerformanceTradeFill[]): void {
  const sidesByInstant = new Map<string, Set<PerformanceFillSide>>();
  for (const fill of fills) {
    const key = `${fill.market}:${performanceTimestampEpochNanoseconds(fill.filledAt)}`;
    const sides = sidesByInstant.get(key) ?? new Set<PerformanceFillSide>();
    sides.add(fill.side);
    sidesByInstant.set(key, sides);
    if (sides.size > 1) {
      throw new Error(
        `Ambiguous opposite-side fills for ${fill.market} at the same instant ${fill.filledAt}.`,
      );
    }
  }
}

function validateInput(
  fills: readonly PerformanceTradeFill[],
  openingPositions: readonly PerformanceOpeningPosition[],
): void {
  const fillIds = new Set<string>();
  const orderMetadata = new Map<
    string,
    Pick<PerformanceTradeFill, "market" | "side" | "strategyDecisionId" | "decisionAction">
  >();
  const decisionMetadata = new Map<
    string,
    Pick<PerformanceTradeFill, "market" | "decisionAction">
  >();
  for (const fill of fills) {
    if (fill.id.length === 0 || fill.orderId.length === 0) {
      throw new Error("Fill id and orderId must be non-empty.");
    }
    if (fillIds.has(fill.id)) {
      throw new Error(`Duplicate fill id ${fill.id}.`);
    }
    fillIds.add(fill.id);
    assertPositive(fill.priceKrw, `Fill ${fill.id} priceKrw`);
    if (!Number.isFinite(fill.volume) || fill.volume <= PERFORMANCE_QUANTITY_TOLERANCE) {
      throw new Error(
        `Fill ${fill.id} volume must be greater than PERFORMANCE_QUANTITY_TOLERANCE.`,
      );
    }
    if (fill.feeKrw !== null && (!Number.isFinite(fill.feeKrw) || fill.feeKrw < 0)) {
      throw new Error(`Fill ${fill.id} feeKrw must be a finite non-negative number or null.`);
    }
    if (!isExactIsoTimestamp(fill.filledAt)) {
      throw new Error(
        `Fill ${fill.id} filledAt must be an exact ISO-8601 calendar timestamp with an explicit timezone.`,
      );
    }
    if (
      fill.decisionAction !== null &&
      ((fill.side === "bid" && !["ENTER", "ADD"].includes(fill.decisionAction)) ||
        (fill.side === "ask" && !["REDUCE", "EXIT"].includes(fill.decisionAction)))
    ) {
      throw new Error(
        `Fill ${fill.id} side ${fill.side} contradicts decision action ${fill.decisionAction}.`,
      );
    }
    if (fill.decisionAction !== null && fill.strategyDecisionId === null) {
      throw new Error(
        `Fill ${fill.id} has decisionAction ${fill.decisionAction} without strategyDecisionId.`,
      );
    }
    validateOrderMetadata(orderMetadata, fill);
    validateDecisionMetadata(decisionMetadata, fill);
  }
  for (const position of openingPositions) {
    assertPositive(position.quantity, `Opening position ${position.market} quantity`);
    if (position.averagePriceKrw !== null) {
      assertPositive(position.averagePriceKrw, `Opening position ${position.market} averagePriceKrw`);
    }
  }
}

function isExactIsoTimestamp(value: string): boolean {
  return parsePerformanceTimestamp(value) !== null;
}

function validateOrderMetadata(
  metadataByOrder: Map<
    string,
    Pick<PerformanceTradeFill, "market" | "side" | "strategyDecisionId" | "decisionAction">
  >,
  fill: PerformanceTradeFill,
): void {
  const current = {
    market: fill.market,
    side: fill.side,
    strategyDecisionId: fill.strategyDecisionId,
    decisionAction: fill.decisionAction,
  };
  const existing = metadataByOrder.get(fill.orderId);
  if (!existing) {
    metadataByOrder.set(fill.orderId, current);
    return;
  }
  for (const field of ["market", "side", "strategyDecisionId", "decisionAction"] as const) {
    if (existing[field] !== current[field]) {
      throw new Error(`Order ${fill.orderId} has inconsistent ${field} metadata.`);
    }
  }
}

function validateDecisionMetadata(
  metadataByDecision: Map<
    string,
    Pick<PerformanceTradeFill, "market" | "decisionAction">
  >,
  fill: PerformanceTradeFill,
): void {
  if (fill.strategyDecisionId === null) {
    return;
  }
  const current = { market: fill.market, decisionAction: fill.decisionAction };
  const existing = metadataByDecision.get(fill.strategyDecisionId);
  if (!existing) {
    metadataByDecision.set(fill.strategyDecisionId, current);
    return;
  }
  for (const field of ["market", "decisionAction"] as const) {
    if (existing[field] !== current[field]) {
      throw new Error(
        `Strategy decision ${fill.strategyDecisionId} has inconsistent ${field} metadata.`,
      );
    }
  }
}

function addNullable(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left + right;
}

function normalizeQuantity(quantity: number): number {
  return Math.abs(quantity) <= PERFORMANCE_QUANTITY_TOLERANCE ? 0 : quantity;
}

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number.`);
  }
}
