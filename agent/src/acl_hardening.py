"""Reusable protected-DACL hardening for the Owlette install tree.

Generalises the protected-DACL pattern from ``display_manager`` into a table of
``{path: spec}`` for the whole install tree. Two entry points:

* ``repair_all(log)`` — called at service start-up and after each console
  session change: re-asserts the intended DACL on any path that has drifted,
  and never raises.
* ``create_private_dir(path, spec)`` — fail-closed directory creation for the
  service-owned trees (``content``, ``update-staging``, the cortex IPC trio).

The specs use well-known SIDs, never localized account names: account names are
localized, so a name lookup fails on non-English Windows. ``apply`` writes the
DACL with ``PROTECTED_DACL_SECURITY_INFORMATION`` so inheritance from the
install root cannot re-introduce a broader grant.

Nothing Windows-specific runs on import: the pywin32 and ``winreg`` imports live
inside the functions that use them, the well-known SIDs are converted on first
use and the table is built by ``specs()`` on first call, so the module imports on
macOS and Linux (where ``specs()`` is empty). The module does not import
``shared_utils``; the two roots are derived here directly, so ``shared_utils`` can
depend on this module without an import cycle.
"""

import functools
import logging
import os
import stat
from collections import namedtuple
from typing import Any, List, Tuple

import osadapter

logger = logging.getLogger(__name__)

# ordered list of (sid, access_mask, inherit_flags); sid is a pywin32 sid object.
AclSpec = List[Tuple[Any, int, int]]


class UntrustedDirectory(Exception):
    """A directory that already exists is not owned by a trusted principal, or is
    a reparse point, so it cannot be adopted as a service-private directory."""
    pass


class AclApplyError(Exception):
    """``apply`` could not write the DACL. Raised so the caller decides whether
    the failure is fatal (the token writer treats one access-denied as
    non-fatal); ``repair_all`` swallows it and moves on."""
    pass


_SID_SYSTEM_STR = 'S-1-5-18'
_SID_ADMINISTRATORS_STR = 'S-1-5-32-544'
_SID_USERS_STR = 'S-1-5-32-545'


@functools.lru_cache(maxsize=None)
def _sid(sid_str: str):
    """A well-known SID as a pywin32 SID object, converted on first use (a pure
    conversion: no i/o, no privilege needed)."""
    import win32security
    return win32security.ConvertStringSidToSid(sid_str)


# SID_SYSTEM, SID_ADMINISTRATORS and SID_USERS are module attributes resolved on
# first access (pep 562), so importing this module needs no pywin32.
_WELL_KNOWN_SIDS = {
    'SID_SYSTEM': _SID_SYSTEM_STR,
    'SID_ADMINISTRATORS': _SID_ADMINISTRATORS_STR,
    'SID_USERS': _SID_USERS_STR,
}


def __getattr__(name: str):
    if name in _WELL_KNOWN_SIDS:
        return _sid(_WELL_KNOWN_SIDS[name])
    raise AttributeError(f'module {__name__!r} has no attribute {name!r}')


# access masks, as ntsecuritycon spells them (FILE_ALL_ACCESS; FILE_GENERIC_READ |
# FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE; FILE_GENERIC_READ |
# FILE_GENERIC_EXECUTE). literals so the module imports without pywin32. modify
# is 0x1301bf: the mask icacls writes for modify and the one the developer grant
# uses, so the devmode tolerance compares it exactly.
_FULL = 0x1F01FF
_MODIFY = 0x1301BF
_READ_EXECUTE = 0x1200A9
# OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
_INHERIT = 0x03
_NO_INHERIT = 0

# marker in a spec template, resolved to the active console user's sid at apply
# time; the ace is dropped when no interactive session exists.
CONSOLE_USER = object()


