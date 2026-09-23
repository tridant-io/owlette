"""swoop streamer spawn helper.

Launches ``{app}\\swoop\\owlette-swoop.exe run`` with the service's own SYSTEM
token retargeted to the active console session, over inherited anonymous pipes:
stdin carries the session bundle and then control lines, stdout carries
json-line events, stderr is redirected into ``logs/swoop``. The pipe contract is
``agent/swoop/PROTOCOL.md`` section 6.

Nothing here elevates. The service is already SYSTEM, so the token is duplicated
rather than requested -- there is no ``runas``, no ``ShellExecute`` and no path
that can raise a UAC prompt.

``owlette_service._launch_command_as_user`` cannot be reused: it passes
``bInheritHandles=0``, so the child would get no pipes.

Two gates run before every spawn, and both refuse rather than degrade:
the install directory must carry the ownership the installer laid down, and
``owlette-swoop.exe version`` must match this agent's version. Neither gate
repairs anything.
"""

import json
import logging
import os
import subprocess

import shared_utils

logger = logging.getLogger(__name__)

# streamer exit codes -- PROTOCOL.md section 6. the agent only interprets them.
EXIT_OK = 0
EXIT_BUNDLE_INVALID = 10
EXIT_VERSION_MISMATCH = 11
EXIT_NO_CAPTURE_SOURCE = 12
EXIT_NO_ENCODER = 13
EXIT_SIGNALING_UNREACHABLE = 14
EXIT_INTERNAL = 20

EXIT_REASONS = {
    EXIT_OK: 'normal',
    EXIT_BUNDLE_INVALID: 'bundle_invalid',
    EXIT_VERSION_MISMATCH: 'version_mismatch',
    EXIT_NO_CAPTURE_SOURCE: 'no_capture_source',
    EXIT_NO_ENCODER: 'no_encoder',
    EXIT_SIGNALING_UNREACHABLE: 'signaling_unreachable',
    EXIT_INTERNAL: 'internal_error',
}

# refusal reasons, logged and reported; never raw win32 text.
REFUSAL_NOT_INSTALLED = 'not_installed'
REFUSAL_INSTALL_UNVERIFIED = 'install_unverified'
REFUSAL_VERSION_MISMATCH = 'version_mismatch'
REFUSAL_NO_CONSOLE_SESSION = 'no_console_session'
REFUSAL_BUNDLE_UNAVAILABLE = 'bundle_unavailable'
REFUSAL_SPAWN_FAILED = 'spawn_failed'

# the streamer's own stderr sink. the streamer rotates logs/swoop itself;
# cleanup_old_logs() is non-recursive and must stay that way.
STDERR_FILENAME = 'owlette-swoop.err.log'

VERSION_PROBE_TIMEOUT_S = 15
BUNDLE_TIMEOUT_S = 10
HOST_EVENTS_TIMEOUT_S = 10

# the three ACEs the installer applies to {app}\swoop, as (mask, sid string).
# SIDs, never account names: LookupAccountName fails on a non-English Windows.
_SID_SYSTEM = 'S-1-5-18'
_SID_ADMINISTRATORS = 'S-1-5-32-544'
_SID_USERS = 'S-1-5-32-545'
_FILE_ALL_ACCESS = 0x1F01FF
_FILE_GENERIC_READ = 0x120089
_FILE_GENERIC_EXECUTE = 0x1200A0
_INHERIT_FLAGS = 0x03  # OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE


class SwoopSpawnError(Exception):
    """A spawn was refused or failed. ``reason`` is one of the REFUSAL_* codes."""

    def __init__(self, reason, message):
        super().__init__(message)
        self.reason = reason


def _expected_aces():
    """The (flags, mask, sid-string) triples the install directory must carry."""
    return {
        (_INHERIT_FLAGS, _FILE_ALL_ACCESS, _SID_SYSTEM),
        (_INHERIT_FLAGS, _FILE_ALL_ACCESS, _SID_ADMINISTRATORS),
        (_INHERIT_FLAGS, _FILE_GENERIC_READ | _FILE_GENERIC_EXECUTE, _SID_USERS),
    }


