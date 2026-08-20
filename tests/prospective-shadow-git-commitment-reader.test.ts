import assert from "node:assert/strict";
import test from "node:test";

import {
  PROSPECTIVE_SHADOW_REGISTRATION_PATH,
  PROSPECTIVE_SHADOW_REGISTRY_PATH,
  PROSPECTIVE_SHADOW_WORKFLOW_PATH,
} from "../src/modules/performance/performance-prospective-shadow-commitment.js";
import {
  createReadOnlyGitRunner,
  readProspectiveShadowGitEvidence,
  type ReadOnlyGitRunner,
} from "../src/research/prospective-shadow-git-commitment-reader.js";

const IMPLEMENTATION = "1".repeat(40);
const PUBLICATION = "2".repeat(40);

test("initial evidence reader issues only the exact read-only git commands and detaches bytes", async () => {
  const calls: string[][] = [];
  const outputs = new Map<string, string>([
    [`rev-parse HEAD`, `${IMPLEMENTATION}\n`],
    [`show --no-patch --format=%P ${PUBLICATION}`, `${IMPLEMENTATION}\n`],
    [`diff-tree --no-commit-id --name-only -r ${PUBLICATION}`, `${PROSPECTIVE_SHADOW_REGISTRATION_PATH}\n${PROSPECTIVE_SHADOW_REGISTRY_PATH}\n`],
    [`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`, "registration\n"],
    [`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`, "registry\n"],
    [`show ${IMPLEMENTATION}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`, "workflow\n"],
    [`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`, "workflow\n"],
  ]);
  const runner: ReadOnlyGitRunner = {
    run: async (args) => {
      calls.push([...args]);
      if (args.join(" ") === `show ${IMPLEMENTATION}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}` ||
          args.join(" ") === `show ${IMPLEMENTATION}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`) {
        return { exitCode: 128, stdout: "", stderr: "path does not exist" };
      }
      const stdout = outputs.get(args.join(" "));
      if (stdout === undefined) return { exitCode: 1, stdout: "", stderr: "unexpected" };
      return { exitCode: 0, stdout, stderr: "" };
    },
  };

  const evidence = await readProspectiveShadowGitEvidence({
    mode: "REGISTERED_PUBLICATION",
    implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
  }, runner);
  assert.equal(evidence.mode, "REGISTERED_PUBLICATION");
  if (evidence.mode !== "REGISTERED_PUBLICATION") throw new Error("unexpected evidence mode");
  outputs.set(`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`, "mutated\n");

  assert.equal(evidence.registrationBytes, "registration\n");
  assert.equal(evidence.registrationAtImplementation.status, "MISSING");
  assert.equal(evidence.registryAtImplementation.status, "MISSING");
  assert.equal(calls.length, 9);
  assert.equal(Object.isFrozen(evidence), true);
});

test("read-only git runner rejects mutations, network, shell fragments, and unapproved reads before execution", async () => {
  const executed: string[][] = [];
  const runner = createReadOnlyGitRunner("C:/fixture", async (_cwd, args) => {
    executed.push([...args]);
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  });
  for (const args of [
    ["checkout", "main"], ["fetch", "origin"], ["push"], ["reset", "--hard"],
    ["rev-parse", "https://github.com/x/y"], ["show", `${PUBLICATION}:README.md;echo pwned`],
    ["config", "--get", "remote.origin.url"], ["log", "--all"],
  ]) {
    await assert.rejects(runner.run(args), /read-only allowlist|forbidden/i);
  }
  assert.deepEqual(executed, []);

  await runner.run(["rev-parse", "HEAD"]);
  assert.deepEqual(executed, [["rev-parse", "HEAD"]]);
});

test("reader surfaces git failure without fallback or additional mutation command", async () => {
  const calls: string[][] = [];
  const runner: ReadOnlyGitRunner = {
    run: async (args) => {
      calls.push([...args]);
      return { exitCode: 128, stdout: "", stderr: "missing object" };
    },
  };
  await assert.rejects(readProspectiveShadowGitEvidence({
    mode: "REGISTERED_PUBLICATION",
    implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
  }, runner), /missing object|git/i);
  assert.deepEqual(calls, [["rev-parse", "HEAD"]]);
});

