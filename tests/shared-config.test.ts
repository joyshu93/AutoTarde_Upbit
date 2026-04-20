import assert from "node:assert/strict";

import { loadConfig } from "../src/shared/config.js";
import { test } from "./harness.js";

test("shared config defaults to DRY_RUN with live orders disabled", () => {
  const config = loadConfig({} as NodeJS.ProcessEnv);

  assert.equal(config.trading.mode, "DRY_RUN");
  assert.equal(config.trading.liveOrdersEnabled, false);
  assert.deepEqual(config.trading.approvedSymbols, ["KRW-BTC", "KRW-ETH"]);
  assert.equal(config.controls.startPaused, false);
  assert.equal(config.controls.killSwitchEnabled, false);
  assert.deepEqual(config.startupWarnings, []);
});

test("shared config falls back safely when mode flags are invalid", () => {
  const config = loadConfig({
    TRADING_MODE: "paper",
    ENABLE_LIVE_ORDERS: "sometimes",
  } as NodeJS.ProcessEnv);

  assert.equal(config.trading.mode, "DRY_RUN");
  assert.equal(config.trading.liveOrdersEnabled, false);
  assert.match(
    config.startupWarnings.join("\n"),
    /Invalid TRADING_MODE value "paper" detected; falling back to DRY_RUN\./,
  );
  assert.match(
    config.startupWarnings.join("\n"),
    /Invalid ENABLE_LIVE_ORDERS value "sometimes" detected; falling back to false\./,
  );
});

test("shared config refuses LIVE startup when required safety gates are missing", () => {
  assert.throws(
    () =>
      loadConfig({
        TRADING_MODE: "LIVE",
        ENABLE_LIVE_ORDERS: "true",
      } as NodeJS.ProcessEnv),
    /LIVE startup validation failed:/,
  );
});
