import type { StrategyDecisionAction } from "../../domain/types.js";
import type { StrategyEntryPath } from "./position-guard-core.js";

export const POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE = 1e-12;

export interface PositionGuardCandidateState {
  currentEpisodeAddCount: number;
  currentEpisodeRealizedPnlKrw: number;
  lastFullExitAt: string | null;
  lastFullExitRealizedPnlKrw: number | null;
  lastEntryPath: StrategyEntryPath | null;
  lastEvidenceAt: string | null;
  lastEvidenceId: string | null;
}

export interface PositionGuardCandidateExecutionEvidence {
  evidenceId: string;
  executedAt: string;
  action: Extract<StrategyDecisionAction, "ENTER" | "ADD" | "REDUCE" | "EXIT">;
  entryPath: StrategyEntryPath;
  realizedPnlKrw: number | null;
  remainingQuantity: number;
}

const EXPLICIT_ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const STRATEGY_ENTRY_PATHS: readonly StrategyEntryPath[] = [
  "PULLBACK",
  "RECLAIM",
  "BREAKOUT_HOLD",
  "NONE",
];
const EXECUTED_ACTIONS: readonly PositionGuardCandidateExecutionEvidence["action"][] = [
  "ENTER",
  "ADD",
  "REDUCE",
  "EXIT",
];

export function createEmptyPositionGuardCandidateState(): Readonly<PositionGuardCandidateState> {
  return Object.freeze({
    currentEpisodeAddCount: 0,
    currentEpisodeRealizedPnlKrw: 0,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: null,
    lastEvidenceId: null,
  });
}

export function validatePositionGuardCandidateState(state: PositionGuardCandidateState): void {
  if (state === null || typeof state !== "object") {
    throw new Error("PositionGuard candidate state must be an object.");
  }
  if (!Number.isInteger(state.currentEpisodeAddCount) || state.currentEpisodeAddCount < 0) {
    throw new Error("PositionGuard candidate state currentEpisodeAddCount must be a non-negative integer.");
  }
  if (!Number.isFinite(state.currentEpisodeRealizedPnlKrw)) {
    throw new Error("PositionGuard candidate state currentEpisodeRealizedPnlKrw must be finite.");
  }
  if (state.lastFullExitAt !== null) {
    parsePositionGuardCandidateTimestamp(state.lastFullExitAt, "state lastFullExitAt");
  }
  if (
    state.lastFullExitRealizedPnlKrw !== null &&
    !Number.isFinite(state.lastFullExitRealizedPnlKrw)
  ) {
    throw new Error("PositionGuard candidate state lastFullExitRealizedPnlKrw must be finite or null.");
  }
  if ((state.lastFullExitAt === null) !== (state.lastFullExitRealizedPnlKrw === null)) {
    throw new Error("PositionGuard candidate state full-exit metadata must be either both null or both non-null.");
  }
  if (
    state.lastEntryPath !== null &&
    !STRATEGY_ENTRY_PATHS.includes(state.lastEntryPath)
  ) {
    throw new Error("PositionGuard candidate state lastEntryPath is invalid.");
  }
  if (state.lastEvidenceAt === undefined || state.lastEvidenceId === undefined) {
    throw new Error("PositionGuard candidate state cursor metadata must be present.");
  }
  if (state.lastEvidenceAt !== null) {
    parsePositionGuardCandidateTimestamp(state.lastEvidenceAt, "state lastEvidenceAt");
  }
  if (
    state.lastEvidenceId !== null &&
    (typeof state.lastEvidenceId !== "string" || state.lastEvidenceId.trim() === "")
  ) {
    throw new Error("PositionGuard candidate state lastEvidenceId must be a non-empty string or null.");
  }
  const hasEvidenceAt = typeof state.lastEvidenceAt === "string";
  const hasEvidenceId = typeof state.lastEvidenceId === "string";
  if (hasEvidenceAt !== hasEvidenceId) {
    throw new Error("PositionGuard candidate state cursor metadata must be either both null or both non-null.");
  }
  if (!hasEvidenceAt && !isPristineCandidateState(state)) {
    throw new Error("PositionGuard candidate state may use a null cursor only when the state is empty.");
  }
}

