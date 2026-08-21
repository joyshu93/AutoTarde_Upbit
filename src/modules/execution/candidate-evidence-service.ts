import type {
  FillRecord,
  OrderRecord,
  StrategyDecisionRecord,
} from "../../domain/types.js";
import type { ExecutionRepository, OperatorStateStore } from "../db/interfaces.js";
import type { CandidatePilotRepository } from "../db/pilot-interfaces.js";
import {
  parsePositionGuardCandidateTimestamp,
  type PositionGuardCandidateDecimal,
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

    const deployment = await this.dependencies.pilotRepository.getDeploymentForExchangeAccount(
      order.exchangeAccountId,
    );
    if (!deployment || (deployment.phase !== "ACTIVE" && deployment.phase !== "DRAINING")) {
      return { outcome: "NO_ACTIVE_DEPLOYMENT", orderId, detail: "No active candidate deployment is persisted." };
    }
    if (deployment.market !== order.market) {
      return this.fault(order, "DEPLOYMENT_MARKET_MISMATCH", "Candidate deployment market does not match terminal order market.");
    }

    try {
      const fills = await this.dependencies.repositories.listFills(order.id);
      if (fills.length === 0) {
        if (await this.hasTerminalNoFillMarker(order)) {
          return {
            outcome: "DUPLICATE",
            orderId: order.id,
            detail: "Terminal no-fill cancellation was already recorded.",
          };
        }
        const decision = await this.getVerifiedDecision(order);
        return this.recordTerminalNoFill(order, decision);
      }

      const decision = await this.getVerifiedDecision(order);
      const aggregate = aggregateTerminalFills(order, decision, fills);
      if (aggregate.executedQuantity.coefficient === 0n) {
        return { outcome: "TERMINAL_NO_FILL", orderId, detail: "Terminal order has zero aggregate fills." };
      }

      const state = await this.dependencies.pilotRepository.getState(deployment.id);
      if (!state) {
        throw new CandidateEvidenceFault("CANDIDATE_STATE_MISSING", "Candidate deployment state is missing.");
      }
      const evidenceId = `terminal-order:${order.id}`;
      const existing = (await this.dependencies.pilotRepository.listEvidenceAfter(deployment.id, null))
        .find((evidence) => evidence.evidenceId === evidenceId);
      if (existing) {
        assertMatchingExistingEvidence(existing, {
          evidenceId,
          executedAt: order.updatedAt,
          action: decision.action,
          entryPath: decision.entryPath,
          terminalStatus: order.status,
          executedQuantity: formatDecimal(aggregate.executedQuantity),
          grossQuoteValueKrw: formatDecimal(aggregate.grossQuoteValueKrw),
          confirmedFeeKrw: formatDecimal(aggregate.confirmedFeeKrw),
        });
        return { outcome: "DUPLICATE", orderId, detail: "Terminal order evidence was already projected." };
      }

      const remainingQuantity = deriveRemainingQuantity(
        state.currentEpisodeInventoryQuantity,
        decision.action,
        aggregate.executedQuantity,
      );
      const evidence: PositionGuardCandidateExecutionEvidence = {
        evidenceId,
        executedAt: order.updatedAt,
        action: decision.action,
        entryPath: decision.entryPath,
        terminalStatus: order.status,
        executedQuantity: formatDecimal(aggregate.executedQuantity),
        grossQuoteValueKrw: formatDecimal(aggregate.grossQuoteValueKrw),
        confirmedFeeKrw: formatDecimal(aggregate.confirmedFeeKrw),
        remainingQuantity: formatDecimal(remainingQuantity),
      };
      const advanced = await this.dependencies.pilotRepository.advanceStateWithEvidence({
        deploymentId: deployment.id,
        expectedStateVersion: state.stateVersion,
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

  private async getVerifiedDecision(order: OrderRecord): Promise<VerifiedDecision> {
    if (!order.strategyDecisionId) {
      throw new CandidateEvidenceFault("STRATEGY_DECISION_MISSING", "Terminal strategy order has no decision reference.");
    }
    if (!this.dependencies.repositories.getStrategyDecisionById) {
      throw new CandidateEvidenceFault("STRATEGY_DECISION_LOOKUP_UNAVAILABLE", "Strategy decision lookup is unavailable.");
    }
    const decision = await this.dependencies.repositories.getStrategyDecisionById(order.strategyDecisionId);
    if (!decision) {
      throw new CandidateEvidenceFault("STRATEGY_DECISION_MISSING", "Terminal strategy order references no persisted decision.");
    }
    if (
      decision.exchangeAccountId !== order.exchangeAccountId ||
      decision.strategyKey !== POSITION_GUARD_STRATEGY_KEY ||
      decision.market !== order.market ||
      decision.status !== "READY" ||
      !isCandidateAction(decision.action)
    ) {
      throw new CandidateEvidenceFault("STRATEGY_DECISION_INVALID", "Persisted strategy decision is invalid for candidate evidence.");
    }
    const expectedSide = decision.action === "ENTER" || decision.action === "ADD" ? "bid" : "ask";
    if (order.side !== expectedSide) {
      throw new CandidateEvidenceFault("ORDER_SIDE_ACTION_MISMATCH", "Order side does not match the persisted decision action.");
    }
    const decisionAt = parseTimestamp(decision.createdAt, "strategy decision createdAt");
    const requestedAt = parseTimestamp(order.requestedAt, "order requestedAt");
    const updatedAt = parseTimestamp(order.updatedAt, "order updatedAt");
    if (decisionAt > requestedAt || requestedAt > updatedAt) {
      throw new CandidateEvidenceFault("ORDER_TIMESTAMP_INVALID", "Decision and order timestamps are inconsistent.");
    }
    const basis = parseDecisionBasis(decision);
    return { action: decision.action, entryPath: basis.entryPath, decision, decisionAt, requestedAt, updatedAt };
  }

  private async fault(
    order: OrderRecord,
    code: string,
    message: string,
  ): Promise<CandidateEvidenceProjectionResult> {
    const { occurredAt } = this.dependencies.clock.now();
    parseTimestamp(occurredAt, "candidate evidence fault occurredAt");
    const eventId = `candidate-evidence-fault:${order.id}:${code}`;
    const existingEvents = await this.dependencies.repositories.listOrderEvents(order.id);
    if (!existingEvents.some((event) => event.id === eventId)) {
      await this.dependencies.repositories.appendOrderEvent({
        id: eventId,
        orderId: order.id,
        eventType: "CANDIDATE_EVIDENCE_PROJECTION_FAILED",
        eventSource: "RECONCILIATION",
        payloadJson: JSON.stringify({ code, message }),
        createdAt: occurredAt,
      });
    }
    await this.dependencies.operatorState.pauseForFault({
      exchangeAccountId: order.exchangeAccountId,
      faultId: eventId,
      reason: `${code}: ${message}`,
      occurredAt,
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
      return {
        outcome: "DUPLICATE",
        orderId: order.id,
        detail: "Terminal no-fill cancellation was already recorded.",
      };
    }
    const { occurredAt } = this.dependencies.clock.now();
    parseTimestamp(occurredAt, "candidate no-fill occurredAt");
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
      createdAt: occurredAt,
    });
    return {
      outcome: "TERMINAL_NO_FILL",
      orderId: order.id,
      detail: "Terminal no-fill cancellation was recorded without candidate state advancement.",
    };
  }

  private async hasTerminalNoFillMarker(order: OrderRecord): Promise<boolean> {
    const eventId = `candidate-evidence-no-fill:${order.id}`;
    const existingEvents = await this.dependencies.repositories.listOrderEvents(order.id);
    return existingEvents.some((event) => event.id === eventId);
  }
}

type CandidateAction = Extract<StrategyDecisionRecord["action"], "ENTER" | "ADD" | "REDUCE" | "EXIT">;

interface VerifiedDecision {
  action: CandidateAction;
  entryPath: StrategyEntryPath;
  decision: StrategyDecisionRecord;
  decisionAt: bigint;
  requestedAt: bigint;
  updatedAt: bigint;
}

interface ExactDecimal {
  coefficient: bigint;
  scale: number;
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
): {
  executedQuantity: ExactDecimal;
  grossQuoteValueKrw: ExactDecimal;
  confirmedFeeKrw: ExactDecimal;
} {
  let executedQuantity = zeroDecimal();
  let grossQuoteValueKrw = zeroDecimal();
  let confirmedFeeKrw = zeroDecimal();
  for (const fill of fills) {
    if (fill.orderId !== order.id || fill.market !== order.market || fill.side !== order.side) {
      throw new CandidateEvidenceFault("FILL_ORDER_MISMATCH", "Persisted fill does not match terminal order identity.");
    }
    const filledAt = parseTimestamp(fill.filledAt, "fill filledAt");
    if (filledAt < decision.requestedAt || filledAt > decision.updatedAt) {
      throw new CandidateEvidenceFault("FILL_TIMESTAMP_INVALID", "Persisted fill timestamp is outside the terminal order lifecycle.");
    }
    if (fill.feeCurrency !== "KRW" || fill.feeAmount === null) {
      throw new CandidateEvidenceFault("MISSING_FEE_EVIDENCE", "Every terminal fill requires confirmed KRW fee evidence.");
    }
    const volume = parsePositiveDecimal(fill.volume, "fill volume");
    const price = parsePositiveDecimal(fill.price, "fill price");
    const fee = parseNonNegativeDecimal(fill.feeAmount, "fill feeAmount");
    executedQuantity = addDecimals(executedQuantity, volume);
    grossQuoteValueKrw = addDecimals(grossQuoteValueKrw, multiplyDecimals(price, volume));
    confirmedFeeKrw = addDecimals(confirmedFeeKrw, fee);
  }

  if (order.volume !== null) {
    const requestedQuantity = parsePositiveDecimal(order.volume, "order volume");
    if (compareDecimals(executedQuantity, requestedQuantity) > 0) {
      throw new CandidateEvidenceFault("ORDER_QUANTITY_INVALID", "Terminal fills exceed persisted order quantity.");
    }
  }
  if (order.side === "bid" && order.ordType === "price") {
    const quoteBudget = parsePositiveDecimal(order.price ?? "", "order price");
    if (compareDecimals(grossQuoteValueKrw, quoteBudget) > 0) {
      throw new CandidateEvidenceFault("ORDER_QUANTITY_INVALID", "Terminal bid fills exceed persisted quote budget.");
    }
  }
  return { executedQuantity, grossQuoteValueKrw, confirmedFeeKrw };
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
  if (
    strategyDecision?.market !== decision.market ||
    strategyDecision.action !== decision.action ||
    !isEntryPath(entryPath)
  ) {
    throw new CandidateEvidenceFault("STRATEGY_DECISION_INVALID", "Strategy decision basis does not match persisted decision provenance.");
  }
  return { entryPath };
}

function assertMatchingExistingEvidence(
  existing: Readonly<PositionGuardCandidateExecutionEvidence>,
  expected: Omit<PositionGuardCandidateExecutionEvidence, "remainingQuantity" | "executedQuantity" | "grossQuoteValueKrw" | "confirmedFeeKrw"> & {
    executedQuantity: PositionGuardCandidateDecimal;
    grossQuoteValueKrw: PositionGuardCandidateDecimal;
    confirmedFeeKrw: PositionGuardCandidateDecimal;
  },
): void {
  if (
    existing.executedAt !== expected.executedAt ||
    existing.action !== expected.action ||
    existing.entryPath !== expected.entryPath ||
    existing.terminalStatus !== expected.terminalStatus ||
    decimalText(existing.executedQuantity) !== decimalText(expected.executedQuantity) ||
    decimalText(existing.grossQuoteValueKrw) !== decimalText(expected.grossQuoteValueKrw) ||
    decimalText(existing.confirmedFeeKrw) !== decimalText(expected.confirmedFeeKrw)
  ) {
    throw new CandidateEvidenceFault("CONFLICTING_TERMINAL_EVIDENCE", "Persisted candidate evidence conflicts with terminal order evidence.");
  }
}

function deriveRemainingQuantity(
  currentQuantity: number,
  action: CandidateAction,
  executedQuantity: ExactDecimal,
): ExactDecimal {
  const current = parseNonNegativeDecimal(String(currentQuantity), "candidate state inventory quantity");
  if (action === "ENTER" || action === "ADD") {
    return addDecimals(current, executedQuantity);
  }
  if (compareDecimals(executedQuantity, current) > 0) {
    throw new CandidateEvidenceFault("ORDER_QUANTITY_INVALID", "Terminal sell evidence exceeds candidate inventory.");
  }
  return subtractDecimals(current, executedQuantity);
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

function parsePositiveDecimal(value: string, label: string): ExactDecimal {
  const parsed = parseNonNegativeDecimal(value, label);
  if (parsed.coefficient === 0n) {
    throw new CandidateEvidenceFault("DECIMAL_INVALID", `${label} must be positive.`);
  }
  return parsed;
}

function parseNonNegativeDecimal(value: string, label: string): ExactDecimal {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    throw new CandidateEvidenceFault("DECIMAL_INVALID", `${label} must be a non-negative decimal string.`);
  }
  const [whole, fractional = ""] = value.split(".");
  const coefficient = BigInt(`${whole}${fractional}`);
  return normalizeDecimal({ coefficient, scale: fractional.length });
}

function zeroDecimal(): ExactDecimal {
  return { coefficient: 0n, scale: 0 };
}

function normalizeDecimal(value: ExactDecimal): ExactDecimal {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function addDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeDecimal({
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) +
      right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  });
}

function subtractDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeDecimal({
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) -
      right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  });
}

function multiplyDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return normalizeDecimal({
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  });
}

function compareDecimals(left: ExactDecimal, right: ExactDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient = right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

function formatDecimal(value: ExactDecimal): string {
  const digits = value.coefficient.toString();
  if (value.scale === 0) return digits;
  const padded = digits.padStart(value.scale + 1, "0");
  return `${padded.slice(0, -value.scale)}.${padded.slice(-value.scale)}`;
}

function decimalText(value: PositionGuardCandidateDecimal): string {
  return typeof value === "string" ? value : String(value);
}
