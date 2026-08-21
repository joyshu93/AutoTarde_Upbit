import assert from "node:assert/strict";

import type { OrderRecord, StrategyDecisionRecord } from "../src/domain/types.js";
import type { CandidateExecutionAuthority } from "../src/modules/execution/interfaces.js";
import {
  createCandidateExecutionAttemptTimestamps,
  deriveCandidateExecutionBinding,
  formatCanonicalUtcIsoNanoseconds,
  validateCandidateExecutionAuthority,
} from "../src/modules/execution/candidate-execution-authority.js";
import { candidateExecutionBindingMaterialHash } from "../src/modules/db/pilot-interfaces.js";
import { test } from "./harness.js";

test("candidate execution authority validates and detaches exact ACTIVE provenance", () => {
  const input = validAuthority();
  const validated = validateCandidateExecutionAuthority(input);

  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  assert.equal(Object.isFrozen(validated), true);
});

test("candidate execution authority accepts only phase-specific route reasons", () => {
  assert.doesNotThrow(() => validateCandidateExecutionAuthority(validAuthority({
    expectedPhase: "ACTIVE",
    routeReason: "CANDIDATE_EARLY_THESIS_FAILURE",
  })));
  assert.doesNotThrow(() => validateCandidateExecutionAuthority(validAuthority({
    expectedPhase: "DRAINING",
    routeReason: "DRAINING_RISK_REDUCTION_PRESERVED",
  })));

  assert.throws(() => validateCandidateExecutionAuthority({
    ...validAuthority(),
    routeReason: "DRAINING_RISK_REDUCTION_PRESERVED",
  }), /route reason/i);
  assert.throws(() => validateCandidateExecutionAuthority({
    ...validAuthority({ expectedPhase: "DRAINING", routeReason: "DRAINING_RISK_REDUCTION_PRESERVED" }),
    routeReason: "CANDIDATE_ALLOWED",
  }), /route reason/i);
});

test("candidate execution authority rejects extra symbol accessor and non-plain material", () => {
  const extra = { ...validAuthority(), orderId: "forbidden" };
  assert.throws(() => validateCandidateExecutionAuthority(extra), /exactly own data properties/i);

  const symbol = validAuthority() as CandidateExecutionAuthority & { [key: symbol]: string };
  symbol[Symbol("forbidden")] = "value";
  assert.throws(() => validateCandidateExecutionAuthority(symbol), /exactly own data properties/i);

  const accessor = validAuthority();
  Object.defineProperty(accessor, "deploymentId", { enumerable: true, get: () => "deployment-1" });
  assert.throws(() => validateCandidateExecutionAuthority(accessor), /own data properties/i);

  const inherited = Object.assign(Object.create({ orderId: "forbidden" }), validAuthority());
  assert.throws(() => validateCandidateExecutionAuthority(inherited), /plain object/i);
});

test("candidate execution authority rejects frozen identity activation and state mismatches", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["kind", { kind: "OTHER" }],
    ["pilot", { pilotId: "OTHER" }],
    ["market", { market: "KRW-ETH" }],
    ["strategy", { strategyKey: "other" }],
    ["policy", { policyId: "OTHER" }],
    ["policy version", { policyVersion: "OTHER" }],
    ["activation epoch", { activationEpochNs: 1n }],
    ["state negative", { expectedStateVersion: -1 }],
    ["state fractional", { expectedStateVersion: 1.5 }],
    ["state unsafe", { expectedStateVersion: Number.MAX_SAFE_INTEGER + 1 }],
  ];
  for (const [label, change] of cases) {
    assert.throws(
      () => validateCandidateExecutionAuthority({ ...validAuthority(), ...change }),
      Error,
      label,
    );
  }
});

test("candidate execution authority rejects empty identities and invalid deployment chronology", () => {
  assert.throws(
    () => validateCandidateExecutionAuthority({ ...validAuthority(), deploymentId: " " }),
    /deployment/i,
  );
  assert.throws(
    () => validateCandidateExecutionAuthority({
      ...validAuthority(),
      expectedDeploymentUpdatedAt: "2026-08-20T23:59:59.999999999Z",
    }),
    /deployment.*chronology|updatedAt/i,
  );
});

test("binding derivation accepts valid ACTIVE ENTER and EXIT material", () => {
  for (const action of ["ENTER", "EXIT"] as const) {
    const fixture = validDerivation({ action });
    const binding = deriveCandidateExecutionBinding(fixture);

    assert.equal(binding.action, action);
    assert.equal(binding.orderId, fixture.order.id);
    assert.equal(binding.strategyDecisionId, fixture.decision.id);
    assert.equal(binding.orderMaterialHash, candidateExecutionBindingMaterialHash(binding));
    assert.equal(Object.isFrozen(binding), true);
  }
});

test("binding derivation copies execution mode only from the final order", () => {
  const fixture = validDerivation();
  fixture.order.executionMode = "DRY_RUN";

  assert.equal(deriveCandidateExecutionBinding(fixture).executionMode, "DRY_RUN");
});

