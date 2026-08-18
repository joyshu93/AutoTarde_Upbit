import assert from "node:assert/strict";

import {
  analyzeAddLossAttribution,
  type AddLossAttributionInput,
} from "../src/modules/performance/performance-add-loss-attribution.js";
import type { AddDecisionDiagnosticsResult, AddDecisionExposure } from "../src/modules/performance/performance-add-diagnostics.js";
import type { AddPostDecisionExcursionResult } from "../src/modules/performance/performance-add-excursions.js";
import { test } from "./harness.js";

test("ADD loss attribution preserves epoch ordering, stable fill tie-breaks, and complete fee net contribution", () => {
  const result = analyzeAddLossAttribution(input({
    exposures: [
      exposure({ id: "exposure-z", generatedAt: "2026-04-20T10:00:00.000000100+09:00", fillId: "fill-z", episodeId: "episode-1", net: -120, mae: -80, mfe: 20 }),
      exposure({ id: "exposure-a", generatedAt: "2026-04-20T01:00:00.000000100Z", fillId: "fill-a", episodeId: "episode-1", net: 80, mae: -15, mfe: 100 }),
    ],
  }));

  assert.deepEqual(result.contributions.map((item) => ({ id: item.exposureId, ordinal: item.addOrdinalWithinEpisode })), [
    { id: "exposure-a", ordinal: 1 },
    { id: "exposure-z", ordinal: 2 },
  ]);
  assert.equal(result.contributions[0]?.netRealizedContributionKrw.status, "KNOWN");
  assert.equal(result.contributions[0]?.netRealizedContributionKrw.value, 80);
  assert.deepEqual(result.contributions[1]?.netRealizedContributionKrw, { status: "KNOWN", value: -120 });
  assert.deepEqual(result.cohorts.byAddOrdinal.map((item) => ({
    value: item.value,
    knownNet: item.knownNetContributionCount,
    net: item.netRealizedContributionKrw.total,
    mae: item.maeKrw,
    evidenceIds: item.evidenceIds,
  })), [
    { value: "1", knownNet: 1, net: { status: "KNOWN", value: 80 }, mae: { knownCount: 1, mean: -15, min: -15, max: -15 }, evidenceIds: ["exposure-a"] },
    { value: "2", knownNet: 1, net: { status: "KNOWN", value: -120 }, mae: { knownCount: 1, mean: -80, min: -80, max: -80 }, evidenceIds: ["exposure-z"] },
  ]);
});

test("ADD loss attribution keeps net unknown when existing fee completeness is not COMPLETE", () => {
  const result = analyzeAddLossAttribution(input({
    exposures: [exposure({
      id: "incomplete",
      net: -50,
      completeness: "FEE_EVIDENCE_INCOMPLETE",
      allocatedEntryFeeKrw: null,
      allocatedExitFeeKrw: 4,
      mae: null,
      mfe: null,
    })],
  }));

  const contribution = result.contributions[0]!;
  assert.deepEqual(contribution.netRealizedContributionKrw, {
    status: "UNKNOWN",
    reasons: ["FEE_EVIDENCE_INCOMPLETE"],
  });
  assert.deepEqual(contribution.postDecisionExcursion.maeKrw, {
    status: "UNKNOWN",
    reasons: ["MISSING_EXPECTED_HOURLY_CANDLE_COVERAGE"],
  });
  assert.equal(result.aggregate.knownNetContributionCount, 0);
  assert.equal(result.aggregate.netRealizedContributionKrw.total.status, "UNKNOWN");
  assert.equal(result.aggregate.partiallyRealizedAddCount, 1);
});

