# Backend Development Guidelines

**Version**: 2.0.0
**Last Updated**: 2026-03-21
**Applies To**: Owlette Python Agent (`agent/` directory)

---

## Tech Stack

- **Language**: Python 3.9+ (type hints encouraged)
- **Platform**: Windows Service via `owlette-host` (`agent/host`, Rust) — not pywin32 ServiceFramework directly, and not NSSM since 3.0.0
- **Cloud**: Firestore REST API (`firestore_rest_client.py`) — NOT Firebase Admin SDK
- **Auth**: OAuth two-token system (access + refresh) with Fernet AES encrypted storage
- **Process Management**: psutil, pywin32, Task Scheduler (schtasks)
- **Local UI**: none in python — the Tauri desktop app in `desktop/` owns the tray, the config window and the reboot prompt (3.0.0+)
- **Build**: Inno Setup with embedded Python 3.11 (not PyInstaller), plus a `tauri build --no-bundle` step for the desktop exe and a `cargo build --release` step for the service host

---

## Module Map (`agent/src/`, ~40 modules — the tables below cover the load-bearing ones)

### Core Service
| Module | Purpose |
|--------|---------|
| `owlette_service.py` | Main Windows service — process monitoring loop (10s interval), command handling, crash recovery |
| `owlette_runner.py` | Host↔service bridge — SCM stop watcher, exit codes, service lifecycle |
| `shared_utils.py` | Config loading, logging, system metrics, file paths, atomic JSON writes |

### Firebase Chain
| Module | Purpose |
|--------|---------|
| `firebase_client.py` | Cloud communication — presence/heartbeat (30s), metrics (60s), config sync, command listener, process crash alerts |
| `firestore_rest_client.py` | Low-level Firestore REST API wrapper (GET/POST/PATCH/DELETE) |
| `connection_manager.py` | State machine (6 states), circuit breaker, exponential backoff, thread supervision watchdog |
| `auth_manager.py` | OAuth two-token system — access token (1h) + refresh token (30d), auto-refresh 5min before expiry |
| `secure_storage.py` | Fernet AES encrypted token file (`.tokens.enc`), machine-specific key derivation |

### Process Utilities
| Module | Purpose |
|--------|---------|
| `owlette_scout.py` | Process responsiveness checker — sends WM_NULL to window handles |

### User-Facing
The local UI lives in `desktop/` (Tauri), not here. The service launches
`{app}\app\owlette-desktop.exe` with `--tray` for the notification-area icon and
`--restart-prompt` for the relaunch-limit countdown; the app talks back through
`config.json`, `tmp/app_states.json` and `tmp/service_status.json` under the
`Global\OwletteJsonFileMutex` contract. See `desktop/README.md`.

| Module | Purpose |
|--------|---------|
| `session_exec.py` | Runs python/cmd/PowerShell in the interactive session (CreateProcessAsUser) |

### Installation & Updates
| Module | Purpose |
|--------|---------|
| `configure_site.py` | Pairing (device code) during install, plus the desktop app's CLI back end for join/leave/report-issue/reboot |
| `owlette_updater.py` | Self-update bootstrap — stop service → download → silent install → verify |
| `installer_utils.py` | Download/execute/cancel remote installers (deployment system) |

### Utilities
| Module | Purpose |
|--------|---------|
| `registry_utils.py` | Windows registry queries (installed software list) |

> **Full architecture details**: See `skills/resources/agent-architecture.md`
> **Build system details**: See `skills/resources/installer-build-system.md`

---

## Development Patterns

### Adding a New Command

1. Add command name to the handler in `owlette_service.py` → `handle_command()`
2. Implement the handler method on the service class
3. Commands arrive via Firestore listener as `{command, data, timestamp}`
4. Always move command to `completed` collection after handling
5. Log the action via `firebase_client.log_event()`

Existing commands: `restart_process`, `kill_process`, `set_launch_mode`, `update_config`, `install_software`

### Modifying Process Handling

- Process states: `RUNNING`, `STALLED`, `KILLED`, `STOPPED`, `INACTIVE`
- Main loop in `handle_process()` runs every 10s per configured process
- Two-stage launch: Task Scheduler first (managed processes are never descendants of the agent), CreateProcessAsUser fallback
- Hang detection: 3-stage confirmation (0-10s watch → 10-15s confirm → 15s+ kill)
- Crash recovery: `recover_running_processes()` validates PIDs against `exe_path` on startup

