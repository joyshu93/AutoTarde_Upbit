import assert from "node:assert/strict";

import {
  calculatePerformance,
  type PerformanceCalculationInput,
} from "../src/modules/performance/performance-calculator.js";
import { test } from "./harness.js";

test("performance calculator reports profitable and losing round trips with fees", () => {
  const result = calculatePerformance({
    fills: [
      fill("btc-buy", "KRW-BTC", "bid", 10, 2, 1, "2026-08-01T00:00:00.000Z"),
      fill("btc-sell", "KRW-BTC", "ask", 12, 2, 1, "2026-08-02T00:00:00.000Z"),
      fill("eth-buy", "KRW-ETH", "bid", 20, 1, 0.5, "2026-08-03T00:00:00.000Z"),
      fill("eth-sell", "KRW-ETH", "ask", 18, 1, 0.5, "2026-08-04T00:00:00.000Z"),
    ],
  });

  assert.deepEqual(result.totals, {
    realizedPnlKrw: -1,
    openingInventoryRealizedPnlKrw: 0,
    selectedStreamRealizedPnlKrw: -1,
    paidFeesKrw: 3,
    turnoverKrw: 82,
    remainingCostKrw: 0,
    marketValueKrw: 0,
    grossUnrealizedPnlKrw: 0,
  });
  assert.equal(market(result, "KRW-BTC").realizedPnlKrw, 2);
  assert.equal(market(result, "KRW-ETH").realizedPnlKrw, -3);
  assert.deepEqual(result.warnings, []);
});

test("performance calculator applies FIFO to partial sells and marks the remaining lot", () => {
  const result = calculatePerformance({
    fills: [
      fill("first", "KRW-BTC", "bid", 100, 1, 0, "2026-08-01T00:00:00.000Z"),
      fill("second", "KRW-BTC", "bid", 120, 2, 0, "2026-08-02T00:00:00.000Z"),
      fill("partial-sell", "KRW-BTC", "ask", 150, 2, 0, "2026-08-03T00:00:00.000Z"),
    ],
    markPrices: [{ market: "KRW-BTC", priceKrw: 130 }],
  });

  assert.deepEqual(market(result, "KRW-BTC"), {
    market: "KRW-BTC",
    realizedPnlKrw: 80,
    openingInventoryRealizedPnlKrw: 0,
    selectedStreamRealizedPnlKrw: 80,
    paidFeesKrw: 0,
    turnoverKrw: 640,
    remainingQuantity: 1,
    remainingCostKrw: 120,
    marketValueKrw: 130,
    grossUnrealizedPnlKrw: 10,
    unmatchedSellQuantity: 0,
  });
});

test("performance calculator orders mixed-offset fills by their parsed instant", () => {
  const result = calculatePerformance({
    fills: [
      fill("later-sell", "KRW-BTC", "ask", 110, 1, 0, "2026-08-01T02:00:00.000Z"),
      fill("earlier-buy", "KRW-BTC", "bid", 100, 1, 0, "2026-08-01T10:00:00.000+09:00"),
    ],
  });

  const btc = market(result, "KRW-BTC");
  assert.equal(btc.realizedPnlKrw, 10);
  assert.equal(btc.unmatchedSellQuantity, 0);
  assert.deepEqual(result.warnings, []);
});

test("performance calculator orders mixed-offset nanosecond fills before using FIFO", () => {
  const result = calculatePerformance({
    fills: [
      fill("a-later-sell", "KRW-BTC", "ask", 110, 1, 0, "2026-08-01T01:00:00.000000200Z"),
      fill(
        "z-earlier-buy",
        "KRW-BTC",
        "bid",
        100,
        1,
        0,
        "2026-08-01T10:00:00.000000100+09:00",
      ),
    ],
  });

  const btc = market(result, "KRW-BTC");
  assert.equal(btc.realizedPnlKrw, 10);
  assert.equal(btc.unmatchedSellQuantity, 0);
  assert.deepEqual(result.warnings, []);
});

test("performance calculator rejects opposite-side fills at the same exact instant", () => {
  assert.throws(
    () =>
      calculatePerformance({
        fills: [
          fill(
            "z-buy",
            "KRW-BTC",
            "bid",
            100,
            1,
            0,
            "2026-08-01T10:00:00.000000100+09:00",
          ),
          fill("a-sell", "KRW-BTC", "ask", 110, 1, 0, "2026-08-01T01:00:00.000000100Z"),
        ],
      }),
    /Ambiguous opposite-side fills for KRW-BTC at the same instant/,
  );
});

test("performance calculator uses fill id as the same-side FIFO tie-break", () => {
  const result = calculatePerformance({
    fills: [
      fill(
        "z-expensive-buy",
        "KRW-BTC",
        "bid",
        120,
        1,
        0,
        "2026-08-01T10:00:00.000000100+09:00",
      ),
      fill("a-cheap-buy", "KRW-BTC", "bid", 100, 1, 0, "2026-08-01T01:00:00.000000100Z"),
      fill("later-sell", "KRW-BTC", "ask", 110, 1, 0, "2026-08-01T01:00:00.000000200Z"),
    ],
    markPrices: [{ market: "KRW-BTC", priceKrw: 120 }],
  });

  const btc = market(result, "KRW-BTC");
  assert.equal(btc.realizedPnlKrw, 10);
  assert.equal(btc.unmatchedSellQuantity, 0);
  assert.equal(btc.remainingQuantity, 1);
  assert.equal(btc.remainingCostKrw, 120);
  assert.deepEqual(result.warnings, []);
});