test("ADD loss attribution preserves known gross while incomplete fees keep net and aggregate totals incomplete", () => {
  const result = analyzeAddLossAttribution(input({
    exposures: [
      exposure({ id: "known", net: 20, realizedQuantity: 0.1, remainingQuantity: 0 }),
      exposure({
        id: "fee-unknown",
        net: -10,
        completeness: "FEE_EVIDENCE_INCOMPLETE",
        allocatedEntryFeeKrw: null,
        allocatedExitFeeKrw: 4,
      }),
    ],
  }));

  const incomplete = result.contributions.find((item) => item.exposureId === "fee-unknown")!;
  assert.deepEqual(incomplete.grossRealizedContributionKrw, { status: "KNOWN", value: -2 });
  assert.deepEqual(incomplete.netRealizedContributionKrw, { status: "UNKNOWN", reasons: ["FEE_EVIDENCE_INCOMPLETE"] });
  assert.deepEqual(result.aggregate.grossRealizedContributionKrw, {
    completeness: "COMPLETE",
    knownCount: 2,
    unknownCount: 0,
    knownSubtotal: { status: "KNOWN", value: 26 },
    total: { status: "KNOWN", value: 26 },
  });
  assert.deepEqual(result.aggregate.netRealizedContributionKrw, {
    completeness: "PARTIAL",
    knownCount: 1,
    unknownCount: 1,
    knownSubtotal: { status: "KNOWN", value: 20 },
    total: { status: "UNKNOWN", reasons: ["INCOMPLETE_CONTRIBUTION_EVIDENCE"] },
  });
});

test("ADD loss attribution keeps unknown quantities unavailable rather than coercing them to zero", () => {
  const unknownQuantity = exposure();
  const result = analyzeAddLossAttribution(input({
    exposures: [{
      ...unknownQuantity,
      costAndFeeImpact: {
        ...unknownQuantity.costAndFeeImpact,
        realizedQuantity: null,
        remainingQuantity: null,
      },
    }],
  }));

  assert.equal(result.contributions[0]?.lifecycleState, "UNAVAILABLE");
  assert.equal(result.aggregate.unavailableLifecycleAddCount, 1);
  assert.deepEqual(result.aggregate.realizedQuantity, {
    completeness: "UNKNOWN",
    knownCount: 0,
    unknownCount: 1,
    knownSubtotal: { status: "UNKNOWN", reasons: ["NO_KNOWN_QUANTITIES"] },
    total: { status: "UNKNOWN", reasons: ["INCOMPLETE_QUANTITY_EVIDENCE"] },
  });
});

test("ADD loss attribution retains fee and excursion provenance in contributions and cohort evidence", () => {
  const result = analyzeAddLossAttribution(input());
  const contribution = result.contributions[0]!;
  assert.deepEqual({
    allocatedEntryFeeKrw: contribution.allocatedEntryFeeKrw,
    allocatedExitFeeKrw: contribution.allocatedExitFeeKrw,
    realizationSliceIds: contribution.realizationSliceIds,
    provenance: contribution.postDecisionExcursion.provenance,
  }, {
    allocatedEntryFeeKrw: 4,
    allocatedExitFeeKrw: 4,
    realizationSliceIds: ["slice-exposure-1"],
    provenance: {
      datasetSha256: "a".repeat(64),
      source: "test",
      historyStartAt: "2026-04-20T00:00:00Z",
      endAt: "2026-04-21T00:00:00Z",
    },
  });
  assert.deepEqual(result.aggregate.evidence[0], {
    exposureId: "exposure-1",
    fillId: "fill-1",
    episodeId: "episode-1",
    realizationSliceIds: ["slice-exposure-1"],
    excursionExposureId: "exposure-1",
    datasetSha256: "a".repeat(64),
    source: "test",
    historyStartAt: "2026-04-20T00:00:00Z",
    endAt: "2026-04-21T00:00:00Z",
  });
});

test("ADD loss attribution rejects duplicate executed fill IDs and excludes non-executed rows from ordinals", () => {
  const first = exposure({ id: "first", fillId: "same-fill", generatedAt: "2026-04-20T01:00:00.000000100Z" });
  const duplicate = exposure({ id: "duplicate", fillId: "same-fill", generatedAt: "2026-04-20T02:00:00.000000100Z" });
  assert.throws(() => analyzeAddLossAttribution(input({ exposures: [first, duplicate] })), /duplicate executed ADD fill id/i);

  const notExecuted = {
    ...exposure({ id: "not-executed", fillId: "not-an-ordinal", generatedAt: "2026-04-20T00:00:00.000000100Z" }),
    pairingStatus: "BASELINE_NOT_EXECUTED" as const,
    baseline: { action: "ADD" as const, executed: false, fillId: null },
    baselineEpisode: null,
  };
  const result = analyzeAddLossAttribution(input({ exposures: [notExecuted, first] }));
  assert.deepEqual(result.contributions.map((item) => ({ id: item.exposureId, ordinal: item.addOrdinalWithinEpisode })), [
    { id: "not-executed", ordinal: null },
    { id: "first", ordinal: 1 },
  ]);
});

