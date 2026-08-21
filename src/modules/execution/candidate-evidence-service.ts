import type {
  CandidateExecutionBindingRecord,
} from "../../domain/pilot-types.js";
import type {
  FillRecord,
  OrderRecord,
  StrategyDecisionRecord,
} from "../../domain/types.js";
import type { ExecutionRepository, OperatorStateStore } from "../db/interfaces.js";
import type { CandidateEvidenceRecord, CandidatePilotRepository } from "../db/pilot-interfaces.js";
import {
  addExactDecimals,
  canonicalNonNegativeDecimal,
  compareExactDecimals,
  compareDeterministicIdentifiers,
  deriveExactRemainingQuantity,
  formatExactDecimal,
  multiplyExactDecimals,
  parseCanonicalNonNegativeDecimal,
  projectExactCandidateState,
} from "./candidate-evidence-decimals.js";
import {
  parsePositionGuardCandidateTimestamp,
  type PositionGuardCandidateExecutionEvidence,
} from "../strategy/position-guard-candidate-state.js";
import { POSITION_GUARD_STRATEGY_KEY, type StrategyEntryPath } from "../strategy/position-guard-core.js";

export interface CandidateEvidenceClock {
  now(): { occurredAt: string; occurredAtEpochMs: number };
}

export type CandidateEvidenceProjectionOutcome =
  | "ADVANCED"
  | "DUPLICATE"
  | "NO_ACTIVE_DEPLOYMENT"
  | "NOT_CANDIDATE_ORDER"
  | "NOT_TERMINAL"
  | "TERMINAL_NO_FILL"
  | "FAULT";

export interface CandidateEvidenceProjectionResult {
  outcome: CandidateEvidenceProjectionOutcome;
  orderId: string;
  detail: string;
}

export class CandidateExecutionEvidenceService {
  constructor(
    private readonly dependencies: {
      exchangeAccountId: string;
      repositories: ExecutionRepository;
      pilotRepository: CandidatePilotRepository;
      operatorState: OperatorStateStore;
      clock: CandidateEvidenceClock;
    },
  ) {}

