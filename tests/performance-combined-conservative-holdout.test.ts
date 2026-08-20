import assert from "node:assert/strict";

import {
  evaluateCombinedConservativeHoldout,
  type CombinedConservativeHoldoutInput,
  type CombinedConservativeHoldoutMatrixCell,
} from "../src/modules/performance/performance-combined-conservative-holdout.js";
import { test } from "./harness.js";

test("preserves normalized [from,to) holdout boundaries without widening either endpoint", () => {
  const input = passingInput();
  input.assets[0]!.holdout = {
    from: "2026-05-01T09:00:00+09:00",
    to: "2026-05-02T09:00:00+09:00",
  };
  input.assets[0]!.dataset.endAt = "2026-05-02T00:00:00.000Z";

  const result = evaluateCombinedConservativeHoldout(input);

  assert.deepEqual(result.assets[0]!.holdout, {
    from: "2026-05-01T00:00:00.000Z",
    to: "2026-05-02T00:00:00.000Z",
  });
  assert.equal(result.phase, "PROSPECTIVE_SHADOW");
});

test("rejects a known directional failure even when the same asset has insufficient evidence", () => {
  const input = passingInput();
  const btcCandidate = cell(input, "BTC", "SAME_CLOSE_MODELED", "BASE", "COMBINED_CONSERVATIVE");
  btcCandidate.coverage.cadenceComplete = false;
  btcCandidate.completedEpisodeCount = 2;
  cell(input, "BTC", "NEXT_FRAME_MODELED", "BASE", "COMBINED_CONSERVATIVE").netReturnPct = 0.04;

  const result = evaluateCombinedConservativeHoldout(input);
  const btc = result.assets[0]!;

  assert.equal(btc.asset, "BTC");
  assert.equal(btc.status, "REJECTED");
  assert.ok(btc.comparisons.some((comparison) => comparison.metric === "NET_RETURN_PCT" && comparison.outcome === "FAIL"));
  assert.equal(btc.evidenceComplete, false);
});

test("keeps a favorable but incomplete asset insufficient", () => {
  const input = passingInput();
  cell(input, "ETH", "NEXT_FRAME_MODELED", "STRESS", "COMBINED_CONSERVATIVE").coverage.feeComplete = false;

  const result = evaluateCombinedConservativeHoldout(input);

  assert.equal(result.assets[1]!.asset, "ETH");
  assert.equal(result.assets[1]!.status, "INSUFFICIENT");
  assert.ok(result.assets[1]!.comparisons.every((comparison) => comparison.outcome !== "FAIL"));
});

test("supports continued shadow only with complete favorable evidence and fixed policy", () => {
  const result = evaluateCombinedConservativeHoldout(passingInput());

  assert.equal(result.candidate, "COMBINED_CONSERVATIVE");
  assert.equal(result.readOnly, true);
  assert.equal(result.deploymentApproval, false);
  assert.match(result.interpretationBoundary, /not.*deployment approval/i);
  assert.deepEqual(result.assets.map((asset) => asset.status), [
    "SUPPORTS_CONTINUED_SHADOW",
    "SUPPORTS_CONTINUED_SHADOW",
  ]);
  assert.equal(result.assets[0]!.comparisons.length, 32);
  assert.deepEqual(result.assets[0]!.comparisons[0], {
    timing: "SAME_CLOSE_MODELED",
    cost: "BASE",
    anchor: "BASELINE",
    metric: "NET_RETURN_PCT",
    candidateValue: 0.12,
    anchorValue: 0.1,
    delta: 2,
    tolerance: 0.000001,
    valueUnit: "RATIO",
    deltaUnit: "PERCENTAGE_POINTS",
    outcome: "PASS",
  });
});

test("classifies phase retrospectively when any asset begins before authority freeze", () => {
  const input = passingInput();
  for (const asset of input.assets) {
    asset.holdout.from = "2026-04-12T19:00:00.000Z";
    syncRangeProvenance(input, asset.asset);
  }

  const result = evaluateCombinedConservativeHoldout(input);

  assert.equal(result.phase, "RETROSPECTIVE_HOLDOUT");
});

