import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PROSPECTIVE_SHADOW_POLICY_MANIFEST,
  createProspectiveShadowRegistration,
  serializeProspectiveShadowRegistration,
  serializeProspectiveShadowRegistryEvent,
  type ProspectiveShadowRegistration,
} from "../src/modules/performance/performance-prospective-shadow-registration.js";
import {
  PROSPECTIVE_SHADOW_ASSURANCE,
  PROSPECTIVE_SHADOW_BRANCH,
  PROSPECTIVE_SHADOW_CLOSURE_CONFIRMATION,
  PROSPECTIVE_SHADOW_INITIAL_CONFIRMATION,
  PROSPECTIVE_SHADOW_REGISTRATION_PATH,
  PROSPECTIVE_SHADOW_REGISTRY_PATH,
  PROSPECTIVE_SHADOW_REPOSITORY,
  PROSPECTIVE_SHADOW_WORKFLOW_PATH,
  type ValidateProspectiveShadowClosureCommitmentInput,
  type ValidateProspectiveShadowCommitmentInput,
} from "../src/modules/performance/performance-prospective-shadow-commitment.js";
import {
  ProspectiveShadowEvaluationError,
  evaluateProspectiveComponentShadow,
  type ProspectiveShadowCompletenessGate,
  type ProspectiveShadowPathEvidence,
} from "../src/modules/performance/performance-prospective-shadow-evaluation.js";

const IMPLEMENTATION_SHA = "a".repeat(40);
const PUBLICATION_SHA = "b".repeat(40);
const CLOSURE_SHA = "c".repeat(40);
const ABANDONMENT_SHA = "f".repeat(40);
const WORKFLOW_BYTES = "name: prospective-shadow\n";

type Fixture = Readonly<{
  registration: ProspectiveShadowRegistration;
  initialCommitmentInput: ValidateProspectiveShadowCommitmentInput;
  closureCommitmentInput: ValidateProspectiveShadowClosureCommitmentInput;
  evidence: readonly ProspectiveShadowPathEvidence[];
}>;

function createFixture(options: Readonly<{
  registeredAt?: string;
  retrospectiveReportSha256?: string;
}> = {}): Fixture {
  const registration = createProspectiveShadowRegistration({
    registeredAt: options.registeredAt ?? "2026-01-01T00:00:00Z",
    implementationCommitSha: IMPLEMENTATION_SHA,
    developmentAuthoritySha256: "d".repeat(64),
    retrospectiveReportSha256: options.retrospectiveReportSha256 ?? "e".repeat(64),
    policyManifest: PROSPECTIVE_SHADOW_POLICY_MANIFEST,
  });
  const registrationBytes = serializeProspectiveShadowRegistration(registration);
  const registryBytes = serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1,
    authority: registration.authority,
    experimentId: registration.experimentId,
    event: "REGISTERED",
    eventAt: registration.registeredAt,
    registrationPayloadSha256: registration.payloadSha256,
  });
  const runUrl = `https://github.com/${PROSPECTIVE_SHADOW_REPOSITORY}/actions/runs/101`;
  const initialCommitmentInput: ValidateProspectiveShadowCommitmentInput = {
    registration,
    metadata: {
      schemaVersion: 1,
      authority: registration.authority,
      mode: "REGISTERED_PUBLICATION",
      repository: PROSPECTIVE_SHADOW_REPOSITORY,
      branch: PROSPECTIVE_SHADOW_BRANCH,
      runId: 101,
      runUrl,
      serverCreatedAt: "2026-01-01T01:00:00Z",
      implementationCommitSha: IMPLEMENTATION_SHA,
      publicationCommitSha: PUBLICATION_SHA,
      headSha: PUBLICATION_SHA,
      registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH,
      registryPath: PROSPECTIVE_SHADOW_REGISTRY_PATH,
      workflowPath: PROSPECTIVE_SHADOW_WORKFLOW_PATH,
      registrationPayloadSha256: registration.payloadSha256,
    },
    manualVerification: {
      confirmation: PROSPECTIVE_SHADOW_INITIAL_CONFIRMATION,
      verifiedAt: "2026-01-01T01:01:00Z",
      runUrl,
      repository: PROSPECTIVE_SHADOW_REPOSITORY,
      branch: PROSPECTIVE_SHADOW_BRANCH,
      runId: 101,
      implementationCommitSha: IMPLEMENTATION_SHA,
      publicationCommitSha: PUBLICATION_SHA,
      registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH,
      registrationPayloadSha256: registration.payloadSha256,
    },
    gitEvidence: {
      mode: "REGISTERED_PUBLICATION",
      currentHeadSha: IMPLEMENTATION_SHA,
      publicationCommitSha: PUBLICATION_SHA,
      publicationParents: [IMPLEMENTATION_SHA],
      publicationChangedPaths: [PROSPECTIVE_SHADOW_REGISTRATION_PATH, PROSPECTIVE_SHADOW_REGISTRY_PATH],
      registrationAtImplementation: { status: "MISSING", exitCode: 128, stderr: "missing" },
      registryAtImplementation: { status: "MISSING", exitCode: 128, stderr: "missing" },
      registrationBytes,
      registryBytes,
      workflowAtImplementationBytes: WORKFLOW_BYTES,
      workflowAtPublicationBytes: WORKFLOW_BYTES,
    },
  };
  const history = [{
    commitSha: PUBLICATION_SHA,
    parents: [IMPLEMENTATION_SHA],
    changedPaths: [PROSPECTIVE_SHADOW_REGISTRATION_PATH, PROSPECTIVE_SHADOW_REGISTRY_PATH],
    registration: { status: "PRESENT" as const, bytes: registrationBytes },
    registry: { status: "PRESENT" as const, bytes: registryBytes },
    workflowBytes: WORKFLOW_BYTES,
  }];
  const closureRunUrl = `https://github.com/${PROSPECTIVE_SHADOW_REPOSITORY}/actions/runs/202`;
  const registrySha256 = createHash("sha256").update(registryBytes, "utf8").digest("hex");
  const closureCommitmentInput: ValidateProspectiveShadowClosureCommitmentInput = {
    registration,
    initialCommitmentInput,
    metadata: {
      schemaVersion: 1,
      authority: registration.authority,
      mode: "CLOSURE",
      repository: PROSPECTIVE_SHADOW_REPOSITORY,
      branch: PROSPECTIVE_SHADOW_BRANCH,
      runId: 202,
      runUrl: closureRunUrl,
      serverCreatedAt: registration.window.to,
      implementationCommitSha: IMPLEMENTATION_SHA,
      publicationCommitSha: PUBLICATION_SHA,
      headSha: CLOSURE_SHA,
      registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH,
      registryPath: PROSPECTIVE_SHADOW_REGISTRY_PATH,
      workflowPath: PROSPECTIVE_SHADOW_WORKFLOW_PATH,
      registrationPayloadSha256: registration.payloadSha256,
      closureTipSha: CLOSURE_SHA,
      registryClassification: "ACTIVE_AT_CLOSE",
      registrySha256,
      relevantPathHistory: history,
      abandonmentMetadata: null,
    },
    manualVerification: {
      confirmation: PROSPECTIVE_SHADOW_CLOSURE_CONFIRMATION,
      verifiedAt: registration.window.to,
      runUrl: closureRunUrl,
      repository: PROSPECTIVE_SHADOW_REPOSITORY,
      branch: PROSPECTIVE_SHADOW_BRANCH,
      runId: 202,
      implementationCommitSha: IMPLEMENTATION_SHA,
      publicationCommitSha: PUBLICATION_SHA,
      closureTipSha: CLOSURE_SHA,
      registrySha256,
      latestRelevantPathCommitSha: PUBLICATION_SHA,
      noLaterRelevantPathCommit: true,
    },
    gitEvidence: {
      mode: "CLOSURE",
      currentHeadSha: IMPLEMENTATION_SHA,
      publicationCommitSha: PUBLICATION_SHA,
      closureTipSha: CLOSURE_SHA,
      publicationIsAncestorOfClosureTip: true,
      registrationAtPublicationBytes: registrationBytes,
      registrationAtClosureBytes: registrationBytes,
      registryAtClosureBytes: registryBytes,
      workflowAtImplementationBytes: WORKFLOW_BYTES,
      workflowAtClosureBytes: WORKFLOW_BYTES,
      relevantPathHistory: history,
    },
  };
  return { registration, initialCommitmentInput, closureCommitmentInput, evidence: createCompleteEvidence(registration) };
}

