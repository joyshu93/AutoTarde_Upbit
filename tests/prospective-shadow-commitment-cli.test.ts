import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildProspectiveShadowWorkflowMetadata,
  parseProspectiveShadowCommitmentArgs,
  runProspectiveShadowCommitmentCli,
  type ProspectiveShadowCommitmentCliOptions,
} from "../src/research/prospective-shadow-commitment.js";
import {
  PROSPECTIVE_SHADOW_REGISTRATION_PATH,
  PROSPECTIVE_SHADOW_REGISTRY_PATH,
  PROSPECTIVE_SHADOW_WORKFLOW_PATH,
  validateProspectiveShadowClosureCommitment,
  type ProspectiveShadowWorkflowMode,
} from "../src/modules/performance/performance-prospective-shadow-commitment.js";
import {
  createProspectiveShadowRegistration,
  PROSPECTIVE_SHADOW_POLICY_MANIFEST,
  serializeProspectiveShadowRegistration,
  serializeProspectiveShadowRegistryEvent,
} from "../src/modules/performance/performance-prospective-shadow-registration.js";
import type { ReadOnlyGitRunner, ReadonlyGitResult } from "../src/research/prospective-shadow-git-commitment-reader.js";

const REPOSITORY = "joyshu93/AutoTarde_Upbit";
const IMPLEMENTATION = "1".repeat(40);
const PUBLICATION = "2".repeat(40);
const CLOSURE = "3".repeat(40);
const ABANDONMENT = "4".repeat(40);
const TAMPER = "5".repeat(40);
const WORKFLOW = "name: prospective\n";
const execFileAsync = promisify(execFile);

