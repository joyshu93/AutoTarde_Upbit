import assert from "node:assert/strict";

import {
  RuntimeOwnershipGuardError,
  type RuntimeOwnershipAuthority,
} from "../src/app/runtime-ownership-guard.js";
import {
  InlineTelegramSyncController as ProductionInlineTelegramSyncController,
} from "../src/app/sync-controller.js";
import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import {
  PortfolioSyncService as ProductionPortfolioSyncService,
} from "../src/modules/reconciliation/portfolio-sync-service.js";
import {
  ReconciliationService as ProductionReconciliationService,
} from "../src/modules/reconciliation/reconciliation-service.js";
import { DurableTelegramReporter } from "../src/modules/telegram/reporter.js";
import { test } from "./harness.js";

class InlineTelegramSyncController extends ProductionInlineTelegramSyncController {
  constructor(dependencies: ConstructorParameters<typeof ProductionInlineTelegramSyncController>[0]) {
    super({
      ...dependencies,
      runtimeOwnership: dependencies.runtimeOwnership ?? createAlwaysOwnedRuntimeOwnershipAuthority(),
    });
  }
}

class PortfolioSyncService extends ProductionPortfolioSyncService {
  constructor(dependencies: ConstructorParameters<typeof ProductionPortfolioSyncService>[0]) {
    super({
      ...dependencies,
      runtimeOwnership: dependencies.runtimeOwnership ?? createAlwaysOwnedRuntimeOwnershipAuthority(),
    });
  }
}

class ReconciliationService extends ProductionReconciliationService {
  constructor(dependencies: ConstructorParameters<typeof ProductionReconciliationService>[0]) {
    super({
      ...dependencies,
      runtimeOwnership: dependencies.runtimeOwnership ?? createAlwaysOwnedRuntimeOwnershipAuthority(),
    });
  }
}

test("inline telegram sync controller fails closed when runtime authority is omitted", async () => {
  let syncCalls = 0;
  const controller = new ProductionInlineTelegramSyncController({
    portfolioSyncService: {
      async run(): Promise<never> {
        syncCalls += 1;
        throw new Error("sync must not run without ownership authority");
      },
    },
  });

  await assert.rejects(
    () => controller.requestSync({
      exchangeAccountId: "primary",
      requestedBy: "TELEGRAM",
      requestedCommand: "/sync",
    }),
    /RUNTIME_OWNERSHIP_NOT_HELD/u,
  );
  assert.equal(syncCalls, 0);
});

function createLostRuntimeOwnershipAuthority(): RuntimeOwnershipAuthority {
  return {
    snapshot: () => ({
      status: "LOST",
      generation: 1,
      executionMode: "DRY_RUN",
      acquiredAtEpochMs: 1,
      heartbeatAtEpochMs: 1,
      expiresAtEpochMs: 45_001,
      takeover: false,
      lossReason: "TEST_GENERATION_REPLACED",
    }),
    assertLocallyHeld() {
      throw new Error("RUNTIME_OWNERSHIP_LOST: TEST_GENERATION_REPLACED");
    },
    async assertCurrent(): Promise<never> {
      throw new Error("RUNTIME_OWNERSHIP_LOST: TEST_GENERATION_REPLACED");
    },
  };
}

function createAlwaysOwnedRuntimeOwnershipAuthority(): RuntimeOwnershipAuthority {
  const record = {
    ownerToken: "owner".padEnd(64, "x"),
    generation: 1,
    executionMode: "DRY_RUN" as const,
    acquiredAtEpochMs: 1,
    heartbeatAtEpochMs: 1,
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  };
  return {
    snapshot: () => ({
      status: "OWNED",
      generation: record.generation,
      executionMode: record.executionMode,
      acquiredAtEpochMs: record.acquiredAtEpochMs,
      heartbeatAtEpochMs: record.heartbeatAtEpochMs,
      expiresAtEpochMs: record.expiresAtEpochMs,
      takeover: false,
      lossReason: null,
    }),
    assertLocallyHeld() {},
    async assertCurrent() {
      return { ...record };
    },
  };
}

