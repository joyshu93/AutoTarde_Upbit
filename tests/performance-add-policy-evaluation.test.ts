import assert from "node:assert/strict";

import {
  APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS,
  evaluateAddPolicyCandidate,
  type AddPolicyCandidateEvaluationInput,
  type AddPolicyEvaluationObservation,
} from "../src/modules/performance/performance-add-policy-evaluation.js";
import { test } from "./harness.js";

test("all acceptance gates pass and retain thresholds, observations, and anchor comparisons", () => {
  const input = passingInput();
  const result = evaluateAddPolicyCandidate(input);

  assert.equal(result.status, "ELIGIBLE_FOR_FURTHER_RESEARCH");
  assert.deepEqual(result.thresholds, APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS);
  assert.deepEqual(result.observations, {
    fullPath: input.fullPath,
    windows: input.windows,
  });
  assert.deepEqual(result.costAnchors, {
    BASE: { costScenarioId: "base", feeRate: 0.0005, slippageRate: 0.0003 },
    STRESS: { costScenarioId: "stress", feeRate: 0.001, slippageRate: 0.002 },
  });
  assert.ok(Object.values(result.gates).every((gate) => gate.status === "PASS"));
  const stressNoAddComparison = result.anchorComparisons.windows[0]?.comparisons.find(
    (item) => item.costRole === "STRESS" && item.anchor === "NO_ADD",
  );
  assert.deepEqual(stressNoAddComparison, {
    costRole: "STRESS",
    anchor: "NO_ADD",
    candidateReturnPct: 0.02,
    anchorReturnPct: 0.01,
    returnDeltaPercentagePoints: 1,
    candidateMaxDrawdownPct: 0.02,
    anchorMaxDrawdownPct: 0.055,
    drawdownDeltaPercentagePoints: stressNoAddComparison?.drawdownDeltaPercentagePoints,
  });
  assert.ok(Math.abs((stressNoAddComparison?.drawdownDeltaPercentagePoints ?? 0) + 3.5) < 1e-12);
  assert.deepEqual(result.gates.fullPathNetReturn.comparisons.map((item) => ({
    ...item,
    anchorReturnPct: rounded(item.anchorReturnPct),
    deltaPercentagePoints: rounded(item.deltaPercentagePoints),
  })), [
    comparison("BASE", "BASELINE", 0.12, 0.1, 2, true),
    comparison("BASE", "NO_ADD", 0.12, 0.11, 1, true),
    comparison("STRESS", "BASELINE", 0.08, 0.06, 2, true),
    comparison("STRESS", "NO_ADD", 0.08, 0.07, 1, true),
  ]);
  assert.equal(result.periodSemantics, "[from,to)");
  assert.equal(result.statisticalSignificanceClaim, false);
});

test("full-path return must strictly exceed both anchors in base and stress cells", () => {
  for (const [role, anchor] of [["BASE", "BASELINE"], ["STRESS", "NO_ADD"]] as const) {
    const input = passingInput();
    const candidate = observation(input.fullPath, input.candidate, role);
    const anchored = observation(input.fullPath, anchor, role);
    candidate.totalReturnPct = anchored.totalReturnPct;

    const result = evaluateAddPolicyCandidate(input);
    assert.equal(result.status, "REJECTED");
    assert.equal(result.gates.fullPathNetReturn.status, "FAIL");
    assert.equal(
      result.gates.fullPathNetReturn.comparisons.find(
        (item) => item.costRole === role && item.anchor === anchor,
      )?.passed,
      false,
    );
  }
});

test("every base window requires a strictly positive candidate delta versus BASELINE", () => {
  const input = passingInput();
  const window = input.windows[1]!;
  observation(window.observations, input.candidate, "BASE").totalReturnPct =
    observation(window.observations, "BASELINE", "BASE").totalReturnPct;

  const result = evaluateAddPolicyCandidate(input);
  assert.equal(result.status, "REJECTED");
  assert.equal(result.gates.baseWindowReturn.status, "FAIL");
  assert.equal(result.gates.baseWindowReturn.observations[1]?.deltaPercentagePoints, 0);
  assert.equal(result.gates.baseWindowReturn.observations[1]?.passed, false);
});

test("stress windows require two positive deltas and enforce the negative floor", () => {
  const exactFloor = passingInput();
  const exactFloorWindow = exactFloor.windows[2]!;
  observation(exactFloorWindow.observations, exactFloor.candidate, "STRESS").totalReturnPct =
    observation(exactFloorWindow.observations, "BASELINE", "STRESS").totalReturnPct - 0.005;
  assert.equal(
    evaluateAddPolicyCandidate(exactFloor).gates.stressWindowReturn.status,
    "PASS",
  );

  const tooFewPositive = passingInput();
  for (const window of tooFewPositive.windows.slice(1)) {
    observation(window.observations, tooFewPositive.candidate, "STRESS").totalReturnPct =
      observation(window.observations, "BASELINE", "STRESS").totalReturnPct;
  }
  const countResult = evaluateAddPolicyCandidate(tooFewPositive);
  assert.equal(countResult.status, "REJECTED");
  assert.equal(countResult.gates.stressWindowReturn.status, "FAIL");
  assert.equal(countResult.gates.stressWindowReturn.positiveWindowCount, 1);

  const belowFloor = passingInput();
  const window = belowFloor.windows[2]!;
  observation(window.observations, belowFloor.candidate, "STRESS").totalReturnPct =
    observation(window.observations, "BASELINE", "STRESS").totalReturnPct - 0.00500001;
  const floorResult = evaluateAddPolicyCandidate(belowFloor);
  assert.equal(floorResult.status, "REJECTED");
  assert.equal(floorResult.gates.stressWindowReturn.status, "FAIL");
  assert.equal(floorResult.gates.stressWindowReturn.observations[2]?.floorPassed, false);
});

