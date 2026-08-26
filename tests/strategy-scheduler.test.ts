import assert from "node:assert/strict";

import type { RuntimeOwnershipAuthority } from "../src/app/runtime-ownership-guard.js";
import { StrategyScheduler } from "../src/app/strategy-scheduler.js";
import { InMemoryExecutionRepository } from "../src/modules/db/repositories/in-memory-repositories.js";
import type {
  TelegramStrategyPreviewResult,
  TelegramStrategyRunController,
  TelegramStrategyRunRequest,
  TelegramStrategyRunResult,
} from "../src/modules/telegram/interfaces.js";
import type { OperatorNotificationReporter } from "../src/modules/telegram/reporter.js";
import { test } from "./harness.js";

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

test("strategy scheduler rejects a cycle after runtime ownership is lost", async () => {
  let controllerCalls = 0;
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "DRY_RUN_ADAPTER",
      markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
    },
    controller: {
      async requestRun(): Promise<TelegramStrategyRunResult> {
        controllerCalls += 1;
        throw new Error("controller must not run after ownership loss");
      },
      async requestPreview(): Promise<TelegramStrategyPreviewResult> {
        throw new Error("preview is not used by the scheduler");
      },
    },
    runtimeOwnership: createLostRuntimeOwnershipAuthority(),
  });
  scheduler.stop();

  await assert.rejects(
    () => scheduler.runMarketNow("KRW-BTC"),
    /RUNTIME_OWNERSHIP_LOST/u,
  );

  assert.equal(controllerCalls, 0);
});

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

test("strategy scheduler runs configured run-on-start markets sequentially", async () => {
  const requests: string[] = [];
  const scheduledDelays: number[] = [];
  const repository = new InMemoryExecutionRepository();
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: true,
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
    controller: createController({
      async requestRun(request) {
        requests.push(request.market);
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T00:00:00.000Z",
          market: request.market,
          strategyDecisionId: `strategy-decision-${request.market}`,
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
      "2026-04-20T00:00:03.000Z",
    ]),
    setTimer: (callback, delayMs) => {
      scheduledDelays.push(delayMs);
      const timer = setTimeout(callback, 0);
      clearTimeout(timer);
      return timer;
    },
  });

  const status = scheduler.start();
  await waitForMicrotasks();
  const finalStatus = scheduler.getStatus();
  const persistedRuns = await repository.listStrategySchedulerRuns("primary", 5);

  assert.equal(status.enabled, true);
  assert.equal(status.started, true);
  assert.deepEqual(requests, ["KRW-BTC", "KRW-ETH"]);
  assert.deepEqual(scheduledDelays, [1_800_000, 2_700_000]);
  assert.deepEqual(
    persistedRuns.map((run) => `${run.market}:${run.status}:${run.action}`),
    ["KRW-ETH:COMPLETED:HOLD", "KRW-BTC:COMPLETED:HOLD"],
  );
  assert.equal(finalStatus.markets[0]?.runCount, 1);
  assert.equal(finalStatus.markets[0]?.successCount, 1);
  assert.equal(finalStatus.markets[0]?.skippedCount, 0);
  assert.equal(finalStatus.markets[1]?.runCount, 1);
  assert.equal(finalStatus.markets[1]?.successCount, 1);
  assert.equal(finalStatus.markets[1]?.skippedCount, 0);
});

test("strategy scheduler does not start when live startup preflight blocks it", async () => {
  const scheduledDelays: number[] = [];
  const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
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
    reporter: createReporter(notifications),
    now: () => "2026-04-20T00:00:00.000Z",
    setTimer: (callback, delayMs) => {
      scheduledDelays.push(delayMs);
      const timer = setTimeout(callback, 0);
      clearTimeout(timer);
      return timer;
    },
  });

  const status = scheduler.start();
  const notified = await scheduler.reportStartupBlockIfNeeded();
  const duplicateNotified = await scheduler.reportStartupBlockIfNeeded();

  assert.equal(status.enabled, true);
  assert.equal(status.started, false);
  assert.equal(status.startupPreflight?.status, "BLOCK");
  assert.deepEqual(scheduledDelays, []);
  assert.equal(status.markets[0]?.lastStatus, "STARTUP_BLOCKED");
  assert.match(status.markets[0]?.lastError ?? "", /active_orders/);
  assert.equal(notified, true);
  assert.equal(duplicateNotified, false);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.notificationType, "SCHEDULER_STARTUP_BLOCKED");
  assert.equal(notifications[0]?.severity, "ERROR");
  assert.match(notifications[0]?.message ?? "", /active_orders/);
  assert.equal(notifications[0]?.payload?.scope, "LIVE");
  assert.equal(notifications[0]?.payload?.liveSendPath, "LIVE_ADAPTER");
});

test("strategy scheduler records completed run outcomes through the shared run controller", async () => {
  const requests: TelegramStrategyRunRequest[] = [];
  const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
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
    reporter: createReporter(notifications),
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
  assert.deepEqual(notifications, []);
});

test("strategy scheduler prevents same-market overlapping runs", async () => {
  let releaseRun: (() => void) | undefined;
  const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
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
    reporter: createReporter(notifications),
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
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.notificationType, "SCHEDULER_RUN_SKIPPED");
  assert.equal(notifications[0]?.severity, "WARN");
});

