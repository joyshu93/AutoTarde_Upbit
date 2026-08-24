import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

const pilotReadinessScriptName = "inspect-btc-pilot-readiness.example.ps1";

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

test("BTC pilot readiness example requires explicit read-only inspection inputs", () => {
  const script = readPilotReadinessScript();

  assert.match(script, /inspect:btc-pilot:readiness/);
  assert.match(script, /Mandatory\s*=\s*\$true[\s\S]*\$DatabasePath/);
  assert.match(script, /Test-Path[\s\S]*\$DatabasePath[\s\S]*PathType\s+Leaf/);
  assert.match(script, /--database-path[\s\S]*\$DatabasePath/);
  assert.match(script, /--exchange-account-id[\s\S]*\$ExchangeAccountId/);
  assert.match(script, /--deployment-id[\s\S]*\$DeploymentId/);
  assert.match(script, /--freshness-threshold-ms[\s\S]*\$FreshnessThresholdMs/);
  assert.match(script, /BTC_COMBINED_CONSERVATIVE_PILOT_V1/);
  assert.match(script, /KRW-BTC/);
  assert.match(script, /COMBINED_CONSERVATIVE/);
  assert.match(script, /PCS-2026-001\.DEPLOYMENT_READINESS_V1/);
});

test("BTC pilot readiness example defaults policy selection to BASELINE", () => {
  const script = readPilotReadinessScript();

  assert.match(script, /APP_EXECUTION_MODE\s*=\s*"DRY_RUN"/);
  assert.match(script, /Remove-Item\s+Env:\\POSITION_GUARD_PILOT_ID\b/);
  assert.match(script, /Remove-Item\s+Env:\\POSITION_GUARD_PILOT_CONFIRMATION\b/);
  assert.doesNotMatch(script, /APP_EXECUTION_MODE\s*=\s*"LIVE"/);
  assert.doesNotMatch(script, /\$env:POSITION_GUARD_PILOT_ID\s*=/);
  assert.doesNotMatch(script, /\$env:POSITION_GUARD_PILOT_CONFIRMATION\s*=/);
  assert.doesNotMatch(script, /I_UNDERSTAND_BTC_CANDIDATE_LIVE_PILOT/);
});

test("BTC pilot readiness example exposes exactly one allowlisted readiness executable", () => {
  assertPilotReadinessAstSafe(join(scriptsDirectory, pilotReadinessScriptName));
});

