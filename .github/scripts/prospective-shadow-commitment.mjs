// Generated validator bundle. Source: src/research/prospective-shadow-commitment.ts

// src/research/prospective-shadow-commitment.ts
import { createHash as createHash2 } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// src/modules/performance/performance-prospective-shadow-registration.ts
import { createHash } from "node:crypto";

// src/modules/strategy/position-guard-research-manifest.ts
var FROZEN_BROAD_LOSS_CAUSE_SCENARIO_ORDER = [
  "HTF_TREND_GATE",
  "STRICT_PULLBACK",
  "EARLY_THESIS_FAILURE",
  "ADD_LIMITED",
  "COOLDOWN_CONTROL",
  "COMBINED_CONSERVATIVE"
];
var FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER = [
  "COMBINED_MINUS_HTF_TREND_GATE",
  "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  "COMBINED_MINUS_ADD_LIMITED",
  "COMBINED_MINUS_COOLDOWN_CONTROL"
];
var BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY = deepFreeze({
  id: "BROAD_LOSS_CAUSE_V1",
  developmentRange: {
    from: "2025-01-01T00:00:00Z",
    to: "2026-04-12T19:00:00Z"
  },
  validationWindows: [
    { id: "W1", from: "2025-07-20T00:00:00Z", to: "2025-10-25T19:00:00Z" },
    { id: "W2", from: "2025-10-26T00:00:00Z", to: "2025-12-31T19:00:00Z" },
    { id: "W3", from: "2026-01-01T00:00:00Z", to: "2026-04-12T19:00:00Z" }
  ],
  costCells: [
    { id: "BASE", role: "BASE", feeRate: 5e-4, slippageRate: 3e-4 },
    { id: "STRESS", role: "STRESS", feeRate: 1e-3, slippageRate: 2e-3 }
  ],
  executionTimingModels: ["SAME_CLOSE_MODELED", "NEXT_FRAME_MODELED"],
  anchors: ["BASELINE", "NO_ADD"],
  scenarioOrder: FROZEN_BROAD_LOSS_CAUSE_SCENARIO_ORDER,
  evaluationThresholds: {
    minimumFullPathCompletedEpisodes: 30,
    minimumWindowPolicyExposedCompletedEpisodes: 10,
    minimumImprovedWindowCount: 2
  },
  policy: {
    quantityTolerance: 1e-12,
    scenarios: {
      HTF_TREND_GATE: {
        minimumTrendAlignmentScore: 3,
        allowedRegimes: ["BULL_TREND", "PULLBACK_IN_UPTREND", "EARLY_RECOVERY"]
      },
      STRICT_PULLBACK: {
        requiredEntryPath: "PULLBACK",
        requiredRegime: "PULLBACK_IN_UPTREND",
        minimumTrendAlignmentScore: 4,
        minimumRecoveryQualityScore: 3,
        allowedOneHourLocations: ["LOWER", "MIDDLE"]
      },
      EARLY_THESIS_FAILURE: {
        maximumFailedReclaimRecoveryQualityScore: 1,
        minimumBearishBreakdownPressureScore: 2
      },
      ADD_LIMITED: {
        maxAddsPerEpisode: 1,
        minimumTrendAlignmentScore: 4,
        minimumRecoveryQualityScore: 3,
        allowedRegimes: ["BULL_TREND", "PULLBACK_IN_UPTREND"]
      },
      COOLDOWN_CONTROL: {
        nonPositiveExitHours: 12,
        sameEntryPathHours: 24
      },
      COMBINED_CONSERVATIVE: {
        components: ["HTF_TREND_GATE", "EARLY_THESIS_FAILURE", "ADD_LIMITED", "COOLDOWN_CONTROL"],
        precedence: [
          "PRESERVE_RISK_REDUCTION",
          "EARLY_THESIS_FAILURE",
          "COOLDOWN_CONTROL",
          "HTF_TREND_GATE",
          "ADD_LIMITED"
        ]
      }
    }
  }
});
var COMBINED_CONSERVATIVE_COMPONENTS = BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.policy.scenarios.COMBINED_CONSERVATIVE.components;
var COMBINED_CONSERVATIVE_ABLATION_RESEARCH_AUTHORITY = deepFreeze({
  id: "COMBINED_CONSERVATIVE_ABLATION_V1",
  components: COMBINED_CONSERVATIVE_COMPONENTS,
  precedence: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.policy.scenarios.COMBINED_CONSERVATIVE.precedence,
  scenarioOrder: FROZEN_COMBINED_CONSERVATIVE_ABLATION_SCENARIO_ORDER,
  scenarios: {
    COMBINED_MINUS_HTF_TREND_GATE: {
      inactiveComponent: "HTF_TREND_GATE",
      activeComponents: ["EARLY_THESIS_FAILURE", "ADD_LIMITED", "COOLDOWN_CONTROL"]
    },
    COMBINED_MINUS_EARLY_THESIS_FAILURE: {
      inactiveComponent: "EARLY_THESIS_FAILURE",
      activeComponents: ["HTF_TREND_GATE", "ADD_LIMITED", "COOLDOWN_CONTROL"]
    },
    COMBINED_MINUS_ADD_LIMITED: {
      inactiveComponent: "ADD_LIMITED",
      activeComponents: ["HTF_TREND_GATE", "EARLY_THESIS_FAILURE", "COOLDOWN_CONTROL"]
    },
    COMBINED_MINUS_COOLDOWN_CONTROL: {
      inactiveComponent: "COOLDOWN_CONTROL",
      activeComponents: ["HTF_TREND_GATE", "EARLY_THESIS_FAILURE", "ADD_LIMITED"]
    }
  }
});
function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

