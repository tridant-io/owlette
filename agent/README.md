# Owlette Agent - Windows Service

The Owlette Agent is a Python-based Windows service that monitors and manages processes, with cloud integration via Firebase.

## Features

- **Process Monitoring**: Automatically restart crashed or frozen applications
- **Firebase Integration**: Real-time cloud communication and remote control
- **Offline Resilient**: Continues operating from cached config when offline
- **System Metrics**: Reports CPU, memory, disk, and GPU usage to cloud
- **Remote Commands**: Restart/kill processes from web dashboard
- **Remote Screenshots**: Capture and send screenshots to the dashboard
- **MCP Tools**: Tool-calling support for the Cortex AI assistant
- **Self-Update**: Update the agent remotely from the web dashboard
- **Device-Code Pairing**: Secure token-based auth with a 3-word pairing phrase

---

## Quick Start

### Prerequisites

- Windows 10/11 or Windows Server
- Python 3.11 (the packaged installer bundles the 3.11.8 embedded runtime)
- WebView2 runtime for the desktop app (present on Windows 11; the installer
  adds it on the LTSC/IoT images that lack it)
- Firebase project with Firestore enabled

### Installation

1. **Run the installer** (recommended):

   Download the installer from the Owlette web dashboard. It handles everything:
   - Installs embedded Python runtime and all dependencies
   - Runs device-code pairing with a 3-word phrase
   - Registers the agent with your site
   - Installs and starts the Windows service

   See [INSTALLER-USAGE.md](INSTALLER-USAGE.md) for the full device-code pairing documentation.

2. **Configure processes** (optional):
   - Use the desktop app (Start menu → "Owlette Configuration", or the tray icon)
   - Or manage from the web dashboard

3. **Connect to Owlette Dashboard**:
   - The installer opens the Owlette window on **join a site**, showing a 3-word pairing phrase and the authorization link for the server you installed against
   - Authorize with that window's own button, or enter the phrase from a phone or another device
   - Select a site and authorize; the agent polls until tokens are returned

---

## Configuration

### config/config.json

```json
{
  "version": "2.2.0",
  "processes": [
    {
      "id": "unique-id-here",
      "name": "My Application",
      "exe_path": "C:\\Path\\To\\Application.exe",
      "file_path": "C:\\Path\\To\\file.toe",
      "cwd": "C:\\Working\\Directory",
      "time_delay": 0,
      "time_to_init": 10,
      "relaunch_attempts": 3,
      "autolaunch": true,
      "visibility": "Show",
      "priority": "Normal"
    }
  ],
  "firebase": {
    "enabled": true,
    "site_id": "your-site-id"
  }
}
```

### Process Settings

| Setting | Description | Values |
|---------|-------------|--------|
| `name` | Display name for the process | Any string |
| `exe_path` | Full path to executable | `C:\Path\To\app.exe` |
| `file_path` | File to open or command-line args | `C:\file.ext` or `--args` |
| `cwd` | Working directory | `C:\Working\Dir` |
| `time_delay` | Delay before launch (seconds) | `0`, `5`, `10`, etc. |
| `time_to_init` | Time to initialize before checking responsiveness | `10`, `30`, `60`, etc. |
| `relaunch_attempts` | Max restart attempts before system reboot | `3`, `5`, `10`, etc. |
| `autolaunch` | Auto-start on service start | `true` or `false` |
| `visibility` | Window visibility | `"Show"` or `"Hide"` |
| `priority` | Process priority | `"Low"`, `"Normal"`, `"High"`, `"Realtime"` |
| `check_responsive` | Enable "not responding" detection | `true` (default) or `false` |

### Firebase Settings

| Setting | Description |
|---------|-------------|
| `enabled` | Enable Firebase cloud features |
| `site_id` | Unique identifier for this site/location |

**Authentication:** Modern installations use device-code pairing (no manual credentials needed). Tokens are stored encrypted at `C:\ProgramData\Owlette\.tokens.enc`. See [INSTALLER-USAGE.md](INSTALLER-USAGE.md) for the pairing flow details.

---

## Manual Installation Steps

If the installer doesn't work, follow these manual steps:

