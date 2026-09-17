"""What the daemon's own loop duties do off Windows.

`import owlette_service` succeeding is not the same as surviving a tick. Two
duties the 5-second loop performs unconditionally still reached a Windows-only
module from inside their own bodies:

* the hoot launcher imported `win32con`/`win32process` above its `try`, so on
  the first tick with hoot enabled the ModuleNotFoundError unwound `main()`
  itself — the loop's `try` carries only a `finally` — and systemd restarted
  the daemon into the same crash;
* the display tick imported `display_manager`, whose module body asserts the
  Windows x64 ABI, so every tick logged a warning that the `displays.enabled`
  kill switch is below and cannot silence.

Methods are bound onto a SimpleNamespace through the descriptor protocol, the
house pattern from test_cortex_process_command.py, so the production bodies run
without building a service.
"""

import logging
import os
import sys
import time
from types import SimpleNamespace

import pytest

import osadapter
import shared_utils

posix_only = pytest.mark.skipif(sys.platform == 'win32', reason='the POSIX arms')

pytestmark = posix_only


def _bound(name, svc):
    from owlette_service import OwletteService

    return getattr(OwletteService, name).__get__(svc, OwletteService)


@pytest.fixture
def console_user(monkeypatch):
    """Whoever is running the suite, standing in for the user at the machine."""
    import pwd

    account = pwd.getpwuid(os.getuid())
    monkeypatch.setattr(osadapter, 'console_user', lambda: account.pw_name)
    return account


def test_a_script_is_launched_as_the_user_at_the_machine(
        console_user, monkeypatch):
    """hoot is a kiosk-user process on every platform — that is what makes
    `ipc/cortex_commands` a user-to-root channel — so the launch goes through
    the adapter's session spawn and never runs as the daemon's own root."""
    spawned = []
    monkeypatch.setattr(
        shared_utils, 'get_python_exe_path',
        lambda: '/opt/owlette/python/bin/python3')
    monkeypatch.setattr(
        osadapter, 'spawn_as_user',
        lambda argv, uid: (spawned.append((argv, uid)), 4321)[1])

    svc = SimpleNamespace(cortex_pid=None)
    svc._spawn_as_console_user = _bound('_spawn_as_console_user', svc)

    # THE negative control: against the previous body this call raises
    # ModuleNotFoundError('win32con') before it reaches any of the assertions.
    assert _bound('launch_python_script_as_user', svc)('owlette_cortex.py') is True

    (argv, uid), = spawned
    assert argv == [
        '/opt/owlette/python/bin/python3', shared_utils.get_path('owlette_cortex.py')]
    assert uid == console_user.pw_uid
    assert svc.cortex_pid == 4321


def test_script_arguments_survive_the_handoff(console_user, monkeypatch):
    """The Windows arm takes a quoted command line; the adapter takes argv, so
    the job path session_exec is handed has to arrive as one token."""
    spawned = []
    monkeypatch.setattr(
        shared_utils, 'get_python_exe_path',
        lambda: '/opt/owlette/python/bin/python3')
    monkeypatch.setattr(
        osadapter, 'spawn_as_user',
        lambda argv, uid: (spawned.append(argv), 4321)[1])

    svc = SimpleNamespace(cortex_pid=None)
    svc._spawn_as_console_user = _bound('_spawn_as_console_user', svc)
    _bound('launch_python_script_as_user', svc)(
        'session_exec.py', '"/var/lib/owlette/ipc/jobs/a b.json"')

    assert spawned[0][-1] == '/var/lib/owlette/ipc/jobs/a b.json'


def test_the_hoot_tick_degrades_when_nobody_is_signed_in(monkeypatch, caplog):
    """The headless case — a rebooted kiosk before anyone logs in, and every
    server-shaped install. It is a skipped launch, not an exception out of the
    loop that runs it."""
    monkeypatch.setattr(osadapter, 'console_user', lambda: None)
    monkeypatch.setattr(shared_utils, 'is_cortex_enabled', lambda config=None: True)
    monkeypatch.setattr(
        shared_utils, 'get_python_exe_path',
        lambda: '/opt/owlette/python/bin/python3')
    monkeypatch.setattr(
        osadapter, 'spawn_as_user',
        lambda argv, uid: pytest.fail('spawned with nobody signed in'))

    svc = SimpleNamespace(
        cortex_pid=None,
        _cortex_last_launch_time=0.0,
        _cortex_launch_cooldown=0,
    )
    for name in ('_is_cortex_alive', 'launch_python_script_as_user',
                 '_spawn_as_console_user'):
        setattr(svc, name, _bound(name, svc))

    with caplog.at_level(logging.DEBUG):
        assert _bound('_try_launch_cortex', svc)() is False
    assert 'no interactive user session' in caplog.text


