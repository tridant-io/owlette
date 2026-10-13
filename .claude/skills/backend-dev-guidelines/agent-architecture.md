# Owlette Agent Architecture Reference

**Applies To**: `agent/src/` (Python 3.11; a Windows service under owlette-host, a launchd daemon on macOS, a systemd unit on Linux)

This document captures the architecture and design decisions of the Owlette agent — a service that monitors processes, syncs with Firebase, and accepts remote commands. Read this before modifying any agent code. Where it says Windows, the macOS/Linux equivalent sits behind `osadapter/`.

---

## Module Dependency Graph

```
owlette_service.py          Main service loop (OwletteService + main()), legacy command chain, self-update
  ├── firebase_client.py    Cloud communication (Firestore REST API)
  │   ├── auth_manager.py   OAuth two-token system (access + refresh), device-code pairing
  │   │   └── secure_storage.py  Encrypted token file (Fernet AES)
  │   ├── firestore_rest_client.py  Firestore REST API wrapper
  │   └── connection_manager.py  State machine, circuit breaker, thread watchdog
  ├── command_router.py     Registry for the *_commands.py handler modules
  ├── shared_utils.py       Config, logging, system metrics, file paths
  ├── installer_utils.py    Download/verify/execute/cancel installers
  ├── osadapter/            Per-OS seams (win, darwin, linux, posix): data root, launch, reboot, key material
  └── registry_utils.py     Windows registry queries (installed software)

owlette_runner.py           The process the service manager supervises (builds the service, runs main())
configure_site.py           Device-code pairing + join/leave/report-issue/reboot CLI (also the desktop app's back end)
process_launcher.py         Windows: starts a managed process in the user session, hands its PID back
owlette_scout.py            Windows: process responsiveness checker (user32.IsHungAppWindow)
session_exec.py             Windows: runs code in the interactive desktop session (CreateProcessAsUser)
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
owlette-host (launchd / systemd elsewhere) launches owlette_runner.py
 → initialize logging (RotatingFileHandler → <data root>\logs\service.log)
 → module-level try-import of FirebaseClient (FIREBASE_AVAILABLE flag, no crash if missing)
 → upgrade_config() (schema migration)
 → object.__new__(OwletteService) + _init_state()  (the one place service state is set)
 → HealthProbe (startup verdict for the tray)
 → if firebase enabled + has OAuth tokens → wait_for_network (up to 90s)
   → AuthManager + FirebaseClient (which builds its own ConnectionManager)
 → _write_service_status_early() + _wire_connection_status_listener()
 → register signal / console-control handlers, start_scm_stop_watcher() (skipped under --debug)
 → main() loop
```