# ----- the two install roots ------------------------------------------------
#
# the data root is %programdata%\owlette unless the override osadapter honours
# relocates it, as shared_utils.get_data_path resolves it (read here directly:
# osadapter's windows arm imports shared_utils, which imports this module).
# the payload root {app} is two directories above this file's
# folder ({app}\agent\src), as paths.rs' install_root and
# shared_utils.get_python_exe_path resolve it. a /dir= install can split the
# two; when it does not (the fleet default) they are the same folder and the
# table holds no duplicate path, so no entry is applied twice.

_DATA_ROOT = os.path.normpath(
    os.environ.get(osadapter.DATA_ROOT_ENV)
    or os.path.join(os.environ.get('PROGRAMDATA', r'C:\ProgramData'), 'Owlette')
)
_APP_ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)


# app_root marks entries under {app}; repair_all only touches those on an
# installed tree.
_SpecEntry = namedtuple('_SpecEntry', ['path', 'aces', 'app_root'])


def _build_specs() -> List['_SpecEntry']:
    """The hardening table for both roots. Path strings only — no I/O."""
    if os.name != 'nt':  # pragma: no cover - non-windows
        return []

    SID_SYSTEM = _sid(_SID_SYSTEM_STR)
    SID_ADMINISTRATORS = _sid(_SID_ADMINISTRATORS_STR)
    SID_USERS = _sid(_SID_USERS_STR)
    code_dir = [
        (SID_SYSTEM, _FULL, _INHERIT),
        (SID_ADMINISTRATORS, _FULL, _INHERIT),
        (SID_USERS, _READ_EXECUTE, _INHERIT),
    ]
    # root-level payload files: same trust as a code dir but not inheritable.
    # the root claude.md counts as code: cortex runs with {app}\agent as its
    # working directory and reads claude.md files from there and above as
    # instructions.
    root_file = [
        (SID_SYSTEM, _FULL, _NO_INHERIT),
        (SID_ADMINISTRATORS, _FULL, _NO_INHERIT),
        (SID_USERS, _READ_EXECUTE, _NO_INHERIT),
    ]
    service_dir = [
        (SID_SYSTEM, _FULL, _INHERIT),
        (SID_ADMINISTRATORS, _FULL, _INHERIT),
    ]
    console_dir = [
        (SID_SYSTEM, _FULL, _INHERIT),
        (SID_ADMINISTRATORS, _FULL, _INHERIT),
        (CONSOLE_USER, _MODIFY, _INHERIT),
    ]
    token_file = [
        (SID_SYSTEM, _FULL, _NO_INHERIT),
        (SID_ADMINISTRATORS, _FULL, _NO_INHERIT),
        (CONSOLE_USER, _MODIFY, _NO_INHERIT),
    ]

    entries: List[_SpecEntry] = []
    # payload root
    for name in ('agent', 'python', 'tools', 'app', 'scripts'):
        entries.append(_SpecEntry(os.path.join(_APP_ROOT, name), code_dir, True))
    for name in (
        'unins000.exe', 'unins000.dat', 'README.md', 'LICENSE',
        'CLAUDE.md', 'THIRD_PARTY_NOTICES.md', 'LGPL-2.1.txt',
    ):
        entries.append(_SpecEntry(os.path.join(_APP_ROOT, name), root_file, True))
    # data root
    for name in ('content', 'update-staging'):
        entries.append(
            _SpecEntry(os.path.join(_DATA_ROOT, name), service_dir, False)
        )
    for name in ('cortex_commands', 'cortex_results', 'cortex_events'):
        entries.append(
            _SpecEntry(os.path.join(_DATA_ROOT, 'ipc', name), console_dir, False)
        )
    # the pre-migration copy secure_storage keeps across a key-derivation
    # change is a credential store too, and takes the store's aces.
    for name in ('.tokens.enc', '.tokens.enc.v1'):
        entries.append(_SpecEntry(os.path.join(_DATA_ROOT, name), token_file, False))
    # deliberately not rows: the swoop and roost data-root ipc and log directories
    # (ipc\{jobs,results,swoop,requests}, logs\swoop). the right ace set depends on
    # which principal reads each one and those readers are not shipped yet, so they
    # inherit the data root's acl and whatever consumes them verifies the creator's
    # identity, the way the cortex command read path does. cache\update is the
    # posix-only update staging directory and needs no windows acl.
    return entries