test("ADD loss attribution validates numeric evidence and keeps BTC and ETH results isolated", () => {
  const valid = input();
  const invalid = exposure();
  assert.throws(() => analyzeAddLossAttribution({
    ...valid,
    diagnostics: { ...valid.diagnostics, exposures: [{ ...invalid, costAndFeeImpact: { ...invalid.costAndFeeImpact, entryFeeKrw: -1 } }] },
  }), /entry fee/i);
  assert.throws(() => analyzeAddLossAttribution({
    ...valid,
    diagnostics: { ...valid.diagnostics, exposures: [{ ...invalid, costAndFeeImpact: { ...invalid.costAndFeeImpact, entryNotionalKrw: -1 } }] },
  }), /entry notional/i);
  assert.throws(() => analyzeAddLossAttribution({
    ...valid,
    diagnostics: { ...valid.diagnostics, exposures: [{ ...invalid, costAndFeeImpact: { ...invalid.costAndFeeImpact, realizedGrossPnlBeforeFeesKrw: Number.NaN } }] },
  }), /gross contribution/i);

  const eth = input({ asset: "ETH", market: "KRW-ETH", exposures: [exposure({ id: "eth", net: 55 })] });
  const ethResult = analyzeAddLossAttribution(eth);
  assert.equal(ethResult.asset, "ETH");
  assert.equal(ethResult.market, "KRW-ETH");
  assert.deepEqual(ethResult.aggregate.netRealizedContributionKrw.knownSubtotal, { status: "KNOWN", value: 55 });
});

test("ADD loss attribution emits all specified cohorts and all three supplied policy mappings", () => {
  const result = analyzeAddLossAttribution(input({
    exposures: [
      exposure({ id: "risk", generatedAt: "2026-04-20T01:00:00.000000100Z", atrShock: true, regime: "BULL_TREND", weakeningStage: "NONE", alignment: 4 }),
      exposure({ id: "weak", generatedAt: "2026-04-20T02:00:00.000000100Z", atrShock: false, regime: "RANGE", weakeningStage: "SOFT", alignment: 2 }),
    ],
    suppression: [
      { policyId: "ADD_RISK_CLEAR", suppressedDecisions: [{ generatedAt: "2026-04-20T01:00:00.000000100Z", evidenceIds: ["risk-policy"] }] },
      { policyId: "ADD_HIGH_ALIGNMENT", suppressedDecisions: [{ generatedAt: "2026-04-20T02:00:00.000000100Z", evidenceIds: ["alignment-policy"] }] },
      { policyId: "ADD_CORE_TREND", suppressedDecisions: [{ generatedAt: "2026-04-20T02:00:00.000000100Z", evidenceIds: ["core-policy"] }] },
    ],
  }));
  assert.deepEqual(result.cohorts.byRegime.map((item) => item.value), ["BULL_TREND", "RANGE"]);
  assert.deepEqual(result.cohorts.byWeakeningStage.map((item) => item.value), ["NONE", "SOFT"]);
  assert.deepEqual(result.cohorts.byTrendAlignmentScore.map((item) => item.value), ["2", "4"]);
  assert.deepEqual(result.policySuppressedCohorts.map((item) => item.policyId), [
    "ADD_CORE_TREND",
    "ADD_HIGH_ALIGNMENT",
    "ADD_RISK_CLEAR",
  ]);
});

