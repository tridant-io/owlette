# Finalise the guest before the golden checkpoint: clean shutdown, pin the
# display mode, boot, and verify what actually took effect. Run ELEVATED.
#
# Three things can only happen around a power cycle, which is why they are
# bundled here rather than in 05:
#   * Set-VMVideo refuses to run on a VM that is not Off.
#   * Rename-Computer only takes effect on reboot.
#   * A deleted account's profile directory stays locked while its registry
#     hive is mounted; the hive unloads on shutdown, so the sweep works now
#     when it did not before.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
param(
  [string]$Name = "owlette-e2e",
  [int]$Width = 1920,
  [int]$Height = 1080,
  [string]$ExpectHostname = "owlette-e2e-01",
  # Profile directory of an account already removed, to sweep once unlocked.
  [string]$StaleProfile = "C:\Users\admin",
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred')
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-vm-finalize-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  # $StaleProfile is a recursive delete target, so take only C:\Users\<plain name>;
  # windows drops a trailing dot or space when it resolves the path.
  if ($StaleProfile -notmatch '^C:\\Users\\[A-Za-z0-9](?:[A-Za-z0-9 ._-]*[A-Za-z0-9_-])?\z' -or
      (Split-Path $StaleProfile -Leaf) -in @('Public', 'Default', 'Default User', 'All Users')) {
    throw "-StaleProfile '$StaleProfile' is not C:\Users\<removed account>."
  }

  $vm = Get-VM -Name $Name -ErrorAction Stop

  # --- clean shutdown --------------------------------------------------------
  if ($vm.State -ne 'Off') {
    Write-Host "shutting the guest down cleanly..." -ForegroundColor Cyan
    Stop-VM -VM $vm -Force              # graceful; -TurnOff would be the hard kill
    $deadline = (Get-Date).AddMinutes(3)
    while ((Get-VM -Name $Name).State -ne 'Off' -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
    if ((Get-VM -Name $Name).State -ne 'Off') { throw "guest did not shut down within 3 minutes" }
    Write-Host "off." -ForegroundColor Green
  }

  # --- pin the display mode --------------------------------------------------
  # The synthetic display controller only offers modes the HOST allows, which is
  # why setting the resolution inside Windows kept reverting to 1024x768.
  Set-VMVideo -VMName $Name -ResolutionType Single `
    -HorizontalResolution $Width -VerticalResolution $Height
  Write-Host "Set-VMVideo -> ${Width}x${Height}." -ForegroundColor Green

  # --- boot ------------------------------------------------------------------
  Start-VM -Name $Name
  Write-Host "started; waiting for PowerShell Direct..." -ForegroundColor Cyan

  if (-not (Test-Path $CredFile)) { throw "no saved credential at $CredFile" }
  $cred = Import-Clixml -Path $CredFile

  $session = $null
  $deadline = (Get-Date).AddMinutes(6)
  while (-not $session -and (Get-Date) -lt $deadline) {
    try { $session = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop }
    catch { Start-Sleep -Seconds 5 }
  }
  if (-not $session) { throw "PowerShell Direct did not come up within 6 minutes" }
  Write-Host "connected." -ForegroundColor Green

  # --- verify + sweep --------------------------------------------------------
  $state = Invoke-Command -Session $session -ArgumentList $StaleProfile -ScriptBlock {
    param($stale)
    # never sweep the profile of an account that still exists (08 -RemoveOld deletes the account)
    if ((Test-Path $stale) -and -not (Get-LocalUser -Name (Split-Path $stale -Leaf) -ErrorAction SilentlyContinue)) {
      # Delete the Win32_UserProfile OBJECT, not the directory. Windows removes
      # the folder itself as part of that, including files an ordinary recursive
      # delete cannot touch (AppData\Local\Microsoft\Windows\SFAP\cache0.bin was
      # the hold-out here). takeown + icacls + Remove-Item is the wrong tool and
      # fails even as an administrator, because the ACLs name a SID that no
      # longer resolves once the account is gone.
      #
      # It only works once the profile's registry hive is unloaded, which is why
      # this lives after the reboot above and not in 08.
      $prof = Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -eq $stale }
      if ($prof) {
        Write-Host "removing the profile of $stale"
        try { $prof | Remove-CimInstance -ErrorAction Stop }
        catch { Write-Warning "could not remove the profile of ${stale}: $($_.Exception.Message)" }
      }
      # Only if something still survives that removal.
      if (Test-Path $stale) {
        Write-Host "deleting what is left of $stale"
        try { Remove-Item -LiteralPath $stale -Recurse -Force -ErrorAction Stop }
        catch { Write-Warning "could not delete all of ${stale}: $($_.Exception.Message)" }
      }
    }
    [PSCustomObject]@{
      Hostname     = $env:COMPUTERNAME
      Screen       = (Get-CimInstance Win32_VideoController | Select-Object -First 1 -Expand VideoModeDescription)
      StaleProfile = Test-Path $stale
      Users        = (Get-LocalUser | Where-Object { $_.Enabled } | Select-Object -Expand Name) -join ', '
      WebView2     = [bool](@(
                       'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
                       'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
                     ) | Where-Object { Test-Path $_ } | Select-Object -First 1)
      PawnIO       = [bool](Get-Service PawnIO -ErrorAction SilentlyContinue)
      OwletteSvc   = [bool](Get-Service OwletteService -ErrorAction SilentlyContinue)
    }
  }
  Remove-PSSession $session

  Write-Host ""
  $state | Format-List | Out-String | Write-Host

  $problems = @()
  if ($state.Hostname -ne $ExpectHostname) { $problems += "hostname is '$($state.Hostname)', expected '$ExpectHostname' (Owlette's machine_id IS the hostname)" }
  if ($state.Screen -notmatch "$Width x $Height")  { $problems += "display is '$($state.Screen)', expected ${Width} x ${Height}" }
  if ($state.StaleProfile)                          { $problems += "stale profile $StaleProfile still present" }
  if (-not $state.WebView2)                         { $problems += "WebView2 missing - installer would take the console pairing fallback" }
  if ($state.PawnIO)                                { $problems += "PawnIO present - b04 would have no driver caption to film" }
  if ($state.OwletteSvc)                            { $problems += "Owlette already installed - not an empty machine" }

  if ($problems.Count) {
    Write-Host "NOT READY FOR THE GOLDEN SNAPSHOT:" -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  } else {
    Write-Host "READY FOR THE GOLDEN SNAPSHOT" -ForegroundColor Green
    Write-Host "Next: shut the guest down cleanly, then 06-checkpoint-golden.ps1" -ForegroundColor Yellow
  }
}
catch {
  Write-Host "FINALIZE FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
