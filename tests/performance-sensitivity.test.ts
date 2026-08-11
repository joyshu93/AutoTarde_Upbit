import assert from "node:assert/strict";

import {
  runCostSensitivity,
  type CostSensitivityInput,
} from "../src/modules/performance/performance-sensitivity.js";
import type { PositionGuardStructureAnalysis } from "../src/modules/strategy/position-guard-core.js";
import type { PositionGuardBacktestFrame } from "../src/modules/strategy/position-guard-backtest.js";
import { test } from "./harness.js";

test("cost sensitivity preserves strategy and cell order deterministically", () => {
  const input = createInput();
  const first = runCostSensitivity(input);
  const second = runCostSensitivity(input);

  assert.deepEqual(
    first.cells.map((cell) => `${cell.scenario}:${cell.costScenario.id}`),
    ["NO_ADD:HIGH", "NO_ADD:ZERO", "BASELINE:HIGH", "BASELINE:ZERO"],
  );
  assert.deepEqual(second, first);
  assert.deepEqual(first.scenarios, input.scenarios);
  assert.deepEqual(first.costScenarios, input.costScenarios);
});

test("cost sensitivity rejects empty duplicate and invalid cells", () => {
  assert.throws(
    () => runCostSensitivity({ ...createInput(), costScenarios: [] }),
    /at least one cost scenario/,
  );
  assert.throws(
    () => runCostSensitivity({
      ...createInput(),
      costScenarios: [{ id: " ", feeRate: 0, slippageRate: 0 }],
    }),
    /id must be non-empty/,
  );
  assert.throws(
    () => runCostSensitivity({
      ...createInput(),
      costScenarios: [
        { id: "SAME", feeRate: 0, slippageRate: 0 },
        { id: "SAME", feeRate: 0.01, slippageRate: 0 },
      ],
    }),
    /Duplicate cost scenario id SAME/,
  );
  assert.throws(
    () => runCostSensitivity({
      ...createInput(),
      costScenarios: [
        { id: "FIRST", feeRate: 0.01, slippageRate: 0.02 },
        { id: "SECOND", feeRate: 0.01, slippageRate: 0.02 },
      ],
    }),
    /Duplicate cost rates/,
  );

  for (const [field, value] of [
    ["feeRate", -0.01],
    ["feeRate", Number.NaN],
    ["feeRate", Number.POSITIVE_INFINITY],
    ["slippageRate", -0.01],
    ["slippageRate", Number.NaN],
    ["slippageRate", Number.POSITIVE_INFINITY],
  ] as const) {
    assert.throws(
      () => runCostSensitivity({
        ...createInput(),
        costScenarios: [{
          id: "INVALID",
          feeRate: field === "feeRate" ? value : 0,
          slippageRate: field === "slippageRate" ? value : 0,
        }],
      }),
      new RegExp(`${field} must be a finite non-negative number`),
    );
  }
});

test("cost sensitivity reuses immutable frames and independently replays every cell", () => {
  const input = createInput();
  const framesBefore = structuredClone(input.frames);
  const result = runCostSensitivity(input);

  assert.equal(result.sourceFrames, input.frames);
  assert.ok(result.cells.every((cell) => cell.sourceFrames === input.frames));
  assert.deepEqual(input.frames, framesBefore);
  assert.ok(result.cells.every(
    (cell) => cell.counterfactual.legacyBacktest.result.frames[0]?.startingState.cashKrw === input.initialCashKrw,
  ));
  assert.notEqual(
    result.cells[0]?.counterfactual.legacyBacktest.result.finalState,
    result.cells[1]?.counterfactual.legacyBacktest.result.finalState,
  );
});

