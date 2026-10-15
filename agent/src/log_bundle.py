"""
log_bundle — the zip a "submit issue" uploads with its screenshots or its logs.

The screenshots the desktop app staged in `ipc/issue-attachments/` go in first
(`screenshots/<n>.<ext>`), each re-checked as an image of at most 8 MB.
Without "attach logs" they and the manifest are all the zip holds. The logs are
these sources, nothing else:
  * every regular file under the data root's `logs/` tree (`logs/<path>`);
  * the data root's `tmp/status_writer.log*` (`tmp/<file>`);
  * the desktop app's and owlette swoop's own logs (`desktop/<file>`, `viewer/<file>`);
  * a listing of the data root, names, sizes and dates only (`system/data-root.txt`);
  * Windows: owlette's Inno Setup logs from this user's %TEMP% (`installer/<file>`)
    and the Application log's crash events for owlette's programs
    (`system/application-crashes.txt`);
  * macOS: crash reports for owlette's programs (`crash/<file>`) and the lines of
    the installer log that mention owlette (`system/install-owlette.txt`);
  * Linux: the systemd journals of the agent unit and the self-update unit
    (`system/journal-owlette-agent.txt`, `system/journal-owlette-update.txt`).

On macOS and Linux this runs as root and the per-user log folders are in the
console user's home, so a planted symlink or hard link there could pull
`.tokens.enc` or `/etc/shadow` into a zip that leaves the machine. Every file is
therefore opened without following links and checked on the descriptor: a
regular file with one link, and under root a per-user log must belong to the
console user, as must a staged screenshot. `logs/swoop` and `ipc/` are
group-writable, so the link checks apply to the data tree too, and on POSIX the
data root's folders are read by descriptor so a directory swapped for a link
after the listing cannot lead the walk out of them.

`manifest.txt` is written last and lists what went in and what was left out.
"""

from __future__ import annotations

import collections
import datetime
import logging
import os
import platform
import re
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from typing import Callable, NamedTuple, Optional, Sequence, Union

import installer_utils
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

# (app id, log file prefix, folder in the zip, name in the manifest) per app that logs per user
USER_APPS = (
    ('app.owlette.desktop', 'owlette-desktop', 'desktop', 'the desktop app'),
    ('app.owlette.swoop-viewer', 'owlette-swoop-viewer', 'viewer', 'owlette swoop'),
)
STATUS_WRITER_LOG = 'status_writer.log'

INSTALLER_LOGS_KEPT = 5
INSTALLER_LOG_HEAD_BYTES = 4096
# inno names every app's log alike and logs no app name, only the exe it ran: owlette's
# is built as Owlette-Installer-v<version>.exe (OutputBaseFilename in owlette_installer.iss)
OWLETTE_INSTALLER_PREFIX = b'owlette-installer'
_SETUP_EXE_LINE = re.compile(rb'Original Setup EXE:[ \t]*([^\r\n]+)')

COMMAND_TIMEOUT_SECONDS = 20
COMMAND_OUTPUT_CAP_BYTES = 20 * 1000 * 1000
JOURNAL_UNITS = ('owlette-agent', installer_utils.UPDATE_UNIT_NAME)
CRASH_QUERY = (
    "*[System[(Provider[@Name='Application Error'] or Provider[@Name='Windows Error Reporting'])"
    " and (EventID=1000 or EventID=1001)"
    f" and TimeCreated[timediff(@SystemTime) <= {MAX_AGE_SECONDS * 1000}]]]"
)
_OWLETTE_EXE = re.compile(
    r'(?<![\w.-])(owlette-desktop|owlette-swoop-viewer|owlette-host|owlette-swoop)\.exe',
    re.IGNORECASE)

CRASH_REPORT_DIR = '/Library/Logs/DiagnosticReports'
CRASH_REPORTS_KEPT = 10
# a python3 report counts only when its process path is under the install root,
# which an .ips names in its first lines
CRASH_REPORT_HEAD_BYTES = 4096
INSTALL_LOG_DIR = '/var/log'
INSTALL_LOG_CAP_BYTES = 5 * 1000 * 1000
# bounds the memory one runaway line costs; a longer line is read in pieces
INSTALL_LOG_LINE_BYTES = 64 * 1024

LISTING_CAP_BYTES = 2 * 1000 * 1000
# bundled runtimes: thousands of files that say little, so they are walked last
HEAVY_DIRS = frozenset({'python', 'node_modules', 'site-packages'})

