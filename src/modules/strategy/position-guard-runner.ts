import {
  type OrderRecord,
  type OrderSide,
  type OrderType,
  type StrategyDecision,
  type StrategyDecisionRecord,
  type SupportedMarket,
} from "../../domain/types.js";
import type {
  PositionGuardPilotDeploymentRecord,
  PositionGuardPilotPhase,
  PositionGuardPilotRefreshReceipt,
  PositionGuardPolicySelection,
} from "../../domain/pilot-types.js";
import { createId } from "../../shared/ids.js";
import type { ExecutionRepository } from "../db/interfaces.js";
import {
  parseCandidatePilotTimestamp,
  toPositionGuardCandidateRoutingState,
  validateCandidatePilotDeployment,
  type CandidatePilotRecoveryFaultReason,
} from "../db/pilot-interfaces.js";
import {
  canonicalNonNegativeDecimal,
  canonicalSignedDecimal,
  type ExactCandidateState,
} from "../execution/candidate-evidence-decimals.js";
import type { ExecutionService } from "../execution/execution-service.js";
import type {
  CandidateExecutionAuthority,
  SubmitOrderFromDecisionInput,
  SubmitOrderFromDecisionResult,
} from "../execution/interfaces.js";
import { analyzePositionGuardMarketStructure } from "./market-structure.js";
import {
  buildPositionGuardStrategyContext,
  loadPositionGuardStrategyContext,
} from "./position-guard-context.js";
import {
  decidePositionGuardCore,
  DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
  POSITION_GUARD_STRATEGY_KEY,
  toStrategyDecision,
  type PositionGuardEngineDecision,
  type PositionGuardStrategyContext,
  type PositionGuardStrategySettings,
} from "./position-guard-core.js";
import {
  routePositionGuardPolicy,
  type PositionGuardPolicyRouteReason,
  type PositionGuardPolicyRouteResult,
} from "./position-guard-policy-router.js";
import {
  fetchPositionGuardMarketSnapshot,
  type PositionGuardPublicMarketDataReader,
} from "./position-guard-snapshot.js";

export interface PositionGuardRunnerConfig {
  exchangeAccountId: string;
  candleCount: number;
  settings: PositionGuardStrategySettings;
}

export interface PositionGuardRunInput {
  market: SupportedMarket;
  generatedAt: string;
  candleTo?: string;
  refreshReceipt?: PositionGuardPilotRefreshReceipt;
}

export type PositionGuardRunnerPilotVerificationResult =
  | Readonly<{
      status: "READY";
      verificationOnly?: true;
      deployment: Readonly<PositionGuardPilotDeploymentRecord>;
      phase: "PENDING_FLAT" | "ACTIVE" | "DRAINING" | "DISABLED";
      activation: Readonly<{ activationAt: string; activationEpochNs: bigint }> | null;
      state: Readonly<ExactCandidateState>;
      stateVersion: number;
      refreshProvenance: Readonly<PositionGuardPilotRefreshReceipt>;
    }>
  | Readonly<{
      status: "BLOCKED_FAULT";
      reasonCode: CandidatePilotRecoveryFaultReason;
      faultId: string;
      executableAuthority: false;
    }>;

export interface PositionGuardCandidateRunVerifier {
  verifyAndPrepareBtcRun(
    receipt: PositionGuardPilotRefreshReceipt,
  ): Promise<PositionGuardRunnerPilotVerificationResult>;
}

export interface PositionGuardRunResult {
  strategyDecisionRecord: StrategyDecisionRecord;
  strategyDecision: StrategyDecision;
  engineDecision: PositionGuardEngineDecision;
  context: PositionGuardStrategyContext;
  submission: SubmitOrderFromDecisionResult | null;
}

export interface PositionGuardOrderPreview {
  side: OrderSide;
  ordType: OrderType;
  price: string | null;
  volume: string | null;
  requestedNotionalKrw: number | null;
  requestedQuantity: number | null;
}

export interface PositionGuardPreviewResult {
  strategyDecision: StrategyDecision;
  engineDecision: PositionGuardEngineDecision;
  context: PositionGuardStrategyContext;
  orderPreview: PositionGuardOrderPreview | null;
}

