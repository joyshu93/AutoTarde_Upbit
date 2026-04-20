import assert from "node:assert/strict";

import type {
  BalanceSnapshotRecord,
  ExecutionStateRecord,
  OrderRecord,
  PositionSnapshotRecord,
} from "../src/domain/types.js";
import type { ExecutionRepository, OperatorStateStore } from "../src/modules/db/interfaces.js";
import { TelegramCommandRouter } from "../src/modules/telegram/commands.js";
import {
  buildUnsupportedCommandMessage,
  buildUsageMessage,
  parseTelegramCommand,
  validateTelegramCommand,
} from "../src/modules/telegram/contracts.js";
import {
  formatBalanceMessage,
  formatPositionMessage,
} from "../src/modules/telegram/formatter.js";
import type { TelegramSyncResult } from "../src/modules/telegram/interfaces.js";
import { test } from "./harness.js";

test("parseTelegramCommand normalizes bot mentions and preserves arguments", () => {
  const parsed = parseTelegramCommand("/STATUS@autotrade_upbit_bot");

  assert.ok(parsed);
  assert.equal(parsed.command, "/status");
  assert.deepEqual(parsed.args, []);
  assert.equal(parsed.contract.summary, "Show execution mode, live gate, and operator control state.");
});

test("manual input commands are rejected by the operator contract", () => {
  const message = buildUnsupportedCommandMessage("/setposition BTC 0.25 95000000");

  assert.match(message, /Manual cash and position input is not supported in Telegram\./);
  assert.match(message, /\/status \/balances \/positions \/orders \/pause \/resume \/killswitch \/sync/);
});

test("no-argument commands return usage guidance when extra arguments are supplied", () => {
  const parsed = parseTelegramCommand("/resume now");

  assert.ok(parsed);
  assert.equal(
    validateTelegramCommand(parsed),
    buildUsageMessage("/resume"),
  );
});

test("formatters expose stored snapshots and keep Telegram manual input out of scope", () => {
  const balanceSnapshot: BalanceSnapshotRecord = {
    id: "balance-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:00:00.000Z",
    source: "EXCHANGE_POLL",
    totalKrwValue: "1250000",
    balancesJson: JSON.stringify([
      {
        currency: "KRW",
        balance: "250000",
        locked: "0",
        avgBuyPrice: "0",
        unitCurrency: "KRW",
      },
      {
        currency: "BTC",
        balance: "0.01000000",
        locked: "0",
        avgBuyPrice: "100000000",
        unitCurrency: "KRW",
      },
    ]),
  };
  const positionSnapshot: PositionSnapshotRecord = {
    id: "position-1",
    exchangeAccountId: "primary",
    capturedAt: "2026-04-20T00:05:00.000Z",
    source: "RECONCILIATION",
    positionsJson: JSON.stringify([
      {
        asset: "BTC",
        market: "KRW-BTC",
        quantity: "0.01000000",
        averageEntryPrice: "100000000",
        markPrice: "101000000",
        marketValue: "1010000",
        exposureRatio: "0.80",
        capturedAt: "2026-04-20T00:05:00.000Z",
      },
    ]),
  };

  const balancesMessage = formatBalanceMessage(balanceSnapshot);
  const positionsMessage = formatPositionMessage(positionSnapshot);

  assert.match(balancesMessage, /Balances Snapshot/);
  assert.match(balancesMessage, /- BTC free=0\.01000000 locked=0 avg_buy_price=100000000 KRW/);
  assert.match(balancesMessage, /operator_boundary: Telegram does not accept manual cash or position input\./);

  assert.match(positionsMessage, /Positions Snapshot/);
  assert.match(positionsMessage, /- KRW-BTC qty=0\.01000000 avg=100000000 mark=101000000 value=1010000 exposure=0\.80/);
  assert.match(positionsMessage, /operator_boundary: Telegram does not accept manual cash or position input\./);
});

