import {
  comparePerformanceTimestamps,
  parsePerformanceTimestamp,
  performanceTimestampEpochNanoseconds,
} from "./performance-timestamp.js";

export type PerformanceMarket = "KRW-BTC" | "KRW-ETH";
export type PerformanceFillSide = "bid" | "ask";

export type PerformanceFill = {
  id: string;
  market: PerformanceMarket;
  side: PerformanceFillSide;
  priceKrw: number;
  volume: number;
  feeKrw: number | null;
  filledAt: string;
};

export type PerformanceOpeningPosition = {
  market: PerformanceMarket;
  quantity: number;
  averagePriceKrw: number | null;
};

export type PerformanceMarkPrice = {
  market: PerformanceMarket;
  priceKrw: number | null;
};

export type PerformanceCalculationInput = {
  fills: readonly PerformanceFill[];
  openingPositions?: readonly PerformanceOpeningPosition[];
  markPrices?: readonly PerformanceMarkPrice[];
};

export type PerformanceWarningCode =
  | "MISSING_FILL_FEE"
  | "UNMATCHED_SELL"
  | "MISSING_OPENING_COST"
  | "MISSING_MARK_PRICE";

export type PerformanceWarning = {
  code: PerformanceWarningCode;
  market: PerformanceMarket;
  message: string;
  fillId?: string;
};

export type MarketPerformanceResult = {
  market: PerformanceMarket;
  realizedPnlKrw: number | null;
  openingInventoryRealizedPnlKrw: number | null;
  selectedStreamRealizedPnlKrw: number | null;
  paidFeesKrw: number | null;
  turnoverKrw: number;
  remainingQuantity: number;
  remainingCostKrw: number | null;
  marketValueKrw: number | null;
  grossUnrealizedPnlKrw: number | null;
  unmatchedSellQuantity: number;
};

export type PerformanceTotals = Omit<
  MarketPerformanceResult,
  "market" | "remainingQuantity" | "unmatchedSellQuantity"
>;

export type PerformanceCalculationResult = {
  markets: readonly MarketPerformanceResult[];
  totals: PerformanceTotals;
  warnings: readonly PerformanceWarning[];
};

type LotSource = "OPENING" | "SELECTED_STREAM";

type Lot = {
  source: LotSource;
  quantity: number;
  costPerUnitKrw: number | null;
};

type MarketState = {
  market: PerformanceMarket;
  lots: Lot[];
  realizedPnlKrw: number | null;
  openingInventoryRealizedPnlKrw: number | null;
  selectedStreamRealizedPnlKrw: number | null;
  paidFeesKrw: number | null;
  turnoverKrw: number;
  unmatchedSellQuantity: number;
};

const MARKET_ORDER: readonly PerformanceMarket[] = ["KRW-BTC", "KRW-ETH"];

// Upbit's supported order quantities are materially larger than this threshold.
// Normalize smaller arithmetic residue to zero at every inventory boundary.
const QUANTITY_TOLERANCE = 1e-12;

