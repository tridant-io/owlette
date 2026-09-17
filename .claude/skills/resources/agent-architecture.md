# Owlette Agent Architecture Reference

**Last Updated**: 2026-03-21
**Applies To**: `agent/src/` (Python 3.9+ Windows Service)

This document captures the architecture and design decisions of the Owlette agent — a Windows service that monitors processes, syncs with Firebase, and accepts remote commands. Read this before modifying any agent code.

---

## Module Dependency Graph

```
owlette_service.py          Main service loop (OwletteService + main())
  ├── firebase_client.py    Cloud communication (Firestore REST API)
  │   ├── auth_manager.py   OAuth two-token system (access + refresh)
  │   │   └── secure_storage.py  Encrypted token file (Fernet AES)
  │   ├── firestore_rest_client.py  Firestore REST API wrapper
  │   └── connection_manager.py  State machine, circuit breaker, thread watchdog
  ├── shared_utils.py       Config, logging, system metrics, file paths
  ├── installer_utils.py    Download/execute/cancel remote installers
  └── registry_utils.py     Windows registry queries (installed software)

owlette_runner.py           The process owlette-host supervises (bridges the host → service main loop)
owlette_updater.py          Self-update bootstrap (stop service → download → silent install)
configure_site.py           Pairing + join/leave/report-issue/reboot CLI (also the desktop app's back end)
owlette_scout.py            Process responsiveness checker (sends WM_NULL to window)
session_exec.py             Runs code in the interactive desktop session (CreateProcessAsUser)
```

The local UI is **not** python. `desktop/` (Tauri 2 + React) ships as
`{app}\app\owlette-desktop.exe` and provides the tray icon, the configuration
window and the reboot countdown; the service launches it with `--tray` /
`--restart-prompt`. It replaced `owlette_gui.py`, `owlette_tray.py` and
`prompt_restart.py` in 3.0.0. See `desktop/README.md` for the service seam
(`config.json`, `app_states.json`, `service_status.json`, the named mutex).

---

## Service Lifecycle

### Startup Flow
`owlette_runner.py` owns the sequence — `OwletteService` has no constructor.
```
owlette-host launches owlette_runner.py
 → initialize logging (RotatingFileHandler → C:\ProgramData\Owlette\logs\service.log)
 → upgrade_config() (schema migration)
 → object.__new__(OwletteService) + _init_state()  (the one place service state is set)
 → HealthProbe().run() (startup verdict for the tray)
 → lazy import FirebaseClient (FIREBASE_AVAILABLE flag, no crash if missing)
 → if firebase enabled + has OAuth tokens → AuthManager + FirebaseClient + ConnectionManager
 → _write_service_status_early() + _wire_connection_status_listener()
 → register signal / console-control handlers, start_scm_stop_watcher()
 → main() loop
```

### Main Loop (10-second interval)
```
while self.is_alive:
  update current_time
  for each configured process:
    handle_process(process)  → launch / monitor / recover
  sleep(SLEEP_INTERVAL=10)
```

### Shutdown Flow
The SCM stop watcher sees owlette-host report STOP_PENDING; a console control
event is the other trigger. Both land in `graceful_shutdown(trigger)`, which runs
at most once per process — first caller wins.
```
graceful_shutdown(trigger)
 → session_state.set_intent_if_none("external_clean")  (before any network call)
 → firebase_client.enter_shutdown_mode()  (caps the Firestore timeout at 3s)
 → self.is_alive = False (breaks main loop)
 → log_event(agent_stopped)
 → firebase_client.stop() → marks machine offline, stops listeners
 → write service_status.json (running=false)
```
The desktop app is **not** in the service's process tree and is deliberately left
running — see `build_detached_launch_command`.

**Key state variables**:
- `self.is_alive` — service running flag
- `self.first_start` — True until first loop completes (affects relaunch counting)
- `self.relaunch_attempts` — dict[process_name → int] tracking restart counts
- `self.last_started` — dict[process_id → {time, pid}] tracking launch times
- `self.results` — dict loaded from app_states.json (persisted PIDs)
- `self.active_installations` — dict tracking deployment processes for cancellation

