# Upgrade harness: prove the 3.3.6 candidate hardens the install tree when it is
# laid down OVER an already-fielded version, not only on a clean install. Run
# on the Hyper-V host used by the rest of scripts/vm, elevated or as a member of
# Hyper-V Administrators (PowerShell Direct and the VM operations need no more).
#
# For each -FromVersion it reverts to golden-empty, installs THAT fielded
# installer, checkpoints golden-<v>-installed, installs the candidate over it,
# then asserts:
#   * icacls shows no BUILTIN\Users (S-1-5-32-545) write bit (W, M, F, WD, AD) on
#     any code dir, service-owned dir, the uninstaller, or the app-root payload
#     docs the candidate now locks down;
#   * .tokens.enc and its pre-migration copy .tokens.enc.v1, if present, carry
#     no BUILTIN\Users ACE at all;
#   * OwletteService is Running;
#   * the console-user and cloud paths that the lockdown could have broken still
#     work (pairing helper, cortex IPC round trip, screenshot, config.json edit,
#     app_states.json read, self-update staging).
# It prints a PASS/FAIL table and exits non-zero on any FAIL.
#
# WHY AN UPGRADE HARNESS AND NOT JUST 18-verify-install.ps1: the CLAUDE.md fleet
# rule is that an upgrade runs the OLD installer's tree first, so a fix proven
# only on a clean install proves nothing about the boxes in the field. 2.12.21
# and 3.0.0 write the vulnerable "users-modify" root ACE that inherits into every
# code dir; the candidate's re-ACL step has to remove it on the upgrade path.
#
# API KEY (never printed by this script): resolving each fielded installer's
# download URL needs the installer list route, which is superadmin-gated. The old
# installers are served by PROD. Supply an installer-scoped PROD key by one of:
#     -ApiKey owk_...                         (direct)
#     -ApiKeyEnv OWLETTE_API_KEY_PROD         (name of an env var holding it)
#     -ApiKeyFile ..\..\.claude\.env.local -ApiKeyName OWLETTE_API_KEY_PROD
# OWNER ACTION: mint one at owlette.app -> Admin -> API Keys with the
# installer=*:read scope (superadmin only), keep it out of the repo, and pass it
# in. The key stays on the host; only the resulting signed download URL is sent
# into the guest.
#
# ROUTE NOTE (checked against web/app/api/installer/ and confirmed with
# unauthenticated probes): GET /api/installer/[version] is NOT a read route - that
# path has only a DELETE handler and answers 405 to GET. The read route is the
# list, GET /api/installer (401 unauthenticated = deployed and gated), which
# returns { versions: [ { version, download_url, checksum_sha256, ... } ] }. This
# harness reads that list and picks the matching version's signed download_url,
# rather than the /api/installer/[version] path named in the task text.
#
# STATIC ONLY on the dev box: do not run this here. It reverts snapshots and
# drives a guest, which belongs on the owner's VM host. It has been parse-checked
# with [System.Management.Automation.Language.Parser]::ParseFile (0 errors).
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'CredFile',
  Justification = 'Path to a DPAPI-encrypted PSCredential file, not a credential.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'ApiKey',
  Justification = 'Read-only installer-list key; never printed, never written into the guest.')]
param(
  [string]$Name = "owlette-e2e",
  [string]$Snapshot = "golden-empty",
  [string]$CredFile = (Join-Path $env:LOCALAPPDATA 'owlette-vm\guest-e2e.cred'),

  # The fielded versions to upgrade FROM. Run one at a time on the VM host.
  [string[]]$FromVersion = @('2.12.21', '3.0.0', '3.1.0', '3.2.3', '3.3.5'),

  # The 3.3.6 candidate to install over each fielded version. Give a URL (fetched
  # in-guest, like the template) or a local path (pushed over the VM bus). At
  # least one is required.
  [string]$CandidateUrl = "",
  [string]$CandidatePath = "",
  [string]$CandidateExeName = "Owlette-Installer-candidate.exe",
  [string]$CandidateSha256 = "",

  # API key resolution for the installer list route. Never printed.
  [string]$ApiKey = "",
  [string]$ApiKeyEnv = "OWLETTE_API_KEY_PROD",
  [string]$ApiKeyFile = "",
  [string]$ApiKeyName = "OWLETTE_API_KEY_PROD",
  [string]$ApiBase = "https://owlette.app",

  # Owner input (amendment 3): authorize the generated pairing phrase in the
  # dashboard so the pairing + token-write path is proven end to end. Without it,
  # that half is reported SKIPPED, not PASS.
  [switch]$AuthorizePairing,
  [int]$AuthorizeTimeoutSec = 600,

  # Negative control (amendment 4): after the candidate installs, deliberately
  # re-grant BUILTIN\Users Modify on one code dir IN THE GUEST so the ACL
  # assertion is proven able to FAIL. Guest-only; the VM is reverted afterwards.
  [switch]$NegativeControl,

  # 2.12.21 and 3.0.0 block on a silent pairing poll (their installers predate the
  # silent-skip added in 3.1.0), so the FROM install can take several minutes.
  [int]$FromInstallTimeoutSec = 900,
  [int]$InstallTimeoutSec = 600,
  [int]$ServiceTimeoutSec = 180
)

$ErrorActionPreference = 'Stop'

# Reverting, checkpointing and PowerShell Direct need Hyper-V rights, which a
# member of Hyper-V Administrators (S-1-5-32-578) holds without elevation; an
# elevated administrator has them too. Either is enough.
$__id = [Security.Principal.WindowsIdentity]::GetCurrent()
$__pr = New-Object Security.Principal.WindowsPrincipal($__id)
$__hv = [bool]($__id.Groups | Where-Object { $_.Value -eq 'S-1-5-32-578' })
if (-not ($__hv -or $__pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))) {
  throw "run this elevated, or as a member of Hyper-V Administrators"
}

try { Stop-Transcript | Out-Null } catch { }
$log = Join-Path $env:TEMP ("owlette-vm-upgrade-{0}-{1}.log" -f $PID, (Get-Date -Format 'HHmmss'))
try { Start-Transcript -Path $log -Force | Out-Null; Write-Host "transcript: $log" -ForegroundColor Cyan }
catch { Write-Host "(transcript unavailable)" -ForegroundColor DarkGray }

