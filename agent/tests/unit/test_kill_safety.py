"""
tests for Wave 5 of process-identity 3.3.0: identity-gated destructive paths.

THE GATE, uniform everywhere (D1): before terminating pid P for entry E,
load E's recorded row for P and require identity_matches. No record refuses
('not managed by owlette'); a mismatch (recycled pid) refuses AND removes the
stale row so it can never feed a later kill. Refusals are Error: strings on
command paths (the dashboard parses that prefix) and warnings elsewhere, each
naming the entry, the pid and why.

Sites covered, per the Wave 5 matrix:
  - _identity_gate / _resolve_recorded_pid primitives
  - dashboard kill/stop (handle_firebase_command): tracked gate, durable-
    record resolution when tracking is empty (the point of the record), and
    the strict-discovery fallback gated on identity read at that moment
  - dashboard legacy restart: tracked gate with an Error: refusal
  - cortex IPC kill: same resolver, dict-shaped refusal
  - stall path (_kill_and_relaunch_locked): mismatch does NOT kill, clears
    tracking, lets the loop handle reality
  - config-removal terminate: gated, exe_path threaded to graceful_terminate
  - schedule-window stop: routed through graceful_terminate WITH exe_path;
    recorded rows take the uniform gate; a recordless tracked pid (legacy
    in-memory state, impossible from any 3.3.0 bind) stops only on an exact
    live-image match read at that moment
  - _terminate_processes_for_install (D4): close_processes resolves against
    managed entries' recorded pids only; the machine-wide psutil name scan is
    DELETED - every deployment test spies on psutil.process_iter and asserts
    zero calls, which is the negative control (the pre-Wave-5 code called it
    on every close_processes name, inside a broad except that would swallow
    a raising stub).

House patterns: real OwletteService method bodies descriptor-bound onto a
SimpleNamespace (test_cortex_process_command.py); FakeProc + a monkeypatched
psutil process table (test_process_lookup.py / test_inherit.py); real state
file redirected into the sandbox. owlette_service is imported lazily inside
helpers so collection order cannot double-initialise the cryptography PyO3
bindings.
"""

import json
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

import psutil
import pytest

import shared_utils


ENTRY = {'id': 'proc-1', 'name': 'Demo App', 'exe_path': 'C:\\apps\\demo.exe',
         'file_path': '', 'launch_mode': 'always'}

EXE = 'C:\\apps\\demo.exe'
EXE_NORMALISED = 'c:\\apps\\demo.exe'
OTHER_EXE = 'c:\\elsewhere\\stranger.exe'

PID = 101
CREATE_TIME = 1111.5


class FakeProc:
    """The minimal psutil.Process surface read_process_identity touches."""

    def __init__(self, pid, create_time, exe):
        self.pid = pid
        self._create_time = create_time
        self._exe = exe

    def oneshot(self):
        import contextlib
        return contextlib.nullcontext()

    def create_time(self):
        return self._create_time

    def exe(self):
        return self._exe

    def status(self):
        # Util.is_pid_running reads this off Windows to tell a live process
        # from a zombie the daemon has not reaped yet; a double without it
        # makes every identity check raise there and nowhere else.
        return psutil.STATUS_RUNNING


