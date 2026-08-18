import assert from "node:assert/strict";

import {
  classifyAddHoldoutHypotheses,
  type AddHoldoutHypothesisInput,
} from "../src/modules/performance/performance-add-holdout-hypothesis.js";
import type { AddLossAttributionResult } from "../src/modules/performance/performance-add-loss-attribution.js";
import type { AddPolicyCandidate, AddPolicyCandidateEvaluationResult } from "../src/modules/performance/performance-add-policy-evaluation.js";
import { test } from "./harness.js";

test("holdout classifier applies NOT_APPLICABLE before all other outcomes", () => {
  const result = classifyAddHoldoutHypotheses(input({
    evaluations: [evaluation("BTC", "ADD_RISK_CLEAR")],
  }));

  assert.deepEqual(result.hypotheses.map((item) => ({ candidate: item.candidate, status: item.status, reasons: item.reasonCodes })), [
    { candidate: "ADD_CORE_TREND", status: "NOT_APPLICABLE", reasons: ["MISSING_BTC_CANDIDATE_EVALUATION", "MISSING_BTC_SUPPRESSION_EVIDENCE", "MISSING_ETH_CANDIDATE_EVALUATION", "MISSING_ETH_SUPPRESSION_EVIDENCE"] },
    { candidate: "ADD_HIGH_ALIGNMENT", status: "NOT_APPLICABLE", reasons: ["MISSING_BTC_CANDIDATE_EVALUATION", "MISSING_BTC_SUPPRESSION_EVIDENCE", "MISSING_ETH_CANDIDATE_EVALUATION", "MISSING_ETH_SUPPRESSION_EVIDENCE"] },
    { candidate: "ADD_RISK_CLEAR", status: "NOT_APPLICABLE", reasons: ["MISSING_ETH_CANDIDATE_EVALUATION"] },
  ]);
});

test("holdout classifier returns INSUFFICIENT for incomplete suppression evidence before gate disagreement", () => {
  const result = classifyAddHoldoutHypotheses(input({
    btcAttribution: attribution("BTC", "ADD_RISK_CLEAR", { completeness: "UNKNOWN" }),
    evaluations: [evaluation("BTC", "ADD_RISK_CLEAR", { failPerformance: true }), evaluation("ETH", "ADD_RISK_CLEAR")],
  }));
  const hypothesis = byCandidate(result, "ADD_RISK_CLEAR");

  assert.equal(hypothesis.status, "INSUFFICIENT");
  assert.deepEqual(hypothesis.reasonCodes, ["BTC_SUPPRESSED_CONTRIBUTION_INCOMPLETE"]);
});

test("holdout classifier returns CONFLICTING when complete cross-asset evidence fails frozen gates or loses no money", () => {
  const gateConflict = classifyAddHoldoutHypotheses(input({
    evaluations: [evaluation("BTC", "ADD_RISK_CLEAR", { failPerformance: true }), evaluation("ETH", "ADD_RISK_CLEAR")],
  }));
  assert.deepEqual(byCandidate(gateConflict, "ADD_RISK_CLEAR").reasonCodes, ["BTC_FROZEN_PERFORMANCE_OR_DRAWDOWN_GATE_FAILED"]);
  assert.equal(byCandidate(gateConflict, "ADD_RISK_CLEAR").status, "CONFLICTING");

  const contributionConflict = classifyAddHoldoutHypotheses(input({
    ethAttribution: attribution("ETH", "ADD_RISK_CLEAR", { net: 10 }),
    evaluations: [evaluation("BTC", "ADD_RISK_CLEAR"), evaluation("ETH", "ADD_RISK_CLEAR")],
  }));
  assert.equal(byCandidate(contributionConflict, "ADD_RISK_CLEAR").status, "CONFLICTING");
  assert.deepEqual(byCandidate(contributionConflict, "ADD_RISK_CLEAR").reasonCodes, ["ETH_SUPPRESSED_CONTRIBUTION_NOT_NEGATIVE"]);
});

test("holdout classifier marks only support-only insufficiency with negative known net as READY without changing source status", () => {
  const result = classifyAddHoldoutHypotheses(input({
    evaluations: [
      evaluation("BTC", "ADD_RISK_CLEAR", { supportInsufficient: true }),
      evaluation("ETH", "ADD_RISK_CLEAR", { supportInsufficient: true }),
    ],
  }));
  const hypothesis = byCandidate(result, "ADD_RISK_CLEAR");

  assert.equal(hypothesis.status, "READY_FOR_FUTURE_HOLDOUT");
  assert.deepEqual(hypothesis.reasonCodes, ["SUPPORT_ONLY_INSUFFICIENCY_WITH_CROSS_ASSET_NEGATIVE_CONTRIBUTION"]);
  assert.deepEqual(hypothesis.sourceCandidateStatuses, { BTC: "INSUFFICIENT", ETH: "INSUFFICIENT" });
});

