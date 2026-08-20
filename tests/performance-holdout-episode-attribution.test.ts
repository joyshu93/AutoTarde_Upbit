import assert from "node:assert/strict";

import {
  analyzeHoldoutEpisodeAttribution,
  type HoldoutEpisodeAttributionInput,
  type HoldoutEpisodePathProvenance,
} from "../src/modules/performance/performance-holdout-episode-attribution.js";
import {
  matchPerformanceTrades,
  type PerformanceTradeFill,
} from "../src/modules/performance/performance-trade-matcher.js";
import type {
  CounterfactualModeledFillAttribution,
  CounterfactualScenario,
  CounterfactualScenarioResult,
} from "../src/modules/performance/strategy-counterfactual.js";
import { test } from "./harness.js";

test("holdout episode attribution exact-matches timezone-equivalent entries and preserves partial exits", () => {
  const input = baseInput();
  input.reference = scenario("COMBINED_CONSERVATIVE", [
    fill("r-enter", "bid", 100, 2, 1, "2026-07-01T09:00:00+09:00", "ENTER"),
    fill("r-reduce", "ask", 105, 1, 0.5, "2026-07-02T00:00:00Z", "REDUCE"),
    fill("r-exit", "ask", 110, 1, 0.5, "2026-07-03T00:00:00Z", "EXIT"),
  ]);
  input.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", [
    fill("a-enter", "bid", 100, 2, 1, "2026-07-01T00:00:00Z", "ENTER"),
    fill("a-exit", "ask", 108, 2, 1, "2026-07-04T00:00:00Z", "EXIT"),
  ]);

  const result = analyzeHoldoutEpisodeAttribution(input);

  assert.equal(result.analysisKind, "HOLDOUT_EPISODE_COMPONENT_ABLATION_ATTRIBUTION");
  assert.equal(result.readOnly, true);
  assert.equal(result.causalClaim, false);
  assert.equal(result.deploymentApproval, false);
  assert.equal(result.prospectiveApproval, false);
  assert.equal(result.relationships.length, 1);
  assert.equal(result.relationships[0]?.relationshipKind, "EXIT_TIMING_CHANGED");
  assert.deepEqual(result.relationships[0]?.classifications, [
    "EXACT_ENTRY_MATCH",
    "EXIT_TIMING_CHANGED",
  ]);
  assert.equal(result.relationships[0]?.entryKeyEpochNanoseconds, "1782864000000000000");
  assert.equal(result.relationships[0]?.reference?.openedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(result.relationships[0]?.reference?.exitFillIds.length, 2);
  assert.deepEqual(result.relationships[0]?.reference?.realizationSliceIds, [
    "r-reduce:r-enter:0",
    "r-exit:r-enter:0",
  ]);
  assert.equal(result.relationships[0]?.reference?.openedQuantity, 2);
  assert.equal(result.relationships[0]?.reference?.realizedQuantity, 2);
  assert.equal(result.relationships[0]?.reference?.remainingQuantity, 0);
  assert.equal(result.relationships[0]?.closedKnownPnlComparable, true);
  assert.equal(result.counts.exactEntryMatches, 1);
  assert.equal(result.counts.exitTimingChanged, 1);
  assert.equal(result.counts.closedKnownPnlComparisons, 1);
});

test("empty attribution retains deterministic JSON-safe top-level scenario identity", () => {
  const utcInput = baseInput();
  const offsetInput = cloneInput(utcInput);
  offsetInput.from = "2026-07-01T09:00:00+09:00";
  offsetInput.to = "2026-07-10T09:00:00+09:00";
  offsetInput.referenceProvenance.holdoutFrom = offsetInput.from;
  offsetInput.referenceProvenance.holdoutTo = offsetInput.to;
  offsetInput.ablationProvenance.holdoutFrom = offsetInput.from;
  offsetInput.ablationProvenance.holdoutTo = offsetInput.to;

  const utcResult = analyzeHoldoutEpisodeAttribution(utcInput);
  const offsetResult = analyzeHoldoutEpisodeAttribution(offsetInput);

  assert.equal(utcResult.referenceScenario, "COMBINED_CONSERVATIVE");
  assert.equal(utcResult.ablationScenario, "COMBINED_MINUS_ADD_LIMITED");
  assert.deepEqual(utcResult.relationships, []);
  assert.deepEqual(utcResult.referenceInterventions, []);
  assert.deepEqual(utcResult.ablationInterventions, []);
  assert.doesNotThrow(() => JSON.stringify(utcResult));
  assert.equal(JSON.stringify(offsetResult), JSON.stringify(utcResult));
});