function metric<Unit extends "RATIO" | "KRW">(unit: Unit, value: number) {
  return { unit, value, complete: true as const, unknownReason: null };
}

function unknownMetric<Unit extends "RATIO" | "KRW">(unit: Unit, unknownReason: string) {
  return { unit, value: null, complete: false as const, unknownReason };
}

function nextRepresentableAbove(value: number): number {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  view.setBigUint64(0, view.getBigUint64(0, false) + 1n, false);
  return view.getFloat64(0, false);
}

function createCompleteEvidence(registration: ProspectiveShadowRegistration): readonly ProspectiveShadowPathEvidence[] {
  return registration.matrix.assets.flatMap(({ asset, market }) =>
    registration.matrix.scenarios.flatMap((scenario) =>
      registration.matrix.timings.flatMap((timing) =>
        registration.matrix.costs.map((cost) => ({
          asset,
          market,
          scenario,
          timing,
          costId: cost.id,
          completedKnownNetEpisodes: 10,
          openEpisodes: 0,
          incompleteGates: [],
          metrics: {
            netReturn: metric("RATIO", scenario === "COMBINED_CONSERVATIVE" ? 0.01 : 0.011),
            maximumRealizedDrawdown: metric("RATIO", 0.05),
            turnover: metric("KRW", 100_000),
            modeledFees: metric("KRW", 50),
          },
        })),
      ),
    ),
  );
}

function replacePath(
  evidence: readonly ProspectiveShadowPathEvidence[],
  predicate: (path: ProspectiveShadowPathEvidence) => boolean,
  update: (path: ProspectiveShadowPathEvidence) => ProspectiveShadowPathEvidence,
): readonly ProspectiveShadowPathEvidence[] {
  return evidence.map((path) => predicate(path) ? update(structuredClone(path)) : structuredClone(path));
}

function evaluateFinal(fixture: Fixture, evidence = fixture.evidence) {
  return evaluateProspectiveComponentShadow({
    registration: fixture.registration,
    initialCommitmentInput: fixture.initialCommitmentInput,
    closureCommitmentInput: fixture.closureCommitmentInput,
    asOf: fixture.registration.window.to,
    pathEvidence: evidence,
  });
}

function createValidAbandonedClosure(fixture: Fixture): ValidateProspectiveShadowClosureCommitmentInput {
  const registrationBytes = serializeProspectiveShadowRegistration(fixture.registration);
  const initialRegistryBytes = fixture.initialCommitmentInput.gitEvidence.registryBytes;
  const abandonedRegistryBytes = `${initialRegistryBytes}${serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1,
    authority: fixture.registration.authority,
    experimentId: fixture.registration.experimentId,
    event: "ABANDONED",
    eventAt: "2026-04-01T00:00:00Z",
    registrationPayloadSha256: fixture.registration.payloadSha256,
    publicationCommitSha: PUBLICATION_SHA,
    reason: "prospective protocol abandoned before close",
  })}`;
  const publicationHistory = fixture.closureCommitmentInput.metadata.relevantPathHistory[0]!;
  const history = [publicationHistory, {
    commitSha: ABANDONMENT_SHA,
    parents: [PUBLICATION_SHA],
    changedPaths: [PROSPECTIVE_SHADOW_REGISTRY_PATH],
    registration: { status: "PRESENT" as const, bytes: registrationBytes },
    registry: { status: "PRESENT" as const, bytes: abandonedRegistryBytes },
    workflowBytes: WORKFLOW_BYTES,
  }];
  const registrySha256 = createHash("sha256").update(abandonedRegistryBytes, "utf8").digest("hex");
  const abandonmentRunId = 150;
  const abandonmentRunUrl = `https://github.com/${PROSPECTIVE_SHADOW_REPOSITORY}/actions/runs/${abandonmentRunId}`;
  const closure = structuredClone(fixture.closureCommitmentInput);
  return {
    ...closure,
    metadata: {
      ...closure.metadata,
      registryClassification: "ABANDONED",
      registrySha256,
      relevantPathHistory: history,
      abandonmentMetadata: {
        schemaVersion: 1,
        authority: fixture.registration.authority,
        mode: "ABANDONED",
        repository: PROSPECTIVE_SHADOW_REPOSITORY,
        branch: PROSPECTIVE_SHADOW_BRANCH,
        runId: abandonmentRunId,
        runUrl: abandonmentRunUrl,
        serverCreatedAt: "2026-04-01T00:01:00Z",
        implementationCommitSha: IMPLEMENTATION_SHA,
        publicationCommitSha: PUBLICATION_SHA,
        headSha: ABANDONMENT_SHA,
        registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH,
        registryPath: PROSPECTIVE_SHADOW_REGISTRY_PATH,
        workflowPath: PROSPECTIVE_SHADOW_WORKFLOW_PATH,
        registrationPayloadSha256: fixture.registration.payloadSha256,
      },
    },
    manualVerification: {
      ...closure.manualVerification,
      registrySha256,
      latestRelevantPathCommitSha: ABANDONMENT_SHA,
    },
    gitEvidence: {
      ...closure.gitEvidence,
      registryAtClosureBytes: abandonedRegistryBytes,
      relevantPathHistory: history,
    },
  };
}

