import assert from "node:assert/strict";

import { buildExecutionPolicy, loadAppConfig } from "../src/app/env.js";
import { test } from "./harness.js";

test("loadAppConfig defaults to DRY_RUN with live gate disabled", () => {
  const config = loadAppConfig({});

  assert.equal(config.executionMode, "DRY_RUN");
  assert.equal(config.liveExecutionGate, "DISABLED");
  assert.equal(config.globalKillSwitch, false);

  const policy = buildExecutionPolicy(config);
  assert.equal(policy.executionMode, "DRY_RUN");
  assert.equal(policy.liveExecutionGate, "DISABLED");
});

test("loadAppConfig allows LIVE only when explicitly requested", () => {
  const config = loadAppConfig({
    APP_EXECUTION_MODE: "LIVE",
    ENABLE_LIVE_ORDERS: "true",
  });

  assert.equal(config.executionMode, "LIVE");
  assert.equal(config.liveExecutionGate, "ENABLED");
});
