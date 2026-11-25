"""
path_commands — the handler for `check_path`, the read-only question behind the
dashboard's path warning: is what was just saved in a process's path field on this
machine, and would the launcher take it? if not, where should browsing start?

a browser cannot see a machine's disk, so the dashboard asks after each save of a
changed field and warns on a `warning` in the answer. nothing here changes
anything, and the answer holds names and kinds only: no contents, no sizes.

this is the dashboard's one reader of a field's value. the desktop app has its own
for the same rules, because it probes the disk directly:
desktop/src/lib/missingPath.ts. both follow the launchers
(`OwletteService.launch_process_as_user` and `_validate_path` on windows,
`osadapter.posix._managed_command` and `_managed_cwd` elsewhere):

- `exe_path` and `cwd` are one path each. a launch target that isn't absolute
  warns, because no launcher searches PATH for it; a relative working directory is
  resolved at launch and isn't checked. a folder as a launch target and a file as a
  working directory are refused, except that a macos `.app` bundle launches as a
  folder. a symbolic link in either is refused on every os, whatever it points at.
- `file_path` is a file only if the whole value is one and a command line
  otherwise, so a value warns only when it starts like an absolute path and no cut
  of it is a file; plain arguments and relative paths are not checked. the whole
  value being a link is refused: always on windows, and elsewhere only when it
  points at a file.
- a value starting with two slashes on windows warns without a probe:
  `_validate_path` refuses it at launch, and touching a share a dashboard user named
  would send the agent's credentials there. a posix `//` is an ordinary path.

the type rides the fast command lane, so an install in flight doesn't hold it up
and it never runs on the main loop. a dead share or mount can hang a stat for
minutes, so the work runs on a daemon thread under a bound: past it the answer is
`unknown`. unreadable is always `unknown`, never `missing`.
"""

from __future__ import annotations

import json
import logging
import ntpath
import os
import posixpath
import re
import stat
import sys
import threading
from typing import Any, Callable

from command_router import CommandRouter

logger = logging.getLogger(__name__)

FILE = 'file'
FOLDER = 'folder'
MISSING = 'missing'
UNKNOWN = 'unknown'
# what the probe tells apart and an answer's status doesn't.
FILE_LINK = 'file-link'
FOLDER_LINK = 'folder-link'
BROKEN_LINK = 'broken-link'

# the warnings beyond missing, and FOLDER and FILE: a path of the wrong kind.
NOT_ABSOLUTE = 'not_absolute'
NETWORK = 'network'
# two slashes that aren't a share: `\\?\C:\x`, `\\.\pipe`, `//flag`, `\\server` alone.
REFUSED = 'refused'
LINK = 'link'

# `folder` lists one for the dashboard's folder browser; the others are process fields.
FIELDS = ('exe_path', 'file_path', 'cwd', 'folder')

BOUND_SECONDS = 3.0
# matches the web route's limit.
MAX_VALUE_CHARS = 1024
# how many whitespace cuts of a value are tried as a file with arguments after it.
MAX_CUTS = 8
MAX_ENTRIES = 200
# the answer lands in the machine's one `commands/completed` doc, and a doc tops
# out at 1 MiB, so this counts what a name costs there: utf-8 bytes, json-escaped.
# firebase_client keeps only the newest few answers; this and that make the bound.
MAX_LISTING_BYTES = 16 * 1024
# the listing, plus the path and its parent at 3 bytes a character, plus the keys.
MAX_ANSWER_BYTES = MAX_LISTING_BYTES + 2 * 3 * MAX_VALUE_CHARS + 512
# a probe wedged in the kernel keeps its thread until the mount answers, so wedged
# probes are capped; a machine out of slots answers unknown until they return.
MAX_IN_FLIGHT = 8

# windows' "not there" codes. python also maps ERROR_BAD_NETPATH and
# ERROR_BAD_NET_NAME to FileNotFoundError, and a dead share is not a missing file.
# path not found, file not found, invalid drive, a file where a folder should be.
_WINERRORS_NOT_THERE = frozenset({None, 2, 3, 15, 267})

