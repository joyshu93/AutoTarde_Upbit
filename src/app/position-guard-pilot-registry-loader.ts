import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

import type { PositionGuardPilotAbandonmentValidation } from "../domain/pilot-types.js";
import { validatePositionGuardPilotAbandonment } from "../modules/strategy/position-guard-pilot-authority.js";

const REGISTRY_RELATIVE_SEGMENTS = Object.freeze([
  "docs",
  "research",
  "prospective-shadow",
  "registry.jsonl",
] as const);
const EXPECTED_CANONICAL_REGISTRY_SHA256 =
  "23dcdbd775d14176afb6ce0bd1be3c024e13cf97c98267a4dd3a2930c8e9cdf9";
const MAX_REGISTRY_BYTES = 4_096;
const EXACT_REGISTERED_RECORD = Object.freeze({
  authority: "PROSPECTIVE_COMPONENT_SHADOW_V1",
  event: "REGISTERED",
  eventAt: "2026-08-20T07:54:01.786Z",
  experimentId: "PCS-2026-001",
  registrationPayloadSha256: "978e31695707453507fa604bae71f3f1657a061f891e621f2026f1e293c53b40",
  schemaVersion: 1,
} as const);

export type PositionGuardPilotRegistryFixtureReader = (
  descriptor: number,
  registryPath: string,
) => Uint8Array;

type PositionGuardPilotRegistryStatsStage =
  | "OPENED_BEFORE_READ"
  | "PATH_BEFORE_READ"
  | "OPENED_AFTER_READ"
  | "PATH_AFTER_READ"
  | "CURRENT_OPENED_BEFORE_READ"
  | "CURRENT_PATH_BEFORE_READ"
  | "CURRENT_OPENED_AFTER_READ"
  | "CURRENT_PATH_AFTER_READ";

type PositionGuardPilotRegistryStatsProjector = (
  stage: PositionGuardPilotRegistryStatsStage,
  stats: BigIntStats,
) => BigIntStats;

type PositionGuardPilotRegistryLoaderTestOptions = Readonly<{
  projectStats: PositionGuardPilotRegistryStatsProjector;
}>;

/**
 * Loads the single checked-in abandonment record without consulting Git, the network, or env.
 * A valid abandonment is historical authority evidence, never LIVE trading approval.
 */
export function loadCheckedInPositionGuardPilotAbandonment(): PositionGuardPilotAbandonmentValidation {
  const moduleFilePath = fileURLToPath(import.meta.url);
  return loadFromRepositoryRoot(
    projectRepositoryRootFromModuleFile(moduleFilePath),
    readOpenedRegistry,
    identityStatsProjector,
  );
}

/** Test seam: the fixed relative path and production validation remain unchanged. */
export function loadPositionGuardPilotAbandonmentFromRepositoryRootForTest(
  repositoryRoot: string,
  fixtureReader: PositionGuardPilotRegistryFixtureReader = readOpenedRegistry,
  options: PositionGuardPilotRegistryLoaderTestOptions = {
    projectStats: identityStatsProjector,
  },
): PositionGuardPilotAbandonmentValidation {
  return loadFromRepositoryRoot(repositoryRoot, fixtureReader, options.projectStats);
}

export function projectPositionGuardPilotRepositoryRootFromModuleFileForTest(
  moduleFilePath: string,
): string {
  return projectRepositoryRootFromModuleFile(moduleFilePath);
}

export function validatePositionGuardPilotRegistryBytes(
  bytes: Uint8Array,
): PositionGuardPilotAbandonmentValidation {
  return validatePositionGuardPilotRegistryEvidence(bytes).validation;
}

type PositionGuardPilotRegistryEvidence = Readonly<{
  canonicalSha256: string;
  validation: PositionGuardPilotAbandonmentValidation;
}>;

