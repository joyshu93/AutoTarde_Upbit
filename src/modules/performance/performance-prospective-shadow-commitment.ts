import { createHash } from "node:crypto";

import {
  PROSPECTIVE_SHADOW_AUTHORITY,
  PROSPECTIVE_SHADOW_MIN_PUBLICATION_LEAD_MS,
  parseProspectiveShadowRegistry,
  serializeProspectiveShadowRegistration,
  validateProspectiveShadowRegistration,
  type ProspectiveShadowRegistration,
} from "./performance-prospective-shadow-registration.js";
import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
} from "./performance-timestamp.js";

export const PROSPECTIVE_SHADOW_REPOSITORY = "joyshu93/AutoTarde_Upbit" as const;
export const PROSPECTIVE_SHADOW_BRANCH = "main" as const;
export const PROSPECTIVE_SHADOW_REGISTRATION_PATH =
  "docs/research/prospective-shadow/PCS-2026-001.registration.json" as const;
export const PROSPECTIVE_SHADOW_REGISTRY_PATH =
  "docs/research/prospective-shadow/registry.jsonl" as const;
export const PROSPECTIVE_SHADOW_WORKFLOW_PATH =
  ".github/workflows/prospective-shadow-registration.yml" as const;
export const PROSPECTIVE_SHADOW_INITIAL_CONFIRMATION =
  "I_VERIFIED_PUBLIC_GITHUB_COMMITMENT" as const;
export const PROSPECTIVE_SHADOW_CLOSURE_CONFIRMATION =
  "I_VERIFIED_PUBLIC_GITHUB_REGISTRY_CLOSURE" as const;
export const PROSPECTIVE_SHADOW_ASSURANCE =
  "HUMAN_VERIFIED_PUBLIC_GITHUB_RUN" as const;

export type ProspectiveShadowWorkflowMode =
  | "REGISTERED_PUBLICATION"
  | "ABANDONED"
  | "CLOSURE";

export type ProspectiveShadowActionsRun = Readonly<{
  id: number;
  html_url: string;
  created_at: string;
  head_branch: string;
  head_sha: string;
  repository: Readonly<{ full_name: string }>;
}>;

export type ProspectiveShadowWorkflowContext = Readonly<{
  mode: ProspectiveShadowWorkflowMode;
  repository: string;
  branch: string;
  runId: number;
  runUrl: string;
  headSha: string;
  implementationCommitSha: string;
  publicationCommitSha: string;
  registrationPayloadSha256: string;
}>;

export type ProspectiveShadowWorkflowMetadata = Readonly<{
  schemaVersion: 1;
  authority: typeof PROSPECTIVE_SHADOW_AUTHORITY;
  mode: ProspectiveShadowWorkflowMode;
  repository: typeof PROSPECTIVE_SHADOW_REPOSITORY;
  branch: typeof PROSPECTIVE_SHADOW_BRANCH;
  runId: number;
  runUrl: string;
  serverCreatedAt: string;
  implementationCommitSha: string;
  publicationCommitSha: string;
  headSha: string;
  registrationPath: typeof PROSPECTIVE_SHADOW_REGISTRATION_PATH;
  registryPath: typeof PROSPECTIVE_SHADOW_REGISTRY_PATH;
  workflowPath: typeof PROSPECTIVE_SHADOW_WORKFLOW_PATH;
  registrationPayloadSha256: string;
}>;

export type ProspectiveShadowPublicationGitEvidence = Readonly<{
  mode: "REGISTERED_PUBLICATION";
  currentHeadSha: string;
  publicationCommitSha: string;
  publicationParents: readonly string[];
  publicationChangedPaths: readonly string[];
  registrationAtImplementation: ProspectiveShadowGitPathEvidence;
  registryAtImplementation: ProspectiveShadowGitPathEvidence;
  registrationBytes: string;
  registryBytes: string;
  workflowAtImplementationBytes: string;
  workflowAtPublicationBytes: string;
}>;

export type ProspectiveShadowGitPathEvidence =
  | Readonly<{ status: "PRESENT"; bytes: string }>
  | Readonly<{ status: "MISSING"; exitCode: number; stderr: string }>;

export type ProspectiveShadowRelevantPathCommitEvidence = Readonly<{
  commitSha: string;
  parents: readonly string[];
  changedPaths: readonly string[];
  registration: ProspectiveShadowGitPathEvidence;
  registry: ProspectiveShadowGitPathEvidence;
  workflowBytes: string;
}>;

export type ProspectiveShadowInitialManualVerification = Readonly<{
  confirmation: typeof PROSPECTIVE_SHADOW_INITIAL_CONFIRMATION;
  verifiedAt: string;
  runUrl: string;
  repository: string;
  branch: string;
  runId: number;
  implementationCommitSha: string;
  publicationCommitSha: string;
  registrationPath: string;
  registrationPayloadSha256: string;
}>;

export interface ValidateProspectiveShadowCommitmentInput {
  readonly registration: ProspectiveShadowRegistration;
  readonly metadata: ProspectiveShadowWorkflowMetadata;
  readonly manualVerification: ProspectiveShadowInitialManualVerification;
  readonly gitEvidence: ProspectiveShadowPublicationGitEvidence;
}

