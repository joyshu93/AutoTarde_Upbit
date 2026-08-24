import type {
  ExchangeBalance,
  SupportedMarket,
  TimeInForce,
  UpbitSelfMatchPrevention,
} from "../../../domain/types.js";
import { ExchangeOrderLookupError, ExchangeOrderSubmissionError } from "../errors.js";
import type {
  CancelOrderResult,
  ExchangeOrderHistoryQuery,
  ExchangeOrderSnapshot,
  LiveExecutionAdapter,
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
    bid?: {
      min_total?: string | number | null;
    };
    ask?: {
      min_total?: string | number | null;
    };
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
  time_in_force?: TimeInForce | null;
  smp_type?: UpbitSelfMatchPrevention | null;
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

export class UpbitPrivateClient implements LiveExecutionAdapter {
  readonly sendPath = "LIVE_ADAPTER" as const;

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
      bidMinTotal: parseOptionalNumber(response.market.bid?.min_total),
      askMinTotal: parseOptionalNumber(response.market.ask?.min_total),
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
    let response: Response;
    try {
      response = await this.dispatch({
        method: "POST",
        path: "/v1/orders",
        body: mapOrderRequest(request),
      });
    } catch {
      throw new ExchangeOrderSubmissionError({
        kind: "UNCERTAIN",
        status: null,
        exchangeCode: null,
        exchangeName: null,
        responseReceived: false,
      });
    }

    if (!response.ok) {
      const exchangeError = await readUpbitErrorMetadata(response, this.credentials);
      throw new ExchangeOrderSubmissionError({
        kind: isDefinitiveOrderRejection(response.status) ? "DEFINITIVE_REJECTION" : "UNCERTAIN",
        status: response.status,
        exchangeCode: exchangeError.code,
        exchangeName: exchangeError.name,
        responseReceived: true,
      });
    }

    let orderResponse: unknown;
    try {
      orderResponse = await response.json();
    } catch {
      throw new ExchangeOrderSubmissionError({
        kind: "UNCERTAIN",
        status: response.status,
        exchangeCode: null,
        exchangeName: null,
        responseReceived: true,
      });
    }

    if (!isValidOrderSubmissionResponse(orderResponse)) {
      throw new ExchangeOrderSubmissionError({
        kind: "UNCERTAIN",
        status: response.status,
        exchangeCode: null,
        exchangeName: null,
        responseReceived: true,
      });
    }

    try {
      return mapOrderResponse(orderResponse);
    } catch {
      throw new ExchangeOrderSubmissionError({
        kind: "UNCERTAIN",
        status: response.status,
        exchangeCode: null,
        exchangeName: null,
        responseReceived: true,
      });
    }
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

    try {
      const response = await this.requestJson<UpbitOrderResponse>({
        method: "GET",
        path: "/v1/order",
        query,
      });

      return mapOrderResponse(response);
    } catch (error) {
      if (error instanceof UpbitPrivateRequestError && error.status === 404) {
        return null;
      }

      throw new ExchangeOrderLookupError({
        kind: error instanceof UpbitPrivateRequestError && !isTransientLookupStatus(error.status)
          ? "PERMANENT"
          : "TRANSIENT",
        status: error instanceof UpbitPrivateRequestError ? error.status : null,
      });
    }
  }

  async listOpenOrders(query: ExchangeOrderHistoryQuery = {}): Promise<ExchangeOrderSnapshot[]> {
    const response = await this.requestJson<UpbitOrderResponse[]>({
      method: "GET",
      path: "/v1/orders/open",
      query: buildHistoryQuery(query, ["wait", "watch"]),
    });

    return response.map(mapOrderResponse);
  }

  async listClosedOrders(query: ExchangeOrderHistoryQuery = {}): Promise<ExchangeOrderSnapshot[]> {
    const response = await this.requestJson<UpbitOrderResponse[]>({
      method: "GET",
      path: "/v1/orders/closed",
      query: buildHistoryQuery(query, ["done", "cancel"]),
    });

    return response.map(mapOrderResponse);
  }

  private async requestJson<T>(options: UpbitPrivateRequestOptions): Promise<T> {
    const response = await this.dispatch(options);

    if (!response.ok) {
      await response.text().catch(() => "");
      throw new UpbitPrivateRequestError(response.status, response.statusText);
    }

    return (await response.json()) as T;
  }

  private async dispatch(options: UpbitPrivateRequestOptions): Promise<Response> {
    const queryString = options.query ? buildUpbitQueryString(options.query) : "";
    const bodyQueryString = options.body ? buildUpbitQueryString(options.body) : "";
    const authPayload = bodyQueryString || queryString || undefined;
    const token = buildUpbitJwtToken(this.credentials, authPayload);
    const suffix = queryString ? `?${queryString}` : "";

    const requestInit: RequestInit = {
      method: options.method,
      redirect: "manual",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    };

    return this.fetchImpl(`${this.baseUrl}${options.path}${suffix}`, requestInit);
  }
}

