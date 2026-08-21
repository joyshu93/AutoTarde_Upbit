import type { StrategyDecisionAction } from "../../domain/types.js";
import type { StrategyEntryPath } from "./position-guard-core.js";

export const POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE = 1e-12;

export interface PositionGuardCandidateState {
  currentEpisodeAddCount: number;
  currentEpisodeCostBasisKrw: number;
  currentEpisodeInventoryQuantity: number;
  currentEpisodeRealizedPnlKrw: number;
  lastFullExitAt: string | null;
  lastFullExitRealizedPnlKrw: number | null;
  lastEntryPath: StrategyEntryPath | null;
  lastEvidenceAt: string | null;
  lastEvidenceId: string | null;
  stateVersion: number;
}

export interface PositionGuardCandidateExecutionEvidence {
  evidenceId: string;
  executedAt: string;
  action: Extract<StrategyDecisionAction, "ENTER" | "ADD" | "REDUCE" | "EXIT">;
  entryPath: StrategyEntryPath;
  terminalStatus: "FILLED" | "CANCELED";
  executedQuantity: number;
  grossQuoteValueKrw: number;
  confirmedFeeKrw: number;
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
const STATE_KEYS = [
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
const EVIDENCE_KEYS = [
  "evidenceId",
  "executedAt",
  "action",
  "entryPath",
  "terminalStatus",
  "executedQuantity",
  "grossQuoteValueKrw",
  "confirmedFeeKrw",
  "remainingQuantity",
] as const;

export function createEmptyPositionGuardCandidateState(): Readonly<PositionGuardCandidateState> {
  return Object.freeze({
    currentEpisodeAddCount: 0,
    currentEpisodeCostBasisKrw: 0,
    currentEpisodeInventoryQuantity: 0,
    currentEpisodeRealizedPnlKrw: 0,
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: null,
    lastEvidenceId: null,
    stateVersion: 0,
  });
}

export function validatePositionGuardCandidateState(state: PositionGuardCandidateState): void {
  validateStateSnapshot(snapshotState(state));
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
  const stateSnapshot = snapshotState(state);
  validateStateSnapshot(stateSnapshot);
  const evidenceSnapshot = snapshotExecutionEvidence(evidence);
  validateExecutionEvidence(evidenceSnapshot);
  return advanceValidatedPositionGuardCandidateState(stateSnapshot, evidenceSnapshot);
}

export function projectPositionGuardCandidateState(input: {
  initialState: PositionGuardCandidateState;
  evidence: readonly PositionGuardCandidateExecutionEvidence[];
}): Readonly<PositionGuardCandidateState> {
  const initialState = snapshotState(input.initialState);
  validateStateSnapshot(initialState);
  const evidenceIds = new Set<string>();
  if (initialState.lastEvidenceId !== null) evidenceIds.add(initialState.lastEvidenceId);

  const ordered = input.evidence.map((item) => {
    const snapshot = snapshotExecutionEvidence(item);
    validateExecutionEvidence(snapshot);
    if (evidenceIds.has(snapshot.evidenceId)) {
      throw new Error(`Duplicate PositionGuard candidate evidenceId ${snapshot.evidenceId}.`);
    }
    evidenceIds.add(snapshot.evidenceId);
    return {
      evidence: snapshot,
      epochNanoseconds: parsePositionGuardCandidateTimestamp(snapshot.executedAt, "evidence executedAt"),
    };
  });
  ordered.sort((left, right) => {
    if (left.epochNanoseconds < right.epochNanoseconds) return -1;
    if (left.epochNanoseconds > right.epochNanoseconds) return 1;
    if (left.evidence.evidenceId < right.evidence.evidenceId) return -1;
    if (left.evidence.evidenceId > right.evidence.evidenceId) return 1;
    return 0;
  });

  let state: Readonly<PositionGuardCandidateState> = Object.freeze(cloneState(initialState));
  for (const { evidence } of ordered) {
    state = advanceValidatedPositionGuardCandidateState(state, evidence);
  }
  return state;
}

function advanceValidatedPositionGuardCandidateState(
  state: PositionGuardCandidateState,
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>,
): Readonly<PositionGuardCandidateState> {
  assertEvidenceAfterStateCursor(state, evidence);
  if (evidence.executedQuantity === 0) {
    assertNoFillEvidenceMatchesState(state, evidence);
    return Object.freeze(cloneState(state));
  }

  assertNonZeroFillLifecycle(state, evidence);
  const next = cloneState(state);
  if (isBuyAction(evidence.action)) {
    next.currentEpisodeInventoryQuantity += evidence.executedQuantity;
    next.currentEpisodeCostBasisKrw += evidence.grossQuoteValueKrw + evidence.confirmedFeeKrw;
    if (evidence.action === "ENTER") next.lastEntryPath = evidence.entryPath;
    if (evidence.action === "ADD") next.currentEpisodeAddCount += 1;
    assertResidualMatches(next.currentEpisodeInventoryQuantity, evidence.remainingQuantity, evidence.evidenceId);
  } else {
    const expectedRemaining = state.currentEpisodeInventoryQuantity - evidence.executedQuantity;
    const closesEpisode = expectedRemaining <= POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE;
    assertResidualMatches(closesEpisode ? 0 : expectedRemaining, evidence.remainingQuantity, evidence.evidenceId);
    const removedCost = closesEpisode
      ? state.currentEpisodeCostBasisKrw
      : state.currentEpisodeCostBasisKrw * (evidence.executedQuantity / state.currentEpisodeInventoryQuantity);
    const realizedPnl = state.currentEpisodeRealizedPnlKrw +
      evidence.grossQuoteValueKrw - evidence.confirmedFeeKrw - removedCost;

    if (closesEpisode) {
      next.currentEpisodeAddCount = 0;
      next.currentEpisodeCostBasisKrw = 0;
      next.currentEpisodeInventoryQuantity = 0;
      next.currentEpisodeRealizedPnlKrw = 0;
      next.lastFullExitAt = evidence.executedAt;
      next.lastFullExitRealizedPnlKrw = realizedPnl;
    } else {
      next.currentEpisodeCostBasisKrw -= removedCost;
      next.currentEpisodeInventoryQuantity = expectedRemaining;
      next.currentEpisodeRealizedPnlKrw = realizedPnl;
    }
  }

  next.lastEvidenceAt = evidence.executedAt;
  next.lastEvidenceId = evidence.evidenceId;
  next.stateVersion += 1;
  validateStateSnapshot(next);
  return Object.freeze(next);
}

function snapshotState(value: PositionGuardCandidateState): PositionGuardCandidateState {
  const record = exactOwnDataRecord(value, "state", STATE_KEYS);
  return {
    currentEpisodeAddCount: record.currentEpisodeAddCount as number,
    currentEpisodeCostBasisKrw: record.currentEpisodeCostBasisKrw as number,
    currentEpisodeInventoryQuantity: record.currentEpisodeInventoryQuantity as number,
    currentEpisodeRealizedPnlKrw: record.currentEpisodeRealizedPnlKrw as number,
    lastFullExitAt: record.lastFullExitAt as string | null,
    lastFullExitRealizedPnlKrw: record.lastFullExitRealizedPnlKrw as number | null,
    lastEntryPath: record.lastEntryPath as StrategyEntryPath | null,
    lastEvidenceAt: record.lastEvidenceAt as string | null,
    lastEvidenceId: record.lastEvidenceId as string | null,
    stateVersion: record.stateVersion as number,
  };
}

function snapshotExecutionEvidence(
  value: PositionGuardCandidateExecutionEvidence,
): Readonly<PositionGuardCandidateExecutionEvidence> {
  const record = exactOwnDataRecord(value, "execution evidence", EVIDENCE_KEYS);
  return Object.freeze({
    evidenceId: record.evidenceId as string,
    executedAt: record.executedAt as string,
    action: record.action as PositionGuardCandidateExecutionEvidence["action"],
    entryPath: record.entryPath as StrategyEntryPath,
    terminalStatus: record.terminalStatus as PositionGuardCandidateExecutionEvidence["terminalStatus"],
    executedQuantity: record.executedQuantity as number,
    grossQuoteValueKrw: record.grossQuoteValueKrw as number,
    confirmedFeeKrw: record.confirmedFeeKrw as number,
    remainingQuantity: record.remainingQuantity as number,
  });
}

function validateStateSnapshot(state: PositionGuardCandidateState): void {
  if (!Number.isInteger(state.currentEpisodeAddCount) || state.currentEpisodeAddCount < 0) {
    throw new Error("PositionGuard candidate state currentEpisodeAddCount must be a non-negative integer.");
  }
  if (!Number.isFinite(state.currentEpisodeInventoryQuantity) || state.currentEpisodeInventoryQuantity < 0) {
    throw new Error("PositionGuard candidate state currentEpisodeInventoryQuantity must be finite and non-negative.");
  }
  if (!Number.isFinite(state.currentEpisodeCostBasisKrw) || state.currentEpisodeCostBasisKrw < 0) {
    throw new Error("PositionGuard candidate state currentEpisodeCostBasisKrw must be finite and non-negative.");
  }
  if (!Number.isFinite(state.currentEpisodeRealizedPnlKrw)) {
    throw new Error("PositionGuard candidate state currentEpisodeRealizedPnlKrw must be finite.");
  }
  if (!Number.isSafeInteger(state.stateVersion) || state.stateVersion < 0) {
    throw new Error("PositionGuard candidate state stateVersion must be a non-negative safe integer.");
  }
  if (state.lastEntryPath !== null && !STRATEGY_ENTRY_PATHS.includes(state.lastEntryPath)) {
    throw new Error("PositionGuard candidate state lastEntryPath is invalid.");
  }
  validateFullExitMetadata(state);
  validateCursor(state);

  if (state.currentEpisodeInventoryQuantity <= POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE) {
    if (state.currentEpisodeInventoryQuantity !== 0) {
      throw new Error("Flat PositionGuard candidate state must normalize inventory quantity to zero.");
    }
    if (
      state.currentEpisodeCostBasisKrw !== 0 ||
      state.currentEpisodeAddCount !== 0 ||
      state.currentEpisodeRealizedPnlKrw !== 0
    ) {
      throw new Error("Flat PositionGuard candidate state must have zero cost basis, add count, and realized PnL.");
    }
    if (state.lastEvidenceAt !== null && state.lastFullExitAt === null) {
      throw new Error("Flat PositionGuard candidate state with a cursor requires full-exit metadata.");
    }
  } else if (state.currentEpisodeCostBasisKrw <= 0 || state.lastEntryPath === null) {
    throw new Error("Open PositionGuard candidate state requires positive cost basis and entry path.");
  }
  if (state.stateVersion < minimumReachableStateVersion(state)) {
    throw new Error("PositionGuard candidate state stateVersion is below the minimum implied by its persisted episode state.");
  }
}

function minimumReachableStateVersion(state: PositionGuardCandidateState): number {
  let minimum = state.lastFullExitAt === null ? 0 : 2;
  if (state.currentEpisodeInventoryQuantity > POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE) {
    minimum += 1 + state.currentEpisodeAddCount;
    if (state.currentEpisodeRealizedPnlKrw !== 0) minimum += 1;
  }
  return minimum;
}

function validateFullExitMetadata(state: PositionGuardCandidateState): void {
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
}

function validateCursor(state: PositionGuardCandidateState): void {
  const evidenceAt = state.lastEvidenceAt;
  const evidenceId = state.lastEvidenceId;
  const hasEvidenceAt = typeof evidenceAt === "string";
  const hasEvidenceId = typeof evidenceId === "string";
  if (evidenceAt !== null && !hasEvidenceAt) {
    throw new Error("PositionGuard candidate state lastEvidenceAt must be a string or null.");
  }
  if (evidenceId !== null && (!hasEvidenceId || evidenceId.trim() === "")) {
    throw new Error("PositionGuard candidate state lastEvidenceId must be a non-empty string or null.");
  }
  if (hasEvidenceAt !== hasEvidenceId) {
    throw new Error("PositionGuard candidate state cursor metadata must be either both null or both non-null.");
  }
  if (!hasEvidenceAt) {
    if (!isPristineCandidateState(state)) {
      throw new Error("PositionGuard candidate state may use a null cursor only when the state is empty.");
    }
    return;
  }
  parsePositionGuardCandidateTimestamp(evidenceAt, "state lastEvidenceAt");
  if (state.stateVersion === 0) {
    throw new Error("PositionGuard candidate state with a cursor must have a positive stateVersion.");
  }
  if (state.lastFullExitAt !== null &&
    parsePositionGuardCandidateTimestamp(state.lastFullExitAt, "state lastFullExitAt") >
      parsePositionGuardCandidateTimestamp(evidenceAt, "state lastEvidenceAt")) {
    throw new Error("PositionGuard candidate state full-exit metadata cannot be after its chronology cursor.");
  }
}

function validateExecutionEvidence(evidence: Readonly<PositionGuardCandidateExecutionEvidence>): void {
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
  if (evidence.terminalStatus !== "FILLED" && evidence.terminalStatus !== "CANCELED") {
    throw new Error("PositionGuard candidate evidence terminal lifecycle status is invalid.");
  }
  for (const [field, value] of [
    ["executedQuantity", evidence.executedQuantity],
    ["grossQuoteValueKrw", evidence.grossQuoteValueKrw],
    ["confirmedFeeKrw", evidence.confirmedFeeKrw],
    ["remainingQuantity", evidence.remainingQuantity],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`PositionGuard candidate evidence ${field} must be finite and non-negative.`);
    }
  }
  if (evidence.executedQuantity === 0) {
    if (evidence.terminalStatus !== "CANCELED") {
      throw new Error("Terminal no-fill PositionGuard candidate evidence must be CANCELED.");
    }
    if (evidence.grossQuoteValueKrw !== 0 || evidence.confirmedFeeKrw !== 0) {
      throw new Error("Terminal no-fill PositionGuard candidate evidence must have zero value and fee.");
    }
    return;
  }
  if (evidence.grossQuoteValueKrw <= 0) {
    throw new Error("PositionGuard candidate evidence must have a positive quote value for a non-zero fill.");
  }
  if (!Number.isFinite(evidence.grossQuoteValueKrw / evidence.executedQuantity)) {
    throw new Error("PositionGuard candidate evidence implied execution price must be finite.");
  }
}

function assertNoFillEvidenceMatchesState(
  state: PositionGuardCandidateState,
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>,
): void {
  assertResidualMatches(state.currentEpisodeInventoryQuantity, evidence.remainingQuantity, evidence.evidenceId);
}

function assertNonZeroFillLifecycle(
  state: PositionGuardCandidateState,
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>,
): void {
  if (isBuyAction(evidence.action)) {
    if (evidence.action === "ENTER" && state.currentEpisodeInventoryQuantity !== 0) {
      throw new Error("PositionGuard candidate ENTER evidence requires a flat episode.");
    }
    if (evidence.action === "ADD" && state.currentEpisodeInventoryQuantity <= POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE) {
      throw new Error("PositionGuard candidate ADD evidence requires an open episode.");
    }
    return;
  }
  if (state.currentEpisodeInventoryQuantity <= POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE) {
    throw new Error("PositionGuard candidate sell evidence requires an open episode.");
  }
  if (evidence.executedQuantity > state.currentEpisodeInventoryQuantity + POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE) {
    throw new Error("PositionGuard candidate sell evidence exceeds episode inventory.");
  }
}

function assertResidualMatches(expected: number, actual: number, evidenceId: string): void {
  if (Math.abs(expected - actual) > POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE) {
    throw new Error(`PositionGuard candidate evidence ${evidenceId} remainingQuantity contradicts the episode residual.`);
  }
}

function assertEvidenceAfterStateCursor(
  state: PositionGuardCandidateState,
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>,
): void {
  if (state.lastEvidenceAt === null) return;
  const cursorEpoch = parsePositionGuardCandidateTimestamp(state.lastEvidenceAt, "state lastEvidenceAt");
  const evidenceEpoch = parsePositionGuardCandidateTimestamp(evidence.executedAt, "evidence executedAt");
  if (
    evidenceEpoch < cursorEpoch ||
    (evidenceEpoch === cursorEpoch && evidence.evidenceId <= state.lastEvidenceId!)
  ) {
    throw new Error(
      "PositionGuard candidate evidence must be ordered after the state chronology cursor by epoch nanoseconds and evidenceId.",
    );
  }
}

function exactOwnDataRecord<Keys extends readonly string[]>(
  value: unknown,
  label: string,
  keys: Keys,
): Record<Keys[number], unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`PositionGuard candidate ${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`PositionGuard candidate ${label} must be a plain object with own data properties.`);
  }
  const names = Object.getOwnPropertyNames(value);
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    throw new Error(`PositionGuard candidate ${label} must not contain symbol keys.`);
  }
  if (names.length !== keys.length || names.some((name) => !keys.includes(name))) {
    throw new Error(`PositionGuard candidate ${label} must contain exactly the required own data properties.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Error(`PositionGuard candidate ${label} ${key} must be an own data property.`);
    }
    record[key] = descriptor.value;
  }
  return record as Record<Keys[number], unknown>;
}

