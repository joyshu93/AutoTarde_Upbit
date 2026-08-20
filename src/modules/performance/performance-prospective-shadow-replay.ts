import { createHash } from "node:crypto";

import type { SupportedStrategyTimeframe } from "../strategy/market-structure.js";
import type { PositionGuardBacktestFrame } from "../strategy/position-guard-backtest.js";
import {
  analyzePositionGuardFeatureCoverage,
  type PositionGuardFeatureCoverage,
} from "./performance-candle-coverage.js";
import {
  analyzeHoldoutEpisodeAttribution,
  type HoldoutEpisodeAttributionInput,
  type HoldoutEpisodeAttributionResult,
  type HoldoutEpisodePathProvenance,
} from "./performance-holdout-episode-attribution.js";
import {
  PROSPECTIVE_SHADOW_ASSETS,
  PROSPECTIVE_SHADOW_COSTS,
  PROSPECTIVE_SHADOW_SCENARIOS,
  PROSPECTIVE_SHADOW_TIMINGS,
  validateProspectiveShadowRegistration,
  type ProspectiveShadowRegistration,
} from "./performance-prospective-shadow-registration.js";
import type {
  ProspectiveShadowCompletenessGate,
  ProspectiveShadowMetricEvidence,
  ProspectiveShadowPathEvidence,
} from "./performance-prospective-shadow-evaluation.js";
import {
  calculateResearchCandleDatasetChecksum,
  parseResearchCandleDataset,
  type ResearchCandleDataset,
} from "./research-candle-dataset.js";
import {
  parseResearchNoTradeEvidence,
  validateResearchNoTradeEvidenceForDataset,
  type ResearchNoTradeEvidence,
} from "./research-no-trade-evidence.js";
import {
  runCounterfactualScenarios,
  type CounterfactualInput,
  type CounterfactualScenarioResult,
} from "./strategy-counterfactual.js";
import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
  type PerformanceTimestamp,
} from "./performance-timestamp.js";

export interface ProspectiveShadowFrameBuilderInput {
  readonly asset: "BTC" | "ETH";
  readonly market: "KRW-BTC" | "KRW-ETH";
  readonly dataset: ResearchCandleDataset;
  readonly featureWarmupStartAt: string;
  readonly decisionFrom: string;
  readonly decisionTo: string;
  readonly minimumCompletedCandles: Readonly<Record<SupportedStrategyTimeframe, number>>;
}

export type ProspectiveShadowFrameBuilder = (
  input: ProspectiveShadowFrameBuilderInput,
) => readonly PositionGuardBacktestFrame[];

/** Pure seams permit replay-boundary validation with synthetic research evidence. */
export type ProspectiveShadowCounterfactualRunner = (
  input: CounterfactualInput,
) => readonly CounterfactualScenarioResult[];

export type ProspectiveShadowRelationshipAnalyzer = (
  input: HoldoutEpisodeAttributionInput,
) => HoldoutEpisodeAttributionResult;

export interface BuildProspectiveShadowReplayEvidenceInput {
  readonly registration: ProspectiveShadowRegistration;
  readonly datasets: readonly Readonly<{
    asset: "BTC" | "ETH";
    dataset: ResearchCandleDataset;
    noTradeEvidence: ResearchNoTradeEvidence;
  }>[];
  readonly frameBuilder: ProspectiveShadowFrameBuilder;
  readonly minimumCompletedCandles: Readonly<Record<SupportedStrategyTimeframe, number>>;
  readonly requiredFeatureLookbackCandles: number;
  readonly counterfactualRunner?: ProspectiveShadowCounterfactualRunner | undefined;
  readonly relationshipAnalyzer?: ProspectiveShadowRelationshipAnalyzer | undefined;
}

export interface ProspectiveShadowReplayEvidenceReader {
  read(): Promise<BuildProspectiveShadowReplayEvidenceInput["datasets"]>;
}

export interface BuildProspectiveShadowReplayEvidenceFromReaderInput {
  readonly registration: ProspectiveShadowRegistration;
  readonly frameBuilder: ProspectiveShadowFrameBuilder;
  readonly minimumCompletedCandles: Readonly<Record<SupportedStrategyTimeframe, number>>;
  readonly requiredFeatureLookbackCandles: number;
  readonly reader: ProspectiveShadowReplayEvidenceReader;
  readonly counterfactualRunner?: ProspectiveShadowCounterfactualRunner | undefined;
  readonly relationshipAnalyzer?: ProspectiveShadowRelationshipAnalyzer | undefined;
}

export type ProspectiveShadowReplayCadenceEvidence = Readonly<{
  complete: boolean;
  warmupExpectedHourlyIntervals: number;
  warmupObservedHourlyIntervals: number;
  warmupVerifiedNoTradeHourlyIntervals: number;
  warmupUnexplainedHourlyIntervals: number;
  expectedHourlyIntervals: number;
  observedHourlyIntervals: number;
  verifiedNoTradeHourlyIntervals: number;
  unexplainedHourlyIntervals: number;
}>;

