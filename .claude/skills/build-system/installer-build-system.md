# Owlette Installer & Build System Reference

**Applies To**: `agent/` build pipeline, Inno Setup installer, the owlette-host service host

This document covers the complete build-to-installation pipeline on Windows. Read this before modifying any build scripts, the Inno Setup script, or the installation/update flow. The macOS pkg and Linux deb builds are in the build-system skill.

---

## Build Pipeline Overview

### Two Build Modes

| | Full Build | Quick Build |
|--|-----------|------------|
| **Script** | `build_installer_full.bat` | `build_installer_quick.bat` |
| **Duration** | 5-10 minutes | ~30 seconds |
| **Downloads Python** | Yes (3.11.8 embedded) | No (reuses existing) |
| **Installs pip/deps** | Yes | No |
| **Copies source** | Yes | Yes |
| **Builds Rust/desktop** | Yes (desktop app, owlette-host, swoop) | Rebuilds owlette-host when cargo is present; re-copies the desktop and swoop exes |
| **Compiles installer** | Yes — exits 1 at step 9 if no ISCC is found (the package is still assembled) | Yes (requires Inno Setup) |
| **When to use** | First build, dependency changes | Source code changes only |

**Prerequisites**: Inno Setup 6 (found via `%ISCC%`, then `iscc.exe` on PATH, then `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`), Node 22 + npm, rustup, MSVC C++ build tools, cmake.

---

## Full Build Steps (`build_installer_full.bat`)

```
[0/9] Read VERSION file (single source of truth)
[1/9] Clean build\installer_package, installer_output, python and tools (build\macos and build\linux are kept)
[2/9] Download Python 3.11.8 embedded (cached at agent\downloads\python-embed.zip, SHA256-pinned, checked with certutil) → build\python
[3/9] Configure python311._pth (import paths for embedded runtime)
[4/9] Bootstrap pip (get-pip.py)
[5/9] Install requirements.txt (the slow step) + delete the SDK's bundled claude.exe (242MB)
[6/9] Build the desktop app (npx tauri build --no-bundle → owlette-desktop.exe)
[7/9] Build the Rust binaries: owlette-host (agent/host) and the swoop streamer (agent/swoop, --features audio-opus, needs cmake)
[8/9] Assemble installer_package/ directory
[9/9] Compile with Inno Setup → Owlette-Installer-v{VERSION}.exe
```

### Package Structure (what gets bundled)
```
build/installer_package/
├── python/              Embedded Python 3.11 runtime
│   ├── python.exe       Console Python
│   ├── pythonw.exe      GUI Python (no console window) — hosts cortex + session_exec
│   ├── python311._pth   Import path configuration
│   └── Lib/
│       └── site-packages/  All pip dependencies
├── agent/
│   ├── src/             All Python source files (__pycache__ stripped)
│   ├── icons/           Application icons (ICO/PNG)
│   ├── CLAUDE.md        hoot's on-machine agent constitution
│   └── VERSION          Version file
├── app/
│   └── owlette-desktop.exe  Tauri desktop app — tray, config window, reboot prompt
├── swoop/
│   └── owlette-swoop.exe    swoop streamer (shared_utils.get_swoop_exe_path())
├── tools/
│   └── owlette-host.exe Windows service host (built from agent/host)
└── scripts/
    ├── install.bat      Service installation
    └── uninstall.bat    Service removal
```

The `.iss` also installs `README.md`, `CLAUDE.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md` and `LGPL-2.1.txt` to `{app}`.

No tkinter/tcl: the python UI was deleted in 3.0.0 and the embedded runtime has
never shipped a GUI toolkit of its own.

### Embedded Python Configuration (`python311._pth`)
```
python311.zip        # Compressed standard library
.                    # Current directory
Lib                  # Standard library
Lib\site-packages    # Third-party packages
..\agent\src         # Agent source code (relative path)
import site          # Enables site.main() for pip
```

**Important**: the `.pth` sits in `{app}\python`, so `..\agent\src` resolves to `{app}\agent\src` and puts the agent source on the embedded interpreter's `sys.path` whatever the working directory. Never edit `python311._pth` without understanding embedded-Python import resolution — breaking it kills every import.

