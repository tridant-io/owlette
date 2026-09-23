# Ubuntu 24.04 kiosk VM (Hyper-V)

The Linux target for the tri-platform work: a Gen-2 Hyper-V guest running
Ubuntu 24.04 LTS with a minimal GNOME desktop on **Xorg**, auto-logged in as
`kiosk`. It covers every non-media row of the port - agent, systemd unit,
packaging, pairing, desktop app, X11 session - without needing a second
physical machine.

These scripts are separate from the numbered scripts in `scripts/vm/`, which
build the **Windows** fleet VM. Nothing here touches those.

## Prerequisites

- Hyper-V enabled (`../01-enable-hyperv.ps1`) and an elevated PowerShell for
  steps 03-06. Hyper-V cmdlets fail for a caller who is neither elevated nor in
  the "Hyper-V Administrators" group.
- WSL with `Ubuntu-24.04`, plus `genisoimage` and `xorriso`
  (`sudo apt-get install genisoimage xorriso`). Windows ships no ISO authoring
  tool, so step 02 borrows WSL's.
- ~10 GB free on `C:` for the two ISOs, plus whatever the guest grows into
  (~9 GB in practice).

## Run order

| step | elevated | what it does |
| --- | --- | --- |
| `01-fetch-iso.ps1` | no | downloads and SHA256-verifies the newest `ubuntu-24.04.x-live-server-amd64.iso` into `C:\VMs\iso\` |
| `02-seed-iso.ps1` | no | writes the autoinstall `user-data`/`meta-data`, builds `seed.iso` (volume label `cidata`), and writes a copy of the installer ISO with `autoinstall` added to its GRUB kernel lines |
| `03-create-vm.ps1` | yes | creates the VM: Gen 2, 4 vCPU, 4096 MB static, 40 GB dynamic VHDX, Secure Boot on the `MicrosoftUEFICertificateAuthority` template, DVD 1 = installer, DVD 2 = seed |
| `04-install.ps1` | yes | starts it, waits for the install to power the guest off, ejects both DVDs, points the firmware at the disk, and starts it again - then waits for the installed system to answer SSH as `owlette-kiosk`, which proves it comes up on its own |
| `05-verify-guest.ps1` | yes, unless `-Ip` | SSHes in and checks release, systemd, the auto-login session type, the user systemd instance, Xorg, the GDM config and the packages the desktop app links against |
| `06-checkpoint-golden.ps1` | yes | takes `golden-<yyyyMMdd>` once 05 passes |

Each script writes a transcript to `%TEMP%\owlette-ubuntu-*-<pid>.log` and ends
with a single `... OK` / `... FAILED` line. 01, 02, 05 and 06 are safe to
re-run. 03 is not, against a guest that is already built: it re-attaches the
installer ISO and makes it the first boot device, so 03 followed by 04
reinstalls over the finished guest. 04 only makes sense straight after 03: run
against a finished, powered-off guest it boots the installed system, waits the
whole install timeout for a power-off that never comes, and reports INSTALL
FAILED. A rebuild is `03 -Recreate`.

Steps 03-06 chain, so one elevated PowerShell answers one UAC prompt for the
whole ~35-minute build:

```powershell
cd <repo>\scripts\vm\ubuntu
$ErrorActionPreference = 'Stop'
.\03-create-vm.ps1; .\04-install.ps1; .\05-verify-guest.ps1; .\06-checkpoint-golden.ps1 -StopFirst
```

## Why the installer ISO gets patched

subiquity treats an autoinstall config that arrives over cloud-init as
untrusted: it boots, finds the seed, and then waits for a human to confirm
before touching the disk. The documented way to skip that is the word
`autoinstall` on the kernel command line, so step 02 replays the ISO through
`xorriso` with that one word added to the two casper kernel lines. The El Torito
boot images are replayed untouched, so the signed shim and GRUB are unchanged
and the ISO still boots with Secure Boot on.

## The guest

| | |
| --- | --- |
| VM / hostname | `owlette-kiosk` |
| user | `kiosk` / `owlette-lab` (sudo, in `adm` and `sudo`) |
| ssh key | `C:\VMs\owlette-kiosk\ssh\id_ed25519` (no passphrase, lab only) |
| session | GDM auto-login, `WaylandEnable=false`, Xorg |
| seed files | `C:\VMs\owlette-kiosk\seed\user-data`, `meta-data` |
| console shot | `C:\VMs\owlette-kiosk\console-latest.png`, refreshed while 04 waits |

```powershell
$ip = (Get-VMNetworkAdapter -VMName owlette-kiosk).IPAddresses |
      Where-Object { $_ -notmatch ':' } | Select-Object -First 1
ssh -i C:\VMs\owlette-kiosk\ssh\id_ed25519 kiosk@$ip
Restore-VMSnapshot -VMName owlette-kiosk -Name golden-<yyyyMMdd> -Confirm:$false
```

The guest reports its IP to the host through the Hyper-V KVP daemon, which is
why `linux-cloud-tools-virtual` is in the package list - without it the host has
no way to find the VM.

## Changing what the guest contains

Edit the `$userData` here-string in `02-seed-iso.ps1`, then re-run
`02` -> `03 -Recreate` -> `04` -> `05` -> `06`. The seed is the only source of
truth for the guest's contents; nothing is configured by hand after the install,
so a rebuild is always reproducible.
