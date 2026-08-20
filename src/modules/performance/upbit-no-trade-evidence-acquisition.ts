import { createHash } from "node:crypto";

import type {
  UpbitCandleSnapshot,
  UpbitGetOneMinuteCandlesRequest,
  UpbitSpotMarket,
} from "../exchange/upbit/contracts.js";
import {
  classifyIndependentNoTradeCoverage,
  computeResearchNoTradeEvidenceSha256,
  parseResearchNoTradeEvidence,
  validateResearchNoTradeEvidenceForDataset,
  type ResearchNoTradeEvidence,
  type ResearchNoTradeEvidenceWithoutChecksum,
  type ResearchNoTradeQuerySegment,
  type ResearchNoTradeRange,
} from "./research-no-trade-evidence.js";
import {
  parseResearchCandleDataset,
  type ResearchCandleDataset,
} from "./research-candle-dataset.js";
import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
  type PerformanceTimestamp,
} from "./performance-timestamp.js";

const SOURCE = "upbit-public-independent-no-trade-collector" as const;
const COLLECTOR_VERSION = "upbit-no-trade-evidence-v1";
const HOUR_NANOSECONDS = 3_600_000_000_000n;
const UPBIT_UTC_WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/;

export interface ResearchNoTradeMinuteCandleReader {
  getMinuteCandles(request: UpbitGetOneMinuteCandlesRequest): Promise<readonly UpbitCandleSnapshot[]>;
}

export type AcquireUpbitNoTradeEvidenceInput = {
  parentDataset: ResearchCandleDataset;
  collectedAt: string;
  pageSize: number;
  pageLimit: number;
};

export type AcquiredUpbitNoTradeEvidence = {
  evidence: ResearchNoTradeEvidence;
  json: string;
  segmentCount: number;
  pageCount: number;
  verifiedRangeCount: number;
  source: typeof SOURCE;
  boundary: {
    sqlite: false;
    privateExchange: false;
    telegram: false;
    scheduler: false;
    strategyExecution: false;
    orders: false;
  };
};

export type NoTradeFingerprintRow = {
  market: "KRW-BTC" | "KRW-ETH";
  unit: 1;
  openTime: string;
  openingPrice: number;
  highPrice: number;
  lowPrice: number;
  tradePrice: number;
  exchangeTimestamp: number;
  quoteVolume: number;
  volume: number;
};

export type NoTradeResponseFingerprintPage = {
  requestTo: string;
  rawRowCount: number;
  rows: readonly NoTradeFingerprintRow[];
};

export function computeNoTradeResponseFingerprint(input: {
  asset: "BTC" | "ETH";
  market: "KRW-BTC" | "KRW-ETH";
  from: string;
  to: string;
  pageSize: number;
  requestPages: readonly NoTradeResponseFingerprintPage[];
  terminalReason: "CROSSED_RANGE_START" | "SOURCE_EXHAUSTED";
}): string {
  const validated = validateFingerprintInput(input);
  return createHash("sha256").update(canonicalJson({
    schema: "UPBIT_NO_TRADE_RESPONSE_FINGERPRINT_V1",
    collectorVersion: COLLECTOR_VERSION,
    asset: validated.asset,
    market: validated.market,
    unit: 1,
    from: validated.from,
    to: validated.to,
    pageSize: validated.pageSize,
    requestPages: validated.requestPages,
    terminalReason: validated.terminalReason,
  }), "utf8").digest("hex");
}

