import assert from "node:assert/strict";

import {
  buildProspectiveShadowReplayEvidence,
  buildProspectiveShadowReplayEvidenceFromReader,
  inspectProspectiveShadowReplayPathEvidence,
  orderProspectiveShadowReplayCounterfactualFills,
  validateProspectiveShadowReplayRelationshipEvidence,
  type BuildProspectiveShadowReplayEvidenceInput,
} from "../src/modules/performance/performance-prospective-shadow-replay.js";
import { analyzeHoldoutEpisodeAttribution } from "../src/modules/performance/performance-holdout-episode-attribution.js";
import { matchPerformanceTrades } from "../src/modules/performance/performance-trade-matcher.js";
import { runCounterfactualScenarios } from "../src/modules/performance/strategy-counterfactual.js";
import {
  calculateResearchCandleDatasetChecksum,
  type ResearchCandleDataset,
} from "../src/modules/performance/research-candle-dataset.js";
import {
  computeResearchNoTradeEvidenceSha256,
  type ResearchNoTradeEvidence,
} from "../src/modules/performance/research-no-trade-evidence.js";
import {
  createProspectiveShadowRegistration,
  PROSPECTIVE_SHADOW_POLICY_MANIFEST,
} from "../src/modules/performance/performance-prospective-shadow-registration.js";
import type { PositionGuardBacktestFrame } from "../src/modules/strategy/position-guard-backtest.js";
import { runRegisteredTests, test } from "./harness.js";

test("replays exactly the ordered registered 24-path matrix from fresh prospective state", () => {
  const evidence = buildProspectiveShadowReplayEvidence(input());

  assert.equal(evidence.paths.length, 24);
  assert.deepEqual(
    evidence.paths.map((path) => [path.asset, path.scenario, path.timing, path.costId]),
    ["BTC", "ETH"].flatMap((asset) => [
      "COMBINED_CONSERVATIVE",
      "COMBINED_MINUS_EARLY_THESIS_FAILURE",
      "COMBINED_MINUS_COOLDOWN_CONTROL",
    ].flatMap((scenario) => [
      "SAME_CLOSE_MODELED",
      "NEXT_FRAME_MODELED",
    ].flatMap((timing) => ["BASE", "STRESS"].map((cost) => [asset, scenario, timing, cost])))),
  );
  for (const path of evidence.paths) {
    assert.deepEqual(path.initialState, {
      cashKrw: 1_000_000,
      quantity: 0,
      openEpisode: false,
      addCount: 0,
      cooldownActive: false,
    });
    assert.equal(path.counterfactual.legacyBacktest.result.frames[0]?.startingState.cashKrw, 1_000_000);
    assert.equal(path.counterfactual.legacyBacktest.result.frames[0]?.startingState.quantity, 0);
    assert.equal(path.counterfactual.matchResult.episodes.length, 0);
  }
});

test("uses warmup frames only for features and keeps decisions and fills inside [from,to)", () => {
  const source = input();
  let warmupCandleSeen = false;
  const withBuilder: BuildProspectiveShadowReplayEvidenceInput = { ...source, frameBuilder: (request) => {
    warmupCandleSeen = request.dataset.candles["1h"].some((item) =>
      item.openTime === source.registration.policyManifest.featureWarmupStartAt);
    return [frame(hourBefore(request.decisionFrom)), frame(request.decisionFrom), frame(request.decisionTo)];
  } };
  const evidence = buildProspectiveShadowReplayEvidence(withBuilder);
  const first = evidence.paths[0]!;

  assert.equal(warmupCandleSeen, true);
  assert.equal(first.featureFrameCount, 3);
  assert.equal(first.replayFrameCount, 1);
  assert.equal(first.counterfactual.sourceFrames[0]?.generatedAt, source.registration.window.from);
  assert.equal(first.counterfactual.fills.length, 0);
  assert.equal(first.counterfactual.legacyBacktest.result.frames.length, 1);
  assert.equal(first.cadence.complete, true);
  assert.equal(first.cadence.expectedHourlyIntervals, 2_880);
  assert.equal(first.cadence.observedHourlyIntervals, 2_880);
});

