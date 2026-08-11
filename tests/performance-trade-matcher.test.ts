import assert from "node:assert/strict";

import {
  matchPerformanceTrades,
  type PerformanceTradeFill,
} from "../src/modules/performance/performance-trade-matcher.js";
import { test } from "./harness.js";

test("trade matcher creates auditable FIFO slices and one flat-to-flat episode across partial exits", () => {
  const result = matchPerformanceTrades({
    fills: [
      fill("buy-enter", "bid", 100, 1, 10, "2026-08-01T00:00:00.000Z", "ENTER"),
      fill("buy-add", "bid", 120, 2, 12, "2026-08-02T00:00:00.000Z", "ADD"),
      fill("sell-reduce", "ask", 150, 2, 20, "2026-08-03T00:00:00.000Z", "REDUCE"),
      fill("sell-exit", "ask", 130, 1, 5, "2026-08-04T00:00:00.000Z", "EXIT"),
    ],
  });

  assert.equal(result.realizationSlices.length, 3);
  assert.deepEqual(
    result.realizationSlices.map((slice) => ({
      source: slice.source,
      episodeId: slice.episodeId,
      entryFillId: slice.entry.fillId,
      entryOrderId: slice.entry.orderId,
      entryDecisionId: slice.entry.strategyDecisionId,
      entryAction: slice.entry.decisionAction,
      exitFillId: slice.exit.fillId,
      exitAction: slice.exit.decisionAction,
      quantity: slice.quantity,
      gross: slice.grossPnlBeforeFeesKrw,
      buyFee: slice.allocatedBuyFeeKrw,
      sellFee: slice.allocatedSellFeeKrw,
      net: slice.netRealizedPnlKrw,
      holdingMs: slice.holdingDurationMs,
    })),
    [
      {
        source: "SELECTED_STREAM",
        episodeId: "KRW-BTC:buy-enter",
        entryFillId: "buy-enter",
        entryOrderId: "order-buy-enter",
        entryDecisionId: "decision-buy-enter",
        entryAction: "ENTER",
        exitFillId: "sell-reduce",
        exitAction: "REDUCE",
        quantity: 1,
        gross: 50,
        buyFee: 10,
        sellFee: 10,
        net: 30,
        holdingMs: 2 * DAY,
      },
      {
        source: "SELECTED_STREAM",
        episodeId: "KRW-BTC:buy-enter",
        entryFillId: "buy-add",
        entryOrderId: "order-buy-add",
        entryDecisionId: "decision-buy-add",
        entryAction: "ADD",
        exitFillId: "sell-reduce",
        exitAction: "REDUCE",
        quantity: 1,
        gross: 30,
        buyFee: 6,
        sellFee: 10,
        net: 14,
        holdingMs: DAY,
      },
      {
        source: "SELECTED_STREAM",
        episodeId: "KRW-BTC:buy-enter",
        entryFillId: "buy-add",
        entryOrderId: "order-buy-add",
        entryDecisionId: "decision-buy-add",
        entryAction: "ADD",
        exitFillId: "sell-exit",
        exitAction: "EXIT",
        quantity: 1,
        gross: 10,
        buyFee: 6,
        sellFee: 5,
        net: -1,
        holdingMs: 2 * DAY,
      },
    ],
  );

  assert.deepEqual(result.episodes, [
    {
      id: "KRW-BTC:buy-enter",
      market: "KRW-BTC",
      status: "COMPLETED",
      openedAt: "2026-08-01T00:00:00.000Z",
      closedAt: "2026-08-04T00:00:00.000Z",
      entryFillIds: ["buy-enter", "buy-add"],
      exitFillIds: ["sell-reduce", "sell-exit"],
      realizationSliceIds: [
        "sell-reduce:buy-enter:0",
        "sell-reduce:buy-add:1",
        "sell-exit:buy-add:0",
      ],
      remainingQuantity: 0,
      grossRealizedPnlKrw: 90,
      realizedFeeImpactKrw: 47,
      netRealizedPnlKrw: 43,
      holdingDurationMs: 3 * DAY,
    },
  ]);
  assert.deepEqual(result.unmatchedSells, []);
});

