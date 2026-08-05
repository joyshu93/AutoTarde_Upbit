import { SUPPORTED_ASSETS, type SupportedAsset } from "../domain/types.js";
import { UpbitPublicTickerClient } from "../modules/exchange/upbit/public-client.js";
import {
  runPositionGuardPublicBacktest,
} from "../modules/strategy/position-guard-public-backtest.js";

interface ParsedArgs {
  asset: SupportedAsset;
  startAt: string;
  endAt: string;
  initialCashKrw: number;
  initialQuantity: number;
  initialAverageEntryPrice: number;
  warmupDays?: number;
  pageSize?: number;
  pageLimit?: number;
  feeRate?: number;
  slippageRate?: number;
  minimumTradeValueKrw?: number;
  label?: string;
  baseUrl?: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === "help") {
    printUsage();
    return;
  }

  const client = new UpbitPublicTickerClient({
    ...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }),
  });
  const result = await runPositionGuardPublicBacktest(client, {
    asset: args.asset,
    startAt: args.startAt,
    endAt: args.endAt,
    initialCashKrw: args.initialCashKrw,
    initialQuantity: args.initialQuantity,
    initialAverageEntryPrice: args.initialAverageEntryPrice,
    ...(args.warmupDays === undefined ? {} : { warmupDays: args.warmupDays }),
    ...(args.pageSize === undefined ? {} : { pageSize: args.pageSize }),
    ...(args.pageLimit === undefined ? {} : { pageLimit: args.pageLimit }),
    ...(args.label === undefined ? {} : { label: args.label }),
    ...(args.feeRate === undefined && args.slippageRate === undefined && args.minimumTradeValueKrw === undefined
      ? {}
      : {
        execution: {
          feeRate: args.feeRate ?? 0.0005,
          slippageRate: args.slippageRate ?? 0,
          minimumTradeValueKrw: args.minimumTradeValueKrw ?? 5_000,
        },
      }),
  });

  console.log(result.formattedReport);
  console.log(`market: ${result.market}`);
  console.log(`history_start_at: ${result.historyStartAt}`);
  console.log(`dataset_candles: 1h=${result.dataset.candleCounts["1h"]} 4h=${result.dataset.candleCounts["4h"]} 1d=${result.dataset.candleCounts["1d"]}`);
  console.log("non_mutation_boundary: database=false telegram=false private_exchange=false order_lifecycle=false live_orders=false");
}

function parseArgs(argv: string[]): ParsedArgs | "help" {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--help" || token === "-h") {
      return "help";
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (!rawKey) {
      throw new Error(`Invalid argument: ${token}`);
    }
    if (inlineValue !== undefined) {
      values.set(rawKey, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}.`);
    }
    values.set(rawKey, next);
    index += 1;
  }

  return {
    asset: parseAsset(values.get("asset") ?? "BTC"),
    startAt: requireValue(values, "start"),
    endAt: requireValue(values, "end"),
    initialCashKrw: parseNumber(values.get("initial-cash-krw") ?? "1000000", "initial-cash-krw"),
    initialQuantity: parseNumber(values.get("initial-quantity") ?? "0", "initial-quantity"),
    initialAverageEntryPrice: parseNumber(
      values.get("initial-average-entry-price") ?? "0",
      "initial-average-entry-price",
    ),
    ...(values.has("warmup-days") ? { warmupDays: parseNumber(requireValue(values, "warmup-days"), "warmup-days") } : {}),
    ...(values.has("page-size") ? { pageSize: parseNumber(requireValue(values, "page-size"), "page-size") } : {}),
    ...(values.has("page-limit") ? { pageLimit: parseNumber(requireValue(values, "page-limit"), "page-limit") } : {}),
    ...(values.has("fee-rate") ? { feeRate: parseNumber(requireValue(values, "fee-rate"), "fee-rate") } : {}),
    ...(values.has("slippage-rate") ? { slippageRate: parseNumber(requireValue(values, "slippage-rate"), "slippage-rate") } : {}),
    ...(values.has("minimum-trade-value-krw")
      ? { minimumTradeValueKrw: parseNumber(requireValue(values, "minimum-trade-value-krw"), "minimum-trade-value-krw") }
      : {}),
    ...(values.has("label") ? { label: requireValue(values, "label") } : {}),
    ...(values.has("base-url") ? { baseUrl: requireValue(values, "base-url") } : {}),
  };
}

function parseAsset(value: string): SupportedAsset {
  if ((SUPPORTED_ASSETS as readonly string[]).includes(value)) {
    return value as SupportedAsset;
  }
  throw new Error(`Unsupported asset: ${value}. Use BTC or ETH.`);
}

function parseNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric --${label}: ${value}`);
  }
  return parsed;
}

function requireValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required --${key}.`);
  }
  return value;
}

function printUsage(): void {
  console.log([
    "Usage:",
    "  npm run backtest:positionguard -- --asset BTC --start 2026-01-01T00:00:00Z --end 2026-04-01T00:00:00Z --initial-cash-krw 1000000",
    "",
    "Optional:",
    "  --initial-quantity 0",
    "  --initial-average-entry-price 0",
    "  --warmup-days 220",
    "  --page-size 200",
    "  --page-limit 100",
    "  --fee-rate 0.0005",
    "  --slippage-rate 0",
    "  --minimum-trade-value-krw 5000",
    "  --label BTC-2026Q1",
  ].join("\n"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