test("accepts authenticated no-trade intervals as complete cadence without synthesizing candles", () => {
  const complete = input();
  const pair = complete.datasets[0]!;
  const missing = pair.dataset.candles["1h"].find((item) => item.openTime === complete.registration.window.from)!;
  pair.dataset.candles["1h"].splice(pair.dataset.candles["1h"].indexOf(missing), 1);
  pair.noTradeEvidence.verifiedNoTradeRanges.push({ from: missing.openTime, to: missing.closeTime });
  resealPair(pair.dataset, pair.noTradeEvidence);
  assert.equal(buildProspectiveShadowReplayEvidence(complete).paths[0]!.cadence.complete, true);
  assert.equal(buildProspectiveShadowReplayEvidence(complete).paths[0]!.cadence.verifiedNoTradeHourlyIntervals, 1);

  const incomplete = input();
  const uncovered = incomplete.datasets[0]!;
  uncovered.dataset.candles["1h"].splice(1, 1);
  resealPair(uncovered.dataset, uncovered.noTradeEvidence);
  assert.equal(buildProspectiveShadowReplayEvidence(incomplete).paths[0]!.cadence.complete, false);
  assert.ok(buildProspectiveShadowReplayEvidence(incomplete).paths[0]!.pathEvidence.incompleteGates.includes("CADENCE"));
});

test("rejects an incomplete registered warmup and accepts its authenticated no-trade coverage", () => {
  const unverified = input();
  const missing = unverified.datasets[0]!.dataset.candles["1h"].find((item) =>
    item.openTime === unverified.registration.policyManifest.featureWarmupStartAt)!;
  unverified.datasets[0]!.dataset.candles["1h"].splice(
    unverified.datasets[0]!.dataset.candles["1h"].indexOf(missing),
    1,
  );
  resealPair(unverified.datasets[0]!.dataset, unverified.datasets[0]!.noTradeEvidence);
  assert.throws(() => buildProspectiveShadowReplayEvidence(unverified), /warmup.*unexplained|unexplained.*warmup/i);

  const verified = input();
  const verifiedMissing = verified.datasets[0]!.dataset.candles["1h"].find((item) =>
    item.openTime === verified.registration.policyManifest.featureWarmupStartAt)!;
  verified.datasets[0]!.dataset.candles["1h"].splice(
    verified.datasets[0]!.dataset.candles["1h"].indexOf(verifiedMissing),
    1,
  );
  verified.datasets[0]!.noTradeEvidence.verifiedNoTradeRanges[0]!.from =
    verified.registration.policyManifest.featureWarmupStartAt;
  resealPair(verified.datasets[0]!.dataset, verified.datasets[0]!.noTradeEvidence);
  assert.doesNotThrow(() => buildProspectiveShadowReplayEvidence(verified));
});

test("keeps valid post-window candle changes out of all replay evidence", () => {
  const baseline = input(true);
  const changed = input(true);
  for (const pair of changed.datasets) {
    const last = pair.dataset.candles["1h"].at(-1)!;
    last.closePrice = 9_999_999;
    last.highPrice = 9_999_999;
    resealPair(pair.dataset, pair.noTradeEvidence);
  }

  assert.deepEqual(
    buildProspectiveShadowReplayEvidence(changed),
    buildProspectiveShadowReplayEvidence(baseline),
  );
});

test("canonicalizes replay provenance so end=to and valid evidence extended after to are identical", () => {
  assert.deepEqual(
    buildProspectiveShadowReplayEvidence(input(false)),
    buildProspectiveShadowReplayEvidence(input(true)),
  );
});