test("inclusive stress return floor is stable against floating-point artifacts", () => {
  const input = passingInput();
  const boundaryWindow = input.windows[2]!;
  observation(boundaryWindow.observations, "BASELINE", "STRESS").totalReturnPct = 0.065;
  observation(boundaryWindow.observations, input.candidate, "STRESS").totalReturnPct = 0.06;

  const result = evaluateAddPolicyCandidate(input);
  const boundary = result.gates.stressWindowReturn.observations[2]!;
  assert.equal(boundary.deltaPercentagePoints, -0.5);
  assert.equal(boundary.floorPassed, true);
  assert.equal(result.gates.stressWindowReturn.status, "PASS");
});

test("drawdown gates allow exact boundaries and reject values above them", () => {
  const exact = passingInput();
  observation(exact.fullPath, exact.candidate, "BASE").maxDrawdownPct =
    observation(exact.fullPath, "BASELINE", "BASE").maxDrawdownPct;
  observation(exact.fullPath, exact.candidate, "STRESS").maxDrawdownPct =
    observation(exact.fullPath, "BASELINE", "STRESS").maxDrawdownPct;
  for (const window of exact.windows) {
    observation(window.observations, exact.candidate, "STRESS").maxDrawdownPct =
      observation(window.observations, "BASELINE", "STRESS").maxDrawdownPct + 0.01;
  }
  assert.equal(evaluateAddPolicyCandidate(exact).status, "ELIGIBLE_FOR_FURTHER_RESEARCH");

  const fullPathFailure = passingInput();
  observation(fullPathFailure.fullPath, fullPathFailure.candidate, "BASE").maxDrawdownPct = 0.05000001;
  const fullPathResult = evaluateAddPolicyCandidate(fullPathFailure);
  assert.equal(fullPathResult.status, "REJECTED");
  assert.equal(fullPathResult.gates.fullPathMaxDrawdown.status, "FAIL");

  const stressFailure = passingInput();
  observation(stressFailure.windows[0]!.observations, stressFailure.candidate, "STRESS").maxDrawdownPct = 0.07000001;
  const stressResult = evaluateAddPolicyCandidate(stressFailure);
  assert.equal(stressResult.status, "REJECTED");
  assert.equal(stressResult.gates.stressWindowMaxDrawdown.status, "FAIL");
});

test("inclusive stress drawdown boundary is stable against floating-point artifacts", () => {
  const input = passingInput();
  const boundaryWindow = input.windows[0]!;
  observation(boundaryWindow.observations, "BASELINE", "STRESS").maxDrawdownPct = 0.06;
  observation(boundaryWindow.observations, input.candidate, "STRESS").maxDrawdownPct = 0.07;

  const result = evaluateAddPolicyCandidate(input);
  const boundary = result.gates.stressWindowMaxDrawdown.observations[0]!;
  assert.equal(boundary.deltaPercentagePoints, 1);
  assert.equal(boundary.passed, true);
  assert.equal(result.gates.stressWindowMaxDrawdown.status, "PASS");
});

test("policy support below 30 full-path episodes takes INSUFFICIENT precedence", () => {
  const input = passingInput();
  input.fullPath.policyExposedCompletedEpisodeCount = 29;
  observation(input.fullPath.observations, input.candidate, "BASE").totalReturnPct = -100;

  const result = evaluateAddPolicyCandidate(input);
  assert.equal(result.status, "INSUFFICIENT");
  assert.deepEqual(result.gates.policyExposedCompletedEpisodes, {
    status: "INSUFFICIENT",
    fullPathObservedCount: 29,
    fullPathRequiredCount: 30,
    windows: input.windows.map((window) => ({
      windowId: window.id,
      evaluable: true,
      observedCount: window.policyExposedCompletedEpisodeCount,
      requiredCount: 10,
      passed: true,
    })),
  });
});

test("fewer than 10 policy-exposed completed episodes in any window is insufficient", () => {
  const input = passingInput();
  input.windows[1]!.policyExposedCompletedEpisodeCount = 9;

  const result = evaluateAddPolicyCandidate(input);
  assert.equal(result.status, "INSUFFICIENT");
  assert.equal(result.gates.policyExposedCompletedEpisodes.status, "INSUFFICIENT");
  assert.equal(result.gates.policyExposedCompletedEpisodes.windows[1]?.passed, false);
});