test("ADD loss attribution aggregates only caller-provided policy suppression evidence", () => {
  const result = analyzeAddLossAttribution(input({
    exposures: [
      exposure({ id: "risk", generatedAt: "2026-04-20T01:00:00.000000100Z", net: -100, atrShock: true, regime: "BULL_TREND", alignment: 4, weakeningStage: "NONE" }),
      exposure({ id: "alignment", generatedAt: "2026-04-20T02:00:00.000000100Z", net: 40, atrShock: false, regime: "RANGE", alignment: 2, weakeningStage: "SOFT" }),
    ],
    suppression: [{
      policyId: "ADD_RISK_CLEAR",
      suppressedDecisions: [{ generatedAt: "2026-04-20T10:00:00.000000100+09:00", evidenceIds: ["candidate-risk-frame"] }],
    }],
  }));

  assert.deepEqual(result.policySuppressedCohorts.map((item) => ({
    policyId: item.policyId,
    suppressionEvidenceIds: item.suppressionEvidenceIds,
    count: item.metrics.executedAddCount,
    total: item.metrics.netRealizedContributionKrw.total,
    evidenceIds: item.metrics.evidenceIds,
  })), [{
    policyId: "ADD_RISK_CLEAR",
    suppressionEvidenceIds: ["candidate-risk-frame"],
    count: 1,
    total: { status: "KNOWN", value: -100 },
    evidenceIds: ["risk"],
  }]);
  assert.deepEqual(result.cohorts.byAtrShock.map((item) => ({
    value: item.value,
    total: item.netRealizedContributionKrw.total,
    evidenceIds: item.evidenceIds,
  })), [
    { value: "false", total: { status: "KNOWN", value: 40 }, evidenceIds: ["alignment"] },
    { value: "true", total: { status: "KNOWN", value: -100 }, evidenceIds: ["risk"] },
  ]);
});

test("ADD loss attribution marks an empty configured suppression cohort as unobserved", () => {
  const result = analyzeAddLossAttribution(input({
    suppression: [{ policyId: "ADD_RISK_CLEAR", suppressedDecisions: [] }],
  }));
  const cohort = result.policySuppressedCohorts[0]!;

  assert.equal(cohort.metrics.executedAddCount, 0);
  assert.equal(cohort.metrics.netRealizedContributionKrw.completeness, "UNKNOWN");
  assert.deepEqual(cohort.metrics.netRealizedContributionKrw.total, {
    status: "UNKNOWN",
    reasons: ["NO_KNOWN_CONTRIBUTIONS"],
  });
});

test("ADD loss attribution rejects blank suppression provenance and orders equivalent evidence deterministically", () => {
  assert.throws(() => analyzeAddLossAttribution(input({
    suppression: [{
      policyId: "ADD_RISK_CLEAR",
      suppressedDecisions: [{ generatedAt: "2026-04-20T01:00:00.000000100Z", evidenceIds: [" "] }],
    }],
  })), /suppression evidence id/i);

  const exposures = [
    exposure({ id: "later", generatedAt: "2026-04-20T02:00:00.000000100Z", net: 20 }),
    exposure({ id: "earlier", generatedAt: "2026-04-20T01:00:00.000000100Z", net: -10 }),
  ];
  const decisions = [
    { generatedAt: "2026-04-20T02:00:00.000000100Z", evidenceIds: ["z"] },
    { generatedAt: "2026-04-20T01:00:00.000000100Z", evidenceIds: ["a"] },
  ];
  const reversed = analyzeAddLossAttribution(input({
    exposures,
    suppression: [{ policyId: "ADD_RISK_CLEAR", suppressedDecisions: decisions }],
  }));
  const ordered = analyzeAddLossAttribution(input({
    exposures,
    suppression: [{ policyId: "ADD_RISK_CLEAR", suppressedDecisions: [...decisions].reverse() }],
  }));

  assert.deepEqual(reversed.policySuppressedCohorts, ordered.policySuppressedCohorts);
});