1. **Install Python 3.11**
   ```cmd
   # Download from python.org and install
   ```

2. **Install dependencies**
   ```cmd
   cd agent
   pip install -r requirements.txt
   ```

3. **Create folders**
   ```cmd
   mkdir config
   mkdir logs
   mkdir tmp
   ```

4. **Create config file**
   ```cmd
   copy config.template.json config\config.json
   ```

5. **Connect to Owlette Dashboard** (optional but recommended)
   - Use the device-code pairing installer from the web dashboard (recommended)
   - Or for manual/development setups, run `python src\configure_site.py`

6. **Install service** (elevated)
   ```cmd
   scripts\install.bat
   ```
   The service is hosted by `tools\owlette-host.exe`, which `install.bat`
   registers, configures and starts. `owlette_service.py` no longer accepts
   service verbs — the pywin32 service framework is gone.

---

## Development

### Running Without Installing Service

For development/testing:

```cmd
cd agent/src
python owlette_runner.py --debug
```

**Note:** Requires administrator privileges to access Windows service APIs.

### Version Management

**Single Source of Truth: `agent/VERSION` file**

To bump the version across all components:

```bash
node scripts/sync-versions.js 2.3.0
```

The version automatically propagates to:
- The desktop app's status footer (reads the installed `agent/VERSION`)
- Firestore agent registration (`firebase_client.py`)
- Device-code registration (`auth_manager.py`)
- Installer filename (`Owlette-Installer-v2.2.0.exe`)

**How it works:**
- `shared_utils.py` reads `VERSION` file at runtime
- Build script reads `VERSION` and passes to Inno Setup compiler
- All code imports version from `shared_utils.APP_VERSION`

### Building the Installer

You have two options for building the installer:

#### Option 1: Full Build (First Time / Clean Build)

```cmd
cd agent
build_installer_full.bat
```

**What it does:**
- Downloads Python 3.11 embedded (~25 MB)
- Installs all dependencies
- Copies source files
- Builds the `owlette-host` service host (Rust)
- Compiles installer with Inno Setup

**Time:** ~5-10 minutes
**When to use:** First build, after dependency changes, or for clean builds

#### Option 2: Quick Build (Development Iteration)

```cmd
cd agent
build_installer_quick.bat
```

**What it does:**
- Validates VERSION file
- Copies updated source files only
- Runs Inno Setup compiler

**Time:** ~30 seconds
**When to use:** After code changes (Python files, scripts, icons)

**Prerequisites:** Must run full build at least once to set up build/ directory

**Output:** Both scripts produce `build\installer_output\Owlette-Installer-v{VERSION}.exe`

---

## Service Management

The service is hosted by `owlette-host.exe` (source in [`host/`](host/)), which
replaced NSSM in 3.0.0. It launches `python.exe agent\src\owlette_runner.py`,
restarts it when it exits 42/43 or crashes, and stops it by reporting
STOP_PENDING and waiting — it never kills the child's process tree, so managed
processes and the desktop app survive a service restart.

### Start/Stop/Restart

```cmd
net start OwletteService
net stop OwletteService
net start OwletteService  # Restart
```

or, equivalently, through the host (waits for the state, and reports it):

```cmd
tools\owlette-host.exe start
tools\owlette-host.exe stop
```

### Check Status

```cmd
sc query OwletteService
tools\owlette-host.exe status
```

`status` also prints the registered image, which is how you confirm a machine has
migrated off NSSM. Exit code: 0 running, 3 installed but stopped, 4 not
installed.

### View Logs

```cmd
type logs\service.log         :: the agent
type logs\service_host.log    :: the host: spawns, exit codes, stops, backoff
type logs\service_stderr.log  :: whatever the agent printed before it died
```

### Uninstall

```cmd
scripts\uninstall.bat
```

Or manually (elevated):
```cmd
tools\owlette-host.exe uninstall
```

---

## Troubleshooting

### Service won't start

1. **Check logs**: `logs/service.log`
2. **Verify Python**: `python --version` should be 3.11
3. **Check permissions**: Service needs admin rights
4. **Check pairing tokens**: Ensure agent completed device-code pairing

### Processes won't launch

