"""The Linux arm of the osadapter surface.

What macOS and Linux answer the same way is `posix`, imported here and
re-exported so the package has one module per platform to select; this file is
what Linux does differently — systemd for service control, /etc/machine-id for
identity, dpkg for the software inventory, `shutdown` for the reboot subsystem,
and a capture that refuses outright on anything but an X11 seat.
"""

from __future__ import annotations

import logging
import os
import subprocess
import uuid

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

# The unit the package installs, and what the agent's own service name — spelled
# for the Windows SCM wherever it is configured — resolves to here.
SERVICE_UNIT = 'owlette-agent.service'

# systemd writes the first at install; D-Bus's copy is what a system without it
# carries. Both are key material as well as an identifier, so neither is logged.
MACHINE_ID_FILES = ('/etc/machine-id', '/var/lib/dbus/machine-id')

# The only seat v1 can capture or stream: a Wayland compositor hands a grab
# from outside the session a black frame, and the portal that would answer
# properly needs a client inside it — the desktop app's own work, in wave 4.
CAPTURE_SESSION_TYPE = 'x11'
_WAYLAND_SESSION_TYPE = 'wayland'

# systemd's record of a shutdown it has scheduled: written when one is
# scheduled, removed when it fires or is cancelled.
SCHEDULED_SHUTDOWN_FILE = '/run/systemd/shutdown/scheduled'

# The waits owlette-host uses for the same controls on Windows
# (agent/host/src/registration.rs): a stop is generous because the agent
# flushes `online: false` inside that window.
_SERVICE_CONTROLS = {
    'start': (True, 60),
    'stop': (False, 45),
    'restart': (True, 60),
}
_STATE_TIMEOUT_SECONDS = 10
_SHUTDOWN_TIMEOUT_SECONDS = 15
_DPKG_TIMEOUT_SECONDS = 30

# Package, version and maintainer, with the status that says whether the
# package is installed or only leaves its configuration behind.
_DPKG_FORMAT = '${Package}\t${Version}\t${Maintainer}\t${db:Status-Status}\n'


def _session_type() -> str | None:
    """Which display server the console session runs; None when there is no seat.

    What logind reports, which is the only source that is right on both a GDM
    X11 and a GDM Wayland seat: `Display` is empty on each, and the process
    logind names as the session's leader is a root-owned PAM worker that
    declares nothing at all. A session logind does not type graphical is named
    by the desktop app running in it instead.
    """
    session = posix._graphical_session()
    return session.type if session is not None else _app_session_type()


def _app_session_type() -> str | None:
    """The display the resident desktop app holds, for a seat logind does not
    list as one: an X session started by `startx` from a tty auto-login is
    typed `tty`, and the app in it is the process a capture goes through
    anyway. Wayland first — an XWayland client carries both variables.
    """
    pid = posix._desktop_pid()
    if pid is None:
        return None
    environ = posix._process_environ(pid)
    if environ.get('WAYLAND_DISPLAY'):
        return _WAYLAND_SESSION_TYPE
    if environ.get('DISPLAY'):
        return CAPTURE_SESSION_TYPE
    return None


def capture_screen(monitor: int, *, executor, timeout_s: int) -> dict:
    """Grab `monitor` through the desktop app, on an X11 seat only.

    Refused in the shape a failed job comes back in, so the caller reports that
    this machine cannot capture rather than uploading a black frame as a
    screenshot of the kiosk.
    """
    seat = _session_type()
    if seat != CAPTURE_SESSION_TYPE:
        return {
            'error': 'unsupported_on_platform',
            'session_type': seat,
            'message': (
                f'screen capture needs an x11 session; this machine reports '
                f'{seat or "no graphical session"}'
            ),
        }
    return posix.capture_screen(monitor, executor=executor, timeout_s=timeout_s)


def stable_machine_id() -> str:
    """The machine id systemd writes at install — stable across reboots, renames
    and every reinstall but the operating system's own."""
    return _machine_id()


def key_material() -> bytes:
    """Machine-bound material for the token store's key derivation."""
    return _machine_id().encode()


