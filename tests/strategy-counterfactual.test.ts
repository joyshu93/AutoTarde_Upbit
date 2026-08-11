import assert from "node:assert/strict";

import type { PositionGuardStructureAnalysis } from "../src/modules/strategy/position-guard-core.js";
import {
  runPositionGuardBacktest,
  type PositionGuardBacktestFrame,
} from "../src/modules/strategy/position-guard-backtest.js";
import {
  runCounterfactualScenarios,
  type CounterfactualInput,
} from "../src/modules/performance/strategy-counterfactual.js";
import { test } from "./harness.js";

test("counterfactual BASELINE has parity with the existing no-policy engine", () => {
  const input = createCounterfactualInput(["BASELINE"]);
  const expected = runPositionGuardBacktest(input);
  const [baseline] = runCounterfactualScenarios(input);

  assert.deepEqual(baseline?.legacyBacktest.result, expected);
  assert.equal(baseline?.legacyBacktest.label, "LEGACY_AVERAGE_COST_BACKTEST");
  assert.equal(baseline?.evidenceKind, "SIMULATED_COUNTERFACTUAL");
  assert.equal(baseline?.scenario, "BASELINE");
  assert.equal(baseline?.executionPolicy, null);
});

test("counterfactual scenarios reuse immutable frames and clone initial state", () => {
  const input = createCounterfactualInput(["BASELINE", "NO_ADD"]);
  const before = structuredClone(input.frames);
  const result = runCounterfactualScenarios(input);

  assert.equal(result[0]?.sourceFrames, input.frames);
  assert.equal(result[1]?.sourceFrames, input.frames);
  assert.deepEqual(input.frames, before);
  assert.notEqual(result[0]?.legacyBacktest.result.finalState, result[1]?.legacyBacktest.result.finalState);
  assert.equal(result[0]?.legacyBacktest.result.frames[0]?.startingState.cashKrw, input.initialCashKrw);
  assert.equal(result[1]?.legacyBacktest.result.frames[0]?.startingState.cashKrw, input.initialCashKrw);
});

test("counterfactual scenario order is stable and empty or duplicate scenarios reject", () => {
  assert.deepEqual(
    runCounterfactualScenarios(createCounterfactualInput(["NO_ADD", "BASELINE"]))
      .map((result) => result.scenario),
    ["NO_ADD", "BASELINE"],
  );
  assert.throws(
    () => runCounterfactualScenarios(createCounterfactualInput([])),
    /at least one scenario/,
  );
  assert.throws(
    () => runCounterfactualScenarios(createCounterfactualInput(["BASELINE", "BASELINE"])),
    /Duplicate counterfactual scenario BASELINE/,
  );
});

test("counterfactual rejects reordered frames and non-finite initial state", () => {
  const input = createCounterfactualInput(["BASELINE"]);
  assert.throws(
    () => runCounterfactualScenarios({ ...input, frames: [...input.frames].reverse() }),
    /frames must be strictly ordered/,
  );
  assert.throws(
    () => runCounterfactualScenarios({ ...input, initialCashKrw: Number.NaN }),
    /initialCashKrw must be finite/,
  );
});

test("counterfactual synthetic fills and complete results are deterministic", () => {
  const input = createCounterfactualInput(["BASELINE", "NO_ADD"]);
  const first = runCounterfactualScenarios(input);
  const second = runCounterfactualScenarios(input);

  assert.deepEqual(second, first);
  const fill = first[0]?.fills[0];
  assert.match(fill?.id ?? "", /BASELINE:BTC:2026-04-20T01:00:00.000Z:0:ADD:bid/);
  assert.equal(fill?.filledAt, "2026-04-20T01:00:00.000Z");
  assert.equal(fill?.feeKrw, first[0]?.legacyBacktest.result.frames[0]?.trade?.feeKrw);
});

test("counterfactual preserves offset nanosecond timestamps in epoch order and deterministic ids", () => {
  const offsetTimestamp = "2026-04-20T10:00:00.000000100+09:00";
  const utcTimestamp = "2026-04-20T01:00:00.000000200Z";
  assert.ok(offsetTimestamp.localeCompare(utcTimestamp) > 0);
  const input = createCounterfactualInput(
    ["BASELINE", "NO_ADD"],
    [strongAddFrame(offsetTimestamp), strongAddFrame(utcTimestamp)],
  );

  const first = runCounterfactualScenarios(input);
  const second = runCounterfactualScenarios(input);
  const baseline = first[0];

  assert.deepEqual(first.map((result) => result.scenario), ["BASELINE", "NO_ADD"]);
  assert.deepEqual(second, first);
  assert.deepEqual(
    baseline?.fills.map((fill) => fill.filledAt),
    [offsetTimestamp, utcTimestamp],
  );
  assert.deepEqual(
    baseline?.fills.map((fill) => fill.id),
    [
      `counterfactual:BASELINE:BTC:${offsetTimestamp}:0:ADD:bid:fill`,
      `counterfactual:BASELINE:BTC:${utcTimestamp}:1:ADD:bid:fill`,
    ],
  );
});

