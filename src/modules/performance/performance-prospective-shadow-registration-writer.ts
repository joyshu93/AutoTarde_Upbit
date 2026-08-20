import { lstat, mkdir, readFile, realpath, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  PROSPECTIVE_SHADOW_AUTHORITY,
  PROSPECTIVE_SHADOW_EXPERIMENT_ID,
  createProspectiveShadowRegistration,
  parseProspectiveShadowRegistry,
  serializeProspectiveShadowRegistration,
  serializeProspectiveShadowRegistryEvent,
  validateProspectiveShadowRegistration,
  type CreateProspectiveShadowRegistrationInput,
  type ProspectiveShadowAbandonedEvent,
  type ProspectiveShadowRegistration,
  type ProspectiveShadowRegisteredEvent,
} from "./performance-prospective-shadow-registration.js";
import { parsePerformanceTimestamp } from "./performance-timestamp.js";

const REGISTRATION_FILE_NAME = "PCS-2026-001.registration.json";
const REGISTRY_FILE_NAME = "registry.jsonl";
const PUBLICATION_DIRECTORY_NAME = "prospective-shadow";
const PUBLICATION_MARKER_FILE_NAME = ".publication-in-progress";
const ABANDONMENT_LOCK_DIRECTORY_NAME = ".prospective-shadow.abandon.lock";
const LOCK_OWNER_FILE_NAME = "owner";
const SAFE_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ProspectiveShadowPathKind = "MISSING" | "DIRECTORY" | "SYMBOLIC_LINK" | "OTHER";

export interface ProspectiveShadowRegistrationFileSystem {
  pathKind(path: string): Promise<ProspectiveShadowPathKind>;
  realPath(path: string): Promise<string>;
  listDirectory(path: string): Promise<readonly string[]>;
  createDirectoryExclusive(path: string): Promise<void>;
  writeFileExclusive(path: string, bytes: string): Promise<void>;
  readUtf8(path: string): Promise<string>;
  replaceFileAtomic(stagedPath: string, finalPath: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  removeFile(path: string): Promise<void>;
}

export interface ProspectiveShadowRegistrationWriterDependencies {
  readonly now: () => string;
  readonly randomSuffix: () => string;
  readonly fs: ProspectiveShadowRegistrationFileSystem;
}

export type PublishProspectiveShadowRegistrationInput = Readonly<{
  repositoryRoot: string;
  implementationCommitSha: string;
  developmentAuthoritySha256: string;
  retrospectiveReportSha256: string;
  policyManifest: CreateProspectiveShadowRegistrationInput["policyManifest"];
}>;

export type PublishedProspectiveShadowRegistration = Readonly<{
  directoryPath: string;
  registrationPath: string;
  registryPath: string;
  registration: ProspectiveShadowRegistration;
  registrationBytes: string;
  registryBytes: string;
}>;

export type AppendProspectiveShadowAbandonmentInput = Readonly<{
  repositoryRoot: string;
  expectedRegistrationPayloadSha256: string;
  publicationCommitSha: string;
  reason: string;
}>;

export type PublishedProspectiveShadowAbandonment = Readonly<{
  registrationPath: string;
  registryPath: string;
  event: ProspectiveShadowAbandonedEvent;
  previousRegistryBytes: string;
  registryBytes: string;
  cleanupWarnings: readonly string[];
}>;

export class ProspectiveShadowRegistrationWriterError extends Error {
  readonly cleanupWarnings: readonly string[];

