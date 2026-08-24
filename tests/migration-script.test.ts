import assert from "node:assert/strict";

import { parseMigrationScript } from "../src/modules/db/migration-script.js";
import { test } from "./harness.js";

test("migration parser unwraps one outer transaction without rewriting trigger bodies", () => {
  const triggerSql = `CREATE TRIGGER sample_no_update
BEFORE UPDATE ON sample
BEGIN
  SELECT CASE
    WHEN NEW.value = 'BEGIN; COMMIT; END;'
    THEN RAISE(ABORT, 'sample rows are append-only')
  END;
END;`;
  const parsed = parseMigrationScript(`
    -- Foreign keys must be disabled before the atomic outer transaction.
    PRAGMA foreign_keys = OFF;
    BEGIN IMMEDIATE;
    CREATE TABLE sample (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    ${triggerSql}
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);

  assert.equal(parsed.requiresForeignKeysOff, true);
  assert.equal(parsed.hadTransactionEnvelope, true);
  assert.match(parsed.bodySql, /CREATE TABLE sample/u);
  assert.equal(parsed.bodySql.includes(triggerSql), true);
  assert.doesNotMatch(parsed.bodySql, /PRAGMA foreign_keys|BEGIN IMMEDIATE|\n\s*COMMIT;/iu);
});

test("migration parser accepts a plain script for atomic outer execution", () => {
  const parsed = parseMigrationScript(`
    -- A plain migration still belongs to the runner's transaction.
    ALTER TABLE sample ADD COLUMN created_at TEXT;
  `);

  assert.equal(parsed.requiresForeignKeysOff, false);
  assert.equal(parsed.hadTransactionEnvelope, false);
  assert.match(parsed.bodySql, /ALTER TABLE sample/u);
});

test("migration parser rejects malformed or nested transaction control", () => {
  for (const sql of [
    "BEGIN IMMEDIATE;\nCREATE TABLE sample (id TEXT);",
    "COMMIT;\nCREATE TABLE sample (id TEXT);",
    "BEGIN IMMEDIATE;\nBEGIN IMMEDIATE;\nCOMMIT;\nCOMMIT;",
    "PRAGMA foreign_keys = OFF;\nCREATE TABLE sample (id TEXT);",
    "BEGIN;\nCREATE TABLE sample (id TEXT);\nCOMMIT;",
    "BEGIN EXCLUSIVE;\nCREATE TABLE sample (id TEXT);\nCOMMIT;",
    "CREATE TABLE sample (id TEXT);\nEND;",
  ]) {
    assert.throws(() => parseMigrationScript(sql), /malformed migration transaction structure/iu);
  }
});