test("keeps an unmatched zero-PnL reference episode neutral instead of labeling it a gain", () => {
  const input = baseInput();
  input.reference = scenario("COMBINED_CONSERVATIVE", closed("flat", 100, 100));
  input.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", []);

  const result = analyzeHoldoutEpisodeAttribution(input);

  assert.equal(result.relationships[0]?.relationshipKind, "PATH_DIVERGED");
  assert.deepEqual(result.relationships[0]?.classifications, ["PATH_DIVERGED"]);
  assert.equal(result.counts.referenceOnlyGain, 0);
  assert.equal(result.counts.referenceOnlyLoss, 0);
  assert.equal(result.counts.pathDiverged, 1);
});

test("retains stable intervention evidence even when a suppression creates no fill", () => {
  const input = baseInput();
  input.reference = scenario("COMBINED_CONSERVATIVE", [
    fill("r-enter", "bid", 100, 2, 1, "2026-07-01T00:00:00Z", "ENTER"),
    fill("r-exit", "ask", 110, 2, 1, "2026-07-03T00:00:00Z", "EXIT"),
  ]);
  input.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", [
    fill("a-enter", "bid", 100, 2, 1, "2026-07-01T00:00:00Z", "ENTER"),
    fill("a-exit", "ask", 110, 2, 1, "2026-07-03T00:00:00Z", "EXIT"),
  ]);
  addSuppressedIntervention(
    input.ablation,
    "2026-07-02T00:00:00Z",
    "ADD",
    "HOLD",
    "EPISODE_ADD_LIMIT_REACHED",
  );

  const result = analyzeHoldoutEpisodeAttribution(input);
  const evidence = result.ablationInterventions[0];

  assert.ok(evidence);
  assert.equal(evidence.evidenceType, "RESEARCH_INTERVENTION");
  assert.equal(evidence.outcome, "SUPPRESS");
  assert.equal(evidence.originalAction, "ADD");
  assert.equal(evidence.effectiveAction, "HOLD");
  assert.equal(evidence.reason, "EPISODE_ADD_LIMIT_REACHED");
  assert.equal(evidence.linkedFillId, null);
  assert.equal(evidence.linkedStrategyDecisionId, null);
  assert.equal(evidence.linkedEpisodeId, result.relationships[0]?.ablation?.episodeId);
  assert.deepEqual(result.relationships[0]?.ablation?.interventionEvidenceIds, [evidence.id]);
  assert.match(evidence.decisionEvidenceId, /^decision:/);
});