function validateFingerprintInput(input: {
  asset: "BTC" | "ETH";
  market: "KRW-BTC" | "KRW-ETH";
  from: string;
  to: string;
  pageSize: number;
  requestPages: readonly NoTradeResponseFingerprintPage[];
  terminalReason: "CROSSED_RANGE_START" | "SOURCE_EXHAUSTED";
}): {
  asset: "BTC" | "ETH";
  market: "KRW-BTC" | "KRW-ETH";
  from: string;
  to: string;
  pageSize: number;
  requestPages: NoTradeResponseFingerprintPage[];
  terminalReason: "CROSSED_RANGE_START" | "SOURCE_EXHAUSTED";
} {
  if (input === null || typeof input !== "object") throw new Error("No-trade response fingerprint input must be an object.");
  if (input.asset !== "BTC" && input.asset !== "ETH") throw new Error("No-trade response fingerprint asset must be BTC or ETH.");
  const expectedMarket = input.asset === "BTC" ? "KRW-BTC" : "KRW-ETH";
  if (input.market !== expectedMarket) throw new Error(`No-trade response fingerprint market must be ${expectedMarket} for ${input.asset}.`);
  assertPagination(input.pageSize, 1);
  const from = requireTimestamp(input.from, "fingerprint from");
  const to = requireTimestamp(input.to, "fingerprint to");
  if (compareEpochNanoseconds(from.epochNanoseconds, to.epochNanoseconds) >= 0) {
    throw new Error("No-trade response fingerprint from must be before to.");
  }
  if (!Array.isArray(input.requestPages) || input.requestPages.length === 0) {
    throw new Error("No-trade response fingerprint requestPages must be a non-empty array.");
  }
  if (input.terminalReason !== "CROSSED_RANGE_START" && input.terminalReason !== "SOURCE_EXHAUSTED") {
    throw new Error("No-trade response fingerprint terminalReason is unsupported.");
  }

  let previousCursor: PerformanceTimestamp | null = null;
  let expectedCursor: PerformanceTimestamp | null = null;
  let previousPageWasEmpty = false;
  let previousPageCrossedRangeStart = false;
  const pages = input.requestPages.map((page, pageIndex) => {
    if (page === null || typeof page !== "object") throw new Error(`No-trade response fingerprint page ${pageIndex} must be an object.`);
    if (!Number.isSafeInteger(page.rawRowCount) || page.rawRowCount < 0) {
      throw new Error(`No-trade response fingerprint page ${pageIndex} rawRowCount must be a non-negative safe integer.`);
    }
    if (!Array.isArray(page.rows) || page.rawRowCount !== page.rows.length) {
      throw new Error(`No-trade response fingerprint page ${pageIndex} rawRowCount must equal its row membership.`);
    }
    const cursor = requireTimestamp(page.requestTo, `fingerprint page ${pageIndex} requestTo`);
    if (pageIndex === 0 && compareEpochNanoseconds(cursor.epochNanoseconds, to.epochNanoseconds) !== 0) {
      throw new Error("No-trade response fingerprint first request cursor must equal to.");
    }
    if (pageIndex > 0) {
      if (previousPageWasEmpty) {
        throw new Error("No-trade response fingerprint empty response pages must be terminal.");
      }
      if (expectedCursor === null || compareEpochNanoseconds(cursor.epochNanoseconds, expectedCursor.epochNanoseconds) !== 0) {
        throw new Error("No-trade response fingerprint request cursor must equal the prior page's oldest unique open.");
      }
      if (previousPageCrossedRangeStart) {
        throw new Error("No-trade response fingerprint a page crossing the range start must be terminal.");
      }
    }
    if (
      compareEpochNanoseconds(cursor.epochNanoseconds, from.epochNanoseconds) < 0 ||
      compareEpochNanoseconds(cursor.epochNanoseconds, to.epochNanoseconds) > 0 ||
      (previousCursor !== null && compareEpochNanoseconds(cursor.epochNanoseconds, previousCursor.epochNanoseconds) >= 0)
    ) {
      throw new Error("No-trade response fingerprint request cursors must strictly decrease within the requested range.");
    }
    previousCursor = cursor;
    const rows = page.rows.map((row: NoTradeFingerprintRow, rowIndex: number) =>
      validateFingerprintRow(row, input.market, pageIndex, rowIndex));
    rows.sort(compareFingerprintRows);
    const uniqueRows = collapseIdenticalRows(rows);
    for (const row of uniqueRows) {
      const open = requireTimestamp(row.openTime, "fingerprint row openTime");
      if (compareEpochNanoseconds(open.epochNanoseconds, cursor.epochNanoseconds) >= 0) {
        throw new Error("No-trade response fingerprint response rows must be strictly before their request cursor.");
      }
      if (
        compareEpochNanoseconds(open.epochNanoseconds, from.epochNanoseconds) >= 0 &&
        compareEpochNanoseconds(open.epochNanoseconds, to.epochNanoseconds) < 0
      ) {
        throw new Error("No-trade response fingerprint cannot contain a 1m candle inside the parent gap.");
      }
    }
    previousPageWasEmpty = rows.length === 0;
    if (previousPageWasEmpty && pageIndex < input.requestPages.length - 1) {
      throw new Error("No-trade response fingerprint empty response pages must be terminal.");
    }
    expectedCursor = previousPageWasEmpty
      ? null
      : requireTimestamp(uniqueRows.at(-1)!.openTime, "fingerprint page oldest unique openTime");
    previousPageCrossedRangeStart = expectedCursor !== null &&
      compareEpochNanoseconds(expectedCursor.epochNanoseconds, from.epochNanoseconds) < 0;
    return { requestTo: cursor.normalized, rawRowCount: page.rawRowCount, rows };
  });

  const terminalPage = pages.at(-1)!;
  if (input.terminalReason === "SOURCE_EXHAUSTED" && terminalPage.rows.length !== 0) {
    throw new Error("No-trade response fingerprint source exhaustion must end with an empty response page.");
  }
  if (input.terminalReason === "CROSSED_RANGE_START") {
    if (terminalPage.rows.length === 0) throw new Error("No-trade response fingerprint crossed-range terminal page must not be empty.");
    const oldest = collapseIdenticalRows(terminalPage.rows).at(-1)!;
    if (compareEpochNanoseconds(requireTimestamp(oldest.openTime, "terminal row openTime").epochNanoseconds, from.epochNanoseconds) >= 0) {
      throw new Error("No-trade response fingerprint crossed-range terminal page must contain an open before from.");
    }
  }

  return {
    asset: input.asset,
    market: input.market,
    from: from.normalized,
    to: to.normalized,
    pageSize: input.pageSize,
    requestPages: pages,
    terminalReason: input.terminalReason,
  };
}