### Main Loop (5-second interval)
```
while self.is_alive:
  update current_time
  for each configured process:
    always → handle_process(process)  → launch / monitor / recover
    scheduled → handle_process if in window or manually overridden, else stop it
  off-cadence work every N ticks (*_ITERATIONS = INTERVAL // SLEEP_INTERVAL)
  _write_service_status()  (throttled)
  sleep(SLEEP_INTERVAL=5)
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
- `self.manual_overrides` — process ids a user started/stopped outside their schedule

---

## Process Management

### Process Status Values
- `RUNNING` — confirmed running via psutil
- `LAUNCHING` / `LAUNCH_FAILED` — launch in progress / launch failed
- `STALLED` — detected unresponsive (hung window)
- `KILLED` — manually terminated via dashboard command
- `STOPPED` — process terminated/crashed
- `RESTARTING` — written by the desktop app
- `INACTIVE` — configured but launch mode is `off` (or `scheduled` and outside schedule window)

### Process Launch (`launch_process_as_user`, Windows)

One path, no Task Scheduler:
1. The service starts `python process_launcher.py <args.json>` via CreateProcessAsUser with the console user's token (`NORMAL_PRIORITY_CLASS | DETACHED_PROCESS`, desktop `WinSta0\Default`).
2. The helper, already in the user's session, starts the target: `ShellExecuteEx` for visible launches (full desktop/GPU context for apps like TouchDesigner), `subprocess.Popen` with `SW_HIDE` + `CREATE_NO_WINDOW` for hidden ones; `.bat`/`.cmd` go through `cmd.exe /s /c`.
3. The PID comes back through a `tmp/pid_*.txt` handoff and is checked against the helper's process tree.

**Why**: managed processes are never descendants of the agent, so they survive service restarts and anything that walks the tree — a manual `taskkill /T`, a remote-management tool, an operator's Task Manager "end process tree". owlette-host terminates only the process it launched.

Off Windows the launch is `osadapter.launch_managed_process`.

### Multi-Stage Hang Detection (`handle_unresponsive_process`, Windows)

Uses a 3-stage confirmation to prevent false positives from momentary UI hangs:

1. **Stage 1 (0-10s)**: First detection → record `hung_since` timestamp, set status STALLED
2. **Stage 2 (10-15s)**: Still hung → keep watching (DEBUG log)
3. **Stage 3 (15s+, `HANG_CONFIRM_SECONDS`)**: Confirmed hung → kill process and relaunch

Responsiveness is checked by `owlette_scout.py`, which the service starts in the user session each tick for every running process; it calls `user32.IsHungAppWindow` on the process's windows. Results written to `app_states.json`.

Can be disabled per-process: `check_responsive: false`

### Crash Recovery (`recover_running_processes`)

On service restart:
1. Read app_states.json for PIDs from previous session
2. For each PID: validate it's still running via `psutil.Process(pid)`
3. **Security**: `shared_utils.identity_matches(record, pid)` compares the process create_time recorded at launch (exe is only a sanity check) — prevents PID hijacking after reuse. Rows without a record (pre-3.3.0) are relaunched, not adopted
4. Clean dead PIDs from state file
5. Adopt valid processes (skip launch, mark RUNNING) when their mode is `always` or `scheduled` and in window

### Process Crash Alerts

When a process crash or start failure is detected, the agent sends an alert:

```
log_event('process_crash', ...)  →  send_process_alert(name, error, 'process_crash')
log_event('process_start_failed', ...)  →  send_process_alert(name, error, 'process_start_failed')
```

Alert locations in `owlette_service.py`:
1. `kill_and_relaunch_process()` — failed to kill and restart
2. `handle_process_launch()` — launch exception
3. `handle_process()` — unexpected process exit (not manually killed; exit code 0 is logged as `process_exited` with no alert)

`send_process_alert()` in `firebase_client.py` wraps `send_alert()`: a daemon thread POSTs to `/api/agent/alert` with bearer token auth, and a failed send is queued in `_pending_alerts` and re-sent on reconnect. The web API applies per-process rate limiting (3/hr per `machineId:processName`), queues the event, and `/api/cron/process-alerts` emails a per-site digest every 3 minutes to users who have `processAlerts !== false`.

### 3-Mode Launch System

Processes use a `launch_mode` field instead of a binary `autolaunch` toggle:

| Mode | Behavior |
|------|----------|
| `off` | Process is not launched or monitored (status: INACTIVE) |
| `always` | Process is always launched and monitored (equivalent to old `autolaunch: true`) |
| `scheduled` | Process is launched only during configured schedule windows |

**Schedule enforcement** happens in the `main()` loop:
- Each process can have a `schedules` array of `ScheduleBlock` objects: `{ name?, colorIndex?, days: string[], ranges: [{ start: "HH:MM", stop: "HH:MM" }] }`
- `is_within_schedule(schedules, timezone_str)` in `shared_utils.py` checks the current time in the site timezone against every window
- When in `scheduled` mode and outside the window, the process is treated as INACTIVE: not launched, and a running one is stopped (identity-gated, through `graceful_terminate`)
- When the schedule window opens, the process is launched automatically

**Manual override tracking**: If a user manually starts/stops a process via the dashboard while in `scheduled` mode, the agent records it in `manual_overrides` so it does not fight the user's intent; the override clears when the next window opens.

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
- **Heartbeat + metrics**: one `_metrics_loop` writes `online`, `lastHeartbeat` and the `metrics` map onto `sites/{siteId}/machines/{machineId}` — every 5s while the desktop window is open, 30s while any process is running or while disconnected, 120s idle. `_update_presence` runs only at start and stop.
- **Config sync**: On change → `config/{siteId}/machines/{machineId}`

**Background threads** (supervised by ConnectionManager; both poll via `listen_to_document`):
- `command_listener` — polls `sites/{siteId}/machines/{machineId}/commands/pending` every 2-5s
- `config_listener` — polls `config/{siteId}/machines/{machineId}`

**Offline resilience**:
- Config cached to `cache/firebase_cache.json`
- Loaded on connection failure, re-uploaded on reconnect
- Hash-based dedup prevents re-uploading unchanged config

**Key methods**:
- `start()` / `stop()` — lifecycle management
- `register_command_callback(fn)` — service registers command handler
- `register_config_update_callback(fn)` — service registers config handler
- `register_removed_callback(fn)` — service registers what leaves the site once the dashboard removed this machine (its config doc vanished); the client stops every write and deletes its row again
- `log_event(action, level, process_name=None, details=None, ...)` — log events for web dashboard
- `send_process_alert(process_name, error_message, event_type)` — fire-and-forget alert via `/api/agent/alert` (daemon thread, non-blocking)
- `finish_command(cmd_id, cmd_data, result)` / `update_command_progress(...)` — terminal and progress writes for commands
- `set_machine_flags(flags)` — rebooting / shuttingDown / rebootPending on the machine doc
- `is_connected()` — check connection state

### ConnectionManager (`connection_manager.py`)

**State machine**:
```
DISCONNECTED → CONNECTING → CONNECTED
                    ↑           ↓
                 RECONNECTING ← (error)
                    ↓
                 BACKOFF → (wait) → RECONNECTING

