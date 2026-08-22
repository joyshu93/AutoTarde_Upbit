import assert from "node:assert/strict";

import {
  InlineTelegramStrategyRunController,
  type CandidateBtcRunPreparation,
} from "../src/app/strategy-run-controller.js";
import type { PositionGuardPilotRefreshReceipt } from "../src/domain/pilot-types.js";
import type {
  PositionGuardPreviewResult,
  PositionGuardRunResult,
} from "../src/modules/strategy/position-guard-runner.js";
import { test } from "./harness.js";

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
  const second = await controller.requestRun(runRequest("KRW-BTC", "SCHEDULER"));
  releasePreparation();
  const completed = await first;

  assert.equal(second.status, "ALREADY_RUNNING");
  assert.equal(completed.status, "COMPLETED");
  assert.equal(runCalls, 1);
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
  return {
    exchangeAccountId: "primary",
    requestedAt: REQUESTED_AT,
    balanceSnapshotId: "balance-1",
    balanceCapturedAt: REQUESTED_AT,
    positionSnapshotId: "position-1",
    positionCapturedAt: REQUESTED_AT,
    reconciliationRunId: "reconciliation-1",
    reconciliationStartedAt: REQUESTED_AT,
    reconciliationCompletedAt: REQUESTED_AT,
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
