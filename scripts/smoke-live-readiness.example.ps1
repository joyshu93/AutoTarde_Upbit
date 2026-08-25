# Copy this file to smoke-live-readiness.local.ps1 and fill in secrets locally.
# The .local.ps1 copy is ignored by Git. Do not commit API keys or bot tokens.
#
# This script checks LIVE readiness only. It does not start the runtime,
# start the scheduler, poll Telegram, run /sync, run strategy, or send orders.

$ErrorActionPreference = "Stop"

$LiveReadinessConfirmation = "REPLACE_WITH_I_UNDERSTAND_REAL_ORDERS"
if ($LiveReadinessConfirmation -ne "I_UNDERSTAND_REAL_ORDERS") {
  throw "Refusing to check LIVE readiness until LiveReadinessConfirmation is set to I_UNDERSTAND_REAL_ORDERS in the local copy."
}

$env:APP_EXECUTION_MODE = "LIVE"
$env:ENABLE_LIVE_ORDERS = "true"
$RepositoryRoot = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")
$env:DATABASE_PATH = (Resolve-Path -LiteralPath (Join-Path $RepositoryRoot "var/company-live.sqlite") -ErrorAction Stop).Path
$env:LIVE_DATABASE_INSTANCE_ID = "REPLACE_WITH_PROVISIONED_DATABASE_INSTANCE_UUID"

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
  "LIVE_DATABASE_INSTANCE_ID",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OPERATOR_CHAT_ID"
)

foreach ($name in $requiredEnv) {
  $value = [Environment]::GetEnvironmentVariable($name, "Process")
  if ([string]::IsNullOrWhiteSpace($value) -or $value.StartsWith("REPLACE_WITH_")) {
    throw "Refusing to check LIVE readiness because $name is not configured in the local copy."
  }
}

Write-Host "Checking AutoTrade_Upbit LIVE readiness without starting the runtime."
Write-Host "DATABASE_PATH=$env:DATABASE_PATH"
Write-Host "Strategy scheduler remains disabled for this readiness check."
Write-Host "No Upbit order is submitted by this script."

npm.cmd run smoke:live:readiness
