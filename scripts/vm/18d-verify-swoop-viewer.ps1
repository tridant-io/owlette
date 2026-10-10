<#
.SYNOPSIS
  Proves the agent installer ships owlette swoop, the viewer app (swoop-viewer
  task 4.1), on the e2e VM.

  Reverts the VM to its golden snapshot, installs the candidate silently and
  checks what the installer adds for the app: the exe beside the desktop app,
  the owlette-swoop:// registration (HKCR, written machine-wide) and the
  "owlette swoop" Start-menu shortcut. Then opens the link in the signed-in
  user's session with `start`, the way a browser hands one over, and checks
  that the installed app started and opened that page. Uninstalls silently
  with the app still running and checks that all three are gone and the app
  was closed.

  The link is opened by a scheduled task with a time trigger: a GUI process
  started from PowerShell Direct lands in a session with no desktop, and an
  interactive task cannot be started on demand from there (16-drive-installer
  has the measurement). Needs the golden image's autologon.

  -Snapshot golden-<v>-installed runs the same checks as an upgrade over that
  fielded version instead of a clean install.

  ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
  the file carries a UTF-8 BOM.

.EXAMPLE
  powershell -File scripts/vm/18d-verify-swoop-viewer.ps1 -CandidatePath agent\build\installer_output\Owlette-Installer-v4.1.8.exe
  powershell -File scripts/vm/18d-verify-swoop-viewer.ps1 -CandidatePath agent\build\installer_output\Owlette-Installer-v4.1.8.exe -Snapshot golden-3.1.0-installed
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CandidatePath,
  [string]$Name = "owlette-e2e",
  [string]$Snapshot = "golden-empty",
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred'),
  [string]$Link = 'owlette-swoop://dev.owlette.app/swoop',
  [int]$InstallTimeoutSec = 600
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $CandidatePath)) { throw "candidate not found: $CandidatePath" }

# Reverting and PowerShell Direct need Hyper-V rights: membership of Hyper-V
# Administrators (S-1-5-32-578) or an elevated administrator (as in 18).
$__id = [Security.Principal.WindowsIdentity]::GetCurrent()
$__pr = New-Object Security.Principal.WindowsPrincipal($__id)
$__hv = [bool]($__id.Groups | Where-Object { $_.Value -eq 'S-1-5-32-578' })
if (-not ($__hv -or $__pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) {
  throw "run this elevated, or as a member of Hyper-V Administrators"
}

$cred = Import-Clixml -Path $CredFile
$rows = @()
function Add-Row($check, $pass, $detail) {
  $verdict = if ($pass) { 'PASS' } else { 'FAIL' }
  $script:rows += [PSCustomObject]@{ Check = $check; Verdict = $verdict; Detail = $detail }
  Write-Host ("  [{0}] {1,-34} {2}" -f $verdict, $check, $detail)
}

$vm = Get-VM -Name $Name
if ($vm.State -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
Restore-VMSnapshot -VMSnapshot (Get-VMSnapshot -VMName $Name -Name $Snapshot) -Confirm:$false
Start-VM -Name $Name
Write-Host "reverted to '$Snapshot' and started." -ForegroundColor Green
$deadline = (Get-Date).AddMinutes(6)
$s = $null
while (-not $s -and (Get-Date) -lt $deadline) {
  try { $s = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop } catch { Start-Sleep -Seconds 5 }
}
if (-not $s) { throw "could not open a PowerShell Direct session to $Name" }

$guestExe = 'C:\Owlette-Installer-candidate.exe'
Copy-Item -Path $CandidatePath -Destination $guestExe -ToSession $s -Force

# What the installer adds for owlette swoop, read the way Windows resolves it.
$inspect = {
  $exe = 'C:\ProgramData\Owlette\app\owlette-swoop-viewer.exe'
  $hkcr = 'Registry::HKEY_CLASSES_ROOT\owlette-swoop'
  $lnk = Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Owlette\owlette swoop.lnk'
  $key = Get-Item -LiteralPath $hkcr -ErrorAction SilentlyContinue
  $cmd = Get-ItemProperty -LiteralPath "$hkcr\shell\open\command" -ErrorAction SilentlyContinue
  [PSCustomObject]@{
    Exe         = Test-Path $exe
    ExeVersion  = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.FileVersion } else { '' }
    Key         = [bool]$key
    UrlProtocol = [bool]($key -and ($key.GetValueNames() -contains 'URL Protocol'))
    Command     = if ($cmd) { $cmd.'(default)' } else { '' }
    MachineKey  = Test-Path -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Classes\owlette-swoop'
    Shortcut    = Test-Path $lnk
    Target      = if (Test-Path $lnk) { (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).TargetPath } else { '' }
    Running     = @(Get-Process -Name owlette-swoop-viewer -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }).Count
  }
}