# ----------------------------------------------------------------------------
# Results table. Every check appends one row; a single FAIL makes the run exit 1.
# ----------------------------------------------------------------------------
$rows = New-Object System.Collections.ArrayList
function Add-Row([string]$version, [string]$check, [string]$status, [string]$detail = "") {
  [void]$rows.Add([PSCustomObject]@{ Version = $version; Check = $check; Status = $status; Detail = $detail })
  $color = switch ($status) { 'PASS' { 'Green' } 'FAIL' { 'Red' } 'SKIP' { 'Yellow' } default { 'DarkGray' } }
  Write-Host ("  [{0,-4}] {1,-9} {2}{3}" -f $status, $version, $check, $(if ($detail) { " - $detail" } else { "" })) -ForegroundColor $color
}

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

# ----------------------------------------------------------------------------
# API key: resolved on the host, never printed, never sent into the guest.
# ----------------------------------------------------------------------------
$PLACEHOLDERS = @('owk_replace_with_your_admin_key', 'owk_your_key_here', 'owk_test_xxx', 'owk_live_xxx')

function Resolve-ApiKey {
  $key = ""
  $src = ""
  if ($ApiKey) { $key = $ApiKey; $src = "-ApiKey" }
  elseif ($ApiKeyFile) {
    if (-not (Test-Path $ApiKeyFile)) { throw "api key file not found: $ApiKeyFile" }
    $line = Get-Content -LiteralPath $ApiKeyFile |
      Where-Object { $_ -match ("^\s*" + [regex]::Escape($ApiKeyName) + "\s*=") } |
      Select-Object -First 1
    if (-not $line) { throw "no $ApiKeyName in $ApiKeyFile" }
    $key = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
    $src = "$ApiKeyFile ($ApiKeyName)"
  }
  else {
    $envVal = [Environment]::GetEnvironmentVariable($ApiKeyEnv)
    if ($envVal) { $key = $envVal.Trim(); $src = "env:$ApiKeyEnv" }
  }

  if (-not $key) {
    throw ("no installer-list api key. Pass -ApiKey, or -ApiKeyEnv <var>, or " +
           "-ApiKeyFile <path> -ApiKeyName <var>. OWNER ACTION: mint an " +
           "installer=*:read PROD key at $ApiBase -> Admin -> API Keys.")
  }
  if ($PLACEHOLDERS -contains $key -or -not $key.StartsWith('owk_')) {
    throw ("the api key from $src is a placeholder or not an owk_ key. Mint a real " +
           "installer=*:read PROD key and pass it in; it is never printed or stored.")
  }
  Write-Host "api key: resolved from $src (value not shown)." -ForegroundColor DarkGray
  return $key
}

# Fetch every non-forgotten installer version once, so each FROM lookup is a
# local find rather than a per-version request. Follows nextPageToken.
function Get-InstallerCatalog($key) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $all = @()
  $token = ""
  for ($page = 1; $page -le 20; $page++) {
    $uri = "$ApiBase/api/installer?page_size=100&includeDeleted=true"
    if ($token) { $uri += "&page_token=$([Uri]::EscapeDataString($token))" }
    try {
      $resp = Invoke-RestMethod -Uri $uri -Method GET -Headers @{ 'x-api-key' = $key } -TimeoutSec 60
    }
    catch {
      $code = $null
      if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      $hint = switch ($code) {
        401 { "401 - the key is invalid or not accepted" }
        403 { "403 - the key lacks installer=*:read (installer-scoped WRITE keys do not imply read)" }
        default { "$($_.Exception.Message)" }
      }
      throw "installer list request failed: $hint"
    }
    if ($resp.versions) { $all += $resp.versions }
    $token = if ($resp.nextPageToken) { "$($resp.nextPageToken)" } else { "" }
    if (-not $token) { break }
  }
  return $all
}

function Find-Installer($catalog, [string]$version) {
  $hit = $catalog | Where-Object { "$($_.version)" -eq $version } | Select-Object -First 1
  if (-not $hit) { throw "version $version is not in the installer catalog" }
  if (-not $hit.download_url) { throw "version $version has no download_url" }
  return [PSCustomObject]@{
    Url    = "$($hit.download_url)"
    Sha256 = if ($hit.checksum_sha256) { "$($hit.checksum_sha256)".ToLower() } else { "" }
  }
}

# ----------------------------------------------------------------------------
# Guest-side scriptblocks. Each returns a plain object the host turns into rows.
# The install root is the default single-tree layout; a /DIR= split is not
# exercised by this matrix (every install goes to the default location).
# ----------------------------------------------------------------------------

$SB_CleanCheck = {
  [PSCustomObject]@{
    Svc  = [bool](Get-Service OwletteService -ErrorAction SilentlyContinue)
    Data = Test-Path 'C:\ProgramData\Owlette'
  }
}

# Download an installer in-guest and verify its sha256. Returns the path.
$SB_DownloadOnly = {
  param($url, $exe, $sha)
  $dest = Join-Path ([Environment]::GetFolderPath('Desktop')) $exe
  if (Test-Path $dest) { Remove-Item $dest -Force }
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 600
  $got = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
  if ($sha -and $got -ne $sha.ToLower()) {
    return [PSCustomObject]@{ Ok = $false; Detail = "checksum mismatch: got $got"; Dest = $dest }
  }
  [PSCustomObject]@{ Ok = $true; Detail = "downloaded, checksum verified"; Dest = $dest }
}

# Start an installer DETACHED inside the guest. An installer's own stop/kill
# pass can take the PowerShell Direct session with it, and a session that dies
# mid-Invoke-Command is a runspace-fatal error no catch block sees (the 2.12.21
# row killed the whole matrix that way). So nothing waits inside the session:
# cmd runs the installer and writes its exit code to a file, and the host polls
# for that file with fresh short sessions (Wait-GuestInstall).
$SB_StartInstaller = {
  param($path)
  if (-not (Test-Path $path)) { return [PSCustomObject]@{ Ok = $false; Detail = "not found: $path" } }
  Remove-Item 'C:\owlette-install.exit' -Force -ErrorAction SilentlyContinue
  $inner = "`"$path`" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG=C:\owlette-install.log & echo !ERRORLEVEL! > C:\owlette-install.exit"
  Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList "/v:on /c `"$inner`"" -WindowStyle Hidden | Out-Null
  [PSCustomObject]@{ Ok = $true; Detail = 'started' }
}

