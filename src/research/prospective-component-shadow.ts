import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  appendProspectiveShadowAbandonment,
  nodeProspectiveShadowRegistrationFileSystem,
  publishProspectiveShadowRegistration,
  type AppendProspectiveShadowAbandonmentInput,
  type PublishProspectiveShadowRegistrationInput,
} from "../modules/performance/performance-prospective-shadow-registration-writer.js";
import {
  PROSPECTIVE_SHADOW_REGISTRATION_PATH,
  validateProspectiveShadowClosureCommitment,
  validateProspectiveShadowCommitment,
  validateProspectiveShadowPersistedWorkflowMetadata,
  type ProspectiveShadowClosureMetadata,
  type ProspectiveShadowClosureManualVerification,
  type ProspectiveShadowWorkflowMetadata,
} from "../modules/performance/performance-prospective-shadow-commitment.js";
import {
  PROSPECTIVE_SHADOW_POLICY_MANIFEST,
  parseProspectiveShadowRegistry,
  serializeProspectiveShadowRegistration,
  validateProspectiveShadowRegistration,
  type ProspectiveShadowRegistration,
} from "../modules/performance/performance-prospective-shadow-registration.js";
import {
  evaluateProspectiveComponentShadow,
  type ProspectiveShadowEvaluation,
  type ProspectiveShadowFinalOutcomes,
} from "../modules/performance/performance-prospective-shadow-evaluation.js";
import {
  buildProspectiveShadowReplayEvidence,
  type BuildProspectiveShadowReplayEvidenceInput,
  type ProspectiveShadowReplayEvidence,
} from "../modules/performance/performance-prospective-shadow-replay.js";
import { parseResearchCandleDataset, type ResearchCandleDataset } from "../modules/performance/research-candle-dataset.js";
import { parseResearchNoTradeEvidence, type ResearchNoTradeEvidence } from "../modules/performance/research-no-trade-evidence.js";
import { buildPositionGuardBacktestFrames } from "../modules/strategy/position-guard-backtest-frames.js";
import { parsePerformanceTimestamp, compareEpochNanoseconds } from "../modules/performance/performance-timestamp.js";
import {
  createReadOnlyGitRunner,
  readProspectiveShadowGitEvidence,
  type ProspectiveShadowGitEvidence,
} from "./prospective-shadow-git-commitment-reader.js";

const REPORT_DIRECTORY = ["docs", "research", "prospective-shadow", "reports", "PCS-2026-001"] as const;
const REPORT_JSON_FILE = "report.json";
const REPORT_TEXT_FILE = "report.txt";
const REPORT_MARKER_FILE = ".publication-in-progress";
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const execFileAsync = promisify(execFile);

type RegisterOptions = Readonly<{
  command: "register";
  implementationCommitSha: string;
  developmentAuthoritySha256: string;
  retrospectiveReportSha256: string;
}>;
type AbandonOptions = Readonly<{
  command: "abandon";
  abandonedAt: string;
  expectedRegistrationPayloadSha256: string;
  publicationCommitSha: string;
  reason: string;
}>;
type CollectingOptions = Readonly<{ command: "inspect" | "evaluate"; asOf: string }>;
type FinalEvaluateOptions = Readonly<{
  command: "evaluate";
  asOf: string;
  btcDatasetPath: string;
  ethDatasetPath: string;
  btcSidecarPath: string;
  ethSidecarPath: string;
  initialMetadataPath: string;
  initialManualVerificationPath: string;
  closureMetadataPath: string;
  closureManualVerificationPath: string;
  implementationCheckoutSha: string;
  minimumCompletedCandles: Readonly<{ "1h": number; "4h": number; "1d": number }>;
  requiredFeatureLookbackCandles: number;
}>;

export type ProspectiveComponentShadowCliOptions = RegisterOptions | AbandonOptions | CollectingOptions | FinalEvaluateOptions;

export type ProspectiveComponentShadowReport = Readonly<{
  schemaVersion: 1;
  authority: string;
  experimentId: string;
  phase: "COLLECTING" | "FINAL";
  asOf: string;
  window: ProspectiveShadowRegistration["window"];
  calendar: Readonly<{ windowComplete: boolean }>;
  registration: Readonly<{ payloadSha256: string; implementationCommitSha: string }>;
  outcomes: ProspectiveShadowFinalOutcomes | null;
  replay: ProspectiveShadowReplayEvidence | null;
  evaluation: ProspectiveShadowEvaluation | null;
  inspection: Readonly<{ registryState: "ACTIVE" | "ABANDONED"; markerPresent: false }> | null;
  safety: Readonly<{
    readOnly: true;
    causalClaim: false;
    deploymentApproval: false;
    liveApproval: false;
    boundary: string;
  }>;
  provenance: Readonly<{
    datasetChecksums: Readonly<{ BTC: string | null; ETH: string | null }>;
    sidecarChecksums: Readonly<{ BTC: string | null; ETH: string | null }>;
    pathFingerprints: Readonly<{ BTC: string | null; ETH: string | null }>;
    commitmentAssurance: "HUMAN_VERIFIED_PUBLIC_GITHUB_RUN" | null;
    cryptographicallyVerified: false;
    evidence: Readonly<{
      datasets: Readonly<Record<"BTC" | "ETH", Readonly<{
        datasetPath: string;
        datasetProvenance: ResearchCandleDataset["provenance"];
        sidecarPath: string;
        sidecarProvenance: ResearchNoTradeEvidence["provenance"];
      }>>>;
      initialMetadata: ProspectiveShadowWorkflowMetadata;
      initialManualVerification: unknown;
      closureMetadata: ProspectiveShadowClosureMetadata;
      closureManualVerification: unknown;
    }> | null;
  }>;
}>;

export type ProspectiveComponentShadowCliResult = Readonly<{
  command: ProspectiveComponentShadowCliOptions["command"];
  report: ProspectiveComponentShadowReport | null;
  reportDirectoryPath?: string;
}>;

