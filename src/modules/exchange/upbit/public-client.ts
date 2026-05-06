import type {
  UpbitCandleSnapshot,
  UpbitGetDayCandlesRequest,
  UpbitGetMinuteCandlesRequest,
  UpbitPublicQuotationClient,
  UpbitTickerSnapshot,
} from "./contracts.js";

interface UpbitPublicTickerClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface UpbitTickerResponse {
  market: string;
  trade_price: number;
  trade_timestamp: number;
}

const DEFAULT_BASE_URL = "https://api.upbit.com";

export class UpbitPublicTickerClient implements UpbitPublicQuotationClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: UpbitPublicTickerClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async getTickers(markets: readonly UpbitTickerSnapshot["market"][]): Promise<readonly UpbitTickerSnapshot[]> {
    if (markets.length === 0) {
      return [];
    }

    const query = encodeURIComponent(markets.join(","));
    const response = await this.fetchImpl(`${this.baseUrl}/v1/ticker?markets=${query}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      await response.text().catch(() => "");
      throw new Error(`Upbit public ticker request failed (${response.status} ${response.statusText}).`);
    }

    const payload = (await response.json()) as UpbitTickerResponse[];
    return payload.map((ticker) => ({
      market: ticker.market as UpbitTickerSnapshot["market"],
      trade_price: ticker.trade_price,
      trade_timestamp: ticker.trade_timestamp,
    }));
  }

  async getMinuteCandles(request: UpbitGetMinuteCandlesRequest): Promise<readonly UpbitCandleSnapshot[]> {
    assertCandleCount(request.count);
    const query = buildQuery({
      market: request.market,
      count: String(request.count),
      ...(request.to === undefined ? {} : { to: request.to }),
    });
    const payload = await this.getJson<UpbitCandleSnapshot[]>(
      `/v1/candles/minutes/${request.unit}?${query}`,
      "minute candle",
    );

    return payload.map((candle) => ({
      ...candle,
      market: candle.market as UpbitTickerSnapshot["market"],
      unit: request.unit,
    }));
  }

  async getDayCandles(request: UpbitGetDayCandlesRequest): Promise<readonly UpbitCandleSnapshot[]> {
    assertCandleCount(request.count);
    const query = buildQuery({
      market: request.market,
      count: String(request.count),
      ...(request.to === undefined ? {} : { to: request.to }),
    });
    const payload = await this.getJson<UpbitCandleSnapshot[]>(`/v1/candles/days?${query}`, "day candle");

    return payload.map((candle) => ({
      ...candle,
      market: candle.market as UpbitTickerSnapshot["market"],
    }));
  }

  private async getJson<TPayload>(pathAndQuery: string, label: string): Promise<TPayload> {
    const response = await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      await response.text().catch(() => "");
      throw new Error(`Upbit public ${label} request failed (${response.status} ${response.statusText}).`);
    }

    return await response.json() as TPayload;
  }
}

function assertCandleCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    throw new Error("Upbit candle count must be an integer between 1 and 200.");
  }
}

function buildQuery(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}
