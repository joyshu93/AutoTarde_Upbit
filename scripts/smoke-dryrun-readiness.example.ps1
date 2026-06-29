# Copy this file to smoke-dryrun-readiness.local.ps1 and fill in secrets locally.
# The .local.ps1 copy is ignored by Git. Do not commit API keys or bot tokens.
#
# This script checks DRY_RUN readiness only. It does not start the runtime,
# start the scheduler, poll Telegram, run /sync, run strategy, or send orders.

$ErrorActionPreference = "Stop"

$env:APP_EXECUTION_MODE = "DRY_RUN"
$env:ENABLE_LIVE_ORDERS = "false"
$env:DATABASE_PATH = "./var/company-dryrun.sqlite"

$env:UPBIT_ACCESS_KEY = "REPLACE_WITH_UPBIT_ACCESS_KEY"
$env:UPBIT_SECRET_KEY = "REPLACE_WITH_UPBIT_SECRET_KEY"

$env:TELEGRAM_BOT_TOKEN = "REPLACE_WITH_TELEGRAM_BOT_TOKEN"
$env:TELEGRAM_OPERATOR_CHAT_ID = "REPLACE_WITH_TELEGRAM_OPERATOR_CHAT_ID"
$env:ENABLE_TELEGRAM_INBOUND_POLLING = "true"
$env:ENABLE_TELEGRAM_DELIVERY = "true"

$env:STRATEGY_SCHEDULER_ENABLED = "false"
$env:STRATEGY_SCHEDULER_RUN_ON_START = "false"

$requiredEnv = @(
  "UPBIT_ACCESS_KEY",
  "UPBIT_SECRET_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OPERATOR_CHAT_ID"
)

foreach ($name in $requiredEnv) {
  $value = [Environment]::GetEnvironmentVariable($name, "Process")
  if ([string]::IsNullOrWhiteSpace($value) -or $value.StartsWith("REPLACE_WITH_")) {
    throw "Refusing to check DRY_RUN readiness because $name is not configured in the local copy."
  }
}

Write-Host "Checking AutoTrade_Upbit DRY_RUN readiness without starting the runtime."
Write-Host "DATABASE_PATH=$env:DATABASE_PATH"
Write-Host "Live orders remain disabled by ENABLE_LIVE_ORDERS=false."
Write-Host "No Upbit order is submitted by this script."

npm.cmd run smoke:dryrun:readiness
