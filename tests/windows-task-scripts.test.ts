import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { test } from "./harness.js";

const scriptsDirectory = join(process.cwd(), "scripts");

const taskScriptNames = [
  "register-autotrade-dryrun-task.example.ps1",
  "register-autotrade-live-scheduler-task.example.ps1",
  "unregister-autotrade-task.example.ps1",
] as const;

const localRuntimeScriptNames = [
  "start-company-dryrun.example.ps1",
  "start-company-dryrun-scheduler.example.ps1",
  "smoke-dryrun-readiness.example.ps1",
  "smoke-dryrun-sync.example.ps1",
  "smoke-dryrun-completion.example.ps1",
  "start-company-live.example.ps1",
  "start-company-live-scheduler.example.ps1",
  "smoke-live-readiness.example.ps1",
] as const;

const forbiddenSecretAssignments =
  /\$env:(UPBIT_ACCESS_KEY|UPBIT_SECRET_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_OPERATOR_CHAT_ID)\s*=/;
const forbiddenAutostartTriggers =
  /\b(New-ScheduledTaskTrigger|-AtStartup|-AtLogOn|StartWhenAvailable|schtasks\s+\/create\s+.*\/sc\s+(onstart|onlogon))/i;
const forbiddenAutomaticRestart = /\b(RestartCount|RestartInterval)\b/;

test("Windows task helper scripts do not store secrets or create autostart triggers", () => {
  for (const scriptName of taskScriptNames) {
    const script = readTaskScript(scriptName);

    assert.doesNotMatch(script, forbiddenSecretAssignments, `${scriptName} must not assign API or Telegram secrets`);
    assert.doesNotMatch(script, forbiddenAutostartTriggers, `${scriptName} must not register startup/logon triggers`);
    assert.doesNotMatch(script, forbiddenAutomaticRestart, `${scriptName} must not configure automatic restarts`);
    assert.doesNotMatch(script, /^\s*Start-ScheduledTask\b/m, `${scriptName} must not start a task after registration`);
    assert.match(script, /\.local\.ps1/, `${scriptName} should only target ignored local scripts`);
  }
});

test("LIVE scheduler task registration requires explicit live and scheduler confirmations", () => {
  const script = readTaskScript("register-autotrade-live-scheduler-task.example.ps1");

  assert.match(script, /I_UNDERSTAND_REAL_ORDERS/);
  assert.match(script, /I_UNDERSTAND_AUTOMATIC_SCHEDULED_ORDERS/);
  assert.match(script, /I_UNDERSTAND_THIS_TASK_HAS_NO_AUTOSTART_TRIGGER/);
  assert.match(script, /start-company-live-scheduler\.local\.ps1/);
});

test("LIVE scheduler task registration preserves run-on-start and preflight safety", () => {
  const script = readTaskScript("register-autotrade-live-scheduler-task.example.ps1");

  assert.match(script, /STRATEGY_SCHEDULER_RUN_ON_START\\s\*=\\s\*"false"/);
  assert.match(script, /smoke:live:scheduler-preflight/);
});

test("DRY_RUN task registration only targets the DRY_RUN local launcher", () => {
  const script = readTaskScript("register-autotrade-dryrun-task.example.ps1");

  assert.match(script, /AutoTrade_Upbit_DRY_RUN_Manual/);
  assert.match(script, /start-company-dryrun\.local\.ps1/);
  assert.doesNotMatch(script, /start-company-live-scheduler\.local\.ps1/);
});

test("task unregister helper is constrained to approved AutoTrade task names", () => {
  const script = readTaskScript("unregister-autotrade-task.example.ps1");

  assert.match(script, /AutoTrade_Upbit_DRY_RUN_Manual/);
  assert.match(script, /AutoTrade_Upbit_LIVE_Scheduler_Manual/);
  assert.match(script, /AllowedTaskNames/);
});