test("strategy scheduler treats async before-run preflight as an in-flight run", async () => {
  let releasePreflight: (() => void) | undefined;
  const repository = new InMemoryExecutionRepository();
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController(),
    repositories: repository,
    beforeRunPreflight: async () => {
      await new Promise<void>((resolve) => {
        releasePreflight = resolve;
      });
      return null;
    },
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:01.000Z",
      "2026-04-20T00:00:02.000Z",
    ]),
  });

  const firstRun = scheduler.runMarketNow("KRW-BTC");
  const skipped = await scheduler.runMarketNow("KRW-BTC");
  const release = releasePreflight;
  assert.ok(release);
  release();
  const firstResult = await firstRun;
  const status = scheduler.getStatus();
  const persistedRuns = await repository.listStrategySchedulerRuns("primary", 5);

  assert.equal(skipped.status, "ALREADY_RUNNING");
  assert.equal(firstResult.status, "COMPLETED");
  assert.equal(status.markets[0]?.runCount, 1);
  assert.equal(status.markets[0]?.skippedCount, 1);
  assert.deepEqual(
    persistedRuns.map((run) => run.status).sort(),
    ["COMPLETED", "SKIPPED"],
  );
});

test("strategy scheduler refreshes account health before live run preflight", async () => {
  let refreshed = false;
  let controllerCalled = false;
  const repository = new InMemoryExecutionRepository();
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController({
      async requestRun(request) {
        controllerCalled = true;
        return createController().requestRun(request);
      },
    }),
    repositories: repository,
    beforeRunAccountRefresh: async () => {
      refreshed = true;
      return {
        status: "COMPLETED",
        requestedAt: "2026-04-20T00:00:00.500Z",
        detail: "Scheduler preflight sync completed.",
      };
    },
    beforeRunPreflight: async () => ({
      checkedAt: "2026-04-20T00:00:01.000Z",
      scope: "LIVE",
      status: refreshed ? "PASS" : "BLOCK",
      detail: refreshed
        ? "Live scheduler startup preflight passed."
        : "Live scheduler startup blocked by balance_snapshot.",
      checks: [
        {
          name: "balance_snapshot",
          status: refreshed ? "PASS" : "BLOCK",
          detail: refreshed ? "fresh account evidence" : "stale account evidence",
        },
      ],
    }),
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:02.000Z",
    ]),
  });

  const result = await scheduler.runMarketNow("KRW-BTC");
  const persistedRuns = await repository.listStrategySchedulerRuns("primary", 5);

  assert.equal(result.status, "COMPLETED");
  assert.equal(controllerCalled, true);
  assert.equal(persistedRuns[0]?.status, "COMPLETED");
});

test("strategy scheduler shares one account refresh across simultaneous market ticks", async () => {
  let releaseRefresh: (() => void) | undefined;
  let refreshCalls = 0;
  const requests: string[] = [];
  const repository = new InMemoryExecutionRepository();
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
        {
          market: "KRW-ETH",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController({
      async requestRun(request) {
        requests.push(request.market);
        return createController().requestRun(request);
      },
    }),
    repositories: repository,
    beforeRunAccountRefresh: async () => {
      refreshCalls += 1;
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      return {
        status: "COMPLETED",
        requestedAt: "2026-04-20T00:00:00.500Z",
        detail: "Scheduler preflight sync completed.",
      };
    },
    beforeRunPreflight: async () => ({
      checkedAt: "2026-04-20T00:00:01.000Z",
      scope: "LIVE",
      status: "PASS",
      detail: "Live scheduler startup preflight passed.",
      checks: [],
    }),
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:02.000Z",
      "2026-04-20T00:00:02.000Z",
    ]),
  });

  const firstRun = scheduler.runMarketNow("KRW-BTC");
  const secondRun = scheduler.runMarketNow("KRW-ETH");
  await waitForMicrotasks();

  assert.equal(refreshCalls, 1);
  const release = releaseRefresh;
  assert.ok(release);
  release();

  const results = await Promise.all([firstRun, secondRun]);
  const persistedRuns = await repository.listStrategySchedulerRuns("primary", 5);

  assert.deepEqual(results.map((result) => result.status), ["COMPLETED", "COMPLETED"]);
  assert.deepEqual(requests.sort(), ["KRW-BTC", "KRW-ETH"]);
  assert.deepEqual(
    persistedRuns.map((run) => run.status).sort(),
    ["COMPLETED", "COMPLETED"],
  );
});

test("strategy scheduler serializes simultaneous scheduled market ticks", async () => {
  let accountRunning = false;
  let firstRunHeld = false;
  let releaseFirstRun: (() => void) | undefined;
  const scheduledCallbacks: Array<() => void> = [];
  const requests: string[] = [];
  const repository = new InMemoryExecutionRepository();
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
        {
          market: "KRW-ETH",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController({
      async requestRun(request) {
        requests.push(request.market);
        if (accountRunning) {
          return {
            status: "ALREADY_RUNNING",
            requestedAt: "2026-04-20T01:00:00.000Z",
            market: request.market,
            strategyDecisionId: null,
            action: null,
            orderId: null,
            orderStatus: null,
            submissionAccepted: null,
            detail: "A strategy run is already running for primary.",
          };
        }

        accountRunning = true;
        if (!firstRunHeld) {
          firstRunHeld = true;
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve;
          });
        }
        accountRunning = false;
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T01:00:00.000Z",
          market: request.market,
          strategyDecisionId: `strategy-decision-${request.market}`,
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
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T01:00:00.000Z",
      "2026-04-20T01:00:00.000Z",
      "2026-04-20T01:00:01.000Z",
      "2026-04-20T01:00:02.000Z",
      "2026-04-20T01:00:03.000Z",
      "2026-04-20T01:00:04.000Z",
    ]),
    setTimer: (callback) => {
      scheduledCallbacks.push(callback);
      const timer = setTimeout(callback, 0);
      clearTimeout(timer);
      return timer;
    },
  });

  scheduler.start();
  assert.equal(scheduledCallbacks.length, 2);

  scheduledCallbacks[0]?.();
  scheduledCallbacks[1]?.();
  await waitForMicrotasks();

  assert.deepEqual(requests, ["KRW-BTC"]);
  const release = releaseFirstRun;
  assert.ok(release);
  release();
  await waitForMicrotasks();
  await waitForMicrotasks();

  const status = scheduler.getStatus();
  const persistedRuns = await repository.listStrategySchedulerRuns("primary", 5);

  assert.deepEqual(requests, ["KRW-BTC", "KRW-ETH"]);
  assert.equal(status.markets[0]?.lastStatus, "COMPLETED");
  assert.equal(status.markets[1]?.lastStatus, "COMPLETED");
  assert.equal(status.markets[0]?.skippedCount, 0);
  assert.equal(status.markets[1]?.skippedCount, 0);
  assert.deepEqual(
    persistedRuns.map((run) => `${run.market}:${run.status}`).sort(),
    ["KRW-BTC:COMPLETED", "KRW-ETH:COMPLETED"],
  );
});

