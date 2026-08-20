import { createHash } from "node:crypto";

import { BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY } from "../strategy/position-guard-research-manifest.js";
import { parsePerformanceTimestamp } from "./performance-timestamp.js";

export const PROSPECTIVE_SHADOW_AUTHORITY = "PROSPECTIVE_COMPONENT_SHADOW_V1" as const;
export const PROSPECTIVE_SHADOW_EXPERIMENT_ID = "PCS-2026-001" as const;
export const PROSPECTIVE_SHADOW_WINDOW_DURATION_MS = 10_368_000_000 as const;
export const PROSPECTIVE_SHADOW_REGISTRATION_PREPARATION_LEAD_MS = 259_200_000 as const;
export const PROSPECTIVE_SHADOW_MIN_PUBLICATION_LEAD_MS = 172_800_000 as const;
export const PROSPECTIVE_SHADOW_MINIMUM_ORDER_VALUE_KRW = 5_000 as const;

export const PROSPECTIVE_SHADOW_ASSETS = deepFreeze([
  { asset: "BTC", market: "KRW-BTC" },
  { asset: "ETH", market: "KRW-ETH" },
] as const);
export const PROSPECTIVE_SHADOW_SCENARIOS = deepFreeze([
  "COMBINED_CONSERVATIVE",
  "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  "COMBINED_MINUS_COOLDOWN_CONTROL",
] as const);
export const PROSPECTIVE_SHADOW_TIMINGS = deepFreeze([
  "SAME_CLOSE_MODELED",
  "NEXT_FRAME_MODELED",
] as const);
export const PROSPECTIVE_SHADOW_COSTS = deepFreeze([
  { id: "BASE", feeRate: 0.0005, slippageRate: 0.0003 },
  { id: "STRESS", feeRate: 0.001, slippageRate: 0.002 },
] as const);

type RegisteredPolicyManifestWithoutChecksum = {
  readonly schemaVersion: 1;
  readonly authorityId: "BROAD_LOSS_CAUSE_V1";
  readonly developmentRange: Readonly<{ from: string; to: string }>;
  readonly featureWarmupStartAt: string;
  readonly components: readonly [
    "HTF_TREND_GATE",
    "EARLY_THESIS_FAILURE",
    "ADD_LIMITED",
    "COOLDOWN_CONTROL",
  ];
  readonly scenarios: Readonly<{
    COMBINED_CONSERVATIVE: readonly [
      "HTF_TREND_GATE",
      "EARLY_THESIS_FAILURE",
      "ADD_LIMITED",
      "COOLDOWN_CONTROL",
    ];
    COMBINED_MINUS_EARLY_THESIS_FAILURE: readonly [
      "HTF_TREND_GATE",
      "ADD_LIMITED",
      "COOLDOWN_CONTROL",
    ];
    COMBINED_MINUS_COOLDOWN_CONTROL: readonly [
      "HTF_TREND_GATE",
      "EARLY_THESIS_FAILURE",
      "ADD_LIMITED",
    ];
  }>;
  readonly actionPrecedence: readonly [
    "PRESERVE_RISK_REDUCTION",
    "EARLY_THESIS_FAILURE",
    "COOLDOWN_CONTROL",
    "HTF_TREND_GATE",
    "ADD_LIMITED",
  ];
  readonly thresholds: Readonly<{
    HTF_TREND_GATE: Readonly<{
      minimumTrendAlignmentScore: 3;
      allowedRegimes: readonly ["BULL_TREND", "PULLBACK_IN_UPTREND", "EARLY_RECOVERY"];
    }>;
    EARLY_THESIS_FAILURE: Readonly<{
      maximumFailedReclaimRecoveryQualityScore: 1;
      minimumBearishBreakdownPressureScore: 2;
    }>;
    ADD_LIMITED: Readonly<{
      maxAddsPerEpisode: 1;
      minimumTrendAlignmentScore: 4;
      minimumRecoveryQualityScore: 3;
      allowedRegimes: readonly ["BULL_TREND", "PULLBACK_IN_UPTREND"];
    }>;
    COOLDOWN_CONTROL: Readonly<{
      nonPositiveExitHours: 12;
      sameEntryPathHours: 24;
    }>;
  }>;
};