function validatePositionGuardPilotRegistryEvidence(
  bytes: Uint8Array,
): PositionGuardPilotRegistryEvidence {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_REGISTRY_BYTES) {
    throw new Error("PositionGuard pilot registry bytes are missing or exceed the authority size limit.");
  }

  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const normalized = normalizeRegistryNewlines(decoded);
  const normalizedBytes = Buffer.from(normalized, "utf8");
  const sha256 = createHash("sha256").update(normalizedBytes).digest("hex");
  if (sha256 !== EXPECTED_CANONICAL_REGISTRY_SHA256) {
    throw new Error("PositionGuard pilot registry does not match the checked-in canonical authority bytes.");
  }

  const lines = normalized.split("\n");
  if (lines.length !== 3 || lines[2] !== "") {
    throw new Error("PositionGuard pilot registry must contain exactly two canonical JSONL records.");
  }

  const registered = parseJsonRecord(lines[0] as string);
  const abandoned = parseJsonRecord(lines[1] as string);
  if (!isExactPlainDataRecord(registered, EXACT_REGISTERED_RECORD)) {
    throw new Error("PositionGuard pilot registry registration authority is invalid.");
  }

  const abandonment = validatePositionGuardPilotAbandonment(abandoned);
  return Object.freeze({
    canonicalSha256: sha256,
    validation: Object.freeze({ ...abandonment }),
  });
}

function loadFromRepositoryRoot(
  repositoryRoot: string,
  reader: PositionGuardPilotRegistryFixtureReader,
  projectStats: PositionGuardPilotRegistryStatsProjector,
): PositionGuardPilotAbandonmentValidation {
  const resolvedRoot = resolve(repositoryRoot);
  assertNoSymbolicLinks(resolvedRoot);
  if (!lstatSync(resolvedRoot).isDirectory()) {
    throw new Error("PositionGuard pilot registry repository root must be a directory.");
  }

  const realRoot = realpathSync.native(resolvedRoot);
  const registryPath = join(resolvedRoot, ...REGISTRY_RELATIVE_SEGMENTS);
  assertNoSymbolicLinks(registryPath);
  const realRegistryPath = realpathSync.native(registryPath);
  assertContainedPath(realRoot, realRegistryPath);

  const descriptor = openSync(registryPath, constants.O_RDONLY);
  try {
    assertNoSymbolicLinks(registryPath);
    if (!samePath(realRoot, realpathSync.native(resolvedRoot))) {
      throw new Error("PositionGuard pilot registry repository root changed while opening the file.");
    }
    const opened = projectStats(
      "OPENED_BEFORE_READ",
      fstatSync(descriptor, { bigint: true }),
    );
    if (!opened.isFile()) {
      throw new Error("PositionGuard pilot registry must be a regular file.");
    }
    if (opened.size <= 0n || opened.size > BigInt(MAX_REGISTRY_BYTES)) {
      throw new Error("PositionGuard pilot registry file size is invalid.");
    }
    assertStableFileIdentity(
      opened,
      projectStats("PATH_BEFORE_READ", statSync(registryPath, { bigint: true })),
    );

    const bytes = Uint8Array.from(reader(descriptor, registryPath));
    const afterRead = projectStats(
      "OPENED_AFTER_READ",
      fstatSync(descriptor, { bigint: true }),
    );
    assertNoSymbolicLinks(registryPath);
    if (!samePath(realRoot, realpathSync.native(resolvedRoot))) {
      throw new Error("PositionGuard pilot registry repository root changed while reading the file.");
    }
    assertStableOpenedFile(opened, afterRead);
    assertStableFileIdentity(
      afterRead,
      projectStats("PATH_AFTER_READ", statSync(registryPath, { bigint: true })),
    );

    const realRegistryPathAfterRead = realpathSync.native(registryPath);
    assertContainedPath(realRoot, realRegistryPathAfterRead);
    if (!samePath(realRegistryPath, realRegistryPathAfterRead)) {
      throw new Error("PositionGuard pilot registry path changed while it was being read.");
    }

    const openedEvidence = validatePositionGuardPilotRegistryEvidence(bytes);
    const currentPathEvidence = readCurrentPathRegistryEvidence({
      expectedRealRegistryPath: realRegistryPath,
      originalAfterRead: afterRead,
      projectStats,
      realRoot,
      registryPath,
      resolvedRoot,
    });
    if (openedEvidence.canonicalSha256 !== currentPathEvidence.canonicalSha256) {
      throw new Error("PositionGuard pilot registry current path content changed after opening.");
    }
    return openedEvidence.validation;
  } finally {
    closeSync(descriptor);
  }
}