export function parsePositionGuardCandidateTimestamp(value: string, label: string): bigint {
  if (typeof value !== "string") {
    throw new Error(`Invalid PositionGuard candidate ${label}: expected a primitive string.`);
  }
  const match = EXPLICIT_ISO_TIMESTAMP.exec(value);
  if (!match) throw invalidTimestamp(value, label);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const timezone = match[8];
  if (
    timezone === undefined ||
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    !isValidTimezone(timezone)
  ) {
    throw invalidTimestamp(value, label);
  }

  const wholeSecond =
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${timezone}`;
  const epochMilliseconds = Date.parse(wholeSecond);
  if (!Number.isFinite(epochMilliseconds)) throw invalidTimestamp(value, label);

  const fractionNanoseconds = BigInt(fraction.padEnd(9, "0") || "0");
  return BigInt(epochMilliseconds) * NANOSECONDS_PER_MILLISECOND + fractionNanoseconds;
}

export function advancePositionGuardCandidateState(
  state: PositionGuardCandidateState,
  evidence: PositionGuardCandidateExecutionEvidence,
): Readonly<PositionGuardCandidateState> {
  validatePositionGuardCandidateState(state);
  validateExecutionEvidence(evidence);
  assertEvidenceAfterStateCursor(state, evidence);

  const next = cloneState(state);
  if (evidence.action === "ENTER") next.lastEntryPath = evidence.entryPath;
  if (evidence.action === "ADD") next.currentEpisodeAddCount += 1;
  if (evidence.action === "REDUCE" || evidence.action === "EXIT") {
    if (evidence.realizedPnlKrw === null) {
      throw new Error(`PositionGuard candidate evidence ${evidence.evidenceId} realizedPnlKrw is required for ${evidence.action}.`);
    }
    next.currentEpisodeRealizedPnlKrw = roundMoney(
      next.currentEpisodeRealizedPnlKrw + evidence.realizedPnlKrw,
    );
  }
  if (
    evidence.action === "EXIT" &&
    evidence.remainingQuantity <= POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE
  ) {
    next.currentEpisodeAddCount = 0;
    next.lastFullExitAt = evidence.executedAt;
    next.lastFullExitRealizedPnlKrw = next.currentEpisodeRealizedPnlKrw;
    next.currentEpisodeRealizedPnlKrw = 0;
  }
  next.lastEvidenceAt = evidence.executedAt;
  next.lastEvidenceId = evidence.evidenceId;

  validatePositionGuardCandidateState(next);
  return Object.freeze(next);
}

export function projectPositionGuardCandidateState(input: {
  initialState: PositionGuardCandidateState;
  evidence: readonly PositionGuardCandidateExecutionEvidence[];
}): Readonly<PositionGuardCandidateState> {
  validatePositionGuardCandidateState(input.initialState);
  let state: Readonly<PositionGuardCandidateState> = Object.freeze(cloneState(input.initialState));
  const evidenceIds = new Set<string>();
  if (state.lastEvidenceId !== null && state.lastEvidenceId !== undefined) {
    evidenceIds.add(state.lastEvidenceId);
  }

  for (const item of input.evidence) {
    validateExecutionEvidence(item);
    if (evidenceIds.has(item.evidenceId)) {
      throw new Error(`Duplicate PositionGuard candidate evidenceId ${item.evidenceId}.`);
    }

    evidenceIds.add(item.evidenceId);
    state = advancePositionGuardCandidateState(state, item);
  }

  return state;
}

function validateExecutionEvidence(evidence: PositionGuardCandidateExecutionEvidence): void {
  if (evidence === null || typeof evidence !== "object") {
    throw new Error("PositionGuard candidate execution evidence must be an object.");
  }
  if (typeof evidence.evidenceId !== "string" || evidence.evidenceId.trim() === "") {
    throw new Error("PositionGuard candidate evidenceId must be a non-empty string.");
  }
  parsePositionGuardCandidateTimestamp(evidence.executedAt, "evidence executedAt");
  if (!EXECUTED_ACTIONS.includes(evidence.action)) {
    throw new Error(`PositionGuard candidate evidence action ${String(evidence.action)} is invalid.`);
  }
  if (!STRATEGY_ENTRY_PATHS.includes(evidence.entryPath)) {
    throw new Error(`PositionGuard candidate evidence entryPath ${String(evidence.entryPath)} is invalid.`);
  }
  if (evidence.realizedPnlKrw !== null && !Number.isFinite(evidence.realizedPnlKrw)) {
    throw new Error("PositionGuard candidate evidence realizedPnlKrw must be finite or null.");
  }
  if (!Number.isFinite(evidence.remainingQuantity) || evidence.remainingQuantity < 0) {
    throw new Error("PositionGuard candidate evidence remainingQuantity must be finite and non-negative.");
  }
}

function cloneState(state: PositionGuardCandidateState): PositionGuardCandidateState {
  return {
    currentEpisodeAddCount: state.currentEpisodeAddCount,
    currentEpisodeRealizedPnlKrw: state.currentEpisodeRealizedPnlKrw,
    lastFullExitAt: state.lastFullExitAt,
    lastFullExitRealizedPnlKrw: state.lastFullExitRealizedPnlKrw,
    lastEntryPath: state.lastEntryPath,
    lastEvidenceAt: state.lastEvidenceAt,
    lastEvidenceId: state.lastEvidenceId,
  };
}

function isPristineCandidateState(state: PositionGuardCandidateState): boolean {
  return state.currentEpisodeAddCount === 0 &&
    state.currentEpisodeRealizedPnlKrw === 0 &&
    state.lastFullExitAt === null &&
    state.lastFullExitRealizedPnlKrw === null &&
    state.lastEntryPath === null;
}

function assertEvidenceAfterStateCursor(
  state: PositionGuardCandidateState,
  evidence: PositionGuardCandidateExecutionEvidence,
): void {
  if (state.lastEvidenceAt === null) return;
  const lastEvidenceId = state.lastEvidenceId;
  if (lastEvidenceId === null) {
    throw new Error("PositionGuard candidate state cursor metadata is incomplete.");
  }
  if (evidence.evidenceId === lastEvidenceId) {
    throw new Error(`Duplicate PositionGuard candidate evidenceId ${evidence.evidenceId} at the state cursor.`);
  }

  const cursorEpoch = parsePositionGuardCandidateTimestamp(state.lastEvidenceAt, "state lastEvidenceAt");
  const evidenceEpoch = parsePositionGuardCandidateTimestamp(evidence.executedAt, "evidence executedAt");
  if (
    evidenceEpoch < cursorEpoch ||
    (evidenceEpoch === cursorEpoch && evidence.evidenceId <= lastEvidenceId)
  ) {
    throw new Error(
      "PositionGuard candidate evidence must be ordered after the state chronology cursor by epoch nanoseconds and evidenceId.",
    );
  }
}

function invalidTimestamp(value: string, label: string): Error {
  return new Error(`Invalid PositionGuard candidate ${label}: ${value}`);
}

function isValidTimezone(timezone: string): boolean {
  if (timezone === "Z") return true;
  const offsetHour = Number(timezone.slice(1, 3));
  const offsetMinute = Number(timezone.slice(4, 6));
  return offsetMinute <= 59 && (offsetHour < 14 || (offsetHour === 14 && offsetMinute === 0));
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function roundMoney(value: number): number {
  return Number(value.toFixed(6));
}
