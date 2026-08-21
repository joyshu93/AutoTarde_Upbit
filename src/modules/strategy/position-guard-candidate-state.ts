import type { StrategyDecisionAction } from "../../domain/types.js";
import type { StrategyEntryPath } from "./position-guard-core.js";

export const POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE = 1e-12;

export interface PositionGuardCandidateState {
  currentEpisodeAddCount: number;
  currentEpisodeCostBasisKrw?: number;
  currentEpisodeInventoryQuantity?: number;
  currentEpisodeRealizedPnlKrw: number;
  lastFullExitAt: string | null;
  lastFullExitRealizedPnlKrw: number | null;
  lastEntryPath: StrategyEntryPath | null;
  lastEvidenceAt: string | null;
  lastEvidenceId: string | null;
  stateVersion?: number;
}

export interface PositionGuardCandidateExecutionEvidence {
  evidenceId: string;
  executedAt: string;
  action: Extract<StrategyDecisionAction, "ENTER" | "ADD" | "REDUCE" | "EXIT">;
  entryPath: StrategyEntryPath;
  terminalStatus?: "FILLED" | "CANCELED";
  executedQuantity?: number;
  grossQuoteValueKrw?: number;
  confirmedFeeKrw?: number;
  remainingQuantity: number;
  realizedPnlKrw?: number | null;
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
  if (state === null || typeof state !== "object") {
    throw new Error("PositionGuard candidate state must be an object.");
  }
  if (!Number.isInteger(state.currentEpisodeAddCount) || state.currentEpisodeAddCount < 0) {
    throw new Error("PositionGuard candidate state currentEpisodeAddCount must be a non-negative integer.");
  }
  if (!Number.isFinite(state.currentEpisodeRealizedPnlKrw)) {
    throw new Error("PositionGuard candidate state currentEpisodeRealizedPnlKrw must be finite.");
  }
  validateFullExitMetadata(state);
  validateEntryPath(state);
  validateCursor(state);

