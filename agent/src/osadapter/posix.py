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
from collections.abc import Iterator

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
# And only a login's own session. The display manager's greeter is an
# active graphical session of its own — on the kiosk VM logind lists it as
# `Class=greeter, Name=gdm, Type=x11, Active=yes` before the autologin and
# after every logout — and answering with it ran the kiosk application as
# the display manager's system account on an unattended login screen, and
# let a request written by that account through the privileged seam.
_USER_SESSION_CLASS = 'user'
# And only while that login is still standing. logind keeps a session
# listed through its whole teardown — on the kiosk VM for 90 seconds,
# systemd's scope stop timeout, with Active=yes, Class=user and Type=x11
# unchanged long after the X server it named had exited — and only State
# moves: a session being stopped reports `closing` from the moment the stop
# begins. Launching into one succeeds, the process dies with the display it
# was handed, and a logout spent a GUI entry's whole relaunch budget. A
# logind too old to publish the property leaves the session judged as before.
_LIVE_SESSION_STATES = frozenset({'active', 'online'})
_LOGINCTL_TIMEOUT_SECONDS = 5

# Lifted from a process inside the session rather than assembled from
# constants: GDM, LightDM and SDDM each put the X cookie somewhere different,
# and a DISPLAY without an XAUTHORITY leaves root with "cannot open display".
# The account's own variables are never among them — a session runs other
# accounts' processes too, root's PAM worker above all.
_SESSION_VARIABLES = frozenset({
    'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS', 'XDG_SESSION_TYPE',
})
# What tells a process of the session apart from a helper that merely runs
# inside it.
_DISPLAY_VARIABLES = ('DISPLAY', 'WAYLAND_DISPLAY')
# How much of a search is opened before it gives up: a seat runs tens of
# processes and the machine hundreds, and the search must never become a walk
# of all of them. A cgroup's own `cgroup.procs` is the kernel's own list and
# is read whole; what this bounds is what a search opens — the session user's
# own processes, and the cgroup files under their systemd manager. Bounding
# raw pids bounded it to the machine's numerically lowest 256, which on any
# box that has run more than that are the boot's processes and never the
# login's.
_SESSION_SCAN_LIMIT = 256
_DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin'

# The three trees the kernel publishes a session through, named here rather
# than written into each path: the suite points them at a seat it builds, which
# is the only way to hold this to one the test machine does not have.
PROC_ROOT = '/proc'
CGROUP_ROOT = '/sys/fs/cgroup'
RUNTIME_DIR_ROOT = '/run/user'

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

_Session = namedtuple('_Session', 'name type id uid')

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

    The account's own variables always, and the session's display variables
    when that user is at a seat. What is lifted never overwrites the account's
    half: HOME, USER, LOGNAME and PATH describe the account the process is
    about to run as, and the session is not that account's alone to speak for.
    A variable the session set to nothing is not lifted either: an empty
    WAYLAND_DISPLAY names no socket, and a toolkit that picks its backend on
    the variable's presence stops there rather than falling back to the
    DISPLAY beside it — the reason the cookie ladder omits XAUTHORITY too.
    """
    env = _account_env(uid)
    session = _graphical_session(uid)
    if session is not None:
        lifted = _session_display_environ(session)
        env.update({
            name: value
            for name, value in lifted.items()
            if name in _SESSION_VARIABLES and value
        })
        cookie = _xauthority(lifted.get('XAUTHORITY'), uid)
        if cookie:
            env['XAUTHORITY'] = cookie
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

    A headless machine, a container, a box whose kiosk user has not logged in
    yet and one sitting at the login screen all resolve to None here — there is
    a session listed for each, and none of them is a login of a real account.
    """
    for line in _loginctl('list-sessions', '--no-legend').splitlines():
        columns = line.split()
        if not columns:
            continue
        properties = _session_properties(columns[0])
        if properties.get('Active') != 'yes':
            continue
        if properties.get('Class') != _USER_SESSION_CLASS:
            continue
        state = properties.get('State')
        if state and state not in _LIVE_SESSION_STATES:
            continue
        session_type = properties.get('Type')
        if session_type not in _GRAPHICAL_SESSION_TYPES:
            continue
        if uid is not None and properties.get('User') != str(uid):
            continue
        name, session_uid = properties.get('Name'), properties.get('User', '')
        if name and session_uid.isdigit():
            return _Session(name, session_type, columns[0], int(session_uid))
    return None