function validateFingerprintRow(
  row: NoTradeFingerprintRow,
  market: "KRW-BTC" | "KRW-ETH",
  pageIndex: number,
  rowIndex: number,
): NoTradeFingerprintRow {
  if (row === null || typeof row !== "object") throw new Error(`No-trade response fingerprint page ${pageIndex} row ${rowIndex} must be an object.`);
  if (row.market !== market) throw new Error(`No-trade response fingerprint page ${pageIndex} row ${rowIndex} market does not match the request.`);
  if (row.unit !== 1) throw new Error(`No-trade response fingerprint page ${pageIndex} row ${rowIndex} unit must be 1.`);
  return {
    market,
    unit: 1,
    openTime: requireTimestamp(row.openTime, `fingerprint page ${pageIndex} row ${rowIndex} openTime`).normalized,
    openingPrice: requireNonNegativeFinite(row.openingPrice, `fingerprint page ${pageIndex} row ${rowIndex} openingPrice`),
    highPrice: requireNonNegativeFinite(row.highPrice, `fingerprint page ${pageIndex} row ${rowIndex} highPrice`),
    lowPrice: requireNonNegativeFinite(row.lowPrice, `fingerprint page ${pageIndex} row ${rowIndex} lowPrice`),
    tradePrice: requireNonNegativeFinite(row.tradePrice, `fingerprint page ${pageIndex} row ${rowIndex} tradePrice`),
    exchangeTimestamp: requireSafeTimestamp(row.exchangeTimestamp, `fingerprint page ${pageIndex} row ${rowIndex} exchangeTimestamp`),
    quoteVolume: requireNonNegativeFinite(row.quoteVolume, `fingerprint page ${pageIndex} row ${rowIndex} quoteVolume`),
    volume: requireNonNegativeFinite(row.volume, `fingerprint page ${pageIndex} row ${rowIndex} volume`),
  };
}

export async function acquireUpbitNoTradeEvidence(
  reader: ResearchNoTradeMinuteCandleReader,
  input: AcquireUpbitNoTradeEvidenceInput,
): Promise<AcquiredUpbitNoTradeEvidence> {
  const parent = parseResearchCandleDataset(JSON.stringify(input.parentDataset));
  const collectedAt = requireTimestamp(input.collectedAt, "collectedAt");
  const parentEnd = requireTimestamp(parent.provenance.endAt, "parent endAt");
  if (compareEpochNanoseconds(collectedAt.epochNanoseconds, parentEnd.epochNanoseconds) < 0) {
    throw new Error("No-trade evidence collectedAt must be at or after the parent endAt.");
  }
  assertPagination(input.pageSize, input.pageLimit);

  const coverage = classifyIndependentNoTradeCoverage(parent);
  const ranges = splitHourlyRanges(coverage.missingRanges);
  const segments: ResearchNoTradeQuerySegment[] = [];
  let pageCount = 0;

  for (const range of ranges) {
    const acquired = await collectSegment(reader, {
      asset: parent.provenance.asset,
      market: parent.provenance.market,
      range,
      pageSize: input.pageSize,
      pageLimit: input.pageLimit,
    });
    segments.push(acquired.segment);
    pageCount += acquired.pageCount;
  }

  const unsigned: ResearchNoTradeEvidenceWithoutChecksum = {
    provenance: {
      schemaVersion: 1,
      evidenceKind: "INDEPENDENT_NO_TRADE_EVIDENCE_V1",
      asset: parent.provenance.asset,
      market: parent.provenance.market,
      parentDatasetSha256: parent.provenance.sha256,
      from: parent.provenance.historyStartAt,
      to: parent.provenance.endAt,
      source: SOURCE,
      lowerTimeframe: "1m",
      collectorVersion: COLLECTOR_VERSION,
      collectedAt: collectedAt.normalized,
    },
    querySegments: segments,
    verifiedNoTradeRanges: ranges,
  };
  const evidence = parseResearchNoTradeEvidence(JSON.stringify({
    ...unsigned,
    provenance: { ...unsigned.provenance, sha256: computeResearchNoTradeEvidenceSha256(unsigned) },
  }));
  validateResearchNoTradeEvidenceForDataset(evidence, parent);

  return {
    evidence,
    json: `${JSON.stringify(evidence, null, 2)}\n`,
    segmentCount: segments.length,
    pageCount,
    verifiedRangeCount: ranges.length,
    source: SOURCE,
    boundary: Object.freeze({
      sqlite: false,
      privateExchange: false,
      telegram: false,
      scheduler: false,
      strategyExecution: false,
      orders: false,
    }),
  };
}

