import assert from "node:assert/strict";

import {
  validatePerformanceStability,
  type PerformanceStabilityInput,
  type StabilityScenarioPath,
} from "../src/modules/performance/performance-stability-validation.js";
import { test } from "./harness.js";

test("stability validation slices continuous paths into explicit [from,to) windows", () => {
  const result = validatePerformanceStability(baseInput());
  const first = result.windows[0]!;

  assert.equal(first.window.id, "w1");
  assert.deepEqual(first.baseline, {
    scenario: "BASELINE",
    startEquityKrw: 1_000,
    endEquityKrw: 1_100,
    periodReturnPct: 0.1,
    maxDrawdownPct: 0,
    frameCount: 2,
    fillCount: 1,
    turnoverKrw: 100,
    feesKrw: 1,
    feeCompleteness: "COMPLETE",
    completedEpisodeCount: 1,
    carryInCompletedEpisodeCount: 0,
    policyExposureCount: 0,
  });
  assert.equal(first.noAdd.startEquityKrw, 1_000);
  assert.equal(first.noAdd.endEquityKrw, 1_150);
  assert.equal(first.noAdd.periodReturnPct, 0.15);
  assert.equal(first.returnDeltaPercentagePoints, 5);
  assert.equal(first.direction, "NO_ADD_BETTER");
});

test("later windows carry forward each scenario path instead of resetting capital", () => {
  const result = validatePerformanceStability(baseInput());
  const second = result.windows[1]!;

  assert.equal(second.baseline.startEquityKrw, 1_100);
  assert.equal(second.baseline.endEquityKrw, 990);
  assert.equal(second.noAdd.startEquityKrw, 1_150);
  assert.equal(second.noAdd.endEquityKrw, 1_207.5);
  assert.ok(Math.abs((second.baseline.periodReturnPct ?? 0) - (-0.1)) < 1e-12);
  assert.ok(Math.abs((second.noAdd.periodReturnPct ?? 0) - 0.05) < 1e-12);
  assert.ok(Math.abs((second.returnDeltaPercentagePoints ?? 0) - 15) < 1e-9);
});

test("period drawdown starts from the carried boundary equity and never uses a future frame", () => {
  const input = baseInput();
  input.paths = input.paths.map((path) => ({
    ...path,
    frames: [
      ...path.frames,
      frame("2026-01-03T00:00:00.000Z", 1, "HOLD", false),
    ],
  }));
  const result = validatePerformanceStability(input);
  const second = result.windows[1]!;

  assert.notEqual(second.baseline.maxDrawdownPct, null);
  assert.ok(Math.abs((second.baseline.maxDrawdownPct ?? 0) - 0.1) < 1e-12);
  assert.equal(second.noAdd.maxDrawdownPct, 0);
  assert.equal(second.baseline.endEquityKrw, 990);
  assert.equal(second.noAdd.endEquityKrw, 1_207.5);
});

test("[from,to) boundaries assign fills and completed carry-in episodes exactly once", () => {
  const input = baseInput();
  const baseline = requirePath(input, "BASELINE");
  baseline.fills = [
    fill("at-from", "2026-01-01T00:00:00.000Z", 10, 2, 0.1),
    fill("at-to", "2026-01-02T00:00:00.000Z", 20, 3, 0.2),
  ];
  baseline.episodes = [
    episode("carry", "2025-12-31T23:00:00.000Z", "2026-01-01T12:00:00.000Z"),
    episode("at-to", "2026-01-01T12:00:00.000Z", "2026-01-02T00:00:00.000Z"),
  ];

  const result = validatePerformanceStability(input);
  assert.equal(result.windows[0]?.baseline.fillCount, 1);
  assert.equal(result.windows[0]?.baseline.turnoverKrw, 20);
  assert.equal(result.windows[0]?.baseline.completedEpisodeCount, 1);
  assert.equal(result.windows[0]?.baseline.carryInCompletedEpisodeCount, 1);
  assert.equal(result.windows[1]?.baseline.fillCount, 1);
  assert.equal(result.windows[1]?.baseline.completedEpisodeCount, 1);
});

test("missing fees remain explicit and are never replaced with zero", () => {
  const input = baseInput();
  requirePath(input, "NO_ADD").fills = [
    fill("unknown-fee", "2026-01-01T12:00:00.000Z", 100, 1, null),
  ];

  const first = validatePerformanceStability(input).windows[0]!;
  assert.equal(first.noAdd.feesKrw, null);
  assert.equal(first.noAdd.feeCompleteness, "INCOMPLETE");
  assert.equal(first.noAdd.turnoverKrw, 100);
});

