# Run the unattended install and wait it out (tri-platform task 0.0).
# Run ELEVATED.
#
#   .\04-install.ps1
#
# The VM boots the patched installer ISO, subiquity reads the cidata seed on
# DVD 2, installs, and POWERS OFF - the seed says "shutdown: poweroff" rather
# than the default reboot, and that is load-bearing. A reboot would land back
# on DVD 1, which is still attached and still first in the boot order, and the
# autoinstall would run again on the machine it just built. Powering off ends
# the install at a point the host controls: eject, repoint the firmware at the
# disk, and start it once more.
#
# So the completion signal for phase 1 is the VM reaching Off, and for phase 2
# it is the INSTALLED system answering SSH as the kiosk user. The live
# installer session cannot fake that second signal: it never receives our key
# (the key lives under autoinstall:, which only subiquity reads) and it calls
# itself "ubuntu-server".
#
# A console thumbnail is written to the VM folder on every heartbeat. A stalled
# unattended install is otherwise completely opaque - the one screen that says
# what went wrong is the guest's own console.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
param(
  [string]$Name = "owlette-kiosk",
  [string]$VmRoot = "C:\VMs",
  # What the installed system must report as its hostname. This is the signal
  # that separates the installed guest from the live installer session.
  [string]$Hostname = "owlette-kiosk",
  [string]$Username = "kiosk",
  [string]$KeyPath = "",
  [int]$TimeoutMinutes = 45,
  # How long the first boot off the disk gets before it counts as a failure.
  [int]$BootTimeoutMinutes = 10
)

$ErrorActionPreference = 'Stop'
$vmDir = Join-Path $VmRoot $Name
if (-not $KeyPath) { $KeyPath = Join-Path $vmDir 'ssh\id_ed25519' }
$log = Join-Path $env:TEMP ("owlette-ubuntu-install-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

function Get-GuestIPv4([string]$vmName) {
  # Preferred source: the Hyper-V KVP daemon in the guest (installed by
  # linux-cloud-tools-virtual). It reports nothing until that package is up,
  # which is why the ARP fallback exists - the host has talked to the guest's
  # MAC by then whether or not KVP is running.
  $nic = Get-VMNetworkAdapter -VMName $vmName -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $nic) { return $null }
  $ip = $nic.IPAddresses | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notlike '169.254.*' } | Select-Object -First 1
  if ($ip) { return $ip }
  $mac = ($nic.MacAddress -replace '(..)(?=.)', '$1-')
  if ($mac -like '00-00-00-00-00-00') { return $null }
  $n = Get-NetNeighbor -LinkLayerAddress $mac -AddressFamily IPv4 -ErrorAction SilentlyContinue |
       Where-Object { $_.State -ne 'Unreachable' -and $_.IPAddress -notlike '169.254.*' } |
       Select-Object -First 1
  if ($n) { return $n.IPAddress }
  return $null
}

function Invoke-GuestSsh([string]$ip, [string]$cmd, [int]$timeoutSec = 10) {
  # BatchMode: never fall back to a password prompt - an elevated background
  # window waiting on stdin is a hang with no output.
  # UserKnownHostsFile=NUL: the guest generates its host key during the
  # install and the lab reuses IP addresses, so a remembered key is only ever
  # a false alarm.
  #
  # EAP drops to Continue around the call on purpose. PS 5.1 wraps every
  # stderr line of a native exe in a NativeCommandError when stderr is merged,
  # and under EAP=Stop the first "Connection refused" of a poll loop that is
  # SUPPOSED to see refusals would abort the script.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & ssh.exe -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=no `
      -o UserKnownHostsFile=NUL -o LogLevel=ERROR -o ConnectTimeout=$timeoutSec `
      "$Username@$ip" $cmd 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  return [pscustomobject]@{ Code = $code; Text = (($out | ForEach-Object { "$_" }) -join "`n").Trim() }
}

function Test-GuestUp {
  $ip = Get-GuestIPv4 $Name
  if (-not $ip) { return $null }
  $r = Invoke-GuestSsh $ip 'hostname'
  if ($r.Code -eq 0 -and $r.Text -eq $Hostname) { return $ip }
  return $null
}

