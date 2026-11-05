"""swoop streamer spawn helper, macOS and Linux.

The daemon runs as root with no display of its own, so it does not start the
streamer itself: it asks the resident desktop app to, with a ``launch`` job
through the job seam (``osadapter.run_job``). The app starts its own sidecar as
its own child -- on macOS that is what credits the app's Screen Recording grant
to the streamer -- with stdin and stdout both on one unix socket the daemon
bound under ``ipc/swoop``. Line 1 on that socket is the bundle, so the bundle
never touches disk, and the daemon's end closing is the streamer's EOF
(PROTOCOL.md section 6). The runner's half is
``desktop/src-tauri/src/jobrunner.rs``.

Nothing here elevates and nothing here raises a prompt: the app launches only
its own sidecar, only for a request root wrote, and resolves the program itself.

The gates match the Windows arm's: the install must be root's alone and the
streamer's version this agent's, and neither gate repairs anything. The bundle
and everything read from the socket are never logged.
"""

import json
import logging
import os
import re
import socket
import stat
import struct
import sys
import time
import uuid

import psutil

import osadapter
import shared_utils
import swoop_spawn
from swoop_spawn import (
    EXIT_INTERNAL,
    REFUSAL_DESKTOP_NOT_RUNNING,
    REFUSAL_INSTALL_UNVERIFIED,
    REFUSAL_NOT_INSTALLED,
    REFUSAL_SPAWN_FAILED,
    REFUSAL_VERSION_MISMATCH,
    STDERR_FILENAME,
    SwoopSpawnError,
)

logger = logging.getLogger(__name__)

IPC_SUBDIR = 'ipc/swoop'
LOG_SUBDIR = 'logs/swoop'
SOCKET_SUFFIX = '.sock'
EXIT_FILE_SUFFIX = '.exit.json'
# the socket's mode: root owns it and the ipc group -- the app's user -- may
# connect. nobody else may, and the runner refuses one that is world-writable.
SOCKET_MODE = 0o660

JOB_TYPE = 'launch'
PROGRAM = 'owlette-swoop'
# the runner's budget to connect and spawn, and the daemon's to see the
# connection once the job has answered.
LAUNCH_TIMEOUT_S = 10
ACCEPT_TIMEOUT_S = 10
# the app writes the exit file from a thread that waits on the child, so it can
# land a moment after the process is gone.
EXIT_FILE_WAIT_S = 2
_POLL_S = 0.05
_EXIT_FILE_LIMIT = 4096
# what a runner error may look like in our log; anything else is 'unknown'.
_RUNNER_CODE = re.compile(r'[a-z_]{1,64}')

# the install is root's alone: the file and the three directories above it,
# which on macOS are Contents/MacOS, Contents and the app bundle.
_INSTALL_OWNER_UID = 0
_INSTALL_DEPTH = 3

# the peer's credentials: linux's struct ucred (pid, uid, gid), macOS's struct
# xucred (cr_version, cr_uid, cr_ngroups, cr_groups[16]) at level SOL_LOCAL.
_UCRED = struct.Struct('=iII')
_SOL_LOCAL = 0
_XUCRED_SIZE = 76
_XUCRED_HEAD = struct.Struct('=II')
_XUCRED_VERSION = 0


def install_is_protected(exe_path):
    """True when the streamer and the three directories above it are root's alone.

    A path anyone but root can write is a binary anyone but root can replace,
    and the daemon runs its ``version`` as root. Each entry is read with lstat,
    so a link is refused rather than followed. Read-only, like the Windows check.
    """
    path = os.path.abspath(exe_path)
    for _ in range(_INSTALL_DEPTH + 1):
        try:
            st = os.lstat(path)
        except OSError as e:
            logger.warning('swoop: could not read the install state: %s', e)
            return False
        if (stat.S_ISLNK(st.st_mode) or st.st_uid != _INSTALL_OWNER_UID
                or st.st_mode & (stat.S_IWGRP | stat.S_IWOTH)):
            logger.warning('swoop: %s does not match the installed layout', path)
            return False
        path = os.path.dirname(path)
    return True


