import assert from "node:assert/strict";

import {
  diagnosePerformance,
} from "../src/modules/performance/performance-diagnostics.js";
import {
  type PerformanceDecisionAction,
  type PerformanceTradeFill,
} from "../src/modules/performance/performance-trade-matcher.js";
import { test } from "./harness.js";

const DAY = 86_400_000;

test("diagnostics separates completed episode and FIFO slice outcomes", () => {
  const result = diagnose([
    fill("btc-buy-1", "KRW-BTC", "bid", 100, 1, 1, at(0), "ENTER"),
    fill("btc-buy-2", "KRW-BTC", "bid", 120, 1, 1, at(1), "ADD"),
    fill("btc-sell-1", "KRW-BTC", "ask", 110, 1, 1, at(2), "REDUCE"),
    fill("btc-sell-2", "KRW-BTC", "ask", 130, 1, 1, at(3), "EXIT"),
    fill("eth-buy", "KRW-ETH", "bid", 100, 1, 0, at(4), "ENTER"),
    fill("eth-sell", "KRW-ETH", "ask", 90, 1, 0, at(5), "EXIT"),
    fill("btc-flat-buy", "KRW-BTC", "bid", 100, 1, 5, at(6), "ENTER"),
    fill("btc-flat-sell", "KRW-BTC", "ask", 110, 1, 5, at(7), "EXIT"),
  ]);

  assert.deepEqual(result.combined.episodeOutcomes, known({ win: 1, loss: 1, breakeven: 1 }));
  assert.deepEqual(result.combined.episodeWinRate, known(1 / 3));
  assert.deepEqual(result.combined.sliceOutcomes, known({ win: 2, loss: 1, breakeven: 1 }));
  assert.deepEqual(result.combined.sliceWinRate, known(0.5));
  assert.deepEqual(result.combined.averageWinKrw, known(16));
  assert.deepEqual(result.combined.averageLossKrw, known(-10));
  assert.deepEqual(result.combined.averageNetPnlKrw, known(2));
  assert.deepEqual(result.combined.payoffRatio, known(1.6));
  assert.deepEqual(result.combined.profitFactor, known(1.6));
  assert.deepEqual(result.combined.grossRealizedPnlKrw, known(20));
  assert.deepEqual(result.combined.realizedFeeImpactKrw, known(14));
  assert.deepEqual(result.combined.netRealizedPnlKrw, known(6));
  assert.deepEqual(result.combined.turnoverKrw, known(860));
  assert.deepEqual(result.combined.confirmedFeesKrw, known(14));
  assert.equal(result.combined.feeCompleteness, "COMPLETE");
  assert.deepEqual(result.markets["KRW-BTC"].episodeOutcomes, known({ win: 1, loss: 0, breakeven: 1 }));
  assert.deepEqual(result.markets["KRW-ETH"].episodeOutcomes, known({ win: 0, loss: 1, breakeven: 0 }));
});

test("diagnostics excludes open episodes but retains partial realization in curves", () => {
  const result = diagnose([
    fill("buy", "KRW-BTC", "bid", 100, 2, 2, at(0), "ENTER"),
    fill("partial", "KRW-BTC", "ask", 120, 1, 1, at(1), "REDUCE"),
  ]);

  assert.equal(result.combined.completedEpisodeCount, 0);
  assert.equal(result.combined.openEpisodeCount, 1);
  assert.equal(result.combined.episodeWinRate.status, "NOT_APPLICABLE");
  assert.deepEqual(result.realizedPnlCurve.net, known([
    { observedAt: at(1), cumulativePnlKrw: 18, drawdownKrw: 0 },
  ]));
});

test("diagnostics makes net outcome statistics unknown when a fee is missing", () => {
  const result = diagnose([
    fill("buy", "KRW-BTC", "bid", 100, 1, null, at(0), "ENTER"),
    fill("sell", "KRW-BTC", "ask", 120, 1, 1, at(1), "EXIT"),
  ]);

  assert.equal(result.combined.episodeOutcomes.status, "UNKNOWN");
  assert.equal(result.combined.episodeWinRate.status, "UNKNOWN");
  assert.equal(result.combined.profitFactor.status, "UNKNOWN");
  assert.equal(result.combined.netRealizedPnlKrw.status, "UNKNOWN");
  assert.equal(result.realizedPnlCurve.net.status, "UNKNOWN");
  assert.equal(result.combined.feeCompleteness, "INCOMPLETE");
  assert.deepEqual(result.combined.grossRealizedPnlKrw, known(20));
  assert.deepEqual(result.combined.confirmedFeesKrw, known(1));
  assert.equal(result.combined.maxConsecutiveWins.status, "UNKNOWN");
});

