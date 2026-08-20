import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createProspectiveShadowRegistration,
  PROSPECTIVE_SHADOW_POLICY_MANIFEST,
  serializeProspectiveShadowRegistration,
  serializeProspectiveShadowRegistryEvent,
} from "../src/modules/performance/performance-prospective-shadow-registration.js";
import {
  PROSPECTIVE_SHADOW_BRANCH,
  PROSPECTIVE_SHADOW_REPOSITORY,
  PROSPECTIVE_SHADOW_REGISTRATION_PATH,
  PROSPECTIVE_SHADOW_REGISTRY_PATH,
  PROSPECTIVE_SHADOW_WORKFLOW_PATH,
  validateProspectiveShadowClosureCommitment,
  validateProspectiveShadowCommitment,
  validateProspectiveShadowAbandonmentStructure,
  validateProspectiveShadowWorkflowMetadata,
} from "../src/modules/performance/performance-prospective-shadow-commitment.js";

const IMPLEMENTATION = "1".repeat(40);
const PUBLICATION = "2".repeat(40);
const CLOSURE = "3".repeat(40);
const WORKFLOW = "name: prospective\n";

function fixture() {
  const registration = createProspectiveShadowRegistration({
    registeredAt: "2026-01-01T00:00:00Z",
    implementationCommitSha: IMPLEMENTATION,
    developmentAuthoritySha256: "a".repeat(64),
    retrospectiveReportSha256: "b".repeat(64),
    policyManifest: structuredClone(PROSPECTIVE_SHADOW_POLICY_MANIFEST),
  });
  const registrationBytes = serializeProspectiveShadowRegistration(registration);
  const registryBytes = serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1,
    authority: registration.authority,
    experimentId: registration.experimentId,
    event: "REGISTERED",
    eventAt: registration.registeredAt,
    registrationPayloadSha256: registration.payloadSha256,
  });
  const gitEvidence = {
    mode: "REGISTERED_PUBLICATION" as const,
    currentHeadSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
    publicationParents: [IMPLEMENTATION],
    publicationChangedPaths: [PROSPECTIVE_SHADOW_REGISTRATION_PATH, PROSPECTIVE_SHADOW_REGISTRY_PATH],
    registrationAtImplementation: { status: "MISSING" as const, exitCode: 128, stderr: "path does not exist" },
    registryAtImplementation: { status: "MISSING" as const, exitCode: 128, stderr: "path does not exist" },
    registrationBytes,
    registryBytes,
    workflowAtImplementationBytes: WORKFLOW,
    workflowAtPublicationBytes: WORKFLOW,
  };
  const metadata = {
    schemaVersion: 1 as const,
    authority: registration.authority,
    mode: "REGISTERED_PUBLICATION" as const,
    repository: PROSPECTIVE_SHADOW_REPOSITORY,
    branch: PROSPECTIVE_SHADOW_BRANCH,
    runId: 101,
    runUrl: `https://github.com/${PROSPECTIVE_SHADOW_REPOSITORY}/actions/runs/101`,
    serverCreatedAt: "2026-01-02T00:00:00Z",
    implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
    headSha: PUBLICATION,
    registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH,
    registryPath: PROSPECTIVE_SHADOW_REGISTRY_PATH,
    workflowPath: PROSPECTIVE_SHADOW_WORKFLOW_PATH,
    registrationPayloadSha256: registration.payloadSha256,
  };
  const manualVerification = {
    confirmation: "I_VERIFIED_PUBLIC_GITHUB_COMMITMENT" as const,
    verifiedAt: "2026-01-02T01:00:00Z",
    runUrl: metadata.runUrl,
    repository: metadata.repository,
    branch: metadata.branch,
    runId: metadata.runId,
    implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
    registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH,
    registrationPayloadSha256: registration.payloadSha256,
  };
  return { registration, registrationBytes, registryBytes, gitEvidence, metadata, manualVerification };
}

