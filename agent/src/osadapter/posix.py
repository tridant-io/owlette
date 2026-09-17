"""The shared POSIX arm of the osadapter surface.

macOS and Linux keep the tree in different places and answer the per-OS
operations differently — those arms are their own modules — but the session
story is the same on both, and it is this one: the daemon runs as root with no
display of its own, the desktop app runs as the console user, and anything that
has to be seen goes either into that user's session or into the app's job seam.

The user-session operations OwletteService keeps to itself on Windows are
implemented here rather than refused — off Windows there is no token ladder to
duplicate, so spawning into the session and the GUI job round-trip are the
adapter's own work.
"""

from __future__ import annotations

import errno
import grp
import json
import logging
import os
import pwd
import shlex
import shutil
import stat
import subprocess
import sys
import threading
import time
import uuid
from collections import namedtuple

from . import resolve_data_root

logger = logging.getLogger(__name__)

# The two facts the POSIX arms differ on, resolved here so neither arm has to
# carry a copy: where the tree lives, and the dedicated group that owns it. The
# group is what lets the console user reach the seam — never `staff` or `wheel`,
# which are every logged-in user and root's own.
if sys.platform == 'darwin':
    DATA_ROOT = '/Library/Application Support/Owlette'
    GROUP = '_owlette'
    # How an account joins it, which is per-OS as well: macOS has no usermod.
    GROUP_ADD = f'dseditgroup -o edit -a USER -t user {GROUP}'
else:
    DATA_ROOT = '/var/lib/owlette'
    GROUP = 'owlette'
    GROUP_ADD = f'usermod -aG {GROUP} USER'

DESKTOP_PROCESS_NAME = 'owlette-desktop'

# A session is a seat only when it is active and of a graphical type: a tty or
# ssh login is listed exactly the same way and has no display to reach.
_GRAPHICAL_SESSION_TYPES = frozenset({'x11', 'wayland'})
_LOGINCTL_TIMEOUT_SECONDS = 5

# Lifted from the session leader rather than assembled from constants: GDM,
# LightDM and SDDM each put the X cookie somewhere different, and a DISPLAY
# without an XAUTHORITY leaves root with "cannot open display".
_SESSION_VARIABLES = frozenset({
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE',
    'HOME', 'USER', 'LOGNAME', 'PATH',
})
_DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin'

# The GUI job seam the resident desktop app serves
# (desktop/src-tauri/src/jobrunner.rs): the daemon drops a request in, the app
# writes the result back beside it.
JOBS_DIR = 'ipc/jobs'
RESULTS_DIR = 'ipc/results'
JOB_FILE_MODE = 0o640
JOB_TIMEOUT_SECONDS = 120
# What a job is allowed beyond the budget its caller named, for the runner
# to hand the result back once its own work is done.
_JOB_HANDOVER_SECONDS = 5
_JOB_POLL_SECONDS = 0.1

# decision 4's data-root mode table. The root is not group-writable, so
# `.tokens.enc` (0600 root) cannot be replaced by anything the app runs;
# everything the app writes into is, and every queue under `ipc/` is one of
# those — the cortex channel, the swoop bundles and the job seam alike.
_DIRECTORY_MODES = {
    '': 0o750,
    'config': 0o770,
    'tmp': 0o770,
    'ipc': 0o770,
    'logs': 0o750,
    'logs/swoop': 0o770,
    'cache': 0o750,
}
# The files in the tree the desktop app reads or writes as well, and whether
# this is where they are created. The lock (shared_utils.JSON_LOCK_FILE) is:
# whichever process takes it first would otherwise create it at its own umask,
# and a 0640 lock file is one the app cannot take at all.
_FILE_MODES = (
    ('config/config.json', 0o660, False),
    ('config/machine_id', 0o640, False),
    ('tmp/json.lock', 0o660, True),
)

# cortex_cli_fetch.CACHE_SUBDIR, spelled out rather than imported so applying
# the mode table cannot pull the CLI fetcher into the daemon's start-up path.
# The binary lands 0o750, so the group has to own the tree or the console
# user's hoot process cannot execute it.
CLI_CACHE_DIR = 'cache/claude-cli'

