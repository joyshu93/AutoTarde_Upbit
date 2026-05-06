import assert from "node:assert/strict";

import type {
  BalanceSnapshotRecord,
  OrderRecord,
  PortfolioExposureSnapshot,
  PositionSnapshot,
  PositionSnapshotRecord,
  StrategyDecisionRecord,
} from "../src/domain/types.js";
import { InMemoryExecutionRepository } from "../src/modules/db/repositories/in-memory-repositories.js";
import {
  buildPositionGuardStrategyContext,
  deriveRecentExitContext,
  loadPositionGuardStrategyContext,
  toPreviousPositionGuardDecision,
} from "../src/modules/strategy/position-guard-context.js";
import type { PositionGuardStructureAnalysis } from "../src/modules/strategy/position-guard-core.js";
import { POSITION_GUARD_STRATEGY_KEY } from "../src/modules/strategy/position-guard-core.js";
import { test } from "./harness.js";

test("position guard context builder derives portfolio inputs from persisted snapshots", () => {
  const context = buildPositionGuardStrategyContext({
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    generatedAt: "2026-04-20T02:05:00.000Z",
    analysis: createAnalysis(),
    balanceSnapshotJson: JSON.stringify([
      { currency: "KRW", balance: "1500000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
      { currency: "BTC", balance: "0.02", locked: "0", avgBuyPrice: "100000000", unitCurrency: "KRW" },
    ]),
    positionSnapshotJson: JSON.stringify([
      createPosition({
        asset: "BTC",
        market: "KRW-BTC",
        quantity: "0.02",
        averageEntryPrice: "100000000",
        marketValue: "2200000",
      }),
    ]),
    portfolio: createPortfolio(),
    latestDecisionRecord: createStrategyDecision({
      createdAt: "2026-04-20T01:05:00.000Z",
      decisionBasisJson: JSON.stringify({
        metadata: {
          executionDisposition: "DEFERRED_CONFIRMATION",
          signalQualityBucket: "MEDIUM",
          diagnosticsJson: JSON.stringify({ entryPath: "RECLAIM" }),
        },
      }),
    }),
    orders: [
      createOrder({
        id: "exit-order",
        side: "ask",
        status: "FILLED",
        updatedAt: "2026-04-20T00:05:00.000Z",
      }),
    ],
  });

  assert.equal(context.asset, "BTC");
  assert.equal(context.availableKrw, 1_500_000);
  assert.equal(context.positionQuantity, 0.02);
  assert.equal(context.averageEntryPrice, 100_000_000);
  assert.equal(context.portfolio.assetMarketValueKrw, 2_200_000);
  assert.equal(context.analysis.pnlPct, 0.1);
  assert.deepEqual(context.latestDecision, {
    action: "ENTER",
    executionDisposition: "DEFERRED_CONFIRMATION",
    entryPath: "RECLAIM",
    qualityBucket: "MEDIUM",
    createdAt: "2026-04-20T01:05:00.000Z",
  });
  assert.equal(context.recentExit.createdAt, "2026-04-20T00:05:00.000Z");
  assert.equal(context.recentExit.hoursSinceExit, 2);
});

test("position guard context loader reads repository state without mutating it", async () => {
  const repository = new InMemoryExecutionRepository();
  await repository.saveBalanceSnapshot(createBalanceSnapshot());
  await repository.savePositionSnapshot(createPositionSnapshot());
  await repository.saveStrategyDecision(createStrategyDecision({
    id: "older",
    createdAt: "2026-04-20T00:05:00.000Z",
    decisionBasisJson: JSON.stringify({
      metadata: {
        executionDisposition: "SKIPPED",
        signalQualityBucket: "LOW",
        diagnosticsJson: JSON.stringify({ entryPath: "NONE" }),
      },
    }),
  }));
  await repository.saveStrategyDecision(createStrategyDecision({
    id: "newer",
    createdAt: "2026-04-20T01:05:00.000Z",
    decisionBasisJson: JSON.stringify({
      metadata: {
        executionDisposition: "DEFERRED_CONFIRMATION",
        signalQualityBucket: "MEDIUM",
        diagnosticsJson: JSON.stringify({ entryPath: "RECLAIM" }),
      },
    }),
  }));
  await repository.saveOrder(createOrder({
    id: "exit-order",
    side: "ask",
    status: "FILLED",
    updatedAt: "2026-04-20T00:05:00.000Z",
  }));

  const context = await loadPositionGuardStrategyContext(repository, {
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    generatedAt: "2026-04-20T02:05:00.000Z",
    analysis: createAnalysis(),
  });

  assert.equal(context.availableKrw, 1_500_000);
  assert.equal(context.latestDecision?.createdAt, "2026-04-20T01:05:00.000Z");
  assert.equal(context.latestDecision?.executionDisposition, "DEFERRED_CONFIRMATION");
  assert.equal((await repository.listOrders("primary")).length, 1);
});

test("position guard context ignores incomplete latest decision basis", () => {
  const previous = toPreviousPositionGuardDecision(createStrategyDecision({
    decisionBasisJson: JSON.stringify({
      metadata: {
        executionDisposition: "DEFERRED_CONFIRMATION",
      },
    }),
  }));

  assert.equal(previous, null);
});

test("position guard recent exit context only considers filled sell orders for the same market", () => {
  const recentExit = deriveRecentExitContext(
    [
      createOrder({
        id: "buy-order",
        side: "bid",
        status: "FILLED",
        updatedAt: "2026-04-20T01:05:00.000Z",
      }),
      createOrder({
        id: "eth-exit",
        market: "KRW-ETH",
        side: "ask",
        status: "FILLED",
        updatedAt: "2026-04-20T01:30:00.000Z",
      }),
      createOrder({
        id: "btc-exit",
        side: "ask",
        status: "FILLED",
        updatedAt: "2026-04-20T00:05:00.000Z",
      }),
    ],
    "KRW-BTC",
    "2026-04-20T02:05:00.000Z",
  );

  assert.equal(recentExit.createdAt, "2026-04-20T00:05:00.000Z");
  assert.equal(recentExit.hoursSinceExit, 2);
  assert.equal(recentExit.realizedPnl, null);
});

function createAnalysis(): PositionGuardStructureAnalysis {
  return {
    regime: "EARLY_RECOVERY",
    riskLevel: "LOW",
    invalidationState: "CLEAR",
    invalidationLevel: 95_000_000,
    pullbackZone: false,
    reclaimStructure: true,
    breakoutHoldStructure: false,
    upperRangeChase: false,
    currentPrice: 110_000_000,
    entryPath: "RECLAIM",
    trendAlignmentScore: 4,
    recoveryQualityScore: 4,
    breakdownPressureScore: 0,
    weakeningStage: "NONE",
    breakdown1d: false,
    breakdown4h: false,
    failedReclaim: false,
    bearishMomentumExpansion: false,
    volumeRecovery: true,
    macdImproving: true,
    rsiRecovery: true,
    atrShock: false,
    averageEntryPrice: 0,
    pnlPct: 0,
    oneHourLocation: "MIDDLE",
    fourHourLocation: "MIDDLE",
  };
}

function createBalanceSnapshot(): BalanceSnapshotRecord {
  return {
    id: "balance-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T01:00:00.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "3700000",
    balancesJson: JSON.stringify([
      { currency: "KRW", balance: "1500000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
    ]),
  };
}

function createPositionSnapshot(): PositionSnapshotRecord {
  return {
    id: "position-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T01:00:00.000Z",
    source: "RECONCILIATION",
    positionsJson: JSON.stringify([
      createPosition({
        asset: "BTC",
        market: "KRW-BTC",
        quantity: "0.02",
        averageEntryPrice: "100000000",
        marketValue: "2200000",
      }),
    ]),
  };
}

function createPosition(overrides: Partial<PositionSnapshot>): PositionSnapshot {
  return {
    asset: "BTC",
    market: "KRW-BTC",
    quantity: "0",
    averageEntryPrice: null,
    markPrice: "110000000",
    marketValue: "0",
    exposureRatio: null,
    capturedAt: "2026-04-20T01:00:00.000Z",
    ...overrides,
  };
}

function createPortfolio(): PortfolioExposureSnapshot {
  return {
    totalEquityKrw: 3_700_000,
    totalExposureKrw: 2_200_000,
    assetExposureKrw: {
      BTC: 2_200_000,
      ETH: 0,
    },
  };
}

function createStrategyDecision(overrides: Partial<StrategyDecisionRecord> = {}): StrategyDecisionRecord {
  return {
    id: "decision-1",
    exchangeAccountId: "primary",
    strategyKey: POSITION_GUARD_STRATEGY_KEY,
    market: "KRW-BTC",
    action: "ENTER",
    status: "READY",
    decisionBasisJson: JSON.stringify({
      metadata: {
        executionDisposition: "IMMEDIATE",
        signalQualityBucket: "HIGH",
        diagnosticsJson: JSON.stringify({ entryPath: "RECLAIM" }),
      },
    }),
    intendedNotionalKrw: "100000",
    intendedQuantity: null,
    referencePrice: "110000000",
    createdAt: "2026-04-20T01:05:00.000Z",
    ...overrides,
  };
}

function createOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  return {
    id: "order-1",
    strategyDecisionId: null,
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "ask",
    ordType: "market",
    volume: "0.02",
    price: null,
    timeInForce: null,
    smpType: null,
    identifier: "identifier-1",
    idempotencyKey: "idempotency-1",
    origin: "STRATEGY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: null,
    status: "FILLED",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:05:00.000Z",
    ...overrides,
  };
}