test("ADD loss attribution keeps fully realized, partial, unrealized, and breakeven ADD units distinct", () => {
  const result = analyzeAddLossAttribution(input({
    exposures: [
      exposure({ id: "full", net: 20, realizedQuantity: 0.1, remainingQuantity: 0 }),
      exposure({ id: "partial", net: -10, realizedQuantity: 0.04, remainingQuantity: 0.06 }),
      exposure({ id: "open", realizedQuantity: 0, remainingQuantity: 0.1, completeness: "NOT_AVAILABLE", mae: null, mfe: null }),
      exposure({ id: "flat", net: 0, realizedQuantity: 0.1, remainingQuantity: 0 }),
    ],
  }));

  assert.deepEqual({
    executed: result.aggregate.executedAddCount,
    fully: result.aggregate.fullyRealizedAddCount,
    partial: result.aggregate.partiallyRealizedAddCount,
    unrealized: result.aggregate.unrealizedAddCount,
    knownNet: result.aggregate.knownNetContributionCount,
    positive: result.aggregate.positiveNetContributionCount,
    negative: result.aggregate.negativeNetContributionCount,
    breakeven: result.aggregate.breakevenNetContributionCount,
    net: result.aggregate.netRealizedContributionKrw,
  }, {
    executed: 4,
    fully: 2,
    partial: 1,
    unrealized: 1,
    knownNet: 3,
    positive: 1,
    negative: 1,
    breakeven: 1,
    net: {
      completeness: "PARTIAL",
      knownCount: 3,
      unknownCount: 1,
      knownSubtotal: { status: "KNOWN", value: 10 },
      total: { status: "UNKNOWN", reasons: ["INCOMPLETE_CONTRIBUTION_EVIDENCE"] },
    },
  });
  assert.deepEqual(result.aggregate.maeKrw, { knownCount: 3, mean: -25, min: -25, max: -25 });
});

test("ADD loss attribution rejects unsafe timestamp, lifecycle, market, quantity, and excursion evidence", () => {
  const valid = input();
  assert.throws(
    () => analyzeAddLossAttribution({ ...valid, diagnostics: { ...valid.diagnostics, exposures: [exposure({ generatedAt: "2026-04-20T01:00:00" })] } }),
    /explicit timezone/i,
  );
  assert.throws(
    () => analyzeAddLossAttribution({ ...valid, diagnostics: { ...valid.diagnostics, exposures: [exposure(), exposure()] } }),
    /duplicate ADD exposure id/i,
  );
  assert.throws(
    () => analyzeAddLossAttribution({ ...valid, diagnostics: { ...valid.diagnostics, market: "KRW-ETH" } }),
    /market/i,
  );
  assert.throws(
    () => analyzeAddLossAttribution({ ...valid, diagnostics: { ...valid.diagnostics, exposures: [exposure({ realizedQuantity: -0.01 })] } }),
    /realized quantity/i,
  );
  assert.throws(
    () => analyzeAddLossAttribution({ ...valid, excursions: { ...valid.excursions, exposures: [] } }),
    /missing excursion evidence/i,
  );
  assert.throws(
    () => analyzeAddLossAttribution({
      ...valid,
      excursions: {
        ...valid.excursions,
        exposures: [...valid.excursions.exposures, { ...valid.excursions.exposures[0]!, exposureId: "unexpected" }],
      },
    }),
    /does not match a diagnostics exposure/i,
  );
  assert.throws(
    () => analyzeAddLossAttribution({ ...valid, policySuppressionEvidence: [{ policyId: "ADD_RISK_CLEAR", suppressedDecisions: [{ generatedAt: "2026-04-20T03:00:00Z", evidenceIds: ["unmatched"] }] }] }),
    /does not match an ADD exposure/i,
  );
  assert.throws(
    () => {
      const inconsistent = exposure({ net: 10, allocatedEntryFeeKrw: 5, allocatedExitFeeKrw: 5 });
      return analyzeAddLossAttribution({
        ...valid,
        diagnostics: {
          ...valid.diagnostics,
          exposures: [{
            ...inconsistent,
            costAndFeeImpact: { ...inconsistent.costAndFeeImpact, realizedFeeImpactKrw: 10 },
          }],
        },
      });
    },
    /net contribution contradicts gross and fees/i,
  );
  assert.throws(
    () => analyzeAddLossAttribution({ ...valid, diagnostics: { ...valid.diagnostics, exposures: [{ ...exposure(), costAndFeeImpact: { ...exposure().costAndFeeImpact, realizationSliceIds: [] } }] } }),
    /requires realization slice evidence/i,
  );
});

