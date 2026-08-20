import assert from "node:assert/strict";

import {
  evaluatePerformanceComponentAblation,
  type PerformanceComponentAblationCell,
  type PerformanceComponentAblationInput,
} from "../src/modules/performance/performance-component-ablation.js";
import type {
  HoldoutEpisodeAttributionCounts,
  HoldoutEpisodeEnvelope,
  HoldoutEpisodeRelationship,
  HoldoutEpisodeRelationshipKind,
} from "../src/modules/performance/performance-holdout-episode-attribution.js";
import { test } from "./harness.js";

const COMPONENTS = [
  "COMBINED_MINUS_HTF_TREND_GATE",
  "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  "COMBINED_MINUS_ADD_LIMITED",
  "COMBINED_MINUS_COOLDOWN_CONTROL",
] as const;
const COVERAGE_KEYS = [
  "cadenceComplete",
  "featureCoverageComplete",
  "carryInStateComplete",
  "referenceLifecycleComplete",
  "ablationLifecycleComplete",
  "referenceFeeComplete",
  "ablationFeeComplete",
  "referenceFiniteMetricsComplete",
  "ablationFiniteMetricsComplete",
] as const;

type TestPathCoverage = Record<(typeof COVERAGE_KEYS)[number], boolean>;
type ExpectedDeltaEvidence = {
  coverage: TestPathCoverage;
  episodeAttribution: ReturnType<typeof attributionOf>;
};

test("classifies all five component-ablation outcomes and preserves non-approval flags", () => {
  const noDifference = evaluatePerformanceComponentAblation(input());
  assert.deepEqual(noDifference.assets.map((asset) => asset.asset), ["BTC", "ETH"]);
  assert.ok(noDifference.assets.every((asset) => asset.components.every((component) =>
    component.classification === "NO_MEASURABLE_DIFFERENCE")));
  assert.equal(noDifference.readOnly, true);
  assert.equal(noDifference.causalClaim, false);
  assert.equal(noDifference.deploymentApproval, false);
  assert.equal(noDifference.prospectiveApproval, false);
  assert.match(noDifference.interpretationBoundary, /cannot authorize shadow or LIVE/i);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(noDifference)));

  const harm = input();
  changeAllCells(harm, "COMBINED_MINUS_HTF_TREND_GATE", { netReturnPct: 0.01 });
  assert.equal(component(evaluatePerformanceComponentAblation(harm), "BTC", "COMBINED_MINUS_HTF_TREND_GATE").classification, "HARM_ASSOCIATION");

  const protective = input();
  changeAllCells(protective, "COMBINED_MINUS_EARLY_THESIS_FAILURE", { netReturnPct: -0.01 });
  assert.equal(component(evaluatePerformanceComponentAblation(protective), "ETH", "COMBINED_MINUS_EARLY_THESIS_FAILURE").classification, "PROTECTIVE_ASSOCIATION");

  const mixed = input();
  changeCell(mixed, "BTC", "COMBINED_MINUS_ADD_LIMITED", "SAME_CLOSE_MODELED", "BASE", { netReturnPct: 0.01 });
  changeCell(mixed, "BTC", "COMBINED_MINUS_ADD_LIMITED", "SAME_CLOSE_MODELED", "STRESS", { netReturnPct: -0.01 });
  assert.equal(component(evaluatePerformanceComponentAblation(mixed), "BTC", "COMBINED_MINUS_ADD_LIMITED").classification, "MIXED_ASSOCIATION");

  const insufficient = input();
  setEvidence(insufficient.assets[0]!.cells[0]!, "PATH_DIVERGED");
  assert.equal(component(evaluatePerformanceComponentAblation(insufficient), "BTC", "COMBINED_MINUS_HTF_TREND_GATE").classification, "INSUFFICIENT_EVIDENCE");
});