test("incomplete frame coverage is retained and classified as insufficient", () => {
  const input = passingInput();
  input.windows[2]!.coverage = {
    ...completeCoverage(24, input.windows[2]!.from),
    status: "INCOMPLETE",
    windowCadenceStatus: "INCOMPLETE",
    windowSequenceContinuityStatus: "INCOMPLETE",
    windowClockGridStatus: "ANOMALOUS",
    observedFrameCount: 23,
    missingFrameCount: 1,
    offGridFrameCount: 1,
    missingRanges: [{
      firstMissingAt: "2026-01-03T12:00:00.000Z",
      lastMissingAt: "2026-01-03T12:00:00.000Z",
      missingFrameCount: 1,
      previousObservedAt: "2026-01-03T11:00:00.000Z",
      nextObservedAt: "2026-01-03T13:00:00.000Z",
    }],
    offGridInstants: [{ observedAt: "2026-01-03T12:15:00.000Z", occurrenceCount: 1 }],
  };

  const result = evaluateAddPolicyCandidate(input);
  assert.equal(result.status, "INSUFFICIENT");
  assert.equal(result.gates.frameCoverage.status, "INSUFFICIENT");
  assert.deepEqual(result.gates.frameCoverage.windows[2], {
    windowId: "w3",
    ...input.windows[2]!.coverage,
    passed: false,
  });
  assert.deepEqual(
    result.gates.baseWindowReturn.observations.map((item) => item.windowId),
    ["w1", "w2"],
  );
  assert.deepEqual(
    result.gates.stressWindowReturn.observations.map((item) => item.windowId),
    ["w1", "w2"],
  );
  assert.deepEqual(
    result.gates.stressWindowMaxDrawdown.observations.map((item) => item.windowId),
    ["w1", "w2"],
  );
  assert.deepEqual(result.gates.policyExposedCompletedEpisodes.windows[2], {
    windowId: "w3",
    evaluable: false,
    observedCount: 10,
    requiredCount: 10,
    passed: null,
  });
  assert.equal(result.anchorComparisons.windows[2]?.evaluable, false);
});

test("known no-trade frames preserve sequence continuity and pass frame coverage", () => {
  const input = passingInput();
  const coverage = input.fullPath.coverage;
  input.fullPath.coverage = {
    ...coverage,
    windowCadenceStatus: "INCOMPLETE",
    windowSequenceContinuityStatus: "COMPLETE",
    windowClockGridStatus: "SPARSE_BY_CONTRACT",
    observedFrameCount: coverage.expectedFrameCount - 1,
    noTradeFrameCount: 1,
    noTradeRanges: [cadenceGap("2026-01-02T12:00:00.000Z")],
  };

  const result = evaluateAddPolicyCandidate(input);

  assert.equal(result.gates.frameCoverage.status, "PASS");
  assert.equal(result.gates.frameCoverage.fullPath.windowCadenceStatus, "INCOMPLETE");
  assert.equal(result.gates.frameCoverage.fullPath.windowSequenceContinuityStatus, "COMPLETE");
  assert.equal(result.gates.frameCoverage.fullPath.windowClockGridStatus, "SPARSE_BY_CONTRACT");
  assert.equal(result.gates.frameCoverage.fullPath.noTradeFrameCount, 1);
});

test("no-trade coverage rejects count mismatch, overlap, forged statuses, and result mutation", () => {
  const countMismatch = passingInput();
  Object.assign(countMismatch.fullPath.coverage, {
    windowCadenceStatus: "INCOMPLETE",
    windowSequenceContinuityStatus: "COMPLETE",
    windowClockGridStatus: "SPARSE_BY_CONTRACT",
    observedFrameCount: 71,
    noTradeFrameCount: 2,
    noTradeRanges: [cadenceGap("2026-01-02T12:00:00.000Z")],
  });
  assert.throws(() => evaluateAddPolicyCandidate(countMismatch), /noTradeRanges.*sum|count conservation/i);

  const overlap = passingInput();
  Object.assign(overlap.fullPath.coverage, {
    status: "INCOMPLETE",
    windowCadenceStatus: "INCOMPLETE",
    windowSequenceContinuityStatus: "INCOMPLETE",
    windowClockGridStatus: "ANOMALOUS",
    observedFrameCount: 70,
    noTradeFrameCount: 1,
    noTradeRanges: [cadenceGap("2026-01-02T12:00:00.000Z")],
    missingFrameCount: 1,
    missingRanges: [cadenceGap("2026-01-02T12:00:00.000Z")],
  });
  assert.throws(() => evaluateAddPolicyCandidate(overlap), /noTradeRanges.*overlap.*missingRanges/i);

  const malformed = passingInput();
  Object.assign(malformed.fullPath.coverage, {
    windowCadenceStatus: "INCOMPLETE",
    windowSequenceContinuityStatus: "COMPLETE",
    windowClockGridStatus: "SPARSE_BY_CONTRACT",
    observedFrameCount: 71,
    noTradeFrameCount: 1,
    noTradeRanges: [{
      ...cadenceGap("2026-01-02T12:00:00.000Z"),
      firstMissingAt: "2026-01-02T12:30:00.000Z",
      lastMissingAt: "2026-01-02T12:30:00.000Z",
    }],
  });
  assert.throws(() => evaluateAddPolicyCandidate(malformed), /noTradeRanges.*align/i);

  const forged = passingInput();
  Object.assign(forged.fullPath.coverage, {
    windowSequenceContinuityStatus: "INCOMPLETE",
    windowClockGridStatus: "SPARSE_BY_CONTRACT",
  });
  assert.throws(() => evaluateAddPolicyCandidate(forged), /windowSequenceContinuityStatus.*evidence/i);

  const mutation = passingInput();
  Object.assign(mutation.fullPath.coverage, {
    windowCadenceStatus: "INCOMPLETE",
    windowSequenceContinuityStatus: "COMPLETE",
    windowClockGridStatus: "SPARSE_BY_CONTRACT",
    observedFrameCount: 71,
    noTradeFrameCount: 1,
    noTradeRanges: [cadenceGap("2026-01-02T12:00:00.000Z")],
  });
  const result = evaluateAddPolicyCandidate(mutation);
  mutation.fullPath.coverage.noTradeRanges[0]!.firstMissingAt = "2026-01-01T00:00:00.000Z";
  assert.equal(result.gates.frameCoverage.fullPath.noTradeRanges[0]?.firstMissingAt, "2026-01-02T12:00:00.000Z");
  assert.equal(
    result.observations.fullPath.coverage.noTradeRanges[0]?.firstMissingAt,
    "2026-01-02T12:00:00.000Z",
  );

  const upstreamMutation = passingInput();
  Object.assign(upstreamMutation.fullPath.coverage, {
    upstreamExpectedFrameCount: 2,
    upstreamObservedFrameCount: 1,
    upstreamFirstExpectedFrameAt: "2025-12-31T22:00:00.000Z",
    upstreamEndExclusiveAt: "2026-01-01T00:00:00.000Z",
    upstreamNoTradeFrameCount: 1,
    upstreamNoTradeRanges: [cadenceGap("2025-12-31T23:00:00.000Z")],
    upstreamClockGridStatus: "SPARSE_BY_CONTRACT",
  });
  const upstreamResult = evaluateAddPolicyCandidate(upstreamMutation);
  upstreamMutation.fullPath.coverage.upstreamNoTradeRanges[0]!.firstMissingAt = "2025-12-31T22:00:00.000Z";
  assert.equal(
    upstreamResult.gates.frameCoverage.fullPath.upstreamNoTradeRanges[0]?.firstMissingAt,
    "2025-12-31T23:00:00.000Z",
  );
  assert.equal(
    upstreamResult.observations.fullPath.coverage.upstreamNoTradeRanges[0]?.firstMissingAt,
    "2025-12-31T23:00:00.000Z",
  );
});

