import assert from "node:assert/strict";

import {
  diagnoseCombinedConservativeHoldoutFailures,
  type HoldoutFailureDiagnosticAssetInput,
} from "../src/modules/performance/performance-holdout-failure-diagnostics.js";
import type {
  CombinedConservativeHoldoutComparison,
  CombinedConservativeMetric,
} from "../src/modules/performance/performance-combined-conservative-holdout.js";
import { test } from "./harness.js";

test("holdout failure diagnostics preserve BTC and ETH and prohibit causal claims", () => {
  const result = diagnoseCombinedConservativeHoldoutFailures([
    assetInput("ETH", comparisonMatrix(() => "PASS")),
    assetInput("BTC", comparisonMatrix(() => "PASS")),
  ]);

  assert.equal(result.analysisKind, "COMBINED_CONSERVATIVE_AGGREGATE_FAILURE_DIAGNOSTICS");
  assert.equal(result.readOnly, true);
  assert.equal(result.causalClaim, false);
  assert.equal(result.deploymentApproval, false);
  assert.deepEqual(result.assets.map((asset) => asset.asset), ["BTC", "ETH"]);
  assert.ok(result.assets.every((asset) => asset.failedComparisonCount === 0));
});

test("holdout failure diagnostics identify return shortfall without higher turnover or fees", () => {
  const comparisons = comparisonMatrix(({ timing, cost, anchor, metric }) => {
    const returnFails = metric === "NET_RETURN_PCT"
      && (anchor === "NO_ADD" || cost === "BASE");
    return returnFails ? "FAIL" : "PASS";
  });

  const eth = diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", comparisonMatrix(() => "PASS")),
    assetInput("ETH", comparisons, "REJECTED"),
  ]).assets[1]!;

  assert.equal(eth.failedComparisonCount, 6);
  assert.deepEqual(eth.failedByMetric, {
    NET_RETURN_PCT: 6,
    MAX_DRAWDOWN_PCT: 0,
    TURNOVER_KRW: 0,
    FEES_KRW: 0,
  });
  assert.deepEqual(eth.returnFailureTimingModels, ["SAME_CLOSE_MODELED", "NEXT_FRAME_MODELED"]);
  assert.deepEqual(eth.returnFailureCostCells, ["BASE", "STRESS"]);
  assert.deepEqual(eth.returnFailureAnchors, ["BASELINE", "NO_ADD"]);
  assert.equal(eth.returnFailureAgainstNoAddAcrossAllCells, true);
  assert.equal(eth.returnFailureAcrossAllCells, false);
  assert.equal(
    eth.cells.filter((cell) => cell.signals.includes("RETURN_SHORTFALL_WITHOUT_HIGHER_TURNOVER_OR_MODELED_FEES")).length,
    6,
  );
});

test("holdout failure diagnostics keep unknown evidence out of directional associations", () => {
  const comparisons = comparisonMatrix(({ metric }) =>
    metric === "NET_RETURN_PCT" ? "UNKNOWN" : "PASS");

  const btc = diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", comparisons, "INSUFFICIENT"),
    assetInput("ETH", comparisonMatrix(() => "PASS")),
  ]).assets[0]!;

  assert.equal(btc.failedComparisonCount, 0);
  assert.equal(btc.unknownComparisonCount, 8);
  assert.ok(btc.cells.every((cell) => !cell.signals.includes("RETURN_UNDERPERFORMANCE")));
});

test("holdout failure diagnostics distinguish aggregate cost-drag association without claiming cause", () => {
  const comparisons = comparisonMatrix(({ timing, cost, anchor, metric }) => {
    if (timing !== "SAME_CLOSE_MODELED" || cost !== "BASE" || anchor !== "BASELINE") return "PASS";
    return metric === "NET_RETURN_PCT" || metric === "TURNOVER_KRW" || metric === "FEES_KRW"
      ? "FAIL"
      : "PASS";
  });

  const cell = diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", comparisons, "REJECTED"),
    assetInput("ETH", comparisonMatrix(() => "PASS")),
  ]).assets[0]!.cells[0]!;

  assert.deepEqual(cell.signals, [
    "RETURN_UNDERPERFORMANCE",
    "HIGHER_TURNOVER",
    "HIGHER_MODELED_FEES",
    "RETURN_SHORTFALL_WITH_COST_DRAG_ASSOCIATION",
  ]);
});

test("holdout failure diagnostics do not infer absent cost evidence from unknown turnover and fees", () => {
  const comparisons = comparisonMatrix(({ timing, cost, anchor, metric }) => {
    if (timing !== "SAME_CLOSE_MODELED" || cost !== "BASE" || anchor !== "BASELINE") return "PASS";
    if (metric === "NET_RETURN_PCT") return "FAIL";
    if (metric === "TURNOVER_KRW" || metric === "FEES_KRW") return "UNKNOWN";
    return "PASS";
  });

  const cell = diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", comparisons, "REJECTED"),
    assetInput("ETH", comparisonMatrix(() => "PASS")),
  ]).assets[0]!.cells[0]!;

  assert.deepEqual(cell.signals, ["RETURN_UNDERPERFORMANCE"]);
  assert.equal(cell.signals.includes("RETURN_SHORTFALL_WITHOUT_HIGHER_TURNOVER_OR_MODELED_FEES"), false);
  assert.equal(cell.signals.includes("RETURN_SHORTFALL_WITH_COST_DRAG_ASSOCIATION"), false);
});

