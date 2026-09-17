"""
tests for Task 6.1 of process-identity 3.3.0: LAUNCH_FAILED gets its first
writer (D5).

The status has been rendered by the desktop (red dot, "failed") and the web
for years; nothing ever wrote it. A failed launch or an identity-refused
operation was an Error: string in a log while the entry showed the hollow
INACTIVE ring - indistinguishable from launch-mode-off.

THE NO-PID PROBLEM, and the decision under test (_surface_launch_failed):
a failed launch has no live pid to key a fresh row by, and the desktop
parser (parseAppStates) prunes non-numeric top-level keys and persists the
pruned document, so the status is only ever written onto a row that already
exists - the refused pid's own row when the caller names one bound to the
entry, else the entry's newest existing (dead) generation. An entry that has
NEVER produced a row (blank exe_path from creation) stays INACTIVE, which
statusForProcess yields exactly when no row carries the entry's id and the
desktop's launchModeBlockedReason copy already explains in the UI.

PERSISTENCE: cleanup_stale_tracking_data and recover_running_processes both
delete dead-pid rows, which would erase the surfacing within one sweep and
leave nothing to reuse - so both now keep a dead LAUNCH_FAILED row while its
entry is still configured (the periodic sweep additionally requires that no
live row has superseded it). The keep tests here are the negative controls:
they FAIL against the pre-6.1 sweeps (repo rule - a guard that never failed
proves nothing).

CLEARING: the status must not stick. A bind to the same pid overwrites the
row through the existing write paths (pinned here, nothing added); a bind to
a new pid writes a newer-timestamped row that wins the desktop's recency
sort, and the sweep clears the leftover once the entry has a live row again.

House patterns: real OwletteService method bodies descriptor-bound onto a
SimpleNamespace (test_cortex_process_command.py); FakeProc + a monkeypatched
psutil process table and a redirected state file (test_kill_safety.py).
owlette_service is imported lazily inside tests so collection order cannot
double-initialise the cryptography PyO3 bindings.
"""

import datetime
import json
import sys
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

import psutil
import pytest

import shared_utils


ENTRY = {'id': 'proc-1', 'name': 'Demo App', 'exe_path': 'C:\\apps\\demo.exe',
         'file_path': '', 'launch_mode': 'always'}

EXE = 'C:\\apps\\demo.exe'
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
    """Replace the live process view with `table` ({pid: FakeProc})."""
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
    """read_config honouring the shapes the code under test asks for."""
    def fake_read_config(keys=None, process_list_id=None):
        cfg = {'processes': [dict(ENTRY)], 'firebase': {'enabled': False}}
        if keys == ['processes']:
            return cfg['processes']
        if keys == ['time_to_init']:
            return '10'
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


def dead_row(entry_id='proc-1', status='RUNNING', timestamp=100):
    return {'id': entry_id, 'status': status, 'timestamp': timestamp}


def recorded_row(entry_id='proc-1', create_time=CREATE_TIME,
                 exe=shared_utils.normalize_exe_path(EXE),
                 timestamp=100, status='RUNNING'):
    return {'id': entry_id, 'status': status, 'timestamp': timestamp,
            'create_time': create_time, 'exe': exe, 'managed': True,
            'origin': 'launched'}


def assert_parser_compatible(states):
    """Every top-level key must survive the desktop's parseAppStates prune."""
    for key in states:
        assert key.isdigit(), (
            'non-numeric top-level key %r would be pruned (and the pruned '
            'document persisted) by the desktop parser' % key)


# ==========================================================================
# the writer itself
# ==========================================================================

def test_writer_marks_refused_pid_row_and_strips_identity(state_file):
    """The row involved gets the status; the identity record is stripped so
    recovery keeps the (now recordless) row instead of dropping it as a
    recycled record. timestamp survives for the desktop's recency sort."""
    import owlette_service
    write_states(state_file, {str(PID): recorded_row()})

    assert owlette_service._surface_launch_failed('proc-1', pid=PID) is True

    row = read_states(state_file)[str(PID)]
    assert row['status'] == 'LAUNCH_FAILED'
    assert row['id'] == 'proc-1'
    assert row['timestamp'] == 100
    for field in ('create_time', 'exe', 'managed', 'origin'):
        assert field not in row, '%s should be stripped' % field