test("performance calculator normalizes decimal quantity residuals within tolerance", () => {
  const result = calculatePerformance({
    fills: [
      fill("buy", "KRW-BTC", "bid", 100, 0.3, 0, "2026-08-01T00:00:00.000Z"),
      fill("sell-one", "KRW-BTC", "ask", 100, 0.1, 0, "2026-08-02T00:00:00.000Z"),
      fill("sell-two", "KRW-BTC", "ask", 100, 0.2, 0, "2026-08-03T00:00:00.000Z"),
    ],
  });

  const btc = market(result, "KRW-BTC");
  assert.equal(btc.remainingQuantity, 0);
  assert.equal(btc.unmatchedSellQuantity, 0);
  assert.deepEqual(result.warnings, []);
});

test("performance calculator separates opening inventory pnl from selected-stream pnl", () => {
  const result = calculatePerformance({
    openingPositions: [{ market: "KRW-BTC", quantity: 2, averagePriceKrw: 90 }],
    fills: [
      fill("stream-buy", "KRW-BTC", "bid", 100, 1, 0, "2026-08-01T00:00:00.000Z"),
      fill("mixed-sell", "KRW-BTC", "ask", 120, 2.5, 0, "2026-08-02T00:00:00.000Z"),
    ],
    markPrices: [{ market: "KRW-BTC", priceKrw: 110 }],
  });

  const btc = market(result, "KRW-BTC");
  assert.equal(btc.realizedPnlKrw, 70);
  assert.equal(btc.openingInventoryRealizedPnlKrw, 60);
  assert.equal(btc.selectedStreamRealizedPnlKrw, 10);
  assert.equal(btc.remainingQuantity, 0.5);
  assert.equal(btc.remainingCostKrw, 50);
  assert.equal(btc.marketValueKrw, 55);
  assert.equal(btc.grossUnrealizedPnlKrw, 5);
});

test("performance calculator allocates a sell fee across opening and selected-stream FIFO lots", () => {
  const result = calculatePerformance({
    openingPositions: [{ market: "KRW-BTC", quantity: 1, averagePriceKrw: 100 }],
    fills: [
      fill("stream-buy", "KRW-BTC", "bid", 110, 1, 0, "2026-08-01T00:00:00.000Z"),
      fill("mixed-sell", "KRW-BTC", "ask", 130, 2, 20, "2026-08-02T00:00:00.000Z"),
    ],
  });

  const btc = market(result, "KRW-BTC");
  assert.equal(btc.realizedPnlKrw, 30);
  assert.equal(btc.openingInventoryRealizedPnlKrw, 20);
  assert.equal(btc.selectedStreamRealizedPnlKrw, 10);
  assert.equal(btc.paidFeesKrw, 20);
});

test("performance calculator reports missing fees, unavailable marks, and unmatched sells", () => {
  const result = calculatePerformance({
    openingPositions: [{ market: "KRW-ETH", quantity: 1, averagePriceKrw: null }],
    fills: [
      fill("missing-fee", "KRW-BTC", "bid", 100, 1, null, "2026-08-01T00:00:00.000Z"),
      fill("unmatched", "KRW-BTC", "ask", 110, 2, 0, "2026-08-02T00:00:00.000Z"),
    ],
  });

  assert.equal(market(result, "KRW-BTC").unmatchedSellQuantity, 1);
  assert.equal(market(result, "KRW-BTC").paidFeesKrw, null);
  assert.equal(result.totals.paidFeesKrw, null);
  assert.equal(market(result, "KRW-BTC").grossUnrealizedPnlKrw, 0);
  assert.equal(market(result, "KRW-ETH").grossUnrealizedPnlKrw, null);
  assert.equal(market(result, "KRW-ETH").remainingCostKrw, null);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code),
    ["MISSING_FILL_FEE", "UNMATCHED_SELL", "MISSING_OPENING_COST", "MISSING_MARK_PRICE"],
  );
});

test("performance calculator rejects non-finite or non-positive persisted values", () => {
  assert.throws(
    () =>
      calculatePerformance({
        fills: [fill("invalid-price", "KRW-BTC", "bid", 0, 1, 0, "2026-08-01T00:00:00.000Z")],
      }),
    /priceKrw must be a finite positive number/,
  );
  assert.throws(
    () =>
      calculatePerformance({
        fills: [fill("invalid-fee", "KRW-BTC", "bid", 1, 1, -1, "2026-08-01T00:00:00.000Z")],
      }),
    /feeKrw must be a finite non-negative number or null/,
  );
});

test("performance calculator consistently rejects invalid exact timestamps", () => {
  const invalidTimestamps = [
    "2026-02-30T00:00:00.000Z",
    "2026-08-01T00:00:00.0000000000Z",
    "2026-08-01T00:00:00.000+14:01",
    "2026-08-01T00:00:00.000",
  ];

  for (const filledAt of invalidTimestamps) {
    assert.throws(
      () =>
        calculatePerformance({
          fills: [fill("invalid-time", "KRW-BTC", "bid", 1, 1, 0, filledAt)],
        }),
      /Fill invalid-time filledAt must be a valid timestamp\./,
    );
  }
});

function fill(
  id: string,
  marketName: "KRW-BTC" | "KRW-ETH",
  side: "bid" | "ask",
  priceKrw: number,
  volume: number,
  feeKrw: number | null,
  filledAt: string,
): PerformanceCalculationInput["fills"][number] {
  return { id, market: marketName, side, priceKrw, volume, feeKrw, filledAt };
}

function market(
  result: ReturnType<typeof calculatePerformance>,
  marketName: "KRW-BTC" | "KRW-ETH",
) {
  const found = result.markets.find((entry) => entry.market === marketName);
  assert.ok(found, `Expected ${marketName} performance result.`);
  return found;
}
