"""Install-tree hardening in the service (3.3.6).

Covers the service-side changes: the start-up ACL repair and its anomaly
event, the session-change repair and the console watch that starts it, the
stale update-installer sweep, the Cortex queue's owner, size and schema gate,
the process-launcher handoff (an exclusively created pid file with its own DACL,
a deny-write args file, and a pid that must descend from the helper), the owner
gate on the stop sentinel and the update marker, and the status files' route
through the DACL-aware JSON writer.

Every Win32 security call is mocked at a seam (acl_hardening.repair_all / apply
/ console_user_sid / _native_read_owner, owlette_service._token_user_sid /
_console_session) and psutil is replaced by a fake process table, so nothing
touches a real security descriptor, the live install, the live console session
or a real process tree. The files themselves are real, in tmp_path, because
is_trusted_owner's link checks read real stat data. owlette_service is imported
lazily, as in test_cortex_process_command.py.
"""

import contextlib
import json
import logging
import os
import shutil
import sys
import threading
import time
from types import SimpleNamespace
from unittest.mock import MagicMock

import psutil
import pytest
import win32process
import win32profile
import win32security as ws
import win32ts

import osadapter


_SYSTEM_SID_STR = 'S-1-5-18'
_HELPER_SID_STR = 'S-1-5-21-111-222-333-1001'
_OTHER_SID_STR = 'S-1-5-21-111-222-333-1002'
_HELPER_SID = ws.ConvertStringSidToSid(_HELPER_SID_STR)


class _Proc:
    """The psutil.Process surface the handoff and the identity record read."""

    def __init__(self, pid, ppid, create_time, exe=''):
        self.pid = pid
        self._ppid = ppid
        self._create_time = create_time
        self._exe = exe

    def ppid(self):
        return self._ppid

    def create_time(self):
        return self._create_time

    def exe(self):
        return self._exe

    def oneshot(self):
        return contextlib.nullcontext()


def _process_table(monkeypatch, table):
    def process(pid):
        if pid not in table:
            raise psutil.NoSuchProcess(pid)
        return table[pid]
    monkeypatch.setattr(psutil, 'Process', process)


def _owned_by(monkeypatch, sid_str):
    """Every file reads as owned by sid_str. The real is_trusted_owner runs,
    link checks included."""
    import acl_hardening
    monkeypatch.setattr(acl_hardening, '_native_read_owner',
                        lambda path: ws.ConvertStringSidToSid(sid_str))


def _bind(svc, name):
    from owlette_service import OwletteService
    return getattr(OwletteService, name).__get__(svc, OwletteService)


# ----- start-up repair -------------------------------------------------------

class TestStartupRepair:
    @staticmethod
    def _paths():
        import acl_hardening
        fixed = next(e.path for e in acl_hardening.specs() if e.path.endswith('python'))
        token = next(e.path for e in acl_hardening.specs() if e.path.endswith('.tokens.enc'))
        return fixed, token

    @staticmethod
    def _run(svc, monkeypatch, repaired):
        import owlette_service
        monkeypatch.setattr(
            owlette_service.acl_hardening, 'repair_all', lambda log: list(repaired))
        _bind(svc, '_repair_install_acls')()

    def test_drift_on_a_fixed_entry_is_queued_as_the_anomaly_event(self, monkeypatch):
        fixed, token = self._paths()
        svc = SimpleNamespace(_pending_anomaly_event=None)

        self._run(svc, monkeypatch, [fixed, token])

        action, details = svc._pending_anomaly_event
        assert action == 'install_permissions_repaired'
        assert fixed in details
        # the token file follows the console user; its repair is not drift.
        assert token not in details

    def test_console_user_entries_raise_no_event(self, monkeypatch):
        _, token = self._paths()
        svc = SimpleNamespace(_pending_anomaly_event=None)

        self._run(svc, monkeypatch, [token])

        assert svc._pending_anomaly_event is None

    def test_a_clean_tree_logs_ok_and_queues_nothing(self, monkeypatch, caplog):
        svc = SimpleNamespace(_pending_anomaly_event=None)

        with caplog.at_level(logging.INFO):
            self._run(svc, monkeypatch, [])

        assert 'acl hardening: ok' in caplog.text
        assert svc._pending_anomaly_event is None

    def test_the_session_classifier_event_is_not_overwritten(self, monkeypatch):
        fixed, _ = self._paths()
        classified = ('unexpected_reboot', 'boot detected with no shutdown signal')
        svc = SimpleNamespace(_pending_anomaly_event=classified)

        self._run(svc, monkeypatch, [fixed])

        assert svc._pending_anomaly_event == classified


