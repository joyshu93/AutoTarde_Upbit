import assert from "node:assert/strict";

import { detectPortfolioDrift } from "../src/modules/reconciliation/portfolio-drift.js";
import { test } from "./harness.js";

test("portfolio drift ignores valuation-only changes when quantities are unchanged", () => {
  const evaluation = detectPortfolioDrift({
    previousBalanceSnapshot: {
      id: "balance-prev",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:00:00.000Z",
      source: "RECONCILIATION",
      totalKrwValue: "2000000",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "1000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "90000000", unitCurrency: "KRW" },
      ]),
    },
    currentBalanceSnapshot: {
      id: "balance-current",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:10:00.000Z",
      source: "RECONCILIATION",
      totalKrwValue: "2100000",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "1000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "90000000", unitCurrency: "KRW" },
      ]),
    },
    previousPositionSnapshot: {
      id: "position-prev",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:00:00.000Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([
        {
          asset: "BTC",
          market: "KRW-BTC",
          quantity: "0.01",
          averageEntryPrice: "90000000",
          markPrice: "100000000",
          marketValue: "1000000",
          exposureRatio: null,
          capturedAt: "2026-04-20T00:00:00.000Z",
        },
      ]),
    },
    currentPositionSnapshot: {
      id: "position-current",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:10:00.000Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([
        {
          asset: "BTC",
          market: "KRW-BTC",
          quantity: "0.01",
          averageEntryPrice: "90000000",
          markPrice: "110000000",
          marketValue: "1100000",
          exposureRatio: null,
          capturedAt: "2026-04-20T00:10:00.000Z",
        },
      ]),
    },
    fills: [],
  });

  assert.equal(evaluation.comparedBalance, true);
  assert.equal(evaluation.comparedPositions, true);
  assert.deepEqual(evaluation.findings, []);
});

test("portfolio drift explains cash and position movement with local fills before flagging drift", () => {
  const evaluation = detectPortfolioDrift({
    previousBalanceSnapshot: {
      id: "balance-prev-2",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:00:00.000Z",
      source: "RECONCILIATION",
      totalKrwValue: "10000000",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "10000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
      ]),
    },
    currentBalanceSnapshot: {
      id: "balance-current-2",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:10:00.000Z",
      source: "RECONCILIATION",
      totalKrwValue: "9999500",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "8999500", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "100000000", unitCurrency: "KRW" },
      ]),
    },
    previousPositionSnapshot: {
      id: "position-prev-2",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:00:00.000Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([]),
    },
    currentPositionSnapshot: {
      id: "position-current-2",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:10:00.000Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([
        {
          asset: "BTC",
          market: "KRW-BTC",
          quantity: "0.01",
          averageEntryPrice: "100000000",
          markPrice: "100000000",
          marketValue: "1000000",
          exposureRatio: null,
          capturedAt: "2026-04-20T00:10:00.000Z",
        },
      ]),
    },
    fills: [
      {
        id: "fill-1",
        orderId: "order-1",
        exchangeFillId: "trade-1",
        market: "KRW-BTC",
        side: "bid",
        price: "100000000",
        volume: "0.01",
        feeCurrency: "KRW",
        feeAmount: "500",
        filledAt: "2026-04-20T00:05:00.000Z",
        rawPayloadJson: "{}",
      },
    ],
  });

  assert.deepEqual(evaluation.findings, []);
});

test("portfolio drift flags unexplained cash and quantity changes", () => {
  const evaluation = detectPortfolioDrift({
    previousBalanceSnapshot: {
      id: "balance-prev-3",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:00:00.000Z",
      source: "RECONCILIATION",
      totalKrwValue: "10000000",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "10000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
      ]),
    },
    currentBalanceSnapshot: {
      id: "balance-current-3",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:10:00.000Z",
      source: "RECONCILIATION",
      totalKrwValue: "10050000",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "10050000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0.02", locked: "0", avgBuyPrice: "100000000", unitCurrency: "KRW" },
      ]),
    },
    previousPositionSnapshot: {
      id: "position-prev-3",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:00:00.000Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([]),
    },
    currentPositionSnapshot: {
      id: "position-current-3",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:10:00.000Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([
        {
          asset: "BTC",
          market: "KRW-BTC",
          quantity: "0.02",
          averageEntryPrice: "100000000",
          markPrice: "100000000",
          marketValue: "2000000",
          exposureRatio: null,
          capturedAt: "2026-04-20T00:10:00.000Z",
        },
      ]),
    },
    fills: [],
  });

  assert.deepEqual(
    evaluation.findings.map((finding) => finding.code),
    ["BALANCE_DRIFT_DETECTED", "POSITION_DRIFT_DETECTED"],
  );
});