function candidate(result: ReturnType<typeof evaluateFinal>, asset: "BTC" | "ETH", scenario: string) {
  assert.notEqual(result.outcomes, null);
  const outcomes = result.outcomes;
  assert.ok(outcomes);
  const found = outcomes.assets.find((entry) => entry.asset === asset)?.candidates.find((entry) => entry.scenario === scenario);
  assert.ok(found);
  return found;
}

test("before window end returns COLLECTING without accepting closure or exposing outcome metrics", () => {
  const fixture = createFixture();
  const result = evaluateProspectiveComponentShadow({
    registration: fixture.registration,
    initialCommitmentInput: fixture.initialCommitmentInput,
    closureCommitmentInput: null,
    asOf: "2026-05-02T23:59:59.999999999Z",
    pathEvidence: null,
  });

  assert.equal(result.phase, "COLLECTING");
  assert.equal(result.outcomes, null);
  assert.equal(result.calendar.windowComplete, false);
  assert.equal(JSON.stringify(result).includes("netReturn"), false);
  assert.equal(result.commitment.assurance, PROSPECTIVE_SHADOW_ASSURANCE);
});

test("asOf exactly equal to window.to performs final independent candidate evaluation", () => {
  const fixture = createFixture();
  const result = evaluateFinal(fixture);

  assert.equal(result.phase, "FINAL");
  assert.equal(result.calendar.windowComplete, true);
  assert.equal(candidate(result, "BTC", "COMBINED_MINUS_EARLY_THESIS_FAILURE").status, "SUPPORTS_CONTINUED_SHADOW");
  assert.equal(candidate(result, "ETH", "COMBINED_MINUS_COOLDOWN_CONTROL").status, "SUPPORTS_CONTINUED_SHADOW");
});

test("nine harmful known-net episodes remain INSUFFICIENT and open episodes do not count", () => {
  const fixture = createFixture();
  const evidence = replacePath(fixture.evidence, (path) => path.asset === "BTC", (path) => ({
    ...path,
    completedKnownNetEpisodes: 9,
    openEpisodes: 100,
    metrics: path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE"
      ? { ...path.metrics, netReturn: metric("RATIO", -0.5) }
      : path.metrics,
  }));
  const result = evaluateFinal(fixture, evidence);
  const evaluated = candidate(result, "BTC", "COMBINED_MINUS_EARLY_THESIS_FAILURE");

  assert.equal(evaluated.status, "INSUFFICIENT");
  assert.ok(evaluated.reasonCodes.includes("INSUFFICIENT_EPISODE_SUPPORT"));
  assert.equal(evaluated.reasonCodes.includes("KNOWN_HARM_NET_RETURN"), false);
});

test("ten supported episodes plus complete harm rejects despite a different-cell incomplete gate", () => {
  const fixture = createFixture();
  const withHarm = replacePath(fixture.evidence, (path) =>
    path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE" && path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE",
  (path) => ({
    ...path,
    metrics: { ...path.metrics, netReturn: metric("RATIO", -0.01) },
  }));
  const evidence = replacePath(withHarm, (path) =>
    path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE" && path.timing === "NEXT_FRAME_MODELED" && path.costId === "STRESS",
  (path) => ({
    ...path,
    completedKnownNetEpisodes: 0,
    incompleteGates: ["NO_TRADE_COVERAGE"],
    metrics: {
      netReturn: unknownMetric("RATIO", "different-cell no-trade coverage unavailable"),
      maximumRealizedDrawdown: unknownMetric("RATIO", "different-cell no-trade coverage unavailable"),
      turnover: unknownMetric("KRW", "different-cell no-trade coverage unavailable"),
      modeledFees: unknownMetric("KRW", "different-cell no-trade coverage unavailable"),
    },
  }));
  const evaluated = candidate(evaluateFinal(fixture, evidence), "BTC", "COMBINED_MINUS_EARLY_THESIS_FAILURE");

  assert.equal(evaluated.status, "REJECTED");
  assert.ok(evaluated.reasonCodes.includes("KNOWN_HARM_NET_RETURN"));
  assert.ok(evaluated.reasonCodes.includes("INCOMPLETE_EVIDENCE"));
  assert.deepEqual(evaluated.reasonDetails.map((entry) => entry.code), evaluated.reasonCodes);
  assert.ok(evaluated.reasonDetails.every((entry) => entry.detail.trim().length > 0));
  assert.match(
    evaluated.reasonDetails.find((entry) => entry.code === "KNOWN_HARM_NET_RETURN")!.detail,
    /0\.000001 percentage points/,
  );
});

test("return, drawdown, turnover, and fee harm use explicit percentage-point and KRW units", () => {
  const cases = [
    ["netReturn", metric("RATIO", 0), "KNOWN_HARM_NET_RETURN", "PERCENTAGE_POINTS"],
    ["maximumRealizedDrawdown", metric("RATIO", 0.06), "KNOWN_HARM_DRAWDOWN", "PERCENTAGE_POINTS"],
    ["turnover", metric("KRW", 100_001), "KNOWN_HARM_TURNOVER", "KRW"],
    ["modeledFees", metric("KRW", 51), "KNOWN_HARM_FEES", "KRW"],
  ] as const;
  for (const [key, changedMetric, reason, unit] of cases) {
    const fixture = createFixture();
    const evidence = replacePath(fixture.evidence, (path) =>
      path.asset === "BTC" && path.scenario === "COMBINED_MINUS_COOLDOWN_CONTROL" && path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE",
    (path) => ({ ...path, metrics: { ...path.metrics, [key]: changedMetric } } as ProspectiveShadowPathEvidence));
    const evaluated = candidate(evaluateFinal(fixture, evidence), "BTC", "COMBINED_MINUS_COOLDOWN_CONTROL");
    assert.equal(evaluated.status, "REJECTED", key);
    assert.ok(evaluated.reasonCodes.includes(reason), key);
    const cell = evaluated.cells.find((entry) => entry.timing === "SAME_CLOSE_MODELED" && entry.costId === "BASE");
    assert.ok(cell);
    assert.equal(cell.deltas[key].unit, unit);
  }
});

