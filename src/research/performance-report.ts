import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ExecutionMode, OrderOrigin } from "../domain/types.js";
import {
  calculatePerformance,
  type MarketPerformanceResult,
  type PerformanceCalculationResult,
} from "../modules/performance/performance-calculator.js";
import {
  diagnosePerformance,
  type Metric,
  type PerformanceDiagnosticGroup,
  type PerformanceDiagnosticsResult,
} from "../modules/performance/performance-diagnostics.js";
import type { PositionEpisode } from "../modules/performance/performance-trade-matcher.js";
import { comparePerformanceTimestamps } from "../modules/performance/performance-timestamp.js";
import {
  normalizeExplicitIsoTimestamp,
  readPerformanceInput,
  type PerformanceReadFilters,
  type PerformanceReadProvenance,
} from "../modules/performance/sqlite-performance-reader.js";

export type PerformanceReportOutput = "text" | "json";

export type PerformanceReportOptions = PerformanceReadFilters & {
  output: PerformanceReportOutput;
};

export type PerformanceReport = {
  provenance: PerformanceReadProvenance;
  performance: PerformanceCalculationResult;
  diagnostics: PerformanceDiagnosticsResult;
  recentCompletedEpisodes: readonly PositionEpisode[];
  disclaimer: "This is selected order stream performance; it is not total account return.";
};

const DISCLAIMER =
  "This is selected order stream performance; it is not total account return." as const;
export const PERFORMANCE_BREAKEVEN_TOLERANCE_KRW = 1e-9;
const RECENT_COMPLETED_EPISODE_LIMIT = 10;