  constructor(operation: string, cause: unknown, cleanupWarnings: readonly string[]) {
    super(`Prospective shadow ${operation} failed: ${describeError(cause)}`, { cause });
    this.name = "ProspectiveShadowRegistrationWriterError";
    this.cleanupWarnings = Object.freeze([...cleanupWarnings]);
  }
}

export const nodeProspectiveShadowRegistrationFileSystem: ProspectiveShadowRegistrationFileSystem = {
  pathKind: inspectPathKind,
  realPath: realpath,
  listDirectory: async (path) => readdir(path),
  createDirectoryExclusive: async (path) => { await mkdir(path); },
  writeFileExclusive: async (path, bytes) => { await writeFile(path, bytes, { encoding: "utf8", flag: "wx" }); },
  readUtf8: readUtf8File,
  replaceFileAtomic: async (stagedPath, finalPath) => { await rename(stagedPath, finalPath); },
  removeDirectory: async (path) => { await rm(path, { recursive: true }); },
  removeFile: async (path) => { await unlink(path); },
};

export async function publishProspectiveShadowRegistration(
  input: PublishProspectiveShadowRegistrationInput,
  dependencies: ProspectiveShadowRegistrationWriterDependencies,
): Promise<PublishedProspectiveShadowRegistration> {
  const detachedInput = structuredClone(input);
  const registeredAt = dependencies.now();
  const suffix = requireSafeSuffix(dependencies.randomSuffix());
  const paths = publicationPaths(detachedInput.repositoryRoot);
  const owner = `${PROSPECTIVE_SHADOW_EXPERIMENT_ID}:${suffix}\n`;
  const registration = createProspectiveShadowRegistration({
    registeredAt,
    implementationCommitSha: detachedInput.implementationCommitSha,
    developmentAuthoritySha256: detachedInput.developmentAuthoritySha256,
    retrospectiveReportSha256: detachedInput.retrospectiveReportSha256,
    policyManifest: detachedInput.policyManifest,
  });
  const registrationBytes = serializeProspectiveShadowRegistration(registration);
  const registeredEvent: ProspectiveShadowRegisteredEvent = {
    schemaVersion: 1,
    authority: PROSPECTIVE_SHADOW_AUTHORITY,
    experimentId: PROSPECTIVE_SHADOW_EXPERIMENT_ID,
    event: "REGISTERED",
    eventAt: registration.registeredAt,
    registrationPayloadSha256: registration.payloadSha256,
  };
  const registryBytes = serializeProspectiveShadowRegistryEvent(registeredEvent);
  let directoryReserved = false;
  let directoryOwned = false;

  try {
    const rootRealPath = await ensureSafeResearchDirectory(paths, dependencies.fs);
    await reservePublicationDirectory(paths, rootRealPath, dependencies.fs);
    directoryReserved = true;
    await dependencies.fs.writeFileExclusive(paths.markerPath, owner);
    directoryOwned = true;
    await dependencies.fs.writeFileExclusive(paths.registrationPath, registrationBytes);
    await dependencies.fs.writeFileExclusive(paths.registryPath, registryBytes);
    await verifyPublicationBytes(
      dependencies.fs,
      paths.registrationPath,
      paths.registryPath,
      registrationBytes,
      registryBytes,
    );
    await assertOwnedPublicationDirectory(paths, rootRealPath, owner, dependencies.fs);
    await dependencies.fs.removeFile(paths.markerPath);
    directoryOwned = false;
  } catch (error) {
    const cleanupWarnings: string[] = [];
    if (directoryOwned) {
      await captureCleanupWarning(cleanupWarnings, "publication directory cleanup", async () => {
        await removeOwnedPublicationDirectory(paths, owner, dependencies.fs);
      });
    } else if (directoryReserved) {
      cleanupWarnings.push("Publication directory cleanup skipped because ownership was not established.");
    }
    throw new ProspectiveShadowRegistrationWriterError("publication", error, cleanupWarnings);
  }

  return Object.freeze({
    directoryPath: paths.finalDirectory,
    registrationPath: paths.registrationPath,
    registryPath: paths.registryPath,
    registration,
    registrationBytes,
    registryBytes,
  });
}

export async function appendProspectiveShadowAbandonment(
  input: AppendProspectiveShadowAbandonmentInput,
  dependencies: ProspectiveShadowRegistrationWriterDependencies,
): Promise<PublishedProspectiveShadowAbandonment> {
  const detachedInput = structuredClone(input);
  const abandonedAt = dependencies.now();
  const suffix = requireSafeSuffix(dependencies.randomSuffix());
  const paths = abandonmentPaths(detachedInput.repositoryRoot, suffix);
  const lockOwner = `${PROSPECTIVE_SHADOW_EXPERIMENT_ID}:${suffix}\n`;
  let lockReserved = false;
  let lockOwned = false;
  let replacementCreated = false;
  let committed = false;
  let committedResult: Omit<PublishedProspectiveShadowAbandonment, "cleanupWarnings"> | undefined;

  try {
    const rootRealPath = await assertSafePublicationChain(paths, dependencies.fs);
    await readCompletePublication(paths, dependencies.fs);
    await dependencies.fs.createDirectoryExclusive(paths.lockDirectory);
    lockReserved = true;
    await assertContainedDirectory(paths.lockDirectory, rootRealPath, "abandonment lock", dependencies.fs);
    await dependencies.fs.writeFileExclusive(paths.lockOwnerPath, lockOwner);
    lockOwned = true;

    const initial = await readCompletePublication(paths, dependencies.fs);
    if (initial.registration.payloadSha256 !== detachedInput.expectedRegistrationPayloadSha256) {
      throw new Error("Prospective shadow abandonment payload hash mismatch.");
    }
    if (initial.registry.registrationPayloadSha256 !== initial.registration.payloadSha256) {
      throw new Error("Prospective shadow registration and registry payload hash mismatch.");
    }
    if (initial.registry.abandoned) {
      throw new Error("Prospective shadow registration is already abandoned.");
    }
    assertBeforeWindowClose(abandonedAt, initial.registration.window.to);

    const eventBytes = serializeProspectiveShadowRegistryEvent({
      schemaVersion: 1,
      authority: PROSPECTIVE_SHADOW_AUTHORITY,
      experimentId: PROSPECTIVE_SHADOW_EXPERIMENT_ID,
      event: "ABANDONED",
      eventAt: abandonedAt,
      registrationPayloadSha256: initial.registration.payloadSha256,
      publicationCommitSha: detachedInput.publicationCommitSha,
      reason: detachedInput.reason,
    });
    const registryBytes = `${initial.registryBytes}${eventBytes}`;
    const parsedReplacement = parseProspectiveShadowRegistry(registryBytes);
    const event = parsedReplacement.events[1];
    if (event?.event !== "ABANDONED") {
      throw new Error("Prospective shadow abandonment replacement is invalid.");
    }

    await dependencies.fs.writeFileExclusive(paths.replacementPath, registryBytes);
    replacementCreated = true;
    const replacementReadBack = await dependencies.fs.readUtf8(paths.replacementPath);
    if (replacementReadBack !== registryBytes) {
      throw new Error("Prospective shadow abandonment replacement read-back mismatch.");
    }
    parseProspectiveShadowRegistry(replacementReadBack);

    const unchanged = await readCompletePublication(paths, dependencies.fs);
    if (unchanged.registrationBytes !== initial.registrationBytes) {
      throw new Error("Prospective shadow registration changed while abandonment lock was held.");
    }
    if (unchanged.registryBytes !== initial.registryBytes) {
      throw new Error("Prospective shadow registry changed while abandonment lock was held.");
    }
    await assertOwnedLockDirectory(paths, rootRealPath, lockOwner, dependencies.fs);
    await dependencies.fs.replaceFileAtomic(paths.replacementPath, paths.registryPath);
    committed = true;
    committedResult = Object.freeze({
      registrationPath: paths.registrationPath,
      registryPath: paths.registryPath,
      event,
      previousRegistryBytes: initial.registryBytes,
      registryBytes,
    });
  } catch (error) {
    if (committed) throw error;
    const cleanupWarnings = await cleanupAbandonmentArtifacts(
      paths,
      lockOwner,
      { lockReserved, lockOwned, replacementCreated },
      dependencies.fs,
    );
    throw new ProspectiveShadowRegistrationWriterError("abandonment", error, cleanupWarnings);
  }

  const cleanupWarnings = await cleanupAbandonmentArtifacts(
    paths,
    lockOwner,
    { lockReserved, lockOwned, replacementCreated },
    dependencies.fs,
  );
  if (!committedResult) throw new Error("Prospective shadow abandonment committed without a result.");
  return Object.freeze({ ...committedResult, cleanupWarnings: Object.freeze(cleanupWarnings) });
}

async function ensureSafeResearchDirectory(
  paths: PublicationPaths,
  fs: ProspectiveShadowRegistrationFileSystem,
): Promise<string> {
  const rootRealPath = await assertRepositoryRoot(paths.repositoryRoot, fs);
  await createOrValidateContainedDirectory(paths.docsDirectory, rootRealPath, "docs", fs);
  await createOrValidateContainedDirectory(paths.researchDirectory, rootRealPath, "research", fs);
  return rootRealPath;
}

async function reservePublicationDirectory(
  paths: PublicationPaths,
  rootRealPath: string,
  fs: ProspectiveShadowRegistrationFileSystem,
): Promise<void> {
  const kind = await fs.pathKind(paths.finalDirectory);
  if (kind !== "MISSING") {
    if (kind === "SYMBOLIC_LINK") throw new Error("Prospective shadow final directory must not be a symbolic link or junction.");
    if (kind !== "DIRECTORY") throw new Error("Prospective shadow final publication path must be a directory.");
    await assertContainedDirectory(paths.finalDirectory, rootRealPath, "final publication", fs);
    const entries = [...await fs.listDirectory(paths.finalDirectory)].sort();
    if (await isCompleteExistingPublication(paths, entries, fs)) {
      throw new Error(`Prospective shadow registration directory already exists: ${paths.finalDirectory}.`);
    }
    throw new Error(`Prospective shadow final directory contains an incomplete publication: ${paths.finalDirectory}.`);
  }
  try {
    await fs.createDirectoryExclusive(paths.finalDirectory);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      throw new Error(`Prospective shadow final directory contains an incomplete or concurrent publication: ${paths.finalDirectory}.`);
    }
    throw error;
  }
  await assertContainedDirectory(paths.finalDirectory, rootRealPath, "final publication", fs);
}