test("strategy scheduler skips remaining same-batch market ticks after an order is submitted", async () => {
  const scheduledCallbacks: Array<() => void> = [];
  const requests: string[] = [];
  const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
  const repository = new InMemoryExecutionRepository();
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
        {
          market: "KRW-ETH",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController({
      async requestRun(request) {
        requests.push(request.market);
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T01:00:00.000Z",
          market: request.market,
          strategyDecisionId: `strategy-decision-${request.market}`,
          action: request.market === "KRW-BTC" ? "REDUCE" : "HOLD",
          orderId: request.market === "KRW-BTC" ? "order-btc-reduce" : null,
          orderStatus: request.market === "KRW-BTC" ? "OPEN" : null,
          submissionAccepted: request.market === "KRW-BTC" ? true : null,
          detail: request.market === "KRW-BTC"
            ? "Decision REDUCE persisted; order submission accepted."
            : "Decision HOLD persisted; no order submission was requested.",
        };
      },
    }),
    repositories: repository,
    reporter: createReporter(notifications),
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T01:00:00.000Z",
      "2026-04-20T01:00:01.000Z",
      "2026-04-20T01:00:02.000Z",
      "2026-04-20T01:00:03.000Z",
      "2026-04-20T01:00:04.000Z",
    ]),
    setTimer: (callback) => {
      scheduledCallbacks.push(callback);
      const timer = setTimeout(callback, 0);
      clearTimeout(timer);
      return timer;
    },
  });

  scheduler.start();
  scheduledCallbacks[0]?.();
  scheduledCallbacks[1]?.();
  await waitForMicrotasks();
  await waitForMicrotasks();
  await waitForMicrotasks();

  const status = scheduler.getStatus();
  const persistedRuns = await repository.listStrategySchedulerRuns("primary", 5);

  assert.deepEqual(requests, ["KRW-BTC"]);
  assert.equal(status.markets[0]?.lastStatus, "COMPLETED");
  assert.equal(status.markets[1]?.lastStatus, "SKIPPED");
  assert.equal(status.markets[1]?.runCount, 0);
  assert.equal(status.markets[1]?.skippedCount, 1);
  assert.deepEqual(
    persistedRuns.map((run) => `${run.market}:${run.status}`).sort(),
    ["KRW-BTC:COMPLETED", "KRW-ETH:SKIPPED"],
  );
  assert.equal(notifications[0]?.notificationType, "SCHEDULER_ORDER_SUBMITTED");
  assert.equal(notifications[1]?.notificationType, "SCHEDULER_RUN_SKIPPED");
});

test("strategy scheduler treats millisecond-staggered same-second timers as one order-deferral batch", async () => {
  const scheduledCallbacks: Array<() => void> = [];
  const requests: string[] = [];
  const repository = new InMemoryExecutionRepository();
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
        {
          market: "KRW-ETH",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController({
      async requestRun(request) {
        requests.push(request.market);
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T01:00:00.000Z",
          market: request.market,
          strategyDecisionId: `strategy-decision-${request.market}`,
          action: request.market === "KRW-BTC" ? "ENTER" : "HOLD",
          orderId: request.market === "KRW-BTC" ? "order-btc-enter" : null,
          orderStatus: request.market === "KRW-BTC" ? "OPEN" : null,
          submissionAccepted: request.market === "KRW-BTC" ? true : null,
          detail: request.market === "KRW-BTC"
            ? "Decision ENTER persisted and submitted through the configured execution path."
            : "Decision HOLD persisted; no order submission was requested.",
        };
      },
    }),
    repositories: repository,
    now: createNowSequence([
      "2026-04-20T00:00:00.100Z",
      "2026-04-20T00:00:00.700Z",
      "2026-04-20T01:00:00.100Z",
      "2026-04-20T01:00:00.700Z",
      "2026-04-20T01:00:01.000Z",
      "2026-04-20T01:00:02.000Z",
      "2026-04-20T01:00:03.000Z",
    ]),
    setTimer: (callback) => {
      scheduledCallbacks.push(callback);
      const timer = setTimeout(callback, 0);
      clearTimeout(timer);
      return timer;
    },
  });

  scheduler.start();
  scheduledCallbacks[0]?.();
  scheduledCallbacks[1]?.();
  await waitForMicrotasks();
  await waitForMicrotasks();
  await waitForMicrotasks();

  const status = scheduler.getStatus();
  const persistedRuns = await repository.listStrategySchedulerRuns("primary", 5);

  assert.deepEqual(requests, ["KRW-BTC"]);
  assert.equal(status.markets[0]?.lastStatus, "COMPLETED");
  assert.equal(status.markets[1]?.lastStatus, "SKIPPED");
  assert.deepEqual(
    persistedRuns.map((run) => `${run.market}:${run.status}`).sort(),
    ["KRW-BTC:COMPLETED", "KRW-ETH:SKIPPED"],
  );
});