_DIR_FLAGS = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)

# the desktop app's staging folder and limits (desktop/src-tauri/src/issue_attachments.rs)
SCREENSHOTS_DIR = 'ipc/issue-attachments'
MAX_SCREENSHOTS = 5
SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024
_SCREENSHOT_NAME = re.compile(r'[0-9a-f]{32}\.(?:png|jpg|webp)')
# room for a stored entry's headers when deciding whether a screenshot fits the cap
ENTRY_OVERHEAD_BYTES = 1024


class _Skip(Exception):
    """A source or file left out of the zip; the message is the manifest's reason."""


class _TimedOut(_Skip):
    """A command killed at its timeout, with what it wrote before then."""

    def __init__(self, message: str, tail: bytes, dropped: bool):
        super().__init__(message)
        self.tail = tail
        self.dropped = dropped


class _Candidate(NamedTuple):
    path: str
    arcname: str
    mtime: float
    owner_uid: Optional[int]
    # set when `path` is a name inside this open directory
    dir_fd: Optional[int] = None


def build_log_zip(dest_path: str, screenshots: Sequence[str] = (),
                  include_logs: bool = True) -> dict:
    """Write the issue zip to `dest_path` (created or truncated, mode 0600): the
    staged `screenshots` first, then the logs unless `include_logs` is False.

    Returns `{files, size, skipped, screenshots}`: the number of entries
    included besides the manifest, the zip's size in bytes, `(name, reason)`
    for everything left out, and how many screenshots went in.
    """
    skipped: list[tuple[str, str]] = []
    dir_fds: list[int] = []
    try:
        now = time.time()
        cutoff = now - MAX_AGE_SECONDS
        generated = []
        fresh = []
        if include_logs:
            generated = _generated_entries(skipped)
            # the small sources go in ahead of logs/: each is bounded on its own, and a
            # runaway logs/ tree would otherwise spend the budget and the cap before them
            fresh = (_fresh(_small_candidates(skipped, dir_fds, cutoff), cutoff, skipped)
                     + _fresh(_machine_candidates(skipped, dir_fds), cutoff, skipped))

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
                uncompressed = _add_screenshots(zf, out, screenshots, included, skipped)
                shots = len(included)
                for arcname, data, note in generated:
                    if out.tell() >= ARCHIVE_CAP_BYTES:
                        skipped.append((arcname, 'the zip reached its 50 MB cap'))
                    elif uncompressed + len(data) > UNCOMPRESSED_BUDGET_BYTES:
                        skipped.append((arcname, 'past the 300 MB uncompressed budget'))
                    else:
                        zf.writestr(arcname, data)
                        uncompressed += len(data)
                        included.append((arcname, len(data), now, note))
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

    logger.info(f"Built the issue zip: {len(included)} files ({shots} screenshots), "
                f"{size} bytes")
    return {'files': len(included), 'size': size, 'skipped': skipped, 'screenshots': shots}


def screenshot_ids(value) -> Optional[list[str]]:
    """`value` without repeats, in first-seen order, when it is a list of at
    most MAX_SCREENSHOTS staged screenshot names, else None. A name is joined
    onto the staging folder, so nothing else may pass."""
    if not isinstance(value, list) or len(value) > MAX_SCREENSHOTS:
        return None
    if not all(isinstance(name, str) and _SCREENSHOT_NAME.fullmatch(name) for name in value):
        return None
    return list(dict.fromkeys(value))


def _add_screenshots(zf: zipfile.ZipFile, out, ids: Sequence[str], included: list,
                     skipped: list) -> int:
    """Each staged screenshot as `screenshots/<n>.<ext>`, numbered in the order
    they go in; returns the bytes added.

    Stored whole or not at all: an image cut at the cap is no use, and images
    are compressed already. A screenshot that fails a check is a manifest line.
    """
    if not ids:
        return 0
    try:
        # under root on POSIX the desktop app wrote them as the console user
        owner_uid = None if os.name == 'nt' else _console_home()[1]
        directory = _screenshot_dir()
    except _Skip as e:
        skipped.extend((f'screenshot {name}', str(e)) for name in ids)
        return 0
    except OSError as e:
        skipped.extend((f'screenshot {name}', f'could not be opened: {e.strerror or e}')
                       for name in ids)
        return 0
    added = 0
    try:
        for name in ids:
            label = f'screenshot {name}'
            if not _SCREENSHOT_NAME.fullmatch(name):
                skipped.append((label, 'is not a staged screenshot name'))
                continue
            try:
                data, mtime = _read_screenshot(directory, name, owner_uid)
            except _Skip as e:
                skipped.append((label, str(e)))
                continue
            if out.tell() + len(data) + ENTRY_OVERHEAD_BYTES > ARCHIVE_CAP_BYTES:
                skipped.append((label, 'would pass the 50 MB zip cap'))
                continue
            arcname = f'screenshots/{len(included) + 1}.{_image_ext(data)}'
            zf.writestr(arcname, data, compress_type=zipfile.ZIP_STORED)
            included.append((arcname, len(data), mtime, ''))
            added += len(data)
    finally:
        if isinstance(directory, int):
            os.close(directory)
    return added