test("coverage reports missing aligned observations without interpolation", () => {
  const input = baseInput();
  input.expectedFrameIntervalMs = 12 * 60 * 60 * 1_000;
  input.paths = input.paths.map((path) => ({
    ...path,
    frames: path.frames.filter((item) => item.generatedAt !== "2026-01-01T12:00:00.000Z"),
  }));

  const first = validatePerformanceStability(input).windows[0]!;
  assert.deepEqual(first.coverage, {
    expectedFrameCount: 2,
    observedFrameCount: 1,
    missingFrameCount: 1,
    coverageRatio: 0.5,
    status: "PARTIAL",
  });
  assert.equal(first.classification, "INSUFFICIENT_EVIDENCE");
});

test("sample support uses completed episodes while reporting policy exposure separately", () => {
  const input = baseInput();
  const noAdd = requirePath(input, "NO_ADD");
  noAdd.frames = noAdd.frames.map((item) => ({
    ...item,
    decisionAction: "ADD",
    policyExposure: "ADD_SUPPRESSED",
  }));
  noAdd.episodes = Array.from({ length: 10 }, (_, index) =>
    episode(`noadd-${index}`, "2026-01-01T00:00:00.000Z", "2026-01-01T12:00:00.000Z"));
  const baseline = requirePath(input, "BASELINE");
  baseline.episodes = Array.from({ length: 12 }, (_, index) =>
    episode(`baseline-${index}`, "2026-01-01T00:00:00.000Z", "2026-01-01T12:00:00.000Z"));

  const first = validatePerformanceStability(input).windows[0]!;
  assert.equal(first.sampleSupport.completedEpisodeCount, 10);
  assert.equal(first.sampleSupport.baselineCompletedEpisodeCount, 12);
  assert.equal(first.sampleSupport.noAddCompletedEpisodeCount, 10);
  assert.equal(first.sampleSupport.policyExposureCount, 2);
  assert.equal(first.sampleSupport.status, "PRELIMINARY");
  assert.equal(first.classification, "NO_ADD_BETTER");
});

test("a window with no suppressed ADD is classified as no policy exposure", () => {
  const first = validatePerformanceStability(baseInput()).windows[0]!;
  assert.equal(first.sampleSupport.policyExposureCount, 0);
  assert.equal(first.classification, "NO_POLICY_EXPOSURE");
});

test("zero start equity makes return non-comparable without aborting other evidence", () => {
  const input = baseInput();
  for (const path of input.paths) {
    path.frames[1] = { ...path.frames[1]!, equityKrw: 0 };
  }
  const second = validatePerformanceStability(input).windows[1]!;

  assert.equal(second.baseline.startEquityKrw, 0);
  assert.equal(second.baseline.periodReturnPct, null);
  assert.equal(second.noAdd.periodReturnPct, null);
  assert.equal(second.direction, "NOT_COMPARABLE");
  assert.equal(second.classification, "INSUFFICIENT_EVIDENCE");
});

test("NO_ADD policy exposure must be attached only to an ADD decision", () => {
  const input = baseInput();
  const noAdd = requirePath(input, "NO_ADD");
  noAdd.frames[0] = { ...noAdd.frames[0]!, policyExposure: "ADD_SUPPRESSED" };

  assert.throws(
    () => validatePerformanceStability(input),
    /ADD_SUPPRESSED.*decisionAction ADD/i,
  );
});

test("overall classification requires the explicit minimum number of evaluable windows", () => {
  const input = supportedInput();
  const result = validatePerformanceStability(input);

  assert.equal(result.overall.evaluableWindowCount, 2);
  assert.equal(result.overall.betterWindowCount, 2);
  assert.equal(result.overall.classification, "CONSISTENT_POSITIVE");

  input.minimumEvaluableWindows = 3;
  assert.equal(
    validatePerformanceStability(input).overall.classification,
    "INSUFFICIENT_EVIDENCE",
  );
});