function cliFixture(mode: ProspectiveShadowWorkflowMode, createdAt?: string) {
  const registration = createProspectiveShadowRegistration({
    registeredAt: "2026-01-01T00:00:00Z",
    implementationCommitSha: IMPLEMENTATION,
    developmentAuthoritySha256: "a".repeat(64),
    retrospectiveReportSha256: "b".repeat(64),
    policyManifest: structuredClone(PROSPECTIVE_SHADOW_POLICY_MANIFEST),
  });
  const registrationBytes = serializeProspectiveShadowRegistration(registration);
  const registeredRegistry = serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1,
    authority: registration.authority,
    experimentId: registration.experimentId,
    event: "REGISTERED",
    eventAt: registration.registeredAt,
    registrationPayloadSha256: registration.payloadSha256,
  });
  const abandonedRegistry = registeredRegistry + serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1,
    authority: registration.authority,
    experimentId: registration.experimentId,
    event: "ABANDONED",
    eventAt: registration.window.from,
    registrationPayloadSha256: registration.payloadSha256,
    publicationCommitSha: PUBLICATION,
    reason: "Stopped before the observation window ended.",
  });
  const headSha = mode === "REGISTERED_PUBLICATION" ? PUBLICATION : mode === "ABANDONED" ? ABANDONMENT : CLOSURE;
  const runId = mode === "REGISTERED_PUBLICATION" ? 101 : mode === "ABANDONED" ? 102 : 103;
  const runUrl = `https://github.com/${REPOSITORY}/actions/runs/${runId}`;
  const defaultCreatedAt = mode === "REGISTERED_PUBLICATION"
    ? "2026-01-02T00:00:00Z"
    : mode === "ABANDONED" ? registration.window.from : registration.window.to;
  const options: ProspectiveShadowCommitmentCliOptions = {
    mode,
    githubRunJsonPath: "own-run.json",
    outputPath: "output.json",
    repository: REPOSITORY,
    branch: "main",
    runId,
    runUrl,
    headSha,
    implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
  };
  const runJson = JSON.stringify({
    id: runId,
    html_url: runUrl,
    created_at: createdAt ?? defaultCreatedAt,
    head_branch: "main",
    head_sha: headSha,
    repository: { full_name: REPOSITORY },
  });
  const outputs = new Map<string, ReadonlyGitResult>();
  const ok = (command: string, stdout: string) => outputs.set(command, { exitCode: 0, stdout, stderr: "" });
  const missing = (command: string) => outputs.set(command, { exitCode: 128, stdout: "", stderr: "path does not exist" });
  ok("rev-parse HEAD", `${headSha}\n`);
  ok(`show ${IMPLEMENTATION}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`, WORKFLOW);

  if (mode === "REGISTERED_PUBLICATION") {
    ok(`show --no-patch --format=%P ${PUBLICATION}`, `${IMPLEMENTATION}\n`);
    ok(`diff-tree --no-commit-id --name-only -r ${PUBLICATION}`, `${PROSPECTIVE_SHADOW_REGISTRATION_PATH}\n${PROSPECTIVE_SHADOW_REGISTRY_PATH}\n`);
    ok(`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`, registrationBytes);
    ok(`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`, registeredRegistry);
    ok(`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`, WORKFLOW);
    missing(`show ${IMPLEMENTATION}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`);
    missing(`show ${IMPLEMENTATION}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`);
  } else if (mode === "ABANDONED") {
    ok(`merge-base --is-ancestor ${PUBLICATION} ${ABANDONMENT}`, "");
    ok(`show --no-patch --format=%P ${ABANDONMENT}`, `${CLOSURE}\n`);
    ok(`diff-tree --no-commit-id --name-only -r ${ABANDONMENT}`, `${PROSPECTIVE_SHADOW_REGISTRY_PATH}\n`);
    ok(`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`, registrationBytes);
    ok(`show ${ABANDONMENT}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`, registrationBytes);
    ok(`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`, registeredRegistry);
    ok(`show ${ABANDONMENT}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`, abandonedRegistry);
    ok(`show ${ABANDONMENT}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`, WORKFLOW);
  } else {
    ok(`merge-base --is-ancestor ${PUBLICATION} ${CLOSURE}`, "");
    ok(`log --reverse --format=%H ${PUBLICATION}^..${CLOSURE} -- ${PROSPECTIVE_SHADOW_REGISTRATION_PATH} ${PROSPECTIVE_SHADOW_REGISTRY_PATH}`, `${PUBLICATION}\n`);
    ok(`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`, registrationBytes);
    ok(`show ${CLOSURE}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`, registrationBytes);
    ok(`show ${CLOSURE}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`, registeredRegistry);
    ok(`show ${CLOSURE}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`, WORKFLOW);
    ok(`show --no-patch --format=%P ${PUBLICATION}`, `${IMPLEMENTATION}\n`);
    ok(`diff-tree --no-commit-id --name-only -r ${PUBLICATION}`, `${PROSPECTIVE_SHADOW_REGISTRATION_PATH}\n${PROSPECTIVE_SHADOW_REGISTRY_PATH}\n`);
    ok(`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`, registeredRegistry);
    ok(`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`, WORKFLOW);
  }
  const calls: string[] = [];
  const extraFiles = new Map<string, string>();
  const gitRunner: ReadOnlyGitRunner = { run: async (args) => {
    const command = args.join(" ");
    calls.push(command);
    return outputs.get(command) ?? { exitCode: 99, stdout: "", stderr: `unexpected fake Git command: ${command}` };
  } };
  let written = "";
  return {
    registration,
    options,
    outputs,
    calls,
    registeredRegistry,
    registrationBytes,
    dependencies: {
      cwd: "C:/fixture",
      readTextFile: async (filePath: string) => {
        const normalized = filePath.replaceAll("\\", "/");
        if (normalized.endsWith(PROSPECTIVE_SHADOW_REGISTRATION_PATH)) return registrationBytes;
        return extraFiles.get(normalized) ?? runJson;
      },
      writeOutput: async (_filePath: string, bytes: string) => { written = bytes; },
      gitRunner,
    },
    getWritten: () => written,
    setFile: (filePath: string, bytes: string) => extraFiles.set(filePath.replaceAll("\\", "/"), bytes),
    ok,
  };
}

