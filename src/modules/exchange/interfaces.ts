import type {
  ExchangeBalance,
  OrderSide,
  OrderType,
  SupportedMarket,
  TimeInForce,
  UpbitSelfMatchPrevention,
} from "../../domain/types.js";
import { createId } from "../../shared/ids.js";

export interface UpbitOrderRequest {
  market: SupportedMarket;
  side: OrderSide;
  ordType: OrderType;
  volume: string | null;
  price: string | null;
  identifier: string;
  timeInForce: TimeInForce | null;
  smpType: UpbitSelfMatchPrevention | null;
}

export interface UpbitOrderChance {
  marketId: string;
  askTypes: string[];
  bidTypes: string[];
  maxTotal: string | null;
  bidMinTotal: number | null;
  askMinTotal: number | null;
  bidFee: string;
  askFee: string;
}

export interface ExchangeFillSnapshot {
  tradeUuid: string | null;
  side: OrderSide;
  price: string;
  volume: string;
  funds: string | null;
  fee: string | null;
  createdAt: string | null;
  raw: unknown;
}

export interface ExchangeOrderSnapshot {
  uuid: string;
  identifier: string | null;
  market: SupportedMarket;
  side: OrderSide;
  ordType: OrderType;
  state: string;
  price: string | null;
  volume: string | null;
  remainingVolume: string | null;
  executedVolume: string | null;
  paidFee: string | null;
  createdAt: string;
  fills: ExchangeFillSnapshot[];
  raw: unknown;
}

export interface OrderValidationResult {
  accepted: boolean;
  marketOnline: boolean;
  reason: string | null;
  preview: ExchangeOrderSnapshot | null;
}

export interface CancelOrderResult {
  accepted: boolean;
  canceledOrder: ExchangeOrderSnapshot | null;
  reason: string | null;
}

export interface ExchangeAdapter {
  getBalances(): Promise<ExchangeBalance[]>;
  getOrderChance(market: SupportedMarket): Promise<UpbitOrderChance>;
  testOrder(request: UpbitOrderRequest): Promise<OrderValidationResult>;
  createOrder(request: UpbitOrderRequest): Promise<ExchangeOrderSnapshot>;
  cancelOrder(query: { uuid?: string; identifier?: string }): Promise<CancelOrderResult>;
  getOrder(query: { uuid?: string; identifier?: string }): Promise<ExchangeOrderSnapshot | null>;
}

export class DryRunExchangeAdapter implements ExchangeAdapter {
  async getBalances(): Promise<ExchangeBalance[]> {
    return [
      { currency: "KRW", balance: "0", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
      { currency: "BTC", balance: "0", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
      { currency: "ETH", balance: "0", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
    ];
  }

  async getOrderChance(market: SupportedMarket): Promise<UpbitOrderChance> {
    return {
      marketId: market,
      askTypes: ["limit", "market", "best", "limit_ioc", "limit_fok", "best_ioc", "best_fok"],
      bidTypes: ["limit", "price", "best", "limit_ioc", "limit_fok", "best_ioc", "best_fok"],
      maxTotal: null,
      bidMinTotal: 5000,
      askMinTotal: 5000,
      bidFee: "0",
      askFee: "0",
    };
  }

  async testOrder(request: UpbitOrderRequest): Promise<OrderValidationResult> {
    return {
      accepted: true,
      marketOnline: true,
      reason: null,
      preview: buildDryRunSnapshot(request, "wait"),
    };
  }

  async createOrder(request: UpbitOrderRequest): Promise<ExchangeOrderSnapshot> {
    return buildDryRunSnapshot(request, "wait");
  }

  async cancelOrder(query: { uuid?: string; identifier?: string }): Promise<CancelOrderResult> {
    if (!query.uuid && !query.identifier) {
      return {
        accepted: false,
        canceledOrder: null,
        reason: "Either uuid or identifier is required.",
      };
    }

    return {
      accepted: true,
      canceledOrder: {
        uuid: query.uuid ?? createId("dryrun_cancel"),
        identifier: query.identifier ?? null,
        market: "KRW-BTC",
        side: "bid",
        ordType: "limit",
        state: "cancel",
    price: null,
    volume: null,
    remainingVolume: null,
    executedVolume: null,
    paidFee: null,
    createdAt: new Date().toISOString(),
    fills: [],
    raw: { mode: "DRY_RUN" },
  },
  reason: null,
};
  }

  async getOrder(query: { uuid?: string; identifier?: string }): Promise<ExchangeOrderSnapshot | null> {
    if (!query.uuid && !query.identifier) {
      return null;
    }

    return {
      uuid: query.uuid ?? createId("dryrun_order"),
      identifier: query.identifier ?? null,
      market: "KRW-BTC",
      side: "bid",
      ordType: "limit",
      state: "wait",
      price: "0",
      volume: "0",
      remainingVolume: "0",
      executedVolume: "0",
      paidFee: "0",
      createdAt: new Date().toISOString(),
      fills: [],
      raw: { mode: "DRY_RUN" },
    };
  }
}

function buildDryRunSnapshot(request: UpbitOrderRequest, state: string): ExchangeOrderSnapshot {
  return {
    uuid: createId("dryrun_order"),
    identifier: request.identifier,
    market: request.market,
    side: request.side,
    ordType: request.ordType,
    state,
    price: request.price,
    volume: request.volume,
    remainingVolume: request.volume,
    executedVolume: "0",
    paidFee: "0",
    createdAt: new Date().toISOString(),
    fills: [],
    raw: {
      mode: "DRY_RUN",
      request,
    },
  };
}
