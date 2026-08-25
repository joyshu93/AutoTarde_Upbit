# Copy this file to register-autotrade-live-scheduler-task.local.ps1 before use.
# The .local.ps1 copy is ignored by Git. Do not commit local machine choices.
#
# This registers a manual-only Windows Task Scheduler entry that launches the
# existing LIVE scheduler local startup script. It does not store secrets in the
# task definition and it does not create startup, logon, or catch-up triggers.
# Real Upbit order submission can occur only after the registered task is
# manually started and the application-level live scheduler guards pass.

$ErrorActionPreference = "Stop"

$LiveTaskOrderConfirmation = "REPLACE_WITH_I_UNDERSTAND_REAL_ORDERS"
if ($LiveTaskOrderConfirmation -ne "I_UNDERSTAND_REAL_ORDERS") {
  throw "Refusing to register the LIVE scheduler task until LiveTaskOrderConfirmation is set to I_UNDERSTAND_REAL_ORDERS in the local copy."
}

$LiveTaskSchedulerConfirmation = "REPLACE_WITH_I_UNDERSTAND_AUTOMATIC_SCHEDULED_ORDERS"
if ($LiveTaskSchedulerConfirmation -ne "I_UNDERSTAND_AUTOMATIC_SCHEDULED_ORDERS") {
  throw "Refusing to register the LIVE scheduler task until LiveTaskSchedulerConfirmation is set to I_UNDERSTAND_AUTOMATIC_SCHEDULED_ORDERS in the local copy."
}

$NoAutostartConfirmation = "REPLACE_WITH_I_UNDERSTAND_THIS_TASK_HAS_NO_AUTOSTART_TRIGGER"
if ($NoAutostartConfirmation -ne "I_UNDERSTAND_THIS_TASK_HAS_NO_AUTOSTART_TRIGGER") {
  throw "Refusing to register the LIVE scheduler task until NoAutostartConfirmation is set to I_UNDERSTAND_THIS_TASK_HAS_NO_AUTOSTART_TRIGGER in the local copy."
}

$TaskName = "AutoTrade_Upbit_LIVE_Scheduler_Manual"
$ReplaceExistingTask = $false

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Resolve-Path (Join-Path $ScriptDirectory "..")
$TargetScript = Resolve-Path -LiteralPath (Join-Path $ScriptDirectory "start-company-live-scheduler.local.ps1") -ErrorAction SilentlyContinue

if ($null -eq $TargetScript) {
  throw "Refusing to register $TaskName because scripts/start-company-live-scheduler.local.ps1 does not exist."
}

if ((Split-Path -Leaf $TargetScript.Path) -ne "start-company-live-scheduler.local.ps1") {
  throw "Refusing to register $TaskName because the target script is not the approved LIVE scheduler local launcher."
}

$TargetScriptText = Get-Content -Raw -LiteralPath $TargetScript.Path
if ($TargetScriptText -match "REPLACE_WITH_") {
  throw "Refusing to register $TaskName because start-company-live-scheduler.local.ps1 still contains REPLACE_WITH_ placeholders."
}

if ($TargetScriptText -notmatch 'STRATEGY_SCHEDULER_RUN_ON_START\s*=\s*"false"') {
  throw "Refusing to register $TaskName because start-company-live-scheduler.local.ps1 must keep STRATEGY_SCHEDULER_RUN_ON_START set to false."
}

if ($TargetScriptText -notmatch "smoke:live:scheduler-preflight") {
  throw "Refusing to register $TaskName because start-company-live-scheduler.local.ps1 must run the live scheduler preflight smoke before startup."
}

if ($TargetScriptText -notmatch "LIVE_DATABASE_INSTANCE_ID") {
  throw "Refusing to register $TaskName because the LIVE scheduler launcher must bind the provisioned database instance identity."
}

if ($TargetScriptText -notmatch "Resolve-Path -LiteralPath") {
  throw "Refusing to register $TaskName because the LIVE scheduler launcher must resolve an existing absolute database path."
}

$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $ExistingTask) {
  if (-not $ReplaceExistingTask) {
    throw "Task $TaskName already exists. Set ReplaceExistingTask to true in the local copy if you want to replace it."
  }

  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$PowerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$TaskArguments = "-NoProfile -ExecutionPolicy Bypass -File `"$($TargetScript.Path)`""
$Action = New-ScheduledTaskAction -Execute $PowerShellPath -Argument $TaskArguments -WorkingDirectory $RepositoryRoot.Path
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 365) `
  -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel LeastPrivilege

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Settings $Settings `
  -Principal $Principal `
  -Description "Manual-only AutoTrade_Upbit LIVE scheduler launcher. No startup or logon trigger is registered."

Write-Host "Registered manual-only task: $TaskName"
Write-Host "No startup, logon, or catch-up trigger was created."
Write-Host "Start manually with: Start-ScheduledTask -TaskName `"$TaskName`""