test("requires close-time collection and preserves registered costs, timings, and active scenarios", () => {
  const source = input();
  const valid = buildProspectiveShadowReplayEvidence(source);
  assert.deepEqual(
    [...new Set(valid.paths.map((path) => path.counterfactual.executionTimingProvenance.model))],
    ["SAME_CLOSE_MODELED", "NEXT_FRAME_MODELED"],
  );
  assert.deepEqual(
    [...new Set(valid.paths.filter((path) => path.costId === "BASE").map((path) => path.counterfactual.legacyBacktest.result.metrics.feesKrw))],
    [0],
  );
  assert.deepEqual(
    [...new Set(valid.paths.map((path) => path.counterfactual.executionPolicy?.id))],
    [
      "COMBINED_CONSERVATIVE",
      "COMBINED_MINUS_EARLY_THESIS_FAILURE",
      "COMBINED_MINUS_COOLDOWN_CONTROL",
    ],
  );
  assert.deepEqual(
    valid.paths[0]!.counterfactual.executionPolicy?.id,
    "COMBINED_CONSERVATIVE",
  );
  assert.ok(valid.paths.every((path) => {
    const active = source.registration.policyManifest.scenarios[path.scenario];
    return active.includes("HTF_TREND_GATE") && active.includes("ADD_LIMITED");
  }));

  const normal = input();
  const shortDataset = datasetFor(
    "BTC",
    "KRW-BTC",
    normal.registration.window.from,
    hourAfter(normal.registration.window.from),
    false,
  );
  const premature: BuildProspectiveShadowReplayEvidenceInput = {
    ...normal,
    datasets: [
      { asset: "BTC", dataset: shortDataset, noTradeEvidence: sidecarFor(shortDataset) },
      normal.datasets[1]!,
    ],
  };
  assert.throws(
    () => buildProspectiveShadowReplayEvidence(premature),
    /collected at or after window\.to/i,
  );
});

