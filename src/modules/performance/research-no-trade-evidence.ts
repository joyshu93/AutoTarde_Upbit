import { createHash } from "node:crypto";

import {
  parseResearchCandleDataset,
  type ResearchCandleDataset,
} from "./research-candle-dataset.js";
import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
  type PerformanceTimestamp,
} from "./performance-timestamp.js";

export type ResearchNoTradeEvidenceProvenance = {
  schemaVersion: 1;
  evidenceKind: "INDEPENDENT_NO_TRADE_EVIDENCE_V1";
  asset: ResearchAsset;
  market: ResearchMarket;
  parentDatasetSha256: string;
  from: string;
  to: string;
  source: string;
  lowerTimeframe: "1m";
  collectorVersion: string;
  collectedAt: string;
  sha256: string;
};

export type ResearchNoTradeQuerySegment = {
  from: string;
  to: string;
  paginationComplete: boolean;
  responseFingerprint: string;
};

export type ResearchNoTradeRange = {
  from: string;
  to: string;
};

export type ResearchNoTradeEvidence = {
  provenance: ResearchNoTradeEvidenceProvenance;
  querySegments: ResearchNoTradeQuerySegment[];
  verifiedNoTradeRanges: ResearchNoTradeRange[];
};

export type IndependentNoTradeCoverageStatus =
  | "DENSE"
  | "VERIFIED_SPARSE"
  | "UNVERIFIED_SPARSE";

export type IndependentNoTradeCoverage = {
  status: IndependentNoTradeCoverageStatus;
  missingRanges: ResearchNoTradeRange[];
  uncoveredRanges: ResearchNoTradeRange[];
};

type ResearchNoTradeEvidenceWithoutChecksum = Omit<ResearchNoTradeEvidence, "provenance"> & {
  provenance: Omit<ResearchNoTradeEvidenceProvenance, "sha256">;
};

const SHA256_HEX = /^[a-f0-9]{64}$/;
const HOUR_NANOSECONDS = 3_600_000_000_000n;
type ResearchAsset = "BTC" | "ETH";
type ResearchMarket = "KRW-BTC" | "KRW-ETH";

export function parseResearchNoTradeEvidence(json: string): ResearchNoTradeEvidence {
  if (typeof json !== "string" || json.trim().length === 0) {
    throw new Error("Research no-trade evidence JSON must not be empty.");
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Research no-trade evidence must be valid JSON.");
  }

  const evidence = parseEvidence(value, true) as ResearchNoTradeEvidence;
  const { sha256, ...provenance } = evidence.provenance;
  const expectedChecksum = computeResearchNoTradeEvidenceSha256({
    provenance,
    querySegments: evidence.querySegments,
    verifiedNoTradeRanges: evidence.verifiedNoTradeRanges,
  });
  if (sha256 !== expectedChecksum) {
    throw new Error("Research no-trade evidence checksum does not match declared sha256.");
  }

  return evidence;
}

export function computeResearchNoTradeEvidenceSha256(
  evidence: ResearchNoTradeEvidenceWithoutChecksum,
): string {
  const validated = parseEvidence(evidence, false) as ResearchNoTradeEvidenceWithoutChecksum;
  return createHash("sha256").update(canonicalJson(validated), "utf8").digest("hex");
}

export function validateResearchNoTradeEvidenceForDataset(
  evidence: ResearchNoTradeEvidence,
  dataset: ResearchCandleDataset,
): void {
  const validated = parseResearchNoTradeEvidence(JSON.stringify(evidence));
  const parent = parseResearchCandleDataset(JSON.stringify(dataset));
  const parentStart = requireTimestamp(parent.provenance.historyStartAt, "parent dataset historyStartAt");
  const parentEnd = requireTimestamp(parent.provenance.endAt, "parent dataset endAt");
  const evidenceStart = requireTimestamp(validated.provenance.from, "evidence from");
  const evidenceEnd = requireTimestamp(validated.provenance.to, "evidence to");

  if (validated.provenance.asset !== parent.provenance.asset) {
    throw new Error("Research no-trade evidence parent asset does not match the dataset.");
  }
  if (validated.provenance.market !== parent.provenance.market) {
    throw new Error("Research no-trade evidence parent market does not match the dataset.");
  }
  if (validated.provenance.parentDatasetSha256 !== parent.provenance.sha256) {
    throw new Error("Research no-trade evidence parent sha256 does not match the dataset.");
  }
  if (
    compareEpochNanoseconds(evidenceStart.epochNanoseconds, parentStart.epochNanoseconds) !== 0 ||
    compareEpochNanoseconds(evidenceEnd.epochNanoseconds, parentEnd.epochNanoseconds) !== 0
  ) {
    throw new Error("Research no-trade evidence parent range does not match the dataset.");
  }

  for (const range of validated.verifiedNoTradeRanges) {
    if (!isFullyCoveredByCompleteSegments(range, validated.querySegments)) {
      throw new Error("Research no-trade evidence verified ranges must be covered by complete query segments.");
    }
  }

  for (const candle of parent.candles["1h"]) {
    const open = requireTimestamp(candle.openTime, "parent observed hourly candle open");
    const close = requireTimestamp(candle.closeTime, "parent observed hourly candle close");
    if (validated.verifiedNoTradeRanges.some((range) => overlaps(range, open, close))) {
      throw new Error("Research no-trade evidence verified range overlaps an observed hourly candle.");
    }
  }
}