test("returns detached deeply frozen evidence with deterministic JSON at every level", () => {
  const input = baseInput();
  input.reference = scenario("COMBINED_CONSERVATIVE", closed("r", 100, 110));
  input.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", closed("a", 100, 110));
  addSuppressedIntervention(
    input.ablation,
    "2026-07-01T12:00:00Z",
    "ADD",
    "HOLD",
    "EPISODE_ADD_LIMIT_REACHED",
  );

  const first = analyzeHoldoutEpisodeAttribution(input);
  const frozenJson = JSON.stringify(first);
  const second = analyzeHoldoutEpisodeAttribution(cloneInput(input));

  assert.equal(JSON.stringify(second), frozenJson);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.provenance), true);
  assert.equal(Object.isFrozen(first.relationships), true);
  assert.equal(Object.isFrozen(first.relationships[0]), true);
  assert.equal(Object.isFrozen(first.relationships[0]?.reference), true);
  assert.equal(Object.isFrozen(first.relationships[0]?.reference?.realizationSliceIds), true);
  assert.equal(Object.isFrozen(first.ablationInterventions), true);
  assert.equal(Object.isFrozen(first.ablationInterventions[0]), true);
  assert.equal(Object.isFrozen(first.counts), true);
  assert.equal(Object.isFrozen(first.warnings), true);

  assert.throws(() => {
    (first.relationships as unknown as unknown[]).push({});
  }, TypeError);
  assert.throws(() => {
    (first.relationships[0]!.reference as { openedQuantity: number }).openedQuantity = 999;
  }, TypeError);
  assert.throws(() => {
    (first.ablationInterventions[0] as { reason: string }).reason = "mutated";
  }, TypeError);

  input.reference.fills[0]!.volume = 999;
  replaceFirstIntervention(input.ablation, { reason: "CONDITIONS_MET" });
  assert.equal(JSON.stringify(first), frozenJson);
});

test("rejects malformed declared FIFO links, quantities, and intervention cross-links", () => {
  const valid = baseInput();
  valid.reference = scenario("COMBINED_CONSERVATIVE", closed("r", 100, 110));
  valid.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", closed("a", 100, 110));
  addSuppressedIntervention(
    valid.ablation,
    "2026-07-01T12:00:00Z",
    "ADD",
    "HOLD",
    "EPISODE_ADD_LIMIT_REACHED",
  );

  const badSlice = cloneInput(valid);
  (badSlice.reference.matchResult.episodes[0]!.realizationSliceIds as string[])[0] = "missing-slice";
  assert.throws(() => analyzeHoldoutEpisodeAttribution(badSlice), /declared.*FIFO|realization.*link/i);

  const badQuantity = cloneInput(valid);
  (badQuantity.reference.matchResult.episodes[0] as { remainingQuantity: number }).remainingQuantity = -1;
  assert.throws(
    () => analyzeHoldoutEpisodeAttribution(badQuantity),
    /declared.*(?:quantity|quantities)|remaining quantity/i,
  );

  const badIntervention = cloneInput(valid);
  replaceFirstIntervention(badIntervention.ablation, {
    generatedAt: "2026-07-01T12:00:00.000000001Z",
  });
  assert.throws(() => analyzeHoldoutEpisodeAttribution(badIntervention), /intervention.*generatedAt|frame.*instant/i);
});

test("SAME_CLOSE uses explicit timing provenance and source frames when entry attribution is absent", () => {
  const input = baseInput();
  input.reference = scenario("COMBINED_CONSERVATIVE", closed("r", 100, 110), {
    attributions: [],
  });
  input.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", closed("a", 100, 110), {
    attributions: [],
  });

  const result = analyzeHoldoutEpisodeAttribution(input);

  assert.equal(result.relationships[0]?.relationshipKind, "EXACT_ENTRY_MATCH");
  assert.equal(result.relationships[0]?.reference?.firstEnterDecisionAt, "2026-07-01T00:00:00.000Z");
});

test("classifies reference-only gains/losses, ablation-only episodes, and keyless path divergence", () => {
  const input = baseInput();
  input.reference = scenario("COMBINED_CONSERVATIVE", [
    ...closed("loss", 110, 100, "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"),
    ...closed("gain", 100, 120, "2026-07-03T00:00:00Z", "2026-07-04T00:00:00Z"),
    fill("keyless-buy", "bid", 100, 1, 0, "2026-07-05T00:00:00Z", "ADD"),
    fill("keyless-exit", "ask", 100, 1, 0, "2026-07-06T00:00:00Z", "EXIT"),
  ]);
  input.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", closed(
    "only", 100, 105, "2026-07-07T00:00:00Z", "2026-07-08T00:00:00Z",
  ));

  const result = analyzeHoldoutEpisodeAttribution(input);

  assert.deepEqual(result.relationships.map((row) => row.relationshipKind), [
    "REFERENCE_ONLY_LOSS",
    "REFERENCE_ONLY_GAIN",
    "PATH_DIVERGED",
    "ABLATION_ONLY",
  ]);
  assert.equal(result.counts.referenceOnlyLoss, 1);
  assert.equal(result.counts.referenceOnlyGain, 1);
  assert.equal(result.counts.ablationOnly, 1);
  assert.equal(result.counts.pathDiverged, 1);
});