test("applies exact costs across every timing/cost cell, including successful next-frame fills", () => {
  const source = input();
  const withBuilder: BuildProspectiveShadowReplayEvidenceInput = { ...source, frameBuilder: (request) => [
    frame(hourBefore(request.decisionFrom)),
    entryFrame(request.decisionFrom),
    entryFrame(hourAfter(request.decisionFrom)),
    frame(request.decisionTo),
  ] };
  const evidence = buildProspectiveShadowReplayEvidence(withBuilder);
  const sameCloseBase = evidence.paths.find((path) => path.asset === "BTC" && path.scenario === "COMBINED_CONSERVATIVE" &&
    path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE")!;
  const sameCloseStress = evidence.paths.find((path) => path.asset === "BTC" && path.scenario === "COMBINED_CONSERVATIVE" &&
    path.timing === "SAME_CLOSE_MODELED" && path.costId === "STRESS")!;
  const nextFrameBase = evidence.paths.find((path) => path.asset === "BTC" && path.scenario === "COMBINED_CONSERVATIVE" &&
    path.timing === "NEXT_FRAME_MODELED" && path.costId === "BASE")!;

  assert.equal(sameCloseBase.counterfactual.fills[0]?.feeKrw, 150);
  assert.equal(sameCloseBase.counterfactual.fills[0]?.priceKrw, 100_030);
  assert.equal(sameCloseBase.counterfactual.fills[0]?.volume, 2.999100269919);
  assert.equal(sameCloseStress.counterfactual.fills[0]?.feeKrw, 300);
  assert.equal(sameCloseStress.counterfactual.fills[0]?.priceKrw, 100_200);
  assert.equal(sameCloseStress.counterfactual.fills[0]?.volume, 2.994011976048);
  assert.equal(nextFrameBase.counterfactual.fills[0]?.filledAt, hourAfter(source.registration.window.from));
  assert.equal(nextFrameBase.counterfactual.fills[0]?.priceKrw, 100_030);
  assert.equal(nextFrameBase.counterfactual.legacyBacktest.result.frames[0]?.modeledExecution?.status, "EXECUTED_NEXT_FRAME");
  assert.ok(evidence.paths.every((path) => path.counterfactual.executionTimingProvenance.model === path.timing));
  assert.deepEqual(
    evidence.paths.map((path) => [path.costId, path.counterfactual.fills[0]?.feeKrw ?? null]),
    evidence.paths.map((path) => [path.costId, path.costId === "BASE" ? 150 : 300]),
  );
});

test("preserves partial exits, FIFO realization slices, and unique exact entry relationships", () => {
  const source = input();
  const withBuilder: BuildProspectiveShadowReplayEvidenceInput = { ...source, frameBuilder: (request) => [
    frame(hourBefore(request.decisionFrom)),
    entryFrame(request.decisionFrom),
    reduceFrame(hourAfter(request.decisionFrom)),
    exitFrame(hoursAfter(request.decisionFrom, 2)),
    frame(hoursAfter(request.decisionFrom, 3)),
    frame(request.decisionTo),
  ] };
  const evidence = buildProspectiveShadowReplayEvidence(withBuilder);
  const reference = evidence.paths.find((path) => path.asset === "BTC" && path.scenario === "COMBINED_CONSERVATIVE" &&
    path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE")!;
  const candidate = evidence.paths.find((path) => path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE" &&
    path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE")!;
  const episode = reference.counterfactual.matchResult.episodes[0]!;

  assert.deepEqual(reference.counterfactual.fills.map((fill) => fill.decisionAction), ["ENTER", "REDUCE", "EXIT"]);
  assert.equal(reference.counterfactual.matchResult.episodes.length, 1);
  assert.equal(episode.status, "COMPLETED");
  assert.equal(episode.exitFillIds.length, 2);
  assert.equal(episode.realizationSliceIds.length, 2);
  assert.equal(reference.counterfactual.matchResult.realizationSlices.length, 2);
  assert.equal(candidate.relationshipEvidence.complete, true);
  assert.equal(candidate.relationships?.relationships.length, 1);
  assert.equal(candidate.relationships?.relationships[0]?.relationshipKind, "EXACT_ENTRY_MATCH");
  assert.equal(
    candidate.relationships?.relationships[0]?.reference?.firstEnterDecisionEpochNanoseconds,
    candidate.relationships?.relationships[0]?.ablation?.firstEnterDecisionEpochNanoseconds,
  );
  assert.equal(
    candidate.relationships?.relationships[0]?.entryKeyEpochNanoseconds,
    candidate.relationships?.relationships[0]?.reference?.firstEnterDecisionEpochNanoseconds,
  );
});

test("accepts canonical reference-only and ablation-only keyed relationships", () => {
  const ablationOnly = buildProspectiveShadowReplayEvidence({
    ...input(),
    frameBuilder: (request) => [
      entryFrame(request.decisionFrom),
      exitFrame(hourAfter(request.decisionFrom)),
      entryFrame(hoursAfter(request.decisionFrom, 2)),
      exitFrame(hoursAfter(request.decisionFrom, 3)),
      frame(hoursAfter(request.decisionFrom, 4)),
    ],
  });
  const cooldownRelationship = relationshipFor(ablationOnly, "COMBINED_MINUS_COOLDOWN_CONTROL").relationships
    .find((relationship) => relationship.reference === null && relationship.ablation !== null)!;
  assert.notEqual(cooldownRelationship.entryKeyEpochNanoseconds, null);
  assert.equal(cooldownRelationship.relationshipKind, "ABLATION_ONLY");

  const referenceOnly = buildProspectiveShadowReplayEvidence({
    ...input(),
    frameBuilder: (request) => [
      entryFrame(request.decisionFrom),
      earlyFailureFrame(hourAfter(request.decisionFrom)),
      entryFrame(hoursAfter(request.decisionFrom, 26)),
      earlyFailureFrame(hoursAfter(request.decisionFrom, 27)),
      frame(hoursAfter(request.decisionFrom, 28)),
    ],
  });
  const earlyFailureRelationships = relationshipFor(referenceOnly, "COMBINED_MINUS_EARLY_THESIS_FAILURE").relationships;
  const earlyFailureRelationship = earlyFailureRelationships
    .find((relationship) => relationship.reference !== null && relationship.ablation === null);
  assert.ok(earlyFailureRelationship);
  assert.notEqual(earlyFailureRelationship.entryKeyEpochNanoseconds, null);
  assert.ok(["REFERENCE_ONLY_LOSS", "REFERENCE_ONLY_GAIN"].includes(earlyFailureRelationship.relationshipKind));
});

test("propagates cadence and feature gaps to every evaluator metric and known-net support", () => {
  const incomplete = buildProspectiveShadowReplayEvidence(input()).paths[0]!;
  assert.ok(incomplete.pathEvidence.incompleteGates.includes("FEATURE_COVERAGE"));
  assert.equal(incomplete.pathEvidence.completedKnownNetEpisodes, 0);
  assert.ok(Object.values(incomplete.pathEvidence.metrics).every((metric) => metric.complete === false));
  assert.ok(Object.values(incomplete.pathEvidence.metrics).every((metric) => metric.value === null));
});

test("detaches and deeply freezes replay evidence before caller-owned inputs can change", () => {
  const source = input();
  const evidence = buildProspectiveShadowReplayEvidence(source);
  const saved = JSON.stringify(evidence);

  source.datasets[0]!.dataset.candles["1h"][0]!.closePrice = 777;
  (source.minimumCompletedCandles as { "1h": number })["1h"] = 2;
  assert.equal(JSON.stringify(evidence), saved);
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.paths), true);
  assert.equal(Object.isFrozen(evidence.paths[0]), true);
  assert.equal(Object.isFrozen(evidence.paths[0]!.counterfactual.fills), true);
  assert.throws(() => {
    (evidence.paths as unknown as unknown[]).push({});
  }, TypeError);
});

test("snapshots caller configuration before an asynchronous read-only evidence reader resolves", async () => {
  const baseline = input();
  const mutable = input();
  let resolve: ((value: BuildProspectiveShadowReplayEvidenceInput["datasets"]) => void) | undefined;
  const pending = buildProspectiveShadowReplayEvidenceFromReader({
    registration: mutable.registration,
    frameBuilder: mutable.frameBuilder,
    minimumCompletedCandles: mutable.minimumCompletedCandles,
    requiredFeatureLookbackCandles: mutable.requiredFeatureLookbackCandles,
    reader: {
      read: () => new Promise((done) => { resolve = done; }),
    },
  });

  (mutable.minimumCompletedCandles as { "1h": number })["1h"] = 999;
  mutable.datasets[0]!.dataset.candles["1h"][0]!.closePrice = 777;
  resolve?.(baseline.datasets);

  assert.deepEqual(await pending, buildProspectiveShadowReplayEvidence(baseline));
});

test("rejects duplicate exact first-ENTER epoch-nanosecond relationship keys at the replay boundary", () => {
  const source = replayWithCompletedEpisode();
  assert.throws(() => buildProspectiveShadowReplayEvidence({
    ...source,
    relationshipAnalyzer: (request) => {
      const result = structuredClone(analyzeHoldoutEpisodeAttribution(request));
      const exact = result.relationships.find((relationship) => relationship.relationshipKind === "EXACT_ENTRY_MATCH")!;
      (result.relationships as unknown as unknown[]).push(structuredClone(exact));
      return result;
    },
  }), /duplicate exact first-ENTER epoch-nanosecond relationship key/i);
});

test("rejects cross-path fallback when an injected exact relationship has different entry keys", () => {
  const source = replayWithCompletedEpisode();
  assert.throws(() => buildProspectiveShadowReplayEvidence({
    ...source,
    relationshipAnalyzer: (request) => {
      const result = structuredClone(analyzeHoldoutEpisodeAttribution(request));
      const exact = result.relationships.find((relationship) => relationship.relationshipKind === "EXACT_ENTRY_MATCH")!;
      const reference = exact.reference!;
      const ablation = exact.ablation!;
      (exact as { ablation: typeof ablation }).ablation = {
        ...ablation,
        firstEnterDecisionEpochNanoseconds: (BigInt(reference.firstEnterDecisionEpochNanoseconds!) + 1n).toString(),
      };
      return result;
    },
  }), /exact entry relationship key mismatch; no cross-path fallback/i);
});

test("orders same-side fills at the same instant by fill ID at the replay output boundary", () => {
  const source = input();
  const evidence = buildProspectiveShadowReplayEvidence({
    ...source,
    frameBuilder: (request) => [entryFrame(request.decisionFrom), frame(hourAfter(request.decisionFrom))],
  });
  const counterfactual = evidence.paths.find((path) => path.asset === "BTC" && path.scenario === "COMBINED_CONSERVATIVE" &&
    path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE")!.counterfactual;
  const first = counterfactual.fills[0]!;
  const fills = orderProspectiveShadowReplayCounterfactualFills({
    ...counterfactual,
    fills: [
      { ...first, id: `${first.id}:z`, orderId: `${first.orderId}:z` },
      { ...first, id: `${first.id}:a`, orderId: `${first.orderId}:a` },
    ],
  }).fills;

  assert.equal(fills.length, 2);
  assert.equal(fills[0]!.side, fills[1]!.side);
  assert.equal(fills[0]!.filledAt, fills[1]!.filledAt);
  assert.deepEqual(fills.map((fill) => fill.id), [...fills].map((fill) => fill.id).sort());
});

test("keeps injected unknown fee and lifecycle evidence explicit and propagates both to all dependent metrics", () => {
  const source = input();
  const evidence = buildProspectiveShadowReplayEvidence({
    ...source,
    frameBuilder: (request) => [entryFrame(request.decisionFrom), frame(hourAfter(request.decisionFrom))],
  });
  const path = evidence.paths.find((candidate) => candidate.asset === "BTC" &&
    candidate.scenario === "COMBINED_CONSERVATIVE" && candidate.timing === "SAME_CLOSE_MODELED" && candidate.costId === "BASE")!;
  const counterfactual = structuredClone(path.counterfactual);
  const first = counterfactual.fills[0]!;
  counterfactual.fills = [
    { ...first, feeKrw: null },
    {
      ...first,
      id: `${first.id}:unmatched-exit`,
      orderId: `${first.orderId}:unmatched-exit`,
      strategyDecisionId: `${first.strategyDecisionId}:unmatched-exit`,
      decisionAction: "EXIT",
      side: "ask",
      volume: first.volume * 2,
      filledAt: hourAfter(first.filledAt),
    },
  ];
  counterfactual.matchResult = matchPerformanceTrades({ fills: counterfactual.fills });
  assert.throws(() => buildProspectiveShadowReplayEvidence({
    ...source,
    frameBuilder: (request) => [entryFrame(request.decisionFrom), frame(hourAfter(request.decisionFrom))],
    counterfactualRunner: () => [counterfactual],
  }), /not canonically identical/i);
  const assessed = inspectProspectiveShadowReplayPathEvidence({ registration: source.registration, path, counterfactual });

  assert.equal(assessed.feeEvidence.complete, false);
  assert.match(assessed.feeEvidence.unknownReason!, /unknown or invalid fee/i);
  assert.equal(assessed.lifecycleEvidence.complete, false);
  assert.match(assessed.lifecycleEvidence.unknownReason!, /unmatched sells/i);
  assert.ok(assessed.pathEvidence.incompleteGates.includes("FEE_EVIDENCE"));
  assert.ok(assessed.pathEvidence.incompleteGates.includes("LIFECYCLE"));
  assert.equal(assessed.pathEvidence.completedKnownNetEpisodes, 0);
  assert.ok(Object.values(assessed.pathEvidence.metrics).every((metric) => metric.complete === false && metric.value === null));
});

test("rejects a counterfactual seam that forges fresh state, metrics, or episode support", () => {
  const source = input();
  assert.throws(() => buildProspectiveShadowReplayEvidence({
    ...source,
    counterfactualRunner: (request) => {
      const result = structuredClone(runCounterfactualScenarios(request)[0]!);
      result.legacyBacktest.result.frames[0]!.startingState.cashKrw = 1;
      result.legacyBacktest.result.metrics.totalReturnPct = 999;
      result.diagnostics.markets[request.market].completedEpisodeCount = 999;
      return [result];
    },
  }), /not canonically identical/i);
});

test("rejects a relationship seam that forges empty relationship evidence", () => {
  const source = replayWithCompletedEpisode();
  assert.throws(() => buildProspectiveShadowReplayEvidence({
    ...source,
    relationshipAnalyzer: (request) => {
      const result = structuredClone(analyzeHoldoutEpisodeAttribution(request));
      (result as unknown as { relationships: unknown[] }).relationships = [];
      return result;
    },
  }), /not canonically identical/i);
});

test("rejects duplicate and mismatched non-primary relationships with non-null exact entry keys", () => {
  const evidence = buildProspectiveShadowReplayEvidence(replayWithCompletedEpisode());
  const canonical = evidence.paths.find((path) => path.asset === "BTC" &&
    path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE" && path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE")!.relationships!;
  const duplicate = structuredClone(canonical);
  const exact = duplicate.relationships.find((relationship) => relationship.entryKeyEpochNanoseconds !== null)!;
  (exact as { relationshipKind: string }).relationshipKind = "OPEN_AT_TO";
  (duplicate.relationships as unknown as unknown[]).push(structuredClone(exact));
  assert.throws(() => validateProspectiveShadowReplayRelationshipEvidence(canonical, duplicate), /duplicate exact first-ENTER/i);

  const mismatched = structuredClone(canonical);
  const relationship = mismatched.relationships.find((candidate) => candidate.entryKeyEpochNanoseconds !== null)!;
  (relationship as { relationshipKind: string }).relationshipKind = "EXIT_TIMING_CHANGED";
  (relationship as { ablation: NonNullable<typeof relationship.ablation> }).ablation = {
    ...relationship.ablation!,
    firstEnterDecisionEpochNanoseconds: (BigInt(relationship.entryKeyEpochNanoseconds!) + 1n).toString(),
  };
  assert.throws(() => validateProspectiveShadowReplayRelationshipEvidence(canonical, mismatched), /no cross-path fallback/i);
});

function replayWithCompletedEpisode(): BuildProspectiveShadowReplayEvidenceInput {
  const source = input();
  return {
    ...source,
    frameBuilder: (request) => [
      entryFrame(request.decisionFrom),
      reduceFrame(hourAfter(request.decisionFrom)),
      exitFrame(hoursAfter(request.decisionFrom, 2)),
      frame(hoursAfter(request.decisionFrom, 3)),
    ],
  };
}

function relationshipFor(
  evidence: ReturnType<typeof buildProspectiveShadowReplayEvidence>,
  scenario: "COMBINED_MINUS_EARLY_THESIS_FAILURE" | "COMBINED_MINUS_COOLDOWN_CONTROL",
) {
  return evidence.paths.find((path) => path.asset === "BTC" && path.scenario === scenario &&
    path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE")!.relationships!;
}

function input(includePostWindowCandle = false): BuildProspectiveShadowReplayEvidenceInput {
  const registration = createProspectiveShadowRegistration({
    registeredAt: "2026-08-20T00:00:00Z",
    implementationCommitSha: "a".repeat(40),
    developmentAuthoritySha256: "b".repeat(64),
    retrospectiveReportSha256: "c".repeat(64),
    policyManifest: PROSPECTIVE_SHADOW_POLICY_MANIFEST,
  });
  const datasets = registration.matrix.assets.map(({ asset, market }) => {
    const dataset = datasetFor(asset, market, registration.window.from, registration.window.to, includePostWindowCandle);
    const noTradeEvidence = sidecarFor(dataset);
    noTradeEvidence.verifiedNoTradeRanges.push({
      from: hourAfter(registration.policyManifest.featureWarmupStartAt),
      to: registration.window.from,
    });
    resealPair(dataset, noTradeEvidence);
    return { asset, dataset, noTradeEvidence };
  });
  return {
    registration,
    datasets,
    frameBuilder: (request) => [
      frame(hourBefore(request.decisionFrom)),
      frame(request.decisionFrom),
      frame(request.decisionTo),
    ],
    minimumCompletedCandles: { "1h": 1, "4h": 1, "1d": 1 },
    requiredFeatureLookbackCandles: 1,
  };
}

function datasetFor(
  asset: "BTC" | "ETH",
  market: "KRW-BTC" | "KRW-ETH",
  from: string,
  to: string,
  includePostWindowCandle: boolean,
): ResearchCandleDataset {
  const end = includePostWindowCandle ? hourAfter(to) : to;
  const hours = hoursBetween(from, end);
  const withoutChecksum = {
    provenance: {
      schemaVersion: 1 as const,
      asset,
      market,
      historyStartAt: PROSPECTIVE_SHADOW_POLICY_MANIFEST.featureWarmupStartAt,
      endAt: end,
      collectedAt: hourAfter(end),
      source: "synthetic-immutable-fixture",
    },
    candles: {
      "1h": hours.map((openTime) => candle(market, "1h", openTime)),
      "4h": [],
      "1d": [],
    },
  };
  withoutChecksum.candles["1h"].unshift(candle(market, "1h", PROSPECTIVE_SHADOW_POLICY_MANIFEST.featureWarmupStartAt));
  return {
    ...withoutChecksum,
    provenance: {
      ...withoutChecksum.provenance,
      sha256: calculateResearchCandleDatasetChecksum(withoutChecksum),
    },
  };
}

function sidecarFor(dataset: ResearchCandleDataset): ResearchNoTradeEvidence {
  const withoutChecksum = {
    provenance: {
      schemaVersion: 1 as const,
      evidenceKind: "INDEPENDENT_NO_TRADE_EVIDENCE_V1" as const,
      asset: dataset.provenance.asset,
      market: dataset.provenance.market,
      parentDatasetSha256: dataset.provenance.sha256,
      from: dataset.provenance.historyStartAt,
      to: dataset.provenance.endAt,
      source: "synthetic-immutable-sidecar",
      lowerTimeframe: "1m" as const,
      collectorVersion: "test",
      collectedAt: dataset.provenance.collectedAt,
    },
    querySegments: [{
      from: dataset.provenance.historyStartAt,
      to: dataset.provenance.endAt,
      paginationComplete: true,
      responseFingerprint: "d".repeat(64),
    }],
    verifiedNoTradeRanges: [],
  };
  return {
    ...withoutChecksum,
    provenance: {
      ...withoutChecksum.provenance,
      sha256: computeResearchNoTradeEvidenceSha256(withoutChecksum),
    },
  };
}

function resealPair(dataset: ResearchCandleDataset, sidecar: ResearchNoTradeEvidence): void {
  const { sha256: _datasetSha, ...datasetProvenance } = dataset.provenance;
  dataset.provenance.sha256 = calculateResearchCandleDatasetChecksum({
    provenance: datasetProvenance,
    candles: dataset.candles,
  });
  sidecar.provenance.parentDatasetSha256 = dataset.provenance.sha256;
  const { sha256: _sidecarSha, ...sidecarProvenance } = sidecar.provenance;
  sidecar.provenance.sha256 = computeResearchNoTradeEvidenceSha256({
    provenance: sidecarProvenance,
    querySegments: sidecar.querySegments,
    verifiedNoTradeRanges: sidecar.verifiedNoTradeRanges,
  });
}

function frame(generatedAt: string): PositionGuardBacktestFrame {
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
    },
    source: {
      candleCounts: { "1h": 1, "4h": 1, "1d": 1 },
      latestCloseTime: { "1h": generatedAt, "4h": generatedAt, "1d": generatedAt },
    },
  };
}

function entryFrame(generatedAt: string): PositionGuardBacktestFrame {
  const value = frame(generatedAt);
  return {
    ...value,
    analysis: {
      ...value.analysis,
      regime: "BULL_TREND",
      entryPath: "RECLAIM",
      reclaimStructure: true,
      trendAlignmentScore: 4,
      recoveryQualityScore: 4,
      volumeRecovery: true,
      macdImproving: true,
      rsiRecovery: true,
    },
  };
}

function reduceFrame(generatedAt: string): PositionGuardBacktestFrame {
  const value = frame(generatedAt);
  return {
    ...value,
    analysis: {
      ...value.analysis,
      regime: "RANGE",
      currentPrice: 110_000,
      weakeningStage: "SOFT",
      upperRangeChase: true,
      breakdownPressureScore: 2,
    },
  };
}

function exitFrame(generatedAt: string): PositionGuardBacktestFrame {
  const value = frame(generatedAt);
  return {
    ...value,
    analysis: {
      ...value.analysis,
      regime: "BREAKDOWN_RISK",
      currentPrice: 90_000,
      invalidationState: "BROKEN",
      breakdown1d: true,
      breakdown4h: true,
      bearishMomentumExpansion: true,
    },
  };
}

function earlyFailureFrame(generatedAt: string): PositionGuardBacktestFrame {
  const value = frame(generatedAt);
  return {
    ...value,
    analysis: {
      ...value.analysis,
      currentPrice: 90_000,
      pnlPct: -0.1,
      failedReclaim: true,
      weakeningStage: "FAILURE",
      recoveryQualityScore: 1,
    },
  };
}

function candle(market: "KRW-BTC" | "KRW-ETH", timeframe: "1h", openTime: string) {
  return {
    market,
    timeframe,
    openTime,
    closeTime: hourAfter(openTime),
    openPrice: 100_000,
    highPrice: 100_000,
    lowPrice: 100_000,
    closePrice: 100_000,
    volume: 1,
    quoteVolume: 100_000,
  };
}

function hoursBetween(from: string, to: string): string[] {
  const values: string[] = [];
  for (let time = Date.parse(from); time < Date.parse(to); time += 60 * 60 * 1000) {
    values.push(new Date(time).toISOString());
  }
  return values;
}

function hourBefore(value: string): string {
  return new Date(Date.parse(value) - 60 * 60 * 1000).toISOString();
}

function hourAfter(value: string): string {
  return new Date(Date.parse(value) + 60 * 60 * 1000).toISOString();
}

function hoursAfter(value: string, count: number): string {
  return new Date(Date.parse(value) + count * 60 * 60 * 1000).toISOString();
}

void runRegisteredTests();
