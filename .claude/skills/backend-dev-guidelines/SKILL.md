---
name: backend-dev-guidelines
description: "Patterns for the Owlette Python agent in agent/: the 5s service loop, process launch, monitoring and crash recovery, remote commands (command_router and *_commands.py), Firestore REST client, ConnectionManager, OAuth tokens, config.json migration, crash alerts and log paths. Use when changing agent code, adding a command, or debugging the service, a process, reconnection, tokens or agent logs."
paths:
  - "agent/**"
---

# Backend Development Guidelines

**Applies To**: Owlette Python Agent (`agent/` directory)

---

## Tech Stack

- **Language**: Python 3.11 (ships embedded 3.11.8 on Windows, python-build-standalone 3.11 on macOS/Linux; a fresh dev install needs ≥ 3.10); type hints encouraged
- **Platform**: Windows service via `owlette-host` (`agent/host`, Rust — not pywin32 ServiceFramework directly, and not NSSM since 3.0.0); a launchd daemon on macOS and a systemd unit on Linux. Platform differences live behind `agent/src/osadapter/` (`win`, `darwin`, `linux`, `posix`)
- **Cloud**: Firestore REST API (`firestore_rest_client.py`) — NOT Firebase Admin SDK
- **Auth**: OAuth two-token system (access + refresh) with Fernet AES encrypted storage
- **Process Management**: psutil, pywin32; on Windows managed processes start through `process_launcher.py` in the user session (CreateProcessAsUser), elsewhere `osadapter.launch_managed_process`
- **Local UI**: none in python — the Tauri desktop app in `desktop/` owns the tray, the config window and the reboot prompt (3.0.0+)
- **Build**: Inno Setup with embedded Python 3.11 (not PyInstaller), plus a `tauri build --no-bundle` step for the desktop exe and `cargo build --release` steps for the service host and the swoop streamer

---

## Module Map (`agent/src/`, 52 modules + `osadapter/` — the tables below cover the load-bearing ones)

### Core Service
| Module | Purpose |
|--------|---------|
| `owlette_service.py` | Main service — process monitoring loop (5s), legacy command chain, crash recovery, self-update |
| `owlette_runner.py` | Host↔service bridge — builds the service, SCM stop watcher, exit codes, service lifecycle |
| `shared_utils.py` | Config loading + `upgrade_config()`, logging, system metrics, file paths, atomic JSON writes |
| `command_router.py` | Registry the `*_commands.py` modules (`process_`, `machine_`, `sync_`, `swoop_`, `site_`) register handlers into |

### Firebase Chain
| Module | Purpose |
|--------|---------|
| `firebase_client.py` | Cloud communication — adaptive heartbeat + metrics (`_metrics_loop`), config sync, command poller and lanes, alerts |
| `firestore_rest_client.py` | Low-level Firestore REST API wrapper (GET/POST/PATCH/DELETE, `listen_to_document` polling) |
| `connection_manager.py` | State machine, circuit breaker, exponential backoff, thread supervision watchdog |
| `auth_manager.py` | OAuth two-token system — access token (1h) + refresh token (no expiry, rotated on every refresh), auto-refresh 5min before expiry; device-code pairing |
| `secure_storage.py` | Fernet AES encrypted token file (`.tokens.enc`), machine-specific key derivation |

### Process Utilities
| Module | Purpose |
|--------|---------|
| `process_launcher.py` | Windows: runs in the user session, starts the target (ShellExecuteEx, or Popen when hidden) and hands its PID back |
| `owlette_scout.py` | Windows: process responsiveness checker — `user32.IsHungAppWindow` on the process's windows |

### User-Facing
The local UI lives in `desktop/` (Tauri), not here. The service launches
`{app}\app\owlette-desktop.exe` with `--tray` for the notification-area icon and
`--restart-prompt` for the relaunch-limit countdown; the app talks back through
`config.json`, `tmp/app_states.json` and `tmp/service_status.json` under the
`Global\OwletteJsonFileMutex` contract. See `desktop/README.md`.

| Module | Purpose |
|--------|---------|
| `session_exec.py` | Windows: runs python/cmd/PowerShell in the interactive session (CreateProcessAsUser) |

### Installation & Updates
| Module | Purpose |
|--------|---------|
| `configure_site.py` | Device-code pairing during install, plus the desktop app's CLI back end for join/leave/report-issue/reboot |
| `installer_utils.py` | Download/verify/execute/cancel installers (deployments and self-update; self-update itself is `OwletteService._handle_update_owlette`) |

