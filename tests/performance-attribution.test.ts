import assert from "node:assert/strict";

import {
  buildObservedAttribution,
  classifySampleSupport,
} from "../src/modules/performance/performance-attribution.js";
import { diagnosePerformance } from "../src/modules/performance/performance-diagnostics.js";
import {
  type FifoRealizationSlice,
  type PerformanceTradeFill,
  type PerformanceTradeMatchResult,
} from "../src/modules/performance/performance-trade-matcher.js";
import { test } from "./harness.js";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

test("sample support uses the observation-count policy thresholds", () => {
  assert.deepEqual(classifySampleSupport("REALIZATION_SLICES", 9), {
    policy: "OBSERVATION_COUNT_V1",
    unit: "REALIZATION_SLICES",
    observedCount: 9,
    requiredCount: 30,
    status: "INSUFFICIENT",
  });
  assert.equal(classifySampleSupport("UNIQUE_FILL_IDS", 10).status, "PRELIMINARY");
  assert.equal(classifySampleSupport("UNIQUE_DECISION_IDS", 29).status, "PRELIMINARY");
  assert.equal(classifySampleSupport("COMPLETED_EPISODES", 30).status, "SUPPORTED");
});

test("observed attribution counts distinct evidence and exposes alternative action views", () => {
  const attribution = buildObservedAttribution(diagnose([
    fill("entry", "bid", 100, 2, 1, at(0), "decision-entry", "ENTER"),
    fill("reduce", "ask", 110, 1, 1, at(HOUR), "decision-exit", "REDUCE"),
    fill("exit", "ask", 120, 1, 1, at(2 * HOUR), "decision-exit-2", "EXIT"),
  ]));

  assert.deepEqual(attribution.counts, {
    realizationSlices: 2,
    uniqueFillIds: 3,
    uniqueDecisionIds: 3,
    completedEpisodes: 1,
  });
  assert.equal(attribution.evidenceKind, "OBSERVED_LIVE_ATTRIBUTION");
  assert.equal(attribution.actionDimensions.entry.kind, "ENTRY_LOT_ATTRIBUTION");
  assert.equal(attribution.actionDimensions.exit.kind, "EXIT_FILL_ATTRIBUTION");
  assert.deepEqual(attribution.actionDimensions.entry.sourceContributions.SELECTED_STREAM.ENTER, {
    distinctFillIds: ["entry"],
    distinctDecisionIds: ["decision-entry"],
    sliceCount: 2,
    completedEpisodeCount: 1,
    realizedQuantity: 2,
    grossPnlKrw: { status: "KNOWN", value: 30 },
    observedFeeImpactKrw: { status: "KNOWN", value: 3 },
    netPnlKrw: { status: "KNOWN", value: 27 },
  });
  assert.deepEqual(attribution.actionDimensions.exit.sourceContributions.SELECTED_STREAM.REDUCE, {
    distinctFillIds: ["reduce"],
    distinctDecisionIds: ["decision-exit"],
    sliceCount: 1,
    completedEpisodeCount: 1,
    realizedQuantity: 1,
    grossPnlKrw: { status: "KNOWN", value: 10 },
    observedFeeImpactKrw: { status: "KNOWN", value: 1.5 },
    netPnlKrw: { status: "KNOWN", value: 8.5 },
  });
  assert.deepEqual(attribution.totals, {
    realizedQuantity: 2,
    grossPnlKrw: { status: "KNOWN", value: 30 },
    observedFeeImpactKrw: { status: "KNOWN", value: 3 },
    netPnlKrw: { status: "KNOWN", value: 27 },
  });
  assert.deepEqual(attribution.warnings, [{
    code: "ALTERNATIVE_ATTRIBUTION_VIEWS_MUST_NOT_BE_SUMMED",
    message: "Selected-stream entry-lot and exit-fill attribution are alternative views over the same selected-stream realization slices and must not be summed; opening-inventory exit attribution is a separate left-censored source view.",
  }]);
});