function cloneState(state: PositionGuardCandidateState): PositionGuardCandidateState {
  return {
    currentEpisodeAddCount: state.currentEpisodeAddCount,
    currentEpisodeCostBasisKrw: state.currentEpisodeCostBasisKrw,
    currentEpisodeInventoryQuantity: state.currentEpisodeInventoryQuantity,
    currentEpisodeRealizedPnlKrw: state.currentEpisodeRealizedPnlKrw,
    lastFullExitAt: state.lastFullExitAt,
    lastFullExitRealizedPnlKrw: state.lastFullExitRealizedPnlKrw,
    lastEntryPath: state.lastEntryPath,
    lastEvidenceAt: state.lastEvidenceAt,
    lastEvidenceId: state.lastEvidenceId,
    stateVersion: state.stateVersion,
  };
}

function isPristineCandidateState(state: PositionGuardCandidateState): boolean {
  return state.currentEpisodeAddCount === 0 &&
    state.currentEpisodeCostBasisKrw === 0 &&
    state.currentEpisodeInventoryQuantity === 0 &&
    state.currentEpisodeRealizedPnlKrw === 0 &&
    state.lastFullExitAt === null &&
    state.lastFullExitRealizedPnlKrw === null &&
    state.lastEntryPath === null &&
    state.stateVersion === 0;
}

function isBuyAction(action: PositionGuardCandidateExecutionEvidence["action"]): boolean {
  return action === "ENTER" || action === "ADD";
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