test("initial public commitment binds distinct implementation and publication commits before the window", () => {
  const input = fixture();
  const validated = validateProspectiveShadowCommitment(input);

  assert.equal(validated.assurance, "HUMAN_VERIFIED_PUBLIC_GITHUB_RUN");
  assert.equal(validated.cryptographicallyVerified, false);
  assert.equal(validated.implementationCommitSha, IMPLEMENTATION);
  assert.equal(validated.publicationCommitSha, PUBLICATION);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.metadata), true);
});

test("initial public commitment requires at least 48 hours of public lead time", () => {
  const exact = fixture();
  exact.metadata.serverCreatedAt = "2026-01-02T00:00:00.000Z";
  exact.manualVerification.verifiedAt = "2026-01-02T00:00:00.000Z";
  assert.doesNotThrow(() => validateProspectiveShadowCommitment(exact));

  const short = fixture();
  short.metadata.serverCreatedAt = "2026-01-02T00:00:00.001Z";
  short.manualVerification.verifiedAt = "2026-01-02T00:00:00.001Z";
  assert.throws(
    () => validateProspectiveShadowCommitment(short),
    /48 hours|public lead/i,
  );
});

test("initial commitment rejects wrong checkout, parent, paths, bytes, identities, timing, and human confirmation", () => {
  const mutations: Array<[string, (value: any) => void, RegExp]> = [
    ["same commits", (value) => value.metadata.publicationCommitSha = IMPLEMENTATION, /distinct/i],
    ["wrong checkout", (value) => value.gitEvidence.currentHeadSha = PUBLICATION, /HEAD|implementation/i],
    ["two parents", (value) => value.gitEvidence.publicationParents.push("4".repeat(40)), /one parent/i],
    ["wrong parent", (value) => value.gitEvidence.publicationParents[0] = "4".repeat(40), /parent/i],
    ["extra path", (value) => value.gitEvidence.publicationChangedPaths.push("README.md"), /changed paths/i],
    ["registration already present", (value) => value.gitEvidence.registrationAtImplementation = { status: "PRESENT", bytes: value.gitEvidence.registrationBytes }, /absent before publication/i],
    ["registry already present", (value) => value.gitEvidence.registryAtImplementation = { status: "PRESENT", bytes: value.gitEvidence.registryBytes }, /absent before publication/i],
    ["registration bytes", (value) => value.gitEvidence.registrationBytes += " ", /registration bytes|canonical/i],
    ["registry duplicate", (value) => value.gitEvidence.registryBytes += value.gitEvidence.registryBytes, /duplicate|REGISTERED/i],
    ["workflow changed", (value) => value.gitEvidence.workflowAtPublicationBytes += "# changed\n", /workflow/i],
    ["late run", (value) => value.metadata.serverCreatedAt = value.registration.window.from, /48 hours|public lead|before.*window/i],
    ["wrong repository", (value) => value.metadata.repository = "someone/else", /repository/i],
    ["wrong branch", (value) => value.metadata.branch = "feature", /branch/i],
    ["wrong head", (value) => value.metadata.headSha = IMPLEMENTATION, /head SHA/i],
    ["extra metadata", (value) => value.metadata.unregistered = true, /metadata.*keys/i],
    ["wrong URL", (value) => value.metadata.runUrl += "/attempts/1", /run URL/i],
    ["wrong phrase", (value) => value.manualVerification.confirmation = "yes", /confirmation/i],
    ["extra manual field", (value) => value.manualVerification.unregistered = true, /manual.*keys/i],
    ["early verification", (value) => value.manualVerification.verifiedAt = "2026-01-01T23:59:59Z", /verifiedAt/i],
    ["manual SHA mismatch", (value) => value.manualVerification.publicationCommitSha = "4".repeat(40), /manual.*publication/i],
  ];
  for (const [name, mutate, expected] of mutations) {
    const value = structuredClone(fixture()) as any;
    mutate(value);
    assert.throws(() => validateProspectiveShadowCommitment(value), expected, name);
  }
});

