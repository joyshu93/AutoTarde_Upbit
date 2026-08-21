import {
  parsePositionGuardCandidateTimestamp,
  type PositionGuardCandidateExecutionEvidence,
} from "../strategy/position-guard-candidate-state.js";

export interface ExactCandidateState {
  currentEpisodeAddCount: number;
  currentEpisodeCostBasisKrw: string;
  currentEpisodeInventoryQuantity: string;
  currentEpisodeRealizedPnlKrw: string;
  lastFullExitAt: string | null;
  lastFullExitRealizedPnlKrw: string | null;
  lastEntryPath: PositionGuardCandidateExecutionEvidence["entryPath"] | null;
  lastEvidenceAt: string | null;
  lastEvidenceId: string | null;
  stateVersion: number;
}

export interface ExactDecimal {
  coefficient: bigint;
  scale: number;
}

const CANONICAL_NON_NEGATIVE = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u;
const CANONICAL_SIGNED = /^(?:0|[1-9]\d*(?:\.\d*[1-9])?|-?[1-9]\d*(?:\.\d*[1-9])?)$/u;
export const EXACT_CANDIDATE_QUANTITY_TOLERANCE = "0.000000000001";
const QUANTITY_TOLERANCE = parseCanonicalNonNegativeDecimal(
  EXACT_CANDIDATE_QUANTITY_TOLERANCE,
  "candidate quantity tolerance",
);

export function createExactEmptyCandidateState(): Readonly<ExactCandidateState> {
  return Object.freeze({
    currentEpisodeAddCount: 0,
    currentEpisodeCostBasisKrw: "0",
    currentEpisodeInventoryQuantity: "0",
    currentEpisodeRealizedPnlKrw: "0",
    lastFullExitAt: null,
    lastFullExitRealizedPnlKrw: null,
    lastEntryPath: null,
    lastEvidenceAt: null,
    lastEvidenceId: null,
    stateVersion: 0,
  });
}

export function parseCandidateEvidenceTimestamp(value: string, label: string): bigint {
  return parsePositionGuardCandidateTimestamp(value, label);
}

export function parseCanonicalNonNegativeDecimal(value: unknown, label: string): ExactDecimal {
  if (typeof value !== "string" || !CANONICAL_NON_NEGATIVE.test(value)) {
    throw new Error(`${label} must be a canonical non-negative decimal string.`);
  }
  return parseCanonicalDecimal(value, label);
}

export function parseCanonicalSignedDecimal(value: unknown, label: string): ExactDecimal {
  if (typeof value !== "string" || !CANONICAL_SIGNED.test(value)) {
    throw new Error(`${label} must be a canonical signed decimal string.`);
  }
  return parseCanonicalDecimal(value, label);
}

export function canonicalNonNegativeDecimal(value: unknown, label: string): string {
  return formatExactDecimal(parseCanonicalNonNegativeDecimal(value, label));
}

export function canonicalSignedDecimal(value: unknown, label: string): string {
  return formatExactDecimal(parseCanonicalSignedDecimal(value, label));
}

export function compareExactDecimals(left: ExactDecimal, right: ExactDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient = right.coefficient * 10n ** BigInt(scale - right.scale);
  return leftCoefficient < rightCoefficient ? -1 : leftCoefficient > rightCoefficient ? 1 : 0;
}

export function addExactDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeExactDecimal({
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) +
      right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  });
}

export function subtractExactDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  return normalizeExactDecimal({
    coefficient:
      left.coefficient * 10n ** BigInt(scale - left.scale) -
      right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  });
}

export function multiplyExactDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return normalizeExactDecimal({
    coefficient: left.coefficient * right.coefficient,
    scale: left.scale + right.scale,
  });
}

