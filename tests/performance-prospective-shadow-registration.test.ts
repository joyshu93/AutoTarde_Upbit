import assert from "node:assert/strict";
import test from "node:test";

import { BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY } from "../src/modules/strategy/position-guard-research-manifest.js";
import {
  PROSPECTIVE_SHADOW_ASSETS,
  PROSPECTIVE_SHADOW_AUTHORITY,
  PROSPECTIVE_SHADOW_COSTS,
  PROSPECTIVE_SHADOW_EXPERIMENT_ID,
  PROSPECTIVE_SHADOW_POLICY_MANIFEST,
  PROSPECTIVE_SHADOW_SCENARIOS,
  PROSPECTIVE_SHADOW_TIMINGS,
  createProspectiveShadowRegistration,
  parseProspectiveShadowRegistry,
  serializeProspectiveShadowRegistration,
  serializeProspectiveShadowRegistryEvent,
  validateProspectiveShadowRegistration,
  type CreateProspectiveShadowRegistrationInput,
  type ProspectiveShadowRegistration,
  type ProspectiveShadowRegistryEvent,
} from "../src/modules/performance/performance-prospective-shadow-registration.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const COMMIT_A = "1".repeat(40);

function validInput(
  overrides: Partial<CreateProspectiveShadowRegistrationInput> = {},
): CreateProspectiveShadowRegistrationInput {
  return {
    registeredAt: "2026-01-01T00:00:00Z",
    implementationCommitSha: COMMIT_A,
    developmentAuthoritySha256: SHA_A,
    retrospectiveReportSha256: SHA_B,
    policyManifest: structuredClone(PROSPECTIVE_SHADOW_POLICY_MANIFEST),
    ...overrides,
  };
}

function mutableRegistration(): ProspectiveShadowRegistration {
  return structuredClone(createProspectiveShadowRegistration(validInput())) as ProspectiveShadowRegistration;
}

test("registration freezes the exact prospective matrix, initial state, and fixed UTC window", () => {
  const registration = createProspectiveShadowRegistration(validInput());

  assert.equal(PROSPECTIVE_SHADOW_AUTHORITY, "PROSPECTIVE_COMPONENT_SHADOW_V1");
  assert.equal(PROSPECTIVE_SHADOW_EXPERIMENT_ID, "PCS-2026-001");
  assert.deepEqual(PROSPECTIVE_SHADOW_ASSETS, [
    { asset: "BTC", market: "KRW-BTC" },
    { asset: "ETH", market: "KRW-ETH" },
  ]);
  assert.deepEqual(PROSPECTIVE_SHADOW_SCENARIOS, [
    "COMBINED_CONSERVATIVE",
    "COMBINED_MINUS_EARLY_THESIS_FAILURE",
    "COMBINED_MINUS_COOLDOWN_CONTROL",
  ]);
  assert.deepEqual(PROSPECTIVE_SHADOW_TIMINGS, ["SAME_CLOSE_MODELED", "NEXT_FRAME_MODELED"]);
  assert.deepEqual(PROSPECTIVE_SHADOW_COSTS, [
    { id: "BASE", feeRate: 0.0005, slippageRate: 0.0003 },
    { id: "STRESS", feeRate: 0.001, slippageRate: 0.002 },
  ]);
  assert.deepEqual(registration.window, {
    from: "2026-01-04T00:00:00.000Z",
    to: "2026-05-04T00:00:00.000Z",
    durationMs: 10_368_000_000,
  });
  assert.equal(registration.matrix.pathCount, 24);
  assert.deepEqual(registration.initialStates, [
    {
      asset: "BTC",
      market: "KRW-BTC",
      cashKrw: 1_000_000,
      quantity: 0,
      openEpisode: false,
      addCount: 0,
      cooldownActive: false,
    },
    {
      asset: "ETH",
      market: "KRW-ETH",
      cashKrw: 1_000_000,
      quantity: 0,
      openEpisode: false,
      addCount: 0,
      cooldownActive: false,
    },
  ]);
  assert.equal(registration.minimumOrderValueKrw, 5_000);
  assert.equal(registration.implementationCommitSha, COMMIT_A);
  assert.equal("publicationCommitSha" in registration, false);
});

test("registration reserves a 72-hour publication buffer and rounds up to a whole UTC hour", () => {
  const registration = createProspectiveShadowRegistration(validInput({
    registeredAt: "2026-01-01T00:00:00.000000001Z",
  }));

  assert.equal(registration.registeredAt, "2026-01-01T00:00:00.000000001Z");
  assert.equal(registration.window.from, "2026-01-04T01:00:00.000Z");
  assert.equal(registration.window.to, "2026-05-04T01:00:00.000Z");
});

test("registration ceilings a pre-1970 fractional instant instead of skipping an extra UTC hour", () => {
  const registration = createProspectiveShadowRegistration(validInput({
    registeredAt: "1969-12-29T00:00:00.000000001Z",
  }));

  assert.equal(registration.window.from, "1970-01-01T01:00:00.000Z");
  assert.equal(registration.window.to, "1970-05-01T01:00:00.000Z");
});