test("reports carry-in, open-at-to, and unknown net outcomes outside known closed comparisons", () => {
  const input = baseInput();
  input.reference = scenario("COMBINED_CONSERVATIVE", [
    ...closed("carry", 100, 110, "2026-06-30T00:00:00Z", "2026-07-02T00:00:00Z"),
    ...closed("unknown", 100, 110, "2026-07-03T00:00:00Z", "2026-07-04T00:00:00Z", null),
    fill("open-enter", "bid", 100, 1, 0, "2026-07-05T00:00:00Z", "ENTER"),
  ]);
  input.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", []);

  const result = analyzeHoldoutEpisodeAttribution(input);

  assert.deepEqual(result.relationships.map((row) => row.relationshipKind), [
    "CARRY_IN",
    "NET_OUTCOME_UNKNOWN",
    "OPEN_AT_TO",
  ]);
  assert.equal(result.counts.carryIn, 1);
  assert.equal(result.counts.openAtTo, 1);
  assert.equal(result.counts.netOutcomeUnknown, 1);
  assert.equal(result.counts.closedKnownPnlComparisons, 0);
  assert.deepEqual(result.warnings, [
    "Carry-in episodes are excluded from closed known PnL comparisons.",
    "Episodes open at the exclusive holdout end are excluded from closed known PnL comparisons.",
    "Episodes with unknown net outcomes are excluded from closed known PnL comparisons.",
  ]);
});

test("excludes episodes completed strictly before holdout from", () => {
  const input = baseInput();
  input.reference = scenario("COMBINED_CONSERVATIVE", closed(
    "pre-holdout",
    100,
    110,
    "2026-06-29T00:00:00Z",
    "2026-06-30T23:59:59.999999999Z",
  ));
  input.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", []);

  const result = analyzeHoldoutEpisodeAttribution(input);

  assert.deepEqual(result.relationships, []);
  assert.equal(result.counts.totalRelationships, 0);
  assert.equal(result.counts.carryIn, 0);
  assert.deepEqual(result.warnings, []);
});

test("includes a carry-in episode whose terminal fill occurs exactly at holdout from", () => {
  const input = baseInput();
  input.reference = scenario("COMBINED_CONSERVATIVE", closed(
    "at-from",
    100,
    110,
    "2026-06-30T00:00:00Z",
    "2026-07-01T09:00:00+09:00",
  ));
  input.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", []);

  const result = analyzeHoldoutEpisodeAttribution(input);

  assert.equal(result.relationships.length, 1);
  assert.equal(result.relationships[0]?.relationshipKind, "CARRY_IN");
  assert.equal(result.relationships[0]?.reference?.closedAt, "2026-07-01T00:00:00.000Z");
  assert.equal(result.counts.carryIn, 1);
});

test("rejects a non-finite net PnL delta produced from finite episode outcomes", () => {
  const input = baseInput();
  input.reference = scenario("COMBINED_CONSERVATIVE", closed(
    "reference-extreme",
    1e308,
    1,
  ));
  input.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", closed(
    "ablation-extreme",
    1,
    1e308,
  ));

  assert.throws(
    () => analyzeHoldoutEpisodeAttribution(input),
    /net PnL delta.*finite/i,
  );
});

