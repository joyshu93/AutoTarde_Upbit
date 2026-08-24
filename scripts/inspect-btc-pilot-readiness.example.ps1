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
$RepositoryRoot = ([System.IO.DirectoryInfo]$PSScriptRoot).Parent.FullName
$NpmApplications = @(Microsoft.PowerShell.Core\Get-Command -Name "npm.cmd" -CommandType Application -All -ErrorAction Stop)
if ($NpmApplications.Count -lt 1) {
  throw "BTC pilot readiness requires npm.cmd to resolve to an application."
}
$NpmResolvedPath = Microsoft.PowerShell.Management\Resolve-Path -LiteralPath $NpmApplications[0].Path -ErrorAction Stop
if (
  $NpmResolvedPath.Provider.Name -ne "FileSystem" -or
  $NpmResolvedPath.ProviderPath -notmatch '(?i)[\\/]npm\.cmd$' -or
  -not (Microsoft.PowerShell.Management\Test-Path -LiteralPath $NpmResolvedPath.ProviderPath -PathType Leaf)
) {
  throw "BTC pilot readiness requires npm.cmd to resolve to one canonical filesystem application path."
}
$NpmCommandPath = $NpmResolvedPath.ProviderPath
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

$inspectionExitCode = 1
Push-Location -LiteralPath $RepositoryRoot
try {
  & $NpmCommandPath run inspect:btc-pilot:readiness -- `
    --database-path "$DatabasePath" `
    --format $Format `
    --exchange-account-id $ExchangeAccountId `
    --deployment-id $DeploymentId `
    --checked-at $checkedAt `
    --freshness-threshold-ms $FreshnessThresholdMs
  $inspectionExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($inspectionExitCode -ne 0) {
  exit $inspectionExitCode
}