export interface PositionGuardPolicyRouteAudit {
  schemaVersion: "POSITION_GUARD_POLICY_ROUTE_AUDIT_V1";
  configuredSelection: PositionGuardPolicySelection;
  resolvedSelection: PositionGuardPolicyRouteResult["selection"];
  baselineDecision: PositionGuardEngineDecision;
  baselineStrategyDecision: StrategyDecision;
  candidateEvaluation: PositionGuardPolicyRouteResult["candidateEvaluation"];
  effectiveDecision: PositionGuardEngineDecision;
  effectiveStrategyDecision: StrategyDecision;
  executionBlocked: boolean;
  executionDecision: PositionGuardEngineDecision | null;
  deploymentId: string | null;
  pilotId: string | null;
  policyId: string | null;
  policyVersion: string | null;
  phase: PositionGuardPilotPhase;
  activationAt: string | null;
  stateVersion: number | null;
  reasonCode: PositionGuardPolicyRouteReason;
  refreshProvenance: PositionGuardPilotRefreshReceipt | null;
}

export class PositionGuardCandidateRunBlockedError extends Error {
  readonly reasonCode: CandidatePilotRecoveryFaultReason;
  readonly faultId: string;

  constructor(result: Extract<PositionGuardRunnerPilotVerificationResult, { status: "BLOCKED_FAULT" }>) {
    super(`PositionGuard BTC candidate verification blocked: ${result.reasonCode}.`);
    this.name = "PositionGuardCandidateRunBlockedError";
    this.reasonCode = result.reasonCode;
    this.faultId = result.faultId;
  }
}

const BASELINE_POLICY_SELECTION: PositionGuardPolicySelection = Object.freeze({
  kind: "BASELINE",
  pilotId: null,
});

export class PositionGuardStrategyRunner {
  constructor(
    private readonly dependencies: {
      repositories: ExecutionRepository;
      executionService: ExecutionService;
      marketDataReader: PositionGuardPublicMarketDataReader;
      config: PositionGuardRunnerConfig;
      policySelection?: PositionGuardPolicySelection;
      candidateRunVerifier?: PositionGuardCandidateRunVerifier;
      policyRouter?: typeof routePositionGuardPolicy;
    },
  ) {}

  async runOnce(input: PositionGuardRunInput): Promise<PositionGuardRunResult> {
    const baselineDecision = await this.buildDecision(input);
    const selection = this.dependencies.policySelection ?? BASELINE_POLICY_SELECTION;
    if (selection.kind === "BASELINE") {
      return this.persistAndExecuteBaseline(input, baselineDecision);
    }

    const verification = input.market === "KRW-BTC"
      ? await this.verifyCandidateRun(input)
      : null;
    const route = (this.dependencies.policyRouter ?? routePositionGuardPolicy)({
      market: input.market,
      generatedAt: input.generatedAt,
      baselineDecision: baselineDecision.engineDecision,
      selection,
      pilotPhase: verification?.phase ?? "DISABLED",
      candidateState: verification === null
        ? null
        : toPositionGuardCandidateRoutingState(verification.state),
      positionQuantity: baselineDecision.context.positionQuantity,
      averageEntryPrice: baselineDecision.context.averageEntryPrice,
      analysis: baselineDecision.context.analysis,
    });
    const effectiveStrategyDecision = toStrategyDecision(
      baselineDecision.context,
      route.effectiveDecision,
    );
    const executionStrategyDecision = route.executionDecision === null
      ? null
      : toStrategyDecision(baselineDecision.context, route.executionDecision);
    const candidateAuthority = executionStrategyDecision === null
      ? undefined
      : candidateExecutionAuthority({
          verification,
          route,
          executionDecision: executionStrategyDecision,
        });
    const policyRoute = createPolicyRouteAudit({
      selection,
      baselineDecision,
      effectiveStrategyDecision,
      route,
      verification,
    });
    const strategyDecisionRecord = createStrategyDecisionRecord({
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      generatedAt: input.generatedAt,
      strategyDecision: effectiveStrategyDecision,
      engineDecision: route.effectiveDecision,
      context: baselineDecision.context,
      policyRoute,
    });

    await this.dependencies.repositories.saveStrategyDecision(strategyDecisionRecord);

    const orderInput = route.executionBlocked || executionStrategyDecision === null
      ? null
      : toOrderSubmissionInput({
          exchangeAccountId: this.dependencies.config.exchangeAccountId,
          strategyDecisionId: strategyDecisionRecord.id,
          decision: executionStrategyDecision,
          referencePriceCapturedAt: baselineDecision.referencePriceCapturedAt,
          ...(candidateAuthority === undefined ? {} : { candidateAuthority }),
        });
    const submission = orderInput === null
      ? null
      : await this.dependencies.executionService.submitOrderFromDecision(orderInput);

    return {
      strategyDecisionRecord,
      strategyDecision: effectiveStrategyDecision,
      engineDecision: route.effectiveDecision,
      context: baselineDecision.context,
      submission,
    };
  }

