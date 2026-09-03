<#
.SYNOPSIS
  Install Primetime GPS as a Windows service so it survives a reboot.

.DESCRIPTION
  Downloads WinSW, renders deploy/ptt-gps.xml from the template for this
  machine, registers the service and starts it. Safe to re-run: it reinstalls
  cleanly over an existing install.

  Run from an elevated PowerShell:
      .\deploy\install-service.ps1

.PARAMETER Port
  API port the console is served on. Must match the service XML if you change it.
#>
[CmdletBinding()]
param(
  [int]$Port = 8080,
  [int]$IngestPort = 1000,
  [switch]$StopDevServers,
  [string]$WinSwVersion = '2.12.0'
)

$ErrorActionPreference = 'Stop'
$deploy = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $deploy
# WinSW reads the config file named after itself, so this must sit beside
# ptt-gps.xml under the same base name.
$exe = Join-Path $deploy 'ptt-gps.exe'

function Require-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell - installing a service needs administrator.'
  }
}

function Get-PortHolder([int]$p) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($conn) { return Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue }
  } catch { }
  return $null
}

# `npm run dev` supervises the server with tsx watch, so stopping the process
# that holds the port just prompts the watcher to start another one and take it
# straight back. Walk up to the outermost supervisor so the advice works.
# Killing the process that holds the port is not enough: tsx watch starts
# another within a second. Kill the watchers first so nothing is left to
# restart anything, then whatever remains. Two passes, because killing a tree
# shifts the list underneath us.
function Stop-DevServers {
  foreach ($pass in 1..2) {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'ptt-gps' } |
      Sort-Object { if ($_.CommandLine -match 'tsx.*watch') { 0 } else { 1 } }
    foreach ($proc in $procs) {
      Write-Host "  killing PID $($proc.ProcessId)"
      & taskkill /PID $proc.ProcessId /T /F 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 2
  }
}

function Get-Supervisor($proc) {
  $top = $proc.ProcessId
  $cur = $proc
  for ($i = 0; $i -lt 8; $i++) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
    if (-not $parent) { break }
    if ($parent.CommandLine -notmatch 'tsx|npm-cli|npm run dev') { break }
    $top = $parent.ProcessId
    $cur = $parent
  }
  return $top
}

Require-Admin

# --- the service runs the built output, so build it --------------------------
# Always, rather than only when dist is missing. A stale dist is the worse
# failure of the two: the service comes up, looks healthy, and serves code
# nobody can account for.
Write-Host 'Building...' -ForegroundColor Cyan
Push-Location $root
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }
} finally { Pop-Location }

# The console is served from admin-ui/dist; without it the service runs but
# only answers the API, which is a confusing way to discover a missing build.
if (-not (Test-Path (Join-Path $root 'admin-ui\dist\index.html'))) {
  throw 'admin-ui/dist is missing - run "npm run build" in the repo root first.'
}

# --- WinSW ------------------------------------------------------------------
if (-not (Test-Path $exe)) {
  $url = "https://github.com/winsw/winsw/releases/download/v$WinSwVersion/WinSW.NET461.exe"
  Write-Host "Downloading WinSW $WinSwVersion..."

  # Invoke-WebRequest in Windows PowerShell renders a progress bar per chunk,
  # which on a binary of this size is slow enough to look like a hang and
  # occasionally drops the connection outright. Silencing it is not cosmetic.
  $prevProgress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  # Add TLS 1.2 rather than replacing whatever is already enabled.
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  try {
    Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing -TimeoutSec 120
  } catch {
    Write-Host "Invoke-WebRequest failed ($($_.Exception.Message)) - trying curl." -ForegroundColor Yellow
    if (Test-Path $exe) { Remove-Item $exe -Force }
    # curl.exe ships with Windows 10 1803 and Server 2019 onwards, and does its
    # own TLS, so it gets past most of what trips the cmdlet.
    & curl.exe -sSL --fail -o "$exe" "$url"
    if ($LASTEXITCODE -ne 0) { throw 'curl failed too' }
  } finally {
    $ProgressPreference = $prevProgress
  }

  # A failed download can leave an HTML error page with an .exe name, which
  # fails much later and much more confusingly. Check it is really a binary.
  $header = [System.IO.File]::ReadAllBytes($exe)[0..1]
  if ((Get-Item $exe).Length -lt 100000 -or $header[0] -ne 0x4D -or $header[1] -ne 0x5A) {
    Remove-Item $exe -Force
    throw "Downloaded file was not a Windows executable. Download $url by hand and save it as deploy\ptt-gps.exe, then re-run this script."
  }
}