function initialCommitmentInput(fixture: ReturnType<typeof cliFixture>) {
  const metadata = {
    schemaVersion: 1 as const,
    authority: fixture.registration.authority,
    mode: "REGISTERED_PUBLICATION" as const,
    repository: REPOSITORY as typeof REPOSITORY,
    branch: "main" as const,
    runId: 101,
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/101`,
    serverCreatedAt: "2026-01-02T00:00:00Z",
    implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
    headSha: PUBLICATION,
    registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH,
    registryPath: PROSPECTIVE_SHADOW_REGISTRY_PATH,
    workflowPath: PROSPECTIVE_SHADOW_WORKFLOW_PATH,
    registrationPayloadSha256: fixture.registration.payloadSha256,
  };
  return {
    registration: fixture.registration,
    metadata,
    manualVerification: {
      confirmation: "I_VERIFIED_PUBLIC_GITHUB_COMMITMENT" as const,
      verifiedAt: "2026-01-02T01:00:00Z",
      runUrl: metadata.runUrl,
      repository: REPOSITORY,
      branch: "main",
      runId: 101,
      implementationCommitSha: IMPLEMENTATION,
      publicationCommitSha: PUBLICATION,
      registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH,
      registrationPayloadSha256: fixture.registration.payloadSha256,
    },
    gitEvidence: {
      mode: "REGISTERED_PUBLICATION" as const,
      currentHeadSha: IMPLEMENTATION,
      publicationCommitSha: PUBLICATION,
      publicationParents: [IMPLEMENTATION],
      publicationChangedPaths: [PROSPECTIVE_SHADOW_REGISTRATION_PATH, PROSPECTIVE_SHADOW_REGISTRY_PATH],
      registrationAtImplementation: { status: "MISSING" as const, exitCode: 128, stderr: "path does not exist" },
      registryAtImplementation: { status: "MISSING" as const, exitCode: 128, stderr: "path does not exist" },
      registrationBytes: fixture.registrationBytes,
      registryBytes: fixture.registeredRegistry,
      workflowAtImplementationBytes: WORKFLOW,
      workflowAtPublicationBytes: WORKFLOW,
    },
  };
}

function validateCliClosureOutput(
  fixture: ReturnType<typeof cliFixture>,
  output: Awaited<ReturnType<typeof runProspectiveShadowCommitmentCli>>,
  registryBytes: string,
) {
  if (!("closureTipSha" in output) || !("relevantPathHistory" in output) || !("registrySha256" in output)) {
    throw new Error("expected closure output");
  }
  const manualVerification = {
    confirmation: "I_VERIFIED_PUBLIC_GITHUB_REGISTRY_CLOSURE" as const,
    verifiedAt: fixture.registration.window.to,
    runUrl: output.runUrl,
    repository: REPOSITORY,
    branch: "main",
    runId: output.runId,
    implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
    closureTipSha: output.closureTipSha,
    registrySha256: output.registrySha256,
    latestRelevantPathCommitSha: output.relevantPathHistory.at(-1)?.commitSha ?? "",
    noLaterRelevantPathCommit: true as const,
  };
  return validateProspectiveShadowClosureCommitment({
    registration: fixture.registration,
    initialCommitmentInput: initialCommitmentInput(fixture),
    metadata: output,
    manualVerification,
    gitEvidence: {
      mode: "CLOSURE",
      currentHeadSha: IMPLEMENTATION,
      publicationCommitSha: PUBLICATION,
      closureTipSha: output.closureTipSha,
      publicationIsAncestorOfClosureTip: true,
      registrationAtPublicationBytes: fixture.registrationBytes,
      registrationAtClosureBytes: fixture.registrationBytes,
      registryAtClosureBytes: registryBytes,
      workflowAtImplementationBytes: WORKFLOW,
      workflowAtClosureBytes: WORKFLOW,
      relevantPathHistory: output.relevantPathHistory,
    },
  });
}

test("commitment CLI parser requires explicit mode and exact own-run inputs", () => {
  const parsed = parseProspectiveShadowCommitmentArgs([
    "--mode", "REGISTERED_PUBLICATION",
    "--github-run-json", "run.json",
    "--output", "commitment.json",
    "--repository", REPOSITORY,
    "--branch", "main",
    "--run-id", "101",
    "--run-url", `https://github.com/${REPOSITORY}/actions/runs/101`,
    "--head-sha", PUBLICATION,
    "--implementation-commit-sha", IMPLEMENTATION,
    "--publication-commit-sha", PUBLICATION,
  ]);
  assert.equal(parsed.mode, "REGISTERED_PUBLICATION");
  assert.equal(parsed.runId, 101);
  const closureWithAbandonment = parseProspectiveShadowCommitmentArgs([
    ...[
      "--mode", "CLOSURE", "--github-run-json", "run.json", "--output", "commitment.json",
      "--repository", REPOSITORY, "--branch", "main", "--run-id", "103",
      "--run-url", `https://github.com/${REPOSITORY}/actions/runs/103`, "--head-sha", CLOSURE,
      "--implementation-commit-sha", IMPLEMENTATION, "--publication-commit-sha", PUBLICATION,
    ],
    "--abandonment-metadata", "prior-abandonment.json",
  ]);
  assert.equal(closureWithAbandonment.abandonmentMetadataPath, "prior-abandonment.json");
  assert.throws(() => parseProspectiveShadowCommitmentArgs([]), /Missing required argument/i);
  assert.throws(() => parseProspectiveShadowCommitmentArgs(["--mode", "BAD"]), /mode/i);
});