  private async persistAndExecuteBaseline(
    input: PositionGuardRunInput,
    decision: Awaited<ReturnType<PositionGuardStrategyRunner["buildDecision"]>>,
  ): Promise<PositionGuardRunResult> {
    const strategyDecisionRecord = createStrategyDecisionRecord({
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      generatedAt: input.generatedAt,
      strategyDecision: decision.strategyDecision,
      engineDecision: decision.engineDecision,
      context: decision.context,
    });

    await this.dependencies.repositories.saveStrategyDecision(strategyDecisionRecord);

    const orderInput = toOrderSubmissionInput({
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      strategyDecisionId: strategyDecisionRecord.id,
      decision: decision.strategyDecision,
      referencePriceCapturedAt: decision.referencePriceCapturedAt,
    });
    const submission = orderInput === null
      ? null
      : await this.dependencies.executionService.submitOrderFromDecision(orderInput);

    return {
      strategyDecisionRecord,
      strategyDecision: decision.strategyDecision,
      engineDecision: decision.engineDecision,
      context: decision.context,
      submission,
    };
  }

  private async verifyCandidateRun(
    input: PositionGuardRunInput,
  ): Promise<Extract<PositionGuardRunnerPilotVerificationResult, { status: "READY" }>> {
    if (input.refreshReceipt === undefined) {
      throw new Error("A verified BTC candidate run requires an exact refresh receipt.");
    }
    if (this.dependencies.candidateRunVerifier === undefined) {
      throw new Error("A verified BTC candidate run requires a candidate verifier.");
    }
    const verification = await this.dependencies.candidateRunVerifier.verifyAndPrepareBtcRun(
      input.refreshReceipt,
    );
    if (verification.status === "BLOCKED_FAULT") {
      throw new PositionGuardCandidateRunBlockedError(verification);
    }
    return canonicalReadyVerification({
      verification,
      selection: this.dependencies.policySelection!,
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      receipt: input.refreshReceipt,
    });
  }

  async previewOnce(input: PositionGuardRunInput): Promise<PositionGuardPreviewResult> {
    const decision = await this.buildDecision(input);
    const orderInput = toOrderSubmissionInput({
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      strategyDecisionId: "preview",
      decision: decision.strategyDecision,
      referencePriceCapturedAt: decision.referencePriceCapturedAt,
    });

    return {
      ...decision,
      orderPreview: orderInput === null ? null : toOrderPreview(orderInput),
    };
  }

  private async buildDecision(input: PositionGuardRunInput): Promise<{
    strategyDecision: StrategyDecision;
    engineDecision: PositionGuardEngineDecision;
    context: PositionGuardStrategyContext;
    referencePriceCapturedAt: string;
  }> {
    const marketSnapshot = await fetchPositionGuardMarketSnapshot(this.dependencies.marketDataReader, {
      market: input.market,
      fetchedAt: input.generatedAt,
      candleCount: this.dependencies.config.candleCount,
      ...(input.candleTo === undefined ? {} : { to: input.candleTo }),
    });
    const preliminaryAnalysis = analyzePositionGuardMarketStructure(marketSnapshot);
    const context = await loadPositionGuardStrategyContext(this.dependencies.repositories, {
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      market: input.market,
      generatedAt: input.generatedAt,
      settings: this.dependencies.config.settings,
      analysis: preliminaryAnalysis,
    });
    const engineDecision = decidePositionGuardCore(context);
    const strategyDecision = toStrategyDecision(context, engineDecision);
    const referencePriceCapturedAt = resolveReferencePriceCapturedAt(marketSnapshot);

    return {
      strategyDecision,
      engineDecision,
      context,
      referencePriceCapturedAt,
    };
  }
}

