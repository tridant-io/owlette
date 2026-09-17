"""The Windows arm of the osadapter surface.

Each operation routes to the implementation the agent already ships, with no
behaviour change; the data root is the exception — the %PROGRAMDATA% lookup
lives here, and shared_utils.get_data_path() reads it back through the
package. The five operations OwletteService owns on Windows — the
user-session and managed-process work, which runs off the live service object
and its token ladder — raise NotSupportedHere rather than duplicate it; no
Windows call site routes through them.
"""

from __future__ import annotations

import logging
import os
import subprocess
import uuid
import winreg

import win32service
import win32serviceutil
import win32ts
import winerror

from . import NotSupportedHere, resolve_data_root

logger = logging.getLogger(__name__)

# Agent modules are imported inside the operation that uses them so the
# adapter's import graph stays one-way: everything under agent/src can import
# osadapter, including the modules these operations delegate to.


def data_root(sub: str | None = None) -> str:
    """The data tree under %PROGRAMDATA%, or `sub` inside it."""
    return resolve_data_root(
        os.path.join(os.environ.get('PROGRAMDATA', 'C:\\ProgramData'), 'Owlette'),
        sub,
    )


def console_user() -> str | None:
    """The account signed in at the console; None when nobody is."""
    session_id = win32ts.WTSGetActiveConsoleSessionId()
    if session_id == 0xFFFFFFFF:
        return None
    try:
        username = win32ts.WTSQuerySessionInformation(
            None, session_id, win32ts.WTSUserName
        )
    except Exception as e:
        logger.debug(f"Console user lookup failed for session {session_id}: {e}")
        return None
    return username or None


def session_env(uid) -> dict[str, str]:
    """Not routed here: CreateProcessAsUser carries the user's environment block."""
    raise NotSupportedHere(
        'session_env: OwletteService builds the environment block from the '
        'console user token'
    )


def spawn_as_user(argv, uid) -> int:
    """Not routed here: OwletteService.launch_python_script_as_user owns the token ladder."""
    raise NotSupportedHere(
        'spawn_as_user: OwletteService.launch_python_script_as_user owns the '
        'token ladder'
    )


def run_job(job: dict) -> dict:
    """Not routed here: session jobs run through OwletteService.execute_in_user_session."""
    raise NotSupportedHere(
        'run_job: OwletteService.execute_in_user_session runs session jobs on '
        'Windows'
    )


def capture_screen(monitor: int, *, executor, timeout_s: int) -> dict:
    """Grab `monitor` in the console session, through the service's executor.

    `executor` is OwletteService.execute_in_user_session: the service is
    LocalSystem in session 0, where a grab returns a blank LocalSystem display,
    so the code runs in the console user's session through CreateProcessAsUser.
    It is handed back untouched — the executor's result dict is the operation's.
    """
    return executor(
        'python',
        _build_capture_code(monitor),
        timeout=timeout_s,
        trusted=True,
    )


def launch_managed_process(spec: dict) -> int | None:
    """Not routed here: OwletteService.launch_process_as_user owns managed launches."""
    raise NotSupportedHere(
        'launch_managed_process: OwletteService.launch_process_as_user owns '
        'managed launches'
    )


def stable_machine_id() -> str:
    """The Windows MachineGuid — stable across reboots and user contexts."""
    return _machine_guid()


def key_material() -> bytes:
    """Machine-bound material for the token store's key derivation."""
    return _machine_guid().encode()


# The control to issue, the state it must reach, and how long to allow —
# the waits owlette-host uses (agent/host/src/registration.rs STOP_WAIT /
# START_WAIT); a stop is generous because the agent flushes `online: false`
# inside that window.
_SERVICE_CONTROLS = {
    'start': ('StartService', win32service.SERVICE_RUNNING, 60),
    'stop': ('StopService', win32service.SERVICE_STOPPED, 45),
}

_ALREADY_IN_STATE = (
    winerror.ERROR_SERVICE_ALREADY_RUNNING,
    winerror.ERROR_SERVICE_NOT_ACTIVE,
)