def install_dir_is_protected(swoop_dir):
    """True when ``swoop_dir`` still carries the installer's ownership.

    Compared as an unordered set of triples against :func:`_expected_aces`, with
    inheritance required to be disabled. Read-only: this never writes an ACL and
    never creates the directory. Anything unexpected -- including an unreadable
    descriptor -- is a False, because the spawn path is a gate, not a repair.
    """
    if os.name != 'nt':
        return False
    try:
        import win32security as ws
    except ImportError as e:
        logger.warning('swoop: pywin32 unavailable for the install check: %s', e)
        return False

    try:
        sd = ws.GetNamedSecurityInfo(
            swoop_dir, ws.SE_FILE_OBJECT, ws.DACL_SECURITY_INFORMATION,
        )
        control, _revision = sd.GetSecurityDescriptorControl()
        se_dacl_protected = getattr(ws, 'SE_DACL_PROTECTED', 0x1000)
        if not (control & se_dacl_protected):
            logger.warning('swoop: %s does not match the installed layout', swoop_dir)
            return False

        dacl = sd.GetSecurityDescriptorDacl()
        expected = _expected_aces()
        if dacl is None or dacl.GetAceCount() != len(expected):
            logger.warning('swoop: %s does not match the installed layout', swoop_dir)
            return False

        access_allowed = getattr(ws, 'ACCESS_ALLOWED_ACE_TYPE', 0)
        actual = set()
        for index in range(dacl.GetAceCount()):
            ace = dacl.GetAce(index)
            (ace_type, ace_flags) = ace[0][0], ace[0][1]
            if ace_type != access_allowed:
                logger.warning('swoop: %s does not match the installed layout', swoop_dir)
                return False
            actual.add((int(ace_flags), int(ace[1]), ws.ConvertSidToStringSid(ace[-1])))

        if actual != expected:
            # the sets go to debug only; the refusal itself is the operator signal.
            logger.warning('swoop: %s does not match the installed layout', swoop_dir)
            logger.debug('swoop: expected %s, found %s', sorted(expected), sorted(actual))
            return False
        return True
    except Exception as e:
        logger.warning('swoop: could not read the install directory state: %s', e)
        return False


def read_streamer_version(exe_path, timeout=VERSION_PROBE_TIMEOUT_S):
    """Run ``owlette-swoop.exe version`` and return the trimmed stdout, or None.

    Runs off the 5-second loop (the manager's worker thread), never on it.
    """
    creationflags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    try:
        result = subprocess.run(
            [exe_path, 'version'],
            capture_output=True, text=True, timeout=timeout,
            creationflags=creationflags,
        )
    except Exception as e:
        logger.warning('swoop: version probe failed: %s', e)
        return None
    if result.returncode != 0:
        logger.warning('swoop: version probe exited %s', result.returncode)
        return None
    return (result.stdout or '').strip()


def verify_install(exe_path=None):
    """Run both pre-spawn gates and return the verified exe path.

    Raises :class:`SwoopSpawnError` with a REFUSAL_* reason. A stale binary left
    by a delayed-until-reboot upgrade is caught here rather than by the
    streamer's own exit code 11.
    """
    exe_path = exe_path or shared_utils.get_swoop_exe_path()
    if not exe_path:
        raise SwoopSpawnError(REFUSAL_NOT_INSTALLED, 'swoop is not installed')

    swoop_dir = shared_utils.get_swoop_dir()
    if not install_dir_is_protected(swoop_dir):
        raise SwoopSpawnError(
            REFUSAL_INSTALL_UNVERIFIED,
            'swoop install directory does not match the installed layout',
        )

    version = read_streamer_version(exe_path)
    if version != shared_utils.APP_VERSION:
        raise SwoopSpawnError(
            REFUSAL_VERSION_MISMATCH,
            f'streamer version {version!r} != agent {shared_utils.APP_VERSION!r}',
        )
    return exe_path


def fetch_bundle(sid, site_id, machine_id, auth_manager, timeout=BUNDLE_TIMEOUT_S):
    """Fetch the session bundle and return it as a mutable single-line buffer.

    A bytearray so the caller can wipe it after the write. The bundle, the token
    that fetched it and every key inside it are never logged -- not at debug, not
    partially -- so no response body or header ever reaches a log record.
    """
    import requests

    token = auth_manager.get_valid_token()
    if not token:
        raise SwoopSpawnError(REFUSAL_BUNDLE_UNAVAILABLE, 'no valid agent token')

    api_base = shared_utils.get_api_base_url()
    try:
        response = requests.post(
            f'{api_base}/agent/swoop/bundle',
            json={
                'siteId': site_id,
                'machineId': machine_id,
                'sid': sid,
                'agentVersion': shared_utils.APP_VERSION,
            },
            headers={'Authorization': f'Bearer {token}'},
            timeout=timeout,
        )
        response.raise_for_status()
    except Exception as e:
        # requests' message carries the status and url, never the body.
        raise SwoopSpawnError(
            REFUSAL_BUNDLE_UNAVAILABLE, f'bundle fetch failed: {e}',
        ) from None

    buf = bytearray(response.content.strip())
    if not buf.startswith(b'{') or b'\n' in buf:
        raise SwoopSpawnError(
            REFUSAL_BUNDLE_UNAVAILABLE, 'bundle response was not one json line',
        )
    return buf