async function isCompleteExistingPublication(
  paths: PublicationPaths,
  entries: readonly string[],
  fs: ProspectiveShadowRegistrationFileSystem,
): Promise<boolean> {
  if (!sameEntries(entries, [REGISTRATION_FILE_NAME, REGISTRY_FILE_NAME])) return false;
  try {
    const registrationBytes = await fs.readUtf8(paths.registrationPath);
    const registryBytes = await fs.readUtf8(paths.registryPath);
    const registration = parseCanonicalRegistration(registrationBytes);
    const registry = parseProspectiveShadowRegistry(registryBytes);
    return registry.registrationPayloadSha256 === registration.payloadSha256;
  } catch {
    return false;
  }
}

async function assertSafePublicationChain(
  paths: AbandonmentPaths,
  fs: ProspectiveShadowRegistrationFileSystem,
): Promise<string> {
  const rootRealPath = await assertRepositoryRoot(paths.repositoryRoot, fs);
  await assertContainedDirectory(paths.docsDirectory, rootRealPath, "docs", fs);
  await assertContainedDirectory(paths.researchDirectory, rootRealPath, "research", fs);
  await assertContainedDirectory(paths.finalDirectory, rootRealPath, "final publication", fs);
  return rootRealPath;
}

async function readCompletePublication(
  paths: Pick<AbandonmentPaths, "finalDirectory" | "markerPath" | "registrationPath" | "registryPath">,
  fs: ProspectiveShadowRegistrationFileSystem,
) {
  const entries = [...await fs.listDirectory(paths.finalDirectory)].sort();
  if (!sameEntries(entries, [REGISTRATION_FILE_NAME, REGISTRY_FILE_NAME])) {
    throw new Error(`Prospective shadow final directory contains an incomplete publication: ${paths.finalDirectory}.`);
  }
  if (await fs.pathKind(paths.markerPath) !== "MISSING") {
    throw new Error(`Prospective shadow final directory contains an incomplete publication marker: ${paths.finalDirectory}.`);
  }
  const registrationBytes = await fs.readUtf8(paths.registrationPath);
  const registryBytes = await fs.readUtf8(paths.registryPath);
  return {
    registrationBytes,
    registryBytes,
    registration: parseCanonicalRegistration(registrationBytes),
    registry: parseProspectiveShadowRegistry(registryBytes),
  };
}

