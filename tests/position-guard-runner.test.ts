import assert from "node:assert/strict";

import type { ExecutionStateRecord, StrategyDecision } from "../src/domain/types.js";
import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import { ExecutionService } from "../src/modules/execution/execution-service.js";
import { DryRunExchangeAdapter, type ExchangeAdapter } from "../src/modules/exchange/interfaces.js";
import type {
  UpbitCandleSnapshot,
  UpbitGetDayCandlesRequest,
  UpbitGetMinuteCandlesRequest,
  UpbitSpotMarket,
  UpbitTickerSnapshot,
} from "../src/modules/exchange/upbit/contracts.js";
import {
  createDefaultPositionGuardRunnerConfig,
  createStrategyDecisionRecord,
  PositionGuardStrategyRunner,
  toOrderSubmissionInput,
} from "../src/modules/strategy/position-guard-runner.js";
import type { PositionGuardEngineDecision, PositionGuardStrategyContext } from "../src/modules/strategy/position-guard-core.js";
import { test } from "./harness.js";

test("position guard runner persists a strategy decision without submitting when the action is HOLD", async () => {
  let createOrderCallCount = 0;
  const repositories = new InMemoryExecutionRepository();
  const executionService = createExecutionService(repositories, {
    async createOrder(request) {
      createOrderCallCount += 1;
      return new DryRunExchangeAdapter().createOrder(request);
    },
  });
  await seedEmptyPortfolio(repositories);

  const runner = new PositionGuardStrategyRunner({
    repositories,
    executionService,
    marketDataReader: createFlatMarketReader(),
    config: createDefaultPositionGuardRunnerConfig("primary"),
  });

  const result = await runner.runOnce({
    market: "KRW-BTC",
    generatedAt: "2026-04-20T01:05:00.000Z",
  });
  const latestDecision = await repositories.getLatestStrategyDecision(
    "primary",
    "KRW-BTC",
    result.strategyDecision.strategyKey,
  );
  const orders = await repositories.listOrders("primary");

  assert.equal(result.strategyDecision.action, "HOLD");
  assert.equal(result.strategyDecisionRecord.status, "NO_ACTION");
  assert.equal(result.submission, null);
  assert.equal(latestDecision?.id, result.strategyDecisionRecord.id);
  assert.equal(orders.length, 0);
  assert.equal(createOrderCallCount, 0);
});

test("position guard runner persists deferred confirmation without submitting an order", async () => {
  let createOrderCallCount = 0;
  const repositories = new InMemoryExecutionRepository();
  const executionService = createExecutionService(repositories, {
    async createOrder(request) {
      createOrderCallCount += 1;
      return new DryRunExchangeAdapter().createOrder(request);
    },
  });
  await seedEmptyPortfolio(repositories);

  const runner = new PositionGuardStrategyRunner({
    repositories,
    executionService,
    marketDataReader: createFlatMarketReader(),
    config: createDefaultPositionGuardRunnerConfig("primary"),
  });
  const generatedAt = "2026-04-20T01:05:00.000Z";
  const decision = createBullishDecisionBundle("DEFERRED_CONFIRMATION", generatedAt);
  Object.defineProperty(runner, "buildDecision", {
    value: async () => decision,
  });

  const result = await runner.runOnce({
    market: "KRW-BTC",
    generatedAt,
  });
  const persistedDecision = await repositories.getLatestStrategyDecision(
    "primary",
    "KRW-BTC",
    result.strategyDecision.strategyKey,
  );
  const orders = await repositories.listOrders("primary");

  assert.equal(result.strategyDecision.action, "ENTER");
  assert.equal(result.engineDecision.executionDisposition, "DEFERRED_CONFIRMATION");
  assert.equal(result.strategyDecision.metadata.executionDisposition, "DEFERRED_CONFIRMATION");
  assert.equal(result.strategyDecisionRecord.status, "PENDING_CONFIRMATION");
  assert.equal(persistedDecision?.id, result.strategyDecisionRecord.id);
  assert.equal(result.submission, null);
  assert.equal(orders.length, 0);
  assert.equal(createOrderCallCount, 0);
});

