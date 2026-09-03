<#
.SYNOPSIS
  Pull, build, verify, then restart - in that order.

.DESCRIPTION
  The ordering is the point. Pulling and restarting first would leave the box
  down if the build failed; here everything is prepared and tested while the
  old process is still running and still tracking, and the service is only
  stopped once the new build is known good. A failure costs nothing but time.

  Refuses while a race is armed or live. Prints what it is about to deploy and
  asks, unless -Yes.

      .\deploy\update.ps1            # check, confirm, deploy
      .\deploy\update.ps1 -Check     # just say whether anything is waiting
      .\deploy\update.ps1 -Yes       # no prompt (for a scheduled window)

.PARAMETER Force
  Deploy even with a race armed or live. There is almost never a good reason.
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Yes,
  [switch]$Force,
  [int]$Port = 8080,
  [string]$Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Push-Location $root

function Health {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3 }
  catch { return $null }
}

# Resolved rather than assumed to be on PATH. A long-lived shell can predate
# the machine PATH that Git was added to, and an unattended run under the
# service account gets a minimal PATH of its own - in both cases the whole
# script is useless without git, including the rollback.
function Resolve-Tool([string]$name, [string[]]$candidates) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  throw "$name was not found. Install it, or add it to PATH."
}

$git = Resolve-Tool 'git' @(
  "$env:ProgramFiles\Git\cmd\git.exe",
  "${env:ProgramFiles(x86)}\Git\cmd\git.exe",
  "$env:LOCALAPPDATA\Programs\Git\cmd\git.exe"
)
$npm = Resolve-Tool 'npm.cmd' @("$env:ProgramFiles\nodejs\npm.cmd")

try {
  # --- what is waiting? -----------------------------------------------------
  & $git fetch --quiet origin $Branch
  if ($LASTEXITCODE -ne 0) { throw 'git fetch failed' }

  $local = (& $git rev-parse HEAD).Trim()
  $remote = (& $git rev-parse "origin/$Branch").Trim()

  if ($local -eq $remote) {
    Write-Host "Up to date ($($local.Substring(0,7)))." -ForegroundColor Green
    return
  }

  $log = & $git log --oneline --no-decorate "HEAD..origin/$Branch"
  Write-Host ''
  Write-Host "$($log.Count) commit(s) waiting:" -ForegroundColor Cyan
  $log | ForEach-Object { Write-Host "  $_" }
  Write-Host ''

  if ($Check) { return }

  # --- interlocks -----------------------------------------------------------
  # Local edits on the box would be discarded or would block the pull; either
  # way somebody should look at them first.
  $dirty = & $git status --porcelain
  if ($dirty) {
    Write-Host 'The working tree on this machine has local changes:' -ForegroundColor Red
    $dirty | ForEach-Object { Write-Host "  $_" }
    throw 'Refusing to update over local changes. Commit, stash or discard them first.'
  }

  $h = Health
  if ($null -eq $h) {
    Write-Host 'Service is not answering - updating anyway (nothing to interrupt).' -ForegroundColor Yellow
  } elseif (-not $h.safeToRestart) {
    $msg = "A race is running (armed $($h.races.armed), live $($h.races.live))."
    if (-not $Force) { throw "$msg Finish or reset it, or pass -Force if you really mean it." }
    Write-Host "$msg Continuing because -Force was given." -ForegroundColor Red
  }

  if (-not $Yes) {
    $answer = Read-Host 'Deploy these commits? (y/N)'
    if ($answer -notmatch '^(y|yes)$') { Write-Host 'Cancelled.'; return }
  }

  # --- prepare, with the old build still serving ----------------------------
  Write-Host ''
  Write-Host 'Pulling...' -ForegroundColor Cyan
  & $git pull --ff-only origin $Branch
  if ($LASTEXITCODE -ne 0) { throw 'git pull failed (not a fast-forward?)' }

  Write-Host 'Installing dependencies...' -ForegroundColor Cyan
  & $npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed - the old build is still running' }

  Write-Host 'Building...' -ForegroundColor Cyan
  & $npm run build
  if ($LASTEXITCODE -ne 0) { throw 'build failed - the old build is still running' }

  Write-Host 'Running tests...' -ForegroundColor Cyan
  & $npm test
  if ($LASTEXITCODE -ne 0) { throw 'tests failed - the old build is still running' }

  # --- swap -----------------------------------------------------------------
  Write-Host 'Restarting the service...' -ForegroundColor Cyan
  Restart-Service -Name 'ptt-gps' -Force

  $ok = $false
  foreach ($i in 1..30) {
    Start-Sleep -Seconds 1
    $h = Health
    if ($h -and $h.ok) { $ok = $true; break }
  }

  if (-not $ok) {
    Write-Host ''
    Write-Host 'The new build did not come up. Rolling back.' -ForegroundColor Red
    & $git reset --hard $local
    & $npm ci
    & $npm run build
    Restart-Service -Name 'ptt-gps' -Force
    throw "Rolled back to $($local.Substring(0,7)). Check logs\ptt-gps.err.log for why."
  }

  Write-Host ''
  Write-Host "Deployed version $($h.version) at $((& $git rev-parse --short HEAD).Trim())." -ForegroundColor Green
  Write-Host "$($h.events) event(s) active, $($h.races.live) race(s) live."
}
finally {
  Pop-Location
}