test("holdout classifier treats support insufficiency plus a frozen performance failure as CONFLICTING", () => {
  const result = classifyAddHoldoutHypotheses(input({
    evaluations: [
      evaluation("BTC", "ADD_RISK_CLEAR", { supportInsufficient: true, failPerformance: true }),
      evaluation("ETH", "ADD_RISK_CLEAR", { supportInsufficient: true }),
    ],
  }));

  const hypothesis = byCandidate(result, "ADD_RISK_CLEAR");
  assert.equal(hypothesis.status, "CONFLICTING");
  assert.deepEqual(hypothesis.reasonCodes, ["BTC_FROZEN_PERFORMANCE_OR_DRAWDOWN_GATE_FAILED"]);
});

test("holdout classifier never marks READY when frozen cost cells, windows, comparisons, or coverage are incomplete", () => {
  for (const invalid of ["missingStressCell", "missingWindow", "emptyComparisons", "incompleteCoverage"] as const) {
    const result = classifyAddHoldoutHypotheses(input({
      evaluations: [
        evaluation("BTC", "ADD_RISK_CLEAR", { supportInsufficient: true, [invalid]: true }),
        evaluation("ETH", "ADD_RISK_CLEAR", { supportInsufficient: true }),
      ],
    }));
    const hypothesis = byCandidate(result, "ADD_RISK_CLEAR");
    assert.equal(hypothesis.status, "INSUFFICIENT", invalid);
    assert.deepEqual(hypothesis.reasonCodes, ["BTC_CANDIDATE_EVIDENCE_INSUFFICIENT"], invalid);
  }
});

test("holdout classifier requires every BASE and STRESS cost cell to retain the frozen anchor identity", () => {
  const malformed = evaluation("BTC", "ADD_RISK_CLEAR", { supportInsufficient: true });
  const firstCell = malformed.observations.fullPath.observations[0]!;
  const mismatched = {
    ...malformed,
    observations: {
      ...malformed.observations,
      fullPath: {
        ...malformed.observations.fullPath,
        observations: [{ ...firstCell, feeRate: firstCell.feeRate + 0.0001 }, ...malformed.observations.fullPath.observations.slice(1)],
      },
    },
  };
  const result = classifyAddHoldoutHypotheses(input({
    evaluations: [mismatched, evaluation("ETH", "ADD_RISK_CLEAR", { supportInsufficient: true })],
  }));

  assert.equal(byCandidate(result, "ADD_RISK_CLEAR").status, "INSUFFICIENT");
  assert.deepEqual(byCandidate(result, "ADD_RISK_CLEAR").reasonCodes, ["BTC_CANDIDATE_EVIDENCE_INSUFFICIENT"]);
});

test("holdout classifier requires approved thresholds and internally consistent frozen support counts before READY", () => {
  const cases: Array<{ name: string; mutate: (value: AddPolicyCandidateEvaluationResult) => AddPolicyCandidateEvaluationResult }> = [
    {
      name: "lowered threshold",
      mutate: (value) => ({ ...value, thresholds: { ...value.thresholds, minimumFullPathPolicyExposedCompletedEpisodes: 1 } }),
    },
    {
      name: "lowered full-path required count",
      mutate: (value) => ({ ...value, gates: { ...value.gates, policyExposedCompletedEpisodes: { ...value.gates.policyExposedCompletedEpisodes, fullPathRequiredCount: 29 } } }),
    },
    {
      name: "lowered W1 required count",
      mutate: (value) => ({ ...value, gates: { ...value.gates, policyExposedCompletedEpisodes: { ...value.gates.policyExposedCompletedEpisodes, windows: value.gates.policyExposedCompletedEpisodes.windows.map((window) => window.windowId === "W1" ? { ...window, requiredCount: 9 } : window) } } }),
    },
    {
      name: "inconsistent passed count",
      mutate: (value) => ({ ...value, gates: { ...value.gates, policyExposedCompletedEpisodes: { ...value.gates.policyExposedCompletedEpisodes, windows: value.gates.policyExposedCompletedEpisodes.windows.map((window) => window.windowId === "W1" ? { ...window, observedCount: 11, passed: false } : window) } } }),
    },
  ];
  for (const invalid of cases) {
    const result = classifyAddHoldoutHypotheses(input({
      evaluations: [
        invalid.mutate(evaluation("BTC", "ADD_RISK_CLEAR", { supportInsufficient: true })),
        evaluation("ETH", "ADD_RISK_CLEAR", { supportInsufficient: true }),
      ],
    }));
    const hypothesis = byCandidate(result, "ADD_RISK_CLEAR");
    assert.equal(hypothesis.status, "INSUFFICIENT", invalid.name);
    assert.deepEqual(hypothesis.reasonCodes, ["BTC_APPROVED_THRESHOLD_OR_SUPPORT_CONTRACT_INSUFFICIENT"], invalid.name);
  }
});