test("cost sensitivity applies costs during replay so later trade quantity changes", () => {
  const result = runCostSensitivity(createInput(["BASELINE"]));
  const high = result.cells[0]!;
  const zero = result.cells[1]!;
  const highTrades = high.counterfactual.fills;
  const zeroTrades = zero.counterfactual.fills;

  assert.equal(highTrades.length, 2);
  assert.equal(zeroTrades.length, 2);
  assert.equal(highTrades[0]?.volume, zeroTrades[0]?.volume);
  assert.ok((highTrades[1]?.volume ?? 0) < (zeroTrades[1]?.volume ?? 0));
  assert.ok(
    high.counterfactual.legacyBacktest.result.frames[1]!.startingState.cashKrw <
      zero.counterfactual.legacyBacktest.result.frames[1]!.startingState.cashKrw,
  );
  assert.notDeepEqual(
    high.counterfactual.legacyBacktest.result.finalState,
    zero.counterfactual.legacyBacktest.result.finalState,
  );
  assert.equal(high.modeledFeesKrw.status, "KNOWN");
  assert.ok(high.modeledFeesKrw.status === "KNOWN" && high.modeledFeesKrw.value > 0);
  assert.deepEqual(zero.modeledFeesKrw, { status: "KNOWN", value: 0 });
});

test("cost sensitivity forwards slippage to adverse buy and sell execution prices", () => {
  const input: CostSensitivityInput = {
    ...createInput(["BASELINE"]),
    initialCashKrw: 600_000,
    initialQuantity: 0,
    initialAverageEntryPrice: 0,
    frames: [
      strongAddFrame("2026-04-20T01:00:00.000Z"),
      createFrame("2026-04-20T02:00:00.000Z", {
        currentPrice: 120_000,
        invalidationState: "BROKEN",
        breakdown1d: true,
        breakdown4h: true,
        bearishMomentumExpansion: true,
      }),
    ],
    costScenarios: [
      { id: "SLIPPAGE_ONLY", feeRate: 0, slippageRate: 0.1 },
      { id: "ZERO", feeRate: 0, slippageRate: 0 },
    ],
  };

  const [slippage, zero] = runCostSensitivity(input).cells;
  assert.deepEqual(
    slippage?.counterfactual.fills.map((fill) => [fill.decisionAction, fill.priceKrw]),
    [["ENTER", 110_000], ["EXIT", 108_000]],
  );
  assert.deepEqual(
    zero?.counterfactual.fills.map((fill) => [fill.decisionAction, fill.priceKrw]),
    [["ENTER", 100_000], ["EXIT", 120_000]],
  );
  assert.notDeepEqual(slippage?.counterfactual.fills, zero?.counterfactual.fills);
  assert.notDeepEqual(
    slippage?.counterfactual.legacyBacktest.result.finalState,
    zero?.counterfactual.legacyBacktest.result.finalState,
  );
});

test("cost sensitivity forwards minimum trade value and records a below-threshold skip", () => {
  const [cell] = runCostSensitivity({
    ...createInput(["BASELINE"]),
    frames: [strongAddFrame("2026-04-20T01:00:00.000Z")],
    minimumTradeValueKrw: 200_000,
    costScenarios: [{ id: "ZERO", feeRate: 0, slippageRate: 0 }],
  }).cells;
  const [frame] = cell?.counterfactual.legacyBacktest.result.frames ?? [];

  assert.equal(frame?.decision.action, "ADD");
  assert.equal(frame?.executed, false);
  assert.equal(frame?.skipReason, "BELOW_MINIMUM_TRADE_VALUE");
  assert.equal(cell?.counterfactual.fills.length, 0);
});

