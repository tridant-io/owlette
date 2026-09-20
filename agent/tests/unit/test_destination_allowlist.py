"""
tests for destination_allowlist — security-floor enforcement for roost
extraction targets. fail-closed semantics are critical: empty/missing
allowlist must reject all writes.
"""

import os
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

import destination_allowlist as mod
from destination_allowlist import (
    DestinationAllowlist,
    DestinationNotAllowedError,
    default_roots,
    get_interactive_user_ids,
)


class FakePasswd:
    """stand-in for a `pwd.struct_passwd`, so the POSIX arms are drivable from
    any host."""

    def __init__(self, pw_dir, pw_uid=1001, pw_gid=1002):
        self.pw_dir = pw_dir
        self.pw_uid = pw_uid
        self.pw_gid = pw_gid


def test_none_roots_rejects_all_paths():
    allowlist = DestinationAllowlist(None)
    assert not allowlist.is_allowed('C:\\Windows\\System32\\evil.exe')
    assert not allowlist.is_allowed('/tmp/anything')
    assert not allowlist.is_allowed(str(Path.home()))


def test_empty_roots_rejects_all_paths():
    allowlist = DestinationAllowlist([])
    assert not allowlist.is_allowed('C:\\Windows\\System32\\evil.exe')
    assert not allowlist.is_allowed('/tmp/anything')


def test_empty_roots_validate_raises_with_clear_message():
    allowlist = DestinationAllowlist([])
    with pytest.raises(DestinationNotAllowedError, match="empty"):
        allowlist.validate('/anything')


def test_from_config_with_missing_agent_config_applies_defaults(tmp_path, monkeypatch):
    """no agent_config key → field unset → apply this OS's default roots."""
    # Don't depend on the real default root existing on the CI runner.
    monkeypatch.setattr(mod, 'default_roots', lambda os_family=None: [str(tmp_path)])
    allowlist = mod.DestinationAllowlist.from_config({})
    assert allowlist.is_allowed(str(tmp_path / 'x' / 'y.toe'))


def test_from_config_with_missing_allowed_extract_roots_applies_defaults(tmp_path, monkeypatch):
    """agent_config exists but no allowed_extract_roots → apply the defaults."""
    monkeypatch.setattr(mod, 'default_roots', lambda os_family=None: [str(tmp_path)])
    allowlist = mod.DestinationAllowlist.from_config({'agent_config': {}})
    assert allowlist.is_allowed(str(tmp_path / 'x' / 'y.toe'))


def test_from_config_with_explicit_empty_list_is_fail_closed():
    """explicit empty list → reject all (deliberate lockdown state)."""
    allowlist = DestinationAllowlist.from_config({
        'agent_config': {'allowed_extract_roots': []}
    })
    assert not allowlist.is_allowed('/tmp/test')