---

## Inno Setup Script (`owlette_installer.iss`)

### Key Settings
- **AppId**: `{A7B8C9D0-E1F2-4A5B-8C9D-0E1F2A3B4C5D}` (identifies Owlette in registry)
- **Default install path**: `C:\ProgramData\Owlette` (via Inno Setup `{commonappdata}` constant)
- **Compression**: LZMA2 ultra64 (~50MB output)
- **Architecture**: x64 only
- **Privileges**: Admin required
- **Version**: Read from `OWLETTE_VERSION` environment variable (set by build script); the `.iss` fallback version is stale and only used when the variable is missing

### Installation Steps (in order)

**Before files are copied — `InitializeSetup`**: `net stop OwletteService` (synchronous) and a check that it reached Stopped; kill owlette-host/nssm, owlette-swoop, owlette-desktop and the install's python/pythonw (by path, then by module); stop and delete the legacy `R0python`/`R0pythonw` kernel services; poll up to 30s for `libcrypto-3.dll` to unlock. `[InstallDelete]` then wipes `{app}\python\Lib\site-packages`, the dead `gui.log`/`tray.log` files and retired shortcuts before the copy.

**Defender exclusion RETRACTION** (`[Run]`, logged to `logs\defender_setup.log`):
```powershell
# removes the 5 WinRing0-era entries (WinTmp path, python/pythonw process,
# python.sys/pythonw.sys paths) plus {app}\python\Lib\site-packages\LibreHardwareMonitor,
# {app}\python, {app}, C:\Owlette and C:\Owlette\python — active removal,
# because upgrades never run the old uninstaller
Remove-MpPreference -ExclusionPath '{app}\python\python.sys'   # ...and the others
```
**Why**: the temperature stack is LibreHardwareMonitor 0.9.6 (`HardwareMonitor` pip package) + the signed PawnIO driver. Nothing extracts a flagged `.sys` any more, so no exclusions are needed — but machines upgrading from <= 3.1.0 carry them and must have them retracted.

**Post-install — `CurStepChanged(ssPostInstall)`**, in order:
1. `EnsureWebView2Runtime` → `EnsurePawnIO` (installs `vendor\PawnIO_setup.exe -install -silent` when the registry `Uninstall\PawnIO\DisplayVersion` is absent or < 2.2.0 — the gate matters because 2.1.0 boot-loops Win10 1809/LTSC machines; exit 0/183/3010 all mean success; never fatal) → `HardenInstallTree` → swoop ACL
2. If `ShouldConfigureSite()` → `RunPairingHandoff()`:
   - silent install with no `/ADD=` → skips pairing, logs "installed unpaired"
   - interactive, no `/ADD=`, WebView2 and the desktop exe present → `owlette-desktop.exe --pair --server <dev|prod>` as the original user (no wait)
   - otherwise → `python.exe configure_site.py --server <dev|prod> [--add "<phrase>"]`
3. `install.bat --silent` — unconditional since 3.1.0, and it does not wait for the desktop app's pairing window

`ShouldConfigureSite()` is true when `/ADD=` was passed, config.json is missing or unreadable, it lacks a non-empty `site_id` with `"enabled": true`, or an explicit `/SERVER=` conflicts with the config's `environment` (or the environment can't be determined). Interactive mode alone does not trigger pairing. Flags tracked: `PairingSucceeded` (log only), `AppOpenedByHandoff`, `InstallSucceeded`, `ServiceWasStopped`.

### Upgrades

There is no config backup/restore. `[Files]` never touches `config\config.json` or `.tokens.enc`, so an upgrade leaves them in place; the `InitializeSetup` stop/kill/unlock sequence above is what makes overwriting the runtime safe.

### Uninstallation Steps (`[UninstallRun]`)
1. Kill the install's `owlette-desktop` (matched by path)
2. `owlette-host uninstall` (stops the service, waits for STOPPED so the agent
   can flush `online: false`, then deregisters it)