test("position guard runner keeps confirmed decisions order-capable", async () => {
  let createOrderCallCount = 0;
  const repositories = new InMemoryExecutionRepository();
  const executionService = createExecutionService(repositories, {
    async createOrder(request) {
      createOrderCallCount += 1;
      return new DryRunExchangeAdapter().createOrder(request);
    },
  });
  await seedEmptyPortfolio(repositories);

  const runner = new PositionGuardStrategyRunner({
    repositories,
    executionService,
    marketDataReader: createFlatMarketReader(),
    config: createDefaultPositionGuardRunnerConfig("primary"),
  });
  const generatedAt = "2026-04-20T01:05:00.000Z";
  const decision = createBullishDecisionBundle("EXECUTED_AFTER_CONFIRMATION", generatedAt);
  Object.defineProperty(runner, "buildDecision", {
    value: async () => decision,
  });

  const result = await runner.runOnce({
    market: "KRW-BTC",
    generatedAt,
  });
  const persistedDecision = await repositories.getLatestStrategyDecision(
    "primary",
    "KRW-BTC",
    result.strategyDecision.strategyKey,
  );
  const orders = await repositories.listOrders("primary");

  assert.equal(result.engineDecision.executionDisposition, "EXECUTED_AFTER_CONFIRMATION");
  assert.equal(persistedDecision?.id, result.strategyDecisionRecord.id);
  assert.equal(result.submission?.accepted, true);
  assert.equal(orders.length, 1);
  assert.equal(createOrderCallCount, 1);
});

test("position guard preview computes a decision without persisting or submitting", async () => {
  let createOrderCallCount = 0;
  const repositories = new InMemoryExecutionRepository();
  const executionService = createExecutionService(repositories, {
    async createOrder(request) {
      createOrderCallCount += 1;
      return new DryRunExchangeAdapter().createOrder(request);
    },
  });
  await seedEmptyPortfolio(repositories);

  const runner = new PositionGuardStrategyRunner({
    repositories,
    executionService,
    marketDataReader: createFlatMarketReader(),
    config: createDefaultPositionGuardRunnerConfig("primary"),
  });

  const result = await runner.previewOnce({
    market: "KRW-BTC",
    generatedAt: "2026-04-20T01:05:00.000Z",
  });
  const latestDecision = await repositories.getLatestStrategyDecision(
    "primary",
    "KRW-BTC",
    result.strategyDecision.strategyKey,
  );
  const orders = await repositories.listOrders("primary");

  assert.equal(result.strategyDecision.action, "HOLD");
  assert.equal(result.orderPreview, null);
  assert.equal(latestDecision, null);
  assert.equal(orders.length, 0);
  assert.equal(createOrderCallCount, 0);
});

test("position guard runner maps buy and sell decisions to Upbit spot order requests", () => {
  const enterDecision: StrategyDecision = {
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "ENTER",
    reasonCodes: ["enter"],
    referencePrice: 100_000_000,
    requestedNotionalKrw: 150_000,
    requestedQuantity: null,
    metadata: {
      executionDisposition: "EXECUTED_AFTER_CONFIRMATION",
    },
  };
  const exitDecision: StrategyDecision = {
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "EXIT",
    reasonCodes: ["exit"],
    referencePrice: 100_000_000,
    requestedNotionalKrw: null,
    requestedQuantity: 0.012345678901,
    metadata: {},
  };

  const buyInput = toOrderSubmissionInput({
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-buy",
    referencePriceCapturedAt: "2026-04-20T01:05:00.000Z",
    decision: enterDecision,
  });
  const sellInput = toOrderSubmissionInput({
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-sell",
    referencePriceCapturedAt: "2026-04-20T01:05:00.000Z",
    decision: exitDecision,
  });

  assert.deepEqual(buyInput, {
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-buy",
    referencePriceCapturedAt: "2026-04-20T01:05:00.000Z",
    decision: enterDecision,
    side: "bid",
    ordType: "price",
    price: "150000",
    volume: null,
  });
  assert.deepEqual(sellInput, {
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-sell",
    referencePriceCapturedAt: "2026-04-20T01:05:00.000Z",
    decision: exitDecision,
    side: "ask",
    ordType: "market",
    price: null,
    volume: "0.012345678901",
  });
});