def service_control(verb: str, name: str) -> bool:
    """start / stop / restart a unit; True once it reached the state.

    Both properties the callers rely on, the way the Windows arm has them:
    `systemctl` returns only when its job is done, so a stop answers once the
    unit is stopped, and a unit already in the requested state is a success —
    what the caller wants is the state, not the transition. A unit systemd
    does not know is not in any state, and refusing the control is the answer.
    """
    control = _SERVICE_CONTROLS.get(verb)
    if control is None:
        raise ValueError(f"unknown service verb '{verb}'")
    wants_active, wait_seconds = control
    unit = _unit(name)

    issued = _run(['systemctl', verb, unit], wait_seconds)
    if issued is None:
        return False
    if issued.returncode != 0:
        logger.warning(
            f"systemctl {verb} {unit} exited {issued.returncode}: "
            f"{issued.stderr.strip()}"
        )
        if _load_state(unit) == 'not-found':
            return False

    state = _run(['systemctl', 'is-active', unit], _STATE_TIMEOUT_SECONDS)
    if state is None:
        return False
    return (state.stdout.strip() == 'active') is wants_active


def pending_reboot() -> dict:
    """Whether a package upgrade is waiting on a reboot, and what asked for it."""
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

    `shutdown -c` exits 0 whether or not anything was scheduled, so what it
    exited with cannot be the answer on its own: a cancel that cancelled
    nothing is the failure the Windows arm's `shutdown /a` reports, and the
    dashboard clears its pending state off this.
    """
    scheduled = os.path.exists(SCHEDULED_SHUTDOWN_FILE)
    result = _run(['shutdown', '-c'], _SHUTDOWN_TIMEOUT_SECONDS)
    return scheduled and result is not None and result.returncode == 0


def installed_software() -> list[dict[str, str]]:
    """Installed packages: name, version, publisher, uninstall command.

    dpkg's own database rather than apt: it answers without a network round-trip
    and without taking the lock an upgrade may be holding. A package that has
    been removed but still has its configuration is not installed software.
    """
    result = _run(['dpkg-query', '-W', '-f', _DPKG_FORMAT], _DPKG_TIMEOUT_SECONDS)
    if result is None or result.returncode != 0:
        logger.warning(
            f"dpkg-query did not answer: "
            f"{(result.stderr.strip() if result else 'not available')[:200]}"
        )
        return []

    packages = []
    for line in result.stdout.splitlines():
        fields = line.split('\t')
        if len(fields) != 4 or fields[3] != 'installed':
            continue
        name, package_version, maintainer, _ = fields
        packages.append({
            'name': name,
            'version': package_version,
            'publisher': maintainer,
            'install_location': '',
            'uninstall_command': f'apt-get remove -y {name}',
            'installer_type': 'dpkg',
        })
    logger.info(f"Found {len(packages)} installed software packages")
    return packages


def streamer_capable() -> bool:
    """Whether this machine can drive a streaming session: an X11 seat, the same
    signal the capture gate reads."""
    return _session_type() == CAPTURE_SESSION_TYPE


def _machine_id() -> str:
    """The machine id, or the interface-derived uuid on a system with neither
    file — a container, where nothing else is stable either."""
    for path in MACHINE_ID_FILES:
        try:
            with open(path, 'r', encoding='utf-8') as f:
                machine_id = f.read().strip()
        except OSError as e:
            logger.debug(f"Could not read {path}: {e}")
            continue
        if machine_id:
            return machine_id
        logger.warning(f"{path} is empty")
    return str(uuid.getnode())


def _unit(name: str) -> str:
    """The unit a caller's service name means here.

    The agent's own service is spelled for the Windows SCM everywhere it is
    configured, and this is the one place that knows what it is called on Linux.
    """
    import shared_utils

    if name == shared_utils.SERVICE_NAME:
        return SERVICE_UNIT
    return name if '.' in name else f'{name}.service'


def _load_state(unit: str) -> str | None:
    """What systemd knows about the unit — `not-found` when it knows nothing.

    `is-active` reports a unit that was never installed exactly as it reports
    a stopped one, so a stop issued against a name nothing answers to would
    otherwise read as a success.
    """
    result = _run(
        ['systemctl', 'show', '-p', 'LoadState', '--value', unit],
        _STATE_TIMEOUT_SECONDS,
    )
    return result.stdout.strip() if result is not None else None


def _issue_shutdown(flag: str, delay: int, message: str | None) -> None:
    """`shutdown -r|-h +N [message]`, raising when the OS refuses.

    The countdown is whole minutes and `+0` fires immediately with nothing to
    abort, so a delay is rounded up and never rests below one: the dashboard
    reports a scheduled reboot as cancellable, and that has to be true.
    """
    command = ['shutdown', flag, f'+{max(1, -(-int(delay) // 60))}']
    if message:
        command.append(message)
    subprocess.run(command, check=True, timeout=_SHUTDOWN_TIMEOUT_SECONDS)


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
