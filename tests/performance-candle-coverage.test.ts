import assert from "node:assert/strict";

import {
  analyzePositionGuardFeatureCoverage,
  type PositionGuardFeatureCoverageFrame,
} from "../src/modules/performance/performance-candle-coverage.js";
import type {
  ResearchCandle,
  ResearchCandleDataset,
  ResearchCandleTimeframe,
} from "../src/modules/performance/research-candle-dataset.js";
import { test } from "./harness.js";

const HOUR_MS = 60 * 60 * 1000;
const LOOKBACK = 200;

test("feature coverage accepts continuous 200-candle lookbacks for every timeframe", () => {
  const dataset = continuousDataset(205);
  const frames = [frameAtLatest(dataset)];

  const result = analyzePositionGuardFeatureCoverage({ dataset, frames, requiredLookbackCandles: LOOKBACK });

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.affectedFrameCount, 0);
  for (const timeframe of ["1h", "4h", "1d"] as const) {
    assert.equal(result.timeframes[timeframe].sourceCadenceStatus, "COMPLETE");
    assert.equal(result.timeframes[timeframe].sourceSequenceStatus, "COMPLETE");
    assert.equal(result.timeframes[timeframe].clockGridStatus, "DENSE");
    assert.equal(result.timeframes[timeframe].sourceNoTradeIntervalCount, 0);
    assert.deepEqual(result.timeframes[timeframe].sourceNoTradeRanges, []);
    assert.equal(result.timeframes[timeframe].sourceBlockingAnomalyCount, 0);
    assert.equal(result.timeframes[timeframe].lookbackContinuityStatus, "COMPLETE");
    assert.equal(result.timeframes[timeframe].affectedFrameCount, 0);
  }
});

test("feature coverage records an internal 1h no-trade gap without blocking actual-candle lookback", () => {
  const source = continuousDataset(205);
  const dataset = datasetFromCandles({
    ...source.candles,
    "1h": source.candles["1h"].filter((_, index) => index !== 100),
  }, source.provenance.historyStartAt, source.provenance.endAt);
  const frames = [frameAtLatest(dataset)];

  const result = analyzePositionGuardFeatureCoverage({ dataset, frames, requiredLookbackCandles: LOOKBACK });
  const oneHourCoverage = result.timeframes["1h"];

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.continuityPolicy, "GENERATED_CANDLES_SINCE_DATASET_START");
  assert.equal(result.affectedFrameCount, 0);
  assert.equal(oneHourCoverage.sourceCadenceStatus, "INCOMPLETE");
  assert.equal(oneHourCoverage.sourceSequenceStatus, "COMPLETE");
  assert.equal(oneHourCoverage.clockGridStatus, "SPARSE_BY_CONTRACT");
  assert.equal(oneHourCoverage.sourceMissingCandleCount, 1);
  assert.equal(oneHourCoverage.sourceNoTradeIntervalCount, 1);
  assert.deepEqual(oneHourCoverage.sourceNoTradeRanges, oneHourCoverage.sourceMissingRanges);
  assert.equal(oneHourCoverage.sourceBlockingAnomalyCount, 0);
  assert.equal(oneHourCoverage.lookbackContinuityStatus, "COMPLETE");
  assert.equal(oneHourCoverage.affectedFrameCount, 0);
});

test("source no-trade ranges are defensive copies of nominal missing-range evidence", () => {
  const source = continuousDataset(205);
  const dataset = datasetFromCandles({
    ...source.candles,
    "1h": source.candles["1h"].filter((_, index) => index !== 100),
  }, source.provenance.historyStartAt, source.provenance.endAt);

  const coverage = analyzePositionGuardFeatureCoverage({
    dataset,
    frames: [frameAtLatest(dataset)],
    requiredLookbackCandles: LOOKBACK,
  }).timeframes["1h"];
  coverage.sourceNoTradeRanges[0]!.missingCandleCount = 999;

  assert.equal(coverage.sourceMissingRanges[0]!.missingCandleCount, 1);
  assert.equal(coverage.sourceNoTradeIntervalCount, 1);
});

