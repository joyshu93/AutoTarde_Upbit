import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { getMarketForAsset, type SupportedAsset, type SupportedMarket } from "../../domain/types.js";
import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
  type PerformanceTimestamp,
} from "./performance-timestamp.js";

export type ResearchCandleTimeframe = "1h" | "4h" | "1d";

export type ResearchDatasetProvenance = {
  schemaVersion: 1;
  asset: SupportedAsset;
  market: SupportedMarket;
  historyStartAt: string;
  endAt: string;
  collectedAt: string;
  source: string;
  sha256: string;
};

export type ResearchCandle = {
  market: SupportedMarket;
  timeframe: ResearchCandleTimeframe;
  openTime: string;
  closeTime: string;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  closePrice: number;
  volume: number;
  quoteVolume: number;
};

export type ResearchCandleDataset = {
  provenance: ResearchDatasetProvenance;
  candles: Record<ResearchCandleTimeframe, ResearchCandle[]>;
};

type ResearchCandleDatasetWithoutChecksum = Omit<ResearchCandleDataset, "provenance"> & {
  provenance: Omit<ResearchDatasetProvenance, "sha256">;
};

const TIMEFRAMES: readonly ResearchCandleTimeframe[] = ["1h", "4h", "1d"];
const TIMEFRAME_DURATION_NANOSECONDS: Record<ResearchCandleTimeframe, bigint> = {
  "1h": 3_600_000_000_000n,
  "4h": 14_400_000_000_000n,
  "1d": 86_400_000_000_000n,
};
const TIMEFRAME_DURATION_LABEL: Record<ResearchCandleTimeframe, string> = {
  "1h": "1 hour",
  "4h": "4 hours",
  "1d": "24 hours",
};
const SHA256_HEX = /^[a-f0-9]{64}$/;

export function parseResearchCandleDataset(json: string): ResearchCandleDataset {
  if (typeof json !== "string" || json.trim().length === 0) {
    throw new Error("Research candle dataset JSON must not be empty.");
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Research candle dataset must be valid JSON.");
  }

  const dataset = parseDataset(value, true) as ResearchCandleDataset;
  const { sha256, ...provenance } = dataset.provenance;
  const expectedChecksum = calculateResearchCandleDatasetChecksum({
    candles: dataset.candles,
    provenance,
  });
  if (sha256 !== expectedChecksum) {
    throw new Error("Research candle dataset checksum does not match declared sha256.");
  }

  return dataset;
}

export function calculateResearchCandleDatasetChecksum(
  dataset: Omit<ResearchCandleDataset, "provenance"> & {
    provenance: Omit<ResearchDatasetProvenance, "sha256">;
  },
): string {
  const validated = parseDataset(dataset, false) as ResearchCandleDatasetWithoutChecksum;
  return createHash("sha256").update(canonicalJson(validated), "utf8").digest("hex");
}

export async function readResearchCandleDataset(path: string): Promise<ResearchCandleDataset> {
  const bytes = await readFile(path);
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Research candle dataset file must contain valid UTF-8 JSON.");
  }

  return parseResearchCandleDataset(json);
}

function parseDataset(
  value: unknown,
  requiresChecksum: boolean,
): ResearchCandleDataset | ResearchCandleDatasetWithoutChecksum {
  const dataset = requireRecord(value, "Research candle dataset");
  assertExactKeys(dataset, ["provenance", "candles"], "Research candle dataset");
  const provenance = parseProvenance(dataset.provenance, requiresChecksum);
  const candles = parseCandles(
    dataset.candles,
    provenance.asset,
    provenance.market,
    provenance.historyStartAt,
    provenance.endAt,
  );

  return { provenance, candles } as ResearchCandleDataset | ResearchCandleDatasetWithoutChecksum;
}

