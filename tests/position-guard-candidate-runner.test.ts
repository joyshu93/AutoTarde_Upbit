import assert from "node:assert/strict";

import type {
  PositionGuardPilotDeploymentRecord,
  PositionGuardPolicySelection,
} from "../src/domain/pilot-types.js";
import type { StrategyDecisionRecord } from "../src/domain/types.js";
import type { RuntimeOwnershipAuthority } from "../src/app/runtime-ownership-guard.js";
import type { SubmitOrderFromDecisionInput } from "../src/modules/execution/interfaces.js";
import {
  toStrategyDecision,
  type PositionGuardEngineDecision,
  type PositionGuardStrategyContext,
} from "../src/modules/strategy/position-guard-core.js";
import {
  createDefaultPositionGuardRunnerConfig,
  createStrategyDecisionRecord,
  PositionGuardStrategyRunner,
} from "../src/modules/strategy/position-guard-runner.js";
import { test } from "./harness.js";

const GENERATED_AT = "2026-08-22T00:00:00.000Z";

test("candidate runner builds the baseline decision before verification", async () => {
  const trace: string[] = [];
  const harness = createHarness({
    buildDecision: () => {
      trace.push("baseline");
      return decisionBundle(engineDecision("ENTER", { targetNotionalKrw: 123_456 }));
    },
    verify: () => {
      trace.push("verify");
      return readyVerification();
    },
    route: (input) => {
      trace.push("route");
      return activeRoute(input.baselineDecision);
    },
  });

  await harness.runner.runOnce(candidateRunInput());

  assert.deepEqual(trace, ["baseline", "verify", "route"]);
});

test("candidate runner routes a verified BTC decision exactly once", async () => {
  let routeCalls = 0;
  const harness = createHarness({
    route: (input) => {
      routeCalls += 1;
      assert.equal(input.market, "KRW-BTC");
      assert.equal(input.candidateState?.currentEpisodeInventoryQuantity, 0.01);
      return activeRoute(input.baselineDecision);
    },
  });

  await harness.runner.runOnce(candidateRunInput());

  assert.equal(routeCalls, 1);
});

