import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  fingerprintUpbitAccessKey,
  provisionLiveDatabaseIdentity,
  verifyLiveDatabaseIdentity,
} from "../src/app/live-database-identity.js";
import { createSqlitePersistence } from "../src/modules/db/repositories/sqlite-repositories.js";
import { runLiveReadinessSmoke } from "../src/smoke/live-readiness.js";
import { runLiveSchedulerPreflightSmoke } from "../src/smoke/live-scheduler-preflight.js";
import { test } from "./harness.js";
import { loadAppConfig } from "../src/app/env.js";
import { createVerifiedApplication } from "../src/index.js";
import { createApp as createProductionApp } from "../src/app/create-app.js";

const INSTANCE_ID = "7d66cf9c-c739-4b39-a7ac-41a9a6f75e59";
const ACCESS_KEY = "test-access-key";

test("DRY_RUN database identity verification is a filesystem-free no-op", () => {
  const missingPath = resolve("definitely-missing", "dry-run.sqlite");
  const result = verifyLiveDatabaseIdentity({
    executionMode: "DRY_RUN",
    databasePath: missingPath,
    expectedDatabaseInstanceId: null,
    exchangeAccountId: "primary",
    upbitAccessKey: null,
  });

  assert.deepEqual(result, { status: "NOT_REQUIRED" });
});

test("database instance identity has no hidden default and is loaded only from explicit environment", () => {
  assert.equal(loadAppConfig({}).liveDatabaseInstanceId, null);
  assert.equal(loadAppConfig({ LIVE_DATABASE_INSTANCE_ID: INSTANCE_ID }).liveDatabaseInstanceId, INSTANCE_ID);
});

test("the production application composition root enforces identity before persistence creation", async () => {
  const previous = {
    APP_EXECUTION_MODE: process.env.APP_EXECUTION_MODE,
    DATABASE_PATH: process.env.DATABASE_PATH,
    LIVE_DATABASE_INSTANCE_ID: process.env.LIVE_DATABASE_INSTANCE_ID,
    UPBIT_ACCESS_KEY: process.env.UPBIT_ACCESS_KEY,
  };
  try {
    process.env.APP_EXECUTION_MODE = "LIVE";
    process.env.DATABASE_PATH = "./var/never-create-live.sqlite";
    process.env.LIVE_DATABASE_INSTANCE_ID = INSTANCE_ID;
    process.env.UPBIT_ACCESS_KEY = ACCESS_KEY;
    const config = loadAppConfig();
    assert.throws(() => createProductionApp(config), /absolute/u);
    assert.throws(
      () => createProductionApp(config, {
        liveDatabaseIdentityVerifier: () => ({ status: "NOT_REQUIRED" }),
      } as unknown as Parameters<typeof createProductionApp>[1]),
      /absolute/u,
    );
    await assert.rejects(
      () => createVerifiedApplication(async () => undefined),
      /absolute/u,
    );
  } finally {
    restoreEnv(previous);
  }
});

