import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { ExecutionMode } from "../domain/types.js";
import {
  listCanonicalMigrationFilenames,
  openReadOnlySqliteDatabase,
  openSqliteDatabase,
} from "../modules/db/repositories/sqlite-database.js";
import {
  canonicalizeLocalDatabasePath,
  LocalDatabasePathError,
} from "../modules/db/local-database-path.js";

const FINGERPRINT_DOMAIN = "AUTOTRADE_UPBIT_LIVE_ACCOUNT_V1\0";
const RETIRED_MIGRATIONS = new Set(["0013_add_max_live_order_value_risk_code.sql"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface LiveDatabaseIdentityExpectation {
  executionMode: ExecutionMode;
  databasePath: string;
  expectedDatabaseInstanceId: string | null;
  exchangeAccountId: string;
  upbitAccessKey: string | null;
}

export type LiveDatabaseIdentityVerification =
  | Readonly<{ status: "NOT_REQUIRED" }>
  | Readonly<{
      status: "VERIFIED";
      canonicalDatabasePath: string;
      databaseInstanceId: string;
      exchangeAccountId: string;
    }>;

export interface LiveDatabaseIdentityProvisioningInput {
  databasePath: string;
  databaseInstanceId: string;
  exchangeAccountId: string;
  upbitAccessKey: string;
}

export interface LiveDatabaseIdentityProvisioningResult {
  databasePath: string;
  databaseInstanceId: string;
  exchangeAccountId: string;
  upbitAccessKeyFingerprint: string;
  created: boolean;
}

interface LiveDatabaseIdentityRow {
  database_instance_id: string;
  exchange_account_id: string;
  upbit_access_key_sha256: string;
}

interface ExchangeAccountIdentityRow {
  id: string;
  exchange: string;
  venue_type: string;
  quote_currency: string;
  is_primary: number;
}

export class LiveDatabaseIdentityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LiveDatabaseIdentityError";
  }
}

export function fingerprintUpbitAccessKey(accessKey: string): string {
  const normalized = requireNonEmpty(accessKey, "UPBIT_ACCESS_KEY");
  return createHash("sha256").update(FINGERPRINT_DOMAIN).update(normalized).digest("hex");
}

export function verifyLiveDatabaseIdentity(
  input: LiveDatabaseIdentityExpectation,
): LiveDatabaseIdentityVerification {
  if (input.executionMode !== "LIVE") return { status: "NOT_REQUIRED" };

  const databasePath = validateExistingAbsoluteDatabasePath(input.databasePath);
  const expectedInstanceId = validateInstanceId(input.expectedDatabaseInstanceId);
  const accessKeyFingerprint = fingerprintUpbitAccessKey(input.upbitAccessKey ?? "");
  const exchangeAccountId = requireNonEmpty(input.exchangeAccountId, "exchange_account_id");
  const db = openReadOnlySqliteDatabase(databasePath);
  try {
    validateMigrationLedger(db);
    validateExchangeAccount(db, exchangeAccountId);
    const identity = readIdentity(db);
    if (identity === null) {
      throw new LiveDatabaseIdentityError(
        "IDENTITY_MISSING",
        "LIVE database identity is missing; run the explicit offline provisioning command first.",
      );
    }
    if (identity.database_instance_id !== expectedInstanceId) {
      throw new LiveDatabaseIdentityError(
        "DATABASE_INSTANCE_MISMATCH",
        "LIVE database instance identity does not match the configured expectation.",
      );
    }
    if (identity.exchange_account_id !== exchangeAccountId) {
      throw new LiveDatabaseIdentityError(
        "EXCHANGE_ACCOUNT_MISMATCH",
        "LIVE database exchange account identity does not match the configured account.",
      );
    }
    if (identity.upbit_access_key_sha256 !== accessKeyFingerprint) {
      throw new LiveDatabaseIdentityError(
        "CREDENTIAL_MISMATCH",
        "LIVE database credential identity does not match the configured Upbit access key.",
      );
    }
    return {
      status: "VERIFIED",
      canonicalDatabasePath: databasePath,
      databaseInstanceId: identity.database_instance_id,
      exchangeAccountId: identity.exchange_account_id,
    };
  } finally {
    db.close();
  }
}

