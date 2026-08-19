import assert from "node:assert/strict";

import {
  FROZEN_STRATEGY_HYPOTHESIS_MANIFEST,
  evaluateStrategyHypotheses,
  type StrategyHypothesisCoverageObservation,
  type StrategyHypothesisEvaluationInput,
  type StrategyHypothesisMetricObservation,
  type StrategyHypothesisSupportObservation,
} from "../src/modules/performance/performance-strategy-hypothesis-evaluation.js";
import { BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY } from
  "../src/modules/strategy/position-guard-research-manifest.js";
import { test } from "./harness.js";

const ASSETS = ["BTC", "ETH"] as const;
const CANDIDATES = ["HTF_TREND_GATE", "STRICT_PULLBACK"] as const;
const TIMINGS = ["SAME_CLOSE_MODELED", "NEXT_FRAME_MODELED"] as const;
const SCOPES = [
  { scope: "FULL_PATH" as const, windowId: null },
  { scope: "WINDOW" as const, windowId: "W1" },
  { scope: "WINDOW" as const, windowId: "W2" },
  { scope: "WINDOW" as const, windowId: "W3" },
] as const;

test("replay and evaluator derive the frozen research contract from one authority", () => {
  assert.equal(BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.id, "BROAD_LOSS_CAUSE_V1");
  assert.equal(
    FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentFrom,
    BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.developmentRange.from,
  );
  assert.equal(
    FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.developmentTo,
    BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.developmentRange.to,
  );
  assert.deepEqual(
    FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.scenarios,
    BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.scenarioOrder,
  );
  assert.deepEqual(
    FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.costCells,
    BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.costCells,
  );
});

test("complete evidence keeps BTC and ETH independent and makes each eligible", () => {
  const result = evaluateStrategyHypotheses(passingInput());

  assert.deepEqual(result.evaluations.map((item) => `${item.asset}:${item.candidate}`), [
    "BTC:HTF_TREND_GATE",
    "BTC:STRICT_PULLBACK",
    "ETH:HTF_TREND_GATE",
    "ETH:STRICT_PULLBACK",
  ]);
  assert.ok(result.evaluations.every((item) => item.status === "ELIGIBLE_FOR_SHADOW_TEST"));
  assert.ok(result.evaluations.every((item) => item.dataSufficiency.status === "COMPLETE"));
  assert.ok(result.evaluations.every((item) => item.directionalGateOutcome.status === "PASS"));
  assert.deepEqual(result.evaluations[0]?.pathProvenance, [
    {
      timingModel: "SAME_CLOSE_MODELED",
      datasetSha256: "a".repeat(64),
      initialStateFingerprint: "initial-BTC-SAME_CLOSE_MODELED",
      frameFingerprint: "frames-BTC-SAME_CLOSE_MODELED",
    },
    {
      timingModel: "NEXT_FRAME_MODELED",
      datasetSha256: "a".repeat(64),
      initialStateFingerprint: "initial-BTC-NEXT_FRAME_MODELED",
      frameFingerprint: "frames-BTC-NEXT_FRAME_MODELED",
    },
  ]);
  assert.deepEqual(result.evaluations[0]?.directionalGateOutcome.gates.map((gate) => gate.id), [
    "SAME_CLOSE_MODELED:FULL_PATH_BASE_RETURN:BASELINE",
    "SAME_CLOSE_MODELED:FULL_PATH_BASE_RETURN:NO_ADD",
    "SAME_CLOSE_MODELED:FULL_PATH_BASE_DRAWDOWN",
    "SAME_CLOSE_MODELED:BASE_WINDOW_RETURN:BASELINE",
    "SAME_CLOSE_MODELED:BASE_WINDOW_RETURN:NO_ADD",
    "SAME_CLOSE_MODELED:STRESS_RETURN_RETENTION:BASELINE",
    "SAME_CLOSE_MODELED:STRESS_RETURN_RETENTION:NO_ADD",
    "NEXT_FRAME_MODELED:FULL_PATH_BASE_RETURN:BASELINE",
    "NEXT_FRAME_MODELED:FULL_PATH_BASE_RETURN:NO_ADD",
    "NEXT_FRAME_MODELED:FULL_PATH_BASE_DRAWDOWN",
    "NEXT_FRAME_MODELED:BASE_WINDOW_RETURN:BASELINE",
    "NEXT_FRAME_MODELED:BASE_WINDOW_RETURN:NO_ADD",
    "NEXT_FRAME_MODELED:STRESS_RETURN_RETENTION:BASELINE",
    "NEXT_FRAME_MODELED:STRESS_RETURN_RETENTION:NO_ADD",
  ]);
  assert.deepEqual(result.evaluations[0]?.comparisons.fullPath[0], {
    timingModel: "SAME_CLOSE_MODELED",
    costCellId: "BASE",
    costRole: "BASE",
    anchor: "BASELINE",
    candidateNetReturnPct: 0.12,
    anchorNetReturnPct: 0.1,
    returnDeltaPercentagePoints: 2,
    candidateMaxDrawdownPct: 0.08,
    anchorMaxDrawdownPct: 0.1,
    drawdownDeltaPercentagePoints: -2,
  });
  assert.deepEqual(result.crossAssetSummary[0], {
    candidate: "HTF_TREND_GATE",
    adjudicative: false,
    assetStatuses: [
      { asset: "BTC", status: "ELIGIBLE_FOR_SHADOW_TEST" },
      { asset: "ETH", status: "ELIGIBLE_FOR_SHADOW_TEST" },
    ],
  });
});