test("default runner router covers ACTIVE, DRAINING, DISABLED, and ETH baseline routes", async () => {
  const active = createHarness({
    buildDecision: () => decisionBundle(engineDecision("ENTER", { targetNotionalKrw: 123_456 })),
  });
  const activeResult = await active.runner.runOnce(candidateRunInput());
  assert.deepEqual(
    [activeResult.strategyDecision.action, readPolicyRoute(activeResult.strategyDecisionRecord).reasonCode],
    ["ENTER", "CANDIDATE_ALLOWED"],
  );
  assert.ok(active.submitted[0]?.candidateAuthority);

  for (const [action, expectedAction, expectedReason] of [
    ["ENTER", "HOLD", "DRAINING_NEW_RISK_SUPPRESSED"],
    ["ADD", "HOLD", "DRAINING_NEW_RISK_SUPPRESSED"],
    ["HOLD", "HOLD", "DRAINING_BASELINE_HOLD_PRESERVED"],
    ["REDUCE", "REDUCE", "DRAINING_RISK_REDUCTION_PRESERVED"],
    ["EXIT", "EXIT", "DRAINING_RISK_REDUCTION_PRESERVED"],
  ] as const) {
    const draining = createHarness({
      buildDecision: () => decisionBundle(
        engineDecision(action, action === "ADD" ? { targetNotionalKrw: 123_456 } : {
          targetQuantityFraction: action === "REDUCE" ? 0.5 : action === "EXIT" ? 1 : null,
        }),
        action === "ADD" ? flatContext() : openContext(),
      ),
      verify: () => readyVerification("DRAINING"),
    });
    const drainingResult = await draining.runner.runOnce(candidateRunInput());
    assert.deepEqual(
      [drainingResult.strategyDecision.action, readPolicyRoute(drainingResult.strategyDecisionRecord).reasonCode],
      [expectedAction, expectedReason],
    );
    if (action === "REDUCE" || action === "EXIT") {
      assert.deepEqual(draining.submitted[0]?.candidateAuthority, {
        kind: "POSITION_GUARD_BTC_CANDIDATE",
        deploymentId: "deployment-1",
        exchangeAccountId: "primary",
        pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
        market: "KRW-BTC",
        strategyKey: "position_guard.paper_core.v1",
        policyId: "COMBINED_CONSERVATIVE",
        policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
        activationAt: "2026-08-21T23:00:00.000Z",
        activationEpochNs: 1_787_353_200_000_000_000n,
        expectedDeploymentUpdatedAt: "2026-08-21T23:00:00.000Z",
        expectedStateVersion: 4,
        expectedPhase: "DRAINING",
        routeReason: "DRAINING_RISK_REDUCTION_PRESERVED",
      });
    } else {
      assert.equal(draining.submitted[0]?.candidateAuthority, undefined);
    }
  }

  const disabled = createHarness({
    buildDecision: () => decisionBundle(engineDecision("ENTER", { targetNotionalKrw: 123_456 })),
    verify: () => readyVerification("DISABLED"),
  });
  const disabledResult = await disabled.runner.runOnce(candidateRunInput());
  assert.deepEqual(
    [disabledResult.strategyDecision.action, readPolicyRoute(disabledResult.strategyDecisionRecord).reasonCode],
    ["ENTER", "PILOT_DISABLED"],
  );
  assert.equal(disabled.submitted[0]?.candidateAuthority, undefined);

  const preActivationDisabled = createHarness({
    buildDecision: () => decisionBundle(engineDecision("ENTER", { targetNotionalKrw: 123_456 })),
    verify: () => readyVerification("DISABLED", "NONE"),
  });
  const preActivationDisabledResult = await preActivationDisabled.runner.runOnce(candidateRunInput());
  assert.deepEqual(
    [
      preActivationDisabledResult.strategyDecision.action,
      readPolicyRoute(preActivationDisabledResult.strategyDecisionRecord).reasonCode,
    ],
    ["ENTER", "PILOT_DISABLED"],
  );
  assert.equal(preActivationDisabled.submitted[0]?.candidateAuthority, undefined);

  const eth = createHarness({
    market: "KRW-ETH",
    buildDecision: () => decisionBundle(engineDecision("ADD", { targetNotionalKrw: 123_456 }), ethContext()),
  });
  const ethResult = await eth.runner.runOnce({ market: "KRW-ETH", generatedAt: GENERATED_AT });
  assert.deepEqual(
    [ethResult.strategyDecision.action, readPolicyRoute(ethResult.strategyDecisionRecord).reasonCode],
    ["ADD", "ETH_BASELINE"],
  );
  assert.equal(eth.submitted[0]?.candidateAuthority, undefined);
});

test("blocked candidate verification stops before routing persistence and execution", async () => {
  let routeCalls = 0;
  const harness = createHarness({
    verify: () => ({
      status: "BLOCKED_FAULT",
      reasonCode: "REPLAY_MISMATCH",
      faultId: "fault-1",
      executableAuthority: false,
    }),
    route: () => {
      routeCalls += 1;
      throw new Error("router must not be called");
    },
  });

  await assert.rejects(
    () => harness.runner.runOnce(candidateRunInput()),
    (error: unknown) => {
      assert.equal((error as { name?: string }).name, "PositionGuardCandidateRunBlockedError");
      assert.equal((error as { reasonCode?: string }).reasonCode, "REPLAY_MISMATCH");
      assert.equal((error as { faultId?: string }).faultId, "fault-1");
      return true;
    },
  );
  assert.equal(routeCalls, 0);
  assert.equal(harness.saved.length, 0);
  assert.equal(harness.submitted.length, 0);
});

test("candidate allow preserves baseline entry and add sizing exactly", async () => {
  for (const action of ["ENTER", "ADD"] as const) {
    const baseline = engineDecision(action, { targetNotionalKrw: 123_456.789012 });
    const harness = createHarness({
      buildDecision: () => decisionBundle(baseline),
      route: () => activeRoute(baseline),
    });

    const result = await harness.runner.runOnce(candidateRunInput());

    assert.equal(result.engineDecision.targetNotionalKrw, baseline.targetNotionalKrw);
    assert.equal(result.strategyDecision.requestedNotionalKrw, 123_456.789012);
    assert.equal(harness.submitted[0]?.decision.requestedNotionalKrw, 123_456.789012);
    assert.equal(harness.saved[0]?.intendedNotionalKrw, "123456.789012");
    assert.equal(harness.submitted[0]?.price, harness.saved[0]?.intendedNotionalKrw);
  }
});

