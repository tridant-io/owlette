"""
MCP Tool implementations for Owlette Agent.

These tools are invoked via Firestore commands (type: 'mcp_tool_call')
from the web dashboard's chat interface. Each function returns a structured
dict that gets sent back as the tool result.

This module holds the cross-platform half of the table plus the dispatch:
`execute_tool` merges in the handlers of whichever arm this machine runs —
`tools_windows` or `tools_posix` — and refuses a Windows-only tool elsewhere
with a structured `unsupported_on_platform` result.

No new dependencies — uses existing psutil, subprocess, platform, socket, etc.
"""

import fnmatch
import logging
import os
import platform
import shlex
import socket
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime

import psutil

import shared_utils

logger = logging.getLogger(__name__)

# No console window, and — for the cancellable tools only — a process group of
# the child's own, so _kill_process_tree takes the whole tree down with it.
# Neither constant exists off Windows, where a creationflags of 0 is the no-op.
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
NEW_PROCESS_GROUP = getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0)

# run_command only (native binaries), strict by design. run_powershell deliberately
# does NOT use it: the old first-token regex was bypassed by `Get-Date; Remove-Item`
# and false-rejected real scripts, so accountability is the Firestore audit trail
# (owlette_service._log_cortex_tool) plus the [MCP-AUDIT] local log.
_WINDOWS_ALLOWED_COMMANDS = [
    'ipconfig', 'systeminfo', 'hostname', 'whoami', 'tasklist',
    'netstat', 'ping', 'tracert', 'nslookup', 'dir', 'type',
    'echo', 'set', 'ver', 'wmic', 'sc', 'net', 'reg', 'nvidia-smi', 'dxdiag',
]

# The macOS/Linux counterpart. `sc`, `net` and `reg` have their analogues here
# in `systemctl` and `launchctl` — service control is auditable either way, and
# the tool is Tier 3 (dashboard-audited) on both.
_POSIX_ALLOWED_COMMANDS = [
    'hostname', 'whoami', 'id', 'uname', 'uptime', 'date', 'sw_vers',
    'ls', 'cat', 'echo', 'env', 'df', 'du', 'free', 'ps', 'lsof',
    'ip', 'ifconfig', 'netstat', 'ss', 'ping', 'traceroute', 'dig', 'nslookup',
    'host', 'systemctl', 'journalctl', 'launchctl', 'system_profiler',
    'lsb_release', 'lspci', 'lscpu', 'lsblk', 'dmesg', 'nvidia-smi',
]

MAX_OUTPUT_SIZE = 50000  # characters

SUBPROCESS_TIMEOUT = 25  # seconds

# Seconds. 55min, under the 1h pending-entry GC in
# firebase_client._cleanup_stale_commands — a script that outlives its pending
# entry can never deliver a result. Web clamps to the same value; longer jobs use
# the detached-job + follow-up pattern.
MAX_SCRIPT_TIMEOUT = 3300

# command_id → subprocess PID for every shell-spawning tool, so cancel_mcp_tool
# (in firebase_client) can kill one running command's process tree. Entries are
# removed on finish, timeout or error.
_RUNNING_COMMANDS = {}
_RUNNING_COMMANDS_LOCK = threading.Lock()


def cancel_running_command(command_id):
    """Kill the process tree of an in-flight command registered via
    _run_tracked_subprocess (execute_script, run_powershell, run_command).

    Returns True if a running process was found and killed, False if the
    command is unknown or already finished (idempotent — cancelling twice,
    or cancelling a completed command, is not an error).
    """
    with _RUNNING_COMMANDS_LOCK:
        pid = _RUNNING_COMMANDS.get(command_id)
    if pid is None:
        return False
    logger.info(f"[MCP-AUDIT] cancel_mcp_tool: killing process tree for command {command_id} (PID {pid})")
    _kill_process_tree(pid)
    return True


def _run(cmd, timeout, cwd=None, command_id=None, new_group=False):
    """Run argv to completion with no console window — the one subprocess site.

    Registering the PID (when command_id is provided) is what lets a
    cancel_mcp_tool interrupt kill this process mid-flight — the whole tree,
    via CREATE_NEW_PROCESS_GROUP, so children spawned by the script die too.
    The registry entry is always removed in the finally block.

    Returns (returncode, stdout, stderr, timed_out). On timeout the process
    tree is killed, returncode is None, timed_out is True, and any partial
    output captured before the kill is returned.
    """
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        cwd=cwd,
        creationflags=NO_WINDOW | (NEW_PROCESS_GROUP if new_group else 0),
    )

    if command_id is not None:
        with _RUNNING_COMMANDS_LOCK:
            _RUNNING_COMMANDS[command_id] = proc.pid

    try:
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
            return proc.returncode, stdout, stderr, False
        except subprocess.TimeoutExpired:
            # Kill the entire process tree, not just the root, then drain any
            # remaining output.
            _kill_process_tree(proc.pid)
            stdout, stderr = proc.communicate(timeout=5)
            return None, stdout or '', stderr or '', True
    except Exception:
        _kill_process_tree(proc.pid)
        raise
    finally:
        if command_id is not None:
            with _RUNNING_COMMANDS_LOCK:
                _RUNNING_COMMANDS.pop(command_id, None)