test("LIVE rejects relative and missing database paths without creating them", async () => {
  assert.throws(
    () => verifyLiveDatabaseIdentity({
      executionMode: "LIVE",
      databasePath: "./var/missing-live.sqlite",
      expectedDatabaseInstanceId: INSTANCE_ID,
      exchangeAccountId: "primary",
      upbitAccessKey: ACCESS_KEY,
    }),
    /absolute/u,
  );

  const directory = await mkdtemp(join(tmpdir(), "autotrade-live-identity-missing-"));
  const databasePath = join(directory, "nested", "missing.sqlite");
  try {
    assert.throws(
      () => verifyLiveDatabaseIdentity({
        executionMode: "LIVE",
        databasePath,
        expectedDatabaseInstanceId: INSTANCE_ID,
        exchangeAccountId: "primary",
        upbitAccessKey: ACCESS_KEY,
      }),
      /does not exist/u,
    );
    await assert.rejects(() => stat(databasePath));
    await assert.rejects(() => stat(join(directory, "nested")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit provisioning binds an existing migrated database and verification is read-only", async () => {
  const fixture = await createDatabaseFixture();
  try {
    const provisioned = provisionLiveDatabaseIdentity({
      databasePath: fixture.databasePath,
      databaseInstanceId: INSTANCE_ID,
      exchangeAccountId: "primary",
      upbitAccessKey: ACCESS_KEY,
    });
    assert.equal(provisioned.databaseInstanceId, INSTANCE_ID);
    assert.equal(provisioned.upbitAccessKeyFingerprint, fingerprintUpbitAccessKey(ACCESS_KEY));

    const beforeBytes = await readFile(fixture.databasePath);
    const beforeStat = await stat(fixture.databasePath);
    const verified = verifyLiveDatabaseIdentity({
      executionMode: "LIVE",
      databasePath: fixture.databasePath,
      expectedDatabaseInstanceId: INSTANCE_ID,
      exchangeAccountId: "primary",
      upbitAccessKey: ACCESS_KEY,
    });
    const afterBytes = await readFile(fixture.databasePath);
    const afterStat = await stat(fixture.databasePath);

    assert.equal(verified.status, "VERIFIED");
    assert.deepEqual(afterBytes, beforeBytes);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
  } finally {
    await fixture.cleanup();
  }
});

test("LIVE identity verification rejects database, account credential, and migration mismatches", async () => {
  const fixture = await createDatabaseFixture();
  try {
    provisionLiveDatabaseIdentity({
      databasePath: fixture.databasePath,
      databaseInstanceId: INSTANCE_ID,
      exchangeAccountId: "primary",
      upbitAccessKey: ACCESS_KEY,
    });

    assert.throws(() => verify(fixture.databasePath, {
      expectedDatabaseInstanceId: "e06711eb-1c7f-4f58-88dd-d4970329e5d8",
    }), /instance identity does not match/u);
    assert.throws(() => verify(fixture.databasePath, { upbitAccessKey: "rotated-key" }), /credential identity does not match/u);

    const db = new DatabaseSync(fixture.databasePath);
    db.prepare("DELETE FROM _schema_migrations WHERE filename = ?")
      .run("0024_add_runtime_ownership.sql");
    db.close();
    assert.throws(() => verify(fixture.databasePath), /missing required migration/u);

    const futureDb = new DatabaseSync(fixture.databasePath);
    futureDb.prepare("INSERT INTO _schema_migrations (filename, applied_at) VALUES (?, ?)")
      .run("0024_add_runtime_ownership.sql", "2026-08-25T00:00:00.000Z");
    futureDb.prepare("INSERT INTO _schema_migrations (filename, applied_at) VALUES (?, ?)")
      .run("9999_unknown_future.sql", "2026-08-25T00:00:00.000Z");
    futureDb.close();
    assert.throws(() => verify(fixture.databasePath), /unknown migration/u);
  } finally {
    await fixture.cleanup();
  }
});

test("retired migration 0013 is accepted but identity provisioning never overwrites a binding", async () => {
  const fixture = await createDatabaseFixture();
  try {
    const db = new DatabaseSync(fixture.databasePath);
    db.prepare("INSERT INTO _schema_migrations (filename, applied_at) VALUES (?, ?)")
      .run("0013_add_max_live_order_value_risk_code.sql", "2026-08-25T00:00:00.000Z");
    db.close();

    provisionLiveDatabaseIdentity({
      databasePath: fixture.databasePath,
      databaseInstanceId: INSTANCE_ID,
      exchangeAccountId: "primary",
      upbitAccessKey: ACCESS_KEY,
    });
    assert.equal(verify(fixture.databasePath).status, "VERIFIED");

    const before = await readFile(fixture.databasePath);
    assert.throws(() => provisionLiveDatabaseIdentity({
      databasePath: fixture.databasePath,
      databaseInstanceId: "e06711eb-1c7f-4f58-88dd-d4970329e5d8",
      exchangeAccountId: "primary",
      upbitAccessKey: ACCESS_KEY,
    }), /already bound/u);
    assert.deepEqual(await readFile(fixture.databasePath), before);
  } finally {
    await fixture.cleanup();
  }
});

test("default LIVE readiness and scheduler preflight inspect the verified database without mutation", async () => {
  const fixture = await createDatabaseFixture();
  const keys = [
    "APP_EXECUTION_MODE", "ENABLE_LIVE_ORDERS", "DATABASE_PATH", "LIVE_DATABASE_INSTANCE_ID",
    "UPBIT_ACCESS_KEY", "UPBIT_SECRET_KEY", "STRATEGY_SCHEDULER_ENABLED",
    "STRATEGY_SCHEDULER_RUN_ON_START",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    provisionLiveDatabaseIdentity({
      databasePath: fixture.databasePath,
      databaseInstanceId: INSTANCE_ID,
      exchangeAccountId: "primary",
      upbitAccessKey: ACCESS_KEY,
    });
    process.env.APP_EXECUTION_MODE = "LIVE";
    process.env.ENABLE_LIVE_ORDERS = "true";
    process.env.DATABASE_PATH = fixture.databasePath;
    process.env.LIVE_DATABASE_INSTANCE_ID = INSTANCE_ID;
    process.env.UPBIT_ACCESS_KEY = ACCESS_KEY;
    process.env.UPBIT_SECRET_KEY = "test-secret-key";
    process.env.STRATEGY_SCHEDULER_ENABLED = "false";
    process.env.STRATEGY_SCHEDULER_RUN_ON_START = "false";

    const before = await readFile(fixture.databasePath);
    const readiness = await runLiveReadinessSmoke();
    const scheduler = await runLiveSchedulerPreflightSmoke();
    const after = await readFile(fixture.databasePath);

    assert.equal(readiness.nonMutationBoundary.databaseWrites, false);
    assert.equal(readiness.nonMutationBoundary.migrations, false);
    assert.equal(scheduler.nonMutationBoundary.databaseWrites, false);
    assert.equal(scheduler.nonMutationBoundary.migrations, false);
    assert.deepEqual(after, before);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fixture.cleanup();
  }
});

test("all checked-in LIVE launch and smoke scripts require an existing absolute DB and provisioned identity", async () => {
  const scriptNames = [
    "start-company-live.example.ps1",
    "start-company-live-scheduler.example.ps1",
    "smoke-live-readiness.example.ps1",
    "smoke-live-scheduler-preflight.example.ps1",
  ];
  for (const scriptName of scriptNames) {
    const source = await readFile(resolve("scripts", scriptName), "utf8");
    assert.match(source, /Resolve-Path -LiteralPath/u, scriptName);
    assert.match(source, /LIVE_DATABASE_INSTANCE_ID/u, scriptName);
    assert.match(source, /REPLACE_WITH_PROVISIONED_DATABASE_INSTANCE_UUID/u, scriptName);
    assert.doesNotMatch(source, /DATABASE_PATH\s*=\s*"\.\/var\/company-live\.sqlite"/u, scriptName);
  }
});

function verify(
  databasePath: string,
  overrides: Partial<Parameters<typeof verifyLiveDatabaseIdentity>[0]> = {},
) {
  return verifyLiveDatabaseIdentity({
    executionMode: "LIVE",
    databasePath,
    expectedDatabaseInstanceId: INSTANCE_ID,
    exchangeAccountId: "primary",
    upbitAccessKey: ACCESS_KEY,
    ...overrides,
  });
}

async function createDatabaseFixture(): Promise<{
  databasePath: string;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "autotrade-live-identity-"));
  const databasePath = join(directory, "live.sqlite");
  const persistence = createSqlitePersistence({
    databasePath,
    exchangeAccountId: "primary",
    userId: "operator",
    userTelegramId: "operator",
    userDisplayName: "Operator",
    accessKeyRef: "ENV:UPBIT_ACCESS_KEY",
    secretKeyRef: "ENV:UPBIT_SECRET_KEY",
    executionMode: "LIVE",
    liveExecutionGate: "ENABLED",
    killSwitchActive: false,
  });
  persistence.close();
  return {
    databasePath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