test("counterfactual partial REDUCE then EXIT produces FIFO slices and one completed episode", () => {
  const input = createCounterfactualInput(["BASELINE"], [
    strongAddFrame("2026-04-20T01:00:00.000Z"),
    createFrame("2026-04-20T02:00:00.000Z", {
      regime: "WEAK_DOWNTREND",
      currentPrice: 120_000,
      weakeningStage: "CLEAR",
      failedReclaim: true,
      bearishMomentumExpansion: true,
    }),
    createFrame("2026-04-20T03:00:00.000Z", {
      currentPrice: 110_000,
      invalidationState: "BROKEN",
      breakdown1d: true,
      breakdown4h: true,
      bearishMomentumExpansion: true,
    }),
  ], {
    initialCashKrw: 991_000,
    initialQuantity: 0.1,
    initialAverageEntryPrice: 90_000,
  });
  const [result] = runCounterfactualScenarios(input);

  assert.deepEqual(
    result?.fills.map((fill) => fill.decisionAction),
    ["ADD", "REDUCE", "EXIT"],
  );
  assert.equal(result?.matchResult.realizationSlices.length, 3);
  const addVolume = result?.fills[0]?.volume ?? 0;
  const reduceVolume = result?.fills[1]?.volume ?? 0;
  assert.deepEqual(
    result?.matchResult.realizationSlices.map((slice) => Number(slice.quantity.toFixed(3))),
    [
      0.1,
      Number((reduceVolume - 0.1).toFixed(3)),
      Number((addVolume - (reduceVolume - 0.1)).toFixed(3)),
    ],
  );
  assert.equal(result?.matchResult.episodes.filter((episode) => episode.status === "COMPLETED").length, 1);
  assert.equal(result?.matchResult.episodes[0]?.remainingQuantity, 0);
  assert.equal(result?.diagnostics.combined.completedEpisodeCount, 1);
  assert.equal(result?.diagnostics.combined.selectedSliceCount, 2);
});

test("counterfactual diagnostics use completed episodes and retain explicit metric states", () => {
  const [result] = runCounterfactualScenarios(createCounterfactualInput(["BASELINE"]));

  assert.equal(result?.diagnostics.combined.completedEpisodeCount, 0);
  assert.equal(result?.diagnostics.combined.episodeWinRate.status, "NOT_APPLICABLE");
  assert.equal(result?.diagnostics.markPnlCurve.gross.status, "NOT_APPLICABLE");
  assert.equal(result?.diagnostics.matchResult, result?.matchResult);
});

function createCounterfactualInput(
  scenarios: CounterfactualInput["scenarios"],
  frames = [
    strongAddFrame("2026-04-20T01:00:00.000Z"),
    strongAddFrame("2026-04-20T02:00:00.000Z"),
    strongAddFrame("2026-04-20T03:00:00.000Z"),
  ],
  initial: Partial<Pick<CounterfactualInput, "initialCashKrw" | "initialQuantity" | "initialAverageEntryPrice">> = {},
): CounterfactualInput {
  return {
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 600_000,
    initialQuantity: 4,
    initialAverageEntryPrice: 100_000,
    frames,
    scenarios,
    diagnosticPolicy: { breakevenToleranceKrw: 0 },
    ...initial,
  };
}

function strongAddFrame(generatedAt: string): PositionGuardBacktestFrame {
  return createFrame(generatedAt, {
    regime: "BULL_TREND",
    currentPrice: 100_000,
    entryPath: "RECLAIM",
    reclaimStructure: true,
    trendAlignmentScore: 4,
    recoveryQualityScore: 4,
    volumeRecovery: true,
    macdImproving: true,
    rsiRecovery: true,
  });
}

function createFrame(
  generatedAt: string,
  analysisOverrides: Partial<PositionGuardStructureAnalysis>,
): PositionGuardBacktestFrame {
  return {
    generatedAt,
    analysis: {
      regime: "RANGE",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: 95_000,
      pullbackZone: false,
      reclaimStructure: false,
      breakoutHoldStructure: false,
      upperRangeChase: false,
      currentPrice: 100_000,
      entryPath: "NONE",
      trendAlignmentScore: 0,
      recoveryQualityScore: 0,
      breakdownPressureScore: 0,
      weakeningStage: "NONE",
      breakdown1d: false,
      breakdown4h: false,
      failedReclaim: false,
      bearishMomentumExpansion: false,
      volumeRecovery: false,
      macdImproving: false,
      rsiRecovery: false,
      atrShock: false,
      averageEntryPrice: 0,
      pnlPct: 0,
      oneHourLocation: "MIDDLE",
      fourHourLocation: "MIDDLE",
      ...analysisOverrides,
    },
  };
}
