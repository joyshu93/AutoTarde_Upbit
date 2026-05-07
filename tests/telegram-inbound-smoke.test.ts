import assert from "node:assert/strict";

import { loadAppConfig } from "../src/app/env.js";
import {
  applyTelegramInboundSmokeSafetyEnv,
  validateTelegramInboundSmokeSafety,
} from "../src/smoke/telegram-inbound-once.js";
import { test } from "./harness.js";

test("telegram inbound smoke env forces dry-run and disables live/scheduler paths", () => {
  const env: NodeJS.ProcessEnv = {
    APP_EXECUTION_MODE: "LIVE",
    ENABLE_LIVE_ORDERS: "true",
    STRATEGY_SCHEDULER_ENABLED: "true",
    STRATEGY_SCHEDULER_RUN_ON_START: "true",
    ENABLE_TELEGRAM_INBOUND_POLLING: "false",
    TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS: "25",
    TELEGRAM_INBOUND_POLL_LIMIT: "10",
  };

  const report = applyTelegramInboundSmokeSafetyEnv(env);
  const config = loadAppConfig(env);

  assert.equal(report.previous.APP_EXECUTION_MODE, "LIVE");
  assert.equal(report.previous.ENABLE_LIVE_ORDERS, "true");
  assert.equal(env.APP_EXECUTION_MODE, "DRY_RUN");
  assert.equal(env.ENABLE_LIVE_ORDERS, "false");
  assert.equal(env.STRATEGY_SCHEDULER_ENABLED, "false");
  assert.equal(env.STRATEGY_SCHEDULER_RUN_ON_START, "false");
  assert.equal(env.ENABLE_TELEGRAM_INBOUND_POLLING, "true");
  assert.equal(env.TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS, "0");
  assert.equal(env.TELEGRAM_INBOUND_POLL_LIMIT, "1");
  assert.equal(config.executionMode, "DRY_RUN");
  assert.equal(config.liveExecutionGate, "DISABLED");
  assert.equal(config.strategySchedulerEnabled, false);
  assert.equal(config.strategySchedulerRunOnStart, false);
  assert.equal(config.telegramInboundPollingEnabled, true);
  assert.equal(config.telegramInboundPollTimeoutSeconds, 0);
  assert.equal(config.telegramInboundPollLimit, 1);
  assert.deepEqual(validateTelegramInboundSmokeSafety(config), []);
});

test("telegram inbound smoke safety validator blocks non-smoke runtime settings", () => {
  const config = loadAppConfig({
    APP_EXECUTION_MODE: "LIVE",
    ENABLE_LIVE_ORDERS: "true",
    STRATEGY_SCHEDULER_ENABLED: "true",
    STRATEGY_SCHEDULER_RUN_ON_START: "true",
    ENABLE_TELEGRAM_INBOUND_POLLING: "false",
    TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS: "25",
    TELEGRAM_INBOUND_POLL_LIMIT: "10",
  });

  assert.deepEqual(validateTelegramInboundSmokeSafety(config), [
    "APP_EXECUTION_MODE must resolve to DRY_RUN for telegram inbound smoke.",
    "ENABLE_LIVE_ORDERS must resolve to DISABLED for telegram inbound smoke.",
    "STRATEGY_SCHEDULER_ENABLED must be false for telegram inbound smoke.",
    "STRATEGY_SCHEDULER_RUN_ON_START must be false for telegram inbound smoke.",
    "ENABLE_TELEGRAM_INBOUND_POLLING must be true for telegram inbound smoke.",
    "TELEGRAM_INBOUND_POLL_TIMEOUT_SECONDS must be 0 for a non-blocking smoke poll.",
    "TELEGRAM_INBOUND_POLL_LIMIT must be 1 for a bounded smoke poll.",
  ]);
});