test("selected-stream totals exclude opening inventory and exit attribution separates sources", () => {
  const diagnostics = diagnosePerformance({
    openingPositions: [{ market: "KRW-BTC", quantity: 1, averagePriceKrw: 100 }],
    fills: [
      fill("selected-entry", "bid", 100, 1, 1, at(0), "decision-entry", "ENTER"),
      fill("shared-exit", "ask", 120, 2, 2, at(HOUR), "decision-exit", "EXIT"),
    ],
    policy: { breakevenToleranceKrw: 0 },
  });
  const attribution = buildObservedAttribution({
    matchResult: diagnostics.matchResult,
    diagnostics,
  });

  assert.deepEqual(attribution.totals, {
    realizedQuantity: 1,
    grossPnlKrw: { status: "KNOWN", value: 20 },
    observedFeeImpactKrw: { status: "KNOWN", value: 2 },
    netPnlKrw: { status: "KNOWN", value: 18 },
  });
  assert.deepEqual(attribution.openingInventoryTotals, {
    realizedQuantity: 1,
    grossPnlKrw: { status: "KNOWN", value: 20 },
    observedFeeImpactKrw: { status: "UNKNOWN", reasons: ["MISSING_FILL_FEE"] },
    netPnlKrw: { status: "UNKNOWN", reasons: ["MISSING_FILL_FEE"] },
  });
  assert.deepEqual(attribution.actionDimensions.exit.sourceContributions.SELECTED_STREAM.EXIT, {
    distinctFillIds: ["shared-exit"],
    distinctDecisionIds: ["decision-exit"],
    sliceCount: 1,
    completedEpisodeCount: 1,
    realizedQuantity: 1,
    grossPnlKrw: { status: "KNOWN", value: 20 },
    observedFeeImpactKrw: { status: "KNOWN", value: 2 },
    netPnlKrw: { status: "KNOWN", value: 18 },
  });
  assert.deepEqual(attribution.actionDimensions.exit.sourceContributions.OPENING.EXIT, {
    distinctFillIds: ["shared-exit"],
    distinctDecisionIds: ["decision-exit"],
    sliceCount: 1,
    completedEpisodeCount: 0,
    realizedQuantity: 1,
    grossPnlKrw: { status: "KNOWN", value: 20 },
    observedFeeImpactKrw: { status: "UNKNOWN", reasons: ["MISSING_FILL_FEE"] },
    netPnlKrw: { status: "UNKNOWN", reasons: ["MISSING_FILL_FEE"] },
  });
});

test("opening-only exit remains visible without contaminating selected-stream views", () => {
  const diagnostics = diagnosePerformance({
    openingPositions: [{ market: "KRW-BTC", quantity: 1, averagePriceKrw: 100 }],
    fills: [fill("opening-exit", "ask", 120, 1, 1, at(HOUR), "decision-exit", "EXIT")],
    policy: { breakevenToleranceKrw: 0 },
  });
  const attribution = buildObservedAttribution({
    matchResult: diagnostics.matchResult,
    diagnostics,
  });

  assert.deepEqual(attribution.totals, {
    realizedQuantity: 0,
    grossPnlKrw: { status: "KNOWN", value: 0 },
    observedFeeImpactKrw: { status: "KNOWN", value: 0 },
    netPnlKrw: { status: "KNOWN", value: 0 },
  });
  assert.equal(
    attribution.actionDimensions.entry.sourceContributions.SELECTED_STREAM.UNKNOWN.sliceCount,
    0,
  );
  assert.deepEqual(attribution.actionDimensions.exit.sourceContributions.OPENING.EXIT, {
    distinctFillIds: ["opening-exit"],
    distinctDecisionIds: ["decision-exit"],
    sliceCount: 1,
    completedEpisodeCount: 0,
    realizedQuantity: 1,
    grossPnlKrw: { status: "KNOWN", value: 20 },
    observedFeeImpactKrw: { status: "UNKNOWN", reasons: ["MISSING_FILL_FEE"] },
    netPnlKrw: { status: "UNKNOWN", reasons: ["MISSING_FILL_FEE"] },
  });
  assert.equal(attribution.evidenceGaps[0]?.code, "LEFT_CENSORED_OPENING_INVENTORY");
});

test("holding buckets use completed episodes at exact boundary values", () => {
  const attribution = buildObservedAttribution(diagnose([
    ...roundTrip("under", 0, 23 * HOUR + 59 * 60 * 1_000),
    ...roundTrip("day", 1, DAY),
    ...roundTrip("three-days", 2, 3 * DAY),
    ...roundTrip("seven-days", 3, 7 * DAY),
    ...roundTrip("fourteen-days", 4, 14 * DAY),
  ]));

  assert.deepEqual(attribution.holdingDurationBuckets, {
    under24Hours: 1,
    from24HoursToUnder3Days: 1,
    from3DaysToUnder7Days: 1,
    from7DaysToUnder14Days: 1,
    atLeast14Days: 1,
  });
});