def post_host_events(events, site_id, machine_id, auth_manager, timeout=HOST_EVENTS_TIMEOUT_S):
    """POST a batch of streamer host events to the audit route.

    The streamer holds no long-lived credential (PROTOCOL.md section 5), so the
    service posts on its behalf with the machine token. An event carries a type,
    a reason code and ids -- never a token, a key, a fingerprint or clipboard
    content -- so nothing here needs redacting, and nothing here is logged.

    Returns True when the batch was accepted. Raises on a transport or status
    failure; the caller decides what a lost audit row is worth.
    """
    import requests

    if not events:
        return True
    token = auth_manager.get_valid_token() if auth_manager is not None else None
    if not token:
        return False

    api_base = shared_utils.get_api_base_url()
    response = requests.post(
        f'{api_base}/agent/swoop/events',
        json={
            'siteId': site_id,
            'machineId': machine_id,
            'events': list(events),
        },
        headers={'Authorization': f'Bearer {token}'},
        timeout=timeout,
    )
    response.raise_for_status()
    return True


class SwoopProcess:
    """A running streamer: its pipes, its job object and its exit code.

    The job object carries ``JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE``, so closing it
    is what guarantees no streamer outlives the service.
    """

    def __init__(self, pid, process_handle, job_handle, stdin_handle, stdout_handle):
        self.pid = pid
        self.exit_code = None
        self._process = process_handle
        self._job = job_handle
        self._stdin = stdin_handle
        self._stdout = stdout_handle
        self._closed = False

    def write_bundle(self, buf):
        """Write the bundle as stdin line 1, then wipe the caller's buffer."""
        import win32file
        buf.extend(b'\n')
        try:
            win32file.WriteFile(self._stdin, bytes(buf))
        finally:
            # best effort: python may have copied it, but the long-lived buffer goes.
            buf[:] = b'\x00' * len(buf)

    def write_line(self, obj):
        """Write one control line (``kill``, ``sas_result``) to stdin."""
        import win32file
        win32file.WriteFile(self._stdin, (json.dumps(obj) + '\n').encode('utf-8'))

    def iter_lines(self):
        """Yield decoded stdout lines until the streamer closes the pipe."""
        import win32file
        buf = b''
        while True:
            try:
                _hr, data = win32file.ReadFile(self._stdout, 65536)
            except Exception:
                break  # a broken pipe is how a dead streamer reaches us
            if not data:
                break
            buf += data
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                line = line.strip()
                if line:
                    yield line.decode('utf-8', 'replace')

    def wait(self, timeout):
        """Wait up to ``timeout`` seconds; return the exit code or None."""
        import win32event
        import win32process
        rc = win32event.WaitForSingleObject(self._process, int(timeout * 1000))
        if rc != win32event.WAIT_OBJECT_0:
            return None
        self.exit_code = win32process.GetExitCodeProcess(self._process)
        return self.exit_code

    def close(self):
        """Close the job -- which terminates the streamer -- and every handle."""
        if self._closed:
            return
        self._closed = True
        for handle in (self._stdin, self._stdout, self._job, self._process):
            try:
                handle.Close()
            except Exception:
                pass


def _console_session_token():
    """Duplicate the service's SYSTEM token onto the active console session.

    Same primitive as ``owlette_service._get_elevated_install_token``: no
    elevation is requested, the token is the one this process already holds.
    """
    import ctypes
    import win32api
    import win32profile
    import win32security
    import win32ts

    session_id = win32ts.WTSGetActiveConsoleSessionId()
    if session_id == 0xFFFFFFFF:
        raise SwoopSpawnError(REFUSAL_NO_CONSOLE_SESSION, 'no active console session')

    service_token = win32security.OpenProcessToken(
        win32api.GetCurrentProcess(),
        win32security.TOKEN_DUPLICATE | win32security.TOKEN_QUERY,
    )
    try:
        token = win32security.DuplicateTokenEx(
            ExistingToken=service_token,
            DesiredAccess=win32security.TOKEN_ALL_ACCESS,
            ImpersonationLevel=win32security.SecurityImpersonation,
            TokenType=win32security.TokenPrimary,
            TokenAttributes=None,
        )
    finally:
        service_token.Close()

    ctypes.windll.advapi32.SetTokenInformation(
        int(token),
        12,  # TokenSessionId
        ctypes.byref(ctypes.c_ulong(session_id)),
        ctypes.sizeof(ctypes.c_ulong),
    )
    environment = win32profile.CreateEnvironmentBlock(token, False)
    level = _configured_log_level()
    if level:
        environment['OWLETTE_SWOOP_LOG'] = level
    return token, environment