test("workflow metadata validates exact own-run Actions REST identity for all three modes", () => {
  const { registration, metadata } = fixture();
  for (const mode of ["REGISTERED_PUBLICATION", "ABANDONED", "CLOSURE"] as const) {
    const headSha = mode === "REGISTERED_PUBLICATION" ? PUBLICATION : CLOSURE;
    const runId = mode === "REGISTERED_PUBLICATION" ? 101 : mode === "ABANDONED" ? 102 : 103;
    const runUrl = `https://github.com/${PROSPECTIVE_SHADOW_REPOSITORY}/actions/runs/${runId}`;
    const result = validateProspectiveShadowWorkflowMetadata({
      context: {
        mode,
        repository: PROSPECTIVE_SHADOW_REPOSITORY,
        branch: "main",
        runId,
        runUrl,
        headSha,
        implementationCommitSha: IMPLEMENTATION,
        publicationCommitSha: PUBLICATION,
        registrationPayloadSha256: registration.payloadSha256,
      },
      actionsRun: {
        id: runId,
        html_url: runUrl,
        created_at: mode === "CLOSURE" ? registration.window.to : metadata.serverCreatedAt,
        head_branch: "main",
        head_sha: headSha,
        repository: { full_name: PROSPECTIVE_SHADOW_REPOSITORY },
      },
    });
    assert.equal(result.mode, mode);
    assert.equal(
      result.serverCreatedAt,
      mode === "CLOSURE" ? registration.window.to : "2026-01-02T00:00:00.000Z",
    );
  }
});

test("closure commitment requires at-or-after-end server time and fresh manually verified public path history", () => {
  const base = fixture();
  const registrySha256 = createHash("sha256").update(base.registryBytes, "utf8").digest("hex");
  const closureMetadata = {
    ...base.metadata,
    mode: "CLOSURE" as const,
    runId: 103,
    runUrl: `https://github.com/${PROSPECTIVE_SHADOW_REPOSITORY}/actions/runs/103`,
    serverCreatedAt: base.registration.window.to,
    headSha: CLOSURE,
    closureTipSha: CLOSURE,
    registryClassification: "ACTIVE_AT_CLOSE" as const,
    registrySha256,
    relevantPathHistory: [{
      commitSha: PUBLICATION,
      parents: [IMPLEMENTATION],
      changedPaths: [PROSPECTIVE_SHADOW_REGISTRATION_PATH, PROSPECTIVE_SHADOW_REGISTRY_PATH],
      registration: { status: "PRESENT" as const, bytes: base.registrationBytes },
      registry: { status: "PRESENT" as const, bytes: base.registryBytes },
      workflowBytes: WORKFLOW,
    }],
    abandonmentMetadata: null,
  };
  const closureGitEvidence = {
    mode: "CLOSURE" as const,
    currentHeadSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
    closureTipSha: CLOSURE,
    publicationIsAncestorOfClosureTip: true,
    registrationAtPublicationBytes: base.registrationBytes,
    registrationAtClosureBytes: base.registrationBytes,
    registryAtClosureBytes: base.registryBytes,
    workflowAtImplementationBytes: WORKFLOW,
    workflowAtClosureBytes: WORKFLOW,
    relevantPathHistory: closureMetadata.relevantPathHistory,
  };
  const closureManualVerification = {
    confirmation: "I_VERIFIED_PUBLIC_GITHUB_REGISTRY_CLOSURE" as const,
    verifiedAt: base.registration.window.to,
    runUrl: closureMetadata.runUrl,
    repository: PROSPECTIVE_SHADOW_REPOSITORY,
    branch: "main" as const,
    runId: 103,
    implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
    closureTipSha: CLOSURE,
    registrySha256,
    latestRelevantPathCommitSha: PUBLICATION,
    noLaterRelevantPathCommit: true as const,
  };

  const result = validateProspectiveShadowClosureCommitment({
    registration: base.registration,
    initialCommitmentInput: base,
    metadata: closureMetadata,
    manualVerification: closureManualVerification,
    gitEvidence: closureGitEvidence,
  });
  assert.equal(result.registryClassification, "ACTIVE_AT_CLOSE");
  assert.equal(result.cryptographicallyVerified, false);

  for (const [name, mutate, expected] of [
    ["early closure", (value: any) => value.metadata.serverCreatedAt = "2026-05-02T23:59:59Z", /at or after.*window/i],
    ["not ancestor", (value: any) => value.gitEvidence.publicationIsAncestorOfClosureTip = false, /ancestor/i],
    ["registration replaced", (value: any) => value.gitEvidence.registrationAtClosureBytes += " ", /registration.*unchanged/i],
    ["stale history", (value: any) => value.manualVerification.noLaterRelevantPathCommit = false, /later.*path/i],
    ["history mismatch", (value: any) => value.manualVerification.latestRelevantPathCommitSha = CLOSURE, /latest.*path/i],
    ["wrong phrase", (value: any) => value.manualVerification.confirmation = "yes", /confirmation/i],
  ] as const) {
    const value = structuredClone({
      registration: base.registration,
      initialCommitmentInput: base,
      metadata: closureMetadata,
      manualVerification: closureManualVerification,
      gitEvidence: closureGitEvidence,
    }) as any;
    mutate(value);
    assert.throws(() => validateProspectiveShadowClosureCommitment(value), expected, name);
  }
});