def install_process_table(monkeypatch, table):
    """Replace the live process view with `table` ({pid: FakeProc}).

    shared_utils and owlette_service import the same psutil module object, so
    patching it once covers read_process_identity, identity_matches AND
    Util.is_pid_running.
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
    """read_config honouring both the no-arg and keys=['processes'] shapes."""
    def fake_read_config(keys=None, process_list_id=None):
        cfg = {'processes': [dict(ENTRY)], 'firebase': {'enabled': False}}
        if keys == ['processes']:
            return cfg['processes']
        return cfg
    monkeypatch.setattr(shared_utils, 'read_config', fake_read_config)


@pytest.fixture
def gt(monkeypatch):
    """graceful_terminate spy - no test in this module kills anything real."""
    spy = MagicMock(return_value=True)
    monkeypatch.setattr(shared_utils, 'graceful_terminate', spy)
    return spy


def write_states(path, states):
    path.write_text(json.dumps(states))


def read_states(path):
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def recorded_row(entry_id=ENTRY['id'], create_time=CREATE_TIME, exe=EXE,
                 timestamp=None, status='RUNNING'):
    row = {'id': entry_id, 'status': status, 'create_time': create_time,
           'exe': exe, 'managed': True, 'origin': 'launched'}
    if timestamp is not None:
        row['timestamp'] = timestamp
    return row


# ==========================================================================
# gate primitives
# ==========================================================================

def test_gate_match_allows(state_file, monkeypatch):
    import owlette_service
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})

    assert owlette_service._identity_gate(PID, 'proc-1') == (True, None)


def test_gate_mismatch_refuses_and_cleans_row(state_file, monkeypatch):
    """PID recycled: same pid, different create_time. Refuse AND drop the
    stale row - it must never feed a later kill."""
    import owlette_service
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(
        monkeypatch, {PID: FakeProc(PID, CREATE_TIME + 50.0, EXE)})

    allowed, why = owlette_service._identity_gate(PID, 'proc-1')

    assert allowed is False
    assert 'does not match' in why
    assert str(PID) not in read_states(state_file), \
        'the recycled row survived the refusal'


def test_gate_no_record_refuses_and_leaves_row(state_file, monkeypatch):
    """A row without create_time is not evidence - refuse, but do not
    destroy state the gate does not understand."""
    import owlette_service
    write_states(state_file, {str(PID): {'id': 'proc-1', 'status': 'RUNNING'}})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})

    allowed, why = owlette_service._identity_gate(PID, 'proc-1')

    assert allowed is False
    assert 'not managed by owlette' in why
    assert str(PID) in read_states(state_file)


def test_gate_record_for_other_entry_refuses(state_file, monkeypatch):
    """A pid recorded for entry B must not die under entry A's command."""
    import owlette_service
    write_states(state_file, {str(PID): recorded_row(entry_id='proc-2')})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})

    allowed, why = owlette_service._identity_gate(PID, 'proc-1')

    assert allowed is False
    assert 'proc-2' in why


# ==========================================================================
# durable-record resolution
# ==========================================================================

def test_resolver_returns_live_verified_pid(state_file, monkeypatch):
    import owlette_service
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})

    assert owlette_service._resolve_recorded_pid('proc-1') == PID


def test_resolver_ignores_dead_and_recycled_rows(state_file, monkeypatch):
    """A dead pid and a recycled pid both fail verification - no target."""
    import owlette_service
    write_states(state_file, {
        '101': recorded_row(),                    # dead (not in table)
        '102': recorded_row(create_time=2222.0),  # recycled (table disagrees)
    })
    install_process_table(
        monkeypatch, {102: FakeProc(102, 9999.0, EXE)})

    assert owlette_service._resolve_recorded_pid('proc-1') is None


def test_resolver_prefers_newest_timestamp(state_file, monkeypatch):
    """Two verified rows (duplicate-before-convergence): both are provably
    owlette's own instances, the newest launch wins deterministically."""
    import owlette_service
    write_states(state_file, {
        '101': recorded_row(timestamp=100),
        '102': recorded_row(create_time=2222.0, timestamp=200),
    })
    install_process_table(monkeypatch, {
        101: FakeProc(101, CREATE_TIME, EXE),
        102: FakeProc(102, 2222.0, EXE),
    })

    assert owlette_service._resolve_recorded_pid('proc-1') == 102


# ==========================================================================
# dashboard kill/stop (handle_firebase_command)
# ==========================================================================

def make_cmd_service():
    from owlette_service import OwletteService
    svc = SimpleNamespace(
        last_started={},
        firebase_client=None,
        _command_rate_limits={},
        COMMAND_RATE_LIMIT_SECONDS=0,
        _command_router=SimpleNamespace(has_handler=lambda cmd_type: False),
        manual_overrides={},
        _cached_site_timezone=None,
        kill_and_relaunch_process=MagicMock(return_value=4321),
        handle_process_launch=MagicMock(return_value=5678),
        _find_running_process_by_exe=MagicMock(return_value=None),
        _adopt_running_instance=MagicMock(return_value=None),
    )
    svc.handle_firebase_command = (
        OwletteService.handle_firebase_command.__get__(svc, OwletteService))
    return svc