def test_console_user_entries_are_the_token_file_and_the_cortex_queues():
    import owlette_service
    names = sorted(os.path.basename(p) for p in owlette_service._console_user_acl_paths())
    assert names == ['.tokens.enc', '.tokens.enc.v1',
                     'cortex_commands', 'cortex_events', 'cortex_results']


def test_main_snapshots_the_console_then_repairs_after_the_classifier(monkeypatch):
    lock = threading.Lock()
    """main() order: the classifier resets the anomaly slot, so the repair runs
    after it; the console is read before the repair, so the watcher repairs
    again after any later change; session repairs are enabled before the
    sweep. The state is set in main() because owlette_runner never runs
    __init__."""
    import owlette_service

    class _Stop(BaseException):
        """Not an Exception, so main()'s non-fatal wrappers let it through."""

    order = []
    svc = MagicMock()
    svc._acl_repair_lock = lock
    svc._classify_startup_session.side_effect = lambda: order.append('classify')
    svc._repair_install_acls.side_effect = lambda: order.append('repair')

    def _console():
        order.append('console')
        return (1, 'alice')

    def _sweep():
        order.append(('sweep', svc._acl_startup_repaired))
        raise _Stop()

    monkeypatch.setattr(owlette_service, '_console_session', _console)
    svc._sweep_stale_update_installers.side_effect = _sweep
    monkeypatch.setattr(
        owlette_service.shared_utils, 'harden_existing_json', lambda path: None)
    monkeypatch.setattr(
        owlette_service.shared_utils, 'log_startup_system_snapshot', lambda: None)
    monkeypatch.setattr(
        owlette_service.shared_utils, 'log_startup_config_summary', lambda: None)

    with pytest.raises(_Stop):
        _bind(svc, 'main')()

    assert order == ['classify', 'console', 'repair', ('sweep', True)]
    assert svc._acl_console == (1, 'alice')
    # the lock is declared by _init_state; main() must not replace it.
    assert svc._acl_repair_lock is lock


def test_main_checks_app_states_permissions_after_the_repair(monkeypatch):
    """An upgrade leaves tmp\\app_states.json with the ACL it was created under,
    and an idle machine never rewrites it. main() checks it once, after the
    start-up repair, and a failure there does not stop the start-up."""
    import owlette_service

    class _Stop(BaseException):
        """Not an Exception, so main()'s non-fatal wrappers let it through."""

    order = []
    svc = MagicMock()
    svc._repair_install_acls.side_effect = lambda: order.append('repair')

    def _harden(path):
        order.append(('harden', path))
        raise RuntimeError('denied')

    def _sweep():
        order.append('sweep')
        raise _Stop()

    svc._sweep_stale_update_installers.side_effect = _sweep
    monkeypatch.setattr(owlette_service, '_console_session', lambda: (1, 'alice'))
    monkeypatch.setattr(
        owlette_service.shared_utils, 'harden_existing_json', _harden)
    monkeypatch.setattr(
        owlette_service.shared_utils, 'log_startup_system_snapshot', lambda: None)
    monkeypatch.setattr(
        owlette_service.shared_utils, 'log_startup_config_summary', lambda: None)

    with pytest.raises(_Stop):
        _bind(svc, 'main')()

    assert order == [
        'repair',
        ('harden', owlette_service.shared_utils.RESULT_FILE_PATH),
        'sweep',
    ]


# ----- session-change repair -------------------------------------------------

class TestSessionChangeRepair:
    @pytest.fixture
    def console(self, monkeypatch):
        import owlette_service
        session = {'id': 1}
        monkeypatch.setattr(
            win32ts, 'WTSGetActiveConsoleSessionId', lambda: session['id'])
        monkeypatch.setattr(
            win32ts, 'WTSQueryUserToken', lambda session_id: MagicMock())
        monkeypatch.setattr(
            win32profile, 'CreateEnvironmentBlock', lambda token, inherit: {})
        return session

    @staticmethod
    def _service(startup_repaired):
        return SimpleNamespace(
            console_user_token=None, environment=None, _last_logged_session_id=None,
            _acl_startup_repaired=startup_repaired, _start_session_acl_repair=MagicMock())

    def test_a_new_console_session_starts_one_repair(self, console):
        svc = self._service(startup_repaired=True)
        refresh = _bind(svc, '_refresh_user_token')

        refresh()
        refresh()
        assert svc._start_session_acl_repair.call_count == 1

        console['id'] = 2
        refresh()
        assert svc._start_session_acl_repair.call_count == 2

    def test_nothing_starts_before_the_startup_repair(self, console):
        svc = self._service(startup_repaired=False)

        _bind(svc, '_refresh_user_token')()

        svc._start_session_acl_repair.assert_not_called()

    def test_the_repair_runs_on_a_daemon_thread_as_a_session_change(self, monkeypatch):
        import owlette_service
        seen = []
        done = threading.Event()

        def fake_repair(log, session_change=False):
            seen.append((threading.current_thread().name, session_change))
            done.set()
            return []

        monkeypatch.setattr(owlette_service.acl_hardening, 'repair_all', fake_repair)
        svc = SimpleNamespace(_acl_repair_lock=threading.Lock())

        _bind(svc, '_start_session_acl_repair')()

        assert done.wait(5)
        assert seen == [('acl-session-repair', True)]


