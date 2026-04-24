import type {
  ExecutionRiskLimits,
  ExecutionStateRecord,
  ExecutionPolicy,
  RiskRuleCode,
  OrderRecord,
  RiskEventRecord,
  StrategyDecision,
  TimeInForce,
} from "../../domain/types.js";
import { createId } from "../../shared/ids.js";
import type { ExecutionRepository, OperatorStateStore } from "../db/interfaces.js";
import type { ExchangeAdapter, UpbitOrderChance } from "../exchange/interfaces.js";
import { evaluateRiskGuards } from "../risk/guards.js";
import type { OperatorNotificationReporter } from "../telegram/reporter.js";
import { buildOrderIdentifier, buildOrderIdempotencyKey } from "./idempotency.js";
import type { SubmitOrderFromDecisionInput, SubmitOrderFromDecisionResult } from "./interfaces.js";

export class ExecutionService {
  constructor(
    private readonly dependencies: {
      riskLimits: ExecutionRiskLimits;
      exchangeAdapter: ExchangeAdapter;
      validationAdapter?: Pick<ExchangeAdapter, "getOrderChance" | "testOrder">;
      repositories: ExecutionRepository;
      operatorState: OperatorStateStore;
      reporter?: OperatorNotificationReporter;
    },
  ) {}