function createPolicyRouteAudit(input: {
  selection: Extract<PositionGuardPolicySelection, { kind: "BTC_CANDIDATE_PILOT" }>;
  baselineDecision: {
    strategyDecision: StrategyDecision;
    engineDecision: PositionGuardEngineDecision;
  };
  effectiveStrategyDecision: StrategyDecision;
  route: Readonly<PositionGuardPolicyRouteResult>;
  verification: Extract<PositionGuardRunnerPilotVerificationResult, { status: "READY" }> | null;
}): PositionGuardPolicyRouteAudit {
  const deployment = input.verification?.deployment ?? null;
  const audit = {
    schemaVersion: "POSITION_GUARD_POLICY_ROUTE_AUDIT_V1" as const,
    configuredSelection: input.selection,
    resolvedSelection: input.route.selection,
    baselineDecision: input.route.baselineDecision,
    baselineStrategyDecision: input.baselineDecision.strategyDecision,
    candidateEvaluation: input.route.candidateEvaluation,
    effectiveDecision: input.route.effectiveDecision,
    effectiveStrategyDecision: input.effectiveStrategyDecision,
    executionBlocked: input.route.executionBlocked,
    executionDecision: input.route.executionDecision,
    deploymentId: deployment?.id ?? null,
    pilotId: deployment?.pilotId ?? null,
    policyId: deployment?.policyId ?? null,
    policyVersion: deployment?.policyVersion ?? null,
    phase: input.route.pilotPhase,
    activationAt: input.verification?.activation?.activationAt ?? null,
    stateVersion: input.route.stateVersion,
    reasonCode: input.route.reasonCode,
    refreshProvenance: input.verification?.refreshProvenance ?? null,
  };
  return JSON.parse(JSON.stringify(audit)) as PositionGuardPolicyRouteAudit;
}

function candidateExecutionAuthority(input: {
  verification: Extract<PositionGuardRunnerPilotVerificationResult, { status: "READY" }> | null;
  route: Readonly<PositionGuardPolicyRouteResult>;
  executionDecision: StrategyDecision;
}): CandidateExecutionAuthority | undefined {
  if (
    input.verification === null ||
    input.verification.phase !== "ACTIVE" ||
    input.verification.activation === null ||
    input.route.pilotPhase !== "ACTIVE" ||
    input.route.executionBlocked ||
    input.executionDecision.action === "HOLD" ||
    input.executionDecision.metadata.executionDisposition === "DEFERRED_CONFIRMATION" ||
    (input.route.reasonCode !== "CANDIDATE_ALLOWED" &&
      input.route.reasonCode !== "CANDIDATE_EARLY_THESIS_FAILURE") ||
    (input.route.reasonCode === "CANDIDATE_EARLY_THESIS_FAILURE" && input.executionDecision.action !== "EXIT")
  ) {
    return undefined;
  }

  const deployment = input.verification.deployment;
  return Object.freeze({
    kind: "POSITION_GUARD_BTC_CANDIDATE",
    deploymentId: deployment.id,
    exchangeAccountId: deployment.exchangeAccountId,
    pilotId: deployment.pilotId,
    market: deployment.market,
    strategyKey: "position_guard.paper_core.v1",
    policyId: deployment.policyId,
    policyVersion: deployment.policyVersion,
    activationAt: input.verification.activation.activationAt,
    activationEpochNs: input.verification.activation.activationEpochNs,
    expectedDeploymentUpdatedAt: deployment.updatedAt,
    expectedStateVersion: input.verification.stateVersion,
    expectedPhase: "ACTIVE",
    routeReason: input.route.reasonCode,
  });
}

