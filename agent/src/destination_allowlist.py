"""
destination_allowlist — where roost may write extracted files on this machine.

The agent runs as SYSTEM (root on POSIX), so a customer-controlled extract_path
could otherwise overwrite C:\\Windows\\System32 or /usr/bin. FAIL-CLOSED: an empty
or missing allowlist allows nothing.

- Roots are absolute and realpath-resolved (not startswith on the literal path),
  which defeats symlink/junction reparse-point escapes.
- Windows: reparse points are detected via FILE_ATTRIBUTE_REPARSE_POINT, not
  is_symlink() — junctions need no SeCreateSymbolicLinkPrivilege and are the more
  common attacker primitive (cve-2022-21658, cve-2025-4330).
- Windows: comparison is case-folded; NTFS is case-insensitive and a casing
  mismatch must not false-reject.
- POSIX: `~` resolves through the console user, never the root daemon's own
  home, and is refused outright when nobody is at the machine; the per-OS
  system-path sets are compared after resolve(), so a symlinked `/etc` arrives
  as `/private/etc` on macOS.

Out of scope: network/auth (upstream), chunk verification and extracted-file ACLs
(sync_assembler). Consumed by sync_assembler during the atomic rename.
"""

from __future__ import annotations

import logging
import os
import stat
import sys
import time
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)


def _os_family() -> str:
    """'windows' | 'macos' | 'linux' — this module's one read of the platform.

    Every OS-specific branch below goes through it, so a test can drive the
    POSIX arms from any host.
    """
    if sys.platform == 'win32':
        return 'windows'
    if sys.platform == 'darwin':
        return 'macos'
    return 'linux'


# Applied when config carries no explicit roots. `~` goes through
# `_safe_expanduser`, never os.path.expanduser: under LocalSystem the stdlib
# expands to C:\Windows\System32\config\systemprofile, which _is_dangerous_root
# rejects, and under the root daemon to /root (/var/root on macOS), which is
# refused before it can be resolved at all.
# Windows: `~/Documents`, not `~/Documents/Owlette`, so a relative extract path
# like "projects/show1" lands directly under Documents; the empty-field fallback
# still nests under `Owlette` (see the web-side `resolveExtractPath`).
# POSIX: a fixed directory the installer creates, outside every TCC-protected
# folder and outside every home — the daemon's own `~` is somewhere the kiosk
# user cannot read.
_DEFAULT_ROOTS_BY_OS: Dict[str, List[str]] = {
    'windows': ['~/Documents'],
    'macos': ['/Users/Shared/Owlette'],
    'linux': ['/var/lib/owlette/projects'],
}


def default_roots(os_family: Optional[str] = None) -> List[str]:
    """The roots applied when config carries no `allowed_extract_roots`."""
    return list(_DEFAULT_ROOTS_BY_OS[os_family or _os_family()])


# Last resort under SYSTEM with no identifiable interactive profile: writable by
# SYSTEM, visible to every user, not under System32.
_WINDOWS_SYSTEM_FALLBACK_HOME = r'C:\Users\Public'

# Never treated as the interactive user when scanning C:\Users\ (case-folded).
_WINDOWS_PROFILE_EXCLUDES = frozenset({
    'public', 'default', 'default user', 'defaultappgroup',
    'all users', 'systemprofile', 'networkservice', 'localservice',
})

# Memoised: the logged-in user doesn't change across a service run on a kiosk, so
# skip the registry + filesystem scan on every expansion.
_cached_interactive_home_sentinel = object()  # distinguish "not cached" from "cached None"
_cached_interactive_home_state: Any = _cached_interactive_home_sentinel


def _running_as_system() -> bool:
    """True when the current process is the Windows LocalSystem account."""
    if _os_family() != 'windows':
        return False
    # USERPROFILE, not USERNAME — a real user named 'SYSTEM' would false-positive.
    profile = os.environ.get('USERPROFILE', '')
    return 'system32' in profile.lower() and 'systemprofile' in profile.lower()