test("diagnostics classifies a gross profit as a net loss when confirmed fees exceed it", () => {
  const result = diagnose([
    fill("buy", "KRW-BTC", "bid", 100, 1, 3, at(0), "ENTER"),
    fill("sell", "KRW-BTC", "ask", 105, 1, 3, at(1), "EXIT"),
  ]);

  assert.deepEqual(result.combined.grossRealizedPnlKrw, known(5));
  assert.deepEqual(result.combined.netRealizedPnlKrw, known(-1));
  assert.deepEqual(result.combined.episodeOutcomes, known({ win: 0, loss: 1, breakeven: 0 }));
});

test("diagnostics reports streaks, holding time, and best and worst completed episodes", () => {
  const result = diagnose([
    ...roundTrip("w1", "KRW-BTC", 100, 110, at(0), at(1)),
    ...roundTrip("w2", "KRW-BTC", 100, 120, at(2), at(4)),
    ...roundTrip("l1", "KRW-ETH", 100, 90, at(5), at(8)),
    ...roundTrip("l2", "KRW-ETH", 100, 80, at(9), at(13)),
  ]);

  assert.deepEqual(result.combined.maxConsecutiveWins, known(2));
  assert.deepEqual(result.combined.maxConsecutiveLosses, known(2));
  assert.deepEqual(result.combined.holdingDurationMs, known({ average: 2.5 * DAY, min: DAY, max: 4 * DAY }));
  assert.equal(result.combined.bestCompletedEpisode.status, "KNOWN");
  assert.equal(result.combined.worstCompletedEpisode.status, "KNOWN");
  if (
    result.combined.bestCompletedEpisode.status !== "KNOWN" ||
    result.combined.worstCompletedEpisode.status !== "KNOWN"
  ) {
    throw new Error("Expected known episode extremes.");
  }
  assert.equal(result.combined.bestCompletedEpisode.value.netPnlKrw, 20);
  assert.equal(result.combined.worstCompletedEpisode.value.netPnlKrw, -20);
});

test("realized drawdown groups same epoch across markets and orders mixed timezones by epoch", () => {
  const sameEpochA = "2026-08-02T00:00:00.000Z";
  const sameEpochB = "2026-08-02T09:00:00.000+09:00";
  const result = diagnose([
    ...roundTrip("first", "KRW-BTC", 100, 200, "2026-08-01T00:00:00.000Z", sameEpochA),
    ...roundTrip("offset", "KRW-ETH", 100, 50, "2026-08-01T01:00:00.000Z", sameEpochB),
    ...roundTrip("third", "KRW-BTC", 100, 25, at(3), at(4)),
  ]);

  assert.deepEqual(result.realizedPnlCurve.net, known([
    { observedAt: sameEpochA, cumulativePnlKrw: 50, drawdownKrw: 0 },
    { observedAt: at(4), cumulativePnlKrw: -25, drawdownKrw: 75 },
  ]));
  assert.deepEqual(result.realizedPnlCurve.maxNetDrawdownKrw, known(75));
});

test("realized drawdown computes the canonical +100 -150 +25 path as 150", () => {
  const result = diagnose([
    ...roundTrip("a", "KRW-BTC", 100, 200, at(0), at(1)),
    ...roundTrip("b", "KRW-BTC", 200, 50, at(2), at(3)),
    ...roundTrip("c", "KRW-BTC", 100, 125, at(4), at(5)),
  ]);

  assert.deepEqual(result.realizedPnlCurve.maxNetDrawdownKrw, known(150));
});