### Feature areas (not detailed here)
roost sync (`sync_*.py`), swoop remote sessions (`swoop_*.py`), hoot (`owlette_cortex.py`, `cortex_*.py`, `mcp_tools.py`), displays (`display_manager.py`, `nvapi_display.py`), `screenshot_capture.py`, `health_probe.py`, `temp_sensors.py`, `registry_utils.py` (Windows installed-software list).

> **Full architecture details**: [agent-architecture.md](agent-architecture.md)
> **Build system details**: [../build-system/installer-build-system.md](../build-system/installer-build-system.md)

---

## Development Patterns

### Adding a New Command

1. Write `def _handle_x(cmd_data: dict, cmd_id: str, service) -> str` in the matching `*_commands.py` module and register it in that module's `register_handlers(router)`: `router.register('x')(_handle_x)` (see `process_commands.py`). A new module also needs its guarded import + `register_handlers` call in `OwletteService._init_state`.
2. `handle_firebase_command(cmd_id, cmd_data)` in `owlette_service.py` dispatches through the router first and falls back to the legacy if/elif chain; registering a type twice raises.
3. Commands are `{type, ...params}` map fields of the single `commands/pending` doc, picked up by the poller every 2-5s.
4. Return a result string; an `Error:` prefix (or a raise) marks it failed. Don't write `completed` yourself — `firebase_client.finish_command` moves it there. Work that continues on its own thread returns `COMMAND_DEFERRED` and calls `finish_command` later; report progress with `update_command_progress`.
5. Commands run on one serialised slow worker. Add the type to `FirebaseClient._FAST_COMMAND_TYPES` only if it finishes in under 30s and is safe to run concurrently.
6. A 5s per-(type, process) rate limit (`COMMAND_RATE_LIMIT_SECONDS`) applies; types that legitimately repeat go in its exemption tuple.
7. Log the action via `firebase_client.log_event(action, level, process_name=..., details=...)`.

The full list of command types is the router registrations plus the legacy chain in `handle_firebase_command`; the web side's allowlist is in the firebase-integration skill.

### Modifying Process Handling

- Process states: `RUNNING`, `STALLED`, `KILLED`, `STOPPED`, `INACTIVE`, `LAUNCHING`, `LAUNCH_FAILED`, `RESTARTING` (the last written by the desktop app)
- The `main()` loop runs every 5s (`SLEEP_INTERVAL = 5`) and calls `handle_process()` for each process that is `always`, `scheduled` and in its window, or under a manual override
- Windows launch: `launch_process_as_user` starts `process_launcher.py` in the console session via CreateProcessAsUser (`DETACHED_PROCESS`); the helper starts the target and writes its PID back through `tmp/pid_*.txt`, so managed processes are never descendants of the agent. No Task Scheduler, no VBScript
- Hang detection: 3-stage confirmation (0-10s watch → 10-15s confirm → kill at `HANG_CONFIRM_SECONDS = 15`), Windows only
- Crash recovery: `recover_running_processes()` adopts a PID only when `shared_utils.identity_matches(record, pid)` confirms the create_time recorded at launch

### Launch Mode Patterns

Processes use a 3-mode `launch_mode` field (`off` / `always` / `scheduled`) instead of a binary `autolaunch` boolean.

**Key utilities in `shared_utils.py`**:
- `is_within_schedule(schedules, timezone_str=None)` — returns `True` if the current day+time (in the site timezone the caller passes) falls within any `ScheduleBlock` in the list. Each block has `{ name?, colorIndex?, days: ["Mon","Tue",...], ranges: [{ start: "HH:MM", stop: "HH:MM" }] }`. Handles overnight ranges (e.g. 22:00-06:00).
- `upgrade_config()` — migrates legacy `autolaunch: bool` to `launch_mode: "always"/"off"` on startup.

**In the `owlette_service.py` `main()` loop**:
- `launch_mode == "off"` → skipped (INACTIVE)
- `launch_mode == "always"` → `handle_process()` launches/monitors
- `launch_mode == "scheduled"` → `is_within_schedule(proc.get("schedules"), site timezone)`; in window → `handle_process()`, outside → stopped unless a manual override is active
- Manual override tracking prevents the scheduler from fighting user intent until the next window opens

**Backward compatibility**: `autolaunch` is still derived and synced to Firestore (true when effectively active) for any legacy consumers.