export function divideExactDecimals(left: ExactDecimal, right: ExactDecimal, label: string): ExactDecimal {
  if (right.coefficient === 0n) {
    throw new Error(`${label} cannot divide by zero.`);
  }
  let numerator = left.coefficient;
  let denominator = right.coefficient;
  const scaleDelta = right.scale - left.scale;
  if (scaleDelta >= 0) {
    numerator *= 10n ** BigInt(scaleDelta);
  } else {
    denominator *= 10n ** BigInt(-scaleDelta);
  }
  const divisor = greatestCommonDivisor(abs(numerator), abs(denominator));
  numerator /= divisor;
  denominator /= divisor;

  let twos = 0;
  let fives = 0;
  while (denominator % 2n === 0n) {
    denominator /= 2n;
    twos += 1;
  }
  while (denominator % 5n === 0n) {
    denominator /= 5n;
    fives += 1;
  }
  if (denominator !== 1n && denominator !== -1n) {
    throw new Error(`${label} does not have a terminating exact decimal representation.`);
  }
  const scale = Math.max(twos, fives);
  if (twos < scale) numerator *= 2n ** BigInt(scale - twos);
  if (fives < scale) numerator *= 5n ** BigInt(scale - fives);
  return normalizeExactDecimal({ coefficient: numerator, scale });
}

export function formatExactDecimal(value: ExactDecimal): string {
  const normalized = normalizeExactDecimal(value);
  const sign = normalized.coefficient < 0n ? "-" : "";
  const digits = abs(normalized.coefficient).toString();
  if (normalized.scale === 0) return `${sign}${digits}`;
  const padded = digits.padStart(normalized.scale + 1, "0");
  return `${sign}${padded.slice(0, -normalized.scale)}.${padded.slice(-normalized.scale)}`;
}

export function deriveExactRemainingQuantity(input: {
  currentQuantity: string;
  action: PositionGuardCandidateExecutionEvidence["action"];
  executedQuantity: string;
}): string {
  const current = parseCanonicalNonNegativeDecimal(input.currentQuantity, "candidate exact inventory quantity");
  const executed = parseCanonicalNonNegativeDecimal(input.executedQuantity, "candidate executed quantity");
  if (input.action === "ENTER" || input.action === "ADD") {
    return formatExactDecimal(addExactDecimals(current, executed));
  }
  if (compareExactDecimals(executed, addExactDecimals(current, QUANTITY_TOLERANCE)) > 0) {
    throw new Error("Terminal sell evidence exceeds exact candidate inventory.");
  }
  const remaining = subtractExactDecimals(current, executed);
  return compareExactDecimals(absDecimal(remaining), QUANTITY_TOLERANCE) <= 0
    ? "0"
    : formatExactDecimal(remaining);
}

