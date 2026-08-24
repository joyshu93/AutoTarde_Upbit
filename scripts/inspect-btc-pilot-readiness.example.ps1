# Read-only BTC candidate pilot readiness inspection.
# This example requires an existing SQLite database and explicit persisted identity inputs.
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

# Candidate selection is explicit for inspection, but order transmission remains disabled.
$env:APP_EXECUTION_MODE = "LIVE"
$env:ENABLE_LIVE_ORDERS = "false"
$env:POSITION_GUARD_PILOT_ID = $PilotId
$env:POSITION_GUARD_PILOT_CONFIRMATION = "I_UNDERSTAND_BTC_CANDIDATE_LIVE_PILOT"
$env:ENABLE_TELEGRAM_INBOUND_POLLING = "false"
$env:ENABLE_TELEGRAM_DELIVERY = "false"
$env:STRATEGY_SCHEDULER_ENABLED = "false"
$env:STRATEGY_SCHEDULER_RUN_ON_START = "false"

Write-Host "Inspecting persisted BTC pilot readiness without activation."
Write-Host "pilot=$PilotId market=$PilotMarket policy=$PilotPolicy version=$PilotPolicyVersion"
Write-Host "database=$DatabasePath deployment=$DeploymentId account=$ExchangeAccountId"

npm.cmd run inspect:btc-pilot:readiness -- `
  --database-path "$DatabasePath" `
  --format $Format `
  --exchange-account-id $ExchangeAccountId `
  --deployment-id $DeploymentId `
  --checked-at $checkedAt `
  --freshness-threshold-ms $FreshnessThresholdMs
