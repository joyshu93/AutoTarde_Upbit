import assert from "node:assert/strict";

import { StrategyScheduler } from "../src/app/strategy-scheduler.js";
import { InMemoryExecutionRepository } from "../src/modules/db/repositories/in-memory-repositories.js";
import type {
  TelegramStrategyRunController,
  TelegramStrategyRunRequest,
  TelegramStrategyRunResult,
} from "../src/modules/telegram/interfaces.js";
import { test } from "./harness.js";

test("strategy scheduler is disabled by default and does not schedule timers", () => {
  const scheduledDelays: number[] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: false,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "DRY_RUN_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController(),
    now: () => "2026-04-20T00:00:00.000Z",
    setTimer: (callback, delayMs) => {
      scheduledDelays.push(delayMs);
      const timer = setTimeout(callback, 0);
      clearTimeout(timer);
      return timer;
    },
  });

  const status = scheduler.start();

  assert.equal(status.enabled, false);
  assert.equal(status.started, false);
  assert.deepEqual(scheduledDelays, []);
  assert.equal(status.markets[0]?.lastStatus, "NEVER_RUN");
});

test("strategy scheduler schedules configured markets without immediate run by default", () => {
  const scheduledDelays: number[] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "DRY_RUN_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 1_800_000,
        },
        {
          market: "KRW-ETH",
          intervalMs: 2_700_000,
        },
      ],
    },
    controller: createController(),
    now: () => "2026-04-20T00:00:00.000Z",
    setTimer: (callback, delayMs) => {
      scheduledDelays.push(delayMs);
      const timer = setTimeout(callback, 0);
      clearTimeout(timer);
      return timer;
    },
  });

  const status = scheduler.start();

  assert.equal(status.enabled, true);
  assert.equal(status.started, true);
  assert.deepEqual(scheduledDelays, [1_800_000, 2_700_000]);
  assert.equal(status.markets[0]?.nextRunAt, "2026-04-20T00:30:00.000Z");
  assert.equal(status.markets[1]?.nextRunAt, "2026-04-20T00:45:00.000Z");
});

test("strategy scheduler does not start when live startup preflight blocks it", () => {
  const scheduledDelays: number[] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      startupPreflight: {
        checkedAt: "2026-04-20T00:00:00.000Z",
        scope: "LIVE",
        status: "BLOCK",
        detail: "Live scheduler startup blocked by active_orders.",
        checks: [
          {
            name: "active_orders",
            status: "BLOCK",
            detail: "1 active or reconciliation-required order(s) must be resolved first.",
          },
        ],
      },
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 1_800_000,
        },
      ],
    },
    controller: createController(),
    now: () => "2026-04-20T00:00:00.000Z",
    setTimer: (callback, delayMs) => {
      scheduledDelays.push(delayMs);
      const timer = setTimeout(callback, 0);
      clearTimeout(timer);
      return timer;
    },
  });

  const status = scheduler.start();

  assert.equal(status.enabled, true);
  assert.equal(status.started, false);
  assert.equal(status.startupPreflight?.status, "BLOCK");
  assert.deepEqual(scheduledDelays, []);
  assert.equal(status.markets[0]?.lastStatus, "STARTUP_BLOCKED");
  assert.match(status.markets[0]?.lastError ?? "", /active_orders/);
});

test("strategy scheduler records completed run outcomes through the shared run controller", async () => {
  const requests: TelegramStrategyRunRequest[] = [];
  const repository = new InMemoryExecutionRepository();
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "DRY_RUN_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController({
      async requestRun(request) {
        requests.push(request);
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T00:00:00.000Z",
          market: request.market,
          strategyDecisionId: "strategy-decision-1",
          action: "HOLD",
          orderId: null,
          orderStatus: null,
          submissionAccepted: null,
          detail: "Decision HOLD persisted; no order submission was requested.",
        };
      },
    }),
    repositories: repository,
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:02.000Z",
    ]),
  });

  const result = await scheduler.runMarketNow("KRW-BTC");
  const status = scheduler.getStatus();
  const persistedRuns = await repository.listStrategySchedulerRuns("primary", 5);

  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(requests.map((request) => `${request.requestedBy}:${request.requestedCommand}:${request.market}`), [
    "SCHEDULER:SCHEDULER_TICK:KRW-BTC",
  ]);
  assert.equal(status.markets[0]?.runCount, 1);
  assert.equal(status.markets[0]?.successCount, 1);
  assert.equal(status.markets[0]?.failureCount, 0);
  assert.equal(status.markets[0]?.lastStrategyDecisionId, "strategy-decision-1");
  assert.equal(status.markets[0]?.lastAction, "HOLD");
  assert.equal(status.markets[0]?.lastStatus, "COMPLETED");
  assert.equal(persistedRuns.length, 1);
  assert.equal(persistedRuns[0]?.status, "COMPLETED");
  assert.equal(persistedRuns[0]?.strategyDecisionId, "strategy-decision-1");
  assert.equal(persistedRuns[0]?.action, "HOLD");
});

test("strategy scheduler prevents same-market overlapping runs", async () => {
  let releaseRun: (() => void) | undefined;
  const repository = new InMemoryExecutionRepository();
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "DRY_RUN_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController({
      async requestRun(request) {
        await new Promise<void>((resolve) => {
          releaseRun = resolve;
        });
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T00:00:00.000Z",
          market: request.market,
          strategyDecisionId: "strategy-decision-1",
          action: "HOLD",
          orderId: null,
          orderStatus: null,
          submissionAccepted: null,
          detail: "Decision HOLD persisted; no order submission was requested.",
        };
      },
    }),
    repositories: repository,
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:01.000Z",
      "2026-04-20T00:00:02.000Z",
    ]),
  });

  const firstRun = scheduler.runMarketNow("KRW-BTC");
  const skipped = await scheduler.runMarketNow("KRW-BTC");
  const skippedStatus = scheduler.getStatus();
  const release = releaseRun;
  assert.ok(release);
  release();
  await firstRun;
  const finalStatus = scheduler.getStatus();
  const persistedRuns = await repository.listStrategySchedulerRuns("primary", 5);

  assert.equal(skipped.status, "ALREADY_RUNNING");
  assert.equal(skippedStatus.markets[0]?.running, true);
  assert.equal(skippedStatus.markets[0]?.skippedCount, 1);
  assert.equal(finalStatus.markets[0]?.running, false);
  assert.equal(finalStatus.markets[0]?.runCount, 1);
  assert.equal(finalStatus.markets[0]?.successCount, 1);
  assert.equal(finalStatus.markets[0]?.skippedCount, 1);
  assert.deepEqual(
    persistedRuns.map((run) => run.status).sort(),
    ["COMPLETED", "SKIPPED"],
  );
});

function createController(
  overrides: Partial<TelegramStrategyRunController> = {},
): TelegramStrategyRunController {
  return {
    async requestRun(request): Promise<TelegramStrategyRunResult> {
      return {
        status: "COMPLETED",
        requestedAt: "2026-04-20T00:00:00.000Z",
        market: request.market,
        strategyDecisionId: "strategy-decision-1",
        action: "HOLD",
        orderId: null,
        orderStatus: null,
        submissionAccepted: null,
        detail: "Decision HOLD persisted; no order submission was requested.",
      };
    },
    ...overrides,
  };
}

function createNowSequence(values: string[]): () => string {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value ?? "2026-04-20T00:00:00.000Z";
  };
}
