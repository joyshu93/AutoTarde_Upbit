import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  PROSPECTIVE_SHADOW_REGISTRATION_PATH,
  PROSPECTIVE_SHADOW_REGISTRY_PATH,
  PROSPECTIVE_SHADOW_WORKFLOW_PATH,
  type ProspectiveShadowAbandonmentGitEvidence,
  type ProspectiveShadowClosureGitEvidence,
  type ProspectiveShadowGitPathEvidence,
  type ProspectiveShadowRelevantPathCommitEvidence,
  type ProspectiveShadowPublicationGitEvidence,
} from "../modules/performance/performance-prospective-shadow-commitment.js";

const execFileAsync = promisify(execFile);
const COMMIT = /^[a-f0-9]{40}$/;
const SAFE_TOKEN = /^[a-zA-Z0-9._:/=+%^~-]+$/;
const CANONICAL_PATHS = new Set<string>([
  PROSPECTIVE_SHADOW_REGISTRATION_PATH,
  PROSPECTIVE_SHADOW_REGISTRY_PATH,
  PROSPECTIVE_SHADOW_WORKFLOW_PATH,
]);

export type ReadonlyGitResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export interface ReadOnlyGitRunner {
  run(args: readonly string[]): Promise<ReadonlyGitResult>;
}

export type ReadOnlyGitExecutor = (
  cwd: string,
  args: readonly string[],
) => Promise<ReadonlyGitResult>;

export type ReadProspectiveShadowGitEvidenceInput =
  | Readonly<{
      mode: "REGISTERED_PUBLICATION";
      implementationCommitSha: string;
      publicationCommitSha: string;
    }>
  | Readonly<{
      mode: "ABANDONED";
      implementationCommitSha: string;
      publicationCommitSha: string;
      abandonmentCommitSha: string;
    }>
  | Readonly<{
      mode: "CLOSURE";
      implementationCommitSha: string;
      publicationCommitSha: string;
      closureTipSha: string;
    }>;

export type ProspectiveShadowGitEvidence =
  | ProspectiveShadowPublicationGitEvidence
  | ProspectiveShadowAbandonmentGitEvidence
  | ProspectiveShadowClosureGitEvidence;

export function createReadOnlyGitRunner(
  cwd: string,
  executor: ReadOnlyGitExecutor = defaultExecutor,
): ReadOnlyGitRunner {
  if (typeof cwd !== "string" || cwd.trim() === "") throw new Error("Read-only Git working directory must be non-empty.");
  return {
    async run(args: readonly string[]): Promise<ReadonlyGitResult> {
      assertReadOnlyGitArgs(args);
      const result = await executor(cwd, [...args]);
      return Object.freeze({
        exitCode: requireExitCode(result.exitCode),
        stdout: String(result.stdout),
        stderr: String(result.stderr),
      });
    },
  };
}

