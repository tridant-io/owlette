# Owlette Installer & Build System Reference

**Last Updated**: 2026-03-12
**Applies To**: `agent/` build pipeline, Inno Setup installer, the owlette-host service host

This document covers the complete build-to-installation pipeline. Read this before modifying any build scripts, the Inno Setup script, or the installation/update flow.

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
| **Compiles installer** | Yes (if Inno Setup found) | Yes (requires Inno Setup) |
| **When to use** | First build, dependency changes | Source code changes only |

**Prerequisite**: Inno Setup 6 at `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`

---

## Full Build Steps (`build_installer_full.bat`)

```
[0/9] Read VERSION file (single source of truth)
[1/9] Clean build/ directory
[2/9] Download Python 3.11.8 embedded (python.org → build/python-embed.zip)
[3/9] Configure python311._pth (import paths for embedded runtime)
[4/9] Bootstrap pip (get-pip.py)
[5/9] Install requirements.txt (the slow step) + delete the SDK's bundled claude.exe (242MB)
[6/9] Build the desktop app (npx tauri build --no-bundle → owlette-desktop.exe)
[7/9] Build the service host (cargo build --release in agent/host → owlette-host.exe)
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
│   └── VERSION          Version file
├── app/
│   └── owlette-desktop.exe  Tauri desktop app — tray, config window, reboot prompt
├── tools/
│   └── owlette-host.exe Windows service host (built from agent/host)
└── scripts/
    ├── install.bat      Service installation
    └── uninstall.bat    Service removal
```

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

**Important**: `..\agent\src` on that path is what lets `{app}\app\owlette-desktop.exe`'s sibling python scripts import each other from any working directory. Never edit `python311._pth` without understanding embedded-Python import resolution — breaking it kills every import.

---

## Inno Setup Script (`owlette_installer.iss`)

### Key Settings
- **AppId**: `{A7B8C9D0-E1F2-4A5B-8C9D-0E1F2A3B4C5D}` (identifies Owlette in registry)
- **Default install path**: `C:\ProgramData\Owlette` (via Inno Setup `{commonappdata}` constant)
- **Compression**: LZMA2 ultra64 (~50MB output)
- **Architecture**: x64 only
- **Privileges**: Admin required
- **Version**: Read from `OWLETTE_VERSION` environment variable (set by build script)

### Installation Steps (in order)

**Step 0 — Defender exclusion RETRACTION + PawnIO driver**:
```powershell
# [Run] retracts the five exclusions pre-PawnIO versions added (WinTmp path,
# python/pythonw process, python.sys/pythonw.sys paths) — active removal,
# because upgrades never run the old uninstaller
Remove-MpPreference -ExclusionPath '{app}\python\python.sys'   # ...and the other four
```
**Why**: the temperature stack is LibreHardwareMonitor 0.9.6 (`HardwareMonitor` pip package) + the signed PawnIO driver. Nothing extracts a flagged `.sys` any more, so no exclusions are needed — but machines upgrading from <= 3.1.0 carry them and must have them retracted. `EnsurePawnIO()` in `[Code]` installs `vendor\PawnIO_setup.exe` (`-install -silent`) when the registry `Uninstall\PawnIO\DisplayVersion` is absent or < 2.2.0 — the gate matters because 2.1.0 boot-loops Win10 1809/LTSC machines. Exit 0/183/3010 all mean success; never fatal. `InitializeSetup` also stops+deletes the legacy `R0python`/`R0pythonw` kernel services, and `[InstallDelete]` prunes `python.sys`/`pythonw.sys` and the `WinTmp` package (pythonnet/clr_loader/wmi stay — the new stack needs them).

**Step 1 — OAuth Configuration** (conditional):
```
python.exe configure_site.py --url "https://owlette.app/setup"
```
- **Runs if**: Fresh install OR interactive mode
- **Skipped if**: Silent mode + config already exists (self-update scenario)
- Controlled by `ShouldConfigureSite()` function
- Tracked by `DidRunOAuth` flag (affects config restore logic)

**Step 2 — Service Installation**:
```
install.bat --silent
```
- Runs AFTER OAuth completes (sequential, not parallel)

### Config Backup/Restore Logic

During upgrades, config.json must survive reinstallation:

1. `BackupConfigIfExists()` — copies config to `%TEMP%\config.json.backup` before install
2. Files are overwritten during installation
3. `RestoreConfigIfBackedUp()` — restores config UNLESS:
   - `DidRunOAuth == True` → preserve fresh OAuth config (CRITICAL: never overwrite new auth)
   - `WizardSilent() == True` → skip restore, service syncs from Firestore automatically

### Uninstallation Steps
1. `owlette-host uninstall` (stops the service, waits for STOPPED so the agent
   can flush `online: false`, then deregisters it)
2. Delete any legacy `R0python`/`R0pythonw` services and remove the legacy
   Windows Defender exclusions (machines that never took a PawnIO-era upgrade).
   PawnIO itself stays installed — shared component, like the WebView2 runtime.
3. Delete installation directory
4. Prompt user about `C:\ProgramData\Owlette\` config/logs/tokens
   - Silent uninstall: always preserve (for upgrades)
   - Interactive: ask user

### Silent Install Parameters
```bash
# Production (default)
Owlette-Installer-v2.0.54.exe /SERVER=prod