test("router applies control commands, blocks invalid arguments, and advertises sync wiring state", async () => {
  const stateTransitions: string[] = [];
  let currentState = createExecutionState({
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
  });

  const operatorState: OperatorStateStore = {
    async getState() {
      return currentState;
    },
    async pause(reason) {
      stateTransitions.push(`pause:${reason ?? "none"}`);
      currentState = createExecutionState({
        systemStatus: "PAUSED",
        killSwitchActive: false,
        pauseReason: reason ?? "paused_by_operator",
        updatedAt: "2026-04-20T00:01:00.000Z",
      });
      return currentState;
    },
    async resume() {
      stateTransitions.push("resume");
      currentState = createExecutionState({
        systemStatus: "RUNNING",
        killSwitchActive: false,
        pauseReason: null,
        updatedAt: "2026-04-20T00:02:00.000Z",
      });
      return currentState;
    },
    async activateKillSwitch(reason) {
      stateTransitions.push(`killswitch:${reason ?? "none"}`);
      currentState = createExecutionState({
        systemStatus: "KILL_SWITCHED",
        killSwitchActive: true,
        pauseReason: reason ?? "killswitch_activated",
        updatedAt: "2026-04-20T00:03:00.000Z",
      });
      return currentState;
    },
  };

  const router = new TelegramCommandRouter({
    operatorState,
    repositories: createRepositoryStub(),
    now: () => "2026-04-20T00:04:00.000Z",
  });

  const pauseResponse = await router.route("/pause maintenance window");
  const invalidResumeResponse = await router.route("/resume now");
  const unsupportedInputResponse = await router.route("/setcash 100000");
  const syncResponse = await router.route("/sync");

  assert.match(pauseResponse.text, /Execution Control/);
  assert.match(pauseResponse.text, /command: \/pause/);
  assert.match(pauseResponse.text, /pause_reason: maintenance window/);
  assert.deepEqual(stateTransitions, ["pause:maintenance window"]);

  assert.equal(
    invalidResumeResponse.text,
    "Usage: /resume\nResume execution when the kill switch is clear.",
  );
  assert.deepEqual(stateTransitions, ["pause:maintenance window"]);

  assert.match(unsupportedInputResponse.text, /Manual cash and position input is not supported in Telegram\./);
  assert.match(syncResponse.text, /status: NOT_CONNECTED/);
  assert.match(syncResponse.text, /requested_at: 2026-04-20T00:04:00.000Z/);
});

test("router surfaces a wired sync controller when available", async () => {
  const syncRequests: string[] = [];
  const router = new TelegramCommandRouter({
    operatorState: createOperatorStateStub(),
    repositories: createRepositoryStub(),
    syncController: {
      async requestSync(request): Promise<TelegramSyncResult> {
        syncRequests.push(`${request.exchangeAccountId}:${request.requestedCommand}`);
        return {
          status: "REQUESTED",
          requestedAt: "2026-04-20T00:10:00.000Z",
          detail: "Reconciliation run queued for the primary account.",
        };
      },
    },
  });

  const response = await router.route("/sync");

  assert.deepEqual(syncRequests, ["primary:/sync"]);
  assert.match(response.text, /status: REQUESTED/);
  assert.match(response.text, /detail: Reconciliation run queued for the primary account\./);
});

function createExecutionState(
  overrides: Partial<ExecutionStateRecord> = {},
): ExecutionStateRecord {
  return {
    id: "execution-state-1",
    exchangeAccountId: "primary",
    executionMode: "DRY_RUN",
    liveExecutionGate: "DISABLED",
    systemStatus: "RUNNING",
    killSwitchActive: false,
    pauseReason: null,
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  };
}

function createOperatorStateStub(): OperatorStateStore {
  return {
    async getState() {
      return createExecutionState();
    },
    async pause(reason) {
      return createExecutionState({
        systemStatus: "PAUSED",
        pauseReason: reason ?? "paused_by_operator",
      });
    },
    async resume() {
      return createExecutionState({
        systemStatus: "RUNNING",
        pauseReason: null,
      });
    },
    async activateKillSwitch(reason) {
      return createExecutionState({
        systemStatus: "KILL_SWITCHED",
        killSwitchActive: true,
        pauseReason: reason ?? "killswitch_activated",
      });
    },
  };
}

function createRepositoryStub(overrides: Partial<ExecutionRepository> = {}): ExecutionRepository {
  const orders: OrderRecord[] = [];

  return {
    async saveStrategyDecision() {},
    async saveOrder(record) {
      orders.push(record);
    },
    async updateOrder() {},
    async findOrderByIdempotencyKey() {
      return null;
    },
    async listActiveOrders() {
      return [];
    },
    async listOrders() {
      return orders;
    },
    async appendOrderEvent() {},
    async saveFill() {},
    async listFills() {
      return [];
    },
    async saveBalanceSnapshot() {},
    async getLatestBalanceSnapshot() {
      return null;
    },
    async savePositionSnapshot() {},
    async getLatestPositionSnapshot() {
      return null;
    },
    async getPortfolioExposure() {
      return {
        totalEquityKrw: 0,
        totalExposureKrw: 0,
        assetExposureKrw: {
          BTC: 0,
          ETH: 0,
        },
      };
    },
    async saveRiskEvent() {},
    async listRiskEvents() {
      return [];
    },
    async saveReconciliationRun() {},
    async updateReconciliationRun() {},
    ...overrides,
  };
}