def _screenshot_dir() -> Union[str, int]:
    """The staging folder: a path on Windows, and on POSIX a descriptor opened
    without following a link, since `ipc/` is the group's to write."""
    path = os.path.join(_data_root(), SCREENSHOTS_DIR)
    return path if os.name == 'nt' else os.open(path, _DIR_FLAGS)


def _read_screenshot(directory: Union[str, int], name: str,
                     owner_uid: Optional[int]) -> tuple[bytes, float]:
    """One staged screenshot's bytes and mtime, once it has passed every check."""
    by_fd = isinstance(directory, int)
    src, info = _open_checked(name if by_fd else os.path.join(directory, name), owner_uid,
                              directory if by_fd else None)
    try:
        if info.st_size > SCREENSHOT_MAX_BYTES:
            raise _Skip('is larger than 8 MB')
        chunks = []
        read = 0
        while True:
            try:
                chunk = os.read(src, CHUNK_BYTES)
            except OSError as e:
                raise _Skip(f'could not be read: {e.strerror or e}')
            if not chunk:
                break
            read += len(chunk)
            if read > SCREENSHOT_MAX_BYTES:
                raise _Skip('is larger than 8 MB')
            chunks.append(chunk)
    finally:
        os.close(src)
    data = b''.join(chunks)
    if not _image_ext(data):
        raise _Skip('is not a png, jpeg or webp image')
    return data, info.st_mtime


def _image_ext(data: bytes) -> str:
    """The extension the magic bytes name, or '' for anything but png, jpeg or webp."""
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'jpg'
    if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    return ''


def discard_screenshots(ids: Sequence[str]) -> None:
    """Unlink each staged screenshot by its exact name; one already gone is fine."""
    try:
        directory = _screenshot_dir()
    except FileNotFoundError:
        return
    except OSError as e:
        logger.warning(f"Could not open the screenshot staging folder: {e.strerror or e}")
        return
    by_fd = isinstance(directory, int)
    try:
        for name in ids:
            if not _SCREENSHOT_NAME.fullmatch(name):
                continue
            try:
                os.unlink(name if by_fd else os.path.join(directory, name),
                          dir_fd=directory if by_fd else None)
            except FileNotFoundError:
                pass
            except OSError as e:
                logger.warning(f"Could not delete the staged screenshot {name}: "
                               f"{e.strerror or e}")
    finally:
        if by_fd:
            os.close(directory)


def _fresh(candidates: list[_Candidate], cutoff: float, skipped: list) -> list[_Candidate]:
    """`candidates` changed since `cutoff`, newest first; the rest go to `skipped`."""
    fresh = []
    for candidate in candidates:
        if candidate.mtime < cutoff:
            skipped.append((candidate.arcname, 'older than 14 days'))
        else:
            fresh.append(candidate)
    fresh.sort(key=lambda c: c.mtime, reverse=True)
    return fresh


def _data_root() -> str:
    return shared_utils.get_data_path()


def _install_root() -> str:
    return shared_utils.get_install_root()


def _temp_dir() -> str:
    return tempfile.gettempdir()


def _machine_candidates(skipped: list, dir_fds: list) -> list[_Candidate]:
    root = os.path.join(_data_root(), 'logs')
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