test("holdout classifier rejects suppressed-cohort total identity and homogeneous lifecycle quantity contradictions", () => {
  const cases: Array<{ name: string; mutate: (value: AddLossAttributionResult) => AddLossAttributionResult }> = [
    {
      name: "net total differs from gross minus fee",
      mutate: (value) => replaceSuppressedMetrics(value, (metrics) => ({
        ...metrics,
        grossRealizedContributionKrw: { ...metrics.grossRealizedContributionKrw, knownSubtotal: { status: "KNOWN", value: -90 }, total: { status: "KNOWN", value: -90 } },
      })),
    },
    {
      name: "fully realized has remaining quantity",
      mutate: (value) => replaceSuppressedMetrics(value, (metrics) => ({
        ...metrics,
        remainingQuantity: { ...metrics.remainingQuantity, knownSubtotal: { status: "KNOWN", value: 0.1 }, total: { status: "KNOWN", value: 0.1 } },
      })),
    },
    {
      name: "unrealized has realized quantity",
      mutate: (value) => replaceSuppressedMetrics(value, (metrics) => ({
        ...metrics,
        fullyRealizedAddCount: 0,
        unrealizedAddCount: 1,
        realizedQuantity: { ...metrics.realizedQuantity, knownSubtotal: { status: "KNOWN", value: 1 }, total: { status: "KNOWN", value: 1 } },
        remainingQuantity: { ...metrics.remainingQuantity, knownSubtotal: { status: "KNOWN", value: 1 }, total: { status: "KNOWN", value: 1 } },
      })),
    },
    {
      name: "partial has zero remaining quantity",
      mutate: (value) => replaceSuppressedMetrics(value, (metrics) => ({
        ...metrics,
        fullyRealizedAddCount: 0,
        partiallyRealizedAddCount: 1,
        remainingQuantity: { ...metrics.remainingQuantity, knownSubtotal: { status: "KNOWN", value: 0 }, total: { status: "KNOWN", value: 0 } },
      })),
    },
  ];
  for (const invalid of cases) {
    assert.throws(() => classifyAddHoldoutHypotheses(input({
      attributions: [invalid.mutate(attribution("BTC")), attribution("ETH")],
      evaluations: [
        evaluation("BTC", "ADD_RISK_CLEAR", { supportInsufficient: true }),
        evaluation("ETH", "ADD_RISK_CLEAR", { supportInsufficient: true }),
      ],
    })), /suppressed contribution/i, invalid.name);
  }
});

test("holdout classifier keeps gross-unknown suppression evidence INSUFFICIENT even when fee and net are known", () => {
  const result = classifyAddHoldoutHypotheses(input({
    btcAttribution: replaceSuppressedMetrics(attribution("BTC"), (metrics) => ({
      ...metrics,
      knownGrossContributionCount: 0,
      grossRealizedContributionKrw: aggregateMetric("UNKNOWN", 0),
      meanKnownGrossContributionKrw: aggregateMetric("UNKNOWN", 0),
    })),
    evaluations: [
      evaluation("BTC", "ADD_RISK_CLEAR", { supportInsufficient: true }),
      evaluation("ETH", "ADD_RISK_CLEAR", { supportInsufficient: true }),
    ],
  }));

  const hypothesis = byCandidate(result, "ADD_RISK_CLEAR");
  assert.equal(hypothesis.status, "INSUFFICIENT");
  assert.deepEqual(hypothesis.reasonCodes, ["BTC_SUPPRESSED_CONTRIBUTION_INCOMPLETE"]);
});

test("holdout classifier rejects blank suppression provenance before READY classification", () => {
  const blank = attribution("BTC");
  const damaged = {
    ...blank,
    policySuppressedCohorts: [{ ...blank.policySuppressedCohorts[0]!, suppressionEvidenceIds: [" "] }],
  };

  assert.throws(() => classifyAddHoldoutHypotheses(input({
    attributions: [damaged, attribution("ETH")],
    evaluations: [
      evaluation("BTC", "ADD_RISK_CLEAR", { supportInsufficient: true }),
      evaluation("ETH", "ADD_RISK_CLEAR", { supportInsufficient: true }),
    ],
  })), /suppression evidence id/i);
});

