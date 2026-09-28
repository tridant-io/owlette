# Install a candidate build on a CLEAN image and prove the service starts.
# Run ELEVATED.
#
# This is the check that would have caught the 3.2.1 bug before release:
# 3.2.0 installed perfectly and then the service could not start, because
# owlette-host.exe imported VCRUNTIME140.dll - shipped with the Visual C++
# redistributable, not with Windows. Every development machine has that
# redistributable, so "it works here" proves nothing about a freshly imaged
# kiosk, signage player or media server.
#
# Reverting to golden-empty first is the whole point: a machine that has ever
# had Owlette on it is not a clean image, and silent uninstall deliberately
# preserves user data.
#
# Installs silently (no pairing phrase, so pairing is skipped) because this
# verifies the RESULT, not the on-camera experience - 17-shoot-b03-b04.ps1 is
# the one that films it.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
param(
  [string]$Name = "owlette-e2e",
  [string]$Snapshot = "golden-empty",
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred'),
  [Parameter(Mandatory = $true)][string]$DownloadUrl,
  [Parameter(Mandatory = $true)][string]$ExeName,
  [string]$Sha256 = "",
  # How long to allow for the install plus the service reaching Running.
  [int]$InstallTimeoutSec = 600,
  [int]$ServiceTimeoutSec = 180
)

$ErrorActionPreference = 'Stop'