def test_writer_never_defaces_another_entrys_row(state_file):
    """A refused pid whose row belongs to entry B must not be painted failed
    under entry A's operation - that would show "failed" on a healthy
    neighbour. With no row of its own, entry A surfaces nothing."""
    import owlette_service
    write_states(state_file, {str(PID): dead_row(entry_id='proc-2')})

    assert owlette_service._surface_launch_failed('proc-1', pid=PID) is False

    assert read_states(state_file)[str(PID)]['status'] == 'RUNNING'


def test_writer_falls_back_to_newest_dead_generation(state_file):
    import owlette_service
    write_states(state_file, {
        '90': dead_row(timestamp=50, status='KILLED'),
        '95': dead_row(timestamp=200),
    })

    assert owlette_service._surface_launch_failed('proc-1') is True

    states = read_states(state_file)
    assert states['95']['status'] == 'LAUNCH_FAILED'
    assert states['90']['status'] == 'KILLED', 'older generation defaced'


def test_writer_no_rows_surfaces_nothing_and_fabricates_nothing(state_file):
    """The never-launched case: no row exists, so the entry stays INACTIVE
    (statusForProcess falls back to INACTIVE only when no row carries the
    entry id - the desktop's launchModeBlockedReason copy explains it). No
    synthetic key may appear: non-numeric keys are pruned by the desktop
    parser and a fabricated numeric pid would collide with a real process."""
    import owlette_service
    write_states(state_file, {})

    assert owlette_service._surface_launch_failed('proc-1') is False

    states = read_states(state_file)
    assert states == {}
    assert_parser_compatible(states)


def test_writer_folds_sibling_failed_rows(state_file):
    """Repeated failure/success cycles must never accumulate one
    LAUNCH_FAILED row per attempt - siblings fold into the newest."""
    import owlette_service
    write_states(state_file, {
        '80': {'id': 'proc-1', 'status': 'LAUNCH_FAILED'},
        '85': {'id': 'proc-1', 'status': 'LAUNCH_FAILED', 'timestamp': 40},
        '95': dead_row(timestamp=200, status='KILLED'),
    })

    assert owlette_service._surface_launch_failed('proc-1') is True

    states = read_states(state_file)
    failed = [k for k, v in states.items() if v['status'] == 'LAUNCH_FAILED']
    assert failed == ['95'], 'expected exactly one LAUNCH_FAILED row'
    assert '80' not in states and '85' not in states


def test_writer_repeat_is_a_no_op_not_a_duplicate(state_file):
    import owlette_service
    write_states(state_file, {'95': dead_row(timestamp=200)})

    assert owlette_service._surface_launch_failed('proc-1') is True
    first = read_states(state_file)
    assert owlette_service._surface_launch_failed('proc-1') is True
    second = read_states(state_file)

    assert first == second
    assert len(second) == 1


# ==========================================================================
# case 1: _launch_locked failure sites
# ==========================================================================

def make_launch_service():
    from owlette_service import OwletteService
    svc = SimpleNamespace(
        last_started={},
        firebase_client=None,
        current_time=datetime.datetime.now(),
        _skip_launch_delay=set(),
        _seat_probe=None,
        _seat_probe_thread=threading.get_ident(),
        _seatless_entries=set(),
        reached_max_relaunch_attempts=MagicMock(return_value=False),
        launch_process_as_user=MagicMock(return_value=None),
        _write_cortex_event=MagicMock(),
    )
    for name in ('_launch_locked', '_seat_absent'):
        setattr(svc, name,
                getattr(OwletteService, name).__get__(svc, OwletteService))
    return svc