test("uses exact frozen tolerances and exact completed-episode-count deltas", () => {
  const within = input();
  changeAllCells(within, "COMBINED_MINUS_HTF_TREND_GATE", {
    netReturnPct: 0.00000001,
    maxDrawdownPct: 0.00000001,
    turnoverKrw: 0.000000001,
    feesKrw: 0.000000001,
  });
  assert.equal(component(evaluatePerformanceComponentAblation(within), "BTC", "COMBINED_MINUS_HTF_TREND_GATE").classification, "NO_MEASURABLE_DIFFERENCE");

  const over = input();
  changeAllCells(over, "COMBINED_MINUS_HTF_TREND_GATE", { netReturnPct: 0.00000002 });
  assert.equal(component(evaluatePerformanceComponentAblation(over), "BTC", "COMBINED_MINUS_HTF_TREND_GATE").classification, "HARM_ASSOCIATION");

  const count = input();
  changeAllCells(count, "COMBINED_MINUS_HTF_TREND_GATE", { completedEpisodeCount: 1 });
  assert.equal(component(evaluatePerformanceComponentAblation(count), "BTC", "COMBINED_MINUS_HTF_TREND_GATE").classification, "MIXED_ASSOCIATION");
});

test("treats incomplete lifecycle, fee, carry-in, open, unknown, and support evidence as insufficient", () => {
  const cases: Array<[string, (value: PerformanceComponentAblationInput) => void]> = [
    ["lifecycle", (value) => { value.assets[0]!.cells[0]!.attribution.warnings = ["lifecycle incomplete"]; }],
    ["fee", (value) => { value.assets[0]!.cells[0]!.attribution.warnings = ["fee incomplete"]; }],
    ["carry-in", (value) => { setEvidence(value.assets[0]!.cells[0]!, "CARRY_IN"); }],
    ["open", (value) => { setEvidence(value.assets[0]!.cells[0]!, "OPEN_AT_TO"); }],
    ["unknown", (value) => { setEvidence(value.assets[0]!.cells[0]!, "NET_OUTCOME_UNKNOWN"); }],
    ["path-diverged", (value) => { setEvidence(value.assets[0]!.cells[0]!, "PATH_DIVERGED"); }],
    ["support", (value) => { value.assets[0]!.cells[0]!.reference.completedEpisodeCount = 9; }],
    ["comparison", (value) => { setEvidence(value.assets[0]!.cells[0]!, "EXACT_ENTRY_MATCH", false); }],
  ];
  for (const [name, mutate] of cases) {
    const value = input();
    mutate(value);
    assert.equal(component(evaluatePerformanceComponentAblation(value), "BTC", "COMBINED_MINUS_HTF_TREND_GATE").classification, "INSUFFICIENT_EVIDENCE", name);
  }
});

test("retains complete deterministic JSON-safe episode attribution without input aliasing", () => {
  const value = input();
  const sourceCell = value.assets[0]!.cells[0]!;
  const sourceAttribution = sourceCell.attribution;
  const sourceCoverage = coverageOf(sourceCell);

  const result = evaluatePerformanceComponentAblation(value);
  const delta = component(result, "BTC", "COMBINED_MINUS_HTF_TREND_GATE").deltas[0]! as unknown as
    ExpectedDeltaEvidence & Record<string, unknown>;

  assert.deepEqual(delta.episodeAttribution, sourceAttribution);
  assert.notStrictEqual(delta.episodeAttribution, sourceAttribution);
  assert.notStrictEqual(delta.episodeAttribution.relationships, sourceAttribution.relationships);
  assert.notStrictEqual(delta.episodeAttribution.relationships[0]!.reference, sourceAttribution.relationships[0]!.reference);
  assert.deepEqual(delta.coverage, sourceCoverage);
  assert.notStrictEqual(delta.coverage, sourceCoverage);
  assert.doesNotThrow(() => JSON.stringify(delta.episodeAttribution));

  const frozenEvidence = JSON.stringify(delta.episodeAttribution);
  sourceAttribution.warnings = ["mutated after evaluation"];
  sourceAttribution.relationships[0]!.reference!.episodeId = "mutated-episode";
  sourceCoverage.cadenceComplete = false;
  assert.equal(JSON.stringify(delta.episodeAttribution), frozenEvidence);
  assert.equal(delta.coverage.cadenceComplete, true);
  assert.equal(JSON.stringify(evaluatePerformanceComponentAblation(input())), JSON.stringify(evaluatePerformanceComponentAblation(input())));
});