def _resolve_interactive_home() -> Optional[str]:
    """
    The profile dir an operator expects `~` to mean on a kiosk/signage box.

      1. HKLM\\…\\Winlogon\\DefaultUserName — kiosks run auto-login, so this is
         authoritative when present.
      2. Most-recently-modified non-system profile under C:\\Users\\.

    None when nothing usable is found (caller falls back to C:\\Users\\Public).
    Never raises.
    """
    if _os_family() != 'windows':
        return None

    # 1. auto-login default user
    try:
        import winreg
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r'SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon',
        ) as k:
            try:
                name, _ = winreg.QueryValueEx(k, 'DefaultUserName')
                if isinstance(name, str) and name.strip():
                    # DefaultUserName may be `DOMAIN\user`.
                    bare = name.strip().split('\\')[-1]
                    candidate = Path('C:/Users') / bare
                    if candidate.is_dir():
                        resolved = str(candidate)
                        logger.info(
                            f"destination_allowlist: resolved `~` via auto-login "
                            f"DefaultUserName → {resolved}"
                        )
                        return resolved
            except FileNotFoundError:
                pass  # key exists but no DefaultUserName value
    except (OSError, ImportError):
        pass

    # 2. most recently modified non-system profile under C:\Users\
    try:
        users_dir = Path('C:/Users')
        best: Optional[tuple] = None  # (mtime, path)
        for entry in users_dir.iterdir():
            if not entry.is_dir():
                continue
            if entry.name.lower() in _WINDOWS_PROFILE_EXCLUDES:
                continue
            try:
                mtime = entry.stat().st_mtime
            except OSError:
                continue
            if best is None or mtime > best[0]:
                best = (mtime, str(entry))
        if best is not None:
            logger.info(
                f"destination_allowlist: resolved `~` via most-recent-profile → {best[1]}"
            )
            return best[1]
    except OSError:
        pass

    return None


def get_interactive_username() -> Optional[str]:
    """
    The detected interactive username (the `admin` in `C:\\Users\\admin`).

    The assembler adds it to file DACLs so extracted files are readable from the
    user's desktop session. None on non-Windows, when not running as LocalSystem,
    or when no interactive user was found — callers then add no user ACE.
    """
    if not _running_as_system():
        return None
    home = _get_interactive_home()
    if home == _WINDOWS_SYSTEM_FALLBACK_HOME:
        return None
    # Profile dir name == username; DOMAIN\user still resolves to C:\Users\user,
    # which is what LookupAccountName wants.
    return Path(home).name or None


def get_interactive_user_ids() -> Optional[Tuple[int, int]]:
    """
    (uid, gid) the assembler gives extracted files on POSIX, so the kiosk user
    can read what the root daemon wrote.

    None on Windows, where ownership is expressed as a DACL instead
    (`sync_assembler._harden_acl`), None when this process is not root — it
    already owns what it writes — and None when the console user cannot be
    resolved, leaving the files root-owned rather than guessing an account.
    """
    if not _running_as_root():
        return None
    entry = _console_user_passwd()
    if entry is None:
        return None
    return entry.pw_uid, entry.pw_gid


def _get_interactive_home() -> str:
    """Memoised wrapper around `_resolve_interactive_home` + fallback."""
    global _cached_interactive_home_state
    if _cached_interactive_home_state is _cached_interactive_home_sentinel:
        resolved = _resolve_interactive_home()
        if resolved is None:
            logger.warning(
                f"destination_allowlist: could not identify an interactive user "
                f"under C:\\Users\\ — falling back to {_WINDOWS_SYSTEM_FALLBACK_HOME!r}. "
                f"Files will be visible to every user but not under any specific "
                f"user's Documents."
            )
            resolved = _WINDOWS_SYSTEM_FALLBACK_HOME
        _cached_interactive_home_state = resolved
    return _cached_interactive_home_state


class UnresolvableHomeError(ValueError):
    """`~` under a privileged agent with nobody at the machine.

    Expanding it would hand back the daemon's own home — /root, or /var/root on
    macOS — which is never where the operator meant their files to go and which
    they cannot even read, so the path is refused instead of quietly redirected.
    """


