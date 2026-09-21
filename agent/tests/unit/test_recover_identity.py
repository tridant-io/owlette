"""
tests for Wave 2 of process-identity 3.3.0: the durable launch record and
strict identity-only recovery in owlette_service.

recover_running_processes may re-adopt a row ONLY when the row's recorded
create_time still matches the live process at that pid (identity_matches) --
everything else is doubt, and doubt launches fresh (D3): rows with no identity
record (pre-3.3.0 state files) are skipped, rows whose pid was recycled are
refused AND removed so the stale record can never feed a later kill. The
launch-record tests pin the exact row shape written at the moment a real PID
is bound to an entry.

House patterns: real OwletteService method bodies descriptor-bound onto a
SimpleNamespace (test_cortex_process_command.py); FakeProc + monkeypatched
psutil where unit-scoped (test_process_lookup.py). owlette_service is imported
lazily inside helpers so collection order cannot double-initialise the
cryptography PyO3 bindings.
"""

import contextlib
import json
import logging
import os
import threading
import time
from types import SimpleNamespace

import psutil
import pytest

import shared_utils


ENTRY = {'id': 'proc-1', 'name': 'Demo App', 'exe_path': 'C:\\apps\\demo.exe',
         'launch_mode': 'always'}


class FakeProc:
    """The minimal psutil.Process surface read_process_identity touches."""

    def __init__(self, pid, create_time, exe):
        self.pid = pid
        self._create_time = create_time
        self._exe = exe

    def oneshot(self):
        return contextlib.nullcontext()

    def create_time(self):
        return self._create_time

    def exe(self):
        return self._exe


def install_process_table(monkeypatch, table):
    """Replace the live process view with `table` ({pid: FakeProc}).

    shared_utils and owlette_service import the same psutil module object, so
    patching it once covers read_process_identity, identity_matches AND
    Util.is_pid_running / cleanup's pid_exists.
    """
    def process(pid):
        pid = int(pid)
        if pid not in table:
            raise psutil.NoSuchProcess(pid)
        return table[pid]

    monkeypatch.setattr(shared_utils.psutil, 'Process', process)
    monkeypatch.setattr(shared_utils.psutil, 'pid_exists',
                        lambda pid: int(pid) in table)


@pytest.fixture
def state_file(tmp_path, monkeypatch):
    """Redirect the app_states file into the test sandbox."""
    path = tmp_path / 'app_states.json'
    monkeypatch.setattr(shared_utils, 'RESULT_FILE_PATH', str(path))
    return path


@pytest.fixture
def config(monkeypatch):
    monkeypatch.setattr(shared_utils, 'read_config',
                        lambda *a, **k: {'processes': [dict(ENTRY)]})


def write_states(path, states):
    path.write_text(json.dumps(states))


def read_states(path):
    return json.loads(path.read_text())


def make_recovery_service():
    from owlette_service import OwletteService
    svc = SimpleNamespace(last_started={}, _cached_site_timezone=None)
    svc.recover_running_processes = (
        OwletteService.recover_running_processes.__get__(svc, OwletteService))
    return svc


def identity_row(create_time, exe, **extra):
    row = {'id': 'proc-1', 'status': 'RUNNING',
           'create_time': create_time, 'exe': exe,
           'managed': True, 'origin': 'launched'}
    row.update(extra)
    return row


# --- recovery matrix ---------------------------------------------------------

def test_identity_match_readopts_row(state_file, config, monkeypatch, caplog):
    """Recorded create_time equals the live process's -> re-adopt, keep row."""
    install_process_table(monkeypatch, {
        500: FakeProc(500, 1111.5, 'C:\\apps\\demo.exe')})
    states = {'500': identity_row(1111.5, 'c:\\apps\\demo.exe')}
    write_states(state_file, states)
    svc = make_recovery_service()

    with caplog.at_level(logging.DEBUG):
        svc.recover_running_processes()

    assert svc.last_started['proc-1']['pid'] == 500
    assert 're-adopted by identity' in caplog.text
    # Nothing was dropped, so the state file is byte-for-byte untouched.
    assert read_states(state_file) == states


def test_create_time_mismatch_refuses_and_cleans(
        state_file, config, monkeypatch, caplog):
    """Right pid, wrong birth time = a recycled pid wearing our record. The
    stranger is never adopted and the stale row is removed so no later kill
    path can resolve it."""
    install_process_table(monkeypatch, {
        500: FakeProc(500, 2222.0, 'C:\\apps\\demo.exe')})
    write_states(state_file, {'500': identity_row(1111.5, 'c:\\apps\\demo.exe')})
    svc = make_recovery_service()

    with caplog.at_level(logging.DEBUG):
        svc.recover_running_processes()

    assert svc.last_started == {}
    assert 'refused: pid recycled' in caplog.text
    assert read_states(state_file) == {}