test("zero upstream coverage is valid, while manifested upstream evidence and forged statuses reject", () => {
  assert.equal(evaluateAddPolicyCandidate(passingInput()).gates.frameCoverage.status, "PASS");

  const manifested = passingInput();
  Object.assign(manifested.fullPath.coverage, {
    upstreamMissingFrameCount: 1,
    upstreamMissingRanges: [cadenceGap("2025-12-31T23:00:00.000Z")],
  });
  assert.throws(() => evaluateAddPolicyCandidate(manifested), /upstream.*cadence bounds/i);

  const forgedSequence = passingInput();
  Object.assign(forgedSequence.fullPath.coverage, {
    upstreamExpectedFrameCount: 2,
    upstreamObservedFrameCount: 1,
    upstreamFirstExpectedFrameAt: "2025-12-31T22:00:00.000Z",
    upstreamEndExclusiveAt: "2026-01-01T00:00:00.000Z",
    upstreamMissingFrameCount: 1,
    upstreamMissingRanges: [cadenceGap("2025-12-31T23:00:00.000Z")],
    upstreamSequenceContinuityStatus: "COMPLETE",
    upstreamClockGridStatus: "ANOMALOUS",
    upstreamStateContinuityStatus: "COMPLETE",
  });
  assert.throws(() => evaluateAddPolicyCandidate(forgedSequence), /upstreamSequenceContinuityStatus.*evidence/i);

  const forgedState = passingInput();
  Object.assign(forgedState.fullPath.coverage, {
    upstreamExpectedFrameCount: 2,
    upstreamObservedFrameCount: 1,
    upstreamFirstExpectedFrameAt: "2025-12-31T22:00:00.000Z",
    upstreamEndExclusiveAt: "2026-01-01T00:00:00.000Z",
    upstreamMissingFrameCount: 1,
    upstreamMissingRanges: [cadenceGap("2025-12-31T23:00:00.000Z")],
    upstreamSequenceContinuityStatus: "INCOMPLETE",
    upstreamClockGridStatus: "ANOMALOUS",
    upstreamStateContinuityStatus: "COMPLETE",
  });
  assert.throws(() => evaluateAddPolicyCandidate(forgedState), /upstreamStateContinuityStatus.*equal/i);
});

test("coverage rejects forged window and upstream grid, raw cadence, and overall statuses", () => {
  const windowGrid = passingInput();
  Object.assign(windowGrid.fullPath.coverage, {
    windowClockGridStatus: "SPARSE_BY_CONTRACT",
  });
  assert.throws(() => evaluateAddPolicyCandidate(windowGrid), /windowClockGridStatus.*evidence/i);

  const upstreamGrid = passingInput();
  Object.assign(upstreamGrid.fullPath.coverage, {
    upstreamClockGridStatus: "SPARSE_BY_CONTRACT",
  });
  assert.throws(() => evaluateAddPolicyCandidate(upstreamGrid), /upstreamClockGridStatus.*evidence/i);

  const rawCadence = passingInput();
  Object.assign(rawCadence.fullPath.coverage, {
    windowCadenceStatus: "INCOMPLETE",
  });
  assert.throws(() => evaluateAddPolicyCandidate(rawCadence), /windowCadenceStatus.*evidence/i);

  const overall = passingInput();
  Object.assign(overall.fullPath.coverage, {
    status: "INCOMPLETE",
  });
  assert.throws(() => evaluateAddPolicyCandidate(overall), /coverage status.*window cadence and upstream continuity/i);
});