test("enforces [from,to), ignores future lifecycle evidence, and is stable across input order", () => {
  const input = baseInput();
  const beforeTo = fill("open", "bid", 100, 1, 0, "2026-07-09T23:59:59.999999999Z", "ENTER");
  const atTo = fill("future-exit", "ask", 999, 1, 0, "2026-07-10T00:00:00Z", "EXIT");
  input.reference = scenario("COMBINED_CONSERVATIVE", [atTo, beforeTo]);
  input.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", []);

  const first = analyzeHoldoutEpisodeAttribution(input);
  const changedFuture = cloneInput(input);
  changedFuture.reference = scenario("COMBINED_CONSERVATIVE", [
    { ...atTo, priceKrw: 1 },
    beforeTo,
  ]);
  const second = analyzeHoldoutEpisodeAttribution(changedFuture);

  assert.deepEqual(second, first);
  assert.equal(first.relationships[0]?.relationshipKind, "OPEN_AT_TO");

  const atFrom = cloneInput(input);
  atFrom.reference = scenario("COMBINED_CONSERVATIVE", closed(
    "boundary", 100, 101, "2026-07-01T00:00:00Z", "2026-07-01T00:00:00.000000001Z",
  ));
  assert.equal(analyzeHoldoutEpisodeAttribution(atFrom).relationships.length, 1);
});

