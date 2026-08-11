import path from "node:path";
import { pathToFileURL } from "node:url";

import type { SupportedAsset, SupportedMarket } from "../domain/types.js";
import { UpbitPublicTickerClient } from "../modules/exchange/upbit/public-client.js";
import {
  parsePerformanceTimestamp,
  compareEpochNanoseconds,
  type PerformanceTimestamp,
} from "../modules/performance/performance-timestamp.js";
import type { ResearchCandleTimeframe } from "../modules/performance/research-candle-dataset.js";
import {
  assertResearchCandleDatasetOutputAvailable,
  writeVerifiedResearchCandleDataset,
} from "../modules/performance/research-candle-dataset-writer.js";
export { assertResearchCandleDatasetOutputAvailable };
import {
  acquireUpbitResearchCandleDataset,
  type ResearchCandleAcquisitionBoundary,
} from "../modules/performance/upbit-research-candle-acquisition.js";
import type {
  PositionGuardBacktestCandleReader,
} from "../modules/strategy/position-guard-public-backtest.js";

export type ResearchCandleDatasetCliOptions = {
  asset: SupportedAsset;
  historyStartAt: string;
  endAt: string;
  outputPath: string;
  pageSize: number;
  pageLimit: number;
};

export type ResearchCandleDatasetCliDependencies = {
  now: () => Date;
  createReader: () => PositionGuardBacktestCandleReader;
  assertOutputAvailable: (outputPath: string) => Promise<void>;
  writeArtifact: (input: { outputPath: string; json: string }) => Promise<void>;
};

export type ResearchCandleDatasetCliSummary = {
  service: "AutoTrade_Upbit";
  status: "COMPLETED";
  asset: SupportedAsset;
  market: SupportedMarket;
  historyStartAt: string;
  endAt: string;
  collectedAt: string;
  outputPath: string;
  candleCounts: Record<ResearchCandleTimeframe, number>;
  sha256: string;
  source: "upbit-public-historical-candles";
  boundary: ResearchCandleAcquisitionBoundary;
};

const ARGUMENT_KEYS = [
  "asset",
  "history-start",
  "end",
  "output",
  "page-size",
  "page-limit",
] as const;
type ArgumentKey = typeof ARGUMENT_KEYS[number];
const ARGUMENT_KEY_SET = new Set<string>(ARGUMENT_KEYS);

