import assert from "node:assert/strict";

import { ExecutionService } from "../src/modules/execution/execution-service.js";
import { DryRunExchangeAdapter } from "../src/modules/exchange/interfaces.js";
import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import { test } from "./harness.js";

function createExecutionService() {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-1",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const service = new ExecutionService({
    policy: {
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      globalKillSwitch: false,
      maxAllocationByAsset: {
        BTC: 0.6,
        ETH: 0.4,
      },
      totalExposureCap: 0.95,
      stalePriceThresholdMs: 30_000,
      minimumOrderValueKrw: 5_000,
    },
    exchangeAdapter: new DryRunExchangeAdapter(),
    repositories,
    operatorState,
  });

  return { service, repositories };
}

test("execution service persists a dry-run order and blocks duplicate idempotent submissions", async () => {
  const { service, repositories } = createExecutionService();
  await repositories.saveBalanceSnapshot({
    id: "balance-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "10000000",
    balancesJson: "[]",
  });
  await repositories.savePositionSnapshot({
    id: "position-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    positionsJson: "[]",
  });

  const input = {
    exchangeAccountId: "primary",
    strategyDecisionId: "decision-1",
    decision: {
      strategyKey: "deterministic.stub.v1",
      market: "KRW-BTC" as const,
      action: "ENTER" as const,
      reasonCodes: ["TEST"],
      referencePrice: 100_000_000,
      requestedNotionalKrw: 100_000,
      requestedQuantity: 0.001,
      metadata: {},
    },
    side: "bid" as const,
    ordType: "limit" as const,
    price: "100000000",
    volume: "0.001",
  };

  const first = await service.submitOrderFromDecision(input);
  assert.equal(first.accepted, true);
  assert.equal(first.order?.status, "OPEN");

  const second = await service.submitOrderFromDecision(input);
  assert.equal(second.accepted, false);
  assert.match(second.reason ?? "", /Duplicate order intent/);
});