test("an adjacent 1h no-trade gap is grouped without poisoning recursive actual candle input", () => {
  const source = continuousDataset(205);
  const dataset = datasetFromCandles({
    ...source.candles,
    "1h": source.candles["1h"].filter((_, index) => index !== 1 && index !== 2),
  }, source.provenance.historyStartAt, source.provenance.endAt);
  const frames = [frameAtLatest(dataset)];

  const result = analyzePositionGuardFeatureCoverage({ dataset, frames, requiredLookbackCandles: LOOKBACK });

  assert.equal(result.timeframes["1h"].sourceCadenceStatus, "INCOMPLETE");
  assert.equal(result.timeframes["1h"].sourceSequenceStatus, "COMPLETE");
  assert.equal(result.timeframes["1h"].sourceMissingCandleCount, 2);
  assert.equal(result.timeframes["1h"].sourceNoTradeIntervalCount, 2);
  assert.deepEqual(result.timeframes["1h"].sourceNoTradeRanges, [{
    firstMissingCloseTime: source.candles["1h"][1]!.closeTime,
    lastMissingCloseTime: source.candles["1h"][2]!.closeTime,
    missingCandleCount: 2,
    previousObservedCloseTime: source.candles["1h"][0]!.closeTime,
    nextObservedCloseTime: source.candles["1h"][3]!.closeTime,
  }]);
  assert.equal(result.continuityPolicy, "GENERATED_CANDLES_SINCE_DATASET_START");
  assert.equal(result.timeframes["1h"].lookbackContinuityStatus, "COMPLETE");
  assert.equal(result.affectedFrameCount, 0);
  assert.equal(result.status, "COMPLETE");
});

test("sparse no-trade gaps are independently nonblocking in 1h, 4h, and 1d", () => {
  const source = continuousDataset(205);
  const dataset = datasetFromCandles({
    ...source.candles,
    "1h": source.candles["1h"].filter((_, index) => index !== 100),
    "4h": source.candles["4h"].filter((_, index) => index !== 100),
    "1d": source.candles["1d"].filter((_, index) => index !== 100),
  }, source.provenance.historyStartAt, source.provenance.endAt);

  const result = analyzePositionGuardFeatureCoverage({
    dataset,
    frames: [frameAtLatest(dataset)],
    requiredLookbackCandles: LOOKBACK,
  });

  assert.equal(result.status, "COMPLETE");
  for (const timeframe of ["1h", "4h", "1d"] as const) {
    assert.equal(result.timeframes[timeframe].sourceCadenceStatus, "INCOMPLETE");
    assert.equal(result.timeframes[timeframe].sourceSequenceStatus, "COMPLETE");
    assert.equal(result.timeframes[timeframe].clockGridStatus, "SPARSE_BY_CONTRACT");
    assert.equal(result.timeframes[timeframe].sourceNoTradeIntervalCount, 1);
    assert.equal(result.timeframes[timeframe].lookbackContinuityStatus, "COMPLETE");
  }
});