export interface ProspectiveComponentShadowCliDependencies {
  readonly repositoryRoot: string;
  readonly now: () => Date;
  readonly publishRegistration: (input: PublishProspectiveShadowRegistrationInput & Readonly<{ registeredAt: string }>) => Promise<unknown>;
  readonly appendAbandonment: (input: AppendProspectiveShadowAbandonmentInput & Readonly<{ abandonedAt: string }>) => Promise<unknown>;
  readonly readRegistration: () => Promise<ProspectiveShadowRegistration>;
  readonly readInspection: () => Promise<Readonly<{ registrationBytes: string; registryBytes: string; markerPresent: boolean }>>;
  readonly verifyImplementationCheckout: (implementationCommitSha: string) => Promise<void>;
  readonly readImplementationCheckoutSha: () => Promise<string>;
  readonly readEvidenceJson: (filePath: string) => Promise<unknown>;
  readonly readGitEvidence: (input: Readonly<{ mode: "REGISTERED_PUBLICATION" | "CLOSURE"; implementationCommitSha: string; publicationCommitSha: string; closureTipSha?: string }>) => Promise<ProspectiveShadowGitEvidence>;
  readonly readDataset: (filePath: string) => Promise<ResearchCandleDataset>;
  readonly readNoTradeEvidence: (filePath: string) => Promise<ResearchNoTradeEvidence>;
  readonly buildReplay: (input: BuildProspectiveShadowReplayEvidenceInput) => Promise<ProspectiveShadowReplayEvidence>;
  readonly evaluate: (input: Parameters<typeof evaluateProspectiveComponentShadow>[0]) => ProspectiveShadowEvaluation;
  readonly publishReport: (input: Readonly<{ directoryPath: string; json: string; text: string }>) => Promise<void>;
}