_WINDOWS_ABSOLUTE = re.compile(r'^[a-zA-Z]:[\\/]')
_DOUBLE_SLASH = re.compile(r'^[\\/]{2}')
_CWD_DOUBLE_SLASH = re.compile(r'^(?:\\\\|//)')
# a server and a share; `\\?\` and `//flag` start the same way and are not network paths.
_NETWORK_PATH = re.compile(r'^[\\/]{2}[^\\/?.][^\\/]*[\\/]+[^\\/]')
_QUOTED = re.compile(r'^"([^"]+)"\s*(.*)$', re.DOTALL)
# a lone dash isn't a flag (`OneDrive - Acme` is a folder), nor is a piece with a
# slash in it (`show -v2/main.toe`). these and the next match desktop's splitArgs.
_WINDOWS_FLAG = re.compile(r'\s+(?:-{1,2}|/)[A-Za-z0-9_][^\s\\/=]*(?:=\S*)?(?=\s|$)')
_POSIX_FLAG = re.compile(r'\s+-{1,2}[A-Za-z0-9_][^\s/=]*(?:=\S*)?(?=\s|$)')
# the path ends at the last piece with a file extension; an extension has a letter,
# which tells it from `v1.2` and `127.0.0.1`.
_THROUGH_LAST_EXTENSION = re.compile(r'^.*\.[A-Za-z0-9_]*[A-Za-z][A-Za-z0-9_]*(?=\s|$)')
_APP_BUNDLE = re.compile(r'\.app/*$')

_LINK_TARGET = {FILE_LINK: FILE, FOLDER_LINK: FOLDER, BROKEN_LINK: MISSING}

_slots = threading.BoundedSemaphore(MAX_IN_FLIGHT)


def _this_system() -> str:
    if sys.platform == 'win32':
        return 'windows'
    return 'macos' if sys.platform == 'darwin' else 'linux'


def _answer(status: str, warning: str | None = None, path: str | None = None,
            rest: str = '', nearest: str | None = None) -> dict:
    return {'status': status, 'warning': warning, 'path': path, 'rest': rest, 'nearest': nearest}


def _stat(path: str) -> str:
    # lstat is what os.path.islink, the launchers' check, reads: a junction isn't a link.
    try:
        is_link = stat.S_ISLNK(os.lstat(path).st_mode)
    except (FileNotFoundError, NotADirectoryError) as e:
        return MISSING if getattr(e, 'winerror', None) in _WINERRORS_NOT_THERE else UNKNOWN
    except (OSError, ValueError):
        return UNKNOWN
    try:
        mode = os.stat(path).st_mode
    except (OSError, ValueError):
        # the launchers refuse a link wherever it points, so a dead target changes nothing.
        return BROKEN_LINK if is_link else UNKNOWN
    if stat.S_ISDIR(mode):
        return FOLDER_LINK if is_link else FOLDER
    if stat.S_ISREG(mode):
        return FILE_LINK if is_link else FILE
    return UNKNOWN


def _is_folder(entry: os.DirEntry) -> bool:
    try:
        return entry.is_dir()
    except OSError:
        return False


def _scan(path: str) -> dict:
    folders: list[str] = []
    files: list[str] = []
    used = 0
    truncated = False
    with os.scandir(path) as entries:
        for entry in entries:
            try:
                cost = len(json.dumps(entry.name, ensure_ascii=False).encode('utf-8')) + 1
            except UnicodeEncodeError:
                # a name that isn't valid unicode can't be stored, or picked.
                continue
            if len(folders) + len(files) >= MAX_ENTRIES or used + cost > MAX_LISTING_BYTES:
                truncated = True
                break
            used += cost
            (folders if _is_folder(entry) else files).append(entry.name)
    return {
        'folders': sorted(folders, key=str.casefold),
        'files': sorted(files, key=str.casefold),
        'truncated': truncated,
    }


def _refusal(value: str, field: str, system: str) -> str | None:
    """what the launcher refuses a value for before touching any disk: on windows, a
    value starting with two slashes, having turned every `/` into `\\` first in all
    but `cwd`. so `/\\x` is refused as a launch target and is only relative as a
    working directory. elsewhere `//x` is an ordinary path."""
    if system != 'windows':
        return None
    if not (_CWD_DOUBLE_SLASH if field == 'cwd' else _DOUBLE_SLASH).match(value):
        return None
    return NETWORK if _NETWORK_PATH.match(value) else REFUSED


