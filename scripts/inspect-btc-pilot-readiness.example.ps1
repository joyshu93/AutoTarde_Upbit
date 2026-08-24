# Read-only BTC candidate pilot readiness inspection with BASELINE policy selection.
# This example requires an existing SQLite database and explicit persisted identity inputs.
# Candidate selection, confirmation, and activation belong in a separate local procedure.
# It does not start the app, activate the pilot, call Upbit or Telegram, or enable LIVE orders.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$DatabasePath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ExchangeAccountId,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$DeploymentId,

  [Parameter(Mandatory = $true)]
  [ValidateRange(1, [long]::MaxValue)]
  [long]$FreshnessThresholdMs,

  [ValidateSet("TEXT", "JSON")]
  [string]$Format = "TEXT"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
  throw "BTC pilot readiness requires an explicit existing SQLite database file: $DatabasePath"
}

$DatabasePath = (Resolve-Path -LiteralPath $DatabasePath).ProviderPath
$checkedAt = [DateTimeOffset]::UtcNow.ToString("o")

$PilotId = "BTC_COMBINED_CONSERVATIVE_PILOT_V1"
$PilotMarket = "KRW-BTC"
$PilotPolicy = "COMBINED_CONSERVATIVE"
$PilotPolicyVersion = "PCS-2026-001.DEPLOYMENT_READINESS_V1"

# Keep the checked-in example on the default BASELINE selection even when the
# parent PowerShell process contains candidate-pilot environment variables.
$env:APP_EXECUTION_MODE = "DRY_RUN"
$env:ENABLE_LIVE_ORDERS = "false"
Remove-Item Env:\POSITION_GUARD_PILOT_ID -ErrorAction SilentlyContinue
Remove-Item Env:\POSITION_GUARD_PILOT_CONFIRMATION -ErrorAction SilentlyContinue
$env:ENABLE_TELEGRAM_INBOUND_POLLING = "false"
$env:ENABLE_TELEGRAM_DELIVERY = "false"
$env:STRATEGY_SCHEDULER_ENABLED = "false"
$env:STRATEGY_SCHEDULER_RUN_ON_START = "false"

Write-Host "Inspecting persisted BTC pilot readiness with BASELINE policy selection and without activation."
Write-Host "pilot=$PilotId market=$PilotMarket policy=$PilotPolicy version=$PilotPolicyVersion"
Write-Host "database=$DatabasePath deployment=$DeploymentId account=$ExchangeAccountId"

npm.cmd run inspect:btc-pilot:readiness -- `
  --database-path "$DatabasePath" `
  --format $Format `
  --exchange-account-id $ExchangeAccountId `
  --deployment-id $DeploymentId `
  --checked-at $checkedAt `
  --freshness-threshold-ms $FreshnessThresholdMs