test("mark curve replays only persisted evidence available at each snapshot", () => {
  const fills = [
    fill("buy", "KRW-BTC", "bid", 100, 1, 2, at(1), "ENTER"),
    fill("future-sell", "KRW-BTC", "ask", 150, 1, 3, at(4), "EXIT"),
  ];
  const result = diagnosePerformance({
    fills,
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [
      { snapshotId: "s0", capturedAt: at(0), prices: { "KRW-BTC": 999 } },
      { snapshotId: "s1", capturedAt: at(2), prices: { "KRW-BTC": 90 } },
      { snapshotId: "s2", capturedAt: at(3), prices: { "KRW-BTC": 120 } },
      { snapshotId: "s3", capturedAt: at(5), prices: { "KRW-BTC": 130 } },
    ],
  });

  assert.deepEqual(result.markPnlCurve.gross, known([
    { snapshotId: "s0", observedAt: at(0), attributedPnlKrw: 0, drawdownKrw: 0 },
    { snapshotId: "s1", observedAt: at(2), attributedPnlKrw: -10, drawdownKrw: 10 },
    { snapshotId: "s2", observedAt: at(3), attributedPnlKrw: 20, drawdownKrw: 0 },
    { snapshotId: "s3", observedAt: at(5), attributedPnlKrw: 50, drawdownKrw: 0 },
  ]));
  assert.equal(result.markPnlCurve.net.status, "KNOWN");
  if (result.markPnlCurve.net.status !== "KNOWN") throw new Error("Expected known net mark curve.");
  assert.deepEqual(result.markPnlCurve.net.value.map((point) => point.attributedPnlKrw), [0, -12, 18, 45]);
  assert.deepEqual(result.markPnlCurve.maxGrossDrawdownKrw, known(10));
  assert.deepEqual(result.markPnlCurve.maxNetDrawdownKrw, known(12));
  assert.equal(result.markPnlCurve.sampleCount, 4);
  assert.equal(result.markPnlCurve.maxObservationGapMs, 2 * DAY);
  assert.deepEqual(result.markPnlCurve.excludedObservations, []);
});

test("mark curve is explicitly unknown when an open selected position has no persisted mark", () => {
  const fills = [fill("buy", "KRW-BTC", "bid", 100, 1, 1, at(0), "ENTER")];
  const result = diagnosePerformance({
    fills,
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [{ snapshotId: "missing-btc", capturedAt: at(1), prices: {} }],
  });

  assert.equal(result.markPnlCurve.gross.status, "UNKNOWN");
  assert.equal(result.markPnlCurve.net.status, "UNKNOWN");
  assert.equal(result.markPnlCurve.maxGrossDrawdownKrw.status, "UNKNOWN");
  assert.deepEqual(result.markPnlCurve.excludedObservations, [
    {
      snapshotId: "missing-btc",
      capturedAt: at(1),
      market: "KRW-BTC",
      metricScopes: ["GROSS", "NET"],
      reasonCodes: ["MISSING_ACTIVE_POSITION_MARK"],
    },
  ]);
});

test("mark exclusion provenance keeps gross usable when only remaining buy fee is unknown", () => {
  const result = diagnosePerformance({
    fills: [fill("buy", "KRW-BTC", "bid", 100, 1, null, at(0), "ENTER")],
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [{ snapshotId: "missing-fee", capturedAt: at(1), prices: { "KRW-BTC": 110 } }],
  });

  assert.equal(result.markPnlCurve.gross.status, "KNOWN");
  assert.equal(result.markPnlCurve.net.status, "UNKNOWN");
  assert.equal(result.markPnlCurve.usableObservationCount, 1);
  assert.equal(result.markPnlCurve.sampleCount, 1);
  assert.deepEqual(result.markPnlCurve.excludedObservations, [
    {
      snapshotId: "missing-fee",
      capturedAt: at(1),
      market: "KRW-BTC",
      metricScopes: ["NET"],
      reasonCodes: ["INCOMPLETE_REMAINING_BUY_FEE"],
    },
  ]);
});

test("mark exclusion provenance distinguishes non-finite acquisition and realized attribution", () => {
  const acquisition = diagnosePerformance({
    fills: [fill("overflow-buy", "KRW-BTC", "bid", 1e308, 1e308, 0, at(0), "ENTER")],
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [{ snapshotId: "acquisition", capturedAt: at(1), prices: { "KRW-BTC": 1 } }],
  });
  const realized = diagnosePerformance({
    fills: [
      fill("buy", "KRW-BTC", "bid", 1, 1e308, 0, at(0), "ENTER"),
      fill("sell", "KRW-BTC", "ask", 1e308, 1e308, 0, at(1), "EXIT"),
    ],
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [{ snapshotId: "realized", capturedAt: at(2), prices: {} }],
  });

  assert.deepEqual(acquisition.markPnlCurve.excludedObservations, [
    {
      snapshotId: "acquisition",
      capturedAt: at(1),
      market: "KRW-BTC",
      metricScopes: ["GROSS", "NET"],
      reasonCodes: ["INCOMPLETE_ACQUISITION_COST"],
    },
  ]);
  assert.deepEqual(realized.markPnlCurve.excludedObservations, [
    {
      snapshotId: "realized",
      capturedAt: at(2),
      market: "KRW-BTC",
      metricScopes: ["GROSS", "NET"],
      reasonCodes: [
        "INCOMPLETE_REALIZED_GROSS_ATTRIBUTION",
        "INCOMPLETE_REALIZED_NET_ATTRIBUTION",
      ],
    },
  ]);
});

