"""
log_bundle — the zip of logs a "submit issue" with "attach logs" uploads.

Two sources, nothing else:
  * every regular file under the data root's `logs/` tree (`logs/<path>`);
  * the desktop app's own `owlette-desktop*.log` files (`desktop/<file>`).

On macOS and Linux this runs as root and the desktop folder is in the console
user's home, so a planted symlink or hard link there could pull `.tokens.enc`
or `/etc/shadow` into a zip that leaves the machine. Every file is therefore
opened without following links and checked on the descriptor: a regular file
with one link, and under root a desktop log must belong to the console user.
`logs/swoop` is group-writable, so the link checks apply to the data tree too,
and on POSIX that tree is walked by descriptor so a directory swapped for a
link after the listing cannot lead the walk out of `logs/`.

`manifest.txt` is written last and lists what went in and what was left out.
"""

from __future__ import annotations

import datetime
import logging
import os
import platform
import socket
import stat
import sys
import time
import zipfile
from typing import NamedTuple, Optional, Union

import osadapter
import shared_utils

logger = logging.getLogger(__name__)

# a support case is about the last fortnight; older logs only add size
MAX_AGE_SECONDS = 14 * 24 * 3600
# bounds the read and the deflate time on a box with a runaway log
UNCOMPRESSED_BUDGET_BYTES = 300 * 1000 * 1000
# decimal mb keeps the zip under the upload route's 50 MiB limit with room for the manifest
ARCHIVE_CAP_BYTES = 50 * 1000 * 1000
# deflate's middle ground: logs compress well and level 9 buys little for its cpu
COMPRESS_LEVEL = 6
# the cap is checked per chunk, so this is also the most one entry overshoots it
CHUNK_BYTES = 1024 * 1024

DESKTOP_APP_ID = 'app.owlette.desktop'
DESKTOP_LOG_PREFIX = 'owlette-desktop'

_DIR_FLAGS = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)


class _Skip(Exception):
    """A source or file left out of the zip; the message is the manifest's reason."""


class _Candidate(NamedTuple):
    path: str
    arcname: str
    mtime: float
    owner_uid: Optional[int]
    # set when `path` is a name inside this open directory
    dir_fd: Optional[int] = None


def build_log_zip(dest_path: str) -> dict:
    """Write the log zip to `dest_path` (created or truncated, mode 0600).

    Returns `{files, size, skipped}`: the number of log files included, the
    zip's size in bytes, and `(name, reason)` for everything left out.
    """
    skipped: list[tuple[str, str]] = []
    dir_fds: list[int] = []
    try:
        candidates = _machine_candidates(skipped, dir_fds) + _desktop_candidates(skipped)

        cutoff = time.time() - MAX_AGE_SECONDS
        fresh = []
        for candidate in candidates:
            if candidate.mtime < cutoff:
                skipped.append((candidate.arcname, 'older than 14 days'))
            else:
                fresh.append(candidate)
        fresh.sort(key=lambda c: c.mtime, reverse=True)

        included = []
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_BINARY', 0)
        if os.name != 'nt':
            flags |= os.O_NOFOLLOW
        fd = os.open(dest_path, flags, 0o600)
        if hasattr(os, 'fchmod'):
            # an existing file keeps its mode through O_CREAT
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as out:
            with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED,
                                 compresslevel=COMPRESS_LEVEL) as zf:
                uncompressed = 0
                for candidate in fresh:
                    if out.tell() >= ARCHIVE_CAP_BYTES:
                        skipped.append((candidate.arcname, 'the zip reached its 50 MB cap'))
                        continue
                    try:
                        src, info = _open_checked(
                            candidate.path, candidate.owner_uid, candidate.dir_fd)
                    except _Skip as e:
                        skipped.append((candidate.arcname, str(e)))
                        continue
                    try:
                        if uncompressed + info.st_size > UNCOMPRESSED_BUDGET_BYTES:
                            skipped.append(
                                (candidate.arcname, 'past the 300 MB uncompressed budget'))
                            continue
                        written, note = _copy(src, info.st_size, zf, candidate.arcname, out)
                    finally:
                        os.close(src)
                    uncompressed += written
                    included.append((candidate.arcname, written, info.st_mtime, note))
                zf.writestr('manifest.txt', _manifest(included, skipped))
            size = out.tell()
    finally:
        for dir_fd in dir_fds:
            os.close(dir_fd)

    logger.info(f"Built the issue log zip: {len(included)} files, {size} bytes")
    return {'files': len(included), 'size': size, 'skipped': skipped}