test("requires identical BTC and ETH holdout ranges and exact retrospective cutoff starts", () => {
  const differentRanges = passingInput();
  differentRanges.assets[1]!.holdout.to = "2026-05-03T00:00:00.000Z";
  differentRanges.assets[1]!.dataset.endAt = "2026-05-03T00:00:00.000Z";
  differentRanges.assets[1]!.dataset.collectedAt = "2026-05-03T01:00:00.000Z";
  syncRangeProvenance(differentRanges, "ETH");
  assert.throws(() => evaluateCombinedConservativeHoldout(differentRanges), /identical.*holdout/i);

  const retrospectiveNotAtCutoff = passingInput();
  retrospectiveNotAtCutoff.authority.frozenAt = "2026-05-04T00:00:00.000Z";
  for (const asset of retrospectiveNotAtCutoff.assets) {
    asset.authorityFrozenAt = retrospectiveNotAtCutoff.authority.frozenAt;
  }
  assert.throws(() => evaluateCombinedConservativeHoldout(retrospectiveNotAtCutoff), /retrospective.*development cutoff/i);

  const prospectiveBeforeFreeze = passingInput();
  prospectiveBeforeFreeze.authority.frozenAt = "2026-05-02T00:00:00.000Z";
  for (const asset of prospectiveBeforeFreeze.assets) {
    asset.authorityFrozenAt = prospectiveBeforeFreeze.authority.frozenAt;
  }
  assert.throws(() => evaluateCombinedConservativeHoldout(prospectiveBeforeFreeze), /retrospective.*development cutoff/i);
});

test("preserves exact matrix and dataset provenance and rejects mismatches", () => {
  const result = roundOneResult(evaluateCombinedConservativeHoldout(passingInput()));
  assert.deepEqual(result.assets[0]!.dataset, {
    collectedAt: "2026-05-02T01:00:00.000Z",
    endAt: "2026-05-02T00:00:00.000Z",
    checksum: "a".repeat(64),
    fingerprint: "frames-BTC-v1",
    holdoutFrom: "2026-05-01T00:00:00.000Z",
    holdoutTo: "2026-05-02T00:00:00.000Z",
    noTradeEvidenceChecksum: "c".repeat(64),
    initialStateFingerprint: "initial-BTC-v1",
    developmentFrameFingerprint: "development-BTC-v1",
    replayFrameFingerprint: "replay-BTC-v1",
  });
  assert.equal(result.assets[0]!.matrix[0]!.replayFrameFingerprint, "replay-BTC-v1");

  const mismatch = passingInput();
  Object.assign(cell(mismatch, "BTC", "SAME_CLOSE_MODELED", "BASE", "BASELINE"), {
    noTradeEvidenceChecksum: "d".repeat(64),
  });
  assert.throws(() => evaluateCombinedConservativeHoldout(mismatch), /no-trade.*checksum/i);
});

test("requires exactly six boolean coverage keys and reports unknown comparisons for incomplete coverage", () => {
  const missingCoverage = passingInput();
  delete (cell(missingCoverage, "BTC", "SAME_CLOSE_MODELED", "BASE", "BASELINE").coverage as Record<string, unknown>).feeComplete;
  assert.throws(() => evaluateCombinedConservativeHoldout(missingCoverage), /coverage.*exactly/i);

  const extraCoverage = passingInput();
  (cell(extraCoverage, "BTC", "SAME_CLOSE_MODELED", "BASE", "BASELINE").coverage as Record<string, unknown>).unexpected = true;
  assert.throws(() => evaluateCombinedConservativeHoldout(extraCoverage), /coverage.*exactly/i);

  const incomplete = passingInput();
  cell(incomplete, "BTC", "SAME_CLOSE_MODELED", "BASE", "COMBINED_CONSERVATIVE").coverage.feeComplete = false;
  const result = roundOneResult(evaluateCombinedConservativeHoldout(incomplete));
  const comparison = result.assets[0]!.comparisons.find((item) =>
    item.timing === "SAME_CLOSE_MODELED" && item.cost === "BASE" && item.anchor === "BASELINE" && item.metric === "NET_RETURN_PCT",
  );
  assert.equal(comparison?.outcome, "PASS");
  assert.equal(result.assets[0]!.status, "INSUFFICIENT");
  assert.deepEqual(result.assets[0]!.reasonCodes, ["INCOMPLETE_COVERAGE"]);
});

