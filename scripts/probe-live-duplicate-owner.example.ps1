# Copy this file to probe-live-duplicate-owner.local.ps1 and fill in the
# database identity and access key locally. The .local.ps1 copy is ignored by
# Git. Do not commit the access key.
#
# This probe verifies LIVE database identity read-only and attempts only the
# same Windows named-pipe process lock used by startup. It never constructs the
# application, writes SQLite, starts workers, calls APIs, or transmits orders.

$ErrorActionPreference = "Stop"

$env:LIVE_DUPLICATE_OWNER_PROBE_CONFIRMATION = "REPLACE_WITH_I_UNDERSTAND_THIS_ONLY_PROBES_RUNTIME_OWNERSHIP"
if ($env:LIVE_DUPLICATE_OWNER_PROBE_CONFIRMATION -ne "I_UNDERSTAND_THIS_ONLY_PROBES_RUNTIME_OWNERSHIP") {
  throw "Refusing to probe until LIVE_DUPLICATE_OWNER_PROBE_CONFIRMATION is set in the local copy."
}

$env:APP_EXECUTION_MODE = "LIVE"
$env:ENABLE_LIVE_ORDERS = "false"
$RepositoryRoot = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")
$env:DATABASE_PATH = (Resolve-Path -LiteralPath (Join-Path $RepositoryRoot "var/company-live.sqlite") -ErrorAction Stop).Path
$env:LIVE_DATABASE_INSTANCE_ID = "REPLACE_WITH_PROVISIONED_DATABASE_INSTANCE_UUID"
$env:UPBIT_ACCESS_KEY = "REPLACE_WITH_UPBIT_ACCESS_KEY"

$requiredEnv = @(
  "DATABASE_PATH",
  "LIVE_DATABASE_INSTANCE_ID",
  "UPBIT_ACCESS_KEY"
)

foreach ($name in $requiredEnv) {
  $value = [Environment]::GetEnvironmentVariable($name, "Process")
  if ([string]::IsNullOrWhiteSpace($value) -or $value.StartsWith("REPLACE_WITH_")) {
    throw "Refusing to probe because $name is not configured in the local copy."
  }
}

Write-Host "Probing the AutoTrade_Upbit LIVE process-lock boundary without starting a runtime."
Write-Host "PASS/DUPLICATE_BLOCKED means an existing owner rejected the probe."
Write-Host "BLOCK/NO_ACTIVE_OWNER means the probe acquired and immediately released the lock."

npm.cmd run probe:live:duplicate-owner
