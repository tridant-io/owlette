# Build the two ISOs the unattended install needs (tri-platform task 0.0).
# Runs UNELEVATED - nothing here touches Hyper-V.
#
#   .\02-seed-iso.ps1
#
# It produces:
#   1. seed.iso      - a NoCloud "cidata" volume holding the autoinstall
#                      user-data plus an empty meta-data. This is DVD 2.
#   2. <iso>-autoinstall.iso - the downloaded live-server ISO with one word
#                      added to its GRUB menu entries. This is DVD 1.
#
# Why (2) exists, when the brief only asked for a seed: subiquity treats an
# autoinstall config that arrives via cloud-init as untrusted. It boots, finds
# the seed, and then STOPS at "the installer will destroy your disk, continue?"
# - a human keypress in the middle of a headless run. The documented way to
# skip that confirmation is the word "autoinstall" on the kernel command line
# (canonical-subiquity.readthedocs-hosted.com, "Autoinstall quick start":
# "To skip the need for a confirmation, interrupt the booting process, and add
# the autoinstall parameter to the kernel command line"). Patching grub.cfg is
# that, made repeatable. xorriso replays the original El Torito boot images
# rather than rebuilding them, so the ISO stays Secure Boot bootable: the
# signed shim and GRUB binaries are untouched and Ubuntu's GRUB does not
# signature-check grub.cfg on removable media.
#
# genisoimage and xorriso come from WSL - Windows ships no ISO authoring tool.
#
# ASCII ONLY: PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless
# the file carries a UTF-8 BOM, so a stray em-dash breaks the parse.

[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingPlainTextForPassword', 'Password',
  Justification = 'Lab VM console password, deliberately fixed and documented in the README.')]
param(
  [string]$VmRoot = "C:\VMs",
  [string]$Name = "owlette-kiosk",
  [string]$IsoDir = "C:\VMs\iso",
  # Defaults to the newest live-server ISO 01-fetch-iso.ps1 left in $IsoDir.
  [string]$InstallerIso = "",
  [string]$Hostname = "owlette-kiosk",
  [string]$Username = "kiosk",
  [string]$Password = "owlette-lab",
  [string]$WslDistro = "Ubuntu-24.04",
  # Rebuild both ISOs even if they already exist.
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP ("owlette-ubuntu-seed-{0}.log" -f $PID)
Start-Transcript -Path $log -Force | Out-Null
Write-Host "transcript: $log" -ForegroundColor Cyan

function ConvertTo-WslPath([string]$winPath) {
  # C:\VMs\x -> /mnt/c/VMs/x. Only used for paths this script owns, so the
  # naive drive-letter rewrite is enough.
  $p = (Resolve-Path -LiteralPath $winPath -ErrorAction SilentlyContinue)
  if ($p) { $winPath = $p.Path }
  $drive = $winPath.Substring(0, 1).ToLower()
  return "/mnt/$drive" + ($winPath.Substring(2) -replace '\\', '/')
}

function Invoke-Wsl([string]$bash) {
  # -u root because genisoimage/xorriso write into /mnt/c and the default WSL
  # user is not the Windows account's owner there.
  #
  # EAP drops to Continue for the call: PS 5.1 wraps each stderr line of a
  # native exe in a NativeCommandError when stderr is merged, and under
  # EAP=Stop a harmless xorriso progress line on stderr would abort the run.
  # The exit code is the only failure signal worth trusting here.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & wsl.exe -d $WslDistro -u root -- bash -lc $bash 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  $text = (($out | ForEach-Object { "$_" }) -join "`n")
  if ($code -ne 0) { throw "wsl exited $code for: $bash`n$text" }
  return $text
}

try {
  $vmDir = Join-Path $VmRoot $Name
  $seedDir = Join-Path $vmDir 'seed'
  $sshDir = Join-Path $vmDir 'ssh'
  New-Item -ItemType Directory -Force $seedDir | Out-Null
  New-Item -ItemType Directory -Force $sshDir | Out-Null

  if (-not $InstallerIso) {
    $InstallerIso = (Get-ChildItem -Path $IsoDir -Filter 'ubuntu-24.04.*-live-server-amd64.iso' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -notlike '*-autoinstall.iso' } |
      Sort-Object Name -Descending | Select-Object -First 1 -ExpandProperty FullName)
  }
  if (-not $InstallerIso -or -not (Test-Path $InstallerIso)) {
    throw "no live-server ISO in $IsoDir - run 01-fetch-iso.ps1 first"
  }
  Write-Host "installer ISO: $InstallerIso" -ForegroundColor Cyan

  # --- 1. an SSH key, so 04 and 05 can drive the guest without a password ----
  # The guest also gets the password below for console login; the key exists
  # because ssh.exe cannot be fed a password non-interactively and a headless
  # verifier must not need one.
  $keyPath = Join-Path $sshDir 'id_ed25519'
  if (-not (Test-Path $keyPath)) {
    & ssh-keygen.exe -t ed25519 -N '""' -C "owlette-kiosk-lab" -f $keyPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "ssh-keygen exited $LASTEXITCODE" }
    Write-Host "generated $keyPath" -ForegroundColor Green
  } else {
    Write-Host "reusing $keyPath" -ForegroundColor Green
  }
  # OpenSSH on Windows refuses a private key that other accounts can read
  # ("UNPROTECTED PRIVATE KEY FILE"), and C:\VMs inherits read rights for
  # Users from the drive root. Break inheritance and keep this account only.
  & icacls.exe $keyPath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls exited $LASTEXITCODE for $keyPath" }
  $pubKey = (Get-Content "$keyPath.pub" -Raw).Trim()

  # --- 2. the autoinstall config -------------------------------------------
  # openssl lives in WSL; Windows has no crypt(3). SHA-512 ($6$) is what
  # /etc/shadow on noble expects.
  $hash = (Invoke-Wsl "openssl passwd -6 '$Password'").Trim()
  if ($hash -notmatch '^\$6\$') { throw "unexpected password hash: $hash" }

  # Package notes:
  #  - libgtk-3-0t64, not libgtk-3-0: noble's 64-bit time_t transition renamed
  #    the binary package. "libgtk-3-0" only survives as a virtual name, and a
  #    virtual name that ever gains a second provider stops resolving.
  #  - linux-cloud-tools-virtual is not a desktop dependency: it carries the
  #    Hyper-V KVP daemon, which is how the HOST learns the guest's IP
  #    (Get-VMNetworkAdapter). 04 and 05 have no other way to find the VM.
  #  - network-manager arrives anyway under ubuntu-desktop-minimal, but it is
  #    named explicitly because the late-commands below disable systemd-networkd
  #    and hand the link to it. A transitive dependency that silently goes away
  #    would leave the guest with no network at all, so the thing we depend on
  #    is written down.
  $userData = @"
