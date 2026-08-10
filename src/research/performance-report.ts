import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ExecutionMode, OrderOrigin } from "../domain/types.js";
import {
  calculatePerformance,
  type MarketPerformanceResult,
  type PerformanceCalculationResult,
} from "../modules/performance/performance-calculator.js";
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
  disclaimer: "This is selected order stream performance; it is not total account return.";
};

const DISCLAIMER =
  "This is selected order stream performance; it is not total account return." as const;

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
  if (from !== undefined && to !== undefined && Date.parse(from) >= Date.parse(to)) {
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
  return {
    provenance: readResult.provenance,
    performance: calculatePerformance(readResult.input),
    disclaimer: DISCLAIMER,
  };
}

export function formatPerformanceReport(
  report: PerformanceReport,
  output: PerformanceReportOutput,
): string {
  if (output === "json") return JSON.stringify(report, null, 2);

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
    `mark_snapshot: ${formatSnapshot(report.provenance.markSnapshot)}`,
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
    `warnings: ${report.performance.warnings.length}`,
    ...report.performance.warnings.map(
      (warning) => `- ${warning.code} | ${warning.market} | ${warning.message}`,
    ),
    "",
    `Disclaimer: ${report.disclaimer}`,
  ];
  return lines.join("\n");
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
  return value === null ? "unknown" : Number.isInteger(value) ? String(value) : String(value);
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
