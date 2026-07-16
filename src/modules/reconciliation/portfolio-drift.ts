import type {
  BalanceSnapshotRecord,
  ExchangeBalance,
  FillRecord,
  PositionSnapshot,
  PositionSnapshotRecord,
  SupportedAsset,
} from "../../domain/types.js";

const MANAGED_ASSETS: readonly SupportedAsset[] = ["BTC", "ETH"] as const;
const FLOATING_POINT_EPSILON = 1e-9;
const KRW_DUST_TOLERANCE = 1;
const FILL_SNAPSHOT_START_GRACE_MS = 1_000;

export interface PortfolioDriftFinding {
  code: "BALANCE_DRIFT_DETECTED" | "POSITION_DRIFT_DETECTED";
  message: string;
  payload: Record<string, unknown>;
}

export interface PortfolioDriftEvaluation {
  findings: PortfolioDriftFinding[];
  comparedBalance: boolean;
  comparedPositions: boolean;
}

export function detectPortfolioDrift(input: {
  previousBalanceSnapshot: BalanceSnapshotRecord | null;
  currentBalanceSnapshot: BalanceSnapshotRecord | null;
  previousPositionSnapshot: PositionSnapshotRecord | null;
  currentPositionSnapshot: PositionSnapshotRecord | null;
  fills: FillRecord[];
}): PortfolioDriftEvaluation {
  const findings: PortfolioDriftFinding[] = [];
  const balanceFinding = detectBalanceDrift(input);
  const positionFinding = detectPositionDrift(input);

  if (balanceFinding.finding) {
    findings.push(balanceFinding.finding);
  }

  if (positionFinding.finding) {
    findings.push(positionFinding.finding);
  }

  return {
    findings,
    comparedBalance: balanceFinding.compared,
    comparedPositions: positionFinding.compared,
  };
}

function detectBalanceDrift(input: {
  previousBalanceSnapshot: BalanceSnapshotRecord | null;
  currentBalanceSnapshot: BalanceSnapshotRecord | null;
  fills: FillRecord[];
}): {
  compared: boolean;
  finding: PortfolioDriftFinding | null;
} {
  const previous = parseManagedBalances(input.previousBalanceSnapshot);
  const current = parseManagedBalances(input.currentBalanceSnapshot);
  if (!previous || !current) {
    return {
      compared: false,
      finding: null,
    };
  }

  const fillsSincePrevious = selectFillsWithinSnapshotWindow(
    input.fills,
    input.previousBalanceSnapshot!.capturedAt,
    input.currentBalanceSnapshot!.capturedAt,
  );
  const finding = buildBalanceDriftFinding({
    previous,
    current,
    fills: fillsSincePrevious,
    previousCapturedAt: input.previousBalanceSnapshot!.capturedAt,
    currentCapturedAt: input.currentBalanceSnapshot!.capturedAt,
  });
  if (!finding) {
    return {
      compared: true,
      finding: null,
    };
  }

  const graceFinding = buildBalanceDriftFinding({
    previous,
    current,
    fills: selectFillsWithinSnapshotWindow(
      input.fills,
      input.previousBalanceSnapshot!.capturedAt,
      input.currentBalanceSnapshot!.capturedAt,
      FILL_SNAPSHOT_START_GRACE_MS,
    ),
    previousCapturedAt: input.previousBalanceSnapshot!.capturedAt,
    currentCapturedAt: input.currentBalanceSnapshot!.capturedAt,
  });

  return {
    compared: true,
    finding: graceFinding,
  };
}