3. Roll back swoop's firewall group and `SoftwareSASGeneration`
4. Delete any legacy `R0python`/`R0pythonw` services and remove the legacy
   Windows Defender exclusions (machines that never took a PawnIO-era upgrade).
   PawnIO itself stays installed — shared component, like the WebView2 runtime.
5. Delete the runtime folders (`python`, `agent`, `app`, `tools`, `scripts`, `swoop`) plus swoop's logs/ipc leftovers, `README.md` and `LICENSE`
6. Prompt user about `C:\ProgramData\Owlette\` config/logs/tokens
   - Silent uninstall: always preserve (for upgrades)
   - Interactive: ask user

### Silent Install Parameters
```bash
# Production (default)
Owlette-Installer-vX.Y.Z.exe /SERVER=prod

# Development
Owlette-Installer-vX.Y.Z.exe /SERVER=dev

# Silent install that pairs (the only silent pairing path; phrase from the dashboard's "Generate Code")
Owlette-Installer-vX.Y.Z.exe /ADD=silver-compass-drift /SILENT

# Self-update (fully silent, keeps config, skips pairing on a paired machine)
Owlette-Installer-vX.Y.Z.exe /VERYSILENT /NORESTART /SUPPRESSMSGBOXES /ALLUSERS

# Custom program directory (the data root stays C:\ProgramData\Owlette)
Owlette-Installer-vX.Y.Z.exe /DIR="D:\CustomPath\Owlette"
```

---

## Device-Code Pairing (`configure_site.py`)

During installation (or from the desktop app) the agent pairs without a browser login on the machine:

```
1. AuthManager.request_device_code() → a 3-word phrase
2. An operator authorizes it at owlette.app/add (opened with the phrase pre-filled) or with the dashboard's "+" → "Enter Code"
3. AuthManager.poll_device_code() polls {api_base}/agent/auth/device-code/poll
4. Tokens are encrypted to C:\ProgramData\Owlette\.tokens.enc (NOT in config.json)
5. config.json gets firebase.enabled=true, site_id, project_id, api_base, plus a top-level "environment"
```

`configure_site.py --server dev|prod` picks the environment (otherwise the config's `environment`, defaulting to production); `--url` only overrides the API base and accepts just `https://owlette.app/api` or `https://dev.owlette.app/api`. Pairing logs to `logs\pairing_debug.log`.

**Environment values**:
- dev → project_id: `owlette-dev-3838a`, api_base: `https://dev.owlette.app/api`
- prod → project_id: `owlette-prod-90a12`, api_base: `https://owlette.app/api`

The old localhost:8765 browser-callback flow and its `POST /api/agent/auth/exchange` were replaced by device-code pairing in 2.4.1; the route and `AuthManager.exchange_registration_code` still exist but no current code path calls them.

---

## Service Configuration (`install.bat` → `owlette-host install`)

`install.bat` no longer configures anything itself: it calls
`tools\owlette-host.exe install`, and every property below is written by
`agent/host/src/registration.rs`. That is deliberate — the registration a
machine ends up with is a property of the shipped binary, not of whichever
batch file last ran.

### Service Properties
```
Service Name:    OwletteService
Display Name:    Owlette Service
Account:         LocalSystem (elevated privileges for process management)
Start Type:      SERVICE_AUTO_START, DelayedAutostart explicitly 0
Dependencies:    Tcpip, Dnscache, NlaSvc (waits for a real network stack)
ImagePath:       "C:\ProgramData\Owlette\tools\owlette-host.exe" run
Child:           C:\ProgramData\Owlette\python\python.exe
                 C:\ProgramData\Owlette\agent\src\owlette_runner.py
Working Dir:     C:\ProgramData\Owlette\agent\src (the child's cwd)
Console:         CREATE_NO_WINDOW on the child
Failure actions: restart after 5s, 5s, 60s; reset after 1 day;
                 also on non-crash failures
```

`owlette-host install` is also the migration: it stops and deletes any existing
registration (logging when the one it replaced was NSSM) before creating its
own. Nothing under `%ProgramData%\Owlette` is touched.

