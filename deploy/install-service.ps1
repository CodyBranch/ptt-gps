<#
.SYNOPSIS
  Install Primetime GPS as a Windows service so it survives a reboot.

.DESCRIPTION
  Downloads WinSW next to deploy/ptt-gps.xml, registers the service and starts
  it. Safe to re-run: it reinstalls cleanly over an existing install.

  Run from an elevated PowerShell:
      .\deploy\install-service.ps1

.PARAMETER Port
  API port the console is served on. Must match the service XML if you change it.
#>
[CmdletBinding()]
param(
  [int]$Port = 8080,
  [string]$WinSwVersion = '2.12.0'
)

$ErrorActionPreference = 'Stop'
$deploy = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $deploy
$exe = Join-Path $deploy 'WinSW.exe'

function Require-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this from an elevated PowerShell - installing a service needs administrator.'
  }
}

Require-Admin

# --- the service runs the built output, so it has to exist -------------------
if (-not (Test-Path (Join-Path $root 'server\dist\index.js'))) {
  Write-Host 'Server is not built yet - building.' -ForegroundColor Yellow
  Push-Location $root
  try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'build failed' }
  } finally { Pop-Location }
}

# The console is served from admin-ui/dist; without it the service runs but
# only answers the API, which is a confusing way to discover a missing build.
if (-not (Test-Path (Join-Path $root 'admin-ui\dist\index.html'))) {
  throw 'admin-ui/dist is missing - run "npm run build" in the repo root first.'
}

# --- WinSW ------------------------------------------------------------------
if (-not (Test-Path $exe)) {
  $url = "https://github.com/winsw/winsw/releases/download/v$WinSwVersion/WinSW-net461.exe"
  Write-Host "Downloading WinSW $WinSwVersion..."
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $exe
}

$existing = Get-Service -Name 'ptt-gps' -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host 'Service already installed - reinstalling.' -ForegroundColor Yellow
  & $exe stop   | Out-Null
  & $exe uninstall | Out-Null
  Start-Sleep -Seconds 2
}

New-Item -ItemType Directory -Force -Path (Join-Path $root 'logs') | Out-Null

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
  throw "Service started but did not answer on port $Port. Check logs\ptt-gps.out.log and .err.log."
}

Write-Host ''
Write-Host 'Installed. It will start automatically after a reboot.' -ForegroundColor Green
Write-Host '  status:  Get-Service ptt-gps'
Write-Host '  stop:    Stop-Service ptt-gps'
Write-Host '  logs:    logs\ptt-gps.out.log'
Write-Host '  update:  .\deploy\update.ps1'
