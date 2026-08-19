import assert from "node:assert/strict";

import type { PositionGuardStructureAnalysis } from "../src/modules/strategy/position-guard-core.js";
import {
  runPositionGuardBacktest,
  type PositionGuardBacktestFrame,
} from "../src/modules/strategy/position-guard-backtest.js";
import {
  BROAD_LOSS_CAUSE_RESEARCH_MANIFEST,
  runCounterfactualScenarios,
  type CounterfactualInput,
  type CounterfactualScenario,
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

test("counterfactual maps all five scenarios to Task 1 policies in caller order", () => {
  const scenarios = [
    "ADD_CORE_TREND",
    "BASELINE",
    "ADD_RISK_CLEAR",
    "NO_ADD",
    "ADD_HIGH_ALIGNMENT",
  ] as const satisfies readonly CounterfactualScenario[];

  const result = runCounterfactualScenarios(createCounterfactualInput(scenarios));

  assert.deepEqual(
    result.map(({ scenario, executionPolicy }) => [scenario, executionPolicy]),
    [
      ["ADD_CORE_TREND", { id: "ADD_CORE_TREND" }],
      ["BASELINE", null],
      ["ADD_RISK_CLEAR", { id: "ADD_RISK_CLEAR" }],
      ["NO_ADD", { id: "NO_ADD", suppressedActions: ["ADD"] }],
      ["ADD_HIGH_ALIGNMENT", { id: "ADD_HIGH_ALIGNMENT" }],
    ],
  );
});

test("counterfactual maps all six frozen broad-loss scenarios without reordering", () => {
  const scenarios = [
    "HTF_TREND_GATE",
    "STRICT_PULLBACK",
    "EARLY_THESIS_FAILURE",
    "ADD_LIMITED",
    "COOLDOWN_CONTROL",
    "COMBINED_CONSERVATIVE",
  ] as const satisfies readonly CounterfactualScenario[];
  const result = runCounterfactualScenarios({
    ...createCounterfactualInput(scenarios),
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
  });

  assert.deepEqual(result.map(({ scenario }) => scenario), scenarios);
  assert.deepEqual(result.map(({ executionPolicy }) => executionPolicy), scenarios.map((id) => ({ id })));
});

test("counterfactual exports the frozen development, cost-role, threshold, and timing manifest", () => {
  assert.deepEqual(BROAD_LOSS_CAUSE_RESEARCH_MANIFEST.developmentRange, {
    from: "2025-01-01T00:00:00Z",
    to: "2026-04-12T19:00:00Z",
  });
  assert.deepEqual(BROAD_LOSS_CAUSE_RESEARCH_MANIFEST.costCells, {
    BASE: { role: "BASE", feeRate: 0.0005, slippageRate: 0.0003 },
    STRESS: { role: "STRESS", feeRate: 0.001, slippageRate: 0.002 },
  });
  assert.deepEqual(BROAD_LOSS_CAUSE_RESEARCH_MANIFEST.executionTimingModels, [
    "SAME_CLOSE_MODELED",
    "NEXT_FRAME_MODELED",
  ]);
  assert.equal(BROAD_LOSS_CAUSE_RESEARCH_MANIFEST.scenarios.ADD_LIMITED.maxAddsPerEpisode, 1);
  assert.equal(BROAD_LOSS_CAUSE_RESEARCH_MANIFEST.scenarios.COOLDOWN_CONTROL.nonPositiveExitHours, 12);
  assert.equal(Object.isFrozen(BROAD_LOSS_CAUSE_RESEARCH_MANIFEST), true);
  assert.equal(Object.isFrozen(BROAD_LOSS_CAUSE_RESEARCH_MANIFEST.scenarios), true);
});

test("counterfactual defaults to same-close provenance and explicitly records next-frame provenance", () => {
  const sameClose = runCounterfactualScenarios(createCounterfactualInput(["BASELINE"]))[0]!;
  const nextFrame = runCounterfactualScenarios({
    ...createCounterfactualInput(["BASELINE"]),
    executionTimingModel: "NEXT_FRAME_MODELED",
  })[0]!;

  assert.deepEqual(sameClose.executionTimingProvenance, {
    model: "SAME_CLOSE_MODELED",
    observedExecution: false,
    caveat: "Core decisions are modeled at each frame close and filled at that same close.",
  });
  assert.deepEqual(nextFrame.executionTimingProvenance, {
    model: "NEXT_FRAME_MODELED",
    observedExecution: false,
    caveat: "Core decisions are modeled at one frame close and filled at the next completed frame close.",
  });
});

test("NEXT_FRAME synthetic fill keeps the originating ENTER when the execution frame decides EXIT", () => {
  const decisionGeneratedAt = "2026-04-20T01:00:00.000000100Z";
  const executedAt = "2026-04-20T02:00:00.000000200Z";
  const [result] = runCounterfactualScenarios({
    ...createCounterfactualInput(["HTF_TREND_GATE"], [
      createFrame(decisionGeneratedAt, {
        regime: "EARLY_RECOVERY",
        currentPrice: 100_000,
        entryPath: "RECLAIM",
        reclaimStructure: true,
        trendAlignmentScore: 4,
        recoveryQualityScore: 4,
        volumeRecovery: true,
        macdImproving: true,
        rsiRecovery: true,
      }),
      createFrame(executedAt, {
        currentPrice: 110_000,
        invalidationState: "BROKEN",
        breakdown1d: true,
        breakdown4h: true,
        bearishMomentumExpansion: true,
      }),
    ], {
      initialCashKrw: 100_000,
      initialQuantity: 0,
      initialAverageEntryPrice: 0,
    }),
    executionTimingModel: "NEXT_FRAME_MODELED",
  });
  const fill = result?.fills[0];

  assert.equal(result?.legacyBacktest.result.frames[0]?.decision.action, "ENTER");
  assert.equal(result?.legacyBacktest.result.frames[1]?.decision.action, "EXIT");
  assert.equal(result?.legacyBacktest.result.frames[1]?.trade?.action, "ENTER");
  assert.equal(fill?.decisionAction, "ENTER");
  assert.equal(fill?.filledAt, executedAt);
  assert.equal(
    fill?.strategyDecisionId,
    `counterfactual:HTF_TREND_GATE:BTC:${decisionGeneratedAt}:0:ENTER:decision`,
  );
  assert.match(fill?.id ?? "", /HTF_TREND_GATE.*ENTER.*ALLOW.*CONDITIONS_MET/);
  assert.deepEqual(result?.modeledFillAttributions, [{
    fillId: fill?.id,
    scenario: "HTF_TREND_GATE",
    decisionGeneratedAt,
    decisionFrameIndex: 0,
    executedAt,
    executionFrameIndex: 1,
    originalAction: "ENTER",
    effectiveAction: "ENTER",
    intervention: {
      outcome: "ALLOW",
      reason: "CONDITIONS_MET",
    },
  }]);
});

test("SAME_CLOSE synthetic fill preserves the policy intervention attribution", () => {
  const generatedAt = "2026-04-20T01:00:00.000000100Z";
  const [result] = runCounterfactualScenarios({
    ...createCounterfactualInput(["HTF_TREND_GATE"], [
      createFrame(generatedAt, {
        regime: "EARLY_RECOVERY",
        currentPrice: 100_000,
        entryPath: "RECLAIM",
        reclaimStructure: true,
        trendAlignmentScore: 4,
        recoveryQualityScore: 4,
        volumeRecovery: true,
        macdImproving: true,
        rsiRecovery: true,
      }),
    ], {
      initialCashKrw: 100_000,
      initialQuantity: 0,
      initialAverageEntryPrice: 0,
    }),
    executionTimingModel: "SAME_CLOSE_MODELED",
  });
  const fill = result?.fills[0];

  assert.equal(fill?.decisionAction, "ENTER");
  assert.equal(fill?.filledAt, generatedAt);
  assert.deepEqual(result?.modeledFillAttributions, [{
    fillId: fill?.id,
    scenario: "HTF_TREND_GATE",
    decisionGeneratedAt: generatedAt,
    decisionFrameIndex: 0,
    executedAt: generatedAt,
    executionFrameIndex: 0,
    originalAction: "ENTER",
    effectiveAction: "ENTER",
    intervention: {
      outcome: "ALLOW",
      reason: "CONDITIONS_MET",
    },
  }]);
});

test("synthetic fills record an overridden effective action without losing the original action", () => {
  const decisionGeneratedAt = "2026-04-20T01:00:00.000000100Z";
  const executedAt = "2026-04-20T02:00:00.000000200Z";
  const [result] = runCounterfactualScenarios({
    ...createCounterfactualInput(["EARLY_THESIS_FAILURE"], [
      createFrame(decisionGeneratedAt, {
        regime: "BULL_TREND",
        currentPrice: 90_000,
        entryPath: "RECLAIM",
        reclaimStructure: true,
        trendAlignmentScore: 4,
        failedReclaim: true,
        weakeningStage: "CLEAR",
        recoveryQualityScore: 1,
      }),
      createFrame(executedAt, { currentPrice: 89_000 }),
    ]),
    executionTimingModel: "NEXT_FRAME_MODELED",
  });
  const fill = result?.fills[0];
  const attribution = result?.modeledFillAttributions?.[0];

  assert.equal(attribution?.originalAction, "HOLD");
  assert.equal(attribution?.effectiveAction, "EXIT");
  assert.equal(fill?.side, "ask");
  assert.equal(fill?.decisionAction, "EXIT");
});

test("counterfactual rejects carry-in stateful scenarios without explicit policy state", () => {
  for (const scenario of ["ADD_LIMITED", "COOLDOWN_CONTROL", "COMBINED_CONSERVATIVE"] as const) {
    assert.throws(
      () => runCounterfactualScenarios(createCounterfactualInput([scenario])),
      new RegExp(`${scenario}.*carry-in research state`),
    );
  }
});

test("counterfactual conditional scenarios produce stable scenario-qualified fill ids", () => {
  const scenarios = [
    "ADD_RISK_CLEAR",
    "ADD_HIGH_ALIGNMENT",
    "ADD_CORE_TREND",
  ] as const satisfies readonly CounterfactualScenario[];

  const first = runCounterfactualScenarios(createCounterfactualInput(scenarios));
  const second = runCounterfactualScenarios(createCounterfactualInput(scenarios));

  assert.deepEqual(second, first);
  assert.deepEqual(
    first.map((result) => result.fills[0]?.id),
    [
      "counterfactual:ADD_RISK_CLEAR:BTC:2026-04-20T01:00:00.000Z:0:ADD:bid:fill",
      "counterfactual:ADD_HIGH_ALIGNMENT:BTC:2026-04-20T01:00:00.000Z:0:ADD:bid:fill",
      "counterfactual:ADD_CORE_TREND:BTC:2026-04-20T01:00:00.000Z:0:ADD:bid:fill",
    ],
  );
});

test("counterfactual rejects duplicate conditional and unknown scenario ids", () => {
  const duplicate = [
    "ADD_RISK_CLEAR",
    "ADD_RISK_CLEAR",
  ] as const satisfies readonly CounterfactualScenario[];
  const unknown = ["ADD_FUTURE_KNOWLEDGE"] as unknown as readonly CounterfactualScenario[];

  assert.throws(
    () => runCounterfactualScenarios(createCounterfactualInput(duplicate)),
    /Duplicate counterfactual scenario ADD_RISK_CLEAR/,
  );
  assert.throws(
    () => runCounterfactualScenarios(createCounterfactualInput(unknown)),
    /Invalid counterfactual scenario ADD_FUTURE_KNOWLEDGE/,
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