test("deep-freezes the complete detached result graph at multiple evidence levels", () => {
  const value = input();
  const result = evaluatePerformanceComponentAblation(value);
  const frozenJson = JSON.stringify(result);
  const asset = result.assets[0]!;
  const evaluated = asset.components[0]!;
  const delta = evaluated.deltas[0]!;

  for (const node of [
    result,
    result.assets,
    asset,
    asset.components,
    evaluated,
    evaluated.deltas,
    evaluated.warnings,
    delta,
    delta.reference,
    delta.ablation,
    delta.coverage,
    delta.episodeAttribution,
    delta.episodeAttribution.provenance,
    delta.episodeAttribution.relationships,
    delta.episodeAttribution.relationships[0],
    delta.episodeAttribution.relationships[0]!.reference,
    delta.episodeAttribution.referenceInterventions,
    delta.warnings,
    delta.provenance,
  ]) assert.equal(Object.isFrozen(node), true);

  assert.throws(() => {
    (result.assets as unknown as unknown[]).push({});
  }, TypeError);
  assert.throws(() => {
    (evaluated as { classification: string }).classification = "MUTATED";
  }, TypeError);
  assert.throws(() => {
    (delta.reference as { netReturnPct: number }).netReturnPct = 999;
  }, TypeError);
  assert.throws(() => {
    (delta.episodeAttribution.relationships[0]!.reference as { openedQuantity: number }).openedQuantity = 999;
  }, TypeError);
  assert.throws(() => {
    (delta.provenance as { datasetFingerprint: string }).datasetFingerprint = "mutated";
  }, TypeError);

  value.assets[0]!.cells[0]!.reference.netReturnPct = 999;
  value.assets[0]!.cells[0]!.attribution.relationships[0]!.reference!.episodeId = "mutated";
  assert.equal(JSON.stringify(result), frozenJson);
  assert.equal(
    JSON.stringify(evaluatePerformanceComponentAblation(input())),
    JSON.stringify(evaluatePerformanceComponentAblation(input())),
  );
});

test("canonicalizes coverage JSON independently of caller insertion order", () => {
  const canonical = input();
  const permuted = input();
  const permutedCell = permuted.assets[0]!.cells[0]! as PerformanceComponentAblationCell & {
    coverage: TestPathCoverage;
  };
  permutedCell.coverage = {
    ablationFiniteMetricsComplete: true,
    referenceFiniteMetricsComplete: true,
    ablationFeeComplete: true,
    referenceFeeComplete: true,
    ablationLifecycleComplete: true,
    referenceLifecycleComplete: true,
    carryInStateComplete: true,
    featureCoverageComplete: true,
    cadenceComplete: true,
  };

  const canonicalDelta = component(
    evaluatePerformanceComponentAblation(canonical),
    "BTC",
    "COMBINED_MINUS_HTF_TREND_GATE",
  ).deltas[0]!;
  const permutedDelta = component(
    evaluatePerformanceComponentAblation(permuted),
    "BTC",
    "COMBINED_MINUS_HTF_TREND_GATE",
  ).deltas[0]!;

  assert.equal(JSON.stringify(permutedDelta.coverage), JSON.stringify(canonicalDelta.coverage));
  assert.equal(JSON.stringify(permutedDelta), JSON.stringify(canonicalDelta));
});

test("makes every false path coverage category insufficient with stable warnings", () => {
  for (const key of COVERAGE_KEYS) {
    const value = input();
    coverageOf(value.assets[0]!.cells[0]!)[key] = false;

    const result = evaluatePerformanceComponentAblation(value);
    const evaluated = component(result, "BTC", "COMBINED_MINUS_HTF_TREND_GATE");
    const delta = evaluated.deltas[0]! as unknown as ExpectedDeltaEvidence & {
      evidenceComplete: boolean;
      warnings: readonly string[];
    };

    assert.equal(evaluated.classification, "INSUFFICIENT_EVIDENCE", key);
    assert.equal(delta.evidenceComplete, false, key);
    assert.deepEqual(delta.warnings, [`Path coverage ${key} is incomplete.`], key);
    assert.equal(delta.coverage[key], false, key);
  }
});