function detectPositionDrift(input: {
  previousPositionSnapshot: PositionSnapshotRecord | null;
  currentPositionSnapshot: PositionSnapshotRecord | null;
  fills: FillRecord[];
}): {
  compared: boolean;
  finding: PortfolioDriftFinding | null;
} {
  const previous = parseManagedPositionQuantities(input.previousPositionSnapshot);
  const current = parseManagedPositionQuantities(input.currentPositionSnapshot);
  if (!previous || !current) {
    return {
      compared: false,
      finding: null,
    };
  }

  const fillsSincePrevious = selectFillsWithinSnapshotWindow(
    input.fills,
    input.previousPositionSnapshot!.capturedAt,
    input.currentPositionSnapshot!.capturedAt,
  );
  const finding = buildPositionDriftFinding({
    previous,
    current,
    fills: fillsSincePrevious,
    previousCapturedAt: input.previousPositionSnapshot!.capturedAt,
    currentCapturedAt: input.currentPositionSnapshot!.capturedAt,
  });
  if (!finding) {
    return {
      compared: true,
      finding: null,
    };
  }

  const graceFinding = buildPositionDriftFinding({
    previous,
    current,
    fills: selectFillsWithinSnapshotWindow(
      input.fills,
      input.previousPositionSnapshot!.capturedAt,
      input.currentPositionSnapshot!.capturedAt,
      FILL_SNAPSHOT_START_GRACE_MS,
    ),
    previousCapturedAt: input.previousPositionSnapshot!.capturedAt,
    currentCapturedAt: input.currentPositionSnapshot!.capturedAt,
  });

  return {
    compared: true,
    finding: graceFinding,
  };
}

function buildBalanceDriftFinding(input: {
  previous: { KRW: number; BTC: number; ETH: number };
  current: { KRW: number; BTC: number; ETH: number };
  fills: FillRecord[];
  previousCapturedAt: string;
  currentCapturedAt: string;
}): PortfolioDriftFinding | null {
  const explained = aggregateFillDeltas(input.fills);
  const actualKrwDelta = input.current.KRW - input.previous.KRW;
  const unexplainedKrwDelta = actualKrwDelta - explained.KRW;
  if (isEffectivelyZero(unexplainedKrwDelta, KRW_DUST_TOLERANCE)) {
    return null;
  }

  return {
    code: "BALANCE_DRIFT_DETECTED",
    message:
      `KRW balance changed by ${formatSignedNumber(actualKrwDelta)} while local fills explain ${formatSignedNumber(explained.KRW)} between ` +
      `${input.previousCapturedAt} and ${input.currentCapturedAt}.`,
    payload: {
      previousCapturedAt: input.previousCapturedAt,
      currentCapturedAt: input.currentCapturedAt,
      previousKrw: input.previous.KRW,
      currentKrw: input.current.KRW,
      actualKrwDelta,
      explainedKrwDelta: explained.KRW,
      unexplainedKrwDelta,
      fillsConsidered: input.fills.length,
    },
  };
}

function buildPositionDriftFinding(input: {
  previous: Record<SupportedAsset, number>;
  current: Record<SupportedAsset, number>;
  fills: FillRecord[];
  previousCapturedAt: string;
  currentCapturedAt: string;
}): PortfolioDriftFinding | null {
  const explained = aggregateFillDeltas(input.fills);
  const residualByAsset = MANAGED_ASSETS.reduce<Record<SupportedAsset, number>>(
    (accumulator, asset) => {
      accumulator[asset] = input.current[asset] - input.previous[asset] - explained[asset];
      return accumulator;
    },
    { BTC: 0, ETH: 0 },
  );
  const driftedAssets = MANAGED_ASSETS.filter((asset) => !isEffectivelyZero(residualByAsset[asset]));

  if (driftedAssets.length === 0) {
    return null;
  }

  return {
    code: "POSITION_DRIFT_DETECTED",
    message:
      `Managed position quantities drifted for ${driftedAssets.join(",")} between ${input.previousCapturedAt} and ` +
      `${input.currentCapturedAt}.`,
    payload: {
      previousCapturedAt: input.previousCapturedAt,
      currentCapturedAt: input.currentCapturedAt,
      fillsConsidered: input.fills.length,
      assets: driftedAssets.map((asset) => ({
        asset,
        previousQuantity: input.previous[asset],
        currentQuantity: input.current[asset],
        actualQuantityDelta: input.current[asset] - input.previous[asset],
        explainedQuantityDelta: explained[asset],
        unexplainedQuantityDelta: residualByAsset[asset],
      })),
    },
  };
}