test("trade matcher separates opening inventory slices and allocates mixed sell fees proportionally", () => {
  const result = matchPerformanceTrades({
    openingPositions: [{ market: "KRW-BTC", quantity: 1, averagePriceKrw: 80 }],
    fills: [
      fill("selected-buy", "bid", 100, 1, 4, "2026-08-01T00:00:00.000Z", "ENTER"),
      fill("mixed-sell", "ask", 120, 1.5, 15, "2026-08-02T00:00:00.000Z", "REDUCE"),
      fill("final-sell", "ask", 110, 0.5, 5, "2026-08-03T00:00:00.000Z", "EXIT"),
    ],
  });

  assert.deepEqual(
    result.realizationSlices.map((slice) => ({
      source: slice.source,
      episodeId: slice.episodeId,
      entryFillId: slice.entry.fillId,
      quantity: slice.quantity,
      gross: slice.grossPnlBeforeFeesKrw,
      buyFee: slice.allocatedBuyFeeKrw,
      sellFee: slice.allocatedSellFeeKrw,
      net: slice.netRealizedPnlKrw,
      holdingMs: slice.holdingDurationMs,
    })),
    [
      {
        source: "OPENING",
        episodeId: null,
        entryFillId: null,
        quantity: 1,
        gross: 40,
        buyFee: null,
        sellFee: 10,
        net: null,
        holdingMs: null,
      },
      {
        source: "SELECTED_STREAM",
        episodeId: "KRW-BTC:selected-buy",
        entryFillId: "selected-buy",
        quantity: 0.5,
        gross: 10,
        buyFee: 2,
        sellFee: 5,
        net: 3,
        holdingMs: DAY,
      },
      {
        source: "SELECTED_STREAM",
        episodeId: "KRW-BTC:selected-buy",
        entryFillId: "selected-buy",
        quantity: 0.5,
        gross: 5,
        buyFee: 2,
        sellFee: 5,
        net: -2,
        holdingMs: 2 * DAY,
      },
    ],
  );
  assert.equal(result.episodes.length, 1);
  assert.equal(result.episodes[0]?.status, "COMPLETED");
  assert.equal(result.episodes[0]?.netRealizedPnlKrw, 1);
});

test("trade matcher invalidates one market after an unmatched sell and records ignored later fills", () => {
  const result = matchPerformanceTrades({
    fills: [
      fill("unmatched", "ask", 110, 1, 1, "2026-08-01T00:00:00.000Z", "EXIT"),
      fill("ignored-buy", "bid", 100, 1, 1, "2026-08-02T00:00:00.000Z", "ENTER"),
      fill("ignored-sell", "ask", 120, 1, 1, "2026-08-03T00:00:00.000Z", "EXIT"),
    ],
  });

  assert.deepEqual(result.realizationSlices, []);
  assert.deepEqual(result.episodes, []);
  assert.deepEqual(result.unmatchedSells, [
    { market: "KRW-BTC", fillId: "unmatched", quantity: 1 },
  ]);
  assert.deepEqual(result.attributionFailures, [
    {
      code: "UNMATCHED_SELL",
      market: "KRW-BTC",
      causingFillId: "unmatched",
      unmatchedQuantity: 1,
      ignoredLaterFillIds: ["ignored-buy", "ignored-sell"],
    },
  ]);
});

test("trade matcher preserves legitimate multiple fills for one consistent order", () => {
  const first = fill("buy-part-1", "bid", 100, 0.4, 0.4, "2026-08-01T00:00:00.000Z", "ENTER");
  const second = fill("buy-part-2", "bid", 101, 0.6, 0.6, "2026-08-01T00:00:01.000Z", "ENTER");
  const result = matchPerformanceTrades({
    fills: [
      { ...first, orderId: "shared-order", strategyDecisionId: "shared-decision" },
      { ...second, orderId: "shared-order", strategyDecisionId: "shared-decision" },
      fill("sell", "ask", 110, 1, 1, "2026-08-02T00:00:00.000Z", "EXIT"),
    ],
  });

  assert.equal(result.episodes.length, 1);
  assert.deepEqual(result.episodes[0]?.entryFillIds, ["buy-part-1", "buy-part-2"]);
  assert.equal(result.realizationSlices.length, 2);
});

test("trade matcher rejects inconsistent metadata reused by one order", () => {
  const base = fill("first", "bid", 100, 1, 0, "2026-08-01T00:00:00.000Z", "ENTER");
  const second = fill("second", "bid", 100, 1, 0, "2026-08-01T00:00:01.000Z", "ENTER");
  const sameOrder = {
    ...second,
    orderId: base.orderId,
    strategyDecisionId: base.strategyDecisionId,
  };

  for (const [inconsistent, field] of [
    [{ ...sameOrder, market: "KRW-ETH" as const }, "market"],
    [{ ...sameOrder, side: "ask" as const, decisionAction: "EXIT" as const }, "side"],
    [{ ...sameOrder, strategyDecisionId: "different-decision" }, "strategyDecisionId"],
    [{ ...sameOrder, decisionAction: "ADD" as const }, "decisionAction"],
  ]) {
    assert.throws(
      () => matchPerformanceTrades({ fills: [base, inconsistent as PerformanceTradeFill] }),
      new RegExp(`Order .* has inconsistent ${field} metadata`),
    );
  }
});

