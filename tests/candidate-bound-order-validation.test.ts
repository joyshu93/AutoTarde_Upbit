import assert from "node:assert/strict";

import type { CandidateExecutionBindingRecord } from "../src/domain/pilot-types.js";
import type { OrderRecord } from "../src/domain/types.js";
import type {
  PersistCandidateBoundOrderIntentInput,
} from "../src/modules/db/interfaces.js";
import {
  candidateExecutionBindingMaterialHash,
} from "../src/modules/db/pilot-interfaces.js";
import {
  validateCandidateBoundOrderIntent,
} from "../src/modules/db/repositories/candidate-bound-order-validation.js";
import { test } from "./harness.js";

test("candidate-bound order validator accepts a complete BTC candidate intent", () => {
  const input = validInput();

  assert.deepEqual(validateCandidateBoundOrderIntent(input), input);
});

test("candidate-bound order validator rejects each authority mismatch family", () => {
  const cases: Array<[string, (input: PersistCandidateBoundOrderIntentInput) => void]> = [
    ["decision status", (input) => { input.decision.status = "DATA_STALE"; }],
    ["decision id", (input) => { input.decision.id = "different-decision"; }],
    ["decision account", (input) => { input.decision.exchangeAccountId = "other"; }],
    ["decision market", (input) => { input.decision.market = "KRW-ETH"; }],
    ["decision strategy", (input) => { input.decision.strategyKey = "other"; }],
    ["decision action", (input) => { input.decision.action = "ADD"; }],
    ["decision notional", (input) => { input.decision.intendedNotionalKrw = "9999"; }],
    ["deployment id", (input) => { input.deployment.id = "other-deployment"; }],
    ["deployment account", (input) => { input.deployment.exchangeAccountId = "other"; }],
    ["deployment phase", (input) => { input.deployment.phase = "DRAINING"; }],
    ["deployment update", (input) => { input.deployment.updatedAt = "2026-08-21T00:00:00.000000002Z"; }],
    ["state reread", (input) => { input.exactStateVersion = 8; }],
  ];

  for (const [label, mutate] of cases) {
    const input = validInput();
    mutate(input);
    assert.throws(() => validateCandidateBoundOrderIntent(input), Error, label);
  }
});

test("candidate-bound order validator rejects immutable order and binding mismatches", () => {
  const cases: Array<[string, (input: PersistCandidateBoundOrderIntentInput) => void]> = [
    ["order id", (input) => { input.order.id = "other-order"; }],
    ["decision id", (input) => { input.order.strategyDecisionId = "other-decision"; }],
    ["account", (input) => { input.order.exchangeAccountId = "other"; }],
    ["market", (input) => { input.order.market = "KRW-ETH"; }],
    ["mode", (input) => { input.order.executionMode = "DRY_RUN"; }],
    ["ord type", (input) => { input.order.ordType = "limit"; }],
    ["side", (input) => { input.order.side = "ask"; }],
    ["price", (input) => { input.order.price = "10001"; }],
    ["volume", (input) => { input.order.volume = "0.1"; }],
    ["time in force", (input) => { input.order.timeInForce = "ioc"; }],
    ["smp", (input) => { input.order.smpType = "reduce"; }],
  ];

  for (const [label, mutate] of cases) {
    const input = validInput();
    mutate(input);
    assert.throws(() => validateCandidateBoundOrderIntent(input), Error, label);
  }
});

test("candidate-bound order validator rejects incorrect action-side relationships", () => {
  const entry = validInput();
  entry.order.side = "ask";
  entry.binding = rehash({ ...entry.binding, side: "ask" });
  assert.throws(() => validateCandidateBoundOrderIntent(entry), /side.*action/i);

  const exit = validInput({ action: "EXIT" });
  exit.order.side = "bid";
  exit.binding = rehash({ ...exit.binding, side: "bid" });
  assert.throws(() => validateCandidateBoundOrderIntent(exit), /side.*action/i);
});

test("candidate-bound order validator rejects noncanonical decimals", () => {
  for (const value of ["01", "1.0", "1e3", "-1", "NaN", "Infinity"]) {
    const input = validInput();
    input.order.price = value;
    input.binding = rehash({ ...input.binding, boundPrice: value });
    input.decision.intendedNotionalKrw = value;
    assert.throws(() => validateCandidateBoundOrderIntent(input), /canonical|decimal/i, value);
  }
});