$existing = Get-Service -Name 'ptt-gps' -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host 'Service already installed - reinstalling.' -ForegroundColor Yellow
  & $exe stop   | Out-Null
  & $exe uninstall | Out-Null
  # Wait for the old process to actually let go rather than guessing at a
  # sleep. A stop that has not finished looks exactly like a foreign process
  # holding the port, and the check below would blame the wrong thing.
  foreach ($i in 1..20) {
    if (-not (Get-PortHolder $Port) -and -not (Get-PortHolder $IngestPort)) { break }
    Start-Sleep -Seconds 1
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null

# --- render the config for this machine --------------------------------------
# The service account is LocalSystem, which does not share your PATH, so the
# path to node is resolved here rather than left for the service to look up.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  throw 'node is not on PATH. Install Node.js, or open a new shell if you just did.'
}
Write-Host "Using node at $node"
(Get-Content -Raw (Join-Path $deploy 'ptt-gps.xml.template')).Replace('@@NODE@@', $node) |
  Set-Content -Path (Join-Path $deploy 'ptt-gps.xml') -Encoding ascii

# --- is anything else already running? ---------------------------------------
# Our own service is gone by this point, so a listener on either port is a
# server someone started by hand. It would block the service two ways at once:
# the new process loses the bind, and it contends for the same SQLite file.
$blocker = Get-PortHolder $Port
$blockedPort = $Port
if (-not $blocker) {
  $blocker = Get-PortHolder $IngestPort
  $blockedPort = $IngestPort
}
if ($blocker -and $StopDevServers) {
  Write-Host ''
  Write-Host "Port $blockedPort is held by PID $($blocker.ProcessId) - stopping dev servers." -ForegroundColor Yellow
  Stop-DevServers
  $blocker = Get-PortHolder $Port
  if (-not $blocker) { $blocker = Get-PortHolder $IngestPort }
  if ($blocker) {
    Write-Host "PID $($blocker.ProcessId) is still holding a port after the kill:" -ForegroundColor Red
    Write-Host "  $($blocker.CommandLine)"
    throw 'Could not free the ports.'
  }
  Write-Host 'Ports are free.' -ForegroundColor Green
} elseif ($blocker) {
  $top = Get-Supervisor $blocker
  Write-Host ''
  Write-Host "Port $blockedPort is already held by PID $($blocker.ProcessId)." -ForegroundColor Red
  Write-Host "  $($blocker.CommandLine)"
  Write-Host ''
  Write-Host 'The service cannot run alongside it: they want the same ports and the'
  Write-Host 'same database.'
  Write-Host ''
  Write-Host 'Re-run with -StopDevServers to stop it, or do it by hand:' -ForegroundColor Yellow
  if ($top -ne $blocker.ProcessId) {
    # tsx watch restarts its child, so the child's PID is the wrong target.
    Write-Host "  taskkill /PID $top /T /F"
  } else {
    Write-Host "  Stop-Process -Id $($blocker.ProcessId) -Force"
  }
  throw "Port $blockedPort is in use."
}

Write-Host 'Installing service...'
& $exe install
if ($LASTEXITCODE -ne 0) { throw 'WinSW install failed' }

& $exe start
if ($LASTEXITCODE -ne 0) { throw 'WinSW start failed' }

# --- prove it is actually serving, not merely "started" ----------------------
Write-Host 'Waiting for the console to answer...'
$ok = $false
foreach ($i in 1..30) {
  Start-Sleep -Seconds 1
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
    if ($h.ok) {
      Write-Host ''
      Write-Host "Running version $($h.version) - $($h.events) event(s) active." -ForegroundColor Green
      $ok = $true
      break
    }
  } catch { }
}
if (-not $ok) {
  # Naming a log file and stopping leaves the reader to do the work. Show it.
  Write-Host ''
  Write-Host "Service started but nothing answered on port $Port." -ForegroundColor Red
  Write-Host "Service state: $((Get-Service -Name 'ptt-gps' -ErrorAction SilentlyContinue).Status)"

  foreach ($name in @('ptt-gps.err.log', 'ptt-gps.out.log', 'ptt-gps.wrapper.log')) {
    $path = Join-Path $root "logs\$name"
    if (Test-Path $path) {
      $tail = Get-Content $path -Tail 20 -ErrorAction SilentlyContinue
      if ($tail) {
        Write-Host ''
        Write-Host "--- $name ---" -ForegroundColor Yellow
        $tail | ForEach-Object { Write-Host "  $_" }
      }
    }
  }

  # A watcher can start a dev server again between the check above and now, and
  # then the console that fails to answer is not the one we just installed.
  $thief = Get-PortHolder $Port
  if ($thief -and $thief.CommandLine -match 'tsx|src[\\/]index\.ts') {
    Write-Host ''
    Write-Host "Port $Port was taken by a dev server while the service started:" -ForegroundColor Yellow
    Write-Host "  PID $($thief.ProcessId)  $($thief.CommandLine)"
    Write-Host 'Re-run with -StopDevServers.'
  } elseif (-not $thief) {
    Write-Host ''
    Write-Host 'If the logs are empty, node itself never started - check that' -ForegroundColor Yellow
    Write-Host "  $node"
    Write-Host '  is readable by LocalSystem.'
  }
  throw 'Service did not come up.'
}

Write-Host ''
Write-Host 'Installed. It will start automatically after a reboot.' -ForegroundColor Green
Write-Host '  status:  Get-Service ptt-gps'
Write-Host '  stop:    Stop-Service ptt-gps'
Write-Host '  logs:    logs\ptt-gps.out.log'
Write-Host '  update:  .\deploy\update.ps1'