def _machine_logs_dir() -> str:
    return shared_utils.get_data_path('logs')


def _machine_candidates(skipped: list, dir_fds: list) -> list[_Candidate]:
    root = _machine_logs_dir()
    out: list[_Candidate] = []
    try:
        if os.name == 'nt':
            _walk(root, 'logs', out, skipped, dir_fds)
        else:
            fd = os.open(root, _DIR_FLAGS)
            dir_fds.append(fd)
            _walk(fd, 'logs', out, skipped, dir_fds)
    except OSError as e:
        skipped.append(('logs/', f'could not be listed: {e.strerror or e}'))
    return out


def _walk(directory: Union[str, int], rel: str, out: list, skipped: list,
          dir_fds: list) -> None:
    """List `directory` into `out`, recursing into real subdirectories.

    On POSIX `directory` is a descriptor and each child is opened relative to
    it without following links: a directory swapped for a symlink between the
    listing and the open fails the open instead of being followed. Windows has
    no dir_fd, so there it is a path and the junction check is the guard.
    """
    by_fd = isinstance(directory, int)
    with os.scandir(directory) as it:
        entries = sorted(it, key=lambda entry: entry.name)
    for entry in entries:
        arcname = f'{rel}/{entry.name}'
        try:
            if _is_link(entry):
                skipped.append((arcname, 'is a link'))
            elif entry.is_dir(follow_symlinks=False):
                if by_fd:
                    child = os.open(entry.name, _DIR_FLAGS, dir_fd=directory)
                    dir_fds.append(child)
                else:
                    child = entry.path
                _walk(child, arcname, out, skipped, dir_fds)
            elif entry.is_file(follow_symlinks=False):
                mtime = entry.stat(follow_symlinks=False).st_mtime
                out.append(_Candidate(entry.path, arcname, mtime, None,
                                      directory if by_fd else None))
            else:
                skipped.append((arcname, 'is not a regular file'))
        except OSError as e:
            skipped.append((arcname, f'could not be read: {e.strerror or e}'))


def _is_link(entry: os.DirEntry) -> bool:
    if entry.is_symlink():
        return True
    # a windows junction is not a symlink to is_symlink(), only a reparse point
    attributes = getattr(entry.stat(follow_symlinks=False), 'st_file_attributes', 0)
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _desktop_candidates(skipped: list) -> list[_Candidate]:
    try:
        directory, owner_uid = _desktop_source()
        with os.scandir(directory) as it:
            entries = sorted(it, key=lambda entry: entry.name)
    except _Skip as e:
        skipped.append(('desktop/', str(e)))
        return []
    except FileNotFoundError:
        skipped.append(('desktop/', 'the desktop app has no log folder'))
        return []
    except OSError as e:
        skipped.append(('desktop/', f'could not be listed: {e.strerror or e}'))
        return []
    out = []
    for entry in entries:
        if not (entry.name.startswith(DESKTOP_LOG_PREFIX) and '.log' in entry.name):
            continue
        arcname = f'desktop/{entry.name}'
        try:
            if _is_link(entry):
                skipped.append((arcname, 'is a link'))
            elif entry.is_file(follow_symlinks=False):
                mtime = entry.stat(follow_symlinks=False).st_mtime
                out.append(_Candidate(entry.path, arcname, mtime, owner_uid))
            else:
                skipped.append((arcname, 'is not a regular file'))
        except OSError as e:
            skipped.append((arcname, f'could not be read: {e.strerror or e}'))
    return out


