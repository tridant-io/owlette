"""
fleet_session: keeps this machine's fleet session where its local MCP script
reads it (ADR 0017).

A granted machine acts on other machines of its site through
`/api/agent/fleet/*`. The script that does so (`fleet_mcp.py`) runs as the
logged-in user and never holds the agent's own credentials: the service
exchanges its ID token for a 15-minute fleet session, good for nothing else,
and writes it to `ipc/fleet/session.json`, which the logged-in user may only
read. This module is that exchange and that file.

The service's 5-second loop calls `tick()`, which only decides whether there is
work and starts it on a daemon thread, one at a time. Nothing here ever logs the
session or the agent's token: a failed request is named by its exception type
alone, because requests quotes a header it refuses.

Windows and macOS. On macOS the service is root and the console user reads the
file through the service group: `ipc/fleet` takes the data-root mode table's row
for a folder under `ipc/` (0770), and the file is written 0640 with that group,
the way the hoot token file is. Elsewhere (Linux) `tick()` and `withdraw()` do
nothing.
"""

import errno
import json
import logging
import os
import stat
import sys
import threading
import time

import acl_hardening
import shared_utils

SESSION_FILE = 'session.json'

# the route allows 30 calls an hour for one machine. the session lives 15
# minutes and is asked for every 10; a failed refresh is tried again every 150
# seconds, which is 24 an hour at worst and one retry inside the old session's
# life.
REFRESH_SECONDS = 600
RETRY_SECONDS = 150
# a machine with no grant asks again hourly, and sooner when the site's settings
# change (`request_refresh`), though never twice inside a minute: that command
# reaches every machine of the site, most of which hold no grant.
NOT_GRANTED_SECONDS = 3600
MIN_ASK_GAP_SECONDS = 60
# an unpaired machine has nothing to ask with; whether it has paired is a
# local read.
UNPAIRED_SECONDS = 30
REQUEST_TIMEOUT_SECONDS = 15

# the server's two answers that mean "no session for this machine".
_REFUSALS = {
    (403, 'fleet_not_granted'): 'this machine holds no grant to act on its site',
    (401, 'pairing_revoked'): 'this machine is no longer paired to its site',
}

_SUPPORTED = sys.platform in ('win32', 'darwin')


def session_path():
    """Where the local MCP script reads this machine's fleet session."""
    return os.path.join(shared_utils.get_data_path('ipc/fleet'), SESSION_FILE)


def _ensure_session_dir():
    """Create ipc/fleet: the service writes, the console user reads. Raises when
    the directory exists and is not the service's own."""
    path = os.path.dirname(session_path())
    if sys.platform == 'win32':
        aces = {os.path.normcase(entry.path): entry.aces for entry in acl_hardening.specs()}
        acl_hardening.create_private_dir(path, aces[os.path.normcase(path)])
        return
    # ipc/ is group-writable, so a folder the console user planted is theirs
    os.makedirs(path, exist_ok=True)
    info = os.lstat(path)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        raise acl_hardening.UntrustedDirectory(f"refusing to use {path}: not a folder the service owns")
    from osadapter import posix

    posix.harden_data_root(shared_utils.get_data_path(), [path])