def kill_cmd():
    return {'type': 'kill_process', 'process_id': 'proc-1'}


def test_dashboard_kill_tracked_match_kills_with_exe_path(
        state_file, config, gt, monkeypatch):
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = make_cmd_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    result = svc.handle_firebase_command('cmd-1', kill_cmd())

    assert result == f"Process Demo App (PID {PID}) terminated"
    gt.assert_called_once_with(PID, exe_path=EXE)
    assert read_states(state_file)[str(PID)]['status'] == 'KILLED'
    assert svc.last_started['proc-1'].get('killed') is True


def test_dashboard_kill_tracked_mismatch_refuses_error_string(
        state_file, config, gt, monkeypatch):
    """Contract (e) unit-scoped: recycled pid -> Error: refusal naming the
    entry and the pid, nothing terminated, stale row cleaned, tracking
    cleared so the loop re-establishes reality."""
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(
        monkeypatch, {PID: FakeProc(PID, CREATE_TIME + 50.0, OTHER_EXE)})
    svc = make_cmd_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    result = svc.handle_firebase_command('cmd-1', kill_cmd())

    assert result.startswith('Error:')
    assert 'Demo App' in result and str(PID) in result
    gt.assert_not_called()
    assert str(PID) not in read_states(state_file)
    assert 'proc-1' not in svc.last_started


def test_dashboard_kill_tracked_no_record_refuses(
        state_file, config, gt, monkeypatch):
    write_states(state_file, {str(PID): {'id': 'proc-1', 'status': 'RUNNING'}})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = make_cmd_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    result = svc.handle_firebase_command('cmd-1', kill_cmd())

    assert result.startswith('Error:')
    assert 'not managed by owlette' in result
    gt.assert_not_called()


def test_dashboard_kill_resolves_durable_record_when_untracked(
        state_file, config, gt, monkeypatch):
    """Contract (c) unit-scoped: tracking emptied by a service restart, the
    durable record alone resolves the target - that is the point of the
    record."""
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = make_cmd_service()  # last_started empty

    result = svc.handle_firebase_command('cmd-1', kill_cmd())

    assert result == f"Process Demo App (PID {PID}) terminated"
    gt.assert_called_once_with(PID, exe_path=EXE)
    svc._find_running_process_by_exe.assert_not_called()


def test_dashboard_kill_discovered_pid_unreadable_identity_refuses(
        state_file, config, gt, monkeypatch):
    """A strict-discovery hit whose identity cannot be read (died between
    the match and the read) is refused, exactly like an inherit declines."""
    install_process_table(monkeypatch, {})  # pid vanished before the read
    svc = make_cmd_service()
    svc._find_running_process_by_exe = MagicMock(return_value=777)

    result = svc.handle_firebase_command('cmd-1', kill_cmd())

    assert result.startswith('Error:')
    assert '777' in result and 'not managed by owlette' in result
    gt.assert_not_called()


def test_dashboard_kill_discovered_pid_image_mismatch_refuses(
        state_file, config, gt, monkeypatch):
    install_process_table(
        monkeypatch, {777: FakeProc(777, 3333.0, OTHER_EXE)})
    svc = make_cmd_service()
    svc._find_running_process_by_exe = MagicMock(return_value=777)

    result = svc.handle_firebase_command('cmd-1', kill_cmd())

    assert result.startswith('Error:')
    gt.assert_not_called()


def test_dashboard_kill_discovered_pid_image_match_kills(
        state_file, config, gt, monkeypatch):
    """Strict-unique-match plus a same-image identity read at this moment is
    the same evidence bar an inherit accepts - the kill proceeds."""
    install_process_table(monkeypatch, {777: FakeProc(777, 3333.0, EXE)})
    svc = make_cmd_service()
    svc._find_running_process_by_exe = MagicMock(return_value=777)

    result = svc.handle_firebase_command('cmd-1', kill_cmd())

    assert result == 'Process Demo App (PID 777) terminated'
    gt.assert_called_once_with(777, exe_path=EXE)