test("incomplete full-path cadence coverage takes INSUFFICIENT precedence", () => {
  const input = passingInput();
  input.fullPath = {
    ...input.fullPath,
    coverage: {
      ...completeCoverage(72),
      status: "INCOMPLETE",
      windowCadenceStatus: "INCOMPLETE",
      windowSequenceContinuityStatus: "INCOMPLETE",
      windowClockGridStatus: "ANOMALOUS",
      observedFrameCount: 71,
      missingFrameCount: 1,
      missingRanges: [{
        firstMissingAt: "2026-01-02T12:00:00.000Z",
        lastMissingAt: "2026-01-02T12:00:00.000Z",
        missingFrameCount: 1,
        previousObservedAt: "2026-01-02T11:00:00.000Z",
        nextObservedAt: "2026-01-02T13:00:00.000Z",
      }],
    },
  } as AddPolicyCandidateEvaluationInput["fullPath"];
  observation(input.fullPath.observations, input.candidate, "BASE").totalReturnPct = -1;

  const result = evaluateAddPolicyCandidate(input);
  const frameCoverage = result.gates.frameCoverage as typeof result.gates.frameCoverage & {
    fullPath: {
      status: "INCOMPLETE";
      expectedFrameCount: number;
      observedFrameCount: number;
      passed: false;
    };
  };

  assert.equal(result.status, "INSUFFICIENT");
  assert.deepEqual(frameCoverage.fullPath, {
    ...input.fullPath.coverage,
    passed: false,
  });
});

test("approved thresholds are immutable and callers cannot weaken acceptance gates", () => {
  assert.equal(Object.isFrozen(APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS), true);
  assert.deepEqual(APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS, {
    minimumFullPathReturnDeltaPercentagePoints: 0,
    minimumBaseWindowReturnDeltaPercentagePoints: 0,
    minimumPositiveStressWindowCount: 2,
    requiredStressWindowCount: 3,
    minimumStressWindowReturnDeltaPercentagePoints: -0.5,
    maximumFullPathDrawdownDeltaPercentagePoints: 0,
    maximumStressWindowDrawdownDeltaPercentagePoints: 1,
    minimumFullPathPolicyExposedCompletedEpisodes: 30,
    minimumWindowPolicyExposedCompletedEpisodes: 10,
  });

  const weakened = passingInput();
  weakened.thresholds = {
    ...weakened.thresholds,
    minimumFullPathPolicyExposedCompletedEpisodes: 1,
  };
  assert.throws(() => evaluateAddPolicyCandidate(weakened), /approved.*threshold/i);
});

test("incomplete recursive feature input takes INSUFFICIENT precedence", () => {
  const input = passingInput();
  input.fullPath.coverage = {
    ...input.fullPath.coverage,
    status: "INCOMPLETE",
    featureLookbackContinuityStatus: "INCOMPLETE",
    featureLookbackAffectedFrameCount: 3,
    featureLookbackAffectedRanges: [{
      firstFrameAt: "2026-01-01T10:00:00.000Z",
      lastFrameAt: "2026-01-01T12:00:00.000Z",
      affectedFrameCount: 3,
    }],
  };

  const result = evaluateAddPolicyCandidate(input);

  assert.equal(result.status, "INSUFFICIENT");
  assert.equal(result.gates.frameCoverage.status, "INSUFFICIENT");
  assert.equal(result.gates.frameCoverage.fullPath.featureLookbackContinuityStatus, "INCOMPLETE");
  assert.equal(result.gates.frameCoverage.fullPath.passed, false);
});

test("upstream duplicate evidence is retained and classified as insufficient", () => {
  const input = passingInput();
  input.windows[1]!.coverage = {
    ...input.windows[1]!.coverage,
    status: "INCOMPLETE",
    upstreamStateContinuityStatus: "INCOMPLETE",
    upstreamSequenceContinuityStatus: "INCOMPLETE",
    upstreamClockGridStatus: "ANOMALOUS",
    upstreamExpectedFrameCount: 2,
    upstreamObservedFrameCount: 2,
    upstreamFirstExpectedFrameAt: "2025-12-31T22:00:00.000Z",
    upstreamEndExclusiveAt: "2026-01-01T00:00:00.000Z",
    upstreamDuplicateFrameCount: 1,
    upstreamDuplicateInstants: [{
      observedAt: "2025-12-31T23:00:00.000Z",
      occurrenceCount: 2,
    }],
  };

  const result = evaluateAddPolicyCandidate(input);

  assert.equal(result.status, "INSUFFICIENT");
  assert.equal(result.gates.frameCoverage.windows[1]!.upstreamDuplicateFrameCount, 1);
  assert.deepEqual(result.gates.frameCoverage.windows[1]!.upstreamDuplicateInstants, [{
    observedAt: "2025-12-31T23:00:00.000Z",
    occurrenceCount: 2,
  }]);
});