# ----- console watch ---------------------------------------------------------

class TestConsoleWatch:
    """A login is noticed on the local config watcher's tick even when the
    service launches nothing: a desktop app started from the Startup folder,
    no configured process, no Cortex."""

    @staticmethod
    def _watcher(console_at_start_up):
        svc = SimpleNamespace(_acl_console=console_at_start_up, _start_session_acl_repair=MagicMock())
        svc.check = _bind(svc, '_check_console_session')
        return svc

    def test_a_login_with_no_launch_still_repairs(self, monkeypatch):
        import owlette_service
        calls = []
        done = threading.Event()

        def fake_repair(log, session_change=False):
            calls.append(session_change)
            done.set()
            return []

        monkeypatch.setattr(owlette_service.acl_hardening, 'repair_all', fake_repair)
        # the boot's logon screen, then the same session with a user in it.
        console = {'now': (1, '')}
        monkeypatch.setattr(owlette_service, '_console_session', lambda: console['now'])
        svc = SimpleNamespace(_acl_console=(1, ''), _acl_repair_lock=threading.Lock())
        svc._start_session_acl_repair = _bind(svc, '_start_session_acl_repair')
        check = _bind(svc, '_check_console_session')

        check()
        assert not done.wait(0.2)

        console['now'] = (1, 'alice')
        check()

        assert done.wait(5)
        assert calls == [True]
        assert svc._acl_console == (1, 'alice')

    def test_a_new_session_or_user_repairs_once_each(self, monkeypatch):
        import owlette_service
        svc = self._watcher((1, 'alice'))
        for now in [(1, 'alice'), (2, ''), (2, ''), (2, 'bob'), (2, 'bob')]:
            monkeypatch.setattr(owlette_service, '_console_session', lambda now=now: now)
            svc.check()

        assert svc._start_session_acl_repair.call_count == 2
        assert svc._acl_console == (2, 'bob')

    def test_nothing_happens_while_a_session_is_being_attached(self, monkeypatch):
        import owlette_service
        monkeypatch.setattr(owlette_service, '_console_session', lambda: None)
        svc = self._watcher((1, 'alice'))

        svc.check()

        svc._start_session_acl_repair.assert_not_called()
        assert svc._acl_console == (1, 'alice')

    def test_every_config_watcher_tick_looks_at_the_console(self, monkeypatch):
        import owlette_service
        monkeypatch.setattr(owlette_service, 'LOCAL_CONFIG_POLL_INTERVAL', 0)
        ticks = []
        svc = SimpleNamespace(is_alive=True, _check_local_config_changes=MagicMock(
            side_effect=RuntimeError('a bad config tick')))

        def check():
            ticks.append(1)
            if len(ticks) == 3:
                svc.is_alive = False

        svc._check_console_session = check

        _bind(svc, 'start_local_config_watcher')().join(timeout=5)

        # a failing config check must not keep the console from being looked at.
        assert len(ticks) == 3

    def test_the_console_read_is_the_session_and_its_user(self, monkeypatch):
        import owlette_service
        monkeypatch.setattr(win32ts, 'WTSGetActiveConsoleSessionId', lambda: 3)
        monkeypatch.setattr(win32ts, 'WTSQuerySessionInformation',
                            lambda server, session_id, info_class: f'user-of-{session_id}')

        assert owlette_service._console_session() == (3, 'user-of-3')

    def test_a_detached_or_unreadable_console_reads_as_none(self, monkeypatch):
        import owlette_service
        monkeypatch.setattr(
            win32ts, 'WTSGetActiveConsoleSessionId', lambda: 0xFFFFFFFF)
        assert owlette_service._console_session() is None

        monkeypatch.setattr(win32ts, 'WTSGetActiveConsoleSessionId', lambda: 1)

        def fail(*args):
            raise OSError('rpc unavailable')

        monkeypatch.setattr(win32ts, 'WTSQuerySessionInformation', fail)
        assert owlette_service._console_session() is None


# ----- stale update installers ----------------------------------------------