def _run_tracked_subprocess(cmd, timeout, command_id, cwd=None):
    """The cancellable path: the caller's command_id owns the running PID."""
    return _run(cmd, timeout, cwd=cwd, command_id=command_id, new_group=True)


def run_capture(cmd, timeout=SUBPROCESS_TIMEOUT, cwd=None):
    """The untracked path: (returncode, stdout, stderr), never a raise.

    Every tool that is not cancellable runs through here — both platform arms
    included — so a timeout or a missing binary reads like any other non-zero
    exit instead of unwinding into execute_tool's catch-all.
    """
    try:
        returncode, stdout, stderr, timed_out = _run(cmd, timeout, cwd=cwd)
    except Exception as e:
        return -1, '', str(e)
    if timed_out:
        return -1, stdout, f'{cmd[0]} timed out after {timeout}s'
    return returncode, stdout, stderr


def time_ago(moment, now=None):
    """`moment` as coarse elapsed time — '3 days ago', 'just now'."""
    delta = (now or datetime.now()) - moment
    elapsed = int(delta.total_seconds())
    for unit, size in (('year', 31536000), ('month', 2592000), ('day', 86400),
                       ('hour', 3600), ('minute', 60)):
        count = elapsed // size
        if count > 0:
            return f'{count} {unit}{"s" if count != 1 else ""} ago'
    return 'just now'


# Tier 2 safety: manage_process must never kill these.
_WINDOWS_CRITICAL_PROCESSES = frozenset({
    'system', 'system idle process', 'registry', 'memory compression',
    'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe',
    'lsass.exe', 'smss.exe', 'fontdrvhost.exe', 'dwm.exe', 'svchost.exe',
    'spoolsv.exe', 'lsaiso.exe', 'sihost.exe',
    # Owlette itself. owlette-host.exe replaced nssm.exe in 3.0.0; nssm.exe stays
    # because pre-3.0.0 machines are still hosted by it.
    'owlette_service.exe', 'owlette-host.exe', 'nssm.exe',
    'python.exe', 'pythonw.exe',
})

# The POSIX counterpart. manage_process is one of the cross-platform tools, so
# without this the Windows image names above protect nothing off Windows: the
# daemon answers to `python3` there, not `python.exe`, and killing macOS's
# loginwindow or WindowServer as root logs the kiosk out and takes the desktop
# app — the only executor for GUI jobs on POSIX — down with it.
_POSIX_CRITICAL_PROCESSES = frozenset({
    # pid 1 and the session/security daemons on each init system.
    'init', 'systemd', 'systemd-logind', 'systemd-journald', 'dbus-daemon',
    'sshd', 'launchd', 'loginwindow', 'windowserver', 'systemuiserver',
    # Owlette itself, under the names it runs as off Windows.
    'owlette-desktop', 'owlette-host', 'python', 'python3',
})


def _critical_processes():
    """This platform's never-kill set."""
    if sys.platform == 'win32':
        return _WINDOWS_CRITICAL_PROCESSES
    return _POSIX_CRITICAL_PROCESSES


def _is_critical_process(name):
    """Return True if a process name is in the hardcoded critical blocklist."""
    if not name:
        return True  # reject empty names defensively
    return name.lower() in _critical_processes()


# The tools only Windows implements: the twelve in tools_windows.py that have no
# POSIX analogue, plus the two PowerShell shells that live here because they are
# cancellable — the agent half of the `os: ["windows"]` tool tag. The twelve are
# absent from the POSIX tool table, so execute_tool answers for them; the two
# shells stay in the table on every platform, so command_id keeps reaching them,
# and refuse in the same shape when the interpreter is not on the machine.
WINDOWS_ONLY_TOOLS = frozenset({
    'configure_gpu_tdr', 'manage_windows_update', 'suppress_setup_screens',
    'manage_notifications', 'configure_power_plan', 'manage_scheduled_task',
    'network_reset', 'registry_operation', 'clean_disk_space',
    'get_event_logs_filtered', 'manage_windows_feature',
    'run_powershell', 'execute_script',
})


def _unsupported_on_platform(tool_name):
    """The structured refusal a gated tool returns off its own platform."""
    return {
        'error': 'unsupported_on_platform',
        'tool': tool_name,
        'platform': sys.platform,
        'message': f'{tool_name} is implemented on windows only',
    }


