import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PROSPECTIVE_SHADOW_POLICY_MANIFEST,
  parseProspectiveShadowRegistry,
  validateProspectiveShadowRegistration,
} from "../src/modules/performance/performance-prospective-shadow-registration.js";
import {
  ProspectiveShadowRegistrationWriterError,
  appendProspectiveShadowAbandonment,
  nodeProspectiveShadowRegistrationFileSystem,
  publishProspectiveShadowRegistration,
  type ProspectiveShadowRegistrationFileSystem,
} from "../src/modules/performance/performance-prospective-shadow-registration-writer.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const PUBLICATION_MARKER = ".publication-in-progress";
const LOCK_DIRECTORY = ".prospective-shadow.abandon.lock";
const LOCK_OWNER_FILE = "owner";

test("reserves the final directory, commits by removing its marker, and samples time once", async () => {
  await withRepository(async (repositoryRoot) => {
    let clockCalls = 0;
    const result = await publishProspectiveShadowRegistration(
      registrationInput(repositoryRoot),
      dependencies({
        now: () => {
          clockCalls += 1;
          return "2026-08-20T10:15:30+09:00";
        },
        randomSuffix: () => "publish-success",
      }),
    );
    assert.equal(clockCalls, 1);
    assert.equal(result.registration.registeredAt, "2026-08-20T01:15:30.000Z");
    assert.equal(result.registration.window.from, "2026-08-23T02:00:00.000Z");
    assert.deepEqual(await readdir(result.directoryPath), [
      "PCS-2026-001.registration.json",
      "registry.jsonl",
    ]);
    assert.equal(await readFile(result.registrationPath, "utf8"), result.registrationBytes);
    assert.equal(await readFile(result.registryPath, "utf8"), result.registryBytes);
    assert.equal(parseProspectiveShadowRegistry(result.registryBytes).events.length, 1);
    assert.equal(
      parseProspectiveShadowRegistry(result.registryBytes).registrationPayloadSha256,
      result.registration.payloadSha256,
    );
    assert.deepEqual(await researchEntries(repositoryRoot), ["prospective-shadow"]);
  });
});

test("refuses complete and incomplete existing final directories without altering either", async () => {
  await withRepository(async (repositoryRoot) => {
    const published = await publish(repositoryRoot);
    const registrationBefore = await readFile(published.registrationPath, "utf8");
    await assert.rejects(
      publishProspectiveShadowRegistration(
        registrationInput(repositoryRoot),
        dependencies({ randomSuffix: () => "existing-complete" }),
      ),
      /already exists/i,
    );
    assert.equal(await readFile(published.registrationPath, "utf8"), registrationBefore);
  });

  await withRepository(async (repositoryRoot) => {
    const finalDirectory = canonicalDirectory(repositoryRoot);
    await mkdir(finalDirectory, { recursive: true });
    await writeFile(join(finalDirectory, PUBLICATION_MARKER), "foreign-owner\n", "utf8");
    await writeFile(join(finalDirectory, "partial.txt"), "keep-me", "utf8");
    await assert.rejects(
      publishProspectiveShadowRegistration(
        registrationInput(repositoryRoot),
        dependencies({ randomSuffix: () => "existing-incomplete" }),
      ),
      /incomplete publication/i,
    );
    assert.equal(await readFile(join(finalDirectory, "partial.txt"), "utf8"), "keep-me");
    assert.equal(await readFile(join(finalDirectory, PUBLICATION_MARKER), "utf8"), "foreign-owner\n");
  });
});