test("holdout failure diagnostics canonicalize shuffled comparisons by timing cost anchor and metric", () => {
  const shuffled = shuffleComparisons(comparisonMatrix(({ metric }) =>
    metric === "NET_RETURN_PCT" ? "FAIL" : "PASS"));

  const btc = diagnoseCombinedConservativeHoldoutFailures([
    assetInput("ETH", shuffleComparisons(comparisonMatrix(() => "PASS"))),
    assetInput("BTC", shuffled, "REJECTED"),
  ]).assets[0]!;

  assert.deepEqual(btc.cells.map((cell) => `${cell.timing}:${cell.cost}:${cell.anchor}`), [
    "SAME_CLOSE_MODELED:BASE:BASELINE",
    "SAME_CLOSE_MODELED:BASE:NO_ADD",
    "SAME_CLOSE_MODELED:STRESS:BASELINE",
    "SAME_CLOSE_MODELED:STRESS:NO_ADD",
    "NEXT_FRAME_MODELED:BASE:BASELINE",
    "NEXT_FRAME_MODELED:BASE:NO_ADD",
    "NEXT_FRAME_MODELED:STRESS:BASELINE",
    "NEXT_FRAME_MODELED:STRESS:NO_ADD",
  ]);
  for (const cell of btc.cells) {
    assert.deepEqual(
      cell.comparisons.map((comparison) => comparison.metric),
      ["NET_RETURN_PCT", "MAX_DRAWDOWN_PCT", "TURNOVER_KRW", "FEES_KRW"],
    );
  }
});

test("holdout failure diagnostics reject comparison delta mismatches", () => {
  const inconsistent = comparisonMatrix(() => "PASS");
  inconsistent[0] = { ...inconsistent[0]!, delta: inconsistent[0]!.delta + 0.5 };

  assert.throws(() => diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", inconsistent),
    assetInput("ETH", comparisonMatrix(() => "PASS")),
  ]), /delta.*candidate.*anchor|candidate.*anchor.*delta/i);
});

test("holdout failure diagnostics reject outcomes that contradict delta and tolerance", () => {
  const contradictory = comparisonMatrix(() => "PASS");
  contradictory[0] = comparison(
    "SAME_CLOSE_MODELED",
    "BASE",
    "BASELINE",
    "NET_RETURN_PCT",
    "FAIL",
  );
  contradictory[0] = {
    ...contradictory[0],
    candidateValue: 0.11,
    anchorValue: 0.1,
    delta: 1,
  };

  assert.throws(() => diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", contradictory, "REJECTED"),
    assetInput("ETH", comparisonMatrix(() => "PASS")),
  ]), /outcome.*tolerance|tolerance.*outcome|outcome.*delta/i);
});

test("holdout failure diagnostics reject negative maximum drawdown values", () => {
  const negativeDrawdown = comparisonMatrix(() => "PASS");
  const index = negativeDrawdown.findIndex((item) => item.metric === "MAX_DRAWDOWN_PCT");
  assert.notEqual(index, -1);
  negativeDrawdown[index] = { ...negativeDrawdown[index]!, candidateValue: -0.01 };

  assert.throws(() => diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", negativeDrawdown),
    assetInput("ETH", comparisonMatrix(() => "PASS")),
  ]), /MAX_DRAWDOWN_PCT.*non-negative|drawdown.*non-negative/i);
});

test("holdout failure diagnostics reject supported status with failed comparisons", () => {
  const failed = comparisonMatrix(({ metric }) => metric === "NET_RETURN_PCT" ? "FAIL" : "PASS");

  assert.throws(() => diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", failed, "SUPPORTS_CONTINUED_SHADOW"),
    assetInput("ETH", comparisonMatrix(() => "PASS")),
  ]), /SUPPORTS_CONTINUED_SHADOW.*FAIL|FAIL.*SUPPORTS_CONTINUED_SHADOW/i);
});

test("holdout failure diagnostics reject supported status with unknown comparisons", () => {
  const unknown = comparisonMatrix(({ metric }) => metric === "FEES_KRW" ? "UNKNOWN" : "PASS");

  assert.throws(() => diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", unknown, "SUPPORTS_CONTINUED_SHADOW"),
    assetInput("ETH", comparisonMatrix(() => "PASS")),
  ]), /SUPPORTS_CONTINUED_SHADOW.*UNKNOWN|UNKNOWN.*SUPPORTS_CONTINUED_SHADOW/i);
});

test("holdout failure diagnostics reject rejected status when every comparison passes", () => {
  assert.throws(() => diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", comparisonMatrix(() => "PASS"), "REJECTED"),
    assetInput("ETH", comparisonMatrix(() => "PASS")),
  ]), /REJECTED.*FAIL|no.*FAIL.*REJECTED/i);
});