def test_stale_update_installers_are_removed_one_file_at_a_time(tmp_path, monkeypatch):
    import owlette_service
    tmp_dir = tmp_path / 'tmp'
    tmp_dir.mkdir()
    monkeypatch.setattr(
        owlette_service.shared_utils, 'get_data_path', lambda filename=None: str(tmp_dir))

    stale = ['owlette-Update.exe', 'owlette-Update_1726912345.exe', 'OWLETTE-UPDATE-OLD.EXE']
    kept = ['owlette-Update.exe.log', 'other.exe', 'app_states.json']
    for name in stale + kept:
        (tmp_dir / name).write_bytes(b'MZ')
    trap = tmp_dir / 'owlette-Update-dir.exe'
    trap.mkdir()
    (trap / 'inside.txt').write_text('keep')

    removed = []
    real_remove = os.remove

    def spy(path):
        removed.append(os.path.basename(path))
        real_remove(path)

    monkeypatch.setattr(owlette_service.os, 'remove', spy)

    _bind(SimpleNamespace(), '_sweep_stale_update_installers')()

    assert sorted(removed) == sorted(stale)
    assert sorted(p.name for p in tmp_dir.iterdir()) == sorted(kept + [trap.name])
    assert (trap / 'inside.txt').read_text() == 'keep'


# ----- stop sentinel ---------------------------------------------------------

class TestStopSentinel:
    @pytest.fixture
    def sentinel(self, tmp_path, monkeypatch):
        import owlette_service
        path = tmp_path / 'stop_signal.json'
        monkeypatch.setattr(owlette_service, 'STOP_SENTINEL_PATH', str(path))
        return path

    @staticmethod
    def _service():
        from owlette_service import OwletteService
        return object.__new__(OwletteService)

    @staticmethod
    def _read(svc):
        return svc._read_stop_sentinel(time.time() - 60)

    def test_an_untrusted_sentinel_is_ignored_and_deleted(self, sentinel, monkeypatch, caplog):
        _owned_by(monkeypatch, _OTHER_SID_STR)
        svc = self._service()

        sentinel.write_text('{"control": "stop"}')
        with caplog.at_level(logging.DEBUG):
            assert self._read(svc) is None
        assert not sentinel.exists()
        assert any(r.levelno == logging.WARNING and 'stop sentinel' in r.getMessage()
                   for r in caplog.records)

        # polled four times a second: only the first one warns.
        caplog.clear()
        sentinel.write_text('{"control": "stop"}')
        with caplog.at_level(logging.DEBUG):
            assert self._read(svc) is None
        assert not sentinel.exists()
        assert not [r for r in caplog.records if r.levelno >= logging.WARNING]

    def test_a_sentinel_from_system_is_obeyed(self, sentinel, monkeypatch):
        _owned_by(monkeypatch, _SYSTEM_SID_STR)
        sentinel.write_text('{"control": "stop"}')

        assert self._read(self._service()) == 'stop'
        assert sentinel.exists()

    def test_a_hard_link_to_a_system_owned_file_is_not_a_stop(
            self, sentinel, tmp_path, monkeypatch):
        _owned_by(monkeypatch, _SYSTEM_SID_STR)
        target = tmp_path / 'service.log'
        target.write_text('log line')
        os.link(target, sentinel)

        assert self._read(self._service()) is None
        assert not sentinel.exists()
        assert target.read_text() == 'log line'


# ----- update marker ---------------------------------------------------------

@pytest.fixture
def marker(tmp_path, monkeypatch):
    """A fresh update marker in a sandboxed ProgramData."""
    monkeypatch.setenv(osadapter.DATA_ROOT_ENV, str(tmp_path / 'Owlette'))
    logs = tmp_path / 'owlette' / 'logs'
    logs.mkdir(parents=True)
    path = logs / 'update_in_progress.json'
    path.write_text(json.dumps({
        'started_at': time.strftime('%Y-%m-%d %H:%M:%S'),
        'old_version': '3.3.5',
        'target_version': '3.3.6',
        'command_id': 'forged-command',
        'deployment_id': 'forged-deployment',
    }))
    return path


def test_an_untrusted_marker_is_never_reported(marker, monkeypatch):
    import owlette_service
    _owned_by(monkeypatch, _OTHER_SID_STR)
    # the trusted path queries and deletes scheduled tasks; a test must not.
    monkeypatch.setattr(owlette_service.subprocess, 'run',
                        MagicMock(side_effect=AssertionError('schtasks from a test')))
    svc = SimpleNamespace()

    _bind(svc, '_check_update_status')()

    assert not marker.exists()
    assert not hasattr(svc, '_pending_update_completion')
    assert not hasattr(svc, '_pending_update_event')