export function calculatePerformance(
  input: PerformanceCalculationInput,
): PerformanceCalculationResult {
  const openingPositions = input.openingPositions ?? [];
  const markPrices = input.markPrices ?? [];
  validateInput(input.fills, openingPositions, markPrices);

  const states = new Map<PerformanceMarket, MarketState>();
  const missingFeeWarnings: PerformanceWarning[] = [];
  const unmatchedSellWarnings: PerformanceWarning[] = [];
  const missingOpeningCostWarnings: PerformanceWarning[] = [];
  const missingMarkWarnings: PerformanceWarning[] = [];

  for (const position of openingPositions) {
    const state = getState(states, position.market);
    state.lots.push({
      source: "OPENING",
      quantity: position.quantity,
      costPerUnitKrw: position.averagePriceKrw,
    });
    if (position.averagePriceKrw === null) {
      missingOpeningCostWarnings.push({
        code: "MISSING_OPENING_COST",
        market: position.market,
        message: `Opening cost is unavailable for ${position.market}.`,
      });
    }
  }

  const orderedFills = [...input.fills].sort((left, right) =>
    comparePerformanceTimestamps(left.filledAt, right.filledAt) || left.id.localeCompare(right.id),
  );
  for (const fill of orderedFills) {
    const state = getState(states, fill.market);
    const notionalKrw = fill.priceKrw * fill.volume;
    state.turnoverKrw += notionalKrw;
    if (fill.feeKrw === null) {
      state.paidFeesKrw = null;
      missingFeeWarnings.push({
        code: "MISSING_FILL_FEE",
        market: fill.market,
        fillId: fill.id,
        message: `Fee is unavailable for fill ${fill.id}.`,
      });
    } else {
      state.paidFeesKrw = addNullable(state.paidFeesKrw, fill.feeKrw);
    }

    if (fill.side === "bid") {
      state.lots.push({
        source: "SELECTED_STREAM",
        quantity: fill.volume,
        costPerUnitKrw:
          fill.feeKrw === null ? null : (notionalKrw + fill.feeKrw) / fill.volume,
      });
      continue;
    }

    const unmatchedQuantity = consumeSell(state, fill);
    if (unmatchedQuantity > QUANTITY_TOLERANCE) {
      state.unmatchedSellQuantity = normalizeQuantity(
        state.unmatchedSellQuantity + unmatchedQuantity,
      );
      unmatchedSellWarnings.push({
        code: "UNMATCHED_SELL",
        market: fill.market,
        fillId: fill.id,
        message: `Sell fill ${fill.id} has ${unmatchedQuantity} unmatched quantity.`,
      });
    }
  }

  const marks = new Map(markPrices.map((mark) => [mark.market, mark.priceKrw] as const));
  for (const mark of markPrices) {
    getState(states, mark.market);
  }

  const markets = MARKET_ORDER.filter((market) => states.has(market)).map((market) => {
    const state = states.get(market);
    if (!state) {
      throw new Error(`Missing performance state for ${market}.`);
    }
    const result = finishMarket(state, marks.get(market));
    if (result.remainingQuantity > 0 && result.marketValueKrw === null) {
      missingMarkWarnings.push({
        code: "MISSING_MARK_PRICE",
        market,
        message: `Mark price is unavailable for ${market}.`,
      });
    }
    return result;
  });

  return {
    markets,
    totals: totalMarkets(markets),
    warnings: [
      ...missingFeeWarnings,
      ...unmatchedSellWarnings,
      ...missingOpeningCostWarnings,
      ...missingMarkWarnings,
    ],
  };
}

function consumeSell(state: MarketState, fill: PerformanceFill): number {
  let quantityToSell = fill.volume;
  const netProceedsPerUnitKrw =
    fill.feeKrw === null ? null : fill.priceKrw - fill.feeKrw / fill.volume;

  while (quantityToSell > QUANTITY_TOLERANCE && state.lots.length > 0) {
    const lot = state.lots[0];
    if (!lot) {
      break;
    }
    const consumedQuantity = Math.min(quantityToSell, lot.quantity);
    const pnlKrw =
      lot.costPerUnitKrw === null || netProceedsPerUnitKrw === null
        ? null
        : (netProceedsPerUnitKrw - lot.costPerUnitKrw) * consumedQuantity;

    state.realizedPnlKrw = addNullable(state.realizedPnlKrw, pnlKrw);
    if (lot.source === "OPENING") {
      state.openingInventoryRealizedPnlKrw = addNullable(
        state.openingInventoryRealizedPnlKrw,
        pnlKrw,
      );
    } else {
      state.selectedStreamRealizedPnlKrw = addNullable(
        state.selectedStreamRealizedPnlKrw,
        pnlKrw,
      );
    }

    lot.quantity = normalizeQuantity(lot.quantity - consumedQuantity);
    quantityToSell = normalizeQuantity(quantityToSell - consumedQuantity);
    if (lot.quantity <= QUANTITY_TOLERANCE) {
      state.lots.shift();
    }
  }

  return normalizeQuantity(quantityToSell);
}

