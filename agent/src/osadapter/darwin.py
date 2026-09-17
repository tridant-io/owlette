"""The macOS arm of the osadapter surface.

What macOS and Linux answer the same way is `posix`, imported here and
re-exported so the package has one module per platform to select. The session
half is among it: who is at the console, the environment of their session and
the spawn into it are answered by posix's own helpers, which carry the macOS
mechanism beside the Linux one, because the shared operations resolve those
helpers inside `posix` and an override here would never be reached. This file
is what macOS does differently — launchd for service control, IOPlatformUUID
for identity, application bundles for the software inventory, BSD `shutdown`
for the reboot subsystem, and a capture that answers to the desktop app's
Screen Recording grant rather than to a display server.
"""

from __future__ import annotations

import ctypes
import functools
import json
import logging
import os
import plistlib
import pwd
import re
import stat
import subprocess
import tempfile
import threading
import time
import uuid

import psutil

from . import posix
from .posix import (
    console_user,
    data_root,
    desktop_process_name,
    json_lock,
    launch_managed_process,
    notify,
    run_job,
    session_env,
    spawn_as_user,
)

logger = logging.getLogger(__name__)

# The LaunchDaemon the package installs, and what the agent's own service name
# — spelled for the Windows SCM wherever it is configured — resolves to here.
SERVICE_LABEL = 'app.owlette.agent'
LAUNCH_DAEMONS_DIR = '/Library/LaunchDaemons'
# A launchd label, as the plist that defines it is named after it.
_LABEL = re.compile(r'^[\w.@:\-]+$')
# launchctl's exit for a service the domain does not know.
_LAUNCHCTL_NO_SUCH_SERVICE = 113

# The waits owlette-host uses for the same controls on Windows
# (agent/host/src/registration.rs): a stop is generous because the agent
# flushes `online: false` inside that window.
_SERVICE_CONTROLS = {
    'start': (True, 60),
    'stop': (False, 45),
    'restart': (True, 60),
}
_LAUNCHCTL_TIMEOUT_SECONDS = 30
_STATE_POLL_SECONDS = 0.5

# What the daemon starts in the console user's session — a managed process, or
# hoot — runs as a launchd job in that user's GUI domain, labelled under this
# prefix (_spawn_in_gui_domain).
SESSION_JOB_PREFIX = 'app.owlette.session.'
# One line of `launchctl print gui/<uid>`'s services block naming a session job
# of ours: its pid (0 once exited), its last exit status, and its label.
_SESSION_JOB_LINE = re.compile(
    rf'^\s*(\d+)\s+\S+\s+({re.escape(SESSION_JOB_PREFIX)}[0-9a-f]{{32}})\s*$')
# launchd's spawn trampoline, which a job's pid is until it execs the program.
XPCPROXY = '/usr/libexec/xpcproxy'
_EXEC_SETTLE_SECONDS = 5
_EXEC_SETTLE_POLL_SECONDS = 0.01
# How long one spawn may take end to end, launchctl round-trips and the exec
# wait included: the monitor loop launches managed processes itself, and a
# launchd that has stopped answering must not hold it for every call's own
# timeout in turn.
_SPAWN_BUDGET_SECONDS = 10
# One spawn into a session at a time. A sweep boots out every session job in
# the domain that has no process, and a job another spawn has bootstrapped but
# not yet kickstarted is exactly that; managed entries launch under locks of
# their own, and hoot beside them.
_session_spawn_lock = threading.Lock()

# BSD shutdown(8): with a countdown it forks a scheduler that calls setsid(),
# is adopted by launchd, sleeps the countdown out and then reboots through
# launchd, which ends every process — nothing in a session can hold it off.
SHUTDOWN_COMMAND = '/sbin/shutdown'
_LAUNCHD_PID = 1
_SHUTDOWN_TIMEOUT_SECONDS = 15