def _open_session_dir():
    """A descriptor on ipc/fleet, checked on the descriptor: a folder owned by
    the service, not a link. ipc/ is group-writable, so the name can be swapped
    at any moment and every file operation goes through a descriptor taken fresh
    here. Raises FileNotFoundError when there is no folder."""
    try:
        fd = os.open(
            os.path.dirname(session_path()),
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
    except OSError as e:
        if e.errno in (errno.ELOOP, errno.ENOTDIR):
            raise acl_hardening.UntrustedDirectory("ipc/fleet is not a folder") from e
        raise
    if os.fstat(fd).st_uid != os.geteuid():
        os.close(fd)
        raise acl_hardening.UntrustedDirectory("ipc/fleet is not owned by the service")
    return fd


def _publish_session(session):
    """Write the session to a new file that no one but the service and, off
    Windows, its group can read at any moment, then move it over the old one."""
    path = session_path()
    if sys.platform == 'win32':
        temp_path = f"{path}.tmp"
        with open(temp_path, 'w', encoding='utf-8') as f:
            json.dump(session, f)
        os.replace(temp_path, path)
        return
    name = os.path.basename(path)
    temp_name = f"{name}.tmp"
    dir_fd = _open_session_dir()
    try:
        # shared_utils.open_new_file takes no dir_fd, and a path open here would
        # follow a swapped folder
        try:
            os.unlink(temp_name, dir_fd=dir_fd)
        except FileNotFoundError:
            pass
        # created for the service alone: the group may read it only once it
        # is the service's group, never whatever group a new file starts with
        file_fd = os.open(
            temp_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=dir_fd,
        )
        with os.fdopen(file_fd, 'w', encoding='utf-8') as f:
            shared_utils.grant_data_group(f.fileno())
            os.fchmod(f.fileno(), 0o640)
            json.dump(session, f)
        os.replace(temp_name, name, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
    finally:
        os.close(dir_fd)


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _retry_after(response):
    """How long a 429 says to wait, in seconds, within what the keeper will
    wait: a whole interval when the server names no time."""
    try:
        seconds = int(response.headers.get('Retry-After'))
    except (AttributeError, TypeError, ValueError):
        seconds = REFRESH_SECONDS
    return min(max(seconds, RETRY_SECONDS), NOT_GRANTED_SECONDS)


class FleetSessionKeeper:
    """Fetches this machine's fleet session and keeps its file current.

    `get_client` returns the service's FirebaseClient, or None before there is
    one. It is asked on every refresh, because a re-pair replaces the client.
    """

    def __init__(self, get_client, clock=time.time):
        self._get_client = get_client
        self._clock = clock
        self._lock = threading.Lock()
        self._thread = None
        self._due_at = 0.0
        self._asked = False
        self._last_request_at = None
        # bumped by withdraw(), so a refresh in flight cannot put the file back
        self._epoch = 0
        # when the file's session runs out: None with no file, 0.0 for a file
        # that should not be there. it starts at 0.0 because a run that died
        # may have left one, which the first pass replaces or deletes.
        self._expires_at = 0.0
        # a fetched session the file would not take yet
        self._pending = None
        self._dir_ready = False
        self._said = None

    def tick(self):
        """Start a worker when there is work. Called on the 5-second loop, so it
        does no I/O of its own."""
        if not _SUPPORTED:
            return
        if self._thread is not None and self._thread.is_alive():
            return
        now = self._clock()
        with self._lock:
            idle = (
                self._pending is None
                and now < self._due_at
                and (self._expires_at is None or now < self._expires_at)
            )
        if idle:
            return
        thread = threading.Thread(target=self._run, daemon=True, name='fleet-session')
        thread.start()
        self._thread = thread

    def request_refresh(self):
        """Ask for a refresh as soon as the keeper may ask again: the site's
        settings changed, and this machine may just have been granted or cut."""
        with self._lock:
            self._asked = True
            self._due_at = min(self._due_at, self._soonest())

    def withdraw(self):
        """Delete the session file: the machine left its site, or the service
        is stopping. A refresh in flight is discarded."""
        if not _SUPPORTED:
            return
        with self._lock:
            self._epoch += 1
            self._pending = None
            self._due_at = 0.0
        self._remove_file()

    def _soonest(self):
        """The earliest the server may be asked again. Call with the lock held."""
        if self._last_request_at is None:
            return 0.0
        return self._last_request_at + MIN_ASK_GAP_SECONDS

    def _run(self):
        with self._lock:
            self._asked = False
            epoch = self._epoch
        try:
            self.refresh_once()
        except Exception as e:
            # the type alone: see the module docstring
            self._say(f"refresh failed ({type(e).__name__})")
            self._set_due(self._clock() + RETRY_SECONDS, epoch)
        with self._lock:
            # asked while this pass ran, which may have read the server too early
            if self._asked:
                self._asked = False
                self._due_at = min(self._due_at, self._soonest())

    def refresh_once(self):
        """One pass: finish a write the file refused, drop a session that ran
        out, or fetch a new one when that is due."""
        now = self._clock()
        with self._lock:
            if self._pending is not None and self._pending['expiresAt'] <= now:
                self._pending = None
            pending, due, epoch = self._pending, now >= self._due_at, self._epoch
        if pending is not None:
            self._store(pending, epoch)
        elif due:
            self._fetch(now, epoch)
        else:
            self._drop_expired(now)

    def _fetch(self, now, epoch):
        client = self._get_client()
        manager = getattr(client, 'auth_manager', None)
        if manager is None or not manager.is_authenticated():
            self._set_due(now + UNPAIRED_SECONDS, epoch)
            self._remove_file()
            return

        import requests

        api_base = shared_utils.get_api_base_url()
        with self._lock:
            self._last_request_at = now
        try:
            response = requests.post(
                f"{api_base}/agent/fleet/session",
                headers={'Authorization': f'Bearer {manager.get_valid_token()}'},
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except Exception as e:
            self._keep_until_expiry(now, epoch, type(e).__name__)
            return
        status = response.status_code
        try:
            body = response.json()
        except ValueError:
            body = None
        if not isinstance(body, dict):
            body = {}

        if status == 200:
            session = self._session_from(body, api_base, client, now)
            if session is None:
                self._keep_until_expiry(now, epoch, 'an answer that is no session')
                return
            self._set_due(now + REFRESH_SECONDS, epoch)
            self._store(session, epoch)
            return
        refusal = _REFUSALS.get((status, body.get('code')))
        if refusal:
            self._set_due(now + NOT_GRANTED_SECONDS, epoch)
            self._remove_file()
            self._say(f"none ({refusal})", logging.INFO)
            return
        # a 429 waits as long as the server says; anything else is tried again sooner
        self._keep_until_expiry(
            now, epoch, f"http {status}",
            _retry_after(response) if status == 429 else RETRY_SECONDS,
        )

    @staticmethod
    def _session_from(body, api_base, client, now):
        """The file's content for a 200 answer, or None when it is not one."""
        token, expires_at = body.get('token'), body.get('expiresAt')
        site_id = getattr(client, 'site_id', None)
        machine_id = getattr(client, 'machine_id', None)
        if not (isinstance(token, str) and token and _is_number(expires_at) and expires_at > now
                and isinstance(site_id, str) and site_id
                and isinstance(machine_id, str) and machine_id):
            return None
        return {
            'token': token,
            'expiresAt': expires_at,
            'apiBase': api_base,
            'siteId': site_id,
            'machineId': machine_id,
        }

    def _store(self, session, epoch):
        with self._lock:
            if epoch != self._epoch:
                return
        temp_path = f"{session_path()}.tmp"
        try:
            if not self._dir_ready:
                _ensure_session_dir()
                self._dir_ready = True
            _publish_session(session)
        except (acl_hardening.UntrustedDirectory, acl_hardening.AclApplyError) as e:
            # nothing a retry fixes: the folder is not the service's to write in
            self._set_due(self._clock() + NOT_GRANTED_SECONDS, epoch)
            self._say(f"could not prepare the session folder ({type(e).__name__}: {e})")
            return
        except OSError as e:
            # windows refuses the replace while the script holds the file open
            # for a read: the next tick tries the write again, not the request.
            # the folder is looked at again too, in case it is what went, and
            # the half-written copy does not wait on disk with a live session.
            self._dir_ready = False
            self._discard(temp_path)
            with self._lock:
                if epoch == self._epoch:
                    self._pending = session
            self._say(f"could not write the session file ({type(e).__name__}: {e})")
            return
        with self._lock:
            withdrawn = epoch != self._epoch
            if not withdrawn:
                first = not self._expires_at
                self._pending = None
                self._expires_at = session['expiresAt']
        if withdrawn:
            self._remove_file()
            return
        self._said = None
        if first:
            logging.info("fleet session: this machine holds a grant; session written")

    def _keep_until_expiry(self, now, epoch, why, wait=RETRY_SECONDS):
        """A refresh that did not happen: the session in the file is still
        good until it runs out."""
        self._set_due(now + wait, epoch)
        self._drop_expired(now)
        self._say(f"could not refresh ({why}); the current session stays until it runs out")

    def _drop_expired(self, now):
        with self._lock:
            expired = self._expires_at is not None and now >= self._expires_at
        if expired:
            self._remove_file()

    def _remove_file(self):
        """Delete the session file and any half-written copy. One that will not
        go is tried again on the next tick."""
        path = session_path()
        gone = self._discard(f"{path}.tmp")
        gone = self._discard(path) and gone
        with self._lock:
            self._expires_at = None if gone else 0.0

    def _discard(self, path):
        """Delete one file. True when it is gone. Off Windows through a checked
        descriptor on the folder: a folder that is not the service's is not
        followed, and its files are not ours to delete."""
        try:
            if sys.platform == 'win32':
                os.remove(path)
            else:
                dir_fd = _open_session_dir()
                try:
                    os.unlink(os.path.basename(path), dir_fd=dir_fd)
                finally:
                    os.close(dir_fd)
        except FileNotFoundError:
            pass
        except acl_hardening.UntrustedDirectory as e:
            self._say(f"could not delete {os.path.basename(path)} ({type(e).__name__}: {e})")
            return False
        except OSError as e:
            self._say(f"could not delete {os.path.basename(path)} ({type(e).__name__}: {e})")
            return False
        return True

    def _set_due(self, when, epoch):
        """Set the next ask, unless a withdrawal since made it due at once."""
        with self._lock:
            if epoch == self._epoch:
                self._due_at = when

    def _say(self, message, level=logging.WARNING):
        """Log a state once, not on every pass that finds it unchanged."""
        if message != self._said:
            self._said = message
            logging.log(level, "fleet session: %s", message)
