import type { ExchangeBalance, SupportedMarket } from "../../../domain/types.js";
import type {
  CancelOrderResult,
  ExchangeAdapter,
  ExchangeOrderSnapshot,
  OrderValidationResult,
  UpbitOrderChance,
  UpbitOrderRequest,
} from "../interfaces.js";
import { buildUpbitJwtToken, buildUpbitQueryString, type UpbitCredentials } from "./auth.js";

interface UpbitPrivateClientOptions extends UpbitCredentials {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface UpbitOrderChanceResponse {
  bid_fee: string;
  ask_fee: string;
  market: {
    id: string;
    ask_types?: string[];
    bid_types?: string[];
    max_total?: string | null;
  };
}

interface UpbitOrderResponse {
  uuid: string;
  identifier?: string;
  market: SupportedMarket;
  side: "bid" | "ask";
  ord_type: "limit" | "price" | "market" | "best";
  state: string;
  price?: string | null;
  volume?: string | null;
  remaining_volume?: string | null;
  executed_volume?: string | null;
  paid_fee?: string | null;
  created_at: string;
  trades?: Array<{
    uuid?: string;
    side?: "bid" | "ask";
    price: string;
    volume: string;
    funds?: string | null;
    fee?: string | null;
    created_at?: string | null;
  }>;
}

interface UpbitBalanceResponse {
  currency: string;
  balance: string;
  locked: string;
  avg_buy_price: string;
  unit_currency: string;
}

const DEFAULT_BASE_URL = "https://api.upbit.com";

export class UpbitPrivateClient implements ExchangeAdapter {
  private readonly credentials: UpbitCredentials;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: UpbitPrivateClientOptions) {
    this.credentials = {
      accessKey: options.accessKey,
      secretKey: options.secretKey,
    };
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getBalances(): Promise<ExchangeBalance[]> {
    const response = await this.requestJson<UpbitBalanceResponse[]>({
      method: "GET",
      path: "/v1/accounts",
    });

    return response.map((balance) => ({
      currency: balance.currency,
      balance: balance.balance,
      locked: balance.locked,
      avgBuyPrice: balance.avg_buy_price,
      unitCurrency: balance.unit_currency,
    }));
  }

  async getOrderChance(market: SupportedMarket): Promise<UpbitOrderChance> {
    const response = await this.requestJson<UpbitOrderChanceResponse>({
      method: "GET",
      path: "/v1/orders/chance",
      query: { market },
    });

    return {
      marketId: response.market.id,
      askTypes: response.market.ask_types ?? [],
      bidTypes: response.market.bid_types ?? [],
      maxTotal: response.market.max_total ?? null,
      bidFee: response.bid_fee,
      askFee: response.ask_fee,
    };
  }

  async testOrder(request: UpbitOrderRequest): Promise<OrderValidationResult> {
    const response = await this.requestJson<UpbitOrderResponse>({
      method: "POST",
      path: "/v1/orders/test",
      body: mapOrderRequest(request),
    });

    return {
      accepted: true,
      marketOnline: true,
      reason: null,
      preview: mapOrderResponse(response),
    };
  }

  async createOrder(request: UpbitOrderRequest): Promise<ExchangeOrderSnapshot> {
    const response = await this.requestJson<UpbitOrderResponse>({
      method: "POST",
      path: "/v1/orders",
      body: mapOrderRequest(request),
    });

    return mapOrderResponse(response);
  }

  async cancelOrder(query: { uuid?: string; identifier?: string }): Promise<CancelOrderResult> {
    const response = await this.requestJson<UpbitOrderResponse>({
      method: "DELETE",
      path: "/v1/order",
      query,
    });

    return {
      accepted: true,
      canceledOrder: mapOrderResponse(response),
      reason: null,
    };
  }

  async getOrder(query: { uuid?: string; identifier?: string }): Promise<ExchangeOrderSnapshot | null> {
    if (!query.uuid && !query.identifier) {
      return null;
    }

    const response = await this.requestJson<UpbitOrderResponse>({
      method: "GET",
      path: "/v1/order",
      query,
    });

    return mapOrderResponse(response);
  }

  private async requestJson<T>(options: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: Record<string, string | number | boolean | null | undefined>;
  }): Promise<T> {
    const queryString = options.query ? buildUpbitQueryString(options.query) : "";
    const bodyQueryString = options.body ? buildUpbitQueryString(options.body) : "";
    const authPayload = bodyQueryString || queryString || undefined;
    const token = buildUpbitJwtToken(this.credentials, authPayload);
    const suffix = queryString ? `?${queryString}` : "";

    const requestInit: RequestInit = {
      method: options.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    };

    const response = await this.fetchImpl(`${this.baseUrl}${options.path}${suffix}`, requestInit);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Upbit private request failed (${response.status} ${response.statusText}): ${body}`);
    }

    return (await response.json()) as T;
  }
}

function mapOrderRequest(request: UpbitOrderRequest): Record<string, string> {
  return {
    market: request.market,
    side: request.side,
    ord_type: request.ordType,
    ...(request.volume ? { volume: request.volume } : {}),
    ...(request.price ? { price: request.price } : {}),
    ...(request.identifier ? { identifier: request.identifier } : {}),
    ...(request.timeInForce ? { time_in_force: request.timeInForce } : {}),
    ...(request.smpType ? { smp_type: request.smpType } : {}),
  };
}

function mapOrderResponse(response: UpbitOrderResponse): ExchangeOrderSnapshot {
  return {
    uuid: response.uuid,
    identifier: response.identifier ?? null,
    market: response.market,
    side: response.side,
    ordType: response.ord_type,
    state: response.state,
    price: response.price ?? null,
    volume: response.volume ?? null,
    remainingVolume: response.remaining_volume ?? null,
    executedVolume: response.executed_volume ?? null,
    paidFee: response.paid_fee ?? null,
    createdAt: response.created_at,
    fills: (response.trades ?? []).map((trade) => ({
      tradeUuid: trade.uuid ?? null,
      side: trade.side ?? response.side,
      price: trade.price,
      volume: trade.volume,
      funds: trade.funds ?? null,
      fee: trade.fee ?? null,
      createdAt: trade.created_at ?? null,
      raw: trade,
    })),
    raw: response,
  };
}