async function collectSegment(
  reader: ResearchNoTradeMinuteCandleReader,
  input: {
    asset: "BTC" | "ETH";
    market: UpbitSpotMarket;
    range: ResearchNoTradeRange;
    pageSize: number;
    pageLimit: number;
  },
): Promise<{ segment: ResearchNoTradeQuerySegment; pageCount: number }> {
  const from = requireTimestamp(input.range.from, "segment from");
  const to = requireTimestamp(input.range.to, "segment to");
  let cursor = to;
  const requestPages: NoTradeResponseFingerprintPage[] = [];

  for (let page = 0; page < input.pageLimit; page += 1) {
    const requestTo = cursor.normalized;
    const response = await reader.getMinuteCandles({
      market: input.market,
      unit: 1,
      count: input.pageSize,
      to: requestTo,
    });
    if (!Array.isArray(response)) {
      throw new Error("Upbit minute candle response must be an array.");
    }
    const rows = response.map((candidate, index) => normalizeRow(candidate, input.market, index));
    rows.sort(compareFingerprintRows);
    requestPages.push({ requestTo, rawRowCount: response.length, rows });

    if (rows.length === 0) return completedSegment(input, requestPages, "SOURCE_EXHAUSTED");

    const uniqueRows = collapseIdenticalRows(rows);
    for (const row of uniqueRows) {
      const open = requireTimestamp(row.openTime, "minute candle openTime");
      if (compareEpochNanoseconds(open.epochNanoseconds, cursor.epochNanoseconds) >= 0) {
        throw new Error("Upbit minute candle open time must be strictly before the request cursor.");
      }
      if (
        compareEpochNanoseconds(open.epochNanoseconds, from.epochNanoseconds) >= 0 &&
        compareEpochNanoseconds(open.epochNanoseconds, to.epochNanoseconds) < 0
      ) {
        throw new Error("Parent gap contains a 1m candle and cannot be certified as no-trade evidence.");
      }
    }

    const oldest = uniqueRows.at(-1)!;
    const oldestOpen = requireTimestamp(oldest.openTime, "oldest minute candle openTime");
    if (compareEpochNanoseconds(oldestOpen.epochNanoseconds, from.epochNanoseconds) < 0) {
      return completedSegment(input, requestPages, "CROSSED_RANGE_START");
    }
    if (compareEpochNanoseconds(oldestOpen.epochNanoseconds, cursor.epochNanoseconds) >= 0) {
      throw new Error("Upbit minute candle cursor did not strictly decrease.");
    }
    cursor = oldestOpen;
  }

  throw new Error(`No-trade evidence pagination did not complete within pageLimit=${input.pageLimit}.`);
}

function completedSegment(
  input: { asset: "BTC" | "ETH"; market: UpbitSpotMarket; range: ResearchNoTradeRange; pageSize: number },
  requestPages: readonly NoTradeResponseFingerprintPage[],
  terminalReason: "CROSSED_RANGE_START" | "SOURCE_EXHAUSTED",
): { segment: ResearchNoTradeQuerySegment; pageCount: number } {
  return {
    segment: {
      from: input.range.from,
      to: input.range.to,
      paginationComplete: true,
      responseFingerprint: computeNoTradeResponseFingerprint({
        asset: input.asset,
        market: input.market,
        from: input.range.from,
        to: input.range.to,
        pageSize: input.pageSize,
        requestPages,
        terminalReason,
      }),
    },
    pageCount: requestPages.length,
  };
}

