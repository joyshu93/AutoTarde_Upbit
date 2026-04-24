import assert from "node:assert/strict";

import { UpbitPublicTickerClient } from "../src/modules/exchange/upbit/public-client.js";
import { test } from "./harness.js";

test("upbit public ticker client requests pair tickers and maps trade prices", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const client = new UpbitPublicTickerClient({
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
      });

      return new Response(
        JSON.stringify([
          {
            market: "KRW-BTC",
            trade_price: 100000000,
            trade_timestamp: 1745110200000,
          },
          {
            market: "KRW-ETH",
            trade_price: 3500000,
            trade_timestamp: 1745110201000,
          },
        ]),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    },
  });

  const tickers = await client.getTickers(["KRW-BTC", "KRW-ETH"]);

  assert.deepEqual(requests, [
    {
      url: "https://api.upbit.com/v1/ticker?markets=KRW-BTC%2CKRW-ETH",
      method: "GET",
    },
  ]);
  assert.deepEqual(tickers, [
    {
      market: "KRW-BTC",
      trade_price: 100000000,
      trade_timestamp: 1745110200000,
    },
    {
      market: "KRW-ETH",
      trade_price: 3500000,
      trade_timestamp: 1745110201000,
    },
  ]);
});

test("upbit public ticker client throws explicit errors for non-ok responses", async () => {
  const client = new UpbitPublicTickerClient({
    fetchImpl: async () =>
      new Response("rate limited", {
        status: 429,
        statusText: "Too Many Requests",
      }),
  });

  await assert.rejects(
    () => client.getTickers(["KRW-BTC"]),
    /Upbit public ticker request failed \(429 Too Many Requests\)\./,
  );
});