test("scopes missing fee evidence to fee comparisons and separates value and delta units", () => {
  const input = passingInput();
  cell(input, "BTC", "SAME_CLOSE_MODELED", "BASE", "COMBINED_CONSERVATIVE").coverage.feeComplete = false;

  const result = roundOneResult(evaluateCombinedConservativeHoldout(input));
  const comparisons = result.assets[0]!.comparisons.filter((item) =>
    item.timing === "SAME_CLOSE_MODELED" && item.cost === "BASE" && item.anchor === "BASELINE",
  );

  assert.deepEqual(
    comparisons.map((item) => [item.metric, item.outcome]),
    [
      ["NET_RETURN_PCT", "PASS"],
      ["MAX_DRAWDOWN_PCT", "PASS"],
      ["TURNOVER_KRW", "PASS"],
      ["FEES_KRW", "UNKNOWN"],
    ],
  );
  assert.deepEqual(comparisons[0] && pickComparisonUnitNames(comparisons[0]), {
    valueUnit: "RATIO",
    deltaUnit: "PERCENTAGE_POINTS",
  });
  assert.deepEqual(comparisons[3] && pickComparisonUnitNames(comparisons[3]), {
    valueUnit: "KRW",
    deltaUnit: "KRW",
  });
  assert.equal(result.assets[0]!.status, "INSUFFICIENT");
  assert.deepEqual(result.assets[0]!.reasonCodes, ["INCOMPLETE_COVERAGE"]);
});

test("uses percentage points for ratio metrics, KRW tolerance for monetary metrics, and anchor support", () => {
  const input = passingInput();
  cell(input, "BTC", "SAME_CLOSE_MODELED", "BASE", "COMBINED_CONSERVATIVE").feesKrw = 10.0000000005;
  const result = roundOneResult(evaluateCombinedConservativeHoldout(input));
  const net = result.assets[0]!.comparisons.find((item) => item.metric === "NET_RETURN_PCT");
  const drawdown = result.assets[0]!.comparisons.find((item) => item.metric === "MAX_DRAWDOWN_PCT");
  const fees = result.assets[0]!.comparisons.find((item) => item.metric === "FEES_KRW");
  assert.deepEqual(net && pickComparisonUnits(net), {
    delta: 2,
    tolerance: 0.000001,
    valueUnit: "RATIO",
    deltaUnit: "PERCENTAGE_POINTS",
  });
  assert.deepEqual(drawdown && pickComparisonUnits(drawdown), {
    delta: -2,
    tolerance: 0.000001,
    valueUnit: "RATIO",
    deltaUnit: "PERCENTAGE_POINTS",
  });
  assert.deepEqual(fees && pickComparisonUnits(fees), {
    delta: 5e-10,
    tolerance: 0.000000001,
    valueUnit: "KRW",
    deltaUnit: "KRW",
  });
  assert.equal(fees?.outcome, "PASS");

  const anchorInsufficient = passingInput();
  cell(anchorInsufficient, "ETH", "NEXT_FRAME_MODELED", "STRESS", "NO_ADD").completedEpisodeCount = 9;
  const insufficient = roundOneResult(evaluateCombinedConservativeHoldout(anchorInsufficient));
  assert.equal(insufficient.assets[1]!.status, "INSUFFICIENT");
  assert.deepEqual(insufficient.assets[1]!.reasonCodes, ["ANCHOR_COMPLETED_EPISODES_BELOW_MINIMUM"]);
});