test("inline telegram sync controller rejects before sync after runtime ownership is lost", async () => {
  let syncCalls = 0;
  const controller = new InlineTelegramSyncController({
    portfolioSyncService: {
      async run(): Promise<never> {
        syncCalls += 1;
        throw new Error("sync must not run after ownership loss");
      },
    },
    runtimeOwnership: createLostRuntimeOwnershipAuthority(),
  });

  await assert.rejects(
    () => controller.requestSync({
      exchangeAccountId: "primary",
      requestedBy: "TELEGRAM",
      requestedCommand: "/sync",
    }),
    /RUNTIME_OWNERSHIP_LOST/u,
  );

  assert.equal(syncCalls, 0);
});

test("inline telegram sync controller rethrows ownership loss from an active sync without failure reporting", async () => {
  const ownership = createOwnedThenLostRuntimeOwnershipAuthority();
  let reportCalls = 0;
  const controller = new InlineTelegramSyncController({
    portfolioSyncService: {
      async run(): Promise<never> {
        ownership.lose();
        throw ownership.lossError;
      },
    },
    reporter: {
      async report() {
        reportCalls += 1;
      },
    },
    runtimeOwnership: ownership.authority,
  });

  await assert.rejects(
    () => controller.requestSync({
      exchangeAccountId: "primary",
      requestedBy: "TELEGRAM",
      requestedCommand: "/sync",
    }),
    (error) => error === ownership.lossError,
  );

  assert.equal(reportCalls, 0);
});

function createOwnedThenLostRuntimeOwnershipAuthority(): {
  authority: RuntimeOwnershipAuthority;
  lose(): void;
  lossError: RuntimeOwnershipGuardError;
} {
  let held = true;
  const lossError = new RuntimeOwnershipGuardError(
    "RUNTIME_OWNERSHIP_LOST",
    "RUNTIME_OWNERSHIP_LOST: TEST_GENERATION_REPLACED",
  );
  return {
    lossError,
    lose() {
      held = false;
    },
    authority: {
      snapshot: () => ({
        status: held ? "OWNED" : "LOST",
        generation: 1,
        executionMode: "DRY_RUN",
        acquiredAtEpochMs: 1,
        heartbeatAtEpochMs: 1,
        expiresAtEpochMs: 45_001,
        takeover: false,
        lossReason: held ? null : "TEST_GENERATION_REPLACED",
      }),
      assertLocallyHeld() {
        if (!held) throw lossError;
      },
      async assertCurrent() {
        if (!held) throw lossError;
        return {
          ownerToken: "owner".padEnd(64, "x"),
          generation: 1,
          executionMode: "DRY_RUN",
          acquiredAtEpochMs: 1,
          heartbeatAtEpochMs: 1,
          expiresAtEpochMs: 45_001,
        };
      },
    },
  };
}