test("an observable base return failure rejects only its asset and candidate", () => {
  const input = passingInput();
  metric(input, "BTC", "HTF_TREND_GATE", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", "BASE", null)
    .netReturnPct = 0.1;

  const result = evaluateStrategyHypotheses(input);
  const failed = evaluation(result, "BTC", "HTF_TREND_GATE");
  assert.equal(failed.status, "REJECTED");
  assert.equal(failed.directionalGateOutcome.status, "FAIL");
  assert.deepEqual(failed.directionalGateOutcome.reasons, [
    "SAME_CLOSE_MODELED:FULL_PATH_BASE_RETURN_NOT_IMPROVED_VS_BASELINE",
  ]);
  assert.equal(evaluation(result, "ETH", "HTF_TREND_GATE").status, "ELIGIBLE_FOR_SHADOW_TEST");
  assert.equal(evaluation(result, "BTC", "STRICT_PULLBACK").status, "ELIGIBLE_FOR_SHADOW_TEST");
});

test("worse base drawdown is an observable rejection gate", () => {
  const input = passingInput();
  metric(input, "BTC", "HTF_TREND_GATE", "HTF_TREND_GATE", "NEXT_FRAME_MODELED", "BASE", null)
    .maxDrawdownPct = 0.100001;

  const result = evaluation(evaluateStrategyHypotheses(input), "BTC", "HTF_TREND_GATE");
  assert.equal(result.status, "REJECTED");
  assert.deepEqual(result.directionalGateOutcome.reasons, [
    "NEXT_FRAME_MODELED:FULL_PATH_BASE_DRAWDOWN_WORSENED",
  ]);
});

test("fewer than two improved base windows is rejected", () => {
  const input = passingInput();
  for (const windowId of ["W2", "W3"] as const) {
    metric(input, "BTC", "HTF_TREND_GATE", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", "BASE", windowId)
      .netReturnPct = 0.02;
  }

  const result = evaluation(evaluateStrategyHypotheses(input), "BTC", "HTF_TREND_GATE");
  assert.equal(result.status, "REJECTED");
  assert.deepEqual(result.directionalGateOutcome.reasons, [
    "SAME_CLOSE_MODELED:BASE_WINDOW_IMPROVEMENT_COUNT_BELOW_2_VS_BASELINE",
  ]);
});

test("failure to retain positive return under stress is rejected", () => {
  const input = passingInput();
  metric(input, "BTC", "HTF_TREND_GATE", "HTF_TREND_GATE", "NEXT_FRAME_MODELED", "STRESS", null)
    .netReturnPct = 0.06;

  const result = evaluation(evaluateStrategyHypotheses(input), "BTC", "HTF_TREND_GATE");
  assert.equal(result.status, "REJECTED");
  assert.deepEqual(result.directionalGateOutcome.reasons, [
    "NEXT_FRAME_MODELED:STRESS_RETURN_IMPROVEMENT_NOT_RETAINED_VS_BASELINE",
  ]);
});

test("known directional failure wins status precedence without hiding insufficiency", () => {
  const input = passingInput();
  metric(input, "BTC", "HTF_TREND_GATE", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", "BASE", null)
    .netReturnPct = 0.1;
  coverage(input, "BTC", "HTF_TREND_GATE", "NEXT_FRAME_MODELED", null)
    .independentlyVerifiedNoTrade = false;

  const result = evaluation(evaluateStrategyHypotheses(input), "BTC", "HTF_TREND_GATE");
  assert.equal(result.status, "REJECTED");
  assert.equal(result.dataSufficiency.status, "INSUFFICIENT");
  assert.deepEqual(result.dataSufficiency.reasons, [
    "NEXT_FRAME_MODELED:FULL_PATH:INDEPENDENTLY_VERIFIED_NO_TRADE_FALSE",
  ]);
  assert.equal(result.directionalGateOutcome.status, "FAIL");
});

test("return, window, and stress gates independently require improvement over NO_ADD", () => {
  const fullPath = passingInput();
  metric(fullPath, "BTC", "HTF_TREND_GATE", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", "BASE", null)
    .netReturnPct = 0.105;
  setCanonicalAnchorReturn(
    fullPath, "BTC", "NO_ADD", "SAME_CLOSE_MODELED", "BASE", null, 0.105,
  );
  let result = evaluation(evaluateStrategyHypotheses(fullPath), "BTC", "HTF_TREND_GATE");
  assert.deepEqual(result.directionalGateOutcome.reasons, [
    "SAME_CLOSE_MODELED:FULL_PATH_BASE_RETURN_NOT_IMPROVED_VS_NO_ADD",
  ]);

  const windows = passingInput();
  for (const windowId of ["W2", "W3"] as const) {
    metric(windows, "BTC", "HTF_TREND_GATE", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", "BASE", windowId)
      .netReturnPct = 0.01;
    setCanonicalAnchorReturn(
      windows, "BTC", "BASELINE", "SAME_CLOSE_MODELED", "BASE", windowId, 0,
    );
  }
  result = evaluation(evaluateStrategyHypotheses(windows), "BTC", "HTF_TREND_GATE");
  assert.deepEqual(result.directionalGateOutcome.reasons, [
    "SAME_CLOSE_MODELED:BASE_WINDOW_IMPROVEMENT_COUNT_BELOW_2_VS_NO_ADD",
  ]);

  const stress = passingInput();
  metric(stress, "BTC", "HTF_TREND_GATE", "HTF_TREND_GATE", "NEXT_FRAME_MODELED", "STRESS", null)
    .netReturnPct = 0.05;
  setCanonicalAnchorReturn(
    stress, "BTC", "BASELINE", "NEXT_FRAME_MODELED", "STRESS", null, 0.04,
  );
  result = evaluation(evaluateStrategyHypotheses(stress), "BTC", "HTF_TREND_GATE");
  assert.deepEqual(result.directionalGateOutcome.reasons, [
    "NEXT_FRAME_MODELED:STRESS_RETURN_IMPROVEMENT_NOT_RETAINED_VS_NO_ADD",
  ]);
});

test("every asset and timing path requires one canonical provenance identity", () => {
  const candidateMismatch = passingInput();
  const changedCandidate = metric(
    candidateMismatch,
    "BTC",
    "HTF_TREND_GATE",
    "HTF_TREND_GATE",
    "SAME_CLOSE_MODELED",
    "BASE",
    null,
  ) as unknown as { frameFingerprint: string };
  changedCandidate.frameFingerprint = "frame-other";
  assert.throws(
    () => evaluateStrategyHypotheses(candidateMismatch),
    /provenance identity mismatch.*BTC.*SAME_CLOSE_MODELED/i,
  );

  const anchorMismatch = passingInput();
  const changedAnchor = metric(
    anchorMismatch,
    "BTC",
    "STRICT_PULLBACK",
    "BASELINE",
    "NEXT_FRAME_MODELED",
    "STRESS",
    "W2",
  );
  changedAnchor.netReturnPct += 0.001;
  assert.throws(
    () => evaluateStrategyHypotheses(anchorMismatch),
    /canonical anchor mismatch.*BTC.*NEXT_FRAME_MODELED.*STRESS.*W2.*BASELINE/i,
  );
});

test("candidate selection accepts only an exact subsequence of frozen scenario order", () => {
  assert.deepEqual(FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.scenarios, [
    "HTF_TREND_GATE",
    "STRICT_PULLBACK",
    "EARLY_THESIS_FAILURE",
    "ADD_LIMITED",
    "COOLDOWN_CONTROL",
    "COMBINED_CONSERVATIVE",
  ]);
  const valid = passingInput([
    "HTF_TREND_GATE",
    "EARLY_THESIS_FAILURE",
    "ADD_LIMITED",
    "COMBINED_CONSERVATIVE",
  ]);
  assert.deepEqual(evaluateStrategyHypotheses(valid).crossAssetSummary.map((item) => item.candidate), [
    "HTF_TREND_GATE",
    "EARLY_THESIS_FAILURE",
    "ADD_LIMITED",
    "COMBINED_CONSERVATIVE",
  ]);

  const reordered = passingInput(["STRICT_PULLBACK", "HTF_TREND_GATE"]);
  assert.throws(() => evaluateStrategyHypotheses(reordered), /frozen scenario order/i);
});

test("coverage, carry-in, and support gaps are insufficient when no failure is observable", () => {
  const cases: Array<{
    name: string;
    mutate: (input: StrategyHypothesisEvaluationInput) => void;
    reason: string;
  }> = [
    {
      name: "unverified no-trade",
      mutate: (input) => { coverage(input, "BTC", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", null).independentlyVerifiedNoTrade = false; },
      reason: "SAME_CLOSE_MODELED:FULL_PATH:INDEPENDENTLY_VERIFIED_NO_TRADE_FALSE",
    },
    {
      name: "carry-in state",
      mutate: (input) => { coverage(input, "BTC", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", null).carryInStateComplete = false; },
      reason: "SAME_CLOSE_MODELED:FULL_PATH:CARRY_IN_STATE_INCOMPLETE",
    },
    {
      name: "cadence",
      mutate: (input) => { coverage(input, "BTC", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", "W1").cadenceComplete = false; },
      reason: "SAME_CLOSE_MODELED:W1:CADENCE_INCOMPLETE",
    },
    {
      name: "lifecycle",
      mutate: (input) => { coverage(input, "BTC", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", null).lifecycleComplete = false; },
      reason: "SAME_CLOSE_MODELED:FULL_PATH:LIFECYCLE_INCOMPLETE",
    },
    {
      name: "fee",
      mutate: (input) => { coverage(input, "BTC", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", null).feeComplete = false; },
      reason: "SAME_CLOSE_MODELED:FULL_PATH:FEE_INCOMPLETE",
    },
    {
      name: "finite support declaration",
      mutate: (input) => { coverage(input, "BTC", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", null).finiteMetricsComplete = false; },
      reason: "SAME_CLOSE_MODELED:FULL_PATH:FINITE_METRICS_INCOMPLETE",
    },
    {
      name: "full path support",
      mutate: (input) => { support(input, "BTC", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", null).completedEpisodeCount = 29; },
      reason: "SAME_CLOSE_MODELED:FULL_PATH:COMPLETED_EPISODES_BELOW_30",
    },
    {
      name: "window support",
      mutate: (input) => { support(input, "BTC", "HTF_TREND_GATE", "SAME_CLOSE_MODELED", "W2").policyExposedCompletedEpisodeCount = 9; },
      reason: "SAME_CLOSE_MODELED:W2:POLICY_EXPOSED_COMPLETED_EPISODES_BELOW_10",
    },
  ];

  for (const item of cases) {
    const input = passingInput();
    item.mutate(input);
    const result = evaluation(evaluateStrategyHypotheses(input), "BTC", "HTF_TREND_GATE");
    assert.equal(result.status, "INSUFFICIENT", item.name);
    assert.equal(result.dataSufficiency.status, "INSUFFICIENT", item.name);
    assert.ok(result.dataSufficiency.reasons.includes(item.reason), item.name);
    assert.equal(result.directionalGateOutcome.status, "PASS", item.name);
  }
});

test("both timing models are mandatory and missing metrics make directional gates unknown", () => {
  const input = passingInput();
  input.metricObservations = input.metricObservations.filter((item) => !(
    item.asset === "BTC"
    && item.candidate === "HTF_TREND_GATE"
    && item.timingModel === "NEXT_FRAME_MODELED"
  ));

  const result = evaluation(evaluateStrategyHypotheses(input), "BTC", "HTF_TREND_GATE");
  assert.equal(result.status, "INSUFFICIENT");
  assert.equal(result.dataSufficiency.status, "INSUFFICIENT");
  assert.equal(result.directionalGateOutcome.status, "UNKNOWN");
  assert.ok(result.dataSufficiency.reasons.includes("NEXT_FRAME_MODELED:METRIC_EVIDENCE_MISSING"));
});

test("the evaluator requires the exact frozen development manifest, windows, and explicit cost roles", () => {
  const wrongRange = passingInput();
  wrongRange.manifest = { ...wrongRange.manifest, developmentTo: "2026-04-12T20:00:00Z" };
  assert.throws(() => evaluateStrategyHypotheses(wrongRange), /frozen development manifest/i);

  const wrongWindow = passingInput();
  wrongWindow.manifest = {
    ...wrongWindow.manifest,
    windows: wrongWindow.manifest.windows.map((item) => item.id === "W2"
      ? { ...item, from: "2025-10-25T00:00:00Z" }
      : item),
  };
  assert.throws(() => evaluateStrategyHypotheses(wrongWindow), /frozen development manifest/i);

  const wrongRole = passingInput();
  wrongRole.metricObservations[0]!.costRole = "STRESS";
  assert.throws(() => evaluateStrategyHypotheses(wrongRole), /cost role/i);
});

test("duplicate, malformed, non-finite, and non-ordered evidence is rejected", () => {
  const duplicate = passingInput();
  duplicate.metricObservations.push({ ...duplicate.metricObservations[0]! });
  assert.throws(() => evaluateStrategyHypotheses(duplicate), /duplicate metric observation/i);

  const nonFinite = passingInput();
  nonFinite.metricObservations[0]!.netReturnPct = Number.NaN;
  assert.throws(() => evaluateStrategyHypotheses(nonFinite), /finite/i);

  const malformed = passingInput();
  (malformed.coverageObservations[0] as unknown as { windowId: string }).windowId = "W9";
  assert.throws(() => evaluateStrategyHypotheses(malformed), /window/i);

  const unordered = passingInput();
  const first = unordered.metricObservations[0]!;
  const second = unordered.metricObservations[1]!;
  unordered.metricObservations[0] = second;
  unordered.metricObservations[1] = first;
  assert.throws(() => evaluateStrategyHypotheses(unordered), /stable order/i);
});

function passingInput(candidates: readonly string[] = CANDIDATES): StrategyHypothesisEvaluationInput {
  const metricObservations: StrategyHypothesisMetricObservation[] = [];
  const coverageObservations: StrategyHypothesisCoverageObservation[] = [];
  const supportObservations: StrategyHypothesisSupportObservation[] = [];
  for (const asset of ASSETS) {
    for (const candidate of candidates) {
      for (const timingModel of TIMINGS) {
        for (const scope of SCOPES) {
          coverageObservations.push({
            asset,
            candidate,
            timingModel,
            ...scope,
            cadenceComplete: true,
            independentlyVerifiedNoTrade: true,
            lifecycleComplete: true,
            feeComplete: true,
            finiteMetricsComplete: true,
            carryInStateComplete: true,
          });
          supportObservations.push({
            asset,
            candidate,
            timingModel,
            ...scope,
            completedEpisodeCount: scope.scope === "FULL_PATH" ? 30 : 12,
            policyExposedCompletedEpisodeCount: scope.scope === "WINDOW" ? 10 : 30,
          });
          for (const cost of FROZEN_STRATEGY_HYPOTHESIS_MANIFEST.costCells) {
            for (const scenario of ["BASELINE", "NO_ADD", candidate]) {
              const isCandidate = scenario === candidate;
              metricObservations.push({
                asset,
                candidate,
                scenario,
                timingModel,
                datasetSha256: asset === "BTC" ? "a".repeat(64) : "b".repeat(64),
                initialStateFingerprint: `initial-${asset}-${timingModel}`,
                frameFingerprint: `frames-${asset}-${timingModel}`,
                costCellId: cost.id,
                costRole: cost.role,
                ...scope,
                netReturnPct: isCandidate
                  ? (cost.role === "BASE" ? (scope.scope === "FULL_PATH" ? 0.12 : 0.04) : 0.08)
                  : scenario === "BASELINE"
                    ? (cost.role === "BASE" ? (scope.scope === "FULL_PATH" ? 0.1 : 0.02) : 0.06)
                    : (cost.role === "BASE"
                      ? (scope.scope === "FULL_PATH" ? 0.09 : 0.01)
                      : 0.05),
                maxDrawdownPct: isCandidate ? 0.08 : scenario === "BASELINE" ? 0.1 : 0.09,
              } as StrategyHypothesisMetricObservation);
            }
          }
        }
      }
    }
  }
  return {
    manifest: structuredClone(FROZEN_STRATEGY_HYPOTHESIS_MANIFEST),
    candidates: [...candidates],
    metricObservations,
    coverageObservations,
    supportObservations,
  };
}

function metric(
  input: StrategyHypothesisEvaluationInput,
  asset: "BTC" | "ETH",
  candidate: string,
  scenario: string,
  timingModel: "SAME_CLOSE_MODELED" | "NEXT_FRAME_MODELED",
  costCellId: "BASE" | "STRESS",
  windowId: "W1" | "W2" | "W3" | null,
): StrategyHypothesisMetricObservation {
  const found = input.metricObservations.find((item) => item.asset === asset
    && item.candidate === candidate
    && item.scenario === scenario
    && item.timingModel === timingModel
    && item.costCellId === costCellId
    && item.windowId === windowId);
  assert.ok(found);
  return found;
}

function setCanonicalAnchorReturn(
  input: StrategyHypothesisEvaluationInput,
  asset: "BTC" | "ETH",
  anchor: "BASELINE" | "NO_ADD",
  timingModel: "SAME_CLOSE_MODELED" | "NEXT_FRAME_MODELED",
  costCellId: "BASE" | "STRESS",
  windowId: "W1" | "W2" | "W3" | null,
  netReturnPct: number,
): void {
  for (const observation of input.metricObservations) {
    if (observation.asset === asset
      && observation.scenario === anchor
      && observation.timingModel === timingModel
      && observation.costCellId === costCellId
      && observation.windowId === windowId) {
      observation.netReturnPct = netReturnPct;
    }
  }
}

function coverage(
  input: StrategyHypothesisEvaluationInput,
  asset: "BTC" | "ETH",
  candidate: string,
  timingModel: "SAME_CLOSE_MODELED" | "NEXT_FRAME_MODELED",
  windowId: "W1" | "W2" | "W3" | null,
): StrategyHypothesisCoverageObservation {
  const found = input.coverageObservations.find((item) => item.asset === asset
    && item.candidate === candidate
    && item.timingModel === timingModel
    && item.windowId === windowId);
  assert.ok(found);
  return found;
}

function support(
  input: StrategyHypothesisEvaluationInput,
  asset: "BTC" | "ETH",
  candidate: string,
  timingModel: "SAME_CLOSE_MODELED" | "NEXT_FRAME_MODELED",
  windowId: "W1" | "W2" | "W3" | null,
): StrategyHypothesisSupportObservation {
  const found = input.supportObservations.find((item) => item.asset === asset
    && item.candidate === candidate
    && item.timingModel === timingModel
    && item.windowId === windowId);
  assert.ok(found);
  return found;
}

function evaluation(
  result: ReturnType<typeof evaluateStrategyHypotheses>,
  asset: "BTC" | "ETH",
  candidate: string,
) {
  const found = result.evaluations.find((item) => item.asset === asset && item.candidate === candidate);
  assert.ok(found);
  return found;
}