function canonicalReadyVerification(input: {
  verification: Extract<PositionGuardRunnerPilotVerificationResult, { status: "READY" }>;
  selection: PositionGuardPolicySelection;
  exchangeAccountId: string;
  receipt: PositionGuardPilotRefreshReceipt;
}): Extract<PositionGuardRunnerPilotVerificationResult, { status: "READY" }> {
  if (input.selection.kind !== "BTC_CANDIDATE_PILOT") {
    throw new Error("Candidate verification requires the exact BTC candidate selection.");
  }
  const verificationRecord = exactOwnDataRecord(
    input.verification,
    "verified BTC candidate authority",
    READY_VERIFICATION_KEYS,
    OPTIONAL_READY_VERIFICATION_KEYS,
  );
  if (verificationRecord.status !== "READY") {
    throw new Error("Verified BTC candidate authority status must be READY.");
  }
  if (
    Object.hasOwn(verificationRecord, "verificationOnly") &&
    verificationRecord.verificationOnly !== true
  ) {
    throw new Error("Verified BTC candidate authority verificationOnly must be true when present.");
  }
  const deployment = Object.freeze(validateCandidatePilotDeployment(
    verificationRecord.deployment as PositionGuardPilotDeploymentRecord,
  ));
  const phase = requirePilotReadyPhase(verificationRecord.phase);
  const activation = canonicalActivation(verificationRecord.activation);
  const state = canonicalExactCandidateState(verificationRecord.state);
  const stateVersion = requireNonNegativeSafeInteger(
    verificationRecord.stateVersion,
    "verified BTC candidate stateVersion",
  );
  const receipt = canonicalRefreshReceipt(input.receipt, "candidate run refresh receipt");
  const refreshProvenance = canonicalRefreshReceipt(
    verificationRecord.refreshProvenance,
    "verified BTC candidate refresh provenance",
  );
  if (
    deployment.exchangeAccountId !== input.exchangeAccountId ||
    deployment.exchangeAccountId !== receipt.exchangeAccountId ||
    deployment.pilotId !== input.selection.pilotId ||
    deployment.market !== input.selection.market ||
    deployment.policyId !== input.selection.policyId ||
    deployment.policyVersion !== input.selection.policyVersion ||
    deployment.phase !== phase ||
    stateVersion !== state.stateVersion
  ) {
    throw new Error("Verified BTC candidate authority does not match the configured run identity.");
  }
  if (!sameRefreshReceipt(receipt, refreshProvenance)) {
    throw new Error("Verified BTC candidate refresh provenance does not match the exact run receipt.");
  }
  if (phase === "ACTIVE" || phase === "DRAINING") {
    if (
      activation === null ||
      deployment.activationAt !== activation.activationAt ||
      deployment.activationEpochNs !== activation.activationEpochNs
    ) {
      throw new Error(`Verified ${phase} BTC candidate authority requires exact activation provenance.`);
    }
  } else if (phase === "PENDING_FLAT" && activation !== null) {
    throw new Error("PENDING_FLAT BTC candidate authority cannot carry activation provenance.");
  } else if (phase === "DISABLED") {
    if (activation === null) {
      if (deployment.activationAt !== null || deployment.activationEpochNs !== null) {
        throw new Error("Verified DISABLED BTC candidate authority activation provenance is invalid.");
      }
    } else if (
      deployment.activationAt !== activation.activationAt
      || deployment.activationEpochNs !== activation.activationEpochNs
    ) {
      throw new Error("Verified DISABLED BTC candidate authority activation provenance is invalid.");
    }
  }
  return Object.freeze({
    status: "READY",
    deployment,
    phase,
    activation,
    state,
    stateVersion,
    refreshProvenance,
  });
}

const READY_VERIFICATION_KEYS = [
  "status",
  "deployment",
  "phase",
  "activation",
  "state",
  "stateVersion",
  "refreshProvenance",
] as const;
const OPTIONAL_READY_VERIFICATION_KEYS = ["verificationOnly"] as const;
const EXACT_CANDIDATE_STATE_KEYS = [
  "currentEpisodeAddCount",
  "currentEpisodeCostBasisKrw",
  "currentEpisodeInventoryQuantity",
  "currentEpisodeRealizedPnlKrw",
  "lastFullExitAt",
  "lastFullExitRealizedPnlKrw",
  "lastEntryPath",
  "lastEvidenceAt",
  "lastEvidenceId",
  "stateVersion",
] as const;

