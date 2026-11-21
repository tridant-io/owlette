<#
.SYNOPSIS
  Proves the installer's swoop uninstall cleanup (task 7.7) on the e2e VM.

  Reverts the VM to its golden snapshot, installs the candidate, plants what an
  enabled swoop leaves behind (the firewall rule group, SoftwareSASGeneration=3
  with the agent's side-effect record, logs\swoop, ipc\swoop), uninstalls
  silently and checks that every one of them is gone or restored. Two rounds:
  a record that says the policy was absent (the value must be deleted) and one
  that says it was 1 (the value must read 1 afterwards).

.EXAMPLE
  powershell -File scripts/vm/18c-verify-swoop-uninstall.ps1 -CandidatePath agent\build\installer_output\Owlette-Installer-v3.3.7.exe
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CandidatePath,
  [string]$Name = "owlette-e2e",
  [string]$Snapshot = "golden-empty",
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred'),
  [int]$InstallTimeoutSec = 600
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $CandidatePath)) { throw "candidate not found: $CandidatePath" }
$cred = Import-Clixml -Path $CredFile
$rows = @()
function Add-Row($round, $check, $verdict, $detail) {
  $script:rows += [PSCustomObject]@{ Round = $round; Check = $check; Verdict = $verdict; Detail = $detail }
  Write-Host ("  [{0}] {1,-7} {2,-34} {3}" -f $verdict, $round, $check, $detail)
}

$snap = Get-VMSnapshot -VMName $Name -Name $Snapshot
Restore-VMSnapshot -VMSnapshot $snap -Confirm:$false
if ((Get-VM -Name $Name).State -ne 'Running') { Start-VM -Name $Name }
$deadline = (Get-Date).AddMinutes(6)
$s = $null
while (-not $s -and (Get-Date) -lt $deadline) {
  try { $s = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop } catch { Start-Sleep -Seconds 5 }
}
if (-not $s) { throw "could not open a PowerShell Direct session to $Name" }

$guestExe = 'C:\Owlette-Installer-candidate.exe'
Copy-Item -Path $CandidatePath -Destination $guestExe -ToSession $s -Force

$install = {
  param($exe, $timeoutSec)
  $p = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=C:\owlette-install.log' -PassThru
  if (-not $p.WaitForExit($timeoutSec * 1000)) { return 'install timed out' }
  "install exit $($p.ExitCode)"
}

$plant = {
  param($sasPrior)
  $root = 'C:\ProgramData\Owlette'
  $r = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  # idempotent: a rule left by an earlier round would make New-NetFirewallRule throw
  Get-NetFirewallRule -Group 'Owlette swoop' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  New-NetFirewallRule -Name 'Owlette-swoop-UDP-In' -DisplayName 'Owlette swoop' -Group 'Owlette swoop' -Direction Inbound -Protocol UDP -Action Allow -Program "$root\swoop\owlette-swoop.exe" | Out-Null
  New-NetFirewallRule -Name 'Owlette-swoop-mDNS-In' -DisplayName 'Owlette swoop (mDNS)' -Group 'Owlette swoop' -Direction Inbound -Protocol UDP -LocalPort 5353 -Action Allow | Out-Null
  if (-not (Test-Path $r)) { New-Item -Path $r -Force | Out-Null }
  Set-ItemProperty -Path $r -Name SoftwareSASGeneration -Value 3 -Type DWord
  New-Item -ItemType Directory -Force -Path "$root\tmp", "$root\logs\swoop", "$root\ipc\swoop" | Out-Null
  $record = if ($sasPrior -eq 'absent') { '{"firewall":"' + ($root -replace '\\', '\\\\') + '\\\\swoop\\\\owlette-swoop.exe","sasPrior":"absent"}' } else { '{"firewall":"x","sasPrior":' + $sasPrior + '}' }
  Set-Content -Path "$root\tmp\swoop_side_effects.json" -Value $record -Encoding ascii
  Set-Content -Path "$root\logs\swoop\session-1.log" -Value 'transcript' -Encoding ascii
  Set-Content -Path "$root\ipc\swoop\marker" -Value 'x' -Encoding ascii
  $rules = @(Get-NetFirewallRule -Group 'Owlette swoop' -ErrorAction SilentlyContinue).Count
  $sas = (Get-ItemProperty -Path $r -Name SoftwareSASGeneration).SoftwareSASGeneration
  "planted: rules=$rules sas=$sas swoopdir=$(Test-Path "$root\swoop")"
}