test("requires path coverage to have exactly nine boolean keys", () => {
  const missing = input();
  delete (coverageOf(missing.assets[0]!.cells[0]!) as Partial<TestPathCoverage>).cadenceComplete;
  assert.throws(() => evaluatePerformanceComponentAblation(missing), /coverage.*exactly.*nine/i);

  const extra = input();
  (coverageOf(extra.assets[0]!.cells[0]!) as TestPathCoverage & { unexpected: boolean }).unexpected = true;
  assert.throws(() => evaluatePerformanceComponentAblation(extra), /coverage.*exactly.*nine/i);

  const nonBoolean = input();
  (coverageOf(nonBoolean.assets[0]!.cells[0]!) as unknown as Record<string, unknown>).referenceFeeComplete = "yes";
  assert.throws(() => evaluatePerformanceComponentAblation(nonBoolean), /coverage.*referenceFeeComplete.*boolean/i);
});

test("rejects top-level attribution scenario mismatches even when relationships are empty", () => {
  const wrongReference = input();
  setEmptyEvidence(wrongReference.assets[0]!.cells[0]!);
  (wrongReference.assets[0]!.cells[0]!.attribution as unknown as { referenceScenario: string }).referenceScenario = "BASELINE";
  assert.throws(() => evaluatePerformanceComponentAblation(wrongReference), /referenceScenario.*COMBINED_CONSERVATIVE/i);

  const wrongAblation = input();
  setEmptyEvidence(wrongAblation.assets[0]!.cells[0]!);
  (wrongAblation.assets[0]!.cells[0]!.attribution as unknown as { ablationScenario: string }).ablationScenario = "COMBINED_MINUS_ADD_LIMITED";
  assert.throws(() => evaluatePerformanceComponentAblation(wrongAblation), /ablationScenario.*cell/i);
});

test("rejects relationship envelopes whose scenarios contradict top-level attribution identity", () => {
  const wrongReference = input();
  wrongReference.assets[0]!.cells[0]!.attribution.relationships[0]!.reference!.scenario = "BASELINE";
  assert.throws(() => evaluatePerformanceComponentAblation(wrongReference), /reference envelope.*scenario/i);

  const wrongAblation = input();
  wrongAblation.assets[0]!.cells[0]!.attribution.relationships[0]!.ablation!.scenario = "COMBINED_MINUS_ADD_LIMITED";
  assert.throws(() => evaluatePerformanceComponentAblation(wrongAblation), /ablation envelope.*scenario/i);
});

test("cross-checks every nested episode and intervention identity against its component cell", () => {
  const envelopeCases: Array<[string, (envelope: HoldoutEpisodeEnvelope) => void, RegExp]> = [
    ["asset", (envelope) => { envelope.asset = "ETH"; }, /reference envelope.*asset/i],
    ["market", (envelope) => { envelope.market = "KRW-ETH"; }, /reference envelope.*market/i],
    ["timing", (envelope) => { envelope.timingModel = "NEXT_FRAME_MODELED"; }, /reference envelope.*timing/i],
    ["cost", (envelope) => { envelope.costCellId = "STRESS"; }, /reference envelope.*cost/i],
  ];
  for (const [name, mutate, expected] of envelopeCases) {
    const value = input();
    mutate(value.assets[0]!.cells[0]!.attribution.relationships[0]!.reference!);
    assert.throws(() => evaluatePerformanceComponentAblation(value), expected, name);
  }

  const intervention = input();
  intervention.assets[0]!.cells[0]!.attribution.referenceInterventions = [{
    id: "intervention-reference",
    evidenceType: "RESEARCH_INTERVENTION",
    scenario: "COMBINED_CONSERVATIVE",
    asset: "ETH",
    market: "KRW-BTC",
    timingModel: "SAME_CLOSE_MODELED",
    costCellId: "BASE",
    decisionEvidenceId: "decision:reference",
    decisionGeneratedAt: "2026-07-01T00:00:00.000Z",
    decisionGeneratedAtEpochNanoseconds: "1782864000000000000",
    decisionFrameIndex: 0,
    originalAction: "ADD",
    effectiveAction: "HOLD",
    outcome: "SUPPRESS",
    reason: "EPISODE_ADD_LIMIT_REACHED",
    linkedFillId: null,
    linkedStrategyDecisionId: null,
    linkedEpisodeId: "reference-episode",
  }];
  intervention.assets[0]!.cells[0]!.attribution.relationships[0]!.reference!.interventionEvidenceIds = [
    "intervention-reference",
  ];
  assert.throws(
    () => evaluatePerformanceComponentAblation(intervention),
    /reference intervention.*asset/i,
  );
});