function parseManagedBalances(snapshot: BalanceSnapshotRecord | null): {
  KRW: number;
  BTC: number;
  ETH: number;
} | null {
  if (!snapshot) {
    return null;
  }

  const parsed = tryParseJson<ExchangeBalance[]>(snapshot.balancesJson);
  if (!parsed) {
    return null;
  }

  return parsed.reduce(
    (accumulator, balance) => {
      if (balance.currency === "KRW" || balance.currency === "BTC" || balance.currency === "ETH") {
        accumulator[balance.currency] += Number(balance.balance) + Number(balance.locked);
      }
      return accumulator;
    },
    {
      KRW: 0,
      BTC: 0,
      ETH: 0,
    },
  );
}

function parseManagedPositionQuantities(
  snapshot: PositionSnapshotRecord | null,
): Record<SupportedAsset, number> | null {
  if (!snapshot) {
    return null;
  }

  const parsed = tryParseJson<PositionSnapshot[]>(snapshot.positionsJson);
  if (!parsed) {
    return null;
  }

  return parsed.reduce<Record<SupportedAsset, number>>(
    (accumulator, position) => {
      if (position.asset === "BTC" || position.asset === "ETH") {
        accumulator[position.asset] += Number(position.quantity);
      }
      return accumulator;
    },
    {
      BTC: 0,
      ETH: 0,
    },
  );
}

function aggregateFillDeltas(fills: FillRecord[]): {
  KRW: number;
  BTC: number;
  ETH: number;
} {
  return fills.reduce(
    (accumulator, fill) => {
      const asset = fill.market === "KRW-BTC" ? "BTC" : "ETH";
      const quantity = Number(fill.volume);
      const notionalKrw = Number(fill.price) * quantity;
      const feeKrw = fill.feeCurrency === "KRW" || fill.feeCurrency === null ? Number(fill.feeAmount ?? "0") : 0;

      if (fill.side === "bid") {
        accumulator[asset] += quantity;
        accumulator.KRW -= notionalKrw + feeKrw;
      } else {
        accumulator[asset] -= quantity;
        accumulator.KRW += notionalKrw - feeKrw;
      }

      return accumulator;
    },
    {
      KRW: 0,
      BTC: 0,
      ETH: 0,
    },
  );
}

function isExchangeBackedFill(fill: FillRecord): boolean {
  if (fill.exchangeFillId.startsWith("dryrun_")) {
    return false;
  }

  const parsed = tryParseJson<Record<string, unknown>>(fill.rawPayloadJson);
  return parsed?.mode !== "DRY_RUN";
}

function selectFillsWithinSnapshotWindow(
  fills: FillRecord[],
  previousCapturedAt: string,
  currentCapturedAt: string,
  previousStartGraceMs = 0,
): FillRecord[] {
  return fills.filter(
    (fill) =>
      isExchangeBackedFill(fill) &&
      isTimestampWithinSnapshotWindow(fill.filledAt, previousCapturedAt, currentCapturedAt, previousStartGraceMs),
  );
}

function isTimestampWithinSnapshotWindow(
  timestamp: string,
  previousCapturedAt: string,
  currentCapturedAt: string,
  previousStartGraceMs = 0,
): boolean {
  const instant = Date.parse(timestamp);
  const previous = Date.parse(previousCapturedAt);
  const current = Date.parse(currentCapturedAt);

  if (!Number.isFinite(instant) || !Number.isFinite(previous) || !Number.isFinite(current)) {
    return false;
  }

  return instant > previous - previousStartGraceMs && instant <= current;
}

function tryParseJson<T>(rawJson: string): T | null {
  try {
    return JSON.parse(rawJson) as T;
  } catch {
    return null;
  }
}

function isEffectivelyZero(value: number, tolerance = FLOATING_POINT_EPSILON): boolean {
  return Math.abs(value) <= tolerance + FLOATING_POINT_EPSILON;
}

function formatSignedNumber(value: number): string {
  if (Object.is(value, -0) || isEffectivelyZero(value)) {
    return "0";
  }

  const normalized = String(value);
  return value > 0 ? `+${normalized}` : normalized;
}