---

## Process Management

### Process Status Values
- `RUNNING` — confirmed running via psutil
- `STALLED` — detected unresponsive (hung window)
- `KILLED` — manually terminated via dashboard command
- `STOPPED` — process terminated/crashed
- `INACTIVE` — configured but launch mode is `off` (or `scheduled` and outside schedule window)

### Two-Stage Process Launch (`launch_process_as_user`)

**Stage 1 — Task Scheduler (preferred)**:
```
schtasks /Create /TN "OwletteProcess_{id}" /TR "{command}" /SC ONCE /ST 00:00 /RU {username}
schtasks /Run /TN "OwletteProcess_{id}"
schtasks /Delete /TN "OwletteProcess_{id}" /F
```
**Why**: Processes launched by Task Scheduler run under svchost.exe, so they are not descendants of the agent at all and survive service restarts unconditionally. This was originally a defence against NSSM's process-tree kill; owlette-host (3.0.0) terminates only the process it launched, but the detachment stays because a managed show must survive anything that walks the tree — a manual `taskkill /T`, a remote-management tool, an operator's Task Manager "end process tree".

**Stage 2 — CreateProcessAsUser (fallback)**:
Used when schtasks fails (no user logged in, permission issues).
Uses `CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB` flags.

**Hidden window support**: Wraps command in VBScript via `wscript.exe` with `intWindowStyle = 0`.

### Multi-Stage Hang Detection (`handle_unresponsive_process`)

Uses a 3-stage confirmation to prevent false positives from momentary UI hangs:

1. **Stage 1 (0-10s)**: First detection → record `hung_since` timestamp, set status STALLED
2. **Stage 2 (10-15s)**: Still hung → log warning, continue monitoring
3. **Stage 3 (15s+)**: Confirmed hung → kill process and relaunch

Responsiveness is checked by `owlette_scout.py` which runs as a user-space process and sends `WM_NULL` to the process window. Results written to `app_states.json`.

Can be disabled per-process: `check_responsive: false`

### Crash Recovery (`recover_running_processes`)

On service restart:
1. Read app_states.json for PIDs from previous session
2. For each PID: validate it's still running via `psutil.Process(pid)`
3. **Security**: verify `psutil.Process(pid).exe()` matches configured `exe_path` (prevents PID hijacking after reuse)
4. Clean dead PIDs from state file
5. Adopt valid processes (skip launch, mark RUNNING)

### Process Crash Alerts

When a process crash or start failure is detected, the agent sends an email alert:

```
log_event('process_crash', ...)  →  send_process_alert(name, error, 'process_crash')
log_event('process_start_failed', ...)  →  send_process_alert(name, error, 'process_start_failed')
```

Alert locations in `owlette_service.py`:
1. `kill_and_relaunch_process()` — failed to kill and restart
2. `handle_process_launch()` — launch exception
3. `handle_process()` — unexpected process exit (not manually killed)

`send_process_alert()` in `firebase_client.py` spawns a daemon thread that POSTs to `/api/agent/alert` with bearer token auth. The web API applies per-process rate limiting (3/hr per `machineId:processName`) and emails users who have `processAlerts !== false`.

### 3-Mode Launch System

Processes use a `launch_mode` field instead of a binary `autolaunch` toggle:

| Mode | Behavior |
|------|----------|
| `off` | Process is not launched or monitored (status: INACTIVE) |
| `always` | Process is always launched and monitored (equivalent to old `autolaunch: true`) |
| `scheduled` | Process is launched only during configured schedule windows |

**Schedule enforcement** happens in the monitoring loop (`handle_process()`):
- Each process can have a `schedules` array of `ScheduleBlock` objects: `{ days: string[], startTime: "HH:MM", endTime: "HH:MM" }`
- `is_within_schedule(schedules)` in `shared_utils.py` checks if current time falls within any active window
- When in `scheduled` mode and outside the window, the process is treated as INACTIVE (not launched, optionally killed)
- When the schedule window opens, the process is launched automatically