$uninstall = {
  param($timeoutSec)
  $u = 'C:\ProgramData\Owlette\unins000.exe'
  if (-not (Test-Path $u)) { return 'no uninstaller at ' + $u }
  Remove-Item 'C:\owlette-uninstall.log' -Force -ErrorAction SilentlyContinue
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
  $steps = if (Test-Path 'C:\owlette-uninstall.log') { @(Select-String -Path 'C:\owlette-uninstall.log' -Pattern 'powershell' | ForEach-Object { $_.Line.Trim() }) } else { @('no uninstall log') }
  "uninstall exit $($p.ExitCode); log: " + ($steps -join ' | ')
}

$inspect = {
  $root = 'C:\ProgramData\Owlette'
  $r = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
  $rules = @(Get-NetFirewallRule -Group 'Owlette swoop' -ErrorAction SilentlyContinue).Count
  $prop = Get-ItemProperty -Path $r -Name SoftwareSASGeneration -ErrorAction SilentlyContinue
  $sas = if ($null -eq $prop) { 'absent' } else { [string]$prop.SoftwareSASGeneration }
  [PSCustomObject]@{
    Rules = $rules; Sas = $sas
    SwoopDir = Test-Path "$root\swoop"; LogsSwoop = Test-Path "$root\logs\swoop"
    IpcSwoop = Test-Path "$root\ipc\swoop"; Record = Test-Path "$root\tmp\swoop_side_effects.json"
    LogsKept = Test-Path "$root\logs"
  }
}

foreach ($round in @(@{ Name = 'absent'; Prior = 'absent'; ExpectSas = 'absent' }, @{ Name = 'prior=1'; Prior = 1; ExpectSas = '1' })) {
  $label = $round.Name
  $detail = Invoke-Command -Session $s -ScriptBlock $install -ArgumentList $guestExe, $InstallTimeoutSec
  Add-Row $label 'candidate install' $(if ($detail -eq 'install exit 0') { 'PASS' } else { 'FAIL' }) $detail
  $detail = Invoke-Command -Session $s -ScriptBlock $plant -ArgumentList $round.Prior
  Add-Row $label 'plant side effects' $(if ($detail -like 'planted: rules=2 sas=3 swoopdir=True') { 'PASS' } else { 'FAIL' }) $detail
  $detail = Invoke-Command -Session $s -ScriptBlock $uninstall -ArgumentList $InstallTimeoutSec
  Add-Row $label 'silent uninstall' $(if ($detail -like 'uninstall exit 0*') { 'PASS' } else { 'FAIL' }) $detail
  $after = Invoke-Command -Session $s -ScriptBlock $inspect
  Add-Row $label 'firewall rules removed' $(if ($after.Rules -eq 0) { 'PASS' } else { 'FAIL' }) "rules left: $($after.Rules)"
  Add-Row $label "sas restored ($($round.ExpectSas))" $(if ($after.Sas -eq $round.ExpectSas) { 'PASS' } else { 'FAIL' }) "value now: $($after.Sas)"
  Add-Row $label 'swoop payload removed' $(if (-not $after.SwoopDir) { 'PASS' } else { 'FAIL' }) "swoop dir present: $($after.SwoopDir)"
  Add-Row $label 'logs\swoop removed' $(if (-not $after.LogsSwoop) { 'PASS' } else { 'FAIL' }) "present: $($after.LogsSwoop)"
  Add-Row $label 'ipc\swoop removed' $(if (-not $after.IpcSwoop) { 'PASS' } else { 'FAIL' }) "present: $($after.IpcSwoop)"
  Add-Row $label 'record removed' $(if (-not $after.Record) { 'PASS' } else { 'FAIL' }) "present: $($after.Record)"
  Add-Row $label 'other logs kept' $(if ($after.LogsKept) { 'PASS' } else { 'FAIL' }) "logs dir present: $($after.LogsKept)"
}
Remove-PSSession $s
$pass = @($rows | Where-Object Verdict -eq 'PASS').Count
$fail = @($rows | Where-Object Verdict -eq 'FAIL').Count
Write-Host "PASS=$pass  FAIL=$fail"
if ($fail -gt 0) { exit 1 }
