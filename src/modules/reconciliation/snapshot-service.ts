import type {
  BalanceSnapshotRecord,
  ExchangeBalance,
  PositionSnapshot,
  PositionSnapshotRecord,
  SupportedAsset,
} from "../../domain/types.js";
import { getAssetForMarket, type SupportedMarket } from "../../domain/types.js";
import { createId } from "../../shared/ids.js";
import type { UpbitTickerSnapshot } from "../exchange/upbit/contracts.js";

export function buildPriceByAssetFromExchangeBalances(
  balances: ExchangeBalance[],
): Partial<Record<SupportedAsset, number>> {
  const priceByAsset: Partial<Record<SupportedAsset, number>> = {};

  for (const balance of balances) {
    if (balance.currency !== "BTC" && balance.currency !== "ETH") {
      continue;
    }

    const avgBuyPrice = Number(balance.avgBuyPrice);
    if (Number.isFinite(avgBuyPrice) && avgBuyPrice > 0) {
      priceByAsset[balance.currency] = avgBuyPrice;
    }
  }

  return priceByAsset;
}

export function buildPriceByAssetFromTickerSnapshots(
  tickers: readonly Pick<UpbitTickerSnapshot, "market" | "trade_price">[],
): Partial<Record<SupportedAsset, number>> {
  const priceByAsset: Partial<Record<SupportedAsset, number>> = {};

  for (const ticker of tickers) {
    const asset = getAssetForMarket(ticker.market as SupportedMarket);
    if (Number.isFinite(ticker.trade_price) && ticker.trade_price > 0) {
      priceByAsset[asset] = ticker.trade_price;
    }
  }

  return priceByAsset;
}

export function buildBalanceSnapshotRecord(input: {
  exchangeAccountId: string;
  balances: ExchangeBalance[];
  priceByAsset: Partial<Record<SupportedAsset, number>>;
  source: BalanceSnapshotRecord["source"];
  capturedAt?: string;
}): BalanceSnapshotRecord {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const totalKrwValue = calculateTotalKrwValue(input.balances, input.priceByAsset);

  return {
    id: createId("balance_snapshot"),
    exchangeAccountId: input.exchangeAccountId,
    capturedAt,
    source: input.source,
    totalKrwValue: String(totalKrwValue),
    balancesJson: JSON.stringify(input.balances),
  };
}

export function buildPositionSnapshotRecord(input: {
  exchangeAccountId: string;
  balances: ExchangeBalance[];
  priceByAsset: Partial<Record<SupportedAsset, number>>;
  source: PositionSnapshotRecord["source"];
  capturedAt?: string;
}): PositionSnapshotRecord {
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  const positions = input.balances
    .filter((balance) => balance.currency === "BTC" || balance.currency === "ETH")
    .map<PositionSnapshot>((balance) => {
      const asset = balance.currency as SupportedAsset;
      const quantity = Number(balance.balance) + Number(balance.locked);
      const markPrice = input.priceByAsset[asset] ?? null;
      const marketValue = typeof markPrice === "number" ? quantity * markPrice : null;
      const averageEntryPrice = Number(balance.avgBuyPrice) > 0 ? balance.avgBuyPrice : null;

      return {
        asset,
        market: asset === "BTC" ? "KRW-BTC" : "KRW-ETH",
        quantity: String(quantity),
        averageEntryPrice,
        markPrice: typeof markPrice === "number" ? String(markPrice) : null,
        marketValue: typeof marketValue === "number" ? String(marketValue) : null,
        exposureRatio: null,
        capturedAt,
      };
    });

  return {
    id: createId("position_snapshot"),
    exchangeAccountId: input.exchangeAccountId,
    capturedAt,
    source: input.source,
    positionsJson: JSON.stringify(positions),
  };
}

function calculateTotalKrwValue(
  balances: ExchangeBalance[],
  priceByAsset: Partial<Record<SupportedAsset, number>>,
): number {
  return balances.reduce((sum, balance) => {
    if (balance.currency === "KRW") {
      return sum + Number(balance.balance) + Number(balance.locked);
    }

    if (balance.currency === "BTC" || balance.currency === "ETH") {
      const quantity = Number(balance.balance) + Number(balance.locked);
      const price = priceByAsset[balance.currency] ?? 0;
      return sum + quantity * price;
    }

    return sum;
  }, 0);
}