class TestSelfUpdateGuard:
    @staticmethod
    def _update(monkeypatch, trusted):
        import owlette_service
        _owned_by(monkeypatch, _SYSTEM_SID_STR if trusted else _OTHER_SID_STR)
        monkeypatch.setattr(shutil, 'disk_usage', lambda path: SimpleNamespace(free=10 * 1024 ** 3))
        # the staging directory's creation and dacl are test_self_update_hardening's.
        monkeypatch.setattr(owlette_service.acl_hardening, 'create_private_dir', MagicMock())
        download = MagicMock(return_value=(False, None))
        monkeypatch.setattr(owlette_service.installer_utils, 'download_file', download)
        svc = SimpleNamespace(
            _command_rate_limits={}, COMMAND_RATE_LIMIT_SECONDS=0,
            _command_router=SimpleNamespace(has_handler=lambda cmd_type: False),
            firebase_client=None)
        result = _bind(svc, 'handle_firebase_command')('cmd-1', {
            'type': 'update_owlette',
            'installer_url': 'https://example.invalid/Owlette-Installer-v9.9.9.exe',
            'checksum_sha256': 'a' * 64,
        })
        return result, download

    def test_an_untrusted_marker_does_not_hold_off_the_update(self, marker, monkeypatch):
        result, download = self._update(monkeypatch, trusted=False)

        assert 'already in progress' not in result
        download.assert_called_once()
        assert not marker.exists()

    def test_an_untrusted_marker_is_ignored_even_when_it_cannot_be_deleted(
            self, marker, monkeypatch):
        import owlette_service
        real_remove = os.remove

        def refuse(path):
            if os.path.normcase(str(path)) == os.path.normcase(str(marker)):
                raise PermissionError('held open by the account that planted it')
            real_remove(path)

        monkeypatch.setattr(owlette_service.os, 'remove', refuse)

        result, download = self._update(monkeypatch, trusted=False)

        assert 'already in progress' not in result
        download.assert_called_once()

    def test_the_service_s_own_marker_still_blocks_a_second_update(self, marker, monkeypatch):
        result, download = self._update(monkeypatch, trusted=True)

        assert result.startswith('Update already in progress')
        download.assert_not_called()
        assert marker.exists()


# ----- status files ----------------------------------------------------------

@pytest.fixture
def status(tmp_path, monkeypatch):
    """A bare service whose status writes land in tmp_path and are recorded."""
    import owlette_service
    import shared_utils
    monkeypatch.setattr(owlette_service, '_status_writer_logger',
                        logging.getLogger('test.status_writer'))
    monkeypatch.setattr(shared_utils, 'get_data_path', lambda rel: str(tmp_path / rel))
    monkeypatch.setattr(shared_utils, 'read_config', lambda keys=None: False)
    monkeypatch.setattr(shared_utils, 'RESULT_FILE_PATH', str(tmp_path / 'app_states.json'))
    writes = []
    real_write = shared_utils.write_json_to_file
    state = SimpleNamespace(writes=writes, calls=[], fail=False,
                            path=tmp_path / 'tmp' / 'service_status.json')

    def recording_write(data, file_path, *args, **kwargs):
        writes.append(os.path.basename(file_path))
        state.calls.append((os.path.basename(file_path), kwargs))
        if not state.fail:  # a failure is logged inside and never raised
            real_write(data, file_path, *args, **kwargs)

    monkeypatch.setattr(shared_utils, 'write_json_to_file', recording_write)
    svc = object.__new__(owlette_service.OwletteService)
    svc.firebase_client = None
    svc._last_status_signature = None
    svc._last_status_write_time = 0.0
    svc._health_state = None
    state.svc = svc
    return state


class TestStatusFiles:
    def test_every_status_file_goes_through_the_dacl_aware_writer(self, status):
        import owlette_service

        status.svc._write_service_status_early()
        status.svc._write_service_status()
        owlette_service.Util.initialize_results_file()

        assert status.writes == ['service_status.json', 'service_status.json', 'app_states.json']
        assert json.loads(status.path.read_text())['service']['running'] is True

    def test_a_failed_write_is_retried_on_the_next_tick_as_before(self, status):
        status.fail = True
        status.svc._write_service_status()

        # nothing replaced the file, so the throttle did not move.
        assert status.svc._last_status_signature is None
        assert status.svc._last_status_write_time == 0.0

        status.fail = False
        status.svc._write_service_status()

        assert status.writes == ['service_status.json', 'service_status.json']
        assert status.path.exists()
        assert status.svc._last_status_signature is not None

    def test_an_unchanged_status_is_still_throttled(self, status):
        status.svc._write_service_status()
        status.svc._write_service_status()

        assert status.writes == ['service_status.json']

    def test_only_the_loop_s_status_write_is_single_attempt(self, status):
        """_write_service_status runs on the 5-second loop, which must never
        sleep: one attempt, no retry backoff. The start-up writers keep the
        writer's retries."""
        import owlette_service

        status.svc._write_service_status_early()
        status.svc._write_service_status()
        owlette_service.Util.initialize_results_file()

        assert status.calls == [
            ('service_status.json', {}),
            ('service_status.json', {'max_retries': 1}),
            ('app_states.json', {}),
        ]


