# Copy this file to start-company-dryrun-scheduler.local.ps1 and fill in secrets locally.
# The .local.ps1 copy is ignored by Git. Do not commit API keys or bot tokens.
#
# This script starts DRY_RUN mode with the strategy scheduler enabled.
# It keeps live orders disabled and runs exchange-backed DRY_RUN safety checks before startup.

$ErrorActionPreference = "Stop"

$DryRunSchedulerConfirmation = "REPLACE_WITH_I_UNDERSTAND_DRY_RUN_SCHEDULED_ORDERS"
if ($DryRunSchedulerConfirmation -ne "I_UNDERSTAND_DRY_RUN_SCHEDULED_ORDERS") {
  throw "Refusing to start DRY_RUN scheduler mode until DryRunSchedulerConfirmation is set to I_UNDERSTAND_DRY_RUN_SCHEDULED_ORDERS in the local copy."
}

$env:APP_EXECUTION_MODE = "DRY_RUN"
$env:ENABLE_LIVE_ORDERS = "false"
$env:DATABASE_PATH = "./var/company-dryrun-scheduler.sqlite"

$env:UPBIT_ACCESS_KEY = "REPLACE_WITH_UPBIT_ACCESS_KEY"
$env:UPBIT_SECRET_KEY = "REPLACE_WITH_UPBIT_SECRET_KEY"

$env:TELEGRAM_BOT_TOKEN = "REPLACE_WITH_TELEGRAM_BOT_TOKEN"
$env:TELEGRAM_OPERATOR_CHAT_ID = "REPLACE_WITH_TELEGRAM_OPERATOR_CHAT_ID"
$env:ENABLE_TELEGRAM_INBOUND_POLLING = "true"
$env:ENABLE_TELEGRAM_DELIVERY = "true"

$env:STRATEGY_SCHEDULER_ENABLED = "true"
$env:STRATEGY_SCHEDULER_RUN_ON_START = "true"
$env:STRATEGY_SCHEDULER_BTC_INTERVAL_MS = "3600000"
$env:STRATEGY_SCHEDULER_ETH_INTERVAL_MS = "3600000"

$requiredEnv = @(
  "UPBIT_ACCESS_KEY",
  "UPBIT_SECRET_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OPERATOR_CHAT_ID",
  "STRATEGY_SCHEDULER_BTC_INTERVAL_MS",
  "STRATEGY_SCHEDULER_ETH_INTERVAL_MS"
)

foreach ($name in $requiredEnv) {
  $value = [Environment]::GetEnvironmentVariable($name, "Process")
  if ([string]::IsNullOrWhiteSpace($value) -or $value.StartsWith("REPLACE_WITH_")) {
    throw "Refusing to start DRY_RUN scheduler mode because $name is not configured in the local copy."
  }
}

Write-Host "Starting AutoTrade_Upbit in DRY_RUN scheduler mode."
Write-Host "DATABASE_PATH=$env:DATABASE_PATH"
Write-Host "Live orders are disabled by ENABLE_LIVE_ORDERS=false."
Write-Host "STRATEGY_SCHEDULER_ENABLED=$env:STRATEGY_SCHEDULER_ENABLED"
Write-Host "STRATEGY_SCHEDULER_RUN_ON_START=$env:STRATEGY_SCHEDULER_RUN_ON_START"
Write-Host "BTC interval ms=$env:STRATEGY_SCHEDULER_BTC_INTERVAL_MS"
Write-Host "ETH interval ms=$env:STRATEGY_SCHEDULER_ETH_INTERVAL_MS"
Write-Host "Checking exchange-backed DRY_RUN sync before scheduler startup."

npm.cmd run smoke:dryrun:sync
if ($LASTEXITCODE -ne 0) {
  throw "Refusing to start DRY_RUN scheduler mode because smoke:dryrun:sync failed with exit code $LASTEXITCODE."
}

Write-Host "Checking DRY_RUN readiness before starting the scheduler runtime."
npm.cmd run smoke:dryrun:readiness
if ($LASTEXITCODE -ne 0) {
  throw "Refusing to start DRY_RUN scheduler mode because smoke:dryrun:readiness failed with exit code $LASTEXITCODE."
}

Write-Host "Starting runtime. The scheduler will run once on startup, then use the configured intervals."
npm.cmd run start
if ($LASTEXITCODE -ne 0) {
  throw "DRY_RUN scheduler runtime exited with code $LASTEXITCODE."
}