def test_dashboard_restart_tracked_mismatch_refuses_error_string(
        state_file, config, gt, monkeypatch):
    """Legacy restart branch: the tracked pid is gated identically."""
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(
        monkeypatch, {PID: FakeProc(PID, CREATE_TIME + 50.0, EXE)})
    svc = make_cmd_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    result = svc.handle_firebase_command(
        'cmd-1', {'type': 'restart_process', 'process_id': 'proc-1'})

    assert result.startswith('Error:')
    assert 'Demo App' in result and str(PID) in result
    svc.kill_and_relaunch_process.assert_not_called()
    assert 'proc-1' not in svc.last_started


# ==========================================================================
# cortex IPC kill
# ==========================================================================

def test_cortex_kill_mismatch_returns_error_dict(state_file, gt, monkeypatch):
    import owlette_service
    from owlette_service import OwletteService

    monkeypatch.setattr(
        owlette_service.shared_utils, 'read_config',
        lambda *a, **k: {'processes': [dict(ENTRY)]})
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(
        monkeypatch, {PID: FakeProc(PID, CREATE_TIME + 50.0, EXE)})

    svc = SimpleNamespace(
        last_started={'proc-1': {'pid': PID}},
        firebase_client=None,
        kill_and_relaunch_process=MagicMock(),
        handle_process_launch=MagicMock(),
    )
    svc._handle_cortex_process_command = (
        OwletteService._handle_cortex_process_command.__get__(
            svc, OwletteService))

    result = svc._handle_cortex_process_command('kill_process', 'Demo App')

    assert 'error' in result
    assert 'Demo App' in result['error'] and str(PID) in result['error']
    gt.assert_not_called()
    assert str(PID) not in read_states(state_file)


# ==========================================================================
# stall path: _kill_and_relaunch_locked
# ==========================================================================

def make_relaunch_service():
    from owlette_service import OwletteService
    svc = SimpleNamespace(
        last_started={},
        firebase_client=None,
        _launch_locks={},
        _launch_locks_guard=threading.Lock(),
        reached_max_relaunch_attempts=MagicMock(return_value=False),
        launch_process_as_user=MagicMock(return_value=999),
        log_and_notify=MagicMock(),
        _write_cortex_event=MagicMock(),
    )
    for name in ('kill_and_relaunch_process', '_kill_and_relaunch_locked',
                 '_launch_lock_for'):
        setattr(svc, name,
                getattr(OwletteService, name).__get__(svc, OwletteService))
    return svc


def test_kill_and_relaunch_match_proceeds(state_file, gt, monkeypatch):
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = make_relaunch_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    new_pid = svc.kill_and_relaunch_process(PID, dict(ENTRY))

    assert new_pid == 999
    gt.assert_called_once_with(PID, exe_path=EXE)
    assert svc.last_started['proc-1']['pid'] == 999


def test_kill_and_relaunch_mismatch_refuses_and_clears_tracking(
        state_file, gt, monkeypatch):
    """Stall path on a recycled pid: do NOT kill, clear tracking, let the
    monitor loop handle reality (fresh launch under D3)."""
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(
        monkeypatch, {PID: FakeProc(PID, CREATE_TIME + 50.0, EXE)})
    svc = make_relaunch_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    new_pid = svc.kill_and_relaunch_process(PID, dict(ENTRY))

    assert new_pid is None
    gt.assert_not_called()
    svc.launch_process_as_user.assert_not_called()
    assert 'proc-1' not in svc.last_started
    assert str(PID) not in read_states(state_file)


def test_kill_and_relaunch_no_record_refuses(state_file, gt, monkeypatch):
    write_states(state_file, {str(PID): {'id': 'proc-1', 'status': 'RUNNING'}})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = make_relaunch_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    assert svc.kill_and_relaunch_process(PID, dict(ENTRY)) is None
    gt.assert_not_called()


# ==========================================================================
# config-removal terminate (handle_config_update)
# ==========================================================================