test("open episodes are excluded from holding buckets and reported as structured evidence gaps", () => {
  const attribution = buildObservedAttribution(diagnose([
    fill("entry", "bid", 100, 2, 1, at(0), "decision-entry", "ENTER"),
    fill("partial", "ask", 120, 1, 1, at(HOUR), "decision-exit", "REDUCE"),
  ]));

  assert.equal(attribution.counts.completedEpisodes, 0);
  assert.deepEqual(attribution.holdingDurationBuckets, {
    under24Hours: 0,
    from24HoursToUnder3Days: 0,
    from3DaysToUnder7Days: 0,
    from7DaysToUnder14Days: 0,
    atLeast14Days: 0,
  });
  assert.deepEqual(attribution.evidenceGaps[0], {
    code: "OPEN_EPISODE_EXCLUDED_FROM_COMPLETED_ANALYSIS",
    severity: "WARNING",
    scope: "POSITION_EPISODE",
    affectedMetrics: ["COMPLETED_EPISODE_COUNT", "HOLDING_DURATION_BUCKETS"],
    evidenceIds: ["KRW-BTC:entry"],
    message: "Open position episodes are excluded from completed-episode holding analysis.",
  });
});

test("opening inventory is left-censored evidence", () => {
  const diagnostics = diagnosePerformance({
    openingPositions: [{ market: "KRW-BTC", quantity: 1, averagePriceKrw: 100 }],
    fills: [fill("exit", "ask", 120, 1, 1, at(HOUR), "decision-exit", "EXIT")],
    policy: { breakevenToleranceKrw: 0 },
  });
  const attribution = buildObservedAttribution({
    matchResult: diagnostics.matchResult,
    diagnostics,
  });

  assert.deepEqual(attribution.evidenceGaps[0], {
    code: "LEFT_CENSORED_OPENING_INVENTORY",
    severity: "WARNING",
    scope: "ENTRY_LOT",
    affectedMetrics: ["ENTRY_ACTION_ATTRIBUTION", "GROSS_PNL_KRW", "OBSERVED_FEE_IMPACT_KRW", "NET_PNL_KRW"],
    evidenceIds: ["exit:opening:0"],
    message: "Opening inventory predates the selected stream and is left-censored for entry attribution.",
  });
});

test("unknown fee evidence remains unknown and is never converted to zero", () => {
  const attribution = buildObservedAttribution(diagnose([
    fill("entry", "bid", 100, 1, null, at(0), "decision-entry", "ENTER"),
    fill("exit", "ask", 120, 1, 1, at(HOUR), "decision-exit", "EXIT"),
  ]));

  assert.deepEqual(attribution.totals.grossPnlKrw, { status: "KNOWN", value: 20 });
  assert.equal(attribution.totals.observedFeeImpactKrw.status, "UNKNOWN");
  assert.equal(attribution.totals.netPnlKrw.status, "UNKNOWN");
  assert.deepEqual(attribution.evidenceGaps, [{
    code: "INCOMPLETE_FEE_EVIDENCE",
    severity: "WARNING",
    scope: "REALIZATION_SLICE",
    affectedMetrics: ["OBSERVED_FEE_IMPACT_KRW", "NET_PNL_KRW"],
    evidenceIds: ["exit:entry:0"],
    message: "One or more realization slices have incomplete fee evidence; fee impact and net PnL remain unknown.",
  }]);
});

test("unknown opening cost remains unknown and emits a structured evidence gap", () => {
  const diagnostics = diagnosePerformance({
    openingPositions: [{ market: "KRW-BTC", quantity: 1, averagePriceKrw: null }],
    fills: [fill("exit", "ask", 120, 1, 1, at(HOUR), "decision-exit", "EXIT")],
    policy: { breakevenToleranceKrw: 0 },
  });
  const attribution = buildObservedAttribution({
    matchResult: diagnostics.matchResult,
    diagnostics,
  });

  assert.equal(attribution.openingInventoryTotals.grossPnlKrw.status, "UNKNOWN");
  assert.equal(attribution.openingInventoryTotals.netPnlKrw.status, "UNKNOWN");
  assert.deepEqual(attribution.evidenceGaps[1], {
    code: "INCOMPLETE_COST_EVIDENCE",
    severity: "WARNING",
    scope: "REALIZATION_SLICE",
    affectedMetrics: ["GROSS_PNL_KRW", "NET_PNL_KRW"],
    evidenceIds: ["exit:opening:0"],
    message: "One or more realization slices have incomplete cost evidence; gross and net PnL remain unknown.",
  });
});