interface UpbitPrivateRequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | Array<string | number | boolean> | null | undefined>;
  body?: Record<string, string | number | boolean | Array<string | number | boolean> | null | undefined>;
}

class UpbitPrivateRequestError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string) {
    super(`Upbit private request failed (${status} ${statusText}).`);
    this.status = status;
  }
}

async function readUpbitErrorMetadata(
  response: Response,
  credentials: UpbitCredentials,
): Promise<{ code: string | null; name: string | null }> {
  try {
    return extractUpbitErrorMetadata(await response.json(), credentials);
  } catch {
    return { code: null, name: null };
  }
}

function extractUpbitErrorMetadata(
  payload: unknown,
  credentials: UpbitCredentials,
): { code: string | null; name: string | null } {
  if (!isRecord(payload)) {
    return { code: null, name: null };
  }

  const error = isRecord(payload.error) ? payload.error : payload;
  const name = sanitizeExchangeIdentifier(error.name, credentials);

  return {
    code: sanitizeExchangeIdentifier(error.code, credentials) ?? name,
    name,
  };
}

function sanitizeExchangeIdentifier(value: unknown, credentials: UpbitCredentials): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(trimmed)) {
    return null;
  }

  if (containsConfiguredCredential(trimmed, credentials) || looksLikeToken(trimmed)) {
    return null;
  }

  return trimmed;
}

function containsConfiguredCredential(value: string, credentials: UpbitCredentials): boolean {
  return [credentials.accessKey, credentials.secretKey].some(
    (credential) => credential.length > 0 && value.includes(credential),
  );
}

function looksLikeToken(value: string): boolean {
  return (
    /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ||
    /^[A-Za-z0-9_-]{32,}$/.test(value)
  );
}

function isDefinitiveOrderRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

function isTransientLookupStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isValidOrderSubmissionResponse(response: unknown): response is UpbitOrderResponse {
  return (
    isRecord(response) &&
    isNonEmptyString(response.uuid) &&
    (response.market === "KRW-BTC" || response.market === "KRW-ETH") &&
    (response.side === "bid" || response.side === "ask") &&
    (response.ord_type === "limit" || response.ord_type === "price" || response.ord_type === "market" || response.ord_type === "best") &&
    isNonEmptyString(response.state) &&
    isNonEmptyString(response.created_at) &&
    isOptionalStringOrNull(response.identifier) &&
    isOptionalStringOrNull(response.price) &&
    isOptionalStringOrNull(response.volume) &&
    (response.time_in_force === undefined || response.time_in_force === null ||
      response.time_in_force === "ioc" || response.time_in_force === "fok" || response.time_in_force === "post_only") &&
    (response.smp_type === undefined || response.smp_type === null ||
      response.smp_type === "cancel_maker" || response.smp_type === "cancel_taker" || response.smp_type === "reduce") &&
    isOptionalStringOrNull(response.remaining_volume) &&
    isOptionalStringOrNull(response.executed_volume) &&
    isOptionalStringOrNull(response.paid_fee) &&
    (response.trades === undefined || (Array.isArray(response.trades) && response.trades.every(isValidOrderTrade)))
  );
}

function isValidOrderTrade(trade: unknown): boolean {
  return (
    isRecord(trade) &&
    isOptionalStringOrNull(trade.uuid) &&
    (trade.side === undefined || trade.side === null || trade.side === "bid" || trade.side === "ask") &&
    isNonEmptyString(trade.price) &&
    isNonEmptyString(trade.volume) &&
    isOptionalStringOrNull(trade.funds) &&
    isOptionalStringOrNull(trade.fee) &&
    isOptionalStringOrNull(trade.created_at)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalStringOrNull(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function buildHistoryQuery(
  query: ExchangeOrderHistoryQuery,
  defaultStates: string[],
): Record<string, string | number | boolean | Array<string | number | boolean>> {
  return {
    ...(query.market ? { market: query.market } : {}),
    "states[]": query.states && query.states.length > 0 ? query.states : defaultStates,
    ...(typeof query.startTimeMs === "number" ? { start_time: Math.trunc(query.startTimeMs) } : {}),
    ...(typeof query.endTimeMs === "number" ? { end_time: Math.trunc(query.endTimeMs) } : {}),
    page: query.page ?? 1,
    limit: query.limit ?? 20,
    order_by: query.orderBy ?? "desc",
  };
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
    timeInForce: response.time_in_force ?? null,
    smpType: response.smp_type ?? null,
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

function parseOptionalNumber(input: string | number | null | undefined): number | null {
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : null;
  }

  const parsed = Number(input);
  return Number.isFinite(parsed) ? parsed : null;
}
