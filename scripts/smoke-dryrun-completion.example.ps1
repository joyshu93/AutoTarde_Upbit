# Copy this file to smoke-dryrun-completion.local.ps1 and fill in secrets locally.
# The local copy is ignored by Git.

$ErrorActionPreference = "Stop"

$env:APP_EXECUTION_MODE = "DRY_RUN"
$env:ENABLE_LIVE_ORDERS = "false"
$env:ENABLE_TELEGRAM_DELIVERY = "false"
$env:ENABLE_TELEGRAM_INBOUND_POLLING = "false"
$env:STRATEGY_SCHEDULER_ENABLED = "false"
$env:STRATEGY_SCHEDULER_RUN_ON_START = "false"
$env:DATABASE_PATH = "./var/company-dryrun-scheduler.sqlite"

$env:UPBIT_ACCESS_KEY = "REPLACE_WITH_UPBIT_ACCESS_KEY"
$env:UPBIT_SECRET_KEY = "REPLACE_WITH_UPBIT_SECRET_KEY"
$env:TELEGRAM_BOT_TOKEN = "REPLACE_WITH_TELEGRAM_BOT_TOKEN"
$env:TELEGRAM_OPERATOR_CHAT_ID = "REPLACE_WITH_TELEGRAM_OPERATOR_CHAT_ID"

$requiredSecretNames = @(
  "UPBIT_ACCESS_KEY",
  "UPBIT_SECRET_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OPERATOR_CHAT_ID"
)

foreach ($name in $requiredSecretNames) {
  $value = [Environment]::GetEnvironmentVariable($name, "Process")
  if ([string]::IsNullOrWhiteSpace($value) -or $value.StartsWith("REPLACE_WITH_")) {
    throw "Refusing to run DRY_RUN completion smoke because $name is not configured in the local copy."
  }
}

Write-Host "Checking persisted AutoTrade_Upbit DRY_RUN automatic execution evidence."
Write-Host "DATABASE_PATH=$env:DATABASE_PATH"
Write-Host "Telegram delivery and inbound polling stay disabled for this smoke."
Write-Host "The scheduler is not started by this smoke."
Write-Host "No Upbit order is submitted by this script."

npm.cmd run smoke:dryrun:completion