test("mark exclusion provenance is sorted deterministically for combined and per-market curves", () => {
  const result = diagnosePerformance({
    fills: [
      fill("btc-buy", "KRW-BTC", "bid", 100, 1, null, at(0), "ENTER"),
      fill("eth-buy", "KRW-ETH", "bid", 200, 1, 0, at(0), "ENTER"),
    ],
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [
      { snapshotId: "z-later", capturedAt: at(2), prices: { "KRW-BTC": 120 } },
      { snapshotId: "a-earlier", capturedAt: at(1), prices: { "KRW-BTC": 110 } },
    ],
  });

  assert.deepEqual(result.markPnlCurve.excludedObservations, [
    {
      snapshotId: "a-earlier",
      capturedAt: at(1),
      market: "KRW-BTC",
      metricScopes: ["NET"],
      reasonCodes: ["INCOMPLETE_REMAINING_BUY_FEE"],
    },
    {
      snapshotId: "a-earlier",
      capturedAt: at(1),
      market: "KRW-ETH",
      metricScopes: ["GROSS", "NET"],
      reasonCodes: ["MISSING_ACTIVE_POSITION_MARK"],
    },
    {
      snapshotId: "z-later",
      capturedAt: at(2),
      market: "KRW-BTC",
      metricScopes: ["NET"],
      reasonCodes: ["INCOMPLETE_REMAINING_BUY_FEE"],
    },
    {
      snapshotId: "z-later",
      capturedAt: at(2),
      market: "KRW-ETH",
      metricScopes: ["GROSS", "NET"],
      reasonCodes: ["MISSING_ACTIVE_POSITION_MARK"],
    },
  ]);
  assert.deepEqual(
    result.marketMarkPnlCurves["KRW-BTC"].excludedObservations,
    result.markPnlCurve.excludedObservations.filter((item) => item.market === "KRW-BTC"),
  );
  assert.deepEqual(
    result.marketMarkPnlCurves["KRW-ETH"].excludedObservations,
    result.markPnlCurve.excludedObservations.filter((item) => item.market === "KRW-ETH"),
  );
  assert.notStrictEqual(
    result.markPnlCurve.excludedObservations,
    result.marketMarkPnlCurves["KRW-BTC"].excludedObservations,
  );
  assert.notStrictEqual(
    result.markPnlCurve.excludedObservations[0]?.metricScopes,
    result.marketMarkPnlCurves["KRW-BTC"].excludedObservations[0]?.metricScopes,
  );
});

test("mark curve counts only usable persisted observations and gaps per market", () => {
  const fills = [
    fill("btc-buy", "KRW-BTC", "bid", 100, 1, 0, at(0), "ENTER"),
    fill("eth-buy", "KRW-ETH", "bid", 200, 1, 0, at(0), "ENTER"),
  ];
  const result = diagnosePerformance({
    fills,
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [
      {
        snapshotId: "both-early",
        capturedAt: "2026-08-02T00:00:00.000100Z",
        prices: { "KRW-BTC": 110, "KRW-ETH": 210 },
      },
      {
        snapshotId: "btc-only",
        capturedAt: "2026-08-03T09:00:00.000200+09:00",
        prices: { "KRW-BTC": 120 },
      },
      {
        snapshotId: "both-late",
        capturedAt: "2026-08-05T00:00:00.000300Z",
        prices: { "KRW-BTC": 130, "KRW-ETH": 230 },
      },
    ],
  });

  assert.equal(result.markPnlCurve.persistedObservationCount, 3);
  assert.equal(result.markPnlCurve.usableObservationCount, 2);
  assert.equal(result.markPnlCurve.sampleCount, 2);
  assert.equal(result.markPnlCurve.maxObservationGapMs, 3 * DAY + 0.2);
  assert.equal(result.markPnlCurve.gross.status, "UNKNOWN");
  assert.equal(result.markPnlCurve.net.status, "UNKNOWN");

  const btc = result.marketMarkPnlCurves["KRW-BTC"];
  assert.equal(btc.persistedObservationCount, 3);
  assert.equal(btc.usableObservationCount, 3);
  assert.equal(btc.sampleCount, 3);
  assert.equal(btc.maxObservationGapMs, 2 * DAY + 0.1);
  assert.equal(btc.gross.status, "KNOWN");
  if (btc.gross.status !== "KNOWN") throw new Error("Expected known BTC mark curve.");
  assert.deepEqual(
    btc.gross.value.map((point) => point.observedAt),
    [
      "2026-08-02T00:00:00.000100Z",
      "2026-08-03T09:00:00.000200+09:00",
      "2026-08-05T00:00:00.000300Z",
    ],
  );

  const eth = result.marketMarkPnlCurves["KRW-ETH"];
  assert.equal(eth.persistedObservationCount, 3);
  assert.equal(eth.usableObservationCount, 2);
  assert.equal(eth.sampleCount, 2);
  assert.equal(eth.maxObservationGapMs, 3 * DAY + 0.2);
  assert.equal(eth.gross.status, "UNKNOWN");
  assert.equal(JSON.stringify({ combined: result.markPnlCurve, btc, eth }).includes("null"), false);
});

