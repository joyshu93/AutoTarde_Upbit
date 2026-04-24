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

  const explained = aggregateFillDeltas(input.fills.filter((fill) => fill.filledAt > input.previousBalanceSnapshot!.capturedAt));
  const actualKrwDelta = current.KRW - previous.KRW;
  const unexplainedKrwDelta = actualKrwDelta - explained.KRW;
  if (isEffectivelyZero(unexplainedKrwDelta)) {
    return {
      compared: true,
      finding: null,
    };
  }

  return {
    compared: true,
    finding: {
      code: "BALANCE_DRIFT_DETECTED",
      message:
        `KRW balance changed by ${formatSignedNumber(actualKrwDelta)} while local fills explain ${formatSignedNumber(explained.KRW)} between ` +
        `${input.previousBalanceSnapshot!.capturedAt} and ${input.currentBalanceSnapshot!.capturedAt}.`,
      payload: {
        previousCapturedAt: input.previousBalanceSnapshot!.capturedAt,
        currentCapturedAt: input.currentBalanceSnapshot!.capturedAt,
        previousKrw: previous.KRW,
        currentKrw: current.KRW,
        actualKrwDelta,
        explainedKrwDelta: explained.KRW,
        unexplainedKrwDelta,
        fillsConsidered: input.fills.filter((fill) => fill.filledAt > input.previousBalanceSnapshot!.capturedAt).length,
      },
    },
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

  const fillsSincePrevious = input.fills.filter((fill) => fill.filledAt > input.previousPositionSnapshot!.capturedAt);
  const explained = aggregateFillDeltas(fillsSincePrevious);
  const residualByAsset = MANAGED_ASSETS.reduce<Record<SupportedAsset, number>>(
    (accumulator, asset) => {
      accumulator[asset] = current[asset] - previous[asset] - explained[asset];
      return accumulator;
    },
    { BTC: 0, ETH: 0 },
  );
  const driftedAssets = MANAGED_ASSETS.filter((asset) => !isEffectivelyZero(residualByAsset[asset]));

  if (driftedAssets.length === 0) {
    return {
      compared: true,
      finding: null,
    };
  }

  return {
    compared: true,
    finding: {
      code: "POSITION_DRIFT_DETECTED",
      message:
        `Managed position quantities drifted for ${driftedAssets.join(",")} between ${input.previousPositionSnapshot!.capturedAt} and ` +
        `${input.currentPositionSnapshot!.capturedAt}.`,
      payload: {
        previousCapturedAt: input.previousPositionSnapshot!.capturedAt,
        currentCapturedAt: input.currentPositionSnapshot!.capturedAt,
        fillsConsidered: fillsSincePrevious.length,
        assets: driftedAssets.map((asset) => ({
          asset,
          previousQuantity: previous[asset],
          currentQuantity: current[asset],
          actualQuantityDelta: current[asset] - previous[asset],
          explainedQuantityDelta: explained[asset],
          unexplainedQuantityDelta: residualByAsset[asset],
        })),
      },
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

function tryParseJson<T>(rawJson: string): T | null {
  try {
    return JSON.parse(rawJson) as T;
  } catch {
    return null;
  }
}

function isEffectivelyZero(value: number): boolean {
  return Math.abs(value) <= FLOATING_POINT_EPSILON;
}

function formatSignedNumber(value: number): string {
  if (Object.is(value, -0) || isEffectivelyZero(value)) {
    return "0";
  }

  const normalized = String(value);
  return value > 0 ? `+${normalized}` : normalized;
}
