import type {
  BalanceSnapshotRecord,
  PositionSnapshotRecord,
  SupportedAsset,
} from "../../domain/types.js";
import type { ExecutionRepository } from "../db/interfaces.js";
import type { ExchangeAdapter } from "../exchange/interfaces.js";
import { UPBIT_SPOT_MARKETS, type UpbitPublicQuotationClient } from "../exchange/upbit/contracts.js";
import { createId } from "../../shared/ids.js";
import type { ReconciliationSummary, ReconciliationTrigger } from "./interfaces.js";
import type { ReconciliationService } from "./reconciliation-service.js";
import {
  buildBalanceSnapshotRecord,
  buildPositionSnapshotRecord,
  buildPriceByAssetFromExchangeBalances,
  buildPriceByAssetFromTickerSnapshots,
} from "./snapshot-service.js";

export interface PortfolioSyncRunResult {
  requestedAt: string;
  valuationSource: "public_ticker" | "public_ticker+avg_buy_price_fallback" | "avg_buy_price_fallback";
  balanceSnapshot: BalanceSnapshotRecord;
  positionSnapshot: PositionSnapshotRecord;
  previousBalanceSnapshot: BalanceSnapshotRecord | null;
  previousPositionSnapshot: PositionSnapshotRecord | null;
  reconciliationSummary: ReconciliationSummary;
}

export class PortfolioSyncService {
  constructor(
    private readonly dependencies: {
      exchangeAdapter: Pick<ExchangeAdapter, "getBalances">;
      marketPriceReader?: Pick<UpbitPublicQuotationClient, "getTickers">;
      repositories: ExecutionRepository;
      reconciliationService: Pick<ReconciliationService, "run">;
      now?: () => string;
    },
  ) {}

  async run(input: {
    exchangeAccountId: string;
    source: ReconciliationTrigger;
  }): Promise<PortfolioSyncRunResult> {
    const requestedAt = this.dependencies.now?.() ?? new Date().toISOString();

    try {
      const previousBalanceSnapshot = await this.dependencies.repositories.getLatestBalanceSnapshot(input.exchangeAccountId);
      const previousPositionSnapshot = await this.dependencies.repositories.getLatestPositionSnapshot(input.exchangeAccountId);
      const balances = await this.dependencies.exchangeAdapter.getBalances();
      const valuation = await this.resolveValuationPrices(balances);
      const balanceSnapshot = buildBalanceSnapshotRecord({
        exchangeAccountId: input.exchangeAccountId,
        balances,
        priceByAsset: valuation.priceByAsset,
        source: "RECONCILIATION",
        capturedAt: requestedAt,
      });
      const positionSnapshot = buildPositionSnapshotRecord({
        exchangeAccountId: input.exchangeAccountId,
        balances,
        priceByAsset: valuation.priceByAsset,
        source: "RECONCILIATION",
        capturedAt: requestedAt,
      });

      await this.dependencies.repositories.saveBalanceSnapshot(balanceSnapshot);
      await this.dependencies.repositories.savePositionSnapshot(positionSnapshot);

      const reconciliationSummary = await this.dependencies.reconciliationService.run(input.exchangeAccountId, {
        source: input.source,
        portfolioSnapshots: {
          previousBalanceSnapshot,
          currentBalanceSnapshot: balanceSnapshot,
          previousPositionSnapshot,
          currentPositionSnapshot: positionSnapshot,
        },
      });

      return {
        requestedAt,
        valuationSource: valuation.source,
        balanceSnapshot,
        positionSnapshot,
        previousBalanceSnapshot,
        previousPositionSnapshot,
        reconciliationSummary,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown portfolio sync failure.";
      await this.dependencies.repositories.saveReconciliationRun({
        id: createId("recon_run"),
        exchangeAccountId: input.exchangeAccountId,
        status: "ERROR",
        startedAt: requestedAt,
        completedAt: requestedAt,
        summaryJson: JSON.stringify({
          source: input.source,
          status: "ERROR",
          issues: [],
          candidateCount: 0,
          processedCount: 0,
          deferredCount: 0,
          maxOrderLookupsPerRun: 0,
        }),
        errorMessage: message,
      });
      throw error;
    }
  }

  private async resolveValuationPrices(
    balances: Awaited<ReturnType<ExchangeAdapter["getBalances"]>>,
  ): Promise<{
    priceByAsset: Partial<Record<SupportedAsset, number>>;
    source: "public_ticker" | "public_ticker+avg_buy_price_fallback" | "avg_buy_price_fallback";
  }> {
    const fallbackPrices = buildPriceByAssetFromExchangeBalances(balances);
    let marketPriceError: string | null = null;
    let marketPrices: Partial<Record<SupportedAsset, number>> = {};

    if (this.dependencies.marketPriceReader) {
      try {
        marketPrices = buildPriceByAssetFromTickerSnapshots(
          await this.dependencies.marketPriceReader.getTickers(UPBIT_SPOT_MARKETS),
        );
      } catch (error) {
        marketPriceError = error instanceof Error ? error.message : "Unknown public ticker failure.";
      }
    }

    const priceByAsset: Partial<Record<SupportedAsset, number>> = {
      ...fallbackPrices,
      ...marketPrices,
    };

    const heldAssets = listHeldManagedAssets(balances);
    const missingAssets = heldAssets.filter((asset) => !isPositiveNumber(priceByAsset[asset]));
    if (missingAssets.length > 0) {
      const suffix = marketPriceError ? ` Public ticker error: ${marketPriceError}` : "";
      throw new Error(`Unable to determine valuation prices for held assets: ${missingAssets.join(",")}.${suffix}`);
    }

    const usedFallback = heldAssets.some(
      (asset) => !isPositiveNumber(marketPrices[asset]) && isPositiveNumber(fallbackPrices[asset]),
    );
    const usedMarketPrice = heldAssets.some((asset) => isPositiveNumber(marketPrices[asset]));

    if (usedMarketPrice && usedFallback) {
      return { priceByAsset, source: "public_ticker+avg_buy_price_fallback" };
    }

    if (usedMarketPrice) {
      return { priceByAsset, source: "public_ticker" };
    }

    return { priceByAsset, source: "avg_buy_price_fallback" };
  }
}

function listHeldManagedAssets(
  balances: Awaited<ReturnType<ExchangeAdapter["getBalances"]>>,
): SupportedAsset[] {
  return balances
    .filter((balance) => balance.currency === "BTC" || balance.currency === "ETH")
    .filter((balance) => Number(balance.balance) + Number(balance.locked) > 0)
    .map((balance) => balance.currency as SupportedAsset);
}

function isPositiveNumber(value: number | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
