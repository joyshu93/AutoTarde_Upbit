import assert from "node:assert/strict";

import type { UpbitCandleSnapshot } from "../src/modules/exchange/upbit/contracts.js";
import {
  acquireUpbitNoTradeEvidence,
  computeNoTradeResponseFingerprint,
  type ResearchNoTradeMinuteCandleReader,
} from "../src/modules/performance/upbit-no-trade-evidence-acquisition.js";
import {
  calculateResearchCandleDatasetChecksum,
  parseResearchCandleDataset,
  type ResearchCandle,
  type ResearchCandleDataset,
} from "../src/modules/performance/research-candle-dataset.js";
import { test } from "./harness.js";

type DatasetInput = Omit<ResearchCandleDataset, "provenance"> & {
  provenance: Omit<ResearchCandleDataset["provenance"], "sha256">;
};

test("no-trade acquisition does not read public candles for a dense authenticated parent", async () => {
  await withFetchTrap(async () => {
    let reads = 0;
    const acquired = await acquireUpbitNoTradeEvidence({
      getMinuteCandles: async () => { reads += 1; return []; },
    }, validDenseInput());

    assert.equal(reads, 0);
    assert.deepEqual(acquired.evidence.querySegments, []);
    assert.deepEqual(acquired.evidence.verifiedNoTradeRanges, []);
    assert.equal(acquired.pageCount, 0);
  });
});

test("no-trade acquisition splits sparse parent missing hours into exact segments", async () => {
  await withFetchTrap(async () => {
    const calls: string[] = [];
    const acquired = await acquireUpbitNoTradeEvidence({
      getMinuteCandles: async (request) => {
        calls.push(`${request.unit}:${request.to}`);
        return [];
      },
    }, sparseInput());

    assert.deepEqual(calls, [
      "1:2026-08-01T01:00:00.000Z",
      "1:2026-08-01T03:00:00.000Z",
    ]);
    assert.deepEqual(acquired.evidence.verifiedNoTradeRanges, [
      { from: "2026-08-01T00:00:00.000Z", to: "2026-08-01T01:00:00.000Z" },
      { from: "2026-08-01T02:00:00.000Z", to: "2026-08-01T03:00:00.000Z" },
    ]);
  });
});

test("no-trade acquisition authenticates forged parents before the first reader call", async () => {
  await withFetchTrap(async () => {
    const parent = sparseInput().parentDataset;
    parent.candles["1h"][0]!.closePrice = 100.5;
    let reads = 0;
    await assert.rejects(
      acquireUpbitNoTradeEvidence({
        getMinuteCandles: async () => { reads += 1; return []; },
      }, { ...sparseInput(), parentDataset: parent }),
      /dataset checksum/i,
    );
    assert.equal(reads, 0);
  });
});

test("no-trade acquisition completes a segment only after crossing below from", async () => {
  await withFetchTrap(async () => {
    const requests: string[] = [];
    const pages = [[minuteAt("2026-07-31T23:59:00.000Z")]];
    const acquired = await acquireUpbitNoTradeEvidence({
      getMinuteCandles: async (request) => {
        requests.push(request.to ?? "none");
        return pages.shift() ?? [];
      },
    }, sparseSingleHourInput({ pageSize: 2, pageLimit: 3 }));

    assert.deepEqual(requests, ["2026-08-01T01:00:00.000Z"]);
    assert.equal(acquired.pageCount, 1);
  });
});

test("no-trade acquisition rejects a minute candle inside a missing parent hour", async () => {
  await withFetchTrap(async () => {
    await assert.rejects(
      acquireUpbitNoTradeEvidence(readerReturning([minuteAt("2026-08-01T00:30:00.000Z")]), sparseSingleHourInput()),
      /parent.*gap.*contains.*1m candle/i,
    );
  });
});