test("enforces timestamp ordering and JSON-safe numeric evidence", () => {
  const collectedBeforeEnd = passingInput();
  collectedBeforeEnd.assets[0]!.dataset.collectedAt = "2026-05-01T23:59:59.999Z";
  assert.throws(() => evaluateCombinedConservativeHoldout(collectedBeforeEnd), /collectedAt.*endAt/i);

  const frozenBeforeDevelopment = passingInput();
  frozenBeforeDevelopment.authority.frozenAt = "2026-04-12T18:59:59.999Z";
  for (const asset of frozenBeforeDevelopment.assets) asset.authorityFrozenAt = frozenBeforeDevelopment.authority.frozenAt;
  assert.throws(() => evaluateCombinedConservativeHoldout(frozenBeforeDevelopment), /frozenAt.*development cutoff/i);

  const negativeZero = passingInput();
  cell(negativeZero, "ETH", "SAME_CLOSE_MODELED", "BASE", "BASELINE").turnoverKrw = -0;
  assert.throws(() => evaluateCombinedConservativeHoldout(negativeZero), /negative zero/i);

  const negativeZeroCount = passingInput();
  cell(negativeZeroCount, "ETH", "SAME_CLOSE_MODELED", "BASE", "BASELINE").completedEpisodeCount = -0;
  assert.throws(() => evaluateCombinedConservativeHoldout(negativeZeroCount), /negative zero/i);

  const jsonRoundTrip = JSON.parse(JSON.stringify(passingInput())) as CombinedConservativeHoldoutInput;
  const result = evaluateCombinedConservativeHoldout(jsonRoundTrip);
  assert.equal(JSON.parse(JSON.stringify(result)).assets[1].asset, "ETH");
});

test("rejects malformed ranges, provenance, metrics, and matrix shape while keeping BTC then ETH output order", () => {
  const ordered = passingInput();
  ordered.assets.reverse();
  assert.deepEqual(evaluateCombinedConservativeHoldout(ordered).assets.map((asset) => asset.asset), ["BTC", "ETH"]);

  const invalidTimestamp = passingInput();
  invalidTimestamp.assets[0]!.holdout.from = "2026-05-01T00:00:00";
  assert.throws(() => evaluateCombinedConservativeHoldout(invalidTimestamp), /explicit timezone/i);

  const overlapsDevelopment = passingInput();
  overlapsDevelopment.assets[0]!.holdout.from = "2026-04-11T19:00:00.000Z";
  assert.throws(() => evaluateCombinedConservativeHoldout(overlapsDevelopment), /overlaps development/i);

  const beyondDataset = passingInput();
  beyondDataset.assets[0]!.dataset.endAt = "2026-05-01T12:00:00.000Z";
  assert.throws(() => evaluateCombinedConservativeHoldout(beyondDataset), /endAt.*holdout\.to/i);

  const wrongMarket = passingInput();
  wrongMarket.assets[0]!.market = "KRW-ETH";
  assert.throws(() => evaluateCombinedConservativeHoldout(wrongMarket), /market.*does not match asset/i);

  const wrongProvenance = passingInput();
  cell(wrongProvenance, "BTC", "SAME_CLOSE_MODELED", "BASE", "BASELINE").datasetChecksum = "f".repeat(64);
  assert.throws(() => evaluateCombinedConservativeHoldout(wrongProvenance), /dataset checksum/i);

  const duplicate = passingInput();
  duplicate.assets[0]!.matrix.push({ ...duplicate.assets[0]!.matrix[0]! });
  assert.throws(() => evaluateCombinedConservativeHoldout(duplicate), /duplicate matrix cell/i);

  const missing = passingInput();
  missing.assets[0]!.matrix = missing.assets[0]!.matrix.filter((item) => item.scenario !== "NO_ADD");
  assert.throws(() => evaluateCombinedConservativeHoldout(missing), /exactly one.*NO_ADD/i);

  const invalidMetric = passingInput();
  cell(invalidMetric, "ETH", "NEXT_FRAME_MODELED", "STRESS", "COMBINED_CONSERVATIVE").feesKrw = -1;
  assert.throws(() => evaluateCombinedConservativeHoldout(invalidMetric), /feesKrw.*non-negative/i);

  const wrongPolicy = passingInput();
  wrongPolicy.policy.minimumCompletedEpisodes = 9;
  assert.throws(() => evaluateCombinedConservativeHoldout(wrongPolicy), /minimumCompletedEpisodes.*10/i);
});