test("cost sensitivity rejects invalid minimum trade values", () => {
  for (const minimumTradeValueKrw of [
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(
      () => runCostSensitivity({ ...createInput(), minimumTradeValueKrw }),
      /minimumTradeValueKrw must be a finite non-negative number/,
    );
  }
});

test("cost sensitivity rejects slippage that can create nonpositive sell prices", () => {
  for (const slippageRate of [1, 1.01]) {
    assert.throws(
      () => runCostSensitivity({
        ...createInput(["BASELINE"]),
        costScenarios: [{ id: "INVALID", feeRate: 0, slippageRate }],
      }),
      /slippageRate must be less than 1/,
    );
  }
});

test("cost sensitivity counts opening-inventory exits in all-fill turnover and fees", () => {
  const [cell] = runCostSensitivity({
    ...createInput(["BASELINE"]),
    initialCashKrw: 0,
    initialQuantity: 1,
    initialAverageEntryPrice: 100_000,
    frames: [
      createFrame("2026-04-20T01:00:00.000Z", {
        currentPrice: 120_000,
        invalidationState: "BROKEN",
        breakdown1d: true,
        breakdown4h: true,
        bearishMomentumExpansion: true,
      }),
    ],
    costScenarios: [{ id: "MODELED_FEE", feeRate: 0.01, slippageRate: 0 }],
  }).cells;

  assert.deepEqual(
    cell?.counterfactual.fills.map((fill) => [fill.decisionAction, fill.priceKrw, fill.feeKrw]),
    [["EXIT", 120_000, 1_200]],
  );
  assert.equal(cell?.costMetricScope, "ALL_SIMULATED_FILLS");
  assert.deepEqual(cell?.turnoverKrw, { status: "KNOWN", value: 120_000 });
  assert.deepEqual(cell?.modeledFeesKrw, { status: "KNOWN", value: 1_200 });
  assert.equal(cell?.fifoOutcomeMetricScope, "SELECTED_STREAM_FIFO");
  assert.equal(cell?.completedEpisodeCount, 0);
  assert.deepEqual(cell?.episodeWinRate, {
    status: "NOT_APPLICABLE",
    reason: "NO_COMPLETED_EPISODES",
  });
  assert.deepEqual(cell?.profitFactor, {
    status: "NOT_APPLICABLE",
    reason: "ZERO_GROSS_LOSS",
  });
});

test("cost sensitivity labels modeled evidence and preserves diagnostic metric states", () => {
  const [cell] = runCostSensitivity(createInput(["BASELINE"])).cells;

  assert.equal(cell?.evidenceKind, "MODELED_COST_SCENARIO");
  assert.equal(cell?.scenario, "BASELINE");
  assert.deepEqual(cell?.costScenario, { id: "HIGH", feeRate: 0.1, slippageRate: 0 });
  assert.ok(Number.isFinite(cell?.finalEquityKrw));
  assert.ok(Number.isFinite(cell?.totalReturnPct));
  assert.ok(Number.isFinite(cell?.maxDrawdownPct));
  assert.equal(cell?.completedEpisodeCount, 0);
  assert.deepEqual(cell?.episodeWinRate, {
    status: "NOT_APPLICABLE",
    reason: "NO_COMPLETED_EPISODES",
  });
  assert.deepEqual(cell?.profitFactor, {
    status: "NOT_APPLICABLE",
    reason: "ZERO_GROSS_LOSS",
  });
  assert.equal(cell?.turnoverKrw.status, "KNOWN");
  assert.equal(cell?.counterfactual.evidenceKind, "SIMULATED_COUNTERFACTUAL");
});

function createInput(
  scenarios: CostSensitivityInput["scenarios"] = ["NO_ADD", "BASELINE"],
): CostSensitivityInput {
  return {
    asset: "BTC",
    market: "KRW-BTC",
    initialCashKrw: 600_000,
    initialQuantity: 4,
    initialAverageEntryPrice: 100_000,
    frames: [
      strongAddFrame("2026-04-20T01:00:00.000Z"),
      strongAddFrame("2026-04-20T02:00:00.000Z"),
      strongAddFrame("2026-04-20T03:00:00.000Z"),
    ],
    scenarios,
    diagnosticPolicy: { breakevenToleranceKrw: 0 },
    minimumTradeValueKrw: 5_000,
    costScenarios: [
      { id: "HIGH", feeRate: 0.1, slippageRate: 0 },
      { id: "ZERO", feeRate: 0, slippageRate: 0 },
    ],
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