test("candidate suppression persists HOLD with complete baseline and candidate audit", async () => {
  const baseline = engineDecision("ADD", { targetNotionalKrw: 250_000 });
  const suppressed = engineDecision("HOLD", {
    summary: "Candidate suppression.",
    reasons: ["STRICT_PULLBACK_REQUIRED"],
  });
  const candidateEvaluation = Object.freeze({
    policyId: "COMBINED_CONSERVATIVE",
    outcome: "SUPPRESS",
    reasonCodes: Object.freeze(["STRICT_PULLBACK_REQUIRED"]),
    effectiveDecision: suppressed,
  });
  const harness = createHarness({
    buildDecision: () => decisionBundle(baseline),
    route: () => routeResult({
      baseline,
      effective: suppressed,
      executionDecision: suppressed,
      reasonCode: "CANDIDATE_SUPPRESSED",
      candidateEvaluation,
    }),
  });

  const result = await harness.runner.runOnce(candidateRunInput());
  const audit = readPolicyRoute(harness.saved[0]!);

  assert.equal(result.strategyDecision.action, "HOLD");
  assert.equal(result.strategyDecisionRecord.action, "HOLD");
  assert.equal(result.strategyDecisionRecord.status, "NO_ACTION");
  assert.equal(harness.submitted.length, 0);
  assert.equal(audit.baselineDecision.action, "ADD");
  assert.equal(audit.candidateEvaluation.outcome, "SUPPRESS");
  assert.equal(audit.effectiveDecision.action, "HOLD");
  assert.equal(audit.reasonCode, "CANDIDATE_SUPPRESSED");
});

test("candidate early-thesis override persists and executes EXIT instead of baseline action", async () => {
  const baseline = engineDecision("ADD", { targetNotionalKrw: 200_000 });
  const exit = engineDecision("EXIT", {
    targetNotionalKrw: 0,
    targetQuantityFraction: 1,
    reasons: ["EARLY_THESIS_FAILURE"],
  });
  const harness = createHarness({
    buildDecision: () => decisionBundle(baseline, openContext()),
    route: () => routeResult({
      baseline,
      effective: exit,
      executionDecision: exit,
      reasonCode: "CANDIDATE_EARLY_THESIS_FAILURE",
      candidateEvaluation: { outcome: "OVERRIDE_EXIT", effectiveDecision: exit },
    }),
  });

  const result = await harness.runner.runOnce(candidateRunInput());

  assert.equal(result.strategyDecision.action, "EXIT");
  assert.equal(result.strategyDecisionRecord.action, "EXIT");
  assert.equal(harness.submitted.length, 1);
  assert.equal(harness.submitted[0]?.decision.action, "EXIT");
  assert.equal(harness.submitted[0]?.side, "ask");
});

test("candidate runner creates execution input only from route.executionDecision", async () => {
  const baseline = engineDecision("ENTER", { targetNotionalKrw: 150_000 });
  const effective = engineDecision("ENTER", { targetNotionalKrw: 150_000 });
  const executionDecision = engineDecision("HOLD");
  const harness = createHarness({
    buildDecision: () => decisionBundle(baseline),
    route: () => routeResult({
      baseline,
      effective,
      executionDecision,
      reasonCode: "CANDIDATE_ALLOWED",
      candidateEvaluation: { outcome: "ALLOW", effectiveDecision: effective },
    }),
  });

  const result = await harness.runner.runOnce(candidateRunInput());

  assert.equal(result.strategyDecision.action, "ENTER");
  assert.equal(harness.submitted.length, 0);
});