test("concurrent publishers leave exactly one complete marker-free publication", async () => {
  await withRepository(async (repositoryRoot) => {
    let suffix = 0;
    const shared = dependencies({ randomSuffix: () => `race-${suffix += 1}` });
    const attempts = await Promise.allSettled([
      publishProspectiveShadowRegistration(registrationInput(repositoryRoot), shared),
      publishProspectiveShadowRegistration(registrationInput(repositoryRoot), shared),
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
    const finalDirectory = canonicalDirectory(repositoryRoot);
    const registration = validateProspectiveShadowRegistration(
      JSON.parse(await readFile(join(finalDirectory, "PCS-2026-001.registration.json"), "utf8")),
    );
    const registry = parseProspectiveShadowRegistry(
      await readFile(join(finalDirectory, "registry.jsonl"), "utf8"),
    );
    assert.equal(registry.registrationPayloadSha256, registration.payloadSha256);
    assert.deepEqual(await readdir(finalDirectory), [
      "PCS-2026-001.registration.json",
      "registry.jsonl",
    ]);
  });
});

test("a canonical-file failure removes a final directory only when its owner marker still matches", async () => {
  await withRepository(async (repositoryRoot) => {
    let writes = 0;
    const fs: ProspectiveShadowRegistrationFileSystem = {
      ...nodeProspectiveShadowRegistrationFileSystem,
      writeFileExclusive: async (path, bytes) => {
        writes += 1;
        if (writes === 2) throw new Error("injected canonical write failure");
        await nodeProspectiveShadowRegistrationFileSystem.writeFileExclusive(path, bytes);
      },
    };
    const error = await captureWriterError(() => publishProspectiveShadowRegistration(
      registrationInput(repositoryRoot),
      dependencies({ fs, randomSuffix: () => "owned-cleanup" }),
    ));
    assert.match(error.message, /canonical write failure/);
    assert.deepEqual(error.cleanupWarnings, []);
    assert.deepEqual(await researchEntries(repositoryRoot), []);
  });

  await withRepository(async (repositoryRoot) => {
    let writes = 0;
    const fs: ProspectiveShadowRegistrationFileSystem = {
      ...nodeProspectiveShadowRegistrationFileSystem,
      writeFileExclusive: async (path, bytes) => {
        writes += 1;
        if (writes === 2) {
          await writeFile(join(canonicalDirectory(repositoryRoot), PUBLICATION_MARKER), "replacement-owner\n", "utf8");
          throw new Error("injected owner swap failure");
        }
        await nodeProspectiveShadowRegistrationFileSystem.writeFileExclusive(path, bytes);
      },
    };
    const error = await captureWriterError(() => publishProspectiveShadowRegistration(
      registrationInput(repositoryRoot),
      dependencies({ fs, randomSuffix: () => "owner-swap" }),
    ));
    assert.match(error.message, /owner swap failure/);
    assert.equal(error.cleanupWarnings.some((warning) => /ownership/i.test(warning)), true);
    assert.equal(
      await readFile(join(canonicalDirectory(repositoryRoot), PUBLICATION_MARKER), "utf8"),
      "replacement-owner\n",
    );
  });
});

test("marker creation failure leaves an incomplete unowned reservation and reports cleanup detail", async () => {
  await withRepository(async (repositoryRoot) => {
    const fs = failOnce(nodeProspectiveShadowRegistrationFileSystem, "writeFileExclusive");
    const error = await captureWriterError(() => publishProspectiveShadowRegistration(
      registrationInput(repositoryRoot),
      dependencies({ fs, randomSuffix: () => "marker-failure" }),
    ));
    assert.match(error.message, /injected writeFileExclusive failure/);
    assert.equal(error.cleanupWarnings.some((warning) => /ownership was not established/i.test(warning)), true);
    assert.deepEqual(await readdir(canonicalDirectory(repositoryRoot)), []);
    await assert.rejects(
      publishProspectiveShadowRegistration(
        registrationInput(repositoryRoot),
        dependencies({ randomSuffix: () => "after-marker-failure" }),
      ),
      /incomplete publication/i,
    );
  });
});

test("rejects symlink or junction components before writing registration artifacts", async () => {
  await withRepository(async (repositoryRoot) => {
    const outside = await mkdtemp(join(tmpdir(), "autotrade-prospective-outside-"));
    try {
      await mkdir(join(repositoryRoot, "docs"), { recursive: true });
      await symlink(outside, join(repositoryRoot, "docs", "research"), "junction");
      await assert.rejects(
        publishProspectiveShadowRegistration(
          registrationInput(repositoryRoot),
          dependencies({ randomSuffix: () => "junction" }),
        ),
        /symbolic link|junction|containment/i,
      );
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("caller mutation during awaited path validation cannot change publication bytes", async () => {
  await withRepository(async (repositoryRoot) => {
    let releaseRealPath!: () => void;
    const gate = new Promise<void>((resolve) => { releaseRealPath = resolve; });
    const input = registrationInput(repositoryRoot) as MutableRegistrationInput;
    let first = true;
    const fs: ProspectiveShadowRegistrationFileSystem = {
      ...nodeProspectiveShadowRegistrationFileSystem,
      realPath: async (path) => {
        if (first) {
          first = false;
          await gate;
        }
        return nodeProspectiveShadowRegistrationFileSystem.realPath(path);
      },
    };
    const publication = publishProspectiveShadowRegistration(
      input,
      dependencies({ fs, randomSuffix: () => "mutation" }),
    );
    input.implementationCommitSha = SHA_B;
    (input.policyManifest as unknown as { schemaVersion: number }).schemaVersion = 999;
    releaseRealPath();
    const result = await publication;
    assert.equal(result.registration.implementationCommitSha, SHA_A);
    assert.equal(result.registration.policyManifest.schemaVersion, 1);
  });
});

test("abandonment uses a non-empty exclusive lock directory and returns no warnings on clean commit", async () => {
  await withRepository(async (repositoryRoot) => {
    const published = await publish(repositoryRoot);
    const registrationBefore = await readFile(published.registrationPath, "utf8");
    const registryBefore = await readFile(published.registryPath, "utf8");
    let releaseRead!: () => void;
    let lockObserved = false;
    let registrationReads = 0;
    const gate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const fs: ProspectiveShadowRegistrationFileSystem = {
      ...nodeProspectiveShadowRegistrationFileSystem,
      readUtf8: async (path) => {
        if (path === published.registrationPath) registrationReads += 1;
        if (!lockObserved && path === published.registrationPath && registrationReads === 2) {
          lockObserved = true;
          assert.deepEqual(
            await readdir(join(repositoryRoot, "docs", "research", LOCK_DIRECTORY)),
            [LOCK_OWNER_FILE],
          );
          assert.notEqual(
            await readFile(join(repositoryRoot, "docs", "research", LOCK_DIRECTORY, LOCK_OWNER_FILE), "utf8"),
            "",
          );
          await gate;
        }
        return nodeProspectiveShadowRegistrationFileSystem.readUtf8(path);
      },
    };
    const pending = appendProspectiveShadowAbandonment(
      abandonmentInput(repositoryRoot, published.registration.payloadSha256),
      dependencies({ fs, now: () => "2026-08-25T12:34:56+09:00", randomSuffix: () => "abandon-success" }),
    );
    while (!lockObserved) await new Promise((resolve) => setTimeout(resolve, 1));
    releaseRead();
    const abandoned = await pending;
    assert.equal(await readFile(published.registrationPath, "utf8"), registrationBefore);
    assert.equal(abandoned.previousRegistryBytes, registryBefore);
    assert.equal(await readFile(published.registryPath, "utf8"), abandoned.registryBytes);
    assert.deepEqual(abandoned.cleanupWarnings, []);
    assert.deepEqual(await researchEntries(repositoryRoot), ["prospective-shadow"]);
  });
});

test("abandonment rejects incomplete publication, duplicate, hash mismatch, and close-or-later time", async () => {
  await withRepository(async (repositoryRoot) => {
    const finalDirectory = canonicalDirectory(repositoryRoot);
    await mkdir(finalDirectory, { recursive: true });
    await writeFile(join(finalDirectory, PUBLICATION_MARKER), "owner\n", "utf8");
    await assert.rejects(
      appendProspectiveShadowAbandonment(
        abandonmentInput(repositoryRoot, DIGEST_C),
        dependencies({ now: () => "2026-08-23T00:00:00Z" }),
      ),
      /incomplete publication/i,
    );
  });

  await withRepository(async (repositoryRoot) => {
    const published = await publish(repositoryRoot);
    const input = abandonmentInput(repositoryRoot, published.registration.payloadSha256);
    await appendProspectiveShadowAbandonment(input, dependencies({ now: () => "2026-08-23T00:00:00Z" }));
    await assert.rejects(
      appendProspectiveShadowAbandonment(input, dependencies({ now: () => "2026-08-23T01:00:00Z" })),
      /already abandoned/i,
    );
  });

  await withRepository(async (repositoryRoot) => {
    const published = await publish(repositoryRoot);
    await assert.rejects(
      appendProspectiveShadowAbandonment(
        abandonmentInput(repositoryRoot, DIGEST_D),
        dependencies({ now: () => "2026-08-23T00:00:00Z" }),
      ),
      /payload hash mismatch/i,
    );
    await assert.rejects(
      appendProspectiveShadowAbandonment(
        abandonmentInput(repositoryRoot, published.registration.payloadSha256),
        dependencies({ now: () => published.registration.window.to }),
      ),
      /before window.to/i,
    );
  });
});

test("pre-commit abandonment failure preserves registry and reports temp and lock cleanup failures", async () => {
  await withRepository(async (repositoryRoot) => {
    const published = await publish(repositoryRoot);
    const priorRegistry = await readFile(published.registryPath, "utf8");
    const fs: ProspectiveShadowRegistrationFileSystem = {
      ...nodeProspectiveShadowRegistrationFileSystem,
      replaceFileAtomic: async () => { throw new Error("injected replacement failure"); },
      removeFile: async (path) => {
        if (path.includes(".registry.")) throw new Error("injected temp cleanup failure");
        await nodeProspectiveShadowRegistrationFileSystem.removeFile(path);
      },
      removeDirectory: async (path) => {
        if (path.endsWith(LOCK_DIRECTORY)) throw new Error("injected lock cleanup failure");
        await nodeProspectiveShadowRegistrationFileSystem.removeDirectory(path);
      },
    };
    const error = await captureWriterError(() => appendProspectiveShadowAbandonment(
      abandonmentInput(repositoryRoot, published.registration.payloadSha256),
      dependencies({ fs, now: () => "2026-08-23T00:00:00Z", randomSuffix: () => "precommit-cleanup" }),
    ));
    assert.match(error.message, /replacement failure/);
    assert.equal(error.cleanupWarnings.some((warning) => /temp cleanup failure/i.test(warning)), true);
    assert.equal(error.cleanupWarnings.some((warning) => /lock cleanup failure/i.test(warning)), true);
    assert.equal(await readFile(published.registryPath, "utf8"), priorRegistry);
  });
});

test("a swapped lock owner is never removed during pre-commit cleanup", async () => {
  await withRepository(async (repositoryRoot) => {
    const published = await publish(repositoryRoot);
    const ownerPath = join(repositoryRoot, "docs", "research", LOCK_DIRECTORY, LOCK_OWNER_FILE);
    const fs: ProspectiveShadowRegistrationFileSystem = {
      ...nodeProspectiveShadowRegistrationFileSystem,
      replaceFileAtomic: async () => {
        await writeFile(ownerPath, "replacement-owner\n", "utf8");
        throw new Error("injected owner swap before commit");
      },
    };
    const error = await captureWriterError(() => appendProspectiveShadowAbandonment(
      abandonmentInput(repositoryRoot, published.registration.payloadSha256),
      dependencies({ fs, now: () => "2026-08-23T00:00:00Z", randomSuffix: () => "lock-owner-swap" }),
    ));
    assert.equal(error.cleanupWarnings.some((warning) => /ownership/i.test(warning)), true);
    assert.equal(await readFile(ownerPath, "utf8"), "replacement-owner\n");
  });
});

test("post-commit cleanup failures return warnings while preserving the committed abandonment", async () => {
  await withRepository(async (repositoryRoot) => {
    const published = await publish(repositoryRoot);
    const cleanupAttempts: string[] = [];
    const fs: ProspectiveShadowRegistrationFileSystem = {
      ...nodeProspectiveShadowRegistrationFileSystem,
      replaceFileAtomic: async (stagedPath, finalPath) => {
        const bytes = await readFile(stagedPath, "utf8");
        await nodeProspectiveShadowRegistrationFileSystem.replaceFileAtomic(stagedPath, finalPath);
        await writeFile(stagedPath, bytes, { encoding: "utf8", flag: "wx" });
      },
      removeFile: async (path) => {
        cleanupAttempts.push(`file:${path}`);
        if (path.includes(".registry.")) throw new Error("injected committed temp cleanup failure");
        await nodeProspectiveShadowRegistrationFileSystem.removeFile(path);
      },
      removeDirectory: async (path) => {
        cleanupAttempts.push(`directory:${path}`);
        if (path.endsWith(LOCK_DIRECTORY)) throw new Error("injected committed lock cleanup failure");
        await nodeProspectiveShadowRegistrationFileSystem.removeDirectory(path);
      },
    };
    const result = await appendProspectiveShadowAbandonment(
      abandonmentInput(repositoryRoot, published.registration.payloadSha256),
      dependencies({ fs, now: () => "2026-08-23T00:00:00Z", randomSuffix: () => "postcommit-cleanup" }),
    );
    assert.equal(parseProspectiveShadowRegistry(await readFile(published.registryPath, "utf8")).abandoned, true);
    assert.equal(result.cleanupWarnings.some((warning) => /committed temp cleanup failure/i.test(warning)), true);
    assert.equal(result.cleanupWarnings.some((warning) => /committed lock cleanup failure/i.test(warning)), true);
    assert.equal(cleanupAttempts.some((attempt) => attempt.startsWith("file:")), true);
    assert.equal(cleanupAttempts.some((attempt) => attempt.startsWith("directory:")), true);
  });
});

function registrationInput(repositoryRoot: string) {
  return {
    repositoryRoot,
    implementationCommitSha: SHA_A,
    developmentAuthoritySha256: DIGEST_C,
    retrospectiveReportSha256: DIGEST_D,
    policyManifest: structuredClone(PROSPECTIVE_SHADOW_POLICY_MANIFEST),
  };
}

function abandonmentInput(repositoryRoot: string, expectedRegistrationPayloadSha256: string) {
  return {
    repositoryRoot,
    expectedRegistrationPayloadSha256,
    publicationCommitSha: SHA_B,
    reason: "Prospective collection cannot continue.",
  };
}

type MutableRegistrationInput = ReturnType<typeof registrationInput> & {
  implementationCommitSha: string;
};

function dependencies(overrides: {
  now?: () => string;
  randomSuffix?: () => string;
  fs?: ProspectiveShadowRegistrationFileSystem;
} = {}) {
  return {
    now: overrides.now ?? (() => "2026-08-20T00:00:00Z"),
    randomSuffix: overrides.randomSuffix ?? (() => "fixed-suffix"),
    fs: overrides.fs ?? nodeProspectiveShadowRegistrationFileSystem,
  };
}

async function publish(repositoryRoot: string) {
  return publishProspectiveShadowRegistration(
    registrationInput(repositoryRoot),
    dependencies({ randomSuffix: () => "initial-publication" }),
  );
}

async function captureWriterError(run: () => Promise<unknown>): Promise<ProspectiveShadowRegistrationWriterError> {
  try {
    await run();
  } catch (error) {
    assert.equal(error instanceof ProspectiveShadowRegistrationWriterError, true);
    return error as ProspectiveShadowRegistrationWriterError;
  }
  throw new Error("Expected prospective shadow writer operation to fail.");
}

function failOnce<K extends keyof ProspectiveShadowRegistrationFileSystem>(
  base: ProspectiveShadowRegistrationFileSystem,
  method: K,
): ProspectiveShadowRegistrationFileSystem {
  let failed = false;
  const wrapper = { ...base } as ProspectiveShadowRegistrationFileSystem;
  (wrapper as unknown as Record<string, unknown>)[String(method)] = async (...args: unknown[]) => {
    if (!failed) {
      failed = true;
      throw new Error(`injected ${String(method)} failure`);
    }
    return (base[method] as (...values: unknown[]) => Promise<unknown>)(...args);
  };
  return wrapper;
}

function canonicalDirectory(repositoryRoot: string): string {
  return join(repositoryRoot, "docs", "research", "prospective-shadow");
}

async function researchEntries(repositoryRoot: string): Promise<string[]> {
  const researchDirectory = join(repositoryRoot, "docs", "research");
  try {
    return (await readdir(researchDirectory)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function withRepository(run: (repositoryRoot: string) => Promise<void>): Promise<void> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "autotrade-prospective-writer-"));
  try {
    await run(repositoryRoot);
  } finally {
    await rm(repositoryRoot, { recursive: true, force: true });
  }
}
