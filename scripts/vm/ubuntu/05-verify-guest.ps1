# Prove the kiosk guest is the machine the Linux port needs (tri-platform task
# 0.0). Run ELEVATED - it asks Hyper-V for the guest IP. Pass -Ip to skip that
# and run unelevated.
#
#   .\05-verify-guest.ps1
#
# What it is really checking, in one line: that a cold boot lands in an
# auto-logged-in Xorg session owned by the kiosk user, with the libraries the
# desktop app links against already present. Everything printed below is
# evidence for that claim, and each FAIL is a reason not to take the golden
# checkpoint.
#
# X11 and not Wayland is a v1 decision, not an accident: the desktop app's
# webview and tray indicator are tested against Xorg, and xdotool - the tool
# every GUI test in this repo drives - does not work under Wayland at all.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM.

param(
  [string]$Name = "owlette-kiosk",
  [string]$VmRoot = "C:\VMs",
  [string]$Username = "kiosk",
  [string]$KeyPath = "",
  # Skip the Hyper-V lookup (and the elevation it needs) by naming the guest.
  [string]$Ip = ""
)

$ErrorActionPreference = 'Stop'
$vmDir = Join-Path $VmRoot $Name
if (-not $KeyPath) { $KeyPath = Join-Path $vmDir 'ssh\id_ed25519' }
$log = Join-Path $env:TEMP ("owlette-ubuntu-verify-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

$failures = @()

function Invoke-Guest([string]$cmd) {
  # The command travels base64-encoded and is decoded by the guest's own
  # shell. PS 5.1 hands a native exe an argument that contains spaces wrapped
  # in double quotes and never escapes the double quotes INSIDE it, so the C
  # runtime on the far side of ssh.exe consumed them: `[ -n "$(...)" ]` reached
  # the guest as `[ -n $(...) ]`, which is TRUE for an empty value, and the
  # seat check below then accepted the verifier's own ssh session. Base64 has
  # no character PS or the CRT treats specially, so what is written here is
  # what the guest runs.
  $wire = 'echo {0} | base64 -d | bash' -f [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cmd))
  # EAP drops to Continue for the call: PS 5.1 turns a native exe's merged
  # stderr into NativeCommandError records, which under EAP=Stop would abort
  # this script on any command that writes a warning to stderr.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & ssh.exe -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=no `
      -o UserKnownHostsFile=NUL -o LogLevel=ERROR -o ConnectTimeout=10 `
      "$Username@$Ip" $wire 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  return [pscustomobject]@{ Code = $code; Text = (($out | ForEach-Object { "$_" }) -join "`n").Trim() }
}

function Show-Guest([string]$title, [string]$cmd) {
  Write-Host ""
  Write-Host "--- $title ---" -ForegroundColor Cyan
  $r = Invoke-Guest $cmd
  Write-Host $r.Text
  return $r
}