function readCurrentPathRegistryEvidence(input: Readonly<{
  expectedRealRegistryPath: string;
  originalAfterRead: BigIntStats;
  projectStats: PositionGuardPilotRegistryStatsProjector;
  realRoot: string;
  registryPath: string;
  resolvedRoot: string;
}>): PositionGuardPilotRegistryEvidence {
  assertNoSymbolicLinks(input.registryPath);
  const realRegistryPathBeforeOpen = realpathSync.native(input.registryPath);
  assertContainedPath(input.realRoot, realRegistryPathBeforeOpen);
  if (!samePath(input.expectedRealRegistryPath, realRegistryPathBeforeOpen)) {
    throw new Error("PositionGuard pilot registry current path changed before verification.");
  }

  const currentDescriptor = openSync(input.registryPath, constants.O_RDONLY);
  try {
    assertNoSymbolicLinks(input.registryPath);
    if (!samePath(input.realRoot, realpathSync.native(input.resolvedRoot))) {
      throw new Error("PositionGuard pilot registry repository root changed during verification.");
    }

    const currentOpened = input.projectStats(
      "CURRENT_OPENED_BEFORE_READ",
      fstatSync(currentDescriptor, { bigint: true }),
    );
    if (!currentOpened.isFile()) {
      throw new Error("PositionGuard pilot registry current path must be a regular file.");
    }
    if (currentOpened.size <= 0n || currentOpened.size > BigInt(MAX_REGISTRY_BYTES)) {
      throw new Error("PositionGuard pilot registry current path file size is invalid.");
    }
    assertStableFileIdentity(input.originalAfterRead, currentOpened);
    assertStableFileIdentity(
      currentOpened,
      input.projectStats(
        "CURRENT_PATH_BEFORE_READ",
        statSync(input.registryPath, { bigint: true }),
      ),
    );

    const currentBytes = Uint8Array.from(readOpenedRegistry(currentDescriptor));
    const currentAfterRead = input.projectStats(
      "CURRENT_OPENED_AFTER_READ",
      fstatSync(currentDescriptor, { bigint: true }),
    );
    assertNoSymbolicLinks(input.registryPath);
    if (!samePath(input.realRoot, realpathSync.native(input.resolvedRoot))) {
      throw new Error("PositionGuard pilot registry repository root changed during verification.");
    }
    assertStableOpenedFile(currentOpened, currentAfterRead);
    assertStableFileIdentity(
      currentAfterRead,
      input.projectStats(
        "CURRENT_PATH_AFTER_READ",
        statSync(input.registryPath, { bigint: true }),
      ),
    );

    const realRegistryPathAfterRead = realpathSync.native(input.registryPath);
    assertContainedPath(input.realRoot, realRegistryPathAfterRead);
    if (!samePath(input.expectedRealRegistryPath, realRegistryPathAfterRead)) {
      throw new Error("PositionGuard pilot registry current path changed during verification.");
    }
    return validatePositionGuardPilotRegistryEvidence(currentBytes);
  } finally {
    closeSync(currentDescriptor);
  }
}

function readOpenedRegistry(descriptor: number): Uint8Array {
  return readFileSync(descriptor);
}

function projectRepositoryRootFromModuleFile(moduleFilePath: string): string {
  const resolvedModuleFile = resolve(moduleFilePath);
  const extension = extname(resolvedModuleFile);
  const appDirectory = dirname(resolvedModuleFile);
  const sourceDirectory = dirname(appDirectory);
  if (
    basename(resolvedModuleFile) !== `position-guard-pilot-registry-loader${extension}`
    || basename(appDirectory) !== "app"
    || basename(sourceDirectory) !== "src"
  ) {
    throw new Error("PositionGuard pilot registry loader module path is invalid.");
  }

  if (extension === ".ts") {
    return dirname(sourceDirectory);
  }
  if (extension === ".js") {
    const distributionDirectory = dirname(sourceDirectory);
    if (basename(distributionDirectory) !== "dist") {
      throw new Error("PositionGuard pilot registry compiled module path is invalid.");
    }
    return dirname(distributionDirectory);
  }
  throw new Error("PositionGuard pilot registry loader module extension is invalid.");
}