# The IORegistry, read in-process rather than through `ioreg`: the console is
# asked about every five seconds while a managed process is down, and a spawn
# per question costs the daemon a fork and tens of milliseconds where a read
# costs tens of microseconds.
_IOKIT = '/System/Library/Frameworks/IOKit.framework/IOKit'
_CORE_FOUNDATION = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'
_MAIN_PORT_DEFAULT = 0
_CF_STRING_ENCODING_UTF8 = 0x08000100
_CF_BINARY_PLIST = 200
# Every login session WindowServer knows, with the flags that say which one is
# at the screen. `loginwindow` sits in the list at the login window, and
# `_mbsetupuser` while Setup Assistant runs; neither is anyone's login.
_CONSOLE_USERS = 'IOConsoleUsers'
_NOT_A_LOGIN = frozenset({'root', 'loginwindow'})
CONSOLE_SESSION_TYPE = 'aqua'
# The machine's hardware UUID as the platform expert publishes it — the value
# System Information shows, stable across renames, reinstalls and OS upgrades.
_PLATFORM_EXPERT = b'IOPlatformExpertDevice'
_UUID = re.compile(r'^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$')

# Where applications are installed, walked directly rather than asked of
# Spotlight. `system_profiler SPApplicationsDataType` answers with what
# Spotlight returns: on the macOS 26 machine this arm was written on, it and
# `mdfind` both reported none of the 67 bundles in /Applications with indexing
# enabled on every volume, and a kiosk image may have indexing off entirely.
# Every account's own Applications folder is walked as well; a bundle is never
# descended into, so the helpers inside one are not installed software.
APPLICATION_DIRS = ('/Applications',)
USERS_DIR = '/Users'
# /Applications/<vendor>/<suite>/<name>.app is as deep as installers go.
_APPLICATION_DEPTH = 3
# How many directory entries one inventory opens before it stops: a folder of
# project files dropped into /Applications must not turn the walk into a crawl.
_INVENTORY_SCAN_LIMIT = 8192

# What the desktop app publishes about its own TCC grants
# (desktop/src-tauri/src/tcc.rs, task 4.4): a JSON object carrying
# `screen_recording` (bool) and `checked_at` (unix seconds), written by the app
# as the console user. The grant can be withdrawn in System Settings at any
# moment, so a report older than the bound below is no report at all.
TCC_STATE_FILE = 'ipc/tcc.json'
TCC_STATE_MAX_AGE_SECONDS = 300
# How far ahead of this clock a report may claim to be before it is refused.
_TCC_CLOCK_SKEW_SECONDS = 60
_TCC_STATE_LIMIT = 4096


def capture_screen(monitor: int, *, executor, timeout_s: int) -> dict:
    """Grab `monitor` through the desktop app, unless it has said it cannot.

    TCC ties Screen Recording to the app's bundle, and on macOS a grab made
    without the grant need not fail — it can come back as a frame missing every
    other application's windows. An app that has reported the grant missing is
    never asked for a frame, and the refusal comes back in the shape a failed
    job does. An app that has not reported either way is asked, and its job
    runner answers for the grant itself.
    """
    if _screen_recording_granted() is False:
        return {
            'error': 'screen_recording_not_granted',
            'message': (
                'screen recording has not been granted to the owlette app on '
                'this machine'
            ),
        }
    return posix.capture_screen(monitor, executor=executor, timeout_s=timeout_s)


def stable_machine_id() -> str:
    """The hardware UUID — stable across reboots, renames and reinstalls."""
    return _platform_uuid()


def key_material() -> bytes:
    """Machine-bound material for the token store's key derivation."""
    return _platform_uuid().encode()


def service_control(verb: str, name: str) -> bool:
    """start / stop / restart a LaunchDaemon; True once it reached the state.

    Both properties the callers rely on, the way the other arms have them: a
    stop answers once the job has exited, and a job already in the requested
    state is a success. A stop is a `bootout` — launchd relaunches a job that
    carries KeepAlive, as the agent's own does, the moment a signal ends it —
    so a start or restart that finds the job unloaded bootstraps it back from
    its plist first. A label launchd does not know, with no plist to load it
    from, is in no state at all, and refusing the control is the answer.
    """
    control = _SERVICE_CONTROLS.get(verb)
    if control is None:
        raise ValueError(f"unknown service verb '{verb}'")
    wants_running, wait_seconds = control
    label = _label(name)
    if label is None:
        logger.warning(f"Refusing to control '{name}': not a launchd label")
        return False
    target = f'system/{label}'

    if verb == 'stop':
        issued = _run(['launchctl', 'bootout', target], wait_seconds)
    else:
        kickstart = ['launchctl', 'kickstart', *(['-k'] if verb == 'restart' else []), target]
        issued = _run(kickstart, _LAUNCHCTL_TIMEOUT_SECONDS)
        if issued is not None and issued.returncode == _LAUNCHCTL_NO_SUCH_SERVICE:
            if not _bootstrap(label):
                return False
            issued = _run(kickstart, _LAUNCHCTL_TIMEOUT_SECONDS)
    if issued is None:
        return False
    if issued.returncode != 0:
        logger.warning(
            f"launchctl {verb} {target} exited {issued.returncode}: "
            f"{issued.stderr.strip()}"
        )
        if not _known(label):
            return False
    return _await_state(label, wants_running, wait_seconds)


