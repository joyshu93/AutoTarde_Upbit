import assert from "node:assert/strict";

import {
  RuntimeOwnershipGuardError,
  type RuntimeOwnershipAuthority,
} from "../src/app/runtime-ownership-guard.js";
import {
  InlineTelegramStrategyRunController as ProductionInlineTelegramStrategyRunController,
  type CandidateBtcRunPreparation,
} from "../src/app/strategy-run-controller.js";
import type { PositionGuardPilotRefreshReceipt } from "../src/domain/pilot-types.js";
import type {
  PositionGuardPreviewResult,
  PositionGuardRunResult,
} from "../src/modules/strategy/position-guard-runner.js";
import { test } from "./harness.js";

class InlineTelegramStrategyRunController extends ProductionInlineTelegramStrategyRunController {
  constructor(dependencies: ConstructorParameters<typeof ProductionInlineTelegramStrategyRunController>[0]) {
    super({
      ...dependencies,
      runtimeOwnership: dependencies.runtimeOwnership ?? createAlwaysOwnedRuntimeOwnershipAuthority(),
    });
  }
}

test("strategy run controller fails closed when runtime authority is omitted", async () => {
  let runnerCalls = 0;
  const controller = new ProductionInlineTelegramStrategyRunController({
    runner: {
      async runOnce(): Promise<never> {
        runnerCalls += 1;
        throw new Error("runner must not run without ownership authority");
      },
      async previewOnce(): Promise<never> {
        throw new Error("preview is not used by requestRun");
      },
    },
  });

  await assert.rejects(
    () => controller.requestRun({
      exchangeAccountId: "primary",
      market: "KRW-BTC",
      requestedBy: "TELEGRAM",
      requestedCommand: "/run",
    }),
    /RUNTIME_OWNERSHIP_NOT_HELD/u,
  );
  assert.equal(runnerCalls, 0);
});

