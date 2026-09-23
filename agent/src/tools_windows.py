"""The Windows arm of the hoot tool surface.

Seventeen of the tools in `mcp_tools.execute_tool` are Windows-shaped — the
registry, the SCM, the task scheduler, PowerShell. They live here so that
importing `mcp_tools` on macOS or Linux never touches `winreg` or pywin32;
`mcp_tools._platform_handlers()` imports this module only when it is running on
Windows, and `tools_posix.py` answers the six that have a POSIX backend.

Every subprocess goes through `mcp_tools.run_capture`, so a timeout or a missing
binary is a -1 return code with the reason in stderr rather than a raise.
"""

import json
import logging
import os
import re
import subprocess
import time
import winreg
from datetime import datetime

import psutil

import mcp_tools
import shared_utils

logger = logging.getLogger(__name__)

# The UpdateOrchestrator task Windows uses to schedule its own reboot.
_REBOOT_TASK = r'\Microsoft\Windows\UpdateOrchestrator\Reboot'

# EventLogEntryType, which ConvertTo-Json serialises as the enum's integer, in
# the level names get_event_logs takes as a parameter and the POSIX arm reports.
_ENTRY_TYPES = {
    1: 'Error', 2: 'Warning', 4: 'Information',
    8: 'SuccessAudit', 16: 'FailureAudit',
}


# Helpers


def _sc_exe(args, timeout=15):
    """Run sc.exe with a safe argument list. Returns (returncode, stdout, stderr)."""
    return mcp_tools.run_capture(['sc.exe'] + list(args), timeout)


def _parse_sc_qc(output):
    """Parse `sc qc <service>` text output into a dict."""
    info = {}
    current_key = None
    for line in output.splitlines():
        if ':' in line and not line.startswith(' '):
            key, _, val = line.partition(':')
            current_key = key.strip().lower().replace(' ', '_')
            info[current_key] = val.strip()
        elif line.strip() and current_key:
            # Continuation line (dependencies, etc.)
            info[current_key] = (info.get(current_key, '') + ' ' + line.strip()).strip()
    return info


def _key_exists(hive, path):
    try:
        with winreg.OpenKey(hive, path):
            return True
    except (FileNotFoundError, OSError):
        return False


def _value_exists(hive, path, name):
    try:
        with winreg.OpenKey(hive, path) as k:
            winreg.QueryValueEx(k, name)
            return True
    except (FileNotFoundError, OSError):
        return False


def _open_or_create(hive, path, access=winreg.KEY_READ | winreg.KEY_WRITE):
    try:
        return winreg.OpenKey(hive, path, 0, access)
    except FileNotFoundError:
        return winreg.CreateKey(hive, path)


def _read_dword(hive, path, name):
    try:
        with winreg.OpenKey(hive, path) as k:
            val, _ = winreg.QueryValueEx(k, name)
            return val
    except (FileNotFoundError, OSError):
        return None


# Machine-wide policies: (key_path, value_name, dword_value)
_SETUP_MACHINE_KEYS = {
    'privacy_experience': (r'SOFTWARE\Policies\Microsoft\Windows\OOBE', 'DisablePrivacyExperience', 1),
    'edge_first_run': (r'SOFTWARE\Policies\Microsoft\Edge', 'HideFirstRunExperience', 1),
}


# Per-user keys, relative to each user hive root
_SETUP_USER_KEYS = {
    'scoobe': (r'Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement', 'ScoobeSystemSettingEnabled', 0),
    'welcome_experience': (r'Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager', 'SubscribedContent-310093Enabled', 0),
    'welcome_experience_policy': (r'Software\Policies\Microsoft\Windows\CloudContent', 'DisableWindowsSpotlightWindowsWelcomeExperience', 1),
}


_PROFILE_LIST_KEY = r'SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList'


_SETUP_MOUNT_NAME = 'OwletteSetupScreens'


def _write_dword(root, path, name, value):
    """Create-or-set. Returns 'set' if the value changed, 'ok' if already right."""
    if _read_dword(root, path, name) == value:
        return 'ok'
    with winreg.CreateKey(root, path) as k:
        winreg.SetValueEx(k, name, 0, winreg.REG_DWORD, value)
    return 'set'


def _enumerate_profiles():
    """Real user profiles from ProfileList: [(sid, ntuser_dat_path)]."""
    profiles = []
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, _PROFILE_LIST_KEY) as k:
            i = 0
            while True:
                try:
                    sid = winreg.EnumKey(k, i)
                except OSError:
                    break
                i += 1
                if not sid.startswith('S-1-5-21-'):
                    continue
                try:
                    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, f'{_PROFILE_LIST_KEY}\\{sid}') as pk:
                        image_path, _ = winreg.QueryValueEx(pk, 'ProfileImagePath')
                    expanded = winreg.ExpandEnvironmentStrings(image_path)
                    profiles.append((sid, os.path.join(expanded, 'NTUSER.DAT')))
                except (FileNotFoundError, OSError):
                    continue
    except (FileNotFoundError, OSError) as e:
        logger.warning(f"suppress_setup_screens: ProfileList enumeration failed: {e}")
    return profiles


def _hive_loaded(sid):
    try:
        with winreg.OpenKey(winreg.HKEY_USERS, sid):
            return True
    except (FileNotFoundError, OSError):
        return False


def _reg_exe(args):
    rc, out, err = mcp_tools.run_capture(['reg.exe'] + list(args), 15)
    return rc, (err or out or '').strip()


def _unmount_hive():
    """Unload the temp hive. Handles must be closed first; retry briefly."""
    import gc
    gc.collect()
    for attempt in range(3):
        code, msg = _reg_exe(['unload', f'HKU\\{_SETUP_MOUNT_NAME}'])
        if code == 0:
            return None
        time.sleep(0.5)
    return f'reg unload failed: {msg}'


def _apply_user_keys(hive_root_path):
    """Write all _SETUP_USER_KEYS under HKU\\<hive_root_path>. Returns (set, ok, errors)."""
    wrote, already, errors = [], [], []
    for label, (path, name, value) in _SETUP_USER_KEYS.items():
        try:
            outcome = _write_dword(winreg.HKEY_USERS, f'{hive_root_path}\\{path}', name, value)
            (wrote if outcome == 'set' else already).append(label)
        except Exception as e:
            errors.append(f'{label}: {e}')
    return wrote, already, errors


def _apply_mounted(ntuser_path, target_desc):
    """Mount an offline NTUSER.DAT, write the keys, and always unload."""
    if not os.path.isfile(ntuser_path):
        return {'target': target_desc, 'error': f'hive file not found: {ntuser_path}'}
    code, msg = _reg_exe(['load', f'HKU\\{_SETUP_MOUNT_NAME}', ntuser_path])
    if code != 0:
        return {'target': target_desc, 'error': f'reg load failed: {msg}'}
    try:
        wrote, already, errors = _apply_user_keys(_SETUP_MOUNT_NAME)
    finally:
        unload_error = _unmount_hive()
    entry = {'target': target_desc, 'hive': 'mounted', 'applied': wrote, 'already_ok': already}
    problems = errors + ([unload_error] if unload_error else [])
    if problems:
        entry['error'] = '; '.join(problems)
    return entry


def _default_profile_hive():
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, _PROFILE_LIST_KEY) as k:
            path, _ = winreg.QueryValueEx(k, 'Default')
        return os.path.join(winreg.ExpandEnvironmentStrings(path), 'NTUSER.DAT')
    except (FileNotFoundError, OSError):
        return os.path.join(os.environ.get('SystemDrive', 'C:') + os.sep, 'Users', 'Default', 'NTUSER.DAT')


def _ps_escape(s):
    """Escape a string for embedding in a PowerShell double-quoted string."""
    if s is None:
        return ''
    return str(s).replace('`', '``').replace('"', '`"').replace('$', '`$')


def _run_powershell_script(script, timeout=60, bypass=True):
    """Run an inline PowerShell script. Returns (rc, stdout, stderr).

    `bypass` suppresses a GPO execution policy, which the handlers that run
    scripts need on a locked-down kiosk; the read-only queries inherit the
    machine's policy instead.
    """
    policy = ['-ExecutionPolicy', 'Bypass'] if bypass else []
    return mcp_tools.run_capture(
        ['powershell', '-NoProfile'] + policy + ['-Command', script],
        timeout,
    )


# Key path prefixes registry_operation may touch (case-insensitive). Mirrors the
# _validate_file_path() allowlist pattern.
_SAFE_REGISTRY_PREFIXES = (
    # Auto-login configuration
    r'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon',
    # GPU / TDR settings
    r'SYSTEM\CurrentControlSet\Control\GraphicsDrivers',
    # Windows Update policy + UX
    r'SOFTWARE\Microsoft\WindowsUpdate',
    r'SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate',
    # Notifications / push notifications (HKCU paths, hive passed separately)
    r'SOFTWARE\Microsoft\Windows\CurrentVersion\PushNotifications',
    r'SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications',
    r'SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Advanced',
    # Power policy
    r'SYSTEM\CurrentControlSet\Control\Power',
    # Service parameters (specific services)
    r'SYSTEM\CurrentControlSet\Services',
    # Owlette-managed keys (safe by definition)
    r'SOFTWARE\Owlette',
)