test("rejects every attribution count when it disagrees with relationships", () => {
  const fields: readonly (keyof HoldoutEpisodeAttributionCounts)[] = [
    "totalRelationships",
    "exactEntryMatches",
    "exitTimingChanged",
    "referenceOnlyLoss",
    "referenceOnlyGain",
    "ablationOnly",
    "pathDiverged",
    "carryIn",
    "openAtTo",
    "netOutcomeUnknown",
    "closedKnownPnlComparisons",
  ];
  for (const field of fields) {
    const value = input();
    value.assets[0]!.cells[0]!.attribution.counts[field] += 1;
    assert.throws(() => evaluatePerformanceComponentAblation(value), new RegExp(`count.*${field}`, "i"), field);
  }
});

test("preserves nanosecond holdout bounds and accepts timezone-equivalent evidence", () => {
  const value = input();
  const btc = value.assets.find((entry) => entry.asset === "BTC")!;
  setRange(
    btc,
    "2026-06-30T00:00:00.000000001Z",
    "2026-07-03T00:00:00.000000002Z",
    "2026-06-30T09:00:00.000000001+09:00",
    "2026-07-03T09:00:00.000000002+09:00",
  );

  const result = evaluatePerformanceComponentAblation(value);

  assert.equal(result.assets[0]!.holdoutFrom, "2026-06-30T00:00:00.000000001Z");
  assert.equal(result.assets[0]!.holdoutTo, "2026-07-03T00:00:00.000000002Z");
});

test("rejects a cell range mismatch that differs only below one millisecond", () => {
  const value = input();
  value.assets[0]!.cells[0]!.holdoutFrom = "2026-07-01T00:00:00.000000001Z";

  assert.throws(() => evaluatePerformanceComponentAblation(value), /cell holdout range mismatch/i);
});

test("rejects incomplete matrices, mismatched provenance, unsafe metrics, and delta overflow", () => {
  const missing = input();
  missing.assets[0]!.cells.pop();
  assert.throws(() => evaluatePerformanceComponentAblation(missing), /exactly one.*cell/i);

  const wrongAblation = input();
  wrongAblation.assets[0]!.cells[0]!.ablation.scenario = "COMBINED_MINUS_ADD_LIMITED";
  assert.throws(() => evaluatePerformanceComponentAblation(wrongAblation), /ablation/i);

  const provenance = input();
  provenance.assets[0]!.cells[0]!.attribution.provenance.datasetFingerprint = "other";
  assert.throws(() => evaluatePerformanceComponentAblation(provenance), /provenance/i);

  const nonFinite = input();
  nonFinite.assets[0]!.cells[0]!.reference.turnoverKrw = Number.NaN;
  assert.throws(() => evaluatePerformanceComponentAblation(nonFinite), /finite/i);

  const overflow = input();
  changeAllCells(overflow, "COMBINED_MINUS_HTF_TREND_GATE", { netReturnPct: Number.MAX_VALUE });
  overflow.assets[0]!.cells.filter((cell) => cell.ablation.scenario === "COMBINED_MINUS_HTF_TREND_GATE")
    .forEach((cell) => { cell.reference.netReturnPct = -Number.MAX_VALUE; });
  assert.throws(() => evaluatePerformanceComponentAblation(overflow), /delta.*finite/i);
});

