import assert from "node:assert/strict";

import { UpbitPrivateClient } from "../src/modules/exchange/upbit/private-client.js";
import { test } from "./harness.js";

test("upbit private client lists open orders with state-array filters", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const client = new UpbitPrivateClient({
    accessKey: "access-key",
    secretKey: "secret-key",
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
      });

      return new Response(
        JSON.stringify([
          {
            uuid: "uuid-open-1",
            identifier: "identifier-open-1",
            market: "KRW-BTC",
            side: "bid",
            ord_type: "limit",
            state: "wait",
            price: "100000000",
            volume: "0.01",
            remaining_volume: "0.01",
            executed_volume: "0",
            paid_fee: "0",
            created_at: "2026-04-25T00:00:00.000Z",
            trades: [],
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

  const orders = await client.listOpenOrders({
    market: "KRW-BTC",
    states: ["wait", "watch"],
    limit: 25,
  });

  assert.deepEqual(requests, [
    {
      url: "https://api.upbit.com/v1/orders/open?market=KRW-BTC&states[]=wait&states[]=watch&page=1&limit=25&order_by=desc",
      method: "GET",
    },
  ]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0]?.uuid, "uuid-open-1");
  assert.equal(orders[0]?.state, "wait");
  assert.equal(orders[0]?.identifier, "identifier-open-1");
});

test("upbit private client lists closed orders with done/cancel defaults", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const client = new UpbitPrivateClient({
    accessKey: "access-key",
    secretKey: "secret-key",
    fetchImpl: async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method,
      });

      return new Response(
        JSON.stringify([
          {
            uuid: "uuid-closed-1",
            market: "KRW-ETH",
            side: "ask",
            ord_type: "market",
            state: "done",
            volume: "0.1",
            remaining_volume: "0",
            executed_volume: "0.1",
            paid_fee: "250",
            created_at: "2026-04-25T00:10:00.000Z",
            trades: [],
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

  const orders = await client.listClosedOrders({
    market: "KRW-ETH",
    startTimeMs: 1_745_324_400_000,
    endTimeMs: 1_745_410_800_000,
    page: 2,
    limit: 10,
    orderBy: "asc",
  });

  assert.deepEqual(requests, [
    {
      url: "https://api.upbit.com/v1/orders/closed?market=KRW-ETH&states[]=done&states[]=cancel&start_time=1745324400000&end_time=1745410800000&page=2&limit=10&order_by=asc",
      method: "GET",
    },
  ]);
  assert.equal(orders.length, 1);
  assert.equal(orders[0]?.uuid, "uuid-closed-1");
  assert.equal(orders[0]?.state, "done");
  assert.equal(orders[0]?.identifier, null);
});
