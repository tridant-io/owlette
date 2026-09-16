"""The POSIX arm of the hoot tool surface.

Six of the tools `mcp_tools.execute_tool` publishes have a macOS and a Linux
backend; every other Windows-shaped tool refuses through mcp_tools' one gate.
`run_command` is the sixth and stays in mcp_tools — it is cancellable, and this
platform reaches it through the allow-list — so five handlers live here, under
their published Windows wire names.

Every backend shells out through `mcp_tools.run_capture`, so a missing binary or
a hung query comes back as a -1 return code with the reason in stderr rather
than an exception.
"""

import json
import logging
import os
import re
import sys
from datetime import datetime

import psutil

import mcp_tools

logger = logging.getLogger(__name__)

# The published `level` enum (Error / Warning / Information) in each log's own
# vocabulary. journalctl's --priority takes a severity ceiling — `err` means err
# and everything above it — so each level is spelled as the FROM..TO range that
# carries its own name below, the way the Windows arm's -EntryType matches one
# type exactly. macOS has no warning level: `default` is the band between info
# and error, which is where warning sits on the other two platforms.
_JOURNAL_PRIORITIES = {
    'error': 'err..err', 'warning': 'warning..warning', 'information': 'notice..info',
}
_LOG_MESSAGE_TYPES = {'error': 'error', 'warning': 'default', 'information': 'info'}

# syslog priority -> the level names the Windows arm reports, so a hoot turn
# reads one vocabulary whatever the machine is.
_JOURNAL_LEVELS = {
    '0': 'Critical', '1': 'Critical', '2': 'Critical', '3': 'Error',
    '4': 'Warning', '5': 'Information', '6': 'Information', '7': 'Verbose',
}

# `log show`'s message types, in that same vocabulary — the inverse of
# _LOG_MESSAGE_TYPES, so a filtered query answers in the level it was asked for.
_LOG_SHOW_LEVELS = {
    'fault': 'Critical', 'error': 'Error', 'default': 'Warning',
    'info': 'Information', 'debug': 'Verbose',
}

# systemctl's ActiveState and UnitFileState, in the same vocabulary.
_SYSTEMD_STATES = {
    'active': 'running', 'reloading': 'running', 'inactive': 'stopped',
    'failed': 'failed', 'activating': 'start_pending', 'deactivating': 'stop_pending',
}
_SYSTEMD_START_TYPES = {
    'enabled': 'automatic', 'enabled-runtime': 'automatic', 'static': 'system',
    'generated': 'system', 'indirect': 'demand_start', 'disabled': 'demand_start',
    'masked': 'disabled', 'masked-runtime': 'disabled',
}

# A systemd unit name or a launchd label, either with an instance suffix.
_SERVICE_NAME = re.compile(r'^[\w.@:\-]+$')

# What manage_windows_service can do here: launchd has no pause/continue, and
# systemd's restart policy is unit configuration, not a runtime call.
_SUPPORTED_ACTIONS = ('start', 'stop', 'restart', 'set_startup', 'get_details')

# Debian and Ubuntu write this when a package upgrade needs a reboot. /run is
# the real path; /var/run is the compatibility symlink on older images.
_REBOOT_MARKERS = ('/run/reboot-required', '/var/run/reboot-required')

# Where launchd keeps system-domain daemon plists. A job that `stop` booted out
# of the domain is loaded back from its own file, which is named for its label.
_LAUNCH_DAEMON_DIRS = ('/Library/LaunchDaemons', '/System/Library/LaunchDaemons')


def _is_macos():
    return sys.platform == 'darwin'


# Helpers


def _systemd_properties(out):
    """`systemctl show` output — one KEY=VALUE per line — as a dict."""
    return dict(
        line.split('=', 1) for line in out.splitlines() if '=' in line
    )


def _launchctl_value(out, key):
    """One value out of `launchctl list <label>`'s plist-shaped dump."""
    match = re.search(rf'"{key}"\s*=\s*([^;]+);', out)
    return match.group(1).strip().strip('"') if match else None


def _print_value(out, key):
    """One `key = value` line out of `launchctl print`'s indented dump."""
    match = re.search(rf'^\s*{key}\s*=\s*(.+)$', out, re.MULTILINE)
    return match.group(1).strip() if match else None


def _from_epoch_microseconds(value):
    """journald's __REALTIME_TIMESTAMP as a datetime."""
    try:
        return datetime.fromtimestamp(int(value) / 1_000_000)
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def _from_log_timestamp(value):
    """`log show`'s '2026-09-15 09:12:31.123456-0700' as a datetime."""
    try:
        return datetime.strptime(str(value)[:19], '%Y-%m-%d %H:%M:%S')
    except (TypeError, ValueError):
        return None