1. **Check paths**: Ensure `exe_path` and `file_path` are correct
2. **Check permissions**: Service runs as SYSTEM but launches as logged-in user
3. **Check logs**: Look for errors in `logs/service.log`
4. **Increase `time_to_init`**: Some apps need more time to start

### Dashboard not connecting

1. **Check authentication**: Ensure device-code pairing completed successfully
2. **Check tokens**: Tokens stored encrypted at `C:\ProgramData\Owlette\.tokens.enc` (use `auth_manager.py` to verify)
3. **Check internet**: Service needs internet to connect to dashboard
4. **Check config**: Ensure `firebase.enabled` is `true` in `config/config.json`
5. **Check logs**: Look for authentication errors in `logs/service.log`
6. **Offline mode**: Service will continue with cached config if dashboard unavailable
7. **Re-authenticate**: Run installer again or run `configure_site.py` to re-pair if tokens were revoked

### "Access Denied" errors

- Service commands require administrator privileges
- Right-click Command Prompt -> "Run as administrator"

---

## File Structure

```
agent/
├── src/                           # Python source code
│   ├── owlette_service.py         # Main Windows service
│   ├── owlette_runner.py          # Process lifecycle management
│   ├── owlette_scout.py           # System metrics collector
│   ├── firebase_client.py         # Firebase integration & sync
│   ├── firestore_rest_client.py   # Firestore REST API client
│   ├── connection_manager.py      # Connection state machine & reconnect
│   ├── auth_manager.py            # Token exchange and refresh
│   ├── secure_storage.py          # Encrypted credential storage
│   ├── shared_utils.py            # Shared utilities & constants
│   ├── process_launcher.py        # Process start/stop logic
│   ├── session_exec.py            # User-session process execution
│   ├── health_probe.py            # Health check endpoint
│   ├── mcp_tools.py               # Cortex AI tool implementations
│   ├── configure_site.py          # Site join/leave device-code pairing flow
│   ├── installer_utils.py         # Remote deployment handler
│   ├── command_router.py          # Command dispatch (fast lane / slow worker)
│   ├── sync_commands.py           # roost handlers: sync_pull, cancel_sync, rollback
│   ├── sync_version.py            # roost version fetch, validation, diff
│   ├── sync_downloader.py         # roost chunk download + SHA-256 verification
│   ├── sync_assembler.py          # roost atomic file assembly + ACL hardening
│   ├── sync_state.py              # roost sqlite state (resume, pinning)
│   ├── sync_scrub.py              # roost content-store cleanup
│   ├── destination_allowlist.py   # roost write-destination gate (fail-closed)
│   ├── roost_kill_switch.py       # roost per-site emergency stop
│   └── registry_utils.py          # Windows registry operations
├── tests/                         # pytest tests
├── config/                        # Configuration (gitignored)
│   └── config.json                # Main config
├── logs/                          # Log files (gitignored)
│   └── service.log
├── tmp/                           # Temporary files (gitignored)
├── scripts/                       # Packaged service install/uninstall scripts
├── build_installer_full.bat       # Full build script
├── build_installer_quick.bat      # Quick build script
├── owlette_installer.iss          # Inno Setup script
├── requirements.txt               # Python dependencies
├── config.template.json           # Config template
├── VERSION                        # Agent version file
└── README.md                      # This file
```

---

## Developer Documentation

### Building the Installer

See [BUILD.md](BUILD.md) for comprehensive instructions on building the installer:

- **Full Build**: Complete rebuild with embedded Python (~5-10 min)
- **Quick Build**: Fast iteration during development (~30 sec)
- Testing procedures and troubleshooting

### End-User Documentation

- **[INSTALLER-USAGE.md](INSTALLER-USAGE.md)** - Installation guide for end users
  - Environment selection (dev/prod)
  - Device-code pairing flow
  - Silent installation
  - Troubleshooting

---

## Support

- **Documentation**: See [docs/](../docs/) folder
- **Issues**: https://github.com/tridant-io/owlette/issues
- **Firebase Setup**: [docs/setup/firebase.md](../docs/setup/firebase.md)

---

## License

See [LICENSE](../LICENSE) in the root directory.