test("abandoned registry is rejected as an active initial or closure commitment", () => {
  const base = fixture();
  const abandoned = serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1,
    authority: base.registration.authority,
    experimentId: base.registration.experimentId,
    event: "ABANDONED",
    eventAt: "2026-02-01T00:00:00Z",
    registrationPayloadSha256: base.registration.payloadSha256,
    publicationCommitSha: PUBLICATION,
    reason: "Stopped prospectively.",
  });
  const value = structuredClone(base) as any;
  value.gitEvidence.registryBytes += abandoned;
  assert.throws(() => validateProspectiveShadowCommitment(value), /abandoned/i);
});

test("abandonment may follow unrelated commits but must remain a one-parent descendant with a registry-only append", () => {
  const base = fixture();
  const unrelatedParent = "4".repeat(40);
  const abandonmentCommit = "5".repeat(40);
  const abandonedBytes = base.registryBytes + serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1,
    authority: base.registration.authority,
    experimentId: base.registration.experimentId,
    event: "ABANDONED",
    eventAt: "2026-02-01T00:00:00Z",
    registrationPayloadSha256: base.registration.payloadSha256,
    publicationCommitSha: PUBLICATION,
    reason: "Stopped prospectively.",
  });
  const evidence = {
    mode: "ABANDONED" as const,
    currentHeadSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
    abandonmentCommitSha: abandonmentCommit,
    publicationIsAncestorOfAbandonment: true,
    abandonmentParents: [unrelatedParent],
    abandonmentChangedPaths: [PROSPECTIVE_SHADOW_REGISTRY_PATH],
    registrationAtPublicationBytes: base.registrationBytes,
    registrationAtAbandonmentBytes: base.registrationBytes,
    registryAtPublicationBytes: base.registryBytes,
    registryAtAbandonmentBytes: abandonedBytes,
    workflowAtImplementationBytes: WORKFLOW,
    workflowAtAbandonmentBytes: WORKFLOW,
  };
  assert.doesNotThrow(() => validateProspectiveShadowAbandonmentStructure(base.registration, evidence));
  assert.throws(
    () => validateProspectiveShadowAbandonmentStructure(base.registration, { ...evidence, publicationIsAncestorOfAbandonment: false }),
    /ancestor/i,
  );
  const atBoundary = {
    ...evidence,
    registryAtAbandonmentBytes: base.registryBytes + serializeProspectiveShadowRegistryEvent({
      schemaVersion: 1,
      authority: base.registration.authority,
      experimentId: base.registration.experimentId,
      event: "ABANDONED",
      eventAt: base.registration.window.to,
      registrationPayloadSha256: base.registration.payloadSha256,
      publicationCommitSha: PUBLICATION,
      reason: "Too late.",
    }),
  };
  assert.throws(() => validateProspectiveShadowAbandonmentStructure(base.registration, atBoundary), /before.*window end/i);
});

