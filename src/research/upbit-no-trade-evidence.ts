import path from "node:path";
import { pathToFileURL } from "node:url";

import { UpbitPublicTickerClient } from "../modules/exchange/upbit/public-client.js";
import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
} from "../modules/performance/performance-timestamp.js";
import {
  readResearchCandleDataset,
  type ResearchCandleDataset,
} from "../modules/performance/research-candle-dataset.js";
import {
  assertResearchNoTradeEvidenceOutputAvailable,
  writeVerifiedResearchNoTradeEvidence,
} from "../modules/performance/research-no-trade-evidence-writer.js";
import {
  acquireUpbitNoTradeEvidence,
  type AcquiredUpbitNoTradeEvidence,
  type ResearchNoTradeMinuteCandleReader,
} from "../modules/performance/upbit-no-trade-evidence-acquisition.js";

const ARGUMENT_KEYS = ["parent-dataset", "output", "page-size", "page-limit"] as const;
type ArgumentKey = typeof ARGUMENT_KEYS[number];
const ARGUMENT_KEY_SET = new Set<string>(ARGUMENT_KEYS);

export type NoTradeEvidenceCliOptions = {
  parentDatasetPath: string;
  outputPath: string;
  pageSize: number;
  pageLimit: number;
};

export type NoTradeEvidenceCliDependencies = {
  now: () => Date;
  readParentDataset: (path: string) => Promise<ResearchCandleDataset>;
  assertOutputAvailable: (path: string) => Promise<void>;
  createReader: () => ResearchNoTradeMinuteCandleReader;
  writeArtifact: (input: {
    outputPath: string;
    json: string;
    parentDataset: ResearchCandleDataset;
  }) => Promise<void>;
};

export type NoTradeEvidenceCliSummary = {
  service: "AutoTrade_Upbit";
  status: "COMPLETED";
  parentDatasetPath: string;
  parentDatasetSha256: string;
  outputPath: string;
  evidenceSha256: string;
  collectedAt: string;
  segmentCount: number;
  pageCount: number;
  verifiedRangeCount: number;
  source: "upbit-public-independent-no-trade-collector";
  boundary: AcquiredUpbitNoTradeEvidence["boundary"];
};

export function parseNoTradeEvidenceArgs(argv: readonly string[]): NoTradeEvidenceCliOptions {
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
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    values.set(argumentKey, value);
    index += 1;
  }

  return validateOptions({
    parentDatasetPath: requireArgument(values, "parent-dataset"),
    outputPath: requireArgument(values, "output"),
    pageSize: parsePageSize(requireArgument(values, "page-size")),
    pageLimit: parsePageLimit(requireArgument(values, "page-limit")),
  });
}

export async function runNoTradeEvidenceCli(
  options: NoTradeEvidenceCliOptions,
  dependencies: NoTradeEvidenceCliDependencies,
): Promise<NoTradeEvidenceCliSummary> {
  const validated = validateOptions(options);
  const collectionClock = dependencies.now();
  if (Number.isNaN(collectionClock.getTime())) {
    throw new Error("No-trade evidence collection clock is invalid.");
  }
  const collectedAt = collectionClock.toISOString();

  const parentDataset = await dependencies.readParentDataset(validated.parentDatasetPath);
  assertParentEndNotAfterCollectionTime(parentDataset, collectedAt);
  await dependencies.assertOutputAvailable(validated.outputPath);

  const reader = dependencies.createReader();
  const acquired = await acquireUpbitNoTradeEvidence(reader, {
    parentDataset,
    collectedAt,
    pageSize: validated.pageSize,
    pageLimit: validated.pageLimit,
  });
  await dependencies.writeArtifact({
    outputPath: validated.outputPath,
    json: acquired.json,
    parentDataset,
  });

  return {
    service: "AutoTrade_Upbit",
    status: "COMPLETED",
    parentDatasetPath: validated.parentDatasetPath,
    parentDatasetSha256: parentDataset.provenance.sha256,
    outputPath: validated.outputPath,
    evidenceSha256: acquired.evidence.provenance.sha256,
    collectedAt: acquired.evidence.provenance.collectedAt,
    segmentCount: acquired.segmentCount,
    pageCount: acquired.pageCount,
    verifiedRangeCount: acquired.verifiedRangeCount,
    source: acquired.source,
    boundary: acquired.boundary,
  };
}

function validateOptions(options: NoTradeEvidenceCliOptions): NoTradeEvidenceCliOptions {
  if (typeof options.parentDatasetPath !== "string" || options.parentDatasetPath.trim() === "") {
    throw new Error("--parent-dataset must be a non-empty path.");
  }
  if (typeof options.outputPath !== "string" || options.outputPath.trim() === "") {
    throw new Error("--output must be a non-empty path.");
  }
  return {
    parentDatasetPath: options.parentDatasetPath,
    outputPath: options.outputPath,
    pageSize: parsePageSize(String(options.pageSize)),
    pageLimit: parsePageLimit(String(options.pageLimit)),
  };
}

function parsePageSize(value: string): number {
  const parsed = parsePositiveSafeInteger(value);
  if (parsed === null || parsed > 200) {
    throw new Error("--page-size must be an integer between 1 and 200.");
  }
  return parsed;
}

function parsePageLimit(value: string): number {
  const parsed = parsePositiveSafeInteger(value);
  if (parsed === null) throw new Error("--page-limit must be a positive safe integer.");
  return parsed;
}

function parsePositiveSafeInteger(value: string): number | null {
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function requireArgument(values: ReadonlyMap<ArgumentKey, string>, key: ArgumentKey): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Missing required argument --${key}.`);
  return value;
}

function assertParentEndNotAfterCollectionTime(
  parentDataset: ResearchCandleDataset,
  collectedAt: string,
): void {
  const parentEnd = parsePerformanceTimestamp(parentDataset.provenance.endAt);
  const collectionTime = parsePerformanceTimestamp(collectedAt);
  if (
    parentEnd === null || collectionTime === null ||
    compareEpochNanoseconds(parentEnd.epochNanoseconds, collectionTime.epochNanoseconds) > 0
  ) {
    throw new Error("Parent dataset end must be at or before the collection time.");
  }
}

function createDefaultDependencies(): NoTradeEvidenceCliDependencies {
  return {
    now: () => new Date(),
    readParentDataset: readResearchCandleDataset,
    assertOutputAvailable: assertResearchNoTradeEvidenceOutputAvailable,
    createReader: () => new UpbitPublicTickerClient(),
    writeArtifact: writeVerifiedResearchNoTradeEvidence,
  };
}

async function main(): Promise<void> {
  const options = parseNoTradeEvidenceArgs(process.argv.slice(2));
  const summary = await runNoTradeEvidenceCli(options, createDefaultDependencies());
  console.log(JSON.stringify(summary, null, 2));
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Research no-trade evidence acquisition failed: ${message}`);
    process.exitCode = 1;
  });
}