function createLostRuntimeOwnershipAuthority(): RuntimeOwnershipAuthority {
  return {
    snapshot: () => ({
      status: "LOST",
      generation: 1,
      executionMode: "DRY_RUN",
      acquiredAtEpochMs: 1,
      heartbeatAtEpochMs: 1,
      expiresAtEpochMs: 45_001,
      takeover: false,
      lossReason: "TEST_GENERATION_REPLACED",
    }),
    assertLocallyHeld() {
      throw new Error("RUNTIME_OWNERSHIP_LOST: TEST_GENERATION_REPLACED");
    },
    async assertCurrent(): Promise<never> {
      throw new Error("RUNTIME_OWNERSHIP_LOST: TEST_GENERATION_REPLACED");
    },
  };
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

test("strategy run controller rejects before preparation or runner work after ownership loss", async () => {
  let preparationCalls = 0;
  let runnerCalls = 0;
  const controller = new InlineTelegramStrategyRunController({
    runner: {
      async runOnce(): Promise<PositionGuardRunResult> {
        runnerCalls += 1;
        throw new Error("runner must not run after ownership loss");
      },
      async previewOnce(): Promise<PositionGuardPreviewResult> {
        throw new Error("preview is not used by requestRun");
      },
    },
    candidateBtcRunPreparation: {
      async prepare(): Promise<never> {
        preparationCalls += 1;
        throw new Error("preparation must not run after ownership loss");
      },
    },
    runtimeOwnership: createLostRuntimeOwnershipAuthority(),
  });

  await assert.rejects(
    () => controller.requestRun({
      exchangeAccountId: "primary",
      market: "KRW-BTC",
      requestedBy: "TELEGRAM",
      requestedCommand: "/run",
    }),
    /RUNTIME_OWNERSHIP_LOST/u,
  );

  assert.equal(preparationCalls, 0);
  assert.equal(runnerCalls, 0);
});

test("strategy run controller rethrows ownership loss from an active runner", async () => {
  const ownership = createOwnedThenLostRuntimeOwnershipAuthority();
  const controller = new InlineTelegramStrategyRunController({
    runner: {
      async runOnce(): Promise<never> {
        ownership.lose();
        throw ownership.lossError;
      },
      async previewOnce(): Promise<never> {
        throw new Error("preview is not used by requestRun");
      },
    },
    runtimeOwnership: ownership.authority,
  });

  await assert.rejects(
    () => controller.requestRun({
      exchangeAccountId: "primary",
      market: "KRW-ETH",
      requestedBy: "TELEGRAM",
      requestedCommand: "/run",
    }),
    (error) => error === ownership.lossError,
  );
});

function createOwnedThenLostRuntimeOwnershipAuthority(): {
  authority: RuntimeOwnershipAuthority;
  lose(): void;
  lossError: RuntimeOwnershipGuardError;
} {
  let held = true;
  const lossError = new RuntimeOwnershipGuardError(
    "RUNTIME_OWNERSHIP_LOST",
    "RUNTIME_OWNERSHIP_LOST: TEST_GENERATION_REPLACED",
  );
  return {
    lossError,
    lose() {
      held = false;
    },
    authority: {
      snapshot: () => ({
        status: held ? "OWNED" : "LOST",
        generation: 1,
        executionMode: "DRY_RUN",
        acquiredAtEpochMs: 1,
        heartbeatAtEpochMs: 1,
        expiresAtEpochMs: 45_001,
        takeover: false,
        lossReason: held ? null : "TEST_GENERATION_REPLACED",
      }),
      assertLocallyHeld() {
        if (!held) throw lossError;
      },
      async assertCurrent() {
        if (!held) throw lossError;
        return {
          ownerToken: "owner".padEnd(64, "x"),
          generation: 1,
          executionMode: "DRY_RUN",
          acquiredAtEpochMs: 1,
          heartbeatAtEpochMs: 1,
          expiresAtEpochMs: 45_001,
        };
      },
    },
  };
}

test("manual strategy run preflight blocks before runner execution", async () => {
  let runOnceCalled = false;
  const controller = new InlineTelegramStrategyRunController({
    runner: {
      async runOnce(): Promise<PositionGuardRunResult> {
        runOnceCalled = true;
        throw new Error("runOnce should not be called when manual preflight blocks.");
      },
      async previewOnce(): Promise<PositionGuardPreviewResult> {
        throw new Error("previewOnce is not used by requestRun.");
      },
    },
    beforeManualRunPreflight: async () => ({
      checkedAt: "2026-04-20T00:00:00.000Z",
      scope: "LIVE",
      status: "BLOCK",
      detail: "Live manual /run blocked by active_orders.",
      checks: [
        {
          name: "active_orders",
          status: "BLOCK",
          detail: "1 active or reconciliation-required order(s) must be resolved first.",
        },
      ],
    }),
    now: () => "2026-04-20T00:00:00.000Z",
  });

  const result = await controller.requestRun({
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    requestedBy: "TELEGRAM",
    requestedCommand: "/run",
  });

  assert.equal(result.status, "FAILED");
  assert.equal(runOnceCalled, false);
  assert.match(result.detail, /Manual strategy run blocked before decision/);
  assert.match(result.detail, /blocking_checks=active_orders/);
});

test("strategy preview computes order intent without calling the run path", async () => {
  let previewOnceCalled = false;
  const controller = new InlineTelegramStrategyRunController({
    runner: {
      async runOnce(): Promise<PositionGuardRunResult> {
        throw new Error("runOnce should not be called by requestPreview.");
      },
      async previewOnce(input): Promise<PositionGuardPreviewResult> {
        previewOnceCalled = true;
        assert.equal(input.market, "KRW-ETH");
        return {
          strategyDecision: {
            strategyKey: "position_guard.paper_core.v1",
            market: "KRW-ETH",
            action: "ENTER",
            reasonCodes: ["enter"],
            referencePrice: 3_000_000,
            requestedNotionalKrw: 150_000,
            requestedQuantity: null,
            metadata: {},
          },
          engineDecision: {
            executionDisposition: "READY",
          } as unknown as PositionGuardPreviewResult["engineDecision"],
          context: {} as PositionGuardPreviewResult["context"],
          orderPreview: {
            side: "bid",
            ordType: "price",
            price: "150000",
            volume: null,
            requestedNotionalKrw: 150_000,
            requestedQuantity: null,
          },
        };
      },
    },
    now: () => "2026-04-20T00:00:00.000Z",
  });

  const result = await controller.requestPreview({
    exchangeAccountId: "primary",
    market: "KRW-ETH",
    requestedBy: "TELEGRAM",
    requestedCommand: "/preview",
  });

  assert.equal(previewOnceCalled, true);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.market, "KRW-ETH");
  assert.equal(result.action, "ENTER");
  assert.equal(result.executionDisposition, "READY");
  assert.equal(result.orderSide, "bid");
  assert.equal(result.orderType, "price");
  assert.equal(result.orderPrice, "150000");
  assert.match(result.detail, /would require \/run to persist and submit/);
});