def make_config_update_service():
    from owlette_service import OwletteService
    svc = SimpleNamespace(
        last_started={},
        firebase_client=None,
        _applying_remote_config=False,
        _config_baseline_lock=threading.Lock(),
        _local_config_mtime=None,
        _last_seen_launch_modes={},
        _last_seen_launch_schedules={},
        _initialize_or_restart_firebase_client=MagicMock(return_value=True),
        _apply_launch_mode_transition=MagicMock(),
    )
    for name in ('handle_config_update', '_get_process_launch_mode',
                 '_get_schedule_signature'):
        setattr(svc, name,
                getattr(OwletteService, name).__get__(svc, OwletteService))
    return svc


@pytest.fixture
def config_update_env(tmp_path, monkeypatch, config):
    """Sandbox config.json plus the diff seam so the removal loop runs."""
    import owlette_service
    config_path = tmp_path / 'config.json'
    monkeypatch.setattr(shared_utils, 'CONFIG_PATH', str(config_path))
    monkeypatch.setattr(owlette_service.config_sync, 'configs_equal',
                        lambda a, b: False)


def test_config_removal_gated_and_threads_exe_path(
        state_file, config_update_env, gt, monkeypatch):
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = make_config_update_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    svc.handle_config_update({'processes': []})

    gt.assert_called_once_with(PID, exe_path=EXE)
    assert read_states(state_file)[str(PID)]['status'] == 'STOPPED'
    assert 'proc-1' not in svc.last_started


def test_config_removal_mismatch_refuses_but_still_untracks(
        state_file, config_update_env, gt, monkeypatch):
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(
        monkeypatch, {PID: FakeProc(PID, CREATE_TIME + 50.0, EXE)})
    svc = make_config_update_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    svc.handle_config_update({'processes': []})

    gt.assert_not_called()
    assert 'proc-1' not in svc.last_started, \
        'a removed entry must drop its tracking even when the kill refuses'


# ==========================================================================
# schedule-window stop
# ==========================================================================

def sched_service():
    return SimpleNamespace(last_started={'proc-1': {'pid': PID}},
                           firebase_client=None)


def test_schedule_stop_recorded_match_uses_graceful_terminate_with_exe_path(
        state_file, gt, monkeypatch):
    import owlette_service
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = sched_service()

    owlette_service._stop_process_outside_window(svc, dict(ENTRY), PID)

    gt.assert_called_once_with(PID, exe_path=EXE)
    assert 'proc-1' not in svc.last_started


def test_schedule_stop_recorded_mismatch_refuses_cleans_and_clears(
        state_file, gt, monkeypatch):
    import owlette_service
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(
        monkeypatch, {PID: FakeProc(PID, CREATE_TIME + 50.0, EXE)})
    svc = sched_service()

    owlette_service._stop_process_outside_window(svc, dict(ENTRY), PID)

    gt.assert_not_called()
    assert str(PID) not in read_states(state_file)
    assert 'proc-1' not in svc.last_started


def test_schedule_stop_recordless_exact_image_match_stops(
        state_file, gt, monkeypatch):
    """Legacy in-memory tracking (no 3.3.0 bind can produce it): the live
    image equals the entry's exe_path exactly, read at this moment - the
    stop proceeds. Mirrors the lifecycle characterisation scenario."""
    import owlette_service
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = sched_service()

    owlette_service._stop_process_outside_window(svc, dict(ENTRY), PID)

    gt.assert_called_once_with(PID, exe_path=EXE)
    assert 'proc-1' not in svc.last_started


def test_schedule_stop_recordless_image_mismatch_refuses(
        state_file, gt, monkeypatch):
    """A recordless tracked pid wearing a different image is a recycled pid
    in the only clothes we can check - refuse, clear tracking."""
    import owlette_service
    install_process_table(
        monkeypatch, {PID: FakeProc(PID, CREATE_TIME, OTHER_EXE)})
    svc = sched_service()

    owlette_service._stop_process_outside_window(svc, dict(ENTRY), PID)

    gt.assert_not_called()
    assert 'proc-1' not in svc.last_started