def _event(moment, level, source, message, now):
    """One log line in the shape the Windows arm returns."""
    entry = {
        'time': moment.strftime('%Y-%m-%d %H:%M:%S') if moment else '',
        'level': level,
        'source': source,
        'message': str(message)[:500],
    }
    if moment is not None:
        entry['time_ago'] = mcp_tools.time_ago(moment, now)
    return entry


def _journal_events(out, now):
    """`journalctl --output=json`: one JSON object per line. None if unparsable."""
    events = []
    for line in out.splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            return None
        events.append(_event(
            _from_epoch_microseconds(record.get('__REALTIME_TIMESTAMP')),
            _JOURNAL_LEVELS.get(str(record.get('PRIORITY')), ''),
            record.get('SYSLOG_IDENTIFIER') or record.get('_COMM') or '',
            record.get('MESSAGE') or '',
            now,
        ))
    return events


def _log_show_events(out, now):
    """`log show --style json`: one JSON array. None if unparsable."""
    try:
        records = json.loads(out) if out.strip() else []
    except ValueError:
        return None
    if isinstance(records, dict):
        records = [records]
    return [
        _event(
            _from_log_timestamp(record.get('timestamp')),
            _LOG_SHOW_LEVELS.get((record.get('messageType') or '').lower(), ''),
            record.get('subsystem') or os.path.basename(record.get('processImagePath') or ''),
            record.get('eventMessage') or '',
            now,
        )
        for record in records
    ]


def _state_argv(service_name, action):
    """The start / stop / restart command for this init system."""
    if _is_macos():
        target = f'system/{service_name}'
        if action == 'start':
            return ['launchctl', 'kickstart', target]
        if action == 'restart':
            return ['launchctl', 'kickstart', '-k', target]
        # bootout, not `kill SIGTERM`: a signal only asks, and launchd relaunches
        # any job with KeepAlive — which the owlette daemon's own plist carries.
        return ['launchctl', 'bootout', target]
    return ['systemctl', action, service_name]


def _startup_argv(service_name, startup):
    """The commands that set this start type, in order, or None for a start type
    this OS cannot express — launchd knows only enabled and disabled."""
    if _is_macos():
        verb = {'auto': 'enable', 'disabled': 'disable'}.get(startup)
        return [['launchctl', verb, f'system/{service_name}']] if verb else None
    verb = {'auto': 'enable', 'manual': 'disable', 'disabled': 'mask'}.get(startup)
    if verb is None:
        return None
    # enable and disable both fail on a masked unit, and nothing else here lifts
    # a previous `set_startup disabled`. Unmasking one that is not masked is a
    # no-op, so auto and manual always arrive at the state they name.
    if verb == 'mask':
        return [['systemctl', verb, service_name]]
    return [['systemctl', 'unmask', service_name], ['systemctl', verb, service_name]]


def _bootstrap_then_retry(service_name, action, failure):
    """Load a booted-out daemon back into the system domain, then retry.

    kickstart reaches only a job that is still bootstrapped, and `stop` boots the
    job out — so without this, a stop through this tool could not be undone
    through it. Returns the original failure when the label has no plist where
    launchd keeps them, or when it cannot be bootstrapped.
    """
    plist = next(
        (path for path in (f'{d}/{service_name}.plist' for d in _LAUNCH_DAEMON_DIRS)
         if os.path.exists(path)), None,
    )
    if plist is None:
        return failure
    rc, _, _ = mcp_tools.run_capture(['launchctl', 'bootstrap', 'system', plist], 60)
    if rc != 0:
        return failure
    return mcp_tools.run_capture(_state_argv(service_name, action), 60)


def _service_details(service_name):
    """get_details, keyed like the Windows arm's payload."""
    if _is_macos():
        rc, out, err = mcp_tools.run_capture(
            ['launchctl', 'print', f'system/{service_name}'], 15,
        )
        if rc != 0:
            return {'error': f'Service not found or launchctl print failed: {(err or out).strip()}'}
        pid = _print_value(out, 'pid')
        return {
            'service': service_name,
            'display_name': None,
            'description': None,
            'status': _print_value(out, 'state') or 'unknown',
            'process_id': int(pid) if pid and pid.isdigit() else None,
            'start_type': 'unknown',
            'binary_path': _print_value(out, 'program') or _print_value(out, 'path'),
            'log_on_account': _print_value(out, 'username'),
            'dependencies': None,
            'recovery_raw': out[:mcp_tools.MAX_OUTPUT_SIZE],
        }

    rc, out, err = mcp_tools.run_capture(
        ['systemctl', 'show', service_name, '--no-pager',
         '--property=Description,ActiveState,UnitFileState,MainPID,ExecStart,User,Requires,Restart'],
        15,
    )
    if rc != 0:
        return {'error': f'Service not found or systemctl show failed: {(err or out).strip()}'}
    unit = _systemd_properties(out)
    main_pid = unit.get('MainPID', '0')
    return {
        'service': service_name,
        'display_name': unit.get('Description') or None,
        'description': unit.get('Description') or None,
        'status': _SYSTEMD_STATES.get(unit.get('ActiveState', ''), 'unknown'),
        'process_id': int(main_pid) if main_pid.isdigit() and main_pid != '0' else None,
        'start_type': _SYSTEMD_START_TYPES.get(unit.get('UnitFileState', ''), 'unknown'),
        'binary_path': unit.get('ExecStart') or None,
        'log_on_account': unit.get('User') or 'root',
        'dependencies': unit.get('Requires') or None,
        'recovery_raw': unit.get('Restart') or None,
    }


