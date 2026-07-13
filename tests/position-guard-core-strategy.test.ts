import assert from "node:assert/strict";

import {
  DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
  decidePositionGuardCore,
  toStrategyDecision,
  type PositionGuardStrategyContext,
  type PositionGuardStructureAnalysis,
} from "../src/modules/strategy/position-guard-core.js";
import { test } from "./harness.js";

test("position guard core exits immediately when invalidation is broken", () => {
  const context = createContext({
    positionQuantity: 0.5,
    averageEntryPrice: 100_000_000,
    analysis: {
      invalidationState: "BROKEN",
      breakdown1d: true,
      breakdown4h: true,
      bearishMomentumExpansion: true,
      currentPrice: 90_000_000,
      pnlPct: -0.1,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "EXIT");
  assert.equal(decision.executionDisposition, "IMMEDIATE");
  assert.equal(decision.targetQuantityFraction, 1);
  assert.equal(strategyDecision.action, "EXIT");
  assert.equal(strategyDecision.requestedQuantity, 0.5);
  assert.equal(strategyDecision.requestedNotionalKrw, null);
});

test("position guard core does not emit exit orders while flat", () => {
  const context = createContext({
    positionQuantity: 0,
    averageEntryPrice: 0,
    analysis: {
      invalidationState: "BROKEN",
      breakdown1d: true,
      breakdown4h: true,
      bearishMomentumExpansion: true,
      currentPrice: 90_000_000,
      pnlPct: 0,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "HOLD");
  assert.equal(decision.executionDisposition, "SKIPPED");
  assert.equal(decision.targetQuantityFraction, null);
  assert.match(decision.summary, /No position/);
  assert.equal(strategyDecision.action, "HOLD");
  assert.equal(strategyDecision.requestedQuantity, null);
  assert.equal(strategyDecision.requestedNotionalKrw, null);
});

test("position guard core blocks no-chase entries in the upper range", () => {
  const context = createContext({
    availableKrw: 1_000_000,
    positionQuantity: 0,
    analysis: {
      regime: "BULL_TREND",
      upperRangeChase: true,
      entryPath: "BREAKOUT_HOLD",
      breakoutHoldStructure: true,
      trendAlignmentScore: 5,
      recoveryQualityScore: 5,
      currentPrice: 100_000_000,
    },
  });

  const decision = decidePositionGuardCore(context);

  assert.equal(decision.action, "HOLD");
  assert.equal(decision.executionDisposition, "SKIPPED");
  assert.match(decision.reasons.join(" "), /too extended|not strong enough/);
});

test("position guard core creates an immediate entry from strong reclaim structure", () => {
  const context = createContext({
    availableKrw: 1_000_000,
    positionQuantity: 0,
    analysis: {
      regime: "EARLY_RECOVERY",
      entryPath: "RECLAIM",
      reclaimStructure: true,
      trendAlignmentScore: 4,
      recoveryQualityScore: 4,
      volumeRecovery: true,
      macdImproving: true,
      rsiRecovery: true,
      currentPrice: 100_000_000,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "ENTER");
  assert.equal(decision.executionDisposition, "IMMEDIATE");
  assert.ok(decision.targetNotionalKrw >= DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS.minimumTradeValueKrw);
  assert.equal(strategyDecision.action, "ENTER");
  assert.equal(strategyDecision.requestedQuantity, null);
  assert.equal(strategyDecision.metadata.sourceEngine, "PositionGuard_PaperTrade");
});

test("position guard core defers borderline entry until the previous hourly signature confirms", () => {
  const firstContext = createContext({
    generatedAt: "2026-04-20T01:05:00.000Z",
    availableKrw: 1_000_000,
    positionQuantity: 0,
    analysis: {
      regime: "RECLAIM_ATTEMPT",
      entryPath: "RECLAIM",
      reclaimStructure: true,
      trendAlignmentScore: 3,
      recoveryQualityScore: 3,
      currentPrice: 100_000_000,
    },
  });
  const firstDecision = decidePositionGuardCore(firstContext);

  const secondContext = createContext({
    generatedAt: "2026-04-20T02:05:00.000Z",
    latestDecision: {
      action: firstDecision.action,
      executionDisposition: firstDecision.executionDisposition,
      entryPath: firstDecision.diagnostics.entryPath,
      qualityBucket: firstDecision.signalQuality.bucket,
      createdAt: "2026-04-20T01:05:00.000Z",
    },
    availableKrw: 1_000_000,
    positionQuantity: 0,
    analysis: firstContext.analysis,
  });
  const secondDecision = decidePositionGuardCore(secondContext);

  assert.equal(firstDecision.action, "ENTER");
  assert.equal(firstDecision.executionDisposition, "DEFERRED_CONFIRMATION");
  assert.equal(secondDecision.action, "ENTER");
  assert.equal(secondDecision.executionDisposition, "EXECUTED_AFTER_CONFIRMATION");
});

test("position guard core reduces a profitable position on soft weakening", () => {
  const context = createContext({
    positionQuantity: 0.4,
    averageEntryPrice: 90_000_000,
    analysis: {
      regime: "RANGE",
      currentPrice: 100_000_000,
      pnlPct: 0.11,
      weakeningStage: "SOFT",
      upperRangeChase: true,
      breakdownPressureScore: 2,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "REDUCE");
  assert.equal(decision.executionDisposition, "IMMEDIATE");
  assert.ok((decision.targetQuantityFraction ?? 0) > 0);
  assert.equal(strategyDecision.action, "REDUCE");
  assert.ok((strategyDecision.requestedQuantity ?? 0) > 0);
});

test("position guard core protects profitable weak-downtrend exposure when deterioration is confirmed", () => {
  const context = createContext({
    positionQuantity: 0.35,
    averageEntryPrice: 100_000_000,
    analysis: {
      regime: "WEAK_DOWNTREND",
      invalidationState: "CLEAR",
      currentPrice: 104_000_000,
      pnlPct: 0.04,
      weakeningStage: "NONE",
      failedReclaim: false,
      bearishMomentumExpansion: true,
      atrShock: false,
      breakdownPressureScore: 1,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "REDUCE");
  assert.equal(decision.executionDisposition, "IMMEDIATE");
  assert.ok((decision.targetQuantityFraction ?? 0) >= 0.25);
  assert.ok((decision.targetQuantityFraction ?? 0) <= 0.45);
  assert.match(decision.reasons.join(" "), /Weak downtrend/);
  assert.equal(strategyDecision.action, "REDUCE");
  assert.ok((strategyDecision.requestedQuantity ?? 0) > 0);
});

test("position guard core holds losing weak-downtrend exposure even when deterioration is present", () => {
  const context = createContext({
    positionQuantity: 0.35,
    averageEntryPrice: 100_000_000,
    analysis: {
      regime: "WEAK_DOWNTREND",
      invalidationState: "CLEAR",
      currentPrice: 94_000_000,
      pnlPct: -0.06,
      weakeningStage: "NONE",
      failedReclaim: false,
      bearishMomentumExpansion: true,
      atrShock: false,
      breakdownPressureScore: 1,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "HOLD");
  assert.equal(decision.executionDisposition, "SKIPPED");
  assert.equal(decision.targetQuantityFraction, null);
  assert.equal(strategyDecision.action, "HOLD");
  assert.equal(strategyDecision.requestedQuantity, null);
});

test("position guard core holds weak-downtrend exposure without additional deterioration", () => {
  const context = createContext({
    positionQuantity: 0.35,
    averageEntryPrice: 100_000_000,
    analysis: {
      regime: "WEAK_DOWNTREND",
      invalidationState: "CLEAR",
      currentPrice: 98_500_000,
      pnlPct: -0.015,
      weakeningStage: "NONE",
      failedReclaim: false,
      bearishMomentumExpansion: false,
      atrShock: false,
      breakdownPressureScore: 0,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "HOLD");
  assert.equal(decision.executionDisposition, "SKIPPED");
  assert.equal(decision.targetQuantityFraction, null);
  assert.equal(strategyDecision.action, "HOLD");
  assert.equal(strategyDecision.requestedQuantity, null);
});

test("position guard core protects profitable breakdown-risk exposure before full invalidation", () => {
  const context = createContext({
    positionQuantity: 0.35,
    averageEntryPrice: 100_000_000,
    analysis: {
      regime: "BREAKDOWN_RISK",
      invalidationState: "CLEAR",
      currentPrice: 104_000_000,
      pnlPct: 0.04,
      weakeningStage: "SOFT",
      breakdown1d: false,
      breakdown4h: false,
      failedReclaim: true,
      bearishMomentumExpansion: false,
      atrShock: false,
      breakdownPressureScore: 2,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "REDUCE");
  assert.equal(decision.executionDisposition, "IMMEDIATE");
  assert.ok((decision.targetQuantityFraction ?? 0) >= 0.3);
  assert.ok((decision.targetQuantityFraction ?? 0) <= 0.55);
  assert.match(decision.reasons.join(" "), /Breakdown risk/);
  assert.equal(strategyDecision.action, "REDUCE");
  assert.ok((strategyDecision.requestedQuantity ?? 0) > 0);
});

test("position guard core preserves the stronger legacy reduction when defensive evidence overlaps", () => {
  const context = createContext({
    positionQuantity: 0.35,
    averageEntryPrice: 100_000_000,
    analysis: {
      regime: "BREAKDOWN_RISK",
      invalidationState: "CLEAR",
      currentPrice: 104_000_000,
      pnlPct: 0.04,
      weakeningStage: "CLEAR",
      breakdown1d: false,
      breakdown4h: false,
      failedReclaim: true,
      bearishMomentumExpansion: true,
      atrShock: true,
      breakdownPressureScore: 4,
    },
  });

  const decision = decidePositionGuardCore(context);
  const expectedReduceFraction = Math.min(
    0.75,
    DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS.reduceFraction * 1.2,
  );

  assert.equal(decision.action, "REDUCE");
  assert.equal(decision.targetQuantityFraction, expectedReduceFraction);
  assert.match(decision.reasons.join(" "), /larger staged reduction/);
});

test("position guard core holds defensive reduction when the implied order is below minimum value", () => {
  const context = createContext({
    positionQuantity: 0.00005,
    averageEntryPrice: 90_000_000,
    portfolio: {
      totalEquityKrw: 2_000_000,
      assetMarketValueKrw: 100_000,
      totalExposureKrw: 100_000,
    },
    analysis: {
      regime: "RANGE",
      invalidationState: "CLEAR",
      currentPrice: 99_000_000,
      pnlPct: 0.10,
      weakeningStage: "SOFT",
      failedReclaim: false,
      bearishMomentumExpansion: true,
      atrShock: true,
      upperRangeChase: false,
      breakdownPressureScore: 2,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "HOLD");
  assert.equal(decision.executionDisposition, "SKIPPED");
  assert.equal(decision.targetQuantityFraction, null);
  assert.equal(strategyDecision.action, "HOLD");
  assert.equal(strategyDecision.requestedQuantity, null);
});

test("position guard core allows defensive reduction exactly at minimum value despite a stale low portfolio value", () => {
  const currentPrice = 100_000_000;
  const expectedReduceFraction = DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS.reduceFraction * 0.5;
  const positionQuantity = 0.00005 / expectedReduceFraction;
  const context = createContext({
    positionQuantity,
    averageEntryPrice: 90_000_000,
    portfolio: {
      totalEquityKrw: 2_000_000,
      assetMarketValueKrw: 1_000,
      totalExposureKrw: 1_000,
    },
    analysis: {
      regime: "RANGE",
      invalidationState: "CLEAR",
      currentPrice,
      pnlPct: 0.10,
      weakeningStage: "SOFT",
      failedReclaim: false,
      bearishMomentumExpansion: true,
      atrShock: true,
      upperRangeChase: false,
      breakdownPressureScore: 2,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "REDUCE");
  assert.equal(strategyDecision.requestedQuantity, 0.00005);
  assert.equal((strategyDecision.requestedQuantity ?? 0) * currentPrice, 5_000);
});

test("position guard core protects profitable range exposure on soft momentum deterioration", () => {
  const context = createContext({
    positionQuantity: 0.35,
    averageEntryPrice: 90_000_000,
    analysis: {
      regime: "RANGE",
      invalidationState: "CLEAR",
      currentPrice: 99_000_000,
      pnlPct: 0.10,
      weakeningStage: "SOFT",
      failedReclaim: false,
      bearishMomentumExpansion: true,
      atrShock: true,
      upperRangeChase: false,
      breakdownPressureScore: 2,
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "REDUCE");
  assert.equal(decision.executionDisposition, "IMMEDIATE");
  assert.ok((decision.targetQuantityFraction ?? 0) >= 0.15);
  assert.ok((decision.targetQuantityFraction ?? 0) <= 0.28);
  assert.match(decision.reasons.join(" "), /protects open gains/);
  assert.equal(strategyDecision.action, "REDUCE");
  assert.ok((strategyDecision.requestedQuantity ?? 0) > 0);
});

test("position guard core holds a losing range position on borderline momentum weakness alone", () => {
  const context = createContext({
    positionQuantity: 0.00046145,
    averageEntryPrice: 99_852_064.85658354,
    portfolio: {
      totalEquityKrw: 2_000_000,
      assetMarketValueKrw: 43_589.4467,
      totalExposureKrw: 43_589.4467,
    },
    analysis: {
      regime: "RANGE",
      riskLevel: "ELEVATED",
      invalidationState: "CLEAR",
      invalidationLevel: 92_513_000,
      pullbackZone: true,
      currentPrice: 94_466_000,
      entryPath: "PULLBACK",
      trendAlignmentScore: 2,
      recoveryQualityScore: 0,
      breakdownPressureScore: 1,
      weakeningStage: "NONE",
      breakdown1d: false,
      breakdown4h: false,
      failedReclaim: false,
      bearishMomentumExpansion: true,
      macdImproving: false,
      atrShock: false,
      upperRangeChase: false,
      pnlPct: -0.05394044544115821,
      oneHourLocation: "MIDDLE",
      fourHourLocation: "MIDDLE",
    },
  });

  const decision = decidePositionGuardCore(context);
  const strategyDecision = toStrategyDecision(context, decision);

  assert.equal(decision.action, "HOLD");
  assert.equal(decision.executionDisposition, "SKIPPED");
  assert.equal(strategyDecision.action, "HOLD");
  assert.equal(strategyDecision.requestedQuantity, null);
});

function createContext(
  overrides: Omit<Partial<PositionGuardStrategyContext>, "analysis"> & {
    analysis?: Partial<PositionGuardStructureAnalysis>;
  } = {},
): PositionGuardStrategyContext {
  const analysis: PositionGuardStructureAnalysis = {
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
    averageEntryPrice: overrides.averageEntryPrice ?? 0,
    pnlPct: 0,
    oneHourLocation: "MIDDLE",
    fourHourLocation: "MIDDLE",
    ...overrides.analysis,
  };

  const positionQuantity = overrides.positionQuantity ?? 0;
  const totalEquityKrw = overrides.portfolio?.totalEquityKrw ?? 2_000_000;
  const assetMarketValueKrw = overrides.portfolio?.assetMarketValueKrw ?? positionQuantity * analysis.currentPrice;

  return {
    asset: overrides.asset ?? "BTC",
    market: overrides.market ?? "KRW-BTC",
    generatedAt: overrides.generatedAt ?? "2026-04-20T01:05:00.000Z",
    availableKrw: overrides.availableKrw ?? 1_000_000,
    positionQuantity,
    averageEntryPrice: overrides.averageEntryPrice ?? analysis.averageEntryPrice,
    portfolio: {
      totalEquityKrw,
      assetMarketValueKrw,
      totalExposureKrw: overrides.portfolio?.totalExposureKrw ?? assetMarketValueKrw,
    },
    latestDecision: overrides.latestDecision ?? null,
    recentExit: overrides.recentExit ?? {
      createdAt: null,
      hoursSinceExit: null,
      realizedPnl: null,
    },
    settings: overrides.settings ?? DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
    analysis,
  };
}
