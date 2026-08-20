import assert from "node:assert/strict";

import {
  createVerifiedNoTradeCoverage,
  createVerifiedNoTradeCoverageFromRanges,
  partitionHourlyCoverage,
} from "../src/modules/performance/performance-hourly-coverage.js";
import type { CandleCoverageGap } from "../src/modules/performance/performance-candle-coverage.js";
import { test } from "./harness.js";

const SOURCE_BOUNDARY = {
  historyStartAt: "2026-04-20T00:00:00.000000000Z",
  endAt: "2026-04-20T08:00:00.000000000Z",
} as const;

test("hourly coverage assigns every expected interval to exactly one category", () => {
  const result = partitionHourlyCoverage({
    from: "2026-04-20T01:00:00.000000000Z",
    to: "2026-04-20T06:00:00.000000000Z",
    sourceBoundary: SOURCE_BOUNDARY,
    observedIntervals: [
      interval("2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z"),
      interval("2026-04-20T03:00:00Z", "2026-04-20T04:00:00Z"),
      interval("2026-04-20T05:00:00Z", "2026-04-20T06:00:00Z"),
    ],
    verifiedNoTradeRanges: [gap("2026-04-20T03:00:00Z", "2026-04-20T03:00:00Z", 1)],
  });

  assert.equal(result.expectedIntervalCount, 5);
  assert.equal(result.observedIntervalCount, 3);
  assert.equal(result.verifiedNoTradeIntervalCount, 1);
  assert.equal(result.unexplainedMissingIntervalCount, 1);
  assert.equal(
    result.observedIntervalCount
      + result.verifiedNoTradeIntervalCount
      + result.unexplainedMissingIntervalCount,
    result.expectedIntervalCount,
  );
  assert.deepEqual(result.observedIntervals, [
    key("2026-04-20T01:00:00.000000000Z", "2026-04-20T02:00:00.000000000Z"),
    key("2026-04-20T03:00:00.000000000Z", "2026-04-20T04:00:00.000000000Z"),
    key("2026-04-20T05:00:00.000000000Z", "2026-04-20T06:00:00.000000000Z"),
  ]);
  assert.deepEqual(result.verifiedNoTradeIntervals, [
    key("2026-04-20T02:00:00.000000000Z", "2026-04-20T03:00:00.000000000Z"),
  ]);
  assert.deepEqual(result.unexplainedMissingIntervals, [
    key("2026-04-20T04:00:00.000000000Z", "2026-04-20T05:00:00.000000000Z"),
  ]);
});

test("hourly coverage validates a full no-trade range before clipping it to [from,to)", () => {
  const authoritativeRange = gap("2026-04-20T02:00:00Z", "2026-04-20T05:00:00Z", 4);
  const result = partitionHourlyCoverage({
    from: "2026-04-20T02:00:00Z",
    to: "2026-04-20T04:00:00Z",
    sourceBoundary: SOURCE_BOUNDARY,
    observedIntervals: [],
    verifiedNoTradeRanges: [authoritativeRange],
  });

  assert.equal(result.expectedIntervalCount, 2);
  assert.equal(result.verifiedNoTradeIntervalCount, 2);
  assert.deepEqual(result.verifiedNoTradeIntervals, [
    key("2026-04-20T02:00:00.000000000Z", "2026-04-20T03:00:00.000000000Z"),
    key("2026-04-20T03:00:00.000000000Z", "2026-04-20T04:00:00.000000000Z"),
  ]);
  assert.deepEqual(result.verifiedNoTradeRanges, [{
    firstMissingCloseTime: "2026-04-20T03:00:00.000000000Z",
    lastMissingCloseTime: "2026-04-20T04:00:00.000000000Z",
    missingCandleCount: 2,
    previousObservedCloseTime: null,
    nextObservedCloseTime: null,
  }]);

  authoritativeRange.missingCandleCount = 99;
  assert.equal(result.verifiedNoTradeRanges[0]?.missingCandleCount, 2);
});

test("hourly coverage canonicalizes mixed timezone observations by epoch order", () => {
  const result = partitionHourlyCoverage({
    from: "2026-04-20T10:00:00+09:00",
    to: "2026-04-20T13:00:00+09:00",
    sourceBoundary: {
      historyStartAt: "2026-04-20T00:00:00Z",
      endAt: "2026-04-20T06:00:00Z",
    },
    observedIntervals: [
      interval("2026-04-20T12:00:00+09:00", "2026-04-20T13:00:00+09:00"),
      interval("2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z"),
    ],
    verifiedNoTradeRanges: [],
  });

  assert.deepEqual(result.observedIntervals, [
    key("2026-04-20T01:00:00.000000000Z", "2026-04-20T02:00:00.000000000Z"),
    key("2026-04-20T03:00:00.000000000Z", "2026-04-20T04:00:00.000000000Z"),
  ]);
  assert.deepEqual(result.unexplainedMissingIntervals, [
    key("2026-04-20T02:00:00.000000000Z", "2026-04-20T03:00:00.000000000Z"),
  ]);
});

