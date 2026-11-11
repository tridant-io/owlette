# Building the Hyper-V capture / e2e VM

Creates the Windows 11 guest that Profile C in
[gui-automation-machine-setup.md](gui-automation-machine-setup.md) configures: the
box the release e2e gate runs on, and the clean machine episode 3's installer
beats are filmed against. Those beats need a guest that is genuinely **missing**
WebView2 and PawnIO, because the installer's progress captions only appear while
it installs them — which is why they cannot be shot on a dev workstation.

Scripts live in [`scripts/vm/`](../../scripts/vm/) and run in order. They are
idempotent: re-running after a failure resumes rather than colliding.

| | |
|---|---|
| `01-enable-hyperv.ps1` | enable the Hyper-V feature (once per host, needs a reboot) |
| `02-create-vm.ps1` | create/configure the VM — Gen 2, Secure Boot, vTPM, ISO, NIC |
| `03-provision-vm.ps1` | grant Hyper-V rights, then call `02` |
| `04-boot-installer.ps1` | boot the ISO, catching the "press any key" prompt over WMI |
| `05-prep-guest.ps1` | connect over PowerShell Direct, verify the guest is a valid base, run Profile A+C prep |
| `06-checkpoint-golden.ps1` | take the `golden-empty` checkpoint |
| `07-oobe-local-account.ps1` | get past the forced-Microsoft-account OOBE screen |
| `08-fix-guest-account.ps1` | create the `e2e` account, remove a wrongly-named one |
| `09-finalize-image.ps1` | shutdown, pin the display mode, reboot, verify, sweep |

---

## Before you start