#cloud-config
autoinstall:
  version: 1
  # Do not let subiquity refresh itself mid-run: a snap update partway through
  # an unattended install swaps the code out from under the config below.
  refresh-installer:
    update: false
  locale: en_US.UTF-8
  keyboard:
    layout: us
  identity:
    hostname: $Hostname
    username: $Username
    password: "$hash"
  ssh:
    install-server: true
    allow-pw: true
    authorized-keys:
      - "$pubKey"
  storage:
    layout:
      name: lvm
  packages:
    - ubuntu-desktop-minimal
    - openssh-server
    - xdg-utils
    - dbus-user-session
    - libwebkit2gtk-4.1-0
    - libgtk-3-0t64
    - libayatana-appindicator3-1
    - librsvg2-2
    - xdotool
    - python3-venv
    - curl
    - git
    - linux-cloud-tools-virtual
    - network-manager
  late-commands:
    # X11 only in v1 of the Linux port: the desktop app's webview and tray
    # paths are tested against Xorg, and Wayland changes both. GDM reads this
    # file at boot, so writing it here is enough - no session restart needed.
    - mkdir -p /target/etc/gdm3
    - printf '%s\n' '[daemon]' 'AutomaticLoginEnable=true' 'AutomaticLogin=$Username' 'WaylandEnable=false' > /target/etc/gdm3/custom.conf
    # The server ISO leaves multi-user.target as the default even once a
    # desktop is installed, which would boot to a text console.
    - curtin in-target --target=/target -- systemctl set-default graphical.target
    # Hand the network to NetworkManager, the way a real Ubuntu Desktop install
    # is shaped. The live-server ISO leaves netplan's renderer unset (so it
    # defaults to systemd-networkd) AND leaves systemd-networkd enabled; adding
    # a desktop on top gives the machine two network stacks. netplan then emits
    # no .network files, systemd-networkd manages zero links, and
    # systemd-networkd-wait-online sits waiting 120s for a managed link that
    # never appears. It fails - which is the whole reason the first build came
    # up "degraded" - and it blocks network-online.target on the way down,
    # once ahead of cloud-init.service and again ahead of cloud-config.service.
    # gdm is ordered after those, so graphical.target landed at 4min 10s and 05
    # gave up long before the auto-login session existed. Pinning the renderer
    # and dropping networkd took the guest to graphical.target in 2.6s.
    #
    # The renderer is pinned in /etc rather than relying on the
    # network-manager package's own /usr/lib/netplan/00-network-manager-all.yaml:
    # disabling networkd is only safe while something else owns the link, so
    # the two halves of that bargain belong in the same place. 99- outranks
    # cloud-init's 50-cloud-init.yaml, which cloud-init rewrites on every boot.
    - mkdir -p /target/etc/netplan
    - "printf '%s\\n' 'network:' '  version: 2' '  renderer: NetworkManager' > /target/etc/netplan/99-kiosk-renderer.yaml"
    # netplan refuses to read a world-readable config (it holds wifi secrets on
    # other machines) and warns loudly about one.
    - chmod 600 /target/etc/netplan/99-kiosk-renderer.yaml
    - curtin in-target --target=/target -- systemctl disable systemd-networkd-wait-online.service
    - curtin in-target --target=/target -- systemctl disable systemd-networkd.socket
    - curtin in-target --target=/target -- systemctl disable systemd-networkd.service
    - curtin in-target --target=/target -- systemctl enable NetworkManager.service
    - curtin in-target --target=/target -- systemctl enable ssh
    - curtin in-target --target=/target -- usermod -aG adm,sudo $Username
  # poweroff, NOT the default reboot. DVD 1 is still attached and still first
  # in the boot order at this point, so a reboot would walk straight back into
  # the installer and autoinstall the machine it just built. Powering off hands
  # control back to the host, which ejects the media before starting it again
  # (04-install.ps1).
  shutdown: poweroff