def verify_install(exe_path=None):
    """Run the pre-spawn gates and return the verified exe path.

    Raises :class:`SwoopSpawnError` with a REFUSAL_* reason, as the Windows arm
    does: absent, not root's alone, or a version that is not this agent's.
    """
    exe_path = exe_path or shared_utils.get_swoop_exe_path()
    if not exe_path or not os.path.exists(exe_path):
        raise SwoopSpawnError(REFUSAL_NOT_INSTALLED, 'swoop is not installed')

    if not install_is_protected(exe_path):
        raise SwoopSpawnError(
            REFUSAL_INSTALL_UNVERIFIED,
            'swoop install does not match the installed layout',
        )

    version = swoop_spawn.read_streamer_version(exe_path)
    if version != shared_utils.APP_VERSION:
        raise SwoopSpawnError(
            REFUSAL_VERSION_MISMATCH,
            f'streamer version {version!r} != agent {shared_utils.APP_VERSION!r}',
        )
    return exe_path


class PosixSwoopProcess:
    """A running streamer: its socket, its pinned process and its exit code.

    The process is held by pid and create time, so nothing here ever signals a
    pid the system has since handed to another process.
    """

    def __init__(self, pid, process, conn, socket_path, exit_path):
        self.pid = pid
        self.exit_code = None
        self._process = process
        self._conn = conn
        self._socket_path = socket_path
        self._exit_path = exit_path
        self._said_code = None
        self._closed = False

    def write_bundle(self, buf):
        """Write the bundle as line 1, then wipe the caller's buffer."""
        buf.extend(b'\n')
        try:
            self._conn.sendall(buf)
        finally:
            # best effort: python may have copied it, but the long-lived buffer goes.
            buf[:] = b'\x00' * len(buf)

    def write_line(self, obj):
        """Write one control line (``kill``, ``token``)."""
        self._conn.sendall((json.dumps(obj) + '\n').encode('utf-8'))

    def iter_lines(self):
        """Yield decoded lines until the streamer closes its end.

        The code an ``exiting`` line carries is kept: it is the streamer's own
        word on how it ended, and it outranks the exit file.
        """
        buf = b''
        while True:
            try:
                data = self._conn.recv(65536)
            except OSError:
                break  # a socket closed under us is how a dead streamer reaches us
            if not data:
                break
            buf += data
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                line = line.strip()
                if line:
                    text = line.decode('utf-8', 'replace')
                    self._remember_exit(text)
                    yield text

    def _remember_exit(self, text):
        try:
            event = json.loads(text)
        except ValueError:
            return
        if isinstance(event, dict) and event.get('type') == 'exiting':
            code = event.get('code')
            if isinstance(code, int) and not isinstance(code, bool):
                self._said_code = code

    def wait(self, timeout):
        """Wait up to ``timeout`` seconds; return the exit code or None.

        None while the pinned process runs. Once it is gone or a zombie: the
        ``exiting`` line's code, else the app's exit file, else internal_error.
        """
        deadline = time.monotonic() + timeout
        while self._running():
            if time.monotonic() >= deadline:
                return None
            time.sleep(_POLL_S)
        if self.exit_code is None:
            self.exit_code = self._final_code()
        return self.exit_code

    def close(self):
        """Kill the streamer if it is still the process we launched, close the
        socket, and remove the two files the spawn named."""
        if self._closed:
            return
        self._closed = True
        if self._running():
            try:
                self._process.kill()
            except psutil.Error:
                pass
        try:
            # wakes a reader blocked on the socket, which a bare close does not.
            self._conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self._conn.close()
        _unlink(self._socket_path)
        _unlink(self._exit_path)

    def _running(self):
        try:
            return (self._process.is_running()
                    and self._process.status() != psutil.STATUS_ZOMBIE)
        except psutil.Error:
            return False

    def _final_code(self):
        # the reader may still be relaying the exiting line, so it is asked
        # again on every pass rather than once before the file.
        deadline = time.monotonic() + EXIT_FILE_WAIT_S
        while True:
            if self._said_code is not None:
                return self._said_code
            code = self._exit_file_code()
            if code is not None:
                return code
            if time.monotonic() >= deadline:
                return EXIT_INTERNAL
            time.sleep(_POLL_S)

    def _exit_file_code(self):
        """The code the app recorded for this pid, or None.

        ``ipc/swoop`` is the group's to write, so the file is opened without
        following a link and read only when it is a regular file.
        """
        try:
            fd = os.open(self._exit_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            return None
        try:
            with os.fdopen(fd, 'rb') as f:
                if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                    return None
                raw = f.read(_EXIT_FILE_LIMIT + 1)
            record = json.loads(raw) if len(raw) <= _EXIT_FILE_LIMIT else None
        except (OSError, ValueError):
            return None
        if not isinstance(record, dict) or record.get('pid') != self.pid:
            return None
        code = record.get('code')
        return code if isinstance(code, int) and not isinstance(code, bool) else None


def spawn(exe_path, log_dir=None, *, sid=None):
    """Have the desktop app launch the streamer on a fresh socket.

    The caller writes the bundle as line 1. Returns a :class:`PosixSwoopProcess`;
    raises :class:`SwoopSpawnError` on any failure. Runs on the manager's worker
    thread, never the service loop: the job round trip and the accept both wait.
    """
    # the app resolves its own sidecar: a path in a job is a refusal.
    del exe_path
    ipc_dir = shared_utils.get_data_path(IPC_SUBDIR)
    log_dir = log_dir or shared_utils.get_data_path(LOG_SUBDIR)
    # one id per spawn names the socket and the exit file; never the sid.
    spawn_id = uuid.uuid4().hex
    socket_path = os.path.join(ipc_dir, spawn_id + SOCKET_SUFFIX)
    exit_path = os.path.join(ipc_dir, spawn_id + EXIT_FILE_SUFFIX)
    listener = conn = None

    try:
        listener = _listen(ipc_dir, socket_path)
        result = osadapter.run_job(_launch_job(socket_path, exit_path, log_dir))
        _discard_result(result)
        pid = _launched_pid(result)

        listener.settimeout(ACCEPT_TIMEOUT_S)
        try:
            conn, _addr = listener.accept()
        except TimeoutError:
            raise SwoopSpawnError(
                REFUSAL_SPAWN_FAILED,
                f'the streamer did not connect within {ACCEPT_TIMEOUT_S}s',
            ) from None

        console_uid = _console_uid()
        if console_uid is None or _peer_uid(conn) != console_uid:
            raise SwoopSpawnError(
                REFUSAL_SPAWN_FAILED, 'the streamer socket was reached by another user',
            )
        # connected: nothing else may reach the streamer through that path.
        _unlink(socket_path)
        process = _pin(pid, console_uid)

        logger.info('swoop: streamer started for %s, pid %s', sid, pid)
        return PosixSwoopProcess(pid, process, conn, socket_path, exit_path)
    except Exception as e:
        if conn is not None:
            conn.close()
        _unlink(socket_path)
        if isinstance(e, SwoopSpawnError):
            raise
        raise SwoopSpawnError(REFUSAL_SPAWN_FAILED, f'spawn failed: {e}') from None
    finally:
        if listener is not None:
            listener.close()


def sweep_stale():
    """Remove the sockets and exit files an earlier run left in ``ipc/swoop``.

    One entry at a time, by name, inside the directory itself: the directory is
    opened without following a link, and an unlink never follows one either.
    Never raises.
    """
    ipc_dir = shared_utils.get_data_path(IPC_SUBDIR)
    try:
        fd = os.open(ipc_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return
    except OSError as e:
        logger.warning('swoop: could not open %s to clear it: %s', ipc_dir, e)
        return
    removed = 0
    try:
        for name in os.listdir(fd):
            if not name.endswith((SOCKET_SUFFIX, EXIT_FILE_SUFFIX)):
                continue
            try:
                os.unlink(name, dir_fd=fd)
                removed += 1
            except FileNotFoundError:
                pass
            except OSError as e:
                logger.debug('swoop: could not remove %s: %s', name, e)
    except OSError as e:
        logger.warning('swoop: could not list %s: %s', ipc_dir, e)
    finally:
        os.close(fd)
    if removed:
        logger.info('swoop: cleared %d stale entries from %s', removed, ipc_dir)


def _listen(ipc_dir, socket_path):
    """Bind the streamer's socket, open it to the ipc group alone, and listen.

    The group is the one ``ipc/swoop`` itself carries, read without following a
    link: that directory's group is how the app's user reaches the seam.
    """
    st = os.lstat(ipc_dir)
    if not stat.S_ISDIR(st.st_mode):
        raise SwoopSpawnError(REFUSAL_SPAWN_FAILED, f'{ipc_dir} is not a directory')
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(socket_path)
        os.chmod(socket_path, SOCKET_MODE)
        os.chown(socket_path, -1, st.st_gid)
        listener.listen(1)
    except BaseException:
        listener.close()
        raise
    return listener


def _launch_job(socket_path, exit_path, log_dir):
    """The ``launch`` request. It names paths and a program, never a secret."""
    env = {}
    level = swoop_spawn._configured_log_level()
    if level:
        env['OWLETTE_SWOOP_LOG'] = level
    return {
        'type': JOB_TYPE,
        'trusted': True,
        'program': PROGRAM,
        'args': ['run'],
        'socket': socket_path,
        'stderr': os.path.join(log_dir, STDERR_FILENAME),
        'exit_file': exit_path,
        'env': env,
        'timeout_s': LAUNCH_TIMEOUT_S,
    }


def _launched_pid(result):
    """The pid the runner reported, or the refusal its result names."""
    error = result.get('error')
    if error == REFUSAL_DESKTOP_NOT_RUNNING:
        raise SwoopSpawnError(REFUSAL_DESKTOP_NOT_RUNNING, 'the desktop app is not running')
    if error:
        code = error if isinstance(error, str) and _RUNNER_CODE.fullmatch(error) else 'unknown'
        raise SwoopSpawnError(REFUSAL_SPAWN_FAILED, f'launch job failed: {code}')
    pid = result.get('pid')
    if type(pid) is not int or pid <= 0:
        raise SwoopSpawnError(REFUSAL_SPAWN_FAILED, 'launch job answered without a pid')
    return pid


def _discard_result(result):
    """Remove the job's result directory, which ``run_job`` leaves to its
    caller: a launch writes nothing there but ``result.json``."""
    output_dir = result.get('outputDir')
    if not output_dir:
        return
    _unlink(os.path.join(output_dir, 'result.json'))
    try:
        os.rmdir(output_dir)
    except FileNotFoundError:
        pass
    except OSError as e:
        logger.debug('swoop: could not remove %s: %s', output_dir, e)


def _console_uid():
    """The uid of the user at the console, or None when nobody is there."""
    import pwd

    user = osadapter.console_user()
    if user is None:
        return None
    try:
        return pwd.getpwnam(user).pw_uid
    except KeyError:
        return None


def _peer_uid(conn):
    """The uid of the process that connected, as the kernel recorded it."""
    if sys.platform == 'darwin':
        raw = conn.getsockopt(_SOL_LOCAL, socket.LOCAL_PEERCRED, _XUCRED_SIZE)
        version, uid = _XUCRED_HEAD.unpack_from(raw)
        if version != _XUCRED_VERSION:
            raise OSError(f'unexpected xucred version {version}')
        return uid
    raw = conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, _UCRED.size)
    return _UCRED.unpack(raw)[1]


def _pin(pid, uid):
    """The launched process, held by pid and create time.

    Refused unless it runs as the console user: the pid comes from a result the
    app wrote, and ``close`` may signal it as root.
    """
    process = psutil.Process(pid)
    if process.uids().real != uid:
        raise SwoopSpawnError(REFUSAL_SPAWN_FAILED, f"pid {pid} is not the console user's")
    return process


def _unlink(path):
    """Remove one file by its exact path, whether or not it is still there."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError as e:
        logger.debug('swoop: could not remove %s: %s', path, e)