# Host side: wait for the detached installer's exit-code file, reconnecting
# for every look so a session the installer severed costs one retry, not the row.
# -StopPairingPoll: a fielded installer on a machine with no config runs the
# interactive pairing flow (configure_site.py, QR + poll) and, with nobody to
# authorise, sits in it far past the server's 600 s code lifetime (2.12.21 and
# 3.0.1 both outlasted 30 minutes here). A real fielded box was paired long ago
# and never enters that step, so the harness stops that one process by pid once
# it has clearly been polling; the installer then finishes on its own.
function Wait-GuestInstall($vmName, $cred, [int]$timeout, [switch]$StopPairingPoll) {
  $deadline = (Get-Date).AddSeconds($timeout)
  $stopped = ""
  $boxedOnce = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 10
    $s2 = $null
    try {
      $s2 = New-PSSession -VMName $vmName -Credential $cred -ErrorAction Stop
      $r = Invoke-Command -Session $s2 -ArgumentList $StopPairingPoll.IsPresent -ScriptBlock {
        param($stopPoll)
        $note = ""
        $boxed = $false
        if ($stopPoll) {
          Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'configure_site\.py' } | ForEach-Object {
            if (((Get-Date) - $_.CreationDate).TotalSeconds -gt 90) {
              Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
              $note = "pairing poll (pid $($_.ProcessId)) stopped after $([int]((Get-Date) - $_.CreationDate).TotalSeconds)s; "
            }
          }
          # With the poll gone, 2.12.21/3.0.x call plain MsgBox("pairing was not
          # completed"), which Inno does not suppress under /SUPPRESSMSGBOXES
          # (only SuppressibleMsgBox is). In this non-interactive session the box
          # is invisible and blocks forever. The file tree is complete by then
          # (the box sits in ssPostInstall, after the uninstall log; the service
          # install it skips is a NOTE for these versions anyway), so end the
          # setup process by pid and let cmd write the exit code.
          $log = 'C:\owlette-install.log'
          if ((Test-Path $log) -and ((Get-Content $log -Tail 6) -match 'Pairing failed - skipping service install')) {
            Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'Owlette-from-*.tmp' } | ForEach-Object {
              Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
              $boxed = $true
            }
          }
        }
        $code = if (Test-Path 'C:\owlette-install.exit') { (Get-Content 'C:\owlette-install.exit' -Raw).Trim() } else { $null }
        [PSCustomObject]@{ Code = $code; Note = $note; Boxed = $boxed; Tree = (Test-Path 'C:\ProgramData\Owlette\agent\src') }
      }
      if ($r.Note) { $stopped = $r.Note }
      if ($r.Boxed) { $boxedOnce = $true }
      if ($null -ne $r.Code -and "$($r.Code)" -ne '') {
        if ($boxedOnce -and $r.Tree) {
          return [PSCustomObject]@{ Ok = $true; Detail = "${stopped}setup ended at its unsuppressed pairing box after the files were installed (service not registered, as for any unpaired silent install of this version)"; ExitCode = 0 }
        }
        return [PSCustomObject]@{ Ok = ("$($r.Code)" -eq '0'); Detail = "${stopped}exit $($r.Code)"; ExitCode = [int]$r.Code }
      }
    }
    catch { }
    finally { if ($s2) { Remove-PSSession $s2 -ErrorAction SilentlyContinue } }
  }
  [PSCustomObject]@{ Ok = $false; Detail = "${stopped}installer did not finish within ${timeout}s"; ExitCode = -1 }
}

$SB_WaitService = {
  param($timeout)
  $deadline = (Get-Date).AddSeconds($timeout)
  $status = 'absent'
  while ((Get-Date) -lt $deadline) {
    $x = Get-Service OwletteService -ErrorAction SilentlyContinue
    if ($x) { $status = "$($x.Status)"; if ($x.Status -eq 'Running') { break } }
    Start-Sleep -Seconds 3
  }
  [PSCustomObject]@{ Status = $status }
}