test("holdout classifier treats configured zero-observation suppression cohorts as INSUFFICIENT", () => {
  const emptyAttribution = (asset: "BTC" | "ETH"): AddLossAttributionResult => {
    const value = attribution(asset);
    const metrics = value.policySuppressedCohorts[0]!.metrics;
    const emptyMetric = {
      completeness: "UNKNOWN" as const,
      knownCount: 0,
      unknownCount: 0,
      knownSubtotal: { status: "UNKNOWN" as const, reasons: ["NO_KNOWN_CONTRIBUTIONS"] },
      total: { status: "UNKNOWN" as const, reasons: ["NO_KNOWN_CONTRIBUTIONS"] },
    };
    return {
      ...value,
      policySuppressedCohorts: [{
        ...value.policySuppressedCohorts[0]!,
        suppressionEvidenceIds: [],
        metrics: {
          ...metrics,
          executedAddCount: 0,
          fullyRealizedAddCount: 0,
          knownGrossContributionCount: 0,
          knownNetContributionCount: 0,
          negativeNetContributionCount: 0,
          grossRealizedContributionKrw: emptyMetric,
          confirmedFeeImpactKrw: emptyMetric,
          netRealizedContributionKrw: emptyMetric,
          meanKnownGrossContributionKrw: emptyMetric,
          meanKnownNetContributionKrw: emptyMetric,
          realizedQuantity: emptyMetric,
          remainingQuantity: emptyMetric,
          evidenceIds: [],
          evidence: [],
        },
      }],
    };
  };
  const result = classifyAddHoldoutHypotheses(input({
    attributions: [emptyAttribution("BTC"), emptyAttribution("ETH")],
    evaluations: [
      evaluation("BTC", "ADD_RISK_CLEAR", { supportInsufficient: true }),
      evaluation("ETH", "ADD_RISK_CLEAR", { supportInsufficient: true }),
    ],
  }));

  const hypothesis = byCandidate(result, "ADD_RISK_CLEAR");
  assert.equal(hypothesis.status, "INSUFFICIENT");
  assert.deepEqual(hypothesis.reasonCodes, [
    "BTC_SUPPRESSED_CONTRIBUTION_INCOMPLETE",
    "ETH_SUPPRESSED_CONTRIBUTION_INCOMPLETE",
  ]);
});

test("holdout classifier rejects zero-volume contradictions for fully realized, unrealized, and partial cohorts", () => {
  const cases: Array<{ name: string; mutate: (value: AddLossAttributionResult) => AddLossAttributionResult }> = [
    {
      name: "fully realized zero realized quantity",
      mutate: (value) => replaceSuppressedMetrics(value, (metrics) => ({
        ...metrics,
        realizedQuantity: { ...metrics.realizedQuantity, knownSubtotal: { status: "KNOWN", value: 0 }, total: { status: "KNOWN", value: 0 } },
      })),
    },
    {
      name: "unrealized zero remaining quantity",
      mutate: (value) => replaceSuppressedMetrics(value, (metrics) => ({
        ...metrics,
        fullyRealizedAddCount: 0,
        unrealizedAddCount: 1,
        realizedQuantity: { ...metrics.realizedQuantity, knownSubtotal: { status: "KNOWN", value: 0 }, total: { status: "KNOWN", value: 0 } },
        remainingQuantity: { ...metrics.remainingQuantity, knownSubtotal: { status: "KNOWN", value: 0 }, total: { status: "KNOWN", value: 0 } },
      })),
    },
    {
      name: "partial zero realized quantity",
      mutate: (value) => replaceSuppressedMetrics(value, (metrics) => ({
        ...metrics,
        fullyRealizedAddCount: 0,
        partiallyRealizedAddCount: 1,
        realizedQuantity: { ...metrics.realizedQuantity, knownSubtotal: { status: "KNOWN", value: 0 }, total: { status: "KNOWN", value: 0 } },
        remainingQuantity: { ...metrics.remainingQuantity, knownSubtotal: { status: "KNOWN", value: 1 }, total: { status: "KNOWN", value: 1 } },
      })),
    },
  ];
  for (const invalid of cases) {
    assert.throws(() => classifyAddHoldoutHypotheses(input({
      attributions: [invalid.mutate(attribution("BTC")), attribution("ETH")],
      evaluations: [
        evaluation("BTC", "ADD_RISK_CLEAR", { supportInsufficient: true }),
        evaluation("ETH", "ADD_RISK_CLEAR", { supportInsufficient: true }),
      ],
    })), /suppressed contribution/i, invalid.name);
  }
});