# ==========================================================================
# deployment: _terminate_processes_for_install (D4)
# ==========================================================================

def make_deploy_service():
    from owlette_service import OwletteService
    svc = SimpleNamespace(install_locks={}, last_started={},
                          firebase_client=None)
    svc._terminate_processes_for_install = (
        OwletteService._terminate_processes_for_install.__get__(
            svc, OwletteService))
    return svc


@pytest.fixture
def machine_scan_spy(monkeypatch):
    """D4 negative control: the pre-Wave-5 code ran psutil.process_iter for
    every close_processes name (inside a broad except, so a raising stub
    would be silently swallowed - verified). Every deployment test asserts
    this spy was never called; against the old code it records the scan and
    the assertion fails."""
    import owlette_service
    spy = MagicMock(return_value=iter([]))
    monkeypatch.setattr(owlette_service.psutil, 'process_iter', spy)
    monkeypatch.setattr(owlette_service.time, 'sleep', lambda seconds: None)
    return spy


def test_deploy_suppress_half_gated_kills_with_exe_path_and_locks(
        state_file, config, gt, machine_scan_spy, monkeypatch):
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = make_deploy_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    locked = svc._terminate_processes_for_install(
        close_processes=[], suppress_projects=['proc-1'],
        deployment_id='dep-1', cmd_id='cmd-1')

    assert locked == ['proc-1']
    assert svc.install_locks == {'proc-1': 'dep-1'}
    gt.assert_called_once_with(PID, exe_path=EXE)
    assert read_states(state_file)[str(PID)]['status'] == 'STOPPED'
    assert 'proc-1' not in svc.last_started
    assert machine_scan_spy.call_count == 0


def test_deploy_suppress_mismatch_refuses_but_still_locks(
        state_file, config, gt, machine_scan_spy, monkeypatch):
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(
        monkeypatch, {PID: FakeProc(PID, CREATE_TIME + 50.0, EXE)})
    svc = make_deploy_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    locked = svc._terminate_processes_for_install(
        close_processes=[], suppress_projects=['proc-1'],
        deployment_id='dep-1', cmd_id='cmd-1')

    assert locked == ['proc-1']
    assert svc.install_locks == {'proc-1': 'dep-1'}
    gt.assert_not_called()
    assert machine_scan_spy.call_count == 0


@pytest.mark.windows(
    reason='close_processes carries Windows exe basenames; software deployment is Windows-only')
def test_deploy_close_resolves_managed_entry_recorded_pid(
        state_file, config, gt, machine_scan_spy, monkeypatch):
    """close_processes=['demo.exe'] maps to the config entry by exe
    basename, then to the entry's RECORDED pid - identity-verified, with
    exe_path threaded through. No tracking needed (post-restart shape)."""
    write_states(state_file, {str(PID): recorded_row()})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = make_deploy_service()  # last_started empty

    svc._terminate_processes_for_install(
        close_processes=['demo.exe'], suppress_projects=[],
        deployment_id='dep-1', cmd_id='cmd-1')

    gt.assert_called_once_with(PID, exe_path=EXE)
    assert read_states(state_file)[str(PID)]['status'] == 'STOPPED'
    assert machine_scan_spy.call_count == 0,         'deployment close ran a machine-wide scan (D4 negative control)'


def test_deploy_close_unknown_name_skipped_no_scan_no_kill(
        state_file, config, gt, machine_scan_spy, monkeypatch):
    """Contract (d) unit-scoped: a close_processes name matching no managed
    entry is logged and skipped - never hunted for machine-wide. The
    machine_scan_spy assertion fails this test against the pre-Wave-5
    scan (proven by running it against the stashed old code)."""
    install_process_table(monkeypatch, {})
    svc = make_deploy_service()

    locked = svc._terminate_processes_for_install(
        close_processes=['stranger.exe'], suppress_projects=[],
        deployment_id='dep-1', cmd_id='cmd-1')

    assert locked == []
    gt.assert_not_called()
    assert machine_scan_spy.call_count == 0,         'deployment close ran a machine-wide scan (D4 negative control)'
