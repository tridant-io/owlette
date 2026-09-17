# Prepare the freshly-installed guest over PowerShell Direct, then verify it is
# a valid base for the installer shoot. Run ELEVATED, after Windows setup.
#
# PowerShell Direct (Invoke-Command -VMName) runs over the VM bus: no guest
# networking, no IP, no WinRM configuration. It needs Hyper-V admin rights on
# the host and a local account in the guest.
#
# Credentials are collected with Get-Credential in THIS window and never
# printed, never written to the transcript, and never stored. Nothing here logs
# a password.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
# PSAvoidUsingPlainTextForPassword fires on any [string] parameter whose NAME
# contains "Cred". $CredFile is the PATH to a DPAPI-encrypted credential file,
# not a secret - the whole point of it is that no password is ever passed or
# stored as text. Suppressed deliberately rather than renamed around, so the
# reasoning survives.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
param(
  [string]$Name = "owlette-e2e",
  [string]$GuestUser = "e2e",
  # Repo root, so the guest gets the real bootstrap script rather than a copy
  # that can drift.
  [string]$RepoRoot = "C:\Users\admin\Documents\Git\Owlette",
  # Skip the long bootstrap run; just connect and report readiness.
  [switch]$VerifyOnly,
  # Force the guest's display mode from the host before checking. The in-guest
  # Display settings page does not always stick on the synthetic adapter, and
  # the capture harness asserts 1920x1080.
  [switch]$FixVideo,
  # Reconnect the vNIC. The OOBE BypassNro path deliberately disconnects it
  # (that flag only applies offline) and nothing puts it back.
  [switch]$ConnectNic,
  [string]$SwitchName = "Default Switch",
  # Rename the guest's COMPUTERNAME (requires a reboot to take effect). Windows
  # generates a random name like DESKTOP-EQGJN15 during OOBE, and Owlette seeds
  # its machine_id from the hostname the first time the agent runs, then keeps
  # it (agent/src/shared_utils.py -> get_machine_id(), persisted at
  # config/machine_id), so the name baked into the golden image becomes the
  # machine's identity on the dashboard forever. Set it deliberately.
  [string]$RenameGuest = "",
  # Path to a DPAPI-encrypted PSCredential written by Export-Clixml, readable
  # only by this Windows account on this machine. Lets the VM scripts run
  # unattended with no password on disk in the clear; prompts when absent.
  # Named CredFile, not CredentialPath: PSScriptAnalyzer's
  # PSAvoidUsingPlainTextForPassword matches on the parameter NAME, so
  # "*Credential*" on a [string] trips a warning that would wrongly suggest a
  # secret is being passed as text. This is a file path.
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred')
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-vm-prep-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  $vm = Get-VM -Name $Name -ErrorAction Stop
  if ($vm.State -ne 'Running') { throw "VM '$Name' is $($vm.State); start it first." }

  if ($ConnectNic) {
    $nic = Get-VMNetworkAdapter -VM $vm | Select-Object -First 1
    if ($nic.SwitchName -ne $SwitchName) {
      Connect-VMNetworkAdapter -VMName $Name -SwitchName $SwitchName
      Write-Host "vNIC reconnected to '$SwitchName'." -ForegroundColor Green
    } else {
      Write-Host "vNIC already on '$SwitchName'." -ForegroundColor Green
    }
  }

  if ($FixVideo) {
    # Set-VMVideo only works on a STOPPED VM. Warn and carry on rather than
    # aborting the readiness check - the natural moment to apply this is during
    # the clean shutdown that precedes the golden checkpoint anyway.
    if ($vm.State -eq 'Off') {
      Set-VMVideo -VMName $Name -ResolutionType Single `
        -HorizontalResolution 1920 -VerticalResolution 1080
      Write-Host "Set-VMVideo -> 1920x1080 (applies on next boot)." -ForegroundColor Green
    } else {
      Write-Host "-FixVideo skipped: Set-VMVideo requires the VM to be OFF." -ForegroundColor Yellow
      Write-Host "  Shut the guest down, then: Set-VMVideo -VMName $Name -ResolutionType Single -HorizontalResolution 1920 -VerticalResolution 1080" -ForegroundColor Yellow
    }
  }

  if (Test-Path $CredFile) {
    $cred = Import-Clixml -Path $CredFile
    Write-Host "using saved credential for '$($cred.UserName)' ($CredFile)." -ForegroundColor Green
  } else {
    Write-Host "Enter the GUEST password for '$GuestUser' (not logged)." -ForegroundColor Cyan
    $cred = Get-Credential -UserName $GuestUser -Message "owlette-e2e guest account"
  }

  # The guest finishes OOBE well before it accepts PowerShell Direct; poll.
  Write-Host "waiting for PowerShell Direct..." -ForegroundColor Cyan
  $session = $null
  $deadline = (Get-Date).AddMinutes(5)
  while (-not $session -and (Get-Date) -lt $deadline) {
    try { $session = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop }
    catch { Start-Sleep -Seconds 5 }
  }
  if (-not $session) { throw "PowerShell Direct never came up. Is the guest at the desktop, and is the password right?" }
  Write-Host "connected." -ForegroundColor Green

  # --- readiness: this VM exists to be a machine that LACKS these ------------
  # Episode 3's b04 films the installer's progress captions, and those only
  # render while it installs WebView2 and PawnIO. A guest that already has
  # either one cannot produce the shot, so check BEFORE the golden snapshot -
  # after it is baked, this is expensive to discover.
  $state = Invoke-Command -Session $session -ScriptBlock {
    $webview = @(
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
      'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    [PSCustomObject]@{
      Caption      = (Get-CimInstance Win32_OperatingSystem).Caption
      Build        = (Get-CimInstance Win32_OperatingSystem).BuildNumber
      User         = $env:USERNAME
      # Who is signed in at the CONSOLE - not the same as the PowerShell Direct
      # session's user, and it is what decides whether the old account can be
      # deleted and whether autologon is set up correctly.
      ConsoleUser  = (Get-CimInstance Win32_ComputerSystem).UserName
      Network      = [bool](Get-NetAdapter | Where-Object { $_.Status -eq 'Up' })
      Screen       = (Get-CimInstance Win32_VideoController |
                      Select-Object -First 1 -Expand VideoModeDescription)
      WebView2     = [bool]$webview
      PawnIO       = [bool](Get-Service PawnIO -ErrorAction SilentlyContinue)
      OwletteSvc   = [bool](Get-Service OwletteService -ErrorAction SilentlyContinue)
      PSVersion    = $PSVersionTable.PSVersion.ToString()
    }
  }

  Write-Host ""
  Write-Host "--- guest ---------------------------------------------" -ForegroundColor Cyan
  $state | Format-List | Out-String | Write-Host
  Write-Host "-------------------------------------------------------" -ForegroundColor Cyan

  $problems = @()
  $notes = @()
  # WebView2 must be PRESENT. The ep03 script is explicit (03-install-and-pair.md:18):
  # "the demo image must already have the WebView2 evergreen runtime ... without it
  # the installer falls back to the old console pairing path
  # (agent/owlette_installer.iss:841) and b05/b06 will not match". Current Windows 11
  # (26200) ships it inbox, which is also what a real customer machine looks like.
  # The cost is only b04's WebView2 caption, and the script already allows for that:
  # "hold on those captions if the demo VM shows them; skip the hold if it doesn't".
  if (-not $state.WebView2) {
    $problems += "WebView2 is MISSING - the installer would take the console pairing fallback and b05/b06 would not match the desktop take."
  } else {
    $notes += "WebView2 present (required for the GUI pairing path). b04 will not show its 'Installing the WebView2 runtime' caption - expected on current Windows."
  }
  # PawnIO must be ABSENT, or b04 has no progress caption to film at all.
  if ($state.PawnIO)     { $problems += "PawnIO is already installed - b04 would show no driver caption." }
  if ($state.OwletteSvc) { $problems += "Owlette is already installed - this is not an empty machine." }
  if ($state.Screen -notmatch '1920 x 1080') {
    $problems += "Display is '$($state.Screen)', not 1920 x 1080. Set it in the guest (Profile A pins resolution and the capture harness asserts it)."
  }

  $notes | ForEach-Object { Write-Host "  note: $_" -ForegroundColor DarkCyan }
  if ($problems.Count) {
    Write-Host "NOT READY:" -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  } else {
    Write-Host "READY: Win11 guest at 1920x1080, WebView2 present, no PawnIO, no Owlette." -ForegroundColor Green
  }

  # --- Profile A + C prep ----------------------------------------------------
  if (-not $VerifyOnly) {
    $src = Join-Path $RepoRoot 'scripts\bootstrap-gui-automation.ps1'
    if (-not (Test-Path $src)) { throw "bootstrap script not found: $src" }
    Invoke-Command -Session $session -ScriptBlock {
      New-Item -ItemType Directory -Force 'C:\owlette-setup' | Out-Null
    }
    Copy-Item -Path $src -Destination 'C:\owlette-setup\' -ToSession $session -Force
    Write-Host "copied bootstrap-gui-automation.ps1 into the guest." -ForegroundColor Green

    Write-Host "running Profile A+C prep in the guest (this takes a few minutes)..." -ForegroundColor Cyan
    # A fresh Windows install is ExecutionPolicy Restricted, so dot-sourcing the
    # script fails outright. Launch a child powershell with Bypass rather than
    # changing the machine's policy: whether this image ships with a relaxed
    # policy is a Profile C decision, not a side effect of running the bootstrap.
    $out = Invoke-Command -Session $session -ScriptBlock {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -File 'C:\owlette-setup\bootstrap-gui-automation.ps1' -Rig E2eRunner -Apply 2>&1 | Out-String
    }
    Write-Host $out
  }

  if ($RenameGuest) {
    $renamed = Invoke-Command -Session $session -ArgumentList $RenameGuest -ScriptBlock {
      param($newName)
      if ($env:COMPUTERNAME -eq $newName) { return "already '$newName'" }
      Rename-Computer -NewName $newName -Force -ErrorAction Stop
      return "renamed '$env:COMPUTERNAME' -> '$newName' (applies on reboot)"
    }
    Write-Host "  $renamed" -ForegroundColor Green
  }

  Remove-PSSession $session
  Write-Host "PREP OK" -ForegroundColor Green
  Write-Host "Next: shut the guest down cleanly, then run 06-checkpoint-golden.ps1" -ForegroundColor Yellow
}
catch {
  Write-Host "PREP FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