test("metadata builder trusts server time only after exact GitHub own-run identity checks", () => {
  const runUrl = `https://github.com/${REPOSITORY}/actions/runs/101`;
  const metadata = buildProspectiveShadowWorkflowMetadata({
    context: {
      mode: "REGISTERED_PUBLICATION",
      repository: REPOSITORY,
      branch: "main",
      runId: 101,
      runUrl,
      headSha: PUBLICATION,
      implementationCommitSha: IMPLEMENTATION,
      publicationCommitSha: PUBLICATION,
      registrationPayloadSha256: "a".repeat(64),
    },
    actionsRunJson: JSON.stringify({
      id: 101,
      html_url: runUrl,
      created_at: "2026-01-02T00:00:00Z",
      head_branch: "main",
      head_sha: PUBLICATION,
      repository: { full_name: REPOSITORY },
    }),
  });
  assert.equal(metadata.serverCreatedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(JSON.stringify(metadata).includes("GITHUB_TOKEN"), false);
  assert.throws(() => buildProspectiveShadowWorkflowMetadata({
    context: { ...metadata, mode: "REGISTERED_PUBLICATION", registrationPayloadSha256: "a".repeat(64) },
    actionsRunJson: JSON.stringify({
      id: 999,
      html_url: runUrl,
      created_at: "2026-01-02T00:00:00Z",
      head_branch: "main",
      head_sha: PUBLICATION,
      repository: { full_name: REPOSITORY },
    }),
  } as any), /run ID|identity/i);
});

test("workflow has exact triggers, least privilege, full history, three modes, and no trading side effects", async () => {
  const workflow = await readFile(".github/workflows/prospective-shadow-registration.yml", "utf8");
  const bundle = await readFile(".github/scripts/prospective-shadow-commitment.mjs", "utf8");
  for (const expected of [
    "workflow_dispatch:", "branches:", "- main", "docs/research/prospective-shadow/PCS-2026-001.registration.json",
    "docs/research/prospective-shadow/registry.jsonl", "contents: read", "actions: read", "fetch-depth: 0",
    "persist-credentials: false", "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    ".github/scripts/prospective-shadow-commitment.mjs",
    "REGISTERED_PUBLICATION", "ABANDONED", "CLOSURE", "api.github.com/repos/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    "abandonment_metadata_json", "--abandonment-metadata prospective-shadow-abandonment-metadata.json",
    "TARGET_BRANCH: ${{ github.ref_name }}", "--branch \"$TARGET_BRANCH\"",
    "[[ \"$TARGET_BRANCH\" == 'main' ]]",
  ]) assert.equal(workflow.includes(expected), true, expected);
  for (const forbidden of [
    "APP_EXECUTION_MODE", "UPBIT_ACCESS_KEY", "UPBIT_SECRET_KEY", "TELEGRAM_BOT_TOKEN",
    "npm run start", "npm test", "research:candles", "research:no-trade-evidence", "sqlite",
    "git fetch", "git push", "git checkout main",
    "uses: actions/checkout@v4", "uses: actions/upload-artifact@v4", "npm ci", "npm install", "npx ",
  ]) assert.equal(workflow.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
  assert.equal(/permissions:\s*\n\s*contents: read\s*\n\s*actions: read/.test(workflow), true);
  assert.equal(bundle.includes("Publication workflow requires at least 48 hours of public lead time."), true);
  assert.equal(bundle.includes("createReadOnlyGitRunner"), true);
  assert.equal(/UPBIT_(?:ACCESS|SECRET)_KEY|TELEGRAM_BOT_TOKEN|node:sqlite/.test(bundle), false);
});

test("checked-in workflow validator bundle is byte-for-byte reproducible from TypeScript source", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/check-prospective-commitment-bundle.mjs"], {
    cwd: process.cwd(),
    windowsHide: true,
  });
  assert.match(`${stdout}\n${stderr}`, /matches the TypeScript source/i);
});

test("CLI validates REGISTERED_PUBLICATION end to end using only fake Git and memory files", async () => {
  const fixture = cliFixture("REGISTERED_PUBLICATION");
  const output = await runProspectiveShadowCommitmentCli(fixture.options, fixture.dependencies);
  assert.equal(output.mode, "REGISTERED_PUBLICATION");
  assert.equal(output.headSha, PUBLICATION);
  assert.deepEqual(JSON.parse(fixture.getWritten()), output);
  assert.equal(fixture.calls.includes(`show ${IMPLEMENTATION}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`), true);
});