function createPortfolioSyncService(input: {
  exchangeAdapter: ConstructorParameters<typeof PortfolioSyncService>[0]["exchangeAdapter"];
  marketPriceReader?: ConstructorParameters<typeof PortfolioSyncService>[0]["marketPriceReader"];
  repositories: ConstructorParameters<typeof PortfolioSyncService>[0]["repositories"];
  reconciliationService: ConstructorParameters<typeof PortfolioSyncService>[0]["reconciliationService"];
  now?: ConstructorParameters<typeof PortfolioSyncService>[0]["now"];
}) {
  return new PortfolioSyncService({
    exchangeAdapter: input.exchangeAdapter,
    repositories: input.repositories,
    reconciliationService: input.reconciliationService,
    ...(input.marketPriceReader ? { marketPriceReader: input.marketPriceReader } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}

test("inline telegram sync controller uses public ticker prices for valuation when available", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-1",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
  const reconciliationService = new ReconciliationService({
    repositories,
    operatorState,
  });
  const now = () => "2026-04-20T00:10:00.000Z";
  const controller = new InlineTelegramSyncController({
    portfolioSyncService: createPortfolioSyncService({
      exchangeAdapter: {
        async getBalances() {
          return [
            { currency: "KRW", balance: "1000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
            { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "90000000", unitCurrency: "KRW" },
          ];
        },
      },
      marketPriceReader: {
        async getTickers() {
          return [
            {
              market: "KRW-BTC",
              trade_price: 100_000_000,
              trade_timestamp: 1_745_110_200_000,
            },
          ];
        },
      },
      repositories,
      reconciliationService,
      now,
    }),
    now,
  });

  const result = await controller.requestSync({
    exchangeAccountId: "primary",
    requestedBy: "TELEGRAM",
    requestedCommand: "/sync",
  });

  const balanceSnapshot = await repositories.getLatestBalanceSnapshot("primary");
  const positionSnapshot = await repositories.getLatestPositionSnapshot("primary");
  const runs = await repositories.listReconciliationRuns("primary", 1);

  assert.equal(result.status, "COMPLETED");
  assert.match(result.detail, /Stored balance snapshot/);
  assert.match(result.detail, /valuation_source=public_ticker/);
  assert.match(result.detail, /reconciliation_source=OPERATOR_SYNC/);
  assert.match(result.detail, /Reconciliation status=SUCCESS/);
  assert.equal(balanceSnapshot?.source, "RECONCILIATION");
  assert.equal(balanceSnapshot?.totalKrwValue, "2000000");
  assert.equal(positionSnapshot?.source, "RECONCILIATION");

  const positions = JSON.parse(positionSnapshot?.positionsJson ?? "[]") as Array<{
    market: string;
    asset: string;
    quantity: string;
    markPrice: string | null;
    marketValue: string | null;
  }>;
  assert.equal(positions.length, 1);
  assert.equal(positions[0]?.market, "KRW-BTC");
  assert.equal(positions[0]?.asset, "BTC");
  assert.equal(positions[0]?.quantity, "0.01");
  assert.equal(positions[0]?.markPrice, "100000000");
  assert.equal(positions[0]?.marketValue, "1000000");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "SUCCESS");
});

test("inline telegram sync controller falls back to avg_buy_price when public ticker pricing is unavailable", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-2",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
  const reconciliationService = new ReconciliationService({
    repositories,
    operatorState,
  });
  const now = () => "2026-04-20T00:11:00.000Z";
  const controller = new InlineTelegramSyncController({
    portfolioSyncService: createPortfolioSyncService({
      exchangeAdapter: {
        async getBalances() {
          return [
            { currency: "KRW", balance: "1000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
            { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "90000000", unitCurrency: "KRW" },
          ];
        },
      },
      marketPriceReader: {
        async getTickers() {
          throw new Error("public ticker unavailable");
        },
      },
      repositories,
      reconciliationService,
      now,
    }),
    now,
  });

  const result = await controller.requestSync({
    exchangeAccountId: "primary",
    requestedBy: "TELEGRAM",
    requestedCommand: "/sync",
  });
  const balanceSnapshot = await repositories.getLatestBalanceSnapshot("primary");
  const runs = await repositories.listReconciliationRuns("primary", 1);

  assert.equal(result.status, "COMPLETED");
  assert.match(result.detail, /valuation_source=avg_buy_price_fallback/);
  assert.match(result.detail, /reconciliation_source=OPERATOR_SYNC/);
  assert.equal(balanceSnapshot?.totalKrwValue, "1900000");
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "SUCCESS");
});

test("inline telegram sync controller records portfolio drift when exchange balances move without local fills", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-2b",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
  await repositories.saveBalanceSnapshot({
    id: "balance-prev-drift",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "RECONCILIATION",
    totalKrwValue: "10000000",
    balancesJson: JSON.stringify([
      { currency: "KRW", balance: "10000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
    ]),
  });
  await repositories.savePositionSnapshot({
    id: "position-prev-drift",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "RECONCILIATION",
    positionsJson: JSON.stringify([]),
  });

  const reconciliationService = new ReconciliationService({
    repositories,
    operatorState,
  });
  const now = () => "2026-04-20T00:11:30.000Z";
  const controller = new InlineTelegramSyncController({
    portfolioSyncService: createPortfolioSyncService({
      exchangeAdapter: {
        async getBalances() {
          return [
            { currency: "KRW", balance: "10100000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
            { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "100000000", unitCurrency: "KRW" },
          ];
        },
      },
      marketPriceReader: {
        async getTickers() {
          return [
            {
              market: "KRW-BTC",
              trade_price: 100_000_000,
              trade_timestamp: 1_745_110_200_000,
            },
          ];
        },
      },
      repositories,
      reconciliationService,
      now,
    }),
    now,
  });

  const result = await controller.requestSync({
    exchangeAccountId: "primary",
    requestedBy: "TELEGRAM",
    requestedCommand: "/sync",
  });
  const runs = await repositories.listReconciliationRuns("primary", 1);
  const riskEvents = await repositories.listRiskEvents("primary", 10);

  assert.equal(result.status, "COMPLETED");
  assert.match(result.detail, /Reconciliation status=DRIFT_DETECTED/);
  assert.match(result.detail, /issue_codes=BALANCE_DRIFT_DETECTED,POSITION_DRIFT_DETECTED/);
  assert.equal(runs[0]?.status, "DRIFT_DETECTED");
  assert.deepEqual(
    riskEvents.map((event) => event.ruleCode),
    ["BALANCE_DRIFT_DETECTED", "POSITION_DRIFT_DETECTED"],
  );
});

test("inline telegram sync controller records a failed reconciliation run when valuation remains unavailable", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-3",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
  const reconciliationService = new ReconciliationService({
    repositories,
    operatorState,
  });
  const now = () => "2026-04-20T00:12:00.000Z";
  const controller = new InlineTelegramSyncController({
    portfolioSyncService: createPortfolioSyncService({
      exchangeAdapter: {
        async getBalances() {
          return [
            { currency: "KRW", balance: "1000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
            { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
          ];
        },
      },
      marketPriceReader: {
        async getTickers() {
          throw new Error("public ticker unavailable");
        },
      },
      repositories,
      reconciliationService,
      now,
    }),
    now,
  });

  const result = await controller.requestSync({
    exchangeAccountId: "primary",
    requestedBy: "TELEGRAM",
    requestedCommand: "/sync",
  });
  const runs = await repositories.listReconciliationRuns("primary", 1);

  assert.equal(result.status, "FAILED");
  assert.match(result.detail, /Unable to determine valuation prices/);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "ERROR");
  assert.match(runs[0]?.errorMessage ?? "", /Unable to determine valuation prices/);
});

test("inline telegram sync controller records a failed reconciliation run when exchange polling fails", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-4",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
  const reconciliationService = new ReconciliationService({
    repositories,
    operatorState,
  });
  const now = () => "2026-04-20T00:13:00.000Z";
  const controller = new InlineTelegramSyncController({
    portfolioSyncService: createPortfolioSyncService({
      exchangeAdapter: {
        async getBalances() {
          throw new Error("upbit accounts endpoint unavailable");
        },
      },
      repositories,
      reconciliationService,
      now,
    }),
    now,
  });

  const result = await controller.requestSync({
    exchangeAccountId: "primary",
    requestedBy: "TELEGRAM",
    requestedCommand: "/sync",
  });
  const runs = await repositories.listReconciliationRuns("primary", 1);

  assert.equal(result.status, "FAILED");
  assert.match(result.detail, /upbit accounts endpoint unavailable/);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "ERROR");
  assert.match(runs[0]?.errorMessage ?? "", /upbit accounts endpoint unavailable/);
});