try {
  if (-not (Test-Path $KeyPath)) { throw "ssh key not found: $KeyPath - run 02-seed-iso.ps1" }
  if (-not $Ip) {
    # Only this lookup needs elevation: Hyper-V refuses a caller who is
    # neither elevated nor in the "Hyper-V Administrators" group. Passing
    # -Ip skips it, which is what makes an unelevated run possible.
    $me = New-Object Security.Principal.WindowsPrincipal(
      [Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      throw "the guest IP lookup needs an elevated PowerShell - elevate, or pass -Ip <address>"
    }
    $nic = Get-VMNetworkAdapter -VMName $Name -ErrorAction Stop | Select-Object -First 1
    $Ip = $nic.IPAddresses | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' -and $_ -notlike '169.254.*' } | Select-Object -First 1
    if (-not $Ip) {
      $mac = ($nic.MacAddress -replace '(..)(?=.)', '$1-')
      $Ip = (Get-NetNeighbor -LinkLayerAddress $mac -AddressFamily IPv4 -ErrorAction SilentlyContinue |
             Where-Object { $_.State -ne 'Unreachable' } | Select-Object -First 1).IPAddress
    }
  }
  if (-not $Ip) { throw "could not determine the guest IP - is the VM running?" }
  Write-Host "guest: $Username@$Ip" -ForegroundColor Cyan

  $probe = Invoke-Guest 'hostname'
  if ($probe.Code -ne 0) { throw "ssh to $Ip failed: $($probe.Text)" }
  Write-Host "hostname: $($probe.Text)" -ForegroundColor Green

  # --- release ---------------------------------------------------------------
  $r = Show-Guest 'lsb_release -a' 'lsb_release -a'
  if ($r.Text -notmatch '24\.04') { $failures += "not Ubuntu 24.04: $($r.Text)" }

  # --- systemd ---------------------------------------------------------------
  # is-system-running exits non-zero for "degraded", so the text is the signal,
  # not the exit code.
  #
  # "degraded" is a FAILURE here, not a warning. It was a warning once, on the
  # theory that a fresh desktop install always leaves one unit unhappy about
  # hardware a VM does not have. That theory cost a build: the degraded unit
  # was systemd-networkd-wait-online, and the same 120s timeout that failed it
  # also blocked network-online.target twice and pushed graphical.target to
  # 4min 10s - so the guest had no auto-login session yet when this script
  # looked, and the one line that would have explained why was printed in
  # yellow and passed. A clean boot on this image is "running"; anything else
  # is a reason not to checkpoint.
  $r = Show-Guest 'systemctl is-system-running' 'systemctl is-system-running; true'
  switch -Regex ($r.Text) {
    '^running'  { break }
    '^degraded' {
      $d = Invoke-Guest 'systemctl --failed --no-legend --no-pager'
      Write-Host "failed units:`n$($d.Text)" -ForegroundColor Red
      $failures += "systemd is degraded: $($d.Text -replace "`n", '; ')"
      break
    }
    default     { $failures += "systemd is '$($r.Text)'" }
  }

  # --- sessions --------------------------------------------------------------
  Show-Guest 'loginctl list-sessions' 'loginctl list-sessions --no-pager' | Out-Null

  # The graphical session, specifically. The SSH login this script arrives on
  # is ALSO a session owned by kiosk, so something has to tell them apart: the
  # graphical one is the one attached to a seat (seat0). The SSH one has no
  # seat at all.
  #
  # Derived by walking list-sessions rather than reading
  # "loginctl show-user <user> -p Display", which is what this used to do. That
  # property is a cached pointer and it can name a session that has already
  # gone away - the verifier then asked show-session about session 8, got
  # "No session '8' known", and reported that instead of the real state. Every
  # id below came out of list-sessions in the same breath and is confirmed to
  # have a seat, so show-session cannot be handed an id that does not exist.
  #
  # Class=user excludes GDM's own greeter, which also sits on seat0.
  #
  # Polled rather than read once: sshd answers before GDM has finished starting
  # the auto-login session, so a single read right after boot reports "no
  # graphical session" for a machine that is simply a few seconds behind.
  # Built from a single-quoted template with one substitution, for the same
  # reason as the package check below.
  $seatTpl = @'
for s in $(loginctl list-sessions --no-legend | awk '{print $1}'); do [ "$(loginctl show-session $s -p Name --value)" = "__USER__" ] || continue; [ "$(loginctl show-session $s -p Class --value)" = "user" ] || continue; [ -n "$(loginctl show-session $s -p Seat --value)" ] || continue; echo $s; break; done
'@
  $seatCmd = $seatTpl -replace '__USER__', $Username
  $sid = ""
  $deadline = (Get-Date).AddSeconds(90)
  while (-not $sid -and (Get-Date) -lt $deadline) {
    $sid = (Invoke-Guest $seatCmd).Text
    if (-not $sid) { Start-Sleep -Seconds 5 }
  }
  if (-not $sid) { $failures += "no seat session for $Username (autologin did not happen)" }
  else {
    Show-Guest "loginctl show-session $sid" "loginctl show-session $sid -p Id -p User -p Class -p Type -p Active -p Remote -p Seat" | Out-Null
    $type = ((Invoke-Guest "loginctl show-session $sid -p Type --value").Text)
    Write-Host "XDG_SESSION_TYPE (session $sid): $type" -ForegroundColor $(if ($type -eq 'x11') { 'Green' } else { 'Red' })
    if ($type -ne 'x11') { $failures += "graphical session type is '$type', expected x11" }
  }

  # --- the user's own systemd instance --------------------------------------
  # A dead user manager means no autostart, no tray, no D-Bus session - the
  # desktop app would fail in ways that look like app bugs.
  $r = Show-Guest 'systemctl --user status (as kiosk)' 'systemctl --user is-system-running; systemctl --user --no-pager --plain list-units --state=failed | head -20; true'
  if ($r.Text -match 'offline|failed to connect') { $failures += "no per-user systemd instance for $Username" }

  # --- Xorg ------------------------------------------------------------------
  $r = Show-Guest 'Xorg / display stack' 'pgrep -a Xorg || echo NO-XORG'
  if ($r.Text -match 'NO-XORG') { $failures += "no Xorg process is running" }
  Show-Guest 'gnome-shell' 'pgrep -a gnome-shell || echo none' | Out-Null

  # --- GDM autologin ---------------------------------------------------------
  $r = Show-Guest 'gdm3 custom.conf' 'cat /etc/gdm3/custom.conf'
  if ($r.Text -notmatch "AutomaticLogin\s*=\s*$Username") { $failures += "GDM autologin is not set to $Username" }
  if ($r.Text -notmatch 'AutomaticLoginEnable\s*=\s*[Tt]rue') { $failures += "GDM AutomaticLoginEnable is not true" }
  if ($r.Text -notmatch 'WaylandEnable\s*=\s*[Ff]alse') { $failures += "GDM WaylandEnable is not false" }
  Show-Guest 'default systemd target' 'systemctl get-default' | Out-Null

  # --- the libraries the desktop app links against ---------------------------
  # Checked here rather than assumed from the autoinstall package list: a
  # package that failed to install during autoinstall does not stop the
  # install, it just quietly is not there.
  $pkgs = 'libwebkit2gtk-4.1-0 libgtk-3-0t64 libayatana-appindicator3-1 librsvg2-2 xdotool python3-venv curl git openssh-server dbus-user-session xdg-utils ubuntu-desktop-minimal linux-cloud-tools-virtual network-manager'
  # Built from a single-quoted template with one substitution: a double-quoted
  # PowerShell string would need every $ and " in the shell snippet escaped,
  # and one missed backtick turns a check into a silent pass.
  $tpl = @'
for p in __PKGS__; do s=$(dpkg-query -W -f='${db:Status-Status}' $p 2>/dev/null); echo $p=${s:-MISSING}; done
'@
  $r = Show-Guest 'required packages' ($tpl -replace '__PKGS__', $pkgs)
  foreach ($line in ($r.Text -split "`n")) {
    if ($line -match '^(\S+)=(.*)$' -and $matches[2].Trim() -ne 'installed') {
      $failures += "package $($matches[1]) is '$($matches[2].Trim())'"
    }
  }

  Write-Host ""
  Write-Host "================ summary ================" -ForegroundColor Cyan
  Write-Host "guest      : $Username@$Ip"
  Write-Host "ssh        : ssh -i $KeyPath $Username@$Ip"
  if ($failures.Count -gt 0) {
    foreach ($f in $failures) { Write-Host "FAIL  $f" -ForegroundColor Red }
    throw "$($failures.Count) check(s) failed - do NOT checkpoint this image"
  }
  Write-Host "VERIFY OK" -ForegroundColor Green
  Write-Host "next: 06-checkpoint-golden.ps1" -ForegroundColor Yellow
}
catch {
  Write-Host "VERIFY FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