  async processTerminalOrder(orderId: string): Promise<CandidateEvidenceProjectionResult> {
    const order = await this.dependencies.repositories.findOrderByReference(
      this.dependencies.exchangeAccountId,
      orderId,
    );
    if (!order) {
      return { outcome: "NOT_CANDIDATE_ORDER", orderId, detail: "Order is not persisted for the candidate account." };
    }
    if (order.origin !== "STRATEGY" || order.market !== "KRW-BTC") {
      return { outcome: "NOT_CANDIDATE_ORDER", orderId, detail: "Order is outside candidate strategy provenance." };
    }
    if (order.status !== "FILLED" && order.status !== "CANCELED") {
      return { outcome: "NOT_TERMINAL", orderId, detail: `Order lifecycle ${order.status} is not terminal.` };
    }

    const deployment = await this.dependencies.pilotRepository.getDeploymentForExchangeAccount(order.exchangeAccountId);
    if (!deployment || (deployment.phase !== "ACTIVE" && deployment.phase !== "DRAINING")) {
      return { outcome: "NO_ACTIVE_DEPLOYMENT", orderId, detail: "No active candidate deployment is persisted." };
    }

    try {
      const binding = await this.dependencies.pilotRepository.getExecutionBindingForOrder(order.id);
      if (!binding) {
        throw new CandidateEvidenceFault(
          "CANDIDATE_EXECUTION_BINDING_MISSING",
          "Terminal candidate order has no persisted deployment binding.",
        );
      }
      const decision = await this.getVerifiedDecision(order, deployment, binding);
      const fills = await this.dependencies.repositories.listFills(order.id);
      if (fills.length === 0) {
        if (await this.hasTerminalNoFillMarker(order)) {
          return {
            outcome: "DUPLICATE",
            orderId: order.id,
            detail: "Terminal no-fill cancellation was already recorded.",
          };
        }
        return this.recordTerminalNoFill(order, decision);
      }

      const aggregate = aggregateTerminalFills(order, decision, fills);
      const evidenceId = `terminal-order:${order.id}`;
      const exactState = await this.dependencies.pilotRepository.getExactState(deployment.id);
      if (!exactState) {
        throw new CandidateEvidenceFault(
          "CANDIDATE_STATE_LEGACY_APPROXIMATE",
          "Candidate state has no authoritative exact decimal representation.",
        );
      }
      const records = await this.dependencies.pilotRepository.listEvidenceRecords(deployment.id);
      if (records.some((record) => record.materialVersion !== "EXACT_V2")) {
        throw new CandidateEvidenceFault(
          "LEGACY_CANDIDATE_EVIDENCE",
          "Candidate deployment contains legacy approximate evidence and cannot advance.",
        );
      }
      const evidenceEpoch = parseTimestamp(aggregate.executedAt, "terminal fill executedAt");
      const stateBeforeEvidence = projectExactCandidateState(
        records
          .filter((record) => isBeforeEvidence(record, evidenceEpoch, evidenceId))
          .map((record) => record.evidence),
      );
      const remainingQuantity = deriveExactRemainingQuantity({
        currentQuantity: stateBeforeEvidence.currentEpisodeInventoryQuantity,
        action: decision.action,
        executedQuantity: aggregate.executedQuantity,
      });
      const existing = await this.dependencies.pilotRepository.getEvidenceRecord(deployment.id, evidenceId);
      if (existing) {
        if (existing.materialVersion !== "EXACT_V2") {
          throw new CandidateEvidenceFault(
            "LEGACY_CANDIDATE_EVIDENCE",
            "Terminal order identity is occupied by legacy approximate candidate evidence.",
          );
        }
        assertMatchingExistingEvidence(existing, {
          evidenceId,
          executedAt: aggregate.executedAt,
          action: decision.action,
          entryPath: decision.entryPath,
          terminalStatus: order.status,
          executedQuantity: aggregate.executedQuantity,
          grossQuoteValueKrw: aggregate.grossQuoteValueKrw,
          confirmedFeeKrw: aggregate.confirmedFeeKrw,
          remainingQuantity,
        });
        return { outcome: "DUPLICATE", orderId, detail: "Terminal order evidence was already projected." };
      }
      const evidence: PositionGuardCandidateExecutionEvidence = {
        evidenceId,
        executedAt: aggregate.executedAt,
        action: decision.action,
        entryPath: decision.entryPath,
        terminalStatus: order.status,
        executedQuantity: aggregate.executedQuantity,
        grossQuoteValueKrw: aggregate.grossQuoteValueKrw,
        confirmedFeeKrw: aggregate.confirmedFeeKrw,
        remainingQuantity,
      };
      const advanced = await this.dependencies.pilotRepository.advanceStateWithEvidence({
        deploymentId: deployment.id,
        expectedStateVersion: exactState.stateVersion,
        evidence,
      });
      return {
        outcome: advanced.duplicate ? "DUPLICATE" : "ADVANCED",
        orderId,
        detail: advanced.duplicate
          ? "Terminal order evidence was already projected."
          : "Terminal order evidence was projected atomically.",
      };
    } catch (error) {
      const fault = error instanceof CandidateEvidenceFault
        ? error
        : new CandidateEvidenceFault(
          "CANDIDATE_EVIDENCE_PROJECTION_FAILED",
          error instanceof Error ? error.message : "Unknown candidate evidence projection failure.",
        );
      return this.fault(order, fault.code, fault.message);
    }
  }

