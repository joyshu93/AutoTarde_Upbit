import assert from "node:assert/strict";
import {
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  type BigIntStats,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  loadPositionGuardPilotAbandonmentFromRepositoryRootForTest,
  projectPositionGuardPilotRepositoryRootFromModuleFileForTest,
  validatePositionGuardPilotRegistryBytes,
} from "../src/app/position-guard-pilot-registry-loader.js";
import { test } from "./harness.js";

const REGISTERED_LINE = "{\"authority\":\"PROSPECTIVE_COMPONENT_SHADOW_V1\",\"event\":\"REGISTERED\",\"eventAt\":\"2026-08-20T07:54:01.786Z\",\"experimentId\":\"PCS-2026-001\",\"registrationPayloadSha256\":\"978e31695707453507fa604bae71f3f1657a061f891e621f2026f1e293c53b40\",\"schemaVersion\":1}";
const ABANDONED_LINE = "{\"authority\":\"PROSPECTIVE_COMPONENT_SHADOW_V1\",\"event\":\"ABANDONED\",\"eventAt\":\"2026-08-21T03:08:24.756Z\",\"experimentId\":\"PCS-2026-001\",\"publicationCommitSha\":\"358113dba5cd0425161a4aed0827f496d268d1f5\",\"reason\":\"operator-abandoned-before-window-start-for-separately-governed-btc-only-live-pilot-no-prospective-outcomes-collected-or-evaluated\",\"registrationPayloadSha256\":\"978e31695707453507fa604bae71f3f1657a061f891e621f2026f1e293c53b40\",\"schemaVersion\":1}";
const CANONICAL_REGISTRY = `${REGISTERED_LINE}\n${ABANDONED_LINE}\n`;
const REGISTRY_RELATIVE_PATH = join(
  "docs",
  "research",
  "prospective-shadow",
  "registry.jsonl",
);

type RegistryStatsStage =
  | "OPENED_BEFORE_READ"
  | "PATH_BEFORE_READ"
  | "OPENED_AFTER_READ"
  | "PATH_AFTER_READ";

type RegistryStatsProjector = (
  stage: RegistryStatsStage,
  stats: BigIntStats,
) => BigIntStats;

test("registry module path projection ignores cwd for source and compiled layouts", () => {
  const repositoryRoot = resolve("synthetic-position-guard-pilot-repository");
  const sourceModule = join(
    repositoryRoot,
    "src",
    "app",
    "position-guard-pilot-registry-loader.ts",
  );
  const compiledModule = join(
    repositoryRoot,
    "dist",
    "src",
    "app",
    "position-guard-pilot-registry-loader.js",
  );

  assert.equal(
    projectPositionGuardPilotRepositoryRootFromModuleFileForTest(sourceModule),
    repositoryRoot,
  );
  assert.equal(
    projectPositionGuardPilotRepositoryRootFromModuleFileForTest(compiledModule),
    repositoryRoot,
  );
});

test("registry bytes validator accepts exact LF and whole-file CRLF bytes", () => {
  for (const text of [CANONICAL_REGISTRY, CANONICAL_REGISTRY.replaceAll("\n", "\r\n")]) {
    const validation = validatePositionGuardPilotRegistryBytes(Buffer.from(text, "utf8"));
    assert.equal(Object.isFrozen(validation), true);
    assert.deepEqual(validation, {
      valid: true,
      experimentId: "PCS-2026-001",
      eventAt: "2026-08-21T03:08:24.756Z",
    });
  }
});

test("registry bytes validator rejects malformed newline and UTF-8 encodings", () => {
  for (const bytes of [
    Buffer.from(CANONICAL_REGISTRY.replace("\n", "\r\n"), "utf8"),
    Buffer.from(CANONICAL_REGISTRY.replace("\n", "\r"), "utf8"),
    Buffer.from([0xc3, 0x28]),
  ]) {
    assert.throws(() => validatePositionGuardPilotRegistryBytes(bytes));
  }
});