test("holdout classifier rejects damaged suppressed-cohort arithmetic before using its net sign", () => {
  const cases: Array<{ name: string; mutate: (value: AddLossAttributionResult) => AddLossAttributionResult }> = [
    {
      name: "negative fee",
      mutate: (value) => replaceSuppressedMetrics(value, (metrics) => ({
        ...metrics,
        confirmedFeeImpactKrw: { ...metrics.confirmedFeeImpactKrw, total: { status: "KNOWN", value: -1 }, knownSubtotal: { status: "KNOWN", value: -1 } },
      })),
    },
    {
      name: "negative quantity",
      mutate: (value) => replaceSuppressedMetrics(value, (metrics) => ({
        ...metrics,
        realizedQuantity: { ...metrics.realizedQuantity, total: { status: "KNOWN", value: -1 }, knownSubtotal: { status: "KNOWN", value: -1 } },
      })),
    },
    {
      name: "lifecycle sum",
      mutate: (value) => replaceSuppressedMetrics(value, (metrics) => ({ ...metrics, fullyRealizedAddCount: 0 })),
    },
    {
      name: "known count",
      mutate: (value) => replaceSuppressedMetrics(value, (metrics) => ({ ...metrics, knownNetContributionCount: 0 })),
    },
  ];
  for (const invalid of cases) {
    assert.throws(() => classifyAddHoldoutHypotheses(input({
      attributions: [invalid.mutate(attribution("BTC")), attribution("ETH")],
      evaluations: [evaluation("BTC", "ADD_RISK_CLEAR"), evaluation("ETH", "ADD_RISK_CLEAR")],
    })), /suppressed contribution/i, invalid.name);
  }
});

test("holdout classifier preserves exact suppression wrapper evidence and reports only non-support-only assets", () => {
  const btc = attribution("BTC");
  const eth = attribution("ETH");
  const result = classifyAddHoldoutHypotheses(input({
    attributions: [btc, eth],
    evaluations: [
      evaluation("BTC", "ADD_RISK_CLEAR", { supportInsufficient: true }),
      evaluation("ETH", "ADD_RISK_CLEAR"),
    ],
  }));
  const hypothesis = byCandidate(result, "ADD_RISK_CLEAR");

  assert.equal(hypothesis.status, "CONFLICTING");
  assert.deepEqual(hypothesis.reasonCodes, ["ETH_NOT_SUPPORT_ONLY_INSUFFICIENT"]);
  assert.deepEqual(hypothesis.assets[0]!.suppressionEvidenceIds, btc.policySuppressedCohorts[0]!.suppressionEvidenceIds);
  assert.deepEqual(hypothesis.assets[1]!.suppressionEvidenceIds, eth.policySuppressedCohorts[0]!.suppressionEvidenceIds);
});

test("holdout classifier rejects non-JSON-safe values and cycles", () => {
  const unsupported: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["function", () => undefined],
    ["symbol", Symbol("unsafe")],
    ["bigint", 1n],
  ];
  for (const [name, unsafe] of unsupported) {
    const candidate = evaluation("BTC", "ADD_RISK_CLEAR") as unknown as Record<string, unknown>;
    candidate.unsafe = unsafe;
    assert.throws(() => classifyAddHoldoutHypotheses(input({ evaluations: [candidate as unknown as AddPolicyCandidateEvaluationResult, evaluation("ETH", "ADD_RISK_CLEAR")] })), /JSON-safe/i, name);
  }
  const cyclic = evaluation("BTC", "ADD_RISK_CLEAR") as unknown as Record<string, unknown>;
  cyclic.self = cyclic;
  assert.throws(() => classifyAddHoldoutHypotheses(input({ evaluations: [cyclic as unknown as AddPolicyCandidateEvaluationResult, evaluation("ETH", "ADD_RISK_CLEAR")] })), /cycle/i);
});

test("holdout classifier rejects duplicate, mismatched, non-finite, and incomplete candidate evidence", () => {
  assert.throws(() => classifyAddHoldoutHypotheses(input({
    attributions: [attribution("BTC"), attribution("BTC")],
  })), /duplicate ADD holdout attribution asset BTC/i);
  assert.throws(() => classifyAddHoldoutHypotheses(input({
    evaluations: [evaluation("BTC", "ADD_RISK_CLEAR"), evaluation("BTC", "ADD_RISK_CLEAR")],
  })), /duplicate ADD holdout candidate evaluation BTC:ADD_RISK_CLEAR/i);
  assert.throws(() => classifyAddHoldoutHypotheses(input({
    evaluations: [evaluation("BTC", "ADD_RISK_CLEAR", { nonFinite: true }), evaluation("ETH", "ADD_RISK_CLEAR")],
  })), /finite/i);
  const mismatched = attribution("BTC");
  const malformed = {
    ...mismatched,
    policySuppressedCohorts: [{
      ...mismatched.policySuppressedCohorts[0]!,
      metrics: { ...mismatched.policySuppressedCohorts[0]!.metrics, value: "ADD_HIGH_ALIGNMENT" },
    }],
  };
  assert.throws(() => classifyAddHoldoutHypotheses(input({
    attributions: [malformed, attribution("ETH")],
  })), /policy-suppressed cohort candidate/i);
});

