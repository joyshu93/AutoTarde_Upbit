import type {
  BalanceSnapshotRecord,
  PositionSnapshotRecord,
  ReconciliationRunRecord,
  SupportedAsset,
} from "../../domain/types.js";
import type { ExecutionRepository } from "../db/interfaces.js";
import { parseCandidatePilotTimestamp } from "../db/pilot-interfaces.js";
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
  reconciliationRun: ReconciliationRunRecord;
}

export class PortfolioSyncService {
  private readonly dependencies: Readonly<{
    exchangeAdapter: Pick<ExchangeAdapter, "getBalances">;
    marketPriceReader?: Pick<UpbitPublicQuotationClient, "getTickers">;
    repositories: ExecutionRepository;
    reconciliationService: Pick<ReconciliationService, "runWithRecord">;
    now?: () => string;
  }>;

  constructor(
    dependencies: {
      exchangeAdapter: Pick<ExchangeAdapter, "getBalances">;
      marketPriceReader?: Pick<UpbitPublicQuotationClient, "getTickers">;
      repositories: ExecutionRepository;
      reconciliationService: Pick<ReconciliationService, "runWithRecord">;
      now?: () => string;
    },
  ) {
    this.dependencies = Object.freeze({
      exchangeAdapter: dependencies.exchangeAdapter,
      ...(dependencies.marketPriceReader === undefined ? {} : { marketPriceReader: dependencies.marketPriceReader }),
      repositories: dependencies.repositories,
      reconciliationService: dependencies.reconciliationService,
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
  }

  async run(input: {
    exchangeAccountId: string;
    source: ReconciliationTrigger;
    requestedAt?: string;
  }): Promise<PortfolioSyncRunResult> {
    const runInput = snapshotRunInput(input);
    const dependencies = this.dependencies;
    const requestedAt = runInput.requestedAt ?? dependencies.now?.() ?? new Date().toISOString();
    parseCandidatePilotTimestamp(requestedAt, "portfolio sync requestedAt");
    const repositories = dependencies.repositories;
    const getLatestBalanceSnapshot = repositories.getLatestBalanceSnapshot.bind(repositories);
    const getLatestPositionSnapshot = repositories.getLatestPositionSnapshot.bind(repositories);
    const saveBalanceSnapshot = repositories.saveBalanceSnapshot.bind(repositories);
    const savePositionSnapshot = repositories.savePositionSnapshot.bind(repositories);
    const updateReconciliationRun = repositories.updateReconciliationRun.bind(repositories);
    const getBalances = dependencies.exchangeAdapter.getBalances.bind(dependencies.exchangeAdapter);
    const runWithRecord = dependencies.reconciliationService.runWithRecord.bind(dependencies.reconciliationService);
    const getTickers = dependencies.marketPriceReader?.getTickers.bind(dependencies.marketPriceReader);
    const reconciliationRunIdentity = Object.freeze({
      id: createId("recon_run"),
      startedAt: requestedAt,
    });

    try {
      const previousBalanceSnapshot = await getLatestBalanceSnapshot(runInput.exchangeAccountId);
      const previousPositionSnapshot = await getLatestPositionSnapshot(runInput.exchangeAccountId);
      const balances = await getBalances();
      const valuation = await this.resolveValuationPrices(balances, getTickers);
      const balanceSnapshot = buildBalanceSnapshotRecord({
        exchangeAccountId: runInput.exchangeAccountId,
        balances,
        priceByAsset: valuation.priceByAsset,
        source: "RECONCILIATION",
        capturedAt: requestedAt,
      });
      const positionSnapshot = buildPositionSnapshotRecord({
        exchangeAccountId: runInput.exchangeAccountId,
        balances,
        priceByAsset: valuation.priceByAsset,
        source: "RECONCILIATION",
        capturedAt: requestedAt,
      });

      await saveBalanceSnapshot(balanceSnapshot);
      await savePositionSnapshot(positionSnapshot);

      const reconciliationResult = await runWithRecord(runInput.exchangeAccountId, {
        source: runInput.source,
        runIdentity: reconciliationRunIdentity,
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
        reconciliationSummary: reconciliationResult.summary,
        reconciliationRun: { ...reconciliationResult.reconciliationRun },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown portfolio sync failure.";
      await updateReconciliationRun({
        id: reconciliationRunIdentity.id,
        exchangeAccountId: runInput.exchangeAccountId,
        status: "ERROR",
        startedAt: reconciliationRunIdentity.startedAt,
        completedAt: requestedAt,
        summaryJson: JSON.stringify({
          source: runInput.source,
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
    getTickers: ((markets: readonly (typeof UPBIT_SPOT_MARKETS)[number][]) => ReturnType<UpbitPublicQuotationClient["getTickers"]>) | undefined,
  ): Promise<{
    priceByAsset: Partial<Record<SupportedAsset, number>>;
    source: "public_ticker" | "public_ticker+avg_buy_price_fallback" | "avg_buy_price_fallback";
  }> {
    const fallbackPrices = buildPriceByAssetFromExchangeBalances(balances);
    let marketPriceError: string | null = null;
    let marketPrices: Partial<Record<SupportedAsset, number>> = {};

    if (getTickers) {
      try {
        marketPrices = buildPriceByAssetFromTickerSnapshots(
          await getTickers(UPBIT_SPOT_MARKETS),
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

function snapshotRunInput(input: {
  exchangeAccountId: string;
  source: ReconciliationTrigger;
  requestedAt?: string;
}): Readonly<{
  exchangeAccountId: string;
  source: ReconciliationTrigger;
  requestedAt?: string;
}> {
  if (typeof input !== "object" || input === null || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error("Portfolio sync input must be a plain object.");
  }
  const allowedKeys = new Set(["exchangeAccountId", "source", "requestedAt"]);
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
    throw new Error("Portfolio sync input has an invalid key set.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const exchangeAccountId = requiredStringDataProperty(descriptors, "exchangeAccountId");
  const source = requiredStringDataProperty(descriptors, "source") as ReconciliationTrigger;
  const requestedAt = optionalStringDataProperty(descriptors, "requestedAt");
  if (requestedAt !== undefined) parseCandidatePilotTimestamp(requestedAt, "portfolio sync requestedAt");

  return Object.freeze({
    exchangeAccountId,
    source,
    ...(requestedAt === undefined ? {} : { requestedAt }),
  });
}

function requiredStringDataProperty(descriptors: PropertyDescriptorMap, key: string): string {
  const descriptor = descriptors[key];
  if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor) || typeof descriptor.value !== "string") {
    throw new Error(`Portfolio sync input ${key} must be an enumerable string data property.`);
  }
  if (descriptor.value.trim().length === 0) throw new Error(`Portfolio sync input ${key} must not be empty.`);
  return descriptor.value;
}

function optionalStringDataProperty(descriptors: PropertyDescriptorMap, key: string): string | undefined {
  return descriptors[key] === undefined ? undefined : requiredStringDataProperty(descriptors, key);
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
