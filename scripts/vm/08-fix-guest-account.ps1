# Create the 'e2e' local account in the guest (and later remove the wrong one).
# Run ELEVATED, guest running, over PowerShell Direct.
#
# Why create rather than rename: Rename-LocalUser changes the account name but
# NOT its profile directory, so a renamed account still lives in C:\Users\<old>.
# That mismatch would be baked into the golden image every future run reverts
# to, and it shows up in every path, log and screenshot thereafter.
#
# The new profile is materialised by running a throwaway process AS the new user
# (Start-Process -Credential), which is what actually creates C:\Users\e2e - the
# account alone does not. No interactive logon needed for that part.
#
# Two phases, because Windows will not delete the account you are signed in as:
#   1. (default)   create e2e, make it an admin, materialise its profile
#      --> then sign the guest into e2e
#   2. -RemoveOld  delete the old account and its profile
#
# Passwords are collected with Get-Credential in THIS window, travel only over
# the VM bus, and are never printed or stored.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

#Requires -RunAsAdministrator
# See 05-prep-guest.ps1 for why this is suppressed: $CredFile is a PATH to a
# DPAPI-encrypted credential file, and the analyzer matches on the name alone.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
param(
  [string]$Name = "owlette-e2e",
  [string]$NewUser = "e2e",
  [string]$OldUser = "admin",
  # Phase 2: delete $OldUser. Only works once the guest is signed in as $NewUser.
  [switch]$RemoveOld,
  # Saved credential for the CONNECTING account; prompts when absent.
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred')
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-vm-account-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

try {
  # -RemoveOld recursively deletes C:\Users\<OldUser>, so take only a plain
  # account name: an empty or path-like value would widen the target, and
  # windows drops a trailing dot or space when it resolves the path.
  if ($RemoveOld -and ($OldUser -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9 ._-]*[A-Za-z0-9_-])?\z' -or
      $OldUser -in @($NewUser, 'Public', 'Default', 'Default User', 'All Users'))) {
    throw "-OldUser '$OldUser' is not the plain name of a removable account."
  }

  $vm = Get-VM -Name $Name -ErrorAction Stop
  if ($vm.State -ne 'Running') { throw "VM '$Name' is $($vm.State); start it first." }

  # Prefill the BARE account name when prompting. Left blank, the prompt offers
  # the HOST's qualified user (TEC-A4D\admin), and PowerShell Direct rejects
  # that for a guest-local account with a bare "The credential is invalid".
  if (Test-Path $CredFile) {
    $connectCred = Import-Clixml -Path $CredFile
    Write-Host "using saved credential for '$($connectCred.UserName)'." -ForegroundColor Green
  } else {
    Write-Host "Connect AS a guest admin - use the BARE name, e.g. '$OldUser'." -ForegroundColor Cyan
    $connectCred = Get-Credential -UserName $OldUser -Message "existing guest admin account (bare name, no domain)"
  }
  $session = New-PSSession -VMName $Name -Credential $connectCred -ErrorAction Stop
  Write-Host "connected as $($connectCred.UserName)." -ForegroundColor Green

  if (-not $RemoveOld) {
    Write-Host "Set the password for the NEW '$NewUser' account." -ForegroundColor Cyan
    $newCred = Get-Credential -UserName $NewUser -Message "new guest account '$NewUser'"

    $result = Invoke-Command -Session $session -ArgumentList $NewUser -ScriptBlock {
      param($user)
      $cred = $using:newCred
      if (-not (Get-LocalUser -Name $user -ErrorAction SilentlyContinue)) {
        New-LocalUser -Name $user -Password $cred.Password -FullName $user `
          -Description 'owlette e2e/capture rig' -PasswordNeverExpires | Out-Null
      } else {
        Set-LocalUser -Name $user -Password $cred.Password
      }
      if (-not (Get-LocalGroupMember -Group 'Administrators' -Member $user -ErrorAction SilentlyContinue)) {
        Add-LocalGroupMember -Group 'Administrators' -Member $user
      }

      # Materialise the profile: the account exists, but C:\Users\<user> is not
      # created until something actually runs as that user.
      $profilePath = "C:\Users\$user"
      if (-not (Test-Path $profilePath)) {
        # -WorkingDirectory is load-bearing: Start-Process -Credential inherits the
        # CALLER's working directory, and if the new user cannot read it the call
        # fails with the misleading "The directory name is invalid." C:\ is
        # readable by every account.
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','exit' -Credential $cred `
          -WorkingDirectory 'C:\' -LoadUserProfile -WindowStyle Hidden -ErrorAction Stop
        $deadline = (Get-Date).AddSeconds(60)
        while (-not (Test-Path $profilePath) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
      }

      [PSCustomObject]@{
        Created     = [bool](Get-LocalUser -Name $user -ErrorAction SilentlyContinue)
        IsAdmin     = [bool](Get-LocalGroupMember -Group 'Administrators' -Member $user -ErrorAction SilentlyContinue)
        ProfileMade = Test-Path $profilePath
        Users       = (Get-LocalUser | Where-Object { $_.Enabled } | Select-Object -Expand Name) -join ', '
      }
    }

    $result | Format-List | Out-String | Write-Host
    if (-not $result.ProfileMade) {
      Write-Host "Account exists but its profile was not created. Sign into '$NewUser' once in the guest; that will create it." -ForegroundColor Yellow
    }
    Write-Host "ACCOUNT CREATED" -ForegroundColor Green
    Write-Host "Next: sign the guest out of '$OldUser' and IN as '$NewUser', then re-run with -RemoveOld." -ForegroundColor Yellow
  }
  else {
    $result = Invoke-Command -Session $session -ArgumentList $OldUser, $NewUser -ScriptBlock {
      param($old, $new)
      if ($env:USERNAME -eq $old) {
        throw "the guest is still signed in as '$old' - sign in as '$new' first; Windows will not delete the active account."
      }
      if (-not (Get-LocalUser -Name $new -ErrorAction SilentlyContinue)) {
        throw "'$new' does not exist - run phase 1 first."
      }
      # End any lingering session for the old account FIRST. "Switch user"
      # leaves the session alive and its registry hive loaded, and the profile
      # then cannot be deleted: "The process cannot access the file because it
      # is being used by another process."
      $sessions = @()
      try {
        $sessions = (quser 2>$null) | Select-Object -Skip 1 | ForEach-Object {
          $f = ($_ -replace '^>', '') -split '\s{2,}'
          if ($f.Count -ge 3) { [PSCustomObject]@{ User = $f[0].Trim(); Id = ($f | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1) } }
        }
      } catch { }
      foreach ($s in $sessions) {
        if ($s.User -eq $old -and $s.Id) {
          Write-Output "logging off stale session $($s.Id) for '$old'"
          & logoff $s.Id 2>$null
          Start-Sleep -Seconds 5
        }
      }

      $u = Get-LocalUser -Name $old -ErrorAction SilentlyContinue
      if ($u) {
        # Remove the profile (registry entry + directory) before the account, or
        # C:\Users\<old> is orphaned in the golden image forever.
        $p = Get-CimInstance Win32_UserProfile |
             Where-Object { $_.LocalPath -eq "C:\Users\$old" }
        if ($p) {
          try { $p | Remove-CimInstance }
          catch {
            throw ("could not remove the '$old' profile: $($_.Exception.Message). " +
                   "Its hive is still loaded - reboot the guest, sign in as '$new', and re-run.")
          }
        }
        Remove-LocalUser -Name $old
      }

      # Remove-CimInstance on Win32_UserProfile drops the registry entry but can
      # leave the directory behind when a file was locked at that moment. Sweep
      # it, narrowly: only this exact path, and only once the account is gone.
      $stale = "C:\Users\$old"
      if ((Test-Path $stale) -and -not (Get-LocalUser -Name $old -ErrorAction SilentlyContinue)) {
        # A profile directory's ACLs name the account's SID, which no longer
        # resolves once the account is deleted - so even an administrator gets
        # access-denied and Remove-Item -Force fails silently. Take ownership
        # and grant rights first, then delete.
        Write-Host "deleting stale profile directory $stale"
        & takeown.exe /F $stale /R /A /D Y  2>&1 | Out-Null
        & icacls.exe  $stale /grant 'Administrators:(OI)(CI)F' /T /C 2>&1 | Out-Null
        try { Remove-Item -LiteralPath $stale -Recurse -Force -ErrorAction Stop }
        catch { Write-Warning "could not delete all of ${stale}: $($_.Exception.Message) - 09-finalize-image.ps1 sweeps it after the reboot." }
      }
      [PSCustomObject]@{
        SignedInAs   = $env:USERNAME
        OldRemoved   = -not [bool](Get-LocalUser -Name $old -ErrorAction SilentlyContinue)
        OldProfile   = Test-Path "C:\Users\$old"
        Users        = (Get-LocalUser | Where-Object { $_.Enabled } | Select-Object -Expand Name) -join ', '
      }
    }
    $result | Format-List | Out-String | Write-Host
    Write-Host "OLD ACCOUNT REMOVED" -ForegroundColor Green
  }

  Remove-PSSession $session
}
catch {
  Write-Host "ACCOUNT FIX FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