function Save-VmConsolePng([string]$vmName, [string]$outPath, [int]$w = 800, [int]$h = 600) {
  # Msvm_VirtualSystemManagementService hands back raw RGB565 pixels. Named
  # method parameters, not positional: the MOF order is not the order
  # PowerShell would guess. Diagnostics only - never fatal.
  try {
    Add-Type -AssemblyName System.Drawing
    $svc = Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_VirtualSystemManagementService
    $sys = Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem -Filter "ElementName='$vmName'"
    $sd = $sys.GetRelated('Msvm_VirtualSystemSettingData') | Select-Object -First 1
    $p = $svc.GetMethodParameters('GetVirtualSystemThumbnailImage')
    $p.TargetSystem = $sd.Path.Path
    $p.WidthPixels = $w
    $p.HeightPixels = $h
    $r = $svc.InvokeMethod('GetVirtualSystemThumbnailImage', $p, $null)
    if ($r.ReturnValue -ne 0 -or -not $r.ImageData) { return $false }
    $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $bits = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bmp.PixelFormat)
    [System.Runtime.InteropServices.Marshal]::Copy([byte[]]$r.ImageData, 0, $bits.Scan0, $r.ImageData.Length)
    $bmp.UnlockBits($bits)
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return $true
  } catch { return $false }
}

function Wait-For([string]$phase, [int]$minutes, [scriptblock]$test, [string]$shot) {
  $deadline = (Get-Date).AddMinutes($minutes)
  $started = Get-Date
  $lastBeat = (Get-Date).AddMinutes(-5)
  while ((Get-Date) -lt $deadline) {
    $hit = & $test
    if ($hit) { return $hit }
    if (((Get-Date) - $lastBeat).TotalSeconds -ge 120) {
      $lastBeat = Get-Date
      $state = (Get-VM -Name $Name).State
      $ip = Get-GuestIPv4 $Name
      Save-VmConsolePng $Name $shot | Out-Null
      Write-Host ("[{0,3} min] {1}: state={2} ip={3}" -f
        [int]((Get-Date) - $started).TotalMinutes, $phase, $state, $(if ($ip) { $ip } else { 'unknown' }))
    }
    Start-Sleep -Seconds 15
  }
  return $null
}

try {
  if (-not (Test-Path $KeyPath)) { throw "ssh key not found: $KeyPath - run 02-seed-iso.ps1" }
  $vm = Get-VM -Name $Name -ErrorAction Stop
  $shot = Join-Path $vmDir 'console-latest.png'
  $t0 = Get-Date

  # A re-run against a VM that already finished has nothing to wait for.
  $alreadyUp = $false
  if ($vm.State -eq 'Running') {
    if (Test-GuestUp) {
      $alreadyUp = $true
      Write-Host "the installed system is already up - skipping the install wait." -ForegroundColor Yellow
    }
  }

  if (-not $alreadyUp) {
    if ($vm.State -eq 'Off') {
      Start-VM -VM $vm
      Write-Host "started '$Name' - the installer boots itself; no keypress needed." -ForegroundColor Green
    } else {
      Write-Host "VM is already $($vm.State) - waiting on it as-is." -ForegroundColor Yellow
    }

    $done = Wait-For 'installing' $TimeoutMinutes { if ((Get-VM -Name $Name).State -eq 'Off') { 'off' } } $shot
    if (-not $done) {
      Save-VmConsolePng $Name $shot | Out-Null
      throw ("the install did not finish within $TimeoutMinutes minutes. The guest console at that moment is " +
             "$shot - open it, or run: vmconnect.exe localhost $Name")
    }
    Write-Host ("install finished in {0:n0} minutes; the guest powered itself off." -f ((Get-Date) - $t0).TotalMinutes) -ForegroundColor Green

    # --- hand the machine over to its own disk -------------------------------
    foreach ($d in Get-VMDvdDrive -VMName $Name) {
      Set-VMDvdDrive -VMName $Name -ControllerNumber $d.ControllerNumber -ControllerLocation $d.ControllerLocation -Path $null
    }
    Write-Host "ejected both DVDs." -ForegroundColor Green

    $hdd = Get-VMHardDiskDrive -VMName $Name | Select-Object -First 1
    Set-VMFirmware -VMName $Name -FirstBootDevice $hdd
    Write-Host "boot device is now the disk." -ForegroundColor Green

    Start-VM -VMName $Name
  }

  $ip = Wait-For 'first boot from disk' $BootTimeoutMinutes { Test-GuestUp } $shot
  if (-not $ip) {
    Save-VmConsolePng $Name $shot | Out-Null
    throw "the installed system did not answer SSH within $BootTimeoutMinutes minutes (console: $shot)"
  }

  Save-VmConsolePng $Name $shot | Out-Null
  Write-Host "INSTALL OK" -ForegroundColor Green
  Write-Host "guest ip: $ip"
  Write-Host "ssh: ssh -i $KeyPath $Username@$ip"
  Write-Host "next: 05-verify-guest.ps1" -ForegroundColor Yellow
}
catch {
  Write-Host "INSTALL FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