def _safe_expanduser(path: str) -> str:
    """
    os.path.expanduser, except that a privileged agent's `~` means the human at
    the machine and not the account the agent runs as: the stdlib expands it to
    C:\\Windows\\System32\\config\\systemprofile under LocalSystem and to /root
    (/var/root on macOS) under the root daemon, none of which the operator can
    see. Raises UnresolvableHomeError when the agent is privileged and there is
    no interactive session for a bare `~` to stand for. Everything else is
    stdlib behaviour, including substituting only a leading `~`.
    """
    if not path:
        return path
    # Every target path validated during a sync comes through here, and
    # `_privileged_home` costs a console-user lookup on POSIX. Anything
    # without a leading `~` is what the stdlib would hand back unchanged.
    if not path.startswith('~'):
        return path
    # `~user/...` names its own account, which pwd resolves whoever is at the
    # machine: only the bare form means "the human here". The stdlib leaves it
    # unchanged when `user` doesn't exist — desired.
    if not (path == '~' or path.startswith('~/') or path.startswith('~\\')):
        return os.path.expanduser(path)
    home = _privileged_home()
    if home is None:
        return os.path.expanduser(path)
    return home if path == '~' else home + path[1:]


def _privileged_home() -> Optional[str]:
    """
    The home `~` must mean while the agent runs privileged, or None when the
    stdlib answer is already right because the process is its own user.

    Raises UnresolvableHomeError under the root daemon with no console user:
    there is no interactive session, so there is no home `~` could honestly
    stand for, and the daemon's own is not an answer.
    """
    if _os_family() == 'windows':
        return _get_interactive_home() if _running_as_system() else None
    if not _running_as_root():
        return None
    entry = _console_user_passwd()
    if entry is None:
        raise UnresolvableHomeError(
            "'~' cannot be resolved: the agent is running as root and nobody is "
            "signed in at this machine"
        )
    return entry.pw_dir


def _running_as_root() -> bool:
    """True when this POSIX process is root — the daemon's normal state."""
    geteuid = getattr(os, 'geteuid', None)
    return geteuid is not None and geteuid() == 0


# Only a successful lookup is cached for good. A daemon that starts before the
# kiosk autologin completes has no console user yet, and pinning that answer
# would leave every later sync of the run root-owned and every `~` root refused
# until the service restarts. A failure is cached for this long instead: the
# assembler asks once per extracted file, and on POSIX the lookup asks the OS
# who is at the console, which a 5,000-file sync must not do 5,000 times.
_CONSOLE_USER_RETRY_SECONDS = 30.0
_cached_console_user_passwd: Any = None
_console_user_failed_at: Optional[float] = None


def _console_user_passwd() -> Any:
    """
    The `pwd` entry of the user at the machine, named by `osadapter`.

    The logged-in user doesn't change across a service run on a kiosk and the
    assembler asks once per extracted file, so a resolved entry is kept. None on
    Windows, when nobody is logged in yet, and when the name has no local
    account — the last two are retried, and warned about, at most once per
    `_CONSOLE_USER_RETRY_SECONDS`.
    """
    global _cached_console_user_passwd, _console_user_failed_at
    if _cached_console_user_passwd is not None:
        return _cached_console_user_passwd
    if _os_family() == 'windows':
        return None
    now = time.monotonic()
    if (_console_user_failed_at is not None
            and now - _console_user_failed_at < _CONSOLE_USER_RETRY_SECONDS):
        return None
    try:
        import osadapter
        username = osadapter.console_user()
    except Exception as e:
        _console_user_failed_at = now
        logger.warning(
            f"destination_allowlist: could not identify the console user: {e}"
        )
        return None
    if not username:
        _console_user_failed_at = now
        return None
    try:
        import pwd
        entry = pwd.getpwnam(username)
    except (ImportError, KeyError) as e:
        _console_user_failed_at = now
        logger.warning(
            f"destination_allowlist: console user {username!r} has no local "
            f"account: {e}"
        )
        return None
    _cached_console_user_passwd = entry
    return entry

# Any reparse point: both IO_REPARSE_TAG_SYMLINK and IO_REPARSE_TAG_MOUNT_POINT.
# is_symlink() only catches the former.
_FILE_ATTRIBUTE_REPARSE_POINT = 0x400