test("position guard runner records inspectable decision basis", () => {
  const strategyDecision: StrategyDecision = {
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "HOLD",
    reasonCodes: ["hold"],
    referencePrice: 100_000_000,
    requestedNotionalKrw: null,
    requestedQuantity: null,
    metadata: {
      executionDisposition: "SKIPPED",
    },
  };
  const engineDecision = {
    action: "HOLD",
    summary: "Hold.",
    reasons: ["No signal."],
    targetNotionalKrw: 0,
    targetQuantityFraction: null,
    referencePrice: 100_000_000,
    executionDisposition: "SKIPPED",
    signalQuality: {
      score: 1,
      bucket: "LOW",
      confirmationRequired: false,
      confirmationSatisfied: false,
      reentryPenaltyApplied: false,
    },
    exposureGuardrails: {
      perAssetMaxAllocation: 0.45,
      totalPortfolioMaxExposure: 0.75,
      remainingAssetCapacity: 0,
      remainingPortfolioCapacity: 0,
    },
    diagnostics: {
      regime: "RANGE",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: 95_000_000,
      entryPath: "NONE",
      trendAlignmentScore: 0,
      recoveryQualityScore: 0,
      breakdownPressureScore: 0,
      weakeningStage: "NONE",
      upperRangeChase: false,
      pullbackZone: false,
      reclaimStructure: false,
      breakoutHoldStructure: false,
    },
  } satisfies PositionGuardEngineDecision;
  const context = {
    asset: "BTC",
    market: "KRW-BTC",
    generatedAt: "2026-04-20T01:05:00.000Z",
    availableKrw: 0,
    positionQuantity: 0,
    averageEntryPrice: 0,
    portfolio: {
      totalEquityKrw: 0,
      assetMarketValueKrw: 0,
      totalExposureKrw: 0,
    },
    latestDecision: null,
    recentExit: {
      createdAt: null,
      hoursSinceExit: null,
      realizedPnl: null,
    },
    settings: createDefaultPositionGuardRunnerConfig("primary").settings,
    analysis: {
      regime: "RANGE",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: 95_000_000,
      pullbackZone: false,
      reclaimStructure: false,
      breakoutHoldStructure: false,
      upperRangeChase: false,
      currentPrice: 100_000_000,
      entryPath: "NONE",
      trendAlignmentScore: 0,
      recoveryQualityScore: 0,
      breakdownPressureScore: 0,
      weakeningStage: "NONE",
      breakdown1d: false,
      breakdown4h: false,
      failedReclaim: false,
      bearishMomentumExpansion: false,
      volumeRecovery: false,
      macdImproving: false,
      rsiRecovery: false,
      atrShock: false,
      averageEntryPrice: 0,
      pnlPct: 0,
    },
  } satisfies PositionGuardStrategyContext;

  const record = createStrategyDecisionRecord({
    exchangeAccountId: "primary",
    generatedAt: "2026-04-20T01:05:00.000Z",
    strategyDecision,
    engineDecision,
    context,
  });
  const basis = JSON.parse(record.decisionBasisJson) as {
    strategyDecision?: StrategyDecision;
    engineDecision?: PositionGuardEngineDecision;
    context?: {
      analysis?: {
        regime?: string;
      };
    };
  };

  assert.equal(record.status, "NO_ACTION");
  assert.equal(basis.strategyDecision?.action, "HOLD");
  assert.equal(basis.engineDecision?.executionDisposition, "SKIPPED");
  assert.equal(basis.context?.analysis?.regime, "RANGE");
});