def pending_reboot() -> dict:
    """Whether a software update is waiting on a restart, and what asked for it."""
    import mcp_tools

    return mcp_tools.check_pending_reboot({}, None)


def reboot(delay: int, message: str | None = None) -> None:
    """Reboot in `delay` seconds; cancellable with cancel_reboot() until it fires."""
    _issue_shutdown('-r', delay, message)


def shutdown(delay: int, message: str | None = None) -> None:
    """Power off in `delay` seconds; cancellable with cancel_reboot() until it fires."""
    _issue_shutdown('-h', delay, message)


def cancel_reboot() -> bool:
    """Abort a pending reboot or shutdown; True when one was aborted.

    BSD `shutdown` has no `-c`. A scheduled shutdown is the process it forked,
    sleeping out the countdown in a session of its own with launchd as its
    parent, and ending that process is the cancel shutdown(8) documents — it
    removes /etc/nologin on its way out once the countdown has written it. The
    schedulers are found by what they are rather than by a pid kept from when
    one was issued: they outlive a daemon restart, a pid kept across one could
    name another process by then, and nothing the OS keeps records one either.
    A `shutdown` still attached to whoever ran it is not waiting on anything.
    """
    schedulers = _pending_shutdowns()
    if not schedulers:
        return False
    for scheduler in schedulers:
        try:
            scheduler.terminate()
        except psutil.NoSuchProcess:
            pass
        except psutil.Error as e:
            logger.warning(f"Could not end scheduled shutdown (PID {scheduler.pid}): {e}")
    _, alive = psutil.wait_procs(schedulers, timeout=_SHUTDOWN_TIMEOUT_SECONDS)
    for scheduler in alive:
        logger.warning(f"Scheduled shutdown (PID {scheduler.pid}) did not end")
    return not alive


def installed_software() -> list[dict[str, str]]:
    """Installed applications: name, version, publisher, uninstall command.

    One row per application bundle, read out of its own Info.plist. A bundle
    has no uninstaller to run and no publisher field — its signing identity is
    the only place that names one, and asking `codesign` about every bundle is
    a process per application on every inventory — so both are empty, and the
    uninstall command handler refuses a row without a command rather than
    guessing one. `install_location` and `installer_type` are carried on every
    row: the dashboard's uninstall dialog reads both off each one.
    """
    import shared_utils

    rows = []
    for bundle in _application_bundles():
        info = shared_utils.read_bundle_info(bundle)
        if info is None:
            continue
        version = info.get('CFBundleShortVersionString') or info.get('CFBundleVersion')
        rows.append({
            'name': os.path.basename(bundle)[:-len('.app')],
            'version': version if isinstance(version, str) else '',
            'publisher': '',
            'install_location': bundle,
            'uninstall_command': '',
            'installer_type': 'app',
        })
    rows.sort(key=lambda row: (row['name'].lower(), row['install_location']))
    logger.info(f"Found {len(rows)} installed applications")
    return rows


def streamer_capable() -> bool:
    """Whether this machine can drive a streaming session: the desktop app
    holds Screen Recording, as it last reported."""
    return _screen_recording_granted() is True


def _platform_uuid() -> str:
    """IOPlatformUUID; raises OSError when the registry does not publish one.

    Never a fallback. The token store's key is derived from this value, and a
    store that fails to decrypt reads as empty and is overwritten under
    whatever key the next save derives — so a stand-in answered for one failed
    read would unpair the machine for good, where a raise fails only the
    attempt that asked and writes nothing.
    """
    platform_uuid = _registry_property(_PLATFORM_EXPERT, 'IOPlatformUUID')
    if not isinstance(platform_uuid, str) or not _UUID.match(platform_uuid):
        raise OSError('the IORegistry did not report an IOPlatformUUID')
    return platform_uuid