function input(overrides: {
  attributions?: readonly AddLossAttributionResult[];
  btcAttribution?: AddLossAttributionResult;
  ethAttribution?: AddLossAttributionResult;
  evaluations?: readonly AddPolicyCandidateEvaluationResult[];
} = {}): AddHoldoutHypothesisInput {
  return {
    attributions: overrides.attributions ?? [
      overrides.btcAttribution ?? attribution("BTC"),
      overrides.ethAttribution ?? attribution("ETH"),
    ],
    candidateEvaluations: overrides.evaluations ?? [
      evaluation("BTC", "ADD_RISK_CLEAR", { supportInsufficient: true }),
      evaluation("ETH", "ADD_RISK_CLEAR", { supportInsufficient: true }),
    ],
  };
}

function attribution(
  asset: "BTC" | "ETH",
  policyId: AddPolicyCandidate = "ADD_RISK_CLEAR",
  overrides: { net?: number; completeness?: "COMPLETE" | "PARTIAL" | "UNKNOWN" } = {},
): AddLossAttributionResult {
  const completeness = overrides.completeness ?? "COMPLETE";
  const net = overrides.net ?? -100;
  return {
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    analysisKind: "ADD_LOSS_ATTRIBUTION",
    causalClaim: false,
    asset,
    market: asset === "BTC" ? "KRW-BTC" : "KRW-ETH",
    contributionUnit: "EXECUTED_ADD_FILL",
    contributions: [],
    aggregate: cohort("ALL", completeness, net),
    cohorts: { byRegime: [], byAtrShock: [], byWeakeningStage: [], byTrendAlignmentScore: [], byAddOrdinal: [] },
    policySuppressedCohorts: [{ policyId, suppressionEvidenceIds: [`${asset}-${policyId}-suppression`], metrics: cohort(policyId, completeness, net) }],
  };
}

function cohort(value: string, completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN", net: number) {
  const known = completeness === "COMPLETE";
  return {
    dimension: "POLICY_SUPPRESSED" as const,
    value,
    executedAddCount: 1,
    fullyRealizedAddCount: 1,
    partiallyRealizedAddCount: 0,
    unrealizedAddCount: 0,
    unavailableLifecycleAddCount: 0,
    knownGrossContributionCount: 1,
    knownNetContributionCount: known ? 1 : 0,
    positiveNetContributionCount: known && net > 0 ? 1 : 0,
    negativeNetContributionCount: known && net < 0 ? 1 : 0,
    breakevenNetContributionCount: known && net === 0 ? 1 : 0,
    grossRealizedContributionKrw: aggregateMetric("COMPLETE", net + 8),
    confirmedFeeImpactKrw: aggregateMetric(completeness, 8),
    netRealizedContributionKrw: aggregateMetric(completeness, net),
    meanKnownGrossContributionKrw: aggregateMetric("COMPLETE", net + 8),
    meanKnownNetContributionKrw: aggregateMetric(completeness, net),
    realizedQuantity: { completeness: "COMPLETE" as const, knownCount: 1, unknownCount: 0, knownSubtotal: { status: "KNOWN" as const, value: 1 }, total: { status: "KNOWN" as const, value: 1 } },
    remainingQuantity: { completeness: "COMPLETE" as const, knownCount: 1, unknownCount: 0, knownSubtotal: { status: "KNOWN" as const, value: 0 }, total: { status: "KNOWN" as const, value: 0 } },
    maeKrw: { knownCount: 0, mean: null, min: null, max: null },
    mfeKrw: { knownCount: 0, mean: null, min: null, max: null },
    evidenceIds: [value],
    evidence: [],
  };
}

function aggregateMetric(completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN", value: number) {
  const known = completeness === "COMPLETE";
  return {
    completeness,
    knownCount: known ? 1 : 0,
    unknownCount: known ? 0 : 1,
    knownSubtotal: known ? { status: "KNOWN" as const, value } : { status: "UNKNOWN" as const, reasons: ["TEST"] },
    total: known ? { status: "KNOWN" as const, value } : { status: "UNKNOWN" as const, reasons: ["TEST"] },
  };
}