test("effective decision columns agree with the complete detached policy-route audit", async () => {
  const baseline = engineDecision("ADD", { targetNotionalKrw: 200_000 });
  const exit = engineDecision("EXIT", { targetQuantityFraction: 1 });
  const verification = readyVerification();
  if (verification.activation === null) throw new Error("expected ACTIVE verification fixture");
  const harness = createHarness({
    buildDecision: () => decisionBundle(baseline, openContext()),
    verify: () => verification,
    route: () => routeResult({
      baseline,
      effective: exit,
      executionDecision: exit,
      reasonCode: "CANDIDATE_EARLY_THESIS_FAILURE",
      candidateEvaluation: { outcome: "OVERRIDE_EXIT", effectiveDecision: exit },
    }),
  });

  const result = await harness.runner.runOnce(candidateRunInput());
  const audit = readPolicyRoute(result.strategyDecisionRecord);

  assert.equal(result.strategyDecisionRecord.action, audit.effectiveStrategyDecision.action);
  assert.equal(result.strategyDecisionRecord.status, "READY");
  assert.equal(result.strategyDecisionRecord.intendedNotionalKrw, null);
  assert.equal(result.strategyDecisionRecord.intendedQuantity, String(audit.effectiveStrategyDecision.requestedQuantity));
  assert.equal(audit.schemaVersion, "POSITION_GUARD_POLICY_ROUTE_AUDIT_V1");
  assert.deepEqual(audit.configuredSelection, candidateSelection());
  assert.equal(audit.resolvedSelection, "BTC_COMBINED_CONSERVATIVE_PILOT_V1");
  assert.equal(audit.deploymentId, verification.deployment.id);
  assert.equal(audit.pilotId, verification.deployment.pilotId);
  assert.equal(audit.policyId, verification.deployment.policyId);
  assert.equal(audit.policyVersion, verification.deployment.policyVersion);
  assert.equal(audit.phase, "ACTIVE");
  assert.equal(audit.activationAt, verification.activation.activationAt);
  assert.equal(audit.stateVersion, verification.stateVersion);
  assert.equal(audit.reasonCode, "CANDIDATE_EARLY_THESIS_FAILURE");
  assert.deepEqual(audit.refreshProvenance, refreshReceipt());
  assert.notEqual(audit.baselineDecision, baseline);
  assert.notEqual(audit.refreshProvenance, verification.refreshProvenance);
});

test("only eligible ACTIVE executable routes receive exact non-order candidate authority", async () => {
  for (const routeCase of [
    { reason: "CANDIDATE_ALLOWED", action: "ENTER" },
    { reason: "CANDIDATE_EARLY_THESIS_FAILURE", action: "EXIT" },
  ] as const) {
    const context = routeCase.action === "EXIT" ? openContext() : flatContext();
    const decision = engineDecision(routeCase.action, routeCase.action === "ENTER"
      ? { targetNotionalKrw: 100_000 }
      : { targetQuantityFraction: 1 });
    const harness = createHarness({
      buildDecision: () => decisionBundle(decision, context),
      route: () => routeResult({
        baseline: decision,
        effective: decision,
        executionDecision: decision,
        reasonCode: routeCase.reason,
        candidateEvaluation: { outcome: "ALLOW", effectiveDecision: decision },
      }),
    });

    await harness.runner.runOnce(candidateRunInput());

    const authority = harness.submitted[0]?.candidateAuthority;
    assert.ok(authority);
    assert.deepEqual(authority, {
      kind: "POSITION_GUARD_BTC_CANDIDATE",
      deploymentId: "deployment-1",
      exchangeAccountId: "primary",
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      strategyKey: "position_guard.paper_core.v1",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      activationAt: "2026-08-21T23:00:00.000Z",
      activationEpochNs: 1_787_353_200_000_000_000n,
      expectedDeploymentUpdatedAt: "2026-08-21T23:00:00.000Z",
      expectedStateVersion: 4,
      expectedPhase: "ACTIVE",
      routeReason: routeCase.reason,
    });
    for (const forbidden of [
      "orderId", "bindingId", "identifier", "action", "side", "ordType", "price",
      "volume", "timeInForce", "smpType", "executionMode", "materialVersion",
      "orderMaterialHash", "attemptStartedAt", "createdAt",
    ]) {
      assert.equal(Object.hasOwn(authority, forbidden), false, forbidden);
    }
  }
});

test("candidate authority is detached from verifier mutation during decision persistence", async () => {
  const verification = structuredClone(readyVerification());
  const harness = createHarness({
    verify: () => verification,
    duringSave: () => {
      (verification.deployment as { id: string }).id = "mutated-after-validation";
      (verification.activation as { activationAt: string }).activationAt = "2026-08-22T00:00:00.000Z";
      (verification.refreshProvenance as { reconciliationRunId: string }).reconciliationRunId =
        "mutated-reconciliation";
    },
  });

  const result = await harness.runner.runOnce(candidateRunInput());
  const audit = readPolicyRoute(result.strategyDecisionRecord);
  const authority = harness.submitted[0]?.candidateAuthority;

  assert.equal(verification.deployment.id, "mutated-after-validation");
  assert.equal(audit.deploymentId, "deployment-1");
  assert.equal(audit.activationAt, "2026-08-21T23:00:00.000Z");
  assert.equal(audit.refreshProvenance?.reconciliationRunId, "reconciliation-1");
  assert.ok(authority);
  assert.equal(authority.deploymentId, audit.deploymentId);
  assert.equal(authority.activationAt, audit.activationAt);
  assert.equal(authority.deploymentId, "deployment-1");
});