def _spawn_in_gui_domain(argv, uid, env, cwd=None) -> int:
    """Start `argv` as a launchd job in `uid`'s GUI domain; returns its pid.

    launchd starts the job inside that login's own bootstrap namespace and
    audit session — where WindowServer, the pasteboard and notifications are
    reached — as that user, as its own TCC-responsible process, and with the
    per-user environment a GUI process expects; `env` is laid over it. The pid
    `kickstart -p` reports is the program's own and launchd is its parent, so
    it outlives a daemon restart and nothing is left for the daemon to reap.

    Not the plan's `launchctl asuser <uid> sudo -u <user>`: asuser keeps the
    pid, but sudo forks and waits on its PAM session, so the pid a supervisor
    recorded would have been sudo's, and a SIGKILL to it would orphan the very
    application it meant to end.

    Every job gets a label of its own, and the jobs of earlier spawns that have
    exited are booted out first: a job stays loaded after its process exits,
    and two managed entries with the same command line must never boot out
    each other's running instance. The job abandons its process group, so what
    the program leaves running when it exits is its own business, as it is on
    Windows and Linux, rather than launchd's to kill. Raises OSError when
    launchd refuses the job, the program never starts, or the spawn outruns
    its budget.
    """
    deadline = time.monotonic() + _SPAWN_BUDGET_SECONDS
    if not _session_spawn_lock.acquire(timeout=_SPAWN_BUDGET_SECONDS):
        raise OSError('another spawn into a session did not finish in time')
    try:
        return _spawn_job(argv, uid, env, cwd, deadline)
    finally:
        _session_spawn_lock.release()


def _spawn_job(argv, uid, env, cwd, deadline) -> int:
    """The spawn itself, under the session-spawn lock and within `deadline`."""
    domain = f'gui/{uid}'
    _sweep_session_jobs(domain, deadline)
    label = f'{SESSION_JOB_PREFIX}{uuid.uuid4().hex}'
    job = {
        'Label': label,
        'ProgramArguments': list(argv),
        'EnvironmentVariables': dict(env),
        'ProcessType': 'Interactive',
        'AbandonProcessGroup': True,
        'RunAtLoad': False,
        'KeepAlive': False,
    }
    if cwd:
        job['WorkingDirectory'] = cwd
    with tempfile.TemporaryDirectory() as staging:
        plist = os.path.join(staging, f'{label}.plist')
        with open(plist, 'wb') as f:
            plistlib.dump(job, f)
        _launchctl(['launchctl', 'bootstrap', domain, plist], deadline)
    service = f'{domain}/{label}'
    try:
        reported = _launchctl(['launchctl', 'kickstart', '-p', service], deadline).stdout.strip()
        if not reported.isdigit():
            raise OSError(f"launchctl kickstart named no pid for {service}: {reported!r}")
        pid = int(reported)
        _await_exec(pid, uid, deadline)
    except OSError:
        _run(['launchctl', 'bootout', service], _remaining(deadline, floor=1))
        raise
    return pid


def _sweep_session_jobs(domain: str, deadline: float) -> None:
    """Boot out the session jobs in `domain` whose process has exited.

    Read off `launchctl print`, whose services block lists every job as its
    pid — 0 once it has exited — its last exit status and its label. A job
    whose pid is not 0 is running and is never touched. The output is not
    launchctl's API: a format it no longer matches boots nothing out, and the
    exited jobs wait for the next sweep that can read them.
    """
    printed = _run(['launchctl', 'print', domain], _remaining(deadline))
    if printed is None or printed.returncode != 0:
        return
    for line in printed.stdout.splitlines():
        job = _SESSION_JOB_LINE.match(line)
        if job is None or job.group(1) != '0':
            continue
        if time.monotonic() >= deadline:
            return
        _run(['launchctl', 'bootout', f'{domain}/{job.group(2)}'], _remaining(deadline))