# Reverting and PowerShell Direct need Hyper-V rights, which a member of
# Hyper-V Administrators (S-1-5-32-578) holds without elevation; an elevated
# administrator has them too. Either is enough (the same guard as 18b).
$__id = [Security.Principal.WindowsIdentity]::GetCurrent()
$__pr = New-Object Security.Principal.WindowsPrincipal($__id)
$__hv = [bool]($__id.Groups | Where-Object { $_.Value -eq 'S-1-5-32-578' })
if (-not ($__hv -or $__pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) {
  throw "run this elevated, or as a member of Hyper-V Administrators"
}

try { Stop-Transcript | Out-Null } catch { }
$log = Join-Path $env:TEMP ("owlette-vm-verify-{0}-{1}.log" -f $PID, (Get-Date -Format 'HHmmss'))
try { Start-Transcript -Path $log -Force | Out-Null; Write-Host "transcript: $log" -ForegroundColor Cyan }
catch { Write-Host "(transcript unavailable)" -ForegroundColor DarkGray }

function Connect-Guest($vmName, $cred, [int]$minutes = 6) {
  $s = $null
  $deadline = (Get-Date).AddMinutes($minutes)
  while (-not $s -and (Get-Date) -lt $deadline) {
    try { $s = New-PSSession -VMName $vmName -Credential $cred -ErrorAction Stop }
    catch { Start-Sleep -Seconds 5 }
  }
  if (-not $s) { throw "PowerShell Direct did not come up within $minutes minutes" }
  return $s
}

$failures = @()

try {
  $vm = Get-VM -Name $Name -ErrorAction Stop
  $snap = Get-VMSnapshot -VMName $Name -Name $Snapshot -ErrorAction Stop
  if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
  Restore-VMSnapshot -VMSnapshot $snap -Confirm:$false
  Write-Host "reverted to '$Snapshot'." -ForegroundColor Green
  Start-VM -Name $Name

  $cred = Import-Clixml -Path $CredFile
  $s = Connect-Guest $Name $cred
  Write-Host "guest is up." -ForegroundColor Green

  # Prove it really is a clean image before trusting anything that follows.
  $pre = Invoke-Command -Session $s -ScriptBlock {
    [PSCustomObject]@{
      Svc    = [bool](Get-Service OwletteService -ErrorAction SilentlyContinue)
      Data   = Test-Path 'C:\ProgramData\Owlette'
      PawnIO = [bool](Get-Service PawnIO -ErrorAction SilentlyContinue)
      VCRun  = (Test-Path 'C:\Windows\System32\vcruntime140.dll')
    }
  }
  Write-Host ("clean-image check: OwletteService={0} ProgramData={1} PawnIO={2} vcruntime140-present={3}" -f `
    $pre.Svc, $pre.Data, $pre.PawnIO, $pre.VCRun)
  if ($pre.Svc)  { $failures += "the image already has OwletteService - the revert did not take" }
  if ($pre.Data) { $failures += "the image already has C:\ProgramData\Owlette" }
  if ($pre.VCRun) {
    Write-Host "NOTE: this image HAS vcruntime140.dll, so it cannot prove the static-CRT fix." -ForegroundColor Yellow
  }

  Write-Host "downloading the installer in-guest..." -ForegroundColor Cyan
  $dl = Invoke-Command -Session $s -ArgumentList $DownloadUrl, $ExeName -ScriptBlock {
    param($url, $exe)
    $dest = Join-Path ([Environment]::GetFolderPath('Desktop')) $exe
    if (Test-Path $dest) { Remove-Item $dest -Force }
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 600
    [PSCustomObject]@{
      Path  = $dest
      Bytes = (Get-Item $dest).Length
      Sha   = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
    }
  }
  Write-Host ("downloaded {0} bytes" -f $dl.Bytes) -ForegroundColor Green
  if ($Sha256 -and $dl.Sha -ne $Sha256.ToLower()) {
    throw "checksum mismatch in the guest: got $($dl.Sha), expected $($Sha256.ToLower())"
  }
  if ($Sha256) { Write-Host "checksum verified - this is the artifact that was uploaded." -ForegroundColor Green }

  # Silent, no /ADD: pairing is skipped, the service is still installed.
  Write-Host "installing silently..." -ForegroundColor Cyan
  $inst = Invoke-Command -Session $s -ArgumentList $dl.Path, $InstallTimeoutSec -ScriptBlock {
    param($exe, $timeout)
    $args = '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=C:\owlette-install.log'
    $p = Start-Process -FilePath $exe -ArgumentList $args -PassThru
    if (-not $p.WaitForExit($timeout * 1000)) {
      try { $p.Kill() } catch { }
      return [PSCustomObject]@{ TimedOut = $true; ExitCode = -1 }
    }
    [PSCustomObject]@{ TimedOut = $false; ExitCode = $p.ExitCode }
  }
  if ($inst.TimedOut) { $failures += "the installer did not finish within $InstallTimeoutSec s" }
  else { Write-Host ("installer exit code: {0}" -f $inst.ExitCode) -ForegroundColor Green }
  if (-not $inst.TimedOut -and $inst.ExitCode -ne 0) { $failures += "installer exit code $($inst.ExitCode)" }

  # THE assertion: does the service actually run on this machine?
  Write-Host "waiting for OwletteService to reach Running..." -ForegroundColor Cyan
  $svc = Invoke-Command -Session $s -ArgumentList $ServiceTimeoutSec -ScriptBlock {
    param($timeout)
    $deadline = (Get-Date).AddSeconds($timeout)
    $status = 'absent'
    while ((Get-Date) -lt $deadline) {
      $x = Get-Service OwletteService -ErrorAction SilentlyContinue
      if ($x) { $status = "$($x.Status)"; if ($x.Status -eq 'Running') { break } }
      Start-Sleep -Seconds 3
    }
    $hostExe = 'C:\ProgramData\Owlette\tools\owlette-host.exe'
    $imports = ''
    if (Test-Path $hostExe) {
      $bytes = [IO.File]::ReadAllBytes($hostExe)
      $ascii = [Text.Encoding]::ASCII.GetString($bytes)
      $imports = if ($ascii -match 'VCRUNTIME140\.dll') { 'VCRUNTIME140.dll' } else { 'none' }
    }
    [PSCustomObject]@{
      Status     = $status
      HostExists = (Test-Path $hostExe)
      VcImport   = $imports
      PawnIO     = [bool](Get-Service PawnIO -ErrorAction SilentlyContinue)
      LogTail    = (Get-Content 'C:\owlette-install.log' -Tail 6 -ErrorAction SilentlyContinue) -join ' | '
    }
  }

  Write-Host ""
  Write-Host ("OwletteService status : {0}" -f $svc.Status)
  Write-Host ("host exe present      : {0}" -f $svc.HostExists)
  Write-Host ("host CRT import       : {0}" -f $svc.VcImport)
  Write-Host ("PawnIO installed      : {0}" -f $svc.PawnIO)

  if ($svc.Status -ne 'Running') {
    $failures += "OwletteService is '$($svc.Status)', not Running"
    Write-Host ("install log tail: {0}" -f $svc.LogTail) -ForegroundColor Yellow
  }
  if ($svc.VcImport -ne 'none') {
    $failures += "the installed host still imports $($svc.VcImport)"
  }

  Remove-PSSession $s
  Write-Host ""
  if ($failures.Count) {
    Write-Host "VERIFY FAILED:" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
  }
  Write-Host "VERIFY OK - clean image, silent install, service Running, no VC++ runtime dependency." -ForegroundColor Green
}
catch {
  Write-Host "VERIFY ERROR: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