@functools.lru_cache(maxsize=1)
def specs() -> List['_SpecEntry']:
    """The hardening table, built on first call and empty off Windows. Read it
    at call time, never at import."""
    return _build_specs()


# ----- native seams (wrapped so unit tests can mock every win32 call) -------

def _native_read_dacl(path: str):
    import win32security
    return win32security.GetNamedSecurityInfo(
        path, win32security.SE_FILE_OBJECT,
        win32security.DACL_SECURITY_INFORMATION,
    )


def _native_read_owner(path: str):
    import win32security
    sd = win32security.GetFileSecurity(
        path, win32security.OWNER_SECURITY_INFORMATION,
    )
    return sd.GetSecurityDescriptorOwner()


def _native_write_dacl(path: str, dacl) -> None:
    import win32security
    protected = getattr(
        win32security, 'PROTECTED_DACL_SECURITY_INFORMATION', None,
    )
    if protected is None:  # pragma: no cover - constant present on supported builds
        protected = -2147483648  # 0x80000000 as a signed c long
    win32security.SetNamedSecurityInfo(
        path, win32security.SE_FILE_OBJECT,
        win32security.DACL_SECURITY_INFORMATION | protected,
        None, None, dacl, None,
    )


def _mkdir(path: str) -> None:
    os.mkdir(path)


def _is_plain_object(path: str) -> bool:
    """True when ``path`` is neither a reparse point (symlink, junction) nor
    one of several hard links. Raises OSError when it cannot be read."""
    st = os.lstat(path)
    return st.st_nlink == 1 and not st.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT


def _is_installed_tree() -> bool:
    """True when {app} holds the uninstaller: an installed tree, not a source
    checkout (whose files must never be re-ACL'd)."""
    return os.path.isfile(os.path.join(_APP_ROOT, 'unins000.exe'))


def _read_dev_mode_value():
    """Raw HKLM\\SOFTWARE\\Owlette\\DevMode value, or raise if key/value absent."""
    import winreg
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Owlette') as key:
        value, _regtype = winreg.QueryValueEx(key, 'DevMode')
        return value


# ----- public api -----------------------------------------------------------

def console_user_sid():
    """The active console user's SID, or ``None`` when there is no interactive
    session. The raw token user SID is returned unfiltered so Entra ID accounts
    (S-1-12-1-*) are honoured."""
    if os.name != 'nt':
        return None

    token = None
    try:
        import win32security
        import win32ts
        session_id = win32ts.WTSGetActiveConsoleSessionId()
        if session_id == 0xFFFFFFFF:
            return None
        try:
            token = win32ts.WTSQueryUserToken(session_id)
            token_user = win32security.GetTokenInformation(
                token, win32security.TokenUser,
            )
            return token_user[0] if isinstance(token_user, tuple) else token_user
        except Exception as e:
            logger.debug(
                'console user: WTSQueryUserToken failed (%s); trying session name',
                e,
            )
            return _console_user_sid_from_session_name(session_id)
    except Exception as e:
        logger.debug('console user: SID lookup failed: %s', e)
        return None
    finally:
        if token is not None:
            try:
                token.Close()
            except Exception as e:  # pragma: no cover - defensive close
                logger.debug('console user: token close failed: %s', e)


def _console_user_sid_from_session_name(session_id):
    """Fallback SID lookup that works in non-LocalSystem runs."""
    try:
        import win32security
        import win32ts
        username = win32ts.WTSQuerySessionInformation(
            None, session_id, win32ts.WTSUserName,
        )
        if not username:
            return None
        domain = win32ts.WTSQuerySessionInformation(
            None, session_id, win32ts.WTSDomainName,
        )
        account = f'{domain}\\{username}' if domain else username
        user_sid, _, _ = win32security.LookupAccountName('', account)
        return user_sid
    except Exception as e:
        logger.debug('console user: session-name SID lookup failed: %s', e)
        return None