# Forbidden paths — rejected even if they happen to prefix-match something above
_FORBIDDEN_REGISTRY_PREFIXES = (
    r'SAM',                                         # local account password hashes
    r'SECURITY',                                    # LSA secrets, audit config
    r'SOFTWARE\Microsoft\Cryptography',             # machine GUID, crypto config
    r'SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList',  # user SIDs
)


def _validate_registry_path(hive, key_path):
    """Validate a registry hive+key_path against allowlist/blocklist.

    Returns (ok, error_message_or_none).
    """
    if hive not in ('HKLM', 'HKCU'):
        return False, f"Unsupported hive '{hive}'. Must be HKLM or HKCU."
    if not key_path or not isinstance(key_path, str):
        return False, 'key_path is required'

    key_lower = key_path.lower().lstrip('\\')

    # Blocklist wins over the allowlist
    for forbidden in _FORBIDDEN_REGISTRY_PREFIXES:
        if key_lower.startswith(forbidden.lower()):
            return False, f"Registry path '{key_path}' is in the forbidden list"

    for allowed in _SAFE_REGISTRY_PREFIXES:
        if key_lower.startswith(allowed.lower()):
            return True, None

    return False, (
        f"Registry path '{key_path}' is not in the allowlist. "
        f"Allowed prefixes: {', '.join(_SAFE_REGISTRY_PREFIXES)}"
    )


# Tier 1: read-only


def get_gpu_processes(params, config):
    """Get per-process GPU memory (VRAM) usage via Windows Performance Counters.

    Uses the \\GPU Process Memory(*)\\ counters (same data source as Task Manager).
    This is the only reliable method on Windows WDDM — nvidia-smi and pynvml both
    return [N/A] or 0 for DirectX/OpenGL graphics processes. Works cross-vendor
    (NVIDIA, AMD, Intel).

    GPU-level totals (model, total/used VRAM) are enriched via pynvml if available.
    """
    # Step 1: Query Windows Performance Counters via PowerShell
    ps_script = (
        "$d = (Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -EA SilentlyContinue).CounterSamples;"
        "$s = (Get-Counter '\\GPU Process Memory(*)\\Shared Usage' -EA SilentlyContinue).CounterSamples;"
        "$r = @{dedicated=@(); shared=@()};"
        "foreach ($x in $d) { $r.dedicated += @{i=$x.InstanceName; v=$x.CookedValue} };"
        "foreach ($x in $s) { $r.shared += @{i=$x.InstanceName; v=$x.CookedValue} };"
        "$r | ConvertTo-Json -Depth 3 -Compress"
    )

    rc, out, err = _run_powershell_script(ps_script, timeout=15, bypass=False)
    if rc != 0 or not out.strip():
        return {'error': f'GPU Performance Counters unavailable: {(err or out).strip() or "no output"}'}

    try:
        data = json.loads(out)
    except ValueError as e:
        return {'error': f'GPU counter query failed: {e}'}

    # Step 2: Parse PIDs and aggregate per-process
    pid_pattern = re.compile(r'pid_(\d+)_')
    per_pid = {}  # pid -> {dedicated_bytes, shared_bytes}

    for entry in data.get('dedicated', []):
        match = pid_pattern.search(entry.get('i', ''))
        if not match:
            continue
        pid = int(match.group(1))
        per_pid.setdefault(pid, {'dedicated_bytes': 0, 'shared_bytes': 0})
        per_pid[pid]['dedicated_bytes'] += entry.get('v', 0)

    for entry in data.get('shared', []):
        match = pid_pattern.search(entry.get('i', ''))
        if not match:
            continue
        pid = int(match.group(1))
        per_pid.setdefault(pid, {'dedicated_bytes': 0, 'shared_bytes': 0})
        per_pid[pid]['shared_bytes'] += entry.get('v', 0)

    # Step 3: Resolve process names and build result list
    processes = []
    for pid, mem in per_pid.items():
        dedicated_mb = round(mem['dedicated_bytes'] / (1024 * 1024), 1)
        shared_mb = round(mem['shared_bytes'] / (1024 * 1024), 1)

        # Skip processes with negligible GPU memory (< 1 MB dedicated)
        if dedicated_mb < 1 and shared_mb < 1:
            continue

        proc_name = 'Unknown'
        try:
            proc_name = psutil.Process(pid).name()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass

        processes.append({
            'pid': pid,
            'name': proc_name,
            'dedicated_gpu_mb': dedicated_mb,
            'shared_gpu_mb': shared_mb,
        })

    processes.sort(key=lambda p: p['dedicated_gpu_mb'], reverse=True)

    # Step 4: Enrich with GPU-level totals from NVML (NVIDIA)
    gpu_info = mcp_tools.gpu_totals()

    return {
        'processes': processes,
        'process_count': len(processes),
        'gpu': gpu_info,
    }


def get_event_logs(params, config):
    """Get Windows event logs (Application, System, or Security)."""
    log_name = params.get('log_name', 'Application')
    max_events = min(params.get('max_events', 20), 100)
    level_filter = params.get('level', None)  # 'Error', 'Warning', 'Information'

    ps_cmd = f'Get-EventLog -LogName {log_name} -Newest {max_events * 2}'
    if level_filter:
        ps_cmd += f' -EntryType {level_filter}'
    ps_cmd += ' | Select-Object -First ' + str(max_events) + ' TimeGenerated, EntryType, Source, Message | ConvertTo-Json -Depth 2'

    rc, out, err = _run_powershell_script(ps_cmd, timeout=mcp_tools.SUBPROCESS_TIMEOUT, bypass=False)
    if rc != 0:
        return {'error': f'Failed to query event logs: {(err or out).strip()[:500]}'}

    try:
        events = json.loads(out) if out.strip() else []
    except ValueError:
        return {'error': 'Failed to parse event log output'}
    if isinstance(events, dict):
        events = [events]

    now = datetime.now()
    formatted = []
    for evt in events[:max_events]:
        raw_time = evt.get('TimeGenerated', '')
        entry = {
            'time': raw_time,
            'level': _ENTRY_TYPES.get(evt.get('EntryType'), ''),
            'source': evt.get('Source', ''),
            'message': (evt.get('Message', '') or '')[:500],
        }
        # PowerShell serialises DateTime as /Date(<epoch ms>)/.
        if isinstance(raw_time, str) and '/Date(' in raw_time:
            try:
                dt = datetime.fromtimestamp(int(raw_time.split('(')[1].split(')')[0]) / 1000)
            except (ValueError, IndexError):
                dt = None
            if dt is not None:
                entry['time'] = dt.strftime('%Y-%m-%d %H:%M:%S')
                entry['time_ago'] = mcp_tools.time_ago(dt, now)
        formatted.append(entry)

    return {'log_name': log_name, 'events': formatted, 'count': len(formatted)}


def get_service_status(params, config):
    """Get Windows service status by name, including start type for proper interpretation."""
    service_name = params.get('service_name')
    if not service_name:
        return {'error': 'service_name parameter is required'}

    try:
        import win32service
        import win32serviceutil

        status = win32serviceutil.QueryServiceStatus(service_name)
        state_map = {
            win32service.SERVICE_STOPPED: 'stopped',
            win32service.SERVICE_START_PENDING: 'start_pending',
            win32service.SERVICE_STOP_PENDING: 'stop_pending',
            win32service.SERVICE_RUNNING: 'running',
            win32service.SERVICE_CONTINUE_PENDING: 'continue_pending',
            win32service.SERVICE_PAUSE_PENDING: 'pause_pending',
            win32service.SERVICE_PAUSED: 'paused',
        }

        start_type = 'unknown'
        try:
            scm = win32service.OpenSCManager(None, None, win32service.SC_MANAGER_CONNECT)
            try:
                svc = win32service.OpenService(scm, service_name, win32service.SERVICE_QUERY_CONFIG)
                try:
                    cfg = win32service.QueryServiceConfig(svc)
                    start_type_map = {
                        win32service.SERVICE_AUTO_START: 'automatic',
                        win32service.SERVICE_BOOT_START: 'boot',
                        win32service.SERVICE_DEMAND_START: 'demand_start',
                        win32service.SERVICE_DISABLED: 'disabled',
                        win32service.SERVICE_SYSTEM_START: 'system',
                    }
                    start_type = start_type_map.get(cfg[1], 'unknown')
                finally:
                    win32service.CloseServiceHandle(svc)
            finally:
                win32service.CloseServiceHandle(scm)
        except Exception:
            pass  # Non-critical — status is still valid without start type

        result = {
            'service_name': service_name,
            'status': state_map.get(status[1], 'unknown'),
            'start_type': start_type,
            'service_type': status[0],
            'current_state': status[1],
        }

        # Add interpretive note for demand-start services that are stopped (normal idle state)
        if result['status'] == 'stopped' and start_type == 'demand_start':
            result['note'] = (
                'This is a demand-start service — it starts only when needed and stops when idle. '
                'A "stopped" status is normal and does NOT mean the service is disabled or broken. '
                'For Windows Update (wuauserv), "stopped" means no update check or install is '
                'currently in progress; updates are still enabled unless the start type is "disabled".'
            )

        return result
    except Exception as e:
        return {'error': f'Failed to query service {service_name}: {e}'}


