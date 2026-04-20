import { createFingerprint } from "../../shared/ids.js";

export function buildOrderIdempotencyKey(input: {
  exchangeAccountId: string;
  strategyDecisionId: string | null;
  market: string;
  side: string;
  ordType: string;
  price: string | null;
  volume: string | null;
}): string {
  return createFingerprint(
    [
      input.exchangeAccountId,
      input.strategyDecisionId ?? "manual",
      input.market,
      input.side,
      input.ordType,
      input.price ?? "null",
      input.volume ?? "null",
    ].join("|"),
  );
}

export function buildOrderIdentifier(input: {
  market: string;
  side: string;
  strategyDecisionId: string | null;
  requestedAt: string;
}): string {
  const timestamp = input.requestedAt.replace(/[-:.TZ]/g, "");
  const suffix = createFingerprint(`${input.market}|${input.side}|${input.strategyDecisionId ?? "manual"}|${timestamp}`).slice(0, 12);
  return `${input.market}-${input.side}-${suffix}`;
}