test("inline telegram sync controller queues an operator notification when sync fails", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-4b",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
  const reconciliationService = new ReconciliationService({
    repositories,
    operatorState,
  });
  const now = () => "2026-04-20T00:13:30.000Z";
  const controller = new InlineTelegramSyncController({
    portfolioSyncService: createPortfolioSyncService({
      exchangeAdapter: {
        async getBalances() {
          throw new Error("upbit accounts endpoint unavailable");
        },
      },
      repositories,
      reconciliationService,
      now,
    }),
    reporter: new DurableTelegramReporter({ repositories }),
    now,
  });

  await controller.requestSync({
    exchangeAccountId: "primary",
    requestedBy: "TELEGRAM",
    requestedCommand: "/sync",
  });

  const notifications = await repositories.listOperatorNotifications("primary");

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.notificationType, "SYNC_FAILED");
  assert.equal(notifications[0]?.severity, "ERROR");
  assert.match(notifications[0]?.message ?? "", /upbit accounts endpoint unavailable/);
});

test("inline telegram sync controller applies exchange-backed order reconciliation during sync", async () => {
  const repositories = new InMemoryExecutionRepository();
  const operatorState = new InMemoryOperatorStateStore({
    id: "state-5",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    degradedReason: null,
    degradedAt: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });
  await repositories.saveOrder({
    id: "order-5",
    strategyDecisionId: "decision-5",
    exchangeAccountId: "primary",
    market: "KRW-BTC",
    side: "bid",
    ordType: "limit",
    volume: "0.01",
    price: "100000000",
    timeInForce: null,
    smpType: null,
    identifier: "identifier-5",
    idempotencyKey: "idem-5",
    origin: "STRATEGY",
    requestedAt: "2026-04-20T00:00:00.000Z",
    upbitUuid: "uuid-5",
    status: "OPEN",
    executionMode: "DRY_RUN",
    exchangeResponseJson: null,
    failureCode: null,
    failureMessage: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const reconciliationService = new ReconciliationService({
    repositories,
    operatorState,
    orderReader: {
      async getOrder() {
        return {
          uuid: "uuid-5",
          identifier: "identifier-5",
          market: "KRW-BTC",
          side: "bid",
          ordType: "limit",
          state: "done",
          price: "100000000",
          volume: "0.01",
          remainingVolume: "0",
          executedVolume: "0.01",
          paidFee: "500",
          createdAt: "2026-04-20T00:00:00.000Z",
          fills: [],
          raw: {
            state: "done",
          },
        };
      },
    },
  });
  const now = () => "2026-04-20T00:14:00.000Z";
  const controller = new InlineTelegramSyncController({
    portfolioSyncService: createPortfolioSyncService({
      exchangeAdapter: {
        async getBalances() {
          return [
            { currency: "KRW", balance: "1000000", locked: "0", avgBuyPrice: "0", unitCurrency: "KRW" },
            { currency: "BTC", balance: "0.01", locked: "0", avgBuyPrice: "90000000", unitCurrency: "KRW" },
          ];
        },
      },
      marketPriceReader: {
        async getTickers() {
          return [
            {
              market: "KRW-BTC",
              trade_price: 100_000_000,
              trade_timestamp: 1_745_110_200_000,
            },
          ];
        },
      },
      repositories,
      reconciliationService,
      now,
    }),
    now,
  });

  const result = await controller.requestSync({
    exchangeAccountId: "primary",
    requestedBy: "TELEGRAM",
    requestedCommand: "/sync",
  });
  const orders = await repositories.listOrders("primary");

  assert.equal(result.status, "COMPLETED");
  assert.match(result.detail, /reconciliation_source=OPERATOR_SYNC/);
  assert.match(result.detail, /Reconciliation status=DRIFT_DETECTED/);
  assert.equal(orders[0]?.status, "FILLED");
});