def test_missing_exe_launch_writes_launch_failed_on_reused_row(state_file):
    write_states(state_file, {'4242': dead_row()})
    svc = make_launch_service()
    entry = dict(ENTRY, exe_path='C:\\apps\\definitely-missing-demo.exe')

    assert svc._launch_locked(entry, None) is None

    states = read_states(state_file)
    row = states['4242']
    assert row['status'] == 'LAUNCH_FAILED'
    assert row['id'] == 'proc-1'
    assert row['timestamp'] == 100, 'launch timestamp must survive the merge'
    assert svc.last_started['proc-1']['failed'] is True
    assert_parser_compatible(states)


def test_blank_exe_with_history_writes_launch_failed(state_file):
    write_states(state_file, {'4242': dead_row()})
    svc = make_launch_service()

    assert svc._launch_locked(dict(ENTRY, exe_path=''), None) is None

    assert read_states(state_file)['4242']['status'] == 'LAUNCH_FAILED'
    assert svc.last_started['proc-1']['failed'] is True


def test_blank_exe_never_launched_stays_inactive(state_file):
    """Blank exe from creation: no row has ever existed, nothing is written
    (INACTIVE + launchModeBlockedReason is the deliberate surface), and in
    particular no "None"-keyed or synthetic row corrupts the file."""
    write_states(state_file, {})
    svc = make_launch_service()

    assert svc._launch_locked(dict(ENTRY, exe_path=''), None) is None

    states = read_states(state_file)
    assert states == {}
    assert_parser_compatible(states)
    assert svc.last_started['proc-1']['failed'] is True


def test_no_pid_launch_writes_launch_failed(state_file, config, tmp_path,
                                            monkeypatch):
    """launch_process_as_user returned no PID: the third in-memory-marker
    site now also surfaces.

    The one case here whose exe_path really is on disk, so the only one
    that reaches the seat check off Windows. The adapter is stubbed rather
    than asked: this is about the surfacing, and a machine's seat is not
    something a test of it should depend on.
    """
    import owlette_service

    monkeypatch.setattr(
        owlette_service, 'osadapter',
        SimpleNamespace(console_user=lambda: 'kiosk'))
    exe = tmp_path / 'demo-runner.exe'
    exe.write_bytes(b'')
    write_states(state_file, {'4242': dead_row()})
    svc = make_launch_service()

    assert svc._launch_locked(dict(ENTRY, exe_path=str(exe)), None) is None

    svc.launch_process_as_user.assert_called_once()
    assert read_states(state_file)['4242']['status'] == 'LAUNCH_FAILED'
    assert svc.last_started['proc-1']['failed'] is True


def test_a_launch_never_attempted_for_want_of_a_seat_surfaces_nothing(
        state_file, config, tmp_path, monkeypatch):
    """The one non-failure in this file. Off Windows a box with nobody at a
    graphical seat refuses every managed launch (plan decision 4), so none is
    attempted — and a launch that never happened has nothing to surface. A
    machine at its greeter rewrote this file around a LAUNCH_FAILED row once
    a minute per entry, for as long as nobody was signed in.

    The in-memory cooldown marker is still set: it is what holds the retry to
    once a minute until somebody signs in.
    """
    import owlette_service

    monkeypatch.setattr(sys, 'platform', 'linux')
    monkeypatch.setattr(
        owlette_service, 'osadapter',
        SimpleNamespace(console_user=lambda: None))
    exe = tmp_path / 'demo-runner.exe'
    exe.write_bytes(b'')
    write_states(state_file, {'4242': dead_row()})
    svc = make_launch_service()

    assert svc._launch_locked(dict(ENTRY, exe_path=str(exe)), None) is None

    # The negative control: both of these were the no-PID path's before.
    svc.launch_process_as_user.assert_not_called()
    assert read_states(state_file)['4242']['status'] == 'RUNNING'
    assert svc.last_started['proc-1']['failed'] is True