# Writing any of these names — extension or not — targets the DEVICE, not the
# filesystem, so `<allowed>/NUL` or `<allowed>/sub/CON.toe` silently eats data.
# https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file
_WINDOWS_RESERVED_NAMES = frozenset({
    'con', 'prn', 'aux', 'nul',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
})


class DestinationNotAllowedError(Exception):
    """raised when a destination path is outside the allowlist."""
    pass


class DestinationAllowlist:
    """
    Allowed root directories; validates a target path against them after realpath
    resolution. Build directly, or via `from_config(config_dict)`.
    """

    def __init__(self, roots: Optional[Iterable[str]]) -> None:
        # Fail-closed: None/empty means deny all — a deliberate lockdown state.
        if roots is None:
            self._roots: List[Path] = []
        else:
            resolved: List[Path] = []
            for r in roots:
                if not r or not isinstance(r, str):
                    logger.warning(
                        f"destination_allowlist: ignoring invalid root entry: {r!r}"
                    )
                    continue
                try:
                    expanded = Path(_safe_expanduser(r)).resolve(strict=False)
                except UnresolvableHomeError as e:
                    logger.error(
                        f"destination_allowlist: REFUSING root {r!r}: {e} — give "
                        f"an absolute path instead"
                    )
                    continue
                except (OSError, ValueError) as e:
                    # ValueError = NULL-byte injection; OSError = transient.
                    logger.warning(
                        f"destination_allowlist: failed to resolve root {r!r}: {e}"
                    )
                    continue
                # Fail loud on misconfiguration: a root of `C:\` would authorise
                # this SYSTEM process to write anywhere on the drive.
                if _is_dangerous_root(expanded):
                    logger.error(
                        f"destination_allowlist: REFUSING dangerous root {expanded!r} "
                        f"(drive root or system directory) — drop it from "
                        f"agent_config.allowed_extract_roots"
                    )
                    continue
                resolved.append(expanded)
            self._roots = resolved
        logger.info(
            f"destination_allowlist initialized with {len(self._roots)} root(s): "
            f"{[str(p) for p in self._roots]}"
        )

    @classmethod
    def from_config(cls, config: dict) -> 'DestinationAllowlist':
        """
        Build from {'agent_config': {'allowed_extract_roots': [...]}}.

        Field missing → `default_roots()` (installer seeded no override; roost
        must work out of the box). Field present but empty → fail-closed, an
        explicit admin opt-out. Otherwise use the items verbatim.
        """
        agent_config = config.get('agent_config') or {}
        if 'allowed_extract_roots' not in agent_config:
            defaults = default_roots()
            logger.info(
                f"destination_allowlist: 'allowed_extract_roots' not set in "
                f"config — applying this OS's default roots {defaults}"
            )
            return cls(defaults)
        roots = agent_config.get('allowed_extract_roots')
        if not roots:
            logger.warning(
                "destination_allowlist: 'allowed_extract_roots' is empty — "
                "fail-closed (rejects all paths). remove the field or add an "
                "entry to allow extraction."
            )
        return cls(roots)

    def is_allowed(self, target: str) -> bool:
        """True if target is under an allowed root, traversal/symlink defences
        applied. Never raises — use validate() for raising semantics."""
        try:
            self.validate(target)
            return True
        except DestinationNotAllowedError:
            return False

    def validate(self, target: str) -> Path:
        """
        Returns the resolved Path when target is under an allowed root; raises
        DestinationNotAllowedError otherwise. Callers must use the returned path
        downstream — the string they passed in may be stale.
        """
        if not self._roots:
            raise DestinationNotAllowedError(
                "destination allowlist is empty — refusing all writes. "
                "set agent_config.allowed_extract_roots to enable extraction."
            )

        if not target or not isinstance(target, str):
            raise DestinationNotAllowedError(
                f"invalid target path: {target!r}"
            )

        # ValueError catches NULL-byte injection (`/path/file\x00.evil`).
        try:
            expanded = Path(_safe_expanduser(target))
        except UnresolvableHomeError as e:
            raise DestinationNotAllowedError(str(e)) from e
        except (ValueError, TypeError) as e:
            raise DestinationNotAllowedError(
                f"invalid characters in target path {target!r}: {e}"
            ) from e
        except Exception as e:
            raise DestinationNotAllowedError(
                f"could not expand path {target!r}: {e}"
            ) from e

        # Absolute only — cwd-dependent resolution is ambiguous.
        if not expanded.is_absolute():
            raise DestinationNotAllowedError(
                f"target path must be absolute: {target!r}"
            )

        is_windows = _os_family() == 'windows'

        # Reject alternate data streams (`file.toe:hidden:$DATA` writes hidden
        # bytes into a stream on the parent) and reserved device names, which
        # Windows redirects to the device regardless of extension.
        if is_windows:
            for i, part in enumerate(expanded.parts):
                # part 0 is `C:\\` — the only segment allowed a colon.
                if i == 0:
                    continue
                if ':' in part:
                    raise DestinationNotAllowedError(
                        f"target path contains windows alternate data stream "
                        f"(`:` in segment {part!r}): {target!r}"
                    )
                # NUL.txt and con.json are still the device.
                stem = part.split('.')[0].casefold()
                if stem in _WINDOWS_RESERVED_NAMES:
                    raise DestinationNotAllowedError(
                        f"target path contains windows reserved device name "
                        f"(segment {part!r} resolves to device {stem.upper()}): {target!r}"
                    )

        # resolve() follows symlinks AND junctions on Windows — wanted, so a link
        # out of an allowed root is caught by the relative_to check below.
        # strict=False: the file doesn't exist yet.
        try:
            resolved = expanded.resolve(strict=False)
        except (OSError, RuntimeError, ValueError) as e:
            raise DestinationNotAllowedError(
                f"could not resolve path {target!r}: {e}"
            ) from e

        # '..' can survive resolve() when intermediate dirs don't exist.
        # relative_to() would catch it too; this just gives a clearer message.
        if '..' in resolved.parts:
            raise DestinationNotAllowedError(
                f"path contains unresolved '..' segment: {str(resolved)!r}"
            )

        # Defence in depth against cve-2022-21658 / cve-2025-4330: resolve()
        # handles most cases, but re-check every parent for reparse points.
        if is_windows:
            self._check_no_reparse_points(resolved)

        # NTFS is case-insensitive: compare case-folded or 'C:\\Users\\Foo'
        # fails to match 'c:\\users\\foo\\file'.
        case_fold = is_windows
        resolved_cmp = _case_fold_path(resolved) if case_fold else resolved
        for root in self._roots:
            root_cmp = _case_fold_path(root) if case_fold else root
            try:
                resolved_cmp.relative_to(root_cmp)
                # Original casing — callers need canonical filesystem paths.
                return resolved
            except ValueError:
                continue

        raise DestinationNotAllowedError(
            f"path {str(resolved)!r} is not under any allowed root: "
            f"{[str(r) for r in self._roots]}"
        )

    def _check_no_reparse_points(self, resolved: Path) -> None:
        """
        Windows: reject if any parent is a reparse point. Uses
        FILE_ATTRIBUTE_REPARSE_POINT rather than is_symlink() because junctions
        need no SeCreateSymbolicLinkPrivilege and are the commoner primitive.

        FAIL-CLOSED on stat errors — only ENOENT (we're about to create it) passes.
        """
        # Path('C:\\').parent == Path('C:\\'), so terminate on a seen-set rather
        # than cur != cur.parent.
        cur = resolved
        seen: set = set()
        while True:
            if cur in seen:
                break
            seen.add(cur)
            try:
                st = os.lstat(str(cur))
            except FileNotFoundError:
                pass  # not created yet — fine, we're about to create it
            except OSError as e:
                # FAIL-CLOSED. Earlier code logged-and-allowed here, contradicting
                # the module's doctrine.
                raise DestinationNotAllowedError(
                    f"refusing path: cannot verify parent {str(cur)!r} is not a "
                    f"reparse point ({e.__class__.__name__}: {e})"
                ) from e
            else:
                attrs = getattr(st, 'st_file_attributes', 0)
                if attrs & _FILE_ATTRIBUTE_REPARSE_POINT:
                    raise DestinationNotAllowedError(
                        f"refusing path containing reparse point at {str(cur)!r} "
                        f"(symlink or junction)"
                    )
            parent = cur.parent
            if parent == cur:
                break
            cur = parent

    @property
    def roots(self) -> List[Path]:
        """read-only view of resolved allowed roots."""
        return list(self._roots)

    def __repr__(self) -> str:
        return f"DestinationAllowlist(roots={[str(r) for r in self._roots]})"