function finishMarket(
  state: MarketState,
  markPriceKrw: number | null | undefined,
): MarketPerformanceResult {
  const remainingQuantity = normalizeQuantity(
    state.lots.reduce((sum, lot) => sum + lot.quantity, 0),
  );
  const remainingCostKrw = state.lots.some((lot) => lot.costPerUnitKrw === null)
    ? null
    : state.lots.reduce(
        (sum, lot) => sum + lot.quantity * (lot.costPerUnitKrw ?? 0),
        0,
      );
  const marketValueKrw =
    remainingQuantity === 0
      ? 0
      : markPriceKrw === null || markPriceKrw === undefined
        ? null
        : remainingQuantity * markPriceKrw;

  return {
    market: state.market,
    realizedPnlKrw: state.realizedPnlKrw,
    openingInventoryRealizedPnlKrw: state.openingInventoryRealizedPnlKrw,
    selectedStreamRealizedPnlKrw: state.selectedStreamRealizedPnlKrw,
    paidFeesKrw: state.paidFeesKrw,
    turnoverKrw: state.turnoverKrw,
    remainingQuantity,
    remainingCostKrw,
    marketValueKrw,
    grossUnrealizedPnlKrw:
      remainingCostKrw === null || marketValueKrw === null
        ? null
        : marketValueKrw - remainingCostKrw,
    unmatchedSellQuantity: state.unmatchedSellQuantity,
  };
}

function totalMarkets(markets: readonly MarketPerformanceResult[]): PerformanceTotals {
  return {
    realizedPnlKrw: sumNullable(markets.map((market) => market.realizedPnlKrw)),
    openingInventoryRealizedPnlKrw: sumNullable(
      markets.map((market) => market.openingInventoryRealizedPnlKrw),
    ),
    selectedStreamRealizedPnlKrw: sumNullable(
      markets.map((market) => market.selectedStreamRealizedPnlKrw),
    ),
    paidFeesKrw: sumNullable(markets.map((market) => market.paidFeesKrw)),
    turnoverKrw: markets.reduce((sum, market) => sum + market.turnoverKrw, 0),
    remainingCostKrw: sumNullable(markets.map((market) => market.remainingCostKrw)),
    marketValueKrw: sumNullable(markets.map((market) => market.marketValueKrw)),
    grossUnrealizedPnlKrw: sumNullable(
      markets.map((market) => market.grossUnrealizedPnlKrw),
    ),
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
  const state: MarketState = {
    market,
    lots: [],
    realizedPnlKrw: 0,
    openingInventoryRealizedPnlKrw: 0,
    selectedStreamRealizedPnlKrw: 0,
    paidFeesKrw: 0,
    turnoverKrw: 0,
    unmatchedSellQuantity: 0,
  };
  states.set(market, state);
  return state;
}

function addNullable(current: number | null, addition: number | null): number | null {
  return current === null || addition === null ? null : current + addition;
}

function sumNullable(values: readonly (number | null)[]): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function normalizeQuantity(value: number): number {
  return Math.abs(value) <= QUANTITY_TOLERANCE ? 0 : value;
}

function validateInput(
  fills: readonly PerformanceFill[],
  openingPositions: readonly PerformanceOpeningPosition[],
  markPrices: readonly PerformanceMarkPrice[],
): void {
  for (const fill of fills) {
    assertPositive(fill.priceKrw, `Fill ${fill.id} priceKrw`);
    assertPositive(fill.volume, `Fill ${fill.id} volume`);
    if (fill.feeKrw !== null && (!Number.isFinite(fill.feeKrw) || fill.feeKrw < 0)) {
      throw new Error(`Fill ${fill.id} feeKrw must be a finite non-negative number or null.`);
    }
    if (parsePerformanceTimestamp(fill.filledAt) === null) {
      throw new Error(`Fill ${fill.id} filledAt must be a valid timestamp.`);
    }
  }
  rejectAmbiguousInstants(fills);
  for (const position of openingPositions) {
    assertPositive(position.quantity, `Opening position ${position.market} quantity`);
    if (position.averagePriceKrw !== null) {
      assertPositive(
        position.averagePriceKrw,
        `Opening position ${position.market} averagePriceKrw`,
      );
    }
  }
  for (const mark of markPrices) {
    if (mark.priceKrw !== null) {
      assertPositive(mark.priceKrw, `Mark ${mark.market} priceKrw`);
    }
  }
}

function rejectAmbiguousInstants(fills: readonly PerformanceFill[]): void {
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

function assertPositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive number.`);
  }
}