test("source cadence exposes duplicate and off-grid candle evidence", () => {
  const source = continuousDataset(205);
  const oneHour = [...source.candles["1h"]];
  oneHour.splice(4_805, 0, { ...oneHour[4_804]! });
  oneHour[4_810] = shiftCandle(oneHour[4_810]!, 15 * 60 * 1000);
  const dataset = datasetFromCandles({
    ...source.candles,
    "1h": oneHour,
  }, source.provenance.historyStartAt, source.provenance.endAt);
  const beforeAnomaly = frameAtDecision(dataset, source.candles["1h"][4_799]!.closeTime);
  const afterAnomaly = frameAtDecision(dataset, source.candles["1h"][4_815]!.closeTime);

  const result = analyzePositionGuardFeatureCoverage({
    dataset,
    frames: [beforeAnomaly, afterAnomaly],
    requiredLookbackCandles: LOOKBACK,
  });

  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.timeframes["1h"].sourceCadenceStatus, "INCOMPLETE");
  assert.equal(result.timeframes["1h"].sourceSequenceStatus, "INCOMPLETE");
  assert.equal(result.timeframes["1h"].clockGridStatus, "ANOMALOUS");
  assert.equal(result.timeframes["1h"].sourceDuplicateCandleCount, 1);
  assert.equal(result.timeframes["1h"].sourceOffGridCandleCount, 1);
  assert.deepEqual(result.timeframes["1h"].sourceDuplicateInstants, [{
    observedAt: oneHour[4_804]!.closeTime,
    occurrenceCount: 2,
  }]);
  assert.deepEqual(result.timeframes["1h"].sourceOffGridInstants, [{
    observedAt: oneHour[4_810]!.closeTime,
    occurrenceCount: 1,
  }]);
  assert.equal(result.timeframes["1h"].sourceBlockingAnomalyCount, 2);
  assert.equal(result.timeframes["1h"].affectedFrameCount, 1);
  assert.deepEqual(result.timeframes["1h"].affectedFrameRanges, [{
    firstFrameAt: afterAnomaly.generatedAt,
    lastFrameAt: afterAnomaly.generatedAt,
    affectedFrameCount: 1,
  }]);
  assert.equal(result.timeframes["4h"].affectedFrameCount, 0);
  assert.equal(result.timeframes["1d"].affectedFrameCount, 0);
  assert.equal(result.affectedFrameCount, 1);
});

test("feature coverage rejects a frame that references a future candle", () => {
  const dataset = continuousDataset(205);
  const frame = frameAtLatest(dataset);
  frame.generatedAt = "2025-01-01T01:00:00.000Z";

  assert.throws(
    () => analyzePositionGuardFeatureCoverage({ dataset, frames: [frame], requiredLookbackCandles: LOOKBACK }),
    /latestCloseTime.*after.*generatedAt/i,
  );
});

test("feature coverage treats an observed candle after the dataset boundary as a blocking anomaly", () => {
  const source = continuousDataset(205);
  const afterBoundary = makeCandles("1h", 1).map((candle) => ({
    ...candle,
    openTime: source.provenance.endAt,
    closeTime: new Date(Date.parse(source.provenance.endAt) + HOUR_MS).toISOString(),
  }));
  const dataset = datasetFromCandles({
    ...source.candles,
    "1h": [...source.candles["1h"], ...afterBoundary],
  }, source.provenance.historyStartAt, source.provenance.endAt);

  const beforeAnomaly = frameAtDecision(dataset, source.provenance.endAt);
  const afterAnomaly = frameAtDecision(dataset, afterBoundary[0]!.closeTime);
  const result = analyzePositionGuardFeatureCoverage({
    dataset,
    frames: [beforeAnomaly, afterAnomaly],
    requiredLookbackCandles: LOOKBACK,
  });

  assert.equal(result.timeframes["1h"].sourceSequenceStatus, "INCOMPLETE");
  assert.equal(result.timeframes["1h"].clockGridStatus, "ANOMALOUS");
  assert.equal(result.timeframes["1h"].sourceOffGridCandleCount, 1);
  assert.equal(result.timeframes["1h"].sourceBlockingAnomalyCount, 1);
  assert.equal(result.timeframes["1h"].affectedFrameCount, 1);
  assert.deepEqual(result.timeframes["1h"].affectedFrameRanges, [{
    firstFrameAt: afterAnomaly.generatedAt,
    lastFrameAt: afterAnomaly.generatedAt,
    affectedFrameCount: 1,
  }]);
  assert.equal(result.timeframes["4h"].affectedFrameCount, 0);
  assert.equal(result.timeframes["1d"].affectedFrameCount, 0);
  assert.equal(result.affectedFrameCount, 1);
  assert.equal(result.status, "INCOMPLETE");
});