test("mark curve reports zero usable observations when every persisted mark is unusable", () => {
  const result = diagnosePerformance({
    fills: [fill("buy", "KRW-BTC", "bid", 100, 1, 0, at(0), "ENTER")],
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [
      { snapshotId: "missing-early", capturedAt: at(1), prices: {} },
      { snapshotId: "missing-late", capturedAt: at(4), prices: {} },
    ],
  });

  for (const curve of [result.markPnlCurve, result.marketMarkPnlCurves["KRW-BTC"]]) {
    assert.equal(curve.persistedObservationCount, 2);
    assert.equal(curve.usableObservationCount, 0);
    assert.equal(curve.sampleCount, 0);
    assert.equal(curve.maxObservationGapMs, null);
    assert.equal(curve.gross.status, "UNKNOWN");
    assert.equal(curve.net.status, "UNKNOWN");
  }
});

test("mark curve is not applicable when no persisted mark observations are supplied", () => {
  const result = diagnose([]);

  assert.deepEqual(result.markPnlCurve.gross, {
    status: "NOT_APPLICABLE",
    reason: "NO_MARK_OBSERVATIONS",
  });
  assert.deepEqual(result.markPnlCurve.maxGrossDrawdownKrw, {
    status: "NOT_APPLICABLE",
    reason: "NO_MARK_OBSERVATIONS",
  });
  assert.deepEqual(result.markPnlCurve.excludedObservations, []);
});

test("diagnostics reports entry and exit action contribution independently", () => {
  const result = diagnose([
    fill("enter", "KRW-BTC", "bid", 100, 1, 1, at(0), "ENTER"),
    fill("add", "KRW-BTC", "bid", 120, 1, 1, at(1), "ADD"),
    fill("reduce", "KRW-BTC", "ask", 130, 1, 1, at(2), "REDUCE"),
    fill("exit", "KRW-BTC", "ask", 110, 1, 1, at(3), "EXIT"),
  ]);

  assert.deepEqual(result.combined.entryActionContribution.ENTER.netPnlKrw, known(28));
  assert.deepEqual(result.combined.entryActionContribution.ADD.netPnlKrw, known(-12));
  assert.deepEqual(result.combined.exitActionContribution.REDUCE.netPnlKrw, known(28));
  assert.deepEqual(result.combined.exitActionContribution.EXIT.netPnlKrw, known(-12));
});

test("diagnostics excludes opening-inventory disposal from selected turnover and fees", () => {
  const fills = [
    fill("selected-buy", "KRW-BTC", "bid", 100, 1, 2, at(0), "ENTER"),
    fill("mixed-sell", "KRW-BTC", "ask", 120, 2, 10, at(1), "EXIT"),
  ];
  const result = diagnosePerformance({
    fills,
    openingPositions: [{ market: "KRW-BTC", quantity: 1, averagePriceKrw: 90 }],
    policy: { breakevenToleranceKrw: 0 },
  });

  assert.deepEqual(result.combined.turnoverKrw, known(220));
  assert.deepEqual(result.combined.confirmedFeesKrw, known(7));
  assert.deepEqual(result.combined.realizedFeeImpactKrw, known(7));
  assert.deepEqual(result.combined.netRealizedPnlKrw, known(13));
});

test("diagnostics never emits Infinity when completed episodes have no losses", () => {
  const result = diagnose(roundTrip("only-win", "KRW-BTC", 100, 120, at(0), at(1)));

  assert.deepEqual(result.combined.profitFactor, {
    status: "NOT_APPLICABLE",
    reason: "ZERO_GROSS_LOSS",
  });
  assert.deepEqual(result.combined.payoffRatio, {
    status: "NOT_APPLICABLE",
    reason: "ZERO_GROSS_LOSS",
  });
});

