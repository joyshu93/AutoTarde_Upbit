import {
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
} from "node:path";

export type LocalDatabasePathErrorCode =
  | "DATABASE_PATH_REQUIRED"
  | "DATABASE_PATH_NETWORK"
  | "DATABASE_PATH_DEVICE"
  | "DATABASE_PATH_SHORT_NAME"
  | "DATABASE_PATH_NOT_FOUND"
  | "DATABASE_PATH_NOT_REGULAR_FILE"
  | "DATABASE_PATH_REPARSE_POINT"
  | "DATABASE_PATH_HARDLINK_AMBIGUOUS"
  | "DATABASE_PATH_CANONICALIZATION_FAILED";

export class LocalDatabasePathError extends Error {
  constructor(
    readonly code: LocalDatabasePathErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalDatabasePathError";
  }
}

export function canonicalizeLocalDatabasePath(
  rawPath: string,
  options: Readonly<{ mustExist?: boolean }> = {},
): string {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new LocalDatabasePathError(
      "DATABASE_PATH_REQUIRED",
      "Database path must be configured explicitly.",
    );
  }
  const databasePath = rawPath.trim();
  rejectUnsafeLexicalForm(databasePath);

  const absolutePath = resolve(databasePath);
  rejectUnsafeLexicalForm(absolutePath);
  const missingComponents: string[] = [];
  let existingPath = absolutePath;
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) {
      throw new LocalDatabasePathError(
        "DATABASE_PATH_CANONICALIZATION_FAILED",
        "Database path has no existing local ancestor.",
      );
    }
    missingComponents.unshift(basename(existingPath));
    existingPath = parent;
  }
  if (options.mustExist === true && missingComponents.length > 0) {
    throw new LocalDatabasePathError(
      "DATABASE_PATH_NOT_FOUND",
      "Database path does not exist.",
    );
  }

  try {
    inspectExistingPathComponents(existingPath);
    const realExistingPath = realpathSync.native(existingPath);
    rejectUnsafeLexicalForm(realExistingPath);
    if (!sameCanonicalPath(existingPath, realExistingPath)) {
      throw new LocalDatabasePathError(
        process.platform === "win32" && containsDosShortNameComponent(existingPath)
          ? "DATABASE_PATH_SHORT_NAME"
          : "DATABASE_PATH_REPARSE_POINT",
        process.platform === "win32" && containsDosShortNameComponent(existingPath)
          ? "Database path resolves through a Windows short-name alias."
          : "Database path resolves through an alias or reparse point.",
      );
    }

    if (missingComponents.length === 0) {
      const stats = statSync(realExistingPath);
      if (!stats.isFile()) {
        throw new LocalDatabasePathError(
          "DATABASE_PATH_NOT_REGULAR_FILE",
          "Configured database path must identify a regular file.",
        );
      }
      if (stats.nlink !== 1) {
        throw new LocalDatabasePathError(
          "DATABASE_PATH_HARDLINK_AMBIGUOUS",
          "Database path has multiple hardlink names and cannot be scoped safely.",
        );
      }
    }

    const canonicalPath = missingComponents.reduce(
      (current, component) => join(current, component),
      realExistingPath,
    );
    rejectUnsafeLexicalForm(canonicalPath);
    return canonicalPath;
  } catch (error) {
    if (error instanceof LocalDatabasePathError) throw error;
    throw new LocalDatabasePathError(
      "DATABASE_PATH_CANONICALIZATION_FAILED",
      "Database path could not be proven to use one local canonical name.",
      { cause: error },
    );
  }
}

function inspectExistingPathComponents(existingPath: string): void {
  let component = existingPath;
  const root = parse(existingPath).root;
  while (true) {
    if (lstatSync(component).isSymbolicLink()) {
      throw new LocalDatabasePathError(
        "DATABASE_PATH_REPARSE_POINT",
        "Database path contains a symlink, junction, or reparse-point alias.",
      );
    }
    if (sameCanonicalPath(component, root)) return;
    const parent = dirname(component);
    if (parent === component) return;
    component = parent;
  }
}

function rejectUnsafeLexicalForm(databasePath: string): void {
  const windowsForm = databasePath.replaceAll("/", "\\");
  if (/^\\\\[?.]\\/u.test(windowsForm) || /^\\\?\?\\/u.test(windowsForm)) {
    throw new LocalDatabasePathError(
      "DATABASE_PATH_DEVICE",
      "Database path must not use a Windows device namespace.",
    );
  }
  if (windowsForm.startsWith("\\\\")) {
    throw new LocalDatabasePathError(
      "DATABASE_PATH_NETWORK",
      "Database path must not use UNC or network storage.",
    );
  }
  if (!isAbsolute(databasePath) && databasePath.startsWith("//")) {
    throw new LocalDatabasePathError(
      "DATABASE_PATH_NETWORK",
      "Database path must not use UNC or network storage.",
    );
  }
}

function containsDosShortNameComponent(databasePath: string): boolean {
  return databasePath
    .replaceAll("/", "\\")
    .split("\\")
    .some((component) => {
      const match = /^([^.]*)~([1-9][0-9]*)(?:\.([^.]+))?$/iu.exec(component);
      if (!match) return false;
      const stemPrefix = match[1]!;
      const numericTail = match[2]!;
      const extension = match[3] ?? "";
      return stemPrefix.length >= 1 &&
        stemPrefix.length <= 6 &&
        stemPrefix.length + 1 + numericTail.length <= 8 &&
        extension.length <= 3;
    });
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toUpperCase() === right.toUpperCase()
    : left === right;
}
