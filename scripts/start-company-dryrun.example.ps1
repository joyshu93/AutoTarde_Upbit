# Copy this file to start-company-dryrun.local.ps1 and fill in secrets locally.
# The .local.ps1 copy is ignored by Git. Do not commit API keys or bot tokens.

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

Write-Host "Starting AutoTrade_Upbit in DRY_RUN mode."
Write-Host "DATABASE_PATH=$env:DATABASE_PATH"
Write-Host "Live orders are disabled by ENABLE_LIVE_ORDERS=false."

npm.cmd run build
npm.cmd run start