# ----- cortex queue ----------------------------------------------------------

_CONSOLE_SID = ws.ConvertStringSidToSid(_HELPER_SID_STR)
_RESTART = {'id': 'ctx_1_abc123', 'tool_name': 'restart_process',
            'tool_params': {'process_name': 'TouchDesigner'}, 'timestamp': 1.5}


@pytest.fixture
def queue(tmp_path, monkeypatch):
    import acl_hardening
    import owlette_service
    import shared_utils
    cmd_dir = tmp_path / 'cortex_commands'
    cmd_dir.mkdir()
    result_dir = tmp_path / 'cortex_results'
    monkeypatch.setattr(shared_utils, 'CORTEX_IPC_CMD_DIR', str(cmd_dir))
    monkeypatch.setattr(shared_utils, 'CORTEX_IPC_RESULT_DIR', str(result_dir))
    monkeypatch.setattr(shared_utils, 'read_config', lambda *a, **k: {
        'processes': [{'id': 'proc-1', 'name': 'TouchDesigner'}]})
    monkeypatch.setattr(owlette_service.acl_hardening, 'console_user_sid', lambda: _CONSOLE_SID)
    owner = {'sid': _HELPER_SID_STR}
    monkeypatch.setattr(acl_hardening, '_native_read_owner',
                        lambda path: ws.ConvertStringSidToSid(owner['sid']))
    svc = SimpleNamespace(
        _execute_cortex_command=MagicMock(return_value={'status': 'completed'}))

    def put(payload, name='cmd.json'):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        (cmd_dir / name).write_bytes(data)

    return SimpleNamespace(cmd_dir=cmd_dir, result_dir=result_dir, owner=owner, svc=svc,
                           drain=_bind(svc, '_drain_cortex_ipc_commands'), put=put)


def _results(queue):
    if not queue.result_dir.exists():
        return {}
    return {p.name: json.loads(p.read_text()) for p in queue.result_dir.iterdir()}


class TestCortexQueue:
    def test_a_command_from_the_console_user_runs(self, queue):
        queue.put(_RESTART)

        queue.drain()

        queue.svc._execute_cortex_command.assert_called_once_with(
            'restart_process', {'process_name': 'TouchDesigner'})
        assert _results(queue) == {'ctx_1_abc123.json': {
            'id': 'ctx_1_abc123', 'result': {'status': 'completed'}}}
        assert not list(queue.cmd_dir.iterdir())

    def test_a_command_owned_by_another_user_is_refused_and_deleted(self, queue):
        queue.owner['sid'] = _OTHER_SID_STR
        queue.put(_RESTART)

        queue.drain()

        queue.svc._execute_cortex_command.assert_not_called()
        assert _results(queue) == {}
        assert not list(queue.cmd_dir.iterdir())

    def test_a_hard_link_to_a_console_user_file_is_refused(self, queue, tmp_path):
        # another account writes a command into a console-user-owned file it
        # can modify (a log) and links it into the queue.
        log = tmp_path / 'cortex.log'
        log.write_text(json.dumps(_RESTART))
        os.link(log, queue.cmd_dir / 'cmd.json')

        queue.drain()

        queue.svc._execute_cortex_command.assert_not_called()
        assert not list(queue.cmd_dir.iterdir())
        assert json.loads(log.read_text()) == _RESTART

    def test_an_oversize_command_is_refused_and_deleted(self, queue):
        queue.put({**_RESTART, 'tool_params': {'process_name': 'x' * (64 * 1024)}})

        queue.drain()

        queue.svc._execute_cortex_command.assert_not_called()
        assert _results(queue) == {}
        assert not list(queue.cmd_dir.iterdir())

    def test_an_unknown_key_is_refused_with_the_reason(self, queue):
        queue.put({**_RESTART, 'run_as': 'SYSTEM'})

        queue.drain()

        queue.svc._execute_cortex_command.assert_not_called()
        assert _results(queue) == {'ctx_1_abc123.json': {
            'id': 'ctx_1_abc123', 'result': {'error': 'command refused: unexpected keys'}}}
        assert not list(queue.cmd_dir.iterdir())

    def test_an_id_that_is_a_path_writes_nothing(self, queue, tmp_path):
        queue.put({**_RESTART, 'id': '..\\..\\escaped'})

        queue.drain()

        queue.svc._execute_cortex_command.assert_not_called()
        assert not queue.result_dir.exists()
        # where the old code would have written it: two levels above the results.
        assert not (tmp_path.parent / 'escaped.json').exists()
        assert not list(queue.cmd_dir.iterdir())


_NAMES = {'touchdesigner'}