test("normalizes output to frozen asset, component, timing, and cost order", () => {
  const value = input();
  value.assets.reverse();
  for (const asset of value.assets) asset.cells.reverse();
  const result = evaluatePerformanceComponentAblation(value);
  assert.deepEqual(result.assets.map((asset) => asset.asset), ["BTC", "ETH"]);
  assert.deepEqual(result.assets[0]!.components.map((entry) => entry.ablationScenario), COMPONENTS);
  assert.deepEqual(component(result, "BTC", "COMBINED_MINUS_HTF_TREND_GATE").deltas.map((entry) => [entry.timing, entry.cost]), [
    ["SAME_CLOSE_MODELED", "BASE"],
    ["SAME_CLOSE_MODELED", "STRESS"],
    ["NEXT_FRAME_MODELED", "BASE"],
    ["NEXT_FRAME_MODELED", "STRESS"],
  ]);
});

function input(): PerformanceComponentAblationInput {
  return {
    authorityId: "COMBINED_CONSERVATIVE_ABLATION_V1",
    assets: [asset("BTC", "KRW-BTC"), asset("ETH", "KRW-ETH")],
  };
}

function asset(asset: "BTC" | "ETH", market: "KRW-BTC" | "KRW-ETH") {
  return {
    asset,
    market,
    holdoutFrom: "2026-07-01T00:00:00.000Z",
    holdoutTo: "2026-07-10T00:00:00.000Z",
    cells: COMPONENTS.flatMap((ablationScenario) => [
      cell(asset, market, ablationScenario, "SAME_CLOSE_MODELED", "BASE"),
      cell(asset, market, ablationScenario, "SAME_CLOSE_MODELED", "STRESS"),
      cell(asset, market, ablationScenario, "NEXT_FRAME_MODELED", "BASE"),
      cell(asset, market, ablationScenario, "NEXT_FRAME_MODELED", "STRESS"),
    ]),
  };
}

function cell(
  asset: "BTC" | "ETH",
  market: "KRW-BTC" | "KRW-ETH",
  ablationScenario: (typeof COMPONENTS)[number],
  timing: "SAME_CLOSE_MODELED" | "NEXT_FRAME_MODELED",
  cost: "BASE" | "STRESS",
): PerformanceComponentAblationCell {
  const provenance = {
    authorityId: "COMBINED_CONSERVATIVE_ABLATION_V1",
    asset,
    market,
    timingModel: timing,
    costCellId: cost,
    costRole: cost,
    feeRate: cost === "BASE" ? 0.0005 : 0.001,
    slippageRate: cost === "BASE" ? 0.0003 : 0.002,
    holdoutFrom: "2026-07-01T00:00:00.000Z",
    holdoutTo: "2026-07-10T00:00:00.000Z",
    datasetSha256: asset === "BTC" ? "a".repeat(64) : "b".repeat(64),
    datasetFingerprint: `dataset-${asset}`,
    initialStateFingerprint: `initial-${asset}`,
    developmentFrameFingerprint: `development-${asset}`,
    replayFrameFingerprint: `replay-${asset}`,
  };
  return {
    asset,
    market,
    timing,
    cost,
    holdoutFrom: provenance.holdoutFrom,
    holdoutTo: provenance.holdoutTo,
    reference: metrics("COMBINED_CONSERVATIVE"),
    ablation: metrics(ablationScenario),
    coverage: completeCoverage(),
    attribution: {
      analysisKind: "HOLDOUT_EPISODE_COMPONENT_ABLATION_ATTRIBUTION" as const,
      referenceScenario: "COMBINED_CONSERVATIVE" as const,
      ablationScenario,
      readOnly: true as const,
      causalClaim: false as const,
      deploymentApproval: false as const,
      prospectiveApproval: false as const,
      provenance: { ...provenance },
      referenceInterventions: [],
      ablationInterventions: [],
      relationships: [relationship(asset, market, timing, cost, ablationScenario)],
      counts: {
        totalRelationships: 1,
        exactEntryMatches: 1,
        exitTimingChanged: 0,
        referenceOnlyLoss: 0,
        referenceOnlyGain: 0,
        ablationOnly: 0,
        pathDiverged: 0,
        carryIn: 0,
        openAtTo: 0,
        netOutcomeUnknown: 0,
        closedKnownPnlComparisons: 1,
      },
      warnings: [],
    },
  } as PerformanceComponentAblationCell;
}

