import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PROSPECTIVE_SHADOW_BRANCH,
  PROSPECTIVE_SHADOW_REGISTRATION_PATH,
  PROSPECTIVE_SHADOW_REPOSITORY,
  PROSPECTIVE_SHADOW_REGISTRY_PATH,
  PROSPECTIVE_SHADOW_WORKFLOW_PATH,
  validateProspectiveShadowAbandonmentStructure,
  validateProspectiveShadowClosureStructure,
  validateProspectiveShadowPublicationStructure,
  validateProspectiveShadowPersistedWorkflowMetadata,
  validateProspectiveShadowWorkflowMetadata,
  type ProspectiveShadowActionsRun,
  type ProspectiveShadowWorkflowContext,
  type ProspectiveShadowWorkflowMetadata,
  type ProspectiveShadowWorkflowMode,
  type ProspectiveShadowClosureMetadata,
} from "../modules/performance/performance-prospective-shadow-commitment.js";
import {
  PROSPECTIVE_SHADOW_MIN_PUBLICATION_LEAD_MS,
  parseProspectiveShadowRegistry,
  validateProspectiveShadowRegistration,
} from "../modules/performance/performance-prospective-shadow-registration.js";
import {
  compareEpochNanoseconds,
  parsePerformanceTimestamp,
} from "../modules/performance/performance-timestamp.js";
import {
  createReadOnlyGitRunner,
  readProspectiveShadowGitEvidence,
  type ReadOnlyGitRunner,
} from "./prospective-shadow-git-commitment-reader.js";

const ARGUMENT_KEYS = [
  "mode", "github-run-json", "output", "repository", "branch", "run-id", "run-url",
  "head-sha", "implementation-commit-sha", "publication-commit-sha",
  "abandonment-metadata",
] as const;
type ArgumentKey = typeof ARGUMENT_KEYS[number];
const ARGUMENT_SET = new Set<string>(ARGUMENT_KEYS);

export type ProspectiveShadowCommitmentCliOptions = Readonly<{
  mode: ProspectiveShadowWorkflowMode;
  githubRunJsonPath: string;
  outputPath: string;
  repository: string;
  branch: string;
  runId: number;
  runUrl: string;
  headSha: string;
  implementationCommitSha: string;
  publicationCommitSha: string;
  abandonmentMetadataPath?: string;
}>;

export type ProspectiveShadowCommitmentCliDependencies = Readonly<{
  cwd: string;
  readTextFile: (filePath: string) => Promise<string>;
  writeOutput: (filePath: string, bytes: string) => Promise<void>;
  gitRunner: ReadOnlyGitRunner;
}>;

type ModeSpecificWorkflowMetadata<M extends ProspectiveShadowWorkflowMode> =
  Omit<ProspectiveShadowWorkflowMetadata, "mode"> & Readonly<{ mode: M }>;

export type ProspectiveShadowCommitmentOutput =
  | ModeSpecificWorkflowMetadata<"REGISTERED_PUBLICATION">
  | (ModeSpecificWorkflowMetadata<"ABANDONED"> & Readonly<{
      mode: "ABANDONED";
      abandonmentCommitSha: string;
      registrySha256: string;
    }>)
  | ProspectiveShadowClosureMetadata;