# Tier 1: read-only


def get_event_logs(params, config):
    """Recent system log entries: `log show` on macOS, journalctl on Linux.

    The Windows log_name (Application / System / Security) has no POSIX
    counterpart — both backends read the one system journal — so it is echoed
    back rather than applied, and `source` says which journal answered.
    """
    del config
    log_name = params.get('log_name', 'Application')
    max_events = min(params.get('max_events', 20), 100)
    level = (params.get('level') or '').lower()

    if _is_macos():
        source = 'log show'
        # The unified log takes a time window, not a count, so the window is the
        # only bound on the work — the daemon decodes every record `log show`
        # prints — and it is what max_events has to shrink here, the way it is
        # --lines on the journalctl arm. Ten minutes, the cap, is already far
        # more than the twenty records the default asks for. `log show` leaves
        # info-level messages out unless they are asked for.
        window = min(10, max(1, max_events // 2))
        cmd = ['log', 'show', '--style', 'json', '--last', f'{window}m']
        if level:
            message_type = _LOG_MESSAGE_TYPES.get(level)
            if message_type is None:
                return {'error': f"Invalid level '{params.get('level')}'. Use: Error/Warning/Information"}
            cmd += ['--predicate', f'messageType == {message_type}']
            if message_type == 'info':
                cmd.append('--info')
    else:
        source = 'journalctl'
        cmd = ['journalctl', '--output=json', '--no-pager', f'--lines={max_events}']
        if level:
            priority = _JOURNAL_PRIORITIES.get(level)
            if priority is None:
                return {'error': f"Invalid level '{params.get('level')}'. Use: Error/Warning/Information"}
            cmd.append(f'--priority={priority}')

    rc, out, err = mcp_tools.run_capture(cmd, mcp_tools.SUBPROCESS_TIMEOUT)
    if rc != 0:
        return {'error': f'Failed to query {source}: {(err or out).strip()[:500]}'}

    now = datetime.now()
    events = _log_show_events(out, now) if _is_macos() else _journal_events(out, now)
    if events is None:
        return {'error': f'Failed to parse {source} output'}

    # Both journals answer oldest first; the tool reports newest first.
    events.reverse()
    events = events[:max_events]
    return {'log_name': log_name, 'events': events, 'count': len(events), 'source': source}


def get_service_status(params, config):
    """A service's state and start type: launchd on macOS, systemd on Linux."""
    del config
    service_name = params.get('service_name')
    if not service_name:
        return {'error': 'service_name parameter is required'}
    if not _SERVICE_NAME.match(service_name):
        return {'error': f"Invalid service_name '{service_name}'"}

    if _is_macos():
        rc, out, err = mcp_tools.run_capture(['launchctl', 'list', service_name], 15)
        if rc != 0:
            return {'error': f'Failed to query service {service_name}: '
                             f'{(err or out).strip() or "not loaded"}'}
        pid = _launchctl_value(out, 'PID')
        return {
            'service_name': service_name,
            'status': 'running' if pid else 'stopped',
            'start_type': 'demand_start' if _launchctl_value(out, 'OnDemand') == 'true' else 'automatic',
            'pid': int(pid) if pid and pid.isdigit() else None,
        }

    rc, out, err = mcp_tools.run_capture(
        ['systemctl', 'show', service_name, '--no-pager',
         '--property=ActiveState,SubState,UnitFileState,LoadState'], 15,
    )
    if rc != 0:
        return {'error': f'Failed to query service {service_name}: {(err or out).strip()}'}
    unit = _systemd_properties(out)
    if unit.get('LoadState') == 'not-found':
        return {'error': f'Service not found: {service_name}'}
    return {
        'service_name': service_name,
        'status': _SYSTEMD_STATES.get(unit.get('ActiveState', ''), 'unknown'),
        'start_type': _SYSTEMD_START_TYPES.get(unit.get('UnitFileState', ''), 'unknown'),
        'sub_state': unit.get('SubState', ''),
    }


def check_pending_reboot(params, config):
    """Whether the OS is waiting on a reboot (read-only).

    The keys match the Windows arm's exactly — osadapter.pending_reboot() is one
    shape on all three platforms — and neither POSIX source reports when the
    last update landed or when the next one is due.
    """
    del params, config
    if _is_macos():
        rc, out, err = mcp_tools.run_capture(
            ['softwareupdate', '--list', '--no-scan'], mcp_tools.SUBPROCESS_TIMEOUT,
        )
        if rc != 0:
            return {'error': f'softwareupdate query failed: {(err or out).strip()[:500]}'}
        # softwareupdate tags an update that needs one with `[restart]`, on
        # either stream depending on the release.
        reasons = ['software_update'] if '[restart]' in (out + err).lower() else []
    else:
        reasons = ['package_update'] if any(os.path.exists(p) for p in _REBOOT_MARKERS) else []

    return {
        'pending': bool(reasons),
        'reasons': reasons,
        'last_update_installed': None,
        'next_scheduled_update': None,
    }


def get_gpu_processes(params, config):
    """Per-process GPU memory via nvidia-smi, with the NVML totals beside it.

    The Windows arm reads WDDM performance counters, which have no POSIX
    counterpart: here only NVIDIA reports per-process VRAM, and only for compute
    clients. A machine without nvidia-smi gets an empty list and the reason.
    """
    del params, config
    totals = mcp_tools.gpu_totals()
    rc, out, err = mcp_tools.run_capture(
        ['nvidia-smi', '--query-compute-apps=pid,used_gpu_memory',
         '--format=csv,noheader,nounits'], 15,
    )
    if rc != 0:
        return {
            'processes': [],
            'process_count': 0,
            'gpu': totals,
            'note': 'per-process GPU memory needs nvidia-smi: '
                    f'{(err or out).strip()[:200] or "it is not installed on this machine"}',
        }

    processes = []
    for line in out.splitlines():
        fields = [field.strip() for field in line.split(',')]
        if len(fields) != 2 or not fields[0].isdigit():
            continue
        try:
            dedicated_mb = round(float(fields[1]), 1)
        except ValueError:
            continue
        pid = int(fields[0])
        proc_name = 'Unknown'
        try:
            proc_name = psutil.Process(pid).name()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        processes.append({
            'pid': pid,
            'name': proc_name,
            'dedicated_gpu_mb': dedicated_mb,
            'shared_gpu_mb': 0,
        })

    processes.sort(key=lambda proc: proc['dedicated_gpu_mb'], reverse=True)
    return {'processes': processes, 'process_count': len(processes), 'gpu': totals}


# Tier 2: purpose-built admin


def manage_windows_service(params, config):
    """Service control under its published name: systemctl / launchctl here.

    The name is the wire contract the dashboard, the SDKs and every shipped
    hoot prompt already use — it is not renamed for POSIX, it gains arms.
    """
    del config
    action = (params.get('action') or '').lower()
    service_name = (params.get('service_name') or '').strip()

    if not service_name:
        return {'error': 'service_name is required'}
    if not _SERVICE_NAME.match(service_name):
        return {'error': f"Invalid service_name '{service_name}'"}

    logger.info(f"[MCP-AUDIT] manage_windows_service: action={action} service={service_name}")

    if action not in _SUPPORTED_ACTIONS:
        return {'error': f"Action '{action}' is not supported on {sys.platform}. "
                         f"Use: {'/'.join(_SUPPORTED_ACTIONS)}"}

    if action == 'get_details':
        return _service_details(service_name)

    if action == 'set_startup':
        startup = (params.get('startup_type') or '').lower()
        commands = _startup_argv(service_name, startup)
        if commands is None:
            usable = 'auto/disabled' if _is_macos() else 'auto/manual/disabled'
            return {'error': f"Invalid startup_type '{startup}'. Use: {usable}"}
        for argv in commands:
            rc, out, err = mcp_tools.run_capture(argv, 30)
            if rc != 0:
                return {'error': f'set_startup failed: {(err or out).strip()}'}
        return {'action': action, 'service': service_name,
                'startup_type': startup, 'status': 'ok'}

    rc, out, err = mcp_tools.run_capture(_state_argv(service_name, action), 60)
    if rc != 0 and _is_macos() and action in ('start', 'restart'):
        rc, out, err = _bootstrap_then_retry(service_name, action, (rc, out, err))
    if rc != 0:
        return {'error': f'{action} failed: {(err or out).strip()}'}
    return {'action': action, 'service': service_name, 'status': 'ok'}


# The handler half of the tool table: `mcp_tools.execute_tool` merges this over
# its own cross-platform handlers, and `tools_windows.HANDLERS` is its opposite
# number. Keys are the published wire names.
HANDLERS = {
    'get_event_logs': get_event_logs,
    'get_service_status': get_service_status,
    'check_pending_reboot': check_pending_reboot,
    'get_gpu_processes': get_gpu_processes,
    'manage_windows_service': manage_windows_service,
}