// src/modules/performance/performance-timestamp.ts
var EXPLICIT_ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
var NANOSECONDS_PER_MILLISECOND = 1000000n;
function parsePerformanceTimestamp(value) {
  const match = EXPLICIT_ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const timezone = match[8];
  if (timezone === void 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59 || !isValidTimezone(timezone)) {
    return null;
  }
  const wholeSecond = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${timezone}`;
  const epochMilliseconds = Date.parse(wholeSecond);
  if (!Number.isFinite(epochMilliseconds)) return null;
  const fractionNanoseconds = BigInt(fraction.padEnd(9, "0") || "0");
  const normalizedFraction = fraction.length < 3 ? fraction.padEnd(3, "0") : fraction;
  const normalizedSecond = new Date(epochMilliseconds).toISOString().slice(0, 19);
  return {
    normalized: `${normalizedSecond}.${normalizedFraction || "000"}Z`,
    epochNanoseconds: BigInt(epochMilliseconds) * NANOSECONDS_PER_MILLISECOND + fractionNanoseconds
  };
}
function compareEpochNanoseconds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function isValidTimezone(timezone) {
  if (timezone === "Z") return true;
  const offsetHour = Number(timezone.slice(1, 3));
  const offsetMinute = Number(timezone.slice(4, 6));
  return offsetHour < 14 || offsetHour === 14 && offsetMinute === 0;
}
function daysInMonth(year, month) {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// src/modules/performance/performance-prospective-shadow-registration.ts
var PROSPECTIVE_SHADOW_AUTHORITY = "PROSPECTIVE_COMPONENT_SHADOW_V1";
var PROSPECTIVE_SHADOW_EXPERIMENT_ID = "PCS-2026-001";
var PROSPECTIVE_SHADOW_WINDOW_DURATION_MS = 10368e6;
var PROSPECTIVE_SHADOW_REGISTRATION_PREPARATION_LEAD_MS = 2592e5;
var PROSPECTIVE_SHADOW_MIN_PUBLICATION_LEAD_MS = 1728e5;
var PROSPECTIVE_SHADOW_MINIMUM_ORDER_VALUE_KRW = 5e3;
var PROSPECTIVE_SHADOW_ASSETS = deepFreeze2([
  { asset: "BTC", market: "KRW-BTC" },
  { asset: "ETH", market: "KRW-ETH" }
]);
var PROSPECTIVE_SHADOW_SCENARIOS = deepFreeze2([
  "COMBINED_CONSERVATIVE",
  "COMBINED_MINUS_EARLY_THESIS_FAILURE",
  "COMBINED_MINUS_COOLDOWN_CONTROL"
]);
var PROSPECTIVE_SHADOW_TIMINGS = deepFreeze2([
  "SAME_CLOSE_MODELED",
  "NEXT_FRAME_MODELED"
]);
var PROSPECTIVE_SHADOW_COSTS = deepFreeze2([
  { id: "BASE", feeRate: 5e-4, slippageRate: 3e-4 },
  { id: "STRESS", feeRate: 1e-3, slippageRate: 2e-3 }
]);
var SOURCE_POLICY = BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.policy;
var SOURCE_COMBINED_COMPONENTS = SOURCE_POLICY.scenarios.COMBINED_CONSERVATIVE.components;
var POLICY_MANIFEST_UNSIGNED = {
  schemaVersion: 1,
  authorityId: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.id,
  developmentRange: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.developmentRange,
  featureWarmupStartAt: BROAD_LOSS_CAUSE_RESEARCH_AUTHORITY.developmentRange.from,
  components: SOURCE_COMBINED_COMPONENTS,
  scenarios: {
    COMBINED_CONSERVATIVE: SOURCE_COMBINED_COMPONENTS,
    COMBINED_MINUS_EARLY_THESIS_FAILURE: SOURCE_COMBINED_COMPONENTS.filter(
      (component) => component !== "EARLY_THESIS_FAILURE"
    ),
    COMBINED_MINUS_COOLDOWN_CONTROL: SOURCE_COMBINED_COMPONENTS.filter(
      (component) => component !== "COOLDOWN_CONTROL"
    )
  },
  actionPrecedence: SOURCE_POLICY.scenarios.COMBINED_CONSERVATIVE.precedence,
  thresholds: {
    HTF_TREND_GATE: SOURCE_POLICY.scenarios.HTF_TREND_GATE,
    EARLY_THESIS_FAILURE: SOURCE_POLICY.scenarios.EARLY_THESIS_FAILURE,
    ADD_LIMITED: SOURCE_POLICY.scenarios.ADD_LIMITED,
    COOLDOWN_CONTROL: SOURCE_POLICY.scenarios.COOLDOWN_CONTROL
  }
};
var PROSPECTIVE_SHADOW_POLICY_MANIFEST = deepFreeze2({
  ...POLICY_MANIFEST_UNSIGNED,
  sha256: sha256(POLICY_MANIFEST_UNSIGNED)
});
var HOUR_NS = 3600000000000n;
var REGISTRATION_DELAY_NS = BigInt(PROSPECTIVE_SHADOW_REGISTRATION_PREPARATION_LEAD_MS) * 1000000n;
var NS_PER_MS = 1000000n;
var SHA256_HEX = /^[a-f0-9]{64}$/;
var COMMIT_SHA = /^[a-f0-9]{40}$/;
var SAFETY_BOUNDARY = "Prospective research evidence cannot authorize deployment, LIVE execution, or strategy changes.";
function createProspectiveShadowRegistration(input) {
  const registered = requireTimestamp(input.registeredAt, "registeredAt");
  const implementationCommitSha = requireCommit(input.implementationCommitSha, "implementationCommitSha");
  const developmentAuthoritySha256 = requireSha256(input.developmentAuthoritySha256, "developmentAuthoritySha256");
  const retrospectiveReportSha256 = requireSha256(input.retrospectiveReportSha256, "retrospectiveReportSha256");
  const policyManifest = validatePolicyManifest(structuredClone(input.policyManifest));
  const earliestStart = registered.epochNanoseconds + REGISTRATION_DELAY_NS;
  const fromNs = ceilToHour(earliestStart);
  const from = epochNanosecondsToIso(fromNs);
  const to = epochNanosecondsToIso(fromNs + BigInt(PROSPECTIVE_SHADOW_WINDOW_DURATION_MS) * NS_PER_MS);
  const unsigned = {
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
      pathCount: 24
    },
    initialStates: [
      { asset: "BTC", market: "KRW-BTC", cashKrw: 1e6, quantity: 0, openEpisode: false, addCount: 0, cooldownActive: false },
      { asset: "ETH", market: "KRW-ETH", cashKrw: 1e6, quantity: 0, openEpisode: false, addCount: 0, cooldownActive: false }
    ],
    minimumOrderValueKrw: PROSPECTIVE_SHADOW_MINIMUM_ORDER_VALUE_KRW,
    policyManifest,
    implementationCommitSha,
    developmentAuthoritySha256,
    retrospectiveReportSha256,
    supportPolicy: { minimumKnownNetClosedEpisodesPerPath: 10 },
    comparisonPolicy: { percentagePointTolerance: 1e-6, krwTolerance: 1e-9 },
    safety: { readOnly: true, deploymentApproval: false, liveApproval: false, boundary: SAFETY_BOUNDARY }
  };
  return deepFreeze2({ ...unsigned, payloadSha256: sha256(unsigned) });
}
function validateProspectiveShadowRegistration(value) {
  const record = requireRecord(value, "Prospective shadow registration");
  assertExactKeys(record, [
    "schemaVersion",
    "authority",
    "experimentId",
    "registeredAt",
    "window",
    "matrix",
    "initialStates",
    "minimumOrderValueKrw",
    "policyManifest",
    "implementationCommitSha",
    "developmentAuthoritySha256",
    "retrospectiveReportSha256",
    "supportPolicy",
    "comparisonPolicy",
    "safety",
    "payloadSha256"
  ], "Prospective shadow registration");
  const expected = createProspectiveShadowRegistration({
    registeredAt: requireString(record.registeredAt, "registeredAt"),
    implementationCommitSha: requireString(record.implementationCommitSha, "implementationCommitSha"),
    developmentAuthoritySha256: requireString(record.developmentAuthoritySha256, "developmentAuthoritySha256"),
    retrospectiveReportSha256: requireString(record.retrospectiveReportSha256, "retrospectiveReportSha256"),
    policyManifest: validatePolicyManifest(record.policyManifest)
  });
  const suppliedChecksum = requireSha256(record.payloadSha256, "payloadSha256");
  const expectedRecord = structuredClone(expected);
  expectedRecord.payloadSha256 = suppliedChecksum;
  assertRegistrationSections(record, expectedRecord);
  if (suppliedChecksum !== expected.payloadSha256) {
    throw new Error("Prospective shadow registration checksum does not match its canonical payload.");
  }
  return expected;
}
function serializeProspectiveShadowRegistration(registration) {
  return `${canonicalJson(validateProspectiveShadowRegistration(registration))}
`;
}
function serializeProspectiveShadowRegistryEvent(event) {
  return `${canonicalJson(validateRegistryEvent(event))}
`;
}
function parseProspectiveShadowRegistry(bytes) {
  if (typeof bytes !== "string" || bytes.length === 0 || !bytes.endsWith("\n")) {
    throw new Error("Prospective shadow registry must be non-empty canonical JSONL ending with a newline.");
  }
  const lines = bytes.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.length > 2 || lines.some((line) => line.length === 0)) {
    throw new Error("Prospective shadow registry must contain one REGISTERED event and at most one ABANDONED event.");
  }
  const events = lines.map((line, index) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Prospective shadow registry line ${index + 1} must be valid JSON.`);
    }
    const event = validateRegistryEvent(parsed);
    if (serializeProspectiveShadowRegistryEvent(event) !== `${line}
`) {
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
  if (abandoned !== void 0 && abandoned.registrationPayloadSha256 !== first.registrationPayloadSha256) {
    throw new Error("Prospective shadow registry event payload hashes must match.");
  }
  return deepFreeze2({
    events: structuredClone(events),
    registrationPayloadSha256: first.registrationPayloadSha256,
    abandoned: abandoned !== void 0
  });
}
function validateRegistryEvent(value) {
  const record = requireRecord(value, "Prospective shadow registry event");
  const event = record.event;
  if (event === "REGISTERED") {
    assertExactKeys(record, ["schemaVersion", "authority", "experimentId", "event", "eventAt", "registrationPayloadSha256"], "REGISTERED registry event");
    validateRegistryIdentity(record);
    return deepFreeze2({
      schemaVersion: 1,
      authority: PROSPECTIVE_SHADOW_AUTHORITY,
      experimentId: PROSPECTIVE_SHADOW_EXPERIMENT_ID,
      event: "REGISTERED",
      eventAt: requireRegistryTimestamp(record.eventAt, "REGISTERED eventAt"),
      registrationPayloadSha256: requireSha256(record.registrationPayloadSha256, "REGISTERED registrationPayloadSha256")
    });
  }
  if (event === "ABANDONED") {
    assertExactKeys(record, ["schemaVersion", "authority", "experimentId", "event", "eventAt", "registrationPayloadSha256", "publicationCommitSha", "reason"], "ABANDONED registry event");
    validateRegistryIdentity(record);
    const reason = requireString(record.reason, "ABANDONED reason").trim();
    if (reason.length === 0) throw new Error("ABANDONED reason must be non-empty.");
    return deepFreeze2({
      schemaVersion: 1,
      authority: PROSPECTIVE_SHADOW_AUTHORITY,
      experimentId: PROSPECTIVE_SHADOW_EXPERIMENT_ID,
      event: "ABANDONED",
      eventAt: requireRegistryTimestamp(record.eventAt, "ABANDONED eventAt"),
      registrationPayloadSha256: requireSha256(record.registrationPayloadSha256, "ABANDONED registrationPayloadSha256"),
      publicationCommitSha: requireCommit(record.publicationCommitSha, "ABANDONED publicationCommitSha"),
      reason
    });
  }
  throw new Error("Prospective shadow registry event must be REGISTERED or ABANDONED.");
}
function validateRegistryIdentity(record) {
  if (record.schemaVersion !== 1) throw new Error("Prospective shadow registry schemaVersion must be 1.");
  if (record.authority !== PROSPECTIVE_SHADOW_AUTHORITY) throw new Error("Prospective shadow registry authority is invalid.");
  if (record.experimentId !== PROSPECTIVE_SHADOW_EXPERIMENT_ID) throw new Error("Prospective shadow registry experimentId is invalid.");
}
function validatePolicyManifest(value) {
  const record = requireRecord(value, "Prospective shadow policy manifest");
  assertExactKeys(record, [...Object.keys(PROSPECTIVE_SHADOW_POLICY_MANIFEST)], "Prospective shadow policy manifest");
  if (canonicalJson(record) !== canonicalJson(PROSPECTIVE_SHADOW_POLICY_MANIFEST)) {
    throw new Error("Prospective shadow policy manifest does not match the frozen policy manifest.");
  }
  const { sha256: declared, ...unsigned } = record;
  if (declared !== sha256(unsigned)) throw new Error("Prospective shadow policy manifest checksum is invalid.");
  return deepFreeze2(structuredClone(record));
}
function assertRegistrationSections(actual, expected) {
  const labels = [
    ["schemaVersion", "schemaVersion"],
    ["authority", "authority"],
    ["experimentId", "experimentId"],
    ["registeredAt", "registeredAt timestamp"],
    ["window", "window"],
    ["matrix", "matrix scenario/timing/cost/pathCount"],
    ["initialStates", "initial state"],
    ["minimumOrderValueKrw", "minimum order value"],
    ["policyManifest", "policy manifest"],
    ["implementationCommitSha", "implementation commit"],
    ["developmentAuthoritySha256", "development authority SHA-256"],
    ["retrospectiveReportSha256", "retrospective report SHA-256"],
    ["supportPolicy", "support policy"],
    ["comparisonPolicy", "comparison policy"],
    ["safety", "safety boundary"]
  ];
  for (const [key, label] of labels) {
    if (canonicalJson(actual[key]) !== canonicalJson(expected[key])) {
      throw new Error(`Prospective shadow registration ${label} does not match the frozen contract.`);
    }
  }
}
function ceilToHour(value) {
  const remainder = (value % HOUR_NS + HOUR_NS) % HOUR_NS;
  return remainder === 0n ? value : value + HOUR_NS - remainder;
}
function epochNanosecondsToIso(value) {
  if (value % NS_PER_MS !== 0n) throw new Error("Prospective shadow window must be millisecond-aligned.");
  const milliseconds = Number(value / NS_PER_MS);
  if (!Number.isSafeInteger(milliseconds)) throw new Error("Prospective shadow window timestamp is outside the supported range.");
  const iso = new Date(milliseconds).toISOString();
  if (!parsePerformanceTimestamp(iso)) throw new Error("Prospective shadow window timestamp is invalid.");
  return iso;
}
function requireTimestamp(value, label) {
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) throw new Error(`${label} must be an exact ISO-8601 timestamp with an explicit timezone and at most nanosecond precision.`);
  return parsed;
}
function requireRegistryTimestamp(value, label) {
  const timestamp = requireString(value, label);
  return requireTimestamp(timestamp, label).normalized;
}
function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) throw new Error(`${label} must be a lowercase SHA-256 hex digest.`);
  return value;
}
function requireCommit(value, label) {
  if (typeof value !== "string" || !COMMIT_SHA.test(value)) throw new Error(`${label} must be a lowercase 40-character Git commit SHA.`);
  return value;
}
function requireString(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}
function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}
function assertExactKeys(record, expected, label) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys must match the frozen contract exactly.`);
  }
}
function sha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
function canonicalJson(value) {
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
function deepFreeze2(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze2(nested);
    Object.freeze(value);
  }
  return value;
}

// src/modules/performance/performance-prospective-shadow-commitment.ts
var PROSPECTIVE_SHADOW_REPOSITORY = "joyshu93/AutoTarde_Upbit";
var PROSPECTIVE_SHADOW_BRANCH = "main";
var PROSPECTIVE_SHADOW_REGISTRATION_PATH = "docs/research/prospective-shadow/PCS-2026-001.registration.json";
var PROSPECTIVE_SHADOW_REGISTRY_PATH = "docs/research/prospective-shadow/registry.jsonl";
var PROSPECTIVE_SHADOW_WORKFLOW_PATH = ".github/workflows/prospective-shadow-registration.yml";
function validateProspectiveShadowWorkflowMetadata(input) {
  const context = validateContext(input.context);
  const run = validateActionsRun(input.actionsRun);
  if (run.id !== context.runId) throw new Error("GitHub Actions run ID does not match the exact workflow run.");
  if (run.html_url !== context.runUrl) throw new Error("GitHub Actions run URL does not match the exact workflow run.");
  if (run.repository.full_name !== context.repository) throw new Error("GitHub Actions repository identity does not match.");
  if (run.head_branch !== context.branch) throw new Error("GitHub Actions branch identity does not match.");
  if (run.head_sha !== context.headSha) throw new Error("GitHub Actions head SHA identity does not match.");
  return deepFreeze3({
    schemaVersion: 1,
    authority: PROSPECTIVE_SHADOW_AUTHORITY,
    mode: context.mode,
    repository: PROSPECTIVE_SHADOW_REPOSITORY,
    branch: PROSPECTIVE_SHADOW_BRANCH,
    runId: context.runId,
    runUrl: context.runUrl,
    serverCreatedAt: requireTimestamp2(run.created_at, "GitHub Actions server created_at"),
    implementationCommitSha: context.implementationCommitSha,
    publicationCommitSha: context.publicationCommitSha,
    headSha: context.headSha,
    registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH,
    registryPath: PROSPECTIVE_SHADOW_REGISTRY_PATH,
    workflowPath: PROSPECTIVE_SHADOW_WORKFLOW_PATH,
    registrationPayloadSha256: context.registrationPayloadSha256
  });
}
function validateProspectiveShadowPersistedWorkflowMetadata(value, mode) {
  return validateMetadata(value, mode);
}
function validateProspectiveShadowPublicationStructure(registrationInput, evidenceInput, options = {}) {
  const registration = validateProspectiveShadowRegistration(registrationInput);
  const evidence = validatePublicationEvidence(evidenceInput);
  if (options.requireImplementationCheckout !== false) {
    assertEqual(evidence.currentHeadSha, registration.implementationCommitSha, "current HEAD must equal the implementation commit");
  }
  assertDistinctCommits(registration.implementationCommitSha, evidence.publicationCommitSha);
  assertExpectedMissing(evidence.registrationAtImplementation, "registration path at implementation commit");
  assertExpectedMissing(evidence.registryAtImplementation, "registry path at implementation commit");
  if (evidence.publicationParents.length !== 1) throw new Error("Publication commit must have exactly one parent.");
  assertEqual(evidence.publicationParents[0], registration.implementationCommitSha, "publication parent");
  assertExactPaths(evidence.publicationChangedPaths, [PROSPECTIVE_SHADOW_REGISTRATION_PATH, PROSPECTIVE_SHADOW_REGISTRY_PATH]);
  if (evidence.registrationBytes !== serializeProspectiveShadowRegistration(registration)) {
    throw new Error("Publication registration bytes do not match the canonical registration.");
  }
  const registry = parseProspectiveShadowRegistry(evidence.registryBytes);
  if (registry.events.length !== 1) throw new Error("Initial public registry must contain exactly one REGISTERED event and must not be abandoned.");
  const registered = registry.events[0];
  if (registered?.event !== "REGISTERED" || registered.eventAt !== registration.registeredAt) {
    throw new Error("REGISTERED eventAt must exactly equal registration.registeredAt.");
  }
  assertEqual(registry.registrationPayloadSha256, registration.payloadSha256, "registry registration payload");
  if (evidence.workflowAtImplementationBytes.length === 0 || evidence.workflowAtImplementationBytes !== evidence.workflowAtPublicationBytes) {
    throw new Error("Workflow bytes must be non-empty and identical in implementation and publication commits.");
  }
  return evidence;
}
function validateProspectiveShadowAbandonmentStructure(registrationInput, evidenceInput, options = {}) {
  const registration = validateProspectiveShadowRegistration(registrationInput);
  const evidence = validateAbandonmentEvidence(evidenceInput);
  if (options.requireImplementationCheckout !== false) {
    assertEqual(evidence.currentHeadSha, registration.implementationCommitSha, "current HEAD must equal the implementation commit");
  }
  if (!evidence.publicationIsAncestorOfAbandonment) {
    throw new Error("Publication commit must be an ancestor of the abandonment commit.");
  }
  if (evidence.abandonmentParents.length !== 1) throw new Error("Abandonment commit must have exactly one parent.");
  assertExactPaths(evidence.abandonmentChangedPaths, [PROSPECTIVE_SHADOW_REGISTRY_PATH]);
  const canonicalRegistration = serializeProspectiveShadowRegistration(registration);
  if (evidence.registrationAtPublicationBytes !== canonicalRegistration || evidence.registrationAtAbandonmentBytes !== canonicalRegistration) {
    throw new Error("Canonical registration must remain unchanged in the abandonment commit.");
  }
  const before = parseProspectiveShadowRegistry(evidence.registryAtPublicationBytes);
  const after = parseProspectiveShadowRegistry(evidence.registryAtAbandonmentBytes);
  if (before.events.length !== 1 || after.events.length !== 2 || !after.abandoned) {
    throw new Error("Abandonment must preserve one REGISTERED event and append exactly one ABANDONED event.");
  }
  if (evidence.registryAtAbandonmentBytes.slice(0, evidence.registryAtPublicationBytes.length) !== evidence.registryAtPublicationBytes) {
    throw new Error("Abandonment registry must preserve the original registry bytes exactly.");
  }
  const abandonment = after.events[1];
  if (abandonment?.event !== "ABANDONED" || compareTimestamp(abandonment.eventAt, registration.window.to) >= 0) {
    throw new Error("ABANDONED eventAt must be before the registered window end.");
  }
  if (evidence.workflowAtImplementationBytes.length === 0 || evidence.workflowAtImplementationBytes !== evidence.workflowAtAbandonmentBytes) {
    throw new Error("Workflow bytes must remain unchanged in the abandonment commit.");
  }
  return evidence;
}
function validateProspectiveShadowClosureStructure(registrationInput, evidenceInput, options = {}) {
  const registration = validateProspectiveShadowRegistration(registrationInput);
  const evidence = validateClosureEvidence(evidenceInput);
  if (options.requireImplementationCheckout !== false) {
    assertEqual(evidence.currentHeadSha, registration.implementationCommitSha, "current HEAD must equal the implementation commit");
  }
  if (!evidence.publicationIsAncestorOfClosureTip) throw new Error("Publication commit must be an ancestor of the closure tip.");
  const canonicalRegistration = serializeProspectiveShadowRegistration(registration);
  if (evidence.registrationAtPublicationBytes !== canonicalRegistration || evidence.registrationAtClosureBytes !== canonicalRegistration) {
    throw new Error("Canonical registration must remain unchanged from publication through closure.");
  }
  if (evidence.workflowAtImplementationBytes.length === 0 || evidence.workflowAtImplementationBytes !== evidence.workflowAtClosureBytes) {
    throw new Error("Workflow bytes must remain unchanged from implementation through closure.");
  }
  const registry = parseProspectiveShadowRegistry(evidence.registryAtClosureBytes);
  assertEqual(registry.registrationPayloadSha256, registration.payloadSha256, "closure registry registration payload");
  validateRelevantPathHistory(registration, evidence, registry.abandoned);
  return registry;
}
function validateContext(value) {
  const record = requireRecord2(value, "Workflow context");
  const mode = requireMode(record.mode);
  if (record.repository !== PROSPECTIVE_SHADOW_REPOSITORY) throw new Error("Workflow repository must be the canonical repository.");
  if (record.branch !== PROSPECTIVE_SHADOW_BRANCH) throw new Error("Workflow branch must be main.");
  const runId = requirePositiveInteger(record.runId, "Workflow run ID");
  const runUrl = requireRunUrl(record.runUrl, runId);
  const implementationCommitSha = requireCommit2(record.implementationCommitSha, "implementationCommitSha");
  const publicationCommitSha = requireCommit2(record.publicationCommitSha, "publicationCommitSha");
  assertDistinctCommits(implementationCommitSha, publicationCommitSha);
  return deepFreeze3({
    mode,
    repository: PROSPECTIVE_SHADOW_REPOSITORY,
    branch: PROSPECTIVE_SHADOW_BRANCH,
    runId,
    runUrl,
    headSha: requireCommit2(record.headSha, "headSha"),
    implementationCommitSha,
    publicationCommitSha,
    registrationPayloadSha256: requireSha2562(record.registrationPayloadSha256, "registrationPayloadSha256")
  });
}
function validateActionsRun(value) {
  const record = requireRecord2(value, "GitHub Actions run");
  const repository = requireRecord2(record.repository, "GitHub Actions repository");
  return deepFreeze3({
    id: requirePositiveInteger(record.id, "GitHub Actions run ID"),
    html_url: requireString2(record.html_url, "GitHub Actions html_url"),
    created_at: requireTimestamp2(record.created_at, "GitHub Actions created_at"),
    head_branch: requireString2(record.head_branch, "GitHub Actions head_branch"),
    head_sha: requireCommit2(record.head_sha, "GitHub Actions head_sha"),
    repository: { full_name: requireString2(repository.full_name, "GitHub Actions repository full_name") }
  });
}
function validateMetadata(value, mode) {
  const record = requireRecord2(value, "Commitment metadata");
  const keys = [
    "schemaVersion",
    "authority",
    "mode",
    "repository",
    "branch",
    "runId",
    "runUrl",
    "serverCreatedAt",
    "implementationCommitSha",
    "publicationCommitSha",
    "headSha",
    "registrationPath",
    "registryPath",
    "workflowPath",
    "registrationPayloadSha256"
  ];
  if (mode === "CLOSURE") keys.push("closureTipSha", "registryClassification", "registrySha256", "relevantPathHistory", "abandonmentMetadata");
  assertExactKeys2(record, keys, "Commitment metadata");
  if (record.schemaVersion !== 1 || record.authority !== PROSPECTIVE_SHADOW_AUTHORITY) throw new Error("Commitment metadata authority is invalid.");
  if (record.mode !== mode) throw new Error(`Commitment metadata mode must be ${mode}.`);
  assertCanonicalMetadataIdentity(record);
  return deepFreeze3(structuredClone(value));
}
function validatePublicationEvidence(value) {
  const record = requireRecord2(value, "Publication Git evidence");
  if (record.mode !== "REGISTERED_PUBLICATION") throw new Error("Publication Git evidence mode is invalid.");
  return deepFreeze3({
    mode: "REGISTERED_PUBLICATION",
    currentHeadSha: requireCommit2(record.currentHeadSha, "currentHeadSha"),
    publicationCommitSha: requireCommit2(record.publicationCommitSha, "publicationCommitSha"),
    publicationParents: requireCommitArray(record.publicationParents, "publicationParents"),
    publicationChangedPaths: requireStringArray(record.publicationChangedPaths, "publicationChangedPaths"),
    registrationAtImplementation: validatePathEvidence(record.registrationAtImplementation, "registrationAtImplementation"),
    registryAtImplementation: validatePathEvidence(record.registryAtImplementation, "registryAtImplementation"),
    registrationBytes: requireString2(record.registrationBytes, "registrationBytes"),
    registryBytes: requireString2(record.registryBytes, "registryBytes"),
    workflowAtImplementationBytes: requireString2(record.workflowAtImplementationBytes, "workflowAtImplementationBytes"),
    workflowAtPublicationBytes: requireString2(record.workflowAtPublicationBytes, "workflowAtPublicationBytes")
  });
}
function validateClosureEvidence(value) {
  const record = requireRecord2(value, "Closure Git evidence");
  if (record.mode !== "CLOSURE") throw new Error("Closure Git evidence mode is invalid.");
  if (typeof record.publicationIsAncestorOfClosureTip !== "boolean") throw new Error("Closure ancestry evidence must be boolean.");
  return deepFreeze3({
    mode: "CLOSURE",
    currentHeadSha: requireCommit2(record.currentHeadSha, "currentHeadSha"),
    publicationCommitSha: requireCommit2(record.publicationCommitSha, "publicationCommitSha"),
    closureTipSha: requireCommit2(record.closureTipSha, "closureTipSha"),
    publicationIsAncestorOfClosureTip: record.publicationIsAncestorOfClosureTip,
    registrationAtPublicationBytes: requireString2(record.registrationAtPublicationBytes, "registrationAtPublicationBytes"),
    registrationAtClosureBytes: requireString2(record.registrationAtClosureBytes, "registrationAtClosureBytes"),
    registryAtClosureBytes: requireString2(record.registryAtClosureBytes, "registryAtClosureBytes"),
    workflowAtImplementationBytes: requireString2(record.workflowAtImplementationBytes, "workflowAtImplementationBytes"),
    workflowAtClosureBytes: requireString2(record.workflowAtClosureBytes, "workflowAtClosureBytes"),
    relevantPathHistory: validateRelevantCommitEvidenceArray(record.relevantPathHistory)
  });
}
function validateAbandonmentEvidence(value) {
  const record = requireRecord2(value, "Abandonment Git evidence");
  if (record.mode !== "ABANDONED") throw new Error("Abandonment Git evidence mode is invalid.");
  return deepFreeze3({
    mode: "ABANDONED",
    currentHeadSha: requireCommit2(record.currentHeadSha, "currentHeadSha"),
    publicationCommitSha: requireCommit2(record.publicationCommitSha, "publicationCommitSha"),
    abandonmentCommitSha: requireCommit2(record.abandonmentCommitSha, "abandonmentCommitSha"),
    publicationIsAncestorOfAbandonment: requireBoolean(record.publicationIsAncestorOfAbandonment, "publicationIsAncestorOfAbandonment"),
    abandonmentParents: requireCommitArray(record.abandonmentParents, "abandonmentParents"),
    abandonmentChangedPaths: requireStringArray(record.abandonmentChangedPaths, "abandonmentChangedPaths"),
    registrationAtPublicationBytes: requireString2(record.registrationAtPublicationBytes, "registrationAtPublicationBytes"),
    registrationAtAbandonmentBytes: requireString2(record.registrationAtAbandonmentBytes, "registrationAtAbandonmentBytes"),
    registryAtPublicationBytes: requireString2(record.registryAtPublicationBytes, "registryAtPublicationBytes"),
    registryAtAbandonmentBytes: requireString2(record.registryAtAbandonmentBytes, "registryAtAbandonmentBytes"),
    workflowAtImplementationBytes: requireString2(record.workflowAtImplementationBytes, "workflowAtImplementationBytes"),
    workflowAtAbandonmentBytes: requireString2(record.workflowAtAbandonmentBytes, "workflowAtAbandonmentBytes")
  });
}
function validatePathEvidence(value, label) {
  const record = requireRecord2(value, label);
  if (record.status === "PRESENT") {
    assertExactKeys2(record, ["status", "bytes"], label);
    return deepFreeze3({ status: "PRESENT", bytes: requireString2(record.bytes, `${label} bytes`) });
  }
  if (record.status === "MISSING") {
    assertExactKeys2(record, ["status", "exitCode", "stderr"], label);
    const exitCode = record.exitCode;
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode <= 0) {
      throw new Error(`${label} missing-path exitCode must be a positive integer.`);
    }
    const stderr = requireString2(record.stderr, `${label} stderr`);
    if (stderr.trim() === "") throw new Error(`${label} missing-path stderr must be non-empty.`);
    return deepFreeze3({ status: "MISSING", exitCode, stderr });
  }
  throw new Error(`${label} status must be PRESENT or MISSING.`);
}
function assertExpectedMissing(value, label) {
  if (value.status !== "MISSING") throw new Error(`${label} must be absent before publication.`);
}
function validateRelevantCommitEvidenceArray(value) {
  if (!Array.isArray(value)) throw new Error("Closure relevant path history must be an array.");
  const result = value.map((item, index) => {
    const record = requireRecord2(item, `Closure relevant path history[${index}]`);
    assertExactKeys2(record, ["commitSha", "parents", "changedPaths", "registration", "registry", "workflowBytes"], `Closure relevant path history[${index}]`);
    return deepFreeze3({
      commitSha: requireCommit2(record.commitSha, `history[${index}].commitSha`),
      parents: requireCommitArray(record.parents, `history[${index}].parents`),
      changedPaths: requireStringArray(record.changedPaths, `history[${index}].changedPaths`),
      registration: validatePathEvidence(record.registration, `history[${index}].registration`),
      registry: validatePathEvidence(record.registry, `history[${index}].registry`),
      workflowBytes: requireString2(record.workflowBytes, `history[${index}].workflowBytes`)
    });
  });
  if (new Set(result.map((item) => item.commitSha)).size !== result.length) {
    throw new Error("Closure relevant path history contains duplicate commits.");
  }
  return deepFreeze3(result);
}
function validateRelevantPathHistory(registration, evidence, abandoned) {
  const history = evidence.relevantPathHistory;
  const expectedLength = abandoned ? 2 : 1;
  if (history.length !== expectedLength) {
    throw new Error("Relevant-path history may contain only the initial publication and one fully validated abandonment.");
  }
  const publication = history[0];
  if (publication === void 0 || publication.commitSha !== evidence.publicationCommitSha) {
    throw new Error("Relevant-path history must begin with the publication commit.");
  }
  if (publication.parents.length !== 1 || publication.parents[0] !== registration.implementationCommitSha) {
    throw new Error("History publication commit must have the implementation commit as its only parent.");
  }
  assertExactPaths(publication.changedPaths, [PROSPECTIVE_SHADOW_REGISTRATION_PATH, PROSPECTIVE_SHADOW_REGISTRY_PATH]);
  const canonicalRegistration = serializeProspectiveShadowRegistration(registration);
  if (publication.registration.status !== "PRESENT" || publication.registration.bytes !== canonicalRegistration) {
    throw new Error("History publication registration bytes are not canonical.");
  }
  if (publication.registry.status !== "PRESENT") throw new Error("History publication registry must be present.");
  const initialRegistry = parseProspectiveShadowRegistry(publication.registry.bytes);
  const registered = initialRegistry.events[0];
  if (initialRegistry.events.length !== 1 || registered?.event !== "REGISTERED" || registered.eventAt !== registration.registeredAt) {
    throw new Error("History publication must contain exactly the canonical REGISTERED event.");
  }
  if (publication.workflowBytes !== evidence.workflowAtImplementationBytes) {
    throw new Error("Workflow bytes changed at publication.");
  }
  const latest = history.at(-1);
  if (latest?.registration.status !== "PRESENT" || latest.registration.bytes !== evidence.registrationAtClosureBytes || latest.registry.status !== "PRESENT" || latest.registry.bytes !== evidence.registryAtClosureBytes) {
    throw new Error("Closure tip path bytes do not match the latest relevant commit evidence.");
  }
  if (latest.workflowBytes !== evidence.workflowAtClosureBytes) throw new Error("Closure workflow evidence does not match history.");
  if (abandoned) {
    const abandonment = history[1];
    if (abandonment === void 0 || abandonment.parents.length !== 1) throw new Error("Abandonment history commit must have exactly one parent.");
    assertExactPaths(abandonment.changedPaths, [PROSPECTIVE_SHADOW_REGISTRY_PATH]);
    if (abandonment.registration.status !== "PRESENT" || abandonment.registration.bytes !== canonicalRegistration) {
      throw new Error("Registration must remain canonical at abandonment.");
    }
    if (abandonment.registry.status !== "PRESENT" || !abandonment.registry.bytes.startsWith(publication.registry.bytes)) {
      throw new Error("Abandonment must append to the publication registry bytes.");
    }
    const registry = parseProspectiveShadowRegistry(abandonment.registry.bytes);
    const event = registry.events[1];
    if (registry.events.length !== 2 || event?.event !== "ABANDONED" || event.publicationCommitSha !== evidence.publicationCommitSha || compareTimestamp(event.eventAt, registration.window.to) >= 0) {
      throw new Error("History abandonment must be the one valid pre-window-end ABANDONED event.");
    }
    if (abandonment.workflowBytes !== evidence.workflowAtImplementationBytes) throw new Error("Workflow bytes changed at abandonment.");
  }
}
function assertCanonicalMetadataIdentity(record) {
  if (record.repository !== PROSPECTIVE_SHADOW_REPOSITORY) throw new Error("Commitment metadata repository is invalid.");
  if (record.branch !== PROSPECTIVE_SHADOW_BRANCH) throw new Error("Commitment metadata branch is invalid.");
  requirePositiveInteger(record.runId, "Commitment metadata runId");
  requireRunUrl(record.runUrl, record.runId);
  requireTimestamp2(record.serverCreatedAt, "Commitment metadata serverCreatedAt");
  requireCommit2(record.implementationCommitSha, "Commitment metadata implementationCommitSha");
  requireCommit2(record.publicationCommitSha, "Commitment metadata publicationCommitSha");
  requireCommit2(record.headSha, "Commitment metadata headSha");
  if (record.registrationPath !== PROSPECTIVE_SHADOW_REGISTRATION_PATH || record.registryPath !== PROSPECTIVE_SHADOW_REGISTRY_PATH || record.workflowPath !== PROSPECTIVE_SHADOW_WORKFLOW_PATH) {
    throw new Error("Commitment metadata canonical paths are invalid.");
  }
  requireSha2562(record.registrationPayloadSha256, "Commitment metadata registrationPayloadSha256");
}
function assertDistinctCommits(implementation, publication) {
  if (implementation === publication) throw new Error("Implementation and publication commits must be distinct.");
}
function assertExactPaths(actual, expected) {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    throw new Error("Publication changed paths must be exactly the canonical registration and registry paths.");
  }
}
function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match.`);
}
function compareTimestamp(left, right) {
  const a = parsePerformanceTimestamp(left);
  const b = parsePerformanceTimestamp(right);
  if (!a || !b) throw new Error("Commitment comparison timestamps must be valid ISO-8601 values.");
  return compareEpochNanoseconds(a.epochNanoseconds, b.epochNanoseconds);
}
function requireTimestamp2(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a timestamp string.`);
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) throw new Error(`${label} must be an exact ISO-8601 timestamp with an explicit timezone.`);
  return parsed.normalized;
}
function requireMode(value) {
  if (value !== "REGISTERED_PUBLICATION" && value !== "ABANDONED" && value !== "CLOSURE") {
    throw new Error("Workflow mode must be REGISTERED_PUBLICATION, ABANDONED, or CLOSURE.");
  }
  return value;
}
function requireRunUrl(value, runId) {
  const expected = `https://github.com/${PROSPECTIVE_SHADOW_REPOSITORY}/actions/runs/${runId}`;
  if (value !== expected) throw new Error("Workflow run URL must identify the exact canonical public Actions run.");
  return expected;
}
function requirePositiveInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}
function requireCommit2(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new Error(`${label} must be a lowercase 40-character commit SHA.`);
  return value;
}
function requireSha2562(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}
function requireString2(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}
function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}
function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array.`);
  return [...value];
}
function requireCommitArray(value, label) {
  return requireStringArray(value, label).map((item) => requireCommit2(item, label));
}
function requireRecord2(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}
function assertExactKeys2(record, expected, label) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys do not match the frozen contract.`);
  }
}
function deepFreeze3(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze3(nested);
    Object.freeze(value);
  }
  return value;
}