export type ProspectiveShadowReplayPath = Readonly<{
  asset: "BTC" | "ETH";
  market: "KRW-BTC" | "KRW-ETH";
  scenario: typeof PROSPECTIVE_SHADOW_SCENARIOS[number];
  timing: typeof PROSPECTIVE_SHADOW_TIMINGS[number];
  costId: typeof PROSPECTIVE_SHADOW_COSTS[number]["id"];
  initialState: Readonly<{
    cashKrw: 1_000_000;
    quantity: 0;
    openEpisode: false;
    addCount: 0;
    cooldownActive: false;
  }>;
  featureFrameCount: number;
  replayFrameCount: number;
  cadence: ProspectiveShadowReplayCadenceEvidence;
  featureCoverage: PositionGuardFeatureCoverage;
  feeEvidence: Readonly<{ complete: boolean; unknownReason: string | null }>;
  lifecycleEvidence: Readonly<{ complete: boolean; unknownReason: string | null }>;
  relationshipEvidence: Readonly<{ complete: boolean; unknownReason: string | null }>;
  counterfactual: CounterfactualScenarioResult;
  relationships: HoldoutEpisodeAttributionResult | null;
  pathEvidence: ProspectiveShadowPathEvidence;
}>;

export type ProspectiveShadowReplayEvidence = Readonly<{
  schemaVersion: 1;
  authority: ProspectiveShadowRegistration["authority"];
  experimentId: ProspectiveShadowRegistration["experimentId"];
  window: ProspectiveShadowRegistration["window"];
  paths: readonly ProspectiveShadowReplayPath[];
  pathEvidence: readonly ProspectiveShadowPathEvidence[];
}>;

export type ProspectiveShadowReplayPathEvidenceInspection = Readonly<{
  feeEvidence: Readonly<{ complete: boolean; unknownReason: string | null }>;
  lifecycleEvidence: Readonly<{ complete: boolean; unknownReason: string | null }>;
  pathEvidence: ProspectiveShadowPathEvidence;
}>;

type MutableProspectiveShadowReplayPath = Omit<ProspectiveShadowReplayPath, "relationships" | "relationshipEvidence" | "pathEvidence"> & {
  relationships: HoldoutEpisodeAttributionResult | null;
  relationshipEvidence: { complete: boolean; unknownReason: string | null };
  pathEvidence: ProspectiveShadowPathEvidence;
};

const HOUR_NANOSECONDS = 3_600_000_000_000n;
const INITIAL_STATE = {
  cashKrw: 1_000_000,
  quantity: 0,
  openEpisode: false,
  addCount: 0,
  cooldownActive: false,
} as const;

export function buildProspectiveShadowReplayEvidence(
  input: BuildProspectiveShadowReplayEvidenceInput,
): ProspectiveShadowReplayEvidence {
  const detached: BuildProspectiveShadowReplayEvidenceInput = {
    registration: structuredClone(input.registration),
    datasets: input.datasets.map((pair) => structuredClone(pair)),
    frameBuilder: input.frameBuilder,
    minimumCompletedCandles: structuredClone(input.minimumCompletedCandles),
    requiredFeatureLookbackCandles: input.requiredFeatureLookbackCandles,
    counterfactualRunner: input.counterfactualRunner,
    relationshipAnalyzer: input.relationshipAnalyzer,
  };
  const registration = validateProspectiveShadowRegistration(detached.registration);
  validateFrameRequirements(detached);
  const pairs = normalizePairs(detached.datasets, registration);
  const paths: MutableProspectiveShadowReplayPath[] = [];
  const replayDatasets = new Map<"BTC" | "ETH", ResearchCandleDataset>();

  for (const pair of pairs) {
    const prepared = prepareDataset(pair, registration);
    replayDatasets.set(pair.asset, prepared.dataset);
    const beforeBuild = JSON.stringify(prepared.dataset);
    const featureFrames = normalizeFrames(detached.frameBuilder({
      asset: pair.asset,
      market: pair.dataset.provenance.market,
      dataset: prepared.dataset,
      featureWarmupStartAt: registration.policyManifest.featureWarmupStartAt,
      decisionFrom: registration.window.from,
      decisionTo: registration.window.to,
      minimumCompletedCandles: detached.minimumCompletedCandles,
    }));
    if (JSON.stringify(prepared.dataset) !== beforeBuild) {
      throw new Error("Prospective replay frame builder must not mutate its clipped dataset.");
    }
    const replayFrames = featureFrames.filter((frame) => inRange(
      requireTimestamp(frame.generatedAt, "frame generatedAt").epochNanoseconds,
      registration.window.from,
      registration.window.to,
    ));
    const featureCoverage = analyzePositionGuardFeatureCoverage({
      dataset: prepared.dataset,
      frames: replayFrames.map((frame) => ({
        generatedAt: frame.generatedAt,
        latestCloseTime: requireFrameSource(frame).latestCloseTime,
      })),
      requiredLookbackCandles: detached.requiredFeatureLookbackCandles,
    });

    for (const scenario of registration.matrix.scenarios) {
      for (const timing of registration.matrix.timings) {
        for (const cost of registration.matrix.costs) {
          const counterfactual = runCounterfactual(
            detached.counterfactualRunner, {
            asset: pair.asset,
            market: pair.dataset.provenance.market,
            initialCashKrw: INITIAL_STATE.cashKrw,
            initialQuantity: INITIAL_STATE.quantity,
            initialAverageEntryPrice: 0,
            frames: replayFrames,
            scenarios: [scenario],
            executionTimingModel: timing,
            execution: {
              feeRate: cost.feeRate,
              slippageRate: cost.slippageRate,
              minimumTradeValueKrw: registration.minimumOrderValueKrw,
            },
            diagnosticPolicy: { breakevenToleranceKrw: 0 },
            researchCarryInState: {
              currentEpisodeAddCount: 0,
              currentEpisodeRealizedPnlKrw: 0,
              lastFullExitAt: null,
              lastFullExitRealizedPnlKrw: null,
              lastEntryPath: null,
            },
          }, scenario);
          assertWindowBounded(counterfactual, registration);
          const orderedCounterfactual = orderCounterfactualFills(counterfactual);
          const feeEvidence = deriveFeeEvidence(orderedCounterfactual);
          const lifecycleEvidence = deriveLifecycleEvidence(orderedCounterfactual, registration);
          const pathEvidence = buildPathEvidence({
            registration,
            asset: pair.asset,
            market: pair.dataset.provenance.market,
            scenario,
            timing,
            costId: cost.id,
            cadence: prepared.cadence,
            featureCoverage,
            feeEvidence,
            lifecycleEvidence,
            relationshipEvidence: scenario === "COMBINED_CONSERVATIVE"
              ? { complete: true, unknownReason: null }
              : { complete: false, unknownReason: "Episode relationship evidence has not been evaluated." },
            counterfactual: orderedCounterfactual,
          });
          paths.push({
            asset: pair.asset,
            market: pair.dataset.provenance.market,
            scenario,
            timing,
            costId: cost.id,
            initialState: { ...INITIAL_STATE },
            featureFrameCount: featureFrames.length,
            replayFrameCount: replayFrames.length,
            cadence: prepared.cadence,
            featureCoverage,
            feeEvidence,
            lifecycleEvidence,
            relationshipEvidence: scenario === "COMBINED_CONSERVATIVE"
              ? { complete: true, unknownReason: null }
              : { complete: false, unknownReason: "Episode relationship evidence has not been evaluated." },
            counterfactual: orderedCounterfactual,
            relationships: null,
            pathEvidence,
          });
        }
      }
    }
  }

  assertExactMatrix(paths, registration);
  attachRelationships(paths, replayDatasets, registration, detached.relationshipAnalyzer);
  for (const path of paths) {
    path.pathEvidence = buildPathEvidence({
      registration,
      asset: path.asset,
      market: path.market,
      scenario: path.scenario,
      timing: path.timing,
      costId: path.costId,
      cadence: path.cadence,
      featureCoverage: path.featureCoverage,
      feeEvidence: path.feeEvidence,
      lifecycleEvidence: path.lifecycleEvidence,
      relationshipEvidence: path.relationshipEvidence,
      counterfactual: path.counterfactual,
    });
  }
  const pathEvidence = paths.map((path) => path.pathEvidence);
  assertExactMatrix(pathEvidence, registration);
  return deepFreeze({
    schemaVersion: 1,
    authority: registration.authority,
    experimentId: registration.experimentId,
    window: structuredClone(registration.window),
    paths: structuredClone(paths),
    pathEvidence: structuredClone(pathEvidence),
  });
}