test("net PnL identifies missing cost evidence when fees are known", () => {
  const input = diagnose([
    fill("entry", "bid", 100, 1, 0, at(0), "decision-entry", "ENTER"),
    fill("exit", "ask", 120, 1, 1, at(HOUR), "decision-exit", "EXIT"),
  ]);
  const attribution = buildObservedAttribution({
    ...input,
    matchResult: withSlice(input.matchResult, {
      grossPnlBeforeFeesKrw: null,
      allocatedBuyFeeKrw: 0,
      allocatedSellFeeKrw: 1,
      netRealizedPnlKrw: null,
    }),
  });

  assert.deepEqual(attribution.totals.observedFeeImpactKrw, { status: "KNOWN", value: 1 });
  assert.deepEqual(attribution.totals.netPnlKrw, {
    status: "UNKNOWN",
    reasons: ["MISSING_FIFO_COST"],
  });
});

test("attribution rejects non-finite numeric evidence and negative holding durations", () => {
  const input = diagnose([
    fill("entry", "bid", 100, 1, 0, at(0), "decision-entry", "ENTER"),
    fill("exit", "ask", 120, 1, 1, at(HOUR), "decision-exit", "EXIT"),
  ]);

  for (const [patch, expected] of [
    [{ quantity: Number.NaN }, /quantity must be a finite positive number/],
    [{ grossPnlBeforeFeesKrw: Number.POSITIVE_INFINITY }, /grossPnlBeforeFeesKrw must be finite or null/],
    [{ netRealizedPnlKrw: Number.NaN }, /netRealizedPnlKrw must be finite or null/],
    [{ allocatedBuyFeeKrw: Number.POSITIVE_INFINITY }, /allocatedBuyFeeKrw must be finite or null/],
    [{ allocatedSellFeeKrw: Number.NaN }, /allocatedSellFeeKrw must be finite or null/],
    [{ holdingDurationMs: -1 }, /holdingDurationMs must be a finite non-negative number or null/],
  ] as const) {
    assert.throws(
      () => buildObservedAttribution({ ...input, matchResult: withSlice(input.matchResult, patch) }),
      expected,
    );
  }

  const episode = input.matchResult.episodes[0];
  if (episode === undefined) throw new Error("Expected a completed episode fixture.");
  assert.throws(
    () =>
      buildObservedAttribution({
        ...input,
        matchResult: {
          ...input.matchResult,
          episodes: [{ ...episode, holdingDurationMs: Number.NEGATIVE_INFINITY }],
        },
      }),
    /Episode .* holdingDurationMs must be a finite non-negative number or null/,
  );
});

function diagnose(fills: readonly PerformanceTradeFill[]) {
  const diagnostics = diagnosePerformance({
    fills,
    policy: { breakevenToleranceKrw: 0 },
  });
  return {
    matchResult: diagnostics.matchResult,
    diagnostics,
  };
}

function withSlice(
  matchResult: PerformanceTradeMatchResult,
  patch: Partial<FifoRealizationSlice>,
): PerformanceTradeMatchResult {
  return {
    ...matchResult,
    realizationSlices: matchResult.realizationSlices.map((slice, index) =>
      index === 0 ? { ...slice, ...patch } : slice,
    ),
  };
}

function roundTrip(
  id: string,
  index: number,
  holdingDurationMs: number,
): readonly PerformanceTradeFill[] {
  const openedAt = at(index * 20 * DAY);
  return [
    fill(`${id}-entry`, "bid", 100, 1, 0, openedAt, `decision-${id}-entry`, "ENTER"),
    fill(
      `${id}-exit`,
      "ask",
      110,
      1,
      0,
      at(index * 20 * DAY + holdingDurationMs),
      `decision-${id}-exit`,
      "EXIT",
    ),
  ];
}

function fill(
  id: string,
  side: "bid" | "ask",
  priceKrw: number,
  volume: number,
  feeKrw: number | null,
  filledAt: string,
  strategyDecisionId: string | null,
  decisionAction: "ENTER" | "ADD" | "REDUCE" | "EXIT" | null,
): PerformanceTradeFill {
  return {
    id,
    orderId: `order-${id}`,
    strategyDecisionId,
    decisionAction,
    market: "KRW-BTC",
    side,
    priceKrw,
    volume,
    feeKrw,
    filledAt,
  };
}

function at(offsetMs: number): string {
  return new Date(Date.UTC(2026, 7, 1) + offsetMs).toISOString();
}