def _session_display_environ(session: _Session) -> dict[str, str]:
    """The environment of a process that is actually inside the session.

    Not the session leader: on GDM — X11 and Wayland alike — logind names a
    root-owned `gdm-session-worker` as the Leader, and its environment carries
    no display at all, only root's own PATH and USER. logind has nothing else
    to offer either, its `Display` property being empty on both session types.
    The variables exist only on the processes the session itself started, so
    one of those answers: the first process belonging to the session's own
    user, in its scope or in the user units beside it, whose environment
    names a display.
    """
    for pid in _session_pids(session):
        if _process_uid(pid) != session.uid:
            continue
        environ = _process_environ(pid)
        if any(environ.get(name) for name in _DISPLAY_VARIABLES):
            return environ
    logger.warning(
        f"No process in {session.name}'s graphical session carries a display; "
        f"a process launched into it would reach none either"
    )
    return {}


def _session_pids(session: _Session) -> Iterator[int]:
    """The processes to ask about the session, the exact ones first.

    cgroup v2 keeps a logind session's processes in one scope, so that scope's
    `cgroup.procs` is the list itself — read whole, because the kernel's own
    answer is not ours to truncate. A machine that does not publish it there
    — a v1 hierarchy, or a scope under some other slice — is answered by the
    processes whose own cgroup line names the scope.

    Since GNOME 3.34 the session is also a set of systemd *user* units, which
    sit beside that scope rather than inside it: on Ubuntu 24.04 the scope
    holds Xorg and the session binary while gnome-shell — the process
    carrying WAYLAND_DISPLAY, and DISPLAY once XWayland has started — runs
    under `user@<uid>.service`. That unit's own subtree of `cgroup.procs`
    files answers for it, read after the scope and never instead of it. The
    rest of the user's slice is never asked at all — an ssh login of the same
    account is in it, and a forwarded DISPLAY is a screen on somebody else's
    desk.
    """
    scope = f'session-{session.id}.scope'
    listed = _read_pids(os.path.join(
        CGROUP_ROOT, 'user.slice', f'user-{session.uid}.slice', scope,
        'cgroup.procs',
    ))
    asked = set()
    for pid in listed or _pids_under(scope, session.uid):
        asked.add(pid)
        yield pid
    for pid in _user_manager_pids(session.uid):
        if pid not in asked:
            yield pid


def _read_pids(path: str) -> list[int]:
    """The pids one cgroup.procs names; empty when there is no such file."""
    return [
        int(entry)
        for entry in _read_entry(path).decode(errors='replace').split()
        if entry.isdigit()
    ]


def _pids_under(cgroup_name: str, uid) -> list[int]:
    """`uid`'s live processes whose own cgroup names `cgroup_name`.

    Ownership settles what is a candidate at all, and it settles it first:
    only the session user's own processes are ever asked for a display, and
    the bound belongs on those rather than on the machine's pids.
    """
    try:
        listed = sorted(
            int(name) for name in os.listdir(PROC_ROOT) if name.isdigit())
    except OSError as e:
        logger.debug(f"Could not list {PROC_ROOT}: {e}")
        return []
    pids = []
    examined = 0
    for pid in listed:
        if _process_uid(pid) != uid:
            continue
        cgroup = _read_entry(_proc_path(pid, 'cgroup')).decode(errors='replace')
        if cgroup_name in cgroup:
            pids.append(pid)
        examined += 1
        if examined >= _SESSION_SCAN_LIMIT:
            break
    return pids