### Log Rotation
```
Stdout:          C:\ProgramData\Owlette\logs\service_stdout.log
Stderr:          C:\ProgramData\Owlette\logs\service_stderr.log
Host log:        C:\ProgramData\Owlette\logs\service_host.log
Rotate:          On size — 10MB per child stream, 2MB for the host log,
                 one sibling kept (`<name>.log.1`)
```

### Restart Behavior
| child exit | host response |
|---|---|
| 42 (restart flag) / 43 (self-restart watchdog) | relaunch immediately |
| 0 | stop the service — a clean exit is the agent saying it is done |
| anything else | relaunch after 5s; 5 crashes in 5 minutes → 60s, logged as a crash loop |

This is why `owlette_runner.py` uses `sys.exit(0)` for graceful shutdown and
`sys.exit(42)` for a self-restart.

### Stopping
The host reports `STOP_PENDING` to the SCM and waits up to 20s for the agent to
exit on its own. `owlette_service.start_scm_stop_watcher()` polls that state
every 250ms and runs `graceful_shutdown()` — flush `online: false`, log
`agent_stopped`, record a clean external stop. Only after the grace window does
the host terminate the child, and it terminates **only** the process it
launched: managed processes and the desktop app are never in scope.

---

## owlette_runner.py Bridge

**Why it exists**: the host runs a console application, so the service needs a
plain `__main__`. `owlette_runner.py` is it, and it owns the whole startup
sequence — `OwletteService` has no constructor of its own:

1. Building the instance with `object.__new__` and calling `_init_state()`,
   the single place service attributes are set
2. Wiring the health probe and the Firebase client onto it
3. Running `OwletteService.main()` as a regular Python process

**The stop path is critical**: the SCM stop watcher (started by the runner) is
what notices a stop. It must:
- Set `is_alive = False` to break the main loop
- Log `agent_stopped` event to Firestore
- Call `firebase_client.stop()` to mark machine offline
- Exit with code 0

---

## Self-Update Mechanism (`owlette_service.py` + `installer_utils.py`)

Triggered by the `update_owlette` command from the web dashboard; handled by `OwletteService._handle_update_owlette` → `_run_self_update` → `_start_windows_update`:

```
1. Refuse without the command's checksum_sha256; refuse while logs\update_in_progress.json
   (10 min guard) exists or with < 500 MB free
2. Download to %ProgramData%\Owlette\update-staging\owlette-Update.exe
   - 3 attempts, 5s then 10s apart
   - 30s connect / 600s read timeout
   - on Windows a locked target fails the attempt (strict_path)
3. Verify: ≥ 1 MB (MIN_ARTIFACT_BYTES), `MZ` header (verify_artifact_family), sha256 match;
   the file is held open via open_verified until it runs
4. Launch it as a SYSTEM scheduled task OwletteUpdate_<ts> (/RU SYSTEM /RL HIGHEST), so it
   outlives the service it is about to stop:
     owlette-Update.exe /VERYSILENT /NORESTART /SUPPRESSMSGBOXES /ALLUSERS /LOG="<data>\logs\installer_update.log"
   - `schtasks /Run` is fire-and-forget; there is no execution timeout
   - a paired machine's silent install skips pairing (ShouldConfigureSite returns false)
   - install.bat runs → owlette-host install → service starts
5. A second SYSTEM task, OwletteRecovery_<ts>, waits 300s and runs `net start OwletteService`
   if `sc query` does not show it RUNNING; a detached process deletes both tasks after 300s
```

**Safety**: If the update fails, the old installation is untouched and the service host restarts the agent from whatever is on disk.

---

## File System Layout After Installation