function canonicalActivation(value: unknown): Readonly<{
  activationAt: string;
  activationEpochNs: bigint;
}> | null {
  if (value === null) return null;
  const record = exactOwnDataRecord(value, "verified BTC candidate activation", [
    "activationAt",
    "activationEpochNs",
  ] as const);
  const activationAt = requireNonEmptyString(record.activationAt, "candidate activationAt");
  const activationEpochNs = record.activationEpochNs;
  if (typeof activationEpochNs !== "bigint") {
    throw new Error("Candidate activationEpochNs must be a bigint.");
  }
  if (parseCandidatePilotTimestamp(activationAt, "candidate activationAt") !== activationEpochNs) {
    throw new Error("Candidate activation epoch does not match its timestamp.");
  }
  return Object.freeze({ activationAt, activationEpochNs });
}

function canonicalExactCandidateState(value: unknown): Readonly<ExactCandidateState> {
  const record = exactOwnDataRecord(value, "verified exact candidate state", EXACT_CANDIDATE_STATE_KEYS);
  const state: ExactCandidateState = {
    currentEpisodeAddCount: requireNonNegativeSafeInteger(
      record.currentEpisodeAddCount,
      "candidate currentEpisodeAddCount",
    ),
    currentEpisodeCostBasisKrw: canonicalNonNegativeDecimal(
      record.currentEpisodeCostBasisKrw,
      "candidate currentEpisodeCostBasisKrw",
    ),
    currentEpisodeInventoryQuantity: canonicalNonNegativeDecimal(
      record.currentEpisodeInventoryQuantity,
      "candidate currentEpisodeInventoryQuantity",
    ),
    currentEpisodeRealizedPnlKrw: canonicalSignedDecimal(
      record.currentEpisodeRealizedPnlKrw,
      "candidate currentEpisodeRealizedPnlKrw",
    ),
    lastFullExitAt: requireNullableString(record.lastFullExitAt, "candidate lastFullExitAt"),
    lastFullExitRealizedPnlKrw: record.lastFullExitRealizedPnlKrw === null
      ? null
      : canonicalSignedDecimal(
          record.lastFullExitRealizedPnlKrw,
          "candidate lastFullExitRealizedPnlKrw",
        ),
    lastEntryPath: requireCandidateEntryPath(record.lastEntryPath),
    lastEvidenceAt: requireNullableString(record.lastEvidenceAt, "candidate lastEvidenceAt"),
    lastEvidenceId: requireNullableString(record.lastEvidenceId, "candidate lastEvidenceId"),
    stateVersion: requireNonNegativeSafeInteger(record.stateVersion, "candidate stateVersion"),
  };
  toPositionGuardCandidateRoutingState(state);
  return Object.freeze(state);
}

function canonicalRefreshReceipt(value: unknown, label: string): PositionGuardPilotRefreshReceipt {
  const record = exactOwnDataRecord(value, label, REFRESH_RECEIPT_KEYS);
  const receipt = {
    exchangeAccountId: requireNonEmptyString(record.exchangeAccountId, `${label} exchangeAccountId`),
    requestedAt: requireTimestamp(record.requestedAt, `${label} requestedAt`),
    balanceSnapshotId: requireNonEmptyString(record.balanceSnapshotId, `${label} balanceSnapshotId`),
    balanceCapturedAt: requireTimestamp(record.balanceCapturedAt, `${label} balanceCapturedAt`),
    positionSnapshotId: requireNonEmptyString(record.positionSnapshotId, `${label} positionSnapshotId`),
    positionCapturedAt: requireTimestamp(record.positionCapturedAt, `${label} positionCapturedAt`),
    reconciliationRunId: requireNonEmptyString(
      record.reconciliationRunId,
      `${label} reconciliationRunId`,
    ),
    reconciliationStartedAt: requireTimestamp(
      record.reconciliationStartedAt,
      `${label} reconciliationStartedAt`,
    ),
    reconciliationCompletedAt: requireTimestamp(
      record.reconciliationCompletedAt,
      `${label} reconciliationCompletedAt`,
    ),
    reconciliationSource: record.reconciliationSource,
  };
  if (receipt.reconciliationSource !== "SCHEDULER_PREFLIGHT") {
    throw new Error(`${label} reconciliationSource must be SCHEDULER_PREFLIGHT.`);
  }
  return Object.freeze(receipt as PositionGuardPilotRefreshReceipt);
}

const REFRESH_RECEIPT_KEYS = [
  "exchangeAccountId",
  "requestedAt",
  "balanceSnapshotId",
  "balanceCapturedAt",
  "positionSnapshotId",
  "positionCapturedAt",
  "reconciliationRunId",
  "reconciliationStartedAt",
  "reconciliationCompletedAt",
  "reconciliationSource",
] as const;