@pytest.mark.parametrize('cmd, reason', [
    ({**_RESTART, 'extra': 1}, 'unexpected keys'),
    ({**_RESTART, 'timestamp': 'now'}, 'timestamp is not a number'),
    ({**_RESTART, 'tool_name': 'run_command'}, 'unknown tool'),
    ({**_RESTART, 'tool_name': ['restart_process']}, 'unknown tool'),
    ({**_RESTART, 'tool_params': ['TouchDesigner']}, 'tool_params is not an object'),
    ({**_RESTART, 'tool_params': {}}, 'unexpected tool_params for restart_process'),
    ({**_RESTART, 'tool_name': 'kill_process',
      'tool_params': {'process_name': 'TouchDesigner', 'force': True}},
     'unexpected tool_params for kill_process'),
    ({**_RESTART, 'tool_params': {'process_name': 'explorer'}},
     'process_name is not a configured process'),
    ({**_RESTART, 'tool_params': {'process_name': 7}},
     'process_name is not a configured process'),
    ({**_RESTART, 'tool_name': 'set_launch_mode',
      'tool_params': {'process_name': 'TouchDesigner', 'mode': 'on'}},
     'mode is not one of off, always, scheduled'),
    ({**_RESTART, 'tool_name': 'set_launch_mode',
      'tool_params': {'process_name': 'TouchDesigner', 'mode': ['off']}},
     'mode is not one of off, always, scheduled'),
    ({**_RESTART, 'tool_name': 'set_launch_mode',
      'tool_params': {'process_name': 'TouchDesigner', 'schedules': 'daily'}},
     'schedules is not a list'),
    ({**_RESTART, 'tool_name': 'capture_screenshot', 'tool_params': {'monitor': True}},
     'monitor is not a non-negative integer'),
    ({**_RESTART, 'tool_name': 'capture_screenshot', 'tool_params': {'monitor': -1}},
     'monitor is not a non-negative integer'),
])
def test_anything_but_a_cortex_tool_call_is_refused(cmd, reason):
    import owlette_service
    assert owlette_service._cortex_command_refusal(cmd, _NAMES) == reason


@pytest.mark.parametrize('cmd', [
    {**_RESTART, 'tool_params': {'process_name': 'touchdesigner'}},
    {'id': 'c1', 'tool_name': 'start_process', 'tool_params': {'process_name': 'TouchDesigner'}},
    {'id': 'c1', 'tool_name': 'set_launch_mode',
     'tool_params': {'process_name': 'TouchDesigner', 'mode': 'scheduled', 'schedules': []}},
    {'id': 'c1', 'tool_name': 'capture_screenshot', 'tool_params': {}},
    {'id': 'c1', 'tool_name': 'capture_screenshot', 'tool_params': {'monitor': 2}},
])
def test_the_shapes_cortex_writes_are_accepted(cmd):
    import owlette_service
    assert owlette_service._cortex_command_refusal(cmd, _NAMES) is None


# ----- process-launcher handoff ---------------------------------------------

class TestPidDescendsFrom:
    NOT_BEFORE = 1000.0
    HELPER = 50

    @pytest.fixture(autouse=True)
    def table(self, monkeypatch):
        _process_table(monkeypatch, {
            60: _Proc(60, 50, 1001.0),   # the helper's child
            70: _Proc(70, 60, 1002.0),   # its grandchild
            61: _Proc(61, 50, 999.0),    # older than the launch: a recycled parent pid
            80: _Proc(80, 4, 1001.0),    # someone else's child
            4: _Proc(4, 0, 1.0),
        })

    def _check(self, pid):
        import owlette_service
        return owlette_service._pid_descends_from(pid, self.HELPER, self.NOT_BEFORE)

    def test_a_child_of_the_helper_is_accepted(self):
        assert self._check(60) is True

    def test_a_grandchild_of_the_helper_is_accepted(self):
        assert self._check(70) is True

    def test_a_process_outside_the_helper_s_tree_is_refused(self):
        assert self._check(80) is False

    def test_a_process_older_than_the_launch_is_refused(self):
        assert self._check(61) is False

    def test_a_dead_pid_is_refused(self):
        assert self._check(99) is False

    @pytest.mark.parametrize('pid', ['60', 60.0, True, None])
    def test_a_pid_that_is_not_an_int_is_refused(self, pid):
        assert self._check(pid) is False


def test_the_ancestry_walk_stops_after_five_levels(monkeypatch):
    import owlette_service
    table = {pid: _Proc(pid, pid - 1, 1001.0) for pid in range(102, 107)}
    table[101] = _Proc(101, 50, 1001.0)
    _process_table(monkeypatch, table)

    assert owlette_service._pid_descends_from(105, 50, 1000.0) is True
    assert owlette_service._pid_descends_from(106, 50, 1000.0) is False