function passingInput(): CombinedConservativeHoldoutInput {
  const input: CombinedConservativeHoldoutInput = {
    authority: {
      version: "BROAD_LOSS_CAUSE_V1",
      frozenAt: "2026-05-01T00:00:00.000Z",
      developmentCutoff: "2026-04-12T19:00:00.000Z",
    },
    policy: {
      candidate: "COMBINED_CONSERVATIVE",
      minimumCompletedEpisodes: 10,
      comparisonTolerancePercentagePoints: 0.000001,
      comparisonToleranceKrw: 0.000000001,
    },
    assets: [assetInput("BTC"), assetInput("ETH")],
  };
  return addRoundOneContract(input);
}

function assetInput(asset: "BTC" | "ETH"): CombinedConservativeHoldoutInput["assets"][number] {
  const market = asset === "BTC" ? "KRW-BTC" : "KRW-ETH";
  const checksum = asset === "BTC" ? "a".repeat(64) : "b".repeat(64);
  const fingerprint = `frames-${asset}-v1`;
  const noTradeEvidenceChecksum = asset === "BTC" ? "c".repeat(64) : "d".repeat(64);
  return {
    asset,
    market,
    authorityVersion: "BROAD_LOSS_CAUSE_V1",
    authorityFrozenAt: "2026-05-01T00:00:00.000Z",
    holdout: {
      from: "2026-05-01T00:00:00.000Z",
      to: "2026-05-02T00:00:00.000Z",
    },
    dataset: {
      asset,
      market,
      collectedAt: "2026-05-02T01:00:00.000Z",
      endAt: "2026-05-02T00:00:00.000Z",
      checksum,
      fingerprint,
      holdoutFrom: "2026-05-01T00:00:00.000Z",
      holdoutTo: "2026-05-02T00:00:00.000Z",
      noTradeEvidenceChecksum,
      initialStateFingerprint: `initial-${asset}-v1`,
      developmentFrameFingerprint: `development-${asset}-v1`,
      replayFrameFingerprint: `replay-${asset}-v1`,
    },
    matrix: (["SAME_CLOSE_MODELED", "NEXT_FRAME_MODELED"] as const).flatMap((timing) =>
      (["BASE", "STRESS"] as const).flatMap((cost) => [
        metric(asset, market, timing, cost, "BASELINE", checksum, fingerprint, 0.1),
        metric(asset, market, timing, cost, "NO_ADD", checksum, fingerprint, 0.11),
        metric(asset, market, timing, cost, "COMBINED_CONSERVATIVE", checksum, fingerprint, 0.12),
      ]),
    ),
  };
}

function metric(
  asset: "BTC" | "ETH",
  market: "KRW-BTC" | "KRW-ETH",
  timing: CombinedConservativeHoldoutMatrixCell["timing"],
  cost: CombinedConservativeHoldoutMatrixCell["cost"],
  scenario: CombinedConservativeHoldoutMatrixCell["scenario"],
  datasetChecksum: string,
  datasetFingerprint: string,
  netReturnPct: number,
): CombinedConservativeHoldoutMatrixCell {
  const scenarioOffset = scenario === "BASELINE" ? 0 : scenario === "NO_ADD" ? 1 : 2;
  return {
    asset,
    market,
    timing,
    cost,
    scenario,
    holdoutFrom: "2026-05-01T00:00:00.000Z",
    holdoutTo: "2026-05-02T00:00:00.000Z",
    datasetChecksum,
    noTradeEvidenceChecksum: asset === "BTC" ? "c".repeat(64) : "d".repeat(64),
    datasetFingerprint,
    initialStateFingerprint: `initial-${asset}-v1`,
    developmentFrameFingerprint: `development-${asset}-v1`,
    replayFrameFingerprint: `replay-${asset}-v1`,
    netReturnPct,
    maxDrawdownPct: 0.1 - scenarioOffset * 0.01,
    turnoverKrw: 1_000 - scenarioOffset * 10,
    feesKrw: 10 - scenarioOffset,
    completedEpisodeCount: 10,
    coverage: {
      cadenceComplete: true,
      independentlyVerifiedNoTrade: true,
      lifecycleComplete: true,
      feeComplete: true,
      finiteMetricsComplete: true,
      carryInStateComplete: true,
    },
  };
}