export function classifyIndependentNoTradeCoverage(
  dataset: ResearchCandleDataset,
  evidence?: ResearchNoTradeEvidence,
): IndependentNoTradeCoverage {
  const parent = parseResearchCandleDataset(JSON.stringify(dataset));
  const validatedEvidence = evidence === undefined
    ? undefined
    : parseResearchNoTradeEvidence(JSON.stringify(evidence));
  if (validatedEvidence !== undefined) {
    validateResearchNoTradeEvidenceForDataset(validatedEvidence, parent);
  }

  const historyStart = requireTimestamp(parent.provenance.historyStartAt, "parent dataset historyStartAt");
  const end = requireTimestamp(parent.provenance.endAt, "parent dataset endAt");
  const expectedHourlyIntervals = new Map<bigint, bigint>();
  for (
    let intervalOpen = ceilToHour(historyStart.epochNanoseconds);
    intervalOpen + HOUR_NANOSECONDS <= end.epochNanoseconds;
    intervalOpen += HOUR_NANOSECONDS
  ) {
    expectedHourlyIntervals.set(intervalOpen, intervalOpen + HOUR_NANOSECONDS);
  }

  const observedHourlyOpens = new Set<bigint>();
  for (const candle of parent.candles["1h"]) {
    const open = requireTimestamp(candle.openTime, "parent observed hourly candle open").epochNanoseconds;
    const close = requireTimestamp(candle.closeTime, "parent observed hourly candle close").epochNanoseconds;
    if (expectedHourlyIntervals.get(open) !== close) {
      throw new Error("Research no-trade coverage observed hourly candle must match an expected nominal hourly interval.");
    }
    observedHourlyOpens.add(open);
  }
  const missingStarts: bigint[] = [];
  for (const intervalStart of expectedHourlyIntervals.keys()) {
    if (!observedHourlyOpens.has(intervalStart)) missingStarts.push(intervalStart);
  }

  const missingRanges = groupNominalHourlyRanges(missingStarts);
  if (missingRanges.length === 0) {
    return { status: "DENSE", missingRanges, uncoveredRanges: [] };
  }

  const verifiedRanges = validatedEvidence?.verifiedNoTradeRanges ?? [];
  const uncoveredRanges = subtractVerifiedRanges(missingRanges, verifiedRanges);
  return {
    status: uncoveredRanges.length === 0 ? "VERIFIED_SPARSE" : "UNVERIFIED_SPARSE",
    missingRanges,
    uncoveredRanges,
  };
}

function parseEvidence(
  value: unknown,
  requiresChecksum: boolean,
): ResearchNoTradeEvidence | ResearchNoTradeEvidenceWithoutChecksum {
  const evidence = requireRecord(value, "Research no-trade evidence");
  assertExactKeys(evidence, ["provenance", "querySegments", "verifiedNoTradeRanges"], "Research no-trade evidence");
  const provenance = parseProvenance(evidence.provenance, requiresChecksum);
  const evidenceStart = requireTimestamp(provenance.from, "evidence from");
  const evidenceEnd = requireTimestamp(provenance.to, "evidence to");
  const querySegments = parseQuerySegments(evidence.querySegments, evidenceStart, evidenceEnd);
  const verifiedNoTradeRanges = parseRanges(
    evidence.verifiedNoTradeRanges,
    evidenceStart,
    evidenceEnd,
    "verifiedNoTradeRanges",
  );

  return { provenance, querySegments, verifiedNoTradeRanges } as ResearchNoTradeEvidence | ResearchNoTradeEvidenceWithoutChecksum;
}

