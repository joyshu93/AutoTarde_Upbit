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
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

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

/**
 * Loads the single checked-in abandonment record without consulting Git, the network, or env.
 * A valid abandonment is historical authority evidence, never LIVE trading approval.
 */
export function loadCheckedInPositionGuardPilotAbandonment(): PositionGuardPilotAbandonmentValidation {
  return loadFromRepositoryRoot(process.cwd(), readOpenedRegistry);
}

/** Test seam: the fixed relative path and production validation remain unchanged. */
export function loadPositionGuardPilotAbandonmentFromRepositoryRootForTest(
  repositoryRoot: string,
  fixtureReader: PositionGuardPilotRegistryFixtureReader = readOpenedRegistry,
): PositionGuardPilotAbandonmentValidation {
  return loadFromRepositoryRoot(repositoryRoot, fixtureReader);
}

export function validatePositionGuardPilotRegistryBytes(
  bytes: Uint8Array,
): PositionGuardPilotAbandonmentValidation {
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
  return Object.freeze({ ...abandonment });
}

function loadFromRepositoryRoot(
  repositoryRoot: string,
  reader: PositionGuardPilotRegistryFixtureReader,
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
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()) {
      throw new Error("PositionGuard pilot registry must be a regular file.");
    }
    if (opened.size <= 0n || opened.size > BigInt(MAX_REGISTRY_BYTES)) {
      throw new Error("PositionGuard pilot registry file size is invalid.");
    }
    assertStableFileIdentity(opened, statSync(registryPath, { bigint: true }));

    const bytes = Uint8Array.from(reader(descriptor, registryPath));
    const afterRead = fstatSync(descriptor, { bigint: true });
    assertNoSymbolicLinks(registryPath);
    if (!samePath(realRoot, realpathSync.native(resolvedRoot))) {
      throw new Error("PositionGuard pilot registry repository root changed while reading the file.");
    }
    assertStableOpenedFile(opened, afterRead);
    assertStableFileIdentity(afterRead, statSync(registryPath, { bigint: true }));

    const realRegistryPathAfterRead = realpathSync.native(registryPath);
    assertContainedPath(realRoot, realRegistryPathAfterRead);
    if (!samePath(realRegistryPath, realRegistryPathAfterRead)) {
      throw new Error("PositionGuard pilot registry path changed while it was being read.");
    }

    return validatePositionGuardPilotRegistryBytes(bytes);
  } finally {
    closeSync(descriptor);
  }
}

function readOpenedRegistry(descriptor: number): Uint8Array {
  return readFileSync(descriptor);
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
  if (opened.dev !== pathStats.dev || opened.ino !== pathStats.ino) {
    throw new Error("PositionGuard pilot registry path does not identify the opened file.");
  }
  if (opened.dev === 0n && opened.ino === 0n) {
    throw new Error("PositionGuard pilot registry file identity cannot be established.");
  }
}

function assertStableOpenedFile(before: BigIntStats, after: BigIntStats): void {
  if (
    before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error("PositionGuard pilot registry file changed while it was being read.");
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}