```
C:\ProgramData\Owlette\                  Installation + data directory
├── python\                              Embedded Python 3.11 runtime
├── agent\src\                           Python source code
├── agent\icons\                         Application icons
├── agent\VERSION                        Version file
├── app\owlette-desktop.exe              Tauri desktop app
├── swoop\owlette-swoop.exe              swoop streamer
├── tools\owlette-host.exe               Windows service host
├── scripts\                             Batch launchers
├── unins000.exe                         Inno Setup uninstaller
├── config\config.json                   Process + Firebase configuration
├── logs\                                All log files
│   ├── service.log                      Main service log (RotatingFileHandler)
│   ├── service_stdout.log               Agent stdout, captured by the host
│   ├── service_stderr.log               Agent stderr, captured by the host
│   ├── service_host.log                 The host itself: spawns, exits, stops
│   ├── pairing_debug.log                Device-code pairing
│   ├── cortex.log                       hoot runtime
│   ├── installer_update.log             Self-update (Inno /LOG)
│   └── defender_setup.log               Defender exclusion retraction
├── cache\firebase_cache.json            Offline Firestore config cache
├── ipc\                                 session_exec jobs/results
├── update-staging\                      Self-update download
├── tmp\service_status.json              IPC status file (service → desktop app tray)
└── .tokens.enc                          Encrypted OAuth tokens (hidden file)

Start Menu\Programs\Owlette\             Shortcuts
├── Owlette                              → app\owlette-desktop.exe (opens the window)   [AppUserModelID]
├── View Logs                            → C:\ProgramData\Owlette\logs\
├── Edit Configuration                   → config.json
└── Uninstall Owlette

Startup\                                 Auto-start on login
└── Owlette                              → app\owlette-desktop.exe --tray   [AppUserModelID]
```

The `AppUserModelID` (`app.owlette.desktop`) on those two shortcuts is
load-bearing, not cosmetic: Windows silently discards toasts from an unpackaged
app that no Start-menu shortcut registers an id for, and the notification call
still returns success.

**Exactly two shortcuts carry it, and both are named "Owlette".** Windows draws
a toast's attribution line from the *name* of a registered shortcut, and with
several carrying the same id it does not specify which one it picks — a third
registrar made toasts read "Owlette Configuration" in 3.0.0 testing, so that
shortcut is retired (`[InstallDelete]` removes it on upgrade), and the startup
shortcut is `Owlette.lnk`, not the `Owlette Tray.lnk` it was called through 2.x.

The desktop app's own "start on login" toggle writes and deletes that same
startup shortcut with the same id (`desktop/src-tauri/src/startup_link.rs`), so
setup recreating it on every upgrade is what repairs a 2.x machine's shortcut —
and also what re-enables the toggle for anyone who turned it off. The old
`Owlette Tray.lnk` name is removed by both `[InstallDelete]` and the toggle.

---

## Version Propagation

```
agent/VERSION (single source of truth)
    ↓ build_installer_full.bat reads it
    ↓ Sets OWLETTE_VERSION environment variable
    ↓ Copies to build/installer_package/agent/VERSION
    ↓ Inno Setup reads OWLETTE_VERSION → installer filename
    ↓
Owlette-Installer-v{VERSION}.exe
    ↓ Installs to C:\ProgramData\Owlette\agent\VERSION
    ↓
Service reads at runtime: shared_utils.get_app_version()
    → Reported in: the device-code request, the User-Agent and X-Owlette-Agent-Version
      headers, and Firestore agent_version / agentVersion
```

The desktop app carries its own copy from `tauri.conf.json` / `Cargo.toml`, which `sync-versions.js` keeps in step.

**To bump version**: `node scripts/sync-versions.js X.Y.Z` (every version file — see the build-system skill)

---

## Common Build Issues

**"Inno Setup not found"**: Install Inno Setup 6 from jrsoftware.org, or point `%ISCC%` at it. Without it the build assembles the package and then exits 1 at step 9.

**Quick build fails**: Run full build first to create the Python runtime and dependencies.

**Silent install leaves the machine unpaired**: expected without `/ADD=<phrase>` — setup logs "installed unpaired". Pass `/ADD=` or pair from the desktop app.

**Service won't start after update**: Check `C:\ProgramData\Owlette\logs\service_stderr.log` for Python import errors. May need a full rebuild if dependencies changed.

**"cargo not found on PATH"** (step 6, the desktop build, is the first to need it): install the Rust toolchain with rustup; the build script prepends `%USERPROFILE%\.cargo\bin` itself, so cargo does not have to be on the system PATH. There is no download step and no fallback binary to seed — since 3.0.0 the build depends on nobody else's host being up for this.