def _small_candidates(skipped: list, dir_fds: list, cutoff: float) -> list[_Candidate]:
    """The bounded file sources: status_writer, the per-user app logs, the setup
    logs and the crash reports."""
    out = _dir_candidates(
        os.path.join(_data_root(), 'tmp'), 'tmp',
        lambda name: name.startswith(STATUS_WRITER_LOG), skipped, dir_fds,
        missing='the data root has no tmp folder', by_fd=os.name != 'nt')
    for app_id, prefix, folder, label in USER_APPS:
        try:
            directory, owner_uid = _user_log_dir(app_id)
        except _Skip as e:
            skipped.append((f'{folder}/', str(e)))
            continue
        out += _dir_candidates(
            directory, folder,
            lambda name, prefix=prefix: name.startswith(prefix) and '.log' in name,
            skipped, dir_fds, missing=f'{label} has no log folder', owner_uid=owner_uid)
    if sys.platform == 'win32':
        out += _installer_candidates(skipped, dir_fds, cutoff)
    elif sys.platform == 'darwin':
        out += _crash_report_candidates(skipped, dir_fds, cutoff)
    return out


def _dir_candidates(directory: str, rel: str, wanted: Callable[[str], bool], skipped: list,
                    dir_fds: list, missing: str, owner_uid: Optional[int] = None,
                    by_fd: bool = False) -> list[_Candidate]:
    """The files directly in `directory` whose names pass `wanted`, as `rel/<name>`.

    With `by_fd` the folder is opened without following a link and its files
    are later opened relative to that descriptor, as `_walk` does on POSIX.
    """
    try:
        if by_fd:
            listed: Union[str, int] = os.open(directory, _DIR_FLAGS)
            dir_fds.append(listed)
        else:
            listed = directory
        with os.scandir(listed) as it:
            entries = sorted(it, key=lambda entry: entry.name)
    except FileNotFoundError:
        skipped.append((f'{rel}/', missing))
        return []
    except OSError as e:
        skipped.append((f'{rel}/', f'could not be listed: {e.strerror or e}'))
        return []
    out = []
    for entry in entries:
        if not wanted(entry.name):
            continue
        arcname = f'{rel}/{entry.name}'
        try:
            if _is_link(entry):
                skipped.append((arcname, 'is a link'))
            elif entry.is_file(follow_symlinks=False):
                mtime = entry.stat(follow_symlinks=False).st_mtime
                out.append(_Candidate(entry.path, arcname, mtime, owner_uid,
                                      listed if by_fd else None))
            else:
                skipped.append((arcname, 'is not a regular file'))
        except OSError as e:
            skipped.append((arcname, f'could not be read: {e.strerror or e}'))
    return out


def _user_log_dir(app_id: str) -> tuple[str, Optional[int]]:
    """A per-user app's log folder, and the uid its files must belong to.

    The uid is None unless this runs as root on POSIX: the Windows CLI runs as
    the console user and reads its own %LOCALAPPDATA%.
    """
    if sys.platform == 'win32':
        base = os.environ.get('LOCALAPPDATA')
        if not base:
            raise _Skip('LOCALAPPDATA is not set')
        return os.path.join(base, app_id, 'logs'), None

    home, owner_uid = _console_home()
    if sys.platform == 'darwin':
        return os.path.join(home, 'Library', 'Logs', app_id), owner_uid
    return os.path.join(home, '.local', 'share', app_id, 'logs'), owner_uid


def _console_home() -> tuple[str, Optional[int]]:
    """The POSIX console user's home, and the uid files there must belong to
    (None unless this runs as root)."""
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
    return account.pw_dir, account.pw_uid if os.geteuid() == 0 else None


def _installer_candidates(skipped: list, dir_fds: list, cutoff: float) -> list[_Candidate]:
    """Owlette's newest Inno Setup logs in this user's %TEMP%.

    Only a log from the last 14 days is opened to see whose it is, so years of
    other apps' setup logs cost one manifest line, not a read each.
    """
    found = _dir_candidates(
        _temp_dir(), 'installer',
        lambda name: name.startswith('Setup Log ') and name.endswith('.txt'),
        skipped, dir_fds, missing='the temp folder does not exist')
    old = [c for c in found if c.mtime < cutoff]
    if old:
        skipped.append(('installer/', f'{len(old)} setup logs older than 14 days'))
    owlette = []
    for candidate in sorted(found, key=lambda c: c.mtime, reverse=True):
        if candidate.mtime < cutoff:
            continue
        try:
            head = _read_head(candidate, INSTALLER_LOG_HEAD_BYTES)
        except _Skip as e:
            skipped.append((candidate.arcname, str(e)))
            continue
        if not _is_owlette_setup_log(head):
            skipped.append((candidate.arcname, "is another app's setup log"))
        elif len(owlette) >= INSTALLER_LOGS_KEPT:
            skipped.append((candidate.arcname, f'past the {INSTALLER_LOGS_KEPT} newest setup logs'))
        else:
            owlette.append(candidate)
    return owlette


