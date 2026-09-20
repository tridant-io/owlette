# Fetch the Ubuntu 24.04 LTS live-server ISO for the kiosk VM (tri-platform
# task 0.0). Runs UNELEVATED - nothing here touches Hyper-V.
#
#   .\01-fetch-iso.ps1
#
# IDEMPOTENT ON PURPOSE. The ISO is ~3 GB: a re-run that finds a local file
# whose SHA256 already matches SHA256SUMS does nothing and prints the path. A
# file that does NOT match is deleted rather than reused - a truncated ISO
# still boots far enough to burn 20 minutes before failing in the installer.
#
# The point release is discovered from SHA256SUMS instead of hardcoded. The
# 24.04.x line respins about every six months and releases.ubuntu.com keeps
# only the current one, so a pinned filename starts 404ing without warning.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM, so a stray em-dash breaks the parse.

param(
  [string]$IsoDir = "C:\VMs\iso",
  [string]$BaseUrl = "https://releases.ubuntu.com/24.04",
  # Re-download even when the local copy verifies. For recovering from a file
  # that is intact but was built from the wrong flavour (desktop vs server).
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-ubuntu-fetch-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  # PS 5.1 still defaults to TLS 1.0/1.1 here, which releases.ubuntu.com refuses.
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  New-Item -ItemType Directory -Force $IsoDir | Out-Null

  Write-Host "reading $BaseUrl/SHA256SUMS" -ForegroundColor Cyan
  # SHA256SUMS is served without a text/* content type, so PS 5.1 hands back
  # .Content as a Byte[] and every string operation on it silently finds
  # nothing. Decode explicitly instead of trusting the type.
  $raw = (Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS" -UseBasicParsing).Content
  $sums = if ($raw -is [byte[]]) { [Text.Encoding]::UTF8.GetString($raw) } else { [string]$raw }

  # Lines look like: <64 hex>  *ubuntu-24.04.3-live-server-amd64.iso
  $candidates = @()
  foreach ($line in ($sums -split "`n")) {
    if ($line -match '^([0-9a-fA-F]{64})\s+\*?(ubuntu-24\.04\.(\d+)-live-server-amd64\.iso)\s*$') {
      $candidates += [pscustomobject]@{
        Sha256 = $matches[1].ToLower(); Name = $matches[2]; Point = [int]$matches[3]
      }
    }
  }
  if ($candidates.Count -eq 0) { throw "no live-server-amd64 ISO listed in $BaseUrl/SHA256SUMS" }
  $pick = $candidates | Sort-Object Point -Descending | Select-Object -First 1
  $iso = Join-Path $IsoDir $pick.Name
  Write-Host "selected $($pick.Name)" -ForegroundColor Green
  Write-Host "expected sha256 $($pick.Sha256)" -ForegroundColor DarkGray

  if ((Test-Path $iso) -and -not $Force) {
    Write-Host "verifying existing copy..." -ForegroundColor Cyan
    $have = (Get-FileHash -Path $iso -Algorithm SHA256).Hash.ToLower()
    if ($have -eq $pick.Sha256) {
      Write-Host "ISO already present and verified: $iso" -ForegroundColor Green
      Write-Host "FETCH OK $iso"
      return
    }
    Write-Host "existing copy does not match ($have) - removing." -ForegroundColor Yellow
    Remove-Item $iso -Force
  } elseif ((Test-Path $iso) -and $Force) {
    Remove-Item $iso -Force
  }

  # BITS first: it resumes, survives a transient drop, and does not buffer the
  # whole 3 GB in memory the way Invoke-WebRequest does on PS 5.1. curl.exe is
  # the fallback because BITS is disabled on some hardened boxes.
  $url = "$BaseUrl/$($pick.Name)"
  try {
    Import-Module BitsTransfer -ErrorAction Stop
    Write-Host "downloading via BITS: $url" -ForegroundColor Cyan
    Start-BitsTransfer -Source $url -Destination $iso -Description "ubuntu kiosk ISO" -ErrorAction Stop
  } catch {
    Write-Host "BITS unavailable or failed ($($_.Exception.Message)) - falling back to curl.exe" -ForegroundColor Yellow
    if (Test-Path $iso) { Remove-Item $iso -Force }
    & curl.exe -L --fail --silent --show-error --retry 3 -o $iso $url
    if ($LASTEXITCODE -ne 0) { throw "curl.exe exited $LASTEXITCODE" }
  }

  Write-Host "verifying sha256..." -ForegroundColor Cyan
  $have = (Get-FileHash -Path $iso -Algorithm SHA256).Hash.ToLower()
  if ($have -ne $pick.Sha256) {
    Remove-Item $iso -Force
    throw "sha256 mismatch: got $have, expected $($pick.Sha256) - deleted the download"
  }

  $gb = [Math]::Round((Get-Item $iso).Length / 1GB, 2)
  Write-Host "verified $iso ($gb GB)" -ForegroundColor Green
  Write-Host "FETCH OK $iso"
}
catch {
  Write-Host "FETCH FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