test("gap manifests reject count spans, overlap, and non-adjacent boundary evidence", () => {
  const spanMismatch = passingInput();
  spanMismatch.fullPath.coverage = {
    ...spanMismatch.fullPath.coverage,
    status: "INCOMPLETE",
    windowCadenceStatus: "INCOMPLETE",
    windowSequenceContinuityStatus: "INCOMPLETE",
    windowClockGridStatus: "ANOMALOUS",
    observedFrameCount: 70,
    missingFrameCount: 2,
    missingRanges: [{
      firstMissingAt: "2026-01-01T01:00:00.000Z",
      lastMissingAt: "2026-01-01T01:00:00.000Z",
      missingFrameCount: 2,
      previousObservedAt: "2026-01-01T00:00:00.000Z",
      nextObservedAt: "2026-01-01T02:00:00.000Z",
    }],
  };
  assert.throws(() => evaluateAddPolicyCandidate(spanMismatch), /timestamp span.*missingFrameCount/i);

  const badBoundary = passingInput();
  badBoundary.fullPath.coverage = {
    ...badBoundary.fullPath.coverage,
    status: "INCOMPLETE",
    windowCadenceStatus: "INCOMPLETE",
    windowSequenceContinuityStatus: "INCOMPLETE",
    windowClockGridStatus: "ANOMALOUS",
    observedFrameCount: 71,
    missingFrameCount: 1,
    missingRanges: [{
      firstMissingAt: "2026-01-01T01:00:00.000Z",
      lastMissingAt: "2026-01-01T01:00:00.000Z",
      missingFrameCount: 1,
      previousObservedAt: "2025-12-31T23:00:00.000Z",
      nextObservedAt: "2026-01-01T02:00:00.000Z",
    }],
  };
  assert.throws(() => evaluateAddPolicyCandidate(badBoundary), /previousObservedAt.*adjacent/i);
});

test("cost provenance is retained and fixed matrix rates reject malformed or mixed evidence", () => {
  const input = passingInput();
  assert.deepEqual(evaluateAddPolicyCandidate(input).observations.fullPath.observations[0], {
    scenario: input.candidate,
    costRole: "BASE",
    costScenarioId: "base",
    feeRate: 0.0005,
    slippageRate: 0.0003,
    totalReturnPct: 0.12,
    maxDrawdownPct: 0.04,
  });

  const invalid = [Number.NaN, Number.POSITIVE_INFINITY, -0.001];
  for (const value of invalid) {
    const malformed = passingInput();
    observation(malformed.fullPath.observations, malformed.candidate, "BASE").feeRate = value;
    assert.throws(() => evaluateAddPolicyCandidate(malformed), /feeRate.*finite non-negative/i);
  }

  const wrongBaseFee = passingInput();
  observation(wrongBaseFee.fullPath.observations, wrongBaseFee.candidate, "BASE").feeRate = 0.0004;
  assert.throws(() => evaluateAddPolicyCandidate(wrongBaseFee), /BASE.*feeRate.*0\.0005/i);

  const wrongBaseSlippage = passingInput();
  observation(wrongBaseSlippage.windows[0]!.observations, "NO_ADD", "BASE").slippageRate = 0.0004;
  assert.throws(() => evaluateAddPolicyCandidate(wrongBaseSlippage), /BASE.*slippageRate.*0\.0003/i);

  const wrongStress = passingInput();
  observation(wrongStress.fullPath.observations, "BASELINE", "STRESS").slippageRate = 0.001;
  assert.throws(() => evaluateAddPolicyCandidate(wrongStress), /STRESS.*slippageRate.*0\.002/i);

  const duplicateIds = passingInput();
  for (const metric of duplicateIds.fullPath.observations) metric.costScenarioId = "same";
  assert.throws(() => evaluateAddPolicyCandidate(duplicateIds), /BASE and STRESS.*IDs.*distinct/i);
});

test("configured and observed slippage rates must be less than one", () => {
  const configured = passingInput();
  configured.baseSlippageRate = 1;
  for (const item of configured.fullPath.observations) {
    if (item.costRole === "BASE") item.slippageRate = 1;
  }
  for (const window of configured.windows) {
    for (const item of window.observations) {
      if (item.costRole === "BASE") item.slippageRate = 1;
    }
  }
  assert.throws(() => evaluateAddPolicyCandidate(configured), /baseSlippageRate.*less than 1/i);

  const observed = passingInput();
  observation(observed.fullPath.observations, observed.candidate, "STRESS").slippageRate = 1;
  assert.throws(() => evaluateAddPolicyCandidate(observed), /slippageRate.*less than 1/i);
});