test("feature coverage records leading and trailing provenance grid gaps as no-trade evidence", () => {
  const source = continuousDataset(205);
  const dataset = datasetFromCandles({
    ...source.candles,
    "1h": source.candles["1h"].slice(1),
    "4h": source.candles["4h"].slice(0, -1),
  }, source.provenance.historyStartAt, source.provenance.endAt);

  const result = analyzePositionGuardFeatureCoverage({
    dataset,
    frames: [frameAtLatest(dataset)],
    requiredLookbackCandles: LOOKBACK,
  });

  assert.equal(result.timeframes["1h"].sourceMissingCandleCount, 1);
  assert.equal(result.timeframes["1h"].sourceMissingRanges[0]?.firstMissingCloseTime,
    source.candles["1h"][0]!.closeTime);
  assert.equal(result.timeframes["4h"].sourceMissingCandleCount, 1);
  assert.equal(result.timeframes["4h"].sourceMissingRanges[0]?.lastMissingCloseTime,
    source.candles["4h"].at(-1)!.closeTime);
  assert.equal(result.timeframes["1h"].sourceNoTradeIntervalCount, 1);
  assert.equal(result.timeframes["4h"].sourceNoTradeIntervalCount, 1);
  assert.equal(result.status, "COMPLETE");
});

test("feature coverage allows a decision during a no-trade interval to reference the latest actual candle", () => {
  const source = continuousDataset(205);
  const missingIndex = 4_800;
  const dataset = datasetFromCandles({
    ...source.candles,
    "1h": source.candles["1h"].filter((_, index) => index !== missingIndex),
  }, source.provenance.historyStartAt, source.provenance.endAt);
  const decisionAt = source.candles["1h"][missingIndex]!.closeTime;
  const frame: PositionGuardFeatureCoverageFrame = {
    generatedAt: decisionAt,
    latestCloseTime: {
      "1h": source.candles["1h"][missingIndex - 1]!.closeTime,
      "4h": source.candles["4h"].filter((candle) => Date.parse(candle.closeTime) <= Date.parse(decisionAt)).at(-1)!.closeTime,
      "1d": source.candles["1d"].filter((candle) => Date.parse(candle.closeTime) <= Date.parse(decisionAt)).at(-1)!.closeTime,
    },
  };

  const result = analyzePositionGuardFeatureCoverage({ dataset, frames: [frame], requiredLookbackCandles: LOOKBACK });

  assert.equal(result.status, "COMPLETE");
  assert.equal(result.affectedFrameCount, 0);
  assert.equal(result.timeframes["1h"].lookbackContinuityStatus, "COMPLETE");
});

test("feature coverage blocks insufficient actual candles despite a valid source sequence", () => {
  const source = continuousDataset(205);
  const dataset = datasetFromCandles({
    ...source.candles,
    "1h": source.candles["1h"].slice(-199),
  }, source.provenance.historyStartAt, source.provenance.endAt);
  const result = analyzePositionGuardFeatureCoverage({
    dataset,
    frames: [frameAtLatest(dataset)],
    requiredLookbackCandles: LOOKBACK,
  });

  assert.equal(result.timeframes["1h"].sourceSequenceStatus, "COMPLETE");
  assert.equal(result.timeframes["1h"].lookbackContinuityStatus, "INCOMPLETE");
  assert.equal(result.status, "INCOMPLETE");
});

