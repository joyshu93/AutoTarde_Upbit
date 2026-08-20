import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  formatProspectiveComponentShadowReport,
  formatProspectiveShadowRegistrationPreview,
  parseProspectiveComponentShadowArgs,
  publishProspectiveComponentShadowReport,
  readProspectiveComponentShadowInspection,
  runProspectiveComponentShadowCli,
  validateReadOnlyCheckoutGitCommand,
  verifyCleanImplementationCheckout,
  type ProspectiveComponentShadowReport,
  type ProspectiveComponentShadowCliDependencies,
  type ProspectiveComponentShadowReportFileSystem,
  type ReadOnlyCheckoutCommandRunner,
} from "../src/research/prospective-component-shadow.js";
import {
  PROSPECTIVE_SHADOW_POLICY_MANIFEST,
  createProspectiveShadowRegistrationDraft,
  createProspectiveShadowRegistration,
  serializeProspectiveShadowRegistration,
  serializeProspectiveShadowRegistryEvent,
  type ProspectiveShadowRegistration,
} from "../src/modules/performance/performance-prospective-shadow-registration.js";
import {
  PROSPECTIVE_SHADOW_BRANCH,
  PROSPECTIVE_SHADOW_CLOSURE_CONFIRMATION,
  PROSPECTIVE_SHADOW_INITIAL_CONFIRMATION,
  PROSPECTIVE_SHADOW_REGISTRATION_PATH,
  PROSPECTIVE_SHADOW_REGISTRY_PATH,
  PROSPECTIVE_SHADOW_REPOSITORY,
  PROSPECTIVE_SHADOW_WORKFLOW_PATH,
} from "../src/modules/performance/performance-prospective-shadow-commitment.js";
import { buildProspectiveShadowReplayEvidence } from "../src/modules/performance/performance-prospective-shadow-replay.js";
import { evaluateProspectiveComponentShadow } from "../src/modules/performance/performance-prospective-shadow-evaluation.js";
import { calculateResearchCandleDatasetChecksum } from "../src/modules/performance/research-candle-dataset.js";
import { computeResearchNoTradeEvidenceSha256 } from "../src/modules/performance/research-no-trade-evidence.js";
import type { PositionGuardBacktestFrame } from "../src/modules/strategy/position-guard-backtest.js";

const IMPLEMENTATION = "1".repeat(40);
const PUBLICATION = "2".repeat(40);
const execFileAsync = promisify(execFile);

test("CLI import exposes pure helpers without constructing a runtime, database, network client, or report artifact", () => {
  assert.equal(typeof parseProspectiveComponentShadowArgs, "function");
  assert.equal(typeof runProspectiveComponentShadowCli, "function");
  assert.equal(typeof formatProspectiveComponentShadowReport, "function");
});

test("register rejects caller-controlled time and accepts only authority inputs", () => {
  assert.deepEqual(
    parseProspectiveComponentShadowArgs([
      "register",
      "--implementation-commit-sha", IMPLEMENTATION,
      "--development-authority-sha256", "a".repeat(64),
      "--retrospective-report-sha256", "b".repeat(64),
    ]),
    {
      command: "register",
      implementationCommitSha: IMPLEMENTATION,
      developmentAuthoritySha256: "a".repeat(64),
      retrospectiveReportSha256: "b".repeat(64),
    },
  );
  assert.throws(
    () => parseProspectiveComponentShadowArgs([
      "register", "--registered-at", "2026-08-20T00:00:00Z",
      "--implementation-commit-sha", IMPLEMENTATION,
      "--development-authority-sha256", "a".repeat(64),
      "--retrospective-report-sha256", "b".repeat(64),
    ]),
    /unknown argument --registered-at/i,
  );
});

test("preview accepts the exact register authority contract without caller-controlled time", () => {
  assert.deepEqual(
    parseProspectiveComponentShadowArgs([
      "preview",
      "--implementation-commit-sha", IMPLEMENTATION,
      "--development-authority-sha256", "a".repeat(64),
      "--retrospective-report-sha256", "b".repeat(64),
    ]),
    {
      command: "preview",
      implementationCommitSha: IMPLEMENTATION,
      developmentAuthoritySha256: "a".repeat(64),
      retrospectiveReportSha256: "b".repeat(64),
      output: "text",
    },
  );
  assert.deepEqual(
    parseProspectiveComponentShadowArgs([
      "preview",
      "--implementation-commit-sha", IMPLEMENTATION,
      "--development-authority-sha256", "a".repeat(64),
      "--retrospective-report-sha256", "b".repeat(64),
      "--output", "json",
    ]),
    {
      command: "preview",
      implementationCommitSha: IMPLEMENTATION,
      developmentAuthoritySha256: "a".repeat(64),
      retrospectiveReportSha256: "b".repeat(64),
      output: "json",
    },
  );
  assert.throws(
    () => parseProspectiveComponentShadowArgs([
      "preview",
      "--implementation-commit-sha", IMPLEMENTATION,
      "--development-authority-sha256", "a".repeat(64),
      "--retrospective-report-sha256", "b".repeat(64),
      "--output", "yaml",
    ]),
    /output.*text or json/i,
  );
  assert.throws(
    () => parseProspectiveComponentShadowArgs([
      "preview", "--registered-at", "2026-08-20T00:00:00Z",
      "--implementation-commit-sha", IMPLEMENTATION,
      "--development-authority-sha256", "a".repeat(64),
      "--retrospective-report-sha256", "b".repeat(64),
    ]),
    /unknown argument --registered-at/i,
  );
});

test("preview calculates the canonical registration without publishing or reading side effects", async () => {
  const events: string[] = [];
  const result = await runProspectiveComponentShadowCli(
    parseProspectiveComponentShadowArgs([
      "preview",
      "--implementation-commit-sha", IMPLEMENTATION,
      "--development-authority-sha256", "a".repeat(64),
      "--retrospective-report-sha256", "b".repeat(64),
    ]),
    dependencies(events),
  );

  assert.deepEqual(events, ["now"]);
  assert.equal(result.command, "preview");
  if (result.command !== "preview") assert.fail("Expected preview result.");
  assert.equal(result.report, null);
  assert.equal(result.preview.registration.registeredAt, "2026-08-20T00:00:00.000Z");
  assert.equal(result.preview.registration.window.from, "2026-08-23T00:00:00.000Z");
  assert.equal(result.preview.registration.matrix.pathCount, 24);
  assert.equal(result.preview.registration.payloadSha256.length, 64);
  assert.equal(result.preview.canonicalRegistrationBytes, serializeProspectiveShadowRegistration(result.preview.registration));
  assert.equal(result.preview.canonicalRegistryBytes, registeredRegistryBytes(result.preview.registration));
  const sharedDraft = createProspectiveShadowRegistrationDraft({
    registeredAt: result.preview.registration.registeredAt,
    implementationCommitSha: IMPLEMENTATION,
    developmentAuthoritySha256: "a".repeat(64),
    retrospectiveReportSha256: "b".repeat(64),
    policyManifest: PROSPECTIVE_SHADOW_POLICY_MANIFEST,
  });
  assert.equal(result.preview.canonicalRegistrationBytes, sharedDraft.registrationBytes);
  assert.equal(result.preview.canonicalRegistryBytes, sharedDraft.registryBytes);
  assert.deepEqual(result.preview.wouldWrite, {
    registrationPath: "docs/research/prospective-shadow/PCS-2026-001.registration.json",
    registryPath: "docs/research/prospective-shadow/registry.jsonl",
  });
  assert.deepEqual(result.preview.safety, {
    binding: false,
    writesPerformed: false,
    gitAccessed: false,
    networkAccessed: false,
    databaseAccessed: false,
    actualRegistrationResamplesClock: true,
  });
});