test("REGISTERED event time is bound exactly to registration.registeredAt", () => {
  const value = fixture() as any;
  value.gitEvidence.registryBytes = serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1,
    authority: value.registration.authority,
    experimentId: value.registration.experimentId,
    event: "REGISTERED",
    eventAt: "2026-01-01T00:00:01Z",
    registrationPayloadSha256: value.registration.payloadSha256,
  });
  assert.throws(() => validateProspectiveShadowCommitment(value), /eventAt.*registeredAt/i);
});

test("closure revalidates raw initial evidence and rejects modification-revert path history", () => {
  const base = fixture();
  const registrySha256 = createHash("sha256").update(base.registryBytes, "utf8").digest("hex");
  const publicationHistory = {
    commitSha: PUBLICATION,
    parents: [IMPLEMENTATION],
    changedPaths: [PROSPECTIVE_SHADOW_REGISTRATION_PATH, PROSPECTIVE_SHADOW_REGISTRY_PATH],
    registration: { status: "PRESENT" as const, bytes: base.registrationBytes },
    registry: { status: "PRESENT" as const, bytes: base.registryBytes },
    workflowBytes: WORKFLOW,
  };
  const input: any = {
    registration: base.registration,
    initialCommitmentInput: structuredClone(base),
    metadata: {
      ...base.metadata,
      mode: "CLOSURE",
      runId: 103,
      runUrl: `https://github.com/${PROSPECTIVE_SHADOW_REPOSITORY}/actions/runs/103`,
      serverCreatedAt: base.registration.window.to,
      headSha: CLOSURE,
      closureTipSha: CLOSURE,
      registryClassification: "ACTIVE_AT_CLOSE",
      registrySha256,
      relevantPathHistory: [publicationHistory],
      abandonmentMetadata: null,
    },
    manualVerification: {
      confirmation: "I_VERIFIED_PUBLIC_GITHUB_REGISTRY_CLOSURE",
      verifiedAt: "2026-05-03T01:00:00Z",
      runUrl: `https://github.com/${PROSPECTIVE_SHADOW_REPOSITORY}/actions/runs/103`,
      repository: PROSPECTIVE_SHADOW_REPOSITORY,
      branch: "main",
      runId: 103,
      implementationCommitSha: IMPLEMENTATION,
      publicationCommitSha: PUBLICATION,
      closureTipSha: CLOSURE,
      registrySha256,
      latestRelevantPathCommitSha: PUBLICATION,
      noLaterRelevantPathCommit: true,
    },
    gitEvidence: {
      mode: "CLOSURE",
      currentHeadSha: IMPLEMENTATION,
      publicationCommitSha: PUBLICATION,
      closureTipSha: CLOSURE,
      publicationIsAncestorOfClosureTip: true,
      registrationAtPublicationBytes: base.registrationBytes,
      registrationAtClosureBytes: base.registrationBytes,
      registryAtClosureBytes: base.registryBytes,
      workflowAtImplementationBytes: WORKFLOW,
      workflowAtClosureBytes: WORKFLOW,
      relevantPathHistory: [publicationHistory],
    },
  };
  input.initialCommitmentInput.manualVerification.confirmation = "forged";
  assert.throws(() => validateProspectiveShadowClosureCommitment(input), /confirmation/i);

  input.initialCommitmentInput = structuredClone(base);
  const tamper = { ...publicationHistory, commitSha: "4".repeat(40), parents: [PUBLICATION], changedPaths: [PROSPECTIVE_SHADOW_REGISTRY_PATH] };
  const revert = { ...publicationHistory, commitSha: "5".repeat(40), parents: [tamper.commitSha], changedPaths: [PROSPECTIVE_SHADOW_REGISTRY_PATH] };
  input.metadata.relevantPathHistory = [publicationHistory, tamper, revert];
  input.gitEvidence.relevantPathHistory = [publicationHistory, tamper, revert];
  input.manualVerification.latestRelevantPathCommitSha = revert.commitSha;
  assert.throws(() => validateProspectiveShadowClosureCommitment(input), /only the initial publication.*one fully validated abandonment/i);
});
