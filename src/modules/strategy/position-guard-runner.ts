import {
  type OrderRecord,
  type OrderType,
  type StrategyDecision,
  type StrategyDecisionRecord,
  type SupportedMarket,
} from "../../domain/types.js";
import { createId } from "../../shared/ids.js";
import type { ExecutionRepository } from "../db/interfaces.js";
import type { ExecutionService } from "../execution/execution-service.js";
import type { SubmitOrderFromDecisionInput, SubmitOrderFromDecisionResult } from "../execution/interfaces.js";
import { analyzePositionGuardMarketStructure } from "./market-structure.js";
import {
  buildPositionGuardStrategyContext,
  loadPositionGuardStrategyContext,
} from "./position-guard-context.js";
import {
  decidePositionGuardCore,
  DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
  POSITION_GUARD_STRATEGY_KEY,
  toStrategyDecision,
  type PositionGuardEngineDecision,
  type PositionGuardStrategyContext,
  type PositionGuardStrategySettings,
} from "./position-guard-core.js";
import {
  fetchPositionGuardMarketSnapshot,
  type PositionGuardPublicMarketDataReader,
} from "./position-guard-snapshot.js";

export interface PositionGuardRunnerConfig {
  exchangeAccountId: string;
  candleCount: number;
  settings: PositionGuardStrategySettings;
}

export interface PositionGuardRunInput {
  market: SupportedMarket;
  generatedAt: string;
  candleTo?: string;
}

export interface PositionGuardRunResult {
  strategyDecisionRecord: StrategyDecisionRecord;
  strategyDecision: StrategyDecision;
  engineDecision: PositionGuardEngineDecision;
  context: PositionGuardStrategyContext;
  submission: SubmitOrderFromDecisionResult | null;
}

export class PositionGuardStrategyRunner {
  constructor(
    private readonly dependencies: {
      repositories: ExecutionRepository;
      executionService: ExecutionService;
      marketDataReader: PositionGuardPublicMarketDataReader;
      config: PositionGuardRunnerConfig;
    },
  ) {}

  async runOnce(input: PositionGuardRunInput): Promise<PositionGuardRunResult> {
    const marketSnapshot = await fetchPositionGuardMarketSnapshot(this.dependencies.marketDataReader, {
      market: input.market,
      fetchedAt: input.generatedAt,
      candleCount: this.dependencies.config.candleCount,
      ...(input.candleTo === undefined ? {} : { to: input.candleTo }),
    });
    const preliminaryAnalysis = analyzePositionGuardMarketStructure(marketSnapshot);
    const context = await loadPositionGuardStrategyContext(this.dependencies.repositories, {
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      market: input.market,
      generatedAt: input.generatedAt,
      settings: this.dependencies.config.settings,
      analysis: preliminaryAnalysis,
    });
    const engineDecision = decidePositionGuardCore(context);
    const strategyDecision = toStrategyDecision(context, engineDecision);
    const strategyDecisionRecord = createStrategyDecisionRecord({
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      generatedAt: input.generatedAt,
      strategyDecision,
      engineDecision,
      context,
    });

    await this.dependencies.repositories.saveStrategyDecision(strategyDecisionRecord);

    const orderInput = toOrderSubmissionInput({
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      strategyDecisionId: strategyDecisionRecord.id,
      decision: strategyDecision,
    });
    const submission = orderInput === null
      ? null
      : await this.dependencies.executionService.submitOrderFromDecision(orderInput);

    return {
      strategyDecisionRecord,
      strategyDecision,
      engineDecision,
      context,
      submission,
    };
  }
}

export function createStrategyDecisionRecord(input: {
  exchangeAccountId: string;
  generatedAt: string;
  strategyDecision: StrategyDecision;
  engineDecision: PositionGuardEngineDecision;
  context: PositionGuardStrategyContext;
}): StrategyDecisionRecord {
  return {
    id: createId("strategy_decision"),
    exchangeAccountId: input.exchangeAccountId,
    strategyKey: input.strategyDecision.strategyKey,
    market: input.strategyDecision.market,
    action: input.strategyDecision.action,
    status: input.strategyDecision.action === "HOLD" ? "NO_ACTION" : "READY",
    decisionBasisJson: JSON.stringify({
      strategyDecision: input.strategyDecision,
      engineDecision: input.engineDecision,
      context: {
        asset: input.context.asset,
        market: input.context.market,
        generatedAt: input.context.generatedAt,
        positionQuantity: input.context.positionQuantity,
        averageEntryPrice: input.context.averageEntryPrice,
        portfolio: input.context.portfolio,
        latestDecision: input.context.latestDecision,
        recentExit: input.context.recentExit,
        settings: input.context.settings,
        analysis: input.context.analysis,
      },
      metadata: input.strategyDecision.metadata,
    }),
    intendedNotionalKrw: input.strategyDecision.requestedNotionalKrw === null
      ? null
      : String(input.strategyDecision.requestedNotionalKrw),
    intendedQuantity: input.strategyDecision.requestedQuantity === null
      ? null
      : String(input.strategyDecision.requestedQuantity),
    referencePrice: String(input.strategyDecision.referencePrice),
    createdAt: input.generatedAt,
  };
}

export function toOrderSubmissionInput(input: {
  exchangeAccountId: string;
  strategyDecisionId: string;
  decision: StrategyDecision;
}): SubmitOrderFromDecisionInput | null {
  switch (input.decision.action) {
    case "ENTER":
    case "ADD": {
      if (input.decision.requestedNotionalKrw === null || input.decision.requestedNotionalKrw <= 0) {
        return null;
      }

      return {
        exchangeAccountId: input.exchangeAccountId,
        strategyDecisionId: input.strategyDecisionId,
        decision: input.decision,
        side: "bid",
        ordType: "price",
        price: formatDecimal(input.decision.requestedNotionalKrw),
        volume: null,
      };
    }
    case "REDUCE":
    case "EXIT": {
      if (input.decision.requestedQuantity === null || input.decision.requestedQuantity <= 0) {
        return null;
      }

      return {
        exchangeAccountId: input.exchangeAccountId,
        strategyDecisionId: input.strategyDecisionId,
        decision: input.decision,
        side: "ask",
        ordType: "market",
        price: null,
        volume: formatDecimal(input.decision.requestedQuantity),
      };
    }
    case "HOLD":
      return null;
  }
}

export function createDefaultPositionGuardRunnerConfig(
  exchangeAccountId: string,
): PositionGuardRunnerConfig {
  return {
    exchangeAccountId,
    candleCount: 200,
    settings: DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
  };
}

function formatDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(12).replace(/0+$/u, "").replace(/\.$/u, "");
}