export type ValidatedProspectiveShadowCommitment = Readonly<{
  assurance: typeof PROSPECTIVE_SHADOW_ASSURANCE;
  cryptographicallyVerified: false;
  implementationCommitSha: string;
  publicationCommitSha: string;
  metadata: ProspectiveShadowWorkflowMetadata;
  manualVerifiedAt: string;
}>;

export type ProspectiveShadowClosureMetadata = ProspectiveShadowWorkflowMetadata & Readonly<{
  mode: "CLOSURE";
  closureTipSha: string;
  registryClassification: "ACTIVE_AT_CLOSE" | "ABANDONED";
  registrySha256: string;
  relevantPathHistory: readonly ProspectiveShadowRelevantPathCommitEvidence[];
  abandonmentMetadata: ProspectiveShadowWorkflowMetadata | null;
}>;

export type ProspectiveShadowClosureGitEvidence = Readonly<{
  mode: "CLOSURE";
  currentHeadSha: string;
  publicationCommitSha: string;
  closureTipSha: string;
  publicationIsAncestorOfClosureTip: boolean;
  registrationAtPublicationBytes: string;
  registrationAtClosureBytes: string;
  registryAtClosureBytes: string;
  workflowAtImplementationBytes: string;
  workflowAtClosureBytes: string;
  relevantPathHistory: readonly ProspectiveShadowRelevantPathCommitEvidence[];
}>;

export type ProspectiveShadowAbandonmentGitEvidence = Readonly<{
  mode: "ABANDONED";
  currentHeadSha: string;
  publicationCommitSha: string;
  abandonmentCommitSha: string;
  publicationIsAncestorOfAbandonment: boolean;
  abandonmentParents: readonly string[];
  abandonmentChangedPaths: readonly string[];
  registrationAtPublicationBytes: string;
  registrationAtAbandonmentBytes: string;
  registryAtPublicationBytes: string;
  registryAtAbandonmentBytes: string;
  workflowAtImplementationBytes: string;
  workflowAtAbandonmentBytes: string;
}>;

export type ProspectiveShadowClosureManualVerification = Readonly<{
  confirmation: typeof PROSPECTIVE_SHADOW_CLOSURE_CONFIRMATION;
  verifiedAt: string;
  runUrl: string;
  repository: string;
  branch: string;
  runId: number;
  implementationCommitSha: string;
  publicationCommitSha: string;
  closureTipSha: string;
  registrySha256: string;
  latestRelevantPathCommitSha: string;
  noLaterRelevantPathCommit: true;
}>;

export interface ValidateProspectiveShadowClosureCommitmentInput {
  readonly registration: ProspectiveShadowRegistration;
  readonly initialCommitmentInput: ValidateProspectiveShadowCommitmentInput;
  readonly metadata: ProspectiveShadowClosureMetadata;
  readonly manualVerification: ProspectiveShadowClosureManualVerification;
  readonly gitEvidence: ProspectiveShadowClosureGitEvidence;
}

export type ValidatedProspectiveShadowClosureCommitment = Readonly<{
  assurance: typeof PROSPECTIVE_SHADOW_ASSURANCE;
  cryptographicallyVerified: false;
  registryClassification: "ACTIVE_AT_CLOSE" | "ABANDONED";
  closureTipSha: string;
  metadata: ProspectiveShadowClosureMetadata;
  manualVerifiedAt: string;
}>;

export function validateProspectiveShadowWorkflowMetadata(input: {
  readonly context: ProspectiveShadowWorkflowContext;
  readonly actionsRun: ProspectiveShadowActionsRun;
}): ProspectiveShadowWorkflowMetadata {
  const context = validateContext(input.context);
  const run = validateActionsRun(input.actionsRun);
  if (run.id !== context.runId) throw new Error("GitHub Actions run ID does not match the exact workflow run.");
  if (run.html_url !== context.runUrl) throw new Error("GitHub Actions run URL does not match the exact workflow run.");
  if (run.repository.full_name !== context.repository) throw new Error("GitHub Actions repository identity does not match.");
  if (run.head_branch !== context.branch) throw new Error("GitHub Actions branch identity does not match.");
  if (run.head_sha !== context.headSha) throw new Error("GitHub Actions head SHA identity does not match.");
  return deepFreeze({
    schemaVersion: 1,
    authority: PROSPECTIVE_SHADOW_AUTHORITY,
    mode: context.mode,
    repository: PROSPECTIVE_SHADOW_REPOSITORY,
    branch: PROSPECTIVE_SHADOW_BRANCH,
    runId: context.runId,
    runUrl: context.runUrl,
    serverCreatedAt: requireTimestamp(run.created_at, "GitHub Actions server created_at"),
    implementationCommitSha: context.implementationCommitSha,
    publicationCommitSha: context.publicationCommitSha,
    headSha: context.headSha,
    registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH,
    registryPath: PROSPECTIVE_SHADOW_REGISTRY_PATH,
    workflowPath: PROSPECTIVE_SHADOW_WORKFLOW_PATH,
    registrationPayloadSha256: context.registrationPayloadSha256,
  });
}