function parseProvenance(
  value: unknown,
  requiresChecksum: boolean,
): ResearchDatasetProvenance | Omit<ResearchDatasetProvenance, "sha256"> {
  const provenance = requireRecord(value, "Research candle dataset provenance");
  assertExactKeys(
    provenance,
    requiresChecksum
      ? ["schemaVersion", "asset", "market", "historyStartAt", "endAt", "collectedAt", "source", "sha256"]
      : ["schemaVersion", "asset", "market", "historyStartAt", "endAt", "collectedAt", "source"],
    "Research candle dataset provenance",
  );

  if (provenance.schemaVersion !== 1) {
    throw new Error("Research candle dataset provenance schemaVersion must be exactly 1.");
  }
  const asset = requireAsset(provenance.asset);
  const market = requireMarket(provenance.market);
  if (market !== getMarketForAsset(asset)) {
    throw new Error(`Research candle dataset market must be ${getMarketForAsset(asset)} for ${asset}.`);
  }
  const historyStartAt = requireTimestamp(provenance.historyStartAt, "historyStartAt");
  const endAt = requireTimestamp(provenance.endAt, "endAt");
  const collectedAt = requireTimestamp(provenance.collectedAt, "collectedAt");
  if (compareEpochNanoseconds(historyStartAt.epochNanoseconds, endAt.epochNanoseconds) >= 0) {
    throw new Error("Research candle dataset provenance historyStartAt must be before endAt.");
  }
  if (compareEpochNanoseconds(endAt.epochNanoseconds, collectedAt.epochNanoseconds) > 0) {
    throw new Error("Research candle dataset provenance collectedAt must be at or after endAt.");
  }
  if (typeof provenance.source !== "string" || provenance.source.trim().length === 0) {
    throw new Error("Research candle dataset provenance source must be a non-empty string.");
  }

  const parsed = {
    schemaVersion: 1 as const,
    asset,
    market,
    historyStartAt: provenance.historyStartAt as string,
    endAt: provenance.endAt as string,
    collectedAt: provenance.collectedAt as string,
    source: provenance.source,
  };
  if (!requiresChecksum) {
    return parsed;
  }
  if (typeof provenance.sha256 !== "string" || !SHA256_HEX.test(provenance.sha256)) {
    throw new Error("Research candle dataset provenance sha256 must be a lowercase SHA-256 hex digest.");
  }

  return { ...parsed, sha256: provenance.sha256 };
}

function parseCandles(
  value: unknown,
  asset: SupportedAsset,
  market: SupportedMarket,
  historyStartAt: string,
  endAt: string,
): Record<ResearchCandleTimeframe, ResearchCandle[]> {
  const candleGroups = requireRecord(value, "Research candle dataset candles");
  for (const timeframe of TIMEFRAMES) {
    if (!Array.isArray(candleGroups[timeframe])) {
      throw new Error(`Research candle dataset ${timeframe} must be an array.`);
    }
  }
  assertExactKeys(candleGroups, TIMEFRAMES, "Research candle dataset candles");
  const historyStart = requireTimestamp(historyStartAt, "historyStartAt");
  const end = requireTimestamp(endAt, "endAt");

  return {
    "1h": parseCandleGroup(candleGroups["1h"], "1h", asset, market, historyStart, end),
    "4h": parseCandleGroup(candleGroups["4h"], "4h", asset, market, historyStart, end),
    "1d": parseCandleGroup(candleGroups["1d"], "1d", asset, market, historyStart, end),
  };
}