# ACL assertion. Parses icacls for a BUILTIN\Users / S-1-5-32-545 ACE that
# carries any write-class bit, over the code dirs, service-owned dirs, the
# uninstaller files and the app-root payload docs the candidate locks down.
# .tokens.enc, if present, must carry no Users ACE at all.
$SB_AclCheck = {
  $root = 'C:\ProgramData\Owlette'
  $dirs  = @('agent', 'python', 'tools', 'app', 'scripts', 'content', 'update-staging')
  $files = @('unins000.exe', 'unins000.dat',
             'README.md', 'LICENSE', 'CLAUDE.md', 'THIRD_PARTY_NOTICES.md', 'LGPL-2.1.txt')
  # The write-class bits called out in spike 0.1: full, modify, write, write-data
  # / add-file, append-data / add-subdir. RX / R and the inheritance markers
  # (I)(OI)(CI) are never in this set, so a read-only Users ACE passes.
  $forbidden = @('F', 'M', 'W', 'WD', 'AD')

  function Get-UsersAces([string]$path) {
    # Returns the permission-token lists of every BUILTIN\Users ACE on $path.
    $raw = & icacls $path 2>&1 | Out-String
    $aces = @()
    foreach ($line in ($raw -split "`r?`n")) {
      # Match the BUILTIN\Users group only, by name or SID. Deliberately NOT a
      # bare "Users", which would also catch "NT AUTHORITY\Authenticated Users"
      # (S-1-5-11) and misreport it as this group.
      if ($line -match '(?i)(?:BUILTIN\\Users|\*?S-1-5-32-545)\s*:\s*(.+)$') {
        $perm = $Matches[1]
        $tokens = $perm -split '[(),\s]+' | Where-Object { $_ -ne '' }
        $aces += , @($tokens)
      }
    }
    return $aces
  }

  $offenders = @()
  $missing = @()

  foreach ($d in $dirs) {
    $p = Join-Path $root $d
    if (-not (Test-Path $p)) { $missing += $d; continue }
    foreach ($ace in (Get-UsersAces $p)) {
      if ($ace | Where-Object { $forbidden -contains $_.ToUpper() }) {
        $offenders += ("{0} [{1}]" -f $d, ($ace -join ',')); break
      }
    }
  }
  foreach ($f in $files) {
    $p = Join-Path $root $f
    if (-not (Test-Path $p)) { $missing += $f; continue }
    foreach ($ace in (Get-UsersAces $p)) {
      if ($ace | Where-Object { $forbidden -contains $_.ToUpper() }) {
        $offenders += ("{0} [{1}]" -f $f, ($ace -join ',')); break
      }
    }
  }

  # .tokens.enc: no Users ACE at all (F6 leaves SYSTEM, Administrators and the
  # console SID only). Only present once the machine has paired.
  $tok = Join-Path $root '.tokens.enc'
  $tokStatus = 'absent'
  if (Test-Path $tok) {
    $tokStatus = if ((Get-UsersAces $tok).Count -gt 0) { 'users-present' } else { 'clean' }
  }
  # .tokens.enc.v1: the copy the key-derivation migration keeps beside the
  # store is a credential store too, and carries the same restricted DACL.
  # Present only on a machine that paired before the migration and upgraded
  # across it.
  $tokV1 = Join-Path $root '.tokens.enc.v1'
  $tokV1Status = 'absent'
  if (Test-Path $tokV1) {
    $tokV1Status = if ((Get-UsersAces $tokV1).Count -gt 0) { 'users-present' } else { 'clean' }
  }

  [PSCustomObject]@{
    Offenders = $offenders
    Missing   = $missing
    Token     = $tokStatus
    TokenV1   = $tokV1Status
  }
}

# Negative control: re-grant BUILTIN\Users Modify on one code dir so the ACL
# assertion above is proven able to FAIL. GUEST-ONLY (this runs inside the
# throwaway VM, which is reverted after the run); it adds an ACE, never deletes.
$SB_WeakenAcl = {
  $p = 'C:\ProgramData\Owlette\agent'
  & icacls $p /grant '*S-1-5-32-545:(OI)(CI)(M)' /T /C /Q 2>&1 | Out-Null
  [PSCustomObject]@{ Done = (Test-Path $p) }
}

# Smoke S1: the desktop-app pairing path. Runs the bundled interpreter exactly as
# agent_cli.rs does (python.exe configure_site.py --json-progress --no-browser,
# cwd agent/src) and confirms it reaches the 'phrase' event - i.e. the locked-down
# python + agent source are still executable by the console user and the
# device-code request reaches the cloud. The process is killed by PID once the
# phrase is seen; the device code simply expires server-side.
$SB_PairPhrase = {
  param($phraseTimeout)
  $py  = 'C:\ProgramData\Owlette\python\python.exe'
  $cfg = 'C:\ProgramData\Owlette\agent\src\configure_site.py'
  $cwd = 'C:\ProgramData\Owlette\agent\src'
  $out = 'C:\owlette-setup\pair-probe.jsonl'
  if (-not (Test-Path $py) -or -not (Test-Path $cfg)) {
    return [PSCustomObject]@{ Ok = $false; Phrase = ''; Url = ''; Detail = 'python or configure_site.py missing' }
  }
  New-Item -ItemType Directory -Force 'C:\owlette-setup' | Out-Null
  Remove-Item $out -Force -ErrorAction SilentlyContinue
  $p = Start-Process -FilePath $py `
    -ArgumentList @($cfg, '--json-progress', '--no-browser') `
    -WorkingDirectory $cwd -RedirectStandardOutput $out -WindowStyle Hidden -PassThru
  $phrase = ''; $url = ''; $err = ''
  $deadline = (Get-Date).AddSeconds($phraseTimeout)
  while (-not $phrase -and -not $err -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if (Test-Path $out) {
      foreach ($line in (Get-Content $out -ErrorAction SilentlyContinue)) {
        if (-not $line) { continue }
        try { $ev = $line | ConvertFrom-Json } catch { continue }
        if ($ev.event -eq 'phrase') {
          $phrase = "$($ev.value.pairPhrase)"
          $url = "$($ev.value.pairingUrl)"; if (-not $url) { $url = "$($ev.value.verificationUri)" }
        }
        elseif ($ev.event -eq 'error') { $err = "$($ev.value)" }
      }
    }
  }
  # Leave the helper running only if we are handing the phrase to the owner to
  # authorize; the host stops it by PID afterwards.
  [PSCustomObject]@{
    Ok     = [bool]$phrase
    Phrase = $phrase
    Url    = $url
    Pid    = $p.Id
    Detail = if ($phrase) { "phrase emitted" } elseif ($err) { "error: $err" } else { "no phrase within ${phraseTimeout}s" }
  }
}

$SB_ReadPairEvents = {
  param($out)
  if (Test-Path $out) { Get-Content $out -ErrorAction SilentlyContinue } else { @() }
}

$SB_StopPid = {
  param($procId)
  try { Stop-Process -Id ([int]$procId) -Force -ErrorAction Stop; 'stopped' } catch { 'gone' }
}

$SB_PairedState = {
  $siteId = ''
  try { $siteId = (Get-Content 'C:\ProgramData\Owlette\config\config.json' -Raw | ConvertFrom-Json).firebase.site_id } catch { }
  [PSCustomObject]@{
    SiteId = "$siteId"
    Token  = (Test-Path 'C:\ProgramData\Owlette\.tokens.enc')
    Svc    = "$((Get-Service OwletteService -ErrorAction SilentlyContinue).Status)"
  }
}