export function parseProspectiveShadowCommitmentArgs(
  argv: readonly string[],
): ProspectiveShadowCommitmentCliOptions {
  const values = new Map<ArgumentKey, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) throw new Error(`Unexpected argument ${token ?? "<missing>"}.`);
    const key = token.slice(2);
    if (!ARGUMENT_SET.has(key)) throw new Error(`Unknown argument --${key}.`);
    const typedKey = key as ArgumentKey;
    if (values.has(typedKey)) throw new Error(`Duplicate argument --${key}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    values.set(typedKey, value);
    index += 1;
  }
  const mode = requireMode(requireArgument(values, "mode"));
  return {
    mode,
    githubRunJsonPath: requireNonEmpty(requireArgument(values, "github-run-json"), "--github-run-json"),
    outputPath: requireNonEmpty(requireArgument(values, "output"), "--output"),
    repository: requireArgument(values, "repository"),
    branch: requireArgument(values, "branch"),
    runId: requireRunId(requireArgument(values, "run-id")),
    runUrl: requireArgument(values, "run-url"),
    headSha: requireCommit(requireArgument(values, "head-sha"), "--head-sha"),
    implementationCommitSha: requireCommit(requireArgument(values, "implementation-commit-sha"), "--implementation-commit-sha"),
    publicationCommitSha: requireCommit(requireArgument(values, "publication-commit-sha"), "--publication-commit-sha"),
    ...(values.has("abandonment-metadata")
      ? { abandonmentMetadataPath: requireNonEmpty(values.get("abandonment-metadata") ?? "", "--abandonment-metadata") }
      : {}),
  };
}

export function buildProspectiveShadowWorkflowMetadata(input: {
  readonly context: ProspectiveShadowWorkflowContext;
  readonly actionsRunJson: string;
}): ProspectiveShadowWorkflowMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.actionsRunJson);
  } catch {
    throw new Error("GitHub Actions own-run response must be valid JSON.");
  }
  return validateProspectiveShadowWorkflowMetadata({
    context: input.context,
    actionsRun: parsed as ProspectiveShadowActionsRun,
  });
}

export async function runProspectiveShadowCommitmentCli(
  options: ProspectiveShadowCommitmentCliOptions,
  dependencies: ProspectiveShadowCommitmentCliDependencies,
): Promise<ProspectiveShadowCommitmentOutput> {
  const registrationBytes = await dependencies.readTextFile(path.join(dependencies.cwd, PROSPECTIVE_SHADOW_REGISTRATION_PATH));
  let registrationJson: unknown;
  try {
    registrationJson = JSON.parse(registrationBytes);
  } catch {
    throw new Error("Canonical prospective registration must be valid JSON.");
  }
  const registration = validateProspectiveShadowRegistration(registrationJson);
  const actionsRunJson = await dependencies.readTextFile(options.githubRunJsonPath);
  const context: ProspectiveShadowWorkflowContext = {
    mode: options.mode,
    repository: options.repository,
    branch: options.branch,
    runId: options.runId,
    runUrl: options.runUrl,
    headSha: options.headSha,
    implementationCommitSha: options.implementationCommitSha,
    publicationCommitSha: options.publicationCommitSha,
    registrationPayloadSha256: registration.payloadSha256,
  };
  const metadata = buildProspectiveShadowWorkflowMetadata({ context, actionsRunJson });
  let output: ProspectiveShadowCommitmentOutput;

  if (options.mode === "REGISTERED_PUBLICATION") {
    const evidence = await readProspectiveShadowGitEvidence({
      mode: "REGISTERED_PUBLICATION",
      implementationCommitSha: options.implementationCommitSha,
      publicationCommitSha: options.publicationCommitSha,
    }, dependencies.gitRunner);
    if (evidence.mode !== "REGISTERED_PUBLICATION") throw new Error("Unexpected Git evidence mode.");
    if (evidence.currentHeadSha !== options.headSha) throw new Error("Workflow checkout HEAD must match GitHub head SHA.");
    validateProspectiveShadowPublicationStructure(registration, evidence, { requireImplementationCheckout: false });
    assertMinimumPublicLead(metadata.serverCreatedAt, registration.window.from);
    output = deepFreeze({ ...metadata, mode: "REGISTERED_PUBLICATION" });
  } else if (options.mode === "ABANDONED") {
    const evidence = await readProspectiveShadowGitEvidence({
      mode: "ABANDONED",
      implementationCommitSha: options.implementationCommitSha,
      publicationCommitSha: options.publicationCommitSha,
      abandonmentCommitSha: options.headSha,
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
    output = deepFreeze({
      ...metadata,
      mode: "ABANDONED",
      abandonmentCommitSha: evidence.abandonmentCommitSha,
      registrySha256: sha256Bytes(evidence.registryAtAbandonmentBytes),
    });
  } else {
    const evidence = await readProspectiveShadowGitEvidence({
      mode: "CLOSURE",
      implementationCommitSha: options.implementationCommitSha,
      publicationCommitSha: options.publicationCommitSha,
      closureTipSha: options.headSha,
    }, dependencies.gitRunner);
    if (evidence.mode !== "CLOSURE") throw new Error("Unexpected Git evidence mode.");
    if (evidence.currentHeadSha !== options.headSha) throw new Error("Workflow checkout HEAD must match GitHub head SHA.");
    const registry = validateProspectiveShadowClosureStructure(registration, evidence, { requireImplementationCheckout: false });
    assertTimestampOrder(metadata.serverCreatedAt, registration.window.to, "AT_OR_AFTER");
    const registrySha256 = sha256Bytes(evidence.registryAtClosureBytes);
    let abandonmentMetadata: ProspectiveShadowWorkflowMetadata | null = null;
    if (registry.abandoned) {
      if (options.abandonmentMetadataPath === undefined) {
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
        windowTo: registration.window.to,
      });
    } else if (options.abandonmentMetadataPath !== undefined) {
      throw new Error("Active closure must not provide --abandonment-metadata.");
    }
    output = deepFreeze({
      ...metadata,
      mode: "CLOSURE",
      closureTipSha: evidence.closureTipSha,
      registryClassification: registry.abandoned ? "ABANDONED" : "ACTIVE_AT_CLOSE",
      registrySha256,
      relevantPathHistory: [...evidence.relevantPathHistory],
      abandonmentMetadata,
    });
  }

  await dependencies.writeOutput(options.outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}

async function readAndValidateAbandonmentMetadata(input: Readonly<{
  filePath: string;
  readTextFile: (filePath: string) => Promise<string>;
  registrationPayloadSha256: string;
  implementationCommitSha: string;
  publicationCommitSha: string;
  latestRelevantCommitSha: string | undefined;
  registrySha256: string;
  windowTo: string;
}>): Promise<ProspectiveShadowWorkflowMetadata> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await input.readTextFile(input.filePath));
  } catch {
    throw new Error("Prior abandonment workflow metadata must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Prior abandonment workflow metadata must be an object.");
  }
  const record = structuredClone(parsed) as Record<string, unknown>;
  const abandonmentCommitSha = requireCommit(String(record.abandonmentCommitSha ?? ""), "abandonmentCommitSha");
  const registrySha256 = requireSha256(String(record.registrySha256 ?? ""), "registrySha256");
  delete record.abandonmentCommitSha;
  delete record.registrySha256;
  const metadata = validateProspectiveShadowPersistedWorkflowMetadata(
    record as ProspectiveShadowWorkflowMetadata,
    "ABANDONED",
  );
  if (abandonmentCommitSha !== metadata.headSha || abandonmentCommitSha !== input.latestRelevantCommitSha) {
    throw new Error("Prior abandonment commit must match its head SHA and the latest relevant Git commit.");
  }
  if (registrySha256 !== input.registrySha256) throw new Error("Prior abandonment registry SHA-256 does not match closure registry bytes.");
  if (metadata.registrationPayloadSha256 !== input.registrationPayloadSha256 ||
      metadata.implementationCommitSha !== input.implementationCommitSha ||
      metadata.publicationCommitSha !== input.publicationCommitSha) {
    throw new Error("Prior abandonment workflow metadata does not match the closure identity.");
  }
  assertTimestampOrder(metadata.serverCreatedAt, input.windowTo, "BEFORE");
  return metadata;
}

function createDefaultDependencies(cwd: string): ProspectiveShadowCommitmentCliDependencies {
  return {
    cwd,
    readTextFile: (filePath) => readFile(filePath, "utf8"),
    writeOutput: (filePath, bytes) => writeFile(filePath, bytes, { encoding: "utf8", flag: "wx" }),
    gitRunner: createReadOnlyGitRunner(cwd),
  };
}

async function main(): Promise<void> {
  const options = parseProspectiveShadowCommitmentArgs(process.argv.slice(2));
  const output = await runProspectiveShadowCommitmentCli(options, createDefaultDependencies(process.cwd()));
  console.log(JSON.stringify(output, null, 2));
}

function requireArgument(values: ReadonlyMap<ArgumentKey, string>, key: ArgumentKey): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Missing required argument --${key}.`);
  return value;
}

