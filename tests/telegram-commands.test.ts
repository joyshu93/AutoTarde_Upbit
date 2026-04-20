import assert from "node:assert/strict";

import { InMemoryExecutionRepository, InMemoryOperatorStateStore } from "../src/modules/db/repositories/in-memory-repositories.js";
import { TelegramCommandRouter } from "../src/modules/telegram/commands.js";
import { test } from "./harness.js";

function createRouter(): TelegramCommandRouter {
  return new TelegramCommandRouter({
    repositories: new InMemoryExecutionRepository(),
    operatorState: new InMemoryOperatorStateStore({
      id: "state-1",
      exchangeAccountId: "primary",
      executionMode: "DRY_RUN",
      liveExecutionGate: "DISABLED",
      systemStatus: "RUNNING",
      killSwitchActive: false,
      pauseReason: null,
      updatedAt: "2026-04-20T00:00:00.000Z",
    }),
  });
}

test("telegram router parses supported operator commands only", () => {
  const router = createRouter();

  const parsed = router.parse("/status");
  assert.equal(parsed?.command, "/status");
  assert.deepEqual(parsed?.args, []);
  assert.equal(parsed?.contract.command, "/status");
  assert.equal(router.parse("/setcash 1000000"), null);
  assert.equal(router.parse("status"), null);
});

test("telegram router pauses and resumes operator state", async () => {
  const router = createRouter();

  const paused = await router.route("/pause maintenance");
  assert.match(paused.text, /system_status: PAUSED/);
  assert.match(paused.text, /pause_reason: maintenance/);

  const resumed = await router.route("/resume");
  assert.match(resumed.text, /system_status: RUNNING/);
});

test("telegram router activates kill switch", async () => {
  const router = createRouter();

  const response = await router.route("/killswitch operator_stop");
  assert.match(response.text, /system_status: KILL_SWITCHED/);
  assert.match(response.text, /kill_switch: on/);
});