try {
  $pre = Invoke-Command -Session $s -ScriptBlock $inspect
  Add-Row 'no owlette swoop before' (-not $pre.Exe -and -not $pre.Key -and -not $pre.Shortcut) "exe=$($pre.Exe) scheme=$($pre.Key) shortcut=$($pre.Shortcut)"

  $inst = Invoke-Command -Session $s -ArgumentList $guestExe, $InstallTimeoutSec -ScriptBlock {
    param($exe, $timeoutSec)
    $p = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=C:\owlette-install.log' -PassThru
    if (-not $p.WaitForExit($timeoutSec * 1000)) { return 'install timed out' }
    "install exit $($p.ExitCode)"
  }
  Add-Row 'candidate install' ($inst -eq 'install exit 0') $inst

  $want = '"C:\ProgramData\Owlette\app\owlette-swoop-viewer.exe" "%1"'
  $after = Invoke-Command -Session $s -ScriptBlock $inspect
  Add-Row 'viewer exe installed' $after.Exe "app\owlette-swoop-viewer.exe version $($after.ExeVersion)"
  Add-Row 'HKCR\owlette-swoop' ($after.Key -and $after.UrlProtocol) "key=$($after.Key) URL Protocol=$($after.UrlProtocol)"
  Add-Row 'scheme command' ($after.Command -eq $want) "$($after.Command)"
  Add-Row 'machine-wide (HKLM classes)' $after.MachineKey "HKLM\SOFTWARE\Classes\owlette-swoop=$($after.MachineKey)"
  Add-Row 'start-menu shortcut' ($after.Shortcut -and $after.Target -eq 'C:\ProgramData\Owlette\app\owlette-swoop-viewer.exe') "owlette swoop.lnk -> $($after.Target)"

  # `start <link>` in the signed-in user's session, as a browser would hand it over
  $armed = Invoke-Command -Session $s -ArgumentList $cred.UserName, $Link -ScriptBlock {
    param($user, $link)
    $leaf = ($user -split '\\')[-1]
    $deadline = (Get-Date).AddMinutes(3)
    $signedIn = $false
    while (-not $signedIn -and (Get-Date) -lt $deadline) {
      $signedIn = [bool](Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" |
        Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $leaf })
      if (-not $signedIn) { Start-Sleep -Seconds 3 }
    }
    if (-not $signedIn) { return 'no signed-in desktop for ' + $user + ' (autologon?)' }
    Unregister-ScheduledTask -TaskName OwletteSwoopLink -Confirm:$false -ErrorAction SilentlyContinue
    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c start "" "' + $link + '"')
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(10)
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName OwletteSwoopLink -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    'armed'
  }
  if ($armed -ne 'armed') { Add-Row 'link opens owlette swoop' $false $armed }
  else {
    $opened = Invoke-Command -Session $s -ArgumentList $Link -ScriptBlock {
      param($link)
      $exe = 'C:\ProgramData\Owlette\app\owlette-swoop-viewer.exe'
      $log = Join-Path $env:LOCALAPPDATA 'app.owlette.swoop-viewer\logs\owlette-swoop-viewer.log'
      $page = 'https://' + $link.Substring('owlette-swoop://'.Length)
      $deadline = (Get-Date).AddSeconds(90)
      $proc = $null; $line = $null
      while ((Get-Date) -lt $deadline -and -not ($proc -and $line)) {
        Start-Sleep -Seconds 3
        $proc = Get-CimInstance Win32_Process -Filter "Name='owlette-swoop-viewer.exe'" |
          Where-Object { $_.ExecutablePath -eq $exe -and $_.CommandLine -like "*$link*" } | Select-Object -First 1
        if (Test-Path $log) {
          $line = Get-Content $log -ErrorAction SilentlyContinue |
            Where-Object { $_ -match ('opening ' + [regex]::Escape($page) + '\s*$') } | Select-Object -Last 1
        }
      }
      $task = Get-ScheduledTaskInfo -TaskName OwletteSwoopLink -ErrorAction SilentlyContinue
      Unregister-ScheduledTask -TaskName OwletteSwoopLink -Confirm:$false -ErrorAction SilentlyContinue
      [PSCustomObject]@{
        Pid     = if ($proc) { $proc.ProcessId } else { 0 }
        Command = if ($proc) { $proc.CommandLine } else { '' }
        Line    = "$line"
        Task    = if ($task) { $task.LastTaskResult } else { 'no task' }
      }
    }
    Add-Row 'link starts the installed app' ($opened.Pid -gt 0) "pid $($opened.Pid): $($opened.Command) (task result $($opened.Task))"
    Add-Row 'app opened the linked page' ([bool]$opened.Line) "log: $($opened.Line)"
  }

  # uninstall with the app still running: the [UninstallRun] kill must free the exe
  $un = Invoke-Command -Session $s -ArgumentList $InstallTimeoutSec -ScriptBlock {
    param($timeoutSec)
    $u = 'C:\ProgramData\Owlette\unins000.exe'
    if (-not (Test-Path $u)) { return 'no uninstaller at ' + $u }
    $running = @(Get-Process -Name owlette-swoop-viewer -ErrorAction SilentlyContinue).Count
    $p = Start-Process -FilePath $u -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=C:\owlette-uninstall.log' -PassThru
    if (-not $p.WaitForExit($timeoutSec * 1000)) { return 'uninstall timed out' }
    # an inno uninstaller copies itself to %temp%\_iu*.tmp and exits at once;
    # the copy is the one that does the work, so wait for it, not for unins000.
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
      $worker = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '_iu*' -or $_.ProcessName -like 'unins*' }
      if (-not $worker) { break }
      Start-Sleep -Seconds 2
    }
    Start-Sleep -Seconds 3
    "uninstall exit $($p.ExitCode) (owlette swoop processes before: $running)"
  }
  Add-Row 'silent uninstall' ($un -like 'uninstall exit 0*') $un

  $gone = Invoke-Command -Session $s -ScriptBlock $inspect
  Add-Row 'app closed' ($gone.Running -eq 0) "processes running the installed exe: $($gone.Running)"
  Add-Row 'viewer exe removed' (-not $gone.Exe) "present: $($gone.Exe)"
  Add-Row 'HKCR\owlette-swoop removed' (-not $gone.Key -and -not $gone.MachineKey) "hkcr=$($gone.Key) hklm=$($gone.MachineKey)"
  Add-Row 'start-menu shortcut removed' (-not $gone.Shortcut) "present: $($gone.Shortcut)"
}
finally {
  Remove-PSSession $s
}
$pass = @($rows | Where-Object Verdict -eq 'PASS').Count
$fail = @($rows | Where-Object Verdict -eq 'FAIL').Count
Write-Host "PASS=$pass  FAIL=$fail"
if ($fail -gt 0) { exit 1 }