export type RegisteredPolicyManifest = RegisteredPolicyManifestWithoutChecksum & {
  readonly sha256: string;
};

const SOURCE_POLICY = BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.policy;
const SOURCE_COMBINED_COMPONENTS = SOURCE_POLICY.scenarios.COMBINED_CONSERVATIVE.components;

const POLICY_MANIFEST_UNSIGNED: RegisteredPolicyManifestWithoutChecksum = {
  schemaVersion: 1,
  authorityId: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.id,
  developmentRange: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.developmentRange,
  featureWarmupStartAt: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.developmentRange.from,
  components: SOURCE_COMBINED_COMPONENTS,
  scenarios: {
    COMBINED_CONSERVATIVE: SOURCE_COMBINED_COMPONENTS,
    COMBINED_MINUS_EARLY_THESIS_FAILURE: SOURCE_COMBINED_COMPONENTS.filter(
      (component) => component !== "EARLY_THESIS_FAILURE",
    ) as unknown as RegisteredPolicyManifestWithoutChecksum["scenarios"]["COMBINED_MINUS_EARLY_THESIS_FAILURE"],
    COMBINED_MINUS_COOLDOWN_CONTROL: SOURCE_COMBINED_COMPONENTS.filter(
      (component) => component !== "COOLDOWN_CONTROL",
    ) as unknown as RegisteredPolicyManifestWithoutChecksum["scenarios"]["COMBINED_MINUS_COOLDOWN_CONTROL"],
  },
  actionPrecedence: SOURCE_POLICY.scenarios.COMBINED_CONSERVATIVE.precedence,
  thresholds: {
    HTF_TREND_GATE: SOURCE_POLICY.scenarios.HTF_TREND_GATE,
    EARLY_THESIS_FAILURE: SOURCE_POLICY.scenarios.EARLY_THESIS_FAILURE,
    ADD_LIMITED: SOURCE_POLICY.scenarios.ADD_LIMITED,
    COOLDOWN_CONTROL: SOURCE_POLICY.scenarios.COOLDOWN_CONTROL,
  },
};

export const PROSPECTIVE_SHADOW_POLICY_MANIFEST: RegisteredPolicyManifest = deepFreeze({
  ...POLICY_MANIFEST_UNSIGNED,
  sha256: sha256(POLICY_MANIFEST_UNSIGNED),
});

export interface CreateProspectiveShadowRegistrationInput {
  readonly registeredAt: string;
  readonly implementationCommitSha: string;
  readonly developmentAuthoritySha256: string;
  readonly retrospectiveReportSha256: string;
  readonly policyManifest: RegisteredPolicyManifest;
}