async function verifyPublicationBytes(
  fs: ProspectiveShadowRegistrationFileSystem,
  registrationPath: string,
  registryPath: string,
  expectedRegistrationBytes: string,
  expectedRegistryBytes: string,
): Promise<void> {
  const registrationBytes = await fs.readUtf8(registrationPath);
  const registryBytes = await fs.readUtf8(registryPath);
  if (registrationBytes !== expectedRegistrationBytes) throw new Error("Prospective shadow registration read-back mismatch.");
  const registration = parseCanonicalRegistration(registrationBytes);
  if (registryBytes !== expectedRegistryBytes) throw new Error("Prospective shadow registry read-back mismatch.");
  const registry = parseProspectiveShadowRegistry(registryBytes);
  if (registry.registrationPayloadSha256 !== registration.payloadSha256) {
    throw new Error("Prospective shadow registration and registry payload hash mismatch.");
  }
}

async function assertOwnedPublicationDirectory(
  paths: PublicationPaths,
  rootRealPath: string,
  owner: string,
  fs: ProspectiveShadowRegistrationFileSystem,
): Promise<void> {
  await assertContainedDirectory(paths.finalDirectory, rootRealPath, "owned final publication", fs);
  const markerOwner = await fs.readUtf8(paths.markerPath);
  if (markerOwner !== owner) throw new Error("Prospective shadow publication directory ownership changed.");
  const entries = [...await fs.listDirectory(paths.finalDirectory)].sort();
  if (!sameEntries(entries, [PUBLICATION_MARKER_FILE_NAME, REGISTRATION_FILE_NAME, REGISTRY_FILE_NAME])) {
    throw new Error("Prospective shadow owned publication directory contains unexpected entries.");
  }
}