_Session = namedtuple('_Session', 'name leader type')

_children = {}
_children_lock = threading.Lock()

# Jobs whose caller gave up waiting, and how long a late runner is still watched
# for: the result directory belongs to the caller, and an abandoned one has none.
_abandoned = {}
_abandoned_lock = threading.Lock()

_missing_group_logged = False


def data_root(sub: str | None = None) -> str:
    """The agent's data tree, or `sub` inside it."""
    return resolve_data_root(DATA_ROOT, sub)


def console_user() -> str | None:
    """The user at the machine's graphical session; None when nobody is.

    None means there is no interactive session at all, and every caller treats
    it that way: a job that needs a display fails closed rather than falling
    back to the account the daemon happens to run as.
    """
    session = _graphical_session()
    return session.name if session is not None else None


def session_env(uid) -> dict[str, str]:
    """The environment a process needs to reach that user's display.

    The account's own variables always, the session leader's display variables
    when that user is at a seat. XAUTHORITY falls back to the home directory's
    cookie only when the leader carries none.
    """
    env = _account_env(uid)
    session = _graphical_session(uid)
    if session is not None:
        env.update({
            name: value
            for name, value in _process_environ(session.leader).items()
            if name in _SESSION_VARIABLES
        })
        env.setdefault('XAUTHORITY', os.path.join(env['HOME'], '.Xauthority'))
    return env


def spawn_as_user(argv, uid) -> int:
    """Run `argv` as `uid` in their session; returns the pid."""
    return _spawn(argv, uid, session_env(uid))


def run_job(job: dict) -> dict:
    """Run a GUI job in the desktop app's session and return its result.

    The daemon has no display on POSIX, so capture, notification and anything
    else that must happen where the user can see it is dropped into `ipc/jobs/`
    for the resident app to execute; it writes the result into
    `ipc/results/<id>/`, and that directory — named here rather than read back
    out of the result, which the app could otherwise point at a tree the caller
    then removes as root — is the caller's to remove once it has read whatever
    the job produced.

    An app that is not running, or does not answer within JOB_TIMEOUT_SECONDS,
    fails closed with a typed `desktop_not_running` result rather than leaving
    the caller hanging — the request is withdrawn on the way out, so an app
    starting later never runs a job whose caller has already given up, and what
    a runner already mid-job writes afterwards is swept rather than left for
    nobody.
    """
    return _run_job(job, JOB_TIMEOUT_SECONDS)


def _run_job(job: dict, wait_seconds: float) -> dict:
    """`run_job`'s work, held to `wait_seconds` rather than the seam's own cap.

    An operation whose caller bounds its own worst case passes that budget
    in: the crash screenshot captures inline on the monitor loop, and a
    runner that has wedged must not hold the loop for the two minutes a job
    is otherwise given.
    """
    _sweep_abandoned()
    if _desktop_pid() is None:
        return _desktop_not_running(job, 'the desktop app is not running')

    job_id = uuid.uuid4().hex
    request = data_root(f'{JOBS_DIR}/{job_id}.json')
    result_dir = data_root(f'{RESULTS_DIR}/{job_id}')
    result_file = os.path.join(result_dir, 'result.json')
    _write_job(request, dict(job, id=job_id))
    try:
        deadline = time.monotonic() + wait_seconds
        while True:
            result = _read_result(result_file)
            if result is not None:
                return dict(result, outputDir=result_dir)
            if time.monotonic() >= deadline:
                _abandon(job_id)
                return _desktop_not_running(
                    job, f'no result within {wait_seconds}s'
                )
            time.sleep(_JOB_POLL_SECONDS)
    finally:
        _discard(request)