test("preview formatter emits stable JSON and an explicit non-binding human summary", async () => {
  const result = await runProspectiveComponentShadowCli(
    parseProspectiveComponentShadowArgs([
      "preview",
      "--implementation-commit-sha", IMPLEMENTATION,
      "--development-authority-sha256", "a".repeat(64),
      "--retrospective-report-sha256", "b".repeat(64),
    ]),
    dependencies([]),
  );
  assert.equal(result.command, "preview");
  if (result.command !== "preview") assert.fail("Expected preview result.");

  const json = formatProspectiveShadowRegistrationPreview(result.preview, "json");
  const text = formatProspectiveShadowRegistrationPreview(result.preview, "text");
  assert.deepEqual(JSON.parse(json), result.preview);
  assert.equal(json, formatProspectiveShadowRegistrationPreview(result.preview, "json"));
  assert.match(text, /PREVIEW.*NON-BINDING/i);
  assert.match(text, /writes_performed: false/i);
  assert.match(text, /path_count: 24/i);
  assert.match(text, /canonical_registration_bytes:/i);
  assert.match(text, /canonical_registry_bytes:/i);
  assert.match(text, /actual registration.*resample/i);
});

test("preview CLI JSON entrypoint leaves its working directory empty", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "prospective-preview-"));
  try {
    const cliPath = path.resolve("dist/src/research/prospective-component-shadow.js");
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      cliPath,
      "preview",
      "--implementation-commit-sha", IMPLEMENTATION,
      "--development-authority-sha256", "a".repeat(64),
      "--retrospective-report-sha256", "b".repeat(64),
      "--output", "json",
    ], { cwd: directory });
    const parsed = JSON.parse(stdout) as { status?: unknown; safety?: { writesPerformed?: unknown } };
    assert.equal(parsed.status, "NOT_REGISTERED");
    assert.equal(parsed.safety?.writesPerformed, false);
    assert.equal(stderr, "");
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("parser rejects duplicate, unknown, partial, invalid timestamp, and invalid integer inputs without defaults", () => {
  assert.throws(() => parseProspectiveComponentShadowArgs([
    "register", "--implementation-commit-sha", IMPLEMENTATION, "--implementation-commit-sha", IMPLEMENTATION,
  ]), /duplicate argument/i);
  assert.throws(() => parseProspectiveComponentShadowArgs(["inspect", "--as-of", "2026-08-20T00:00:00"]), /explicit-timezone/i);
  assert.throws(() => parseProspectiveComponentShadowArgs(["inspect", "--as-of", "2026-08-20T00:00:00Z", "--unknown", "x"]), /unknown argument/i);
  assert.throws(() => parseProspectiveComponentShadowArgs([
    "evaluate", "--as-of", "2026-08-20T00:00:00Z", "--btc-dataset", "btc.json",
  ]), /missing required argument --eth-dataset/i);
  assert.throws(() => parseProspectiveComponentShadowArgs([
    "evaluate", "--as-of", "2026-08-20T00:00:00Z", "--btc-dataset", "btc.json", "--eth-dataset", "eth.json",
    "--btc-sidecar", "btc-sidecar", "--eth-sidecar", "eth-sidecar", "--initial-metadata", "initial", "--initial-manual-verification", "manual",
    "--closure-metadata", "closure", "--closure-manual-verification", "closure-manual", "--implementation-checkout-sha", IMPLEMENTATION,
    "--minimum-completed-candles-1h", "0", "--minimum-completed-candles-4h", "1", "--minimum-completed-candles-1d", "1", "--required-feature-lookback-candles", "1",
  ]), /positive safe integer/i);
});

test("register accepts only explicit authority inputs and delegates one sampled time to the registration writer", async () => {
  const options = parseProspectiveComponentShadowArgs([
    "register",
    "--implementation-commit-sha", IMPLEMENTATION,
    "--development-authority-sha256", "a".repeat(64),
    "--retrospective-report-sha256", "b".repeat(64),
  ]);
  assert.equal(options.command, "register");
  assert.throws(
    () => parseProspectiveComponentShadowArgs([...optionsToArgv(options), "--repository-root", "C:/elsewhere"]),
    /unknown argument --repository-root/i,
  );

  const events: string[] = [];
  const result = await runProspectiveComponentShadowCli(options, dependencies(events));
  assert.equal(result.command, "register");
  assert.deepEqual(events, ["now", "publish:2026-08-20T00:00:00.000Z"]);
});

test("abandon requires an explicit reason and time and reaches only the locked append-only writer", async () => {
  assert.throws(
    () => parseProspectiveComponentShadowArgs([
      "abandon", "--expected-registration-payload-sha256", "a".repeat(64),
      "--publication-commit-sha", PUBLICATION, "--abandoned-at", "2026-08-21T00:00:00Z",
    ]),
    /missing required argument --reason/i,
  );
  const options = parseProspectiveComponentShadowArgs([
    "abandon",
    "--expected-registration-payload-sha256", "a".repeat(64),
    "--publication-commit-sha", PUBLICATION,
    "--reason", "Collection halted before close.",
    "--abandoned-at", "2026-08-21T00:00:00Z",
  ]);
  const events: string[] = [];
  await runProspectiveComponentShadowCli(options, dependencies(events));
  assert.deepEqual(events, ["abandon:2026-08-21T00:00:00.000Z"]);
});

test("inspect and pre-end evaluate expose only collecting calendar progress and never replay", async () => {
  const registration = fixtureRegistration();
  for (const command of ["inspect", "evaluate"] as const) {
    const events: string[] = [];
    const result = await runProspectiveComponentShadowCli(
      parseProspectiveComponentShadowArgs([command, "--as-of", registration.window.from]),
      dependencies(events, registration),
    );
    assert.notEqual(result.report, null);
    if (result.report === null) throw new Error("Collecting command must return a report.");
    assert.equal(result.report.phase, "COLLECTING");
    assert.equal(result.report.outcomes, null);
    assert.deepEqual(events, ["read-inspection"]);
  }
});

test("inspect remains collecting and read-only after close, while marker and registry integrity failures reject", async () => {
  const registration = fixtureRegistration();
  const events: string[] = [];
  const result = await runProspectiveComponentShadowCli(
    parseProspectiveComponentShadowArgs(["inspect", "--as-of", registration.window.to]),
    dependencies(events, registration),
  );
  assert.notEqual(result.report, null);
  assert.equal(result.report?.phase, "COLLECTING");
  assert.equal(result.report?.calendar.windowComplete, true);
  assert.deepEqual(events, ["read-inspection"]);

  const marked: ProspectiveComponentShadowCliDependencies = {
    ...dependencies([], registration),
    readInspection: async () => ({ registrationBytes: serializeProspectiveShadowRegistration(registration), registryBytes: serializeProspectiveShadowRegistryEvent({ schemaVersion: 1, authority: registration.authority, experimentId: registration.experimentId, event: "REGISTERED", eventAt: registration.registeredAt, registrationPayloadSha256: registration.payloadSha256 }), markerPresent: true }),
  };
  await assert.rejects(runProspectiveComponentShadowCli(parseProspectiveComponentShadowArgs(["inspect", "--as-of", registration.window.to]), marked), /in-progress publication marker/i);
});

