import assert from "node:assert/strict";

import type { RiskEvaluationContext } from "../src/domain/types.js";
import { evaluateRiskGuards } from "../src/modules/risk/guards.js";
import { test } from "./harness.js";

test("risk guards accept a healthy dry-run order request", () => {
  const result = evaluateRiskGuards(createRiskContext());

  assert.equal(result.accepted, true);
  assert.deepEqual(result.triggeredRules, []);
});

test("risk guards block LIVE execution when the live gate is disabled", () => {
  const result = evaluateRiskGuards(
    createRiskContext({
      policy: {
        executionMode: "LIVE",
        liveExecutionGate: "DISABLED",
        globalKillSwitch: false,
        maxAllocationByAsset: {
          BTC: 0.7,
          ETH: 0.4,
        },
        totalExposureCap: 0.95,
        stalePriceThresholdMs: 30_000,
        minimumOrderValueKrw: 5_000,
      },
    }),
  );

  assert.equal(result.accepted, false);
  assert.deepEqual(
    result.triggeredRules.map((rule) => rule.code),
    ["LIVE_EXECUTION_DISABLED"],
  );
});

test("risk guards block stale or missing market references", () => {
  const result = evaluateRiskGuards(
    createRiskContext({
      priceSnapshot: null,
    }),
  );

  assert.equal(result.accepted, false);
  assert.deepEqual(
    result.triggeredRules.map((rule) => rule.code),
    ["STALE_PRICE_GUARD"],
  );
});

test("risk guards block duplicate active orders that match the same request shape", () => {
  const result = evaluateRiskGuards(
    createRiskContext({
      openOrders: [
        {
          market: "KRW-BTC",
          side: "bid",
          ordType: "limit",
          price: "100000000",
          volume: "0.01000000",
          status: "OPEN",
          identifier: "existing-order",
          idempotencyKey: "previous-intent",
        },
      ],
      requestedPrice: "100000000.0",
      requestedVolume: "0.01",
    }),
  );

  assert.equal(result.accepted, false);
  assert.deepEqual(
    result.triggeredRules.map((rule) => rule.code),
    ["DUPLICATE_ORDER_GUARD"],
  );
});

test("risk guards enforce the minimum order value", () => {
  const result = evaluateRiskGuards(
    createRiskContext({
      requestedNotionalKrw: 4_999,
      requestedQuantity: 0.00005,
      requestedVolume: "0.00005",
    }),
  );

  assert.equal(result.accepted, false);
  assert.deepEqual(
    result.triggeredRules.map((rule) => rule.code),
    ["MINIMUM_ORDER_VALUE_GUARD"],
  );
});

function createRiskContext(
  overrides: Partial<RiskEvaluationContext> = {},
): RiskEvaluationContext {
  return {
    policy: {
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      globalKillSwitch: false,
      maxAllocationByAsset: {
        BTC: 0.7,
        ETH: 0.4,
      },
      totalExposureCap: 0.95,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    systemStatus: "RUNNING",
    market: "KRW-BTC",
    priceSnapshot: {
      market: "KRW-BTC",
      tradePrice: 100_000_000,
      capturedAt: "2026-04-20T00:00:10.000Z",
    },
    portfolio: {
      totalEquityKrw: 10_000_000,
      totalExposureKrw: 1_000_000,
      assetExposureKrw: {
        BTC: 1_000_000,
        ETH: 0,
      },
    },
    openOrders: [],
    requestedSide: "bid",
    requestedIdempotencyKey: "intent-1",
    requestedPrice: "100000000",
    requestedVolume: "0.01000000",
    requestedNotionalKrw: 1_000_000,
    requestedQuantity: 0.01,
    now: "2026-04-20T00:00:20.000Z",
    ...overrides,
  };
}
