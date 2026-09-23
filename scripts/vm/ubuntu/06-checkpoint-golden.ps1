# Take the golden checkpoint of the Ubuntu kiosk VM. Run ELEVATED, with the
# guest SHUT DOWN (or pass -StopFirst).
#
#   .\06-checkpoint-golden.ps1 -StopFirst
#
# This snapshot is the reset mechanism for every Linux agent test: installing
# the agent, pairing it, and running a session all leave state behind that no
# uninstall removes, so a revert is the only way back to a clean kiosk.
#
# Only run this after 05-verify-guest.ps1 passes. A checkpoint of an image
# whose session came up on Wayland, or whose webkit libraries never landed, is
# a broken baseline that every later run starts from.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
param(
  [string]$Name = "owlette-kiosk",
  [string]$SnapshotName = "",
  # Ask the guest to shut down first if it is still running.
  [switch]$StopFirst
)

$ErrorActionPreference = 'Stop'
if (-not $SnapshotName) { $SnapshotName = "golden-" + (Get-Date -Format 'yyyyMMdd') }
$log = Join-Path $env:TEMP ("owlette-ubuntu-checkpoint-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  $vm = Get-VM -Name $Name -ErrorAction Stop

  if ($vm.State -ne 'Off') {
    if (-not $StopFirst) {
      throw "VM is $($vm.State). Shut it down cleanly, or re-run with -StopFirst."
    }
    # Stop-VM requests a guest shutdown through the integration services
    # rather than pulling the plug: a checkpoint of a hard-killed guest carries
    # a dirty filesystem and an unreplayed journal into every future run.
    Write-Host "requesting clean shutdown..." -ForegroundColor Cyan
    Stop-VM -VM $vm -Force
    $deadline = (Get-Date).AddMinutes(5)
    while ((Get-VM -Name $Name).State -ne 'Off' -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
    if ((Get-VM -Name $Name).State -ne 'Off') { throw "guest did not shut down within 5 minutes" }
    Write-Host "guest is off." -ForegroundColor Green
  }

  $existing = Get-VMSnapshot -VMName $Name -Name $SnapshotName -ErrorAction SilentlyContinue
  if ($existing) {
    throw ("a snapshot named '$SnapshotName' already exists (created $($existing.CreationTime)). " +
           "Rename or remove it deliberately - overwriting a golden image silently is how a polluted " +
           "baseline gets baked in.")
  }

  Checkpoint-VM -VM $vm -SnapshotName $SnapshotName
  Write-Host "created checkpoint '$SnapshotName'." -ForegroundColor Green
  Get-VMSnapshot -VMName $Name | Select-Object Name, CreationTime, ParentSnapshotName |
    Format-Table -AutoSize | Out-String | Write-Host

  Write-Host "CHECKPOINT OK" -ForegroundColor Green
  Write-Host "revert with: Restore-VMSnapshot -VMName $Name -Name $SnapshotName -Confirm:`$false" -ForegroundColor Yellow
}
catch {
  Write-Host "CHECKPOINT FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