export function provisionLiveDatabaseIdentity(
  input: LiveDatabaseIdentityProvisioningInput,
): LiveDatabaseIdentityProvisioningResult {
  const databasePath = validateExistingAbsoluteDatabasePath(input.databasePath);
  const databaseInstanceId = validateInstanceId(input.databaseInstanceId);
  const exchangeAccountId = requireNonEmpty(input.exchangeAccountId, "exchange_account_id");
  const upbitAccessKeyFingerprint = fingerprintUpbitAccessKey(input.upbitAccessKey);
  inspectExistingBindingBeforeProvision({
    databasePath,
    databaseInstanceId,
    exchangeAccountId,
    upbitAccessKeyFingerprint,
  });
  const handle = openSqliteDatabase(databasePath);
  let created = false;
  try {
    validateExchangeAccount(handle.db, exchangeAccountId);
    const existing = readIdentity(handle.db);
    if (existing !== null) {
      if (
        existing.database_instance_id !== databaseInstanceId ||
        existing.exchange_account_id !== exchangeAccountId ||
        existing.upbit_access_key_sha256 !== upbitAccessKeyFingerprint
      ) {
        throw new LiveDatabaseIdentityError(
          "IDENTITY_ALREADY_BOUND",
          "LIVE database is already bound to a different identity; provisioning never overwrites a binding.",
        );
      }
    } else {
      const now = new Date().toISOString();
      handle.db.prepare(`
        INSERT INTO live_database_identity (
          singleton_id, database_instance_id, exchange_account_id,
          upbit_access_key_sha256, created_at, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?)
      `).run(databaseInstanceId, exchangeAccountId, upbitAccessKeyFingerprint, now, now);
      created = true;
    }
  } finally {
    handle.close();
  }

  verifyLiveDatabaseIdentity({
    executionMode: "LIVE",
    databasePath,
    expectedDatabaseInstanceId: databaseInstanceId,
    exchangeAccountId,
    upbitAccessKey: input.upbitAccessKey,
  });
  return {
    databasePath,
    databaseInstanceId,
    exchangeAccountId,
    upbitAccessKeyFingerprint,
    created,
  };
}

function inspectExistingBindingBeforeProvision(input: Readonly<{
  databasePath: string;
  databaseInstanceId: string;
  exchangeAccountId: string;
  upbitAccessKeyFingerprint: string;
}>): void {
  const db = openReadOnlySqliteDatabase(input.databasePath);
  try {
    validateExchangeAccount(db, input.exchangeAccountId);
    const existing = readIdentity(db);
    if (
      existing !== null &&
      (existing.database_instance_id !== input.databaseInstanceId ||
        existing.exchange_account_id !== input.exchangeAccountId ||
        existing.upbit_access_key_sha256 !== input.upbitAccessKeyFingerprint)
    ) {
      throw new LiveDatabaseIdentityError(
        "IDENTITY_ALREADY_BOUND",
        "LIVE database is already bound to a different identity; provisioning never overwrites a binding.",
      );
    }
  } finally {
    db.close();
  }
}

function validateExistingAbsoluteDatabasePath(rawPath: string): string {
  const databasePath = requireNonEmpty(rawPath, "DATABASE_PATH");
  if (databasePath === ":memory:" || !isAbsolute(databasePath)) {
    throw new LiveDatabaseIdentityError(
      "DATABASE_PATH_NOT_ABSOLUTE",
      "LIVE DATABASE_PATH must be an explicit absolute path to an existing SQLite file.",
    );
  }
  try {
    return canonicalizeLocalDatabasePath(databasePath, { mustExist: true });
  } catch (error) {
    if (!(error instanceof LocalDatabasePathError)) throw error;
    const code = error.code === "DATABASE_PATH_NOT_FOUND"
      ? "DATABASE_NOT_FOUND"
      : error.code === "DATABASE_PATH_NOT_REGULAR_FILE"
        ? "DATABASE_NOT_REGULAR_FILE"
        : error.code;
    const message = error.code === "DATABASE_PATH_NOT_FOUND"
      ? "LIVE database does not exist; no file or directory was created."
      : `LIVE ${error.message}`;
    throw new LiveDatabaseIdentityError(code, message);
  }
}