test("PENDING_FLAT suppresses new risk and preserves risk reduction without authority", async () => {
  const cases = [
    { baseline: engineDecision("ENTER", { targetNotionalKrw: 100_000 }), effective: engineDecision("HOLD") },
    { baseline: engineDecision("ADD", { targetNotionalKrw: 100_000 }), effective: engineDecision("HOLD") },
    { baseline: engineDecision("REDUCE", { targetQuantityFraction: 0.5 }), effective: engineDecision("REDUCE", { targetQuantityFraction: 0.5 }) },
    { baseline: engineDecision("EXIT", { targetQuantityFraction: 1 }), effective: engineDecision("EXIT", { targetQuantityFraction: 1 }) },
  ] as const;

  for (const item of cases) {
    const context = item.baseline.action === "ENTER" ? flatContext() : openContext();
    const harness = createHarness({
      buildDecision: () => decisionBundle(item.baseline, context),
      verify: () => pendingFlatVerification(),
      route: () => routeResult({
        baseline: item.baseline,
        effective: item.effective,
        executionDecision: item.effective,
        reasonCode: item.baseline.action === "ENTER" || item.baseline.action === "ADD"
          ? "PENDING_FLAT_NEW_RISK_SUPPRESSED"
          : "PENDING_FLAT_RISK_REDUCTION_PRESERVED",
        phase: "PENDING_FLAT",
        candidateEvaluation: null,
      }),
    });

    const result = await harness.runner.runOnce(candidateRunInput());

    assert.equal(result.strategyDecision.action, item.effective.action);
    if (harness.submitted[0]) assert.equal(harness.submitted[0].candidateAuthority, undefined);
  }
});

test("ETH under candidate selection never verifies candidate state and records ETH baseline audit", async () => {
  let verifierCalls = 0;
  let routerCalls = 0;
  const baseline = engineDecision("HOLD");
  const harness = createHarness({
    market: "KRW-ETH",
    buildDecision: () => decisionBundle(baseline, ethContext()),
    verify: () => {
      verifierCalls += 1;
      throw new Error("ETH must not verify candidate state");
    },
    route: () => {
      routerCalls += 1;
      return routeResult({
        baseline,
        effective: baseline,
        executionDecision: baseline,
        reasonCode: "ETH_BASELINE",
        phase: "DISABLED",
        selection: "BASELINE",
        candidateEvaluation: null,
        stateVersion: null,
      });
    },
  });

  const result = await harness.runner.runOnce({ market: "KRW-ETH", generatedAt: GENERATED_AT });
  const audit = readPolicyRoute(result.strategyDecisionRecord);

  assert.equal(verifierCalls, 0);
  assert.equal(routerCalls, 1);
  assert.equal(result.strategyDecision.action, "HOLD");
  assert.equal(audit.reasonCode, "ETH_BASELINE");
  assert.equal(audit.refreshProvenance, null);
  assert.equal(audit.deploymentId, null);
});

test("default baseline run and preview remain byte-equivalent and never verify candidate authority", async () => {
  let verifierCalls = 0;
  let routerCalls = 0;
  const bundle = decisionBundle(engineDecision("HOLD"));
  const harness = createHarness({
    selection: baselineSelection(),
    buildDecision: () => bundle,
    verify: () => {
      verifierCalls += 1;
      throw new Error("baseline must not verify candidate state");
    },
    route: () => {
      routerCalls += 1;
      throw new Error("default baseline must preserve the original byte path");
    },
  });

  const result = await harness.runner.runOnce({ market: "KRW-BTC", generatedAt: GENERATED_AT });
  const preview = await harness.runner.previewOnce({ market: "KRW-BTC", generatedAt: GENERATED_AT });
  const expected = createStrategyDecisionRecord({
    exchangeAccountId: "primary",
    generatedAt: GENERATED_AT,
    strategyDecision: bundle.strategyDecision,
    engineDecision: bundle.engineDecision,
    context: bundle.context,
  });

  assert.equal(verifierCalls, 0);
  assert.equal(routerCalls, 0);
  assert.deepEqual(result.strategyDecisionRecord, { ...expected, id: result.strategyDecisionRecord.id });
  assert.deepEqual(preview.strategyDecision, bundle.strategyDecision);
  assert.equal(preview.orderPreview, null);
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.submitted.length, 0);
});