export function validateProspectiveShadowPersistedWorkflowMetadata(
  value: ProspectiveShadowWorkflowMetadata,
  mode: ProspectiveShadowWorkflowMode,
): ProspectiveShadowWorkflowMetadata {
  return validateMetadata(value, mode);
}

export function validateProspectiveShadowCommitment(
  input: ValidateProspectiveShadowCommitmentInput,
): ValidatedProspectiveShadowCommitment {
  const registration = validateProspectiveShadowRegistration(input.registration);
  const metadata = validateMetadata(input.metadata, "REGISTERED_PUBLICATION");
  const evidence = validatePublicationEvidence(input.gitEvidence);
  const manual = validateInitialManualVerification(input.manualVerification);

  assertDistinctCommits(registration.implementationCommitSha, metadata.publicationCommitSha);
  assertEqual(metadata.implementationCommitSha, registration.implementationCommitSha, "metadata implementation commit");
  assertEqual(metadata.registrationPayloadSha256, registration.payloadSha256, "metadata registration payload");
  assertEqual(metadata.headSha, metadata.publicationCommitSha, "metadata head SHA");
  assertMinimumLead(
    metadata.serverCreatedAt,
    registration.window.from,
    PROSPECTIVE_SHADOW_MIN_PUBLICATION_LEAD_MS,
    "GitHub Actions publication must have at least 48 hours of public lead time",
  );

  validateProspectiveShadowPublicationStructure(registration, evidence);
  assertEqual(evidence.publicationCommitSha, metadata.publicationCommitSha, "Git evidence publication commit");

  assertManualIdentity(manual, metadata);
  assertAtOrAfter(manual.verifiedAt, metadata.serverCreatedAt, "Manual verifiedAt must be at or after the GitHub Actions run");
  return deepFreeze({
    assurance: PROSPECTIVE_SHADOW_ASSURANCE,
    cryptographicallyVerified: false,
    implementationCommitSha: registration.implementationCommitSha,
    publicationCommitSha: metadata.publicationCommitSha,
    metadata,
    manualVerifiedAt: manual.verifiedAt,
  });
}