def _configured_log_level():
    """``swoop.logLevel`` from config.json, for a diagnosis. Only the two
    levels the streamer knows; anything else leaves it at info."""
    try:
        level = (shared_utils.load_config() or {}).get('swoop', {}).get('logLevel')
    except Exception:
        return None
    return level if level in ('debug', 'trace') else None


def _open_stderr_handle(log_dir, sa):
    """Inheritable append handle on the streamer's stderr file."""
    import win32file
    os.makedirs(log_dir, exist_ok=True)
    path = os.path.join(log_dir, STDERR_FILENAME)
    handle = win32file.CreateFile(
        path,
        win32file.GENERIC_WRITE,
        win32file.FILE_SHARE_READ | win32file.FILE_SHARE_WRITE,
        sa,
        win32file.OPEN_ALWAYS,
        win32file.FILE_ATTRIBUTE_NORMAL,
        None,
    )
    win32file.SetFilePointer(handle, 0, win32file.FILE_END)
    return handle


def spawn(exe_path, log_dir=None):
    """Start the streamer suspended, box it in a job object, resume it.

    The caller writes the bundle as the first stdin line. Returns a
    :class:`SwoopProcess`; raises :class:`SwoopSpawnError` on any failure.
    """
    import win32con
    import win32api
    import win32job
    import win32pipe
    import win32process
    import win32security

    log_dir = log_dir or shared_utils.SWOOP_LOG_DIR
    token = None
    child_handles = []
    parent_handles = []
    process_handle = thread_handle = job = None

    try:
        token, environment = _console_session_token()

        sa = win32security.SECURITY_ATTRIBUTES()
        sa.bInheritHandle = 1
        stdin_r, stdin_w = win32pipe.CreatePipe(sa, 0)
        stdout_r, stdout_w = win32pipe.CreatePipe(sa, 0)
        stderr_h = _open_stderr_handle(log_dir, sa)
        child_handles = [stdin_r, stdout_w, stderr_h]
        parent_handles = [stdin_w, stdout_r]
        # our ends must not cross into the child, or stdout never reaches eof.
        for handle in parent_handles:
            win32api.SetHandleInformation(handle, win32con.HANDLE_FLAG_INHERIT, 0)

        si = win32process.STARTUPINFO()
        si.dwFlags = win32process.STARTF_USESTDHANDLES | win32process.STARTF_USESHOWWINDOW
        si.wShowWindow = win32con.SW_HIDE
        si.lpDesktop = 'WinSta0\\Default'
        si.hStdInput = stdin_r
        si.hStdOutput = stdout_w
        si.hStdError = stderr_h
        try:
            si.lpAttributeList = {'handle_list': list(child_handles)}
        except Exception as e:
            # older pywin32 has no PROC_THREAD_ATTRIBUTE_HANDLE_LIST; the three
            # handles above are already the only inheritable ones we hold.
            logger.warning('swoop: handle list unavailable, relying on flags: %s', e)

        flags = (
            win32con.CREATE_SUSPENDED
            | win32con.CREATE_NO_WINDOW
            | win32con.NORMAL_PRIORITY_CLASS
        )
        process_handle, thread_handle, pid, _tid = win32process.CreateProcessAsUser(
            token,
            None,
            f'"{exe_path}" run',
            None,
            None,
            1,  # bInheritHandles: the whole reason this helper exists
            flags,
            environment,
            None,
            si,
        )

        job = win32job.CreateJobObject(None, '')
        limits = win32job.QueryInformationJobObject(
            job, win32job.JobObjectExtendedLimitInformation,
        )
        limits['BasicLimitInformation']['LimitFlags'] |= (
            win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
        win32job.SetInformationJobObject(
            job, win32job.JobObjectExtendedLimitInformation, limits,
        )
        win32job.AssignProcessToJobObject(job, process_handle)
        win32process.ResumeThread(thread_handle)
        thread_handle.Close()
        thread_handle = None

        # the child owns these now; holding them would keep the pipes open.
        for handle in child_handles:
            handle.Close()
        child_handles = []

        logger.info('swoop: streamer started, pid %s', pid)
        return SwoopProcess(pid, process_handle, job, stdin_w, stdout_r)
    except SwoopSpawnError:
        _close_all(child_handles + parent_handles + [thread_handle, process_handle, job])
        raise
    except Exception as e:
        _close_all(child_handles + parent_handles + [thread_handle, process_handle, job])
        raise SwoopSpawnError(REFUSAL_SPAWN_FAILED, f'spawn failed: {e}') from None
    finally:
        if token is not None:
            try:
                token.Close()
            except Exception:
                pass


def _close_all(handles):
    for handle in handles:
        if handle is None:
            continue
        try:
            handle.Close()
        except Exception:
            pass