export async function readProspectiveShadowGitEvidence(
  input: ReadProspectiveShadowGitEvidenceInput,
  runner: ReadOnlyGitRunner,
): Promise<ProspectiveShadowGitEvidence> {
  const implementation = requireCommit(input.implementationCommitSha, "implementationCommitSha");
  const publication = requireCommit(input.publicationCommitSha, "publicationCommitSha");
  const currentHeadSha = trimLine(await runRequired(runner, ["rev-parse", "HEAD"]));

  if (input.mode === "REGISTERED_PUBLICATION") {
    const parents = splitWhitespace(await runRequired(runner, ["show", "--no-patch", "--format=%P", publication]));
    const changedPaths = splitLines(await runRequired(runner, ["diff-tree", "--no-commit-id", "--name-only", "-r", publication]));
    const registrationBytes = await runRequired(runner, ["show", `${publication}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]);
    const registryBytes = await runRequired(runner, ["show", `${publication}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`]);
    const workflowAtImplementationBytes = await runRequired(runner, ["show", `${implementation}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]);
    const workflowAtPublicationBytes = await runRequired(runner, ["show", `${publication}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]);
    return deepFreeze({
      mode: "REGISTERED_PUBLICATION",
      currentHeadSha,
      publicationCommitSha: publication,
      publicationParents: parents,
      publicationChangedPaths: changedPaths,
      registrationAtImplementation: await readPathEvidence(runner, implementation, PROSPECTIVE_SHADOW_REGISTRATION_PATH),
      registryAtImplementation: await readPathEvidence(runner, implementation, PROSPECTIVE_SHADOW_REGISTRY_PATH),
      registrationBytes,
      registryBytes,
      workflowAtImplementationBytes,
      workflowAtPublicationBytes,
    });
  }

  if (input.mode === "ABANDONED") {
    const abandonment = requireCommit(input.abandonmentCommitSha, "abandonmentCommitSha");
    const ancestry = await runner.run(["merge-base", "--is-ancestor", publication, abandonment]);
    if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1) throw gitError(["merge-base", "--is-ancestor", publication, abandonment], ancestry);
    const parents = splitWhitespace(await runRequired(runner, ["show", "--no-patch", "--format=%P", abandonment]));
    const changedPaths = splitLines(await runRequired(runner, ["diff-tree", "--no-commit-id", "--name-only", "-r", abandonment]));
    return deepFreeze({
      mode: "ABANDONED",
      currentHeadSha,
      publicationCommitSha: publication,
      abandonmentCommitSha: abandonment,
      publicationIsAncestorOfAbandonment: ancestry.exitCode === 0,
      abandonmentParents: parents,
      abandonmentChangedPaths: changedPaths,
      registrationAtPublicationBytes: await runRequired(runner, ["show", `${publication}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]),
      registrationAtAbandonmentBytes: await runRequired(runner, ["show", `${abandonment}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]),
      registryAtPublicationBytes: await runRequired(runner, ["show", `${publication}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`]),
      registryAtAbandonmentBytes: await runRequired(runner, ["show", `${abandonment}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`]),
      workflowAtImplementationBytes: await runRequired(runner, ["show", `${implementation}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]),
      workflowAtAbandonmentBytes: await runRequired(runner, ["show", `${abandonment}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]),
    });
  }

  const closureTip = requireCommit(input.closureTipSha, "closureTipSha");
  const ancestry = await runner.run(["merge-base", "--is-ancestor", publication, closureTip]);
  if (ancestry.exitCode !== 0 && ancestry.exitCode !== 1) throw gitError(["merge-base", "--is-ancestor", publication, closureTip], ancestry);
  const historyBytes = await runRequired(runner, [
    "log", "--reverse", "--format=%H", `${publication}^..${closureTip}`, "--",
    PROSPECTIVE_SHADOW_REGISTRATION_PATH, PROSPECTIVE_SHADOW_REGISTRY_PATH,
  ]);
  const historyCommits = splitLines(historyBytes).map((commit) => requireCommit(commit, "relevantPathHistory commit"));
  const relevantPathHistory: ProspectiveShadowRelevantPathCommitEvidence[] = [];
  for (const commitSha of historyCommits) {
    relevantPathHistory.push(deepFreeze({
      commitSha,
      parents: splitWhitespace(await runRequired(runner, ["show", "--no-patch", "--format=%P", commitSha])),
      changedPaths: splitLines(await runRequired(runner, ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha])),
      registration: await readPathEvidence(runner, commitSha, PROSPECTIVE_SHADOW_REGISTRATION_PATH),
      registry: await readPathEvidence(runner, commitSha, PROSPECTIVE_SHADOW_REGISTRY_PATH),
      workflowBytes: await runRequired(runner, ["show", `${commitSha}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]),
    }));
  }
  return deepFreeze({
    mode: "CLOSURE",
    currentHeadSha,
    publicationCommitSha: publication,
    closureTipSha: closureTip,
    publicationIsAncestorOfClosureTip: ancestry.exitCode === 0,
    registrationAtPublicationBytes: await runRequired(runner, ["show", `${publication}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]),
    registrationAtClosureBytes: await runRequired(runner, ["show", `${closureTip}:${PROSPECTIVE_SHADOW_REGISTRATION_PATH}`]),
    registryAtClosureBytes: await runRequired(runner, ["show", `${closureTip}:${PROSPECTIVE_SHADOW_REGISTRY_PATH}`]),
    workflowAtImplementationBytes: await runRequired(runner, ["show", `${implementation}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]),
    workflowAtClosureBytes: await runRequired(runner, ["show", `${closureTip}:${PROSPECTIVE_SHADOW_WORKFLOW_PATH}`]),
    relevantPathHistory,
  });
}