test("exact candidate state conversion is detached frozen finite and matches repository approximation", async () => {
  const pilotInterfaces = await import("../src/modules/db/pilot-interfaces.js") as Record<string, unknown>;
  const convert = pilotInterfaces.toPositionGuardCandidateRoutingState as
    | ((state: Record<string, unknown>) => Record<string, unknown>)
    | undefined;
  assert.equal(typeof convert, "function");
  const exact = exactState();

  const converted = convert!(exact);

  assert.deepEqual(converted, {
    currentEpisodeAddCount: 1,
    currentEpisodeCostBasisKrw: 1_000_000.25,
    currentEpisodeInventoryQuantity: 0.01,
    currentEpisodeRealizedPnlKrw: -25.5,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: "PULLBACK",
    lastEvidenceAt: "2026-08-21T22:00:00.000Z",
    lastEvidenceId: "evidence-4",
    stateVersion: 4,
  });
  assert.equal(Object.isFrozen(converted), true);
  assert.notEqual(converted, exact);
  exact.currentEpisodeInventoryQuantity = "0.02";
  assert.equal(converted.currentEpisodeInventoryQuantity, 0.01);
  assert.throws(() => convert!({ ...exactState(), currentEpisodeCostBasisKrw: "1".repeat(400) }), /finite/i);
});

type RouteInput = Readonly<{
  market: "KRW-BTC" | "KRW-ETH";
  baselineDecision: PositionGuardEngineDecision;
  candidateState: Readonly<Record<string, unknown>> | null;
}>;

type HarnessOptions = Readonly<{
  market?: "KRW-BTC" | "KRW-ETH";
  selection?: PositionGuardPolicySelection;
  buildDecision?: () => ReturnType<typeof decisionBundle>;
  verify?: () => unknown;
  route?: (input: RouteInput) => unknown;
  duringSave?: (record: StrategyDecisionRecord) => void;
}>;

function createHarness(options: HarnessOptions = {}) {
  const saved: StrategyDecisionRecord[] = [];
  const submitted: SubmitOrderFromDecisionInput[] = [];
  const dependencies = {
    repositories: {
      async saveStrategyDecision(record: StrategyDecisionRecord) {
        saved.push(structuredClone(record));
        options.duringSave?.(record);
      },
    },
    executionService: {
      async submitOrderFromDecision(input: SubmitOrderFromDecisionInput) {
        submitted.push(input);
        return { accepted: false, outcome: "REJECTED", order: null, reason: "fixture" } as const;
      },
    },
    marketDataReader: {},
    config: createDefaultPositionGuardRunnerConfig("primary"),
    policySelection: options.selection ?? candidateSelection(),
    candidateRunVerifier: {
      async verifyAndPrepareBtcRun() {
        return options.verify?.() ?? readyVerification();
      },
    },
    runtimeOwnership: createAlwaysOwnedRuntimeOwnershipAuthority(),
    ...(options.route === undefined ? {} : { policyRouter: options.route }),
  };
  const runner = new PositionGuardStrategyRunner(dependencies as never);
  Object.defineProperty(runner, "buildDecision", {
    value: async () => options.buildDecision?.() ?? decisionBundle(
      engineDecision("ENTER", { targetNotionalKrw: 100_000 }),
      options.market === "KRW-ETH" ? ethContext() : flatContext(),
    ),
  });
  return { runner, saved, submitted };
}

function createAlwaysOwnedRuntimeOwnershipAuthority(): RuntimeOwnershipAuthority {
  const record = {
    ownerToken: "owner".padEnd(64, "x"),
    generation: 1,
    executionMode: "DRY_RUN" as const,
    acquiredAtEpochMs: 1,
    heartbeatAtEpochMs: 1,
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  };
  return {
    snapshot: () => ({
      status: "OWNED",
      generation: record.generation,
      executionMode: record.executionMode,
      acquiredAtEpochMs: record.acquiredAtEpochMs,
      heartbeatAtEpochMs: record.heartbeatAtEpochMs,
      expiresAtEpochMs: record.expiresAtEpochMs,
      takeover: false,
      lossReason: null,
    }),
    assertLocallyHeld() {},
    async assertCurrent() {
      return { ...record };
    },
  };
}