### Changing Config Schema

1. Update `upgrade_config()` in `shared_utils.py` for migration
2. Use atomic writes: write to `.tmp` file → `os.replace()` to final path
3. **NEVER modify the `firebase` section** during remote config updates
4. Hash-based dedup prevents listener feedback loops

### Process Crash Alerts

When a process crashes or fails to start, the agent sends an alert via the web API:

1. After each `log_event('process_crash', ...)` or `log_event('process_start_failed', ...)` call in `owlette_service.py`, a call to `firebase_client.send_process_alert()` follows
2. `send_process_alert(process_name, error_message, event_type)` spawns a daemon thread that POSTs `{siteId, machineId, eventType, data: {process_name, error_message}, agentVersion}` to `/api/agent/alert`
3. The web API rate-limits per `machineId:processName` (3/hr) and queues the event; a cron emails a per-site digest every 3 minutes to users with `processAlerts !== false`
4. Alert sending is non-blocking — a failed send is queued and re-sent on reconnect

### Error Handling

- **All Firebase/network errors** → report to `ConnectionManager.report_error()`
- **JSON file reads** → use `shared_utils.read_json_from_file()` (returns `{}` on a missing or unreadable file)
- **Config writes** → atomic writes via `.tmp` → rename pattern
- **Process operations** → wrap in try/except, log via `shared_utils` logger
- **Token errors** → `AuthenticationError` (fatal, clear tokens) vs `TokenRefreshError` (retriable)

---

## Critical Rules

### Do
- Report all errors to ConnectionManager (centralized state + reconnection)
- Validate PID identity (`shared_utils.identity_matches`) before adopting or killing a process
- Use atomic file writes for config changes
- Test with `cd agent/src && ../.venv/Scripts/python owlette_runner.py --debug` from an admin shell (macOS/Linux: `sudo ../.venv/bin/python owlette_runner.py --debug`); stop the installed service first
- Preserve `firebase` config section during any config update
- Set new service state in `OwletteService._init_state()` only — the runner builds the service with `object.__new__` and never calls `__init__`

### Don't
- Never log OAuth tokens (even in DEBUG mode)
- Never write credentials to config.json (tokens go to `.tokens.enc` only)
- Never skip identity validation in `recover_running_processes()`
- Never use blocking operations in the 5-second main loop — off-cadence work uses `*_ITERATIONS` counters and single-flight threads
- Never spawn reconnection logic outside ConnectionManager

---

## File Paths (Production, Windows)

The data root is `C:\ProgramData\Owlette\` on Windows, `/Library/Application Support/Owlette` on macOS and `/var/lib/owlette` on Linux (`osadapter.data_root()`); the layout below it is the same.

| Path | Purpose |
|------|---------|
| `C:\ProgramData\Owlette\` | Installation directory (agent code, Python, the service host) + runtime data |
| `C:\ProgramData\Owlette\config\config.json` | Runtime configuration |
| `C:\ProgramData\Owlette\logs\service.log` | Service logs (rotating) |
| `C:\ProgramData\Owlette\logs\service_host.log`, `service_stdout.log`, `service_stderr.log` | owlette-host's own log and the agent's captured stdout/stderr |
| `C:\ProgramData\Owlette\logs\pairing_debug.log`, `cortex.log`, `installer_update.log` | Pairing, hoot, and self-update (Inno `/LOG`) |
| `%LOCALAPPDATA%\app.owlette.desktop\logs\owlette-desktop.log` | Desktop app (tray, config window) logs |
| `C:\ProgramData\Owlette\.tokens.enc` | Encrypted OAuth tokens |
| `C:\ProgramData\Owlette\cache\firebase_cache.json` | Offline config cache |
| `C:\ProgramData\Owlette\tmp\service_status.json` | IPC status file (service → desktop app tray) |
| `C:\ProgramData\Owlette\tmp\app_states.json` | Persisted PIDs for crash recovery |

---

## Build Commands

```bash
# Full build (first time, downloads Python and builds the desktop app, service host and swoop, ~5-10 min)
cd agent
build_installer_full.bat

# Quick build (development, copies + compiles only, ~30 sec)
cd agent
build_installer_quick.bat

# Debug mode (admin shell; stop the installed service first)
cd agent/src
../.venv/Scripts/python owlette_runner.py --debug
```

> See [installer-build-system.md](../build-system/installer-build-system.md) for complete build pipeline documentation.