**Manual override tracking**: If a user manually starts/stops a process via the dashboard while in `scheduled` mode, the agent tracks this override so it does not fight the user's intent until the next schedule transition.

**Config migration**: `upgrade_config()` in `shared_utils.py` migrates legacy `autolaunch: true/false` to `launch_mode: 'always'/'off'`.

**Backward compatibility**: The `autolaunch` field is still derived and written to Firestore status for any consumers that read it (true when `launch_mode` is `always`, or `scheduled` and within window).

**Desktop app / Web**: Both use a segmented control (off / always / scheduled).

### Relaunch Limits
- Per-process config: `relaunch_attempts` (default: 3, 0 = unlimited)
- Tracked in `self.relaunch_attempts[process_name]`
- When exceeded: launches the desktop app with `--restart-prompt` (countdown to machine reboot)
- Counter resets after prompt is shown

---

## Firebase Integration Chain

```
FirebaseClient
  ├── AuthManager (token lifecycle)
  │   └── SecureStorage (encrypted persistence)
  ├── FirestoreRestClient (HTTP calls to Firestore)
  └── ConnectionManager (state + reconnection)
```

### FirebaseClient (`firebase_client.py`)

**Constructor**: `FirebaseClient(auth_manager, project_id, site_id, config_cache_path)`

**Data sync cycles**:
- **Presence/heartbeat**: Every 30s → `sites/{siteId}/machines/{machineId}/presence`
- **System metrics**: Every 60s → `sites/{siteId}/machines/{machineId}/status`
- **Config sync**: On change → `config/{siteId}/machines/{machineId}`

**Background threads** (supervised by ConnectionManager):
- `command_listener` — listens to `sites/{siteId}/machines/{machineId}/commands/pending`
- `config_listener` — listens to `config/{siteId}/machines/{machineId}`

**Offline resilience**:
- Config cached to `cache/firebase_cache.json`
- Loaded on connection failure, re-uploaded on reconnect
- Hash-based dedup prevents re-uploading unchanged config

**Key methods**:
- `start()` / `stop()` — lifecycle management
- `register_command_callback(fn)` — service registers command handler
- `register_config_update_callback(fn)` — service registers config handler
- `log_event(action, level, details)` — log events for web dashboard
- `send_process_alert(process_name, error_message, event_type)` — fire-and-forget email alert via `/api/agent/alert` (daemon thread, non-blocking)
- `is_connected()` — check connection state

### ConnectionManager (`connection_manager.py`)

**State machine**:
```
DISCONNECTED → CONNECTING → CONNECTED
                    ↑           ↓
                 RECONNECTING ← (error)
                    ↓
                 BACKOFF → (wait) → RECONNECTING

Any state → FATAL_ERROR (unrecoverable: machine removed, auth permanently revoked)
```

**Exponential backoff**: base=30s, max=3600s, formula: `min(current * 2, MAX)`, jitter: 50-100% (prevents thundering herd from multiple agents reconnecting simultaneously)

**Circuit breaker**: Opens after 5 consecutive failures, tests recovery after 5 minutes

**Thread supervision**: Watchdog checks every 10s, auto-restarts dead listener threads on next successful connection

**Key methods**:
- `connect()` / `disconnect()` — control state
- `report_error(exception, context)` — any component reports failures here
- `report_success()` — resets failure counters
- `register_thread(name, factory)` — register supervised thread
- `start_watchdog()` — enable thread health checks
- `add_state_listener(callback)` — subscribe to state changes
- `force_reconnect()` — bypass backoff for immediate retry

### OAuth Two-Token System (`auth_manager.py`)

**Tokens**:
- **Access token**: 1-hour Firebase custom token for Firestore REST API
- **Refresh token**: 30-day token to obtain new access tokens