/** Narrow adapter for fault-injecting the report publication boundary in tests. */
export interface ProspectiveComponentShadowReportFileSystem {
  readonly realpath: (value: string) => Promise<string>;
  readonly mkdir: (value: string, options?: Readonly<{ recursive?: boolean }>) => Promise<string | undefined>;
  readonly lstat: (value: string) => Promise<Stats>;
  readonly readFile: (value: string, encoding: "utf8") => Promise<string>;
  readonly writeFile: (value: string, bytes: string, options: Readonly<{ encoding: "utf8"; flag: "wx" }>) => Promise<void>;
  readonly unlink: (value: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (value: string, options: Readonly<{ recursive: true; force: false }>) => Promise<void>;
}

export type ReadOnlyCheckoutCommandResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;
export interface ReadOnlyCheckoutCommandRunner {
  readonly run: (args: readonly string[]) => Promise<ReadOnlyCheckoutCommandResult>;
}

const nodeProspectiveComponentShadowReportFileSystem: ProspectiveComponentShadowReportFileSystem = {
  realpath,
  mkdir,
  lstat,
  readFile,
  writeFile,
  unlink,
  rename,
  rm,
};

export function parseProspectiveComponentShadowArgs(argv: readonly string[]): ProspectiveComponentShadowCliOptions {
  const command = argv[0];
  if (command !== "register" && command !== "abandon" && command !== "inspect" && command !== "evaluate") {
    throw new Error("First argument must be register, abandon, inspect, or evaluate.");
  }
  const values = parseValues(argv.slice(1));
  if (command === "register") {
    assertOnly(values, ["implementation-commit-sha", "development-authority-sha256", "retrospective-report-sha256"]);
    return {
      command,
      implementationCommitSha: requireCommit(requireValue(values, "implementation-commit-sha"), "--implementation-commit-sha"),
      developmentAuthoritySha256: requireSha256(requireValue(values, "development-authority-sha256"), "--development-authority-sha256"),
      retrospectiveReportSha256: requireSha256(requireValue(values, "retrospective-report-sha256"), "--retrospective-report-sha256"),
    };
  }
  if (command === "abandon") {
    assertOnly(values, ["abandoned-at", "expected-registration-payload-sha256", "publication-commit-sha", "reason"]);
    return {
      command,
      abandonedAt: requireTimestamp(requireValue(values, "abandoned-at"), "--abandoned-at"),
      expectedRegistrationPayloadSha256: requireSha256(requireValue(values, "expected-registration-payload-sha256"), "--expected-registration-payload-sha256"),
      publicationCommitSha: requireCommit(requireValue(values, "publication-commit-sha"), "--publication-commit-sha"),
      reason: requireNonEmpty(requireValue(values, "reason"), "--reason"),
    };
  }
  if (command === "inspect") {
    assertOnly(values, ["as-of"]);
    return { command, asOf: requireTimestamp(requireValue(values, "as-of"), "--as-of") };
  }
  const asOf = requireTimestamp(requireValue(values, "as-of"), "--as-of");
  const finalKeys = ["as-of", "btc-dataset", "eth-dataset", "btc-sidecar", "eth-sidecar", "initial-metadata", "initial-manual-verification", "closure-metadata", "closure-manual-verification", "implementation-checkout-sha", "minimum-completed-candles-1h", "minimum-completed-candles-4h", "minimum-completed-candles-1d", "required-feature-lookback-candles"];
  const collectingKeys = ["as-of"];
  const isFinal = finalKeys.some((key) => values.has(key) && key !== "as-of");
  assertOnly(values, isFinal ? finalKeys : collectingKeys);
  if (!isFinal) return { command, asOf };
  return {
    command,
    asOf,
    btcDatasetPath: requirePath(requireValue(values, "btc-dataset"), "--btc-dataset"),
    ethDatasetPath: requirePath(requireValue(values, "eth-dataset"), "--eth-dataset"),
    btcSidecarPath: requirePath(requireValue(values, "btc-sidecar"), "--btc-sidecar"),
    ethSidecarPath: requirePath(requireValue(values, "eth-sidecar"), "--eth-sidecar"),
    initialMetadataPath: requirePath(requireValue(values, "initial-metadata"), "--initial-metadata"),
    initialManualVerificationPath: requirePath(requireValue(values, "initial-manual-verification"), "--initial-manual-verification"),
    closureMetadataPath: requirePath(requireValue(values, "closure-metadata"), "--closure-metadata"),
    closureManualVerificationPath: requirePath(requireValue(values, "closure-manual-verification"), "--closure-manual-verification"),
    implementationCheckoutSha: requireCommit(requireValue(values, "implementation-checkout-sha"), "--implementation-checkout-sha"),
    minimumCompletedCandles: {
      "1h": requirePositiveInteger(requireValue(values, "minimum-completed-candles-1h"), "--minimum-completed-candles-1h"),
      "4h": requirePositiveInteger(requireValue(values, "minimum-completed-candles-4h"), "--minimum-completed-candles-4h"),
      "1d": requirePositiveInteger(requireValue(values, "minimum-completed-candles-1d"), "--minimum-completed-candles-1d"),
    },
    requiredFeatureLookbackCandles: requirePositiveInteger(requireValue(values, "required-feature-lookback-candles"), "--required-feature-lookback-candles"),
  };
}

export async function runProspectiveComponentShadowCli(
  options: ProspectiveComponentShadowCliOptions,
  dependencies: ProspectiveComponentShadowCliDependencies,
): Promise<ProspectiveComponentShadowCliResult> {
  options = structuredClone(options);
  const repositoryRoot = dependencies.repositoryRoot;
  if (options.command === "register") {
    const registrationOptions = options as RegisterOptions;
    const registeredAt = normalizedNow(dependencies.now, "Registration clock");
    const published = await dependencies.publishRegistration({
      repositoryRoot,
      implementationCommitSha: registrationOptions.implementationCommitSha,
      developmentAuthoritySha256: registrationOptions.developmentAuthoritySha256,
      retrospectiveReportSha256: registrationOptions.retrospectiveReportSha256,
      policyManifest: PROSPECTIVE_SHADOW_POLICY_MANIFEST,
      registeredAt,
    });
    const registration = extractPublishedRegistration(published);
    return { command: "register", report: collectingReport(registration, registeredAt) };
  }
  if (options.command === "abandon") {
    await dependencies.appendAbandonment({
      repositoryRoot: dependencies.repositoryRoot,
      expectedRegistrationPayloadSha256: options.expectedRegistrationPayloadSha256,
      publicationCommitSha: options.publicationCommitSha,
      reason: options.reason,
      abandonedAt: options.abandonedAt,
    });
    return { command: "abandon", report: null };
  }

  if (isFinalEvaluate(options)) return runFinalEvaluate(options, dependencies, repositoryRoot);

  const inspection = structuredClone(await dependencies.readInspection());
  if (inspection.markerPresent) throw new Error("Prospective registration inspection rejected an in-progress publication marker.");
  let inspectedRegistrationJson: unknown;
  try { inspectedRegistrationJson = JSON.parse(inspection.registrationBytes); } catch { throw new Error("Prospective registration inspection bytes must be valid JSON."); }
  const inspectedRegistration = validateProspectiveShadowRegistration(inspectedRegistrationJson);
  if (serializeProspectiveShadowRegistration(inspectedRegistration) !== inspection.registrationBytes) {
    throw new Error("Prospective registration inspection bytes are not canonical.");
  }
  const inspectedRegistry = parseProspectiveShadowRegistry(inspection.registryBytes);
  if (inspectedRegistry.registrationPayloadSha256 !== inspectedRegistration.payloadSha256) throw new Error("Prospective registration and registry inspection payload hashes do not match.");
  const registeredEvent = inspectedRegistry.events[0];
  if (registeredEvent?.event !== "REGISTERED" || registeredEvent.eventAt !== inspectedRegistration.registeredAt) {
    throw new Error("Prospective registration registry REGISTERED eventAt must equal registration.registeredAt.");
  }
  const abandonment = inspectedRegistry.events[1];
  if (abandonment !== undefined) {
    if (abandonment.event !== "ABANDONED" || abandonment.registrationPayloadSha256 !== inspectedRegistration.payloadSha256) {
      throw new Error("Prospective registration registry abandonment identity does not match registration authority.");
    }
    const abandonedAt = parsePerformanceTimestamp(abandonment.eventAt);
    const close = parsePerformanceTimestamp(inspectedRegistration.window.to);
    if (abandonedAt === null || close === null || compareEpochNanoseconds(abandonedAt.epochNanoseconds, close.epochNanoseconds) >= 0) {
      throw new Error("Prospective registration registry ABANDONED eventAt must be before the prospective window close.");
    }
  }
  const inspectedState = inspectedRegistry.abandoned ? "ABANDONED" as const : "ACTIVE" as const;
  if (options.command === "inspect") return { command: "inspect", report: collectingReport(inspectedRegistration, options.asOf, inspectedState) };
  if (!windowComplete(options.asOf, inspectedRegistration.window.to)) {
    return { command: options.command, report: collectingReport(inspectedRegistration, options.asOf, inspectedState) };
  }
  throw new Error("Post-window evaluate requires the complete final evidence matrix.");
}

async function runFinalEvaluate(
  options: FinalEvaluateOptions,
  dependencies: ProspectiveComponentShadowCliDependencies,
  repositoryRoot: string,
): Promise<ProspectiveComponentShadowCliResult> {
  const initialMetadata = structuredClone(await dependencies.readEvidenceJson(options.initialMetadataPath)) as ProspectiveShadowWorkflowMetadata;
  const initialManualVerification = structuredClone(await dependencies.readEvidenceJson(options.initialManualVerificationPath));
  const validatedInitialMetadata = validateProspectiveShadowPersistedWorkflowMetadata(initialMetadata, "REGISTERED_PUBLICATION");
  const initialGitEvidence = structuredClone(await dependencies.readGitEvidence({
    mode: "REGISTERED_PUBLICATION",
    implementationCommitSha: validatedInitialMetadata.implementationCommitSha,
    publicationCommitSha: validatedInitialMetadata.publicationCommitSha,
  }));
  if (initialGitEvidence.mode !== "REGISTERED_PUBLICATION") throw new Error("Initial commitment reader returned the wrong evidence mode.");
  let committedRegistrationJson: unknown;
  try { committedRegistrationJson = JSON.parse(initialGitEvidence.registrationBytes); } catch { throw new Error("Publication Git evidence registration bytes must be valid JSON."); }
  const registration = validateProspectiveShadowRegistration(structuredClone(committedRegistrationJson));
  const initialCommitmentInput = {
    registration,
    metadata: validatedInitialMetadata,
    manualVerification: initialManualVerification as never,
    gitEvidence: initialGitEvidence as never,
  };
  validateProspectiveShadowCommitment(initialCommitmentInput);
  if (!windowComplete(options.asOf, registration.window.to)) {
    return { command: "evaluate", report: collectingReport(registration, options.asOf) };
  }
  const closureMetadata = structuredClone(await dependencies.readEvidenceJson(options.closureMetadataPath)) as ProspectiveShadowClosureMetadata;
  const closureManualVerification = structuredClone(await dependencies.readEvidenceJson(options.closureManualVerificationPath)) as ProspectiveShadowClosureManualVerification;
  const closureTipSha = requireCommit(closureMetadata.closureTipSha, "closure metadata closureTipSha");
  if (options.implementationCheckoutSha !== registration.implementationCommitSha) {
    throw new Error("--implementation-checkout-sha must equal the publication registration implementation commit.");
  }
  await dependencies.verifyImplementationCheckout(registration.implementationCommitSha);
  const checkedOut = requireCommit(await dependencies.readImplementationCheckoutSha(), "implementation checkout");
  if (checkedOut !== registration.implementationCommitSha) throw new Error("Exact implementation checkout is required for final prospective evaluation.");
  const closureGitEvidence = structuredClone(await dependencies.readGitEvidence({
    mode: "CLOSURE",
    implementationCommitSha: registration.implementationCommitSha,
    publicationCommitSha: validatedInitialMetadata.publicationCommitSha,
    closureTipSha,
  }));
  const btcDataset = structuredClone(await dependencies.readDataset(options.btcDatasetPath));
  const btcSidecar = structuredClone(await dependencies.readNoTradeEvidence(options.btcSidecarPath));
  const ethDataset = structuredClone(await dependencies.readDataset(options.ethDatasetPath));
  const ethSidecar = structuredClone(await dependencies.readNoTradeEvidence(options.ethSidecarPath));
  const closureCommitmentInput = {
    registration,
    initialCommitmentInput,
    metadata: closureMetadata,
    manualVerification: closureManualVerification,
    gitEvidence: closureGitEvidence as never,
  };
  // Reject commitment/closure authority before parsing or replaying market evidence.
  validateProspectiveShadowClosureCommitment(closureCommitmentInput);
  const replay = structuredClone(await dependencies.buildReplay({
    registration,
    datasets: [
      { asset: "BTC", dataset: btcDataset, noTradeEvidence: btcSidecar },
      { asset: "ETH", dataset: ethDataset, noTradeEvidence: ethSidecar },
    ],
    frameBuilder: (input) => buildPositionGuardBacktestFrames({
      asset: input.asset,
      market: input.market,
      oneHourCandles: input.dataset.candles["1h"],
      fourHourCandles: input.dataset.candles["4h"],
      oneDayCandles: input.dataset.candles["1d"],
      startAt: input.featureWarmupStartAt,
      endAt: input.decisionTo,
      minimumCompletedCandles: input.minimumCompletedCandles,
    }),
    minimumCompletedCandles: options.minimumCompletedCandles,
    requiredFeatureLookbackCandles: options.requiredFeatureLookbackCandles,
  }));
  const evaluation = dependencies.evaluate({
    registration,
    initialCommitmentInput,
    closureCommitmentInput,
    asOf: options.asOf,
    pathEvidence: replay.pathEvidence,
  });
  const report = finalReport({
    evaluation,
    btcDataset,
    btcSidecar,
    ethDataset,
    ethSidecar,
    replay,
    options,
    initialMetadata: validatedInitialMetadata,
    initialManualVerification,
    closureMetadata,
    closureManualVerification,
  });
  const json = formatProspectiveComponentShadowReport(report, "json");
  const text = formatProspectiveComponentShadowReport(report, "text");
  const directoryPath = path.join(repositoryRoot, ...REPORT_DIRECTORY);
  await dependencies.publishReport({ directoryPath, json, text });
  return { command: "evaluate", report, reportDirectoryPath: directoryPath };
}

export function formatProspectiveComponentShadowReport(report: ProspectiveComponentShadowReport, output: "json" | "text"): string {
  if (output === "json") return `${stableJson(report)}\n`;
  const lines = [
    "PROSPECTIVE COMPONENT SHADOW REPORT - RESEARCH ONLY; NOT DEPLOYMENT APPROVAL OR LIVE APPROVAL.",
    `phase: ${report.phase}`,
    `experiment: ${report.experimentId}`,
    `authority: ${report.authority}`,
    `observed_as_of: ${report.asOf}`,
    `window: [${report.window.from}, ${report.window.to})`,
    `registration_payload_sha256: ${report.registration.payloadSha256}`,
    `read_only: ${report.safety.readOnly}`,
    `causal_claim: ${report.safety.causalClaim}`,
    `deployment_approval: ${report.safety.deploymentApproval}`,
    `live_approval: ${report.safety.liveApproval}`,
    `commitment_assurance: ${report.provenance.commitmentAssurance ?? "not evaluated"}`,
    "Human verification is auditable provenance, not cryptographic verification.",
  ];
  if (report.outcomes === null) {
    lines.push("outcomes: withheld while COLLECTING; replay and outcome metrics were not run.");
  } else {
    for (const asset of report.outcomes.assets) {
      lines.push(`${asset.asset} (${asset.market})`);
      for (const candidate of asset.candidates) {
        lines.push(`  ${candidate.scenario}: ${candidate.status}`);
        lines.push(`  reason_codes: ${candidate.reasonCodes.join(",") || "none"}`);
        lines.push(`  incomplete_gates: ${candidate.incompleteGates.join(",") || "none"}`);
        for (const reason of candidate.reasonDetails) lines.push(`  reason_detail: ${reason.code} | ${reason.detail}`);
        for (const cell of candidate.cells) lines.push(`  cell: timing=${cell.timing}; cost=${cell.costId}; support=${cell.supportSufficient}; harm=${cell.knownHarmReasonCodes.join(",") || "none"}`);
      }
    }
  }
  if (report.replay !== null) {
    lines.push(`replay_paths: ${report.replay.paths.length}`);
    for (const asset of ["BTC", "ETH"] as const) {
      const paths = report.replay.paths.filter((entry) => entry.asset === asset);
      const episodes = paths.reduce((count, entry) => count + entry.counterfactual.matchResult.episodes.length, 0);
      const fifoSlices = paths.reduce((count, entry) => count + entry.counterfactual.matchResult.realizationSlices.length, 0);
      const unknownReasons = [...new Set(paths.flatMap((entry) => [
        entry.feeEvidence.unknownReason,
        entry.lifecycleEvidence.unknownReason,
        entry.relationshipEvidence.unknownReason,
        ...Object.values(entry.pathEvidence.metrics).map((metric) => metric.unknownReason),
      ]).filter((reason): reason is string => reason !== null))];
      lines.push(`replay_${asset}: paths=${paths.length}; episodes=${episodes}; fifo_realization_slices=${fifoSlices}; unknown_reasons=${unknownReasons.join(" | ") || "none"}`);
    }
  }
  lines.push("TECHNICAL EVIDENCE - deterministic replay, commitment, and evaluator detail; research only.");
  appendCommitmentTechnicalDetail(lines, report);
  appendEvaluatorTechnicalDetail(lines, report);
  appendReplayTechnicalDetail(lines, report);
  lines.push(`dataset_checksums: BTC=${report.provenance.datasetChecksums.BTC ?? "not evaluated"}; ETH=${report.provenance.datasetChecksums.ETH ?? "not evaluated"}`);
  lines.push(`sidecar_checksums: BTC=${report.provenance.sidecarChecksums.BTC ?? "not evaluated"}; ETH=${report.provenance.sidecarChecksums.ETH ?? "not evaluated"}`);
  lines.push(`path_fingerprints: BTC=${report.provenance.pathFingerprints.BTC ?? "not evaluated"}; ETH=${report.provenance.pathFingerprints.ETH ?? "not evaluated"}`);
  return lines.join("\n");
}

function appendCommitmentTechnicalDetail(lines: string[], report: ProspectiveComponentShadowReport): void {
  const evidence = report.provenance.evidence;
  if (evidence === null) {
    lines.push("commitment_evidence: not evaluated");
    return;
  }
  const initialManual = evidence.initialManualVerification as Record<string, unknown>;
  const closureManual = evidence.closureManualVerification as Record<string, unknown>;
  lines.push(`initial_commitment run_id=${evidence.initialMetadata.runId}; run_url=${evidence.initialMetadata.runUrl}; server_created_at=${evidence.initialMetadata.serverCreatedAt}; implementation_commit=${evidence.initialMetadata.implementationCommitSha}; publication_commit=${evidence.initialMetadata.publicationCommitSha}; manual_confirmation=${technicalValue(initialManual, "confirmation")}; manual_verified_at=${technicalValue(initialManual, "verifiedAt")}`);
  lines.push(`closure_commitment run_id=${evidence.closureMetadata.runId}; run_url=${evidence.closureMetadata.runUrl}; server_created_at=${evidence.closureMetadata.serverCreatedAt}; closure_tip=${evidence.closureMetadata.closureTipSha}; registry_sha256=${evidence.closureMetadata.registrySha256}; manual_confirmation=${technicalValue(closureManual, "confirmation")}; manual_verified_at=${technicalValue(closureManual, "verifiedAt")}`);
}

function appendEvaluatorTechnicalDetail(lines: string[], report: ProspectiveComponentShadowReport): void {
  if (report.evaluation?.outcomes === null || report.evaluation === null) return;
  for (const asset of report.evaluation.outcomes.assets) {
    for (const candidate of asset.candidates) {
      lines.push(`evaluator_candidate asset=${asset.asset}; market=${asset.market}; scenario=${candidate.scenario}; status=${candidate.status}; reason_codes=${candidate.reasonCodes.join(",") || "none"}; incomplete_gates=${candidate.incompleteGates.join(",") || "none"}`);
      for (const reason of candidate.reasonDetails) lines.push(`evaluator_reason asset=${asset.asset}; scenario=${candidate.scenario}; code=${reason.code}; detail=${reason.detail}`);
      for (const cell of candidate.cells) {
        lines.push(`evaluator_cell asset=${asset.asset}; scenario=${candidate.scenario}; timing=${cell.timing}; cost=${cell.costId}; delta_net_return_unit=${cell.deltas.netReturn.unit}; delta_net_return_value=${cell.deltas.netReturn.value}; delta_net_return_complete=${cell.deltas.netReturn.complete}; delta_net_return_unknown_reason=${cell.deltas.netReturn.unknownReason ?? "none"}; delta_drawdown_unit=${cell.deltas.maximumRealizedDrawdown.unit}; delta_drawdown_value=${cell.deltas.maximumRealizedDrawdown.value}; delta_turnover_unit=${cell.deltas.turnover.unit}; delta_turnover_value=${cell.deltas.turnover.value}; delta_fees_unit=${cell.deltas.modeledFees.unit}; delta_fees_value=${cell.deltas.modeledFees.value}; support=${cell.supportSufficient}; incomplete_gates=${cell.incompleteGates.join(",") || "none"}; known_harm=${cell.knownHarmReasonCodes.join(",") || "none"}`);
      }
    }
  }
}

function appendReplayTechnicalDetail(lines: string[], report: ProspectiveComponentShadowReport): void {
  if (report.replay === null) return;
  for (const pathEvidence of report.replay.paths) {
    const pathId = replayPathId(pathEvidence);
    const relationshipProvenance = pathEvidence.relationships?.provenance;
    lines.push(`path path_id=${pathId}; feature_frame_count=${pathEvidence.featureFrameCount}; replay_frame_count=${pathEvidence.replayFrameCount}; cadence_complete=${pathEvidence.cadence.complete}; fee_complete=${pathEvidence.feeEvidence.complete}; lifecycle_complete=${pathEvidence.lifecycleEvidence.complete}; relationship_complete=${pathEvidence.relationshipEvidence.complete}; dataset_sha256=${relationshipProvenance?.datasetSha256 ?? "none"}; replay_frame_fingerprint=${relationshipProvenance?.replayFrameFingerprint ?? "none"}`);
    for (const [name, metric] of Object.entries(pathEvidence.pathEvidence.metrics)) {
      lines.push(`metric path_id=${pathId}; name=${name}; unit=${metric.unit}; value=${metric.value}; complete=${metric.complete}; unknown_reason=${metric.unknownReason ?? "none"}`);
    }
    for (const fill of pathEvidence.counterfactual.fills) {
      lines.push(`fill path_id=${pathId}; id=${fill.id}; order_id=${fill.orderId}; decision_id=${fill.strategyDecisionId ?? "none"}; action=${fill.decisionAction ?? "none"}; side=${fill.side}; price_krw=${fill.priceKrw}; volume=${fill.volume}; fee_krw=${fill.feeKrw ?? "none"}; filled_at=${fill.filledAt}`);
    }
    for (const episode of pathEvidence.counterfactual.matchResult.episodes) {
      lines.push(`episode path_id=${pathId}; id=${episode.id}; status=${episode.status}; entry_fill_ids=${episode.entryFillIds.join(",")}; exit_fill_ids=${episode.exitFillIds.join(",")}; fifo_slice_ids=${episode.realizationSliceIds.join(",")}; net_realized_pnl_krw=${episode.netRealizedPnlKrw ?? "none"}`);
    }
    for (const slice of pathEvidence.counterfactual.matchResult.realizationSlices) {
      lines.push(`fifo path_id=${pathId}; id=${slice.id}; episode_id=${slice.episodeId ?? "none"}; entry_fill_id=${slice.entry.fillId ?? "none"}; exit_fill_id=${slice.exit.fillId ?? "none"}; quantity=${slice.quantity}; net_realized_pnl_krw=${slice.netRealizedPnlKrw ?? "none"}`);
    }
    for (const relationship of pathEvidence.relationships?.relationships ?? []) {
      lines.push(`relationship path_id=${pathId}; kind=${relationship.relationshipKind}; entry_key_epoch_nanoseconds=${relationship.entryKeyEpochNanoseconds ?? "none"}; reference_episode_id=${relationship.reference?.episodeId ?? "none"}; ablation_episode_id=${relationship.ablation?.episodeId ?? "none"}; net_pnl_delta_krw=${relationship.netPnlDeltaKrw ?? "none"}`);
    }
  }
}

function replayPathId(pathEvidence: ProspectiveShadowReplayEvidence["paths"][number]): string {
  return `${pathEvidence.asset}|${pathEvidence.market}|${pathEvidence.scenario}|${pathEvidence.timing}|${pathEvidence.costId}`;
}

function technicalValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "none";
}

