import assert from "node:assert/strict";

import { ExchangeOrderLookupError, ExchangeOrderSubmissionError } from "../src/modules/exchange/errors.js";
import { UpbitPrivateClient } from "../src/modules/exchange/upbit/private-client.js";
import { test } from "./harness.js";

const orderRequest = {
  market: "KRW-BTC" as const,
  side: "bid" as const,
  ordType: "limit" as const,
  volume: "0.001",
  price: "100000000",
  identifier: "submission-identifier",
  timeInForce: null,
  smpType: null,
};

test("create-order classifies a clear Upbit 400 rejection without exposing response secrets", async () => {
  const client = createPrivateClient(async () => upbitErrorResponse(400, "invalid_price", "secret-key Bearer jwt"));

  await assert.rejects(
    () => client.createOrder(orderRequest),
    (error: unknown) => {
      const submissionError = assertSubmissionError(error, {
        kind: "DEFINITIVE_REJECTION",
        status: 400,
        exchangeCode: "invalid_price",
        exchangeName: "invalid_price",
        responseReceived: true,
      });
      assert.doesNotMatch(submissionError.message, /secret-key|Bearer|jwt/i);
      return true;
    },
  );
});

test("create-order classifies a transport disconnect as uncertain", async () => {
  const client = createPrivateClient(async () => {
    throw new TypeError("socket disconnected");
  });

  await assert.rejects(
    () => client.createOrder(orderRequest),
    (error: unknown) => {
      assertSubmissionError(error, {
        kind: "UNCERTAIN",
        status: null,
        exchangeCode: null,
        exchangeName: null,
        responseReceived: false,
      });
      return true;
    },
  );
});

test("create-order classifies a 5xx response as uncertain", async () => {
  const client = createPrivateClient(async () => upbitErrorResponse(503, "temporary_error", "retry later"));

  await assert.rejects(
    () => client.createOrder(orderRequest),
    (error: unknown) => {
      assertSubmissionError(error, {
        kind: "UNCERTAIN",
        status: 503,
        exchangeCode: "temporary_error",
        exchangeName: "temporary_error",
        responseReceived: true,
      });
      return true;
    },
  );
});

test("create-order treats a malformed 2xx response as uncertain", async () => {
  const client = createPrivateClient(async () => jsonResponse({ uuid: "order-uuid" }));

  await assert.rejects(
    () => client.createOrder(orderRequest),
    (error: unknown) => {
      assertSubmissionError(error, {
        kind: "UNCERTAIN",
        status: 200,
        exchangeCode: null,
        exchangeName: null,
        responseReceived: true,
      });
      return true;
    },
  );
});

test("create-order wraps malformed optional trade data from a 2xx response as uncertain", async () => {
  const client = createPrivateClient(async () => jsonResponse({ ...validOrderResponse(), trades: {} }));

  await assert.rejects(
    () => client.createOrder(orderRequest),
    (error: unknown) => {
      assertSubmissionError(error, {
        kind: "UNCERTAIN",
        status: 200,
        exchangeCode: null,
        exchangeName: null,
        responseReceived: true,
      });
      return true;
    },
  );
});

test("create-order retains the duplicate identifier code for recovery lookup", async () => {
  const client = createPrivateClient(async () => upbitErrorResponse(400, "duplicate_identifier", "already exists"));

  await assert.rejects(
    () => client.createOrder(orderRequest),
    (error: unknown) => {
      assertSubmissionError(error, {
        kind: "DEFINITIVE_REJECTION",
        status: 400,
        exchangeCode: "duplicate_identifier",
        exchangeName: "duplicate_identifier",
        responseReceived: true,
      });
      return true;
    },
  );
});

test("create-order does not retain reflected configured credentials as exchange metadata", async () => {
  const accessKey = "configured-access-key";
  const secretKey = "configured-secret-key";
  const client = createPrivateClientWithCredentials({
    accessKey,
    secretKey,
    fetchImpl: async () => upbitErrorResponse(400, accessKey, "rejected", secretKey),
  });

  await assert.rejects(
    () => client.createOrder(orderRequest),
    (error: unknown) => {
      const submissionError = assertSubmissionError(error, {
        kind: "DEFINITIVE_REJECTION",
        status: 400,
        exchangeCode: null,
        exchangeName: null,
        responseReceived: true,
      });
      assert.doesNotMatch(submissionError.message, /configured-access-key|configured-secret-key/);
      return true;
    },
  );
});

test("create-order does not retain token-shaped exchange metadata", async () => {
  const tokenLikeValue = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.signature";
  const client = createPrivateClient(async () => upbitErrorResponse(400, tokenLikeValue, "rejected"));

  await assert.rejects(
    () => client.createOrder(orderRequest),
    (error: unknown) => {
      assertSubmissionError(error, {
        kind: "DEFINITIVE_REJECTION",
        status: 400,
        exchangeCode: null,
        exchangeName: null,
        responseReceived: true,
      });
      return true;
    },
  );
});

