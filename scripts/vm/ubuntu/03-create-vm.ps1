# Create the Ubuntu kiosk VM (tri-platform task 0.0). Run ELEVATED - Hyper-V
# cmdlets refuse a caller who is neither elevated nor in "Hyper-V
# Administrators", and Get-VM alone fails with a permission error.
#
#   .\03-create-vm.ps1            # after 01-fetch-iso.ps1 and 02-seed-iso.ps1
#   .\03-create-vm.ps1 -Recreate  # throw the VM and its disk away first
#
# IDEMPOTENT ON PURPOSE, for the same reason 02-create-vm.ps1 (the Windows
# fleet VM) is: a run that dies halfway leaves a registered VM behind, and
# without per-step checks the retry fails at New-VM instead of resuming.
#
# Sizing: 4 vCPU and a flat 4096 MB - dynamic memory is OFF deliberately. A
# GNOME session that starts under a 512 MB minimum balloons badly on Hyper-V,
# and this guest exists to measure how the agent behaves, not how Hyper-V
# reclaims pages. 40 GB dynamic VHDX: ubuntu-desktop-minimal plus the agent
# lands around 9 GB used.
#
# Secure Boot is ON with the MicrosoftUEFICertificateAuthority template - the
# Windows template trusts only Microsoft's Windows CA, which does not cover
# Ubuntu's shim, so a Gen-2 Ubuntu guest will not boot under it.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM, so a stray em-dash breaks the parse.