test("unknown metric and evidence gates stay explicit and produce INSUFFICIENT without known harm", () => {
  const fixture = createFixture();
  const evidence = replacePath(fixture.evidence, (path) =>
    path.asset === "ETH" && path.scenario === "COMBINED_MINUS_COOLDOWN_CONTROL" && path.timing === "NEXT_FRAME_MODELED" && path.costId === "STRESS",
  (path) => ({
    ...path,
    completedKnownNetEpisodes: 0,
    incompleteGates: ["FEE_EVIDENCE", "LIFECYCLE", "FINITE_METRICS", "CADENCE", "FEATURE_COVERAGE", "NO_TRADE_COVERAGE"],
    metrics: {
      netReturn: unknownMetric("RATIO", "net return cannot be established"),
      maximumRealizedDrawdown: unknownMetric("RATIO", "drawdown cannot be established"),
      turnover: unknownMetric("KRW", "turnover cannot be established"),
      modeledFees: unknownMetric("KRW", "modeled fee evidence missing"),
    },
  }));
  const evaluated = candidate(evaluateFinal(fixture, evidence), "ETH", "COMBINED_MINUS_COOLDOWN_CONTROL");

  assert.equal(evaluated.status, "INSUFFICIENT");
  assert.ok(evaluated.reasonCodes.includes("INCOMPLETE_EVIDENCE"));
  assert.deepEqual(evaluated.incompleteGates, ["CADENCE", "FEATURE_COVERAGE", "NO_TRADE_COVERAGE", "LIFECYCLE", "FEE_EVIDENCE", "FINITE_METRICS"] satisfies ProspectiveShadowCompletenessGate[]);
});

test("complete non-worse evidence with no qualifying return benefit is REJECTED", () => {
  const fixture = createFixture();
  const evidence = replacePath(fixture.evidence, (path) => path.scenario !== "COMBINED_CONSERVATIVE", (path) => ({
    ...path,
    metrics: { ...path.metrics, netReturn: metric("RATIO", 0.01) },
  }));
  const evaluated = candidate(evaluateFinal(fixture, evidence), "BTC", "COMBINED_MINUS_EARLY_THESIS_FAILURE");

  assert.equal(evaluated.status, "REJECTED");
  assert.deepEqual(evaluated.reasonCodes, ["NO_MEANINGFUL_NET_RETURN_IMPROVEMENT"]);
});

test("nonzero-baseline tolerance boundaries distinguish exact, inside, and outside values", () => {
  const fixture = createFixture();
  const toleranceRatio = fixture.registration.comparisonPolicy.percentagePointTolerance / 100;
  const krwTolerance = fixture.registration.comparisonPolicy.krwTolerance;
  const baselineEvidence = replacePath(fixture.evidence, () => true, (path) => ({
    ...path,
    metrics: {
      netReturn: metric("RATIO", 0.1),
      maximumRealizedDrawdown: metric("RATIO", 0.1),
      turnover: metric("KRW", 100_000),
      modeledFees: metric("KRW", 50),
    },
  }));
  const candidatePath = (path: ProspectiveShadowPathEvidence) =>
    path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE";

  for (const multiplier of [0.5, 1]) {
    const evidence = replacePath(baselineEvidence, candidatePath, (path) => ({
      ...path,
      metrics: {
        netReturn: metric("RATIO", 0.1 + toleranceRatio * multiplier),
        maximumRealizedDrawdown: metric("RATIO", 0.1 + toleranceRatio * multiplier),
        turnover: metric("KRW", 100_000 + krwTolerance * multiplier),
        modeledFees: metric("KRW", 50 + krwTolerance * multiplier),
      },
    }));
    const evaluated = candidate(evaluateFinal(fixture, evidence), "BTC", "COMBINED_MINUS_EARLY_THESIS_FAILURE");
    assert.equal(evaluated.status, "REJECTED", `multiplier=${multiplier}`);
    assert.deepEqual(evaluated.reasonCodes, ["NO_MEANINGFUL_NET_RETURN_IMPROVEMENT"], `multiplier=${multiplier}`);
    assert.equal(evaluated.cells[0]!.deltas.netReturn.unit, "PERCENTAGE_POINTS");
    assert.equal(evaluated.cells[0]!.deltas.turnover.unit, "KRW");
  }

  const beneficial = replacePath(baselineEvidence, candidatePath, (path) => ({
    ...path,
    metrics: { ...path.metrics, netReturn: metric("RATIO", 0.1 + toleranceRatio * 2) },
  }));
  assert.equal(
    candidate(evaluateFinal(fixture, beneficial), "BTC", "COMBINED_MINUS_EARLY_THESIS_FAILURE").status,
    "SUPPORTS_CONTINUED_SHADOW",
  );

  const harmfulReturn = replacePath(baselineEvidence, candidatePath, (path) => ({
    ...path,
    metrics: { ...path.metrics, netReturn: metric("RATIO", 0.1 - toleranceRatio * 2) },
  }));
  assert.ok(candidate(evaluateFinal(fixture, harmfulReturn), "BTC", "COMBINED_MINUS_EARLY_THESIS_FAILURE")
    .reasonCodes.includes("KNOWN_HARM_NET_RETURN"));

  const harmfulCosts = replacePath(baselineEvidence, candidatePath, (path) => ({
    ...path,
    metrics: {
      ...path.metrics,
      maximumRealizedDrawdown: metric("RATIO", 0.1 + toleranceRatio * 2),
      turnover: metric("KRW", 100_000 + krwTolerance * 2),
      modeledFees: metric("KRW", 50 + krwTolerance * 2),
    },
  }));
  const harmfulCostResult = candidate(evaluateFinal(fixture, harmfulCosts), "BTC", "COMBINED_MINUS_EARLY_THESIS_FAILURE");
  assert.ok(harmfulCostResult.reasonCodes.includes("KNOWN_HARM_DRAWDOWN"));
  assert.ok(harmfulCostResult.reasonCodes.includes("KNOWN_HARM_TURNOVER"));
  assert.ok(harmfulCostResult.reasonCodes.includes("KNOWN_HARM_FEES"));
});