def capture_screen(monitor: int, *, executor, timeout_s: int) -> dict:
    """Grab `monitor` where the user can see it, through the desktop app.

    `executor` is the Windows service's user-session round-trip and has no part
    here — the daemon has no display of its own, so the grab is a job for the
    resident app, which on macOS is also the only process whose TCC grant can
    cover a capture at all.

    The result is the shape the Windows executor answers with, so
    screenshot_capture reads both the same way: the app writes the PNG into the
    job's result directory and reports the monitor count, which is handed on as
    the `monitors=N` line that arm prints.

    `timeout_s` is the runner's budget for the grab and the daemon's own
    wait alike, so a caller that bounds the call is held to what it asked
    for rather than to the seam's cap.
    """
    del executor
    result = _run_job(
        {'type': 'capture', 'monitor': monitor, 'timeout_s': timeout_s},
        timeout_s + _JOB_HANDOVER_SECONDS,
    )
    if result.get('error'):
        return _discard_output(result)
    monitors = result.get('monitors')
    return {
        'outputDir': result['outputDir'],
        'files': result.get('files') or [],
        'stdout': f'monitors={monitors}' if isinstance(monitors, int) else '',
    }


def notify(title: str, body: str) -> dict:
    """Show a message to whoever is at the machine.

    Another job for the app: a root daemon has no session to draw in, so
    `osascript` and `notify-send` would both fail from here — and an app that is
    down is the typed refusal rather than a message nobody ever sees. The job
    produces no files, so its result directory is removed on the way out.
    """
    result = _discard_output(
        run_job({'type': 'notify', 'title': title, 'body': body})
    )
    return result if result.get('error') else {'status': 'sent'}


def launch_managed_process(spec: dict) -> int | None:
    """Start a configured managed process; returns its pid, None on failure.

    `spec` is the `processes[]` row OwletteService.launch_process_as_user
    consumes on Windows: `exe_path`, an optional `file_path` carrying the
    argument or file to open, and an optional `cwd`. It is launched as the
    console user and never as root — a kiosk application started by the daemon
    would have no display and would own its files to the wrong account.
    """
    user = console_user()
    if user is None:
        logger.error(
            f"Cannot launch {spec.get('exe_path')!r}: nobody is signed in at a "
            f"graphical session"
        )
        return None
    try:
        account = pwd.getpwnam(user)
        argv = _managed_argv(spec)
        cwd = _managed_cwd(spec)
    except (KeyError, OSError, ValueError) as e:
        logger.error(f"Cannot launch {spec.get('exe_path')!r}: {e}")
        return None

    logger.info(f"Launching: {' '.join(argv)} as {user}")
    try:
        pid = _spawn(argv, account.pw_uid, session_env(account.pw_uid), cwd=cwd)
    except (OSError, ValueError) as e:
        logger.error(f"Process launch failed: {e}")
        return None
    logger.info(f"Process launched with PID {pid}")
    return pid


def desktop_process_name() -> str:
    """The desktop app's image name, for the tray-liveness guard."""
    return DESKTOP_PROCESS_NAME


def json_lock():
    """The flock desktop/src-tauri/src/json_io.rs takes for the same writes."""
    import shared_utils

    return shared_utils._CrossProcessLock()


def harden_data_root(root, directories) -> None:
    """Apply decision 4's mode table to the tree `ensure_data_directories` built.

    The daemon is root at umask 022 and the desktop app is the console user, so
    every directory the app writes into has to be opened to the group
    explicitly, and the group has to own it. `root` is the caller's — the one
    the adapter answered with — so the table is read against the tree that was
    actually built. Nothing here raises: a dev box that is not root still gets
    its directories, and an install whose group has not been created yet
    (packaging owns that) keeps working with the modes alone.
    """
    gid = _group_gid()
    for directory in directories:
        _apply(directory, _directory_mode(_relative_to(root, directory)), gid, True)
    for relative, mode, create in _FILE_MODES:
        path = os.path.join(root, relative)
        if create:
            _create(path, mode)
        if os.path.lexists(path):
            _apply(path, mode, gid, False)
    _chgrp_tree(os.path.join(root, CLI_CACHE_DIR), gid)


def adopt_into_group(path: str) -> None:
    """Give one file the daemon wrote into the tree to the group.

    The mode table is applied when the daemon starts; anything it writes there
    afterwards — the cortex CLI binary above all, which is 0o750 — has to be
    handed over as it is written, or the console user cannot reach it until the
    next start.
    """
    gid = _group_gid()
    if gid is not None:
        _chgrp(path, gid)