function normalizeRegistryNewlines(value: string): string {
  if (!value.includes("\r")) {
    return value;
  }

  const withoutCrLf = value.replaceAll("\r\n", "");
  if (withoutCrLf.includes("\r") || withoutCrLf.includes("\n")) {
    throw new Error("PositionGuard pilot registry uses mixed or invalid newline encoding.");
  }
  return value.replaceAll("\r\n", "\n");
}

function parseJsonRecord(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("PositionGuard pilot registry contains invalid JSONL.");
  }
}

function isExactPlainDataRecord(
  value: unknown,
  expected: Readonly<Record<string, unknown>>,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return false;
  }

  const keys = Reflect.ownKeys(value);
  const expectedEntries = Object.entries(expected);
  if (
    keys.length !== expectedEntries.length
    || !keys.every((key) => typeof key === "string" && Object.hasOwn(expected, key))
  ) {
    return false;
  }

  return expectedEntries.every(([key, expectedValue]) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && descriptor.enumerable
      && "value" in descriptor
      && descriptor.value === expectedValue;
  });
}

function assertNoSymbolicLinks(targetPath: string): void {
  const resolvedPath = resolve(targetPath);
  const parsedRoot = parse(resolvedPath).root;
  const remainder = relative(parsedRoot, resolvedPath);
  let currentPath = parsedRoot;

  for (const segment of remainder.split(sep).filter((value) => value.length > 0)) {
    currentPath = join(currentPath, segment);
    if (lstatSync(currentPath).isSymbolicLink()) {
      throw new Error("PositionGuard pilot registry path must not contain a symlink or junction.");
    }
  }
}

function assertContainedPath(repositoryRoot: string, targetPath: string): void {
  const pathFromRoot = relative(repositoryRoot, targetPath);
  if (
    pathFromRoot === ""
    || pathFromRoot === ".."
    || pathFromRoot.startsWith(`..${sep}`)
    || isAbsolute(pathFromRoot)
  ) {
    throw new Error("PositionGuard pilot registry must remain inside the repository root.");
  }
}

function assertStableFileIdentity(opened: BigIntStats, pathStats: BigIntStats): void {
  const openedHasIdentity = hasFileIdentity(opened);
  const pathHasIdentity = hasFileIdentity(pathStats);
  if (openedHasIdentity !== pathHasIdentity) {
    throw new Error("PositionGuard pilot registry file identity availability changed.");
  }
  if (
    openedHasIdentity
    && (opened.dev !== pathStats.dev || opened.ino !== pathStats.ino)
  ) {
    throw new Error("PositionGuard pilot registry path does not identify the opened file.");
  }
  if (!hasStableFileMetadata(opened, pathStats)) {
    throw new Error("PositionGuard pilot registry path metadata does not match the opened file.");
  }
}

function assertStableOpenedFile(before: BigIntStats, after: BigIntStats): void {
  const beforeHasIdentity = hasFileIdentity(before);
  const afterHasIdentity = hasFileIdentity(after);
  if (
    beforeHasIdentity !== afterHasIdentity
    || (beforeHasIdentity && (before.dev !== after.dev || before.ino !== after.ino))
    || !hasStableFileMetadata(before, after)
  ) {
    throw new Error("PositionGuard pilot registry file changed while it was being read.");
  }
}

function hasFileIdentity(stats: BigIntStats): boolean {
  return stats.dev !== 0n || stats.ino !== 0n;
}

function hasStableFileMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return left.isFile()
    && right.isFile()
    && fileTypeSignature(left) === fileTypeSignature(right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.birthtimeNs === right.birthtimeNs
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid
    && left.gid === right.gid
    && left.rdev === right.rdev;
}

function fileTypeSignature(stats: BigIntStats): string {
  return [
    stats.isFile(),
    stats.isDirectory(),
    stats.isBlockDevice(),
    stats.isCharacterDevice(),
    stats.isSymbolicLink(),
    stats.isFIFO(),
    stats.isSocket(),
  ].join(":");
}

function identityStatsProjector(
  _stage: PositionGuardPilotRegistryStatsStage,
  stats: BigIntStats,
): BigIntStats {
  return stats;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}
