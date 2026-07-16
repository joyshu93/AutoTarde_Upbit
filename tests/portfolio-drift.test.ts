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

test("portfolio drift ignores dry-run synthetic fills because they do not mutate exchange balances", () => {
  const evaluation = detectPortfolioDrift({
    previousBalanceSnapshot: {
      id: "balance-prev-dryrun",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:00:00.000Z",
      source: "RECONCILIATION",
      totalKrwValue: "10000000",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "10000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "100000000", unitCurrency: "KRW" },
      ]),
    },
    currentBalanceSnapshot: {
      id: "balance-current-dryrun",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:10:00.000Z",
      source: "RECONCILIATION",
      totalKrwValue: "10000000",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "10000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "100000000", unitCurrency: "KRW" },
      ]),
    },
    previousPositionSnapshot: {
      id: "position-prev-dryrun",
      exchangeAccountId: "primary",
      capturedAt: "2026-04-20T00:00:00.000Z",
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
          capturedAt: "2026-04-20T00:00:00.000Z",
        },
      ]),
    },
    currentPositionSnapshot: {
      id: "position-current-dryrun",
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
        id: "fill-dryrun",
        orderId: "order-dryrun",
        exchangeFillId: "dryrun_repair:order-dryrun",
        market: "KRW-BTC",
        side: "ask",
        price: "100000000",
        volume: "0.01",
        feeCurrency: null,
        feeAmount: "0",
        filledAt: "2026-04-20T00:05:00.000Z",
        rawPayloadJson: JSON.stringify({ mode: "DRY_RUN", settlement: "LOCAL_DRY_RUN_REPAIR" }),
      },
    ],
  });

  assert.deepEqual(evaluation.findings, []);
});

test("portfolio drift compares fill and snapshot timestamps by instant instead of text", () => {
  const evaluation = detectPortfolioDrift({
    previousBalanceSnapshot: {
      id: "balance-prev-upbit-timezone",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-06T09:27:39.442Z",
      source: "RECONCILIATION",
      totalKrwValue: "1011907.38",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "1011907.38", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0.009874", locked: "0", avgBuyPrice: "90000000", unitCurrency: "KRW" },
      ]),
    },
    currentBalanceSnapshot: {
      id: "balance-current-upbit-timezone",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-06T09:29:46.309Z",
      source: "RECONCILIATION",
      totalKrwValue: "1011907.38",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "1011907.38", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0.009874", locked: "0", avgBuyPrice: "90000000", unitCurrency: "KRW" },
      ]),
    },
    previousPositionSnapshot: {
      id: "position-prev-upbit-timezone",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-06T09:27:39.442Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([
        {
          asset: "BTC",
          market: "KRW-BTC",
          quantity: "0.009874",
          averageEntryPrice: "90000000",
          markPrice: "94503000",
          marketValue: "933137.922",
          exposureRatio: null,
          capturedAt: "2026-07-06T09:27:39.442Z",
        },
      ]),
    },
    currentPositionSnapshot: {
      id: "position-current-upbit-timezone",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-06T09:29:46.309Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([
        {
          asset: "BTC",
          market: "KRW-BTC",
          quantity: "0.009874",
          averageEntryPrice: "90000000",
          markPrice: "94503000",
          marketValue: "933137.922",
          exposureRatio: null,
          capturedAt: "2026-07-06T09:29:46.309Z",
        },
      ]),
    },
    fills: [
      {
        id: "fill-upbit-timezone",
        orderId: "order-upbit-timezone",
        exchangeFillId: "trade-upbit-timezone",
        market: "KRW-BTC",
        side: "ask",
        price: "94503000",
        volume: "0.000126",
        feeCurrency: null,
        feeAmount: "0",
        filledAt: "2026-07-06T18:27:39.360311+09:00",
        rawPayloadJson: "{}",
      },
    ],
  });

  assert.deepEqual(evaluation.findings, []);
});

