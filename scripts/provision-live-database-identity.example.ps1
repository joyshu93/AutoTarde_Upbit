# Copy this file to provision-live-database-identity.local.ps1 and fill it in locally.
# Stop the LIVE process and back up the database before running this one-time command.

$ErrorActionPreference = "Stop"

$ProvisionConfirmation = "REPLACE_WITH_I_UNDERSTAND_THIS_WRITES_LIVE_DATABASE_IDENTITY"
if ($ProvisionConfirmation -ne "I_UNDERSTAND_THIS_WRITES_LIVE_DATABASE_IDENTITY") {
  throw "Refusing to provision LIVE database identity without the exact confirmation."
}

$RepositoryRoot = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")
$env:DATABASE_PATH = (Resolve-Path -LiteralPath (Join-Path $RepositoryRoot "var/company-live.sqlite") -ErrorAction Stop).Path
$env:LIVE_DATABASE_INSTANCE_ID = "REPLACE_WITH_A_NEW_UUID"
$env:UPBIT_ACCESS_KEY = "REPLACE_WITH_UPBIT_ACCESS_KEY"
$env:LIVE_DATABASE_IDENTITY_PROVISION_CONFIRMATION = "I_UNDERSTAND_THIS_WRITES_LIVE_DATABASE_IDENTITY"

foreach ($name in @("LIVE_DATABASE_INSTANCE_ID", "UPBIT_ACCESS_KEY")) {
  $value = [Environment]::GetEnvironmentVariable($name, "Process")
  if ([string]::IsNullOrWhiteSpace($value) -or $value.StartsWith("REPLACE_WITH_")) {
    throw "Refusing to provision because $name is not configured in the local copy."
  }
}

Write-Host "Provisioning identity for the existing LIVE database: $env:DATABASE_PATH"
Write-Host "This command applies pending migrations and inserts one immutable identity binding."
npm.cmd run provision:live-db-identity