test("registry bytes validator rejects every non-canonical registry mutation", () => {
  const mutations = [
    `${ABANDONED_LINE}\n${REGISTERED_LINE}\n`,
    `${REGISTERED_LINE}\n`,
    `${REGISTERED_LINE}\n${ABANDONED_LINE}\n${ABANDONED_LINE}\n`,
    `${REGISTERED_LINE}\n${REGISTERED_LINE}\n`,
    `${REGISTERED_LINE.replace("REGISTERED", "ABANDONED")}\n${ABANDONED_LINE}\n`,
    `${REGISTERED_LINE}\n${ABANDONED_LINE.replace("PCS-2026-001", "PCS-2026-002")}\n`,
    `${REGISTERED_LINE}\n${ABANDONED_LINE.replace("358113d", "058113d")}\n`,
    `${REGISTERED_LINE}\n${ABANDONED_LINE} \n`,
    ` ${REGISTERED_LINE}\n${ABANDONED_LINE}\n`,
    `${REGISTERED_LINE}\n${ABANDONED_LINE}`,
    `${REGISTERED_LINE.replace("\"event\":", "\"event\":\"REGISTERED\",\"event\":")}\n${ABANDONED_LINE}\n`,
  ];

  for (const text of mutations) {
    assert.throws(() => validatePositionGuardPilotRegistryBytes(Buffer.from(text, "utf8")));
  }
});

test("registry file loader reads only the fixed path below a repository root", () => {
  withTemporaryRepository((repositoryRoot, registryPath) => {
    writeFileSync(registryPath, CANONICAL_REGISTRY, "utf8");

    assert.deepEqual(
      loadPositionGuardPilotAbandonmentFromRepositoryRootForTest(repositoryRoot),
      {
        valid: true,
        experimentId: "PCS-2026-001",
        eventAt: "2026-08-21T03:08:24.756Z",
      },
    );
  });
});

test("registry file loader fails closed for a missing fixed registry", () => {
  withTemporaryRepository((repositoryRoot) => {
    assert.throws(
      () => loadPositionGuardPilotAbandonmentFromRepositoryRootForTest(repositoryRoot),
    );
  }, { createRegistryDirectory: false });
});

test("registry fixture reader cannot bypass canonical byte validation", () => {
  withTemporaryRepository((repositoryRoot, registryPath) => {
    writeFileSync(registryPath, CANONICAL_REGISTRY, "utf8");

    assert.throws(() => loadPositionGuardPilotAbandonmentFromRepositoryRootForTest(
      repositoryRoot,
      (_descriptor, openedPath) => {
        assert.equal(openedPath, registryPath);
        return Buffer.from(CANONICAL_REGISTRY.replace("PCS-2026-001", "PCS-2026-002"));
      },
    ));
  });
});