def _is_absolute(path: str, system: str) -> bool:
    return bool(_WINDOWS_ABSOLUTE.match(path)) if system == 'windows' else path.startswith('/')


def _native(path: str, system: str) -> str:
    return ntpath.normpath(path) if system == 'windows' else posixpath.normpath(path)


def _parent(path: str, system: str) -> str | None:
    """the folder above a native path, or None at its root."""
    above = ntpath.dirname(path) if system == 'windows' else posixpath.dirname(path)
    return above if above != path else None


def _nearest_folder(path: str, system: str, probe: Callable[[str], str]) -> str | None:
    folder = _parent(_native(path, system), system)
    while folder is not None:
        status = probe(folder)
        if status in (FOLDER, FOLDER_LINK):
            return folder
        # whatever hangs or refuses here does the same on every level above it.
        if status == UNKNOWN:
            return None
        folder = _parent(folder, system)
    return None


def _report(path: str, rest: str, system: str, probe: Callable[[str], str]) -> dict:
    """a path the launcher doesn't refuse for what it is: only its absence warns."""
    status = probe(_native(path, system))
    status = _LINK_TARGET.get(status, status)
    if status != MISSING:
        return _answer(status, path=path, rest=rest)
    return _answer(MISSING, warning=MISSING, path=path, rest=rest,
                   nearest=_nearest_folder(path, system, probe))


def _split_arguments(value: str, system: str) -> tuple[str, str]:
    """the path and arguments to report for a value nothing on disk matched: up to
    the first flag, then to the last whitespace-separated piece with a file
    extension, so `Show v1.2 final.toe` stays whole and `gone.py 8000` doesn't."""
    flag = (_WINDOWS_FLAG if system == 'windows' else _POSIX_FLAG).search(value)
    head = value[:flag.start()] if flag else value
    last = _THROUGH_LAST_EXTENSION.match(head)
    end = last.end() if last else len(head)
    return value[:end], value[end:].strip()


def _file_candidates(value: str) -> list[str]:
    """the whole value, then its cuts at whitespace, longest first."""
    cuts = [cut.start() for cut in re.finditer(r'\s+', value)]
    return [value, *[value[:cut] for cut in reversed(cuts)][:MAX_CUTS]]


def _is_refused_link(status: str, system: str) -> bool:
    """whether the launcher refuses `file_path` being this link: off windows it only
    validates the field when os.path.isfile says it is one file to open."""
    return status in _LINK_TARGET if system == 'windows' else status == FILE_LINK


def _check_file_path(value: str, system: str, probe: Callable[[str], str]) -> dict:
    quoted = _QUOTED.match(value)
    path, rest = (quoted.group(1), quoted.group(2)) if quoted else _split_arguments(value, system)

    # the launcher checks the whole value, so a quoted share is only arguments to it.
    refused = _refusal(value, 'file_path', system)
    if refused:
        return _answer(UNKNOWN, warning=refused, path=path, rest=rest)
    # the launcher expands nothing, but a shell or the launch target may.
    if not _is_absolute(path, system) or re.search(r'[%$]', path):
        return _answer(UNKNOWN)

    if not quoted:
        for candidate in _file_candidates(value):
            if not _is_absolute(candidate, system):
                continue
            native = _native(candidate, system)
            status = probe(native)
            if candidate == value:
                if _is_refused_link(status, system):
                    return _answer(_LINK_TARGET[status], warning=LINK, path=value,
                                   nearest=_parent(native, system))
                # any other link is only text to the launcher.
                if status in _LINK_TARGET:
                    return _answer(UNKNOWN if status == BROKEN_LINK else _LINK_TARGET[status], path=value)
                if status == FOLDER:
                    return _answer(FOLDER, path=value)
            if status in (FILE, FILE_LINK):
                return _answer(FILE, path=candidate, rest=value[len(candidate):].strip())
            if status == UNKNOWN:
                return _answer(UNKNOWN, path=candidate)

    answer = _report(path, rest, system, probe)
    if system == 'windows' and answer['status'] == MISSING and answer['nearest'] is None:
        # nothing on the way up, so the agent can't see this drive. it may be mapped
        # in the user's session only, and this field reaches that session as text:
        # the launcher never needed the agent to see it.
        return _answer(UNKNOWN, path=path, rest=rest)
    return answer