test("hourly coverage preserves a nanosecond source-boundary phase", () => {
  const result = partitionHourlyCoverage({
    from: "2026-04-20T10:00:00.000000100+09:00",
    to: "2026-04-20T12:00:00.000000100+09:00",
    sourceBoundary: {
      historyStartAt: "2026-04-20T01:00:00.000000100Z",
      endAt: "2026-04-20T04:00:00.000000100Z",
    },
    observedIntervals: [
      interval("2026-04-20T01:00:00.000000100Z", "2026-04-20T02:00:00.000000100Z"),
      interval("2026-04-20T02:00:00.000000100Z", "2026-04-20T03:00:00.000000100Z"),
    ],
    verifiedNoTradeRanges: [],
  });

  assert.equal(result.expectedIntervalCount, 2);
  assert.equal(result.observedIntervalCount, 2);
});

test("verified no-trade authority is derived from anomaly-free source observations", () => {
  assert.throws(
    () => createVerifiedNoTradeCoverage({
      sourceBoundary: SOURCE_BOUNDARY,
      observedIntervals: [],
    }),
    /at least one observed source interval/i,
  );

  const missing = gap("2026-04-20T03:00:00Z", "2026-04-20T03:00:00Z", 1);
  const observedIntervals = observedIntervalsExcludingGaps(SOURCE_BOUNDARY, [missing]);
  const approved = createVerifiedNoTradeCoverage({
    sourceBoundary: SOURCE_BOUNDARY,
    observedIntervals,
  });
  observedIntervals.length = 0;
  assert.deepEqual(approved.ranges, [{
    firstMissingCloseTime: "2026-04-20T03:00:00.000000000Z",
    lastMissingCloseTime: "2026-04-20T03:00:00.000000000Z",
    missingCandleCount: 1,
    previousObservedCloseTime: "2026-04-20T02:00:00.000000000Z",
    nextObservedCloseTime: "2026-04-20T04:00:00.000000000Z",
  }]);

  const duplicate = interval("2026-04-20T00:00:00Z", "2026-04-20T01:00:00Z");
  assert.throws(
    () => createVerifiedNoTradeCoverage({
      sourceBoundary: SOURCE_BOUNDARY,
      observedIntervals: [duplicate, duplicate],
    }),
    /duplicate observed/i,
  );
});

test("explicit verified no-trade authority rejects an omitted missing range", () => {
  const first = gap("2026-04-20T03:00:00Z", "2026-04-20T03:00:00Z", 1);
  const second = gap("2026-04-20T06:00:00Z", "2026-04-20T06:00:00Z", 1);
  assert.throws(
    () => createVerifiedNoTradeCoverageFromRanges({
      sourceBoundary: SOURCE_BOUNDARY,
      observedIntervals: observedIntervalsExcludingGaps(SOURCE_BOUNDARY, [first, second]),
      verifiedNoTradeRanges: [first],
    }),
    /unexplained missing hourly interval/i,
  );
});