test("uses deterministic epoch, path, and evidence tie-breaks independent of timezone spelling", () => {
  const input = baseInput();
  input.reference = scenario("COMBINED_CONSERVATIVE", [
    ...closed("later", 100, 101, "2026-07-03T09:00:00+09:00", "2026-07-04T00:00:00Z"),
    ...closed("earlier", 100, 101, "2026-07-02T00:00:00Z", "2026-07-02T12:00:00Z"),
  ].reverse());
  input.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", []);

  const result = analyzeHoldoutEpisodeAttribution(input);

  assert.deepEqual(result.relationships.map((row) => row.reference?.firstEnterDecisionAt), [
    "2026-07-02T00:00:00.000Z",
    "2026-07-03T00:00:00.000Z",
  ]);
  assert.equal(JSON.stringify(result).includes("bigint"), false);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("rejects scenario, timing, cost, market, provenance, lifecycle, and malformed evidence mismatches", () => {
  const valid = baseInput();
  valid.reference = scenario("COMBINED_CONSERVATIVE", closed("r", 100, 110));
  valid.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", closed("a", 100, 110));

  const cases: Array<[string, (input: HoldoutEpisodeAttributionInput) => void, RegExp]> = [
    ["reference role", (input) => { input.reference = scenario("BASELINE", []); }, /reference scenario.*COMBINED_CONSERVATIVE/i],
    ["ablation role", (input) => { input.ablation = scenario("STRICT_PULLBACK", []); }, /ablation scenario/i],
    ["timing", (input) => { input.ablation.executionTimingProvenance.model = "NEXT_FRAME_MODELED"; }, /timing/i],
    ["cost", (input) => { input.cost.feeRate = 0.25; }, /cost/i],
    ["market", (input) => { input.market = "KRW-ETH"; }, /asset.*market/i],
    ["provenance", (input) => { input.ablationProvenance.datasetSha256 = "b".repeat(64); }, /provenance/i],
    ["unmatched sell", (input) => { input.reference = scenario("COMBINED_CONSERVATIVE", [fill("sell", "ask", 1, 1, 0, "2026-07-01T00:00:00Z", "EXIT")]); }, /unmatched sell|lifecycle/i],
    ["opposite sides", (input) => {
      input.reference = scenario("COMBINED_CONSERVATIVE", []);
      input.reference.fills = [
        fill("buy", "bid", 1, 1, 0, "2026-07-01T00:00:00Z", "ENTER"),
        fill("sell", "ask", 1, 1, 0, "2026-07-01T09:00:00+09:00", "EXIT"),
      ];
    }, /opposite-side/i],
    ["negative", (input) => { input.reference.fills[0]!.priceKrw = -1; }, /positive/i],
    ["non-finite", (input) => { input.reference.fills[0]!.volume = Number.NaN; }, /finite|volume/i],
    ["timestamp", (input) => { input.from = "2026-07-01T00:00:00"; }, /explicit timezone/i],
  ];

  for (const [name, mutate, expected] of cases) {
    const input = cloneInput(valid);
    mutate(input);
    assert.throws(() => analyzeHoldoutEpisodeAttribution(input), expected, name);
  }
});

test("rejects duplicate exact entry keys and NEXT_FRAME entries without attribution", () => {
  const duplicate = baseInput();
  duplicate.reference = scenario("COMBINED_CONSERVATIVE", [
    ...closed("one", 100, 101, "2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z"),
    ...closed("two", 100, 101, "2026-07-03T00:00:00Z", "2026-07-04T00:00:00Z"),
  ]);
  duplicate.reference.modeledFillAttributions = duplicate.reference.modeledFillAttributions!.map(
    (item) => item.effectiveAction === "ENTER"
      ? { ...item, decisionGeneratedAt: "2026-07-01T00:00:00Z", decisionFrameIndex: 0 }
      : item,
  );
  duplicate.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", []);
  assert.throws(() => analyzeHoldoutEpisodeAttribution(duplicate), /duplicate entry key/i);

  const next = baseInput();
  next.timingModel = "NEXT_FRAME_MODELED";
  next.referenceProvenance.timingModel = "NEXT_FRAME_MODELED";
  next.ablationProvenance.timingModel = "NEXT_FRAME_MODELED";
  next.reference = scenario("COMBINED_CONSERVATIVE", closed("r", 100, 110), {
    timingModel: "NEXT_FRAME_MODELED",
    attributions: [],
  });
  next.ablation = scenario("COMBINED_MINUS_ADD_LIMITED", [], { timingModel: "NEXT_FRAME_MODELED" });
  assert.throws(() => analyzeHoldoutEpisodeAttribution(next), /NEXT_FRAME_MODELED.*attribution/i);
});

function baseInput(): HoldoutEpisodeAttributionInput {
  const common = provenance();
  return {
    reference: scenario("COMBINED_CONSERVATIVE", []),
    ablation: scenario("COMBINED_MINUS_ADD_LIMITED", []),
    asset: "BTC",
    market: "KRW-BTC",
    timingModel: "SAME_CLOSE_MODELED",
    cost: { id: "BASE", role: "BASE", feeRate: 0.0005, slippageRate: 0.0003 },
    from: "2026-07-01T00:00:00Z",
    to: "2026-07-10T00:00:00Z",
    referenceProvenance: { ...common },
    ablationProvenance: { ...common },
  };
}

function provenance(): HoldoutEpisodePathProvenance {
  return {
    authorityId: "COMBINED_CONSERVATIVE_ABLATION_V1",
    asset: "BTC",
    market: "KRW-BTC",
    timingModel: "SAME_CLOSE_MODELED",
    costCellId: "BASE",
    costRole: "BASE",
    feeRate: 0.0005,
    slippageRate: 0.0003,
    holdoutFrom: "2026-07-01T00:00:00Z",
    holdoutTo: "2026-07-10T00:00:00Z",
    datasetSha256: "a".repeat(64),
    datasetFingerprint: "dataset-fingerprint",
    initialStateFingerprint: "initial-state-fingerprint",
    developmentFrameFingerprint: "development-frame-fingerprint",
    replayFrameFingerprint: "replay-frame-fingerprint",
  };
}

function closed(
  stem: string,
  entryPrice: number,
  exitPrice: number,
  entryAt = "2026-07-01T00:00:00Z",
  exitAt = "2026-07-02T00:00:00Z",
  fee: number | null = 0,
): PerformanceTradeFill[] {
  return [
    fill(`${stem}-enter`, "bid", entryPrice, 1, fee, entryAt, "ENTER"),
    fill(`${stem}-exit`, "ask", exitPrice, 1, fee, exitAt, "EXIT"),
  ];
}

function fill(
  id: string,
  side: "bid" | "ask",
  priceKrw: number,
  volume: number,
  feeKrw: number | null,
  filledAt: string,
  decisionAction: "ENTER" | "ADD" | "REDUCE" | "EXIT",
): PerformanceTradeFill {
  return {
    id,
    orderId: `order-${id}`,
    strategyDecisionId: `decision-${id}`,
    decisionAction,
    market: "KRW-BTC",
    side,
    priceKrw,
    volume,
    feeKrw,
    filledAt,
  };
}

function scenario(
  scenarioId: CounterfactualScenario,
  fills: PerformanceTradeFill[],
  options: {
    timingModel?: "SAME_CLOSE_MODELED" | "NEXT_FRAME_MODELED";
    attributions?: CounterfactualModeledFillAttribution[];
  } = {},
): CounterfactualScenarioResult {
  const orderedInstants = [...new Set(fills.map((item) => item.filledAt))];
  const sourceFrames = orderedInstants.map((generatedAt) => ({ generatedAt })) as unknown as CounterfactualScenarioResult["sourceFrames"];
  const attributions = options.attributions ?? fills.map((item) => ({
    fillId: item.id,
    scenario: scenarioId,
    decisionGeneratedAt: item.filledAt,
    decisionFrameIndex: orderedInstants.indexOf(item.filledAt),
    executedAt: item.filledAt,
    executionFrameIndex: orderedInstants.indexOf(item.filledAt),
    originalAction: item.decisionAction ?? "HOLD",
    effectiveAction: item.decisionAction ?? "ENTER",
    intervention: null,
  }));
  return {
    evidenceKind: "SIMULATED_COUNTERFACTUAL",
    scenario: scenarioId,
    executionPolicy: scenarioId === "BASELINE" ? null : { id: scenarioId } as CounterfactualScenarioResult["executionPolicy"],
    sourceFrames,
    legacyBacktest: {
      label: "LEGACY_AVERAGE_COST_BACKTEST",
      result: {
        frames: sourceFrames.map((frame) => ({ generatedAt: frame.generatedAt })),
        metrics: {},
        finalState: {},
      } as never,
    },
    fills,
    matchResult: matchPerformanceTrades({ fills }),
    diagnostics: {} as CounterfactualScenarioResult["diagnostics"],
    executionTimingProvenance: {
      model: options.timingModel ?? "SAME_CLOSE_MODELED",
      observedExecution: false,
      caveat: "modeled",
    },
    modeledFillAttributions: attributions,
  };
}

function addSuppressedIntervention(
  result: CounterfactualScenarioResult,
  generatedAt: string,
  originalAction: "ADD" | "ENTER",
  effectiveAction: "HOLD",
  reason: "EPISODE_ADD_LIMIT_REACHED" | "SAME_ENTRY_PATH_24H_COOLDOWN",
): void {
  const sourceFrameTemplate = result.sourceFrames[0];
  if (!sourceFrameTemplate) throw new Error("Test fixture requires a source-frame template.");
  result.sourceFrames = [
    ...result.sourceFrames,
    { ...sourceFrameTemplate, generatedAt },
  ];
  result.legacyBacktest.result.frames.push({
    generatedAt,
    decision: { action: originalAction },
    researchIntervention: {
      scenario: result.scenario,
      generatedAt,
      originalAction,
      effectiveAction,
      outcome: "SUPPRESS",
      reason,
      evidence: {},
    },
  } as unknown as CounterfactualScenarioResult["legacyBacktest"]["result"]["frames"][number]);
}

function replaceFirstIntervention(
  result: CounterfactualScenarioResult,
  changes: Partial<NonNullable<
    CounterfactualScenarioResult["legacyBacktest"]["result"]["frames"][number]["researchIntervention"]
  >>,
): void {
  const frames = result.legacyBacktest.result.frames;
  const index = frames.findIndex((frame) => frame.researchIntervention !== null
    && frame.researchIntervention !== undefined);
  const frame = frames[index];
  const intervention = frame?.researchIntervention;
  if (index < 0 || !frame || !intervention) {
    throw new Error("Test fixture requires an intervention frame.");
  }
  frames[index] = {
    ...frame,
    researchIntervention: {
      ...intervention,
      ...changes,
    },
  };
}

function cloneInput(input: HoldoutEpisodeAttributionInput): HoldoutEpisodeAttributionInput {
  return structuredClone(input);
}
