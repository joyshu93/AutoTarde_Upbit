export const MODULE_NAMES = [
  "db",
  "exchange",
  "execution",
  "reconciliation",
  "risk",
  "strategy",
  "telegram"
] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];

export const SUPPORTED_MARKETS = ["KRW-BTC", "KRW-ETH"] as const;

export type ApprovedMarket = (typeof SUPPORTED_MARKETS)[number];