def _await_exec(pid: int, uid: int, deadline: float) -> None:
    """Wait for a job's pid to become the program it was started for.

    launchd hands the pid back while it can still be xpcproxy — root, and a
    different image — before that trampoline drops to the user and execs, and
    a supervisor records the identity of whatever the pid is on return. The
    program is anything that is no longer the trampoline and runs as the user:
    a script's image is its interpreter, and a symlinked path resolves, so
    neither is ever the argv it was started with. A pid that is gone before it
    was ever the program is a launch that failed — launchd could not change to
    the directory or exec the file, where Linux's Popen raises — and not a
    crash to alert on.
    """
    settled_by = min(deadline, time.monotonic() + _EXEC_SETTLE_SECONDS)
    while True:
        try:
            process = psutil.Process(pid)
            with process.oneshot():
                if process.exe() != XPCPROXY and process.uids().real == uid:
                    return
        except psutil.NoSuchProcess:
            raise OSError(f"PID {pid} exited before it became its program")
        except psutil.Error:
            pass
        if time.monotonic() >= settled_by:
            raise OSError(f"PID {pid} did not become its program as uid {uid}")
        time.sleep(_EXEC_SETTLE_POLL_SECONDS)


def _launchctl(command, deadline: float):
    """launchctl's result, raising OSError when it could not be run, refused,
    or there is no time left to run it in."""
    if time.monotonic() >= deadline:
        raise OSError(f"{' '.join(command[:2])} was not run: the spawn is out of time")
    result = _run(command, _remaining(deadline))
    if result is None:
        raise OSError(f"{' '.join(command[:2])} could not be run")
    if result.returncode != 0:
        raise OSError(
            f"{' '.join(command[:2])} exited {result.returncode}: "
            f"{(result.stderr or result.stdout).strip()}"
        )
    return result


def _remaining(deadline: float, floor: float = 0.1) -> float:
    """The seconds left before `deadline`, never less than `floor`."""
    return max(floor, deadline - time.monotonic())


def _console_session(uid=None):
    """The login at the console, `uid`'s when one is named; None if there is no seat.

    WindowServer publishes every login session in the IORegistry's
    IOConsoleUsers, and the seat is the one that is on the console and has
    finished logging in: a session switched away from under Fast User
    Switching is off the console, one still starting its login is not done,
    and the login window, Setup Assistant and root are nobody's login at all.
    Read in-process, so the question costs the loop no process spawn.
    """
    sessions = _registry_property(None, _CONSOLE_USERS)
    if not isinstance(sessions, list):
        return None
    for session in sessions:
        if not isinstance(session, dict):
            continue
        if session.get('kCGSSessionOnConsoleKey') is not True:
            continue
        if session.get('kCGSessionLoginDoneKey') is not True:
            continue
        name = session.get('kCGSSessionUserNameKey')
        session_uid = session.get('kCGSSessionUserIDKey')
        if not isinstance(name, str) or name in _NOT_A_LOGIN or name.startswith('_'):
            continue
        if type(session_uid) is not int or session_uid == 0:
            continue
        if uid is not None and session_uid != uid:
            continue
        return posix._Session(
            name, CONSOLE_SESSION_TYPE, str(session.get('kCGSSessionAuditIDKey', '')),
            session_uid,
        )
    return None


@functools.lru_cache(maxsize=None)
def _frameworks():
    """IOKit and CoreFoundation, loaded once and typed for the calls made."""
    iokit = ctypes.CDLL(_IOKIT)
    cf = ctypes.CDLL(_CORE_FOUNDATION)
    port, pointer = ctypes.c_uint32, ctypes.c_void_p
    for function, argtypes, restype in (
        (iokit.IORegistryGetRootEntry, [port], port),
        (iokit.IOServiceMatching, [ctypes.c_char_p], pointer),
        (iokit.IOServiceGetMatchingService, [port, pointer], port),
        (iokit.IORegistryEntryCreateCFProperty, [port, pointer, pointer, ctypes.c_uint32], pointer),
        (iokit.IOObjectRelease, [port], ctypes.c_int),
        (cf.CFStringCreateWithCString, [pointer, ctypes.c_char_p, ctypes.c_uint32], pointer),
        (cf.CFPropertyListCreateData, [pointer, pointer, ctypes.c_long, ctypes.c_ulong, pointer], pointer),
        (cf.CFDataGetLength, [pointer], ctypes.c_long),
        (cf.CFDataGetBytePtr, [pointer], pointer),
        (cf.CFRelease, [pointer], None),
    ):
        function.argtypes, function.restype = argtypes, restype
    return iokit, cf