test("strategy scheduler blocks a market run when before-run preflight blocks it", async () => {
  let controllerCalled = false;
  const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
  const repository = new InMemoryExecutionRepository();
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController({
      async requestRun(request) {
        controllerCalled = true;
        return createController().requestRun(request);
      },
    }),
    repositories: repository,
    reporter: createReporter(notifications),
    beforeRunPreflight: async () => ({
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
    }),
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:02.000Z",
    ]),
  });

  const result = await scheduler.runMarketNow("KRW-BTC");
  const status = scheduler.getStatus();
  const persistedRuns = await repository.listStrategySchedulerRuns("primary", 5);

  assert.equal(result.status, "FAILED");
  assert.match(result.detail, /active_orders/);
  assert.equal(controllerCalled, false);
  assert.equal(status.markets[0]?.running, false);
  assert.equal(status.markets[0]?.failureCount, 1);
  assert.equal(persistedRuns.length, 1);
  assert.equal(persistedRuns[0]?.status, "FAILED");
  assert.match(persistedRuns[0]?.detail ?? "", /active_orders/);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.notificationType, "SCHEDULER_RUN_FAILED");
});

test("strategy scheduler notifies when a scheduled run submits an order", async () => {
  const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController({
      async requestRun(request) {
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T00:00:00.000Z",
          market: request.market,
          strategyDecisionId: "strategy-decision-1",
          action: "EXIT",
          orderId: "order-1",
          orderStatus: "OPEN",
          submissionAccepted: true,
          detail: "Decision EXIT persisted and submitted through the configured execution path.",
        };
      },
    }),
    reporter: createReporter(notifications),
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:02.000Z",
    ]),
  });

  await scheduler.runMarketNow("KRW-BTC");

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.notificationType, "SCHEDULER_ORDER_SUBMITTED");
  assert.equal(notifications[0]?.severity, "INFO");
  assert.equal(notifications[0]?.payload?.orderId, "order-1");
  assert.equal(notifications[0]?.payload?.liveSendPath, "LIVE_ADAPTER");
});

test("strategy scheduler notifies when a scheduled order is rejected", async () => {
  const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController({
      async requestRun(request) {
        return {
          status: "COMPLETED",
          requestedAt: "2026-04-20T00:00:00.000Z",
          market: request.market,
          strategyDecisionId: "strategy-decision-1",
          action: "EXIT",
          orderId: null,
          orderStatus: null,
          submissionAccepted: false,
          submissionOutcome: "REJECTED",
          detail: "Decision EXIT persisted; order submission rejected: A matching active order already exists.",
        };
      },
    }),
    reporter: createReporter(notifications),
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:02.000Z",
    ]),
  });

  await scheduler.runMarketNow("KRW-BTC");

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.notificationType, "SCHEDULER_ORDER_REJECTED");
  assert.equal(notifications[0]?.severity, "WARN");
  assert.match(notifications[0]?.message ?? "", /A matching active order already exists/);
});

test("strategy scheduler reports reconciliation required as a failed run, not exchange rejection", async () => {
  const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true, runOnStart: false, exchangeAccountId: "primary", liveSendPath: "LIVE_ADAPTER",
      markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
    },
    controller: createController({
      async requestRun(request) {
        return {
          status: "FAILED", requestedAt: "2026-04-20T00:00:00.000Z", market: request.market,
          strategyDecisionId: "strategy-decision-1", action: "EXIT", orderId: "order-1",
          orderStatus: "RECONCILIATION_REQUIRED", submissionAccepted: false,
          submissionOutcome: "RECONCILIATION_REQUIRED", detail: "Order outcome is uncertain and requires reconciliation.",
        };
      },
    }),
    reporter: createReporter(notifications),
    now: createNowSequence(["2026-04-20T00:00:00.000Z", "2026-04-20T00:00:02.000Z"]),
  });

  const result = await scheduler.runMarketNow("KRW-BTC");

  assert.equal(result.status, "FAILED");
  assert.equal(result.submissionOutcome, "RECONCILIATION_REQUIRED");
  assert.equal(notifications[0]?.notificationType, "SCHEDULER_RUN_FAILED");
});

test("strategy scheduler notifies when a scheduled run fails", async () => {
  const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        {
          market: "KRW-BTC",
          intervalMs: 3_600_000,
        },
      ],
    },
    controller: createController({
      async requestRun(request) {
        return {
          status: "FAILED",
          requestedAt: "2026-04-20T00:00:00.000Z",
          market: request.market,
          strategyDecisionId: null,
          action: null,
          orderId: null,
          orderStatus: null,
          submissionAccepted: null,
          detail: "Strategy run failed: ticker unavailable.",
        };
      },
    }),
    reporter: createReporter(notifications),
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:02.000Z",
    ]),
  });

  await scheduler.runMarketNow("KRW-BTC");

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.notificationType, "SCHEDULER_RUN_FAILED");
  assert.equal(notifications[0]?.severity, "ERROR");
  assert.match(notifications[0]?.message ?? "", /ticker unavailable/);
});