test("registry file loader rejects a junction in the fixed path", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "autotrade-pilot-registry-link-"));
  try {
    const repositoryRoot = join(temporaryRoot, "repository");
    const outsideDocs = join(temporaryRoot, "outside-docs");
    mkdirSync(join(outsideDocs, "research", "prospective-shadow"), { recursive: true });
    writeFileSync(
      join(outsideDocs, "research", "prospective-shadow", "registry.jsonl"),
      CANONICAL_REGISTRY,
      "utf8",
    );
    mkdirSync(repositoryRoot, { recursive: true });
    symlinkSync(outsideDocs, join(repositoryRoot, "docs"), "junction");

    assert.throws(
      () => loadPositionGuardPilotAbandonmentFromRepositoryRootForTest(repositoryRoot),
    );
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test("registry file loader detects a path swap after opening the descriptor", () => {
  withTemporaryRepository((repositoryRoot, registryPath) => {
    writeFileSync(registryPath, CANONICAL_REGISTRY, "utf8");
    const originalPath = `${registryPath}.opened`;
    let openedDescriptor: number | null = null;

    assert.throws(() => loadPositionGuardPilotAbandonmentFromRepositoryRootForTest(
      repositoryRoot,
      (descriptor, openedPath) => {
        openedDescriptor = descriptor;
        assert.equal(openedPath, registryPath);
        renameSync(openedPath, originalPath);
        writeFileSync(openedPath, CANONICAL_REGISTRY, "utf8");
        return readFileSync(descriptor);
      },
    ));

    assert.notEqual(openedDescriptor, null);
    assert.throws(() => fstatSync(openedDescriptor as unknown as number));
  });
});

test("registry file loader accepts stable canonical files when dev and ino are unavailable", () => {
  withTemporaryRepository((repositoryRoot, registryPath) => {
    writeFileSync(registryPath, CANONICAL_REGISTRY, "utf8");
    const observedStages: RegistryStatsStage[] = [];

    assert.deepEqual(
      loadPositionGuardPilotAbandonmentFromRepositoryRootForTest(repositoryRoot, undefined, {
        projectStats: (stage, stats) => {
          observedStages.push(stage);
          return overrideStats(stats, { dev: 0n, ino: 0n });
        },
      }),
      {
        valid: true,
        experimentId: "PCS-2026-001",
        eventAt: "2026-08-21T03:08:24.756Z",
      },
    );
    assert.deepEqual(observedStages, [
      "OPENED_BEFORE_READ",
      "PATH_BEFORE_READ",
      "OPENED_AFTER_READ",
      "PATH_AFTER_READ",
    ]);
  });
});

test("registry file loader rejects partial or mismatched file identities", () => {
  for (const projectStats of [
    ((stage, stats) => overrideStats(
      stats,
      stage === "OPENED_BEFORE_READ"
        ? { dev: 0n, ino: 0n }
        : { dev: 11n, ino: 17n },
    )),
    ((stage, stats) => overrideStats(
      stats,
      stage === "PATH_BEFORE_READ"
        ? { dev: 11n, ino: 19n }
        : { dev: 11n, ino: 17n },
    )),
  ] satisfies RegistryStatsProjector[]) {
    withTemporaryRepository((repositoryRoot, registryPath) => {
      writeFileSync(registryPath, CANONICAL_REGISTRY, "utf8");
      assert.throws(() => loadPositionGuardPilotAbandonmentFromRepositoryRootForTest(
        repositoryRoot,
        undefined,
        { projectStats },
      ));
    });
  }
});

test("registry fallback identity rejects a path swap with changed metadata", () => {
  withTemporaryRepository((repositoryRoot, registryPath) => {
    writeFileSync(registryPath, CANONICAL_REGISTRY, "utf8");
    const originalPath = `${registryPath}.opened`;

    assert.throws(() => loadPositionGuardPilotAbandonmentFromRepositoryRootForTest(
      repositoryRoot,
      (descriptor, openedPath) => {
        renameSync(openedPath, originalPath);
        writeFileSync(openedPath, CANONICAL_REGISTRY, "utf8");
        utimesSync(openedPath, new Date(1_000), new Date(1_000));
        return readFileSync(descriptor);
      },
      {
        projectStats: (_stage, stats) => overrideStats(stats, { dev: 0n, ino: 0n }),
      },
    ));
  });
});

function withTemporaryRepository(
  run: (repositoryRoot: string, registryPath: string) => void,
  options: Readonly<{ createRegistryDirectory: boolean }> = { createRegistryDirectory: true },
): void {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "autotrade-pilot-registry-"));
  const registryPath = join(repositoryRoot, REGISTRY_RELATIVE_PATH);
  try {
    if (options.createRegistryDirectory) {
      mkdirSync(dirname(registryPath), { recursive: true });
    }
    run(repositoryRoot, registryPath);
  } finally {
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
}

function overrideStats(
  stats: BigIntStats,
  overrides: Readonly<Partial<Record<"dev" | "ino" | "mtimeNs", bigint>>>,
): BigIntStats {
  return new Proxy(stats, {
    get(target, property) {
      if (property in overrides) {
        return overrides[property as keyof typeof overrides];
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