test("overall classification reports mixed and consistent non-positive signs deterministically", () => {
  const mixed = supportedInput();
  const noAdd = requirePath(mixed, "NO_ADD");
  noAdd.frames = noAdd.frames.map((item, index) => index >= 2
    ? { ...item, equityKrw: index === 2 ? 1_035 : 920 }
    : item);
  assert.equal(validatePerformanceStability(mixed).overall.classification, "MIXED");

  const nonPositive = supportedInput();
  requirePath(nonPositive, "NO_ADD").frames = requirePath(nonPositive, "BASELINE").frames
    .map((item) => ({
      ...item,
      decisionAction: "ADD" as const,
      policyExposure: "ADD_SUPPRESSED" as const,
    }));
  const result = validatePerformanceStability(nonPositive);
  assert.equal(result.overall.classification, "CONSISTENT_NON_POSITIVE");
  assert.ok(result.windows.every((item) => item.direction === "TIED"));
});

test("windows require explicit timezone unique ids strict order and no overlap", () => {
  const invalidTimestamp = baseInput();
  invalidTimestamp.windows[0] = { id: "w1", from: "2026-01-01T00:00:00", to: "2026-01-02T00:00:00.000Z" };
  assert.throws(() => validatePerformanceStability(invalidTimestamp), /explicit timezone/i);

  const duplicate = baseInput();
  duplicate.windows[1] = { ...duplicate.windows[1]!, id: "w1" };
  assert.throws(() => validatePerformanceStability(duplicate), /duplicate window id/i);

  const overlap = baseInput();
  overlap.windows[1] = { id: "w2", from: "2026-01-01T12:00:00.000Z", to: "2026-01-03T00:00:00.000Z" };
  assert.throws(() => validatePerformanceStability(overlap), /overlap/i);

  const unsorted = baseInput();
  unsorted.windows.reverse();
  assert.throws(() => validatePerformanceStability(unsorted), /strictly ordered/i);
});

test("scenario paths reject duplicate scenarios timestamps ids and misaligned paired observations", () => {
  const duplicateScenario = baseInput();
  duplicateScenario.paths = [
    requirePath(duplicateScenario, "BASELINE"),
    { ...requirePath(duplicateScenario, "BASELINE") },
  ];
  assert.throws(() => validatePerformanceStability(duplicateScenario), /BASELINE and NO_ADD/i);

  const duplicateFrame = baseInput();
  const baseline = requirePath(duplicateFrame, "BASELINE");
  baseline.frames = [baseline.frames[0]!, baseline.frames[0]!, ...baseline.frames.slice(1)];
  assert.throws(() => validatePerformanceStability(duplicateFrame), /strictly ordered|duplicate/i);

  const duplicateFill = baseInput();
  const firstFill = requirePath(duplicateFill, "BASELINE").fills[0]!;
  requirePath(duplicateFill, "BASELINE").fills = [firstFill, { ...firstFill }];
  assert.throws(() => validatePerformanceStability(duplicateFill), /duplicate fill id/i);

  const mismatch = baseInput();
  requirePath(mismatch, "NO_ADD").frames[0] = frame("2026-01-01T01:00:00.000Z", 1_000, "HOLD", false);
  assert.throws(() => validatePerformanceStability(mismatch), /paired frame timestamps/i);
});

test("numeric inputs and derived values reject NaN infinity negatives and overflow", () => {
  const badEquity = baseInput();
  requirePath(badEquity, "BASELINE").frames[0] = frame("2026-01-01T00:00:00.000Z", Number.NaN, "HOLD", false);
  assert.throws(() => validatePerformanceStability(badEquity), /equityKrw.*finite/i);

  const badFill = baseInput();
  requirePath(badFill, "BASELINE").fills = [
    fill("bad", "2026-01-01T00:00:00.000Z", -1, 1, 0),
  ];
  assert.throws(() => validatePerformanceStability(badFill), /priceKrw.*positive/i);

  const overflow = baseInput();
  requirePath(overflow, "BASELINE").fills = [
    fill("overflow", "2026-01-01T00:00:00.000Z", Number.MAX_VALUE, 2, 0),
  ];
  assert.throws(() => validatePerformanceStability(overflow), /turnover.*finite/i);
});

test("mixed timezone windows and observations compare by exact epoch", () => {
  const input = baseInput();
  input.windows[0] = {
    id: "w1",
    from: "2026-01-01T09:00:00.000+09:00",
    to: "2026-01-02T09:00:00.000+09:00",
  };

  const first = validatePerformanceStability(input).windows[0]!;
  assert.equal(first.window.from, "2026-01-01T00:00:00.000Z");
  assert.equal(first.window.to, "2026-01-02T00:00:00.000Z");
  assert.equal(first.baseline.frameCount, 2);
});