test("strategy scheduler defaults preparation ownership to scheduler hooks in order", async () => {
  const calls: string[] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
    },
    controller: createController({
      async requestRun(request) {
        calls.push(`controller:${request.market}`);
        return createController().requestRun(request);
      },
    }),
    beforeRunAccountRefresh: async () => {
      calls.push("refresh");
      return { status: "COMPLETED", requestedAt: "2026-04-20T00:00:00.000Z", detail: "ok" };
    },
    beforeRunPreflight: async () => {
      calls.push("preflight");
      return { checkedAt: "2026-04-20T00:00:01.000Z", scope: "LIVE", status: "PASS", detail: "ok", checks: [] };
    },
    now: createNowSequence(["2026-04-20T00:00:00.000Z", "2026-04-20T00:00:02.000Z"]),
  });

  const result = await scheduler.runMarketNow("KRW-BTC");

  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(calls, ["refresh", "preflight", "controller:KRW-BTC"]);
});

test("strategy scheduler lets controller-owned BTC skip both scheduler preparation hooks", async () => {
  const calls: string[] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
    },
    controller: createController({
      async requestRun(request) {
        calls.push(`controller:${request.market}`);
        return createController().requestRun(request);
      },
    }),
    resolveRunPreparationOwner: (market) => {
      calls.push(`resolve:${market}`);
      return "CONTROLLER";
    },
    beforeRunAccountRefresh: async () => {
      calls.push("refresh");
      return { status: "COMPLETED", requestedAt: "2026-04-20T00:00:00.000Z", detail: "ok" };
    },
    beforeRunPreflight: async () => {
      calls.push("preflight");
      return { checkedAt: "2026-04-20T00:00:01.000Z", scope: "LIVE", status: "PASS", detail: "ok", checks: [] };
    },
    now: createNowSequence(["2026-04-20T00:00:00.000Z", "2026-04-20T00:00:02.000Z"]),
  });

  const result = await scheduler.runMarketNow("KRW-BTC");

  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(calls, ["resolve:KRW-BTC", "controller:KRW-BTC"]);
});

test("strategy scheduler keeps ETH scheduler-owned preparation in order", async () => {
  const calls: string[] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [{ market: "KRW-ETH", intervalMs: 3_600_000 }],
    },
    controller: createController({
      async requestRun(request) {
        calls.push(`controller:${request.market}`);
        return createController().requestRun(request);
      },
    }),
    resolveRunPreparationOwner: (market) => {
      calls.push(`resolve:${market}`);
      return "SCHEDULER";
    },
    beforeRunAccountRefresh: async () => {
      calls.push("refresh");
      return { status: "COMPLETED", requestedAt: "2026-04-20T00:00:00.000Z", detail: "ok" };
    },
    beforeRunPreflight: async () => {
      calls.push("preflight");
      return { checkedAt: "2026-04-20T00:00:01.000Z", scope: "LIVE", status: "PASS", detail: "ok", checks: [] };
    },
    now: createNowSequence(["2026-04-20T00:00:00.000Z", "2026-04-20T00:00:02.000Z"]),
  });

  const result = await scheduler.runMarketNow("KRW-ETH");

  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(calls, ["resolve:KRW-ETH", "refresh", "preflight", "controller:KRW-ETH"]);
});

test("controller-owned BTC neither joins nor suppresses a concurrent scheduler-owned refresh", async () => {
  let releaseRefresh: (() => void) | undefined;
  let refreshCalls = 0;
  const controllerCalls: string[] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        { market: "KRW-BTC", intervalMs: 3_600_000 },
        { market: "KRW-ETH", intervalMs: 3_600_000 },
      ],
    },
    controller: createController({
      async requestRun(request) {
        controllerCalls.push(request.market);
        return createController().requestRun(request);
      },
    }),
    resolveRunPreparationOwner: (market) => market === "KRW-BTC" ? "CONTROLLER" : "SCHEDULER",
    beforeRunAccountRefresh: async () => {
      refreshCalls += 1;
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      return { status: "COMPLETED", requestedAt: "2026-04-20T00:00:00.000Z", detail: "ok" };
    },
    beforeRunPreflight: async () => ({
      checkedAt: "2026-04-20T00:00:01.000Z", scope: "LIVE", status: "PASS", detail: "ok", checks: [],
    }),
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:00.100Z",
      "2026-04-20T00:00:02.000Z",
      "2026-04-20T00:00:02.100Z",
    ]),
  });

  const ethRun = scheduler.runMarketNow("KRW-ETH");
  await waitForMicrotasks();
  const btcRun = scheduler.runMarketNow("KRW-BTC");
  await waitForMicrotasks();

  assert.equal(refreshCalls, 1);
  assert.deepEqual(controllerCalls, ["KRW-BTC"]);
  const release = releaseRefresh;
  assert.ok(release);
  release();

  const results = await Promise.all([ethRun, btcRun]);
  assert.deepEqual(results.map((result) => result.status), ["COMPLETED", "COMPLETED"]);
  assert.deepEqual(controllerCalls.sort(), ["KRW-BTC", "KRW-ETH"]);
});