- **Windows 11 ISO.** Get it from
  <https://www.microsoft.com/software-download/windows11> ("Download Windows 11
  Disk Image"), ~6-8 GB. Verify it is really UEFI-bootable before blaming the VM
  — see [the ISO is not the usual suspect](#the-iso-is-not-the-usual-suspect--but-rule-it-out-in-one-step).
- **Disk.** 80 GB dynamic VHDX; a fresh Win11 guest settles around 12 GB and
  grows from there. The host needs real headroom for snapshots.
- **An interactive session on the host.** Every step needs a UAC prompt, and a
  UAC prompt renders on the secure desktop. Over RDP or Parsec it may not reach
  you at all — see [UAC](#uac-you-will-see-this-error-and-it-is-not-what-it-says).

---

## Procedure

### 1. Enable Hyper-V (once per host)

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-File','<repo>\scripts\vm\01-enable-hyperv.ps1'
```

**Reboot.** `vmms` must be running before anything else works:

```powershell
Get-Service vmms      # Running
```

### 2. Create the VM

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-File','<repo>\scripts\vm\03-provision-vm.ps1'
```

Use `03`, not `02` — it also adds you to **Hyper-V Administrators**, without
which every later `Get-VM`, `Start-VM` and `Checkpoint-VM` needs its own UAC
prompt. **That membership applies at your next sign-in, not immediately.** Sign
out and back in when you can; until you do, drive Hyper-V through elevated
scripts (which is what these are).

Read the transcript it prints (`%TEMP%\owlette-vm-provision-<pid>.log`) and
confirm it ends `PROVISION OK`. The elevated window is a separate process — the
transcript is the only way an unelevated session sees what happened.

To rebuild from scratch, add `-Recreate`. Required after a vTPM mismatch; see
[vTPM](#vtpm-the-vm-refuses-to-start-after-a-second-run).

### 3. Boot the installer

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-File','<repo>\scripts\vm\04-boot-installer.ps1'
```

Do **not** try to catch "Press any key to boot from CD or DVD" by hand. `04`
resets the VM and types into its virtual keyboard over WMI for 45 s; the prompt
cannot be missed. Confirm `BOOT-KEYS OK` in
`%TEMP%\owlette-vm-boot-<pid>.log`, then check the screen:

```bash
ffmpeg -v error -f gdigrab -framerate 1 \
  -i title="owlette-e2e on localhost - Virtual Machine Connection" \
  -frames:v 1 -y vm-now.png
```

You should see **Windows 11 Setup**.

### 4. Walk Windows setup (manual, ~10 min)

Genuinely interactive; two choices are load-bearing for the golden image:

- **No Microsoft account** — take "domain join instead" / offline account.
- **Username `e2e`.**

Then set the guest display to **1920×1080** (Profile A pins resolution; the
capture harness asserts it).

### 5. Profile A + C prep, inside the guest

Driven from the host over **PowerShell Direct** (`Invoke-Command -VMName`), which
runs over the VM bus - no guest networking, no IP, no WinRM setup. It needs
Hyper-V admin rights on the host and a local account in the guest.

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-File','<repo>\scripts\vm\05-prep-guest.ps1'
```

It prompts for the guest password with `Get-Credential` in that window; the
password is never printed, logged, or stored.

Before running the bootstrap it **verifies the guest is a valid base**, and that
check is the point of the step: it fails if WebView2, PawnIO or Owlette are
already present, or if the display is not 1920x1080. Episode 3's b04 films the
installer's progress captions, and those only render while it installs WebView2
and PawnIO - discovering afterwards that the golden image already had them means
rebuilding it. Use `-VerifyOnly` to check without running the bootstrap.

Then work the manual checklist it prints, and the rest of
[Profile C](gui-automation-machine-setup.md#profile-c--e2e-runner-vm-extras-unattended-release-gate).

### 6. Golden snapshot

Shut the guest down **cleanly**, then:

```powershell
Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-File','<repo>\scripts\vm\06-checkpoint-golden.ps1'
```

It refuses to run against a guest that is still on - a checkpoint of a
hard-killed guest carries a dirty filesystem into every future run - and refuses
to overwrite an existing `golden-empty`, because silently replacing the golden
image is how a polluted base gets baked in.

This snapshot is the reset mechanism for every installer take and every e2e run.
Silent uninstall deliberately preserves user data, so uninstalling never returns
the box to empty — only a revert does.

---

## What goes wrong

Everything below actually happened while building this VM. Each cost real time,
and none of them says what it means.

### UAC: you will see this error, and it is not what it says

```
Start-Process : This command cannot be run due to the error: The operation was canceled by the user.
```

Windows returns this both when someone clicks No **and when the prompt is never
answered and times out**. If you are away from the keyboard, or the secure
desktop prompt cannot render — likely over RDP or Parsec — you get an instant
"canceled" that looks like a refusal.

Before assuming a policy problem, check that UAC is actually normal:

```powershell
$k='HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
'EnableLUA','ConsentPromptBehaviorAdmin','PromptOnSecureDesktop' |
  ForEach-Object { '{0} = {1}' -f $_, (Get-ItemProperty $k $_).$_ }
```

`1 / 5 / 1` is the standard configuration. If you see that, the prompt is being
raised correctly and simply is not being accepted.

### `.ps1` files must be pure ASCII

PowerShell 5.1 decodes a `.ps1` as the system **ANSI** codepage unless the file
carries a UTF-8 BOM. An em-dash written by a UTF-8 editor is three bytes, which
cp1252 turns into three characters — and inside a double-quoted string that eats
the terminator:

```
The string is missing the terminator: ".
Missing closing '}' in statement block or type definition.
```

Write these scripts in **plain ASCII** (`-`, `'`, `...`, `->`). It is more
durable than a BOM, which only protects files someone remembered to mark.
Parse-check before handing a script to anyone:

```powershell
$e=$null; [System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$null,[ref]$e); $e
```

### `-VM` is not universal

Most Hyper-V cmdlets take a VM object via `-VM`. **`Connect-VMNetworkAdapter`
and `Set-VMDvdDrive` do not** — they take `-VMName`, and passing `-VM` fails
with:

```
Parameter cannot be processed because the parameter name 'VM' is ambiguous.
Possible matches include: -VMNetworkAdapter -VMSwitch -VMName -Name.
```

Check rather than assume:

```powershell
(Get-Command Connect-VMNetworkAdapter).Parameters.Keys -contains 'VM'   # False
```

### vTPM: the VM refuses to start after a second run

```
'owlette-e2e' failed to start worker process: The computed authentication tag
did not match the input authentication tag. (0xC000A002)
```

`New-HgsKeyProtector` mints a **fresh** protector on every call. Running
`Set-VMKeyProtector` again against a VM whose vTPM is already enabled replaces
the protector its sealed state is bound to, and the VM can never start. This is
the classic way a "harmless" re-run bricks a working VM.

`02-create-vm.ps1` guards it:

```powershell
if (-not (Get-VMSecurity -VM $vm).TpmEnabled) { ...seal once... }
```

To recover, rebuild — the seal cannot be repaired:

```powershell
scripts\vm\03-provision-vm.ps1 -Recreate
```

### "The boot loader failed" usually means nobody pressed a key

The Hyper-V UEFI boot summary reports an expired optical-boot prompt as a
**failure**, then falls through the boot order:

```
1. SCSI DVD (0,1)      The boot loader failed.
2. Network Adapter     A boot image was not found.
3. SCSI Disk (0,0)     The boot loader did not load an operating system.
```

That is a missed "Press any key to boot from CD or DVD", not a misconfigured VM.
The **"Restart now" button on that screen is frequently inert** — use
`Action -> Reset` in VMConnect, or just run `04-boot-installer.ps1`.

### The ISO is not the usual suspect — but rule it out in one step

A truncated download looks identical in Explorer. Read the boot structures
instead of re-downloading on a hunch: a valid UEFI-bootable Windows ISO has an
El Torito boot record at sector 17 and a **0xEF** section in its boot catalog.

```python
with open(iso, "rb") as f:
    f.seek(0x8800); brvd = f.read(2048)
    assert brvd[7:30].startswith(b"EL TORITO")     # bootable at all
    cat = int.from_bytes(brvd[0x47:0x4B], "little")
    f.seek(cat * 2048); blob = f.read(2048)
    plats = [blob[o+1] for o in range(0, 2048, 32) if blob[o:o+1] in (b"\x90", b"\x91")]
    assert 0xEF in plats                            # UEFI section present
```

### You cannot automate the VMConnect window from an unelevated session

`vmconnect` launched by an elevated script **is** elevated, and UIPI forbids a
lower-integrity process from sending it input. UI automation (pywinauto and
friends) times out with no useful error.

Two things follow, and together they are a complete automation loop:

- **Input:** go around the window entirely and type into the VM's virtual
  keyboard over WMI. No focus, no timing, no integrity problem:

  ```powershell
  $sys = Get-WmiObject -Namespace 'root\virtualization\v2' -Class Msvm_ComputerSystem `
         -Filter "ElementName='owlette-e2e'"
  $kb = $sys.GetRelated('Msvm_Keyboard') | Select-Object -First 1
  $kb.TypeKey(0x20)          # VK_SPACE
  ```

  This is how `04-boot-installer.ps1` works, and how the installer wizard is
  driven during the shoot.

- **Output:** screen **capture** is not blocked the way input is, so an
  unelevated session can still read the guest's screen by grabbing the VMConnect
  window with `gdigrab -i title=...` (above).

### Read the transcript, and make sure it is the right one

These scripts run in a separate elevated window, so their transcript is the only
channel back. Two rules, both learned the hard way:

- **One log per run** (`...-<pid>.log`). A failing run keeps its window open
  (`-NoExit`) still holding the file, and an unelevated caller cannot kill an
  elevated process to release it — so the *next* run silently fails to start its
  transcript and you read **stale output**, concluding a fix did not work when
  it was never exercised.
- **`Stop-Transcript` in a `finally`**, so a terminating error releases the file.

Always read the newest log, and check its `Start time` against the clock.

---

### Windows 11 forces a Microsoft account during OOBE

24H2 removed the visible "offline account" path; there is no button to click.
Two escapes remain and `07-oobe-local-account.ps1` drives both:

- `start ms-cxh:localonly` (default) opens a local-account dialog immediately,
  no reboot, network intact. Patched in recent 25H2 **Insider** builds
  (26220.6772+) but present on retail 26200.
- `-Method BypassNro` sets the OOBE BypassNRO flag and reboots. Works on every
  current build, but **only while the machine is offline**, so it disconnects
  the vNIC. Reconnect it afterwards or the guest has no network and nothing
  says why (`05-prep-guest.ps1 -ConnectNic`).

### Key injection reports success while doing nothing

Three separate causes, all of which return "success", cost four attempts here:

1. **The console is in mark/selection mode.** Its title starts `Select ` and it
   silently swallows every keystroke while the API still returns 0. Send Esc
   before typing anything.
2. **`GetRelated()` returns an object with no method metadata.** A direct
   `$kb.TypeKey()` on it yields a raw object rather than a status code, and code
   that tests "is it 0?" reads absence-of-error as success. Rehydrate with
   `[wmi]$rel.__PATH` and call `InvokeMethod`, which returns a real `uint32`.
3. **Naming a helper `RV`** shadows PowerShell's built-in alias for
   `Remove-Variable`, so the helper never runs at all.

Probe with something whose success is externally visible - Enter producing a new
prompt line, Shift+F10 opening a second window - rather than trusting a return
code.

### PowerShell Direct rejects a host-qualified username

`Get-Credential` with no `-UserName` offers the HOST's qualified account
(`TEC-A4D\admin`). PowerShell Direct wants a guest-local name and rejects the
other with a flat "The credential is invalid", which says nothing about why.
Prefill the bare name.

Store the guest credential DPAPI-encrypted so the scripts run unattended without
a password on disk in the clear:

```powershell
$cred | Export-Clixml "$env:LOCALAPPDATA\owlette-vm\guest-e2e.cred"
```

`05`, `08` and `09` read it automatically and prompt only when it is absent.

### The guest's name and account are baked in forever

Windows generates a random hostname during OOBE (`DESKTOP-EQGJN15`), and
**Owlette's `machine_id` IS the hostname** (`agent/src/shared_utils.py:151` ->
`socket.gethostname()`). Whatever the golden image carries becomes that
machine's identity on the dashboard. Rename it deliberately
(`05-prep-guest.ps1 -RenameGuest owlette-e2e-01`; takes effect on reboot).

Same for the account: prefer creating the right one over `Rename-LocalUser`,
which renames the account but leaves its profile at `C:\Users\<old>`.

### Deleting an account's profile directory

Three things in order, and the order is the whole difference:

1. **End the old account's session first.** "Switch user" leaves it signed in
   with its registry hive mounted, and the profile then cannot be removed:
   "The process cannot access the file because it is being used by another
   process." `08` runs `quser` and logs the session off.
2. **Reboot.** The hive unloads on shutdown; until then nothing else works.
3. **Delete the `Win32_UserProfile` OBJECT, not the folder.** Windows removes
   the directory itself, including files a recursive delete cannot touch. Do
   NOT reach for `takeown` + `icacls` + `Remove-Item` - it fails even as an
   administrator, because the ACLs name a SID that no longer resolves.

```powershell
Get-CimInstance Win32_UserProfile |
  Where-Object { $_.LocalPath -eq 'C:\Users\admin' } | Remove-CimInstance
```

### Resolution must be set from the HOST

The synthetic display controller only offers modes the host permits, so setting
the resolution inside Windows silently reverts (1024x768 here, repeatedly).
`Set-VMVideo` pins it - and **requires the VM to be Off**:

```powershell
Set-VMVideo -VMName owlette-e2e -ResolutionType Single `
  -HorizontalResolution 1920 -VerticalResolution 1080
```

### A fresh guest is ExecutionPolicy Restricted

`bootstrap-gui-automation.ps1` will not load at all. Launch a child process with
`-ExecutionPolicy Bypass` rather than changing the machine policy - whether the
image ships with a relaxed policy is a Profile C decision, not a side effect of
running the bootstrap.

---

## Reference: what `02-create-vm.ps1` builds

| Setting | Value | Why |
|---|---|---|
| Generation | 2 | UEFI; required for Secure Boot + vTPM |
| Secure Boot | On, `MicrosoftWindows` template | Win11 requirement. The `MicrosoftUEFICertificateAuthority` template is for Linux guests |
| vTPM | Enabled, sealed once | Win11 requirement |
| Memory | 4 GB startup, dynamic 4-8 GB | |
| CPU | half the host's logical processors | |
| Disk | 80 GB dynamic VHDX | |
| Network | `Default Switch` | NAT to the internet, isolated from the LAN. Pass `-SwitchName` for something stricter |
| Checkpoints | Standard, automatic checkpoints **off** | Automatic checkpoints would fork the golden snapshot lineage |