  private async getVerifiedDecision(
    order: OrderRecord,
    deployment: Awaited<ReturnType<CandidatePilotRepository["getDeployment"]>> & {},
    binding: CandidateExecutionBindingRecord,
  ): Promise<VerifiedDecision> {
    if (!order.strategyDecisionId) {
      throw new CandidateEvidenceFault("STRATEGY_DECISION_MISSING", "Terminal strategy order has no decision reference.");
    }
    const decision = await this.dependencies.repositories.getStrategyDecisionById?.(order.strategyDecisionId);
    if (!decision) {
      throw new CandidateEvidenceFault("STRATEGY_DECISION_MISSING", "Terminal strategy order references no persisted decision.");
    }
    if (
      binding.deploymentId !== deployment.id ||
      binding.strategyDecisionId !== decision.id ||
      binding.orderId !== order.id ||
      binding.exchangeAccountId !== order.exchangeAccountId ||
      binding.market !== order.market ||
      binding.strategyKey !== POSITION_GUARD_STRATEGY_KEY ||
      binding.policyId !== deployment.policyId ||
      binding.policyVersion !== deployment.policyVersion ||
      binding.executionMode !== order.executionMode ||
      binding.ordType !== order.ordType
    ) {
      throw new CandidateEvidenceFault("CANDIDATE_EXECUTION_BINDING_INVALID", "Persisted order binding does not match deployment provenance.");
    }
    if (
      decision.exchangeAccountId !== order.exchangeAccountId ||
      decision.strategyKey !== POSITION_GUARD_STRATEGY_KEY ||
      decision.market !== order.market ||
      decision.status !== "READY" ||
      !isCandidateAction(decision.action) ||
      binding.action !== decision.action
    ) {
      throw new CandidateEvidenceFault("STRATEGY_DECISION_INVALID", "Persisted strategy decision is invalid for candidate evidence.");
    }
    const expectedSide = decision.action === "ENTER" || decision.action === "ADD" ? "bid" : "ask";
    if (order.side !== expectedSide || binding.side !== expectedSide) {
      throw new CandidateEvidenceFault("ORDER_SIDE_ACTION_MISMATCH", "Order side does not match persisted candidate action.");
    }
    assertSameOptionalExactDecimal(binding.intendedQuantity, decision.intendedQuantity, "intended quantity");
    assertSameOptionalExactDecimal(binding.intendedNotionalKrw, decision.intendedNotionalKrw, "intended notional");
    if (binding.intendedQuantity !== null && order.volume !== binding.intendedQuantity) {
      throw new CandidateEvidenceFault("ORDER_QUANTITY_INVALID", "Order volume does not match its bound intended quantity.");
    }
    if (order.ordType === "price" && binding.intendedNotionalKrw !== null && order.price !== binding.intendedNotionalKrw) {
      throw new CandidateEvidenceFault("ORDER_QUANTITY_INVALID", "Price order budget does not match its bound intended notional.");
    }
    const decisionAt = parseTimestamp(decision.createdAt, "strategy decision createdAt");
    const requestedAt = parseTimestamp(order.requestedAt, "order requestedAt");
    const activationAt = binding.activationEpochNs;
    if (decisionAt > requestedAt || requestedAt < activationAt) {
      throw new CandidateEvidenceFault("ORDER_TIMESTAMP_INVALID", "Decision, activation, and order timestamps are inconsistent.");
    }
    const basis = parseDecisionBasis(decision);
    return { action: decision.action, entryPath: basis.entryPath, decision, requestedAt };
  }

  private async fault(
    order: OrderRecord,
    code: string,
    message: string,
  ): Promise<CandidateEvidenceProjectionResult> {
    const now = this.dependencies.clock.now();
    validateClock(now);
    const eventId = `candidate-evidence-fault:${order.id}:${code}`;
    const existingEvents = await this.dependencies.repositories.listOrderEvents(order.id);
    if (!existingEvents.some((event) => event.id === eventId)) {
      await this.dependencies.repositories.appendOrderEvent({
        id: eventId,
        orderId: order.id,
        eventType: "CANDIDATE_EVIDENCE_PROJECTION_FAILED",
        eventSource: "RECONCILIATION",
        payloadJson: JSON.stringify({ code, message }),
        createdAt: now.occurredAt,
      });
    }
    await this.dependencies.operatorState.pauseForFault({
      exchangeAccountId: order.exchangeAccountId,
      faultId: eventId,
      reason: `${code}: ${message}`,
      occurredAt: now.occurredAt,
    });
    return { outcome: "FAULT", orderId: order.id, detail: `${code}: ${message}` };
  }

  private async recordTerminalNoFill(
    order: OrderRecord,
    decision: VerifiedDecision,
  ): Promise<CandidateEvidenceProjectionResult> {
    const eventId = `candidate-evidence-no-fill:${order.id}`;
    const existingEvents = await this.dependencies.repositories.listOrderEvents(order.id);
    if (existingEvents.some((event) => event.id === eventId)) {
      return { outcome: "DUPLICATE", orderId: order.id, detail: "Terminal no-fill cancellation was already recorded." };
    }
    const now = this.dependencies.clock.now();
    validateClock(now);
    await this.dependencies.repositories.appendOrderEvent({
      id: eventId,
      orderId: order.id,
      eventType: "CANDIDATE_EVIDENCE_TERMINAL_NO_FILL",
      eventSource: "RECONCILIATION",
      payloadJson: JSON.stringify({
        action: decision.action,
        entryPath: decision.entryPath,
        terminalStatus: order.status,
      }),
      createdAt: now.occurredAt,
    });
    return {
      outcome: "TERMINAL_NO_FILL",
      orderId: order.id,
      detail: "Terminal no-fill cancellation was recorded without candidate state advancement.",
    };
  }

