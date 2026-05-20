# Copy this file to start-company-live-scheduler.local.ps1 and fill in secrets locally.
# The .local.ps1 copy is ignored by Git. Do not commit API keys or bot tokens.
#
# This script starts LIVE mode with the strategy scheduler enabled.
# Use only after the scheduler preflight smoke has been reviewed.

$ErrorActionPreference = "Stop"

$LiveSchedulerConfirmation = "REPLACE_WITH_I_UNDERSTAND_REAL_ORDERS"
if ($LiveSchedulerConfirmation -ne "I_UNDERSTAND_REAL_ORDERS") {
  throw "Refusing to start LIVE scheduler mode until LiveSchedulerConfirmation is set to I_UNDERSTAND_REAL_ORDERS in the local copy."
}

$LiveSchedulerSecondConfirmation = "REPLACE_WITH_I_UNDERSTAND_AUTOMATIC_SCHEDULED_ORDERS"
if ($LiveSchedulerSecondConfirmation -ne "I_UNDERSTAND_AUTOMATIC_SCHEDULED_ORDERS") {
  throw "Refusing to start LIVE scheduler mode until LiveSchedulerSecondConfirmation is set to I_UNDERSTAND_AUTOMATIC_SCHEDULED_ORDERS in the local copy."
}

$env:APP_EXECUTION_MODE = "LIVE"
$env:ENABLE_LIVE_ORDERS = "true"
$env:DATABASE_PATH = "./var/company-live.sqlite"

$env:UPBIT_ACCESS_KEY = "REPLACE_WITH_UPBIT_ACCESS_KEY"
$env:UPBIT_SECRET_KEY = "REPLACE_WITH_UPBIT_SECRET_KEY"

$env:TELEGRAM_BOT_TOKEN = "REPLACE_WITH_TELEGRAM_BOT_TOKEN"
$env:TELEGRAM_OPERATOR_CHAT_ID = "REPLACE_WITH_TELEGRAM_OPERATOR_CHAT_ID"
$env:ENABLE_TELEGRAM_INBOUND_POLLING = "true"
$env:ENABLE_TELEGRAM_DELIVERY = "true"

$env:STRATEGY_SCHEDULER_ENABLED = "true"
$env:STRATEGY_SCHEDULER_RUN_ON_START = "false"
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
    throw "Refusing to start LIVE scheduler mode because $name is not configured in the local copy."
  }
}

Write-Host "Starting AutoTrade_Upbit in LIVE scheduler mode."
Write-Host "DATABASE_PATH=$env:DATABASE_PATH"
Write-Host "STRATEGY_SCHEDULER_ENABLED=$env:STRATEGY_SCHEDULER_ENABLED"
Write-Host "STRATEGY_SCHEDULER_RUN_ON_START=$env:STRATEGY_SCHEDULER_RUN_ON_START"
Write-Host "BTC interval ms=$env:STRATEGY_SCHEDULER_BTC_INTERVAL_MS"
Write-Host "ETH interval ms=$env:STRATEGY_SCHEDULER_ETH_INTERVAL_MS"
Write-Host "The app startup preflight must pass before scheduler timers are installed."
Write-Host "Real Upbit order submission is possible on later scheduled strategy cycles if all guards pass."

npm.cmd run smoke:live:scheduler-preflight
npm.cmd run start