def is_trusted_owner(path: str, user_sid=None) -> bool:
    """True when ``path``'s owner is SYSTEM or Administrators, or ``user_sid``
    when one is given, and ``path`` is neither a reparse point nor a hard link.

    In a directory local users can create entries in, an owner check alone
    proves nothing: a hard link to a SYSTEM-owned file they can write
    attributes on (a log), or a reparse point, carries that object's owner.
    Fail-closed: any read failure returns False so a caller treats the path as
    untrusted."""
    try:
        import win32security
        if not _is_plain_object(path):
            return False
        owner_str = win32security.ConvertSidToStringSid(_native_read_owner(path))
        if owner_str in (_SID_SYSTEM_STR, _SID_ADMINISTRATORS_STR):
            return True
        return (user_sid is not None
                and owner_str == win32security.ConvertSidToStringSid(user_sid))
    except Exception as e:
        logger.debug('is_trusted_owner: read failed for %s: %s', path, e)
        return False


def apply(path: str, spec: AclSpec) -> None:
    """Write ``spec`` as a protected DACL on ``path``. ``spec`` must be concrete
    (no CONSOLE_USER markers). Raises ``AclApplyError`` on failure."""
    try:
        import win32security
        dacl = win32security.ACL()
        for sid, mask, flags in spec:
            dacl.AddAccessAllowedAceEx(
                win32security.ACL_REVISION, flags, mask, sid,
            )
        _native_write_dacl(path, dacl)
    except Exception as e:
        raise AclApplyError(f'failed to apply DACL to {path}: {e}') from e


def matches(path: str, spec: AclSpec) -> bool:
    """True when ``path`` already carries exactly ``spec`` as a protected DACL.
    Never raises — any read/parse failure returns False."""
    try:
        import win32security
        sd = _native_read_dacl(path)
        control, _revision = sd.GetSecurityDescriptorControl()
        se_dacl_protected = getattr(win32security, 'SE_DACL_PROTECTED', 0x1000)
        if not (control & se_dacl_protected):
            return False
        dacl = sd.GetSecurityDescriptorDacl()
        if dacl is None or dacl.GetAceCount() != len(spec):
            return False

        expected = {
            (int(flags), int(mask), win32security.ConvertSidToStringSid(sid))
            for sid, mask, flags in spec
        }
        allowed_type = getattr(win32security, 'ACCESS_ALLOWED_ACE_TYPE', 0)
        actual = set()
        for index in range(dacl.GetAceCount()):
            ace = dacl.GetAce(index)
            ace_type = ace[0][0]
            ace_flags = ace[0][1]
            access_mask = ace[1]
            sid = ace[-1]
            if ace_type != allowed_type:
                return False
            actual.add((
                int(ace_flags), int(access_mask),
                win32security.ConvertSidToStringSid(sid),
            ))
        return actual == expected
    except Exception as e:
        logger.debug('acl matches: comparison failed for %s: %s', path, e)
        return False


def _resolve_spec(aces, console_sid) -> AclSpec:
    """Turn a spec template into a concrete spec: substitute the console user
    SID for CONSOLE_USER, dropping that ACE when no interactive session exists."""
    resolved: AclSpec = []
    for sid, mask, flags in aces:
        if sid is CONSOLE_USER:
            if console_sid is None:
                continue
            resolved.append((console_sid, mask, flags))
        else:
            resolved.append((sid, mask, flags))
    return resolved


def create_private_dir(path: str, spec: AclSpec) -> None:
    """Create ``path`` as a service-private directory and set its DACL.

    ``os.mkdir`` without ``exist_ok`` — an existing directory is adopted only
    when ``is_trusted_owner`` holds for it (owned by SYSTEM or Administrators,
    not a reparse point), otherwise ``UntrustedDirectory`` is raised. ``spec``
    may contain a CONSOLE_USER marker; it is resolved here."""
    try:
        _mkdir(path)
    except FileExistsError:
        if not is_trusted_owner(path):
            raise UntrustedDirectory(
                f'refusing to use existing untrusted directory: {path}'
            )
    apply(path, _resolve_spec(spec, console_user_sid()))