def _is_owlette_setup_log(head: bytes) -> bool:
    """Whether the setup exe a log's head names is owlette's own installer.

    Only the exe's own name counts: a deployment's third-party installer runs
    from %TEMP%\\owlette_installers, so its path says owlette too.
    """
    match = _SETUP_EXE_LINE.search(head)
    if not match:
        return False
    exe = match.group(1).strip().strip(b'"').replace(b'/', b'\\').rsplit(b'\\', 1)[-1]
    return exe.lower().startswith(OWLETTE_INSTALLER_PREFIX)


def _crash_report_candidates(skipped: list, dir_fds: list, cutoff: float) -> list[_Candidate]:
    """The newest crash reports from the last 14 days for owlette's programs, from
    the system's DiagnosticReports and the console user's.

    A report counts when its name starts with owlette, or with python and its head
    names the install root: the agent runs on the bundled python3, and another
    app's python crashing is not ours to ship.
    """
    folders = [(CRASH_REPORT_DIR, None)]
    try:
        home, owner_uid = _console_home()
        folders.append((os.path.join(home, 'Library', 'Logs', 'DiagnosticReports'), owner_uid))
    except _Skip as e:
        skipped.append(("crash/ (the console user's reports)", str(e)))
    found = []
    for directory, owner_uid in folders:
        found += _dir_candidates(
            directory, 'crash', _is_crash_report_name, skipped, dir_fds,
            missing=f'{directory} does not exist', owner_uid=owner_uid,
            by_fd=os.name != 'nt')
    old = [c for c in found if c.mtime < cutoff]
    if old:
        skipped.append(('crash/', f'{len(old)} crash reports older than 14 days'))
    root = _install_root()
    # an .ips is json and escapes every slash in a path
    markers = (root.encode('utf-8'), root.replace('/', '\\/').encode('utf-8'))
    ours = []
    for candidate in sorted(found, key=lambda c: c.mtime, reverse=True):
        if candidate.mtime < cutoff:
            continue
        name = candidate.arcname.split('/', 1)[1]
        if any(c.arcname == candidate.arcname for c in ours):
            skipped.append((candidate.arcname, 'has the name of a newer report already in'))
            continue
        if not name.lower().startswith('owlette'):
            try:
                head = _read_head(candidate, CRASH_REPORT_HEAD_BYTES)
            except _Skip as e:
                skipped.append((candidate.arcname, str(e)))
                continue
            if not any(marker in head for marker in markers):
                skipped.append((candidate.arcname, "is another program's python"))
                continue
        if len(ours) >= CRASH_REPORTS_KEPT:
            skipped.append(
                (candidate.arcname, f'past the {CRASH_REPORTS_KEPT} newest crash reports'))
        else:
            ours.append(candidate)
    return ours


def _is_crash_report_name(name: str) -> bool:
    lowered = name.lower()
    return lowered.startswith(('owlette', 'python')) and lowered.endswith(('.ips', '.crash'))


def _read_head(candidate: _Candidate, size: int) -> bytes:
    """The first `size` bytes of a candidate, through the same checks as a copy."""
    fd, _ = _open_checked(candidate.path, candidate.owner_uid, candidate.dir_fd)
    try:
        return os.read(fd, size)
    except OSError as e:
        raise _Skip(f'could not be read: {e.strerror or e}')
    finally:
        os.close(fd)


def _generated_entries(skipped: list) -> list[tuple[str, bytes, str]]:
    """The entries written from a listing or a command rather than copied from a file."""
    sources: list[tuple[str, Callable[[], tuple[bytes, str]]]] = [
        ('system/data-root.txt', _data_root_listing)]
    if sys.platform == 'win32':
        sources.append(('system/application-crashes.txt', _crash_events))
    elif sys.platform == 'darwin':
        sources.append(('system/install-owlette.txt', lambda: _install_log_lines(skipped)))
    elif sys.platform.startswith('linux'):
        sources += [(f'system/journal-{unit}.txt', lambda unit=unit: _journal(unit))
                    for unit in JOURNAL_UNITS]
    out = []
    for arcname, produce in sources:
        try:
            data, note = produce()
        except _Skip as e:
            skipped.append((arcname, str(e)))
        except OSError as e:
            skipped.append((arcname, f'could not be read: {e.strerror or e}'))
        else:
            out.append((arcname, data, note))
    return out