def _desktop_source() -> tuple[str, Optional[int]]:
    """The desktop app's log folder, and the uid its files must belong to.

    The uid is None unless this runs as root on POSIX: the Windows CLI runs as
    the console user and reads its own %LOCALAPPDATA%.
    """
    if sys.platform == 'win32':
        base = os.environ.get('LOCALAPPDATA')
        if not base:
            raise _Skip('LOCALAPPDATA is not set')
        return os.path.join(base, DESKTOP_APP_ID, 'logs'), None

    import pwd

    try:
        user = osadapter.console_user()
    except Exception as e:
        raise _Skip(f'the console user could not be resolved: {e}')
    if not user:
        raise _Skip('nobody is at a graphical session')
    try:
        account = pwd.getpwnam(user)
    except KeyError:
        raise _Skip(f'the console user {user!r} has no account of its own')
    if sys.platform == 'darwin':
        directory = os.path.join(account.pw_dir, 'Library', 'Logs', DESKTOP_APP_ID)
    else:
        directory = os.path.join(account.pw_dir, '.local', 'share', DESKTOP_APP_ID, 'logs')
    owner_uid = account.pw_uid if os.geteuid() == 0 else None
    return directory, owner_uid


def _open_checked(path: str, owner_uid: Optional[int],
                  dir_fd: Optional[int] = None) -> tuple[int, os.stat_result]:
    """A read descriptor on `path` (relative to `dir_fd` when set) and its fstat,
    once it has passed every check.

    The checks run on the descriptor, so a file swapped after the listing is
    still caught. O_NONBLOCK keeps a planted fifo from hanging the open.
    """
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0)
    if os.name != 'nt':
        flags |= os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        fd = os.open(path, flags, dir_fd=dir_fd)
    except OSError as e:
        raise _Skip(f'could not be opened: {e.strerror or e}')
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise _Skip('is not a regular file')
        if info.st_nlink != 1:
            raise _Skip(f'has {info.st_nlink} hard links')
        if owner_uid is not None and info.st_uid != owner_uid:
            raise _Skip(f'is owned by uid {info.st_uid}, not the console user')
    except BaseException:
        os.close(fd)
        raise
    return fd, info


def _copy(src: int, size: int, zf: zipfile.ZipFile, arcname: str, out) -> tuple[int, str]:
    """Copy up to `size` bytes of `src` into the entry `arcname`.

    Returns the bytes copied and a manifest note when the entry is short: a
    live log keeps growing, so `size` is the length at fstat and no more.
    """
    written = 0
    note = ''
    with zf.open(arcname, 'w') as entry:
        while written < size:
            try:
                chunk = os.read(src, min(CHUNK_BYTES, size - written))
            except OSError as e:
                note = f'read stopped: {e.strerror or e}'
                break
            if not chunk:
                break
            entry.write(chunk)
            written += len(chunk)
            if out.tell() >= ARCHIVE_CAP_BYTES and written < size:
                note = 'cut short at the 50 MB zip cap'
                break
    return written, note


def _manifest(included: list, skipped: list) -> str:
    lines = [
        f'owlette agent {shared_utils.APP_VERSION}',
        f'platform: {platform.platform()} ({sys.platform})',
        f'hostname: {socket.gethostname()}',
        f'created: {_iso(time.time())}',
        '',
        f'included ({len(included)}):',
    ]
    for arcname, size, mtime, note in included:
        line = f'  {arcname}  {size} bytes  modified {_iso(mtime)}'
        lines.append(f'{line}  ({note})' if note else line)
    lines += ['', f'skipped ({len(skipped)}):']
    lines += [f'  {name}  {reason}' for name, reason in skipped]
    return '\n'.join(lines) + '\n'


def _iso(timestamp: float) -> str:
    return datetime.datetime.fromtimestamp(
        timestamp, datetime.timezone.utc).isoformat(timespec='seconds')