def _registry_property(entry_class: bytes | None, name: str):
    """One property of an IORegistry entry, as the property-list value it is.

    `entry_class` names the first service of that class; None is the registry's
    root. None when the entry or the property is absent. The value crosses from
    CoreFoundation as a serialised property list, so nothing below this reads a
    CF object field by field.
    """
    iokit, cf = _frameworks()
    if entry_class is None:
        entry = iokit.IORegistryGetRootEntry(_MAIN_PORT_DEFAULT)
    else:
        # IOServiceGetMatchingService consumes the matching dictionary.
        entry = iokit.IOServiceGetMatchingService(
            _MAIN_PORT_DEFAULT, iokit.IOServiceMatching(entry_class))
    if not entry:
        return None
    try:
        key = cf.CFStringCreateWithCString(None, name.encode(), _CF_STRING_ENCODING_UTF8)
        if not key:
            return None
        try:
            value = iokit.IORegistryEntryCreateCFProperty(entry, key, None, 0)
        finally:
            cf.CFRelease(key)
    finally:
        iokit.IOObjectRelease(entry)
    if not value:
        return None
    try:
        data = cf.CFPropertyListCreateData(None, value, _CF_BINARY_PLIST, 0, None)
    finally:
        cf.CFRelease(value)
    if not data:
        return None
    try:
        return plistlib.loads(ctypes.string_at(cf.CFDataGetBytePtr(data), cf.CFDataGetLength(data)))
    except ValueError as e:
        logger.debug(f"IORegistry property {name} did not read as a property list: {e}")
        return None
    finally:
        cf.CFRelease(data)


def _label(name: str) -> str | None:
    """The launchd label a caller's service name means here, or None when the
    name cannot be one.

    The agent's own service is spelled for the Windows SCM everywhere it is
    configured, and this is the one place that knows its label on macOS. The
    label also names the plist a bootstrap reads, so it is held to the
    characters a label is made of before it reaches a path.
    """
    import shared_utils

    if name == shared_utils.SERVICE_NAME:
        return SERVICE_LABEL
    return name if _LABEL.match(name or '') else None


def _plist_path(label: str) -> str:
    return os.path.join(LAUNCH_DAEMONS_DIR, f'{label}.plist')


def _known(label: str) -> bool:
    """Whether launchd has the job loaded, or has a plist to load it from."""
    if os.path.isfile(_plist_path(label)):
        return True
    printed = _run(['launchctl', 'print', f'system/{label}'], _LAUNCHCTL_TIMEOUT_SECONDS)
    return printed is not None and printed.returncode == 0


def _bootstrap(label: str) -> bool:
    """Load a job that is not loaded back into the system domain from its plist."""
    plist = _plist_path(label)
    if not os.path.isfile(plist):
        logger.warning(f"launchd does not know {label} and there is no {plist} to load")
        return False
    loaded = _run(['launchctl', 'bootstrap', 'system', plist], _LAUNCHCTL_TIMEOUT_SECONDS)
    if loaded is None:
        return False
    if loaded.returncode != 0:
        logger.warning(
            f"launchctl bootstrap system {plist} exited {loaded.returncode}: "
            f"{loaded.stderr.strip()}"
        )
        return False
    return True


def _running(label: str) -> bool | None:
    """Whether the job is running; None when launchctl could not be asked."""
    printed = _run(['launchctl', 'print', f'system/{label}'], _LAUNCHCTL_TIMEOUT_SECONDS)
    if printed is None:
        return None
    if printed.returncode != 0:
        # Not loaded is not running — a booted-out job is a stopped one.
        return False
    # The job's own state is the first `state =` line, one tab in; the
    # blocks nested below it carry states of their own.
    match = re.search(r'^\tstate = (\S+)', printed.stdout, re.MULTILINE)
    return match is not None and match.group(1) == 'running'


def _await_state(label: str, wants_running: bool, wait_seconds: float) -> bool:
    """Poll the job until it is in the state the control asked for.

    `kickstart` returns once the start is issued, not once the job is up, so
    the state is watched for rather than read once.
    """
    deadline = time.monotonic() + wait_seconds
    while True:
        running = _running(label)
        if running is not None and running is wants_running:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(_STATE_POLL_SECONDS)