test("candidate-bound order validator requires the exact one-nanosecond successor across a second rollover", () => {
  const valid = validInput({
    bindingCreatedAt: "2026-08-21T00:00:00.999999999Z",
    requestedAt: "2026-08-21T00:00:01Z",
  });
  assert.doesNotThrow(() => validateCandidateBoundOrderIntent(valid));

  const invalid = validInput({
    bindingCreatedAt: "2026-08-21T00:00:00.999999999Z",
    requestedAt: "2026-08-21T00:00:01.000000001Z",
  });
  assert.throws(() => validateCandidateBoundOrderIntent(invalid), /nanosecond successor/i);
});

test("candidate-bound order validator compares mixed-offset timestamps by epoch nanoseconds", () => {
  const input = validInput({
    bindingCreatedAt: "2026-08-21T09:00:00+09:00",
    requestedAt: "2026-08-21T00:00:00.000000001Z",
  });

  assert.doesNotThrow(() => validateCandidateBoundOrderIntent(input));
});

test("candidate-bound order validator rejects malformed negative and unsafe state versions", () => {
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const expected = validInput();
    expected.expectedStateVersion = value;
    assert.throws(() => validateCandidateBoundOrderIntent(expected), /state version/i, `expected ${value}`);

    const exact = validInput();
    exact.exactStateVersion = value;
    assert.throws(() => validateCandidateBoundOrderIntent(exact), /state version/i, `exact ${value}`);
  }
});

test("candidate-bound order validator rejects extra accessor symbol and non-plain aggregate material", () => {
  const extra = validInput() as PersistCandidateBoundOrderIntentInput & { extra?: string };
  extra.extra = "forbidden";
  assert.throws(() => validateCandidateBoundOrderIntent(extra), /exactly own data properties/i);

  const accessor = validInput();
  Object.defineProperty(accessor, "expectedStateVersion", { enumerable: true, get: () => 7 });
  assert.throws(() => validateCandidateBoundOrderIntent(accessor), /exactly own data properties/i);

  const symbol = validInput() as PersistCandidateBoundOrderIntentInput & { [key: symbol]: string };
  symbol[Symbol("forbidden")] = "value";
  assert.throws(() => validateCandidateBoundOrderIntent(symbol), /exactly own data properties/i);

  const nonPlain = Object.assign(Object.create({ inherited: true }), validInput()) as PersistCandidateBoundOrderIntentInput;
  assert.throws(() => validateCandidateBoundOrderIntent(nonPlain), /plain object/i);
});

test("candidate-bound order validator rejects extra accessor and symbol nested records", () => {
  const extraOrder = validInput();
  (extraOrder.order as typeof extraOrder.order & { extra?: string }).extra = "forbidden";
  assert.throws(() => validateCandidateBoundOrderIntent(extraOrder), /candidate-bound order/i);

  const accessorDecision = validInput();
  Object.defineProperty(accessorDecision.decision, "status", { enumerable: true, get: () => "READY" });
  assert.throws(() => validateCandidateBoundOrderIntent(accessorDecision), /strategy decision/i);

  const symbolEvent = validInput();
  (symbolEvent.event as typeof symbolEvent.event & { [key: symbol]: string })[Symbol("x")] = "x";
  assert.throws(() => validateCandidateBoundOrderIntent(symbolEvent), /order event/i);
});

test("candidate-bound order validator requires immutable request timestamps and pristine local order state", () => {
  const timestampCases: Array<[string, (input: PersistCandidateBoundOrderIntentInput) => void]> = [
    ["event", (input) => { input.event.createdAt = "2026-08-21T00:00:00.000000002Z"; }],
    ["created", (input) => { input.order.createdAt = "2026-08-21T00:00:00.000000002Z"; }],
    ["updated", (input) => { input.order.updatedAt = "2026-08-21T00:00:00.000000002Z"; }],
    ["uuid", (input) => { input.order.upbitUuid = "exchange-id"; }],
    ["response", (input) => { input.order.exchangeResponseJson = "{}"; }],
    ["failure", (input) => { input.order.failureCode = "FAILED"; }],
  ];
  for (const [label, mutate] of timestampCases) {
    const input = validInput();
    mutate(input);
    assert.throws(() => validateCandidateBoundOrderIntent(input), Error, label);
  }
});