function parseCandleGroup(
  value: unknown,
  timeframe: ResearchCandleTimeframe,
  asset: SupportedAsset,
  market: SupportedMarket,
  historyStart: PerformanceTimestamp,
  end: PerformanceTimestamp,
): ResearchCandle[] {
  if (!Array.isArray(value)) {
    throw new Error(`Research candle dataset ${timeframe} must be an array.`);
  }

  let previousOpen: PerformanceTimestamp | null = null;
  let previousClose: PerformanceTimestamp | null = null;
  return value.map((candidate, index) => {
    const candle = requireRecord(candidate, `Research candle dataset ${timeframe}[${index}]`);
    assertExactKeys(
      candle,
      [
        "market",
        "timeframe",
        "openTime",
        "closeTime",
        "openPrice",
        "highPrice",
        "lowPrice",
        "closePrice",
        "volume",
        "quoteVolume",
      ],
      `Research candle dataset ${timeframe}[${index}]`,
    );
    if (candle.market !== market) {
      throw new Error(`Research candle dataset ${timeframe}[${index}] market must be ${market} for ${asset}.`);
    }
    if (candle.timeframe !== timeframe) {
      throw new Error(`Research candle dataset ${timeframe}[${index}] timeframe must be ${timeframe}.`);
    }

    const openTime = requireTimestamp(candle.openTime, `${timeframe}[${index}].openTime`);
    const closeTime = requireTimestamp(candle.closeTime, `${timeframe}[${index}].closeTime`);
    if (compareEpochNanoseconds(openTime.epochNanoseconds, closeTime.epochNanoseconds) >= 0) {
      throw new Error(`Research candle dataset ${timeframe}[${index}] openTime must be before closeTime.`);
    }
    const durationNanoseconds = closeTime.epochNanoseconds - openTime.epochNanoseconds;
    if (durationNanoseconds !== TIMEFRAME_DURATION_NANOSECONDS[timeframe]) {
      throw new Error(
        `Research candle dataset ${timeframe}[${index}] duration must be exactly ${TIMEFRAME_DURATION_LABEL[timeframe]}.`,
      );
    }
    if (compareEpochNanoseconds(openTime.epochNanoseconds, historyStart.epochNanoseconds) < 0
      || compareEpochNanoseconds(closeTime.epochNanoseconds, end.epochNanoseconds) > 0) {
      throw new Error(`Research candle dataset ${timeframe}[${index}] must be within the provenance history range.`);
    }
    if (
      (previousOpen && compareEpochNanoseconds(previousOpen.epochNanoseconds, openTime.epochNanoseconds) >= 0)
      || (previousClose && compareEpochNanoseconds(previousClose.epochNanoseconds, closeTime.epochNanoseconds) >= 0)
    ) {
      throw new Error(`Research candle dataset ${timeframe} candles must be strictly ordered by instant.`);
    }
    previousOpen = openTime;
    previousClose = closeTime;

    const openPrice = requirePositiveNumber(candle.openPrice, `${timeframe}[${index}].openPrice`);
    const highPrice = requirePositiveNumber(candle.highPrice, `${timeframe}[${index}].highPrice`);
    const lowPrice = requirePositiveNumber(candle.lowPrice, `${timeframe}[${index}].lowPrice`);
    const closePrice = requirePositiveNumber(candle.closePrice, `${timeframe}[${index}].closePrice`);
    if (lowPrice > openPrice || lowPrice > closePrice) {
      throw new Error(`Research candle dataset ${timeframe}[${index}] lowPrice must be less than or equal to openPrice and closePrice.`);
    }
    if (openPrice > highPrice || closePrice > highPrice) {
      throw new Error(`Research candle dataset ${timeframe}[${index}] openPrice and closePrice must be less than or equal to highPrice.`);
    }

    return {
      market,
      timeframe,
      openTime: candle.openTime as string,
      closeTime: candle.closeTime as string,
      openPrice,
      highPrice,
      lowPrice,
      closePrice,
      volume: requireNonNegativeNumber(candle.volume, `${timeframe}[${index}].volume`),
      quoteVolume: requireNonNegativeNumber(candle.quoteVolume, `${timeframe}[${index}].quoteVolume`),
    };
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = requireRecord(value, "Canonical research candle dataset value");
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

function assertExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.length !== expected.length || actualKeys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields.`);
  }
}

function requireAsset(value: unknown): SupportedAsset {
  if (value === "BTC" || value === "ETH") return value;
  throw new Error("Research candle dataset provenance asset must be BTC or ETH.");
}

function requireMarket(value: unknown): SupportedMarket {
  if (value === "KRW-BTC" || value === "KRW-ETH") return value;
  throw new Error("Research candle dataset provenance market must be KRW-BTC or KRW-ETH.");
}

function requireTimestamp(value: unknown, label: string): PerformanceTimestamp {
  if (typeof value !== "string") {
    throw new Error(`Research candle dataset ${label} must be an explicit-timezone ISO timestamp.`);
  }
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) {
    throw new Error(`Research candle dataset ${label} must be an explicit-timezone ISO timestamp.`);
  }
  return parsed;
}

function requirePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Research candle dataset ${label} must be a finite positive number.`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Research candle dataset ${label} must be a finite non-negative number.`);
  }
  return value;
}