test("strategy scheduler fails closed when preparation ownership resolution throws or returns invalid data", async () => {
  for (const resolver of [
    () => {
      throw new Error("resolver failed");
    },
    () => "UNSUPPORTED_OWNER",
  ]) {
    const repository = new InMemoryExecutionRepository();
    let refreshCalls = 0;
    let preflightCalls = 0;
    let controllerCalls = 0;
    const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
    const scheduler = new StrategyScheduler({
      config: {
        enabled: true,
        runOnStart: false,
        exchangeAccountId: "primary",
        liveSendPath: "LIVE_ADAPTER",
        markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
      },
      controller: createController({
        async requestRun(request) {
          controllerCalls += 1;
          return createController().requestRun(request);
        },
      }),
      resolveRunPreparationOwner: resolver as unknown as (market: "KRW-BTC" | "KRW-ETH") => "SCHEDULER" | "CONTROLLER",
      repositories: repository,
      reporter: createReporter(notifications),
      beforeRunAccountRefresh: async () => {
        refreshCalls += 1;
        return { status: "COMPLETED", requestedAt: "2026-04-20T00:00:00.000Z", detail: "ok" };
      },
      beforeRunPreflight: async () => {
        preflightCalls += 1;
        return { checkedAt: "2026-04-20T00:00:01.000Z", scope: "LIVE", status: "PASS", detail: "ok", checks: [] };
      },
      now: createNowSequence(["2026-04-20T00:00:00.000Z", "2026-04-20T00:00:02.000Z"]),
    });

    const result = await scheduler.runMarketNow("KRW-BTC");
    const persisted = await repository.listStrategySchedulerRuns("primary", 5);

    assert.equal(result.status, "FAILED");
    assert.equal(refreshCalls, 0);
    assert.equal(preflightCalls, 0);
    assert.equal(controllerCalls, 0);
    assert.equal(persisted[0]?.status, "FAILED");
    assert.match(persisted[0]?.detail ?? "", /preparation ownership/i);
    assert.equal(notifications[0]?.notificationType, "SCHEDULER_RUN_FAILED");
  }
});

test("strategy scheduler never invokes an initial ownership resolver accessor", async () => {
  const repository = new InMemoryExecutionRepository();
  const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
  let refreshCalls = 0;
  let preflightCalls = 0;
  let controllerCalls = 0;
  let accessorCalls = 0;
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
    },
    controller: createController({
      async requestRun(request) {
        controllerCalls += 1;
        return createController().requestRun(request);
      },
    }),
    get resolveRunPreparationOwner(): (market: "KRW-BTC" | "KRW-ETH") => "CONTROLLER" {
      accessorCalls += 1;
      throw new Error("resolver accessor failed");
    },
    repositories: repository,
    reporter: createReporter(notifications),
    beforeRunAccountRefresh: async () => {
      refreshCalls += 1;
      return { status: "COMPLETED", requestedAt: "2026-04-20T00:00:00.000Z", detail: "ok" };
    },
    beforeRunPreflight: async () => {
      preflightCalls += 1;
      return { checkedAt: "2026-04-20T00:00:01.000Z", scope: "LIVE", status: "PASS", detail: "ok", checks: [] };
    },
    now: createNowSequence(["2026-04-20T00:00:00.000Z", "2026-04-20T00:00:02.000Z"]),
  });

  assert.equal(accessorCalls, 0);
  const result = await scheduler.runMarketNow("KRW-BTC");
  const persisted = await repository.listStrategySchedulerRuns("primary", 5);

  assert.equal(result.status, "FAILED");
  assert.equal(accessorCalls, 0);
  assert.equal(refreshCalls, 0);
  assert.equal(preflightCalls, 0);
  assert.equal(controllerCalls, 0);
  assert.equal(persisted[0]?.status, "FAILED");
  assert.equal(notifications[0]?.notificationType, "SCHEDULER_RUN_FAILED");
});

test("strategy scheduler fails closed when its scheduler-owned resolver is replaced after construction", async () => {
  const repository = new InMemoryExecutionRepository();
  const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
  let refreshCalls = 0;
  let preflightCalls = 0;
  let controllerCalls = 0;
  const dependencies: ConstructorParameters<typeof StrategyScheduler>[0] = {
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
    },
    controller: createController({
      async requestRun(request) {
        controllerCalls += 1;
        return createController().requestRun(request);
      },
    }),
    resolveRunPreparationOwner: () => "SCHEDULER",
    repositories: repository,
    reporter: createReporter(notifications),
    beforeRunAccountRefresh: async () => {
      refreshCalls += 1;
      return { status: "COMPLETED", requestedAt: "2026-04-20T00:00:00.000Z", detail: "ok" };
    },
    beforeRunPreflight: async () => {
      preflightCalls += 1;
      return { checkedAt: "2026-04-20T00:00:01.000Z", scope: "LIVE", status: "PASS", detail: "ok", checks: [] };
    },
    now: createNowSequence(["2026-04-20T00:00:00.000Z", "2026-04-20T00:00:02.000Z"]),
  };
  const scheduler = new StrategyScheduler(dependencies);

  dependencies.resolveRunPreparationOwner = () => "CONTROLLER";

  const result = await scheduler.runMarketNow("KRW-BTC");
  const persisted = await repository.listStrategySchedulerRuns("primary", 5);

  assert.equal(result.status, "FAILED");
  assert.equal(refreshCalls, 0);
  assert.equal(preflightCalls, 0);
  assert.equal(controllerCalls, 0);
  assert.equal(persisted[0]?.status, "FAILED");
  assert.match(persisted[0]?.detail ?? "", /preparation ownership/i);
  assert.equal(notifications[0]?.notificationType, "SCHEDULER_RUN_FAILED");
});