def test_a_user_session_job_is_refused_rather_than_run_out_of_band(
        tmp_path, monkeypatch):
    """`ipc/jobs` is the resident desktop app's queue off Windows. The Windows
    round-trip writes a job there AND executes it itself, so on POSIX the app
    would run the same job over again - and the result directory it creates at
    the daemon's umask is root-owned 0755 inside a tree the console user is only
    a group member of, so the caller waited out its whole timeout for a result
    that could never be written."""
    monkeypatch.setenv('OWLETTE_DATA_ROOT', str(tmp_path / 'Owlette'))
    started = time.monotonic()

    result = _bound('execute_in_user_session', SimpleNamespace())(
        'python', 'print(1)', timeout=25)

    assert result['error'].startswith('unsupported_on_platform')
    # The negative control is the timeout the caller used to burn instead.
    assert time.monotonic() - started < 1
    assert not (tmp_path / 'Owlette' / 'ipc').exists()


def test_the_display_tick_is_a_no_op_and_says_nothing(caplog):
    """display_manager is never ported, and its import alone raises. Anything
    short of returning first logs a warning on every tick for the life of the
    install — the `displays.enabled` switch is below the import and cannot
    reach it."""
    with caplog.at_level(logging.DEBUG):
        assert _bound('_check_display_topology', SimpleNamespace())() is None

    assert caplog.records == []


def test_a_restart_flag_from_anyone_but_the_daemon_is_ignored_and_removed(
        tmp_path, monkeypatch, caplog):
    """Restarting the agent is a privileged request off Windows — nonce, one
    per five minutes, an audit row — and `tmp/` is group-writable, so a flag
    written there by the console user would be the same restart with none of
    it, on every tick, for as long as they kept writing one."""
    flag = tmp_path / 'restart.flag'
    flag.write_text('')
    monkeypatch.setattr(os, 'geteuid', lambda: flag.stat().st_uid + 1)

    with caplog.at_level(logging.WARNING):
        assert _bound('_restart_requested', SimpleNamespace())(str(flag)) is False

    # Left in place it would log the same refusal every five seconds.
    assert not flag.exists()
    assert 'privileged request' in caplog.text


def test_a_symlink_to_a_root_owned_file_is_not_the_daemons_own_flag(
        tmp_path, monkeypatch, caplog):
    """`os.stat` reports the target's owner, so a link the console user drops
    under this name — to any file root happens to own — read back as the
    daemon's own flag and restarted the agent on every tick with none of the
    seam's nonce, window or audit."""
    target = tmp_path / 'owned-by-the-daemon'
    target.write_text('')
    flag = tmp_path / 'restart.flag'
    flag.symlink_to(target)
    monkeypatch.setattr(os, 'geteuid', lambda: target.stat().st_uid)

    with caplog.at_level(logging.WARNING):
        assert _bound('_restart_requested', SimpleNamespace())(str(flag)) is False

    assert not flag.is_symlink()
    assert target.exists()
    assert 'privileged request' in caplog.text


def test_a_directory_named_like_a_restart_flag_is_removed_whole(
        tmp_path, monkeypatch, caplog):
    """`tmp/` is group-writable, so the name can be taken by a directory —
    which `os.remove` cannot clear, leaving the same refusal in the log every
    five seconds for the life of the install."""
    flag = tmp_path / 'restart.flag'
    flag.mkdir()
    (flag / 'held-open').write_text('')
    monkeypatch.setattr(os, 'geteuid', lambda: flag.stat().st_uid + 1)

    with caplog.at_level(logging.WARNING):
        assert _bound('_restart_requested', SimpleNamespace())(str(flag)) is False

    assert not flag.exists()


def test_the_daemons_own_restart_flag_still_restarts_the_agent(tmp_path):
    """The negative control: the flag is how the self-update and the seam's
    `restart` verb end this process, and neither may be blocked by the guard
    above."""
    flag = tmp_path / 'restart.flag'
    flag.write_text('')

    assert _bound('_restart_requested', SimpleNamespace())(str(flag)) is True
    assert flag.exists()


def test_no_restart_flag_is_not_a_restart(tmp_path):
    assert _bound('_restart_requested', SimpleNamespace())(
        str(tmp_path / 'nothing')) is False