function collectingReport(registration: ProspectiveShadowRegistration, asOf: string, registryState: "ACTIVE" | "ABANDONED" = "ACTIVE"): ProspectiveComponentShadowReport {
  return {
    schemaVersion: 1,
    authority: registration.authority,
    experimentId: registration.experimentId,
    phase: "COLLECTING",
    asOf,
    window: structuredClone(registration.window),
    calendar: { windowComplete: windowComplete(asOf, registration.window.to) },
    registration: { payloadSha256: registration.payloadSha256, implementationCommitSha: registration.implementationCommitSha },
    outcomes: null,
    replay: null,
    evaluation: null,
    inspection: { registryState, markerPresent: false },
    safety: safetyBoundary(registration.safety.boundary),
    provenance: {
      datasetChecksums: { BTC: null, ETH: null }, sidecarChecksums: { BTC: null, ETH: null }, pathFingerprints: { BTC: null, ETH: null },
      commitmentAssurance: null, cryptographicallyVerified: false, evidence: null,
    },
  };
}

function finalReport(input: Readonly<{
  evaluation: ProspectiveShadowEvaluation;
  btcDataset: ResearchCandleDataset;
  btcSidecar: ResearchNoTradeEvidence;
  ethDataset: ResearchCandleDataset;
  ethSidecar: ResearchNoTradeEvidence;
  replay: ProspectiveShadowReplayEvidence;
  options: FinalEvaluateOptions;
  initialMetadata: ProspectiveShadowWorkflowMetadata;
  initialManualVerification: unknown;
  closureMetadata: ProspectiveShadowClosureMetadata;
  closureManualVerification: unknown;
}>): ProspectiveComponentShadowReport {
  const { evaluation, btcDataset, btcSidecar, ethDataset, ethSidecar, replay, options } = input;
  return {
    schemaVersion: 1,
    authority: evaluation.authority,
    experimentId: evaluation.experimentId,
    phase: evaluation.phase,
    asOf: evaluation.asOf,
    window: structuredClone(evaluation.window),
    calendar: structuredClone(evaluation.calendar),
    registration: structuredClone(evaluation.registration),
    outcomes: evaluation.outcomes === null ? null : structuredClone(evaluation.outcomes),
    replay: structuredClone(replay),
    evaluation: structuredClone(evaluation),
    inspection: null,
    safety: safetyBoundary(evaluation.safety.boundary),
    provenance: {
      datasetChecksums: { BTC: btcDataset.provenance.sha256, ETH: ethDataset.provenance.sha256 },
      sidecarChecksums: { BTC: btcSidecar.provenance.sha256, ETH: ethSidecar.provenance.sha256 },
      pathFingerprints: { BTC: sha256(stableJson(replay.paths.filter((entry) => entry.asset === "BTC"))), ETH: sha256(stableJson(replay.paths.filter((entry) => entry.asset === "ETH"))) },
      commitmentAssurance: evaluation.commitment.assurance,
      cryptographicallyVerified: false,
      evidence: {
        datasets: {
          BTC: { datasetPath: options.btcDatasetPath, datasetProvenance: structuredClone(btcDataset.provenance), sidecarPath: options.btcSidecarPath, sidecarProvenance: structuredClone(btcSidecar.provenance) },
          ETH: { datasetPath: options.ethDatasetPath, datasetProvenance: structuredClone(ethDataset.provenance), sidecarPath: options.ethSidecarPath, sidecarProvenance: structuredClone(ethSidecar.provenance) },
        },
        initialMetadata: structuredClone(input.initialMetadata),
        initialManualVerification: structuredClone(input.initialManualVerification),
        closureMetadata: structuredClone(input.closureMetadata),
        closureManualVerification: structuredClone(input.closureManualVerification),
      },
    },
  };
}

