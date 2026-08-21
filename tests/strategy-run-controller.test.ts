import assert from "node:assert/strict";

import { InlineTelegramStrategyRunController } from "../src/app/strategy-run-controller.js";
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