test("CLI validates ABANDONED end to end using only fake Git and memory files", async () => {
  const fixture = cliFixture("ABANDONED");
  const output = await runProspectiveShadowCommitmentCli(fixture.options, fixture.dependencies);
  assert.equal(output.mode, "ABANDONED");
  if (!("abandonmentCommitSha" in output)) throw new Error("ABANDONED output lacks abandonment evidence");
  assert.equal(output.abandonmentCommitSha, ABANDONMENT);
  assert.equal(output.headSha, ABANDONMENT);
  assert.deepEqual(JSON.parse(fixture.getWritten()), output);
});

test("CLI validates active CLOSURE end to end with detailed publication evidence", async () => {
  const fixture = cliFixture("CLOSURE");
  const output = await runProspectiveShadowCommitmentCli(fixture.options, fixture.dependencies);
  assert.equal(output.mode, "CLOSURE");
  if (!("registryClassification" in output) || !("relevantPathHistory" in output)) {
    throw new Error("CLOSURE output lacks closure evidence");
  }
  assert.equal(output.registryClassification, "ACTIVE_AT_CLOSE");
  assert.deepEqual(output.relevantPathHistory.map((entry) => entry.commitSha), [PUBLICATION]);
  assert.equal(output.abandonmentMetadata, null);
  assert.equal(validateCliClosureOutput(fixture, output, fixture.registeredRegistry).registryClassification, "ACTIVE_AT_CLOSE");
  assert.deepEqual(JSON.parse(fixture.getWritten()), output);
});

test("CLI abandoned closure accepts prior abandonment metadata and emits validator-ready output", async () => {
  const fixture = cliFixture("CLOSURE");
  const abandonedRegistry = fixture.registeredRegistry + serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1,
    authority: fixture.registration.authority,
    experimentId: fixture.registration.experimentId,
    event: "ABANDONED",
    eventAt: fixture.registration.window.from,
    registrationPayloadSha256: fixture.registration.payloadSha256,
    publicationCommitSha: PUBLICATION,
    reason: "Stopped before closure.",
  });
  fixture.ok(
    `log --reverse --format=%H ${PUBLICATION}^..${CLOSURE} -- ${PROSPECTIVE_SHADOW_REGISTRATION_PATH} ${PROSPECTIVE_SHADOW_REGISTRY_PATH}`,
    `${PUBLICATION}\n${ABANDONMENT}\n`,
  );
  fixture.ok(`show ${CLOSURE}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`, abandonedRegistry);
  fixture.ok(`show --no-patch --format=%P ${ABANDONMENT}`, `${PUBLICATION}\n`);
  fixture.ok(`diff-tree --no-commit-id --name-only -r ${ABANDONMENT}`, `${PROSPECTIVE_SHADOW_REGISTRY_PATH}\n`);
  fixture.ok(`show ${ABANDONMENT}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`, fixture.registrationBytes);
  fixture.ok(`show ${ABANDONMENT}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`, abandonedRegistry);
  fixture.ok(`show ${ABANDONMENT}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`, WORKFLOW);
  const abandonmentRunUrl = `https://github.com/${REPOSITORY}/actions/runs/102`;
  const priorAbandonmentOutput = {
    schemaVersion: 1,
    authority: fixture.registration.authority,
    mode: "ABANDONED",
    repository: REPOSITORY,
    branch: "main",
    runId: 102,
    runUrl: abandonmentRunUrl,
    serverCreatedAt: fixture.registration.window.from,
    implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
    headSha: ABANDONMENT,
    registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH,
    registryPath: PROSPECTIVE_SHADOW_REGISTRY_PATH,
    workflowPath: PROSPECTIVE_SHADOW_WORKFLOW_PATH,
    registrationPayloadSha256: fixture.registration.payloadSha256,
    abandonmentCommitSha: ABANDONMENT,
    registrySha256: createHash("sha256").update(abandonedRegistry, "utf8").digest("hex"),
  };
  const abandonmentMetadataPath = "C:/fixture/prior-abandonment.json";
  fixture.setFile(abandonmentMetadataPath, JSON.stringify(priorAbandonmentOutput));
  const options = { ...fixture.options, abandonmentMetadataPath } as ProspectiveShadowCommitmentCliOptions;
  const output = await runProspectiveShadowCommitmentCli(options, fixture.dependencies);
  assert.equal(output.mode, "CLOSURE");
  if (output.mode !== "CLOSURE") throw new Error("expected closure output");
  const expectedMetadata = structuredClone(priorAbandonmentOutput) as Record<string, unknown>;
  delete expectedMetadata.abandonmentCommitSha;
  delete expectedMetadata.registrySha256;
  assert.deepEqual(output.abandonmentMetadata, expectedMetadata);
  assert.equal(validateCliClosureOutput(fixture, output, abandonedRegistry).registryClassification, "ABANDONED");
});