function validateMigrationLedger(db: DatabaseSync): void {
  const integrityRows = db.prepare("PRAGMA quick_check").all() as unknown as Array<{ quick_check: string }>;
  if (integrityRows.length !== 1 || integrityRows[0]?.quick_check !== "ok") {
    throw new LiveDatabaseIdentityError("DATABASE_INTEGRITY_FAILED", "LIVE database failed SQLite quick_check.");
  }
  if (db.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new LiveDatabaseIdentityError(
      "DATABASE_FOREIGN_KEY_FAILED",
      "LIVE database contains foreign-key integrity violations.",
    );
  }
  const table = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_schema_migrations'
  `).get() as { name: string } | undefined;
  if (!table) {
    throw new LiveDatabaseIdentityError("MIGRATION_LEDGER_MISSING", "LIVE database migration ledger is missing.");
  }
  const appliedRows = db.prepare("SELECT filename FROM _schema_migrations ORDER BY filename").all() as unknown as Array<{ filename: string }>;
  const applied = new Set(appliedRows.map((row) => row.filename));
  const expected = listCanonicalMigrationFilenames();
  const missing = expected.filter((filename) => !applied.has(filename));
  if (missing.length > 0) {
    throw new LiveDatabaseIdentityError(
      "MIGRATION_MISSING",
      `LIVE database is missing required migration(s): ${missing.join(",")}.`,
    );
  }
  const expectedSet = new Set(expected);
  const unknown = [...applied].filter((filename) => !expectedSet.has(filename) && !RETIRED_MIGRATIONS.has(filename));
  if (unknown.length > 0) {
    throw new LiveDatabaseIdentityError(
      "MIGRATION_UNKNOWN",
      `LIVE database contains unknown migration(s): ${unknown.join(",")}.`,
    );
  }
}

function validateExchangeAccount(db: DatabaseSync, exchangeAccountId: string): void {
  const row = db.prepare(`
    SELECT id, exchange, venue_type, quote_currency, is_primary
    FROM exchange_accounts WHERE id = ? LIMIT 1
  `).get(exchangeAccountId) as ExchangeAccountIdentityRow | undefined;
  if (!row || row.exchange !== "UPBIT" || row.venue_type !== "SPOT" || row.quote_currency !== "KRW" || row.is_primary !== 1) {
    throw new LiveDatabaseIdentityError(
      "EXCHANGE_ACCOUNT_INVALID",
      "LIVE database does not contain the expected primary Upbit KRW spot account.",
    );
  }
}

function readIdentity(db: DatabaseSync): LiveDatabaseIdentityRow | null {
  const table = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'live_database_identity'
  `).get() as { name: string } | undefined;
  if (!table) return null;
  const rows = db.prepare(`
    SELECT database_instance_id, exchange_account_id, upbit_access_key_sha256
    FROM live_database_identity ORDER BY singleton_id
  `).all() as unknown as LiveDatabaseIdentityRow[];
  if (rows.length > 1) {
    throw new LiveDatabaseIdentityError("IDENTITY_CORRUPT", "LIVE database contains multiple identity records.");
  }
  return rows[0] ?? null;
}

function validateInstanceId(value: string | null): string {
  const instanceId = requireNonEmpty(value ?? "", "LIVE_DATABASE_INSTANCE_ID");
  if (!UUID_PATTERN.test(instanceId)) {
    throw new LiveDatabaseIdentityError(
      "DATABASE_INSTANCE_ID_INVALID",
      "LIVE_DATABASE_INSTANCE_ID must be an explicit UUID with no default.",
    );
  }
  return instanceId.toLowerCase();
}

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new LiveDatabaseIdentityError("REQUIRED_VALUE_MISSING", `${name} must be configured explicitly for LIVE.`);
  }
  return normalized;
}
