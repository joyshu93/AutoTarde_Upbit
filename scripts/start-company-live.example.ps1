# Copy this file to start-company-live.local.ps1 and fill in secrets locally.
# The .local.ps1 copy is ignored by Git. Do not commit API keys or bot tokens.
#
# This script enables the LIVE send path when all app-side safety gates pass.
# Keep STRATEGY_SCHEDULER_ENABLED=false for the first live validation run.

$ErrorActionPreference = "Stop"

$LiveOrderConfirmation = "REPLACE_WITH_I_UNDERSTAND_REAL_ORDERS"
if ($LiveOrderConfirmation -ne "I_UNDERSTAND_REAL_ORDERS") {
  throw "Refusing to start LIVE mode until LiveOrderConfirmation is set to I_UNDERSTAND_REAL_ORDERS in the local copy."
}

$env:APP_EXECUTION_MODE = "LIVE"
$env:ENABLE_LIVE_ORDERS = "true"
$env:MAX_LIVE_ORDER_VALUE_KRW = "6000"
$env:DATABASE_PATH = "./var/company-live.sqlite"

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
  "TELEGRAM_OPERATOR_CHAT_ID",
  "MAX_LIVE_ORDER_VALUE_KRW"
)

foreach ($name in $requiredEnv) {
  $value = [Environment]::GetEnvironmentVariable($name, "Process")
  if ([string]::IsNullOrWhiteSpace($value) -or $value.StartsWith("REPLACE_WITH_")) {
    throw "Refusing to start LIVE mode because $name is not configured in the local copy."
  }
}

Write-Host "Starting AutoTrade_Upbit in LIVE mode."
Write-Host "DATABASE_PATH=$env:DATABASE_PATH"
Write-Host "MAX_LIVE_ORDER_VALUE_KRW=$env:MAX_LIVE_ORDER_VALUE_KRW"
Write-Host "Strategy scheduler is disabled by default for the first LIVE validation run."
Write-Host "Real Upbit order submission is enabled only if runtime readiness and risk guards pass."

npm.cmd run smoke:live:readiness
npm.cmd run start