interface FixtureOptions {
  action?: "ENTER" | "EXIT";
  bindingCreatedAt?: string;
  requestedAt?: string;
}

function validInput(options: FixtureOptions = {}): PersistCandidateBoundOrderIntentInput {
  const action = options.action ?? "ENTER";
  const bindingCreatedAt = options.bindingCreatedAt ?? "2026-08-21T00:00:00Z";
  const requestedAt = options.requestedAt ?? "2026-08-21T00:00:00.000000001Z";
  const side: OrderRecord["side"] = action === "ENTER" ? "bid" : "ask";
  const intendedNotionalKrw = action === "ENTER" ? "10000" : null;
  const intendedQuantity = action === "EXIT" ? "0.0001" : null;
  const price = action === "ENTER" ? "10000" : null;
  const volume = action === "EXIT" ? "0.0001" : null;
  const ordType: OrderRecord["ordType"] = action === "ENTER" ? "price" : "market";
  const activationAt = "2026-08-20T23:59:59Z";
  const order: OrderRecord = {
    id: "order-1",
    strategyDecisionId: "decision-1",
    exchangeAccountId: "primary",
    market: "KRW-BTC" as const,
    side,
    ordType,
    volume,
    price,
    timeInForce: null,
    smpType: null,
    identifier: "candidate-order-1",
    idempotencyKey: "candidate-idempotency-1",
    origin: "STRATEGY" as const,
    requestedAt,
    upbitUuid: null,
    status: "PERSISTED" as const,
    executionMode: "LIVE" as const,
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
  };
  const binding = rehash({
    id: "binding-1",
    deploymentId: "deployment-1",
    strategyDecisionId: "decision-1",
    orderId: "order-1",
    exchangeAccountId: "primary",
    activationAt,
    activationEpochNs: BigInt(Date.parse(activationAt)) * 1_000_000n,
    market: "KRW-BTC",
    strategyKey: "position_guard.paper_core.v1",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    executionMode: "LIVE",
    ordType,
    action,
    side,
    intendedQuantity,
    intendedNotionalKrw,
    boundPrice: price,
    boundVolume: volume,
    boundTimeInForce: null,
    boundSmpType: null,
    materialVersion: "BINDING_V2",
    orderMaterialHash: "",
    createdAt: bindingCreatedAt,
  });
  return {
    order,
    event: {
      id: "event-1",
      orderId: order.id,
      eventType: "ORDER_PERSISTED",
      eventSource: "LOCAL",
      payloadJson: JSON.stringify({ decisionAction: action }),
      createdAt: requestedAt,
    },
    binding,
    decision: {
      id: "decision-1",
      exchangeAccountId: "primary",
      strategyKey: "position_guard.paper_core.v1",
      market: "KRW-BTC",
      action,
      status: "READY",
      decisionBasisJson: "{}",
      intendedNotionalKrw,
      intendedQuantity,
      referencePrice: "100000000",
      createdAt: "2026-08-20T23:59:59.500Z",
    },
    deployment: {
      id: "deployment-1",
      exchangeAccountId: "primary",
      pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
      market: "KRW-BTC",
      policyId: "COMBINED_CONSERVATIVE",
      policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
      phase: "ACTIVE",
      activationAt,
      activationEpochNs: binding.activationEpochNs,
      createdAt: "2026-08-20T23:00:00Z",
      updatedAt: "2026-08-20T23:59:59.500Z",
    },
    exactStateVersion: 7,
    expectedPhase: "ACTIVE",
    expectedDeploymentUpdatedAt: "2026-08-20T23:59:59.500Z",
    expectedStateVersion: 7,
  };
}

function rehash(
  binding: Omit<CandidateExecutionBindingRecord, "orderMaterialHash"> & { orderMaterialHash?: string },
): CandidateExecutionBindingRecord {
  const material = { ...binding, orderMaterialHash: "" } as CandidateExecutionBindingRecord;
  return { ...material, orderMaterialHash: candidateExecutionBindingMaterialHash(material) };
}