function parseProvenance(
  value: unknown,
  requiresChecksum: boolean,
): ResearchNoTradeEvidenceProvenance | Omit<ResearchNoTradeEvidenceProvenance, "sha256"> {
  const provenance = requireRecord(value, "Research no-trade evidence provenance");
  assertExactKeys(
    provenance,
    requiresChecksum
      ? [
        "schemaVersion",
        "evidenceKind",
        "asset",
        "market",
        "parentDatasetSha256",
        "from",
        "to",
        "source",
        "lowerTimeframe",
        "collectorVersion",
        "collectedAt",
        "sha256",
      ]
      : [
        "schemaVersion",
        "evidenceKind",
        "asset",
        "market",
        "parentDatasetSha256",
        "from",
        "to",
        "source",
        "lowerTimeframe",
        "collectorVersion",
        "collectedAt",
      ],
    "Research no-trade evidence provenance",
  );

  if (provenance.schemaVersion !== 1) {
    throw new Error("Research no-trade evidence schemaVersion must be exactly 1.");
  }
  if (provenance.evidenceKind !== "INDEPENDENT_NO_TRADE_EVIDENCE_V1") {
    throw new Error("Research no-trade evidence kind is unsupported.");
  }
  const asset = requireAsset(provenance.asset);
  const market = requireMarket(provenance.market);
  if (market !== marketForAsset(asset)) {
    throw new Error(`Research no-trade evidence market must be ${marketForAsset(asset)} for ${asset}.`);
  }
  const from = requireTimestamp(provenance.from, "evidence from");
  const to = requireTimestamp(provenance.to, "evidence to");
  const collectedAt = requireTimestamp(provenance.collectedAt, "evidence collectedAt");
  if (compareEpochNanoseconds(from.epochNanoseconds, to.epochNanoseconds) >= 0) {
    throw new Error("Research no-trade evidence range must have from before to.");
  }
  if (compareEpochNanoseconds(to.epochNanoseconds, collectedAt.epochNanoseconds) > 0) {
    throw new Error("Research no-trade evidence collectedAt must be at or after to.");
  }
  if (!SHA256_HEX.test(requireNonEmptyString(provenance.parentDatasetSha256, "parentDatasetSha256"))) {
    throw new Error("Research no-trade evidence parentDatasetSha256 must be a lowercase SHA-256 hex digest.");
  }

  const parsed = {
    schemaVersion: 1 as const,
    evidenceKind: "INDEPENDENT_NO_TRADE_EVIDENCE_V1" as const,
    asset,
    market,
    parentDatasetSha256: provenance.parentDatasetSha256 as string,
    from: provenance.from as string,
    to: provenance.to as string,
    source: requireNonEmptyString(provenance.source, "source"),
    lowerTimeframe: requireLowerTimeframe(provenance.lowerTimeframe),
    collectorVersion: requireNonEmptyString(provenance.collectorVersion, "collectorVersion"),
    collectedAt: provenance.collectedAt as string,
  };
  if (!requiresChecksum) return parsed;

  if (typeof provenance.sha256 !== "string" || !SHA256_HEX.test(provenance.sha256)) {
    throw new Error("Research no-trade evidence sha256 must be a lowercase SHA-256 hex digest.");
  }
  return { ...parsed, sha256: provenance.sha256 };
}