  async submitOrderFromDecision(input: SubmitOrderFromDecisionInput): Promise<SubmitOrderFromDecisionResult> {
    const requestedAt = new Date().toISOString();
    const decision = input.decision;
    const market = input.market ?? decision.market;
    const idempotencyKey = buildOrderIdempotencyKey({
      exchangeAccountId: input.exchangeAccountId,
      strategyDecisionId: input.strategyDecisionId,
      market,
      side: input.side,
      ordType: input.ordType,
      price: input.price,
      volume: input.volume,
    });

    const duplicate = await this.dependencies.repositories.findOrderByIdempotencyKey(
      input.exchangeAccountId,
      idempotencyKey,
    );
    if (duplicate) {
      return {
        accepted: false,
        order: duplicate,
        reason: "Duplicate order intent already exists for the same idempotency key.",
      };
    }

    const state = await this.dependencies.operatorState.getState();
    const policy = composeExecutionPolicy(state, this.dependencies.riskLimits);
    const openOrders = await this.dependencies.repositories.listActiveOrders(input.exchangeAccountId, market);
    const portfolio = await this.dependencies.repositories.getPortfolioExposure(input.exchangeAccountId);

    const requestedNotionalKrw =
      typeof decision.requestedNotionalKrw === "number"
        ? decision.requestedNotionalKrw
        : deriveRequestedNotionalKrw(input.price, input.volume);

    const requestedQuantity =
      typeof decision.requestedQuantity === "number"
        ? decision.requestedQuantity
        : input.volume
          ? Number(input.volume)
          : null;
    const identifier = buildOrderIdentifier({
      market,
      side: input.side,
      strategyDecisionId: input.strategyDecisionId,
      requestedAt,
    });

    const risk = evaluateRiskGuards({
      policy,
      systemStatus: state.systemStatus,
      market,
      priceSnapshot: {
        market,
        tradePrice: decision.referencePrice,
        capturedAt: requestedAt,
      },
      portfolio,
      openOrders,
      requestedSide: input.side,
      requestedIdempotencyKey: idempotencyKey,
      requestedPrice: input.price,
      requestedVolume: input.volume,
      requestedNotionalKrw,
      requestedQuantity,
      now: requestedAt,
    });

    if (!risk.accepted) {
      await Promise.all(
        risk.triggeredRules.map((rule) =>
          this.dependencies.repositories.saveRiskEvent(createRiskEvent(input.exchangeAccountId, input.strategyDecisionId, rule.code, rule.message)),
        ),
      );
      await this.safeReport({
        exchangeAccountId: input.exchangeAccountId,
        notificationType: "ORDER_REJECTED",
        severity: "WARN",
        title: "Order blocked by local risk policy",
        message: risk.triggeredRules.map((rule) => rule.message).join("; "),
        payload: {
          strategyDecisionId: input.strategyDecisionId,
          market,
          side: input.side,
          ordType: input.ordType,
          reasonCodes: risk.triggeredRules.map((rule) => rule.code),
        },
      });

      return {
        accepted: false,
        order: null,
        reason: risk.triggeredRules.map((rule) => rule.message).join("; "),
      };
    }

    const preTradeValidation = await this.runExchangePreTradeValidation({
      exchangeAccountId: input.exchangeAccountId,
      strategyDecisionId: input.strategyDecisionId,
      market,
      side: input.side,
      ordType: input.ordType,
      price: input.price,
      volume: input.volume,
      requestedAt,
      requestedNotionalKrw,
      identifier,
      idempotencyKey,
    });

    if (!preTradeValidation.accepted) {
      await this.dependencies.repositories.saveRiskEvent(
        createRiskEvent(
          input.exchangeAccountId,
          input.strategyDecisionId,
          preTradeValidation.ruleCode,
          preTradeValidation.message,
          preTradeValidation.payload,
        ),
      );
      await this.safeReport({
        exchangeAccountId: input.exchangeAccountId,
        notificationType: "ORDER_REJECTED",
        severity: "WARN",
        title: "Order rejected before submission",
        message: preTradeValidation.message,
        payload: {
          strategyDecisionId: input.strategyDecisionId,
          market,
          side: input.side,
          ordType: input.ordType,
          identifier,
          idempotencyKey,
          ruleCode: preTradeValidation.ruleCode,
        },
      });

      return {
        accepted: false,
        order: null,
        reason: preTradeValidation.message,
      };
    }

    const order: OrderRecord = {
      id: createId("order"),
      strategyDecisionId: input.strategyDecisionId,
      exchangeAccountId: input.exchangeAccountId,
      market,
      side: input.side,
      ordType: input.ordType,
      volume: input.volume,
      price: input.price,
      timeInForce: null,
      smpType: null,
      identifier,
      idempotencyKey,
      origin: input.origin ?? "STRATEGY",
      requestedAt,
      upbitUuid: null,
      status: "PERSISTED",
      executionMode: state.executionMode,
      exchangeResponseJson: null,
      failureCode: null,
      failureMessage: null,
      createdAt: requestedAt,
      updatedAt: requestedAt,
    };

    await this.dependencies.repositories.saveOrder(order);
    await this.dependencies.repositories.appendOrderEvent({
      id: createId("order_event"),
      orderId: order.id,
      eventType: "ORDER_PERSISTED",
      eventSource: "LOCAL",
      payloadJson: JSON.stringify({
        idempotencyKey,
        decisionAction: decision.action,
      }),
      createdAt: requestedAt,
    });

    try {
      const exchangeOrder = await this.dependencies.exchangeAdapter.createOrder({
        market,
        side: input.side,
        ordType: input.ordType,
        volume: input.volume,
        price: input.price,
        identifier: order.identifier,
        timeInForce: null,
        smpType: null,
      });

      const updatedOrder: OrderRecord = {
        ...order,
        upbitUuid: exchangeOrder.uuid,
        status: exchangeOrder.executedVolume && Number(exchangeOrder.executedVolume) > 0 ? "PARTIALLY_FILLED" : "OPEN",
        exchangeResponseJson: JSON.stringify(exchangeOrder.raw),
        updatedAt: new Date().toISOString(),
      };

      await this.dependencies.repositories.updateOrder(updatedOrder);
      await this.dependencies.repositories.appendOrderEvent({
        id: createId("order_event"),
        orderId: order.id,
        eventType: "ORDER_SUBMITTED",
        eventSource: "EXCHANGE",
        payloadJson: JSON.stringify(exchangeOrder.raw),
        createdAt: updatedOrder.updatedAt,
      });

      for (const fill of exchangeOrder.fills) {
        await this.dependencies.repositories.saveFill({
          id: createId("fill"),
          orderId: order.id,
          exchangeFillId: fill.tradeUuid ?? createId("exchange_fill"),
          market,
          side: fill.side,
          price: fill.price,
          volume: fill.volume,
          feeCurrency: "KRW",
          feeAmount: fill.fee,
          filledAt: fill.createdAt ?? updatedOrder.updatedAt,
          rawPayloadJson: JSON.stringify(fill.raw),
        });
      }

      return {
        accepted: true,
        order: updatedOrder,
        reason: null,
      };
    } catch (error) {
      const failedOrder: OrderRecord = {
        ...order,
        status: "FAILED",
        failureCode: "EXCHANGE_SUBMISSION_FAILED",
        failureMessage: error instanceof Error ? error.message : "Unknown exchange submission failure.",
        updatedAt: new Date().toISOString(),
      };

      await this.dependencies.repositories.updateOrder(failedOrder);
      await this.dependencies.repositories.appendOrderEvent({
        id: createId("order_event"),
        orderId: order.id,
        eventType: "ORDER_SUBMISSION_FAILED",
        eventSource: "LOCAL",
        payloadJson: JSON.stringify({
          message: failedOrder.failureMessage,
        }),
        createdAt: failedOrder.updatedAt,
      });
      await this.safeReport({
        exchangeAccountId: input.exchangeAccountId,
        notificationType: "ORDER_SUBMISSION_FAILED",
        severity: "ERROR",
        title: "Order submission failed",
        message: failedOrder.failureMessage ?? "Unknown exchange submission failure.",
        payload: {
          orderId: failedOrder.id,
          strategyDecisionId: failedOrder.strategyDecisionId,
          market: failedOrder.market,
          side: failedOrder.side,
          ordType: failedOrder.ordType,
          identifier: failedOrder.identifier,
        },
      });

      return {
        accepted: false,
        order: failedOrder,
        reason: failedOrder.failureMessage,
      };
    }
  }