export type ProspectiveShadowRegistration = Readonly<{
  schemaVersion: 1;
  authority: typeof PROSPECTIVE_SHADOW_AUTHORITY;
  experimentId: typeof PROSPECTIVE_SHADOW_EXPERIMENT_ID;
  registeredAt: string;
  window: Readonly<{ from: string; to: string; durationMs: typeof PROSPECTIVE_SHADOW_WINDOW_DURATION_MS }>;
  matrix: Readonly<{
    assets: typeof PROSPECTIVE_SHADOW_ASSETS;
    scenarios: typeof PROSPECTIVE_SHADOW_SCENARIOS;
    timings: typeof PROSPECTIVE_SHADOW_TIMINGS;
    costs: typeof PROSPECTIVE_SHADOW_COSTS;
    pathCount: 24;
  }>;
  initialStates: readonly [
    Readonly<{ asset: "BTC"; market: "KRW-BTC"; cashKrw: 1_000_000; quantity: 0; openEpisode: false; addCount: 0; cooldownActive: false }>,
    Readonly<{ asset: "ETH"; market: "KRW-ETH"; cashKrw: 1_000_000; quantity: 0; openEpisode: false; addCount: 0; cooldownActive: false }>,
  ];
  minimumOrderValueKrw: typeof PROSPECTIVE_SHADOW_MINIMUM_ORDER_VALUE_KRW;
  policyManifest: RegisteredPolicyManifest;
  implementationCommitSha: string;
  developmentAuthoritySha256: string;
  retrospectiveReportSha256: string;
  supportPolicy: Readonly<{ minimumKnownNetClosedEpisodesPerPath: 10 }>;
  comparisonPolicy: Readonly<{ percentagePointTolerance: 0.000001; krwTolerance: 0.000000001 }>;
  safety: Readonly<{ readOnly: true; deploymentApproval: false; liveApproval: false; boundary: string }>;
  payloadSha256: string;
}>;

type RegistrationWithoutChecksum = Omit<ProspectiveShadowRegistration, "payloadSha256">;

export type ProspectiveShadowRegisteredEvent = Readonly<{
  schemaVersion: 1;
  authority: typeof PROSPECTIVE_SHADOW_AUTHORITY;
  experimentId: typeof PROSPECTIVE_SHADOW_EXPERIMENT_ID;
  event: "REGISTERED";
  eventAt: string;
  registrationPayloadSha256: string;
}>;

export type ProspectiveShadowAbandonedEvent = Readonly<{
  schemaVersion: 1;
  authority: typeof PROSPECTIVE_SHADOW_AUTHORITY;
  experimentId: typeof PROSPECTIVE_SHADOW_EXPERIMENT_ID;
  event: "ABANDONED";
  eventAt: string;
  registrationPayloadSha256: string;
  publicationCommitSha: string;
  reason: string;
}>;

export type ProspectiveShadowRegistryEvent =
  | ProspectiveShadowRegisteredEvent
  | ProspectiveShadowAbandonedEvent;

export type ProspectiveShadowRegistry = Readonly<{
  events: readonly ProspectiveShadowRegistryEvent[];
  registrationPayloadSha256: string;
  abandoned: boolean;
}>;

export type ProspectiveShadowRegistrationDraft = Readonly<{
  registration: ProspectiveShadowRegistration;
  registrationBytes: string;
  registryBytes: string;
}>;

const HOUR_NS = 3_600_000_000_000n;
const REGISTRATION_DELAY_NS = BigInt(PROSPECTIVE_SHADOW_REGISTRATION_PREPARATION_LEAD_MS) * 1_000_000n;
const NS_PER_MS = 1_000_000n;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SAFETY_BOUNDARY = "Prospective research evidence cannot authorize deployment, LIVE execution, or strategy changes.";