def _data_root_listing() -> tuple[bytes, str]:
    """Every entry under the data root, and on POSIX under the install root when it
    sits elsewhere, as path, size and modified time: names only, never contents,
    and no link followed. Cut at LISTING_CAP_BYTES."""
    roots = [_data_root()]
    install = _install_root()
    if os.name != 'nt' and not _within(install, roots[0]):
        roots.append(install)
    lines = []
    used = 0
    for root in roots:
        for line in [f'== {root}', *_tree_lines(root)]:
            used += len(line.encode('utf-8', 'backslashreplace')) + 1
            if used > LISTING_CAP_BYTES:
                note = 'cut short at the 2 MB listing cap'
                lines.append(f'({note})')
                return _text(lines), note
            lines.append(line)
    return _text(lines), ''


def _tree_lines(root: str):
    """A line per entry under `root`, one folder's entries at a time, HEAVY_DIRS last.

    On POSIX each folder is reached from `root` a name at a time without
    following a link, so a folder swapped for one cannot lead the listing out.
    """
    pending = ['']
    heavy = []
    while pending or heavy:
        rel = pending.pop() if pending else heavy.pop(0)
        fd = None
        try:
            if os.name != 'nt':
                fd = _open_dir(root, rel)
            with os.scandir(os.path.join(root, rel) if fd is None else fd) as it:
                entries = sorted(it, key=lambda entry: entry.name)
            subdirs = []
            for entry in entries:
                name = f'{rel}/{entry.name}' if rel else entry.name
                try:
                    info = entry.stat(follow_symlinks=False)
                    if _is_link(entry):
                        line = f'{name}  link'
                    elif entry.is_dir(follow_symlinks=False):
                        line = f'{name}/'
                        (heavy if entry.name in HEAVY_DIRS else subdirs).append(name)
                    elif entry.is_file(follow_symlinks=False):
                        line = f'{name}  {info.st_size} bytes  modified {_iso(info.st_mtime)}'
                    else:
                        line = f'{name}  not a regular file'
                except OSError as e:
                    line = f'{name}  could not be read: {e.strerror or e}'
                yield line
            pending.extend(reversed(subdirs))
        except OSError as e:
            yield f'{rel or "."}/  could not be listed: {e.strerror or e}'
        finally:
            if fd is not None:
                os.close(fd)


def _open_dir(root: str, rel: str) -> int:
    """`rel` under `root`, opened one name at a time without following a link."""
    fd = os.open(root, _DIR_FLAGS)
    for part in rel.split('/') if rel else []:
        try:
            child = os.open(part, _DIR_FLAGS, dir_fd=fd)
        finally:
            os.close(fd)
        fd = child
    return fd


def _within(path: str, root: str) -> bool:
    try:
        root = os.path.realpath(root)
        return os.path.commonpath([os.path.realpath(path), root]) == root
    except ValueError:
        return False


def _text(lines: list[str]) -> bytes:
    return ('\n'.join(lines) + '\n').encode('utf-8', 'backslashreplace')


def _journal(unit: str) -> tuple[bytes, str]:
    """`unit`'s journal for the last 14 days. A unit that never ran gives
    journalctl's own "no entries" line."""
    notes = []
    try:
        data, dropped = _run(
            ['journalctl', '-u', f'{unit}.service', '--since', '14 days ago', '--no-pager',
             '-o', 'short-iso'],
            COMMAND_TIMEOUT_SECONDS, COMMAND_OUTPUT_CAP_BYTES)
    except _TimedOut as e:
        # the kill lands mid-line; end at the last whole one
        data, dropped = e.tail[:e.tail.rfind(b'\n') + 1], e.dropped
        notes.append('cut at the 20 s limit')
    if dropped:
        # the cap's cut lands mid-line; start at the first whole one
        data = data[data.find(b'\n') + 1:]
        notes.insert(0, 'oldest lines cut at the 20 MB cap')
    return data, '; '.join(notes)