test("profit factor is known zero for loss-only episodes while payoff remains not applicable", () => {
  const result = diagnose(roundTrip("only-loss", "KRW-BTC", 100, 80, at(0), at(1)));

  assert.deepEqual(result.combined.profitFactor, known(0));
  assert.deepEqual(result.combined.payoffRatio, {
    status: "NOT_APPLICABLE",
    reason: "NO_WINNING_EPISODES",
  });
});

test("combined streaks are unknown for conflicting outcomes at one close epoch regardless of ids", () => {
  const closeAt = at(2);
  const first = diagnose([
    ...roundTrip("z-win", "KRW-BTC", 100, 120, at(0), closeAt),
    ...roundTrip("a-loss", "KRW-ETH", 100, 80, at(1), closeAt),
  ]);
  const swapped = diagnose([
    ...roundTrip("a-win", "KRW-BTC", 100, 120, at(0), closeAt),
    ...roundTrip("z-loss", "KRW-ETH", 100, 80, at(1), closeAt),
  ]);

  for (const result of [first, swapped]) {
    assert.deepEqual(result.combined.maxConsecutiveWins, {
      status: "UNKNOWN",
      reasons: ["AMBIGUOUS_SIMULTANEOUS_OUTCOMES"],
    });
    assert.deepEqual(result.combined.maxConsecutiveLosses, {
      status: "UNKNOWN",
      reasons: ["AMBIGUOUS_SIMULTANEOUS_OUTCOMES"],
    });
    assert.deepEqual(result.markets["KRW-BTC"].maxConsecutiveWins, known(1));
    assert.deepEqual(result.markets["KRW-ETH"].maxConsecutiveLosses, known(1));
  }
});

test("diagnostics validates fills internally and exposes the authoritative match result", () => {
  const fills = roundTrip("audit", "KRW-BTC", 100, 120, at(0), at(1));
  const result = diagnose(fills);
  assert.equal(result.matchResult.episodes.length, 1);
  assert.equal(result.matchResult.realizationSlices.length, 1);

  assert.throws(
    () => diagnose([{ ...fills[0]!, priceKrw: Number.NaN }]),
    /priceKrw must be a finite positive number/,
  );
});

test("per-market mark curves preserve valid BTC evidence when ETH mark is missing", () => {
  const fills = [
    fill("btc-buy", "KRW-BTC", "bid", 100, 1, 1, at(0), "ENTER"),
    fill("eth-buy", "KRW-ETH", "bid", 200, 1, 1, at(0), "ENTER"),
  ];
  const result = diagnosePerformance({
    fills,
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [
      { snapshotId: "partial", capturedAt: at(1), prices: { "KRW-BTC": 110 } },
    ],
  });

  assert.deepEqual(
    result.marketMarkPnlCurves["KRW-BTC"].net.status,
    "KNOWN",
  );
  assert.equal(result.marketMarkPnlCurves["KRW-ETH"].net.status, "UNKNOWN");
  assert.equal(result.markPnlCurve.net.status, "UNKNOWN");
  assert.equal(result.marketRealizedPnlCurves["KRW-BTC"].net.status, "KNOWN");
  assert.equal(result.marketRealizedPnlCurves["KRW-ETH"].net.status, "KNOWN");
});

test("same-epoch identical mark observations are deduplicated deterministically", () => {
  const fills = [fill("buy", "KRW-BTC", "bid", 100, 1, null, at(0), "ENTER")];
  const result = diagnosePerformance({
    fills,
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [
      { snapshotId: "z", capturedAt: "2026-08-02T09:00:00.000+09:00", prices: { "KRW-BTC": 110 } },
      { snapshotId: "a", capturedAt: "2026-08-02T00:00:00.000Z", prices: { "KRW-BTC": 110 } },
    ],
  });

  assert.equal(result.markPnlCurve.persistedObservationCount, 2);
  assert.equal(result.markPnlCurve.usableObservationCount, 1);
  assert.equal(result.markPnlCurve.sampleCount, 1);
  assert.equal(result.markPnlCurve.gross.status, "KNOWN");
  if (result.markPnlCurve.gross.status !== "KNOWN") throw new Error("Expected known mark curve.");
  assert.equal(result.markPnlCurve.gross.value[0]?.snapshotId, "a");
  assert.deepEqual(result.markPnlCurve.excludedObservations, [
    {
      snapshotId: "a",
      capturedAt: "2026-08-02T00:00:00.000Z",
      market: "KRW-BTC",
      metricScopes: ["NET"],
      reasonCodes: ["INCOMPLETE_REMAINING_BUY_FEE"],
    },
  ]);
});