async function removeOwnedPublicationDirectory(
  paths: PublicationPaths,
  owner: string,
  fs: ProspectiveShadowRegistrationFileSystem,
): Promise<void> {
  const kind = await fs.pathKind(paths.finalDirectory);
  if (kind !== "DIRECTORY") throw new Error("Prospective shadow publication cleanup refused because directory ownership is not provable.");
  const markerOwner = await fs.readUtf8(paths.markerPath);
  if (markerOwner !== owner) throw new Error("Prospective shadow publication cleanup refused because ownership changed.");
  await fs.removeDirectory(paths.finalDirectory);
}

async function cleanupAbandonmentArtifacts(
  paths: AbandonmentPaths,
  owner: string,
  state: Readonly<{ lockReserved: boolean; lockOwned: boolean; replacementCreated: boolean }>,
  fs: ProspectiveShadowRegistrationFileSystem,
): Promise<string[]> {
  const warnings: string[] = [];
  if (state.replacementCreated) {
    await captureCleanupWarning(warnings, "abandonment temporary registry cleanup", async () => {
      await removeTemporaryFile(fs, paths.replacementPath);
    });
  }
  if (state.lockOwned) {
    await captureCleanupWarning(warnings, "abandonment lock cleanup", async () => {
      await releaseOwnedLockDirectory(paths, owner, fs);
    });
  } else if (state.lockReserved) {
    warnings.push("Abandonment lock cleanup skipped because ownership was not established.");
  }
  return warnings;
}

async function assertOwnedLockDirectory(
  paths: AbandonmentPaths,
  rootRealPath: string,
  owner: string,
  fs: ProspectiveShadowRegistrationFileSystem,
): Promise<void> {
  await assertContainedDirectory(paths.lockDirectory, rootRealPath, "abandonment lock", fs);
  const entries = [...await fs.listDirectory(paths.lockDirectory)].sort();
  if (!sameEntries(entries, [LOCK_OWNER_FILE_NAME])) throw new Error("Prospective shadow abandonment lock is not a single-owner lock directory.");
  if (await fs.readUtf8(paths.lockOwnerPath) !== owner) throw new Error("Prospective shadow abandonment lock ownership changed.");
}

async function releaseOwnedLockDirectory(
  paths: AbandonmentPaths,
  owner: string,
  fs: ProspectiveShadowRegistrationFileSystem,
): Promise<void> {
  const kind = await fs.pathKind(paths.lockDirectory);
  if (kind !== "DIRECTORY") throw new Error("Prospective shadow abandonment lock cleanup refused because ownership is not provable.");
  const entries = [...await fs.listDirectory(paths.lockDirectory)].sort();
  if (!sameEntries(entries, [LOCK_OWNER_FILE_NAME])) throw new Error("Prospective shadow abandonment lock cleanup refused because lock contents changed.");
  if (await fs.readUtf8(paths.lockOwnerPath) !== owner) throw new Error("Prospective shadow abandonment lock cleanup refused because ownership changed.");
  await fs.removeDirectory(paths.lockDirectory);
}