test("trade matcher rejects inconsistent metadata reused by one strategy decision", () => {
  const base = fill("first", "bid", 100, 1, 0, "2026-08-01T00:00:00.000Z", "ENTER");
  const second = fill("second", "bid", 100, 1, 0, "2026-08-01T00:00:01.000Z", "ENTER");

  assert.throws(
    () =>
      matchPerformanceTrades({
        fills: [base, { ...second, strategyDecisionId: base.strategyDecisionId, market: "KRW-ETH" }],
      }),
    /Strategy decision .* has inconsistent market metadata/,
  );
  assert.throws(
    () =>
      matchPerformanceTrades({
        fills: [
          base,
          {
            ...second,
            strategyDecisionId: base.strategyDecisionId,
            decisionAction: "ADD",
          },
        ],
      }),
    /Strategy decision .* has inconsistent decisionAction metadata/,
  );
});

test("trade matcher rejects an action without a strategy decision id", () => {
  assert.throws(
    () =>
      matchPerformanceTrades({
        fills: [
          {
            ...fill("buy", "bid", 100, 1, 0, "2026-08-01T00:00:00.000Z", "ENTER"),
            strategyDecisionId: null,
          },
        ],
      }),
    /Fill buy has decisionAction ENTER without strategyDecisionId/,
  );
});

test("trade matcher rejects fill volume at or below the quantity tolerance", () => {
  for (const volume of [1e-12, 1e-13]) {
    assert.throws(
      () =>
        matchPerformanceTrades({
          fills: [
            fill("dust", "bid", 100, volume, 0, "2026-08-01T00:00:00.000Z", "ENTER"),
          ],
        }),
      /Fill dust volume must be greater than PERFORMANCE_QUANTITY_TOLERANCE/,
    );
  }
});

test("trade matcher reports an open episode and normalizes decimal quantity residue", () => {
  const result = matchPerformanceTrades({
    fills: [
      fill("buy", "bid", 100, 0.3, 0, "2026-08-01T00:00:00.000Z", "ENTER"),
      fill("partial", "ask", 110, 0.1, 0, "2026-08-02T00:00:00.000Z", "REDUCE"),
      fill("still-partial", "ask", 110, 0.1, 0, "2026-08-03T00:00:00.000Z", "REDUCE"),
    ],
  });

  assert.equal(result.episodes[0]?.status, "OPEN");
  assert.equal(result.episodes[0]?.closedAt, null);
  assert.ok(Math.abs((result.episodes[0]?.remainingQuantity ?? 0) - 0.1) < 1e-12);

  const completed = matchPerformanceTrades({
    fills: [
      fill("buy", "bid", 100, 0.3, 0, "2026-08-01T00:00:00.000Z", "ENTER"),
      fill("sell-one", "ask", 100, 0.1, 0, "2026-08-02T00:00:00.000Z", "REDUCE"),
      fill("sell-two", "ask", 100, 0.2, 0, "2026-08-03T00:00:00.000Z", "EXIT"),
    ],
  });
  assert.equal(completed.episodes[0]?.status, "COMPLETED");
  assert.equal(completed.episodes[0]?.remainingQuantity, 0);
});

test("trade matcher sorts mixed timezone instants by epoch and same-side ties by stable fill id", () => {
  const result = matchPerformanceTrades({
    fills: [
      fill("z-buy", "bid", 200, 1, 0, "2026-08-01T10:00:00.000+09:00", "ADD"),
      fill("sell", "ask", 300, 2, 0, "2026-08-01T02:00:00.000Z", "EXIT"),
      fill("a-buy", "bid", 100, 1, 0, "2026-08-01T01:00:00.000Z", "ENTER"),
    ],
  });

  assert.deepEqual(
    result.realizationSlices.map((slice) => slice.entry.fillId),
    ["a-buy", "z-buy"],
  );
  assert.deepEqual(
    result.realizationSlices.map((slice) => slice.grossPnlBeforeFeesKrw),
    [200, 100],
  );
});

test("trade matcher rejects opposite-side fills for one market at the same instant", () => {
  assert.throws(
    () =>
      matchPerformanceTrades({
        fills: [
          fill("buy", "bid", 100, 1, 0, "2026-08-01T00:00:00.000Z", "ENTER"),
          fill("sell", "ask", 110, 1, 0, "2026-08-01T09:00:00.000+09:00", "EXIT"),
        ],
      }),
    /Ambiguous opposite-side fills.*KRW-BTC.*same instant/,
  );
});

test("trade matcher rejects impossible calendar dates in fill timestamps", () => {
  assert.throws(
    () =>
      matchPerformanceTrades({
        fills: [
          fill("impossible-date", "bid", 100, 1, 0, "2026-02-30T00:00:00Z", "ENTER"),
        ],
      }),
    /Fill impossible-date filledAt must be an exact ISO-8601 calendar timestamp with an explicit timezone/,
  );
});

