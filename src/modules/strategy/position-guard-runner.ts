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
  toPositionGuardCandidateRoutingState,
  validateCandidatePilotDeployment,
  type CandidatePilotRecoveryFaultReason,
} from "../db/pilot-interfaces.js";
import type { ExactCandidateState } from "../execution/candidate-evidence-decimals.js";
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
      phase: "PENDING_FLAT" | "ACTIVE";
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

    const candidateAuthority = executionStrategyDecision === null
      ? undefined
      : candidateExecutionAuthority({
          verification,
          route,
          executionDecision: executionStrategyDecision,
        });
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
    validateReadyVerification({
      verification,
      selection: this.dependencies.policySelection!,
      exchangeAccountId: this.dependencies.config.exchangeAccountId,
      receipt: input.refreshReceipt,
    });
    return verification;
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

function validateReadyVerification(input: {
  verification: Extract<PositionGuardRunnerPilotVerificationResult, { status: "READY" }>;
  selection: PositionGuardPolicySelection;
  exchangeAccountId: string;
  receipt: PositionGuardPilotRefreshReceipt;
}): void {
  if (input.selection.kind !== "BTC_CANDIDATE_PILOT") {
    throw new Error("Candidate verification requires the exact BTC candidate selection.");
  }
  const deployment = validateCandidatePilotDeployment(input.verification.deployment);
  if (
    deployment.exchangeAccountId !== input.exchangeAccountId ||
    deployment.exchangeAccountId !== input.receipt.exchangeAccountId ||
    deployment.pilotId !== input.selection.pilotId ||
    deployment.market !== input.selection.market ||
    deployment.policyId !== input.selection.policyId ||
    deployment.policyVersion !== input.selection.policyVersion ||
    deployment.phase !== input.verification.phase ||
    input.verification.stateVersion !== input.verification.state.stateVersion
  ) {
    throw new Error("Verified BTC candidate authority does not match the configured run identity.");
  }
  if (!sameRefreshReceipt(input.receipt, input.verification.refreshProvenance)) {
    throw new Error("Verified BTC candidate refresh provenance does not match the exact run receipt.");
  }
  if (input.verification.phase === "ACTIVE") {
    if (
      input.verification.activation === null ||
      deployment.activationAt !== input.verification.activation.activationAt ||
      deployment.activationEpochNs !== input.verification.activation.activationEpochNs
    ) {
      throw new Error("Verified ACTIVE BTC candidate authority requires exact activation provenance.");
    }
  } else if (input.verification.activation !== null) {
    throw new Error("PENDING_FLAT BTC candidate authority cannot carry activation provenance.");
  }
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