function evaluation(
  asset: "BTC" | "ETH",
  candidate: AddPolicyCandidate,
  overrides: {
    supportInsufficient?: boolean;
    failPerformance?: boolean;
    nonFinite?: boolean;
    missingStressCell?: boolean;
    missingWindow?: boolean;
    emptyComparisons?: boolean;
    incompleteCoverage?: boolean;
  } = {},
): AddPolicyCandidateEvaluationResult {
  const supportInsufficient = overrides.supportInsufficient ?? false;
  const failPerformance = overrides.failPerformance ?? false;
  const value = overrides.nonFinite ? Number.NaN : 1;
  return {
    evidenceKind: "SIMULATED_CONDITIONAL_ADD_POLICY_EVALUATION",
    asset,
    candidate,
    status: supportInsufficient ? "INSUFFICIENT" : failPerformance ? "REJECTED" : "ELIGIBLE_FOR_FURTHER_RESEARCH",
    periodSemantics: "[from,to)",
    costAnchors: { BASE: { costScenarioId: "base", feeRate: 0.0005, slippageRate: 0.001 }, STRESS: { costScenarioId: "stress", feeRate: 0.001, slippageRate: 0.002 } },
    thresholds: { minimumFullPathReturnDeltaPercentagePoints: 0, minimumBaseWindowReturnDeltaPercentagePoints: 0, minimumPositiveStressWindowCount: 2, requiredStressWindowCount: 3, minimumStressWindowReturnDeltaPercentagePoints: -0.5, maximumFullPathDrawdownDeltaPercentagePoints: 0, maximumStressWindowDrawdownDeltaPercentagePoints: 1, minimumFullPathPolicyExposedCompletedEpisodes: 30, minimumWindowPolicyExposedCompletedEpisodes: 10 },
    observations: { fullPath: { coverage: coverage(overrides.incompleteCoverage), policyExposedCompletedEpisodeCount: supportInsufficient ? 2 : 40, observations: observations(value, candidate, overrides.missingStressCell) }, windows: ["W1", "W2", "W3"].filter((id) => !overrides.missingWindow || id !== "W3").map((id) => ({ id, from: "2026-01-01T00:00:00Z", to: "2026-02-01T00:00:00Z", coverage: coverage(overrides.incompleteCoverage), policyExposedCompletedEpisodeCount: supportInsufficient ? 1 : 12, observations: observations(value, candidate, overrides.missingStressCell) })) },
    anchorComparisons: {
      fullPath: overrides.emptyComparisons ? [] : anchorComparisons(value),
      windows: ["W1", "W2", "W3"].filter((id) => !overrides.missingWindow || id !== "W3").map((windowId) => ({ windowId, evaluable: true, comparisons: overrides.emptyComparisons ? [] : anchorComparisons(value) })),
    },
    gates: {
      fullPathNetReturn: { status: failPerformance ? "FAIL" : "PASS", comparisons: overrides.emptyComparisons ? [] : returnComparisons(value) },
      baseWindowReturn: { status: "PASS", observations: overrides.emptyComparisons ? [] : windowReturnObservations(value) },
      stressWindowReturn: { status: "PASS", requiredPositiveWindowCount: 2, positiveWindowCount: 2, observations: overrides.emptyComparisons ? [] : stressWindowReturnObservations(value) },
      fullPathMaxDrawdown: { status: "PASS", observations: overrides.emptyComparisons ? [] : drawdownObservations(value) },
      stressWindowMaxDrawdown: { status: "PASS", observations: overrides.emptyComparisons ? [] : stressDrawdownObservations(value) },
      policyExposedCompletedEpisodes: { status: supportInsufficient ? "INSUFFICIENT" : "PASS", fullPathObservedCount: supportInsufficient ? 2 : 40, fullPathRequiredCount: 30, windows: ["W1", "W2", "W3"].map((windowId) => ({ windowId, evaluable: true, observedCount: supportInsufficient ? 1 : 12, requiredCount: 10, passed: supportInsufficient ? false : true })) },
      frameCoverage: { status: "PASS", fullPath: { ...coverage(overrides.incompleteCoverage), passed: !overrides.incompleteCoverage }, windows: ["W1", "W2", "W3"].filter((id) => !overrides.missingWindow || id !== "W3").map((windowId) => ({ ...coverage(overrides.incompleteCoverage), windowId, passed: !overrides.incompleteCoverage })) },
    },
    statisticalSignificanceClaim: false,
  };
}