function candidateRunInput() {
  return {
    market: "KRW-BTC" as const,
    generatedAt: GENERATED_AT,
    refreshReceipt: refreshReceipt(),
  };
}

function refreshReceipt() {
  return {
    exchangeAccountId: "primary",
    requestedAt: "2026-08-21T23:59:00.000Z",
    balanceSnapshotId: "balance-1",
    balanceCapturedAt: "2026-08-21T23:59:01.000Z",
    positionSnapshotId: "position-1",
    positionCapturedAt: "2026-08-21T23:59:01.000Z",
    reconciliationRunId: "reconciliation-1",
    reconciliationStartedAt: "2026-08-21T23:59:02.000Z",
    reconciliationCompletedAt: "2026-08-21T23:59:03.000Z",
    reconciliationSource: "SCHEDULER_PREFLIGHT" as const,
  };
}

function readyVerification(
  phase: "PENDING_FLAT" | "ACTIVE" | "DRAINING" | "DISABLED" = "ACTIVE",
  activation: "ACTIVE" | "NONE" = phase === "PENDING_FLAT" ? "NONE" : "ACTIVE",
) {
  return Object.freeze({
    status: "READY" as const,
    deployment: deployment(phase, activation),
    phase,
    activation: activation === "NONE" ? null : Object.freeze({
      activationAt: "2026-08-21T23:00:00.000Z",
      activationEpochNs: 1_787_353_200_000_000_000n,
    }),
    state: Object.freeze(exactState()),
    stateVersion: 4,
    refreshProvenance: Object.freeze(refreshReceipt()),
  });
}

function pendingFlatVerification() {
  return Object.freeze({
    status: "READY" as const,
    deployment: deployment("PENDING_FLAT"),
    phase: "PENDING_FLAT" as const,
    activation: null,
    state: Object.freeze(exactState()),
    stateVersion: 4,
    refreshProvenance: Object.freeze(refreshReceipt()),
  });
}

function deployment(
  phase: "ACTIVE" | "PENDING_FLAT" | "DRAINING" | "DISABLED",
  activation: "ACTIVE" | "NONE" = phase === "PENDING_FLAT" ? "NONE" : "ACTIVE",
): PositionGuardPilotDeploymentRecord {
  return Object.freeze({
    id: "deployment-1",
    exchangeAccountId: "primary",
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    phase,
    activationAt: activation === "NONE" ? null : "2026-08-21T23:00:00.000Z",
    activationEpochNs: activation === "NONE" ? null : 1_787_353_200_000_000_000n,
    createdAt: "2026-08-21T20:00:00.000Z",
    updatedAt: phase === "PENDING_FLAT" ? "2026-08-21T22:00:00.000Z" : "2026-08-21T23:00:00.000Z",
  });
}

function exactState() {
  return {
    currentEpisodeAddCount: 1,
    currentEpisodeCostBasisKrw: "1000000.25",
    currentEpisodeInventoryQuantity: "0.01",
    currentEpisodeRealizedPnlKrw: "-25.5",
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: "PULLBACK" as const,
    lastEvidenceAt: "2026-08-21T22:00:00.000Z",
    lastEvidenceId: "evidence-4",
    stateVersion: 4,
  };
}

function candidateSelection(): PositionGuardPolicySelection {
  return Object.freeze({
    kind: "BTC_CANDIDATE_PILOT",
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    liveOperatorConfirmed: true,
  });
}

function baselineSelection(): PositionGuardPolicySelection {
  return Object.freeze({ kind: "BASELINE", pilotId: null });
}

function routeResult(input: {
  baseline: PositionGuardEngineDecision;
  effective: PositionGuardEngineDecision;
  executionDecision: PositionGuardEngineDecision;
  reasonCode: string;
  phase?: "ACTIVE" | "PENDING_FLAT" | "DISABLED";
  selection?: "BASELINE" | "BTC_COMBINED_CONSERVATIVE_PILOT_V1";
  candidateEvaluation: unknown;
  stateVersion?: number | null;
}) {
  return Object.freeze({
    baselineDecision: input.baseline,
    effectiveDecision: input.effective,
    selection: input.selection ?? "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    pilotPhase: input.phase ?? "ACTIVE",
    candidateEvaluation: input.candidateEvaluation,
    reasonCode: input.reasonCode,
    stateVersion: input.stateVersion === undefined ? 4 : input.stateVersion,
    executionBlocked: false as const,
    executionDecision: input.executionDecision,
  });
}