test("BTC pilot readiness AST allowlist rejects unsafe executable mutations", () => {
  const original = readPilotReadinessScript();
  const mutations = [
    {
      name: "database removal",
      source: `${original}\nRemove-Item -LiteralPath $DatabasePath\n`,
    },
    {
      name: "wrong Test-Path target",
      source: original.replace(
        "Test-Path -LiteralPath $DatabasePath -PathType Leaf",
        "Test-Path -LiteralPath $PSScriptRoot -PathType Leaf",
      ),
    },
    {
      name: "wrong Resolve-Path target",
      source: original.replace(
        "Resolve-Path -LiteralPath $DatabasePath",
        "Resolve-Path -LiteralPath $PSScriptRoot",
      ),
    },
    {
      name: "wrong Push-Location target",
      source: original.replace(
        "Push-Location -LiteralPath $RepositoryRoot",
        "Push-Location -LiteralPath $DatabasePath",
      ),
    },
    {
      name: "altered Pop-Location",
      source: original.replace("Pop-Location", "Pop-Location -StackName unsafe"),
    },
    {
      name: "static file deletion",
      source: `${original}\n[IO.File]::Delete($DatabasePath)\n`,
    },
    {
      name: "dynamic member invocation",
      source: `${original}\n$unsafeMember = "Delete"\n[IO.File]::$unsafeMember($DatabasePath)\n`,
    },
    {
      name: "different npm run",
      source: original.replace(
        "npm.cmd run inspect:btc-pilot:readiness",
        "npm.cmd run start",
      ),
    },
  ] as const;
  const temporaryRoot = mkdtempSync(join(tmpdir(), "autotrade-pilot-ast-mutations-"));

  try {
    for (const mutation of mutations) {
      assert.notEqual(mutation.source, original, `${mutation.name} mutation must change the fixture`);
      const scriptPath = join(temporaryRoot, `${mutation.name.replaceAll(" ", "-")}.ps1`);
      writeFileSync(scriptPath, mutation.source, "utf8");
      assert.throws(
        () => assertPilotReadinessAstSafe(scriptPath),
        `${mutation.name} must be rejected by the AST allowlist`,
      );
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("BTC pilot readiness AST shape rejects a top-level conditional exit override", () => {
  const original = readPilotReadinessScript();
  const mutation = `${original}\nif (-not $env:FAKE_NPM_EXIT_CODE) { $inspectionExitCode = 0 }\n`;

  assertPilotReadinessMutationRejected("top-level-conditional-exit-override", mutation, original);
});

test("BTC pilot readiness AST shape rejects an exit override inside the native-call try block", () => {
  const original = readPilotReadinessScript();
  const mutation = original.replace(
    "  $inspectionExitCode = $LASTEXITCODE\n",
    "  $inspectionExitCode = $LASTEXITCODE\n  if (-not $env:FAKE_NPM_EXIT_CODE) { $inspectionExitCode = 0 }\n",
  );

  assertPilotReadinessMutationRejected("try-block-exit-override", mutation, original);
});

test("BTC pilot readiness AST shape rejects a function-definition command shadow", () => {
  const original = readPilotReadinessScript();
  const mutation = original.replace(
    "$inspectionExitCode = 1\n",
    "function npm.cmd { $global:LASTEXITCODE = 0 }\n$inspectionExitCode = 1\n",
  );

  assertPilotReadinessMutationRejected("function-command-shadow", mutation, original);
});

test("BTC pilot readiness AST shape ignores comments without relaxing executable structure", () => {
  const original = readPilotReadinessScript();
  const mutation = original.replace(
    "try {\n  npm.cmd",
    "try {\n  # Review comments may change without changing executable behavior.\n  npm.cmd",
  );
  const temporaryRoot = mkdtempSync(join(tmpdir(), "autotrade-pilot-ast-comments-"));
  const scriptPath = join(temporaryRoot, "comment-only-change.ps1");

  try {
    assert.notEqual(mutation, original, "comment-only mutation must change the fixture");
    writeFileSync(scriptPath, mutation, "utf8");
    assert.doesNotThrow(() => assertPilotReadinessAstSafe(scriptPath));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function assertPilotReadinessMutationRejected(
  name: string,
  mutation: string,
  original: string,
): void {
  assert.notEqual(mutation, original, `${name} mutation must change the fixture`);
  const temporaryRoot = mkdtempSync(join(tmpdir(), "autotrade-pilot-ast-shape-"));
  const scriptPath = join(temporaryRoot, `${name}.ps1`);

  try {
    writeFileSync(scriptPath, mutation, "utf8");
    assert.throws(
      () => assertPilotReadinessAstSafe(scriptPath),
      `${name} must be rejected by the complete AST shape check`,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function assertPilotReadinessAstSafe(scriptPath: string): void {
  const ast = inspectPowerShellAst(scriptPath);
  const commands = ast.commands.map((command) => ({
    name: command.name,
    text: normalizePowerShellExtent(command.text),
  }));

  assert.deepEqual(commands, [
    {
      name: "Test-Path",
      text: "Test-Path -LiteralPath $DatabasePath -PathType Leaf",
    },
    {
      name: "Resolve-Path",
      text: "Resolve-Path -LiteralPath $DatabasePath",
    },
    {
      name: "Remove-Item",
      text: "Remove-Item Env:\\POSITION_GUARD_PILOT_ID -ErrorAction SilentlyContinue",
    },
    {
      name: "Remove-Item",
      text: "Remove-Item Env:\\POSITION_GUARD_PILOT_CONFIRMATION -ErrorAction SilentlyContinue",
    },
    {
      name: "Write-Host",
      text: 'Write-Host "Inspecting persisted BTC pilot readiness with BASELINE policy selection and without activation."',
    },
    {
      name: "Write-Host",
      text: 'Write-Host "pilot=$PilotId market=$PilotMarket policy=$PilotPolicy version=$PilotPolicyVersion"',
    },
    {
      name: "Write-Host",
      text: 'Write-Host "database=$DatabasePath deployment=$DeploymentId account=$ExchangeAccountId"',
    },
    {
      name: "Push-Location",
      text: "Push-Location -LiteralPath $RepositoryRoot",
    },
    {
      name: "npm.cmd",
      text: "npm.cmd run inspect:btc-pilot:readiness -- --database-path \"$DatabasePath\" --format $Format --exchange-account-id $ExchangeAccountId --deployment-id $DeploymentId --checked-at $checkedAt --freshness-threshold-ms $FreshnessThresholdMs",
    },
    {
      name: "Pop-Location",
      text: "Pop-Location",
    },
  ]);
  assert.deepEqual(ast.finallyCommands, ["Pop-Location"]);
  assert.deepEqual(
    ast.memberInvocations.map((invocation) => ({
      member: invocation.member,
      text: normalizePowerShellExtent(invocation.text),
    })),
    [
      {
        member: "ToString",
        text: '[DateTimeOffset]::UtcNow.ToString("o")',
      },
    ],
  );
  assert.deepEqual(
    {
      paramAttributes: ast.paramAttributes,
      paramBlock: ast.paramBlock,
      topLevelStatements: ast.topLevelStatements,
    },
    expectedPilotReadinessAstShape,
  );
  assert.deepEqual(ast.executableTokens, [
    ...expectedPilotReadinessAstShape.paramAttributes.flatMap((attribute) => attribute.tokens),
    ...expectedPilotReadinessAstShape.paramBlock.tokens,
    ...expectedPilotReadinessAstShape.topLevelStatements.flatMap((statement) => statement.tokens),
  ]);
}

const expectedPilotReadinessAstShape = {
  paramAttributes: [
    astFingerprint("AttributeAst", "[", "CmdletBinding", "(", ")", "]"),
  ],
  paramBlock: astFingerprint(
    "ParamBlockAst",
    "param",
    "(",
    "[", "Parameter", "(", "Mandatory", "=", "$true", ")", "]",
    "[", "ValidateNotNullOrEmpty", "(", ")", "]",
    "[", "string", "]", "$DatabasePath", ",",
    "[", "Parameter", "(", "Mandatory", "=", "$true", ")", "]",
    "[", "ValidateNotNullOrEmpty", "(", ")", "]",
    "[", "string", "]", "$ExchangeAccountId", ",",
    "[", "Parameter", "(", "Mandatory", "=", "$true", ")", "]",
    "[", "ValidateNotNullOrEmpty", "(", ")", "]",
    "[", "string", "]", "$DeploymentId", ",",
    "[", "Parameter", "(", "Mandatory", "=", "$true", ")", "]",
    "[", "ValidateRange", "(", "1", ",", "[", "long", "]", "::", "MaxValue", ")", "]",
    "[", "long", "]", "$FreshnessThresholdMs", ",",
    "[", "ValidateSet", "(", '"TEXT"', ",", '"JSON"', ")", "]",
    "[", "string", "]", "$Format", "=", '"TEXT"',
    ")",
  ),
  topLevelStatements: [
    astFingerprint("AssignmentStatementAst", "$ErrorActionPreference", "=", '"Stop"'),
    astFingerprint(
      "IfStatementAst",
      "if", "(", "-not", "(", "Test-Path", "-LiteralPath", "$DatabasePath", "-PathType", "Leaf", ")", ")", "{",
      "throw", '"BTC pilot readiness requires an explicit existing SQLite database file: $DatabasePath"',
      "}",
    ),
    astFingerprint(
      "AssignmentStatementAst",
      "$DatabasePath", "=", "(", "Resolve-Path", "-LiteralPath", "$DatabasePath", ")", ".", "ProviderPath",
    ),
    astFingerprint(
      "AssignmentStatementAst",
      "$RepositoryRoot", "=", "(", "[", "System.IO.DirectoryInfo", "]", "$PSScriptRoot", ")", ".", "Parent", ".", "FullName",
    ),
    astFingerprint(
      "AssignmentStatementAst",
      "$checkedAt", "=", "[", "DateTimeOffset", "]", "::", "UtcNow", ".", "ToString", "(", '"o"', ")",
    ),
    astFingerprint("AssignmentStatementAst", "$PilotId", "=", '"BTC_COMBINED_CONSERVATIVE_PILOT_V1"'),
    astFingerprint("AssignmentStatementAst", "$PilotMarket", "=", '"KRW-BTC"'),
    astFingerprint("AssignmentStatementAst", "$PilotPolicy", "=", '"COMBINED_CONSERVATIVE"'),
    astFingerprint(
      "AssignmentStatementAst",
      "$PilotPolicyVersion", "=", '"PCS-2026-001.DEPLOYMENT_READINESS_V1"',
    ),
    astFingerprint("AssignmentStatementAst", "$env:APP_EXECUTION_MODE", "=", '"DRY_RUN"'),
    astFingerprint("AssignmentStatementAst", "$env:ENABLE_LIVE_ORDERS", "=", '"false"'),
    astFingerprint(
      "PipelineAst",
      "Remove-Item", "Env:\\POSITION_GUARD_PILOT_ID", "-ErrorAction", "SilentlyContinue",
    ),
    astFingerprint(
      "PipelineAst",
      "Remove-Item", "Env:\\POSITION_GUARD_PILOT_CONFIRMATION", "-ErrorAction", "SilentlyContinue",
    ),
    astFingerprint(
      "AssignmentStatementAst",
      "$env:ENABLE_TELEGRAM_INBOUND_POLLING", "=", '"false"',
    ),
    astFingerprint("AssignmentStatementAst", "$env:ENABLE_TELEGRAM_DELIVERY", "=", '"false"'),
    astFingerprint("AssignmentStatementAst", "$env:STRATEGY_SCHEDULER_ENABLED", "=", '"false"'),
    astFingerprint(
      "AssignmentStatementAst",
      "$env:STRATEGY_SCHEDULER_RUN_ON_START", "=", '"false"',
    ),
    astFingerprint(
      "PipelineAst",
      "Write-Host", '"Inspecting persisted BTC pilot readiness with BASELINE policy selection and without activation."',
    ),
    astFingerprint(
      "PipelineAst",
      "Write-Host", '"pilot=$PilotId market=$PilotMarket policy=$PilotPolicy version=$PilotPolicyVersion"',
    ),
    astFingerprint(
      "PipelineAst",
      "Write-Host", '"database=$DatabasePath deployment=$DeploymentId account=$ExchangeAccountId"',
    ),
    astFingerprint("AssignmentStatementAst", "$inspectionExitCode", "=", "1"),
    astFingerprint("PipelineAst", "Push-Location", "-LiteralPath", "$RepositoryRoot"),
    astFingerprint(
      "TryStatementAst",
      "try", "{",
      "npm.cmd", "run", "inspect:btc-pilot:readiness", "--",
      "--database-path", '"$DatabasePath"',
      "--format", "$Format",
      "--exchange-account-id", "$ExchangeAccountId",
      "--deployment-id", "$DeploymentId",
      "--checked-at", "$checkedAt",
      "--freshness-threshold-ms", "$FreshnessThresholdMs",
      "$inspectionExitCode", "=", "$LASTEXITCODE",
      "}", "finally", "{", "Pop-Location", "}",
    ),
    astFingerprint(
      "IfStatementAst",
      "if", "(", "$inspectionExitCode", "-ne", "0", ")", "{", "exit", "$inspectionExitCode", "}",
    ),
  ],
} satisfies {
  paramAttributes: PowerShellAstNodeFingerprint[];
  paramBlock: PowerShellAstNodeFingerprint;
  topLevelStatements: PowerShellAstNodeFingerprint[];
};

function astFingerprint(type: string, ...tokens: string[]): PowerShellAstNodeFingerprint {
  return { type, tokens };
}

test("BTC pilot readiness example runs its single npm command from the repository root", () => {
  const fixture = createPilotReadinessFixture(0);

  try {
    const result = runPilotReadinessFixture(fixture);
    const capture = readFileSync(fixture.capturePath, "utf8").trim().split(/\r?\n/);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(capture.length, 2, "the readiness npm command must run exactly once");
    assert.equal(capture[0], `cwd=${fixture.repositoryRoot}`);
    assert.match(
      capture[1]!,
      new RegExp(
        `^args=run inspect:btc-pilot:readiness -- --database-path ${escapeRegExp(fixture.databasePath)} --format TEXT `
          + "--exchange-account-id account_fixture --deployment-id deployment_fixture --checked-at \\S+ --freshness-threshold-ms 60000$",
      ),
    );
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("BTC pilot readiness example returns the native npm failure exit code", () => {
  const fixture = createPilotReadinessFixture(37);

  try {
    const result = runPilotReadinessFixture(fixture);
    const capture = readFileSync(fixture.capturePath, "utf8").trim().split(/\r?\n/);

    assert.equal(result.status, 37, result.stderr || result.stdout);
    assert.equal(capture.length, 2, "the readiness npm command must run exactly once");
  } finally {
    rmSync(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("BTC pilot readiness example cannot activate or mutate trading paths", () => {
  const script = readPilotReadinessScript();

  assert.match(script, /ENABLE_LIVE_ORDERS\s*=\s*"false"/);
  assert.doesNotMatch(script, /ENABLE_LIVE_ORDERS\s*=\s*"true"/);
  assert.doesNotMatch(script, /STRATEGY_SCHEDULER_(?:ENABLED|RUN_ON_START)\s*=\s*"true"/);
  assert.doesNotMatch(script, /npm\.cmd\s+run\s+(?:start|smoke:[^\s]*(?:sync|operator)|[^\s]*order)/i);
  assert.doesNotMatch(script, /\/(?:sync|run|order)\b/i);
  assert.doesNotMatch(script, /\$env:(?:UPBIT_ACCESS_KEY|UPBIT_SECRET_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_OPERATOR_CHAT_ID)\s*=/);
  assert.doesNotMatch(script, /(?:Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item)[^\r\n]*\.local\.ps1/i);
});

function readTaskScript(scriptName: (typeof taskScriptNames)[number]): string {
  return readFileSync(join(scriptsDirectory, scriptName), "utf8");
}

function readLocalRuntimeScript(scriptName: (typeof localRuntimeScriptNames)[number]): string {
  return readFileSync(join(scriptsDirectory, scriptName), "utf8");
}

function readPilotReadinessScript(): string {
  return readFileSync(join(scriptsDirectory, pilotReadinessScriptName), "utf8");
}

type PowerShellAstInspection = {
  commands: Array<{ name: string | null; text: string }>;
  executableTokens: string[];
  finallyCommands: Array<string | null>;
  memberInvocations: Array<{ member: string | null; text: string }>;
  paramAttributes: PowerShellAstNodeFingerprint[];
  paramBlock: PowerShellAstNodeFingerprint | null;
  topLevelStatements: PowerShellAstNodeFingerprint[];
};

type PowerShellAstNodeFingerprint = {
  type: string;
  tokens: string[];
};

function inspectPowerShellAst(scriptPath: string): PowerShellAstInspection {
  const inspector = String.raw`
$TargetPath = $env:AUTOTRADE_AST_TARGET_PATH
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($TargetPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
  foreach ($parseError in $parseErrors) { Write-Error $parseError.Message }
  exit 1
}
$commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
  [pscustomobject]@{ name = $_.GetCommandName(); text = $_.Extent.Text }
})
$members = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true) | ForEach-Object {
  $memberName = if ($_.Member -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Member.Value } else { $null }
  [pscustomobject]@{ member = $memberName; text = $_.Extent.Text }
})
$finallyCommands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.TryStatementAst] }, $true) | ForEach-Object {
  if ($null -ne $_.Finally) {
    $_.Finally.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
      $_.GetCommandName()
    }
  }
})
function Get-ExecutableNodeFingerprint($node) {
  if ($null -eq $node) { return $null }
  $nodeTokens = @($tokens | Where-Object {
    $_.Extent.StartOffset -ge $node.Extent.StartOffset -and
    $_.Extent.EndOffset -le $node.Extent.EndOffset -and
    $_.Kind.ToString() -notin @("Comment", "NewLine", "LineContinuation", "EndOfInput")
  } | ForEach-Object { $_.Text })
  return [pscustomobject]@{ type = $node.GetType().Name; tokens = $nodeTokens }
}
$paramAttributes = @($ast.ParamBlock.Attributes | ForEach-Object { Get-ExecutableNodeFingerprint $_ })
$paramBlock = Get-ExecutableNodeFingerprint $ast.ParamBlock
$topLevelStatements = @($ast.EndBlock.Statements | ForEach-Object { Get-ExecutableNodeFingerprint $_ })
$executableTokens = @($tokens | Where-Object {
  $_.Kind.ToString() -notin @("Comment", "NewLine", "LineContinuation", "EndOfInput")
} | ForEach-Object { $_.Text })
[pscustomobject]@{
  commands = $commands
  executableTokens = $executableTokens
  finallyCommands = $finallyCommands
  memberInvocations = $members
  paramAttributes = $paramAttributes
  paramBlock = $paramBlock
  topLevelStatements = $topLevelStatements
} | ConvertTo-Json -Depth 8 -Compress
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", inspector],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AUTOTRADE_AST_TARGET_PATH: scriptPath,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as PowerShellAstInspection;
}

type PilotReadinessFixture = {
  temporaryRoot: string;
  repositoryRoot: string;
  callerDirectory: string;
  databasePath: string;
  scriptPath: string;
  shimDirectory: string;
  capturePath: string;
  nativeExitCode: number;
};

function createPilotReadinessFixture(nativeExitCode: number): PilotReadinessFixture {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "autotrade-pilot-readiness-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  const scriptsRoot = join(repositoryRoot, "scripts");
  const callerDirectory = join(temporaryRoot, "caller");
  const shimDirectory = join(temporaryRoot, "shim");
  const databasePath = join(temporaryRoot, "fixture.sqlite");
  const capturePath = join(temporaryRoot, "npm-capture.txt");
  const scriptPath = join(scriptsRoot, pilotReadinessScriptName);

  mkdirSync(scriptsRoot, { recursive: true });
  mkdirSync(callerDirectory, { recursive: true });
  mkdirSync(shimDirectory, { recursive: true });
  copyFileSync(join(scriptsDirectory, pilotReadinessScriptName), scriptPath);
  writeFileSync(databasePath, "fixture", "utf8");
  writeFileSync(
    join(shimDirectory, "npm.cmd"),
    [
      "@echo off",
      ">>\"%FAKE_NPM_CAPTURE_PATH%\" echo cwd=%CD%",
      ">>\"%FAKE_NPM_CAPTURE_PATH%\" echo args=%*",
      "exit /b %FAKE_NPM_EXIT_CODE%",
      "",
    ].join("\r\n"),
    "utf8",
  );

  return {
    temporaryRoot,
    repositoryRoot,
    callerDirectory,
    databasePath,
    scriptPath,
    shimDirectory,
    capturePath,
    nativeExitCode,
  };
}

function runPilotReadinessFixture(fixture: PilotReadinessFixture): SpawnSyncReturns<string> {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
  env[pathKey] = `${fixture.shimDirectory};${env[pathKey] ?? ""}`;
  env.FAKE_NPM_CAPTURE_PATH = fixture.capturePath;
  env.FAKE_NPM_EXIT_CODE = String(fixture.nativeExitCode);

  return spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      fixture.scriptPath,
      "-DatabasePath",
      fixture.databasePath,
      "-ExchangeAccountId",
      "account_fixture",
      "-DeploymentId",
      "deployment_fixture",
      "-FreshnessThresholdMs",
      "60000",
    ],
    {
      cwd: fixture.callerDirectory,
      encoding: "utf8",
      env,
    },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePowerShellExtent(value: string): string {
  return value.replace(/`\r?\n\s*/g, " ").replace(/\s+/g, " ").trim();
}