test("strategy run propagates reconciliation and lease outcomes without calling them rejections", async () => {
  const controller = new InlineTelegramStrategyRunController({
    runner: {
      async runOnce(): Promise<PositionGuardRunResult> {
        return {
          strategyDecisionRecord: { id: "decision-1" } as PositionGuardRunResult["strategyDecisionRecord"],
          strategyDecision: { action: "ENTER", market: "KRW-BTC" } as PositionGuardRunResult["strategyDecision"],
          engineDecision: {} as PositionGuardRunResult["engineDecision"],
          context: {} as PositionGuardRunResult["context"],
          submission: {
            accepted: false,
            outcome: "RECONCILIATION_REQUIRED",
            order: { id: "order-1", status: "RECONCILIATION_REQUIRED" } as Exclude<NonNullable<PositionGuardRunResult["submission"]>["order"], null>,
            reason: "transport outcome unknown",
          },
        };
      },
      async previewOnce(): Promise<PositionGuardPreviewResult> { throw new Error("unused"); },
    },
    now: () => "2026-04-20T00:00:00.000Z",
  });

  const result = await controller.requestRun({
    exchangeAccountId: "primary", market: "KRW-BTC", requestedBy: "TELEGRAM", requestedCommand: "/run",
  });

  assert.equal(result.status, "FAILED");
  assert.equal(result.submissionOutcome, "RECONCILIATION_REQUIRED");
  assert.doesNotMatch(result.detail, /rejected/i);
});

test("candidate BTC manual run prepares once and passes a canonical frozen receipt to the runner", async () => {
  const trace: string[] = [];
  const original = createRefreshReceipt();
  let manualPreflightCalls = 0;
  let runnerReceipt: PositionGuardPilotRefreshReceipt | undefined;
  const controller = new InlineTelegramStrategyRunController({
    runner: createRunner({
      async runOnce(input) {
        trace.push("runner");
        runnerReceipt = input.refreshReceipt;
        assert.equal(input.generatedAt, REQUESTED_AT);
        return createRunResult();
      },
    }),
    candidateBtcRunPreparation: {
      async prepare(input) {
        trace.push("prepare");
        assert.deepEqual(input, {
          exchangeAccountId: "primary",
          requestedAt: REQUESTED_AT,
          requestedBy: "TELEGRAM",
        });
        return { status: "READY", refreshReceipt: original };
      },
    },
    beforeManualRunPreflight: async () => {
      manualPreflightCalls += 1;
      return null;
    },
    now: () => REQUESTED_AT,
  });

  const result = await controller.requestRun(runRequest("KRW-BTC", "TELEGRAM"));

  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(trace, ["prepare", "runner"]);
  assert.equal(manualPreflightCalls, 0);
  assert.deepEqual(runnerReceipt, createRefreshReceipt());
  assert.notEqual(runnerReceipt, original);
  assert.equal(Object.isFrozen(runnerReceipt), true);
});

test("candidate BTC scheduled run uses the same preparation path and timestamp", async () => {
  const trace: string[] = [];
  const controller = new InlineTelegramStrategyRunController({
    runner: createRunner({
      async runOnce(input) {
        trace.push(`runner:${input.generatedAt}`);
        assert.deepEqual(input.refreshReceipt, createRefreshReceipt());
        return createRunResult();
      },
    }),
    candidateBtcRunPreparation: {
      async prepare(input) {
        trace.push(`prepare:${input.requestedBy}:${input.requestedAt}`);
        return { status: "READY", refreshReceipt: createRefreshReceipt() };
      },
    },
    now: () => REQUESTED_AT,
  });

  const result = await controller.requestRun(runRequest("KRW-BTC", "SCHEDULER"));

  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(trace, [
    `prepare:SCHEDULER:${REQUESTED_AT}`,
    `runner:${REQUESTED_AT}`,
  ]);
});

test("candidate BTC snapshots the READY receipt before runner awaits", async () => {
  const original = createRefreshReceipt() as Mutable<PositionGuardPilotRefreshReceipt>;
  let releaseRunner!: () => void;
  const runnerStarted = new Promise<void>((resolve) => {
    releaseRunner = resolve;
  });
  let observed: PositionGuardPilotRefreshReceipt | undefined;
  const controller = new InlineTelegramStrategyRunController({
    runner: createRunner({
      async runOnce(input) {
        observed = input.refreshReceipt;
        await runnerStarted;
        assert.equal(input.refreshReceipt?.balanceSnapshotId, "balance-1");
        return createRunResult();
      },
    }),
    candidateBtcRunPreparation: readyPreparation(original),
    now: () => REQUESTED_AT,
  });

  const pending = controller.requestRun(runRequest("KRW-BTC", "TELEGRAM"));
  await Promise.resolve();
  original.balanceSnapshotId = "mutated-after-prepare";
  releaseRunner();
  const result = await pending;

  assert.equal(result.status, "COMPLETED");
  assert.equal(observed?.balanceSnapshotId, "balance-1");
  assert.equal(Object.isFrozen(observed), true);
});