export function validateProspectiveShadowPublicationStructure(
  registrationInput: ProspectiveShadowRegistration,
  evidenceInput: ProspectiveShadowPublicationGitEvidence,
  options: Readonly<{ requireImplementationCheckout?: boolean }> = {},
): ProspectiveShadowPublicationGitEvidence {
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

export function validateProspectiveShadowClosureCommitment(
  input: ValidateProspectiveShadowClosureCommitmentInput,
): ValidatedProspectiveShadowClosureCommitment {
  const registration = validateProspectiveShadowRegistration(input.registration);
  const initial = validateProspectiveShadowCommitment(input.initialCommitmentInput);
  const metadata = validateClosureMetadata(input.metadata);
  const evidence = validateClosureEvidence(input.gitEvidence);
  const manual = validateClosureManualVerification(input.manualVerification);

  assertEqual(initial.implementationCommitSha, registration.implementationCommitSha, "initial commitment implementation commit");
  assertEqual(initial.publicationCommitSha, metadata.publicationCommitSha, "initial commitment publication commit");
  assertAtOrAfter(metadata.serverCreatedAt, registration.window.to, "Closure run must be at or after the registered window end");
  assertEqual(metadata.implementationCommitSha, registration.implementationCommitSha, "closure metadata implementation commit");
  assertEqual(metadata.registrationPayloadSha256, registration.payloadSha256, "closure metadata registration payload");
  assertEqual(metadata.headSha, metadata.closureTipSha, "closure metadata head SHA");

  const registry = validateProspectiveShadowClosureStructure(registration, evidence);
  assertEqual(evidence.publicationCommitSha, metadata.publicationCommitSha, "closure Git evidence publication commit");
  assertEqual(evidence.closureTipSha, metadata.closureTipSha, "closure Git evidence tip");
  const expectedClassification = registry.abandoned ? "ABANDONED" : "ACTIVE_AT_CLOSE";
  assertEqual(metadata.registryClassification, expectedClassification, "closure registry classification");
  if (expectedClassification === "ACTIVE_AT_CLOSE" && metadata.abandonmentMetadata !== null) {
    throw new Error("Active closure must not include abandonment metadata.");
  }
  if (expectedClassification === "ABANDONED") {
    const abandonmentMetadata = metadata.abandonmentMetadata;
    if (abandonmentMetadata === null) throw new Error("Abandoned closure requires validated abandonment metadata.");
    assertBefore(abandonmentMetadata.serverCreatedAt, registration.window.to, "Abandonment workflow run must be before the registered window end");
    assertEqual(abandonmentMetadata.implementationCommitSha, registration.implementationCommitSha, "abandonment metadata implementation commit");
    assertEqual(abandonmentMetadata.publicationCommitSha, metadata.publicationCommitSha, "abandonment metadata publication commit");
    assertEqual(abandonmentMetadata.registrationPayloadSha256, registration.payloadSha256, "abandonment metadata registration payload");
    assertEqual(abandonmentMetadata.headSha, evidence.relevantPathHistory.at(-1)?.commitSha, "abandonment metadata head SHA");
  }
  assertEqual(metadata.registrySha256, sha256Bytes(evidence.registryAtClosureBytes), "closure registry SHA-256");
  assertJsonEqual(metadata.relevantPathHistory, evidence.relevantPathHistory, "closure relevant path history");
  if (metadata.relevantPathHistory.length === 0 || metadata.relevantPathHistory[0]?.commitSha !== metadata.publicationCommitSha) {
    throw new Error("Closure relevant path history must begin with the publication commit.");
  }

  assertClosureManualIdentity(manual, metadata);
  assertAtOrAfter(manual.verifiedAt, metadata.serverCreatedAt, "Closure manual verifiedAt must be at or after the closure run");
  if (!manual.noLaterRelevantPathCommit) throw new Error("Manual closure verification must confirm no later relevant-path commit.");
  const latest = metadata.relevantPathHistory.at(-1)?.commitSha;
  assertEqual(manual.latestRelevantPathCommitSha, latest, "manual latest relevant path commit");
  return deepFreeze({
    assurance: PROSPECTIVE_SHADOW_ASSURANCE,
    cryptographicallyVerified: false,
    registryClassification: metadata.registryClassification,
    closureTipSha: metadata.closureTipSha,
    metadata,
    manualVerifiedAt: manual.verifiedAt,
  });
}

export function validateProspectiveShadowAbandonmentStructure(
  registrationInput: ProspectiveShadowRegistration,
  evidenceInput: ProspectiveShadowAbandonmentGitEvidence,
  options: Readonly<{ requireImplementationCheckout?: boolean }> = {},
): ProspectiveShadowAbandonmentGitEvidence {
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

export function validateProspectiveShadowClosureStructure(
  registrationInput: ProspectiveShadowRegistration,
  evidenceInput: ProspectiveShadowClosureGitEvidence,
  options: Readonly<{ requireImplementationCheckout?: boolean }> = {},
) {
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

function validateContext(value: ProspectiveShadowWorkflowContext): ProspectiveShadowWorkflowContext {
  const record = requireRecord(value, "Workflow context");
  const mode = requireMode(record.mode);
  if (record.repository !== PROSPECTIVE_SHADOW_REPOSITORY) throw new Error("Workflow repository must be the canonical repository.");
  if (record.branch !== PROSPECTIVE_SHADOW_BRANCH) throw new Error("Workflow branch must be main.");
  const runId = requirePositiveInteger(record.runId, "Workflow run ID");
  const runUrl = requireRunUrl(record.runUrl, runId);
  const implementationCommitSha = requireCommit(record.implementationCommitSha, "implementationCommitSha");
  const publicationCommitSha = requireCommit(record.publicationCommitSha, "publicationCommitSha");
  assertDistinctCommits(implementationCommitSha, publicationCommitSha);
  return deepFreeze({
    mode,
    repository: PROSPECTIVE_SHADOW_REPOSITORY,
    branch: PROSPECTIVE_SHADOW_BRANCH,
    runId,
    runUrl,
    headSha: requireCommit(record.headSha, "headSha"),
    implementationCommitSha,
    publicationCommitSha,
    registrationPayloadSha256: requireSha256(record.registrationPayloadSha256, "registrationPayloadSha256"),
  });
}

function validateActionsRun(value: ProspectiveShadowActionsRun): ProspectiveShadowActionsRun {
  const record = requireRecord(value, "GitHub Actions run");
  const repository = requireRecord(record.repository, "GitHub Actions repository");
  return deepFreeze({
    id: requirePositiveInteger(record.id, "GitHub Actions run ID"),
    html_url: requireString(record.html_url, "GitHub Actions html_url"),
    created_at: requireTimestamp(record.created_at, "GitHub Actions created_at"),
    head_branch: requireString(record.head_branch, "GitHub Actions head_branch"),
    head_sha: requireCommit(record.head_sha, "GitHub Actions head_sha"),
    repository: { full_name: requireString(repository.full_name, "GitHub Actions repository full_name") },
  });
}

function validateMetadata(value: ProspectiveShadowWorkflowMetadata, mode: ProspectiveShadowWorkflowMode): ProspectiveShadowWorkflowMetadata {
  const record = requireRecord(value, "Commitment metadata");
  const keys = [
    "schemaVersion", "authority", "mode", "repository", "branch", "runId", "runUrl",
    "serverCreatedAt", "implementationCommitSha", "publicationCommitSha", "headSha",
    "registrationPath", "registryPath", "workflowPath", "registrationPayloadSha256",
  ];
  if (mode === "CLOSURE") keys.push("closureTipSha", "registryClassification", "registrySha256", "relevantPathHistory", "abandonmentMetadata");
  assertExactKeys(record, keys, "Commitment metadata");
  if (record.schemaVersion !== 1 || record.authority !== PROSPECTIVE_SHADOW_AUTHORITY) throw new Error("Commitment metadata authority is invalid.");
  if (record.mode !== mode) throw new Error(`Commitment metadata mode must be ${mode}.`);
  assertCanonicalMetadataIdentity(record);
  return deepFreeze(structuredClone(value));
}

function validatePublicationEvidence(value: ProspectiveShadowPublicationGitEvidence): ProspectiveShadowPublicationGitEvidence {
  const record = requireRecord(value, "Publication Git evidence");
  if (record.mode !== "REGISTERED_PUBLICATION") throw new Error("Publication Git evidence mode is invalid.");
  return deepFreeze({
    mode: "REGISTERED_PUBLICATION",
    currentHeadSha: requireCommit(record.currentHeadSha, "currentHeadSha"),
    publicationCommitSha: requireCommit(record.publicationCommitSha, "publicationCommitSha"),
    publicationParents: requireCommitArray(record.publicationParents, "publicationParents"),
    publicationChangedPaths: requireStringArray(record.publicationChangedPaths, "publicationChangedPaths"),
    registrationAtImplementation: validatePathEvidence(record.registrationAtImplementation, "registrationAtImplementation"),
    registryAtImplementation: validatePathEvidence(record.registryAtImplementation, "registryAtImplementation"),
    registrationBytes: requireString(record.registrationBytes, "registrationBytes"),
    registryBytes: requireString(record.registryBytes, "registryBytes"),
    workflowAtImplementationBytes: requireString(record.workflowAtImplementationBytes, "workflowAtImplementationBytes"),
    workflowAtPublicationBytes: requireString(record.workflowAtPublicationBytes, "workflowAtPublicationBytes"),
  });
}

function validateInitialManualVerification(value: ProspectiveShadowInitialManualVerification): ProspectiveShadowInitialManualVerification {
  const record = requireRecord(value, "Initial manual verification");
  assertExactKeys(record, [
    "confirmation", "verifiedAt", "runUrl", "repository", "branch", "runId",
    "implementationCommitSha", "publicationCommitSha", "registrationPath", "registrationPayloadSha256",
  ], "Initial manual verification");
  if (record.confirmation !== PROSPECTIVE_SHADOW_INITIAL_CONFIRMATION) throw new Error("Initial manual verification confirmation is invalid.");
  return deepFreeze({
    confirmation: PROSPECTIVE_SHADOW_INITIAL_CONFIRMATION,
    verifiedAt: requireTimestamp(record.verifiedAt, "Initial manual verifiedAt"),
    runUrl: requireString(record.runUrl, "Initial manual runUrl"),
    repository: requireString(record.repository, "Initial manual repository"),
    branch: requireString(record.branch, "Initial manual branch"),
    runId: requirePositiveInteger(record.runId, "Initial manual runId"),
    implementationCommitSha: requireCommit(record.implementationCommitSha, "Initial manual implementationCommitSha"),
    publicationCommitSha: requireCommit(record.publicationCommitSha, "Initial manual publicationCommitSha"),
    registrationPath: requireString(record.registrationPath, "Initial manual registrationPath"),
    registrationPayloadSha256: requireSha256(record.registrationPayloadSha256, "Initial manual registrationPayloadSha256"),
  });
}

function validateClosureMetadata(value: ProspectiveShadowClosureMetadata): ProspectiveShadowClosureMetadata {
  const base = validateMetadata(value, "CLOSURE");
  const record = requireRecord(value, "Closure metadata");
  const classification = record.registryClassification;
  if (classification !== "ACTIVE_AT_CLOSE" && classification !== "ABANDONED") throw new Error("Closure registry classification is invalid.");
  return deepFreeze({
    ...base,
    mode: "CLOSURE",
    closureTipSha: requireCommit(record.closureTipSha, "closureTipSha"),
    registryClassification: classification,
    registrySha256: requireSha256(record.registrySha256, "registrySha256"),
    relevantPathHistory: validateRelevantCommitEvidenceArray(record.relevantPathHistory),
    abandonmentMetadata: record.abandonmentMetadata === null
      ? null
      : validateMetadata(record.abandonmentMetadata as ProspectiveShadowWorkflowMetadata, "ABANDONED"),
  });
}

function validateClosureEvidence(value: ProspectiveShadowClosureGitEvidence): ProspectiveShadowClosureGitEvidence {
  const record = requireRecord(value, "Closure Git evidence");
  if (record.mode !== "CLOSURE") throw new Error("Closure Git evidence mode is invalid.");
  if (typeof record.publicationIsAncestorOfClosureTip !== "boolean") throw new Error("Closure ancestry evidence must be boolean.");
  return deepFreeze({
    mode: "CLOSURE",
    currentHeadSha: requireCommit(record.currentHeadSha, "currentHeadSha"),
    publicationCommitSha: requireCommit(record.publicationCommitSha, "publicationCommitSha"),
    closureTipSha: requireCommit(record.closureTipSha, "closureTipSha"),
    publicationIsAncestorOfClosureTip: record.publicationIsAncestorOfClosureTip,
    registrationAtPublicationBytes: requireString(record.registrationAtPublicationBytes, "registrationAtPublicationBytes"),
    registrationAtClosureBytes: requireString(record.registrationAtClosureBytes, "registrationAtClosureBytes"),
    registryAtClosureBytes: requireString(record.registryAtClosureBytes, "registryAtClosureBytes"),
    workflowAtImplementationBytes: requireString(record.workflowAtImplementationBytes, "workflowAtImplementationBytes"),
    workflowAtClosureBytes: requireString(record.workflowAtClosureBytes, "workflowAtClosureBytes"),
    relevantPathHistory: validateRelevantCommitEvidenceArray(record.relevantPathHistory),
  });
}

function validateAbandonmentEvidence(value: ProspectiveShadowAbandonmentGitEvidence): ProspectiveShadowAbandonmentGitEvidence {
  const record = requireRecord(value, "Abandonment Git evidence");
  if (record.mode !== "ABANDONED") throw new Error("Abandonment Git evidence mode is invalid.");
  return deepFreeze({
    mode: "ABANDONED",
    currentHeadSha: requireCommit(record.currentHeadSha, "currentHeadSha"),
    publicationCommitSha: requireCommit(record.publicationCommitSha, "publicationCommitSha"),
    abandonmentCommitSha: requireCommit(record.abandonmentCommitSha, "abandonmentCommitSha"),
    publicationIsAncestorOfAbandonment: requireBoolean(record.publicationIsAncestorOfAbandonment, "publicationIsAncestorOfAbandonment"),
    abandonmentParents: requireCommitArray(record.abandonmentParents, "abandonmentParents"),
    abandonmentChangedPaths: requireStringArray(record.abandonmentChangedPaths, "abandonmentChangedPaths"),
    registrationAtPublicationBytes: requireString(record.registrationAtPublicationBytes, "registrationAtPublicationBytes"),
    registrationAtAbandonmentBytes: requireString(record.registrationAtAbandonmentBytes, "registrationAtAbandonmentBytes"),
    registryAtPublicationBytes: requireString(record.registryAtPublicationBytes, "registryAtPublicationBytes"),
    registryAtAbandonmentBytes: requireString(record.registryAtAbandonmentBytes, "registryAtAbandonmentBytes"),
    workflowAtImplementationBytes: requireString(record.workflowAtImplementationBytes, "workflowAtImplementationBytes"),
    workflowAtAbandonmentBytes: requireString(record.workflowAtAbandonmentBytes, "workflowAtAbandonmentBytes"),
  });
}

function validateClosureManualVerification(value: ProspectiveShadowClosureManualVerification): ProspectiveShadowClosureManualVerification {
  const record = requireRecord(value, "Closure manual verification");
  assertExactKeys(record, [
    "confirmation", "verifiedAt", "runUrl", "repository", "branch", "runId",
    "implementationCommitSha", "publicationCommitSha", "closureTipSha", "registrySha256",
    "latestRelevantPathCommitSha", "noLaterRelevantPathCommit",
  ], "Closure manual verification");
  if (record.confirmation !== PROSPECTIVE_SHADOW_CLOSURE_CONFIRMATION) throw new Error("Closure manual verification confirmation is invalid.");
  if (record.noLaterRelevantPathCommit !== true) throw new Error("Closure manual verification must confirm no later relevant-path commit.");
  return deepFreeze({
    confirmation: PROSPECTIVE_SHADOW_CLOSURE_CONFIRMATION,
    verifiedAt: requireTimestamp(record.verifiedAt, "Closure manual verifiedAt"),
    runUrl: requireString(record.runUrl, "Closure manual runUrl"),
    repository: requireString(record.repository, "Closure manual repository"),
    branch: requireString(record.branch, "Closure manual branch"),
    runId: requirePositiveInteger(record.runId, "Closure manual runId"),
    implementationCommitSha: requireCommit(record.implementationCommitSha, "Closure manual implementationCommitSha"),
    publicationCommitSha: requireCommit(record.publicationCommitSha, "Closure manual publicationCommitSha"),
    closureTipSha: requireCommit(record.closureTipSha, "Closure manual closureTipSha"),
    registrySha256: requireSha256(record.registrySha256, "Closure manual registrySha256"),
    latestRelevantPathCommitSha: requireCommit(record.latestRelevantPathCommitSha, "Closure manual latestRelevantPathCommitSha"),
    noLaterRelevantPathCommit: true,
  });
}

function validatePathEvidence(value: unknown, label: string): ProspectiveShadowGitPathEvidence {
  const record = requireRecord(value, label);
  if (record.status === "PRESENT") {
    assertExactKeys(record, ["status", "bytes"], label);
    return deepFreeze({ status: "PRESENT", bytes: requireString(record.bytes, `${label} bytes`) });
  }
  if (record.status === "MISSING") {
    assertExactKeys(record, ["status", "exitCode", "stderr"], label);
    const exitCode = record.exitCode;
    if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode <= 0) {
      throw new Error(`${label} missing-path exitCode must be a positive integer.`);
    }
    const stderr = requireString(record.stderr, `${label} stderr`);
    if (stderr.trim() === "") throw new Error(`${label} missing-path stderr must be non-empty.`);
    return deepFreeze({ status: "MISSING", exitCode, stderr });
  }
  throw new Error(`${label} status must be PRESENT or MISSING.`);
}

function assertExpectedMissing(value: ProspectiveShadowGitPathEvidence, label: string): void {
  if (value.status !== "MISSING") throw new Error(`${label} must be absent before publication.`);
}

function validateRelevantCommitEvidenceArray(value: unknown): readonly ProspectiveShadowRelevantPathCommitEvidence[] {
  if (!Array.isArray(value)) throw new Error("Closure relevant path history must be an array.");
  const result = value.map((item, index) => {
    const record = requireRecord(item, `Closure relevant path history[${index}]`);
    assertExactKeys(record, ["commitSha", "parents", "changedPaths", "registration", "registry", "workflowBytes"], `Closure relevant path history[${index}]`);
    return deepFreeze({
      commitSha: requireCommit(record.commitSha, `history[${index}].commitSha`),
      parents: requireCommitArray(record.parents, `history[${index}].parents`),
      changedPaths: requireStringArray(record.changedPaths, `history[${index}].changedPaths`),
      registration: validatePathEvidence(record.registration, `history[${index}].registration`),
      registry: validatePathEvidence(record.registry, `history[${index}].registry`),
      workflowBytes: requireString(record.workflowBytes, `history[${index}].workflowBytes`),
    });
  });
  if (new Set(result.map((item) => item.commitSha)).size !== result.length) {
    throw new Error("Closure relevant path history contains duplicate commits.");
  }
  return deepFreeze(result);
}

function validateRelevantPathHistory(
  registration: ProspectiveShadowRegistration,
  evidence: ProspectiveShadowClosureGitEvidence,
  abandoned: boolean,
): void {
  const history = evidence.relevantPathHistory;
  const expectedLength = abandoned ? 2 : 1;
  if (history.length !== expectedLength) {
    throw new Error("Relevant-path history may contain only the initial publication and one fully validated abandonment.");
  }
  const publication = history[0];
  if (publication === undefined || publication.commitSha !== evidence.publicationCommitSha) {
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
  if (latest?.registration.status !== "PRESENT" || latest.registration.bytes !== evidence.registrationAtClosureBytes ||
      latest.registry.status !== "PRESENT" || latest.registry.bytes !== evidence.registryAtClosureBytes) {
    throw new Error("Closure tip path bytes do not match the latest relevant commit evidence.");
  }
  if (latest.workflowBytes !== evidence.workflowAtClosureBytes) throw new Error("Closure workflow evidence does not match history.");

  if (abandoned) {
    const abandonment = history[1];
    if (abandonment === undefined || abandonment.parents.length !== 1) throw new Error("Abandonment history commit must have exactly one parent.");
    assertExactPaths(abandonment.changedPaths, [PROSPECTIVE_SHADOW_REGISTRY_PATH]);
    if (abandonment.registration.status !== "PRESENT" || abandonment.registration.bytes !== canonicalRegistration) {
      throw new Error("Registration must remain canonical at abandonment.");
    }
    if (abandonment.registry.status !== "PRESENT" || !abandonment.registry.bytes.startsWith(publication.registry.bytes)) {
      throw new Error("Abandonment must append to the publication registry bytes.");
    }
    const registry = parseProspectiveShadowRegistry(abandonment.registry.bytes);
    const event = registry.events[1];
    if (registry.events.length !== 2 || event?.event !== "ABANDONED" ||
        event.publicationCommitSha !== evidence.publicationCommitSha ||
        compareTimestamp(event.eventAt, registration.window.to) >= 0) {
      throw new Error("History abandonment must be the one valid pre-window-end ABANDONED event.");
    }
    if (abandonment.workflowBytes !== evidence.workflowAtImplementationBytes) throw new Error("Workflow bytes changed at abandonment.");
  }
}

function assertCanonicalMetadataIdentity(record: Record<string, unknown>): void {
  if (record.repository !== PROSPECTIVE_SHADOW_REPOSITORY) throw new Error("Commitment metadata repository is invalid.");
  if (record.branch !== PROSPECTIVE_SHADOW_BRANCH) throw new Error("Commitment metadata branch is invalid.");
  requirePositiveInteger(record.runId, "Commitment metadata runId");
  requireRunUrl(record.runUrl, record.runId as number);
  requireTimestamp(record.serverCreatedAt, "Commitment metadata serverCreatedAt");
  requireCommit(record.implementationCommitSha, "Commitment metadata implementationCommitSha");
  requireCommit(record.publicationCommitSha, "Commitment metadata publicationCommitSha");
  requireCommit(record.headSha, "Commitment metadata headSha");
  if (record.registrationPath !== PROSPECTIVE_SHADOW_REGISTRATION_PATH || record.registryPath !== PROSPECTIVE_SHADOW_REGISTRY_PATH || record.workflowPath !== PROSPECTIVE_SHADOW_WORKFLOW_PATH) {
    throw new Error("Commitment metadata canonical paths are invalid.");
  }
  requireSha256(record.registrationPayloadSha256, "Commitment metadata registrationPayloadSha256");
}

function assertManualIdentity(manual: ProspectiveShadowInitialManualVerification, metadata: ProspectiveShadowWorkflowMetadata): void {
  const checks: Array<[unknown, unknown, string]> = [
    [manual.runUrl, metadata.runUrl, "manual run URL"], [manual.repository, metadata.repository, "manual repository"],
    [manual.branch, metadata.branch, "manual branch"], [manual.runId, metadata.runId, "manual run ID"],
    [manual.implementationCommitSha, metadata.implementationCommitSha, "manual implementation commit"],
    [manual.publicationCommitSha, metadata.publicationCommitSha, "manual publication commit"],
    [manual.registrationPath, metadata.registrationPath, "manual registration path"],
    [manual.registrationPayloadSha256, metadata.registrationPayloadSha256, "manual registration payload"],
  ];
  for (const [actual, expected, label] of checks) assertEqual(actual, expected, label);
}

function assertClosureManualIdentity(manual: ProspectiveShadowClosureManualVerification, metadata: ProspectiveShadowClosureMetadata): void {
  const checks: Array<[unknown, unknown, string]> = [
    [manual.runUrl, metadata.runUrl, "closure manual run URL"], [manual.repository, metadata.repository, "closure manual repository"],
    [manual.branch, metadata.branch, "closure manual branch"], [manual.runId, metadata.runId, "closure manual run ID"],
    [manual.implementationCommitSha, metadata.implementationCommitSha, "closure manual implementation commit"],
    [manual.publicationCommitSha, metadata.publicationCommitSha, "closure manual publication commit"],
    [manual.closureTipSha, metadata.closureTipSha, "closure manual tip"],
    [manual.registrySha256, metadata.registrySha256, "closure manual registry SHA-256"],
  ];
  for (const [actual, expected, label] of checks) assertEqual(actual, expected, label);
}

function assertDistinctCommits(implementation: string, publication: string): void {
  if (implementation === publication) throw new Error("Implementation and publication commits must be distinct.");
}

function assertExactPaths(actual: readonly string[], expected: readonly string[]): void {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
    throw new Error("Publication changed paths must be exactly the canonical registration and registry paths.");
  }
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} does not match.`);
}

function assertEqual(actual: unknown, expected: unknown, label: string): asserts actual {
  if (actual !== expected) throw new Error(`${label} does not match.`);
}

function assertBefore(actual: string, boundary: string, label: string): void {
  if (compareTimestamp(actual, boundary) >= 0) throw new Error(`${label}.`);
}

function assertMinimumLead(actual: string, boundary: string, minimumMs: number, label: string): void {
  const actualTimestamp = parsePerformanceTimestamp(actual);
  const boundaryTimestamp = parsePerformanceTimestamp(boundary);
  if (!actualTimestamp || !boundaryTimestamp) {
    throw new Error("Commitment lead timestamps must be valid ISO-8601 values.");
  }
  const leadNanoseconds = boundaryTimestamp.epochNanoseconds - actualTimestamp.epochNanoseconds;
  if (leadNanoseconds < BigInt(minimumMs) * 1_000_000n) throw new Error(`${label}.`);
}

function assertAtOrAfter(actual: string, boundary: string, label: string): void {
  if (compareTimestamp(actual, boundary) < 0) throw new Error(`${label}.`);
}

function compareTimestamp(left: string, right: string): number {
  const a = parsePerformanceTimestamp(left);
  const b = parsePerformanceTimestamp(right);
  if (!a || !b) throw new Error("Commitment comparison timestamps must be valid ISO-8601 values.");
  return compareEpochNanoseconds(a.epochNanoseconds, b.epochNanoseconds);
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a timestamp string.`);
  const parsed = parsePerformanceTimestamp(value);
  if (!parsed) throw new Error(`${label} must be an exact ISO-8601 timestamp with an explicit timezone.`);
  return parsed.normalized;
}

function requireMode(value: unknown): ProspectiveShadowWorkflowMode {
  if (value !== "REGISTERED_PUBLICATION" && value !== "ABANDONED" && value !== "CLOSURE") {
    throw new Error("Workflow mode must be REGISTERED_PUBLICATION, ABANDONED, or CLOSURE.");
  }
  return value;
}

function requireRunUrl(value: unknown, runId: number): string {
  const expected = `https://github.com/${PROSPECTIVE_SHADOW_REPOSITORY}/actions/runs/${runId}`;
  if (value !== expected) throw new Error("Workflow run URL must identify the exact canonical public Actions run.");
  return expected;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
  return value;
}

function requireCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) throw new Error(`${label} must be a lowercase 40-character commit SHA.`);
  return value;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array.`);
  return [...value] as string[];
}

function requireCommitArray(value: unknown, label: string): readonly string[] {
  return requireStringArray(value, label).map((item) => requireCommit(item, label));
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys do not match the frozen contract.`);
  }
}

function sha256Bytes(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