def _install_log_lines(skipped: list) -> tuple[bytes, str]:
    """The lines of macOS's installer logs that mention owlette, oldest first,
    the newest kept under INSTALL_LOG_CAP_BYTES.

    The log is system-wide and records every app's installs, so no other line
    leaves the machine. Rotated logs are read only when plain text.
    """
    try:
        with os.scandir(INSTALL_LOG_DIR) as it:
            logs = [(entry.stat(follow_symlinks=False).st_mtime, entry.name) for entry in it
                    if entry.name == 'install.log'
                    or (entry.name.startswith('install.log.')
                        and not entry.name.endswith(('.gz', '.bz2')))]
    except OSError as e:
        raise _Skip(f'{INSTALL_LOG_DIR} could not be listed: {e.strerror or e}')
    if not logs:
        raise _Skip(f'{INSTALL_LOG_DIR} has no install.log')
    kept: collections.deque = collections.deque()
    used = 0
    dropped = False
    read = 0
    for _, name in sorted(logs):
        try:
            fd = _open_checked(os.path.join(INSTALL_LOG_DIR, name), None)[0]
        except _Skip as e:
            skipped.append((f'system/install-owlette.txt from {name}', str(e)))
            continue
        read += 1
        with os.fdopen(fd, 'rb') as f:
            for line in iter(lambda: f.readline(INSTALL_LOG_LINE_BYTES), b''):
                if b'owlette' not in line.lower():
                    continue
                if not line.endswith(b'\n'):
                    line += b'\n'
                kept.append(line)
                used += len(line)
                while used > INSTALL_LOG_CAP_BYTES:
                    used -= len(kept.popleft())
                    dropped = True
    if not read:
        raise _Skip('no install.log could be read')
    note = 'oldest lines cut at the 5 MB cap' if dropped else ''
    return b''.join(kept), note


def _crash_events() -> tuple[bytes, str]:
    """The Application log's crash events from the last 14 days that name one of
    owlette's programs. python.exe and pythonw.exe count only from the install's
    own python folder: another app's python crashing is not ours to ship."""
    data, dropped = _run(
        ['wevtutil', 'qe', 'Application', f'/q:{CRASH_QUERY}', '/f:text'],
        COMMAND_TIMEOUT_SECONDS, COMMAND_OUTPUT_CAP_BYTES)
    text = data.decode('utf-8', 'replace').replace('\x00', '')
    events = [e for e in re.split(r'(?m)^(?=Event\[\d+\])', text) if e.startswith('Event[')]
    python_dir = os.path.join(_install_root(), 'python').lower() + os.sep
    ours = [e for e in events
            if _OWLETTE_EXE.search(e)
            or python_dir + 'python.exe' in e.lower()
            or python_dir + 'pythonw.exe' in e.lower()]
    note = 'oldest events cut at the 20 MB cap' if dropped else ''
    header = (f'application log crash events naming owlette programs, last 14 days, '
              f'oldest first: {len(ours)} of {len(events)} read\n\n')
    return (header + ''.join(ours)).encode('utf-8', 'backslashreplace'), note


def _run(argv: list[str], timeout: float, cap: int) -> tuple[bytes, bool]:
    """The last `cap` bytes `argv` writes to stdout, and whether any were dropped.

    Read as it streams, so a runaway command costs `cap` of memory rather than
    its whole output. A timer kills a command still running after `timeout`
    seconds. Raises _Skip when the command is missing or fails, and _TimedOut,
    carrying the output so far, when it times out.
    """
    try:
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except FileNotFoundError:
        raise _Skip(f'{argv[0]} is not installed')
    except OSError as e:
        raise _Skip(f'{argv[0]} could not be run: {e.strerror or e}')
    timed_out = threading.Event()

    def stop():
        if proc.poll() is None:
            timed_out.set()
            proc.kill()

    timer = threading.Timer(timeout, stop)
    timer.start()
    tail = bytearray()
    dropped = False
    try:
        with proc.stdout:
            for chunk in iter(lambda: proc.stdout.read(CHUNK_BYTES), b''):
                tail += chunk
                if len(tail) > cap:
                    del tail[:len(tail) - cap]
                    dropped = True
        code = proc.wait()
    finally:
        timer.cancel()
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    if timed_out.is_set():
        raise _TimedOut(f'{argv[0]} ran past {timeout:g} s', bytes(tail), dropped)
    if code != 0:
        raise _Skip(f'{argv[0]} exited with code {code}')
    return bytes(tail), dropped


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