**Auto-refresh**: 5 minutes before expiry (`TOKEN_REFRESH_BUFFER_SECONDS = 300`)

**Flow**: `get_valid_token()` → check cached → if expired → `POST /api/agent/auth/refresh` → cache new token

**Error handling**:
- 401/403: Clear tokens, require re-registration
- 429: Rate limited → backoff
- Network errors: Transient, retry with exponential backoff

**Exceptions**: `AuthenticationError` (fatal), `TokenRefreshError` (retriable)

### Encrypted Token Storage (`secure_storage.py`)

**File**: `C:\ProgramData\Owlette\.tokens.enc` (hidden file)

**Encryption**: Fernet symmetric (AES-128-CBC + HMAC-SHA256)

**Key derivation**:
```python
key_material = osadapter.key_material() + b":owlette-agent"
key = base64url(SHA256(key_material))
```
`osadapter.key_material()` is the machine binding and nothing else: MachineGuid from the Windows
registry (`HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`), IOPlatformUUID on macOS,
`/etc/machine-id` on Linux. The hostname is no longer part of it — a store written under the
previous `{machine_guid}:{hostname}:owlette-agent` derivation is re-encrypted on first load, and
the original is kept as `.tokens.enc.v1` for one minor.

**Stored data**: `{refresh_token, access_token, token_expiry, site_id}`

**Access**: Readable by both regular users and SYSTEM (C:\ProgramData is shared).

---

## Command Handling

Commands arrive via Firestore listener on `commands/pending/{commandId}`.

### Supported Commands

| Command | Data Fields | Behavior |
|---------|-------------|----------|
| `restart_process` | `process_name` | Kill running process + relaunch |
| `kill_process` | `process_name` | Terminate via `psutil.Process(pid).terminate()` |
| `set_launch_mode` | `process_name`, `launch_mode` | Update launch mode (`off`/`always`/`scheduled`), affects next cycle |
| `update_config` | `config` (full object) | Replace local config, preserve firebase section |
| `install_software` | `installer_url`, `silent_flags`, `timeout_seconds`, `sha256_checksum`, `deployment_id` | Download + execute installer |
| `reboot_machine` | — | Set `rebooting` flag, run `shutdown /r /t 30` |
| `shutdown_machine` | — | Set `shuttingDown` flag, run `shutdown /s /t 30` |
| `cancel_reboot` | — | Run `shutdown /a`, clear `rebooting`/`shuttingDown` flags |
| `dismiss_reboot_pending` | `process_name` | Clear `rebootPending` flag, reset relaunch counter for process, kill local prompt |
| `capture_screenshot` | — | Capture in the user session → signed-url PUT → `screenshots/finalize` |

### Machine Flags (Firestore)

Written to `sites/{siteId}/machines/{machineId}`:

| Flag | Set By | Cleared By | Purpose |
|------|--------|-----------|---------|
| `rebooting: true` | `_handle_reboot_machine` | Agent startup, `_handle_cancel_reboot` | Dashboard shows "Rebooting..." badge |
| `shuttingDown: true` | `_handle_shutdown_machine` | Agent startup, `_handle_cancel_reboot` | Dashboard shows "Shutting down..." badge |
| `rebootPending: { active, processName, reason, timestamp }` | `reached_max_relaunch_attempts` | Agent startup, `_handle_dismiss_reboot_pending` | Dashboard shows approve/dismiss banner |

### Config Update Preservation

**Critical rule**: The `firebase` section of config.json is NEVER overwritten by remote config updates. This prevents authentication loss.

Flow:
1. Read current config → extract firebase section
2. Write new config from Firestore
3. Restore original firebase section
4. Hash-based dedup prevents listener feedback loops (config change → upload → listener fires → ignored because hash matches)

---

## IPC: Service ↔ Tray Icon

**Mechanism**: Status file written by service, read by tray icon.

**Path**: `C:\ProgramData\Owlette\tmp\service_status.json`