// src/research/prospective-shadow-git-commitment-reader.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var COMMIT = /^[a-f0-9]{40}$/;
var SAFE_TOKEN = /^[a-zA-Z0-9._:/=+%^~-]+$/;
var CANONICAL_PATHS = /* @__PURE__ */ new Set([
  PROSPECTIVE_SHADOW_REGISTRATION_PATH,
  PROSPECTIVE_SHADOW_REGISTRY_PATH,
  PROSPECTIVE_SHADOW_WORKFLOW_PATH
]);
function createReadOnlyGitRunner(cwd, executor = defaultExecutor) {
  if (typeof cwd !== "string" || cwd.trim() === "") throw new Error("Read-only Git working directory must be non-empty.");
  return {
    async run(args) {
      assertReadOnlyGitArgs(args);
      const result = await executor(cwd, [...args]);
      return Object.freeze({
        exitCode: requireExitCode(result.exitCode),
        stdout: String(result.stdout),
        stderr: String(result.stderr)
      });
    }
  };
}
async function readProspectiveShadowGitEvidence(input, runner) {
  const implementation = requireCommit3(input.implementationCommitSha, "implementationCommitSha");
  const publication = requireCommit3(input.publicationCommitSha, "publicationCommitSha");
  const currentHeadSha = trimLine(await runRequired(runner, ["rev-parse", "HEAD"]));
  if (input.mode === "REGISTERED_PUBLICATION") {
    const parents = splitWhitespace(await runRequired(runner, ["show", "--no-patch", "--format=%P", publication]));
    const changedPaths = splitLines(await runRequired(runner, ["diff-tree", "--no-commit-id", "--name-only", "-r", publication]));
    const registrationBytes = await runRequired(runner, ["show", `${publication}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]);
    const registryBytes = await runRequired(runner, ["show", `${publication}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`]);
    const workflowAtImplementationBytes = await runRequired(runner, ["show", `${implementation}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]);
    const workflowAtPublicationBytes = await runRequired(runner, ["show", `${publication}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]);
    return deepFreeze4({
      mode: "REGISTERED_PUBLICATION",
      currentHeadSha,
      publicationCommitSha: publication,
      publicationParents: parents,
      publicationChangedPaths: changedPaths,
      registrationAtImplementation: await readPathEvidence(runner, implementation, PROSPECTIVE_SHADOW_REGISTRATION_PATH),
      registryAtImplementation: await readPathEvidence(runner, implementation, PROSPECTIVE_SHADOW_REGISTRY_PATH),
      registrationBytes,
      registryBytes,
      workflowAtImplementationBytes,
      workflowAtPublicationBytes
    });
  }
  if (input.mode === "ABANDONED") {
    const abandonment = requireCommit3(input.abandonmentCommitSha, "abandonmentCommitSha");
    const ancestry2 = await runner.run(["merge-base", "--is-ancestor", publication, abandonment]);
    if (ancestry2.exitCode !== 0 && ancestry2.exitCode !== 1) throw gitError(["merge-base", "--is-ancestor", publication, abandonment], ancestry2);
    const parents = splitWhitespace(await runRequired(runner, ["show", "--no-patch", "--format=%P", abandonment]));
    const changedPaths = splitLines(await runRequired(runner, ["diff-tree", "--no-commit-id", "--name-only", "-r", abandonment]));
    return deepFreeze4({
      mode: "ABANDONED",
      currentHeadSha,
      publicationCommitSha: publication,
      abandonmentCommitSha: abandonment,
      publicationIsAncestorOfAbandonment: ancestry2.exitCode === 0,
      abandonmentParents: parents,
      abandonmentChangedPaths: changedPaths,
      registrationAtPublicationBytes: await runRequired(runner, ["show", `${publication}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]),
      registrationAtAbandonmentBytes: await runRequired(runner, ["show", `${abandonment}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]),
      registryAtPublicationBytes: await runRequired(runner, ["show", `${publication}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`]),
      registryAtAbandonmentBytes: await runRequired(runner, ["show", `${abandonment}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`]),
      workflowAtImplementationBytes: await runRequired(runner, ["show", `${implementation}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]),
      workflowAtAbandonmentBytes: await runRequired(runner, ["show", `${abandonment}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`])
    });
  }
  const closureTip = requireCommit3(input.closureTipSha, "closureTipSha");
  const ancestry = await runner.run(["merge-base", "--is-ancestor", publication, closureTip]);
  if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1) throw gitError(["merge-base", "--is-ancestor", publication, closureTip], ancestry);
  const historyBytes = await runRequired(runner, [
    "log",
    "--reverse",
    "--format=%H",
    `${publication}^..${closureTip}`,
    "--",
    PROSPECTIVE_SHADOW_REGISTRATION_PATH,
    PROSPECTIVE_SHADOW_REGISTRY_PATH
  ]);
  const historyCommits = splitLines(historyBytes).map((commit) => requireCommit3(commit, "relevantPathHistory commit"));
  const relevantPathHistory = [];
  for (const commitSha of historyCommits) {
    relevantPathHistory.push(deepFreeze4({
      commitSha,
      parents: splitWhitespace(await runRequired(runner, ["show", "--no-patch", "--format=%P", commitSha])),
      changedPaths: splitLines(await runRequired(runner, ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha])),
      registration: await readPathEvidence(runner, commitSha, PROSPECTIVE_SHADOW_REGISTRATION_PATH),
      registry: await readPathEvidence(runner, commitSha, PROSPECTIVE_SHADOW_REGISTRY_PATH),
      workflowBytes: await runRequired(runner, ["show", `${commitSha}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`])
    }));
  }
  return deepFreeze4({
    mode: "CLOSURE",
    currentHeadSha,
    publicationCommitSha: publication,
    closureTipSha: closureTip,
    publicationIsAncestorOfClosureTip: ancestry.exitCode === 0,
    registrationAtPublicationBytes: await runRequired(runner, ["show", `${publication}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]),
    registrationAtClosureBytes: await runRequired(runner, ["show", `${closureTip}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]),
    registryAtClosureBytes: await runRequired(runner, ["show", `${closureTip}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`]),
    workflowAtImplementationBytes: await runRequired(runner, ["show", `${implementation}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]),
    workflowAtClosureBytes: await runRequired(runner, ["show", `${closureTip}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]),
    relevantPathHistory
  });
}
async function readPathEvidence(runner, commitSha, filePath) {
  const args = ["show", `${commitSha}:${filePath}`];
  const result = await runner.run(args);
  if (result.exitCode === 0) return deepFreeze4({ status: "PRESENT", bytes: String(result.stdout) });
  if (result.stdout !== "") throw new Error(`Read-only git show returned bytes while reporting failure for ${filePath}.`);
  const stderr = result.stderr.trim();
  if (stderr === "") throw gitError(args, result);
  return deepFreeze4({ status: "MISSING", exitCode: result.exitCode, stderr });
}
function assertReadOnlyGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== "string" || !SAFE_TOKEN.test(arg))) {
    throw new Error("Git arguments contain a forbidden token outside the read-only allowlist.");
  }
  const [command, ...rest] = args;
  const allowed = command === "rev-parse" && rest.length === 1 && rest[0] === "HEAD" || command === "show" && isAllowedShow(rest) || command === "diff-tree" && isAllowedDiffTree(rest) || command === "merge-base" && rest.length === 3 && rest[0] === "--is-ancestor" && isCommit(rest[1]) && isCommit(rest[2]) || command === "log" && isAllowedLog(rest);
  if (!allowed) throw new Error("Git command is outside the prospective read-only allowlist.");
}
function isAllowedShow(args) {
  if (args.length === 3 && args[0] === "--no-patch" && args[1] === "--format=%P") return isCommit(args[2]);
  if (args.length !== 1) return false;
  const token = args[0];
  if (token === void 0) return false;
  const separator = token.indexOf(":");
  if (separator < 0) return false;
  return isCommit(token.slice(0, separator)) && CANONICAL_PATHS.has(token.slice(separator + 1));
}
function isAllowedDiffTree(args) {
  return args.length === 4 && args[0] === "--no-commit-id" && args[1] === "--name-only" && args[2] === "-r" && isCommit(args[3]);
}
function isAllowedLog(args) {
  return args.length === 6 && args[0] === "--reverse" && args[1] === "--format=%H" && /^[a-f0-9]{40}\^\.\.[a-f0-9]{40}$/.test(args[2] ?? "") && args[3] === "--" && args[4] === PROSPECTIVE_SHADOW_REGISTRATION_PATH && args[5] === PROSPECTIVE_SHADOW_REGISTRY_PATH;
}
async function runRequired(runner, args) {
  const result = await runner.run(args);
  if (result.exitCode !== 0) throw gitError(args, result);
  return String(result.stdout);
}
function gitError(args, result) {
  const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
  return new Error(`Read-only git ${args[0] ?? "command"} failed: ${detail}`);
}
function splitLines(value) {
  const trimmed = value.trim();
  return trimmed === "" ? [] : trimmed.split(/\r?\n/);
}
function splitWhitespace(value) {
  const trimmed = value.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}