export function createProspectiveShadowRegistration(
  input: CreateProspectiveShadowRegistrationInput,
): ProspectiveShadowRegistration {
  const registered = requireTimestamp(input.registeredAt, "registeredAt");
  const implementationCommitSha = requireCommit(input.implementationCommitSha, "implementationCommitSha");
  const developmentAuthoritySha256 = requireSha256(input.developmentAuthoritySha256, "developmentAuthoritySha256");
  const retrospectiveReportSha256 = requireSha256(input.retrospectiveReportSha256, "retrospectiveReportSha256");
  const policyManifest = validatePolicyManifest(structuredClone(input.policyManifest));
  const earliestStart = registered.epochNanoseconds + REGISTRATION_DELAY_NS;
  const fromNs = ceilToHour(earliestStart);
  const from = epochNanosecondsToIso(fromNs);
  const to = epochNanosecondsToIso(fromNs + BigInt(PROSPECTIVE_SHADOW_WINDOW_DURATION_MS) * NS_PER_MS);

  const unsigned: RegistrationWithoutChecksum = {
    schemaVersion: 1,
    authority: PROSPECTIVE_SHADOW_AUTHORITY,
    experimentId: PROSPECTIVE_SHADOW_EXPERIMENT_ID,
    registeredAt: registered.normalized,
    window: { from, to, durationMs: PROSPECTIVE_SHADOW_WINDOW_DURATION_MS },
    matrix: {
      assets: structuredClone(PROSPECTIVE_SHADOW_ASSETS),
      scenarios: structuredClone(PROSPECTIVE_SHADOW_SCENARIOS),
      timings: structuredClone(PROSPECTIVE_SHADOW_TIMINGS),
      costs: structuredClone(PROSPECTIVE_SHADOW_COSTS),
      pathCount: 24,
    },
    initialStates: [
      { asset: "BTC", market: "KRW-BTC", cashKrw: 1_000_000, quantity: 0, openEpisode: false, addCount: 0, cooldownActive: false },
      { asset: "ETH", market: "KRW-ETH", cashKrw: 1_000_000, quantity: 0, openEpisode: false, addCount: 0, cooldownActive: false },
    ],
    minimumOrderValueKrw: PROSPECTIVE_SHADOW_MINIMUM_ORDER_VALUE_KRW,
    policyManifest,
    implementationCommitSha,
    developmentAuthoritySha256,
    retrospectiveReportSha256,
    supportPolicy: { minimumKnownNetClosedEpisodesPerPath: 10 },
    comparisonPolicy: { percentagePointTolerance: 0.000001, krwTolerance: 0.000000001 },
    safety: { readOnly: true, deploymentApproval: false, liveApproval: false, boundary: SAFETY_BOUNDARY },
  };
  return deepFreeze({ ...unsigned, payloadSha256: sha256(unsigned) });
}

export function createProspectiveShadowRegistrationDraft(
  input: CreateProspectiveShadowRegistrationInput,
): ProspectiveShadowRegistrationDraft {
  const registration = createProspectiveShadowRegistration(input);
  const registeredEvent: ProspectiveShadowRegisteredEvent = {
    schemaVersion: 1,
    authority: registration.authority,
    experimentId: registration.experimentId,
    event: "REGISTERED",
    eventAt: registration.registeredAt,
    registrationPayloadSha256: registration.payloadSha256,
  };
  return Object.freeze({
    registration,
    registrationBytes: serializeProspectiveShadowRegistration(registration),
    registryBytes: serializeProspectiveShadowRegistryEvent(registeredEvent),
  });
}

export function validateProspectiveShadowRegistration(value: unknown): ProspectiveShadowRegistration {
  const record = requireRecord(value, "Prospective shadow registration");
  assertExactKeys(record, [
    "schemaVersion", "authority", "experimentId", "registeredAt", "window", "matrix",
    "initialStates", "minimumOrderValueKrw", "policyManifest", "implementationCommitSha",
    "developmentAuthoritySha256", "retrospectiveReportSha256", "supportPolicy",
    "comparisonPolicy", "safety", "payloadSha256",
  ], "Prospective shadow registration");

  const expected = createProspectiveShadowRegistration({
    registeredAt: requireString(record.registeredAt, "registeredAt"),
    implementationCommitSha: requireString(record.implementationCommitSha, "implementationCommitSha"),
    developmentAuthoritySha256: requireString(record.developmentAuthoritySha256, "developmentAuthoritySha256"),
    retrospectiveReportSha256: requireString(record.retrospectiveReportSha256, "retrospectiveReportSha256"),
    policyManifest: validatePolicyManifest(record.policyManifest),
  });
  const suppliedChecksum = requireSha256(record.payloadSha256, "payloadSha256");
  const expectedRecord = structuredClone(expected) as Record<string, unknown>;
  expectedRecord.payloadSha256 = suppliedChecksum;
  assertRegistrationSections(record, expectedRecord);
  if (suppliedChecksum !== expected.payloadSha256) {
    throw new Error("Prospective shadow registration checksum does not match its canonical payload.");
  }
  return expected;
}