def check_pending_reboot(params, config):
    """Tier 1: Detect whether a system reboot is pending (read-only)."""
    reasons = []

    if _key_exists(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'):
        reasons.append('windows_update')
    if _key_exists(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'):
        reasons.append('cbs')
    if _value_exists(winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Control\Session Manager', 'PendingFileRenameOperations'):
        reasons.append('pending_file_rename')
    if _key_exists(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Updates\UpdateExeVolatile'):
        reasons.append('sccm_client')

    # Query scheduled update tasks for next-run time
    next_scheduled = None
    rc, out, _ = mcp_tools.run_capture(
        ['schtasks.exe', '/Query', '/TN', _REBOOT_TASK, '/FO', 'LIST', '/V'], 10,
    )
    if rc == 0:
        for line in out.splitlines():
            if line.strip().startswith('Next Run Time:'):
                next_scheduled = line.split(':', 1)[1].strip()
                break

    # Last update installed time (HotFixID from last Get-HotFix)
    last_update = None
    rc, out, _ = _run_powershell_script(
        '(Get-HotFix | Sort-Object InstalledOn -Descending | Select -First 1).InstalledOn',
        timeout=15, bypass=False,
    )
    if rc == 0 and out.strip():
        last_update = out.strip()

    return {
        'pending': bool(reasons),
        'reasons': reasons,
        'last_update_installed': last_update,
        'next_scheduled_update': {'task': _REBOOT_TASK, 'next_run': next_scheduled} if next_scheduled else None,
    }


# Tier 2: purpose-built admin


def manage_windows_service(params, config):
    """Full services.msc parity: state, startup, recovery, details."""
    action = (params.get('action') or '').lower()
    service_name = (params.get('service_name') or '').strip()

    if not service_name:
        return {'error': 'service_name is required'}
    # Basic validation: service names are alphanumeric + underscore/hyphen/dot
    if not re.match(r'^[\w.\-]+$', service_name):
        return {'error': f"Invalid service_name '{service_name}'"}

    logger.info(f"[MCP-AUDIT] manage_windows_service: action={action} service={service_name}")

    try:
        import win32service
        import win32serviceutil
    except ImportError:
        return {'error': 'pywin32 not available'}

    # State operations
    if action in ('start', 'stop', 'restart', 'pause', 'continue'):
        try:
            if action == 'start':
                win32serviceutil.StartService(service_name)
            elif action == 'stop':
                win32serviceutil.StopService(service_name)
            elif action == 'restart':
                win32serviceutil.RestartService(service_name)
            elif action == 'pause':
                win32serviceutil.ControlService(service_name, win32service.SERVICE_CONTROL_PAUSE)
            elif action == 'continue':
                win32serviceutil.ControlService(service_name, win32service.SERVICE_CONTROL_CONTINUE)
            return {'action': action, 'service': service_name, 'status': 'ok'}
        except Exception as e:
            return {'error': f'{action} failed: {e}'}

    # Set startup type
    if action == 'set_startup':
        startup = (params.get('startup_type') or '').lower()
        mapping = {
            'auto': 'auto', 'auto_delayed': 'delayed-auto',
            'manual': 'demand', 'disabled': 'disabled',
        }
        if startup not in mapping:
            return {'error': f"Invalid startup_type. Use: {', '.join(mapping)}"}
        rc, out, err = _sc_exe(['config', service_name, f'start={mapping[startup]}'])
        if rc != 0:
            return {'error': f'sc config failed: {err or out}'}
        return {'action': action, 'service': service_name, 'startup_type': startup, 'status': 'ok'}

    # Set recovery / failure actions
    if action == 'set_recovery':
        action_map = {'restart': 'restart', 'run_program': 'run', 'reboot': 'reboot', 'none': ''}
        first = params.get('first_failure', 'restart').lower()
        second = params.get('second_failure', 'restart').lower()
        subsequent = params.get('subsequent_failures', 'reboot').lower()
        for name, val in [('first_failure', first), ('second_failure', second), ('subsequent_failures', subsequent)]:
            if val not in action_map:
                return {'error': f"Invalid {name} '{val}'. Use: {', '.join(action_map)}"}

        delay_ms = int(params.get('restart_delay_ms', 60000))
        reset_days = int(params.get('reset_counter_days', 1))
        reset_seconds = reset_days * 86400
        reboot_msg = params.get('reboot_message', '')
        run_prog = params.get('run_program_path', '')

        # actions format: action1/delay/action2/delay/action3/delay
        actions_str = f'{action_map[first]}/{delay_ms}/{action_map[second]}/{delay_ms}/{action_map[subsequent]}/{delay_ms}'
        sc_args = ['failure', service_name, f'reset={reset_seconds}', f'actions={actions_str}']
        if reboot_msg:
            sc_args.append(f'reboot={reboot_msg}')
        if run_prog:
            sc_args.append(f'command={run_prog}')

        rc, out, err = _sc_exe(sc_args)
        if rc != 0:
            return {'error': f'sc failure failed: {err or out}'}

        # Also enable "Enable actions for stops with errors" (on by default but make explicit)
        _sc_exe(['failureflag', service_name, '1'])

        return {
            'action': action,
            'service': service_name,
            'recovery': {
                'first_failure': first, 'second_failure': second,
                'subsequent_failures': subsequent,
                'restart_delay_ms': delay_ms, 'reset_counter_days': reset_days,
                'reboot_message': reboot_msg or None, 'run_program_path': run_prog or None,
            },
            'status': 'ok',
        }

    # Get full details
    if action == 'get_details':
        rc, qc_out, qc_err = _sc_exe(['qc', service_name])
        if rc != 0:
            return {'error': f'Service not found or sc qc failed: {qc_err or qc_out}'}
        qc = _parse_sc_qc(qc_out)

        _, qf_out, _ = _sc_exe(['qfailure', service_name])
        recovery_text = qf_out

        _, qd_out, _ = _sc_exe(['qdescription', service_name])
        description = ''
        for line in qd_out.splitlines():
            if 'DESCRIPTION:' in line.upper():
                description = line.split(':', 1)[1].strip()

        status_name = 'unknown'
        process_id = None
        try:
            status = win32serviceutil.QueryServiceStatus(service_name)
            status_map = {1: 'stopped', 2: 'start_pending', 3: 'stop_pending',
                          4: 'running', 5: 'continue_pending', 6: 'pause_pending', 7: 'paused'}
            status_name = status_map.get(status[1], f'unknown({status[1]})')
        except Exception:
            pass

        return {
            'service': service_name,
            'display_name': qc.get('display_name'),
            'description': description,
            'status': status_name,
            'process_id': process_id,
            'start_type': qc.get('start_type'),
            'binary_path': qc.get('binary_path_name'),
            'log_on_account': qc.get('service_start_name'),
            'dependencies': qc.get('dependencies'),
            'recovery_raw': recovery_text,
        }

    return {'error': f"Unknown action '{action}'. Use: start/stop/restart/pause/continue/set_startup/set_recovery/get_details"}


def configure_gpu_tdr(params, config):
    """Set Windows GPU TDR (Timeout Detection and Recovery) timeout values.

    Writes TdrDelay and optionally TdrDdiDelay under
    HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers.
    Requires a reboot to take effect.
    """
    try:
        timeout = int(params.get('timeout_seconds', 0))
    except (TypeError, ValueError):
        return {'error': 'timeout_seconds must be an integer'}
    if not (2 <= timeout <= 300):
        return {'error': 'timeout_seconds must be between 2 and 300'}

    ddi_timeout = params.get('ddi_timeout_seconds')
    if ddi_timeout is not None:
        try:
            ddi_timeout = int(ddi_timeout)
            if not (2 <= ddi_timeout <= 300):
                return {'error': 'ddi_timeout_seconds must be between 2 and 300'}
        except (TypeError, ValueError):
            return {'error': 'ddi_timeout_seconds must be an integer'}

    logger.info(f"[MCP-AUDIT] configure_gpu_tdr: timeout={timeout}s ddi_timeout={ddi_timeout}")

    key_path = r'SYSTEM\CurrentControlSet\Control\GraphicsDrivers'
    previous = {}
    new_values = {}

    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key_path, 0,
                            winreg.KEY_READ | winreg.KEY_WRITE) as key:
            try:
                previous['TdrDelay'], _ = winreg.QueryValueEx(key, 'TdrDelay')
            except FileNotFoundError:
                previous['TdrDelay'] = None
            try:
                previous['TdrDdiDelay'], _ = winreg.QueryValueEx(key, 'TdrDdiDelay')
            except FileNotFoundError:
                previous['TdrDdiDelay'] = None

            winreg.SetValueEx(key, 'TdrDelay', 0, winreg.REG_DWORD, timeout)
            new_values['TdrDelay'] = timeout
            if ddi_timeout is not None:
                winreg.SetValueEx(key, 'TdrDdiDelay', 0, winreg.REG_DWORD, ddi_timeout)
                new_values['TdrDdiDelay'] = ddi_timeout

        return {
            'status': 'applied',
            'reboot_required': True,
            'previous_values': previous,
            'new_values': new_values,
            'note': 'A system reboot is required for GPU TDR changes to take effect.',
        }
    except PermissionError:
        return {'error': 'Permission denied writing to registry (agent must run as SYSTEM/admin)'}
    except Exception as e:
        return {'error': f'Registry write failed: {e}'}


def manage_windows_update(params, config):
    """Pause/resume/schedule Windows Update via registry policy keys."""
    action = (params.get('action') or '').lower()
    logger.info(f"[MCP-AUDIT] manage_windows_update: action={action}")

    POLICY_KEY = r'SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
    UX_KEY = r'SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'

    if action == 'get_status':
        return {
            'active_hours_start': _read_dword(winreg.HKEY_LOCAL_MACHINE, UX_KEY, 'ActiveHoursStart'),
            'active_hours_end': _read_dword(winreg.HKEY_LOCAL_MACHINE, UX_KEY, 'ActiveHoursEnd'),
            'scheduled_install_day': _read_dword(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY, 'ScheduledInstallDay'),
            'scheduled_install_time': _read_dword(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY, 'ScheduledInstallTime'),
            'auto_restart_deadline_days': _read_dword(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY, 'AutoRestartDeadlinePeriodInDays'),
            'feature_update_deferral_days': _read_dword(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY, 'DeferFeatureUpdatesPeriodInDays'),
            'quality_update_deferral_days': _read_dword(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY, 'DeferQualityUpdatesPeriodInDays'),
        }

    if action == 'pause':
        try:
            pause_days = int(params.get('pause_days', 7))
            if not (1 <= pause_days <= 35):
                return {'error': 'pause_days must be 1-35'}
        except (TypeError, ValueError):
            return {'error': 'pause_days must be an integer'}
        from datetime import datetime, timedelta, timezone
        pause_until = (datetime.now(timezone.utc) + timedelta(days=pause_days)).strftime('%Y-%m-%dT%H:%M:%SZ')
        try:
            with _open_or_create(winreg.HKEY_LOCAL_MACHINE, UX_KEY) as k:
                winreg.SetValueEx(k, 'PauseUpdatesExpiryTime', 0, winreg.REG_SZ, pause_until)
            return {'status': 'paused', 'pause_until': pause_until, 'pause_days': pause_days}
        except Exception as e:
            return {'error': f'pause failed: {e}'}

    if action == 'resume':
        try:
            with _open_or_create(winreg.HKEY_LOCAL_MACHINE, UX_KEY) as k:
                try:
                    winreg.DeleteValue(k, 'PauseUpdatesExpiryTime')
                except FileNotFoundError:
                    pass
            return {'status': 'resumed'}
        except Exception as e:
            return {'error': f'resume failed: {e}'}

    if action == 'set_active_hours':
        try:
            start = int(params.get('start_hour'))
            end = int(params.get('end_hour'))
            if not (0 <= start <= 23) or not (0 <= end <= 23):
                return {'error': 'start_hour and end_hour must be 0-23'}
        except (TypeError, ValueError):
            return {'error': 'start_hour and end_hour required as integers'}
        try:
            with _open_or_create(winreg.HKEY_LOCAL_MACHINE, UX_KEY) as k:
                winreg.SetValueEx(k, 'ActiveHoursStart', 0, winreg.REG_DWORD, start)
                winreg.SetValueEx(k, 'ActiveHoursEnd', 0, winreg.REG_DWORD, end)
                winreg.SetValueEx(k, 'IsActiveHoursEnabled', 0, winreg.REG_DWORD, 1)
            return {'status': 'ok', 'active_hours': {'start': start, 'end': end}}
        except Exception as e:
            return {'error': f'set_active_hours failed: {e}'}

    if action == 'set_scheduled_install':
        try:
            day = int(params.get('day_of_week', 0))
            hour = int(params.get('hour', 3))
            if not (0 <= day <= 7) or not (0 <= hour <= 23):
                return {'error': 'day_of_week 0-7 (0=every day), hour 0-23'}
        except (TypeError, ValueError):
            return {'error': 'day_of_week and hour required as integers'}
        try:
            with _open_or_create(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY) as k:
                winreg.SetValueEx(k, 'AUOptions', 0, winreg.REG_DWORD, 4)  # scheduled install
                winreg.SetValueEx(k, 'ScheduledInstallDay', 0, winreg.REG_DWORD, day)
                winreg.SetValueEx(k, 'ScheduledInstallTime', 0, winreg.REG_DWORD, hour)
                winreg.SetValueEx(k, 'NoAutoUpdate', 0, winreg.REG_DWORD, 0)
            return {'status': 'ok', 'day_of_week': day, 'hour': hour}
        except Exception as e:
            return {'error': f'set_scheduled_install failed: {e}'}

    if action == 'set_restart_deadline':
        try:
            days = int(params.get('deadline_days', 7))
            if not (2 <= days <= 14):
                return {'error': 'deadline_days must be 2-14'}
        except (TypeError, ValueError):
            return {'error': 'deadline_days must be an integer'}
        try:
            with _open_or_create(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY) as k:
                winreg.SetValueEx(k, 'AutoRestartDeadlinePeriodInDays', 0, winreg.REG_DWORD, days)
            return {'status': 'ok', 'deadline_days': days}
        except Exception as e:
            return {'error': f'set_restart_deadline failed: {e}'}

    if action == 'set_feature_deferral':
        try:
            days = int(params.get('days', 0))
            if not (0 <= days <= 365):
                return {'error': 'days must be 0-365 for feature updates'}
        except (TypeError, ValueError):
            return {'error': 'days must be an integer'}
        try:
            with _open_or_create(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY) as k:
                winreg.SetValueEx(k, 'DeferFeatureUpdates', 0, winreg.REG_DWORD, 1 if days > 0 else 0)
                winreg.SetValueEx(k, 'DeferFeatureUpdatesPeriodInDays', 0, winreg.REG_DWORD, days)
            return {'status': 'ok', 'feature_deferral_days': days}
        except Exception as e:
            return {'error': f'set_feature_deferral failed: {e}'}

    if action == 'set_quality_deferral':
        try:
            days = int(params.get('days', 0))
            if not (0 <= days <= 30):
                return {'error': 'days must be 0-30 for quality updates'}
        except (TypeError, ValueError):
            return {'error': 'days must be an integer'}
        try:
            with _open_or_create(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY) as k:
                winreg.SetValueEx(k, 'DeferQualityUpdates', 0, winreg.REG_DWORD, 1 if days > 0 else 0)
                winreg.SetValueEx(k, 'DeferQualityUpdatesPeriodInDays', 0, winreg.REG_DWORD, days)
            return {'status': 'ok', 'quality_deferral_days': days}
        except Exception as e:
            return {'error': f'set_quality_deferral failed: {e}'}

    return {'error': f"Unknown action '{action}'. See tool description for valid actions."}


def suppress_setup_screens(params, config):
    """Suppress the full-screen Windows setup/OOBE screens that hijack the
    display after updates: the privacy-settings experience, the Windows
    Welcome Experience, SCOOBE ("Let's finish setting up your device") and
    the Edge first-run tour.

    The service runs as SYSTEM, so "HKCU" here would be SYSTEM's own hive.
    The per-user keys are therefore written under HKEY_USERS\\<SID> for every
    real profile — mounting not-loaded hives with reg.exe — plus the Default
    profile so future accounts inherit the suppression.
    """
    action = (params.get('action') or '').lower()
    logger.info(f"[MCP-AUDIT] suppress_setup_screens: action={action}")

    if action == 'get_status':
        machine = {}
        for label, (path, name, value) in _SETUP_MACHINE_KEYS.items():
            machine[label + '_suppressed'] = _read_dword(winreg.HKEY_LOCAL_MACHINE, path, name) == value
        users = []
        for sid, ntuser_path in _enumerate_profiles():
            entry = {'sid': sid, 'profile_path': os.path.dirname(ntuser_path), 'loaded': _hive_loaded(sid)}
            if entry['loaded']:
                for label, (path, name, value) in _SETUP_USER_KEYS.items():
                    entry[label + '_suppressed'] = _read_dword(winreg.HKEY_USERS, f'{sid}\\{path}', name) == value
            # Not-loaded hives are not mounted just for a read — apply is
            # idempotent and reports per-key state, so use it to close gaps.
            users.append(entry)
        return {
            'machine': machine,
            'users': users,
            'all_machine_keys_suppressed': all(machine.values()),
        }

    if action == 'apply':
        results = {'machine': [], 'users': [], 'errors': []}

        for label, (path, name, value) in _SETUP_MACHINE_KEYS.items():
            try:
                outcome = _write_dword(winreg.HKEY_LOCAL_MACHINE, path, name, value)
                results['machine'].append({'key': label, 'outcome': 'applied' if outcome == 'set' else 'already_ok'})
            except Exception as e:
                results['errors'].append(f'machine {label}: {e}')

        for sid, ntuser_path in _enumerate_profiles():
            target = os.path.dirname(ntuser_path)
            if _hive_loaded(sid):
                wrote, already, errors = _apply_user_keys(sid)
                entry = {'target': target, 'sid': sid, 'hive': 'loaded', 'applied': wrote, 'already_ok': already}
                if errors:
                    entry['error'] = '; '.join(errors)
                results['users'].append(entry)
            else:
                entry = _apply_mounted(ntuser_path, target)
                entry['sid'] = sid
                results['users'].append(entry)
            if entry.get('error'):
                results['errors'].append(f"{target}: {entry['error']}")

        default_entry = _apply_mounted(_default_profile_hive(), 'default profile (future users)')
        results['default_profile'] = default_entry
        if default_entry.get('error'):
            results['errors'].append(f"default profile: {default_entry['error']}")

        results['status'] = 'partial' if results['errors'] else 'ok'
        return results

    return {'error': f"Unknown action '{action}'. Use: get_status/apply"}


def manage_notifications(params, config):
    """Suppress Windows toast notifications / enable Focus Assist for kiosks."""
    action = (params.get('action') or '').lower()
    logger.info(f"[MCP-AUDIT] manage_notifications: action={action}")

    PUSH_KEY = r'SOFTWARE\Microsoft\Windows\CurrentVersion\PushNotifications'
    NOTIFICATIONS_SETTINGS = r'SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings'
    QUIET_HOURS_KEY = r'SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Advanced'

    if action == 'get_status':
        toast_enabled = None
        focus_profile = None
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, PUSH_KEY) as k:
                toast_enabled, _ = winreg.QueryValueEx(k, 'ToastEnabled')
        except (FileNotFoundError, OSError):
            pass
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, QUIET_HOURS_KEY) as k:
                focus_profile, _ = winreg.QueryValueEx(k, 'QuietHoursProfile')
        except (FileNotFoundError, OSError):
            pass
        return {
            'toast_enabled': toast_enabled,
            'focus_profile': focus_profile,
        }

    if action == 'disable_all_toasts':
        try:
            with _open_or_create(winreg.HKEY_CURRENT_USER, PUSH_KEY) as k:
                winreg.SetValueEx(k, 'ToastEnabled', 0, winreg.REG_DWORD, 0)
            return {'status': 'ok', 'toast_enabled': 0}
        except Exception as e:
            return {'error': f'disable_all_toasts failed: {e}'}

    if action == 'enable_focus_assist':
        mode = (params.get('focus_mode') or 'alarms_only').lower()
        profile_map = {
            'priority_only': 'Microsoft.QuietHoursProfile.PriorityOnly',
            'alarms_only': 'Microsoft.QuietHoursProfile.AlarmsOnly',
        }
        if mode not in profile_map:
            return {'error': f"Invalid focus_mode. Use: {', '.join(profile_map)}"}
        try:
            with _open_or_create(winreg.HKEY_CURRENT_USER, QUIET_HOURS_KEY) as k:
                winreg.SetValueEx(k, 'QuietHoursProfile', 0, winreg.REG_SZ, profile_map[mode])
            return {'status': 'ok', 'focus_mode': mode}
        except Exception as e:
            return {'error': f'enable_focus_assist failed: {e}'}

    if action == 'disable_focus_assist':
        try:
            with _open_or_create(winreg.HKEY_CURRENT_USER, QUIET_HOURS_KEY) as k:
                winreg.SetValueEx(k, 'QuietHoursProfile', 0, winreg.REG_SZ, 'Microsoft.QuietHoursProfile.Unrestricted')
            return {'status': 'ok'}
        except Exception as e:
            return {'error': f'disable_focus_assist failed: {e}'}

    if action == 'disable_for_app':
        app_name = (params.get('app_name') or '').strip()
        if not app_name:
            return {'error': 'app_name is required'}
        if not re.match(r'^[\w.\-!]+$', app_name):
            return {'error': f"Invalid app_name '{app_name}'"}
        try:
            app_path = f'{NOTIFICATIONS_SETTINGS}\\{app_name}'
            with _open_or_create(winreg.HKEY_CURRENT_USER, app_path) as k:
                winreg.SetValueEx(k, 'Enabled', 0, winreg.REG_DWORD, 0)
            return {'status': 'ok', 'app_name': app_name}
        except Exception as e:
            return {'error': f'disable_for_app failed: {e}'}

    return {'error': f"Unknown action '{action}'. Use: get_status/disable_all_toasts/enable_focus_assist/disable_focus_assist/disable_for_app"}


def configure_power_plan(params, config):
    """Configure Windows power plan + disable sleep/hibernate/screen blanking."""
    logger.info(f"[MCP-AUDIT] configure_power_plan: params={list(params.keys())}")

    plan = (params.get('plan') or '').lower()
    plan_guids = {
        'high_performance': '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c',
        'balanced': '381b4222-f694-41f0-9685-ff5bb260df2e',
        'ultimate_performance': 'e9a42b02-d5df-448d-aa00-03f14749eb61',
    }

    actions_done = []
    errors = []

    if plan:
        if plan not in plan_guids:
            return {'error': f"Invalid plan. Use: {', '.join(plan_guids)}"}
        rc, out, err = mcp_tools.run_capture(
            ['powercfg.exe', '/setactive', plan_guids[plan]], 10,
        )
        if rc == 0:
            actions_done.append(f'set_plan:{plan}')
        else:
            errors.append(f'set_plan failed: {err or out}')

    if params.get('disable_sleep'):
        for ac_or_dc in ('standby-timeout-ac', 'standby-timeout-dc'):
            rc, out, err = mcp_tools.run_capture(
                ['powercfg.exe', '/change', ac_or_dc, '0'], 10,
            )
            if rc == 0:
                actions_done.append(f'{ac_or_dc}=0')
            else:
                errors.append(f'{ac_or_dc} failed: {err or out}')

    if params.get('disable_hibernate'):
        rc, out, err = mcp_tools.run_capture(['powercfg.exe', '/hibernate', 'off'], 10)
        if rc == 0:
            actions_done.append('hibernate_off')
        else:
            errors.append(f'hibernate off failed: {err or out}')

    if params.get('disable_screen_blanking'):
        for ac_or_dc in ('monitor-timeout-ac', 'monitor-timeout-dc'):
            rc, out, err = mcp_tools.run_capture(
                ['powercfg.exe', '/change', ac_or_dc, '0'], 10,
            )
            if rc == 0:
                actions_done.append(f'{ac_or_dc}=0')
            else:
                errors.append(f'{ac_or_dc} failed: {err or out}')

    return {
        'status': 'ok' if not errors else 'partial',
        'actions_done': actions_done,
        'errors': errors or None,
    }


def manage_scheduled_task(params, config):
    """Full taskschd.msc parity: list, enable, disable, delete, run_now, stop,
    create (with full trigger/action/principal/settings schema), get_details,
    get_history."""
    action = (params.get('action') or '').lower()
    task_name = (params.get('task_name') or '').strip()

    logger.info(f"[MCP-AUDIT] manage_scheduled_task: action={action} task={task_name or '(n/a)'}")

    # Validate task_name for non-list actions
    if action != 'list':
        if not task_name:
            return {'error': 'task_name is required'}
        if not re.match(r'^[\w.\-\\ ]+$', task_name):
            return {'error': f"Invalid task_name '{task_name}'"}

    if action == 'list':
        name_filter = params.get('name_filter', '')
        # Use PowerShell Get-ScheduledTask for rich output
        ps = 'Get-ScheduledTask | Select-Object TaskName,TaskPath,State | ConvertTo-Json -Depth 3'
        rc, out, err = _run_powershell_script(ps, timeout=30)
        if rc != 0:
            return {'error': f'list failed: {err or out}'}
        try:
            tasks = json.loads(out) if out.strip() else []
            if not isinstance(tasks, list):
                tasks = [tasks]
            if name_filter:
                tasks = [t for t in tasks if name_filter.lower() in (t.get('TaskName') or '').lower()]
            return {'count': len(tasks), 'tasks': tasks[:200]}
        except Exception as e:
            return {'error': f'failed to parse task list: {e}'}

    if action in ('enable', 'disable', 'delete', 'run_now', 'stop'):
        cmd_map = {
            'enable': ['schtasks.exe', '/Change', '/TN', task_name, '/ENABLE'],
            'disable': ['schtasks.exe', '/Change', '/TN', task_name, '/DISABLE'],
            'delete': ['schtasks.exe', '/Delete', '/TN', task_name, '/F'],
            'run_now': ['schtasks.exe', '/Run', '/TN', task_name],
            'stop': ['schtasks.exe', '/End', '/TN', task_name],
        }
        rc, out, err = mcp_tools.run_capture(cmd_map[action], 15)
        if rc != 0:
            return {'error': f'{action} failed: {(err or out).strip()}'}
        return {'action': action, 'task_name': task_name, 'status': 'ok'}

    if action == 'get_history':
        ps = (
            f'$info = Get-ScheduledTaskInfo -TaskName "{_ps_escape(task_name)}"; '
            '$info | Select-Object LastRunTime,LastTaskResult,NextRunTime,NumberOfMissedRuns | ConvertTo-Json'
        )
        rc, out, err = _run_powershell_script(ps)
        if rc != 0:
            return {'error': f'get_history failed: {err or out}'}
        try:
            return {'task_name': task_name, **json.loads(out)}
        except Exception as e:
            return {'error': f'parse failed: {e}', 'raw': out}

    if action == 'get_details':
        ps = f'Export-ScheduledTask -TaskName "{_ps_escape(task_name)}"'
        rc, out, err = _run_powershell_script(ps)
        if rc != 0:
            return {'error': f'get_details failed: {err or out}'}
        return {'task_name': task_name, 'xml': out}

    if action == 'create':
        return _create_scheduled_task(params)

    return {'error': f"Unknown action '{action}'. Use: list/enable/disable/delete/run_now/stop/create/get_details/get_history"}


def _create_scheduled_task(params):
    """Build a PowerShell Register-ScheduledTask script from the structured schema."""
    task_name = params.get('task_name', '').strip()
    description = params.get('description', '')
    trigger = params.get('trigger') or {}
    # Accept either 'task_action' (preferred, avoids collision with top-level 'action')
    # or 'action' (for backward compat when passed as an object).
    action_def = params.get('task_action')
    if not action_def and isinstance(params.get('action'), dict):
        action_def = params.get('action')
    action_def = action_def or {}
    principal = params.get('principal') or {}
    settings = params.get('settings') or {}

    if not re.match(r'^[\w.\-\\ ]+$', task_name):
        return {'error': f"Invalid task_name '{task_name}'"}

    # Build trigger
    t_type = (trigger.get('type') or '').lower()
    if t_type == 'boot':
        trigger_ps = 'New-ScheduledTaskTrigger -AtStartup'
    elif t_type == 'logon':
        user = trigger.get('user')
        user_part = (' -User "' + _ps_escape(user) + '"') if user else ''
        trigger_ps = 'New-ScheduledTaskTrigger -AtLogOn' + user_part
    elif t_type == 'once':
        dt = trigger.get('start_datetime', '')
        if not dt:
            return {'error': 'trigger.start_datetime required for once'}
        trigger_ps = f'New-ScheduledTaskTrigger -Once -At "{_ps_escape(dt)}"'
    elif t_type == 'daily':
        st = trigger.get('start_time', '04:00')
        interval = int(trigger.get('days_interval', 1))
        trigger_ps = f'New-ScheduledTaskTrigger -Daily -At "{_ps_escape(st)}" -DaysInterval {interval}'
    elif t_type == 'weekly':
        st = trigger.get('start_time', '04:00')
        days = trigger.get('days_of_week') or ['sun']
        day_map = {'mon': 'Monday', 'tue': 'Tuesday', 'wed': 'Wednesday', 'thu': 'Thursday',
                   'fri': 'Friday', 'sat': 'Saturday', 'sun': 'Sunday'}
        try:
            ps_days = ','.join(day_map[d.lower()] for d in days)
        except KeyError:
            return {'error': f'invalid day in days_of_week: {days}'}
        trigger_ps = f'New-ScheduledTaskTrigger -Weekly -At "{_ps_escape(st)}" -DaysOfWeek {ps_days}'
    elif t_type == 'monthly':
        # Use schtasks since New-ScheduledTaskTrigger doesn't have Monthly (requires MSFT_TaskMonthlyTrigger via CIM)
        return {'error': 'monthly trigger: use New-ScheduledTaskTrigger is limited; please use create with a daily/weekly approximation or execute_script for complex monthly schedules'}
    elif t_type == 'on_event':
        log_name = trigger.get('log_name', 'Application')
        event_id = trigger.get('event_id')
        source = trigger.get('source', '')
        xpath = f"*[System[Provider[@Name='{_ps_escape(source)}'] and EventID={int(event_id)}]]" if source else f"*[System[EventID={int(event_id)}]]"
        # Use CIM class for event trigger
        trigger_ps = (
            f'$class = Get-CimClass -ClassName MSFT_TaskEventTrigger '
            f'-Namespace Root/Microsoft/Windows/TaskScheduler; '
            f'$t = New-CimInstance -CimClass $class -ClientOnly; '
            f'$t.Enabled = $true; $t.Subscription = \'<QueryList><Query Id="0" Path="{_ps_escape(log_name)}">'
            f'<Select Path="{_ps_escape(log_name)}">{xpath}</Select></Query></QueryList>\'; $t'
        )
    elif t_type == 'on_idle':
        mins = int(trigger.get('idle_minutes', 10))
        trigger_ps = f'New-ScheduledTaskTrigger -AtLogOn'  # Idle uses settings, not trigger
        # We'll configure idle via settings below
        settings['_idle_timeout_minutes'] = mins
    else:
        return {'error': f"Invalid trigger.type '{t_type}'. Use: boot/logon/once/daily/weekly/on_event/on_idle"}

    # Build action
    a_type = (action_def.get('type') or 'run_program').lower()
    if a_type != 'run_program':
        return {'error': f"Only action.type 'run_program' is supported"}
    program = action_def.get('program', '')
    if not program:
        return {'error': 'action.program is required'}
    arguments = action_def.get('arguments', '')
    working_dir = action_def.get('working_directory', '')
    args_part = f' -Argument "{_ps_escape(arguments)}"' if arguments else ''
    wd_part = f' -WorkingDirectory "{_ps_escape(working_dir)}"' if working_dir else ''
    action_ps = f'New-ScheduledTaskAction -Execute "{_ps_escape(program)}"{args_part}{wd_part}'

    # Build principal
    run_as = (principal.get('run_as') or 'SYSTEM').upper()
    run_level = (principal.get('run_level') or 'highest').lower()
    user_map = {
        'SYSTEM': 'SYSTEM',
        'LOCAL_SERVICE': 'LOCAL SERVICE',
        'NETWORK_SERVICE': 'NETWORK SERVICE',
        'CURRENT_USER': None,  # omit UserId to default to current user
    }
    if run_as not in user_map:
        return {'error': f"Invalid principal.run_as '{run_as}'"}
    rl = 'Highest' if run_level == 'highest' else 'Limited'
    if user_map[run_as] is None:
        principal_ps = f'New-ScheduledTaskPrincipal -LogonType S4U -RunLevel {rl}'
    else:
        principal_ps = f'New-ScheduledTaskPrincipal -UserId "{user_map[run_as]}" -LogonType ServiceAccount -RunLevel {rl}'

    # Build settings
    settings_parts = []
    if settings.get('start_when_available', True):
        settings_parts.append('-StartWhenAvailable')
    if settings.get('allow_start_on_batteries', True):
        settings_parts.append('-AllowStartIfOnBatteries')
    if settings.get('stop_if_going_on_batteries') is False:
        settings_parts.append('-DontStopIfGoingOnBatteries')
    if settings.get('hidden'):
        settings_parts.append('-Hidden')
    if settings.get('run_only_if_network_available'):
        settings_parts.append('-RunOnlyIfNetworkAvailable')
    etl = settings.get('execution_time_limit_minutes')
    if etl:
        settings_parts.append(f'-ExecutionTimeLimit (New-TimeSpan -Minutes {int(etl)})')
    rc_count = settings.get('restart_count')
    if rc_count:
        settings_parts.append(f'-RestartCount {int(rc_count)}')
        ri = int(settings.get('restart_interval_minutes', 1))
        settings_parts.append(f'-RestartInterval (New-TimeSpan -Minutes {ri})')
    mi = (settings.get('multiple_instances') or 'ignore_new').lower()
    mi_map = {'parallel': 'Parallel', 'queue': 'Queue', 'ignore_new': 'IgnoreNew', 'stop_existing': 'StopExisting'}
    if mi in mi_map:
        settings_parts.append(f'-MultipleInstances {mi_map[mi]}')
    exp = settings.get('delete_expired_task_after_days')
    if exp:
        settings_parts.append(f'-DeleteExpiredTaskAfter (New-TimeSpan -Days {int(exp)})')
    if settings.get('_idle_timeout_minutes'):
        mins = int(settings['_idle_timeout_minutes'])
        settings_parts.append(f'-IdleDuration (New-TimeSpan -Minutes 1) -IdleWaitTimeout (New-TimeSpan -Minutes {mins}) -RunOnlyIfIdle')
    settings_ps = 'New-ScheduledTaskSettingsSet ' + ' '.join(settings_parts) if settings_parts else 'New-ScheduledTaskSettingsSet'

    # Assemble full script
    desc_part = f' -Description "{_ps_escape(description)}"' if description else ''
    ps_script = (
        f'$trigger = {trigger_ps}; '
        f'$action = {action_ps}; '
        f'$principal = {principal_ps}; '
        f'$settings = {settings_ps}; '
        f'Register-ScheduledTask -TaskName "{_ps_escape(task_name)}" '
        f'-Trigger $trigger -Action $action -Principal $principal -Settings $settings{desc_part} -Force | Out-Null; '
        f'Write-Output "OK"'
    )

    rc, out, err = _run_powershell_script(ps_script, timeout=30)
    if rc != 0:
        return {'error': f'create failed: {err or out}'}
    return {'action': 'create', 'task_name': task_name, 'status': 'ok'}


def network_reset(params, config):
    """Flush DNS, renew IP, restart adapter, or reset winsock."""
    action = (params.get('action') or '').lower()
    adapter = params.get('adapter_name', '')
    logger.info(f"[MCP-AUDIT] network_reset: action={action} adapter={adapter or 'n/a'}")

    if action == 'flush_dns':
        rc, out, _ = mcp_tools.run_capture(['ipconfig.exe', '/flushdns'], 15)
        return {'action': action, 'rc': rc, 'output': out.strip()[:mcp_tools.MAX_OUTPUT_SIZE]}
    if action == 'renew_ip':
        mcp_tools.run_capture(['ipconfig.exe', '/release'], 30)
        rc, out, _ = mcp_tools.run_capture(['ipconfig.exe', '/renew'], 60)
        return {'action': action, 'rc': rc, 'output': out.strip()[:mcp_tools.MAX_OUTPUT_SIZE]}
    if action == 'restart_adapter':
        if not adapter:
            return {'error': 'adapter_name required for restart_adapter'}
        if not re.match(r'^[\w .\-]+$', adapter):
            return {'error': f'invalid adapter_name: {adapter}'}
        mcp_tools.run_capture(
            ['netsh.exe', 'interface', 'set', 'interface', adapter, 'admin=disabled'], 30,
        )
        rc, _, _ = mcp_tools.run_capture(
            ['netsh.exe', 'interface', 'set', 'interface', adapter, 'admin=enabled'], 30,
        )
        return {'action': action, 'adapter': adapter, 'rc': rc}
    if action == 'reset_winsock':
        rc, out, _ = mcp_tools.run_capture(['netsh.exe', 'winsock', 'reset'], 15)
        return {'action': action, 'rc': rc, 'output': out.strip()[:mcp_tools.MAX_OUTPUT_SIZE],
                'note': 'Reboot required for winsock reset to fully take effect.'}

    return {'error': f"Invalid action '{action}'. Use: flush_dns/renew_ip/restart_adapter/reset_winsock"}


def registry_operation(params, config):
    """Allowlisted registry read / write / delete."""
    action = (params.get('action') or '').lower()
    hive = (params.get('hive') or '').upper()
    key_path = (params.get('key_path') or '').strip()
    value_name = params.get('value_name', '')

    logger.info(f"[MCP-AUDIT] registry_operation: action={action} hive={hive} key={key_path} value={value_name}")

    ok, err = _validate_registry_path(hive, key_path)
    if not ok:
        return {'error': err}

    hive_const = winreg.HKEY_LOCAL_MACHINE if hive == 'HKLM' else winreg.HKEY_CURRENT_USER

    type_map = {
        'string': winreg.REG_SZ,
        'dword': winreg.REG_DWORD,
        'binary': winreg.REG_BINARY,
        'expand_string': winreg.REG_EXPAND_SZ,
        'multi_string': winreg.REG_MULTI_SZ,
    }

    if action == 'read':
        try:
            with winreg.OpenKey(hive_const, key_path) as key:
                if value_name:
                    val, regtype = winreg.QueryValueEx(key, value_name)
                    return {'hive': hive, 'key_path': key_path, 'value_name': value_name,
                            'value': val if not isinstance(val, bytes) else val.hex(), 'type': regtype}
                values = []
                i = 0
                while True:
                    try:
                        n, v, t = winreg.EnumValue(key, i)
                        values.append({'name': n, 'type': t,
                                       'value': v if not isinstance(v, bytes) else v.hex()})
                        i += 1
                    except OSError:
                        break
                return {'hive': hive, 'key_path': key_path, 'values': values}
        except FileNotFoundError:
            return {'error': f'Key not found: {hive}\\{key_path}'}
        except Exception as e:
            return {'error': f'read failed: {e}'}

    if action == 'write':
        value_data = params.get('value_data')
        value_type = (params.get('value_type') or 'string').lower()
        if value_type not in type_map:
            return {'error': f"Invalid value_type. Use: {', '.join(type_map)}"}
        if not value_name:
            return {'error': 'value_name is required for write'}
        try:
            with winreg.CreateKey(hive_const, key_path) as key:
                reg_type = type_map[value_type]
                if value_type == 'dword':
                    value_data = int(value_data)
                elif value_type == 'binary':
                    value_data = bytes.fromhex(value_data) if isinstance(value_data, str) else bytes(value_data)
                elif value_type == 'multi_string':
                    value_data = list(value_data) if not isinstance(value_data, list) else value_data
                winreg.SetValueEx(key, value_name, 0, reg_type, value_data)
            return {'hive': hive, 'key_path': key_path, 'value_name': value_name,
                    'value_type': value_type, 'status': 'ok'}
        except Exception as e:
            return {'error': f'write failed: {e}'}

    if action == 'delete':
        if not value_name:
            return {'error': 'value_name is required for delete (key deletion not supported)'}
        try:
            with winreg.OpenKey(hive_const, key_path, 0, winreg.KEY_WRITE) as key:
                winreg.DeleteValue(key, value_name)
            return {'hive': hive, 'key_path': key_path, 'value_name': value_name, 'status': 'deleted'}
        except FileNotFoundError:
            return {'error': f'Value not found: {value_name}'}
        except Exception as e:
            return {'error': f'delete failed: {e}'}

    return {'error': f"Invalid action '{action}'. Use: read/write/delete"}


def clean_disk_space(params, config):
    """Clean temp / prefetch / recycle bin / owlette logs with age filter + dry-run."""
    target = (params.get('target') or '').lower()
    older_than_days = int(params.get('older_than_days', 7))
    dry_run = bool(params.get('dry_run', False))

    logger.info(f"[MCP-AUDIT] clean_disk_space: target={target} older_than_days={older_than_days} dry_run={dry_run}")

    target_paths = {
        'temp': os.path.expandvars('%TEMP%'),
        'windows_temp': os.path.expandvars(r'%SystemRoot%\Temp'),
        'prefetch': os.path.expandvars(r'%SystemRoot%\Prefetch'),
        'owlette_logs': shared_utils.get_data_path('logs'),
    }

    if target == 'recycle_bin':
        if dry_run:
            return {'target': target, 'dry_run': True, 'note': 'Cannot dry-run recycle bin; no count available.'}
        try:
            import ctypes
            SHERB_NOCONFIRMATION = 0x00000001
            SHERB_NOPROGRESSUI = 0x00000002
            SHERB_NOSOUND = 0x00000004
            result = ctypes.windll.shell32.SHEmptyRecycleBinW(None, None,
                SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND)
            return {'target': target, 'rc': result, 'status': 'ok' if result == 0 else 'error'}
        except Exception as e:
            return {'error': f'recycle bin empty failed: {e}'}

    if target not in target_paths:
        return {'error': f"Invalid target. Use: {', '.join(list(target_paths) + ['recycle_bin'])}"}

    target_path = target_paths[target]
    if not os.path.isdir(target_path):
        return {'error': f'Target path does not exist: {target_path}'}

    cutoff = time.time() - (older_than_days * 86400)
    freed_bytes = 0
    files_deleted = 0
    files_scanned = 0
    errors = []

    for root, dirs, files in os.walk(target_path):
        for fname in files:
            files_scanned += 1
            fpath = os.path.join(root, fname)
            try:
                stat = os.stat(fpath)
                if stat.st_mtime > cutoff:
                    continue
                size = stat.st_size
                if dry_run:
                    freed_bytes += size
                    files_deleted += 1
                else:
                    try:
                        os.remove(fpath)
                        freed_bytes += size
                        files_deleted += 1
                    except (OSError, PermissionError):
                        pass  # skip locked/in-use files silently
            except Exception as e:
                if len(errors) < 5:
                    errors.append(str(e))

    return {
        'target': target, 'target_path': target_path,
        'older_than_days': older_than_days, 'dry_run': dry_run,
        'files_scanned': files_scanned, 'files_deleted': files_deleted,
        'freed_bytes': freed_bytes, 'freed_mb': round(freed_bytes / 1024 / 1024, 2),
        'errors': errors or None,
    }


def get_event_logs_filtered(params, config):
    """Fast filtered event log query via Get-WinEvent -FilterHashtable."""
    log_name = params.get('log_name', 'Application')
    process_name = params.get('process_name', '')
    event_id = params.get('event_id')
    hours_back = int(params.get('hours_back', 24))
    level = params.get('level', '')
    max_events = int(params.get('max_events', 50))

    if log_name not in ('Application', 'System', 'Security', 'Setup'):
        return {'error': f"Invalid log_name '{log_name}'"}
    if not (1 <= hours_back <= 168):
        return {'error': 'hours_back must be 1-168'}
    if not (1 <= max_events <= 200):
        return {'error': 'max_events must be 1-200'}

    logger.info(f"[MCP-AUDIT] get_event_logs_filtered: log={log_name} hours={hours_back} process={process_name} event_id={event_id}")

    level_map = {'Critical': 1, 'Error': 2, 'Warning': 3, 'Information': 4, 'Verbose': 5}

    filter_parts = [f"LogName='{log_name}'", f"StartTime=(Get-Date).AddHours(-{hours_back})"]
    if event_id is not None:
        filter_parts.append(f'ID={int(event_id)}')
    if level and level in level_map:
        filter_parts.append(f'Level={level_map[level]}')
    if process_name:
        pn = _ps_escape(process_name)
        filter_parts.append(f"ProviderName='{pn}'")

    hash_table = '@{' + '; '.join(filter_parts) + '}'
    # Wrap Get-WinEvent in try/catch so "no matching events" returns [] instead of
    # surfacing as a non-zero exit with empty stderr. Real errors still propagate.
    ps = (
        'try { '
        f'Get-WinEvent -FilterHashtable {hash_table} -MaxEvents {max_events} -ErrorAction Stop | '
        'Select-Object TimeCreated,Id,Level,LevelDisplayName,ProviderName,Message | '
        'ConvertTo-Json -Depth 3 -Compress '
        '} catch [Exception] { '
        'if ($_.FullyQualifiedErrorId -like "NoMatchingEventsFound*") { "[]" } '
        'else { Write-Error $_.Exception.Message; exit 1 } '
        '}'
    )
    rc, out, err = _run_powershell_script(ps, timeout=60)
    if rc != 0:
        msg = (err or out).strip() or 'unknown error (empty stderr)'
        return {'error': f'event query failed (rc={rc}): {msg}'}
    try:
        events = json.loads(out) if out.strip() else []
        if not isinstance(events, list):
            events = [events]
        return {'log_name': log_name, 'hours_back': hours_back, 'count': len(events), 'events': events}
    except Exception as e:
        return {'error': f'parse failed: {e}', 'raw': out[:2000]}


def manage_windows_feature(params, config):
    """Add / remove / list Windows Optional Features, Capabilities, or AppX packages."""
    ftype = (params.get('type') or '').lower()
    action = (params.get('action') or '').lower()
    name = params.get('name', '')
    all_users = bool(params.get('all_users', False))
    name_filter = params.get('name_filter', '')

    logger.info(f"[MCP-AUDIT] manage_windows_feature: type={ftype} action={action} name={name}")

    # Critical-feature blocklist — can't be disabled regardless of params
    CRITICAL_FEATURES = frozenset({
        'netfx4', 'netfx4-advsrvs', 'netfx3', 'windows-defender-default-definitions',
        'microsoft-windows-subsystem-linux', 'windows-management-framework',
    })
    CRITICAL_APPX_PATTERNS = ('Microsoft.WindowsStore', 'Microsoft.NET.Native', 'Microsoft.VCLibs',
                              'Microsoft.UI.Xaml', 'Microsoft.DesktopAppInstaller')

    if action == 'remove':
        if ftype in ('optional_feature', 'capability') and name.lower() in CRITICAL_FEATURES:
            return {'error': f"Refusing to remove critical feature '{name}'"}
        if ftype == 'appx_package':
            if any(p in name for p in CRITICAL_APPX_PATTERNS):
                return {'error': f"Refusing to remove critical AppX '{name}'"}

    if ftype == 'optional_feature':
        if action == 'list':
            ps = 'Get-WindowsOptionalFeature -Online | Select-Object FeatureName,State | ConvertTo-Json -Compress'
            if name_filter:
                ps = f'Get-WindowsOptionalFeature -Online | Where-Object {{ $_.FeatureName -like "*{_ps_escape(name_filter)}*" }} | Select-Object FeatureName,State | ConvertTo-Json -Compress'
        elif action == 'install':
            if not name:
                return {'error': 'name is required for install'}
            ps = f'Enable-WindowsOptionalFeature -Online -FeatureName "{_ps_escape(name)}" -NoRestart -ErrorAction Stop | Select-Object RestartNeeded | ConvertTo-Json -Compress'
        elif action == 'remove':
            if not name:
                return {'error': 'name is required for remove'}
            ps = f'Disable-WindowsOptionalFeature -Online -FeatureName "{_ps_escape(name)}" -NoRestart -ErrorAction Stop | Select-Object RestartNeeded | ConvertTo-Json -Compress'
        else:
            return {'error': f"Invalid action '{action}'"}

    elif ftype == 'capability':
        if action == 'list':
            ps = 'Get-WindowsCapability -Online | Where-Object { $_.State -ne "NotPresent" } | Select-Object Name,State | ConvertTo-Json -Compress'
            if name_filter:
                ps = f'Get-WindowsCapability -Online | Where-Object {{ $_.Name -like "*{_ps_escape(name_filter)}*" }} | Select-Object Name,State | ConvertTo-Json -Compress'
        elif action == 'install':
            if not name:
                return {'error': 'name is required'}
            ps = f'Add-WindowsCapability -Online -Name "{_ps_escape(name)}" -ErrorAction Stop | Select-Object RestartNeeded | ConvertTo-Json -Compress'
        elif action == 'remove':
            if not name:
                return {'error': 'name is required'}
            ps = f'Remove-WindowsCapability -Online -Name "{_ps_escape(name)}" -ErrorAction Stop | Select-Object RestartNeeded | ConvertTo-Json -Compress'
        else:
            return {'error': f"Invalid action '{action}'"}

    elif ftype == 'appx_package':
        if action == 'list':
            scope = '-AllUsers' if all_users else ''
            filter_clause = f' | Where-Object {{ $_.Name -like "*{_ps_escape(name_filter)}*" }}' if name_filter else ''
            ps = f'Get-AppxPackage {scope}{filter_clause} | Select-Object Name,PackageFullName,Version | ConvertTo-Json -Compress'
        elif action == 'install':
            return {'error': 'AppX install via this tool is not supported — use the Microsoft Store or execute_script.'}
        elif action == 'remove':
            if not name:
                return {'error': 'name is required for remove'}
            if all_users:
                ps = (
                    f'Get-AppxPackage -AllUsers -Name "{_ps_escape(name)}" | Remove-AppxPackage -AllUsers; '
                    f'Get-AppxProvisionedPackage -Online | Where-Object {{ $_.DisplayName -like "*{_ps_escape(name)}*" }} | Remove-AppxProvisionedPackage -Online; '
                    'Write-Output "OK"'
                )
            else:
                ps = f'Get-AppxPackage -Name "{_ps_escape(name)}" | Remove-AppxPackage; Write-Output "OK"'
        else:
            return {'error': f"Invalid action '{action}'"}

    else:
        return {'error': f"Invalid type '{ftype}'. Use: optional_feature/capability/appx_package"}

    rc, out, err = _run_powershell_script(ps, timeout=120)
    if rc != 0:
        return {'error': f'{ftype} {action} failed: {err or out}'}

    try:
        data = json.loads(out) if out.strip() else None
    except Exception:
        data = None

    return {
        'type': ftype, 'action': action, 'name': name or None,
        'result': data if data is not None else out.strip()[:2000],
    }


def show_notification(params, config):
    """Display an on-screen toast or modal message for a nearby operator."""
    title = params.get('title', 'Owlette')
    message = params.get('message', '')
    style = (params.get('style') or 'toast').lower()
    duration = int(params.get('duration_seconds', 5))

    if not message:
        return {'error': 'message is required'}
    if style not in ('toast', 'modal'):
        return {'error': f"Invalid style '{style}'. Use: toast/modal"}

    logger.info(f"[MCP-AUDIT] show_notification: style={style} title={title}")

    if style == 'modal':
        # msg.exe broadcasts to all interactive sessions
        try:
            subprocess.Popen(
                ['msg.exe', '*', f'/TIME:{duration}', message[:1000]],
                shell=False, creationflags=mcp_tools.NO_WINDOW,
            )
            return {'style': style, 'status': 'sent'}
        except Exception as e:
            return {'error': f'modal send failed: {e}'}

    # Toast via PowerShell + Windows.UI.Notifications
    ps = (
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null; '
        '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null; '
        f'$xml = \'<toast><visual><binding template="ToastText02"><text id="1">{_ps_escape(title)}</text><text id="2">{_ps_escape(message)}</text></binding></visual></toast>\'; '
        '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument; $doc.LoadXml($xml); '
        '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc; '
        '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Owlette").Show($toast); '
        'Write-Output "OK"'
    )
    rc, out, err = _run_powershell_script(ps, timeout=10)
    if rc != 0:
        return {'error': f'toast failed: {err or out}'}
    return {'style': style, 'status': 'sent', 'duration_seconds': duration}


# The handler half of the tool table: `mcp_tools.execute_tool` merges this over
# its own cross-platform handlers, and `tools_posix.HANDLERS` is its opposite
# number. Keys are the published wire names.
HANDLERS = {
    'get_gpu_processes': get_gpu_processes,
    'get_event_logs': get_event_logs,
    'get_service_status': get_service_status,
    'check_pending_reboot': check_pending_reboot,
    'manage_windows_service': manage_windows_service,
    'configure_gpu_tdr': configure_gpu_tdr,
    'manage_windows_update': manage_windows_update,
    'suppress_setup_screens': suppress_setup_screens,
    'manage_notifications': manage_notifications,
    'configure_power_plan': configure_power_plan,
    'manage_scheduled_task': manage_scheduled_task,
    'network_reset': network_reset,
    'registry_operation': registry_operation,
    'clean_disk_space': clean_disk_space,
    'get_event_logs_filtered': get_event_logs_filtered,
    'manage_windows_feature': manage_windows_feature,
    'show_notification': show_notification,
}