def _application_bundles() -> list[str]:
    """Every application bundle under the directories applications live in."""
    roots = list(APPLICATION_DIRS)
    try:
        with os.scandir(USERS_DIR) as accounts:
            roots.extend(
                os.path.join(entry.path, 'Applications')
                for entry in accounts
                if entry.is_dir(follow_symlinks=False)
            )
    except OSError as e:
        logger.debug(f"Could not list {USERS_DIR}: {e}")

    bundles = []
    budget = _INVENTORY_SCAN_LIMIT
    pending = [(root, 1) for root in roots]
    while pending and budget > 0:
        directory, depth = pending.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    budget -= 1
                    if budget <= 0:
                        logger.warning(
                            f"Application inventory stopped after "
                            f"{_INVENTORY_SCAN_LIMIT} entries"
                        )
                        break
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                    if entry.name.endswith('.app'):
                        bundles.append(entry.path)
                    elif depth < _APPLICATION_DEPTH:
                        pending.append((entry.path, depth + 1))
        except OSError as e:
            logger.debug(f"Could not list {directory}: {e}")
    return bundles


def _screen_recording_granted() -> bool | None:
    """What the desktop app last reported about its Screen Recording grant.

    None — no report — when there is no fresh one from the console user's own
    app: `ipc/` is writable by the whole group, so a report counts only in a
    regular file the console user owns, that nobody else can write, and that
    was written inside the freshness bound.
    """
    user = console_user()
    if user is None:
        return None
    try:
        uid = pwd.getpwnam(user).pw_uid
        fd = posix._open_entry(data_root(TCC_STATE_FILE), False)
    except KeyError:
        return None
    except FileNotFoundError:
        return None
    except OSError as e:
        logger.debug(f"Could not open {TCC_STATE_FILE}: {e}")
        return None
    try:
        with os.fdopen(fd, 'rb') as f:
            owner = os.fstat(f.fileno())
            if owner.st_uid != uid or owner.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
                logger.debug(f"Ignoring {TCC_STATE_FILE}: not the console user's own")
                return None
            raw = f.read(_TCC_STATE_LIMIT + 1)
        state = json.loads(raw) if len(raw) <= _TCC_STATE_LIMIT else None
    except (OSError, ValueError) as e:
        logger.debug(f"Could not read {TCC_STATE_FILE}: {e}")
        return None
    if not isinstance(state, dict):
        return None
    granted, checked_at = state.get('screen_recording'), state.get('checked_at')
    if not isinstance(granted, bool) or isinstance(checked_at, bool) \
            or not isinstance(checked_at, (int, float)):
        return None
    age = time.time() - checked_at
    if age > TCC_STATE_MAX_AGE_SECONDS or age < -_TCC_CLOCK_SKEW_SECONDS:
        return None
    return granted


def _issue_shutdown(flag: str, delay: int, message: str | None) -> None:
    """`shutdown -r|-h +N [message]`, raising when the OS refuses.

    The countdown is whole minutes and `+0` reboots in the foreground with
    nothing to abort, so a delay is rounded up and never rests below one: the
    dashboard reports a scheduled reboot as cancellable, and that has to be
    true.

    The scheduler shutdown forks keeps every descriptor it was handed until the
    machine goes down, so nothing here is a pipe — waiting for a pipe to close
    would wait for the reboot. Its refusal, which the parent prints before any
    fork, is read back out of an unlinked file instead.
    """
    command = [SHUTDOWN_COMMAND, flag, f'+{max(1, -(-int(delay) // 60))}']
    if message:
        command.append(message)
    with tempfile.TemporaryFile() as refusal:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=refusal,
            timeout=_SHUTDOWN_TIMEOUT_SECONDS,
        )
        if result.returncode != 0:
            refusal.seek(0)
            raise subprocess.CalledProcessError(
                result.returncode, command,
                stderr=refusal.read().decode(errors='replace').strip(),
            )


def _pending_shutdowns() -> list:
    """The shutdown schedulers counting down: the system's own binary, detached
    from whoever ran it and adopted by launchd."""
    pending = []
    for process in psutil.process_iter(['exe', 'ppid']):
        if process.info['exe'] == SHUTDOWN_COMMAND and process.info['ppid'] == _LAUNCHD_PID:
            pending.append(process)
    return pending


def _run(command, timeout_seconds):
    """A command's result, or None when it could not be run at all.

    The difference matters: a control that never reached the OS is a failure
    whatever state the caller was asking for.
    """
    try:
        return subprocess.run(
            command, capture_output=True, text=True, timeout=timeout_seconds
        )
    except (OSError, subprocess.SubprocessError) as e:
        logger.warning(f"{' '.join(command)} failed: {e}")
        return None
