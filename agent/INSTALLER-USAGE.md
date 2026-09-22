# Owlette Installer Usage Guide

## Basic Installation

Double-click the installer and follow the prompts:

```bash
Owlette-Installer-v<version>.exe
```

This will install Owlette configured for the **production environment** (owlette.app) by default. Pass `/SERVER=dev` to target the development environment instead.

## Environment Selection

### Command-Line Flags

The installer supports switching between development and production environments using the `/SERVER` flag:

#### Production Environment (Default)
```bash
Owlette-Installer-v<version>.exe /SERVER=prod
```
- Connects to: `https://owlette.app`
- Use for production deployments
- This is the default when `/SERVER` is omitted

#### Development Environment
```bash
Owlette-Installer-v<version>.exe /SERVER=dev
```
- Connects to: `https://dev.owlette.app`
- Use for testing, development, and staging

### How It Works

1. The `/SERVER` parameter is passed to the Inno Setup installer, which normalizes it to `dev` or `prod`; anything else is treated as `prod`
2. That token is passed straight through as `--server dev` or `--server prod`. No URL is passed at all — the agent resolves the API base and the Firebase project for that environment itself (`shared_utils.get_api_base_url` / `get_project_id`)
3. On an interactive install the installer hands pairing to the desktop app (`owlette-desktop.exe --pair --server ...`), which opens the **join a site** dialog with the pairing phrase, the authorization link for that server, and an environment badge on anything other than production
4. `configure_site.py` runs on the console instead when `/ADD=` is supplied, or when the machine has no WebView2 runtime for the desktop app to render in
5. Either way the agent starts polling immediately, and nothing on the target machine opens a browser on its own — authorize from the pairing dialog's button, or from any other device

## Silent Installation

For automated deployments, combine with standard Inno Setup silent flags:

```bash
# Silent install for development with a preauthorized phrase
Owlette-Installer-v<version>.exe /SILENT /SERVER=dev /ADD=silver-compass-drift

# Silent install for production with a preauthorized phrase
Owlette-Installer-v<version>.exe /SILENT /SERVER=prod /ADD=silver-compass-drift

# Very silent (no progress window)
Owlette-Installer-v<version>.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SERVER=prod /ADD=silver-compass-drift
```

**Note:** For unattended installs, pass `/ADD=<phrase>` with a preauthorized pairing phrase from the dashboard. A silent install without `/ADD=` skips pairing entirely — nobody can read a pairing phrase on that path — and installs the machine unpaired. The service is still registered and started; pair it later from the desktop app or `configure_site.py`.

## Installation Process

1. **Administrator Privileges Check**
   - Installer verifies admin rights (required for Windows service installation)

2. **Existing Installation Cleanup**
   - Stops any running Owlette processes
   - Prepares for service installation

3. **File Extraction**
   - Copies Python runtime, Owlette Agent code, tools, and configurations to `C:\ProgramData\Owlette`

4. **Service Installation**
   - Registers Owlette as a Windows service hosted by `owlette-host.exe`
   - Configures service to start automatically
   - Starts the service
   - **Unconditional** — pairing no longer gates it. A machine that never completes pairing still ends up with a registered, running service; it simply has no site to talk to yet
   - Once paired, the agent authenticates using the stored device-code tokens

5. **Site Configuration**
   - Skipped on upgrades: an existing valid config already bound to the requested server
   - **Interactive installs** hand pairing to the desktop app, which opens **join a site** with the pairing phrase, the authorization link, and an environment badge on anything other than production. The wizard does not wait for it, which is why the service is installed and started while you are still pairing
   - **`/ADD=` installs, and machines with no WebView2 runtime**, run `configure_site.py` on the console instead; the wizard does wait for that one
   - **Silent installs without `/ADD=`** skip pairing altogether and install the machine unpaired
   - Authorize from the pairing dialog's own button, or from a phone or another computer. Nothing on this machine opens a browser on its own
   - **Automatic device-code token exchange:**
     - Web backend authorizes the pairing phrase
     - Agent polls until access + refresh tokens are returned
     - Tokens are stored in the encrypted Owlette token file
     - Site ID and configuration saved to `config.json`
   - **No manual credential downloads required!**
   - If pairing does not complete, the installer says so and prints both recovery routes. The service is already running, so pairing later is all that is left

6. **Shortcuts Creation**
   - Start Menu shortcuts for GUI and tray icon
   - Startup folder shortcut for tray icon (auto-starts on login)

## Post-Installation

### Firebase Integration

**Firebase integration is automatic!** The installer device-code flow handles all authentication:

✅ **Automatic:**
- Device-code tokens (access + refresh)
- Encrypted token-file storage
- Automatic token refresh (when access token expires)
- Site assignment and permissions