function parseQuerySegments(
  value: unknown,
  evidenceStart: PerformanceTimestamp,
  evidenceEnd: PerformanceTimestamp,
): ResearchNoTradeQuerySegment[] {
  if (!Array.isArray(value)) throw new Error("Research no-trade evidence querySegments must be an array.");

  let previousEnd: PerformanceTimestamp | null = null;
  return value.map((candidate, index) => {
    const segment = requireRecord(candidate, `Research no-trade evidence querySegments[${index}]`);
    assertExactKeys(
      segment,
      ["from", "to", "paginationComplete", "responseFingerprint"],
      `Research no-trade evidence querySegments[${index}]`,
    );
    if (typeof segment.paginationComplete !== "boolean") {
      throw new Error(`Research no-trade evidence querySegments[${index}] paginationComplete must be a boolean.`);
    }
    if (typeof segment.responseFingerprint !== "string" || !SHA256_HEX.test(segment.responseFingerprint)) {
      throw new Error(`Research no-trade evidence querySegments[${index}] responseFingerprint must be a lowercase SHA-256 hex digest.`);
    }
    const from = requireTimestamp(segment.from, `querySegments[${index}].from`);
    const to = requireTimestamp(segment.to, `querySegments[${index}].to`);
    assertContainedRange(from, to, evidenceStart, evidenceEnd, `querySegments[${index}]`);
    if (previousEnd && compareEpochNanoseconds(previousEnd.epochNanoseconds, from.epochNanoseconds) > 0) {
      throw new Error("Research no-trade evidence querySegments must be ordered and non-overlapping.");
    }
    previousEnd = to;

    return {
      from: segment.from as string,
      to: segment.to as string,
      paginationComplete: segment.paginationComplete,
      responseFingerprint: segment.responseFingerprint,
    };
  });
}

function parseRanges(
  value: unknown,
  evidenceStart: PerformanceTimestamp,
  evidenceEnd: PerformanceTimestamp,
  label: string,
): ResearchNoTradeRange[] {
  if (!Array.isArray(value)) throw new Error(`Research no-trade evidence ${label} must be an array.`);

  let previousEnd: PerformanceTimestamp | null = null;
  return value.map((candidate, index) => {
    const range = requireRecord(candidate, `Research no-trade evidence ${label}[${index}]`);
    assertExactKeys(range, ["from", "to"], `Research no-trade evidence ${label}[${index}]`);
    const from = requireTimestamp(range.from, `${label}[${index}].from`);
    const to = requireTimestamp(range.to, `${label}[${index}].to`);
    assertContainedRange(from, to, evidenceStart, evidenceEnd, `${label}[${index}]`);
    if (previousEnd && compareEpochNanoseconds(previousEnd.epochNanoseconds, from.epochNanoseconds) > 0) {
      throw new Error(`Research no-trade evidence ${label} must be ordered and non-overlapping.`);
    }
    previousEnd = to;

    return { from: range.from as string, to: range.to as string };
  });
}

function assertContainedRange(
  from: PerformanceTimestamp,
  to: PerformanceTimestamp,
  containerFrom: PerformanceTimestamp,
  containerTo: PerformanceTimestamp,
  label: string,
): void {
  if (compareEpochNanoseconds(from.epochNanoseconds, to.epochNanoseconds) >= 0) {
    throw new Error(`Research no-trade evidence ${label} must have from before to.`);
  }
  if (
    compareEpochNanoseconds(from.epochNanoseconds, containerFrom.epochNanoseconds) < 0 ||
    compareEpochNanoseconds(to.epochNanoseconds, containerTo.epochNanoseconds) > 0
  ) {
    throw new Error(`Research no-trade evidence ${label} must be within the evidence range.`);
  }
}

function isFullyCoveredByCompleteSegments(
  range: ResearchNoTradeRange,
  segments: readonly ResearchNoTradeQuerySegment[],
): boolean {
  const rangeStart = requireTimestamp(range.from, "verified range from").epochNanoseconds;
  const rangeEnd = requireTimestamp(range.to, "verified range to").epochNanoseconds;
  let coveredUntil = rangeStart;

  for (const segment of segments) {
    if (!segment.paginationComplete) continue;
    const segmentStart = requireTimestamp(segment.from, "query segment from").epochNanoseconds;
    const segmentEnd = requireTimestamp(segment.to, "query segment to").epochNanoseconds;
    if (compareEpochNanoseconds(segmentEnd, coveredUntil) <= 0) continue;
    if (compareEpochNanoseconds(segmentStart, coveredUntil) > 0) return false;
    coveredUntil = segmentEnd;
    if (compareEpochNanoseconds(coveredUntil, rangeEnd) >= 0) return true;
  }

  return false;
}

function overlaps(
  range: ResearchNoTradeRange,
  candleOpen: PerformanceTimestamp,
  candleClose: PerformanceTimestamp,
): boolean {
  const from = requireTimestamp(range.from, "verified range from");
  const to = requireTimestamp(range.to, "verified range to");
  return compareEpochNanoseconds(candleOpen.epochNanoseconds, to.epochNanoseconds) < 0 &&
    compareEpochNanoseconds(from.epochNanoseconds, candleClose.epochNanoseconds) < 0;
}