function createExecutionService(
  repositories: InMemoryExecutionRepository,
  exchangeAdapterOverrides: Partial<ExchangeAdapter> = {},
): ExecutionService {
  const baseAdapter = new DryRunExchangeAdapter();
  const exchangeAdapter: ExchangeAdapter = {
    getBalances: exchangeAdapterOverrides.getBalances ?? baseAdapter.getBalances.bind(baseAdapter),
    getOrderChance: exchangeAdapterOverrides.getOrderChance ?? baseAdapter.getOrderChance.bind(baseAdapter),
    testOrder: exchangeAdapterOverrides.testOrder ?? baseAdapter.testOrder.bind(baseAdapter),
    createOrder: exchangeAdapterOverrides.createOrder ?? baseAdapter.createOrder.bind(baseAdapter),
    cancelOrder: exchangeAdapterOverrides.cancelOrder ?? baseAdapter.cancelOrder.bind(baseAdapter),
    getOrder: exchangeAdapterOverrides.getOrder ?? baseAdapter.getOrder.bind(baseAdapter),
    listOpenOrders: exchangeAdapterOverrides.listOpenOrders ?? baseAdapter.listOpenOrders.bind(baseAdapter),
    listClosedOrders: exchangeAdapterOverrides.listClosedOrders ?? baseAdapter.listClosedOrders.bind(baseAdapter),
  };

  return new ExecutionService({
    riskLimits: {
      maxAllocationByAsset: {
        BTC: 0.6,
        ETH: 0.6,
      },
      totalExposureCap: 0.75,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    exchangeAdapter,
    validationAdapter: exchangeAdapter,
    repositories,
    operatorState: new InMemoryOperatorStateStore(createExecutionState()),
    now: () => "2026-04-20T01:05:10.000Z",
  });
}

function createBullishDecisionBundle(
  executionDisposition: "DEFERRED_CONFIRMATION" | "EXECUTED_AFTER_CONFIRMATION",
  generatedAt: string,
): {
  strategyDecision: StrategyDecision;
  engineDecision: PositionGuardEngineDecision;
  context: PositionGuardStrategyContext;
  referencePriceCapturedAt: string;
} {
  const engineDecision: PositionGuardEngineDecision = {
    action: "ENTER",
    summary: "Borderline entry signal.",
    reasons: ["Confirmation is required."],
    targetNotionalKrw: 100_000,
    targetQuantityFraction: null,
    referencePrice: 100_000_000,
    executionDisposition,
    signalQuality: {
      score: 6,
      bucket: "BORDERLINE",
      confirmationRequired: true,
      confirmationSatisfied: executionDisposition === "EXECUTED_AFTER_CONFIRMATION",
      reentryPenaltyApplied: false,
    },
    exposureGuardrails: {
      perAssetMaxAllocation: 0.45,
      totalPortfolioMaxExposure: 0.75,
      remainingAssetCapacity: 450_000,
      remainingPortfolioCapacity: 750_000,
    },
    diagnostics: {
      regime: "RECLAIM_ATTEMPT",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: 95_000_000,
      entryPath: "RECLAIM",
      trendAlignmentScore: 3,
      recoveryQualityScore: 3,
      breakdownPressureScore: 0,
      weakeningStage: "NONE",
      upperRangeChase: false,
      pullbackZone: false,
      reclaimStructure: true,
      breakoutHoldStructure: false,
    },
  };
  const strategyDecision: StrategyDecision = {
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action: "ENTER",
    reasonCodes: ["enter", executionDisposition.toLowerCase()],
    referencePrice: engineDecision.referencePrice,
    requestedNotionalKrw: engineDecision.targetNotionalKrw,
    requestedQuantity: null,
    metadata: {
      executionDisposition,
      confirmationRequired: true,
      confirmationSatisfied: executionDisposition === "EXECUTED_AFTER_CONFIRMATION",
    },
  };
  const context: PositionGuardStrategyContext = {
    asset: "BTC",
    market: "KRW-BTC",
    generatedAt,
    availableKrw: 1_000_000,
    positionQuantity: 0,
    averageEntryPrice: 0,
    portfolio: {
      totalEquityKrw: 1_000_000,
      assetMarketValueKrw: 0,
      totalExposureKrw: 0,
    },
    latestDecision: null,
    recentExit: {
      createdAt: null,
      hoursSinceExit: null,
      realizedPnl: null,
    },
    settings: createDefaultPositionGuardRunnerConfig("primary").settings,
    analysis: {
      regime: "RECLAIM_ATTEMPT",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: 95_000_000,
      pullbackZone: false,
      reclaimStructure: true,
      breakoutHoldStructure: false,
      upperRangeChase: false,
      currentPrice: 100_000_000,
      entryPath: "RECLAIM",
      trendAlignmentScore: 3,
      recoveryQualityScore: 3,
      breakdownPressureScore: 0,
      weakeningStage: "NONE",
      breakdown1d: false,
      breakdown4h: false,
      failedReclaim: false,
      bearishMomentumExpansion: false,
      volumeRecovery: false,
      macdImproving: false,
      rsiRecovery: false,
      atrShock: false,
      averageEntryPrice: 0,
      pnlPct: 0,
    },
  };

  return {
    strategyDecision,
    engineDecision,
    context,
    referencePriceCapturedAt: generatedAt,
  };
}

function createExecutionState(): ExecutionStateRecord {
  return {
    id: "state-1",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
}

async function seedEmptyPortfolio(repositories: InMemoryExecutionRepository): Promise<void> {
  await repositories.saveBalanceSnapshot({
    id: "balance-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T01:00:00.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "1000000",
    balancesJson: JSON.stringify([
      { currency: "KRW", balance: "1000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
    ]),
  });
  await repositories.savePositionSnapshot({
    id: "position-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T01:00:00.000Z",
    source: "RECONCILIATION",
    positionsJson: "[]",
  });
}

function createFlatMarketReader() {
  return {
    async getTickers(markets: readonly UpbitSpotMarket[]): Promise<readonly UpbitTickerSnapshot[]> {
      return markets.map((market) => ({
        market,
        trade_price: 100_000_000,
        trade_timestamp: Date.parse("2026-04-20T01:05:00.000Z"),
      }));
    },
    async getMinuteCandles(request: UpbitGetMinuteCandlesRequest): Promise<readonly UpbitCandleSnapshot[]> {
      return createCandles(request.market, request.count, request.unit === 60 ? 60 * 60 * 1000 : 4 * 60 * 60 * 1000);
    },
    async getDayCandles(request: UpbitGetDayCandlesRequest): Promise<readonly UpbitCandleSnapshot[]> {
      return createCandles(request.market, request.count, 24 * 60 * 60 * 1000);
    },
  };
}

function createCandles(
  market: UpbitSpotMarket,
  count: number,
  durationMs: number,
): UpbitCandleSnapshot[] {
  const lastOpenMs = Date.parse("2026-04-20T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const openMs = lastOpenMs - ((count - 1 - index) * durationMs);
    return {
      market,
      candle_date_time_utc: new Date(openMs).toISOString().replace(/\.000Z$/u, ""),
      candle_date_time_kst: new Date(openMs + 9 * 60 * 60 * 1000).toISOString().replace(/\.000Z$/u, ""),
      opening_price: 100_000_000,
      high_price: 101_000_000,
      low_price: 99_000_000,
      trade_price: 100_000_000,
      timestamp: openMs,
      candle_acc_trade_price: 1_000_000_000,
      candle_acc_trade_volume: 10,
    };
  });
}