test("binding derivation accepts DRAINING REDUCE and EXIT but rejects entry", () => {
  for (const action of ["REDUCE", "EXIT"] as const) {
    const fixture = validDerivation({ action, phase: "DRAINING" });
    assert.doesNotThrow(() => deriveCandidateExecutionBinding(fixture));
  }

  assert.throws(
    () => deriveCandidateExecutionBinding(validDerivation({ action: "ENTER", phase: "DRAINING" })),
    /DRAINING|risk reduction/i,
  );
});

test("binding derivation permits early thesis failure authority only for EXIT", () => {
  const exit = validDerivation();
  exit.decision.action = "EXIT";
  exit.decision.intendedNotionalKrw = null;
  exit.decision.intendedQuantity = "0.0001";
  exit.order.side = "ask";
  exit.order.ordType = "market";
  exit.order.price = null;
  exit.order.volume = "0.0001";
  exit.authority = validAuthority({ routeReason: "CANDIDATE_EARLY_THESIS_FAILURE" });
  assert.doesNotThrow(() => deriveCandidateExecutionBinding(exit));

  const enter = validDerivation();
  enter.authority = validAuthority({ routeReason: "CANDIDATE_EARLY_THESIS_FAILURE" });
  assert.throws(() => deriveCandidateExecutionBinding(enter), /early thesis.*EXIT/i);
});

test("binding derivation is reproducible detached and insensitive to later caller mutation", () => {
  const fixture = validDerivation({ action: "ADD" });
  const first = deriveCandidateExecutionBinding(fixture);
  const second = deriveCandidateExecutionBinding(validDerivation({ action: "ADD" }));

  assert.deepEqual(first, second);
  fixture.order.price = "99999";
  fixture.decision.intendedNotionalKrw = "99999";
  assert.equal(first.boundPrice, "10000");
  assert.equal(first.intendedNotionalKrw, "10000");
});

test("binding derivation rejects account market strategy policy phase and activation mismatches", () => {
  const cases: Array<[string, (fixture: DerivationFixture) => void]> = [
    ["order account", (fixture) => { fixture.order.exchangeAccountId = "other"; }],
    ["decision account", (fixture) => { fixture.decision.exchangeAccountId = "other"; }],
    ["market", (fixture) => { fixture.order.market = "KRW-ETH"; }],
    ["strategy", (fixture) => { fixture.decision.strategyKey = "other"; }],
    ["activation", (fixture) => { fixture.createdAt = fixture.authority.activationAt; }],
  ];
  for (const [label, mutate] of cases) {
    const fixture = validDerivation();
    mutate(fixture);
    assert.throws(() => deriveCandidateExecutionBinding(fixture), Error, label);
  }
});

test("binding derivation rejects decision action and immutable order material mismatches", () => {
  const cases: Array<[string, (fixture: DerivationFixture) => void]> = [
    ["decision id", (fixture) => { fixture.order.strategyDecisionId = "other"; }],
    ["decision status", (fixture) => { fixture.decision.status = "DATA_STALE"; }],
    ["action", (fixture) => { fixture.decision.action = "EXIT"; }],
    ["side", (fixture) => { fixture.order.side = "ask"; }],
    ["type", (fixture) => { fixture.order.ordType = "limit"; }],
    ["price", (fixture) => { fixture.order.price = "9999"; }],
    ["not pristine", (fixture) => { fixture.order.upbitUuid = "exchange-id"; }],
  ];
  for (const [label, mutate] of cases) {
    const fixture = validDerivation();
    mutate(fixture);
    assert.throws(() => deriveCandidateExecutionBinding(fixture), Error, label);
  }
});

test("binding derivation rejects future decisions and non-exact request timestamps", () => {
  const futureDecision = validDerivation();
  futureDecision.decision.createdAt = futureDecision.order.requestedAt;
  assert.throws(() => deriveCandidateExecutionBinding(futureDecision), /chronology/i);

  const wrongSuccessor = validDerivation();
  wrongSuccessor.order.requestedAt = "2026-08-21T00:00:00.000000003Z";
  wrongSuccessor.order.createdAt = wrongSuccessor.order.requestedAt;
  wrongSuccessor.order.updatedAt = wrongSuccessor.order.requestedAt;
  assert.throws(() => deriveCandidateExecutionBinding(wrongSuccessor), /nanosecond successor/i);
});

test("nanosecond formatter emits canonical UTC with exactly nine fractional digits", () => {
  assert.equal(formatCanonicalUtcIsoNanoseconds(1n), "1970-01-01T00:00:00.000000001Z");
  assert.equal(
    formatCanonicalUtcIsoNanoseconds(999_999_999n),
    "1970-01-01T00:00:00.999999999Z",
  );
});

