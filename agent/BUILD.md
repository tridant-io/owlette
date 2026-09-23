# Building the Owlette Installer

This guide explains how to build the Owlette installer executable for distribution. Releasing a build (security gate, version bump, changelog, upload) is covered in [docs/runbooks/agent-installer-release.md](../docs/runbooks/agent-installer-release.md).

## Prerequisites

- **Windows** (required for building the Windows installer)
- **Node.js 22 + npm** — the full build compiles the desktop app in `desktop/`
- **Rust toolchain** (rustup) and **MSVC C++ build tools** — for the desktop app and the `owlette-host` service host. The build prepends `%USERPROFILE%\.cargo\bin` to PATH itself
- **Inno Setup 6** — found through `%ISCC%`, then `iscc` on PATH, then `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`

No system Python is needed: the build downloads and checksum-verifies its own embedded Python 3.11.8. `scripts/bootstrap-windows.ps1` checks all of the above.

## Build Methods

### Method 1: Full Build from Scratch (Recommended for releases)

This method creates a fresh embedded Python environment and builds everything from scratch.

**When to use:**
- Building a release version
- After Python dependency changes
- After desktop app changes
- First time building

**Command (cmd, from `agent/`):**
```bat
build_installer_full.bat
```

The script ends with `pause`, and pauses on every error. From a non-interactive shell, redirect stdin so it cannot hang:
```powershell
cmd /c "<repo>\agent\build_installer_full.bat < NUL > %TEMP%\installer-build.log 2>&1"
```

**What it does:**
0. Reads the version from `VERSION`
1. Cleans `build/` (the `downloads/` cache is kept)
2. Downloads Python 3.11.8 embedded and verifies its SHA-256
3. Configures the embedded Python's import paths
4. Installs pip
5. Installs `requirements.txt` into the embedded Python
6. Builds the desktop app (`npx tauri build --no-bundle` in `desktop/`)
7. Builds the service host (`cargo build --release` in `agent/host`)
8. Stages the installer package in `build/installer_package/`
9. Compiles the Inno Setup installer from `owlette_installer.iss`

**Output:**
- `build/installer_output/Owlette-Installer-v{VERSION}.exe`

**Duration:** ~5-10 minutes (longer on a cold cargo cache)

### Method 2: Quick Rebuild (Fast iteration during development)

This method updates the agent source in an existing package and recompiles the installer, skipping the Python environment setup.

**When to use:**
- During active development
- After editing `.py` files in `src/`
- When you haven't changed dependencies

**Command (cmd, from `agent/`):**
```bat
build_installer_quick.bat
```

**What it does:**
1. Reads the version from `VERSION`
2. Checks that a previous full build exists
3. Copies the agent source, scripts, and icons into `build/installer_package/`; re-copies the desktop app if it has been rebuilt, and rebuilds the service host
4. Recompiles the Inno Setup installer

**Output:**
- `build/installer_output/Owlette-Installer-v{VERSION}.exe` (updated)

**Duration:** ~30 seconds

**Important:**
- Requires a previous full build (Method 1) to exist in `build/`
- Does not update Python dependencies or the Python runtime
- Does not compile the desktop app — run `npx tauri build --no-bundle` in `desktop/` first if it changed
- If you get errors, do a full rebuild with Method 1

## Build Output Structure

After a full build, you'll have:

```
agent/
├── build/
│   ├── installer_package/           # Staging directory for installer
│   │   ├── python/                   # Embedded Python 3.11 runtime + dependencies
│   │   ├── agent/
│   │   │   ├── src/                  # Agent Python source code
│   │   │   └── icons/                # Application icons
│   │   ├── app/
│   │   │   └── owlette-desktop.exe   # Desktop app (tray + window)
│   │   ├── tools/
│   │   │   └── owlette-host.exe      # Windows service host
│   │   └── scripts/                  # install.bat / uninstall.bat
│   │
│   └── installer_output/
│       └── Owlette-Installer-v{VERSION}.exe  # Final installer executable
│
├── downloads/                        # Download cache (kept between builds)
├── owlette_installer.iss             # Inno Setup script
├── build_installer_full.bat          # Full build script (~5-10 min)
└── build_installer_quick.bat         # Quick build script (~30 sec)
```

