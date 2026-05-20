# Copy this file to unregister-autotrade-task.local.ps1 before use.
# The .local.ps1 copy is ignored by Git.
#
# This removes one of the approved manual-only AutoTrade_Upbit scheduled tasks.

$ErrorActionPreference = "Stop"

$TaskUnregistrationConfirmation = "REPLACE_WITH_I_UNDERSTAND_THIS_TASK_HAS_NO_AUTOSTART_TRIGGER"
if ($TaskUnregistrationConfirmation -ne "I_UNDERSTAND_THIS_TASK_HAS_NO_AUTOSTART_TRIGGER") {
  throw "Refusing to unregister until TaskUnregistrationConfirmation is set to I_UNDERSTAND_THIS_TASK_HAS_NO_AUTOSTART_TRIGGER in the local copy."
}

$TaskName = "AutoTrade_Upbit_LIVE_Scheduler_Manual"
$AllowedTaskNames = @(
  "AutoTrade_Upbit_DRY_RUN_Manual",
  "AutoTrade_Upbit_LIVE_Scheduler_Manual"
)

if ($AllowedTaskNames -notcontains $TaskName) {
  throw "Refusing to unregister unsupported task name: $TaskName"
}

$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $ExistingTask) {
  Write-Host "Task $TaskName is not registered."
  exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Unregistered task: $TaskName"