test("trade matcher accepts up to nanosecond precision and rejects longer fractions", () => {
  for (const [index, timestamp] of [
    "2026-08-01T00:00:00Z",
    "2026-08-01T09:00:00.1+09:00",
    "2026-08-01T09:00:00.12+09:00",
    "2026-08-01T09:00:00.123+09:00",
    "2026-07-06T18:27:39.360311+09:00",
    "2026-08-01T00:00:00.123456789Z",
  ].entries()) {
    assert.doesNotThrow(() =>
      matchPerformanceTrades({
        fills: [fill(`valid-${index}`, "bid", 100, 1, 0, timestamp, "ENTER")],
      }),
    );
  }

  assert.throws(
    () =>
      matchPerformanceTrades({
        fills: [
          fill("over-precision", "bid", 100, 1, 0, "2026-08-01T00:00:00.1234567890Z", "ENTER"),
        ],
      }),
    /Fill over-precision filledAt must be an exact ISO-8601 calendar timestamp with an explicit timezone/,
  );
});

test("trade matcher enforces the ISO-8601 timezone offset boundary", () => {
  for (const [index, timestamp] of [
    "2026-08-01T14:00:00+14:00",
    "2026-07-31T10:00:00-14:00",
  ].entries()) {
    assert.doesNotThrow(() =>
      matchPerformanceTrades({
        fills: [fill(`offset-boundary-${index}`, "bid", 100, 1, 0, timestamp, "ENTER")],
      }),
    );
  }

  for (const [index, timestamp] of [
    "2026-08-01T14:01:00+14:01",
    "2026-07-31T09:59:00-14:01",
    "2026-08-01T23:59:00+23:59",
  ].entries()) {
    assert.throws(
      () =>
        matchPerformanceTrades({
          fills: [fill(`invalid-offset-${index}`, "bid", 100, 1, 0, timestamp, "ENTER")],
        }),
      /must be an exact ISO-8601 calendar timestamp with an explicit timezone/,
    );
  }
});

test("trade matcher orders opposite-side fills within the same millisecond exactly", () => {
  const result = matchPerformanceTrades({
    fills: [
      fill("a-sell", "ask", 110, 1, 0, "2026-08-01T00:00:00.000200Z", "EXIT"),
      fill("z-buy", "bid", 100, 1, 0, "2026-08-01T00:00:00.000100Z", "ENTER"),
    ],
  });

  assert.equal(result.realizationSlices[0]?.entry.fillId, "z-buy");
  assert.equal(result.realizationSlices[0]?.exit.fillId, "a-sell");
  assert.equal(result.realizationSlices[0]?.holdingDurationMs, 0.1);
});

test("trade matcher keeps unknown fees and opening cost explicit instead of assuming zero", () => {
  const result = matchPerformanceTrades({
    openingPositions: [{ market: "KRW-BTC", quantity: 1, averagePriceKrw: null }],
    fills: [
      fill("buy", "bid", 100, 1, null, "2026-08-01T00:00:00.000Z", "ENTER"),
      fill("sell", "ask", 110, 2, null, "2026-08-02T00:00:00.000Z", "EXIT"),
    ],
  });

  assert.equal(result.realizationSlices[0]?.source, "OPENING");
  assert.equal(result.realizationSlices[0]?.grossPnlBeforeFeesKrw, null);
  assert.equal(result.realizationSlices[0]?.netRealizedPnlKrw, null);
  assert.equal(result.realizationSlices[1]?.source, "SELECTED_STREAM");
  assert.equal(result.realizationSlices[1]?.grossPnlBeforeFeesKrw, 10);
  assert.equal(result.realizationSlices[1]?.allocatedBuyFeeKrw, null);
  assert.equal(result.realizationSlices[1]?.allocatedSellFeeKrw, null);
  assert.equal(result.realizationSlices[1]?.netRealizedPnlKrw, null);
  assert.equal(result.episodes[0]?.grossRealizedPnlKrw, 10);
  assert.equal(result.episodes[0]?.realizedFeeImpactKrw, null);
  assert.equal(result.episodes[0]?.netRealizedPnlKrw, null);
});

const DAY = 24 * 60 * 60 * 1_000;

function fill(
  id: string,
  side: "bid" | "ask",
  priceKrw: number,
  volume: number,
  feeKrw: number | null,
  filledAt: string,
  action: "ENTER" | "ADD" | "REDUCE" | "EXIT" | null,
): PerformanceTradeFill {
  return {
    id,
    orderId: `order-${id}`,
    strategyDecisionId: `decision-${id}`,
    decisionAction: action,
    market: "KRW-BTC",
    side,
    priceKrw,
    volume,
    feeKrw,
    filledAt,
  };
}