### Launch Mode Patterns

Processes use a 3-mode `launch_mode` field (`off` / `always` / `scheduled`) instead of a binary `autolaunch` boolean.

**Key utilities in `shared_utils.py`**:
- `is_within_schedule(schedules)` — returns `True` if current day+time falls within any `ScheduleBlock` in the list. Each block has `{ days: ["Mon","Tue",...], startTime: "HH:MM", endTime: "HH:MM" }`. Handles overnight ranges (e.g. 22:00-06:00).
- `upgrade_config()` — migrates legacy `autolaunch: bool` to `launch_mode: "always"/"off"` on startup.

**In `owlette_service.py` `handle_process()`**:
- `launch_mode == "off"` → skip (INACTIVE)
- `launch_mode == "always"` → always launch/monitor
- `launch_mode == "scheduled"` → call `is_within_schedule(proc.get("schedules", []))`, launch only if within window
- Manual override tracking prevents the scheduler from fighting user intent during the current schedule window

**Backward compatibility**: `autolaunch` is still derived and synced to Firestore (true when effectively active) for any legacy consumers.

### Changing Config Schema

1. Update `upgrade_config()` in `owlette_service.py` for migration
2. Use atomic writes: write to `.tmp` file → `os.replace()` to final path
3. **NEVER modify the `firebase` section** during remote config updates
4. Hash-based dedup prevents listener feedback loops

### Process Crash Alerts

When a process crashes or fails to start, the agent sends an email alert via the web API:

1. After each `log_event('process_crash', ...)` or `log_event('process_start_failed', ...)` call in `owlette_service.py`, a call to `firebase_client.send_process_alert()` follows
2. `send_process_alert(process_name, error_message, event_type)` spawns a daemon thread that POSTs to `/api/agent/alert` with `eventType`, `processName`, and `errorMessage`
3. The web API rate-limits per `machineId:processName` (3/hr) and routes to users with `processAlerts !== false`
4. All alert sending is non-blocking — failures are logged and silently ignored

### Error Handling

- **All Firebase/network errors** → report to `ConnectionManager.report_error()`
- **JSON file reads** → use `shared_utils.read_json_from_file()` with null checks
- **Config writes** → atomic writes via `.tmp` → rename pattern
- **Process operations** → wrap in try/except, log via `shared_utils` logger
- **Token errors** → `AuthenticationError` (fatal, clear tokens) vs `TokenRefreshError` (retriable)

---

## Critical Rules

### Do
- Report all errors to ConnectionManager (centralized state + reconnection)
- Validate PID ownership (`psutil.Process(pid).exe()` vs configured `exe_path`) during recovery
- Use atomic file writes for config changes
- Test with `python owlette_runner.py --debug` (requires admin prompt)
- Preserve `firebase` config section during any config update

### Don't
- Never log OAuth tokens (even in DEBUG mode)
- Never write credentials to config.json (tokens go to `.tokens.enc` only)
- Never skip PID validation in `recover_running_processes()`
- Never use blocking operations in the 10-second main loop
- Never spawn reconnection logic outside ConnectionManager

---

## File Paths (Production)

| Path | Purpose |
|------|---------|
| `C:\ProgramData\Owlette\` | Installation directory (agent code, Python, the service host) + runtime data |
| `C:\ProgramData\Owlette\config\config.json` | Runtime configuration |
| `C:\ProgramData\Owlette\logs\service.log` | Service logs (rotating) |
| `C:\ProgramData\Owlette\logs\tray.log` | Tray icon logs |
| `C:\ProgramData\Owlette\logs\gui.log` | GUI logs |
| `C:\ProgramData\Owlette\.tokens.enc` | Encrypted OAuth tokens |
| `C:\ProgramData\Owlette\cache\firebase_cache.json` | Offline config cache |
| `C:\ProgramData\Owlette\tmp\service_status.json` | IPC status file (service → tray) |
| `C:\ProgramData\Owlette\tmp\app_states.json` | Persisted PIDs for crash recovery |

---

## Build Commands

```bash
# Full build (first time, downloads Python and builds the desktop app + service host, ~5-10 min)
cd agent
build_installer_full.bat

# Quick build (development, copies + compiles only, ~30 sec)
cd agent
build_installer_quick.bat

# Debug mode (requires admin prompt)
cd agent/src
python owlette_runner.py --debug
```

> See `skills/resources/installer-build-system.md` for complete build pipeline documentation.