test("same-epoch conflicting mark observations are rejected instead of ID-ordered", () => {
  const fills = [fill("buy", "KRW-BTC", "bid", 100, 1, 0, at(0), "ENTER")];
  assert.throws(
    () =>
      diagnosePerformance({
        fills,
        policy: { breakevenToleranceKrw: 0 },
        markObservations: [
          { snapshotId: "a", capturedAt: at(1), prices: { "KRW-BTC": 110 } },
          { snapshotId: "b", capturedAt: at(1), prices: { "KRW-BTC": 90 } },
        ],
      }),
    /Conflicting mark observations at the same instant/,
  );
});

test("mark valuation normalizes a fully sold decimal residue within quantity tolerance", () => {
  const fills = [
    fill("buy-a", "KRW-BTC", "bid", 100, 0.1, 0, at(0), "ENTER"),
    fill("buy-b", "KRW-BTC", "bid", 100, 0.2, 0, at(0), "ADD"),
    fill("sell", "KRW-BTC", "ask", 110, 0.3, 0, at(1), "EXIT"),
  ];
  const result = diagnosePerformance({
    fills,
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [{ snapshotId: "after-close", capturedAt: at(2), prices: {} }],
  });

  assert.equal(result.marketMarkPnlCurves["KRW-BTC"].gross.status, "KNOWN");
  assert.equal(result.marketMarkPnlCurves["KRW-BTC"].net.status, "KNOWN");
});

test("mark observations reject impossible ISO calendar dates", () => {
  assert.throws(
    () =>
      diagnosePerformance({
        fills: [],
        policy: { breakevenToleranceKrw: 0 },
        markObservations: [
          { snapshotId: "impossible", capturedAt: "2026-02-30T00:00:00Z", prices: {} },
        ],
      }),
    /capturedAt must be ISO-8601 with an explicit timezone/,
  );
});

test("mark observations preserve exact ordering within the same millisecond", () => {
  const result = diagnosePerformance({
    fills: [fill("buy", "KRW-BTC", "bid", 100, 1, 0, "2026-08-01T00:00:00Z", "ENTER")],
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [
      { snapshotId: "a-later", capturedAt: "2026-08-01T00:00:01.000200Z", prices: { "KRW-BTC": 90 } },
      { snapshotId: "z-earlier", capturedAt: "2026-08-01T00:00:01.000100Z", prices: { "KRW-BTC": 110 } },
    ],
  });

  assert.equal(result.markPnlCurve.gross.status, "KNOWN");
  if (result.markPnlCurve.gross.status !== "KNOWN") throw new Error("Expected known mark curve.");
  assert.deepEqual(
    result.markPnlCurve.gross.value.map((point) => point.snapshotId),
    ["z-earlier", "a-later"],
  );
});

test("mark observations reject fractional precision beyond nanoseconds", () => {
  assert.throws(
    () =>
      diagnosePerformance({
        fills: [],
        policy: { breakevenToleranceKrw: 0 },
        markObservations: [
          { snapshotId: "over-precision", capturedAt: "2026-08-01T00:00:00.1234567890Z", prices: {} },
        ],
      }),
    /capturedAt must be ISO-8601 with an explicit timezone/,
  );
});

test("same-epoch complementary mark maps merge with the lexicographically smallest snapshot id", () => {
  const fills = [
    fill("btc-buy", "KRW-BTC", "bid", 100, 1, 0, at(0), "ENTER"),
    fill("eth-buy", "KRW-ETH", "bid", 200, 1, 0, at(0), "ENTER"),
  ];
  const result = diagnosePerformance({
    fills,
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [
      { snapshotId: "z-btc", capturedAt: "2026-08-02T09:00:00+09:00", prices: { "KRW-BTC": 110 } },
      { snapshotId: "a-eth", capturedAt: "2026-08-02T00:00:00Z", prices: { "KRW-ETH": 220 } },
    ],
  });

  assert.equal(result.markPnlCurve.persistedObservationCount, 2);
  assert.equal(result.markPnlCurve.usableObservationCount, 1);
  assert.equal(result.markPnlCurve.sampleCount, 1);
  assert.equal(result.markPnlCurve.gross.status, "KNOWN");
  if (result.markPnlCurve.gross.status !== "KNOWN") throw new Error("Expected merged mark curve.");
  assert.deepEqual(result.markPnlCurve.gross.value, [
    {
      snapshotId: "a-eth",
      observedAt: "2026-08-02T00:00:00Z",
      attributedPnlKrw: 30,
      drawdownKrw: 0,
    },
  ]);
});

