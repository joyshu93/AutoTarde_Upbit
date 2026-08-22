import { parseCandidatePilotTimestamp } from "../db/pilot-interfaces.js";

const MILLISECONDS_PER_DAY = 86_400_000;
const TOP_KEYS = [
  "closedOrderLookbackDays", "stopBeforeDays", "stopBeforeAt", "retentionAssumptionDays",
  "retentionBoundaryAt", "retentionStatus", "coverageStatus", "confidenceLevel", "confidenceReason",
  "failureMessage", "scannedSnapshotCount", "recoveredOrderCount", "markets",
] as const;
const MARKET_KEYS = [
  "market", "recentClosedWindowStartAt", "recentClosedWindowEndAt", "archivalWindowStartAt",
  "archivalWindowEndAt", "nextWindowEndAt", "archiveComplete", "retentionStatus", "confidenceLevel",
  "confidenceReason", "openHistoryTruncated", "recentClosedHistoryTruncated",
  "archivalClosedHistoryTruncated", "openPagesScanned", "recentClosedPagesScanned",
  "archivalClosedPagesScanned", "snapshotCount",
] as const;

type RetentionStatus = "WITHIN_ASSUMED_RETENTION" | "BEYOND_ASSUMED_RETENTION";
type ConfidenceLevel = "HIGH" | "PARTIAL";
type ConfidenceReason = "ARCHIVE_COMPLETE" | "ARCHIVE_IN_PROGRESS" | "PAGE_LIMIT_REACHED" |
  "BEYOND_ASSUMED_RETENTION";