def _case_fold_path(p: Path) -> Path:
    """Case-folded path for Windows comparison — casefold(), not lower(), so
    international characters compare correctly."""
    return Path(str(p).casefold())


# Refused as extract roots on POSIX: a root that is, contains or sits under one
# of these hands the root daemon the operating system. Compared after resolve(),
# which on macOS turns `/etc` into `/private/etc` — the bare `/etc`, `/var` and
# `/tmp` spellings are listed alongside for a path that never touches the disk.
# `/` is exact-match only; every absolute path sits under it.
_POSIX_SYSTEM_PATHS: Dict[str, frozenset] = {
    'linux': frozenset({
        '/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot',
        '/var', '/sys', '/proc', '/dev', '/run', '/root',
    }),
    'macos': frozenset({
        '/', '/private/etc', '/private/var', '/private/tmp', '/System',
        '/Library', '/Applications', '/usr', '/bin', '/sbin', '/var/root',
        '/etc', '/var', '/tmp',
    }),
}

# Carved back out of the sets above: the installer creates these for roost and
# owns them, so the OS default root is not refused as a child of a system path.
_POSIX_SYSTEM_PATH_EXCEPTIONS: Dict[str, frozenset] = {
    'linux': frozenset({'/var/lib/owlette'}),
    'macos': frozenset({'/Users/Shared/Owlette'}),
}