test("attribution failures make the affected market and combined statistics unknown", () => {
  const fills = [
    fill("unmatched", "KRW-BTC", "ask", 100, 1, 0, at(0), "EXIT"),
    ...roundTrip("ignored", "KRW-BTC", 100, 120, at(1), at(2)),
    ...roundTrip("eth-valid", "KRW-ETH", 200, 220, at(1), at(2)),
  ];
  const result = diagnosePerformance({
    fills,
    policy: { breakevenToleranceKrw: 0 },
    markObservations: [
      { snapshotId: "z-later", capturedAt: at(4), prices: {} },
      { snapshotId: "a-earlier", capturedAt: at(3), prices: {} },
    ],
  });

  assert.equal(result.markets["KRW-BTC"].episodeWinRate.status, "UNKNOWN");
  assert.equal(result.combined.netRealizedPnlKrw.status, "UNKNOWN");
  assert.equal(result.realizedPnlCurve.net.status, "UNKNOWN");
  assert.equal(result.markPnlCurve.gross.status, "UNKNOWN");
  assert.equal(result.markPnlCurve.net.status, "UNKNOWN");
  assert.equal(result.markPnlCurve.persistedObservationCount, 2);
  assert.equal(result.markPnlCurve.usableObservationCount, 0);
  assert.equal(result.markPnlCurve.sampleCount, 0);
  assert.equal(result.markPnlCurve.maxObservationGapMs, null);
  assert.deepEqual(result.markPnlCurve.excludedObservations, [
    attributionExclusion("a-earlier", at(3), "KRW-BTC"),
    attributionExclusion("z-later", at(4), "KRW-BTC"),
  ]);
  assert.deepEqual(
    result.marketMarkPnlCurves["KRW-BTC"].excludedObservations,
    result.markPnlCurve.excludedObservations,
  );
  assert.notStrictEqual(
    result.marketMarkPnlCurves["KRW-BTC"].excludedObservations,
    result.markPnlCurve.excludedObservations,
  );
  assert.deepEqual(result.marketMarkPnlCurves["KRW-ETH"].excludedObservations, []);
  assert.equal(result.marketMarkPnlCurves["KRW-ETH"].gross.status, "KNOWN");
  assert.equal(result.marketMarkPnlCurves["KRW-ETH"].usableObservationCount, 2);
});

function attributionExclusion(
  snapshotId: string,
  capturedAt: string,
  market: "KRW-BTC" | "KRW-ETH",
) {
  return {
    snapshotId,
    capturedAt,
    market,
    metricScopes: ["GROSS", "NET"],
    reasonCodes: [
      "INCOMPLETE_REALIZED_GROSS_ATTRIBUTION",
      "INCOMPLETE_REALIZED_NET_ATTRIBUTION",
    ],
  };
}

function diagnose(fills: readonly PerformanceTradeFill[]) {
  return diagnosePerformance({
    fills,
    policy: { breakevenToleranceKrw: 0 },
  });
}

function roundTrip(
  id: string,
  market: "KRW-BTC" | "KRW-ETH",
  buyPrice: number,
  sellPrice: number,
  boughtAt: string,
  soldAt: string,
): PerformanceTradeFill[] {
  return [
    fill(`${id}-buy`, market, "bid", buyPrice, 1, 0, boughtAt, "ENTER"),
    fill(`${id}-sell`, market, "ask", sellPrice, 1, 0, soldAt, "EXIT"),
  ];
}

function fill(
  id: string,
  market: "KRW-BTC" | "KRW-ETH",
  side: "bid" | "ask",
  priceKrw: number,
  volume: number,
  feeKrw: number | null,
  filledAt: string,
  decisionAction: PerformanceDecisionAction,
): PerformanceTradeFill {
  return {
    id,
    orderId: `order-${id}`,
    strategyDecisionId: `decision-${id}`,
    decisionAction,
    market,
    side,
    priceKrw,
    volume,
    feeKrw,
    filledAt,
  };
}

function at(day: number): string {
  return new Date(Date.UTC(2026, 7, 1 + day)).toISOString();
}

function known<T>(value: T): { status: "KNOWN"; value: T } {
  return { status: "KNOWN", value };
}