function groupNominalHourlyRanges(intervalStarts: readonly bigint[]): ResearchNoTradeRange[] {
  const ranges: ResearchNoTradeRange[] = [];
  for (const intervalStart of intervalStarts) {
    const previous = ranges.at(-1);
    if (previous !== undefined) {
      const previousEnd = requireTimestamp(previous.to, "previous missing range to").epochNanoseconds;
      if (previousEnd === intervalStart) {
        previous.to = formatExactTimestamp(intervalStart + HOUR_NANOSECONDS);
        continue;
      }
    }
    ranges.push({
      from: formatExactTimestamp(intervalStart),
      to: formatExactTimestamp(intervalStart + HOUR_NANOSECONDS),
    });
  }
  return ranges;
}

function subtractVerifiedRanges(
  missingRanges: readonly ResearchNoTradeRange[],
  verifiedRanges: readonly ResearchNoTradeRange[],
): ResearchNoTradeRange[] {
  const uncovered: ResearchNoTradeRange[] = [];
  for (const missing of missingRanges) {
    const missingStart = requireTimestamp(missing.from, "missing range from").epochNanoseconds;
    const missingEnd = requireTimestamp(missing.to, "missing range to").epochNanoseconds;
    let cursor = missingStart;

    for (const verified of verifiedRanges) {
      const verifiedStart = requireTimestamp(verified.from, "verified range from").epochNanoseconds;
      const verifiedEnd = requireTimestamp(verified.to, "verified range to").epochNanoseconds;
      if (verifiedEnd <= cursor) continue;
      if (verifiedStart >= missingEnd) break;
      if (verifiedStart > cursor) {
        uncovered.push({
          from: formatExactTimestamp(cursor),
          to: formatExactTimestamp(verifiedStart < missingEnd ? verifiedStart : missingEnd),
        });
      }
      if (verifiedEnd > cursor) cursor = verifiedEnd < missingEnd ? verifiedEnd : missingEnd;
      if (cursor === missingEnd) break;
    }

    if (cursor < missingEnd) {
      uncovered.push({
        from: formatExactTimestamp(cursor),
        to: formatExactTimestamp(missingEnd),
      });
    }
  }
  return uncovered;
}

function ceilToHour(epochNanoseconds: bigint): bigint {
  const remainder = epochNanoseconds % HOUR_NANOSECONDS;
  return remainder === 0n ? epochNanoseconds : epochNanoseconds + HOUR_NANOSECONDS - remainder;
}

function formatExactTimestamp(epochNanoseconds: bigint): string {
  const seconds = epochNanoseconds / 1_000_000_000n;
  const fractionalNanoseconds = epochNanoseconds % 1_000_000_000n;
  const milliseconds = Number(seconds * 1_000n);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("Research no-trade coverage timestamp is outside the safe range.");
  }
  const prefix = new Date(milliseconds).toISOString().slice(0, 19);
  if (fractionalNanoseconds % 1_000_000n === 0n) {
    return `${prefix}.${(fractionalNanoseconds / 1_000_000n).toString().padStart(3, "0")}Z`;
  }
  return `${prefix}.${fractionalNanoseconds.toString().padStart(9, "0")}Z`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = requireRecord(value, "Canonical research no-trade evidence value");
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, expectedKeys: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}

function requireAsset(value: unknown): ResearchAsset {
  if (value === "BTC" || value === "ETH") return value;
  throw new Error("Research no-trade evidence asset must be BTC or ETH.");
}

function requireMarket(value: unknown): ResearchMarket {
  if (value === "KRW-BTC" || value === "KRW-ETH") return value;
  throw new Error("Research no-trade evidence market must be KRW-BTC or KRW-ETH.");
}

function marketForAsset(asset: ResearchAsset): ResearchMarket {
  return asset === "BTC" ? "KRW-BTC" : "KRW-ETH";
}

function requireLowerTimeframe(value: unknown): "1m" {
  if (value === "1m") return value;
  throw new Error("Research no-trade evidence lowerTimeframe must be 1m.");
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Research no-trade evidence ${label} must be a non-empty string.`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): PerformanceTimestamp {
  if (typeof value !== "string") {
    throw new Error(`Research no-trade evidence ${label} must be an exact timestamp with an explicit timezone.`);
  }
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) {
    throw new Error(`Research no-trade evidence ${label} must be an exact timestamp with an explicit timezone.`);
  }
  return parsed;
}