function coverage(incomplete = false) {
  return { status: incomplete ? "INCOMPLETE" as const : "COMPLETE" as const, windowCadenceStatus: incomplete ? "INCOMPLETE" as const : "COMPLETE" as const, windowSequenceContinuityStatus: "COMPLETE" as const, windowClockGridStatus: "DENSE" as const, upstreamStateContinuityStatus: "COMPLETE" as const, featureLookbackContinuityStatus: "COMPLETE" as const, expectedFrameIntervalMs: 3_600_000, firstExpectedFrameAt: "2026-01-01T00:00:00Z", endExclusiveAt: "2026-02-01T00:00:00Z", expectedFrameCount: 10, observedFrameCount: incomplete ? 9 : 10, noTradeFrameCount: 0, noTradeRanges: [], missingFrameCount: incomplete ? 1 : 0, duplicateFrameCount: 0, offGridFrameCount: 0, missingRanges: [], duplicateInstants: [], offGridInstants: [], upstreamExpectedFrameCount: 10, upstreamObservedFrameCount: 10, upstreamSequenceContinuityStatus: "COMPLETE" as const, upstreamClockGridStatus: "DENSE" as const, upstreamNoTradeFrameCount: 0, upstreamNoTradeRanges: [], upstreamFirstExpectedFrameAt: null, upstreamEndExclusiveAt: null, upstreamMissingFrameCount: 0, upstreamDuplicateFrameCount: 0, upstreamOffGridFrameCount: 0, upstreamMissingRanges: [], upstreamDuplicateInstants: [], upstreamOffGridInstants: [], featureLookbackAffectedFrameCount: 0, featureLookbackAffectedRanges: [] };
}

function observations(value: number, candidate: AddPolicyCandidate, missingStressCell = false) {
  return (["BASE", "STRESS"] as const).flatMap((costRole) => (["BASELINE", "NO_ADD", candidate] as const).map((scenario) => ({ scenario, costRole, costScenarioId: costRole === "BASE" ? "base" : "stress", feeRate: costRole === "BASE" ? 0.0005 : 0.001, slippageRate: costRole === "BASE" ? 0.001 : 0.002, totalReturnPct: value, maxDrawdownPct: 1 })))
    .filter((item) => !missingStressCell || item.costRole !== "STRESS" || item.scenario !== candidate);
}

function anchorComparisons(value: number) {
  return (["BASE", "STRESS"] as const).flatMap((costRole) => (["BASELINE", "NO_ADD"] as const).map((anchor) => ({ costRole, anchor, candidateReturnPct: value, anchorReturnPct: value, returnDeltaPercentagePoints: 0, candidateMaxDrawdownPct: 1, anchorMaxDrawdownPct: 1, drawdownDeltaPercentagePoints: 0 })));
}

function returnComparisons(value: number) {
  return (["BASE", "STRESS"] as const).flatMap((costRole) => (["BASELINE", "NO_ADD"] as const).map((anchor) => ({ costRole, anchor, candidateReturnPct: value, anchorReturnPct: value, deltaPercentagePoints: 0, thresholdPercentagePoints: 0, operator: ">" as const, passed: true })));
}

function windowReturnObservations(value: number) {
  return ["W1", "W2", "W3"].map((windowId) => ({ windowId, candidateReturnPct: value, baselineReturnPct: value, deltaPercentagePoints: 0, thresholdPercentagePoints: 0, passed: true }));
}

function stressWindowReturnObservations(value: number) {
  return ["W1", "W2", "W3"].map((windowId) => ({ ...windowReturnObservations(value).find((item) => item.windowId === windowId)!, positive: true, floorPassed: true }));
}

function drawdownObservations(value: number) {
  return (["BASE", "STRESS"] as const).map((costRole) => ({ costRole, candidateMaxDrawdownPct: value, baselineMaxDrawdownPct: value, deltaPercentagePoints: 0, maximumDeltaPercentagePoints: 1, passed: true }));
}

function stressDrawdownObservations(value: number) {
  return ["W1", "W2", "W3"].map((windowId) => ({ windowId, candidateMaxDrawdownPct: value, baselineMaxDrawdownPct: value, deltaPercentagePoints: 0, maximumDeltaPercentagePoints: 1, passed: true }));
}

function replaceSuppressedMetrics(value: AddLossAttributionResult, mutate: (metrics: AddLossAttributionResult["policySuppressedCohorts"][number]["metrics"]) => AddLossAttributionResult["policySuppressedCohorts"][number]["metrics"]): AddLossAttributionResult {
  return { ...value, policySuppressedCohorts: [{ ...value.policySuppressedCohorts[0]!, metrics: mutate(value.policySuppressedCohorts[0]!.metrics) }] };
}

function byCandidate(result: ReturnType<typeof classifyAddHoldoutHypotheses>, candidate: AddPolicyCandidate) {
  const found = result.hypotheses.find((item) => item.candidate === candidate);
  assert.ok(found, `missing ${candidate}`);
  return found;
}