def test_missing_record_is_not_adopted_and_row_survives(
        state_file, config, monkeypatch, caplog):
    """Pre-3.3.0 state file: the pid is alive but nothing proves it is ours.
    D3: never adopt on doubt -- the entry relaunches via the normal loop. The
    row itself is kept (the pid IS alive; deleting history is not recovery's
    job)."""
    install_process_table(monkeypatch, {
        500: FakeProc(500, 1111.5, 'C:\\apps\\demo.exe')})
    states = {'500': {'id': 'proc-1', 'status': 'RUNNING'}}
    write_states(state_file, states)
    svc = make_recovery_service()

    with caplog.at_level(logging.DEBUG):
        svc.recover_running_processes()

    assert svc.last_started == {}
    assert 'no identity record (pre-3.3.0) - will relaunch' in caplog.text
    assert read_states(state_file) == states


def test_dead_pid_swept_while_live_match_adopted(
        state_file, config, monkeypatch, caplog):
    """The existing dead-pid sweep stays: dead rows leave the file, live
    proven rows are re-adopted in the same pass."""
    install_process_table(monkeypatch, {
        500: FakeProc(500, 1111.5, 'C:\\apps\\demo.exe')})
    live_row = identity_row(1111.5, 'c:\\apps\\demo.exe')
    write_states(state_file, {
        '500': live_row,
        '600': identity_row(3333.0, 'c:\\apps\\demo.exe'),  # dead
        'None': {'status': 'LAUNCHING'},  # failed-launch junk
    })
    svc = make_recovery_service()

    with caplog.at_level(logging.DEBUG):
        svc.recover_running_processes()

    assert svc.last_started['proc-1']['pid'] == 500
    assert read_states(state_file) == {'500': live_row}


def test_inactive_launch_mode_keeps_row_but_does_not_track(
        state_file, monkeypatch, caplog):
    """A proven row for an off entry stays in the file but is not tracked --
    off processes are never monitored (pre-existing rule, re-pinned against
    the rewrite)."""
    install_process_table(monkeypatch, {
        500: FakeProc(500, 1111.5, 'C:\\apps\\demo.exe')})
    entry = dict(ENTRY, launch_mode='off')
    monkeypatch.setattr(shared_utils, 'read_config',
                        lambda *a, **k: {'processes': [entry]})
    states = {'500': identity_row(1111.5, 'c:\\apps\\demo.exe')}
    write_states(state_file, states)
    svc = make_recovery_service()

    with caplog.at_level(logging.DEBUG):
        svc.recover_running_processes()

    assert svc.last_started == {}
    assert "launch_mode is 'off'" in caplog.text
    assert read_states(state_file) == states


# --- cleanup_stale_tracking_data int() guard ---------------------------------

def test_non_numeric_key_survives_the_guarded_sweep(
        state_file, config, monkeypatch, caplog):
    """A non-numeric app_states key must not abort the stale-pid sweep.

    Negative control: against the pre-guard code int('None') raised out of the
    comprehension into the method's broad except, so the dead '600' row
    survived -- this test fails there and passes only with the guard.
    """
    from owlette_service import OwletteService
    install_process_table(monkeypatch, {
        500: FakeProc(500, 1111.5, 'C:\\apps\\demo.exe')})
    svc = SimpleNamespace(
        last_started={}, relaunch_attempts={}, install_locks={},
        active_installations={}, manual_overrides={},
        _skip_launch_delay=set(),
        results={
            'None': {'status': 'LAUNCHING'},
            'not-a-pid': {'status': 'RUNNING'},
            '500': {'id': 'proc-1', 'status': 'RUNNING'},
            '600': {'id': 'proc-1', 'status': 'RUNNING'},  # dead
        },
    )
    svc.cleanup_stale_tracking_data = (
        OwletteService.cleanup_stale_tracking_data.__get__(svc, OwletteService))

    with caplog.at_level(logging.DEBUG):
        svc.cleanup_stale_tracking_data()

    assert '600' not in svc.results, 'dead pid not swept - guard missing?'
    assert 'Error cleaning up stale tracking data' not in caplog.text
    # Non-numeric keys are skipped, never deleted here (recovery owns them).
    assert set(svc.results) == {'None', 'not-a-pid', '500'}
    assert read_states(state_file) == svc.results