test("registered policy manifest is an exact frozen projection of BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY", () => {
  const sourcePolicy = BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.policy;

  assert.strictEqual(
    PROSPECTIVE_SHADOW_POLICY_MANIFEST.developmentRange,
    BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.developmentRange,
  );
  assert.equal(
    PROSPECTIVE_SHADOW_POLICY_MANIFEST.featureWarmupStartAt,
    BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.developmentRange.from,
  );
  assert.strictEqual(
    PROSPECTIVE_SHADOW_POLICY_MANIFEST.components,
    sourcePolicy.scenarios.COMBINED_CONSERVATIVE.components,
  );
  assert.strictEqual(
    PROSPECTIVE_SHADOW_POLICY_MANIFEST.scenarios.COMBINED_CONSERVATIVE,
    sourcePolicy.scenarios.COMBINED_CONSERVATIVE.components,
  );
  assert.strictEqual(
    PROSPECTIVE_SHADOW_POLICY_MANIFEST.actionPrecedence,
    sourcePolicy.scenarios.COMBINED_CONSERVATIVE.precedence,
  );
  assert.strictEqual(
    PROSPECTIVE_SHADOW_POLICY_MANIFEST.thresholds.HTF_TREND_GATE,
    sourcePolicy.scenarios.HTF_TREND_GATE,
  );
  assert.strictEqual(
    PROSPECTIVE_SHADOW_POLICY_MANIFEST.thresholds.EARLY_THESIS_FAILURE,
    sourcePolicy.scenarios.EARLY_THESIS_FAILURE,
  );
  assert.strictEqual(
    PROSPECTIVE_SHADOW_POLICY_MANIFEST.thresholds.ADD_LIMITED,
    sourcePolicy.scenarios.ADD_LIMITED,
  );
  assert.strictEqual(
    PROSPECTIVE_SHADOW_POLICY_MANIFEST.thresholds.COOLDOWN_CONTROL,
    sourcePolicy.scenarios.COOLDOWN_CONTROL,
  );
  assert.deepEqual(PROSPECTIVE_SHADOW_POLICY_MANIFEST.thresholds, {
    HTF_TREND_GATE: {
      minimumTrendAlignmentScore: 3,
      allowedRegimes: ["BULL_TREND", "PULLBACK_IN_UPTREND", "EARLY_RECOVERY"],
    },
    EARLY_THESIS_FAILURE: {
      maximumFailedReclaimRecoveryQualityScore: 1,
      minimumBearishBreakdownPressureScore: 2,
    },
    ADD_LIMITED: {
      maxAddsPerEpisode: 1,
      minimumTrendAlignmentScore: 4,
      minimumRecoveryQualityScore: 3,
      allowedRegimes: ["BULL_TREND", "PULLBACK_IN_UPTREND"],
    },
    COOLDOWN_CONTROL: {
      nonPositiveExitHours: 12,
      sameEntryPathHours: 24,
    },
  });
});

test("registration serialization is canonical, checksum-bound, detached, and deeply frozen", () => {
  const input = validInput();
  const registration = createProspectiveShadowRegistration(input);
  const serialized = serializeProspectiveShadowRegistration(registration);
  const reparsed = validateProspectiveShadowRegistration(JSON.parse(serialized));

  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(reparsed, registration);
  assert.match(registration.payloadSha256, /^[a-f0-9]{64}$/);
  assert.equal(serializeProspectiveShadowRegistration(reparsed), serialized);
  assert.equal(Object.isFrozen(registration), true);
  assert.equal(Object.isFrozen(registration.matrix), true);
  assert.equal(Object.isFrozen(registration.matrix.costs), true);
  assert.equal(Object.isFrozen(registration.policyManifest.thresholds.ADD_LIMITED), true);

  (input.policyManifest.thresholds.ADD_LIMITED as { maxAddsPerEpisode: number }).maxAddsPerEpisode = 99;
  assert.equal(registration.policyManifest.thresholds.ADD_LIMITED.maxAddsPerEpisode, 1);

  const changed = createProspectiveShadowRegistration(validInput({ retrospectiveReportSha256: SHA_A }));
  assert.notEqual(changed.payloadSha256, registration.payloadSha256);
});