def _directory_mode(relative: str) -> int:
    """The table's mode for a directory, by its path under the data root."""
    mode = _DIRECTORY_MODES.get(relative)
    if mode is not None:
        return mode
    return 0o770 if relative.startswith('ipc/') else 0o750


def _relative_to(root: str, path: str) -> str:
    """`path` under `root`, slash-separated; '' for the root itself."""
    relative = os.path.relpath(path, root).replace(os.sep, '/')
    return '' if relative == '.' else relative


def _apply(path: str, mode: int, gid: int | None, directory: bool) -> None:
    """One entry of the mode table: the bits, then the group that needs them.

    Applied to a descriptor opened O_NOFOLLOW and never to the name. Half the
    table is group-writable by design, so an entry swapped for a symlink would
    otherwise carry the table's bits — and the group — to whatever it names.
    """
    try:
        fd = _open_entry(path, directory)
    except OSError as e:
        logger.warning(f"Not applying {oct(mode)} to {path}: {e}")
        return
    try:
        os.fchmod(fd, mode)
        if gid is not None and os.fstat(fd).st_gid != gid:
            os.fchown(fd, -1, gid)
    except OSError as e:
        logger.debug(f"Could not set {oct(mode)} on {path}: {e}")
    finally:
        os.close(fd)


def _open_entry(path: str, directory: bool) -> int:
    """A descriptor on the entry itself: not a symlink, and the kind the table
    names. O_NONBLOCK so a fifo left in the tree cannot stall the open."""
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    if directory:
        return os.open(path, flags | os.O_DIRECTORY)
    fd = os.open(path, flags)
    if stat.S_ISREG(os.fstat(fd).st_mode):
        return fd
    os.close(fd)
    raise OSError(errno.EINVAL, 'not a regular file', path)


def _create(path: str, mode: int) -> None:
    """Create the file if it is not there yet; leave it alone if it is.

    O_EXCL: the directory is group-writable, so an entry already there — a
    symlink planted in it included — is never opened through.
    """
    try:
        os.close(os.open(path, os.O_RDWR | os.O_CREAT | os.O_EXCL, mode))
    except FileExistsError:
        pass
    except OSError as e:
        logger.debug(f"Could not create {path}: {e}")


def _chgrp(path: str, gid: int) -> None:
    """Group ownership, never followed through a symlink out of the tree."""
    try:
        if os.lstat(path).st_gid != gid:
            os.chown(path, -1, gid, follow_symlinks=False)
    except OSError as e:
        logger.debug(f"Could not give {path} to group {GROUP}: {e}")


def _chgrp_tree(path: str, gid: int | None) -> None:
    """Hand a whole subtree to the group, files the daemon wrote included."""
    if gid is None or not os.path.isdir(path):
        return
    _chgrp(path, gid)
    for current, directories, files in os.walk(path):
        for name in directories + files:
            _chgrp(os.path.join(current, name), gid)


def _group_gid() -> int | None:
    """The daemon group's gid, or None until packaging has created it."""
    global _missing_group_logged
    try:
        return grp.getgrnam(GROUP).gr_gid
    except KeyError:
        if not _missing_group_logged:
            _missing_group_logged = True
            logger.warning(
                f"Group {GROUP} does not exist — leaving the data root's group "
                f"ownership alone; the desktop app cannot reach the seam until "
                f"the package creates it"
            )
        return None


def _graphical_session(uid=None) -> _Session | None:
    """The active graphical session, `uid`'s when one is named; None if no seat.

    A headless machine, a container and a box whose kiosk user has not logged in
    yet all resolve to None here — there is a session listed for each, and none
    of them is a seat.
    """
    for line in _loginctl('list-sessions', '--no-legend').splitlines():
        columns = line.split()
        if not columns:
            continue
        properties = _session_properties(columns[0])
        if properties.get('Active') != 'yes':
            continue
        session_type = properties.get('Type')
        if session_type not in _GRAPHICAL_SESSION_TYPES:
            continue
        if uid is not None and properties.get('User') != str(uid):
            continue
        name, leader = properties.get('Name'), properties.get('Leader', '')
        if name and leader.isdigit():
            return _Session(name, int(leader), session_type)
    return None