test("feature coverage blocks a timeframe with no actual generated candles", () => {
  const source = continuousDataset(205);
  const dataset = datasetFromCandles({
    ...source.candles,
    "1h": [],
  }, source.provenance.historyStartAt, source.provenance.endAt);
  const frame = frameAtLatest(source);
  frame.latestCloseTime["1h"] = null;

  const result = analyzePositionGuardFeatureCoverage({ dataset, frames: [frame], requiredLookbackCandles: LOOKBACK });

  assert.equal(result.timeframes["1h"].sourceSequenceStatus, "INCOMPLETE");
  assert.equal(result.timeframes["1h"].lookbackContinuityStatus, "INCOMPLETE");
  assert.equal(result.status, "INCOMPLETE");
});

function continuousDataset(dayCount: number): ResearchCandleDataset {
  const historyStartAt = "2025-01-01T00:00:00.000Z";
  const endAt = new Date(Date.parse(historyStartAt) + dayCount * 24 * HOUR_MS).toISOString();
  return datasetFromCandles({
    "1h": makeCandles("1h", dayCount * 24),
    "4h": makeCandles("4h", dayCount * 6),
    "1d": makeCandles("1d", dayCount),
  }, historyStartAt, endAt);
}

function datasetFromCandles(
  candles: ResearchCandleDataset["candles"],
  historyStartAt = "2025-01-01T00:00:00.000Z",
  endAt = "2028-01-01T00:00:00.000Z",
): ResearchCandleDataset {
  return {
    provenance: {
      schemaVersion: 1,
      asset: "BTC",
      market: "KRW-BTC",
      historyStartAt,
      endAt,
      collectedAt: endAt,
      source: "fixture",
      sha256: "a".repeat(64),
    },
    candles,
  };
}

function makeCandles(timeframe: ResearchCandleTimeframe, count: number): ResearchCandle[] {
  const intervalMs = timeframe === "1h" ? HOUR_MS : timeframe === "4h" ? 4 * HOUR_MS : 24 * HOUR_MS;
  const startMs = Date.parse("2025-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, index) => {
    const openMs = startMs + index * intervalMs;
    return {
      market: "KRW-BTC",
      timeframe,
      openTime: new Date(openMs).toISOString(),
      closeTime: new Date(openMs + intervalMs).toISOString(),
      openPrice: 100,
      highPrice: 102,
      lowPrice: 99,
      closePrice: 101,
      volume: 1,
      quoteVolume: 101,
    };
  });
}

function frameAtLatest(dataset: ResearchCandleDataset): PositionGuardFeatureCoverageFrame {
  const latestCloseTime = {
    "1h": dataset.candles["1h"].at(-1)!.closeTime,
    "4h": dataset.candles["4h"].at(-1)!.closeTime,
    "1d": dataset.candles["1d"].at(-1)!.closeTime,
  };
  const generatedAt = new Date(Math.max(
    ...Object.values(latestCloseTime).map((timestamp) => Date.parse(timestamp)),
  )).toISOString();
  return {
    generatedAt,
    latestCloseTime,
  };
}

function frameAtDecision(
  dataset: ResearchCandleDataset,
  generatedAt: string,
): PositionGuardFeatureCoverageFrame {
  const generatedAtMs = Date.parse(generatedAt);
  return {
    generatedAt,
    latestCloseTime: {
      "1h": latestCloseAtOrBefore(dataset.candles["1h"], generatedAtMs),
      "4h": latestCloseAtOrBefore(dataset.candles["4h"], generatedAtMs),
      "1d": latestCloseAtOrBefore(dataset.candles["1d"], generatedAtMs),
    },
  };
}

function latestCloseAtOrBefore(candles: readonly ResearchCandle[], generatedAtMs: number): string | null {
  return candles.filter((candle) => Date.parse(candle.closeTime) <= generatedAtMs).at(-1)?.closeTime ?? null;
}

function shiftCandle(candle: ResearchCandle, offsetMs: number): ResearchCandle {
  return {
    ...candle,
    openTime: new Date(Date.parse(candle.openTime) + offsetMs).toISOString(),
    closeTime: new Date(Date.parse(candle.closeTime) + offsetMs).toISOString(),
  };
}