@pytest.fixture
def handoff(tmp_path, monkeypatch):
    """launch_process_as_user with the user-session spawn faked: the fake
    helper (pid 50) records what it could see and do, then reports a pid."""
    import owlette_service
    import shared_utils

    monkeypatch.setenv(osadapter.DATA_ROOT_ENV, str(tmp_path / 'Owlette'))
    tmp_dir = tmp_path / 'Owlette' / 'tmp'
    tmp_dir.mkdir(parents=True)
    assert shared_utils.get_data_path('tmp') == str(tmp_dir)
    monkeypatch.setattr(shared_utils, 'get_python_exe_path', lambda: sys.executable)
    monkeypatch.setattr(shared_utils, 'RESULT_FILE_PATH', str(tmp_path / 'app_states.json'))
    exe = tmp_path / 'target-app.exe'
    exe.write_bytes(b'')

    state = SimpleNamespace(report={'pid': 4242}, seen={}, applied=[], tmp_dir=tmp_dir,
                            exe=str(exe), app_states=tmp_path / 'app_states.json')

    def fake_create_process_as_user(token, app_name, command_line, *rest):
        args_file = command_line.rsplit('"', 2)[-2]
        with open(args_file, 'r') as f:
            launch_args = json.load(f)
        state.seen['pid_file'] = launch_args['pid_file']
        state.seen['pid_file_size'] = os.path.getsize(launch_args['pid_file'])
        try:
            open(args_file, 'a').close()
            state.seen['args_writable'] = True
        except PermissionError:
            state.seen['args_writable'] = False
        with open(launch_args['pid_file'], 'w') as f:
            json.dump(state.report, f)
        return None, None, 50, 0

    monkeypatch.setattr(win32process, 'CreateProcessAsUser',
                        fake_create_process_as_user)
    monkeypatch.setattr(owlette_service, '_token_user_sid', lambda token: _HELPER_SID)
    monkeypatch.setattr(owlette_service.acl_hardening, 'apply',
                        lambda path, spec: state.applied.append((path, spec)))
    # the service creates the pid file, so in production system owns it.
    _owned_by(monkeypatch, _SYSTEM_SID_STR)

    svc = SimpleNamespace(
        console_user_token=object(), environment=None, firebase_client=None,
        _refresh_user_token=lambda: None,
        _find_running_process_by_exe=MagicMock(return_value=None),
        _validate_path=owlette_service.OwletteService._validate_path,
        # dev's tail: both launch arms end in _record_launch, which returns the pid
        _record_launch=lambda process, pid: pid)
    state.svc = svc
    state.launch = lambda: _bind(svc, 'launch_process_as_user')(
        {'id': 'proc-x', 'name': 'Target', 'exe_path': state.exe})
    return state


def _child(ppid, exe):
    """pid 4242, created a minute from now: after any launch in the test."""
    return _Proc(4242, ppid, time.time() + 60, exe)


class TestLaunchHandoff:
    def test_the_pid_file_exists_before_the_helper_and_only_its_user_may_write(
            self, handoff, monkeypatch):
        import acl_hardening
        _process_table(monkeypatch, {4242: _child(50, handoff.exe)})

        assert handoff.launch() == 4242

        assert handoff.seen['pid_file_size'] == 0
        [(path, spec)] = handoff.applied
        assert path == handoff.seen['pid_file']
        assert [(ws.ConvertSidToStringSid(sid), mask, flags) for sid, mask, flags in spec] == [
            (ws.ConvertSidToStringSid(acl_hardening.SID_SYSTEM), 0x1F01FF, 0),
            (ws.ConvertSidToStringSid(acl_hardening.SID_ADMINISTRATORS), 0x1F01FF, 0),
            (_HELPER_SID_STR, 0x1301BF, 0),
        ]
        assert not list(handoff.tmp_dir.iterdir())

    def test_the_args_file_cannot_be_rewritten_while_the_helper_runs(
            self, handoff, monkeypatch):
        _process_table(monkeypatch, {4242: _child(50, handoff.exe)})

        handoff.launch()

        assert handoff.seen['args_writable'] is False

    def test_a_pid_the_helper_did_not_start_is_refused(self, handoff, monkeypatch):
        # a forged answer naming a process outside the helper's tree.
        _process_table(monkeypatch, {4242: _child(7, handoff.exe)})

        assert handoff.launch() is None

        handoff.svc._find_running_process_by_exe.assert_called_once()
        assert not handoff.app_states.exists()

    def test_a_pid_file_replaced_by_another_account_is_ignored(
            self, handoff, monkeypatch):
        _process_table(monkeypatch, {4242: _child(50, handoff.exe)})
        _owned_by(monkeypatch, _OTHER_SID_STR)

        assert handoff.launch() is None

        handoff.svc._find_running_process_by_exe.assert_called_once()
        assert not handoff.app_states.exists()
