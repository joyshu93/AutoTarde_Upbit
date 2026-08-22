import assert from "node:assert/strict";
import {
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  loadPositionGuardPilotAbandonmentFromRepositoryRootForTest,
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
