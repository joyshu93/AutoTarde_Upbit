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
  rateLimitMaxRetries?: number;
  rateLimitRetryDelayMs?: number;
  sleepImpl?: (delayMs: number) => Promise<void>;
}

interface UpbitTickerResponse {
  market: string;
  trade_price: number;
  trade_timestamp: number;
}

const DEFAULT_BASE_URL = "https://api.upbit.com";
const DEFAULT_RATE_LIMIT_MAX_RETRIES = 3;
const DEFAULT_RATE_LIMIT_RETRY_DELAY_MS = 1_000;

export class UpbitPublicTickerClient implements UpbitPublicQuotationClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly rateLimitMaxRetries: number;
  private readonly rateLimitRetryDelayMs: number;
  private readonly sleepImpl: (delayMs: number) => Promise<void>;

  constructor(options: UpbitPublicTickerClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.rateLimitMaxRetries = normalizeNonNegativeInteger(
      options.rateLimitMaxRetries ?? DEFAULT_RATE_LIMIT_MAX_RETRIES,
      "rateLimitMaxRetries",
    );
    this.rateLimitRetryDelayMs = normalizeNonNegativeInteger(
      options.rateLimitRetryDelayMs ?? DEFAULT_RATE_LIMIT_RETRY_DELAY_MS,
      "rateLimitRetryDelayMs",
    );
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  async getTickers(markets: readonly UpbitTickerSnapshot["market"][]): Promise<readonly UpbitTickerSnapshot[]> {
    if (markets.length === 0) {
      return [];
    }

    const query = encodeURIComponent(markets.join(","));
    const payload = await this.getJson<UpbitTickerResponse[]>(`/v1/ticker?markets=${query}`, "ticker");
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
    let retryCount = 0;

    while (true) {
      const response = await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (response.ok) {
        return await response.json() as TPayload;
      }
      await response.text().catch(() => "");
      if (response.status === 429 && retryCount < this.rateLimitMaxRetries) {
        retryCount += 1;
        await this.sleepImpl(getRateLimitRetryDelayMs(response, this.rateLimitRetryDelayMs));
        continue;
      }

      const attemptsSuffix = retryCount === 0 ? "" : ` after ${retryCount + 1} attempts`;
      throw new Error(`Upbit public ${label} request failed${attemptsSuffix} (${response.status} ${response.statusText}).`);
    }
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

function getRateLimitRetryDelayMs(response: Response, fallbackDelayMs: number): number {
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1_000);
    }

    const retryAtMs = Date.parse(retryAfter);
    if (!Number.isNaN(retryAtMs)) {
      return Math.max(0, retryAtMs - Date.now());
    }
  }

  return fallbackDelayMs;
}

function normalizeNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Upbit public ${label} must be a non-negative integer.`);
  }
  return value;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