export function isStrictHistoryRecoverySummary(
  value: unknown,
  reconciliationStatus: string,
  issueCodes: readonly string[],
  runStartedAt: string,
  completedOrCheckedAt: string,
): boolean {
  const startedAtEpoch = timestampEpoch(runStartedAt);
  const boundaryEpoch = timestampEpoch(completedOrCheckedAt);
  if (startedAtEpoch === null || boundaryEpoch === null || startedAtEpoch > boundaryEpoch || !isDenseStringArray(issueCodes)) {
    return false;
  }

  const summary = exactDataRecord(value, TOP_KEYS);
  if (summary === null) return false;
  const closedOrderLookbackDays = nonNegativeSafeInteger(summary.closedOrderLookbackDays);
  const stopBeforeDays = nonNegativeSafeInteger(summary.stopBeforeDays);
  const retentionAssumptionDays = nonNegativeSafeInteger(summary.retentionAssumptionDays);
  const scannedSnapshotCount = nonNegativeSafeInteger(summary.scannedSnapshotCount);
  const recoveredOrderCount = nonNegativeSafeInteger(summary.recoveredOrderCount);
  if (
    closedOrderLookbackDays === null || closedOrderLookbackDays < 1 ||
    stopBeforeDays === null || stopBeforeDays < closedOrderLookbackDays ||
    retentionAssumptionDays === null || retentionAssumptionDays < closedOrderLookbackDays ||
    scannedSnapshotCount === null || recoveredOrderCount === null
  ) return false;

  const recentStartAt = derivedTimestamp(runStartedAt, closedOrderLookbackDays);
  const expectedStopBeforeAt = derivedTimestamp(runStartedAt, stopBeforeDays);
  const expectedRetentionBoundaryAt = derivedTimestamp(runStartedAt, retentionAssumptionDays);
  if (
    recentStartAt === null || expectedStopBeforeAt === null || expectedRetentionBoundaryAt === null ||
    summary.stopBeforeAt !== expectedStopBeforeAt || summary.retentionBoundaryAt !== expectedRetentionBoundaryAt ||
    !timestampsAtOrBefore([summary.stopBeforeAt, summary.retentionBoundaryAt], boundaryEpoch)
  ) return false;

  const markets = denseDataArray(summary.markets);
  if (markets === null) return false;
  const hasLookupFailureIssue = issueCodes.some((code) => code === "ORDER_HISTORY_LOOKUP_FAILED");
  if (summary.confidenceLevel === "FAILED") {
    const expectedRetentionStatus = Date.parse(expectedStopBeforeAt) < Date.parse(expectedRetentionBoundaryAt)
      ? "BEYOND_ASSUMED_RETENTION"
      : "WITHIN_ASSUMED_RETENTION";
    return reconciliationStatus === "DRIFT_DETECTED" &&
      hasLookupFailureIssue &&
      summary.retentionStatus === expectedRetentionStatus &&
      summary.coverageStatus === "IN_PROGRESS" &&
      summary.confidenceReason === "LOOKUP_FAILED" &&
      typeof summary.failureMessage === "string" &&
      scannedSnapshotCount === 0 && recoveredOrderCount === 0 && markets.length === 0;
  }

  if (
    (reconciliationStatus !== "SUCCESS" && reconciliationStatus !== "DRIFT_DETECTED") ||
    hasLookupFailureIssue || summary.failureMessage !== null ||
    !oneOf(summary.retentionStatus, ["WITHIN_ASSUMED_RETENTION", "BEYOND_ASSUMED_RETENTION"]) ||
    !oneOf(summary.coverageStatus, ["IN_PROGRESS", "COMPLETE"]) ||
    !oneOf(summary.confidenceLevel, ["HIGH", "PARTIAL"]) ||
    !oneOf(summary.confidenceReason, ["ARCHIVE_COMPLETE", "ARCHIVE_IN_PROGRESS", "PAGE_LIMIT_REACHED", "BEYOND_ASSUMED_RETENTION"]) ||
    markets.length !== 2
  ) return false;

  const expectedStopBeforeMs = Date.parse(expectedStopBeforeAt);
  const expectedRetentionBoundaryMs = Date.parse(expectedRetentionBoundaryAt);
  const recentStartMs = Date.parse(recentStartAt);
  const lookbackMs = closedOrderLookbackDays * MILLISECONDS_PER_DAY;
  if ([expectedStopBeforeMs, expectedRetentionBoundaryMs, recentStartMs, lookbackMs].some((item) => !Number.isSafeInteger(item))) {
    return false;
  }

  const seenMarkets = new Set<string>();
  const validated: Array<{
    archiveComplete: boolean;
    retentionStatus: RetentionStatus;
    confidenceLevel: ConfidenceLevel;
    confidenceReason: ConfidenceReason;
    snapshotCount: number;
  }> = [];
  for (const rawMarket of markets) {
    const market = exactDataRecord(rawMarket, MARKET_KEYS);
    if (market === null || !oneOf(market.market, ["KRW-BTC", "KRW-ETH"]) || seenMarkets.has(market.market)) return false;
    if (
      typeof market.archiveComplete !== "boolean" ||
      typeof market.openHistoryTruncated !== "boolean" ||
      typeof market.recentClosedHistoryTruncated !== "boolean" ||
      typeof market.archivalClosedHistoryTruncated !== "boolean" ||
      !oneOf(market.retentionStatus, ["WITHIN_ASSUMED_RETENTION", "BEYOND_ASSUMED_RETENTION"]) ||
      !oneOf(market.confidenceLevel, ["HIGH", "PARTIAL"]) ||
      !oneOf(market.confidenceReason, ["ARCHIVE_COMPLETE", "ARCHIVE_IN_PROGRESS", "PAGE_LIMIT_REACHED", "BEYOND_ASSUMED_RETENTION"])
    ) return false;

    const openPagesScanned = nonNegativeSafeInteger(market.openPagesScanned);
    const recentClosedPagesScanned = nonNegativeSafeInteger(market.recentClosedPagesScanned);
    const archivalClosedPagesScanned = nonNegativeSafeInteger(market.archivalClosedPagesScanned);
    const snapshotCount = nonNegativeSafeInteger(market.snapshotCount);
    if (openPagesScanned === null || recentClosedPagesScanned === null || archivalClosedPagesScanned === null || snapshotCount === null) {
      return false;
    }
    if (!timestampsAtOrBefore([
      market.recentClosedWindowStartAt, market.recentClosedWindowEndAt, market.archivalWindowStartAt,
      market.archivalWindowEndAt, market.nextWindowEndAt,
    ], boundaryEpoch)) return false;

    const archivalStartMs = typeof market.archivalWindowStartAt === "string" ? Date.parse(market.archivalWindowStartAt) : NaN;
    const archivalEndMs = typeof market.archivalWindowEndAt === "string" ? Date.parse(market.archivalWindowEndAt) : NaN;
    if (!Number.isSafeInteger(archivalStartMs) || !Number.isSafeInteger(archivalEndMs)) return false;
    const expectedArchivalStartMs = archivalEndMs <= expectedStopBeforeMs
      ? archivalEndMs
      : Math.max(archivalEndMs - lookbackMs, expectedStopBeforeMs);
    const expectedArchivalStartAt = isoTimestamp(expectedArchivalStartMs);
    if (expectedArchivalStartAt === null) return false;
    const archiveComplete = archivalStartMs <= expectedStopBeforeMs;
    const retentionStatus: RetentionStatus =
      archivalStartMs <= expectedRetentionBoundaryMs || expectedStopBeforeMs < expectedRetentionBoundaryMs
        ? "BEYOND_ASSUMED_RETENTION"
        : "WITHIN_ASSUMED_RETENTION";
    const pageLimitReached = market.openHistoryTruncated || market.recentClosedHistoryTruncated ||
      market.archivalClosedHistoryTruncated;
    const confidenceReason: ConfidenceReason = pageLimitReached
      ? "PAGE_LIMIT_REACHED"
      : retentionStatus === "BEYOND_ASSUMED_RETENTION"
        ? "BEYOND_ASSUMED_RETENTION"
        : archiveComplete ? "ARCHIVE_COMPLETE" : "ARCHIVE_IN_PROGRESS";
    const confidenceLevel: ConfidenceLevel = archiveComplete && !pageLimitReached &&
        retentionStatus === "WITHIN_ASSUMED_RETENTION" ? "HIGH" : "PARTIAL";
    const totalPages = openPagesScanned + recentClosedPagesScanned + archivalClosedPagesScanned;
    if (
      market.recentClosedWindowStartAt !== recentStartAt || market.recentClosedWindowEndAt !== runStartedAt ||
      archivalStartMs > archivalEndMs || archivalEndMs > recentStartMs ||
      market.archivalWindowStartAt !== expectedArchivalStartAt || market.nextWindowEndAt !== market.archivalWindowStartAt ||
      market.archiveComplete !== archiveComplete || market.retentionStatus !== retentionStatus ||
      market.confidenceReason !== confidenceReason || market.confidenceLevel !== confidenceLevel ||
      openPagesScanned < 1 || recentClosedPagesScanned < 1 ||
      (!archiveComplete && archivalClosedPagesScanned < 1) ||
      (market.openHistoryTruncated && openPagesScanned === 0) ||
      (market.recentClosedHistoryTruncated && recentClosedPagesScanned === 0) ||
      (market.archivalClosedHistoryTruncated && archivalClosedPagesScanned === 0) ||
      !Number.isSafeInteger(totalPages) || (snapshotCount > 0 && totalPages === 0)
    ) return false;

    seenMarkets.add(market.market);
    validated.push({ archiveComplete, retentionStatus, confidenceLevel, confidenceReason, snapshotCount });
  }

  if (!seenMarkets.has("KRW-BTC") || !seenMarkets.has("KRW-ETH")) return false;
  const expectedCoverage = validated.every((market) => market.archiveComplete) ? "COMPLETE" : "IN_PROGRESS";
  const expectedRetention = validated.some((market) => market.retentionStatus === "BEYOND_ASSUMED_RETENTION")
    ? "BEYOND_ASSUMED_RETENTION" : "WITHIN_ASSUMED_RETENTION";
  const expectedConfidence = validated.every((market) => market.confidenceLevel === "HIGH") ? "HIGH" : "PARTIAL";
  const expectedReason = validated.some((market) => market.confidenceReason === "PAGE_LIMIT_REACHED")
    ? "PAGE_LIMIT_REACHED"
    : validated.some((market) => market.confidenceReason === "BEYOND_ASSUMED_RETENTION")
      ? "BEYOND_ASSUMED_RETENTION"
      : validated.some((market) => market.confidenceReason === "ARCHIVE_IN_PROGRESS")
        ? "ARCHIVE_IN_PROGRESS" : "ARCHIVE_COMPLETE";
  const snapshotCount = validated.reduce((total, market) => total + market.snapshotCount, 0);
  return Number.isSafeInteger(snapshotCount) && summary.coverageStatus === expectedCoverage &&
    summary.retentionStatus === expectedRetention && summary.confidenceLevel === expectedConfidence &&
    summary.confidenceReason === expectedReason && recoveredOrderCount <= scannedSnapshotCount &&
    scannedSnapshotCount <= snapshotCount && (scannedSnapshotCount > 0) === (snapshotCount > 0);
}

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function denseDataArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const ownKeys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (ownKeys.length !== value.length + 1 || lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
    lengthDescriptor.value !== value.length || lengthDescriptor.enumerable !== false) return null;
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function isDenseStringArray(value: readonly string[]): boolean {
  const items = denseDataArray(value);
  return items !== null && items.every((item) => typeof item === "string");
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function timestampEpoch(value: unknown): bigint | null {
  if (typeof value !== "string") return null;
  try {
    return parseCandidatePilotTimestamp(value, "history recovery timestamp");
  } catch {
    return null;
  }
}

function timestampsAtOrBefore(values: readonly unknown[], boundaryEpoch: bigint): boolean {
  return values.every((value) => {
    const valueEpoch = timestampEpoch(value);
    return valueEpoch !== null && valueEpoch <= boundaryEpoch;
  });
}

function derivedTimestamp(startedAt: string, days: number): string | null {
  const startedAtMs = Date.parse(startedAt);
  const durationMs = days * MILLISECONDS_PER_DAY;
  if (!Number.isSafeInteger(startedAtMs) || !Number.isSafeInteger(durationMs)) return null;
  return isoTimestamp(startedAtMs - durationMs);
}

function isoTimestamp(epochMilliseconds: number): string | null {
  if (!Number.isSafeInteger(epochMilliseconds)) return null;
  try {
    return new Date(epochMilliseconds).toISOString();
  } catch {
    return null;
  }
}