function completeCoverage(): TestPathCoverage {
  return {
    cadenceComplete: true,
    featureCoverageComplete: true,
    carryInStateComplete: true,
    referenceLifecycleComplete: true,
    ablationLifecycleComplete: true,
    referenceFeeComplete: true,
    ablationFeeComplete: true,
    referenceFiniteMetricsComplete: true,
    ablationFiniteMetricsComplete: true,
  };
}

function coverageOf(cell: PerformanceComponentAblationCell): TestPathCoverage {
  return (cell as PerformanceComponentAblationCell & { coverage: TestPathCoverage }).coverage;
}

function attributionOf(cell: PerformanceComponentAblationCell) {
  return cell.attribution;
}

function relationship(
  asset: "BTC" | "ETH",
  market: "KRW-BTC" | "KRW-ETH",
  timing: "SAME_CLOSE_MODELED" | "NEXT_FRAME_MODELED",
  cost: "BASE" | "STRESS",
  ablationScenario: (typeof COMPONENTS)[number],
  closedKnownPnlComparable = true,
): HoldoutEpisodeRelationship {
  return {
    relationshipKind: "EXACT_ENTRY_MATCH",
    classifications: ["EXACT_ENTRY_MATCH"],
    entryKeyEpochNanoseconds: "1782864000000000000",
    reference: envelope("COMBINED_CONSERVATIVE", asset, market, timing, cost, "reference"),
    ablation: envelope(ablationScenario, asset, market, timing, cost, "ablation"),
    closedKnownPnlComparable,
    netPnlDeltaKrw: closedKnownPnlComparable ? 0 : null,
  };
}

function envelope(
  scenario: "COMBINED_CONSERVATIVE" | (typeof COMPONENTS)[number],
  asset: "BTC" | "ETH",
  market: "KRW-BTC" | "KRW-ETH",
  timingModel: "SAME_CLOSE_MODELED" | "NEXT_FRAME_MODELED",
  costCellId: "BASE" | "STRESS",
  stem: string,
): HoldoutEpisodeEnvelope {
  return {
    scenario,
    asset,
    market,
    timingModel,
    costCellId,
    episodeId: `${stem}-episode`,
    entryFillIds: [`${stem}-entry`],
    exitFillIds: [`${stem}-exit`],
    modeledFillAttributionFillIds: [`${stem}-entry`, `${stem}-exit`],
    interventionFillIds: [],
    realizationSliceIds: [`${stem}-exit:${stem}-entry:0`],
    interventionEvidenceIds: [],
    firstEnterDecisionAt: "2026-07-01T00:00:00.000Z",
    firstEnterDecisionEpochNanoseconds: "1782864000000000000",
    firstEnterExecutedAt: "2026-07-01T00:00:00.000Z",
    firstEnterExecutedEpochNanoseconds: "1782864000000000000",
    openedAt: "2026-07-01T00:00:00.000Z",
    openedAtEpochNanoseconds: "1782864000000000000",
    closedAt: "2026-07-02T00:00:00.000Z",
    closedAtEpochNanoseconds: "1782950400000000000",
    grossRealizedPnlKrw: 10,
    realizedFeeImpactKrw: 1,
    netRealizedPnlKrw: 9,
    openedQuantity: 1,
    realizedQuantity: 1,
    remainingQuantity: 0,
    holdingDurationMs: 86_400_000,
    carryIn: false,
    openAtTo: false,
    netOutcomeKnown: true,
  };
}

function setEvidence(
  cell: PerformanceComponentAblationCell,
  kind: HoldoutEpisodeRelationshipKind,
  closedKnownPnlComparable = false,
): void {
  if (cell.ablation.scenario === "COMBINED_CONSERVATIVE") throw new Error("Test fixture requires an ablation scenario.");
  const row = relationship(cell.asset, cell.market, cell.timing, cell.cost, cell.ablation.scenario, closedKnownPnlComparable);
  row.relationshipKind = kind;
  row.classifications = [kind];
  if (kind !== "EXACT_ENTRY_MATCH") {
    row.entryKeyEpochNanoseconds = null;
    row.ablation = null;
    row.netPnlDeltaKrw = null;
  }
  if (kind === "CARRY_IN") row.reference!.carryIn = true;
  if (kind === "OPEN_AT_TO") row.reference!.openAtTo = true;
  if (kind === "NET_OUTCOME_UNKNOWN") row.reference!.netOutcomeKnown = false;
  cell.attribution.relationships = [row];
  cell.attribution.counts = countsFor([row]);
}

