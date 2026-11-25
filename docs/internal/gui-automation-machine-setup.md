# GUI Automation Machine Setup
**Created**: 2026-06-12 | **Status**: Canonical

The single source of truth for provisioning a Windows machine that runs Owlette GUI automation — both the **capture/demo machine** (video tutorials, maintainer present) and the **e2e runner VM** (unattended release gate). Other docs link here; do not duplicate this recipe elsewhere — `dev/video-tutorials/capture-native/README.md` covers only its scene-specific workflow and defers machine prep to this doc.

**INTERNAL — keep inside `docs/internal/`**, which is never published (only `web/content/docs` is). This doc discusses autologon, disabled screen lock, and elevated runners — it must never reach the public docs site. When the e2e harness directory is created in Wave 1, link here from its README; this is the permanent home.

**Executable version**: `scripts/bootstrap-gui-automation.ps1` — validates the checkable items below; items required for the selected rig FAIL (exit 1, so it doubles as a run preflight) while advisory items WARN without gating. `-Apply` fixes the safe subset (power timeouts, screen-saver/resume-logon registry, the pinned venv, and for CaptureRig the Defender exclusion — the idle auto-lock *policy* stays manual) and deliberately runs even when validation failed — re-run without `-Apply` to verify. `-Rig CaptureRig|E2eRunner` (alias `-Profile`) adds the Profile B/C checks. Items it can't automate (autologon enrollment, Windows Update deferral, DPI changes, snapshots, runner registration) print as a manual-steps list. Keep script and doc in sync — a new checklist line here should gain a check there.

---

## Profile A — common base (every GUI-automation machine)

### 1. OS + display (pin it, then never touch it)