test("results are deterministic JSON-friendly values", () => {
  const first = validatePerformanceStability(baseInput());
  const second = validatePerformanceStability(baseInput());
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.doesNotMatch(JSON.stringify(first), /NaN|Infinity/);
  assert.equal(Object.hasOwn(first, "undefined"), false);
});

function baseInput(): PerformanceStabilityInput {
  return {
    asset: "BTC",
    market: "KRW-BTC",
    costScenarioId: "base",
    expectedFrameIntervalMs: 12 * 60 * 60 * 1_000,
    comparisonTolerancePercentagePoints: 1e-9,
    minimumEvaluableWindows: 1,
    windows: [
      { id: "w1", from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
      { id: "w2", from: "2026-01-02T00:00:00.000Z", to: "2026-01-03T00:00:00.000Z" },
    ],
    paths: [
      {
        scenario: "BASELINE",
        initialEquityKrw: 1_000,
        frames: [
          frame("2026-01-01T00:00:00.000Z", 1_000, "HOLD", false),
          frame("2026-01-01T12:00:00.000Z", 1_100, "ENTER", false),
          frame("2026-01-02T00:00:00.000Z", 1_045, "HOLD", false),
          frame("2026-01-02T12:00:00.000Z", 990, "EXIT", false),
        ],
        fills: [fill("baseline-fill", "2026-01-01T12:00:00.000Z", 100, 1, 1)],
        episodes: [episode("baseline-episode", "2026-01-01T12:00:00.000Z", "2026-01-01T18:00:00.000Z")],
      },
      {
        scenario: "NO_ADD",
        initialEquityKrw: 1_000,
        frames: [
          frame("2026-01-01T00:00:00.000Z", 1_000, "HOLD", false),
          frame("2026-01-01T12:00:00.000Z", 1_150, "ENTER", false),
          frame("2026-01-02T00:00:00.000Z", 1_178.75, "HOLD", false),
          frame("2026-01-02T12:00:00.000Z", 1_207.5, "EXIT", false),
        ],
        fills: [fill("noadd-fill", "2026-01-01T12:00:00.000Z", 100, 1, 1)],
        episodes: [episode("noadd-episode", "2026-01-01T12:00:00.000Z", "2026-01-01T18:00:00.000Z")],
      },
    ],
  };
}

function supportedInput(): PerformanceStabilityInput {
  const input = baseInput();
  input.minimumEvaluableWindows = 2;
  for (const scenario of ["BASELINE", "NO_ADD"] as const) {
    const path = requirePath(input, scenario);
    path.episodes = [
      ...Array.from({ length: 10 }, (_, index) => episode(
        `${scenario}-w1-${index}`,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T12:00:00.000Z",
      )),
      ...Array.from({ length: 10 }, (_, index) => episode(
        `${scenario}-w2-${index}`,
        "2026-01-02T00:00:00.000Z",
        "2026-01-02T12:00:00.000Z",
      )),
    ];
  }
  requirePath(input, "NO_ADD").frames = requirePath(input, "NO_ADD").frames.map((item) => ({
    ...item,
    decisionAction: "ADD",
    policyExposure: "ADD_SUPPRESSED",
  }));
  return input;
}

function requirePath(input: PerformanceStabilityInput, scenario: StabilityScenarioPath["scenario"]): StabilityScenarioPath {
  const path = input.paths.find((item) => item.scenario === scenario);
  if (!path) throw new Error(`Missing ${scenario} fixture path.`);
  return path as StabilityScenarioPath;
}

function frame(
  generatedAt: string,
  equityKrw: number,
  decisionAction: "ENTER" | "ADD" | "REDUCE" | "EXIT" | "HOLD",
  suppressed: boolean,
) {
  return {
    generatedAt,
    equityKrw,
    decisionAction,
    policyExposure: suppressed ? "ADD_SUPPRESSED" as const : null,
  };
}

function fill(id: string, filledAt: string, priceKrw: number, volume: number, feeKrw: number | null) {
  return { id, filledAt, priceKrw, volume, feeKrw };
}

function episode(id: string, openedAt: string, closedAt: string) {
  return { id, openedAt, closedAt, status: "COMPLETED" as const };
}
