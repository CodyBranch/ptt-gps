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
  [string]$Branch = 'main',
  [string]$StatusFile
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Push-Location $root

# --- progress the console can follow -----------------------------------------
# A deploy restarts the service, so the process asking for it dies partway
# through and cannot be told how it ended. Progress goes to a file instead,
# which outlives the restart and is what the console reads afterwards. It sits
# with the database rather than in the repo, so a rollback cannot revert it.
$script:Stage = 'starting'
$script:Lines = New-Object System.Collections.ArrayList

function Set-Stage([string]$stage, [string]$message, [bool]$done = $false, [bool]$ok = $false) {
  $script:Stage = $stage
  if ($message) {
    [void]$script:Lines.Add($message)
    Write-Host $message -ForegroundColor Cyan
  }
  if (-not $StatusFile) { return }
  try {
    $dir = Split-Path -Parent $StatusFile
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $payload = [ordered]@{
      stage      = $stage
      message    = $message
      log        = @($script:Lines)
      done       = $done
      ok         = $ok
      updatedAt  = (Get-Date).ToUniversalTime().ToString('o')
    }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -Path $StatusFile -Encoding utf8
  } catch {
    # Never let reporting failure break the deploy it is reporting on.
    Write-Host "(could not write status: $($_.Exception.Message))" -ForegroundColor DarkGray
  }
}

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

  $pullNeeded = $local -ne $remote

  # Being on the newest commit is not the same as running it. Pulling by hand
  # leaves the tree ahead of the build, and the service keeps serving the old
  # dist indefinitely because nothing rebuilt it - a state that looks
  # up to date from every angle except the one that matters.
  $dist = Join-Path $root 'server\dist\index.js'
  $headTime = [datetime]::Parse((& $git log -1 --format=%cI HEAD).Trim())
  $buildStale = (-not (Test-Path $dist)) -or ((Get-Item $dist).LastWriteTime.ToUniversalTime() -lt $headTime.ToUniversalTime())

  if (-not $pullNeeded -and -not $buildStale) {
    Set-Stage 'up-to-date' "Already up to date ($($local.Substring(0,7)))." $true $true
    return
  }

  if ($pullNeeded) {
    $log = & $git log --oneline --no-decorate "HEAD..origin/$Branch"
    Write-Host ''
    Write-Host "$($log.Count) commit(s) waiting:" -ForegroundColor Cyan
    $log | ForEach-Object { Write-Host "  $_" }
    Write-Host ''
  } else {
    $log = @()
    Write-Host ''
    Write-Host "Up to date at $($local.Substring(0,7)), but the running build is older than it." -ForegroundColor Yellow
    Write-Host 'Rebuilding and restarting so the service runs what the tree says.'
    Write-Host ''
  }

  if ($Check) { return }

  # --- interlocks -----------------------------------------------------------
  # Local edits to code would be discarded or would block the pull; either way
  # somebody should look at them first.
  #
  # Event configs and courses are the exception. They are operator data that
  # happens to live in the repo, written on the box through the console, so a
  # production tree is dirty by design and blocking on them would refuse every
  # deploy forever.
  $dirty = & $git status --porcelain
  $dataChanges = @()
  $codeChanges = @()
  foreach ($line in $dirty) {
    # Porcelain format is 'XY path', with forward slashes, quoted if unusual.
    $file = $line.Substring(3).Trim('"')
    if ($file -like 'events/*') { $dataChanges += $line } else { $codeChanges += $line }
  }

  if ($codeChanges) {
    Write-Host 'The working tree on this machine has local code changes:' -ForegroundColor Red
    $codeChanges | ForEach-Object { Write-Host "  $_" }
    throw "Refusing to update over local code changes: $($codeChanges -join '; ')"
  }

  if ($dataChanges) {
    Write-Host "$($dataChanges.Count) local event/course change(s) - these are yours, and are kept:" -ForegroundColor Cyan
    $dataChanges | ForEach-Object { Write-Host "  $_" }
    Write-Host ''
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
    $ask = if ($pullNeeded) { 'Deploy these commits? (y/N)' } else { 'Rebuild and restart? (y/N)' }
    $answer = Read-Host $ask
    if ($answer -notmatch '^(y|yes)$') { Write-Host 'Cancelled.'; return }
  }

  # --- prepare, with the old build still serving ----------------------------
  if ($pullNeeded) {
    Set-Stage 'pulling' "Pulling $($log.Count) commit(s)..."
    & $git pull --ff-only origin $Branch
    if ($LASTEXITCODE -ne 0) { throw 'git pull failed (not a fast-forward?)' }
  }

  # Dependencies are only touched when they actually changed.
  #
  # `npm ci` deletes node_modules and reinstalls from scratch, which cannot
  # work here: the running service holds native modules open (ngrok's .node
  # among them) and Windows refuses to unlink a loaded binary. The whole point
  # of this script is that the old build keeps serving while the new one is
  # prepared, so the install has to tolerate a running server.
  #
  # `npm install` leaves packages that are already correct alone, so it only
  # goes near the locked files when a dependency genuinely moved.
  $depsChanged = $false
  if ($pullNeeded) {
    $touched = & $git diff --name-only "$local..HEAD"
    $depsChanged = [bool]($touched | Where-Object { $_ -match '(^|/)(package\.json|package-lock\.json)$' })
  }

  if ($depsChanged) {
    Set-Stage 'installing' 'Dependencies changed - installing...'
    & $npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      throw 'npm install failed - the old build is still running, nothing was changed'
    }
  } else {
    Set-Stage 'installing' 'Dependencies unchanged - skipping install.'
  }

  Set-Stage 'building' 'Building...'
  & $npm run build
  if ($LASTEXITCODE -ne 0) { throw 'build failed - the old build is still running' }

  Set-Stage 'testing' 'Running tests...'
  & $npm test
  if ($LASTEXITCODE -ne 0) { throw 'tests failed - the old build is still running' }

  # --- swap -----------------------------------------------------------------
  # Everything above ran while the old build was still serving. This is the
  # first irreversible step, and the one that kills whoever asked for it.
  Set-Stage 'restarting' 'Restarting the service...'
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

    # reset --hard reverts the whole tree, and events/ is tracked, so a
    # rollback would quietly undo operator edits to real event configs. Set
    # them aside first and put them back afterwards: losing an event to a
    # failed deploy would be far worse than the failed deploy.
    $keep = Join-Path $env:TEMP "ptt-gps-events-$($local.Substring(0,7))"
    if (Test-Path $keep) { Remove-Item $keep -Recurse -Force }
    Copy-Item (Join-Path $root 'events') $keep -Recurse -Force
    Write-Host "  events/ copied to $keep"

    & $git reset --hard $local
    Copy-Item "$keep\*" (Join-Path $root 'events') -Recurse -Force
    Write-Host '  events/ restored'

    # Same constraint as above, and the service is down at this point, so a
    # clean install would be possible - but it is also the slowest way back.
    if ($depsChanged) { & $npm install --no-audit --no-fund }
    & $npm run build
    Restart-Service -Name 'ptt-gps' -Force
    Set-Stage 'rolled-back' "New build did not come up. Rolled back to $($local.Substring(0,7))." $true $false
    throw "Rolled back to $($local.Substring(0,7)). Check logs\ptt-gps.err.log for why."
  }

  $short = (& $git rev-parse --short HEAD).Trim()
  Set-Stage 'done' "Deployed version $($h.version) at $short." $true $true
  Write-Host "$($h.events) event(s) active, $($h.races.live) race(s) live."
}
catch {
  # The console has no other way to learn why a deploy it started never
  # finished: the process it was talking to is gone.
  if ($script:Stage -ne 'rolled-back') {
    Set-Stage 'failed' $_.Exception.Message $true $false
  }
  throw
}
finally {
  Pop-Location
}