test("inspect rejects malformed registry, hash mismatch, and duplicate registry registration events", async () => {
  const registration = fixtureRegistration();
  const canonical = registeredRegistryBytes(registration);
  for (const registryBytes of ["not-json\n", canonical.replace(registration.payloadSha256, "f".repeat(64)), canonical + canonical]) {
    await assert.rejects(
      runProspectiveComponentShadowCli(
        parseProspectiveComponentShadowArgs(["inspect", "--as-of", registration.window.from]),
        { ...dependencies([], registration), readInspection: async () => ({ registrationBytes: serializeProspectiveShadowRegistration(registration), registryBytes, markerPresent: false }) },
      ),
    );
  }
  await assert.rejects(
    runProspectiveComponentShadowCli(
      parseProspectiveComponentShadowArgs(["inspect", "--as-of", registration.window.from]),
      { ...dependencies([], registration), readInspection: async () => ({ registrationBytes: `${serializeProspectiveShadowRegistration(registration)}\n`, registryBytes: canonical, markerPresent: false }) },
    ),
    /registration inspection bytes are not canonical/i,
  );
});

test("inspect reports abandoned registry state without evaluating outcomes", async () => {
  const registration = fixtureRegistration();
  const registryBytes = registeredRegistryBytes(registration) + serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1,
    authority: registration.authority,
    experimentId: registration.experimentId,
    event: "ABANDONED",
    eventAt: registration.window.from,
    registrationPayloadSha256: registration.payloadSha256,
    publicationCommitSha: PUBLICATION,
    reason: "Collection stopped.",
  });
  const result = await runProspectiveComponentShadowCli(
    parseProspectiveComponentShadowArgs(["inspect", "--as-of", registration.window.to]),
    { ...dependencies([], registration), readInspection: async () => ({ registrationBytes: serializeProspectiveShadowRegistration(registration), registryBytes, markerPresent: false }) },
  );
  assert.equal(result.report?.inspection?.registryState, "ABANDONED");
  assert.equal(result.report?.outcomes, null);
});

test("pre-end final evaluation reads only initial commitment authority and never reaches market evidence", async () => {
  const fixture = finalEvidenceFixture();
  const events: string[] = [];
  const options = finalOptions(fixture.registration, 1);
  if (!("btcDatasetPath" in options)) throw new Error("Expected final evaluation options.");
  const result = await runProspectiveComponentShadowCli({ ...options, asOf: fixture.registration.window.from }, finalDependencies(fixture, events, async () => { throw new Error("pre-end report publication is forbidden"); }));
  assert.equal(result.report?.phase, "COLLECTING");
  assert.deepEqual(events, ["initial-metadata", "initial-manual", "initial-git"]);
});