function trimLine(value) {
  const lines = splitLines(value);
  if (lines.length !== 1) throw new Error("Read-only Git command must return exactly one line.");
  return lines[0] ?? "";
}
function requireCommit3(value, label) {
  if (!isCommit(value)) throw new Error(`${label} must be a lowercase 40-character Git commit SHA.`);
  return value;
}
function isCommit(value) {
  return value !== void 0 && COMMIT.test(value);
}
function requireExitCode(value) {
  if (!Number.isInteger(value) || value < 0) throw new Error("Git executor exit code is invalid.");
  return value;
}
async function defaultExecutor(cwd, args) {
  try {
    const result = await execFileAsync("git", [...args], { cwd, encoding: "utf8", windowsHide: true });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const candidate = error;
    return {
      exitCode: typeof candidate.code === "number" ? candidate.code : 1,
      stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
      stderr: typeof candidate.stderr === "string" ? candidate.stderr : String(candidate.message ?? error)
    };
  }
}
function deepFreeze4(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze4(nested);
    Object.freeze(value);
  }
  return value;
}

// src/research/prospective-shadow-commitment.ts
var ARGUMENT_KEYS = [
  "mode",
  "github-run-json",
  "output",
  "repository",
  "branch",
  "run-id",
  "run-url",
  "head-sha",
  "implementation-commit-sha",
  "publication-commit-sha",
  "abandonment-metadata"
];
var ARGUMENT_SET = new Set(ARGUMENT_KEYS);
function parseProspectiveShadowCommitmentArgs(argv) {
  const values = /* @__PURE__ */ new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === void 0 || !token.startsWith("--")) throw new Error(`Unexpected argument ${token ?? "<missing>"}.`);
    const key = token.slice(2);
    if (!ARGUMENT_SET.has(key)) throw new Error(`Unknown argument --${key}.`);
    const typedKey = key;
    if (values.has(typedKey)) throw new Error(`Duplicate argument --${key}.`);
    const value = argv[index + 1];
    if (value === void 0 || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    values.set(typedKey, value);
    index += 1;
  }
  const mode = requireMode2(requireArgument(values, "mode"));
  return {
    mode,
    githubRunJsonPath: requireNonEmpty(requireArgument(values, "github-run-json"), "--github-run-json"),
    outputPath: requireNonEmpty(requireArgument(values, "output"), "--output"),
    repository: requireArgument(values, "repository"),
    branch: requireArgument(values, "branch"),
    runId: requireRunId(requireArgument(values, "run-id")),
    runUrl: requireArgument(values, "run-url"),
    headSha: requireCommit4(requireArgument(values, "head-sha"), "--head-sha"),
    implementationCommitSha: requireCommit4(requireArgument(values, "implementation-commit-sha"), "--implementation-commit-sha"),
    publicationCommitSha: requireCommit4(requireArgument(values, "publication-commit-sha"), "--publication-commit-sha"),
    ...values.has("abandonment-metadata") ? { abandonmentMetadataPath: requireNonEmpty(values.get("abandonment-metadata") ?? "", "--abandonment-metadata") } : {}
  };
}
function buildProspectiveShadowWorkflowMetadata(input) {
  let parsed;
  try {
    parsed = JSON.parse(input.actionsRunJson);
  } catch {
    throw new Error("GitHub Actions own-run response must be valid JSON.");
  }
  return validateProspectiveShadowWorkflowMetadata({
    context: input.context,
    actionsRun: parsed
  });
}
async function runProspectiveShadowCommitmentCli(options, dependencies) {
  const registrationBytes = await dependencies.readTextFile(path.join(dependencies.cwd, PROSPECTIVE_SHADOW_REGISTRATION_PATH));
  let registrationJson;
  try {
    registrationJson = JSON.parse(registrationBytes);
  } catch {
    throw new Error("Canonical prospective registration must be valid JSON.");
  }
  const registration = validateProspectiveShadowRegistration(registrationJson);
  const actionsRunJson = await dependencies.readTextFile(options.githubRunJsonPath);
  const context = {
    mode: options.mode,
    repository: options.repository,
    branch: options.branch,
    runId: options.runId,
    runUrl: options.runUrl,
    headSha: options.headSha,
    implementationCommitSha: options.implementationCommitSha,
    publicationCommitSha: options.publicationCommitSha,
    registrationPayloadSha256: registration.payloadSha256
  };
  const metadata = buildProspectiveShadowWorkflowMetadata({ context, actionsRunJson });
  let output;
  if (options.mode === "REGISTERED_PUBLICATION") {
    const evidence = await readProspectiveShadowGitEvidence({
      mode: "REGISTERED_PUBLICATION",
      implementationCommitSha: options.implementationCommitSha,
      publicationCommitSha: options.publicationCommitSha
    }, dependencies.gitRunner);
    if (evidence.mode !== "REGISTERED_PUBLICATION") throw new Error("Unexpected Git evidence mode.");
    if (evidence.currentHeadSha !== options.headSha) throw new Error("Workflow checkout HEAD must match GitHub head SHA.");
    validateProspectiveShadowPublicationStructure(registration, evidence, { requireImplementationCheckout: false });
    assertMinimumPublicLead(metadata.serverCreatedAt, registration.window.from);
    output = deepFreeze5({ ...metadata, mode: "REGISTERED_PUBLICATION" });
  } else if (options.mode === "ABANDONED") {
    const evidence = await readProspectiveShadowGitEvidence({
      mode: "ABANDONED",
      implementationCommitSha: options.implementationCommitSha,
      publicationCommitSha: options.publicationCommitSha,
      abandonmentCommitSha: options.headSha
    }, dependencies.gitRunner);
    if (evidence.mode !== "ABANDONED") throw new Error("Unexpected Git evidence mode.");
    if (evidence.currentHeadSha !== options.headSha) throw new Error("Workflow checkout HEAD must match GitHub head SHA.");
    validateProspectiveShadowAbandonmentStructure(registration, evidence, { requireImplementationCheckout: false });
    assertTimestampOrder(metadata.serverCreatedAt, registration.window.to, "BEFORE");
    const registry = parseProspectiveShadowRegistry(evidence.registryAtAbandonmentBytes);
    const abandoned = registry.events[1];
    if (abandoned?.event !== "ABANDONED" || abandoned.publicationCommitSha !== options.publicationCommitSha) {
      throw new Error("ABANDONED registry event must bind the original publication commit.");
    }
    output = deepFreeze5({
      ...metadata,
      mode: "ABANDONED",
      abandonmentCommitSha: evidence.abandonmentCommitSha,
      registrySha256: sha256Bytes(evidence.registryAtAbandonmentBytes)
    });
  } else {
    const evidence = await readProspectiveShadowGitEvidence({
      mode: "CLOSURE",
      implementationCommitSha: options.implementationCommitSha,
      publicationCommitSha: options.publicationCommitSha,
      closureTipSha: options.headSha
    }, dependencies.gitRunner);
    if (evidence.mode !== "CLOSURE") throw new Error("Unexpected Git evidence mode.");
    if (evidence.currentHeadSha !== options.headSha) throw new Error("Workflow checkout HEAD must match GitHub head SHA.");
    const registry = validateProspectiveShadowClosureStructure(registration, evidence, { requireImplementationCheckout: false });
    assertTimestampOrder(metadata.serverCreatedAt, registration.window.to, "AT_OR_AFTER");
    const registrySha256 = sha256Bytes(evidence.registryAtClosureBytes);
    let abandonmentMetadata = null;
    if (registry.abandoned) {
      if (options.abandonmentMetadataPath === void 0) {
        throw new Error("Abandoned closure requires --abandonment-metadata with the prior ABANDONED workflow output path.");
      }
      abandonmentMetadata = await readAndValidateAbandonmentMetadata({
        filePath: options.abandonmentMetadataPath,
        readTextFile: dependencies.readTextFile,
        registrationPayloadSha256: registration.payloadSha256,
        implementationCommitSha: options.implementationCommitSha,
        publicationCommitSha: options.publicationCommitSha,
        latestRelevantCommitSha: evidence.relevantPathHistory.at(-1)?.commitSha,
        registrySha256,
        windowTo: registration.window.to
      });
    } else if (options.abandonmentMetadataPath !== void 0) {
      throw new Error("Active closure must not provide --abandonment-metadata.");
    }
    output = deepFreeze5({
      ...metadata,
      mode: "CLOSURE",
      closureTipSha: evidence.closureTipSha,
      registryClassification: registry.abandoned ? "ABANDONED" : "ACTIVE_AT_CLOSE",
      registrySha256,
      relevantPathHistory: [...evidence.relevantPathHistory],
      abandonmentMetadata
    });
  }
  await dependencies.writeOutput(options.outputPath, `${JSON.stringify(output, null, 2)}
`);
  return output;
}
async function readAndValidateAbandonmentMetadata(input) {
  let parsed;
  try {
    parsed = JSON.parse(await input.readTextFile(input.filePath));
  } catch {
    throw new Error("Prior abandonment workflow metadata must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Prior abandonment workflow metadata must be an object.");
  }
  const record = structuredClone(parsed);
  const abandonmentCommitSha = requireCommit4(String(record.abandonmentCommitSha ?? ""), "abandonmentCommitSha");
  const registrySha256 = requireSha2563(String(record.registrySha256 ?? ""), "registrySha256");
  delete record.abandonmentCommitSha;
  delete record.registrySha256;
  const metadata = validateProspectiveShadowPersistedWorkflowMetadata(
    record,
    "ABANDONED"
  );
  if (abandonmentCommitSha !== metadata.headSha || abandonmentCommitSha !== input.latestRelevantCommitSha) {
    throw new Error("Prior abandonment commit must match its head SHA and the latest relevant Git commit.");
  }
  if (registrySha256 !== input.registrySha256) throw new Error("Prior abandonment registry SHA-256 does not match closure registry bytes.");
  if (metadata.registrationPayloadSha256 !== input.registrationPayloadSha256 || metadata.implementationCommitSha !== input.implementationCommitSha || metadata.publicationCommitSha !== input.publicationCommitSha) {
    throw new Error("Prior abandonment workflow metadata does not match the closure identity.");
  }
  assertTimestampOrder(metadata.serverCreatedAt, input.windowTo, "BEFORE");
  return metadata;
}
function createDefaultDependencies(cwd) {
  return {
    cwd,
    readTextFile: (filePath) => readFile(filePath, "utf8"),
    writeOutput: (filePath, bytes) => writeFile(filePath, bytes, { encoding: "utf8", flag: "wx" }),
    gitRunner: createReadOnlyGitRunner(cwd)
  };
}
async function main() {
  const options = parseProspectiveShadowCommitmentArgs(process.argv.slice(2));
  const output = await runProspectiveShadowCommitmentCli(options, createDefaultDependencies(process.cwd()));
  console.log(JSON.stringify(output, null, 2));
}
function requireArgument(values, key) {
  const value = values.get(key);
  if (value === void 0) throw new Error(`Missing required argument --${key}.`);
  return value;
}
function requireMode2(value) {
  if (value !== "REGISTERED_PUBLICATION" && value !== "ABANDONED" && value !== "CLOSURE") {
    throw new Error("--mode must be REGISTERED_PUBLICATION, ABANDONED, or CLOSURE.");
  }
  return value;
}
function requireNonEmpty(value, label) {
  if (value.trim() === "") throw new Error(`${label} must be non-empty.`);
  return value;
}
function requireRunId(value) {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("--run-id must be a positive safe integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("--run-id must be a positive safe integer.");
  return parsed;
}
function requireCommit4(value, label) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(`${label} must be a lowercase 40-character Git commit SHA.`);
  return value;
}
function requireSha2563(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}
function assertTimestampOrder(actual, boundary, relation) {
  const a = parsePerformanceTimestamp(actual);
  const b = parsePerformanceTimestamp(boundary);
  if (!a || !b) throw new Error("Commitment timing values are invalid.");
  const comparison = compareEpochNanoseconds(a.epochNanoseconds, b.epochNanoseconds);
  if (relation === "BEFORE" && comparison >= 0) throw new Error("Workflow server-created run must be before the registered boundary.");
  if (relation === "AT_OR_AFTER" && comparison < 0) throw new Error("Closure workflow run must be at or after the registered window end.");
}
function assertMinimumPublicLead(actual, boundary) {
  const actualTimestamp = parsePerformanceTimestamp(actual);
  const boundaryTimestamp = parsePerformanceTimestamp(boundary);
  if (!actualTimestamp || !boundaryTimestamp) {
    throw new Error("Workflow commitment timestamps must be valid ISO-8601 values.");
  }
  const leadNanoseconds = boundaryTimestamp.epochNanoseconds - actualTimestamp.epochNanoseconds;
  if (leadNanoseconds < BigInt(PROSPECTIVE_SHADOW_MIN_PUBLICATION_LEAD_MS) * 1000000n) {
    throw new Error("Publication workflow requires at least 48 hours of public lead time.");
  }
}
function sha256Bytes(value) {
  return createHash2("sha256").update(value, "utf8").digest("hex");
}
function deepFreeze5(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze5(nested);
    Object.freeze(value);
  }
  return value;
}
function isMainModule() {
  const entryPath = process.argv[1];
  return entryPath !== void 0 && import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
}
if (isMainModule()) {
  main().catch((error) => {
    console.error(`Prospective shadow commitment validation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
export {
  buildProspectiveShadowWorkflowMetadata,
  parseProspectiveShadowCommitmentArgs,
  runProspectiveShadowCommitmentCli
};