  private async hasTerminalNoFillMarker(order: OrderRecord): Promise<boolean> {
    const eventId = `candidate-evidence-no-fill:${order.id}`;
    return (await this.dependencies.repositories.listOrderEvents(order.id)).some((event) => event.id === eventId);
  }
}

type CandidateAction = Extract<StrategyDecisionRecord["action"], "ENTER" | "ADD" | "REDUCE" | "EXIT">;

interface VerifiedDecision {
  action: CandidateAction;
  entryPath: StrategyEntryPath;
  decision: StrategyDecisionRecord;
  requestedAt: bigint;
}

interface TerminalFillAggregate {
  executedAt: string;
  executedQuantity: string;
  grossQuoteValueKrw: string;
  confirmedFeeKrw: string;
}

class CandidateEvidenceFault extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function aggregateTerminalFills(
  order: OrderRecord,
  decision: VerifiedDecision,
  fills: FillRecord[],
): TerminalFillAggregate {
  let executedQuantity = parseCanonicalNonNegativeDecimal("0", "aggregate executed quantity");
  let grossQuoteValueKrw = parseCanonicalNonNegativeDecimal("0", "aggregate gross quote value");
  let confirmedFeeKrw = parseCanonicalNonNegativeDecimal("0", "aggregate confirmed fee");
  const ordered = fills.map((fill) => ({
    fill,
    epochNanoseconds: parseTimestamp(fill.filledAt, "fill filledAt"),
  })).sort((left, right) => {
    if (left.epochNanoseconds < right.epochNanoseconds) return -1;
    if (left.epochNanoseconds > right.epochNanoseconds) return 1;
    return compareDeterministicIdentifiers(left.fill.id, right.fill.id);
  });
  for (const { fill, epochNanoseconds } of ordered) {
    if (fill.orderId !== order.id || fill.market !== order.market || fill.side !== order.side) {
      throw new CandidateEvidenceFault("FILL_ORDER_MISMATCH", "Persisted fill does not match terminal order identity.");
    }
    if (epochNanoseconds < decision.requestedAt) {
      throw new CandidateEvidenceFault("FILL_TIMESTAMP_INVALID", "Persisted fill precedes the terminal order request.");
    }
    if (fill.feeCurrency !== "KRW" || fill.feeAmount === null || fill.feeProvenance !== "EXCHANGE_FILL_CONFIRMED") {
      throw new CandidateEvidenceFault(
        "UNVERIFIED_FEE_PROVENANCE",
        "Every terminal fill requires a confirmed per-fill KRW fee source.",
      );
    }
    const volume = parseCanonicalNonNegativeDecimal(fill.volume, "fill volume");
    const price = parseCanonicalNonNegativeDecimal(fill.price, "fill price");
    const fee = parseCanonicalNonNegativeDecimal(fill.feeAmount, "fill feeAmount");
    if (volume.coefficient === 0n || price.coefficient === 0n) {
      throw new CandidateEvidenceFault("DECIMAL_INVALID", "Terminal fill volume and price must be positive.");
    }
    executedQuantity = addExactDecimals(executedQuantity, volume);
    grossQuoteValueKrw = addExactDecimals(grossQuoteValueKrw, multiplyExactDecimals(price, volume));
    confirmedFeeKrw = addExactDecimals(confirmedFeeKrw, fee);
  }
  if (executedQuantity.coefficient === 0n) {
    throw new CandidateEvidenceFault("TERMINAL_FILL_ZERO", "Terminal order contains only zero fills.");
  }
  if (order.volume !== null) {
    const requestedQuantity = parseCanonicalNonNegativeDecimal(order.volume, "order volume");
    if (compareExactDecimals(executedQuantity, requestedQuantity) > 0) {
      throw new CandidateEvidenceFault("ORDER_QUANTITY_INVALID", "Terminal fills exceed persisted order quantity.");
    }
  }
  if (order.side === "bid" && order.ordType === "price") {
    const quoteBudget = parseCanonicalNonNegativeDecimal(order.price ?? "", "order price");
    if (compareExactDecimals(grossQuoteValueKrw, quoteBudget) > 0) {
      throw new CandidateEvidenceFault("ORDER_QUANTITY_INVALID", "Terminal bid fills exceed persisted quote budget.");
    }
  }
  const latest = ordered.at(-1)!;
  return {
    executedAt: latest.fill.filledAt,
    executedQuantity: formatExactDecimal(executedQuantity),
    grossQuoteValueKrw: formatExactDecimal(grossQuoteValueKrw),
    confirmedFeeKrw: formatExactDecimal(confirmedFeeKrw),
  };
}