function addRoundOneContract(input: CombinedConservativeHoldoutInput): CombinedConservativeHoldoutInput {
  Object.assign(input.policy, { comparisonToleranceKrw: 0.000000001 });
  for (const asset of input.assets) {
    const provenance = {
      holdoutFrom: asset.holdout.from,
      holdoutTo: asset.holdout.to,
      noTradeEvidenceChecksum: asset.asset === "BTC" ? "c".repeat(64) : "d".repeat(64),
      initialStateFingerprint: `initial-${asset.asset}-v1`,
      developmentFrameFingerprint: `development-${asset.asset}-v1`,
      replayFrameFingerprint: `replay-${asset.asset}-v1`,
    };
    Object.assign(asset.dataset, provenance);
    for (const matrixCell of asset.matrix) Object.assign(matrixCell, provenance);
  }
  return input;
}

function syncRangeProvenance(input: CombinedConservativeHoldoutInput, asset: "BTC" | "ETH"): void {
  const item = input.assets.find((candidate) => candidate.asset === asset);
  if (!item) throw new Error(`Missing ${asset} fixture.`);
  Object.assign(item.dataset, { holdoutFrom: item.holdout.from, holdoutTo: item.holdout.to });
  for (const matrixCell of item.matrix) {
    Object.assign(matrixCell, { holdoutFrom: item.holdout.from, holdoutTo: item.holdout.to });
  }
}

type RoundOneResult = {
  assets: Array<{
    asset: "BTC" | "ETH";
    status: string;
    reasonCodes: readonly string[];
    dataset: Record<string, unknown>;
    matrix: Array<Record<string, unknown>>;
    comparisons: Array<{
      timing: string;
      cost: string;
      anchor: string;
      metric: string;
      delta: number;
      tolerance: number;
      valueUnit: string;
      deltaUnit: string;
      outcome: string;
    }>;
  }>;
};

function roundOneResult(value: unknown): RoundOneResult {
  return value as RoundOneResult;
}

function pickComparisonUnits(value: {
  delta?: number;
  tolerance?: number;
  valueUnit: string;
  deltaUnit: string;
}) {
  const result = { valueUnit: value.valueUnit, deltaUnit: value.deltaUnit };
  return value.delta === undefined || value.tolerance === undefined
    ? result
    : { delta: value.delta, tolerance: value.tolerance, ...result };
}

function pickComparisonUnitNames(value: { valueUnit: string; deltaUnit: string }) {
  return { valueUnit: value.valueUnit, deltaUnit: value.deltaUnit };
}

function cell(
  input: CombinedConservativeHoldoutInput,
  asset: "BTC" | "ETH",
  timing: CombinedConservativeHoldoutMatrixCell["timing"],
  cost: CombinedConservativeHoldoutMatrixCell["cost"],
  scenario: CombinedConservativeHoldoutMatrixCell["scenario"],
): CombinedConservativeHoldoutMatrixCell {
  const found = input.assets
    .find((item) => item.asset === asset)
    ?.matrix.find((item) => item.timing === timing && item.cost === cost && item.scenario === scenario);
  if (!found) throw new Error(`Missing fixture cell ${asset}:${timing}:${cost}:${scenario}.`);
  return found;
}