# Development
Owlette-Installer-v2.0.54.exe /SERVER=dev

# Self-update (fully silent, preserves config, skips OAuth)
Owlette-Installer-v2.0.54.exe /VERYSILENT /NORESTART /SUPPRESSMSGBOXES /ALLUSERS

# Custom directory
Owlette-Installer-v2.0.54.exe /DIR="D:\CustomPath\Owlette"
```

---

## OAuth Registration Flow (`configure_site.py`)

During installation, the agent authenticates via browser-based OAuth:

```
1. configure_site.py starts HTTP server on localhost:8765
2. Opens browser to https://owlette.app/setup (or dev.owlette.app)
3. User logs in and selects/creates a site
4. Web backend generates single-use registration code (24h expiry)
5. Browser redirects to http://localhost:8765/callback?site_id={id}&token={code}
6. configure_site.py calls AuthManager.exchange_registration_code()
   → POST /api/agent/auth/exchange with {registrationCode, machineId, version}
   → Receives: {accessToken, refreshToken, expiresIn, siteId}
7. Tokens encrypted to C:\ProgramData\Owlette\.tokens.enc (NOT in config.json)
8. config.json updated with firebase.enabled=true, site_id, project_id, api_base
9. Returns styled HTML success page to browser
```

**Environment detection**:
- URL contains `dev.owlette.app` → project_id: `owlette-dev-3838a`, api_base: `https://dev.owlette.app/api`
- Otherwise (production) → project_id: `owlette-prod-90a12`, api_base: `https://owlette.app/api`

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

## Self-Update Mechanism (`owlette_updater.py`)

Triggered by `update_owlette` command from web dashboard:

```
1. Verify admin privileges
2. Launch the installer as a SYSTEM scheduled task, so it outlives the service
   it is about to stop
3. Download installer from URL
   - 3 retries with exponential backoff (5s, 10s, 20s)
   - 5-minute timeout per attempt
   - Validates file size > 1KB
   - Handles locked files (generates unique timestamped filename)
4. Execute: Owlette-Update.exe /VERYSILENT /NORESTART /SUPPRESSMSGBOXES /ALLUSERS
   - 5-minute execution timeout
   - Silent mode skips OAuth (ShouldConfigureSite returns false)
   - install.bat runs → stops old service → installs new → starts
5. Cleanup temporary installer file
6. Verify service started (a SYSTEM recovery task checks after 5 min and runs `net start` if it is not)
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
├── tools\owlette-host.exe               Windows service host
├── scripts\                             Batch launchers
├── unins000.exe                         Inno Setup uninstaller
├── config\                              Runtime configuration
├── logs\                                Service logs (rotating)
├── cache\                               Cached data
└── tmp\                                 Temporary files
├── config\config.json                   Process + Firebase configuration
├── logs\                                All log files
│   ├── service.log                      Main service log (RotatingFileHandler)
│   ├── service_stdout.log               Agent stdout, captured by the host
│   ├── service_stderr.log               Agent stderr, captured by the host
│   ├── service_host.log                 The host itself: spawns, exits, stops
│   ├── tray.log / gui.log               Legacy python UI logs (pre-3.0.0; the desktop app writes neither)
│   ├── oauth_debug.log                  OAuth flow debug
│   └── owlette_updater.log              Update process log
├── cache\firebase_cache.json            Offline Firestore config cache
├── tmp\service_status.json              IPC status file (service → tray)
└── .tokens.enc                          Encrypted OAuth tokens (hidden file)

Start Menu\Programs\Owlette\             Shortcuts
├── Owlette Configuration                → app\owlette-desktop.exe
├── Owlette                              → app\owlette-desktop.exe --tray   [AppUserModelID]
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
several carrying the same id it does not specify which one it picks — so
"Owlette Configuration" deliberately has no id (a third registrar made toasts
read "Owlette Configuration" in 3.0.0 testing), and the startup shortcut is
`Owlette.lnk`, not the `Owlette Tray.lnk` it was called through 2.x.

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
    → Displayed in: tray icon, GUI, Firestore registration, OAuth device info
```

**To bump version**: `node scripts/sync-versions.js 2.1.0` (updates agent/VERSION + web/package.json + /VERSION)

---

## Common Build Issues

**"Python 3.11 not found"**: Tkinter copy requires system Python 3.11 at `C:\Program Files\Python311`. Install it or the GUI won't work.

**"Inno Setup not found"**: Install Inno Setup 6 from jrsoftware.org. Build script still creates the package directory without it.

**Quick build fails**: Run full build first to create the Python runtime and dependencies.

**Installer hangs during silent update**: Usually means `ShouldConfigureSite()` returned true unexpectedly. Check that config.json exists at `C:\ProgramData\Owlette\config\config.json`.

**Service won't start after update**: Check `C:\ProgramData\Owlette\logs\service_stderr.log` for Python import errors. May need a full rebuild if dependencies changed.

**"cargo not found on PATH"** (step 7): the service host is built from source in `agent/host`. Install the Rust toolchain with rustup; the build script prepends `%USERPROFILE%\.cargo\bin` itself, so cargo does not have to be on the system PATH. There is no download step and no fallback binary to seed — since 3.0.0 the build depends on nobody else's host being up for this.