def _platform_handlers():
    """This platform's half of the tool table.

    Imported inside the function on purpose: tools_windows carries the winreg
    and pywin32 imports that must never run on macOS or Linux, so nothing may
    reach it at module scope.
    """
    if sys.platform == 'win32':
        import tools_windows as arm
    else:
        import tools_posix as arm
    return arm.HANDLERS


def _dispatch_platform_tool(tool_name, params, config):
    """Run a relocated tool, or refuse it where this platform has no arm."""
    handler = _platform_handlers().get(tool_name)
    if handler is None:
        return _unsupported_on_platform(tool_name)
    return handler(params, config)


def check_pending_reboot(params, config):
    """Whether the OS is waiting on a reboot, and what is asking for it.

    The one relocated tool with callers outside execute_tool — owlette_service's
    15-minute check and osadapter's `pending_reboot` both call it by name.
    """
    return _dispatch_platform_tool('check_pending_reboot', params, config)


def _show_notification(params, config):
    """Show a message to whoever is at the machine.

    The two platforms wire this in opposite directions: on Windows
    osadapter.notify() calls in here, and off Windows the POSIX arm calls back
    out to it, because the job seam osadapter owns is the only way a daemon
    with no session of its own reaches the screen.
    """
    return _dispatch_platform_tool('show_notification', params, config)


# Shell-spawning tools; their handlers take an extra command_id (via
# _run_tracked_subprocess) so cancel_mcp_tool can kill the process tree.
_CANCELLABLE_TOOLS = frozenset({'execute_script', 'run_powershell', 'run_command'})


def execute_tool(tool_name, tool_params, config=None, command_id=None):
    """
    Dispatch a tool call to the appropriate handler.

    Args:
        tool_name: Name of the tool to execute
        tool_params: Dict of parameters for the tool
        config: Optional agent config dict (avoids re-reading from disk)
        command_id: Optional originating Firestore command id — lets the
            shell-spawning tools (execute_script, run_powershell, run_command)
            register their subprocess for cancellation

    Returns:
        Dict with tool result or error
    """
    handlers = {
        # Tier 1: read-only
        'get_system_info': _get_system_info,
        'get_process_list': _get_process_list,
        'get_running_processes': _get_running_processes,
        'get_network_info': _get_network_info,
        'get_disk_usage': _get_disk_usage,
        'get_agent_config': _get_agent_config,
        'get_agent_logs': _get_agent_logs,
        'get_agent_health': _get_agent_health,
        'get_display_layout': _get_display_layout,
        # Tier 2: purpose-built admin (validated params, no raw shell)
        'manage_process': _manage_process,
        'apply_display_topology': _apply_display_topology,
        # Tier 3: privileged (shell, file I/O, scripts)
        'run_command': _run_command,
        'run_powershell': _run_powershell,
        'execute_script': _execute_script,
        'read_file': _read_file,
        'write_file': _write_file,
        'list_directory': _list_directory,
        # The seventeen relocated handlers, from this platform's arm.
        **_platform_handlers(),
    }

    handler = handlers.get(tool_name)
    if not handler:
        if tool_name in WINDOWS_ONLY_TOOLS:
            return _unsupported_on_platform(tool_name)
        return {'error': f'Unknown tool: {tool_name}'}

    try:
        # Cancellable handlers take (params, config, command_id); all others
        # take (params, config).
        if tool_name in _CANCELLABLE_TOOLS:
            return handler(tool_params, config, command_id=command_id)
        return handler(tool_params, config)
    except Exception as e:
        logger.error(f"Tool '{tool_name}' failed: {e}")
        return {'error': str(e)}


# Tier 1: read-only tools