test("candidate BTC fails before runner for blocked and thrown preparation", async () => {
  for (const preparation of [
    {
      async prepare() {
        return { status: "BLOCKED", detail: "candidate refresh blocked" } as const;
      },
    },
    {
      async prepare(): Promise<never> {
        throw new Error("refresh unavailable");
      },
    },
  ] satisfies CandidateBtcRunPreparation[]) {
    let runCalls = 0;
    const controller = new InlineTelegramStrategyRunController({
      runner: createRunner({
        async runOnce() {
          runCalls += 1;
          return createRunResult();
        },
      }),
      candidateBtcRunPreparation: preparation,
      now: () => REQUESTED_AT,
    });

    const result = await controller.requestRun(runRequest("KRW-BTC", "TELEGRAM"));
    assert.equal(result.status, "FAILED");
    assert.equal(runCalls, 0);
  }
});

test("candidate BTC rejects malformed or mismatched READY receipts before runner", async () => {
  const malformedReceipts: unknown[] = [
    { ...createRefreshReceipt(), exchangeAccountId: "other" },
    { ...createRefreshReceipt(), requestedAt: "2026-04-20T00:00:01.000Z" },
    { ...createRefreshReceipt(), reconciliationSource: "OPERATOR_SYNC" },
    { ...createRefreshReceipt(), balanceSnapshotId: "" },
    { ...createRefreshReceipt(), balanceCapturedAt: "2026-04-20T00:00:00" },
    { ...createRefreshReceipt(), balanceCapturedAt: "2026-02-30T00:00:00.000Z" },
    Object.assign(Object.create(null), createRefreshReceipt()),
    { ...createRefreshReceipt(), extra: "not-allowed" },
    Object.defineProperty({ ...createRefreshReceipt() }, "balanceSnapshotId", {
      enumerable: true,
      get() {
        throw new Error("accessor must not execute");
      },
    }),
    Object.defineProperty({ ...createRefreshReceipt() }, "hidden", {
      enumerable: false,
      value: "not-allowed",
    }),
    Object.assign({ ...createRefreshReceipt() }, { [Symbol("extra")]: "not-allowed" }),
  ];

  for (const receipt of malformedReceipts) {
    let runCalls = 0;
    const controller = new InlineTelegramStrategyRunController({
      runner: createRunner({
        async runOnce() {
          runCalls += 1;
          return createRunResult();
        },
      }),
      candidateBtcRunPreparation: {
        async prepare() {
          return { status: "READY", refreshReceipt: receipt as PositionGuardPilotRefreshReceipt };
        },
      },
      now: () => REQUESTED_AT,
    });

    const result = await controller.requestRun(runRequest("KRW-BTC", "TELEGRAM"));
    assert.equal(result.status, "FAILED");
    assert.equal(runCalls, 0);
  }
});

test("candidate preparation is isolated from ETH and previews", async () => {
  let preparationCalls = 0;
  let runCalls = 0;
  let previewCalls = 0;
  const controller = new InlineTelegramStrategyRunController({
    runner: createRunner({
      async runOnce(input) {
        runCalls += 1;
        assert.equal(input.refreshReceipt, undefined);
        return createRunResult("KRW-ETH");
      },
      async previewOnce() {
        previewCalls += 1;
        return createPreviewResult();
      },
    }),
    candidateBtcRunPreparation: {
      async prepare() {
        preparationCalls += 1;
        return { status: "READY", refreshReceipt: createRefreshReceipt() };
      },
    },
    now: () => REQUESTED_AT,
  });

  await controller.requestRun(runRequest("KRW-ETH", "TELEGRAM"));
  await controller.requestPreview({
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    requestedBy: "TELEGRAM",
    requestedCommand: "/preview",
  });

  assert.equal(preparationCalls, 0);
  assert.equal(runCalls, 1);
  assert.equal(previewCalls, 1);
});