  private async runExchangePreTradeValidation(input: {
    exchangeAccountId: string;
    strategyDecisionId: string | null;
    market: SubmitOrderFromDecisionInput["decision"]["market"];
    side: SubmitOrderFromDecisionInput["side"];
    ordType: SubmitOrderFromDecisionInput["ordType"];
    price: SubmitOrderFromDecisionInput["price"];
    volume: SubmitOrderFromDecisionInput["volume"];
    requestedAt: string;
    requestedNotionalKrw: number | null;
    identifier: string;
    idempotencyKey: string;
  }): Promise<
    | {
        accepted: true;
      }
    | {
        accepted: false;
        ruleCode: RiskRuleCode;
        message: string;
        payload: Record<string, unknown>;
      }
  > {
    const validator = this.dependencies.validationAdapter ?? this.dependencies.exchangeAdapter;
    const basePayload = {
      exchangeAccountId: input.exchangeAccountId,
      strategyDecisionId: input.strategyDecisionId,
      market: input.market,
      side: input.side,
      ordType: input.ordType,
      identifier: input.identifier,
      idempotencyKey: input.idempotencyKey,
      requestedAt: input.requestedAt,
      requestedNotionalKrw: input.requestedNotionalKrw,
      price: input.price,
      volume: input.volume,
    };

    let chance: UpbitOrderChance;
    try {
      chance = await validator.getOrderChance(input.market);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown order chance failure.";
      return {
        accepted: false,
        ruleCode: "EXCHANGE_ORDER_CHANCE_FAILED",
        message: `Exchange order chance precheck failed: ${message}`,
        payload: {
          ...basePayload,
          stage: "getOrderChance",
          reason: message,
        },
      };
    }

    if (chance.marketId !== input.market) {
      return {
        accepted: false,
        ruleCode: "UNSUPPORTED_MARKET",
        message: `Exchange order chance returned mismatched market ${chance.marketId} for ${input.market}.`,
        payload: {
          ...basePayload,
          stage: "getOrderChance",
          requestedMarket: input.market,
          responseMarket: chance.marketId,
        },
      };
    }

    const supportedTypes = input.side === "bid" ? chance.bidTypes : chance.askTypes;
    const requiredType = resolveChanceTypeToken(input.ordType, null);
    if (!supportedTypes.includes(requiredType)) {
      return {
        accepted: false,
        ruleCode: "UNSUPPORTED_ORDER_TYPE",
        message: `Exchange order chance does not allow ${requiredType} orders for ${input.side} on ${input.market}.`,
        payload: {
          ...basePayload,
          stage: "getOrderChance",
          supportedTypes,
          requiredType,
        },
      };
    }

    const exchangeMinTotal = input.side === "bid" ? chance.bidMinTotal : chance.askMinTotal;
    if (
      typeof input.requestedNotionalKrw === "number" &&
      typeof exchangeMinTotal === "number" &&
      Number.isFinite(exchangeMinTotal) &&
      input.requestedNotionalKrw < exchangeMinTotal
    ) {
      return {
        accepted: false,
        ruleCode: "EXCHANGE_MIN_TOTAL_GUARD",
        message: `Requested order value is below exchange min total ${exchangeMinTotal} KRW for ${input.market}.`,
        payload: {
          ...basePayload,
          stage: "getOrderChance",
          requestedNotionalKrw: input.requestedNotionalKrw,
          exchangeMinTotal,
        },
      };
    }

    const exchangeMaxTotal = chance.maxTotal === null ? null : Number(chance.maxTotal);
    if (
      typeof input.requestedNotionalKrw === "number" &&
      typeof exchangeMaxTotal === "number" &&
      Number.isFinite(exchangeMaxTotal) &&
      input.requestedNotionalKrw > exchangeMaxTotal
    ) {
      return {
        accepted: false,
        ruleCode: "EXCHANGE_MAX_TOTAL_GUARD",
        message: `Requested order value exceeds exchange max total ${exchangeMaxTotal} KRW for ${input.market}.`,
        payload: {
          ...basePayload,
          stage: "getOrderChance",
          requestedNotionalKrw: input.requestedNotionalKrw,
          exchangeMaxTotal,
        },
      };
    }

    try {
      const validation = await validator.testOrder({
        market: input.market,
        side: input.side,
        ordType: input.ordType,
        volume: input.volume,
        price: input.price,
        identifier: input.identifier,
        timeInForce: null,
        smpType: null,
      });

      if (!validation.accepted) {
        return {
          accepted: false,
          ruleCode: validation.marketOnline ? "EXCHANGE_ORDER_TEST_FAILED" : "MARKET_OFFLINE",
          message: validation.reason ?? "Exchange order test rejected the request.",
          payload: {
            ...basePayload,
            stage: "testOrder",
            marketOnline: validation.marketOnline,
            reason: validation.reason,
            preview: validation.preview,
          },
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown order test failure.";
      return {
        accepted: false,
        ruleCode: /market_offline/iu.test(message) ? "MARKET_OFFLINE" : "EXCHANGE_ORDER_TEST_FAILED",
        message: `Exchange order test failed: ${message}`,
        payload: {
          ...basePayload,
          stage: "testOrder",
          reason: message,
        },
      };
    }

    return {
      accepted: true,
    };
  }

  private async safeReport(input: {
    exchangeAccountId: string;
    notificationType: "ORDER_REJECTED" | "ORDER_SUBMISSION_FAILED";
    severity: "WARN" | "ERROR";
    title: string;
    message: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    if (!this.dependencies.reporter) {
      return;
    }

    try {
      await this.dependencies.reporter.report(input);
    } catch {
      // Reporting is best-effort and must not change execution outcomes.
    }
  }
}

function composeExecutionPolicy(
  state: ExecutionStateRecord,
  riskLimits: ExecutionRiskLimits,
): ExecutionPolicy {
  return {
    executionMode: state.executionMode,
    liveExecutionGate: state.liveExecutionGate,
    globalKillSwitch: state.killSwitchActive,
    maxAllocationByAsset: riskLimits.maxAllocationByAsset,
    totalExposureCap: riskLimits.totalExposureCap,
    stalePriceThresholdMs: riskLimits.stalePriceThresholdMs,
    minimumOrderValueKrw: riskLimits.minimumOrderValueKrw,
  };
}

function createRiskEvent(
  exchangeAccountId: string,
  strategyDecisionId: string | null,
  ruleCode: RiskEventRecord["ruleCode"],
  message: string,
  payload: Record<string, unknown> = {},
): RiskEventRecord {
  return {
    id: createId("risk_event"),
    exchangeAccountId,
    strategyDecisionId,
    orderId: null,
    level: "BLOCK",
    ruleCode,
    message,
    payloadJson: JSON.stringify(payload),
    createdAt: new Date().toISOString(),
  };
}

function deriveRequestedNotionalKrw(price: string | null, volume: string | null): number | null {
  if (price && volume) {
    const priceNumber = Number(price);
    const volumeNumber = Number(volume);
    if (Number.isFinite(priceNumber) && Number.isFinite(volumeNumber)) {
      return priceNumber * volumeNumber;
    }
  }

  if (price) {
    const priceNumber = Number(price);
    return Number.isFinite(priceNumber) ? priceNumber : null;
  }

  return null;
}

function resolveChanceTypeToken(
  ordType: SubmitOrderFromDecisionInput["ordType"],
  timeInForce: TimeInForce | null,
): string {
  if (!timeInForce) {
    return ordType;
  }

  return `${ordType}_${timeInForce}`;
}