def _get_system_info(params, config):
    """Get comprehensive system information."""
    boot_time = psutil.boot_time()
    uptime_seconds = int(time.time() - boot_time)
    uptime_hours = uptime_seconds // 3600
    uptime_minutes = (uptime_seconds % 3600) // 60

    metrics = shared_utils.get_system_metrics()

    # Get NVIDIA driver version via pynvml (already a dependency for GPU temps)
    gpu_driver_version = 'N/A'
    try:
        from pynvml import nvmlInit, nvmlSystemGetDriverVersion, nvmlShutdown
        nvmlInit()
        gpu_driver_version = nvmlSystemGetDriverVersion()
        nvmlShutdown()
    except Exception:
        pass

    # platform.release() returns "10" on Windows 11 (NT 10.0 build >= 22000)
    os_release = platform.release()
    if platform.system() == 'Windows' and os_release == '10':
        build = platform.version().split('.')[-1] if platform.version() else '0'
        if build.isdigit() and int(build) >= 22000:
            os_release = '11'

    return {
        'hostname': socket.gethostname(),
        'os': f"{platform.system()} {os_release}",
        'os_version': platform.version(),
        'architecture': platform.machine(),
        'cpu_model': metrics.get('cpu', {}).get('model', 'Unknown'),
        'cpu_percent': metrics.get('cpu', {}).get('percent', 0),
        'cpu_cores': psutil.cpu_count(logical=False),
        'cpu_threads': psutil.cpu_count(logical=True),
        'memory_used_gb': metrics.get('memory', {}).get('used_gb', 0),
        'memory_total_gb': metrics.get('memory', {}).get('total_gb', 0),
        'memory_percent': metrics.get('memory', {}).get('percent', 0),
        'disk_used_gb': metrics.get('disk', {}).get('used_gb', 0),
        'disk_total_gb': metrics.get('disk', {}).get('total_gb', 0),
        'disk_percent': metrics.get('disk', {}).get('percent', 0),
        'gpu_model': metrics.get('gpu', {}).get('name', 'N/A'),
        'gpu_driver_version': gpu_driver_version,
        'gpu_usage_percent': metrics.get('gpu', {}).get('usage_percent', 0),
        'gpu_vram_used_gb': metrics.get('gpu', {}).get('vram_used_gb', 0),
        'gpu_vram_total_gb': metrics.get('gpu', {}).get('vram_total_gb', 0),
        'uptime': f"{uptime_hours}h {uptime_minutes}m",
        'uptime_seconds': uptime_seconds,
        'agent_version': shared_utils.get_app_version(),
        'python_version': platform.python_version(),
    }


def _get_process_list(params, config):
    """Get all Owlette-configured processes with their current status."""
    if not config:
        config = shared_utils.read_config()

    processes = config.get('processes', [])
    runtime_state = shared_utils.read_json_from_file(shared_utils.RESULT_FILE_PATH)

    result = []
    for proc in processes:
        proc_name = proc.get('name', 'Unknown')
        proc_id = proc.get('id', '')
        autolaunch = proc.get('autolaunch', False)
        launch_mode = proc.get('launch_mode', 'always' if autolaunch else 'off')
        schedules = proc.get('schedules', None)

        state_info = {}
        if runtime_state:
            for key, val in runtime_state.items():
                if isinstance(val, dict) and val.get('id') == proc_id:
                    state_info = val
                    state_info['_pid'] = key
                    break

        # PID is the dict key in app_states.json, stored as _pid during lookup
        pid_str = state_info.get('_pid')
        pid = int(pid_str) if pid_str else None
        is_running = False
        if pid:
            try:
                p = psutil.Process(pid)
                is_running = p.is_running() and p.status() != psutil.STATUS_ZOMBIE
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                is_running = False

        result.append({
            'name': proc_name,
            'id': proc_id,
            'exe_path': proc.get('exe_path', proc.get('path', '')),
            'file_path': proc.get('file_path', ''),
            'cwd': proc.get('cwd', ''),
            'autolaunch': autolaunch,
            'launch_mode': launch_mode,
            'schedules': schedules,
            'running': is_running,
            'pid': pid if is_running else None,
            'status': state_info.get('status', 'unknown'),
        })

    return {'processes': result, 'count': len(result)}