def test_path_under_allowed_root_is_allowed(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    target = tmp_path / 'project' / 'file.toe'
    assert allowlist.is_allowed(str(target))


def test_path_at_allowed_root_itself_is_allowed(tmp_path):
    """the root itself counts as 'under the root' — relative_to(self) returns '.'."""
    allowlist = DestinationAllowlist([str(tmp_path)])
    assert allowlist.is_allowed(str(tmp_path))


def test_validate_returns_resolved_path(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    target = str(tmp_path / 'sub' / 'file.toe')
    result = allowlist.validate(target)
    assert isinstance(result, Path)
    assert result.is_absolute()


def test_path_traversal_with_dotdot_is_rejected(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    # traversal from inside the allowed root that escapes via ..
    target = str(tmp_path / 'sub' / '..' / '..' / 'evil.exe')
    assert not allowlist.is_allowed(target)


def test_sibling_dir_outside_allowlist_rejected(tmp_path):
    """allowed root is tmp_path/a; trying tmp_path/b should reject."""
    a = tmp_path / 'a'
    b = tmp_path / 'b'
    a.mkdir()
    b.mkdir()
    allowlist = DestinationAllowlist([str(a)])
    assert not allowlist.is_allowed(str(b / 'file'))


def test_completely_unrelated_root_rejected(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    if sys.platform == 'win32':
        target = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    else:
        target = '/etc/passwd'
    assert not allowlist.is_allowed(target)


def test_relative_path_rejected(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    with pytest.raises(DestinationNotAllowedError, match="absolute"):
        allowlist.validate('relative/path/file')


def test_empty_target_rejected(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    with pytest.raises(DestinationNotAllowedError):
        allowlist.validate('')


def test_none_target_rejected(tmp_path):
    allowlist = DestinationAllowlist([str(tmp_path)])
    with pytest.raises(DestinationNotAllowedError):
        allowlist.validate(None)  # type: ignore[arg-type]


def test_null_byte_in_target_raises_DestinationNotAllowedError(tmp_path):
    """
    NULL byte injection: os.path.expanduser raises ValueError, which must
    be wrapped in DestinationNotAllowedError so callers' try/except works.
    """
    allowlist = DestinationAllowlist([str(tmp_path)])
    with pytest.raises(DestinationNotAllowedError):
        allowlist.validate(str(tmp_path / 'file\x00.evil'))
    # The wrapper returns False rather than bubbling the ValueError.
    assert not allowlist.is_allowed(str(tmp_path / 'evil\x00.toe'))


def test_multiple_roots_any_match_allows(tmp_path):
    a = tmp_path / 'a'
    b = tmp_path / 'b'
    a.mkdir()
    b.mkdir()
    allowlist = DestinationAllowlist([str(a), str(b)])
    assert allowlist.is_allowed(str(a / 'file'))
    assert allowlist.is_allowed(str(b / 'file'))
    assert not allowlist.is_allowed(str(tmp_path / 'c' / 'file'))


def test_tilde_in_root_is_expanded(tmp_path, monkeypatch):
    """an unprivileged agent is its own user, so `~` is the stdlib's answer.

    the home is sandboxed rather than read off the machine: the suite runs as
    root on the linux leg, and /root is a system path the allowlist refuses.
    """
    monkeypatch.setattr(mod, '_running_as_root', lambda: False)
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setenv('USERPROFILE', str(tmp_path))  # ntpath.expanduser reads this one
    allowlist = DestinationAllowlist(['~/Documents/Owlette'])
    home = Path.home() / 'Documents' / 'Owlette'
    resolved_roots = allowlist.roots
    assert any(str(r) == str(home.resolve()) for r in resolved_roots), (
        f"expected ~/Documents/Owlette to expand to {home}, got {resolved_roots}"
    )


def test_tilde_in_root_expands_through_the_console_user(tmp_path, monkeypatch):
    """under the privileged daemon `~` is the human at the machine, wherever
    the suite itself happens to be running from."""
    home = tmp_path / 'home' / 'kiosk'
    monkeypatch.setattr(mod, '_os_family', lambda: 'linux')
    monkeypatch.setattr(mod, '_running_as_root', lambda: True)
    monkeypatch.setattr(mod, '_console_user_passwd', lambda: FakePasswd(str(home)))

    allowlist = DestinationAllowlist(['~/projects'])

    assert allowlist.roots == [(home / 'projects').resolve()]


def test_tilde_in_root_is_refused_with_nobody_at_the_machine(tmp_path, monkeypatch):
    """negative control: no console user, no interactive home — the root is
    dropped rather than quietly becoming the daemon's own."""
    monkeypatch.setattr(mod, '_os_family', lambda: 'linux')
    monkeypatch.setattr(mod, '_running_as_root', lambda: True)
    monkeypatch.setattr(mod, '_console_user_passwd', lambda: None)

    assert DestinationAllowlist(['~/projects']).roots == []
    assert not DestinationAllowlist([str(tmp_path)]).is_allowed('~/projects/a.toe')


def test_tilde_in_target_is_expanded(tmp_path, monkeypatch):
    monkeypatch.setattr(mod, '_running_as_root', lambda: False)
    monkeypatch.setenv('HOME', str(tmp_path))
    monkeypatch.setenv('USERPROFILE', str(tmp_path))  # windows
    allowed = tmp_path / 'Documents' / 'Owlette'
    allowed.mkdir(parents=True)
    allowlist = DestinationAllowlist([str(allowed)])
    assert allowlist.is_allowed('~/Documents/Owlette/file.toe')


def test_invalid_root_entries_are_skipped_keeping_valid_one(tmp_path):
    """
    feedback fix: previously this asserted len==1 without verifying WHICH
    survived — could have been any path resolution side-effect.
    """
    valid_root = tmp_path / 'valid'
    valid_root.mkdir()
    allowlist = DestinationAllowlist([
        '',                  # empty string — skipped
        None,                # None — skipped
        123,                 # not a string — skipped
        str(valid_root),     # actually valid
    ])
    assert len(allowlist.roots) == 1
    # explicit check: the surviving root is the valid one we provided
    assert allowlist.roots[0] == valid_root.resolve()


def test_from_config_with_valid_roots():
    """neither path is under a system path on any OS — `/tmp` would be, since
    macOS resolves it to `/private/tmp`."""
    config = {
        'agent_config': {
            'allowed_extract_roots': ['/opt/projects', '/data/projects']
        }
    }
    allowlist = DestinationAllowlist.from_config(config)
    assert len(allowlist.roots) == 2


def test_repr_includes_roots(tmp_path):
    """
    feedback fix: previously only checked the class name; didn't verify
    the roots actually appear in the repr (despite the test name).
    """
    a = tmp_path / 'first-root'
    b = tmp_path / 'second-root'
    a.mkdir()
    b.mkdir()
    allowlist = DestinationAllowlist([str(a), str(b)])
    repr_str = repr(allowlist)
    assert 'DestinationAllowlist' in repr_str
    # actually verify both roots appear in the repr
    assert 'first-root' in repr_str
    assert 'second-root' in repr_str


@pytest.mark.parametrize('family,expected', [
    ('windows', ['~/Documents']),
    ('macos', ['/Users/Shared/Owlette']),
    ('linux', ['/var/lib/owlette/projects']),
])
def test_default_roots_per_os(family, expected):
    """
    the per-OS landing pad. windows keeps `~/Documents`; the POSIX defaults are
    absolute, because `~` under the root daemon is /root (/var/root on macOS),
    which no kiosk user can read.
    """
    assert default_roots(family) == expected


def test_default_roots_follow_the_running_os(monkeypatch):
    monkeypatch.setattr(mod, '_os_family', lambda: 'macos')
    assert default_roots() == ['/Users/Shared/Owlette']


@pytest.mark.parametrize('family', ['macos', 'linux'])
def test_posix_default_root_is_not_refused_by_its_own_os(family, monkeypatch):
    """the carve-outs exist so the default root survives the system-path set."""
    monkeypatch.setattr(mod, '_os_family', lambda: family)
    for root in default_roots(family):
        assert mod._is_dangerous_root(Path(root)) is False


@pytest.mark.windows(reason='Windows-specific reparse-point check')
def test_windows_symlink_in_parent_is_rejected(tmp_path):
    """
    create a symlink inside the allowed root pointing OUT of it.
    paths via the symlink should be rejected — resolve() follows the link
    and the resolved path is outside the allowed root.
    """
    allowed = tmp_path / 'allowed'
    outside = tmp_path / 'outside'
    allowed.mkdir()
    outside.mkdir()
    (outside / 'evil.txt').write_text('hostile')

    link = allowed / 'sneaky'
    try:
        os.symlink(str(outside), str(link), target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation requires admin or developer mode on windows")

    allowlist = DestinationAllowlist([str(allowed)])
    target_via_symlink = str(link / 'evil.txt')
    assert not allowlist.is_allowed(target_via_symlink)


@pytest.mark.windows(reason='Windows reparse-point attribute check')
def test_windows_reparse_point_detected_via_mocked_attribute(tmp_path):
    """
    junctions don't require admin to create but are fiddly to set up in
    pytest. mock the os.lstat to simulate the FILE_ATTRIBUTE_REPARSE_POINT
    bit being set on a parent — covers both junction AND symlink rejection
    via the same code path.
    """
    allowed = tmp_path / 'allowed'
    allowed.mkdir()
    sub = allowed / 'sub'
    sub.mkdir()
    target = sub / 'file.toe'

    allowlist = DestinationAllowlist([str(allowed)])
    # without the mock, the path is allowed (no actual reparse points)
    assert allowlist.is_allowed(str(target))

    # Claim the 'sub' parent carries the reparse-point attribute.
    real_lstat = os.lstat

    def fake_lstat(path):
        s = real_lstat(path)
        if str(sub) in str(path):
            class _Stat:
                pass
            obj = _Stat()
            for attr in dir(s):
                if not attr.startswith('_'):
                    try:
                        setattr(obj, attr, getattr(s, attr))
                    except (AttributeError, TypeError):
                        pass
            obj.st_file_attributes = 0x400  # FILE_ATTRIBUTE_REPARSE_POINT
            return obj
        return s

    with patch('destination_allowlist.os.lstat', side_effect=fake_lstat):
        with pytest.raises(DestinationNotAllowedError, match="reparse point"):
            allowlist.validate(str(target))


@pytest.mark.windows(reason='Windows NTFS is case-insensitive')
def test_windows_case_insensitive_allowlist_match(tmp_path):
    """
    NTFS is case-insensitive but Path.relative_to() is case-sensitive.
    a user's allowlist of `C:\\Users\\Foo` must match a target like
    `c:\\users\\foo\\file.toe` returned by some windows APIs that lowercase.
    without case-folding this fails as "not under any allowed root".
    """
    allowed = tmp_path / 'AllowedDir'
    allowed.mkdir()
    allowlist = DestinationAllowlist([str(allowed)])

    # Different casing resolves to the same place on NTFS.
    target = str(allowed).lower() + os.sep + 'file.toe'
    assert allowlist.is_allowed(target), (
        f"case-folded match failed: target={target!r} not allowed under {allowed!r}"
    )


# stat OSError fails closed; it used to log and allow.


@pytest.mark.windows(reason='Windows alternate data streams')
def test_windows_alternate_data_stream_rejected(tmp_path):
    """
    `C:\\AllowedDir\\file.toe:hidden:$DATA` is a Windows ADS — colon
    syntax that writes hidden bytes into a stream attached to the parent
    file. relative_to() succeeds because the colon doesn't trigger
    path-traversal, but the agent (running as SYSTEM) would silently
    create a hidden malicious payload. round-2 catch.
    """
    allowlist = DestinationAllowlist([str(tmp_path)])
    target = str(tmp_path / 'file.toe:hidden:$DATA')
    with pytest.raises(DestinationNotAllowedError, match="alternate data stream"):
        allowlist.validate(target)
    assert not allowlist.is_allowed(target)


@pytest.mark.windows(reason='Windows drive-root + system-dir rejection')
def test_windows_drive_root_in_allowlist_is_rejected():
    """
    operator misconfiguration: an admin who types `C:\\` as an allowed root
    would otherwise authorize the agent (SYSTEM) to write anywhere on C:,
    including System32. fail-loud at allowlist construction.
    """
    allowlist = DestinationAllowlist(['C:\\'])
    # Dangerous root dropped, allowlist empty, so everything fails closed.
    assert allowlist.roots == []
    assert not allowlist.is_allowed('C:\\Windows\\System32\\evil.dll')


@pytest.mark.windows(reason='Windows system-dir rejection')
def test_windows_system_root_in_allowlist_is_rejected():
    """
    `C:\\Windows` (or whatever %SystemRoot% resolves to) must be rejected
    as a dangerous allowlist root — same justification as drive-root.
    """
    import os
    system_root = os.environ.get('SystemRoot', 'C:\\Windows')
    allowlist = DestinationAllowlist([system_root])
    assert allowlist.roots == []


def test_posix_root_in_allowlist_is_rejected():
    """`/` as an allowed root authorizes everything on the system. reject."""
    if sys.platform == 'win32':
        pytest.skip('posix-only test')
    allowlist = DestinationAllowlist(['/'])
    assert allowlist.roots == []


@pytest.mark.windows(reason='Windows reserved device names')
def test_windows_reserved_device_names_rejected(tmp_path):
    """
    Windows reserved device names (NUL, CON, PRN, AUX, COM1-9, LPT1-9)
    redirect i/o to the named device regardless of extension. an attacker
    version with `<allowed>/NUL` or `<allowed>/sub/CON.toe` would silently
    corrupt data or attach to console/printer streams. round-3 catch.
    """
    allowlist = DestinationAllowlist([str(tmp_path)])
    for name in ('NUL', 'CON', 'PRN', 'AUX', 'COM1', 'LPT9', 'NUL.txt', 'con.json', 'COM5.toe'):
        target = str(tmp_path / 'sub' / name)
        with pytest.raises(DestinationNotAllowedError, match="reserved device name"):
            allowlist.validate(target)
    # legitimate names with similar prefixes pass
    assert allowlist.is_allowed(str(tmp_path / 'console.toe'))   # not CON
    assert allowlist.is_allowed(str(tmp_path / 'auxiliary.toe')) # not AUX
    assert allowlist.is_allowed(str(tmp_path / 'communications.toe')) # not COM1


@pytest.mark.windows(reason='Windows system-dir descendant check')
def test_windows_descendant_of_system_dir_rejected(tmp_path):
    """
    `_is_dangerous_root` previously only checked p-as-ancestor of system
    paths. a symlink at `D:\\my_safe_dir` pointing to `C:\\Windows\\System32`
    would resolve to a descendant of SystemRoot and bypass the check.
    round-3 catch.
    """
    import os
    system_root = os.environ.get('SystemRoot', 'C:\\Windows')
    # try a descendant
    descendant = system_root + '\\System32'
    allowlist = DestinationAllowlist([descendant])
    assert allowlist.roots == [], (
        f"expected descendant of SystemRoot to be rejected, got {allowlist.roots}"
    )


@pytest.mark.windows(reason='reparse-point check is windows-only')
def test_windows_stat_permission_error_fails_closed(tmp_path):
    """
    if we can't stat a parent path, FAIL-CLOSED. previous behavior was
    fail-open ("treat as safe-ish") which contradicted the fail-closed
    doctrine. only ENOENT (parent doesn't exist yet) is allowed through.
    """
    allowed = tmp_path / 'allowed'
    allowed.mkdir()
    target = allowed / 'file.toe'
    allowlist = DestinationAllowlist([str(allowed)])

    # without mock: passes
    assert allowlist.is_allowed(str(target))

    # with mock raising PermissionError on the parent: fail-closed
    real_lstat = os.lstat

    def fake_lstat(path):
        if str(path).startswith(str(allowed)):
            raise PermissionError(13, 'Access denied', str(path))
        return real_lstat(path)

    with patch('destination_allowlist.os.lstat', side_effect=fake_lstat):
        with pytest.raises(DestinationNotAllowedError, match="cannot verify"):
            allowlist.validate(str(target))


# POSIX system paths, `~` and file ownership.
# `_os_family` is the module's one platform read, so every case below runs on
# any host; the paths are compared as PurePosixPath and never touch the disk.

# (family, root, dangerous?) — the post-resolve() spelling, which is what
# DestinationAllowlist.__init__ hands `_is_dangerous_root`.
_POSIX_ROOT_CASES = [
    # linux: is / contains / sits under a system path
    ('linux', '/', True),
    ('linux', '/etc', True),
    ('linux', '/etc/systemd/system', True),
    ('linux', '/usr', True),
    ('linux', '/usr/local/bin', True),
    ('linux', '/var', True),
    ('linux', '/var/lib', True),
    ('linux', '/bin', True),
    ('linux', '/sbin', True),
    ('linux', '/lib', True),
    ('linux', '/lib64', True),
    ('linux', '/boot', True),
    ('linux', '/sys/kernel', True),
    ('linux', '/proc/1', True),
    ('linux', '/dev/shm', True),
    ('linux', '/run/user/1000', True),
    ('linux', '/root', True),
    ('linux', '/root/Documents', True),
    # linux: the carve-out and ordinary operator-chosen roots
    ('linux', '/var/lib/owlette', False),
    ('linux', '/var/lib/owlette/projects', False),
    ('linux', '/var/lib/owlette/projects/show1', False),
    ('linux', '/opt/exhibit', False),
    ('linux', '/home/kiosk/projects', False),
    ('linux', '/srv/roost', False),
    # macos: the /private/... spellings resolve() produces
    ('macos', '/', True),
    ('macos', '/private/etc', True),
    ('macos', '/private/etc/ssh', True),
    ('macos', '/private/var', True),
    ('macos', '/private/var/root', True),
    ('macos', '/private/var/db', True),
    ('macos', '/private/tmp', True),
    ('macos', '/private', True),          # contains /private/etc
    # macos: the bare spellings, for a path that never touches the disk
    ('macos', '/etc', True),
    ('macos', '/var', True),
    ('macos', '/var/root', True),
    ('macos', '/tmp', True),
    # macos: the rest of the OS
    ('macos', '/System', True),
    ('macos', '/System/Library/LaunchDaemons', True),
    ('macos', '/Library', True),
    ('macos', '/Library/LaunchDaemons', True),
    ('macos', '/Applications', True),
    ('macos', '/Applications/owlette.app', True),
    ('macos', '/usr/local/bin', True),
    ('macos', '/bin', True),
    ('macos', '/sbin', True),
    # macos: the carve-outs and ordinary operator-chosen roots
    ('macos', '/Users/Shared/Owlette', False),
    ('macos', '/Users/Shared/Owlette/show1', False),
    ('macos', '/Users/Shared', False),
    ('macos', '/Users/kiosk/Movies', False),
    # the per-user temp tree is under /private/var: shipped policy refuses it,
    # and the suite injects its own tmp root on macOS rather than widen this.
    ('macos', '/private/var/folders/ab/cd/T/pytest-of-runner/pytest-0', True),
    ('macos', '/opt/exhibit', False),
]


@pytest.mark.parametrize('family,root,dangerous', _POSIX_ROOT_CASES)
def test_posix_dangerous_roots(family, root, dangerous, monkeypatch):
    """
    the POSIX arm refuses a root that IS, CONTAINS or SITS UNDER one of the OS's
    system paths. the pre-3.8 set matched exact strings only, so every
    descendant here (`/usr/local/bin`, `/Library/LaunchDaemons`, `/private/etc`)
    was authorised for a root daemon.
    """
    monkeypatch.setattr(mod, '_os_family', lambda: family)
    assert mod._is_dangerous_root(Path(root)) is dangerous


def test_posix_dangerous_root_rejection_empties_the_allowlist(monkeypatch):
    """a refused root is dropped, and an empty allowlist rejects everything."""
    monkeypatch.setattr(mod, '_os_family', lambda: 'linux')
    monkeypatch.setattr(mod, '_is_dangerous_root', lambda p: True)
    allowlist = DestinationAllowlist(['/var/lib/owlette/projects'])
    assert allowlist.roots == []
    assert not allowlist.is_allowed('/var/lib/owlette/projects/show1/a.toe')


def test_posix_tilde_resolves_through_the_console_user(monkeypatch):
    """
    under the root daemon `~` must mean the kiosk user's home. the stdlib would
    answer /root (/var/root on macOS), where the operator can see nothing.
    """
    monkeypatch.setattr(mod, '_os_family', lambda: 'linux')
    monkeypatch.setattr(mod, '_running_as_root', lambda: True)
    monkeypatch.setattr(mod, '_console_user_passwd', lambda: FakePasswd('/home/kiosk'))
    assert mod._safe_expanduser('~') == '/home/kiosk'
    assert mod._safe_expanduser('~/projects') == '/home/kiosk/projects'


def test_posix_tilde_without_a_console_user_is_refused(monkeypatch):
    """
    no console user → there is no interactive session, so `~` resolves to
    nothing. the stdlib would answer /root, which the operator cannot even read.
    """
    monkeypatch.setattr(mod, '_os_family', lambda: 'linux')
    monkeypatch.setattr(mod, '_running_as_root', lambda: True)
    monkeypatch.setattr(mod, '_console_user_passwd', lambda: None)
    monkeypatch.setenv('HOME', '/root')
    monkeypatch.setenv('USERPROFILE', '/root')  # ntpath.expanduser reads this one

    with pytest.raises(mod.UnresolvableHomeError):
        mod._safe_expanduser('~/Documents')

    assert mod._safe_expanduser('/root/Documents') == '/root/Documents'


@pytest.mark.skipif(sys.platform == 'win32', reason='pwd resolves `~user` on POSIX')
def test_posix_tilde_user_names_its_own_account(monkeypatch):
    """
    only the bare `~` means "the human at the machine". `~kiosk/...` names an
    account pwd can resolve whoever is signed in, so it is not the daemon's home
    and is not refused with nobody there.
    """
    monkeypatch.setattr(mod, '_os_family', lambda: 'linux')
    monkeypatch.setattr(mod, '_running_as_root', lambda: True)
    monkeypatch.setattr(mod, '_console_user_passwd', lambda: None)
    import pwd

    account = pwd.getpwuid(os.getuid())

    expanded = mod._safe_expanduser(f'~{account.pw_name}/projects')

    assert expanded == f'{account.pw_dir}/projects'


def test_posix_tilde_is_stdlib_when_not_root(monkeypatch):
    """an unprivileged agent is its own user — nothing to redirect."""
    monkeypatch.setattr(mod, '_os_family', lambda: 'linux')
    monkeypatch.setattr(mod, '_running_as_root', lambda: False)
    monkeypatch.setenv('HOME', '/home/dev')
    monkeypatch.setenv('USERPROFILE', '/home/dev')
    assert mod._safe_expanduser('~/projects') == '/home/dev/projects'


def test_expanduser_skips_the_home_lookup_for_a_plain_path(monkeypatch):
    """validate() sends every assembled file path through here, and on POSIX the
    home lookup asks the OS who is at the console. only a leading `~` needs it."""
    def boom():
        raise AssertionError('home lookup on a path with no `~`')

    monkeypatch.setattr(mod, '_privileged_home', boom)
    target = '/var/lib/owlette/projects/show1/a.toe'
    assert mod._safe_expanduser(target) == target


def test_interactive_user_ids_none_when_not_root(monkeypatch):
    """windows has no geteuid, so this is also the windows answer."""
    monkeypatch.setattr(mod, '_running_as_root', lambda: False)
    assert get_interactive_user_ids() is None


def test_interactive_user_ids_come_from_the_console_user(monkeypatch):
    monkeypatch.setattr(mod, '_running_as_root', lambda: True)
    monkeypatch.setattr(
        mod, '_console_user_passwd', lambda: FakePasswd('/home/kiosk', 1001, 1002)
    )
    assert get_interactive_user_ids() == (1001, 1002)


def test_interactive_user_ids_none_when_console_user_unresolved(monkeypatch):
    """no account to hand the files to → leave them root-owned, don't guess."""
    monkeypatch.setattr(mod, '_running_as_root', lambda: True)
    monkeypatch.setattr(mod, '_console_user_passwd', lambda: None)
    assert get_interactive_user_ids() is None


def test_console_user_lookup_retries_until_it_resolves(monkeypatch):
    """
    the daemon starts before the kiosk autologin completes, so the first lookup
    of a run can legitimately find nobody. pinning that answer would leave every
    later sync of the run root-owned and every `~` root refused until a service
    restart, so only a resolved entry is kept.
    """
    import types

    monkeypatch.setattr(mod, '_os_family', lambda: 'linux')
    monkeypatch.setattr(mod, '_cached_console_user_passwd', None)
    monkeypatch.setattr(mod, '_console_user_failed_at', None)
    monkeypatch.setattr(mod, '_CONSOLE_USER_RETRY_SECONDS', 0.0)

    answers = ['', 'kiosk']
    osadapter_stub = types.ModuleType('osadapter')
    osadapter_stub.console_user = lambda: answers.pop(0)
    monkeypatch.setitem(sys.modules, 'osadapter', osadapter_stub)

    entry = FakePasswd('/home/kiosk')
    pwd_stub = types.ModuleType('pwd')
    pwd_stub.getpwnam = lambda name: entry
    monkeypatch.setitem(sys.modules, 'pwd', pwd_stub)

    assert mod._console_user_passwd() is None   # nobody logged in yet
    assert mod._console_user_passwd() is entry  # retried after login
    # and then kept: a third console_user() call would exhaust `answers`.
    assert mod._console_user_passwd() is entry


def test_console_user_failure_is_throttled(monkeypatch):
    """
    the assembler asks once per extracted file and the POSIX lookup asks the OS,
    so a machine with nobody logged in must not pay for it — or warn about it —
    5,000 times in one sync.
    """
    import types

    monkeypatch.setattr(mod, '_os_family', lambda: 'linux')
    monkeypatch.setattr(mod, '_cached_console_user_passwd', None)
    monkeypatch.setattr(mod, '_console_user_failed_at', None)

    calls = []
    osadapter_stub = types.ModuleType('osadapter')

    def console_user():
        calls.append(1)
        return ''

    osadapter_stub.console_user = console_user
    monkeypatch.setitem(sys.modules, 'osadapter', osadapter_stub)

    for _ in range(5):
        assert mod._console_user_passwd() is None
    assert len(calls) == 1