test("no-trade acquisition enforces source exhaustion, cursor, payload, and page-limit safety", async () => {
  const cases: Array<{ name: string; reader: ResearchNoTradeMinuteCandleReader; expected: RegExp; input?: Partial<ReturnType<typeof sparseSingleHourInput>> }> = [
    { name: "page limit", reader: readerReturning([]), expected: /pageLimit/i, input: { pageLimit: 0 } },
    { name: "cursor regression", reader: readerReturning([minuteAt("2026-08-01T01:00:00.000Z")]), expected: /strictly before.*cursor/i },
    { name: "wrong market", reader: readerReturning([{ ...minuteAt("2026-08-01T00:59:00.000Z"), market: "KRW-ETH" }]), expected: /market/i },
    { name: "wrong unit", reader: readerReturning([{ ...minuteAt("2026-08-01T00:59:00.000Z"), unit: 60 }]), expected: /unit/i },
    { name: "invalid timestamp", reader: readerReturning([{ ...minuteAt("2026-08-01T00:59:00.000Z"), candle_date_time_utc: "2026-08-01T00:59:00Z" }]), expected: /UTC wall-clock/i },
    { name: "invalid price", reader: readerReturning([{ ...minuteAt("2026-08-01T00:59:00.000Z"), opening_price: Number.NaN }]), expected: /finite non-negative/i },
    { name: "reader failure", reader: { getMinuteCandles: async () => { throw new Error("fixture API rejection"); } }, expected: /fixture API rejection/i },
  ];

  for (const entry of cases) {
    await withFetchTrap(async () => {
      const input = { ...sparseSingleHourInput(), ...entry.input };
      await assert.rejects(acquireUpbitNoTradeEvidence(entry.reader, input), entry.expected, entry.name);
    });
  }
});

test("no-trade response fingerprint is canonical and binds response membership", () => {
  const row = fingerprintRow("2026-07-31T23:59:00.000Z");
  const input = {
    asset: "BTC" as const,
    market: "KRW-BTC" as const,
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-01T01:00:00.000Z",
    pageSize: 2,
    requestPages: [{ requestTo: "2026-08-01T01:00:00.000Z", rawRowCount: 1, rows: [row] }],
    terminalReason: "CROSSED_RANGE_START" as const,
  };
  const original = computeNoTradeResponseFingerprint(input);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(original, "efa5e2ee364738f446811585a6c6a4e64cd53a70705ed639c144046a47d0d4cb");
  assert.notEqual(original, computeNoTradeResponseFingerprint({ ...input, requestPages: [{ ...input.requestPages[0]!, rows: [{ ...row, volume: 2 }] }] }));
  assert.notEqual(original, computeNoTradeResponseFingerprint({ ...input, terminalReason: "SOURCE_EXHAUSTED", requestPages: [{ ...input.requestPages[0]!, rawRowCount: 0, rows: [] }] }));
  assert.notEqual(original, computeNoTradeResponseFingerprint({ ...input, requestPages: [{ ...input.requestPages[0]!, rawRowCount: 2, rows: [row, row] }] }));
  assert.notEqual(original, computeNoTradeResponseFingerprint({
    ...input,
    asset: "ETH",
    market: "KRW-ETH",
    requestPages: [{ ...input.requestPages[0]!, rows: [{ ...row, market: "KRW-ETH" }] }],
  }));
  assert.notEqual(original, computeNoTradeResponseFingerprint({ ...input, from: "2026-07-31T23:59:30.000Z" }));
  assert.notEqual(original, computeNoTradeResponseFingerprint({ ...input, pageSize: 3 }));
  assert.throws(() => computeNoTradeResponseFingerprint({ ...input, requestPages: [{ ...input.requestPages[0]!, requestTo: "2026-08-01T00:59:00.000Z" }] }), /first request cursor/i);
  const reorderedRow = { volume: row.volume, quoteVolume: row.quoteVolume, exchangeTimestamp: row.exchangeTimestamp, tradePrice: row.tradePrice, lowPrice: row.lowPrice, highPrice: row.highPrice, openingPrice: row.openingPrice, openTime: row.openTime, unit: row.unit, market: row.market };
  assert.equal(original, computeNoTradeResponseFingerprint({ ...input, requestPages: [{ ...input.requestPages[0]!, rows: [reorderedRow] }] }));
  const olderRow = fingerprintRow("2026-07-31T23:58:00.000Z");
  const twoRows = { ...input, requestPages: [{ ...input.requestPages[0]!, rawRowCount: 2, rows: [row, olderRow] }] };
  assert.equal(
    computeNoTradeResponseFingerprint(twoRows),
    computeNoTradeResponseFingerprint({ ...twoRows, requestPages: [{ ...twoRows.requestPages[0]!, rows: [olderRow, row] }] }),
  );
});