def _get_running_processes(params, config):
    """Get all running OS processes, optionally filtered by name."""
    name_filter = params.get('name_filter', '').lower()
    limit = min(params.get('limit', 50), 200)

    processes = []
    for proc in psutil.process_iter(['pid', 'name', 'cpu_percent', 'memory_info', 'status', 'create_time']):
        try:
            info = proc.info
            if name_filter and name_filter not in info['name'].lower():
                continue

            mem_mb = round(info['memory_info'].rss / (1024 * 1024), 1) if info['memory_info'] else 0

            processes.append({
                'pid': info['pid'],
                'name': info['name'],
                'cpu_percent': info['cpu_percent'] or 0,
                'memory_mb': mem_mb,
                'status': info['status'],
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    processes.sort(key=lambda p: p['memory_mb'], reverse=True)
    processes = processes[:limit]

    return {'processes': processes, 'count': len(processes), 'total_running': len(list(psutil.process_iter()))}


def _get_network_info(params, config):
    """Get network interfaces and IP addresses."""
    interfaces = []
    addrs = psutil.net_if_addrs()
    stats = psutil.net_if_stats()

    for iface_name, addr_list in addrs.items():
        iface_stats = stats.get(iface_name)
        iface = {
            'name': iface_name,
            'is_up': iface_stats.isup if iface_stats else False,
            'speed_mbps': iface_stats.speed if iface_stats else 0,
            'addresses': [],
        }
        for addr in addr_list:
            if addr.family == socket.AF_INET:
                iface['addresses'].append({
                    'type': 'IPv4',
                    'address': addr.address,
                    'netmask': addr.netmask,
                })
            elif addr.family == socket.AF_INET6:
                iface['addresses'].append({
                    'type': 'IPv6',
                    'address': addr.address,
                })
        interfaces.append(iface)

    return {
        'hostname': socket.gethostname(),
        'interfaces': interfaces,
    }


def _get_disk_usage(params, config):
    """Get disk usage for all drives."""
    drives = []
    for partition in psutil.disk_partitions():
        try:
            usage = psutil.disk_usage(partition.mountpoint)
            drives.append({
                'device': partition.device,
                'mountpoint': partition.mountpoint,
                'fstype': partition.fstype,
                'total_gb': round(usage.total / (1024 ** 3), 2),
                'used_gb': round(usage.used / (1024 ** 3), 2),
                'free_gb': round(usage.free / (1024 ** 3), 2),
                'percent': usage.percent,
            })
        except (PermissionError, OSError):
            continue

    return {'drives': drives, 'count': len(drives)}


def _get_agent_config(params, config):
    """Get current agent configuration (sanitized — no secrets)."""
    if not config:
        config = shared_utils.read_config()

    if not config:
        return {'error': 'Unable to read agent configuration'}

    # Return config but strip sensitive fields
    safe_config = {}
    for key, val in config.items():
        if key in ('firebase',):
            # Include firebase section but strip auth tokens
            fb = dict(val) if isinstance(val, dict) else {}
            fb.pop('refresh_token', None)
            fb.pop('access_token', None)
            safe_config[key] = fb
        else:
            safe_config[key] = val

    return {
        'config': safe_config,
        'config_path': shared_utils.CONFIG_PATH,
        'version': shared_utils.get_app_version(),
    }


def _get_agent_logs(params, config):
    """Get recent Owlette agent log entries."""
    max_lines = min(params.get('max_lines', 100), 500)
    level_filter = params.get('level', None)  # 'ERROR', 'WARNING', 'INFO', 'DEBUG'

    log_dir = shared_utils.get_data_path('logs')
    if not os.path.isdir(log_dir):
        return {'error': 'Log directory not found', 'log_dir': log_dir}

    log_files = sorted(
        [f for f in os.listdir(log_dir) if f.endswith('.log')],
        reverse=True
    )

    if not log_files:
        return {'error': 'No log files found', 'log_dir': log_dir}

    log_path = os.path.join(log_dir, log_files[0])

    try:
        with open(log_path, 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()

        if level_filter:
            level_filter_upper = level_filter.upper()
            lines = [l for l in lines if level_filter_upper in l]

        recent = lines[-max_lines:]

        return {
            'log_file': log_files[0],
            'lines': [l.rstrip() for l in recent],
            'count': len(recent),
            'total_lines': len(lines),
        }
    except Exception as e:
        return {'error': f'Failed to read log file: {e}'}


def _get_agent_health(params, config):
    """Get agent health and connection status."""
    del params, config  # unused
    from health_probe import HealthProbe

    api_base = shared_utils.get_configured_api_base()
    state = HealthProbe(
        config_path=shared_utils.CONFIG_PATH,
        api_base=api_base,
    ).run()

    return {
        'status': state.status,
        'error_code': state.error_code,
        'error_message': state.error_message,
        'checked_at': state.checked_at,
        'checks': state.probe_results,
        'version': shared_utils.get_app_version(),
        'hostname': socket.gethostname(),
        'uptime_seconds': int(time.time() - psutil.boot_time()),
    }


def _get_display_layout(params, config):
    """Get current display topology (Tier 1 read-only)."""
    if config and config.get('displays', {}).get('enabled') is False:
        return {'error': 'display management is disabled (config.displays.enabled=false)'}
    try:
        import display_manager
        import nvapi_display
        profile = display_manager.build_display_profile()
        try:
            mosaic = nvapi_display.detect_mosaic()
            if mosaic:
                profile['mosaicActive'] = True
                profile['mosaicGrids'] = mosaic.get('grids', [])
            sync = nvapi_display.detect_sync()
            if sync:
                profile['syncDevices'] = sync.get('devices', [])
        except Exception:
            pass
        return profile
    except Exception as e:
        logger.error(f"get_display_layout failed: {e}")
        return {'error': str(e)}


# Tier 3: privileged tools


def _run_command(params, config, command_id=None):
    """Execute a shell command (validated against allow-list).

    Security: uses shell=False with shlex.split() to prevent shell injection
    via metacharacters (&&, |, ;, etc.). Only the first token is validated
    against the allow-list; remaining tokens are passed as arguments.

    When command_id is provided the subprocess is registered in
    _RUNNING_COMMANDS so cancel_mcp_tool can kill it mid-flight.
    """
    command = params.get('command', '').strip()
    if not command:
        return {'error': 'command parameter is required'}

    # posix=False keeps Windows backslashes in paths (POSIX mode treats \ as escape);
    # POSIX itself needs posix=True, where quoting is how a path with a space arrives.
    try:
        cmd_parts = shlex.split(command, posix=sys.platform != 'win32')
    except ValueError as e:
        return {'error': f'Invalid command syntax: {e}'}

    if not cmd_parts:
        return {'error': 'command parameter is required'}

    allowed = _get_allowed_commands(config)
    cmd_base = cmd_parts[0].lower()

    if not any(cmd_base == a.lower() for a in allowed):
        return {
            'error': f"Command '{cmd_base}' is not in the allow-list. Allowed: {', '.join(sorted(set(a.lower() for a in allowed)))}",
        }

    logger.info(f"[MCP-AUDIT] run_command: {cmd_base} (args: {len(cmd_parts) - 1})")

    returncode, stdout, stderr, timed_out = _run_tracked_subprocess(
        cmd_parts, SUBPROCESS_TIMEOUT, command_id,
    )
    if timed_out:
        return {'error': f'Command timed out after {SUBPROCESS_TIMEOUT} seconds'}

    return {
        'command': command,
        'exit_code': returncode,
        'stdout': stdout[:MAX_OUTPUT_SIZE],
        'stderr': stderr[:MAX_OUTPUT_SIZE],
    }


def _run_powershell(params, config, command_id=None):
    """Execute a PowerShell command. No allow-list — accountability comes from
    the Firestore audit trail (site logs / cortex-events) and the [MCP-AUDIT]
    local log. For novel/long-running scripts with configurable timeouts and
    process-tree cleanup, prefer execute_script.

    When command_id is provided the subprocess is registered in
    _RUNNING_COMMANDS so cancel_mcp_tool can kill it mid-flight.
    """
    del config  # unused
    script = params.get('script', '').strip()
    if not script:
        return {'error': 'script parameter is required'}

    # Audit preview, not just length: 500 chars identifies the script without
    # blowing up log rotation. Newlines become literal `\n` so a real pipe (`|`)
    # can't be misread as a line break.
    _preview = script[:500].replace('\r\n', '\n').replace('\n', '\\n')
    _truncated = '...' if len(script) > 500 else ''
    logger.info(f"[MCP-AUDIT] run_powershell ({len(script)} chars): {_preview}{_truncated}")

    try:
        returncode, stdout, stderr, timed_out = _run_tracked_subprocess(
            ['powershell', '-NoProfile', '-Command', script],
            SUBPROCESS_TIMEOUT, command_id,
        )
    except FileNotFoundError:
        # No interpreter on the machine: off Windows that is the platform
        # answering, in the same shape as every other Windows-only tool.
        return _unsupported_on_platform('run_powershell')
    if timed_out:
        return {'error': f'PowerShell command timed out after {SUBPROCESS_TIMEOUT} seconds'}

    return {
        'script': script,
        'exit_code': returncode,
        'stdout': stdout[:MAX_OUTPUT_SIZE],
        'stderr': stderr[:MAX_OUTPUT_SIZE],
    }


def _execute_script(params, config, command_id=None):
    """Execute a PowerShell script with no command restrictions.

    Uses Popen with a job object so the entire process tree (including
    child processes spawned by Start-Job, Start-Process, etc.) is killed
    on timeout instead of leaving orphans.

    When command_id is provided, the subprocess PID is registered in
    _RUNNING_COMMANDS for the duration of the run so cancel_mcp_tool can
    kill it mid-flight.
    """
    script = params.get('script', '').strip()
    if not script:
        return {'error': 'script parameter is required'}

    timeout = params.get('timeout_seconds', 120)
    if timeout > MAX_SCRIPT_TIMEOUT:
        logger.info(f"[MCP-AUDIT] execute_script timeout_seconds clamped: {timeout}s -> {MAX_SCRIPT_TIMEOUT}s")
        timeout = MAX_SCRIPT_TIMEOUT
    cwd = params.get('working_directory', None)

    if cwd and not os.path.isdir(cwd):
        return {'error': f'Working directory not found: {cwd}'}

    logger.info(f"[MCP-AUDIT] execute_script called. Script length: {len(script)} chars, timeout: {timeout}s")

    # -ExecutionPolicy Bypass: needed on kiosks with GPO AllSigned/Restricted.
    # Not a security boundary — SYSTEM can already do anything.
    try:
        returncode, stdout, stderr, timed_out = _run_tracked_subprocess(
            ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
            timeout, command_id, cwd=cwd,
        )
    except FileNotFoundError:
        return _unsupported_on_platform('execute_script')
    if timed_out:
        return {
            'script': script[:500],
            'stdout': stdout[:MAX_OUTPUT_SIZE],
            'stderr': stderr[:MAX_OUTPUT_SIZE],
            'error': f'Script timed out after {timeout} seconds — all child processes have been terminated',
            'timed_out': True,
        }

    return {
        'script': script[:500],
        'exit_code': returncode,
        'stdout': stdout[:MAX_OUTPUT_SIZE],
        'stderr': stderr[:MAX_OUTPUT_SIZE],
        'timed_out': False,
    }


def _get_allowed_file_bases(config):
    """Build the list of allowed base directories for file I/O.

    Includes Owlette data dirs, user profile, temp, and directories of any
    configured processes (so Cortex can inspect/write project files).
    """
    # expanduser/gettempdir rather than %TEMP% and %USERPROFILE%: expandvars
    # returns the literal off Windows, which would put '%USERPROFILE%' in the
    # allow-list and lock every file tool out of the home directory.
    bases = [
        shared_utils.get_data_path(),
        tempfile.gettempdir(),
        os.path.expanduser('~'),
    ]
    # Configured process dirs, e.g. TouchDesigner projects
    for proc in (config or {}).get('processes', []):
        proc_path = proc.get('path', '')
        if proc_path:
            bases.append(os.path.dirname(proc_path))
    return [os.path.realpath(b) for b in bases if b]


def _validate_file_path(file_path, config):
    """Validate that a file path is within allowed directories.

    Returns (ok, resolved_path_or_error).
    Compares through os.path.normcase — case-insensitively on Windows, exactly
    on a case-sensitive filesystem — with a path-separator check to prevent
    prefix collisions (e.g. OwletteEVIL matching Owlette).
    """
    resolved = os.path.realpath(file_path)
    resolved_cased = os.path.normcase(resolved)
    for base in _get_allowed_file_bases(config):
        base_cased = os.path.normcase(base)
        if resolved_cased.startswith(base_cased):
            # Under base, not merely prefix-matching it:
            # C:\ProgramData\OwletteEVIL must NOT match C:\ProgramData\Owlette.
            if len(resolved_cased) == len(base_cased) or resolved_cased[len(base_cased)] in ('\\', '/'):
                return True, resolved
    return False, f"Path is outside allowed directories: {file_path}"


def _read_file(params, config):
    """Read file contents with size limit and path validation."""
    file_path = params.get('path', '').strip()
    if not file_path:
        return {'error': 'path parameter is required'}

    ok, result = _validate_file_path(file_path, config)
    if not ok:
        logger.warning(f"[MCP-AUDIT] read_file BLOCKED: {result}")
        return {'error': result}

    resolved = result

    if not os.path.isfile(resolved):
        return {'error': f'File not found: {file_path}'}

    file_size = os.path.getsize(resolved)
    max_size = 100 * 1024  # 100 KB

    if file_size > max_size:
        return {'error': f'File too large ({file_size} bytes). Maximum: {max_size} bytes'}

    logger.info(f"[MCP-AUDIT] read_file: {resolved} ({file_size} bytes)")

    try:
        with open(resolved, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()

        return {
            'path': file_path,
            'content': content,
            'size_bytes': file_size,
            'lines': content.count('\n') + 1,
        }
    except Exception as e:
        return {'error': f'Failed to read file: {e}'}


def _write_file(params, config):
    """Write content to a file with path validation."""
    file_path = params.get('path', '').strip()
    content = params.get('content', '')

    if not file_path:
        return {'error': 'path parameter is required'}

    ok, result = _validate_file_path(file_path, config)
    if not ok:
        logger.warning(f"[MCP-AUDIT] write_file BLOCKED: {result}")
        return {'error': result}

    resolved = result

    logger.info(f"[MCP-AUDIT] write_file: {resolved} ({len(content)} chars)")

    try:
        dir_path = os.path.dirname(resolved)
        if dir_path and not os.path.isdir(dir_path):
            os.makedirs(dir_path, exist_ok=True)

        with open(resolved, 'w', encoding='utf-8') as f:
            f.write(content)

        return {
            'path': file_path,
            'size_bytes': len(content.encode('utf-8')),
            'status': 'written',
        }
    except Exception as e:
        return {'error': f'Failed to write file: {e}'}


def _list_directory(params, config):
    """List directory contents."""
    dir_path = params.get('path', '').strip()
    if not dir_path:
        return {'error': 'path parameter is required'}

    if not os.path.isdir(dir_path):
        return {'error': f'Directory not found: {dir_path}'}

    try:
        entries = []
        for entry in os.scandir(dir_path):
            info = {
                'name': entry.name,
                'is_dir': entry.is_dir(),
                'is_file': entry.is_file(),
            }
            try:
                stat = entry.stat()
                info['size_bytes'] = stat.st_size if entry.is_file() else None
                info['modified'] = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(stat.st_mtime))
            except OSError:
                pass
            entries.append(info)

        entries.sort(key=lambda e: (not e['is_dir'], e['name'].lower()))

        return {
            'path': dir_path,
            'entries': entries[:200],
            'count': len(entries),
        }
    except Exception as e:
        return {'error': f'Failed to list directory: {e}'}


# Helpers


def _kill_process_tree(pid):
    """Kill a process and all its descendants using psutil."""
    try:
        parent = psutil.Process(pid)
        children = parent.children(recursive=True)
        for child in reversed(children):
            try:
                child.kill()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        parent.kill()
        psutil.wait_procs(children + [parent], timeout=5)
    except psutil.NoSuchProcess:
        pass  # Already dead
    except Exception as e:
        logger.warning(f"Failed to kill process tree (PID {pid}): {e}")


def _get_allowed_commands(config):
    """The command allow-list from config, or this platform's default."""
    if config and 'mcp' in config:
        custom = config['mcp'].get('allowed_commands', [])
        if custom:
            return custom
    if sys.platform == 'win32':
        return _WINDOWS_ALLOWED_COMMANDS
    return _POSIX_ALLOWED_COMMANDS


def gpu_totals():
    """GPU-level summary (model, total/used VRAM) from NVML; both arms read it."""
    gpus = [{
        'index': g.id,
        'name': g.name,
        'vram_total_mb': round(g.memoryTotal),
        'vram_used_mb': round(g.memoryUsed),
        'vram_free_mb': round(g.memoryFree),
    } for g in shared_utils.get_gpus()]

    return {'gpus': gpus, 'source': 'pynvml' if gpus else 'unavailable'}


def _name_matches(process_name, pattern_lower, match_exact):
    """Whether a process name matches manage_process's pattern."""
    lowered = process_name.lower()
    if match_exact:
        return lowered == pattern_lower
    return fnmatch.fnmatch(lowered, pattern_lower)


# Tier 2: purpose-built admin tools (validated params, no raw shell)


def _manage_process(params, config):
    """Kill / suspend / resume OS processes by name pattern.

    Safer alternative to run_command + taskkill — structured params, no shell,
    refuses to touch critical system processes.
    """
    action = (params.get('action') or '').lower()
    name_pattern = (params.get('name_pattern') or '').strip()
    match_exact = params.get('match_exact', True)
    force = params.get('force', True)

    if action not in ('kill', 'suspend', 'resume'):
        return {'error': f"Invalid action '{action}'. Must be kill/suspend/resume."}
    if not name_pattern:
        return {'error': 'name_pattern is required'}

    pattern_lower = name_pattern.lower()

    logger.info(f"[MCP-AUDIT] manage_process: action={action} pattern={name_pattern} exact={match_exact}")

    matched = []
    skipped_critical = []
    succeeded = []
    failed = []

    for proc in psutil.process_iter(['pid', 'name']):
        try:
            pname = proc.info.get('name') or ''
            if not _name_matches(pname, pattern_lower, match_exact):
                continue
            matched.append({'pid': proc.info['pid'], 'name': pname})

            if _is_critical_process(pname):
                skipped_critical.append(pname)
                continue

            try:
                if action == 'kill':
                    if force:
                        proc.kill()  # SIGKILL equivalent on Windows
                    else:
                        shared_utils.graceful_terminate(proc.info['pid'], timeout=5)
                elif action == 'suspend':
                    proc.suspend()
                elif action == 'resume':
                    proc.resume()
                succeeded.append({'pid': proc.info['pid'], 'name': pname})
            except (psutil.NoSuchProcess, psutil.AccessDenied) as e:
                failed.append({'pid': proc.info['pid'], 'name': pname, 'error': str(e)})
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    return {
        'action': action,
        'pattern': name_pattern,
        'matched_count': len(matched),
        'succeeded': succeeded,
        'failed': failed,
        'skipped_critical': skipped_critical,
    }


# Provisioning & maintenance


def _apply_display_topology(params, config):
    """Apply a display layout (Tier 2 admin)."""
    if config and config.get('displays', {}).get('enabled') is False:
        return {'error': 'display management is disabled (config.displays.enabled=false)'}
    try:
        layout = params.get('layout')
        if not isinstance(layout, dict) or 'monitors' not in layout:
            return {'error': 'layout parameter must be a dict with a monitors list'}
        if not isinstance(layout.get('monitors'), list):
            return {'error': 'layout.monitors must be a list'}
        monitor_count = len(layout.get('monitors', []))
        logger.info(f"[MCP-AUDIT] apply_display_topology: monitors={monitor_count}")
        import display_manager
        result = display_manager.apply_topology(layout)
        return result
    except NotImplementedError:
        return {'error': 'apply_topology not yet implemented (Wave 5)'}
    except Exception as e:
        logger.error(f"apply_display_topology failed: {e}")
        return {'error': str(e)}
