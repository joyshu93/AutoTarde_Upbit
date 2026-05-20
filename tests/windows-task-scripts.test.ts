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

function readTaskScript(scriptName: (typeof taskScriptNames)[number]): string {
  return readFileSync(join(scriptsDirectory, scriptName), "utf8");
}