test("strategy scheduler fails closed when an omitted resolver is added after construction", async () => {
  const repository = new InMemoryExecutionRepository();
  const notifications: Parameters<OperatorNotificationReporter["report"]>[0][] = [];
  let refreshCalls = 0;
  let preflightCalls = 0;
  let controllerCalls = 0;
  const dependencies: ConstructorParameters<typeof StrategyScheduler>[0] = {
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
    },
    controller: createController({
      async requestRun(request) {
        controllerCalls += 1;
        return createController().requestRun(request);
      },
    }),
    repositories: repository,
    reporter: createReporter(notifications),
    beforeRunAccountRefresh: async () => {
      refreshCalls += 1;
      return { status: "COMPLETED", requestedAt: "2026-04-20T00:00:00.000Z", detail: "ok" };
    },
    beforeRunPreflight: async () => {
      preflightCalls += 1;
      return { checkedAt: "2026-04-20T00:00:01.000Z", scope: "LIVE", status: "PASS", detail: "ok", checks: [] };
    },
    now: createNowSequence(["2026-04-20T00:00:00.000Z", "2026-04-20T00:00:02.000Z"]),
  };
  const scheduler = new StrategyScheduler(dependencies);

  dependencies.resolveRunPreparationOwner = () => "CONTROLLER";

  const result = await scheduler.runMarketNow("KRW-BTC");
  const persisted = await repository.listStrategySchedulerRuns("primary", 5);

  assert.equal(result.status, "FAILED");
  assert.equal(refreshCalls, 0);
  assert.equal(preflightCalls, 0);
  assert.equal(controllerCalls, 0);
  assert.equal(persisted[0]?.status, "FAILED");
  assert.match(persisted[0]?.detail ?? "", /preparation ownership/i);
  assert.equal(notifications[0]?.notificationType, "SCHEDULER_RUN_FAILED");
});

test("strategy scheduler fails closed when the resolver descriptor is removed after construction", async () => {
  const repository = new InMemoryExecutionRepository();
  let refreshCalls = 0;
  let preflightCalls = 0;
  let controllerCalls = 0;
  const dependencies: ConstructorParameters<typeof StrategyScheduler>[0] = {
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
    },
    controller: createController({
      async requestRun(request) {
        controllerCalls += 1;
        return createController().requestRun(request);
      },
    }),
    resolveRunPreparationOwner: () => "SCHEDULER",
    repositories: repository,
    beforeRunAccountRefresh: async () => {
      refreshCalls += 1;
      return { status: "COMPLETED", requestedAt: "2026-04-20T00:00:00.000Z", detail: "ok" };
    },
    beforeRunPreflight: async () => {
      preflightCalls += 1;
      return { checkedAt: "2026-04-20T00:00:01.000Z", scope: "LIVE", status: "PASS", detail: "ok", checks: [] };
    },
    now: createNowSequence(["2026-04-20T00:00:00.000Z", "2026-04-20T00:00:02.000Z"]),
  };
  const scheduler = new StrategyScheduler(dependencies);

  delete dependencies.resolveRunPreparationOwner;

  const result = await scheduler.runMarketNow("KRW-BTC");
  const persisted = await repository.listStrategySchedulerRuns("primary", 5);

  assert.equal(result.status, "FAILED");
  assert.equal(refreshCalls, 0);
  assert.equal(preflightCalls, 0);
  assert.equal(controllerCalls, 0);
  assert.equal(persisted[0]?.status, "FAILED");
  assert.match(persisted[0]?.detail ?? "", /preparation ownership/i);
});

test("same-market running guard skips before a second ownership resolution", async () => {
  let releaseController: (() => void) | undefined;
  let resolverCalls = 0;
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
    },
    controller: createController({
      async requestRun(request) {
        await new Promise<void>((resolve) => {
          releaseController = resolve;
        });
        return createController().requestRun(request);
      },
    }),
    resolveRunPreparationOwner: () => {
      resolverCalls += 1;
      return "CONTROLLER";
    },
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:00.100Z",
      "2026-04-20T00:00:02.000Z",
    ]),
  });

  const first = scheduler.runMarketNow("KRW-BTC");
  await waitForMicrotasks();
  const second = await scheduler.runMarketNow("KRW-BTC");

  assert.equal(second.status, "ALREADY_RUNNING");
  assert.equal(resolverCalls, 1);
  const release = releaseController;
  assert.ok(release);
  release();
  await first;
});

test("same-batch order deferral skips ETH before its preparation ownership resolves", async () => {
  const scheduledCallbacks: Array<() => void> = [];
  const resolvedMarkets: string[] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        { market: "KRW-BTC", intervalMs: 3_600_000 },
        { market: "KRW-ETH", intervalMs: 3_600_000 },
      ],
    },
    controller: createController({
      async requestRun(request) {
        return {
          ...(await createController().requestRun(request)),
          orderId: "order-btc",
          orderStatus: "OPEN",
          submissionAccepted: true,
          action: "ENTER",
        };
      },
    }),
    resolveRunPreparationOwner: (market) => {
      resolvedMarkets.push(market);
      return "CONTROLLER";
    },
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T01:00:00.000Z",
      "2026-04-20T01:00:00.010Z",
      "2026-04-20T01:00:01.000Z",
      "2026-04-20T01:00:02.000Z",
    ]),
    setTimer: (callback) => {
      scheduledCallbacks.push(callback);
      const timer = setTimeout(callback, 0);
      clearTimeout(timer);
      return timer;
    },
  });

  scheduler.start();
  scheduledCallbacks[0]?.();
  scheduledCallbacks[1]?.();
  await waitForMicrotasks();
  await waitForMicrotasks();
  await waitForMicrotasks();

  assert.deepEqual(resolvedMarkets, ["KRW-BTC"]);
  assert.equal(scheduler.getStatus().markets[1]?.lastStatus, "SKIPPED");
});