test("registration rejects matrix, policy, checksum, extra-key, hash, commit, timestamp, and numeric corruption", () => {
  const mutations: Array<[string, (value: any) => void, RegExp]> = [
    ["reordered scenarios", (value) => value.matrix.scenarios.reverse(), /scenario/i],
    ["extra timing", (value) => value.matrix.timings.push("LATE"), /timing/i],
    ["changed cost", (value) => value.matrix.costs[0].feeRate = 0.01, /cost/i],
    ["changed path count", (value) => value.matrix.pathCount = 23, /pathCount/i],
    ["changed initial cash", (value) => value.initialStates[0].cashKrw = 999_999, /initial state/i],
    ["changed minimum", (value) => value.minimumOrderValueKrw = 0, /minimum order/i],
    ["negative zero", (value) => value.matrix.costs[0].feeRate = -0, /negative zero|cost/i],
    ["non-finite", (value) => value.matrix.costs[0].feeRate = Number.NaN, /finite|cost/i],
    ["policy threshold", (value) => value.policyManifest.thresholds.ADD_LIMITED.maxAddsPerEpisode = 2, /policy manifest/i],
    ["checksum", (value) => value.payloadSha256 = "0".repeat(64), /checksum/i],
    ["extra key", (value) => value.unregistered = true, /keys/i],
    ["bad hash", (value) => value.developmentAuthoritySha256 = "A".repeat(64), /SHA-256/i],
    ["bad commit", (value) => value.implementationCommitSha = "abc", /commit/i],
    ["timezone-free", (value) => value.registeredAt = "2026-01-01T00:00:00", /timestamp/i],
    ["invalid calendar", (value) => value.registeredAt = "2026-02-30T00:00:00Z", /timestamp/i],
    ["over nanosecond", (value) => value.registeredAt = "2026-01-01T00:00:00.1234567890Z", /timestamp/i],
  ];

  for (const [name, mutate, expected] of mutations) {
    const value = mutableRegistration() as any;
    mutate(value);
    assert.throws(() => validateProspectiveShadowRegistration(value), expected, name);
  }
});

test("registry has one canonical REGISTERED event and an optional matching ABANDONED event", () => {
  const registration = createProspectiveShadowRegistration(validInput());
  const registered: ProspectiveShadowRegistryEvent = {
    schemaVersion: 1,
    authority: PROSPECTIVE_SHADOW_AUTHORITY,
    experimentId: PROSPECTIVE_SHADOW_EXPERIMENT_ID,
    event: "REGISTERED",
    eventAt: registration.registeredAt,
    registrationPayloadSha256: registration.payloadSha256,
  };
  const abandoned: ProspectiveShadowRegistryEvent = {
    schemaVersion: 1,
    authority: PROSPECTIVE_SHADOW_AUTHORITY,
    experimentId: PROSPECTIVE_SHADOW_EXPERIMENT_ID,
    event: "ABANDONED",
    eventAt: "2026-01-04T09:00:00+09:00",
    registrationPayloadSha256: registration.payloadSha256,
    publicationCommitSha: "2".repeat(40),
    reason: "Prospective evidence collection cannot continue.",
  };
  const registeredLine = serializeProspectiveShadowRegistryEvent(registered);
  const abandonedLine = serializeProspectiveShadowRegistryEvent(abandoned);
  const normalizedAbandoned = {
    ...abandoned,
    eventAt: "2026-01-04T00:00:00.000Z",
  };

  assert.equal(registeredLine.endsWith("\n"), true);
  assert.equal(abandonedLine.endsWith("\n"), true);
  assert.deepEqual(parseProspectiveShadowRegistry(registeredLine), {
    events: [registered],
    registrationPayloadSha256: registration.payloadSha256,
    abandoned: false,
  });
  assert.deepEqual(parseProspectiveShadowRegistry(registeredLine + abandonedLine), {
    events: [registered, normalizedAbandoned],
    registrationPayloadSha256: registration.payloadSha256,
    abandoned: true,
  });
});

test("registry rejects non-canonical bytes, reordered or duplicate events, and mismatched identities", () => {
  const registration = createProspectiveShadowRegistration(validInput());
  const registered: ProspectiveShadowRegistryEvent = {
    schemaVersion: 1,
    authority: PROSPECTIVE_SHADOW_AUTHORITY,
    experimentId: PROSPECTIVE_SHADOW_EXPERIMENT_ID,
    event: "REGISTERED",
    eventAt: registration.registeredAt,
    registrationPayloadSha256: registration.payloadSha256,
  };
  const abandoned: ProspectiveShadowRegistryEvent = {
    schemaVersion: 1,
    authority: PROSPECTIVE_SHADOW_AUTHORITY,
    experimentId: PROSPECTIVE_SHADOW_EXPERIMENT_ID,
    event: "ABANDONED",
    eventAt: "2026-01-04T00:00:00Z",
    registrationPayloadSha256: registration.payloadSha256,
    publicationCommitSha: "2".repeat(40),
    reason: "Stopped before close.",
  };
  const r = serializeProspectiveShadowRegistryEvent(registered);
  const a = serializeProspectiveShadowRegistryEvent(abandoned);

  assert.throws(() => parseProspectiveShadowRegistry(r.trimEnd()), /newline|canonical/i);
  assert.throws(() => parseProspectiveShadowRegistry(a + r), /REGISTERED|order/i);
  assert.throws(() => parseProspectiveShadowRegistry(r + r), /duplicate|REGISTERED/i);
  assert.throws(() => parseProspectiveShadowRegistry(r + a + a), /duplicate|ABANDONED/i);

  const mismatch = { ...abandoned, registrationPayloadSha256: SHA_A };
  assert.throws(
    () => parseProspectiveShadowRegistry(r + serializeProspectiveShadowRegistryEvent(mismatch)),
    /payload.*match/i,
  );
});