**Written every**: ~10 seconds by service main loop

**Structure**:
```json
{
  "service": { "running": true, "last_update": 1234567890, "version": "2.0.54" },
  "firebase": { "enabled": true, "connected": true, "site_id": "...", "last_heartbeat": 1234567890 }
}
```

**Tray icon colors**:
- White: Service running + Firebase connected
- Orange: Service running + Firebase disconnected/issues
- Red: Service stopped or Firebase disabled

**Stale detection**: If file is >120s old → red (service likely crashed)

### User-Session Execution (`session_exec.py`)

**Mechanism**: The service launches `session_exec.py` in the interactive user's desktop session via `CreateProcessAsUser`. This enables execution of Python code, shell commands, and PowerShell scripts with full desktop/GPU access.

**Path**: `C:\ProgramData\Owlette\ipc\jobs\` (job files) + `C:\ProgramData\Owlette\ipc\results\{requestId}\` (output)

**Flow**:
1. Service writes job JSON to `ipc/jobs/{requestId}.json`: `{ type, code, timeout, outputDir }`
2. Service launches `session_exec.py {job_path}` via `CreateProcessAsUser` in the active console session
3. `session_exec.py` reads the job, executes (python/cmd/powershell), writes `result.json` + any output files to `outputDir`
4. Service polls for `result.json` (timeout + 5s grace), returns parsed result
5. Cleanup: job file deleted, result dir cleaned by caller

**Job types**: `python` (exec'd in-process), `cmd` (subprocess), `powershell` (subprocess)

**Session 0 note**: The service runs in Session 0 (no desktop access). `session_exec.py` is launched in the user's interactive session via the same `CreateProcessAsUser` mechanism used for managed processes.

**Consumers**:
- `capture_screenshot` command — runs Python capture code via `execute_in_user_session`
- MCP `run_python` tool — arbitrary Python in user session
- MCP `run_command` / `run_powershell` — with `user_session=true` param

---

## Known Limitations

### Command Processing Blocks During Installs

`handle_firebase_command` processes commands synchronously. Long-running commands like `install_software` and `uninstall_software` block the command callback for the duration of the download + install (can be minutes). During this time, no other commands (screenshots, reboots, process management, MCP tools) can be processed.

**Impact**: Screenshot capture, reboot, and other commands time out if a software deployment is in progress.

**User-facing mitigation**: The ScreenshotDialog detects active deployments via `checkMachineHasActiveDeployment` and shows a specific error message explaining why the capture failed.

**Future fix**: Run `install_software` / `uninstall_software` in a background thread with immediate "started" status, then update completion via Firestore. Requires careful handling of concurrent installs and commands that conflict with active installs (e.g., reboot during install).

---

## Critical Maintenance Rules

### Do's
- Always preserve `firebase` config section during config updates
- Use atomic file writes (.tmp → rename) for config changes
- Validate PID ownership (exe_path match) during recovery
- Report all errors to ConnectionManager (centralized handling)
- Use `shared_utils.read_json_from_file()` with null checks for all JSON reads
- Test token refresh error paths (critical for 30-day token expiry)

### Don'ts
- Never log OAuth tokens (even in DEBUG mode) — sanitize in auth_manager.py
- Never write credentials to config.json (tokens go to .tokens.enc only)
- Never modify the firebase section during remote config updates
- Never skip PID validation in `recover_running_processes()`
- Never use blocking operations in the 10-second main loop
- Never spawn reconnection logic outside ConnectionManager (it's the single source of truth)

### Debugging
- Service logs: `C:\ProgramData\Owlette\logs\service.log`
- Tray logs: `C:\ProgramData\Owlette\logs\tray.log`
- GUI logs: `C:\ProgramData\Owlette\logs\gui.log`
- Status file: `C:\ProgramData\Owlette\tmp\service_status.json`
- Config: `C:\ProgramData\Owlette\config\config.json`
- Debug mode: `cd agent\src && python owlette_runner.py --debug` (admin prompt)
