import assert from "node:assert/strict";

import {
  buildBalanceSnapshotRecord,
  buildPositionSnapshotRecord,
  buildPriceByAssetFromExchangeBalances,
} from "../src/modules/reconciliation/snapshot-service.js";
import { test } from "./harness.js";

test("snapshot service builds KRW-valued balance and position snapshots", () => {
  const balances = [
    { currency: "KRW", balance: "1000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
    { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "90000000", unitCurrency: "KRW" },
    { currency: "ETH", balance: "0.5", locked: "0", avgBuyPrice: "3000000", unitCurrency: "KRW" },
  ];

  const balanceSnapshot = buildBalanceSnapshotRecord({
    exchangeAccountId: "primary",
    balances,
    priceByAsset: {
      BTC: 100_000_000,
      ETH: 4_000_000,
    },
    source: "EXCHANGE_POLL",
    capturedAt: "2026-04-20T00:00:00.000Z",
  });

  const positionSnapshot = buildPositionSnapshotRecord({
    exchangeAccountId: "primary",
    balances,
    priceByAsset: {
      BTC: 100_000_000,
      ETH: 4_000_000,
    },
    source: "EXCHANGE_POLL",
    capturedAt: "2026-04-20T00:00:00.000Z",
  });

  assert.equal(balanceSnapshot.totalKrwValue, "4000000");

  const positions = JSON.parse(positionSnapshot.positionsJson) as Array<{ asset: string; marketValue: string | null }>;
  assert.equal(positions.length, 2);
  assert.deepEqual(
    positions.map((position) => position.asset),
    ["BTC", "ETH"],
  );
  assert.deepEqual(
    positions.map((position) => position.marketValue),
    ["1000000", "2000000"],
  );
});

test("snapshot service derives explicit valuation prices from exchange avg_buy_price fields", () => {
  const balances = [
    { currency: "KRW", balance: "1000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
    { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "90000000", unitCurrency: "KRW" },
    { currency: "ETH", balance: "0.5", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
  ];

  const priceByAsset = buildPriceByAssetFromExchangeBalances(balances);

  assert.deepEqual(priceByAsset, {
    BTC: 90_000_000,
  });
});