  if (hasAnyFeeInclusiveStateField(state)) {
    validateFeeInclusiveState(state);
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
  const evidenceKind = validateExecutionEvidence(evidence);
  assertEvidenceAfterStateCursor(state, evidence);

  if (evidenceKind === "LEGACY") {
    if (hasAnyFeeInclusiveStateField(state)) {
      throw new Error("Legacy PositionGuard candidate evidence cannot advance a fee-inclusive state.");
    }
    return advanceLegacyState(state, evidence);
  }
  if (!hasCompleteFeeInclusiveState(state)) {
    throw new Error("Fee-inclusive PositionGuard candidate evidence requires inventory, cost basis, and stateVersion.");
  }
  return advanceFeeInclusiveState(state, evidence);
}

export function projectPositionGuardCandidateState(input: {
  initialState: PositionGuardCandidateState;
  evidence: readonly PositionGuardCandidateExecutionEvidence[];
}): Readonly<PositionGuardCandidateState> {
  validatePositionGuardCandidateState(input.initialState);
  const evidenceIds = new Set<string>();
  if (input.initialState.lastEvidenceId !== null) {
    evidenceIds.add(input.initialState.lastEvidenceId);
  }

  const ordered = input.evidence.map((item) => {
    const kind = validateExecutionEvidence(item);
    if (evidenceIds.has(item.evidenceId)) {
      throw new Error(`Duplicate PositionGuard candidate evidenceId ${item.evidenceId}.`);
    }
    evidenceIds.add(item.evidenceId);
    return { item, kind, epochNanoseconds: parsePositionGuardCandidateTimestamp(item.executedAt, "evidence executedAt") };
  });
  ordered.sort((left, right) => {
    if (left.epochNanoseconds < right.epochNanoseconds) return -1;
    if (left.epochNanoseconds > right.epochNanoseconds) return 1;
    if (left.item.evidenceId < right.item.evidenceId) return -1;
    if (left.item.evidenceId > right.item.evidenceId) return 1;
    return 0;
  });

  let state: Readonly<PositionGuardCandidateState> = Object.freeze(cloneState(input.initialState));
  for (const { item, kind } of ordered) {
    if (kind === "LEGACY" && hasAnyFeeInclusiveStateField(state)) {
      throw new Error("Legacy PositionGuard candidate evidence cannot advance a fee-inclusive state.");
    }
    if (kind === "FEE_INCLUSIVE" && !hasCompleteFeeInclusiveState(state)) {
      throw new Error("Fee-inclusive PositionGuard candidate evidence requires inventory, cost basis, and stateVersion.");
    }
    state = advancePositionGuardCandidateState(state, item);
  }
  return state;
}

function advanceFeeInclusiveState(
  state: PositionGuardCandidateState,
  evidence: PositionGuardCandidateExecutionEvidence,
): Readonly<PositionGuardCandidateState> {
  const executedQuantity = evidence.executedQuantity!;
  const grossQuoteValueKrw = evidence.grossQuoteValueKrw!;
  const confirmedFeeKrw = evidence.confirmedFeeKrw!;
  const inventory = state.currentEpisodeInventoryQuantity!;
  const costBasis = state.currentEpisodeCostBasisKrw!;

  if (executedQuantity === 0) {
    assertNoFillEvidenceMatchesState(state, evidence);
    return state as Readonly<PositionGuardCandidateState>;
  }
  assertNonZeroFillLifecycle(state, evidence);

  const next = cloneState(state) as RequiredFeeInclusiveCandidateState;
  if (isBuyAction(evidence.action)) {
    next.currentEpisodeInventoryQuantity = inventory + executedQuantity;
    next.currentEpisodeCostBasisKrw = costBasis + grossQuoteValueKrw + confirmedFeeKrw;
    next.currentEpisodeRealizedPnlKrw = state.currentEpisodeRealizedPnlKrw;
    if (evidence.action === "ENTER") next.lastEntryPath = evidence.entryPath;
    if (evidence.action === "ADD") next.currentEpisodeAddCount += 1;
    assertResidualMatches(next.currentEpisodeInventoryQuantity, evidence.remainingQuantity, evidence.evidenceId);
  } else {
    const expectedRemaining = inventory - executedQuantity;
    const closesEpisode = expectedRemaining <= POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE;
    assertResidualMatches(closesEpisode ? 0 : expectedRemaining, evidence.remainingQuantity, evidence.evidenceId);
    const removedCost = closesEpisode ? costBasis : costBasis * (executedQuantity / inventory);
    const realizedPnl = state.currentEpisodeRealizedPnlKrw + grossQuoteValueKrw - confirmedFeeKrw - removedCost;

    if (closesEpisode) {
      next.currentEpisodeAddCount = 0;
      next.currentEpisodeCostBasisKrw = 0;
      next.currentEpisodeInventoryQuantity = 0;
      next.currentEpisodeRealizedPnlKrw = 0;
      next.lastFullExitAt = evidence.executedAt;
      next.lastFullExitRealizedPnlKrw = realizedPnl;
    } else {
      next.currentEpisodeCostBasisKrw = costBasis - removedCost;
      next.currentEpisodeInventoryQuantity = expectedRemaining;
      next.currentEpisodeRealizedPnlKrw = realizedPnl;
    }
  }

  next.lastEvidenceAt = evidence.executedAt;
  next.lastEvidenceId = evidence.evidenceId;
  next.stateVersion += 1;
  validatePositionGuardCandidateState(next);
  return Object.freeze(next);
}

function advanceLegacyState(
  state: PositionGuardCandidateState,
  evidence: PositionGuardCandidateExecutionEvidence,
): Readonly<PositionGuardCandidateState> {
  const next = cloneState(state);
  if (evidence.action === "ENTER") next.lastEntryPath = evidence.entryPath;
  if (evidence.action === "ADD") next.currentEpisodeAddCount += 1;
  if (evidence.action === "REDUCE" || evidence.action === "EXIT") {
    next.currentEpisodeRealizedPnlKrw = roundLegacyMoney(
      next.currentEpisodeRealizedPnlKrw + evidence.realizedPnlKrw!,
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

function validateExecutionEvidence(
  evidence: PositionGuardCandidateExecutionEvidence,
): "FEE_INCLUSIVE" | "LEGACY" {
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
  if (!Number.isFinite(evidence.remainingQuantity) || evidence.remainingQuantity < 0) {
    throw new Error("PositionGuard candidate evidence remainingQuantity must be finite and non-negative.");
  }

  if (!hasAnyFeeInclusiveEvidenceField(evidence)) {
    if (evidence.terminalStatus !== undefined) {
      throw new Error("Legacy PositionGuard candidate evidence cannot declare a terminal lifecycle status.");
    }
    if (evidence.realizedPnlKrw !== null && !Number.isFinite(evidence.realizedPnlKrw)) {
      throw new Error("PositionGuard candidate evidence realizedPnlKrw must be finite or null.");
    }
    if ((evidence.action === "REDUCE" || evidence.action === "EXIT") && evidence.realizedPnlKrw === null) {
      throw new Error(`PositionGuard candidate evidence ${evidence.evidenceId} realizedPnlKrw is required for ${evidence.action}.`);
    }
    return "LEGACY";
  }

  if (
    evidence.terminalStatus === undefined ||
    evidence.executedQuantity === undefined ||
    evidence.grossQuoteValueKrw === undefined ||
    evidence.confirmedFeeKrw === undefined
  ) {
    throw new Error("Fee-inclusive PositionGuard candidate evidence must include terminal status, quantity, value, and confirmed fee.");
  }
  if (!Number.isFinite(evidence.executedQuantity) || evidence.executedQuantity < 0) {
    throw new Error("PositionGuard candidate evidence executedQuantity must be finite and non-negative.");
  }
  if (!Number.isFinite(evidence.grossQuoteValueKrw) || evidence.grossQuoteValueKrw < 0) {
    throw new Error("PositionGuard candidate evidence grossQuoteValueKrw must be finite and non-negative.");
  }
  if (!Number.isFinite(evidence.confirmedFeeKrw) || evidence.confirmedFeeKrw < 0) {
    throw new Error("PositionGuard candidate evidence confirmedFeeKrw must be finite and non-negative.");
  }
  if (evidence.terminalStatus !== "FILLED" && evidence.terminalStatus !== "CANCELED") {
    throw new Error("PositionGuard candidate evidence terminal lifecycle status is invalid.");
  }
  if (evidence.executedQuantity === 0) {
    if (evidence.terminalStatus !== "CANCELED") {
      throw new Error("Terminal no-fill PositionGuard candidate evidence must be CANCELED.");
    }
    if (evidence.grossQuoteValueKrw !== 0 || evidence.confirmedFeeKrw !== 0) {
      throw new Error("Terminal no-fill PositionGuard candidate evidence must have zero value and fee.");
    }
  } else {
    if (evidence.grossQuoteValueKrw <= 0) {
      throw new Error("PositionGuard candidate evidence must have a positive quote value for a non-zero fill.");
    }
    if (!Number.isFinite(evidence.grossQuoteValueKrw / evidence.executedQuantity)) {
      throw new Error("PositionGuard candidate evidence implied execution price must be finite.");
    }
  }
  return "FEE_INCLUSIVE";
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

function validateEntryPath(state: PositionGuardCandidateState): void {
  if (state.lastEntryPath !== null && !STRATEGY_ENTRY_PATHS.includes(state.lastEntryPath)) {
    throw new Error("PositionGuard candidate state lastEntryPath is invalid.");
  }
}

function validateCursor(state: PositionGuardCandidateState): void {
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

function validateFeeInclusiveState(state: PositionGuardCandidateState): void {
  if (!hasCompleteFeeInclusiveState(state)) {
    throw new Error("PositionGuard candidate state inventory, cost basis, and stateVersion must be present together.");
  }
  const inventory = state.currentEpisodeInventoryQuantity;
  const costBasis = state.currentEpisodeCostBasisKrw;
  const stateVersion = state.stateVersion;
  if (!Number.isFinite(inventory) || inventory < 0) {
    throw new Error("PositionGuard candidate state currentEpisodeInventoryQuantity must be finite and non-negative.");
  }
  if (!Number.isFinite(costBasis) || costBasis < 0) {
    throw new Error("PositionGuard candidate state currentEpisodeCostBasisKrw must be finite and non-negative.");
  }
  if (!Number.isSafeInteger(stateVersion) || stateVersion < 0) {
    throw new Error("PositionGuard candidate state stateVersion must be a non-negative safe integer.");
  }
  if (inventory <= POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE && costBasis !== 0) {
    throw new Error("Flat PositionGuard candidate state must have zero cost basis.");
  }
  if (inventory > POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE && (costBasis <= 0 || state.lastEntryPath === null)) {
    throw new Error("Open PositionGuard candidate state requires positive cost basis and entry path.");
  }
  if (state.lastEvidenceAt === null && stateVersion !== 0) {
    throw new Error("Cursorless PositionGuard candidate state must have stateVersion 0.");
  }
  if (state.lastEvidenceAt !== null && stateVersion === 0) {
    throw new Error("PositionGuard candidate state with a cursor must have a positive stateVersion.");
  }
}

function assertNoFillEvidenceMatchesState(
  state: PositionGuardCandidateState,
  evidence: PositionGuardCandidateExecutionEvidence,
): void {
  assertResidualMatches(state.currentEpisodeInventoryQuantity!, evidence.remainingQuantity, evidence.evidenceId);
}

function assertNonZeroFillLifecycle(
  state: PositionGuardCandidateState,
  evidence: PositionGuardCandidateExecutionEvidence,
): void {
  const inventory = state.currentEpisodeInventoryQuantity!;
  const executedQuantity = evidence.executedQuantity!;
  if (isBuyAction(evidence.action)) {
    if (evidence.action === "ENTER" && inventory > POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE) {
      throw new Error("PositionGuard candidate ENTER evidence requires a flat episode.");
    }
    if (evidence.action === "ADD" && inventory <= POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE) {
      throw new Error("PositionGuard candidate ADD evidence requires an open episode.");
    }
    return;
  }
  if (inventory <= POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE) {
    throw new Error("PositionGuard candidate sell evidence requires an open episode.");
  }
  if (executedQuantity > inventory + POSITION_GUARD_CANDIDATE_QUANTITY_TOLERANCE) {
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

function cloneState(state: PositionGuardCandidateState): PositionGuardCandidateState {
  return {
    currentEpisodeAddCount: state.currentEpisodeAddCount,
    ...(state.currentEpisodeCostBasisKrw === undefined ? {} : { currentEpisodeCostBasisKrw: state.currentEpisodeCostBasisKrw }),
    ...(state.currentEpisodeInventoryQuantity === undefined ? {} : { currentEpisodeInventoryQuantity: state.currentEpisodeInventoryQuantity }),
    currentEpisodeRealizedPnlKrw: state.currentEpisodeRealizedPnlKrw,
    lastFullExitAt: state.lastFullExitAt,
    lastFullExitRealizedPnlKrw: state.lastFullExitRealizedPnlKrw,
    lastEntryPath: state.lastEntryPath,
    lastEvidenceAt: state.lastEvidenceAt,
    lastEvidenceId: state.lastEvidenceId,
    ...(state.stateVersion === undefined ? {} : { stateVersion: state.stateVersion }),
  };
}

function isPristineCandidateState(state: PositionGuardCandidateState): boolean {
  return state.currentEpisodeAddCount === 0 &&
    state.currentEpisodeRealizedPnlKrw === 0 &&
    state.lastFullExitAt === null &&
    state.lastFullExitRealizedPnlKrw === null &&
    state.lastEntryPath === null &&
    (state.currentEpisodeInventoryQuantity === undefined || state.currentEpisodeInventoryQuantity === 0) &&
    (state.currentEpisodeCostBasisKrw === undefined || state.currentEpisodeCostBasisKrw === 0) &&
    (state.stateVersion === undefined || state.stateVersion === 0);
}

function hasAnyFeeInclusiveStateField(state: PositionGuardCandidateState): boolean {
  return state.currentEpisodeInventoryQuantity !== undefined ||
    state.currentEpisodeCostBasisKrw !== undefined ||
    state.stateVersion !== undefined;
}

function hasCompleteFeeInclusiveState(
  state: PositionGuardCandidateState,
): state is RequiredFeeInclusiveCandidateState {
  return state.currentEpisodeInventoryQuantity !== undefined &&
    state.currentEpisodeCostBasisKrw !== undefined &&
    state.stateVersion !== undefined;
}

function hasAnyFeeInclusiveEvidenceField(evidence: PositionGuardCandidateExecutionEvidence): boolean {
  return evidence.terminalStatus !== undefined ||
    evidence.executedQuantity !== undefined ||
    evidence.grossQuoteValueKrw !== undefined ||
    evidence.confirmedFeeKrw !== undefined;
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

function roundLegacyMoney(value: number): number {
  return Number(value.toFixed(6));
}

type RequiredFeeInclusiveCandidateState = PositionGuardCandidateState & Required<Pick<
  PositionGuardCandidateState,
  "currentEpisodeCostBasisKrw" | "currentEpisodeInventoryQuantity" | "stateVersion"
>>;