"@

  # meta-data must exist even when empty, or cloud-init ignores the volume.
  $metaData = @"
instance-id: $Name-1
local-hostname: $Hostname
"@

  # LF endings and no BOM: cloud-init parses this as YAML on Linux, and a BOM
  # on the first line makes "#cloud-config" unrecognisable.
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText((Join-Path $seedDir 'user-data'), ($userData -replace "`r`n", "`n"), $utf8NoBom)
  [IO.File]::WriteAllText((Join-Path $seedDir 'meta-data'), ($metaData -replace "`r`n", "`n") + "`n", $utf8NoBom)

  Write-Host "----- user-data -----" -ForegroundColor Yellow
  Write-Host $userData
  Write-Host "----- end user-data -----" -ForegroundColor Yellow

  # Fail here rather than 25 minutes into a boot that silently ignored a
  # malformed seed.
  # The file is fed on stdin rather than named as an argument: a quoted path
  # inside a python -c inside bash -lc inside a PowerShell native call loses a
  # quote level somewhere every time.
  $seedWsl = ConvertTo-WslPath $seedDir
  Invoke-Wsl "cd '$seedWsl' && python3 -c 'import yaml,sys; yaml.safe_load(sys.stdin)' < user-data" | Out-Null
  Write-Host "user-data parses as YAML." -ForegroundColor Green

  # --- 3. seed.iso ----------------------------------------------------------
  # -volid cidata is the whole contract: cloud-init's NoCloud datasource scans
  # block devices for that label and nothing else identifies the disk.
  $seedIso = Join-Path $vmDir 'seed.iso'
  $seedIsoWsl = ConvertTo-WslPath $vmDir
  Invoke-Wsl "cd '$seedWsl' && genisoimage -quiet -output '$seedIsoWsl/seed.iso' -volid cidata -joliet -rock user-data meta-data" | Out-Null
  if (-not (Test-Path $seedIso)) { throw "genisoimage produced no $seedIso" }
  Write-Host "built $seedIso" -ForegroundColor Green

  # --- 4. the autoinstall-enabled installer ISO -----------------------------
  $patchedIso = Join-Path $IsoDir ((([IO.Path]::GetFileNameWithoutExtension($InstallerIso))) + "-autoinstall.iso")
  if ((Test-Path $patchedIso) -and -not $Force) {
    Write-Host "patched installer ISO already present: $patchedIso" -ForegroundColor Green
  } else {
    if (Test-Path $patchedIso) { Remove-Item $patchedIso -Force }
    $srcWsl = ConvertTo-WslPath $InstallerIso
    $dstWsl = (ConvertTo-WslPath $IsoDir) + "/" + (Split-Path $patchedIso -Leaf)
    $work = "/tmp/owlette-kiosk-grub"
    Write-Host "patching GRUB to add the autoinstall kernel argument..." -ForegroundColor Cyan
    # -osirrox extracts; the sed targets the two casper kernel lines (stock and
    # HWE) and is idempotent - it refuses to add the word twice. The argument
    # goes BEFORE the "---" separator so it lands on the kernel command line
    # subiquity reads, not in the post-boot section.
    $script = @"
set -e
set -o pipefail
rm -rf $work && mkdir -p $work
xorriso -osirrox on -indev '$srcWsl' -extract /boot/grub/grub.cfg $work/grub.cfg 2>/dev/null
chmod u+w $work/grub.cfg
sed -i -E 's@(linux[[:space:]]+/casper/[a-z-]*vmlinuz)([[:space:]]+)@\1 autoinstall\2@g; s@autoinstall autoinstall@autoinstall@g' $work/grub.cfg
grep -n 'casper/.*vmlinuz' $work/grub.cfg
xorriso -indev '$srcWsl' -outdev '$dstWsl' -boot_image any replay -map $work/grub.cfg /boot/grub/grub.cfg -commit 2>&1 | tail -5
"@
    $out = Invoke-Wsl ($script -replace "`r`n", "`n")
    Write-Host $out
    if (-not (Test-Path $patchedIso)) { throw "xorriso produced no $patchedIso" }
    if ($out -notmatch 'autoinstall') { throw "grub.cfg was not patched - no autoinstall argument in the kernel lines" }
    Write-Host "built $patchedIso" -ForegroundColor Green
  }

  Write-Host "SEED OK" -ForegroundColor Green
  Write-Host "installer ISO: $patchedIso"
  Write-Host "seed ISO: $seedIso"
  Write-Host "ssh key: $keyPath"
}
catch {
  Write-Host "SEED FAILED: $($_.Exception.Message)" -ForegroundColor Red
  throw
}
finally {
  try { Stop-Transcript | Out-Null } catch { }
}