function normalizeRow(candidate: UpbitCandleSnapshot, market: UpbitSpotMarket, index: number): NoTradeFingerprintRow {
  if (candidate === null || typeof candidate !== "object") {
    throw new Error(`Upbit minute candle response row ${index} must be an object.`);
  }
  if (candidate.market !== market) throw new Error(`Upbit minute candle response row ${index} market does not match the request.`);
  if (candidate.unit !== 1) throw new Error(`Upbit minute candle response row ${index} unit must be 1.`);
  if (typeof candidate.candle_date_time_utc !== "string" || !UPBIT_UTC_WALL_CLOCK.test(candidate.candle_date_time_utc)) {
    throw new Error(`Upbit minute candle response row ${index} candle_date_time_utc must be a UTC wall-clock timestamp without an offset.`);
  }
  const openTime = requireTimestamp(`${candidate.candle_date_time_utc}Z`, `minute candle response row ${index} open`).normalized;
  return {
    market,
    unit: 1,
    openTime,
    openingPrice: requireNonNegativeFinite(candidate.opening_price, `minute candle response row ${index} opening_price`),
    highPrice: requireNonNegativeFinite(candidate.high_price, `minute candle response row ${index} high_price`),
    lowPrice: requireNonNegativeFinite(candidate.low_price, `minute candle response row ${index} low_price`),
    tradePrice: requireNonNegativeFinite(candidate.trade_price, `minute candle response row ${index} trade_price`),
    exchangeTimestamp: requireSafeTimestamp(candidate.timestamp, `minute candle response row ${index} timestamp`),
    quoteVolume: requireNonNegativeFinite(candidate.candle_acc_trade_price, `minute candle response row ${index} candle_acc_trade_price`),
    volume: requireNonNegativeFinite(candidate.candle_acc_trade_volume, `minute candle response row ${index} candle_acc_trade_volume`),
  };
}

function collapseIdenticalRows(rows: readonly NoTradeFingerprintRow[]): NoTradeFingerprintRow[] {
  const unique: NoTradeFingerprintRow[] = [];
  for (const row of rows) {
    const previous = unique.at(-1);
    if (previous === undefined || previous.openTime !== row.openTime) {
      unique.push(row);
      continue;
    }
    if (canonicalJson(previous) !== canonicalJson(row)) {
      throw new Error(`Upbit minute candle response contains conflicting duplicate rows at ${row.openTime}.`);
    }
  }
  return unique;
}

function splitHourlyRanges(ranges: readonly ResearchNoTradeRange[]): ResearchNoTradeRange[] {
  const segments: ResearchNoTradeRange[] = [];
  for (const range of ranges) {
    const from = requireTimestamp(range.from, "missing range from");
    const to = requireTimestamp(range.to, "missing range to");
    if (from.epochNanoseconds % HOUR_NANOSECONDS !== 0n || to.epochNanoseconds % HOUR_NANOSECONDS !== 0n) {
      throw new Error("Missing no-trade ranges must be hour-aligned.");
    }
    for (let cursor = from.epochNanoseconds; cursor < to.epochNanoseconds; cursor += HOUR_NANOSECONDS) {
      segments.push({ from: formatTimestamp(cursor), to: formatTimestamp(cursor + HOUR_NANOSECONDS) });
    }
  }
  return segments;
}

function formatTimestamp(epochNanoseconds: bigint): string {
  const milliseconds = Number(epochNanoseconds / 1_000_000n);
  if (!Number.isSafeInteger(milliseconds) || epochNanoseconds % 1_000_000n !== 0n) {
    throw new Error("No-trade evidence timestamps must be representable in milliseconds.");
  }
  return new Date(milliseconds).toISOString();
}

function assertPagination(pageSize: number, pageLimit: number): void {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) {
    throw new Error("No-trade evidence pageSize must be a safe integer from 1 through 200.");
  }
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1) {
    throw new Error("No-trade evidence pageLimit must be a positive safe integer.");
  }
}

function requireTimestamp(value: string, label: string): PerformanceTimestamp {
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) throw new Error(`No-trade evidence ${label} must be an explicit-timezone ISO timestamp.`);
  return parsed;
}

function requireNonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Upbit ${label} must be a finite non-negative number.`);
  }
  return value;
}

function requireSafeTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Upbit ${label} must be a finite non-negative safe integer.`);
  }
  return value;
}

function compareFingerprintRows(left: NoTradeFingerprintRow, right: NoTradeFingerprintRow): number {
  const compared = compareEpochNanoseconds(
    requireTimestamp(right.openTime, "right fingerprint row openTime").epochNanoseconds,
    requireTimestamp(left.openTime, "left fingerprint row openTime").epochNanoseconds,
  );
  return compared !== 0 ? compared : canonicalJson(left).localeCompare(canonicalJson(right));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Canonical no-trade fingerprint values must be JSON-compatible.");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