function input(overrides: {
  asset?: "BTC" | "ETH";
  market?: "KRW-BTC" | "KRW-ETH";
  exposures?: readonly FixtureExposure[];
  suppression?: AddLossAttributionInput["policySuppressionEvidence"];
} = {}): AddLossAttributionInput {
  const exposures = overrides.exposures ?? [exposure()];
  const asset = overrides.asset ?? "BTC";
  const market = overrides.market ?? "KRW-BTC";
  return {
    asset,
    market,
    breakevenToleranceKrw: 0,
    diagnostics: diagnostics(exposures, asset, market),
    excursions: excursions(exposures, asset, market),
    policySuppressionEvidence: overrides.suppression ?? [],
  };
}

type FixtureExposure = AddDecisionExposure & {
  excursion: { mae: number | null; mfe: number | null };
};

function exposure(overrides: {
  id?: string;
  generatedAt?: string;
  fillId?: string;
  episodeId?: string;
  net?: number;
  completeness?: "COMPLETE" | "FEE_EVIDENCE_INCOMPLETE" | "NOT_AVAILABLE";
  realizedQuantity?: number;
  remainingQuantity?: number;
  allocatedEntryFeeKrw?: number | null;
  allocatedExitFeeKrw?: number | null;
  mae?: number | null;
  mfe?: number | null;
  atrShock?: boolean;
  regime?: "BULL_TREND" | "RANGE";
  alignment?: number;
  weakeningStage?: "NONE" | "SOFT";
} = {}): FixtureExposure {
  const id = overrides.id ?? "exposure-1";
  const fillId = overrides.fillId ?? (id === "exposure-1" ? "fill-1" : `fill-${id}`);
  const episodeId = overrides.episodeId ?? "episode-1";
  const net = overrides.net ?? -100;
  const realizedQuantity = overrides.realizedQuantity ?? 0.08;
  const remainingQuantity = overrides.remainingQuantity ?? 0.02;
  const completeness = overrides.completeness ?? "COMPLETE";
  return {
    id,
    generatedAt: overrides.generatedAt ?? "2026-04-20T01:00:00.000000100Z",
    baselineGeneratedAt: overrides.generatedAt ?? "2026-04-20T01:00:00.000000100Z",
    pairingStatus: "EXECUTED_VS_SUPPRESSED" as const,
    originalEvidence: {
      action: "ADD" as const,
      regime: overrides.regime ?? "BULL_TREND",
      atrShock: overrides.atrShock ?? false,
      trendAlignmentScore: overrides.alignment ?? 4,
      weakeningStage: overrides.weakeningStage ?? "NONE",
    },
    baseline: { action: "ADD" as const, executed: true, fillId },
    baselineEpisode: { episodeId, status: "OPEN" as const, outcome: "UNKNOWN" as const, netRealizedPnlKrw: null },
    postDecisionExcursion: { status: "UNKNOWN" as const, reason: "SEE_POST_DECISION_EXCURSION_ANALYSIS" as const },
    costAndFeeImpact: {
      status: completeness === "COMPLETE" ? "AVAILABLE" as const : "UNKNOWN" as const,
      completeness,
      reason: completeness === "COMPLETE" ? null : "FEE_EVIDENCE_INCOMPLETE" as const,
      entryNotionalKrw: 10_000,
      entryFeeKrw: completeness === "COMPLETE" ? 5 : null,
      realizedQuantity,
      remainingQuantity,
      realizedGrossPnlBeforeFeesKrw: net + 8,
      allocatedEntryFeeKrw: overrides.allocatedEntryFeeKrw ?? (completeness === "COMPLETE" ? 4 : null),
      allocatedExitFeeKrw: overrides.allocatedExitFeeKrw ?? (completeness === "COMPLETE" ? 4 : null),
      realizedFeeImpactKrw: completeness === "COMPLETE" ? 8 : null,
      realizedNetPnlKrw: net,
      realizationSliceIds: ["slice-" + id],
    },
    excursion: {
      mae: overrides.mae === undefined ? -25 : overrides.mae,
      mfe: overrides.mfe === undefined ? 50 : overrides.mfe,
    },
  };
}