export function parseResearchCandleDatasetArgs(
  argv: readonly string[],
): ResearchCandleDatasetCliOptions {
  const values = new Map<ArgumentKey, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      throw new Error(`Unexpected argument ${token ?? "<missing>"}.`);
    }
    const key = token.slice(2);
    if (!ARGUMENT_KEY_SET.has(key)) throw new Error(`Unknown argument --${key}.`);
    const argumentKey = key as ArgumentKey;
    if (values.has(argumentKey)) throw new Error(`Duplicate argument --${key}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }
    values.set(argumentKey, value);
    index += 1;
  }

  return validateOptions({
    asset: parseAsset(requireArgument(values, "asset")),
    historyStartAt: requireArgument(values, "history-start"),
    endAt: requireArgument(values, "end"),
    outputPath: requireArgument(values, "output"),
    pageSize: parsePageSize(requireArgument(values, "page-size")),
    pageLimit: parsePageLimit(requireArgument(values, "page-limit")),
  });
}

export async function runResearchCandleDatasetCli(
  options: ResearchCandleDatasetCliOptions,
  dependencies: ResearchCandleDatasetCliDependencies,
): Promise<ResearchCandleDatasetCliSummary> {
  const validated = validateOptions(options);
  const collectedAtDate = dependencies.now();
  if (Number.isNaN(collectedAtDate.getTime())) {
    throw new Error("Research candle collection clock is invalid.");
  }
  const collectedAt = collectedAtDate.toISOString();
  assertEndNotAfterCollectedAt(validated.endAt, collectedAt);
  await dependencies.assertOutputAvailable(validated.outputPath);
  const reader = dependencies.createReader();
  const acquired = await acquireUpbitResearchCandleDataset(reader, {
    asset: validated.asset,
    historyStartAt: validated.historyStartAt,
    endAt: validated.endAt,
    collectedAt,
    pageSize: validated.pageSize,
    pageLimit: validated.pageLimit,
  });
  await dependencies.writeArtifact({
    outputPath: validated.outputPath,
    json: acquired.json,
  });

  return {
    service: "AutoTrade_Upbit",
    status: "COMPLETED",
    asset: acquired.asset,
    market: acquired.market,
    historyStartAt: validated.historyStartAt,
    endAt: validated.endAt,
    collectedAt,
    outputPath: validated.outputPath,
    candleCounts: acquired.candleCounts,
    sha256: acquired.dataset.provenance.sha256,
    source: acquired.source,
    boundary: acquired.boundary,
  };
}

function validateOptions(options: ResearchCandleDatasetCliOptions): ResearchCandleDatasetCliOptions {
  const asset = parseAsset(options.asset);
  const historyStart = parseTimestamp(options.historyStartAt, "history-start");
  const end = parseTimestamp(options.endAt, "end");
  if (compareEpochNanoseconds(historyStart.epochNanoseconds, end.epochNanoseconds) >= 0) {
    throw new Error("--history-start must be before --end.");
  }
  if (options.outputPath.trim() === "") {
    throw new Error("--output must be a non-empty path.");
  }

  return {
    asset,
    historyStartAt: options.historyStartAt,
    endAt: options.endAt,
    outputPath: options.outputPath,
    pageSize: parsePageSize(String(options.pageSize)),
    pageLimit: parsePageLimit(String(options.pageLimit)),
  };
}

function parseAsset(value: string): SupportedAsset {
  if (value === "BTC" || value === "ETH") return value;
  throw new Error("--asset must be BTC or ETH.");
}

function parseTimestamp(value: string, key: "history-start" | "end"): PerformanceTimestamp {
  const parsed = parsePerformanceTimestamp(value);
  if (parsed) return parsed;
  throw new Error(`--${key} must be an explicit-timezone ISO timestamp.`);
}

function parsePageSize(value: string): number {
  const parsed = parsePositiveInteger(value);
  if (parsed === null || parsed > 200) {
    throw new Error("--page-size must be an integer between 1 and 200.");
  }
  return parsed;
}

function parsePageLimit(value: string): number {
  const parsed = parsePositiveInteger(value);
  if (parsed === null) {
    throw new Error("--page-limit must be a positive integer.");
  }
  return parsed;
}

function parsePositiveInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function requireArgument(values: ReadonlyMap<ArgumentKey, string>, key: ArgumentKey): string {
  const value = values.get(key);
  if (value === undefined) {
    throw new Error(`Missing required argument --${key}.`);
  }
  return value;
}

function assertEndNotAfterCollectedAt(endAt: string, collectedAt: string): void {
  const end = parseTimestamp(endAt, "end");
  const collected = parsePerformanceTimestamp(collectedAt);
  if (
    collected === null ||
    compareEpochNanoseconds(end.epochNanoseconds, collected.epochNanoseconds) > 0
  ) {
    throw new Error("--end must be at or before the collection time.");
  }
}

function createDefaultDependencies(): ResearchCandleDatasetCliDependencies {
  return {
    now: () => new Date(),
    assertOutputAvailable: assertResearchCandleDatasetOutputAvailable,
    createReader: () => new UpbitPublicTickerClient(),
    writeArtifact: writeVerifiedResearchCandleDataset,
  };
}

async function main(): Promise<void> {
  const options = parseResearchCandleDatasetArgs(process.argv.slice(2));
  const summary = await runResearchCandleDatasetCli(options, createDefaultDependencies());
  console.log(JSON.stringify(summary, null, 2));
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Research candle dataset acquisition failed: ${message}`);
    process.exitCode = 1;
  });
}