test("non-finite metrics, invalid counts, and contradictory coverage reject explicitly", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const input = passingInput();
    observation(input.fullPath.observations, input.candidate, "BASE").totalReturnPct = value;
    assert.throws(() => evaluateAddPolicyCandidate(input), /totalReturnPct.*finite/i);
  }

  const badDrawdown = passingInput();
  observation(badDrawdown.fullPath.observations, "BASELINE", "BASE").maxDrawdownPct = -1;
  assert.throws(() => evaluateAddPolicyCandidate(badDrawdown), /maxDrawdownPct.*non-negative/i);

  const badSupport = passingInput();
  badSupport.fullPath.policyExposedCompletedEpisodeCount = 30.5;
  assert.throws(() => evaluateAddPolicyCandidate(badSupport), /episode.*non-negative safe integer/i);

  const badCoverage = passingInput();
  badCoverage.windows[0]!.coverage.observedFrameCount = 25;
  assert.throws(() => evaluateAddPolicyCandidate(badCoverage), /count conservation/i);

  const contradictoryGapDetails = passingInput();
  contradictoryGapDetails.fullPath.coverage.observedFrameCount = 71;
  contradictoryGapDetails.fullPath.coverage.missingFrameCount = 1;
  contradictoryGapDetails.fullPath.coverage.missingRanges = [{
    firstMissingAt: "2026-01-02T12:00:00.000Z",
    lastMissingAt: "2026-01-02T12:00:00.000Z",
    missingFrameCount: 1,
    previousObservedAt: "2026-01-02T11:00:00.000Z",
    nextObservedAt: "2026-01-02T13:00:00.000Z",
  }];
  assert.throws(
    () => evaluateAddPolicyCandidate(contradictoryGapDetails),
    /windowCadenceStatus.*cadence evidence/i,
  );

  const overflow = passingInput();
  observation(overflow.fullPath.observations, overflow.candidate, "BASE").totalReturnPct = Number.MAX_VALUE;
  observation(overflow.fullPath.observations, "BASELINE", "BASE").totalReturnPct = -Number.MAX_VALUE;
  assert.throws(() => evaluateAddPolicyCandidate(overflow), /return delta.*finite/i);

  const outOfBoundsFeatureEvidence = passingInput();
  Object.assign(outOfBoundsFeatureEvidence.windows[0]!.coverage, {
    status: "INCOMPLETE",
    featureLookbackContinuityStatus: "INCOMPLETE",
    featureLookbackAffectedFrameCount: 1,
    featureLookbackAffectedRanges: [{
      firstFrameAt: "2025-12-31T23:00:00.000Z",
      lastFrameAt: "2025-12-31T23:00:00.000Z",
      affectedFrameCount: 1,
    }],
  });
  assert.throws(
    () => evaluateAddPolicyCandidate(outOfBoundsFeatureEvidence),
    /featureLookbackAffectedRanges.*cadence bounds/i,
  );
});

test("duplicate or missing BASELINE, NO_ADD, candidate, base, and stress anchors reject", () => {
  const duplicate = passingInput();
  duplicate.fullPath.observations.push({ ...duplicate.fullPath.observations[0]! });
  assert.throws(() => evaluateAddPolicyCandidate(duplicate), /duplicate.*observation/i);

  const missing = passingInput();
  missing.windows[0]!.observations = missing.windows[0]!.observations.filter(
    (item) => !(item.scenario === "NO_ADD" && item.costRole === "STRESS"),
  );
  assert.throws(() => evaluateAddPolicyCandidate(missing), /exactly one.*NO_ADD.*STRESS/i);

  const mismatchedAnchor = passingInput();
  observation(mismatchedAnchor.windows[1]!.observations, "BASELINE", "BASE").costScenarioId = "other-base";
  assert.throws(() => evaluateAddPolicyCandidate(mismatchedAnchor), /cost anchor.*BASE/i);
});

test("mixed timezone windows normalize exact instants and preserve half-open boundaries", () => {
  const input = passingInput();
  input.windows = [
    {
      ...input.windows[0]!,
      from: "2026-01-01T09:00:00+09:00",
      to: "2026-01-02T09:00:00+09:00",
    },
    ...input.windows.slice(1),
  ];
  const result = evaluateAddPolicyCandidate(input);
  assert.equal(result.observations.windows[0]?.from, "2026-01-01T00:00:00.000Z");
  assert.equal(result.observations.windows[0]?.to, "2026-01-02T00:00:00.000Z");
  assert.equal(result.observations.windows[1]?.from, result.observations.windows[0]?.to);

  const noTimezone = passingInput();
  noTimezone.windows[0]!.from = "2026-01-01T00:00:00";
  assert.throws(() => evaluateAddPolicyCandidate(noTimezone), /explicit timezone/i);

  const overlap = passingInput();
  overlap.windows[1]!.from = "2026-01-01T23:59:59.999999999Z";
  assert.throws(() => evaluateAddPolicyCandidate(overlap), /overlap/i);

  const reversed = passingInput();
  reversed.windows.reverse();
  assert.throws(() => evaluateAddPolicyCandidate(reversed), /strictly ordered/i);
});