function safetyBoundary(boundary: string): ProspectiveComponentShadowReport["safety"] {
  return { readOnly: true, causalClaim: false, deploymentApproval: false, liveApproval: false, boundary };
}

function isFinalEvaluate(options: ProspectiveComponentShadowCliOptions): options is FinalEvaluateOptions {
  return options.command === "evaluate" && "btcDatasetPath" in options;
}

function windowComplete(asOf: string, to: string): boolean {
  const observed = parsePerformanceTimestamp(asOf);
  const end = parsePerformanceTimestamp(to);
  if (observed === null || end === null) throw new Error("Prospective evaluation timestamps must be explicit ISO-8601 timestamps.");
  return compareEpochNanoseconds(observed.epochNanoseconds, end.epochNanoseconds) >= 0;
}

function extractPublishedRegistration(value: unknown): ProspectiveShadowRegistration {
  if (value === null || typeof value !== "object" || !("registration" in value)) throw new Error("Prospective registration writer returned no registration.");
  return validateProspectiveShadowRegistration((value as { registration: unknown }).registration);
}

function parseValues(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) throw new Error(`Unexpected argument ${token ?? "<missing>"}.`);
    const key = token.slice(2);
    if (values.has(key)) throw new Error(`Duplicate argument --${key}.`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    values.set(key, value);
    index += 1;
  }
  return values;
}