test("running guard remains held while candidate preparation is pending", async () => {
  let releasePreparation!: () => void;
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  let runCalls = 0;
  const controller = new InlineTelegramStrategyRunController({
    runner: createRunner({
      async runOnce() {
        runCalls += 1;
        return createRunResult();
      },
    }),
    candidateBtcRunPreparation: {
      async prepare() {
        await preparationGate;
        return { status: "READY", refreshReceipt: createRefreshReceipt() };
      },
    },
    now: () => REQUESTED_AT,
  });

  const first = controller.requestRun(runRequest("KRW-BTC", "TELEGRAM"));
  await Promise.resolve();
  const secondRequest = runRequest("KRW-BTC", "SCHEDULER") as Mutable<ReturnType<typeof runRequest>>;
  const secondPending = controller.requestRun(secondRequest);
  secondRequest.exchangeAccountId = "mutated-account";
  secondRequest.market = "KRW-ETH";
  const second = await secondPending;
  releasePreparation();
  const completed = await first;

  assert.equal(second.status, "ALREADY_RUNNING");
  assert.equal(second.market, "KRW-BTC");
  assert.match(second.detail, /primary/);
  assert.equal(completed.status, "COMPLETED");
  assert.equal(runCalls, 1);
});

test("candidate BTC run keeps constructor authority and request values while preparation awaits", async () => {
  const trace: string[] = [];
  let releasePreparation!: () => void;
  let preparationStarted!: () => void;
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const started = new Promise<void>((resolve) => {
    preparationStarted = resolve;
  });
  let preparationCalls = 0;
  const originalPreparation: CandidateBtcRunPreparation = {
    async prepare(input) {
      preparationCalls += 1;
      trace.push(`prepare:${input.exchangeAccountId}:${input.requestedBy}:${input.requestedAt}`);
      if (preparationCalls === 1) {
        preparationStarted();
        await preparationGate;
      }
      return {
        status: "READY",
        refreshReceipt: createRefreshReceiptFor(input.exchangeAccountId, input.requestedAt),
      };
    },
  };
  const dependencies: ConstructorParameters<typeof InlineTelegramStrategyRunController>[0] = {
    runner: createRunner({
      async runOnce(input) {
        trace.push(`runner:${input.market}:${input.generatedAt}`);
        return createRunResult(input.market);
      },
    }),
    candidateBtcRunPreparation: originalPreparation,
    beforeManualRunPreflight: async () => {
      trace.push("manual-preflight:original");
      return null;
    },
    now: () => REQUESTED_AT,
  };
  const controller = new InlineTelegramStrategyRunController(dependencies);
  const request = runRequest("KRW-BTC", "TELEGRAM") as Mutable<ReturnType<typeof runRequest>>;

  const pending = controller.requestRun(request);
  await started;

  dependencies.runner = createRunner({
    async runOnce() {
      trace.push("runner:mutated");
      return createRunResult("KRW-ETH");
    },
  });
  dependencies.candidateBtcRunPreparation = {
    async prepare() {
      trace.push("prepare:mutated");
      return { status: "BLOCKED", detail: "mutated dependency must not be authoritative" };
    },
  };
  dependencies.beforeManualRunPreflight = async () => {
    trace.push("manual-preflight:mutated");
    return null;
  };
  dependencies.now = () => "2026-04-20T00:00:30.000Z";
  request.exchangeAccountId = "mutated-account";
  request.market = "KRW-ETH";
  request.requestedBy = "SCHEDULER";
  request.requestedCommand = "SCHEDULER_TICK";

  releasePreparation();
  const first = await pending;
  const baseline = await controller.requestRun(runRequest("KRW-ETH", "TELEGRAM"));
  const secondCandidate = await controller.requestRun(runRequest("KRW-BTC", "SCHEDULER"));

  assert.equal(first.status, "COMPLETED");
  assert.equal(first.market, "KRW-BTC");
  assert.equal(first.requestedAt, REQUESTED_AT);
  assert.equal(baseline.status, "COMPLETED");
  assert.equal(baseline.requestedAt, REQUESTED_AT);
  assert.equal(secondCandidate.status, "COMPLETED");
  assert.equal(secondCandidate.requestedAt, REQUESTED_AT);
  assert.deepEqual(trace, [
    `prepare:primary:TELEGRAM:${REQUESTED_AT}`,
    `runner:KRW-BTC:${REQUESTED_AT}`,
    "manual-preflight:original",
    `runner:KRW-ETH:${REQUESTED_AT}`,
    `prepare:primary:SCHEDULER:${REQUESTED_AT}`,
    `runner:KRW-BTC:${REQUESTED_AT}`,
  ]);
});