def _user_manager_pids(uid) -> list[int]:
    """The processes of `uid`'s systemd user manager, off the kernel's lists.

    A `cgroup.procs` file names one cgroup's own processes and not its
    children's, so the unit's whole subtree is read rather than its root:
    gnome-shell is two levels down, under
    `session.slice/org.gnome.Shell@wayland.service`, and it is the only
    process on a Wayland seat that carries the display at all.

    That subtree is the unified hierarchy's, and a hierarchy whose root
    publishes no `cgroup.controllers` is not it: on a v1 or hybrid box none
    of those directories exist and the walk would answer nothing at all. The
    unit is matched the way the rung below matches the scope there — on the
    processes whose own cgroup line names it, which a v1 systemd publishes
    just as it does the scope's. The marker at the root is not a promise
    about the path either — a delegated or renamed slice puts the manager
    somewhere else — so a walk that opens no `cgroup.procs` at all falls
    back to that same path-independent match rather than answering nothing.
    """
    unit = f'user@{uid}.service'
    if not os.path.exists(os.path.join(CGROUP_ROOT, 'cgroup.controllers')):
        return _pids_under(unit, uid)
    root = os.path.join(
        CGROUP_ROOT, 'user.slice', f'user-{uid}.slice', unit)
    pids = []
    opened = 0
    for current, _directories, files in os.walk(root):
        if 'cgroup.procs' not in files:
            continue
        pids.extend(_read_pids(os.path.join(current, 'cgroup.procs')))
        opened += 1
        if opened >= _SESSION_SCAN_LIMIT:
            break
    return pids if opened else _pids_under(unit, uid)


def _session_properties(session_id: str) -> dict[str, str]:
    """What loginctl reports about one session, as a mapping."""
    output = _loginctl(
        'show-session', session_id,
        '-p', 'Type', '-p', 'Active', '-p', 'Name', '-p', 'User',
        '-p', 'Class', '-p', 'State',
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


def _proc_path(pid: int, name: str) -> str:
    """One of the files the kernel publishes about a process."""
    return os.path.join(PROC_ROOT, str(pid), name)


def _read_entry(path: str) -> bytes:
    """A kernel file, read off a descriptor on the entry itself.

    /proc and /sys are the kernel's own, but the paths under them are built
    from what loginctl reported, so they get the O_NOFOLLOW and regular-file
    discipline everything under the data root gets.
    """
    try:
        fd = _open_entry(path, False)
    except OSError as e:
        logger.debug(f"Could not open {path}: {e}")
        return b''
    try:
        with os.fdopen(fd, 'rb') as f:
            return f.read()
    except OSError as e:
        logger.debug(f"Could not read {path}: {e}")
        return b''


def _process_environ(pid: int) -> dict[str, str]:
    """The environment a running process was given, from /proc."""
    environ = {}
    for entry in _read_entry(_proc_path(pid, 'environ')).split(b'\0'):
        name, separator, value = entry.partition(b'=')
        if separator:
            environ[name.decode(errors='replace')] = value.decode(errors='replace')
    return environ


def _process_uid(pid: int) -> int | None:
    """The account a process runs as, or None when /proc will not say.

    Taken from the process's own status rather than from the owner of its
    /proc directory: both are the kernel's answer to the same question, and
    this one can also be stated by a layout the suite writes.
    """
    status = _read_entry(_proc_path(pid, 'status')).decode(errors='replace')
    for line in status.splitlines():
        if line.startswith('Uid:'):
            fields = line.split()
            if len(fields) > 1 and fields[1].isdigit():
                return int(fields[1])
            return None
    return None


def _account_env(uid) -> dict[str, str]:
    """What every process of that account gets, seat or no seat."""
    account = pwd.getpwuid(uid)
    return {
        'HOME': account.pw_dir,
        'USER': account.pw_name,
        'LOGNAME': account.pw_name,
        'PATH': _DEFAULT_PATH,
    }


def _xauthority(lifted: str | None, uid) -> str | None:
    """The X cookie to hand the process, or None when there is none to hand.

    The in-session value first: every display manager keeps the cookie
    somewhere else and only the session knows where. GDM's lives under the
    user's runtime directory and never in the home directory `startx` and the
    older managers write to, so the home-directory guess names nothing at all
    on a GDM kiosk — and an XAUTHORITY naming nothing is worse than none,
    because X stops there rather than falling back.
    """
    candidates = (
        lifted,
        os.path.join(RUNTIME_DIR_ROOT, str(uid), 'gdm', 'Xauthority'),
        os.path.join(_account_env(uid)['HOME'], '.Xauthority'),
    )
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


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
    """The command line a managed process row asks for.

    A macOS application bundle is launched as the binary inside it — the image
    supervision later finds by path — and never through `open`, which hands the
    launch to LaunchServices and leaves no pid of ours to supervise.
    """
    import shared_utils

    exe_path = _validated((spec.get('exe_path') or '').strip(), 'executable path')
    if not exe_path:
        raise ValueError('the process has no exe_path')
    exe_path = shared_utils.resolve_exec_target(exe_path)
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