function sameRefreshReceipt(
  left: PositionGuardPilotRefreshReceipt,
  right: PositionGuardPilotRefreshReceipt,
): boolean {
  return REFRESH_RECEIPT_KEYS.every((key) => left[key] === right[key]) &&
    Reflect.ownKeys(left).length === REFRESH_RECEIPT_KEYS.length &&
    Reflect.ownKeys(right).length === REFRESH_RECEIPT_KEYS.length;
}

function exactOwnDataRecord<
  const TRequired extends readonly string[],
  const TOptional extends readonly string[] = readonly [],
>(
  value: unknown,
  label: string,
  requiredKeys: TRequired,
  optionalKeys: TOptional = [] as unknown as TOptional,
): Record<TRequired[number] | TOptional[number], unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be a plain object with exactly own data properties.`);
  }
  const expected = new Set<string>([...requiredKeys, ...optionalKeys]);
  const required = new Set<string>(requiredKeys);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some((key) => typeof key !== "string" || !expected.has(key)) ||
    [...required].some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} must have exactly the approved own data properties.`);
  }
  const result = {} as Record<TRequired[number] | TOptional[number], unknown>;
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label} must have exactly the approved own data properties.`);
    }
    result[key as TRequired[number] | TOptional[number]] = descriptor.value;
  }
  return result;
}

function requirePilotReadyPhase(value: unknown): "PENDING_FLAT" | "ACTIVE" | "DRAINING" | "DISABLED" {
  if (value !== "PENDING_FLAT" && value !== "ACTIVE" && value !== "DRAINING" && value !== "DISABLED") {
    throw new Error("Verified BTC candidate phase must be PENDING_FLAT, ACTIVE, DRAINING, or DISABLED.");
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireNullableString(value: unknown, label: string): string | null {
  return value === null ? null : requireNonEmptyString(value, label);
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireNonEmptyString(value, label);
  parseCandidatePilotTimestamp(timestamp, label);
  return timestamp;
}

function requireCandidateEntryPath(value: unknown): ExactCandidateState["lastEntryPath"] {
  if (
    value !== null &&
    value !== "PULLBACK" &&
    value !== "RECLAIM" &&
    value !== "BREAKOUT_HOLD" &&
    value !== "NONE"
  ) {
    throw new Error("Candidate lastEntryPath is invalid.");
  }
  return value;
}

export function createStrategyDecisionRecord(input: {
  exchangeAccountId: string;
  generatedAt: string;
  strategyDecision: StrategyDecision;
  engineDecision: PositionGuardEngineDecision;
  context: PositionGuardStrategyContext;
  policyRoute?: PositionGuardPolicyRouteAudit;
}): StrategyDecisionRecord {
  const decisionBasis: Record<string, unknown> = {
    strategyDecision: input.strategyDecision,
    engineDecision: input.engineDecision,
    context: {
      asset: input.context.asset,
      market: input.context.market,
      generatedAt: input.context.generatedAt,
      positionQuantity: input.context.positionQuantity,
      averageEntryPrice: input.context.averageEntryPrice,
      portfolio: input.context.portfolio,
      latestDecision: input.context.latestDecision,
      recentExit: input.context.recentExit,
      settings: input.context.settings,
      analysis: input.context.analysis,
    },
    metadata: input.strategyDecision.metadata,
  };
  if (input.policyRoute !== undefined) decisionBasis.policyRoute = input.policyRoute;
  return {
    id: createId("strategy_decision"),
    exchangeAccountId: input.exchangeAccountId,
    strategyKey: input.strategyDecision.strategyKey,
    market: input.strategyDecision.market,
    action: input.strategyDecision.action,
    status: input.engineDecision.executionDisposition === "DEFERRED_CONFIRMATION"
      ? "PENDING_CONFIRMATION"
      : input.strategyDecision.action === "HOLD"
        ? "NO_ACTION"
        : "READY",
    decisionBasisJson: JSON.stringify(decisionBasis),
    intendedNotionalKrw: input.strategyDecision.requestedNotionalKrw === null
      ? null
      : String(input.strategyDecision.requestedNotionalKrw),
    intendedQuantity: input.strategyDecision.requestedQuantity === null
      ? null
      : String(input.strategyDecision.requestedQuantity),
    referencePrice: String(input.strategyDecision.referencePrice),
    createdAt: input.generatedAt,
  };
}

export function toOrderSubmissionInput(input: {
  exchangeAccountId: string;
  strategyDecisionId: string;
  decision: StrategyDecision;
  referencePriceCapturedAt: string;
  candidateAuthority?: CandidateExecutionAuthority;
}): SubmitOrderFromDecisionInput | null {
  if (input.decision.metadata.executionDisposition === "DEFERRED_CONFIRMATION") {
    return null;
  }

  switch (input.decision.action) {
    case "ENTER":
    case "ADD": {
      if (input.decision.requestedNotionalKrw === null || input.decision.requestedNotionalKrw <= 0) {
        return null;
      }

      return {
        exchangeAccountId: input.exchangeAccountId,
        strategyDecisionId: input.strategyDecisionId,
        referencePriceCapturedAt: input.referencePriceCapturedAt,
        decision: input.decision,
        side: "bid",
        ordType: "price",
        price: formatDecimal(input.decision.requestedNotionalKrw),
        volume: null,
        ...(input.candidateAuthority === undefined ? {} : { candidateAuthority: input.candidateAuthority }),
      };
    }
    case "REDUCE":
    case "EXIT": {
      if (input.decision.requestedQuantity === null || input.decision.requestedQuantity <= 0) {
        return null;
      }

      return {
        exchangeAccountId: input.exchangeAccountId,
        strategyDecisionId: input.strategyDecisionId,
        referencePriceCapturedAt: input.referencePriceCapturedAt,
        decision: input.decision,
        side: "ask",
        ordType: "market",
        price: null,
        volume: formatDecimal(input.decision.requestedQuantity),
        ...(input.candidateAuthority === undefined ? {} : { candidateAuthority: input.candidateAuthority }),
      };
    }
    case "HOLD":
      return null;
  }
}

export function createDefaultPositionGuardRunnerConfig(
  exchangeAccountId: string,
): PositionGuardRunnerConfig {
  return {
    exchangeAccountId,
    candleCount: 200,
    settings: DEFAULT_POSITION_GUARD_STRATEGY_SETTINGS,
  };
}

function formatDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(12).replace(/0+$/u, "").replace(/\.$/u, "");
}

function resolveReferencePriceCapturedAt(
  snapshot: Awaited<ReturnType<typeof fetchPositionGuardMarketSnapshot>>,
): string {
  if (
    typeof snapshot.ticker.exchangeTimestampMs === "number"
    && Number.isFinite(snapshot.ticker.exchangeTimestampMs)
  ) {
    return new Date(snapshot.ticker.exchangeTimestampMs).toISOString();
  }

  if (snapshot.ticker.tradeTimeUtc) {
    const timestampMs = Date.parse(snapshot.ticker.tradeTimeUtc);
    if (!Number.isNaN(timestampMs)) {
      return new Date(timestampMs).toISOString();
    }
  }

  throw new Error(`No valid exchange reference-price timestamp is available for ${snapshot.market}.`);
}

function toOrderPreview(input: SubmitOrderFromDecisionInput): PositionGuardOrderPreview {
  return {
    side: input.side,
    ordType: input.ordType,
    price: input.price,
    volume: input.volume,
    requestedNotionalKrw: derivePreviewNotionalKrw(input.decision, input.price, input.volume),
    requestedQuantity: typeof input.decision.requestedQuantity === "number"
      ? input.decision.requestedQuantity
      : input.volume
        ? Number(input.volume)
        : null,
  };
}

function derivePreviewNotionalKrw(
  decision: StrategyDecision,
  price: string | null,
  volume: string | null,
): number | null {
  if (typeof decision.requestedNotionalKrw === "number") {
    return decision.requestedNotionalKrw;
  }

  if (volume) {
    const volumeNumber = Number(volume);
    if (Number.isFinite(volumeNumber)) {
      return decision.referencePrice * volumeNumber;
    }
  }

  if (price) {
    const priceNumber = Number(price);
    return Number.isFinite(priceNumber) ? priceNumber : null;
  }

  return null;
}