test("strategy preview keeps its entry request snapshot while runner awaits", async () => {
  let releasePreview!: () => void;
  let previewStarted!: () => void;
  const previewGate = new Promise<void>((resolve) => {
    releasePreview = resolve;
  });
  const started = new Promise<void>((resolve) => {
    previewStarted = resolve;
  });
  const controller = new InlineTelegramStrategyRunController({
    runner: createRunner({
      async previewOnce(input) {
        assert.equal(input.market, "KRW-BTC");
        previewStarted();
        await previewGate;
        return createPreviewResult();
      },
    }),
    now: () => REQUESTED_AT,
  });
  const request = {
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    requestedBy: "TELEGRAM",
    requestedCommand: "/preview",
  } as Mutable<Parameters<InlineTelegramStrategyRunController["requestPreview"]>[0]>;

  const pending = controller.requestPreview(request);
  await started;
  request.exchangeAccountId = "mutated-account";
  request.market = "KRW-ETH";
  releasePreview();
  const result = await pending;

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.market, "KRW-BTC");
  assert.equal(result.requestedAt, REQUESTED_AT);
});

const REQUESTED_AT = "2026-04-20T00:00:00.000Z";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function runRequest(market: "KRW-BTC" | "KRW-ETH", requestedBy: "TELEGRAM" | "SCHEDULER") {
  return {
    exchangeAccountId: "primary",
    market,
    requestedBy,
    requestedCommand: requestedBy === "TELEGRAM" ? "/run" as const : "SCHEDULER_TICK" as const,
  };
}

function createRefreshReceipt(): PositionGuardPilotRefreshReceipt {
  return createRefreshReceiptFor("primary", REQUESTED_AT);
}

function createRefreshReceiptFor(
  exchangeAccountId: string,
  requestedAt: string,
): PositionGuardPilotRefreshReceipt {
  return {
    exchangeAccountId,
    requestedAt,
    balanceSnapshotId: "balance-1",
    balanceCapturedAt: requestedAt,
    positionSnapshotId: "position-1",
    positionCapturedAt: requestedAt,
    reconciliationRunId: "reconciliation-1",
    reconciliationStartedAt: requestedAt,
    reconciliationCompletedAt: requestedAt,
    reconciliationSource: "SCHEDULER_PREFLIGHT",
  };
}

function readyPreparation(
  refreshReceipt: PositionGuardPilotRefreshReceipt,
): CandidateBtcRunPreparation {
  return {
    async prepare() {
      return { status: "READY", refreshReceipt };
    },
  };
}

function createRunner(overrides: Partial<Pick<PositionGuardStrategyRunnerLike, "runOnce" | "previewOnce">> = {}) {
  return {
    async runOnce() {
      return createRunResult();
    },
    async previewOnce() {
      return createPreviewResult();
    },
    ...overrides,
  };
}

type PositionGuardStrategyRunnerLike = {
  runOnce: (input: {
    market: "KRW-BTC" | "KRW-ETH";
    generatedAt: string;
    refreshReceipt?: PositionGuardPilotRefreshReceipt;
  }) => Promise<PositionGuardRunResult>;
  previewOnce: (input: { market: "KRW-BTC" | "KRW-ETH"; generatedAt: string }) => Promise<PositionGuardPreviewResult>;
};

function createRunResult(market: "KRW-BTC" | "KRW-ETH" = "KRW-BTC"): PositionGuardRunResult {
  return {
    strategyDecisionRecord: { id: "decision-1" } as PositionGuardRunResult["strategyDecisionRecord"],
    strategyDecision: { action: "HOLD", market } as PositionGuardRunResult["strategyDecision"],
    engineDecision: {} as PositionGuardRunResult["engineDecision"],
    context: {} as PositionGuardRunResult["context"],
    submission: null,
  };
}

function createPreviewResult(): PositionGuardPreviewResult {
  return {
    strategyDecision: {
      action: "HOLD",
      market: "KRW-BTC",
      referencePrice: 1,
      requestedNotionalKrw: null,
      requestedQuantity: null,
    } as PositionGuardPreviewResult["strategyDecision"],
    engineDecision: { executionDisposition: "READY" } as unknown as PositionGuardPreviewResult["engineDecision"],
    context: {} as PositionGuardPreviewResult["context"],
    orderPreview: null,
  };
}