test("large KRW baselines honor the configured absolute tolerance without a magnitude-scaled guard", () => {
  const fixture = createFixture();
  const baseline = 100_000_000;
  const tolerance = fixture.registration.comparisonPolicy.krwTolerance;
  const next = nextRepresentableAbove(baseline);
  const outside = nextRepresentableAbove(next);
  assert.equal(baseline + tolerance, baseline, "the exact tolerance is below one ULP at this baseline");
  assert.equal(baseline + tolerance / 2, baseline, "an inside-tolerance value is also rounded to baseline");
  assert.ok(next - baseline > tolerance);

  const baselineEvidence = replacePath(fixture.evidence, () => true, (path) => ({
    ...path,
    metrics: {
      ...path.metrics,
      turnover: metric("KRW", baseline),
      modeledFees: metric("KRW", baseline),
    },
  }));
  const selectedPath = (path: ProspectiveShadowPathEvidence) =>
    path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE";

  for (const [label, candidateValue, harmful] of [
    ["inside", baseline + tolerance / 2, false],
    ["exact", baseline + tolerance, false],
    ["next-representable", next, true],
    ["outside", outside, true],
  ] as const) {
    const evidence = replacePath(baselineEvidence, selectedPath, (path) => ({
      ...path,
      metrics: {
        ...path.metrics,
        turnover: metric("KRW", candidateValue),
        modeledFees: metric("KRW", candidateValue),
      },
    }));
    const evaluated = candidate(
      evaluateFinal(fixture, evidence),
      "BTC",
      "COMBINED_MINUS_EARLY_THESIS_FAILURE",
    );
    assert.equal(evaluated.reasonCodes.includes("KNOWN_HARM_TURNOVER"), harmful, label);
    assert.equal(evaluated.reasonCodes.includes("KNOWN_HARM_FEES"), harmful, label);
    assert.equal(evaluated.cells[0]!.deltas.turnover.unit, "KRW", label);
  }

  const ratioTolerance = fixture.registration.comparisonPolicy.percentagePointTolerance / 100;
  const percentagePointBaseline = replacePath(fixture.evidence, () => true, (path) => ({
    ...path,
    metrics: { ...path.metrics, maximumRealizedDrawdown: metric("RATIO", 0.1) },
  }));
  const percentagePointEvidence = replacePath(percentagePointBaseline, selectedPath, (path) => ({
    ...path,
    metrics: {
      ...path.metrics,
      maximumRealizedDrawdown: metric("RATIO", 0.1 + ratioTolerance),
    },
  }));
  const percentagePointResult = candidate(
    evaluateFinal(fixture, percentagePointEvidence),
    "BTC",
    "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  );
  assert.equal(percentagePointResult.reasonCodes.includes("KNOWN_HARM_DRAWDOWN"), false);
  assert.equal(percentagePointResult.cells[0]!.deltas.maximumRealizedDrawdown.unit, "PERCENTAGE_POINTS");
});

test("top-level registration is bound to the exact initial and closure registration payload", () => {
  const fixture = createFixture();
  const differentCalendar = createFixture({ registeredAt: "2025-12-31T00:00:00Z" });
  const differentReport = createFixture({ retrospectiveReportSha256: "9".repeat(64) });

  for (const substituted of [differentCalendar, differentReport]) {
    assert.equal(substituted.registration.implementationCommitSha, fixture.registration.implementationCommitSha);
    assert.notEqual(substituted.registration.payloadSha256, fixture.registration.payloadSha256);
    assert.throws(() => evaluateProspectiveComponentShadow({
      registration: fixture.registration,
      initialCommitmentInput: substituted.initialCommitmentInput,
      closureCommitmentInput: substituted.closureCommitmentInput,
      asOf: fixture.registration.window.to,
      pathEvidence: fixture.evidence,
    }), (error) => error instanceof ProspectiveShadowEvaluationError && error.code === "REGISTRATION_INVALID");
  }
});

test("affected evidence gates cannot contradict dependent metrics or known-net episode support", () => {
  const fixture = createFixture();
  const contradictions: readonly ((path: ProspectiveShadowPathEvidence) => ProspectiveShadowPathEvidence)[] = [
    (path) => ({ ...path, incompleteGates: ["FEE_EVIDENCE"] }),
    (path) => ({ ...path, incompleteGates: ["LIFECYCLE"] }),
    (path) => ({ ...path, incompleteGates: ["FINITE_METRICS"] }),
    (path) => ({
      ...path,
      completedKnownNetEpisodes: 1,
      incompleteGates: ["FEE_EVIDENCE"],
      metrics: {
        ...path.metrics,
        netReturn: unknownMetric("RATIO", "fees unavailable"),
        modeledFees: unknownMetric("KRW", "fees unavailable"),
      },
    }),
    (path) => ({
      ...path,
      incompleteGates: [],
      metrics: {
        ...path.metrics,
        modeledFees: unknownMetric("KRW", "fees unavailable without matching gate"),
      },
    }),
    (path) => ({
      ...path,
      completedKnownNetEpisodes: 1,
      incompleteGates: [],
      metrics: {
        ...path.metrics,
        netReturn: unknownMetric("RATIO", "aggregate net return unavailable"),
      },
    }),
  ];
  for (const contradict of contradictions) {
    const evidence = replacePath(fixture.evidence, (path) => path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE" && path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE", contradict);
    assert.throws(() => evaluateFinal(fixture, evidence), (error) =>
      error instanceof ProspectiveShadowEvaluationError && error.code === "EVIDENCE_INVALID");
  }
});

test("affected incomplete fee evidence blocks same-path harm", () => {
  const fixture = createFixture();
  const affected = replacePath(fixture.evidence, (path) =>
    path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE" && path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE",
  (path) => ({
    ...path,
    completedKnownNetEpisodes: 0,
    incompleteGates: ["FEE_EVIDENCE"],
    metrics: {
      ...path.metrics,
      netReturn: unknownMetric("RATIO", "fees unavailable"),
      modeledFees: unknownMetric("KRW", "fees unavailable"),
    },
  }));
  const affectedResult = candidate(evaluateFinal(fixture, affected), "BTC", "COMBINED_MINUS_EARLY_THESIS_FAILURE");
  assert.equal(affectedResult.status, "INSUFFICIENT");
  assert.equal(affectedResult.reasonCodes.some((code) => code.startsWith("KNOWN_HARM")), false);
});

test("INITIAL_STATE is exhaustive: complete metrics or known-net support contradict the gate", () => {
  const fixture = createFixture();
  const selectedPath = (path: ProspectiveShadowPathEvidence) =>
    path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE" &&
    path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE";
  const contradictions: readonly ((path: ProspectiveShadowPathEvidence) => ProspectiveShadowPathEvidence)[] = [
    (path) => ({ ...path, incompleteGates: ["INITIAL_STATE"] }),
    (path) => ({
      ...path,
      completedKnownNetEpisodes: 1,
      incompleteGates: ["INITIAL_STATE"],
      metrics: {
        netReturn: unknownMetric("RATIO", "initial state unavailable"),
        maximumRealizedDrawdown: unknownMetric("RATIO", "initial state unavailable"),
        turnover: unknownMetric("KRW", "initial state unavailable"),
        modeledFees: unknownMetric("KRW", "initial state unavailable"),
      },
    }),
  ];

  for (const contradict of contradictions) {
    const evidence = replacePath(fixture.evidence, selectedPath, contradict);
    assert.throws(() => evaluateFinal(fixture, evidence), (error) =>
      error instanceof ProspectiveShadowEvaluationError && error.code === "EVIDENCE_INVALID");
  }

  const coherentGap = replacePath(fixture.evidence, selectedPath, (path) => ({
    ...path,
    completedKnownNetEpisodes: 0,
    incompleteGates: ["INITIAL_STATE"],
    metrics: {
      netReturn: unknownMetric("RATIO", "initial state unavailable"),
      maximumRealizedDrawdown: unknownMetric("RATIO", "initial state unavailable"),
      turnover: unknownMetric("KRW", "initial state unavailable"),
      modeledFees: unknownMetric("KRW", "initial state unavailable"),
    },
  }));
  const evaluated = candidate(
    evaluateFinal(fixture, coherentGap),
    "BTC",
    "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  );
  assert.equal(evaluated.status, "INSUFFICIENT");
  assert.equal(evaluated.reasonCodes.some((code) => code.startsWith("KNOWN_HARM")), false);
});

test("EPISODE_RELATIONSHIPS blocks episode support and dependent return or drawdown evidence", () => {
  const fixture = createFixture();
  const selectedPath = (path: ProspectiveShadowPathEvidence) =>
    path.asset === "ETH" && path.scenario === "COMBINED_MINUS_COOLDOWN_CONTROL" &&
    path.timing === "NEXT_FRAME_MODELED" && path.costId === "STRESS";
  const contradictions: readonly ((path: ProspectiveShadowPathEvidence) => ProspectiveShadowPathEvidence)[] = [
    (path) => ({ ...path, incompleteGates: ["EPISODE_RELATIONSHIPS"] }),
    (path) => ({
      ...path,
      completedKnownNetEpisodes: 1,
      incompleteGates: ["EPISODE_RELATIONSHIPS"],
      metrics: {
        ...path.metrics,
        netReturn: unknownMetric("RATIO", "episode relationships unavailable"),
        maximumRealizedDrawdown: unknownMetric("RATIO", "episode relationships unavailable"),
      },
    }),
  ];

  for (const contradict of contradictions) {
    const evidence = replacePath(fixture.evidence, selectedPath, contradict);
    assert.throws(() => evaluateFinal(fixture, evidence), (error) =>
      error instanceof ProspectiveShadowEvaluationError && error.code === "EVIDENCE_INVALID");
  }

  const coherentGap = replacePath(fixture.evidence, selectedPath, (path) => ({
    ...path,
    completedKnownNetEpisodes: 0,
    incompleteGates: ["EPISODE_RELATIONSHIPS"],
    metrics: {
      ...path.metrics,
      netReturn: unknownMetric("RATIO", "episode relationships unavailable"),
      maximumRealizedDrawdown: unknownMetric("RATIO", "episode relationships unavailable"),
    },
  }));
  const evaluated = candidate(
    evaluateFinal(fixture, coherentGap),
    "ETH",
    "COMBINED_MINUS_COOLDOWN_CONTROL",
  );
  assert.equal(evaluated.status, "INSUFFICIENT");
  assert.equal(evaluated.reasonCodes.some((code) => code.startsWith("KNOWN_HARM")), false);
});

test("replay-frame completeness gates reject same-path complete metrics and episode support", () => {
  const fixture = createFixture();
  const selectedPath = (path: ProspectiveShadowPathEvidence) =>
    path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE" &&
    path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE";

  for (const gate of ["CADENCE", "FEATURE_COVERAGE", "NO_TRADE_COVERAGE"] as const) {
    const evidence = replacePath(fixture.evidence, selectedPath, (path) => ({
      ...path,
      incompleteGates: [gate],
    }));
    assert.throws(() => evaluateFinal(fixture, evidence), (error) =>
      error instanceof ProspectiveShadowEvaluationError && error.code === "EVIDENCE_INVALID", gate);
  }
});

test("replay-frame completeness gates prevent same-path known-harm override", () => {
  const fixture = createFixture();
  const selectedPath = (path: ProspectiveShadowPathEvidence) =>
    path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE" &&
    path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE";

  for (const gate of ["CADENCE", "FEATURE_COVERAGE", "NO_TRADE_COVERAGE"] as const) {
    const evidence = replacePath(fixture.evidence, selectedPath, (path) => ({
      ...path,
      completedKnownNetEpisodes: 0,
      incompleteGates: [gate],
      metrics: {
        netReturn: unknownMetric("RATIO", `${gate} replay frames unavailable`),
        maximumRealizedDrawdown: unknownMetric("RATIO", `${gate} replay frames unavailable`),
        turnover: unknownMetric("KRW", `${gate} replay frames unavailable`),
        modeledFees: unknownMetric("KRW", `${gate} replay frames unavailable`),
      },
    }));
    const evaluated = candidate(
      evaluateFinal(fixture, evidence),
      "BTC",
      "COMBINED_MINUS_EARLY_THESIS_FAILURE",
    );
    assert.equal(evaluated.status, "INSUFFICIENT", gate);
    assert.equal(evaluated.reasonCodes.some((code) => code.startsWith("KNOWN_HARM")), false, gate);
  }
});

test("known harm takes precedence over coherent incompleteness in a different independent cell", () => {
  const fixture = createFixture();
  const harmfulCell = (path: ProspectiveShadowPathEvidence) =>
    path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE" &&
    path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE";
  const incompleteCell = (path: ProspectiveShadowPathEvidence) =>
    path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE" &&
    path.timing === "NEXT_FRAME_MODELED" && path.costId === "STRESS";
  const withHarm = replacePath(fixture.evidence, harmfulCell, (path) => ({
    ...path,
    metrics: { ...path.metrics, netReturn: metric("RATIO", -0.1) },
  }));
  const evidence = replacePath(withHarm, incompleteCell, (path) => ({
    ...path,
    completedKnownNetEpisodes: 0,
    incompleteGates: ["CADENCE"],
    metrics: {
      netReturn: unknownMetric("RATIO", "independent cell cadence unavailable"),
      maximumRealizedDrawdown: unknownMetric("RATIO", "independent cell cadence unavailable"),
      turnover: unknownMetric("KRW", "independent cell cadence unavailable"),
      modeledFees: unknownMetric("KRW", "independent cell cadence unavailable"),
    },
  }));
  const evaluated = candidate(
    evaluateFinal(fixture, evidence),
    "BTC",
    "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  );

  assert.equal(evaluated.status, "REJECTED");
  assert.ok(evaluated.reasonCodes.includes("KNOWN_HARM_NET_RETURN"));
  assert.ok(evaluated.reasonCodes.includes("INCOMPLETE_EVIDENCE"));
  assert.ok(evaluated.reasonCodes.includes("INSUFFICIENT_EPISODE_SUPPORT"));
});

test("BTC, ETH, and both candidates are adjudicated independently without a pooled vote", () => {
  const fixture = createFixture();
  const evidence = replacePath(fixture.evidence, (path) => path.asset === "BTC" && path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE", (path) => ({
    ...path,
    metrics: { ...path.metrics, netReturn: metric("RATIO", -0.1) },
  }));
  const result = evaluateFinal(fixture, evidence);

  assert.equal(candidate(result, "BTC", "COMBINED_MINUS_EARLY_THESIS_FAILURE").status, "REJECTED");
  assert.equal(candidate(result, "BTC", "COMBINED_MINUS_COOLDOWN_CONTROL").status, "SUPPORTS_CONTINUED_SHADOW");
  assert.equal(candidate(result, "ETH", "COMBINED_MINUS_EARLY_THESIS_FAILURE").status, "SUPPORTS_CONTINUED_SHADOW");
  assert.equal("combinedStatus" in result, false);
});

test("invalid, missing, stale, or abandoned closure authority fails REGISTRATION_INVALID", () => {
  const fixture = createFixture();
  const invalidInputs = [
    { ...fixture.initialCommitmentInput, manualVerification: { ...fixture.initialCommitmentInput.manualVerification, confirmation: "WRONG" as typeof PROSPECTIVE_SHADOW_INITIAL_CONFIRMATION } },
    null,
  ];
  for (const initial of invalidInputs) {
    assert.throws(() => evaluateProspectiveComponentShadow({
      registration: fixture.registration,
      initialCommitmentInput: initial ?? fixture.initialCommitmentInput,
      closureCommitmentInput: initial === null ? null : fixture.closureCommitmentInput,
      asOf: fixture.registration.window.to,
      pathEvidence: fixture.evidence,
    }), (error) => error instanceof ProspectiveShadowEvaluationError && error.code === "REGISTRATION_INVALID");
  }

  const staleClosure = structuredClone(fixture.closureCommitmentInput);
  (staleClosure.manualVerification as { noLaterRelevantPathCommit: boolean }).noLaterRelevantPathCommit = false;
  assert.throws(() => evaluateProspectiveComponentShadow({
    registration: fixture.registration,
    initialCommitmentInput: fixture.initialCommitmentInput,
    closureCommitmentInput: staleClosure,
    asOf: fixture.registration.window.to,
    pathEvidence: fixture.evidence,
  }), (error) => error instanceof ProspectiveShadowEvaluationError && error.code === "REGISTRATION_INVALID");

  const abandoned = structuredClone(fixture.closureCommitmentInput);
  (abandoned.metadata as { registryClassification: "ACTIVE_AT_CLOSE" | "ABANDONED" }).registryClassification = "ABANDONED";
  assert.throws(() => evaluateProspectiveComponentShadow({
    registration: fixture.registration,
    initialCommitmentInput: fixture.initialCommitmentInput,
    closureCommitmentInput: abandoned,
    asOf: fixture.registration.window.to,
    pathEvidence: fixture.evidence,
  }), (error) => error instanceof ProspectiveShadowEvaluationError && error.code === "REGISTRATION_INVALID");
});

test("a fully valid ABANDONED closure is revalidated and then rejected as REGISTRATION_INVALID", () => {
  const fixture = createFixture();
  const abandonedClosure = createValidAbandonedClosure(fixture);

  assert.throws(() => evaluateProspectiveComponentShadow({
    registration: fixture.registration,
    initialCommitmentInput: fixture.initialCommitmentInput,
    closureCommitmentInput: abandonedClosure,
    asOf: fixture.registration.window.to,
    pathEvidence: fixture.evidence,
  }), (error) => error instanceof ProspectiveShadowEvaluationError &&
    error.code === "REGISTRATION_INVALID" && /abandoned/i.test(error.message));
});

test("Infinity, negative turnover or fees, and negative episode counts are rejected", () => {
  const fixture = createFixture();
  const corruptions: readonly ((items: ProspectiveShadowPathEvidence[]) => void)[] = [
    (items) => { (items[0]!.metrics.netReturn as { value: number }).value = Number.POSITIVE_INFINITY; },
    (items) => { (items[0]!.metrics.turnover as { value: number }).value = -1; },
    (items) => { (items[0]!.metrics.modeledFees as { value: number }).value = -1; },
    (items) => { (items[0] as { completedKnownNetEpisodes: number }).completedKnownNetEpisodes = -1; },
    (items) => { (items[0] as { openEpisodes: number }).openEpisodes = -1; },
  ];
  for (const corrupt of corruptions) {
    const evidence = structuredClone(fixture.evidence) as ProspectiveShadowPathEvidence[];
    corrupt(evidence);
    assert.throws(() => evaluateFinal(fixture, evidence), (error) =>
      error instanceof ProspectiveShadowEvaluationError && error.code === "EVIDENCE_INVALID");
  }
});

test("finite metric inputs that overflow while computing a delta are rejected", () => {
  const fixture = createFixture();
  const evidence = replacePath(fixture.evidence, (path) =>
    path.asset === "BTC" && path.timing === "SAME_CLOSE_MODELED" && path.costId === "BASE" &&
    (path.scenario === "COMBINED_CONSERVATIVE" || path.scenario === "COMBINED_MINUS_EARLY_THESIS_FAILURE"),
  (path) => ({
    ...path,
    metrics: {
      ...path.metrics,
      netReturn: metric("RATIO", path.scenario === "COMBINED_CONSERVATIVE" ? -Number.MAX_VALUE : Number.MAX_VALUE),
    },
  }));

  assert.throws(() => evaluateFinal(fixture, evidence), (error) =>
    error instanceof ProspectiveShadowEvaluationError && error.code === "EVIDENCE_INVALID");
});

test("metric completeness must agree with value and unknownReason", () => {
  const fixture = createFixture();
  const invalidMetrics = [
    { unit: "KRW", value: null, complete: true, unknownReason: null },
    { unit: "KRW", value: 1, complete: true, unknownReason: "must be null" },
    { unit: "KRW", value: 1, complete: false, unknownReason: "not actually unknown" },
    { unit: "KRW", value: null, complete: false, unknownReason: null },
    { unit: "KRW", value: null, complete: false, unknownReason: "   " },
  ] as const;
  for (const invalidMetric of invalidMetrics) {
    const evidence = structuredClone(fixture.evidence) as ProspectiveShadowPathEvidence[];
    (evidence[0]!.metrics as { turnover: unknown }).turnover = invalidMetric;
    assert.throws(() => evaluateFinal(fixture, evidence), (error) =>
      error instanceof ProspectiveShadowEvaluationError && error.code === "EVIDENCE_INVALID");
  }
});

test("timezone-free asOf is rejected rather than interpreted in local time", () => {
  const fixture = createFixture();
  assert.throws(() => evaluateProspectiveComponentShadow({
    registration: fixture.registration,
    initialCommitmentInput: fixture.initialCommitmentInput,
    closureCommitmentInput: null,
    asOf: "2026-05-02T23:59:59",
    pathEvidence: null,
  }), (error) => error instanceof ProspectiveShadowEvaluationError && error.code === "EVIDENCE_INVALID");
});

test("commitment byte tampering and closure substitution of different initial evidence are rejected", () => {
  const fixture = createFixture();
  const tamperedInitial = structuredClone(fixture.initialCommitmentInput);
  (tamperedInitial.gitEvidence as { workflowAtPublicationBytes: string }).workflowAtPublicationBytes = `${WORKFLOW_BYTES}tampered`;
  assert.throws(() => evaluateProspectiveComponentShadow({
    registration: fixture.registration,
    initialCommitmentInput: tamperedInitial,
    closureCommitmentInput: null,
    asOf: "2026-05-02T23:59:59Z",
    pathEvidence: null,
  }), (error) => error instanceof ProspectiveShadowEvaluationError && error.code === "REGISTRATION_INVALID");

  const tamperedClosure = structuredClone(fixture.closureCommitmentInput);
  (tamperedClosure.gitEvidence as { workflowAtClosureBytes: string }).workflowAtClosureBytes = `${WORKFLOW_BYTES}tampered`;
  assert.throws(() => evaluateProspectiveComponentShadow({
    registration: fixture.registration,
    initialCommitmentInput: fixture.initialCommitmentInput,
    closureCommitmentInput: tamperedClosure,
    asOf: fixture.registration.window.to,
    pathEvidence: fixture.evidence,
  }), (error) => error instanceof ProspectiveShadowEvaluationError && error.code === "REGISTRATION_INVALID");

  const substitutedClosure = structuredClone(fixture.closureCommitmentInput);
  (substitutedClosure.initialCommitmentInput.manualVerification as { verifiedAt: string }).verifiedAt = "2026-01-01T01:02:00Z";
  assert.throws(() => evaluateProspectiveComponentShadow({
    registration: fixture.registration,
    initialCommitmentInput: fixture.initialCommitmentInput,
    closureCommitmentInput: substitutedClosure,
    asOf: fixture.registration.window.to,
    pathEvidence: fixture.evidence,
  }), (error) => error instanceof ProspectiveShadowEvaluationError && error.code === "REGISTRATION_INVALID");
});

test("matrix corruption, non-finite values, negative zero, and invalid non-negative metrics are rejected", () => {
  const fixture = createFixture();
  const corruptions: readonly ((items: ProspectiveShadowPathEvidence[]) => void)[] = [
    (items) => { items.reverse(); },
    (items) => { items.push(structuredClone(items[0]!)); },
    (items) => { (items[0]!.metrics.netReturn as { value: number }).value = Number.NaN; },
    (items) => { (items[0]!.metrics.turnover as { value: number }).value = -0; },
    (items) => { (items[0]!.metrics.maximumRealizedDrawdown as { value: number }).value = -0.01; },
  ];
  for (const corrupt of corruptions) {
    const evidence = structuredClone(fixture.evidence) as ProspectiveShadowPathEvidence[];
    corrupt(evidence);
    assert.throws(() => evaluateFinal(fixture, evidence), (error) =>
      error instanceof ProspectiveShadowEvaluationError && error.code === "EVIDENCE_INVALID");
  }
});

test("result is detached, deeply frozen, and unaffected by caller mutation", () => {
  const fixture = createFixture();
  const mutableEvidence = structuredClone(fixture.evidence) as ProspectiveShadowPathEvidence[];
  const result = evaluateFinal(fixture, mutableEvidence);
  const before = JSON.stringify(result);
  (mutableEvidence[0] as { completedKnownNetEpisodes: number }).completedKnownNetEpisodes = 0;
  (mutableEvidence[0]!.metrics.netReturn as { value: number }).value = -999;

  assert.equal(JSON.stringify(result), before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.outcomes?.assets[0]?.candidates[0]?.cells[0]?.deltas), true);
  assert.throws(() => {
    (result as { phase: string }).phase = "MUTATED";
  }, TypeError);
});