test("no-trade response fingerprint rejects malformed declared evidence instead of canonicalizing it", () => {
  const valid = {
    asset: "BTC" as const,
    market: "KRW-BTC" as const,
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-01T01:00:00.000Z",
    pageSize: 2,
    requestPages: [{ requestTo: "2026-08-01T01:00:00.000Z", rawRowCount: 1, rows: [fingerprintRow("2026-07-31T23:59:00.000Z")] }],
    terminalReason: "CROSSED_RANGE_START" as const,
  };
  assert.throws(() => computeNoTradeResponseFingerprint({ ...valid, asset: "ETH" }), /market.*ETH/i);
  assert.throws(() => computeNoTradeResponseFingerprint({ ...valid, pageSize: 0 }), /pageSize/i);
  assert.throws(() => computeNoTradeResponseFingerprint({ ...valid, from: valid.to }), /from.*before.*to/i);
  assert.throws(() => computeNoTradeResponseFingerprint({ ...valid, requestPages: [{ ...valid.requestPages[0]!, rawRowCount: 2 }] }), /rawRowCount/i);
  assert.throws(() => computeNoTradeResponseFingerprint({
    ...valid,
    requestPages: [valid.requestPages[0]!, { ...valid.requestPages[0]!, requestTo: valid.to }],
  }), /must equal.*oldest unique open/i);
  assert.throws(() => computeNoTradeResponseFingerprint({ ...valid, requestPages: [{ ...valid.requestPages[0]!, rows: [{ ...valid.requestPages[0]!.rows[0]!, openingPrice: Number.NaN }] }] }), /finite non-negative/i);
  assert.throws(() => computeNoTradeResponseFingerprint({ ...valid, requestPages: [{ ...valid.requestPages[0]!, rows: [{ ...valid.requestPages[0]!.rows[0]!, exchangeTimestamp: Number.POSITIVE_INFINITY }] }] }), /safe integer/i);
});

test("no-trade response fingerprint rejects an empty middle page and cursor continuity substitutions", () => {
  const first = { requestTo: "2026-08-01T01:00:00.000Z", rawRowCount: 0, rows: [] };
  const later = {
    requestTo: "2026-08-01T00:30:00.000Z",
    rawRowCount: 1,
    rows: [fingerprintRow("2026-07-31T23:59:00.000Z")],
  };
  const base = {
    asset: "BTC" as const,
    market: "KRW-BTC" as const,
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-01T01:00:00.000Z",
    pageSize: 2,
    terminalReason: "CROSSED_RANGE_START" as const,
  };
  assert.throws(
    () => computeNoTradeResponseFingerprint({ ...base, requestPages: [first, later] }),
    /empty.*terminal/i,
  );

  const duplicate = fingerprintRow("2026-07-31T23:59:00.000Z");
  const oldest = fingerprintRow("2026-07-31T23:58:00.000Z");
  const chainedFirst = { requestTo: base.to, rawRowCount: 3, rows: [duplicate, oldest, duplicate] };
  const correctSecond = { requestTo: oldest.openTime, rawRowCount: 1, rows: [fingerprintRow("2026-07-31T23:57:00.000Z")] };
  assert.throws(
    () => computeNoTradeResponseFingerprint({ ...base, requestPages: [chainedFirst, correctSecond] }),
    /crossing the range start.*terminal/i,
  );
  assert.throws(
    () => computeNoTradeResponseFingerprint({ ...base, requestPages: [chainedFirst, { ...correctSecond, requestTo: "2026-07-31T23:57:30.000Z" }] }),
    /must equal.*oldest unique open/i,
  );
});

test("no-trade acquisition rejects an invalid explicit page limit before reading", async () => {
  await withFetchTrap(async () => {
    const reader = {
      getMinuteCandles: async () => [minuteAt("2026-07-31T23:59:00.000Z")],
    };
    await assert.rejects(acquireUpbitNoTradeEvidence(reader, { ...sparseSingleHourInput(), pageLimit: 0 }), /pageLimit/i);
  });
});

