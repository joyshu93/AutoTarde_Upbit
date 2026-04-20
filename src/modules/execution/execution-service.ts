import type {
  ExecutionPolicy,
  OrderRecord,
  RiskEventRecord,
  StrategyDecision,
} from "../../domain/types.js";
import { createId } from "../../shared/ids.js";
import type { ExecutionRepository, OperatorStateStore } from "../db/interfaces.js";
import type { ExchangeAdapter } from "../exchange/interfaces.js";
import { evaluateRiskGuards } from "../risk/guards.js";
import { buildOrderIdentifier, buildOrderIdempotencyKey } from "./idempotency.js";
import type { SubmitOrderFromDecisionInput, SubmitOrderFromDecisionResult } from "./interfaces.js";

export class ExecutionService {
  constructor(
    private readonly dependencies: {
      policy: ExecutionPolicy;
      exchangeAdapter: ExchangeAdapter;
      repositories: ExecutionRepository;
      operatorState: OperatorStateStore;
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
    const openOrders = await this.dependencies.repositories.listActiveOrders(input.exchangeAccountId, market);
    const portfolio = await this.dependencies.repositories.getPortfolioExposure(input.exchangeAccountId);

    const requestedNotionalKrw =
      typeof decision.requestedNotionalKrw === "number"
        ? decision.requestedNotionalKrw
        : input.price
          ? Number(input.price)
          : null;

    const requestedQuantity =
      typeof decision.requestedQuantity === "number"
        ? decision.requestedQuantity
        : input.volume
          ? Number(input.volume)
          : null;

    const risk = evaluateRiskGuards({
      policy: this.dependencies.policy,
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

      return {
        accepted: false,
        order: null,
        reason: risk.triggeredRules.map((rule) => rule.message).join("; "),
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
      identifier: buildOrderIdentifier({
        market,
        side: input.side,
        strategyDecisionId: input.strategyDecisionId,
        requestedAt,
      }),
      idempotencyKey,
      origin: input.origin ?? "STRATEGY",
      requestedAt,
      upbitUuid: null,
      status: "PERSISTED",
      executionMode: this.dependencies.policy.executionMode,
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

      return {
        accepted: false,
        order: failedOrder,
        reason: failedOrder.failureMessage,
      };
    }
  }
}

function createRiskEvent(
  exchangeAccountId: string,
  strategyDecisionId: string | null,
  ruleCode: RiskEventRecord["ruleCode"],
  message: string,
): RiskEventRecord {
  return {
    id: createId("risk_event"),
    exchangeAccountId,
    strategyDecisionId,
    orderId: null,
    level: "BLOCK",
    ruleCode,
    message,
    payloadJson: JSON.stringify({}),
    createdAt: new Date().toISOString(),
  };
}