function passingInput(): AddPolicyCandidateEvaluationInput {
  const candidate = "ADD_HIGH_ALIGNMENT" as const;
  return {
    asset: "BTC",
    candidate,
    baseSlippageRate: 0.0003,
    thresholds: { ...APPROVED_ADD_POLICY_EVALUATION_THRESHOLDS },
    fullPath: {
      policyExposedCompletedEpisodeCount: 30,
      observations: observations(candidate, 0.12, 0.08, 0.04, 0.05),
      coverage: completeCoverage(72),
    } as AddPolicyCandidateEvaluationInput["fullPath"],
    windows: [
      window("w1", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", candidate),
      window("w2", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z", candidate),
      window("w3", "2026-01-03T00:00:00.000Z", "2026-01-04T00:00:00.000Z", candidate),
    ],
  };
}

function window(id: string, from: string, to: string, candidate: AddPolicyCandidateEvaluationInput["candidate"]) {
  return {
    id,
    from,
    to,
    coverage: completeCoverage(24, from),
    policyExposedCompletedEpisodeCount: 10,
    observations: observations(candidate, 0.03, 0.02, 0.01, 0.02),
  };
}

function completeCoverage(
  expectedFrameCount: number,
  firstExpectedFrameAt = "2026-01-01T00:00:00.000Z",
) {
  const endExclusiveAt = new Date(
    Date.parse(firstExpectedFrameAt) + expectedFrameCount * 60 * 60 * 1000,
  ).toISOString();
  return {
    status: "COMPLETE" as const,
    windowCadenceStatus: "COMPLETE" as const,
    windowSequenceContinuityStatus: "COMPLETE" as const,
    windowClockGridStatus: "DENSE" as const,
    upstreamStateContinuityStatus: "COMPLETE" as const,
    upstreamSequenceContinuityStatus: "COMPLETE" as const,
    upstreamClockGridStatus: "DENSE" as const,
    featureLookbackContinuityStatus: "COMPLETE" as const,
    expectedFrameIntervalMs: 60 * 60 * 1000,
    firstExpectedFrameAt,
    endExclusiveAt,
    expectedFrameCount,
    observedFrameCount: expectedFrameCount,
    noTradeFrameCount: 0,
    noTradeRanges: [],
    missingFrameCount: 0,
    duplicateFrameCount: 0,
    offGridFrameCount: 0,
    missingRanges: [],
    duplicateInstants: [],
    offGridInstants: [],
    upstreamExpectedFrameCount: 0,
    upstreamObservedFrameCount: 0,
    upstreamNoTradeFrameCount: 0,
    upstreamNoTradeRanges: [],
    upstreamFirstExpectedFrameAt: null,
    upstreamEndExclusiveAt: null,
    upstreamMissingFrameCount: 0,
    upstreamDuplicateFrameCount: 0,
    upstreamOffGridFrameCount: 0,
    upstreamMissingRanges: [],
    upstreamDuplicateInstants: [],
    upstreamOffGridInstants: [],
    featureLookbackAffectedFrameCount: 0,
    featureLookbackAffectedRanges: [],
  };
}

function cadenceGap(firstMissingAt: string) {
  const previousObservedAt = new Date(Date.parse(firstMissingAt) - 60 * 60 * 1000).toISOString();
  const nextObservedAt = new Date(Date.parse(firstMissingAt) + 60 * 60 * 1000).toISOString();
  return {
    firstMissingAt,
    lastMissingAt: firstMissingAt,
    missingFrameCount: 1,
    previousObservedAt,
    nextObservedAt,
  };
}

function observations(
  candidate: AddPolicyCandidateEvaluationInput["candidate"],
  candidateBaseReturn: number,
  candidateStressReturn: number,
  candidateBaseDrawdown: number,
  candidateStressDrawdown: number,
): AddPolicyEvaluationObservation[] {
  return [
    metric(candidate, "BASE", "base", 0.0005, 0.0003, candidateBaseReturn, candidateBaseDrawdown),
    metric("BASELINE", "BASE", "base", 0.0005, 0.0003, candidateBaseReturn - 0.02, 0.05),
    metric("NO_ADD", "BASE", "base", 0.0005, 0.0003, candidateBaseReturn - 0.01, 0.045),
    metric(candidate, "STRESS", "stress", 0.001, 0.002, candidateStressReturn, candidateStressDrawdown),
    metric("BASELINE", "STRESS", "stress", 0.001, 0.002, candidateStressReturn - 0.02, 0.06),
    metric("NO_ADD", "STRESS", "stress", 0.001, 0.002, candidateStressReturn - 0.01, 0.055),
  ];
}

function metric(
  scenario: AddPolicyEvaluationObservation["scenario"],
  costRole: AddPolicyEvaluationObservation["costRole"],
  costScenarioId: string,
  feeRate: number,
  slippageRate: number,
  totalReturnPct: number,
  maxDrawdownPct: number,
): AddPolicyEvaluationObservation {
  return { scenario, costRole, costScenarioId, feeRate, slippageRate, totalReturnPct, maxDrawdownPct };
}

function observation(
  source: AddPolicyEvaluationObservation[] | { observations: AddPolicyEvaluationObservation[] },
  scenario: AddPolicyEvaluationObservation["scenario"],
  costRole: AddPolicyEvaluationObservation["costRole"],
): AddPolicyEvaluationObservation {
  const observations = Array.isArray(source) ? source : source.observations;
  const result = observations.find((item) => item.scenario === scenario && item.costRole === costRole);
  if (!result) throw new Error(`Missing fixture observation ${scenario}/${costRole}.`);
  return result;
}

function comparison(
  costRole: "BASE" | "STRESS",
  anchor: "BASELINE" | "NO_ADD",
  candidateReturnPct: number,
  anchorReturnPct: number,
  deltaPercentagePoints: number,
  passed: boolean,
) {
  return {
    costRole,
    anchor,
    candidateReturnPct,
    anchorReturnPct,
    deltaPercentagePoints,
    thresholdPercentagePoints: 0,
    operator: ">" as const,
    passed,
  };
}

function rounded(value: number): number {
  return Number(value.toFixed(12));
}