test("create-order keeps redirect handling manual and classifies a 3xx response as uncertain", async () => {
  let redirect: RequestRedirect | undefined;
  const client = createPrivateClient(async (_input, init) => {
    redirect = init?.redirect;
    return upbitErrorResponse(302, "redirected", "redirect");
  });

  await assert.rejects(
    () => client.createOrder(orderRequest),
    (error: unknown) => {
      assertSubmissionError(error, {
        kind: "UNCERTAIN",
        status: 302,
        exchangeCode: "redirected",
        exchangeName: "redirected",
        responseReceived: true,
      });
      return true;
    },
  );

  assert.equal(redirect, "manual");
});

test("create-order treats a 408 response as uncertain", async () => {
  const client = createPrivateClient(async () => upbitErrorResponse(408, "request_timeout", "timeout"));

  await assert.rejects(
    () => client.createOrder(orderRequest),
    (error: unknown) => {
      assertSubmissionError(error, {
        kind: "UNCERTAIN",
        status: 408,
        exchangeCode: "request_timeout",
        exchangeName: "request_timeout",
        responseReceived: true,
      });
      return true;
    },
  );
});

test("create-order treats a 429 response as uncertain", async () => {
  const client = createPrivateClient(async () => upbitErrorResponse(429, "too_many_requests", "rate limited"));

  await assert.rejects(
    () => client.createOrder(orderRequest),
    (error: unknown) => {
      assertSubmissionError(error, {
        kind: "UNCERTAIN",
        status: 429,
        exchangeCode: "too_many_requests",
        exchangeName: "too_many_requests",
        responseReceived: true,
      });
      return true;
    },
  );
});

test("authenticated order lookup returns null for a confirmed Upbit not-found response", async () => {
  const client = createPrivateClient(async () => upbitErrorResponse(404, "order_not_found", "not found"));

  const order = await client.getOrder({ identifier: "missing-order" });

  assert.equal(order, null);
});

test("authenticated order lookup exposes only a typed transient discriminant for retryable exchange failures", async () => {
  const client = createPrivateClient(async () => upbitErrorResponse(429, "too_many_requests", "rate limited"));

  await assert.rejects(
    () => client.getOrder({ identifier: "retryable-order" }),
    (error: unknown) => {
      assert.ok(error instanceof ExchangeOrderLookupError);
      assert.equal(error.kind, "TRANSIENT");
      assert.equal(error.status, 429);
      return true;
    },
  );
});

test("authenticated order lookup exposes a typed permanent discriminant for non-not-found 4xx failures", async () => {
  const client = createPrivateClient(async () => upbitErrorResponse(400, "invalid_query_payload", "invalid payload"));

  await assert.rejects(
    () => client.getOrder({ identifier: "invalid-order" }),
    (error: unknown) => {
      assert.ok(error instanceof ExchangeOrderLookupError);
      assert.equal(error.kind, "PERMANENT");
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test("non-order private endpoint failures remain generic request failures", async () => {
  const client = createPrivateClient(async () => upbitErrorResponse(400, "invalid_query_payload", "invalid test payload"));

  await assert.rejects(
    () => client.testOrder(orderRequest),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "Error");
      assert.equal("kind" in error, false);
      assert.match(error.message, /Upbit private request failed \(400 /);
      return true;
    },
  );
});

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

function createPrivateClient(fetchImpl: typeof fetch): UpbitPrivateClient {
  return createPrivateClientWithCredentials({
    accessKey: "access-key",
    secretKey: "secret-key",
    fetchImpl,
  });
}

function createPrivateClientWithCredentials(options: {
  accessKey: string;
  secretKey: string;
  fetchImpl: typeof fetch;
}): UpbitPrivateClient {
  return new UpbitPrivateClient(options);
}

function upbitErrorResponse(status: number, name: string, message: string, code?: string): Response {
  return new Response(JSON.stringify({ error: { name, message, ...(code ? { code } : {}) } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function validOrderResponse(): Record<string, unknown> {
  return {
    uuid: "order-uuid",
    identifier: "submission-identifier",
    market: "KRW-BTC",
    side: "bid",
    ord_type: "limit",
    state: "wait",
    price: "100000000",
    volume: "0.001",
    remaining_volume: "0.001",
    executed_volume: "0",
    paid_fee: "0",
    created_at: "2026-08-21T00:00:00.000Z",
    trades: [],
  };
}

function assertSubmissionError(
  error: unknown,
  expected: {
    kind: "DEFINITIVE_REJECTION" | "UNCERTAIN";
    status: number | null;
    exchangeCode: string | null;
    exchangeName: string | null;
    responseReceived: boolean;
  },
): Error {
  assert.ok(error instanceof Error);
  assert.ok(error instanceof ExchangeOrderSubmissionError);
  assert.equal(error.name, "ExchangeOrderSubmissionError");

  const typedError = error as Error & {
    kind?: unknown;
    status?: unknown;
    exchangeCode?: unknown;
    exchangeName?: unknown;
    responseReceived?: unknown;
  };

  assert.equal(typedError.kind, expected.kind);
  assert.equal(typedError.status, expected.status);
  assert.equal(typedError.exchangeCode, expected.exchangeCode);
  assert.equal(typedError.exchangeName, expected.exchangeName);
  assert.equal(typedError.responseReceived, expected.responseReceived);

  return typedError;
}