function setEmptyEvidence(cell: PerformanceComponentAblationCell): void {
  cell.attribution.relationships = [];
  cell.attribution.counts = countsFor([]);
}

function countsFor(rows: readonly HoldoutEpisodeRelationship[]): HoldoutEpisodeAttributionCounts {
  const count = (kind: HoldoutEpisodeRelationshipKind): number =>
    rows.filter((row) => row.classifications.includes(kind)).length;
  return {
    totalRelationships: rows.length,
    exactEntryMatches: count("EXACT_ENTRY_MATCH"),
    exitTimingChanged: count("EXIT_TIMING_CHANGED"),
    referenceOnlyLoss: count("REFERENCE_ONLY_LOSS"),
    referenceOnlyGain: count("REFERENCE_ONLY_GAIN"),
    ablationOnly: count("ABLATION_ONLY"),
    pathDiverged: count("PATH_DIVERGED"),
    carryIn: count("CARRY_IN"),
    openAtTo: count("OPEN_AT_TO"),
    netOutcomeUnknown: count("NET_OUTCOME_UNKNOWN"),
    closedKnownPnlComparisons: rows.filter((row) => row.closedKnownPnlComparable).length,
  };
}

function setRange(
  asset: PerformanceComponentAblationInput["assets"][number],
  outerFrom: string,
  outerTo: string,
  evidenceFrom: string,
  evidenceTo: string,
): void {
  asset.holdoutFrom = outerFrom;
  asset.holdoutTo = outerTo;
  for (const cell of asset.cells) {
    cell.holdoutFrom = evidenceFrom;
    cell.holdoutTo = evidenceTo;
    cell.attribution.provenance.holdoutFrom = evidenceFrom;
    cell.attribution.provenance.holdoutTo = evidenceTo;
  }
}

function metrics(scenario: "COMBINED_CONSERVATIVE" | (typeof COMPONENTS)[number]) {
  return { scenario, netReturnPct: 1, maxDrawdownPct: 2, turnoverKrw: 100, feesKrw: 1, completedEpisodeCount: 10 };
}

function changeAllCells(
  value: PerformanceComponentAblationInput,
  scenario: (typeof COMPONENTS)[number],
  delta: Partial<Omit<ReturnType<typeof metrics>, "scenario">>,
): void {
  for (const asset of value.assets) for (const entry of asset.cells) {
    if (entry.ablation.scenario === scenario) change(entry.ablation, delta);
  }
}

function changeCell(
  value: PerformanceComponentAblationInput,
  asset: "BTC" | "ETH",
  scenario: (typeof COMPONENTS)[number],
  timing: "SAME_CLOSE_MODELED" | "NEXT_FRAME_MODELED",
  cost: "BASE" | "STRESS",
  delta: Partial<Omit<ReturnType<typeof metrics>, "scenario">>,
): void {
  const target = value.assets.find((entry) => entry.asset === asset)!.cells.find((entry) =>
    entry.ablation.scenario === scenario && entry.timing === timing && entry.cost === cost,
  )!;
  change(target.ablation, delta);
}

function change(target: ReturnType<typeof metrics>, delta: Partial<Omit<ReturnType<typeof metrics>, "scenario">>): void {
  for (const [key, value] of Object.entries(delta)) {
    target[key as keyof Omit<ReturnType<typeof metrics>, "scenario">] += value as number;
  }
}

function component(
  result: ReturnType<typeof evaluatePerformanceComponentAblation>,
  asset: "BTC" | "ETH",
  scenario: (typeof COMPONENTS)[number],
) {
  return result.assets.find((entry) => entry.asset === asset)!.components.find((entry) => entry.ablationScenario === scenario)!;
}