# Smoke S2: cortex IPC round trip. Writes a restart_process command into
# ipc/cortex_commands as the console user (proving the console-user DACL the
# service applies to that trio) and waits for the service (SYSTEM) to drain it and
# write a result. An unknown process name still yields a result file, which is all
# the round trip needs to prove.
$SB_CortexRoundTrip = {
  param($waitSec)
  $cmdDir = 'C:\ProgramData\Owlette\ipc\cortex_commands'
  $resDir = 'C:\ProgramData\Owlette\ipc\cortex_results'
  if (-not (Test-Path $cmdDir)) {
    return [PSCustomObject]@{ Ok = $false; Detail = 'ipc\cortex_commands does not exist (service should create it fail-closed)' }
  }
  $id = "harness_$([int](Get-Date -UFormat %s))_$([guid]::NewGuid().ToString('N').Substring(0,6))"
  $cmd = @{ id = $id; tool_name = 'restart_process'; tool_params = @{ process_name = 'harness-nonexistent' }; timestamp = [double](Get-Date -UFormat %s) }
  $cmdPath = Join-Path $cmdDir "$id.json"
  $tmpPath = "$cmdPath.tmp"
  try {
    ($cmd | ConvertTo-Json -Compress) | Set-Content -LiteralPath $tmpPath -Encoding ASCII
    Move-Item -LiteralPath $tmpPath -Destination $cmdPath -Force
  }
  catch {
    return [PSCustomObject]@{ Ok = $false; Detail = "console user could not write a cortex command: $($_.Exception.Message)" }
  }
  $resPath = Join-Path $resDir "$id.json"
  $deadline = (Get-Date).AddSeconds($waitSec)
  $seen = $false
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $resPath) { $seen = $true; break }
    Start-Sleep -Seconds 2
  }
  $consumed = -not (Test-Path $cmdPath)
  if (Test-Path $resPath) { Remove-Item $resPath -Force -ErrorAction SilentlyContinue }
  if (-not (Test-Path $resPath) -and -not $seen -and (Test-Path $cmdPath)) {
    Remove-Item $cmdPath -Force -ErrorAction SilentlyContinue
  }
  [PSCustomObject]@{
    Ok     = ($seen -and $consumed)
    Detail = if ($seen -and $consumed) { "result written, command consumed" }
             elseif ($seen) { "result written but command not consumed" }
             else { "no result within ${waitSec}s (service running? cortex dir writable?)" }
  }
}

# Smoke S3: on-demand screenshot, via the cortex capture_screenshot round trip.
# The capture runs the bundled python in the console session (the lockdown risk)
# and the upload needs a paired, online machine - so this only asserts a full
# result when the machine is paired; unpaired it is SKIPPED (owner input:
# -AuthorizePairing).
$SB_Screenshot = {
  param($waitSec)
  $cmdDir = 'C:\ProgramData\Owlette\ipc\cortex_commands'
  $resDir = 'C:\ProgramData\Owlette\ipc\cortex_results'
  if (-not (Test-Path $cmdDir)) {
    return [PSCustomObject]@{ Ok = $false; Detail = 'ipc\cortex_commands does not exist' }
  }
  $id = "harness_shot_$([int](Get-Date -UFormat %s))_$([guid]::NewGuid().ToString('N').Substring(0,6))"
  $cmd = @{ id = $id; tool_name = 'capture_screenshot'; tool_params = @{ monitor = 0 }; timestamp = [double](Get-Date -UFormat %s) }
  $cmdPath = Join-Path $cmdDir "$id.json"; $tmpPath = "$cmdPath.tmp"
  ($cmd | ConvertTo-Json -Compress) | Set-Content -LiteralPath $tmpPath -Encoding ASCII
  Move-Item -LiteralPath $tmpPath -Destination $cmdPath -Force
  $resPath = Join-Path $resDir "$id.json"
  $deadline = (Get-Date).AddSeconds($waitSec)
  $result = $null
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $resPath) {
      try { $result = (Get-Content $resPath -Raw | ConvertFrom-Json).result } catch { }
      break
    }
    Start-Sleep -Seconds 2
  }
  if (Test-Path $resPath) { Remove-Item $resPath -Force -ErrorAction SilentlyContinue }
  if (-not $result) { return [PSCustomObject]@{ Ok = $false; Detail = "no screenshot result within ${waitSec}s" } }
  $ok = ($result.size_kb -and [double]$result.size_kb -gt 0) -or $result.url -or $result.base64
  [PSCustomObject]@{ Ok = [bool]$ok; Detail = if ($ok) { "captured $($result.size_kb) KB" } else { "error: $($result.error)" } }
}

# Smoke S4: a GUI-style config.json edit as the console user - the desktop app's
# temp-file-and-rename write into config\ (unchanged in 3.3.6). Adds a benign
# top-level key, confirms it lands and that any firebase section survives, then
# restores the original bytes.
$SB_ConfigEdit = {
  $cfg = 'C:\ProgramData\Owlette\config\config.json'
  if (-not (Test-Path $cfg)) { return [PSCustomObject]@{ Ok = $false; Detail = 'config.json missing' } }
  # Byte-exact snapshot for restore, so a paired config is put back untouched
  # (Get-Content round-trips would add a BOM / newline the service could choke on).
  $origBytes = [IO.File]::ReadAllBytes($cfg)
  try {
    $obj = Get-Content $cfg -Raw | ConvertFrom-Json
  }
  catch {
    return [PSCustomObject]@{ Ok = $false; Detail = 'config.json is not valid json' }
  }
  $hadFirebase = [bool]$obj.firebase
  $probe = "harness_$([guid]::NewGuid().ToString('N').Substring(0,8))"
  $noBom = New-Object System.Text.UTF8Encoding($false)
  try {
    $obj | Add-Member -NotePropertyName '_harnessProbe' -NotePropertyValue $probe -Force
    # The desktop app's write shape: serialise, then temp-file-and-rename in
    # config\ (no BOM, like json_io.rs). The named mutex is a concurrency detail,
    # not an ACL one, so it is not reproduced here.
    $tmp = "$cfg.harness.tmp"
    [IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 40), $noBom)
    Move-Item -LiteralPath $tmp -Destination $cfg -Force
    $back = Get-Content $cfg -Raw | ConvertFrom-Json
    $ok = ("$($back._harnessProbe)" -eq $probe) -and ((-not $hadFirebase) -or [bool]$back.firebase)
    $detail = if ($ok) { "console user wrote config.json; firebase preserved=$hadFirebase" } else { "probe or firebase not preserved" }
  }
  catch {
    $ok = $false; $detail = "write denied or failed: $($_.Exception.Message)"
  }
  finally {
    # Restore the original bytes regardless of outcome.
    try { [IO.File]::WriteAllBytes($cfg, $origBytes) } catch { }
  }
  [PSCustomObject]@{ Ok = $ok; Detail = $detail }
}