function activeRoute(baseline: PositionGuardEngineDecision) {
  return routeResult({
    baseline,
    effective: baseline,
    executionDecision: baseline,
    reasonCode: "CANDIDATE_ALLOWED",
    candidateEvaluation: { outcome: "ALLOW", effectiveDecision: baseline },
  });
}

function decisionBundle(
  engine: PositionGuardEngineDecision,
  context: PositionGuardStrategyContext = flatContext(),
) {
  return {
    strategyDecision: toStrategyDecision(context, engine),
    engineDecision: engine,
    context,
    referencePriceCapturedAt: GENERATED_AT,
  };
}

function engineDecision(
  action: PositionGuardEngineDecision["action"],
  overrides: Partial<PositionGuardEngineDecision> = {},
): PositionGuardEngineDecision {
  return {
    action,
    summary: `${action} fixture.`,
    reasons: [`${action}_FIXTURE`],
    targetNotionalKrw: action === "ENTER" || action === "ADD" ? 100_000 : 0,
    targetQuantityFraction: action === "REDUCE" ? 0.5 : action === "EXIT" ? 1 : null,
    referencePrice: 100_000_000,
    executionDisposition: "EXECUTED_AFTER_CONFIRMATION",
    signalQuality: {
      score: 8,
      bucket: "HIGH",
      confirmationRequired: false,
      confirmationSatisfied: true,
      reentryPenaltyApplied: false,
    },
    exposureGuardrails: {
      perAssetMaxAllocation: 0.45,
      totalPortfolioMaxExposure: 0.75,
      remainingAssetCapacity: 450_000,
      remainingPortfolioCapacity: 750_000,
    },
    diagnostics: {
      regime: "BULL_TREND",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: 95_000_000,
      entryPath: "PULLBACK",
      trendAlignmentScore: 3,
      recoveryQualityScore: 3,
      breakdownPressureScore: 0,
      weakeningStage: "NONE",
      upperRangeChase: false,
      pullbackZone: true,
      reclaimStructure: false,
      breakoutHoldStructure: false,
    },
    ...overrides,
  };
}

function flatContext(): PositionGuardStrategyContext {
  return contextFor("BTC", "KRW-BTC", 0, 0);
}

function openContext(): PositionGuardStrategyContext {
  return contextFor("BTC", "KRW-BTC", 0.01, 90_000_000);
}

function ethContext(): PositionGuardStrategyContext {
  return contextFor("ETH", "KRW-ETH", 0, 0);
}

function contextFor(
  asset: "BTC" | "ETH",
  market: "KRW-BTC" | "KRW-ETH",
  positionQuantity: number,
  averageEntryPrice: number,
): PositionGuardStrategyContext {
  return {
    asset,
    market,
    generatedAt: GENERATED_AT,
    availableKrw: 1_000_000,
    positionQuantity,
    averageEntryPrice,
    portfolio: {
      totalEquityKrw: 2_000_000,
      assetMarketValueKrw: positionQuantity * 100_000_000,
      totalExposureKrw: positionQuantity * 100_000_000,
    },
    latestDecision: null,
    recentExit: { createdAt: null, hoursSinceExit: null, realizedPnl: null },
    settings: createDefaultPositionGuardRunnerConfig("primary").settings,
    analysis: {
      regime: "BULL_TREND",
      riskLevel: "LOW",
      invalidationState: "CLEAR",
      invalidationLevel: 95_000_000,
      pullbackZone: true,
      reclaimStructure: false,
      breakoutHoldStructure: false,
      upperRangeChase: false,
      currentPrice: 100_000_000,
      entryPath: "PULLBACK",
      trendAlignmentScore: 3,
      recoveryQualityScore: 3,
      breakdownPressureScore: 0,
      weakeningStage: "NONE",
      breakdown1d: false,
      breakdown4h: false,
      failedReclaim: false,
      bearishMomentumExpansion: false,
      volumeRecovery: true,
      macdImproving: true,
      rsiRecovery: true,
      atrShock: false,
      averageEntryPrice,
      pnlPct: averageEntryPrice === 0 ? 0 : (100_000_000 - averageEntryPrice) / averageEntryPrice,
    },
  };
}

function readPolicyRoute(record: StrategyDecisionRecord): Record<string, any> {
  const basis = JSON.parse(record.decisionBasisJson) as { policyRoute?: Record<string, any> };
  assert.ok(basis.policyRoute);
  return basis.policyRoute;
}