❌ **No longer needed:**
- Manual Firebase credential downloads
- Service account JSON files
- Manual configuration steps

### Authentication Details

**Where tokens are stored:**
- Location: `C:\ProgramData\Owlette\.tokens.enc`
- Encryption: Machine-bound key
- Access: Local Owlette processes on this machine

**Token lifecycle:**
- Access token: Valid for 1 hour (auto-refreshes)
- Refresh token: Valid for 30 days (stored encrypted)
- Automatic refresh: Agent handles this transparently

**Token revocation:**
- Via web dashboard: "Remove Machine" button
- Immediately revokes agent access
- Agent stops syncing within 1 hour (when access token expires)

### Verify Installation

Check service status:
```bash
sc query OwletteService
```

View logs:
```bash
# Service logs
type C:\ProgramData\Owlette\agent\logs\service_stdout.log
type C:\ProgramData\Owlette\agent\logs\service_stderr.log
```

## Uninstallation

Use Windows Settings → Apps → Owlette → Uninstall

Or from Command Prompt:
```bash
C:\ProgramData\Owlette\unins000.exe
```

The uninstaller will:
- Stop and remove the Windows service
- Delete installation files
- Remove shortcuts
- Preserve config and logs (optional to delete manually)

## Troubleshooting

### Port 8765 Already in Use

If pairing cannot reach the server:
1. Check outbound HTTPS access to `owlette.app` or `dev.owlette.app`
2. Confirm the pairing phrase has not expired
3. Re-run the installer or `configure_site.py`

### No Browser Opens

That is by design — nothing on the target machine opens a browser on its own. Authorize from the **open owlette.app/add** button in the pairing window, or from a phone or another computer using the link that is displayed. `--no-browser` and `OWLETTE_NO_BROWSER=1` are still accepted by `configure_site.py` so existing deployment scripts keep working, but they no longer change anything.

### The Pairing Window Doesn't Appear

The service is installed and running either way, so only pairing is outstanding. Finish it by opening Owlette from the Start menu and choosing **join site**, or by running the pairing helper from an administrator prompt:

```bash
"C:\ProgramData\Owlette\python\python.exe" "C:\ProgramData\Owlette\agent\src\configure_site.py" --server prod
```

Machines with no WebView2 runtime get the console pairing flow instead of the window. The installer bootstraps that runtime, but a blocked bootstrapper leaves it missing; the installer's own `/LOG=` file records the outcome.

### Service Won't Start

Check logs at `C:\ProgramData\Owlette\agent\logs\` for error messages.

Common issues:
- Missing or expired pairing tokens
- Python dependencies missing (re-run installer)
- Port conflicts (check firewall settings)

## Advanced Options

### Custom Installation Directory

The installer uses `C:\ProgramData\Owlette` by default. To change:
```bash
Owlette-Installer-v<version>.exe /DIR="D:\CustomPath\Owlette"
```

### Forcing the Console Pairing Path

`/SILENT` bypasses the GUI handoff entirely while still installing the service. That is the documented rollback lever if the desktop pairing window misbehaves on a particular image — no new flag was added for it. Combine it with `/ADD=<phrase>` to actually complete pairing on that path; `/SILENT` on its own installs the machine unpaired.

### Skip Pairing

Not recommended. The agent needs encrypted tokens from the pairing flow; editing `config.json` alone is not enough to connect to a site.

## Developer Notes

### Testing Different Environments

During development, you can test both environments:

```bash
# Test dev environment
Owlette-Installer-v<version>.exe /SERVER=dev

# Uninstall
C:\ProgramData\Owlette\unins000.exe

# Test prod environment
Owlette-Installer-v<version>.exe /SERVER=prod
```

### Manual Configuration Override

`configure_site.py` accepts `--url` with one of the two hosted API bases only, `https://owlette.app/api` or `https://dev.owlette.app/api`:

```bash
python configure_site.py --url https://dev.owlette.app/api --server dev
```

The agent sends its credentials to those two hosts and no others. Any other `--url` is refused before anything is sent, and any other `firebase.api_base` in `config.json` is ignored in favour of the environment's base, with a warning in the log. An agent cannot be pointed at a local web server.

`--server` is **required** whenever `--url` is given. `--url` carries no environment of its own, so without `--server` the agent would write a production Firebase project id for a development URL. Passing `--url` alone exits with code 2.

With no `--url`, `--server` is optional: the machine keeps the environment its config is already bound to.

## Version History

- **2.1.0** - Legacy browser-based custom token authentication (eliminated service accounts)
  - Browser handoff during installation
  - Tokens stored in the then-current Windows encrypted store
  - No manual credential downloads required
  - Token revocation via web dashboard

- **2.0.0** - Initial release with dev/prod environment support