test("run-on-start resolves ownership per market sequentially before later timers", async () => {
  const calls: string[] = [];
  const scheduledDelays: number[] = [];
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: true,
      exchangeAccountId: "primary",
      liveSendPath: "LIVE_ADAPTER",
      markets: [
        { market: "KRW-BTC", intervalMs: 1_800_000 },
        { market: "KRW-ETH", intervalMs: 2_700_000 },
      ],
    },
    controller: createController({
      async requestRun(request) {
        calls.push(`controller:${request.market}`);
        return createController().requestRun(request);
      },
    }),
    resolveRunPreparationOwner: (market) => {
      calls.push(`resolve:${market}`);
      return market === "KRW-BTC" ? "CONTROLLER" : "SCHEDULER";
    },
    beforeRunAccountRefresh: async () => {
      calls.push("refresh");
      return { status: "COMPLETED", requestedAt: "2026-04-20T00:00:00.000Z", detail: "ok" };
    },
    beforeRunPreflight: async () => {
      calls.push("preflight");
      return { checkedAt: "2026-04-20T00:00:01.000Z", scope: "LIVE", status: "PASS", detail: "ok", checks: [] };
    },
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:01.000Z",
      "2026-04-20T00:00:02.000Z",
      "2026-04-20T00:00:03.000Z",
    ]),
    setTimer: (callback, delayMs) => {
      scheduledDelays.push(delayMs);
      const timer = setTimeout(callback, 0);
      clearTimeout(timer);
      return timer;
    },
  });

  scheduler.start();
  await waitForMicrotasks();
  await waitForMicrotasks();

  assert.deepEqual(calls, [
    "resolve:KRW-BTC",
    "controller:KRW-BTC",
    "resolve:KRW-ETH",
    "refresh",
    "preflight",
    "controller:KRW-ETH",
  ]);
  assert.deepEqual(scheduledDelays, [1_800_000, 2_700_000]);
});

test("strategy scheduler stopAndWait clears timers, rejects new work, and waits for the active run", async () => {
  const activeRun = createDeferred<void>();
  const scheduledCallbacks: Array<() => void> = [];
  let clearTimerCalls = 0;
  let requestRunCalls = 0;
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "DRY_RUN_ADAPTER",
      markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
    },
    controller: createController({
      async requestRun(request) {
        requestRunCalls += 1;
        await activeRun.promise;
        return createController().requestRun(request);
      },
    }),
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:01.000Z",
      "2026-04-20T00:00:02.000Z",
    ]),
    setTimer: (callback) => {
      scheduledCallbacks.push(callback);
      return setTimeout(() => undefined, 60_000);
    },
    clearTimer: (timer) => {
      clearTimerCalls += 1;
      clearTimeout(timer);
    },
  });

  scheduler.start();
  const currentRun = scheduler.runMarketNow("KRW-BTC");
  await waitForMicrotasks();
  let stopResolved = false;
  const stopping = scheduler.stopAndWait(1_000).then((status) => {
    stopResolved = true;
    return status;
  });

  assert.equal(clearTimerCalls, 1);
  assert.throws(() => scheduler.start(), /cannot start after stop/i);
  await assert.rejects(() => scheduler.runMarketNow("KRW-BTC"), /cannot run after stop/i);
  scheduledCallbacks[0]?.();
  await waitForMicrotasks();
  assert.equal(requestRunCalls, 1);
  assert.equal(stopResolved, false);

  activeRun.resolve();
  await currentRun;
  const status = await stopping;
  assert.equal(status.started, false);
  assert.equal(status.quiesced, true);
  assert.equal(status.markets[0]?.running, false);
});

test("strategy scheduler stopAndWait returns at its bound while active work remains visible", async () => {
  const activeRun = createDeferred<void>();
  const scheduler = new StrategyScheduler({
    config: {
      enabled: true,
      runOnStart: false,
      exchangeAccountId: "primary",
      liveSendPath: "DRY_RUN_ADAPTER",
      markets: [{ market: "KRW-BTC", intervalMs: 3_600_000 }],
    },
    controller: createController({
      async requestRun(request) {
        await activeRun.promise;
        return createController().requestRun(request);
      },
    }),
    now: createNowSequence([
      "2026-04-20T00:00:00.000Z",
      "2026-04-20T00:00:01.000Z",
    ]),
  });

  const currentRun = scheduler.runMarketNow("KRW-BTC");
  await waitForMicrotasks();
  const status = await scheduler.stopAndWait(0);

  assert.equal(status.started, false);
  assert.equal(status.quiesced, false);
  assert.equal(status.markets[0]?.running, true);

  activeRun.resolve();
  await currentRun;
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
    async requestPreview(request): Promise<TelegramStrategyPreviewResult> {
      return {
        status: "COMPLETED",
        requestedAt: "2026-04-20T00:00:00.000Z",
        market: request.market,
        action: "HOLD",
        executionDisposition: "SKIPPED",
        referencePrice: 100_000_000,
        requestedNotionalKrw: null,
        requestedQuantity: null,
        orderSide: null,
        orderType: null,
        orderPrice: null,
        orderVolume: null,
        detail: "Decision HOLD computed; no order submission would be requested.",
      };
    },
    ...overrides,
  };
}

function createReporter(
  notifications: Parameters<OperatorNotificationReporter["report"]>[0][],
): OperatorNotificationReporter {
  return {
    async report(input) {
      notifications.push(input);
    },
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

async function waitForMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
