import type {
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
}
