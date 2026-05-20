# Copy this file to register-autotrade-dryrun-task.local.ps1 before use.
# The .local.ps1 copy is ignored by Git. Do not commit local machine choices.
#
# This registers a manual-only Windows Task Scheduler entry that launches the
# existing DRY_RUN local startup script. It does not store secrets in the task
# definition and it does not create startup, logon, or catch-up triggers.

$ErrorActionPreference = "Stop"

$TaskRegistrationConfirmation = "REPLACE_WITH_I_UNDERSTAND_THIS_TASK_HAS_NO_AUTOSTART_TRIGGER"
if ($TaskRegistrationConfirmation -ne "I_UNDERSTAND_THIS_TASK_HAS_NO_AUTOSTART_TRIGGER") {
  throw "Refusing to register the task until TaskRegistrationConfirmation is set to I_UNDERSTAND_THIS_TASK_HAS_NO_AUTOSTART_TRIGGER in the local copy."
}

$TaskName = "AutoTrade_Upbit_DRY_RUN_Manual"
$ReplaceExistingTask = $false

$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepositoryRoot = Resolve-Path (Join-Path $ScriptDirectory "..")
$TargetScript = Resolve-Path -LiteralPath (Join-Path $ScriptDirectory "start-company-dryrun.local.ps1") -ErrorAction SilentlyContinue

if ($null -eq $TargetScript) {
  throw "Refusing to register $TaskName because scripts/start-company-dryrun.local.ps1 does not exist."
}

if ((Split-Path -Leaf $TargetScript.Path) -ne "start-company-dryrun.local.ps1") {
  throw "Refusing to register $TaskName because the target script is not the approved DRY_RUN local launcher."
}

$TargetScriptText = Get-Content -Raw -LiteralPath $TargetScript.Path
if ($TargetScriptText -match "REPLACE_WITH_") {
  throw "Refusing to register $TaskName because start-company-dryrun.local.ps1 still contains REPLACE_WITH_ placeholders."
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
  -Description "Manual-only AutoTrade_Upbit DRY_RUN launcher. No startup or logon trigger is registered."

Write-Host "Registered manual-only task: $TaskName"
Write-Host "No startup, logon, or catch-up trigger was created."
Write-Host "Start manually with: Start-ScheduledTask -TaskName `"$TaskName`""