def dev_mode_enabled() -> bool:
    """True when HKLM\\SOFTWARE\\Owlette\\DevMode is the DWORD 1."""
    if os.name != 'nt':
        return False
    try:
        return _read_dev_mode_value() == 1
    except Exception:
        return False


def _is_dev_tolerant(path: str) -> bool:
    """True only for {app}\\app. DevMode tolerance applies there alone:
    agent\\src also carries the developer grant but is never re-asserted here,
    because it is a child of agent."""
    app_dir = os.path.join(_APP_ROOT, 'app')
    return os.path.normcase(os.path.normpath(path)) == os.path.normcase(
        os.path.normpath(app_dir)
    )


def _safe_log(log, level: str, msg: str, *args) -> None:
    """Log without ever raising — repair_all must not fail because of logging."""
    try:
        getattr(log, level)(msg, *args)
    except Exception:
        pass


def follows_console_user(entry) -> bool:
    """True for a specs() entry that grants whoever is at the console: its DACL
    changes with every login and logoff, which is not drift."""
    return any(sid is CONSOLE_USER for sid, _mask, _flags in entry.aces)


def repair_all(log=None, session_change=False) -> List[str]:
    """Re-assert the intended DACL on every path in specs() that has drifted.

    Returns the list of repaired paths. Never raises. Absent paths are skipped
    silently, and a link or reparse point at a path is never followed;
    ``create_private_dir`` owns service-directory creation. App-root
    entries are skipped unless {app} is an installed tree (the uninstaller is
    present), so a run from a source checkout never touches the checkout. In
    DevMode one extra Modify ACE for the current interactive account is
    tolerated on ``app``; ``agent\\src`` is never re-asserted here because it is
    a child of ``agent``.

    ``session_change`` marks a run started by a console session change: the
    console-user entries are expected to change then, so their repairs log at
    info, and the DevMode warning is left to the start-up run. A fixed entry
    repaired then is still drift and still warns."""
    _log = log if log is not None else logger
    repaired: List[str] = []

    try:
        dev = dev_mode_enabled()
    except Exception:
        dev = False
    try:
        console_sid = console_user_sid()
    except Exception:
        console_sid = None
    installed = _is_installed_tree()
    if not installed:
        _safe_log(
            _log, 'debug',
            'acl hardening: %s is not an installed tree; skipping its entries',
            _APP_ROOT,
        )

    for entry in specs():
        path = entry.path
        try:
            if entry.app_root and not installed:
                continue
            if not os.path.exists(path):
                continue
            # a junction or symlink planted where a table path is absent would
            # carry the repair's dacl onto whatever it points at.
            if not _is_plain_object(path):
                _safe_log(
                    _log, 'warning',
                    'acl hardening: %s is a link or reparse point; leaving it alone',
                    path,
                )
                continue
            spec = _resolve_spec(entry.aces, console_sid)
            variants = [spec]
            # accept exactly one extra developer ace, and only on {app}\app.
            if dev and _is_dev_tolerant(path) and console_sid is not None:
                variants.append(spec + [(console_sid, _MODIFY, _INHERIT)])
            if any(matches(path, variant) for variant in variants):
                continue
            apply(path, spec)
            repaired.append(path)
            if session_change and follows_console_user(entry):
                _safe_log(
                    _log, 'info',
                    'acl hardening: updated %s for the console session', path,
                )
            else:
                _safe_log(
                    _log, 'warning',
                    'acl hardening: repaired drifted permissions on %s', path,
                )
        except Exception as e:
            _safe_log(
                _log, 'warning',
                'acl hardening: could not repair %s: %s', path, e,
            )
            continue

    if dev and not session_change:
        _safe_log(
            _log, 'warning',
            'acl hardening: DevMode is enabled; the install tree carries a '
            'developer grant on agent\\src and app',
        )
    return repaired