function requireMode(value: string): ProspectiveShadowWorkflowMode {
  if (value !== "REGISTERED_PUBLICATION" && value !== "ABANDONED" && value !== "CLOSURE") {
    throw new Error("--mode must be REGISTERED_PUBLICATION, ABANDONED, or CLOSURE.");
  }
  return value;
}

function requireNonEmpty(value: string, label: string): string {
  if (value.trim() === "") throw new Error(`${label} must be non-empty.`);
  return value;
}

function requireRunId(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error("--run-id must be a positive safe integer.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("--run-id must be a positive safe integer.");
  return parsed;
}

function requireCommit(value: string, label: string): string {
  if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(`${label} must be a lowercase 40-character Git commit SHA.`);
  return value;
}

function requireSha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}

function assertTimestampOrder(actual: string, boundary: string, relation: "BEFORE" | "AT_OR_AFTER"): void {
  const a = parsePerformanceTimestamp(actual);
  const b = parsePerformanceTimestamp(boundary);
  if (!a || !b) throw new Error("Commitment timing values are invalid.");
  const comparison = compareEpochNanoseconds(a.epochNanoseconds, b.epochNanoseconds);
  if (relation === "BEFORE" && comparison >= 0) throw new Error("Workflow server-created run must be before the registered boundary.");
  if (relation === "AT_OR_AFTER" && comparison < 0) throw new Error("Closure workflow run must be at or after the registered window end.");
}

function assertMinimumPublicLead(actual: string, boundary: string): void {
  const actualTimestamp = parsePerformanceTimestamp(actual);
  const boundaryTimestamp = parsePerformanceTimestamp(boundary);
  if (!actualTimestamp || !boundaryTimestamp) {
    throw new Error("Workflow commitment timestamps must be valid ISO-8601 values.");
  }
  const leadNanoseconds = boundaryTimestamp.epochNanoseconds - actualTimestamp.epochNanoseconds;
  if (leadNanoseconds < BigInt(PROSPECTIVE_SHADOW_MIN_PUBLICATION_LEAD_MS) * 1_000_000n) {
    throw new Error("Publication workflow requires at least 48 hours of public lead time.");
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

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(`Prospective shadow commitment validation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