test("portfolio drift allows one-second exchange timestamp precision skew when a fill explains later snapshots", () => {
  const evaluation = detectPortfolioDrift({
    previousBalanceSnapshot: {
      id: "balance-prev-fill-skew",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-14T14:51:10.137Z",
      source: "RECONCILIATION",
      totalKrwValue: "10000",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "10000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
      ]),
    },
    currentBalanceSnapshot: {
      id: "balance-current-fill-skew",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-14T15:51:10.102Z",
      source: "RECONCILIATION",
      totalKrwValue: "9999.5",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "8999.5", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "ETH", balance: "0.1", locked: "0", avgBuyPrice: "10000", unitCurrency: "KRW" },
      ]),
    },
    previousPositionSnapshot: {
      id: "position-prev-fill-skew",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-14T14:51:10.137Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([]),
    },
    currentPositionSnapshot: {
      id: "position-current-fill-skew",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-14T15:51:10.102Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([
        {
          asset: "ETH",
          market: "KRW-ETH",
          quantity: "0.1",
          averageEntryPrice: "10000",
          markPrice: "10000",
          marketValue: "1000",
          exposureRatio: null,
          capturedAt: "2026-07-14T15:51:10.102Z",
        },
      ]),
    },
    fills: [
      {
        id: "fill-fill-skew",
        orderId: "order-fill-skew",
        exchangeFillId: "trade-fill-skew",
        market: "KRW-ETH",
        side: "bid",
        price: "10000",
        volume: "0.1",
        feeCurrency: "KRW",
        feeAmount: "0.5",
        filledAt: "2026-07-14T23:51:10+09:00",
        rawPayloadJson: "{}",
      },
    ],
  });

  assert.deepEqual(evaluation.findings, []);
});

test("portfolio drift tolerates one KRW of rounding dust after fee-adjusted fills", () => {
  const evaluation = detectPortfolioDrift({
    previousBalanceSnapshot: {
      id: "balance-prev-dust",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-13T10:31:56.941Z",
      source: "RECONCILIATION",
      totalKrwValue: "31749.68015783",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "31749.68015783", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0.00036247", locked: "0", avgBuyPrice: "115950000", unitCurrency: "KRW" },
      ]),
    },
    currentBalanceSnapshot: {
      id: "balance-current-dust",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-13T11:31:57.361Z",
      source: "RECONCILIATION",
      totalKrwValue: "65616.7093325",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "65616.7093325", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
      ]),
    },
    previousPositionSnapshot: {
      id: "position-prev-dust",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-13T10:31:56.941Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([
        {
          asset: "BTC",
          market: "KRW-BTC",
          quantity: "0.00036247",
          averageEntryPrice: "115950000",
          markPrice: "93478000",
          marketValue: "33882.97066",
          exposureRatio: null,
          capturedAt: "2026-07-13T10:31:56.941Z",
        },
      ]),
    },
    currentPositionSnapshot: {
      id: "position-current-dust",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-13T11:31:57.361Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([]),
    },
    fills: [
      {
        id: "fill-dust",
        orderId: "order-dust",
        exchangeFillId: "trade-dust",
        market: "KRW-BTC",
        side: "ask",
        price: "93478000",
        volume: "0.00036247",
        feeCurrency: "KRW",
        feeAmount: "16.94148533",
        filledAt: "2026-07-13T19:31:57+09:00",
        rawPayloadJson: "{}",
      },
    ],
  });

  assert.deepEqual(evaluation.findings, []);
});

test("portfolio drift flags KRW residuals above the explicit dust tolerance", () => {
  const evaluation = detectPortfolioDrift({
    previousBalanceSnapshot: {
      id: "balance-prev-above-dust",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-13T10:31:56.941Z",
      source: "RECONCILIATION",
      totalKrwValue: "31749.68015783",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "31749.68015783", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0.00036247", locked: "0", avgBuyPrice: "115950000", unitCurrency: "KRW" },
      ]),
    },
    currentBalanceSnapshot: {
      id: "balance-current-above-dust",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-13T11:31:57.361Z",
      source: "RECONCILIATION",
      totalKrwValue: "65616.7193325",
      balancesJson: JSON.stringify([
        { currency: "KRW", balance: "65616.7193325", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
        { currency: "BTC", balance: "0", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
      ]),
    },
    previousPositionSnapshot: {
      id: "position-prev-above-dust",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-13T10:31:56.941Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([
        {
          asset: "BTC",
          market: "KRW-BTC",
          quantity: "0.00036247",
          averageEntryPrice: "115950000",
          markPrice: "93478000",
          marketValue: "33882.97066",
          exposureRatio: null,
          capturedAt: "2026-07-13T10:31:56.941Z",
        },
      ]),
    },
    currentPositionSnapshot: {
      id: "position-current-above-dust",
      exchangeAccountId: "primary",
      capturedAt: "2026-07-13T11:31:57.361Z",
      source: "RECONCILIATION",
      positionsJson: JSON.stringify([]),
    },
    fills: [
      {
        id: "fill-above-dust",
        orderId: "order-above-dust",
        exchangeFillId: "trade-above-dust",
        market: "KRW-BTC",
        side: "ask",
        price: "93478000",
        volume: "0.00036247",
        feeCurrency: "KRW",
        feeAmount: "16.94148533",
        filledAt: "2026-07-13T19:31:57+09:00",
        rawPayloadJson: "{}",
      },
    ],
  });

  assert.deepEqual(
    evaluation.findings.map((finding) => finding.code),
    ["BALANCE_DRIFT_DETECTED"],
  );
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
