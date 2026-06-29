# Copy this file to smoke-dryrun-sync.local.ps1 and fill in secrets locally.
# The .local.ps1 copy is ignored by Git. Do not commit API keys or bot tokens.
#
# This script performs an exchange-backed DRY_RUN /sync smoke only.
# It does not start the runtime, start the scheduler, poll Telegram, run strategy,
# deliver Telegram notifications, or send orders.

$ErrorActionPreference = "Stop"

$env:APP_EXECUTION_MODE = "DRY_RUN"
$env:ENABLE_LIVE_ORDERS = "false"
$env:DATABASE_PATH = "./var/company-dryrun.sqlite"

$env:UPBIT_ACCESS_KEY = "REPLACE_WITH_UPBIT_ACCESS_KEY"
$env:UPBIT_SECRET_KEY = "REPLACE_WITH_UPBIT_SECRET_KEY"

$env:ENABLE_TELEGRAM_INBOUND_POLLING = "false"
$env:ENABLE_TELEGRAM_DELIVERY = "false"

$env:STRATEGY_SCHEDULER_ENABLED = "false"
$env:STRATEGY_SCHEDULER_RUN_ON_START = "false"

$requiredEnv = @(
  "UPBIT_ACCESS_KEY",
  "UPBIT_SECRET_KEY"
)

foreach ($name in $requiredEnv) {
  $value = [Environment]::GetEnvironmentVariable($name, "Process")
  if ([string]::IsNullOrWhiteSpace($value) -or $value.StartsWith("REPLACE_WITH_")) {
    throw "Refusing to run DRY_RUN sync smoke because $name is not configured in the local copy."
  }
}

Write-Host "Checking AutoTrade_Upbit exchange-backed DRY_RUN /sync without starting the runtime."
Write-Host "DATABASE_PATH=$env:DATABASE_PATH"
Write-Host "Telegram delivery and inbound polling stay disabled for this smoke."
Write-Host "No Upbit order is submitted by this script."

npm.cmd run smoke:dryrun:sync