async function readPathEvidence(
  runner: ReadOnlyGitRunner,
  commitSha: string,
  filePath: string,
): Promise<ProspectiveShadowGitPathEvidence> {
  const args = ["show", `${commitSha}:${filePath}`] as const;
  const result = await runner.run(args);
  if (result.exitCode === 0) return deepFreeze({ status: "PRESENT", bytes: String(result.stdout) });
  if (result.stdout !== "") throw new Error(`Read-only git show returned bytes while reporting failure for ${filePath}.`);
  const stderr = result.stderr.trim();
  if (stderr === "") throw gitError(args, result);
  return deepFreeze({ status: "MISSING", exitCode: result.exitCode, stderr });
}

function assertReadOnlyGitArgs(args: readonly string[]): void {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== "string" || !SAFE_TOKEN.test(arg))) {
    throw new Error("Git arguments contain a forbidden token outside the read-only allowlist.");
  }
  const [command, ...rest] = args;
  const allowed =
    (command === "rev-parse" && rest.length === 1 && rest[0] === "HEAD") ||
    (command === "show" && isAllowedShow(rest)) ||
    (command === "diff-tree" && isAllowedDiffTree(rest)) ||
    (command === "merge-base" && rest.length === 3 && rest[0] === "--is-ancestor" && isCommit(rest[1]) && isCommit(rest[2])) ||
    (command === "log" && isAllowedLog(rest));
  if (!allowed) throw new Error("Git command is outside the prospective read-only allowlist.");
}

function isAllowedShow(args: readonly string[]): boolean {
  if (args.length === 3 && args[0] === "--no-patch" && args[1] === "--format=%P") return isCommit(args[2]);
  if (args.length !== 1) return false;
  const token = args[0];
  if (token === undefined) return false;
  const separator = token.indexOf(":");
  if (separator < 0) return false;
  return isCommit(token.slice(0, separator)) && CANONICAL_PATHS.has(token.slice(separator + 1));
}

function isAllowedDiffTree(args: readonly string[]): boolean {
  return args.length === 4 && args[0] === "--no-commit-id" && args[1] === "--name-only" && args[2] === "-r" && isCommit(args[3]);
}

function isAllowedLog(args: readonly string[]): boolean {
  return args.length === 6 && args[0] === "--reverse" && args[1] === "--format=%H" &&
    /^[a-f0-9]{40}\^\.\.[a-f0-9]{40}$/.test(args[2] ?? "") && args[3] === "--" &&
    args[4] === PROSPECTIVE_SHADOW_REGISTRATION_PATH && args[5] === PROSPECTIVE_SHADOW_REGISTRY_PATH;
}

async function runRequired(runner: ReadOnlyGitRunner, args: readonly string[]): Promise<string> {
  const result = await runner.run(args);
  if (result.exitCode !== 0) throw gitError(args, result);
  return String(result.stdout);
}

function gitError(args: readonly string[], result: ReadonlyGitResult): Error {
  const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
  return new Error(`Read-only git ${args[0] ?? "command"} failed: ${detail}`);
}

function splitLines(value: string): string[] {
  const trimmed = value.trim();
  return trimmed === "" ? [] : trimmed.split(/\r?\n/);
}

function splitWhitespace(value: string): string[] {
  const trimmed = value.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}

function trimLine(value: string): string {
  const lines = splitLines(value);
  if (lines.length !== 1) throw new Error("Read-only Git command must return exactly one line.");
  return lines[0] ?? "";
}

function requireCommit(value: string, label: string): string {
  if (!isCommit(value)) throw new Error(`${label} must be a lowercase 40-character Git commit SHA.`);
  return value;
}

function isCommit(value: string | undefined): value is string {
  return value !== undefined && COMMIT.test(value);
}

function requireExitCode(value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error("Git executor exit code is invalid.");
  return value;
}

async function defaultExecutor(cwd: string, args: readonly string[]): Promise<ReadonlyGitResult> {
  try {
    const result = await execFileAsync("git", [...args], { cwd, encoding: "utf8", windowsHide: true });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const candidate = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      exitCode: typeof candidate.code === "number" ? candidate.code : 1,
      stdout: typeof candidate.stdout === "string" ? candidate.stdout : "",
      stderr: typeof candidate.stderr === "string" ? candidate.stderr : String(candidate.message ?? error),
    };
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