test("attempt timestamps handle second day and year rollover exactly", () => {
  assert.deepEqual(
    createCandidateExecutionAttemptTimestamps({
      activationEpochNs: 0n,
      bindingCreatedAt: "1970-01-01T00:00:00.999999999Z",
    }),
    {
      bindingCreatedAt: "1970-01-01T00:00:00.999999999Z",
      orderRequestedAt: "1970-01-01T00:00:01.000000000Z",
    },
  );
  assert.equal(
    createCandidateExecutionAttemptTimestamps({
      activationEpochNs: 0n,
      bindingCreatedAt: "2026-12-31T23:59:59.999999999Z",
    }).orderRequestedAt,
    "2027-01-01T00:00:00.000000000Z",
  );
});

test("attempt timestamps canonicalize mixed offsets before deriving the successor", () => {
  assert.deepEqual(
    createCandidateExecutionAttemptTimestamps({
      activationEpochNs: 0n,
      bindingCreatedAt: "2026-08-21T09:00:00.123456789+09:00",
    }),
    {
      bindingCreatedAt: "2026-08-21T00:00:00.123456789Z",
      orderRequestedAt: "2026-08-21T00:00:00.123456790Z",
    },
  );
});

test("timestamp helpers reject pre-epoch malformed and overlong timestamps", () => {
  assert.throws(() => formatCanonicalUtcIsoNanoseconds(-1n), /pre-epoch/i);
  for (const value of [
    "1969-12-31T23:59:59.999999999Z",
    "2026-08-21T00:00:00.1234567890Z",
    "2026-08-21T00:00:00",
    "not-a-timestamp",
  ]) {
    assert.throws(() => createCandidateExecutionAttemptTimestamps({
      activationEpochNs: 0n,
      bindingCreatedAt: value,
    }), Error, value);
  }
});

interface AuthorityOptions {
  expectedPhase?: "ACTIVE" | "DRAINING";
  routeReason?: CandidateExecutionAuthority["routeReason"];
}

function validAuthority(options: AuthorityOptions = {}): CandidateExecutionAuthority {
  const expectedPhase = options.expectedPhase ?? "ACTIVE";
  return {
    kind: "POSITION_GUARD_BTC_CANDIDATE",
    deploymentId: "deployment-1",
    exchangeAccountId: "primary",
    pilotId: "BTC_COMBINED_CONSERVATIVE_PILOT_V1",
    market: "KRW-BTC",
    strategyKey: "position_guard.paper_core.v1",
    policyId: "COMBINED_CONSERVATIVE",
    policyVersion: "PCS-2026-001.DEPLOYMENT_READINESS_V1",
    activationAt: "2026-08-21T00:00:00.000000000Z",
    activationEpochNs: BigInt(Date.parse("2026-08-21T00:00:00Z")) * 1_000_000n,
    expectedPhase,
    expectedDeploymentUpdatedAt: "2026-08-21T00:00:00.000000000Z",
    expectedStateVersion: 7,
    routeReason: options.routeReason ?? (
      expectedPhase === "ACTIVE" ? "CANDIDATE_ALLOWED" : "DRAINING_RISK_REDUCTION_PRESERVED"
    ),
  } as CandidateExecutionAuthority;
}

type ExecutedAction = "ENTER" | "ADD" | "REDUCE" | "EXIT";

interface DerivationOptions {
  action?: ExecutedAction;
  phase?: "ACTIVE" | "DRAINING";
}

interface DerivationFixture {
  authority: CandidateExecutionAuthority;
  order: OrderRecord;
  decision: StrategyDecisionRecord;
  bindingId: string;
  createdAt: string;
}

function validDerivation(options: DerivationOptions = {}): DerivationFixture {
  const action = options.action ?? "ENTER";
  const phase = options.phase ?? "ACTIVE";
  const isEntry = action === "ENTER" || action === "ADD";
  const bindingCreatedAt = "2026-08-21T00:00:00.000000001Z";
  const requestedAt = "2026-08-21T00:00:00.000000002Z";
  const authority = validAuthority({ expectedPhase: phase });
  const decision: StrategyDecisionRecord = {
    id: "decision-1",
    exchangeAccountId: "primary",
    strategyKey: "position_guard.paper_core.v1",
    market: "KRW-BTC",
    action,
    status: "READY",
    decisionBasisJson: "{}",
    intendedNotionalKrw: isEntry ? "10000" : null,
    intendedQuantity: isEntry ? null : "0.0001",
    referencePrice: "100000000",
    createdAt: bindingCreatedAt,
  };
  const order: OrderRecord = {
    id: "order-1",
    strategyDecisionId: decision.id,
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: isEntry ? "bid" : "ask",
    ordType: isEntry ? "price" : "market",
    volume: isEntry ? null : "0.0001",
    price: isEntry ? "10000" : null,
    timeInForce: null,
    smpType: null,
    identifier: "candidate-order-1",
    idempotencyKey: "candidate-idempotency-1",
    origin: "STRATEGY",
    requestedAt,
    upbitUuid: null,
    status: "PERSISTED",
    executionMode: "LIVE",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
  };
  return { authority, order, decision, bindingId: "binding-1", createdAt: bindingCreatedAt };
}