export function serializeProspectiveShadowRegistration(
  registration: ProspectiveShadowRegistration,
): string {
  return `${canonicalJson(validateProspectiveShadowRegistration(registration))}\n`;
}

export function serializeProspectiveShadowRegistryEvent(
  event: ProspectiveShadowRegistryEvent,
): string {
  return `${canonicalJson(validateRegistryEvent(event))}\n`;
}

export function parseProspectiveShadowRegistry(bytes: string): ProspectiveShadowRegistry {
  if (typeof bytes !== "string" || bytes.length === 0 || !bytes.endsWith("\n")) {
    throw new Error("Prospective shadow registry must be non-empty canonical JSONL ending with a newline.");
  }
  const lines = bytes.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.length > 2 || lines.some((line) => line.length === 0)) {
    throw new Error("Prospective shadow registry must contain one REGISTERED event and at most one ABANDONED event.");
  }
  const events = lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Prospective shadow registry line ${index + 1} must be valid JSON.`);
    }
    const event = validateRegistryEvent(parsed);
    if (serializeProspectiveShadowRegistryEvent(event) !== `${line}\n`) {
      throw new Error(`Prospective shadow registry line ${index + 1} is not canonical JSONL.`);
    }
    return event;
  });
  const first = events[0];
  if (first?.event !== "REGISTERED") {
    throw new Error("Prospective shadow registry first event must be REGISTERED.");
  }
  if (events.length === 2 && events[1]?.event !== "ABANDONED") {
    throw new Error("Prospective shadow registry contains a duplicate REGISTERED event; the second event must be ABANDONED.");
  }
  const abandoned = events[1];
  if (abandoned !== undefined && abandoned.registrationPayloadSha256 !== first.registrationPayloadSha256) {
    throw new Error("Prospective shadow registry event payload hashes must match.");
  }
  return deepFreeze({
    events: structuredClone(events),
    registrationPayloadSha256: first.registrationPayloadSha256,
    abandoned: abandoned !== undefined,
  });
}

function validateRegistryEvent(value: unknown): ProspectiveShadowRegistryEvent {
  const record = requireRecord(value, "Prospective shadow registry event");
  const event = record.event;
  if (event === "REGISTERED") {
    assertExactKeys(record, ["schemaVersion", "authority", "experimentId", "event", "eventAt", "registrationPayloadSha256"], "REGISTERED registry event");
    validateRegistryIdentity(record);
    return deepFreeze({
      schemaVersion: 1,
      authority: PROSPECTIVE_SHADOW_AUTHORITY,
      experimentId: PROSPECTIVE_SHADOW_EXPERIMENT_ID,
      event: "REGISTERED",
      eventAt: requireRegistryTimestamp(record.eventAt, "REGISTERED eventAt"),
      registrationPayloadSha256: requireSha256(record.registrationPayloadSha256, "REGISTERED registrationPayloadSha256"),
    });
  }
  if (event === "ABANDONED") {
    assertExactKeys(record, ["schemaVersion", "authority", "experimentId", "event", "eventAt", "registrationPayloadSha256", "publicationCommitSha", "reason"], "ABANDONED registry event");
    validateRegistryIdentity(record);
    const reason = requireString(record.reason, "ABANDONED reason").trim();
    if (reason.length === 0) throw new Error("ABANDONED reason must be non-empty.");
    return deepFreeze({
      schemaVersion: 1,
      authority: PROSPECTIVE_SHADOW_AUTHORITY,
      experimentId: PROSPECTIVE_SHADOW_EXPERIMENT_ID,
      event: "ABANDONED",
      eventAt: requireRegistryTimestamp(record.eventAt, "ABANDONED eventAt"),
      registrationPayloadSha256: requireSha256(record.registrationPayloadSha256, "ABANDONED registrationPayloadSha256"),
      publicationCommitSha: requireCommit(record.publicationCommitSha, "ABANDONED publicationCommitSha"),
      reason,
    });
  }
  throw new Error("Prospective shadow registry event must be REGISTERED or ABANDONED.");
}

function validateRegistryIdentity(record: Record<string, unknown>): void {
  if (record.schemaVersion !== 1) throw new Error("Prospective shadow registry schemaVersion must be 1.");
  if (record.authority !== PROSPECTIVE_SHADOW_AUTHORITY) throw new Error("Prospective shadow registry authority is invalid.");
  if (record.experimentId !== PROSPECTIVE_SHADOW_EXPERIMENT_ID) throw new Error("Prospective shadow registry experimentId is invalid.");
}

function validatePolicyManifest(value: unknown): RegisteredPolicyManifest {
  const record = requireRecord(value, "Prospective shadow policy manifest");
  assertExactKeys(record, [...Object.keys(PROSPECTIVE_SHADOW_POLICY_MANIFEST)], "Prospective shadow policy manifest");
  if (canonicalJson(record) !== canonicalJson(PROSPECTIVE_SHADOW_POLICY_MANIFEST)) {
    throw new Error("Prospective shadow policy manifest does not match the frozen policy manifest.");
  }
  const { sha256: declared, ...unsigned } = record;
  if (declared !== sha256(unsigned)) throw new Error("Prospective shadow policy manifest checksum is invalid.");
  return deepFreeze(structuredClone(record) as RegisteredPolicyManifest);
}

function assertRegistrationSections(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  const labels: Array<[string, string]> = [
    ["schemaVersion", "schemaVersion"], ["authority", "authority"], ["experimentId", "experimentId"],
    ["registeredAt", "registeredAt timestamp"], ["window", "window"], ["matrix", "matrix scenario/timing/cost/pathCount"],
    ["initialStates", "initial state"], ["minimumOrderValueKrw", "minimum order value"],
    ["policyManifest", "policy manifest"], ["implementationCommitSha", "implementation commit"],
    ["developmentAuthoritySha256", "development authority SHA-256"], ["retrospectiveReportSha256", "retrospective report SHA-256"],
    ["supportPolicy", "support policy"], ["comparisonPolicy", "comparison policy"], ["safety", "safety boundary"],
  ];
  for (const [key, label] of labels) {
    if (canonicalJson(actual[key]) !== canonicalJson(expected[key])) {
      throw new Error(`Prospective shadow registration ${label} does not match the frozen contract.`);
    }
  }
}

function ceilToHour(value: bigint): bigint {
  const remainder = ((value % HOUR_NS) + HOUR_NS) % HOUR_NS;
  return remainder === 0n ? value : value + HOUR_NS - remainder;
}

function epochNanosecondsToIso(value: bigint): string {
  if (value % NS_PER_MS !== 0n) throw new Error("Prospective shadow window must be millisecond-aligned.");
  const milliseconds = Number(value / NS_PER_MS);
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Prospective shadow window timestamp is outside the supported range.");
  const iso = new Date(milliseconds).toISOString();
  if (!parsePerformanceTimestamp(iso)) throw new Error("Prospective shadow window timestamp is invalid.");
  return iso;
}

function requireTimestamp(value: string, label: string) {
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) throw new Error(`${label} must be an exact ISO-8601 timestamp with an explicit timezone and at most nanosecond precision.`);
  return parsed;
}

function requireRegistryTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label);
  return requireTimestamp(timestamp, label).normalized;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hex digest.`);
  return value;
}

function requireCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !COMMIT_SHA.test(value)) throw new Error(`${label} must be a lowercase 40-character Git commit SHA.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys must match the frozen contract exactly.`);
  }
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON numbers must be finite.");
    if (Object.is(value, -0)) throw new Error("Canonical JSON numbers must not be negative zero.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = requireRecord(value, "Canonical JSON value");
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