function assertOnly(values: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  for (const key of values.keys()) if (!allowed.includes(key)) throw new Error(`Unknown argument --${key}.`);
}
function requireValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`Missing required argument --${key}.`);
  return value;
}
function requireTimestamp(value: string, label: string): string {
  const parsed = parsePerformanceTimestamp(value);
  if (parsed === null) throw new Error(`${label} must be an explicit-timezone ISO-8601 timestamp.`);
  return parsed.normalized;
}
function normalizedNow(clock: () => Date, label: string): string {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(`${label} is invalid.`);
  return value.toISOString();
}
function requireCommit(value: string, label: string): string {
  if (!COMMIT.test(value)) throw new Error(`${label} must be a lowercase 40-character Git commit SHA.`);
  return value;
}
function requireSha256(value: string, label: string): string {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  return value;
}
function requireNonEmpty(value: string, label: string): string {
  if (value.trim() === "") throw new Error(`${label} must be non-empty.`);
  return value;
}
function requirePath(value: string, label: string): string { return requireNonEmpty(value, label); }
function requirePositiveInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${label} must be a positive safe integer.`);
  return Number(value);
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function stableJson(value: unknown): string { return JSON.stringify(sortJson(value), null, 2); }
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortJson((value as Record<string, unknown>)[key])]));
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Prospective report cannot contain non-finite numbers.");
  return value;
}

function createDefaultDependencies(repositoryRoot: string): ProspectiveComponentShadowCliDependencies {
  const gitRunner = createReadOnlyGitRunner(repositoryRoot);
  return {
    repositoryRoot,
    now: () => new Date(),
    publishRegistration: async ({ registeredAt, ...input }) => publishProspectiveShadowRegistration(input, { now: () => registeredAt, randomSuffix: randomUUID, fs: nodeProspectiveShadowRegistrationFileSystem }),
    appendAbandonment: async ({ abandonedAt, ...input }) => appendProspectiveShadowAbandonment(input, { now: () => abandonedAt, randomSuffix: randomUUID, fs: nodeProspectiveShadowRegistrationFileSystem }),
    readRegistration: async () => validateProspectiveShadowRegistration(JSON.parse(await readFile(path.join(repositoryRoot, PROSPECTIVE_SHADOW_REGISTRATION_PATH), "utf8"))),
    readInspection: async () => readProspectiveComponentShadowInspection(repositoryRoot),
    verifyImplementationCheckout: async (implementationCommitSha) => verifyCleanImplementationCheckout(repositoryRoot, implementationCommitSha),
    readImplementationCheckoutSha: async () => (await gitRunner.run(["rev-parse", "HEAD"])).stdout.trim(),
    readEvidenceJson: async (filePath) => JSON.parse(await readFile(filePath, "utf8")),
    readGitEvidence: async (input) => {
      if (input.mode === "REGISTERED_PUBLICATION") {
        return readProspectiveShadowGitEvidence({
          mode: "REGISTERED_PUBLICATION",
          implementationCommitSha: input.implementationCommitSha,
          publicationCommitSha: input.publicationCommitSha,
        }, gitRunner);
      }
      return readProspectiveShadowGitEvidence({
        mode: "CLOSURE",
        implementationCommitSha: input.implementationCommitSha,
        publicationCommitSha: input.publicationCommitSha,
        closureTipSha: input.closureTipSha ?? "",
      }, gitRunner);
    },
    readDataset: async (filePath) => parseResearchCandleDataset(await readFile(filePath, "utf8")),
    readNoTradeEvidence: async (filePath) => parseResearchNoTradeEvidence(await readFile(filePath, "utf8")),
    buildReplay: async (input) => buildProspectiveShadowReplayEvidence(input),
    evaluate: evaluateProspectiveComponentShadow,
    publishReport: publishExclusiveReport,
  };
}

export async function verifyCleanImplementationCheckout(
  repositoryRoot: string,
  implementationCommitSha: string,
  runner: ReadOnlyCheckoutCommandRunner = nodeReadOnlyCheckoutCommandRunner(repositoryRoot),
): Promise<void> {
  const expected = requireCommit(implementationCommitSha, "implementation checkout");
  const headResult = await runner.run(["rev-parse", "HEAD"]);
  if (headResult.exitCode !== 0) throw new Error(`Read-only implementation checkout verification failed: ${headResult.stderr}`);
  const head = headResult.stdout.trim();
  if (head !== expected) throw new Error("Exact implementation checkout is required for final prospective evaluation.");
  if ((await runner.run(["diff", "--quiet", "--exit-code"])).exitCode !== 0) {
    throw new Error("Implementation checkout contains tracked authority-bearing source/config changes.");
  }
  if ((await runner.run(["diff", "--cached", "--quiet", "--exit-code"])).exitCode !== 0) {
    throw new Error("Implementation checkout contains staged authority-bearing source/config changes.");
  }
  const statusResult = await runner.run(["status", "--porcelain", "--untracked-files=all", "--", "src", "package.json", "package-lock.json", "tsconfig.json"]);
  if (statusResult.exitCode !== 0) throw new Error(`Read-only implementation checkout verification failed: ${statusResult.stderr}`);
  const status = statusResult.stdout;
  if (status.trim() !== "") throw new Error("Implementation checkout contains tracked or untracked authority-bearing source/config changes.");
}

function nodeReadOnlyCheckoutCommandRunner(repositoryRoot: string): ReadOnlyCheckoutCommandRunner {
  return {
    run: async (args) => {
      try {
        const command = validateReadOnlyCheckoutGitCommand(args);
        const result = await execFileAsync("git", command, { cwd: repositoryRoot, windowsHide: true });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error: unknown) {
        const record = error as Partial<{ code: number; stdout: string; stderr: string; message: string }>;
        return { exitCode: typeof record.code === "number" ? record.code : 1, stdout: record.stdout ?? "", stderr: record.stderr ?? record.message ?? String(error) };
      }
    },
  };
}

export function validateReadOnlyCheckoutGitCommand(args: readonly string[]): string[] {
  const allowed = [
    ["rev-parse", "HEAD"],
    ["diff", "--quiet", "--exit-code"],
    ["diff", "--cached", "--quiet", "--exit-code"],
    ["status", "--porcelain", "--untracked-files=all", "--", "src", "package.json", "package-lock.json", "tsconfig.json"],
  ] as const;
  const match = allowed.find((candidate) =>
    candidate.length === args.length && candidate.every((value, index) => value === args[index])
  );
  if (!match) throw new Error("Unsupported read-only checkout Git command.");
  return [...match];
}

async function publishExclusiveReport(input: Readonly<{ directoryPath: string; json: string; text: string }>): Promise<void> {
  await publishProspectiveComponentShadowReport({
    repositoryRoot: process.cwd(),
    directoryPath: input.directoryPath,
    json: input.json,
    text: input.text,
    randomSuffix: randomUUID,
  });
}

export async function publishProspectiveComponentShadowReport(input: Readonly<{
  repositoryRoot: string;
  directoryPath: string;
  json: string;
  text: string;
  randomSuffix: () => string;
  fs?: ProspectiveComponentShadowReportFileSystem;
}>): Promise<void> {
  const fs = input.fs ?? nodeProspectiveComponentShadowReportFileSystem;
  const root = await fs.realpath(input.repositoryRoot);
  const finalDirectory = path.resolve(input.directoryPath);
  if (!isWithin(root, finalDirectory)) throw new Error("Prospective report path escapes the repository root.");
  const parent = path.dirname(finalDirectory);
  const realParent = await ensureContainedDirectory(root, parent, fs);
  if (await pathExists(finalDirectory, fs)) throw new Error(`Prospective report directory already exists: ${finalDirectory}.`);
  const suffix = input.randomSuffix();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(suffix)) throw new Error("Prospective report staging suffix is unsafe.");
  const stagingDirectory = path.join(realParent, `.PCS-2026-001-report-${suffix}.tmp`);
  await fs.mkdir(stagingDirectory);
  const markerPath = path.join(stagingDirectory, REPORT_MARKER_FILE);
  const markerBytes = `PCS-2026-001 report publication owner=${suffix}\n`;
  let renamedDirectory: string | null = null;
  try {
    await fs.writeFile(markerPath, markerBytes, { encoding: "utf8", flag: "wx" });
    const jsonPath = path.join(stagingDirectory, REPORT_JSON_FILE);
    const textPath = path.join(stagingDirectory, REPORT_TEXT_FILE);
    await fs.writeFile(jsonPath, input.json, { encoding: "utf8", flag: "wx" });
    await fs.writeFile(textPath, input.text, { encoding: "utf8", flag: "wx" });
    if (await fs.readFile(jsonPath, "utf8") !== input.json || await fs.readFile(textPath, "utf8") !== input.text) {
      throw new Error("Prospective report staging read-back mismatch.");
    }
    // Recheck immediately before the atomic directory rename; the platform rename rejects a racing final directory.
    if (await pathExists(finalDirectory, fs)) throw new Error(`Prospective report directory already exists: ${finalDirectory}.`);
    await fs.rename(stagingDirectory, finalDirectory);
    renamedDirectory = finalDirectory;
    const finalMarkerPath = path.join(finalDirectory, REPORT_MARKER_FILE);
    if (await fs.readFile(finalMarkerPath, "utf8") !== markerBytes) throw new Error("Prospective report final owner marker mismatch.");
    await fs.unlink(finalMarkerPath);
  } catch (error) {
    const ownedDirectory = renamedDirectory ?? stagingDirectory;
    await cleanupOwnedStagingDirectory(fs, ownedDirectory, path.join(ownedDirectory, REPORT_MARKER_FILE), markerBytes);
    throw error;
  }
}

export async function readProspectiveComponentShadowInspection(
  repositoryRoot: string,
  fs: Pick<ProspectiveComponentShadowReportFileSystem, "realpath" | "lstat" | "readFile"> = nodeProspectiveComponentShadowReportFileSystem,
): Promise<Readonly<{ registrationBytes: string; registryBytes: string; markerPresent: boolean }>> {
  const root = await fs.realpath(repositoryRoot);
  const directory = path.join(root, "docs", "research", "prospective-shadow");
  const registrationPath = path.join(root, PROSPECTIVE_SHADOW_REGISTRATION_PATH);
  const registryPath = path.join(directory, "registry.jsonl");
  await assertContainedExistingPath(root, registrationPath, fs);
  await assertContainedExistingPath(root, registryPath, fs);
  const markerPath = path.join(directory, REPORT_MARKER_FILE);
  await assertContainedExistingParent(root, markerPath, fs);
  const markerPresent = await containedPathExists(root, markerPath, fs);
  return {
    registrationBytes: await fs.readFile(registrationPath, "utf8"),
    registryBytes: await fs.readFile(registryPath, "utf8"),
    markerPresent,
  };
}

async function ensureContainedDirectory(
  root: string,
  directory: string,
  fs: Pick<ProspectiveComponentShadowReportFileSystem, "realpath" | "lstat" | "mkdir">,
): Promise<string> {
  const relative = path.relative(root, directory);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Prospective report parent escapes the repository root.");
  await assertContainedExistingPath(root, root, fs);
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      await assertContainedExistingPath(root, current, fs);
    } catch (error: unknown) {
      if (!isNotFound(error)) throw error;
      await fs.mkdir(current);
      await assertContainedExistingPath(root, current, fs);
    }
  }
  return current;
}

async function assertContainedExistingParent(
  root: string,
  target: string,
  fs: Pick<ProspectiveComponentShadowReportFileSystem, "realpath" | "lstat">,
): Promise<void> {
  await assertContainedExistingPath(root, path.dirname(target), fs);
}

async function assertContainedExistingPath(
  root: string,
  target: string,
  fs: Pick<ProspectiveComponentShadowReportFileSystem, "realpath" | "lstat">,
): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) throw new Error(`Prospective research path contains a symlink: ${target}.`);
  const resolved = await fs.realpath(target);
  if (!isWithin(root, resolved) || !samePath(target, resolved)) throw new Error(`Prospective research path escapes the repository root: ${target}.`);
}

async function containedPathExists(
  root: string,
  target: string,
  fs: Pick<ProspectiveComponentShadowReportFileSystem, "realpath" | "lstat">,
): Promise<boolean> {
  try { await assertContainedExistingPath(root, target, fs); return true; }
  catch (error: unknown) { if (isNotFound(error)) return false; throw error; }
}

async function cleanupOwnedStagingDirectory(
  fs: ProspectiveComponentShadowReportFileSystem,
  stagingDirectory: string,
  markerPath: string,
  markerBytes: string,
): Promise<void> {
  try {
    const stagingStat = await fs.lstat(stagingDirectory);
    if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) return;
    if (await fs.readFile(markerPath, "utf8") !== markerBytes) return;
    await fs.rm(stagingDirectory, { recursive: true, force: false });
  } catch { /* Preserve an unowned or uncertain path rather than overwriting it. */ }
}

async function pathExists(value: string, fs: Pick<ProspectiveComponentShadowReportFileSystem, "lstat"> = nodeProspectiveComponentShadowReportFileSystem): Promise<boolean> {
  try { await fs.lstat(value); return true; } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  const normalized = (value: string) => path.resolve(value).replaceAll("\\", "/").toLowerCase();
  return normalized(left) === normalized(right);
}

async function main(): Promise<void> {
  const options = parseProspectiveComponentShadowArgs(process.argv.slice(2));
  const result = await runProspectiveComponentShadowCli(options, createDefaultDependencies(process.cwd()));
  console.log(result.report === null
    ? "Prospective component shadow abandonment was appended through the locked registry writer. No evaluation or replay was run."
    : formatProspectiveComponentShadowReport(result.report, "text"));
}

function isMainModule(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPath)).href;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    console.error(`Prospective component shadow research failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