def test_repeated_launch_failures_do_not_duplicate_rows(state_file):
    write_states(state_file, {'4242': dead_row()})
    svc = make_launch_service()
    entry = dict(ENTRY, exe_path='C:\\apps\\definitely-missing-demo.exe')

    svc._launch_locked(entry, None)
    svc._launch_locked(entry, None)
    svc._launch_locked(dict(ENTRY, exe_path=''), None)

    states = read_states(state_file)
    assert list(states.keys()) == ['4242']
    assert states['4242']['status'] == 'LAUNCH_FAILED'


# ==========================================================================
# case 2: identity-gate refusals
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


def test_identity_refusal_marks_the_row_involved(state_file, gt, monkeypatch):
    """No-record refusal: the gate leaves the row in place, and the refusal
    surfaces on that exact row."""
    write_states(state_file, {str(PID): {'id': 'proc-1', 'status': 'RUNNING'}})
    install_process_table(monkeypatch, {PID: FakeProc(PID, CREATE_TIME, EXE)})
    svc = make_relaunch_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    assert svc.kill_and_relaunch_process(PID, dict(ENTRY)) is None

    gt.assert_not_called()
    assert read_states(state_file)[str(PID)]['status'] == 'LAUNCH_FAILED'


def test_identity_refusal_mismatch_falls_back_to_older_row(
        state_file, gt, monkeypatch):
    """Recycled pid: the gate drops the stale recorded row, so the surfacing
    falls back to the entry's newest remaining generation."""
    write_states(state_file, {
        str(PID): recorded_row(timestamp=200),
        '90': dead_row(timestamp=50, status='KILLED'),
    })
    install_process_table(
        monkeypatch, {PID: FakeProc(PID, CREATE_TIME + 50.0, EXE)})
    svc = make_relaunch_service()
    svc.last_started = {'proc-1': {'pid': PID}}

    assert svc.kill_and_relaunch_process(PID, dict(ENTRY)) is None

    states = read_states(state_file)
    assert str(PID) not in states, 'recycled row must stay dropped'
    assert states['90']['status'] == 'LAUNCH_FAILED'


def test_schedule_stop_refusal_surfaces_on_tracked_row(
        state_file, gt, monkeypatch):
    """Out-of-window stop refused (recordless pid wearing a stranger's
    image): nothing else rewrites this entry, so the refusal must be the
    visible state."""
    import owlette_service
    write_states(state_file, {str(PID): {'id': 'proc-1', 'status': 'RUNNING'}})
    install_process_table(
        monkeypatch, {PID: FakeProc(PID, CREATE_TIME, OTHER_EXE)})
    svc = SimpleNamespace(last_started={'proc-1': {'pid': PID}},
                          firebase_client=None)

    owlette_service._stop_process_outside_window(svc, dict(ENTRY), PID)

    gt.assert_not_called()
    assert read_states(state_file)[str(PID)]['status'] == 'LAUNCH_FAILED'
    assert 'proc-1' not in svc.last_started


# ==========================================================================
# clearing: existing write paths overwrite; nothing was added for this
# ==========================================================================

def test_success_bind_to_same_pid_overwrites_launch_failed(state_file):
    """The existing bind write (update_process_status_in_json) replaces the
    status on the row - LAUNCH_FAILED does not stick to a reused pid."""
    write_states(state_file, {'4242': {'id': 'proc-1',
                                       'status': 'LAUNCH_FAILED',
                                       'timestamp': 100}})

    shared_utils.update_process_status_in_json(4242, 'RUNNING',
                                               process_id='proc-1')

    assert read_states(state_file)['4242']['status'] == 'RUNNING'


def make_cleanup_service(results):
    from owlette_service import OwletteService
    svc = SimpleNamespace(
        last_started={},
        relaunch_attempts={},
        install_locks={},
        active_installations={},
        manual_overrides={},
        _skip_launch_delay=set(),
        _seatless_entries=set(),
        results=results,
    )
    svc.cleanup_stale_tracking_data = (
        OwletteService.cleanup_stale_tracking_data.__get__(
            svc, OwletteService))
    return svc