def service_control(verb: str, name: str) -> bool:
    """start / stop / restart a Windows service; True once it reached the state.

    Both properties owlette-host's callers rely on: the call is synchronous, so
    a stop returns only once the service is STOPPED, and a service already in
    the requested state is a success — what the caller wants is the state, not
    the transition.
    """
    if verb == 'restart':
        return service_control('stop', name) and service_control('start', name)
    control = _SERVICE_CONTROLS.get(verb)
    if control is None:
        raise ValueError(f"unknown service verb '{verb}'")
    control_name, wanted, wait_seconds = control
    try:
        getattr(win32serviceutil, control_name)(name)
    except Exception as e:
        if getattr(e, 'winerror', None) not in _ALREADY_IN_STATE:
            logger.warning(f"Service {verb} failed for {name}: {e}")
            return False
    try:
        win32serviceutil.WaitForServiceStatus(name, wanted, wait_seconds)
    except Exception as e:
        logger.warning(f"Service {verb} for {name} did not settle: {e}")
        return False
    return True


def pending_reboot() -> dict:
    """Whether Windows is waiting on a reboot, and what is asking for it."""
    import mcp_tools

    return mcp_tools.check_pending_reboot({}, None)


def reboot(delay: int, message: str | None = None) -> None:
    """Reboot in `delay` seconds; cancellable with cancel_reboot() until it fires."""
    _issue_shutdown('/r', delay, message)


def shutdown(delay: int, message: str | None = None) -> None:
    """Power off in `delay` seconds; cancellable with cancel_reboot() until it fires."""
    _issue_shutdown('/s', delay, message)


def cancel_reboot() -> bool:
    """Abort a pending reboot or shutdown; True when Windows accepted the abort.

    CREATE_NO_WINDOW for the reason `_issue_shutdown` carries it: this runs from
    the same CLI the desktop app spawns without a console of its own.
    """
    result = subprocess.run(['shutdown', '/a'], capture_output=True, timeout=15,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    return result.returncode == 0


def installed_software() -> list[dict[str, str]]:
    """Installed packages: name, version, publisher, uninstall command."""
    import registry_utils

    return registry_utils.get_installed_software()


def notify(title: str, body: str) -> dict:
    """Toast whoever is at the machine."""
    import mcp_tools

    return mcp_tools._show_notification({'title': title, 'message': body}, None)


def desktop_process_name() -> str:
    """The desktop app's image name, for the tray-liveness guard."""
    import shared_utils

    return shared_utils.DESKTOP_EXE_NAME


def json_lock():
    """The named mutex desktop/src-tauri/src/json_io.rs takes for the same writes."""
    import shared_utils

    return shared_utils._CrossProcessLock()


def streamer_capable() -> bool:
    """Every Windows machine can drive a streaming session."""
    return True


def _build_capture_code(monitor: int) -> str:
    """Source for the user-session interpreter: mss grab -> raw PNG at
    `<output_dir>/screenshot.png`, nothing else. No JPEG step here — that
    interpreter often can't import PIL.

    `output_dir` is injected into the namespace by session_exec.run_python.
    Callers must pass `trusted=True` so unrestricted imports (mss) work.
    """
    import screenshot_capture

    # Caller has already coerced `monitor` to an int, so this f-string can only
    # substitute a number.
    return f"""
import os
import mss
from mss.tools import to_png

with mss.mss() as sct:
    mon_idx = {monitor} if {monitor} > 0 and {monitor} < len(sct.monitors) else 0
    grabbed = sct.grab(sct.monitors[mon_idx])
    png_bytes = to_png(grabbed.rgb, grabbed.size)
    monitors_count = len(sct.monitors) - 1

out_path = os.path.join(output_dir, {screenshot_capture.SCREENSHOT_FILENAME_PNG!r})
with open(out_path, 'wb') as f:
    f.write(png_bytes)
print(f'monitors={{monitors_count}} size={{len(png_bytes)}}')
"""


def _machine_guid() -> str:
    """MachineGuid from the registry, falling back to uuid.getnode()."""
    try:
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Cryptography'
        ) as key:
            machine_guid = winreg.QueryValueEx(key, 'MachineGuid')[0]
        if machine_guid:
            return machine_guid
        logger.warning('MachineGuid is empty')
    except OSError as e:
        logger.warning(f"Failed to read MachineGuid from the registry: {e}")
    return str(uuid.getnode())


def _issue_shutdown(flag: str, delay: int, message: str | None) -> None:
    """`shutdown /r|/s /t <delay> [/c <message>]`, raising when the OS refuses.

    CREATE_NO_WINDOW because the desktop app spawns the CLI with no console of
    its own: a console child left to allocate one flashes a window across the
    kiosk display on the way out.
    """
    command = ['shutdown', flag, '/t', str(int(delay))]
    if message:
        command += ['/c', message]
    subprocess.run(command, check=True, timeout=15,
                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