test("holdout failure diagnostics reject insufficient status when any comparison fails", () => {
  const failed = comparisonMatrix(({ metric }) => metric === "NET_RETURN_PCT" ? "FAIL" : "PASS");

  assert.throws(() => diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", failed, "INSUFFICIENT"),
    assetInput("ETH", comparisonMatrix(() => "PASS")),
  ]), /FAIL.*REJECTED|REJECTED.*FAIL/i);
});

test("holdout failure diagnostics require insufficient status for unknown-only evidence", () => {
  const unknown = comparisonMatrix(({ metric }) => metric === "FEES_KRW" ? "UNKNOWN" : "PASS");

  assert.throws(() => diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", unknown, "REJECTED"),
    assetInput("ETH", comparisonMatrix(() => "PASS")),
  ]), /UNKNOWN.*INSUFFICIENT|INSUFFICIENT.*UNKNOWN/i);
});

test("holdout failure diagnostics allow all-pass evidence to remain insufficient for support or coverage limits", () => {
  const result = diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", comparisonMatrix(() => "PASS"), "INSUFFICIENT"),
    assetInput("ETH", comparisonMatrix(() => "PASS")),
  ]);

  assert.equal(result.assets[0]!.holdoutStatus, "INSUFFICIENT");
  assert.equal(result.assets[0]!.failedComparisonCount, 0);
  assert.equal(result.assets[0]!.unknownComparisonCount, 0);
  assert.equal(result.assets[1]!.holdoutStatus, "SUPPORTS_CONTINUED_SHADOW");
});

test("holdout failure diagnostics reject missing and duplicate comparison cells", () => {
  const complete = comparisonMatrix(() => "PASS");
  assert.throws(() => diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", []),
    assetInput("ETH", complete),
  ]), /exactly one.*comparison/i);
  assert.throws(() => diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", complete.slice(1)),
    assetInput("ETH", complete),
  ]), /exactly one.*comparison/i);
  assert.throws(() => diagnoseCombinedConservativeHoldoutFailures([
    assetInput("BTC", [...complete, { ...complete[0]! }]),
    assetInput("ETH", complete),
  ]), /duplicate.*comparison/i);
});

function assetInput(
  asset: "BTC" | "ETH",
  comparisons: CombinedConservativeHoldoutComparison[],
  status: HoldoutFailureDiagnosticAssetInput["status"] = "SUPPORTS_CONTINUED_SHADOW",
): HoldoutFailureDiagnosticAssetInput {
  return {
    asset,
    market: asset === "BTC" ? "KRW-BTC" : "KRW-ETH",
    status,
    comparisons,
  };
}

function comparisonMatrix(
  outcome: (key: {
    timing: CombinedConservativeHoldoutComparison["timing"];
    cost: CombinedConservativeHoldoutComparison["cost"];
    anchor: CombinedConservativeHoldoutComparison["anchor"];
    metric: CombinedConservativeMetric;
  }) => CombinedConservativeHoldoutComparison["outcome"],
): CombinedConservativeHoldoutComparison[] {
  return (["SAME_CLOSE_MODELED", "NEXT_FRAME_MODELED"] as const).flatMap((timing) =>
    (["BASE", "STRESS"] as const).flatMap((cost) =>
      (["BASELINE", "NO_ADD"] as const).flatMap((anchor) =>
        (["NET_RETURN_PCT", "MAX_DRAWDOWN_PCT", "TURNOVER_KRW", "FEES_KRW"] as const)
          .map((metric) => comparison(timing, cost, anchor, metric, outcome({ timing, cost, anchor, metric }))))));
}

function comparison(
  timing: CombinedConservativeHoldoutComparison["timing"],
  cost: CombinedConservativeHoldoutComparison["cost"],
  anchor: CombinedConservativeHoldoutComparison["anchor"],
  metric: CombinedConservativeMetric,
  outcome: CombinedConservativeHoldoutComparison["outcome"],
): CombinedConservativeHoldoutComparison {
  const monetary = metric === "TURNOVER_KRW" || metric === "FEES_KRW";
  const anchorValue = monetary ? 100 : 0.1;
  const favorableDelta = monetary || metric === "MAX_DRAWDOWN_PCT" ? -1 : 1;
  const delta = outcome === "PASS" ? favorableDelta : outcome === "FAIL" ? -favorableDelta : 0;
  const candidateValue = monetary
    ? anchorValue + delta
    : anchorValue + delta / 100;
  return {
    timing,
    cost,
    anchor,
    metric,
    candidateValue,
    anchorValue,
    delta,
    tolerance: monetary ? 0.000000001 : 0.000001,
    valueUnit: monetary ? "KRW" : "RATIO",
    deltaUnit: monetary ? "KRW" : "PERCENTAGE_POINTS",
    outcome,
  };
}

function shuffleComparisons(
  comparisons: readonly CombinedConservativeHoldoutComparison[],
): CombinedConservativeHoldoutComparison[] {
  return comparisons.filter((_, index) => index % 2 === 1).reverse()
    .concat(comparisons.filter((_, index) => index % 2 === 0).reverse());
}