FATAL_ERROR exists but nothing enters it; errors that look fatal (revoked credential, site gone) only lengthen the backoff to FATAL_ERROR_BACKOFF = 3600s and still retry. A dashboard removal is handled by FirebaseClient, a refused refresh by AuthManager(on_revoked=...)
```

**Exponential backoff**: base=30s, max=3600s, formula: `min(current * 2, MAX)`, jitter: 50-100% (prevents thundering herd from multiple agents reconnecting simultaneously)

**Circuit breaker**: Opens after 5 consecutive failures, tests recovery after 5 minutes

**Thread supervision**: Watchdog checks every 10s, auto-restarts dead listener threads on next successful connection

**Key methods**:
- `connect()` / `shutdown()` / `reset()` — control state
- `report_error(exception, context)` — any component reports failures here
- `report_success()` — resets failure counters
- `register_thread(name, factory)` — register supervised thread
- `start_watchdog()` — enable thread health checks
- `add_state_listener(callback)` — subscribe to state changes
- `force_reconnect()` — bypass backoff for immediate retry

### OAuth Two-Token System (`auth_manager.py`)

**Tokens**:
- **Access token**: 1-hour Firebase ID token for Firestore REST API
- **Refresh token**: does not expire (admin-revocable); the server rotates it on every refresh with a 5-minute grace window, and the agent persists the new one

**Auto-refresh**: 5 minutes before expiry (`TOKEN_REFRESH_BUFFER_SECONDS = 300`)

**Flow**: `get_valid_token()` → check cached → if expired → `POST /api/agent/auth/refresh` → cache new token

**Pairing**: `request_device_code()` gets a 3-word phrase, an operator authorizes it at owlette.app/add or on the dashboard, `poll_device_code()` polls `/api/agent/auth/device-code/poll` and stores the tokens.

**Error handling**:
- 401/403: Clear tokens, require re-registration
- 429: Rate limited → backoff
- Network errors: `TokenRefreshNetworkError`, retried every `TOKEN_REFRESH_NETWORK_RETRY_SECONDS = 10`

**Exceptions**: `AuthenticationError` (fatal), `TokenRefreshError` (retriable)

### Encrypted Token Storage (`secure_storage.py`)

**File**: `<data root>\.tokens.enc` (`C:\ProgramData\Owlette\.tokens.enc` on Windows; hidden file)

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

**Access**: protected DACL — SYSTEM and Administrators full control, Modify for the writing (or console) user; `.tokens.enc.v1` gets the same.

---

## Command Handling

Commands are `{type, ...params}` map fields of the single `commands/pending` document, keyed by command id. `handle_firebase_command(cmd_id, cmd_data)` dispatches through `CommandRouter` first (handlers registered by `process_commands`, `machine_commands`, `sync_commands`, `swoop_commands`, `site_commands`) and falls back to the legacy if/elif chain in `owlette_service.py`. `firebase_client._execute_command` → `finish_command` writes the result into the `commands/completed` document and deletes the pending field; a result starting with `Error:` is recorded as failed.

**Lanes**: fast commands (`mcp_tool_call`, `capture_screenshot`, `cancel_sync`, `cancel_mcp_tool`, `swoop_*`, `site_settings_refresh` — `_FAST_COMMAND_TYPES`) get a thread each; everything else runs on one serialised slow worker.

### Supported Commands (main ones)

| Command | Data Fields | Behavior |
|---------|-------------|----------|
| `restart_process` | `process_id` or `process_name` | Kill running process + relaunch (router, `process_commands.py`) |
| `start_process` / `stop_process` | `process_id` or `process_name` | Launch / stop one process |
| `kill_process` | `process_id` or `process_name` | Identity gate (`_resolve_kill_target`), then `shared_utils.graceful_terminate(pid, exe_path=…)` |
| `set_launch_mode` | `process_id` or `process_name`, `mode`, optional `schedules` | Update launch mode (`off`/`always`/`scheduled`), affects next cycle |
| `update_config` | `config` (full object) | Replace local config, preserve firebase section |
| `install_software` | `installer_url`, `installer_name`, `silent_flags`, `timeout_seconds` (default 2400), `sha256_checksum`, `deployment_id`, optional `verify_path`, `parallel_install`, `close_processes`, `suppress_projects` | Download + execute installer |
| `cancel_installation` / `uninstall_software` / `cancel_uninstall` | deployment fields | Deployment control |
| `update_owlette` | `installer_url`, `checksum_sha256`, `target_version` | Self-update (see the build-system skill) |
| `reboot_machine` | — | Set `rebooting` + `rebootScheduledAt`, `osadapter.reboot(REBOOT_OS_COUNTDOWN_SECONDS = 60)` |
| `shutdown_machine` | — | Set `shuttingDown` + `shutdownScheduledAt`, `osadapter.shutdown(60)` |
| `cancel_reboot` | — | Abort the OS countdown, clear `rebooting`/`shuttingDown` flags |
| `dismiss_reboot_pending` | `process_name` | Clear `rebootPending` flag, reset relaunch counter for process; the desktop app closes its own prompt |
| `capture_screenshot` | — | Capture in the user session → signed-url PUT → `screenshots/finalize` |
| `sync_pull` / `cancel_sync` / `rollback_to_version` | roost fields | roost sync (`sync_commands.py`) |
| `swoop_session_requested` / `swoop_kill` / `swoop_refresh` | session fields | swoop (`swoop_commands.py`) |
| `mcp_tool_call` / `cancel_mcp_tool` / `provision_cortex_key` | tool fields | hoot |

Others: `toggle_autolaunch`, `refresh_software_inventory`, `start_live_view`, `stop_live_view`, the display-topology commands, `site_settings_refresh`.

### Machine Flags (Firestore)

Written to `sites/{siteId}/machines/{machineId}` via `set_machine_flags`:

| Flag | Set By | Cleared By | Purpose |
|------|--------|-----------|---------|
| `rebooting: true` | `_handle_reboot_machine`, `_check_scheduled_reboot` | Agent startup, `_handle_cancel_reboot` | Dashboard shows "Rebooting..." badge |
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

## IPC: Service ↔ Desktop App Tray

**Mechanism**: Status file written by service, read by the desktop app's tray (`desktop/src-tauri/src/tray.rs`).

**Path**: `<data root>\tmp\service_status.json`

**Written**: called every 5s tick but throttled — written on a state change or at least every 30s (`MIN_STATUS_WRITE_INTERVAL`)

**Structure**:
```json
{
  "service": { "running": true, "last_update": 1234567890, "version": "4.1.7" },
  "firebase": { "enabled": true, "connected": true, "site_id": "...", "site_name": "...", "schedule_timezone": "...", "last_heartbeat": 1234567890 },
  "health": { ... }, "swoop": { ... }, "keep_awake": { ... }
}
```

**Tray status** (`determine_status` in `tray.rs`, in precedence order):
- Error: service stopped (SCM), file older than 120s ("not responding"), health probe failing while disconnected, or not paired
- Warning: file missing or unreadable ("starting"), or otherwise not connected
- Normal: connected

### User-Session Execution (`session_exec.py`, Windows)

**Mechanism**: The service launches `session_exec.py` in the interactive user's desktop session via `CreateProcessAsUser`. This enables execution of Python code, shell commands, and PowerShell scripts with full desktop/GPU access. Off Windows, `ipc/jobs` is the desktop app's queue, filled through `osadapter.run_job`.

**Path**: `<data root>\ipc\jobs\` (job files) + `<data root>\ipc\results\{requestId}\` (output)

**Flow**:
1. Service writes job JSON to `ipc/jobs/{requestId}.json`: `{ type, code, timeout, outputDir }` (timeout capped at 120s)
2. Service launches `session_exec.py {job_path}` via `CreateProcessAsUser` in the active console session
3. `session_exec.py` reads the job, executes (python/cmd/powershell), writes `result.json` + any output files to `outputDir`
4. Service polls for `result.json` (timeout + 5s grace), returns parsed result
5. Cleanup: job file deleted, result dir cleaned by caller

**Job types**: `python` (exec'd in-process), `cmd` (subprocess), `powershell` (subprocess)

**Session 0 note**: The service runs in Session 0 (no desktop access). `session_exec.py` is launched in the user's interactive session via the same `CreateProcessAsUser` mechanism used for managed processes.

**Consumers**:
- `capture_screenshot` command — runs the capture through `execute_in_user_session`
- MCP `run_command` / `run_powershell` — with `user_session=true` param

---

## Known Limitations

### Slow Commands Serialise Behind Installs

Everything outside the fast lane runs on one worker, so a long `install_software` / `uninstall_software` (download + install, can be minutes) delays reboots, process commands and config updates queued behind it. Screenshots, MCP tools, swoop and the cancel commands run on the fast lane and are not blocked.

---

## Critical Maintenance Rules

### Do's
- Always preserve `firebase` config section during config updates
- Use atomic file writes (.tmp → rename) for config changes
- Validate PID identity (`identity_matches`) during recovery
- Report all errors to ConnectionManager (centralized handling)
- Use `shared_utils.read_json_from_file()` for all JSON reads (it returns `{}` on failure)
- Test token refresh error paths (rotation and revocation)

### Don'ts
- Never log OAuth tokens (even in DEBUG mode) — sanitize in auth_manager.py
- Never write credentials to config.json (tokens go to .tokens.enc only)
- Never modify the firebase section during remote config updates
- Never skip PID validation in `recover_running_processes()`
- Never use blocking operations in the 5-second main loop
- Never spawn reconnection logic outside ConnectionManager (it's the single source of truth)

### Debugging
- Service logs: `C:\ProgramData\Owlette\logs\service.log`
- Host and captured output: `logs\service_host.log`, `logs\service_stdout.log`, `logs\service_stderr.log`
- Pairing / hoot / self-update: `logs\pairing_debug.log`, `logs\cortex.log`, `logs\installer_update.log`
- Desktop app: `%LOCALAPPDATA%\app.owlette.desktop\logs\owlette-desktop.log`
- Status file: `C:\ProgramData\Owlette\tmp\service_status.json`
- Config: `C:\ProgramData\Owlette\config\config.json`
- Debug mode: `cd agent\src && ..\.venv\Scripts\python owlette_runner.py --debug` (admin shell, installed service stopped; macOS/Linux `sudo ../.venv/bin/python owlette_runner.py --debug`)