export function parsePerformanceReportArgs(argv: readonly string[]): PerformanceReportOptions {
  const values = new Map<string, string>();
  let output: PerformanceReportOutput = "text";
  const valueArguments = new Set([
    "database",
    "exchange-account",
    "mode",
    "origin",
    "from",
    "to",
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      throw new Error(`Unexpected argument ${token ?? "<missing>"}.`);
    }
    const key = token.slice(2);
    if (key === "json") {
      if (output === "json") throw new Error("Duplicate argument --json.");
      output = "json";
      continue;
    }
    if (!valueArguments.has(key)) throw new Error(`Unknown argument --${key}.`);
    if (values.has(key)) throw new Error(`Duplicate argument --${key}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }
    values.set(key, value);
    index += 1;
  }

  const databasePath = requireArgument(values, "database");
  const exchangeAccountId = requireArgument(values, "exchange-account");
  const executionMode = parseExecutionMode(requireArgument(values, "mode"));
  const origin = parseOrigin(requireArgument(values, "origin"));
  const from = parseOptionalTimestamp(values.get("from"), "from");
  const to = parseOptionalTimestamp(values.get("to"), "to");
  if (from !== undefined && to !== undefined && comparePerformanceTimestamps(from, to) >= 0) {
    throw new Error("--from must be earlier than --to.");
  }

  return {
    databasePath,
    exchangeAccountId,
    executionMode,
    origin,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    output,
  };
}

export function buildPerformanceReport(options: PerformanceReportOptions): PerformanceReport {
  const readResult = readPerformanceInput(options);
  const diagnostics = diagnosePerformance({
    fills: readResult.tradeFills,
    ...(readResult.attributionInput.openingPositions === undefined
      ? {}
      : { openingPositions: readResult.attributionInput.openingPositions }),
    markObservations: readResult.markObservations,
    policy: { breakevenToleranceKrw: PERFORMANCE_BREAKEVEN_TOLERANCE_KRW },
  });
  return {
    provenance: readResult.provenance,
    performance: calculatePerformance(readResult.attributionInput),
    diagnostics,
    recentCompletedEpisodes: diagnostics.matchResult.episodes
      .filter((episode) => episode.status === "COMPLETED")
      .sort(compareRecentEpisodes)
      .slice(0, RECENT_COMPLETED_EPISODE_LIMIT),
    disclaimer: DISCLAIMER,
  };
}

export function formatPerformanceReport(
  report: PerformanceReport,
  output: PerformanceReportOutput,
): string {
  if (output === "json") return stringifyFiniteJson(report);

  const filters = report.provenance.filters;
  const lines = [
    "Performance Report",
    `database: ${filters.databasePath}`,
    `exchange_account: ${filters.exchangeAccountId}`,
    `execution_mode: ${filters.executionMode}`,
    `origin: ${filters.origin}`,
    `period: [${filters.from ?? "unbounded"}, ${filters.to ?? "unbounded"})`,
    `period_semantics: ${filters.periodSemantics}`,
    `fills: ${report.provenance.fillCount}`,
    `first_fill_at: ${report.provenance.firstFillAt ?? "none"}`,
    `last_fill_at: ${report.provenance.lastFillAt ?? "none"}`,
    `opening_snapshot: ${formatSnapshot(report.provenance.openingSnapshot)}`,
    `attribution_opening_snapshot: ${formatSnapshot(report.provenance.attributionOpeningSnapshot)}`,
    `fee_evidence: persisted=${report.provenance.feeEvidence.persistedFillFeeCount}; recovered_order_paid_fee=${report.provenance.feeEvidence.recoveredOrderPaidFeeCount}; unknown=${report.provenance.feeEvidence.unknownFeeCount}`,
    `data_quality_warnings: ${report.provenance.dataQualityWarnings.length}`,
    ...report.provenance.dataQualityWarnings.map(
      (warning) => `- ${warning.code} | fill=${warning.fillId} | order=${warning.orderId} | ${warning.message}`,
    ),
    `mark_snapshot: ${formatSnapshot(report.provenance.markSnapshot)}`,
    `mark_observations: ${report.provenance.markObservationCount}`,
    `first_mark_observation_at: ${report.provenance.firstMarkObservationAt ?? "none"}`,
    `last_mark_observation_at: ${report.provenance.lastMarkObservationAt ?? "none"}`,
    "",
    ...report.performance.markets.flatMap(formatMarket),
    "Totals",
    `realized_pnl_krw: ${formatNumber(report.performance.totals.realizedPnlKrw)}`,
    `opening_inventory_realized_pnl_krw: ${formatNumber(report.performance.totals.openingInventoryRealizedPnlKrw)}`,
    `selected_stream_realized_pnl_krw: ${formatNumber(report.performance.totals.selectedStreamRealizedPnlKrw)}`,
    `paid_fees_krw: ${formatNumber(report.performance.totals.paidFeesKrw)}`,
    `turnover_krw: ${formatNumber(report.performance.totals.turnoverKrw)}`,
    `remaining_cost_krw: ${formatNumber(report.performance.totals.remainingCostKrw)}`,
    `market_value_krw: ${formatNumber(report.performance.totals.marketValueKrw)}`,
    `gross_unrealized_pnl_krw: ${formatNumber(report.performance.totals.grossUnrealizedPnlKrw)}`,
    "",
    "Professional Diagnostics",
    `breakeven_tolerance_krw: ${PERFORMANCE_BREAKEVEN_TOLERANCE_KRW}`,
    "Episode win unit: completed position episodes (zero inventory to positive and back to zero).",
    ...formatDiagnosticGroup("Combined", report.diagnostics.combined),
    ...formatDiagnosticGroup("KRW-BTC", report.diagnostics.markets["KRW-BTC"]),
    ...formatDiagnosticGroup("KRW-ETH", report.diagnostics.markets["KRW-ETH"]),
    "Curves And Drawdowns",
    `Realized curve: ${report.diagnostics.realizedPnlCurve.equityDefinition}; observation_frequency=${report.diagnostics.realizedPnlCurve.observationFrequency}; max_gross_drawdown_krw=${formatMetric(report.diagnostics.realizedPnlCurve.maxGrossDrawdownKrw)}; max_net_drawdown_krw=${formatMetric(report.diagnostics.realizedPnlCurve.maxNetDrawdownKrw)}`,
    `Snapshot mark curve: ${report.diagnostics.markPnlCurve.equityDefinition}; observation_frequency=${report.diagnostics.markPnlCurve.observationFrequency}; ${formatMarkCoverage(report.diagnostics.markPnlCurve, "; ")}; max_observation_gap_ms=${formatNumber(report.diagnostics.markPnlCurve.maxObservationGapMs)}; max_gross_drawdown_krw=${formatMetric(report.diagnostics.markPnlCurve.maxGrossDrawdownKrw)}; max_net_drawdown_krw=${formatMetric(report.diagnostics.markPnlCurve.maxNetDrawdownKrw)}`,
    `KRW-BTC realized drawdown: gross=${formatMetric(report.diagnostics.marketRealizedPnlCurves["KRW-BTC"].maxGrossDrawdownKrw)} net=${formatMetric(report.diagnostics.marketRealizedPnlCurves["KRW-BTC"].maxNetDrawdownKrw)}`,
    `KRW-BTC snapshot mark drawdown: gross=${formatMetric(report.diagnostics.marketMarkPnlCurves["KRW-BTC"].maxGrossDrawdownKrw)} net=${formatMetric(report.diagnostics.marketMarkPnlCurves["KRW-BTC"].maxNetDrawdownKrw)} ${formatMarkCoverage(report.diagnostics.marketMarkPnlCurves["KRW-BTC"], " ")}`,
    `KRW-ETH realized drawdown: gross=${formatMetric(report.diagnostics.marketRealizedPnlCurves["KRW-ETH"].maxGrossDrawdownKrw)} net=${formatMetric(report.diagnostics.marketRealizedPnlCurves["KRW-ETH"].maxNetDrawdownKrw)}`,
    `KRW-ETH snapshot mark drawdown: gross=${formatMetric(report.diagnostics.marketMarkPnlCurves["KRW-ETH"].maxGrossDrawdownKrw)} net=${formatMetric(report.diagnostics.marketMarkPnlCurves["KRW-ETH"].maxNetDrawdownKrw)} ${formatMarkCoverage(report.diagnostics.marketMarkPnlCurves["KRW-ETH"], " ")}`,
    "Realized curve points are cumulative selected-stream PnL at sell-fill instants; drawdown is peak minus cumulative PnL.",
    "Usable snapshot mark points require persisted snapshots with complete mark and cost evidence; persisted observations may be excluded; no interpolation or future observations are used; drawdown is peak minus attributed PnL.",
    "",
    `Recent completed episodes (most recent, max ${RECENT_COMPLETED_EPISODE_LIMIT}):`,
    ...formatRecentEpisodes(report.recentCompletedEpisodes),
    "",
    `warnings: ${report.performance.warnings.length}`,
    ...report.performance.warnings.map(
      (warning) => `- ${warning.code} | ${warning.market} | ${warning.message}`,
    ),
    `diagnostic_warnings: ${report.diagnostics.warnings.length}`,
    ...report.diagnostics.warnings.map((warning) => `- ${warning}`),
    "",
    `Disclaimer: ${report.disclaimer}`,
  ];
  return lines.join("\n");
}

function formatMarkCoverage(
  curve: PerformanceDiagnosticsResult["markPnlCurve"],
  separator: string,
): string {
  const coverage =
    curve.persistedObservationCount === 0
      ? "UNAVAILABLE"
      : curve.usableObservationCount === 0
        ? "UNUSABLE"
        : curve.usableObservationCount < curve.persistedObservationCount
          ? "PARTIAL"
          : "COMPLETE";
  return [
    `persisted_observation_count=${curve.persistedObservationCount}`,
    `usable_observation_count=${curve.usableObservationCount}`,
    `curve_points=${curve.sampleCount}`,
    `coverage=${coverage}`,
  ].join(separator);
}

function formatDiagnosticGroup(
  label: string,
  group: PerformanceDiagnosticGroup,
): string[] {
  return [
    `${label} Diagnostics`,
    `episodes: completed=${group.completedEpisodeCount} open=${group.openEpisodeCount} outcomes=${formatMetric(group.episodeOutcomes)} win_rate=${formatMetric(group.episodeWinRate)}`,
    `episode_pnl_krw: average=${formatMetric(group.averageNetPnlKrw)} average_win=${formatMetric(group.averageWinKrw)} average_loss=${formatMetric(group.averageLossKrw)} payoff_ratio=${formatMetric(group.payoffRatio)} profit_factor=${formatMetric(group.profitFactor)}`,
    `FIFO realization slices: count=${group.selectedSliceCount} outcomes=${formatMetric(group.sliceOutcomes)} win_rate=${formatMetric(group.sliceWinRate)}`,
    `gross_realized_pnl_krw: ${formatMetric(group.grossRealizedPnlKrw)}`,
    `realized_fee_impact_krw: ${formatMetric(group.realizedFeeImpactKrw)}`,
    `net_realized_pnl_krw: ${formatMetric(group.netRealizedPnlKrw)}`,
    `turnover_krw: ${formatMetric(group.turnoverKrw)}`,
    `confirmed_fees_krw: ${formatMetric(group.confirmedFeesKrw)}`,
    `fee_completeness: ${group.feeCompleteness}`,
    `streaks: max_wins=${formatMetric(group.maxConsecutiveWins)} max_losses=${formatMetric(group.maxConsecutiveLosses)}`,
    `holding_duration_ms: ${formatMetric(group.holdingDurationMs)}`,
    `best_completed_episode: ${formatMetric(group.bestCompletedEpisode)}`,
    `worst_completed_episode: ${formatMetric(group.worstCompletedEpisode)}`,
    `entry_action_contribution: ${formatActionContributions(group.entryActionContribution)}`,
    `exit_action_contribution: ${formatActionContributions(group.exitActionContribution)}`,
    "",
  ];
}

function formatActionContributions(
  contributions: PerformanceDiagnosticGroup["entryActionContribution"],
): string {
  return Object.entries(contributions)
    .map(
      ([action, contribution]) =>
        `${action}{slices=${contribution.sliceCount},quantity=${formatNumber(contribution.quantity)},gross=${formatMetric(contribution.grossPnlKrw)},net=${formatMetric(contribution.netPnlKrw)}}`,
    )
    .join(" ");
}

function formatRecentEpisodes(episodes: readonly PositionEpisode[]): string[] {
  if (episodes.length === 0) return ["- none"];
  return episodes.map((episode) =>
    `- ${episode.id} | ${episode.market} | ${episode.openedAt} -> ${episode.closedAt ?? "open"} | gross=${formatNumber(episode.grossRealizedPnlKrw)} | fees=${formatNumber(episode.realizedFeeImpactKrw)} | net=${formatNumber(episode.netRealizedPnlKrw)} | holding_ms=${formatNumber(episode.holdingDurationMs)}`
  );
}

function formatMetric<T>(metric: Metric<T>): string {
  if (metric.status === "UNKNOWN") return `unknown(${metric.reasons.join(",")})`;
  if (metric.status === "NOT_APPLICABLE") return `not_applicable(${metric.reason})`;
  return formatMetricValue(metric.value);
}

function formatMetricValue(value: unknown): string {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  return stringifyFiniteJson(value, 0);
}

function compareRecentEpisodes(left: PositionEpisode, right: PositionEpisode): number {
  return comparePerformanceTimestamps(
    right.closedAt ?? right.openedAt,
    left.closedAt ?? left.openedAt,
  ) ||
    right.id.localeCompare(left.id);
}

function stringifyFiniteJson(value: unknown, space: number = 2): string {
  return JSON.stringify(
    value,
    (key, item: unknown) => {
      if (typeof item === "number" && !Number.isFinite(item)) {
        throw new Error(`Performance report metric ${key || "<root>"} must be finite.`);
      }
      return item;
    },
    space,
  );
}

function formatMarket(market: MarketPerformanceResult): string[] {
  return [
    market.market,
    `realized_pnl_krw: ${formatNumber(market.realizedPnlKrw)}`,
    `opening_inventory_realized_pnl_krw: ${formatNumber(market.openingInventoryRealizedPnlKrw)}`,
    `selected_stream_realized_pnl_krw: ${formatNumber(market.selectedStreamRealizedPnlKrw)}`,
    `paid_fees_krw: ${formatNumber(market.paidFeesKrw)}`,
    `turnover_krw: ${formatNumber(market.turnoverKrw)}`,
    `remaining_quantity: ${formatNumber(market.remainingQuantity)}`,
    `remaining_cost_krw: ${formatNumber(market.remainingCostKrw)}`,
    `market_value_krw: ${formatNumber(market.marketValueKrw)}`,
    `gross_unrealized_pnl_krw: ${formatNumber(market.grossUnrealizedPnlKrw)}`,
    `unmatched_sell_quantity: ${formatNumber(market.unmatchedSellQuantity)}`,
    "",
  ];
}

function formatSnapshot(snapshot: PerformanceReadProvenance["openingSnapshot"]): string {
  return snapshot === null
    ? "none"
    : `${snapshot.id} @ ${snapshot.capturedAt} source=${snapshot.source}`;
}

function formatNumber(value: number | null): string {
  if (value === null) return "unknown";
  if (!Number.isFinite(value)) return "unknown(non-finite)";
  return String(value);
}

function requireArgument(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required argument --${key}.`);
  }
  return value;
}

function parseExecutionMode(value: string): ExecutionMode {
  if (value === "LIVE" || value === "DRY_RUN") return value;
  throw new Error(`Invalid --mode: ${value}. Use LIVE or DRY_RUN.`);
}

function parseOrigin(value: string): OrderOrigin {
  if (value === "STRATEGY" || value === "OPERATOR" || value === "RECOVERY") return value;
  throw new Error(`Invalid --origin: ${value}. Use STRATEGY, OPERATOR, or RECOVERY.`);
}

function parseOptionalTimestamp(value: string | undefined, key: "from" | "to"): string | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeExplicitIsoTimestamp(value, `--${key} timestamp`);
  } catch {
    throw new Error(
      `Invalid --${key} timestamp: ${value}. Use an explicit ISO-8601 timezone.`,
    );
  }
}

async function main(): Promise<void> {
  const options = parsePerformanceReportArgs(process.argv.slice(2));
  const report = buildPerformanceReport(options);
  console.log(formatPerformanceReport(report, options.output));
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Performance report failed: ${message}`);
    process.exitCode = 1;
  });
}