The installer lays this down under `C:\ProgramData\Owlette\`.

## Testing the Installer

### Test with Development Environment

```bat
cd build\installer_output
Owlette-Installer-v{VERSION}.exe /SERVER=dev
```

This will:
1. Hand pairing to the Owlette window with `--server dev`, showing a phrase and a `dev.owlette.app/add` link
2. Complete device-code pairing from that window or any other device
3. Install service connected to dev environment
4. Machine appears in dev dashboard

### Test with Production Environment

`/SERVER=prod` is the default when `/SERVER` is omitted.

```bat
Owlette-Installer-v{VERSION}.exe /SERVER=prod
```

This will:
1. Hand pairing to the Owlette window with `--server prod`, showing a phrase and an `owlette.app/add` link
2. Complete device-code pairing from that window or any other device
3. Install service connected to production environment
4. Machine appears in production dashboard

### Verify Installation

After installation completes:

```powershell
# Check service status
Get-Service OwletteService

# Check logs (should show successful authentication)
Get-Content C:\ProgramData\Owlette\logs\service.log -Tail 50

# Verify the pairing token store exists
Test-Path C:\ProgramData\Owlette\.tokens.enc  # Should be True

# Check config has Firebase settings
Get-Content C:\ProgramData\Owlette\config\config.json | Select-String "enabled|project_id|api_base"
```

**Expected results:**
- Service status: Running
- Logs show: "Agent authenticated - OAuth tokens found"
- Logs show: "Initial heartbeat sent - machine is now online"
- No 401 Unauthorized errors
- Machine appears online in web dashboard

## Common Issues

### Issue: "Permission denied" when copying files

**Solution:** Make sure no Owlette service or installer is running:
```bat
net stop OwletteService
```
and close any running `Owlette-Installer-v*.exe` window.

### Issue: "File is being used by another process" during Inno Setup compilation

**Solution:** Close any running installers or processes locking the output directory:
```bat
taskkill /F /IM ISCC.exe
```

### Issue: Python dependencies missing in installer

**Solution:** Do a full rebuild (Method 1). It cleans `build/` itself before reinstalling dependencies.

### Issue: Changes not reflected in installed service

**Solution:** The quick build copies from `src/`, so confirm the staged copy is current before recompiling:
```bat
dir build\installer_package\agent\src\your_file.py
```

## Version Updates

The version is read from `VERSION` at build time and passed to Inno Setup, which names the output file and writes the registry version. Do not edit version strings by hand:

1. Add the `[X.Y.Z]` release entry to both `docs/changelog.md` and `web/content/docs/changelog.mdx`
2. Run `node scripts/sync-versions.js X.Y.Z` from the repo root — it updates every version file, including the desktop and host crates
3. Commit, then do a full rebuild (Method 1)

The ordering rules are in [docs/internal/version-management.md](../docs/internal/version-management.md) and the release runbook.

## CI/CD Integration

`.github/workflows/build-installer.yml` runs the full build on a Windows runner for tag pushes matching `vX.Y.Z` and on manual dispatch. It uploads the installer as an artifact, generates SLSA provenance, and on tags attaches both to the GitHub Release. It does not upload the installer to Owlette — rolling it out still uses the 3-step API upload in the release runbook.

## Cleaning Build Artifacts

The full build deletes and recreates `build/` on every run, so there is no separate clean step. `downloads/` is a cache of the Python embed and `get-pip.py`; it only needs clearing if the pinned Python version changes.

## Additional Resources

- [Inno Setup Documentation](https://jrsoftware.org/ishelp/)
- [Service host source](host/) - `owlette-host`, the supervisor that replaced NSSM in 3.0.0
- [Installer Usage Guide](INSTALLER-USAGE.md) - For end users
- [Authentication reference](../web/content/docs/reference/authentication.mdx) - device-code pairing and the token lifecycle
- [Agent installer release runbook](../docs/runbooks/agent-installer-release.md) - build, upload, and rollout