function parseDecisionBasis(decision: StrategyDecisionRecord): { entryPath: StrategyEntryPath } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decision.decisionBasisJson) as unknown;
  } catch {
    throw new CandidateEvidenceFault("STRATEGY_DECISION_INVALID", "Strategy decision basis JSON is malformed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CandidateEvidenceFault("STRATEGY_DECISION_INVALID", "Strategy decision basis JSON is invalid.");
  }
  const record = parsed as Record<string, unknown>;
  const strategyDecision = asRecord(record.strategyDecision);
  const engineDecision = asRecord(record.engineDecision);
  const entryPath = engineDecision?.entryPath;
  if (strategyDecision?.market !== decision.market || strategyDecision.action !== decision.action || !isEntryPath(entryPath)) {
    throw new CandidateEvidenceFault("STRATEGY_DECISION_INVALID", "Strategy decision basis does not match persisted decision provenance.");
  }
  return { entryPath };
}

function assertMatchingExistingEvidence(
  existing: Readonly<CandidateEvidenceRecord>,
  expected: PositionGuardCandidateExecutionEvidence,
): void {
  const evidence = existing.evidence;
  if (
    evidence.executedAt !== expected.executedAt ||
    evidence.action !== expected.action ||
    evidence.entryPath !== expected.entryPath ||
    evidence.terminalStatus !== expected.terminalStatus ||
    evidence.executedQuantity !== expected.executedQuantity ||
    evidence.grossQuoteValueKrw !== expected.grossQuoteValueKrw ||
    evidence.confirmedFeeKrw !== expected.confirmedFeeKrw ||
    evidence.remainingQuantity !== expected.remainingQuantity
  ) {
    throw new CandidateEvidenceFault("CONFLICTING_TERMINAL_EVIDENCE", "Persisted candidate evidence conflicts with terminal order evidence.");
  }
}

function isBeforeEvidence(record: Readonly<CandidateEvidenceRecord>, epoch: bigint, evidenceId: string): boolean {
  const recordEpoch = parseTimestamp(record.evidence.executedAt, "persisted candidate evidence executedAt");
  return recordEpoch < epoch || (recordEpoch === epoch && record.evidence.evidenceId < evidenceId);
}

function assertSameOptionalExactDecimal(left: string | null, right: string | null, label: string): void {
  if (left === null || right === null) {
    if (left !== right) {
      throw new CandidateEvidenceFault("CANDIDATE_EXECUTION_BINDING_INVALID", `Binding ${label} does not match strategy decision.`);
    }
    return;
  }
  if (canonicalNonNegativeDecimal(left, `binding ${label}`) !== canonicalNonNegativeDecimal(right, `decision ${label}`)) {
    throw new CandidateEvidenceFault("CANDIDATE_EXECUTION_BINDING_INVALID", `Binding ${label} does not match strategy decision.`);
  }
}

function isCandidateAction(value: StrategyDecisionRecord["action"]): value is CandidateAction {
  return value === "ENTER" || value === "ADD" || value === "REDUCE" || value === "EXIT";
}

function isEntryPath(value: unknown): value is StrategyEntryPath {
  return value === "PULLBACK" || value === "RECLAIM" || value === "BREAKOUT_HOLD" || value === "NONE";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseTimestamp(value: string, label: string): bigint {
  try {
    return parsePositionGuardCandidateTimestamp(value, label);
  } catch (error) {
    throw new CandidateEvidenceFault(
      "TIMESTAMP_INVALID",
      error instanceof Error ? error.message : `Invalid ${label}.`,
    );
  }
}

function validateClock(value: ReturnType<CandidateEvidenceClock["now"]>): void {
  if (!Number.isSafeInteger(value.occurredAtEpochMs) || value.occurredAtEpochMs < 0 || Date.parse(value.occurredAt) !== value.occurredAtEpochMs) {
    throw new Error("Candidate evidence clock must provide matching persisted ISO and epoch-millisecond values.");
  }
}