test("no-trade acquisition rejects conflicting duplicate rows and exact range boundaries", async () => {
  const conflicting = [
    minuteAt("2026-07-31T23:59:00.000Z"),
    { ...minuteAt("2026-07-31T23:59:00.000Z"), trade_price: 102 },
  ];
  await withFetchTrap(async () => {
    await assert.rejects(
      acquireUpbitNoTradeEvidence(readerReturning(conflicting), sparseSingleHourInput()),
      /conflicting duplicate/i,
    );
    await assert.rejects(
      acquireUpbitNoTradeEvidence(readerReturning([minuteAt("2026-08-01T00:00:00.000Z")]), sparseSingleHourInput()),
      /parent.*gap.*contains/i,
      "from is included",
    );
    await assert.rejects(
      acquireUpbitNoTradeEvidence(readerReturning([minuteAt("2026-08-01T01:00:00.000Z")]), sparseSingleHourInput()),
      /strictly before.*cursor/i,
      "to is excluded from range but invalid at the exclusive cursor",
    );
  });
});

function validDenseInput() {
  return {
    parentDataset: dataset([
      hourly("2026-08-01T00:00:00.000Z"),
      hourly("2026-08-01T01:00:00.000Z"),
      hourly("2026-08-01T02:00:00.000Z"),
    ]),
    collectedAt: "2026-08-01T04:00:00.000Z",
    pageSize: 2,
    pageLimit: 3,
  };
}

function sparseInput() {
  return {
    parentDataset: dataset([hourly("2026-08-01T01:00:00.000Z")]),
    collectedAt: "2026-08-01T04:00:00.000Z",
    pageSize: 2,
    pageLimit: 3,
  };
}

function sparseSingleHourInput(overrides: Record<string, unknown> = {}) {
  return { ...sparseInput(), parentDataset: dataset([hourly("2026-08-01T01:00:00.000Z")], "2026-08-01T02:00:00.000Z"), ...overrides } as ReturnType<typeof sparseInput>;
}

function dataset(candles: ResearchCandle[], endAt = "2026-08-01T03:00:00.000Z"): ResearchCandleDataset {
  const unsigned: DatasetInput = {
    provenance: { schemaVersion: 1, asset: "BTC", market: "KRW-BTC", historyStartAt: "2026-08-01T00:00:00.000Z", endAt, collectedAt: "2026-08-01T04:00:00.000Z", source: "fixture" },
    candles: { "1h": candles, "4h": [], "1d": [] },
  };
  return parseResearchCandleDataset(JSON.stringify({ ...unsigned, provenance: { ...unsigned.provenance, sha256: calculateResearchCandleDatasetChecksum(unsigned) } }));
}

function hourly(openTime: string): ResearchCandle {
  const open = new Date(openTime).getTime();
  return { market: "KRW-BTC", timeframe: "1h", openTime, closeTime: new Date(open + 3_600_000).toISOString(), openPrice: 100, highPrice: 102, lowPrice: 99, closePrice: 101, volume: 1, quoteVolume: 101 };
}

function readerReturning(page: readonly UpbitCandleSnapshot[]): ResearchNoTradeMinuteCandleReader {
  return { getMinuteCandles: async () => page };
}

function minuteAt(openTime: string): UpbitCandleSnapshot {
  return { market: "KRW-BTC", unit: 1, candle_date_time_utc: openTime.slice(0, -1), candle_date_time_kst: openTime, opening_price: 100, high_price: 102, low_price: 99, trade_price: 101, timestamp: Date.parse(openTime) + 30_000, candle_acc_trade_price: 101, candle_acc_trade_volume: 1 };
}

function fingerprintRow(openTime: string) {
  return { market: "KRW-BTC" as const, unit: 1 as const, openTime, openingPrice: 100, highPrice: 102, lowPrice: 99, tradePrice: 101, exchangeTimestamp: Date.parse(openTime), quoteVolume: 101, volume: 1 };
}

async function withFetchTrap(callback: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network access is forbidden in no-trade acquisition tests"); }) as typeof fetch;
  try { await callback(); } finally { globalThis.fetch = original; }
}