# --- launch-record write shape -----------------------------------------------

@pytest.fixture
def launch_service(tmp_path, monkeypatch, state_file):
    """A double running the REAL launch_process_as_user body with the win32
    spawn faked: the helper 'launches' pid 4242 by writing the pid handoff
    file, no process is ever created. Mirrors the lifecycle conftest seam.
    """
    import sys
    import owlette_service
    from owlette_service import OwletteService

    # Everything get_data_path() resolves must land in the sandbox.
    monkeypatch.setenv('PROGRAMDATA', str(tmp_path))
    (tmp_path / 'Owlette' / 'tmp').mkdir(parents=True)
    monkeypatch.setattr(shared_utils, 'get_python_exe_path',
                        lambda: sys.executable)

    def fake_create_process_as_user(token, app_name, command_line, *rest):
        args_file = command_line.rsplit('"', 2)[-2]
        with open(args_file, 'r') as f:
            launch_args = json.load(f)
        with open(launch_args['pid_file'], 'w') as f:
            json.dump({'pid': 4242}, f)
        return None, None, 9999, 0

    monkeypatch.setattr(owlette_service.win32process, 'CreateProcessAsUser',
                        fake_create_process_as_user)
    # the faked pid is no real child and the runner owns the file; the
    # handoff's owner and ancestry gates are pinned in
    # test_owlette_service_hardening.py.
    monkeypatch.setattr(owlette_service.acl_hardening, 'is_trusted_owner', lambda *a: True)
    monkeypatch.setattr(owlette_service, '_pid_descends_from', lambda *a: True)

    exe = tmp_path / 'target-app.exe'
    exe.write_bytes(b'')  # must exist; the faked spawn never runs it

    svc = SimpleNamespace(
        console_user_token=object(),
        environment=None,
        _refresh_user_token=lambda: None,
    )
    svc.launch_process_as_user = (
        OwletteService.launch_process_as_user.__get__(svc, OwletteService))
    svc._validate_path = OwletteService._validate_path
    return SimpleNamespace(svc=svc, exe=str(exe))


def test_launch_record_row_shape_preserves_scout_fields(
        launch_service, state_file, monkeypatch):
    """The launch-success write records the full identity on the pid row --
    and merges into an existing row, so owlette_scout's fields survive."""
    install_process_table(monkeypatch, {
        4242: FakeProc(4242, 1234.25, launch_service.exe)})
    write_states(state_file, {
        '4242': {'responsive': False, 'responsive_prev': True,
                 'hung_since': 123},
        '77': {'id': 'proc-other', 'status': 'RUNNING'},
    })

    pid = launch_service.svc.launch_process_as_user(
        {'id': 'proc-x', 'name': 'Target', 'exe_path': launch_service.exe})

    assert pid == 4242
    states = read_states(state_file)
    row = states['4242']
    assert row == {
        'responsive': False,
        'responsive_prev': True,
        'hung_since': 123,
        'timestamp': row['timestamp'],
        'id': 'proc-x',
        'status': 'LAUNCHING',
        'create_time': 1234.25,
        'exe': launch_service.exe.replace('/', '\\').lower(),
        'managed': True,
        'origin': 'launched',
    }
    assert isinstance(row['timestamp'], int)
    assert abs(row['timestamp'] - time.time()) < 60
    assert states['77'] == {'id': 'proc-other', 'status': 'RUNNING'}
    # The record must satisfy the matcher that recovery and (Wave 5) kill
    # paths will hold it to.
    assert shared_utils.identity_matches(
        {'pid': 4242, 'create_time': row['create_time'], 'exe': row['exe']},
        4242) is True


def test_launch_record_skipped_when_child_dies_before_identity_read(
        launch_service, state_file, monkeypatch, caplog):
    """Child gone before the identity read: record NOTHING and let the normal
    failure path run -- the row keeps its pre-wave shape, and recovery will
    later treat it as recordless (never adopted)."""
    install_process_table(monkeypatch, {})  # pid 4242 is already gone

    with caplog.at_level(logging.DEBUG):
        pid = launch_service.svc.launch_process_as_user(
            {'id': 'proc-x', 'name': 'Target',
             'exe_path': launch_service.exe})

    assert pid == 4242
    row = read_states(state_file)['4242']
    assert row == {'timestamp': row['timestamp'], 'id': 'proc-x',
                   'status': 'LAUNCHING'}
    assert 'exited before its identity could be recorded' in caplog.text
