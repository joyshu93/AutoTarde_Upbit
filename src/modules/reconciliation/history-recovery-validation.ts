import { parseCandidatePilotTimestamp } from "../db/pilot-interfaces.js";

const topKeys = ["closedOrderLookbackDays", "stopBeforeDays", "stopBeforeAt", "retentionAssumptionDays", "retentionBoundaryAt", "retentionStatus", "coverageStatus", "confidenceLevel", "confidenceReason", "failureMessage", "scannedSnapshotCount", "recoveredOrderCount", "markets"];
const marketKeys = ["market", "recentClosedWindowStartAt", "recentClosedWindowEndAt", "archivalWindowStartAt", "archivalWindowEndAt", "nextWindowEndAt", "archiveComplete", "retentionStatus", "confidenceLevel", "confidenceReason", "openHistoryTruncated", "recentClosedHistoryTruncated", "archivalClosedHistoryTruncated", "openPagesScanned", "recentClosedPagesScanned", "archivalClosedPagesScanned", "snapshotCount"];

export function isStrictHistoryRecoverySummary(value: unknown, reconciliationStatus: string, issueCodes: readonly string[]): boolean {
  if (!record(value, topKeys)) return false;
  const v = value as Record<string, unknown>;
  if (!ints(v, ["closedOrderLookbackDays", "stopBeforeDays", "retentionAssumptionDays", "scannedSnapshotCount", "recoveredOrderCount"])) return false;
  if (!timestamps(v, ["stopBeforeAt", "retentionBoundaryAt"])) return false;
  if (!one(v.retentionStatus, ["WITHIN_ASSUMED_RETENTION", "BEYOND_ASSUMED_RETENTION"]) || !one(v.coverageStatus, ["IN_PROGRESS", "COMPLETE"]) || !one(v.confidenceLevel, ["HIGH", "PARTIAL", "FAILED"]) || !one(v.confidenceReason, ["ARCHIVE_COMPLETE", "ARCHIVE_IN_PROGRESS", "PAGE_LIMIT_REACHED", "BEYOND_ASSUMED_RETENTION", "LOOKUP_FAILED"])) return false;
  if ((v.failureMessage === null) === (v.confidenceLevel === "FAILED")) return false;
  if (v.confidenceLevel === "FAILED" && (v.confidenceReason !== "LOOKUP_FAILED" || reconciliationStatus !== "DRIFT_DETECTED" || !issueCodes.includes("ORDER_HISTORY_LOOKUP_FAILED"))) return false;
  if (v.confidenceLevel !== "FAILED" && v.failureMessage !== null) return false;
  if (!Array.isArray(v.markets) || Object.getPrototypeOf(v.markets) !== Array.prototype || Reflect.ownKeys(v.markets).length !== v.markets.length + 1) return false;
  const markets = new Set<string>();
  for (const market of v.markets) {
    if (!record(market, marketKeys)) return false;
    const m = market as Record<string, unknown>;
    if (!one(m.market, ["KRW-BTC", "KRW-ETH"]) || markets.has(m.market as string)) return false;
    markets.add(m.market as string);
    if (!timestamps(m, ["recentClosedWindowStartAt", "recentClosedWindowEndAt", "archivalWindowStartAt", "archivalWindowEndAt", "nextWindowEndAt"]) || !ints(m, ["openPagesScanned", "recentClosedPagesScanned", "archivalClosedPagesScanned", "snapshotCount"]) || !["archiveComplete", "openHistoryTruncated", "recentClosedHistoryTruncated", "archivalClosedHistoryTruncated"].every((k) => typeof m[k] === "boolean")) return false;
    if (!one(m.retentionStatus, ["WITHIN_ASSUMED_RETENTION", "BEYOND_ASSUMED_RETENTION"]) || !one(m.confidenceLevel, ["HIGH", "PARTIAL"]) || !one(m.confidenceReason, ["ARCHIVE_COMPLETE", "ARCHIVE_IN_PROGRESS", "PAGE_LIMIT_REACHED", "BEYOND_ASSUMED_RETENTION"])) return false;
  }
  return true;
}
function record(value: unknown, keys: readonly string[]): boolean { return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === keys.length && keys.every((k) => { const d = Object.getOwnPropertyDescriptor(value, k); return d !== undefined && d.enumerable === true && "value" in d; }); }
function ints(v: Record<string, unknown>, keys: readonly string[]): boolean { return keys.every((k) => typeof v[k] === "number" && Number.isSafeInteger(v[k]) && (v[k] as number) >= 0); }
function timestamps(v: Record<string, unknown>, keys: readonly string[]): boolean { try { keys.forEach((k) => parseCandidatePilotTimestamp(v[k] as string, k)); return true; } catch { return false; } }
function one(value: unknown, allowed: readonly string[]): boolean { return typeof value === "string" && allowed.includes(value); }