test("DRY_RUN local scripts keep live orders disabled and run readiness smoke", () => {
  for (const scriptName of ["start-company-dryrun.example.ps1", "smoke-dryrun-readiness.example.ps1"] as const) {
    const script = readLocalRuntimeScript(scriptName);

    assert.match(script, /APP_EXECUTION_MODE\s*=\s*"DRY_RUN"/);
    assert.match(script, /ENABLE_LIVE_ORDERS\s*=\s*"false"/);
    assert.match(script, /STRATEGY_SCHEDULER_ENABLED\s*=\s*"false"/);
    assert.match(script, /STRATEGY_SCHEDULER_RUN_ON_START\s*=\s*"false"/);
    assert.match(script, /REPLACE_WITH_UPBIT_ACCESS_KEY/);
    assert.match(script, /REPLACE_WITH_TELEGRAM_BOT_TOKEN/);
    assert.match(script, /smoke:dryrun:readiness/);
    assert.doesNotMatch(script, /smoke:live:readiness/);
  }
});

test("DRY_RUN startup script refuses placeholder credentials before runtime start", () => {
  const script = readLocalRuntimeScript("start-company-dryrun.example.ps1");

  assert.match(script, /Refusing to start DRY_RUN mode because \$name is not configured/);
  assert.match(script, /StartsWith\("REPLACE_WITH_"\)/);
  assert.match(script, /npm\.cmd run smoke:dryrun:readiness/);
  assert.match(script, /npm\.cmd run start/);
});

test("DRY_RUN scheduler startup script keeps live orders disabled while enabling scheduler rehearsal", () => {
  const script = readLocalRuntimeScript("start-company-dryrun-scheduler.example.ps1");

  assert.match(script, /I_UNDERSTAND_DRY_RUN_SCHEDULED_ORDERS/);
  assert.match(script, /APP_EXECUTION_MODE\s*=\s*"DRY_RUN"/);
  assert.match(script, /ENABLE_LIVE_ORDERS\s*=\s*"false"/);
  assert.match(script, /ENABLE_TELEGRAM_INBOUND_POLLING\s*=\s*"true"/);
  assert.match(script, /ENABLE_TELEGRAM_DELIVERY\s*=\s*"true"/);
  assert.match(script, /STRATEGY_SCHEDULER_ENABLED\s*=\s*"true"/);
  assert.match(script, /STRATEGY_SCHEDULER_RUN_ON_START\s*=\s*"true"/);
  assert.match(script, /STRATEGY_SCHEDULER_BTC_INTERVAL_MS\s*=\s*"3600000"/);
  assert.match(script, /STRATEGY_SCHEDULER_ETH_INTERVAL_MS\s*=\s*"3600000"/);
  assert.match(script, /REPLACE_WITH_UPBIT_ACCESS_KEY/);
  assert.match(script, /REPLACE_WITH_TELEGRAM_BOT_TOKEN/);
  assert.match(script, /smoke:dryrun:sync/);
  assert.match(script, /smoke:dryrun:readiness/);
  assert.match(script, /npm\.cmd run start/);
  assert.match(script, /\$LASTEXITCODE/);
  assert.doesNotMatch(script, /APP_EXECUTION_MODE\s*=\s*"LIVE"/);
  assert.doesNotMatch(script, /ENABLE_LIVE_ORDERS\s*=\s*"true"/);
  assert.doesNotMatch(script, /smoke:live/);
});

test("DRY_RUN sync smoke script keeps live orders, Telegram, scheduler, and strategy disabled", () => {
  const script = readLocalRuntimeScript("smoke-dryrun-sync.example.ps1");

  assert.match(script, /APP_EXECUTION_MODE\s*=\s*"DRY_RUN"/);
  assert.match(script, /ENABLE_LIVE_ORDERS\s*=\s*"false"/);
  assert.match(script, /ENABLE_TELEGRAM_INBOUND_POLLING\s*=\s*"false"/);
  assert.match(script, /ENABLE_TELEGRAM_DELIVERY\s*=\s*"false"/);
  assert.match(script, /STRATEGY_SCHEDULER_ENABLED\s*=\s*"false"/);
  assert.match(script, /STRATEGY_SCHEDULER_RUN_ON_START\s*=\s*"false"/);
  assert.match(script, /REPLACE_WITH_UPBIT_ACCESS_KEY/);
  assert.match(script, /Refusing to run DRY_RUN sync smoke because \$name is not configured/);
  assert.match(script, /smoke:dryrun:sync/);
  assert.doesNotMatch(script, /\/run BTC/);
  assert.doesNotMatch(script, /smoke:live/);
});