def _session_properties(session_id: str) -> dict[str, str]:
    """What loginctl reports about one session, as a mapping."""
    output = _loginctl(
        'show-session', session_id,
        '-p', 'Type', '-p', 'Active', '-p', 'Name', '-p', 'Leader', '-p', 'User',
    )
    properties = {}
    for line in output.splitlines():
        key, separator, value = line.partition('=')
        if separator:
            properties[key.strip()] = value.strip()
    return properties


def _loginctl(*args) -> str:
    """loginctl's stdout; '' when it is absent, times out or refuses."""
    try:
        result = subprocess.run(
            ['loginctl', *args],
            capture_output=True,
            text=True,
            timeout=_LOGINCTL_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as e:
        logger.debug(f"loginctl {' '.join(args)} failed: {e}")
        return ''
    if result.returncode != 0:
        logger.debug(
            f"loginctl {' '.join(args)} exited {result.returncode}: "
            f"{result.stderr.strip()}"
        )
        return ''
    return result.stdout


def _process_environ(pid: int) -> dict[str, str]:
    """The environment a running process was given, from /proc."""
    try:
        with open(f'/proc/{pid}/environ', 'rb') as f:
            raw = f.read()
    except OSError as e:
        logger.debug(f"Could not read the environment of pid {pid}: {e}")
        return {}
    environ = {}
    for entry in raw.split(b'\0'):
        name, separator, value = entry.partition(b'=')
        if separator:
            environ[name.decode(errors='replace')] = value.decode(errors='replace')
    return environ


def _account_env(uid) -> dict[str, str]:
    """What every process of that account gets, seat or no seat."""
    account = pwd.getpwuid(uid)
    return {
        'HOME': account.pw_dir,
        'USER': account.pw_name,
        'LOGNAME': account.pw_name,
        'PATH': _DEFAULT_PATH,
    }


def _spawn(argv, uid, env, cwd=None) -> int:
    """Spawn `argv` as `uid`, in a session of its own, with `env` and no more.

    No preexec_fn: CPython documents it as unsafe in a threaded process, and
    this daemon runs a thread pool and a dozen threads — so the uid, the primary
    group and the account's supplementary groups are handed to Popen itself.
    start_new_session detaches the child from the daemon's process group, which
    is what keeps it running across a service restart.
    """
    account = pwd.getpwuid(uid)
    child = subprocess.Popen(
        argv,
        user=uid,
        group=account.pw_gid,
        extra_groups=os.getgrouplist(account.pw_name, account.pw_gid),
        start_new_session=True,
        env=env,
        cwd=cwd,
    )
    return _remember(child)


def _remember(child) -> int:
    """Keep the handle, drop the finished ones, and return the live pid.

    Supervision is pid-based, but a child nobody waits on stays a zombie — a pid
    that still exists, which is exactly what a pid-based supervisor reads as
    "still running" — and a dropped Popen never waits on anything.
    """
    _reap_finished()
    with _children_lock:
        _children[child.pid] = child
    return child.pid


def _reap_finished() -> None:
    """Wait on the spawned children that have exited, releasing their pids."""
    with _children_lock:
        for pid in [pid for pid, child in _children.items() if child.poll() is not None]:
            del _children[pid]


def _managed_argv(spec: dict) -> list[str]:
    """The command line a managed process row asks for."""
    exe_path = _validated((spec.get('exe_path') or '').strip(), 'executable path')
    if not exe_path:
        raise ValueError('the process has no exe_path')
    if not os.path.isfile(exe_path):
        raise FileNotFoundError(f"executable path not found: {exe_path}")
    arguments = (spec.get('file_path') or '').strip()
    if not arguments:
        return [exe_path]
    # The field holds either one file to open or a command line, the same way it
    # does on Windows; a path that exists is never re-split on its spaces.
    if os.path.isfile(arguments):
        return [exe_path, _validated(arguments, 'file path')]
    return [exe_path, *shlex.split(arguments)]


def _managed_cwd(spec: dict) -> str | None:
    """The working directory a managed process row asks for, validated."""
    cwd = _validated((spec.get('cwd') or '').strip(), 'working directory')
    if not cwd:
        return None
    if not os.path.isdir(cwd):
        raise NotADirectoryError(f"working directory does not exist: {cwd}")
    return cwd


def _validated(path: str, label: str) -> str:
    """A path out of the process row, absolute and never a symbolic link.

    The same refusal OwletteService._validate_path applies to these three fields
    on Windows: the row arrives from Firestore, and a link under a directory the
    console user can write is not a path the operator chose.
    """
    if not path:
        return path
    resolved = os.path.abspath(path)
    if os.path.islink(resolved):
        raise ValueError(f"{label} cannot be a symbolic link: {path}")
    return resolved


def _desktop_pid() -> int | None:
    """The desktop app's pid, or None when the app is not up."""
    import shared_utils

    return shared_utils.read_desktop_pid(shared_utils.TRAY_PID_PATH)


def _desktop_not_running(job: dict, why: str) -> dict:
    """The typed refusal a GUI job fails closed with."""
    return {
        'error': 'desktop_not_running',
        'job': job.get('type'),
        'message': f"the desktop app did not run this job: {why}",
    }


def _write_job(path: str, payload: dict) -> None:
    """Write the request whole, then move it into the watched directory.

    The app watches for the file and reads it as soon as it appears, so a job
    must never be visible there half-written. The group is set explicitly: the
    file is 0640 root and the app runs as the console user, which reaches it
    through the group and cannot alter it.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = f'{path}.{os.getpid()}.tmp'
    gid = _group_gid()
    try:
        fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, JOB_FILE_MODE)
        try:
            os.write(fd, json.dumps(payload).encode('utf-8'))
        finally:
            os.close(fd)
        if gid is not None:
            _chgrp(temp_path, gid)
        os.replace(temp_path, path)
    except OSError:
        _discard(temp_path)
        raise


def _read_result(path: str) -> dict | None:
    """The job's result, or None while the app has not finished writing one.

    Read off a descriptor on the entry itself: the directory is the app's to
    write, so the result has to be a regular file the daemon opens directly and
    never a link it follows out of the seam or a fifo it blocks on.
    """
    try:
        fd = _open_entry(path, False)
    except FileNotFoundError:
        return None
    except OSError as e:
        logger.debug(f"Job result {path} is not readable yet: {e}")
        return None
    try:
        with os.fdopen(fd, 'r', encoding='utf-8') as f:
            result = json.load(f)
    except (OSError, ValueError) as e:
        logger.debug(f"Job result {path} is not readable yet: {e}")
        return None
    return result if isinstance(result, dict) else None


def _abandon(job_id: str) -> None:
    """Note a job whose caller has stopped waiting for it."""
    with _abandoned_lock:
        _abandoned[job_id] = time.monotonic() + JOB_TIMEOUT_SECONDS


def _sweep_abandoned() -> None:
    """Remove what a runner wrote for a job nobody is waiting for any more.

    The result directory is the caller's to remove once it has read the job's
    output, so one the caller never received would sit in the tree for good. A
    runner that was already mid-job when the caller gave up is watched for
    another JOB_TIMEOUT_SECONDS, which is longer than it has left to run.
    """
    now = time.monotonic()
    with _abandoned_lock:
        expired = list(_abandoned.items())
    for job_id, expires in expired:
        _discard_tree(data_root(f'{RESULTS_DIR}/{job_id}'))
        if now >= expires:
            with _abandoned_lock:
                _abandoned.pop(job_id, None)


def _discard_output(result: dict) -> dict:
    """Remove the result directory of a job whose output nobody will read.

    `outputDir` is the caller's to remove, and neither a job that produced
    no files nor one that answered with an error leaves anything to read —
    so the directory goes here rather than staying in the seam for good.
    """
    output_dir = result.pop('outputDir', None)
    if output_dir:
        _discard_tree(output_dir)
    return result


def _discard_tree(path: str) -> None:
    """Remove a directory the job seam owns, whether or not it is there."""
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        pass
    except OSError as e:
        logger.debug(f"Could not remove {path}: {e}")


def _discard(path: str) -> None:
    """Remove a file we own, whether or not it is still there."""
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError as e:
        logger.debug(f"Could not remove {path}: {e}")
