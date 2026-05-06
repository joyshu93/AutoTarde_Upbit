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

test("upbit public client requests minute and day candles", async () => {
  const requests: string[] = [];
  const client = new UpbitPublicTickerClient({
    fetchImpl: async (input) => {
      requests.push(String(input));

      return new Response(
        JSON.stringify([
          {
            market: "KRW-BTC",
            candle_date_time_utc: "2026-04-20T00:00:00",
            candle_date_time_kst: "2026-04-20T09:00:00",
            opening_price: 100,
            high_price: 110,
            low_price: 90,
            trade_price: 105,
            timestamp: 1776630000000,
            candle_acc_trade_price: 1000000,
            candle_acc_trade_volume: 10,
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

  const minuteCandles = await client.getMinuteCandles({
    market: "KRW-BTC",
    unit: 60,
    count: 2,
    to: "2026-04-20T01:00:00Z",
  });
  const dayCandles = await client.getDayCandles({
    market: "KRW-BTC",
    count: 1,
  });

  assert.deepEqual(requests, [
    "https://api.upbit.com/v1/candles/minutes/60?market=KRW-BTC&count=2&to=2026-04-20T01%3A00%3A00Z",
    "https://api.upbit.com/v1/candles/days?market=KRW-BTC&count=1",
  ]);
  assert.equal(minuteCandles[0]?.unit, 60);
  assert.equal(dayCandles[0]?.market, "KRW-BTC");
});

test("upbit public client validates candle count before requesting", async () => {
  const client = new UpbitPublicTickerClient({
    fetchImpl: async () => {
      throw new Error("fetch should not be called");
    },
  });

  await assert.rejects(
    () => client.getMinuteCandles({ market: "KRW-BTC", unit: 60, count: 0 }),
    /Upbit candle count must be an integer between 1 and 200\./,
  );
});