test("reader preserves Git's space-separated merge parents as distinct commits", async () => {
  const otherParent = "3".repeat(40);
  const runner: ReadOnlyGitRunner = {
    run: async (args) => {
      const key = args.join(" ");
      const outputs: Record<string, string> = {
        "rev-parse HEAD": `${IMPLEMENTATION}\n`,
        [`show --no-patch --format=%P ${PUBLICATION}`]: `${IMPLEMENTATION} ${otherParent}\n`,
        [`diff-tree --no-commit-id --name-only -r ${PUBLICATION}`]: `${PROSPECTIVE_SHADOW_REGISTRATION_PATH}\n${PROSPECTIVE_SHADOW_REGISTRY_PATH}\n`,
        [`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]: "registration\n",
        [`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`]: "registry\n",
        [`show ${IMPLEMENTATION}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]: "workflow\n",
        [`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]: "workflow\n",
      };
      const expectedMissing = key === `show ${IMPLEMENTATION}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}` ||
        key === `show ${IMPLEMENTATION}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`;
      return { exitCode: expectedMissing ? 128 : outputs[key] === undefined ? 1 : 0, stdout: outputs[key] ?? "", stderr: expectedMissing ? "missing path" : "" };
    },
  };
  const evidence = await readProspectiveShadowGitEvidence({
    mode: "REGISTERED_PUBLICATION",
    implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
  }, runner);
  assert.equal(evidence.mode, "REGISTERED_PUBLICATION");
  if (evidence.mode !== "REGISTERED_PUBLICATION") throw new Error("unexpected evidence mode");
  assert.deepEqual(evidence.publicationParents, [IMPLEMENTATION, otherParent]);
});

test("closure reader captures per-relevant-commit parents, complete paths, and file bytes", async () => {
  const closure = "3".repeat(40);
  const tamper = "4".repeat(40);
  const calls: string[][] = [];
  const outputs: Record<string, string> = {
    "rev-parse HEAD": `${closure}\n`,
    [`log --reverse --format=%H ${PUBLICATION}^..${closure} -- ${PROSPECTIVE_SHADOW_REGISTRATION_PATH} ${PROSPECTIVE_SHADOW_REGISTRY_PATH}`]: `${PUBLICATION}\n${tamper}\n${closure}\n`,
    [`show ${PUBLICATION}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]: "registration\n",
    [`show ${closure}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]: "registration\n",
    [`show ${closure}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`]: "registry\n",
    [`show ${IMPLEMENTATION}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]: "workflow\n",
    [`show ${closure}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]: "workflow\n",
  };
  for (const [sha, parent, registry] of [
    [PUBLICATION, IMPLEMENTATION, "registry\n"],
    [tamper, PUBLICATION, "tampered\n"],
    [closure, tamper, "registry\n"],
  ] as const) {
    outputs[`show --no-patch --format=%P ${sha}`] = `${parent}\n`;
    outputs[`diff-tree --no-commit-id --name-only -r ${sha}`] = `${PROSPECTIVE_SHADOW_REGISTRY_PATH}\n`;
    outputs[`show ${sha}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`] = "registration\n";
    outputs[`show ${sha}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`] = registry;
    outputs[`show ${sha}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`] = "workflow\n";
  }
  outputs[`diff-tree --no-commit-id --name-only -r ${PUBLICATION}`] = `${PROSPECTIVE_SHADOW_REGISTRATION_PATH}\n${PROSPECTIVE_SHADOW_REGISTRY_PATH}\n`;
  const runner: ReadOnlyGitRunner = { run: async (args) => {
    calls.push([...args]);
    if (args[0] === "merge-base") return { exitCode: 0, stdout: "", stderr: "" };
    const stdout = outputs[args.join(" ")];
    return { exitCode: stdout === undefined ? 1 : 0, stdout: stdout ?? "", stderr: stdout === undefined ? "unexpected" : "" };
  } };
  const evidence = await readProspectiveShadowGitEvidence({
    mode: "CLOSURE",
    implementationCommitSha: IMPLEMENTATION,
    publicationCommitSha: PUBLICATION,
    closureTipSha: closure,
  }, runner);
  assert.equal(evidence.mode, "CLOSURE");
  if (evidence.mode !== "CLOSURE") throw new Error("unexpected mode");
  assert.equal(evidence.relevantPathHistory.length, 3);
  assert.equal(evidence.relevantPathHistory[1]?.registry.status, "PRESENT");
  assert.equal(evidence.relevantPathHistory[1]?.registry.status === "PRESENT" ? evidence.relevantPathHistory[1].registry.bytes : "", "tampered\n");
  assert.equal(calls.some((args) => args[0] === "diff-tree" && args.at(-1) === tamper), true);
});