export async function buildProspectiveShadowReplayEvidenceFromReader(
  input: BuildProspectiveShadowReplayEvidenceFromReaderInput,
): Promise<ProspectiveShadowReplayEvidence> {
  if (!input.reader || typeof input.reader.read !== "function") {
    throw new Error("Prospective replay evidence reader must provide a read function.");
  }
  const snapshot = {
    registration: structuredClone(input.registration),
    frameBuilder: input.frameBuilder,
    minimumCompletedCandles: structuredClone(input.minimumCompletedCandles),
    requiredFeatureLookbackCandles: input.requiredFeatureLookbackCandles,
    counterfactualRunner: input.counterfactualRunner,
    relationshipAnalyzer: input.relationshipAnalyzer,
  };
  const datasets = structuredClone(await input.reader.read());
  return buildProspectiveShadowReplayEvidence({ ...snapshot, datasets });
}

function validateFrameRequirements(input: BuildProspectiveShadowReplayEvidenceInput): void {
  if (typeof input.frameBuilder !== "function") throw new Error("Prospective replay requires a pure frameBuilder.");
  if (input.counterfactualRunner !== undefined && typeof input.counterfactualRunner !== "function") {
    throw new Error("Prospective replay counterfactualRunner must be a pure function.");
  }
  if (input.relationshipAnalyzer !== undefined && typeof input.relationshipAnalyzer !== "function") {
    throw new Error("Prospective replay relationshipAnalyzer must be a pure function.");
  }
  if (!Number.isSafeInteger(input.requiredFeatureLookbackCandles) || input.requiredFeatureLookbackCandles <= 0) {
    throw new Error("Prospective replay requiredFeatureLookbackCandles must be a positive safe integer.");
  }
  for (const timeframe of ["1h", "4h", "1d"] as const) {
    const value = input.minimumCompletedCandles[timeframe];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Prospective replay minimumCompletedCandles.${timeframe} must be a positive safe integer.`);
    }
  }
}

function normalizePairs(
  pairs: BuildProspectiveShadowReplayEvidenceInput["datasets"],
  registration: ProspectiveShadowRegistration,
): readonly Readonly<{ asset: "BTC" | "ETH"; dataset: ResearchCandleDataset; noTradeEvidence: ResearchNoTradeEvidence }>[] {
  if (pairs.length !== registration.matrix.assets.length) {
    throw new Error("Prospective replay requires exactly one dataset and sidecar for BTC and ETH.");
  }
  return registration.matrix.assets.map((expected, index) => {
    const candidate = pairs[index];
    if (!candidate || candidate.asset !== expected.asset) {
      throw new Error("Prospective replay datasets must follow the registered BTC then ETH order.");
    }
    const dataset = parseResearchCandleDataset(JSON.stringify(candidate.dataset));
    const noTradeEvidence = parseResearchNoTradeEvidence(JSON.stringify(candidate.noTradeEvidence));
    validateResearchNoTradeEvidenceForDataset(noTradeEvidence, dataset);
    if (dataset.provenance.asset !== expected.asset || dataset.provenance.market !== expected.market) {
      throw new Error("Prospective replay dataset identity does not match the registered asset and market.");
    }
    return { asset: expected.asset, dataset, noTradeEvidence };
  });
}

function prepareDataset(
  pair: Readonly<{ asset: "BTC" | "ETH"; dataset: ResearchCandleDataset; noTradeEvidence: ResearchNoTradeEvidence }>,
  registration: ProspectiveShadowRegistration,
): Readonly<{ dataset: ResearchCandleDataset; cadence: ProspectiveShadowReplayCadenceEvidence }> {
  const warmup = requireTimestamp(registration.policyManifest.featureWarmupStartAt, "feature warmup start");
  const from = requireTimestamp(registration.window.from, "window from");
  const to = requireTimestamp(registration.window.to, "window to");
  const historyStart = requireTimestamp(pair.dataset.provenance.historyStartAt, "dataset historyStartAt");
  const datasetEnd = requireTimestamp(pair.dataset.provenance.endAt, "dataset endAt");
  const collectedAt = requireTimestamp(pair.dataset.provenance.collectedAt, "dataset collectedAt");
  const sidecarCollectedAt = requireTimestamp(pair.noTradeEvidence.provenance.collectedAt, "sidecar collectedAt");
  const sidecarFrom = requireTimestamp(pair.noTradeEvidence.provenance.from, "sidecar from");
  const sidecarTo = requireTimestamp(pair.noTradeEvidence.provenance.to, "sidecar to");
  if (collectedAt.epochNanoseconds < to.epochNanoseconds || sidecarCollectedAt.epochNanoseconds < to.epochNanoseconds) {
    throw new Error("Prospective replay dataset and no-trade sidecar must be collected at or after window.to.");
  }
  if (historyStart.epochNanoseconds > warmup.epochNanoseconds || datasetEnd.epochNanoseconds < to.epochNanoseconds) {
    throw new Error("Prospective replay dataset must cover the registered feature warmup and full window.");
  }
  if (sidecarFrom.epochNanoseconds > warmup.epochNanoseconds || sidecarTo.epochNanoseconds < to.epochNanoseconds) {
    throw new Error("Prospective replay no-trade sidecar must cover the registered feature warmup and full window.");
  }
  const clipped = {
    provenance: {
      schemaVersion: 1 as const,
      asset: pair.dataset.provenance.asset,
      market: pair.dataset.provenance.market,
      historyStartAt: warmup.normalized,
      endAt: to.normalized,
      collectedAt: to.normalized,
      source: pair.dataset.provenance.source,
    },
    candles: Object.fromEntries((["1h", "4h", "1d"] as const).map((timeframe) => [
      timeframe,
      pair.dataset.candles[timeframe].filter((candle) => {
        const open = requireTimestamp(candle.openTime, `${timeframe} candle openTime`).epochNanoseconds;
        const close = requireTimestamp(candle.closeTime, `${timeframe} candle closeTime`).epochNanoseconds;
        return open >= warmup.epochNanoseconds && close <= to.epochNanoseconds;
      }),
    ])) as ResearchCandleDataset["candles"],
  };
  const dataset = parseResearchCandleDataset(JSON.stringify({
    ...clipped,
    provenance: {
      ...clipped.provenance,
      sha256: calculateResearchCandleDatasetChecksum(clipped),
    },
  }));
  const cadence = calculateCadence(pair.dataset, pair.noTradeEvidence, warmup, from, to);
  if (cadence.warmupUnexplainedHourlyIntervals > 0) {
    throw new Error(
      `Prospective replay warmup has ${cadence.warmupUnexplainedHourlyIntervals} unexplained hourly interval(s).`,
    );
  }
  return { dataset, cadence };
}

function calculateCadence(
  dataset: ResearchCandleDataset,
  sidecar: ResearchNoTradeEvidence,
  warmup: PerformanceTimestamp,
  from: PerformanceTimestamp,
  to: PerformanceTimestamp,
): ProspectiveShadowReplayCadenceEvidence {
  if (
    warmup.epochNanoseconds % HOUR_NANOSECONDS !== 0n ||
    from.epochNanoseconds % HOUR_NANOSECONDS !== 0n ||
    to.epochNanoseconds % HOUR_NANOSECONDS !== 0n
  ) {
    throw new Error("Prospective replay warmup and window must be hour-aligned for cadence validation.");
  }
  const observed = new Set<bigint>();
  for (const candle of dataset.candles["1h"]) {
    const open = requireTimestamp(candle.openTime, "hourly candle openTime").epochNanoseconds;
    const close = requireTimestamp(candle.closeTime, "hourly candle closeTime").epochNanoseconds;
    if (open < warmup.epochNanoseconds || close > to.epochNanoseconds) continue;
    if (close - open !== HOUR_NANOSECONDS || open % HOUR_NANOSECONDS !== 0n) {
      throw new Error("Prospective replay hourly candles must be aligned one-hour intervals.");
    }
    if (observed.has(open)) throw new Error("Prospective replay has duplicate hourly intervals.");
    observed.add(open);
  }
  const warmupCoverage = countCadenceIntervals(observed, sidecar, warmup.epochNanoseconds, from.epochNanoseconds);
  const windowCoverage = countCadenceIntervals(observed, sidecar, from.epochNanoseconds, to.epochNanoseconds);
  return {
    complete: windowCoverage.unexplained === 0,
    warmupExpectedHourlyIntervals: warmupCoverage.expected,
    warmupObservedHourlyIntervals: warmupCoverage.observed,
    warmupVerifiedNoTradeHourlyIntervals: warmupCoverage.verifiedNoTrade,
    warmupUnexplainedHourlyIntervals: warmupCoverage.unexplained,
    expectedHourlyIntervals: windowCoverage.expected,
    observedHourlyIntervals: windowCoverage.observed,
    verifiedNoTradeHourlyIntervals: windowCoverage.verifiedNoTrade,
    unexplainedHourlyIntervals: windowCoverage.unexplained,
  };
}

function countCadenceIntervals(
  observed: ReadonlySet<bigint>,
  sidecar: ResearchNoTradeEvidence,
  from: bigint,
  to: bigint,
): Readonly<{ expected: number; observed: number; verifiedNoTrade: number; unexplained: number }> {
  let expected = 0;
  let observedCount = 0;
  let verifiedNoTrade = 0;
  let unexplained = 0;
  for (let open = from; open < to; open += HOUR_NANOSECONDS) {
    expected += 1;
    if (observed.has(open)) {
      observedCount += 1;
      continue;
    }
    const close = open + HOUR_NANOSECONDS;
    const covered = sidecar.verifiedNoTradeRanges.some((range) => {
      const rangeFrom = requireTimestamp(range.from, "verified no-trade range from").epochNanoseconds;
      const rangeTo = requireTimestamp(range.to, "verified no-trade range to").epochNanoseconds;
      return rangeFrom <= open && rangeTo >= close;
    });
    if (covered) verifiedNoTrade += 1;
    else unexplained += 1;
  }
  return { expected, observed: observedCount, verifiedNoTrade, unexplained };
}

function normalizeFrames(frames: readonly PositionGuardBacktestFrame[]): readonly PositionGuardBacktestFrame[] {
  const copied = [...structuredClone(frames)];
  copied.sort((left, right) => compareEpochNanoseconds(
    requireTimestamp(left.generatedAt, "frame generatedAt").epochNanoseconds,
    requireTimestamp(right.generatedAt, "frame generatedAt").epochNanoseconds,
  ));
  for (let index = 1; index < copied.length; index += 1) {
    if (compareEpochNanoseconds(
      requireTimestamp(copied[index - 1]!.generatedAt, "previous frame generatedAt").epochNanoseconds,
      requireTimestamp(copied[index]!.generatedAt, "frame generatedAt").epochNanoseconds,
    ) >= 0) throw new Error("Prospective replay feature frames must be strictly ordered.");
  }
  return copied;
}

function requireFrameSource(frame: PositionGuardBacktestFrame): NonNullable<PositionGuardBacktestFrame["source"]> {
  if (!frame.source) throw new Error("Prospective replay feature frames must retain source coverage metadata.");
  return frame.source;
}

function inRange(value: bigint, from: string, to: string): boolean {
  const lower = requireTimestamp(from, "window from").epochNanoseconds;
  const upper = requireTimestamp(to, "window to").epochNanoseconds;
  return value >= lower && value < upper;
}

function assertWindowBounded(result: CounterfactualScenarioResult, registration: ProspectiveShadowRegistration): void {
  const from = requireTimestamp(registration.window.from, "window from").epochNanoseconds;
  const to = requireTimestamp(registration.window.to, "window to").epochNanoseconds;
  for (const frame of result.sourceFrames) {
    const instant = requireTimestamp(frame.generatedAt, "replay frame generatedAt").epochNanoseconds;
    if (instant < from || instant >= to) throw new Error("Prospective replay passed a frame outside [window.from, window.to) to execution.");
  }
  for (const fill of result.fills) {
    const instant = requireTimestamp(fill.filledAt, `fill ${fill.id} filledAt`).epochNanoseconds;
    if (instant < from || instant >= to) throw new Error("Prospective replay produced a fill outside [window.from, window.to).");
  }
}

function runCounterfactual(
  runner: ProspectiveShadowCounterfactualRunner | undefined,
  input: CounterfactualInput,
  expectedScenario: CounterfactualScenarioResult["scenario"],
): CounterfactualScenarioResult {
  const canonical = invokeCounterfactualRunner(runCounterfactualScenarios, input, expectedScenario);
  if (!runner) return canonical;
  const candidate = invokeCounterfactualRunner(runner, input, expectedScenario);
  validateProspectiveShadowReplayCounterfactualEvidence(canonical, candidate);
  return canonical;
}

function invokeCounterfactualRunner(
  runner: ProspectiveShadowCounterfactualRunner,
  input: CounterfactualInput,
  expectedScenario: CounterfactualScenarioResult["scenario"],
): CounterfactualScenarioResult {
  const results = runner(structuredClone(input));
  if (!Array.isArray(results) || results.length !== 1 || !results[0]) {
    throw new Error("Prospective replay counterfactual runner must return exactly one result per registered path.");
  }
  const result = structuredClone(results[0]);
  if (result.evidenceKind !== "SIMULATED_COUNTERFACTUAL" || result.scenario !== expectedScenario) {
    throw new Error("Prospective replay counterfactual runner returned the wrong registered scenario result.");
  }
  const fillIds = new Set<string>();
  for (const fill of result.fills) {
    if (typeof fill.id !== "string" || fill.id.length === 0 || fillIds.has(fill.id)) {
      throw new Error("Prospective replay counterfactual runner returned missing or duplicate fill IDs.");
    }
    fillIds.add(fill.id);
  }
  return result;
}

/** Pure output-boundary normalizer; it does not admit evidence into a replay. */
export function orderProspectiveShadowReplayCounterfactualFills(
  result: CounterfactualScenarioResult,
): CounterfactualScenarioResult {
  return {
    ...structuredClone(result),
    fills: [...result.fills].sort((left, right) => compareEpochNanoseconds(
      requireTimestamp(left.filledAt, `fill ${left.id} filledAt`).epochNanoseconds,
      requireTimestamp(right.filledAt, `fill ${right.id} filledAt`).epochNanoseconds,
    ) || left.id.localeCompare(right.id)),
  };
}

function orderCounterfactualFills(result: CounterfactualScenarioResult): CounterfactualScenarioResult {
  return orderProspectiveShadowReplayCounterfactualFills(result);
}

/**
 * Rejects an adapter result unless it is canonically identical to the default
 * pure runner output. This binds all nested execution and diagnostic evidence.
 */
export function validateProspectiveShadowReplayCounterfactualEvidence(
  canonical: CounterfactualScenarioResult,
  candidate: CounterfactualScenarioResult,
): void {
  if (canonicalStructure(candidate) !== canonicalStructure(canonical)) {
    throw new Error("Prospective replay counterfactual adapter result is not canonically identical to default evidence.");
  }
}

function deriveFeeEvidence(result: CounterfactualScenarioResult): Readonly<{ complete: boolean; unknownReason: string | null }> {
  const complete = result.fills.every((fill) => typeof fill.feeKrw === "number" && Number.isFinite(fill.feeKrw) && fill.feeKrw >= 0);
  return complete
    ? { complete: true, unknownReason: null }
    : { complete: false, unknownReason: "One or more modeled fills have unknown or invalid fee evidence." };
}

function deriveLifecycleEvidence(
  result: CounterfactualScenarioResult,
  registration: ProspectiveShadowRegistration,
): Readonly<{ complete: boolean; unknownReason: string | null }> {
  const from = requireTimestamp(registration.window.from, "window from").epochNanoseconds;
  const invalid = result.matchResult.unmatchedSells.length > 0 || result.matchResult.attributionFailures.length > 0 ||
    result.matchResult.episodes.some((episode) => requireTimestamp(episode.openedAt, "episode openedAt").epochNanoseconds < from);
  return invalid
    ? { complete: false, unknownReason: "Lifecycle evidence has unmatched sells, attribution failures, or carry-in episodes." }
    : { complete: true, unknownReason: null };
}

/** Pure inspection only; callers cannot use its result to replace replay evidence. */
export function inspectProspectiveShadowReplayPathEvidence(input: Readonly<{
  registration: ProspectiveShadowRegistration;
  path: Pick<ProspectiveShadowReplayPath,
    "asset" | "market" | "scenario" | "timing" | "costId" | "cadence" | "featureCoverage" | "relationshipEvidence">;
  counterfactual: CounterfactualScenarioResult;
}>): ProspectiveShadowReplayPathEvidenceInspection {
  const detached = structuredClone(input);
  const feeEvidence = deriveFeeEvidence(detached.counterfactual);
  const lifecycleEvidence = deriveLifecycleEvidence(detached.counterfactual, detached.registration);
  return deepFreeze({
    feeEvidence,
    lifecycleEvidence,
    pathEvidence: buildPathEvidence({
      registration: detached.registration,
      asset: detached.path.asset,
      market: detached.path.market,
      scenario: detached.path.scenario,
      timing: detached.path.timing,
      costId: detached.path.costId,
      cadence: detached.path.cadence,
      featureCoverage: detached.path.featureCoverage,
      feeEvidence,
      lifecycleEvidence,
      relationshipEvidence: detached.path.relationshipEvidence,
      counterfactual: detached.counterfactual,
    }),
  });
}

function buildPathEvidence(input: {
  registration: ProspectiveShadowRegistration;
  asset: "BTC" | "ETH";
  market: "KRW-BTC" | "KRW-ETH";
  scenario: typeof PROSPECTIVE_SHADOW_SCENARIOS[number];
  timing: typeof PROSPECTIVE_SHADOW_TIMINGS[number];
  costId: typeof PROSPECTIVE_SHADOW_COSTS[number]["id"];
  cadence: ProspectiveShadowReplayCadenceEvidence;
  featureCoverage: PositionGuardFeatureCoverage;
  feeEvidence: Readonly<{ complete: boolean; unknownReason: string | null }>;
  lifecycleEvidence: Readonly<{ complete: boolean; unknownReason: string | null }>;
  relationshipEvidence: Readonly<{ complete: boolean; unknownReason: string | null }>;
  counterfactual: CounterfactualScenarioResult;
}): ProspectiveShadowPathEvidence {
  const metrics = input.counterfactual.legacyBacktest.result.metrics;
  const diagnostic = input.counterfactual.diagnostics.markets[input.market];
  const realizedCurve = input.counterfactual.diagnostics.marketRealizedPnlCurves[input.market];
  const finite = [metrics.totalReturnPct, metrics.turnoverKrw, metrics.feesKrw]
    .every((value) => Number.isFinite(value) && !Object.is(value, -0));
  const drawdown = realizedCurve.maxNetDrawdownKrw;
  const drawdownKnown = drawdown.status === "KNOWN" && Number.isFinite(drawdown.value) && drawdown.value >= 0;
  const knownNetEpisodes = input.lifecycleEvidence.complete && input.feeEvidence.complete && finite
    ? diagnostic.completedEpisodeCount
    : 0;
  const gates: ProspectiveShadowCompletenessGate[] = [];
  if (!input.cadence.complete) gates.push("CADENCE", "NO_TRADE_COVERAGE");
  if (input.featureCoverage.status !== "COMPLETE") gates.push("FEATURE_COVERAGE");
  if (!input.lifecycleEvidence.complete) gates.push("LIFECYCLE");
  if (!input.feeEvidence.complete) gates.push("FEE_EVIDENCE");
  if (!finite || !drawdownKnown) gates.push("FINITE_METRICS");
  if (!input.relationshipEvidence.complete) gates.push("EPISODE_RELATIONSHIPS");
  const complete = gates.length === 0;
  return {
    asset: input.asset,
    market: input.market,
    scenario: input.scenario,
    timing: input.timing,
    costId: input.costId,
    completedKnownNetEpisodes: complete ? knownNetEpisodes : 0,
    openEpisodes: diagnostic.openEpisodeCount,
    incompleteGates: gates,
    metrics: {
      netReturn: knownMetric("RATIO", metrics.totalReturnPct, complete, "Net return is incomplete because one or more path evidence gates are incomplete."),
      maximumRealizedDrawdown: knownMetric("RATIO", drawdownKnown ? drawdown.value / INITIAL_STATE.cashKrw : null, complete, "Maximum realized drawdown is incomplete because one or more path evidence gates are incomplete."),
      turnover: knownMetric("KRW", metrics.turnoverKrw, complete, "Turnover is incomplete because one or more path evidence gates are incomplete."),
      modeledFees: knownMetric("KRW", metrics.feesKrw, complete, input.feeEvidence.unknownReason ?? "Modeled fees are incomplete because one or more path evidence gates are incomplete."),
    },
  };
}

function knownMetric<Unit extends "RATIO" | "KRW">(
  unit: Unit,
  value: number | null,
  complete: boolean,
  reason: string,
): ProspectiveShadowMetricEvidence<Unit> {
  if (!complete || value === null || !Number.isFinite(value) || Object.is(value, -0)) {
    return { unit, value: null, complete: false, unknownReason: reason };
  }
  return { unit, value, complete: true, unknownReason: null };
}

function attachRelationships(
  paths: MutableProspectiveShadowReplayPath[],
  datasets: ReadonlyMap<"BTC" | "ETH", ResearchCandleDataset>,
  registration: ProspectiveShadowRegistration,
  relationshipAnalyzer: ProspectiveShadowRelationshipAnalyzer | undefined,
): void {
  for (const path of paths) {
    if (path.scenario === "COMBINED_CONSERVATIVE") continue;
    const reference = paths.find((candidate) => candidate.asset === path.asset && candidate.scenario === "COMBINED_CONSERVATIVE" &&
      candidate.timing === path.timing && candidate.costId === path.costId);
    const dataset = datasets.get(path.asset);
    const cost = registration.matrix.costs.find((candidate) => candidate.id === path.costId);
    if (!reference || !dataset || !cost) throw new Error("Prospective replay cannot bind a registered relationship path.");
    const provenance = createProvenance(path, dataset, registration);
    const relationshipInput: HoldoutEpisodeAttributionInput = {
      reference: reference.counterfactual,
      ablation: path.counterfactual,
      asset: path.asset,
      market: path.market,
      timingModel: path.timing,
      cost: { id: cost.id, role: cost.id, feeRate: cost.feeRate, slippageRate: cost.slippageRate },
      referenceProvenance: provenance,
      ablationProvenance: provenance,
      from: registration.window.from,
      to: registration.window.to,
    };
    const canonical = structuredClone(analyzeHoldoutEpisodeAttribution(structuredClone(relationshipInput)));
    validateRelationshipAnalysis(canonical, path);
    if (relationshipAnalyzer) {
      const candidate = structuredClone(relationshipAnalyzer(structuredClone(relationshipInput)));
      validateProspectiveShadowReplayRelationshipEvidence(canonical, candidate);
    }
    path.relationships = canonical;
    path.relationshipEvidence = { complete: true, unknownReason: null };
  }
}

/**
 * Rejects an adapter result unless it matches default attribution evidence and
 * its non-null entry keys remain exact, unique correspondence keys.
 */
export function validateProspectiveShadowReplayRelationshipEvidence(
  canonical: HoldoutEpisodeAttributionResult,
  candidate: HoldoutEpisodeAttributionResult,
): void {
  validateRelationshipEntryKeys(candidate);
  if (canonicalStructure(candidate) !== canonicalStructure(canonical)) {
    throw new Error("Prospective replay relationship adapter result is not canonically identical to default evidence.");
  }
}

function validateRelationshipAnalysis(
  result: HoldoutEpisodeAttributionResult,
  path: Pick<ProspectiveShadowReplayPath, "asset" | "market" | "scenario" | "timing" | "costId">,
): void {
  if (
    result.analysisKind !== "HOLDOUT_EPISODE_COMPONENT_ABLATION_ATTRIBUTION" ||
    result.referenceScenario !== "COMBINED_CONSERVATIVE" ||
    result.ablationScenario !== path.scenario ||
    result.provenance.asset !== path.asset ||
    result.provenance.market !== path.market ||
    result.provenance.timingModel !== path.timing ||
    result.provenance.costCellId !== path.costId
  ) {
    throw new Error("Prospective replay relationship analyzer returned evidence for the wrong registered path.");
  }
  validateRelationshipEntryKeys(result);
}

function validateRelationshipEntryKeys(result: HoldoutEpisodeAttributionResult): void {
  const exactEntryKeys = new Set<string>();
  for (const relationship of result.relationships) {
    const key = relationship.entryKeyEpochNanoseconds;
    if (key === null) continue;
    const referenceKey = relationship.reference?.firstEnterDecisionEpochNanoseconds ?? null;
    const ablationKey = relationship.ablation?.firstEnterDecisionEpochNanoseconds ?? null;
    const presentKeys = [referenceKey, ablationKey].filter((value): value is string => value !== null);
    const requiresTwoSidedMatch = relationship.relationshipKind === "EXACT_ENTRY_MATCH"
      || relationship.relationshipKind === "EXIT_TIMING_CHANGED"
      || relationship.classifications.includes("EXACT_ENTRY_MATCH")
      || relationship.classifications.includes("EXIT_TIMING_CHANGED");
    if (
      presentKeys.length === 0 || presentKeys.some((presentKey) => presentKey !== key)
      || (requiresTwoSidedMatch && (referenceKey === null || ablationKey === null))
    ) {
      throw new Error("Prospective replay exact entry relationship key mismatch; no cross-path fallback is permitted.");
    }
    if (exactEntryKeys.has(key)) {
      throw new Error("Prospective replay has a duplicate exact first-ENTER epoch-nanosecond relationship key.");
    }
    exactEntryKeys.add(key);
  }
}

function createProvenance(
  path: ProspectiveShadowReplayPath,
  dataset: ResearchCandleDataset,
  registration: ProspectiveShadowRegistration,
): HoldoutEpisodePathProvenance {
  const replayFrameFingerprint = fingerprint(path.counterfactual.sourceFrames);
  return {
    authorityId: registration.authority,
    asset: path.asset,
    market: path.market,
    timingModel: path.timing,
    costCellId: path.costId,
    costRole: path.costId,
    feeRate: registration.matrix.costs.find((cost) => cost.id === path.costId)!.feeRate,
    slippageRate: registration.matrix.costs.find((cost) => cost.id === path.costId)!.slippageRate,
    holdoutFrom: registration.window.from,
    holdoutTo: registration.window.to,
    datasetSha256: dataset.provenance.sha256,
    datasetFingerprint: fingerprint(dataset),
    initialStateFingerprint: fingerprint(INITIAL_STATE),
    developmentFrameFingerprint: fingerprint({ featureWarmupStartAt: registration.policyManifest.featureWarmupStartAt }),
    replayFrameFingerprint,
  };
}

function assertExactMatrix(
  paths: readonly Pick<ProspectiveShadowReplayPath, "asset" | "market" | "scenario" | "timing" | "costId">[],
  registration: ProspectiveShadowRegistration,
): void {
  const expected = registration.matrix.assets.flatMap(({ asset, market }) => registration.matrix.scenarios.flatMap((scenario) =>
    registration.matrix.timings.flatMap((timing) => registration.matrix.costs.map((cost) => ({ asset, market, scenario, timing, costId: cost.id }))),
  ));
  if (paths.length !== expected.length || paths.some((path, index) => JSON.stringify({
    asset: path.asset,
    market: path.market,
    scenario: path.scenario,
    timing: path.timing,
    costId: path.costId,
  }) !== JSON.stringify(expected[index]))) {
    throw new Error("Prospective replay paths do not exactly match the registered 24-path matrix.");
  }
}

function requireTimestamp(value: string, label: string): PerformanceTimestamp {
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) throw new Error(`Prospective replay ${label} must be an explicit-timezone timestamp.`);
  return parsed;
}

function canonicalStructure(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "string": return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new Error("Prospective replay canonical evidence cannot contain non-finite or negative-zero numbers.");
      }
      return JSON.stringify(value);
    case "object": {
      if (ancestors.has(value)) throw new Error("Prospective replay canonical evidence cannot contain cyclic values.");
      ancestors.add(value);
      const serialized = Array.isArray(value)
        ? `[${value.map((item) => canonicalStructure(item, ancestors)).join(",")}]`
        : `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
          `${JSON.stringify(key)}:${canonicalStructure((value as Record<string, unknown>)[key], ancestors)}`).join(",")}}`;
      ancestors.delete(value);
      return serialized;
    }
    default:
      throw new Error("Prospective replay canonical evidence must contain only JSON values.");
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