test("CLI rejects a declared mode whose complete commit diff has the wrong classification", async () => {
  const registered = cliFixture("REGISTERED_PUBLICATION");
  registered.ok(`diff-tree --no-commit-id --name-only -r ${PUBLICATION}`, `${PROSPECTIVE_SHADOW_REGISTRY_PATH}\n`);
  await assert.rejects(
    runProspectiveShadowCommitmentCli(registered.options, registered.dependencies),
    /changed paths/i,
  );

  const abandoned = cliFixture("ABANDONED");
  abandoned.ok(`diff-tree --no-commit-id --name-only -r ${ABANDONMENT}`, `${PROSPECTIVE_SHADOW_REGISTRATION_PATH}\n${PROSPECTIVE_SHADOW_REGISTRY_PATH}\n`);
  await assert.rejects(
    runProspectiveShadowCommitmentCli(abandoned.options, abandoned.dependencies),
    /changed paths/i,
  );
});

test("CLI closure rejects registration or registry modification followed by byte-for-byte revert", async () => {
  const fixture = cliFixture("CLOSURE");
  fixture.ok(
    `log --reverse --format=%H ${PUBLICATION}^..${CLOSURE} -- ${PROSPECTIVE_SHADOW_REGISTRATION_PATH} ${PROSPECTIVE_SHADOW_REGISTRY_PATH}`,
    `${PUBLICATION}\n${TAMPER}\n${CLOSURE}\n`,
  );
  fixture.ok(`show --no-patch --format=%P ${TAMPER}`, `${PUBLICATION}\n`);
  fixture.ok(`diff-tree --no-commit-id --name-only -r ${TAMPER}`, `${PROSPECTIVE_SHADOW_REGISTRY_PATH}\n`);
  fixture.ok(`show ${TAMPER}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`, fixture.registrationBytes);
  fixture.ok(`show ${TAMPER}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`, "tampered registry bytes\n");
  fixture.ok(`show ${TAMPER}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`, WORKFLOW);
  fixture.ok(`show --no-patch --format=%P ${CLOSURE}`, `${TAMPER}\n`);
  fixture.ok(`diff-tree --no-commit-id --name-only -r ${CLOSURE}`, `${PROSPECTIVE_SHADOW_REGISTRY_PATH}\n`);
  await assert.rejects(
    runProspectiveShadowCommitmentCli(fixture.options, fixture.dependencies),
    /only the initial publication.*one fully validated abandonment/i,
  );
});

test("CLI enforces server-created time boundaries for publication, abandonment, and closure", async () => {
  const registrationShortLead = cliFixture("REGISTERED_PUBLICATION", "2026-01-02T00:00:00.001Z");
  await assert.rejects(
    runProspectiveShadowCommitmentCli(registrationShortLead.options, registrationShortLead.dependencies),
    /48 hours|public lead/i,
  );

  const registrationBoundary = cliFixture("REGISTERED_PUBLICATION");
  const registrationAtBoundary = cliFixture("REGISTERED_PUBLICATION", registrationBoundary.registration.window.from);
  await assert.rejects(
    runProspectiveShadowCommitmentCli(registrationAtBoundary.options, registrationAtBoundary.dependencies),
    /48 hours|public lead|before the registered boundary/i,
  );

  const abandonmentBoundary = cliFixture("ABANDONED");
  const abandonmentAtBoundary = cliFixture("ABANDONED", abandonmentBoundary.registration.window.to);
  await assert.rejects(
    runProspectiveShadowCommitmentCli(abandonmentAtBoundary.options, abandonmentAtBoundary.dependencies),
    /before the registered boundary/i,
  );

  const closureBoundary = cliFixture("CLOSURE");
  const closureBeforeBoundary = cliFixture("CLOSURE", "2026-01-02T00:00:00Z");
  assert.notEqual(closureBeforeBoundary.registration.window.to, "2026-01-02T00:00:00.000Z");
  await assert.rejects(
    runProspectiveShadowCommitmentCli(closureBeforeBoundary.options, closureBeforeBoundary.dependencies),
    /at or after.*window end/i,
  );
  assert.equal(closureBoundary.registration.window.to, closureBoundary.registration.window.to);
});