async function removeTemporaryFile(fs: ProspectiveShadowRegistrationFileSystem, path: string): Promise<void> {
  try {
    await fs.removeFile(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

async function assertRepositoryRoot(
  repositoryRoot: string,
  fs: ProspectiveShadowRegistrationFileSystem,
): Promise<string> {
  if (repositoryRoot.trim().length === 0) throw new Error("Prospective shadow repositoryRoot must be explicit.");
  const resolvedRoot = resolve(repositoryRoot);
  const kind = await fs.pathKind(resolvedRoot);
  if (kind === "SYMBOLIC_LINK") throw new Error("Prospective shadow repositoryRoot must not be a symbolic link or junction.");
  if (kind !== "DIRECTORY") throw new Error("Prospective shadow repositoryRoot must be an existing directory.");
  return fs.realPath(resolvedRoot);
}

async function createOrValidateContainedDirectory(
  path: string,
  rootRealPath: string,
  label: string,
  fs: ProspectiveShadowRegistrationFileSystem,
): Promise<void> {
  if (await fs.pathKind(path) === "MISSING") {
    try {
      await fs.createDirectoryExclusive(path);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
  }
  await assertContainedDirectory(path, rootRealPath, label, fs);
}

async function assertContainedDirectory(
  path: string,
  rootRealPath: string,
  label: string,
  fs: ProspectiveShadowRegistrationFileSystem,
): Promise<void> {
  const kind = await fs.pathKind(path);
  if (kind === "SYMBOLIC_LINK") throw new Error(`Prospective shadow ${label} must not be a symbolic link or junction.`);
  if (kind !== "DIRECTORY") throw new Error(`Prospective shadow ${label} must be an existing directory.`);
  const actual = await fs.realPath(path);
  const relation = relative(rootRealPath, actual);
  if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relation)) {
    throw new Error(`Prospective shadow ${label} failed repositoryRoot containment validation.`);
  }
}

function parseCanonicalRegistration(bytes: string): ProspectiveShadowRegistration {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("Prospective shadow registration must contain valid JSON.");
  }
  const registration = validateProspectiveShadowRegistration(value);
  if (serializeProspectiveShadowRegistration(registration) !== bytes) {
    throw new Error("Prospective shadow registration is not canonical JSON.");
  }
  return registration;
}

function assertBeforeWindowClose(abandonedAt: string, windowTo: string): void {
  const abandoned = parsePerformanceTimestamp(abandonedAt);
  const close = parsePerformanceTimestamp(windowTo);
  if (!abandoned) throw new Error("Prospective shadow abandonedAt must be an exact ISO-8601 timestamp with an explicit timezone.");
  if (!close || abandoned.epochNanoseconds >= close.epochNanoseconds) {
    throw new Error("Prospective shadow abandonment must occur before window.to.");
  }
}

async function captureCleanupWarning(
  warnings: string[],
  label: string,
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    warnings.push(`${label}: ${describeError(error)}`);
  }
}

type PublicationPaths = ReturnType<typeof publicationPaths>;
type AbandonmentPaths = ReturnType<typeof abandonmentPaths>;

function publicationPaths(repositoryRoot: string) {
  const root = resolve(repositoryRoot);
  const docsDirectory = join(root, "docs");
  const researchDirectory = join(docsDirectory, "research");
  const finalDirectory = join(researchDirectory, PUBLICATION_DIRECTORY_NAME);
  return {
    repositoryRoot: root,
    docsDirectory,
    researchDirectory,
    finalDirectory,
    markerPath: join(finalDirectory, PUBLICATION_MARKER_FILE_NAME),
    registrationPath: join(finalDirectory, REGISTRATION_FILE_NAME),
    registryPath: join(finalDirectory, REGISTRY_FILE_NAME),
  };
}

function abandonmentPaths(repositoryRoot: string, suffix: string) {
  const base = publicationPaths(repositoryRoot);
  const lockDirectory = join(base.researchDirectory, ABANDONMENT_LOCK_DIRECTORY_NAME);
  return {
    ...base,
    lockDirectory,
    lockOwnerPath: join(lockDirectory, LOCK_OWNER_FILE_NAME),
    replacementPath: join(base.researchDirectory, `.${PUBLICATION_DIRECTORY_NAME}.registry.${suffix}.tmp`),
  };
}

function sameEntries(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function requireSafeSuffix(value: string): string {
  if (!SAFE_SUFFIX.test(value)) throw new Error("Prospective shadow writer random suffix must be a safe non-empty path component.");
  return value;
}

async function inspectPathKind(path: string): Promise<ProspectiveShadowPathKind> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "SYMBOLIC_LINK";
    if (stats.isDirectory()) return "DIRECTORY";
    return "OTHER";
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "MISSING";
    throw error;
  }
}

async function readUtf8File(path: string): Promise<string> {
  const bytes = await readFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Prospective shadow artifact must contain valid UTF-8: ${path}.`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