# Smoke S5: tmp\app_states.json readable by the console user. The service writes
# it with a SYSTEM/Admins/console-user DACL in 3.3.6; the tray reads it. This
# session runs as the console account, so a successful parse proves readability.
$SB_AppStatesRead = {
  param($waitSec)
  $p = 'C:\ProgramData\Owlette\tmp\app_states.json'
  $deadline = (Get-Date).AddSeconds($waitSec)
  while (-not (Test-Path $p) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 3 }
  if (-not (Test-Path $p)) { return [PSCustomObject]@{ Ok = $false; Skip = $true; Detail = "app_states.json not written yet (tray not up)" } }
  try {
    $null = Get-Content $p -Raw | ConvertFrom-Json
    [PSCustomObject]@{ Ok = $true; Skip = $false; Detail = "readable and parses" }
  }
  catch {
    [PSCustomObject]@{ Ok = $false; Skip = $false; Detail = "present but unreadable: $($_.Exception.Message)" }
  }
}

# Smoke S6: self-update staging dry run. Stages a dummy "next version" file in
# update-staging\ (writable by the Administrators-class account this session runs
# as), sha256s it and re-opens it read-shared - the download/verify/hold steps of
# the self-update, minus the schtasks execution that would actually reinstall. The
# Users-cannot-write property of update-staging is covered by the ACL assertion.
$SB_SelfUpdateDryRun = {
  $dir = 'C:\ProgramData\Owlette\update-staging'
  if (-not (Test-Path $dir)) {
    return [PSCustomObject]@{ Ok = $false; Detail = 'update-staging does not exist (service should create it fail-closed)' }
  }
  $dummy = Join-Path $dir ("owlette-next-{0}.exe" -f ([guid]::NewGuid().ToString('N').Substring(0,8)))
  try {
    # Minimal valid PE header so it passes the installer's MZ sanity check.
    $bytes = [byte[]]@(0x4D, 0x5A) + (New-Object byte[] 4094)
    [IO.File]::WriteAllBytes($dummy, $bytes)
    $sha = (Get-FileHash $dummy -Algorithm SHA256).Hash.ToLower()
    # Re-open read-shared and hash from the handle, as the hardened self-update does.
    $fs = [IO.File]::Open($dummy, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $held = $fs.CanRead
    $fs.Close()
    $ok = $held -and ($sha.Length -eq 64)
    [PSCustomObject]@{ Ok = $ok; Detail = if ($ok) { "staged + hashed + read-shared in update-staging" } else { "stage/hash/open failed" } }
  }
  catch {
    [PSCustomObject]@{ Ok = $false; Detail = "staging failed: $($_.Exception.Message)" }
  }
  finally {
    try { if (Test-Path $dummy) { Remove-Item -LiteralPath $dummy -Force } } catch { }
  }
}

# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------
try {
  if (-not $CandidateUrl -and -not $CandidatePath) {
    throw "pass -CandidateUrl (fetched in-guest) or -CandidatePath (pushed over the VM bus)"
  }
  if ($CandidatePath -and -not (Test-Path $CandidatePath)) { throw "candidate not found: $CandidatePath" }

  $vm = Get-VM -Name $Name -ErrorAction Stop
  $cred = Import-Clixml -Path $CredFile
  $key = Resolve-ApiKey
  $catalog = Get-InstallerCatalog $key
  Write-Host ("installer catalog: {0} version(s)." -f $catalog.Count) -ForegroundColor Green

  foreach ($v in $FromVersion) {
    Write-Host ""
    Write-Host ("=== upgrade from {0} -> candidate ===" -f $v) -ForegroundColor Cyan

    # Resolve the fielded installer before touching the VM, so a bad version or
    # key fails this row without burning a revert.
    $from = $null
    try { $from = Find-Installer $catalog $v }
    catch { Add-Row $v "resolve from-installer" "FAIL" $_.Exception.Message; continue }

    # 1. Revert to the clean image and boot.
    try {
      $snap = Get-VMSnapshot -VMName $Name -Name $Snapshot -ErrorAction Stop
      if ((Get-VM -Name $Name).State -ne 'Off') { Stop-VM -Name $Name -TurnOff -Force }
      Restore-VMSnapshot -VMSnapshot $snap -Confirm:$false
      Start-VM -Name $Name
    }
    catch { Add-Row $v "revert to $Snapshot" "FAIL" $_.Exception.Message; continue }

    $s = $null
    try { $s = Connect-Guest $Name $cred } catch { Add-Row $v "connect guest" "FAIL" $_.Exception.Message; continue }

    try {
      # 2. Prove it is a clean image.
      $pre = Invoke-Command -Session $s -ScriptBlock $SB_CleanCheck
      if ($pre.Svc -or $pre.Data) {
        Add-Row $v "clean image" "FAIL" "revert did not take (svc=$($pre.Svc) data=$($pre.Data))"
        continue
      }
      Add-Row $v "clean image" "PASS"

      # 3. Install the fielded version. Its service reaching Running is a NOTE, not
      #    a gate: 2.12.x/3.0.0 silent installs gate the service on a pairing poll
      #    that has no phrase here, so they legitimately leave it uninstalled - the
      #    candidate installs it unconditionally in step 6.
      $dl = Invoke-Command -Session $s -ScriptBlock $SB_DownloadOnly `
        -ArgumentList $from.Url, ("Owlette-from-$v.exe"), $from.Sha256
      if (-not $dl.Ok) { Add-Row $v "from-install $v" "FAIL" $dl.Detail; continue }
      $st = Invoke-Command -Session $s -ScriptBlock $SB_StartInstaller -ArgumentList $dl.Dest
      if (-not $st.Ok) { Add-Row $v "from-install $v" "FAIL" $st.Detail; continue }
      # the session is closed while the installer runs (see $SB_StartInstaller)
      Remove-PSSession $s -ErrorAction SilentlyContinue; $s = $null
      $fi = Wait-GuestInstall $Name $cred $FromInstallTimeoutSec -StopPairingPoll
      $s = Connect-Guest $Name $cred
      if (-not $fi.Ok) { Add-Row $v "from-install $v" "FAIL" $fi.Detail; continue }
      Add-Row $v "from-install $v" "PASS" $fi.Detail
      $fsvc = Invoke-Command -Session $s -ScriptBlock $SB_WaitService -ArgumentList 60
      Add-Row $v "from-service $v" "NOTE" "OwletteService=$($fsvc.Status)"

      # 4. Checkpoint the fielded state (replace an old same-named checkpoint).
      try {
        $existing = Get-VMSnapshot -VMName $Name -Name "golden-$v-installed" -ErrorAction SilentlyContinue
        if ($existing) { Remove-VMSnapshot -VMName $Name -Name "golden-$v-installed" -Confirm:$false; Start-Sleep -Seconds 8 }
        Checkpoint-VM -Name $Name -SnapshotName "golden-$v-installed"
        Add-Row $v "checkpoint" "NOTE" "golden-$v-installed"
      }
      catch { Add-Row $v "checkpoint" "NOTE" "could not checkpoint: $($_.Exception.Message)" }
      # A checkpoint pauses the guest and leaves the PowerShell Direct session
      # Broken; every later step needs a fresh one.
      Remove-PSSession $s -ErrorAction SilentlyContinue
      $s = Connect-Guest $Name $cred

      # 5. Install the candidate over it.
      if ($CandidateUrl) {
        $dl = Invoke-Command -Session $s -ScriptBlock $SB_DownloadOnly `
          -ArgumentList $CandidateUrl, $CandidateExeName, $CandidateSha256
        if (-not $dl.Ok) { Add-Row $v "candidate install" "FAIL" $dl.Detail; continue }
        $dest = $dl.Dest
      }
      else {
        # Copy-Item -ToSession cannot land a 43 MB exe: Defender in the guest opens
        # it for scanning mid-stream and the copy dies, leaving a stub (see
        # 10-stage-installer.ps1). Copy-VMFile writes it through the Guest Service
        # Interface in one go, and the guest verifies the bytes before running them.
        $gsi = Get-VMIntegrationService -VMName $Name -Name 'Guest Service Interface'
        if (-not $gsi.Enabled) { Enable-VMIntegrationService -VMName $Name -Name 'Guest Service Interface'; Start-Sleep -Seconds 5 }
        $dest = Invoke-Command -Session $s -ScriptBlock { Join-Path ([Environment]::GetFolderPath('Desktop')) $args[0] } -ArgumentList $CandidateExeName
        Copy-VMFile -Name $Name -SourcePath $CandidatePath -DestinationPath $dest -FileSource Host -CreateFullPath -Force
        $pushed = Invoke-Command -Session $s -ScriptBlock {
          param($p, $sha)
          Unblock-File -LiteralPath $p -ErrorAction SilentlyContinue
          $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower()
          [PSCustomObject]@{ Bytes = (Get-Item -LiteralPath $p).Length; Sha = $got; Ok = (-not $sha -or $got -eq $sha.ToLower()) }
        } -ArgumentList $dest, $CandidateSha256
        if (-not $pushed.Ok) { Add-Row $v "candidate push" "FAIL" "checksum mismatch in the guest: got $($pushed.Sha)"; continue }
        Add-Row $v "candidate push" "PASS" "$($pushed.Bytes) bytes, checksum verified in the guest"
      }
      $st = Invoke-Command -Session $s -ScriptBlock $SB_StartInstaller -ArgumentList $dest
      if (-not $st.Ok) { Add-Row $v "candidate install" "FAIL" $st.Detail; continue }
      Remove-PSSession $s -ErrorAction SilentlyContinue; $s = $null
      $ci = Wait-GuestInstall $Name $cred $InstallTimeoutSec
      $s = Connect-Guest $Name $cred
      if (-not $ci.Ok) { Add-Row $v "candidate install" "FAIL" $ci.Detail; continue }
      Add-Row $v "candidate install" "PASS" $ci.Detail

      # 6. Negative control (amendment 4): weaken one ACL so the assertion FAILs.
      if ($NegativeControl) {
        Invoke-Command -Session $s -ScriptBlock $SB_WeakenAcl | Out-Null
        Add-Row $v "negative control" "NOTE" "re-granted BUILTIN\Users Modify on agent\ (expect the ACL check to FAIL)"
      }

      # 7. ACL assertion.
      $acl = Invoke-Command -Session $s -ScriptBlock $SB_AclCheck
      if ($acl.Missing.Count -gt 0) {
        Add-Row $v "acl: paths present" "FAIL" ("missing: " + ($acl.Missing -join ', '))
      }
      else { Add-Row $v "acl: paths present" "PASS" }
      if ($acl.Offenders.Count -gt 0) {
        Add-Row $v "acl: no Users write" "FAIL" ($acl.Offenders -join '; ')
      }
      else { Add-Row $v "acl: no Users write" "PASS" }
      switch ($acl.Token) {
        'clean'         { Add-Row $v "acl: .tokens.enc" "PASS" "no BUILTIN\Users ACE" }
        'users-present' { Add-Row $v "acl: .tokens.enc" "FAIL" "a BUILTIN\Users ACE is present" }
        default         { Add-Row $v "acl: .tokens.enc" "SKIP" "not present (machine unpaired)" }
      }
      switch ($acl.TokenV1) {
        'clean'         { Add-Row $v "acl: .tokens.enc.v1" "PASS" "no BUILTIN\Users ACE" }
        'users-present' { Add-Row $v "acl: .tokens.enc.v1" "FAIL" "a BUILTIN\Users ACE is present" }
        default         { Add-Row $v "acl: .tokens.enc.v1" "SKIP" "not present (no pre-migration copy)" }
      }

      # 8. Candidate service Running.
      $csvc = Invoke-Command -Session $s -ScriptBlock $SB_WaitService -ArgumentList $ServiceTimeoutSec
      if ($csvc.Status -eq 'Running') { Add-Row $v "service running" "PASS" }
      else { Add-Row $v "service running" "FAIL" "OwletteService=$($csvc.Status)" }

      # 9a. Smoke: pairing path reaches a phrase.
      $pair = Invoke-Command -Session $s -ScriptBlock $SB_PairPhrase -ArgumentList 90
      if ($pair.Ok) { Add-Row $v "smoke: pairing phrase" "PASS" $pair.Detail }
      else { Add-Row $v "smoke: pairing phrase" "FAIL" $pair.Detail }

      # 9b. Smoke: full pairing (authorize + token write). Owner input required.
      if ($AuthorizePairing -and $pair.Ok) {
        Write-Host ""
        Write-Host "  ================================================" -ForegroundColor Yellow
        Write-Host ("   authorize this phrase for {0}:  {1}" -f $v, $pair.Phrase) -ForegroundColor Yellow
        Write-Host ("   at:  {0}" -f $pair.Url) -ForegroundColor Yellow
        Write-Host "  ================================================" -ForegroundColor Yellow
        $authorized = $false; $err = ''
        $out = 'C:\owlette-setup\pair-probe.jsonl'
        $deadline = (Get-Date).AddSeconds($AuthorizeTimeoutSec)
        while (-not $authorized -and -not $err -and (Get-Date) -lt $deadline) {
          Start-Sleep -Seconds 5
          foreach ($line in (Invoke-Command -Session $s -ScriptBlock $SB_ReadPairEvents -ArgumentList $out)) {
            if (-not $line) { continue }
            try { $ev = $line | ConvertFrom-Json } catch { continue }
            if ($ev.event -eq 'authorized') { $authorized = $true }
            elseif ($ev.event -eq 'error') { $err = "$($ev.value)" }
          }
        }
        Start-Sleep -Seconds 10
        $ps = Invoke-Command -Session $s -ScriptBlock $SB_PairedState
        if ($authorized -and $ps.SiteId -and $ps.Token) {
          Add-Row $v "smoke: pairing authorize" "PASS" "site=$($ps.SiteId), token written"
        }
        else {
          Add-Row $v "smoke: pairing authorize" "FAIL" ("authorized=$authorized site='$($ps.SiteId)' token=$($ps.Token)" + $(if ($err) { " err=$err" } else { "" }))
        }
      }
      else {
        Invoke-Command -Session $s -ScriptBlock $SB_StopPid -ArgumentList $pair.Pid | Out-Null
        Add-Row $v "smoke: pairing authorize" "SKIP" "needs -AuthorizePairing and an owner to authorize the phrase"
      }

      # 9c. Smoke: cortex IPC round trip.
      $cx = Invoke-Command -Session $s -ScriptBlock $SB_CortexRoundTrip -ArgumentList 40
      if ($cx.Ok) { Add-Row $v "smoke: cortex round trip" "PASS" $cx.Detail }
      else { Add-Row $v "smoke: cortex round trip" "FAIL" $cx.Detail }

      # 9d. Smoke: on-demand screenshot (needs a paired machine).
      $paired = Invoke-Command -Session $s -ScriptBlock $SB_PairedState
      if ($paired.SiteId -and $paired.Token) {
        $shot = Invoke-Command -Session $s -ScriptBlock $SB_Screenshot -ArgumentList 90
        if ($shot.Ok) { Add-Row $v "smoke: screenshot" "PASS" $shot.Detail }
        else { Add-Row $v "smoke: screenshot" "FAIL" $shot.Detail }
      }
      else {
        Add-Row $v "smoke: screenshot" "SKIP" "needs a paired machine (-AuthorizePairing); capture upload has no cloud target"
      }

      # 9e. Smoke: GUI-style config.json edit as the console user.
      $cfg = Invoke-Command -Session $s -ScriptBlock $SB_ConfigEdit
      if ($cfg.Ok) { Add-Row $v "smoke: config.json edit" "PASS" $cfg.Detail }
      else { Add-Row $v "smoke: config.json edit" "FAIL" $cfg.Detail }

      # 9f. Smoke: app_states.json readable by the console user.
      $as = Invoke-Command -Session $s -ScriptBlock $SB_AppStatesRead -ArgumentList 60
      if ($as.Ok) { Add-Row $v "smoke: app_states read" "PASS" $as.Detail }
      elseif ($as.Skip) { Add-Row $v "smoke: app_states read" "SKIP" $as.Detail }
      else { Add-Row $v "smoke: app_states read" "FAIL" $as.Detail }

      # 9g. Smoke: self-update staging dry run.
      $su = Invoke-Command -Session $s -ScriptBlock $SB_SelfUpdateDryRun
      if ($su.Ok) { Add-Row $v "smoke: self-update dry run" "PASS" $su.Detail }
      else { Add-Row $v "smoke: self-update dry run" "FAIL" $su.Detail }
    }
    catch {
      # an unexpected error is this row's FAIL, not the end of the matrix: the
      # remaining rows still run and the table still prints.
      Add-Row $v "unexpected error" "FAIL" $_.Exception.Message
    }
    finally {
      if ($s) { Remove-PSSession $s -ErrorAction SilentlyContinue }
    }
  }

  # ------------------------------------------------------------------------
  # Table + verdict.
  # ------------------------------------------------------------------------
  Write-Host ""
  Write-Host "==================== UPGRADE MATRIX ====================" -ForegroundColor Cyan
  $rows | Format-Table -AutoSize Version, Status, Check, Detail | Out-String | Write-Host

  $failCount = @($rows | Where-Object { $_.Status -eq 'FAIL' }).Count
  $skipCount = @($rows | Where-Object { $_.Status -eq 'SKIP' }).Count
  $passCount = @($rows | Where-Object { $_.Status -eq 'PASS' }).Count
  Write-Host ("PASS={0}  FAIL={1}  SKIP={2}" -f $passCount, $failCount, $skipCount)

  if ($failCount -gt 0) {
    Write-Host "UPGRADE VERIFY FAILED" -ForegroundColor Red
    exit 1
  }
  Write-Host "UPGRADE VERIFY OK" -ForegroundColor Green
}
catch {
  Write-Host "UPGRADE VERIFY ERROR: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