test("DRY_RUN completion smoke script reads persisted automatic evidence without starting transport or scheduler", () => {
  const script = readLocalRuntimeScript("smoke-dryrun-completion.example.ps1");

  assert.match(script, /APP_EXECUTION_MODE\s*=\s*"DRY_RUN"/);
  assert.match(script, /ENABLE_LIVE_ORDERS\s*=\s*"false"/);
  assert.match(script, /ENABLE_TELEGRAM_INBOUND_POLLING\s*=\s*"false"/);
  assert.match(script, /ENABLE_TELEGRAM_DELIVERY\s*=\s*"false"/);
  assert.match(script, /STRATEGY_SCHEDULER_ENABLED\s*=\s*"false"/);
  assert.match(script, /STRATEGY_SCHEDULER_RUN_ON_START\s*=\s*"false"/);
  assert.match(script, /REPLACE_WITH_UPBIT_ACCESS_KEY/);
  assert.match(script, /REPLACE_WITH_TELEGRAM_BOT_TOKEN/);
  assert.match(script, /Refusing to run DRY_RUN completion smoke because \$name is not configured/);
  assert.match(script, /smoke:dryrun:completion/);
  assert.doesNotMatch(script, /\/sync/);
  assert.doesNotMatch(script, /\/run BTC/);
  assert.doesNotMatch(script, /npm\.cmd run start/);
  assert.doesNotMatch(script, /smoke:live/);
});

test("LIVE startup script refuses to start when readiness smoke blocks", () => {
  const script = readLocalRuntimeScript("start-company-live.example.ps1");

  assert.match(script, /I_UNDERSTAND_REAL_ORDERS/);
  assert.match(script, /APP_EXECUTION_MODE\s*=\s*"LIVE"/);
  assert.match(script, /ENABLE_LIVE_ORDERS\s*=\s*"true"/);
  assert.match(script, /STRATEGY_SCHEDULER_ENABLED\s*=\s*"false"/);
  assert.match(script, /STRATEGY_SCHEDULER_RUN_ON_START\s*=\s*"false"/);
  assert.match(script, /npm\.cmd run smoke:live:readiness/);
  assert.match(script, /\$LASTEXITCODE -ne 0/);
  assert.match(script, /Refusing to start LIVE mode because smoke:live:readiness failed/);
  assert.match(script, /npm\.cmd run start/);
});

test("LIVE scheduler startup script refuses to start when scheduler preflight smoke blocks", () => {
  const script = readLocalRuntimeScript("start-company-live-scheduler.example.ps1");

  assert.match(script, /I_UNDERSTAND_REAL_ORDERS/);
  assert.match(script, /I_UNDERSTAND_AUTOMATIC_SCHEDULED_ORDERS/);
  assert.match(script, /APP_EXECUTION_MODE\s*=\s*"LIVE"/);
  assert.match(script, /ENABLE_LIVE_ORDERS\s*=\s*"true"/);
  assert.match(script, /STRATEGY_SCHEDULER_ENABLED\s*=\s*"true"/);
  assert.match(script, /STRATEGY_SCHEDULER_RUN_ON_START\s*=\s*"false"/);
  assert.match(script, /npm\.cmd run smoke:live:scheduler-preflight/);
  assert.match(script, /\$LASTEXITCODE -ne 0/);
  assert.match(script, /Refusing to start LIVE scheduler mode because smoke:live:scheduler-preflight failed/);
  assert.match(script, /npm\.cmd run start/);
});

function readTaskScript(scriptName: (typeof taskScriptNames)[number]): string {
  return readFileSync(join(scriptsDirectory, scriptName), "utf8");
}

function readLocalRuntimeScript(scriptName: (typeof localRuntimeScriptNames)[number]): string {
  return readFileSync(join(scriptsDirectory, scriptName), "utf8");
}