test("hourly coverage rejects malformed, non-canonical, and contradictory evidence", () => {
  const base = {
    from: "2026-04-20T01:00:00Z",
    to: "2026-04-20T05:00:00Z",
    sourceBoundary: SOURCE_BOUNDARY,
    observedIntervals: [] as ReturnType<typeof interval>[],
    verifiedNoTradeRanges: [] as CandleCoverageGap[],
  };

  assert.throws(() => partitionHourlyCoverage({ ...base, from: base.to }), /from.*before.*to/i);
  assert.throws(
    () => partitionHourlyCoverage({
      ...base,
      sourceBoundary: { ...SOURCE_BOUNDARY, endAt: "2026-04-20T08:30:00Z" },
    }),
    /sourceBoundary.*endAt.*aligned/i,
  );
  assert.throws(
    () => partitionHourlyCoverage({ ...base, from: "2026-04-20T01:30:00Z" }),
    /aligned.*hour/i,
  );
  assert.throws(
    () => partitionHourlyCoverage({
      ...base,
      sourceBoundary: { ...SOURCE_BOUNDARY, historyStartAt: "2026-04-20T02:00:00Z" },
    }),
    /outside.*sourceBoundary/i,
  );
  assert.throws(
    () => partitionHourlyCoverage({
      ...base,
      observedIntervals: [interval(base.from, "2026-04-20T02:00:00Z"), interval(base.from, "2026-04-20T02:00:00Z")],
    }),
    /duplicate observed/i,
  );
  assert.throws(
    () => partitionHourlyCoverage({
      ...base,
      verifiedNoTradeRanges: [gap("2026-04-20T02:00:00Z", "2026-04-20T03:00:00Z", 1)],
    }),
    /missingCandleCount/i,
  );
  assert.throws(
    () => partitionHourlyCoverage({
      ...base,
      verifiedNoTradeRanges: [
        gap("2026-04-20T02:00:00Z", "2026-04-20T02:00:00Z", 1),
        gap("2026-04-20T03:00:00Z", "2026-04-20T03:00:00Z", 1),
      ],
    }),
    /adjacent.*canonical/i,
  );
  assert.throws(
    () => partitionHourlyCoverage({
      ...base,
      verifiedNoTradeRanges: [
        gap("2026-04-20T02:00:00Z", "2026-04-20T03:00:00Z", 2),
        gap("2026-04-20T03:00:00Z", "2026-04-20T04:00:00Z", 2),
      ],
    }),
    /overlap/i,
  );
  assert.throws(
    () => partitionHourlyCoverage({
      ...base,
      observedIntervals: [interval("2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z")],
      verifiedNoTradeRanges: [gap("2026-04-20T02:00:00Z", "2026-04-20T02:00:00Z", 1)],
    }),
    /collision/i,
  );
  assert.throws(
    () => partitionHourlyCoverage({
      ...base,
      verifiedNoTradeRanges: [gap("2026-04-20T09:00:00Z", "2026-04-20T09:00:00Z", 1)],
    }),
    /outside.*sourceBoundary/i,
  );
  assert.throws(
    () => partitionHourlyCoverage({
      ...base,
      observedIntervals: [
        interval("2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z"),
        interval("2026-04-20T03:00:00Z", "2026-04-20T04:00:00Z"),
      ],
      verifiedNoTradeRanges: [{
        ...gap("2026-04-20T03:00:00Z", "2026-04-20T03:00:00Z", 1),
        previousObservedCloseTime: null,
      }],
    }),
    /previousObservedCloseTime.*contradicts/i,
  );
  assert.throws(
    () => partitionHourlyCoverage({
      ...base,
      observedIntervals: [interval("2026-04-20T01:00:00Z", "2026-04-20T02:00:00Z")],
      verifiedNoTradeRanges: [gap("2026-04-20T03:00:00Z", "2026-04-20T03:00:00Z", 1)],
    }),
    /nextObservedCloseTime.*observed interval/i,
  );
});

function interval(openTime: string, closeTime: string) {
  return { openTime, closeTime };
}

function observedIntervalsExcludingGaps(
  boundary: { historyStartAt: string; endAt: string },
  gaps: readonly CandleCoverageGap[],
) {
  const result: ReturnType<typeof interval>[] = [];
  for (
    let open = Date.parse(boundary.historyStartAt);
    open < Date.parse(boundary.endAt);
    open += 3_600_000
  ) {
    const close = open + 3_600_000;
    const missing = gaps.some((range) =>
      close >= Date.parse(range.firstMissingCloseTime)
      && close <= Date.parse(range.lastMissingCloseTime)
    );
    if (!missing) result.push(interval(new Date(open).toISOString(), new Date(close).toISOString()));
  }
  return result;
}

function gap(firstMissingCloseTime: string, lastMissingCloseTime: string, missingCandleCount: number): CandleCoverageGap {
  const previous = new Date(Date.parse(firstMissingCloseTime) - 3_600_000).toISOString();
  const next = new Date(Date.parse(lastMissingCloseTime) + 3_600_000).toISOString();
  return {
    firstMissingCloseTime,
    lastMissingCloseTime,
    missingCandleCount,
    previousObservedCloseTime: Date.parse(previous) <= Date.parse(SOURCE_BOUNDARY.historyStartAt)
      ? null
      : previous,
    nextObservedCloseTime: Date.parse(next) > Date.parse(SOURCE_BOUNDARY.endAt)
      ? null
      : next,
  };
}

function key(openTime: string, closeTime: string): string {
  return `${openTime}/${closeTime}`;
}