- [ ] Windows 11 Pro x64 (64-bit Windows 10+ is the script's hard floor; non-Win11-Pro editions warn as unvalidated).
- [ ] **Display scaling 100%** (Settings → Display → Scale). Template matching and geometry-resolved clicks break under any other scale.
- [ ] **Fixed resolution** — pick one (1920×1080 recommended) and keep it; record it here when the box is provisioned.
- [ ] **Fixed theme** (light/dark) — template crops are theme-sensitive. Record the choice.
- [ ] A VM console resize or Windows Update can silently change these — re-verify all three after any update.

### 2. Power + lock (UIAutomation dies on a locked or blank screen)

```powershell
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
```

- [ ] Screen saver off, "On resume, display logon screen" unchecked (Settings → Lock screen → Screen saver).
- [ ] Lock screen disabled / no idle auto-lock (Settings → Accounts → Sign-in options → "Never" require sign-in).

### 3. RDP discipline

A plain RDP disconnect **locks the console desktop and kills UIAutomation**. Never just close the RDP window. Detach by returning the session to the console:

```powershell
# from an elevated shell INSIDE the RDP session, before disconnecting:
$id = (qwinsta | Select-String 'rdp-tcp#.*Active').ToString().Trim() -split '\s+' | Select-Object -Index 2
tscon $id /dest:console
```

### 4. UAC

- [ ] **Leave UAC ON.** pywinauto cannot click the secure-desktop UAC prompt — no in-session UIA tool can.
- [ ] Run automation (and anything that launches the installer) from an **already-elevated** shell/process so the prompt never appears. Never set `EnableLUA=0`; `ConsentPromptBehaviorAdmin=0` only as a documented last resort on a disposable image.

### 5. Mark-of-the-Web

Downloaded installer EXEs carry MotW → SmartScreen can interpose with a prompt automation can't click:

```powershell
Unblock-File -Path 'C:\path\to\Owlette-Installer-v*.exe'
```

### 6. Python toolchain (the verified pin set)

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install pywinauto==0.6.9 pywin32==306 psutil
```

- [ ] **`pywin32` MUST stay at 306.** 310+ fails with `DLL load failed` against the embedded Py3.9/Win11 combo. This pin is enforced in `dev/video-tutorials/capture-native/requirements.txt` — if you hit DLL errors, check this first, do not "upgrade to fix". (The bootstrap script hard-fails a pywin32 mismatch; pywinauto/psutil version drift only warns.)

### 7. Smoke test

```powershell
# UIA stack alive?
python -c "from pywinauto import Desktop; print(len(Desktop(backend='uia').windows()), 'windows visible')"
# not running in Session 0, and a console session exists? (checking only WTSGetActiveConsoleSessionId
# is NOT enough - a Session-0 service still sees the active console session)
python -c "import ctypes; k = ctypes.windll.kernel32; con = k.WTSGetActiveConsoleSessionId(); sid = ctypes.c_ulong(); k.ProcessIdToSessionId(k.GetCurrentProcessId(), ctypes.byref(sid)); print('console:', con, 'process:', sid.value); assert sid.value != 0, 'Session 0 - no desktop'; assert con != 0xFFFFFFFF, 'no console session'"
```

---

## Profile B — capture/demo machine extras (video tutorials)

- [ ] OBS (recommended capture) or ffmpeg + ffprobe for scripted capture and validation (the script fails when neither is present).
- [ ] Defender exclusion for `dev/video-tutorials/capture-native/.output` — real-time scanning throttles growing mp4s (`-Apply` adds it when elevated).
- [ ] Single primary monitor — the bootstrap script warns on multiple displays; the episode capture preflights (native pipeline) hard-assert one.
- [ ] Scene workflow, `DUMP=1` control-tree tuning, and recorder helpers: see `dev/video-tutorials/capture-native/README.md`.
- [ ] Disposable machine only — installs/uninstalls Owlette repeatedly (manual practice, not script-checkable).

## Profile C — e2e runner VM extras (unattended release gate)

> **Creating the VM itself** — Hyper-V feature, Gen-2 + Secure Boot + vTPM, booting
> the ISO, and the golden snapshot — is
> [hyper-v-capture-vm.md](hyper-v-capture-vm.md), with scripts in `scripts/vm/`.
> This section is what to configure once the guest is up.

Everything in Profile A, plus:

- [ ] **Autologon** for the test user — use Sysinternals `Autologon.exe` (stores the password via LSA, not plaintext registry). The autologon password lives in the host/runner secret store, never in image docs.
- [ ] **Windows Update deferred/paused** — an unattended reboot mid-run is a flake factory, and updates drift the pinned display settings.
- [ ] **GitHub Actions runner configured as the interactive autologon user, NOT as a service.** A service runner lives in Session 0: no desktop, no GUI, and the failure is silent. Start `run.cmd` at logon (shell:startup shortcut or a scheduled task set to "Run only when user is logged on"). The bootstrap script fails when its process runs in Session 0 and warns when not attached to the console session, so a misconfigured runner fails loudly.
- [ ] Node.js + Playwright + chromium (`npx playwright install chromium`), curl.
- [ ] Secrets (dev e2e-superadmin login, Firebase admin creds) in the runner secret store only.
- [ ] **Network-isolated from anything that can reach prod.** Treat the box as compromised-by-design (autologon + no lock).
- [ ] **Golden snapshot** taken after all of the above, with no Owlette installed (empty-machine preflight must pass). State reset between runs is snapshot revert — silent uninstall deliberately preserves user data, so uninstall alone never empties the box.
- [ ] **Second snapshot for the upgrade leg**: version N-1 installed + paired + heartbeating. Document the rotation procedure when re-baselining (and exclude its baked-in refresh token from cloud teardown sweeps — see `dev/completed/full-machine-e2e/plan.md`).

---

## Maintenance

Owned by the fleet-e2e-vms initiative (`dev/active/fleet-e2e-vms/`; it absorbed full-machine-e2e on 2026-09-05 — archive at `dev/completed/full-machine-e2e/`) until the harness ships, then by the harness; the location stays. If either rig needs something machine-level that isn't here, **add it here** — never to the capture-native README or the harness README.