_POSIX_FS_ROOT = PurePosixPath('/')


def _is_dangerous_root(p: Path) -> bool:
    """
    True for drive roots, system directories and anything else unsafe as an
    extract root — the agent is SYSTEM, root on POSIX, so a root of `C:\\` or `/`
    grants write access to System32, Program Files or /usr. Heuristic; real
    lockdown is OS-level ACLs and modes.
    """
    parts = p.parts
    if len(parts) <= 1:  # drive root: `C:\\` and POSIX `/` are both 1 part
        return True
    family = _os_family()
    if family != 'windows':
        # PurePosixPath so the comparison is separator-exact wherever it runs.
        return _is_dangerous_posix_root(PurePosixPath(p.as_posix()), family)

    path_str = str(p).casefold()
    # Reject an entry that IS, CONTAINS, or SITS UNDER a system path. The
    # descendant case catches innocuously-named links that resolve into system
    # dirs — __init__ already ran resolve() before this check.
    system_root = (os.environ.get('SystemRoot') or 'C:\\Windows').casefold()
    program_files = (os.environ.get('ProgramFiles') or 'C:\\Program Files').casefold()
    program_files_x86 = (
        os.environ.get('ProgramFiles(x86)') or 'C:\\Program Files (x86)'
    ).casefold()
    for sys_path in (system_root, program_files, program_files_x86):
        if path_str == sys_path:
            return True
        try:
            # p an ancestor of (or equal to) sys_path?
            Path(sys_path).relative_to(p)
            return True
        except ValueError:
            pass
        try:
            # p a descendant of (or equal to) sys_path?
            Path(path_str).relative_to(sys_path)
            return True
        except ValueError:
            pass
    return False


def _is_dangerous_posix_root(p: PurePosixPath, family: str) -> bool:
    """
    POSIX arm of `_is_dangerous_root`: refuse a root that IS, CONTAINS or SITS
    UNDER one of this OS's system paths, minus the carve-outs the installer owns.
    """
    for carve_out in _POSIX_SYSTEM_PATH_EXCEPTIONS[family]:
        if p.is_relative_to(carve_out):
            return False
    for sys_path in _POSIX_SYSTEM_PATHS[family]:
        system = PurePosixPath(sys_path)
        if p == system:
            return True
        if system == _POSIX_FS_ROOT:
            continue  # the parts check above is what refuses `/` itself
        if p.is_relative_to(system) or system.is_relative_to(p):
            return True
    return False