#Requires -RunAsAdministrator
param(
  [string]$Name = "owlette-kiosk",
  [string]$VmRoot = "C:\VMs",
  [string]$SwitchName = "Default Switch",
  [string]$IsoDir = "C:\VMs\iso",
  # Defaults to the newest ISO 02-seed-iso.ps1 patched with the autoinstall
  # kernel argument. The unpatched ISO stops at a confirmation prompt.
  [string]$InstallerIso = "",
  [string]$SeedIso = "",
  [switch]$Recreate
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-ubuntu-create-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  $vmDir = Join-Path $VmRoot $Name
  if (-not $InstallerIso) {
    $InstallerIso = (Get-ChildItem -Path $IsoDir -Filter 'ubuntu-24.04.*-live-server-amd64-autoinstall.iso' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName)
  }
  if (-not $SeedIso) { $SeedIso = Join-Path $vmDir 'seed.iso' }
  if (-not $InstallerIso -or -not (Test-Path $InstallerIso)) { throw "no autoinstall installer ISO in $IsoDir - run 02-seed-iso.ps1" }
  if (-not (Test-Path $SeedIso)) { throw "seed ISO not found: $SeedIso - run 02-seed-iso.ps1" }
  Write-Host "installer: $InstallerIso" -ForegroundColor Cyan
  Write-Host "seed:      $SeedIso" -ForegroundColor Cyan

  New-Item -ItemType Directory -Force $vmDir | Out-Null
  $vhd = Join-Path $vmDir "$Name.vhdx"

  # --- the VM ----------------------------------------------------------------
  $vm = Get-VM -Name $Name -ErrorAction SilentlyContinue
  if ($vm -and $Recreate) {
    Write-Host "-Recreate: removing existing VM '$Name'." -ForegroundColor Yellow
    if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
    Get-VMSnapshot -VMName $Name -ErrorAction SilentlyContinue | Remove-VMSnapshot -Confirm:$false
    Remove-VM -VM $vm -Force
    if (Test-Path $vhd) { Remove-Item $vhd -Force }
    $vm = $null
  }
  if ($vm) {
    Write-Host "VM '$Name' already exists - reconfiguring in place." -ForegroundColor Yellow
    if ($vm.State -ne 'Off') { throw "VM is $($vm.State). Shut it down before reconfiguring, or re-run with -Recreate." }
  } else {
    if (Test-Path $vhd) {
      # Left by a run that died between New-VHD and VM registration. Worthless
      # - the image is built from scratch - and New-VM refuses to overwrite it.
      Write-Host "removing orphaned VHDX from a failed run: $vhd" -ForegroundColor Yellow
      Remove-Item $vhd -Force
    }
    $vm = New-VM -Name $Name -Generation 2 -MemoryStartupBytes 4096MB `
      -NewVHDPath $vhd -NewVHDSizeBytes 40GB -Path $VmRoot
    Write-Host "created VM '$Name'." -ForegroundColor Green
  }

  Set-VM -VM $vm -ProcessorCount 4 -StaticMemory -MemoryStartupBytes 4096MB `
    -AutomaticCheckpointsEnabled $false -CheckpointType Standard `
    -AutomaticStopAction Save
  # Nothing in the guest runs a hypervisor of its own; leaving the extensions
  # exposed only costs the host the ability to live-migrate or resize memory.
  Set-VMProcessor -VM $vm -ExposeVirtualizationExtensions $false

  # --- firmware --------------------------------------------------------------
  Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftUEFICertificateAuthority

  # --- media: DVD 1 installer, DVD 2 cloud-init seed -------------------------
  # Both are SCSI devices on Gen 2. Order matters only for the boot device; the
  # seed is found by its "cidata" volume label, not by position.
  $dvds = @(Get-VMDvdDrive -VM $vm)
  while ($dvds.Count -lt 2) {
    Add-VMDvdDrive -VM $vm
    $dvds = @(Get-VMDvdDrive -VM $vm)
  }
  if ($dvds.Count -gt 2) { throw "VM has $($dvds.Count) DVD drives - expected 2. Re-run with -Recreate." }
  $dvds = @($dvds | Sort-Object ControllerNumber, ControllerLocation)
  Set-VMDvdDrive -VMName $Name -ControllerNumber $dvds[0].ControllerNumber -ControllerLocation $dvds[0].ControllerLocation -Path $InstallerIso
  Set-VMDvdDrive -VMName $Name -ControllerNumber $dvds[1].ControllerNumber -ControllerLocation $dvds[1].ControllerLocation -Path $SeedIso
  $dvds = @(Get-VMDvdDrive -VM $vm | Sort-Object ControllerNumber, ControllerLocation)

  # Boot the installer first; 04-install.ps1 points this at the disk once the
  # install is done and the media is ejected.
  Set-VMFirmware -VM $vm -FirstBootDevice $dvds[0]

  # --- network ---------------------------------------------------------------
  # Connect-VMNetworkAdapter is the one cmdlet here with no -VM parameter:
  # passing -VM fails with "the parameter name 'VM' is ambiguous".
  if (-not (Get-VMSwitch -Name $SwitchName -ErrorAction SilentlyContinue)) {
    $available = (Get-VMSwitch | Select-Object -Expand Name) -join ', '
    throw "switch '$SwitchName' not found. Available: $available"
  }
  $nic = Get-VMNetworkAdapter -VM $vm | Select-Object -First 1
  if ($nic.SwitchName -ne $SwitchName) { Connect-VMNetworkAdapter -VMName $Name -SwitchName $SwitchName }

  $vm = Get-VM -Name $Name
  Write-Host ""
  $vm | Format-List Name, State, ProcessorCount, MemoryStartup, DynamicMemoryEnabled,
    AutomaticStopAction, AutomaticCheckpointsEnabled | Out-String | Write-Host
  Get-VMFirmware -VM $vm | Format-List SecureBoot, SecureBootTemplate | Out-String | Write-Host
  Get-VMDvdDrive -VM $vm | Format-Table ControllerNumber, ControllerLocation, Path -AutoSize | Out-String | Write-Host

  Write-Host "CREATE OK" -ForegroundColor Green
  Write-Host "next: 04-install.ps1 (starts the VM and waits for the unattended install)" -ForegroundColor Yellow
}
catch {
  Write-Host "CREATE FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