def test_sweep_clears_leftover_once_entry_is_live_again(
        state_file, config, monkeypatch):
    """A successful launch supersedes the failure: once the entry has a live
    row, the dead LAUNCH_FAILED leftover is swept like any stale pid."""
    states = {
        '4242': {'id': 'proc-1', 'status': 'LAUNCH_FAILED', 'timestamp': 100},
        '5555': recorded_row(timestamp=300),
    }
    write_states(state_file, states)
    # The live process must be the one row 5555 RECORDS, create_time included:
    # the sweep verifies identity rather than bare liveness, so a mismatch here
    # would be pid reuse -- the entry would have no live generation, and the
    # LAUNCH_FAILED surfacing would rightly be kept instead of swept.
    install_process_table(monkeypatch, {5555: FakeProc(5555, CREATE_TIME, EXE)})
    svc = make_cleanup_service(json.loads(state_file.read_text()))

    svc.cleanup_stale_tracking_data()

    swept = read_states(state_file)
    assert '4242' not in swept, 'superseded LAUNCH_FAILED row must be swept'
    assert '5555' in swept


# ==========================================================================
# persistence: the sweeps must not erase the surfacing
# ==========================================================================

def test_sweep_keeps_failed_row_while_entry_still_failing(
        state_file, config, monkeypatch):
    """NEGATIVE CONTROL for Task 6.1: the pre-6.1 sweep removed every
    dead-pid row, which would flip a broken entry back to the hollow
    INACTIVE ring within one cleanup interval and leave nothing for the
    writer to reuse. This test fails against that behaviour."""
    write_states(state_file, {
        '4242': {'id': 'proc-1', 'status': 'LAUNCH_FAILED', 'timestamp': 100},
    })
    install_process_table(monkeypatch, {})
    svc = make_cleanup_service(json.loads(state_file.read_text()))

    svc.cleanup_stale_tracking_data()

    assert read_states(state_file).get('4242', {}).get('status') == \
        'LAUNCH_FAILED', 'surfacing row was swept while the entry still fails'


def test_sweep_drops_failed_row_of_removed_entry(
        state_file, config, monkeypatch):
    write_states(state_file, {
        '4242': {'id': 'proc-gone', 'status': 'LAUNCH_FAILED'},
    })
    install_process_table(monkeypatch, {})
    svc = make_cleanup_service(json.loads(state_file.read_text()))

    svc.cleanup_stale_tracking_data()

    assert read_states(state_file) == {}


def make_recovery_service():
    from owlette_service import OwletteService
    svc = SimpleNamespace(last_started={}, _cached_site_timezone=None)
    svc.recover_running_processes = (
        OwletteService.recover_running_processes.__get__(
            svc, OwletteService))
    return svc


def test_recovery_keeps_failed_row_for_configured_entry(
        state_file, config, monkeypatch):
    """NEGATIVE CONTROL, restart flavour: recovery's dead-pid sweep would
    otherwise restart the service into INACTIVE with no row left to reuse."""
    write_states(state_file, {
        '4242': {'id': 'proc-1', 'status': 'LAUNCH_FAILED', 'timestamp': 100},
        '90': dead_row(timestamp=50, status='KILLED'),
    })
    install_process_table(monkeypatch, {})
    svc = make_recovery_service()

    svc.recover_running_processes()

    recovered = read_states(state_file)
    assert recovered.get('4242', {}).get('status') == 'LAUNCH_FAILED', \
        'surfacing row did not survive the restart sweep'
    assert '90' not in recovered, 'ordinary dead rows must still be dropped'
    assert svc.last_started == {}, 'nothing here is adoptable'


def test_recovery_drops_failed_row_of_removed_entry(
        state_file, config, monkeypatch):
    write_states(state_file, {
        '4242': {'id': 'proc-gone', 'status': 'LAUNCH_FAILED'},
    })
    install_process_table(monkeypatch, {})
    svc = make_recovery_service()

    svc.recover_running_processes()

    assert read_states(state_file) == {}