export function advanceExactCandidateState(
  state: Readonly<ExactCandidateState>,
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>,
): Readonly<ExactCandidateState> {
  const executedQuantity = canonicalNonNegativeDecimal(evidence.executedQuantity, "candidate evidence executedQuantity");
  const grossQuoteValueKrw = canonicalNonNegativeDecimal(
    evidence.grossQuoteValueKrw,
    "candidate evidence grossQuoteValueKrw",
  );
  const confirmedFeeKrw = canonicalNonNegativeDecimal(
    evidence.confirmedFeeKrw,
    "candidate evidence confirmedFeeKrw",
  );
  const remainingQuantity = canonicalNonNegativeDecimal(
    evidence.remainingQuantity,
    "candidate evidence remainingQuantity",
  );
  assertExactChronology(state, evidence);
  if (executedQuantity === "0") {
    if (remainingQuantity !== state.currentEpisodeInventoryQuantity) {
      throw new Error("Terminal no-fill candidate evidence contradicts exact inventory.");
    }
    return Object.freeze({ ...state });
  }

  const expectedRemaining = deriveExactRemainingQuantity({
    currentQuantity: state.currentEpisodeInventoryQuantity,
    action: evidence.action,
    executedQuantity,
  });
  if (expectedRemaining !== remainingQuantity) {
    throw new Error(`Candidate evidence ${evidence.evidenceId} remainingQuantity contradicts exact inventory.`);
  }

  const next: ExactCandidateState = { ...state };
  const currentCost = parseCanonicalNonNegativeDecimal(state.currentEpisodeCostBasisKrw, "candidate exact cost basis");
  const currentQuantity = parseCanonicalNonNegativeDecimal(state.currentEpisodeInventoryQuantity, "candidate exact inventory");
  const currentPnl = parseCanonicalSignedDecimal(state.currentEpisodeRealizedPnlKrw, "candidate exact realized pnl");
  const executed = parseCanonicalNonNegativeDecimal(executedQuantity, "candidate executed quantity");
  const gross = parseCanonicalNonNegativeDecimal(grossQuoteValueKrw, "candidate gross quote value");
  const fee = parseCanonicalNonNegativeDecimal(confirmedFeeKrw, "candidate confirmed fee");

  if (evidence.action === "ENTER" || evidence.action === "ADD") {
    if (evidence.action === "ENTER" && state.currentEpisodeInventoryQuantity !== "0") {
      throw new Error("Candidate ENTER evidence requires an exact flat episode.");
    }
    if (evidence.action === "ADD" && state.currentEpisodeInventoryQuantity === "0") {
      throw new Error("Candidate ADD evidence requires an exact open episode.");
    }
    next.currentEpisodeInventoryQuantity = expectedRemaining;
    next.currentEpisodeCostBasisKrw = formatExactDecimal(addExactDecimals(currentCost, addExactDecimals(gross, fee)));
    if (evidence.action === "ENTER") next.lastEntryPath = evidence.entryPath;
    if (evidence.action === "ADD") next.currentEpisodeAddCount += 1;
  } else {
    if (state.currentEpisodeInventoryQuantity === "0") {
      throw new Error("Candidate sell evidence requires an exact open episode.");
    }
    const removedCost = expectedRemaining === "0"
      ? currentCost
      : divideExactDecimals(
          multiplyExactDecimals(currentCost, executed),
          currentQuantity,
          "candidate proportional cost allocation",
        );
    const realized = subtractExactDecimals(
      addExactDecimals(currentPnl, subtractExactDecimals(gross, fee)),
      removedCost,
    );
    if (expectedRemaining === "0") {
      next.currentEpisodeAddCount = 0;
      next.currentEpisodeCostBasisKrw = "0";
      next.currentEpisodeInventoryQuantity = "0";
      next.currentEpisodeRealizedPnlKrw = "0";
      next.lastFullExitAt = evidence.executedAt;
      next.lastFullExitRealizedPnlKrw = formatExactDecimal(realized);
    } else {
      next.currentEpisodeCostBasisKrw = formatExactDecimal(subtractExactDecimals(currentCost, removedCost));
      next.currentEpisodeInventoryQuantity = expectedRemaining;
      next.currentEpisodeRealizedPnlKrw = formatExactDecimal(realized);
    }
  }

  next.lastEvidenceAt = evidence.executedAt;
  next.lastEvidenceId = evidence.evidenceId;
  next.stateVersion += 1;
  return Object.freeze(next);
}

export function projectExactCandidateState(
  evidence: readonly Readonly<PositionGuardCandidateExecutionEvidence>[],
): Readonly<ExactCandidateState> {
  const ordered = evidence.map((item) => ({
    evidence: item,
    epochNanoseconds: parsePositionGuardCandidateTimestamp(item.executedAt, "candidate evidence executedAt"),
  })).sort((left, right) => {
    if (left.epochNanoseconds < right.epochNanoseconds) return -1;
    if (left.epochNanoseconds > right.epochNanoseconds) return 1;
    return compareDeterministicIdentifiers(left.evidence.evidenceId, right.evidence.evidenceId);
  });
  let state = createExactEmptyCandidateState();
  for (const item of ordered) {
    state = advanceExactCandidateState(state, item.evidence);
  }
  return state;
}

export function compareDeterministicIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseCanonicalDecimal(value: string, _label: string): ExactDecimal {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fractional = ""] = unsigned.split(".");
  return normalizeExactDecimal({
    coefficient: (negative ? -1n : 1n) * BigInt(`${whole}${fractional}`),
    scale: fractional.length,
  });
}

function normalizeExactDecimal(value: ExactDecimal): ExactDecimal {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function assertExactChronology(
  state: Readonly<ExactCandidateState>,
  evidence: Readonly<PositionGuardCandidateExecutionEvidence>,
): void {
  if (state.lastEvidenceAt === null) return;
  const cursor = parsePositionGuardCandidateTimestamp(state.lastEvidenceAt, "candidate state lastEvidenceAt");
  const next = parsePositionGuardCandidateTimestamp(evidence.executedAt, "candidate evidence executedAt");
  if (next < cursor || (next === cursor && evidence.evidenceId <= state.lastEvidenceId!)) {
    throw new Error("Candidate evidence must be in exact persisted chronology order.");
  }
}

function absDecimal(value: ExactDecimal): ExactDecimal {
  return value.coefficient < 0n ? { ...value, coefficient: -value.coefficient } : value;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a === 0n ? 1n : a;
}