def _check_folder(value: str, system: str, probe: Callable[[str], str],
                  scan: Callable[[str], dict]) -> dict:
    refused = _refusal(value, 'folder', system)
    if refused:
        return _answer(UNKNOWN, warning=refused, path=value)
    if not _is_absolute(value, system):
        return _answer(UNKNOWN)

    path = _native(value, system)
    answer = _report(path, '', system, probe)
    answer['warning'] = None
    answer['parent'] = _parent(path, system)
    if answer['status'] == FOLDER:
        try:
            answer.update(scan(path))
        except OSError:
            answer['status'] = UNKNOWN
    return answer


def _check_launch_field(field: str, value: str, system: str, probe: Callable[[str], str]) -> dict:
    refused = _refusal(value, field, system)
    if refused:
        return _answer(UNKNOWN, warning=refused, path=value)
    if not _is_absolute(value, system):
        return _answer(UNKNOWN, warning=None if field == 'cwd' else NOT_ABSOLUTE, path=value)

    native = _native(value, system)
    status = probe(native)
    if status in _LINK_TARGET:
        return _answer(_LINK_TARGET[status], warning=LINK, path=value, nearest=_parent(native, system))
    if status == MISSING:
        return _answer(MISSING, warning=MISSING, path=value, nearest=_nearest_folder(value, system, probe))
    if field == 'cwd' and status == FILE:
        return _answer(FILE, warning=FILE, path=value, nearest=_parent(native, system))
    launches_as_folder = system == 'macos' and _APP_BUNDLE.search(value)
    if field == 'exe_path' and status == FOLDER and not launches_as_folder:
        return _answer(FOLDER, warning=FOLDER, path=value, nearest=native)
    return _answer(status, path=value)


def check_path(field: str, value: str, system: str | None = None,
               probe: Callable[[str], str] = _stat,
               scan: Callable[[str], dict] = _scan) -> dict:
    """what a field's value means on this machine. unbounded: see run_bounded."""
    system = system or _this_system()
    value = value.strip()
    if field == 'file_path':
        return _check_file_path(value, system, probe)
    if field == 'folder':
        return _check_folder(value, system, probe, scan)
    return _check_launch_field(field, value, system, probe)


def run_bounded(field: str, value: str, bound: float = BOUND_SECONDS,
                check: Callable[[str, str], dict] = check_path) -> dict:
    """check_path under a time limit. the thread is a daemon, so a probe that never
    returns can't hold up the agent stopping, as a pool's worker would."""
    if not _slots.acquire(blocking=False):
        return _answer(UNKNOWN)
    slots = _slots
    answers: list[dict] = []

    def work() -> None:
        try:
            answers.append(check(field, value))
        except Exception as e:
            logger.warning(f"check_path failed: {type(e).__name__}")
        finally:
            slots.release()

    try:
        worker = threading.Thread(target=work, daemon=True, name='check-path')
        worker.start()
    except Exception:
        slots.release()
        raise
    worker.join(bound)
    return answers[0] if answers else _answer(UNKNOWN)


def handle_check_path(cmd_data: dict, cmd_id: str, service: Any) -> str:
    field = cmd_data.get('field')
    value = cmd_data.get('value')
    if field not in FIELDS:
        return "Error: check_path needs a field: exe_path, file_path, cwd or folder"
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_VALUE_CHARS:
        return f"Error: check_path needs a value of 1 to {MAX_VALUE_CHARS} characters"
    # not ascii-escaped: `\\uXXXX` would double what a non-latin name costs in the doc.
    return json.dumps(run_bounded(field, value), ensure_ascii=False)


def register_handlers(router: CommandRouter) -> None:
    """called once at OwletteService init, after the router is created."""
    router.register('check_path')(handle_check_path)
    logger.info("path_commands: registered handler — check_path")