test("report publication stages, verifies, then exclusively renames the complete report directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prospective-shadow-report-"));
  const directoryPath = path.join(root, "docs", "research", "prospective-shadow", "reports", "PCS-2026-001");
  try {
    await publishProspectiveComponentShadowReport({ repositoryRoot: root, directoryPath, json: "{\"ok\":true}\n", text: "research only\n", randomSuffix: () => "test-stage" });
    assert.equal(await readFile(path.join(directoryPath, "report.json"), "utf8"), "{\"ok\":true}\n");
    assert.equal(await readFile(path.join(directoryPath, "report.txt"), "utf8"), "research only\n");
    assert.equal((await readdir(path.dirname(directoryPath))).some((name) => name.includes("test-stage")), false);
    await assert.rejects(
      publishProspectiveComponentShadowReport({ repositoryRoot: root, directoryPath, json: "replacement", text: "replacement", randomSuffix: () => "other-stage" }),
      /already exists/i,
    );
    assert.equal(await readFile(path.join(directoryPath, "report.json"), "utf8"), "{\"ok\":true}\n");
    await assert.rejects(
      publishProspectiveComponentShadowReport({ repositoryRoot: root, directoryPath: path.join(root, "..", "escape"), json: "x", text: "x", randomSuffix: () => "escape-stage" }),
      /escapes the repository/i,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("report publisher removes only its staging directory after write, read-back, and rename failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prospective-shadow-publisher-failures-"));
  const finalDirectory = path.join(root, "docs", "research", "prospective-shadow", "reports", "PCS-2026-001");
  try {
    for (const failure of ["write", "read", "rename"] as const) {
      const fs = reportFileSystem({
        writeFile: async (value, bytes, options) => {
          if (failure === "write" && value.endsWith("report.txt")) throw new Error("write failed");
          await writeFile(value, bytes, options);
        },
        readFile: async (value, encoding) => {
          if (failure === "read" && value.endsWith("report.json")) throw new Error("read failed");
          return readFile(value, encoding);
        },
        rename: async (from, to) => {
          if (failure === "rename") throw new Error("rename failed");
          await rename(from, to);
        },
      });
      await assert.rejects(publishProspectiveComponentShadowReport({ repositoryRoot: root, directoryPath: finalDirectory, json: "{}\n", text: "text\n", randomSuffix: () => `failure-${failure}`, fs }), new RegExp(`${failure} failed`));
      await assert.rejects(lstat(finalDirectory));
      const entries = await readdir(path.dirname(finalDirectory));
      assert.equal(entries.some((entry) => entry.includes(`failure-${failure}`)), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("report publisher rejects a concurrent final-directory race and symlinked intermediate parent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prospective-shadow-publisher-race-"));
  const finalDirectory = path.join(root, "docs", "research", "prospective-shadow", "reports", "PCS-2026-001");
  const external = await mkdtemp(path.join(tmpdir(), "prospective-shadow-external-"));
  try {
    const raced = reportFileSystem({ rename: async (_from, to) => { await mkdir(to); const error = new Error("race") as Error & { code?: string }; error.code = "EEXIST"; throw error; } });
    await assert.rejects(publishProspectiveComponentShadowReport({ repositoryRoot: root, directoryPath: finalDirectory, json: "{}\n", text: "text\n", randomSuffix: () => "race", fs: raced }), /race/);
    assert.equal((await lstat(finalDirectory)).isDirectory(), true);
    assert.equal((await readdir(path.dirname(finalDirectory))).some((entry) => entry.includes("-race.tmp")), false);
    await rm(path.join(root, "docs"), { recursive: true, force: true });
    await symlink(external, path.join(root, "docs"), "junction");
    await assert.rejects(
      publishProspectiveComponentShadowReport({ repositoryRoot: root, directoryPath: finalDirectory, json: "{}\n", text: "text\n", randomSuffix: () => "escape" }),
      /symlink|escapes the repository/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("report publisher validates every existing parent before mkdir and leaves an external junction target unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prospective-shadow-publisher-containment-"));
  const external = await mkdtemp(path.join(tmpdir(), "prospective-shadow-publisher-external-"));
  const finalDirectory = path.join(root, "docs", "research", "prospective-shadow", "reports", "PCS-2026-001");
  try {
    await symlink(external, path.join(root, "docs"), "junction");
    await assert.rejects(
      publishProspectiveComponentShadowReport({ repositoryRoot: root, directoryPath: finalDirectory, json: "{}\n", text: "text\n", randomSuffix: () => "containment" }),
      /symlink|escapes/i,
    );
    assert.deepEqual(await readdir(external), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("report publisher preserves a swapped staging directory when its unique owner marker no longer matches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prospective-shadow-publisher-owner-"));
  const finalDirectory = path.join(root, "docs", "research", "prospective-shadow", "reports", "PCS-2026-001");
  let stagingDirectory = "";
  try {
    const fs = reportFileSystem({
      mkdir: async (value, options) => {
        await mkdir(value, options);
        if (value.includes(".PCS-2026-001-report-owner.tmp")) stagingDirectory = value;
        return undefined;
      },
      writeFile: async (value, bytes, options) => {
        if (value.endsWith("report.json")) {
          await writeFile(path.join(stagingDirectory, ".publication-in-progress"), "attacker-token\n", "utf8");
          throw new Error("forced write failure");
        }
        await writeFile(value, bytes, options);
      },
    });
    await assert.rejects(
      publishProspectiveComponentShadowReport({ repositoryRoot: root, directoryPath: finalDirectory, json: "{}\n", text: "text\n", randomSuffix: () => "owner", fs }),
      /forced write failure/,
    );
    assert.equal((await lstat(stagingDirectory)).isDirectory(), true);
    assert.equal(await readFile(path.join(stagingDirectory, ".publication-in-progress"), "utf8"), "attacker-token\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inspection binds registry event times and rejects symlinked canonical authority paths before reads", async () => {
  const registration = fixtureRegistration();
  const lateRegistered = serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1, authority: registration.authority, experimentId: registration.experimentId, event: "REGISTERED",
    eventAt: hoursAfter(registration.registeredAt, 1), registrationPayloadSha256: registration.payloadSha256,
  });
  const abandonedAtClose = registeredRegistryBytes(registration) + serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1, authority: registration.authority, experimentId: registration.experimentId, event: "ABANDONED",
    eventAt: registration.window.to, registrationPayloadSha256: registration.payloadSha256, publicationCommitSha: PUBLICATION, reason: "Too late.",
  });
  for (const registryBytes of [lateRegistered, abandonedAtClose]) {
    await assert.rejects(runProspectiveComponentShadowCli(
      parseProspectiveComponentShadowArgs(["inspect", "--as-of", registration.window.from]),
      { ...dependencies([], registration), readInspection: async () => ({ registrationBytes: serializeProspectiveShadowRegistration(registration), registryBytes, markerPresent: false }) },
    ), /eventAt|before the prospective window close/i);
  }

  const root = await mkdtemp(path.join(tmpdir(), "prospective-shadow-inspection-"));
  const external = await mkdtemp(path.join(tmpdir(), "prospective-shadow-inspection-external-"));
  const authorityDirectory = path.join(root, "docs", "research", "prospective-shadow");
  try {
    await mkdir(path.join(root, "docs", "research"), { recursive: true });
    await writeFile(path.join(external, "PCS-2026-001.registration.json"), serializeProspectiveShadowRegistration(registration), "utf8");
    await writeFile(path.join(external, "registry.jsonl"), registeredRegistryBytes(registration), "utf8");
    await symlink(external, authorityDirectory, "junction");
    await assert.rejects(readProspectiveComponentShadowInspection(root), /symlink|escapes/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("read-only checkout verifier rejects dirty authority paths and allows ignored dist without mutation commands", async () => {
  const commands: string[][] = [];
  const clean = checkoutRunner(commands, { status: "" });
  await verifyCleanImplementationCheckout("C:/synthetic", IMPLEMENTATION, clean);
  assert.deepEqual(commands, [
    ["rev-parse", "HEAD"], ["diff", "--quiet", "--exit-code"], ["diff", "--cached", "--quiet", "--exit-code"],
    ["status", "--porcelain", "--untracked-files=all", "--", "src", "package.json", "package-lock.json", "tsconfig.json"],
  ]);
  assert.equal(commands.some((args) => ["checkout", "reset", "clean", "fetch", "push"].includes(args[0] ?? "")), false);
  for (const dirty of ["tracked", "staged", "?? src/authority.ts", "?? package.json"]) {
    await assert.rejects(verifyCleanImplementationCheckout("C:/synthetic", IMPLEMENTATION, checkoutRunner([], { dirty })), /checkout|authority-bearing/i);
  }
  await verifyCleanImplementationCheckout("C:/synthetic", IMPLEMENTATION, checkoutRunner([], { status: "" }));
});

test("default checkout runner rejects every command outside its exact read-only allowlist", () => {
  for (const command of [
    ["rev-parse", "HEAD"],
    ["diff", "--quiet", "--exit-code"],
    ["diff", "--cached", "--quiet", "--exit-code"],
    ["status", "--porcelain", "--untracked-files=all", "--", "src", "package.json", "package-lock.json", "tsconfig.json"],
  ]) {
    assert.deepEqual(validateReadOnlyCheckoutGitCommand(command), command);
  }
  for (const command of [
    ["checkout", "main"], ["fetch", "origin"], ["push"], ["reset", "--hard"],
    ["status"], ["rev-parse", "--show-toplevel"], ["diff", "--stat"], ["-c", "alias.x=!calc", "x"],
  ]) {
    assert.throws(() => validateReadOnlyCheckoutGitCommand(command), /read-only checkout Git command/i);
  }
});

test("final evaluation requires every dataset, sidecar, commitment, manual closure, and exact implementation checkout before reading evidence", async () => {
  const registration = fixtureRegistration();
  const incomplete = [
    "evaluate", "--as-of", registration.window.to,
    "--btc-dataset", "btc.json", "--eth-dataset", "eth.json",
    "--btc-sidecar", "btc.sidecar.json", "--eth-sidecar", "eth.sidecar.json",
    "--initial-metadata", "initial.json", "--initial-manual-verification", "initial-manual.json",
    "--closure-metadata", "closure.json", "--closure-manual-verification", "closure-manual.json",
  ];
  assert.throws(
    () => parseProspectiveComponentShadowArgs(incomplete),
    /implementation-checkout-sha/i,
  );
  const events: string[] = [];
  await assert.rejects(
    runProspectiveComponentShadowCli(
      parseProspectiveComponentShadowArgs([
        ...incomplete,
        "--implementation-checkout-sha", "f".repeat(40),
        "--minimum-completed-candles-1h", "200", "--minimum-completed-candles-4h", "200", "--minimum-completed-candles-1d", "200",
        "--required-feature-lookback-candles", "200",
      ]),
      dependencies(events, registration),
    ),
    /commitment metadata/i,
  );
  assert.deepEqual(events, ["read-evidence", "read-evidence"]);
});

test("final evaluation preserves BTC and ETH sections, stable JSON/text, provenance, safety booleans, and reason codes", () => {
  const registration = fixtureRegistration();
  const report = syntheticFinalReport(registration, "INSUFFICIENT");
  const json = formatProspectiveComponentShadowReport(report, "json");
  const text = formatProspectiveComponentShadowReport(report, "text");
  assert.equal(json, formatProspectiveComponentShadowReport(report, "json"));
  assert.match(text, /RESEARCH ONLY.*not deployment approval/i);
  assert.match(text, /INSUFFICIENT/);
  assert.doesNotMatch(text, /SUPPORTS_CONTINUED_SHADOW|deployment is approved/i);
  assert.deepEqual(JSON.parse(json).outcomes.assets.map((asset: { asset: string }) => asset.asset), ["BTC", "ETH"]);
  assert.equal(JSON.parse(json).safety.deploymentApproval, false);
  assert.equal(JSON.parse(json).safety.liveApproval, false);
  assert.match(json, /INCOMPLETE_EVIDENCE/);
  assert.match(json, /payloadSha256/);
});

test("failed final evidence validation never publishes a report", async () => {
  const registration = fixtureRegistration();
  const events: string[] = [];
  const deps: ProspectiveComponentShadowCliDependencies = {
    ...dependencies(events, registration),
    readImplementationCheckoutSha: async () => { events.push("checkout"); return IMPLEMENTATION; },
    readEvidenceJson: async () => { events.push("read-evidence"); return validEvidenceObject(registration); },
    readGitEvidence: async () => { events.push("read-git"); return {} as never; },
    readDataset: async () => { events.push("read-dataset"); return {} as never; },
    readNoTradeEvidence: async () => { events.push("read-sidecar"); return {} as never; },
    buildReplay: async () => { events.push("replay"); throw new Error("synthetic replay failure"); },
  };
  await assert.rejects(
    runProspectiveComponentShadowCli(finalOptions(registration), deps),
    /commitment metadata/i,
  );
  assert.deepEqual(events, ["read-evidence", "read-evidence"]);
  assert.equal(events.some((event) => event.startsWith("publish-report")), false);
});

test("final evaluation uses published registration bytes and real commitment, replay, evaluator, and full report evidence", async () => {
  const fixture = finalEvidenceFixture();
  const events: string[] = [];
  let published: { json: string; text: string } | undefined;
  const result = await runProspectiveComponentShadowCli(finalOptions(fixture.registration, 1), finalDependencies(fixture, events, async ({ json, text }) => {
    events.push("publish-report");
    published = { json, text };
  }, false, true));
  assert.equal(result.report?.phase, "FINAL");
  assert.equal(events.includes("read-inspection"), false);
  assert.deepEqual(events.slice(0, 5), ["initial-metadata", "initial-manual", "initial-git", "closure-metadata", "closure-manual"]);
  assert.equal(events.filter((event) => event === "replay").length, 1);
  assert.equal(events.filter((event) => event === "evaluate").length, 1);
  assert.equal(events.filter((event) => event === "publish-report").length, 1);
  assert.equal(events.some((event) => event.startsWith("production-frames:") && Number(event.split(":")[1]) > 0), true);
  assert.deepEqual(fixture.gitInputs, [
    { mode: "REGISTERED_PUBLICATION", implementationCommitSha: IMPLEMENTATION, publicationCommitSha: PUBLICATION },
    { mode: "CLOSURE", implementationCommitSha: IMPLEMENTATION, publicationCommitSha: PUBLICATION, closureTipSha: "3".repeat(40) },
  ]);
  const report = result.report!;
  assert.equal(report.registration.payloadSha256, fixture.registration.payloadSha256);
  assert.equal(report.replay?.paths.length, 24);
  assert.equal(report.replay?.pathEvidence.length, 24);
  assert.equal(report.replay?.paths.some((entry) => entry.counterfactual.matchResult.episodes.length > 0), true);
  assert.equal(report.replay?.paths.some((entry) => entry.counterfactual.matchResult.realizationSlices.length > 0), true);
  assert.equal(report.replay?.paths.some((entry) => entry.relationships?.relationships.length), true);
  assert.notEqual(report.evaluation?.outcomes, null);
  assert.equal(report.evaluation!.outcomes!.assets.length, 2);
  assert.equal(report.evaluation!.outcomes!.assets.every((asset) => asset.candidates.every((candidate) => candidate.cells.length > 0 && candidate.reasonDetails.length > 0)), true);
  assert.notEqual(published, undefined);
  const json = JSON.parse(published!.json);
  assert.equal(json.replay.paths.length, 24);
  assert.equal(json.evaluation.outcomes.assets.length, 2);
  assert.match(published!.text, /replay_paths: 24/);
  assert.match(published!.text, /fifo_realization_slices=/);
  assert.match(published!.text, /episodes=/);
  const btcSummary = published!.text.split("\n").find((line) => line.startsWith("replay_BTC:")) ?? "";
  assert.equal((btcSummary.match(/Net return is incomplete because one or more path evidence gates are incomplete\./g) ?? []).length, 1);
  assert.match(published!.text, /reason_detail:/);
  assert.match(published!.text, /TECHNICAL EVIDENCE/);
  const representativePath = report.replay!.paths.find((entry) => entry.counterfactual.fills.length > 0 && entry.relationships !== null)!;
  const pathId = `${representativePath.asset}|${representativePath.market}|${representativePath.scenario}|${representativePath.timing}|${representativePath.costId}`;
  const metric = representativePath.pathEvidence.metrics.netReturn;
  const fill = representativePath.counterfactual.fills[0]!;
  const episode = representativePath.counterfactual.matchResult.episodes[0]!;
  const fifo = representativePath.counterfactual.matchResult.realizationSlices[0]!;
  const relationship = representativePath.relationships!.relationships[0]!;
  const cell = report.evaluation!.outcomes!.assets[0]!.candidates[0]!.cells[0]!;
  assert.match(published!.text, new RegExp(`path_id=${escapeRegExp(pathId)}`));
  assert.match(published!.text, new RegExp(`metric path_id=${escapeRegExp(pathId)}; name=netReturn; unit=${metric.unit}; value=${metric.value}; complete=${metric.complete}; unknown_reason=${metric.unknownReason ?? "none"}`));
  assert.match(published!.text, new RegExp(`fill path_id=${escapeRegExp(pathId)}; id=${escapeRegExp(fill.id)}`));
  assert.match(published!.text, new RegExp(`episode path_id=${escapeRegExp(pathId)}; id=${escapeRegExp(episode.id)}`));
  assert.match(published!.text, new RegExp(`fifo path_id=${escapeRegExp(pathId)}; id=${escapeRegExp(fifo.id)}`));
  assert.match(published!.text, new RegExp(`relationship path_id=${escapeRegExp(pathId)}; kind=${relationship.relationshipKind}`));
  assert.match(published!.text, new RegExp(`evaluator_cell asset=BTC; scenario=COMBINED_MINUS_EARLY_THESIS_FAILURE; timing=${cell.timing}; cost=${cell.costId}; delta_net_return_unit=${cell.deltas.netReturn.unit}`));
  assert.match(published!.text, /initial_commitment run_id=101; run_url=https:\/\/github.com\/joyshu93\/AutoTarde_Upbit\/actions\/runs\/101/);
  assert.match(published!.text, /closure_commitment run_id=202; run_url=https:\/\/github.com\/joyshu93\/AutoTarde_Upbit\/actions\/runs\/202/);
  assert.match(published!.text, /RESEARCH ONLY; NOT DEPLOYMENT APPROVAL/);
  assert.doesNotMatch(published!.text, /deployment is approved/i);

  const publicationRoot = await mkdtemp(path.join(tmpdir(), "prospective-shadow-e2e-publication-"));
  try {
    const publicationDirectory = path.join(publicationRoot, "docs", "research", "prospective-shadow", "reports", "PCS-2026-001");
    await publishProspectiveComponentShadowReport({ repositoryRoot: publicationRoot, directoryPath: publicationDirectory, json: published!.json, text: published!.text, randomSuffix: () => "e2e" });
    assert.equal(await readFile(path.join(publicationDirectory, "report.json"), "utf8"), published!.json);
    assert.equal(await readFile(path.join(publicationDirectory, "report.txt"), "utf8"), published!.text);
  } finally { await rm(publicationRoot, { recursive: true, force: true }); }
});

test("final report detaches every raw evidence category before later asynchronous reads can mutate it", async () => {
  const fixture = finalEvidenceFixture();
  const originalPayloadSha256 = fixture.registration.payloadSha256;
  const events: string[] = [];
  let published = "";
  await runProspectiveComponentShadowCli(finalOptions(fixture.registration, 1), finalDependencies(fixture, events, async ({ json }) => { published = json; }, true));
  const report = JSON.parse(published);
  assert.equal(report.registration.payloadSha256, originalPayloadSha256);
  assert.equal(report.provenance.evidence.initialMetadata.repository, PROSPECTIVE_SHADOW_REPOSITORY);
  assert.equal(report.provenance.evidence.initialManualVerification.repository, PROSPECTIVE_SHADOW_REPOSITORY);
  assert.equal(report.provenance.evidence.closureMetadata.repository, PROSPECTIVE_SHADOW_REPOSITORY);
  assert.equal(report.provenance.evidence.closureManualVerification.repository, PROSPECTIVE_SHADOW_REPOSITORY);
  assert.equal(report.provenance.evidence.datasets.BTC.datasetProvenance.asset, "BTC");
  assert.equal(report.provenance.evidence.datasets.ETH.sidecarProvenance.asset, "ETH");
  assert.equal(fixture.initialMetadata.repository, "mutated-authority");
  assert.equal(fixture.datasets.BTC.provenance.asset, "ETH");
  assert.equal(fixture.sidecars.ETH.provenance.asset, "BTC");
});

function fixtureRegistration(): ProspectiveShadowRegistration {
  return createProspectiveShadowRegistration({
    registeredAt: "2026-08-20T00:00:00Z",
    implementationCommitSha: IMPLEMENTATION,
    developmentAuthoritySha256: "a".repeat(64),
    retrospectiveReportSha256: "b".repeat(64),
    policyManifest: structuredClone(PROSPECTIVE_SHADOW_POLICY_MANIFEST),
  });
}

function dependencies(events: string[], registration = fixtureRegistration()): ProspectiveComponentShadowCliDependencies {
  return {
    repositoryRoot: "C:/synthetic-repository",
    now: () => { events.push("now"); return new Date("2026-08-20T00:00:00Z"); },
    publishRegistration: async ({ registeredAt }) => {
      events.push(`publish:${registeredAt}`);
      return { registration, registrationBytes: JSON.stringify(registration), registryBytes: "registered\n" } as never;
    },
    appendAbandonment: async ({ abandonedAt }) => {
      events.push(`abandon:${abandonedAt}`);
      return {} as never;
    },
    readRegistration: async () => { events.push("read-registration"); return registration; },
    readInspection: async () => {
      events.push("read-inspection");
      return {
        registrationBytes: serializeProspectiveShadowRegistration(registration),
        registryBytes: serializeProspectiveShadowRegistryEvent({ schemaVersion: 1, authority: registration.authority, experimentId: registration.experimentId, event: "REGISTERED", eventAt: registration.registeredAt, registrationPayloadSha256: registration.payloadSha256 }),
        markerPresent: false,
      };
    },
    verifyImplementationCheckout: async () => { events.push("verify-checkout"); },
    readImplementationCheckoutSha: async () => { events.push("checkout"); return registration.implementationCommitSha; },
    readEvidenceJson: async () => { events.push("read-evidence"); return validEvidenceObject(registration); },
    readGitEvidence: async () => { events.push("read-git"); return {} as never; },
    readDataset: async () => { events.push("read-dataset"); return {} as never; },
    readNoTradeEvidence: async () => { events.push("read-sidecar"); return {} as never; },
    buildReplay: async () => { events.push("replay"); return { pathEvidence: [] } as never; },
    evaluate: () => syntheticFinalReport(registration, "INSUFFICIENT") as never,
    publishReport: async ({ directoryPath }) => { events.push(`publish-report:${directoryPath}`); },
  };
}

function finalOptions(registration: ProspectiveShadowRegistration, minimumCompletedCandles = 200) {
  return parseProspectiveComponentShadowArgs([
    "evaluate", "--as-of", registration.window.to,
    "--btc-dataset", "btc.json", "--eth-dataset", "eth.json",
    "--btc-sidecar", "btc.sidecar.json", "--eth-sidecar", "eth.sidecar.json",
    "--initial-metadata", "initial.json", "--initial-manual-verification", "initial-manual.json",
    "--closure-metadata", "closure.json", "--closure-manual-verification", "closure-manual.json",
    "--implementation-checkout-sha", IMPLEMENTATION,
    "--minimum-completed-candles-1h", String(minimumCompletedCandles), "--minimum-completed-candles-4h", String(minimumCompletedCandles), "--minimum-completed-candles-1d", String(minimumCompletedCandles),
    "--required-feature-lookback-candles", String(minimumCompletedCandles),
  ]);
}

function validEvidenceObject(registration: ProspectiveShadowRegistration): unknown {
  return { registrationPayloadSha256: registration.payloadSha256 };
}

function syntheticFinalReport(registration: ProspectiveShadowRegistration, status: "INSUFFICIENT"): ProspectiveComponentShadowReport {
  return {
    schemaVersion: 1 as const,
    authority: registration.authority,
    experimentId: registration.experimentId,
    phase: "FINAL" as const,
    asOf: registration.window.to,
    window: registration.window,
    calendar: { windowComplete: true },
    registration: { payloadSha256: registration.payloadSha256, implementationCommitSha: registration.implementationCommitSha },
    outcomes: { assets: registration.matrix.assets.map(({ asset, market }) => ({
      asset, market, candidates: (["COMBINED_MINUS_EARLY_THESIS_FAILURE", "COMBINED_MINUS_COOLDOWN_CONTROL"] as const).map((scenario) => ({
        scenario, referenceScenario: "COMBINED_CONSERVATIVE", status, reasonCodes: ["INCOMPLETE_EVIDENCE"], reasonDetails: [{ code: "INCOMPLETE_EVIDENCE", detail: "Synthetic incomplete evidence." }], incompleteGates: ["CADENCE"], cells: [],
      })),
    })) },
    replay: null,
    evaluation: null,
    inspection: null,
    safety: { readOnly: true as const, causalClaim: false as const, deploymentApproval: false as const, liveApproval: false as const, boundary: "Research-only evidence." },
    provenance: { datasetChecksums: { BTC: sha256("btc"), ETH: sha256("eth") }, sidecarChecksums: { BTC: sha256("btc-sidecar"), ETH: sha256("eth-sidecar") }, pathFingerprints: { BTC: sha256("btc-path"), ETH: sha256("eth-path") }, commitmentAssurance: "HUMAN_VERIFIED_PUBLIC_GITHUB_RUN" as const, cryptographicallyVerified: false as const, evidence: null },
  };
}

function optionsToArgv(options: ReturnType<typeof parseProspectiveComponentShadowArgs>): string[] {
  if (options.command !== "register") throw new Error("Expected register options.");
  return ["register", "--implementation-commit-sha", options.implementationCommitSha, "--development-authority-sha256", options.developmentAuthoritySha256, "--retrospective-report-sha256", options.retrospectiveReportSha256];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function registeredRegistryBytes(registration: ProspectiveShadowRegistration): string {
  return serializeProspectiveShadowRegistryEvent({
    schemaVersion: 1,
    authority: registration.authority,
    experimentId: registration.experimentId,
    event: "REGISTERED",
    eventAt: registration.registeredAt,
    registrationPayloadSha256: registration.payloadSha256,
  });
}

function reportFileSystem(overrides: Partial<ProspectiveComponentShadowReportFileSystem>): ProspectiveComponentShadowReportFileSystem {
  return {
    realpath: async (value) => (await import("node:fs/promises")).realpath(value),
    mkdir: async (value, options) => mkdir(value, options),
    lstat: async (value) => lstat(value),
    readFile: async (value, encoding) => readFile(value, encoding),
    writeFile: async (value, bytes, options) => writeFile(value, bytes, options),
    unlink: async (value) => unlink(value),
    rename: async (from, to) => rename(from, to),
    rm: async (value, options) => rm(value, options),
    ...overrides,
  };
}

function checkoutRunner(
  commands: string[][],
  state: Readonly<{ status?: string; dirty?: string }>,
): ReadOnlyCheckoutCommandRunner {
  return {
    run: async (args) => {
      commands.push([...args]);
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: `${IMPLEMENTATION}\n`, stderr: "" };
      if (args[0] === "diff" && state.dirty === "tracked") return { exitCode: 1, stdout: "", stderr: "tracked dirty" };
      if (args[0] === "diff" && args[1] === "--cached" && state.dirty === "staged") return { exitCode: 1, stdout: "", stderr: "staged dirty" };
      if (args[0] === "status") return { exitCode: 0, stdout: state.dirty?.startsWith("??") ? state.dirty : state.status ?? "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

function finalEvidenceFixture() {
  const registration = createProspectiveShadowRegistration({
    registeredAt: "2026-01-01T00:00:00Z",
    implementationCommitSha: IMPLEMENTATION,
    developmentAuthoritySha256: "a".repeat(64),
    retrospectiveReportSha256: "b".repeat(64),
    policyManifest: structuredClone(PROSPECTIVE_SHADOW_POLICY_MANIFEST),
  });
  const registrationBytes = serializeProspectiveShadowRegistration(registration);
  const registryBytes = registeredRegistryBytes(registration);
  const initialRunUrl = `https://github.com/${PROSPECTIVE_SHADOW_REPOSITORY}/actions/runs/101`;
  const closureRunUrl = `https://github.com/${PROSPECTIVE_SHADOW_REPOSITORY}/actions/runs/202`;
  const initialMetadata = {
    schemaVersion: 1 as const, authority: registration.authority, mode: "REGISTERED_PUBLICATION" as const,
    repository: PROSPECTIVE_SHADOW_REPOSITORY, branch: PROSPECTIVE_SHADOW_BRANCH, runId: 101, runUrl: initialRunUrl,
    serverCreatedAt: "2026-01-01T01:00:00Z", implementationCommitSha: IMPLEMENTATION, publicationCommitSha: PUBLICATION, headSha: PUBLICATION,
    registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH, registryPath: PROSPECTIVE_SHADOW_REGISTRY_PATH, workflowPath: PROSPECTIVE_SHADOW_WORKFLOW_PATH,
    registrationPayloadSha256: registration.payloadSha256,
  };
  const initialManual = {
    confirmation: PROSPECTIVE_SHADOW_INITIAL_CONFIRMATION, verifiedAt: "2026-01-01T01:01:00Z", runUrl: initialRunUrl,
    repository: PROSPECTIVE_SHADOW_REPOSITORY, branch: PROSPECTIVE_SHADOW_BRANCH, runId: 101, implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION, registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH, registrationPayloadSha256: registration.payloadSha256,
  };
  const history = [{
    commitSha: PUBLICATION, parents: [IMPLEMENTATION], changedPaths: [PROSPECTIVE_SHADOW_REGISTRATION_PATH, PROSPECTIVE_SHADOW_REGISTRY_PATH],
    registration: { status: "PRESENT" as const, bytes: registrationBytes }, registry: { status: "PRESENT" as const, bytes: registryBytes }, workflowBytes: "name: prospective-shadow\n",
  }];
  const closureMetadata = {
    schemaVersion: 1 as const, authority: registration.authority, mode: "CLOSURE" as const,
    repository: PROSPECTIVE_SHADOW_REPOSITORY, branch: PROSPECTIVE_SHADOW_BRANCH, runId: 202, runUrl: closureRunUrl,
    serverCreatedAt: registration.window.to, implementationCommitSha: IMPLEMENTATION, publicationCommitSha: PUBLICATION, headSha: "3".repeat(40),
    registrationPath: PROSPECTIVE_SHADOW_REGISTRATION_PATH, registryPath: PROSPECTIVE_SHADOW_REGISTRY_PATH, workflowPath: PROSPECTIVE_SHADOW_WORKFLOW_PATH,
    registrationPayloadSha256: registration.payloadSha256, closureTipSha: "3".repeat(40), registryClassification: "ACTIVE_AT_CLOSE" as const,
    registrySha256: sha256(registryBytes), relevantPathHistory: history, abandonmentMetadata: null,
  };
  const closureManual = {
    confirmation: PROSPECTIVE_SHADOW_CLOSURE_CONFIRMATION, verifiedAt: registration.window.to, runUrl: closureRunUrl,
    repository: PROSPECTIVE_SHADOW_REPOSITORY, branch: PROSPECTIVE_SHADOW_BRANCH, runId: 202, implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION, closureTipSha: "3".repeat(40), registrySha256: sha256(registryBytes), latestRelevantPathCommitSha: PUBLICATION, noLaterRelevantPathCommit: true as const,
  };
  const datasets = Object.fromEntries(registration.matrix.assets.map(({ asset, market }) => [asset, finalDataset(asset, market, registration)])) as Record<"BTC" | "ETH", ReturnType<typeof finalDataset>>;
  const sidecars = Object.fromEntries(Object.entries(datasets).map(([asset, dataset]) => [asset, finalSidecar(dataset, registration)])) as Record<"BTC" | "ETH", ReturnType<typeof finalSidecar>>;
  return {
    registration, registrationBytes, registryBytes, initialMetadata, initialManual, closureMetadata, closureManual, datasets, sidecars, gitInputs: [] as Array<Record<string, string>>,
    initialGitEvidence: {
      mode: "REGISTERED_PUBLICATION" as const, currentHeadSha: IMPLEMENTATION, publicationCommitSha: PUBLICATION, publicationParents: [IMPLEMENTATION],
      publicationChangedPaths: [PROSPECTIVE_SHADOW_REGISTRATION_PATH, PROSPECTIVE_SHADOW_REGISTRY_PATH],
      registrationAtImplementation: { status: "MISSING" as const, exitCode: 128, stderr: "missing" }, registryAtImplementation: { status: "MISSING" as const, exitCode: 128, stderr: "missing" },
      registrationBytes, registryBytes, workflowAtImplementationBytes: "name: prospective-shadow\n", workflowAtPublicationBytes: "name: prospective-shadow\n",
    },
    closureGitEvidence: {
      mode: "CLOSURE" as const, currentHeadSha: IMPLEMENTATION, publicationCommitSha: PUBLICATION, closureTipSha: "3".repeat(40), publicationIsAncestorOfClosureTip: true,
      registrationAtPublicationBytes: registrationBytes, registrationAtClosureBytes: registrationBytes, registryAtClosureBytes: registryBytes,
      workflowAtImplementationBytes: "name: prospective-shadow\n", workflowAtClosureBytes: "name: prospective-shadow\n", relevantPathHistory: history,
    },
  };
}

function finalDependencies(
  fixture: ReturnType<typeof finalEvidenceFixture>,
  events: string[],
  publish: ProspectiveComponentShadowCliDependencies["publishReport"],
  mutate = false,
  exerciseProductionBuilder = false,
): ProspectiveComponentShadowCliDependencies {
  const mutateRaw = () => {
    fixture.initialMetadata.repository = "mutated-authority" as never;
    fixture.initialManual.repository = "mutated-authority" as never;
    fixture.closureMetadata.repository = "mutated-authority" as never;
    fixture.closureManual.repository = "mutated-authority" as never;
    fixture.datasets.BTC.provenance.asset = "ETH";
    fixture.datasets.ETH.provenance.asset = "BTC";
    fixture.sidecars.BTC.provenance.asset = "ETH";
    fixture.sidecars.ETH.provenance.asset = "BTC";
    fixture.initialGitEvidence.registrationBytes = "{}";
    fixture.initialGitEvidence.registryBytes = "mutated\n";
    fixture.closureGitEvidence.registrationAtClosureBytes = "{}";
    fixture.closureGitEvidence.registryAtClosureBytes = "mutated\n";
  };
  return {
    ...dependencies(events, fixture.registration),
    readInspection: async () => { events.push("read-inspection"); throw new Error("final evaluation must not inspect the current checkout"); },
    verifyImplementationCheckout: async () => { events.push("verify-checkout"); },
    readImplementationCheckoutSha: async () => { events.push("checkout"); return IMPLEMENTATION; },
    readEvidenceJson: async (filePath) => {
      if (filePath === "initial.json") { events.push("initial-metadata"); return fixture.initialMetadata; }
      if (filePath === "initial-manual.json") { events.push("initial-manual"); return fixture.initialManual; }
      if (filePath === "closure.json") { events.push("closure-metadata"); return fixture.closureMetadata; }
      events.push("closure-manual"); return fixture.closureManual;
    },
    readGitEvidence: async (input) => {
      const { mode } = input;
      events.push(mode === "REGISTERED_PUBLICATION" ? "initial-git" : "closure-git");
      fixture.gitInputs.push(structuredClone(input) as Record<string, string>);
      return mode === "REGISTERED_PUBLICATION" ? fixture.initialGitEvidence : fixture.closureGitEvidence;
    },
    readDataset: async (filePath) => { events.push(`dataset:${filePath}`); return fixture.datasets[filePath === "btc.json" ? "BTC" : "ETH"]; },
    readNoTradeEvidence: async (filePath) => { events.push(`sidecar:${filePath}`); return fixture.sidecars[filePath === "btc.sidecar.json" ? "BTC" : "ETH"]; },
    buildReplay: async (input) => {
      events.push("replay");
      if (mutate) mutateRaw();
      if (exerciseProductionBuilder) {
        const btc = input.datasets.find((entry) => entry.asset === "BTC");
        if (btc === undefined) throw new Error("Canonical E2E fixture requires BTC dataset evidence.");
        const frames = input.frameBuilder({
          asset: "BTC",
          market: "KRW-BTC",
          dataset: btc.dataset,
          featureWarmupStartAt: input.registration.window.from,
          decisionFrom: hoursAfter(input.registration.window.to, -24),
          decisionTo: input.registration.window.to,
          minimumCompletedCandles: input.minimumCompletedCandles,
        });
        events.push(`production-frames:${frames.length}`);
        if (frames.length === 0) throw new Error("CLI-provided PositionGuard frame builder returned no frames for complete fixture candles.");
      }
      return buildProspectiveShadowReplayEvidence({ ...input, frameBuilder: (request) => [entryFrame(request.decisionFrom), reduceFrame(hoursAfter(request.decisionFrom, 1)), exitFrame(hoursAfter(request.decisionFrom, 2))] });
    },
    evaluate: (input) => { events.push("evaluate"); return evaluateProspectiveComponentShadow(input); },
    publishReport: publish,
  };
}

function finalDataset(asset: "BTC" | "ETH", market: "KRW-BTC" | "KRW-ETH", registration: ProspectiveShadowRegistration) {
  const withoutChecksum = {
    provenance: { schemaVersion: 1 as const, asset, market, historyStartAt: registration.policyManifest.featureWarmupStartAt, endAt: registration.window.to, collectedAt: hoursAfter(registration.window.to, 1), source: "canonical-test-fixture" },
    candles: {
      "1h": [candle(market, registration.policyManifest.featureWarmupStartAt), ...hoursBetween(registration.window.from, registration.window.to).map((at) => candle(market, at))],
      "4h": [candle(market, registration.window.from, "4h")],
      "1d": [candle(market, registration.window.from, "1d")],
    },
  };
  return { ...withoutChecksum, provenance: { ...withoutChecksum.provenance, sha256: calculateResearchCandleDatasetChecksum(withoutChecksum) } };
}

function finalSidecar(dataset: ReturnType<typeof finalDataset>, registration: ProspectiveShadowRegistration) {
  const withoutChecksum = {
    provenance: { schemaVersion: 1 as const, evidenceKind: "INDEPENDENT_NO_TRADE_EVIDENCE_V1" as const, asset: dataset.provenance.asset, market: dataset.provenance.market, parentDatasetSha256: dataset.provenance.sha256, from: dataset.provenance.historyStartAt, to: dataset.provenance.endAt, source: "canonical-test-sidecar", lowerTimeframe: "1m" as const, collectorVersion: "test", collectedAt: dataset.provenance.collectedAt },
    querySegments: [{ from: dataset.provenance.historyStartAt, to: dataset.provenance.endAt, paginationComplete: true, responseFingerprint: "d".repeat(64) }],
    verifiedNoTradeRanges: [{ from: hoursAfter(registration.policyManifest.featureWarmupStartAt, 1), to: registration.window.from }],
  };
  return { ...withoutChecksum, provenance: { ...withoutChecksum.provenance, sha256: computeResearchNoTradeEvidenceSha256(withoutChecksum) } };
}

function candle(market: "KRW-BTC" | "KRW-ETH", openTime: string, timeframe: "1h" | "4h" | "1d" = "1h") {
  const durationHours = timeframe === "1h" ? 1 : timeframe === "4h" ? 4 : 24;
  return { market, timeframe, openTime, closeTime: hoursAfter(openTime, durationHours), openPrice: 100_000, highPrice: 100_000, lowPrice: 100_000, closePrice: 100_000, volume: 1, quoteVolume: 100_000 };
}

function hoursBetween(from: string, to: string): string[] {
  const values: string[] = [];
  for (let at = Date.parse(from); at < Date.parse(to); at += 3_600_000) values.push(new Date(at).toISOString());
  return values;
}

function hoursAfter(value: string, hours: number): string { return new Date(Date.parse(value) + hours * 3_600_000).toISOString(); }

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function baseFrame(generatedAt: string): PositionGuardBacktestFrame {
  return { generatedAt, analysis: { regime: "RANGE", riskLevel: "LOW", invalidationState: "CLEAR", invalidationLevel: 95_000, pullbackZone: false, reclaimStructure: false, breakoutHoldStructure: false, upperRangeChase: false, currentPrice: 100_000, entryPath: "NONE", trendAlignmentScore: 0, recoveryQualityScore: 0, breakdownPressureScore: 0, weakeningStage: "NONE", breakdown1d: false, breakdown4h: false, failedReclaim: false, bearishMomentumExpansion: false, volumeRecovery: false, macdImproving: false, rsiRecovery: false, atrShock: false, averageEntryPrice: 0, pnlPct: 0, oneHourLocation: "MIDDLE", fourHourLocation: "MIDDLE" }, source: { candleCounts: { "1h": 1, "4h": 1, "1d": 1 }, latestCloseTime: { "1h": generatedAt, "4h": generatedAt, "1d": generatedAt } } };
}

function entryFrame(at: string): PositionGuardBacktestFrame { const frame = baseFrame(at); return { ...frame, analysis: { ...frame.analysis, regime: "BULL_TREND", entryPath: "RECLAIM", reclaimStructure: true, trendAlignmentScore: 4, recoveryQualityScore: 4, volumeRecovery: true, macdImproving: true, rsiRecovery: true } }; }
function reduceFrame(at: string): PositionGuardBacktestFrame { const frame = baseFrame(at); return { ...frame, analysis: { ...frame.analysis, currentPrice: 110_000, weakeningStage: "SOFT", upperRangeChase: true, breakdownPressureScore: 2 } }; }
function exitFrame(at: string): PositionGuardBacktestFrame { const frame = baseFrame(at); return { ...frame, analysis: { ...frame.analysis, regime: "BREAKDOWN_RISK", currentPrice: 90_000, invalidationState: "BROKEN", breakdown1d: true, breakdown4h: true, bearishMomentumExpansion: true } }; }