function diagnostics(items: readonly FixtureExposure[], asset: "BTC" | "ETH", market: "KRW-BTC" | "KRW-ETH"): AddDecisionDiagnosticsResult {
  return {
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    analysisKind: "ADD_DECISION_EXPOSURE",
    causalClaim: false,
    asset,
    market,
    exposures: items.map(({ excursion: _excursion, ...item }) => item),
    aggregate: {
      unit: "DISTINCT_COMPLETED_POSITION_EPISODE",
      exposureCount: items.length,
      pairingCounts: { EXECUTED_VS_SUPPRESSED: items.length, BASELINE_NOT_EXECUTED: 0, PATH_DECISION_DIVERGED: 0 },
      distinctCompletedEpisodeCount: 0,
      completedEpisodeOutcomes: { wins: 0, losses: 0, breakeven: 0, unknown: 0 },
    },
    warnings: [],
  };
}

function excursions(items: readonly FixtureExposure[], asset: "BTC" | "ETH", market: "KRW-BTC" | "KRW-ETH"): AddPostDecisionExcursionResult {
  return {
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    analysisKind: "ADD_POST_DECISION_EXCURSION",
    causalClaim: false,
    asset,
    market,
    timeframe: "1h",
    exposures: items.map((item) => ({
      exposureId: item.id,
      status: item.excursion.mae === null || item.excursion.mfe === null ? "UNKNOWN" as const : "KNOWN" as const,
      reason: item.excursion.mae === null || item.excursion.mfe === null ? "MISSING_EXPECTED_HOURLY_CANDLE_COVERAGE" as const : null,
      maeKrw: item.excursion.mae === null ? { status: "UNKNOWN" as const, reasons: ["MISSING_EXPECTED_HOURLY_CANDLE_COVERAGE"] } : { status: "KNOWN" as const, value: item.excursion.mae },
      mfeKrw: item.excursion.mfe === null ? { status: "UNKNOWN" as const, reasons: ["MISSING_EXPECTED_HOURLY_CANDLE_COVERAGE"] } : { status: "KNOWN" as const, value: item.excursion.mfe },
      maePct: { status: "NOT_APPLICABLE" as const, reason: "TEST" },
      mfePct: { status: "NOT_APPLICABLE" as const, reason: "TEST" },
      coverage: null,
      evidence: { decisionAt: item.generatedAt, baselineFillId: item.baseline.fillId, episodeId: item.baselineEpisode?.episodeId ?? null, episodeClosedAt: null, candleIntervals: [] },
      provenance: { datasetSha256: "a".repeat(64), source: "test", historyStartAt: "2026-04-20T00:00:00Z", endAt: "2026-04-21T00:00:00Z" },
      warnings: ["INTRABAR_ORDER_NOT_INFERRED"] as const,
    })),
  };
}

function cohort(
  dimension: string,
  value: string,
  executedAddCount: number,
  net: number,
  exposureIds: readonly string[],
) {
  return {
    dimension,
    value,
    executedAddCount,
    fullyRealizedAddCount: 0,
    partiallyRealizedAddCount: executedAddCount,
    unrealizedAddCount: 0,
    knownGrossContributionCount: executedAddCount,
    knownNetContributionCount: executedAddCount,
    positiveNetContributionCount: net > 0 ? executedAddCount : 0,
    negativeNetContributionCount: net < 0 ? executedAddCount : 0,
    breakevenNetContributionCount: net === 0 ? executedAddCount : 0,
    grossRealizedContributionKrw: { status: "KNOWN", value: net + executedAddCount * 8 },
    confirmedFeeImpactKrw: { status: "KNOWN", value: executedAddCount * 8 },
    netRealizedContributionKrw: { status: "KNOWN", value: net },
    meanKnownGrossContributionKrw: { status: "KNOWN", value: net / executedAddCount + 8 },
    meanKnownNetContributionKrw: { status: "KNOWN", value: net / executedAddCount },
    realizedQuantity: executedAddCount * 0.08,
    remainingQuantity: executedAddCount * 0.02,
    maeKrw: { knownCount: executedAddCount, mean: -25, min: -25, max: -25 },
    mfeKrw: { knownCount: executedAddCount, mean: 50, min: 50, max: 50 },
    evidenceIds: exposureIds,
  };
}
